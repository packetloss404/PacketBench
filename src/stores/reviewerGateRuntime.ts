import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { apiAgentDoneEvent, apiAgentErrorEvent } from "@/lib/events";
import {
  buildReviewEvidenceBundle,
  buildReviewerInitialMessage,
  buildReviewerRemediationPrompt,
  buildReviewerSystemPrompt,
  parseLatestReviewGateReport,
  REVIEWER_ALLOWED_TOOLS,
} from "@/lib/reviewerGate";
import { getDefaultModel } from "@/lib/api-models";
import { captureAttemptReviewEvidence, setAttemptReviewGate } from "@/lib/tauri";
import { derivedArtifactProvenance } from "@/lib/provenance";
import { requestConversationSave } from "@/stores/agentConversationPersistence";
import {
  apiAgentProvider,
  resolveRetiredApiAgent,
  useAgentTaskStore,
  type AgentCli,
} from "@/stores/agentTaskStore";
import { useFlightStore } from "@/stores/flightStore";
import { useServerStore } from "@/stores/serverStore";
import { useAppStore } from "@/stores/appStore";
import { registerFlightStartup } from "@/lib/flightRunControl";
import type { Attempt, AttemptReviewGate, Flight, ReviewGateReport } from "@/types/flight";
import type { AgentConversation } from "@/types/agent-conversation";

const startingAttempts = new Set<string>();
const finishingAttempts = new Set<string>();
const gateWrites = new Map<string, Promise<boolean>>();
const reviewerCleanups = new Map<string, UnlistenFn[]>();
let syncQueued = false;

function attemptKey(flightId: string, attemptId: string): string {
  return `${flightId}:${attemptId}`;
}

function currentFlight(flightId: string): Flight | undefined {
  return useFlightStore.getState().flights.find((flight) => flight.id === flightId);
}

function currentAttempt(flightId: string, attemptId: string): Attempt | undefined {
  return currentFlight(flightId)?.attempts?.find((attempt) => attempt.id === attemptId);
}

/**
 * Persist the gate before publishing it to the UI. Serialize each attempt's
 * writes so a delayed verdict cannot overwrite a newer retry or override.
 *
 * The backend write is not optional. `reviewGate` is an attempt lifecycle
 * field, and the Rust snapshot merge keeps its own copy of an existing
 * attempt — so a gate that only ever reached `flightStore` was dropped on the
 * next flight save, and `markAttemptStatus("completed")` then rejected every
 * gated acceptance with "Reviewer Gate has not produced a verdict".
 */
function patchReviewGate(
  flightId: string,
  attemptId: string,
  gate: AttemptReviewGate,
  expectedRunningGate?: AttemptReviewGate,
): Promise<boolean> {
  const key = attemptKey(flightId, attemptId);
  const previous = gateWrites.get(key) ?? Promise.resolve(true);
  const write = previous
    .catch(() => false)
    .then(async () => {
      const current = currentAttempt(flightId, attemptId)?.reviewGate;
      if (
        expectedRunningGate &&
        (current?.status !== expectedRunningGate.status ||
          current.reviewerConversationId !== expectedRunningGate.reviewerConversationId)
      )
        return false;
      await persistReviewGate(flightId, attemptId, gate);
      return true;
    });
  gateWrites.set(key, write);
  const release = () => {
    if (gateWrites.get(key) === write) gateWrites.delete(key);
  };
  void write.then(release, release);
  return write;
}

async function persistReviewGate(
  flightId: string,
  attemptId: string,
  gate: AttemptReviewGate,
): Promise<void> {
  try {
    await setAttemptReviewGate(flightId, attemptId, gate);
  } catch (error) {
    const flight = currentFlight(flightId);
    if (flight?.attempts)
      useFlightStore.getState().updateFlight(flightId, {
        attempts: flight.attempts.map((attempt) =>
          attempt.id === attemptId
            ? {
                ...attempt,
                reviewGate: {
                  ...gate,
                  status: "error",
                  errorMessage: `Could not save the reviewer gate: ${String(error)}. Retry the reviewer or override again.`,
                },
              }
            : attempt,
        ),
      });
    throw error;
  }
  // Re-read after IPC so another attempt's concurrent update is preserved.
  const flight = currentFlight(flightId);
  if (!flight?.attempts) return;
  useFlightStore.getState().updateFlight(flightId, {
    attempts: flight.attempts.map((attempt) =>
      attempt.id === attemptId ? { ...attempt, reviewGate: gate } : attempt,
    ),
  });
}

function detachReviewerListeners(conversationId: string): void {
  const cleanups = reviewerCleanups.get(conversationId);
  if (!cleanups) return;
  reviewerCleanups.delete(conversationId);
  for (const cleanup of cleanups) {
    try {
      cleanup();
    } catch {
      // Best-effort listener cleanup.
    }
  }
}

function reportStatus(report: ReviewGateReport): AttemptReviewGate["status"] {
  if (report.verdict === "pass") return "passed";
  if (report.verdict === "blocked") return "blocked";
  return "changes_requested";
}

function reviewerTurnCompleted(conversation: AgentConversation | undefined): boolean {
  if (!conversation || conversation.messages.some((message) => message.isStreaming)) return false;
  const lastAssistant = [...conversation.messages]
    .reverse()
    .find((message) => message.role === "assistant");
  // Older persisted sessions used done. Current API sessions settle to idle,
  // which also represents cancellation and therefore requires a receipt.
  return (
    (conversation.status === "done" &&
      !["cancelled", "failed"].includes(lastAssistant?.turnOutcome ?? "")) ||
    (conversation.status === "idle" && lastAssistant?.turnOutcome === "completed")
  );
}

async function finishReviewer(
  flightId: string,
  attemptId: string,
  conversationId: string,
): Promise<void> {
  const key = attemptKey(flightId, attemptId);
  if (finishingAttempts.has(key)) return;
  const attempt = currentAttempt(flightId, attemptId);
  if (
    !attempt ||
    attempt.reviewGate?.status !== "running" ||
    attempt.reviewGate.reviewerConversationId !== conversationId
  )
    return;
  finishingAttempts.add(key);
  const conversation = useAgentTaskStore
    .getState()
    .conversations.find((item) => item.id === conversationId);
  try {
    if (!reviewerTurnCompleted(conversation))
      throw new Error("The reviewer session failed or was interrupted. Retry the reviewer.");
    const parsedReport = parseLatestReviewGateReport(conversation?.messages ?? []);
    const reviewerSource = [...(conversation?.messages ?? [])]
      .reverse()
      .find((message) => message.role === "assistant")?.provenance;
    const report: ReviewGateReport = {
      ...parsedReport,
      provenance: derivedArtifactProvenance(
        `${attemptId}-review-report`,
        "Independent reviewer report",
        reviewerSource ? [reviewerSource] : [],
      ),
    };
    const status = reportStatus(report);
    const applied = await patchReviewGate(
      flightId,
      attemptId,
      {
        ...attempt.reviewGate,
        status,
        report,
        errorMessage: undefined,
        completedAt: Date.now(),
      },
      attempt.reviewGate,
    );
    if (!applied) return;
    useFlightStore.getState().appendCoordinationEvent(flightId, {
      type: "review_resolved",
      taskId: attemptId,
      agentId: attempt.reviewGate.reviewerAgentConfigId,
      summary:
        status === "passed"
          ? "Independent Reviewer Gate passed."
          : `Independent Reviewer Gate returned ${report.verdict.replace(/_/g, " ")}: ${report.summary}`,
      metadata: {
        attemptId,
        reviewerConversationId: conversationId,
        verdict: report.verdict,
      },
      provenance: report.provenance,
    });
  } catch (error) {
    // A failed persistence already exposes a retryable error; a newer user
    // decision must not be replaced by this older completion's fallback.
    if (currentAttempt(flightId, attemptId)?.reviewGate?.status !== "running") return;
    const message = error instanceof Error ? error.message : String(error);
    const applied = await patchReviewGate(
      flightId,
      attemptId,
      {
        ...attempt.reviewGate,
        status: "error",
        errorMessage: message,
        completedAt: Date.now(),
      },
      attempt.reviewGate,
    );
    if (!applied) return;
    useFlightStore.getState().appendCoordinationEvent(flightId, {
      type: "review_resolved",
      taskId: attemptId,
      agentId: attempt.reviewGate.reviewerAgentConfigId,
      summary: `Independent Reviewer Gate could not produce a valid verdict: ${message}`,
      metadata: {
        attemptId,
        reviewerConversationId: conversationId,
        verdict: "error",
      },
    });
  } finally {
    finishingAttempts.delete(key);
    detachReviewerListeners(conversationId);
  }
}

async function installReviewerListeners(
  flightId: string,
  attemptId: string,
  conversationId: string,
): Promise<void> {
  if (reviewerCleanups.has(conversationId)) return;
  const cleanups: UnlistenFn[] = [];
  reviewerCleanups.set(conversationId, cleanups);

  const done = await listen(apiAgentDoneEvent(conversationId), () => {
    // Let the normal conversation listener flush the final streamed chunk.
    setTimeout(() => {
      void finishReviewer(flightId, attemptId, conversationId).catch(console.error);
    }, 0);
  });
  if (reviewerCleanups.has(conversationId)) cleanups.push(done);
  else done();

  const failed = await listen<{ message?: string }>(apiAgentErrorEvent(conversationId), (event) => {
    const attempt = currentAttempt(flightId, attemptId);
    if (
      !attempt ||
      attempt.reviewGate?.status !== "running" ||
      attempt.reviewGate.reviewerConversationId !== conversationId
    )
      return;
    const message = event.payload?.message?.trim() || "The reviewer session failed.";
    void patchReviewGate(
      flightId,
      attemptId,
      {
        ...attempt.reviewGate,
        status: "error",
        errorMessage: message,
        completedAt: Date.now(),
      },
      attempt.reviewGate,
    ).catch(console.error);
    useFlightStore.getState().appendCoordinationEvent(flightId, {
      type: "review_resolved",
      taskId: attemptId,
      agentId: attempt.reviewGate.reviewerAgentConfigId,
      summary: `Independent Reviewer Gate failed: ${message}`,
      metadata: {
        attemptId,
        reviewerConversationId: conversationId,
        verdict: "error",
      },
    });
    detachReviewerListeners(conversationId);
  });
  if (reviewerCleanups.has(conversationId)) cleanups.push(failed);
  else failed();
}

async function cancelReviewerStartup(
  flightId: string,
  attemptId: string,
  conversationId: string,
  expectedGate?: AttemptReviewGate,
): Promise<void> {
  detachReviewerListeners(conversationId);
  const gate = currentAttempt(flightId, attemptId)?.reviewGate;
  if (
    !gate ||
    !(
      (gate.status === "running" && gate.reviewerConversationId === conversationId) ||
      (expectedGate &&
        gate.status === expectedGate.status &&
        gate.reviewerConversationId === expectedGate.reviewerConversationId)
    )
  )
    return;
  await patchReviewGate(
    flightId,
    attemptId,
    {
      ...gate,
      status: "error",
      errorMessage:
        "Automatic reviewer startup was paused or stopped before the provider started. Retry when ready.",
    },
    gate,
  );
}

export async function startReviewGate(
  flightId: string,
  attemptId: string,
  options: { force?: boolean; expectedGate?: AttemptReviewGate; canStart?: () => boolean } = {},
): Promise<void> {
  const key = attemptKey(flightId, attemptId);
  if (startingAttempts.has(key)) return;
  if (options.canStart?.() === false) {
    await cancelReviewerStartup(flightId, attemptId, "", options.expectedGate);
    return;
  }

  const flight = currentFlight(flightId);
  const attempt = currentAttempt(flightId, attemptId);
  const policy = flight?.reviewGatePolicy;
  if (
    !flight ||
    flight.stoppedAt ||
    flight.archivedAt ||
    !attempt ||
    attempt.status !== "reviewing" ||
    !policy?.enabled
  )
    return;
  if (!options.force && attempt.reviewGate) return;
  if (attempt.reviewGate?.status === "overridden") return;
  if (
    options.expectedGate &&
    (attempt.reviewGate?.status !== options.expectedGate.status ||
      attempt.reviewGate?.reviewerConversationId !== options.expectedGate.reviewerConversationId)
  )
    return;

  startingAttempts.add(key);
  const ticket = registerFlightStartup(flightId);
  const requestedGuard = options.canStart;
  options = {
    ...options,
    canStart: () =>
      ticket.isCurrent() &&
      !currentFlight(flightId)?.stoppedAt &&
      !currentFlight(flightId)?.archivedAt &&
      requestedGuard?.() !== false,
  };
  // A persisted policy can name a provider that no longer exists — chiefly
  // `api-openai-codex`, removed in 2026-07. Substituting its designated
  // replacement is the one place a retired id SHOULD be remapped: a reviewer
  // gate that silently no-ops is strictly worse than one that reviews with a
  // comparable model, and the alternative (an unroutable provider) fails the
  // attempt for a reason the user cannot act on. Conversations get the
  // opposite treatment — read-only, explicit user switch, never automatic.
  const reviewerAgent = resolveRetiredApiAgent(policy.reviewerAgentConfigId as AgentCli);
  // Also re-derive the model when the agent was substituted: a `gpt-5.5`
  // pinned for Codex is not necessarily a model the replacement offers, and
  // `getDefaultModel` on a retired id returns "" (an empty model string is
  // how this used to reach the backend).
  const substituted = reviewerAgent !== policy.reviewerAgentConfigId;
  const reviewerModel = (substituted ? "" : policy.reviewerModel) || getDefaultModel(reviewerAgent);
  const conversationId = `review-${crypto.randomUUID()}`;
  const startedAt = Date.now();
  try {
    await useFlightStore.getState().flushPersistence();
    if (options.canStart?.() === false) {
      await cancelReviewerStartup(flightId, attemptId, conversationId, options.expectedGate);
      return;
    }
    const freshFlight = currentFlight(flightId);
    const freshAttempt = currentAttempt(flightId, attemptId);
    if (
      !freshFlight ||
      !freshAttempt ||
      freshAttempt.status !== "reviewing" ||
      !freshFlight.reviewGatePolicy?.enabled
    )
      return;
    const evidenceSnapshot = await captureAttemptReviewEvidence(flightId, attemptId);
    if (options.canStart?.() === false) {
      await cancelReviewerStartup(flightId, attemptId, conversationId, options.expectedGate);
      return;
    }
    const reviewerSessions = [
      ...(attempt.reviewGate?.reviewerSessions ?? []),
      {
        sessionId: conversationId,
        provider: apiAgentProvider(reviewerAgent),
        model: reviewerModel,
      },
    ];
    const applied = await patchReviewGate(
      flightId,
      attemptId,
      {
        status: "running",
        reviewerConversationId: conversationId,
        reviewerAgentConfigId: reviewerAgent,
        reviewerModel,
        startedAt,
        evidence: evidenceSnapshot,
        reviewerSessions,
      },
      options.expectedGate,
    );
    if (!applied) return;
    if (options.canStart?.() === false) {
      await cancelReviewerStartup(flightId, attemptId, conversationId, options.expectedGate);
      return;
    }

    const builderConversation = useAgentTaskStore
      .getState()
      .conversations.find((conversation) => conversation.id === attempt.sessionId);
    const evidence = await buildReviewEvidenceBundle(freshFlight, freshAttempt, {
      snapshot: evidenceSnapshot,
      builderConversation,
      lookupServer: (id) => useServerStore.getState().getServer(id),
    });
    if (options.canStart?.() === false) {
      await cancelReviewerStartup(flightId, attemptId, conversationId, options.expectedGate);
      return;
    }
    if (
      currentAttempt(flightId, attemptId)?.reviewGate?.status !== "running" ||
      currentAttempt(flightId, attemptId)?.reviewGate?.reviewerConversationId !== conversationId
    )
      return;
    await installReviewerListeners(flightId, attemptId, conversationId);
    if (options.canStart?.() === false) {
      await cancelReviewerStartup(flightId, attemptId, conversationId, options.expectedGate);
      return;
    }

    const server =
      attempt.target.kind === "ssh"
        ? useServerStore.getState().getServer(attempt.target.serverId)
        : undefined;
    if (attempt.target.kind === "ssh" && !server) {
      throw new Error("The SSH server used by this attempt is no longer configured.");
    }
    const sshTarget = server
      ? {
          serverId: server.id,
          name: server.name,
          host: server.host,
          port: server.port,
          user: server.username,
          remotePath: attempt.target.worktreePath,
          keyPath: server.keyPath ?? null,
          authMethod: server.authMethod,
          hostFingerprint: server.hostFingerprint ?? null,
        }
      : null;

    useFlightStore.getState().appendCoordinationEvent(flightId, {
      type: "review_requested",
      taskId: attemptId,
      agentId: reviewerAgent,
      summary: `Started an independent read-only review with ${reviewerAgent}.`,
      metadata: {
        attemptId,
        reviewerConversationId: conversationId,
        reviewerModel,
      },
    });

    if (
      currentAttempt(flightId, attemptId)?.reviewGate?.status !== "running" ||
      currentAttempt(flightId, attemptId)?.reviewGate?.reviewerConversationId !== conversationId
    ) {
      detachReviewerListeners(conversationId);
      return;
    }
    if (options.canStart?.() === false) {
      await cancelReviewerStartup(flightId, attemptId, conversationId, options.expectedGate);
      return;
    }
    await useAgentTaskStore.getState().createApiConversation({
      explicitId: conversationId,
      agent: reviewerAgent,
      projectPath: attempt.target.worktreePath,
      model: reviewerModel,
      initialMessage: buildReviewerInitialMessage(evidence),
      systemPromptOverride: buildReviewerSystemPrompt(),
      planMode: true,
      sshTarget,
      allowedTools: REVIEWER_ALLOWED_TOOLS,
      enabledMcpServerIds: [],
      memoryContextEnabled: false,
      permissionMode: "deny_all",
      approveWrites: false,
    });
    useAgentTaskStore.setState((state) => ({
      conversations: state.conversations.map((conversation) =>
        conversation.id === conversationId
          ? { ...conversation, title: `Review — ${flight.title}` }
          : conversation,
      ),
    }));
    requestConversationSave(conversationId);
    useFlightStore.getState().updateFlight(flightId, {
      linkedSessionIds: Array.from(
        new Set([...(currentFlight(flightId)?.linkedSessionIds ?? []), conversationId]),
      ),
    });

    const created = useAgentTaskStore
      .getState()
      .conversations.find((conversation) => conversation.id === conversationId);
    if (created?.status === "failed") {
      throw new Error("The reviewer session could not be started.");
    }
    if (reviewerTurnCompleted(created)) await finishReviewer(flightId, attemptId, conversationId);
  } catch (error) {
    detachReviewerListeners(conversationId);
    const message = error instanceof Error ? error.message : String(error);
    const fresh = currentAttempt(flightId, attemptId);
    if (
      fresh &&
      (fresh.reviewGate?.reviewerConversationId === conversationId ||
        (fresh.reviewGate?.status === attempt.reviewGate?.status &&
          fresh.reviewGate?.reviewerConversationId === attempt.reviewGate?.reviewerConversationId))
    ) {
      await patchReviewGate(flightId, attemptId, {
        ...fresh.reviewGate,
        reviewerSessions:
          fresh.reviewGate?.reviewerSessions ?? attempt.reviewGate?.reviewerSessions,
        reviewerConversationId: conversationId,
        reviewerAgentConfigId: reviewerAgent,
        reviewerModel,
        status: "error",
        errorMessage: message,
        completedAt: Date.now(),
      });
      useFlightStore.getState().appendCoordinationEvent(flightId, {
        type: "review_resolved",
        taskId: attemptId,
        agentId: reviewerAgent,
        summary: `Independent Reviewer Gate failed to start: ${message}`,
        metadata: { attemptId, reviewerConversationId: conversationId, verdict: "error" },
      });
    }
  } finally {
    startingAttempts.delete(key);
    ticket.finish();
  }
}

export async function retryReviewGate(
  flightId: string,
  attemptId: string,
  canStart?: () => boolean,
): Promise<void> {
  if (canStart?.() === false) return;
  if (startingAttempts.has(attemptKey(flightId, attemptId))) return;
  const attempt = currentAttempt(flightId, attemptId);
  if (!attempt?.reviewGate) return;
  if (attempt.status !== "reviewing") {
    throw new Error(
      "Accepted attempts cannot restart the reviewer after worktree cleanup. Use an explicit override or a new reviewed attempt.",
    );
  }
  if (attempt.reviewGate.status === "overridden") return;
  const pending: AttemptReviewGate = {
    reviewerSessions: attempt.reviewGate.reviewerSessions,
    status: "pending",
    reviewerConversationId: attempt.reviewGate.reviewerConversationId,
    reviewerAgentConfigId: attempt.reviewGate.reviewerAgentConfigId,
    reviewerModel: attempt.reviewGate.reviewerModel,
  };
  if (!(await patchReviewGate(flightId, attemptId, pending, attempt.reviewGate))) return;
  if (canStart?.() === false) {
    await cancelReviewerStartup(flightId, attemptId, "", pending);
    return;
  }
  await startReviewGate(flightId, attemptId, { force: true, expectedGate: pending, canStart });
}

export async function overrideReviewGate(
  flightId: string,
  attemptId: string,
  reason: string,
): Promise<void> {
  const normalized = reason.trim();
  if (normalized.length < 3) throw new Error("An override reason is required.");
  if (normalized.length > 2_000) throw new Error("The override reason is too long.");
  const attempt = currentAttempt(flightId, attemptId);
  if (!attempt?.reviewGate || attempt.reviewGate.status === "passed") return;
  await patchReviewGate(flightId, attemptId, {
    ...attempt.reviewGate,
    status: "overridden",
    overriddenAt: Date.now(),
    overrideReason: normalized,
  });
  useFlightStore.getState().appendCoordinationEvent(flightId, {
    type: "review_resolved",
    taskId: attemptId,
    agentId: "user",
    summary: `Reviewer Gate overridden by the user: ${normalized}`,
    metadata: {
      attemptId,
      verdict: "overridden",
      overrideReason: normalized,
    },
  });
  await useFlightStore.getState().flushPersistence();
}

export async function sendReviewFindingsToBuilder(
  flightId: string,
  attemptId: string,
): Promise<void> {
  if (currentFlight(flightId)?.stoppedAt || currentFlight(flightId)?.archivedAt)
    throw new Error("Resume this Flight explicitly before sending a repair turn.");
  const attempt = currentAttempt(flightId, attemptId);
  const report = attempt?.reviewGate?.report;
  if (!attempt || !report) throw new Error("No structured reviewer findings are available.");
  const reviewerConversationId = attempt.reviewGate?.reviewerConversationId ?? "";
  const builder = useAgentTaskStore
    .getState()
    .conversations.find((conversation) => conversation.id === attempt.sessionId);
  if (!builder) throw new Error("The builder conversation is no longer available.");
  if (attempt.status !== "reviewing" || builder.mode !== "api")
    throw new Error("Only an API attempt awaiting review can receive a repair turn.");
  await useAgentTaskStore
    .getState()
    .sendMessageWithReceipt(attempt.sessionId, buildReviewerRemediationPrompt(report), undefined, {
      requireIdle: true,
    });
  useFlightStore.getState().appendCoordinationEvent(flightId, {
    type: "handoff",
    taskId: attemptId,
    agentId: attempt.agentConfigId,
    summary: "Sent the independent reviewer findings to the builder for one remediation turn.",
    metadata: {
      attemptId,
      reviewerConversationId,
      verdict: report.verdict,
    },
  });
}

export async function syncReviewerGateRuns(
  flights = useFlightStore.getState().flights,
): Promise<void> {
  if (!useAppStore.getState().initialized) return;
  for (const flight of flights) {
    if (flight.stoppedAt || flight.archivedAt) continue;
    if (!flight.reviewGatePolicy?.enabled) continue;
    for (const attempt of flight.attempts ?? []) {
      if (attempt.status !== "reviewing") continue;
      if (startingAttempts.has(attemptKey(flight.id, attempt.id))) continue;
      const gate = attempt.reviewGate;
      if (!gate) {
        void startReviewGate(flight.id, attempt.id).catch(console.error);
        continue;
      }
      if (gate.status === "passed" && !gate.evidence) {
        await patchReviewGate(
          flight.id,
          attempt.id,
          {
            ...gate,
            status: "error",
            errorMessage:
              "This saved review has no code fingerprint. Retry the reviewer before accepting this attempt.",
          },
          gate,
        );
        continue;
      }
      if (gate.status !== "running") continue;
      const conversation = useAgentTaskStore
        .getState()
        .conversations.find((item) => item.id === gate.reviewerConversationId);
      if (reviewerTurnCompleted(conversation) && gate.reviewerConversationId) {
        await finishReviewer(flight.id, attempt.id, gate.reviewerConversationId);
      } else if (!conversation || conversation.status !== "active") {
        await patchReviewGate(
          flight.id,
          attempt.id,
          {
            ...gate,
            status: "error",
            errorMessage: "The reviewer session failed or was interrupted. Retry the reviewer.",
            completedAt: Date.now(),
          },
          gate,
        );
      } else if (conversation && gate.reviewerConversationId) {
        await installReviewerListeners(flight.id, attempt.id, gate.reviewerConversationId);
      }
    }
  }
}

function queueSync(): void {
  if (syncQueued) return;
  syncQueued = true;
  queueMicrotask(() => {
    syncQueued = false;
    void syncReviewerGateRuns().catch(console.error);
  });
}

if (typeof useFlightStore.subscribe === "function") useFlightStore.subscribe(queueSync);
if (typeof useAgentTaskStore.subscribe === "function") useAgentTaskStore.subscribe(queueSync);
useAppStore.subscribe(queueSync);
queueSync();
