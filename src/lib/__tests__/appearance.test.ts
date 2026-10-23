import { describe, expect, it } from "vitest";
import {
  DEFAULT_APPEARANCE_PREFERENCES,
  nextAppScale,
  normalizeAppearancePreferences,
  prevAppScale,
  resolveAppearanceMetrics,
} from "@/lib/appearance";

describe("normalizeAppearancePreferences", () => {
  it("returns defaults for missing input", () => {
    expect(normalizeAppearancePreferences(undefined)).toEqual(DEFAULT_APPEARANCE_PREFERENCES);
  });

  it("clamps and coerces out-of-range values", () => {
    const out = normalizeAppearancePreferences({
      schemaVersion: 1,
      uiScalePercent: 123,
      transcriptFontSizePx: 99,
      density: "bogus",
      agentSidebarWidthPx: 9,
    });
    expect(out.uiScalePercent).toBe(100);
    expect(out.transcriptFontSizePx).toBe(22);
    expect(out.density).toBe("comfortable");
    expect(out.agentSidebarWidthPx).toBe(240);
  });

  it("rejects non-numeric fields to defaults", () => {
    const out = normalizeAppearancePreferences({
      transcriptFontSizePx: NaN,
      agentSidebarWidthPx: "x",
    });
    expect(out.transcriptFontSizePx).toBe(15);
    expect(out.agentSidebarWidthPx).toBe(300);
  });
});

describe("resolveAppearanceMetrics", () => {
  it("matches the default fixture", () => {
    const m = resolveAppearanceMetrics(DEFAULT_APPEARANCE_PREFERENCES);
    expect(m["--text-ui"]).toBe("13px");
    expect(m["--text-body"]).toBe("15px");
    expect(m["--text-code"]).toBe("13px");
    expect(m["--leading-body"]).toBe("24px");
  });

  it("scales each domain exactly once at 125% and 200%", () => {
    const at125 = resolveAppearanceMetrics({
      ...DEFAULT_APPEARANCE_PREFERENCES,
      uiScalePercent: 125,
    });
    expect(at125["--text-ui"]).toBe("16.25px");
    expect(at125["--text-body"]).toBe("18.75px");
    expect(at125["--text-code"]).toBe("16.25px");

    const at200 = resolveAppearanceMetrics({
      ...DEFAULT_APPEARANCE_PREFERENCES,
      uiScalePercent: 200,
    });
    expect(at200["--text-ui"]).toBe("26px");
    expect(at200["--text-body"]).toBe("30px");
    expect(at200["--text-code"]).toBe("26px");
  });

  it("produces 44px transcript and 40px code at base 22 + 200%", () => {
    const m = resolveAppearanceMetrics({
      ...DEFAULT_APPEARANCE_PREFERENCES,
      transcriptFontSizePx: 22,
      uiScalePercent: 200,
    });
    expect(m["--text-body"]).toBe("44px");
    expect(m["--text-code"]).toBe("40px");
  });

  it("uses the compact UI base", () => {
    const m = resolveAppearanceMetrics({
      ...DEFAULT_APPEARANCE_PREFERENCES,
      density: "compact",
      uiScalePercent: 200,
    });
    expect(m["--text-ui"]).toBe("24px");
    expect(m["--text-body"]).toBe("30px");
  });
});

describe("scale steps", () => {
  it("steps up and down and clamps at bounds", () => {
    expect(nextAppScale(100)).toBe(110);
    expect(prevAppScale(200)).toBe(175);
    expect(nextAppScale(200)).toBe(200);
    expect(prevAppScale(100)).toBe(100);
  });
});
