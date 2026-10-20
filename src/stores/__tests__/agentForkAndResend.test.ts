import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentConversation, AgentMessage } from "@/types/agent-conversation";

const listenMock = vi.fn();
const invokeMock = vi.fn();
const closeApiAgentSessionMock = vi.fn();
const sendApiAgentMessageMock = vi.fn();
const startApiAgentSessionMock = vi.fn();
const loadConversationsMock = vi.fn();

vi.mock("@tauri-apps/api/event", () => ({
  listen: (...args: unknown[]) => listenMock(...args),
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

vi.mock("@/lib/agentsMd", () => ({
  loadAgentsMd: vi.fn().mockResolvedValue(null),
}));

vi.mock("@/stores/memoryStore", () => ({
  useMemoryStore: {
    getState: vi.fn(() => ({})),
  },
}));

vi.mock("@/stores/layoutStore", () => ({
  useLayoutStore: {
    getState: vi.fn(() => ({
      setProjectPath: vi.fn(),
    })),
  },
}));

vi.mock("@/lib/tauri", () => ({
  createPtySession: vi.fn(),
  writePty: vi.fn(),
  killPty: vi.fn(),
  readPtyTranscript: vi.fn().mockResolvedValue({ data: "" }),
  listPtySessions: vi.fn().mockResolvedValue([]),
  detectAgent: vi.fn(),
  loadPersistedState: vi.fn(),
  saveAgentsSlice: vi.fn().mockResolvedValue(undefined),
  startApiAgentSession: (...args: unknown[]) => startApiAgentSessionMock(...args),
  sendApiAgentMessage: (...args: unknown[]) => sendApiAgentMessageMock(...args),
  cancelApiAgentSession: vi.fn().mockResolvedValue(undefined),
  cancelPendingTools: vi.fn(),
  closeApiAgentSession: (...args: unknown[]) => closeApiAgentSessionMock(...args),
  saveConversation: vi.fn().mockResolvedValue(undefined),
  loadConversations: (...args: unknown[]) => loadConversationsMock(...args),
  deleteConversationFile: vi.fn().mockResolvedValue(undefined),
  changeAgentModel: vi.fn(),
  setPlanMode: vi.fn(),
  setPermissionMode: vi.fn(),
  respondPermission: vi.fn(),
  setApproveWrites: vi.fn(),
  respondEdit: vi.fn(),
  retryLastTurn: vi.fn(),
  exportConversationMarkdown: vi.fn(),
  saveWorkspacesSlice: vi.fn().mockResolvedValue(undefined),
  removeConversationWorktree: vi.fn().mockResolvedValue(undefined),
}));

function makeMessage(overrides: Partial<AgentMessage> = {}): AgentMessage {
  return {
    id: "msg-x",
    role: "user",
    content: "hello",
    timestamp: 1,
    ...overrides,
  };
}

function conversation(overrides: Partial<AgentConversation> = {}): AgentConversation {
  return {
    id: "conv-A",
    title: "Test",
    agent: "api-openai",
    projectPath: "D:/projects/example",
    status: "idle",
    messages: [
      makeMessage({ id: "msg-1", content: "user one" }),
      makeMessage({ id: "msg-2", role: "assistant", content: "assistant one" }),
      makeMessage({ id: "msg-3", content: "user two" }),
      makeMessage({ id: "msg-4", role: "assistant", content: "assistant two" }),
    ],
    sessionId: "conv-A",
    rawOutput: "",
    createdAt: 1,
    updatedAt: 1,
    mode: "api",
    provider: "openai",
    model: "gpt-4o",
    ...overrides,
  };
}

function seedConversation(
  store: {
    getState: () => { conversations: AgentConversation[] };
    setState: (s: Partial<{ conversations: AgentConversation[] }>) => void;
  },
  conv: AgentConversation,
): void {
  store.setState({
    conversations: [conv, ...store.getState().conversations],
  });
}

describe("agentTaskStore.forkConversation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    vi.doUnmock("@/stores/agentTaskStore");
    localStorage.clear();
    listenMock.mockResolvedValue(() => {});
    invokeMock.mockResolvedValue(undefined);
    loadConversationsMock.mockResolvedValue([]);
    closeApiAgentSessionMock.mockResolvedValue(undefined);
    sendApiAgentMessageMock.mockResolvedValue(undefined);
    startApiAgentSessionMock.mockResolvedValue(undefined);
  });

  it("creates a child with lineage and leaves the parent byte-for-byte intact", async () => {
    const { useAgentTaskStore } = await import("@/stores/agentTaskStore");
    const parent = conversation({
      resumeToken: "stale-token",
      worktree: {
        basePath: "D:/projects/example",
        worktreePath: "D:/projects/example/.pkt-worktrees/conv-A",
        branch: "pkt/conv-A",
        createdAt: 1,
        state: "active",
      },
    });
    seedConversation(useAgentTaskStore, parent);
    const before = JSON.stringify(parent);

    const childId = await useAgentTaskStore
      .getState()
      .forkConversation("conv-A", "msg-3", "edited content");

    expect(childId).toBeTruthy();
    expect(childId).not.toBe("conv-A");

    const after = useAgentTaskStore.getState().conversations.find((c) => c.id === "conv-A");
    expect(JSON.stringify(after)).toBe(before);

    const child = useAgentTaskStore.getState().conversations.find((c) => c.id === childId);
    expect(child).toBeDefined();
    // Prefix before the edited turn, then the explicitly sent new turn.
    expect(child!.messages[0].id).toBe("msg-1");
    expect(child!.messages[1].id).toBe("msg-2");
    expect(child!.messages.some((m) => m.content === "edited content")).toBe(true);
    expect(child!.messages.some((m) => m.id === "msg-3")).toBe(false);
    expect(child!.lineage).toMatchObject({
      parentConversationId: "conv-A",
      forkedFromMessageId: "msg-3",
      kind: "fork",
      contextMode: "semantic",
    });
    // The child is not a second worktree owner and does not inherit live state.
    expect(child!.worktree).toBeUndefined();
    expect(child!.resumeToken).toBeUndefined();
    expect(child!.sessionId).toBeNull();
  });

  it("does not start anything for whitespace-only content", async () => {
    const { useAgentTaskStore } = await import("@/stores/agentTaskStore");
    seedConversation(useAgentTaskStore, conversation());

    const childId = await useAgentTaskStore.getState().forkConversation("conv-A", "msg-3", "   ");

    expect(childId).toBeNull();
    expect(useAgentTaskStore.getState().conversations).toHaveLength(1);
    expect(startApiAgentSessionMock).not.toHaveBeenCalled();
  });

  it("refuses to fork an active conversation", async () => {
    const { useAgentTaskStore } = await import("@/stores/agentTaskStore");
    seedConversation(
      useAgentTaskStore,
      conversation({
        status: "active",
        messages: [
          makeMessage({ id: "msg-1" }),
          makeMessage({ id: "msg-2", isStreaming: true, role: "assistant" }),
        ],
      }),
    );

    const childId = await useAgentTaskStore
      .getState()
      .forkConversation("conv-A", "msg-1", "edited");

    expect(childId).toBeNull();
    expect(useAgentTaskStore.getState().conversations).toHaveLength(1);
    expect(startApiAgentSessionMock).not.toHaveBeenCalled();
  });

  it("leaves the parent intact when child persistence fails", async () => {
    const { useAgentTaskStore } = await import("@/stores/agentTaskStore");
    const tauri = await import("@/lib/tauri");
    vi.mocked(tauri.saveConversation).mockRejectedValueOnce(new Error("disk full"));
    seedConversation(useAgentTaskStore, conversation());
    const before = JSON.stringify(useAgentTaskStore.getState().conversations[0]);

    await expect(
      useAgentTaskStore.getState().forkConversation("conv-A", "msg-3", "edited"),
    ).rejects.toThrow("disk full");

    expect(useAgentTaskStore.getState().conversations).toHaveLength(1);
    expect(JSON.stringify(useAgentTaskStore.getState().conversations[0])).toBe(before);
  });

  it("retains the parent checkout while a fork still references it", async () => {
    const { useAgentTaskStore } = await import("@/stores/agentTaskStore");
    const tauri = await import("@/lib/tauri");
    const removeWorktree = vi.mocked(tauri.removeConversationWorktree);
    seedConversation(
      useAgentTaskStore,
      conversation({
        worktree: {
          basePath: "D:/projects/example",
          worktreePath: "D:/projects/example/.pkt-worktrees/conv-A",
          branch: "pkt/conv-A",
          createdAt: 1,
          state: "active",
        },
      }),
    );

    const childId = await useAgentTaskStore
      .getState()
      .forkConversation("conv-A", "msg-3", "edited");
    expect(childId).toBeTruthy();

    const outcome = await useAgentTaskStore.getState().deleteConversation("conv-A");

    expect(outcome?.discarded).toBe(false);
    expect(outcome?.error).toContain("fork(s) still reference");
    expect(removeWorktree).not.toHaveBeenCalled();
  });
});

describe("agentTaskStore.rewindConversation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    vi.doUnmock("@/stores/agentTaskStore");
    localStorage.clear();
    listenMock.mockResolvedValue(() => {});
    invokeMock.mockResolvedValue(undefined);
    loadConversationsMock.mockResolvedValue([]);
    closeApiAgentSessionMock.mockResolvedValue(undefined);
    startApiAgentSessionMock.mockResolvedValue(undefined);
  });

  it("saves a revision and truncates through the selected turn without sending", async () => {
    const { useAgentTaskStore } = await import("@/stores/agentTaskStore");
    const { useAgentApprovalStore } = await import("@/stores/agentApprovalStore");
    const { useAgentStreamingStore } = await import("@/stores/agentStreamingStore");
    const { useAgentPlanStore } = await import("@/stores/agentPlanStore");
    seedConversation(useAgentTaskStore, conversation());
    useAgentApprovalStore.getState().addPendingPermission("conv-A", {
      id: "perm-1",
      name: "bash",
      arguments: "{}",
    });
    useAgentStreamingStore.getState().appendThinking("conv-A", "midstream...");
    useAgentPlanStore
      .getState()
      .setPlan("conv-A", [{ id: "task-1", content: "Discarded step", status: "completed" }]);

    const rewound = await useAgentTaskStore.getState().rewindConversation("conv-A", "msg-3");

    expect(rewound).toBe(true);
    const updated = useAgentTaskStore.getState().conversations.find((c) => c.id === "conv-A");
    expect(updated!.messages.map((m) => m.id)).toEqual(["msg-1", "msg-2", "msg-3"]);
    expect(updated!.sessionId).toBeNull();
    expect(updated!.transcriptRevisions).toHaveLength(1);
    expect(updated!.transcriptRevisions![0]).toMatchObject({
      conversationId: "conv-A",
      operation: "transcript_rewind",
      throughMessageId: "msg-3",
      messageCount: 4,
    });
    expect(updated!.transcriptRevisions![0].messages.map((m) => m.id)).toEqual([
      "msg-1",
      "msg-2",
      "msg-3",
      "msg-4",
    ]);
    // Transcript-only: no provider start and no filesystem claim.
    expect(startApiAgentSessionMock).not.toHaveBeenCalled();
    expect(sendApiAgentMessageMock).not.toHaveBeenCalled();
    expect(closeApiAgentSessionMock).toHaveBeenCalledWith("conv-A");
    expect(useAgentApprovalStore.getState().permissions.has("conv-A")).toBe(false);
    expect(useAgentStreamingStore.getState().thinkingStream.has("conv-A")).toBe(false);
    expect(useAgentPlanStore.getState().plan.has("conv-A")).toBe(false);
  });

  it("refuses to rewind when Stop does not settle the turn", async () => {
    const { useAgentTaskStore } = await import("@/stores/agentTaskStore");
    invokeMock.mockRejectedValueOnce(new Error("cancel not acknowledged"));
    seedConversation(
      useAgentTaskStore,
      conversation({
        status: "active",
        messages: [
          makeMessage({ id: "msg-1" }),
          makeMessage({ id: "msg-2", isStreaming: true, role: "assistant" }),
        ],
      }),
    );

    const rewound = await useAgentTaskStore.getState().rewindConversation("conv-A", "msg-1");

    expect(rewound).toBe(false);
    const updated = useAgentTaskStore.getState().conversations.find((c) => c.id === "conv-A");
    expect(updated!.messages.map((m) => m.id)).toEqual(["msg-1", "msg-2"]);
    expect(updated!.transcriptRevisions).toBeUndefined();
  });

  it("leaves the transcript intact when the revision cannot be persisted", async () => {
    const { useAgentTaskStore } = await import("@/stores/agentTaskStore");
    const tauri = await import("@/lib/tauri");
    vi.mocked(tauri.saveConversation).mockRejectedValueOnce(new Error("disk full"));
    seedConversation(useAgentTaskStore, conversation());

    const rewound = await useAgentTaskStore.getState().rewindConversation("conv-A", "msg-3");

    expect(rewound).toBe(false);
    const updated = useAgentTaskStore.getState().conversations.find((c) => c.id === "conv-A");
    expect(updated!.messages.map((m) => m.id)).toEqual(["msg-1", "msg-2", "msg-3", "msg-4"]);
    expect(updated!.transcriptRevisions).toBeUndefined();
  });

  it("is a no-op for a missing message id", async () => {
    const { useAgentTaskStore } = await import("@/stores/agentTaskStore");
    seedConversation(useAgentTaskStore, conversation());

    const rewound = await useAgentTaskStore.getState().rewindConversation("conv-A", "missing");

    expect(rewound).toBe(false);
    expect(closeApiAgentSessionMock).not.toHaveBeenCalled();
  });
});
