import { create } from "zustand";
import { getRuntimeCapabilities, getRuntimeGuardStatus } from "@/lib/tauri";

/**
 * Runtime-guard capability cache for the composer (R4b UX follow-up).
 *
 * The guard (the runtime journal) is off by default and this store must be
 * invisible on that path: `imageAttachmentsAllowed` answers `true` whenever the
 * guard is off, so the composer's image affordance is unchanged. Only when the
 * guard is ON does an explicit `vision: "supported"` answer keep attachments
 * enabled — an `unsupported`, `unknown`, or not-yet-read route is refused
 * fail-closed, mirroring the backend `require_route_supports_images` guard.
 */

interface RouteCapability {
  /** `vision.state` from `get_runtime_capabilities`; null when the read failed. */
  visionState: string | null;
}

interface RuntimeGuardState {
  /**
   * null until `init` resolves; false when the status probe failed.
   *
   * `null` (status not yet fetched) is deliberately treated as "off" by
   * {@link RuntimeGuardState.imageAttachmentsAllowed}, so the default path is
   * byte-identical and never briefly disables attachments at startup. The
   * composer's send-path block is the backstop for a genuinely-enabled guard
   * during that window: once `enabled` is true and the route's capability is
   * not yet `supported`, a staged image can no longer be sent.
   */
  enabled: boolean | null;
  capabilities: Record<string, RouteCapability>;
  init: () => Promise<void>;
  ensureCapability: (provider: string, model: string) => void;
  imageAttachmentsAllowed: (provider: string, model: string) => boolean;
  reset: () => void;
}

const inFlight = new Map<string, Promise<void>>();
let initRequest: Promise<void> | null = null;

function routeKey(provider: string, model: string): string {
  return `${provider}:${model}`;
}

export const useRuntimeGuardStore = create<RuntimeGuardState>((set, get) => ({
  enabled: null,
  capabilities: {},

  init: () => {
    if (initRequest) return initRequest;
    initRequest = getRuntimeGuardStatus()
      .then((enabled) => set({ enabled }))
      // A status probe that cannot answer leaves the guard OFF, matching the
      // backend default — a failed readout must not take the affordance away.
      .catch(() => set({ enabled: false }));
    return initRequest;
  },

  ensureCapability: (provider, model) => {
    if (get().enabled !== true) return;
    const key = routeKey(provider, model);
    if (inFlight.has(key) || get().capabilities[key]) return;
    const request = getRuntimeCapabilities(provider, model)
      .then((view) => {
        set((s) => ({
          capabilities: { ...s.capabilities, [key]: { visionState: view.vision.state } },
        }));
      })
      .catch(() => {
        // Fail-closed, and cached: a route whose capability cannot be read is
        // treated as not-supported while the guard is on, and a dead route is
        // not re-probed on every render.
        set((s) => ({
          capabilities: { ...s.capabilities, [key]: { visionState: null } },
        }));
      })
      .finally(() => {
        inFlight.delete(key);
      });
    inFlight.set(key, request);
  },

  imageAttachmentsAllowed: (provider, model) => {
    if (get().enabled !== true) return true;
    return get().capabilities[routeKey(provider, model)]?.visionState === "supported";
  },

  reset: () => {
    inFlight.clear();
    initRequest = null;
    set({ enabled: null, capabilities: {} });
  },
}));
