import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("@/lib/tauri", () => ({
  saveWorkspacesSlice: vi.fn().mockResolvedValue(undefined),
}));

import { useWorkspaceStore, normalizePanes } from "@/stores/workspaceStore";
import { useServerStore } from "@/stores/serverStore";
import { useLayoutStore } from "@/stores/layoutStore";
import type { Workspace, WorkspacePane } from "@/types/workspace";

describe("workspaceStore.createWorkspace", () => {
  beforeEach(() => {
    // Reset workspaceStore between tests.
    useWorkspaceStore.setState({
      workspaces: [],
      activeWorkspaceId: null,
      zoomedPaneId: null,
    });
    // Reset relevant slices that createWorkspace touches.
    useServerStore.setState({
      servers: [],
      activeServerId: null,
      connectionStates: {},
      knownHostsPath: null,
    });
    useLayoutStore.setState({ projectPath: "" });
  });

  it("creates a local workspace with no server metadata", () => {
    const id = useWorkspaceStore
      .getState()
      .createWorkspace("Local WS", ["claude-code"], "C:\\projects\\demo", {
        prompt: "Hi",
      });

    const ws = useWorkspaceStore.getState().workspaces.find((w) => w.id === id);
    expect(ws).toBeDefined();
    expect(ws!.serverId).toBeUndefined();
    expect(ws!.remoteProjectPath).toBeUndefined();
    expect(ws!.projectPath).toBe("C:\\projects\\demo");
    expect(ws!.panes).toHaveLength(1);
    expect(ws!.panes[0].agentId).toBe("claude-code");
    expect(ws!.prompt).toBe("Hi");
  });

  it("creates a remote workspace when serverId + remoteProjectPath are provided", () => {
    useServerStore.setState({
      servers: [
        {
          id: "srv-1",
          name: "Demo",
          host: "example.com",
          port: 22,
          username: "ian",
          authMethod: "agent",
          remotePath: "/srv/app",
          installedAgents: ["claude-code"],
          hostFingerprint: "SHA256:dummy",
        },
      ],
    });

    const id = useWorkspaceStore
      .getState()
      .createWorkspace("Remote WS", ["claude-code"], "ignored-local", {
        serverId: "srv-1",
        remoteProjectPath: "/srv/app",
      });

    const ws = useWorkspaceStore.getState().workspaces.find((w) => w.id === id);
    expect(ws).toBeDefined();
    expect(ws!.serverId).toBe("srv-1");
    expect(ws!.remoteProjectPath).toBe("/srv/app");
    // For remote workspaces the stored projectPath is the remote path so
    // legacy code reading `workspace.projectPath` still gets a label.
    expect(ws!.projectPath).toBe("/srv/app");
  });

  it("throws if serverId refers to an unknown server", () => {
    expect(() =>
      useWorkspaceStore.getState().createWorkspace("Bad WS", ["claude-code"], "/srv/app", {
        serverId: "srv-missing",
        remoteProjectPath: "/srv/app",
      }),
    ).toThrow(/does not match any registered server/i);

    expect(useWorkspaceStore.getState().workspaces).toHaveLength(0);
  });

  it("throws if serverId is provided without remoteProjectPath", () => {
    useServerStore.setState({
      servers: [
        {
          id: "srv-1",
          name: "Demo",
          host: "example.com",
          port: 22,
          username: "ian",
          authMethod: "agent",
          remotePath: "/srv/app",
          installedAgents: [],
          hostFingerprint: "SHA256:dummy",
        },
      ],
    });

    expect(() =>
      useWorkspaceStore
        .getState()
        .createWorkspace("Missing path", ["claude-code"], "ignored-local", {
          serverId: "srv-1",
        }),
    ).toThrow(/remoteProjectPath is required/i);
  });

  it("refuses to persist a local workspace with an empty project path", () => {
    // The empty-path rule used to live only in WorkspaceCreationModal, so the
    // instant paths (Ctrl+N, Fleet sidebar) could bypass it. It is a store
    // invariant now — no caller can create the broken workspace.
    expect(() => useWorkspaceStore.getState().createWorkspace("Path-less", [], "")).toThrow(
      /non-empty projectPath/i,
    );
    expect(() => useWorkspaceStore.getState().createWorkspace("Path-less", [], "   ")).toThrow(
      /non-empty projectPath/i,
    );
    expect(useWorkspaceStore.getState().workspaces).toHaveLength(0);
  });

  it("still allows a remote workspace whose local path is empty", () => {
    useServerStore.setState({
      servers: [
        {
          id: "srv-1",
          name: "Demo",
          host: "example.com",
          port: 22,
          username: "ian",
          authMethod: "agent",
          remotePath: "/srv/app",
          installedAgents: [],
          hostFingerprint: "SHA256:dummy",
        },
      ],
    });

    const id = useWorkspaceStore.getState().createWorkspace("Remote WS", ["claude-code"], "", {
      serverId: "srv-1",
      remoteProjectPath: "/srv/app",
    });

    expect(useWorkspaceStore.getState().workspaces.find((w) => w.id === id)?.projectPath).toBe(
      "/srv/app",
    );
  });

  it("does not push the remote workspace path into layoutStore.projectPath", () => {
    useServerStore.setState({
      servers: [
        {
          id: "srv-1",
          name: "Demo",
          host: "example.com",
          port: 22,
          username: "ian",
          authMethod: "agent",
          remotePath: "/srv/app",
          installedAgents: [],
          hostFingerprint: "SHA256:dummy",
        },
      ],
    });
    useLayoutStore.setState({ projectPath: "C:\\original\\local" });

    const id = useWorkspaceStore
      .getState()
      .createWorkspace("Remote WS", ["claude-code"], "ignored-local", {
        serverId: "srv-1",
        remoteProjectPath: "/srv/app",
      });

    useWorkspaceStore.getState().setActiveWorkspace(id);

    // layoutStore.projectPath should be untouched — local-only state must
    // not be hijacked by a remote workspace.
    expect(useLayoutStore.getState().projectPath).toBe("C:\\original\\local");
  });

  it("syncs layoutStore.projectPath when activating a local workspace", () => {
    useLayoutStore.setState({ projectPath: "C:\\old" });

    const id = useWorkspaceStore
      .getState()
      .createWorkspace("Local WS", ["claude-code"], "C:\\new\\proj");

    useWorkspaceStore.getState().setActiveWorkspace(id);

    expect(useLayoutStore.getState().projectPath).toBe("C:\\new\\proj");
  });

});

// Tile program (P1-S1): pane schema normalization + kind-keyed store sites.
function makeWorkspace(panes: WorkspacePane[], agents: Workspace["agents"] = []): Workspace {
  return {
    id: "ws-1",
    name: "WS",
    agents,
    panes,
    projectPath: "/repo",
    createdAt: 1,
    updatedAt: 2,
    status: "active",
  };
}

describe("normalizePanes (P1-S1)", () => {
  it("defaults a pane with no kind to terminal", () => {
    const [ws] = normalizePanes([makeWorkspace([{ id: "p1", agentId: "codex", sessionId: null }])]);
    expect(ws.panes[0].kind).toBe("terminal");
    expect(ws.panes[0]).not.toHaveProperty("conversationId");
  });

  it("clears persisted PTY session ids because backend processes do not survive hydration", () => {
    const [ws] = normalizePanes([
      makeWorkspace([{ id: "p1", agentId: "codex", sessionId: "stale-session" }]),
    ]);

    expect(ws.panes[0].sessionId).toBeNull();
  });

  it("keeps a conversation pane with a conversationId", () => {
    const [ws] = normalizePanes([
      makeWorkspace([
        {
          id: "p1",
          agentId: "terminal",
          sessionId: null,
          kind: "conversation",
          conversationId: "conv-1",
        },
      ]),
    ]);
    expect(ws.panes[0].kind).toBe("conversation");
    expect(ws.panes[0].conversationId).toBe("conv-1");
  });

  it("self-heals a conversation pane missing its conversationId to a terminal", () => {
    // The inert-carrier arm: a stripped conversationId downgrades to terminal
    // (the sweep half of self-heal lands in P1-S2).
    const [ws] = normalizePanes([
      makeWorkspace([{ id: "p1", agentId: "terminal", sessionId: null, kind: "conversation" }]),
    ]);
    expect(ws.panes[0].kind).toBe("terminal");
    expect(ws.panes[0]).not.toHaveProperty("conversationId");
  });

  it("drops a stray conversationId from a terminal pane", () => {
    const [ws] = normalizePanes([
      makeWorkspace([
        { id: "p1", agentId: "codex", sessionId: null, conversationId: "conv-x" } as WorkspacePane,
      ]),
    ]);
    expect(ws.panes[0].kind).toBe("terminal");
    expect(ws.panes[0]).not.toHaveProperty("conversationId");
  });

  it("drops malformed panes (not an object / missing string id) and preserves unknown fields", () => {
    const [ws] = normalizePanes([
      makeWorkspace([
        null as unknown as WorkspacePane,
        { agentId: "codex", sessionId: null } as unknown as WorkspacePane, // no id
        {
          id: "p3",
          agentId: "codex",
          sessionId: null,
          futureField: 42,
        } as unknown as WorkspacePane,
      ]),
    ]);
    expect(ws.panes).toHaveLength(1);
    expect(ws.panes[0].id).toBe("p3");
    expect((ws.panes[0] as unknown as { futureField?: number }).futureField).toBe(42);
  });
});

describe("workspaceStore kind-keyed sites (P1-S1)", () => {
  beforeEach(() => {
    useWorkspaceStore.setState({ workspaces: [], activeWorkspaceId: null, zoomedPaneId: null });
  });

  it("removePane on a conversation pane leaves agents[] untouched", () => {
    useWorkspaceStore.setState({
      workspaces: [
        makeWorkspace(
          [
            { id: "p-term", agentId: "codex", sessionId: null, kind: "terminal" },
            {
              id: "p-conv",
              agentId: "terminal",
              sessionId: null,
              kind: "conversation",
              conversationId: "conv-1",
            },
          ],
          ["codex"],
        ),
      ],
    });

    useWorkspaceStore.getState().removePane("ws-1", "p-conv");

    const ws = useWorkspaceStore.getState().workspaces[0];
    // The conversation pane was never in agents[]; removing it must not splice
    // the real "codex" terminal out.
    expect(ws.agents).toEqual(["codex"]);
    expect(ws.panes.map((p) => p.id)).toEqual(["p-term"]);
  });

  it("removePane on a terminal pane still removes it from agents[]", () => {
    useWorkspaceStore.setState({
      workspaces: [
        makeWorkspace(
          [{ id: "p-term", agentId: "codex", sessionId: null, kind: "terminal" }],
          ["codex"],
        ),
      ],
    });

    useWorkspaceStore.getState().removePane("ws-1", "p-term");

    const ws = useWorkspaceStore.getState().workspaces[0];
    expect(ws.agents).toEqual([]);
    expect(ws.panes).toHaveLength(0);
  });
});

describe("workspace terminal shell overrides", () => {
  beforeEach(() => {
    useWorkspaceStore.setState({ workspaces: [], activeWorkspaceId: null, zoomedPaneId: null });
  });

  it("persists and clears a workspace-level override", () => {
    useWorkspaceStore.setState({ workspaces: [makeWorkspace([])] });

    useWorkspaceStore.getState().setTerminalShellOverride("ws-1", {
      profile: "wsl",
      executable: "wsl.exe",
      wslDistro: "Ubuntu",
    });
    expect(useWorkspaceStore.getState().workspaces[0].terminalShell).toMatchObject({
      profile: "wsl",
      wslDistro: "Ubuntu",
    });

    useWorkspaceStore.getState().setTerminalShellOverride("ws-1", undefined);
    expect(useWorkspaceStore.getState().workspaces[0].terminalShell).toBeUndefined();
  });

  it("stores a per-pane override only for raw Terminal panes", () => {
    useWorkspaceStore.setState({ workspaces: [makeWorkspace([])] });
    const shell = { profile: "command-prompt" as const, executable: "cmd.exe" };

    const terminalPaneId = useWorkspaceStore
      .getState()
      .addPane("ws-1", "terminal", { terminalShell: shell });
    const codexPaneId = useWorkspaceStore
      .getState()
      .addPane("ws-1", "codex", { terminalShell: shell });
    const workspace = useWorkspaceStore.getState().workspaces[0];

    expect(workspace.panes.find((pane) => pane.id === terminalPaneId)?.terminalShell).toEqual(
      shell,
    );
    expect(workspace.panes.find((pane) => pane.id === codexPaneId)?.terminalShell).toBeUndefined();
  });
});


describe("Workspace Custom CLI snapshots", () => {
  const config = { name: "My agent", command: "my-agent", args: ["two words"], env: { MODE: "dev" }, workingDirectory: "/work/other" };
  beforeEach(() => useWorkspaceStore.setState({ workspaces: [], activeWorkspaceId: null }));

  it("requires configuration at the store boundary", () => {
    expect(() => useWorkspaceStore.getState().createWorkspace("Test", ["custom-cli"], "/repo")).toThrow(/Custom CLI/);
    expect(() => useWorkspaceStore.getState().addPane("missing", "custom-cli")).toThrow(/Custom CLI/);
  });

  it("copies a profile into created and added panes, and preserves it on hydration", () => {
    const profile = structuredClone(config);
    const id = useWorkspaceStore.getState().createWorkspace("Test", ["custom-cli", "gemini"], "/repo", { customCli: profile });
    useWorkspaceStore.getState().addPane(id, "custom-cli", { customCli: profile });
    profile.args.push("changed"); profile.env.MODE = "changed";
    const workspace = useWorkspaceStore.getState().workspaces[0];
    const hydrated = normalizePanes([workspace])[0];
    expect(hydrated.panes[0].customCli).toEqual(config);
    expect(hydrated.panes[2].customCli).toEqual(config);
    expect(hydrated.panes[1].agentId).toBe("gemini");
  });

  it("degrades a malformed saved Custom CLI to an ordinary terminal", () => {
    const id = useWorkspaceStore.getState().createWorkspace("Test", ["custom-cli"], "/repo", { customCli: config });
    const workspace = useWorkspaceStore.getState().workspaces.find((w) => w.id === id)!;
    const hydrated = normalizePanes([{ ...workspace, panes: [{ ...workspace.panes[0], customCli: undefined }] }])[0];
    expect(hydrated.panes[0].agentId).toBe("terminal");
  });
});
