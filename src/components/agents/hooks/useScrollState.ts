import { useCallback, useEffect, useRef, useState } from "react";
import type { AgentMessage } from "@/types/agent-conversation";

/**
 * Tracks scroll position in the messages container and pauses auto-scroll
 * once the user has scrolled > 100px from the bottom. Counts unread messages
 * that arrive while the user is scrolled away.
 *
 * F7 — reader continuity. The hook now saves a per-conversation reading
 * anchor (first visible message id + intra-message offset + whether the reader
 * was following latest) and restores it when the user returns to a
 * conversation. The anchor is in-memory (a module map) so A→B→A restores A's
 * reading position while A keeps receiving output without pulling an older
 * reader to the bottom. "Jump to latest" is explicit and resumes following.
 *
 * The anchor re-anchors by message id, never by a raw scrollTop, so
 * resize/font changes keep the reader on the same turn (rows expose
 * `data-message-id` for this lookup).
 */

export interface ReadingAnchor {
  /** First visible message id at save time (null when following latest). */
  messageId: string | null;
  /** Pixels from the container top to the message top (positive = scrolled). */
  offsetWithinMessagePx: number;
  /** True when the reader was pinned to the bottom (follows new output). */
  followingLatest: boolean;
}

const readingAnchors = new Map<string, ReadingAnchor>();

/** Test/teardown helper — clears every in-memory reader anchor. */
export function resetReadingAnchors(): void {
  readingAnchors.clear();
}

/** Read-only peek at a saved reader anchor (tests + diagnostics). */
export function getReadingAnchor(conversationId: string): ReadingAnchor | undefined {
  return readingAnchors.get(conversationId);
}

function firstVisibleMessageId(container: HTMLElement): {
  messageId: string | null;
  offsetWithinMessagePx: number;
} {
  const containerTop = container.getBoundingClientRect().top;
  const rows = container.querySelectorAll("[data-message-id]");
  for (const row of Array.from(rows)) {
    const rect = row.getBoundingClientRect();
    if (rect.bottom > containerTop) {
      return {
        messageId: row.getAttribute("data-message-id"),
        offsetWithinMessagePx: Math.max(0, containerTop - rect.top),
      };
    }
  }
  return { messageId: null, offsetWithinMessagePx: 0 };
}

export function useScrollState(
  conversationId: string,
  messages: AgentMessage[] | undefined,
) {
  const messagesContainerRef = useRef<HTMLDivElement>(null);
  const messagesContentRef = useRef<HTMLDivElement>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const prevMessageCountRef = useRef(0);
  const [isAtBottom, setIsAtBottom] = useState(true);
  const [unreadCount, setUnreadCount] = useState(0);
  // Mirror of isAtBottom readable inside the ResizeObserver callback without
  // resubscribing it on every scroll.
  const isAtBottomRef = useRef(true);
  isAtBottomRef.current = isAtBottom;
  // Which conversation a scroll belongs to (the DOM container persists across
  // conversation switches, so the anchor must be keyed, not implied).
  const conversationIdRef = useRef(conversationId);
  conversationIdRef.current = conversationId;

  const storeAnchor = useCallback((atBottom: boolean) => {
    const el = messagesContainerRef.current;
    if (!el) return;
    if (atBottom) {
      readingAnchors.set(conversationIdRef.current, {
        messageId: null,
        offsetWithinMessagePx: 0,
        followingLatest: true,
      });
      return;
    }
    const { messageId, offsetWithinMessagePx } = firstVisibleMessageId(el);
    readingAnchors.set(conversationIdRef.current, {
      messageId,
      offsetWithinMessagePx,
      followingLatest: false,
    });
  }, []);

  const restoreAnchor = useCallback(() => {
    const anchor = readingAnchors.get(conversationId);
    if (!anchor || anchor.followingLatest || !anchor.messageId) {
      setIsAtBottom(true);
      isAtBottomRef.current = true;
      messagesEndRef.current?.scrollIntoView({ behavior: "auto" });
      return;
    }
    setIsAtBottom(false);
    isAtBottomRef.current = false;
    const doRestore = () => {
      const el = messagesContainerRef.current;
      const row = el?.querySelector<HTMLElement>(
        `[data-message-id="${anchor.messageId}"]`,
      );
      if (!el || !row) return;
      const containerTop = el.getBoundingClientRect().top;
      const targetTop = row.getBoundingClientRect().top - anchor.offsetWithinMessagePx;
      el.scrollTop += targetTop - containerTop;
    };
    if (typeof requestAnimationFrame === "function") requestAnimationFrame(doRestore);
    else doRestore();
  }, [conversationId]);

  useEffect(() => {
    const el = messagesContainerRef.current;
    if (!el) return;
    const onScroll = () => {
      const distFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
      const atBottom = distFromBottom <= 100;
      setIsAtBottom(atBottom);
      if (atBottom) setUnreadCount(0);
      storeAnchor(atBottom);
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, [storeAnchor]);

  // Keep the view pinned to the bottom while the user is at the bottom even
  // when the content height changes asynchronously (lazy-mounted rows growing
  // from their placeholder height, images loading, markdown reflow). Without
  // this, mounting virtualized rows just above the viewport would drift us off
  // the bottom. Only re-pins when already at bottom, so it never fights an
  // intentional scroll-up.
  useEffect(() => {
    const content = messagesContentRef.current;
    if (!content || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => {
      if (isAtBottomRef.current) {
        messagesEndRef.current?.scrollIntoView({ behavior: "auto" });
      }
    });
    ro.observe(content);
    return () => ro.disconnect();
  }, []);

  // Reset live counters on conversation switch, then restore that
  // conversation's saved reading anchor (or follow latest when none exists).
  // Intentionally only depends on conversationId.
  useEffect(() => {
    setUnreadCount(0);
    prevMessageCountRef.current = messages?.length ?? 0;
    restoreAnchor();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversationId]);

  useEffect(() => {
    const count = messages?.length ?? 0;
    const prev = prevMessageCountRef.current;
    prevMessageCountRef.current = count;
    if (isAtBottom) {
      // High-frequency streaming follow: use instant scroll so overlapping
      // smooth animations don't fight each other (jank). Smooth is reserved
      // for the explicit jumpToLatest() user action.
      messagesEndRef.current?.scrollIntoView({ behavior: "auto" });
    } else if (count > prev) {
      setUnreadCount((u) => u + (count - prev));
    }
  }, [messages, isAtBottom]);

  const jumpToLatest = useCallback(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
    setUnreadCount(0);
    setIsAtBottom(true);
    isAtBottomRef.current = true;
    readingAnchors.set(conversationIdRef.current, {
      messageId: null,
      offsetWithinMessagePx: 0,
      followingLatest: true,
    });
  }, []);

  return {
    messagesContainerRef,
    messagesContentRef,
    messagesEndRef,
    isAtBottom,
    unreadCount,
    jumpToLatest,
  };
}
