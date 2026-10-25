import { create } from "zustand";
import { storageKey } from "@/lib/brand";
import {
  DEFAULT_APPEARANCE_PREFERENCES,
  nextAppScale,
  normalizeAppearancePreferences,
  prevAppScale,
  type AppearancePreferencesV1,
  type AppScalePercent,
  type InterfaceDensity,
} from "@/lib/appearance";

const STORAGE_KEY = storageKey("appearance");
const LEGACY_SIDEBAR_PREFS_KEY = storageKey("agent-sidebar-prefs");

/**
 * V3/V7: the rendered sidebar width used to live in
 * `packetbench:agent-sidebar-prefs.width` while the Appearance reset touched a
 * different field. Read that legacy value once so an existing user's sidebar
 * keeps its size when this store becomes the single width owner.
 */
function readLegacySidebarWidth(): number | undefined {
  try {
    const raw = localStorage.getItem(LEGACY_SIDEBAR_PREFS_KEY);
    if (!raw) return undefined;
    const parsed = JSON.parse(raw) as { prefs?: unknown; width?: unknown };
    if (typeof parsed?.width !== "number" || !Number.isFinite(parsed.width)) {
      return undefined;
    }
    // Consume the legacy width so a later boot can never re-adopt a stale value
    // over a width the user has since chosen in Appearance.
    try {
      localStorage.setItem(
        LEGACY_SIDEBAR_PREFS_KEY,
        JSON.stringify({ prefs: parsed.prefs ?? {} }),
      );
    } catch {
      /* best effort — the adopt-once guard below still holds for this boot */
    }
    return parsed.width;
  } catch {
    return undefined;
  }
}

function read(): AppearancePreferencesV1 {
  let raw: unknown = DEFAULT_APPEARANCE_PREFERENCES;
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    const legacyWidth = readLegacySidebarWidth();
    if (saved) {
      const savedPrefs = JSON.parse(saved) as Partial<AppearancePreferencesV1>;
      raw = savedPrefs;
      // Adopt the legacy width only while the saved appearance width is still
      // the untouched default (or absent) — nothing could set it before this
      // build, so a non-default value is a deliberate choice that must win.
      if (
        legacyWidth !== undefined &&
        (savedPrefs.agentSidebarWidthPx === undefined ||
          savedPrefs.agentSidebarWidthPx === DEFAULT_APPEARANCE_PREFERENCES.agentSidebarWidthPx)
      ) {
        raw = { ...savedPrefs, agentSidebarWidthPx: legacyWidth };
      }
    } else if (legacyWidth !== undefined) {
      raw = { ...DEFAULT_APPEARANCE_PREFERENCES, agentSidebarWidthPx: legacyWidth };
    }
  } catch {
    /* fall through to defaults */
  }
  return normalizeAppearancePreferences(raw);
}

function persist(prefs: AppearancePreferencesV1): boolean {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs));
    return true;
  } catch {
    return false;
  }
}

interface AppearanceStore {
  preferences: AppearancePreferencesV1;
  saveFailed: boolean;
  setUiScalePercent: (value: AppScalePercent) => void;
  setTranscriptFontSizePx: (value: number) => void;
  setDensity: (value: InterfaceDensity) => void;
  setAgentSidebarWidthPx: (value: number) => void;
  increaseAppScale: () => void;
  decreaseAppScale: () => void;
  resetAppScale: () => void;
  resetTextAndLayout: () => void;
}

export const useAppearanceStore = create<AppearanceStore>((set, get) => {
  const commit = (patch: Partial<AppearancePreferencesV1>) => {
    const next = normalizeAppearancePreferences({ ...get().preferences, ...patch });
    set({ preferences: next, saveFailed: !persist(next) });
  };

  return {
    preferences: read(),
    saveFailed: false,

    setUiScalePercent: (value) => commit({ uiScalePercent: value }),
    setTranscriptFontSizePx: (value) => commit({ transcriptFontSizePx: value }),
    setDensity: (value) => commit({ density: value }),
    setAgentSidebarWidthPx: (value) => commit({ agentSidebarWidthPx: value }),

    increaseAppScale: () =>
      commit({ uiScalePercent: nextAppScale(get().preferences.uiScalePercent) }),
    decreaseAppScale: () =>
      commit({ uiScalePercent: prevAppScale(get().preferences.uiScalePercent) }),
    resetAppScale: () => commit({ uiScalePercent: 100 }),

    resetTextAndLayout: () => {
      const ok = persist(DEFAULT_APPEARANCE_PREFERENCES);
      set({ preferences: DEFAULT_APPEARANCE_PREFERENCES, saveFailed: !ok });
    },
  };
});
