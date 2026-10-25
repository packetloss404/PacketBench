import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_APPEARANCE_PREFERENCES } from "@/lib/appearance";
import { useAppearanceStore } from "@/stores/appearanceStore";

const KEY = "packetbench:appearance";

describe("appearanceStore", () => {
  beforeEach(() => {
    localStorage.clear();
    useAppearanceStore.setState({ preferences: DEFAULT_APPEARANCE_PREFERENCES, saveFailed: false });
  });

  it("defaults to comfortable preferences", () => {
    expect(useAppearanceStore.getState().preferences).toEqual(DEFAULT_APPEARANCE_PREFERENCES);
  });

  it("persists under the branded appearance key", () => {
    useAppearanceStore.getState().setUiScalePercent(150);
    const saved = JSON.parse(localStorage.getItem(KEY) ?? "{}");
    expect(saved.uiScalePercent).toBe(150);
    expect(saved.schemaVersion).toBe(1);
  });

  it("clamps setters through the normalizer", () => {
    useAppearanceStore.getState().setTranscriptFontSizePx(99);
    expect(useAppearanceStore.getState().preferences.transcriptFontSizePx).toBe(22);
    useAppearanceStore.getState().setAgentSidebarWidthPx(1);
    expect(useAppearanceStore.getState().preferences.agentSidebarWidthPx).toBe(240);
  });

  it("resetAppScale keeps the reading base and sidebar width", () => {
    useAppearanceStore.getState().setTranscriptFontSizePx(18);
    useAppearanceStore.getState().setAgentSidebarWidthPx(400);
    useAppearanceStore.getState().setUiScalePercent(200);

    useAppearanceStore.getState().resetAppScale();

    const prefs = useAppearanceStore.getState().preferences;
    expect(prefs.uiScalePercent).toBe(100);
    expect(prefs.transcriptFontSizePx).toBe(18);
    expect(prefs.agentSidebarWidthPx).toBe(400);
  });

  it("resetTextAndLayout restores all four defaults", () => {
    useAppearanceStore.getState().setUiScalePercent(175);
    useAppearanceStore.getState().setTranscriptFontSizePx(20);
    useAppearanceStore.getState().setDensity("compact");
    useAppearanceStore.getState().setAgentSidebarWidthPx(460);

    useAppearanceStore.getState().resetTextAndLayout();

    expect(useAppearanceStore.getState().preferences).toEqual(DEFAULT_APPEARANCE_PREFERENCES);
  });

  it("adopts the legacy sidebar width once when no appearance prefs exist yet", async () => {
    localStorage.setItem(
      "packetbench:agent-sidebar-prefs",
      JSON.stringify({ prefs: {}, width: 420 }),
    );
    vi.resetModules();
    const { useAppearanceStore: fresh } = await import("@/stores/appearanceStore");
    expect(fresh.getState().preferences.agentSidebarWidthPx).toBe(420);
  });

  it("never lets the legacy width override saved appearance preferences", async () => {
    localStorage.setItem(
      "packetbench:agent-sidebar-prefs",
      JSON.stringify({ prefs: {}, width: 420 }),
    );
    localStorage.setItem(
      KEY,
      JSON.stringify({ ...DEFAULT_APPEARANCE_PREFERENCES, agentSidebarWidthPx: 260 }),
    );
    vi.resetModules();
    const { useAppearanceStore: fresh } = await import("@/stores/appearanceStore");
    expect(fresh.getState().preferences.agentSidebarWidthPx).toBe(260);
  });

  it("adopts the legacy width while saved appearance prefs still use the default", async () => {
    localStorage.setItem(
      "packetbench:agent-sidebar-prefs",
      JSON.stringify({ prefs: {}, width: 420 }),
    );
    // Appearance prefs exist but the width is untouched (nothing could set it
    // before this build), so the legacy custom width must win.
    localStorage.setItem(KEY, JSON.stringify(DEFAULT_APPEARANCE_PREFERENCES));
    vi.resetModules();
    const { useAppearanceStore: fresh } = await import("@/stores/appearanceStore");
    expect(fresh.getState().preferences.agentSidebarWidthPx).toBe(420);
  });

  it("consumes the legacy width so it cannot be re-adopted later", async () => {
    localStorage.setItem(
      "packetbench:agent-sidebar-prefs",
      JSON.stringify({ prefs: { "conv-1": { pinned: true } }, width: 420 }),
    );
    vi.resetModules();
    await import("@/stores/appearanceStore");
    const legacy = JSON.parse(localStorage.getItem("packetbench:agent-sidebar-prefs") ?? "{}");
    expect(legacy.width).toBeUndefined();
    expect(legacy.prefs).toEqual({ "conv-1": { pinned: true } });
  });
});
