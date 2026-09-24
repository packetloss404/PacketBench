import { useCallback, useMemo, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { ArrowDown, ArrowLeft, MessageSquareOff, Sparkles } from "lucide-react";
import { MemoryInjectionCard } from "./MemoryInjectionCard";
import { AgentHeaderBadges } from "./AgentHeaderBadges";
import { PlanPanel } from "./PlanPanel";
import { deriveMode, flagsForMode, nextMode } from "./agentModeChipUtils";
import type { AgentMode } from "./AgentModeChip";
import { ClickablePathsRoot } from "@/components/common/wrapClickablePaths";
import { useAgentTaskStore } from "@/stores/agentTaskStore";
import {
  EMPTY_PENDING_EDITS,
  EMPTY_PENDING_PERMISSIONS,
  useAgentApprovalStore,
} from "@/stores/agentApprovalStore";
import {
  hidePreview,
  openMarkdownPreview,
  useIsPreviewVisible,
} from "@/lib/previewDock";
import { useRightDockStore } from "@/stores/rightDockStore";
import { useMemoryStore, type MemoryBrief } from "@/stores/memoryStore";
import { TileHeaderActions } from "./chat/TileHeaderActions";
import { handleExport } from "./chat/handleExport";
import { EmptyConversationHint } from "./chat/EmptyConversationHint";
import { PendingDiffCommentsStrip } from "./chat/PendingDiffCommentsStrip";
import { MessageList } from "./chat/MessageList";
import { PendingApprovalsSection } from "./chat/PendingApprovalsSection";
import { Composer } from "./composer/Composer";
import { ReviewBar } from "./review/ReviewBar";
import { ReviewSurface } from "./review/ReviewSurface";
import { useReviewStore } from "@/stores/reviewStore";
import { useScrollState } from "./hooks/useScrollState";
import { useLatestPlanPreview } from "./hooks/useLatestPlanPreview";
import { useDiffTotals } from "./hooks/useDiffTotals";
import { Tooltip } from "@/components/ui/Tooltip";
import { capabilitiesFor } from "@/lib/agentCapabilities";
import { isRemoteConversation } from "@/lib/remoteConversation";
import type { DockSurface } from "@/stores/rightDockStore";

const AGENT_LABELS: Record<string, string> = {
  "claude-code": "Claude Code",
  codex: "Codex",
  opencode: "OpenCode",
  packetcode: "PacketCode",
  // Retired transport; kept so a stored conversation on the id still has a name.
  "api-packetcode": "PacketCode (ACP)",
};

const STATUS_DISPLAY: Record<string, { label: string; className: string }> = {
  active: { label: "Active", className: "text-accent-green" },
  idle: { label: "Idle", className: "text-text-muted" },
  done: { label: "Done", className: "text-accent-blue" },
  failed: { label: "Failed", className: "text-accent-red" },
};

interface AgentChatPaneProps {
  conversationId: string;
  onClose: () => void;
  /**
   * Honest naming for the header's close (X) control at THIS mount site —
   * closing means different things in the Agents view (deselect) and in a
   * workspace tile (remove the pane). Omitted → the Agents-view wording.
   */
  closeLabel?: string;
  closeTooltip?: string;
  /** Archive action for the header overflow menu (workspace tile only). */
  onArchive?: () => void;
  /**
   * Y/N keyboard focus gate for the protected approval shortcuts. Undefined
   * → armed exactly as today. Defined (tile context) → the document-level Y/N
   * handlers arm iff true, so only the focused tile responds to a keypress.
   * The tile passes `activePaneId === pane.id` in P3-S2.
   */
  keyboardScopeActive?: boolean;
  /**
   * Right-dock surface this pane's header may open, if any.
   *
   * Set to "agents" by `AgentsView`, whose dock (preview / diff / editor) is a
   * sibling of this pane. B4 made that dock two-pane-by-default — its rail does
   * not paint until `everOpened` — so without a header control the only way in
   * was a deep link. Left UNSET in the workspace mosaic: there the dock belongs
   * to the workspace shell, not to any one conversation tile, and N tiles each
   * offering a toggle for one shared panel is N wrong controls.
   */
  dockSurface?: DockSurface;
}

// "← back to plan" link shown when this conversation was spawned by a
// Codex handoff. Resolves the parent name lazily; renders nothing if the
// parent has been deleted (cleanup is automatic).
function BackToParentLink({ parentId }: { parentId: string }) {
  const parent = useAgentTaskStore((s) => s.conversations.find((c) => c.id === parentId));
  const selectConversation = useAgentTaskStore((s) => s.selectConversation);
  if (!parent) return null;
  return (
    <Tooltip content={`Spawned via "Hand off to Codex" from "${parent.title}"`}>
      <button
        type="button"
        onClick={() => selectConversation(parentId)}
        className="flex items-center gap-1 rounded border border-bg-border bg-bg-secondary px-1.5 py-0.5 text-ui text-text-muted transition-colors hover:text-accent-blue"
      >
        <ArrowLeft size={11} />
        back to plan
      </button>
    </Tooltip>
  );
}

export function AgentChatPane({
  conversationId,
  onClose,
  closeLabel,
  closeTooltip,
  onArchive,
  keyboardScopeActive,
  dockSurface,
}: AgentChatPaneProps) {
  const conversation = useAgentTaskStore((s) =>
    s.conversations.find((c) => c.id === conversationId),
  );
  const isStopping = useAgentTaskStore(
    (s) => s.cancellingConversationIds?.has(conversationId) ?? false,
  );

  // Grouped store actions — keeps reference stable across renders.
  const actions = useAgentTaskStore(
    useShallow((s) => ({
      changeModel: s.changeModel,
      setPlanMode: s.setPlanMode,
      setPermissionMode: s.setPermissionMode,
      setApproveWrites: s.setApproveWrites,
      appendAllowedToolPattern: s.appendAllowedToolPattern,
      removeDiffComment: s.removeDiffComment,
      clearDiffComments: s.clearDiffComments,
      retryLastTurn: s.retryLastTurn,
      forkAndResend: s.forkAndResend,
    })),
  );

  // Approval actions live in their own substore now — group them so the
  // permission section, review surface, and composer see stable references.
  const approvalActions = useAgentApprovalStore(
    useShallow((s) => ({
      respondPermission: s.respondPermission,
      respondEdit: s.respondEdit,
      cancelPendingTools: s.cancelPendingTools,
    })),
  );
  // Live queues read from the substore — drives the per-item cards and the
  // composer's single canonical cancel-pending action.
  const pendingPermissions = useAgentApprovalStore(
    (s) => s.permissions.get(conversationId) ?? EMPTY_PENDING_PERMISSIONS,
  );
  const pendingEdits = useAgentApprovalStore(
    (s) => s.edits.get(conversationId) ?? EMPTY_PENDING_EDITS,
  );
  // Canonical review surface (P1-8): expanded state lives in reviewStore so
  // transcript chips / MultiFileEditCard / the header chip can deep-link.
  const reviewOpen = useReviewStore(
    (s) => s.open && s.conversationId === conversationId,
  );
  const closeReview = useReviewStore((s) => s.close);

  // P0-3: preview visibility is the dock's, the target is conversation-scoped,
  // and Hide/Show are one verb each (see lib/previewDock).
  const previewOpen = useIsPreviewVisible();
  const openPreviewPanel = useRightDockStore((s) => s.openPanel);
  const togglePreview = useCallback(() => {
    if (previewOpen) hidePreview();
    else openPreviewPanel("agents", "preview");
  }, [previewOpen, openPreviewPanel]);

  // Wave 2c — the header's right-pane toggle. Reads/writes only `expanded`:
  // `RightDock` already falls back to the first selectable panel when nothing
  // has been chosen, and `setExpanded(surface, true)` is what flips
  // `everOpened` so the rail (the way back) starts painting.
  const dockExpanded = useRightDockStore((s) =>
    dockSurface ? s.surfaces[dockSurface].expanded : false,
  );
  const setDockExpanded = useRightDockStore((s) => s.setExpanded);
  const toggleDock = useCallback(() => {
    if (!dockSurface) return;
    setDockExpanded(dockSurface, !dockExpanded);
  }, [dockSurface, dockExpanded, setDockExpanded]);
  const memoryEvents = useMemoryStore((s) => s.events);
  const memoryPatterns = useMemoryStore((s) => s.patterns);
  const composeMemoryBrief = useMemoryStore((s) => s.composeMemoryBrief);

  // Inline edit of a prior user message. Submit forks the conversation here.
  const [editState, setEditState] = useState<{ id: string | null; text: string }>({
    id: null,
    text: "",
  });
  const [settingsError, setSettingsError] = useState<string | null>(null);

  function updateSetting(change: Promise<void>) {
    setSettingsError(null);
    void change.catch((error) => setSettingsError(`Could not update conversation settings: ${String(error)}`));
  }

  const { messagesContainerRef, messagesContentRef, messagesEndRef, isAtBottom, unreadCount, jumpToBottom } =
    useScrollState(conversationId, conversation?.messages);

  useLatestPlanPreview(conversation, conversationId);

  const diffTotals = useDiffTotals(conversation);
  const memoryBrief = useMemo<MemoryBrief>(() => {
    if (!conversation?.projectPath) {
      return { text: "", items: [], charBudget: 0, truncated: false, scopeKey: "" };
    }
    const scope = conversation.sshTarget
      ? {
          kind: "ssh" as const,
          projectPath: conversation.projectPath,
          serverId: conversation.sshTarget.id,
          remotePath: conversation.sshTarget.remotePath,
        }
      : { kind: "local" as const, projectPath: conversation.projectPath };
    return composeMemoryBrief(scope);
    // composeMemoryBrief reads memory state through get(); include
    // events/patterns so counts update live while the conversation is open.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    conversation?.id,
    conversation?.projectPath,
    conversation?.sshTarget,
    composeMemoryBrief,
    memoryEvents,
    memoryPatterns,
  ]);

  if (!conversation) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 bg-bg-primary">
        <MessageSquareOff size={24} className="text-text-muted opacity-40" />
        <span className="text-ui text-text-secondary">Conversation not found</span>
        <span className="text-meta text-text-muted">It may have been deleted.</span>
      </div>
    );
  }

  const status = isStopping
    ? { label: "Stopping…", className: "text-accent-amber" }
    : (STATUS_DISPLAY[conversation.status] ?? STATUS_DISPLAY.idle);
  const agentLabel = AGENT_LABELS[conversation.agent] ?? conversation.agent;
  const caps = capabilitiesFor(conversation);

  // B3 — approvals render inline in the transcript, so the transcript needs
  // the queue and the two store actions that answer it. `undefined` is the
  // capability gate: an adapter that cannot pause a tool call for a decision
  // gets no approval chrome at all, rather than chrome that can never fire.
  const approvalsBinding = caps.canApprovePerTool
    ? {
        permissions: pendingPermissions,
        respondPermission: approvalActions.respondPermission,
        appendAllowedToolPattern: actions.appendAllowedToolPattern,
      }
    : undefined;

  // isActive = actively streaming / waiting for the agent ("running" in the UI sense).
  const isActive = conversation.status === "active";
  const messages = conversation.messages;

  // Claude-Code-style mode set/cycle. Applies flagsForMode(next) to the
  // conversation so the chip always reflects the actual posture. The current
  // approveWrites is threaded through flagsForMode so a mode change can never
  // clobber the fine flag.
  function applyMode(next: AgentMode) {
    if (!conversation || conversation.mode !== "api") return;
    const flags = flagsForMode(next, conversation.approveWrites ?? false);
    if (flags.planMode !== (conversation.planMode ?? false)) {
      updateSetting(actions.setPlanMode(conversationId, flags.planMode));
    }
    if (flags.permissionMode !== (conversation.permissionMode ?? "ask_for_risky")) {
      updateSetting(actions.setPermissionMode(conversationId, flags.permissionMode));
    }
    if (flags.approveWrites !== (conversation.approveWrites ?? false)) {
      updateSetting(actions.setApproveWrites(conversationId, flags.approveWrites));
    }
  }

  function cycleMode() {
    if (!conversation || conversation.mode !== "api") return;
    applyMode(nextMode(deriveMode(conversation)));
  }

  // D3 / P0-4: Markdown preview reads LOCAL disk. On an SSH-backed
  // conversation `projectPath` is the remote path, so clicking a .md token
  // must not open a preview that would read an unrelated local file. The
  // handler is omitted entirely for remote conversations, which also stops
  // ClickablePathsRoot from turning those tokens into left-click targets.
  const isRemote = isRemoteConversation(conversation);
  function handleOpenMarkdown(path: string) {
    if (!/\.mdx?$/i.test(path)) return;
    openMarkdownPreview(conversationId, path);
  }

  /* ----------------- render ----------------- */

  // Pending approvals (Composer's cancel button, PendingApprovalsSection).
  const pendingApprovalCount = pendingEdits.length + pendingPermissions.length;

  // Politely announced to screen readers: status transitions + the latest
  // assistant output as it streams in.
  let lastAssistantText = "";
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "assistant") {
      lastAssistantText = messages[i].content;
      break;
    }
  }

  // aria-live is gated to the focused tile (P3-S3): with N tiles all live at
  // once, every tile announcing its stream would be a screen-reader screech.
  // `keyboardScopeActive` is undefined in standalone (announce, byte-identical
  // to today) and the isFocused boolean in tile frame (announce iff focused).
  const announce = keyboardScopeActive !== false;

  const chatContent = (
    <div className="flex h-full flex-col">
      {/* Header bar — sparkle avatar + title + agent/status chips. Single row
          snapped to the shared h-[33px] baseline. Project / branch / MCP / SSH
          are NOT here: they are context chips on the composer's context strip
          (the old full-bleed SessionMetaLine band is gone, and its 30s
          gitSafetyCheck poll moved with the chip). The `agent-chat-header` hook
          turns the row into a query container (all @container rules are scoped
          to [data-frame="tile"] in conversation-tile.css). */}
      <div className="agent-chat-header flex h-[33px] shrink-0 items-center gap-2.5 border-b border-bg-border bg-bg-secondary px-3">
        <div className="grid h-[26px] w-[26px] shrink-0 place-items-center rounded-md border border-accent-line bg-accent-soft">
          <Sparkles size={13} className="text-accent-green" />
        </div>
        <div className="flex min-w-0 flex-1 items-center gap-1.5">
          <span className="truncate text-ui font-semibold text-text-primary">
            {conversation.title || agentLabel}
          </span>
          {/* Status dot, NOT an identity dot. `getAgentColor(conversation.agent)`
              used to paint this per provider — identity deciding chrome, which
              the capability rule forbids. It now carries the one fact a dot can
              usefully carry: whether this session is running, done, failed or
              parked. The provider still names itself in the title and tooltip. */}
          <span
            aria-hidden="true"
            data-status={conversation.status}
            className={`h-1.5 w-1.5 shrink-0 rounded-full bg-current ${status.className} ${isActive ? "animate-pulse motion-reduce:animate-none" : ""}`}
          />
          <span className={`tile-hide-narrow text-meta font-medium ${status.className}`}>
            {status.label}
          </span>
          <AgentHeaderBadges conversation={conversation} />
          {conversation.parentConversationId && (
            <BackToParentLink parentId={conversation.parentConversationId} />
          )}
        </div>

        <TileHeaderActions
          conversation={conversation}
          conversationId={conversationId}
          diffTotals={diffTotals}
          previewOpen={previewOpen}
          togglePreview={togglePreview}
          onClose={onClose}
          closeLabel={closeLabel}
          closeTooltip={closeTooltip}
          onArchive={onArchive}
          onExport={() => void handleExport(conversation)}
          pendingApprovalCount={pendingApprovalCount}
          dockOpen={dockExpanded}
          onToggleDock={dockSurface ? toggleDock : undefined}
        />
      </div>

      <div aria-live={announce ? "polite" : "off"} aria-atomic="true" className="sr-only">
        {announce ? `${status.label}. ${lastAssistantText}` : ""}
      </div>

      <PlanPanel conversation={conversation} />

      <ClickablePathsRoot
        projectPath={conversation.projectPath}
        onOpenMarkdown={isRemote ? undefined : handleOpenMarkdown}
        remote={isRemote}
      >
        <div className="relative flex min-h-0 flex-1 flex-col">
          <div ref={messagesContainerRef} className="flex-1 overflow-y-auto">
            {/* A3 — the reading measure. The transcript is a centered
                `max-w-chat` column instead of full-bleed at every width, and
                turn spacing comes from `gap-turn` rather than `space-y-turn`.
                This element ALSO carries `messagesContentRef`: useScrollState's
                ResizeObserver measures it so "stick to bottom" stays pinned as
                virtualized rows lazily mount and grow. Keep the ref on whatever
                element carries the spacing — moving it breaks scroll tracking. */}
            <div
              ref={messagesContentRef}
              className="mx-auto flex max-w-chat flex-col gap-turn px-6 pb-4 pt-8"
            >
              {conversation.mode === "api" && conversation.memoryContextEnabled && (
                <MemoryInjectionCard brief={memoryBrief} />
              )}

              {messages.length === 0 && <EmptyConversationHint />}

              <MessageList
                conversation={conversation}
                conversationId={conversationId}
                editingMessageId={editState.id}
                editingText={editState.text}
                onStartEdit={(id, content) => setEditState({ id, text: content })}
                onChangeEdit={(text) => setEditState((s) => ({ ...s, text }))}
                onSubmitEdit={(msgId) => {
                  const text = editState.text;
                  setEditState({ id: null, text: "" });
                  void actions.forkAndResend(conversationId, msgId, text);
                }}
                onCancelEdit={() => setEditState({ id: null, text: "" })}
                onRestoreFrom={(msgId, content) =>
                  void actions.forkAndResend(conversationId, msgId, content)
                }
                onRetryLastTurn={() => void actions.retryLastTurn(conversationId)}
                isActive={isActive}
                scrollContainerRef={messagesContainerRef}
                approvals={approvalsBinding}
              />

              <div ref={messagesEndRef} />
            </div>
          </div>
          {/* B3 — what the old footer band degraded to. The approval CARDS are
              inline in the transcript above (MessageList → InlineApprovals);
              this renders only the floating "N pending · Y allow · N deny"
              pill, and only while every card is scrolled out of view. It also
              owns the ONE document-level Y/N handler and its per-tile focus
              gate, which is why it stays mounted whether or not the pill
              shows. */}
          {approvalsBinding && (
            <PendingApprovalsSection
              conversationId={conversationId}
              pendingPermissions={pendingPermissions}
              respondPermission={approvalActions.respondPermission}
              keyboardScopeActive={keyboardScopeActive}
              scrollContainerRef={messagesContainerRef}
            />
          )}
          {!isAtBottom && (
            <Tooltip content="Jump to latest">
              <button
                type="button"
                onClick={jumpToBottom}
                className="absolute bottom-3 left-1/2 z-10 inline-flex -translate-x-1/2 items-center gap-1.5 rounded-full border border-bg-border bg-bg-primary px-3 py-1 text-ui text-text-secondary shadow-md transition-colors hover:border-accent-green/60 hover:text-text-primary"
              >
                <ArrowDown size={12} />
                <span>{unreadCount > 0 ? `${unreadCount} new` : "Latest"}</span>
              </button>
            </Tooltip>
          )}
          {/* Expanded canonical review surface — takes over the transcript
              area (header/composer stay visible) until collapsed. */}
          {reviewOpen && (
            <div className="absolute inset-0 z-20 bg-bg-primary">
              <ReviewSurface
                conversationId={conversationId}
                onClose={closeReview}
              />
            </div>
          )}
        </div>
      </ClickablePathsRoot>

      {(conversation.pendingDiffComments?.length ?? 0) > 0 && (
        <PendingDiffCommentsStrip
          conversation={conversation}
          onRemove={(id) => actions.removeDiffComment(conversationId, id)}
          onClear={() => actions.clearDiffComments(conversationId)}
        />
      )}

      {conversation.mode === "api" && (
        <ReviewBar
          conversationId={conversationId}
          diffTotals={diffTotals}
          pendingEdits={pendingEdits}
          pendingPermissionCount={pendingPermissions.length}
          respondEdit={approvalActions.respondEdit}
          keyboardScopeActive={keyboardScopeActive}
        />
      )}

      {settingsError && <p role="alert" className="px-3 py-1 text-xs text-accent-red">{settingsError}</p>}
      <Composer
        variant="chat"
        conversationId={conversationId}
        conversation={conversation}
        pendingApprovalCount={pendingApprovalCount}
        onCancelPending={() => void approvalActions.cancelPendingTools(conversationId)}
        onCycleMode={cycleMode}
        onSelectMode={applyMode}
        onSetApproveWrites={(on) => updateSetting(actions.setApproveWrites(conversationId, on))}
        onChangeModel={(model) => updateSetting(actions.changeModel(conversationId, model))}
      />
    </div>
  );

  return (
    <div className="flex h-full bg-bg-primary" data-frame="tile">
      <div className="min-w-0 flex-1">{chatContent}</div>
    </div>
  );
}
