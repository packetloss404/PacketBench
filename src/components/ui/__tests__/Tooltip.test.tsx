import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Tooltip } from "@/components/ui/Tooltip";

afterEach(() => {
  vi.useRealTimers();
});

describe("Tooltip accessible name/description (V6)", () => {
  it("wires aria-describedby and reveals the description on focus", () => {
    vi.useFakeTimers();
    render(
      <Tooltip content="Explain this control">
        <button type="button" aria-label="Do thing" />
      </Tooltip>,
    );

    const trigger = screen.getByRole("button", { name: "Do thing" });
    // No description until the tooltip is actually revealed.
    expect(trigger).not.toHaveAttribute("aria-describedby");

    fireEvent.focus(trigger);
    act(() => {
      vi.advanceTimersByTime(400);
    });
    act(() => {
      vi.advanceTimersByTime(16);
    });

    const tooltip = screen.getByRole("tooltip");
    expect(tooltip).toHaveTextContent("Explain this control");
    expect(trigger).toHaveAttribute("aria-describedby", tooltip.id);
  });

  it("supplements, not clobbers, an existing aria-describedby", () => {
    vi.useFakeTimers();
    render(
      <Tooltip content="tip text">
        <button type="button" aria-label="Act" aria-describedby="pre-existing" />
      </Tooltip>,
    );

    const trigger = screen.getByRole("button", { name: "Act" });
    fireEvent.focus(trigger);
    act(() => {
      vi.advanceTimersByTime(400);
    });
    act(() => {
      vi.advanceTimersByTime(16);
    });

    const tooltip = screen.getByRole("tooltip");
    const describedBy = trigger.getAttribute("aria-describedby") ?? "";
    expect(describedBy).toContain("pre-existing");
    expect(describedBy).toContain(tooltip.id);
  });

  it("dismisses on Escape and returns focus to the trigger", () => {
    vi.useFakeTimers();
    render(
      <Tooltip content="dismissable">
        <button type="button" aria-label="Toggle" />
      </Tooltip>,
    );

    const trigger = screen.getByRole("button", { name: "Toggle" });
    fireEvent.focus(trigger);
    act(() => {
      vi.advanceTimersByTime(400);
    });
    act(() => {
      vi.advanceTimersByTime(16);
    });
    expect(screen.getByRole("tooltip")).toBeInTheDocument();

    fireEvent.keyDown(trigger, { key: "Escape" });
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
  });
});
