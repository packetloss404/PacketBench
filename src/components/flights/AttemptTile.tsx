import { useEffect, useRef, useState } from "react";
import {
  Folder,
  GitPullRequest,
  Server,
  Square,
  Check,
  X as XIcon,
  Loader2,
  CheckCircle2,
  Send,
  RotateCcw,
  ShieldCheck,
  MonitorUp,
  PanelsTopLeft,
  GitMerge,
  MessageSquareText,
} from "lucide-react";
import { useAgentTaskStore } from "@/stores/agentTaskStore";
import {
  attemptLandability,
  describeAttemptDecisionImpact,
  inspectAttemptWorktree,
  useAsyncFlightStore,
  type AttemptDecision,
  type AttemptWorktreeCleanliness,
} from "@/stores/asyncFlightStore";
import { ConfirmDeleteModal } from "@/components/ui/ConfirmDeleteModal";
import { MarkdownRenderer } from "@/components/common/MarkdownRenderer";
import { FlightAttemptEvidence } from "./FlightAttemptEvidence";
import { notifyAttemptFailed } from "@/lib/notifications";
import { reviewerGateAllowsAcceptance } from "@/lib/reviewerGate";
import { inspectFlightAttemptInWorkspace } from "@/lib/agentHandoffs";
import { openConversationInAgents } from "@/stores/sessionGlue";
import { openMonitorWindow } from "@/lib/monitorWindows";
import type { Attempt, AttemptStatus, Flight } from "@/types/flight";
import type { AgentMessage } from "@/types/agent-conversation";

const STATUS_META: Record<AttemptStatus, { label: string; color: string }> = {
  queued: { label: "Queued", color: "text-text-muted" },
  provisioning: { label: "Preparing branch", color: "text-accent-blue" },
  running: { label: "Working", color: "text-accent-blue" },
  reviewing: { label: "Ready for review", color: "text-accent-amber" },
  completed: { label: "Accepted · ready to deliver", color: "text-accent-green" },
  failed: { label: "Needs attention", color: "text-accent-red" },
  cancelled: { label: "Stopped", color: "text-text-muted" },
};
const EMPTY_MESSAGES: AgentMessage[] = [];
const BUTTON =
  "inline-flex items-center gap-1.5 rounded border border-bg-border px-2.5 py-1.5 text-[11px] text-text-secondary hover:bg-bg-hover disabled:cursor-not-allowed disabled:opacity-40";

export function AttemptTile({
  flight,
  attempt,
  onNewAttempt,
}: {
  flight: Flight;
  attempt: Attempt;
  onNewAttempt?: () => void;
}) {
  const conversation = useAgentTaskStore((state) =>
    state.conversations.find((item) => item.id === attempt.sessionId),
  );
  const sendMessage = useAgentTaskStore((state) => state.sendMessageWithReceipt);
  const stopFlight = useAsyncFlightStore((state) => state.stopFlight);
  const setAttemptStatus = useAsyncFlightStore((state) => state.setAttemptStatus);
  const landAttempt = useAsyncFlightStore((state) => state.landAttempt);
  const publishAttemptPr = useAsyncFlightStore((state) => state.publishAttemptPr);
  const retryReviewGate = useAsyncFlightStore((state) => state.retryReviewGate);
  const overrideReviewGate = useAsyncFlightStore((state) => state.overrideReviewGate);
  const sendReviewFindingsToBuilder = useAsyncFlightStore(
    (state) => state.sendReviewFindingsToBuilder,
  );
  const resumeRetainedAttempt = useAsyncFlightStore((state) => state.resumeRetainedAttempt);
  const discardRetainedWorktree = useAsyncFlightStore((state) => state.discardRetainedWorktree);
  const [followUp, setFollowUp] = useState("");
  const [overrideOpen, setOverrideOpen] = useState(false);
  const [overrideReason, setOverrideReason] = useState("");
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [decision, setDecision] = useState<AttemptDecision | null>(null);
  const [discardOpen, setDiscardOpen] = useState(false);
  const [cleanliness, setCleanliness] = useState<AttemptWorktreeCleanliness | null>(null);
  const [landNote, setLandNote] = useState<string | null>(null);
  const messages = conversation?.messages ?? EMPTY_MESSAGES;
  const gate = attempt.reviewGate;
  const delivery = attempt.delivery;
  const retained = attempt.recovery?.state === "retained";
  const cooperativeTask = flight.executionMode === "cooperative" && Boolean(attempt.taskId);
  const inProgress = ["queued", "provisioning", "running"].includes(attempt.status);
  const acceptance = reviewerGateAllowsAcceptance(flight, attempt);
  const landability = attemptLandability(attempt);
  const task = flight.milestones
    .flatMap((milestone) => milestone.tasks)
    .find((item) => item.id === attempt.taskId);
  const summary = [...messages]
    .reverse()
    .find(
      (message) => message.role === "assistant" && message.content.trim() && !message.isStreaming,
    )?.content;
  const label = delivery
    ? delivery.kind === "landed"
      ? "Landed"
      : "PR opened"
    : cooperativeTask && attempt.status === "completed"
      ? "Integrated task"
      : STATUS_META[attempt.status].label;
  const attemptLabel = attempt.target.kind === "ssh" ? attempt.target.serverId : "local";

  useEffect(() => {
    if (attempt.status === "failed")
      void notifyAttemptFailed(flight.title, attemptLabel, attempt.errorMessage);
  }, [attempt.status, attempt.errorMessage, flight.title, attemptLabel]);
  useEffect(() => {
    if (!decision) return;
    let current = true;
    setCleanliness(null);
    void inspectAttemptWorktree(attempt)
      .then((result) => {
        if (current) setCleanliness(result);
      })
      .catch(() => {
        if (current) setCleanliness("unknown");
      });
    return () => {
      current = false;
    };
  }, [decision, attempt]);

  async function runAction(action: () => Promise<unknown>) {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setActionError(null);
    try {
      await action();
    } catch (reason) {
      setActionError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }
  async function confirmDecision() {
    const pending = decision;
    setDecision(null);
    if (pending)
      await runAction(() =>
        setAttemptStatus(flight.id, attempt.id, pending === "accept" ? "completed" : "failed"),
      );
  }
  function sendFollowUp() {
    const text = followUp.trim();
    if (!text || !conversation) return;
    void runAction(async () => {
      await sendMessage(attempt.sessionId, text, undefined, { requireIdle: true });
      setFollowUp("");
    });
  }
  function inspectInWorkspace() {
    const result = inspectFlightAttemptInWorkspace(flight.id, attempt.id);
    if (!result.ok) setActionError(result.message);
  }

  return (
    <article
      id={`flight-attempt-${attempt.id}`}
      tabIndex={-1}
      aria-label={task?.title ?? `Attempt ${attempt.branch}`}
      aria-busy={busy}
      className="min-w-0 overflow-hidden rounded-lg border border-bg-border bg-bg-primary"
    >
      <header className="flex flex-wrap items-center gap-2 border-b border-bg-border bg-bg-secondary px-3 py-2.5 text-xs">
        {inProgress ? (
          <Loader2 size={13} className="animate-spin text-accent-blue" />
        ) : delivery ? (
          <CheckCircle2 size={13} className="text-accent-green" />
        ) : (
          <ShieldCheck size={13} className={STATUS_META[attempt.status].color} />
        )}
        <h3 className={`font-semibold ${STATUS_META[attempt.status].color}`}>{label}</h3>
        <span className="min-w-0 break-all text-[11px] text-text-muted">{attempt.model}</span>
        <span className="ml-auto text-[11px] text-text-muted">
          {attempt.tokens > 0 ? `${(attempt.tokens / 1000).toFixed(1)}k tokens` : ""}
        </span>
        {attempt.draftPrNumber && (
          <DraftPrLink prNumber={attempt.draftPrNumber} href={delivery?.prUrl} />
        )}
      </header>
      <div className="space-y-2 px-3 py-3 text-xs">
        {task && <p className="font-medium text-text-primary">{task.title}</p>}
        <p className="flex items-start gap-1.5 break-all font-mono text-[11px] text-text-muted">
          {attempt.target.kind === "ssh" ? (
            <Server size={12} className="mt-0.5 shrink-0" />
          ) : (
            <Folder size={12} className="mt-0.5 shrink-0" />
          )}
          {attempt.target.basePath}
        </p>
        <p className="break-all text-[11px] text-text-secondary">
          <span className="font-mono">{attempt.branch}</span> →{" "}
          <span className="font-mono">{attempt.baseBranch}</span>
        </p>
        {delivery && (
          <p role="status" className="break-words text-accent-green">
            {delivery.kind === "landed"
              ? `Landed into ${delivery.baseBranch}${delivery.commitSha ? ` as ${delivery.commitSha.slice(0, 12)}` : ""}.`
              : `Draft PR${delivery.prNumber ? ` #${delivery.prNumber}` : ""} opened for this result.`}
          </p>
        )}
        {attempt.status === "completed" && !delivery && (
          <p className="text-text-secondary">
            {cooperativeTask
              ? "Accepted into the Flight integration branch. Complete the remaining tasks, then review and land the combined Flight."
              : "Accepted. Deliver this branch with Land or Open PR to finish the Flight."}
          </p>
        )}
        {attempt.errorMessage && (
          <p
            role="alert"
            className="break-words rounded border border-accent-red/30 bg-accent-red/10 p-2 text-accent-red"
          >
            {attempt.failureCategory && (
              <span className="mr-1 font-medium">
                {attempt.failureCategory.replace(/_/g, " ")}:
              </span>
            )}
            {attempt.errorMessage}
          </p>
        )}
        {retained && (
          <div className="space-y-2 rounded border border-accent-amber/30 bg-accent-amber/5 p-2 text-text-secondary">
            <p className="font-medium text-accent-amber">Work preserved for recovery</p>
            <p>{attempt.recovery?.reason}</p>
            <p className="break-all font-mono text-[11px]">{attempt.target.worktreePath}</p>
            <div className="flex flex-wrap gap-2">
              <button type="button" className={BUTTON} disabled={busy} onClick={inspectInWorkspace}>
                Inspect preserved work
              </button>
              <button
                type="button"
                className={BUTTON}
                disabled={busy}
                onClick={() => void runAction(() => resumeRetainedAttempt(flight.id, attempt.id))}
              >
                <RotateCcw size={11} /> Continue preserved work
              </button>
              {onNewAttempt && (
                <button type="button" className={BUTTON} disabled={busy} onClick={onNewAttempt}>
                  New attempt
                </button>
              )}
              <button
                type="button"
                className={`${BUTTON} text-accent-red`}
                disabled={busy}
                onClick={() => setDiscardOpen(true)}
              >
                Discard preserved work…
              </button>
            </div>
          </div>
        )}
        {summary && (
          <details open={!inProgress}>
            <summary className="cursor-pointer font-medium text-text-secondary">
              Agent result
            </summary>
            <div className="mt-2 max-h-56 overflow-y-auto break-words">
              <MarkdownRenderer content={summary} />
            </div>
          </details>
        )}
        {!summary && !inProgress && (
          <p className="text-text-muted">
            No result summary was reported. Inspect the changes and any available evidence before
            accepting.
          </p>
        )}
        {actionError && (
          <p
            role="alert"
            className="break-words rounded border border-accent-red/30 bg-accent-red/10 p-2 text-accent-red"
          >
            {actionError}
          </p>
        )}
        {busy && (
          <p role="status" className="flex items-center gap-1 text-text-muted">
            <Loader2 size={11} className="animate-spin" /> Applying action…
          </p>
        )}
        {landNote && (
          <p role="status" className="text-accent-green">
            {landNote}
          </p>
        )}
      </div>

      <fieldset
        disabled={busy}
        className="flex min-w-0 flex-wrap items-center gap-2 border-y border-bg-border bg-bg-secondary px-3 py-2"
      >
        <legend className="sr-only">Attempt actions</legend>
        {attempt.status === "reviewing" && (
          <>
            <button
              type="button"
              className={`${BUTTON} border-accent-green/30 text-accent-green`}
              disabled={!acceptance.allowed}
              title={
                acceptance.allowed
                  ? "Accept reviewed work, then deliver its branch"
                  : acceptance.reason
              }
              onClick={() => setDecision("accept")}
            >
              <Check size={11} /> Accept
            </button>
            <button type="button" className={BUTTON} onClick={() => setDecision("reject")}>
              <XIcon size={11} /> Reject
            </button>
            {!acceptance.allowed && (
              <p className="basis-full text-[11px] text-accent-amber">{acceptance.reason}</p>
            )}
          </>
        )}
        {attempt.status === "completed" && !delivery && !cooperativeTask && (
          <>
            <button
              type="button"
              className={`${BUTTON} border-accent-green/30 text-accent-green`}
              disabled={!landability.allowed}
              title={landability.reason}
              onClick={() =>
                void runAction(async () => {
                  setLandNote(null);
                  const result = await landAttempt(flight.id, attempt.id);
                  if (!result.landed) throw new Error(result.message);
                  setLandNote(result.message);
                })
              }
            >
              <GitMerge size={11} /> Land
            </button>
            <button
              type="button"
              className={BUTTON}
              onClick={() => void runAction(() => publishAttemptPr(flight.id, attempt.id))}
            >
              <GitPullRequest size={11} />{" "}
              {attempt.draftPrNumber ? "Record PR delivery" : "Open PR"}
            </button>
            {!landability.allowed && (
              <p className="basis-full text-[11px] text-text-muted">{landability.reason}</p>
            )}
          </>
        )}
        {conversation && (
          <button
            type="button"
            className={BUTTON}
            onClick={() => openConversationInAgents(conversation.id)}
          >
            <MessageSquareText size={11} /> Open agent conversation
          </button>
        )}
        <button type="button" className={BUTTON} onClick={inspectInWorkspace}>
          <PanelsTopLeft size={11} /> Open in Workspace
        </button>
        {conversation && (
          <button
            type="button"
            className={BUTTON}
            onClick={() =>
              void runAction(() =>
                openMonitorWindow({
                  kind: "agent_conversation",
                  conversationId: attempt.sessionId,
                }),
              )
            }
          >
            <MonitorUp size={11} /> Monitor
          </button>
        )}
        {(inProgress || attempt.status === "reviewing") && (
          <button
            type="button"
            className={BUTTON}
            onClick={() => void runAction(() => stopFlight(flight.id))}
          >
            <Square size={11} /> Stop Flight & retain work
          </button>
        )}
      </fieldset>

      <FlightAttemptEvidence attempt={attempt} conversation={conversation} />
      {flight.reviewGatePolicy?.enabled && (
        <section
          aria-label="Independent review"
          className="space-y-2 border-t border-bg-border px-3 py-3 text-xs"
        >
          <div className="flex flex-wrap items-center gap-2">
            <ShieldCheck size={13} className="text-accent-purple" />
            <h4 className="font-semibold text-text-primary">Independent review</h4>
            <span className="ml-auto text-[11px] text-text-muted">
              {gate?.status.replace(/_/g, " ") ?? "pending"}
            </span>
          </div>
          {gate?.evidence ? (
            <div className="space-y-1 break-all text-[11px] text-text-muted">
              <p>
                Review bound to commit {gate.evidence.headSha.slice(0, 12)} from{" "}
                {gate.evidence.baseSha.slice(0, 12)}.
              </p>
              <p title={gate.evidence.fingerprint}>
                Evidence fingerprint: {gate.evidence.fingerprint}
              </p>
              <p>Code and criteria are checked again before acceptance and delivery.</p>
            </div>
          ) : (
            <p className="text-[11px] text-accent-amber">
              No bound review evidence yet. A review status alone does not establish verified code.
            </p>
          )}
          {gate?.reviewerConversationId && (
            <button
              type="button"
              className={BUTTON}
              onClick={() => openConversationInAgents(gate.reviewerConversationId!)}
            >
              <MessageSquareText size={11} /> Open reviewer conversation
            </button>
          )}
          {gate?.report && (
            <>
              <p className="break-words text-text-secondary">{gate.report.summary}</p>
              <ul className="space-y-2">
                {gate.report.findings.map((finding, index) => (
                  <li
                    key={`${finding.title}-${index}`}
                    className={`rounded border border-bg-border p-2 ${finding.severity === "error" ? "text-accent-red" : finding.severity === "warning" ? "text-accent-amber" : "text-text-secondary"}`}
                  >
                    <p className="font-medium">{finding.title}</p>
                    {finding.filePath && (
                      <p className="break-all font-mono text-[11px]">
                        {finding.filePath}
                        {finding.line ? `:${finding.line}` : ""}
                      </p>
                    )}
                    <p className="break-words text-text-secondary">{finding.details}</p>
                  </li>
                ))}
              </ul>
              <details open>
                <summary className="cursor-pointer text-text-secondary">
                  Reviewer evidence ({gate.report.evidence.length})
                </summary>
                <ul className="mt-1 list-disc space-y-1 break-words pl-4 text-[11px] text-text-muted">
                  {gate.report.evidence.map((item, index) => (
                    <li key={index}>{item}</li>
                  ))}
                </ul>
              </details>
            </>
          )}
          {gate?.errorMessage && (
            <p role="alert" className="break-words text-accent-red">
              {gate.errorMessage}
            </p>
          )}
          {gate?.status === "overridden" && (
            <p className="text-accent-amber">Manual override: {gate.overrideReason}</p>
          )}
          {gate && ["changes_requested", "blocked", "error"].includes(gate.status) && (
            <div className="flex flex-wrap gap-2">
              {attempt.status === "reviewing" && (
                <button
                  type="button"
                  disabled={
                    busy ||
                    conversation?.status === "active" ||
                    messages.some((message) => message.isStreaming)
                  }
                  className={BUTTON}
                  onClick={() => void runAction(() => retryReviewGate(flight.id, attempt.id))}
                >
                  <RotateCcw size={11} /> Retry reviewer
                </button>
              )}
              {attempt.status === "reviewing" && gate.report && (
                <button
                  type="button"
                  disabled={
                    busy ||
                    conversation?.status === "active" ||
                    messages.some((message) => message.isStreaming)
                  }
                  className={BUTTON}
                  onClick={() =>
                    void runAction(() => sendReviewFindingsToBuilder(flight.id, attempt.id))
                  }
                >
                  <Send size={11} /> Send findings to builder
                </button>
              )}
              <button
                type="button"
                disabled={busy}
                className={`${BUTTON} text-accent-amber`}
                onClick={() => setOverrideOpen((value) => !value)}
              >
                Override…
              </button>
            </div>
          )}
          {gate?.status === "error" && attempt.status === "running" && (
            <p className="text-text-secondary">
              The builder is working. Retry the reviewer after this turn finishes.
            </p>
          )}
          {attempt.status === "completed" && gate?.status === "error" && (
            <p className="text-text-secondary">
              This accepted attempt's worktree has been cleaned up. Inspect the retained branch,
              start a new reviewed attempt, or record a manual override before delivery.
            </p>
          )}
          {attempt.status === "completed" && gate?.status === "error" && onNewAttempt && (
            <button type="button" className={BUTTON} onClick={onNewAttempt}>
              Start a new reviewed attempt
            </button>
          )}
          {overrideOpen && gate?.status !== "overridden" && (
            <div className="flex flex-wrap items-start gap-2">
              <label className="min-w-0 flex-1 text-[11px] text-text-secondary">
                Override reason
                <textarea
                  aria-label="Override reason"
                  value={overrideReason}
                  onChange={(event) => setOverrideReason(event.target.value)}
                  rows={2}
                  className="mt-1 block w-full rounded border border-accent-amber/30 bg-bg-primary p-2 text-xs text-text-primary"
                />
              </label>
              <button
                type="button"
                disabled={busy || overrideReason.trim().length < 3}
                className={BUTTON}
                onClick={() =>
                  void runAction(async () => {
                    await overrideReviewGate(flight.id, attempt.id, overrideReason);
                    setOverrideOpen(false);
                    setOverrideReason("");
                  })
                }
              >
                Record override
              </button>
            </div>
          )}
        </section>
      )}

      {(inProgress || attempt.status === "reviewing") && conversation && (
        <div className="space-y-1 border-t border-bg-border px-3 py-3">
          <label
            htmlFor={`followup-${attempt.id}`}
            className="text-[11px] font-medium text-text-secondary"
          >
            Follow up with the builder
          </label>
          <div className="flex items-start gap-2">
            <textarea
              id={`followup-${attempt.id}`}
              value={followUp}
              onChange={(event) => setFollowUp(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                  event.preventDefault();
                  sendFollowUp();
                }
              }}
              rows={2}
              className="min-w-0 flex-1 resize-y rounded border border-bg-border bg-bg-primary p-2 text-xs text-text-primary"
            />
            <button
              type="button"
              className={BUTTON}
              disabled={busy || !followUp.trim()}
              onClick={sendFollowUp}
            >
              <Send size={11} /> Send
            </button>
          </div>
        </div>
      )}
      <details className="border-t border-bg-border px-3 py-3 text-xs">
        <summary className="cursor-pointer font-medium text-text-secondary">
          Activity and transcript ({messages.length})
        </summary>
        <div className="mt-2 max-h-80 space-y-3 overflow-y-auto break-words">
          {messages.length === 0 ? (
            <p className="text-text-muted">No transcript is available on this device.</p>
          ) : (
            messages.map((message) => <MessageRow key={message.id} message={message} />)
          )}
        </div>
      </details>

      {decision && (
        <ConfirmDeleteModal
          title={decision === "accept" ? "Accept this attempt?" : "Reject this attempt?"}
          entityName={attempt.branch}
          description={
            decision === "accept"
              ? "is accepted as this Flight's result. Review the consequences below before delivery."
              : "is rejected and marked failed. Its worktree and branch are retained."
          }
          warningTitle={decision === "accept" ? "Accepting this also" : "Rejecting this also"}
          warnings={describeAttemptDecisionImpact(decision, attempt, cleanliness, flight)}
          confirmLabel={decision === "accept" ? "Accept attempt" : "Reject attempt"}
          undoNote={
            decision === "accept"
              ? "The git branch is kept. Worktree removal cannot be undone."
              : "Files and branch are kept. Removing the worktree files requires a separate Discard confirmation."
          }
          onConfirm={() => void confirmDecision()}
          onClose={() => setDecision(null)}
        />
      )}
      {discardOpen && (
        <ConfirmDeleteModal
          title="Discard preserved work?"
          entityName={attempt.target.worktreePath}
          description="is removed. Uncommitted and untracked files in this worktree will be lost. The committed branch is kept."
          warnings={[
            `Exact worktree: ${attempt.target.worktreePath}`,
            `Retained branch: ${attempt.branch}`,
          ]}
          warningTitle="Preserved files will be removed"
          confirmLabel="Discard preserved work"
          onConfirm={() => {
            setDiscardOpen(false);
            void runAction(() => discardRetainedWorktree(flight.id, attempt.id));
          }}
          onClose={() => setDiscardOpen(false)}
        />
      )}
    </article>
  );
}

function MessageRow({ message }: { message: AgentMessage }) {
  return (
    <div className="space-y-1 text-xs">
      <span className="font-medium text-text-muted">
        {message.role === "user" ? "You" : message.role === "assistant" ? "Agent" : "System"}
      </span>
      {message.content && <MarkdownRenderer content={message.content} />}
      {message.toolCalls?.map((call) => (
        <details key={call.id} className="rounded border border-bg-border px-2 py-1 text-[11px]">
          <summary
            className={
              call.status === "error"
                ? "cursor-pointer text-accent-red"
                : "cursor-pointer text-text-secondary"
            }
          >
            {call.name} · {call.status}
          </summary>
          <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap break-all text-text-muted">
            {call.fullContent ?? call.summary ?? call.input ?? "No tool output was recorded."}
          </pre>
        </details>
      ))}
      {message.isStreaming && (
        <span role="status" className="text-text-muted">
          Streaming…
        </span>
      )}
    </div>
  );
}
function DraftPrLink({ prNumber, href: savedHref }: { prNumber: number; href?: string }) {
  const href = savedHref;
  const label = `Draft PR #${prNumber}`;
  return href ? (
    <a
      className="text-[11px] text-accent-purple underline"
      href={href}
      target="_blank"
      rel="noreferrer"
    >
      {label}
    </a>
  ) : (
    <span className="text-[11px] text-accent-purple">{label}</span>
  );
}
