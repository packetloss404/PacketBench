import { describe, it, expect, beforeEach, vi } from "vitest";
import { LAUNCH_DRAFT_KEY, useAgentDraftStore, type StagedAttachment } from "../agentDraftStore";

const STORAGE_KEY = "packetbench:agent-drafts";

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

  it("ignores non-string / empty persisted entries on load", async () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ good: "keep me", bad: 42, empty: "" }));
    // Re-import a fresh module instance so the store re-runs load().
    vi.resetModules();
    const { useAgentDraftStore: fresh } = await import("../agentDraftStore");
    expect(fresh.getState().drafts).toEqual({ good: "keep me" });
  });
});
