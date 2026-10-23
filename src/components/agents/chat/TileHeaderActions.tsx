import { useState } from "react";
import {
  ArrowLeft,
  ChevronDown,
  MoreVertical,
  PanelRight,
  PanelRightClose,
  X,
} from "lucide-react";
import { Tooltip } from "@/components/ui/Tooltip";
import { DiffPaneTrigger } from "../DiffPaneTrigger";
import { HeaderOverflowMenu } from "./HeaderOverflowMenu";
import { useWorkspaceStore } from "@/stores/workspaceStore";
import { capabilitiesFor } from "@/lib/agentCapabilities";
import type { AgentConversation } from "@/types/agent-conversation";

interface TileHeaderActionsProps {
  conversation: AgentConversation;
  conversationId: string;
  diffTotals: { fileCount: number; totalAdds: number; totalDels: number };
  previewOpen: boolean;
  togglePreview: () => void;
  onClose: () => void;
  onExport: () => void;
  /** Pending edits + permissions for this conversation (amber approval badge). */
  pendingApprovalCount: number;
  /** F6: open the EXACT blocker (not just select). When supplied, the approval
   * badge becomes an action that routes to the precise pending card. */
  onOpenAttention?: () => void;
  /** F6: show a compact "Return to review" affordance (present when a saved
   * return anchor exists for this conversation). */
  onReturnToReview?: () => void;
  /** Archive this conversation from the overflow menu. Absent → no Archive row
   * (the Agents view keeps lifecycle actions on the sidebar row). */
  onArchive?: () => void;
  /** Accessible name of the close (X) control. Must describe what closing
   * actually does at THIS mount site. */
  closeLabel?: string;
  /** Tooltip for the close control — states the consequence in full. */
  closeTooltip?: string;
  /**
   * Wave 2c — the right dock's ONLY user-facing entry point.
   *
   * B4 made the Agents dock two-pane-by-default: its 30px rail does not paint
   * until `everOpened`, which left deep links (a preview target, open-in-editor)
   * as the sole way in. This pair restores a hand-operated way to open it.
   *
   * Supplied ONLY where a dock actually exists for this mount (the Agents
   * view). Omitted in the workspace mosaic, where the surface dock belongs to
   * the workspace shell and not to any one conversation tile — a per-tile
   * toggle there would be N controls fighting over one panel.
   */
  dockOpen?: boolean;
  onToggleDock?: () => void;
}

/**
 * Tile-frame ("frame='tile'") variant of the chat header's right cluster —
 * the responsive + lazy-mount economy required by the N-tile mosaic (P3-S3).
 *
 * DO NOT rename `.tile-header-actions` (or the `.agent-chat-header` /
 * `.tile-hide-narrow` hooks in AgentChatPane). `src/styles/conversation-tile.css`
 * targets them through `@container tilehdr` rules; renaming one silently breaks
 * narrow-tile collapse and no test catches it.
 *
 * Ruled hybrid responsive model (no ResizeObserver, no width JS):
 *  - CSS `@container` (see `src/styles/conversation-tile.css`) handles ALL
 *    *visual* collapse of the cheap always-mounted set at narrow widths.
 *  - `HeaderOverflowMenu` is the header's ONE menu. It mounts on first use:
 *    until then an identical-looking placeholder button holds its slot, and its
 *    click mounts the menu already open.
 *
 * ## What moved out (wave 2a)
 *
 * The autonomy chip (`AgentModeChip`), the model picker (`ModelSelector`) and
 * `ContextUsageRing` used to live here behind a lazy "inline controls" reveal.
 * They now live ON the composer — mode chip and model picker in the composer
 * row, the context ring in the composer's context strip — which is where Claude
 * Code and Codex both put them, and which removes the reveal toggle entirely.
 *
 * Two consequences worth knowing:
 *  - the `OPEN_MODEL_DROPDOWN_EVENT` listener that made `/model` work moved to
 *    `composer/Composer.tsx` with the picker. `OPEN_MODE_CHIP_EVENT` needed no
 *    move — `AgentModeChip` has always registered it itself.
 *  - the heavy-control mount economy this file was built around is moot: what
 *    remains (the diffstat chip, the approval badge, the menu placeholder) is
 *    cheap and always mounted.
 *
 * Always-visible narrow set = the Changes diffstat chip (`DiffPaneTrigger`,
 * review entry) and the amber approval badge. Close (X) is always present.
 *
 * ## What moved in (wave 2c)
 *
 * The right-pane toggle (`onToggleDock`). It is the dock's only hand-operated
 * entry point now that the Agents dock ships two-pane with an unpainted rail,
 * and it collapses with `tile-hide-narrow` because a 200px tile has no room to
 * host a dock anyway.
 */
export function TileHeaderActions({
  conversation,
  conversationId,
  diffTotals,
  previewOpen,
  togglePreview,
  onClose,
  onExport,
  pendingApprovalCount,
  onOpenAttention,
  onReturnToReview,
  onArchive,
  // Defaults describe the Agents-view mount (AgentChatPane's onClose there
  // deselects the conversation and shows the New agent screen). The workspace
  // tile passes its own pair — closing a tile removes the pane, not the chat.
  closeLabel = "Close conversation",
  closeTooltip = "Close conversation — returns to the New agent screen. Nothing is stopped or deleted; it stays in the list.",
  dockOpen = false,
  onToggleDock,
}: TileHeaderActionsProps) {
  const caps = capabilitiesFor(conversation);

  // The overflow menu mounts on first use (or when this tile is zoomed);
  // until then a look-alike placeholder holds its place, so the header always
  // shows exactly ONE menu control and never shifts.
  const [menuMounted, setMenuMounted] = useState(false);
  const [menuOpenSignal, setMenuOpenSignal] = useState(0);

  // Is THIS conversation's tile the currently-zoomed pane? Cheap boolean
  // selector — re-renders only when the answer flips (not on every workspace
  // write). Zoomed tiles have room, so their menu mounts eagerly.
  const isZoomedTile = useWorkspaceStore((s) => {
    const zid = s.zoomedPaneId;
    if (!zid) return false;
    for (const ws of s.workspaces) {
      const pane = ws.panes.find((p) => p.id === zid);
      if (pane) {
        return pane.kind === "conversation" && pane.conversationId === conversationId;
      }
    }
    return false;
  });

  const menuActive = menuMounted || isZoomedTile;

  return (
    <div className="tile-header-actions flex shrink-0 items-center gap-1">
      {/* --- Always-visible narrow set --- */}
      {caps.structuredEdits && (
        <DiffPaneTrigger
          conversationId={conversationId}
          fileCount={diffTotals.fileCount}
          totalAdds={diffTotals.totalAdds}
          totalDels={diffTotals.totalDels}
        />
      )}
      {pendingApprovalCount > 0 && (
        <Tooltip
          content={`${pendingApprovalCount} pending approval${pendingApprovalCount === 1 ? "" : "s"}${
            onOpenAttention ? " — open it" : ""
          }`}
        >
          {onOpenAttention ? (
            <button
              type="button"
              onClick={onOpenAttention}
              className="tile-approval-badge inline-flex min-w-[1.1rem] items-center justify-center rounded-full bg-accent-amber/20 px-1.5 py-0.5 font-mono text-meta font-semibold text-accent-amber transition-colors hover:bg-accent-amber/30"
              aria-label={`${pendingApprovalCount} pending approval${
                pendingApprovalCount === 1 ? "" : "s"
              } — open it`}
            >
              {pendingApprovalCount}
            </button>
          ) : (
            <span
              className="tile-approval-badge inline-flex min-w-[1.1rem] items-center justify-center rounded-full bg-accent-amber/20 px-1.5 py-0.5 font-mono text-meta font-semibold text-accent-amber"
              aria-label={`${pendingApprovalCount} pending approvals`}
            >
              {pendingApprovalCount}
            </span>
          )}
        </Tooltip>
      )}
      {onReturnToReview && (
        <Tooltip content="Return to where you were reviewing before this request">
          <button
            type="button"
            onClick={onReturnToReview}
            aria-label="Return to review"
            className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-meta font-medium text-accent-blue transition-colors hover:bg-bg-hover hover:text-text-primary"
          >
            <ArrowLeft size={11} />
            Return to review
          </button>
        </Tooltip>
      )}

      {/* Right-pane toggle. Hidden at narrow tile widths via the existing
          `tile-hide-narrow` container rule — the dock is a wide-window
          affordance, and a 200px tile has nothing to give it. */}
      {onToggleDock && (
        <Tooltip
          content={
            dockOpen
              ? "Hide the right pane"
              : "Show the right pane — preview, diff and editor"
          }
        >
          <button
            type="button"
            onClick={onToggleDock}
            aria-pressed={dockOpen}
            aria-label={dockOpen ? "Hide right pane" : "Show right pane"}
            className={`tile-hide-narrow rounded p-1 transition-colors hover:bg-bg-hover ${
              dockOpen ? "text-text-primary" : "text-text-muted hover:text-text-primary"
            }`}
          >
            {dockOpen ? <PanelRightClose size={12} /> : <PanelRight size={12} />}
          </button>
        </Tooltip>
      )}

      {/* The ONE overflow menu of this header. Mounted on first use; the
          placeholder below is its visual stand-in until then. */}
      {menuActive ? (
        <HeaderOverflowMenu
          conversation={conversation}
          previewOpen={previewOpen}
          togglePreview={togglePreview}
          onExport={onExport}
          openSignal={menuOpenSignal}
          onArchive={onArchive}
        />
      ) : (
        <button
          type="button"
          onClick={() => {
            setMenuMounted(true);
            setMenuOpenSignal((n) => n + 1);
          }}
          aria-label="Conversation menu"
          aria-haspopup="menu"
          className="flex items-center gap-1 rounded px-2 py-1 text-text-muted transition-colors hover:bg-bg-hover hover:text-text-primary"
        >
          <span className="inline-flex p-0.5">
            <MoreVertical size={12} />
          </span>
          <ChevronDown size={10} />
        </button>
      )}

      <Tooltip content={closeTooltip}>
        <button
          onClick={onClose}
          className="rounded p-0.5 text-text-muted transition-colors hover:text-text-primary"
          aria-label={closeLabel}
        >
          <X size={12} />
        </button>
      </Tooltip>
    </div>
  );
}
