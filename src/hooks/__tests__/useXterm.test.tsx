import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useXterm } from "@/hooks/useXterm";

const mocks = vi.hoisted(() => ({
  fits: [] as ReturnType<typeof vi.fn>[],
  refreshes: [] as ReturnType<typeof vi.fn>[],
  resizePty: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/tauri", () => ({
  writePty: vi.fn().mockResolvedValue(undefined),
  resizePty: mocks.resizePty,
}));
vi.mock("@xterm/xterm", () => ({
  Terminal: class {
    cols = 80;
    rows = 24;
    container!: HTMLElement;
    resize?: (size: { cols: number; rows: number }) => void;
    parser = { registerCsiHandler: vi.fn() };
    unicode = { activeVersion: "" };
    refresh = vi.fn();
    constructor() {
      mocks.refreshes.push(this.refresh);
    }
    open(container: HTMLElement) {
      this.container = container;
    }
    loadAddon(addon: { activate?: (terminal: unknown) => void }) {
      addon.activate?.(this);
    }
    onData() {}
    onResize(callback: typeof this.resize) {
      this.resize = callback;
    }
    dispose() {}
  },
}));
vi.mock("@xterm/addon-fit", () => ({
  FitAddon: class {
    terminal!: {
      cols: number;
      rows: number;
      container: HTMLElement;
      resize?: (size: { cols: number; rows: number }) => void;
    };
    fit = vi.fn(() => {
      const cols = Math.floor(this.terminal.container.offsetWidth / 8);
      const rows = Math.floor(this.terminal.container.offsetHeight / 16);
      if (cols !== this.terminal.cols || rows !== this.terminal.rows) {
        Object.assign(this.terminal, { cols, rows });
        this.terminal.resize?.({ cols, rows });
      }
    });
    constructor() {
      mocks.fits.push(this.fit);
    }
    activate(terminal: typeof this.terminal) {
      this.terminal = terminal;
    }
  },
}));
vi.mock("@xterm/addon-web-links", () => ({ WebLinksAddon: class {} }));
vi.mock("@xterm/addon-unicode11", () => ({ Unicode11Addon: class {} }));
vi.mock("@xterm/addon-webgl", () => ({
  WebglAddon: class {
    onContextLoss() {}
    dispose() {}
  },
}));

let nextFrame = 0;
const frames = new Map<number, FrameRequestCallback>();
const observers: ResizeObserverCallback[] = [];

function frame() {
  const callbacks = [...frames.values()];
  frames.clear();
  act(() => callbacks.forEach((callback) => callback(performance.now())));
}

function pane(id: string, initialWidth = 640, initialHeight = 384) {
  let width = initialWidth;
  let height = initialHeight;
  const container = document.createElement("div");
  Object.defineProperties(container, {
    offsetWidth: { get: () => width },
    offsetHeight: { get: () => height },
  });
  const hook = renderHook(() =>
    useXterm({
      containerRef: { current: container },
      sessionIdRef: { current: id },
    }),
  );
  const observer = observers[observers.length - 1];
  const resize = (nextWidth: number, nextHeight: number, notify = true) => {
    width = nextWidth;
    height = nextHeight;
    if (notify)
      act(() =>
        observer(
          [{ target: container, contentRect: { width, height } } as unknown as ResizeObserverEntry],
          {} as ResizeObserver,
        ),
      );
  };
  return {
    ...hook,
    resize,
    fit: mocks.fits[mocks.fits.length - 1],
    refresh: mocks.refreshes[mocks.refreshes.length - 1],
  };
}

describe("terminal resize batching", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.fits.length = 0;
    mocks.refreshes.length = 0;
    frames.clear();
    observers.length = 0;
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      const id = ++nextFrame;
      frames.set(id, callback);
      return id;
    });
    vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
    vi.stubGlobal(
      "ResizeObserver",
      class {
        constructor(callback: ResizeObserverCallback) {
          observers.push(callback);
        }
        observe() {}
        disconnect() {}
      },
    );
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it.each([4, 8])(
    "bounds a %i-pane layout burst to one fit and final PTY size per pane per frame",
    (count) => {
      const panes = Array.from({ length: count }, (_, index) => pane(`pty-${index}`));
      for (const item of panes) item.fit.mockClear();
      for (let notification = 0; notification < 100; notification++) {
        for (const item of panes) item.resize(800 + notification * 8, 480);
      }
      expect(mocks.resizePty).not.toHaveBeenCalled();
      expect(frames.size).toBe(count);
      frame();
      expect(mocks.resizePty).toHaveBeenCalledTimes(count);
      panes.forEach((item, index) => {
        expect(item.fit).toHaveBeenCalledOnce();
        expect(mocks.resizePty).toHaveBeenCalledWith(`pty-${index}`, 199, 30);
        item.resize(1592, 480);
      });
      expect(frames.size).toBe(0);
    },
  );

  it("cancels stale work when hidden, then fits and repaints on return", () => {
    const item = pane("pty-visible");
    item.fit.mockClear();
    item.resize(800, 480);
    item.resize(0, 0);
    frame();
    expect(item.fit).not.toHaveBeenCalled();
    expect(mocks.resizePty).not.toHaveBeenCalled();
    item.resize(800, 480);
    frame();
    expect(item.fit).toHaveBeenCalledOnce();
    expect(item.refresh).toHaveBeenCalledOnce();
    expect(mocks.resizePty).toHaveBeenCalledWith("pty-visible", 100, 30);
  });

  it("checks visibility again when a frame runs before the hidden observer notification", () => {
    const item = pane("pty-late-hide");
    item.fit.mockClear();
    item.resize(800, 480);
    item.resize(0, 0, false);
    frame();
    expect(item.fit).not.toHaveBeenCalled();
    item.resize(800, 480);
    frame();
    expect(item.fit).toHaveBeenCalledOnce();
    expect(item.refresh).toHaveBeenCalledOnce();
  });

  it("does not fit a hidden initial pane and releases a queued frame on unmount", () => {
    const item = pane("pty-hidden", 0, 0);
    expect(item.fit).not.toHaveBeenCalled();
    item.resize(800, 480);
    expect(frames.size).toBe(1);
    item.unmount();
    frame();
    expect(item.fit).not.toHaveBeenCalled();
    expect(mocks.resizePty).not.toHaveBeenCalled();
    expect(item.result.current.xtermRef.current).toBeNull();
  });
});
