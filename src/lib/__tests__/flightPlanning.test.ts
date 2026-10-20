import { describe, expect, it } from "vitest";
import {
  buildFlightPlanningSystemPrompt,
  FLIGHT_PLAN_FENCE,
  materializeFlightPlan,
  parseLatestFlightPlan,
} from "@/lib/flightPlanning";
import type { AgentMessage } from "@/types/agent-conversation";

function assistant(content: string): AgentMessage {
  return { id: "message", role: "assistant", content, timestamp: 1 };
}

const planBlock = `\`\`\`${FLIGHT_PLAN_FENCE}
{
  "title": "Planned flight",
  "milestones": [{
    "key": "m1",
    "title": "Foundation",
    "description": "Build it",
    "validationCriteria": ["Tests pass"],
    "tasks": [
      {"key":"t1","title":"Implement","description":"Write code","type":"implementation","role":"builder","dependsOn":[],"ownedPaths":["src"]},
      {"key":"t2","title":"Test","description":"Verify code","type":"testing","dependsOn":["t1"],"ownedPaths":[]}
    ]
  }]
}
\`\`\``;

describe("flightPlanning", () => {
  it("uses the latest valid assistant plan and materializes dependency ids", () => {
    const parsed = parseLatestFlightPlan([
      assistant(planBlock.replace("Planned flight", "Old plan")),
      assistant(`Refined after feedback.\n${planBlock}`),
    ]);
    const materialized = materializeFlightPlan("flight-1", parsed, 42);

    expect(materialized.title).toBe("Planned flight");
    expect(materialized.taskCount).toBe(2);
    expect(materialized.milestones[0].tasks[0]).toEqual(
      expect.objectContaining({ flightId: "flight-1", status: "pending", createdAt: 42 }),
    );
    expect(materialized.milestones[0].tasks[1].dependsOn).toEqual([
      materialized.milestones[0].tasks[0].id,
    ]);
  });

  it("rejects unknown dependencies", () => {
    expect(() =>
      parseLatestFlightPlan([assistant(planBlock.replace('"t1"]', '"missing"]'))]),
    ).toThrow("unknown task key");
  });

  it("requires a named fenced plan block", () => {
    expect(() => parseLatestFlightPlan([assistant("No structured plan yet.")])).toThrow(
      `No \`${FLIGHT_PLAN_FENCE}\``,
    );
    expect(() =>
      parseLatestFlightPlan([assistant(planBlock.replace(FLIGHT_PLAN_FENCE, "json"))]),
    ).toThrow(`No \`${FLIGHT_PLAN_FENCE}\``);
  });

  it("describes an upfront read-only planning contract", () => {
    const prompt = buildFlightPlanningSystemPrompt("flight-7");
    expect(prompt).toContain("Flight flight-7");
    expect(prompt).toContain("Do not edit files or run commands");
    expect(prompt).toContain(FLIGHT_PLAN_FENCE);
  });
  it("keeps stable task and milestone identity when the same plan is applied again", () => {
    const parsed = parseLatestFlightPlan([assistant(planBlock)]);
    const first = materializeFlightPlan("flight-1", parsed, 1);
    const second = materializeFlightPlan("flight-1", parsed, 2);
    expect(second.milestones.map((milestone) => milestone.id)).toEqual(
      first.milestones.map((milestone) => milestone.id),
    );
    expect(second.milestones[0].tasks.map((task) => task.id)).toEqual(
      first.milestones[0].tasks.map((task) => task.id),
    );
    expect(second.milestones[0].tasks[1].dependsOn).toEqual(first.milestones[0].tasks[1].dependsOn);
  });
});
