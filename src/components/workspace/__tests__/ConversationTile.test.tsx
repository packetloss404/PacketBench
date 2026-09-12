/**
 * ConversationTile (P3-S2).
 *
 * Verifies the tile wrapper without mounting the heavy real AgentChatPane:
 *   - renderTile branches on `pane.kind` (conversation → ConversationTile,
 *     terminal → WorkspacePane) inside WorkspaceMosaicContainer;
 *   - the two additive props (`frame="tile"`, `keyboardScopeActive`) are
 *     threaded, with keyboardScopeActive === (activePaneId === pane.id) so only
 *     the focused tile arms the protected Y/N shortcut (P3-S1 gate, real tiles);
 *   - pointer-down arms focus (activePaneId) as TerminalPane does on click;
 *   - X removes the PANE ONLY — the conversation survives; Archive is the
 *     explicit lifecycle overflow action;
 *   - review auto-zoom uses the EXISTING setZoomedPane and un-zooms only when
 *     review caused the zoom (autoZoomedBy bookkeeping), never remounting the
 *     pane;
 *   - protected store operations (fork-and-resend, queued-send) and per-tile
 *     drafts stay isolated per conversation with TWO tiles mounted.
 *
 * The real agentTaskStore drives the multi-instance assertions (backend mocked
 * exactly as the protected suites do); AgentChatPane and TerminalPane are
 * mocked to the leaf so the test isolates tile-layer wiring.
 */
import { act, fireEvent, render } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentConversation, AgentMessage } from "@/types/agent-conversation";
import type { Workspace } from "@/types/workspace";

// Hoisted so these are initialized before the (hoisted) import chain runs
// agentTaskStore's module-init hydrateConversations().
const {
  listenMock,
  invokeMock,
  closeApiAgentSessionMock,
  cancelApiAgentSessionMock,
  sendApiAgentMessageMock,
  startApiAgentSessionMock,
  loadConversationsMock,
} = vi.hoisted(() => ({
  listenMock: vi.fn().mockResolvedValue(() => {}),
  invokeMock: vi.fn().mockResolvedValue(undefined),
  closeApiAgentSessionMock: vi.fn().mockResolvedValue(undefined),
  cancelApiAgentSessionMock: vi.fn().mockResolvedValue(undefined),
  sendApiAgentMessageMock: vi.fn().mockResolvedValue(undefined),
  startApiAgentSessionMock: vi.fn().mockResolvedValue(undefined),
  loadConversationsMock: vi.fn().mockResolvedValue([]),
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: (...args: unknown[]) => listenMock(...args),
}));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));
vi.mock("@/lib/agentsMd", () => ({
  loadAgentsMd: vi.fn().mockResolvedValue(null),
}));
vi.mock("@/stores/memoryStore", () => ({
  useMemoryStore: {
    getState: vi.fn(() => ({
      composeMemoryBrief: vi.fn(() => ({ text: "" })),
    })),
  },
}));
vi.mock("@/lib/tauri", () => ({
  createPtySession: vi.fn(),
  writePty: vi.fn(),
  killPty: vi.fn(),
  readPtyTranscript: vi.fn().mockResolvedValue({ data: "" }),
  listPtySessions: vi.fn().mockResolvedValue([]),
  detectAgent: vi.fn(),
  loadPersistedState: vi.fn(),
  saveAgentsSlice: vi.fn().mockResolvedValue(undefined),
  startApiAgentSession: (...args: unknown[]) => startApiAgentSessionMock(...args),
  sendApiAgentMessage: (...args: unknown[]) => sendApiAgentMessageMock(...args),
  cancelApiAgentSession: (...args: unknown[]) => cancelApiAgentSessionMock(...args),
  cancelPendingTools: vi.fn(),
  closeApiAgentSession: (...args: unknown[]) => closeApiAgentSessionMock(...args),
  saveConversation: vi.fn().mockResolvedValue(undefined),
  loadConversations: (...args: unknown[]) => loadConversationsMock(...args),
  deleteConversationFile: vi.fn(),
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

// AgentChatPane mock — captures props + counts mounts so we can assert
// threading and the no-remount zoom law.
const chatMounts = vi.hoisted(() => [] as string[]);
const lastProps = vi.hoisted(() => new Map<string, Record<string, unknown>>());
vi.mock("@/components/agents/AgentChatPane", async () => {
  const { useEffect } = await import("react");
  return {
    AgentChatPane: (props: {
      conversationId: string;
      onClose: () => void;
      keyboardScopeActive?: boolean;
    }) => {
      lastProps.set(props.conversationId, props);
      useEffect(() => {
        chatMounts.push(`mount:${props.conversationId}`);
        return () => {
          chatMounts.push(`unmount:${props.conversationId}`);
        };
      }, [props.conversationId]);
      return (
        <div
          data-testid={`chat-${props.conversationId}`}
          data-scope={String(props.keyboardScopeActive)}
        />
      );
    },
  };
});

// TerminalPane mock — the mosaic renderTile branch test needs a terminal pane
// that does not spawn a real PTY.
vi.mock("@/components/session/TerminalPane", () => ({
  TerminalPane: ({ paneId }: { paneId: string }) => (
    <div data-testid={`terminal-${paneId}`} />
  ),
}));

import { ConversationTile } from "@/components/workspace/ConversationTile";
import { WorkspaceMosaicContainer } from "@/components/workspace/WorkspaceMosaicContainer";
import { useAgentTaskStore } from "@/stores/agentTaskStore";
import { useWorkspaceStore } from "@/stores/workspaceStore";
import { useLayoutStore } from "@/stores/layoutStore";
import { useReviewStore } from "@/stores/reviewStore";
import { useAgentDraftStore } from "@/stores/agentDraftStore";

function makeConversation(id: string, over: Partial<AgentConversation> = {}): AgentConversation {
  return {
    id,
    title: `Conversation ${id}`,
    agent: "api-openai",
    projectPath: "/tmp/project",
    status: "idle",
    messages: [],
    sessionId: id,
    rawOutput: "",
    createdAt: 1,
    updatedAt: 1,
    mode: "api",
    provider: "openai",
    model: "gpt-4o",
    ...over,
  };
}

function makeWorkspace(panes: Workspace["panes"]): Workspace {
  const now = Date.now();
  return {
    id: "ws-1",
    name: "Tile workspace",
    agents: [],
    panes,
    projectPath: "/tmp/project",
    createdAt: now,
    updatedAt: now,
    status: "active",
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  chatMounts.length = 0;
  lastProps.clear();
  localStorage.clear();
  listenMock.mockResolvedValue(() => {});
  invokeMock.mockResolvedValue(undefined);
  loadConversationsMock.mockResolvedValue([]);
  closeApiAgentSessionMock.mockResolvedValue(undefined);
  cancelApiAgentSessionMock.mockResolvedValue(undefined);
  sendApiAgentMessageMock.mockResolvedValue(undefined);
  startApiAgentSessionMock.mockResolvedValue(undefined);
  useAgentTaskStore.setState({ conversations: [] });
  useLayoutStore.setState({ activePaneId: "" });
  useReviewStore.setState({ open: false, conversationId: null, focusPath: null });
  useAgentDraftStore.setState({ drafts: {} });
});

describe("WorkspaceMosaicContainer renderTile branch (P3-S2)", () => {
  it("renders ConversationTile for a conversation pane and WorkspacePane for a terminal pane", () => {
    useAgentTaskStore.setState({ conversations: [makeConversation("conv-1")] });
    const workspace = makeWorkspace([
      { id: "pane-term", agentId: "claude-code", sessionId: null },
      { id: "pane-conv", agentId: "terminal", sessionId: null, kind: "conversation", conversationId: "conv-1" },
    ]);
    useWorkspaceStore.setState({ workspaces: [workspace], activeWorkspaceId: "ws-1", zoomedPaneId: null });

    const { container } = render(<WorkspaceMosaicContainer workspace={workspace} />);

    // Conversation pane → ConversationTile → (mocked) AgentChatPane.
    expect(container.querySelector('[data-testid="chat-conv-1"]')).not.toBeNull();
    // Terminal pane → WorkspacePane → (mocked) TerminalPane, untouched.
    expect(container.querySelector('[data-testid="terminal-pane-term"]')).not.toBeNull();
    // The conversation pane must NOT mount a TerminalPane (no rogue PTY).
    expect(container.querySelector('[data-testid="terminal-pane-conv"]')).toBeNull();
  });
});

describe("ConversationTile chrome + wiring", () => {
  function seedSingle() {
    useAgentTaskStore.setState({ conversations: [makeConversation("conv-1")] });
    const workspace = makeWorkspace([
      { id: "pane-conv", agentId: "terminal", sessionId: null, kind: "conversation", conversationId: "conv-1" },
    ]);
    useWorkspaceStore.setState({ workspaces: [workspace], activeWorkspaceId: "ws-1", zoomedPaneId: null });
    return workspace.panes[0];
  }

  it("threads keyboardScopeActive=focused to the mounted AgentChatPane", () => {
    const pane = seedSingle();
    useLayoutStore.setState({ activePaneId: "pane-conv" });
    render(<ConversationTile pane={pane} workspaceId="ws-1" />);
    expect(lastProps.get("conv-1")?.keyboardScopeActive).toBe(true);
  });

  it("arms focus on pointer-down (sets activePaneId)", () => {
    const pane = seedSingle();
    const { container } = render(<ConversationTile pane={pane} workspaceId="ws-1" />);
    expect(useLayoutStore.getState().activePaneId).toBe("");
    fireEvent.pointerDown(container.firstElementChild as Element);
    expect(useLayoutStore.getState().activePaneId).toBe("pane-conv");
  });

  it("X (onClose) removes the pane ONLY — the conversation survives", () => {
    const pane = seedSingle();
    render(<ConversationTile pane={pane} workspaceId="ws-1" />);
    act(() => {
      (lastProps.get("conv-1")?.onClose as () => void)();
    });
    const ws = useWorkspaceStore.getState().workspaces[0];
    expect(ws.panes.find((p) => p.id === "pane-conv")).toBeUndefined();
    // Conversation is untouched (not deleted, not archived).
    const conv = useAgentTaskStore.getState().conversations.find((c) => c.id === "conv-1");
    expect(conv).toBeDefined();
    expect(conv?.archived).toBeFalsy();
  });

  it("Archive (handed to the chat header's ONE overflow menu) archives and removes the tile", () => {
    const pane = seedSingle();
    render(<ConversationTile pane={pane} workspaceId="ws-1" />);
    // The chrome bar no longer carries its own kebab — Archive travels to the
    // chat header's overflow menu as the tile's onArchive.
    act(() => {
      (lastProps.get("conv-1")?.onArchive as () => void)();
    });
    const conv = useAgentTaskStore.getState().conversations.find((c) => c.id === "conv-1");
    expect(conv?.archived).toBe(true);
    const ws = useWorkspaceStore.getState().workspaces[0];
    expect(ws.panes.find((p) => p.id === "pane-conv")).toBeUndefined();
  });

  it("the chrome bar has NO overflow menu of its own (one menu per tile)", () => {
    const pane = seedSingle();
    const { queryByTitle, getByTitle } = render(
      <ConversationTile pane={pane} workspaceId="ws-1" />,
    );
    expect(queryByTitle("More")).toBeNull();
    // Zoom stays in the chrome bar — de-duplication, not a redesign.
    expect(getByTitle("Zoom to focus")).toBeInTheDocument();
  });

  it("labels the close control with what closing actually does (pane only)", () => {
    const pane = seedSingle();
    render(<ConversationTile pane={pane} workspaceId="ws-1" />);
    expect(lastProps.get("conv-1")?.closeLabel).toBe("Close tile");
    expect(lastProps.get("conv-1")?.closeTooltip).toBe(
      "Close tile — removes it from this workspace. The conversation keeps running and stays in the Agents list.",
    );
  });
});

describe("ConversationTile review auto-zoom (autoZoomedBy)", () => {
  function seedSingle() {
    useAgentTaskStore.setState({ conversations: [makeConversation("conv-1")] });
    const workspace = makeWorkspace([
      { id: "pane-conv", agentId: "terminal", sessionId: null, kind: "conversation", conversationId: "conv-1" },
    ]);
    useWorkspaceStore.setState({ workspaces: [workspace], activeWorkspaceId: "ws-1", zoomedPaneId: null });
    return workspace.panes[0];
  }

  it("opening review auto-zooms the tile; closing un-zooms (review caused it)", () => {
    const pane = seedSingle();
    render(<ConversationTile pane={pane} workspaceId="ws-1" />);
    expect(useWorkspaceStore.getState().zoomedPaneId).toBeNull();

    act(() => {
      useReviewStore.setState({ open: true, conversationId: "conv-1" });
    });
    expect(useWorkspaceStore.getState().zoomedPaneId).toBe("pane-conv");

    act(() => {
      useReviewStore.setState({ open: false, conversationId: "conv-1" });
    });
    expect(useWorkspaceStore.getState().zoomedPaneId).toBeNull();
    // The pane was never remounted across the zoom round-trip.
    expect(chatMounts.filter((e) => e === "mount:conv-1")).toHaveLength(1);
    expect(chatMounts.filter((e) => e.startsWith("unmount:"))).toHaveLength(0);
  });

  it("a manual zoom set BEFORE review opens is left intact on review close", () => {
    const pane = seedSingle();
    render(<ConversationTile pane={pane} workspaceId="ws-1" />);
    // User manually zoomed this tile first.
    act(() => {
      useWorkspaceStore.getState().setZoomedPane("pane-conv");
    });
    // Review opens — tile is already zoomed, so review did NOT cause it.
    act(() => {
      useReviewStore.setState({ open: true, conversationId: "conv-1" });
    });
    expect(useWorkspaceStore.getState().zoomedPaneId).toBe("pane-conv");
    // Closing review must NOT un-zoom, since review never caused the zoom.
    act(() => {
      useReviewStore.setState({ open: false, conversationId: "conv-1" });
    });
    expect(useWorkspaceStore.getState().zoomedPaneId).toBe("pane-conv");
  });
});

describe("Two tiles mounted — protected stack stays isolated (P3-S2)", () => {
  function seedTwoTiles() {
    useAgentTaskStore.setState({
      conversations: [
        makeConversation("conv-A", {
          messages: [
            { id: "a1", role: "user", content: "first", timestamp: 1 } as AgentMessage,
            { id: "a2", role: "assistant", content: "reply", timestamp: 2 } as AgentMessage,
            { id: "a3", role: "user", content: "edit me", timestamp: 3 } as AgentMessage,
          ],
        }),
        makeConversation("conv-B", {
          messages: [{ id: "b1", role: "user", content: "B one", timestamp: 1 } as AgentMessage],
        }),
      ],
    });
    const workspace = makeWorkspace([
      { id: "pane-A", agentId: "terminal", sessionId: null, kind: "conversation", conversationId: "conv-A" },
      { id: "pane-B", agentId: "terminal", sessionId: null, kind: "conversation", conversationId: "conv-B" },
    ]);
    useWorkspaceStore.setState({ workspaces: [workspace], activeWorkspaceId: "ws-1", zoomedPaneId: null });
    return workspace;
  }

  it("fork-and-resend on tile A does not touch tile B's conversation", async () => {
    const ws = seedTwoTiles();
    render(
      <>
        <ConversationTile pane={ws.panes[0]} workspaceId="ws-1" />
        <ConversationTile pane={ws.panes[1]} workspaceId="ws-1" />
      </>,
    );
    const before = useAgentTaskStore.getState().conversations.find((c) => c.id === "conv-B")!.messages;

    await act(async () => {
      await useAgentTaskStore.getState().forkAndResend("conv-A", "a3", "edited");
    });

    const convA = useAgentTaskStore.getState().conversations.find((c) => c.id === "conv-A")!;
    // A truncated to before the edited message (a1, a2 survive at the front).
    expect(convA.messages.slice(0, 2).map((m) => m.id)).toEqual(["a1", "a2"]);
    // B is byte-identical.
    const after = useAgentTaskStore.getState().conversations.find((c) => c.id === "conv-B")!.messages;
    expect(after).toEqual(before);
    // Both tiles remained mounted (no remount from the sibling's turn).
    expect(chatMounts.filter((e) => e === "mount:conv-A")).toHaveLength(1);
    expect(chatMounts.filter((e) => e === "mount:conv-B")).toHaveLength(1);
    expect(chatMounts.filter((e) => e.startsWith("unmount:"))).toHaveLength(0);
  });

  it("queued-send-while-streaming on tile A does not queue onto tile B", async () => {
    const ws = seedTwoTiles();
    // A is actively streaming (status active + a live streaming assistant
    // bubble) so a new send is QUEUED, not dispatched.
    useAgentTaskStore.setState({
      conversations: useAgentTaskStore.getState().conversations.map((c) =>
        c.id === "conv-A"
          ? {
              ...c,
              status: "active",
              messages: [
                ...c.messages,
                { id: "a-stream", role: "assistant", content: "", timestamp: 9, isStreaming: true } as AgentMessage,
              ],
            }
          : c,
      ),
    });
    render(
      <>
        <ConversationTile pane={ws.panes[0]} workspaceId="ws-1" />
        <ConversationTile pane={ws.panes[1]} workspaceId="ws-1" />
      </>,
    );

    await act(async () => {
      await useAgentTaskStore.getState().sendMessage("conv-A", "queued while busy");
    });

    const convA = useAgentTaskStore.getState().conversations.find((c) => c.id === "conv-A")!;
    const convB = useAgentTaskStore.getState().conversations.find((c) => c.id === "conv-B")!;
    expect(convA.queuedMessages ?? []).toContain("queued while busy");
    expect(convB.queuedMessages ?? []).toHaveLength(0);
    // No dispatch happened for the queued turn.
    expect(sendApiAgentMessageMock).not.toHaveBeenCalled();
  });

  it("per-tile composer drafts are independent (agentDraftStore)", () => {
    const ws = seedTwoTiles();
    render(
      <>
        <ConversationTile pane={ws.panes[0]} workspaceId="ws-1" />
        <ConversationTile pane={ws.panes[1]} workspaceId="ws-1" />
      </>,
    );
    act(() => {
      useAgentDraftStore.getState().setDraft("conv-A", "draft for A");
      useAgentDraftStore.getState().setDraft("conv-B", "draft for B");
    });
    const drafts = useAgentDraftStore.getState().drafts;
    expect(drafts["conv-A"]).toBe("draft for A");
    expect(drafts["conv-B"]).toBe("draft for B");
  });

  it("Y/N gate arms only the focused tile with two real tiles mounted", () => {
    const ws = seedTwoTiles();
    useLayoutStore.setState({ activePaneId: "pane-A" });
    render(
      <>
        <ConversationTile pane={ws.panes[0]} workspaceId="ws-1" />
        <ConversationTile pane={ws.panes[1]} workspaceId="ws-1" />
      </>,
    );
    expect(lastProps.get("conv-A")?.keyboardScopeActive).toBe(true);
    expect(lastProps.get("conv-B")?.keyboardScopeActive).toBe(false);
  });
});

describe("ConversationTile lifecycle states (P3-S3)", () => {
  function seedWith(conversations: AgentConversation[], conversationId: string) {
    useAgentTaskStore.setState({ conversations });
    const workspace = makeWorkspace([
      {
        id: "pane-conv",
        agentId: "terminal",
        sessionId: null,
        kind: "conversation",
        conversationId,
      },
    ]);
    useWorkspaceStore.setState({
      workspaces: [workspace],
      activeWorkspaceId: "ws-1",
      zoomedPaneId: null,
    });
    return workspace.panes[0];
  }

  it("LOADING: renders the header (title + status) immediately from the session record", () => {
    const pane = seedWith(
      [makeConversation("conv-1", { title: "My task", status: "idle" })],
      "conv-1",
    );
    const { getByText } = render(<ConversationTile pane={pane} workspaceId="ws-1" />);
    // Header title + status pill render synchronously from the record — no
    // dependence on the (mocked) AgentChatPane body, so no blank-header flash.
    expect(getByText("My task")).toBeInTheDocument();
    expect(getByText("idle")).toBeInTheDocument();
  });

  it("MISSING: a dangling conversationId shows the fallback + Remove-tile (removes the pane only)", () => {
    const pane = seedWith([], "ghost-conv");
    const { getByText, queryByTestId } = render(
      <ConversationTile pane={pane} workspaceId="ws-1" />,
    );
    // Fallback face — the heavy AgentChatPane never mounts for a missing conv.
    expect(getByText("This conversation is no longer available.")).toBeInTheDocument();
    expect(queryByTestId("chat-ghost-conv")).toBeNull();

    fireEvent.click(getByText("Remove tile"));
    const ws = useWorkspaceStore.getState().workspaces[0];
    expect(ws.panes.find((p) => p.id === "pane-conv")).toBeUndefined();
  });

  it("MISSING: the layout toolbar can zoom the fallback and restore the grid", () => {
    seedWith([], "ghost-conv");
    const workspace = useWorkspaceStore.getState().workspaces[0];
    const { container, getByRole, getByText } = render(
      <WorkspaceMosaicContainer workspace={workspace} />,
    );
    fireEvent.change(getByRole("combobox", { name: "Select visible pane" }), {
      target: { value: "pane-conv" },
    });
    fireEvent.click(getByRole("button", { name: "Zoom selected pane" }));

    // Match the actual CSS reveal selector, not merely the zoom store flag:
    // without the fallback's marker the mosaic hides every tile here.
    const revealed = container.querySelector(
      '.mosaic-zoom-active .mosaic-tile:has([data-pane-zoomed="true"])',
    );
    expect(revealed).not.toBeNull();
    expect(revealed).toContainElement(getByText("This conversation is no longer available."));
    expect(revealed).toContainElement(getByRole("button", { name: "Remove tile" }));

    fireEvent.click(getByRole("button", { name: "Show all panes" }));
    expect(container.querySelector(".mosaic-zoom-active")).toBeNull();
    expect(getByText("This conversation is no longer available.")).toBeInTheDocument();
  });

  it("MISSING: pointer and keyboard focus select the fallback pane", () => {
    const pane = seedWith([], "ghost-conv");
    const { getByText, getByRole } = render(
      <ConversationTile pane={pane} workspaceId="ws-1" />,
    );
    fireEvent.pointerDown(getByText("This conversation is no longer available."));
    expect(useLayoutStore.getState().activePaneId).toBe(pane.id);
    act(() => useLayoutStore.getState().setActivePaneId("another-pane"));
    act(() => getByRole("button", { name: "Remove tile" }).focus());
    expect(useLayoutStore.getState().activePaneId).toBe(pane.id);
    expect(getByRole("button", { name: "Remove tile" })).toHaveFocus();
  });

  it("FAILED: shows the red pill and a Retry that calls retryLastTurn", () => {
    const pane = seedWith(
      [makeConversation("conv-1", { status: "failed" })],
      "conv-1",
    );
    const retrySpy = vi
      .spyOn(useAgentTaskStore.getState(), "retryLastTurn")
      .mockResolvedValue(undefined);

    const { getByText, getAllByText } = render(
      <ConversationTile pane={pane} workspaceId="ws-1" />,
    );

    // Red status pill (chrome) + the failed banner both surface the failure.
    expect(getAllByText("failed").length).toBeGreaterThanOrEqual(1);

    fireEvent.click(getByText("Retry"));
    expect(retrySpy).toHaveBeenCalledWith("conv-1");
    retrySpy.mockRestore();
  });
});
