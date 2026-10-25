/**
 * Tile program (P1-S2) — sessionGlue: the ONE bridge between the two engines.
 *
 * `agentTaskStore` (headless conversations) and `workspaceStore` (placement)
 * never import each other — an eslint `no-restricted-imports` rule enforces it.
 * All cross-engine wiring lives here:
 *
 *   (a) One-directional GC — deleting a conversation prunes its tiles; closing
 *       a tile NEVER touches the conversation.
 *   (b) Idempotent startup reconciliation sweep — self-heals a wrapper whose
 *       conversation pane was stripped by an old-binary re-save. No localStorage
 *       guard key: reconciliation IS the repair, so re-runs are safe no-ops.
 *   (c) `openConversationInAgents(id)` — the default conversation navigation
 *       path. It selects the conversation and opens the first-class Agents
 *       view without touching Workspace state.
 *   (d) Existing persisted conversation panes remain reference-compatible,
 *       but this bridge exposes no operation that can create a new attachment.
 *
 * {@link initSessionGlue} is installed by the app bootstrap after conversation
 * hydration so reconciliation and garbage collection see authoritative state.
 */
import { useAgentTaskStore } from "@/stores/agentTaskStore";
import { useAgentApprovalStore } from "@/stores/agentApprovalStore";
import { useReviewStore } from "@/stores/reviewStore";
import { useWorkspaceStore, conversationWrapperId } from "@/stores/workspaceStore";
import { useAppStore } from "@/stores/appStore";
import { killPty, getGitStatus, removeConversationWorktree } from "@/lib/tauri";
import {
  isWorktreeSafeToCleanup,
  isWorktreeDirty,
  type WorktreeCleanupFacts,
} from "@/lib/worktreeLifecycle";
import { getWorktreeCleanupPolicy, type WorktreeCleanupPolicy } from "@/stores/agentSettingsStore";
import {
  recordConversationOpenedInAgents,
  useWorkspaceAgentsDogfoodStore,
} from "@/stores/workspaceAgentsDogfoodStore";

// ─── (a) One-directional GC ─────────────────────────────────────────────────

/**
 * Subscribe to `agentTaskStore` and prune referencing panes whenever a
 * conversation disappears (deleteConversation / forkConversation never delete, so
 * only a real removal fires this). Direction is strictly conversation→panes:
 * `workspaceStore.removeConversationPanes` touches no conversation, so closing a
 * tile can never delete a conversation.
 *
 * Returns the zustand unsubscribe fn. Idempotent installation is the caller's
 * concern ({@link initSessionGlue} installs exactly once).
 */
export function installConversationGc(): () => void {
  let previousIds = new Set(useAgentTaskStore.getState().conversations.map((c) => c.id));
  return useAgentTaskStore.subscribe((state) => {
    const nextIds = new Set(state.conversations.map((c) => c.id));
    if (nextIds.size >= previousIds.size) {
      // No id could have been removed when the count didn't shrink — the common
      // streaming-update path exits here without scanning.
      let removedAny = false;
      for (const id of previousIds) {
        if (!nextIds.has(id)) {
          removedAny = true;
          break;
        }
      }
      if (!removedAny) {
        previousIds = nextIds;
        return;
      }
    }
    for (const id of previousIds) {
      if (!nextIds.has(id)) {
        useWorkspaceStore.getState().removeConversationPanes(id);
      }
    }
    previousIds = nextIds;
  });
}

// ─── (b) Reconciliation sweep ───────────────────────────────────────────────

/**
 * Self-heal orphaned conversation wrappers. When an old binary re-saves a
 * workspace it strips `kind`/`conversationId`, so `normalizePanes` degrades the
 * conversation pane to a plain terminal pane on the next load — leaving the
 * `origin:"conversation"` wrapper holding no conversation pane. This sweep
 * removes those ghost wrappers so their conversation cleanly re-surfaces as an
 * UNPLACED fleet row (via `sessionIndex`), with ZERO conversation-file mutation
 * — the conversation record is never touched, only the empty placement wrapper.
 *
 * Idempotent: a second run finds no orphaned wrappers and does nothing. There
 * is deliberately no persisted guard key — reconciliation is the repair, so
 * running it every startup is correct.
 */
export function runReconciliationSweep(): void {
  const orphanWrapperIds: string[] = [];
  for (const workspace of useWorkspaceStore.getState().workspaces) {
    if (workspace.origin !== "conversation") continue;
    const hasConversationPane = workspace.panes.some((p) => p.kind === "conversation");
    if (!hasConversationPane) orphanWrapperIds.push(workspace.id);
  }
  for (const id of orphanWrapperIds) {
    useWorkspaceStore.getState().deleteWorkspace(id);
  }
}

// ─── (c) Agents navigation ──────────────────────────────────────────────────

/**
 * Open a durable conversation in the first-class Agents view.
 *
 * Returns false for a stale id and leaves the current view/selection untouched.
 * Ordinary notification, Flight, Memory, prompt, and approval links use this
 * path so viewing a conversation never creates a wrapper Workspace.
 */
export function openConversationInAgents(conversationId: string): boolean {
  const store = useAgentTaskStore.getState();
  if (!store.conversations.some((conversation) => conversation.id === conversationId)) {
    return false;
  }
  store.selectConversation(conversationId);
  useAppStore.getState().setActiveView("agents");
  recordConversationOpenedInAgents(conversationId);
  return true;
}

/**
 * @deprecated WA1 default links must call {@link openConversationInAgents}.
 * Kept for one compatibility release so external imports cannot strand users.
 */
export function focusConversationDeepLink(conversationId: string): void {
  openConversationInAgents(conversationId);
}

// ─── F6 — exact attention routing ──────────────────────────────────────────

/**
 * The kind of blocker an attention open can target. `permission` and `edit`
 * are revalidated against the authoritative approval queues; `plan` and
 * `failure` carry no queue and simply reveal the conversation.
 */
export type AgentAttentionKind = "permission" | "edit" | "plan" | "failure";

/**
 * A stable identity for the exact blocker to open. `requestId` is a request /
 * tool-use id, never an array position, so a queue that shifts under us cannot
 * redirect the jump to the wrong card.
 */
export interface AgentAttentionTarget {
  conversationId: string;
  kind: AgentAttentionKind;
  requestId: string;
  messageId?: string;
  filePath?: string;
}

export interface AgentAttentionResult {
  opened: boolean;
  reason?: "resolved" | "missing_conversation";
}

/**
 * The ONE user-triggered attention open (header badge, banner, tray, Flight
 * link). Saves the caller's review/reader position, revalidates the target
 * against the live queue, selects + reveals the conversation, and arms the
 * exact approval card (or canonical review) for focus. It never answers or
 * accepts anything, and it never silently targets a *different* request when
 * the named one was already resolved.
 *
 * Returns `resolved` when the exact request is no longer pending and
 * `missing_conversation` when the id is stale — both leave the saved return
 * anchor intact so a "Return to review" affordance can still restore the
 * user's place.
 */
export function openAgentAttention(target: AgentAttentionTarget): AgentAttentionResult {
  const store = useAgentTaskStore.getState();
  const conversation = store.conversations.find((c) => c.id === target.conversationId);
  if (!conversation) return { opened: false, reason: "missing_conversation" };

  const approvals = useAgentApprovalStore.getState();
  if (target.kind === "permission") {
    const pending = approvals.permissions.get(target.conversationId) ?? [];
    if (!pending.some((p) => p.id === target.requestId)) {
      return { opened: false, reason: "resolved" };
    }
  } else if (target.kind === "edit") {
    const pending = approvals.edits.get(target.conversationId) ?? [];
    if (!pending.some((e) => e.id === target.requestId)) {
      return { opened: false, reason: "resolved" };
    }
  }

  const review = useReviewStore.getState();
  // Save the return position for the conversation the user is leaving — the
  // currently-open review surface's file when it is scoped to this same
  // conversation, otherwise a plain reader anchor. The jump stays reversible.
  const returnFilePath =
    review.open && review.conversationId === target.conversationId
      ? review.focusPath
      : null;
  review.saveReturnAnchor(target.conversationId, returnFilePath, 0);

  // Arm the exact card. The ephemeral token is what lets a remount of the same
  // conversation distinguish a fresh open from a stale one.
  review.setAttentionFocus({
    conversationId: target.conversationId,
    kind: target.kind,
    requestId: target.requestId,
    focusToken: `att:${target.conversationId}:${target.requestId}:${Date.now()}`,
  });

  // Edit attention opens the canonical review at its exact pending edit.
  if (target.kind === "edit") {
    review.openForConversation(target.conversationId, target.filePath);
  } else {
    // F6: permission/plan/failure targets live inline in the transcript. The
    // canonical review overlay (z-20) covers that area, so leaving it open
    // would hide the exact card we just armed. Close it so the requested
    // blocker is actually visible. The saved return anchor (above) survives
    // this, so "Return to review" still restores the user's place.
    review.close();
  }

  store.selectConversation(target.conversationId);
  useAppStore.getState().setActiveView("agents");
  recordConversationOpenedInAgents(target.conversationId);
  return { opened: true };
}

/**
 * The "Return to review" half of the attention round-trip: restores the saved
 * review/reader position and reopens the canonical review at its exact file.
 * Returns false when no anchor was saved for this conversation (or the
 * conversation no longer exists).
 */
export function restoreReviewPosition(conversationId: string): boolean {
  const review = useReviewStore.getState();
  const anchor = review.restoreReturnAnchor(conversationId);
  if (!anchor) return false;
  const store = useAgentTaskStore.getState();
  if (!store.conversations.some((c) => c.id === conversationId)) return false;
  store.selectConversation(conversationId);
  useAppStore.getState().setActiveView("agents");
  review.openForConversation(conversationId, anchor.filePath ?? undefined);
  return true;
}

/** Re-export so consumers/tests can assert the deterministic wrapper id without
 *  reaching into workspaceStore internals. */
export { conversationWrapperId };

// ─── (d) Archive lifecycle fan-out (P4-S3) ──────────────────────────────────

/**
 * The facts the safe-cleanup predicate needs for one worktree, plus its
 * provenance. The default gatherer measures only `dirty` reliably (via
 * `git status`); the merge facts (`ancestryMerged`, `recordedPrMerged`,
 * `commitsAhead`) have no TS-layer plumbing yet, so it reports them
 * conservatively as UNPROVEN — `only-when-safe` then Keeps anything it cannot
 * prove already landed (never loses work). Tests inject a gatherer to exercise
 * the full predicate.
 */
async function defaultGatherFacts(input: {
  worktreePath: string;
  prNumber?: number;
}): Promise<WorktreeCleanupFacts> {
  let dirty: boolean;
  try {
    dirty = isWorktreeDirty(await getGitStatus(input.worktreePath));
  } catch {
    // Can't determine cleanliness ⇒ treat as dirty so we never remove a tree
    // whose state we don't know (mirrors discardConversationWorktree).
    dirty = true;
  }
  return { dirty, ancestryMerged: false, recordedPrMerged: false, commitsAhead: 1 };
}

/** Injectable dependencies for {@link archiveWorkspaceWithFanout} — every IO
 *  boundary is overridable so the fan-out is unit-testable with zero backend. */
export interface ArchiveFanoutDeps {
  /**
   * Auto-archive path (the hourly sweep). When true the worktree policy is
   * FORCED to Keep (auto-archive structurally cannot prompt, so it can never
   * clean — ruled) and the "unlanded work" toast is never raised by the caller.
   */
  auto?: boolean;
  /** Override the resolved cleanup policy (defaults to the settings value; a
   *  no-op when {@link ArchiveFanoutDeps.auto} is set). */
  policy?: WorktreeCleanupPolicy;
  killPtySession?: (sessionId: string) => Promise<void>;
  gatherFacts?: (input: {
    conversationId: string;
    worktreePath: string;
    prNumber?: number;
  }) => Promise<WorktreeCleanupFacts>;
  removeWorktree?: (
    basePath: string,
    conversationId: string,
    deleteBranch: boolean,
  ) => Promise<void>;
}

export interface ArchiveFanoutResult {
  workspaceId: string;
  auto: boolean;
  /** PTY session ids killed on archive (member terminal tiles). */
  killedPtySessionIds: string[];
  /** Member conversations archived (transcripts kept). */
  archivedConversationIds: string[];
  /** Worktrees provably safe under the policy — removed, lifecycle flipped. */
  cleanedWorktreeConversationIds: string[];
  /** Unlanded worktrees conservatively Kept (they keep the "worktree pending"
   *  chip). A non-empty list on an EXPLICIT archive drives the caller's toast. */
  keptWorktreeConversationIds: string[];
}

/**
 * Archive a workspace with the full ruled lifecycle fan-out (P4-S3). This is
 * the ONE cross-engine archive path — it lives in sessionGlue because it must
 * touch BOTH engines (workspace placement + conversation records) plus the PTY
 * and git backends, which the store-isolation rule forbids either store from
 * doing directly.
 *
 * Ordering:
 *   1. Kill member PTYs — **on archive only, NEVER on workspace switch** (the
 *      P0-2 law; a plain `setActiveWorkspace` never kills anything).
 *   2. Apply the worktree cleanup policy to each member conversation's active
 *      worktree: provably-safe trees are removed (lifecycle → landed/discarded),
 *      everything else is conservatively Kept with the pending chip.
 *      Auto-archive always Keeps.
 *   3. Archive member conversations — transcripts are always kept.
 *   4. Archive the workspace record itself.
 *
 * The "explicit archive of unlanded work" toast is raised by the CALLER from
 * {@link ArchiveFanoutResult.keptWorktreeConversationIds} (the notification
 * layer stays a consumer; the glue never imports it).
 *
 * Returns `null` when the workspace does not exist.
 */
export async function archiveWorkspaceWithFanout(
  workspaceId: string,
  deps: ArchiveFanoutDeps = {},
): Promise<ArchiveFanoutResult | null> {
  const workspace = useWorkspaceStore.getState().workspaces.find((w) => w.id === workspaceId);
  if (!workspace) return null;

  const auto = deps.auto ?? false;
  const killPtyFn = deps.killPtySession ?? killPty;
  const removeWorktreeFn = deps.removeWorktree ?? removeConversationWorktree;
  const gather = deps.gatherFacts ?? ((i) => defaultGatherFacts(i));
  // Auto-archive can never clean (ruled): force the Keep-everything policy.
  const policy: WorktreeCleanupPolicy = auto
    ? "never"
    : (deps.policy ?? getWorktreeCleanupPolicy());

  // 1. Kill member PTYs (terminal tiles carry the PTY sessionId). Best-effort —
  //    a PTY that already exited is fine. This is the archive-only kill gate.
  const killedPtySessionIds: string[] = [];
  await Promise.all(
    workspace.panes
      .filter((p) => p.sessionId)
      .map(async (p) => {
        killedPtySessionIds.push(p.sessionId!);
        await killPtyFn(p.sessionId!).catch(() => {});
      }),
  );

  // Member conversations = the workspace's conversation panes (deduped).
  const memberConversationIds = [
    ...new Set(
      workspace.panes
        .filter((p) => p.kind === "conversation" && p.conversationId)
        .map((p) => p.conversationId as string),
    ),
  ];

  // 2. Worktree cleanup policy per member conversation.
  const cleanedWorktreeConversationIds: string[] = [];
  const keptWorktreeConversationIds: string[] = [];
  for (const convId of memberConversationIds) {
    const conv = useAgentTaskStore.getState().conversations.find((c) => c.id === convId);
    const wt = conv?.worktree;
    // Only an ACTIVE local worktree is a cleanup candidate. SSH worktrees live
    // on the remote host — never touched here. No worktree ⇒ nothing to keep.
    if (!wt || wt.state !== "active" || conv?.sshTarget) continue;

    if (policy === "never") {
      keptWorktreeConversationIds.push(convId);
      continue;
    }

    // F3: a fork borrows this checkout. Keep the tree while any live child
    // still references it, even when the cleanup predicate says "safe".
    const hasDependentForks = useAgentTaskStore
      .getState()
      .conversations.some((c) => c.id !== convId && c.lineage?.parentConversationId === convId);
    if (hasDependentForks) {
      keptWorktreeConversationIds.push(convId);
      continue;
    }

    let facts: WorktreeCleanupFacts;
    try {
      facts = await gather({
        conversationId: convId,
        worktreePath: wt.worktreePath,
        prNumber: wt.prNumber,
      });
    } catch {
      keptWorktreeConversationIds.push(convId);
      continue;
    }

    // `always` removes a CLEAN tree unconditionally; a DIRTY tree is never
    // removed by any non-Discard path (Phase 2 gate). `only-when-safe` defers
    // entirely to the ruled predicate.
    const safe = policy === "always" ? !facts.dirty : isWorktreeSafeToCleanup(facts);
    if (!safe) {
      keptWorktreeConversationIds.push(convId);
      continue;
    }

    try {
      await removeWorktreeFn(wt.basePath, convId, true);
      // Flip lifecycle so the pending chip clears. "landed" when the work
      // actually merged; "discarded" when `always` tore down a clean-but-
      // unmerged tree.
      const terminal = facts.ancestryMerged || facts.recordedPrMerged ? "landed" : "discarded";
      useAgentTaskStore.getState().setConversationWorktreeState(convId, terminal);
      cleanedWorktreeConversationIds.push(convId);
    } catch {
      // Removal failed — Keep so the chip surfaces the still-present tree.
      keptWorktreeConversationIds.push(convId);
    }
  }

  // 3. Archive member conversations (transcripts kept — archive never deletes).
  for (const convId of memberConversationIds) {
    useAgentTaskStore.getState().archiveConversation(convId);
  }

  // 4. Archive the workspace record.
  useWorkspaceStore.getState().archiveWorkspace(workspaceId);

  return {
    workspaceId,
    auto,
    killedPtySessionIds,
    archivedConversationIds: memberConversationIds,
    cleanedWorktreeConversationIds,
    keptWorktreeConversationIds,
  };
}

// ─── Lifecycle ──────────────────────────────────────────────────────────────

let gcUnsubscribe: (() => void) | null = null;

/**
 * Install the GC subscription (once) and run the reconciliation sweep. The
 * caller (Phase 4 app shell) invokes this AFTER `hydrateConversations` resolves
 * so the sweep sees the fully-hydrated workspace + conversation state. Safe to
 * call more than once — the GC subscription is not duplicated.
 */
export function initSessionGlue(): void {
  if (!gcUnsubscribe) gcUnsubscribe = installConversationGc();
  const conversations = new Set(
    useAgentTaskStore.getState().conversations.map((conversation) => conversation.id),
  );
  const workspaces = useWorkspaceStore.getState().workspaces;
  const conversationPanes = workspaces.flatMap((workspace) =>
    workspace.panes.filter((pane) => pane.kind === "conversation"),
  );
  useWorkspaceAgentsDogfoodStore.getState().recordMigrationAudit({
    conversationPanes: conversationPanes.length,
    missingConversationReferences: conversationPanes.filter(
      (pane) => !pane.conversationId || !conversations.has(pane.conversationId),
    ).length,
    orphanConversationWrappers: workspaces.filter(
      (workspace) =>
        workspace.origin === "conversation" &&
        !workspace.panes.some((pane) => pane.kind === "conversation"),
    ).length,
  });
  runReconciliationSweep();
}

/** Tear down the GC subscription (test cleanup / hot-reload). */
export function teardownSessionGlue(): void {
  if (gcUnsubscribe) {
    gcUnsubscribe();
    gcUnsubscribe = null;
  }
}
