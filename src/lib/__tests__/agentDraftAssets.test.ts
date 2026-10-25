import { beforeEach, describe, expect, it, vi } from "vitest";
import { stagedToImageAttachments } from "@/lib/agentDraftAssets";
import type { StagedAttachment } from "@/stores/agentDraftStore";

const readMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/tauri", () => ({
  readAgentDraftAsset: readMock,
}));

function stagedWithRef(id: string, state: "ready" | "missing" = "ready"): StagedAttachment {
  return {
    id,
    name: `${id}.png`,
    sizeBytes: 12,
    attachment: { media_type: "image/png", data_base64: "" },
    previewUrl: "",
    ref: {
      attachmentId: `asset-${id}`,
      name: `${id}.png`,
      mimeType: "image/png",
      byteLength: 12,
      sha256: "a",
      state,
    },
  };
}

describe("stagedToImageAttachments (F2B)", () => {
  beforeEach(() => {
    readMock.mockReset();
  });

  it("reads a durable ref whose bytes are not in memory", async () => {
    readMock.mockResolvedValue({ mediaType: "image/png", dataBase64: "aGVsbG8=" });
    const { attachments, unreadable } = await stagedToImageAttachments([stagedWithRef("a1")]);
    expect(attachments).toEqual([{ media_type: "image/png", data_base64: "aGVsbG8=" }]);
    expect(unreadable).toEqual([]);
    expect(readMock).toHaveBeenCalledWith("asset-a1");
  });

  it("reports an unreadable ref instead of silently dropping the image", async () => {
    readMock.mockRejectedValue(new Error("bytes are missing"));
    const { attachments, unreadable } = await stagedToImageAttachments([stagedWithRef("a1")]);
    expect(attachments).toEqual([]);
    expect(unreadable).toEqual([{ id: "a1", name: "a1.png" }]);
  });

  it("uses in-memory bytes without reading the backend", async () => {
    const item = stagedWithRef("a1");
    item.attachment = { media_type: "image/png", data_base64: "aW4=" };
    const { attachments, unreadable } = await stagedToImageAttachments([item]);
    expect(attachments).toEqual([{ media_type: "image/png", data_base64: "aW4=" }]);
    expect(unreadable).toEqual([]);
    expect(readMock).not.toHaveBeenCalled();
  });

  it("reports a chip that has neither bytes nor a durable ref", async () => {
    const item = stagedWithRef("a1");
    delete item.ref;
    const { attachments, unreadable } = await stagedToImageAttachments([item]);
    expect(attachments).toEqual([]);
    expect(unreadable).toEqual([{ id: "a1", name: "a1.png" }]);
  });
});
