import { readAgentDraftAsset, type ImageAttachment } from "@/lib/tauri";
import type { StagedAttachment } from "@/stores/agentDraftStore";

/**
 * The result of materializing staged chips for a send. `unreadable` names the
 * chips whose durable bytes could not be read: the caller MUST NOT send while
 * it is non-empty, or the user's staged image would be silently dropped.
 */
export interface MaterializedAttachments {
  attachments: ImageAttachment[];
  unreadable: { id: string; name: string }[];
}

/**
 * Materialize wire `ImageAttachment`s from staged chips. In-memory base64
 * (current session) is used as-is; a hydrated durable ref whose bytes were not
 * in memory is read back from the backend draft-asset store. An unreadable ref
 * is reported in `unreadable` rather than skipped — sending fewer images than
 * the user staged is exactly the silent-drop this guards against.
 */
export function stagedAttachmentsReadySync(staged: StagedAttachment[]): ImageAttachment[] | null {
  if (staged.every((item) => !!item.attachment.data_base64)) {
    return staged.map((item) => item.attachment);
  }
  return null;
}

export async function stagedToImageAttachments(
  staged: StagedAttachment[],
): Promise<MaterializedAttachments> {
  const attachments: ImageAttachment[] = [];
  const unreadable: { id: string; name: string }[] = [];
  for (const item of staged) {
    if (item.attachment.data_base64) {
      attachments.push(item.attachment);
      continue;
    }
    if (!item.ref) {
      // No in-memory bytes and no durable ref: nothing to send.
      unreadable.push({ id: item.id, name: item.name });
      continue;
    }
    try {
      const read = await readAgentDraftAsset(item.ref.attachmentId);
      attachments.push({ media_type: read.mediaType, data_base64: read.dataBase64 });
    } catch {
      // Missing/corrupt ref — report it so the caller blocks instead of
      // sending a message that quietly holds the image back.
      unreadable.push({ id: item.id, name: item.name });
    }
  }
  return { attachments, unreadable };
}
