import { describe, expect, it } from "vitest";
import {
  DEFAULT_STALL_THRESHOLD_MS,
  isAttemptStalled,
  isFlightStuck,
  issuesToFlagNeedsHuman,
  reassignTargetFromEscalation,
  shouldEscalate,
  shouldEscalateStalled,
  stuckSignature,
  suggestReassignmentAgent,
} from "@/lib/flightCoordination";
import type { Attempt, AttemptStatus, CoordinationEvent } from "@/types/flight";

function attempt(id: string, status: AttemptStatus): Attempt {
  return {
    id,
    flightId: "flight-1",
    target: { kind: "local", basePath: "/repo", worktreePath: "/repo/wt" },
    agentConfigId: "agent-1",
    model: "sonnet",
    provider: "anthropic",
    branch: "b",
    baseBranch: "main",
    sessionId: `sess-${id}`,
    status,
    cost: 0,
    tokens: 0,
  };
}

function escalation(signature: string): CoordinationEvent {
  return {
    id: `coord-${signature}`,
    flightId: "flight-1",
    type: "escalation",
    summary: "stuck",
    timestamp: 1,
    metadata: { signature },
  };
}

describe("isFlightStuck", () => {
  it("is false with no attempts", () => {
    expect(isFlightStuck([])).toBe(false);
  });

  it("is false when any attempt is still active or reviewable", () => {
    expect(isFlightStuck([attempt("a", "failed"), attempt("b", "running")])).toBe(false);
    expect(isFlightStuck([attempt("a", "failed"), attempt("b", "reviewing")])).toBe(false);
    expect(isFlightStuck([attempt("a", "failed"), attempt("b", "completed")])).toBe(false);
    expect(isFlightStuck([attempt("a", "queued")])).toBe(false);
  });

  it("is false when all attempts cancelled but none failed", () => {
    expect(isFlightStuck([attempt("a", "cancelled"), attempt("b", "cancelled")])).toBe(false);
  });

  it("is true when all terminal and at least one failed", () => {
    expect(isFlightStuck([attempt("a", "failed")])).toBe(true);
    expect(isFlightStuck([attempt("a", "failed"), attempt("b", "cancelled")])).toBe(true);
  });
});

describe("stuckSignature", () => {
  it("is order-independent", () => {
    const a = attempt("a", "failed");
    const b = attempt("b", "cancelled");
    expect(stuckSignature([a, b])).toBe(stuckSignature([b, a]));
  });

  it("changes when a new attempt appears (re-run)", () => {
    const first = [attempt("a", "failed")];
    const rerun = [attempt("a", "failed"), attempt("b", "failed")];
    expect(stuckSignature(first)).not.toBe(stuckSignature(rerun));
  });
});

describe("shouldEscalate", () => {
  it("is false when the flight is not stuck", () => {
    expect(shouldEscalate([attempt("a", "running")], [])).toBe(false);
  });

  it("is true for a fresh stuck state with no prior escalation", () => {
    expect(shouldEscalate([attempt("a", "failed")], [])).toBe(true);
  });

  it("dedupes against an existing escalation with the matching signature", () => {
    const attempts = [attempt("a", "failed")];
    const log = [escalation(stuckSignature(attempts))];
    expect(shouldEscalate(attempts, log)).toBe(false);
  });

  it("escalates again after a re-run adds new attempts", () => {
    const first = [attempt("a", "failed")];
    const log = [escalation(stuckSignature(first))];
    const rerun = [attempt("a", "failed"), attempt("b", "failed")];
    expect(shouldEscalate(rerun, log)).toBe(true);
  });

  it("escalates when a cancel completes the stuck state (fail + cancel)", () => {
    // A failed while B was running (not stuck, no escalation yet), then B is
    // cancelled — the flight is now stuck and must still get a suggestion.
    const attempts = [attempt("a", "failed"), attempt("b", "cancelled")];
    expect(shouldEscalate(attempts, [])).toBe(true);
  });
});

describe("isAttemptStalled / shouldEscalateStalled (E2)", () => {
  const T = DEFAULT_STALL_THRESHOLD_MS;
  const running = (startedAt: number): Attempt => ({ ...attempt("a", "running"), startedAt });

  it("is false within the threshold", () => {
    expect(isAttemptStalled(running(1000), 1000 + T - 1)).toBe(false);
  });

  it("is true past the threshold", () => {
    expect(isAttemptStalled(running(1000), 1000 + T + 1)).toBe(true);
  });

  it("is false for non-running statuses no matter how old", () => {
    expect(isAttemptStalled({ ...attempt("a", "reviewing"), startedAt: 1 }, 1 + T * 10)).toBe(false);
  });

  it("is false without a startedAt timestamp", () => {
    expect(isAttemptStalled(attempt("a", "running"), 9_999_999)).toBe(false);
  });

  it("escalates a stalled attempt once, then dedupes on its id", () => {
    const a = running(1000);
    const now = 1000 + T + 1;
    expect(shouldEscalateStalled(a, now, [])).toBe(true);
    const log: CoordinationEvent[] = [
      {
        id: "c1",
        flightId: "flight-1",
        type: "escalation",
        summary: "stalled",
        timestamp: 1,
        metadata: { stalledAttemptId: "a" },
      },
    ];
    expect(shouldEscalateStalled(a, now, log)).toBe(false);
  });
});

describe("suggestReassignmentAgent (E3)", () => {
  it("does not suggest an unconfigured model-less provider for one-click reassignment", () => {
    const suggestion = suggestReassignmentAgent([]);
    expect(["api-sugar", "api-cline-pass", "api-opencode-go", "api-ollama-cloud", "api-google", "api-xai"]).not.toContain(suggestion);
  });
  const catalog = ["api-claude", "api-openai", "api-openai-codex"];

  it("suggests the first catalog agent not yet tried", () => {
    expect(suggestReassignmentAgent(["api-claude"], catalog)).toBe("api-openai");
  });

  it("skips all tried agents", () => {
    expect(suggestReassignmentAgent(["api-claude", "api-openai"], catalog)).toBe("api-openai-codex");
  });

  it("returns undefined when everything has been tried", () => {
    expect(suggestReassignmentAgent(catalog, catalog)).toBeUndefined();
  });

  it("suggests the first catalog agent when nothing was tried", () => {
    expect(suggestReassignmentAgent([], catalog)).toBe("api-claude");
  });
});

describe("reassignTargetFromEscalation (E5)", () => {
  const esc = (metadata: Record<string, string>): CoordinationEvent => ({
    id: "e1",
    flightId: "flight-1",
    type: "escalation",
    summary: "stuck",
    timestamp: 1,
    metadata,
  });

  it("is null for non-escalation events", () => {
    expect(
      reassignTargetFromEscalation({ ...esc({ suggestedAgentId: "api-openai" }), type: "task_failed" }, [
        attempt("a", "failed"),
      ]),
    ).toBeNull();
  });

  it("is null without a suggestedAgentId", () => {
    expect(reassignTargetFromEscalation(esc({ signature: "x" }), [attempt("a", "failed")])).toBeNull();
  });

  it("is null when there is no failed attempt to template from", () => {
    expect(
      reassignTargetFromEscalation(esc({ suggestedAgentId: "api-openai" }), [attempt("a", "cancelled")]),
    ).toBeNull();
  });

  it("resolves the most recent failed attempt + the suggested agent", () => {
    expect(
      reassignTargetFromEscalation(esc({ suggestedAgentId: "api-openai" }), [
        attempt("a", "failed"),
        attempt("b", "failed"),
      ]),
    ).toEqual({ attemptId: "b", agentId: "api-openai" });
  });
});

describe("issuesToFlagNeedsHuman (E7)", () => {
  const issue = (id: string, flightId: string | null, status: string) => ({ id, flightId, status });

  it("flags only active issues linked to the flight", () => {
    const issues = [
      issue("i1", "flight-1", "in_progress"),
      issue("i2", "flight-1", "in_review"),
      issue("i3", "flight-1", "done"), // finished
      issue("i4", "flight-1", "backlog"), // not started
      issue("i5", "flight-1", "needs_human"), // already flagged
      issue("i6", "flight-2", "in_progress"), // other flight
      issue("i7", null, "in_progress"), // unlinked
    ];
    expect(issuesToFlagNeedsHuman(issues, "flight-1")).toEqual(["i1", "i2"]);
  });

  it("is empty when nothing is linked + active", () => {
    expect(issuesToFlagNeedsHuman([issue("i1", "flight-1", "done")], "flight-1")).toEqual([]);
  });
});
