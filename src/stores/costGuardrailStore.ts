import { create } from "zustand";
import { storageKey } from "@/lib/brand";
import { readUsageAnalytics } from "@/lib/tauri";
import { useFlightStore } from "@/stores/flightStore";
import type { AnalyticsData } from "@/stores/analyticsStore";
import type { AgentConversation } from "@/types/agent-conversation";
import { sessionCostUsd } from "@/lib/sessionCost";
import {
  DEFAULT_COST_GUARDRAIL_SETTINGS,
  costGuardrailKey,
  evaluateCostGuardrail,
  evaluationMessage,
  normalizeCostGuardrailSettings,
  providerCost,
  providerSourceForAgentProvider,
  type CostGuardrailEvaluation,
  type CostGuardrailSettings,
} from "@/lib/costGuardrails";

const STORAGE_KEY = storageKey("cost-guardrails");
const OVERRIDE_MS = 24 * 60 * 60 * 1000;

interface CostGuardrailStore extends CostGuardrailSettings {
  setDailyLimit: (limit: number | null) => void;
  setGlobalMonthlyLimit: (limit: number | null) => void;
  setSessionLimit: (limit: number | null) => void;
  setProviderLimit: (source: string, limit: number | null) => void;
  setFlightLimit: (flightId: string, limit: number | null) => void;
  setWarningThreshold: (percent: number) => void;
  grantOverride: (key: string, now?: number) => void;
  clearOverride: (key: string) => void;
  hasActiveOverride: (key: string, now?: number) => boolean;
  hydrateFromStorage: () => void;
  evaluateAnalytics: (
    data: AnalyticsData,
    providerSource?: string | null,
  ) => CostGuardrailEvaluation[];
}

function cleanLimit(value: number | null | undefined): number | null {
  if (value == null) return null;
  if (!Number.isFinite(value) || value <= 0) return null;
  return Math.round(value * 100) / 100;
}

function loadSettings(): CostGuardrailSettings {
  if (typeof localStorage === "undefined") {
    return normalizeCostGuardrailSettings(DEFAULT_COST_GUARDRAIL_SETTINGS);
  }

  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return normalizeCostGuardrailSettings(DEFAULT_COST_GUARDRAIL_SETTINGS);
    return normalizeCostGuardrailSettings(JSON.parse(raw) as Partial<CostGuardrailSettings>);
  } catch {
    return normalizeCostGuardrailSettings(DEFAULT_COST_GUARDRAIL_SETTINGS);
  }
}

function persist(settings: CostGuardrailSettings) {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // Settings are best-effort; runtime state still updates.
  }
}

function analyticsTodayCost(data: AnalyticsData): number {
  if (typeof data.todayCostUsd === "number" && Number.isFinite(data.todayCostUsd)) {
    return data.todayCostUsd;
  }
  const today = new Date().toISOString().slice(0, 10);
  return data.dailyCosts.find((day) => day.date === today)?.costUsd ?? 0;
}

export const useCostGuardrailStore = create<CostGuardrailStore>((set, get) => {
  const update = (patch: Partial<CostGuardrailSettings>) => {
    const next = normalizeCostGuardrailSettings({ ...get(), ...patch });
    set(next);
    persist(next);
  };

  return {
    ...loadSettings(),
    setDailyLimit: (limit) => update({ dailyLimitUsd: cleanLimit(limit) }),
    setGlobalMonthlyLimit: (limit) => update({ monthlyLimitUsd: cleanLimit(limit) }),
    setSessionLimit: (limit) => update({ sessionLimitUsd: cleanLimit(limit) }),
    setProviderLimit: (source, limit) => {
      const providerLimitsUsd = { ...get().providerLimitsUsd };
      const clean = cleanLimit(limit);
      if (clean === null) delete providerLimitsUsd[source];
      else providerLimitsUsd[source] = clean;
      update({ providerLimitsUsd });
    },
    setFlightLimit: (flightId, limit) => {
      const flightLimitsUsd = { ...get().flightLimitsUsd };
      const clean = cleanLimit(limit);
      if (clean === null) delete flightLimitsUsd[flightId];
      else flightLimitsUsd[flightId] = clean;
      update({ flightLimitsUsd });
    },
    setWarningThreshold: (percent) => update({ warningThresholdPercent: percent }),
    grantOverride: (key, now = Date.now()) => {
      update({
        overrideUntilByKey: {
          ...get().overrideUntilByKey,
          [key]: now + OVERRIDE_MS,
        },
      });
    },
    clearOverride: (key) => {
      const overrideUntilByKey = { ...get().overrideUntilByKey };
      delete overrideUntilByKey[key];
      update({ overrideUntilByKey });
    },
    hasActiveOverride: (key, now = Date.now()) => {
      const until = get().overrideUntilByKey[key];
      return Boolean(until && until > now);
    },
    hydrateFromStorage: () => {
      set(loadSettings());
    },
    evaluateAnalytics: (data, providerSource) => {
      const state = get();
      const out: CostGuardrailEvaluation[] = [
        evaluateCostGuardrail({
          key: costGuardrailKey.daily,
          label: "Daily spend",
          currentUsd: analyticsTodayCost(data),
          limitUsd: state.dailyLimitUsd,
          warningRatio: state.warningThresholdPercent / 100,
          hardStopRatio: state.hardStopThresholdPercent / 100,
          overrideUntil: state.overrideUntilByKey[costGuardrailKey.daily],
        }),
        evaluateCostGuardrail({
          key: costGuardrailKey.monthly,
          label: "Global monthly spend",
          currentUsd: data.currentMonthCostUsd ?? data.totalCostUsd,
          limitUsd: state.monthlyLimitUsd,
          warningRatio: state.warningThresholdPercent / 100,
          hardStopRatio: state.hardStopThresholdPercent / 100,
          overrideUntil: state.overrideUntilByKey[costGuardrailKey.monthly],
        }),
      ];

      if (providerSource) {
        out.push(
          evaluateCostGuardrail({
            key: costGuardrailKey.provider(providerSource),
            label: `${providerSource} spend`,
            currentUsd: providerCost(data, providerSource),
            limitUsd: state.providerLimitsUsd[providerSource] ?? null,
            warningRatio: state.warningThresholdPercent / 100,
            hardStopRatio: state.hardStopThresholdPercent / 100,
            overrideUntil: state.overrideUntilByKey[costGuardrailKey.provider(providerSource)],
          }),
        );
      }

      return out;
    },
  };
});

export async function assertCostGuardrailsAllowLaunch(
  provider: string,
  flightId?: string | null,
  conversation?: AgentConversation,
): Promise<void> {
  flightId ??= conversation && useFlightStore.getState().flights.find((flight) =>
    flight.attempts?.some((attempt) => attempt.sessionId === conversation.id),
  )?.id;
  useCostGuardrailStore.getState().hydrateFromStorage();
  const state = useCostGuardrailStore.getState();
  const providerSource = providerSourceForAgentProvider(provider);
  const hasAnyCap =
    state.dailyLimitUsd !== null ||
    state.monthlyLimitUsd !== null ||
    state.sessionLimitUsd !== null ||
    state.providerLimitsUsd[providerSource] !== undefined ||
    (flightId ? state.flightLimitsUsd[flightId] !== undefined : false);
  if (!hasAnyCap) return;

  const data = JSON.parse(await readUsageAnalytics()) as AnalyticsData;
  const evaluations = state.evaluateAnalytics(data, providerSource);
  evaluations.push(
    evaluateCostGuardrail({
      key: costGuardrailKey.session,
      label: "Current session spend",
      currentUsd: conversation ? sessionCostUsd(conversation, data.sessionCostsById) : 0,
      limitUsd: state.sessionLimitUsd,
      warningRatio: state.warningThresholdPercent / 100,
      hardStopRatio: state.hardStopThresholdPercent / 100,
      overrideUntil: state.overrideUntilByKey[costGuardrailKey.session],
    }),
  );
  if (flightId) {
    const flight = useFlightStore.getState().flights.find((f) => f.id === flightId);
    evaluations.push(
      evaluateCostGuardrail({
        key: costGuardrailKey.flight(flightId),
        label: `Flight ${flight?.title ?? flightId}`,
        currentUsd: flight?.totalCost ?? 0,
        limitUsd: state.flightLimitsUsd[flightId] ?? null,
        warningRatio: state.warningThresholdPercent / 100,
        hardStopRatio: state.hardStopThresholdPercent / 100,
        overrideUntil: state.overrideUntilByKey[costGuardrailKey.flight(flightId)],
      }),
    );
  }

  const blocked = evaluations.find((evaluation) => evaluation.status === "blocked");
  if (blocked) {
    throw new Error(evaluationMessage(blocked));
  }
}
