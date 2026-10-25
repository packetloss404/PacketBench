import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  gcOrphanDraftAssets,
  LAUNCH_DRAFT_KEY,
  MAX_DRAFT_BYTES,
  useAgentDraftStore,
  type StagedAttachment,
} from "../agentDraftStore";

vi.mock("@/lib/tauri", () => ({
  readAgentDraftAsset: vi.fn().mockResolvedValue({
    mediaType: "image/png",
    dataBase64: "eA==",
  }),
  releaseAgentDraftAsset: vi.fn().mockResolvedValue(undefined),
  gcAgentDraftAssets: vi.fn().mockResolvedValue(0),
}));

const STORAGE_KEY = "packetbench:agent-drafts";
const V2_STORAGE_KEY = "packetbench:agent-drafts-v2";

const store = () => useAgentDraftStore.getState();

function stagedAttachment(id: string): StagedAttachment {
  return {
    id,
    name: `${id}.png`,
    sizeBytes: 12,
    attachment: { media_type: "image/png", data_base64: id },
    previewUrl: `blob:${id}`,
  };
}

function stagedWithRef(id: string): StagedAttachment {
  return {
    ...stagedAttachment(id),
    ref: {
      attachmentId: `asset-${id}`,
      name: `${id}.png`,
      mimeType: "image/png",
      byteLength: 12,
      sha256: "abc",
      state: "ready" as const,
    },
  };
}

describe("agentDraftStore", () => {
  beforeEach(() => {
    localStorage.clear();
    useAgentDraftStore.setState({
      drafts: {},
      stagedAttachments: {},
      attachmentRejections: {},
      stagingGenerations: {},
    });
  });

  it("keeps drafts per conversation — no bleed across ids", () => {
    store().setDraft("conv_a", "half-typed message for A");
    store().setDraft("conv_b", "different draft for B");

    expect(store().drafts.conv_a).toBe("half-typed message for A");
    expect(store().drafts.conv_b).toBe("different draft for B");

    // Updating one conversation's draft never touches the other.
    store().setDraft("conv_a", "edited A");
    expect(store().drafts.conv_a).toBe("edited A");
    expect(store().drafts.conv_b).toBe("different draft for B");
  });

  it("keeps the launch composer's draft isolated from conversation drafts", () => {
    store().setDraft(LAUNCH_DRAFT_KEY, "launch box text");
    store().setDraft("conv_a", "chat text");

    expect(store().drafts[LAUNCH_DRAFT_KEY]).toBe("launch box text");
    expect(store().drafts.conv_a).toBe("chat text");

    // Clearing the launch slot never touches conversation drafts, and
    // vice versa — the old global agentInputText bleed is impossible here.
    store().clearDraft(LAUNCH_DRAFT_KEY);
    expect(store().drafts[LAUNCH_DRAFT_KEY]).toBeUndefined();
    expect(store().drafts.conv_a).toBe("chat text");
  });

  it("returns no draft for a conversation that never typed", () => {
    store().setDraft("conv_a", "text");
    expect(store().drafts.conv_other).toBeUndefined();
  });

  it("removes the entry when the draft empties (send clears it)", () => {
    store().setDraft("conv_a", "about to send");
    store().setDraft("conv_a", "");
    expect("conv_a" in store().drafts).toBe(false);
  });

  it("clearDraft drops the entry and its persisted copy", () => {
    store().setDraft("conv_a", "doomed");
    store().clearDraft("conv_a");
    expect("conv_a" in store().drafts).toBe(false);
    const persisted = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}");
    expect("conv_a" in persisted).toBe(false);
  });

  it("persists drafts to localStorage keyed by conversation id", () => {
    store().setDraft("conv_a", "survives a restart");
    const persisted = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}");
    expect(persisted.conv_a).toBe("survives a restart");
  });

  it("keeps in-memory attachments scoped per draft key", () => {
    expect(store().appendStagedAttachment("conv_a", 0, stagedAttachment("a1"))).toBe(true);
    expect(store().appendStagedAttachment("conv_b", 0, stagedAttachment("b1"))).toBe(true);

    expect(store().stagedAttachments.conv_a.map((a) => a.id)).toEqual(["a1"]);
    expect(store().stagedAttachments.conv_b.map((a) => a.id)).toEqual(["b1"]);

    // Selecting B and back to A must not throw A's images away.
    expect(store().stagedAttachments.conv_a).toHaveLength(1);
  });

  it("rejects late staging completions after the draft scope is cleared", () => {
    const revoke = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    store().clearStagedAttachments("conv_a");
    const generation = store().stagingGenerations.conv_a;

    expect(store().appendStagedAttachment("conv_a", generation - 1, stagedAttachment("late"))).toBe(
      false,
    );
    expect(store().stagedAttachments.conv_a).toBeUndefined();
    expect(revoke).toHaveBeenCalledWith("blob:late");
    revoke.mockRestore();
  });

  it("dropping a draft clears its staged images and invalidates in-flight decodes", () => {
    const revoke = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    store().setDraft("conv_a", "draft text");
    store().appendStagedAttachment("conv_a", 0, stagedAttachment("a1"));
    store().addAttachmentRejection("conv_a", 0, {
      id: "rej1",
      name: "bad.txt",
      message: "bad.txt was not added: only image files are supported",
    });

    store().clearDraft("conv_a");

    expect(store().drafts.conv_a).toBeUndefined();
    expect(store().stagedAttachments.conv_a).toBeUndefined();
    expect(store().attachmentRejections.conv_a).toBeUndefined();
    expect(store().stagingGenerations.conv_a).toBe(1);
    expect(revoke).toHaveBeenCalledWith("blob:a1");
    revoke.mockRestore();
  });

  it("removes one attachment and revokes only its preview URL", () => {
    const revoke = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    store().appendStagedAttachment("conv_a", 0, stagedAttachment("a1"));
    store().appendStagedAttachment("conv_a", 0, stagedAttachment("a2"));

    store().removeStagedAttachment("conv_a", "a1");

    expect(store().stagedAttachments.conv_a.map((a) => a.id)).toEqual(["a2"]);
    expect(revoke).toHaveBeenCalledWith("blob:a1");
    expect(revoke).not.toHaveBeenCalledWith("blob:a2");
    revoke.mockRestore();
  });

  it("never persists attachment bytes or preview URLs", () => {
    store().appendStagedAttachment("conv_a", 0, stagedAttachment("a1"));
    store().setDraft("conv_a", "text only");

    const persisted = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}");
    expect(persisted).toEqual({ conv_a: "text only" });
  });

  it("persists only metadata refs in the v2 envelope — never bytes or blob URLs", () => {
    store().appendStagedAttachment("conv_a", 0, stagedWithRef("a1"));
    store().setDraft("conv_a", "text only");

    const envelope = JSON.parse(localStorage.getItem(V2_STORAGE_KEY) ?? "{}");
    expect(envelope.version).toBe(2);
    expect(envelope.drafts).toEqual({ conv_a: "text only" });
    expect(envelope.attachments.conv_a).toEqual([
      {
        attachmentId: "asset-a1",
        name: "a1.png",
        mimeType: "image/png",
        byteLength: 12,
        sha256: "abc",
        state: "ready",
      },
    ]);
    // No base64 or object URL ever touches the envelope.
    expect(JSON.stringify(envelope)).not.toContain("blob:");
    expect(JSON.stringify(envelope)).not.toContain("data:image");
  });

  it("hydrates durable refs back as staged chips without bytes", async () => {
    localStorage.setItem(
      V2_STORAGE_KEY,
      JSON.stringify({
        version: 2,
        drafts: { conv_a: "persisted text" },
        attachments: {
          conv_a: [
            {
              attachmentId: "asset-h1",
              name: "h1.png",
              mimeType: "image/png",
              byteLength: 12,
              sha256: "def",
              state: "ready",
            },
          ],
        },
        updatedAt: 1,
      }),
    );
    vi.resetModules();
    const { useAgentDraftStore: fresh } = await import("../agentDraftStore");
    const freshStore = fresh.getState();
    expect(freshStore.drafts.conv_a).toBe("persisted text");
    expect(freshStore.stagedAttachments.conv_a).toHaveLength(1);
    expect(freshStore.stagedAttachments.conv_a[0]).toMatchObject({
      name: "h1.png",
      previewUrl: "",
      ref: { attachmentId: "asset-h1", state: "ready" },
    });
    // Hydrated refs carry no in-memory base64.
    expect(freshStore.stagedAttachments.conv_a[0].attachment.data_base64).toBe("");
  });

  it("migrates the v1 text map when no v2 envelope exists", async () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ conv_a: "legacy text" }));
    vi.resetModules();
    const { useAgentDraftStore: fresh } = await import("../agentDraftStore");
    expect(fresh.getState().drafts.conv_a).toBe("legacy text");
    expect(fresh.getState().stagedAttachments).toEqual({});
  });

  it("loads a durable ref's preview on demand", async () => {
    store().appendStagedAttachment("conv_a", 0, { ...stagedWithRef("a1"), previewUrl: "" });
    const tauri = await import("@/lib/tauri");
    vi.mocked(tauri.readAgentDraftAsset).mockResolvedValue({
      mediaType: "image/png",
      dataBase64: "aGVsbG8=",
    });
    Object.defineProperty(URL, "createObjectURL", {
      configurable: true,
      value: vi.fn(() => "blob:loaded"),
    });

    await store().loadStagedPreview("conv_a", "a1");

    expect(tauri.readAgentDraftAsset).toHaveBeenCalledWith("asset-a1");
    expect(store().stagedAttachments.conv_a[0].previewUrl).toBe("blob:loaded");
  });

  it("marks a ref missing when its bytes cannot be read", async () => {
    store().appendStagedAttachment("conv_a", 0, { ...stagedWithRef("a1"), previewUrl: "" });
    const tauri = await import("@/lib/tauri");
    vi.mocked(tauri.readAgentDraftAsset).mockRejectedValueOnce(new Error("gone"));

    await store().loadStagedPreview("conv_a", "a1");

    expect(store().stagedAttachments.conv_a[0].ref?.state).toBe("missing");
  });

  it("ignores non-string / empty persisted entries on load", async () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ good: "keep me", bad: 42, empty: "" }));
    // Re-import a fresh module instance so the store re-runs load().
    vi.resetModules();
    const { useAgentDraftStore: fresh } = await import("../agentDraftStore");
    expect(fresh.getState().drafts).toEqual({ good: "keep me" });
  });

  it("enforces the aggregate per-draft cap", () => {
    store().appendStagedAttachment("conv_a", 0, {
      ...stagedAttachment("big"),
      sizeBytes: MAX_DRAFT_BYTES - 1,
    });
    const added = store().appendStagedAttachment("conv_a", 0, stagedAttachment("over"));
    expect(added).toBe(false);
    expect(store().stagedAttachments.conv_a.map((a) => a.id)).toEqual(["big"]);
  });

  it("never overwrites a newer envelope schema", async () => {
    localStorage.setItem(
      V2_STORAGE_KEY,
      JSON.stringify({ version: 3, drafts: {}, attachments: {}, updatedAt: 1 }),
    );
    vi.resetModules();
    const { useAgentDraftStore: fresh } = await import("../agentDraftStore");

    fresh.getState().setDraft("conv_a", "text");

    // The newer envelope is left byte-identical; only the v1 text map is written.
    const envelope = JSON.parse(localStorage.getItem(V2_STORAGE_KEY) ?? "{}");
    expect(envelope.version).toBe(3);
    expect(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}")).toEqual({ conv_a: "text" });
  });

  it("reclaims assets while keeping every ref named by the envelope", async () => {
    localStorage.setItem(
      V2_STORAGE_KEY,
      JSON.stringify({
        version: 2,
        drafts: { conv_a: "x" },
        attachments: {
          conv_a: [
            {
              attachmentId: "asset-keep",
              name: "k.png",
              mimeType: "image/png",
              byteLength: 1,
              sha256: "a",
              state: "ready",
            },
          ],
        },
        updatedAt: 1,
      }),
    );
    const tauri = await import("@/lib/tauri");

    await gcOrphanDraftAssets();

    expect(tauri.gcAgentDraftAssets).toHaveBeenCalledWith(["asset-keep"]);
  });

  it("skips GC entirely when a newer envelope schema owns the assets", async () => {
    localStorage.setItem(
      V2_STORAGE_KEY,
      JSON.stringify({ version: 3, drafts: {}, attachments: {}, updatedAt: 1 }),
    );
    const tauri = await import("@/lib/tauri");
    vi.mocked(tauri.gcAgentDraftAssets).mockClear();

    const removed = await gcOrphanDraftAssets();

    // Parsing a v3 envelope with the v2 reader yields an empty keep set; running
    // GC would delete every image that envelope still references. Skip instead.
    expect(removed).toBe(0);
    expect(tauri.gcAgentDraftAssets).not.toHaveBeenCalled();
  });
});
