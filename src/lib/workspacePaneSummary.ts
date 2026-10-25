import type { WorkspacePane } from "@/types/workspace";
import { getAgentColor } from "@/lib/agentColors";
import { getWorkspaceCli } from "@/lib/workspaceCliRegistry";

const CLI_LABELS: Partial<Record<WorkspacePane["agentId"], string>> = {
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
    key: `terminal:${pane.agentId}:${accountId ?? ""}${pane.customCli ? `:${pane.customCli.name}` : ""}`,
    label: pane.customCli?.name ?? CLI_LABELS[pane.agentId] ?? getWorkspaceCli(pane.agentId)?.name ?? pane.agentId,
    accountId,
    color: getAgentColor(pane.agentId),
  };
}
