import { render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { MessageList } from "../MessageList";
import type { AgentConversation, AgentMessage } from "@/types/agent-conversation";
import { useAgentSettingsStore } from "@/stores/agentSettingsStore";

it("renders old cancelled tool cards as Interrupted while preserving real results and future turns", () => {
  useAgentSettingsStore.setState({ transcriptViewMode: "normal" });
  const cancelled: AgentMessage = {
    id: "cancelled",
    role: "assistant",
    content: "",
    timestamp: 1,
    turnOutcome: "cancelled",
    isStreaming: false,
    toolCalls: [
      {
        id: "pending",
        name: "bash",
        status: "running",
        input: '{"command":"node scripts/checkpoint.mjs"}',
      },
      {
        id: "completed",
        name: "bash",
        status: "done",
        input: '{"command":"git status"}',
        exitCode: 0,
      },
      { id: "failed", name: "bash", status: "error", input: '{"command":"git diff"}', exitCode: 2 },
    ],
  };
  const conversation = {
    id: "conversation",
    agent: "api-sugar",
    mode: "api",
    projectPath: "/repo",
    status: "idle",
    messages: [cancelled],
  } as AgentConversation;
  const props = {
    conversation,
    conversationId: conversation.id,
    editingMessageId: null,
    editingText: "",
    onStartEdit: vi.fn(),
    onChangeEdit: vi.fn(),
    onSubmitEdit: vi.fn(),
    onCancelEdit: vi.fn(),
    onRestoreFrom: vi.fn(),
    onRetryLastTurn: vi.fn(),
    isActive: false,
  };
  const view = render(<MessageList {...props} />);
  expect(screen.getByText("Interrupted")).toBeInTheDocument();
  expect(screen.queryByText("running")).not.toBeInTheDocument();
  expect(screen.getByText("exit 0")).toBeInTheDocument();
  expect(screen.getByText("exit 2")).toBeInTheDocument();
  expect(cancelled.toolCalls?.[0].status).toBe("running");
  const future: AgentMessage = {
    id: "future",
    role: "assistant",
    content: "",
    timestamp: 2,
    isStreaming: true,
    toolCalls: [
      { id: "next", name: "bash", status: "running", input: '{"command":"node scripts/next.mjs"}' },
    ],
  };
  view.rerender(
    <MessageList
      {...props}
      isActive
      conversation={{ ...conversation, status: "active", messages: [cancelled, future] }}
    />,
  );
  expect(screen.getAllByText("running")).toHaveLength(1);
  expect(screen.getAllByText("Interrupted")).toHaveLength(1);
});
