import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AttemptTargetSpec } from "@/lib/tauri";
import type { Attempt, Flight, Task } from "@/types/flight";
import type { ServerConfig } from "@/types/server";
import { apiAgentDoneEvent, apiAgentErrorEvent } from "@/lib/events";
import { DEFAULT_API_MODEL } from "@/lib/api-models";

type TauriListener = (event: { payload?: { message?: string; cancelled?: boolean } }) => void;

const mocks = vi.hoisted(() => ({
  launchFlightAsync: vi.fn(),
  assertCostGuardrailsAllowLaunch: vi.fn(),
  createApiConversation: vi.fn(),
  loadPersistedState: vi.fn(),
  markAttemptStatus: vi.fn(),
  cancelFlightAttempt: vi.fn().mockResolvedValue(undefined),
  validateAttemptReviewGate: vi.fn().mockResolvedValue(undefined),
  validateAttemptDelivery: vi.fn().mockResolvedValue(undefined),
  landReviewedAttempt: vi.fn(),
  pushReviewedAttempt: vi.fn().mockResolvedValue(undefined),
  beginFlightExecution: vi.fn().mockResolvedValue(undefined),
  stopFlightSessions: vi.fn().mockResolvedValue(undefined),
  resumeFlightAttempt: vi.fn(),
  failPreparedFlightAttempt: vi.fn().mockResolvedValue(undefined),
  recordAttemptDelivery: vi.fn().mockResolvedValue(undefined),
  getFlightAttemptOrigin: vi.fn().mockResolvedValue("git@github.com:owner/repo.git"),
  cancelActiveConversation: vi.fn().mockResolvedValue(undefined),
  prepareFlightIntegrationBranch: vi.fn(),
  integrateFlightAttempt: vi.fn(),
  landFlightIntegration: vi.fn(),
  mergeConversationBranch: vi.fn(),
  cleanupAttemptWorktreeSsh: vi.fn(),
  gitPushBranch: vi.fn(),
  githubCreatePr: vi.fn(),
  setAttemptDraftPr: vi.fn(),
  getServer: vi.fn(),
  selectedRepo: null as { owner: string; repo: string } | null,
  notifyAttemptCompleted: vi.fn(),
  composeMemoryBrief: vi.fn(),
  captureFlightCompleted: vi.fn(),
  adjustConfidenceForFlight: vi.fn(),
  recordInjectedPatterns: vi.fn(),
  clearInjectedPatterns: vi.fn(),
  updateFlightRetrospective: vi.fn(),
  conversations: [] as Array<{
    id: string;
    status?: string;
    messages: Array<{ role: string; content: string; isStreaming?: boolean }>;
  }>,
  listeners: new Map<string, TauriListener>(),
  listen: vi.fn(),
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: mocks.listen,
}));

vi.mock("@/lib/tauri", () => ({
  launchFlightAsync: mocks.launchFlightAsync,
  cancelFlightAttempt: mocks.cancelFlightAttempt,
  cleanupAttemptWorktreeSsh: mocks.cleanupAttemptWorktreeSsh,
  markAttemptStatus: mocks.markAttemptStatus,
  traceFlightAction: vi.fn(),
  validateAttemptReviewGate: mocks.validateAttemptReviewGate,
  validateAttemptDelivery: mocks.validateAttemptDelivery,
  landReviewedAttempt: mocks.landReviewedAttempt,
  pushReviewedAttempt: mocks.pushReviewedAttempt,
  beginFlightExecution: mocks.beginFlightExecution,
  stopFlightSessions: mocks.stopFlightSessions,
  resumeFlightAttempt: mocks.resumeFlightAttempt,
  failPreparedFlightAttempt: mocks.failPreparedFlightAttempt,
  recordAttemptDelivery: mocks.recordAttemptDelivery,
  getFlightAttemptOrigin: mocks.getFlightAttemptOrigin,
  prepareFlightIntegrationBranch: mocks.prepareFlightIntegrationBranch,
  integrateFlightAttempt: mocks.integrateFlightAttempt,
  landFlightIntegration: mocks.landFlightIntegration,
  gitHostListConnections: vi
    .fn()
    .mockResolvedValue([
      { id: "github", kind: "github", baseUrl: "https://github.com", name: "GitHub" },
    ]),
  mergeConversationBranch: mocks.mergeConversationBranch,
  gitPushBranch: mocks.gitPushBranch,
  githubCreatePr: mocks.githubCreatePr,
  setAttemptDraftPr: mocks.setAttemptDraftPr,
  loadPersistedState: mocks.loadPersistedState,
  saveFlightsSlice: vi.fn().mockResolvedValue(undefined),
  saveUiSlice: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/stores/costGuardrailStore", () => ({
  assertCostGuardrailsAllowLaunch: mocks.assertCostGuardrailsAllowLaunch,
  useCostGuardrailStore: { getState: () => ({ sessionLimitUsd: null }) },
}));

// Partial mock: only the store handle is stubbed. `apiAgentProvider` /
// `canonicalizeAgentCli` stay REAL — they are the single source of truth for
// the agent-id -> backend-provider mapping that `buildReassignSpec` and
// `launchReadyTasks` resolve through, and a stubbed one would let a wrong
// mapping pass.
vi.mock("@/stores/agentTaskStore", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/stores/agentTaskStore")>()),
  useAgentTaskStore: {
    getState: () => ({
      conversations: mocks.conversations,
      createApiConversation: mocks.createApiConversation,
      cancelActiveConversation: mocks.cancelActiveConversation,
    }),
  },
}));

vi.mock("@/lib/notifications", () => ({
  notifyAttemptCompleted: mocks.notifyAttemptCompleted,
}));

vi.mock("@/stores/serverStore", () => ({
  useServerStore: {
    getState: () => ({
      getServer: mocks.getServer,
    }),
  },
}));

vi.mock("@/stores/githubStore", () => ({
  useGitHubStore: {
    getState: () => ({
      config: { selectedRepo: mocks.selectedRepo },
    }),
  },
}));

vi.mock("@/stores/memoryStore", () => ({
  useMemoryStore: {
    getState: () => ({
      composeMemoryBrief: mocks.composeMemoryBrief,
      captureFlightCompleted: mocks.captureFlightCompleted,
      adjustConfidenceForFlight: mocks.adjustConfidenceForFlight,
      recordInjectedPatterns: mocks.recordInjectedPatterns,
      clearInjectedPatterns: mocks.clearInjectedPatterns,
      updateFlightRetrospective: mocks.updateFlightRetrospective,
    }),
  },
}));

vi.mock("@/stores/issueStore", () => ({
  useIssueStore: {
    getState: () => ({
      issues: [],
      assignToFlight: vi.fn(),
    }),
  },
}));

vi.mock("@/stores/routingStore", () => ({
  useRoutingStore: {
    getState: () => ({
      resolveForTask: vi.fn().mockReturnValue({ agentConfigId: "claude-code" }),
    }),
  },
}));

vi.mock("@/stores/workspaceStore", () => ({
  useWorkspaceStore: {
    getState: () => ({
      workspaces: [],
      createWorkspace: vi.fn().mockReturnValue("workspace-1"),
    }),
  },
}));

import {
  buildReassignSpec,
  findAsyncLaunchPathCollisions,
  useAsyncFlightStore,
} from "@/stores/asyncFlightStore";
import { useFlightStore } from "@/stores/flightStore";
import { useMemorySettingsStore } from "@/stores/memorySettingsStore";

function localTarget(basePath: string, baseBranch = "main"): AttemptTargetSpec {
  return {
    kind: "local",
    basePath,
    baseBranch,
    agentConfigId: "api-claude",
    provider: "claude",
    model: "claude-sonnet-4-6",
  };
}

function sshTarget(targetId: string, basePath: string, baseBranch = "main"): AttemptTargetSpec {
  return {
    kind: "ssh",
    targetId,
    host: "h",
    port: 22,
    user: "u",
    basePath,
    baseBranch,
    agentConfigId: "api-claude",
    provider: "claude",
    model: "claude-sonnet-4-6",
  };
}

function flight(overrides: Partial<Flight> = {}): Flight {
  return {
    id: "flight-1",
    title: "Flight",
    objective: "Do work",
    status: "active",
    priority: "medium",
    projectPath: "D:/repo",
    workspaceId: null,
    milestones: [],
    linkedSessionIds: [],
    issueIds: [],
    createdAt: 1,
    updatedAt: 1,
    totalCost: 0,
    totalTokens: 0,
    attempts: [],
    ...overrides,
  };
}

function attempt(overrides: Partial<Attempt> = {}): Attempt {
  return {
    id: "att-running",
    flightId: "flight-1",
    target: {
      kind: "local",
      basePath: "D:\\Repo",
      worktreePath: "D:\\Repo\\.git\\packetbench-worktrees\\att-running",
    },
    agentConfigId: "api-claude",
    model: "claude-sonnet-4-6",
    provider: "claude",
    branch: "packetbench/att-running",
    baseBranch: "main",
    sessionId: "att-running",
    status: "running",
    cost: 0,
    tokens: 0,
    ...overrides,
  };
}

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: "task-1",
    milestoneId: "ms-1",
    flightId: "flight-1",
    title: "Task 1",
    description: "",
    order: 0,
    status: "queued",
    type: "implementation",
    agentConfigId: "api-claude",
    dependsOn: [],
    sessionId: null,
    createdAt: 1,
    cost: 0,
    tokens: 0,
    ...overrides,
  };
}

describe("asyncFlightStore collision gate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.listeners.clear();
    mocks.conversations = [];
    mocks.launchFlightAsync.mockResolvedValue([]);
    mocks.assertCostGuardrailsAllowLaunch.mockResolvedValue(undefined);
    mocks.createApiConversation.mockResolvedValue(undefined);
    mocks.loadPersistedState.mockImplementation(async () => ({
      version: 1,
      flights: useFlightStore.getState().flights,
      agents: [],
      settings: { maxParallelSessions: 3, milestoneGating: true, projectPath: "." },
      ui: {},
    }));
    mocks.markAttemptStatus.mockResolvedValue(undefined);
    mocks.notifyAttemptCompleted.mockResolvedValue(undefined);
    mocks.composeMemoryBrief.mockReturnValue({ text: "" });
    mocks.captureFlightCompleted.mockReset();
    useMemorySettingsStore.getState().setInjectIntoFlightPrompts(true);
    mocks.listen.mockImplementation((eventName: string, callback: TauriListener) => {
      mocks.listeners.set(eventName, callback);
      return Promise.resolve(() => {
        mocks.listeners.delete(eventName);
      });
    });
    useFlightStore.setState({ flights: [], activeFlightId: null });
  });

  it("detects duplicate selected targets that claim the same root", () => {
    const collisions = findAsyncLaunchPathCollisions(
      null,
      [localTarget("D:\\Repo"), localTarget("d:/repo/src")],
      [],
    );

    expect(collisions).toHaveLength(1);
    expect(collisions[0].kind).toBe("duplicate_target");
  });

  it("blocks launch when an active attempt already claims the same path", async () => {
    useFlightStore.setState({
      flights: [
        flight({ id: "existing-flight", attempts: [attempt()] }),
        flight({ id: "new-flight" }),
      ],
      activeFlightId: null,
    });

    await expect(
      useAsyncFlightStore.getState().launchAsync("new-flight", "Do it", [localTarget("d:/repo")]),
    ).rejects.toThrow(/already running/);

    expect(mocks.launchFlightAsync).not.toHaveBeenCalled();
  });

  it("does not block completed attempts on the same path", async () => {
    useFlightStore.setState({
      flights: [
        flight({
          id: "existing-flight",
          attempts: [attempt({ status: "completed", completedAt: 2 })],
        }),
        flight({ id: "new-flight" }),
      ],
      activeFlightId: null,
    });

    await expect(
      useAsyncFlightStore.getState().launchAsync("new-flight", "Do it", [localTarget("d:/repo")]),
    ).resolves.toEqual([]);

    expect(mocks.launchFlightAsync).toHaveBeenCalledOnce();
  });

  it("blocks launch when active flight tasks already have overlapping owned paths", async () => {
    useFlightStore.setState({
      flights: [
        flight({
          milestones: [
            {
              id: "ms-1",
              flightId: "flight-1",
              title: "Milestone",
              description: "",
              order: 0,
              status: "active",
              validationCriteria: [],
              tasks: [
                task({ id: "task-1", title: "Frontend", ownedPaths: ["src/features"] }),
                task({
                  id: "task-2",
                  title: "Button",
                  status: "running",
                  ownedPaths: ["SRC\\features\\button.tsx"],
                }),
              ],
            },
          ],
        }),
      ],
      activeFlightId: null,
    });

    await expect(
      useAsyncFlightStore.getState().launchAsync("flight-1", "Do it", [localTarget("d:/repo")]),
    ).rejects.toThrow(/both claim/);

    expect(mocks.launchFlightAsync).not.toHaveBeenCalled();
  });

  it("allows an explicit collision override for serialized handoff flows", async () => {
    useFlightStore.setState({
      flights: [
        flight({ id: "existing-flight", attempts: [attempt()] }),
        flight({ id: "new-flight" }),
      ],
      activeFlightId: null,
    });

    await expect(
      useAsyncFlightStore.getState().launchAsync("new-flight", "Do it", [localTarget("d:/repo")], {
        allowPathCollisions: true,
      }),
    ).resolves.toEqual([]);

    expect(mocks.launchFlightAsync).toHaveBeenCalledOnce();
  });

  it("moves an async attempt to reviewing on api-agent:done without requiring AttemptTile to be mounted", async () => {
    const launchedAttempt = attempt({ id: "att-done", sessionId: "session-done" });
    mocks.launchFlightAsync.mockResolvedValue([launchedAttempt]);
    mocks.conversations = [
      {
        id: "session-done",
        messages: [
          {
            role: "assistant",
            content: "Finished normally, no sentinel marker here.",
            isStreaming: false,
          },
        ],
      },
    ];
    useFlightStore.setState({ flights: [flight()], activeFlightId: null });

    await useAsyncFlightStore.getState().launchAsync("flight-1", "Do it", [localTarget("d:/repo")]);
    await vi.waitFor(() => {
      expect(mocks.listeners.has(apiAgentDoneEvent("session-done"))).toBe(true);
    });

    mocks.listeners.get(apiAgentDoneEvent("session-done"))?.({ payload: {} });

    await vi.waitFor(() => {
      expect(mocks.markAttemptStatus).toHaveBeenCalledWith("flight-1", "att-done", "reviewing");
      expect(
        useFlightStore
          .getState()
          .flights.find((f) => f.id === "flight-1")
          ?.attempts?.find((a) => a.id === "att-done")?.status,
      ).toBe("reviewing");
    });
    expect(mocks.notifyAttemptCompleted).toHaveBeenCalledWith("Flight", "local");
    await vi.waitFor(() => {
      expect(mocks.listeners.has(apiAgentDoneEvent("session-done"))).toBe(false);
      expect(mocks.listeners.has(apiAgentErrorEvent("session-done"))).toBe(false);
    });
  });

  it("starts prepared attempts through an attached conversation after terminal listeners are ready", async () => {
    const prepared = attempt({
      id: "att-prepared",
      sessionId: "session-prepared",
      status: "provisioning",
    });
    mocks.launchFlightAsync.mockResolvedValueOnce([prepared]);
    useFlightStore.setState({ flights: [flight()] });
    mocks.createApiConversation.mockImplementationOnce(async (options) => {
      expect(mocks.listeners.has(apiAgentDoneEvent(prepared.sessionId))).toBe(true);
      expect(mocks.listeners.has(apiAgentErrorEvent(prepared.sessionId))).toBe(true);
      expect(useFlightStore.getState().flights[0].attempts?.[0].sessionId).toBe(prepared.sessionId);
      expect(options).toEqual(
        expect.objectContaining({
          explicitId: prepared.sessionId,
          agent: prepared.agentConfigId,
          projectPath: prepared.target.worktreePath,
          model: prepared.model,
          skipBackendStart: false,
          permissionMode: "ask_for_risky",
          enabledMcpServerIds: [],
        }),
      );
      mocks.conversations.push({ id: options.explicitId, status: "active", messages: [] });
      return options.explicitId;
    });
    await useAsyncFlightStore.getState().launchAsync("flight-1", "Do it", [localTarget("d:/repo")]);
    expect(mocks.createApiConversation).toHaveBeenCalledOnce();
    expect(mocks.failPreparedFlightAttempt).not.toHaveBeenCalled();
  });

  it("retains prepared files and surfaces frontend admission failures before provider dispatch", async () => {
    const prepared = attempt({ status: "provisioning" });
    mocks.launchFlightAsync.mockResolvedValueOnce([prepared]);
    mocks.createApiConversation.mockRejectedValueOnce(new Error("Budget admission refused"));
    useFlightStore.setState({ flights: [flight()] });
    await expect(
      useAsyncFlightStore.getState().launchAsync("flight-1", "Do it", [localTarget("d:/repo")]),
    ).rejects.toThrow("Budget admission refused");
    expect(mocks.failPreparedFlightAttempt).toHaveBeenCalledWith(
      "flight-1",
      prepared.id,
      prepared.sessionId,
      expect.stringContaining("Budget admission refused"),
    );
    expect(mocks.cancelFlightAttempt).not.toHaveBeenCalled();
  });

  it.each(["launch", "resume"] as const)(
    "uses explicit built-in-only tools for a native SSH builder %s",
    async (action) => {
      const target = {
        kind: "ssh",
        serverId: "saved-host",
        basePath: "/repo",
        worktreePath: "/repo/.pkt-worktrees/retained",
      } as const;
      const prepared = attempt({
        id: "remote-attempt",
        sessionId: `remote-${action}`,
        status: "provisioning",
        agentConfigId: "api-sugar",
        provider: "sugar",
        model: "Conduit",
        target,
      });
      mocks.getServer.mockReturnValue({
        id: "saved-host",
        name: "Saved host",
        host: "example.test",
        port: 22,
        username: "ian",
        authMethod: "key",
        keyPath: "C:/keys/id_ed25519",
        hostFingerprint: "SHA256:pinned",
      });
      if (action === "launch") {
        mocks.launchFlightAsync.mockResolvedValueOnce([prepared]);
        useFlightStore.setState({ flights: [flight()] });
        await useAsyncFlightStore.getState().launchAsync("flight-1", "Do it", [
          {
            ...sshTarget("saved-host", "/repo"),
            agentConfigId: "api-sugar",
            provider: "sugar",
            model: "Conduit",
          },
        ]);
      } else {
        const old = {
          ...prepared,
          sessionId: "old-remote",
          status: "failed" as const,
          recovery: { state: "retained" as const, reason: "Startup failed", retainedAt: 10 },
        };
        mocks.resumeFlightAttempt.mockResolvedValueOnce(prepared);
        useFlightStore.setState({ flights: [flight({ stoppedAt: 10, attempts: [old] })] });
        await useAsyncFlightStore.getState().resumeRetainedAttempt("flight-1", old.id);
      }
      expect(mocks.createApiConversation).toHaveBeenCalledWith(
        expect.objectContaining({
          explicitId: prepared.sessionId,
          agent: "api-sugar",
          model: "Conduit",
          enabledMcpServerIds: [],
          permissionMode: "ask_for_risky",
          skipBackendStart: false,
          sshTarget: expect.objectContaining({
            serverId: "saved-host",
            remotePath: target.worktreePath,
            hostFingerprint: "SHA256:pinned",
          }),
        }),
      );
    },
  );

  it("retains prepared first-launch files when terminal listeners cannot register", async () => {
    const prepared = attempt({ status: "provisioning", sessionId: "launch-listener-failure" });
    mocks.launchFlightAsync.mockResolvedValueOnce([prepared]);
    useFlightStore.setState({ flights: [flight()] });
    const normalListen = mocks.listen.getMockImplementation()!;
    mocks.listen.mockImplementation((eventName: string, callback: TauriListener) =>
      eventName.includes(prepared.sessionId)
        ? Promise.reject(new Error("First listener unavailable"))
        : normalListen(eventName, callback),
    );
    try {
      await expect(
        useAsyncFlightStore.getState().launchAsync("flight-1", "brief", [localTarget("d:/repo")]),
      ).rejects.toThrow("First listener unavailable");
      expect(mocks.failPreparedFlightAttempt).toHaveBeenCalledWith(
        "flight-1",
        prepared.id,
        prepared.sessionId,
        expect.stringContaining("First listener unavailable"),
      );
      expect(mocks.createApiConversation).not.toHaveBeenCalled();
    } finally {
      mocks.listen.mockImplementation(normalListen);
    }
  });

  it("does not leave a silently failed conversation's prepared attempt provisioning", async () => {
    const prepared = attempt({ status: "provisioning" });
    mocks.launchFlightAsync.mockResolvedValueOnce([prepared]);
    mocks.createApiConversation.mockImplementationOnce(async () => {
      mocks.conversations.push({ id: prepared.sessionId, status: "failed", messages: [] });
      return prepared.sessionId;
    });
    useFlightStore.setState({ flights: [flight()] });
    await expect(
      useAsyncFlightStore.getState().launchAsync("flight-1", "Do it", [localTarget("d:/repo")]),
    ).rejects.toThrow("could not start");
    expect(mocks.failPreparedFlightAttempt).toHaveBeenCalledOnce();
  });

  it("never promotes a cancelled done event to review", async () => {
    const value = attempt({ sessionId: "cancelled-done" });
    useFlightStore.setState({ flights: [flight({ attempts: [value] })] });
    await vi.waitFor(() =>
      expect(mocks.listeners.has(apiAgentDoneEvent(value.sessionId))).toBe(true),
    );
    mocks.listeners.get(apiAgentDoneEvent(value.sessionId))?.({ payload: { cancelled: true } });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(mocks.markAttemptStatus).not.toHaveBeenCalled();
    expect(mocks.notifyAttemptCompleted).not.toHaveBeenCalled();
  });

  it("projects native retained cancellation from ordinary builder chat Stop", async () => {
    const value = attempt({ sessionId: "chat-stop" });
    useFlightStore.setState({ flights: [flight({ attempts: [value] })] });
    mocks.loadPersistedState.mockResolvedValueOnce({
      flights: [
        flight({
          attempts: [
            {
              ...value,
              status: "cancelled",
              completedAt: 10,
              recovery: { state: "retained", reason: "Builder stopped", retainedAt: 10 },
            },
          ],
        }),
      ],
    });
    await vi.waitFor(() =>
      expect(mocks.listeners.has(apiAgentDoneEvent(value.sessionId))).toBe(true),
    );
    mocks.listeners.get(apiAgentDoneEvent(value.sessionId))?.({ payload: { cancelled: true } });
    await vi.waitFor(() =>
      expect(useFlightStore.getState().flights[0].attempts?.[0].status).toBe("cancelled"),
    );
    expect(useFlightStore.getState().flights[0].attempts?.[0].recovery?.state).toBe("retained");
    expect(mocks.markAttemptStatus).not.toHaveBeenCalled();
    expect(mocks.cancelFlightAttempt).not.toHaveBeenCalled();
    expect(mocks.notifyAttemptCompleted).not.toHaveBeenCalled();
  });

  it("does not let a delayed cancellation read replace a resumed builder", async () => {
    const value = attempt({ sessionId: "chat-stop-old" });
    let finish!: (value: unknown) => void;
    mocks.loadPersistedState.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    useFlightStore.setState({ flights: [flight({ attempts: [value] })] });
    await vi.waitFor(() =>
      expect(mocks.listeners.has(apiAgentDoneEvent(value.sessionId))).toBe(true),
    );
    mocks.listeners.get(apiAgentDoneEvent(value.sessionId))?.({ payload: { cancelled: true } });
    await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
    useFlightStore.setState({
      flights: [flight({ attempts: [{ ...value, sessionId: "resumed-builder" }] })],
    });
    finish({ flights: [flight({ attempts: [{ ...value, status: "cancelled" }] })] });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(useFlightStore.getState().flights[0].attempts?.[0]).toMatchObject({
      sessionId: "resumed-builder",
      status: "running",
    });
    expect(mocks.markAttemptStatus).not.toHaveBeenCalled();
  });

  it("ignores captured old-session completion after Stop or retained resume", async () => {
    const value = attempt({ sessionId: "stale-done" });
    useFlightStore.setState({ flights: [flight({ attempts: [value] })] });
    await vi.waitFor(() =>
      expect(mocks.listeners.has(apiAgentDoneEvent(value.sessionId))).toBe(true),
    );
    const done = mocks.listeners.get(apiAgentDoneEvent(value.sessionId))!;
    useFlightStore.setState({ flights: [flight({ stoppedAt: 10, attempts: [value] })] });
    done({ payload: {} });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(mocks.markAttemptStatus).not.toHaveBeenCalled();
    useFlightStore.setState({
      flights: [flight({ attempts: [{ ...value, sessionId: "new-builder" }] })],
    });
    done({ payload: {} });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(mocks.markAttemptStatus).not.toHaveBeenCalled();
  });

  it("does not project a review completion when Stop wins during its native write", async () => {
    const value = attempt({ sessionId: "stop-during-done" });
    let finish!: () => void;
    mocks.markAttemptStatus.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    useFlightStore.setState({ flights: [flight({ attempts: [value] })] });
    await vi.waitFor(() =>
      expect(mocks.listeners.has(apiAgentDoneEvent(value.sessionId))).toBe(true),
    );
    mocks.listeners.get(apiAgentDoneEvent(value.sessionId))?.({ payload: {} });
    await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
    useFlightStore.setState({
      flights: [flight({ stoppedAt: 10, attempts: [{ ...value, status: "cancelled" }] })],
    });
    finish();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(useFlightStore.getState().flights[0].attempts?.[0].status).toBe("cancelled");
    expect(mocks.notifyAttemptCompleted).not.toHaveBeenCalled();
  });

  it("hydrates retained recovery immediately on api-agent:error without UI mount", async () => {
    const launchedAttempt = attempt({ id: "att-error", sessionId: "session-error" });
    mocks.launchFlightAsync.mockResolvedValue([launchedAttempt]);
    useFlightStore.setState({ flights: [flight()], activeFlightId: null });

    await useAsyncFlightStore.getState().launchAsync("flight-1", "Do it", [localTarget("d:/repo")]);
    await vi.waitFor(() => {
      expect(mocks.listeners.has(apiAgentErrorEvent("session-error"))).toBe(true);
    });
    const recovery: NonNullable<Attempt["recovery"]> = {
      state: "retained",
      retainedAt: 123,
      reason: "Provider failed; worktree retained",
    };
    mocks.loadPersistedState.mockResolvedValueOnce({
      flights: [
        flight({
          attempts: [{ ...launchedAttempt, status: "failed", completedAt: 123, recovery }],
        }),
      ],
      ui: {},
    });

    mocks.listeners.get(apiAgentErrorEvent("session-error"))?.({
      payload: { message: "sidecar disconnected" },
    });

    await vi.waitFor(() => {
      expect(mocks.markAttemptStatus).toHaveBeenCalledWith("flight-1", "att-error", "failed");
      const current = useFlightStore
        .getState()
        .flights.find((f) => f.id === "flight-1")
        ?.attempts?.find((a) => a.id === "att-error");
      expect(current?.status).toBe("failed");
      expect(current?.errorMessage).toBe("sidecar disconnected");
      expect(current?.recovery).toEqual(recovery);
      expect(current?.target).toEqual(launchedAttempt.target);
      expect(mocks.cleanupAttemptWorktreeSsh).not.toHaveBeenCalled();
    });
  });

  it("does not let delayed failure hydration replace a resumed builder", async () => {
    const value = attempt({ id: "failed-old-owner", sessionId: "old-error-owner" });
    useFlightStore.setState({ flights: [flight({ attempts: [value] })] });
    await vi.waitFor(() =>
      expect(mocks.listeners.has(apiAgentErrorEvent(value.sessionId))).toBe(true),
    );
    let finish!: (snapshot: unknown) => void;
    mocks.loadPersistedState.mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    mocks.listeners.get(apiAgentErrorEvent(value.sessionId))?.({
      payload: { message: "old provider failed" },
    });
    await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
    const resumed = { ...value, sessionId: "new-error-owner", status: "running" as const };
    useFlightStore.setState({ flights: [flight({ attempts: [resumed] })] });
    finish({
      flights: [
        flight({
          attempts: [
            {
              ...value,
              status: "failed",
              recovery: { state: "retained", retainedAt: 1, reason: "old failure" },
            },
          ],
        }),
      ],
      ui: {},
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(useFlightStore.getState().flights[0].attempts?.[0]).toEqual(resumed);
  });

  it("preserves a backend fast-start failure returned by launchFlightAsync", async () => {
    const failedAttempt = attempt({
      id: "att-fast-fail",
      sessionId: "session-fast-fail",
      status: "failed",
      errorMessage: "Session start failed: sidecar unavailable",
      completedAt: 2,
    });
    mocks.launchFlightAsync.mockResolvedValue([failedAttempt]);
    useFlightStore.setState({ flights: [flight()], activeFlightId: null });

    await useAsyncFlightStore.getState().launchAsync("flight-1", "Do it", [localTarget("d:/repo")]);

    const current = useFlightStore
      .getState()
      .flights.find((f) => f.id === "flight-1")
      ?.attempts?.find((a) => a.id === "att-fast-fail");
    expect(current?.status).toBe("failed");
    expect(current?.errorMessage).toBe("Session start failed: sidecar unavailable");
    expect(mocks.createApiConversation).not.toHaveBeenCalled();
    expect(mocks.listeners.has(apiAgentDoneEvent("session-fast-fail"))).toBe(false);
    expect(mocks.listeners.has(apiAgentErrorEvent("session-fast-fail"))).toBe(false);
  });

  it("rehydrates and attaches earlier attempts when a later target fails to provision", async () => {
    const partialAttempt = attempt({ id: "att-partial", sessionId: "session-partial" });
    mocks.launchFlightAsync.mockRejectedValueOnce(new Error("target 2 provisioning failed"));
    mocks.loadPersistedState.mockResolvedValueOnce({
      version: 1,
      flights: [flight({ attempts: [partialAttempt] })],
      agents: [],
      settings: { maxParallelSessions: 3, milestoneGating: true, projectPath: "." },
      ui: {},
    });
    useFlightStore.setState({ flights: [flight()], activeFlightId: null });

    await expect(
      useAsyncFlightStore
        .getState()
        .launchAsync("flight-1", "Do it", [localTarget("d:/repo"), localTarget("e:/repo")]),
    ).rejects.toThrow("target 2 provisioning failed");

    expect(
      useFlightStore
        .getState()
        .flights[0]?.attempts?.some((current) => current.id === "att-partial"),
    ).toBe(true);
    expect(mocks.createApiConversation).toHaveBeenCalledWith(
      expect.objectContaining({
        explicitId: "session-partial",
        skipBackendStart: true,
      }),
    );
  });

  it("starts prepared partial successes after a later target fails, with listeners already registered", async () => {
    const partial = attempt({
      id: "partial-prepared",
      sessionId: "partial-session",
      status: "provisioning",
    });
    mocks.launchFlightAsync.mockRejectedValueOnce(new Error("second target failed"));
    mocks.loadPersistedState.mockResolvedValueOnce({
      flights: [flight({ attempts: [partial] })],
      ui: {},
    });
    mocks.createApiConversation.mockImplementationOnce(async (options) => {
      expect(mocks.listeners.has(apiAgentDoneEvent(partial.sessionId))).toBe(true);
      expect(options.skipBackendStart).toBe(false);
    });
    useFlightStore.setState({ flights: [flight()] });
    await expect(
      useAsyncFlightStore
        .getState()
        .launchAsync("flight-1", "brief", [localTarget("d:/repo"), localTarget("e:/repo")]),
    ).rejects.toThrow("second target failed");
    expect(mocks.createApiConversation).toHaveBeenCalledOnce();
  });

  it("refuses to start a prepared SSH attempt as a local conversation when its saved server is missing", async () => {
    const prepared = attempt({
      status: "provisioning",
      target: { kind: "ssh", serverId: "gone", basePath: "/repo", worktreePath: "/repo/retained" },
    });
    mocks.launchFlightAsync.mockResolvedValueOnce([prepared]);
    mocks.getServer.mockReturnValueOnce(undefined);
    useFlightStore.setState({ flights: [flight()] });
    await expect(
      useAsyncFlightStore.getState().launchAsync("flight-1", "brief", [sshTarget("gone", "/repo")]),
    ).rejects.toThrow("saved SSH server");
    expect(mocks.createApiConversation).not.toHaveBeenCalled();
    expect(mocks.failPreparedFlightAttempt).toHaveBeenCalledOnce();
  });

  it("uses the refreshed backend terminal status when an attempt finishes before listeners are ready", async () => {
    const optimisticAttempt = attempt({
      id: "att-instant-done",
      sessionId: "session-instant-done",
      status: "running",
    });
    const persistedAttempt = {
      ...optimisticAttempt,
      status: "reviewing" as const,
    };
    mocks.launchFlightAsync.mockResolvedValue([optimisticAttempt]);
    mocks.loadPersistedState.mockResolvedValue({
      version: 1,
      flights: [flight({ attempts: [persistedAttempt] })],
      agents: [],
      settings: { maxParallelSessions: 3, milestoneGating: true, projectPath: "." },
      ui: {},
    });
    useFlightStore.setState({ flights: [flight()], activeFlightId: null });

    await useAsyncFlightStore.getState().launchAsync("flight-1", "Do it", [localTarget("d:/repo")]);

    const current = useFlightStore
      .getState()
      .flights.find((f) => f.id === "flight-1")
      ?.attempts?.find((a) => a.id === "att-instant-done");
    expect(current?.status).toBe("reviewing");
    expect(mocks.markAttemptStatus).not.toHaveBeenCalledWith(
      "flight-1",
      "att-instant-done",
      "reviewing",
    );
  });

  it("registers terminal listeners for backend-hydrated active attempts", async () => {
    const hydratedAttempt = attempt({
      id: "att-hydrated",
      sessionId: "session-hydrated",
      status: "running",
    });

    useFlightStore.setState({
      flights: [flight({ attempts: [hydratedAttempt] })],
      activeFlightId: "flight-1",
    });

    await vi.waitFor(() => {
      expect(mocks.listeners.has(apiAgentDoneEvent("session-hydrated"))).toBe(true);
      expect(mocks.listeners.has(apiAgentErrorEvent("session-hydrated"))).toBe(true);
    });
  });

  it("handles sentinel completions at store level without double notification", async () => {
    const launchedAttempt = attempt({ id: "att-sentinel", sessionId: "session-sentinel" });
    mocks.launchFlightAsync.mockResolvedValue([launchedAttempt]);
    mocks.conversations = [
      {
        id: "session-sentinel",
        messages: [
          {
            role: "assistant",
            content: "Work complete. <PACKETCODE_DONE>",
            isStreaming: true,
          },
        ],
      },
    ];
    useFlightStore.setState({ flights: [flight()], activeFlightId: null });

    await useAsyncFlightStore.getState().launchAsync("flight-1", "Do it", [localTarget("d:/repo")]);
    await vi.waitFor(() => {
      expect(mocks.listeners.has(apiAgentDoneEvent("session-sentinel"))).toBe(true);
    });

    mocks.listeners.get(apiAgentDoneEvent("session-sentinel"))?.({ payload: {} });

    await vi.waitFor(() => {
      expect(mocks.markAttemptStatus).toHaveBeenCalledWith("flight-1", "att-sentinel", "reviewing");
    });
    expect(mocks.notifyAttemptCompleted).toHaveBeenCalledTimes(1);
  });
});

describe("asyncFlightStore terminal cleanup and publishing", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.markAttemptStatus.mockResolvedValue(undefined);
    mocks.validateAttemptReviewGate.mockReset().mockResolvedValue(undefined);
    mocks.validateAttemptDelivery.mockReset().mockResolvedValue(undefined);
    mocks.landReviewedAttempt.mockReset().mockResolvedValue({
      nothingToLand: false,
      commitSha: "reviewed-commit",
      branchDeleted: false,
    });
    mocks.pushReviewedAttempt.mockReset().mockResolvedValue(undefined);
    mocks.cleanupAttemptWorktreeSsh.mockResolvedValue(undefined);
    mocks.gitPushBranch.mockResolvedValue(undefined);
    mocks.githubCreatePr.mockResolvedValue(JSON.stringify({ number: 42 }));
    mocks.setAttemptDraftPr.mockResolvedValue(undefined);
    mocks.selectedRepo = null;
    mocks.getServer.mockReturnValue(undefined);
    useFlightStore.setState({ flights: [], activeFlightId: null });
  });

  it("rehydrates a stale review error before integration, publication or cleanup", async () => {
    const value = flight({
      publishAttemptsAsPrs: true,
      reviewGatePolicy: {
        enabled: true,
        reviewerAgentConfigId: "api-openai",
        acceptanceCriteria: ["Tests pass"],
      },
      attempts: [attempt({ status: "reviewing", reviewGate: { status: "passed" } })],
    });
    useFlightStore.setState({ flights: [value], activeFlightId: null });
    mocks.validateAttemptReviewGate.mockRejectedValueOnce(
      new Error("Review is stale. Retry review."),
    );
    mocks.loadPersistedState.mockResolvedValueOnce({
      flights: [
        {
          ...value,
          attempts: [
            attempt({
              status: "reviewing",
              reviewGate: { status: "error", errorMessage: "Review is stale. Retry review." },
            }),
          ],
        },
      ],
      ui: {},
    });

    await expect(
      useAsyncFlightStore.getState().setAttemptStatus("flight-1", "att-running", "completed"),
    ).rejects.toThrow("Review is stale");
    expect(mocks.validateAttemptReviewGate).toHaveBeenCalledWith("flight-1", "att-running");
    expect(mocks.markAttemptStatus).not.toHaveBeenCalled();
    expect(mocks.gitPushBranch).not.toHaveBeenCalled();
    expect(mocks.cleanupAttemptWorktreeSsh).not.toHaveBeenCalled();
    expect(useFlightStore.getState().flights[0].attempts![0].reviewGate!.status).toBe("error");
  });

  it("publishes a completed local attempt before Rust removes its worktree", async () => {
    mocks.selectedRepo = { owner: "packetloss404", repo: "PacketBench" };
    useFlightStore.setState({
      flights: [
        flight({
          publishAttemptsAsPrs: true,
          attempts: [attempt({ status: "reviewing" })],
        }),
      ],
      activeFlightId: null,
    });

    await useAsyncFlightStore.getState().setAttemptStatus("flight-1", "att-running", "completed");

    expect(mocks.pushReviewedAttempt).toHaveBeenCalledWith(
      "flight-1",
      "att-running",
      "git@github.com:owner/repo.git",
    );
    expect(mocks.setAttemptDraftPr).toHaveBeenCalledWith(
      "flight-1",
      "att-running",
      42,
      expect.objectContaining({ kind: "pull_request", prNumber: 42 }),
    );
    expect(mocks.pushReviewedAttempt.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.markAttemptStatus.mock.invocationCallOrder[0],
    );
    expect(mocks.setAttemptDraftPr.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.markAttemptStatus.mock.invocationCallOrder[0],
    );
  });

  it.each(["land", "publish"])(
    "refuses to %s a retained branch that changed after acceptance",
    async (action) => {
      const value = flight({
        reviewGatePolicy: {
          enabled: true,
          reviewerAgentConfigId: "api-openai",
          acceptanceCriteria: [],
        },
        attempts: [attempt({ status: "completed", reviewGate: { status: "passed" } })],
      });
      useFlightStore.setState({ flights: [value], activeFlightId: null });
      mocks.validateAttemptDelivery.mockRejectedValueOnce(
        new Error("The accepted branch changed."),
      );
      mocks.loadPersistedState.mockResolvedValueOnce({ flights: [value], ui: {} });
      const call =
        action === "land"
          ? useAsyncFlightStore.getState().landAttempt
          : useAsyncFlightStore.getState().publishAttemptPr;
      await expect(call("flight-1", "att-running")).rejects.toThrow("accepted branch changed");
      expect(mocks.validateAttemptDelivery).toHaveBeenCalledWith("flight-1", "att-running");
      expect(mocks.mergeConversationBranch).not.toHaveBeenCalled();
      expect(mocks.landReviewedAttempt).not.toHaveBeenCalled();
      expect(mocks.pushReviewedAttempt).not.toHaveBeenCalled();
      expect(mocks.gitPushBranch).not.toHaveBeenCalled();
      expect(mocks.githubCreatePr).not.toHaveBeenCalled();
    },
  );

  it.each(["land", "publish"])("uses immutable backend delivery for a gated %s", async (action) => {
    mocks.selectedRepo = { owner: "owner", repo: "repo" };
    useFlightStore.setState({
      flights: [
        flight({
          reviewGatePolicy: {
            enabled: true,
            reviewerAgentConfigId: "api-openai",
            acceptanceCriteria: [],
          },
          attempts: [attempt({ status: "completed", reviewGate: { status: "passed" } })],
        }),
      ],
      activeFlightId: null,
    });
    if (action === "land") {
      await useAsyncFlightStore.getState().landAttempt("flight-1", "att-running");
      expect(mocks.landReviewedAttempt).toHaveBeenCalledWith("flight-1", "att-running", true);
    } else {
      await useAsyncFlightStore.getState().publishAttemptPr("flight-1", "att-running");
      expect(mocks.pushReviewedAttempt).toHaveBeenCalledWith(
        "flight-1",
        "att-running",
        "git@github.com:owner/repo.git",
      );
      expect(mocks.githubCreatePr).toHaveBeenCalledOnce();
    }
    expect(mocks.mergeConversationBranch).not.toHaveBeenCalled();
    expect(mocks.gitPushBranch).not.toHaveBeenCalled();
  });

  it("keeps an opened PR identity and retries only its delivery record", async () => {
    useFlightStore.setState({
      flights: [flight({ attempts: [attempt({ status: "completed" })] })],
    });
    mocks.setAttemptDraftPr.mockRejectedValueOnce(new Error("disk busy"));
    await expect(
      useAsyncFlightStore.getState().publishAttemptPr("flight-1", "att-running"),
    ).rejects.toThrow("PR #42 was opened");
    expect(useFlightStore.getState().flights[0].attempts![0].draftPrNumber).toBe(42);
    expect(useFlightStore.getState().computeFlightStatus("flight-1")).toBe("review");
    await useAsyncFlightStore.getState().publishAttemptPr("flight-1", "att-running");
    expect(mocks.githubCreatePr).toHaveBeenCalledTimes(1);
    expect(mocks.recordAttemptDelivery).toHaveBeenCalledWith(
      "flight-1",
      "att-running",
      expect.objectContaining({ kind: "pull_request", prNumber: 42 }),
    );
    expect(useFlightStore.getState().computeFlightStatus("flight-1")).toBe("done");
  });

  it("uses the registered push origin instead of the selected GitHub repository", async () => {
    mocks.selectedRepo = { owner: "wrong", repo: "unrelated" };
    useFlightStore.setState({
      flights: [flight({ attempts: [attempt({ status: "completed" })] })],
    });
    await useAsyncFlightStore.getState().publishAttemptPr("flight-1", "att-running");
    expect(mocks.getFlightAttemptOrigin).toHaveBeenCalledWith("flight-1", "att-running");
    expect(mocks.githubCreatePr).toHaveBeenCalledWith(
      "owner",
      "repo",
      expect.any(String),
      expect.any(String),
      "packetbench/att-running",
      "main",
      true,
      "github",
    );
  });

  it("never records a delivery when a merge reports nothing to land", async () => {
    mocks.landReviewedAttempt.mockResolvedValueOnce({ nothingToLand: true });
    useFlightStore.setState({
      flights: [flight({ attempts: [attempt({ status: "completed" })] })],
    });
    await useAsyncFlightStore.getState().landAttempt("flight-1", "att-running");
    expect(useFlightStore.getState().flights[0].delivery).toBeUndefined();
    expect(useFlightStore.getState().computeFlightStatus("flight-1")).toBe("review");
  });

  it("keeps a legacy per-attempt PR flag from delivering a partial cooperative graph", async () => {
    const a = attempt({ status: "reviewing", taskId: "task-1" });
    const value = flight({
      executionMode: "cooperative",
      publishAttemptsAsPrs: true,
      attempts: [a],
      integrationBranch: {
        branch: "integration",
        baseBranch: "main",
        baseSha: "base",
        headSha: "before",
        worktreePath: "D:/integration",
        status: "ready",
        targetKind: "local",
        conflictFiles: [],
      },
      milestones: [
        {
          id: "ms-1",
          flightId: "flight-1",
          title: "Scope",
          description: "",
          order: 0,
          status: "active",
          validationCriteria: [],
          tasks: [
            task({ status: "running", ownedPaths: ["src/a"] }),
            task({ id: "task-2", status: "pending", dependsOn: ["task-1"], ownedPaths: ["src/b"] }),
          ],
        },
      ],
    });
    mocks.integrateFlightAttempt.mockResolvedValueOnce({
      headSha: "integrated",
      conflictFiles: [],
    });
    useFlightStore.setState({ flights: [value] });
    await useAsyncFlightStore.getState().setAttemptStatus(value.id, a.id, "completed");
    const after = useFlightStore.getState().flights[0];
    expect(after.delivery).toBeUndefined();
    expect(after.milestones[0].tasks[0].status).toBe("done");
    expect(useFlightStore.getState().computeFlightStatus(value.id)).toBe("active");
    expect(mocks.githubCreatePr).not.toHaveBeenCalled();
  });

  it("publishes an ungated accepted SSH result by exact attempt refspec", async () => {
    const remote = attempt({
      status: "completed",
      target: {
        kind: "ssh",
        serverId: "saved-host",
        basePath: "/srv/repo",
        worktreePath: "/srv/worktree",
      },
    });
    useFlightStore.setState({ flights: [flight({ attempts: [remote] })] });
    await useAsyncFlightStore.getState().publishAttemptPr("flight-1", remote.id);
    expect(mocks.pushReviewedAttempt).toHaveBeenCalledWith(
      "flight-1",
      remote.id,
      "git@github.com:owner/repo.git",
    );
    expect(mocks.gitPushBranch).not.toHaveBeenCalled();
    expect(useFlightStore.getState().flights[0].delivery?.branch).toBe(remote.branch);
  });

  it("leaves clean-only SSH acceptance cleanup under native ownership", async () => {
    mocks.getServer.mockReturnValue({
      id: "server-1",
      host: "example.test",
      port: 22,
      username: "ian",
      keyPath: "C:/keys/id_ed25519",
      hostFingerprint: "SHA256:test",
    });
    const sshAttempt = attempt({
      status: "reviewing",
      target: {
        kind: "ssh",
        serverId: "server-1",
        basePath: "/srv/repo",
        worktreePath: "/srv/repo/.packetbench-worktrees/att-running",
      },
    });
    useFlightStore.setState({
      flights: [flight({ attempts: [sshAttempt] })],
      activeFlightId: null,
    });

    await useAsyncFlightStore.getState().setAttemptStatus("flight-1", "att-running", "completed");

    expect(mocks.markAttemptStatus).toHaveBeenCalledWith("flight-1", "att-running", "completed");
    expect(mocks.cleanupAttemptWorktreeSsh).not.toHaveBeenCalled();
  });

  it("hydrates native Failed + Retained when acceptance rejects after a cleanup-drain failure", async () => {
    const reviewing = attempt({ status: "reviewing" });
    useFlightStore.setState({ flights: [flight({ attempts: [reviewing] })], activeFlightId: null });
    const originalError = new Error("Acceptance could not confirm session cleanup");
    const retained: Attempt = {
      ...reviewing,
      status: "failed",
      completedAt: 123,
      errorMessage: originalError.message,
      recovery: { state: "retained", retainedAt: 123, reason: originalError.message },
    };
    mocks.markAttemptStatus.mockRejectedValueOnce(originalError);
    mocks.loadPersistedState.mockResolvedValueOnce({
      flights: [flight({ attempts: [retained] })],
      ui: {},
    });

    await expect(
      useAsyncFlightStore.getState().setAttemptStatus("flight-1", reviewing.id, "completed"),
    ).rejects.toBe(originalError);

    expect(useFlightStore.getState().flights[0].attempts?.[0]).toMatchObject(retained);
    expect(mocks.cleanupAttemptWorktreeSsh).not.toHaveBeenCalled();
    expect(mocks.cancelFlightAttempt).not.toHaveBeenCalled();
  });

  it("preserves the original status error when the recovery refresh also rejects", async () => {
    const reviewing = attempt({ status: "reviewing" });
    useFlightStore.setState({ flights: [flight({ attempts: [reviewing] })], activeFlightId: null });
    const originalError = new Error("Native session cleanup failed");
    const hydrationError = new Error("Native state could not be read");
    mocks.markAttemptStatus.mockRejectedValueOnce(originalError);
    const hydration = vi
      .spyOn(useFlightStore.getState(), "hydrateFromBackend")
      .mockRejectedValueOnce(hydrationError);
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await expect(
        useAsyncFlightStore.getState().setAttemptStatus("flight-1", reviewing.id, "completed"),
      ).rejects.toBe(originalError);
      expect(warning).toHaveBeenCalledWith(
        "[attempt status] recovery refresh failed",
        reviewing.id,
        hydrationError,
      );
      expect(useFlightStore.getState().flights[0].attempts?.[0].status).toBe("reviewing");
      expect(mocks.cleanupAttemptWorktreeSsh).not.toHaveBeenCalled();
    } finally {
      warning.mockRestore();
      hydration.mockRestore();
    }
  });

  it.each(["failed", "cancelled"] as const)(
    "preserves native retained SSH work after marking an attempt %s",
    async (status) => {
      const sshAttempt = attempt({
        status: "reviewing",
        target: {
          kind: "ssh",
          serverId: "server-1",
          basePath: "/srv/repo",
          worktreePath: "/srv/repo/.packetbench-worktrees/att-running",
        },
      });
      mocks.getServer.mockReturnValue({
        id: "server-1",
        host: "example.test",
        port: 22,
        username: "ian",
        hostFingerprint: "SHA256:test",
      });
      useFlightStore.setState({
        flights: [flight({ attempts: [sshAttempt] })],
        activeFlightId: null,
      });
      const retained: Attempt = {
        ...sshAttempt,
        status,
        recovery: {
          state: "retained",
          retainedAt: 123,
          reason: "Interrupted; branch and worktree retained",
        },
      };
      mocks.markAttemptStatus.mockResolvedValueOnce(null);
      mocks.loadPersistedState.mockResolvedValueOnce({
        flights: [flight({ attempts: [retained] })],
        ui: {},
      });

      await useAsyncFlightStore.getState().setAttemptStatus("flight-1", "att-running", status);

      expect(mocks.markAttemptStatus).toHaveBeenCalledWith("flight-1", "att-running", status);
      expect(mocks.cleanupAttemptWorktreeSsh).not.toHaveBeenCalled();
      expect(mocks.cancelFlightAttempt).not.toHaveBeenCalled();
      expect(useFlightStore.getState().flights[0].attempts?.[0]).toMatchObject({
        status,
        branch: sshAttempt.branch,
        target: sshAttempt.target,
        recovery: retained.recovery,
      });
    },
  );
});

describe("Flight stop and retained-work continuation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.beginFlightExecution.mockReset().mockResolvedValue(undefined);
    mocks.stopFlightSessions.mockReset().mockResolvedValue(undefined);
    mocks.assertCostGuardrailsAllowLaunch.mockReset().mockResolvedValue(undefined);
    mocks.launchFlightAsync.mockReset().mockResolvedValue([]);
    mocks.loadPersistedState.mockImplementation(async () => ({
      flights: useFlightStore.getState().flights,
      ui: {},
    }));
    mocks.conversations = [];
    useFlightStore.setState({ flights: [flight()] });
  });

  it("drains a pending admission and never starts it after Stop", async () => {
    let allow!: () => void;
    mocks.assertCostGuardrailsAllowLaunch.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          allow = resolve;
        }),
    );
    const launch = useAsyncFlightStore
      .getState()
      .launchAsync("flight-1", "brief", [localTarget("D:/repo")], { explicitResume: true });
    const rejected = expect(launch).rejects.toThrow("stopped");
    await vi.waitFor(() => expect(allow).toBeTypeOf("function"));
    let finished = false;
    const stop = useAsyncFlightStore
      .getState()
      .stopFlight("flight-1")
      .then(() => {
        finished = true;
      });
    await vi.waitFor(() => expect(mocks.stopFlightSessions).toHaveBeenCalled());
    expect(finished).toBe(false);
    allow();
    await Promise.all([stop, rejected]);
    expect(mocks.launchFlightAsync).not.toHaveBeenCalled();
    expect(mocks.cancelFlightAttempt).not.toHaveBeenCalled();
  });

  it("cancels every owned conversation, preserving unrelated linked references", async () => {
    const value = flight({
      planningConversationId: "planner",
      linkedSessionIds: ["unrelated"],
      attempts: [
        attempt({
          sessionId: "builder",
          sessionHistory: [{ sessionId: "old-builder", provider: "openai", model: "m" }],
          reviewGate: {
            status: "running",
            reviewerConversationId: "reviewer",
            reviewerSessions: [{ sessionId: "old-reviewer", provider: "openai", model: "m" }],
          },
        }),
      ],
    });
    useFlightStore.setState({ flights: [value] });
    const ids = ["builder", "old-builder", "reviewer", "old-reviewer", "planner", "unrelated"];
    mocks.conversations = ids.map((id) => ({ id, status: "active", messages: [] }));
    await useAsyncFlightStore.getState().stopFlight(value.id);
    expect(mocks.cancelActiveConversation.mock.calls.map(([id]) => id).sort()).toEqual(
      ids.filter((id) => id !== "unrelated").sort(),
    );
    expect(mocks.cancelFlightAttempt).not.toHaveBeenCalled();
  });

  it("resumes the same retained worktree with fresh session ownership", async () => {
    const old = attempt({
      status: "cancelled",
      recovery: { state: "retained", reason: "Interrupted", retainedAt: 10 },
    });
    const resumed = {
      ...old,
      status: "provisioning",
      sessionId: "resumed-session",
      recovery: undefined,
    } as Attempt;
    useFlightStore.setState({ flights: [flight({ stoppedAt: 10, attempts: [old] })] });
    mocks.resumeFlightAttempt.mockResolvedValueOnce(resumed);
    mocks.createApiConversation.mockImplementationOnce(async () => {
      expect(mocks.listeners.has(apiAgentDoneEvent(resumed.sessionId))).toBe(true);
      expect(mocks.listeners.has(apiAgentErrorEvent(resumed.sessionId))).toBe(true);
      expect(useFlightStore.getState().flights[0].attempts?.[0].sessionId).toBe("resumed-session");
    });
    await useAsyncFlightStore.getState().resumeRetainedAttempt("flight-1", old.id);
    expect(mocks.beginFlightExecution).not.toHaveBeenCalled();
    expect(mocks.resumeFlightAttempt).toHaveBeenCalledWith("flight-1", old.id, 10);
    expect(mocks.createApiConversation).toHaveBeenCalledWith(
      expect.objectContaining({
        explicitId: "resumed-session",
        projectPath: old.target.worktreePath,
        skipBackendStart: false,
        initialMessage: "Do work",
        enabledMcpServerIds: [],
      }),
    );
    expect(mocks.launchFlightAsync).not.toHaveBeenCalled();
  });

  it("waits for an in-flight resumed terminal-listener registration before starting the new provider", async () => {
    const old = attempt({
      status: "cancelled",
      recovery: { state: "retained", reason: "Interrupted", retainedAt: 10 },
    });
    const resumed = {
      ...old,
      status: "provisioning",
      sessionId: "resume-await-listeners",
      recovery: undefined,
    } as Attempt;
    let listenersReady!: () => void;
    const registration = new Promise<void>((resolve) => {
      listenersReady = resolve;
    });
    mocks.listen.mockImplementation((eventName: string, callback: TauriListener) => {
      mocks.listeners.set(eventName, callback);
      return eventName.includes(resumed.sessionId)
        ? registration.then(() => () => mocks.listeners.delete(eventName))
        : Promise.resolve(() => mocks.listeners.delete(eventName));
    });
    mocks.resumeFlightAttempt.mockResolvedValueOnce(resumed);
    useFlightStore.setState({ flights: [flight({ stoppedAt: 10, attempts: [old] })] });
    const resume = useAsyncFlightStore.getState().resumeRetainedAttempt("flight-1", old.id);
    await vi.waitFor(() =>
      expect(mocks.listeners.has(apiAgentDoneEvent(resumed.sessionId))).toBe(true),
    );
    expect(mocks.createApiConversation).not.toHaveBeenCalled();
    listenersReady();
    await resume;
    expect(mocks.createApiConversation).toHaveBeenCalledWith(
      expect.objectContaining({ explicitId: resumed.sessionId, skipBackendStart: false }),
    );
    mocks.listen.mockImplementation((eventName: string, callback: TauriListener) => {
      mocks.listeners.set(eventName, callback);
      return Promise.resolve(() => mocks.listeners.delete(eventName));
    });
  });

  it("keeps a rejected legacy resume stopped without admitting a reviewer or builder", async () => {
    const old = attempt({
      status: "reviewing",
      recovery: { state: "retained", reason: "Interrupted by app restart", retainedAt: 10 },
      reviewGate: { status: "error" },
    });
    useFlightStore.setState({
      flights: [
        flight({
          stoppedAt: 10,
          attempts: [old],
          reviewGatePolicy: {
            enabled: true,
            reviewerAgentConfigId: "api-openai",
            reviewerModel: "review-model",
            acceptanceCriteria: [],
          },
        }),
      ],
    });
    mocks.resumeFlightAttempt.mockRejectedValueOnce(new Error("Retained task validation failed"));
    await expect(
      useAsyncFlightStore.getState().resumeRetainedAttempt("flight-1", old.id),
    ).rejects.toThrow("validation failed");
    expect(useFlightStore.getState().flights[0].stoppedAt).toBe(10);
    expect(useFlightStore.getState().flights[0].attempts?.[0]).toMatchObject({
      status: "reviewing",
      sessionId: old.sessionId,
    });
    expect(mocks.beginFlightExecution).not.toHaveBeenCalled();
    expect(mocks.createApiConversation).not.toHaveBeenCalled();
    expect(mocks.failPreparedFlightAttempt).not.toHaveBeenCalled();
  });

  it("retains a fresh prepared session if terminal listener registration fails during resume", async () => {
    const old = attempt({
      status: "cancelled",
      recovery: { state: "retained", reason: "Interrupted", retainedAt: 10 },
    });
    const resumed = {
      ...old,
      status: "provisioning",
      sessionId: "resume-listener-failure",
      recovery: undefined,
    } as Attempt;
    useFlightStore.setState({ flights: [flight({ stoppedAt: 10, attempts: [old] })] });
    mocks.resumeFlightAttempt.mockResolvedValueOnce(resumed);
    const normalListen = mocks.listen.getMockImplementation()!;
    mocks.listen.mockImplementation((eventName: string, callback: TauriListener) =>
      eventName.includes(resumed.sessionId)
        ? Promise.reject(new Error("Listener registration unavailable"))
        : normalListen(eventName, callback),
    );
    try {
      await expect(
        useAsyncFlightStore.getState().resumeRetainedAttempt("flight-1", old.id),
      ).rejects.toThrow("Listener registration unavailable");
      expect(mocks.failPreparedFlightAttempt).toHaveBeenCalledWith(
        "flight-1",
        old.id,
        resumed.sessionId,
        expect.stringContaining("Listener registration unavailable"),
      );
      expect(mocks.createApiConversation).not.toHaveBeenCalled();
    } finally {
      mocks.listen.mockImplementation(normalListen);
    }
  });

  it("keeps Stop authoritative during cooperative integration preparation", async () => {
    let finishPreparation!: (value: Record<string, unknown>) => void;
    mocks.prepareFlightIntegrationBranch.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishPreparation = resolve;
        }),
    );
    const value = flight({
      executionMode: "cooperative",
      executionTarget: { kind: "local", basePath: "D:/repo" },
      milestones: [
        {
          id: "ms-1",
          flightId: "flight-1",
          title: "Scope",
          description: "",
          order: 0,
          status: "active",
          validationCriteria: [],
          tasks: [
            task({
              status: "pending",
              model: "test-model",
              ownedPaths: ["src/feature.ts"],
            }),
          ],
        },
      ],
    });
    useFlightStore.setState({ flights: [value] });
    const launch = useAsyncFlightStore
      .getState()
      .launchReadyTasks(value.id, undefined, { explicitResume: true });
    await vi.waitFor(() => expect(finishPreparation).toBeTypeOf("function"));
    const stop = useAsyncFlightStore.getState().stopFlight(value.id);
    await vi.waitFor(() => expect(mocks.stopFlightSessions).toHaveBeenCalled());
    finishPreparation({
      branch: "integration",
      baseBranch: "main",
      headSha: "head",
      worktreePath: "D:/integration",
    });
    await Promise.all([launch, stop]);
    expect(mocks.beginFlightExecution).not.toHaveBeenCalled();
    expect(mocks.launchFlightAsync).not.toHaveBeenCalled();
  });
});

describe("asyncFlightStore flight-completion memory capture", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.markAttemptStatus.mockResolvedValue(undefined);
    mocks.captureFlightCompleted.mockReset();
    useFlightStore.setState({ flights: [], activeFlightId: null });
  });

  it("captures completion only when the accepted result is delivered", async () => {
    useFlightStore.setState({
      flights: [
        flight({
          attempts: [
            attempt({ id: "att-a", sessionId: "s-a", status: "completed" }),
            attempt({ id: "att-b", sessionId: "s-b", status: "reviewing" }),
          ],
        }),
      ],
      activeFlightId: null,
    });

    await useAsyncFlightStore.getState().setAttemptStatus("flight-1", "att-b", "completed");
    expect(mocks.captureFlightCompleted).not.toHaveBeenCalled();
    expect(useFlightStore.getState().computeFlightStatus("flight-1")).toBe("review");
    await useAsyncFlightStore.getState().landAttempt("flight-1", "att-b");

    expect(mocks.captureFlightCompleted).toHaveBeenCalledTimes(1);
    // Capture is now scope-keyed, not path-keyed, so a flight in a remote
    // workspace files under that workspace's `ssh:` key. This flight has no
    // workspace, so it resolves to a plain local scope on its own path.
    const [payload, scope] = mocks.captureFlightCompleted.mock.calls[0];
    expect(scope).toEqual({ kind: "local", projectPath: "D:/repo", workspaceId: null });
    expect(payload).toMatchObject({
      flightId: "flight-1",
      flightTitle: "Flight",
      whatWorked: expect.arrayContaining([expect.stringContaining("att-")]),
    });
    expect(payload.whatWorked).toHaveLength(2);
  });

  it("does not capture when the flight has not reached done", async () => {
    // One attempt still running: accepting a reviewing sibling leaves the
    // flight "active", so no flight_completed event should fire.
    useFlightStore.setState({
      flights: [
        flight({
          attempts: [
            attempt({ id: "att-run", sessionId: "s-run", status: "running" }),
            attempt({ id: "att-rev", sessionId: "s-rev", status: "reviewing" }),
          ],
        }),
      ],
      activeFlightId: null,
    });

    await useAsyncFlightStore.getState().setAttemptStatus("flight-1", "att-rev", "completed");

    expect(mocks.captureFlightCompleted).not.toHaveBeenCalled();
  });

  it("does not re-capture on a no-op status write to an already-done flight", async () => {
    useFlightStore.setState({
      flights: [
        flight({
          attempts: [attempt({ id: "att-a", sessionId: "s-a", status: "completed" })],
        }),
      ],
      activeFlightId: null,
    });

    // Flight is already "done"; re-writing completed must not fire capture.
    await useAsyncFlightStore.getState().setAttemptStatus("flight-1", "att-a", "completed");

    expect(mocks.captureFlightCompleted).not.toHaveBeenCalled();
  });

  it("does not report delivery when cancelling the last competing attempt", async () => {
    useFlightStore.setState({
      flights: [
        flight({
          attempts: [
            attempt({ id: "att-a", sessionId: "s-a", status: "completed" }),
            attempt({ id: "att-b", sessionId: "s-b", status: "running" }),
          ],
        }),
      ],
      activeFlightId: null,
    });

    await useAsyncFlightStore.getState().cancelAttempt("flight-1", "att-b");

    expect(mocks.captureFlightCompleted).not.toHaveBeenCalled();
    expect(useFlightStore.getState().computeFlightStatus("flight-1")).toBe("review");
  });

  it("does not capture when cancelling an attempt leaves the flight active", async () => {
    useFlightStore.setState({
      flights: [
        flight({
          attempts: [
            attempt({ id: "att-run", sessionId: "s-run", status: "running" }),
            attempt({ id: "att-rev", sessionId: "s-rev", status: "reviewing" }),
          ],
        }),
      ],
      activeFlightId: null,
    });

    await useAsyncFlightStore.getState().cancelAttempt("flight-1", "att-run");

    expect(mocks.captureFlightCompleted).not.toHaveBeenCalled();
  });
});

describe("asyncFlightStore flight-prompt injection gate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.launchFlightAsync.mockResolvedValue([]);
    mocks.assertCostGuardrailsAllowLaunch.mockResolvedValue(undefined);
    mocks.createApiConversation.mockResolvedValue(undefined);
    mocks.loadPersistedState.mockImplementation(async () => ({
      version: 1,
      flights: useFlightStore.getState().flights,
      agents: [],
      settings: { maxParallelSessions: 3, milestoneGating: true, projectPath: "." },
      ui: {},
    }));
    mocks.listen.mockImplementation((eventName: string, callback: TauriListener) => {
      mocks.listeners.set(eventName, callback);
      return Promise.resolve(() => mocks.listeners.delete(eventName));
    });
    mocks.composeMemoryBrief.mockReturnValue({ text: "MEMORY BRIEF", items: [] });
    useFlightStore.setState({ flights: [flight()], activeFlightId: null });
  });

  it("prepends the memory brief when injectIntoFlightPrompts is on", async () => {
    useMemorySettingsStore.getState().setInjectIntoFlightPrompts(true);
    mocks.launchFlightAsync.mockResolvedValue([attempt()]);

    await useAsyncFlightStore.getState().launchAsync("flight-1", "Do it", [localTarget("d:/repo")]);

    expect(mocks.composeMemoryBrief).toHaveBeenCalled();
    const promptArg = mocks.launchFlightAsync.mock.calls[0][1] as string;
    expect(promptArg).toContain("MEMORY BRIEF");
    expect(promptArg).toContain("Do it");
    expect(mocks.createApiConversation).toHaveBeenCalledWith(
      expect.objectContaining({ initialMessage: promptArg }),
    );
  });

  it("briefs an all-ssh launch with that server's remote scope", async () => {
    // Previously ANY non-local target skipped the brief entirely, so a remote
    // flight could never receive project memory.
    useMemorySettingsStore.getState().setInjectIntoFlightPrompts(true);
    mocks.launchFlightAsync.mockResolvedValue([attempt()]);

    await useAsyncFlightStore
      .getState()
      .launchAsync("flight-1", "Do it", [sshTarget("srv-1", "/srv/app")]);

    expect(mocks.composeMemoryBrief).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "ssh", serverId: "srv-1", remotePath: "/srv/app" }),
      expect.anything(),
    );
    // The flight's own (local-mirror) projectPath must not leak into the scope.
    const scopeArg = mocks.composeMemoryBrief.mock.calls[0][0] as Record<string, unknown>;
    expect(scopeArg.projectPath).toBe("/srv/app");
  });

  it("refuses to brief an ssh fan-out that spans two servers", async () => {
    // No single scope owns this launch, so no memory rides along rather than
    // an arbitrary server's memory being handed to the other's agent.
    useMemorySettingsStore.getState().setInjectIntoFlightPrompts(true);
    mocks.launchFlightAsync.mockResolvedValue([attempt()]);

    await useAsyncFlightStore
      .getState()
      .launchAsync("flight-1", "Do it", [
        sshTarget("srv-1", "/srv/app"),
        sshTarget("srv-2", "/srv/app"),
      ]);

    expect(mocks.composeMemoryBrief).not.toHaveBeenCalled();
  });

  it("refuses to brief a mixed local + ssh fan-out", async () => {
    useMemorySettingsStore.getState().setInjectIntoFlightPrompts(true);
    mocks.launchFlightAsync.mockResolvedValue([attempt()]);

    await useAsyncFlightStore
      .getState()
      .launchAsync("flight-1", "Do it", [localTarget("d:/repo"), sshTarget("srv-1", "/srv/app")]);

    expect(mocks.composeMemoryBrief).not.toHaveBeenCalled();
  });

  it("sends the raw prompt when injectIntoFlightPrompts is off", async () => {
    useMemorySettingsStore.getState().setInjectIntoFlightPrompts(false);

    await useAsyncFlightStore.getState().launchAsync("flight-1", "Do it", [localTarget("d:/repo")]);

    expect(mocks.composeMemoryBrief).not.toHaveBeenCalled();
    const promptArg = mocks.launchFlightAsync.mock.calls[0][1] as string;
    expect(promptArg).toBe("Do it");
  });
});

describe("buildReassignSpec (E4)", () => {
  const failedLocal: Attempt = {
    id: "att-1",
    flightId: "f1",
    target: { kind: "local", basePath: "/repo", worktreePath: "/repo/wt" },
    agentConfigId: "api-claude",
    model: "claude-sonnet-4-6",
    provider: "claude",
    branch: "packetbench/att-1",
    baseBranch: "main",
    sessionId: "s1",
    status: "failed",
    cost: 0,
    tokens: 0,
  };
  const noServer = () => undefined;

  it("retains a named provider's selected model when retrying the same agent", () => {
    const failed = {
      ...failedLocal,
      agentConfigId: "api-sugar",
      provider: "sugar",
      model: "sugar/chosen",
    };
    expect(buildReassignSpec(failed, "api-sugar", noServer)?.model).toBe("sugar/chosen");
    expect(buildReassignSpec(failedLocal, "api-sugar", noServer)?.model).toBe(DEFAULT_API_MODEL);
    expect(() => buildReassignSpec(failedLocal, "api-google", noServer)).toThrow(
      "Select this provider and a model",
    );
  });

  it("rebuilds a local target with the new agent + its default model", () => {
    const spec = buildReassignSpec(failedLocal, "api-openai", noServer);
    expect(spec?.kind).toBe("local");
    expect(spec?.agentConfigId).toBe("api-openai");
    expect(spec?.provider).toBe("openai");
    expect(spec?.basePath).toBe("/repo");
    expect(spec?.baseBranch).toBe("main");
    // The new agent's default model, not the failed attempt's claude model.
    expect(spec?.model).not.toBe("claude-sonnet-4-6");
  });

  it("returns null for an SSH attempt whose server is no longer configured", () => {
    const failedSsh: Attempt = {
      ...failedLocal,
      target: { kind: "ssh", serverId: "srv-x", basePath: "/repo", worktreePath: "/repo/wt" },
    };
    expect(buildReassignSpec(failedSsh, "api-openai", noServer)).toBeNull();
  });

  it("rebuilds an SSH target from the saved server config", () => {
    const failedSsh: Attempt = {
      ...failedLocal,
      target: { kind: "ssh", serverId: "srv-1", basePath: "/repo", worktreePath: "/repo/wt" },
    };
    const server = {
      id: "srv-1",
      host: "example.com",
      port: 2222,
      username: "dev",
      keyPath: "/keys/id",
      authMethod: "key",
      hostFingerprint: "SHA256:abc",
    } as ServerConfig;
    const spec = buildReassignSpec(failedSsh, "api-claude", () => server);
    expect(spec?.kind).toBe("ssh");
    if (spec?.kind === "ssh") {
      expect(spec.host).toBe("example.com");
      expect(spec.port).toBe(2222);
      expect(spec.user).toBe("dev");
      expect(spec.agentConfigId).toBe("api-claude");
      // Reassigning onto the default executor must produce the canonical
      // `get_provider` id, not the prefix-strip "claude" the failed attempt
      // was recorded with.
      expect(spec.provider).toBe("anthropic");
    }
  });

  it("maps the default api-claude executor to 'anthropic' on a local reassign", () => {
    const spec = buildReassignSpec(failedLocal, "api-claude", noServer);
    expect(spec?.provider).toBe("anthropic");
    expect(spec?.provider).not.toBe("claude");
  });
});
