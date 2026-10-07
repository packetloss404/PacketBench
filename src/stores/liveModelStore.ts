import { create } from "zustand";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { AgentCli } from "@/stores/agentTaskStore";
import {
  classifyLiveModelError,
  fetchLiveModels,
  liveModelRow,
  liveModelSource,
  type LiveModelAnswer,
} from "@/lib/liveModels";

/**
 * Shared cache of provider-enumerated model lists.
 *
 * Deliberately modelled on `authStatusStore`: one cache, one in-flight request
 * per key, one global `provider-auth:changed` subscription — not one fetch per
 * mounted picker.
 *
 * ## Serve cached, refresh behind
 *
 * `ensureFresh` NEVER makes a caller wait. It returns immediately; whatever is
 * cached (including a stale list) keeps rendering while a refresh runs, and the
 * subscriber re-renders when the new answer lands. Nothing here is on the app's
 * launch path or the picker's open path — a model picker that spins on a cold
 * network is strictly worse than one showing last week's list.
 *
 * ## Eager invalidation
 *
 * The TTL is a backstop for drift, not the mechanism. The events that actually
 * change a provider's answer are pushed:
 *
 * - `provider-auth:changed` (a key added, changed, or a login completing) —
 *   subscribed here, once, globally.
 * - a base URL edit — call {@link LiveModelState.invalidate} from the Settings
 *   surface that made the edit.
 * - the user pressing Refresh in a picker — `ensureFresh(agent, { force: true })`.
 */

interface CacheEntry extends LiveModelAnswer {
  /** Which vendor key this entry answers for. */
  provider: string;
}

interface LiveModelState {
  entries: Record<string, CacheEntry>;
  /**
   * The cached answer for an agent's provider, without triggering a fetch.
   * `undefined` for an agent that does not enumerate live at all.
   */
  answerFor: (agent: AgentCli) => LiveModelAnswer | undefined;
  /**
   * Ensure a reasonably fresh list exists for this agent's provider, refreshing
   * in the background when the TTL has lapsed. Returns nothing: callers render
   * from the store, never from this call's result.
   *
   * Only `producer: "ipc"` providers are fetched here — Ollama, the custom
   * endpoint has its own producer and converges on the
   * seam's row builder and precedence instead.
   */
  ensureFresh: (agent: AgentCli, options?: { force?: boolean }) => void;
  /** Drop a provider's cached answer (base URL changed, key rotated, …). */
  invalidate: (provider?: string) => void;
  /** Idempotently install the single global `provider-auth:changed` listener. */
  ensureListener: () => void;
  /** Test-only escape hatch: drop cache, in-flight map, and listener. */
  reset: () => void;
}

/**
 * In-flight fetches, keyed by provider. Outside zustand state because promises
 * are not renderable state — subscribers re-render when a result lands, not
 * when a request starts.
 */
const inFlight = new Map<string, Promise<void>>();

let listenerHandle: UnlistenFn | undefined;
let listenerRequested = false;

export const useLiveModelStore = create<LiveModelState>((set, get) => ({
  entries: {},

  answerFor: (agent) => {
    const source = liveModelSource(agent);
    if (!source) return undefined;
    return get().entries[source.provider];
  },

  ensureFresh: (agent, options) => {
    const source = liveModelSource(agent);
    if (!source || source.producer !== "ipc") return;
    const key = source.provider;
    const force = options?.force ?? false;

    if (inFlight.has(key)) return;

    const cached = get().entries[key];
    // `unsupported` is terminal for the session: this build has no binding, so
    // retrying on every picker open would be pure noise. A forced refresh still
    // re-checks, so a user who asked gets a real answer either way.
    if (!force && cached?.status === "unsupported") return;
    if (
      !force &&
      cached &&
      cached.fetchedAt !== undefined &&
      Date.now() - cached.fetchedAt < source.ttlMs
    ) {
      return;
    }

    set((s) => ({
      entries: {
        ...s.entries,
        [key]: {
          // Keep the last good rows on screen rather than flashing empty —
          // this is a refresh behind existing content, not a cold load.
          ...(cached ?? {}),
          provider: key,
          status: "loading",
        },
      },
    }));

    const request = fetchLiveModels(key)
      .then((result) => {
        if (inFlight.get(key) !== request) return;
        if (result === "unsupported") {
          set((s) => ({
            entries: {
              ...s.entries,
              [key]: { ...(s.entries[key] ?? { provider: key }), provider: key, status: "unsupported" },
            },
          }));
          return;
        }
        const rows = result.map((model) => liveModelRow(model, key));
        set((s) => ({
          entries: {
            ...s.entries,
            [key]: {
              provider: key,
              // A settled answer, empty included — see the `[]` ruling in
              // `lib/liveModels.ts`. This is the ONE place an empty list is
              // allowed to replace a previously non-empty one.
              status: "ready",
              models: rows,
              fetchedAt: Date.now(),
            },
          },
        }));
      })
      .catch((err: unknown) => {
        if (inFlight.get(key) !== request) return;
        const { status, message } = classifyLiveModelError(err);
        set((s) => {
          const previous = s.entries[key];
          return {
            entries: {
              ...s.entries,
              [key]: {
                provider: key,
                status,
                error: message,
                // A FAILED fetch must never clear a list that once landed —
                // the same degradation rule every producer follows, where
                // leaving the field untouched keeps the catalog standing
                // rather than emptying the picker.
                models: previous?.models,
                fetchedAt: previous?.fetchedAt,
              },
            },
          };
        });
      })
      .finally(() => {
        if (inFlight.get(key) === request) inFlight.delete(key);
      });

    inFlight.set(key, request);
  },

  invalidate: (provider) => {
    if (!provider) {
      inFlight.clear();
      set({ entries: {} });
      return;
    }
    inFlight.delete(provider);
    set((s) => {
      const next = { ...s.entries };
      delete next[provider];
      return { entries: next };
    });
  },

  ensureListener: () => {
    if (listenerRequested) return;
    listenerRequested = true;
    listen<{ provider: string }>("provider-auth:changed", (event) => {
      // A credential changed for this vendor, so whatever it previously told
      // us about its catalog (including "no key") is now suspect. Drop it; the
      // next `ensureFresh` — mounted pickers rerun it when the entry disappears —
      // re-asks.
      const provider = event.payload?.provider;
      if (!provider) {
        get().invalidate();
        return;
      }
      get().invalidate(provider);
      // Auth probes use CLI-flavoured ids (`claude-oauth`) where the model
      // registry uses vendor keys (`anthropic`); drop both rather than let a
      // naming mismatch strand a stale "no key" answer on screen.
      if (provider === "claude-oauth") get().invalidate("anthropic");
      if (provider === "openai-codex") get().invalidate("openai");
    })
      .then((fn) => {
        if (!listenerRequested) {
          fn();
          return;
        }
        listenerHandle = fn;
      })
      .catch((err) => {
        listenerRequested = false;
        console.warn("[liveModelStore] listen(provider-auth:changed) failed", err);
      });
  },

  reset: () => {
    inFlight.clear();
    listenerRequested = false;
    if (listenerHandle) {
      listenerHandle();
      listenerHandle = undefined;
    }
    set({ entries: {} });
  },
}));
