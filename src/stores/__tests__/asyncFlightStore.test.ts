import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AttemptTargetSpec } from "@/lib/tauri";
import type { Attempt, Flight, Task } from "@/types/flight";
import type { ServerConfig } from "@/types/server";
import { apiAgentDoneEvent, apiAgentErrorEvent } from "@/lib/events";

type TauriListener = (event: { payload?: { message?: string } }) => void;

const mocks = vi.hoisted(() => ({
  launchFlightAsync: vi.fn(),
  assertCostGuardrailsAllowLaunch: vi.fn(),
  createApiConversation: vi.fn(),
  loadPersistedState: vi.fn(),
  markAttemptStatus: vi.fn(),
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
  cancelFlightAttempt: vi.fn().mockResolvedValue(undefined),
  cleanupAttemptWorktreeSsh: mocks.cleanupAttemptWorktreeSsh,
  markAttemptStatus: mocks.markAttemptStatus,
  gitPushBranch: mocks.gitPushBranch,
  githubCreatePr: mocks.githubCreatePr,
  setAttemptDraftPr: mocks.setAttemptDraftPr,
  loadPersistedState: mocks.loadPersistedState,
  saveFlightsSlice: vi.fn().mockResolvedValue(undefined),
  saveUiSlice: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/stores/costGuardrailStore", () => ({
  assertCostGuardrailsAllowLaunch: mocks.assertCostGuardrailsAllowLaunch,
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

function sshTarget(
  targetId: string,
  basePath: string,
  baseBranch = "main",
): AttemptTargetSpec {
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
      flights: [flight({ id: "existing-flight", attempts: [attempt()] })],
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
      flights: [flight({ id: "existing-flight", attempts: [attempt()] })],
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

  it("moves an async attempt to failed with error text on api-agent:error without UI mount", async () => {
    const launchedAttempt = attempt({ id: "att-error", sessionId: "session-error" });
    mocks.launchFlightAsync.mockResolvedValue([launchedAttempt]);
    useFlightStore.setState({ flights: [flight()], activeFlightId: null });

    await useAsyncFlightStore.getState().launchAsync("flight-1", "Do it", [localTarget("d:/repo")]);
    await vi.waitFor(() => {
      expect(mocks.listeners.has(apiAgentErrorEvent("session-error"))).toBe(true);
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
    });
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
    mocks.cleanupAttemptWorktreeSsh.mockResolvedValue(undefined);
    mocks.gitPushBranch.mockResolvedValue(undefined);
    mocks.githubCreatePr.mockResolvedValue(JSON.stringify({ number: 42 }));
    mocks.setAttemptDraftPr.mockResolvedValue(undefined);
    mocks.selectedRepo = null;
    mocks.getServer.mockReturnValue(undefined);
    useFlightStore.setState({ flights: [], activeFlightId: null });
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

    expect(mocks.gitPushBranch).toHaveBeenCalledWith(
      "D:\\Repo\\.git\\packetbench-worktrees\\att-running",
      "packetbench/att-running",
      false,
    );
    expect(mocks.setAttemptDraftPr).toHaveBeenCalledWith("flight-1", "att-running", 42);
    expect(mocks.gitPushBranch.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.markAttemptStatus.mock.invocationCallOrder[0],
    );
    expect(mocks.setAttemptDraftPr.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.markAttemptStatus.mock.invocationCallOrder[0],
    );
  });

  it("cleans up an SSH worktree after accepting an attempt", async () => {
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

    expect(mocks.cleanupAttemptWorktreeSsh).toHaveBeenCalledWith({
      flightId: "flight-1",
      attemptId: "att-running",
      host: "example.test",
      port: 22,
      user: "ian",
      keyPath: "C:/keys/id_ed25519",
      basePath: "/srv/repo",
      targetId: "server-1",
      hostFingerprint: "SHA256:test",
    });
  });
});

describe("asyncFlightStore flight-completion memory capture", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.markAttemptStatus.mockResolvedValue(undefined);
    mocks.captureFlightCompleted.mockReset();
    useFlightStore.setState({ flights: [], activeFlightId: null });
  });

  it("captures a flight_completed event on the transition to done", async () => {
    // Flight rolls up to "review" (one completed, one reviewing). Accepting
    // the reviewing attempt flips the whole flight to "done".
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

  it("captures a flight_completed event when cancelling the last outstanding attempt tips the flight to done", async () => {
    // One attempt already completed, one still running. Cancelling the
    // running attempt (the "pick a winner" flow) rolls the flight up to
    // "done" via the mixed-terminal fallback in computeStatusFromAttempts —
    // this must fire capture even though cancelAttempt never calls
    // setAttemptStatus.
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

    expect(mocks.captureFlightCompleted).toHaveBeenCalledTimes(1);
    // Capture is now scope-keyed, not path-keyed, so a flight in a remote
    // workspace files under that workspace's `ssh:` key. This flight has no
    // workspace, so it resolves to a plain local scope on its own path.
    const [payload, scope] = mocks.captureFlightCompleted.mock.calls[0];
    expect(scope).toEqual({ kind: "local", projectPath: "D:/repo", workspaceId: null });
    expect(payload).toMatchObject({ flightId: "flight-1", flightTitle: "Flight" });
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
      .launchAsync("flight-1", "Do it", [
        localTarget("d:/repo"),
        sshTarget("srv-1", "/srv/app"),
      ]);

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
    const failed = {...failedLocal, agentConfigId:"api-sugar", provider:"sugar", model:"sugar/chosen"};
    expect(buildReassignSpec(failed, "api-sugar", noServer)?.model).toBe("sugar/chosen");
    expect(() => buildReassignSpec(failedLocal, "api-sugar", noServer)).toThrow("Select this provider and a model");
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
