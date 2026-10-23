import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn().mockResolvedValue(() => {}) }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@/lib/agentsMd", () => ({ loadAgentsMd: vi.fn().mockResolvedValue(null) }));
vi.mock("@/stores/memoryStore", () => ({
  useMemoryStore: { getState: vi.fn(() => ({})) },
}));
vi.mock("@/stores/layoutStore", () => ({
  useLayoutStore: { getState: vi.fn(() => ({ setProjectPath: vi.fn() })) },
}));
vi.mock("@/lib/tauri", () => ({
  killPty: vi.fn(),
  getGitStatus: vi.fn(),
  removeConversationWorktree: vi.fn(),
  loadConversations: vi.fn().mockResolvedValue([]),
  respondPermission: vi.fn(),
  respondEdit: vi.fn(),
  cancelPendingTools: vi.fn(),
}));

import { openAgentAttention, restoreReviewPosition } from "@/stores/sessionGlue";
import { useAgentTaskStore } from "@/stores/agentTaskStore";
import { useAgentApprovalStore } from "@/stores/agentApprovalStore";
import { useReviewStore } from "@/stores/reviewStore";
import { useAppStore } from "@/stores/appStore";
import type { AgentConversation } from "@/types/agent-conversation";

function conv(overrides: Partial<AgentConversation> = {}): AgentConversation {
  return {
    id: "conv-1",
    title: "My Task",
    agent: "api-claude",
    projectPath: "/proj",
    status: "active",
    messages: [],
    sessionId: "conv-1",
    rawOutput: "",
    createdAt: 1,
    updatedAt: 1,
    mode: "api",
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  useAgentTaskStore.setState({ conversations: [conv()], selectedConversationId: null });
  useAgentApprovalStore.setState({
    permissions: new Map([["conv-1", [{ id: "perm-1", name: "bash", arguments: "{}" }]]]),
    edits: new Map(),
  });
  useReviewStore.setState({
    open: false,
    conversationId: null,
    focusPath: null,
    returnAnchor: null,
    attentionFocus: null,
    searchNavigation: null,
  });
  useAppStore.setState({ activeView: "welcome" as never });
});

describe("openAgentAttention — exact attention routing (F6)", () => {
  it("opens the exact permission: selects, reveals, arms the card and saves a return anchor", () => {
    const result = openAgentAttention({
      conversationId: "conv-1",
      kind: "permission",
      requestId: "perm-1",
    });

    expect(result).toEqual({ opened: true });
    expect(useAgentTaskStore.getState().selectedConversationId).toBe("conv-1");
    expect(useAppStore.getState().activeView).toBe("agents");
    expect(useReviewStore.getState().attentionFocus).toMatchObject({
      conversationId: "conv-1",
      kind: "permission",
      requestId: "perm-1",
    });
    expect(useReviewStore.getState().returnAnchor).toMatchObject({
      conversationId: "conv-1",
    });
  });

  it("returns missing_conversation for a stale id without arming anything", () => {
    const result = openAgentAttention({
      conversationId: "does-not-exist",
      kind: "permission",
      requestId: "perm-1",
    });

    expect(result).toEqual({ opened: false, reason: "missing_conversation" });
    expect(useReviewStore.getState().attentionFocus).toBeNull();
    expect(useAppStore.getState().activeView).toBe("welcome");
  });

  it("returns resolved (never targets a different request) when the exact id is gone", () => {
    const result = openAgentAttention({
      conversationId: "conv-1",
      kind: "permission",
      requestId: "perm-answered",
    });

    expect(result).toEqual({ opened: false, reason: "resolved" });
    expect(useReviewStore.getState().attentionFocus).toBeNull();
    expect(useAgentTaskStore.getState().selectedConversationId).toBeNull();
  });

  it("edit attention opens the canonical review at the exact pending edit", () => {
    useAgentApprovalStore.setState({
      edits: new Map([["conv-1", [{ id: "edit-1", path: "src/a.ts", content: "x" }]]]),
    });
    const result = openAgentAttention({
      conversationId: "conv-1",
      kind: "edit",
      requestId: "edit-1",
      filePath: "src/a.ts",
    });

    expect(result).toEqual({ opened: true });
    expect(useReviewStore.getState().open).toBe(true);
    expect(useReviewStore.getState().focusPath).toBe("src/a.ts");
  });
});

describe("restoreReviewPosition — return to review (F6)", () => {
  it("restores the saved file and consumes the anchor", () => {
    useReviewStore.getState().saveReturnAnchor("conv-1", "src/a.ts", 42);

    expect(restoreReviewPosition("conv-1")).toBe(true);
    expect(useReviewStore.getState().open).toBe(true);
    expect(useReviewStore.getState().focusPath).toBe("src/a.ts");
    expect(useReviewStore.getState().returnAnchor).toBeNull();
  });

  it("returns false when no anchor was saved", () => {
    expect(restoreReviewPosition("conv-1")).toBe(false);
  });
});
