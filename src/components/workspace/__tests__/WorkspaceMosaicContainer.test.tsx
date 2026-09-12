import { act, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerModal, resetModalStack, unregisterModal } from "@/lib/modalStack";
import { WorkspaceMosaicContainer } from "@/components/workspace/WorkspaceMosaicContainer";
import { useWorkspaceStore } from "@/stores/workspaceStore";
import { useReviewStore } from "@/stores/reviewStore";
import { useLayoutStore } from "@/stores/layoutStore";
import type { Workspace } from "@/types/workspace";
import type { MosaicNode } from "@/types/mosaic";
import { storageKey } from "@/lib/brand";

// Track PTY-owner mounts. TerminalPane owns the agent PTY (useTerminalSession
// auto-starts a session ~200ms after mount), so a second mounted TerminalPane
// for the same paneId IS the duplicate-agent-spawn bug this suite guards
// against, and any unmount/remount across zoom would kill the live PTY.
const mountLog = vi.hoisted(() => [] as string[]);
const saveWorkspacesSlice = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));

vi.mock("@/lib/tauri", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/tauri")>()),
  saveWorkspacesSlice,
}));

vi.mock("@/components/session/TerminalPane", async () => {
  const { useEffect } = await import("react");
  return {
    TerminalPane: ({ paneId }: { paneId: string }) => {
      useEffect(() => {
        mountLog.push(`mount:${paneId}`);
        return () => {
          mountLog.push(`unmount:${paneId}`);
        };
      }, [paneId]);
      return <div data-testid={`terminal-${paneId}`} />;
    },
  };
});

/**
 * Capture the `onRelease` the container hands to `Mosaic`, so persistence tests
 * can drive the real gesture path instead of writing to the store themselves.
 * The genuine `Mosaic` still renders — only the prop is intercepted.
 */
const releaseRef = vi.hoisted(() => ({ current: null as ((t: unknown) => void) | null }));
const renderedTree = vi.hoisted(() => ({ current: null as MosaicNode<string> | null }));

vi.mock("react-mosaic-component", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-mosaic-component")>();
  const React = await import("react");
  const Wrapped = (props: Record<string, unknown>) => {
    releaseRef.current = props.onRelease as (t: unknown) => void;
    renderedTree.current = props.value as MosaicNode<string> | null;
    return React.createElement(actual.Mosaic as never, props as never);
  };
  return { ...actual, Mosaic: Wrapped };
});

/** Fire the container's own onRelease with `tree`. */
function releaseLayout(tree: unknown) {
  if (!releaseRef.current) throw new Error("Mosaic onRelease was never wired");
  releaseRef.current(tree);
}

function makeWorkspace(): Workspace {
  const now = Date.now();
  return {
    id: "ws-1",
    name: "Zoom test workspace",
    agents: ["claude-code", "codex"],
    panes: [
      { id: "pane-a", agentId: "claude-code", sessionId: null },
      { id: "pane-b", agentId: "codex", sessionId: null },
    ],
    projectPath: "/tmp/project",
    createdAt: now,
    updatedAt: now,
    status: "active",
  };
}

function terminalCount(container: HTMLElement, paneId: string): number {
  return container.querySelectorAll(`[data-testid="terminal-${paneId}"]`).length;
}

describe("WorkspaceMosaicContainer zoom", () => {
  beforeEach(() => {
    mountLog.length = 0;
    useWorkspaceStore.setState({
      workspaces: [makeWorkspace()],
      activeWorkspaceId: "ws-1",
      zoomedPaneId: null,
    });
    useReviewStore.setState({ open: false, conversationId: null, focusPath: null });
  });

  it("mounts exactly one PTY-owning pane per tile while zoomed (no duplicate agent spawn)", () => {
    const workspace = useWorkspaceStore.getState().workspaces[0];
    const { container } = render(<WorkspaceMosaicContainer workspace={workspace} />);

    expect(terminalCount(container, "pane-a")).toBe(1);
    expect(terminalCount(container, "pane-b")).toBe(1);

    act(() => {
      useWorkspaceStore.getState().setZoomedPane("pane-a");
    });

    // The old zoom overlay mounted a SECOND WorkspacePane for the zoomed
    // pane, spawning a duplicate agent PTY. Exactly one instance must exist.
    expect(terminalCount(container, "pane-a")).toBe(1);
    // Non-zoomed panes stay mounted (hidden) so their PTYs persist.
    expect(terminalCount(container, "pane-b")).toBe(1);

    expect(mountLog.filter((e) => e === "mount:pane-a")).toHaveLength(1);
    expect(mountLog.filter((e) => e === "mount:pane-b")).toHaveLength(1);
    expect(mountLog.filter((e) => e.startsWith("unmount:"))).toHaveLength(0);
  });

  it("preserves the mounted panes across zoom in and out (PTY persistence)", () => {
    const workspace = useWorkspaceStore.getState().workspaces[0];
    const { container } = render(<WorkspaceMosaicContainer workspace={workspace} />);

    act(() => {
      useWorkspaceStore.getState().setZoomedPane("pane-a");
    });
    // Escape exits zoom
    fireEvent.keyDown(window, { key: "Escape" });

    expect(useWorkspaceStore.getState().zoomedPaneId).toBeNull();
    expect(terminalCount(container, "pane-a")).toBe(1);
    expect(terminalCount(container, "pane-b")).toBe(1);
    // No pane ever unmounted or remounted across the zoom round-trip.
    expect(mountLog.filter((e) => e === "mount:pane-a")).toHaveLength(1);
    expect(mountLog.filter((e) => e === "mount:pane-b")).toHaveLength(1);
    expect(mountLog.filter((e) => e.startsWith("unmount:"))).toHaveLength(0);
  });

  it("applies the CSS maximize hooks to the already-mounted tile", () => {
    const workspace = useWorkspaceStore.getState().workspaces[0];
    const { container } = render(<WorkspaceMosaicContainer workspace={workspace} />);

    const mosaicEl = container.querySelector(".mosaic");
    expect(mosaicEl).not.toBeNull();
    expect(mosaicEl!.classList.contains("mosaic-zoom-active")).toBe(false);
    expect(container.querySelector('[data-pane-zoomed="true"]')).toBeNull();

    act(() => {
      useWorkspaceStore.getState().setZoomedPane("pane-a");
    });

    expect(mosaicEl!.classList.contains("mosaic-zoom-active")).toBe(true);
    const zoomedWrapper = container.querySelector('[data-pane-zoomed="true"]');
    expect(zoomedWrapper).not.toBeNull();
    // The zoom marker sits on pane-a's wrapper inside its mosaic tile, which
    // mosaic-overrides.css maximizes in place.
    expect(zoomedWrapper!.querySelector('[data-testid="terminal-pane-a"]')).not.toBeNull();
    expect(zoomedWrapper!.closest(".mosaic-tile")).not.toBeNull();

    fireEvent.keyDown(window, { key: "Escape" });

    expect(mosaicEl!.classList.contains("mosaic-zoom-active")).toBe(false);
    expect(container.querySelector('[data-pane-zoomed="true"]')).toBeNull();
  });

  // ---- P3-S1 condition-based Escape layering --------------------------

  it("zoom-exit no-ops while the review surface is open (Escape closes review first, not zoom)", () => {
    // The pane must be the CONVERSATION the review is for. Review auto-zoom
    // only ever zooms that tile, and the guard is scoped to it — a review open
    // for some other conversation (a stale flag left by the Agents view) must
    // NOT block zoom-exit here. See the stale-flag test above.
    const workspace: Workspace = {
      ...useWorkspaceStore.getState().workspaces[0],
      panes: [
        {
          id: "pane-a",
          agentId: "terminal",
          sessionId: null,
          kind: "conversation",
          conversationId: "conv-1",
        },
        { id: "pane-b", agentId: "codex", sessionId: null },
      ],
    };
    useWorkspaceStore.setState({ workspaces: [workspace] });
    render(<WorkspaceMosaicContainer workspace={workspace} />);

    act(() => {
      useWorkspaceStore.getState().setZoomedPane("pane-a");
    });
    // Review is open (the tile auto-zoomed for it). Its own Escape handler
    // owns this keypress; the mosaic zoom-exit must stand down so the two
    // never double-fire off one Escape.
    act(() => {
      useReviewStore.setState({ open: true, conversationId: "conv-1" });
    });

    fireEvent.keyDown(window, { key: "Escape" });
    // Zoom survives — review would have consumed this Escape.
    expect(useWorkspaceStore.getState().zoomedPaneId).toBe("pane-a");

    // Once review is closed, the next Escape exits zoom as usual.
    act(() => {
      useReviewStore.setState({ open: false, conversationId: null });
    });
    fireEvent.keyDown(window, { key: "Escape" });
    expect(useWorkspaceStore.getState().zoomedPaneId).toBeNull();
  });
});

/**
 * Pane add/remove must not remount a SURVIVING tile.
 *
 * A remount runs `useTerminalSession`'s unmount cleanup (`killPty`) and then
 * auto-starts a fresh PTY, so remounting a survivor kills a running agent
 * mid-task. `MosaicRoot.renderRecursively` flattens each split into a keyed
 * Fragment, so a leaf that changes DEPTH lands under a differently-keyed
 * Fragment and React remounts it — reordering within one split's children is
 * safe, re-nesting is not.
 */
describe("WorkspaceMosaicContainer pane add/remove stability", () => {
  function withPanes(ids: string[]): Workspace {
    return {
      ...makeWorkspace(),
      agents: ids.map(() => "claude-code" as const),
      panes: ids.map((id) => ({ id, agentId: "claude-code" as const, sessionId: null })),
    };
  }

  beforeEach(() => {
    mountLog.length = 0;
    useWorkspaceStore.setState({
      workspaces: [makeWorkspace()],
      activeWorkspaceId: "ws-1",
      zoomedPaneId: null,
    });
  });

  it("adding panes one at a time never unmounts an already-running pane", () => {
    const { rerender } = render(<WorkspaceMosaicContainer workspace={withPanes(["pane-a"])} />);

    for (const ids of [
      ["pane-a", "pane-b"],
      ["pane-a", "pane-b", "pane-c"],
      ["pane-a", "pane-b", "pane-c", "pane-d"],
      ["pane-a", "pane-b", "pane-c", "pane-d", "pane-e"],
    ]) {
      act(() => {
        rerender(<WorkspaceMosaicContainer workspace={withPanes(ids)} />);
      });
    }

    // The regression: 2 -> 3 logged "unmount:pane-b, mount:pane-b", killing a
    // running codex when a terminal was added beside it.
    expect(mountLog.filter((e) => e.startsWith("unmount:"))).toEqual([]);
    for (const id of ["pane-a", "pane-b", "pane-c", "pane-d", "pane-e"]) {
      expect(mountLog.filter((e) => e === `mount:${id}`)).toHaveLength(1);
    }
  });

  it("removing a middle pane unmounts only that pane", () => {
    const { rerender } = render(
      <WorkspaceMosaicContainer workspace={withPanes(["pane-a", "pane-b", "pane-c"])} />,
    );
    mountLog.length = 0;

    act(() => {
      rerender(<WorkspaceMosaicContainer workspace={withPanes(["pane-a", "pane-c"])} />);
    });

    // Previously the parent split collapsed to a bare leaf, lifting pane-c a
    // level and restarting it.
    expect(mountLog).toEqual(["unmount:pane-b"]);
  });

  it("renders exactly one tile per pane at every count (no duplicate leaves)", () => {
    for (let n = 1; n <= 8; n++) {
      const ids = Array.from({ length: n }, (_, i) => `pane-${i}`);
      const { container, unmount } = render(
        <WorkspaceMosaicContainer workspace={withPanes(ids)} />,
      );
      for (const id of ids) {
        // buildPresetTree used to clamp a short id list with `Math.min`,
        // repeating the last id (n=3, n=5 -> two tiles, two PTYs for one pane)
        // and dropping ids past the preset's capacity (n=7, n=8 -> no tile).
        expect(terminalCount(container, id), `pane ${id} at n=${n}`).toBe(1);
      }
      unmount();
    }
  });
});

/**
 * Escape layering for zoom.
 *
 * Zoom is the LOWEST-priority Escape consumer. Its listener registers when
 * zoom is set — before any dialog opened afterwards registers its own — and
 * window listeners fire in registration order, so `defaultPrevented` could
 * never order the two: zoom ran first and set the very flag Modal checks.
 */
describe("WorkspaceMosaicContainer zoom Escape layering", () => {
  beforeEach(() => {
    mountLog.length = 0;
    resetModalStack();
    useWorkspaceStore.setState({
      workspaces: [makeWorkspace()],
      activeWorkspaceId: "ws-1",
      zoomedPaneId: null,
    });
    useReviewStore.setState({ open: false, conversationId: null, focusPath: null });
  });

  afterEach(() => {
    resetModalStack();
  });

  function renderZoomed() {
    const workspace = useWorkspaceStore.getState().workspaces[0];
    const result = render(<WorkspaceMosaicContainer workspace={workspace} />);
    act(() => {
      useWorkspaceStore.getState().setZoomedPane("pane-a");
    });
    return result;
  }

  it("leaves the zoom alone while any dialog is open", () => {
    renderZoomed();
    // A dialog opened AFTER the zoom — the ordering that made this fail.
    registerModal("some-dialog", 1);

    fireEvent.keyDown(window, { key: "Escape" });

    expect(useWorkspaceStore.getState().zoomedPaneId).toBe("pane-a");

    unregisterModal("some-dialog");
    fireEvent.keyDown(window, { key: "Escape" });
    expect(useWorkspaceStore.getState().zoomedPaneId).toBeNull();
  });

  it("does not steal Escape from a focused terminal", () => {
    const { container } = renderZoomed();
    const terminal = document.createElement("textarea");
    terminal.className = "xterm-helper-textarea";
    container.appendChild(terminal);

    // Escape leaving vim's insert mode must not also discard the zoom.
    fireEvent.keyDown(terminal, { key: "Escape" });
    expect(useWorkspaceStore.getState().zoomedPaneId).toBe("pane-a");

    // From outside the terminal it still exits.
    fireEvent.keyDown(window, { key: "Escape" });
    expect(useWorkspaceStore.getState().zoomedPaneId).toBeNull();
  });

  it("ignores an Escape another layer already handled", () => {
    renderZoomed();
    const handled = new KeyboardEvent("keydown", { key: "Escape", cancelable: true });
    handled.preventDefault();
    window.dispatchEvent(handled);
    expect(useWorkspaceStore.getState().zoomedPaneId).toBe("pane-a");
  });

  it("ignores Escape mid-IME composition", () => {
    renderZoomed();
    fireEvent.keyDown(window, { key: "Escape", isComposing: true });
    expect(useWorkspaceStore.getState().zoomedPaneId).toBe("pane-a");
  });

  it("keeps a background workspace's zoom, but stops consuming Escape for it", () => {
    renderZoomed();
    expect(useWorkspaceStore.getState().zoomedPaneId).toBe("pane-a");

    act(() => {
      useWorkspaceStore.setState({ activeWorkspaceId: "ws-other" });
    });

    // The zoom SURVIVES: `mosaic-zoom-active` is gated on this container owning
    // the zoomed pane, so a background zoom cannot blank the workspace on
    // screen. Clearing it here would instead race ConversationTile's review
    // auto-zoom, which never re-fires once cancelled.
    expect(useWorkspaceStore.getState().zoomedPaneId).toBe("pane-a");

    // But this container must no longer act on Escape.
    fireEvent.keyDown(window, { key: "Escape" });
    expect(useWorkspaceStore.getState().zoomedPaneId).toBe("pane-a");
  });

  it("does not consume Escape while the Workspace surface is off screen", () => {
    const workspace = useWorkspaceStore.getState().workspaces[0];
    render(<WorkspaceMosaicContainer workspace={workspace} surfaceActive={false} />);
    act(() => {
      useWorkspaceStore.getState().setZoomedPane("pane-a");
    });

    // WorkspaceView stays mounted under display:none, so Escape pressed in
    // Agents must not silently un-zoom an off-screen pane.
    fireEvent.keyDown(window, { key: "Escape" });
    expect(useWorkspaceStore.getState().zoomedPaneId).toBe("pane-a");
  });

  it("exits zoom even when a stale global review flag is left open elsewhere", () => {
    renderZoomed();
    // Opening review in Agents and switching to Workspace leaves `open` true
    // with no ReviewSurface mounted. An unscoped read made Escape permanently
    // dead here; the guard is scoped to a review OF THE ZOOMED PANE.
    act(() => {
      useReviewStore.setState({ open: true, conversationId: "conv-elsewhere" });
    });

    fireEvent.keyDown(window, { key: "Escape" });
    expect(useWorkspaceStore.getState().zoomedPaneId).toBeNull();
  });
});

/**
 * Layout persistence.
 *
 * The tree used to be pure `useState`, so every restart rebuilt it from the
 * pane-count preset and a hand-arranged layout was lost. It now round-trips
 * through `workspace.layout`.
 */
describe("WorkspaceMosaicContainer layout persistence", () => {
  function withPanes(ids: string[], layout?: unknown): Workspace {
    return {
      ...makeWorkspace(),
      agents: ids.map(() => "claude-code" as const),
      panes: ids.map((id) => ({ id, agentId: "claude-code" as const, sessionId: null })),
      ...(layout === undefined ? {} : { layout: layout as Workspace["layout"] }),
    };
  }

  beforeEach(() => {
    mountLog.length = 0;
    useWorkspaceStore.setState({
      workspaces: [makeWorkspace()],
      activeWorkspaceId: "ws-1",
      zoomedPaneId: null,
    });
  });

  it("saves the arrangement when a drag/resize gesture completes", () => {
    const ws = withPanes(["pane-a", "pane-b"]);
    useWorkspaceStore.setState({ workspaces: [ws] });
    render(<WorkspaceMosaicContainer workspace={ws} />);

    const dragged = {
      type: "split" as const,
      direction: "column" as const,
      splitPercentages: [70, 30],
      children: ["pane-b", "pane-a"],
    };
    // Drive the component's own onRelease, not the store directly — the
    // earlier version of this test asserted on a store write it made itself,
    // so it passed even with `onRelease={handleRelease}` deleted.
    act(() => {
      releaseLayout(dragged);
    });

    expect(useWorkspaceStore.getState().workspaces[0].layout).toEqual(dragged);
  });

  it("ignores the mid-drag release that collapses the dragged tile to 0%", () => {
    const ws = withPanes(["pane-a", "pane-b"]);
    useWorkspaceStore.setState({ workspaces: [ws] });
    render(<WorkspaceMosaicContainer workspace={ws} />);

    // MosaicWindow hides the dragged tile on drag START, and `hide` suppresses
    // only onChange — so a release lands mid-drag with a 0% pane. Saving it
    // would restore an invisible pane on the next launch.
    act(() => {
      releaseLayout({
        type: "split",
        direction: "row",
        splitPercentages: [0, 100],
        children: ["pane-a", "pane-b"],
      });
    });
    expect(useWorkspaceStore.getState().workspaces[0].layout).toBeUndefined();

    // The real drop still saves.
    act(() => {
      releaseLayout({
        type: "split",
        direction: "row",
        splitPercentages: [40, 60],
        children: ["pane-b", "pane-a"],
      });
    });
    expect(useWorkspaceStore.getState().workspaces[0].layout).toBeTruthy();
  });

  it("restores a saved arrangement instead of the preset", () => {
    // Column order reversed — not a shape any preset produces for 2 panes.
    const saved = {
      type: "split" as const,
      direction: "column" as const,
      children: ["pane-b", "pane-a"],
    };
    const ws = withPanes(["pane-a", "pane-b"], saved);
    useWorkspaceStore.setState({ workspaces: [ws] });

    const { container } = render(<WorkspaceMosaicContainer workspace={ws} />);

    // Both panes present exactly once, in the SAVED order.
    expect(terminalCount(container, "pane-a")).toBe(1);
    expect(terminalCount(container, "pane-b")).toBe(1);
    const tiles = [...container.querySelectorAll("[data-testid^='terminal-']")].map((el) =>
      el.getAttribute("data-testid"),
    );
    expect(tiles).toEqual(["terminal-pane-b", "terminal-pane-a"]);
  });

  it("reconciles a stale layout against the panes that actually exist", () => {
    // Saved when pane-c existed and pane-d did not.
    const stale = {
      type: "split" as const,
      direction: "row" as const,
      children: ["pane-a", "pane-c"],
    };
    const ws = withPanes(["pane-a", "pane-d"], stale);
    useWorkspaceStore.setState({ workspaces: [ws] });

    const { container } = render(<WorkspaceMosaicContainer workspace={ws} />);

    expect(terminalCount(container, "pane-a")).toBe(1);
    expect(terminalCount(container, "pane-d")).toBe(1);
    expect(terminalCount(container, "pane-c")).toBe(0);
  });

  it("falls back to the preset when the saved layout is malformed", () => {
    const ws = withPanes(["pane-a", "pane-b"], { garbage: true });
    useWorkspaceStore.setState({ workspaces: [ws] });

    const { container } = render(<WorkspaceMosaicContainer workspace={ws} />);

    expect(terminalCount(container, "pane-a")).toBe(1);
    expect(terminalCount(container, "pane-b")).toBe(1);
  });

  it("restores the displayed columns after incremental additions without restarting surviving PTYs", async () => {
    const ws = withPanes(["pane-a"]);
    useWorkspaceStore.setState({ workspaces: [ws] });
    function CurrentWorkspace() {
      const workspace = useWorkspaceStore((state) => state.workspaces[0]);
      return <WorkspaceMosaicContainer workspace={workspace} />;
    }
    const firstRun = render(<CurrentWorkspace />);
    mountLog.length = 0;

    for (let index = 0; index < 3; index++) {
      act(() => {
        useWorkspaceStore.getState().addPane(ws.id, "terminal");
      });
    }
    const displayedBeforeClose = structuredClone(renderedTree.current);
    const ids = useWorkspaceStore.getState().workspaces[0].panes.map((pane) => pane.id);
    expect(displayedBeforeClose).toMatchObject({
      type: "split",
      direction: "row",
      children: ids,
    });
    expect(mountLog.filter((entry) => entry.startsWith("unmount:"))).toEqual([]);
    expect(mountLog.filter((entry) => entry === "mount:pane-a")).toEqual([]);

    // Re-open from the actual persisted snapshot, not the in-memory tree.
    const saved = JSON.parse(localStorage.getItem(storageKey("workspaces-cache"))!);
    await waitFor(() => expect(saveWorkspacesSlice).toHaveBeenLastCalledWith(saved));
    firstRun.unmount();
    useWorkspaceStore.setState({ workspaces: [], activeWorkspaceId: null });
    useWorkspaceStore.getState().hydrateFromBackend(saved);
    mountLog.length = 0;
    render(<CurrentWorkspace />);
    expect(renderedTree.current).toEqual(displayedBeforeClose);
    for (const id of ids)
      expect(mountLog.filter((entry) => entry === `mount:${id}`)).toHaveLength(1);
  });

  it("does not bump updatedAt — rearranging tiles is not activity on the work", () => {
    const ws = withPanes(["pane-a", "pane-b"]);
    useWorkspaceStore.setState({ workspaces: [ws] });
    const before = useWorkspaceStore.getState().workspaces[0].updatedAt;

    act(() => {
      useWorkspaceStore.getState().setWorkspaceLayout("ws-1", {
        type: "split",
        direction: "row",
        children: ["pane-b", "pane-a"],
      });
    });

    expect(useWorkspaceStore.getState().workspaces[0].updatedAt).toBe(before);
  });

  it("keeps eight live PTYs mounted across readable/fit, viewport width, balance, and zoom changes", () => {
    const ids = Array.from({ length: 8 }, (_, index) => `pane-${index}`);
    const layout = {
      type: "split" as const,
      direction: "row" as const,
      children: ids,
      splitPercentages: [10, 10, 10, 10, 15, 15, 15, 15],
    };
    const workspace = withPanes(ids, layout);
    useWorkspaceStore.setState({ workspaces: [workspace] });
    useLayoutStore.setState({ activePaneId: ids[0] });
    const view = render(
      <div style={{ width: 800, height: 600 }}>
        <WorkspaceMosaicContainer workspace={workspace} />
      </div>,
    );
    const canvas = view.container.querySelector<HTMLElement>("[data-workspace-canvas]")!;
    expect(canvas.style.minWidth).toBe("3600px");
    expect(canvas.style.minHeight).toBe("240px");
    expect(view.getByRole("toolbar", { name: "Workspace pane layout" })).toBeInTheDocument();
    mountLog.length = 0;

    fireEvent.click(view.getByRole("button", { name: "Fit all" }));
    expect(canvas.style.minWidth).toBe("0px");
    expect(renderedTree.current).toEqual(layout);
    view.rerender(
      <div style={{ width: 1600, height: 900 }}>
        <WorkspaceMosaicContainer workspace={workspace} />
      </div>,
    );
    fireEvent.click(view.getByRole("button", { name: "Readable" }));
    expect(canvas.style.minWidth).toBe("3600px");
    fireEvent.click(view.getByRole("button", { name: "Balance sizes" }));
    expect(canvas.style.minWidth).toBe("2880px");
    expect(useWorkspaceStore.getState().workspaces[0].layout).toEqual({
      type: "split",
      direction: "row",
      children: ids,
    });
    fireEvent.click(view.getByRole("button", { name: "Zoom selected pane" }));
    expect(canvas.style.minWidth).toBe("0px");
    expect(view.getByRole("button", { name: "Fit all" })).toBeDisabled();
    fireEvent.click(view.getByRole("button", { name: "Show all panes" }));
    expect(canvas.style.minWidth).toBe("2880px");
    expect(mountLog).toEqual([]);
    for (const id of ids) expect(terminalCount(view.container, id)).toBe(1);
  });

  it("reveals off-screen selection and restores scroll after zoom without remounting", () => {
    const workspace = withPanes(["pane-a", "pane-b"]);
    useWorkspaceStore.setState({ workspaces: [workspace] });
    useLayoutStore.setState({ activePaneId: "pane-a" });
    const view = render(<WorkspaceMosaicContainer workspace={workspace} />);
    const viewport = view.container.querySelector<HTMLElement>("[data-workspace-viewport]")!;
    const tile = view.container
      .querySelector('[data-workspace-pane-id="pane-b"]')!
      .closest<HTMLElement>(".mosaic-tile")!;
    vi.spyOn(viewport, "getBoundingClientRect").mockReturnValue({
      left: 0,
      right: 600,
      top: 0,
      bottom: 400,
    } as DOMRect);
    const paneBounds = vi
      .spyOn(tile, "getBoundingClientRect")
      .mockReturnValue({ left: 800, right: 1160, top: 0, bottom: 240 } as DOMRect);
    fireEvent.click(view.getByRole("button", { name: "Next pane" }));
    expect(useLayoutStore.getState().activePaneId).toBe("pane-b");
    expect(viewport.scrollLeft).toBe(560);
    fireEvent.scroll(viewport);
    paneBounds.mockReturnValue({ left: 240, right: 600, top: 0, bottom: 240 } as DOMRect);
    mountLog.length = 0;
    fireEvent.click(view.getByRole("button", { name: "Zoom selected pane" }));
    expect(viewport.scrollLeft).toBe(0);
    fireEvent.click(view.getByRole("button", { name: "Show all panes" }));
    expect(viewport.scrollLeft).toBe(560);
    expect(mountLog).toEqual([]);
  });

  it("keeps the last selected pane visible after fit/readable, balance, and a settled window resize", () => {
    const observers = new Map<Element, ResizeObserverCallback>();
    const frames = new Map<number, FrameRequestCallback>();
    let frameId = 0;
    vi.stubGlobal(
      "ResizeObserver",
      class {
        constructor(private callback: ResizeObserverCallback) {}
        observe(element: Element) {
          observers.set(element, this.callback);
        }
        disconnect() {}
      },
    );
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      frames.set(++frameId, callback);
      return frameId;
    });
    vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
    const ids = Array.from({ length: 8 }, (_, index) => `pane-${index}`);
    const workspace = withPanes(ids, {
      type: "split",
      direction: "row",
      children: ids,
      splitPercentages: [20, 20, 10, 10, 10, 10, 10, 10],
    });
    useWorkspaceStore.setState({ workspaces: [workspace] });
    useLayoutStore.setState({ activePaneId: ids[0] });
    const view = render(
      <>
        <input aria-label="Unsent editor text" defaultValue="keep editing" />
        <WorkspaceMosaicContainer workspace={workspace} />
      </>,
    );
    try {
      const viewport = view.container.querySelector<HTMLElement>("[data-workspace-viewport]")!;
      const canvas = view.container.querySelector<HTMLElement>("[data-workspace-canvas]")!;
      const tile = view.container
        .querySelector(`[data-workspace-pane-id="${ids[7]}"]`)!
        .closest<HTMLElement>(".mosaic-tile")!;
      let width = 600;
      let left = 0;
      const canvasWidth = () => Math.max(width, parseFloat(canvas.style.minWidth) || 0);
      // Browser scroll ranges clamp when the canvas shrinks; jsdom needs this
      // geometry model to exercise the actual overflow transition.
      Object.defineProperty(viewport, "scrollLeft", {
        configurable: true,
        get: () => Math.min(left, Math.max(0, canvasWidth() - width)),
        set: (value: number) => {
          left = Math.max(0, Math.min(value, canvasWidth() - width));
        },
      });
      vi.spyOn(viewport, "getBoundingClientRect").mockImplementation(
        () => ({ left: 0, right: width, top: 0, bottom: 400 }) as DOMRect,
      );
      vi.spyOn(tile, "getBoundingClientRect").mockImplementation(
        () =>
          ({
            left:
              canvasWidth() *
                (renderedTree.current &&
                typeof renderedTree.current === "object" &&
                "splitPercentages" in renderedTree.current
                  ? 0.9
                  : 0.875) -
              viewport.scrollLeft,
            right: canvasWidth() - viewport.scrollLeft,
            top: 0,
            bottom: 240,
          }) as DOMRect,
      );
      fireEvent.change(view.getByRole("combobox", { name: "Select visible pane" }), {
        target: { value: ids[7] },
      });
      const editor = view.getByRole("textbox", { name: "Unsent editor text" });
      editor.focus();
      fireEvent.click(view.getByRole("button", { name: "Fit all" }));
      expect(viewport.scrollLeft).toBe(0);
      fireEvent.click(view.getByRole("button", { name: "Readable" }));
      expect(viewport.scrollLeft).toBe(3000);
      fireEvent.click(view.getByRole("button", { name: "Balance sizes" }));
      expect(viewport.scrollLeft).toBe(2280);
      const savedBeforeResize = useWorkspaceStore.getState().workspaces[0].layout;
      width = 420;
      act(() => {
        observers.get(viewport)!(
          [{ contentRect: { width, height: 400 } } as ResizeObserverEntry],
          {} as ResizeObserver,
        );
        for (const callback of frames.values()) callback(0);
        frames.clear();
      });
      expect(viewport.scrollLeft).toBe(2460);
      expect(useWorkspaceStore.getState().workspaces[0].layout).toBe(savedBeforeResize);
      expect(document.activeElement).toBe(editor);
      expect(editor).toHaveValue("keep editing");
    } finally {
      view.unmount();
      vi.unstubAllGlobals();
    }
  });
});
