import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { WorkspaceCreationModal } from "@/components/workspace/WorkspaceCreationModal";
import { WorkspaceView } from "@/components/views/WorkspaceView";
import type { Workspace } from "@/types/workspace";

// Phase 3.1: the modal probes the remote path via Tauri before allowing
// Save. Mock the probe so the test doesn't need a real SSH backend.
vi.mock("@/lib/tauri", async () => {
  const actual = await vi.importActual<typeof import("@/lib/tauri")>("@/lib/tauri");
  return {
    ...actual,
    sshCheckRemotePath: vi.fn().mockResolvedValue({
      exists: true,
      isDirectory: true,
      isGitRepo: false,
    }),
  };
});

const mocks = vi.hoisted(() => {
  const remoteWorkspace: Workspace = {
    id: "ws-remote",
    name: "Remote",
    agents: ["terminal"],
    panes: [
      {
        id: "pane-terminal",
        agentId: "terminal",
        sessionId: null,
      },
    ],
    projectPath: "/srv/app",
    createdAt: 1,
    updatedAt: 1,
    status: "active",
    serverId: "srv-1",
    remoteProjectPath: "/srv/app",
  };

  return {
    appState: {
      initialized: true,
      setActiveView: vi.fn(),
      openSettings: vi.fn(),
    },
    layoutState: {
      projectPath: "D:\\projects\\PacketBench",
    },
    workspaceState: {
      workspaces: [remoteWorkspace],
      activeWorkspaceId: "ws-remote",
      setActiveWorkspace: vi.fn(),
      createWorkspace: vi.fn(() => "ws-new"),
      addPane: vi.fn(() => "pane-new"),
      setBypassPermissions: vi.fn(),
      creationRequest: null as number | null,
      clearWorkspaceCreationRequest: vi.fn(),
    },
    agentState: {
      agents: [
        { id: "claude-code", installed: true },
        { id: "codex", installed: true },
        { id: "opencode", installed: true },
        { id: "packetcode", installed: true },
      ],
      detecting: false,
    },
    serverState: {
      servers: [
        {
          id: "srv-1",
          name: "Remote",
          host: "example.com",
          port: 22,
          username: "ian",
          authMethod: "agent",
          remotePath: "/srv/app",
          installedAgents: ["claude-code"],
          // Phase 3.1: the workspace creation modal blocks Save when the
          // selected server has no pinned host fingerprint. Provide one
          // so the existing remote-template assertion still passes.
          hostFingerprint: "SHA256:example-fingerprint-for-test",
        },
      ],
    },
    delegateWorkspaceToAgents: vi.fn(),
  };
});

vi.mock("@/lib/agentHandoffs", () => ({
  delegateWorkspaceToAgents: mocks.delegateWorkspaceToAgents,
}));

vi.mock("@/stores/workspaceStore", () => {
  const useWorkspaceStore = Object.assign(
    vi.fn((selector: (state: typeof mocks.workspaceState) => unknown) =>
      selector(mocks.workspaceState),
    ),
    {
      getState: vi.fn(() => mocks.workspaceState),
    },
  );
  return { useWorkspaceStore };
});

vi.mock("@/stores/appStore", () => ({
  useAppStore: Object.assign(
    vi.fn((selector: (state: typeof mocks.appState) => unknown) => selector(mocks.appState)),
    {
      getState: vi.fn(() => mocks.appState),
    },
  ),
}));

vi.mock("@/stores/layoutStore", () => ({
  useLayoutStore: vi.fn((selector: (state: typeof mocks.layoutState) => unknown) =>
    selector(mocks.layoutState),
  ),
}));

vi.mock("@/stores/agentStore", () => ({
  useAgentStore: Object.assign(
    vi.fn((selector: (state: typeof mocks.agentState) => unknown) => selector(mocks.agentState)),
    {
      getState: vi.fn(() => mocks.agentState),
    },
  ),
}));

vi.mock("@/stores/serverStore", () => ({
  useServerStore: Object.assign(
    vi.fn((selector: (state: typeof mocks.serverState) => unknown) => selector(mocks.serverState)),
    {
      getState: vi.fn(() => mocks.serverState),
    },
  ),
}));

vi.mock("@/stores/promptStore", () => ({
  usePromptStore: vi.fn((selector: (state: { templates: unknown[] }) => unknown) =>
    selector({ templates: [] }),
  ),
}));

vi.mock("@/stores/editorStore", () => ({
  isFileDirty: () => false,
  isMarkdownPath: () => false,
  useEditorStore: vi.fn(
    (
      selector: (state: {
        openFiles: unknown[];
        activeFileId: null;
        closeFile: () => void;
        setActiveFile: () => void;
      }) => unknown,
    ) =>
      selector({
        openFiles: [],
        activeFileId: null,
        closeFile: vi.fn(),
        setActiveFile: vi.fn(),
      }),
  ),
}));

vi.mock("@/stores/memoryStore", () => ({
  useMemoryStore: vi.fn(
    (selector: (state: { patterns: unknown[]; isLearning: boolean }) => unknown) =>
      selector({ patterns: [], isLearning: false }),
  ),
}));

vi.mock("@/lib/onboarding", () => ({
  isOnboardingComplete: () => true,
}));

vi.mock("@/components/workspace/WorkspaceMosaicContainer", () => ({
  WorkspaceMosaicContainer: () => <div data-testid="workspace-mosaic" />,
}));

vi.mock("@/components/onboarding/OnboardingPane", () => ({
  OnboardingPane: () => <div />,
}));

vi.mock("@/components/editor/EditorPane", () => ({
  EditorPane: () => <div />,
}));

vi.mock("@/components/workspace/GitDashboard", () => ({
  GitDashboard: () => <div />,
}));

describe("workspace launch installed-agent checks", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // AdvancedAccordion persists its open/closed state to localStorage;
    // clear it so the remote-launch test's forceOpenOnFirstMount doesn't
    // leak into the local three-field test's "collapsed by default" check.
    localStorage.clear();
    mocks.workspaceState.creationRequest = null;
    mocks.workspaceState.workspaces[0].panes = [
      { id: "pane-terminal", agentId: "terminal", sessionId: null },
    ];
  });

  it("filters remote workspace templates through server installedAgents", async () => {
    render(
      <WorkspaceCreationModal onClose={vi.fn()} serverId="srv-1" remoteProjectPath="/srv/app" />,
    );

    // The "Review Pair" template wants claude-code + codex, but the mock
    // server only reports claude-code installed — applying it must filter
    // the sessions down to the remotely-available subset. (This used the
    // "Research" template before the Gemini CLI removal deleted it.)
    fireEvent.click(screen.getByRole("button", { name: /review pair/i }));

    // The new Location step debounces an SSH probe before enabling Save.
    // Wait for the button to become enabled before clicking it.
    const saveBtn = screen.getByRole("button", { name: "Create Workspace" });
    await waitFor(() => expect(saveBtn).not.toBeDisabled(), { timeout: 2000 });
    fireEvent.click(saveBtn);

    expect(mocks.workspaceState.createWorkspace).toHaveBeenCalledWith(
      "Review Pair",
      ["claude-code"],
      "/srv/app",
      expect.objectContaining({
        serverId: "srv-1",
        remoteProjectPath: "/srv/app",
      }),
    );
  });

  it("collapses to a three-field flow (name, project, template) with Advanced hidden by default", () => {
    render(<WorkspaceCreationModal onClose={vi.fn()} />);

    // Bypass permissions — like the rest of the location/agent/model tuning
    // — lives behind Advanced, which stays collapsed on a bare launch.
    const advancedToggle = screen.getByRole("button", { name: /advanced/i });
    expect(advancedToggle).toHaveAttribute("aria-expanded", "false");

    fireEvent.click(advancedToggle);
    expect(screen.getByText("Bypass permissions")).toBeInTheDocument();
    fireEvent.click(advancedToggle);

    // Detected PacketCode is the default-selected template, so naming the
    // workspace is the only field a bare launch needs to touch.
    fireEvent.change(screen.getByPlaceholderText("My Workspace"), {
      target: { value: "My New Workspace" },
    });

    const saveBtn = screen.getByRole("button", { name: "Create Workspace" });
    expect(saveBtn).not.toBeDisabled();
    fireEvent.click(saveBtn);

    expect(mocks.workspaceState.createWorkspace).toHaveBeenCalledWith(
      "My New Workspace",
      ["packetcode"],
      mocks.layoutState.projectPath,
      expect.anything(),
    );
  });

  it("template name-seeding is not sticky, and never overwrites a typed name", () => {
    render(<WorkspaceCreationModal onClose={vi.fn()} />);

    const nameInput = screen.getByPlaceholderText("My Workspace") as HTMLInputElement;
    // Seeded from the project folder, so a bare launch needs no typing.
    expect(nameInput.value).toBe("PacketBench");

    fireEvent.click(screen.getByRole("button", { name: /cli pair/i }));
    expect(nameInput.value).toBe("CLI Pair");

    // The second template used to be ignored because the seed only ran while
    // the field was empty.
    fireEvent.click(screen.getByRole("button", { name: /review pair/i }));
    expect(nameInput.value).toBe("Review Pair");

    fireEvent.change(nameInput, { target: { value: "Mine" } });
    fireEvent.click(screen.getByRole("button", { name: /cli pair/i }));
    expect(nameInput.value).toBe("Mine");
  });

  it("disables CLI sessions that are unavailable on the active remote server", () => {
    render(<WorkspaceView />);

    fireEvent.click(screen.getByRole("button", { name: /add session/i }));

    // The remote server only reports claude-code installed, so the Codex CLI
    // row is gated off while Claude Code adds instantly.
    expect(screen.getByRole("button", { name: "Codex CLI" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Claude Code" }));

    // Multi-account CLI support: an untouched row passes no account option, so
    // `addPane` re-resolves the sticky per-project default itself.
    expect(mocks.workspaceState.addPane).toHaveBeenCalledWith(
      "ws-remote",
      "claude-code",
      undefined,
    );
    expect(mocks.workspaceState.addPane).not.toHaveBeenCalledWith("ws-remote", "codex", undefined);
  });

  it("opens the creation form for a global creation request (Toolbar / Ctrl+K)", () => {
    // The Toolbar "+ New" menu and the command palette are mounted outside
    // this surface; they publish a token rather than each rendering their own
    // modal instance.
    mocks.workspaceState.creationRequest = 1;

    render(<WorkspaceView />);

    expect(screen.getByText("New Workspace")).toBeInTheDocument();
    expect(mocks.workspaceState.clearWorkspaceCreationRequest).toHaveBeenCalled();
  });

  it("delegates the active Workspace target to the Agents launcher", () => {
    render(<WorkspaceView />);

    fireEvent.click(screen.getByRole("button", { name: "Delegate" }));

    expect(mocks.delegateWorkspaceToAgents).toHaveBeenCalledWith("ws-remote");
  });

  it("counts viewers and saved conversations separately while preserving CLI account groups", () => {
    mocks.workspaceState.workspaces[0].panes = [
      { id: "terminal-legacy", agentId: "terminal", sessionId: null },
      { id: "terminal-explicit", kind: "terminal", agentId: "terminal", sessionId: null },
      { id: "claude-a-1", agentId: "claude-code", accountId: "account-a", sessionId: null },
      { id: "claude-a-2", agentId: "claude-code", accountId: "account-a", sessionId: null },
      { id: "claude-b", agentId: "claude-code", accountId: "account-b", sessionId: null },
      {
        id: "file-a",
        kind: "file",
        agentId: "terminal",
        filePath: "/app/README.md",
        sessionId: null,
      },
      {
        id: "file-b",
        kind: "file",
        agentId: "terminal",
        accountId: "inert-file-account",
        filePath: "/app/config.json",
        sessionId: null,
      },
      {
        id: "chat-a",
        kind: "conversation",
        agentId: "terminal",
        conversationId: "conversation-a",
        sessionId: null,
      },
      {
        id: "chat-b",
        kind: "conversation",
        agentId: "terminal",
        conversationId: "conversation-b",
        sessionId: null,
      },
    ];

    render(<WorkspaceView />);

    expect(screen.getByText("Terminal x2")).toBeInTheDocument();
    expect(screen.getByText("File viewer x2")).toBeInTheDocument();
    expect(screen.getByText("Saved conversation x2")).toBeInTheDocument();
    expect(screen.getByText("Claude x2")).toBeInTheDocument();
    expect(screen.getByText("Claude")).toBeInTheDocument();
    expect(screen.getAllByTestId("account-dot").map((dot) => dot.dataset.accountId)).toEqual([
      "account-a",
      "account-b",
    ]);
    expect(screen.queryByText("Terminal x4")).not.toBeInTheDocument();
  });

  it("does not claim a terminal exists when a Workspace contains only viewer and conversation panes", () => {
    mocks.workspaceState.workspaces[0].panes = [
      {
        id: "file",
        kind: "file",
        agentId: "terminal",
        filePath: "/app/README.md",
        sessionId: null,
      },
      {
        id: "chat",
        kind: "conversation",
        agentId: "terminal",
        conversationId: "conversation",
        sessionId: null,
      },
    ];

    render(<WorkspaceView />);

    expect(screen.getByText("File viewer")).toBeInTheDocument();
    expect(screen.getByText("Saved conversation")).toBeInTheDocument();
    expect(screen.queryByText(/^Terminal(?: x\d+)?$/)).not.toBeInTheDocument();
  });
});
