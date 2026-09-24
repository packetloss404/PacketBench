import { useEffect, type RefObject } from "react";
import type { Terminal } from "@xterm/xterm";
import { useLayoutStore } from "@/stores/layoutStore";

import { useAppStore } from "@/stores/appStore";
import { useWorkspaceStore } from "@/stores/workspaceStore";
import { isModalOpen } from "@/lib/modalStack";

interface UseApprovalShortcutsOptions {
  showApproval: boolean;
  /** Identifies this pane, so a keypress can be attributed to one prompt. */
  paneId: string;
  workspaceId?: string;
  containerRef?: RefObject<HTMLElement | null>;
  xtermRef: RefObject<Terminal | null>;
  onApprove: () => void;
  onDeny: () => void;
  onAbort: () => void;
  /** Owning pane can restore focus with visibility/selection/dialog guards. */
  onRestoreFocus?: () => void;
}

/** Bare approval keys belong only to the selected, visible terminal. */
export function useApprovalShortcuts({
  showApproval,
  paneId,
  workspaceId,
  containerRef,
  xtermRef,
  onApprove,
  onDeny,
  onAbort,
  onRestoreFocus,
}: UseApprovalShortcutsOptions) {
  useEffect(() => {
    if (!showApproval) return;
    const term = xtermRef.current;
    if (term) term.blur();

    const handler = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.isComposing || e.ctrlKey || e.altKey || e.metaKey || e.shiftKey)
        return;
      const app = useAppStore.getState();
      if (app.activeView !== "workspace" || app.commandPaletteOpen || isModalOpen()) return;
      if (useLayoutStore.getState().activePaneId !== paneId) return;
      if (workspaceId && useWorkspaceStore.getState().activeWorkspaceId !== workspaceId) return;
      const container = containerRef?.current;
      if (
        containerRef &&
        (!container ||
          !container.isConnected ||
          container.getClientRects().length === 0 ||
          getComputedStyle(container).visibility === "hidden")
      )
        return;
      const target = e.target instanceof Element ? e.target : null;
      if (
        target?.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"])')
      )
        return;
      const terminalRoot = container?.closest("[data-terminal-pane]");
      if (
        target?.closest('button, a, [role="button"], [role="menuitem"]') &&
        !terminalRoot?.contains(target)
      )
        return;

      if (e.key === "y" || e.key === "Y") {
        e.preventDefault();
        onApprove();
      } else if (e.key === "n" || e.key === "N") {
        e.preventDefault();
        onDeny();
      } else if (e.key === "Escape") {
        e.preventDefault();
        onAbort();
      }
    };

    window.addEventListener("keydown", handler);
    return () => {
      window.removeEventListener("keydown", handler);
      if (onRestoreFocus) onRestoreFocus();
      else if (term) term.focus();
    };
  }, [
    showApproval,
    paneId,
    workspaceId,
    containerRef,
    onApprove,
    onDeny,
    onAbort,
    xtermRef,
    onRestoreFocus,
  ]);
}
