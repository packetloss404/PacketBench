/**
 * Per-conversation composer drafts, keyed by conversation id.
 *
 * Replaces the old Ctrl+S one-slot draft stash: the chat composer writes
 * through here on every keystroke, so switching conversations never bleeds
 * a half-typed draft into another chat and never loses it. Persisted to
 * localStorage so drafts also survive an app restart. Entries are removed
 * when the draft empties (send / manual clear) and when the conversation
 * is deleted, so the persisted map stays bounded.
 *
 * Kept deliberately separate from `agentTaskStore` so per-keystroke writes
 * don't churn the store that owns the conversations themselves.
 */
import { create } from "zustand";
import { loadFromStorage, saveToStorage } from "@/lib/storage";
import type { ImageAttachment } from "@/lib/tauri";

import { storageKey } from "@/lib/brand";
const STORAGE_KEY = storageKey("agent-drafts");

export interface StagedAttachment {
  id: string;
  name: string;
  sizeBytes: number;
  attachment: ImageAttachment;
  previewUrl: string;
}

export interface AttachmentRejection {
  id: string;
  name: string;
  message: string;
}

/** Revoked when a chip is removed or its draft is cleared. */
function revokePreviewUrl(url: string | undefined): void {
  if (!url) return;
  if (typeof URL !== "undefined" && typeof URL.revokeObjectURL === "function") {
    URL.revokeObjectURL(url);
  }
}

/**
 * Draft key for the launch composer (the "new agent" box). It has no
 * conversation id, but its draft lives here alongside the per-conversation
 * ones so no composer text is ever held in a global store field — this
 * replaced `agentTaskStore.agentInputText`. The `__` prefix can never
 * collide with a generated conversation id (`conv_*`).
 */
export const LAUNCH_DRAFT_KEY = "__launch__";

interface AgentDraftStore {
  /** conversationId -> in-progress composer text */
  drafts: Record<string, string>;
  /** In-memory only: bytes are Kept in this session and never persisted. */
  stagedAttachments: Record<string, StagedAttachment[]>;
  attachmentRejections: Record<string, AttachmentRejection[]>;
  /** Invalidates late decodes after a draft is cleared or sent. */
  stagingGenerations: Record<string, number>;
  setDraft: (conversationId: string, text: string) => void;
  clearDraft: (conversationId: string) => void;
  appendStagedAttachment: (
    conversationId: string,
    expectedGeneration: number,
    attachment: StagedAttachment,
  ) => boolean;
  addAttachmentRejection: (
    conversationId: string,
    expectedGeneration: number,
    rejection: AttachmentRejection,
  ) => boolean;
  removeStagedAttachment: (conversationId: string, attachmentId: string) => void;
  clearStagedAttachments: (conversationId: string) => void;
  dismissAttachmentRejection: (conversationId: string, rejectionId: string) => void;
}

function load(): Record<string, string> {
  const raw = loadFromStorage<Record<string, unknown>>(STORAGE_KEY, {});
  // Defensive: only accept non-empty string entries so a stale / malformed
  // payload can't leak into the composer.
  const drafts: Record<string, string> = {};
  for (const [id, text] of Object.entries(raw ?? {})) {
    if (typeof text === "string" && text.length > 0) drafts[id] = text;
  }
  return drafts;
}

export const useAgentDraftStore = create<AgentDraftStore>((set, get) => ({
  drafts: load(),
  stagedAttachments: {},
  attachmentRejections: {},
  stagingGenerations: {},

  setDraft: (conversationId, text) => {
    if (!conversationId) return;
    set((s) => {
      const drafts = { ...s.drafts };
      if (text.length === 0) delete drafts[conversationId];
      else drafts[conversationId] = text;
      saveToStorage(STORAGE_KEY, drafts);
      return { drafts };
    });
  },

  clearDraft: (conversationId) => {
    const staged = get().stagedAttachments[conversationId] ?? [];
    for (const attachment of staged) revokePreviewUrl(attachment.previewUrl);
    set((s) => {
      const drafts = { ...s.drafts };
      delete drafts[conversationId];
      const stagedAttachments = { ...s.stagedAttachments };
      delete stagedAttachments[conversationId];
      const attachmentRejections = { ...s.attachmentRejections };
      delete attachmentRejections[conversationId];
      const stagingGenerations = {
        ...s.stagingGenerations,
        [conversationId]: (s.stagingGenerations[conversationId] ?? 0) + 1,
      };
      saveToStorage(STORAGE_KEY, drafts);
      return { drafts, stagedAttachments, attachmentRejections, stagingGenerations };
    });
  },

  appendStagedAttachment: (conversationId, expectedGeneration, attachment) => {
    if ((get().stagingGenerations[conversationId] ?? 0) !== expectedGeneration) {
      revokePreviewUrl(attachment.previewUrl);
      return false;
    }
    set((s) => ({
      stagedAttachments: {
        ...s.stagedAttachments,
        [conversationId]: [...(s.stagedAttachments[conversationId] ?? []), attachment],
      },
    }));
    return true;
  },

  addAttachmentRejection: (conversationId, expectedGeneration, rejection) => {
    if ((get().stagingGenerations[conversationId] ?? 0) !== expectedGeneration) {
      return false;
    }
    set((s) => ({
      attachmentRejections: {
        ...s.attachmentRejections,
        [conversationId]: [...(s.attachmentRejections[conversationId] ?? []), rejection],
      },
    }));
    return true;
  },

  removeStagedAttachment: (conversationId, attachmentId) => {
    const staged = get().stagedAttachments[conversationId] ?? [];
    const removed = staged.find((attachment) => attachment.id === attachmentId);
    revokePreviewUrl(removed?.previewUrl);
    set((s) => {
      const remaining = (s.stagedAttachments[conversationId] ?? []).filter(
        (attachment) => attachment.id !== attachmentId,
      );
      const stagedAttachments = { ...s.stagedAttachments };
      if (remaining.length === 0) delete stagedAttachments[conversationId];
      else stagedAttachments[conversationId] = remaining;
      return { stagedAttachments };
    });
  },

  clearStagedAttachments: (conversationId) => {
    for (const attachment of get().stagedAttachments[conversationId] ?? []) {
      revokePreviewUrl(attachment.previewUrl);
    }
    set((s) => {
      const stagedAttachments = { ...s.stagedAttachments };
      delete stagedAttachments[conversationId];
      const attachmentRejections = { ...s.attachmentRejections };
      delete attachmentRejections[conversationId];
      const stagingGenerations = {
        ...s.stagingGenerations,
        [conversationId]: (s.stagingGenerations[conversationId] ?? 0) + 1,
      };
      return { stagedAttachments, attachmentRejections, stagingGenerations };
    });
  },

  dismissAttachmentRejection: (conversationId, rejectionId) => {
    set((s) => {
      const remaining = (s.attachmentRejections[conversationId] ?? []).filter(
        (rejection) => rejection.id !== rejectionId,
      );
      const attachmentRejections = { ...s.attachmentRejections };
      if (remaining.length === 0) delete attachmentRejections[conversationId];
      else attachmentRejections[conversationId] = remaining;
      return { attachmentRejections };
    });
  },
}));
