import { create } from "zustand";
import { loadFromStorage, saveToStorage } from "@/lib/storage";

import { storageKey } from "@/lib/brand";
/**
 * The canonical review surface's store (consensus P1-8).
 *
 * Owns two things:
 *
 * 1. Ephemeral open/focus state for the single multibuffer review panel
 *    that the "N files · +X/−Y · Review" bar above the composer expands
 *    into. Replaces the old `diffPaneStore` slide-out state. Intentionally
 *    not persisted — the panel always reopens closed after a restart.
 *
 * 2. The persisted per-file "Viewed" slice (GitHub-PR-style checkbox).
 *    Replaces the old `useReviewedDiffs` hand-rolled pub/sub + unbounded
 *    localStorage map. Keyed `conversationId → path → signature`, where
 *    the signature captures the edit chain the user acknowledged — a new
 *    edit to the same file changes the signature, so the file drops back
 *    to unviewed (exactly GitHub's "changed since you viewed it" reset).
 *    Bounded the same way composer drafts are: `clearConversation` runs
 *    from agentTaskStore's delete/cleanup path.
 */

const VIEWED_STORAGE_KEY = storageKey("review-viewed-v1");

/** conversationId → path → signature the user marked as viewed. */
type ViewedMap = Record<string, Record<string, string>>;

/**
 * Signature of one file's edit chain as shown by the review surface.
 * `writeCount` bumps with every edit-bearing tool call touching the path
 * and the content length catches same-count rewrites — cheap, and a false
 * "still viewed" requires an edit preserving both.
 */
export function editSignature(entry: {
  writeCount: number;
  content: string;
}): string {
  return `${entry.writeCount}:${entry.content.length}`;
}

function loadViewed(): ViewedMap {
  const raw = loadFromStorage<Record<string, unknown>>(VIEWED_STORAGE_KEY, {});
  const out: ViewedMap = {};
  for (const [convId, files] of Object.entries(raw ?? {})) {
    if (!files || typeof files !== "object" || Array.isArray(files)) continue;
    const clean: Record<string, string> = {};
    for (const [path, sig] of Object.entries(files as Record<string, unknown>)) {
      if (typeof sig === "string") clean[path] = sig;
    }
    if (Object.keys(clean).length > 0) out[convId] = clean;
  }
  return out;
}

/**
 * F6/F7: a saved reader/review position to return to after an attention or
 * search jump. Ephemeral (in-memory) — it describes where the user was, never
 * what the conversation holds. `filePath` is null when the review panel was
 * not open (a plain reader position instead).
 */
export interface ReviewReturnAnchor {
  conversationId: string;
  filePath: string | null;
  offsetPx: number;
}

/** F6: the exact approval card an attention open must reveal + focus. */
export interface AttentionFocus {
  conversationId: string;
  kind: "permission" | "edit" | "plan" | "failure";
  requestId: string;
  /** Ephemeral token — never a serialized HTMLElement reference. */
  focusToken: string;
}

/** F7: a search result's navigation target (stable message/revision identity). */
export interface SearchNavigationTarget {
  conversationId: string;
  messageId: string;
  transcriptRevisionId?: string;
  token: string;
}

interface ReviewStore {
  /** True while the expanded multibuffer panel is open in the chat pane. */
  open: boolean;
  /** Conversation the panel is scoped to (null = never opened). */
  conversationId: string | null;
  /** Deep-link target: the surface scrolls this file's section into view. */
  focusPath: string | null;
  /** Persisted per-file Viewed acknowledgements. */
  viewed: ViewedMap;
  /** F6: the review/reader position to restore after an attention jump. */
  returnAnchor: ReviewReturnAnchor | null;
  /** F6: the approval card to reveal + focus after `openAgentAttention`. */
  attentionFocus: AttentionFocus | null;
  /** F7: the turn a search result must navigate to (consumed by MessageList). */
  searchNavigation: SearchNavigationTarget | null;

  openForConversation: (conversationId: string, path?: string) => void;
  close: () => void;

  saveReturnAnchor: (
    conversationId: string,
    filePath: string | null,
    offsetPx: number,
  ) => void;
  /** Peek (no clear) — the header reads this to show "Return to review". */
  getReturnAnchor: (conversationId: string) => ReviewReturnAnchor | null;
  /** Consume + clear — used by the actual return navigation. */
  restoreReturnAnchor: (conversationId: string) => ReviewReturnAnchor | null;

  setAttentionFocus: (focus: AttentionFocus | null) => void;
  clearAttentionFocus: (conversationId: string) => void;

  setSearchNavigation: (target: SearchNavigationTarget | null) => void;
  clearSearchNavigation: (conversationId: string) => void;

  /** Mark / unmark a file's current edit signature as viewed. */
  setViewed: (
    conversationId: string,
    path: string,
    signature: string,
    viewed: boolean,
  ) => void;
  /** True when the stored signature matches the file's current one. */
  isViewed: (conversationId: string, path: string, signature: string) => boolean;

  /** GC hook — called when a conversation is deleted so the persisted
   * viewed map stays bounded by live conversations. */
  clearConversation: (conversationId: string) => void;
}

export const useReviewStore = create<ReviewStore>((set, get) => ({
  open: false,
  conversationId: null,
  focusPath: null,
  viewed: loadViewed(),
  returnAnchor: null,
  attentionFocus: null,
  searchNavigation: null,

  openForConversation: (conversationId, path) =>
    set({
      open: true,
      conversationId,
      focusPath: path ?? null,
    }),

  saveReturnAnchor: (conversationId, filePath, offsetPx) =>
    set({
      returnAnchor: {
        conversationId,
        filePath,
        offsetPx: Number.isFinite(offsetPx) ? offsetPx : 0,
      },
    }),

  getReturnAnchor: (conversationId) => {
    const anchor = get().returnAnchor;
    return anchor && anchor.conversationId === conversationId ? anchor : null;
  },

  restoreReturnAnchor: (conversationId) => {
    const anchor = get().returnAnchor;
    if (!anchor || anchor.conversationId !== conversationId) return null;
    set({ returnAnchor: null });
    return anchor;
  },

  setAttentionFocus: (focus) => set({ attentionFocus: focus }),

  clearAttentionFocus: (conversationId) => {
    const focus = get().attentionFocus;
    if (!focus || focus.conversationId !== conversationId) return;
    set({ attentionFocus: null });
  },

  setSearchNavigation: (target) => set({ searchNavigation: target }),

  clearSearchNavigation: (conversationId) => {
    const target = get().searchNavigation;
    if (!target || target.conversationId !== conversationId) return;
    set({ searchNavigation: null });
  },

  close: () =>
    set({
      open: false,
      // Keep conversationId so re-opening returns to the same place during
      // the session; drop the deep-link focus so it only fires once.
      focusPath: null,
    }),

  setViewed: (conversationId, path, signature, viewedFlag) => {
    set((s) => {
      const forConv = { ...(s.viewed[conversationId] ?? {}) };
      if (viewedFlag) {
        if (forConv[path] === signature) return s;
        forConv[path] = signature;
      } else {
        if (!(path in forConv)) return s;
        delete forConv[path];
      }
      const viewed = { ...s.viewed };
      if (Object.keys(forConv).length === 0) delete viewed[conversationId];
      else viewed[conversationId] = forConv;
      saveToStorage(VIEWED_STORAGE_KEY, viewed);
      return { viewed };
    });
  },

  isViewed: (conversationId, path, signature) =>
    get().viewed[conversationId]?.[path] === signature,

  clearConversation: (conversationId) => {
    set((s) => {
      const next: Partial<ReviewStore> = {};
      if (s.conversationId === conversationId) {
        next.open = false;
        next.conversationId = null;
        next.focusPath = null;
      }
      if (conversationId in s.viewed) {
        const viewed = { ...s.viewed };
        delete viewed[conversationId];
        saveToStorage(VIEWED_STORAGE_KEY, viewed);
        next.viewed = viewed;
      }
      return Object.keys(next).length > 0 ? next : s;
    });
  },
}));
