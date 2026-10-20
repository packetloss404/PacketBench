import { describe, it, expect, beforeEach, vi } from "vitest";
import type { PersistedState } from "@/lib/tauri";
import type { Attempt, Flight } from "@/types/flight";
import type { FlightPlanInput } from "@/lib/flightPlanning";

// Mock tauri functions
vi.mock("@/lib/tauri", () => ({
  loadPersistedState: vi.fn().mockResolvedValue({
    version: 1,
    flights: [],
    agents: [],
    settings: { maxParallelSessions: 3, milestoneGating: true, projectPath: "." },
    ui: {},
  }),
  saveFlightsSlice: vi.fn().mockResolvedValue(undefined),
  saveUiSlice: vi.fn().mockResolvedValue(undefined),
}));

// Mock issueStore
vi.mock("@/stores/issueStore", () => ({
  useIssueStore: {
    getState: vi.fn().mockReturnValue({
      issues: [],
      assignToFlight: vi.fn(),
    }),
  },
}));

import { useFlightStore } from "@/stores/flightStore";
import { useIssueStore } from "@/stores/issueStore";
import { saveFlightsSlice, saveUiSlice } from "@/lib/tauri";

function makePersistedState(
  flights: ReturnType<typeof useFlightStore.getState>["flights"],
): PersistedState {
  return {
    version: 1,
    flights,
    agents: [],
    issues: [],
    settings: { maxParallelSessions: 3, milestoneGating: true, projectPath: "." },
    ui: {},
    workspaces: [],
    memoryEvents: [],
    memoryPatterns: [],
    servers: [],
    cliAccounts: [],
    cliAccountDefaults: {},
  };
}

function setMockIssues(issues: Array<{ id: string; flightId: string | null }>) {
  vi.mocked(useIssueStore.getState).mockReturnValue({
    issues,
    assignToFlight: vi.fn(),
  } as unknown as ReturnType<typeof useIssueStore.getState>);
}

const plan: FlightPlanInput = {
  title: "Repair a regression",
  objective: "Preserve existing behavior and fix the failing case",
  milestones: [
    {
      key: "repair",
      title: "Repair",
      description: "Scoped implementation and verification",
      validationCriteria: ["Regression check passes"],
      tasks: [
        {
          key: "implement",
          title: "Implement the fix",
          description: "Repair the failing case",
          type: "implementation",
          dependsOn: [],
          ownedPaths: ["src/example.ts"],
        },
        {
          key: "verify",
          title: "Verify the fix",
          description: "Exercise the regression",
          type: "testing",
          dependsOn: ["implement"],
          ownedPaths: ["tests/example.test.ts"],
        },
      ],
    },
  ],
};
function plannedFlight(): Flight {
  const flight = useFlightStore
    .getState()
    .addFlight({ title: "Repair", objective: "Repair", priority: "medium", projectPath: "/repo" });
  useFlightStore.getState().applyFlightPlan(flight.id, plan);
  return useFlightStore.getState().flights.find((item) => item.id === flight.id)!;
}
function executionAttempt(flight: Flight, patch: Partial<Attempt> = {}): Attempt {
  return {
    id: "attempt-1",
    flightId: flight.id,
    target: { kind: "local", basePath: "/repo", worktreePath: "/repo/.worktrees/attempt-1" },
    agentConfigId: "api-sugar",
    model: "test-model",
    provider: "sugar",
    branch: "pkt/attempt-1",
    baseBranch: "main",
    sessionId: "builder",
    status: "running",
    cost: 0,
    tokens: 0,
    taskId: flight.milestones[0].tasks[0].id,
    ...patch,
  };
}

describe("flightStore", () => {
  beforeEach(async () => {
    await useFlightStore
      .getState()
      .flushPersistence()
      .catch(() => undefined);
    localStorage.clear();
    vi.clearAllMocks();
    setMockIssues([]);
    useFlightStore.setState({
      flights: [],
      activeFlightId: null,
    });
  });

  it("addFlight creates a flight with correct defaults", () => {
    const flight = useFlightStore.getState().addFlight({
      title: "Test Flight",
      objective: "Build something",
      priority: "high",
      projectPath: "/tmp/project",
    });

    expect(flight.title).toBe("Test Flight");
    expect(flight.objective).toBe("Build something");
    expect(flight.priority).toBe("high");
    expect(flight.projectPath).toBe("/tmp/project");
    expect(flight.status).toBe("draft");
    expect(flight.milestones).toEqual([]);
    expect(flight.linkedSessionIds).toEqual([]);
    expect(flight.issueIds).toEqual([]);
    expect(flight.id).toMatch(/^flight_/);
    expect(flight.totalCost).toBe(0);
    expect(flight.totalTokens).toBe(0);

    const { flights } = useFlightStore.getState();
    expect(flights).toHaveLength(1);
    expect(flights[0].id).toBe(flight.id);
  });

  it("deleteFlight removes the flight", () => {
    const flight = useFlightStore.getState().addFlight({
      title: "To Delete",
      objective: "Will be removed",
      priority: "low",
      projectPath: ".",
    });

    useFlightStore.getState().deleteFlight(flight.id);

    expect(useFlightStore.getState().flights).toHaveLength(0);
  });

  it("updateFlight updates fields", () => {
    const flight = useFlightStore.getState().addFlight({
      title: "Original",
      objective: "Obj",
      priority: "medium",
      projectPath: ".",
    });

    useFlightStore.getState().updateFlight(flight.id, { title: "New Title" });

    const updated = useFlightStore.getState().flights.find((f) => f.id === flight.id);
    expect(updated?.title).toBe("New Title");
    expect(updated?.objective).toBe("Obj"); // unchanged field preserved
  });

  it("flushPersistence waits for the queued backend Flight save", async () => {
    let release!: () => void;
    vi.mocked(saveFlightsSlice).mockImplementationOnce(
      () => new Promise<void>((resolve) => (release = resolve)),
    );

    useFlightStore.getState().addFlight({
      title: "Persist before launch",
      objective: "Do not race the first attempt",
      priority: "medium",
      projectPath: ".",
    });

    let flushed = false;
    const flush = useFlightStore
      .getState()
      .flushPersistence()
      .then(() => (flushed = true));
    await Promise.resolve();
    expect(flushed).toBe(false);

    release();
    await flush;
    expect(flushed).toBe(true);
  });

  it("setActiveFlight sets activeFlightId and persists it", async () => {
    const flight = useFlightStore.getState().addFlight({
      title: "Active Flight",
      objective: "Test active",
      priority: "high",
      projectPath: ".",
    });

    expect(useFlightStore.getState().activeFlightId).toBeNull();

    useFlightStore.getState().setActiveFlight(flight.id);

    expect(useFlightStore.getState().activeFlightId).toBe(flight.id);

    // persist-on-set: activeFlightId is written through to the ui slice
    await new Promise((r) => setTimeout(r, 0));
    expect(vi.mocked(saveUiSlice)).toHaveBeenCalledWith({ selectedFlightId: flight.id });

    useFlightStore.getState().setActiveFlight(null);
    expect(useFlightStore.getState().activeFlightId).toBeNull();
  });

  it("computeFlightStatus returns draft for empty flight", () => {
    const flight = useFlightStore.getState().addFlight({
      title: "Empty Flight",
      objective: "No milestones",
      priority: "low",
      projectPath: ".",
    });

    const status = useFlightStore.getState().computeFlightStatus(flight.id);
    expect(status).toBe("draft");
  });

  it("reconciles flight issueIds from issue flight assignments", () => {
    const flight = useFlightStore.getState().addFlight({
      title: "Linked Flight",
      objective: "Link test",
      priority: "medium",
      projectPath: ".",
    });
    const otherFlight = useFlightStore.getState().addFlight({
      title: "Other Flight",
      objective: "Other link test",
      priority: "medium",
      projectPath: ".",
      issueIds: ["stale_issue"],
    });

    setMockIssues([
      { id: "issue_1", flightId: flight.id },
      { id: "issue_2", flightId: flight.id },
      { id: "issue_3", flightId: null },
      { id: "issue_4", flightId: "missing_flight" },
    ]);

    useFlightStore.getState().reconcileIssueLinks({ persist: false, touchUpdatedAt: false });

    const flights = useFlightStore.getState().flights;
    expect(flights.find((f) => f.id === flight.id)?.issueIds).toEqual(["issue_1", "issue_2"]);
    expect(flights.find((f) => f.id === otherFlight.id)?.issueIds).toEqual([]);
  });

  it("reconciles issue links after backend hydration", async () => {
    const backendFlight = {
      ...useFlightStore.getState().addFlight({
        title: "Backend Flight",
        objective: "Hydrate link test",
        priority: "medium",
        projectPath: ".",
      }),
      issueIds: [],
    };
    setMockIssues([{ id: "issue_hydrated", flightId: backendFlight.id }]);
    useFlightStore.setState({ flights: [], activeFlightId: null });

    await useFlightStore.getState().hydrateFromBackend(makePersistedState([backendFlight]));

    expect(useFlightStore.getState().flights[0].issueIds).toEqual(["issue_hydrated"]);
  });

  describe("reviewed plan identity", () => {
    it("rejects a dependency cycle before replacing an otherwise valid draft plan", () => {
      const flight = plannedFlight();
      const cyclic = {
        ...plan,
        milestones: plan.milestones.map((milestone) => ({
          ...milestone,
          tasks: milestone.tasks.map((task) =>
            task.key === "implement" ? { ...task, dependsOn: ["verify"] } : task,
          ),
        })),
      };
      expect(() => useFlightStore.getState().applyFlightPlan(flight.id, cyclic)).toThrow(/cycl/i);
      expect(useFlightStore.getState().flights[0].milestones).toEqual(flight.milestones);
    });
    it("keeps task and dependency IDs plus explicit assignments when refining a plan before execution", () => {
      const flight = plannedFlight();
      const originalIds = flight.milestones[0].tasks.map((task) => task.id);
      const assigned = flight.milestones.map((milestone) => ({
        ...milestone,
        tasks: milestone.tasks.map((task) => ({
          ...task,
          agentConfigId: "api-openai-agents",
          model: "chosen-model",
          createdAt: 42,
        })),
      }));
      useFlightStore.getState().updateFlight(flight.id, { milestones: assigned });
      useFlightStore
        .getState()
        .applyFlightPlan(flight.id, {
          ...plan,
          title: "Refined repair",
          milestones: plan.milestones.map((milestone) => ({
            ...milestone,
            tasks: milestone.tasks.map((task) => ({
              ...task,
              description: `Clarified: ${task.description}`,
            })),
          })),
        });
      const refined = useFlightStore.getState().flights[0];
      expect(refined.title).toBe("Refined repair");
      expect(refined.milestones[0].id).toBe(flight.milestones[0].id);
      expect(refined.milestones[0].tasks.map((task) => task.id)).toEqual(originalIds);
      expect(refined.milestones[0].tasks[1].dependsOn).toEqual([originalIds[0]]);
      for (const task of refined.milestones[0].tasks) {
        expect(task).toMatchObject({
          agentConfigId: "api-openai-agents",
          model: "chosen-model",
          createdAt: 42,
        });
        expect(task.description).toContain("Clarified:");
      }
    });

    it("rejects plan replacement after even a failed attempt and leaves the existing plan untouched", () => {
      const flight = plannedFlight();
      useFlightStore.setState({
        flights: [{ ...flight, attempts: [executionAttempt(flight, { status: "failed" })] }],
      });
      const before = useFlightStore.getState().flights[0];
      expect(() =>
        useFlightStore.getState().applyFlightPlan(flight.id, { ...plan, title: "Replacement" }),
      ).toThrow(/after execution starts/i);
      expect(useFlightStore.getState().flights[0]).toEqual(before);
    });

    it.each(["started", "finished", "usage"])(
      "rejects replacement when task execution is recorded by %s without an attempt",
      (evidence) => {
        const flight = plannedFlight();
        const taskPatch =
          evidence === "started"
            ? { startedAt: 10 }
            : evidence === "finished"
              ? { status: "done" as const, completedAt: 20 }
              : { cost: 0.1, tokens: 100 };
        const executed = {
          ...flight,
          milestones: flight.milestones.map((milestone) => ({
            ...milestone,
            tasks: milestone.tasks.map((task, index) =>
              index === 0 ? { ...task, ...taskPatch } : task,
            ),
          })),
        };
        useFlightStore.setState({ flights: [executed] });
        expect(() => useFlightStore.getState().applyFlightPlan(flight.id, plan)).toThrow(
          /after execution starts/i,
        );
        expect(useFlightStore.getState().flights[0].milestones).toEqual(executed.milestones);
      },
    );

    it("also rejects identity replacement through updateFlight while permitting same-task runtime updates", () => {
      const flight = plannedFlight();
      const attempt = executionAttempt(flight);
      useFlightStore.setState({ flights: [{ ...flight, attempts: [attempt] }] });
      const replacement = flight.milestones.map((milestone) => ({
        ...milestone,
        tasks: milestone.tasks.map((task, index) =>
          index === 0 ? { ...task, id: "replacement-task" } : task,
        ),
      }));
      expect(() =>
        useFlightStore.getState().updateFlight(flight.id, { milestones: replacement }),
      ).toThrow(/cannot be replaced/i);
      expect(() => useFlightStore.getState().updateFlight(flight.id, { milestones: [] })).toThrow(
        /cannot be replaced/i,
      );
      const progress = flight.milestones.map((milestone) => ({
        ...milestone,
        tasks: milestone.tasks.map((task, index) =>
          index === 0
            ? { ...task, status: "running" as const, sessionId: attempt.sessionId }
            : task,
        ),
      }));
      useFlightStore.getState().updateFlight(flight.id, { milestones: progress });
      expect(useFlightStore.getState().flights[0].milestones[0].tasks[0]).toMatchObject({
        id: attempt.taskId,
        status: "running",
        sessionId: attempt.sessionId,
      });
    });
  });

  describe("archive retains recoverable work", () => {
    it.each(["queued", "provisioning", "running", "reviewer"])(
      "refuses archive with active %s work",
      (phase) => {
        const flight = plannedFlight();
        const attempt = executionAttempt(
          flight,
          phase === "reviewer"
            ? {
                status: "reviewing",
                reviewGate: { status: "running", reviewerConversationId: "reviewer" },
              }
            : { status: phase as "queued" | "provisioning" | "running" },
        );
        useFlightStore.setState({ flights: [{ ...flight, attempts: [attempt] }] });
        expect(() => useFlightStore.getState().archiveFlight(flight.id)).toThrow(
          /stop the flight/i,
        );
        expect(useFlightStore.getState().flights[0].archivedAt).toBeUndefined();
        expect(useFlightStore.getState().flights[0].attempts).toEqual([attempt]);
      },
    );

    it("refuses archive while a task is running even without an attempt record", () => {
      const flight = plannedFlight();
      useFlightStore.setState({
        flights: [
          {
            ...flight,
            milestones: flight.milestones.map((milestone) => ({
              ...milestone,
              tasks: milestone.tasks.map((task) => ({ ...task, status: "running" as const })),
            })),
          },
        ],
      });
      expect(() => useFlightStore.getState().archiveFlight(flight.id)).toThrow(/stop the flight/i);
    });

    it("round-trips archive and restore without discarding retained files, review evidence, or identity", async () => {
      const flight = plannedFlight();
      const attempt = executionAttempt(flight, {
        status: "cancelled",
        recovery: { state: "retained", retainedAt: 100, reason: "Desktop restarted" },
        reviewGate: {
          status: "error",
          errorMessage: "Review interrupted",
          evidence: {
            fingerprint: "review-fingerprint",
            contextFingerprint: "criteria-fingerprint",
            baseSha: "base-sha",
            headSha: "reviewed-sha",
          },
        },
      });
      useFlightStore.setState({
        flights: [
          {
            ...flight,
            attempts: [attempt],
            coordinationLog: [
              {
                id: "event",
                flightId: flight.id,
                type: "handoff",
                summary: "Preserved result",
                timestamp: 1,
              },
            ],
          },
        ],
      });
      useFlightStore.getState().archiveFlight(flight.id);
      expect(useFlightStore.getState().flights[0].archivedAt).toBeGreaterThan(0);
      expect(() => useFlightStore.getState().applyFlightPlan(flight.id, plan)).toThrow();
      useFlightStore.getState().unarchiveFlight(flight.id);
      await useFlightStore.getState().flushPersistence();
      const restored = useFlightStore.getState().flights[0];
      expect(restored.archivedAt).toBeUndefined();
      expect(restored.attempts).toEqual([attempt]);
      expect(restored.milestones).toEqual(flight.milestones);
      expect(restored.coordinationLog).toHaveLength(1);
      expect(saveFlightsSlice).toHaveBeenLastCalledWith([restored]);
    });
  });
});
