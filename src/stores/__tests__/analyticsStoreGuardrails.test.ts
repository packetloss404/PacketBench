import { beforeEach, describe, expect, it, vi } from "vitest";
import { storageKey } from "@/lib/brand";
import { computeCostGuardrailStatus, normalizeCostGuardrailSettings } from "@/lib/costGuardrails";
import type { AnalyticsData } from "../analyticsStore";
import type { AgentConversation } from "@/types/agent-conversation";

const sessions = vi.hoisted(() => ({ conversations: [] as AgentConversation[] }));
const notifyCostThreshold = vi.hoisted(() => vi.fn());
vi.mock("@/lib/notifications", () => ({ notifyCostThreshold }));
vi.mock("@/stores/agentTaskStore", () => ({ useAgentTaskStore: { getState: () => sessions } }));

const invokeMock = vi.fn();

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

const SETTINGS_KEY = storageKey("cost-guardrails");

function analytics(overrides: Partial<AnalyticsData> = {}): AnalyticsData {
  return {
    totalCostUsd: 0,
    totalSessions: 0,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    modelUsage: [],
    dailyCosts: [],
    todayCostUsd: 0,
    currentMonthCostUsd: 0,
    unknownPricingModelUsage: [],
    ...overrides,
  };
}

async function loadStore() {
  vi.resetModules();
  return import("../analyticsStore");
}

describe("cost guardrails", () => {
  beforeEach(() => {
    localStorage.clear();
    invokeMock.mockReset();
    sessions.conversations = [];
    notifyCostThreshold.mockReset().mockResolvedValue(true);
  });

  it("computes warning and hard-limit states from daily spend", () => {
    const settings = normalizeCostGuardrailSettings({ dailyLimitUsd: 10 });
    const warning = computeCostGuardrailStatus(analytics({ todayCostUsd: 8 }), settings, {
      now: new Date("2026-05-28T12:00:00Z"),
    });
    const limit = computeCostGuardrailStatus(analytics({ todayCostUsd: 10.25 }), settings, {
      now: new Date("2026-05-28T12:00:00Z"),
    });

    expect(warning.level).toBe("warning");
    expect(warning.activeScope?.scope).toBe("daily");
    expect(warning.requiresApproval).toBe(false);
    expect(limit.level).toBe("limit");
    expect(limit.requiresApproval).toBe(true);
    expect(limit.canOverride).toBe(true);
  });

  it("computes monthly limits from the backend monthly aggregate", () => {
    const status = computeCostGuardrailStatus(
      analytics({ currentMonthCostUsd: 51 }),
      normalizeCostGuardrailSettings({ monthlyLimitUsd: 50 }),
    );

    expect(status.level).toBe("limit");
    expect(status.activeScope).toMatchObject({
      scope: "monthly",
      spendUsd: 51,
      limitUsd: 50,
    });
  });

  it("surfaces unknown pricing as distinct from free usage", () => {
    const unknownUsage = {
      source: "codex",
      model: "future-model-x",
      sessions: 1,
      inputTokens: 1000,
      outputTokens: 500,
      costUsd: 0,
      pricingStatus: "unknown" as const,
    };
    const status = computeCostGuardrailStatus(
      analytics({
        modelUsage: [unknownUsage],
        unknownPricingModelUsage: [unknownUsage],
      }),
      normalizeCostGuardrailSettings({ dailyLimitUsd: 10 }),
    );

    expect(status.level).toBe("unknown_pricing");
    expect(status.hasUnknownPricing).toBe(true);
    expect(status.unknownPricingModelUsage).toEqual([unknownUsage]);
  });

  it("persists guardrail settings and recomputes status after analytics load", async () => {
    invokeMock.mockResolvedValueOnce(JSON.stringify(analytics({ todayCostUsd: 8.5 })));

    const { useAnalyticsStore } = await loadStore();
    useAnalyticsStore.getState().updateGuardrailSettings({
      dailyLimitUsd: 10,
      warningThresholdPercent: 70,
    });

    expect(JSON.parse(localStorage.getItem(SETTINGS_KEY)!)).toMatchObject({
      dailyLimitUsd: 10,
      warningThresholdPercent: 70,
      hardStopThresholdPercent: 100,
    });

    await useAnalyticsStore.getState().load();

    expect(useAnalyticsStore.getState().guardrailStatus.level).toBe("warning");

    const reloaded = await loadStore();
    expect(reloaded.useAnalyticsStore.getState().guardrailSettings).toMatchObject({
      dailyLimitUsd: 10,
      warningThresholdPercent: 70,
    });
  });

  it("monitors each conversation using durable usage, without double-counting it in the daily snapshot", async () => {
    const { useAnalyticsStore } = await loadStore();
    sessions.conversations = [
      {
        id: "a",
        mode: "api",
        model: "new-model",
        messages: [{ role: "assistant", costUsd: 2 }],
      } as AgentConversation,
    ];
    useAnalyticsStore.getState().updateGuardrailSettings({ sessionLimitUsd: 2.5 });
    invokeMock.mockResolvedValue(
      JSON.stringify(analytics({ todayCostUsd: 3, sessionCostsById: { a: 3 } })),
    );
    await useAnalyticsStore.getState().load();
    expect(useAnalyticsStore.getState().guardrailStatus.activeScope).toMatchObject({
      scope: "session:a",
      spendUsd: 3,
      level: "limit",
    });
    expect(useAnalyticsStore.getState().guardrailStatus.snapshot.todayUsd).toBe(3);
    useAnalyticsStore.getState().updateGuardrailSettings({ sessionLimitUsd: 4 });
    expect(useAnalyticsStore.getState().guardrailStatus.scopes).toContainEqual(
      expect.objectContaining({ scope: "session:a", spendUsd: 3 }),
    );
  });

  it("notifies an already-exceeded budget on first observation only once, then reports escalation", async () => {
    const { useAnalyticsStore } = await loadStore();
    useAnalyticsStore.getState().updateGuardrailSettings({ dailyLimitUsd: 10 });
    invokeMock.mockResolvedValue(JSON.stringify(analytics({ todayCostUsd: 8.5 })));
    await useAnalyticsStore.getState().load();
    await vi.waitFor(() =>
      expect(notifyCostThreshold).toHaveBeenCalledWith("daily", expect.stringContaining("warning")),
    );
    await useAnalyticsStore.getState().load();
    expect(notifyCostThreshold).toHaveBeenCalledTimes(1);
    invokeMock.mockResolvedValue(JSON.stringify(analytics({ todayCostUsd: 11 })));
    await useAnalyticsStore.getState().load();
    await vi.waitFor(() => expect(notifyCostThreshold).toHaveBeenCalledTimes(2));
    expect(notifyCostThreshold).toHaveBeenLastCalledWith(
      "daily",
      expect.stringContaining("$11.00"),
    );
  });

  it("retries suppressed first-observation alerts without duplicating an in-flight notification", async () => {
    const { useAnalyticsStore } = await loadStore();
    useAnalyticsStore.getState().updateGuardrailSettings({ sessionLimitUsd: 2 });
    sessions.conversations = [
      { id: "new", mode: "api", model: "test", messages: [] } as unknown as AgentConversation,
    ];
    invokeMock.mockResolvedValue(JSON.stringify(analytics({ sessionCostsById: { new: 3 } })));
    let complete!: (delivered: boolean) => void;
    notifyCostThreshold.mockReturnValueOnce(
      new Promise<boolean>((resolve) => {
        complete = resolve;
      }),
    );
    await useAnalyticsStore.getState().load();
    await useAnalyticsStore.getState().load();
    expect(notifyCostThreshold).toHaveBeenCalledTimes(1);
    complete(false);
    await Promise.resolve();
    await useAnalyticsStore.getState().load();
    await vi.waitFor(() => expect(notifyCostThreshold).toHaveBeenCalledTimes(2));
    expect(notifyCostThreshold).toHaveBeenLastCalledWith(
      "session:new",
      expect.stringContaining("$3.00"),
    );
    await useAnalyticsStore.getState().load();
    expect(notifyCostThreshold).toHaveBeenCalledTimes(2);
  });
});
