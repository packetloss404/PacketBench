import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Workspace } from "@/types/workspace";

const listenMock = vi.fn();
const invokeMock = vi.fn();
const createPtySessionMock = vi.fn();
const startApiAgentSessionMock = vi.fn();
const loadConversationsMock = vi.fn();
const saveWorkspacesSliceMock = vi.fn();
const detachConversationsFromWorkspaceMock = vi.fn();
const retryLastTurnMock = vi.fn();
const saveAgentsSliceMock = vi.fn();
const loadAgentsMdMock = vi.fn();
const composeMemoryBriefMock = vi.fn((_scope?: unknown) => ({
  text: "",
  items: [],
  charBudget: 1800,
  truncated: false,
  scopeKey: "D:/projects/example",
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: (...args: unknown[]) => listenMock(...args),
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

vi.mock("@/lib/agentsMd", () => ({
  loadAgentsMd: (...args: unknown[]) => loadAgentsMdMock(...args),
}));

vi.mock("@/stores/memoryStore", () => ({
  useMemoryStore: {
    getState: vi.fn(() => ({
      composeMemoryBrief: (scope: unknown) => composeMemoryBriefMock(scope),
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
  createPtySession: (...args: unknown[]) => createPtySessionMock(...args),
  writePty: vi.fn(),
  killPty: vi.fn(),
  readPtyTranscript: vi.fn().mockResolvedValue({ data: "" }),
  listPtySessions: vi.fn().mockResolvedValue([{ id: "pty-session-1", alive: true }]),
  detectAgent: vi.fn(),
  loadPersistedState: vi.fn(),
  saveAgentsSlice: (...args: unknown[]) => saveAgentsSliceMock(...args),
  startApiAgentSession: (...args: unknown[]) => startApiAgentSessionMock(...args),
  sendApiAgentMessage: vi.fn(),
  cancelApiAgentSession: vi.fn(),
  cancelPendingTools: vi.fn(),
  closeApiAgentSession: vi.fn(),
  saveConversation: vi.fn().mockResolvedValue(undefined),
  loadConversations: (...args: unknown[]) => loadConversationsMock(...args),
  deleteConversationFile: vi.fn(),
  changeAgentModel: vi.fn(),
  setPlanMode: vi.fn(),
  setPermissionMode: vi.fn(),
  respondPermission: vi.fn(),
  setApproveWrites: vi.fn(),
  respondEdit: vi.fn(),
  retryLastTurn: (...args: unknown[]) => retryLastTurnMock(...args),
  exportConversationMarkdown: vi.fn(),
  saveWorkspacesSlice: (...args: unknown[]) => saveWorkspacesSliceMock(...args),
}));

function makeWorkspace(overrides: Partial<Workspace> = {}): Workspace {
  const now = Date.now();
  return {
    id: "workspace-1",
    name: "Workspace 1",
    agents: ["codex"],
    panes: [
      {
        id: "pane-1",
        agentId: "codex",
        sessionId: "session-1",
      },
    ],
    projectPath: "D:/projects/example",
    createdAt: now,
    updatedAt: now,
    status: "active",
    ...overrides,
  };
}

describe("agent/workspace store decoupling", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    vi.doUnmock("@/stores/agentTaskStore");
    localStorage.clear();
    listenMock.mockResolvedValue(() => {});
    invokeMock.mockResolvedValue(undefined);
    createPtySessionMock.mockResolvedValue("pty-session-1");
    startApiAgentSessionMock.mockResolvedValue(undefined);
    loadConversationsMock.mockResolvedValue([]);
    loadAgentsMdMock.mockResolvedValue(null);
    saveWorkspacesSliceMock.mockResolvedValue(undefined);
    retryLastTurnMock.mockResolvedValue(undefined);
    saveAgentsSliceMock.mockResolvedValue(undefined);
    composeMemoryBriefMock.mockReturnValue({
      text: "",
      items: [],
      charBudget: 1800,
      truncated: false,
      scopeKey: "D:/projects/example",
    });
  });

  it("does not write workspaceId on newly-created API conversations", async () => {
    const { useAgentTaskStore } = await import("@/stores/agentTaskStore");

    const id = await useAgentTaskStore
      .getState()
      .createApiConversation({
        agent: "api-openai",
        projectPath: "D:/projects/example",
        model: "gpt-4.1",
        initialMessage: "Build the thing",
      });

    const conversation = useAgentTaskStore.getState().conversations.find((c) => c.id === id);

    expect(conversation).toBeDefined();
    expect(conversation).not.toHaveProperty("workspaceId");
    expect(startApiAgentSessionMock).toHaveBeenCalledWith(
      id,
      "openai",
      "gpt-4.1",
      "D:/projects/example",
      "Build the thing",
      null,
      false,
      undefined,
      false,
      null,
      null,
      null,
      null,
      null,
      "ask_for_risky",
      false,
      null,
      undefined,
      undefined,
    );
  });

  it("starts SSH API conversations with remote metadata without local AGENTS.md probing", async () => {
    const { useAgentTaskStore } = await import("@/stores/agentTaskStore");

    const id = await useAgentTaskStore
      .getState()
      .createApiConversation({
        agent: "api-openai-agents",
        projectPath: "/srv/packetbench",
        model: "gpt-5.5",
        initialMessage: "Build remotely",
        thinkingEnabled: false,
        planMode: false,
        sshTarget: {
          serverId: "srv-123",
          name: "Staging",
          host: "example.com",
          port: 2222,
          user: "ian",
          remotePath: "/srv/packetbench",
          keyPath: "C:/Users/ian/.ssh/id_ed25519",
          authMethod: "key",
          hostFingerprint: "SHA256:abc123",
        },
      });

    const conversation = useAgentTaskStore.getState().conversations.find((c) => c.id === id);

    expect(loadAgentsMdMock).not.toHaveBeenCalled();
    expect(conversation?.sshTarget).toEqual({
      id: "srv-123",
      name: "Staging",
      host: "example.com",
      user: "ian",
      remotePath: "/srv/packetbench",
    });
    expect(startApiAgentSessionMock).toHaveBeenCalledWith(
      id,
      "openai-agents",
      "gpt-5.5",
      "/srv/packetbench",
      "Build remotely",
      null,
      false,
      undefined,
      false,
      {
        host: "example.com",
        port: 2222,
        user: "ian",
        remote_path: "/srv/packetbench",
        key_path: "C:/Users/ian/.ssh/id_ed25519",
        auth_method: "key",
        target_id: "srv-123",
        host_fingerprint: "SHA256:abc123",
      },
      null,
      null,
      null,
      null,
      "ask_for_risky",
      false,
      null,
      undefined,
      undefined,
    );
  });

  it("injects compact local memory briefs into new API conversations", async () => {
    composeMemoryBriefMock.mockReturnValue({
      text: "## PacketBench Memory Brief\nLearned patterns:\n- Prefer pnpm scripts.",
      items: [],
      charBudget: 1800,
      truncated: false,
      scopeKey: "D:/projects/example",
    });

    const { useAgentTaskStore } = await import("@/stores/agentTaskStore");
    const id = await useAgentTaskStore
      .getState()
      .createApiConversation({
        agent: "api-openai",
        projectPath: "D:/projects/example",
        model: "gpt-4.1",
        initialMessage: "Build with memory",
        systemPromptOverride: "You are focused.",
        thinkingEnabled: false,
        planMode: false,
        sshTarget: null,
        skipBackendStart: false,
        memoryContextEnabled: true,
      });

    expect(composeMemoryBriefMock).toHaveBeenCalledWith({
      kind: "local",
      projectPath: "D:/projects/example",
    });
    const startCall =
      startApiAgentSessionMock.mock.calls[startApiAgentSessionMock.mock.calls.length - 1];
    expect(startCall?.[5]).toContain("## PacketBench Memory Brief");
    expect(startCall?.[5]).toContain("You are focused.");
    expect(
      useAgentTaskStore.getState().conversations.find((c) => c.id === id)?.memoryContextEnabled,
    ).toBe(true);
  });

  it("passes SSH scope to memory briefs without local path probing", async () => {
    const { useAgentTaskStore } = await import("@/stores/agentTaskStore");
    await useAgentTaskStore.getState().createApiConversation({
      agent: "api-openai-agents",
      projectPath: "/srv/app",
      model: "gpt-5.5",
      initialMessage: "Build remotely with memory enabled",
      systemPromptOverride: null,
      thinkingEnabled: false,
      planMode: false,
      sshTarget: {
        serverId: "server-1",
        name: "Build host",
        host: "example.com",
        port: 2222,
        user: "ian",
        remotePath: "/srv/app",
        keyPath: "/home/ian/.ssh/id_ed25519",
        authMethod: "key",
        hostFingerprint: "SHA256:test",
      },
      skipBackendStart: false,
      memoryContextEnabled: true,
    });

    expect(loadAgentsMdMock).not.toHaveBeenCalled();
    expect(composeMemoryBriefMock).toHaveBeenCalledWith({
      kind: "ssh",
      projectPath: "/srv/app",
      serverId: "server-1",
      remotePath: "/srv/app",
    });
  });

  it("threads SSH target config through sidecar-backed API conversations", async () => {
    const { useAgentTaskStore } = await import("@/stores/agentTaskStore");

    const id = await useAgentTaskStore
      .getState()
      .createApiConversation({
        agent: "api-claude-oauth",
        projectPath: "/srv/app",
        model: "claude-sonnet-4.5",
        initialMessage: "Work on the remote repo",
        systemPromptOverride: null,
        thinkingEnabled: false,
        planMode: false,
        sshTarget: {
          serverId: "server-1",
          name: "Build host",
          host: "example.com",
          port: 2222,
          user: "ian",
          remotePath: "/srv/app",
          keyPath: "/home/ian/.ssh/id_ed25519",
          authMethod: "key",
          hostFingerprint: "SHA256:test",
        },
      });

    const conversation = useAgentTaskStore.getState().conversations.find((c) => c.id === id);

    expect(conversation?.sshTarget).toEqual({
      id: "server-1",
      name: "Build host",
      host: "example.com",
      user: "ian",
      remotePath: "/srv/app",
    });
    expect(startApiAgentSessionMock).toHaveBeenCalledWith(
      id,
      "claude-oauth",
      "claude-sonnet-4.5",
      "/srv/app",
      "Work on the remote repo",
      null,
      false,
      undefined,
      false,
      {
        host: "example.com",
        port: 2222,
        user: "ian",
        remote_path: "/srv/app",
        key_path: "/home/ian/.ssh/id_ed25519",
        auth_method: "key",
        target_id: "server-1",
        host_fingerprint: "SHA256:test",
      },
      null,
      null,
      null,
      null,
      "ask_for_risky",
      false,
      null,
      undefined,
      undefined,
    );
  });

  it("builds resume history from persisted project conversations without workspace metadata", async () => {
    const { buildConversationResumeMessages } = await import("@/stores/agentTaskStore");

    const resumeMessages = buildConversationResumeMessages([
      {
        id: "m1",
        role: "user",
        content: "Investigate the Agents pane",
        timestamp: 1,
      },
      {
        id: "m2",
        role: "assistant",
        content: "I found the provider dropdown.",
        timestamp: 2,
        toolCalls: [
          {
            id: "tool-1",
            name: "read_file",
            status: "done",
            fullContent: "src/components/agents/AgentSidebar.tsx",
          },
        ],
      },
      {
        id: "m3",
        role: "assistant",
        content: "still streaming",
        timestamp: 3,
        isStreaming: true,
      },
    ]);

    expect(resumeMessages).toEqual([
      { role: "user", content: "Investigate the Agents pane" },
      {
        role: "assistant",
        content:
          "I found the provider dropdown.\n\nTool calls:\n- read_file (done)\n  result: src/components/agents/AgentSidebar.tsx",
      },
    ]);
  });

  it("does not auto-failover when the Agents setting is disabled", async () => {
    const listeners = new Map<string, (event: { payload: unknown }) => void>();
    listenMock.mockImplementation(
      (eventName: string, callback: (event: { payload: unknown }) => void) => {
        listeners.set(eventName, callback);
        return Promise.resolve(() => {});
      },
    );

    const { useAgentSettingsStore } = await import("@/stores/agentSettingsStore");
    useAgentSettingsStore.getState().setAutoFailoverEnabled(false);

    const { useAgentTaskStore } = await import("@/stores/agentTaskStore");
    await useAgentTaskStore
      .getState()
      .createApiConversation({
        agent: "api-openai",
        projectPath: "D:/projects/example",
        model: "gpt-4o",
        initialMessage: "Build the thing",
        thinkingEnabled: false,
        planMode: false,
        sshTarget: null,
        explicitId: "conv-no-failover",
        skipBackendStart: true,
      });

    listeners.get("api-agent:error:conv-no-failover")?.({
      payload: { message: "429 rate limit exceeded" },
    });

    expect(retryLastTurnMock).not.toHaveBeenCalled();
    expect(
      useAgentTaskStore.getState().conversations.find((c) => c.id === "conv-no-failover")?.status,
    ).toBe("failed");
  });

  it("keeps auto-failover enabled by default", async () => {
    const listeners = new Map<string, (event: { payload: unknown }) => void>();
    listenMock.mockImplementation(
      (eventName: string, callback: (event: { payload: unknown }) => void) => {
        listeners.set(eventName, callback);
        return Promise.resolve(() => {});
      },
    );

    const { useAgentTaskStore } = await import("@/stores/agentTaskStore");
    await useAgentTaskStore
      .getState()
      .createApiConversation({
        agent: "api-openai",
        projectPath: "D:/projects/example",
        model: "gpt-4o",
        initialMessage: "Build the thing",
        thinkingEnabled: false,
        planMode: false,
        sshTarget: null,
        explicitId: "conv-failover",
        skipBackendStart: true,
      });

    listeners.get("api-agent:error:conv-failover")?.({
      payload: { message: "429 rate limit exceeded" },
    });

    await vi.waitFor(() =>
      expect(retryLastTurnMock).toHaveBeenCalledWith("conv-failover", "o4-mini"),
    );
  });

  it("archives and deletes workspaces without calling agent conversation detach", async () => {
    vi.doMock("@/stores/agentTaskStore", () => ({
      useAgentTaskStore: {
        getState: vi.fn(() => ({
          detachConversationsFromWorkspace: detachConversationsFromWorkspaceMock,
        })),
      },
    }));

    const { useWorkspaceStore } = await import("@/stores/workspaceStore");
    const workspace = makeWorkspace();

    useWorkspaceStore.setState({
      workspaces: [workspace],
      activeWorkspaceId: workspace.id,
      zoomedPaneId: null,
    });

    useWorkspaceStore.getState().archiveWorkspace(workspace.id);

    expect(detachConversationsFromWorkspaceMock).not.toHaveBeenCalled();
    expect(useWorkspaceStore.getState().workspaces[0]).toMatchObject({
      id: workspace.id,
      status: "archived",
    });

    useWorkspaceStore.setState({
      workspaces: [{ ...workspace, status: "active" }],
      activeWorkspaceId: workspace.id,
    });

    useWorkspaceStore.getState().deleteWorkspace(workspace.id);

    expect(detachConversationsFromWorkspaceMock).not.toHaveBeenCalled();
    expect(useWorkspaceStore.getState().workspaces).toEqual([]);
  });
});
