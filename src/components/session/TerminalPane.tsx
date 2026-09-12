import { useRef } from "react";
import { AlertTriangle } from "lucide-react";
import { useLayoutStore } from "@/stores/layoutStore";
import { describePtyExitOutcome, type PtyExitOutcome } from "@/lib/tauri";
import { useTerminalSession } from "@/hooks/useTerminalSession";
import { useXterm } from "@/hooks/useXterm";
import { useApprovalShortcuts } from "@/hooks/useApprovalShortcuts";
import { useTerminalFocus } from "@/hooks/useTerminalFocus";
import { ActivityStrip } from "@/components/session/ActivityStrip";
import { TerminalHeader } from "@/components/session/TerminalHeader";
import { ApprovalOverlay } from "@/components/session/ApprovalOverlay";
import { SessionStatusBar } from "@/components/session/SessionStatusBar";
import "@xterm/xterm/css/xterm.css";

export interface TerminalHeaderRenderState {
  alive: boolean;
  error: string | null;
  showApproval: boolean;
  cliCommand: string;
  /**
   * How the last PTY session in this pane ended, or `null` if none has. A
   * custom header MUST distinguish `failed` from `clean`: without it a CLI
   * that died on startup looks exactly like one the user closed.
   */
  lastExit: PtyExitOutcome | null;
  onRestart: () => void;
  onKill: () => void | Promise<void>;
}

interface TerminalPaneProps {
  paneId: string;
  /** Whether this mounted pane may perform its one automatic PTY launch. */
  autoStart?: boolean;
  onClose?: () => void;
  showCloseButton?: boolean;
  cliCommand?: string;
  cliArgs?: string[];
  env?: Record<string, string>;
  /** Multi-account: forwarded to the default header's account chip. Callers
   *  supplying `renderHeader` render their own chip. */
  accountId?: string | null;
  initialPrompt?: string;
  projectPath?: string;
  /** Owning workspace — memory capture resolves its (local vs ssh) scope from it. */
  workspaceId?: string;
  issueId?: string;
  onSessionCreated?: (sessionId: string) => void;
  onSessionEnded?: () => void;
  /** When provided, replaces the default TerminalHeader bar entirely. */
  renderHeader?: (state: TerminalHeaderRenderState) => React.ReactNode;
}

export function TerminalPane({
  paneId,
  autoStart = true,
  onClose,
  showCloseButton = false,
  cliCommand = "claude",
  cliArgs,
  env,
  accountId,
  initialPrompt,
  projectPath: paneProjectPath,
  workspaceId,
  issueId,
  onSessionCreated,
  onSessionEnded,
  renderHeader,
}: TerminalPaneProps) {
  const termContainerRef = useRef<HTMLDivElement>(null);
  const approvalFocusRef = useRef<HTMLDivElement>(null);
  const sessionIdRef = useRef<string | null>(null);
  const setActivePaneId = useLayoutStore((s) => s.setActivePaneId);

  const clearApprovalRef = useRef<() => void>(() => {});
  const { xtermRef, fitAddonRef } = useXterm({
    containerRef: termContainerRef,
    sessionIdRef,
    onUserInput: () => clearApprovalRef.current(),
  });

  const {
    sessionId,
    alive,
    error,
    lastExit,
    showApproval,
    activityInfo,
    projectPath,
    handleKill,
    handleRestart,
    handleApprove,
    handleDeny,
    handleAbort,
    clearApproval,
  } = useTerminalSession({
    paneId,
    autoStart,
    cliCommand,
    cliArgs,
    env,
    projectPath: paneProjectPath,
    workspaceId,
    initialPrompt,
    issueId,
    xtermRef,
    fitAddonRef,
    sessionIdRef,
    onSessionCreated,
    onSessionEnded,
  });

  clearApprovalRef.current = clearApproval;

  const focusTerminal = useTerminalFocus({
    paneId,
    workspaceId,
    containerRef: termContainerRef,
    xtermRef,
    approvalRef: approvalFocusRef,
    showApproval: showApproval && alive,
  });

  useApprovalShortcuts({
    showApproval,
    paneId,
    xtermRef,
    onApprove: handleApprove,
    onDeny: handleDeny,
    onAbort: handleAbort,
    onRestoreFocus: focusTerminal,
  });

  const showActivityStrip = alive && activityInfo.state !== "idle" && activityInfo.tool !== null;

  return (
    <div
      className="flex h-full flex-col bg-bg-primary"
      data-dictation-pty-session={sessionId ?? undefined}
      data-terminal-pane={paneId}
      onFocusCapture={() => setActivePaneId(paneId)}
      onClick={(event) => {
        setActivePaneId(paneId);
        focusTerminal(event.target);
      }}
    >
      {renderHeader ? (
        renderHeader({
          alive,
          error,
          showApproval,
          cliCommand,
          lastExit,
          onRestart: handleRestart,
          onKill: handleKill,
        })
      ) : (
        <TerminalHeader
          alive={alive}
          error={error}
          showApproval={showApproval}
          cliCommand={cliCommand}
          lastExit={lastExit}
          accountId={accountId}
          onRestart={handleRestart}
          onKill={handleKill}
          onClose={onClose}
          showCloseButton={showCloseButton}
        />
      )}

      <div className="relative flex-1 overflow-hidden" style={{ padding: "4px 2px 0 4px" }}>
        <div ref={termContainerRef} className="h-full w-full overflow-hidden" />
        {showApproval && alive && (
          <ApprovalOverlay
            focusRef={approvalFocusRef}
            onApprove={handleApprove}
            onDeny={handleDeny}
            onAbort={handleAbort}
          />
        )}
      </div>

      {showActivityStrip && (
        <ActivityStrip
          state={activityInfo.state}
          tool={activityInfo.tool}
          file={activityInfo.file}
        />
      )}

      {alive && activityInfo.state === "thinking" && !activityInfo.tool && (
        <ActivityStrip state="thinking" tool={null} file={null} />
      )}

      {/* The pane used to simply stop when a CLI crashed: no error, no exit
          code, nothing to act on. A failed or unreadable exit now leaves a
          persistent bar with the code, what it usually means, and a restart. */}
      {!alive && (lastExit?.kind === "failed" || lastExit?.kind === "unknown") && (
        <div
          className={`flex items-center gap-2 border-t px-3 py-1.5 text-[11px] ${
            lastExit.kind === "failed"
              ? "border-accent-red/30 bg-accent-red/5 text-accent-red"
              : "border-accent-amber/30 bg-accent-amber/5 text-accent-amber"
          }`}
        >
          <AlertTriangle size={12} className="shrink-0" />
          <span className="truncate" title={describePtyExitOutcome(lastExit)}>
            {describePtyExitOutcome(lastExit)}
          </span>
          <div className="flex-1" />
          <button
            onClick={handleRestart}
            className="shrink-0 rounded border border-current px-1.5 py-0.5 text-[10px] opacity-80 hover:opacity-100"
          >
            Restart
          </button>
        </div>
      )}

      <SessionStatusBar cliCommand={cliCommand} alive={alive} projectPath={projectPath} />
    </div>
  );
}
