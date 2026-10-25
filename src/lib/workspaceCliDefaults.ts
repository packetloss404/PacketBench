import { WORKSPACE_CLI_REGISTRY, supportsLocalCli } from "./workspaceCliRegistry";
import { useAgentStore } from "@/stores/agentStore";
import { useServerStore } from "@/stores/serverStore";
import type { WorkspaceAgentSlot } from "@/types/workspace";

/**
 * New Workspace preference order. PacketCode leads when it is available; the
 * remaining installed coding CLIs follow, with a plain terminal as the
 * guaranteed fallback.
 */
export const WORKSPACE_CLI_PRIORITY: readonly WorkspaceAgentSlot[] = [
  "packetcode",
  "claude-code",
  "codex",
  "opencode",
  ...WORKSPACE_CLI_REGISTRY.map((p) => p.id).filter((id) => !["packetcode", "claude-code", "codex", "opencode"].includes(id)),
  "terminal",
];

export function choosePreferredWorkspaceCli(
  installedIds: ReadonlySet<string>,
): WorkspaceAgentSlot {
  return (
    WORKSPACE_CLI_PRIORITY.find(
      (slot) => slot === "terminal" || installedIds.has(slot),
    ) ?? "terminal"
  );
}

/**
 * Resolve the preferred CLI from the current local or SSH detection snapshot.
 * This is intentionally a creation-time choice: existing Workspaces and panes
 * are never rewritten when detection changes.
 */
export function getPreferredWorkspaceCli(
  serverId?: string,
): WorkspaceAgentSlot {
  if (serverId) {
    const server = useServerStore
      .getState()
      .servers.find((candidate) => candidate.id === serverId);
    return choosePreferredWorkspaceCli(
      new Set(server?.installedAgents ?? []),
    );
  }

  return choosePreferredWorkspaceCli(
    new Set(
      useAgentStore
        .getState()
        .agents.filter((agent) => agent.installed && supportsLocalCli(agent.id))
        .map((agent) => agent.id),
    ),
  );
}
