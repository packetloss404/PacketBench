import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import { BookmarkPlus, History, Pencil, RotateCcw, RotateCw } from "lucide-react";
import { MarkdownRenderer } from "@/components/common/MarkdownRenderer";
import { Modal } from "@/components/ui/Modal";
import { Spinner } from "@/components/ui/Spinner";
import { Tooltip } from "@/components/ui/Tooltip";
import { buildTranscriptMemoryInput } from "@/lib/memoryCapture";
import { interruptRunningToolCalls } from "@/lib/toolCallSettlement";
import { useAgentSettingsStore } from "@/stores/agentSettingsStore";
import { useMemoryStore } from "@/stores/memoryStore";
import { ExplorationRollupCard } from "../ExplorationRollupCard";
import { PlanModeApprovalMenu } from "../PlanModeApprovalMenu";
import { ThinkingBlock } from "../ThinkingBlock";
import { looksLikePlan } from "../planDetection";
import { ToolCallRenderer } from "./ToolCallRenderer";
import { InlineApprovals, type InlineApprovalsBinding } from "./InlineApprovals";
import type {
  AgentConversation,
  AgentMessage,
  PendingPermission,
} from "@/types/agent-conversation";

// Virtualization tuning. The last N rows always mount immediately so the
// bottom of the transcript (streaming message, quick actions, diff viewer)
// renders instantly and the "stick to bottom" scroll lands on real content.
// Everything above is lazily mounted as it approaches the viewport.
const TAIL_FORCE_MOUNT = 10;
// Reserved height for a not-yet-mounted row. Keeps the scroll container
// overflowing (so off-screen rows stay off-screen) and gives the scrollbar a
// sensible size before real heights are known. WKWebView has NO CSS scroll
// anchoring, so LazyMessageRow compensates scrollTop manually when a row
// mounts above the viewport (see the layout effect there).
//
// Tracks the BODY TYPE SCALE, not a magic number: it is a two-line assistant
// turn at the current metrics - 2 x --leading-body (24px) of de-bubbled prose,
// + the ~15px footer action row, + the 6px space-y-1.5 between them ≈ 69.
// Re-derive this whenever --text-body / --leading-body or the turn padding move.
const PLACEHOLDER_MIN_HEIGHT = 69;

/** Stable empty queue — keeps the placement memo from re-running every render
 * on a fresh `[]`. */
const NO_PERMISSIONS: PendingPermission[] = [];

interface MessageListProps {
  conversation: AgentConversation;
  conversationId: string;
  editingMessageId: string | null;
  editingText: string;
  onStartEdit: (msgId: string, content: string) => void;
  onChangeEdit: (text: string) => void;
  onSubmitEdit: (msgId: string) => void;
  onCancelEdit: () => void;
  /** Inline per-message Rewind: saves later messages as a revision and keeps
   * this turn. Files are untouched and no turn is started. */
  onRewindFrom: (msgId: string) => void;
  onRetryLastTurn: () => void;
  isActive: boolean;
  // Scroll container that owns the message viewport (from AgentChatPane).
  // Used as the IntersectionObserver root for lazy row mounting.
  scrollContainerRef?: RefObject<HTMLDivElement | null>;
  /**
   * B3 — pending approvals, rendered inline at the call site. `undefined`
   * means "this session cannot approve per tool" (`caps.canApprovePerTool`),
   * and no approval chrome is rendered at all.
   *
   * Presentation only: the Y/N keydown handler and its per-tile focus gate
   * live in `PendingApprovalsSection` and are NOT duplicated here.
   */
  approvals?: InlineApprovalsBinding;
}

export function MessageList({
  conversation,
  conversationId,
  editingMessageId,
  editingText,
  onStartEdit,
  onChangeEdit,
  onSubmitEdit,
  onCancelEdit,
  onRewindFrom,
  onRetryLastTurn,
  isActive,
  scrollContainerRef,
  approvals,
}: MessageListProps) {
  const messages = conversation.messages;
  const revisions = conversation.transcriptRevisions ?? [];
  const [viewingHistory, setViewingHistory] = useState(false);
  const canMutateHistory = !isActive;
  const lastMessage = messages[messages.length - 1];
  const lastAssistantMessage = [...messages].reverse().find((m) => m.role === "assistant");
  const showThinking =
    isActive && (!lastMessage || lastMessage.role === "user") && messages.length > 0;

  // Shared IntersectionObserver for lazy row mounting. One observer per list
  // instance watches every placeholder row; when a row nears the viewport it
  // mounts once and is unobserved (mount-once, never unmount — preserves per
  // card local state like expanded tool output and streaming auto-scroll).
  const observerRef = useRef<IntersectionObserver | null>(null);
  const visibilityCallbacks = useRef(new Map<Element, () => void>());
  const register = useCallback(
    (el: Element, onVisible: () => void) => {
      if (typeof IntersectionObserver === "undefined") {
        onVisible();
        return () => {};
      }
      if (!observerRef.current) {
        observerRef.current = new IntersectionObserver(
          (entries) => {
            for (const entry of entries) {
              if (!entry.isIntersecting) continue;
              const cb = visibilityCallbacks.current.get(entry.target);
              if (cb) {
                visibilityCallbacks.current.delete(entry.target);
                observerRef.current?.unobserve(entry.target);
                cb();
              }
            }
          },
          { root: scrollContainerRef?.current ?? null, rootMargin: "600px 0px" },
        );
      }
      visibilityCallbacks.current.set(el, onVisible);
      observerRef.current.observe(el);
      return () => {
        visibilityCallbacks.current.delete(el);
        observerRef.current?.unobserve(el);
      };
    },
    [scrollContainerRef],
  );
  useEffect(
    () => () => {
      observerRef.current?.disconnect();
      observerRef.current = null;
      visibilityCallbacks.current.clear();
    },
    [],
  );

  const tailStart = Math.max(0, messages.length - TAIL_FORCE_MOUNT);

  // B3 placement. A permission's `id` IS the tool-use id: the
  // `api-agent:permission-request` payload echoes the same id that
  // `api-agent:tool-start` puts on the tool call, so the raising call can be
  // found by identity rather than by guesswork. Anything unmatched — an
  // adapter that gates BEFORE it announces the call — falls to the tail of the
  // transcript, which is exactly where the agent is sitting blocked anyway.
  const pendingPermissions = approvals?.permissions ?? NO_PERMISSIONS;
  const placement = useMemo(() => {
    const byMessage = new Map<string, PendingPermission[]>();
    const trailing: PendingPermission[] = [];
    const ownerOf = (perm: PendingPermission) =>
      messages.find((m) => m.toolCalls?.some((tc) => tc.id === perm.id));
    for (const perm of pendingPermissions) {
      const owner = ownerOf(perm);
      if (!owner) {
        trailing.push(perm);
        continue;
      }
      const bucket = byMessage.get(owner.id);
      if (bucket) bucket.push(perm);
      else byMessage.set(owner.id, [perm]);
    }
    // Where the HEAD of the queue landed. The batch rollup and the Y/N hints
    // render against the head, and only there.
    const head = pendingPermissions[0];
    return {
      byMessage,
      trailing,
      headOwnerId: head ? (ownerOf(head)?.id ?? null) : null,
    };
  }, [messages, pendingPermissions]);
  const topPermissionId = pendingPermissions[0]?.id;

  return (
    <>
      {revisions.length > 0 && (
        <div className="mb-2 flex justify-center">
          <button
            type="button"
            onClick={() => setViewingHistory(true)}
            className="inline-flex items-center gap-1 rounded px-2 py-0.5 text-meta text-text-muted transition-colors hover:bg-bg-hover hover:text-text-primary"
          >
            <History size={10} />
            View previous history ({revisions.length})
          </button>
        </div>
      )}

      {messages.map((msg, index) => {
        const isLastAssistant = msg.id === lastAssistantMessage?.id;
        const ownedApprovals = placement.byMessage.get(msg.id);
        // Always mount the tail window + the last assistant message so the
        // streaming card, quick actions and diff viewer never get windowed out.
        // A row holding a live approval joins them unconditionally: a blocking
        // prompt that a virtualized placeholder swallowed is an agent hung on a
        // question the user was never shown.
        const forceMount = index >= tailStart || isLastAssistant || !!ownedApprovals;
        return (
          <LazyMessageRow
            key={msg.id}
            forceMount={forceMount}
            register={register}
            scrollContainerRef={scrollContainerRef}
          >
            <MessageBubble
              message={msg}
              conversation={conversation}
              isLastAssistant={isLastAssistant}
              onRetry={isLastAssistant && !msg.isStreaming ? onRetryLastTurn : undefined}
              isEditing={editingMessageId === msg.id}
              editingText={editingText}
              onStartEdit={
                msg.role === "user" && canMutateHistory
                  ? () => onStartEdit(msg.id, msg.content)
                  : undefined
              }
              onRewindFrom={
                msg.role === "user" && canMutateHistory ? () => onRewindFrom(msg.id) : undefined
              }
              onChangeEdit={onChangeEdit}
              onSubmitEdit={() => onSubmitEdit(msg.id)}
              onCancelEdit={onCancelEdit}
            />
            {approvals && ownedApprovals && (
              <div className="mt-2">
                <InlineApprovals
                  conversationId={conversationId}
                  conversationAllowedTools={conversation.allowedTools}
                  binding={approvals}
                  permissions={ownedApprovals}
                  leading={placement.headOwnerId === msg.id}
                  topPermissionId={topPermissionId}
                />
              </div>
            )}
          </LazyMessageRow>
        );
      })}

      {approvals && placement.trailing.length > 0 && (
        <InlineApprovals
          conversationId={conversationId}
          conversationAllowedTools={conversation.allowedTools}
          binding={approvals}
          permissions={placement.trailing}
          leading={placement.headOwnerId === null}
          topPermissionId={topPermissionId}
        />
      )}

      {conversation.planMode &&
        lastMessage?.role === "assistant" &&
        !lastMessage.isStreaming &&
        looksLikePlan(lastMessage.content) && (
          <PlanModeApprovalMenu conversationId={conversationId} planText={lastMessage.content} />
        )}

      {showThinking && (
        <div className="flex items-center gap-1.5 text-ui text-text-muted">
          <Spinner size={10} className="text-text-muted" label="Thinking" />
          Thinking...
        </div>
      )}

      {viewingHistory && (
        <Modal title="Previous history" onClose={() => setViewingHistory(false)} width="w-[640px]">
          <p className="mb-3 text-meta text-text-muted">
            Rewind saves later messages here. Files were not changed.
          </p>
          <div className="flex max-h-[60vh] flex-col gap-3 overflow-y-auto">
            {[...revisions].reverse().map((revision) => (
              <section
                key={revision.revisionId}
                className="rounded border border-bg-border bg-bg-secondary p-3"
              >
                <header className="mb-2 flex items-center justify-between text-meta text-text-muted">
                  <span>{new Date(revision.createdAt).toLocaleString()}</span>
                  <span>{revision.messageCount} messages</span>
                </header>
                <div className="flex flex-col gap-1.5">
                  {revision.messages.map((message) => (
                    <div key={message.id} className="text-meta text-text-secondary">
                      <span className="mr-1 font-semibold text-text-primary">
                        {message.role === "user"
                          ? "You"
                          : message.role === "assistant"
                            ? "Agent"
                            : "System"}
                        :
                      </span>
                      <span className="whitespace-pre-wrap break-words">{message.content}</span>
                    </div>
                  ))}
                </div>
              </section>
            ))}
          </div>
        </Modal>
      )}
    </>
  );
}

// Lazily mounts a single message row. Force-mounted rows (tail window / last
// assistant) render immediately; the rest render a fixed-height placeholder
// until they scroll near the viewport, then mount once and stay mounted so no
// card loses local state and scroll position never jumps from an unmount.
function LazyMessageRow({
  forceMount,
  register,
  scrollContainerRef,
  children,
}: {
  forceMount: boolean;
  register: (el: Element, onVisible: () => void) => () => void;
  scrollContainerRef?: RefObject<HTMLDivElement | null>;
  children: ReactNode;
}) {
  const [mounted, setMounted] = useState(forceMount);
  const rowRef = useRef<HTMLDivElement>(null);
  // Placeholder height captured at the moment the observer told this row to
  // mount; consumed by the compensation layout effect below.
  const placeholderHeightRef = useRef<number | null>(null);

  useEffect(() => {
    if (forceMount) {
      setMounted(true);
      return;
    }
    const el = rowRef.current;
    if (!el) return;
    return register(el, () => {
      placeholderHeightRef.current = el.getBoundingClientRect().height;
      setMounted(true);
    });
  }, [forceMount, register]);

  // WKWebView has no CSS scroll anchoring, so when a placeholder above the
  // viewport grows to its real height the visible content lurches down by the
  // difference (Safari never adjusts scrollTop the way Chromium/Gecko do).
  // Compensate manually: measure the height delta in a layout effect (same
  // frame, before paint) and shift the scroll container by it when the row
  // sits above the viewport top. Rows at/below the viewport top need nothing,
  // and the at-bottom pin in useScrollState still owns the follow behavior.
  useLayoutEffect(() => {
    if (!mounted) return;
    const placeholderHeight = placeholderHeightRef.current;
    placeholderHeightRef.current = null;
    if (placeholderHeight == null) return;
    const el = rowRef.current;
    const container = scrollContainerRef?.current;
    if (!el || !container) return;
    const delta = el.getBoundingClientRect().height - placeholderHeight;
    if (delta === 0) return;
    if (el.getBoundingClientRect().top < container.getBoundingClientRect().top) {
      container.scrollBy(0, delta);
    }
  }, [mounted, scrollContainerRef]);

  return (
    <div
      ref={rowRef}
      className="animate-[welcomeFadeIn_200ms_ease-out] motion-reduce:animate-none"
      style={mounted ? undefined : { minHeight: PLACEHOLDER_MIN_HEIGHT }}
    >
      {mounted ? children : null}
    </div>
  );
}

function MessageBubble({
  message,
  conversation,
  isLastAssistant,
  onRetry,
  isEditing,
  editingText,
  onStartEdit,
  onRewindFrom,
  onChangeEdit,
  onSubmitEdit,
  onCancelEdit,
}: {
  message: AgentMessage;
  conversation: AgentConversation;
  isLastAssistant?: boolean;
  onRetry?: () => void;
  isEditing?: boolean;
  editingText?: string;
  onStartEdit?: () => void;
  onRewindFrom?: () => void;
  onChangeEdit?: (text: string) => void;
  onSubmitEdit?: () => void;
  onCancelEdit?: () => void;
}) {
  // Two-step confirm for Rewind: later messages move to a saved revision, so
  // a single stray hover-click must not mutate the active transcript. Local
  // state is safe here: rows are mount-once (LazyMessageRow never unmounts).
  const [confirmingRewind, setConfirmingRewind] = useState(false);
  // M4: manual "+ Add to memory" on assistant turns. Both hooks read
  // unconditionally at the top so hook order stays stable across the role
  // early-returns below.
  const [captured, setCaptured] = useState(false);
  const captureManually = useMemoryStore((s) => s.captureManually);
  // Global transcript view mode (P1-17) — read unconditionally at the top so
  // this hook call stays stable across the role early-returns below.
  const verbosity = useAgentSettingsStore((s) => s.transcriptViewMode);
  // System notices are transcript punctuation, not a participant's turn: a
  // centered faint rule-and-label, no card. Dropping the fill keeps the
  // one-card-background rule intact.
  if (message.role === "system") {
    return (
      <div className="flex items-center gap-2 py-0.5">
        <span className="h-px flex-1 bg-line-soft" />
        <div className="max-w-[80%] text-center text-meta text-text-faint">
          <MarkdownRenderer content={message.content} className="text-meta leading-relaxed" />
        </div>
        <span className="h-px flex-1 bg-line-soft" />
      </div>
    );
  }

  if (message.role === "user") {
    if (isEditing) {
      return (
        <div className="flex justify-end">
          <div className="flex w-full max-w-[85%] flex-col gap-1.5 rounded-[14px_14px_4px_14px] border border-accent-line bg-bg-tertiary px-3.5 py-2.5 text-body">
            <textarea
              autoFocus
              value={editingText ?? ""}
              onChange={(e) => onChangeEdit?.(e.target.value)}
              onKeyDown={(e) => {
                if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
                  e.preventDefault();
                  onSubmitEdit?.();
                } else if (e.key === "Escape") {
                  e.preventDefault();
                  onCancelEdit?.();
                }
              }}
              rows={Math.min(8, Math.max(2, (editingText ?? "").split("\n").length))}
              className="w-full resize-none bg-transparent text-body text-text-primary placeholder:text-text-muted focus:outline-none"
            />
            <div className="flex items-center justify-between gap-2">
              <Tooltip content="Creates a new conversation from this turn; the original is kept">
                <span className="text-meta text-text-muted">
                  New conversation from this turn. Original kept. Runs with current files.
                </span>
              </Tooltip>
              <div className="flex items-center gap-1.5">
                <Tooltip content="Cancel (Esc)">
                  <button
                    type="button"
                    onClick={onCancelEdit}
                    className="rounded px-2 py-0.5 text-ui text-text-secondary transition-colors hover:bg-bg-hover hover:text-text-primary"
                  >
                    Cancel
                  </button>
                </Tooltip>
                <Tooltip content="Start the fork (Ctrl+Enter)">
                  <button
                    type="button"
                    onClick={onSubmitEdit}
                    disabled={!(editingText ?? "").trim()}
                    className="rounded bg-accent-green/20 px-2 py-0.5 text-ui font-medium text-accent-green transition-colors hover:bg-accent-green/30 disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    Start fork
                  </button>
                </Tooltip>
              </div>
            </div>
          </div>
        </div>
      );
    }
    return (
      <div className="flex flex-col items-end">
        <div className="group flex w-full justify-end">
          {/* Neutral, not blue: a blue right-aligned bubble reads as a
              messenger app. The asymmetric radius (square bottom-right) is
              what marks the turn as the user's, not the hue. */}
          <div
            className={`relative max-w-[85%] rounded-[14px_14px_4px_14px] border px-3.5 py-2.5 text-body text-text-primary ${
              message.queued
                ? "border-accent-amber/40 bg-accent-amber/10"
                : "border-bg-border bg-bg-tertiary"
            }`}
          >
            <div className="selectable whitespace-pre-wrap break-words">{message.content}</div>
            {message.queued && <span className="ml-1 text-meta text-accent-amber">(queued)</span>}
            {!message.queued && (onStartEdit || onRewindFrom) && (
              <div className="absolute -left-6 top-1/2 flex -translate-y-1/2 flex-col gap-0.5 opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100">
                {onStartEdit && (
                  <Tooltip content="Edit & fork — creates a new conversation from this turn">
                    <button
                      type="button"
                      aria-label="Edit & fork from this turn"
                      onClick={onStartEdit}
                      className="rounded p-0.5 text-text-muted transition-colors hover:bg-bg-hover hover:text-text-primary"
                    >
                      <Pencil size={11} />
                    </button>
                  </Tooltip>
                )}
                {onRewindFrom && (
                  <Tooltip content="Rewind conversation — later messages move to saved history">
                    <button
                      type="button"
                      aria-label="Rewind conversation from this turn"
                      onClick={() => setConfirmingRewind(true)}
                      className="rounded p-0.5 text-text-muted transition-colors hover:bg-bg-hover hover:text-text-primary"
                    >
                      <RotateCcw size={11} />
                    </button>
                  </Tooltip>
                )}
              </div>
            )}
          </div>
        </div>
        {confirmingRewind && (
          <div className="mt-1 flex items-center gap-2 rounded bg-accent-amber/10 px-2 py-1">
            <span className="text-meta text-accent-amber">
              Rewind conversation? Later messages move to a saved history revision. Files stay as
              they are.
            </span>
            <button
              type="button"
              onClick={() => {
                setConfirmingRewind(false);
                onRewindFrom?.();
              }}
              className="rounded bg-accent-amber/20 px-1.5 py-0.5 text-ui font-medium text-accent-amber transition-colors hover:bg-accent-amber/30"
            >
              Rewind
            </button>
            <button
              type="button"
              onClick={() => setConfirmingRewind(false)}
              className="rounded px-1.5 py-0.5 text-ui text-text-secondary transition-colors hover:bg-bg-hover hover:text-text-primary"
            >
              Cancel
            </button>
          </div>
        )}
      </div>
    );
  }

  // Assistant. De-bubbled: no `flex justify-start`, no `max-w-[90%]`, no
  // `bg-bg-secondary` panel. The turn IS the page — markdown renders directly
  // on the background at the body type scale, and the reading measure comes
  // from the centered transcript column, not from a per-bubble max-width.
  const toolCalls =
    message.turnOutcome === "cancelled" && !message.isStreaming
      ? interruptRunningToolCalls(message.toolCalls ?? [])
      : (message.toolCalls ?? []);
  return (
    <div className="group/turn space-y-1.5">
      {verbosity !== "summary" && message.thinking && message.thinking.length > 0 && (
        <ThinkingBlock text={message.thinking} streaming={message.isStreaming} />
      )}

      {/* Rollup XOR individual cards, per tool call: ExplorationRollupCard is
          the sole representation of read/search/list calls (live AND settled),
          and ToolCallRenderer filters exactly those out via
          isExplorationToolName. The two therefore partition message.toolCalls
          and never both render the same call. Keep that classifier as the
          single source of truth on both sides — duplicating the predicate is
          how the transcript ends up showing a call twice. */}
      {toolCalls.length > 0 && (
        <>
          <ExplorationRollupCard toolCalls={toolCalls} isStreaming={message.isStreaming} />
          <ToolCallRenderer
            toolCalls={toolCalls}
            conversationId={conversation.id}
            projectPath={conversation.projectPath}
          />
        </>
      )}

      {message.content && (
        <div>
          <MarkdownRenderer
            content={message.content}
            className="markdown-doc text-body text-text-primary"
          />
          {message.isStreaming && (
            <span className="ml-1 inline-block h-3.5 w-1.5 animate-pulse rounded-sm bg-accent-green/70 align-text-bottom motion-reduce:animate-none" />
          )}
        </div>
      )}

      {message.isStreaming && !message.content && (
        <div className="flex items-center gap-1.5 text-ui text-text-muted">
          <Spinner size={10} className="text-accent-green" label="Responding" />
          Responding...
        </div>
      )}

      {/* Footer actions are hover-revealed. `opacity-0` (not conditional
          render) is deliberate: the row keeps its height either way, so
          revealing it never changes the row height the virtualizer measured. */}
      <div className="flex items-center gap-2">
        <AssistantTokenPill message={message} />
        <div className="flex items-center gap-2 opacity-0 transition-opacity group-focus-within/turn:opacity-100 group-hover/turn:opacity-100 motion-reduce:transition-none">
          {isLastAssistant && !message.isStreaming && onRetry && (
            <Tooltip content="Retry this turn">
              <button
                type="button"
                onClick={onRetry}
                className="rounded p-0.5 text-meta text-text-muted transition-colors hover:text-text-primary"
              >
                <RotateCw size={11} />
              </button>
            </Tooltip>
          )}
          {!message.isStreaming && message.content && conversation.projectPath && (
            <Tooltip content={captured ? "Saved to memory" : "Add this turn to project memory"}>
              <button
                type="button"
                disabled={captured}
                onClick={() => {
                  captureManually(buildTranscriptMemoryInput(message, conversation));
                  setCaptured(true);
                }}
                className="rounded p-0.5 text-meta text-text-muted transition-colors hover:text-accent-green disabled:text-accent-green"
              >
                <BookmarkPlus size={11} />
              </button>
            </Tooltip>
          )}
        </div>
      </div>
    </div>
  );
}

// Per-turn token count. This used to reveal the turn's USD cost on hover; that
// went with the rest of the cost reporting surface on 2026-07-31. The token
// count stays — it is the measurement the prompt-caching work needs, and it
// costs nothing (the numbers are already on the message).
function AssistantTokenPill({ message }: { message: AgentMessage }) {
  const { inputTokens, outputTokens } = message;
  if (inputTokens == null || outputTokens == null) return null;
  return (
    <div className="font-mono text-meta text-text-muted">{inputTokens + outputTokens} tok</div>
  );
}
