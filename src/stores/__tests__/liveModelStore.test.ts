/**
 * The shared live-model cache.
 *
 * Three properties matter more than the rest, and each corresponds to a way a
 * dynamic model list can fail silently:
 *
 * 1. It never makes a caller wait. `ensureFresh` returns immediately and the
 *    picker renders whatever is cached, so a cold or slow network degrades to
 *    "last week's list" rather than to a spinner or an empty menu.
 * 2. A FAILED refresh does not clear a list that once landed: the catalog (or
 *    the last good answer) must stand, because the alternative is a picker
 *    that empties
 *    itself the first time the network hiccups.
 * 3. A SETTLED answer replaces the previous one even when it is empty. That is
 *    the only case where emptiness is allowed to win.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

// `vi.hoisted` because the `vi.mock` factory below is hoisted above this file's
// statements; a plain `const` is in the temporal dead zone when the factory runs.
const { listProviderModels } = vi.hoisted(() => ({ listProviderModels: vi.fn() }));

// Only the IPC call is stubbed. `parseLiveModelError` is a pure tag parser with
// no Tauri call behind it, and the store's classification depends on it — mock
// it away and these tests would stop covering the thing worth covering.
vi.mock("@/lib/tauri", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/tauri")>()),
  listProviderModels,
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn().mockResolvedValue(() => {}),
}));

import { useLiveModelStore } from "@/stores/liveModelStore";

/** Let the store's promise chain settle. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  useLiveModelStore.getState().reset();
  listProviderModels.mockReset();
});

describe("liveModelStore", () => {
  it("caches by VENDOR, so sibling rows share one round trip", async () => {
    listProviderModels.mockResolvedValue([{ id: "gpt-9" }]);
    // Both OpenAI rows read the same account.
    useLiveModelStore.getState().ensureFresh("api-openai");
    useLiveModelStore.getState().ensureFresh("api-openai-agents");
    await settle();
    expect(listProviderModels).toHaveBeenCalledTimes(1);
    expect(listProviderModels).toHaveBeenCalledWith("openai");
  });

  it("stores rows built through the shared builder", async () => {
    listProviderModels.mockResolvedValue([{ id: "claude-opus-5" }]);
    useLiveModelStore.getState().ensureFresh("api-claude");
    await settle();
    const answer = useLiveModelStore.getState().answerFor("api-claude");
    expect(answer?.status).toBe("ready");
    // ctx/pricing stamped — the chips a row built outside the builder used to
    // silently lose.
    expect(answer?.models?.[0].contextWindow).toBeGreaterThan(0);
    expect(answer?.models?.[0].pricing).toBeTruthy();
  });

  it("serves a cached answer inside the TTL without re-fetching", async () => {
    listProviderModels.mockResolvedValue([{ id: "gpt-9" }]);
    useLiveModelStore.getState().ensureFresh("api-openai");
    await settle();
    useLiveModelStore.getState().ensureFresh("api-openai");
    expect(listProviderModels).toHaveBeenCalledTimes(1);
    // …but an explicit user Refresh always re-asks.
    useLiveModelStore.getState().ensureFresh("api-openai", { force: true });
    await settle();
    expect(listProviderModels).toHaveBeenCalledTimes(2);
  });

  it("keeps the last good list when a refresh FAILS", async () => {
    listProviderModels.mockResolvedValue([{ id: "gpt-9" }]);
    useLiveModelStore.getState().ensureFresh("api-openai");
    await settle();

    listProviderModels.mockRejectedValue(new Error("ECONNREFUSED"));
    useLiveModelStore.getState().ensureFresh("api-openai", { force: true });
    await settle();

    const answer = useLiveModelStore.getState().answerFor("api-openai");
    expect(answer?.status).toBe("failed");
    // The rows survive the failure — this is the whole rule.
    expect(answer?.models?.map((m) => m.value)).toEqual(["gpt-9"]);
  });

  it("lets a SETTLED empty answer replace a non-empty one", async () => {
    listProviderModels.mockResolvedValue([{ id: "gpt-9" }]);
    useLiveModelStore.getState().ensureFresh("api-openai");
    await settle();

    listProviderModels.mockResolvedValue([]);
    useLiveModelStore.getState().ensureFresh("api-openai", { force: true });
    await settle();

    const answer = useLiveModelStore.getState().answerFor("api-openai");
    expect(answer?.status).toBe("ready");
    expect(answer?.models).toEqual([]);
  });

  it("classifies a rejected key apart from an absent one", async () => {
    // These are the TAGGED strings the Rust command actually rejects with
    // (`"<kind>: <message>"`), not prose. Classification reads the tag, so
    // feeding it English here would test a sniffer that no longer exists —
    // and would keep passing while the real contract broke.
    listProviderModels.mockRejectedValue(new Error("unauthorized: rejected by minimax"));
    useLiveModelStore.getState().ensureFresh("api-minimax");
    await settle();
    expect(useLiveModelStore.getState().answerFor("api-minimax")?.status).toBe("unauthorized");

    useLiveModelStore.getState().reset();
    listProviderModels.mockRejectedValue(
      new Error("no-key: No API key configured for minimax."),
    );
    useLiveModelStore.getState().ensureFresh("api-minimax");
    await settle();
    expect(useLiveModelStore.getState().answerFor("api-minimax")?.status).toBe("no-key");
  });

  it("does not fetch for providers with their own producer", async () => {
    // Ollama and the custom endpoint converge on the seam's row builder and
    // precedence, not on this cache — their producers carry metadata the
    // generic DTO cannot express.
    useLiveModelStore.getState().ensureFresh("api-ollama");
    useLiveModelStore.getState().ensureFresh("api-custom");
    // …and neither for a PTY agent, which has no provider at all.
    useLiveModelStore.getState().ensureFresh("claude-code");
    await settle();
    expect(listProviderModels).not.toHaveBeenCalled();
  });

  it("invalidates a vendor so the next ask re-fetches", async () => {
    listProviderModels.mockResolvedValue([{ id: "gpt-9" }]);
    useLiveModelStore.getState().ensureFresh("api-openai");
    await settle();
    useLiveModelStore.getState().invalidate("openai");
    expect(useLiveModelStore.getState().answerFor("api-openai")).toBeUndefined();
    useLiveModelStore.getState().ensureFresh("api-openai");
    await settle();
    expect(listProviderModels).toHaveBeenCalledTimes(2);
  });
});


describe("provider configuration changes", () => {
  it("does not let an old endpoint response overwrite a refreshed catalog", async () => {
    let finishOld!: (models: { id: string }[]) => void;
    listProviderModels.mockImplementationOnce(() => new Promise((resolve) => { finishOld = resolve; }));
    useLiveModelStore.getState().ensureFresh("api-sugar");
    useLiveModelStore.getState().invalidate("sugar");
    listProviderModels.mockResolvedValueOnce([{ id: "new-endpoint/model" }]);
    useLiveModelStore.getState().ensureFresh("api-sugar");
    await settle();
    finishOld([{ id: "old-endpoint/model" }]);
    await settle();
    expect(useLiveModelStore.getState().answerFor("api-sugar")?.models?.map((m) => m.value)).toEqual(["new-endpoint/model"]);
  });

  it.each(["sugar", "cline-pass", "opencode-go", "ollama-cloud", "google", "xai"])("loads current %s models through the shared cache", async (provider) => {
    listProviderModels.mockResolvedValue([{ id: "newly-published-model" }]);
    useLiveModelStore.getState().ensureFresh(`api-${provider}`);
    await settle();
    expect(listProviderModels).toHaveBeenCalledWith(provider);
    expect(useLiveModelStore.getState().answerFor(`api-${provider}`)?.models?.[0].value).toBe("newly-published-model");
  });
});
