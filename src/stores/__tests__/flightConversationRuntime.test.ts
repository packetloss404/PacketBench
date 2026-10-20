import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Flight } from "@/types/flight";

const state = vi.hoisted(() => ({
  flights: [] as Flight[],
  listeners: vi.fn(),
  hydrate: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/stores/flightStore", () => ({
  useFlightStore: {
    getState: () => ({ flights: state.flights, hydrateFromBackend: state.hydrate }),
    setState: (update: (value: { flights: Flight[] }) => { flights: Flight[] }) => {
      state.flights = update({ flights: state.flights }).flights;
    },
  },
}));
vi.mock("@/stores/asyncAttemptTerminalListeners", () => ({
  syncAsyncAttemptTerminalListeners: state.listeners,
}));
import { runFlightConversationTurn } from "@/stores/flightConversationRuntime";
import { revokeFlightStarts } from "@/lib/flightRunControl";

beforeEach(() => {
  vi.clearAllMocks();
  state.listeners.mockReset().mockResolvedValue(undefined);
  state.flights = [
    {
      id: "flight",
      milestones: [],
      linkedSessionIds: [],
      attempts: [
        {
          id: "attempt",
          sessionId: "builder",
          status: "reviewing",
          reviewGate: { status: "passed", evidence: { headSha: "old" } },
        },
      ],
    } as unknown as Flight,
  ];
});

describe("Flight builder follow-up admission", () => {
  it("keeps the replaced builder readable without starting it beside the resumed builder", async () => {
    state.flights[0].attempts![0].sessionHistory = [
      { sessionId: "builder-before-recovery", provider: "openai", model: "old" },
    ];
    const dispatch = vi.fn();
    await expect(runFlightConversationTurn("builder-before-recovery", dispatch)).rejects.toThrow(
      "replaced during recovery",
    );
    expect(dispatch).not.toHaveBeenCalled();
    expect(state.flights[0].attempts![0].sessionId).toBe("builder");
  });
  it("projects a repair as active and attaches the next terminal listeners before dispatch", async () => {
    const dispatch = vi.fn(async () => {
      expect(state.flights[0].attempts![0]).toMatchObject({
        status: "running",
        reviewGate: { status: "error", evidence: undefined, report: undefined },
      });
      expect(state.listeners).toHaveBeenCalled();
    });
    await runFlightConversationTurn("builder", dispatch);
    expect(dispatch).toHaveBeenCalledOnce();
  });

  it("revokes the old verdict without losing reviewer owners or the durable retry budget", async () => {
    const gate = state.flights[0].attempts![0].reviewGate!;
    gate.reviewerConversationId = "old-reviewer";
    gate.reviewerSessions = [
      { sessionId: "old-reviewer", provider: "openai", model: "review-model" },
    ];
    gate.overriddenAt = 10;
    gate.overrideReason = "old override";
    state.flights[0].autonomyRuntime = {
      status: "running",
      actionHistory: [],
      reviewRetryCounts: { attempt: 2 },
    };
    await runFlightConversationTurn("builder", async () => undefined);
    const after = state.flights[0];
    expect(after.attempts![0].reviewGate).toMatchObject({
      status: "error",
      reviewerConversationId: "old-reviewer",
      reviewerSessions: gate.reviewerSessions,
      evidence: undefined,
      report: undefined,
      overriddenAt: undefined,
      overrideReason: undefined,
    });
    expect(after.autonomyRuntime?.reviewRetryCounts).toEqual({ attempt: 2 });
  });

  it("does not dispatch a late repair after Stop during listener installation", async () => {
    state.listeners.mockImplementationOnce(async () => {
      revokeFlightStarts("flight");
    });
    const dispatch = vi.fn();
    await expect(runFlightConversationTurn("builder", dispatch)).rejects.toThrow("stopped");
    expect(dispatch).not.toHaveBeenCalled();
    expect(state.hydrate).toHaveBeenCalledOnce();
  });

  it.each(["completed", "failed", "cancelled"])(
    "requires explicit recovery for a %s attempt",
    async (status) => {
      state.flights[0].attempts![0].status = status as "completed";
      const dispatch = vi.fn();
      await expect(runFlightConversationTurn("builder", dispatch)).rejects.toThrow(
        "Resume retained work",
      );
      expect(dispatch).not.toHaveBeenCalled();
    },
  );
});
