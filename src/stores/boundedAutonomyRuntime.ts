import { generateId } from "@/lib/storage";
import { beginFlightExecution } from "@/lib/tauri";
import { registerFlightStartup, revokeFlightStarts } from "@/lib/flightRunControl";
import {
  evaluateAutonomyAction,
  pauseAutonomyForRestart,
  reviewerRetryCount,
  reviewerRetryDelayMs,
  validateAutonomyPolicy,
  type AutonomyEvaluationRequest,
} from "@/lib/autonomyPolicy";
import { selectReadyCooperativeTasks } from "@/lib/cooperativeFlight";
import { useAgentTaskStore } from "@/stores/agentTaskStore";
import { useAsyncFlightStore } from "@/stores/asyncFlightStore";
import { useFlightStore } from "@/stores/flightStore";
import type {
  Attempt,
  AutonomyActionKind,
  AutonomyActionRecord,
  AutonomyRuntime,
  Flight,
} from "@/types/flight";

const ACTION_HISTORY_LIMIT = 500;
const activeActions = new Set<string>();
let unsubscribeFlight: (() => void) | null = null;
let unsubscribeAgents: (() => void) | null = null;
let syncRequested = false;
let syncRunning = false;
let runtimeGeneration = 0;
let runtimeActive = false;
const reviewRetryTimers = new Map<
  string,
  { flightId: string; dueAt: number; handle: ReturnType<typeof setTimeout> }
>();
let policyWatchdog: ReturnType<typeof setInterval> | undefined;

function clearReviewRetryTimers(flightId?: string): void {
  for (const [key, timer] of reviewRetryTimers) {
    if (flightId !== undefined && timer.flightId !== flightId) continue;
    clearTimeout(timer.handle);
    reviewRetryTimers.delete(key);
  }
}

function scheduleReviewRetry(flightId: string, attemptId: string, dueAt: number): void {
  const key = `${flightId}:${attemptId}`;
  const existing = reviewRetryTimers.get(key);
  if (existing?.dueAt === dueAt) return;
  if (existing) clearTimeout(existing.handle);
  const handle = setTimeout(
    () => {
      reviewRetryTimers.delete(key);
      if (currentFlight(flightId)?.autonomyRuntime?.status === "running") queueSync();
    },
    Math.max(0, dueAt - Date.now()),
  );
  reviewRetryTimers.set(key, { flightId, dueAt, handle });
}

function currentFlight(flightId: string): Flight | undefined {
  return useFlightStore.getState().flights.find((flight) => flight.id === flightId);
}

function updateRuntime(
  flightId: string,
  update: (runtime: AutonomyRuntime) => AutonomyRuntime,
): void {
  const flight = currentFlight(flightId);
  if (!flight?.autonomyRuntime) return;
  useFlightStore.getState().updateFlight(flightId, {
    autonomyRuntime: update(flight.autonomyRuntime),
  });
}

function appendAction(flightId: string, record: AutonomyActionRecord): void {
  updateRuntime(flightId, (runtime) => ({
    ...runtime,
    actionHistory: [...runtime.actionHistory, record].slice(-ACTION_HISTORY_LIMIT),
  }));
}

function patchAction(
  flightId: string,
  actionId: string,
  patch: Partial<AutonomyActionRecord>,
): void {
  updateRuntime(flightId, (runtime) => ({
    ...runtime,
    actionHistory: runtime.actionHistory.map((record) =>
      record.id === actionId ? { ...record, ...patch } : record,
    ),
  }));
}

function stopForAttention(flightId: string, reason: string): void {
  clearReviewRetryTimers(flightId);
  const flight = currentFlight(flightId);
  if (!flight?.autonomyRuntime || flight.autonomyRuntime.status === "needs_attention") return;
  useFlightStore.getState().updateFlight(flightId, {
    status: "paused",
    autonomyRuntime: {
      ...flight.autonomyRuntime,
      status: "needs_attention",
      pausedAt: Date.now(),
      hardStopReason: reason,
    },
  });
  useFlightStore.getState().appendCoordinationEvent(flightId, {
    type: "escalation",
    agentId: "packetbench:bounded-autonomy",
    summary: `Bounded autonomy stopped: ${reason}`,
    metadata: { source: "bounded_autonomy", hardStop: "true" },
  });
  void useAsyncFlightStore
    .getState()
    .stopFlight(flightId, { reason, needsAttention: true })
    .catch(console.error);
}

function targetForAttempt(attempt: Attempt): string {
  return attempt.target.kind === "ssh" ? attempt.target.serverId : "local";
}

function rootForAttempt(attempt: Attempt): string {
  return attempt.target.basePath;
}

function activeAgentCount(flight: Flight): number {
  return (flight.attempts ?? []).filter((attempt) =>
    ["queued", "provisioning", "running"].includes(attempt.status),
  ).length;
}

async function performAutonomyAction(
  flightId: string,
  request: AutonomyEvaluationRequest,
  callback: () => Promise<void>,
  metadata?: AutonomyActionRecord["metadata"],
): Promise<boolean> {
  if (!runtimeActive) return false;
  const key = `${flightId}:${request.action}:${request.subjectId ?? "flight"}`;
  if (activeActions.has(key)) return false;
  const flight = currentFlight(flightId);
  if (!flight) return false;
  const decision = evaluateAutonomyAction(flight, request);
  if (!decision.allowed) {
    if (decision.hardStop) stopForAttention(flightId, decision.reason);
    return false;
  }
  activeActions.add(key);
  const actionId = generateId("autonomy");
  const generation = runtimeGeneration;
  const retryCount =
    request.action === "retry_review" && request.subjectId
      ? reviewerRetryCount(flight, request.subjectId) + 1
      : undefined;
  const sourceGate =
    retryCount !== undefined
      ? flight.attempts?.find((attempt) => attempt.id === request.subjectId)?.reviewGate
      : undefined;
  const retrySource = sourceGate
    ? { status: sourceGate.status, reviewerConversationId: sourceGate.reviewerConversationId }
    : undefined;
  appendAction(flightId, {
    id: actionId,
    kind: request.action,
    subjectId: request.subjectId,
    status: "started",
    reason: decision.reason,
    timestamp: Date.now(),
    cost: flight.totalCost,
    metadata,
  });
  try {
    if (retryCount !== undefined && request.subjectId) {
      const subjectId = request.subjectId;
      updateRuntime(flightId, (runtime) => ({
        ...runtime,
        reviewRetryCounts: { ...runtime.reviewRetryCounts, [subjectId]: retryCount },
      }));
      // Reserve the retry durably before a provider can start. A crash or
      // failed launch must not restore the allowance or start duplicate work.
      await useFlightStore.getState().flushPersistence();
      const latest = currentFlight(flightId);
      if (
        !latest ||
        latest.autonomyRuntime?.status !== "running" ||
        generation !== runtimeGeneration
      ) {
        patchAction(flightId, actionId, {
          status: "denied",
          reason: "The Flight runtime paused or stopped before the reviewer retry started.",
        });
        return false;
      }
      const liveAttempt = latest.attempts?.find((attempt) => attempt.id === subjectId);
      if (
        !latest.autonomyPolicy?.autoReviewRemediation ||
        !latest.reviewGatePolicy?.enabled ||
        liveAttempt?.status !== "reviewing" ||
        liveAttempt.reviewGate?.status !== retrySource?.status ||
        liveAttempt.reviewGate?.reviewerConversationId !== retrySource?.reviewerConversationId
      ) {
        patchAction(flightId, actionId, {
          status: "denied",
          reason: "The reviewer or its policy changed before the automatic retry started.",
        });
        return false;
      }
      const continuation = evaluateAutonomyAction(latest, { ...request, action: "continue" });
      if (!continuation.allowed) {
        if (continuation.hardStop) stopForAttention(flightId, continuation.reason);
        patchAction(flightId, actionId, { status: "denied", reason: continuation.reason });
        return false;
      }
      if (reviewerRetryCount(latest, subjectId) > latest.autonomyPolicy!.maxReviewRounds) {
        const reason = "The reviewer retry limit was reduced before this retry started.";
        stopForAttention(flightId, reason);
        patchAction(flightId, actionId, { status: "denied", reason });
        return false;
      }
    }
    await callback();
    patchAction(flightId, actionId, {
      status: "completed",
      reason: "Completed through the same action used by Assisted mode.",
      cost: currentFlight(flightId)?.totalCost ?? flight.totalCost,
    });
    return true;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    patchAction(flightId, actionId, { status: "failed", reason });
    stopForAttention(flightId, reason);
    return false;
  } finally {
    activeActions.delete(key);
  }
}

function recoveryKey(attempt: Attempt): string {
  return (
    attempt.taskId ??
    `${targetForAttempt(attempt)}:${attempt.target.basePath}:${attempt.agentConfigId}`
  );
}

function latestAttemptsByRecoveryKey(flight: Flight): Attempt[] {
  const latest = new Map<string, Attempt>();
  for (const attempt of flight.attempts ?? []) {
    const key = recoveryKey(attempt);
    const previous = latest.get(key);
    if (!previous || (attempt.startedAt ?? 0) >= (previous.startedAt ?? 0)) {
      latest.set(key, attempt);
    }
  }
  return Array.from(latest.values());
}

function completedAction(
  flight: Flight,
  kind: AutonomyActionKind,
  subjectId: string,
  metadataKey?: string,
  metadataValue?: string,
): AutonomyActionRecord | undefined {
  return [...(flight.autonomyRuntime?.actionHistory ?? [])]
    .reverse()
    .find(
      (record) =>
        record.kind === kind &&
        record.subjectId === subjectId &&
        record.status === "completed" &&
        (!metadataKey || record.metadata?.[metadataKey] === metadataValue),
    );
}

async function syncToolPosture(flight: Flight): Promise<void> {
  const posture = flight.autonomyPolicy?.toolPosture;
  if (!posture) return;
  for (const attempt of flight.attempts ?? []) {
    if (!["queued", "provisioning", "running"].includes(attempt.status)) continue;
    if (completedAction(flight, "set_tool_posture", attempt.id)) continue;
    const conversation = useAgentTaskStore
      .getState()
      .conversations.find((item) => item.id === attempt.sessionId);
    if (!conversation) continue;
    const permissionMode = posture === "allow_in_project" ? "auto" : "ask_for_risky";
    if (conversation.permissionMode === permissionMode) {
      appendAction(flight.id, {
        id: generateId("autonomy"),
        kind: "set_tool_posture",
        subjectId: attempt.id,
        status: "completed",
        reason: `Tool posture already matched ${posture}.`,
        timestamp: Date.now(),
        cost: flight.totalCost,
        metadata: { posture },
      });
      continue;
    }
    await performAutonomyAction(
      flight.id,
      {
        action: "set_tool_posture",
        subjectId: attempt.id,
        root: rootForAttempt(attempt),
        targetId: targetForAttempt(attempt),
      },
      () => useAgentTaskStore.getState().setPermissionMode(attempt.sessionId, permissionMode),
      { posture },
    );
  }
}

async function syncRecovery(flight: Flight): Promise<void> {
  const generation = runtimeGeneration;
  if (!flight.autonomyPolicy?.autoRecovery) return;
  for (const attempt of latestAttemptsByRecoveryKey(flight)) {
    if (attempt.status !== "failed") continue;
    const subjectId = recoveryKey(attempt);
    await performAutonomyAction(
      flight.id,
      {
        action: "recover_attempt",
        subjectId,
        root: rootForAttempt(attempt),
        targetId: targetForAttempt(attempt),
        activeAgents: activeAgentCount(currentFlight(flight.id) ?? flight),
      },
      () =>
        useAsyncFlightStore
          .getState()
          .reassignAttempt(
            flight.id,
            attempt.id,
            attempt.agentConfigId,
            () =>
              runtimeActive &&
              generation === runtimeGeneration &&
              currentFlight(flight.id)?.autonomyRuntime?.status === "running" &&
              !currentFlight(flight.id)?.stoppedAt,
          ),
      { failedAttemptId: attempt.id },
    );
    if (currentFlight(flight.id)?.autonomyRuntime?.status !== "running") return;
  }
}

async function retryReviewerAutomatically(flightId: string, attemptId: string): Promise<void> {
  const generation = runtimeGeneration;
  const canStart = () => {
    const flight = currentFlight(flightId);
    if (
      !runtimeActive ||
      generation !== runtimeGeneration ||
      flight?.autonomyRuntime?.status !== "running" ||
      !flight.autonomyPolicy?.autoReviewRemediation ||
      !flight.reviewGatePolicy?.enabled
    )
      return false;
    const attempt = flight.attempts?.find((candidate) => candidate.id === attemptId);
    if (!attempt || attempt.status !== "reviewing") return false;
    const decision = evaluateAutonomyAction(flight, {
      action: "continue",
      root: rootForAttempt(attempt),
      targetId: targetForAttempt(attempt),
    });
    if (!decision.allowed) {
      if (decision.hardStop) stopForAttention(flightId, decision.reason);
      return false;
    }
    if (reviewerRetryCount(flight, attemptId) > flight.autonomyPolicy.maxReviewRounds) {
      stopForAttention(flightId, "The reviewer retry limit was reduced before this retry started.");
      return false;
    }
    return true;
  };
  await useAsyncFlightStore.getState().retryReviewGate(flightId, attemptId, canStart);
}

function repairTurnCompleted(
  flightId: string,
  attempt: Attempt,
  remediation: AutonomyActionRecord,
): boolean {
  const builder = useAgentTaskStore
    .getState()
    .conversations.find((conversation) => conversation.id === attempt.sessionId);
  const lastAssistant = [...(builder?.messages ?? [])]
    .reverse()
    .find((message) => message.role === "assistant");
  return Boolean(
    builder?.status === "idle" &&
    !builder.messages.some((message) => message.isStreaming) &&
    lastAssistant?.turnOutcome === "completed" &&
    lastAssistant.timestamp >= remediation.timestamp &&
    (remediation.metadata?.builderSessionId === undefined ||
      remediation.metadata.builderSessionId === attempt.sessionId) &&
    !useAgentTaskStore.getState().cancellingConversationIds.has(builder.id) &&
    !currentFlight(flightId)?.stoppedAt &&
    currentFlight(flightId)?.autonomyRuntime?.status === "running",
  );
}

async function syncReview(flight: Flight): Promise<void> {
  if (!flight.autonomyPolicy?.autoReviewRemediation) return;
  for (const attempt of flight.attempts ?? []) {
    if (attempt.status !== "reviewing") continue;
    const gate = attempt.reviewGate;
    if (!gate) continue;
    const reviewerConversationId = gate.reviewerConversationId ?? "pending";
    if (gate.status === "passed") {
      const action: AutonomyActionKind =
        flight.executionMode === "cooperative" ? "integrate_attempt" : "accept_review_pass";
      await performAutonomyAction(
        flight.id,
        {
          action,
          subjectId: attempt.id,
          root: rootForAttempt(attempt),
          targetId: targetForAttempt(attempt),
        },
        () => useAsyncFlightStore.getState().setAttemptStatus(flight.id, attempt.id, "completed"),
        { reviewerConversationId },
      );
      continue;
    }
    if (gate.status === "error") {
      const repair = completedAction(
        flight,
        "review_remediation",
        attempt.id,
        "reviewerConversationId",
        reviewerConversationId,
      );
      if (repair && !repairTurnCompleted(flight.id, attempt, repair)) continue;
      if (
        completedAction(
          flight,
          "retry_review",
          attempt.id,
          "reviewerConversationId",
          reviewerConversationId,
        )
      ) {
        continue;
      }
      const request: AutonomyEvaluationRequest = {
        action: "retry_review",
        subjectId: attempt.id,
        root: rootForAttempt(attempt),
        targetId: targetForAttempt(attempt),
      };
      const fresh = currentFlight(flight.id) ?? flight;
      const decision = evaluateAutonomyAction(fresh, request);
      if (!decision.allowed) {
        if (decision.hardStop) stopForAttention(flight.id, decision.reason);
        continue;
      }
      const dueAt =
        (gate.completedAt ?? gate.startedAt ?? 0) + reviewerRetryDelayMs(fresh, attempt.id);
      if (Date.now() < dueAt) {
        scheduleReviewRetry(flight.id, attempt.id, dueAt);
        continue;
      }
      await performAutonomyAction(
        flight.id,
        request,
        () => retryReviewerAutomatically(flight.id, attempt.id),
        { reviewerConversationId },
      );
      continue;
    }
    if (!["changes_requested", "blocked"].includes(gate.status) || !gate.report) continue;
    const remediation = completedAction(
      flight,
      "review_remediation",
      attempt.id,
      "reviewerConversationId",
      reviewerConversationId,
    );
    if (!remediation) {
      await performAutonomyAction(
        flight.id,
        {
          action: "review_remediation",
          subjectId: attempt.id,
          root: rootForAttempt(attempt),
          targetId: targetForAttempt(attempt),
        },
        () => useAsyncFlightStore.getState().sendReviewFindingsToBuilder(flight.id, attempt.id),
        { reviewerConversationId, builderSessionId: attempt.sessionId },
      );
      continue;
    }
    if (!repairTurnCompleted(flight.id, attempt, remediation)) continue;
    if (
      completedAction(
        flight,
        "retry_review",
        attempt.id,
        "reviewerConversationId",
        reviewerConversationId,
      )
    ) {
      continue;
    }
    await performAutonomyAction(
      flight.id,
      {
        action: "retry_review",
        subjectId: attempt.id,
        root: rootForAttempt(attempt),
        targetId: targetForAttempt(attempt),
      },
      () => retryReviewerAutomatically(flight.id, attempt.id),
      { reviewerConversationId },
    );
  }
}

async function syncGraph(flight: Flight): Promise<void> {
  const generation = runtimeGeneration;
  if (!flight.autonomyPolicy?.autoRunTaskGraph || flight.executionMode !== "cooperative") return;
  for (const task of selectReadyCooperativeTasks(flight)) {
    const fresh = currentFlight(flight.id) ?? flight;
    if (activeAgentCount(fresh) >= (fresh.autonomyPolicy?.maxConcurrentAgents ?? 1)) return;
    await performAutonomyAction(
      flight.id,
      {
        action: "launch_ready_task",
        subjectId: task.id,
        root: flight.projectPath,
        targetId:
          flight.integrationBranch?.targetKind === "ssh"
            ? flight.integrationBranch.targetId
            : "local",
        activeAgents: activeAgentCount(fresh),
      },
      () =>
        useAsyncFlightStore.getState().launchReadyTasks(flight.id, [task.id], {
          canStart: () =>
            runtimeActive &&
            generation === runtimeGeneration &&
            currentFlight(flight.id)?.autonomyRuntime?.status === "running" &&
            !currentFlight(flight.id)?.stoppedAt,
        }),
      { taskTitle: task.title },
    );
    if (currentFlight(flight.id)?.autonomyRuntime?.status !== "running") return;
  }
}

function maybeCompleteAutonomy(flight: Flight): void {
  const runtime = flight.autonomyRuntime;
  if (!runtime || runtime.status !== "running") return;
  const tasks = flight.milestones.flatMap((milestone) => milestone.tasks);
  const attempts = flight.attempts ?? [];
  const graphComplete =
    flight.executionMode === "cooperative" &&
    tasks.length > 0 &&
    tasks.every((task) => task.status === "done");
  const attemptsComplete =
    flight.executionMode !== "cooperative" &&
    attempts.length > 0 &&
    attempts.every((attempt) => ["completed", "cancelled"].includes(attempt.status));
  if (!graphComplete && !attemptsComplete) return;
  useFlightStore.getState().updateFlight(flight.id, {
    autonomyRuntime: {
      ...runtime,
      status: "completed",
      hardStopReason: graphComplete
        ? "All task branches are integrated. Final landing into the base branch remains explicit."
        : undefined,
    },
  });
}

async function syncOneFlight(flight: Flight): Promise<void> {
  if (!runtimeActive) return;
  if (flight.autonomyRuntime?.status !== "running") {
    clearReviewRetryTimers(flight.id);
    return;
  }
  const continuation = evaluateAutonomyAction(flight, {
    action: "continue",
    root: flight.projectPath,
    targetId:
      flight.integrationBranch?.targetKind === "ssh" ? flight.integrationBranch.targetId : "local",
  });
  if (!continuation.allowed) {
    if (continuation.hardStop) stopForAttention(flight.id, continuation.reason);
    return;
  }
  await syncToolPosture(currentFlight(flight.id) ?? flight);
  await syncReview(currentFlight(flight.id) ?? flight);
  await syncRecovery(currentFlight(flight.id) ?? flight);
  await syncGraph(currentFlight(flight.id) ?? flight);
  maybeCompleteAutonomy(currentFlight(flight.id) ?? flight);
}

async function drainSync(): Promise<void> {
  if (syncRunning) return;
  syncRunning = true;
  try {
    while (syncRequested && runtimeActive) {
      syncRequested = false;
      for (const flight of useFlightStore.getState().flights) {
        await syncOneFlight(flight);
      }
    }
  } finally {
    syncRunning = false;
  }
}

function queueSync(): void {
  if (!runtimeActive) return;
  syncRequested = true;
  queueMicrotask(() => void drainSync());
}

export async function startFlightAutonomy(flightId: string): Promise<void> {
  const flight = currentFlight(flightId);
  if (!flight?.autonomyPolicy || !flight.autonomyRuntime) {
    throw new Error("Configure a bounded autonomy policy before starting.");
  }
  const errors = validateAutonomyPolicy(flight.autonomyPolicy, flight);
  if (errors.length > 0) throw new Error(errors[0]);
  if (flight.autonomyRuntime.status === "stopped") {
    throw new Error(
      "This automatic run was stopped. Choose bounded automatic actions again to create a new run.",
    );
  }
  const ticket = registerFlightStartup(flightId);
  const generation = runtimeGeneration;
  try {
    await useFlightStore.getState().flushPersistence();
    if (!ticket.isCurrent() || generation !== runtimeGeneration) return;
    await beginFlightExecution(flightId, flight.stoppedAt);
    if (!ticket.isCurrent() || generation !== runtimeGeneration) return;
    const latest = currentFlight(flightId);
    if (
      !latest?.autonomyRuntime ||
      latest.autonomyRuntime !== flight.autonomyRuntime ||
      latest.archivedAt ||
      latest.delivery
    )
      return;
    if (!latest.autonomyPolicy)
      throw new Error("Configure bounded automatic actions before starting.");
    const latestErrors = validateAutonomyPolicy(latest.autonomyPolicy, latest);
    if (latestErrors.length) throw new Error(latestErrors[0]);
    useFlightStore.getState().updateFlight(flightId, {
      status: "active",
      stoppedAt: undefined,
      autonomyRuntime: {
        ...latest.autonomyRuntime,
        status: "running",
        startedAt: flight.autonomyRuntime.startedAt ?? Date.now(),
        pausedAt: undefined,
        hardStopReason: undefined,
      },
    });
    queueSync();
  } finally {
    ticket.finish();
  }
}

export function pauseFlightAutonomy(flightId: string): void {
  clearReviewRetryTimers(flightId);
  updateRuntime(flightId, (runtime) => ({
    ...runtime,
    status: "paused",
    pausedAt: Date.now(),
    hardStopReason: "Paused by the user.",
  }));
}

export async function stopFlightAutonomy(
  flightId: string,
  cancelRunningAttempts = true,
): Promise<void> {
  clearReviewRetryTimers(flightId);
  revokeFlightStarts(flightId);
  const flight = currentFlight(flightId);
  if (!flight) return;
  useFlightStore.getState().updateFlight(flightId, {
    status: "paused",
    autonomyRuntime: flight.autonomyRuntime
      ? {
          ...flight.autonomyRuntime,
          status: "stopped",
          stoppedAt: Date.now(),
          hardStopReason: "Stopped by the user.",
        }
      : undefined,
  });
  // Stop always stops every owned role. Pause remains the non-cancelling action.
  void cancelRunningAttempts; // Legacy signature retained for existing callers.
  await useAsyncFlightStore.getState().stopFlight(flightId);
}

export function startBoundedAutonomyRuntime(): () => void {
  if (unsubscribeFlight || unsubscribeAgents) {
    return () => undefined;
  }
  runtimeActive = true;
  runtimeGeneration += 1;
  // A desktop restart never resumes unattended work. Rust performs the same
  // recovery for persisted state; this frontend guard also covers test/dev
  // hydration paths that do not pass through the native startup recovery.
  for (const flight of useFlightStore.getState().flights) {
    if (flight.autonomyRuntime?.status !== "running") continue;
    useFlightStore.getState().updateFlight(flight.id, {
      status: "paused",
      autonomyRuntime: pauseAutonomyForRestart(flight.autonomyRuntime),
    });
  }
  unsubscribeFlight = useFlightStore.subscribe(queueSync);
  unsubscribeAgents = useAgentTaskStore.subscribe(queueSync);
  policyWatchdog = setInterval(queueSync, 1_000);
  queueSync();
  let disposed = false;
  return () => {
    if (disposed) return;
    disposed = true;
    runtimeActive = false;
    syncRequested = false;
    runtimeGeneration += 1;
    clearReviewRetryTimers();
    clearInterval(policyWatchdog);
    policyWatchdog = undefined;
    unsubscribeFlight?.();
    unsubscribeAgents?.();
    unsubscribeFlight = null;
    unsubscribeAgents = null;
  };
}
