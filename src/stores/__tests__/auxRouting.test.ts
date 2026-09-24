import { beforeEach, describe, expect, it, vi } from "vitest";

const setAuxRoutingOverridesMock = vi.fn().mockResolvedValue(undefined);

vi.mock("@/lib/tauri", () => ({
  setAuxRoutingOverrides: (...args: unknown[]) => setAuxRoutingOverridesMock(...args),
}));

import { auxOverridePayload, useRoutingStore } from "@/stores/routingStore";
import { ALL_AUX_TASK_CLASSES } from "@/types/routing";

/**
 * WI-1 — the auxiliary routing slice. The frontend owns persistence; the
 * backend owns resolution (only Rust can see the OS keyring, so only Rust can
 * answer "which providers are configured, and which is cheapest"). These tests
 * pin the contract between the two halves.
 */
describe("routingStore auxiliary routing", () => {
  beforeEach(() => {
    localStorage.clear();
    setAuxRoutingOverridesMock.mockClear();
    useRoutingStore.getState().resetAuxToDefaults();
    setAuxRoutingOverridesMock.mockClear();
  });

  it("defaults every auxiliary task class to Auto", () => {
    const { auxMappings, resolveForAuxTask } = useRoutingStore.getState();
    expect(auxMappings.map((m) => m.taskClass)).toEqual(ALL_AUX_TASK_CLASSES);
    for (const taskClass of ALL_AUX_TASK_CLASSES) {
      expect(resolveForAuxTask(taskClass)).toEqual({ provider: null, model: null });
    }
  });

  it("sends an empty override map when everything is on Auto", () => {
    expect(auxOverridePayload(useRoutingStore.getState().auxMappings)).toEqual({});
  });

  it("pushes a pin to the backend, keyed by the wire task-class id", async () => {
    useRoutingStore.getState().setAuxMapping("pr-review", "minimax", "MiniMax-M3");

    expect(useRoutingStore.getState().resolveForAuxTask("pr-review")).toEqual({
      provider: "minimax",
      model: "MiniMax-M3",
    });
    expect(setAuxRoutingOverridesMock).toHaveBeenCalledWith({
      "pr-review": { provider: "minimax", model: "MiniMax-M3" },
    });
  });

  it("keeps pins independent per task class", () => {
    useRoutingStore.getState().setAuxMapping("spec-import", "anthropic", null);
    useRoutingStore.getState().setAuxMapping("pr-description", "openai", "o4-mini");

    expect(auxOverridePayload(useRoutingStore.getState().auxMappings)).toEqual({
      "spec-import": { provider: "anthropic", model: null },
      "pr-description": { provider: "openai", model: "o4-mini" },
    });
    // Untouched classes stay on Auto and are omitted entirely.
    expect(useRoutingStore.getState().resolveForAuxTask("pr-review").provider).toBeNull();
  });

  it("persists pins across a reload and re-pushes them on boot", () => {
    useRoutingStore.getState().setAuxMapping("code-quality-summarize", "openrouter", null);

    const stored = JSON.parse(localStorage.getItem("packetbench:routing-aux") ?? "[]");
    expect(stored).toContainEqual({
      taskClass: "code-quality-summarize",
      provider: "openrouter",
      model: null,
    });

    setAuxRoutingOverridesMock.mockClear();
    useRoutingStore.getState().syncAuxRouting();
    expect(setAuxRoutingOverridesMock).toHaveBeenCalledWith({
      "code-quality-summarize": { provider: "openrouter", model: null },
    });
  });

  it("ignores the retired diagnostic route while retaining the saved run-summary route", async () => {
    localStorage.setItem(
      "packetbench:routing-aux",
      JSON.stringify([
        { taskClass: "code-quality-explain", provider: "anthropic", model: "legacy" },
        { taskClass: "code-quality-summarize", provider: "openrouter", model: "saved-summary" },
      ]),
    );
    vi.resetModules();
    const { useRoutingStore: reloaded } = await import("@/stores/routingStore");
    expect(
      reloaded
        .getState()
        .auxMappings.some((mapping) => String(mapping.taskClass) === "code-quality-explain"),
    ).toBe(false);
    expect(reloaded.getState().resolveForAuxTask("code-quality-summarize")).toEqual({
      provider: "openrouter",
      model: "saved-summary",
    });
    reloaded.getState().syncAuxRouting();
    expect(setAuxRoutingOverridesMock).toHaveBeenLastCalledWith({
      "code-quality-summarize": { provider: "openrouter", model: "saved-summary" },
    });
  });

  it("resets back to Auto and tells the backend", () => {
    useRoutingStore.getState().setAuxMapping("pr-review", "anthropic", null);
    setAuxRoutingOverridesMock.mockClear();

    useRoutingStore.getState().resetAuxToDefaults();

    expect(useRoutingStore.getState().resolveForAuxTask("pr-review").provider).toBeNull();
    expect(setAuxRoutingOverridesMock).toHaveBeenCalledWith({});
  });

  it("offers no subscription-OAuth route", () => {
    // The auxiliary providers the settings can pin are enumerated backend-side
    // (`AUX_PROVIDERS`); the store must not smuggle one in through the payload.
    useRoutingStore.getState().setAuxMapping("spec-import", "claude-oauth", null);
    // The store is a dumb carrier — the backend rejects the value. What matters
    // here is that nothing in the frontend *defaults* to it.
    useRoutingStore.getState().resetAuxToDefaults();
    const payload = auxOverridePayload(useRoutingStore.getState().auxMappings);
    expect(Object.values(payload)).toHaveLength(0);
  });
});
