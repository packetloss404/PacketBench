import { CustomCliFields } from "./CustomCliFields";
import { WORKSPACE_CLI_REGISTRY, supportsLocalCli, getWorkspaceCli, type PresetCliId } from "@/lib/workspaceCliRegistry";
import type { CustomCliConfig } from "@/types/workspace";
import { useState, useMemo, useRef, useEffect, useCallback } from "react";
import { LayoutGrid, Check, FileText, ShieldOff, Loader2, FolderOpen, ChevronDown, Zap, Server, AlertTriangle, CheckCircle2, XCircle, GitBranch, Settings2 } from "lucide-react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { Modal } from "@/components/ui/Modal";
import { useAgentStore } from "@/stores/agentStore";
import { useWorkspaceStore } from "@/stores/workspaceStore";
import { useLayoutStore } from "@/stores/layoutStore";
import { useServerStore } from "@/stores/serverStore";
// Memory context is now injected live at session launch, not baked into workspace prompt
import { usePromptStore } from "@/stores/promptStore";
import { useAppStore } from "@/stores/appStore";
import { computeGridLayout } from "@/lib/gridLayout";
import { INSTALL_HINTS } from "@/lib/agent-install-hints";
import { CLAUDE_MODELS, CODEX_MODELS, OPENCODE_MODELS, PACKETCODE_MODELS, EFFORT_LEVELS, type EffortLevel } from "@/lib/models";
import { sshCheckRemotePath, gitGetOriginUrl, cloneRepoRemote, type RemotePathCheck } from "@/lib/tauri";
import { buildRemoteCloneArgs, shouldOfferRemoteClone } from "@/lib/remoteClone";
import { parseGithubRemote } from "@/lib/git";
import { storageKey } from "@/lib/brand";
import { AdvancedAccordion } from "@/components/agents/composer/AdvancedAccordion";
import { getPreferredWorkspaceCli } from "@/lib/workspaceCliDefaults";
import { bypassCaveat } from "@/lib/bypassFlags";
import { isAccountAwareSlot, resolveAccountId } from "@/lib/sessionAccountDefaults";
import { SessionAccountPicker } from "@/components/workspace/SessionAccountPicker";
import { isLocalWorkspace, type WorkspaceAgentSlot } from "@/types/workspace";

type LocationMode = "local" | "remote";

type PathProbeState =
  | { kind: "idle" }
  | { kind: "probing" }
  | { kind: "ok"; result: RemotePathCheck }
  | { kind: "error"; message: string };

type AgentChoice = PresetCliId;

/** CLI sessions that support the --effort flag. */
const EFFORT_SUPPORTED = new Set<string>(["claude-code"]);

const AGENT_SLOTS: { id: WorkspaceAgentSlot; cliId: AgentChoice | null; label: string; cliCommand: string }[] = [
  ...WORKSPACE_CLI_REGISTRY.map((preset) => ({ id: preset.id, cliId: preset.id, label: preset.name, cliCommand: preset.binary })),
  { id: "terminal", cliId: null, label: "Terminal", cliCommand: "bash" },
  { id: "custom-cli", cliId: null, label: "Custom CLI", cliCommand: "" },
];

const WORKSPACE_TEMPLATES = [
  { id: "packetcode", label: "PacketCode", description: "Recommended terminal coding loop", sessions: ["packetcode"] as WorkspaceAgentSlot[] },
  { id: "cli-pair", label: "CLI Pair", description: "PacketCode + Codex side-by-side", sessions: ["packetcode", "codex"] as WorkspaceAgentSlot[] },
  { id: "review-pair", label: "Review Pair", description: "Claude Code + Codex CLI", sessions: ["claude-code", "codex"] as WorkspaceAgentSlot[] },
  { id: "shell", label: "Shell", description: "One plain terminal", sessions: ["terminal"] as WorkspaceAgentSlot[] },
];

const CLI_MODEL_MAP: Partial<Record<AgentChoice, typeof CLAUDE_MODELS>> = {
  "claude-code": CLAUDE_MODELS,
  codex: CODEX_MODELS,
  opencode: OPENCODE_MODELS,
  packetcode: PACKETCODE_MODELS,
};

interface WorkspaceCreationModalProps {
  onClose: () => void;
  initialSelected?: Set<WorkspaceAgentSlot>;
  serverId?: string;
  remoteProjectPath?: string;
}

/** Last path segment, OS-agnostic. Seeds the workspace name from the folder. */
function basenameOfPath(p: string): string {
  const trimmed = p.trim().replace(/[\\/]+$/, "");
  if (!trimmed) return "";
  return trimmed.split(/[\\/]/).pop() ?? "";
}

export function WorkspaceCreationModal({ onClose, initialSelected, serverId: initialServerId, remoteProjectPath: initialRemoteProjectPath }: WorkspaceCreationModalProps) {
  // The name is auto-seeded from the project folder (matching every instant
  // path, which auto-names) and stays auto until the user types. `nameEdited`
  // is what makes template clicks non-sticky: picking "PacketCode" and then
  // "Review Pair" used to keep the FIRST template's name because the seed only
  // ran while the field was empty.
  // (The seed itself is applied by the `selectedProjectPath` effect below,
  // which also keeps it in step when the folder changes.)
  const [name, setName] = useState("");
  const [customCli, setCustomCli] = useState<CustomCliConfig>();
  const [nameEdited, setNameEdited] = useState(false);
  const preferredDefaultSlot = getPreferredWorkspaceCli(initialServerId);
  // PacketCode is the creation-time default when detected. Existing
  // Workspaces are never rewritten when detection changes.
  const [selected, setSelected] = useState<Set<WorkspaceAgentSlot>>(
    () => initialSelected ?? new Set([preferredDefaultSlot]),
  );
  const [selectedTemplateId, setSelectedTemplateId] = useState<string | null>(
    () =>
      initialSelected
        ? null
        : preferredDefaultSlot === "packetcode"
          ? "packetcode"
          : preferredDefaultSlot === "terminal"
            ? "shell"
            : null,
  );
  const [modelOverrides, setModelOverrides] = useState<Record<string, string | null>>({});
  const [effortOverrides, setEffortOverrides] = useState<Record<string, EffortLevel | null>>({ "claude-code": "medium" });
  // v0.8: seed from the user's "default bypass for new workspaces" setting.
  // Read once at mount via the store snapshot so toggling the setting later
  // doesn't yank the checkbox out from under the user mid-edit.
  const [bypassPermissions, setBypassPermissions] = useState(
    () => useWorkspaceStore.getState().defaultBypassPermissions,
  );
  const [prompt, setPrompt] = useState("");
  /**
   * Multi-account CLI support: explicit per-slot account choices. A slot absent
   * from this map has NOT been touched — `SessionAccountPicker` then displays
   * (and `createWorkspace` applies) the sticky default resolved for the CURRENT
   * project path. Cleared whenever that path changes, which is what makes the
   * pre-fill re-resolve while the modal is open.
   */
  const [accountSelections, setAccountSelections] = useState<
    Partial<Record<WorkspaceAgentSlot, string | null>>
  >({});
  const projectPath = useLayoutStore((s) => s.projectPath);
  const [projectDropdownOpen, setProjectDropdownOpen] = useState(false);
  const projectDropdownRef = useRef<HTMLDivElement>(null);

  // Location: Local vs Remote. Pre-selects "remote" when the caller passes
  // a serverId (e.g. the Servers view's "New workspace on this server"
  // button). Otherwise defaults to Local.
  const [locationMode, setLocationMode] = useState<LocationMode>(initialServerId ? "remote" : "local");
  const [serverId, setServerId] = useState<string | undefined>(initialServerId);
  const [remoteProjectPath, setRemoteProjectPath] = useState<string>(initialRemoteProjectPath ?? "");
  const [serverDropdownOpen, setServerDropdownOpen] = useState(false);
  const serverDropdownRef = useRef<HTMLDivElement>(null);
  const [pathProbe, setPathProbe] = useState<PathProbeState>({ kind: "idle" });

  // S6: optional "clone a repo into this remote path" flow. When the target
  // path isn't already a git repo, the user can paste a repo URL and we clone
  // it (via clone_repo_remote) before creating the workspace.
  const [cloneRepoUrl, setCloneRepoUrl] = useState("");
  const [cloneBranch, setCloneBranch] = useState("");
  const [cloning, setCloning] = useState(false);
  const [cloneError, setCloneError] = useState<string | null>(null);

  // Local project path (only used when locationMode === "local").
  const [selectedProjectPath, setSelectedProjectPath] = useState(projectPath);

  // Keep the auto-seeded name in step with the chosen folder, so the happy
  // path (pick a folder → Create) never trips the "Workspace name is
  // required" block. A user-typed name is never overwritten.
  useEffect(() => {
    if (nameEdited || locationMode !== "local") return;
    const seed = basenameOfPath(selectedProjectPath);
    if (seed) setName(seed);
  }, [selectedProjectPath, nameEdited, locationMode]);

  // v0.8-15: auto-bind to GitHub repo via `git remote get-url origin`.
  // Probe runs against the local project path whenever it changes. We
  // stamp the parsed `{owner, repo}` onto the workspace at save time so
  // the GitHub pane (and the WorkspaceSidebar badge) can render
  // repo-aware affordances without the user picking a repo manually.
  // Remote workspaces are skipped — the git binary lives on the host
  // and we'd need an SSH round-trip we haven't wired here yet.
  const [detectedGithubRepo, setDetectedGithubRepo] = useState<{ owner: string; repo: string } | null>(null);

  const agents = useAgentStore((s) => s.agents);
  const detecting = useAgentStore((s) => s.detecting);
  const servers = useServerStore((s) => s.servers);
  const server = useMemo(
    () => (serverId ? servers.find((srv) => srv.id === serverId) : undefined),
    [serverId, servers],
  );
  const createWorkspace = useWorkspaceStore((s) => s.createWorkspace);
  const setActiveView = useAppStore((s) => s.setActiveView);
  const openSettings = useAppStore((s) => s.openSettings);

  // If the user picks a server and the path field is empty, seed it from
  // the server's default remotePath (matches the legacy
  // `initialRemoteProjectPath ?? server.remotePath` behaviour).
  useEffect(() => {
    if (locationMode !== "remote" || !server) return;
    setRemoteProjectPath((prev) => (prev.trim() ? prev : server.remotePath ?? ""));
  }, [locationMode, server]);

  const installedAgentIds = useMemo(() => {
    if (locationMode === "remote") {
      return new Set(server?.installedAgents ?? []);
    }
    return new Set(agents.filter((agent) => agent.installed).map((agent) => agent.id));
  }, [agents, server?.installedAgents, locationMode]);

  const isAgentInstalled = useCallback((id: WorkspaceAgentSlot) => {
    return id === "terminal" || id === "custom-cli" || ((locationMode === "remote" || supportsLocalCli(id)) && installedAgentIds.has(id));
  }, [installedAgentIds, locationMode]);

  // Unique project paths from existing workspaces + current global path
  const recentProjectPaths = useMemo(() => {
    if (locationMode === "remote") {
      return remoteProjectPath ? [remoteProjectPath] : [];
    }
    const paths = new Set<string>([projectPath]);
    for (const w of useWorkspaceStore.getState().workspaces) {
      if (w.projectPath && isLocalWorkspace(w)) paths.add(w.projectPath);
    }
    return Array.from(paths);
  }, [remoteProjectPath, projectPath, locationMode]);

  useEffect(() => {
    setSelected((prev) => {
      const available = Array.from(prev).filter((agent) => isAgentInstalled(agent));
      if (available.length === prev.size) return prev;
      return new Set(available);
    });
  }, [isAgentInstalled]);

  // Close project dropdown on outside click
  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (projectDropdownRef.current && !projectDropdownRef.current.contains(e.target as Node)) {
        setProjectDropdownOpen(false);
      }
      if (serverDropdownRef.current && !serverDropdownRef.current.contains(e.target as Node)) {
        setServerDropdownOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, []);

  // Live-validate the remote path. Debounced so each keystroke does not
  // dispatch an SSH command. Skipped entirely when the server lacks a
  // pinned host fingerprint — running an SSH probe to an unverified host
  // would defeat the whole point of host-key pinning.
  useEffect(() => {
    if (locationMode !== "remote") {
      setPathProbe({ kind: "idle" });
      return;
    }
    if (!server) {
      setPathProbe({ kind: "idle" });
      return;
    }
    if (!server.hostFingerprint) {
      // Skip the probe — the user must verify the host key on the
      // Servers page first. The fingerprint banner takes over from here.
      setPathProbe({ kind: "idle" });
      return;
    }
    const trimmed = remoteProjectPath.trim();
    if (!trimmed) {
      setPathProbe({ kind: "idle" });
      return;
    }

    let cancelled = false;
    setPathProbe({ kind: "probing" });

    const handle = window.setTimeout(() => {
      sshCheckRemotePath({
        targetId: server.id,
        host: server.host,
        port: server.port,
        user: server.username,
        authMethod: server.authMethod,
        keyPath: server.keyPath,
        hostFingerprint: server.hostFingerprint,
        remotePath: trimmed,
      })
        .then((result) => {
          if (cancelled) return;
          setPathProbe({ kind: "ok", result });
        })
        .catch((err: unknown) => {
          if (cancelled) return;
          const message = err instanceof Error ? err.message : String(err);
          setPathProbe({ kind: "error", message });
        });
    }, 400);

    return () => {
      cancelled = true;
      window.clearTimeout(handle);
    };
  }, [locationMode, server, remoteProjectPath]);

  // v0.8-15: probe `git remote get-url origin` whenever the local
  // project path changes. Failures (non-git dir, no `origin`) are
  // silent — auto-bind is a best-effort polish, never blocking.
  //
  // v0.8 setting: gated on `useWorkspaceStore.autoBindGithubRepo`. When the
  // user has disabled the auto-bind, we skip the probe entirely so we
  // never run `git remote get-url origin` against their local path. They
  // can still bind manually later from the GitHub pane.
  useEffect(() => {
    if (locationMode !== "local") {
      setDetectedGithubRepo(null);
      return;
    }
    if (!useWorkspaceStore.getState().autoBindGithubRepo) {
      setDetectedGithubRepo(null);
      return;
    }
    const path = selectedProjectPath?.trim();
    if (!path) {
      setDetectedGithubRepo(null);
      return;
    }
    let cancelled = false;
    gitGetOriginUrl(path)
      .then((url) => {
        if (cancelled) return;
        if (!url) {
          setDetectedGithubRepo(null);
          return;
        }
        setDetectedGithubRepo(parseGithubRemote(url));
      })
      .catch(() => {
        if (cancelled) return;
        setDetectedGithubRepo(null);
      });
    return () => {
      cancelled = true;
    };
  }, [locationMode, selectedProjectPath]);

  const preview = useMemo(() => {
    if (selected.size === 0) return null;
    return computeGridLayout(selected.size);
  }, [selected.size]);

  // The path the workspace will actually be created at — local folder, or the
  // remote path for an SSH workspace. Sticky account defaults key off this, so
  // it is hoisted out of `handleCreate` and shared with the account pickers.
  const effectivePath =
    locationMode === "remote" ? remoteProjectPath.trim() : selectedProjectPath;

  // Multi-account CLI support: the project path can change while the modal is
  // open (folder picker, recent-path dropdown, Local↔Remote, remote path edit).
  // Drop explicit picks so every account selector re-resolves the sticky
  // default for the NEW path instead of carrying the old project's account.
  useEffect(() => {
    setAccountSelections({});
  }, [effectivePath]);

  // Slots that can carry an account, in the order they appear below.
  const accountAwareSlots = useMemo(
    () => AGENT_SLOTS.filter((slot) => selected.has(slot.id) && isAccountAwareSlot(slot.id)),
    [selected],
  );

  // Collapsed-Advanced summary: surface a non-default account so it is never
  // silently applied from behind a closed accordion.
  const accountSummary = useMemo(() => {
    const labels = accountAwareSlots
      .map((slot) => {
        const explicit = slot.id in accountSelections ? accountSelections[slot.id] : undefined;
        const resolved = explicit !== undefined ? explicit : resolveAccountId(effectivePath, slot.id);
        return resolved ? slot.label : null;
      })
      .filter((label): label is string => label !== null);
    if (labels.length === 0) return null;
    return `${labels.length} account${labels.length > 1 ? "s" : ""}`;
  }, [accountAwareSlots, accountSelections, effectivePath]);

  // CLI sessions with model/permission configuration (not a plain shell).
  const selectedCliAgents = AGENT_SLOTS.filter((s) => selected.has(s.id) && s.cliId);

  // Which of the picked CLIs the bypass toggle cannot actually reach.
  const bypassSelectionCaveat = bypassCaveat(selectedCliAgents.map((s) => s.id));

  // Count of non-default per-agent model overrides — feeds the Advanced
  // section's collapsed summary so an active override stays visible.
  const nOverrides = Object.values(modelOverrides).filter((v) => v != null).length;

  function applyTemplate(template: typeof WORKSPACE_TEMPLATES[number]) {
    const availableSessions = template.sessions.filter((session) => isAgentInstalled(session));
    if (availableSessions.length === 0) return;
    setSelectedTemplateId(template.id);
    setSelected(new Set(availableSessions));
    // Overwrite auto-seeded names (empty or folder/template derived); never
    // overwrite a name the user typed.
    if (!nameEdited) {
      setName(template.label);
    }
  }

  function toggleAgent(id: WorkspaceAgentSlot) {
    if (!isAgentInstalled(id)) return;
    setSelectedTemplateId(null);
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function setModelForAgent(agentId: string, model: string | null) {
    setModelOverrides((prev) => ({ ...prev, [agentId]: model }));
  }

  // Save is only enabled when the form is in a valid state. Memoised so we
  // can both gate the button and short-circuit handleCreate.
  const saveBlockedReason = useMemo<string | null>(() => {
    if (!name.trim()) return "Workspace name is required";
    if (selected.size === 0) return "Select at least one CLI session";
    if (selected.has("custom-cli") && !customCli) return "Configure the Custom CLI executable";
    if (locationMode === "local") {
      // v0.8.8 (edge case): zero-workspaces + no fallback = empty
      // `selectedProjectPath`. Block submit so we never persist a
      // workspace whose `projectPath === ""` (would break the Toolbar
      // folder picker, git pollers, MCP, deploy, etc.).
      if (!selectedProjectPath.trim()) return "Pick a project folder";
    }
    if (locationMode === "remote") {
      if (!serverId || !server) return "Choose a server";
      if (!server.hostFingerprint) return "Verify the server's host key on the Servers page before connecting";
      if (!remoteProjectPath.trim()) return "Remote project path is required";
      if (pathProbe.kind === "probing") return "Verifying remote path…";
      if (pathProbe.kind === "ok" && pathProbe.result.exists && !pathProbe.result.isDirectory) {
        return "Remote path exists but is a file, not a directory";
      }
      if (pathProbe.kind === "error") return pathProbe.message;
    }
    return null;
  }, [name, selected, customCli, locationMode, selectedProjectPath, serverId, server, remoteProjectPath, pathProbe]);

  // v0.8.8 (edge case): pick a folder from the OS dialog. Used when no
  // workspace exists yet (so `useLayoutStore.projectPath` is empty) and
  // the user has nothing to seed the dropdown with. Updates only the
  // modal-local `selectedProjectPath` — we do NOT write through to
  // `useLayoutStore` here because the path becomes canonical once the
  // workspace is created and the active-workspace subscription mirrors
  // it back.
  const handlePickProjectFolder = useCallback(async () => {
    try {
      const picked = await openDialog({
        directory: true,
        multiple: false,
        title: "Select project folder",
        defaultPath: selectedProjectPath || undefined,
      });
      if (typeof picked === "string" && picked.trim()) {
        setSelectedProjectPath(picked);
      }
    } catch {
      // Dialog cancelled or unavailable — nothing to do.
    }
  }, [selectedProjectPath]);

  async function handleCreate() {
    if (saveBlockedReason || cloning) return;

    const orderedAgents = AGENT_SLOTS
      .filter((s) => selected.has(s.id) && isAgentInstalled(s.id))
      .map((s) => s.id);

    if (orderedAgents.length === 0) return;

    const finalPrompt = prompt.trim();

    // S6: if the user asked to clone a repo into the remote path, do it first.
    // A clone failure aborts creation (we don't want a workspace pointing at a
    // half-cloned / empty directory). Reviewer fix: only clone when the affordance
    // is actually applicable for the CURRENT probe (target isn't already a repo)
    // — otherwise a stale repo URL left in state after the user retargeted an
    // existing repo would clone-into-existing, fail, and dead-end invisibly.
    const cloneApplicable =
      locationMode === "remote" &&
      pathProbe.kind === "ok" &&
      shouldOfferRemoteClone(pathProbe.result.exists, pathProbe.result.isGitRepo);
    if (cloneApplicable) {
      const cloneArgs = buildRemoteCloneArgs(server, cloneRepoUrl, effectivePath, cloneBranch);
      if (cloneArgs) {
        setCloning(true);
        setCloneError(null);
        try {
          await cloneRepoRemote(cloneArgs);
        } catch (e) {
          setCloneError(e instanceof Error ? e.message : String(e));
          setCloning(false);
          return;
        }
        setCloning(false);
      }
    }

    createWorkspace(name.trim(), orderedAgents, effectivePath, {
      prompt: finalPrompt || undefined,
      modelOverrides,
      effortOverrides,
      bypassPermissions,
      serverId: locationMode === "remote" ? serverId : undefined,
      remoteProjectPath: locationMode === "remote" ? remoteProjectPath.trim() : undefined,
      executionTarget:
        locationMode === "remote" && serverId ? { kind: "ssh", serverId } : { kind: "local" },
      // v0.8-15: stamp the auto-detected GitHub repo onto the workspace
      // so downstream surfaces (sidebar badge, GitHub pane) can render
      // the binding without re-probing.
      githubRepo: locationMode === "local" ? detectedGithubRepo ?? undefined : undefined,
      // Multi-account CLI support: only slots the user actually touched travel
      // as explicit choices (and become the project's sticky default).
      // Untouched slots are absent, so `createWorkspace` resolves the sticky
      // default itself — the same path the modal-free call sites take.
      accountIds: accountSelections,
      ...(selected.has("custom-cli") ? { customCli } : {}),
    });

    useAppStore.getState().setActiveView("workspace");
    onClose();
  }

  function handleOpenServersView() {
    setActiveView("tools");
    onClose();
  }

  function handleOpenPacketCodeSettings() {
    openSettings({ section: "cli-clients", cliId: "packetcode" });
    onClose();
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.ctrlKey && e.key === "Enter") {
      e.preventDefault();
      handleCreate();
    }
  }

  return (
    <Modal
      onClose={onClose}
      title="New Workspace"
      icon={<LayoutGrid size={16} className="text-accent-green" />}
      width="w-[480px]"
      // The shared Modal's X button always advertises "Close (Esc)"; sibling
      // creation dialogs (FolderPickerFollowUp, the Fleet delete confirm) opt
      // in, so this one did nothing but make the tooltip lie.
      closeOnEscape
      footer={
        <div className="flex justify-end gap-2">
          <button
            onClick={onClose}
            className="px-3 py-1.5 text-ui text-text-secondary hover:text-text-primary transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={handleCreate}
            disabled={saveBlockedReason !== null || cloning}
            title={saveBlockedReason ?? undefined}
            className="px-4 py-1.5 text-ui bg-accent-green/15 text-accent-green border border-accent-green/30 rounded font-medium hover:bg-accent-green/25 transition-colors disabled:opacity-40 inline-flex items-center gap-1.5"
          >
            {cloning && <Loader2 size={11} className="animate-spin" />}
            {cloning ? "Cloning…" : "Create Workspace"}
          </button>
        </div>
      }
    >
      <div className="px-5 py-4 flex flex-col gap-4 max-h-[70vh] overflow-y-auto" onKeyDown={handleKeyDown}>
        {/* Templates — the front door. Picking one seeds the CLI-session
            selection and (if empty) the name, so most launches never touch
            anything below. */}
        <div>
          <label className="text-meta text-text-muted block mb-2 uppercase tracking-wider">
            <Zap size={10} className="inline mr-1 -mt-px" />
            Templates
          </label>
          <div className="flex flex-wrap gap-1.5">
            {WORKSPACE_TEMPLATES.map((tpl) => {
              const isActive = selectedTemplateId === tpl.id;
              const sessionLabels = tpl.sessions.map((session) => AGENT_SLOTS.find((slot) => slot.id === session)?.label ?? session);
              const availableSessions = tpl.sessions.filter((session) => isAgentInstalled(session));
              const disabled = availableSessions.length === 0;
              const unavailableLabels = tpl.sessions
                .filter((session) => !isAgentInstalled(session))
                .map((session) => AGENT_SLOTS.find((slot) => slot.id === session)?.label ?? session);
              return (
                <button
                  key={tpl.id}
                  onClick={() => applyTemplate(tpl)}
                  disabled={disabled}
                  title={unavailableLabels.length > 0 ? `Unavailable: ${unavailableLabels.join(", ")}` : tpl.description}
                  className={`flex flex-col items-start px-3 py-2 text-ui rounded border transition-colors ${
                    isActive
                      ? "bg-accent-green/15 border-accent-green/40"
                      : "bg-bg-primary border-bg-border hover:border-text-muted/30"
                  } ${disabled ? "opacity-50 cursor-not-allowed hover:border-bg-border" : ""}`}
                >
                  <span className={`font-medium ${isActive ? "text-accent-green" : "text-text-primary"}`}>
                    {tpl.label}
                  </span>
                  <span className="text-meta text-text-muted mt-0.5">{tpl.description}</span>
                  <span className="text-meta text-text-muted mt-1 opacity-70">
                    {sessionLabels.join(" + ")}
                  </span>
                </button>
              );
            })}
          </div>
        </div>

        {/* Name */}
        <div>
          <label className="text-meta text-text-muted block mb-1 uppercase tracking-wider">Workspace Name</label>
          <input
            type="text"
            value={name}
            onChange={(e) => {
              setName(e.target.value);
              // Clearing the field hands the name back to auto-seeding.
              setNameEdited(e.target.value.trim().length > 0);
            }}
            placeholder="My Workspace"
            className="w-full bg-bg-primary border border-bg-border rounded px-3 py-1.5 text-xs text-text-primary placeholder:text-text-muted focus:outline-none focus:border-accent-green"
            autoFocus
          />
        </div>

        {/* Project (local). Remote's project (server + path) lives in
            Advanced since it's the less-common path. */}
        {locationMode === "local" && (
          <div ref={projectDropdownRef}>
            <label className="text-meta text-text-muted block mb-1 uppercase tracking-wider">Project</label>
            <div className="flex items-stretch gap-1.5">
              <div className="relative flex-1 min-w-0">
                <button
                  type="button"
                  onClick={() => {
                    // v0.8.8 (edge case): when there's nothing to pick
                    // from (no current selection, no recent paths) the
                    // dropdown would be useless — jump straight to the
                    // OS folder picker so an empty-state user has a
                    // direct affordance.
                    if (!selectedProjectPath.trim() && recentProjectPaths.filter((p) => p.trim()).length === 0) {
                      void handlePickProjectFolder();
                      return;
                    }
                    setProjectDropdownOpen(!projectDropdownOpen);
                  }}
                  className="flex items-center gap-2 w-full bg-bg-primary border border-bg-border rounded px-3 py-1.5 text-ui text-left hover:border-text-muted/30 transition-colors"
                >
                  <FolderOpen size={12} className="text-accent-green flex-shrink-0" />
                  {selectedProjectPath ? (
                    <>
                      <span className="flex-1 truncate text-text-primary" title={selectedProjectPath}>
                        {selectedProjectPath.split(/[\\/]/).pop()}
                      </span>
                      <span className="text-meta text-text-muted truncate max-w-[200px]" title={selectedProjectPath}>
                        {selectedProjectPath}
                      </span>
                    </>
                  ) : (
                    <span className="flex-1 truncate text-text-muted italic">
                      No folder selected — click to pick one
                    </span>
                  )}
                  <ChevronDown
                    size={10}
                    className={`text-text-muted flex-shrink-0 transition-transform ${projectDropdownOpen ? "rotate-180" : ""}`}
                  />
                </button>
                {projectDropdownOpen && recentProjectPaths.filter((p) => p.trim()).length > 0 && (
                  <div className="absolute top-full left-0 mt-1 w-full bg-bg-secondary border border-bg-border rounded-lg shadow-xl z-50 py-1 max-h-[160px] overflow-y-auto">
                    {recentProjectPaths.filter((p) => p.trim()).map((p) => (
                      <button
                        key={p}
                        onClick={() => {
                          setSelectedProjectPath(p);
                          setProjectDropdownOpen(false);
                        }}
                        className={`flex items-center gap-2 w-full px-3 py-1.5 text-left hover:bg-bg-hover transition-colors ${
                          p === selectedProjectPath ? "bg-accent-green/10" : ""
                        }`}
                      >
                        <FolderOpen size={11} className={p === selectedProjectPath ? "text-accent-green" : "text-text-muted"} />
                        <span className="flex-1 truncate text-ui text-text-primary">{p.split(/[\\/]/).pop()}</span>
                        <span className="text-meta text-text-muted truncate max-w-[180px]">{p}</span>
                        {p === selectedProjectPath && <Check size={10} className="text-accent-green flex-shrink-0" />}
                      </button>
                    ))}
                  </div>
                )}
              </div>
              {/* v0.8.8 (edge case): always-present "Pick folder" affordance
                  so users can change folders even when there's only one
                  recent path (which would otherwise hide the dropdown). */}
              <button
                type="button"
                onClick={handlePickProjectFolder}
                title="Pick folder from disk"
                className="flex items-center gap-1 px-2.5 text-ui text-text-muted hover:text-text-primary bg-bg-primary border border-bg-border rounded hover:border-text-muted/30 transition-colors"
              >
                <FolderOpen size={11} />
                Browse
              </button>
            </div>
          </div>
        )}

        <AdvancedAccordion
          persistKey={storageKey("workspace-create-advanced")}
          forceOpenOnFirstMount={!!initialServerId}
          summary={[
            { label: locationMode === "remote" ? "Remote" : null },
            { label: bypassPermissions ? "Bypass perms" : null },
            { label: nOverrides > 0 ? `${nOverrides} model override${nOverrides > 1 ? "s" : ""}` : null },
            { label: accountSummary },
          ]}
        >
          <div className="flex w-full flex-col gap-4">
            {/* Location: Local vs Remote (SSH) */}
            <div>
              <label className="text-meta text-text-muted block mb-1 uppercase tracking-wider">Location</label>
              <div className="grid grid-cols-2 gap-1.5">
                <button
                  type="button"
                  onClick={() => setLocationMode("local")}
                  className={`flex items-center gap-2 px-3 py-2 text-ui rounded border transition-colors ${
                    locationMode === "local"
                      ? "bg-accent-green/15 border-accent-green/40 text-accent-green font-medium"
                      : "bg-bg-primary border-bg-border text-text-muted hover:text-text-secondary hover:border-text-muted/30"
                  }`}
                >
                  <FolderOpen size={12} />
                  <span className="flex flex-col items-start">
                    <span>Local</span>
                    <span className="text-meta text-text-muted">This machine</span>
                  </span>
                </button>
                <button
                  type="button"
                  onClick={() => setLocationMode("remote")}
                  className={`flex items-center gap-2 px-3 py-2 text-ui rounded border transition-colors ${
                    locationMode === "remote"
                      ? "bg-accent-blue/15 border-accent-blue/40 text-accent-blue font-medium"
                      : "bg-bg-primary border-bg-border text-text-muted hover:text-text-secondary hover:border-text-muted/30"
                  }`}
                >
                  <Server size={12} />
                  <span className="flex flex-col items-start">
                    <span>Remote (SSH)</span>
                    <span className="text-meta text-text-muted">Saved server</span>
                  </span>
                </button>
              </div>
            </div>

            {/* Remote: Server picker + remote project path */}
            {locationMode === "remote" && (
              <div className="flex flex-col gap-3">
                {servers.length === 0 ? (
                  <div className="rounded border border-bg-border bg-bg-primary px-3 py-3 text-ui text-text-secondary">
                    <div className="flex items-center gap-2 mb-1.5">
                      <Server size={12} className="text-text-muted" />
                      <span className="font-medium text-text-primary">No servers configured</span>
                    </div>
                    <p className="text-text-muted text-meta mb-2">
                      Add a server in the Tools view to use it as a remote workspace target.
                    </p>
                    <button
                      type="button"
                      onClick={handleOpenServersView}
                      className="text-ui text-accent-blue hover:underline"
                    >
                      Open Servers settings →
                    </button>
                  </div>
                ) : (
                  <div ref={serverDropdownRef}>
                    <label className="text-meta text-text-muted block mb-1 uppercase tracking-wider">Server</label>
                    <div className="relative">
                      <button
                        type="button"
                        onClick={() => setServerDropdownOpen(!serverDropdownOpen)}
                        className="flex items-center gap-2 w-full bg-bg-primary border border-bg-border rounded px-3 py-1.5 text-ui text-left hover:border-text-muted/30 transition-colors"
                      >
                        <Server size={12} className="text-accent-blue flex-shrink-0" />
                        {server ? (
                          <>
                            <span className="flex-1 truncate text-text-primary" title={server.name}>
                              {server.name}
                            </span>
                            <span className="text-meta text-text-muted truncate max-w-[200px]" title={`${server.username}@${server.host}:${server.port}`}>
                              {server.username}@{server.host}:{server.port}
                            </span>
                          </>
                        ) : (
                          <span className="flex-1 text-text-muted italic">Choose a server…</span>
                        )}
                        <ChevronDown
                          size={10}
                          className={`text-text-muted flex-shrink-0 transition-transform ${serverDropdownOpen ? "rotate-180" : ""}`}
                        />
                      </button>
                      {serverDropdownOpen && (
                        <div className="absolute top-full left-0 mt-1 w-full bg-bg-secondary border border-bg-border rounded-lg shadow-xl z-50 py-1 max-h-[200px] overflow-y-auto">
                          {servers.map((srv) => (
                            <button
                              key={srv.id}
                              onClick={() => {
                                setServerId(srv.id);
                                // Reset path probe + seed path field from
                                // the new server's default remotePath if the
                                // user hasn't typed anything.
                                setRemoteProjectPath((prev) => (prev.trim() ? prev : srv.remotePath ?? ""));
                                setServerDropdownOpen(false);
                              }}
                              className={`flex items-center gap-2 w-full px-3 py-1.5 text-left hover:bg-bg-hover transition-colors ${
                                srv.id === serverId ? "bg-accent-blue/10" : ""
                              }`}
                            >
                              <Server size={11} className={srv.id === serverId ? "text-accent-blue" : "text-text-muted"} />
                              <span className="flex-1 truncate text-ui text-text-primary">{srv.name}</span>
                              <span className="text-meta text-text-muted truncate max-w-[180px]">
                                {srv.username}@{srv.host}:{srv.port}
                              </span>
                              {srv.id === serverId && <Check size={10} className="text-accent-blue flex-shrink-0" />}
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>
                )}

                {/* Host-key warning */}
                {server && !server.hostFingerprint && (
                  <div className="rounded border border-accent-amber/30 bg-accent-amber/5 px-3 py-2 text-ui text-accent-amber flex items-start gap-2">
                    <AlertTriangle size={12} className="flex-shrink-0 mt-0.5" />
                    <div className="flex-1">
                      <div className="font-medium">Host key not verified.</div>
                      <p className="text-text-secondary mt-1">
                        Verify the host key on the Servers page before connecting. We won't probe an unpinned host.
                      </p>
                      <button
                        type="button"
                        onClick={handleOpenServersView}
                        className="mt-1 text-ui underline hover:text-accent-amber"
                      >
                        Open Servers settings →
                      </button>
                    </div>
                  </div>
                )}

                {/* Remote project path input */}
                {server && server.hostFingerprint && (
                  <div>
                    <label className="text-meta text-text-muted block mb-1 uppercase tracking-wider">
                      Remote Project Path
                    </label>
                    <input
                      type="text"
                      value={remoteProjectPath}
                      onChange={(e) => setRemoteProjectPath(e.target.value)}
                      placeholder={server.remotePath || "/srv/projects/my-app"}
                      className="w-full bg-bg-primary border border-bg-border rounded px-3 py-1.5 text-xs font-mono text-text-primary placeholder:text-text-muted focus:outline-none focus:border-accent-blue"
                    />
                    <RemotePathProbeIndicator state={pathProbe} />

                    {/* S6: clone-a-repo affordance — only when the target path
                        isn't already a git repo. */}
                    {pathProbe.kind === "ok" &&
                      shouldOfferRemoteClone(
                        pathProbe.result.exists,
                        pathProbe.result.isGitRepo,
                      ) && (
                        <div className="mt-2 rounded border border-bg-border bg-bg-primary/50 p-2">
                          <label className="text-meta text-text-muted block mb-1 uppercase tracking-wider">
                            Clone a repo here <span className="normal-case text-text-muted/70">(optional)</span>
                          </label>
                          <input
                            type="text"
                            value={cloneRepoUrl}
                            onChange={(e) => {
                              setCloneRepoUrl(e.target.value);
                              setCloneError(null);
                            }}
                            placeholder="https://github.com/owner/repo.git"
                            className="w-full bg-bg-primary border border-bg-border rounded px-3 py-1.5 text-xs font-mono text-text-primary placeholder:text-text-muted focus:outline-none focus:border-accent-blue"
                          />
                          <input
                            type="text"
                            value={cloneBranch}
                            onChange={(e) => setCloneBranch(e.target.value)}
                            placeholder="branch (optional — defaults to the repo's default)"
                            className="mt-1.5 w-full bg-bg-primary border border-bg-border rounded px-3 py-1.5 text-xs font-mono text-text-primary placeholder:text-text-muted focus:outline-none focus:border-accent-blue"
                          />
                          <p className="mt-1 text-meta text-text-muted">
                            The repo is cloned into the path above when you create the workspace.
                          </p>
                          {cloneError && (
                            <p className="mt-1 text-meta text-accent-red">{cloneError}</p>
                          )}
                        </div>
                      )}
                  </div>
                )}
              </div>
            )}

            {/* CLI session selection — multi-toggle buttons */}
            <div>
              <label className="text-meta text-text-muted block mb-2 uppercase tracking-wider">CLI Sessions</label>
              {detecting && (
                <p className="flex items-center gap-1 text-meta text-text-muted italic mb-2">
                  <Loader2 size={10} className="animate-spin" />
                  Checking CLI availability…
                </p>
              )}
              <div className="flex flex-wrap items-center gap-1.5">
                {AGENT_SLOTS.map((slot) => {
                  const installed = isAgentInstalled(slot.id);
                  const isSelected = selected.has(slot.id);
                  const hint = INSTALL_HINTS[slot.id];

                  return (
                    <div key={slot.id} className="flex items-center gap-1">
                      <button
                        onClick={() => toggleAgent(slot.id)}
                        disabled={!installed}
                        title={installed ? slot.label : `${slot.label} not found for this workspace. ${getWorkspaceCli(slot.id)?.platformNotes ?? ""}`}
                        className={`flex items-center gap-1.5 px-3 py-1.5 text-ui rounded border transition-colors ${
                          isSelected
                            ? "bg-accent-green/15 border-accent-green/40 text-accent-green font-medium"
                            : "bg-bg-primary border-bg-border text-text-muted hover:text-text-secondary hover:border-text-muted/30"
                        } ${!installed ? "opacity-50 cursor-not-allowed hover:text-text-muted hover:border-bg-border" : ""}`}
                      >
                        <div className={`w-3.5 h-3.5 rounded border flex items-center justify-center ${
                          isSelected ? "bg-accent-green border-accent-green" : "border-bg-border"
                        }`}>
                          {isSelected && <Check size={8} className="text-bg-primary" />}
                        </div>
                        {slot.label}
                      </button>
                      {!installed && slot.id === "packetcode" && !detecting && (
                        <button
                          type="button"
                          onClick={handleOpenPacketCodeSettings}
                          className="inline-flex items-center gap-1 text-meta text-accent-amber underline opacity-80 hover:opacity-100"
                          title="Install, locate, and configure PacketCode"
                        >
                          <Settings2 size={10} />
                          set up
                        </button>
                      )}
                      {!installed && slot.id !== "packetcode" && hint && !detecting && (
                        <a
                          href={hint.url}
                          target="_blank"
                          rel="noreferrer"
                          onClick={(e) => e.stopPropagation()}
                          className="text-meta text-accent-amber underline opacity-80 hover:opacity-100"
                          title={hint.label}
                        >
                          install
                        </a>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>

            {selected.has("custom-cli") && <CustomCliFields value={customCli} onChange={setCustomCli} />}

            {/* Bypass permissions toggle */}
            {selectedCliAgents.length > 0 && (
              <div className="flex flex-col gap-1">
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={bypassPermissions}
                    onChange={(e) => setBypassPermissions(e.target.checked)}
                    className="w-3 h-3 rounded border-bg-border accent-accent-amber"
                  />
                  <ShieldOff size={11} className={bypassPermissions ? "text-accent-amber" : "text-text-muted"} />
                  <span className={`text-ui ${bypassPermissions ? "text-accent-amber" : "text-text-secondary"}`}>
                    Bypass permissions
                  </span>
                </label>
                {/* FAULT: this caveat used to name OpenCode only, so a
                    PacketCode session showed "Bypass permissions" checked while
                    the flag was never passed. `bypassCaveat` derives the list
                    from the same table the spawn path reads. */}
                {bypassPermissions && bypassSelectionCaveat && (
                  <span className="text-meta text-text-muted ml-5">{bypassSelectionCaveat}</span>
                )}
              </div>
            )}

            {/* Multi-account CLI support: account per selected claude-code /
                codex session. Pre-filled from the sticky default for the
                CURRENT project path and re-resolved when that path changes.
                Renders nothing until the user registers an account for that
                CLI, so a zero-config install sees the modal it saw before. */}
            {accountAwareSlots.map((slot) => (
              <SessionAccountPicker
                key={`account-${slot.id}`}
                cli={slot.id as "claude-code" | "codex"}
                projectPath={effectivePath}
                value={slot.id in accountSelections ? accountSelections[slot.id] : undefined}
                onChange={(accountId) =>
                  setAccountSelections((prev) => ({ ...prev, [slot.id]: accountId }))
                }
                variant="field"
                label={`${slot.label} Account`}
              />
            ))}

            {/* Model selection per selected coding CLI. */}
            {selectedCliAgents.map((slot) => {
              const models = CLI_MODEL_MAP[slot.cliId!] ?? [];

              // OpenCode manages its own models internally
              if (models.length === 0) {
                return (
                  <div key={slot.id} className="opacity-50">
                    <label className="block text-meta text-text-muted mb-1.5 uppercase tracking-wider">
                      {slot.label} Model
                    </label>
                    <span className="text-ui text-text-muted italic">Configured inside {slot.label}</span>
                  </div>
                );
              }

              const currentModel = modelOverrides[slot.id] ?? null;
              return (
                <div key={slot.id}>
                  <label className="block text-meta text-text-muted mb-1.5 uppercase tracking-wider">
                    {slot.label} Model
                  </label>
                  <div className="flex flex-wrap gap-1.5">
                    {models.map((m) => (
                      <button
                        key={m.label}
                        onClick={() => setModelForAgent(slot.id, m.value)}
                        className={`px-2.5 py-1 text-ui rounded border transition-colors ${
                          currentModel === m.value
                            ? "bg-accent-amber/15 border-accent-amber/40 text-accent-amber font-medium"
                            : "bg-bg-primary border-bg-border text-text-muted hover:text-text-secondary hover:border-text-muted/30"
                        }`}
                      >
                        {m.label}
                      </button>
                    ))}
                  </div>
                </div>
              );
            })}

            {/* Effort level per selected coding CLI. */}
            {selectedCliAgents.map((slot) => {
              if (!EFFORT_SUPPORTED.has(slot.id)) {
                return null;
              }
              const currentEffort = effortOverrides[slot.id] ?? null;
              return (
                <div key={`effort-${slot.id}`}>
                  <label className="block text-meta text-text-muted mb-1.5 uppercase tracking-wider">
                    {slot.label} Effort
                  </label>
                  <div className="flex flex-wrap gap-1.5">
                    {EFFORT_LEVELS.map((e) => (
                      <button
                        key={e.value}
                        onClick={() => setEffortOverrides((prev) => ({ ...prev, [slot.id]: e.value }))}
                        className={`px-2.5 py-1 text-ui rounded border transition-colors ${
                          currentEffort === e.value
                            ? "bg-accent-purple/15 border-accent-purple/40 text-accent-purple font-medium"
                            : "bg-bg-primary border-bg-border text-text-muted hover:text-text-secondary hover:border-text-muted/30"
                        }`}
                      >
                        {e.label}
                      </button>
                    ))}
                  </div>
                </div>
              );
            })}

            {/* Prompt Template Picker */}
            {selectedCliAgents.length > 0 && (
              <TemplatePicker onSelect={(content) => setPrompt(content)} />
            )}

            {/* Prompt */}
            {selectedCliAgents.length > 0 && (
              <div>
                <label className="block text-meta text-text-muted mb-1.5 uppercase tracking-wider">
                  Initial Prompt
                </label>
                <textarea
                  value={prompt}
                  onChange={(e) => setPrompt(e.target.value)}
                  rows={3}
                  placeholder="Describe the task for all CLI sessions..."
                  className="w-full bg-bg-primary border border-bg-border rounded px-3 py-2 text-xs text-text-primary placeholder:text-text-muted focus:outline-none focus:border-accent-amber resize-none"
                />
                <p className="text-meta text-text-muted mt-1">
                  Ctrl+Enter to create
                </p>
              </div>
            )}

            {/* Grid Preview */}
            {preview && (
              <div>
                <label className="text-meta text-text-muted block mb-2 uppercase tracking-wider">Layout Preview</label>
                <div
                  className="gap-1 max-w-[200px]"
                  style={{
                    display: "grid",
                    gridTemplateColumns: `repeat(${preview.cols}, 1fr)`,
                    gridTemplateRows: `repeat(${preview.rows}, 1fr)`,
                  }}
                >
                  {preview.cells.map((cell) => {
                    const selectedArr = AGENT_SLOTS.filter((s) => selected.has(s.id));
                    const agent = cell.agentIndex !== null ? selectedArr[cell.agentIndex] : null;
                    return (
                      <div
                        key={`${cell.row}-${cell.col}`}
                        className={`h-10 rounded flex items-center justify-center text-meta ${
                          agent
                            ? "bg-accent-green/10 text-accent-green border border-accent-green/20"
                            : "border border-dashed border-bg-border text-text-muted"
                        }`}
                      >
                        {agent?.label ?? ""}
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
          </div>
        </AdvancedAccordion>
      </div>
    </Modal>
  );
}

/** Small inline status row underneath the Remote Project Path input.
 *  Reflects the debounced `sshCheckRemotePath` probe state. Never returns
 *  null — empty/idle renders a placeholder so the modal height stays
 *  stable while the user types. */
function RemotePathProbeIndicator({ state }: { state: PathProbeState }) {
  if (state.kind === "idle") {
    return (
      <p className="text-meta text-text-muted mt-1">
        Type a path to verify it exists on the host.
      </p>
    );
  }
  if (state.kind === "probing") {
    return (
      <p className="flex items-center gap-1 text-meta text-text-muted mt-1">
        <Loader2 size={10} className="animate-spin" />
        Checking remote path…
      </p>
    );
  }
  if (state.kind === "error") {
    return (
      <p className="flex items-center gap-1 text-meta text-accent-red mt-1">
        <XCircle size={10} />
        {state.message}
      </p>
    );
  }
  // ok
  const { exists, isDirectory, isGitRepo } = state.result;
  if (!exists) {
    return (
      <p className="flex items-center gap-1 text-meta text-accent-amber mt-1">
        <AlertTriangle size={10} />
        Path does not exist on the host — create it before starting; it is not created automatically.
      </p>
    );
  }
  if (!isDirectory) {
    return (
      <p className="flex items-center gap-1 text-meta text-accent-red mt-1">
        <XCircle size={10} />
        Path is a file, not a directory.
      </p>
    );
  }
  if (isGitRepo) {
    return (
      <p className="flex items-center gap-1 text-meta text-accent-green mt-1">
        <GitBranch size={10} />
        Git repository detected.
      </p>
    );
  }
  return (
    <p className="flex items-center gap-1 text-meta text-accent-green mt-1">
      <CheckCircle2 size={10} />
      Directory exists.
    </p>
  );
}

function TemplatePicker({ onSelect }: { onSelect: (content: string) => void }) {
  const templates = usePromptStore((s) => s.templates);
  const [open, setOpen] = useState(false);

  if (templates.length === 0) return null;

  return (
    <div>
      <label className="block text-meta text-text-muted mb-1.5 uppercase tracking-wider">
        Prompt Template
      </label>
      <div className="relative">
        <button
          type="button"
          onClick={() => setOpen(!open)}
          className="flex items-center gap-1.5 px-2.5 py-1.5 text-ui bg-bg-primary border border-bg-border rounded w-full text-left text-text-secondary hover:border-text-muted/30 transition-colors"
        >
          <FileText size={11} className="text-accent-amber flex-shrink-0" />
          <span className="flex-1 truncate">Select a template...</span>
        </button>
        {open && (
          <div className="absolute top-full left-0 mt-1 w-full bg-bg-secondary border border-bg-border rounded-lg shadow-xl z-50 py-1 max-h-[200px] overflow-y-auto">
            {templates.map((t) => (
              <button
                key={t.id}
                onClick={() => {
                  onSelect(t.content);
                  setOpen(false);
                }}
                className="flex flex-col w-full px-3 py-2 text-left hover:bg-bg-hover transition-colors"
              >
                <span className="text-ui text-text-primary">{t.name}</span>
                <span className="text-meta text-text-muted truncate">
                  {t.content.slice(0, 80)}
                </span>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
