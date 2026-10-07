/**
 * The live-model seam — one registry, one row builder, one precedence rule.
 *
 * These assertions exist because the three things this module unified had each
 * drifted: `ModelSelector`, `LaunchAsyncFlightModal` and `ProviderRoutingCard`
 * carried three different live/static precedence rules, and `ModelSelector` and
 * `agentCapabilities` disagreed outright about what an empty list MEANS. The
 * `[]` cases below are therefore the load-bearing ones: they pin the ruling
 * (emptiness counts only when it is an ANSWER) so re-collapsing the two empties
 * fails here rather than in a picker three releases later.
 */
import { describe, expect, it } from "vitest";
import { API_PROVIDERS, type ApiModel } from "@/lib/api-models";
import {
  classifyLiveModelError,
  liveModelRow,
  providerEnumeratesLive,
  resolveModelRows,
  LIVE_MODEL_PROVIDERS,
} from "@/lib/liveModels";
import type { AgentCli } from "@/stores/agentTaskStore";

const catalogFor = (agent: AgentCli): ApiModel[] =>
  API_PROVIDERS.find((p) => p.agentCli === agent)?.models ?? [];

describe("liveModels — the registry", () => {
  it("registers every API provider row, and nothing else", () => {
    // The registry replaced a hardcoded exemption list in `ModelSelector`
    // that had already drifted from the set of providers that actually
    // enumerate. Every
    // catalog row is live-capable; nothing outside the catalog is.
    for (const provider of API_PROVIDERS) {
      expect(providerEnumeratesLive(provider.agentCli), provider.agentCli).toBe(true);
    }
    expect(providerEnumeratesLive("claude-code" as AgentCli)).toBe(false);
    // A retired id keeps no registry entry — it must not acquire a picker.
    expect(providerEnumeratesLive("api-openai-codex" as AgentCli)).toBe(false);
  });

  it("shares one cache key between rows that enumerate the same account", () => {
    // Both Claude rows and both OpenAI rows read the same vendor account, so a
    // per-ROW key would double every round trip for no extra information.
    expect(LIVE_MODEL_PROVIDERS["api-claude"]?.provider).toBe(
      LIVE_MODEL_PROVIDERS["api-claude-oauth"]?.provider,
    );
    expect(LIVE_MODEL_PROVIDERS["api-openai"]?.provider).toBe(
      LIVE_MODEL_PROVIDERS["api-openai-agents"]?.provider,
    );
  });

  it("gives the local providers a short TTL and the cloud ones a long one", () => {
    // `ollama pull` should show up almost immediately; a cloud catalog changes
    // on the order of weeks and must not be re-fetched on every picker open.
    const ollama = LIVE_MODEL_PROVIDERS["api-ollama"]!;
    const anthropic = LIVE_MODEL_PROVIDERS["api-claude"]!;
    expect(ollama.ttlMs).toBeLessThan(anthropic.ttlMs);
  });
});

describe("liveModels — the shared row builder", () => {
  it("stamps context and pricing from the shared tables", () => {
    const row = liveModelRow({ id: "claude-opus-5" });
    expect(row.value).toBe("claude-opus-5");
    expect(row.contextWindow).toBeGreaterThan(0);
    expect(row.pricing).toBeTruthy();
  });

  it("prefers what the PROVIDER reported over the bundled tables", () => {
    // The vendor is the authority on its own model, and a brand-new id is
    // exactly the case our tables cannot answer.
    const row = liveModelRow({
      id: "claude-opus-5",
      displayName: "Opus 5 (live)",
      contextWindow: 12_345,
      inputPerMTok: 1,
      outputPerMTok: 2,
    });
    expect(row.label).toBe("Opus 5 (live)");
    expect(row.contextWindow).toBe(12_345);
    expect(row.pricing).toEqual({ input: 1, output: 2 });
  });

  it("keeps the zero-rate guard — a free model is unpriced, not $0", () => {
    expect(liveModelRow({ id: "some-local-model", inputPerMTok: 0, outputPerMTok: 0 }).pricing)
      .toBeUndefined();
  });

  it("still resolves a context window for an id nothing has heard of", () => {
    // `getModelContextWindow` falls through to the field median, so a live row
    // is never LESS informative than a catalog row.
    expect(liveModelRow({ id: "brand-new-model-2027" }).contextWindow).toBeGreaterThan(0);
  });
});

describe("liveModels — precedence, and the `[]` ruling", () => {
  it("prefers a session-authoritative list over the bundled catalog", () => {
    const engineRows = [liveModelRow({ id: "glm-4.7" })];
    const resolved = resolveModelRows({ agent: "api-claude", authoritative: engineRows });
    expect(resolved.rows).toEqual(engineRows);
    expect(resolved.source).toBe("live");
  });

  it("lets an AUTHORITATIVE empty list override the catalog", () => {
    // A backend that was asked and named nothing has told us it serves none.
    // Offering bundled ids it may refuse is the silent no-op this seam exists
    // to prevent — this is `agentCapabilities`' original rule, generalised.
    const resolved = resolveModelRows({ agent: "api-claude", authoritative: [] });
    expect(resolved.rows).toEqual([]);
    expect(resolved.source).toBe("live");
    expect(resolved.notice).toBeTruthy();
  });

  it("does NOT let an absent answer empty the picker", () => {
    // `undefined` is "never asked / the ask failed". The catalog stands, which
    // is what keeps a failed fetch from taking an affordance away.
    const resolved = resolveModelRows({ agent: "api-claude" });
    expect(resolved.rows).toEqual(catalogFor("api-claude"));
    expect(resolved.source).toBe("bundled");
    // Nothing has gone wrong, so nothing is said.
    expect(resolved.notice).toBeNull();
  });

  it("lets a SETTLED empty enumeration override, but not a failed one", () => {
    expect(
      resolveModelRows({ agent: "api-claude", live: { status: "ready", models: [] } }).rows,
    ).toEqual([]);
    // A failure that never landed a list falls back.
    expect(
      resolveModelRows({ agent: "api-claude", live: { status: "failed", error: "boom" } }).rows,
    ).toEqual(catalogFor("api-claude"));
  });

  it("serves the last good list while a refresh runs behind it", () => {
    const previous = [liveModelRow({ id: "gpt-9" })];
    const resolved = resolveModelRows({
      agent: "api-openai",
      live: { status: "loading", models: previous },
    });
    expect(resolved.rows).toEqual(previous);
    expect(resolved.stale).toBe(true);
  });

  it("badges a bundled fallback, and distinguishes 'no key' from 'key rejected'", () => {
    // Two different problems, and the user can only fix the one they are told
    // about. Collapsing them produces the least actionable message in either
    // case.
    const noKey = resolveModelRows({ agent: "api-claude", live: { status: "no-key" } });
    const rejected = resolveModelRows({
      agent: "api-claude",
      live: { status: "unauthorized", error: "401" },
    });
    expect(noKey.rows).toEqual(catalogFor("api-claude"));
    expect(rejected.rows).toEqual(catalogFor("api-claude"));
    expect(noKey.notice).not.toEqual(rejected.notice);
    expect(noKey.notice).toBeTruthy();
    expect(rejected.notice).toBeTruthy();
  });

  it("reports 'none' for an agent with no list of any kind", () => {
    const resolved = resolveModelRows({ agent: "claude-code" as AgentCli });
    expect(resolved.rows).toEqual([]);
    expect(resolved.source).toBe("none");
    // The one case where a caller may legitimately unmount the picker.
    expect(resolved.enumeratesLive).toBe(false);
  });
});

describe("liveModels — error classification", () => {
  it("separates a missing key, a rejected key, and everything else", () => {
    // Classification reads the backend's TAG, not the prose. These assertions
    // used to feed English ("no api key configured", "401 Unauthorized") into
    // a substring sniffer; that broke the moment a provider phrased a
    // rejection differently or localised it, and MiniMax returns an auth
    // failure inside an HTTP 200 body which no status-string heuristic could
    // ever have caught.
    expect(classifyLiveModelError("no-key: Set one in Settings").status).toBe("no-key");
    expect(classifyLiveModelError("not-configured: No base URL").status).toBe("no-key");
    expect(classifyLiveModelError("unauthorized: rejected by openai").status).toBe(
      "unauthorized",
    );
    expect(classifyLiveModelError("network: ECONNREFUSED").status).toBe("failed");
    expect(classifyLiveModelError("credential-store: keyring locked").status).toBe("failed");
    expect(classifyLiveModelError("unsupported: no live catalog").status).toBe("unsupported");
  });

  it("treats an untagged failure as retryable rather than as a setup problem", () => {
    // A panic string or a Tauri transport error carries no tag. Guessing
    // "no-key" from prose would send the user to add a key they already have;
    // the retryable class is the safe default.
    expect(classifyLiveModelError(new Error("ECONNREFUSED")).status).toBe("failed");
    expect(classifyLiveModelError(new Error("no api key configured")).status).toBe("failed");
  });

  it("keeps the provider's own message for the surface to show", () => {
    // The tag is stripped; the human half survives intact.
    expect(classifyLiveModelError("unauthorized: invalid api key sk-…abc").message).toBe(
      "invalid api key sk-…abc",
    );
  });
});


it("surfaces discovery failures for a provider with no bundled fallback", () => {
  const resolved = resolveModelRows({ agent: "api-sugar", live: { status: "no-key", error: "Add your Sugar key in Settings" } });
  expect(resolved.rows).toEqual([]);
  expect(resolved.notice).toBe("Add your Sugar key in Settings");
});

it("does not label cloud-hosted local model names as free", () => {
  expect(liveModelRow({ id: "qwen3:32b" }, "ollama-cloud").pricing).toBeUndefined();
});
