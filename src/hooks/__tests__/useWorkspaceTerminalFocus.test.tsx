import { useRef } from "react";
import type { Terminal } from "@xterm/xterm";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { useAppStore } from "@/stores/appStore";
import { useLayoutStore } from "@/stores/layoutStore";
import { useWorkspaceStore } from "@/stores/workspaceStore";
import { useTerminalFocus } from "@/hooks/useTerminalFocus";
import { useWorkspacePaneNavigation } from "@/hooks/useWorkspacePaneNavigation";
import { useApprovalShortcuts, resetApprovalRegistry } from "@/hooks/useApprovalShortcuts";
import { registerModal, resetModalStack } from "@/lib/modalStack";
import type { Workspace } from "@/types/workspace";
import type { MosaicNode } from "@/types/mosaic";

vi.mock("@/stores/appStore", async () => {
  const { create } = await import("zustand");
  return { useAppStore: create(() => ({ activeView: "workspace", commandPaletteOpen: false })) };
});
vi.mock("@/stores/layoutStore", async () => {
  const { create } = await import("zustand");
  return { useLayoutStore: create(() => ({ activePaneId: "a" })) };
});
vi.mock("@/stores/workspaceStore", async () => {
  const { create } = await import("zustand");
  return {
    useWorkspaceStore: create(() => ({
      activeWorkspaceId: "ws",
      zoomedPaneId: null,
      focusPaneRequest: null,
    })),
  };
});

const workspace = {
  id: "ws",
  panes: [
    { id: "a", agentId: "terminal" },
    { id: "file", kind: "file", agentId: "terminal" },
    { id: "b", agentId: "codex" },
  ],
} as Workspace;
const tree = {
  type: "split" as const,
  direction: "row" as const,
  children: [
    "b",
    { type: "split" as const, direction: "column" as const, children: ["file", "a"] },
  ],
};
let focusCalls: Record<string, Mock<() => void>>;
let requestToken = 0;
const approve = vi.fn();
const deny = vi.fn();
const abort = vi.fn();

function Pane({
  id,
  workspaceId = "ws",
  approval = false,
}: {
  id: string;
  workspaceId?: string;
  approval?: boolean;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const approvalRef = useRef<HTMLDivElement>(null);
  const xtermRef = useRef({
    focus: () => {
      focusCalls[id]();
      inputRef.current?.focus();
    },
    blur: () => inputRef.current?.blur(),
  } as Terminal);
  const focus = useTerminalFocus({
    paneId: id,
    workspaceId,
    containerRef,
    xtermRef,
    approvalRef,
    showApproval: approval,
  });
  useApprovalShortcuts({
    paneId: id,
    showApproval: approval,
    xtermRef,
    onApprove: approve,
    onDeny: deny,
    onAbort: abort,
    onRestoreFocus: focus,
  });
  return (
    <div data-terminal-pane={id}>
      <button data-testid={`menu-${id}`}>Menu</button>
      <div data-testid={`header-${id}`} onClick={(event) => focus(event.target)}>
        Header
      </div>
      {approval && (
        <div tabIndex={-1} ref={approvalRef} data-testid={`approval-${id}`}>
          Approval needed
        </div>
      )}
      <div ref={containerRef} className="xterm" data-testid={`host-${id}`}>
        <textarea ref={inputRef} data-testid={`input-${id}`} className="xterm-helper-textarea" />
      </div>
    </div>
  );
}

function Navigation({
  active = true,
  layout = tree,
}: {
  active?: boolean;
  layout?: MosaicNode<string>;
}) {
  useWorkspacePaneNavigation({ workspace, tree: layout, surfaceActive: active });
  return null;
}

function key(target: EventTarget, init: KeyboardEventInit = {}) {
  const event = new KeyboardEvent("keydown", {
    bubbles: true,
    cancelable: true,
    ctrlKey: true,
    altKey: true,
    key: "PageDown",
    ...init,
  });
  act(() => {
    target.dispatchEvent(event);
  });
  return event;
}

beforeEach(() => {
  vi.clearAllMocks();
  focusCalls = { a: vi.fn(), b: vi.fn() };
  requestToken = 0;
  useAppStore.setState({ activeView: "workspace", commandPaletteOpen: false });
  useLayoutStore.setState({ activePaneId: "a" });
  useWorkspaceStore.setState({
    activeWorkspaceId: "ws",
    zoomedPaneId: null,
    focusPaneRequest: null,
    setZoomedPane: (zoomedPaneId) => useWorkspaceStore.setState({ zoomedPaneId }),
    requestPaneFocus: vi.fn((workspaceId, paneId) => {
      useLayoutStore.setState({ activePaneId: paneId });
      useWorkspaceStore.setState({
        activeWorkspaceId: workspaceId,
        focusPaneRequest: { workspaceId, paneId, token: ++requestToken },
      });
    }),
  });
  vi.spyOn(HTMLElement.prototype, "getClientRects").mockImplementation(function (
    this: HTMLElement,
  ) {
    return (this.hidden ? [] : [{}]) as unknown as DOMRectList;
  });
});

afterEach(() => {
  cleanup();
  resetModalStack();
  resetApprovalRegistry();
  vi.restoreAllMocks();
});

describe("Workspace terminal focus", () => {
  it("selection and repeated focus requests reach the selected xterm input", () => {
    const view = render(
      <>
        <Pane id="a" />
        <Pane id="b" />
      </>,
    );
    expect(document.activeElement).toBe(view.getByTestId("input-a"));
    act(() => useLayoutStore.setState({ activePaneId: "b" }));
    expect(document.activeElement).toBe(view.getByTestId("input-b"));
    const count = focusCalls.b.mock.calls.length;
    act(() => useWorkspaceStore.getState().requestPaneFocus("ws", "b"));
    expect(focusCalls.b).toHaveBeenCalledTimes(count + 1);
  });

  it("refocuses a selected pane from its plain header without stealing a header control", () => {
    const view = render(<Pane id="a" />);
    (view.getByTestId("menu-a") as HTMLElement).focus();
    act(() => useWorkspaceStore.getState().requestPaneFocus("ws", "a"));
    expect(document.activeElement).toBe(view.getByTestId("menu-a"));
    fireEvent.click(view.getByTestId("header-a"));
    expect(document.activeElement).toBe(view.getByTestId("input-a"));
  });

  it.each(["editor", "modal", "palette"])("does not steal focus from %s", (guard) => {
    const view = render(
      <>
        <input data-testid="editor" />
        <Pane id="a" />
        <Pane id="b" />
      </>,
    );
    const editor = view.getByTestId("editor");
    if (guard === "editor") (editor as HTMLElement).focus();
    if (guard === "modal") registerModal("dialog", 1);
    if (guard === "palette") useAppStore.setState({ commandPaletteOpen: true });
    act(() => useWorkspaceStore.getState().requestPaneFocus("ws", "b"));
    expect(focusCalls.b).not.toHaveBeenCalled();
    if (guard === "editor") expect(document.activeElement).toBe(editor);
  });

  it.each(["route", "workspace", "hidden", "zoom"])(
    "does not focus a %s-hidden terminal",
    (guard) => {
      const view = render(
        <>
          <Pane id="a" />
          <Pane id="b" />
        </>,
      );
      if (guard === "route") act(() => useAppStore.setState({ activeView: "agents" }));
      if (guard === "workspace")
        act(() => useWorkspaceStore.setState({ activeWorkspaceId: "other" }));
      if (guard === "hidden") (view.getByTestId("host-b") as HTMLElement).hidden = true;
      if (guard === "zoom") (view.getByTestId("host-b") as HTMLElement).style.visibility = "hidden";
      act(() => useLayoutStore.setState({ activePaneId: "b" }));
      expect(focusCalls.b).not.toHaveBeenCalled();
    },
  );

  it("restores focus when the selected Workspace becomes visible again", () => {
    useAppStore.setState({ activeView: "agents" });
    const view = render(<Pane id="a" />);
    expect(focusCalls.a).not.toHaveBeenCalled();
    act(() => useAppStore.setState({ activeView: "workspace" }));
    expect(document.activeElement).toBe(view.getByTestId("input-a"));
  });

  it("does not refocus when a request's highlight expires", () => {
    const view = render(
      <>
        <button data-testid="toolbar">Toolbar</button>
        <Pane id="a" />
      </>,
    );
    act(() => useWorkspaceStore.getState().requestPaneFocus("ws", "a"));
    (view.getByTestId("toolbar") as HTMLElement).focus();
    act(() => useWorkspaceStore.setState({ focusPaneRequest: null }));
    expect(document.activeElement).toBe(view.getByTestId("toolbar"));
  });
});

describe("Workspace terminal navigation", () => {
  it("focuses the approval group so its advertised answer key reaches the handler", () => {
    useLayoutStore.setState({ activePaneId: "b" });
    const view = render(
      <>
        <Navigation />
        <Pane id="a" approval />
        <Pane id="b" />
      </>,
    );
    key(view.getByTestId("input-b"));
    expect(document.activeElement).toBe(view.getByTestId("approval-a"));
    expect(focusCalls.a).not.toHaveBeenCalled();
    fireEvent.keyDown(view.getByTestId("approval-a"), { key: "y" });
    expect(approve).toHaveBeenCalledTimes(1);
    key(view.getByTestId("approval-a"));
    expect(document.activeElement).toBe(view.getByTestId("input-b"));
  });

  it("does not steal focus when a background pane's approval is cleared", () => {
    useLayoutStore.setState({ activePaneId: "b" });
    const view = render(
      <>
        <Pane id="a" approval />
        <Pane id="b" />
      </>,
    );
    expect(document.activeElement).toBe(view.getByTestId("input-b"));
    view.rerender(
      <>
        <Pane id="a" />
        <Pane id="b" />
      </>,
    );
    expect(document.activeElement).toBe(view.getByTestId("input-b"));
    expect(focusCalls.a).not.toHaveBeenCalled();
  });

  it("cycles visual terminal order, wraps, skips file tiles, and consumes the chord before xterm", () => {
    const view = render(
      <>
        <Navigation />
        <Pane id="a" />
        <Pane id="b" />
      </>,
    );
    const terminalHandler = vi.fn();
    view.getByTestId("input-a").addEventListener("keydown", terminalHandler);
    expect(key(view.getByTestId("input-a")).defaultPrevented).toBe(true);
    expect(terminalHandler).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(view.getByTestId("input-b"));
    key(view.getByTestId("input-b"));
    expect(document.activeElement).toBe(view.getByTestId("input-a"));
    key(view.getByTestId("input-a"), { key: "PageUp" });
    expect(document.activeElement).toBe(view.getByTestId("input-b"));
  });

  it("moves the zoom to the newly selected terminal", () => {
    useWorkspaceStore.setState({ zoomedPaneId: "a" });
    render(<Navigation />);
    key(window);
    expect(useWorkspaceStore.getState().zoomedPaneId).toBe("b");
  });

  it("skips hidden tabs instead of selecting an input that cannot receive focus", () => {
    render(<Navigation layout={{ type: "tabs", tabs: ["a", "b"], activeTabIndex: 0 }} />);
    key(window);
    expect(useWorkspaceStore.getState().requestPaneFocus).toHaveBeenCalledWith("ws", "a");
  });

  it.each([
    "editor",
    "modal",
    "palette",
    "composition",
    "route",
    "workspace",
    "hidden",
    "ordinary",
  ])("yields keys to %s", (guard) => {
    const view = render(
      <>
        <Navigation active={guard !== "hidden"} />
        <input data-testid="editor" />
      </>,
    );
    if (guard === "modal") registerModal("dialog", 1);
    if (guard === "palette") useAppStore.setState({ commandPaletteOpen: true });
    if (guard === "route") useAppStore.setState({ activeView: "agents" });
    if (guard === "workspace") useWorkspaceStore.setState({ activeWorkspaceId: "other" });
    const event = key(guard === "editor" ? view.getByTestId("editor") : window, {
      ...(guard === "composition" ? { isComposing: true } : {}),
      ...(guard === "ordinary" ? { altKey: false } : {}),
    });
    expect(event.defaultPrevented).toBe(false);
    expect(useWorkspaceStore.getState().requestPaneFocus).not.toHaveBeenCalled();
  });
});
