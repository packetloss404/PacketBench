import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  taskState: {
    conversations: [
      {
        id: "conv-stopping",
        title: "Terminal acknowledgement",
        agent: "api-openai",
        projectPath: "D:/projects/example",
        status: "active",
        messages: [
          {
            id: "assistant-stream",
            role: "assistant",
            content: "Stopping safely",
            timestamp: 1,
            isStreaming: true,
          },
        ],
        queuedMessages: [],
        sessionId: "conv-stopping",
        rawOutput: "",
        createdAt: 1,
        updatedAt: 1,
        mode: "api",
        provider: "openai",
        model: "gpt-test",
      },
    ],
    cancellingConversationIds: new Set(["conv-stopping"]),
    changeModel: vi.fn(),
    setPlanMode: vi.fn(),
    setPermissionMode: vi.fn(),
    setApproveWrites: vi.fn(),
    appendAllowedToolPattern: vi.fn(),
    removeDiffComment: vi.fn(),
    clearDiffComments: vi.fn(),
    retryLastTurn: vi.fn(),
    forkConversation: vi.fn(),
    rewindConversation: vi.fn(),
    selectConversation: vi.fn(),
  },
  approvalState: {
    permissions: new Map(),
    edits: new Map(),
    respondPermission: vi.fn(),
    respondEdit: vi.fn(),
    cancelPendingTools: vi.fn(),
  },
}));

vi.mock("@/stores/agentTaskStore", () => ({
  useAgentTaskStore: (selector: (state: typeof mocks.taskState) => unknown) =>
    selector(mocks.taskState),
}));

vi.mock("@/stores/agentApprovalStore", () => ({
  EMPTY_PENDING_EDITS: [],
  EMPTY_PENDING_PERMISSIONS: [],
  useAgentApprovalStore: (selector: (state: typeof mocks.approvalState) => unknown) =>
    selector(mocks.approvalState),
}));

vi.mock("@/stores/reviewStore", () => ({
  useReviewStore: (
    selector: (state: { open: boolean; conversationId: null; close: () => void }) => unknown,
  ) => selector({ open: false, conversationId: null, close: vi.fn() }),
}));

vi.mock("@/stores/rightDockStore", () => ({
  useRightDockStore: (selector: (state: { openPanel: () => void }) => unknown) =>
    selector({ openPanel: vi.fn() }),
}));

vi.mock("@/stores/memoryStore", () => ({
  useMemoryStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector({
      events: [],
      patterns: [],
      composeMemoryBrief: () => ({
        text: "",
        items: [],
        charBudget: 0,
        truncated: false,
        scopeKey: "",
      }),
    }),
}));

vi.mock("@/lib/previewDock", () => ({
  hidePreview: vi.fn(),
  openMarkdownPreview: vi.fn(),
  useIsPreviewVisible: () => false,
}));

vi.mock("@/components/common/wrapClickablePaths", () => ({
  ClickablePathsRoot: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

vi.mock("@/components/agents/hooks/useScrollState", () => ({
  useScrollState: () => ({
    messagesContainerRef: { current: null },
    messagesContentRef: { current: null },
    messagesEndRef: { current: null },
    isAtBottom: true,
    unreadCount: 0,
    jumpToBottom: vi.fn(),
  }),
}));

vi.mock("@/components/agents/hooks/useLatestPlanPreview", () => ({
  useLatestPlanPreview: vi.fn(),
}));

vi.mock("@/components/agents/hooks/useDiffTotals", () => ({
  useDiffTotals: () => ({ files: 0, additions: 0, deletions: 0 }),
}));

vi.mock("@/components/agents/MemoryInjectionCard", () => ({ MemoryInjectionCard: () => null }));
vi.mock("@/components/agents/AgentHeaderBadges", () => ({ AgentHeaderBadges: () => null }));
vi.mock("@/components/agents/PlanPanel", () => ({ PlanPanel: () => null }));
vi.mock("@/components/agents/chat/TileHeaderActions", () => ({ TileHeaderActions: () => null }));
vi.mock("@/components/agents/chat/EmptyConversationHint", () => ({
  EmptyConversationHint: () => null,
}));
vi.mock("@/components/agents/chat/PendingDiffCommentsStrip", () => ({
  PendingDiffCommentsStrip: () => null,
}));
vi.mock("@/components/agents/chat/MessageList", () => ({ MessageList: () => null }));
vi.mock("@/components/agents/chat/PendingApprovalsSection", () => ({
  PendingApprovalsSection: () => null,
}));
vi.mock("@/components/agents/composer/Composer", () => ({ Composer: () => null }));
vi.mock("@/components/agents/review/ReviewBar", () => ({ ReviewBar: () => null }));
vi.mock("@/components/agents/review/ReviewSurface", () => ({ ReviewSurface: () => null }));

vi.mock("@/components/agents/chat/handleExport", () => ({ handleExport: vi.fn() }));

import { AgentChatPane } from "@/components/agents/AgentChatPane";

describe("AgentChatPane Stop acknowledgement", () => {
  it("shows Stopping in both the visible status and polite live region", () => {
    render(<AgentChatPane conversationId="conv-stopping" onClose={vi.fn()} />);

    expect(screen.getByText("Stopping…", { selector: ".tile-hide-narrow" })).toHaveClass(
      "text-accent-amber",
    );
    expect(
      screen.getByText("Stopping…. Stopping safely", { selector: ".sr-only" }),
    ).toHaveAttribute("aria-live", "polite");
  });
});
