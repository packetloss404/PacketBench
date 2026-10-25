import { create } from "zustand";
import { detectCliCatalog, loadPersistedState, saveAgentsSlice } from "@/lib/tauri";
import type { AgentConfig } from "@/types/agent";
import { WORKSPACE_BUILTIN_AGENTS } from "@/agents/workspace-presets";
import { supportsLocalCli } from "@/lib/workspaceCliRegistry";
import { useCliOverrideStore } from "@/stores/cliOverrideStore";

const BUILTIN_AGENTS = WORKSPACE_BUILTIN_AGENTS;

interface AgentStoreState {
  agents: AgentConfig[];
  detecting: boolean;
}

interface AgentStore extends AgentStoreState {
  // CRUD
  addAgent: (agent: AgentConfig) => void;
  updateAgent: (id: string, updates: Partial<AgentConfig>) => void;
  removeAgent: (id: string) => void;
  getAgent: (id: string) => AgentConfig | undefined;

  // Install detection
  detectInstalled: () => Promise<void>;
  setInstalled: (id: string, installed: boolean) => void;

  // Reset built-ins
  resetBuiltins: () => void;
  hydrateFromBackend: (persisted?: Awaited<ReturnType<typeof loadPersistedState>>) => Promise<void>;
}

function loadState(): AgentStoreState {
  // Backend is the sole source of truth; real data arrives via hydrateFromBackend.
  return {
    agents: [...BUILTIN_AGENTS],
    detecting: false,
  };
}

function saveState(agents: AgentConfig[]) {
  void syncAgentsToBackend(agents);
}

async function syncAgentsToBackend(agents: AgentConfig[]) {
  try {
    await saveAgentsSlice(agents);
  } catch (err) {
    console.warn("[agentStore.persist] swallowed error:", err);
  }
}

const initial = loadState();

export const useAgentStore = create<AgentStore>((set, get) => ({
  ...initial,

  addAgent: (agent) => {
    set((s) => {
      // Prevent duplicate IDs
      if (s.agents.some((a) => a.id === agent.id)) return s;
      const agents = [...s.agents, agent];
      saveState(agents);
      return { agents };
    });
  },

  updateAgent: (id, updates) => {
    set((s) => {
      const agents = s.agents.map((a) =>
        a.id === id ? { ...a, ...updates, id: a.id, isBuiltin: a.isBuiltin } : a,
      );
      saveState(agents);
      return { agents };
    });
  },

  removeAgent: (id) => {
    set((s) => {
      // Cannot remove built-in agents
      const agent = s.agents.find((a) => a.id === id);
      if (agent?.isBuiltin) return s;
      const agents = s.agents.filter((a) => a.id !== id);
      saveState(agents);
      return { agents };
    });
  },

  getAgent: (id) => {
    return get().agents.find((a) => a.id === id);
  },

  detectInstalled: async () => {
    set({ detecting: true });
    try {
      const agents = get().agents;

      // Startup-perf: use the bulk `detect_cli_catalog` command rather than one
      // sync `detect_agent` per agent. `detect_agent` is a SYNChronous Tauri
      // command, so N of them serialize on the main/event-loop thread and each
      // spawns a blocking `where`/`which` (up to 2 spawns per missing agent on
      // Windows) with no timeout — that froze the window for ~seconds at launch.
      // `detect_cli_catalog` is async (off the main thread), probes all entries
      // concurrently, and bounds each probe to 2s so a hung PATH lookup can't
      // stall startup.
      let updates: { id: string; installed: boolean; path?: string | null }[] = [];
      try {
        const overrides = useCliOverrideStore.getState().overrides;
        const results = await detectCliCatalog(
          agents.map((a) => {
            const manualPath = overrides[a.id]?.manualPath;
            const binary = a.id === "packetcode" ? "packetcode" : a.command;
            return manualPath
              ? { id: a.id, binary, manualPath }
              : { id: a.id, binary };
          }),
        );
        updates = results.map((r) => ({
          id: r.id,
          installed: r.installed && supportsLocalCli(r.id),
          path: r.path,
        }));
      } catch {
        updates = agents.map((a) => ({ id: a.id, installed: false }));
      }

      set((s) => {
        const updatedAgents = s.agents.map((a) => {
          const update = updates.find((u) => u.id === a.id);
          return update
            ? {
                ...a,
                installed: update.installed,
                command:
                  a.id === "packetcode" && update.installed && update.path
                    ? update.path
                    : a.command,
              }
            : a;
        });
        saveState(updatedAgents);
        return { agents: updatedAgents, detecting: false };
      });
    } catch {
      set({ detecting: false });
    }
  },

  setInstalled: (id, installed) => {
    set((s) => {
      const agents = s.agents.map((a) => (a.id === id ? { ...a, installed } : a));
      return { agents };
    });
  },

  resetBuiltins: () => {
    set((s) => {
      const customAgents = s.agents.filter((a) => !a.isBuiltin);
      const agents = [...BUILTIN_AGENTS, ...customAgents];
      saveState(agents);
      return { agents };
    });
  },

  hydrateFromBackend: async (persisted) => {
    try {
      const state = persisted ?? (await loadPersistedState());
      // Merge persisted agents with current builtins so code-level changes
      // (like new defaultArgs) take effect even if the user has persisted state.
      const builtinIds = new Set(BUILTIN_AGENTS.map((a) => a.id));
      const merged = BUILTIN_AGENTS.map((builtin) => {
        const persisted_agent = state.agents.find((a) => a.id === builtin.id);
        if (persisted_agent) {
          return {
            ...builtin,
            command: persisted_agent.command || builtin.command,
            defaultArgs: Array.isArray(persisted_agent.defaultArgs)
              ? persisted_agent.defaultArgs
              : builtin.defaultArgs,
            installed: persisted_agent.installed,
          };
        }
        return builtin;
      });
      // Preserve custom agents while newly supported ids become builtins.
      const custom = state.agents.filter(
        (a) => !builtinIds.has(a.id),
      );
      set({ agents: [...merged, ...custom] });
    } catch (err) {
      console.warn("[agentStore.hydrate] swallowed error:", err);
    }
  },
}));
