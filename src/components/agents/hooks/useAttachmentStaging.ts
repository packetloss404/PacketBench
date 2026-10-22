import { useCallback } from "react";
import {
  MAX_DRAFT_BYTES,
  useAgentDraftStore,
  type AttachmentRejection,
  type StagedAttachment,
} from "@/stores/agentDraftStore";
import { fileToImageAttachment, MAX_IMAGE_BYTES } from "../composer/utils";

export type { StagedAttachment };

export interface UseAttachmentStagingResult {
  staged: StagedAttachment[];
  rejections: AttachmentRejection[];
  addFiles: (files: File[]) => Promise<void>;
  removeStaged: (id: string) => void;
  dismissRejection: (id: string) => void;
  clear: () => void;
}

const EMPTY_STAGED: StagedAttachment[] = [];
const EMPTY_REJECTIONS: AttachmentRejection[] = [];

function rejectionFor(file: File, reason: string): AttachmentRejection {
  return {
    id: `rej_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    name: file.name || "pasted-image",
    message: `${file.name || "pasted-image"} was not added: ${reason}`,
  };
}

/** Draft-bound image staging. The complete text/image draft is owned by
 * `agentDraftStore` per conversation or launch key, so unmounting or switching
 * A -> B -> A neither loses A's images nor leaks them into B. Bytes are staged
 * to the backend draft-asset store (F2B) so refs survive restart; only the
 * transient preview object URL is session-scoped. */
export function useAttachmentStaging(draftKey: string): UseAttachmentStagingResult {
  const staged = useAgentDraftStore((state) => state.stagedAttachments[draftKey] ?? EMPTY_STAGED);
  const rejections = useAgentDraftStore(
    (state) => state.attachmentRejections[draftKey] ?? EMPTY_REJECTIONS,
  );

  const addFiles = useCallback(
    async (files: File[]) => {
      const generation = useAgentDraftStore.getState().stagingGenerations[draftKey] ?? 0;
      const accepted: StagedAttachment[] = [];
      const rejected: AttachmentRejection[] = [];
      let projectedBytes = (useAgentDraftStore.getState().stagedAttachments[draftKey] ?? []).reduce(
        (sum, item) => sum + item.sizeBytes,
        0,
      );

      for (const file of files) {
        if (!file.type.startsWith("image/")) {
          rejected.push(rejectionFor(file, "only image files are supported"));
          continue;
        }
        if (file.size > MAX_IMAGE_BYTES) {
          rejected.push(rejectionFor(file, "images must be 5 MiB or smaller"));
          continue;
        }
        if (projectedBytes + file.size > MAX_DRAFT_BYTES) {
          rejected.push(rejectionFor(file, "the draft is limited to 20 MiB of images"));
          continue;
        }
        projectedBytes += file.size;
        try {
          const attachment = await fileToImageAttachment(file);
          let ref: StagedAttachment["ref"];
          try {
            const { stageAgentDraftAsset } = await import("@/lib/tauri");
            const stagedAsset = await stageAgentDraftAsset({
              name: file.name || "pasted-image",
              mimeType: file.type,
              dataBase64: attachment.data_base64,
            });
            ref = {
              attachmentId: stagedAsset.attachmentId,
              name: stagedAsset.name,
              mimeType: stagedAsset.mimeType,
              byteLength: stagedAsset.byteLength,
              sha256: stagedAsset.sha256,
              state: "ready",
            };
          } catch {
            // Offline/unavailable backend: fall back to session-only staging.
          }
          accepted.push({
            id: `att_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
            name: file.name || "pasted-image",
            sizeBytes: file.size,
            attachment,
            previewUrl: URL.createObjectURL(file),
            ref,
          });
        } catch {
          rejected.push(rejectionFor(file, "the image could not be read"));
        }
      }

      // Bind late decodes to the draft that requested them. Clearing or
      // sending that draft bumps the generation and discards the result.
      const state = useAgentDraftStore.getState();
      const stillCurrent = (state.stagingGenerations[draftKey] ?? 0) === generation;
      if (!stillCurrent) {
        for (const item of accepted) URL.revokeObjectURL(item.previewUrl);
        return;
      }
      for (const item of accepted) {
        state.appendStagedAttachment(draftKey, generation, item);
      }
      for (const rejection of rejected) {
        state.addAttachmentRejection(draftKey, generation, rejection);
      }
    },
    [draftKey],
  );

  const removeStaged = useCallback(
    (id: string) => {
      useAgentDraftStore.getState().removeStagedAttachment(draftKey, id);
    },
    [draftKey],
  );

  const dismissRejection = useCallback(
    (id: string) => {
      useAgentDraftStore.getState().dismissAttachmentRejection(draftKey, id);
    },
    [draftKey],
  );

  const clear = useCallback(() => {
    useAgentDraftStore.getState().clearStagedAttachments(draftKey);
  }, [draftKey]);

  return { staged, rejections, addFiles, removeStaged, dismissRejection, clear };
}
