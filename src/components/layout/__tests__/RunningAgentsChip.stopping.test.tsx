import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  cancel: vi.fn(),
  openConversation: vi.fn(),
  state: {
    conversations: [
      {
        id: "conv-stopping",
        title: "Cancellation contract",
        mode: "api",
        model: "gpt-test",
        messages: [],
      },
    ],
    cancellingConversationIds: new Set(["conv-stopping"]),
    cancelActiveConversation: vi.fn(),
  },
}));

vi.mock("@/stores/agentTaskStore", () => ({
  useAgentTaskStore: (selector: (state: typeof mocks.state) => unknown) => selector(mocks.state),
}));

vi.mock("@/stores/sessionGlue", () => ({
  openConversationInAgents: (...args: unknown[]) => mocks.openConversation(...args),
}));

vi.mock("@/lib/sessionStatus", () => ({
  useConversationAttention: () => new Map([["conv-stopping", "working"]]),
}));

vi.mock("@/lib/conversationTokens", () => ({
  aggregateConversationTokens: () => 0,
}));

import { RunningAgentsChip } from "@/components/layout/RunningAgentsChip";

describe("RunningAgentsChip Stop acknowledgement", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.state.cancellingConversationIds = new Set(["conv-stopping"]);
  });

  it("keeps the agent visible and disables its Stop action while cancellation is pending", () => {
    render(<RunningAgentsChip />);

    fireEvent.click(screen.getByTitle("1 agent running — click to inspect"));

    const stop = screen.getByTitle("Waiting for Stop acknowledgement");
    expect(screen.getByText("Cancellation contract")).toBeInTheDocument();
    expect(stop).toBeDisabled();
    expect(stop.querySelector("svg")).toHaveClass("animate-pulse");

    fireEvent.click(stop);
    expect(mocks.state.cancelActiveConversation).not.toHaveBeenCalled();
  });
});
