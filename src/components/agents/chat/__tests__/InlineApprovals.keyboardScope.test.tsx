/**
 * B3 (wave 2c) — the per-tile Y/N focus gate SURVIVES the move of the approval
 * markup out of the footer band and into the transcript.
 *
 * `PendingApprovalsSection.dualMode.test.tsx` covers the gate in isolation. This
 * file covers the thing the move actually put at risk: the cards now render
 * inside `MessageList`, one copy per mounted tile, while the document-level
 * keydown handler still lives in exactly one place. The failure mode being
 * guarded against is a workspace mosaic where every open conversation tile
 * answers a single "y" — so the assertions are (a) BOTH tiles paint their
 * approval card at the call site, and (b) one keypress resolves exactly ONE
 * permission, on the focused tile.
 */
import { fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MessageList } from "@/components/agents/chat/MessageList";
import { PendingApprovalsSection } from "@/components/agents/chat/PendingApprovalsSection";
import type {
  AgentConversation,
  PendingPermission,
} from "@/types/agent-conversation";

vi.mock("@/stores/appStore", () => ({
  useAppStore: (selector: (s: { commandPaletteOpen: boolean }) => unknown) =>
    selector({ commandPaletteOpen: false }),
}));

const respondPermission = vi.fn().mockResolvedValue(undefined);
const appendAllowedToolPattern = vi.fn();

/** The tool call that raised the permission carries the SAME id — that
 * identity is what places the card at the call site. */
function makeConversation(id: string, toolUseId: string): AgentConversation {
  return {
    id,
    title: id,
    agent: "api-claude",
    mode: "api",
    model: "claude-sonnet-4-5",
    projectPath: "/repo",
    status: "active",
    messages: [
      {
        id: `${id}-msg`,
        role: "assistant",
        content: "Working on it.",
        timestamp: 0,
        isStreaming: true,
        toolCalls: [{ id: toolUseId, name: "bash", status: "running" }],
      },
    ],
  } as unknown as AgentConversation;
}

function makePermission(id: string): PendingPermission {
  return { id, name: "bash", arguments: '{"command":"ls"}' };
}

/**
 * Exactly what `AgentChatPane` composes for approvals: the inline cards in the
 * transcript, plus the section that owns the ONE keydown handler and the
 * out-of-view pill. Anything else about the pane is irrelevant here.
 */
function Tile({
  conversationId,
  toolUseId,
  focused,
}: {
  conversationId: string;
  toolUseId: string;
  focused: boolean;
}) {
  const conversation = makeConversation(conversationId, toolUseId);
  const permissions = [makePermission(toolUseId)];
  return (
    <div data-testid={`tile-${conversationId}`}>
      <MessageList
        conversation={conversation}
        conversationId={conversationId}
        editingMessageId={null}
        editingText=""
        onStartEdit={() => {}}
        onChangeEdit={() => {}}
        onSubmitEdit={() => {}}
        onCancelEdit={() => {}}
        onRewindFrom={() => {}}
        onRetryLastTurn={() => {}}
        isActive
        approvals={{
          permissions,
          respondPermission,
          appendAllowedToolPattern,
        }}
      />
      <PendingApprovalsSection
        conversationId={conversationId}
        pendingPermissions={permissions}
        respondPermission={respondPermission}
        keyboardScopeActive={focused}
      />
    </div>
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("inline approvals — per-tile keyboard scope (B3)", () => {
  it("renders the approval card inline in EVERY mounted tile", () => {
    render(
      <>
        <Tile conversationId="conv-focused" toolUseId="tool-focused" focused />
        <Tile
          conversationId="conv-background"
          toolUseId="tool-background"
          focused={false}
        />
      </>,
    );

    for (const id of ["conv-focused", "conv-background"]) {
      const tile = screen.getByTestId(`tile-${id}`);
      expect(
        within(tile).getByText(/permission required/i),
      ).toBeInTheDocument();
      // The card sits in the transcript, tagged with the tool-use id it
      // belongs to — that tag is also what the out-of-view pill observes.
      expect(
        tile.querySelector(`[data-approval-id="tool-${id.split("-")[1]}"]`),
      ).not.toBeNull();
    }
  });

  it("one Y reaches ONLY the focused tile, even with both cards on screen", () => {
    render(
      <>
        <Tile conversationId="conv-focused" toolUseId="tool-focused" focused />
        <Tile
          conversationId="conv-background"
          toolUseId="tool-background"
          focused={false}
        />
      </>,
    );

    fireEvent.keyDown(document.body, { key: "y" });

    expect(respondPermission).toHaveBeenCalledTimes(1);
    expect(respondPermission).toHaveBeenCalledWith(
      "conv-focused",
      "tool-focused",
      "allow_once",
    );
  });

  it("one N reaches ONLY the focused tile", () => {
    render(
      <>
        <Tile conversationId="conv-focused" toolUseId="tool-focused" focused />
        <Tile
          conversationId="conv-background"
          toolUseId="tool-background"
          focused={false}
        />
      </>,
    );

    fireEvent.keyDown(document.body, { key: "n" });

    expect(respondPermission).toHaveBeenCalledTimes(1);
    expect(respondPermission).toHaveBeenCalledWith(
      "conv-focused",
      "tool-focused",
      "deny",
    );
  });

  it("clicking Allow on the BACKGROUND tile's card still answers that tile — the gate scopes the keyboard, not the mouse", () => {
    render(
      <>
        <Tile conversationId="conv-focused" toolUseId="tool-focused" focused />
        <Tile
          conversationId="conv-background"
          toolUseId="tool-background"
          focused={false}
        />
      </>,
    );

    const background = screen.getByTestId("tile-conv-background");
    // The primary half of the Allow split-button; its sibling chevron is
    // "Allow with a wider scope".
    fireEvent.click(within(background).getByRole("button", { name: "Allow" }));

    expect(respondPermission).toHaveBeenCalledTimes(1);
    expect(respondPermission).toHaveBeenCalledWith(
      "conv-background",
      "tool-background",
      "allow_once",
    );
  });
});
