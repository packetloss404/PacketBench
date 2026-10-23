import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { MessageList } from "../MessageList";
import type { AgentConversation, AgentMessage } from "@/types/agent-conversation";

function message(overrides: Partial<AgentMessage> = {}): AgentMessage {
  return {
    id: "msg-1",
    role: "user",
    content: "first",
    timestamp: 1,
    ...overrides,
  };
}

function conversation(overrides: Partial<AgentConversation> = {}): AgentConversation {
  return {
    id: "conv-1",
    title: "Test",
    agent: "api-openai",
    projectPath: "/repo",
    status: "idle",
    messages: [message()],
    sessionId: null,
    rawOutput: "",
    createdAt: 1,
    updatedAt: 1,
    mode: "api",
    provider: "openai",
    model: "gpt-4o",
    ...overrides,
  };
}

function renderList(
  conv: AgentConversation,
  overrides: Partial<Parameters<typeof MessageList>[0]> = {},
) {
  return render(
    <MessageList
      conversation={conv}
      conversationId={conv.id}
      editingMessageId={null}
      editingText=""
      onStartEdit={vi.fn()}
      onChangeEdit={vi.fn()}
      onSubmitEdit={vi.fn()}
      onCancelEdit={vi.fn()}
      onRewindFrom={vi.fn()}
      onRetryLastTurn={vi.fn()}
      isActive={false}
      {...overrides}
    />,
  );
}

describe("MessageList — fork and rewind affordances", () => {
  it("labels Edit as a fork and exposes Start fork", () => {
    renderList(conversation(), { editingMessageId: "msg-1", editingText: "first" });

    expect(screen.getByText(/Original kept/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Start fork" })).toBeInTheDocument();
  });

  it("confirms rewind with truthful file semantics and does not claim a rerun", () => {
    const onRewindFrom = vi.fn();
    renderList(conversation(), { onRewindFrom });

    fireEvent.click(screen.getByRole("button", { name: "Rewind conversation from this turn" }));

    expect(
      screen.getByText(
        /Later messages move to a saved history revision\. Files stay as they are\./,
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText(/re-runs/i)).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Rewind" }));
    expect(onRewindFrom).toHaveBeenCalledTimes(1);
  });

  it("hides fork and rewind while a turn is active", () => {
    renderList(conversation({ status: "active" }), { isActive: true });

    expect(
      screen.queryByRole("button", { name: "Edit & fork from this turn" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Rewind conversation from this turn" }),
    ).not.toBeInTheDocument();
  });

  it("disables fork and rewind on a Flight-owned conversation", () => {
    renderList(conversation(), { flightOwned: true });

    expect(
      screen.queryByRole("button", { name: "Edit & fork from this turn" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Rewind conversation from this turn" }),
    ).not.toBeInTheDocument();
    expect(screen.getByText(/Flight-owned conversation/)).toBeInTheDocument();
  });

  it("resolves a message link that a rewind moved into a saved revision", () => {
    const conv = conversation({
      transcriptRevisions: [
        {
          revisionId: "rev-1",
          conversationId: "conv-1",
          operation: "transcript_rewind",
          throughMessageId: "msg-1",
          messageCount: 2,
          messages: [message({ id: "old-1", content: "old user turn" })],
          createdAt: 1,
        },
      ],
    });
    const onSearchNavigationConsumed = vi.fn();
    renderList(conv, {
      searchNavigationTarget: { messageId: "old-1", token: "t1" },
      onSearchNavigationConsumed,
    });

    expect(screen.getByText("Previous history")).toBeInTheDocument();
    expect(screen.getByText("old user turn")).toBeInTheDocument();
    expect(onSearchNavigationConsumed).toHaveBeenCalled();
  });

  it("shows saved history revisions read-only", () => {
    const conv = conversation({
      transcriptRevisions: [
        {
          revisionId: "rev-1",
          conversationId: "conv-1",
          operation: "transcript_rewind",
          throughMessageId: "msg-1",
          messageCount: 2,
          messages: [
            message({ id: "old-1", content: "old user turn" }),
            message({ id: "old-2", role: "assistant", content: "old reply" }),
          ],
          createdAt: 1,
        },
      ],
    });
    renderList(conv);

    fireEvent.click(screen.getByRole("button", { name: /View previous history \(1\)/ }));

    expect(screen.getByText("Previous history")).toBeInTheDocument();
    expect(screen.getByText("old user turn")).toBeInTheDocument();
    expect(screen.getByText("old reply")).toBeInTheDocument();
    expect(screen.getByText(/Files were not changed/)).toBeInTheDocument();
  });
});

describe("MessageList — search navigation (F7)", () => {
  it("force-mounts and briefly highlights the exact historical match, then consumes the target", () => {
    const onSearchNavigationConsumed = vi.fn();
    const conv = conversation({
      messages: [
        message({ id: "msg-1", content: "first" }),
        message({ id: "msg-2", role: "assistant", content: "the needle turn" }),
        message({ id: "msg-3", content: "last" }),
      ],
    });
    const { container } = renderList(conv, {
      searchNavigationTarget: { messageId: "msg-2" },
      onSearchNavigationConsumed,
    });

    const row = container.querySelector('[data-message-id="msg-2"]');
    expect(row).not.toBeNull();
    expect(row!.className).toContain("bg-accent-blue/10");
    expect(onSearchNavigationConsumed).toHaveBeenCalledTimes(1);
  });

  it("ignores a target whose message id does not exist", () => {
    const onSearchNavigationConsumed = vi.fn();
    const conv = conversation({ messages: [message({ id: "msg-1", content: "first" })] });
    const { container } = renderList(conv, {
      searchNavigationTarget: { messageId: "missing" },
      onSearchNavigationConsumed,
    });

    expect(container.querySelector('[data-message-id="missing"]')).toBeNull();
    expect(onSearchNavigationConsumed).toHaveBeenCalledTimes(1);
  });
});
