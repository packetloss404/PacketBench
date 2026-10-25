/**
 * Per-conversation composer drafts, keyed by conversation id.
 *
 * Text is persisted (v1 `package:agent-drafts` map, kept for compatibility) and
 * a versioned v2 envelope (`package:agent-drafts-v2`) additionally persists
 * durable attachment REFS. The actual image bytes live in app-data via the
 * backend draft-asset service (`DraftAssets`); the envelope never stores base64
 * or blob URLs. Refs hydrate back as session-only staged chips whose previews
 * are lazily re-read from the backend, so a crash mid-draft no longer loses the
 * image — only the transient in-memory preview is re-created on demand.
 *
 * Kept deliberately separate from `agentTaskStore` so per-keystroke writes
 * don't churn the store that owns the conversations themselves.
 */
import { create } from "zustand";
import { loadFromStorage, saveToStorage } from "@/lib/storage";
import type { ImageAttachment } from "@/lib/tauri";

import { storageKey } from "@/lib/brand";
const STORAGE_KEY = storageKey("agent-drafts");
const V2_STORAGE_KEY = storageKey("agent-drafts-v2");

export interface DraftAttachmentRef {
  attachmentId: string;
  name: string;
  mimeType: string;
  byteLength: number;
  sha256: string;
  state: "ready" | "missing";
}

export interface StagedAttachment {
  id: string;
  name: string;
  sizeBytes: number;
  attachment: ImageAttachment;
  /** Object URL for the current session's thumbnail. Empty for hydrated refs
   * whose preview has not been re-read yet; never the durable identity. */
  previewUrl: string;
  /** Durable backend ref when the bytes were staged to app-data (F2B). */
  ref?: DraftAttachmentRef;
}

export interface AttachmentRejection {
  id: string;
  name: string;
  message: string;
}

interface DraftsV2Envelope {
  version: 2;
  drafts: Record<string, string>;
  attachments: Record<string, DraftAttachmentRef[]>;
  updatedAt: number;
}

/** Revoked when a chip is removed or its draft is cleared. */
function revokePreviewUrl(url: string | undefined): void {
  if (!url) return;
  if (typeof URL !== "undefined" && typeof URL.revokeObjectURL === "function") {
    URL.revokeObjectURL(url);
  }
}

/** Best-effort release of a durable asset. Dynamic import keeps the store
 * loadable in environments without the Tauri bridge (and in node tests). */
async function releaseAsset(attachmentId: string | undefined): Promise<void> {
  if (!attachmentId) return;
  try {
    const { releaseAgentDraftAsset } = await import("@/lib/tauri");
    await releaseAgentDraftAsset(attachmentId);
  } catch {
    // Best-effort; the 24h gc pass still reclaims orphaned files.
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

/** Aggregate cap for one draft's staged images (implementation default). */
export const MAX_DRAFT_BYTES = 20 * 1024 * 1024;

interface AgentDraftStore {
  /** conversationId -> in-progress composer text */
  drafts: Record<string, string>;
  /** In-memory staged images (session previews); durable bytes are refs. */
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
  /** Mark a durable ref unreadable (bytes missing/corrupt) so its chip offers
   * reattach and the send path can refuse rather than drop it. */
  markAttachmentUnreadable: (conversationId: string, attachmentId: string) => void;
  clearStagedAttachments: (conversationId: string) => void;
  dismissAttachmentRejection: (conversationId: string, rejectionId: string) => void;
  /** Re-read a hydrated durable ref and materialize its session preview. */
  loadStagedPreview: (conversationId: string, attachmentId: string) => Promise<void>;
}

/** v1 text-only map (legacy fallback). */
function loadTextDrafts(): Record<string, string> {
  const raw = loadFromStorage<Record<string, unknown>>(STORAGE_KEY, {});
  const drafts: Record<string, string> = {};
  for (const [id, text] of Object.entries(raw ?? {})) {
    if (typeof text === "string" && text.length > 0) drafts[id] = text;
  }
  return drafts;
}

function hydrateV2(): {
  drafts: Record<string, string>;
  stagedAttachments: Record<string, StagedAttachment[]>;
  preserveExistingEnvelope: boolean;
} {
  const envelope = loadFromStorage<DraftsV2Envelope | null>(V2_STORAGE_KEY, null);
  // A newer schema written by a later build must never be downgraded by this
  // one: keep the key untouched and fall back to the legacy text map.
  if (envelope && typeof envelope.version === "number" && envelope.version > 2) {
    return { drafts: loadTextDrafts(), stagedAttachments: {}, preserveExistingEnvelope: true };
  }
  if (envelope && envelope.version === 2) {
    const drafts: Record<string, string> = {};
    for (const [id, text] of Object.entries(envelope.drafts ?? {})) {
      if (typeof text === "string" && text.length > 0) drafts[id] = text;
    }
    const stagedAttachments: Record<string, StagedAttachment[]> = {};
    for (const [key, refs] of Object.entries(envelope.attachments ?? {})) {
      if (!Array.isArray(refs)) continue;
      stagedAttachments[key] = refs
        .filter((r) => r && typeof r.attachmentId === "string")
        .map((r) => ({
          id: r.attachmentId,
          name: r.name,
          sizeBytes: r.byteLength,
          attachment: { media_type: r.mimeType, data_base64: "" },
          previewUrl: "",
          ref: { ...r, state: "ready" },
        }));
    }
    return { drafts, stagedAttachments, preserveExistingEnvelope: false };
  }
  return { drafts: loadTextDrafts(), stagedAttachments: {}, preserveExistingEnvelope: false };
}

const hydrated = hydrateV2();
/** Set when a newer envelope schema is on disk; `persist` then leaves it alone. */
const preserveExistingEnvelope = hydrated.preserveExistingEnvelope;

function persist(state: {
  drafts: Record<string, string>;
  stagedAttachments: Record<string, StagedAttachment[]>;
}): void {
  // The v1 text map is always safe to write (separate key).
  saveToStorage(STORAGE_KEY, state.drafts);
  if (preserveExistingEnvelope) return;
  const attachments: Record<string, DraftAttachmentRef[]> = {};
  for (const [key, arr] of Object.entries(state.stagedAttachments)) {
    const refs = arr
      .map((s) => s.ref)
      .filter((r): r is DraftAttachmentRef => !!r && r.attachmentId.length > 0);
    if (refs.length > 0) attachments[key] = refs;
  }
  const envelope: DraftsV2Envelope = {
    version: 2,
    drafts: state.drafts,
    attachments,
    updatedAt: Date.now(),
  };
  saveToStorage(V2_STORAGE_KEY, envelope);
}

/**
 * Startup reclamation for draft assets. Keeps every ref named in the persisted
 * v2 envelope and removes the rest (orphans from a crash between staging and
 * the envelope write). Best-effort; never throws.
 */
export async function gcOrphanDraftAssets(): Promise<number> {
  try {
    // Read the raw string rather than `loadFromStorage` so a CORRUPT envelope is
    // distinguishable from an ABSENT one — the helper swallows a parse error and
    // returns the fallback, which would make the keep set empty and delete every
    // image the (unreadable) envelope still references.
    const raw = typeof localStorage === "undefined" ? null : localStorage.getItem(V2_STORAGE_KEY);
    const keep: string[] = [];
    if (raw !== null) {
      let envelope: DraftsV2Envelope;
      try {
        envelope = JSON.parse(raw) as DraftsV2Envelope;
      } catch {
        // Unreadable envelope: ownership is unknown — never reclaim.
        return 0;
      }
      // F2: a newer/older envelope schema owns its assets under retention rules
      // this build does not know. Parsing it with the v2 reader yields an empty
      // keep set, so running GC would delete every image that envelope still
      // references. Never reclaim bytes we cannot attribute — skip the pass and
      // leave the orphan cleanup to the build that owns the schema.
      if (!envelope || typeof envelope.version !== "number" || envelope.version !== 2) {
        return 0;
      }
      for (const refs of Object.values(envelope.attachments ?? {})) {
        if (!Array.isArray(refs)) continue;
        for (const ref of refs) {
          if (ref?.attachmentId) keep.push(ref.attachmentId);
        }
      }
    }
    const { gcAgentDraftAssets } = await import("@/lib/tauri");
    return await gcAgentDraftAssets(keep);
  } catch {
    return 0;
  }
}

export const useAgentDraftStore = create<AgentDraftStore>((set, get) => ({
  drafts: hydrated.drafts,
  stagedAttachments: hydrated.stagedAttachments,
  attachmentRejections: {},
  stagingGenerations: {},

  setDraft: (conversationId, text) => {
    if (!conversationId) return;
    set((s) => {
      const drafts = { ...s.drafts };
      if (text.length === 0) delete drafts[conversationId];
      else drafts[conversationId] = text;
      persist({ drafts, stagedAttachments: s.stagedAttachments });
      return { drafts };
    });
  },

  clearDraft: (conversationId) => {
    for (const attachment of get().stagedAttachments[conversationId] ?? []) {
      revokePreviewUrl(attachment.previewUrl);
      void releaseAsset(attachment.ref?.attachmentId);
    }
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
      persist({ drafts, stagedAttachments });
      return { drafts, stagedAttachments, attachmentRejections, stagingGenerations };
    });
  },

  appendStagedAttachment: (conversationId, expectedGeneration, attachment) => {
    if ((get().stagingGenerations[conversationId] ?? 0) !== expectedGeneration) {
      revokePreviewUrl(attachment.previewUrl);
      void releaseAsset(attachment.ref?.attachmentId);
      return false;
    }
    const existing = get().stagedAttachments[conversationId] ?? [];
    const totalBytes = existing.reduce((sum, item) => sum + item.sizeBytes, 0);
    if (totalBytes + attachment.sizeBytes > MAX_DRAFT_BYTES) {
      revokePreviewUrl(attachment.previewUrl);
      void releaseAsset(attachment.ref?.attachmentId);
      return false;
    }
    set((s) => {
      const stagedAttachments = {
        ...s.stagedAttachments,
        [conversationId]: [...(s.stagedAttachments[conversationId] ?? []), attachment],
      };
      persist({ drafts: s.drafts, stagedAttachments });
      return { stagedAttachments };
    });
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
    void releaseAsset(removed?.ref?.attachmentId);
    set((s) => {
      const remaining = (s.stagedAttachments[conversationId] ?? []).filter(
        (attachment) => attachment.id !== attachmentId,
      );
      const stagedAttachments = { ...s.stagedAttachments };
      if (remaining.length === 0) delete stagedAttachments[conversationId];
      else stagedAttachments[conversationId] = remaining;
      persist({ drafts: s.drafts, stagedAttachments });
      return { stagedAttachments };
    });
  },

  markAttachmentUnreadable: (conversationId, attachmentId) => {
    set((s) => ({
      stagedAttachments: {
        ...s.stagedAttachments,
        [conversationId]: (s.stagedAttachments[conversationId] ?? []).map((a) =>
          a.id === attachmentId && a.ref ? { ...a, ref: { ...a.ref, state: "missing" } } : a,
        ),
      },
    }));
  },

  clearStagedAttachments: (conversationId) => {
    for (const attachment of get().stagedAttachments[conversationId] ?? []) {
      revokePreviewUrl(attachment.previewUrl);
      void releaseAsset(attachment.ref?.attachmentId);
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
      persist({ drafts: s.drafts, stagedAttachments });
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

  loadStagedPreview: async (conversationId, attachmentId) => {
    const item = (get().stagedAttachments[conversationId] ?? []).find((s) => s.id === attachmentId);
    if (!item?.ref || item.previewUrl || item.ref.state === "missing") return;
    try {
      const { readAgentDraftAsset } = await import("@/lib/tauri");
      const read = await readAgentDraftAsset(item.ref.attachmentId);
      const bytes = Uint8Array.from(atob(read.dataBase64), (c) => c.charCodeAt(0));
      const url = URL.createObjectURL(new Blob([bytes], { type: read.mediaType }));
      revokePreviewUrl(item.previewUrl);
      set((s) => ({
        stagedAttachments: {
          ...s.stagedAttachments,
          [conversationId]: (s.stagedAttachments[conversationId] ?? []).map((a) =>
            a.id === attachmentId ? { ...a, previewUrl: url } : a,
          ),
        },
      }));
    } catch {
      // Mark the ref missing so the chip can say "reattach" and sending can
      // refuse rather than silently dropping the image.
      set((s) => ({
        stagedAttachments: {
          ...s.stagedAttachments,
          [conversationId]: (s.stagedAttachments[conversationId] ?? []).map((a) =>
            a.id === attachmentId && a.ref ? { ...a, ref: { ...a.ref, state: "missing" } } : a,
          ),
        },
      }));
    }
  },
}));
