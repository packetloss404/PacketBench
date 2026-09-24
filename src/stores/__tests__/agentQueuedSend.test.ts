import { beforeEach, describe, expect, it, vi } from "vitest";

const listenMock = vi.fn();
const invokeMock = vi.fn();
const closeApiAgentSessionMock = vi.fn();
const cancelApiAgentSessionMock = vi.fn();
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
    getState: vi.fn(() => ({
      composeMemoryBrief: vi.fn(() => ({ text: "" })),
    })),
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
  cancelApiAgentSession: (...args: unknown[]) => cancelApiAgentSessionMock(...args),
  cancelPendingTools: vi.fn(),
  closeApiAgentSession: (...args: unknown[]) => closeApiAgentSessionMock(...args),
  saveConversation: vi.fn().mockResolvedValue(undefined),
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
}));

/**
 * Regression gate for the PROTECTED queued-send-while-streaming behavior
 * (consensus keep list): sending from the composer while the assistant is
 * still streaming must queue the message (queued bubble + queuedMessages)
 * instead of dispatching it mid-turn; sending while idle dispatches
 * after budget admission with attachments forwarded.
 */
describe("agentTaskStore.sendMessage — queued-send-while-streaming (protected)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    vi.doUnmock("@/stores/agentTaskStore");
    localStorage.clear();
    listenMock.mockResolvedValue(() => {});
    invokeMock.mockResolvedValue(undefined);
    loadConversationsMock.mockResolvedValue([]);
    sendApiAgentMessageMock.mockResolvedValue(undefined);
    startApiAgentSessionMock.mockResolvedValue(undefined);
  });

  /** Creates a live API conversation (registers listeners) whose initial
   * assistant message is still streaming — the state the composer sees when
   * the user types while a turn is in flight. */
  async function createStreamingConversation() {
    const { useAgentTaskStore } = await import("@/stores/agentTaskStore");
    const id = await useAgentTaskStore.getState().createApiConversation({
      agent: "api-openai",
      projectPath: "D:/projects/example",
      model: "gpt-4o",
      initialMessage: "first turn",
      systemPromptOverride: null,
      planMode: false,
      sshTarget: null,
      skipBackendStart: true,
      allowedTools: null,
      memoryContextEnabled: false,
      attachments: null,
    });
    return { useAgentTaskStore, id };
  }

  it("queues a send while the assistant is streaming instead of dispatching it", async () => {
    const { useAgentTaskStore, id } = await createStreamingConversation();
    const before = useAgentTaskStore.getState().conversations.find((c) => c.id === id);
    expect(before?.status).toBe("active");
    expect(before?.messages.some((m) => m.isStreaming)).toBe(true);

    useAgentTaskStore.getState().sendMessage(id, "typed mid-stream");

    const conv = useAgentTaskStore.getState().conversations.find((c) => c.id === id);
    // The message is parked in the queue, visible as a queued bubble…
    expect(conv?.queuedMessages).toEqual(["typed mid-stream"]);
    const bubble = conv?.messages.find((m) => m.content === "typed mid-stream");
    expect(bubble?.role).toBe("user");
    expect(bubble?.queued).toBe(true);
    // …and nothing is dispatched to the backend mid-turn.
    expect(sendApiAgentMessageMock).not.toHaveBeenCalled();
  });

  it("queues multiple sends in order while streaming", async () => {
    const { useAgentTaskStore, id } = await createStreamingConversation();

    useAgentTaskStore.getState().sendMessage(id, "queued A");
    useAgentTaskStore.getState().sendMessage(id, "queued B");

    const conv = useAgentTaskStore.getState().conversations.find((c) => c.id === id);
    expect(conv?.queuedMessages).toEqual(["queued A", "queued B"]);
    expect(sendApiAgentMessageMock).not.toHaveBeenCalled();
  });

  it("dispatches after budget admission (with attachments) when no turn is streaming", async () => {
    const { useAgentTaskStore, id } = await createStreamingConversation();
    // Settle the stream: what the done-listener does to the transcript.
    useAgentTaskStore.setState((s) => ({
      conversations: s.conversations.map((c) =>
        c.id === id
          ? {
              ...c,
              status: "idle" as const,
              messages: c.messages.map((m) => ({ ...m, isStreaming: false })),
            }
          : c,
      ),
    }));

    const attachments = [{ media_type: "image/png", data_base64: "aGk=" }];
    useAgentTaskStore.getState().sendMessage(id, "idle send", attachments);

    const conv = useAgentTaskStore.getState().conversations.find((c) => c.id === id);
    expect(conv?.queuedMessages ?? []).toEqual([]);
    const sent = conv?.messages.find((m) => m.content === "idle send");
    expect(sent?.role).toBe("user");
    expect(sent?.queued).toBeUndefined();
    await vi.waitFor(() =>
      expect(sendApiAgentMessageMock).toHaveBeenCalledWith(id, "idle send", attachments),
    );
  });
});
