/**
 * Module-level cache of streamed AI summaries, keyed by `runHash`. Lives
 * here (rather than inside `QualityAISummary.tsx`) so the component
 * file only exports React components — Vite Fast Refresh requires that.
 *
 * Intentionally NOT persisted to localStorage — the underlying check
 * output isn't persisted either, so any stored summary would risk
 * referring to stale failures.
 */
const SUMMARY_CACHE = new Map<string, string>();

export function getQualityAISummaryCache(runHash: string): string | null {
  return SUMMARY_CACHE.get(runHash) ?? null;
}

export function setQualityAISummaryCache(runHash: string, value: string): void {
  SUMMARY_CACHE.set(runHash, value);
}

export function deleteQualityAISummaryCache(runHash: string): void {
  SUMMARY_CACHE.delete(runHash);
}

/**
 * Clear cached AI summaries.
 *
 * - When `runHash` is supplied, delete only that key. Use this when a
 *   specific run is being re-streamed or invalidated — it avoids wiping
 *   another CodeQualityModal instance's cached summary running in parallel.
 * - When omitted, clear the whole module-level Map (e.g. test teardown,
 *   app-wide reset).
 */
export function clearQualityAISummaryCache(runHash?: string): void {
  if (runHash === undefined) {
    SUMMARY_CACHE.clear();
    return;
  }
  SUMMARY_CACHE.delete(runHash);
}
