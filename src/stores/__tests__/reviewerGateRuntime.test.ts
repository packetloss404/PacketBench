import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentConversation } from "@/types/agent-conversation";
import type { Flight } from "@/types/flight";

const state = vi.hoisted(() => ({
  flights: [] as Flight[],
  conversations: [] as AgentConversation[],
  initialized: false,
  persist: vi.fn(),
  event: vi.fn(),
  listen: vi.fn(),
  launch: vi.fn(),
  capture: vi.fn(),
  git: vi.fn(),
  send: vi.fn(),
  server: vi.fn(),
}));
vi.mock("@/lib/tauri", () => ({
  setAttemptReviewGate: (...args: unknown[]) => state.persist(...args),
  captureAttemptReviewEvidence: (...args: unknown[]) => state.capture(...args),
  getGitReviewEvidence: (...args: unknown[]) => state.git(...args),
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: (...args: unknown[]) => state.listen(...args) }));
vi.mock("@/stores/appStore", () => ({
  useAppStore: { getState: () => state, subscribe: vi.fn() },
}));
vi.mock("@/stores/agentConversationPersistence", () => ({ requestConversationSave: vi.fn() }));
vi.mock("@/stores/agentTaskStore", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/stores/agentTaskStore")>()),
  useAgentTaskStore: {
    getState: () => ({
      conversations: state.conversations,
      createApiConversation: state.launch,
      sendMessageWithReceipt: state.send,
    }),
    setState: (
      update: (current: { conversations: AgentConversation[] }) => {
        conversations: AgentConversation[];
      },
    ) => {
      state.conversations = update({ conversations: state.conversations }).conversations;
    },
  },
}));
vi.mock("@/stores/serverStore", () => ({
  useServerStore: { getState: () => ({ getServer: state.server }) },
}));
vi.mock("@/stores/flightStore", () => ({
  useFlightStore: {
    getState: () => ({
      flights: state.flights,
      updateFlight: (id: string, patch: Partial<Flight>) => {
        state.flights = state.flights.map((f) => (f.id === id ? { ...f, ...patch } : f));
      },
      appendCoordinationEvent: state.event,
      flushPersistence: vi.fn(),
    }),
  },
}));

function gate() {
  return state.flights[0].attempts![0].reviewGate!;
}

beforeEach(() => {
  vi.clearAllMocks();
  state.persist.mockReset().mockResolvedValue(undefined);
  state.send.mockReset().mockResolvedValue(undefined);
  state.server.mockReset();
  state.listen.mockResolvedValue(() => {});
  state.capture.mockReset().mockResolvedValue({
    fingerprint: "snapshot",
    contextFingerprint: "context",
    contextJson: JSON.stringify({
      objective: "Frozen objective",
      prompt: "Frozen prompt",
      criteria: ["Frozen criterion"],
      task: null,
      branch: "attempt",
      target: { kind: "local", worktree_path: "/repo/attempt" },
    }),
    baseSha: "base-sha",
    headSha: "head-sha",
  });
  state.git.mockReset().mockResolvedValue({
    baseRef: "base-sha",
    headRef: "head-sha",
    diffSummary: "",
    changedPaths: [],
    patch: "",
    patchTruncated: false,
  });
  state.launch.mockReset().mockImplementation(async (options) => {
    state.conversations.push({
      id: options.explicitId,
      status: "active",
      messages: [],
    } as unknown as AgentConversation);
  });
  state.initialized = true;
  state.conversations = [];
  state.flights = [
    {
      id: "flight",
      title: "Test Flight",
      objective: "Objective",
      prompt: "Prompt",
      milestones: [],
      linkedSessionIds: [],
      reviewGatePolicy: {
        enabled: true,
        reviewerAgentConfigId: "api-openai",
        reviewerModel: "review-model",
        acceptanceCriteria: ["Criterion"],
      },
      attempts: [
        {
          id: "attempt",
          sessionId: "builder",
          baseBranch: "main",
          branch: "attempt",
          target: { kind: "local", basePath: "/repo", worktreePath: "/repo/attempt" },
          status: "reviewing",
          reviewGate: {
            status: "running",
            reviewerConversationId: "review",
            reviewerAgentConfigId: "api-openai",
            reviewerModel: "gpt-test",
          },
        },
      ],
    } as unknown as Flight,
  ];
});

describe("reviewer gate lifecycle", () => {
  it.each(["completed", "cancelled", "failed", undefined] as const)(
    "reconciles idle reviewer %s using its terminal outcome",
    async (turnOutcome) => {
      state.initialized = false;
      const { syncReviewerGateRuns } = await import("../reviewerGateRuntime");
      state.conversations = [
        {
          id: "review",
          status: "idle",
          messages: [
            {
              role: "assistant",
              turnOutcome,
              content:
                '```packetbench-review-gate\n{"schemaVersion":1,"verdict":"pass","summary":"Reviewed","findings":[],"evidence":["tests"]}\n```',
            },
          ],
        } as unknown as AgentConversation,
      ];
      state.initialized = true;
      await syncReviewerGateRuns();
      expect(gate().status, gate().errorMessage).toBe(
        turnOutcome === "completed" ? "passed" : "error",
      );
    },
  );

  it("only records a repair handoff after native dispatch acknowledgment", async () => {
    const { sendReviewFindingsToBuilder } = await import("../reviewerGateRuntime");
    gate().status = "changes_requested";
    gate().report = {
      schemaVersion: 1,
      verdict: "changes_requested",
      summary: "Fix tests",
      findings: [],
      evidence: [],
    };
    state.conversations = [
      { id: "builder", status: "idle", mode: "api", messages: [] } as unknown as AgentConversation,
    ];
    let resolve!: () => void;
    state.send.mockReturnValueOnce(
      new Promise<void>((done) => {
        resolve = done;
      }),
    );
    const send = sendReviewFindingsToBuilder("flight", "attempt");
    expect(state.send).toHaveBeenCalledWith(
      "builder",
      expect.stringContaining("Fix tests"),
      undefined,
      { requireIdle: true },
    );
    expect(state.event).not.toHaveBeenCalled();
    resolve();
    await send;
    expect(state.event).toHaveBeenCalledWith(
      "flight",
      expect.objectContaining({ type: "handoff" }),
    );
  });

  it("bubbles repair dispatch rejection without recording a successful handoff", async () => {
    const { sendReviewFindingsToBuilder } = await import("../reviewerGateRuntime");
    gate().status = "changes_requested";
    gate().report = {
      schemaVersion: 1,
      verdict: "changes_requested",
      summary: "Fix tests",
      findings: [],
      evidence: [],
    };
    state.conversations = [
      { id: "builder", status: "idle", mode: "api", messages: [] } as unknown as AgentConversation,
    ];
    state.send.mockRejectedValueOnce(new Error("permission rejected"));
    await expect(sendReviewFindingsToBuilder("flight", "attempt")).rejects.toThrow(
      "permission rejected",
    );
    expect(state.event).not.toHaveBeenCalled();
  });
  it("normalizes a legacy unbound pass to a retryable error during hydration", async () => {
    state.initialized = false;
    const { syncReviewerGateRuns } = await import("../reviewerGateRuntime");
    gate().status = "passed";
    state.initialized = true;
    await syncReviewerGateRuns();
    expect(gate()).toMatchObject({
      status: "error",
      errorMessage: expect.stringContaining("Retry the reviewer"),
    });
    expect(state.persist).toHaveBeenCalledOnce();
    expect(state.launch).not.toHaveBeenCalled();
  });
  it("registers the actual reviewer owner and pinned code before starting the provider", async () => {
    const { startReviewGate } = await import("../reviewerGateRuntime");
    state.flights[0].attempts![0].reviewGate = undefined;
    await startReviewGate("flight", "attempt");
    expect(state.capture).toHaveBeenCalledWith("flight", "attempt");
    expect(state.git.mock.calls[0][1]).toBe("base-sha");
    expect(gate().evidence?.headSha).toBe("head-sha");
    expect(gate().reviewerSessions).toEqual([
      { sessionId: gate().reviewerConversationId, provider: "openai", model: "review-model" },
    ]);
    expect(state.persist.mock.invocationCallOrder[0]).toBeLessThan(
      state.launch.mock.invocationCallOrder[0],
    );
    expect(state.launch).toHaveBeenCalledWith(
      expect.objectContaining({
        enabledMcpServerIds: [],
        permissionMode: "deny_all",
        planMode: true,
      }),
    );
  });

  it("starts a native SSH reviewer with built-in read-only tools and no MCP servers", async () => {
    const { startReviewGate } = await import("../reviewerGateRuntime");
    const attempt = state.flights[0].attempts![0];
    attempt.reviewGate = undefined;
    attempt.target = {
      kind: "ssh",
      serverId: "saved-host",
      basePath: "/repo",
      worktreePath: "/repo/attempt",
    };
    state.flights[0].reviewGatePolicy!.reviewerAgentConfigId = "api-sugar";
    state.flights[0].reviewGatePolicy!.reviewerModel = "Conduit";
    state.server.mockReturnValue({
      id: "saved-host",
      name: "Saved host",
      host: "example.test",
      port: 22,
      username: "ian",
      authMethod: "key",
      hostFingerprint: "SHA256:pinned",
    });
    await startReviewGate("flight", "attempt");
    expect(state.launch).toHaveBeenCalledWith(
      expect.objectContaining({
        agent: "api-sugar",
        model: "Conduit",
        enabledMcpServerIds: [],
        permissionMode: "deny_all",
        planMode: true,
        allowedTools: expect.arrayContaining(["read_file", "grep"]),
        sshTarget: expect.objectContaining({
          serverId: "saved-host",
          remotePath: "/repo/attempt",
          hostFingerprint: "SHA256:pinned",
        }),
      }),
    );
  });

  it("keeps prior reviewer session ownership across retries", async () => {
    const { retryReviewGate } = await import("../reviewerGateRuntime");
    gate().status = "error";
    gate().reviewerSessions = [
      { sessionId: "old-review", provider: "claude-oauth", model: "old-model" },
    ];
    await retryReviewGate("flight", "attempt");
    expect(gate().reviewerSessions).toContainEqual({
      sessionId: "old-review",
      provider: "claude-oauth",
      model: "old-model",
    });
    expect(gate().reviewerSessions).toHaveLength(2);
    expect(state.launch).toHaveBeenCalledOnce();
  });

  it("rejects terminal reviewer retry before clearing the error or override action", async () => {
    const { retryReviewGate } = await import("../reviewerGateRuntime");
    state.flights[0].attempts![0].status = "completed";
    gate().status = "error";
    await expect(retryReviewGate("flight", "attempt")).rejects.toThrow("new reviewed attempt");
    expect(gate().status).toBe("error");
    expect(state.persist).not.toHaveBeenCalled();
    expect(state.launch).not.toHaveBeenCalled();
  });

  it("surfaces dirty-worktree evidence failure without starting a provider", async () => {
    const { startReviewGate } = await import("../reviewerGateRuntime");
    state.flights[0].attempts![0].reviewGate = undefined;
    state.capture.mockRejectedValueOnce(new Error("Commit untracked changes before reviewing"));
    await startReviewGate("flight", "attempt");
    expect(gate()).toMatchObject({
      status: "error",
      errorMessage: expect.stringContaining("untracked"),
    });
    expect(state.launch).not.toHaveBeenCalled();
  });

  it("does not start a retry over an override made while snapshot capture was pending", async () => {
    const { retryReviewGate, overrideReviewGate } = await import("../reviewerGateRuntime");
    gate().status = "error";
    let complete!: (value: unknown) => void;
    state.capture.mockReturnValueOnce(
      new Promise((resolve) => {
        complete = resolve;
      }),
    );
    const retry = retryReviewGate("flight", "attempt");
    await vi.waitFor(() => expect(state.capture).toHaveBeenCalledOnce());
    await overrideReviewGate("flight", "attempt", "Manually reviewed");
    complete({
      fingerprint: "snapshot",
      contextFingerprint: "context",
      contextJson: JSON.stringify({
        objective: "Frozen objective",
        prompt: "Frozen prompt",
        criteria: [],
        task: null,
        branch: "attempt",
        target: { kind: "local", worktree_path: "/repo/attempt" },
      }),
      baseSha: "base",
      headSha: "head",
    });
    await retry;
    expect(gate().status).toBe("overridden");
    expect(state.launch).not.toHaveBeenCalled();
  });

  it.each(["capture", "bundle"])(
    "does not start an automatic reviewer after cancellation during %s collection",
    async (phase) => {
      const { retryReviewGate, syncReviewerGateRuns } = await import("../reviewerGateRuntime");
      gate().status = "error";
      let allowed = true;
      let release!: (value: unknown) => void;
      const delayed = phase === "capture" ? state.capture : state.git;
      const value = delayed.getMockImplementation()!();
      delayed.mockReturnValueOnce(
        new Promise((resolve) => {
          release = resolve;
        }),
      );
      const retry = retryReviewGate("flight", "attempt", () => allowed);
      await vi.waitFor(() => expect(delayed).toHaveBeenCalled());
      allowed = false;
      release(await value);
      await retry;
      expect(gate()).toMatchObject({
        status: "error",
        errorMessage: expect.stringContaining("paused or stopped"),
      });
      await syncReviewerGateRuns();
      expect(state.launch).not.toHaveBeenCalled();
    },
  );
  it.each(["idle", "missing"])(
    "turns a restored %s reviewer into an actionable interrupted gate",
    async (status) => {
      // Initial module sync must wait for hydration, just like app bootstrap.
      state.initialized = false;
      const { syncReviewerGateRuns } = await import("../reviewerGateRuntime");
      await syncReviewerGateRuns();
      expect(state.persist).not.toHaveBeenCalled();
      state.initialized = true;
      state.conversations =
        status === "missing"
          ? []
          : [{ id: "review", status: "idle", messages: [] } as unknown as AgentConversation];
      await syncReviewerGateRuns();
      expect(gate()).toMatchObject({
        status: "error",
        errorMessage: expect.stringContaining("interrupted"),
      });
      expect(state.listen).not.toHaveBeenCalled();
      expect(state.launch).not.toHaveBeenCalled();
    },
  );

  it("keeps a failed override visibly retryable and never records success", async () => {
    const { overrideReviewGate } = await import("../reviewerGateRuntime");
    gate().status = "error";
    state.persist.mockRejectedValueOnce(new Error("disk full"));
    await expect(overrideReviewGate("flight", "attempt", "Reviewed manually")).rejects.toThrow(
      "disk full",
    );
    expect(gate()).toMatchObject({
      status: "error",
      errorMessage: expect.stringContaining("Could not save"),
    });
    expect(state.event).not.toHaveBeenCalled();
    await overrideReviewGate("flight", "attempt", "Reviewed manually");
    expect(gate().status).toBe("overridden");
    expect(state.event).toHaveBeenCalledOnce();
  });

  it("does not publish passed until the authoritative write completes", async () => {
    const { syncReviewerGateRuns } = await import("../reviewerGateRuntime");
    state.conversations = [
      {
        id: "review",
        status: "done",
        messages: [
          {
            role: "assistant",
            content:
              '```packetbench-review-gate\n{"schemaVersion":1,"verdict":"pass","summary":"Reviewed","findings":[],"evidence":["tests"]}\n```',
          },
        ],
      } as unknown as AgentConversation,
    ];
    let resolve!: () => void;
    state.persist.mockReturnValueOnce(
      new Promise<void>((done) => {
        resolve = done;
      }),
    );
    const finish = syncReviewerGateRuns();
    expect(gate().status).toBe("running");
    expect(state.event).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(state.persist).toHaveBeenCalledOnce());
    resolve();
    await finish;
    expect(gate().status).toBe("passed");
    expect(state.event).toHaveBeenCalledWith(
      "flight",
      expect.objectContaining({ summary: "Independent Reviewer Gate passed." }),
    );
  });

  it("does not let a delayed reviewer completion replace a newer override", async () => {
    const { syncReviewerGateRuns, overrideReviewGate } = await import("../reviewerGateRuntime");
    state.conversations = [
      {
        id: "review",
        status: "done",
        messages: [
          {
            role: "assistant",
            content:
              '```packetbench-review-gate\n{"schemaVersion":1,"verdict":"pass","summary":"Reviewed","findings":[],"evidence":["tests"]}\n```',
          },
        ],
      } as unknown as AgentConversation,
    ];
    let resolve!: () => void;
    state.persist.mockReturnValueOnce(
      new Promise<void>((done) => {
        resolve = done;
      }),
    );
    // Override is admitted first; stale sync still sees running until IPC settles.
    const override = overrideReviewGate("flight", "attempt", "User reviewed manually");
    await vi.waitFor(() => expect(state.persist).toHaveBeenCalledOnce());
    const lateFinish = syncReviewerGateRuns();
    resolve();
    await Promise.all([override, lateFinish]);
    expect(gate().status).toBe("overridden");
    expect(state.persist).toHaveBeenCalledOnce();
    expect(state.event).toHaveBeenCalledOnce();
    expect(state.event.mock.calls[0][1].summary).toContain("overridden");
  });

  it("coalesces concurrent interrupted-review reconciliation", async () => {
    const { syncReviewerGateRuns } = await import("../reviewerGateRuntime");
    state.conversations = [];
    await Promise.all([syncReviewerGateRuns(), syncReviewerGateRuns()]);
    expect(state.persist).toHaveBeenCalledOnce();
    expect(gate().status).toBe("error");
  });
});
