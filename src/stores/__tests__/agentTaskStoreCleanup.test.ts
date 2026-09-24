import { beforeEach, describe, expect, it, vi } from "vitest";

const listenMock = vi.fn();
const invokeMock = vi.fn();
const cancelApiAgentSessionMock = vi.fn();
const closeApiAgentSessionMock = vi.fn();
const deleteConversationFileMock = vi.fn();
const killPtyMock = vi.fn();
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
  killPty: (...args: unknown[]) => killPtyMock(...args),
  readPtyTranscript: vi.fn().mockResolvedValue({ data: "" }),
  listPtySessions: vi.fn().mockResolvedValue([]),
  detectAgent: vi.fn(),
  loadPersistedState: vi.fn(),
  saveAgentsSlice: vi.fn().mockResolvedValue(undefined),
  startApiAgentSession: vi.fn().mockResolvedValue(undefined),
  sendApiAgentMessage: vi.fn(),
  cancelApiAgentSession: (...args: unknown[]) => cancelApiAgentSessionMock(...args),
  cancelPendingTools: vi.fn(),
  closeApiAgentSession: (...args: unknown[]) => closeApiAgentSessionMock(...args),
  saveConversation: vi.fn().mockResolvedValue(undefined),
  loadConversations: (...args: unknown[]) => loadConversationsMock(...args),
  deleteConversationFile: (...args: unknown[]) => deleteConversationFileMock(...args),
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

describe("agentTaskStore.deleteConversation — substore cleanup", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    vi.doUnmock("@/stores/agentTaskStore");
    localStorage.clear();
    listenMock.mockResolvedValue(() => {});
    invokeMock.mockResolvedValue(undefined);
    loadConversationsMock.mockResolvedValue([]);
    cancelApiAgentSessionMock.mockResolvedValue(undefined);
    closeApiAgentSessionMock.mockResolvedValue(undefined);
    deleteConversationFileMock.mockResolvedValue(undefined);
    killPtyMock.mockResolvedValue(undefined);
  });

  it("removes the conversation from agentTaskStore.conversations", async () => {
    const { useAgentTaskStore } = await import("@/stores/agentTaskStore");
    const id = await useAgentTaskStore
      .getState()
      .createApiConversation({
        agent: "api-openai",
        projectPath: "D:/projects/example",
        model: "gpt-4o",
        initialMessage: "kickoff",
      });

    expect(useAgentTaskStore.getState().conversations.find((c) => c.id === id)).toBeDefined();

    useAgentTaskStore.getState().deleteConversation(id);

    expect(useAgentTaskStore.getState().conversations.find((c) => c.id === id)).toBeUndefined();
  });

  it("clears agentApprovalStore entries for the deleted conversation", async () => {
    const { useAgentTaskStore } = await import("@/stores/agentTaskStore");
    const { useAgentApprovalStore } = await import("@/stores/agentApprovalStore");

    const id = await useAgentTaskStore
      .getState()
      .createApiConversation({ agent: "api-openai", projectPath: "D:/projects/example", model: "gpt-4o", initialMessage: "kickoff" });

    useAgentApprovalStore.getState().addPendingPermission(id, {
      id: "perm-1",
      name: "bash",
      arguments: "{}",
    });
    useAgentApprovalStore.getState().addPendingEdit(id, {
      id: "edit-1",
      path: "src/foo.ts",
      content: "// new",
    });
    expect(useAgentApprovalStore.getState().permissions.has(id)).toBe(true);
    expect(useAgentApprovalStore.getState().edits.has(id)).toBe(true);

    useAgentTaskStore.getState().deleteConversation(id);

    expect(useAgentApprovalStore.getState().permissions.has(id)).toBe(false);
    expect(useAgentApprovalStore.getState().edits.has(id)).toBe(false);
  });

  it("clears agentPlanStore entries for the deleted conversation", async () => {
    const { useAgentTaskStore } = await import("@/stores/agentTaskStore");
    const { useAgentPlanStore } = await import("@/stores/agentPlanStore");

    const id = await useAgentTaskStore
      .getState()
      .createApiConversation({ agent: "api-openai", projectPath: "D:/projects/example", model: "gpt-4o", initialMessage: "kickoff" });

    useAgentPlanStore.getState().setPlan(id, [
      { id: "t1", content: "do thing", status: "pending" },
    ]);
    // Seed the approval flag directly — approvePlan's side effects (execute
    // turn) are covered by agentPlanStore.test.ts and would fire a real
    // send here.
    useAgentPlanStore.setState((s) => ({
      planApproved: new Map(s.planApproved).set(id, true),
    }));
    expect(useAgentPlanStore.getState().plan.has(id)).toBe(true);
    expect(useAgentPlanStore.getState().planApproved.has(id)).toBe(true);

    useAgentTaskStore.getState().deleteConversation(id);

    expect(useAgentPlanStore.getState().plan.has(id)).toBe(false);
    expect(useAgentPlanStore.getState().planApproved.has(id)).toBe(false);
  });

  it("clears agentStreamingStore entries for the deleted conversation", async () => {
    const { useAgentTaskStore } = await import("@/stores/agentTaskStore");
    const { useAgentStreamingStore } = await import("@/stores/agentStreamingStore");

    const id = await useAgentTaskStore
      .getState()
      .createApiConversation({ agent: "api-openai", projectPath: "D:/projects/example", model: "gpt-4o", initialMessage: "kickoff" });

    useAgentStreamingStore.getState().appendThinking(id, "thinking...");
    useAgentStreamingStore.getState().setSubAgentBucket(id, "/root/agent_a", {
      inputTokens: 100,
      outputTokens: 50,
      reasoningTokens: 25,
      cacheReadTokens: 10,
    });
    expect(useAgentStreamingStore.getState().thinkingStream.has(id)).toBe(true);
    expect(useAgentStreamingStore.getState().subAgentTokens.has(id)).toBe(true);

    useAgentTaskStore.getState().deleteConversation(id);

    expect(useAgentStreamingStore.getState().thinkingStream.has(id)).toBe(false);
    expect(useAgentStreamingStore.getState().subAgentTokens.has(id)).toBe(false);
  });

  it("calls cancel + close + deleteConversationFile for live API conversations", async () => {
    const { useAgentTaskStore } = await import("@/stores/agentTaskStore");
    const id = await useAgentTaskStore
      .getState()
      .createApiConversation({ agent: "api-openai", projectPath: "D:/projects/example", model: "gpt-4o", initialMessage: "kickoff" });

    // createApiConversation leaves status = "active" until first event arrives.
    expect(useAgentTaskStore.getState().conversations.find((c) => c.id === id)?.status).toBe(
      "active",
    );

    useAgentTaskStore.getState().deleteConversation(id);

    expect(cancelApiAgentSessionMock).toHaveBeenCalledWith(id);
    expect(closeApiAgentSessionMock).toHaveBeenCalledWith(id);
    expect(deleteConversationFileMock).toHaveBeenCalledWith(id);
  });

  it.each(["done", "failed"] as const)("closes the backend when deleting a %s conversation", async (status) => {
    const { useAgentTaskStore } = await import("@/stores/agentTaskStore");
    const id = await useAgentTaskStore.getState().createApiConversation({ agent: "api-openai", projectPath: "D:/projects/example", model: "gpt-4o", initialMessage: "test" });
    useAgentTaskStore.setState((state) => ({ conversations: state.conversations.map((conv) => ({ ...conv, status })) }));
    await useAgentTaskStore.getState().deleteConversation(id);
    expect(closeApiAgentSessionMock).toHaveBeenCalledWith(id);
    expect(cancelApiAgentSessionMock).not.toHaveBeenCalled();
  });

  it("clears the selectedConversationId when the deleted conversation was selected", async () => {
    const { useAgentTaskStore } = await import("@/stores/agentTaskStore");
    const id = await useAgentTaskStore
      .getState()
      .createApiConversation({ agent: "api-openai", projectPath: "D:/projects/example", model: "gpt-4o", initialMessage: "kickoff" });

    // createApiConversation auto-selects the newly created conversation.
    expect(useAgentTaskStore.getState().selectedConversationId).toBe(id);

    useAgentTaskStore.getState().deleteConversation(id);

    expect(useAgentTaskStore.getState().selectedConversationId).toBeNull();
  });

  // Audit race: api-agent:done listener drains a queued message via
  // setTimeout(..., 0). If deleteConversation fires before the timer
  // tick, sendMessage must no-op against the missing conv id. We can't
  // synthesize the Tauri done event from the listener side here, but
  // sendMessage IS the function the drain callback calls, so the safety
  // net lives there — exercise it directly with fake timers to lock the
  // behavior down.
  it("sendMessage drained after deleteConversation is a no-op (no Tauri call for the missing conv)", async () => {
    vi.useFakeTimers();
    try {
      const { useAgentTaskStore } = await import("@/stores/agentTaskStore");
      const tauri = await import("@/lib/tauri");
      const sendSpy = vi.mocked(tauri.sendApiAgentMessage);
      sendSpy.mockClear();

      const id = await useAgentTaskStore
        .getState()
        .createApiConversation({ agent: "api-openai", projectPath: "D:/projects/example", model: "gpt-4o", initialMessage: "kickoff" });

      // Simulate the drain timer that api-agent:done would schedule:
      // setTimeout(() => getState().sendMessage(id, queued), 0).
      setTimeout(() => {
        useAgentTaskStore.getState().sendMessage(id, "queued-drain-payload");
      }, 0);

      // Delete BEFORE the timer fires — same race the audit flagged.
      useAgentTaskStore.getState().deleteConversation(id);
      expect(
        useAgentTaskStore.getState().conversations.find((c) => c.id === id),
      ).toBeUndefined();

      vi.runAllTimers();

      // sendMessage's `if (!conv) return;` guard means no Tauri write
      // happens for the orphaned drain — race is closed.
      const callsForDeletedId = sendSpy.mock.calls.filter(
        (call) => call[0] === id,
      );
      expect(callsForDeletedId).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("sweepAutoArchive", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    vi.doUnmock("@/stores/agentTaskStore");
    localStorage.clear();
    listenMock.mockResolvedValue(() => {});
    invokeMock.mockResolvedValue(undefined);
    loadConversationsMock.mockResolvedValue([]);
    cancelApiAgentSessionMock.mockResolvedValue(undefined);
    closeApiAgentSessionMock.mockResolvedValue(undefined);
    deleteConversationFileMock.mockResolvedValue(undefined);
    killPtyMock.mockResolvedValue(undefined);
  });

  const DAY_MS = 24 * 60 * 60 * 1000;

  function seedConversation(overrides: Record<string, unknown> = {}) {
    const now = Date.now();
    return {
      id: overrides.id ?? "conv-1",
      title: "A conversation",
      agent: "api-openai",
      projectPath: "D:/projects/example",
      status: "done",
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

  it("archives a done conversation idle past the threshold", async () => {
    const { useAgentTaskStore } = await import("@/stores/agentTaskStore");
    const { useAgentSettingsStore } = await import("@/stores/agentSettingsStore");
    const { sweepAutoArchive } = await import("@/stores/agentConversationPersistence");

    useAgentSettingsStore.getState().setAutoArchiveDays(14);
    useAgentTaskStore.setState({
      conversations: [
        seedConversation({ id: "stale-done", updatedAt: Date.now() - 15 * DAY_MS }),
      ],
    } as never);

    sweepAutoArchive();

    const conv = useAgentTaskStore.getState().conversations.find((c) => c.id === "stale-done");
    expect(conv?.archived).toBe(true);
  });

  it("leaves an active conversation untouched", async () => {
    const { useAgentTaskStore } = await import("@/stores/agentTaskStore");
    const { useAgentSettingsStore } = await import("@/stores/agentSettingsStore");
    const { sweepAutoArchive } = await import("@/stores/agentConversationPersistence");

    useAgentSettingsStore.getState().setAutoArchiveDays(14);
    useAgentTaskStore.setState({
      conversations: [
        seedConversation({
          id: "active-conv",
          status: "active",
          updatedAt: Date.now() - 15 * DAY_MS,
        }),
      ],
    } as never);

    sweepAutoArchive();

    const conv = useAgentTaskStore.getState().conversations.find((c) => c.id === "active-conv");
    expect(conv?.archived).toBe(false);
  });

  it("leaves a done-but-recent conversation untouched", async () => {
    const { useAgentTaskStore } = await import("@/stores/agentTaskStore");
    const { useAgentSettingsStore } = await import("@/stores/agentSettingsStore");
    const { sweepAutoArchive } = await import("@/stores/agentConversationPersistence");

    useAgentSettingsStore.getState().setAutoArchiveDays(14);
    useAgentTaskStore.setState({
      conversations: [
        seedConversation({ id: "recent-done", updatedAt: Date.now() - DAY_MS }),
      ],
    } as never);

    sweepAutoArchive();

    const conv = useAgentTaskStore.getState().conversations.find((c) => c.id === "recent-done");
    expect(conv?.archived).toBe(false);
  });

  it("leaves an already-archived conversation untouched (no re-archive loop)", async () => {
    const { useAgentTaskStore } = await import("@/stores/agentTaskStore");
    const { useAgentSettingsStore } = await import("@/stores/agentSettingsStore");
    const { sweepAutoArchive } = await import("@/stores/agentConversationPersistence");

    useAgentSettingsStore.getState().setAutoArchiveDays(14);
    const staleUpdatedAt = Date.now() - 15 * DAY_MS;
    useAgentTaskStore.setState({
      conversations: [
        seedConversation({ id: "already-archived", archived: true, updatedAt: staleUpdatedAt }),
      ],
    } as never);

    sweepAutoArchive();

    const conv = useAgentTaskStore.getState().conversations.find((c) => c.id === "already-archived");
    expect(conv?.archived).toBe(true);
    // archiveConversation bumps updatedAt — an untouched conversation proves
    // sweepAutoArchive skipped it rather than re-archiving.
    expect(conv?.updatedAt).toBe(staleUpdatedAt);
  });

  it("leaves everything untouched when the auto-archive threshold is disabled (null)", async () => {
    const { useAgentTaskStore } = await import("@/stores/agentTaskStore");
    const { useAgentSettingsStore } = await import("@/stores/agentSettingsStore");
    const { sweepAutoArchive } = await import("@/stores/agentConversationPersistence");

    useAgentSettingsStore.getState().setAutoArchiveDays(null);
    useAgentTaskStore.setState({
      conversations: [
        seedConversation({ id: "stale-but-disabled", updatedAt: Date.now() - 100 * DAY_MS }),
      ],
    } as never);

    sweepAutoArchive();

    const conv = useAgentTaskStore
      .getState()
      .conversations.find((c) => c.id === "stale-but-disabled");
    expect(conv?.archived).toBe(false);
  });
});
