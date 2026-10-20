import type { Attempt, Flight, FlightStatus } from "@/types/flight";
import { validateCooperativeGraph } from "@/lib/cooperativeFlight";

export type FlightPhase =
  | "draft"
  | "running"
  | "needs_attention"
  | "review"
  | "ready_to_deliver"
  | "delivered"
  | "archived";
export interface FlightLifecycle {
  phase: FlightPhase;
  label: string;
  summary: string;
  nextAction: "brief" | "stop" | "attention" | "review" | "deliver" | "archive" | "unarchive";
  attentionCount: number;
  activeCount: number;
  resultCount: number;
}

export function attemptHasActiveWork(attempt: Attempt): boolean {
  return (
    ["queued", "provisioning", "running"].includes(attempt.status) ||
    attempt.reviewGate?.status === "running"
  );
}

export function flightOwnedSessionIds(flight: Flight): string[] {
  return [
    ...new Set(
      [
        ...(flight.attempts ?? []).flatMap((attempt) => [
          attempt.sessionId,
          ...(attempt.sessionHistory ?? []).map((session) => session.sessionId),
          attempt.reviewGate?.reviewerConversationId,
          ...(attempt.reviewGate?.reviewerSessions ?? []).map((session) => session.sessionId),
        ]),
        ...flight.milestones.flatMap((milestone) => milestone.tasks.map((task) => task.sessionId)),
        flight.planningConversationId,
      ].filter((id): id is string => Boolean(id)),
    ),
  ];
}

/** One projection for the deck, details, Monitor compatibility status, and learning. */
export function projectFlightLifecycle(
  flight: Flight,
  context: { pendingApprovalCount?: number; activeSessionCount?: number } = {},
): FlightLifecycle {
  const attempts = flight.attempts ?? [];
  const tasks = flight.milestones.flatMap((milestone) => milestone.tasks);
  const activeCount = Math.max(
    attempts.filter(attemptHasActiveWork).length,
    context.activeSessionCount ?? 0,
  );
  const resultCount = attempts.filter((attempt) =>
    ["reviewing", "completed"].includes(attempt.status),
  ).length;
  const latestByTask = new Map<string, Attempt>();
  for (const attempt of attempts)
    if (attempt.taskId) {
      const previous = latestByTask.get(attempt.taskId);
      if (!previous || (attempt.startedAt ?? 0) >= (previous.startedAt ?? 0))
        latestByTask.set(attempt.taskId, attempt);
    }
  const relevant = flight.executionMode === "cooperative" ? [...latestByTask.values()] : attempts;
  const reviewProblems = relevant.filter((attempt) =>
    ["error", "blocked", "changes_requested"].includes(attempt.reviewGate?.status ?? ""),
  );
  const retained = attempts.filter((attempt) => attempt.recovery?.state === "retained");
  const failed = relevant.filter((attempt) => attempt.status === "failed");
  const taskAttention = tasks.filter((task) =>
    ["approval_needed", "blocked", "failed", "paused"].includes(task.status),
  );
  const graphProblems =
    flight.executionMode === "cooperative" ? validateCooperativeGraph(flight) : [];
  const orphaned =
    flight.executionMode === "cooperative" &&
    attempts.some((attempt) => attempt.taskId && !tasks.some((task) => task.id === attempt.taskId));
  const attentionCount =
    (context.pendingApprovalCount ?? 0) +
    reviewProblems.length +
    retained.length +
    taskAttention.length +
    graphProblems.length +
    (orphaned ? 1 : 0) +
    (flight.integrationBranch?.status === "needs_attention" ? 1 : 0) +
    (flight.autonomyRuntime?.status === "needs_attention" ? 1 : 0);
  const result = (
    phase: FlightPhase,
    label: string,
    summary: string,
    nextAction: FlightLifecycle["nextAction"],
    count = attentionCount,
  ): FlightLifecycle => ({
    phase,
    label,
    summary,
    nextAction,
    attentionCount: count,
    activeCount,
    resultCount,
  });
  if (flight.archivedAt)
    return result(
      "archived",
      "Archived",
      "The record and retained work are preserved.",
      "unarchive",
    );
  const delivery = flight.delivery ?? attempts.find((attempt) => attempt.delivery)?.delivery;
  if ((delivery || flight.integrationBranch?.status === "landed") && activeCount === 0) {
    return result(
      "delivered",
      "Delivered",
      delivery?.kind === "pull_request"
        ? `Published ${delivery.prNumber ? `PR #${delivery.prNumber}` : "a pull request"} from ${delivery.branch}.`
        : `Landed into ${delivery?.baseBranch ?? flight.integrationBranch?.baseBranch ?? "the base branch"}.`,
      "archive",
      0,
    );
  }
  if (attentionCount > 0 || flight.stoppedAt) {
    return result(
      "needs_attention",
      flight.stoppedAt ? "Stopped" : "Needs you",
      retained.length > 0
        ? `${retained.length} worktree(s) retained for inspection or recovery.`
        : orphaned
          ? "An attempt no longer belongs to the current task plan."
          : "Resolve the highlighted blocker before continuing.",
      "attention",
      Math.max(1, attentionCount),
    );
  }
  if (activeCount > 0)
    return result(
      "running",
      "Running",
      `${activeCount} agent(s) working in isolated branches.`,
      "stop",
    );
  if (attempts.some((attempt) => attempt.status === "reviewing"))
    return result(
      "review",
      "Review",
      "Inspect the diff, checks and reviewer findings, then accept the result.",
      "review",
    );
  if (flight.executionMode === "cooperative") {
    const integrated =
      tasks.length > 0 &&
      tasks.every((task) => task.status === "done") &&
      tasks.every((task) => latestByTask.get(task.id)?.status === "completed");
    if (integrated && flight.integrationBranch?.status === "ready")
      return result(
        "ready_to_deliver",
        "Ready to land",
        "All task branches are integrated. Review the combined changes before landing.",
        "deliver",
      );
    if (failed.length > 0)
      return result(
        "needs_attention",
        "Needs you",
        "A task failed. Retry that task with its original brief.",
        "attention",
        failed.length,
      );
    if (attempts.length > 0 || tasks.some((task) => task.status === "done"))
      return result(
        "running",
        "Work remaining",
        "The task graph is incomplete. Launch the next ready task.",
        "brief",
      );
  } else if (attempts.some((attempt) => attempt.status === "completed")) {
    return result(
      "ready_to_deliver",
      "Ready to deliver",
      "An accepted result is ready to land or open as a pull request.",
      "deliver",
    );
  }
  if (failed.length > 0 || attempts.some((attempt) => attempt.status === "cancelled"))
    return result(
      "needs_attention",
      "Needs you",
      "No result has been delivered. Inspect the last run or create a new attempt.",
      "attention",
      Math.max(1, failed.length),
    );
  return result(
    "draft",
    "Draft",
    "Refine the outcome, scope and checks, then run one agent.",
    "brief",
    0,
  );
}

export function flightLifecycleStatus(
  flight: Flight,
  context: { pendingApprovalCount?: number; activeSessionCount?: number } = {},
): FlightStatus {
  const lifecycle = projectFlightLifecycle(flight, context);
  switch (lifecycle.phase) {
    case "delivered":
      return "done";
    case "ready_to_deliver":
    case "review":
      return "review";
    case "running":
      return "active";
    case "needs_attention":
      return (flight.attempts ?? []).some((attempt) => attempt.status === "failed") &&
        !lifecycle.resultCount
        ? "failed"
        : "paused";
    case "archived":
      return flight.delivery || flight.integrationBranch?.status === "landed" ? "done" : "paused";
    case "draft":
      return ["spec", "planning", "ready"].includes(flight.status) ? flight.status : "draft";
  }
}
