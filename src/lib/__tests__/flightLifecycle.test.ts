import { describe, expect, it } from "vitest";
import { flightLifecycleStatus, projectFlightLifecycle } from "@/lib/flightLifecycle";
import type { Attempt, Flight, Task } from "@/types/flight";

function attempt(overrides: Partial<Attempt> = {}): Attempt {
  return {
    id: "attempt",
    flightId: "flight",
    status: "completed",
    sessionId: "builder",
    branch: "attempt",
    baseBranch: "main",
    provider: "anthropic",
    agentConfigId: "api-claude",
    model: "model",
    target: { kind: "local", basePath: "/repo", worktreePath: "/repo/worktree" },
    cost: 0,
    tokens: 0,
    ...overrides,
  };
}
function task(id: string, status: Task["status"] = "pending"): Task {
  return {
    id,
    milestoneId: "milestone",
    flightId: "flight",
    title: id,
    description: id,
    type: "implementation",
    status,
    agentConfigId: "api-claude",
    order: 0,
    dependsOn: [],
    sessionId: null,
    createdAt: 1,
    cost: 0,
    tokens: 0,
  };
}
function flight(overrides: Partial<Flight> = {}): Flight {
  return {
    id: "flight",
    title: "Fix",
    objective: "Deliver a fix",
    status: "ready",
    priority: "medium",
    projectPath: "/repo",
    workspaceId: null,
    milestones: [],
    linkedSessionIds: [],
    issueIds: [],
    createdAt: 1,
    updatedAt: 1,
    totalCost: 0,
    totalTokens: 0,
    ...overrides,
  };
}

it("shows active owned planning work and prevents premature delivery", () => {
  const value = flight({ planningConversationId: "planner", attempts: [attempt()] });
  expect(projectFlightLifecycle(value, { activeSessionCount: 1 })).toMatchObject({
    phase: "running",
    nextAction: "stop",
    activeCount: 1,
  });
});
function graph(tasks: Task[], attempts: Attempt[]): Flight {
  return flight({
    executionMode: "cooperative",
    milestones: [
      {
        id: "milestone",
        flightId: "flight",
        title: "Build",
        description: "Build",
        order: 0,
        status: "active",
        validationCriteria: [],
        tasks,
      },
    ],
    attempts,
    integrationBranch: {
      branch: "integration",
      baseBranch: "main",
      baseSha: "base",
      headSha: "head",
      worktreePath: "/integration",
      targetKind: "local",
      status: "ready",
    },
  });
}

describe("shared Flight lifecycle", () => {
  it("keeps an accepted result ready to deliver until a delivery is recorded", () => {
    const value = flight({ attempts: [attempt()] });
    expect(projectFlightLifecycle(value).phase).toBe("ready_to_deliver");
    expect(flightLifecycleStatus(value)).toBe("review");
  });
  it("does not finish a graph after its first accepted task", () => {
    const value = graph(
      [task("a", "done"), { ...task("b"), dependsOn: ["a"] }],
      [attempt({ taskId: "a" })],
    );
    expect(projectFlightLifecycle(value).phase).toBe("running");
    expect(flightLifecycleStatus(value)).toBe("active");
  });
  it("requires accepted attempts for every required graph node", () => {
    expect(
      projectFlightLifecycle(
        graph([task("a", "done"), task("b", "done")], [attempt({ taskId: "a" })]),
      ).phase,
    ).toBe("running");
    expect(
      projectFlightLifecycle(
        graph(
          [task("a", "done"), task("b", "done")],
          [attempt({ id: "a", taskId: "a" }), attempt({ id: "b", taskId: "b" })],
        ),
      ).phase,
    ).toBe("ready_to_deliver");
  });
  it("treats a recorded delivery as completion, including a chosen result after Stop", () => {
    const value = flight({
      stoppedAt: 2,
      attempts: [attempt()],
      delivery: {
        kind: "landed",
        branch: "attempt",
        baseBranch: "main",
        deliveredAt: 3,
        commitSha: "head",
      },
    });
    expect(projectFlightLifecycle(value).phase).toBe("delivered");
    expect(flightLifecycleStatus(value)).toBe("done");
  });
  it("never calls an active sibling finished just because another result was published", () => {
    const value = flight({
      attempts: [attempt({ status: "running" })],
      delivery: {
        kind: "pull_request",
        branch: "attempt",
        baseBranch: "main",
        deliveredAt: 3,
        prNumber: 12,
      },
    });
    expect(projectFlightLifecycle(value).phase).toBe("running");
  });
  it("shows retained files and stale reviewer evidence as attention", () => {
    expect(
      projectFlightLifecycle(
        flight({
          attempts: [
            attempt({
              status: "cancelled",
              recovery: { state: "retained", retainedAt: 2, reason: "interrupted" },
            }),
          ],
        }),
      ).phase,
    ).toBe("needs_attention");
    expect(
      projectFlightLifecycle(
        flight({ attempts: [attempt({ reviewGate: { status: "error", errorMessage: "stale" } })] }),
      ).phase,
    ).toBe("needs_attention");
  });
  it("gives pending provider approvals priority while keeping Stop available", () => {
    const view = projectFlightLifecycle(flight({ attempts: [attempt({ status: "running" })] }), {
      pendingApprovalCount: 2,
    });
    expect(view).toMatchObject({ phase: "needs_attention", activeCount: 1, attentionCount: 2 });
  });
  it("does not turn archival or legacy done labels into an invented delivery", () => {
    expect(flightLifecycleStatus(flight({ status: "done", attempts: [attempt()] }))).toBe("review");
    expect(projectFlightLifecycle(flight({ archivedAt: 3 })).phase).toBe("archived");
    expect(flightLifecycleStatus(flight({ archivedAt: 3 }))).toBe("paused");
  });
  it("blocks orphan task attempts even with a passing reviewer", () => {
    expect(
      projectFlightLifecycle(
        graph([task("current")], [attempt({ taskId: "orphan", reviewGate: { status: "passed" } })]),
      ).phase,
    ).toBe("needs_attention");
  });
});
