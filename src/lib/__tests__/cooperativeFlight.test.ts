import { describe, expect, it } from "vitest";
import {
  buildCooperativeTaskPrompt,
  selectCooperativeTaskViews,
  selectReadyCooperativeTasks,
  validateCooperativeAssignments,
  validateCooperativeGraph,
} from "@/lib/cooperativeFlight";
import type { Flight, Task } from "@/types/flight";

function task(id: string, dependsOn: string[] = [], overrides: Partial<Task> = {}): Task {
  return {
    id,
    milestoneId: "milestone-1",
    flightId: "flight-1",
    title: id,
    description: `Implement ${id}`,
    order: 0,
    status: "pending",
    type: "implementation",
    role: "builder",
    agentConfigId: "api-claude",
    model: "claude-sonnet-4-6",
    ownedPaths: [`src/${id}`],
    dependsOn,
    sessionId: null,
    createdAt: 1,
    cost: 0,
    tokens: 0,
    ...overrides,
  };
}

function flight(tasks: Task[]): Flight {
  return {
    id: "flight-1",
    title: "Graph",
    objective: "Build the graph",
    status: "ready",
    priority: "medium",
    projectPath: "/repo",
    workspaceId: null,
    milestones: [
      {
        id: "milestone-1",
        flightId: "flight-1",
        title: "Milestone",
        description: "Ship",
        order: 0,
        status: "pending",
        tasks,
        validationCriteria: ["Tests pass"],
      },
    ],
    linkedSessionIds: [],
    issueIds: [],
    createdAt: 1,
    updatedAt: 1,
    totalCost: 0,
    totalTokens: 0,
    executionMode: "cooperative",
  };
}

describe("cooperative Flight graph", () => {
  it("rejects missing dependencies and cycles", () => {
    expect(validateCooperativeGraph(flight([task("a", ["missing"])]))).toEqual(
      expect.arrayContaining([expect.objectContaining({ kind: "missing_dependency" })]),
    );
    expect(validateCooperativeGraph(flight([task("a", ["b"]), task("b", ["a"])]))).toEqual(
      expect.arrayContaining([expect.objectContaining({ kind: "dependency_cycle" })]),
    );
  });

  it("computes ready, blocked, running, review, integrated, and failed deterministically", () => {
    const value = flight([
      task("ready"),
      task("blocked", ["ready"]),
      task("running"),
      task("review"),
      task("done", [], { status: "done" }),
      task("failed", [], { status: "failed" }),
    ]);
    value.attempts = [
      {
        id: "att-running",
        flightId: value.id,
        target: { kind: "local", basePath: "/repo", worktreePath: "/run" },
        agentConfigId: "api-claude",
        model: "claude-sonnet-4-6",
        provider: "claude",
        branch: "pkt/run",
        baseBranch: "packetbench/flight/flight-1",
        sessionId: "run",
        taskId: "running",
        status: "running",
        cost: 0,
        tokens: 0,
      },
      {
        id: "att-review",
        flightId: value.id,
        target: { kind: "local", basePath: "/repo", worktreePath: "/review" },
        agentConfigId: "api-claude",
        model: "claude-sonnet-4-6",
        provider: "claude",
        branch: "pkt/review",
        baseBranch: "packetbench/flight/flight-1",
        sessionId: "review",
        taskId: "review",
        status: "reviewing",
        cost: 0,
        tokens: 0,
      },
    ];
    const states = Object.fromEntries(
      selectCooperativeTaskViews(value).map((view) => [view.task.id, view.state]),
    );
    expect(states).toEqual({
      ready: "ready",
      blocked: "blocked",
      running: "running",
      review: "review",
      done: "integrated",
      failed: "failed",
    });
    expect(selectReadyCooperativeTasks(value).map((item) => item.id)).toEqual(["ready"]);
  });

  it("blocks missing assignments and overlapping ownership", () => {
    const value = flight([
      task("a", [], { agentConfigId: "unassigned", model: undefined, ownedPaths: ["src"] }),
      task("b", [], { ownedPaths: ["src/nested"] }),
    ]);
    const kinds = validateCooperativeAssignments(value).map((issue) => issue.kind);
    expect(kinds).toEqual(
      expect.arrayContaining(["missing_assignment", "missing_model", "ownership_conflict"]),
    );
  });

  it("builds a task-scoped prompt with ownership, dependencies, checks, and commit requirement", () => {
    const upstream = task("upstream", [], { status: "done" });
    const downstream = task("downstream", ["upstream"]);
    const prompt = buildCooperativeTaskPrompt(flight([upstream, downstream]), downstream);
    expect(prompt).toContain("src/downstream");
    expect(prompt).toContain("upstream: integrated");
    expect(prompt).toContain("Tests pass");
    expect(prompt).toContain("commit all changes");
  });
  it("allows overlapping paths only for tasks ordered by a valid dependency path", () => {
    const ordered = flight([
      task("a", [], { ownedPaths: ["src"] }),
      task("b", ["a"], { ownedPaths: ["src/file.ts"] }),
      task("c", ["b"], { ownedPaths: ["src/file.ts"] }),
    ]);
    expect(validateCooperativeAssignments(ordered)).toEqual([]);
    const concurrent = flight([
      task("a", [], { ownedPaths: ["src"] }),
      task("b", [], { ownedPaths: ["src/file.ts"] }),
    ]);
    expect(
      validateCooperativeAssignments(concurrent).some(
        (issue) => issue.kind === "ownership_conflict",
      ),
    ).toBe(true);
    const cyclic = flight([
      task("a", ["b"], { ownedPaths: ["src"] }),
      task("b", ["a"], { ownedPaths: ["src"] }),
    ]);
    expect(
      validateCooperativeGraph(cyclic).some((issue) => issue.kind === "dependency_cycle"),
    ).toBe(true);
    expect(
      validateCooperativeAssignments(cyclic).some((issue) => issue.kind === "ownership_conflict"),
    ).toBe(true);
  });
});
