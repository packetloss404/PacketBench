import { useEffect, useRef, type RefObject } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { WebglAddon } from "@xterm/addon-webgl";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { writePty, resizePty } from "@/lib/tauri";

interface UseXtermOptions {
  containerRef: RefObject<HTMLDivElement | null>;
  sessionIdRef: RefObject<string | null>;
  onUserInput?: () => void;
}

export function useXterm({ containerRef, sessionIdRef, onUserInput }: UseXtermOptions) {
  const xtermRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);

  useEffect(() => {
    if (!containerRef.current) return;

    const term = new Terminal({
      cursorBlink: true,
      fontSize: 13,
      lineHeight: 1.15,
      letterSpacing: 0,
      fontFamily: "'JetBrains Mono', 'Cascadia Code', 'Fira Code', 'Consolas', monospace",
      fontWeight: "400",
      fontWeightBold: "600",
      rescaleOverlappingGlyphs: true,
      theme: {
        background: "#0d1117",
        foreground: "#c9d1d9",
        cursor: "#00ff41",
        cursorAccent: "#0d1117",
        selectionBackground: "#30363d",
        selectionForeground: "#c9d1d9",
        black: "#484f58",
        red: "#f85149",
        green: "#00ff41",
        yellow: "#f0b400",
        blue: "#58a6ff",
        magenta: "#bc8cff",
        cyan: "#39c5cf",
        white: "#c9d1d9",
        brightBlack: "#6e7681",
        brightRed: "#ffa198",
        brightGreen: "#56d364",
        brightYellow: "#e3b341",
        brightBlue: "#79c0ff",
        brightMagenta: "#d2a8ff",
        brightCyan: "#56d4dd",
        brightWhite: "#f0f6fc",
      },
      allowProposedApi: true,
      scrollback: 10000,
    });

    // xterm 6.0.0's bundled DECRQM handler (`requestMode`) throws
    // "ReferenceError: Can't find variable: i" — a minified-build bug. That
    // aborts the entire parse, so any output stream containing a DECRQM query
    // (`CSI ? Pd $ p` / `CSI Pd $ p`) renders nothing. opencode/opentui sends
    // several of these on startup, which is why its panes were blank while
    // claude/codex (which don't query) rendered fine. Intercept DECRQM with a
    // no-op so the broken built-in never runs. The CLI just doesn't receive a
    // mode-support reply, which it handles gracefully.
    term.parser.registerCsiHandler({ prefix: "?", intermediates: "$", final: "p" }, () => true);
    term.parser.registerCsiHandler({ intermediates: "$", final: "p" }, () => true);

    const fitAddon = new FitAddon();
    const webLinksAddon = new WebLinksAddon();
    const unicode11Addon = new Unicode11Addon();

    term.loadAddon(fitAddon);
    term.loadAddon(webLinksAddon);
    term.loadAddon(unicode11Addon);
    term.unicode.activeVersion = "11";
    term.open(containerRef.current);

    // Use WebGL renderer for GPU-accelerated 60fps rendering.
    // Keep a reference so we can dispose it explicitly on cleanup.
    //
    // IMPORTANT: attaching the WebGL addon against a hidden / 0x0 container
    // (e.g. a pane in a non-active workspace tile, or one mounted before layout)
    // leaves its canvas permanently blank — even once the pane is shown. Since
    // full-TUI CLIs like OpenCode only redraw on change, nothing ever repaints
    // it, so the pane stays blank. So: only attach WebGL once the container is
    // actually visible, and recreate + repaint it on the hidden->visible
    // transition (see the ResizeObserver below).
    let webglAddon: WebglAddon | null = null;
    const loadWebgl = () => {
      if (webglAddon) return;
      try {
        const addon = new WebglAddon();
        addon.onContextLoss(() => {
          // GPU context was lost (e.g. too many contexts, system sleep).
          // Dispose the addon — xterm falls back to its default canvas renderer.
          addon.dispose();
          if (webglAddon === addon) webglAddon = null;
        });
        term.loadAddon(addon);
        webglAddon = addon;
      } catch {
        // WebGL not available — falls back to default canvas renderer
        webglAddon = null;
      }
    };
    const isContainerVisible = () =>
      !!containerRef.current &&
      containerRef.current.offsetWidth > 0 &&
      containerRef.current.offsetHeight > 0;

    if (isContainerVisible()) loadWebgl();

    if (isContainerVisible()) {
      try {
        fitAddon.fit();
      } catch {
        // Container might not be sized yet
      }
    }

    xtermRef.current = term;
    fitAddonRef.current = fitAddon;

    term.onData((data) => {
      const sid = sessionIdRef.current;
      if (sid) {
        // Per-keystroke writePty — swallow silently because a broken
        // pipeline would otherwise flood the console with one entry per
        // character. The user will notice their input isn't echoing.
        writePty(sid, data).catch(() => {});
        onUserInput?.();
      }
    });

    let wasHidden = !isContainerVisible();
    let resizeFrame: number | null = null;
    let lastObservedSize: { width: number; height: number } | null = null;
    const fitVisibleContainer = () => {
      resizeFrame = null;
      // Visibility may change between the observer notification and this frame.
      if (!isContainerVisible()) {
        wasHidden = true;
        lastObservedSize = null;
        return;
      }
      try {
        fitAddon.fit();
      } catch {
        // ignore
      }
      // Pane just became visible after being hidden / 0x0. A WebGL canvas that
      // was attached while hidden comes back blank, so recreate it now that the
      // container is laid out, then force a full repaint (OpenCode et al. won't
      // redraw on their own). Panes that were visible at mount skip all of this.
      if (wasHidden) {
        wasHidden = false;
        if (webglAddon) {
          webglAddon.dispose();
          webglAddon = null;
        }
        loadWebgl();
        try {
          term.refresh(0, term.rows - 1);
        } catch {
          // ignore
        }
      }
    };
    const resizeObserver = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const { width, height } = entry.contentRect;
        // Hidden workspaces retain their PTYs and xterms; never resize them
        // to zero or run a stale fit queued before the workspace switch.
        if (width < 1 || height < 1) {
          wasHidden = true;
          lastObservedSize = null;
          if (resizeFrame !== null) cancelAnimationFrame(resizeFrame);
          resizeFrame = null;
          return;
        }
        if (!wasHidden && lastObservedSize?.width === width && lastObservedSize.height === height)
          continue;
        lastObservedSize = { width, height };
        // Splitter/layout bursts need one measurement of the final geometry,
        // not a forced fit (and potentially resize IPC) for every notification.
        if (resizeFrame === null) {
          resizeFrame = requestAnimationFrame(fitVisibleContainer);
        }
      }
    });
    resizeObserver.observe(containerRef.current);

    term.onResize(({ cols, rows }) => {
      // Guard against any residual degenerate resize slipping through.
      if (cols < 2 || rows < 2) return;
      const sid = sessionIdRef.current;
      if (sid) {
        resizePty(sid, cols, rows).catch((err) =>
          console.warn("[useXterm.resizePty] failed:", err),
        );
      }
    });

    return () => {
      resizeObserver.disconnect();
      if (resizeFrame !== null) cancelAnimationFrame(resizeFrame);
      // Dispose WebGL addon explicitly before terminal to release GPU context
      if (webglAddon) {
        webglAddon.dispose();
        webglAddon = null;
      }
      term.dispose();
      xtermRef.current = null;
      fitAddonRef.current = null;
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  return { xtermRef, fitAddonRef };
}
