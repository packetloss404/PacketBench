import { useEffect, useState, type RefObject } from "react";
import { ShieldAlert } from "lucide-react";
import { useAppStore } from "@/stores/appStore";
import { useReviewStore } from "@/stores/reviewStore";
import type { PendingPermission } from "@/types/agent-conversation";
import type { useAgentApprovalStore } from "@/stores/agentApprovalStore";

type ApprovalStore = ReturnType<typeof useAgentApprovalStore.getState>;

/**
 * Blocking permission prompts (shell / network / out-of-project tools) with
 * the Allow/Deny verb pair. P1-8: gated file edits no longer render here —
 * they route into the canonical review surface (ReviewBar/ReviewSurface)
 * with Keep/Undo, so the two verb pairs are never mixed in one surface.
 * Permission prompts outrank edits for the Y/N shortcut; the ReviewBar's
 * edit handler stays passive while any permission is pending.
 *
 * ## What this component is, after B3 (wave 2c)
 *
 * It is no longer a footer band. The CARDS moved into the transcript, at the
 * call site that raised them (`chat/InlineApprovals` via `MessageList`). What
 * stayed here, deliberately unmoved, is:
 *
 *  1. the ONE document-level Y/N keydown handler, its typing-context guards,
 *     and the `keyboardScopeActive` / `scopeArmed` per-tile focus gate. Two
 *     live document handlers would mean every open tile in the workspace
 *     mosaic answering a single keypress, so the effect has exactly one home
 *     and the markup moved around it;
 *  2. what the band degrades to — a floating pill, shown only while the
 *     pending approval is scrolled OUT of view, so an agent blocked above the
 *     fold is never silently waiting.
 */
interface PendingApprovalsSectionProps {
  conversationId: string;
  pendingPermissions: PendingPermission[];
  respondPermission: ApprovalStore["respondPermission"];
  /**
   * Y/N focus gate (P3-S1). Undefined → no pane context (standalone
   * AgentsView), armed exactly as today. Defined → the document-level
   * Allow/Deny handler arms iff true, so only the focused conversation tile
   * answers a keypress. Extends the existing arming condition; the visible
   * prompts still render regardless.
   */
  keyboardScopeActive?: boolean;
  /**
   * The transcript's scroll container. Used as the IntersectionObserver root
   * for "is the pending approval actually on screen?". Omitted → the pill
   * never shows (nothing to measure against), which is the safe direction:
   * the inline card is still rendered either way.
   */
  scrollContainerRef?: RefObject<HTMLDivElement | null>;
}

export function PendingApprovalsSection({
  conversationId,
  pendingPermissions,
  respondPermission,
  keyboardScopeActive,
  scrollContainerRef,
}: PendingApprovalsSectionProps) {
  const totalCount = pendingPermissions.length;

  // Y/N shortcuts target the top permission prompt.
  const topPermission = pendingPermissions[0];

  const commandPaletteOpen = useAppStore((s) => s.commandPaletteOpen);

  // F6 — exact attention. `openAgentAttention` arms the specific card via
  // reviewStore.attentionFocus; this section is the one that knows how to
  // reveal it in the transcript and give it focus. The card revalidates
  // against the still-pending queue first: if the request was already answered
  // before the reveal, it stands down instead of targeting a different card.
  const attentionFocus = useReviewStore((s) => s.attentionFocus);
  const clearAttentionFocus = useReviewStore((s) => s.clearAttentionFocus);

  useEffect(() => {
    if (!attentionFocus || attentionFocus.conversationId !== conversationId) return;
    if (attentionFocus.kind !== "permission") return;

    const container = scrollContainerRef?.current;
    if (!container) {
      clearAttentionFocus(conversationId);
      return;
    }

    // Revalidate against the authoritative queue before mounting the jump.
    const stillPending = pendingPermissions.some((p) => p.id === attentionFocus.requestId);
    if (!stillPending) {
      clearAttentionFocus(conversationId);
      return;
    }

    const card = container.querySelector<HTMLElement>(
      `[data-approval-id="${attentionFocus.requestId}"]`,
    );
    if (!card) {
      // The owning row has not mounted yet — leave the focus armed; the next
      // approval mount re-runs this effect (pendingPermissions identity changes).
      return;
    }
    if (typeof card.scrollIntoView === "function") {
      card.scrollIntoView({ block: "center", behavior: "smooth" });
    }
    // Focus the descriptive heading region, NOT the Allow verb: the user must
    // read the host/scope/command before acting. `tabindex` makes the card
    // programmatically focusable without entering the ordinary tab order.
    card.setAttribute("tabindex", "-1");
    card.focus({ preventScroll: true });
    clearAttentionFocus(conversationId);
  }, [
    attentionFocus,
    conversationId,
    pendingPermissions,
    scrollContainerRef,
    clearAttentionFocus,
  ]);

  // P1-9: Y/N stays live wherever the card happens to be — the top prompt is
  // still the target, so a stacked queue can be drained from the keyboard
  // without hunting for each card. The typing-context guards below keep
  // "y"/"n" usable in the composer and any focused input.
  // Dual-mode focus gate (P3-S1): no pane context (undefined) → armed as
  // today; pane context → armed iff this instance holds keyboard scope.
  const scopeArmed = keyboardScopeActive === undefined || keyboardScopeActive;

  useEffect(() => {
    if (totalCount === 0) return;
    if (commandPaletteOpen) return;
    if (!topPermission) return;
    if (!scopeArmed) return;

    const handler = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.shiftKey || e.altKey || e.metaKey) return;
      const target = e.target as HTMLElement | null;
      if (target) {
        const tag = target.tagName;
        if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
        if (
          target.isContentEditable ||
          target.closest("[contenteditable]:not([contenteditable='false'])")
        ) {
          return;
        }
      }
      const key = e.key.toLowerCase();
      if (key !== "y" && key !== "n") return;
      e.preventDefault();
      if (key === "y") {
        void respondPermission(conversationId, topPermission.id, "allow_once");
      } else {
        void respondPermission(conversationId, topPermission.id, "deny");
      }
    };

    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [
    totalCount,
    commandPaletteOpen,
    topPermission,
    conversationId,
    respondPermission,
    scopeArmed,
  ]);

  // Is any inline approval card currently on screen? Cards tag themselves with
  // `data-approval-id`, so this needs no cross-component plumbing and stays
  // scoped to THIS tile's scroll container (a mosaic of tiles must not measure
  // each other's cards). Optimistically true so the pill never flashes on the
  // frame a card mounts, and true when there is no IntersectionObserver
  // (jsdom / old webviews) so the fallback is "no pill", never "wrong pill".
  const [anyCardVisible, setAnyCardVisible] = useState(true);
  useEffect(() => {
    const container = scrollContainerRef?.current;
    if (totalCount === 0 || !container) {
      setAnyCardVisible(true);
      return;
    }
    if (typeof IntersectionObserver === "undefined") {
      setAnyCardVisible(true);
      return;
    }
    const cards = container.querySelectorAll("[data-approval-id]");
    if (cards.length === 0) {
      setAnyCardVisible(true);
      return;
    }
    const seen = new Map<Element, boolean>();
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) seen.set(entry.target, entry.isIntersecting);
        setAnyCardVisible([...seen.values()].some(Boolean));
      },
      { root: container },
    );
    cards.forEach((card) => observer.observe(card));
    return () => observer.disconnect();
  }, [totalCount, pendingPermissions, scrollContainerRef]);

  if (totalCount === 0) return null;
  if (anyCardVisible) return null;

  const scrollToFirst = () => {
    const container = scrollContainerRef?.current;
    container
      ?.querySelector("[data-approval-id]")
      ?.scrollIntoView({ block: "center", behavior: "smooth" });
  };

  return (
    <button
      type="button"
      onClick={scrollToFirst}
      aria-label={`${totalCount} pending approval${totalCount === 1 ? "" : "s"} — scroll to it`}
      title="Scroll to the waiting approval"
      className="absolute bottom-3 right-3 z-10 inline-flex animate-[welcomeFadeIn_150ms_ease-out] items-center gap-1.5 rounded-full border border-accent-amber/50 bg-bg-elevated px-3 py-1 text-ui shadow-md transition-colors hover:border-accent-amber motion-reduce:animate-none"
    >
      <ShieldAlert size={12} className="shrink-0 text-accent-amber" />
      <span className="font-medium text-accent-amber">
        {totalCount} pending
      </span>
      <span className="text-text-muted">· Y allow · N deny</span>
    </button>
  );
}
