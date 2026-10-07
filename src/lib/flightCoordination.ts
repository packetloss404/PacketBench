import type { Attempt, CoordinationEvent } from "@/types/flight";
import { useFlightStore } from "@/stores/flightStore";
import { API_PROVIDERS, getProviderForAgent } from "@/lib/api-models";
import type { AgentCli } from "@/stores/agentTaskStore";
import { useIssueStore } from "@/stores/issueStore";

/**
 * N2 — escalation *suggestions* (never auto-actions) on the flight coordination
 * timeline. Flights run via the attempt-based path; when an attempt fails we
 * record an informational `task_failed` event, and when the flight is left with
 * no path forward (all attempts failed/cancelled, none succeeded) we add one
 * `escalation` suggestion. The suggestion is surfaced in FlightsView's timeline;
 * nothing is reassigned automatically.
 */

const ESCALATION_SUMMARY =
  "No attempt has succeeded — consider reassigning to a different agent, revising the prompt, or reviewing the failures manually.";

function attemptLabel(a: Attempt): string {
  const where = a.target.kind === "ssh" ? a.target.serverId : "local";
  return `${a.provider} (${where})`;
}

function truncate(s: string, max = 140): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length <= max ? t : `${t.slice(0, max - 1)}…`;
}

function agentLabel(agentId: string): string {
  return getProviderForAgent(agentId as AgentCli)?.name ?? agentId;
}

/**
 * E3: pick a concrete alternative agent to suggest for reassignment — the first
 * catalog agent the flight hasn't already tried. Returns undefined when every
 * catalog agent has been tried (nothing new to suggest).
 */
export function suggestReassignmentAgent(
  triedAgentIds: string[],
  // One-click suggestions have no model picker; require a concrete default.
  catalog: string[] = API_PROVIDERS.filter((p) => p.models.length > 0).map((p) => p.agentCli),
): string | undefined {
  const tried = new Set(triedAgentIds);
  return catalog.find((id) => !tried.has(id));
}

/**
 * E5: resolve the one-click reassignment an escalation row offers — its
 * `suggestedAgentId` plus a concrete failed attempt to use as the launch
 * template (the most recent failure). Returns null when the event is not an
 * actionable escalation (no suggestion, or no failed attempt to template from).
 */
export function reassignTargetFromEscalation(
  event: CoordinationEvent,
  attempts: Attempt[],
): { attemptId: string; agentId: string } | null {
  if (event.type !== "escalation") return null;
  const agentId = event.metadata?.suggestedAgentId;
  if (!agentId) return null;
  const template = [...attempts].reverse().find((a) => a.status === "failed");
  if (!template) return null;
  return { attemptId: template.id, agentId };
}

/**
 * E7: active issue statuses worth flagging `needs_human` when their flight
 * escalates. Not backlog/done (not in-flight) or already blocked/needs_human.
 */
const FLAGGABLE_ISSUE_STATUSES = new Set(["up_next", "todo", "in_progress", "in_review", "qa"]);

/** E7 (pure): ids of a flight's linked issues that an escalation should flag. */
export function issuesToFlagNeedsHuman(
  issues: { id: string; flightId: string | null; status: string }[],
  flightId: string,
): string[] {
  return issues
    .filter((i) => i.flightId === flightId && FLAGGABLE_ISSUE_STATUSES.has(i.status))
    .map((i) => i.id);
}

/**
 * E7: flag a flight's active linked issues `needs_human` so they surface in the
 * issue board's "Needs Attention" column when the flight escalates.
 */
function flagLinkedIssuesNeedHuman(flightId: string): void {
  const store = useIssueStore.getState();
  for (const id of issuesToFlagNeedsHuman(store.issues, flightId)) {
    store.updateIssue(id, { status: "needs_human" });
  }
}

/**
 * A flight is "stuck" when every attempt is terminal-without-success — all
 * failed or cancelled, with at least one genuine failure. `reviewing`,
 * `completed`, `running`, and `provisioning` all mean a path forward still
 * exists, so those never count as stuck.
 */
export function isFlightStuck(attempts: Attempt[]): boolean {
  if (attempts.length === 0) return false;
  return (
    attempts.every((a) => a.status === "failed" || a.status === "cancelled") &&
    attempts.some((a) => a.status === "failed")
  );
}

/** Signature of the current attempt set, so a re-run (new attempts) escalates
 *  again rather than being deduped against the prior stuck state. */
export function stuckSignature(attempts: Attempt[]): string {
  return attempts
    .map((a) => `${a.id}:${a.status}`)
    .sort()
    .join("|");
}

/** Escalate at most once per stuck state (deduped by signature). */
export function shouldEscalate(attempts: Attempt[], log: CoordinationEvent[]): boolean {
  if (!isFlightStuck(attempts)) return false;
  const sig = stuckSignature(attempts);
  return !log.some((e) => e.type === "escalation" && e.metadata?.signature === sig);
}

/**
 * Evaluate the flight's current state and, if it is now stuck, append one
 * (signature-deduped) `escalation` suggestion. Reads the store fresh so callers
 * can invoke it right after a status patch. Safe to call on any terminal
 * transition (failure OR cancellation) — the stuck/dedup logic decides.
 */
export function maybeEscalate(flightId: string): void {
  const fresh = useFlightStore.getState().flights.find((f) => f.id === flightId);
  if (!fresh) return;
  const attempts = fresh.attempts ?? [];
  if (!shouldEscalate(attempts, fresh.coordinationLog ?? [])) return;
  // E3: name a concrete alternative agent the flight hasn't tried yet, so the
  // suggestion (and the one-click reassign in the timeline) has a target.
  const suggestedAgentId = suggestReassignmentAgent(attempts.map((a) => a.agentConfigId));
  const suggestion = suggestedAgentId
    ? ` Suggested: reassign to ${agentLabel(suggestedAgentId)}.`
    : "";
  useFlightStore.getState().appendCoordinationEvent(flightId, {
    type: "escalation",
    summary: ESCALATION_SUMMARY + suggestion,
    metadata: {
      signature: stuckSignature(attempts),
      ...(suggestedAgentId ? { suggestedAgentId } : {}),
    },
  });
  // E7: surface the stuck flight on the issue board.
  flagLinkedIssuesNeedHuman(flightId);
}

/**
 * On an attempt failure: append an informational `task_failed` event, then — if
 * the flight is now stuck — one `escalation` suggestion. Called from both the
 * runtime terminal listener and the UI reject path.
 */
export function recordAttemptFailure(
  flightId: string,
  attemptId: string,
  errorMessage?: string,
): void {
  const store = useFlightStore.getState();
  const flight = store.flights.find((f) => f.id === flightId);
  if (!flight) return;
  const attempt = flight.attempts?.find((a) => a.id === attemptId);

  store.appendCoordinationEvent(flightId, {
    type: "task_failed",
    taskId: attemptId,
    agentId: attempt?.agentConfigId,
    summary: attempt
      ? `Attempt ${attemptLabel(attempt)} failed${errorMessage ? `: ${truncate(errorMessage)}` : ""}.`
      : `An attempt failed${errorMessage ? `: ${truncate(errorMessage)}` : ""}.`,
  });

  // Re-read (inside maybeEscalate) after the append so escalation is evaluated
  // against the latest attempt statuses and coordination log.
  maybeEscalate(flightId);
}

/* ------------------------------------------------------------------ *
 * E2 — stuck-threshold detection.
 *
 * `isFlightStuck` above only fires once *every* attempt is terminal. A single
 * attempt that just hangs (running, never emitting a terminal event) would
 * otherwise never escalate. The sweep below raises one (per-attempt-deduped)
 * escalation for any attempt that has been `running` past a wall-clock
 * threshold.
 * ------------------------------------------------------------------ */

/** Default: an attempt running longer than 15 minutes is treated as stalled. */
export const DEFAULT_STALL_THRESHOLD_MS = 15 * 60_000;

/** True when an attempt has been `running` longer than `thresholdMs`. */
export function isAttemptStalled(
  attempt: Attempt,
  nowMs: number,
  thresholdMs = DEFAULT_STALL_THRESHOLD_MS,
): boolean {
  return (
    attempt.status === "running" &&
    typeof attempt.startedAt === "number" &&
    nowMs - attempt.startedAt > thresholdMs
  );
}

/** Escalate a stalled attempt at most once, deduped by its id in the log. */
export function shouldEscalateStalled(
  attempt: Attempt,
  nowMs: number,
  log: CoordinationEvent[],
  thresholdMs = DEFAULT_STALL_THRESHOLD_MS,
): boolean {
  if (!isAttemptStalled(attempt, nowMs, thresholdMs)) return false;
  return !log.some((e) => e.type === "escalation" && e.metadata?.stalledAttemptId === attempt.id);
}

/** Append one escalation per newly-stalled running attempt on the flight. */
export function maybeEscalateStalled(
  flightId: string,
  nowMs: number,
  thresholdMs = DEFAULT_STALL_THRESHOLD_MS,
): void {
  const store = useFlightStore.getState();
  const flight = store.flights.find((f) => f.id === flightId);
  if (!flight) return;
  const log = flight.coordinationLog ?? [];
  let escalated = false;
  for (const attempt of flight.attempts ?? []) {
    if (!shouldEscalateStalled(attempt, nowMs, log, thresholdMs)) continue;
    const mins = Math.round((nowMs - (attempt.startedAt ?? nowMs)) / 60_000);
    store.appendCoordinationEvent(flightId, {
      type: "escalation",
      taskId: attempt.id,
      agentId: attempt.agentConfigId,
      summary: `Attempt ${attemptLabel(attempt)} has been running ${mins}m without finishing — consider reassigning or checking on it.`,
      metadata: { stalledAttemptId: attempt.id },
    });
    escalated = true;
  }
  // E7: a newly-stalled flight surfaces on the issue board too.
  if (escalated) flagLinkedIssuesNeedHuman(flightId);
}

/**
 * Start a periodic sweep for stalled running attempts across all flights.
 * Returns a stop function. Runs only while some attempt is `running`.
 */
export function startStallSweep(intervalMs = 60_000): () => void {
  const tick = () => {
    const now = Date.now();
    for (const f of useFlightStore.getState().flights) {
      if ((f.attempts ?? []).some((a) => a.status === "running")) {
        maybeEscalateStalled(f.id, now);
      }
    }
  };
  const handle = setInterval(tick, intervalMs);
  return () => clearInterval(handle);
}
