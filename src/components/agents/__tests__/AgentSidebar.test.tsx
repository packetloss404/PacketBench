import { act } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AgentSidebar } from "@/components/agents/AgentSidebar";
import { ToastProvider } from "@/components/ui/Toast";
import { useAgentApprovalStore } from "@/stores/agentApprovalStore";
import { useAgentSidebarPrefsStore } from "@/stores/agentSidebarPrefsStore";
import type { AgentConversation } from "@/types/agent-conversation";

const agentStore = vi.hoisted(() => ({
  state: {
    conversations: [] as AgentConversation[],
    deleteConversation: vi.fn(),
    archiveConversation: vi.fn(),
    unarchiveConversation: vi.fn(),
  },
}));

// The sidebar now also imports `engineDirectoryRecord` from this module (the
// synthetic capability record for engine-only rows), so the mock became a
// PARTIAL one: only the hook is a fixture, every other export keeps its real
// implementation. That in turn pulls in the real store module, hence the two
// Tauri stubs above it.
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn().mockResolvedValue(() => {}) }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn().mockResolvedValue(undefined) }));

vi.mock("@/stores/agentTaskStore", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/stores/agentTaskStore")>()),
  // `getState` is required by the shared delete confirm, which reads the
  // conversation imperatively to resolve its worktree.
  useAgentTaskStore: Object.assign(
    (selector: (state: typeof agentStore.state) => unknown) => selector(agentStore.state),
    { getState: () => agentStore.state },
  ),
}));

function conversation(overrides: Partial<AgentConversation> = {}): AgentConversation {
  return {
    id: "conv-1",
    title: "Investigate agent pane",
    agent: "api-openai",
    projectPath: "D:\\projects\\PacketBench",
    status: "idle",
    messages: [
      {
        id: "msg-1",
        role: "user",
        content: "Check the Agents route",
        timestamp: 1,
      },
    ],
    sessionId: "conv-1",
    rawOutput: "",
    createdAt: 1,
    updatedAt: 10,
    mode: "api",
    provider: "openai",
    model: "gpt-5",
    ...overrides,
  };
}

describe("AgentSidebar", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    agentStore.state.conversations = [conversation()];
    useAgentApprovalStore.setState({
      permissions: new Map(),
      edits: new Map(),
    });
    useAgentSidebarPrefsStore.setState({
      prefs: {},
      projectLabels: {},
    });
  });

  it("selects an Agent conversation without requiring a Workspace row", () => {
    const onSelect = vi.fn();
    render(<AgentSidebar selectedId={null} onSelect={onSelect} onNewAgent={vi.fn()} />);

    fireEvent.click(screen.getByText("Investigate agent pane"));

    expect(onSelect).toHaveBeenCalledWith("conv-1");
    expect(screen.getByText("PacketBench")).toBeInTheDocument();
  });

  it("offers exactly ONE New agent control (the labelled footer CTA) and it works", () => {
    const onNewAgent = vi.fn();
    render(<AgentSidebar selectedId={null} onSelect={vi.fn()} onNewAgent={onNewAgent} />);

    // The header "+" that called this identical handler is gone — top+bottom
    // duplication inside one 252px sidebar was the owner's complaint.
    const createControls = screen.getAllByRole("button", { name: /new agent/i });
    expect(createControls).toHaveLength(1);
    expect(createControls[0]).toHaveTextContent("New agent");

    fireEvent.click(createControls[0]);

    expect(onNewAgent).toHaveBeenCalledTimes(1);
  });

  it("pulls pending approvals into a Needs you section", () => {
    act(() => {
      useAgentApprovalStore.getState().addPendingPermission("conv-1", {
        id: "perm-1",
        name: "bash",
        arguments: "{}",
      });
    });

    render(<AgentSidebar selectedId={null} onSelect={vi.fn()} onNewAgent={vi.fn()} />);

    expect(screen.getByText("Needs you")).toBeInTheDocument();
    expect(screen.getByText("Investigate agent pane")).toBeInTheDocument();
  });

  it("confirms a conversation delete by name, and deletes nothing on cancel", () => {
    // Ran in the project root — no worktree, so no worktree warning either.
    agentStore.state.conversations = [conversation({ projectPath: "/repo" })];
    render(
      <ToastProvider>
        <AgentSidebar selectedId={null} onSelect={vi.fn()} onNewAgent={vi.fn()} />
      </ToastProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Delete conversation" }));

    expect(screen.getByText("Delete conversation?")).toBeInTheDocument();
    expect(screen.getByText("\u201cInvestigate agent pane\u201d")).toBeInTheDocument();
    expect(screen.getByText(/will be closed and its history removed/)).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect(agentStore.state.deleteConversation).not.toHaveBeenCalled();
    expect(screen.queryByText("Delete conversation?")).not.toBeInTheDocument();
  });

  it("sorts pinned conversations ahead of newer unpinned conversations", () => {
    agentStore.state.conversations = [
      conversation({ id: "old", title: "Older pinned", updatedAt: 1 }),
      conversation({ id: "new", title: "Newer unpinned", updatedAt: 2 }),
    ];
    useAgentSidebarPrefsStore.setState({
      prefs: { old: { pinned: true } },
    });

    render(<AgentSidebar selectedId={null} onSelect={vi.fn()} onNewAgent={vi.fn()} />);

    const titles = screen
      .getAllByText(/Older pinned|Newer unpinned/)
      .map((element) => element.textContent);
    expect(titles).toEqual(["Older pinned", "Newer unpinned"]);
  });

  it("groups worktree and root conversations under one base project", () => {
    agentStore.state.conversations = [
      conversation({ id: "root", title: "Root thread" }),
      conversation({
        id: "wt-b",
        title: "Worktree thread",
        projectPath: "D:/projects/PacketBench/.pkt-worktrees/conv-b",
        worktree: {
          basePath: "D:/projects/PacketBench",
          worktreePath: "D:/projects/PacketBench/.pkt-worktrees/conv-b",
          branch: "pkt/conv-b",
          createdAt: 1,
          state: "active",
        },
      }),
    ];

    render(<AgentSidebar selectedId={null} onSelect={vi.fn()} onNewAgent={vi.fn()} />);

    // One stable group header for the base project, not per worktree path.
    expect(screen.getAllByText("PacketBench")).toHaveLength(1);
    expect(screen.getByText("Root thread")).toBeInTheDocument();
    expect(screen.getByText("Worktree thread")).toBeInTheDocument();
  });

  it("distinguishes two repositories on the same SSH host", () => {
    agentStore.state.conversations = [
      conversation({
        id: "s1",
        title: "Repo A thread",
        projectPath: "/srv/repoA",
        sshTarget: {
          id: "box",
          name: "Box",
          host: "box.example",
          user: "ian",
          remotePath: "/srv/repoA",
        },
      }),
      conversation({
        id: "s2",
        title: "Repo B thread",
        projectPath: "/srv/repoB",
        sshTarget: {
          id: "box",
          name: "Box",
          host: "box.example",
          user: "ian",
          remotePath: "/srv/repoB",
        },
      }),
    ];

    render(<AgentSidebar selectedId={null} onSelect={vi.fn()} onNewAgent={vi.fn()} />);

    expect(screen.getByText("repoA @ Box")).toBeInTheDocument();
    expect(screen.getByText("repoB @ Box")).toBeInTheDocument();
  });
});
