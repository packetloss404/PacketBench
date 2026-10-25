import { CustomCliFields } from "./CustomCliFields";
import type { CustomCliConfig } from "@/types/workspace";
import { getWorkspaceCli, supportsLocalCli } from "@/lib/workspaceCliRegistry";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { open as openFileDialog } from "@tauri-apps/plugin-dialog";
import {
  BookOpen,
  ExternalLink,
  FileText,
  LayoutTemplate,
  Plus,
  Search,
  Settings2,
  Terminal as TerminalIcon,
} from "lucide-react";
import { TERMINAL_AGENTS } from "@/lib/agent-catalog";
import { getAgentColor } from "@/lib/agentColors";
import { INSTALL_HINTS } from "@/lib/agent-install-hints";
import { useAppStore } from "@/stores/appStore";
import { useWorkspaceStore } from "@/stores/workspaceStore";
import { useAgentStore } from "@/stores/agentStore";
import { useServerStore } from "@/stores/serverStore";
import { isAccountAwareSlot } from "@/lib/sessionAccountDefaults";
import { SessionAccountPicker } from "@/components/workspace/SessionAccountPicker";
import type { Workspace, WorkspaceAgentSlot } from "@/types/workspace";
import { useTerminalShellDetection } from "@/hooks/useTerminalShellDetection";
import { useTerminalSettingsStore } from "@/stores/terminalSettingsStore";
import {
  selectionForProfile,
  shellProfileLabel,
  shellProfilesForPlatform,
  terminalPlatform,
} from "@/lib/terminalShells";
import type { TerminalShellProfileId, TerminalShellSelection } from "@/types/terminal-shell";
import { APP_NAME } from "@/lib/brand";

interface AddSessionPickerProps {
  workspace: Workspace;
  /**
   * `popover` is the compact Workspace-header affordance (and the Fleet
   * sidebar's per-row "+"). `inline` is the empty-Workspace zero state. Both
   * expose PTY/CLI sessions plus the local file/markdown viewer tiles; GUI/API
   * conversations are still created in Agents, so there is deliberately no
   * "Chat" row here.
   *
   * `icon` is the same popover with a bare "+" trigger, for the Fleet sidebar's
   * per-workspace-row affordance where there is no room for a label.
   */
  variant: "popover" | "inline" | "icon";
  onOpenTemplates?: () => void;
}

export function AddSessionPicker({ workspace, variant, onOpenTemplates }: AddSessionPickerProps) {
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  // Viewport coords for the portalled `icon` panel (see below).
  const [anchorRect, setAnchorRect] = useState<{ top: number; left: number } | null>(null);

  useEffect(() => {
    if (variant === "inline" || !open) return;
    const handler = (event: MouseEvent) => {
      const target = event.target as Node;
      // The portalled panel lives outside `anchorRef`, so it needs its own
      // containment check or every click inside the picker would close it.
      if (anchorRef.current?.contains(target)) return;
      if (panelRef.current?.contains(target)) return;
      setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [variant, open]);

  // Close on Escape and on scroll — a fixed-position panel would otherwise
  // detach from its row as the fleet list scrolls under it.
  useEffect(() => {
    if (variant !== "icon" || !open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    const onScroll = () => setOpen(false);
    document.addEventListener("keydown", onKey);
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onScroll);
    return () => {
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onScroll);
    };
  }, [variant, open]);

  if (variant === "inline") {
    return (
      <div className="mx-auto w-full max-w-[380px] rounded-lg border border-bg-border bg-bg-secondary shadow-sm">
        <PickerContent workspace={workspace} onClose={() => {}} onOpenTemplates={onOpenTemplates} />
      </div>
    );
  }

  const isIcon = variant === "icon";

  const PANEL_WIDTH = 320;
  const PANEL_MAX_HEIGHT = 460;

  return (
    <div className="relative" ref={anchorRef}>
      <button
        type="button"
        onClick={(event) => {
          // The sidebar trigger sits inside a clickable workspace row; opening
          // the picker must not also activate/navigate that row.
          event.stopPropagation();
          if (isIcon && !open) {
            const rect = event.currentTarget.getBoundingClientRect();
            // Flip up / clamp left so the panel never runs off the viewport on
            // a bottom-of-list row or a narrow window.
            const top =
              rect.bottom + PANEL_MAX_HEIGHT > window.innerHeight
                ? Math.max(8, rect.top - PANEL_MAX_HEIGHT)
                : rect.bottom + 4;
            const left = Math.min(rect.left, window.innerWidth - PANEL_WIDTH - 8);
            setAnchorRect({ top, left: Math.max(8, left) });
          }
          setOpen((value) => !value);
        }}
        className={
          isIcon
            ? `rounded p-0.5 transition-colors ${
                open
                  ? "bg-accent-green/20 text-accent-green"
                  : "text-text-muted hover:bg-bg-tertiary hover:text-text-primary"
              }`
            : `flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] transition-colors ${
                open
                  ? "bg-accent-green/20 text-accent-green"
                  : "text-text-muted hover:bg-bg-tertiary hover:text-text-primary"
              }`
        }
        title="Add a session, terminal, or file viewer to this workspace"
        aria-label={isIcon ? "Add to this workspace" : undefined}
      >
        <Plus size={isIcon ? 12 : 11} />
        {!isIcon && "Add Session"}
      </button>
      {/* The header variant can position normally; the sidebar variant cannot.
          The Fleet sidebar is a 240px column with `overflow-hidden` on the
          shell and `overflow-y-auto` on the list, so an absolutely-positioned
          panel would be clipped on both axes. Portal it to <body> at fixed
          viewport coords instead. */}
      {open &&
        (isIcon ? (
          anchorRect &&
          createPortal(
            <div
              ref={panelRef}
              onClick={(event) => event.stopPropagation()}
              style={{
                position: "fixed",
                top: anchorRect.top,
                left: anchorRect.left,
                width: PANEL_WIDTH,
                maxHeight: PANEL_MAX_HEIGHT,
              }}
              className="z-[60] overflow-y-auto rounded-md border border-bg-border bg-bg-elevated shadow-xl"
            >
              <PickerContent
                workspace={workspace}
                onClose={() => setOpen(false)}
                onOpenTemplates={onOpenTemplates}
              />
            </div>,
            document.body,
          )
        ) : (
          <div className="absolute right-0 top-full z-50 mt-1 max-h-[75vh] w-[320px] overflow-y-auto rounded-md border border-bg-border bg-bg-elevated shadow-xl">
            <PickerContent
              workspace={workspace}
              onClose={() => setOpen(false)}
              onOpenTemplates={onOpenTemplates}
            />
          </div>
        ))}
    </div>
  );
}

interface PickerContentProps {
  workspace: Workspace;
  onClose: () => void;
  onOpenTemplates?: () => void;
}

function PickerContent({ workspace, onClose, onOpenTemplates }: PickerContentProps) {
  const [filter, setFilter] = useState("");
  const [showCustom, setShowCustom] = useState(false);
  const [customCli, setCustomCli] = useState<CustomCliConfig>();
  const [addError, setAddError] = useState<string | null>(null);
  /**
   * Multi-account CLI support: per-row explicit account choices. A slot absent
   * from this map has NOT been touched, so clicking its row stays the one-click
   * fast path — `addPane` resolves the sticky per-project default itself. A
   * present entry (an id, or `null` for the ambient login) is passed through as
   * an explicit choice and becomes the project's new sticky default.
   */
  const [accountChoices, setAccountChoices] = useState<
    Partial<Record<WorkspaceAgentSlot, string | null>>
  >({});
  const [terminalShellChoice, setTerminalShellChoice] = useState<
    TerminalShellSelection | undefined
  >(undefined);
  const agents = useAgentStore((state) => state.agents);
  const servers = useServerStore((state) => state.servers);
  const addPane = useWorkspaceStore((state) => state.addPane);
  const addFilePane = useWorkspaceStore((state) => state.addFilePane);
  const openSettings = useAppStore((state) => state.openSettings);
  const defaultTerminalShell = useTerminalSettingsStore((state) => state.defaultShell);
  const shellDetection = useTerminalShellDetection();
  const terminalProfiles = shellProfilesForPlatform(terminalPlatform()).filter(
    (profile) => profile !== "custom" || defaultTerminalShell.profile === "custom",
  );

  const isInstalled = (slot: WorkspaceAgentSlot): boolean => {
    if (slot === "terminal" || slot === "custom-cli") return true;
    if (!workspace.serverId && !supportsLocalCli(slot)) return false;
    if (workspace.serverId) {
      const server = servers.find((candidate) => candidate.id === workspace.serverId);
      return server?.installedAgents.includes(slot) ?? false;
    }
    return agents.find((agent) => agent.id === slot)?.installed ?? false;
  };

  const normalizedFilter = filter.trim().toLowerCase();
  const packetCodeReady = isInstalled("packetcode");
  const sessionRows = TERMINAL_AGENTS.filter((entry) =>
    entry.face.toLowerCase().includes(normalizedFilter),
  ).sort((left, right) => {
    const leftRecommended = left.slot === "packetcode" && packetCodeReady;
    const rightRecommended = right.slot === "packetcode" && packetCodeReady;
    if (leftRecommended !== rightRecommended) {
      return leftRecommended ? -1 : 1;
    }
    return 0;
  });

  const pickSession = (slot: WorkspaceAgentSlot) => {
    if (!isInstalled(slot)) return;
    if (slot === "custom-cli") {
      setShowCustom(true);
      return;
    }
    // One-click fast path: when the user never touched the account chip we pass
    // NO `accountId` at all, and `addPane` resolves the sticky per-project
    // default. Only a deliberate switch travels as an explicit choice.
    const touched = slot in accountChoices;
    const options: {
      accountId?: string | null;
      terminalShell?: TerminalShellSelection;
    } = {};
    if (touched) options.accountId = accountChoices[slot] ?? null;
    if (slot === "terminal" && terminalShellChoice) {
      options.terminalShell = terminalShellChoice;
    }
    try {
      setAddError(null);
      addPane(workspace.id, slot, Object.keys(options).length > 0 ? options : undefined);
      onClose();
    } catch (reason) {
      setAddError(reason instanceof Error ? reason.message : String(reason));
    }
  };

  const openPacketCodeSetup = () => {
    openSettings({ section: "cli-clients", cliId: "packetcode" });
    onClose();
  };

  /**
   * WSL as a first-class row rather than a value buried in the Terminal row's
   * shell `<select>`. It is still exactly a Terminal pane carrying a `wsl`
   * shell selection — no new pane kind, no second launch path — but "open a WSL
   * shell here" is a top-level intent, not a preference on another intent.
   * Windows-only, and hidden when no distro is installed.
   */
  const wslShell = shellDetection.shells.wsl;
  const wslDistro = shellDetection.wslDistributions[0];
  const wslAvailable =
    terminalPlatform() === "windows" && wslShell?.available !== false && Boolean(wslDistro);
  const wslLabel = wslDistro ? `WSL · ${wslDistro}` : "WSL";

  const pickWsl = () => {
    const selection = selectionForProfile("wsl", wslShell);
    if (!selection.wslDistro && wslDistro) selection.wslDistro = wslDistro;
    try {
      setAddError(null);
      addPane(workspace.id, "terminal", { terminalShell: selection });
      onClose();
    } catch (reason) {
      setAddError(reason instanceof Error ? reason.message : String(reason));
    }
  };

  /**
   * Viewer rows. Both create the same `kind: "file"` tile; "Markdown Viewer"
   * only differs by filtering the picker to .md/.mdx and asking the shared
   * `EditorPane` to open rendered. SSH workspaces have no local FS, so the rows
   * are disabled rather than hidden (same honesty rule the Editor dock uses).
   */
  const viewersDisabled = Boolean(workspace.serverId);

  const pickViewer = (mode: "any" | "markdown") => {
    // Close first: the native dialog is modal and would otherwise sit behind a
    // popover that the next outside-click dismisses anyway. The store write
    // below does not depend on this component still being mounted.
    onClose();
    void openFileDialog({
      multiple: false,
      directory: false,
      defaultPath: workspace.projectPath,
      ...(mode === "markdown"
        ? { filters: [{ name: "Markdown", extensions: ["md", "mdx"] }] }
        : {}),
    })
      .then((selected) => {
        if (typeof selected !== "string") return;
        addFilePane(workspace.id, selected, mode === "markdown" ? { view: "preview" } : undefined);
      })
      .catch(() => {
        // Dialog cancelled or unavailable — nothing to add.
      });
  };

  const viewerRows = [
    {
      key: "file-viewer",
      label: "File Viewer",
      hint: "Open any file as a tile",
      icon: FileText,
      onPick: () => pickViewer("any"),
    },
    {
      key: "markdown-viewer",
      label: "Markdown Viewer",
      hint: "Open a .md rendered",
      icon: BookOpen,
      onPick: () => pickViewer("markdown"),
    },
  ].filter((row) => row.label.toLowerCase().includes(normalizedFilter));

  const showWslRow = wslAvailable && wslLabel.toLowerCase().includes(normalizedFilter);

  return (
    <div className="py-1">
      <div className="px-2 pb-1 pt-1">
        <div className="flex items-center gap-1.5 rounded border border-bg-border bg-bg-primary px-2 py-1">
          <Search size={11} className="shrink-0 text-text-muted" />
          <input
            autoFocus
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
            placeholder="Search CLI sessions…"
            className="w-full bg-transparent text-ui text-text-primary placeholder:text-text-muted focus:outline-none"
          />
        </div>
        {addError && (
          <div role="alert" className="mt-1 rounded bg-accent-red/10 px-2 py-1 text-[9px] text-accent-red">
            {addError}
          </div>
        )}
      </div>

      {showCustom && (
        <div className="border-b border-bg-border">
          <CustomCliFields value={customCli} onChange={setCustomCli} />
          <div className="flex gap-3 px-3 pb-2 text-ui">
            <button
              type="button"
              disabled={!customCli}
              className="text-accent-green disabled:opacity-50"
              onClick={() => {
                try {
                  addPane(workspace.id, "custom-cli", { customCli });
                  onClose();
                } catch (reason) {
                  setAddError(String(reason));
                }
              }}
            >
              Add Custom CLI
            </button>
            <button type="button" className="text-text-muted" onClick={() => setShowCustom(false)}>
              Cancel
            </button>
          </div>
        </div>
      )}
      <div className="px-3 py-1 text-meta uppercase tracking-wide text-text-muted">
        CLI sessions
      </div>

      <div className="max-h-[320px] overflow-y-auto">
        {sessionRows.map((entry) => {
          const installed = isInstalled(entry.slot);
          const color = getAgentColor(entry.slot);
          const hint = INSTALL_HINTS[entry.slot];
          const recommended = entry.slot === "packetcode" && packetCodeReady;

          return (
            <div
              key={entry.slot}
              className="flex items-center gap-2 px-3 py-1.5 transition-colors hover:bg-bg-hover"
            >
              <button
                type="button"
                onClick={() => pickSession(entry.slot)}
                disabled={!installed}
                title={
                  installed
                    ? `Add ${entry.face} session`
                    : `${entry.face} is not available for this workspace. ${getWorkspaceCli(entry.slot)?.platformNotes ?? ""}`
                }
                className={`flex min-w-0 flex-1 items-center gap-2 text-left text-ui ${
                  installed ? "text-text-primary" : "cursor-not-allowed text-text-muted opacity-50"
                }`}
              >
                <span className={`h-2 w-2 shrink-0 rounded-full ${color.text} bg-current`} />
                <span className="truncate">{entry.face}</span>
                {recommended && (
                  <span className="bg-accent-amber/15 ml-auto rounded px-1.5 py-0.5 text-meta text-accent-amber">
                    Recommended
                  </span>
                )}
              </button>

              {/* Multi-account CLI support: claude-code / codex only. Renders
                  nothing until the user registers an account, so the row is
                  untouched on a zero-config install. Switching here does NOT
                  add the pane — the row click still does, now with the chosen
                  account. */}
              {installed && isAccountAwareSlot(entry.slot) && (
                <SessionAccountPicker
                  cli={entry.slot}
                  projectPath={workspace.projectPath}
                  value={entry.slot in accountChoices ? accountChoices[entry.slot] : undefined}
                  onChange={(accountId) =>
                    setAccountChoices((prev) => ({ ...prev, [entry.slot]: accountId }))
                  }
                  variant="chip"
                />
              )}

              {installed && entry.slot === "terminal" && (
                <select
                  aria-label="Shell for new Terminal session"
                  value={terminalShellChoice?.profile ?? "inherit"}
                  onChange={(event) => {
                    const raw = event.target.value;
                    if (raw === "inherit") {
                      setTerminalShellChoice(undefined);
                      return;
                    }
                    const profile = raw as TerminalShellProfileId;
                    const inherited = workspace.terminalShell ?? defaultTerminalShell;
                    const next =
                      inherited.profile === profile
                        ? { ...inherited }
                        : selectionForProfile(profile, shellDetection.shells[profile]);
                    if (profile === "wsl" && !next.wslDistro) {
                      next.wslDistro = shellDetection.wslDistributions[0];
                    }
                    setTerminalShellChoice(next);
                  }}
                  onClick={(event) => event.stopPropagation()}
                  className="max-w-[132px] shrink-0 rounded border border-bg-border bg-bg-primary px-1.5 py-0.5 text-[9px] text-text-secondary focus:border-accent-green focus:outline-none"
                >
                  <option value="inherit">Default shell</option>
                  {terminalProfiles.map((profile) => {
                    const result = shellDetection.shells[profile];
                    const unavailable =
                      profile !== "auto" && profile !== "custom" && result?.available === false;
                    return (
                      <option key={profile} value={profile} disabled={unavailable}>
                        {shellProfileLabel(profile)}
                        {unavailable ? " · unavailable" : ""}
                      </option>
                    );
                  })}
                </select>
              )}

              {!installed && entry.slot === "packetcode" && (
                <button
                  type="button"
                  onClick={openPacketCodeSetup}
                  className="hover:bg-accent-amber/10 inline-flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-meta text-accent-amber transition-colors"
                  title="Install, locate, and configure PacketCode"
                >
                  <Settings2 size={10} />
                  Set up
                </button>
              )}

              {!installed && entry.slot !== "packetcode" && hint && (
                <a
                  href={hint.url}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-meta text-text-muted hover:text-accent-amber"
                  title={hint.label}
                >
                  <ExternalLink size={10} />
                  Install
                </a>
              )}
            </div>
          );
        })}

        {showWslRow && (
          <div className="flex items-center gap-2 px-3 py-1.5 transition-colors hover:bg-bg-hover">
            <button
              type="button"
              onClick={pickWsl}
              title={`Add a ${wslLabel} terminal session`}
              className="flex min-w-0 flex-1 items-center gap-2 text-left text-ui text-text-primary"
            >
              <TerminalIcon size={11} className="shrink-0 text-accent-purple" />
              <span className="truncate">{wslLabel}</span>
            </button>
          </div>
        )}

        {sessionRows.length === 0 && !showWslRow && (
          <div className="px-3 py-2 text-ui text-text-muted">No matching CLI sessions</div>
        )}
      </div>

      {viewerRows.length > 0 && (
        <>
          <div className="my-1 border-t border-bg-border" />
          <div className="px-3 py-1 text-meta uppercase tracking-wide text-text-muted">Viewers</div>
          {viewerRows.map((row) => {
            const Icon = row.icon;
            return (
              <button
                key={row.key}
                type="button"
                onClick={row.onPick}
                disabled={viewersDisabled}
                title={
                  viewersDisabled
                    ? "File viewers read the local filesystem — not available on SSH workspaces"
                    : row.hint
                }
                className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-ui transition-colors ${
                  viewersDisabled
                    ? "cursor-not-allowed text-text-muted opacity-50"
                    : "text-text-primary hover:bg-bg-hover"
                }`}
              >
                <Icon size={11} className="shrink-0 text-accent-blue" />
                <span className="truncate">{row.label}</span>
              </button>
            );
          })}
        </>
      )}

      {!packetCodeReady && !normalizedFilter && (
        <div className="border-accent-amber/20 bg-accent-amber/5 mx-2 my-1 rounded border px-2 py-1.5 text-meta text-text-muted">
          PacketCode is the recommended {APP_NAME} terminal loop. Use{" "}
          <button
            type="button"
            onClick={openPacketCodeSetup}
            className="text-accent-amber hover:underline"
          >
            Set up
          </button>{" "}
          to install it, locate its executable, and configure its data home.
        </div>
      )}

      {onOpenTemplates && (
        <>
          <div className="my-1 border-t border-bg-border" />
          <button
            type="button"
            onClick={() => {
              onOpenTemplates();
              onClose();
            }}
            title="Opens the New Workspace form — this creates a separate workspace, it does not template the current one"
            className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-ui text-text-secondary transition-colors hover:bg-bg-hover hover:text-text-primary"
          >
            <LayoutTemplate size={12} />
            New workspace from template…
          </button>
        </>
      )}
    </div>
  );
}
