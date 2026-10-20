import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn().mockResolvedValue(() => {}),
}));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/agentsMd", () => ({
  loadAgentsMd: vi.fn().mockResolvedValue(null),
}));
vi.mock("@/stores/memoryStore", () => ({
  useMemoryStore: {
    getState: vi.fn(() => ({})),
  },
}));
vi.mock("@/lib/tauri", () => ({
  createPtySession: vi.fn(),
  writePty: vi.fn(),
  killPty: vi.fn(),
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
  getGitStatus: vi.fn(),
  removeConversationWorktree: vi.fn(),
  saveWorkspacesSlice: vi.fn().mockResolvedValue(undefined),
  saveAgentsSlice: vi.fn().mockResolvedValue(undefined),
  saveServersSlice: vi.fn().mockResolvedValue(undefined),
  saveFlightsSlice: vi.fn().mockResolvedValue(undefined),
  saveUiSlice: vi.fn().mockResolvedValue(undefined),
  loadPersistedState: vi.fn().mockResolvedValue({
    agents: [],
    flights: [],
    issues: [],
    ui: {},
  }),
}));

import {
  attachTerminalToConversationProject,
  delegateWorkspaceToAgents,
  linkConversationToFlight,
  openConversationGitEnding,
  openConversationProjectInWorkspace,
  openFlightAttemptInWorkspace,
  inspectFlightAttemptInWorkspace,
} from "@/lib/agentHandoffs";
import { useAgentStore } from "@/stores/agentStore";
import { useAgentTaskStore } from "@/stores/agentTaskStore";
import { useAppStore } from "@/stores/appStore";
import { useRightDockStore } from "@/stores/rightDockStore";
import { useFlightStore } from "@/stores/flightStore";
import { useLayoutStore } from "@/stores/layoutStore";
import { useServerStore } from "@/stores/serverStore";
import { useWorkspaceStore } from "@/stores/workspaceStore";
import type { AgentConversation } from "@/types/agent-conversation";
import type { Attempt } from "@/types/flight";
import { useWorkspaceAgentsDogfoodStore } from "@/stores/workspaceAgentsDogfoodStore";

function conversation(overrides: Partial<AgentConversation> = {}): AgentConversation {
  return {
    id: "conv-1",
    title: "Finish the handoff",
    agent: "api-openai",
    projectPath: "D:\\projects\\PacketBench",
    status: "idle",
    messages: [],
    sessionId: "session-1",
    rawOutput: "",
    createdAt: 10,
    updatedAt: 20,
    mode: "api",
    permissionMode: "ask_for_risky",
    approveWrites: true,
    enabledMcpServerIds: ["trusted-local"],
    ...overrides,
  };
}

function restoredAttempt(patch: Partial<Attempt> = {}): { flightId: string; attempt: Attempt } {
  const flight = useFlightStore
    .getState()
    .addFlight({
      title: "Restored result",
      objective: "Inspect work after restart",
      priority: "medium",
      projectPath: "D:\\projects\\example",
    });
  const attempt: Attempt = {
    id: "restored-attempt",
    flightId: flight.id,
    target: {
      kind: "local",
      basePath: "D:\\projects\\example",
      worktreePath: "D:\\projects\\example\\.worktrees\\restored-attempt",
    },
    agentConfigId: "api-sugar",
    model: "model",
    provider: "sugar",
    branch: "pkt/restored-attempt",
    baseBranch: "main",
    sessionId: "lost-session",
    status: "cancelled",
    cost: 0,
    tokens: 0,
    recovery: { state: "retained", retainedAt: 123, reason: "Desktop restarted" },
    ...patch,
  };
  useFlightStore.setState({
    flights: [{ ...flight, attempts: [attempt] }],
    activeFlightId: flight.id,
  });
  useAgentTaskStore.setState({ conversations: [], selectedConversationId: null });
  return { flightId: flight.id, attempt };
}

describe("WA3 agent handoffs", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    useAgentTaskStore.setState({
      conversations: [conversation()],
      selectedConversationId: "conv-1",
      selectedRepo: null,
    });
    useWorkspaceStore.setState({
      workspaces: [],
      activeWorkspaceId: null,
      zoomedPaneId: null,
      focusPaneRequest: null,
    });
    useLayoutStore.setState({ activePaneId: "", projectPath: "" });
    useAppStore.setState({
      activeView: "agents",
      gitPanelConversationId: null,
      gitPanelWorkspaceId: null,
    });
    useRightDockStore.getState().reset();
    useServerStore.setState({ servers: [] });
    useFlightStore.setState({ flights: [], activeFlightId: null });
    useWorkspaceAgentsDogfoodStore.getState().reset();
    useAgentStore.setState((state) => ({
      agents: state.agents.map((agent) => ({
        ...agent,
        installed: agent.id === "packetcode" || agent.id === "codex",
      })),
    }));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("opens the project in a PacketCode-first Workspace without attaching the conversation", () => {
    const result = openConversationProjectInWorkspace("conv-1");

    expect(result).toMatchObject({ ok: true, created: true });
    const workspace = useWorkspaceStore.getState().workspaces[0];
    expect(workspace.agents).toEqual(["packetcode"]);
    expect(workspace.projectPath).toBe("D:\\projects\\PacketBench");
    expect(workspace.panes.some((pane) => pane.kind === "conversation")).toBe(false);
    expect(useAgentTaskStore.getState().selectedConversationId).toBe("conv-1");
    expect(useAppStore.getState().activeView).toBe("workspace");
    expect(
      useWorkspaceAgentsDogfoodStore.getState().evidence.counters.agent_opened_workspace_project,
    ).toBe(1);
  });

  it("preserves the SSH server and exact remote worktree when opening Workspace", () => {
    useServerStore.setState({
      servers: [
        {
          id: "server-1",
          name: "Build box",
          host: "example.com",
          port: 22,
          username: "ian",
          authMethod: "agent",
          installedAgents: ["packetcode"],
        },
      ],
    });
    useAgentTaskStore.setState({
      conversations: [
        conversation({
          projectPath: "/srv/app",
          sshTarget: {
            id: "server-1",
            name: "Build box",
            host: "example.com",
            user: "ian",
            remotePath: "/srv/app",
          },
          worktree: {
            basePath: "/srv/app",
            worktreePath: "/srv/app/.pkt-worktrees/conv-1",
            branch: "pkt/conv-1",
            baseBranch: "main",
            createdAt: 1,
            state: "active",
          },
        }),
      ],
    });

    const result = openConversationProjectInWorkspace("conv-1");

    expect(result).toMatchObject({ ok: true, created: true });
    expect(useWorkspaceStore.getState().workspaces[0]).toMatchObject({
      serverId: "server-1",
      projectPath: "/srv/app/.pkt-worktrees/conv-1",
      remoteProjectPath: "/srv/app/.pkt-worktrees/conv-1",
      agents: ["packetcode"],
    });
  });

  it("returns a typed stale-target result without mutating presentation state", () => {
    const beforeView = useAppStore.getState().activeView;

    expect(openConversationProjectInWorkspace("missing")).toMatchObject({
      ok: false,
      code: "conversation_not_found",
    });
    expect(useWorkspaceStore.getState().workspaces).toHaveLength(0);
    expect(useAppStore.getState().activeView).toBe(beforeView);
  });

  it("adds a separately addressable terminal on the exact project", () => {
    const result = attachTerminalToConversationProject("conv-1");

    expect(result.ok).toBe(true);
    const workspace = useWorkspaceStore.getState().workspaces[0];
    expect(workspace.panes).toHaveLength(1);
    expect(workspace.panes[0].agentId).toBe("terminal");
    expect(workspace.panes[0].kind).toBeUndefined();
    expect(workspace.panes[0].conversationId).toBeUndefined();
  });

  it("opens the authoritative Git ending in the project Workspace without attaching", () => {
    const result = openConversationGitEnding("conv-1");

    expect(result.ok).toBe(true);
    const workspaceId = useWorkspaceStore.getState().workspaces[0]?.id;
    expect(useAppStore.getState()).toMatchObject({
      activeView: "workspace",
      gitPanelConversationId: "conv-1",
      gitPanelWorkspaceId: workspaceId,
    });
    // D2: the panel's VISIBILITY is the RightDock's, not appStore's.
    expect(useRightDockStore.getState().surfaces.workspace).toMatchObject({
      activePanel: "git",
      expanded: true,
    });
    expect(
      useWorkspaceStore
        .getState()
        .workspaces.flatMap((workspace) => workspace.panes)
        .filter((pane) => pane.conversationId === "conv-1"),
    ).toHaveLength(0);
  });

  it("opens a Flight attempt project in Workspace without attaching its conversation", () => {
    const result = openFlightAttemptInWorkspace("conv-1");

    expect(result).toMatchObject({ ok: true, conversationId: "conv-1" });
    expect(
      useWorkspaceStore
        .getState()
        .workspaces.flatMap((workspace) => workspace.panes)
        .filter((pane) => pane.kind === "conversation"),
    ).toHaveLength(0);
    expect(
      useWorkspaceAgentsDogfoodStore.getState().evidence.counters.flight_attempt_opened_workspace,
    ).toBe(1);
  });

  it("delegates a remote Workspace to the Agents launcher with the same SSH target", () => {
    useServerStore.setState({
      servers: [
        {
          id: "server-1",
          name: "Build box",
          host: "example.com",
          port: 22,
          username: "ian",
          authMethod: "agent",
          installedAgents: ["packetcode"],
        },
      ],
    });
    const workspaceId = useWorkspaceStore
      .getState()
      .createWorkspace("Remote app", ["packetcode"], "/srv/app", {
        serverId: "server-1",
        remoteProjectPath: "/srv/app",
      });

    const result = delegateWorkspaceToAgents(workspaceId);

    expect(result).toMatchObject({ ok: true, workspaceId });
    expect(useAgentTaskStore.getState().selectedRepo).toContain("server-1");
    expect(useAgentTaskStore.getState().selectedConversationId).toBeNull();
    expect(useAppStore.getState().activeView).toBe("agents");
  });

  it("reports a removed SSH target instead of throwing or creating a local fallback", () => {
    useAgentTaskStore.setState({
      conversations: [
        conversation({
          projectPath: "/srv/app",
          sshTarget: {
            id: "removed-server",
            name: "Removed",
            host: "example.com",
            user: "ian",
            remotePath: "/srv/app",
          },
        }),
      ],
    });

    expect(openConversationProjectInWorkspace("conv-1")).toMatchObject({
      ok: false,
      code: "workspace_not_found",
    });
    expect(useWorkspaceStore.getState().workspaces).toHaveLength(0);
  });

  it("links one durable conversation reference to a Flight idempotently", () => {
    const flight = useFlightStore.getState().addFlight({
      title: "WA3",
      objective: "Ship handoffs",
      priority: "high",
      projectPath: "D:\\projects\\PacketBench",
    });

    const first = linkConversationToFlight("conv-1", flight.id);
    const second = linkConversationToFlight("conv-1", flight.id, {
      openFlight: true,
    });

    expect(first).toMatchObject({ ok: true, alreadyLinked: false });
    expect(second).toMatchObject({ ok: true, alreadyLinked: true });
    expect(
      useFlightStore.getState().flights.find((item) => item.id === flight.id)?.linkedSessionIds,
    ).toEqual(["conv-1"]);
    expect(useFlightStore.getState().activeFlightId).toBe(flight.id);
    expect(useAppStore.getState().activeView).toBe("flights");
  });

  describe("Flight inspection after restart", () => {
    it("opens the exact local retained worktree without a surviving conversation and reuses it on a second inspection", () => {
      const { flightId, attempt } = restoredAttempt();
      const first = inspectFlightAttemptInWorkspace(flightId, attempt.id);
      expect(first).toMatchObject({ ok: true, created: true });
      const workspace = useWorkspaceStore.getState().workspaces[0];
      expect(workspace).toMatchObject({
        projectPath: attempt.target.worktreePath,
        agents: ["terminal"],
      });
      expect(workspace.serverId).toBeUndefined();
      expect(workspace.panes.every((pane) => !pane.conversationId)).toBe(true);
      expect(useAgentTaskStore.getState().conversations).toEqual([]);
      expect(useAppStore.getState().activeView).toBe("workspace");
      expect(inspectFlightAttemptInWorkspace(flightId, attempt.id)).toMatchObject({
        ok: true,
        created: false,
        workspaceId: workspace.id,
      });
      expect(useWorkspaceStore.getState().workspaces).toHaveLength(1);
    });

    it("opens a cleaned accepted result's base repository rather than its removed worktree", () => {
      const { flightId, attempt } = restoredAttempt({ status: "completed", recovery: undefined });
      expect(inspectFlightAttemptInWorkspace(flightId, attempt.id)).toMatchObject({ ok: true });
      expect(useWorkspaceStore.getState().workspaces[0].projectPath).toBe(attempt.target.basePath);
      expect(useWorkspaceStore.getState().workspaces[0].projectPath).not.toBe(
        attempt.target.worktreePath,
      );
      expect(useAgentTaskStore.getState().conversations).toHaveLength(0);
    });

    it("opens the exact pinned SSH worktree without using the server's different default path or a local fallback", () => {
      useServerStore.setState({
        servers: [
          {
            id: "restored-host",
            name: "Build host",
            host: "example.com",
            port: 22,
            username: "builder",
            authMethod: "agent",
            hostFingerprint: "SHA256:fixture",
            remotePath: "/srv/default-project",
            installedAgents: ["packetcode"],
          },
        ],
      });
      const { flightId, attempt } = restoredAttempt({
        target: {
          kind: "ssh",
          serverId: "restored-host",
          basePath: "/srv/project",
          worktreePath: "/srv/project/.worktrees/restored-attempt",
        },
      });
      expect(inspectFlightAttemptInWorkspace(flightId, attempt.id)).toMatchObject({
        ok: true,
        created: true,
      });
      const workspace = useWorkspaceStore.getState().workspaces[0];
      expect(workspace).toMatchObject({
        serverId: "restored-host",
        projectPath: attempt.target.worktreePath,
        remoteProjectPath: attempt.target.worktreePath,
        agents: ["terminal"],
      });
      expect(workspace.projectPath).not.toBe("/srv/default-project");
      expect(useAgentTaskStore.getState().conversations).toHaveLength(0);
    });

    it("refuses a missing SSH host without changing view or creating any local Workspace", () => {
      const { flightId, attempt } = restoredAttempt({
        target: {
          kind: "ssh",
          serverId: "missing-host",
          basePath: "/srv/project",
          worktreePath: "/srv/project/.worktrees/restored-attempt",
        },
      });
      const before = useAppStore.getState().activeView;
      expect(inspectFlightAttemptInWorkspace(flightId, attempt.id)).toMatchObject({
        ok: false,
        code: "unsupported_target",
        message: expect.stringMatching(/saved SSH host/i),
      });
      expect(useWorkspaceStore.getState().workspaces).toEqual([]);
      expect(useAppStore.getState().activeView).toBe(before);
      expect(
        useWorkspaceAgentsDogfoodStore.getState().evidence.counters.flight_attempt_opened_workspace,
      ).toBe(0);
    });

    it("returns a typed stale-attempt failure without requiring or creating a conversation", () => {
      const { flightId } = restoredAttempt();
      expect(inspectFlightAttemptInWorkspace(flightId, "missing-attempt")).toMatchObject({
        ok: false,
        code: "flight_not_found",
      });
      expect(useWorkspaceStore.getState().workspaces).toHaveLength(0);
      expect(useAgentTaskStore.getState().conversations).toHaveLength(0);
    });
  });
});
