export type AppScalePercent = 100 | 110 | 125 | 150 | 175 | 200;
export type InterfaceDensity = "comfortable" | "compact";

export interface AppearancePreferencesV1 {
  schemaVersion: 1;
  uiScalePercent: AppScalePercent;
  transcriptFontSizePx: number;
  density: InterfaceDensity;
  agentSidebarWidthPx: number;
}

export const DEFAULT_APPEARANCE_PREFERENCES: AppearancePreferencesV1 = {
  schemaVersion: 1,
  uiScalePercent: 100,
  transcriptFontSizePx: 15,
  density: "comfortable",
  agentSidebarWidthPx: 300,
};

export const APP_SCALE_STEPS: readonly AppScalePercent[] = [100, 110, 125, 150, 175, 200];

const SCALE_SET = new Set<number>(APP_SCALE_STEPS);

function clamp(value: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, value));
}

function roundCss(value: number): string {
  return `${Math.round(value * 100) / 100}px`;
}

/** Normalize any persisted/envelope value into a valid preference set. */
export function normalizeAppearancePreferences(raw: unknown): AppearancePreferencesV1 {
  const r = (raw ?? {}) as Partial<AppearancePreferencesV1>;
  const scale = SCALE_SET.has(Number(r.uiScalePercent))
    ? (Number(r.uiScalePercent) as AppScalePercent)
    : 100;
  const transcriptFontSizePx = Number.isFinite(r.transcriptFontSizePx)
    ? clamp(Math.round(Number(r.transcriptFontSizePx)), 13, 22)
    : 15;
  const density: InterfaceDensity = r.density === "compact" ? "compact" : "comfortable";
  const agentSidebarWidthPx = Number.isFinite(r.agentSidebarWidthPx)
    ? clamp(Math.round(Number(r.agentSidebarWidthPx)), 240, 480)
    : 300;
  return {
    schemaVersion: 1,
    uiScalePercent: scale,
    transcriptFontSizePx,
    density,
    agentSidebarWidthPx,
  };
}

/**
 * Emit final absolute CSS pixel values, each base multiplied by S exactly once.
 * Returned keys are CSS custom properties the one root hook applies; consumers
 * (Tailwind utilities) already reference `var(--text-*)`.
 */
export function resolveAppearanceMetrics(prefs: AppearancePreferencesV1): Record<string, string> {
  const S = prefs.uiScalePercent / 100;
  const B = prefs.transcriptFontSizePx;
  const C = Math.max(13, B - 2);
  const compact = prefs.density === "compact";
  const ui = compact ? 12 : 13;
  const leadingUi = compact ? 18 : 20;

  return {
    "--text-ui": roundCss(ui * S),
    "--leading-ui": roundCss(leadingUi * S),
    "--text-meta": roundCss(12 * S),
    "--leading-meta": roundCss(16 * S),
    "--text-body": roundCss(B * S),
    "--leading-body": roundCss(1.6 * B * S),
    "--text-composer": roundCss(B * S),
    "--leading-composer": roundCss((22 / 15) * B * S),
    "--text-code": roundCss(C * S),
    "--leading-code": roundCss((20 / 13) * C * S),
    "--text-chip": roundCss(12 * S),
    "--leading-chip": roundCss(18 * S),
    "--text-heading-1": roundCss(18 * S),
    "--leading-heading-1": roundCss(26 * S),
    "--text-heading-2": roundCss(16 * S),
    "--leading-heading-2": roundCss(24 * S),
    "--text-heading-3": roundCss(15 * S),
    "--leading-heading-3": roundCss(22 * S),
  };
}

export function nextAppScale(current: AppScalePercent): AppScalePercent {
  const idx = APP_SCALE_STEPS.indexOf(current);
  return APP_SCALE_STEPS[Math.min(APP_SCALE_STEPS.length - 1, idx + 1)];
}

export function prevAppScale(current: AppScalePercent): AppScalePercent {
  const idx = APP_SCALE_STEPS.indexOf(current);
  return APP_SCALE_STEPS[Math.max(0, idx - 1)];
}
