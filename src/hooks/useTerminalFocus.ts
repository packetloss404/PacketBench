import { useCallback, useEffect, type RefObject } from "react";
import type { Terminal } from "@xterm/xterm";
import { useAppStore } from "@/stores/appStore";
import { useLayoutStore } from "@/stores/layoutStore";
import { useWorkspaceStore } from "@/stores/workspaceStore";
import { isEditableTarget, isTerminalTarget } from "@/lib/keyboardTarget";
import { isModalOpen } from "@/lib/modalStack";

const CONTROL_SELECTOR =
  'button, a, input, textarea, select, [role="menuitem"], [contenteditable="true"]';

/** Selection and explicit focus requests must reach xterm's input, without
 * stealing a dialog, editor, or terminal-header control's focus. */
export function useTerminalFocus({
  paneId,
  workspaceId,
  containerRef,
  xtermRef,
  approvalRef,
  showApproval = false,
}: {
  paneId: string;
  workspaceId?: string;
  containerRef: RefObject<HTMLDivElement | null>;
  xtermRef: RefObject<Terminal | null>;
  approvalRef?: RefObject<HTMLDivElement | null>;
  showApproval?: boolean;
}) {
  const selected = useLayoutStore((s) => s.activePaneId === paneId);
  const activeView = useAppStore((s) => s.activeView);
  const activeWorkspaceId = useWorkspaceStore((s) => s.activeWorkspaceId);
  const zoomedPaneId = useWorkspaceStore((s) => s.zoomedPaneId);
  const requestToken = useWorkspaceStore((s) =>
    s.focusPaneRequest?.paneId === paneId && s.focusPaneRequest.workspaceId === workspaceId
      ? s.focusPaneRequest.token
      : null,
  );

  const focus = useCallback(
    (explicitClick = false) => {
      if (useLayoutStore.getState().activePaneId !== paneId) return;
      const container = containerRef.current;
      if (!container || !container.isConnected || container.getClientRects().length === 0) return;
      if (getComputedStyle(container).visibility === "hidden") return;
      const app = useAppStore.getState();
      if (isModalOpen() || app.commandPaletteOpen) return;
      if (
        workspaceId &&
        (app.activeView !== "workspace" ||
          useWorkspaceStore.getState().activeWorkspaceId !== workspaceId)
      )
        return;
      const focused = document.activeElement;
      if (!explicitClick && isEditableTarget(focused) && !isTerminalTarget(focused)) return;
      // A dropdown/restart/approval button inside a terminal remains operable.
      if (
        !explicitClick &&
        focused?.closest("[data-terminal-pane]") &&
        focused.closest(CONTROL_SELECTOR) &&
        !focused.closest(".xterm")
      )
        return;
      if (approvalRef?.current) approvalRef.current.focus({ preventScroll: true });
      else xtermRef.current?.focus();
    },
    [containerRef, workspaceId, xtermRef, paneId, approvalRef],
  );

  useEffect(() => {
    if (selected) focus();
  }, [selected, activeWorkspaceId, activeView, zoomedPaneId, showApproval, focus]);

  useEffect(() => {
    // Clearing the transient flash is not a new focus intent.
    if (requestToken !== null && useLayoutStore.getState().activePaneId === paneId) focus();
  }, [requestToken, paneId, focus]);

  return useCallback(
    (target?: EventTarget) => {
      const element = target instanceof Element ? target : null;
      if (element?.closest(CONTROL_SELECTOR) && !element.closest(".xterm")) return;
      focus(target !== undefined);
    },
    [focus],
  );
}
