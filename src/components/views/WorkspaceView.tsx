import { useWorkspaceStore } from "@/stores/workspaceStore";
import { useAppStore } from "@/stores/appStore";
import { useLayoutStore } from "@/stores/layoutStore";
import { WorkspaceMosaicContainer } from "@/components/workspace/WorkspaceMosaicContainer";
import { WorkspaceCreationModal } from "@/components/workspace/WorkspaceCreationModal";
import { AddSessionPicker } from "@/components/workspace/AddSessionPicker";
import { OnboardingPane } from "@/components/onboarding/OnboardingPane";
import { EditorDockPanel } from "@/components/editor/EditorDockPanel";
import { RightDock, type RightDockPanel } from "@/components/layout/RightDock";
import { isPanelVisible, useRightDockStore } from "@/stores/rightDockStore";
import { REMOTE_UNSUPPORTED_TOOLTIP } from "@/lib/remoteConversation";
import { isOnboardingComplete } from "@/lib/onboarding";
import { pathIsDir } from "@/lib/tauri";
import { useEffect, useState } from "react";
import { Bot, LayoutGrid, GitBranch, FileText, FolderX, Plus, Zap } from "lucide-react";
import { GitDashboard } from "@/components/workspace/GitDashboard";
import { workspacePaneSummaryIdentity } from "@/lib/workspacePaneSummary";
import { AccountDot } from "@/components/session/AccountChip";
import { useWorkspaceStatuses, attentionDot } from "@/lib/sessionStatus";
import {
  isLocalWorkspace,
  isSshWorkspace,
} from "@/types/workspace";
import { delegateWorkspaceToAgents } from "@/lib/agentHandoffs";
import { bypassCaveat, bypassStatusLabel } from "@/lib/bypassFlags";
import { useWorkspaceAgentsDogfoodStore } from "@/stores/workspaceAgentsDogfoodStore";

interface WorkspaceViewProps {
  /**
   * True only while the Workspace surface is visible. The view stays mounted
   * after its first visit to preserve live PTYs, but hidden Workspaces must not
   * cold-start or restart terminal processes in the background.
   */
  surfaceActive?: boolean;
}

export function WorkspaceView({ surfaceActive = true }: WorkspaceViewProps) {
  const workspaces = useWorkspaceStore((s) => s.workspaces);
  const activeWorkspaceId = useWorkspaceStore((s) => s.activeWorkspaceId);
  const setActiveWorkspace = useWorkspaceStore((s) => s.setActiveWorkspace);
  const setBypassPermissions = useWorkspaceStore((s) => s.setBypassPermissions);
  const initialized = useAppStore((s) => s.initialized);
  const projectPath = useLayoutStore((s) => s.projectPath);
  const [onboardingDone, setOnboardingDone] = useState<boolean>(() => isOnboardingComplete());
  // D2: the Git panel's VISIBILITY belongs to the RightDock. appStore keeps
  // only the deep-link scope written by the in-tile ReviewBar "Finish →
  // Commit…" CTA (openGitPanelForConversation).
  const gitPanelConversationId = useAppStore((s) => s.gitPanelConversationId);
  const gitPanelWorkspaceId = useAppStore((s) => s.gitPanelWorkspaceId);
  const gitPanelVisible = useRightDockStore((s) =>
    isPanelVisible(s.surfaces, "workspace", "git"),
  );
  const toggleDockPanel = useRightDockStore((s) => s.togglePanel);
  const [showCreate, setShowCreate] = useState(false);
  // Global creation entry points (Toolbar "+ New", Ctrl+K palette) publish a
  // token instead of mounting their own modal — this surface owns the one
  // creation form, and the new workspace lands here anyway.
  const creationRequest = useWorkspaceStore((s) => s.creationRequest);
  const clearWorkspaceCreationRequest = useWorkspaceStore((s) => s.clearWorkspaceCreationRequest);
  useEffect(() => {
    if (creationRequest == null) return;
    setShowCreate(true);
    clearWorkspaceCreationRequest?.();
  }, [creationRequest, clearWorkspaceCreationRequest]);
  // Tile program (P4-S1): the tab-strip dot reads the SINGLE status truth
  // (sessionStatus rollup — max severity across member tiles), not a local
  // liveness heuristic.
  const workspaceStatuses = useWorkspaceStatuses();

  const activeWorkspace = workspaces.find((w) => w.id === activeWorkspaceId);

  // Does the selected workspace's project directory still exist?
  //
  // `null` = not checked yet (or not applicable). A workspace whose folder has
  // been moved or deleted used to open to an empty mosaic with the reason
  // stated ONLY inside the sidebar's FILES subtree — which is collapsed by
  // default, so the click looked like it did nothing at all. Remote
  // workspaces are skipped: their path lives on the remote host and
  // `path_is_dir` would answer about the wrong machine.
  const [projectPathMissing, setProjectPathMissing] = useState<string | null>(null);
  const activeProjectPath = activeWorkspace?.projectPath;
  const activeIsLocal = activeWorkspace ? isLocalWorkspace(activeWorkspace) : false;
  useEffect(() => {
    if (!activeProjectPath || !activeIsLocal) {
      setProjectPathMissing(null);
      return;
    }
    let cancelled = false;
    void pathIsDir(activeProjectPath)
      .then((ok) => {
        if (!cancelled) setProjectPathMissing(ok ? null : activeProjectPath);
      })
      // A failed probe is not proof the path is gone — say nothing rather than
      // accuse the directory of being missing on the strength of an IPC error.
      .catch(() => {
        if (!cancelled) setProjectPathMissing(null);
      });
    return () => {
      cancelled = true;
    };
  }, [activeProjectPath, activeIsLocal]);
  const activeNonArchived = workspaces.filter((w) => w.status === "active");
  const recordVisibleConversations = useWorkspaceAgentsDogfoodStore(
    (state) => state.recordVisibleConversations,
  );
  const visibleConversationCount =
    activeWorkspace?.panes.filter((pane) => pane.kind === "conversation").length ?? 0;

  useEffect(() => {
    recordVisibleConversations(visibleConversationCount);
  }, [recordVisibleConversations, visibleConversationCount]);

  // Scope the GitDashboard's WorktreeLifecycleBar to the project Workspace
  // opened by the Agent handoff. No conversation pane is created; the explicit
  // Workspace id prevents stale scope after a tab switch.
  const scopedGitConversationId =
    gitPanelConversationId && gitPanelWorkspaceId === activeWorkspace?.id
      ? gitPanelConversationId
      : undefined;

  const showOnboarding =
    initialized && !onboardingDone && activeNonArchived.length === 0 && !projectPath;

  const bypassOn = activeWorkspace?.bypassPermissions ?? false;

  // FAULT: the header read a flat "Bypass perms: on" even when the workspace
  // held CLIs that have no bypass flag (OpenCode, PacketCode), so the control
  // claimed an effect the spawn path never applied. Derive the caveat from the
  // same table `WorkspacePane` reads when it builds the launch args.
  const bypassAgentIds = activeWorkspace?.panes.map((p) => p.agentId) ?? [];
  const bypassGap = bypassCaveat(bypassAgentIds);
  const bypassLabel = bypassStatusLabel(bypassOn, bypassAgentIds);

  // File viewers and saved conversations carry an inert agentId "terminal";
  // classify by kind before grouping actual CLI panes by agent/account.
  //
  // Multi-account: the key also carries the pane's `accountId`, so two
  // `claude-code` tiles under two different logins stay two badges with two
  // account dots instead of collapsing into an indistinguishable "Claude x2".
  // Ambient panes key on the agent alone and render exactly as before.
  const agentBadges: (ReturnType<typeof workspacePaneSummaryIdentity> & { count: number })[] = [];
  if (activeWorkspace) {
    const byKey = new Map<string, (typeof agentBadges)[number]>();
    for (const pane of activeWorkspace.panes) {
      const identity = workspacePaneSummaryIdentity(pane);
      const existing = byKey.get(identity.key);
      if (existing) {
        existing.count += 1;
      } else {
        const entry = { ...identity, count: 1 };
        byKey.set(identity.key, entry);
        agentBadges.push(entry);
      }
    }
  }

  // D2 — the Workspace surface registers its right-side panels with the ONE
  // dock instead of rendering competing fixed-width columns (P0-2). D3 stays
  // honoured: the local-FS editor is disabled (not hidden) on SSH workspaces.
  const workspaceRemote = Boolean(activeWorkspace && !isLocalWorkspace(activeWorkspace));
  const gitProjectPath = activeWorkspace
    ? workspaceRemote
      ? (activeWorkspace.remoteProjectPath ?? activeWorkspace.projectPath)
      : activeWorkspace.projectPath
    : "";
  const dockPanels: RightDockPanel[] = !activeWorkspace
    ? []
    : [
        {
          id: "editor",
          label: "Editor",
          icon: FileText,
          disabled: workspaceRemote,
          disabledReason: REMOTE_UNSUPPORTED_TOOLTIP,
          render: () => <EditorDockPanel />,
        },
        {
          id: "git",
          label: "Git",
          icon: GitBranch,
          render: () => (
            <GitDashboard
              projectPath={gitProjectPath}
              workspaceId={activeWorkspace.id}
              serverId={isSshWorkspace(activeWorkspace) ? activeWorkspace.serverId : undefined}
              conversationId={scopedGitConversationId}
            />
          ),
        },
      ];

  return (
    <div className="flex flex-1 overflow-hidden">
      <div className="relative flex flex-1 flex-col overflow-hidden">
        {/* Merged header: workspace tabs · CLI badges · + Add Session · git
            toggle · pane-layout presets · bypass perms.
            Replaces the previous two-row layout (workspace context header
            stacked above WorkspaceSubTabs). The active tab's tooltip now
            carries the project-path info the old folder chip used to show. */}
        {initialized && activeNonArchived.length > 0 && (
          <div className="flex h-[33px] shrink-0 items-stretch border-b border-line-soft bg-bg-primary px-2">
            <div className="flex items-stretch gap-0 overflow-x-auto">
              {activeNonArchived.map((ws) => {
                const isActive = ws.id === activeWorkspaceId;
                const dot = attentionDot(workspaceStatuses.get(ws.id) ?? "idle");
                return (
                  <button
                    key={ws.id}
                    onClick={() => setActiveWorkspace(ws.id)}
                    title={ws.projectPath}
                    className={`relative flex items-center gap-1.5 whitespace-nowrap px-3 text-[11px] transition-colors ${
                      isActive ? "text-text-primary" : "text-text-muted hover:text-text-secondary"
                    }`}
                  >
                    <span
                      className={`h-1.5 w-1.5 rounded-full ${dot.className} ${dot.pulse ? "animate-pulse" : ""}`}
                    />
                    <span>{ws.name}</span>
                    {isActive && (
                      <span className="absolute bottom-0 left-2 right-2 h-[2px] rounded-t bg-accent-green" />
                    )}
                  </button>
                );
              })}
              <button
                onClick={() => setShowCreate(true)}
                className="flex items-center px-2 text-text-muted transition-colors hover:text-text-primary"
                // Differentiated from the Fleet sidebar's "New workspace" CTA,
                // which is the instant path. Same noun, explicit about the fork.
                title="New workspace (choose template)…"
              >
                <Plus size={12} />
              </button>
            </div>
            <div className="flex-1" />
            <div className="flex items-center gap-2">
              {activeWorkspace &&
                agentBadges.map(({ key, label, color: c, accountId, count }) => {
                  return (
                    <span
                      key={key}
                      className={`flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] ${c.bg} ${c.text}`}
                    >
                      {/* Account binding stays visible for background /
                          non-focused tiles, whose own header may be off-screen
                          (zoom) or easy to skim past. Ambient panes: nothing. */}
                      <AccountDot accountId={accountId} />
                      {label}
                      {count > 1 && ` x${count}`}
                    </span>
                  );
                })}
              {activeWorkspace && (
                <AddSessionPicker
                  workspace={activeWorkspace}
                  variant="popover"
                  onOpenTemplates={() => setShowCreate(true)}
                />
              )}
              {activeWorkspace && (
                <button
                  type="button"
                  onClick={() => delegateWorkspaceToAgents(activeWorkspace.id)}
                  className="flex items-center gap-1 rounded border border-bg-border bg-bg-secondary px-2 py-0.5 text-[10px] text-text-secondary transition-colors hover:bg-bg-hover hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-50"
                  title="Delegate work on this project to a GUI agent"
                >
                  <Bot size={10} />
                  Delegate
                </button>
              )}
              {activeWorkspace && (
                <button
                  onClick={() => toggleDockPanel("workspace", "git")}
                  className={`rounded p-1 transition-colors ${
                    gitPanelVisible
                      ? "bg-accent-green/20 text-accent-green"
                      : "text-text-muted hover:bg-bg-tertiary hover:text-text-primary"
                  }`}
                  title="Git Dashboard"
                >
                  <GitBranch size={12} />
                </button>
              )}
              <button
                onClick={() =>
                  activeWorkspace && setBypassPermissions(activeWorkspace.id, !bypassOn)
                }
                disabled={!activeWorkspace}
                className={`flex items-center gap-1 rounded border px-2 py-0.5 text-[10px] transition-colors ${
                  bypassOn
                    ? "border-accent-line bg-accent-soft text-accent-amber"
                    : "border-bg-border bg-bg-secondary text-text-muted hover:text-text-secondary"
                } disabled:opacity-50`}
                title={
                  bypassOn && bypassGap
                    ? `Bypass permission prompts for this workspace. ${bypassGap}`
                    : "Bypass permission prompts for this workspace"
                }
              >
                <Zap size={10} />
                <span>Bypass perms: {bypassLabel}</span>
              </button>
            </div>
          </div>
        )}
        {showCreate && <WorkspaceCreationModal onClose={() => setShowCreate(false)} />}

        {/* Main content area: workspace panes + the ONE right dock (D2).
            `relative` anchors the dock's overlay mode at narrow widths. */}
        <div className="relative flex flex-1 overflow-hidden">
          {/* Workspace panes */}
          <div className="flex flex-1 flex-col overflow-hidden">
            {/* All active workspaces stay mounted so PTY sessions persist */}
            {initialized &&
              activeNonArchived.map((ws) => {
                const empty = ws.panes.length === 0;
                return (
                  <div
                    key={ws.id}
                    className="flex flex-1 flex-col overflow-hidden"
                    style={{ display: ws.id === activeWorkspaceId ? "flex" : "none" }}
                  >
                    {empty ? (
                      <div className="flex flex-1 flex-col items-center justify-center gap-3 p-6">
                        <div className="text-center text-xs text-text-muted">
                          Add your first CLI session to this workspace
                        </div>
                        <AddSessionPicker
                          workspace={ws}
                          variant="inline"
                          onOpenTemplates={() => setShowCreate(true)}
                        />
                      </div>
                    ) : projectPathMissing && ws.id === activeWorkspaceId ? (
                      // Say it where the user clicked. The sidebar's FILES
                      // subtree also reports this, but it is collapsed by
                      // default, so without this the workspace opened to a
                      // blank mosaic and the click read as a no-op.
                      <div className="flex flex-1 select-none flex-col items-center justify-center px-6 text-center text-text-muted">
                        <FolderX size={28} className="mb-3 text-accent-red opacity-70" />
                        <p className="text-xs text-text-secondary">
                          This workspace&apos;s project folder is missing
                        </p>
                        <p className="mt-1 max-w-lg break-all font-mono text-[11px] text-accent-red">
                          {projectPathMissing}
                        </p>
                        <p className="mt-3 max-w-md text-[11px]">
                          Its sessions are still saved and nothing has been deleted. Restore
                          the folder at that path, or create a new workspace pointing
                          somewhere that exists.
                        </p>
                      </div>
                    ) : (
                      <WorkspaceMosaicContainer
                        workspace={ws}
                        autoStartTerminals={surfaceActive && ws.id === activeWorkspaceId}
                        surfaceActive={surfaceActive}
                      />
                    )}
                  </div>
                );
              })}
          </div>

          {/* D2 — one dock, one visible panel, one resizer, one width budget.
              The Editor and the Git Dashboard used to render as independent
              480px + 280px columns that could stack (P0-2). */}
          <RightDock
            surface="workspace"
            panels={dockPanels}
            ariaLabel="Workspace panels"
          />
        </div>

        {/* No workspace selected */}
        {initialized &&
          !activeWorkspace &&
          (showOnboarding ? (
            <OnboardingPane onComplete={() => setOnboardingDone(true)} />
          ) : (
            <div className="flex flex-1 select-none flex-col items-center justify-center text-text-muted">
              <LayoutGrid size={28} className="mb-3 opacity-30" />
              <p className="text-xs">Select a workspace from the sidebar or create a new one</p>
            </div>
          ))}
      </div>
    </div>
  );
}
