/**
 * Merged agent catalog (tile program, P3-S4).
 *
 * A thin static READ-LAYER registry that joins the two existing sources of
 * truth — `lib/api-models.ts` (API "Chat agent" providers) and
 * `lib/cli-catalog.ts` / `types/workspace` (the CLI "Terminal" slots) — under a
 * single capability vocabulary. WA2's Workspace `AddSessionPicker` consumes
 * only the terminal half; compatibility draft tiles still use the chat lookup.
 * It NEVER mutates either source: `API_PROVIDERS`
 * and `CLI_CATALOG` stay the owners of models / install metadata. This module
 * only re-projects them behind the ruled capability flags
 * `{ face, supportsApprovals, supportsSsh, models[] }`.
 *
 * Capability language, never transport language (binding ruling): a "Chat agent"
 * is an API provider whose face is the chat tile; a "Terminal" is a PTY CLI
 * slot. The same vendor legitimately appears in both sections (e.g. Claude as a
 * Chat agent AND Claude Code as a Terminal) — the section headers disambiguate
 * search hits.
 */
import type { AgentCli } from "@/stores/agentTaskStore";
import { API_PROVIDERS, type ApiModel } from "@/lib/api-models";
import { WORKSPACE_CLI_REGISTRY } from "@/lib/workspaceCliRegistry";
import type { WorkspaceAgentSlot } from "@/types/workspace";

/** A flattened API provider presented as a Chat-agent row. */
export interface ChatAgentEntry {
  section: "chat";
  agentCli: AgentCli;
  /** Concise picker display name (the chat "face"). */
  face: string;
  /** Default model label shown as the row subtext. */
  defaultModelLabel: string;
  /** Default model value handed to the draft tile. */
  defaultModel: string;
  /** P1-S4 (Codex honesty): whether the adapter can honor approval round-trips.
   *  Drives the capability-filtered mode set in the draft tile. */
  supportsApprovals: boolean;
  /** Whether this provider can run against a remote (SSH) execution context.
   *  Local-only runtimes (Ollama) are false. Informational for P3. */
  supportsSsh: boolean;
  /** The provider's models (from api-models — not duplicated). */
  models: ApiModel[];
}

/** A CLI slot presented as a Terminal row. */
export interface TerminalAgentEntry {
  section: "terminal";
  slot: WorkspaceAgentSlot;
  /** Picker display name. */
  face: string;
  /** Terminals inherit the workspace's SSH execution context unchanged. */
  supportsSsh: boolean;
}

/**
 * Concise chat "face" names keyed by agentCli. `api-models.ts` names some
 * providers by runtime ("Claude Agent SDK (API)"); the picker wants the short
 * face ("Claude Agent SDK") so search disambiguation reads naturally
 * ("cla" → Claude under Chat agents, Claude Code under Terminals).
 */
const CHAT_FACE: Partial<Record<AgentCli, string>> = {
  "api-claude-oauth": "Claude Agent SDK",
  "api-claude": "Claude API",
  "api-openai": "OpenAI",
  "api-openai-agents": "OpenAI Agents",
  "api-minimax": "MiniMax",
  "api-openrouter": "OpenRouter",
  "api-ollama": "Ollama",
  "api-custom": "Custom endpoint",
};

/** Local-only chat runtimes cannot inherit an SSH execution context. */
const CHAT_LOCAL_ONLY: ReadonlySet<AgentCli> = new Set<AgentCli>(["api-ollama"]);

/**
 * The Chat-agent section: every API provider from `api-models.ts`, projected
 * under the capability flags. Order preserved from `API_PROVIDERS` so the
 * subscription faces (Claude OAuth, Codex ChatGPT) lead their vendor groups.
 */
export const CHAT_AGENTS: ChatAgentEntry[] = API_PROVIDERS.map((p) => ({
  section: "chat" as const,
  agentCli: p.agentCli,
  face: CHAT_FACE[p.agentCli] ?? p.name,
  defaultModelLabel: p.models[0]?.label ?? "",
  defaultModel: p.models[0]?.value ?? "",
  supportsApprovals: p.supportsApprovals ?? true,
  supportsSsh: !CHAT_LOCAL_ONLY.has(p.agentCli),
  // Copied, not aliased. `api-models.ts` freezes its arrays so an alias could
  // not be mutated through anyway, but this module's own contract says it
  // never touches either source, and a copy is what makes that true by
  // construction rather than by the other file's continued good behaviour.
  models: [...p.models],
}));

/**
 * These rows are a MODULE-LOAD SNAPSHOT of the bundled catalog, and that is a
 * deliberate limit, not an oversight.
 *
 * `CHAT_AGENTS` answers "what can this build launch?" — a static question with
 * a static answer, asked by pickers that must render before any network call.
 * It is NOT the place to ask "what models does this provider serve right now?":
 * that answer arrives asynchronously, per-provider, and lands in
 * `stores/liveModelStore`. A surface that shows a model list must resolve it
 * through `lib/liveModels.resolveModelRows`, which prefers the live answer and
 * falls back to these rows — never read `entry.models` as if it were current.
 */

/**
 * Every verified terminal preset, plus the shell and configurable CLI rows.
 */
export const TERMINAL_AGENTS: TerminalAgentEntry[] = [
  ...WORKSPACE_CLI_REGISTRY.map((preset): TerminalAgentEntry => ({
    section: "terminal", slot: preset.id, face: preset.name, supportsSsh: true,
  })),
  { section: "terminal", slot: "terminal", face: "Terminal", supportsSsh: true },
  { section: "terminal", slot: "custom-cli", face: "Custom CLI", supportsSsh: true },
];

/** Lookup a chat entry by agentCli. */
export function getChatAgent(agentCli: AgentCli): ChatAgentEntry | undefined {
  return CHAT_AGENTS.find((c) => c.agentCli === agentCli);
}
