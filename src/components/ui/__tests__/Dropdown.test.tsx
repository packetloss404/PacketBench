import { Fragment } from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Dropdown, DropdownItem } from "../Dropdown";
import { Modal } from "../Modal";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function ProviderGroups() {
  return (
    <Dropdown trigger={<span>Choose provider</span>} searchable>
      <div>
        <div>Anthropic group</div>
        <DropdownItem>Claude</DropdownItem>
      </div>
      <Fragment>
        <section>
          <h3>Named group</h3>
          <div>
            <DropdownItem>Sugar</DropdownItem>
          </div>
        </section>
      </Fragment>
    </Dropdown>
  );
}

describe("Dropdown visibility and search", () => {
  it("counts nested matches and removes empty groups without a false no-matches state", () => {
    render(<ProviderGroups />);
    fireEvent.click(screen.getByRole("button", { name: "Choose provider" }));
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "sUgAr" } });
    expect(screen.getByRole("button", { name: "Sugar" })).toBeVisible();
    expect(screen.getByText("Named group")).toBeVisible();
    expect(screen.queryByText("Anthropic group")).not.toBeInTheDocument();
    expect(screen.queryByText("No matches")).not.toBeInTheDocument();
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "unknown provider" } });
    expect(screen.getByText("No matches")).toBeVisible();
    expect(screen.queryByText("Named group")).not.toBeInTheDocument();
  });

  it("refreshes after a full trigger click without changing geometry during mousedown", () => {
    const onOpen = vi.fn();
    const select = vi.fn();
    render(
      <Dropdown trigger={<span>Provider label</span>} onOpen={onOpen}>
        <DropdownItem onClick={select}>Sugar</DropdownItem>
      </Dropdown>,
    );
    fireEvent.mouseDown(screen.getByText("Provider label"));
    expect(onOpen).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText("Provider label"));
    expect(onOpen).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole("button", { name: "Sugar" }));
    expect(select).toHaveBeenCalledOnce();
    expect(screen.getByRole("button", { name: "Provider label" })).toHaveFocus();
    expect(screen.queryByRole("group", { name: "Dropdown options" })).not.toBeInTheDocument();
  });

  it("flips upward and clamps horizontally near the bottom-right viewport edge", () => {
    vi.stubGlobal("innerWidth", 1024);
    vi.stubGlobal("innerHeight", 600);
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (
      this: HTMLElement,
    ) {
      return (
        this.hasAttribute("data-dropdown-menu")
          ? { width: 260, height: 320, left: 0, right: 260, top: 0, bottom: 320 }
          : { width: 130, height: 22, left: 890, right: 1020, top: 550, bottom: 572 }
      ) as DOMRect;
    });
    render(<ProviderGroups />);
    fireEvent.click(screen.getByRole("button", { name: "Choose provider" }));
    const menu = screen.getByRole("group", { name: "Dropdown options" });
    expect(menu).toHaveStyle({
      position: "fixed",
      top: "226px",
      left: "756px",
      maxHeight: "400px",
      overflowY: "auto",
    });
    fireEvent(window, new Event("resize"));
    expect(menu).toHaveStyle({ top: "226px", left: "756px" });
  });

  it("keeps Escape and focus inside the modal until the dropdown has closed", async () => {
    const closeModal = vi.fn();
    render(
      <Modal title="Flight brief" onClose={closeModal}>
        <ProviderGroups />
      </Modal>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Choose provider" }));
    const search = screen.getByRole("textbox");
    await waitFor(() => expect(search).toHaveFocus());
    fireEvent.change(search, { target: { value: "Sugar" } });
    fireEvent.keyDown(search, { key: "Escape" });
    expect(search).toHaveValue("");
    expect(closeModal).not.toHaveBeenCalled();
    fireEvent.keyDown(search, { key: "Escape" });
    expect(screen.queryByRole("group", { name: "Dropdown options" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Choose provider" })).toHaveFocus();
    expect(closeModal).not.toHaveBeenCalled();
  });
});
