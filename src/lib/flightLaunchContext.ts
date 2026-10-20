import { API_PROVIDERS, DEFAULT_API_AGENT, getDefaultModel } from "@/lib/api-models";
import type { AgentConversation } from "@/types/agent-conversation";
import type { AgentCli } from "@/stores/agentTaskStore";
import type { Workspace } from "@/types/workspace";
import type { ServerConfig } from "@/types/server";
import type { PickedTarget } from "@/components/flights/MultiTargetPicker";

/** An editable brief, never an authorization to start a provider. */
export interface FlightLaunchContext {
  flightId?: string;
  title?: string;
  objective?: string;
  acceptanceCriteria?: string[];
  projectPath?: string;
  workspaceId?: string | null;
  serverId?: string;
  baseBranch?: string;
  agent?: AgentCli;
  model?: string;
  conversationId?: string;
  issueId?: string;
  sourceLabel?: string;
}

export function flightContextFromWorkspace(workspace: Workspace): FlightLaunchContext {
  return {
    workspaceId: workspace.id,
    projectPath: workspace.serverId
      ? workspace.remoteProjectPath || workspace.projectPath
      : workspace.projectPath,
    serverId: workspace.serverId,
    sourceLabel: workspace.name,
  };
}

export function flightContextFromConversation(
  conversation: AgentConversation,
): FlightLaunchContext {
  const api =
    conversation.mode === "api" &&
    API_PROVIDERS.some((provider) => provider.agentCli === conversation.agent);
  return {
    title: conversation.title,
    objective:
      [...conversation.messages].reverse().find((message) => message.role === "user")?.content ||
      "",
    projectPath: conversation.worktree?.basePath || conversation.projectPath,
    serverId: conversation.sshTarget?.id,
    baseBranch: conversation.worktree?.baseBranch,
    conversationId: conversation.id,
    sourceLabel: conversation.title,
    ...(api ? { agent: conversation.agent, model: conversation.model } : {}),
  };
}

export function initialFlightTargets(
  context: FlightLaunchContext,
  workspaces: Workspace[],
  servers: ServerConfig[],
): PickedTarget[] {
  const workspace = workspaces.find((item) => item.id === context.workspaceId);
  const path =
    context.projectPath ||
    (workspace?.serverId ? workspace.remoteProjectPath : workspace?.projectPath) ||
    "";
  const serverId = context.serverId || workspace?.serverId;
  const compatibleAgent = API_PROVIDERS.some((provider) => provider.agentCli === context.agent);
  const agent = compatibleAgent ? context.agent! : DEFAULT_API_AGENT;
  const common = {
    basePath: path,
    baseBranch: context.baseBranch || "",
    agent,
    model: compatibleAgent ? context.model || getDefaultModel(agent) : getDefaultModel(agent),
    autoSelectAgent: !compatibleAgent,
  };
  if (serverId) {
    const server = servers.find((item) => item.id === serverId);
    return server
      ? [{ ...common, kind: "ssh", key: `ssh:${server.id}`, server, label: server.name }]
      : [];
  }
  if (!path) return [];
  return [
    {
      ...common,
      kind: "local",
      key: `local:${workspace?.id || "brief"}`,
      workspaceId: workspace?.id || "",
      label: workspace?.name || "Local repository",
    },
  ];
}

export function flightTargetInputError(target: PickedTarget): string | null {
  if (!target.basePath.trim()) return "Choose the repository path.";
  if (/[\0\r\n]/.test(target.basePath))
    return "Repository paths cannot contain control characters.";
  if (
    target.kind === "ssh"
      ? !target.basePath.startsWith("/")
      : !/^(?:[a-z]:[\\/]|\\\\|\/)/i.test(target.basePath)
  ) {
    return "Use an absolute repository path on the execution host.";
  }
  if (target.kind === "ssh" && !target.server.hostFingerprint)
    return "Verify this SSH host's key in Servers settings first.";
  if (!target.baseBranch.trim()) return "Choose the base branch.";
  if (
    /^[-.]|[\s~^:?*\\]|\.\.|@\{|\/\/|[/.]$|\.lock$/.test(target.baseBranch) ||
    target.baseBranch.includes("[")
  )
    return "Enter a valid Git base branch.";
  return null;
}
