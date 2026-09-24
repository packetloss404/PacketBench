import { create } from "zustand";
import { readUsageAnalytics } from "@/lib/tauri";
import { storageKey } from "@/lib/brand";
import {
  computeCostGuardrailStatus,
  DEFAULT_COST_GUARDRAIL_SETTINGS,
  evaluationMessage,
  normalizeCostGuardrailSettings,
  type CostGuardrailScope,
  type CostGuardrailScopeStatus,
  type CostGuardrailStatus,
  type CostGuardrailSettings,
  type CostPricingStatus,
} from "@/lib/costGuardrails";
import { notifyCostThreshold } from "@/lib/notifications";
import { sessionCostUsd } from "@/lib/sessionCost";

export interface ModelUsage {
  model: string;
  sessions: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  source: string;
  pricingStatus?: CostPricingStatus;
}

export interface DailyCost {
  date: string;
  costUsd: number;
}

export interface AnalyticsData {
  sessionCostsById?: Record<string, number>;
  totalCostUsd: number;
  totalSessions: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  modelUsage: ModelUsage[];
  dailyCosts: DailyCost[];
  todayCostUsd?: number;
  currentMonthCostUsd?: number;
  unknownPricingModelUsage?: ModelUsage[];
}

interface AnalyticsStore {
  data: AnalyticsData | null;
  loading: boolean;
  error: string | null;
  guardrailSettings: CostGuardrailSettings;
  guardrailStatus: CostGuardrailStatus;
  sessionCostsById: Record<string, number>;
  load: () => Promise<void>;
  updateGuardrailSettings: (patch: Partial<CostGuardrailSettings>) => void;
  resetGuardrailSettings: () => void;
}

const GUARDRAIL_STORAGE_KEY = storageKey("cost-guardrails");

const initialGuardrailSettings = loadGuardrailSettings();

export const useAnalyticsStore = create<AnalyticsStore>((set, get) => ({
  data: null,
  loading: false,
  error: null,
  guardrailSettings: initialGuardrailSettings,
  guardrailStatus: computeCostGuardrailStatus(null, initialGuardrailSettings),
  sessionCostsById: {},
  load: async () => {
    set({ loading: true, error: null });
    try {
      const raw = await readUsageAnalytics();
      const parsed = JSON.parse(raw) as AnalyticsData;
      const settings = get().guardrailSettings;
      let sessionCostsById: Record<string, number> = {};
      if (settings.sessionLimitUsd !== null) {
        const { useAgentTaskStore } = await import("@/stores/agentTaskStore");
        sessionCostsById = Object.fromEntries(
          useAgentTaskStore
            .getState()
            .conversations.filter(
              (conversation) => conversation.mode === "api" && !conversation.archived,
            )
            .map((conversation) => [
              conversation.id,
              sessionCostUsd(conversation, parsed.sessionCostsById),
            ]),
        );
      }
      const guardrailStatus = computeCostGuardrailStatus(parsed, settings, { sessionCostsById });
      set({
        data: parsed,
        guardrailStatus,
        sessionCostsById,
        loading: false,
      });
      // Proactive cost-threshold notifications: fired here (on the
      // `startCostGuardrailMonitor` poll cadence, not a render path) so alerts
      // surface regardless of which view is mounted.
      void fireGuardrailTransitions(guardrailStatus, settings).catch((error) => {
        console.warn("Cost threshold notification failed:", error);
      });
    } catch (err) {
      set({
        error: err instanceof Error ? err.message : String(err),
        loading: false,
      });
    }
  },
  updateGuardrailSettings: (patch) => {
    set((state) => {
      const next = normalizeCostGuardrailSettings({ ...state.guardrailSettings, ...patch });
      saveGuardrailSettings(next);
      return {
        guardrailSettings: next,
        guardrailStatus: computeCostGuardrailStatus(state.data, next, {
          sessionCostsById: state.sessionCostsById,
        }),
      };
    });
  },
  resetGuardrailSettings: () => {
    const next = { ...DEFAULT_COST_GUARDRAIL_SETTINGS };
    saveGuardrailSettings(next);
    set({
      guardrailSettings: next,
      guardrailStatus: computeCostGuardrailStatus(get().data, next, {
        sessionCostsById: get().sessionCostsById,
      }),
    });
  },
}));

/**
 * Background refresh cadence for the guardrail data source.
 *
 * This poll used to be owned by `LiveSpendChip`, which was removed with the
 * rest of the cost REPORTING surface on 2026-07-31. The guardrails are a
 * safety mechanism, not reporting, so the poll moved here and is started once
 * from `bootstrap` — otherwise threshold notifications would silently stop
 * firing and only the pre-launch hard-stop would remain.
 */
const GUARDRAIL_POLL_MS = 60_000;

let guardrailMonitorStarted = false;

/**
 * Start the app-lifetime guardrail poll. Idempotent: a re-entrant
 * `initializeApp` (StrictMode double-mount) will not stack intervals.
 */
export function startCostGuardrailMonitor(): void {
  if (guardrailMonitorStarted) return;
  guardrailMonitorStarted = true;
  void useAnalyticsStore.getState().load();
  setInterval(() => {
    void useAnalyticsStore.getState().load();
  }, GUARDRAIL_POLL_MS);
}

function loadGuardrailSettings(): CostGuardrailSettings {
  const storage = getLocalStorage();
  if (!storage) return { ...DEFAULT_COST_GUARDRAIL_SETTINGS };

  const raw = storage.getItem(GUARDRAIL_STORAGE_KEY);
  if (!raw) return { ...DEFAULT_COST_GUARDRAIL_SETTINGS };

  try {
    return normalizeCostGuardrailSettings(JSON.parse(raw) as Partial<CostGuardrailSettings>);
  } catch {
    return { ...DEFAULT_COST_GUARDRAIL_SETTINGS };
  }
}

function saveGuardrailSettings(settings: CostGuardrailSettings): void {
  const storage = getLocalStorage();
  if (!storage) return;
  storage.setItem(GUARDRAIL_STORAGE_KEY, JSON.stringify(settings));
}

function getLocalStorage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

// Per-scope last-seen guardrail level, kept in-memory across polls so a
// steady "warning"/"limit" doesn't re-notify every poll — only upward
// transitions fire. Unseen scopes are treated as "ok".
type TrackedLevel = CostGuardrailScopeStatus["level"];
const LEVEL_RANK: Record<TrackedLevel, number> = { ok: 0, warning: 1, limit: 2 };
const lastGuardrailLevelByScope: Record<string, TrackedLevel> = {};
const pendingGuardrailScopes = new Set<string>();

function scopeLabel(scope: CostGuardrailScope): string {
  if (scope === "daily") return "Daily spend";
  if (scope === "monthly") return "Global monthly spend";
  if (scope === "session") return "Current session spend";
  if (scope.startsWith("session:")) return "Conversation spend";
  if (scope.startsWith("provider:")) return `${scope.slice("provider:".length)} spend`;
  if (scope.startsWith("flight:")) return `Flight ${scope.slice("flight:".length)}`;
  return scope;
}

async function fireGuardrailTransitions(
  status: CostGuardrailStatus,
  settings: CostGuardrailSettings,
): Promise<void> {
  const warningRatio = settings.warningThresholdPercent / 100;
  for (const scope of status.scopes) {
    const prev = lastGuardrailLevelByScope[scope.scope] ?? "ok";
    // A first observation above the threshold is actionable too. Record it
    // only after delivery, so disabled/focused/denied notifications can retry.
    const isUpward = LEVEL_RANK[scope.level] > LEVEL_RANK[prev] && scope.level !== "ok";
    if (!isUpward) {
      lastGuardrailLevelByScope[scope.scope] = scope.level;
      continue;
    }
    if (pendingGuardrailScopes.has(scope.scope)) continue;

    const message = evaluationMessage({
      key: scope.scope,
      label: scopeLabel(scope.scope),
      currentUsd: scope.spendUsd,
      limitUsd: scope.limitUsd,
      warningUsd: scope.limitUsd * warningRatio,
      // `scopeStatus` reached "limit" via `hardStopThresholdPercent`, so the
      // notification names the same stop the launch gate would refuse at.
      hardStopUsd: scope.limitUsd * (settings.hardStopThresholdPercent / 100),
      percentUsed: scope.percentUsed,
      status: scope.level === "limit" ? "blocked" : "warning",
      overrideActive: false,
    });
    // Only advance the stored level if the notification was actually
    // delivered. If it was suppressed (focus, debounce, disabled, denied),
    // hold the old level so the next poll retries instead of consuming the
    // transition silently.
    pendingGuardrailScopes.add(scope.scope);
    try {
      const delivered = await notifyCostThreshold(scope.scope, message);
      if (delivered) {
        lastGuardrailLevelByScope[scope.scope] = scope.level;
      }
    } finally {
      pendingGuardrailScopes.delete(scope.scope);
    }
  }

  // Prune scopes that no longer exist (dynamic flight:*/provider:* scopes come
  // and go) so the map can't grow unbounded across a long session.
  const current = new Set<string>(status.scopes.map((s) => s.scope));
  for (const key of Object.keys(lastGuardrailLevelByScope)) {
    if (!current.has(key)) delete lastGuardrailLevelByScope[key];
  }
}
