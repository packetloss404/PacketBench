import type { WorkspacePane } from "@/types/workspace";
import { getAgentColor } from "@/lib/agentColors";

const CLI_LABELS: Record<WorkspacePane["agentId"], string> = {
  terminal: "Terminal",
  "claude-code": "Claude",
  codex: "Codex",
  opencode: "OpenCode",
  packetcode: "PacketCode",
};

/** Both Workspace summaries classify the pane before reading its inert CLI
 * carrier fields. Account grouping applies only to real terminal panes. */
export function workspacePaneSummaryIdentity(pane: WorkspacePane) {
  if (pane.kind === "file") {
    return {
      key: "file",
      label: "File viewer",
      accountId: null,
      color: { bg: "bg-bg-elevated", text: "text-accent-blue" },
    };
  }
  if (pane.kind === "conversation") {
    return {
      key: "conversation",
      label: "Saved conversation",
      accountId: null,
      color: { bg: "bg-bg-elevated", text: "text-accent-purple" },
    };
  }
  const accountId = pane.accountId ?? null;
  return {
    key: `terminal:${pane.agentId}:${accountId ?? ""}`,
    label: CLI_LABELS[pane.agentId] ?? pane.agentId,
    accountId,
    color: getAgentColor(pane.agentId),
  };
}
