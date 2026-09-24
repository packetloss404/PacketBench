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
}));
vi.mock("@/lib/tauri", () => ({
  setAttemptReviewGate: (...args: unknown[]) => state.persist(...args),
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: (...args: unknown[]) => state.listen(...args) }));
vi.mock("@/stores/appStore", () => ({
  useAppStore: { getState: () => state, subscribe: vi.fn() },
}));
vi.mock("@/stores/agentConversationPersistence", () => ({ requestConversationSave: vi.fn() }));
vi.mock("@/stores/agentTaskStore", () => ({
  resolveRetiredApiAgent: (agent: string) => agent,
  useAgentTaskStore: {
    getState: () => ({ conversations: state.conversations, createApiConversation: state.launch }),
  },
}));
vi.mock("@/stores/serverStore", () => ({
  useServerStore: { getState: () => ({ getServer: vi.fn() }) },
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
  state.listen.mockResolvedValue(() => {});
  state.initialized = true;
  state.conversations = [];
  state.flights = [
    {
      id: "flight",
      reviewGatePolicy: { enabled: true },
      attempts: [
        {
          id: "attempt",
          status: "reviewing",
          reviewGate: {
            status: "running",
            reviewerConversationId: "review",
            reviewerAgentConfigId: "api-openai",
            reviewerModel: "gpt-test",
          },
        },
      ],
    } as Flight,
  ];
});

describe("reviewer gate lifecycle", () => {
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
