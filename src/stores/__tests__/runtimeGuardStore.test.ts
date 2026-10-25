/**
 * The runtime-guard capability cache (R4b UX follow-up).
 *
 * The load-bearing rule: while the guard is ON, image attachments are allowed
 * only for a route whose vision is EXPLICITLY `supported`. `unsupported`,
 * `unknown`, an unfetched route, and a failed read are all refusals — the same
 * fail-closed answer the backend `require_route_supports_images` guard gives.
 * While the guard is OFF (the default) the store is invisible: it must never
 * take the affordance away.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const { getRuntimeGuardStatus, getRuntimeCapabilities } = vi.hoisted(() => ({
  getRuntimeGuardStatus: vi.fn(),
  getRuntimeCapabilities: vi.fn(),
}));

vi.mock("@/lib/tauri", () => ({
  getRuntimeGuardStatus,
  getRuntimeCapabilities,
}));

import { useRuntimeGuardStore } from "@/stores/runtimeGuardStore";

/** Let the store's promise chain settle. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  useRuntimeGuardStore.getState().reset();
  getRuntimeGuardStatus.mockReset();
  getRuntimeCapabilities.mockReset();
});

describe("runtimeGuardStore.imageAttachmentsAllowed", () => {
  it("allows images while the guard is disabled, regardless of capability", () => {
    useRuntimeGuardStore.setState({
      enabled: false,
      capabilities: { "openai:gpt-4o": { visionState: "unknown" } },
    });
    expect(useRuntimeGuardStore.getState().imageAttachmentsAllowed("openai", "gpt-4o")).toBe(true);
  });

  it("allows images only for an explicitly supported route while the guard is on", () => {
    useRuntimeGuardStore.setState({
      enabled: true,
      capabilities: {
        "openai:gpt-4o": { visionState: "supported" },
        "openrouter:odd": { visionState: "unsupported" },
        "minimax:m1": { visionState: "unknown" },
      },
    });
    const store = useRuntimeGuardStore.getState();
    expect(store.imageAttachmentsAllowed("openai", "gpt-4o")).toBe(true);
    expect(store.imageAttachmentsAllowed("openrouter", "odd")).toBe(false);
    expect(store.imageAttachmentsAllowed("minimax", "m1")).toBe(false);
  });

  it("fails closed for an unfetched route while the guard is on", () => {
    useRuntimeGuardStore.setState({ enabled: true, capabilities: {} });
    expect(useRuntimeGuardStore.getState().imageAttachmentsAllowed("openai", "gpt-4o")).toBe(false);
  });

  it("caches a failed capability read as not-supported", async () => {
    getRuntimeGuardStatus.mockResolvedValue(true);
    getRuntimeCapabilities.mockRejectedValue(new Error("boom"));
    await useRuntimeGuardStore.getState().init();
    useRuntimeGuardStore.getState().ensureCapability("openai", "gpt-4o");
    await settle();
    expect(useRuntimeGuardStore.getState().capabilities["openai:gpt-4o"]).toBeDefined();
    expect(useRuntimeGuardStore.getState().imageAttachmentsAllowed("openai", "gpt-4o")).toBe(false);
  });

  it("does not probe capabilities while the guard is disabled", async () => {
    getRuntimeGuardStatus.mockResolvedValue(false);
    await useRuntimeGuardStore.getState().init();
    useRuntimeGuardStore.getState().ensureCapability("openai", "gpt-4o");
    await settle();
    expect(getRuntimeCapabilities).not.toHaveBeenCalled();
    expect(useRuntimeGuardStore.getState().imageAttachmentsAllowed("openai", "gpt-4o")).toBe(true);
  });

  it("reads and caches the route's vision state once", async () => {
    getRuntimeGuardStatus.mockResolvedValue(true);
    getRuntimeCapabilities.mockResolvedValue({ vision: { state: "supported" } });
    await useRuntimeGuardStore.getState().init();
    useRuntimeGuardStore.getState().ensureCapability("openai", "gpt-4o");
    useRuntimeGuardStore.getState().ensureCapability("openai", "gpt-4o");
    await settle();
    expect(getRuntimeCapabilities).toHaveBeenCalledTimes(1);
    expect(useRuntimeGuardStore.getState().imageAttachmentsAllowed("openai", "gpt-4o")).toBe(true);
  });
});
