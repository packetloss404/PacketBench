import { readAgentDraftAsset, type ImageAttachment } from "@/lib/tauri";
import type { StagedAttachment } from "@/stores/agentDraftStore";

/**
 * Materialize wire `ImageAttachment`s from staged chips. In-memory base64
 * (current session) is used as-is; a hydrated durable ref whose bytes were not
 * in memory is read back from the backend draft-asset store. Unreadable refs
 * are skipped rather than silently substituting a corrupt payload.
 */
export function stagedAttachmentsReadySync(staged: StagedAttachment[]): ImageAttachment[] | null {
  if (staged.every((item) => !!item.attachment.data_base64)) {
    return staged.map((item) => item.attachment);
  }
  return null;
}

export async function stagedToImageAttachments(
  staged: StagedAttachment[],
): Promise<ImageAttachment[]> {
  const out: ImageAttachment[] = [];
  for (const item of staged) {
    if (item.attachment.data_base64) {
      out.push(item.attachment);
      continue;
    }
    if (item.ref) {
      try {
        const read = await readAgentDraftAsset(item.ref.attachmentId);
        out.push({ media_type: read.mediaType, data_base64: read.dataBase64 });
      } catch {
        // Missing/corrupt ref - leave it out instead of forging bytes.
      }
    }
  }
  return out;
}
