import { useRef } from "react";
import { cleanup, render, fireEvent } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useApprovalShortcuts } from "@/hooks/useApprovalShortcuts";
import { useLayoutStore } from "@/stores/layoutStore";
import { useWorkspaceStore } from "@/stores/workspaceStore";
import { useAppStore } from "@/stores/appStore";
import { registerModal, resetModalStack } from "@/lib/modalStack";

const approve = vi.fn(),
  deny = vi.fn(),
  abort = vi.fn();
function Pane({ paneId = "pane-a", workspaceId = "ws" }) {
  const xtermRef = useRef(null);
  const containerRef = useRef<HTMLDivElement>(null);
  useApprovalShortcuts({
    showApproval: true,
    paneId,
    workspaceId,
    containerRef,
    xtermRef,
    onApprove: approve,
    onDeny: deny,
    onAbort: abort,
  });
  return (
    <div ref={containerRef} data-testid={paneId} tabIndex={-1}>
      Approval
    </div>
  );
}
beforeEach(() => {
  vi.clearAllMocks();
  useLayoutStore.setState({ activePaneId: "pane-a" });
  useWorkspaceStore.setState({ activeWorkspaceId: "ws" });
  useAppStore.setState({ activeView: "workspace", commandPaletteOpen: false });
  vi.spyOn(HTMLElement.prototype, "getClientRects").mockImplementation(function (
    this: HTMLElement,
  ) {
    return (this.hidden ? [] : [{}]) as unknown as DOMRectList;
  });
});
afterEach(() => {
  cleanup();
  resetModalStack();
  vi.restoreAllMocks();
});

function press(target: EventTarget = window, options: KeyboardEventInit = {}) {
  const event = new KeyboardEvent("keydown", {
    key: "y",
    bubbles: true,
    cancelable: true,
    ...options,
  });
  target.dispatchEvent(event);
  return event;
}
describe("terminal approval key ownership", () => {
  it("routes plain y/n/Escape to the selected visible approval", () => {
    const view = render(<Pane />);
    const overlay = view.getByTestId("pane-a");
    expect(press(overlay).defaultPrevented).toBe(true);
    press(overlay, { key: "n" });
    press(overlay, { key: "Escape" });
    expect(approve).toHaveBeenCalledOnce();
    expect(deny).toHaveBeenCalledOnce();
    expect(abort).toHaveBeenCalledOnce();
  });
  it("does not grant the only awaiting pane ownership when another pane is selected", () => {
    render(<Pane />);
    useLayoutStore.setState({ activePaneId: "other" });
    expect(press().defaultPrevented).toBe(false);
    expect(approve).not.toHaveBeenCalled();
  });
  it("dispatches only once with two awaiting panes", () => {
    render(
      <>
        <Pane />
        <Pane paneId="pane-b" />
      </>,
    );
    press();
    expect(approve).toHaveBeenCalledOnce();
  });
  it.each(["view", "workspace", "hidden", "modal", "palette"])(
    "yields when %s hides or supersedes the prompt",
    (scope) => {
      const view = render(<Pane />);
      if (scope === "view") useAppStore.setState({ activeView: "tools" });
      if (scope === "workspace") useWorkspaceStore.setState({ activeWorkspaceId: "other" });
      if (scope === "hidden") view.getByTestId("pane-a").hidden = true;
      if (scope === "modal") registerModal("dialog", 1);
      if (scope === "palette") useAppStore.setState({ commandPaletteOpen: true });
      for (const key of ["y", "n", "Escape"])
        expect(press(window, { key }).defaultPrevented).toBe(false);
      expect(approve).not.toHaveBeenCalled();
      expect(deny).not.toHaveBeenCalled();
      expect(abort).not.toHaveBeenCalled();
    },
  );
  it.each(["ctrlKey", "altKey", "metaKey", "shiftKey", "isComposing"])(
    "yields %s key sequences",
    (modifier) => {
      render(<Pane />);
      expect(press(window, { [modifier]: true }).defaultPrevented).toBe(false);
      expect(approve).not.toHaveBeenCalled();
    },
  );
  it("yields editable controls, including nested contenteditable children", () => {
    const view = render(
      <>
        <Pane />
        <input />
        <textarea />
        <select />
        <div contentEditable>
          <span>Editor</span>
        </div>
      </>,
    );
    for (const target of view.container.querySelectorAll("input,textarea,select,span"))
      fireEvent.keyDown(target, { key: "y" });
    expect(approve).not.toHaveBeenCalled();
  });
  it("does not approve from an unrelated workspace button", () => {
    const view = render(
      <>
        <Pane />
        <button>Git action</button>
      </>,
    );
    expect(press(view.getByRole("button")).defaultPrevented).toBe(false);
    expect(approve).not.toHaveBeenCalled();
  });
  it("respects previously handled keys and removes its listener on unmount", () => {
    const view = render(<Pane />);
    const event = new KeyboardEvent("keydown", { key: "y", cancelable: true });
    event.preventDefault();
    window.dispatchEvent(event);
    view.unmount();
    press();
    expect(approve).not.toHaveBeenCalled();
  });
});
