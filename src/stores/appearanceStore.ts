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

function read(): AppearancePreferencesV1 {
  let raw: unknown = DEFAULT_APPEARANCE_PREFERENCES;
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved) raw = JSON.parse(saved);
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
