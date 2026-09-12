import { useEffect, useRef } from "react";
import { MessageSquareOff, RotateCcw, Trash2 } from "lucide-react";
import { TileChrome } from "./TileChrome";
import { AgentChatPane } from "@/components/agents/AgentChatPane";
import { useAgentTaskStore } from "@/stores/agentTaskStore";
import { useWorkspaceStore } from "@/stores/workspaceStore";
import { useLayoutStore } from "@/stores/layoutStore";
import { useReviewStore } from "@/stores/reviewStore";
import { getAgentColor } from "@/lib/agentColors";
import type { WorkspacePane as WorkspacePaneType } from "@/types/workspace";
import { recordCompatibilityPaneLoaded } from "@/stores/workspaceAgentsDogfoodStore";

interface ConversationTileProps {
  pane: WorkspacePaneType;
  workspaceId: string;
}

const STATUS_PILL: Record<string, { label: string; className: string }> = {
  active: { label: "active", className: "bg-accent-soft text-accent-green" },
  idle: { label: "idle", className: "bg-bg-elevated text-text-muted" },
  done: { label: "done", className: "bg-accent-soft text-accent-blue" },
  failed: { label: "failed", className: "bg-bg-elevated text-accent-red" },
};

/**
 * Conversation tile (P3-S2). A thin wrapper that mounts the UNFORKED
 * AgentChatPane inside the workspace mosaic. It owns only tile-layer concerns —
 * mosaic drag/zoom chrome, the pointer-down focus arm that drives the Y/N
 * keyboard gate, and the review auto-zoom — while the conversation experience
 * itself is AgentChatPane verbatim (the additive `keyboardScopeActive` prop;
 * no fork, no extraction).
 *
 * TileChrome shares drag, identity, status and zoom controls with the terminal
 * and file tiles; conversation lifecycle actions remain in AgentChatPane.
 */
export function ConversationTile({ pane, workspaceId }: ConversationTileProps) {
  // A conversation pane always carries a string conversationId (enforced by
  // normalizePanes — a stripped id self-heals to a terminal pane, so it never
  // reaches this branch). The `?? ""` keeps TS honest and makes AgentChatPane
  // render its own "not found" fallback in the impossible case.
  const conversationId = pane.conversationId ?? "";

  const conversation = useAgentTaskStore((s) =>
    s.conversations.find((c) => c.id === conversationId),
  );
  const conversationFound = Boolean(conversation);

  useEffect(() => {
    recordCompatibilityPaneLoaded(pane.id, conversationFound);
  }, [conversationFound, pane.id]);

  const activePaneId = useLayoutStore((s) => s.activePaneId);
  const setActivePaneId = useLayoutStore((s) => s.setActivePaneId);
  const zoomedPaneId = useWorkspaceStore((s) => s.zoomedPaneId);
  const setZoomedPane = useWorkspaceStore((s) => s.setZoomedPane);
  const isFocused = activePaneId === pane.id;
  const isZoomed = zoomedPaneId === pane.id;
  // Tile program (P4-S1): a needs-you click / deep link publishes a transient
  // focusPaneRequest; while it targets this tile we render a brief flash. Purely
  // derived from the store request (which auto-clears) — no local timer, no
  // zoom, no rearrange.
  const isFlashing = useWorkspaceStore(
    (s) =>
      s.focusPaneRequest?.paneId === pane.id && s.focusPaneRequest?.workspaceId === workspaceId,
  );

  // Canonical review surface open-state, scoped to this tile's conversation.
  const reviewOpen = useReviewStore((s) => s.open && s.conversationId === conversationId);

  // Auto-zoom on review (autoZoomedBy bookkeeping, kept as a local ref in the
  // tile layer per the sprint). ReviewSurface must NEVER render at raw tile
  // width, so opening review CSS-maximizes this tile via the EXISTING
  // setZoomedPane (siblings visibility:hidden, nothing remounts — PTY/P0-2
  // law). The ref records whether *review* caused the zoom so closing review
  // un-zooms only in that case — a manual zoom the user set before opening
  // review is left intact.
  const autoZoomedByReview = useRef(false);
  useEffect(() => {
    if (reviewOpen) {
      if (useWorkspaceStore.getState().zoomedPaneId !== pane.id) {
        setZoomedPane(pane.id);
        autoZoomedByReview.current = true;
      }
    } else if (autoZoomedByReview.current) {
      autoZoomedByReview.current = false;
      if (useWorkspaceStore.getState().zoomedPaneId === pane.id) {
        setZoomedPane(null);
      }
    }
  }, [reviewOpen, pane.id, setZoomedPane]);

  // X removes the PANE ONLY — the conversation survives as an unplaced fleet
  // row (Bravo conceded close-as-archive conflated layout with lifecycle).
  // The header tooltip says exactly this; nothing is stopped or deleted, so
  // there is no confirm (the shared confirm is reserved for destructive paths).
  const removeTile = () => {
    useWorkspaceStore.getState().removePane(workspaceId, pane.id);
  };

  // Archive is the explicit lifecycle action, distinct from X. It lives in the
  // chat header's overflow menu — the tile's ONE menu since the chrome bar's
  // duplicate kebab was removed.
  const archiveConversation = () => {
    if (conversationId) {
      useAgentTaskStore.getState().archiveConversation(conversationId);
    }
    removeTile();
  };

  // Failed-turn recovery (P3-S3): the tile face offers retryLastTurn; the
  // status pill already goes red. No toast storm — the notification layer
  // already covers session errors.
  const retryLastTurn = () => {
    if (conversationId) {
      void useAgentTaskStore.getState().retryLastTurn(conversationId);
    }
  };

  // Missing-conversation lifecycle state (P3-S3): the id is dangling (file
  // deleted, or the conversation was pruned out from under the pane). Render a
  // fallback with a Remove-tile action — removing deletes the PANE only (the
  // one-directional GC never runs the other way). All hooks above have already
  // executed, so this early return is order-safe.
  if (!conversation) {
    return (
      <div
        data-pane-zoomed={isZoomed || undefined}
        onPointerDown={() => setActivePaneId(pane.id)}
        onFocusCapture={() => setActivePaneId(pane.id)}
        className="flex h-full flex-col items-center justify-center gap-3 rounded-md border border-bg-border bg-bg-primary p-6 text-center"
      >
        <MessageSquareOff size={26} className="text-text-muted opacity-40" />
        <div className="text-ui text-text-secondary">This conversation is no longer available.</div>
        <div className="max-w-[240px] text-meta text-text-muted">
          It may have been deleted. The transcript is gone; this tile can be removed.
        </div>
        <button
          type="button"
          onClick={removeTile}
          className="inline-flex items-center gap-1.5 rounded-md border border-bg-border bg-bg-secondary px-3 py-1.5 text-ui text-text-primary transition-colors hover:bg-bg-hover"
        >
          <Trash2 size={13} />
          Remove tile
        </button>
      </div>
    );
  }

  const color = getAgentColor(conversation.agent);
  const title = conversation.title || "Conversation";
  const isActive = conversation.status === "active";
  const isFailed = conversation.status === "failed";
  const pill = STATUS_PILL[conversation.status ?? "idle"] ?? STATUS_PILL.idle;

  const chrome = (
    <TileChrome
      title={title}
      titleClassName={color.text}
      icon={
        <span
          className={`h-2 w-2 shrink-0 rounded-full ${color.text} bg-current ${isActive ? "animate-pulse motion-reduce:animate-none" : ""}`}
        />
      }
      status={pill}
      isZoomed={isZoomed}
      onToggleZoom={() => setZoomedPane(isZoomed ? null : pane.id)}
    />
  );

  const wrapperBorderClass = isFocused ? "border border-accent-line" : "border border-bg-border";
  // Focus-flash highlight (P4-S1): an amber ring pulse layered over the border
  // while a focusPaneRequest targets this tile.
  const flashClass = isFlashing
    ? "ring-2 ring-accent-amber animate-pulse motion-reduce:animate-none"
    : "";

  return (
    // data-pane-zoomed lets mosaic-overrides.css maximize this tile's
    // already-mounted mosaic tile when zoomed (.mosaic-zoom-active) — the same
    // CSS path terminal tiles use, so no sibling ever remounts.
    // onPointerDown arms the Y/N keyboard gate (activePaneId === pane.id),
    // mirroring TerminalPane's focus convention (which uses onClick) but at
    // pointer-down so focus is set before any subsequent keydown.
    <div
      data-pane-zoomed={isZoomed || undefined}
      onPointerDown={() => {
        if (!isFocused) setActivePaneId(pane.id);
      }}
      className={`flex h-full flex-col overflow-hidden rounded-md ${wrapperBorderClass} ${flashClass}`}
    >
      {chrome}
      {isFailed && (
        <div className="flex shrink-0 items-center gap-2 border-b border-accent-red/30 bg-accent-red/10 px-2 py-1">
          <span className="flex-1 truncate text-meta text-accent-red">Last turn failed.</span>
          <button
            type="button"
            onClick={retryLastTurn}
            onMouseDown={(e) => e.stopPropagation()}
            className="inline-flex shrink-0 items-center gap-1 rounded border border-accent-red/40 px-1.5 py-0.5 text-meta text-accent-red transition-colors hover:bg-accent-red/20"
          >
            <RotateCcw size={11} />
            Retry
          </button>
        </div>
      )}
      <div className="min-h-0 flex-1">
        <AgentChatPane
          conversationId={conversationId}
          onClose={removeTile}
          closeLabel="Close tile"
          closeTooltip="Close tile — removes it from this workspace. The conversation keeps running and stays in the Agents list."
          onArchive={archiveConversation}
          keyboardScopeActive={isFocused}
        />
      </div>
    </div>
  );
}
