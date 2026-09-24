/**
 * P2-S3 — the four-action worktree endings bar mounted inside GitDashboard.
 * Covers: renders the four actions; merge-back success flips state → landed and
 * clears the "worktree pending" chip; Keep retains the chip; Discard on a dirty
 * tree requires an explicit confirm before anything is removed.
 *
 * Uses the REAL agentTaskStore (so the state flip is exercised end-to-end) with
 * only the tauri boundary mocked.
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  resolveWorktreePrTarget: vi.fn(),
  publishBranchAsPr: vi.fn(),
  mergeConversationBranch: vi.fn(),
  getGitStatus: vi.fn(),
  removeConversationWorktree: vi.fn(),
}));

vi.mock("@/lib/tauri", async (importActual) => {
  const actual = await importActual<typeof import("@/lib/tauri")>();
  return {
    ...actual,
    mergeConversationBranch: (...a: unknown[]) => mocks.mergeConversationBranch(...a),
    getGitStatus: (...a: unknown[]) => mocks.getGitStatus(...a),
    removeConversationWorktree: (...a: unknown[]) => mocks.removeConversationWorktree(...a),
  };
});

vi.mock("@/lib/gitPublish", () => ({
  publishBranchAsPr: mocks.publishBranchAsPr,
  resolveWorktreePrTarget: mocks.resolveWorktreePrTarget,
}));

import { WorktreeLifecycleBar } from "@/components/workspace/WorktreeLifecycleBar";
import { useAgentTaskStore } from "@/stores/agentTaskStore";
import type { AgentConversation } from "@/types/agent-conversation";

const CONV_ID = "conv-wt";

function seed(overrides: Partial<AgentConversation> = {}): AgentConversation {
  const now = Date.now();
  return {
    id: CONV_ID,
    title: "Worktree conversation",
    agent: "api-openai",
    projectPath: "/repo/.pkt-worktrees/conv-wt",
    status: "idle",
    messages: [],
    sessionId: null,
    rawOutput: "",
    createdAt: now,
    updatedAt: now,
    mode: "api",
    archived: false,
    worktree: {
      basePath: "/repo",
      worktreePath: "/repo/.pkt-worktrees/conv-wt",
      branch: "pkt/conv-wt",
      baseBranch: "main",
      createdAt: now,
      state: "active",
    },
    ...overrides,
  } as AgentConversation;
}

function renderBar() {
  return render(
    <WorktreeLifecycleBar conversationId={CONV_ID} onFeedback={vi.fn()} onLanded={vi.fn()} />,
  );
}

describe("WorktreeLifecycleBar", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resolveWorktreePrTarget.mockResolvedValue({
      owner: "actual",
      repo: "project",
      connectionId: "cloud",
    });
    mocks.publishBranchAsPr.mockResolvedValue({ ok: true, prNumber: 42 });
    mocks.getGitStatus.mockResolvedValue(""); // clean by default
    mocks.removeConversationWorktree.mockResolvedValue(undefined);
    mocks.mergeConversationBranch.mockResolvedValue({
      commitSha: "abcdef1234567",
      branchDeleted: true,
      worktreeRemoved: true,
      nothingToLand: false,
    });
    useAgentTaskStore.setState({ conversations: [seed()] } as never);
  });

  it("resolves the worktree origin before publishing without a global repo selection", async () => {
    renderBar();
    fireEvent.click(screen.getByRole("button", { name: /create pr/i }));
    await waitFor(() =>
      expect(mocks.publishBranchAsPr).toHaveBeenCalledWith(
        expect.objectContaining({ owner: "actual", repo: "project", connectionId: "cloud" }),
      ),
    );
    expect(mocks.resolveWorktreePrTarget).toHaveBeenCalledWith("/repo/.pkt-worktrees/conv-wt");
    expect(useAgentTaskStore.getState().conversations[0].worktree?.prNumber).toBe(42);
  });
  it("does not push or publish when worktree authority cannot be resolved", async () => {
    mocks.resolveWorktreePrTarget.mockRejectedValue(new Error("Unknown Git host"));
    const onFeedback = vi.fn();
    render(<WorktreeLifecycleBar conversationId={CONV_ID} onFeedback={onFeedback} />);
    fireEvent.click(screen.getByRole("button", { name: /create pr/i }));
    await waitFor(() =>
      expect(onFeedback).toHaveBeenCalledWith(
        expect.objectContaining({ type: "err", msg: expect.stringContaining("Unknown Git host") }),
      ),
    );
    expect(mocks.publishBranchAsPr).not.toHaveBeenCalled();
  });
  it("renders the four lifecycle actions and the pending chip", () => {
    renderBar();
    expect(screen.getByText("worktree pending")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /merge back/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /create pr/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /keep for later/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /discard/i })).toBeInTheDocument();
  });

  it("merge-back success flips state → landed and clears the pending chip", async () => {
    renderBar();
    fireEvent.click(screen.getByRole("button", { name: /merge back/i }));

    await waitFor(() => {
      expect(mocks.mergeConversationBranch).toHaveBeenCalledWith("/repo", "pkt/conv-wt", true);
    });
    await waitFor(() => {
      const conv = useAgentTaskStore.getState().conversations.find((c) => c.id === CONV_ID);
      expect(conv?.worktree?.state).toBe("landed");
    });
    // Chip gone, terminal "Landed" surface shown, actions removed.
    expect(screen.queryByText("worktree pending")).not.toBeInTheDocument();
    expect(screen.getByText(/landed/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /merge back/i })).not.toBeInTheDocument();
  });

  it("nothing-to-land keeps the chip and does NOT flip state → landed", async () => {
    mocks.mergeConversationBranch.mockResolvedValue({
      commitSha: "abcdef1234567",
      branchDeleted: false,
      worktreeRemoved: false,
      nothingToLand: true,
    });
    const onFeedback = vi.fn();
    render(<WorktreeLifecycleBar conversationId={CONV_ID} onFeedback={onFeedback} />);
    fireEvent.click(screen.getByRole("button", { name: /merge back/i }));

    await waitFor(() => {
      expect(onFeedback).toHaveBeenCalledWith(
        expect.objectContaining({ type: "err", msg: expect.stringMatching(/nothing to land/i) }),
      );
    });
    // State stays active, pending chip stays, worktree preserved.
    const conv = useAgentTaskStore.getState().conversations.find((c) => c.id === CONV_ID);
    expect(conv?.worktree?.state).toBe("active");
    expect(screen.getByText("worktree pending")).toBeInTheDocument();
  });

  it("Merge back is disabled for remote (SSH) conversations", () => {
    render(<WorktreeLifecycleBar conversationId={CONV_ID} isRemote onFeedback={vi.fn()} />);
    expect(screen.getByRole("button", { name: /merge back/i })).toBeDisabled();
  });

  it("Keep for later retains the worktree and its pending chip", () => {
    const onFeedback = vi.fn();
    render(<WorktreeLifecycleBar conversationId={CONV_ID} onFeedback={onFeedback} />);
    fireEvent.click(screen.getByRole("button", { name: /keep for later/i }));

    // Chip still present; nothing removed; state untouched.
    expect(screen.getByText("worktree pending")).toBeInTheDocument();
    expect(mocks.removeConversationWorktree).not.toHaveBeenCalled();
    const conv = useAgentTaskStore.getState().conversations.find((c) => c.id === CONV_ID);
    expect(conv?.worktree?.state).toBe("active");
    expect(onFeedback).toHaveBeenCalledWith(expect.objectContaining({ type: "ok" }));
  });

  it("Discard on a dirty tree requires confirm before removing anything", async () => {
    mocks.getGitStatus.mockResolvedValue(" M src/foo.ts\n");
    renderBar();
    fireEvent.click(screen.getByRole("button", { name: /^discard$/i }));

    // The store rejects the un-confirmed dirty discard; the bar surfaces the
    // inline confirm and removes nothing yet.
    await waitFor(() => {
      expect(screen.getByText(/uncommitted changes/i)).toBeInTheDocument();
    });
    expect(mocks.removeConversationWorktree).not.toHaveBeenCalled();
    expect(useAgentTaskStore.getState().conversations[0].worktree?.state).toBe("active");

    // Confirming proceeds — dir + branch removed, state → discarded.
    fireEvent.click(screen.getByRole("button", { name: /discard anyway/i }));
    await waitFor(() => {
      expect(mocks.removeConversationWorktree).toHaveBeenCalledWith("/repo", CONV_ID, true);
    });
    await waitFor(() => {
      expect(useAgentTaskStore.getState().conversations[0].worktree?.state).toBe("discarded");
    });
  });

  it("hides entirely when the conversation ran in the project root (no worktree)", () => {
    useAgentTaskStore.setState({
      conversations: [seed({ projectPath: "/repo", worktree: undefined })],
    } as never);
    const { container } = renderBar();
    expect(container).toBeEmptyDOMElement();
  });
});
