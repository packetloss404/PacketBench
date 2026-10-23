import { act, render } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_APPEARANCE_PREFERENCES } from "@/lib/appearance";
import { useAppearanceStore } from "@/stores/appearanceStore";
import { useApplyAppearance, useApplyAppearanceProjection } from "@/hooks/useApplyAppearance";

function Harness() {
  useApplyAppearance();
  return null;
}

function ProjectionHarness() {
  useApplyAppearanceProjection();
  return null;
}

describe("useApplyAppearance", () => {
  beforeEach(() => {
    localStorage.clear();
    useAppearanceStore.setState({ preferences: DEFAULT_APPEARANCE_PREFERENCES, saveFailed: false });
    document.documentElement.removeAttribute("data-ui-density");
    document.documentElement.removeAttribute("data-ui-scale");
  });

  it("writes resolved metric custom properties to the documentElement", () => {
    render(<Harness />);
    const style = document.documentElement.style;
    expect(style.getPropertyValue("--text-ui")).toBe("13px");
    expect(style.getPropertyValue("--text-body")).toBe("15px");
    expect(document.documentElement.getAttribute("data-ui-density")).toBe("comfortable");
    expect(document.documentElement.getAttribute("data-ui-scale")).toBe("100");
  });

  it("updates properties when the store changes", () => {
    render(<Harness />);
    act(() => {
      useAppearanceStore.getState().setUiScalePercent(200);
    });
    expect(document.documentElement.style.getPropertyValue("--text-ui")).toBe("26px");
    expect(document.documentElement.style.getPropertyValue("--text-body")).toBe("30px");
    expect(document.documentElement.getAttribute("data-ui-scale")).toBe("200");
  });

  it("binds Ctrl+= to increase App scale and preventDefault", () => {
    render(<Harness />);
    const event = new KeyboardEvent("keydown", { key: "=", ctrlKey: true, cancelable: true });
    act(() => {
      window.dispatchEvent(event);
    });
    expect(event.defaultPrevented).toBe(true);
    expect(useAppearanceStore.getState().preferences.uiScalePercent).toBe(110);
  });

  it("projection applies metrics but installs no scale shortcut", () => {
    render(<ProjectionHarness />);
    expect(document.documentElement.style.getPropertyValue("--text-ui")).toBe("13px");
    const event = new KeyboardEvent("keydown", { key: "=", ctrlKey: true, cancelable: true });
    act(() => {
      window.dispatchEvent(event);
    });
    expect(event.defaultPrevented).toBe(false);
    expect(useAppearanceStore.getState().preferences.uiScalePercent).toBe(100);
  });

  it("projection follows storage changes without persisting them back", () => {
    render(<ProjectionHarness />);
    act(() => {
      window.dispatchEvent(
        new StorageEvent("storage", {
          key: "packetbench:appearance",
          newValue: JSON.stringify({ ...DEFAULT_APPEARANCE_PREFERENCES, uiScalePercent: 175 }),
        }),
      );
    });
    expect(useAppearanceStore.getState().preferences.uiScalePercent).toBe(175);
  });
});
