import { describe, expect, it } from "vitest";
import { isFlightOwnedConversation } from "@/lib/flightOwnership";
import type { Attempt, Flight } from "@/types/flight";

function attempt(overrides: Partial<Attempt> = {}): Attempt {
  return {
    id: "attempt-1",
    flightId: "flight-1",
    target: { kind: "local", basePath: "/repo", worktreePath: "/repo/wt" } as Attempt["target"],
    agentConfigId: "api-openai",
    model: "gpt",
    provider: "openai",
    branch: "pkt/attempt-1",
    baseBranch: "main",
    sessionId: "conv-builder",
    status: "running",
    cost: 0,
    tokens: 0,
    ...overrides,
  };
}

function flight(overrides: Partial<Flight> = {}): Flight {
  return {
    id: "flight-1",
    title: "F",
    objective: "o",
    status: "active",
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

describe("isFlightOwnedConversation", () => {
  it("recognizes a builder attempt conversation", () => {
    expect(isFlightOwnedConversation("conv-builder", [flight({ attempts: [attempt()] })])).toBe(
      true,
    );
  });

  it("recognizes a reviewer conversation", () => {
    const f = flight({
      attempts: [
        attempt({ reviewGate: { status: "running", reviewerConversationId: "conv-review" } }),
      ],
    });
    expect(isFlightOwnedConversation("conv-review", [f])).toBe(true);
  });

  it("recognizes a reviewer session id", () => {
    const f = flight({
      attempts: [
        attempt({
          reviewGate: {
            status: "running",
            reviewerSessions: [{ sessionId: "conv-review-2", provider: "openai", model: "gpt" }],
          },
        }),
      ],
    });
    expect(isFlightOwnedConversation("conv-review-2", [f])).toBe(true);
  });

  it("does not treat an ordinary or planning conversation as Flight-owned", () => {
    const f = flight({ attempts: [attempt()], planningConversationId: "conv-plan" });
    expect(isFlightOwnedConversation("conv-plan", [f])).toBe(false);
    expect(isFlightOwnedConversation("conv-other", [f])).toBe(false);
    expect(isFlightOwnedConversation("conv-builder", [])).toBe(false);
  });
});
