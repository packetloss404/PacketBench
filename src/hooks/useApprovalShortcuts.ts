import { useEffect, type RefObject } from "react";
import type { Terminal } from "@xterm/xterm";
import { useLayoutStore } from "@/stores/layoutStore";

/**
 * Panes currently showing an approval prompt.
 *
 * These hotkeys are bound on `window`, so every waiting pane's handler runs on
 * a single keypress and `preventDefault` cannot stop a sibling (they share one
 * target; only `stopImmediatePropagation` would). Rather than fight that, each
 * handler decides whether the keypress is addressed to IT — and answering that
 * needs to know how many panes are waiting, which is what this registry is for.
 *
 * Module-level and deliberately not React state: it is read synchronously
 * inside a keydown handler, and a re-render per registration would be pure
 * overhead.
 */
const panesAwaitingApproval = new Set<string>();

/** Test-only escape hatch for suites that unmount without running cleanup. */
export function resetApprovalRegistry(): void {
  panesAwaitingApproval.clear();
}

interface UseApprovalShortcutsOptions {
  showApproval: boolean;
  /** Identifies this pane, so a keypress can be attributed to one prompt. */
  paneId: string;
  xtermRef: RefObject<Terminal | null>;
  onApprove: () => void;
  onDeny: () => void;
  onAbort: () => void;
  /** Owning pane can restore focus with visibility/selection/dialog guards. */
  onRestoreFocus?: () => void;
}

/**
 * Bare `y` / `n` / `Escape` for a terminal pane's approval prompt.
 *
 * Ownership rule, in order:
 *   - exactly ONE pane is waiting  → it owns the keypress, focused or not.
 *     This is the overwhelmingly common case and the unambiguous one; requiring
 *     a click first would break the single-agent workflow for no safety gain.
 *   - several panes are waiting    → only the ACTIVE pane answers.
 *   - several are waiting and none is active → nobody answers. The prompt is
 *     genuinely ambiguous, so the user picks a pane (clicking it makes it
 *     active) or uses that pane's on-screen Approve/Deny buttons.
 *
 * The previous version had no ownership at all: every waiting pane bound the
 * same window keys, so one `y` wrote `y\n` into EVERY waiting agent's stdin —
 * silently approving actions in panes the user had not looked at. An approval
 * prompt exists to be a per-action decision; that turned it into a blanket one.
 */
export function useApprovalShortcuts({
  showApproval,
  paneId,
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

    panesAwaitingApproval.add(paneId);

    const handler = (e: KeyboardEvent) => {
      // Someone with a stronger claim already handled this keypress.
      if (e.defaultPrevented) return;
      // Never steal a literal keystroke from a field the user is typing in.
      // (xterm's focus holder is a textarea, so this also covers terminals.)
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) {
        return;
      }
      // Is this keypress addressed to THIS pane? See the ownership rule above.
      if (panesAwaitingApproval.size > 1) {
        if (useLayoutStore.getState().activePaneId !== paneId) return;
      }

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
      panesAwaitingApproval.delete(paneId);
      if (onRestoreFocus) onRestoreFocus();
      else if (term) term.focus();
    };
  }, [showApproval, paneId, onApprove, onDeny, onAbort, xtermRef, onRestoreFocus]);
}
