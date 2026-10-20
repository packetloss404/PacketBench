import { useCallback } from "react";
import {
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
 * A -> B -> A neither loses A's images nor leaks them into B. Bytes are
 * in-memory only for this slice; the UI labels them "Kept in this session". */
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

      for (const file of files) {
        if (!file.type.startsWith("image/")) {
          rejected.push(rejectionFor(file, "only image files are supported"));
          continue;
        }
        if (file.size > MAX_IMAGE_BYTES) {
          rejected.push(rejectionFor(file, "images must be 5 MiB or smaller"));
          continue;
        }
        try {
          const attachment = await fileToImageAttachment(file);
          accepted.push({
            id: `att_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
            name: file.name || "pasted-image",
            sizeBytes: file.size,
            attachment,
            previewUrl: URL.createObjectURL(file),
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
