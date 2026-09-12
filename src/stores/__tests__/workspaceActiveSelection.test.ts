import { beforeEach, describe, expect, it, vi } from "vitest";

// workspaceStore persists through `@/lib/tauri`, which invokes Tauri commands.
// Stub the transport and keep the store real — what is under test is the
// localStorage round-trip, not the backend save.
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn().mockResolvedValue(undefined),
}));

import { useWorkspaceStore } from "@/stores/workspaceStore";
import { useLayoutStore } from "@/stores/layoutStore";
import { storageKey } from "@/lib/brand";
import type { Workspace } from "@/types/workspace";

const ACTIVE_KEY = storageKey("workspace-active-id");

function workspace(id: string, status: Workspace["status"] = "active"): Workspace {
  return {
    id,
    name: id,
    projectPath: `D:\\projects\\${id}`,
    panes: [
      { id: `${id}-a`, agentId: "terminal", sessionId: null },
      { id: `${id}-b`, agentId: "codex", sessionId: null },
    ],
    agents: ["terminal", "codex"],
    status,
    createdAt: 1,
    updatedAt: 1,
  };
}

describe("workspace selection survives a restart", () => {
  beforeEach(() => {
    localStorage.clear();
    useWorkspaceStore.setState({ workspaces: [], activeWorkspaceId: null, zoomedPaneId: null });
    useWorkspaceStore.getState().hydrateFromBackend([]);
    useLayoutStore.setState({ activePaneId: "" });
  });

  it("writes the selected workspace id to localStorage", () => {
    useWorkspaceStore.setState({ workspaces: [workspace("ws-1"), workspace("ws-2")] });
    useWorkspaceStore.getState().setActiveWorkspace("ws-2");

    expect(useWorkspaceStore.getState().activeWorkspaceId).toBe("ws-2");
    expect(localStorage.getItem(ACTIVE_KEY)).toBe("ws-2");
  });

  it("clears the stored id when the selection is cleared", () => {
    useWorkspaceStore.setState({ workspaces: [workspace("ws-1")] });
    useWorkspaceStore.getState().setActiveWorkspace("ws-1");
    expect(localStorage.getItem(ACTIVE_KEY)).toBe("ws-1");

    useWorkspaceStore.getState().setActiveWorkspace(null);
    expect(localStorage.getItem(ACTIVE_KEY)).toBeNull();
  });

  it("drops a stored id whose workspace no longer exists", async () => {
    // A workspace deleted since the last run must not point the view at a
    // ghost — the restore validates against the hydrated list rather than
    // trusting the stored id.
    localStorage.setItem(ACTIVE_KEY, "ws-gone");
    const { readActiveWorkspaceIdForTest } = await import("@/stores/workspaceStore");
    expect(readActiveWorkspaceIdForTest([workspace("ws-1")])).toBeNull();
  });

  it("drops a stored id whose workspace has been archived", async () => {
    localStorage.setItem(ACTIVE_KEY, "ws-old");
    const { readActiveWorkspaceIdForTest } = await import("@/stores/workspaceStore");
    expect(readActiveWorkspaceIdForTest([workspace("ws-old", "archived")])).toBeNull();
  });

  it("restores a stored id that still resolves to a live workspace", async () => {
    localStorage.setItem(ACTIVE_KEY, "ws-2");
    const { readActiveWorkspaceIdForTest } = await import("@/stores/workspaceStore");
    expect(readActiveWorkspaceIdForTest([workspace("ws-1"), workspace("ws-2")])).toBe("ws-2");
  });

  it("clears the stored id when the active workspace is deleted", () => {
    useWorkspaceStore.setState({ workspaces: [workspace("ws-1")] });
    useWorkspaceStore.getState().setActiveWorkspace("ws-1");

    useWorkspaceStore.getState().deleteWorkspace("ws-1");

    expect(useWorkspaceStore.getState().activeWorkspaceId).toBeNull();
    expect(localStorage.getItem(ACTIVE_KEY)).toBeNull();
  });

  it("restores selection from the backend when the local workspace cache is missing", () => {
    localStorage.setItem(ACTIVE_KEY, "ws-backend-only");
    useWorkspaceStore.getState().hydrateFromBackend([workspace("ws-backend-only")]);

    expect(useWorkspaceStore.getState().activeWorkspaceId).toBe("ws-backend-only");
    expect(localStorage.getItem(ACTIVE_KEY)).toBe("ws-backend-only");
  });

  it.each(["deleted", "archived"])(
    "drops a cached selection that the backend says is %s",
    (status) => {
      useWorkspaceStore.setState({
        workspaces: [workspace("ws-stale")],
        activeWorkspaceId: "ws-stale",
      });
      localStorage.setItem(ACTIVE_KEY, "ws-stale");

      useWorkspaceStore
        .getState()
        .hydrateFromBackend(status === "deleted" ? [] : [workspace("ws-stale", "archived")]);

      expect(useWorkspaceStore.getState().activeWorkspaceId).toBeNull();
      expect(localStorage.getItem(ACTIVE_KEY)).toBeNull();
    },
  );

  it("restores pane configuration and geometry while discarding dead process ids", () => {
    const saved = workspace("ws-restore");
    saved.panes[0] = {
      ...saved.panes[0],
      accountId: "work-account",
      sessionId: "dead-pty",
      pinnedCommands: ["git status"],
    };
    saved.terminalShell = { profile: "powershell7" };
    saved.layout = {
      type: "split",
      direction: "column",
      children: ["ws-restore-b", "ws-restore-a"],
      splitPercentages: [37, 63],
    };
    localStorage.setItem(ACTIVE_KEY, saved.id);
    useWorkspaceStore.getState().hydrateFromBackend([saved]);

    const restored = useWorkspaceStore.getState().getActiveWorkspace();
    expect(restored?.layout).toEqual(saved.layout);
    expect(restored?.terminalShell).toEqual(saved.terminalShell);
    expect(restored?.panes[0]).toMatchObject({
      accountId: "work-account",
      sessionId: null,
      pinnedCommands: ["git status"],
    });
  });

  it.each(["archiveWorkspace", "deleteWorkspace"] as const)(
    "%s clears owned zoom but preserves another workspace's zoom",
    (action) => {
      useWorkspaceStore.setState({
        workspaces: [workspace("ws-1"), workspace("ws-2")],
        zoomedPaneId: "ws-2-b",
      });
      useWorkspaceStore.getState()[action]("ws-1");
      expect(useWorkspaceStore.getState().zoomedPaneId).toBe("ws-2-b");
      useWorkspaceStore.getState()[action]("ws-2");
      expect(useWorkspaceStore.getState().zoomedPaneId).toBeNull();
    },
  );

  it("returns keyboard focus to the last selected pane of each workspace", () => {
    useWorkspaceStore.setState({ workspaces: [workspace("ws-1"), workspace("ws-2")] });
    useWorkspaceStore.getState().setActiveWorkspace("ws-1");
    expect(useLayoutStore.getState().activePaneId).toBe("ws-1-a");
    useLayoutStore.getState().setActivePaneId("ws-1-b");
    useWorkspaceStore.getState().setActiveWorkspace("ws-2");
    expect(useLayoutStore.getState().activePaneId).toBe("ws-2-a");
    useWorkspaceStore.getState().setActiveWorkspace("ws-1");
    expect(useLayoutStore.getState().activePaneId).toBe("ws-1-b");
  });

  it("falls back to a surviving pane when the remembered pane was closed", () => {
    useWorkspaceStore.setState({ workspaces: [workspace("ws-1"), workspace("ws-2")] });
    useWorkspaceStore.getState().setActiveWorkspace("ws-1");
    useLayoutStore.getState().setActivePaneId("ws-1-b");
    useWorkspaceStore.getState().setActiveWorkspace("ws-2");
    useWorkspaceStore.getState().removePane("ws-1", "ws-1-b");
    useWorkspaceStore.getState().setActiveWorkspace("ws-1");
    expect(useLayoutStore.getState().activePaneId).toBe("ws-1-a");
  });

  it("focuses the visible zoomed pane on return without discarding the zoom", () => {
    useWorkspaceStore.setState({ workspaces: [workspace("ws-1"), workspace("ws-2")] });
    useWorkspaceStore.getState().setActiveWorkspace("ws-1");
    useWorkspaceStore.getState().setZoomedPane("ws-1-b");
    useWorkspaceStore.getState().setActiveWorkspace("ws-2");
    useWorkspaceStore.getState().setActiveWorkspace("ws-1");
    expect(useLayoutStore.getState().activePaneId).toBe("ws-1-b");
    expect(useWorkspaceStore.getState().zoomedPaneId).toBe("ws-1-b");
  });

  it("hands focus from a closed file viewer to the adjacent visible terminal", () => {
    const mixed = workspace("mixed");
    mixed.panes.unshift({
      id: "file",
      agentId: "terminal",
      kind: "file",
      filePath: "D:/README.md",
      sessionId: null,
    });
    mixed.layout = { type: "split", direction: "row", children: ["mixed-b", "file", "mixed-a"] };
    useWorkspaceStore.setState({ workspaces: [mixed, workspace("other")] });
    useWorkspaceStore.getState().requestPaneFocus("mixed", "file");
    useWorkspaceStore.getState().setZoomedPane("file");
    useWorkspaceStore.getState().removePane("mixed", "file");
    expect(useLayoutStore.getState().activePaneId).toBe("mixed-a");
    expect(useWorkspaceStore.getState().zoomedPaneId).toBeNull();
    expect(useWorkspaceStore.getState().focusPaneRequest).toBeNull();
    useWorkspaceStore.getState().setActiveWorkspace("other");
    useWorkspaceStore.getState().setActiveWorkspace("mixed");
    expect(useLayoutStore.getState().activePaneId).toBe("mixed-a");
  });

  it("does not steal active focus when closing a background workspace's remembered pane", () => {
    useWorkspaceStore.setState({ workspaces: [workspace("ws-1"), workspace("ws-2")] });
    useWorkspaceStore.getState().setActiveWorkspace("ws-1");
    useLayoutStore.getState().setActivePaneId("ws-1-b");
    useWorkspaceStore.getState().setActiveWorkspace("ws-2");
    useLayoutStore.getState().setActivePaneId("ws-2-b");
    useWorkspaceStore.getState().removePane("ws-1", "ws-1-b");
    expect(useLayoutStore.getState().activePaneId).toBe("ws-2-b");
    useWorkspaceStore.getState().setActiveWorkspace("ws-1");
    expect(useLayoutStore.getState().activePaneId).toBe("ws-1-a");
  });

  it("clears focus when the selected workspace's last pane closes", () => {
    const single = workspace("single");
    single.panes = single.panes.slice(0, 1);
    useWorkspaceStore.setState({ workspaces: [single] });
    useWorkspaceStore.getState().setActiveWorkspace("single");
    useWorkspaceStore.getState().removePane("single", "single-a");
    expect(useLayoutStore.getState().activePaneId).toBe("");
    expect(useWorkspaceStore.getState().activeWorkspaceId).toBe("single");
  });
});
