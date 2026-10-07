import { describe, expect, it } from "vitest";
import {
  computeCostGuardrailStatus,
  evaluateCostGuardrail,
  evaluationMessage,
  isUnknownPricedUsage,
  normalizeCostGuardrailSettings,
  providerSourceForAgentProvider,
} from "@/lib/costGuardrails";

describe("cost guardrails", () => {
  it("marks 80 percent as warning and 100 percent as over budget", () => {
    const settings = normalizeCostGuardrailSettings({
      dailyLimitUsd: 10,
      monthlyLimitUsd: null,
      sessionLimitUsd: null,
      warningThresholdPercent: 80,
      hardStopThresholdPercent: 100,
      requireApprovalAtLimit: true,
    });
    const baseData = {
      totalCostUsd: 0,
      totalSessions: 0,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      modelUsage: [],
      dailyCosts: [],
    };

    expect(
      computeCostGuardrailStatus({ ...baseData, todayCostUsd: 7.99 }, settings).activeScope?.level,
    ).toBe("ok");
    expect(
      computeCostGuardrailStatus({ ...baseData, todayCostUsd: 8 }, settings).activeScope?.level,
    ).toBe("warning");
    expect(
      computeCostGuardrailStatus({ ...baseData, todayCostUsd: 10 }, settings).activeScope?.level,
    ).toBe("limit");
  });

  it("normalizes bad settings into bounded values", () => {
    expect(
      normalizeCostGuardrailSettings({
        dailyLimitUsd: Number.NaN,
        warningThresholdPercent: 999,
        hardStopThresholdPercent: 50,
      }),
    ).toEqual({
      dailyLimitUsd: null,
      monthlyLimitUsd: null,
      sessionLimitUsd: null,
      providerLimitsUsd: {},
      flightLimitsUsd: {},
      warningThresholdPercent: 100,
      hardStopThresholdPercent: 100,
      requireApprovalAtLimit: true,
      overrideUntilByKey: {},
    });
  });

  it("flags token usage that priced as zero for non-local models", () => {
    expect(
      isUnknownPricedUsage({
        source: "api-openai",
        model: "future-model",
        inputTokens: 1000,
        outputTokens: 1000,
        costUsd: 0,
      }),
    ).toBe(true);

    expect(
      isUnknownPricedUsage({
        source: "api-ollama",
        model: "llama3.3:70b",
        inputTokens: 1000,
        outputTokens: 1000,
        costUsd: 0,
      }),
    ).toBe(false);
  });

  it("collapses the retired minimax-api provider identity onto the canonical api-minimax source (P2-20)", () => {
    // `api-minimax-api` was a pure identity duplicate of `api-minimax` —
    // guardrail budgets persisted against the old id must keep resolving
    // to the same cost bucket after the consolidation.
    expect(providerSourceForAgentProvider("api-minimax")).toBe("api-minimax");
    expect(providerSourceForAgentProvider("minimax")).toBe("api-minimax");
    expect(providerSourceForAgentProvider("api-minimax-api")).toBe("api-minimax");
    expect(providerSourceForAgentProvider("minimax-api")).toBe("api-minimax");
  });

  /**
   * FAULT: Settings offers "Hard stop at % · Block launches at this share",
   * but the launch gate (`assertCostGuardrailsAllowLaunch` →
   * `evaluateCostGuardrail`) hard-coded its refusal at 100% of the cap and
   * never received the setting. The status/notification path already honoured
   * it, so the two halves of one control disagreed and the safety half was the
   * one that ignored the user.
   */
  describe("hard stop share", () => {
    const base = {
      key: "daily",
      label: "Daily spend",
      limitUsd: 10,
      warningRatio: 0.8,
    };

    it("blocks at the configured share, not only at the full cap", () => {
      const at85 = evaluateCostGuardrail({ ...base, currentUsd: 8.5, hardStopRatio: 0.85 });
      expect(at85.status).toBe("blocked");
      expect(at85.hardStopUsd).toBe(8.5);
      // Just below the stop is still only a warning.
      expect(evaluateCostGuardrail({ ...base, currentUsd: 8.4, hardStopRatio: 0.85 }).status).toBe(
        "warning",
      );
    });

    it("keeps the pre-existing behaviour when no share is given", () => {
      // The default (`hardStopThresholdPercent: 100`) must be byte-identical
      // to the old hard-coded rule, or every existing install changes.
      expect(evaluateCostGuardrail({ ...base, currentUsd: 9.99 }).status).toBe("warning");
      expect(evaluateCostGuardrail({ ...base, currentUsd: 10 }).status).toBe("blocked");
      expect(evaluateCostGuardrail({ ...base, currentUsd: 10, hardStopRatio: 1 }).status).toBe(
        "blocked",
      );
    });

    it("never lets the stop fall below the warning, which would hide the warning", () => {
      const evaluation = evaluateCostGuardrail({ ...base, currentUsd: 8, hardStopRatio: 0.5 });
      expect(evaluation.hardStopUsd).toBe(8);
    });

    it("still yields to an active override", () => {
      const evaluation = evaluateCostGuardrail({
        ...base,
        currentUsd: 9,
        hardStopRatio: 0.85,
        overrideUntil: 2_000,
        now: 1_000,
      });
      expect(evaluation.status).toBe("warning");
      expect(evaluation.overrideActive).toBe(true);
    });

    it("names the stop in the refusal when it is below the cap", () => {
      const message = evaluationMessage(
        evaluateCostGuardrail({ ...base, currentUsd: 9, hardStopRatio: 0.85 }),
      );
      expect(message).toContain("hard stop at $8.50");
      // At a full-cap stop the extra clause would be noise.
      expect(evaluationMessage(evaluateCostGuardrail({ ...base, currentUsd: 11 }))).not.toContain(
        "hard stop at",
      );
    });
  });
});


it("does not treat a cloud-hosted local model as free usage", () => {
  expect(isUnknownPricedUsage({ source: "api-ollama-cloud", model: "qwen3:32b", inputTokens: 10, outputTokens: 4, costUsd: 0, pricingStatus: "free" })).toBe(true);
});
