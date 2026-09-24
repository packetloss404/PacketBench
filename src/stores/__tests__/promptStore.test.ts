import { describe, it, expect, beforeEach, vi } from "vitest";
import { usePromptStore } from "../promptStore";
import { useLayoutStore } from "../layoutStore";
import { writePty } from "@/lib/tauri";

vi.mock("@/lib/tauri", async (original) => ({
  ...(await original<typeof import("@/lib/tauri")>()),
  writePty: vi.fn(),
}));

const STORAGE_KEY = "packetbench:prompt-templates";
const store = () => usePromptStore.getState();

describe("promptStore", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
    usePromptStore.setState({ templates: [] });
  });

  it("reports a missing terminal and rejected writes while preserving the template", async () => {
    store().addTemplate("Retry me", "intended content", "general");
    const template = store().templates[0];
    const pane = vi.spyOn(useLayoutStore.getState(), "getActivePane").mockReturnValue(undefined);
    await expect(store().sendToTerminal(template.id)).rejects.toThrow("Select a running terminal");
    pane.mockReturnValue({ sessionId: "dead-session" } as ReturnType<typeof useLayoutStore.getState>["panes"][number]);
    vi.mocked(writePty).mockRejectedValueOnce(new Error("PTY no longer exists"));
    await expect(store().sendToTerminal(template.id)).rejects.toThrow("PTY no longer exists");
    expect(store().templates[0]).toEqual(template);
    vi.mocked(writePty).mockResolvedValueOnce(undefined);
    await store().sendToTerminal(template.id);
    expect(writePty).toHaveBeenLastCalledWith("dead-session", "intended content\r");
  });

  describe("addTemplate", () => {
    it("creates a template with generated id and timestamps", () => {
      store().addTemplate("Bug Report", "Describe the bug", "debugging");
      const t = store().templates[0];
      expect(t.id).toMatch(/^tpl_/);
      expect(t.name).toBe("Bug Report");
      expect(t.content).toBe("Describe the bug");
      expect(t.category).toBe("debugging");
      expect(t.createdAt).toBeTypeOf("number");
      expect(t.updatedAt).toBe(t.createdAt);
    });

    it("persists templates to localStorage", () => {
      store().addTemplate("A", "content", "general");
      const raw = JSON.parse(localStorage.getItem(STORAGE_KEY)!);
      expect(raw).toHaveLength(1);
      expect(raw[0].name).toBe("A");
    });

    it("appends multiple templates", () => {
      store().addTemplate("A", "a", "general");
      store().addTemplate("B", "b", "feature");
      expect(store().templates.map((t) => t.name)).toEqual(["A", "B"]);
    });
  });

  describe("updateTemplate", () => {
    it("updates name/content/category and bumps updatedAt", async () => {
      store().addTemplate("Name", "body", "general");
      const id = store().templates[0].id;
      const originalUpdated = store().templates[0].updatedAt;
      await new Promise((r) => setTimeout(r, 2));
      store().updateTemplate(id, { name: "New", content: "new body", category: "review" });
      const t = store().templates[0];
      expect(t.name).toBe("New");
      expect(t.content).toBe("new body");
      expect(t.category).toBe("review");
      expect(t.updatedAt).toBeGreaterThanOrEqual(originalUpdated);
    });

    it("is a no-op for unknown id", () => {
      store().addTemplate("Name", "body", "general");
      expect(() => store().updateTemplate("nope", { name: "x" })).not.toThrow();
      expect(store().templates[0].name).toBe("Name");
    });

    it("persists updates", () => {
      store().addTemplate("Name", "body", "general");
      const id = store().templates[0].id;
      store().updateTemplate(id, { name: "Renamed" });
      const raw = JSON.parse(localStorage.getItem(STORAGE_KEY)!);
      expect(raw[0].name).toBe("Renamed");
    });
  });

  describe("deleteTemplate", () => {
    it("removes a template by id", () => {
      store().addTemplate("A", "a", "general");
      store().addTemplate("B", "b", "general");
      const id = store().templates[0].id;
      store().deleteTemplate(id);
      expect(store().templates.map((t) => t.name)).toEqual(["B"]);
    });

    it("is a no-op for unknown id", () => {
      store().addTemplate("A", "a", "general");
      expect(() => store().deleteTemplate("nope")).not.toThrow();
      expect(store().templates).toHaveLength(1);
    });

    it("persists deletion", () => {
      store().addTemplate("A", "a", "general");
      const id = store().templates[0].id;
      store().deleteTemplate(id);
      expect(JSON.parse(localStorage.getItem(STORAGE_KEY)!)).toEqual([]);
    });
  });
});
