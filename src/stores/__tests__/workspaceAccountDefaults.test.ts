import { beforeEach, describe, expect, it, vi } from "vitest";

// Both workspaceStore and cliAccountStore persist through `@/lib/tauri`, which
// invokes Tauri commands. Stub the transport, keep both stores real — the whole
// point of this file is the seam BETWEEN them.
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn().mockResolvedValue(undefined),
}));

import { useWorkspaceStore, normalizePanes } from "@/stores/workspaceStore";
import type { Workspace } from "@/types/workspace";
import { useCliAccountStore } from "@/stores/cliAccountStore";
import { useServerStore } from "@/stores/serverStore";
import { useLayoutStore } from "@/stores/layoutStore";

const PROJECT = "C:\\projects\\client-app";
const OTHER_PROJECT = "C:\\projects\\oss-lib";

function addAccount(label: string, cli: "claude-code" | "codex") {
  return useCliAccountStore.getState().addAccount({
    label,
    cli,
    configDir: `C:\\cfg\\${label}`,
  });
}

describe("multi-account: session-creation account resolution", () => {
  beforeEach(() => {
    useWorkspaceStore.setState({
      workspaces: [],
      activeWorkspaceId: null,
      zoomedPaneId: null,
    });
    useCliAccountStore.setState({ accounts: [], stickyDefaults: {} });
    useServerStore.setState({
      servers: [],
      activeServerId: null,
      connectionStates: {},
      knownHostsPath: null,
    });
    useLayoutStore.setState({ projectPath: "" });
  });

  it("leaves panes ambient when no account is configured (unchanged behaviour)", () => {
    const id = useWorkspaceStore
      .getState()
      .createWorkspace("WS", ["claude-code", "terminal"], PROJECT);

    const ws = useWorkspaceStore.getState().workspaces.find((w) => w.id === id)!;
    expect(ws.panes).toHaveLength(2);
    // Not merely undefined — the key must be absent so the persisted pane stays
    // byte-identical to the pre-multi-account shape.
    expect(ws.panes[0]).not.toHaveProperty("accountId");
    expect(ws.panes[1]).not.toHaveProperty("accountId");
  });

  it("applies an explicit choice and remembers it as the project's sticky default", () => {
    const client = addAccount("Client work", "claude-code");

    const id = useWorkspaceStore
      .getState()
      .createWorkspace("WS", ["claude-code"], PROJECT, {
        accountIds: { "claude-code": client.id },
      });

    const ws = useWorkspaceStore.getState().workspaces.find((w) => w.id === id)!;
    expect(ws.panes[0].accountId).toBe(client.id);
    expect(useCliAccountStore.getState().defaultFor(PROJECT, "claude-code")).toBe(client.id);
  });

  it("a programmatic createWorkspace (no modal, no explicit choice) picks up the sticky default", () => {
    const client = addAccount("Client work", "claude-code");
    useCliAccountStore.getState().rememberDefault(PROJECT, "claude-code", client.id);

    // Programmatic creation can omit sessionConfig.accountIds entirely.
    const id = useWorkspaceStore
      .getState()
      .createWorkspace("Auto WS", ["claude-code"], PROJECT);

    const ws = useWorkspaceStore.getState().workspaces.find((w) => w.id === id)!;
    expect(ws.panes[0].accountId).toBe(client.id);
  });

  it("keys the sticky default per project path", () => {
    const client = addAccount("Client work", "claude-code");
    useCliAccountStore.getState().rememberDefault(PROJECT, "claude-code", client.id);

    const id = useWorkspaceStore
      .getState()
      .createWorkspace("Other WS", ["claude-code"], OTHER_PROJECT);

    const ws = useWorkspaceStore.getState().workspaces.find((w) => w.id === id)!;
    expect(ws.panes[0]).not.toHaveProperty("accountId");
  });

  it("never resolves a codex default onto a claude-code pane", () => {
    const codexAccount = addAccount("Codex personal", "codex");
    // Force a cross-CLI sticky entry the way a reused id could produce.
    useCliAccountStore.setState({
      stickyDefaults: { [PROJECT]: { "claude-code": codexAccount.id } },
    });

    const id = useWorkspaceStore
      .getState()
      .createWorkspace("WS", ["claude-code"], PROJECT);

    const ws = useWorkspaceStore.getState().workspaces.find((w) => w.id === id)!;
    expect(ws.panes[0]).not.toHaveProperty("accountId");
  });

  it("drops a sticky default that names a deleted account rather than launching it", () => {
    const client = addAccount("Client work", "claude-code");
    useCliAccountStore.getState().rememberDefault(PROJECT, "claude-code", client.id);
    useCliAccountStore.getState().deleteAccount(client.id);

    const id = useWorkspaceStore
      .getState()
      .createWorkspace("WS", ["claude-code"], PROJECT);

    const ws = useWorkspaceStore.getState().workspaces.find((w) => w.id === id)!;
    expect(ws.panes[0]).not.toHaveProperty("accountId");
  });

  it("an explicit null is an ambient launch that clears the remembered default", () => {
    const client = addAccount("Client work", "claude-code");
    useCliAccountStore.getState().rememberDefault(PROJECT, "claude-code", client.id);

    const id = useWorkspaceStore
      .getState()
      .createWorkspace("WS", ["claude-code"], PROJECT, {
        accountIds: { "claude-code": null },
      });

    const ws = useWorkspaceStore.getState().workspaces.find((w) => w.id === id)!;
    expect(ws.panes[0]).not.toHaveProperty("accountId");
    expect(useCliAccountStore.getState().defaultFor(PROJECT, "claude-code")).toBeNull();
  });

  it("addPane resolves the sticky default when the caller expresses no opinion", () => {
    const client = addAccount("Client work", "codex");
    useCliAccountStore.getState().rememberDefault(PROJECT, "codex", client.id);

    const wsId = useWorkspaceStore
      .getState()
      .createWorkspace("WS", ["terminal"], PROJECT);
    const paneId = useWorkspaceStore.getState().addPane(wsId, "codex");

    const ws = useWorkspaceStore.getState().workspaces.find((w) => w.id === wsId)!;
    const pane = ws.panes.find((p) => p.id === paneId)!;
    expect(pane.accountId).toBe(client.id);
  });

  it("addPane honours an explicit choice and writes it back as the sticky default", () => {
    const a = addAccount("Personal", "codex");
    const b = addAccount("Client", "codex");
    useCliAccountStore.getState().rememberDefault(PROJECT, "codex", a.id);

    const wsId = useWorkspaceStore
      .getState()
      .createWorkspace("WS", ["terminal"], PROJECT);
    const paneId = useWorkspaceStore.getState().addPane(wsId, "codex", { accountId: b.id });

    const ws = useWorkspaceStore.getState().workspaces.find((w) => w.id === wsId)!;
    expect(ws.panes.find((p) => p.id === paneId)!.accountId).toBe(b.id);
    expect(useCliAccountStore.getState().defaultFor(PROJECT, "codex")).toBe(b.id);
  });

  it("normalizePanes keeps a valid accountId and drops a malformed one", () => {
    const [normalized] = normalizePanes([
      {
        id: "ws",
        name: "WS",
        agents: ["claude-code", "codex"],
        panes: [
          { id: "p1", agentId: "claude-code", sessionId: null, accountId: "acct-1" },
          // An untrusted cache could hold anything here; a non-string must
          // degrade to ambient rather than reach the runtime as a config dir.
          { id: "p2", agentId: "codex", sessionId: null, accountId: 42 },
          { id: "p3", agentId: "codex", sessionId: null, accountId: "  " },
        ],
        projectPath: PROJECT,
        createdAt: 1,
        updatedAt: 1,
        status: "active",
      } as unknown as Workspace,
    ]);

    expect(normalized.panes[0].accountId).toBe("acct-1");
    expect(normalized.panes[1]).not.toHaveProperty("accountId");
    expect(normalized.panes[2]).not.toHaveProperty("accountId");
  });

  it("never binds an account to a non-account-aware slot", () => {
    const client = addAccount("Client work", "claude-code");
    useCliAccountStore.getState().rememberDefault(PROJECT, "claude-code", client.id);

    const wsId = useWorkspaceStore
      .getState()
      .createWorkspace("WS", ["terminal", "packetcode", "opencode"], PROJECT);

    const ws = useWorkspaceStore.getState().workspaces.find((w) => w.id === wsId)!;
    for (const pane of ws.panes) {
      expect(pane).not.toHaveProperty("accountId");
    }
  });
});
