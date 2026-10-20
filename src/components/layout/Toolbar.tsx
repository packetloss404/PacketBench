import { useState, useRef, useEffect } from "react";
import {
  FolderOpen,
  Wrench,
  Mic,
  Search,
  Plus,
  ChevronDown,
  Target,
  Ticket,
  LayoutGrid,
  Bookmark,
} from "lucide-react";
import { DropdownItem } from "./DropdownItem";
import { SidecarStatusChip } from "./SidecarStatusChip";
import { RunningAgentsChip } from "./RunningAgentsChip";
import { useLayoutStore } from "@/stores/layoutStore";
import { useAppStore, isModuleView, moduleViewId } from "@/stores/appStore";
import { useModuleStore } from "@/stores/moduleStore";
import { flightContextFromWorkspace } from "@/lib/flightLaunchContext";
import { getModulesSorted } from "@/modules/registry";
import { ROUTE_REGISTRY, resolveModuleAlias } from "@/lib/routeRegistry";
import { open } from "@tauri-apps/plugin-dialog";
import { useWorkspaceStore } from "@/stores/workspaceStore";
import { NewIssueForm } from "@/components/issues/NewIssueForm";
import { Modal } from "@/components/ui/Modal";
import { getPreferredWorkspaceCli } from "@/lib/workspaceCliDefaults";
import { openWorkspaceCreationModal } from "@/lib/workspaceCreation";
import { TERMINAL_AGENTS } from "@/lib/agent-catalog";
import { isLocalWorkspace } from "@/types/workspace";

/**
 * Human label for the CLI this picker will actually seed, e.g. "a PacketCode".
 * The copy used to hardcode "a Claude Code pane" while the code has always
 * used `getPreferredWorkspaceCli()` (packetcode > claude-code > codex > …).
 */
function preferredCliLabel(): string {
  const slot = getPreferredWorkspaceCli();
  const face = TERMINAL_AGENTS.find((entry) => entry.slot === slot)?.face ?? "a default CLI";
  return /^[aeiou]/i.test(face) ? `an ${face}` : `a ${face}`;
}

/** Last path segment, OS-agnostic. Used to seed the new workspace name. */
function basenameOfPath(p: string): string {
  const trimmed = p.replace(/[\\/]+$/, "");
  const seg = trimmed.split(/[\\/]/).pop() ?? "";
  return seg || trimmed || "workspace";
}

export function Toolbar() {
  const setProjectPath = useLayoutStore((s) => s.setProjectPath);
  const projectPath = useLayoutStore((s) => s.projectPath);
  const [showToolsMenu, setShowToolsMenu] = useState(false);
  const [showNewMenu, setShowNewMenu] = useState(false);
  const openFlightBrief = useAppStore((state) => state.openFlightBrief);
  const [showNewIssue, setShowNewIssue] = useState(false);
  // v0.8.8: when no workspace is active, picking a folder pops a small
  // disambiguation dialog (create-new vs. set-default-only). Holds the
  // path the user selected from the OS picker while they decide.
  const [pendingPickedPath, setPendingPickedPath] = useState<string | null>(null);
  const setCommandPaletteOpen = useAppStore((s) => s.setCommandPaletteOpen);
  const toolsMenuRef = useRef<HTMLDivElement>(null);
  const newMenuRef = useRef<HTMLDivElement>(null);

  const activeView = useAppStore((s) => s.activeView);
  const setActiveView = useAppStore((s) => s.setActiveView);
  const moduleStates = useModuleStore((s) => s.states);
  // v0.8.8: the active workspace drives both the picker title and the
  // tooltip copy. When no workspace is active, the picker offers a
  // create-vs-default fork instead of silently writing the fallback.
  const activeWorkspace = useWorkspaceStore((s) =>
    s.workspaces.find((w) => w.id === s.activeWorkspaceId),
  );
  const createWorkspace = useWorkspaceStore((s) => s.createWorkspace);

  const enabledModules = getModulesSorted().filter((mod) => moduleStates[mod.id]?.enabled ?? false);

  // Close tools menu when clicking outside
  useEffect(() => {
    if (!showToolsMenu) return;
    function handleClick(e: MouseEvent) {
      if (toolsMenuRef.current && !toolsMenuRef.current.contains(e.target as Node)) {
        setShowToolsMenu(false);
      }
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [showToolsMenu]);

  // Close "New" menu when clicking outside
  useEffect(() => {
    if (!showNewMenu) return;
    function handleClick(e: MouseEvent) {
      if (newMenuRef.current && !newMenuRef.current.contains(e.target as Node)) {
        setShowNewMenu(false);
      }
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [showNewMenu]);

  async function handleOpenFolder() {
    // v0.8.8: smart picker. With an active workspace, the title makes it
    // clear the choice will rebind THAT workspace's project folder. With
    // no workspace, we don't silently write the fallback — we let the
    // user choose whether to create a workspace or just stash the path.
    if (activeWorkspace && !isLocalWorkspace(activeWorkspace)) return;
    const titled = activeWorkspace
      ? `Change folder for "${activeWorkspace.name}"`
      : "Open project folder";
    const selected = await open({
      directory: true,
      multiple: false,
      title: titled,
    });
    if (!selected) return;
    const path = selected as string;
    if (activeWorkspace) {
      // setProjectPath writes through to the active workspace
      // (layoutStore subscription in v88-A), so this is the only call
      // needed. Remote workspaces don't get rebound through this path —
      // the workspaceStore subscription guards on serverId — so a no-op
      // here is the right answer for SSH workspaces too.
      setProjectPath(path);
      return;
    }
    // No active workspace: surface the disambiguation dialog.
    setPendingPickedPath(path);
  }

  function handleCreateWorkspaceFromPicker(path: string) {
    const id = createWorkspace(basenameOfPath(path), [getPreferredWorkspaceCli()], path);
    setPendingPickedPath(null);
    // Land the user on the workspace view so the new workspace's panes
    // become visible immediately — otherwise the create is invisible.
    if (id) setActiveView("workspace");
  }

  function handleSetDefaultFromPicker(path: string) {
    // Store on the fallback field only. No workspace was active, so the
    // workspaceStore subscription has nothing to write through to.
    setProjectPath(path);
    setPendingPickedPath(null);
  }

  return (
    <div className="flex h-9 items-center gap-2 border-b border-bg-border bg-bg-secondary px-3">
      {/* Left section: search + global "New" dropdown */}
      <div className="flex items-center gap-2">
        {/* Ctrl+K Search chip — opens the command palette */}
        <button
          onClick={() => setCommandPaletteOpen(true)}
          className="flex items-center gap-1.5 rounded border border-bg-border bg-bg-secondary px-2 py-0.5 text-xs text-text-secondary transition-colors hover:bg-bg-elevated hover:text-text-primary"
          title="Search and navigate (Ctrl+K)"
        >
          <Search size={12} />
          <span>Search</span>
          <span className="rounded bg-bg-primary px-1 font-mono text-[9px] text-text-muted">
            Ctrl+K
          </span>
        </button>

        {/* Global "+ New" dropdown */}
        <div className="relative" ref={newMenuRef}>
          <button
            onClick={() => setShowNewMenu((v) => !v)}
            className={`flex items-center gap-1 rounded border border-bg-border px-2 py-0.5 text-xs transition-colors ${
              showNewMenu
                ? "bg-bg-elevated text-text-primary"
                : "bg-bg-secondary text-text-secondary hover:bg-bg-elevated hover:text-text-primary"
            }`}
            title="Create a new workspace, flight, or issue"
          >
            <Plus size={12} />
            <span>New</span>
            <ChevronDown size={10} className="text-text-muted" />
          </button>

          {showNewMenu && (
            <div className="absolute left-0 top-full z-50 mt-1 w-52 rounded-lg border border-bg-border bg-bg-secondary py-1 shadow-xl">
              {/* The app's top-level object belongs in the app's top-level
                  create menu. Opens the full creation form on the Workspace
                  surface (one modal owner — see workspaceStore.creationRequest). */}
              <DropdownItem
                icon={<LayoutGrid size={12} className="text-accent-green" />}
                label="New Workspace"
                onClick={() => {
                  openWorkspaceCreationModal();
                  setShowNewMenu(false);
                }}
              />
              <DropdownItem
                icon={<Target size={12} className="text-accent-green" />}
                label="New Flight"
                onClick={() => {
                  openFlightBrief(
                    activeWorkspace ? flightContextFromWorkspace(activeWorkspace) : { projectPath },
                  );
                  setShowNewMenu(false);
                }}
              />
              <DropdownItem
                icon={<Ticket size={12} className="text-accent-amber" />}
                label="New Issue"
                onClick={() => {
                  setShowNewIssue(true);
                  setShowNewMenu(false);
                }}
              />
            </div>
          )}
        </div>
      </div>

      <div className="flex-1" />

      {/* Right section */}
      <div className="flex items-center gap-2">
        {/* Sidecar status chip (v2 Tier 2 slice B) */}
        <SidecarStatusChip />

        {/* Running agents tray — only renders when at least one agent is
            mid-stream. Click to inspect / jump / stop. */}
        <RunningAgentsChip />

        <div className="h-4 w-px self-center bg-bg-border" />

        {/* Optional Tools (modules) dropdown — primary nav lives in LeftRail */}
        {/* D4: modules that are aliases of a first-class shell route (Dictation)
            are filtered out here by the route registry rather than by a
            hardcoded id; Dictation surfaces via the dedicated VT button, the
            CommandPalette, and the StatusStrip indicator instead. */}
        {(() => {
          const toolbarModules = enabledModules.filter((mod) => !resolveModuleAlias(mod.id));
          if (toolbarModules.length === 0) return null;
          return (
            <div className="relative" ref={toolsMenuRef}>
              <button
                onClick={() => setShowToolsMenu(!showToolsMenu)}
                className={`flex items-center gap-1.5 rounded px-2 py-0.5 text-xs transition-colors ${
                  isModuleView(activeView)
                    ? "bg-bg-elevated text-accent-green"
                    : "bg-bg-elevated text-text-secondary hover:text-accent-green"
                }`}
                title="Tools — open one of the optional tool modules."
              >
                <Wrench size={12} className="text-accent-green" />
                <span>Tools</span>
              </button>

              {showToolsMenu && (
                <div className="absolute right-0 top-full z-50 mt-1 w-48 rounded-lg border border-bg-border bg-bg-secondary py-1 shadow-xl">
                  {toolbarModules.map((mod) => {
                    const Icon = mod.icon;
                    return (
                      <DropdownItem
                        key={mod.id}
                        icon={<Icon size={12} className={mod.iconColor} />}
                        label={mod.name}
                        onClick={() => {
                          setActiveView(moduleViewId(mod.id));
                          setShowToolsMenu(false);
                        }}
                      />
                    );
                  })}
                </div>
              )}
            </div>
          );
        })()}

        {/* Dictation (VT) button */}
        <button
          onClick={() => setActiveView("dictation")}
          className={`flex items-center gap-1.5 rounded px-2 py-0.5 text-xs transition-colors ${
            activeView === "dictation"
              ? "bg-bg-elevated text-accent-purple"
              : "bg-bg-elevated text-text-secondary hover:text-accent-purple"
          }`}
          title={`${ROUTE_REGISTRY.dictation.label} — ${ROUTE_REGISTRY.dictation.palette.description}. (${ROUTE_REGISTRY.dictation.hotkey?.display})`}
        >
          <Mic size={12} className="text-accent-purple" />
          <span>VT</span>
        </button>

        <div className="h-4 w-px self-center bg-bg-border" />

        {/* Open project folder */}
        {(() => {
          const activeProjectPath =
            activeWorkspace && !isLocalWorkspace(activeWorkspace)
              ? (activeWorkspace.remoteProjectPath ?? activeWorkspace.projectPath)
              : projectPath;
          const folderTooltip =
            activeWorkspace && !isLocalWorkspace(activeWorkspace)
              ? `Remote project: ${activeProjectPath || "(unset)"} (${activeWorkspace.name}) — change it in Workspace settings`
              : activeWorkspace
                ? `Project: ${activeProjectPath || "(unset)"} (${activeWorkspace.name}) — click to change`
                : projectPath
                  ? `Default folder: ${projectPath} — no workspace open. Click to change or create one.`
                  : "No workspace open — click to create one";
          return (
            <button
              onClick={handleOpenFolder}
              disabled={Boolean(activeWorkspace && !isLocalWorkspace(activeWorkspace))}
              className="flex items-center rounded bg-bg-elevated px-2 py-0.5 text-xs text-text-secondary transition-colors hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:text-text-secondary"
              title={folderTooltip}
              aria-label={folderTooltip}
            >
              <FolderOpen size={12} />
            </button>
          );
        })()}
      </div>

      {/* Modals */}
      {showNewIssue && <NewIssueForm defaultStatus="todo" onClose={() => setShowNewIssue(false)} />}
      {pendingPickedPath && (
        <FolderPickerFollowUp
          pickedPath={pendingPickedPath}
          onCreateWorkspace={() => handleCreateWorkspaceFromPicker(pendingPickedPath)}
          onSetDefault={() => handleSetDefaultFromPicker(pendingPickedPath)}
          onCancel={() => setPendingPickedPath(null)}
        />
      )}
    </div>
  );
}

/**
 * Small follow-up shown after the user picks a folder while no workspace
 * is active. Splits the two reasonable intents: "I want a workspace here
 * now" vs. "I'm just stashing this path as the default for next time".
 */
function FolderPickerFollowUp({
  pickedPath,
  onCreateWorkspace,
  onSetDefault,
  onCancel,
}: {
  pickedPath: string;
  onCreateWorkspace: () => void;
  onSetDefault: () => void;
  onCancel: () => void;
}) {
  return (
    <Modal
      onClose={onCancel}
      title="Use this folder"
      icon={<FolderOpen size={16} className="text-accent-green" />}
      width="w-[460px]"
      closeOnEscape
    >
      <div className="flex flex-col gap-4 px-5 py-4">
        <div>
          <div className="mb-1 text-[10px] uppercase tracking-wider text-text-muted">
            Selected folder
          </div>
          <div
            className="truncate rounded border border-bg-border bg-bg-primary px-3 py-2 font-mono text-xs text-text-primary"
            title={pickedPath}
          >
            {pickedPath}
          </div>
        </div>
        <p className="text-[11px] text-text-secondary">
          No workspace is open. Pick what to do with this folder:
        </p>
        <div className="grid grid-cols-1 gap-2">
          <button
            type="button"
            onClick={onCreateWorkspace}
            className="flex items-start gap-3 rounded border border-bg-border bg-bg-primary px-3 py-3 text-left transition-colors hover:border-accent-green/40 hover:bg-accent-green/5"
          >
            <LayoutGrid size={14} className="mt-0.5 flex-shrink-0 text-accent-green" />
            <span className="flex flex-col">
              <span className="text-[12px] font-medium text-text-primary">
                Create new workspace
              </span>
              <span className="mt-0.5 text-[10px] text-text-muted">
                Open a workspace here with {preferredCliLabel()} pane. You can adjust agents later.
              </span>
            </span>
          </button>
          <button
            type="button"
            onClick={onSetDefault}
            className="flex items-start gap-3 rounded border border-bg-border bg-bg-primary px-3 py-3 text-left transition-colors hover:border-accent-amber/40 hover:bg-accent-amber/5"
          >
            <Bookmark size={14} className="mt-0.5 flex-shrink-0 text-accent-amber" />
            <span className="flex flex-col">
              <span className="text-[12px] font-medium text-text-primary">
                Set as default for next workspace
              </span>
              <span className="mt-0.5 text-[10px] text-text-muted">
                Remember this path so the next workspace you create starts here. No workspace is
                opened now.
              </span>
            </span>
          </button>
        </div>
        <div className="flex justify-end">
          <button
            onClick={onCancel}
            className="px-3 py-1.5 text-xs text-text-secondary transition-colors hover:text-text-primary"
          >
            Cancel
          </button>
        </div>
      </div>
    </Modal>
  );
}
