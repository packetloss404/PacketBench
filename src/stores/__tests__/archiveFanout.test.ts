/**
 * Tile program (P4-S3) — archive lifecycle fan-out + worktree cleanup policy.
 *
 * Gates (ruled):
 *   - member PTYs are killed on ARCHIVE, never on workspace SWITCH (P0-2 law);
 *   - dirty/unlanded worktree under only-when-safe ⇒ Kept with the pending chip
 *     (worktree.state stays "active", nothing removed);
 *   - clean + predicate-safe ⇒ cleaned silently (worktree removed, lifecycle
 *     flipped, no kept entry);
 *   - auto-archive NEVER cleans (even a provably-safe tree is Kept);
 *   - member conversations are archived but transcripts are kept;
 *   - deleting a workspace DETACHES conversations (they survive as virtual rows).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const killPtyMock = vi.fn().mockResolvedValue(undefined);
const getGitStatusMock = vi.fn().mockResolvedValue("");
const removeConversationWorktreeMock = vi.fn().mockResolvedValue(undefined);

vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn().mockResolvedValue(() => {}) }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@/lib/agentsMd", () => ({ loadAgentsMd: vi.fn().mockResolvedValue(null) }));
vi.mock("@/stores/memoryStore", () => ({
  useMemoryStore: { getState: vi.fn(() => ({})) },
}));
vi.mock("@/stores/layoutStore", () => ({
  useLayoutStore: { getState: vi.fn(() => ({ setProjectPath: vi.fn(), setActivePaneId: vi.fn() })) },
}));
vi.mock("@/lib/tauri", () => ({
  createPtySession: vi.fn(),
  writePty: vi.fn(),
  killPty: (...a: unknown[]) => killPtyMock(...a),
  getGitStatus: (...a: unknown[]) => getGitStatusMock(...a),
  removeConversationWorktree: (...a: unknown[]) => removeConversationWorktreeMock(...a),
  startApiAgentSession: vi.fn().mockResolvedValue(undefined),
  sendApiAgentMessage: vi.fn(),
  cancelApiAgentSession: vi.fn().mockResolvedValue(undefined),
  cancelPendingTools: vi.fn(),
  closeApiAgentSession: vi.fn().mockResolvedValue(undefined),
  saveConversation: vi.fn().mockResolvedValue(undefined),
  loadConversations: vi.fn().mockResolvedValue([]),
  deleteConversationFile: vi.fn().mockResolvedValue(undefined),
  changeAgentModel: vi.fn(),
  setPlanMode: vi.fn(),
  setPermissionMode: vi.fn(),
  respondPermission: vi.fn(),
  setApproveWrites: vi.fn(),
  respondEdit: vi.fn(),
  retryLastTurn: vi.fn(),
  exportConversationMarkdown: vi.fn(),
  saveWorkspacesSlice: vi.fn().mockResolvedValue(undefined),
}));

import {
  archiveWorkspaceWithFanout,
  conversationWrapperId,
  teardownSessionGlue,
} from "@/stores/sessionGlue";
import { selectConversationSessions } from "@/lib/sessionIndex";
import { useAgentTaskStore } from "@/stores/agentTaskStore";
import { useWorkspaceStore } from "@/stores/workspaceStore";
import type { WorktreeCleanupFacts } from "@/lib/worktreeLifecycle";
import type { AgentConversation } from "@/types/agent-conversation";
import type { Workspace, WorkspacePane } from "@/types/workspace";

function conv(overrides: Partial<AgentConversation> = {}): AgentConversation {
  return {
    id: "conv-1",
    title: "My Task",
    agent: "api-claude",
    projectPath: "/proj",
    status: "done",
    messages: [],
    sessionId: "conv-1",
    rawOutput: "",
    createdAt: 1,
    updatedAt: 1,
    mode: "api",
    ...overrides,
  };
}

function activeWorktree(overrides: Partial<NonNullable<AgentConversation["worktree"]>> = {}) {
  return {
    basePath: "/proj",
    worktreePath: "/proj/.pkt-worktrees/conv-1",
    branch: "pkt/conv-1",
    baseBranch: "main",
    createdAt: 1,
    state: "active" as const,
    ...overrides,
  };
}

function conversationPane(conversationId: string): WorkspacePane {
  return { id: `pane-${conversationId}`, agentId: "terminal", sessionId: null, kind: "conversation", conversationId };
}

function terminalPane(id: string, sessionId: string | null): WorkspacePane {
  return { id, agentId: "terminal", sessionId };
}

function workspace(id: string, panes: WorkspacePane[], overrides: Partial<Workspace> = {}): Workspace {
  return {
    id,
    name: "WS",
    agents: [],
    panes,
    projectPath: "/proj",
    createdAt: 1,
    updatedAt: 1,
    status: "active",
    ...overrides,
  };
}

/** A gatherer that reports fully-provably-safe facts (clean + zero ahead). */
const safeFacts = async (): Promise<WorktreeCleanupFacts> => ({
  dirty: false,
  ancestryMerged: true,
  recordedPrMerged: false,
  commitsAhead: 0,
});

/** A gatherer that reports an unsafe (dirty, unlanded) tree. */
const dirtyFacts = async (): Promise<WorktreeCleanupFacts> => ({
  dirty: true,
  ancestryMerged: false,
  recordedPrMerged: false,
  commitsAhead: 3,
});

beforeEach(() => {
  vi.clearAllMocks();
  useAgentTaskStore.setState({ conversations: [], selectedConversationId: null });
  useWorkspaceStore.setState({ workspaces: [], activeWorkspaceId: null, zoomedPaneId: null });
});

afterEach(() => {
  teardownSessionGlue();
});

describe("archive fan-out — PTY kill gate (P0-2 law)", () => {
  it("kills member PTYs on ARCHIVE", async () => {
    useWorkspaceStore.setState({
      workspaces: [workspace("ws-1", [terminalPane("pane-term", "pty-9")])],
      activeWorkspaceId: "ws-1",
    });

    const result = await archiveWorkspaceWithFanout("ws-1");

    expect(killPtyMock).toHaveBeenCalledWith("pty-9");
    expect(result?.killedPtySessionIds).toEqual(["pty-9"]);
    expect(useWorkspaceStore.getState().workspaces[0].status).toBe("archived");
    // Archiving the active workspace clears the active id.
    expect(useWorkspaceStore.getState().activeWorkspaceId).toBeNull();
  });

  it("does NOT kill PTYs on workspace SWITCH", () => {
    useWorkspaceStore.setState({
      workspaces: [
        workspace("ws-1", [terminalPane("pane-term", "pty-9")]),
        workspace("ws-2", []),
      ],
      activeWorkspaceId: "ws-1",
    });

    useWorkspaceStore.getState().setActiveWorkspace("ws-2");

    expect(killPtyMock).not.toHaveBeenCalled();
    // Both workspaces still live; the PTY workspace is untouched.
    expect(useWorkspaceStore.getState().workspaces[0].status).toBe("active");
  });
});

describe("archive fan-out — worktree cleanup policy", () => {
  it("only-when-safe: dirty/unlanded tree is KEPT with the pending chip", async () => {
    useAgentTaskStore.setState({ conversations: [conv({ id: "conv-1", worktree: activeWorktree() })] });
    useWorkspaceStore.setState({ workspaces: [workspace("ws-1", [conversationPane("conv-1")])] });

    const result = await archiveWorkspaceWithFanout("ws-1", {
      policy: "only-when-safe",
      gatherFacts: dirtyFacts,
    });

    expect(removeConversationWorktreeMock).not.toHaveBeenCalled();
    expect(result?.keptWorktreeConversationIds).toEqual(["conv-1"]);
    expect(result?.cleanedWorktreeConversationIds).toEqual([]);
    // The worktree stays active → the "worktree pending" chip data source holds.
    const c = useAgentTaskStore.getState().conversations.find((x) => x.id === "conv-1");
    expect(c?.worktree?.state).toBe("active");
  });

  it("only-when-safe: clean + predicate-safe tree is CLEANED silently", async () => {
    useAgentTaskStore.setState({ conversations: [conv({ id: "conv-1", worktree: activeWorktree() })] });
    useWorkspaceStore.setState({ workspaces: [workspace("ws-1", [conversationPane("conv-1")])] });

    const result = await archiveWorkspaceWithFanout("ws-1", {
      policy: "only-when-safe",
      gatherFacts: safeFacts,
    });

    expect(removeConversationWorktreeMock).toHaveBeenCalledWith("/proj", "conv-1", true);
    expect(result?.cleanedWorktreeConversationIds).toEqual(["conv-1"]);
    expect(result?.keptWorktreeConversationIds).toEqual([]);
    // Merged ⇒ lifecycle flips to landed (chip clears).
    const c = useAgentTaskStore.getState().conversations.find((x) => x.id === "conv-1");
    expect(c?.worktree?.state).toBe("landed");
  });

  it("only-when-safe: keeps a checkout still referenced by a fork", async () => {
    useAgentTaskStore.setState({
      conversations: [
        conv({ id: "conv-1", worktree: activeWorktree() }),
        conv({
          id: "fork-1",
          projectPath: "/proj/.pkt-worktrees/conv-1",
          lineage: {
            parentConversationId: "conv-1",
            forkedFromMessageId: "msg-1",
            kind: "fork",
            contextMode: "semantic",
            createdAt: 1,
          },
        }),
      ],
    });
    useWorkspaceStore.setState({ workspaces: [workspace("ws-1", [conversationPane("conv-1")])] });

    const result = await archiveWorkspaceWithFanout("ws-1", {
      policy: "only-when-safe",
      gatherFacts: safeFacts,
    });

    expect(removeConversationWorktreeMock).not.toHaveBeenCalled();
    expect(result?.keptWorktreeConversationIds).toEqual(["conv-1"]);
    expect(result?.cleanedWorktreeConversationIds).toEqual([]);
    const c = useAgentTaskStore.getState().conversations.find((x) => x.id === "conv-1");
    expect(c?.worktree?.state).toBe("active");
  });

  it("never: a provably-safe tree is still KEPT", async () => {
    useAgentTaskStore.setState({ conversations: [conv({ id: "conv-1", worktree: activeWorktree() })] });
    useWorkspaceStore.setState({ workspaces: [workspace("ws-1", [conversationPane("conv-1")])] });

    const result = await archiveWorkspaceWithFanout("ws-1", { policy: "never", gatherFacts: safeFacts });

    expect(removeConversationWorktreeMock).not.toHaveBeenCalled();
    expect(result?.keptWorktreeConversationIds).toEqual(["conv-1"]);
  });

  it("always: a CLEAN tree is removed, a DIRTY tree is kept", async () => {
    useAgentTaskStore.setState({
      conversations: [
        conv({ id: "conv-clean", worktree: activeWorktree({ worktreePath: "/proj/.pkt-worktrees/conv-clean" }) }),
        conv({ id: "conv-dirty", worktree: activeWorktree({ worktreePath: "/proj/.pkt-worktrees/conv-dirty" }) }),
      ],
    });
    useWorkspaceStore.setState({
      workspaces: [workspace("ws-1", [conversationPane("conv-clean"), conversationPane("conv-dirty")])],
    });

    const result = await archiveWorkspaceWithFanout("ws-1", {
      policy: "always",
      gatherFacts: async ({ conversationId }) =>
        conversationId === "conv-dirty" ? dirtyFacts() : safeFacts(),
    });

    expect(result?.cleanedWorktreeConversationIds).toEqual(["conv-clean"]);
    expect(result?.keptWorktreeConversationIds).toEqual(["conv-dirty"]);
  });

  it("auto-archive NEVER cleans, even a provably-safe tree", async () => {
    useAgentTaskStore.setState({ conversations: [conv({ id: "conv-1", worktree: activeWorktree() })] });
    useWorkspaceStore.setState({ workspaces: [workspace("ws-1", [conversationPane("conv-1")])] });

    const gather = vi.fn(safeFacts);
    const result = await archiveWorkspaceWithFanout("ws-1", { auto: true, policy: "always", gatherFacts: gather });

    expect(removeConversationWorktreeMock).not.toHaveBeenCalled();
    // Auto path forces Keep — it never even gathers facts.
    expect(gather).not.toHaveBeenCalled();
    expect(result?.auto).toBe(true);
    expect(result?.keptWorktreeConversationIds).toEqual(["conv-1"]);
  });
});

describe("archive fan-out — conversation + transcript semantics", () => {
  it("archives member conversations but keeps transcripts", async () => {
    useAgentTaskStore.setState({
      conversations: [conv({ id: "conv-1", archived: false, messages: [] })],
    });
    useWorkspaceStore.setState({ workspaces: [workspace("ws-1", [conversationPane("conv-1")])] });

    await archiveWorkspaceWithFanout("ws-1");

    const c = useAgentTaskStore.getState().conversations.find((x) => x.id === "conv-1");
    expect(c).toBeDefined(); // transcript kept
    expect(c?.archived).toBe(true); // conversation archived
  });
});

describe("delete detaches (existing store action) — conversation survives as a virtual row", () => {
  it("deleting a wrapper leaves the conversation as an unplaced fleet row", () => {
    useAgentTaskStore.setState({ conversations: [conv({ id: "conv-1", archived: false })] });
    const wrapperId = conversationWrapperId("conv-1");
    useWorkspaceStore.setState({
      workspaces: [workspace(wrapperId, [conversationPane("conv-1")], { origin: "conversation" })],
    });

    useWorkspaceStore.getState().deleteWorkspace(wrapperId);

    // Conversation is NOT destroyed…
    expect(useAgentTaskStore.getState().conversations.some((c) => c.id === "conv-1")).toBe(true);
    // …and re-surfaces as an unplaced (virtual) row.
    const row = selectConversationSessions().find((r) => r.id === "conv-1");
    expect(row).toBeDefined();
    expect(row?.workspaceId).toBeUndefined();
  });
});
