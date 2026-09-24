export type CostPricingStatus = "priced" | "free" | "unknown";
export type CostGuardrailLevel = "ok" | "warning" | "limit" | "unknown_pricing";
export type CostGuardrailScope =
  | "daily"
  | "monthly"
  | "session"
  | `session:${string}`
  | `provider:${string}`
  | `flight:${string}`;
export type CostGuardrailSnapshotState = "disabled" | "safe" | "warning" | "over";
export type CostGuardrailEvaluationStatus = "off" | "ok" | "warning" | "blocked";

export interface CostGuardrailSettings {
  dailyLimitUsd: number | null;
  monthlyLimitUsd: number | null;
  sessionLimitUsd: number | null;
  providerLimitsUsd: Record<string, number>;
  flightLimitsUsd: Record<string, number>;
  warningThresholdPercent: number;
  hardStopThresholdPercent: number;
  requireApprovalAtLimit: boolean;
  overrideUntilByKey: Record<string, number>;
  enabled?: boolean;
  dailyBudgetUsd?: number;
  warningPercent?: number;
}

export interface CostUsageLike {
  source: string;
  model: string;
  sessions?: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  pricingStatus?: CostPricingStatus;
}

interface AnalyticsLike {
  todayCostUsd?: number;
  currentMonthCostUsd?: number;
  dailyCosts: { date: string; costUsd: number }[];
  modelUsage: CostUsageLike[];
  unknownPricingModelUsage?: CostUsageLike[];
}

export interface CostGuardrailScopeStatus {
  scope: CostGuardrailScope;
  spendUsd: number;
  limitUsd: number;
  percentUsed: number;
  level: Exclude<CostGuardrailLevel, "unknown_pricing">;
}

export interface CostGuardrailStatus {
  level: CostGuardrailLevel;
  summary: string;
  requiresApproval: boolean;
  canOverride: boolean;
  snapshot: CostGuardrailSnapshot;
  scopes: CostGuardrailScopeStatus[];
  activeScope: CostGuardrailScopeStatus | null;
  hasUnknownPricing: boolean;
  unknownPricingModelUsage: CostUsageLike[];
}

export interface CostGuardrailSnapshot {
  state: CostGuardrailSnapshotState;
  todayUsd: number;
  dailyBudgetUsd: number;
  warningUsd: number;
  percentUsed: number;
}

export interface CostGuardrailEvaluation {
  key: string;
  label: string;
  currentUsd: number;
  limitUsd: number | null;
  warningUsd: number | null;
  /** Spend at which a launch is refused — `limitUsd × hardStopRatio`. */
  hardStopUsd: number | null;
  percentUsed: number | null;
  status: CostGuardrailEvaluationStatus;
  overrideActive: boolean;
}

export const DEFAULT_COST_GUARDRAIL_SETTINGS: CostGuardrailSettings = {
  dailyLimitUsd: null,
  monthlyLimitUsd: null,
  sessionLimitUsd: null,
  providerLimitsUsd: {},
  flightLimitsUsd: {},
  warningThresholdPercent: 80,
  hardStopThresholdPercent: 100,
  requireApprovalAtLimit: true,
  overrideUntilByKey: {},
};

export const costGuardrailKey = {
  daily: "daily",
  monthly: "monthly",
  global: "monthly",
  session: "session",
  provider: (source: string) => `provider:${source}`,
  flight: (flightId: string) => `flight:${flightId}`,
};

export function normalizeCostGuardrailSettings(raw: unknown): CostGuardrailSettings {
  const candidate = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
  const warningThresholdPercent = finitePercent(
    candidate.warningThresholdPercent ?? candidate.warningPercent,
    DEFAULT_COST_GUARDRAIL_SETTINGS.warningThresholdPercent,
  );
  const hardStopThresholdPercent = Math.max(
    warningThresholdPercent,
    finitePercent(
      candidate.hardStopThresholdPercent,
      DEFAULT_COST_GUARDRAIL_SETTINGS.hardStopThresholdPercent,
    ),
  );

  const explicitLimitProvided =
    candidate.dailyLimitUsd !== undefined || candidate.dailyBudgetUsd !== undefined;
  const requestedDailyLimit = finitePositiveOrNull(
    candidate.dailyLimitUsd ?? candidate.dailyBudgetUsd,
  );
  const dailyLimitUsd =
    candidate.enabled === false && !explicitLimitProvided ? null : requestedDailyLimit;

  return {
    dailyLimitUsd,
    monthlyLimitUsd: finitePositiveOrNull(candidate.monthlyLimitUsd),
    sessionLimitUsd: finitePositiveOrNull(candidate.sessionLimitUsd),
    providerLimitsUsd: finitePositiveRecord(candidate.providerLimitsUsd),
    flightLimitsUsd: finitePositiveRecord(candidate.flightLimitsUsd),
    warningThresholdPercent,
    hardStopThresholdPercent,
    requireApprovalAtLimit:
      typeof candidate.requireApprovalAtLimit === "boolean"
        ? candidate.requireApprovalAtLimit
        : DEFAULT_COST_GUARDRAIL_SETTINGS.requireApprovalAtLimit,
    overrideUntilByKey: finiteTimestampRecord(candidate.overrideUntilByKey),
  };
}

export function deriveCostGuardrailSnapshot(
  todayUsd: number,
  settings: unknown,
): CostGuardrailSnapshot {
  const normalized = normalizeCostGuardrailSettings(settings);
  const safeToday = Number.isFinite(todayUsd) ? Math.max(0, todayUsd) : 0;
  const dailyBudgetUsd = normalized.dailyLimitUsd ?? 0;
  const warningUsd = dailyBudgetUsd * (normalized.warningThresholdPercent / 100);
  const percentUsed = dailyBudgetUsd > 0 ? (safeToday / dailyBudgetUsd) * 100 : 0;
  const state: CostGuardrailSnapshotState =
    dailyBudgetUsd <= 0
      ? "disabled"
      : percentUsed >= normalized.hardStopThresholdPercent
        ? "over"
        : percentUsed >= normalized.warningThresholdPercent
          ? "warning"
          : "safe";

  return { state, todayUsd: safeToday, dailyBudgetUsd, warningUsd, percentUsed };
}

export function computeCostGuardrailStatus(
  data: AnalyticsLike | null,
  settings: unknown,
  options: {
    now?: Date;
    currentSessionCostUsd?: number | null;
    sessionCostsById?: Record<string, number>;
    flightCostsById?: Record<string, number> | undefined;
    providerCostsBySource?: Record<string, number> | undefined;
  } = {},
): CostGuardrailStatus {
  const normalized = normalizeCostGuardrailSettings(settings);
  const unknown = unknownPricingUsage(data);
  const hasUnknownPricing = unknown.length > 0;

  if (!data) {
    const snapshot = deriveCostGuardrailSnapshot(0, normalized);
    return {
      level: hasUnknownPricing ? "unknown_pricing" : "ok",
      summary: hasUnknownPricing ? "Some usage cannot be priced yet." : "No cost data loaded.",
      requiresApproval: false,
      canOverride: false,
      snapshot,
      scopes: [],
      activeScope: null,
      hasUnknownPricing,
      unknownPricingModelUsage: unknown,
    };
  }

  const now = options.now ?? new Date();
  const dailySpend = costForDay(data, now);
  const snapshot = deriveCostGuardrailSnapshot(
    dailySpend,
    normalized,
  );
  const providerCosts = options.providerCostsBySource ?? providerCostsFromData(data);
  const providerScopes = Object.entries(normalized.providerLimitsUsd)
    .map(([source, limit]) =>
      scopeStatus(`provider:${source}`, providerCosts[source] ?? 0, limit, normalized),
    )
    .filter((scope): scope is CostGuardrailScopeStatus => Boolean(scope));
  const flightScopes = Object.entries(normalized.flightLimitsUsd)
    .map(([flightId, limit]) =>
      scopeStatus(
        `flight:${flightId}`,
        options.flightCostsById?.[flightId] ?? 0,
        limit,
        normalized,
      ),
    )
    .filter((scope): scope is CostGuardrailScopeStatus => Boolean(scope));

  const scopes = [
    scopeStatus("daily", dailySpend, normalized.dailyLimitUsd, normalized),
    scopeStatus("monthly", costForMonth(data, now), normalized.monthlyLimitUsd, normalized),
    ...(options.sessionCostsById ? Object.entries(options.sessionCostsById).map(([id, cost]) =>
      scopeStatus(`session:${id}`, cost, normalized.sessionLimitUsd, normalized),
    ) : [scopeStatus(
      "session",
      options.currentSessionCostUsd ?? 0,
      normalized.sessionLimitUsd,
      normalized,
    )]),
    ...providerScopes,
    ...flightScopes,
  ].filter((scope): scope is CostGuardrailScopeStatus => Boolean(scope));

  const activeScope = strongestScope(scopes);
  let level: CostGuardrailLevel = activeScope?.level ?? "ok";
  if (level === "ok" && hasUnknownPricing) level = "unknown_pricing";

  const requiresApproval =
    Boolean(activeScope && activeScope.level === "limit") && normalized.requireApprovalAtLimit;

  const summary =
    activeScope && activeScope.level !== "ok"
      ? `${activeScope.scope} spend is ${activeScope.percentUsed.toFixed(0)}% of its configured limit.`
      : hasUnknownPricing
        ? "Some usage cannot be priced yet."
        : "Cost guardrails are within configured limits.";

  return {
    level,
    summary,
    requiresApproval,
    canOverride: requiresApproval,
    snapshot,
    scopes,
    activeScope,
    hasUnknownPricing,
    unknownPricingModelUsage: unknown,
  };
}

/**
 * FAULT: the launch gate hard-coded its refusal at 100% of the cap, so
 * Settings → "Hard stop at % · Block launches at this share" changed nothing
 * on the one path that actually blocks a launch. The status/notification path
 * (`scopeStatus`) had always honoured `hardStopThresholdPercent`, so the two
 * halves of the same setting disagreed.
 *
 * `hardStopRatio` defaults to 1, which is exactly the old behaviour — and
 * `DEFAULT_COST_GUARDRAIL_SETTINGS.hardStopThresholdPercent` is 100, so an
 * existing user sees no change until they move the field.
 */
export function evaluateCostGuardrail(input: {
  key: string;
  label: string;
  currentUsd: number;
  limitUsd: number | null | undefined;
  warningRatio: number;
  /** Share of the cap at which a launch is refused. Defaults to 1 (the cap). */
  hardStopRatio?: number;
  overrideUntil?: number | null;
  now?: number;
}): CostGuardrailEvaluation {
  const limitUsd =
    typeof input.limitUsd === "number" && Number.isFinite(input.limitUsd) && input.limitUsd > 0
      ? input.limitUsd
      : null;
  const currentUsd = Number.isFinite(input.currentUsd) ? Math.max(0, input.currentUsd) : 0;
  const warningRatio =
    Number.isFinite(input.warningRatio) && input.warningRatio > 0
      ? Math.min(1, input.warningRatio)
      : 0.8;
  // A hard stop below the warning share would make the warning unreachable,
  // so it is clamped up — the same ordering `normalizeCostGuardrailSettings`
  // enforces on the persisted pair.
  const hardStopRatio =
    Number.isFinite(input.hardStopRatio) && (input.hardStopRatio as number) > 0
      ? Math.max(warningRatio, Math.min(1, input.hardStopRatio as number))
      : 1;
  const overrideActive = Boolean(
    input.overrideUntil && input.overrideUntil > (input.now ?? Date.now()),
  );

  if (limitUsd === null) {
    return {
      key: input.key,
      label: input.label,
      currentUsd,
      limitUsd: null,
      warningUsd: null,
      hardStopUsd: null,
      percentUsed: null,
      status: "off",
      overrideActive,
    };
  }

  const percentUsed = (currentUsd / limitUsd) * 100;
  const hardStopUsd = limitUsd * hardStopRatio;
  const status: CostGuardrailEvaluationStatus =
    currentUsd >= hardStopUsd && !overrideActive
      ? "blocked"
      : currentUsd >= limitUsd * warningRatio
        ? "warning"
        : "ok";

  return {
    key: input.key,
    label: input.label,
    currentUsd,
    limitUsd,
    warningUsd: limitUsd * warningRatio,
    hardStopUsd,
    percentUsed,
    status,
    overrideActive,
  };
}

export function evaluationMessage(evaluation: CostGuardrailEvaluation): string {
  if (evaluation.status === "blocked" && evaluation.limitUsd !== null) {
    // Name the stop when it is below the cap, or the refusal reads as a bug:
    // "$6 of its $10 limit" gives the user no clue why $6 was refused.
    const stop =
      evaluation.hardStopUsd !== null && evaluation.hardStopUsd < evaluation.limitUsd
        ? ` (hard stop at $${evaluation.hardStopUsd.toFixed(2)})`
        : "";
    return `${evaluation.label} is at $${evaluation.currentUsd.toFixed(2)} of its $${evaluation.limitUsd.toFixed(2)} limit${stop}. Approve an override before launching more autonomous work.`;
  }
  if (evaluation.status === "warning" && evaluation.warningUsd !== null) {
    return `${evaluation.label} has passed the $${evaluation.warningUsd.toFixed(2)} warning threshold.`;
  }
  return `${evaluation.label} is within configured cost guardrails.`;
}

export function providerCost(data: AnalyticsLike, providerSource: string): number {
  return data.modelUsage
    .filter((usage) => usage.source === providerSource)
    .reduce((sum, usage) => sum + Math.max(0, usage.costUsd), 0);
}

export function providerSourceForAgentProvider(provider: string): string {
  const normalized = provider.trim().toLowerCase();
  const map: Record<string, string> = {
    "api-claude-oauth": "claude-oauth",
    "claude-oauth": "claude-oauth",
    "api-claude": "api-claude",
    claude: "api-claude",
    // RETIRED provider (removed 2026-07). BOTH directions are kept so
    // per-provider budgets configured before the removal keep applying to
    // the historical spend they were set against.
    "api-openai-codex": "openai-codex",
    "openai-codex": "openai-codex",
    codex: "codex",
    "api-openai": "api-openai",
    openai: "api-openai",
    "api-openai-agents": "openai-agents",
    "openai-agents": "openai-agents",
    "api-minimax": "api-minimax",
    minimax: "api-minimax",
    // Legacy identity-duplicate provider id — collapsed onto the
    // canonical `api-minimax` so guardrail budgets persisted under the
    // old id keep applying (P2-20).
    "api-minimax-api": "api-minimax",
    "minimax-api": "api-minimax",
    "api-openrouter": "api-openrouter",
    openrouter: "api-openrouter",
    "api-ollama": "api-ollama",
    ollama: "api-ollama",
    // PacketCode over ACP — a RETIRED transport. Both keys stay registered so
    // ledger rows written before its removal still resolve to a scope rather
    // than falling through. The frontend
    // agentCli and the bare backend provider id the Rust engine stamps onto
    // analytics rows must collapse onto ONE guardrail source, or a budget set
    // in the UI would silently miss half the spend it was set against.
    "api-packetcode": "api-packetcode",
    "packetcode-acp": "api-packetcode",
  };
  return map[normalized] ?? normalized;
}

export function isUnknownPricedUsage(usage: CostUsageLike): boolean {
  if (usage.pricingStatus) return usage.pricingStatus === "unknown";

  const totalTokens = Math.max(0, usage.inputTokens) + Math.max(0, usage.outputTokens);
  if (totalTokens <= 0 || usage.costUsd > 0) return false;

  const source = usage.source.toLowerCase();
  const model = usage.model.trim().toLowerCase();
  if (source.includes("ollama")) return false;

  const bareModel = model.replace(/^ollama[/:]/, "").replace(/^local\//, "");
  return !isLocalFreeModel(bareModel);
}

function finitePositiveOrNull(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? numeric : null;
}

function finitePercent(value: unknown, fallback: number): number {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return fallback;
  return Math.min(100, numeric);
}

function finitePositiveRecord(value: unknown): Record<string, number> {
  if (typeof value !== "object" || value === null) return {};
  const out: Record<string, number> = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    const next = finitePositiveOrNull(raw);
    if (next !== null) out[key] = next;
  }
  return out;
}

function finiteTimestampRecord(value: unknown): Record<string, number> {
  if (typeof value !== "object" || value === null) return {};
  const out: Record<string, number> = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    const next = Number(raw);
    if (Number.isFinite(next) && next > 0) out[key] = next;
  }
  return out;
}

function costForDay(data: AnalyticsLike, date: Date): number {
  const explicit = data.todayCostUsd;
  if (typeof explicit === "number" && Number.isFinite(explicit)) return explicit;
  return data.dailyCosts.find((day) => day.date === ymd(date))?.costUsd ?? 0;
}

function costForMonth(data: AnalyticsLike, date: Date): number {
  const explicit = data.currentMonthCostUsd;
  if (typeof explicit === "number" && Number.isFinite(explicit)) return explicit;
  const key = ymd(date).slice(0, 7);
  return data.dailyCosts
    .filter((day) => day.date.startsWith(key))
    .reduce((sum, day) => sum + day.costUsd, 0);
}

function providerCostsFromData(data: AnalyticsLike): Record<string, number> {
  const out: Record<string, number> = {};
  for (const usage of data.modelUsage) {
    out[usage.source] = (out[usage.source] ?? 0) + Math.max(0, usage.costUsd);
  }
  return out;
}

function scopeStatus(
  scope: CostGuardrailScope,
  spendUsd: number,
  limitUsd: number | null,
  settings: CostGuardrailSettings,
): CostGuardrailScopeStatus | null {
  if (!limitUsd) return null;
  const safeSpend = Number.isFinite(spendUsd) ? Math.max(0, spendUsd) : 0;
  const percentUsed = limitUsd > 0 ? (safeSpend / limitUsd) * 100 : 0;
  const level =
    percentUsed >= settings.hardStopThresholdPercent
      ? "limit"
      : percentUsed >= settings.warningThresholdPercent
        ? "warning"
        : "ok";
  return { scope, spendUsd: safeSpend, limitUsd, percentUsed, level };
}

function strongestScope(scopes: CostGuardrailScopeStatus[]): CostGuardrailScopeStatus | null {
  const rank: Record<CostGuardrailScopeStatus["level"], number> = {
    ok: 0,
    warning: 1,
    limit: 2,
  };
  return scopes.reduce<CostGuardrailScopeStatus | null>((best, current) => {
    if (!best) return current;
    if (rank[current.level] > rank[best.level]) return current;
    if (rank[current.level] === rank[best.level] && current.percentUsed > best.percentUsed) {
      return current;
    }
    return best;
  }, null);
}

function unknownPricingUsage(data: AnalyticsLike | null): CostUsageLike[] {
  if (!data) return [];
  if (data.unknownPricingModelUsage) return data.unknownPricingModelUsage;
  return data.modelUsage.filter(isUnknownPricedUsage);
}

function ymd(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function isLocalFreeModel(model: string): boolean {
  return (
    model.startsWith("llama") ||
    model.startsWith("qwen") ||
    model.startsWith("deepseek") ||
    model.startsWith("codellama")
  );
}
