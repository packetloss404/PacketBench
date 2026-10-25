import { useEffect, useRef, useState, type ReactNode } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import { Modal } from "@/components/ui/Modal";
import {
  writePty,
  resizePty,
  describePtyExitOutcome,
  type PtyExitOutcome,
} from "@/lib/tauri";
import { useTransientPty } from "@/hooks/useTransientPty";
import { useTerminalSettingsStore } from "@/stores/terminalSettingsStore";
import "@xterm/xterm/css/xterm.css";

interface TransientPtyModalProps {
  title: string;
  icon?: ReactNode;
  command: string;
  args?: string[];
  projectPath?: string;
  /** Sent (with trailing CR) after spawn. Useful for shells that need a
   *  pre-typed install command. */
  initialInput?: string;
  /** Extra environment for the spawned process. Multi-account CLI login flows
   *  pass the target account's `CLAUDE_CONFIG_DIR` / `CODEX_HOME` here so the
   *  credentials land in that account's config dir, not the ambient one. */
  env?: Record<string, string>;
  /** When true, user keystrokes are forwarded into the PTY. When false the
   *  xterm is a read-only output viewer (good for install flows). */
  interactive?: boolean;
  /** If set, kill the PTY after this many ms. */
  timeoutMs?: number;
  onClose: () => void;
  /**
   * Reports the real PTY exit outcome before any optional auto-close.
   *
   * Callers that verify the effect of the command (an installer, a login)
   * MUST distinguish `unknown` from `clean` and re-verify rather than trust a
   * success this modal never observed.
   */
  onExit?: (outcome: PtyExitOutcome) => void;
  /** Auto-dismiss the modal this many ms after the PTY exits cleanly.
   *  0 = stay open until the user clicks Close. Only a genuinely observed
   *  exit code 0 auto-closes — an unobserved status leaves the output up. */
  autoCloseOnSuccessMs?: number;
  runningMessage?: string;
  doneMessage?: string;
  errorMessage?: string;
}

/**
 * Generic floating modal that runs a one-shot PTY, mirrors its output into
 * an embedded xterm, and auto-cleans up on close. Used by login flows and
 * install runners — anything that previously needed a workspace pane just
 * to watch a transient process.
 */
export function TransientPtyModal({
  title,
  icon,
  command,
  args,
  projectPath,
  initialInput,
  env,
  interactive = true,
  timeoutMs,
  onClose,
  onExit,
  autoCloseOnSuccessMs = 0,
  runningMessage = "Running…",
  doneMessage = "Completed.",
  errorMessage = "Ended with an error.",
}: TransientPtyModalProps) {
  const termContainerRef = useRef<HTMLDivElement>(null);
  const xtermRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const sessionIdRef = useRef<string | null>(null);
  const [exitState, setExitState] = useState<"running" | "done" | "error">("running");
  const [exitOutcome, setExitOutcome] = useState<PtyExitOutcome | null>(null);
  // V3: the transient terminal shares the one terminal text-size preference
  // instead of pinning 13px, and updates live without recreating the PTY.
  const terminalFontSizePx = useTerminalSettingsStore((s) => s.terminalFontSizePx);

  const { start, kill, sessionId } = useTransientPty({
    command,
    args,
    projectPath,
    initialInput,
    env,
    timeoutMs,
    onOutput: (chunk) => {
      xtermRef.current?.write(chunk);
    },
    onExit: (outcome) => {
      // Only an observed non-zero code is an error. `killed` is a deliberate
      // control action and `unknown` is an absence of evidence — neither is
      // the command failing, and neither is a success worth auto-closing on.
      setExitState(outcome.kind === "failed" ? "error" : "done");
      setExitOutcome(outcome);
      onExit?.(outcome);
      xtermRef.current?.write(
        `\r\n\x1b[90m[${describePtyExitOutcome(outcome)}]\x1b[0m\r\n`,
      );
      if (outcome.kind === "clean" && autoCloseOnSuccessMs > 0) {
        setTimeout(onClose, autoCloseOnSuccessMs);
      }
    },
    onError: (err) => {
      const msg = err instanceof Error ? err.message : String(err);
      xtermRef.current?.write(`\r\n\x1b[31m${msg}\x1b[0m\r\n`);
      setExitState("error");
    },
  });

  // Mirror sessionId for the xterm onData handler + sync PTY size.
  useEffect(() => {
    sessionIdRef.current = sessionId;
    if (sessionId && fitAddonRef.current && xtermRef.current) {
      try {
        fitAddonRef.current.fit();
        resizePty(sessionId, xtermRef.current.cols, xtermRef.current.rows).catch(() => {});
      } catch {
        // ignore — container may not be sized yet
      }
    }
  }, [sessionId]);

  useEffect(() => {
    if (!termContainerRef.current) return;

    const term = new Terminal({
      cursorBlink: interactive,
      disableStdin: !interactive,
      fontSize: terminalFontSizePx,
      lineHeight: 1.15,
      fontFamily: "'JetBrains Mono', 'Cascadia Code', 'Fira Code', 'Consolas', monospace",
      theme: {
        background: "#0d1117",
        foreground: "#c9d1d9",
        cursor: "#00ff41",
        cursorAccent: "#0d1117",
        selectionBackground: "#30363d",
      },
      scrollback: 5000,
      allowProposedApi: true,
    });

    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.open(termContainerRef.current);

    let webglAddon: WebglAddon | null = null;
    try {
      webglAddon = new WebglAddon();
      webglAddon.onContextLoss(() => {
        webglAddon?.dispose();
        webglAddon = null;
      });
      term.loadAddon(webglAddon);
    } catch {
      webglAddon = null;
    }

    try {
      fitAddon.fit();
    } catch {
      // initial sizing race
    }

    if (interactive) {
      term.onData((data) => {
        const sid = sessionIdRef.current;
        if (!sid) return;
        writePty(sid, data).catch(() => {});
      });
    }

    term.onResize(({ cols, rows }) => {
      if (cols < 2 || rows < 2) return;
      const sid = sessionIdRef.current;
      if (sid) resizePty(sid, cols, rows).catch(() => {});
    });

    const ro = new ResizeObserver(() => {
      try {
        fitAddon.fit();
      } catch {
        // ignore
      }
    });
    ro.observe(termContainerRef.current);

    xtermRef.current = term;
    fitAddonRef.current = fitAddon;

    start();

    return () => {
      ro.disconnect();
      if (webglAddon) {
        webglAddon.dispose();
        webglAddon = null;
      }
      term.dispose();
      xtermRef.current = null;
      fitAddonRef.current = null;
    };
    // start/kill identities are stable; run once on mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // V3: apply a terminal text-size change live — update xterm's own option and
  // refit, without recreating the Terminal or restarting the PTY.
  useEffect(() => {
    const term = xtermRef.current;
    if (!term || !term.options) return;
    term.options.fontSize = terminalFontSizePx;
    const fit = fitAddonRef.current;
    if (fit) {
      try {
        fit.fit();
      } catch {
        // Container may not be sized yet; the ResizeObserver will refit.
      }
    }
  }, [terminalFontSizePx]);

  const handleClose = () => {
    if (exitState === "running") kill();
    onClose();
  };

  // A finished run reports what actually happened. The caller's `doneMessage`
  // is only honest for an observed clean exit; a killed or unobserved exit
  // says so rather than borrowing the success wording.
  const statusText =
    exitState === "running"
      ? runningMessage
      : exitState === "error"
        ? errorMessage
        : exitOutcome && exitOutcome.kind !== "clean"
          ? describePtyExitOutcome(exitOutcome)
          : doneMessage;

  return (
    <Modal
      onClose={handleClose}
      title={title}
      icon={icon}
      width="w-[760px]"
      // Deliberate opt-out of the app-wide Escape-to-close default: the
      // embedded xterm forwards Escape to the running PTY (vim, a prompt,
      // an interactive installer), so the dialog must not eat it.
      closeOnEscape={false}
    >
      <div className="flex flex-col gap-2 p-4">
        <div
          ref={termContainerRef}
          className="h-[420px] bg-[#0d1117] rounded border border-bg-border overflow-hidden"
        />
        <div className="flex items-center justify-between text-[10px] text-text-muted">
          <span>{statusText}</span>
          <button
            onClick={handleClose}
            className="px-2 py-1 rounded border border-bg-border text-text-secondary hover:text-text-primary hover:bg-bg-tertiary text-[11px]"
          >
            {exitState === "running" ? "Cancel" : "Close"}
          </button>
        </div>
      </div>
    </Modal>
  );
}
