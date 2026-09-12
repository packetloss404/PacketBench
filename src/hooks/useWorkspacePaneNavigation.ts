import { useEffect } from "react";
import { useAppStore } from "@/stores/appStore";
import { useLayoutStore } from "@/stores/layoutStore";
import { useWorkspaceStore } from "@/stores/workspaceStore";
import { isModalOpen } from "@/lib/modalStack";
import type { MosaicNode } from "@/types/mosaic";
import type { Workspace } from "@/types/workspace";

function visibleLeafOrder(tree: MosaicNode<string>): string[] {
  if (typeof tree === "string") return [tree];
  if ("children" in tree) return tree.children.flatMap(visibleLeafOrder);
  const active = tree.tabs[tree.activeTabIndex ?? 0];
  return active ? [active] : [];
}

/** Ctrl+Alt+PageUp/PageDown moves terminal focus in the visible mosaic's order.
 * Capture only these explicit app chords, before xterm translates them to PTY
 * input. Ordinary shell shortcuts and text/editor controls retain their keys. */
export function useWorkspacePaneNavigation({
  workspace,
  tree,
  surfaceActive,
}: {
  workspace: Workspace;
  tree: MosaicNode<string> | null;
  surfaceActive: boolean;
}) {
  useEffect(() => {
    if (!surfaceActive || !tree) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (!event.ctrlKey || !event.altKey || event.shiftKey || event.metaKey) return;
      if (event.key !== "PageUp" && event.key !== "PageDown") return;
      if (event.defaultPrevented || event.isComposing || isModalOpen()) return;
      const app = useAppStore.getState();
      const state = useWorkspaceStore.getState();
      if (
        app.activeView !== "workspace" ||
        app.commandPaletteOpen ||
        state.activeWorkspaceId !== workspace.id
      )
        return;
      const target = event.target instanceof Element ? event.target : null;
      if (
        target?.closest(
          'input, textarea, select, [contenteditable]:not([contenteditable="false"])',
        ) &&
        !target.closest(".xterm")
      )
        return;
      const terminalIds = new Set(
        workspace.panes.filter((p) => !p.kind || p.kind === "terminal").map((p) => p.id),
      );
      const order = visibleLeafOrder(tree).filter((id) => terminalIds.has(id));
      if (!order.length) return;
      const index = order.indexOf(useLayoutStore.getState().activePaneId);
      const direction = event.key === "PageDown" ? 1 : -1;
      const next =
        index < 0
          ? direction > 0
            ? 0
            : order.length - 1
          : (index + direction + order.length) % order.length;
      event.preventDefault();
      event.stopPropagation();
      if (state.zoomedPaneId && workspace.panes.some((p) => p.id === state.zoomedPaneId))
        state.setZoomedPane(order[next]);
      state.requestPaneFocus(workspace.id, order[next]);
    };
    window.addEventListener("keydown", handleKeyDown, true);
    return () => window.removeEventListener("keydown", handleKeyDown, true);
  }, [workspace, tree, surfaceActive]);
}
