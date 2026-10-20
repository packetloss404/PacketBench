import { APP_NAME } from "@/lib/brand";

import type { AutonomyActionKind, AutonomyPolicy, AutonomyRuntime, Flight } from "@/types/flight";

export const DEFAULT_AUTONOMY_POLICY: AutonomyPolicy = {
  schemaVersion: 1,
  autoRecovery: true,
  autoReviewRemediation: true,
  autoRunTaskGraph: true,
  toolPosture: "approval_gated",
  maxTotalCost: 25,
  maxDurationMinutes: 120,
  maxRetriesPerTask: 2,
  maxReviewRounds: 2,
  maxConcurrentAgents: 3,
  allowedRoots: [],
  allowedTargets: ["local"],
  allowDraftPrPublishing: false,
};

export interface AutonomyDecision {
  allowed: boolean;
  reason: string;
  hardStop: boolean;
}

export interface AutonomyEvaluationRequest {
  action: AutonomyActionKind;
  subjectId?: string;
  root?: string;
  targetId?: string;
  now?: number;
  activeAgents?: number;
}

export function pauseAutonomyForRestart(
  runtime: AutonomyRuntime,
  now = Date.now(),
): AutonomyRuntime {
  if (runtime.status !== "running") return runtime;
  return {
    ...runtime,
    status: "paused",
    pausedAt: now,
    hardStopReason: `Paused after ${APP_NAME} restarted. Resume explicitly.`,
  };
}

function normalizePath(value: string): string {
  const normalized = value.trim().replace(/\\/g, "/").replace(/\/+$/, "");
  return /^[A-Za-z]:\//.test(normalized) ? normalized.toLowerCase() : normalized;
}

export function pathWithinAllowedRoots(path: string, roots: string[]): boolean {
  const candidate = normalizePath(path);
  if (!candidate) return false;
  return roots.some((root) => {
    const allowed = normalizePath(root);
    return Boolean(allowed) && (candidate === allowed || candidate.startsWith(`${allowed}/`));
  });
}

export function validateAutonomyPolicy(policy: AutonomyPolicy, flight?: Flight): string[] {
  const errors: string[] = [];
  if (policy.schemaVersion !== 1) errors.push("Unsupported autonomy policy version.");
  if (!Number.isFinite(policy.maxTotalCost) || policy.maxTotalCost <= 0) {
    errors.push("Maximum total cost must be greater than zero.");
  }
  if (
    !Number.isInteger(policy.maxDurationMinutes) ||
    policy.maxDurationMinutes < 1 ||
    policy.maxDurationMinutes > 10_080
  ) {
    errors.push("Maximum duration must be between 1 minute and 7 days.");
  }
  if (
    !Number.isInteger(policy.maxRetriesPerTask) ||
    policy.maxRetriesPerTask < 0 ||
    policy.maxRetriesPerTask > 20
  ) {
    errors.push("Retries per task must be between 0 and 20.");
  }
  if (
    !Number.isInteger(policy.maxReviewRounds) ||
    policy.maxReviewRounds < 0 ||
    policy.maxReviewRounds > 20
  ) {
    errors.push("Reviewer rounds must be between 0 and 20.");
  }
  if (
    !Number.isInteger(policy.maxConcurrentAgents) ||
    policy.maxConcurrentAgents < 1 ||
    policy.maxConcurrentAgents > 16
  ) {
    errors.push("Concurrent agents must be between 1 and 16.");
  }
  if (policy.autoRecovery && policy.maxRetriesPerTask === 0) {
    errors.push("Auto-recovery requires at least one retry per task.");
  }
  if (policy.autoReviewRemediation && policy.maxReviewRounds === 0) {
    errors.push("Auto-review remediation requires at least one reviewer round.");
  }
  if (policy.allowedRoots.length === 0) errors.push("At least one allowed root is required.");
  if (policy.allowedRoots.length > 50) errors.push("At most 50 allowed roots are supported.");
  if (policy.allowedTargets.length === 0) errors.push("At least one target is required.");
  if (policy.allowedTargets.length > 50) errors.push("At most 50 targets are supported.");
  if (flight) {
    if (!pathWithinAllowedRoots(flight.projectPath, policy.allowedRoots)) {
      errors.push("The Flight project is outside the policy's allowed roots.");
    }
    if (policy.autoRunTaskGraph && flight.executionMode !== "cooperative") {
      errors.push("Auto-run task graph requires Cooperative execution mode.");
    }
    if (policy.autoRunTaskGraph && !flight.reviewGatePolicy?.enabled) {
      errors.push("Auto-run task graph requires an independent Reviewer Gate.");
    }
    if (flight.publishAttemptsAsPrs && !policy.allowDraftPrPublishing) {
      errors.push("Draft-PR publishing is not allowed by this autonomy policy.");
    }
  }
  return errors;
}

function actionCount(
  flight: Flight,
  action: AutonomyActionKind,
  subjectId: string | undefined,
): number {
  return (flight.autonomyRuntime?.actionHistory ?? []).filter(
    (record) =>
      record.kind === action && record.subjectId === subjectId && record.status !== "denied",
  ).length;
}

/** Kept separately from the bounded activity log so a busy Flight cannot
 * regain reviewer retries when older activity is evicted. Legacy runs use
 * their persisted actions until the first counted retry migrates them. */
export function reviewerRetryCount(flight: Flight, attemptId: string): number {
  const count = flight.autonomyRuntime?.reviewRetryCounts?.[attemptId];
  const historyCount = actionCount(flight, "retry_review", attemptId);
  if (count === undefined) return historyCount;
  if (!Number.isSafeInteger(count) || count < 0) return Number.POSITIVE_INFINITY;
  return Math.max(count, historyCount);
}

export function reviewerRetryDelayMs(flight: Flight, attemptId: string): number {
  return Math.min(60_000, 1_000 * 2 ** Math.min(reviewerRetryCount(flight, attemptId), 6));
}

export function evaluateAutonomyAction(
  flight: Flight,
  request: AutonomyEvaluationRequest,
): AutonomyDecision {
  if (flight.autonomyMode === undefined || flight.autonomyMode === "assisted") {
    return { allowed: false, reason: "This Flight is in Assisted mode.", hardStop: false };
  }
  const policy = flight.autonomyPolicy;
  const runtime = flight.autonomyRuntime;
  if (!policy || !runtime) {
    return {
      allowed: false,
      reason: "The Flight has no persisted autonomy policy snapshot.",
      hardStop: true,
    };
  }
  if (runtime.status !== "running") {
    return {
      allowed: false,
      reason: `Bounded autonomy is ${runtime.status.replace(/_/g, " ")}.`,
      hardStop: false,
    };
  }
  const policyErrors = validateAutonomyPolicy(policy, flight);
  if (policyErrors.length > 0) {
    return { allowed: false, reason: policyErrors[0], hardStop: true };
  }
  const now = request.now ?? Date.now();
  if (flight.totalCost >= policy.maxTotalCost) {
    return {
      allowed: false,
      reason: `Cost limit reached ($${policy.maxTotalCost.toFixed(2)}).`,
      hardStop: true,
    };
  }
  if (
    runtime.startedAt !== undefined &&
    now - runtime.startedAt >= policy.maxDurationMinutes * 60_000
  ) {
    return {
      allowed: false,
      reason: `Duration limit reached (${policy.maxDurationMinutes} minutes).`,
      hardStop: true,
    };
  }
  const root = request.root ?? flight.projectPath;
  if (!pathWithinAllowedRoots(root, policy.allowedRoots)) {
    return { allowed: false, reason: "Action root is outside the allowlist.", hardStop: true };
  }
  const targetId = request.targetId ?? "local";
  if (!policy.allowedTargets.includes(targetId)) {
    return { allowed: false, reason: `Target '${targetId}' is not allowed.`, hardStop: true };
  }
  if (
    ["recover_attempt", "launch_ready_task"].includes(request.action) &&
    (request.activeAgents ?? 0) >= policy.maxConcurrentAgents
  ) {
    return {
      allowed: false,
      reason: `Concurrency limit reached (${policy.maxConcurrentAgents}).`,
      hardStop: false,
    };
  }
  if (request.action === "recover_attempt") {
    if (!policy.autoRecovery) {
      return { allowed: false, reason: "Auto-recovery is disabled.", hardStop: false };
    }
    if (actionCount(flight, request.action, request.subjectId) >= policy.maxRetriesPerTask) {
      return {
        allowed: false,
        reason: `Retry limit reached (${policy.maxRetriesPerTask}) for this task.`,
        hardStop: true,
      };
    }
  }
  if (["review_remediation", "retry_review", "accept_review_pass"].includes(request.action)) {
    if (!policy.autoReviewRemediation) {
      return {
        allowed: false,
        reason: "Auto-review remediation is disabled.",
        hardStop: false,
      };
    }
    if (
      request.action === "review_remediation" &&
      actionCount(flight, request.action, request.subjectId) >= policy.maxReviewRounds
    ) {
      return {
        allowed: false,
        reason: `Reviewer remediation limit reached (${policy.maxReviewRounds}).`,
        hardStop: true,
      };
    }
    if (
      request.action === "retry_review" &&
      reviewerRetryCount(flight, request.subjectId ?? "") >= policy.maxReviewRounds
    ) {
      return {
        allowed: false,
        reason: `Reviewer retry limit reached (${policy.maxReviewRounds}). Retry manually or revise the policy.`,
        hardStop: true,
      };
    }
  }
  if (["launch_ready_task", "integrate_attempt"].includes(request.action)) {
    if (!policy.autoRunTaskGraph) {
      return { allowed: false, reason: "Auto-run task graph is disabled.", hardStop: false };
    }
  }
  return { allowed: true, reason: "Allowed by the bounded autonomy policy.", hardStop: false };
}
