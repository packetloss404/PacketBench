import { useEffect } from "react";
import { normalizeAppearancePreferences, resolveAppearanceMetrics } from "@/lib/appearance";
import { storageKey } from "@/lib/brand";
import { isMac } from "@/lib/platform";
import { useAppearanceStore } from "@/stores/appearanceStore";

const APPEARANCE_KEY = storageKey("appearance");

function applyMetrics(preferences: ReturnType<typeof normalizeAppearancePreferences>): void {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  const metrics = resolveAppearanceMetrics(preferences);
  for (const [property, value] of Object.entries(metrics)) {
    root.style.setProperty(property, value);
  }
  root.setAttribute("data-ui-density", preferences.density);
  root.setAttribute("data-ui-scale", String(preferences.uiScalePercent));
}

/**
 * The ONE root appearance writer: applies the resolved metric CSS custom
 * properties + density/scale attributes to `document.documentElement`, and
 * installs the App-scale keyboard shortcuts. Mount once in App.
 */
export function useApplyAppearance(): void {
  const preferences = useAppearanceStore((s) => s.preferences);

  useEffect(() => {
    applyMetrics(preferences);
  }, [preferences]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const handler = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing || event.altKey) return;
      const modifier = isMac() ? event.metaKey : event.ctrlKey;
      if (!modifier) return;
      const target = event.target as HTMLElement | null;
      if (target?.closest?.(".xterm")) return;

      const store = useAppearanceStore.getState();
      if (event.key === "+" || event.key === "=") {
        event.preventDefault();
        store.increaseAppScale();
      } else if (event.key === "-") {
        event.preventDefault();
        store.decreaseAppScale();
      } else if (event.key === "0") {
        event.preventDefault();
        store.resetAppScale();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);
}

/**
 * Read-only projection for secondary windows (Monitor): applies the same
 * metrics, follows `storage` changes to the single appearance key, and never
 * writes preferences, registers shortcuts or persists anything back.
 */
export function useApplyAppearanceProjection(): void {
  const preferences = useAppearanceStore((s) => s.preferences);

  useEffect(() => {
    applyMetrics(preferences);
  }, [preferences]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const onStorage = (event: StorageEvent) => {
      if (event.key !== APPEARANCE_KEY) return;
      try {
        const next = event.newValue ? JSON.parse(event.newValue) : null;
        useAppearanceStore.setState({ preferences: normalizeAppearancePreferences(next) });
      } catch {
        // Malformed update: keep the last valid projection.
      }
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);
}
