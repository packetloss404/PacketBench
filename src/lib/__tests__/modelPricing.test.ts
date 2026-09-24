import { describe, expect, it } from "vitest";
import cases from "../../../shared/model-pricing-cases.json";
import {
  calculateCostUsd,
  candidatesFor,
  pricingStatusForModel,
  ratesForModel,
} from "@/lib/modelPricing";
import { estimateTurnCostUsd } from "@/lib/conversationCost";
import { sessionCostUsd } from "@/lib/sessionCost";
import type { AgentConversation } from "@/types/agent-conversation";

interface GoldenCase {
  name: string;
  model: string;
  at: string;
  tokens: {
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite5m?: number;
    cacheWrite1h?: number;
  };
  expectedUsd: number;
  /** `priced` | `free` | `unknown`. Mandatory when `expectedUsd` is 0. */
  expectedStatus?: string;
}

const goldenCases = (cases as { cases: GoldenCase[] }).cases;

describe("shared pricing table — cross-language golden cases", () => {
  // The Rust engine (src-tauri/src/commands/pricing.rs, tests::golden_cases_match)
  // runs this EXACT fixture. Rates cannot drift (one shared JSON table); this
  // proves the two implementations cannot drift either.
  it("has a non-trivial fixture", () => {
    expect(goldenCases.length).toBeGreaterThanOrEqual(20);
  });

  it.each(goldenCases)("$name", (testCase) => {
    const got = calculateCostUsd(testCase.model, testCase.tokens, testCase.at);
    expect(got).toBeCloseTo(testCase.expectedUsd, 9);
    if (testCase.expectedStatus !== undefined) {
      expect(pricingStatusForModel(testCase.model), testCase.model).toBe(testCase.expectedStatus);
    }
  });

  // A $0 cost is ambiguous on its own: it means `free` when a zero-rated row
  // matched and `unknown` when nothing did. Conflating the two is what let
  // vendor-namespaced paid routes be billed at $0 and labelled "free".
  it("makes every zero-cost case declare free vs unknown", () => {
    for (const testCase of goldenCases) {
      expect(
        testCase.expectedUsd !== 0 || testCase.expectedStatus !== undefined,
        `${testCase.name}: expectedUsd is 0 and must declare expectedStatus`,
      ).toBe(true);
    }
  });
});

describe("corrected rates (SPIKE-1, first-party Anthropic pricing 2026-07-31)", () => {
  it("prices current Opus at $5/$25, not the deprecated Opus 4.1 $15/$75", () => {
    for (const id of [
      "claude-opus-5",
      "claude-opus-4-8",
      "claude-opus-4-7",
      "claude-opus-4-6-20250415",
      "claude-opus-4-5",
    ]) {
      const rates = ratesForModel(id);
      expect(rates, id).not.toBeNull();
      expect(rates!.input, id).toBe(5);
      expect(rates!.output, id).toBe(25);
      expect(rates!.cacheRead, id).toBe(0.5);
      expect(rates!.cacheWrite5m, id).toBe(6.25);
      expect(rates!.cacheWrite1h, id).toBe(10);
    }
    expect(ratesForModel("claude-opus-4-1-20250805")!.input).toBe(15);
  });

  it("prices Haiku 4.5 at $1/$5, not the retired Haiku 3.5 $0.80/$4", () => {
    const h45 = ratesForModel("claude-haiku-4-5-20251001")!;
    expect([h45.input, h45.output]).toEqual([1, 5]);
    const h35 = ratesForModel("claude-3-5-haiku-20241022")!;
    expect([h35.input, h35.output]).toEqual([0.8, 4]);
  });

  it("prices the whole MiniMax M2 family at $0.30/$1.20", () => {
    for (const id of ["MiniMax-M2", "MiniMax-M2.5", "MiniMax-M2.7"]) {
      const rates = ratesForModel(id)!;
      expect([rates.input, rates.output], id).toEqual([0.3, 1.2]);
    }
    const m1 = ratesForModel("MiniMax-M1")!;
    expect([m1.input, m1.output]).toEqual([0.4, 2.2]);
  });
});

describe("date-scheduled rates", () => {
  it("applies Claude Sonnet 5 introductory pricing through 2026-08-31", () => {
    expect(ratesForModel("claude-sonnet-5", "2026-08-31")!.input).toBe(2);
    expect(ratesForModel("claude-sonnet-5", "2026-08-31")!.output).toBe(10);
  });

  it("applies the standard rate from 2026-09-01 with no human intervention", () => {
    expect(ratesForModel("claude-sonnet-5", "2026-09-01")!.input).toBe(3);
    expect(ratesForModel("claude-sonnet-5", "2027-05-05")!.output).toBe(15);
  });

  it("never reprices a historical turn", () => {
    // Same turn, priced at its own timestamp vs. priced today.
    const augustTurn = Date.UTC(2026, 7, 15);
    const cost = estimateTurnCostUsd(
      "claude-sonnet-5",
      { inputTokens: 1_000_000, outputTokens: 1_000_000 },
      augustTurn,
    );
    expect(cost).toBeCloseTo(12, 9);
    const septemberPrice = estimateTurnCostUsd(
      "claude-sonnet-5",
      { inputTokens: 1_000_000, outputTokens: 1_000_000 },
      Date.UTC(2026, 8, 15),
    );
    expect(septemberPrice).toBeCloseTo(18, 9);
  });

  it("prices each message in a conversation at its own timestamp", () => {
    const conv = {
      id: "conv_1",
      mode: "api",
      model: "claude-sonnet-5",
      messages: [
        {
          id: "m1",
          role: "assistant",
          content: "",
          timestamp: Date.UTC(2026, 7, 20),
          inputTokens: 1_000_000,
          outputTokens: 0,
        },
        {
          id: "m2",
          role: "assistant",
          content: "",
          timestamp: Date.UTC(2026, 8, 20),
          inputTokens: 1_000_000,
          outputTokens: 0,
        },
      ],
    } as unknown as AgentConversation;
    // $2 (August, introductory) + $3 (September, standard) — not 2x either.
    expect(sessionCostUsd(conv)).toBeCloseTo(5, 9);
  });
});

describe("cache-aware turn cost", () => {
  it("prices cache writes, which used to cost $0.00 in the UI", () => {
    const cost = estimateTurnCostUsd("claude-opus-4-8", {
      inputTokens: 0,
      outputTokens: 0,
      cacheWriteTokens: 1_000_000,
    });
    expect(cost).toBeCloseTo(6.25, 9);
  });

  it("prices Anthropic cache reads at the published 0.1x rate, not a blended 0.25x", () => {
    const cost = estimateTurnCostUsd("claude-opus-4-8", { cacheReadTokens: 1_000_000 });
    expect(cost).toBeCloseTo(0.5, 9);
  });

  it("does not subtract cache reads from Anthropic input (disjoint buckets)", () => {
    // Anthropic's input_tokens EXCLUDES cache reads: 100k fresh input must
    // still be billed even when 1M tokens were read from cache.
    const cost = estimateTurnCostUsd("claude-opus-4-8", {
      inputTokens: 100_000,
      cacheReadTokens: 1_000_000,
    });
    expect(cost).toBeCloseTo(0.5 + 0.5, 9);
  });

  it("does subtract cached tokens for vendors that report a superset", () => {
    // OpenAI's cached_tokens is a SUBSET of prompt tokens.
    const cost = estimateTurnCostUsd("gpt-5.5", {
      inputTokens: 1_000_000,
      cacheReadTokens: 400_000,
    });
    expect(cost).toBeCloseTo((600_000 / 1e6) * 5 + (400_000 / 1e6) * 2.5, 9);
  });

  it("bills reasoning tokens at the output rate", () => {
    const cost = estimateTurnCostUsd("gpt-5.5", { outputTokens: 0, reasoningTokens: 1_000_000 });
    expect(cost).toBeCloseTo(15, 9);
  });
});

describe("matching", () => {
  it("strips route prefixes and release-date suffixes in candidate order", () => {
    expect(candidatesFor("anthropic/Claude-Opus-4-8-20260101")).toEqual([
      "anthropic/claude-opus-4-8-20260101",
      "anthropic/claude-opus-4-8",
      "claude-opus-4-8-20260101",
      "claude-opus-4-8",
    ]);
  });

  it("keeps the meta-llama cloud route out of the free local row", () => {
    expect(pricingStatusForModel("meta-llama/llama-4-maverick")).toBe("priced");
    expect(pricingStatusForModel("llama3.3:70b")).toBe("free");
    expect(pricingStatusForModel("ollama/qwen3:32b")).toBe("free");
    expect(pricingStatusForModel("totally-unknown-model-xyz")).toBe("unknown");
  });

  it("keeps vendor-namespaced cloud routes out of the free local row", () => {
    // The bug this guards: the free `local` row's bare `qwen` / `deepseek` /
    // `codellama` prefixes matched straight through the `/`, so a PAID
    // namespaced route resolved to $0 and reported "free". Enumerating
    // OpenRouter live would have zero-rated hundreds of paid models, and the
    // reprice path could not rescue them — it only revisits models with NO
    // entry. `match.excludeNamespaced` on that row is what makes these unknown.
    for (const id of [
      "qwen/qwen3-max",
      "qwen/qwen3-coder",
      "deepseek/deepseek-r1",
      "deepseek/deepseek-chat",
      "codellama/CodeLlama-70b-Instruct-hf",
      "meta-llama/llama-3.3-70b-instruct",
    ]) {
      expect(ratesForModel(id), id).toBeNull();
      expect(pricingStatusForModel(id), id).toBe("unknown");
    }
  });

  it("still resolves genuinely local ids to free", () => {
    for (const id of [
      "llama3.3:70b",
      "qwen2.5-coder:7b",
      "deepseek-coder-v2",
      "codellama:34b",
      "ollama/qwen3:32b",
      "ollama:deepseek-r1:14b",
      "local/codellama:34b",
      "Llama3.3:70B",
    ]) {
      expect(pricingStatusForModel(id), id).toBe("free");
    }
  });

  it("still bills namespaced routes that have a row of their own", () => {
    expect(pricingStatusForModel("meta-llama/llama-4-maverick")).toBe("priced");
    expect(ratesForModel("anthropic/claude-sonnet-4-6")!.input).toBe(3);
    expect(ratesForModel("openai/gpt-5.5")!.input).toBe(5);
    expect(ratesForModel("google/gemini-2.5-pro")!.output).toBe(10);
  });

  it("returns null (not $0.00) for unknown models so callers can hide cost", () => {
    expect(ratesForModel("totally-unknown-model-xyz")).toBeNull();
    expect(estimateTurnCostUsd("totally-unknown-model-xyz", { inputTokens: 1_000_000 })).toBeNull();
    expect(calculateCostUsd("totally-unknown-model-xyz", { input: 1_000_000 })).toBe(0);
  });
});
