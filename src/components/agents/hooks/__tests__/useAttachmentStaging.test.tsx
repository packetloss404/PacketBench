import { act, render, screen } from "@testing-library/react";
import { useEffect } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useAgentDraftStore, MAX_DRAFT_BYTES } from "@/stores/agentDraftStore";
import { useAttachmentStaging, type UseAttachmentStagingResult } from "../useAttachmentStaging";

vi.mock("@/lib/tauri", () => ({
  stageAgentDraftAsset: vi.fn().mockResolvedValue({
    attachmentId: "asset-1",
    name: "shot.png",
    mimeType: "image/png",
    byteLength: 11,
    sha256: "abc",
  }),
  readAgentDraftAsset: vi.fn(),
  releaseAgentDraftAsset: vi.fn().mockResolvedValue(undefined),
}));

let latest: UseAttachmentStagingResult | null = null;

function Harness() {
  const staging = useAttachmentStaging("conv-1");
  useEffect(() => {
    latest = staging;
  }, [staging]);
  return <button type="button">harness</button>;
}

describe("useAttachmentStaging — durable staging (F2B)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    useAgentDraftStore.setState({
      drafts: {},
      stagedAttachments: {},
      attachmentRejections: {},
      stagingGenerations: {},
    });
    latest = null;
  });

  it("stages bytes to the backend and records a durable ref on the chip", async () => {
    render(<Harness />);
    const tauri = await import("@/lib/tauri");

    await act(async () => {
      const file = new File(["image-bytes"], "shot.png", { type: "image/png" });
      await latest!.addFiles([file]);
    });

    expect(tauri.stageAgentDraftAsset).toHaveBeenCalledWith(
      expect.objectContaining({ name: "shot.png", mimeType: "image/png" }),
    );
    const staged = useAgentDraftStore.getState().stagedAttachments["conv-1"];
    expect(staged).toHaveLength(1);
    expect(staged[0].ref).toMatchObject({ attachmentId: "asset-1", state: "ready" });
    // The session preview is kept, and the base64 stays out of the envelope.
    expect(staged[0].previewUrl).toContain("blob:");
    expect(JSON.stringify(localStorage.getItem("packetbench:agent-drafts-v2"))).not.toContain(
      "data:image",
    );
  });

  it("rejects an image that would exceed the per-draft cap", async () => {
    useAgentDraftStore.setState({
      stagedAttachments: {
        "conv-1": [
          {
            id: "big",
            name: "big.png",
            sizeBytes: MAX_DRAFT_BYTES - 1,
            attachment: { media_type: "image/png", data_base64: "x" },
            previewUrl: "blob:big",
          },
        ],
      },
    });
    render(<Harness />);

    await act(async () => {
      await latest!.addFiles([new File(["ab"], "extra.png", { type: "image/png" })]);
    });

    const rejections = useAgentDraftStore.getState().attachmentRejections["conv-1"];
    expect(rejections?.[0]?.message).toContain("20 MiB");
    expect(useAgentDraftStore.getState().stagedAttachments["conv-1"]).toHaveLength(1);
  });

  it("falls back to session-only staging when the backend is unavailable", async () => {
    const tauri = await import("@/lib/tauri");
    vi.mocked(tauri.stageAgentDraftAsset).mockRejectedValueOnce(new Error("offline"));
    render(<Harness />);

    await act(async () => {
      const file = new File(["image-bytes"], "fallback.png", { type: "image/png" });
      await latest!.addFiles([file]);
    });

    const staged = useAgentDraftStore.getState().stagedAttachments["conv-1"];
    expect(staged).toHaveLength(1);
    expect(staged[0].ref).toBeUndefined();
    expect(screen.getByRole("button", { name: "harness" })).toBeInTheDocument();
  });
});
