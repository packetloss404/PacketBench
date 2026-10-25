import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import type { Terminal } from "@xterm/xterm";
import type { FitAddon } from "@xterm/addon-fit";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import {
  createPtySession,
  describePtyExitOutcome,
  killPty,
  listPtySessions,
  parsePtyExitPayload,
  ptyExitOutcomeOf,
  readPtyTranscript,
  writePty,
  type PtyExitOutcome,
  type PtyExitPayload,
} from "@/lib/tauri";
import { logSwallowed } from "@/lib/logSwallowed";
import { ptyExitEvent, ptyOutputEvent } from "@/lib/events";
import type { AgentStatusPatterns } from "@/types/agent";
import {
  bufferedPtyRemainder,
  parsePtyOutputPayload,
  type PtyOutputPayload,
} from "@/lib/ptyReplay";
import { useLayoutStore } from "@/stores/layoutStore";
import { useTabStore } from "@/stores/tabStore";
import { useActivityStore } from "@/stores/activityStore";
import { useMemoryStore } from "@/stores/memoryStore";
import { memoryScopeForWorkspace } from "@/lib/memoryWriteScope";
import { usePtyStateDetector, type PtyDetectorState } from "@/hooks/usePtyStateDetector";
import {
  notifyApprovalNeeded,
  notifySessionComplete,
  notifySessionError,
} from "@/lib/notifications";

/** Keep a stable ref for a callback so it can be used inside effects without adding it as a dependency. */
function useLatestRef<T>(value: T): RefObject<T> {
  const ref = useRef(value);
  ref.current = value;
  return ref;
}

interface UseTerminalSessionOptions {
  paneId: string;
  /** Gate the single automatic launch performed by this hook instance. */
  autoStart?: boolean;
  cliCommand: string;
  cliArgs?: string[];
  env?: Record<string, string>;
  customCli?: boolean;
  statusPatterns?: AgentStatusPatterns;
  projectPath?: string;
  /**
   * The workspace this pane belongs to. Memory capture resolves its scope from
   * this, so a session in a remote workspace is recorded under that
   * workspace's `ssh:` scope instead of being stamped with a bare path that no
   * remote scope can ever match.
   */
  workspaceId?: string;
  initialPrompt?: string;
  issueId?: string;
  xtermRef: RefObject<Terminal | null>;
  fitAddonRef: RefObject<FitAddon | null>;
  sessionIdRef: RefObject<string | null>;
  onSessionCreated?: (sessionId: string) => void;
  onSessionEnded?: () => void;
}

export interface TerminalActivityInfo {
  tool: string | null;
  file: string | null;
  state: PtyDetectorState["agentState"];
}

let sessionCounter = 0;

// Panes with an in-flight `startSession()`. StrictMode / double-mount can fire
// two auto-starts for the same pane a few ms apart; without deduping, each spawns
// its own PTY. That's invisible for claude/codex (multiple instances coexist) but
// fatal for opencode, whose second instance exits 1 and leaves the pane's xterm
// bound to a dead session — i.e. a permanently blank pane. Module-scoped so it
// dedupes across separate hook/component instances of the same pane.
const panesStarting = new Set<string>();

// Sessions shorter than this are noise (a mistyped command, an instant crash)
// and are not worth a memory event. Was 30s, which combined with the
// natural-exit-only gate meant almost nothing was ever captured.
const MIN_MEMORY_CAPTURE_MS = 10_000;

export function useTerminalSession({
  paneId,
  autoStart = true,
  cliCommand,
  cliArgs,
  env,
  customCli,
  statusPatterns,
  projectPath: paneProjectPath,
  workspaceId,
  initialPrompt,
  issueId,
  xtermRef,
  fitAddonRef,
  sessionIdRef,
  onSessionCreated,
  onSessionEnded,
}: UseTerminalSessionOptions) {
  const tabIdRef = useRef<string | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const unlistenersRef = useRef<UnlistenFn[]>([]);
  const exitRequestedRef = useRef(false);
  const endedSessionIdsRef = useRef(new Set<string>());
  const autoStartTriggeredRef = useRef(false);
  // Spawning is async and the pane can be closed while it is in flight. Without
  // this the unmount cleanup reads a still-null `sessionIdRef`, kills nothing,
  // and the resolved spawn leaves a live `claude`/`codex` process behind with
  // no owner — plus writes the dead pane's session back into `layoutStore`.
  const mountedRef = useRef(true);
  // Mirrored so the unmount cleanup can attribute a memory capture without
  // taking `cliCommand` as a dependency (which would re-arm the cleanup).
  const cliCommandRef = useRef(cliCommand);
  cliCommandRef.current = cliCommand;

  // Store callbacks in refs so they never destabilize memoised effects.
  const onSessionCreatedRef = useLatestRef(onSessionCreated);
  const onSessionEndedRef = useLatestRef(onSessionEnded);
  const emitSessionEnded = useCallback(
    (sessionId: string | null) => {
      if (!sessionId || endedSessionIdsRef.current.has(sessionId)) return;
      endedSessionIdsRef.current.add(sessionId);
      onSessionEndedRef.current?.();
    },
    [onSessionEndedRef],
  );

  const [alive, setAlive] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showApproval, setShowApproval] = useState(false);
  const [activityInfo, setActivityInfo] = useState<TerminalActivityInfo>({
    tool: null,
    file: null,
    state: "idle",
  });
  const [currentSessionId, setCurrentSessionId] = useState<string | null>(null);
  // How the last session in this pane ended. Survives the session itself so
  // the header can keep saying "exit 3221225477" after the CLI is gone —
  // previously the pane just stopped and said nothing at all.
  const [lastExit, setLastExit] = useState<PtyExitOutcome | null>(null);

  const globalProjectPath = useLayoutStore((s) => s.projectPath);
  const projectPath = paneProjectPath ?? globalProjectPath;

  // The unmount path captures from a cleanup callback that deliberately does
  // not re-subscribe to props, so the scope inputs ride along in a ref.
  const memoryScopeInputRef = useLatestRef({ workspaceId, projectPath });

  const handleStateChange = useCallback(
    (prev: PtyDetectorState, next: PtyDetectorState) => {
      const tabId = tabIdRef.current;
      const sessionId = sessionIdRef.current;

      setShowApproval(next.needsApproval);
      setActivityInfo({
        tool: next.currentTool,
        file: next.currentFile,
        state: next.agentState,
      });

      if (tabId) {
        useActivityStore.getState().setActivity(tabId, {
          currentTool: next.currentTool,
          currentFile: next.currentFile,
          agentState: next.agentState,
          lastActivityAt: next.lastActivityAt,
        });
      }

      if (tabId) {
        if (next.needsApproval && !prev.needsApproval) {
          useTabStore.getState().updateTabStatus(tabId, "waiting_approval");
          const tab = useTabStore.getState().getTab(tabId);
          if (sessionId && tab) {
            notifyApprovalNeeded(sessionId, tab.name);
          }
        } else if (!next.needsApproval && prev.needsApproval) {
          useTabStore.getState().updateTabStatus(tabId, "running");
        }
      }
    },
    [sessionIdRef],
  );

  const detectorResult = usePtyStateDetector({
    sessionId: currentSessionId,
    statusPatterns,
    onStateChange: handleStateChange,
  });

  const startDurationTimer = useCallback((tabId: string) => {
    if (timerRef.current) {
      clearInterval(timerRef.current);
    }
    const startTime = Date.now();
    timerRef.current = setInterval(() => {
      const elapsed = Date.now() - startTime;
      useTabStore.getState().updateTabDuration(tabId, elapsed);
    }, 1000);
  }, []);

  const stopDurationTimer = useCallback(() => {
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const startSession = useCallback(async () => {
    const term = xtermRef.current;
    const fitAddon = fitAddonRef.current;
    if (!term || !fitAddon) return;

    // Dedupe concurrent starts for the same pane (set synchronously before the
    // first await, so a near-simultaneous duplicate start bails out here). The
    // flag is cleared once the spawn resolves/fails, so legitimate restarts later
    // still work.
    if (paneId) {
      if (panesStarting.has(paneId)) return;
      panesStarting.add(paneId);
    }

    // Kill any existing PTY session before starting a new one to prevent
    // orphans. Swallow kill errors — the PTY may already have exited; the
    // restart will succeed regardless.
    const prevSid = sessionIdRef.current;
    if (prevSid) {
      exitRequestedRef.current = true;
      await killPty(prevSid).catch(() => {});
      sessionIdRef.current = null;
    }

    for (const fn of unlistenersRef.current) {
      fn();
    }
    unlistenersRef.current = [];
    stopDurationTimer();

    setError(null);
    setShowApproval(false);
    // A restart clears the previous run's verdict — the header must not keep
    // showing "exit 127" over a session that is starting fresh.
    setLastExit(null);
    setActivityInfo({ tool: null, file: null, state: "idle" });
    exitRequestedRef.current = false;
    term.reset();

    try {
      fitAddon.fit();
    } catch {
      // ignore
    }

    const cols = term.cols;
    const rows = term.rows;

    sessionCounter++;
    const tabId = `tab_${Date.now()}_${sessionCounter}`;
    tabIdRef.current = tabId;

    try {
      useTabStore.getState().addTab({
        id: tabId,
        ptySessionId: "",
        name: `Session ${sessionCounter}`,
        ticketId: issueId ?? null,
        status: "starting",
        startedAt: Date.now(),
        projectPath,
      });

      const sessionId = await createPtySession(
        projectPath,
        cols,
        rows,
        cliCommand,
        cliArgs || null,
        env ?? null,
        ...(customCli ? [true] as const : []),
      );

      if (paneId) panesStarting.delete(paneId);
      if (!mountedRef.current) {
        // Pane went away mid-spawn. Reap before touching any ref or store —
        // the unmount cleanup already ran and will never see this session.
        // (It already removed the tab we registered above.)
        await killPty(sessionId).catch(() => {});
        return;
      }

      sessionIdRef.current = sessionId;
      setCurrentSessionId(sessionId);
      setAlive(true);

      useLayoutStore.getState().setPaneSession(paneId, sessionId);
      onSessionCreatedRef.current?.(sessionId);

      useTabStore.getState().updateTabStatus(tabId, "running");
      useTabStore.setState((s) => ({
        tabs: s.tabs.map((t) => (t.id === tabId ? { ...t, ptySessionId: sessionId } : t)),
      }));

      startDurationTimer(tabId);

      let buffering = true;
      const buffered: PtyOutputPayload[] = [];
      let exitWhileBuffering = false;
      // The exit payload that arrived while output was still buffering, so a
      // deferred `finishSession()` reports the real outcome instead of losing
      // it. Without this the buffering path would silently downgrade every
      // crash to a clean exit — the same bug one layer down.
      let bufferedExit: PtyExitPayload | null = null;
      let sessionFinished = false;
      const finishSession = (exit: PtyExitPayload | null = null) => {
        if (sessionFinished) return;
        if (buffering) {
          exitWhileBuffering = true;
          bufferedExit = exit;
          return;
        }
        sessionFinished = true;
        for (const fn of unlistenersRef.current) {
          try {
            fn();
          } catch {
            // listener already gone
          }
        }
        unlistenersRef.current = [];

        const wasRequested = exitRequestedRef.current;
        // The four-way outcome. `wasRequested` (Kill / Restart / pane close
        // driven from this hook) downgrades whatever the child reported to
        // `killed`: the backend flags those with `terminated` too, but the
        // request is the authority on this side and a race where the exit
        // event lands first must still not be read as a crash.
        const observed = ptyExitOutcomeOf(exit);
        const outcome: PtyExitOutcome =
          wasRequested && observed.kind !== "killed"
            ? { kind: "killed", exitCode: exit?.exitCode ?? null }
            : observed;
        // Only a genuinely observed non-zero code is a failure. A deliberate
        // kill is a control action, and an unreadable status is an absence of
        // evidence — neither is the CLI crashing.
        const failed = outcome.kind === "failed";
        setLastExit(outcome);
        setAlive(false);
        setShowApproval(false);
        setCurrentSessionId(null);
        sessionIdRef.current = null;
        useLayoutStore.getState().setPaneSession(paneId, null);
        emitSessionEnded(sessionId);
        // Say which it was. Previously every ending printed "[Session ended]"
        // in grey, so a CLI that access-violated on startup was visually
        // identical to one that did its job and returned 0.
        term.write(
          outcome.kind === "failed"
            ? `\r\n\x1b[31m[${describePtyExitOutcome(outcome)}]\x1b[0m\r\n`
            : outcome.kind === "unknown"
              ? `\r\n\x1b[33m[${describePtyExitOutcome(outcome)}]\x1b[0m\r\n`
              : outcome.kind === "killed"
                ? "\r\n\x1b[90m[Session stopped]\x1b[0m\r\n"
                : "\r\n\x1b[90m[Session ended]\x1b[0m\r\n",
        );
        useTabStore.getState().updateTabStatus(tabId, failed ? "error" : "done");
        stopDurationTimer();

        const tab = useTabStore.getState().getTab(tabId);
        if (tab) {
          notifySessionComplete(sessionId, tab.name);
        }

        useActivityStore.getState().clearActivity(tabId);

        // Auto-learn from completed sessions. A user-requested exit (Kill,
        // Restart, closing the pane) is still a session that happened, so it
        // is recorded too — just stamped `killed` rather than `done`. Gating
        // on `!wasRequested` meant every ordinary way of ending a session
        // skipped capture, which is why the Memory pane stayed empty.
        //
        // `killed` covers BOTH a kill this hook asked for and one the backend
        // reported via `terminated`, so a deliberate stop is never scored as a
        // successful task completion. `unknown` still stamps `done`: the
        // memory schema has no fourth state, and a long session whose exit
        // status we could not read is not evidence of failure.
        if (tab && projectPath && tab.durationMs > MIN_MEMORY_CAPTURE_MS) {
          void useMemoryStore
            .getState()
            .learnFromSession(
              sessionId,
              cliCommand,
              memoryScopeForWorkspace(workspaceId, projectPath),
              tab.durationMs,
              outcome.kind === "killed" ? "killed" : failed ? "error" : "done",
            );
        }
      };

      const outputUnlisten = await listen<unknown>(ptyOutputEvent(sessionId), (event) => {
        const output = parsePtyOutputPayload(event.payload);
        if (buffering) {
          buffered.push(output);
        } else {
          term.write(output.data);
        }
      });

      const exitUnlisten = await listen<unknown>(ptyExitEvent(sessionId), (event) => {
        finishSession(parsePtyExitPayload(event.payload));
      });

      unlistenersRef.current = [outputUnlisten, exitUnlisten];
      if (sessionFinished) {
        outputUnlisten();
        exitUnlisten();
        unlistenersRef.current = [];
      }
      if (!mountedRef.current) {
        // Unmounted while the two `listen()` calls were in flight, so the
        // cleanup drained an empty `unlistenersRef`. Drop them here or both
        // stay subscribed forever, writing into a disposed xterm. The PTY
        // itself was already reaped by the cleanup — `sessionIdRef` was set
        // before these awaits.
        outputUnlisten();
        exitUnlisten();
        unlistenersRef.current = [];
        return;
      }

      const transcript = await readPtyTranscript(sessionId).catch(() => null);
      const replayed = transcript?.data ?? "";
      if (replayed) term.write(replayed);
      const bufferedRemainder = bufferedPtyRemainder(replayed, transcript?.sequence, buffered);
      if (bufferedRemainder) term.write(bufferedRemainder);
      buffering = false;
      if (exitWhileBuffering) finishSession(bufferedExit);

      const sessions = await listPtySessions().catch(() => null);
      const liveSession = sessions?.find((s) => s.id === sessionId);
      if (sessions && (!liveSession || !liveSession.alive)) finishSession();
      if (sessionFinished) return;

      if (initialPrompt?.trim()) {
        // Claude Code is ready for input immediately; other CLIs (e.g. OpenCode)
        // need time to initialize their TUI before accepting stdin.
        const delay = cliCommand === "claude" ? 0 : 3000;
        const sendInitialPrompt = () => {
          writePty(sessionId, `${initialPrompt.trim()}\n`).catch((err) => {
            // Surface — a swallowed failure here means the memory /
            // workspace initial prompt never reached the agent and the
            // user can't tell why their first turn looks empty.
            console.error(
              `[useTerminalSession] failed to write initial prompt to ${cliCommand} session ${sessionId}:`,
              err,
            );
          });
        };
        if (delay > 0) {
          setTimeout(sendInitialPrompt, delay);
        } else {
          sendInitialPrompt();
        }
      }
    } catch (err) {
      if (paneId) panesStarting.delete(paneId);
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg);
      const label = cliCommand.charAt(0).toUpperCase() + cliCommand.slice(1);
      term.write(`\x1b[31mFailed to start ${label}: ${msg}\x1b[0m\r\n`);
      term.write(`\x1b[90mMake sure '${cliCommand}' is installed and on your PATH.\x1b[0m\r\n`);
      useTabStore.getState().updateTabStatus(tabId, "error");
      stopDurationTimer();

      notifySessionError(tabId, `Session ${sessionCounter}`);
    }
  }, [
    projectPath,
    workspaceId,
    cliCommand,
    cliArgs,
    env,
    customCli,
    startDurationTimer,
    stopDurationTimer,
    paneId,
    issueId,
    initialPrompt,
    xtermRef,
    fitAddonRef,
    sessionIdRef,
    onSessionCreatedRef,
    emitSessionEnded,
  ]);

  // Auto-start at most once, and only after the owning Workspace is both
  // visible and selected. The component remains mounted after navigation so a
  // live PTY survives, but toggling visibility or changing memoized launch
  // options must never silently restart it.
  useEffect(() => {
    if (!autoStart || autoStartTriggeredRef.current) return;
    const timer = setTimeout(() => {
      if (autoStartTriggeredRef.current) return;
      autoStartTriggeredRef.current = true;
      void startSession();
    }, 200);
    return () => clearTimeout(timer);
  }, [autoStart, startSession]);

  // Cleanup on unmount
  useEffect(() => {
    // Re-armed on every mount: StrictMode's mount/unmount/mount cycle reuses
    // the same ref instance.
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      for (const fn of unlistenersRef.current) {
        fn();
      }
      stopDurationTimer();
      // Release the start-dedupe flag in case we unmount mid-spawn.
      if (paneId) panesStarting.delete(paneId);
      const sid = sessionIdRef.current;
      if (sid) {
        exitRequestedRef.current = true;
        // Capture before the tab is removed below — unmount tears the exit
        // listeners down, so `finishSession` never runs on this path and the
        // session would otherwise be lost to memory entirely.
        const tid = tabIdRef.current;
        const tab = tid ? useTabStore.getState().getTab(tid) : null;
        if (tab?.projectPath && tab.durationMs > MIN_MEMORY_CAPTURE_MS) {
          // Reading `.current` at cleanup time is the point, not a mistake:
          // this effect must NOT re-run when the project path changes (that
          // would tear down a live PTY), so the scope inputs cannot be deps.
          // eslint-disable-next-line react-hooks/exhaustive-deps
          const { workspaceId: wsId, projectPath: paneProject } = memoryScopeInputRef.current;
          void useMemoryStore
            .getState()
            .learnFromSession(
              sid,
              cliCommandRef.current,
              memoryScopeForWorkspace(wsId, paneProject || tab.projectPath),
              tab.durationMs,
              "killed",
            );
        }
        // Unmount cleanup — swallow errors; PTY may already be dead.
        killPty(sid).catch(() => {});
      }
      useLayoutStore.getState().setPaneSession(paneId, null);
      emitSessionEnded(sid);
      const tid = tabIdRef.current;
      if (tid) {
        useTabStore.getState().removeTab(tid);
        useActivityStore.getState().clearActivity(tid);
      }
    };
  }, [paneId, stopDurationTimer, sessionIdRef, memoryScopeInputRef, emitSessionEnded]);

  const handleKill = useCallback(async () => {
    const sid = sessionIdRef.current;
    if (sid) {
      exitRequestedRef.current = true;
      // User-initiated kill — swallow if already exited.
      await killPty(sid).catch(() => {});
      setAlive(false);
    }
    setShowApproval(false);
    setCurrentSessionId(null);
    sessionIdRef.current = null;
    useLayoutStore.getState().setPaneSession(paneId, null);
    emitSessionEnded(sid);
    stopDurationTimer();
    const tid = tabIdRef.current;
    if (tid) {
      useTabStore.getState().updateTabStatus(tid, "done");
      useActivityStore.getState().clearActivity(tid);
    }
  }, [paneId, stopDurationTimer, sessionIdRef, emitSessionEnded]);

  const handleRestart = useCallback(async () => {
    const sid = sessionIdRef.current;
    if (sid) {
      exitRequestedRef.current = true;
      // Restart kills the prior PTY — swallow if already exited.
      await killPty(sid).catch(() => {});
    }
    sessionIdRef.current = null;
    setAlive(false);
    setShowApproval(false);
    setCurrentSessionId(null);
    useLayoutStore.getState().setPaneSession(paneId, null);
    emitSessionEnded(sid);
    stopDurationTimer();

    const tid = tabIdRef.current;
    if (tid) {
      useTabStore.getState().removeTab(tid);
      useActivityStore.getState().clearActivity(tid);
    }
    tabIdRef.current = null;

    // Clear the terminal so restart feels like a fresh session
    xtermRef.current?.clear();

    await startSession();
  }, [paneId, startSession, stopDurationTimer, xtermRef, sessionIdRef, emitSessionEnded]);

  const handleApprove = useCallback(() => {
    const sid = sessionIdRef.current;
    if (sid) {
      writePty(sid, "y\n").catch(logSwallowed("useTerminalSession.approve"));
    }
    setShowApproval(false);
    detectorResult.clearApproval();
  }, [detectorResult, sessionIdRef]);

  const handleDeny = useCallback(() => {
    const sid = sessionIdRef.current;
    if (sid) {
      writePty(sid, "n\n").catch(logSwallowed("useTerminalSession.deny"));
    }
    setShowApproval(false);
    detectorResult.clearApproval();
  }, [detectorResult, sessionIdRef]);

  const handleAbort = useCallback(() => {
    const sid = sessionIdRef.current;
    if (sid) {
      writePty(sid, "\x03").catch(logSwallowed("useTerminalSession.abort"));
    }
    setShowApproval(false);
    detectorResult.clearApproval();
  }, [detectorResult, sessionIdRef]);

  const clearApproval = detectorResult.clearApproval;

  return {
    sessionId: currentSessionId,
    alive,
    error,
    /** How the last session ended, or `null` if none has ended yet. */
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
  };
}
