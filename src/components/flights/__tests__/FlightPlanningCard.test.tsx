import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { FlightPlanningCard } from "../FlightPlanningCard";
import { FLIGHT_PLAN_FENCE } from "@/lib/flightPlanning";
import type { Flight } from "@/types/flight";

const mocks = vi.hoisted(() => ({ apply: vi.fn(), conversations: [] as unknown[] }));
vi.mock("@/stores/flightStore", () => ({
  useFlightStore: (select: (state: unknown) => unknown) => select({ applyFlightPlan: mocks.apply }),
}));
vi.mock("@/stores/agentTaskStore", () => ({
  useAgentTaskStore: (select: (state: unknown) => unknown) =>
    select({ conversations: mocks.conversations }),
}));
vi.mock("@/stores/sessionGlue", () => ({ openConversationInAgents: vi.fn() }));
const plan = {
  title: "Fix the bug",
  objective: "Correct output",
  milestones: [
    {
      key: "m1",
      title: "Fix",
      description: "Small fix",
      validationCriteria: ["regression passes"],
      tasks: [
        {
          key: "t1",
          title: "Implement",
          description: "Fix the implementation",
          type: "implementation",
          dependsOn: [],
          ownedPaths: ["src/fix.ts"],
        },
      ],
    },
  ],
};
function flight(patch: Partial<Flight> = {}): Flight {
  return {
    id: "f1",
    title: "Fix",
    objective: "Fix",
    status: "planning",
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
    planningConversationId: "plan",
    ...patch,
  };
}
beforeEach(() => {
  mocks.apply.mockReset();
  mocks.conversations = [
    {
      id: "plan",
      messages: [
        {
          role: "assistant",
          content: `\`\`\`${FLIGHT_PLAN_FENCE}\n${JSON.stringify(plan)}\n\`\`\``,
        },
      ],
    },
  ];
});
describe("reviewed Flight plan preview", () => {
  it("lets the user inspect and edit a plan before applying without executing it", () => {
    render(<FlightPlanningCard flight={flight()} />);
    fireEvent.click(screen.getByRole("button", { name: "Preview latest plan" }));
    expect(mocks.apply).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText("Task title"), { target: { value: "Targeted repair" } });
    fireEvent.click(screen.getByRole("button", { name: "Apply reviewed plan" }));
    expect(mocks.apply).toHaveBeenCalledWith(
      "f1",
      expect.objectContaining({
        milestones: [
          expect.objectContaining({
            tasks: [expect.objectContaining({ title: "Targeted repair" })],
          }),
        ],
      }),
    );
    expect(screen.getByRole("status")).toHaveTextContent("Reviewed plan applied");
  });
  it("protects task identity after an attempt has executed", () => {
    render(<FlightPlanningCard flight={flight({ attempts: [{ id: "a1" } as never] })} />);
    expect(screen.getByRole("button", { name: "Preview latest plan" })).toBeDisabled();
    expect(screen.getByText(/existing tasks and results keep their identity/i)).toBeInTheDocument();
    expect(mocks.apply).not.toHaveBeenCalled();
  });
  it("surfaces a rejected plan update and retains the preview for correction", () => {
    mocks.apply.mockImplementation(() => {
      throw new Error("Execution started in another action");
    });
    render(<FlightPlanningCard flight={flight()} />);
    fireEvent.click(screen.getByRole("button", { name: "Preview latest plan" }));
    fireEvent.click(screen.getByRole("button", { name: "Apply reviewed plan" }));
    expect(screen.getByRole("alert")).toHaveTextContent("Execution started");
    expect(screen.getByLabelText("Task title")).toHaveValue("Implement");
  });
});
