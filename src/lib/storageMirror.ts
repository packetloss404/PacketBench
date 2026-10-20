/**
 * Durable write-through mirror for the webview's `localStorage`.
 *
 * ## The defect this closes
 *
 * Tauri scopes the webview profile — and therefore `localStorage` — to a
 * directory derived from the **bundle identifier**. On Windows that is
 * `%LOCALAPPDATA%\<identifier>\EBWebView\Default\Local Storage\leveldb`;
 * verified directly on the maintainer's machine, where
 * `com.packetade.desktop` and `com.packetbench.desktop` each own a separate
 * `EBWebView\Default\Local Storage` tree.
 *
 * The 2026-08-26 rename moved the identifier from `com.packetade.desktop` to
 * `com.packetbench.desktop`, so the renamed build came up against an empty
 * store and every `packetbench:*` key looked deleted. `storage-migration.ts`
 * cannot fix that: it runs *inside* the new, already-empty store.
 *
 * The Rust data dir (`~/.packetbench`) is keyed by the user's home directory,
 * not by the bundle identifier, so a copy kept there survives any identifier
 * change. This module keeps that copy in sync and refills `localStorage` from
 * it at boot.
 *
 * ## Design, and what was rejected
 *
 * **Rejected: move persisted state to async Tauri-backed storage.** The
 * obvious fix is to stop using `localStorage` and read state over IPC. But
 * ~40 stores hydrate synchronously at module-evaluation time; making them
 * async would move every one of them to a post-first-paint hydration and
 * change initial-render behaviour app-wide. That is an enormous blast radius
 * for a problem that is really just "the store came up empty once".
 *
 * **Rejected: mirror at the `loadFromStorage` / `saveToStorage` seam.** That
 * seam is imported by 29 files, but it is not the only writer: there are ~25
 * further direct `localStorage.setItem` call sites across `src/components`,
 * `src/lib` and `src/stores`, plus the two stores that use Zustand's `persist`
 * middleware (`issueFlightMirrorStore`, `packetAgentStore`), which writes
 * through its own storage adapter. Hooking the seam would have mirrored a
 * fraction of the keyspace and silently lost the rest.
 *
 * **Chosen: intercept the `Storage` write methods, snapshot the whole
 * `packetbench:*` keyspace, and flush it debounced.** Reads and writes stay
 * exactly as synchronous as they are today — nothing in any store changes —
 * and coverage is total by construction: every writer goes through
 * `setItem`/`removeItem`/`clear`, including Zustand's `persist` middleware and
 * every component that never imported the seam. See
 * {@link interceptStorageWrites} for why the prototype, not the instance, is
 * the patch point.
 *
 * ## Invariants
 *
 * - **`localStorage` wins settings.** Restore fills gaps only, except that
 *   valid project-history arrays merge by exact path and newest timestamp.
 *   A warm origin must not erase history recorded under another origin.
 * - **Snapshot, not deltas.** Each flush sends the complete `packetbench:*`
 *   keyspace, so deletions propagate and the mirror cannot accumulate keys the
 *   app has stopped using.
 * - **The writer only starts after a successful read.** If the mirror cannot
 *   be loaded, the writer stays off — otherwise a failed read on a fresh
 *   origin would flush an empty snapshot over a perfectly good mirror, turning
 *   a transient IPC error into permanent data loss.
 * - **Inert without Tauri.** Under Vitest (no Tauri at all) and any plain
 *   browser context, every entry point is a no-op that resolves. Nothing here
 *   ever throws or leaves a floating rejection.
 *
 * ## Write amplification
 *
 * A naive mirror would cost one IPC round trip per keystroke in stores that
 * persist drafts. Four things bound it:
 *
 * 1. A trailing {@link DEBOUNCE_MS} debounce with a {@link MAX_DEBOUNCE_MS}
 *    ceiling, so a continuous burst still lands at least that often and a
 *    crash can lose at most that window of changes.
 * 2. Flushes are serialized on a promise chain, so a slow write cannot stack
 *    up concurrent IPC calls.
 * 3. An identical-content check: if the serialized snapshot matches the last
 *    one written, the IPC call is skipped entirely.
 * 4. Size budgets ({@link MAX_VALUE_BYTES}, {@link MAX_TOTAL_BYTES}) keep a
 *    runaway cache key from turning every flush into a multi-megabyte write.
 */

import { STORAGE_PREFIX } from "@/lib/brand";
import { loadWebviewStorageMirror, saveWebviewStorageMirror } from "@/lib/tauri";

/** Idle time after the last write before a flush is attempted. */
export const DEBOUNCE_MS = 750;

/**
 * Ceiling on how long a continuous write burst can defer a flush. Also the
 * upper bound on how much a crash between a write and its flush can lose.
 */
export const MAX_DEBOUNCE_MS = 4_000;

/**
 * Per-key ceiling. Values above this are large regenerable caches
 * (`packetbench:workspaces-cache` and friends), not settings worth carrying
 * across a rename, and mirroring them would dominate every flush.
 */
export const MAX_VALUE_BYTES = 512 * 1024;

/** Whole-snapshot ceiling. Largest keys are dropped first to get under it. */
export const MAX_TOTAL_BYTES = 4 * 1024 * 1024;

export interface StorageMirrorBootResult {
  /** Whether the write-through mirror is now running. */
  active: boolean;
  /** How many keys were restored or had project history merged at boot. */
  restored: number;
  /** Why the mirror is inactive, when it is. */
  reason: "no-tauri" | "no-storage" | "load-failed" | "intercept-failed" | null;
}

// ---------------------------------------------------------------------------
// Environment probes
// ---------------------------------------------------------------------------

function getLocalStorage(): Storage | null {
  try {
    const store = globalThis.localStorage;
    return store && typeof store.setItem === "function" ? store : null;
  } catch {
    // Storage can throw on access when site data is blocked.
    return null;
  }
}

/**
 * Whether we are inside the Tauri webview. Matches the probe used elsewhere in
 * the app (e.g. `dictationStore`), so behaviour is consistent across features.
 */
function hasTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

// ---------------------------------------------------------------------------
// Snapshot
// ---------------------------------------------------------------------------

/**
 * Collect every mirrored key from `localStorage`, applying the size budgets.
 *
 * Only the `packetbench:*` namespace is mirrored. Every persisted key in the
 * app is built from `STORAGE_PREFIX` (directly or via `storageKey()`), so this
 * is complete coverage without sweeping up unrelated origin data. Legacy
 * `packetade:*` keys are deliberately excluded: on any install that reaches
 * this code the prefix migration has already copied them forward, so mirroring
 * them would only duplicate bytes.
 */
export function snapshotMirroredKeys(): Record<string, string> {
  const store = getLocalStorage();
  if (!store) return {};

  const collected: { key: string; value: string }[] = [];
  let total = 0;

  try {
    for (let i = 0; i < store.length; i++) {
      const key = store.key(i);
      if (!key || !key.startsWith(STORAGE_PREFIX)) continue;
      const value = store.getItem(key);
      if (value === null) continue;
      if (value.length > MAX_VALUE_BYTES) continue;
      collected.push({ key, value });
      total += key.length + value.length;
    }
  } catch {
    return {};
  }

  if (total > MAX_TOTAL_BYTES) {
    // Drop the biggest entries first: they are the least likely to be
    // hand-authored settings and the most likely to be regenerable caches.
    collected.sort((a, b) => b.value.length - a.value.length);
    while (collected.length > 0 && total > MAX_TOTAL_BYTES) {
      const dropped = collected.shift();
      if (!dropped) break;
      total -= dropped.key.length + dropped.value.length;
    }
  }

  const snapshot: Record<string, string> = {};
  // Sort so a semantically identical snapshot serializes identically and the
  // no-op check below actually fires.
  for (const { key, value } of collected.sort((a, b) => (a.key < b.key ? -1 : 1))) {
    snapshot[key] = value;
  }
  return snapshot;
}

interface MirroredProjectHistoryEntry {
  path: string;
  lastOpened: number;
}

function parseProjectHistory(raw: string): MirroredProjectHistoryEntry[] | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (
      !Array.isArray(parsed) ||
      !parsed.every((entry: unknown) => {
        if (!entry || typeof entry !== "object" || Array.isArray(entry)) return false;
        const item = entry as Record<string, unknown>;
        return (
          typeof item.path === "string" &&
          item.path.length > 0 &&
          typeof item.lastOpened === "number" &&
          Number.isFinite(item.lastOpened) &&
          item.lastOpened >= 0
        );
      })
    )
      return null;
    return parsed as MirroredProjectHistoryEntry[];
  } catch {
    return null;
  }
}

/** The history store has no retention cap; preserve every exact path here too. */
function mergeProjectHistory(current: string, mirrored: string): string | null {
  const live = parseProjectHistory(current);
  const durable = parseProjectHistory(mirrored);
  // Keep a valid local copy when the mirror is malformed. If only the
  // mirror is valid, recover it instead of letting a corrupt warm key erase it.
  if (!durable) return null;
  const byPath = new Map<string, MirroredProjectHistoryEntry>();
  for (const entry of [...(live ?? []), ...durable]) {
    const previous = byPath.get(entry.path);
    if (!previous || entry.lastOpened > previous.lastOpened) byPath.set(entry.path, entry);
  }
  return JSON.stringify(
    [...byPath.values()].sort((left, right) => right.lastOpened - left.lastOpened),
  );
}

/**
 * Copy mirrored entries into `localStorage`, filling gaps except project history.
 *
 * Returns the number of keys actually restored. A key already present in
 * `localStorage` is left untouched except for valid project-history arrays,
 * whose exact paths are unioned before hydration and the initial mirror flush.
 */
export function applyMirrorToStorage(entries: Record<string, string>): number {
  const store = getLocalStorage();
  if (!store) return 0;

  let restored = 0;
  for (const [key, value] of Object.entries(entries)) {
    // Defensive: a hand-edited or version-skewed mirror could hold keys from
    // outside our namespace. Never write those into the origin.
    if (!key.startsWith(STORAGE_PREFIX)) continue;
    if (typeof value !== "string") continue;
    try {
      const current = store.getItem(key);
      if (current !== null) {
        if (key !== `${STORAGE_PREFIX}project-history`) continue;
        const merged = mergeProjectHistory(current, value);
        if (merged === null || merged === current) continue;
        store.setItem(key, merged);
        restored++;
        continue;
      }
      store.setItem(key, value);
      restored++;
    } catch {
      // Quota or a disabled store — restore as much as we can, then stop
      // caring. A partial restore beats aborting the whole boot.
    }
  }
  return restored;
}

// ---------------------------------------------------------------------------
// Write interception
// ---------------------------------------------------------------------------

const WRITE_METHODS = ["setItem", "removeItem", "clear"] as const;

type StorageWriteMethod = (typeof WRITE_METHODS)[number];
type AnyFn = (...args: never[]) => unknown;

/**
 * Wrap the `Storage` write methods so every mutation schedules a flush.
 *
 * Patches `Storage.prototype`, **not** the `localStorage` instance. A real
 * `localStorage` is a WebIDL legacy platform object with a named-property
 * setter: both `localStorage.setItem = fn` and
 * `Object.defineProperty(localStorage, "setItem", …)` are routed into the
 * named-property setter, which stores a *storage entry literally named
 * "setItem"* instead of shadowing the method. The prototype is an ordinary
 * object and patches cleanly. Because the prototype is shared with
 * `sessionStorage`, the wrapper checks the receiver before reacting.
 *
 * The in-memory `Storage` shim used by the Vitest setup files is a plain
 * object behind a `Proxy`, not a `Storage`, so that case falls back to
 * patching the object directly — which is safe precisely because it has no
 * named-property setter.
 *
 * Returns an uninstall function, or `null` if the environment refused the
 * patch (in which case the mirror stays off rather than running half-wired).
 */
export function interceptStorageWrites(onWrite: () => void): (() => void) | null {
  const store = getLocalStorage();
  if (!store) return null;

  const usesPrototype =
    typeof Storage === "function" &&
    store instanceof Storage &&
    typeof Storage.prototype.setItem === "function";
  const target = (usesPrototype ? Storage.prototype : store) as unknown as Record<string, AnyFn>;

  const originals = new Map<StorageWriteMethod, AnyFn>();

  const uninstall = () => {
    for (const [name, original] of originals) {
      try {
        Object.defineProperty(target, name, {
          configurable: true,
          writable: true,
          value: original,
        });
      } catch {
        /* best effort */
      }
    }
    originals.clear();
  };

  try {
    for (const name of WRITE_METHODS) {
      const original = target[name];
      if (typeof original !== "function") {
        uninstall();
        return null;
      }
      originals.set(name, original);
      Object.defineProperty(target, name, {
        configurable: true,
        writable: true,
        value: function patchedStorageWrite(this: unknown, ...args: never[]) {
          // Call through first: a quota exception must propagate exactly as it
          // does today, and a write that failed should not schedule a flush.
          const result = (original as (...a: never[]) => unknown).apply(this, args);
          if (!usesPrototype || this === store) onWrite();
          return result;
        },
      });
    }
  } catch {
    uninstall();
    return null;
  }

  return uninstall;
}

// ---------------------------------------------------------------------------
// Flush scheduling
// ---------------------------------------------------------------------------

let uninstallInterception: (() => void) | null = null;
let debounceTimer: ReturnType<typeof setTimeout> | null = null;
let firstDirtyAt = 0;
let lastFlushedSerialized: string | null = null;
/**
 * Serializes flushes. `runFlush` never rejects, so this chain never rejects —
 * which is what keeps `void flushStorageMirrorNow()` from ever surfacing as an
 * unhandled rejection (a failure mode that fails a Vitest run even when every
 * test passes).
 */
let flushChain: Promise<void> = Promise.resolve();
let unbindLifecycle: (() => void) | null = null;

function clearDebounce(): void {
  if (debounceTimer !== null) {
    clearTimeout(debounceTimer);
    debounceTimer = null;
  }
}

async function runFlush(): Promise<void> {
  if (!uninstallInterception) return;
  try {
    const snapshot = snapshotMirroredKeys();
    const serialized = JSON.stringify(snapshot);
    if (serialized === lastFlushedSerialized) return;
    await saveWebviewStorageMirror(snapshot);
    lastFlushedSerialized = serialized;
  } catch (e) {
    // Force the next flush to retry rather than trusting a bookkeeping value
    // that may not reflect what is actually on disk.
    lastFlushedSerialized = null;
    console.warn("[storage-mirror] flush failed", e);
  }
}

function enqueueFlush(): Promise<void> {
  flushChain = flushChain.then(runFlush, runFlush);
  return flushChain;
}

function scheduleFlush(): void {
  if (!uninstallInterception) return;
  const now = Date.now();

  if (debounceTimer === null) {
    firstDirtyAt = now;
  } else if (now - firstDirtyAt >= MAX_DEBOUNCE_MS) {
    // A sustained write burst has held the trailing debounce open for the
    // whole ceiling. Flush now so the crash-loss window stays bounded.
    clearDebounce();
    void enqueueFlush();
    return;
  }

  clearDebounce();
  debounceTimer = setTimeout(() => {
    debounceTimer = null;
    void enqueueFlush();
  }, DEBOUNCE_MS);
}

/**
 * Flush any pending changes immediately and resolve when the write settles.
 *
 * Never rejects. Safe to call when the mirror is inactive (resolves at once).
 */
export function flushStorageMirrorNow(): Promise<void> {
  clearDebounce();
  return enqueueFlush();
}

/** Tear the mirror down: uninstall the patch, cancel timers, drop listeners. */
export function stopStorageMirror(): void {
  clearDebounce();
  unbindLifecycle?.();
  unbindLifecycle = null;
  uninstallInterception?.();
  uninstallInterception = null;
  lastFlushedSerialized = null;
  firstDirtyAt = 0;
}

function bindLifecycleFlush(): void {
  if (typeof window === "undefined" || typeof window.addEventListener !== "function") return;
  const handler = () => {
    void flushStorageMirrorNow();
  };
  // `pagehide` covers the normal webview teardown; `beforeunload` catches the
  // window-close path. Both are best-effort — the debounce ceiling is what
  // actually bounds loss, these only shorten the tail.
  window.addEventListener("pagehide", handler);
  window.addEventListener("beforeunload", handler);
  unbindLifecycle = () => {
    window.removeEventListener("pagehide", handler);
    window.removeEventListener("beforeunload", handler);
  };
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

/**
 * Restore `localStorage` from the durable mirror, then start mirroring writes.
 *
 * **Must run before any store module evaluates**, because stores hydrate from
 * `localStorage` at module-evaluation time. `src/lib/storage-boot.ts` enforces
 * that ordering; do not call this from inside the React tree.
 *
 * Never rejects.
 */
export async function bootStorageMirror(): Promise<StorageMirrorBootResult> {
  if (!hasTauri()) return { active: false, restored: 0, reason: "no-tauri" };
  if (!getLocalStorage()) return { active: false, restored: 0, reason: "no-storage" };

  let entries: Record<string, string>;
  try {
    entries = await loadWebviewStorageMirror();
  } catch (e) {
    // Deliberately do NOT start the writer. Flushing after a failed read would
    // overwrite a possibly-good mirror with whatever this origin happens to
    // hold, converting a transient IPC error into permanent loss.
    console.warn("[storage-mirror] could not read the mirror; staying passive", e);
    return { active: false, restored: 0, reason: "load-failed" };
  }

  const restored = applyMirrorToStorage(entries ?? {});
  if (restored > 0) {
    console.info(`[storage-mirror] restored ${restored} key(s) from the durable mirror`);
  }

  uninstallInterception = interceptStorageWrites(scheduleFlush);
  if (!uninstallInterception) {
    return { active: false, restored, reason: "intercept-failed" };
  }
  bindLifecycleFlush();

  // Seed the mirror from the live store straight away. On the first launch
  // after this ships the mirror is empty while `localStorage` is full, and
  // waiting for the user's next write to capture it would leave a window where
  // an identifier change still loses everything.
  void flushStorageMirrorNow();

  return { active: true, restored, reason: null };
}

/** Test seam: whether the write-through mirror is currently installed. */
export function isStorageMirrorActive(): boolean {
  return uninstallInterception !== null;
}
