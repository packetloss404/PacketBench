import { useState, useMemo, useCallback } from "react";
import {
  GitMerge,
  GitPullRequestArrow,
  Trash2,
  Clock,
  Loader2,
  CheckCircle2,
  AlertTriangle,
} from "lucide-react";
import { useAgentTaskStore } from "@/stores/agentTaskStore";
import { deriveLegacyWorktree } from "@/stores/agentConversationPersistence";
import { mergeConversationBranch } from "@/lib/tauri";
import { publishBranchAsPr, resolveWorktreePrTarget } from "@/lib/gitPublish";
import { APP_NAME } from "@/lib/brand";

/**
 * P2-S3 — the one endings surface for a conversation's worktree, mounted
 * inside {@link GitDashboard} (never a per-tile git panel or a separate commit
 * modal — ruled). Four actions on the `pkt/<convId>` branch:
 *
 *  1. **Merge back** → `mergeConversationBranch` (P2-S1). Squash-merges into the
 *     root checkout, force-deletes the branch, removes the worktree dir; on
 *     success flips `worktree.state → "landed"` and clears the pending chip.
 *  2. **Create PR** → `gitPublish.publishBranchAsPr` (P2-S2). Pushes the branch
 *     and opens a draft PR, recording the number via `recordConversationPr`.
 *  3. **Discard** → `discardConversationWorktree` (P2-S2) behind a confirm; a
 *     dirty tree ALWAYS requires the explicit confirm (no non-Discard path ever
 *     removes a dirty tree — the store enforces it too).
 *  4. **Keep for later** → worktree retained; the "worktree pending" chip stays.
 *
 * Conflicts / refusals surface through the host's existing feedback slot
 * (`onFeedback`). SSH conversations disable Merge back with the remote
 * read-only message (parity with GitDashboard). Legacy worktrees (no
 * `baseBranch`) get an explicit base picker defaulting to the repo default
 * branch, feeding only the Create-PR base; ahead-counts are labeled approximate.
 */
export interface WorktreeLifecycleBarProps {
  conversationId: string;
  /** Remote (SSH) conversations can't be landed from the local app — Merge
   * back is disabled with the same read-only copy GitDashboard uses. */
  isRemote?: boolean;
  /** Surface conflicts / refusals / successes through the host's feedback
   * slot instead of a second toast system. */
  onFeedback: (feedback: { type: "ok" | "err"; msg: string }) => void;
  /** Called after a successful merge-back so the host can refresh its git
   * view (the branch + worktree just changed underneath it). */
  onLanded?: () => void;
}

type Busy = "merge" | "pr" | "discard" | null;

export function WorktreeLifecycleBar({
  conversationId,
  isRemote,
  onFeedback,
  onLanded,
}: WorktreeLifecycleBarProps) {
  const conversation = useAgentTaskStore((s) =>
    s.conversations.find((c) => c.id === conversationId),
  );
  const setConversationWorktreeState = useAgentTaskStore((s) => s.setConversationWorktreeState);
  const recordConversationPr = useAgentTaskStore((s) => s.recordConversationPr);
  const discardConversationWorktree = useAgentTaskStore((s) => s.discardConversationWorktree);

  const [busy, setBusy] = useState<Busy>(null);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [baseBranchInput, setBaseBranchInput] = useState("");

  // Read-layer worktree provenance: prefer the stamped record, fall back to
  // deriving it for legacy conversations (never persisted back). `null` ⇒ the
  // conversation ran in the project root (or is a remote whose worktree lives
  // on the host) — there is nothing to land/discard, so the bar hides.
  const worktree = useMemo(
    () => conversation?.worktree ?? (conversation ? deriveLegacyWorktree(conversation) : null),
    [conversation],
  );

  const isLegacy = !!worktree && worktree.baseBranch === undefined;
  const effectiveBase = worktree?.baseBranch ?? (baseBranchInput.trim() || "main");

  const handleMerge = useCallback(async () => {
    if (!worktree || busy) return;
    setBusy("merge");
    try {
      const outcome = await mergeConversationBranch(worktree.basePath, worktree.branch, true);
      if (outcome.nothingToLand) {
        // The Rust command creates no commit and removes nothing when the
        // branch has no changes vs. the root — do NOT flip to "landed" or
        // clear the pending chip. Steer the user to Discard instead.
        onFeedback({
          type: "err",
          msg: `Nothing to land: ${worktree.branch} has no changes to merge. Discard it if you're done.`,
        });
        return;
      }
      setConversationWorktreeState(conversationId, "landed");
      onFeedback({
        type: "ok",
        msg: `Landed ${worktree.branch} → ${outcome.commitSha.slice(0, 7)}${
          outcome.branchDeleted ? "" : " (branch cleanup incomplete)"
        }`,
      });
      onLanded?.();
    } catch (e: unknown) {
      onFeedback({ type: "err", msg: `Merge back failed: ${e instanceof Error ? e.message : e}` });
    } finally {
      setBusy(null);
    }
  }, [worktree, busy, conversationId, setConversationWorktreeState, onFeedback, onLanded]);

  const handleCreatePr = useCallback(async () => {
    if (!worktree || busy) return;
    setBusy("pr");
    try {
      const target = await resolveWorktreePrTarget(worktree.worktreePath);
      const title = `[${APP_NAME}] ${conversation?.title ?? worktree.branch}`.slice(0, 256);
      const body = `Auto-generated from ${APP_NAME} conversation \`${conversationId}\`.`;
      const result = await publishBranchAsPr({
        worktreePath: worktree.worktreePath,
        branch: worktree.branch,
        baseBranch: effectiveBase,
        ...target,
        title,
        body,
        draft: true,
      });
      if (!result.ok) {
        onFeedback({
          type: "err",
          msg: `Create PR: ${result.stage === "push" ? "branch push" : "GitHub create_pr"} failed — ${result.message}`,
        });
        return;
      }
      if (result.prNumber != null) {
        recordConversationPr(conversationId, result.prNumber);
        onFeedback({ type: "ok", msg: `Opened draft PR #${result.prNumber}` });
      } else {
        onFeedback({ type: "ok", msg: "Draft PR opened (number unavailable)" });
      }
    } catch (e: unknown) {
      onFeedback({ type: "err", msg: `Create PR failed: ${e instanceof Error ? e.message : e}` });
    } finally {
      setBusy(null);
    }
  }, [
    worktree,
    busy,
    conversation,
    conversationId,
    effectiveBase,
    recordConversationPr,
    onFeedback,
  ]);

  const runDiscard = useCallback(
    async (confirmed: boolean) => {
      if (!worktree || busy) return;
      setBusy("discard");
      try {
        await discardConversationWorktree(conversationId, { confirmed });
        setConfirmDiscard(false);
        onFeedback({ type: "ok", msg: `Discarded ${worktree.branch}` });
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        // The store rejects a dirty tree without confirmation — surface the
        // inline confirm rather than a bare error so the user can proceed.
        if (/uncommitted changes/i.test(msg)) {
          setConfirmDiscard(true);
        } else {
          onFeedback({ type: "err", msg: `Discard failed: ${msg}` });
        }
      } finally {
        setBusy(null);
      }
    },
    [worktree, busy, conversationId, discardConversationWorktree, onFeedback],
  );

  const handleKeep = useCallback(() => {
    // Keep for later is the default outcome — the worktree is simply retained
    // and the "worktree pending" chip stays. Acknowledge via the feedback slot.
    onFeedback({ type: "ok", msg: "Worktree kept — resume it any time from the fleet." });
  }, [onFeedback]);

  // Nothing to manage: no worktree, or the conversation ran in the root.
  if (!conversation || !worktree) return null;

  const state = worktree.state;

  // Terminal states: show the outcome, no actions.
  if (state === "landed" || state === "discarded") {
    return (
      <div className="flex shrink-0 items-center gap-1.5 border-b border-bg-border bg-bg-secondary px-3 py-2 text-ui">
        {state === "landed" ? (
          <>
            <CheckCircle2 size={12} className="shrink-0 text-accent-green" />
            <span className="text-text-secondary">
              Landed — <span className="font-mono text-text-muted">{worktree.branch}</span> merged
              back and cleaned up.
            </span>
          </>
        ) : (
          <>
            <Trash2 size={12} className="shrink-0 text-text-muted" />
            <span className="text-text-secondary">
              Discarded — <span className="font-mono text-text-muted">{worktree.branch}</span>{" "}
              removed.
            </span>
          </>
        )}
      </div>
    );
  }

  const merging = busy === "merge";
  const prBusy = busy === "pr";
  const discarding = busy === "discard";
  const anyBusy = busy !== null;

  return (
    <div className="shrink-0 space-y-2 border-b border-bg-border bg-bg-secondary px-3 py-2">
      <div className="flex items-center gap-1.5">
        <Clock size={11} className="shrink-0 text-accent-amber" />
        <span
          className="rounded-full border border-accent-amber/30 bg-accent-amber/10 px-1.5 py-0.5 text-meta text-accent-amber"
          data-testid="worktree-pending-chip"
        >
          worktree pending
        </span>
        <span className="truncate font-mono text-meta text-text-muted" title={worktree.branch}>
          {worktree.branch}
        </span>
        {isLegacy && (
          <span
            className="text-meta text-text-muted"
            title="Legacy worktree — base branch was not recorded at launch; ahead-counts are approximate."
          >
            · legacy (base ≈)
          </span>
        )}
      </div>

      {isLegacy && (
        <label className="flex items-center gap-1.5 text-meta text-text-muted">
          <span className="shrink-0">PR base</span>
          <input
            type="text"
            value={baseBranchInput}
            onChange={(e) => setBaseBranchInput(e.target.value)}
            placeholder="main"
            aria-label="PR base branch"
            className="min-w-0 flex-1 rounded border border-bg-border bg-bg-primary px-1.5 py-0.5 text-ui text-text-primary placeholder:text-text-muted focus:border-accent-green/50 focus:outline-none"
          />
        </label>
      )}

      <div className="flex flex-wrap items-center gap-1.5">
        <button
          type="button"
          onClick={handleMerge}
          disabled={anyBusy || isRemote}
          title={
            isRemote
              ? "Remote commit/push/pull not yet supported"
              : "Squash-merge this branch back into the root checkout and clean up"
          }
          className="flex items-center gap-1 rounded bg-accent-green/20 px-2 py-1 text-ui font-medium text-accent-green transition-colors hover:bg-accent-green/30 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {merging ? <Loader2 size={11} className="animate-spin" /> : <GitMerge size={11} />}
          Merge back
        </button>
        <button
          type="button"
          onClick={handleCreatePr}
          disabled={anyBusy}
          title="Push the branch and open a draft PR"
          className="flex items-center gap-1 rounded bg-bg-tertiary px-2 py-1 text-ui text-text-secondary transition-colors hover:bg-bg-border hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-40"
        >
          {prBusy ? (
            <Loader2 size={11} className="animate-spin" />
          ) : (
            <GitPullRequestArrow size={11} />
          )}
          Create PR
        </button>
        <button
          type="button"
          onClick={handleKeep}
          disabled={anyBusy}
          title="Keep the worktree for later — nothing is removed"
          className="flex items-center gap-1 rounded bg-bg-tertiary px-2 py-1 text-ui text-text-secondary transition-colors hover:bg-bg-border hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-40"
        >
          <Clock size={11} />
          Keep for later
        </button>
        <button
          type="button"
          onClick={() => runDiscard(false)}
          disabled={anyBusy}
          title="Discard this worktree and its branch"
          className="ml-auto flex items-center gap-1 rounded px-2 py-1 text-ui text-accent-red transition-colors hover:bg-accent-red/10 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {discarding && !confirmDiscard ? (
            <Loader2 size={11} className="animate-spin" />
          ) : (
            <Trash2 size={11} />
          )}
          Discard
        </button>
      </div>

      {confirmDiscard && (
        <div className="flex items-center gap-2 rounded border border-accent-red/30 bg-accent-red/5 px-2 py-1.5 text-meta">
          <AlertTriangle size={12} className="shrink-0 text-accent-red" />
          <span className="flex-1 text-text-secondary">
            This worktree has uncommitted changes. Discarding loses them permanently.
          </span>
          <button
            type="button"
            onClick={() => setConfirmDiscard(false)}
            disabled={discarding}
            className="rounded px-1.5 py-0.5 text-text-secondary transition-colors hover:bg-bg-secondary hover:text-text-primary disabled:opacity-40"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => runDiscard(true)}
            disabled={discarding}
            className="rounded bg-accent-red/20 px-1.5 py-0.5 font-medium text-accent-red transition-colors hover:bg-accent-red/30 disabled:opacity-40"
          >
            {discarding ? <Loader2 size={11} className="animate-spin" /> : "Discard anyway"}
          </button>
        </div>
      )}
    </div>
  );
}
