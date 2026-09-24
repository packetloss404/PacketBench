import { beforeEach, describe, expect, it, vi } from "vitest";

const listenMock = vi.fn();
const invokeMock = vi.fn();
const loadConversationsMock = vi.fn();
const saveConversationMock = vi.fn();
const closeApiAgentSessionMock = vi.fn();

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
    getState: vi.fn(() => ({ setProjectPath: vi.fn() })),
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
  startApiAgentSession: vi.fn().mockResolvedValue(undefined),
  sendApiAgentMessage: vi.fn(),
  cancelApiAgentSession: vi.fn(),
  cancelPendingTools: vi.fn(),
  closeApiAgentSession: (...args: unknown[]) => closeApiAgentSessionMock(...args),
  saveConversation: (...args: unknown[]) => saveConversationMock(...args),
  loadConversations: (...args: unknown[]) => loadConversationsMock(...args),
  deleteConversationFile: vi.fn(),
  changeAgentModel: vi.fn(),
  setPlanMode: vi.fn(),
  setPermissionMode: vi.fn(),
  respondPermission: vi.fn(),
  setApproveWrites: vi.fn(),
  respondEdit: vi.fn(),
  retryLastTurn: vi.fn(),
  exportConversationMarkdown: vi.fn(),
  saveWorkspacesSlice: vi.fn().mockResolvedValue(undefined),
  getGitStatus: vi.fn().mockResolvedValue(""),
  removeConversationWorktree: vi.fn(),
}));

const CONV_ID = "conv-rename";

function seedConversation(overrides: Record<string, unknown> = {}) {
  const now = Date.now();
  return {
    id: CONV_ID,
    title: "Original title",
    agent: "api-claude",
    projectPath: "/repo",
    status: "idle",
    messages: [],
    sessionId: null,
    rawOutput: "",
    createdAt: now,
    updatedAt: now,
    mode: "api",
    archived: false,
    ...overrides,
  };
}

function titleOf(conversations: { id: string; title: string }[]) {
  return conversations.find((c) => c.id === CONV_ID)?.title;
}

describe("agentTaskStore — renameConversation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    vi.doUnmock("@/stores/agentTaskStore");
    localStorage.clear();
    listenMock.mockResolvedValue(() => {});
    invokeMock.mockResolvedValue(undefined);
    loadConversationsMock.mockResolvedValue([]);
    saveConversationMock.mockResolvedValue(undefined);
    closeApiAgentSessionMock.mockResolvedValue(undefined);
  });

  it("persists an explicit empty MCP selection when reconnecting a restored conversation", async () => {
    const { useAgentTaskStore } = await import("@/stores/agentTaskStore");
    useAgentTaskStore.setState({
      conversations: [
        seedConversation({ enabledMcpServerIds: undefined, mcpTrustSnapshot: [{ stale: true }] }),
      ],
    } as never);
    await useAgentTaskStore.getState().prepareMcpReconnect(CONV_ID, []);
    expect(closeApiAgentSessionMock).toHaveBeenCalledWith(CONV_ID);
    expect(useAgentTaskStore.getState().conversations[0].enabledMcpServerIds).toEqual([]);
    expect(useAgentTaskStore.getState().conversations[0].mcpTrustSnapshot).toBeUndefined();
    await vi.waitFor(
      () => {
        expect(saveConversationMock).toHaveBeenCalled();
        const [, json] =
          saveConversationMock.mock.calls[saveConversationMock.mock.calls.length - 1];
        expect(JSON.parse(json as string).enabledMcpServerIds).toEqual([]);
      },
      { timeout: 4000 },
    );
  }, 20000);

  it("preserves selected MCP servers unless the reconnect explicitly changes them", async () => {
    const { useAgentTaskStore } = await import("@/stores/agentTaskStore");
    useAgentTaskStore.setState({
      conversations: [seedConversation({ enabledMcpServerIds: ["kept"] })],
    } as never);
    await useAgentTaskStore.getState().prepareMcpReconnect(CONV_ID);
    expect(useAgentTaskStore.getState().conversations[0].enabledMcpServerIds).toEqual(["kept"]);
  });

  it("does not change MCP selection if closing the backend fails", async () => {
    const { useAgentTaskStore } = await import("@/stores/agentTaskStore");
    useAgentTaskStore.setState({
      conversations: [seedConversation({ enabledMcpServerIds: ["kept"] })],
    } as never);
    closeApiAgentSessionMock.mockRejectedValueOnce(new Error("close failed"));
    await expect(useAgentTaskStore.getState().prepareMcpReconnect(CONV_ID, [])).rejects.toThrow(
      "close failed",
    );
    expect(useAgentTaskStore.getState().conversations[0].enabledMcpServerIds).toEqual(["kept"]);
    expect(saveConversationMock).not.toHaveBeenCalled();
  });

  // First test pays the cold dynamic-import cost of the full agentTaskStore
  // graph plus the real 500ms persist debounce; the default 5s timeout is too
  // tight under parallel suite load on Windows.
  it("renames the conversation and persists the new title", async () => {
    const { useAgentTaskStore } = await import("@/stores/agentTaskStore");
    useAgentTaskStore.setState({ conversations: [seedConversation()] } as never);

    useAgentTaskStore.getState().renameConversation(CONV_ID, "Renamed session");

    expect(titleOf(useAgentTaskStore.getState().conversations)).toBe("Renamed session");
    expect(saveConversationMock).not.toHaveBeenCalled(); // debounced
    await vi.waitFor(
      () => {
        expect(saveConversationMock).toHaveBeenCalled();
        const [id, json] =
          saveConversationMock.mock.calls[saveConversationMock.mock.calls.length - 1];
        expect(id).toBe(CONV_ID);
        expect(JSON.parse(json as string).title).toBe("Renamed session");
      },
      { timeout: 4000 },
    );
  }, 20000);

  it("trims surrounding whitespace before committing", async () => {
    const { useAgentTaskStore } = await import("@/stores/agentTaskStore");
    useAgentTaskStore.setState({ conversations: [seedConversation()] } as never);

    useAgentTaskStore.getState().renameConversation(CONV_ID, "   Padded name   ");

    expect(titleOf(useAgentTaskStore.getState().conversations)).toBe("Padded name");
  });

  // The sidebar commits on blur, so clearing the field and clicking away must
  // not persist an empty row label.
  it("ignores a blank title and leaves the existing one standing", async () => {
    const { useAgentTaskStore } = await import("@/stores/agentTaskStore");
    useAgentTaskStore.setState({ conversations: [seedConversation()] } as never);

    useAgentTaskStore.getState().renameConversation(CONV_ID, "   ");

    expect(titleOf(useAgentTaskStore.getState().conversations)).toBe("Original title");
  });

  it("does not touch other conversations or bump an unchanged title", async () => {
    const { useAgentTaskStore } = await import("@/stores/agentTaskStore");
    const other = seedConversation({ id: "conv-other", title: "Other" });
    const seeded = seedConversation();
    useAgentTaskStore.setState({ conversations: [seeded, other] } as never);
    const before = useAgentTaskStore.getState().conversations;

    useAgentTaskStore.getState().renameConversation(CONV_ID, "Original title");

    // Same title in, so the record is returned by identity — no updatedAt bump
    // and nothing scheduled for persistence.
    const after = useAgentTaskStore.getState().conversations;
    expect(after.find((c) => c.id === CONV_ID)).toBe(before.find((c) => c.id === CONV_ID));
    expect(after.find((c) => c.id === "conv-other")?.title).toBe("Other");
  });
});
