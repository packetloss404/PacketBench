import { useEffect } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { TileChrome } from "../TileChrome";

const connectDragSource = vi.hoisted(() => vi.fn((element) => element));
vi.mock("react-mosaic-component", async () => {
  const { createContext } = await import("react");
  return { MosaicWindowContext: createContext({ mosaicWindowActions: { connectDragSource } }) };
});

beforeEach(() => vi.clearAllMocks());

describe("shared tile controls", () => {
  it("provides named zoom controls and exposes the current zoom state", () => {
    const toggle = vi.fn();
    const view = render(
      <TileChrome title="Local terminal" isZoomed={false} onToggleZoom={toggle} />,
    );
    const zoom = screen.getByRole("button", { name: "Zoom to focus: Local terminal" });
    expect(zoom).toHaveAttribute("aria-pressed", "false");
    fireEvent.click(zoom);
    expect(toggle).toHaveBeenCalledOnce();
    view.rerender(<TileChrome title="Local terminal" isZoomed onToggleZoom={toggle} />);
    expect(screen.getByRole("button", { name: "Exit zoom: Local terminal" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });

  it("double-clicks zoom only on passive header content, never controls", () => {
    const toggle = vi.fn();
    render(
      <TileChrome title="Terminal" isZoomed={false} onToggleZoom={toggle}>
        <button>More</button>
        <input aria-label="Pinned command" />
        <div>Menu description</div>
      </TileChrome>,
    );
    fireEvent.doubleClick(screen.getByRole("button", { name: "More" }));
    fireEvent.doubleClick(screen.getByRole("textbox", { name: "Pinned command" }));
    fireEvent.doubleClick(screen.getByText("Menu description"));
    fireEvent.doubleClick(screen.getByRole("button", { name: "Zoom to focus: Terminal" }));
    expect(toggle).not.toHaveBeenCalled();
    fireEvent.doubleClick(screen.getByText("Terminal"));
    expect(toggle).toHaveBeenCalledOnce();
  });

  it("keeps the shortcut hint on the header grip and connects only that row for dragging", () => {
    render(
      <>
        <TileChrome
          title="Terminal"
          isZoomed={false}
          onToggleZoom={vi.fn()}
          shortcutHint="Ctrl+Alt+PageDown"
        />
        <button>Retry send</button>
      </>,
    );
    expect(screen.getByTitle(/Ctrl\+Alt\+PageDown/)).toContainHTML("svg");
    const row = connectDragSource.mock.lastCall?.[0];
    expect(row.props.role).toBe("group");
    expect(row.props.title).toBeUndefined();
    expect(screen.getByRole("button", { name: "Retry send" }).closest('[role="group"]')).toBeNull();
  });

  it("keeps close semantics with the caller and prevents drag/zoom from consuming close", () => {
    const close = vi.fn();
    const toggle = vi.fn();
    const mouseDown = vi.fn();
    render(
      <div onMouseDown={mouseDown}>
        <TileChrome
          title="README"
          isZoomed={false}
          onToggleZoom={toggle}
          close={{ label: "Close README", tooltip: "Close viewer", onClick: close }}
        />
      </div>,
    );
    const button = screen.getByRole("button", { name: "Close README" });
    fireEvent.mouseDown(button);
    fireEvent.click(button);
    expect(mouseDown).not.toHaveBeenCalled();
    expect(toggle).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledOnce();
  });

  it("does not remount a sibling body when header identity/status/zoom changes", () => {
    const mount = vi.fn();
    const unmount = vi.fn();
    function Body() {
      useEffect(() => {
        mount();
        return unmount;
      }, []);
      return <textarea defaultValue="unsent input" />;
    }
    function Pane({ zoomed }: { zoomed: boolean }) {
      return (
        <>
          <TileChrome
            title={zoomed ? "SSH terminal" : "Local terminal"}
            isZoomed={zoomed}
            onToggleZoom={vi.fn()}
            status={{ label: zoomed ? "running" : "idle", className: "text-text-muted" }}
          />
          <Body />
        </>
      );
    }
    const view = render(<Pane zoomed={false} />);
    const body = screen.getByRole("textbox");
    fireEvent.change(body, { target: { value: "keep this input" } });
    view.rerender(<Pane zoomed />);
    expect(screen.getByRole("textbox")).toBe(body);
    expect(body).toHaveValue("keep this input");
    expect(mount).toHaveBeenCalledOnce();
    expect(unmount).not.toHaveBeenCalled();
  });
});
