import { describe, expect, it } from "vitest";
import { API_PROVIDERS } from "@/lib/api-models";
import { pickFailoverModel } from "@/lib/autoFailover";
import { estimateTurnCostUsd, getModelRates } from "@/lib/conversationCost";
import { pricingStatusForModel } from "@/lib/modelPricing";
import type { AgentConversation } from "@/types/agent-conversation";

const catalogValues = new Set(
  API_PROVIDERS.flatMap((provider) => provider.models.map((model) => model.value)),
);

function conversationWithModel(model: string): AgentConversation {
  return {
    mode: "api",
    model,
    messages: [
      {
        id: "msg_1",
        role: "assistant",
        content: "ok",
        timestamp: 0,
        inputTokens: 1_000,
        outputTokens: 500,
      },
    ],
  } as AgentConversation;
}

describe("model metadata", () => {
  it("fails over within a LIVE list when the caller supplies one", () => {
    // `findProviderCatalog` scanned `API_PROVIDERS` for a provider containing
    // the current model and returned null when none did — so a session running
    // a live-enumerated, user-typed, or newly-published id matched nothing and
    // failover silently did not happen, at the one moment it exists for (a
    // 429). Handing the session's real list in fixes exactly that: neither id
    // below is in any bundled catalog.
    expect(
      pickFailoverModel("claude-opus-9-experimental", [
        "claude-opus-9-experimental",
        "claude-sonnet-9-experimental",
      ]),
    ).toBe("claude-sonnet-9-experimental");
    // And it still declines honestly when the live list offers no lower tier,
    // rather than inventing a bundled id the session cannot reach.
    expect(
      pickFailoverModel("claude-opus-9-experimental", ["claude-opus-9-experimental"]),
    ).toBeNull();
  });

  it("falls back to the bundled catalog when no live list is available", () => {
    // The pre-seam behaviour, unchanged for every caller that has nothing
    // better to offer.
    expect(pickFailoverModel("claude-opus-4-7", [])).toBe(pickFailoverModel("claude-opus-4-7"));
  });

  it("returns only catalog-backed failover models", () => {
    const fallbacks = [
      pickFailoverModel("claude-opus-4-7"),
      pickFailoverModel("claude-opus-4-6-20250415"),
      pickFailoverModel("anthropic/claude-opus-4-7"),
      pickFailoverModel("gpt-5.5"),
      pickFailoverModel("gpt-4o"),
      pickFailoverModel("MiniMax-M2.5"),
    ];

    for (const fallback of fallbacks) {
      expect(fallback).not.toBeNull();
      expect(catalogValues.has(fallback!)).toBe(true);
    }
  });

  it("can price fixed-price catalog models for usage accounting", () => {
    const fixedPriceModels = [...catalogValues].filter((model) => model !== "openrouter/auto");

    for (const model of fixedPriceModels) {
      const conversation = conversationWithModel(model);
      const message = conversation.messages[0];
      const estCost = estimateTurnCostUsd(model, message, message.timestamp);
      expect(estCost, model).not.toBeNull();
    }
  });

  it("sources every populated ApiModel.pricing from the single conversationCost rate table", () => {
    for (const provider of API_PROVIDERS) {
      for (const model of provider.models) {
        if (model.pricing === undefined) continue;
        expect(model.pricing, model.value).toEqual(getModelRates(model.value));
      }
    }
  });

  // Only the local Ollama engine is genuinely free. Every other catalog row is
  // a paid cloud route, so a "free" verdict there means a rate lookup fell
  // through to the $0 `local` row — the failure mode that let bare `qwen` /
  // `deepseek` / `codellama` prefixes swallow vendor-namespaced paid ids and
  // report $0. Budget guardrails read this status, so a wrong "free" here
  // means no guardrail ever fires. This gate matters most when the OpenRouter
  // row stops being a hardcoded handful and is enumerated live.
  it("marks no paid-provider catalog model as free", () => {
    for (const provider of API_PROVIDERS) {
      for (const model of provider.models) {
        const status = pricingStatusForModel(model.value);
        if (provider.id === "ollama") {
          expect(status, model.value).toBe("free");
        } else {
          expect(status, `${provider.id}/${model.value}`).not.toBe("free");
        }
      }
    }
  });
});
