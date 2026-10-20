import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Flight } from "@/types/flight";

const harness = vi.hoisted(() => {
  const flightListeners = new Set<() => void>();
  const agentListeners = new Set<() => void>();
  const value = {
    flights: [] as Flight[],
    conversations: [] as Array<Record<string, unknown>>,
    cancellingConversationIds: new Set<string>(),
    appendCoordinationEvent: vi.fn(),
    cancelAttempt: vi.fn().mockResolvedValue(undefined),
    stopFlight: vi.fn().mockResolvedValue(undefined),
    beginFlightExecution: vi.fn().mockResolvedValue(undefined),
    reassignAttempt: vi.fn().mockResolvedValue(undefined),
    retryReviewGate: vi.fn().mockResolvedValue(undefined),
    sendReviewFindingsToBuilder: vi.fn().mockResolvedValue(undefined),
    setAttemptStatus: vi.fn().mockResolvedValue(undefined),
    launchReadyTasks: vi.fn().mockResolvedValue(undefined),
    setPermissionMode: vi.fn().mockResolvedValue(undefined),
    flushPersistence: vi.fn().mockResolvedValue(undefined),
    flightListeners,
    agentListeners,
  };
  return value;
});

vi.mock("@/stores/flightStore", () => ({
  useFlightStore: {
    getState: () => ({
      flights: harness.flights,
      updateFlight: (id: string, updates: Partial<Flight>) => {
        harness.flights = harness.flights.map((flight) =>
          flight.id === id ? { ...flight, ...updates } : flight,
        );
        for (const listener of harness.flightListeners) listener();
      },
      appendCoordinationEvent: harness.appendCoordinationEvent,
      flushPersistence: harness.flushPersistence,
    }),
    subscribe: (listener: () => void) => {
      harness.flightListeners.add(listener);
      return () => harness.flightListeners.delete(listener);
    },
  },
}));

vi.mock("@/stores/agentTaskStore", () => ({
  useAgentTaskStore: {
    getState: () => ({
      conversations: harness.conversations,
      cancellingConversationIds: harness.cancellingConversationIds,
      setPermissionMode: harness.setPermissionMode,
    }),
    subscribe: (listener: () => void) => {
      harness.agentListeners.add(listener);
      return () => harness.agentListeners.delete(listener);
    },
  },
}));

vi.mock("@/stores/asyncFlightStore", () => ({
  useAsyncFlightStore: {
    getState: () => ({
      cancelAttempt: harness.cancelAttempt,
      stopFlight: harness.stopFlight,
      reassignAttempt: harness.reassignAttempt,
      retryReviewGate: harness.retryReviewGate,
      sendReviewFindingsToBuilder: harness.sendReviewFindingsToBuilder,
      setAttemptStatus: harness.setAttemptStatus,
      launchReadyTasks: harness.launchReadyTasks,
    }),
  },
}));
vi.mock("@/lib/tauri", () => ({ beginFlightExecution: harness.beginFlightExecution }));

import {
  pauseFlightAutonomy,
  startBoundedAutonomyRuntime,
  startFlightAutonomy,
  stopFlightAutonomy,
} from "@/stores/boundedAutonomyRuntime";

let cleanupRuntime: (() => void) | undefined;

afterEach(async () => {
  cleanupRuntime?.();
  cleanupRuntime = undefined;
  if (vi.isFakeTimers()) await vi.advanceTimersByTimeAsync(0);
  vi.useRealTimers();
});

function flight(status: "idle" | "running" | "paused" = "idle"): Flight {
  return {
    id: "flight-1",
    title: "Autonomy",
    objective: "Run",
    status: "active",
    priority: "medium",
    projectPath: "D:\\repo",
    workspaceId: null,
    milestones: [],
    linkedSessionIds: [],
    issueIds: [],
    createdAt: 1,
    updatedAt: 1,
    totalCost: 0,
    totalTokens: 0,
    executionMode: "cooperative",
    reviewGatePolicy: {
      enabled: true,
      reviewerAgentConfigId: "api-openai-codex",
      acceptanceCriteria: ["pass"],
    },
    autonomyMode: "yolo",
    autonomyPolicy: {
      schemaVersion: 1,
      autoRecovery: true,
      autoReviewRemediation: true,
      autoRunTaskGraph: true,
      toolPosture: "approval_gated",
      maxTotalCost: 25,
      maxDurationMinutes: 120,
      maxRetriesPerTask: 2,
      maxReviewRounds: 2,
      maxConcurrentAgents: 3,
      allowedRoots: ["D:\\repo"],
      allowedTargets: ["local"],
      allowDraftPrPublishing: false,
    },
    autonomyRuntime: {
      status,
      startedAt: status === "running" ? 1 : undefined,
      actionHistory: [],
    },
  };
}

describe("bounded autonomy supervision", () => {
  beforeEach(() => {
    harness.flights = [];
    harness.conversations = [];
    harness.cancellingConversationIds.clear();
    harness.flightListeners.clear();
    harness.agentListeners.clear();
    vi.clearAllMocks();
    harness.flushPersistence.mockReset().mockResolvedValue(undefined);
    harness.retryReviewGate.mockReset().mockResolvedValue(undefined);
    harness.beginFlightExecution.mockReset().mockResolvedValue(undefined);
    harness.sendReviewFindingsToBuilder.mockReset().mockResolvedValue(undefined);
  });

  it("pauses a persisted running policy when the runtime starts after reload", () => {
    harness.flights = [flight("running")];
    const cleanup = startBoundedAutonomyRuntime();
    expect(harness.flights[0].autonomyRuntime).toMatchObject({
      status: "paused",
      hardStopReason: expect.stringContaining("Resume explicitly"),
    });
    cleanup();
  });

  it("supports explicit start and pause without cancelling attempts", async () => {
    harness.flights = [flight("idle")];
    await startFlightAutonomy("flight-1");
    expect(harness.flights[0].autonomyRuntime?.status).toBe("running");
    pauseFlightAutonomy("flight-1");
    expect(harness.flights[0].autonomyRuntime).toMatchObject({
      status: "paused",
      hardStopReason: "Paused by the user.",
    });
    expect(harness.cancelAttempt).not.toHaveBeenCalled();
  });

  it("makes Stop terminal and stops all owned roles without discarding worktrees", async () => {
    const value = flight("running");
    value.attempts = [
      {
        id: "attempt-1",
        flightId: value.id,
        target: { kind: "local", basePath: "D:\\repo", worktreePath: "D:\\attempt" },
        agentConfigId: "api-openai",
        model: "gpt-5",
        provider: "openai",
        branch: "packetbench/attempt-1",
        baseBranch: "main",
        sessionId: "session-1",
        status: "running",
        cost: 0,
        tokens: 0,
      },
    ];
    harness.flights = [value];

    await stopFlightAutonomy("flight-1", true);

    expect(harness.flights[0].autonomyRuntime).toMatchObject({
      status: "stopped",
      hardStopReason: "Stopped by the user.",
    });
    expect(harness.stopFlight).toHaveBeenCalledWith("flight-1");
    expect(harness.cancelAttempt).not.toHaveBeenCalled();
    await expect(startFlightAutonomy("flight-1")).rejects.toThrow(
      "Choose bounded automatic actions again",
    );
  });

  it("keeps a user Pause while native start admission is pending", async () => {
    let finish!: () => void;
    harness.beginFlightExecution.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    harness.flights = [flight("idle")];
    const start = startFlightAutonomy("flight-1");
    await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
    pauseFlightAutonomy("flight-1");
    finish();
    await start;
    expect(harness.flights[0].autonomyRuntime?.status).toBe("paused");
  });

  it("stops active work at the duration cap without requiring a provider event", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(100_000);
    const value = flight("idle");
    value.autonomyPolicy = { ...value.autonomyPolicy!, maxDurationMinutes: 1 };
    value.autonomyPolicy.autoRunTaskGraph = false;
    harness.flights = [value];
    cleanupRuntime = startBoundedAutonomyRuntime();
    await startFlightAutonomy(value.id);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(harness.flights[0].autonomyRuntime).toMatchObject({
      status: "needs_attention",
      hardStopReason: expect.stringMatching(/duration/i),
    });
    expect(harness.stopFlight).toHaveBeenCalledWith(
      value.id,
      expect.objectContaining({ needsAttention: true }),
    );
    expect(harness.cancelAttempt).not.toHaveBeenCalled();
  });

  function reviewFailureFlight(): Flight {
    const value = flight("idle");
    value.attempts = [
      {
        id: "attempt-1",
        flightId: value.id,
        target: { kind: "local", basePath: "D:\\repo", worktreePath: "D:\\attempt" },
        agentConfigId: "api-openai",
        model: "test-model",
        provider: "openai",
        branch: "test-attempt",
        baseBranch: "main",
        sessionId: "builder",
        status: "reviewing",
        cost: 0,
        tokens: 0,
        reviewGate: {
          status: "error",
          reviewerConversationId: "review-0",
          completedAt: Date.now(),
        },
      },
    ];
    return value;
  }

  function startReviewFailure(value = reviewFailureFlight()): void {
    harness.flights = [value];
    cleanupRuntime = startBoundedAutonomyRuntime();
    harness.flights[0].autonomyRuntime = {
      ...harness.flights[0].autonomyRuntime!,
      status: "running",
      startedAt: Date.now(),
    };
    for (const listener of harness.flightListeners) listener();
  }

  it("waits for an acknowledged repair's completed idle turn before reserving the invalidated review's retry", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(100_000);
    const value = reviewFailureFlight();
    value.attempts![0].reviewGate = {
      status: "changes_requested",
      reviewerConversationId: "review-0",
      report: {
        schemaVersion: 1,
        verdict: "changes_requested",
        summary: "Fix",
        findings: [],
        evidence: [],
      },
    };
    const builder = {
      id: "builder",
      status: "active",
      messages: [{ role: "assistant", timestamp: Date.now(), isStreaming: true }],
    };
    harness.conversations = [builder];
    let acknowledge!: () => void;
    harness.sendReviewFindingsToBuilder.mockReturnValueOnce(
      new Promise<void>((done) => {
        acknowledge = done;
      }),
    );
    startReviewFailure(value);
    await vi.advanceTimersByTimeAsync(0);
    expect(harness.sendReviewFindingsToBuilder).toHaveBeenCalledOnce();
    expect(harness.flights[0].autonomyRuntime!.actionHistory[0].status).toBe("started");
    expect(harness.retryReviewGate).not.toHaveBeenCalled();
    acknowledge();
    await vi.advanceTimersByTimeAsync(0);
    expect(harness.flights[0].autonomyRuntime!.actionHistory[0]).toMatchObject({
      status: "completed",
      metadata: { builderSessionId: "builder", reviewerConversationId: "review-0" },
    });
    harness.flights[0].attempts![0].reviewGate = {
      status: "error",
      reviewerConversationId: "review-0",
    };
    for (const listener of harness.agentListeners) listener();
    await vi.advanceTimersByTimeAsync(0);
    expect(harness.retryReviewGate).not.toHaveBeenCalled();
    builder.status = "idle";
    builder.messages = [
      {
        role: "assistant",
        timestamp: Date.now(),
        isStreaming: false,
        turnOutcome: "completed",
      } as (typeof builder.messages)[number],
    ];
    for (const listener of harness.agentListeners) listener();
    await vi.advanceTimersByTimeAsync(0);
    expect(harness.retryReviewGate).toHaveBeenCalledOnce();
    expect(harness.flights[0].autonomyRuntime!.reviewRetryCounts).toEqual({ "attempt-1": 1 });
  });

  it.each(["active", "streaming", "cancelled", "failed", "unknown", "stopped", "cancelling"])(
    "does not retry review after a repair that is %s",
    async (state) => {
      vi.useFakeTimers();
      vi.setSystemTime(100_000);
      const value = reviewFailureFlight();
      value.attempts![0].reviewGate = {
        status: "changes_requested",
        reviewerConversationId: "review-0",
        report: {
          schemaVersion: 1,
          verdict: "changes_requested",
          summary: "Fix",
          findings: [],
          evidence: [],
        },
      };
      const builder = {
        id: "builder",
        status: "active",
        messages: [{ role: "assistant", timestamp: Date.now(), isStreaming: true }],
      };
      harness.conversations = [builder];
      startReviewFailure(value);
      await vi.advanceTimersByTimeAsync(0);
      expect(harness.sendReviewFindingsToBuilder).toHaveBeenCalledOnce();
      harness.flights[0].attempts![0].reviewGate = {
        status: "error",
        reviewerConversationId: "review-0",
      };
      builder.status = state === "active" ? "active" : "idle";
      builder.messages = [
        {
          role: "assistant",
          timestamp: Date.now(),
          isStreaming: state === "streaming",
          turnOutcome: ["cancelled", "failed"].includes(state)
            ? state
            : state === "unknown"
              ? undefined
              : "completed",
        } as (typeof builder.messages)[number],
      ];
      if (state === "stopped") harness.flights[0].stoppedAt = Date.now();
      if (state === "cancelling") harness.cancellingConversationIds.add("builder");
      for (const listener of harness.agentListeners) listener();
      await vi.advanceTimersByTimeAsync(0);
      expect(harness.retryReviewGate).not.toHaveBeenCalled();
    },
  );

  it("treats a rejected repair dispatch as attention rather than a completed remediation", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(100_000);
    const value = reviewFailureFlight();
    value.attempts![0].reviewGate = {
      status: "changes_requested",
      reviewerConversationId: "review-0",
      report: {
        schemaVersion: 1,
        verdict: "changes_requested",
        summary: "Fix",
        findings: [],
        evidence: [],
      },
    };
    harness.sendReviewFindingsToBuilder.mockRejectedValueOnce(
      new Error("dispatch permission denied"),
    );
    startReviewFailure(value);
    await vi.advanceTimersByTimeAsync(0);
    expect(harness.flights[0].autonomyRuntime).toMatchObject({
      status: "needs_attention",
      hardStopReason: "dispatch permission denied",
    });
    expect(harness.flights[0].autonomyRuntime!.actionHistory[0].status).toBe("failed");
    expect(harness.retryReviewGate).not.toHaveBeenCalled();
  });

  it("backs off repeated reviewer failures and stops after two persisted retries", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(100_000);
    harness.retryReviewGate.mockImplementation(async () => {
      const attempt = harness.flights[0].attempts![0];
      attempt.reviewGate = {
        status: "error",
        reviewerConversationId: `review-${harness.retryReviewGate.mock.calls.length}`,
        completedAt: Date.now(),
      };
      for (const listener of harness.flightListeners) listener();
    });
    startReviewFailure();
    await vi.advanceTimersByTimeAsync(999);
    expect(harness.retryReviewGate).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(harness.retryReviewGate).toHaveBeenCalledTimes(1);
    expect(harness.flights[0].autonomyRuntime!.reviewRetryCounts).toEqual({ "attempt-1": 1 });
    await vi.advanceTimersByTimeAsync(1_999);
    expect(harness.retryReviewGate).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(harness.retryReviewGate).toHaveBeenCalledTimes(2);
    expect(harness.flushPersistence).toHaveBeenCalledTimes(2);
    expect(harness.flights[0].autonomyRuntime).toMatchObject({
      status: "needs_attention",
      reviewRetryCounts: { "attempt-1": 2 },
      hardStopReason: expect.stringContaining("Reviewer retry limit"),
    });
    await vi.advanceTimersByTimeAsync(120_000);
    expect(harness.retryReviewGate).toHaveBeenCalledTimes(2);
  });

  it("does not regain retries when only the durable counter survives reload", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(100_000);
    const value = reviewFailureFlight();
    value.autonomyRuntime!.reviewRetryCounts = { "attempt-1": 2 };
    startReviewFailure(value);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(harness.retryReviewGate).not.toHaveBeenCalled();
    expect(harness.flights[0].autonomyRuntime!.status).toBe("needs_attention");
  });

  it.each(["pause", "stop", "dispose"])("cancels a pending retry on %s", async (operation) => {
    vi.useFakeTimers();
    vi.setSystemTime(100_000);
    startReviewFailure();
    await vi.advanceTimersByTimeAsync(1);
    if (operation === "pause") pauseFlightAutonomy("flight-1");
    if (operation === "stop") await stopFlightAutonomy("flight-1");
    if (operation === "dispose") cleanupRuntime?.();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(harness.retryReviewGate).not.toHaveBeenCalled();
  });

  it("refuses to launch a retry whose allowance could not be saved", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(100_000);
    harness.flushPersistence.mockRejectedValueOnce(new Error("disk unavailable"));
    startReviewFailure();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(harness.retryReviewGate).not.toHaveBeenCalled();
    expect(harness.flights[0].autonomyRuntime).toMatchObject({
      status: "needs_attention",
      hardStopReason: "disk unavailable",
      reviewRetryCounts: { "attempt-1": 1 },
    });
  });

  it.each(["pause", "dispose"])("rechecks %s after saving a reserved retry", async (operation) => {
    vi.useFakeTimers();
    vi.setSystemTime(100_000);
    let resolve!: () => void;
    harness.flushPersistence.mockReturnValueOnce(
      new Promise<void>((done) => {
        resolve = done;
      }),
    );
    startReviewFailure();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(harness.flushPersistence).toHaveBeenCalledOnce();
    if (operation === "pause") pauseFlightAutonomy("flight-1");
    else cleanupRuntime?.();
    resolve();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(harness.retryReviewGate).not.toHaveBeenCalled();
    expect(harness.flights[0].autonomyRuntime!.reviewRetryCounts).toEqual({ "attempt-1": 1 });
  });

  it("honors a lower retry cap saved while the next retry is being reserved", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(100_000);
    let resolve!: () => void;
    harness.flushPersistence.mockReturnValueOnce(
      new Promise<void>((done) => {
        resolve = done;
      }),
    );
    const value = reviewFailureFlight();
    value.autonomyRuntime!.reviewRetryCounts = { "attempt-1": 1 };
    startReviewFailure(value);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(harness.flushPersistence).toHaveBeenCalledOnce();
    harness.flights[0].autonomyPolicy!.maxReviewRounds = 1;
    resolve();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(harness.retryReviewGate).not.toHaveBeenCalled();
    expect(harness.flights[0].autonomyRuntime).toMatchObject({
      status: "needs_attention",
      reviewRetryCounts: { "attempt-1": 2 },
    });
  });

  it.each(["pause", "stop", "dispose"])(
    "revokes a retry's startup guard on %s after the callback begins",
    async (operation) => {
      vi.useFakeTimers();
      vi.setSystemTime(100_000);
      let guard!: () => boolean;
      let resolve!: () => void;
      harness.retryReviewGate.mockImplementationOnce(
        async (_flightId: string, _attemptId: string, canStart: () => boolean) => {
          guard = canStart;
          await new Promise<void>((done) => {
            resolve = done;
          });
        },
      );
      startReviewFailure();
      await vi.advanceTimersByTimeAsync(1_000);
      expect(guard()).toBe(true);
      if (operation === "pause") pauseFlightAutonomy("flight-1");
      else if (operation === "stop") await stopFlightAutonomy("flight-1", false);
      else cleanupRuntime?.();
      expect(guard()).toBe(false);
      resolve();
      await vi.advanceTimersByTimeAsync(0);
    },
  );

  it.each(["override", "new-reviewer", "disable-policy"])(
    "preserves a newer %s decision while a retry reservation is saving",
    async (operation) => {
      vi.useFakeTimers();
      vi.setSystemTime(100_000);
      let resolve!: () => void;
      harness.flushPersistence.mockReturnValueOnce(
        new Promise<void>((done) => {
          resolve = done;
        }),
      );
      startReviewFailure();
      await vi.advanceTimersByTimeAsync(1_000);
      const value = harness.flights[0];
      if (operation === "override") value.attempts![0].reviewGate!.status = "overridden";
      if (operation === "new-reviewer") {
        value.attempts![0].reviewGate = {
          status: "running",
          reviewerConversationId: "manual-review",
        };
      }
      if (operation === "disable-policy") value.autonomyPolicy!.autoReviewRemediation = false;
      resolve();
      await vi.advanceTimersByTimeAsync(10_000);
      expect(harness.retryReviewGate).not.toHaveBeenCalled();
      expect(harness.flights[0].autonomyRuntime!.reviewRetryCounts).toEqual({ "attempt-1": 1 });
      if (operation === "override")
        expect(value.attempts![0].reviewGate!.status).toBe("overridden");
      if (operation === "new-reviewer") {
        expect(value.attempts![0].reviewGate!.reviewerConversationId).toBe("manual-review");
      }
    },
  );
});
