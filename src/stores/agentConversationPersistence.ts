import { saveConversation, loadConversations } from "@/lib/tauri";
import { useAgentPlanStore } from "@/stores/agentPlanStore";
import { getAgentAutoArchiveIdleMs } from "@/stores/agentSettingsStore";
import type { AgentConversation, AgentPlanItem } from "@/types/agent-conversation";
import { canonicalizeAgentCli, useAgentTaskStore } from "@/stores/agentTaskStore";
import { normalizeMessageProvenance } from "@/lib/provenance";

/**
 * On-disk shape of a persisted conversation. Wider than the runtime
 * `AgentConversation` type: `plan`/`planApproved` are the plan substore's
 * ONE persistence mechanism (P1-11 — the saved record IS the store, so
 * this shape must keep round-tripping), and the remaining keys are
 * legacy/ephemeral fields that older builds wrote onto the record itself.
 * Hydration strips all of them onto a clean `AgentConversation` after
 * feeding `plan`/`planApproved` into `agentPlanStore`.
 */
type PersistedAgentConversation = AgentConversation & {
  plan?: AgentPlanItem[];
  planApproved?: boolean;
  pendingPermissions?: unknown;
  pendingEdits?: unknown;
  thinkingStream?: unknown;
  subAgentTokens?: unknown;
  workspaceId?: string;
  spec?: unknown;
  specStage?: unknown;
};

/** Build a serializable snapshot of a conversation for `saveConversation`.
 * Pulls plan state out of `agentPlanStore` so the persisted record
 * keeps its on-disk shape even though those fields no longer live on the
 * in-memory conversation object. Ephemeral substores (approval,
 * streaming) are intentionally omitted — they reset on hydration. */
function snapshotForPersist(conv: AgentConversation): PersistedAgentConversation {
  const plans = useAgentPlanStore.getState();
  return {
    ...conv,
    plan: plans.getPlan(conv.id),
    planApproved: plans.getPlanApproved(conv.id) || undefined,
  };
}

/** `deriveLegacyWorktree` now lives in the pure `lib/worktreeLifecycle` module
 * (the delete confirm needs it without importing this store's graph). Re-exported
 * here so its long-standing importers keep working unchanged. */
export { deriveLegacyWorktree } from "@/lib/worktreeLifecycle";

/** Debounced save: per-conversation timers so rapid streaming events coalesce. */
const SAVE_DEBOUNCE_MS = 500;
const saveTimers = new Map<string, ReturnType<typeof setTimeout>>();

/** Await durable user intent before launching a first turn or acknowledging a
 * model choice. Cancel older debounced snapshots so they cannot undo it. */
export async function saveConversationNow(conv: AgentConversation): Promise<void> {
  if (conv.mode !== "api") return;
  cancelPendingSave(conv.id);
  await saveConversation(conv.id, JSON.stringify(snapshotForPersist(conv)));
}

export function scheduleSave(conv: AgentConversation): void {
  if (conv.mode !== "api") return; // only persist API conversations
  const existing = saveTimers.get(conv.id);
  if (existing) clearTimeout(existing);
  const handle = setTimeout(() => {
    saveTimers.delete(conv.id);
    saveConversation(conv.id, JSON.stringify(snapshotForPersist(conv))).catch((e) => {
      console.warn("Failed to save conversation:", conv.id, e);
    });
  }, SAVE_DEBOUNCE_MS);
  saveTimers.set(conv.id, handle);
}

/** Cancel any pending debounced save for a conversation (used when the
 * conversation is deleted so a stale timer can't re-persist its file). */
export function cancelPendingSave(conversationId: string): void {
  const timer = saveTimers.get(conversationId);
  if (timer) {
    clearTimeout(timer);
    saveTimers.delete(conversationId);
  }
}

/** Request a save for a conversation by id. Plan-store mutations call
 * this so plan/spec edits debounce-persist through the same path as
 * conversation mutations, without plan-store needing to import the full
 * agentTaskStore module at load time. */
export function requestConversationSave(conversationId: string): void {
  const conv = useAgentTaskStore.getState().conversations.find((c) => c.id === conversationId);
  if (conv) scheduleSave(conv);
}

/** Predicate: should this conversation be auto-archived right now? A
 * conversation qualifies once it's status === "done", not already archived,
 * the Agents settings idle threshold is enabled (non-null), and it has been
 * idle longer than that threshold. Shared by the cold-start hydration pass
 * and the live runtime sweep so both agree on one definition of "stale". */
export function shouldAutoArchive(conv: AgentConversation): boolean {
  if (conv.archived) return false;
  if (conv.status !== "done") return false;
  const autoArchiveIdleMs = getAgentAutoArchiveIdleMs();
  if (autoArchiveIdleMs === null) return false;
  if (conv.updatedAt >= Date.now() - autoArchiveIdleMs) return false;
  return true;
}

/** One-time pass over hydrated conversations: any conversation with
 * status === "done" that has been idle longer than the Agents settings
 * threshold and isn't already archived gets auto-archived. Mutates `conv` in
 * place and returns whether it changed (so callers can re-persist). */
function maybeAutoArchive(conv: AgentConversation): boolean {
  if (!shouldAutoArchive(conv)) return false;
  conv.archived = true;
  return true;
}

/** Live runtime sweep: archives every currently-loaded conversation that
 * qualifies under `shouldAutoArchive`. Unlike `maybeAutoArchive` (cold-start
 * only, mutates a not-yet-in-store record), this runs against the live
 * agentTaskStore and goes through `archiveConversation` so the archive
 * bumps `updatedAt` and schedules a save the normal way — which also keeps
 * an archived conversation from being swept again next run. */
export function sweepAutoArchive(): void {
  const { conversations, archiveConversation } = useAgentTaskStore.getState();
  for (const conv of conversations) {
    if (shouldAutoArchive(conv)) archiveConversation(conv.id);
  }
}

let hydrationPromise: Promise<void> | null = null;

async function loadConversationSnapshot(options: {
  persistAutoArchive: boolean;
  markInterrupted: boolean;
}): Promise<AgentConversation[]> {
  const rawList = await loadConversations();
  const parsed: AgentConversation[] = [];
  for (const raw of rawList) {
    try {
      const persisted = JSON.parse(raw) as PersistedAgentConversation;
      if (persisted.mode !== "api") continue; // PTY sessions died with the app
      // Auto-archive long-idle done conversations BEFORE we coerce status
      // to "idle" below. The main renderer persists that migration; read-only
      // projections may display it but never write it back.
      if (maybeAutoArchive(persisted) && options.persistAutoArchive) {
        saveConversation(persisted.id, JSON.stringify(persisted)).catch((e) => {
          console.warn("Failed to persist auto-archive:", persisted.id, e);
        });
      }
      // Push persisted plan state into the plan substore — it is the
      // ONE runtime source of truth (P1-11). Legacy spec/specStage
      // fields from the retired Spec FSM are simply ignored.
      useAgentPlanStore.getState().hydrateConversation(persisted.id, {
        plan: persisted.plan,
        planApproved: persisted.planApproved,
      });
      // Strip every legacy/ephemeral/mirror key so the in-memory record
      // matches the current `AgentConversation` shape exactly, then
      // apply the cold-start resets and provider alias migration.
      /* eslint-disable @typescript-eslint/no-unused-vars */
      const {
        plan: _plan,
        planApproved: _planApproved,
        pendingPermissions: _pendingPermissions,
        pendingEdits: _pendingEdits,
        thinkingStream: _thinkingStream,
        subAgentTokens: _subAgentTokens,
        workspaceId: _workspaceId,
        spec: _spec,
        specStage: _specStage,
        ...conv
      } = persisted;
      /* eslint-enable @typescript-eslint/no-unused-vars */
      conv.agent = canonicalizeAgentCli(conv.agent);
      const interrupted = options.markInterrupted && conv.status === "active";
      conv.status = "idle";
      conv.messages = (conv.messages ?? []).map((message) =>
        normalizeMessageProvenance({ ...message, isStreaming: false }),
      );
      conv.queuedMessages = [];
      if (interrupted) {
        conv.messages.push({
          id: `${conv.id}:interrupted:${conv.updatedAt}`,
          role: "system",
          content:
            "The previous turn was interrupted when the app closed. Send a message to continue.",
          timestamp: conv.updatedAt,
        });
      }
      parsed.push(conv);
    } catch (e) {
      console.warn("Skipping malformed conversation:", e);
    }
  }
  return parsed;
}

/**
 * Hydrate persisted API conversations exactly once for this renderer lifetime.
 * The app bootstrap awaits this promise before publishing `initialized`, so
 * Workspace/Agents reconciliation cannot race an incomplete conversation set.
 * Runtime-only fields reset so no turn resumes mid-stream after a cold start.
 * A failed first read clears the one-shot guard so a later caller may retry.
 */
export function hydrateConversations(): Promise<void> {
  if (hydrationPromise) return hydrationPromise;
  hydrationPromise = loadConversationSnapshot({ persistAutoArchive: true, markInterrupted: true })
    .then((parsed) => {
      if (parsed.length > 0) {
        useAgentTaskStore.setState((state) => ({
          conversations: [...parsed, ...state.conversations],
        }));
      }
    })
    .catch((e) => {
      hydrationPromise = null;
      console.warn("Failed to hydrate conversations:", e);
    });
  return hydrationPromise;
}

/**
 * Replace this renderer's read-only conversation projection from disk.
 *
 * Unlike main-window hydration, this operation is intentionally repeatable:
 * Monitor polls it while open. Loading and parsing finish before the store is
 * replaced, so a failed refresh preserves the last safe projection and can
 * never persist migrations or other conversation changes.
 */
export async function refreshConversationProjection(): Promise<void> {
  const conversations = await loadConversationSnapshot({
    persistAutoArchive: false,
    markInterrupted: false,
  });
  useAgentTaskStore.setState({ conversations });
}
