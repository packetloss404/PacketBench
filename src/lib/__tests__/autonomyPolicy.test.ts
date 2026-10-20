import { describe, expect, it } from "vitest";
import {
  DEFAULT_AUTONOMY_POLICY,
  evaluateAutonomyAction,
  pathWithinAllowedRoots,
  pauseAutonomyForRestart,
  reviewerRetryCount,
  reviewerRetryDelayMs,
  validateAutonomyPolicy,
} from "@/lib/autonomyPolicy";
import type { AutonomyActionRecord, AutonomyPolicy, Flight } from "@/types/flight";

function policy(overrides: Partial<AutonomyPolicy> = {}): AutonomyPolicy {
  return {
    ...DEFAULT_AUTONOMY_POLICY,
    allowedRoots: ["D:\\repo"],
    allowedTargets: ["local", "server-1"],
    ...overrides,
  };
}

function flight(overrides: Partial<Flight> = {}): Flight {
  return {
    id: "flight-1",
    title: "Autonomy",
    objective: "Ship safely",
    status: "active",
    priority: "medium",
    projectPath: "D:\\repo",
    workspaceId: null,
    milestones: [],
    linkedSessionIds: [],
    issueIds: [],
    createdAt: 1,
    updatedAt: 1,
    totalCost: 2,
    totalTokens: 0,
    executionMode: "cooperative",
    reviewGatePolicy: {
      enabled: true,
      reviewerAgentConfigId: "api-openai-codex",
      acceptanceCriteria: ["tests pass"],
    },
    autonomyMode: "yolo",
    autonomyPolicy: policy(),
    autonomyRuntime: {
      status: "running",
      startedAt: 1_000,
      actionHistory: [],
    },
    ...overrides,
  };
}

function action(
  kind: AutonomyActionRecord["kind"],
  subjectId: string,
  index: number,
): AutonomyActionRecord {
  return {
    id: `action-${index}`,
    kind,
    subjectId,
    status: "completed",
    reason: "done",
    timestamp: index,
    cost: 1,
  };
}

describe("bounded autonomy policy", () => {
  it("hydrates absent legacy fields as Assisted behavior", () => {
    const legacy = flight({
      autonomyMode: undefined,
      autonomyPolicy: undefined,
      autonomyRuntime: undefined,
    });
    expect(
      evaluateAutonomyAction(legacy, {
        action: "continue",
        now: 2_000,
      }),
    ).toEqual({
      allowed: false,
      reason: "This Flight is in Assisted mode.",
      hardStop: false,
    });
  });

  it("authorizes an in-bounds settings snapshot through the central evaluator", () => {
    const value = flight({ autonomyMode: "settings_default" });
    expect(
      evaluateAutonomyAction(value, {
        action: "launch_ready_task",
        subjectId: "task-1",
        root: "D:\\repo\\src",
        targetId: "local",
        activeAgents: 1,
        now: 2_000,
      }).allowed,
    ).toBe(true);
  });

  it("hard-stops on cost and wall-clock limits", () => {
    const cost = flight({ totalCost: 25 });
    expect(evaluateAutonomyAction(cost, { action: "continue", now: 2_000 })).toMatchObject({
      allowed: false,
      hardStop: true,
      reason: expect.stringContaining("Cost"),
    });

    const duration = flight({
      autonomyRuntime: {
        status: "running",
        startedAt: 1_000,
        actionHistory: [],
      },
      autonomyPolicy: policy({ maxDurationMinutes: 1 }),
    });
    expect(
      evaluateAutonomyAction(duration, {
        action: "continue",
        now: 61_000,
      }),
    ).toMatchObject({
      allowed: false,
      hardStop: true,
      reason: expect.stringContaining("Duration"),
    });
  });

  it("counts persisted retries and reviewer rounds across duplicate events", () => {
    const exhausted = flight({
      autonomyRuntime: {
        status: "running",
        startedAt: 1_000,
        actionHistory: [
          action("recover_attempt", "task-1", 1),
          action("recover_attempt", "task-1", 2),
          action("review_remediation", "attempt-1", 3),
          action("review_remediation", "attempt-1", 4),
        ],
      },
    });
    expect(
      evaluateAutonomyAction(exhausted, {
        action: "recover_attempt",
        subjectId: "task-1",
        now: 2_000,
      }),
    ).toMatchObject({ allowed: false, hardStop: true });
    expect(
      evaluateAutonomyAction(exhausted, {
        action: "review_remediation",
        subjectId: "attempt-1",
        now: 2_000,
      }),
    ).toMatchObject({ allowed: false, hardStop: true });
  });

  it("waits at concurrency without turning a normal queue into a hard stop", () => {
    expect(
      evaluateAutonomyAction(flight(), {
        action: "launch_ready_task",
        subjectId: "task-1",
        activeAgents: 3,
        now: 2_000,
      }),
    ).toMatchObject({ allowed: false, hardStop: false });
  });

  it("bounds reviewer restarts across changing session ids and preserves earned acceptance", () => {
    const value = flight();
    value.autonomyRuntime!.actionHistory = [
      action("retry_review", "attempt-1", 1),
      action("retry_review", "attempt-1", 2),
    ];
    expect(
      evaluateAutonomyAction(value, {
        action: "retry_review",
        subjectId: "attempt-1",
        now: 2_000,
      }),
    ).toMatchObject({
      allowed: false,
      hardStop: true,
      reason: expect.stringContaining("retry limit"),
    });
    expect(
      evaluateAutonomyAction(value, {
        action: "accept_review_pass",
        subjectId: "attempt-1",
        now: 2_000,
      }).allowed,
    ).toBe(true);
    expect(
      evaluateAutonomyAction(value, {
        action: "retry_review",
        subjectId: "another-attempt",
        now: 2_000,
      }).allowed,
    ).toBe(true);
  });

  it("keeps the retry limit after activity eviction and fails closed on corrupt counts", () => {
    const value = flight();
    value.autonomyRuntime!.reviewRetryCounts = { "attempt-1": 2 };
    expect(value.autonomyRuntime!.actionHistory).toEqual([]);
    expect(reviewerRetryCount(value, "attempt-1")).toBe(2);
    expect(
      evaluateAutonomyAction(value, {
        action: "retry_review",
        subjectId: "attempt-1",
        now: 2_000,
      }).allowed,
    ).toBe(false);
    value.autonomyRuntime!.reviewRetryCounts["attempt-1"] = -1;
    expect(reviewerRetryCount(value, "attempt-1")).toBe(Number.POSITIVE_INFINITY);
  });

  it("migrates legacy retry history conservatively and caps exponential backoff", () => {
    const value = flight();
    expect(reviewerRetryDelayMs(value, "attempt-1")).toBe(1_000);
    value.autonomyRuntime!.actionHistory = [action("retry_review", "attempt-1", 1)];
    value.autonomyRuntime!.reviewRetryCounts = { "attempt-1": 0 };
    expect(reviewerRetryCount(value, "attempt-1")).toBe(1);
    expect(reviewerRetryDelayMs(value, "attempt-1")).toBe(2_000);
    value.autonomyRuntime!.reviewRetryCounts["attempt-1"] = 20;
    expect(reviewerRetryDelayMs(value, "attempt-1")).toBe(60_000);
  });

  it("rejects root, SSH target, reviewer, graph, and publish policy expansion", () => {
    expect(pathWithinAllowedRoots("D:\\repo\\src", ["D:\\repo"])).toBe(true);
    expect(pathWithinAllowedRoots("D:\\other", ["D:\\repo"])).toBe(false);
    expect(
      evaluateAutonomyAction(flight(), {
        action: "continue",
        root: "D:\\other",
        targetId: "local",
        now: 2_000,
      }),
    ).toMatchObject({ allowed: false, hardStop: true });
    expect(
      evaluateAutonomyAction(flight(), {
        action: "continue",
        root: "D:\\repo",
        targetId: "server-2",
        now: 2_000,
      }),
    ).toMatchObject({ allowed: false, hardStop: true });
    expect(validateAutonomyPolicy(policy(), flight({ executionMode: "independent" }))).toContain(
      "Auto-run task graph requires Cooperative execution mode.",
    );
    expect(validateAutonomyPolicy(policy(), flight({ reviewGatePolicy: undefined }))).toContain(
      "Auto-run task graph requires an independent Reviewer Gate.",
    );
    expect(
      validateAutonomyPolicy(
        policy({ allowDraftPrPublishing: false }),
        flight({ publishAttemptsAsPrs: true }),
      ),
    ).toContain("Draft-PR publishing is not allowed by this autonomy policy.");
  });

  it("never resumes a running policy after reload", () => {
    const runtime = pauseAutonomyForRestart(
      { status: "running", startedAt: 1, actionHistory: [] },
      5_000,
    );
    expect(runtime).toMatchObject({
      status: "paused",
      pausedAt: 5_000,
      hardStopReason: expect.stringContaining("Resume explicitly"),
    });
    const stopped = { status: "stopped" as const, actionHistory: [] };
    expect(pauseAutonomyForRestart(stopped, 5_000)).toBe(stopped);
  });
});
