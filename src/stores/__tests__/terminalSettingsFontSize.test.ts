import { beforeEach, describe, expect, it } from "vitest";
import { useTerminalSettingsStore } from "@/stores/terminalSettingsStore";

const KEY = "packetbench:terminal-font-size";

describe("terminalSettingsStore — font size", () => {
  beforeEach(() => {
    localStorage.clear();
    useTerminalSettingsStore.setState({ terminalFontSizePx: 13 });
  });

  it("defaults to 13px", () => {
    expect(useTerminalSettingsStore.getState().terminalFontSizePx).toBe(13);
  });

  it("clamps to the 10..32 range", () => {
    useTerminalSettingsStore.getState().setTerminalFontSizePx(99);
    expect(useTerminalSettingsStore.getState().terminalFontSizePx).toBe(32);
    useTerminalSettingsStore.getState().setTerminalFontSizePx(1);
    expect(useTerminalSettingsStore.getState().terminalFontSizePx).toBe(10);
  });

  it("persists a validated JSON number under its own key", () => {
    useTerminalSettingsStore.getState().setTerminalFontSizePx(18);
    expect(JSON.parse(localStorage.getItem(KEY) ?? "null")).toBe(18);
  });

  it("resets to 13px", () => {
    useTerminalSettingsStore.getState().setTerminalFontSizePx(26);
    useTerminalSettingsStore.getState().resetTerminalFontSizePx();
    expect(useTerminalSettingsStore.getState().terminalFontSizePx).toBe(13);
  });
});
