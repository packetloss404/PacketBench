import { useAgentTaskStore } from "@/stores/agentTaskStore";
import { useAppStore } from "@/stores/appStore";
import { useFlightStore } from "@/stores/flightStore";
import { useRightDockStore } from "@/stores/rightDockStore";
import { useWorkspaceStore } from "@/stores/workspaceStore";
import { makeSshUri } from "@/lib/ssh-uri";
import { getPreferredWorkspaceCli } from "@/lib/workspaceCliDefaults";
import type { AgentConversation } from "@/types/agent-conversation";
import { isLocalWorkspace, type Workspace, type WorkspaceAgentSlot } from "@/types/workspace";
import { recordWorkspaceAgentsEvent } from "@/stores/workspaceAgentsDogfoodStore";
import { useServerStore } from "@/stores/serverStore";

export type AgentHandoffErrorCode =
  | "conversation_not_found"
  | "workspace_not_found"
  | "flight_not_found"
  | "unsupported_target";

export type AgentHandoffResult<T extends object> =
  | ({ ok: true } & T)
  | { ok: false; code: AgentHandoffErrorCode; message: string };

export interface ConversationProjectTarget {
  kind: "local" | "ssh";
  projectPath: string;
  serverId?: string;
  serverName?: string;
  worktree?: {
    basePath: string;
    worktreePath: string;
    branch: string;
  };
}

function conversationById(conversationId: string): AgentConversation | null {
  return (
    useAgentTaskStore
      .getState()
      .conversations.find((conversation) => conversation.id === conversationId) ?? null
  );
}

function normalizePath(path: string, caseInsensitive: boolean): string {
  const normalized = path.trim().replace(/\\/g, "/").replace(/\/+$/, "");
  return caseInsensitive ? normalized.toLowerCase() : normalized;
}

function isWindowsStylePath(path: string): boolean {
  return /^[a-z]:[\\/]/i.test(path) || path.startsWith("\\\\");
}

function leafName(path: string): string {
  return path.replace(/\\/g, "/").split("/").filter(Boolean).pop() ?? "Project";
}

export function getConversationProjectTarget(
  conversation: AgentConversation,
): ConversationProjectTarget {
  const worktree =
    conversation.worktree?.state === "active"
      ? {
          basePath: conversation.worktree.basePath,
          worktreePath: conversation.worktree.worktreePath,
          branch: conversation.worktree.branch,
        }
      : undefined;
  const projectPath = worktree?.worktreePath ?? conversation.projectPath;

  if (conversation.sshTarget) {
    return {
      kind: "ssh",
      projectPath: projectPath || conversation.sshTarget.remotePath,
      serverId: conversation.sshTarget.id,
      serverName: conversation.sshTarget.name,
      worktree,
    };
  }

  return { kind: "local", projectPath, worktree };
}

export function workspaceMatchesConversationTarget(
  workspace: Workspace,
  target: ConversationProjectTarget,
): boolean {
  if (workspace.status !== "active" || workspace.origin === "conversation") return false;
  if (target.kind === "ssh") {
    if (workspace.serverId !== target.serverId) return false;
    const workspacePath = workspace.remoteProjectPath ?? workspace.projectPath;
    return normalizePath(workspacePath, false) === normalizePath(target.projectPath, false);
  }
  if (!isLocalWorkspace(workspace)) return false;
  return (
    normalizePath(workspace.projectPath, isWindowsStylePath(workspace.projectPath)) ===
    normalizePath(target.projectPath, isWindowsStylePath(target.projectPath))
  );
}

function ensureProjectWorkspace(
  conversation: AgentConversation,
  initialSession?: WorkspaceAgentSlot,
): { workspaceId: string; created: boolean } {
  const target = getConversationProjectTarget(conversation);
  return ensureTargetWorkspace(target, initialSession);
}

function ensureTargetWorkspace(
  target: ConversationProjectTarget,
  initialSession?: WorkspaceAgentSlot,
): { workspaceId: string; created: boolean } {
  const workspaceStore = useWorkspaceStore.getState();
  const activeMatch = workspaceStore.workspaces.find(
    (workspace) =>
      workspace.id === workspaceStore.activeWorkspaceId &&
      workspaceMatchesConversationTarget(workspace, target),
  );
  const existing =
    activeMatch ??
    workspaceStore.workspaces.find((workspace) =>
      workspaceMatchesConversationTarget(workspace, target),
    );

  if (existing) {
    workspaceStore.setActiveWorkspace(existing.id);
    return { workspaceId: existing.id, created: false };
  }

  const session = initialSession ?? getPreferredWorkspaceCli(target.serverId);
  const serverPrefix = target.kind === "ssh" && target.serverName ? `${target.serverName} · ` : "";
  const workspaceId = workspaceStore.createWorkspace(
    `${serverPrefix}${leafName(target.projectPath)}`,
    [session],
    target.projectPath,
    target.kind === "ssh"
      ? {
          serverId: target.serverId,
          remoteProjectPath: target.projectPath,
        }
      : undefined,
  );
  return { workspaceId, created: true };
}

function focusWorkspacePane(workspaceId: string, paneId: string): void {
  useWorkspaceStore.getState().requestPaneFocus(workspaceId, paneId);
  useAppStore.getState().setActiveView("workspace");
}

export function delegateWorkspaceToAgents(
  workspaceId: string,
): AgentHandoffResult<{ workspaceId: string; selectedRepo: string }> {
  const workspace = useWorkspaceStore
    .getState()
    .workspaces.find((candidate) => candidate.id === workspaceId);
  if (!workspace) {
    return {
      ok: false,
      code: "workspace_not_found",
      message: "That Workspace no longer exists.",
    };
  }
  const selectedRepo = workspace.serverId
    ? makeSshUri(workspace.serverId, workspace.remoteProjectPath ?? workspace.projectPath)
    : workspace.projectPath;
  const agentStore = useAgentTaskStore.getState();
  agentStore.setSelectedRepo(selectedRepo);
  agentStore.selectConversation(null);
  useAppStore.getState().setActiveView("agents");
  recordWorkspaceAgentsEvent("workspace_delegated_agents");
  return { ok: true, workspaceId, selectedRepo };
}

export function openConversationProjectInWorkspace(conversationId: string): AgentHandoffResult<{
  conversationId: string;
  workspaceId: string;
  created: boolean;
}> {
  const conversation = conversationById(conversationId);
  if (!conversation) {
    return {
      ok: false,
      code: "conversation_not_found",
      message: "That agent conversation no longer exists.",
    };
  }
  try {
    const workspace = ensureProjectWorkspace(conversation);
    useAppStore.getState().setActiveView("workspace");
    recordWorkspaceAgentsEvent("agent_opened_workspace_project");
    return { ok: true, conversationId, ...workspace };
  } catch (cause) {
    return {
      ok: false,
      code: "workspace_not_found",
      message:
        cause instanceof Error ? cause.message : "The project Workspace could not be opened.",
    };
  }
}

export function attachTerminalToConversationProject(conversationId: string): AgentHandoffResult<{
  conversationId: string;
  workspaceId: string;
  paneId: string;
}> {
  const conversation = conversationById(conversationId);
  if (!conversation) {
    return {
      ok: false,
      code: "conversation_not_found",
      message: "That agent conversation no longer exists.",
    };
  }

  let ensured: { workspaceId: string; created: boolean };
  try {
    ensured = ensureProjectWorkspace(conversation, "terminal");
  } catch (cause) {
    return {
      ok: false,
      code: "workspace_not_found",
      message: cause instanceof Error ? cause.message : "The terminal target is unavailable.",
    };
  }
  const { workspaceId, created } = ensured;
  const workspace = useWorkspaceStore
    .getState()
    .workspaces.find((candidate) => candidate.id === workspaceId);
  const paneId = created
    ? workspace?.panes[0]?.id
    : useWorkspaceStore.getState().addPane(workspaceId, "terminal");
  if (!paneId) {
    return {
      ok: false,
      code: "workspace_not_found",
      message: "The terminal could not be added to Workspace.",
    };
  }
  focusWorkspacePane(workspaceId, paneId);
  recordWorkspaceAgentsEvent("agent_attached_terminal");
  return { ok: true, conversationId, workspaceId, paneId };
}

export function openConversationGitEnding(conversationId: string): AgentHandoffResult<{
  conversationId: string;
  workspaceId: string;
  created: boolean;
}> {
  const project = openConversationProjectInWorkspace(conversationId);
  if (!project.ok) return project;
  useAppStore.getState().openGitPanelForConversation(conversationId, project.workspaceId);
  // D2: the panel itself is a RightDock panel now — scope in appStore,
  // visibility in the dock.
  useRightDockStore.getState().openPanel("workspace", "git");
  recordWorkspaceAgentsEvent("agent_opened_git_ending");
  return project;
}

export function openFlightAttemptInWorkspace(conversationId: string): AgentHandoffResult<{
  conversationId: string;
  workspaceId: string;
  created: boolean;
}> {
  const result = openConversationProjectInWorkspace(conversationId);
  if (result.ok) {
    recordWorkspaceAgentsEvent("flight_attempt_opened_workspace");
  }
  return result;
}

/** Inspect retained files after restart without requiring a live conversation. */
export function inspectFlightAttemptInWorkspace(
  flightId: string,
  attemptId: string,
): AgentHandoffResult<{
  workspaceId: string;
  created: boolean;
}> {
  const attempt = useFlightStore
    .getState()
    .flights.find((flight) => flight.id === flightId)
    ?.attempts?.find((candidate) => candidate.id === attemptId);
  if (!attempt)
    return {
      ok: false,
      code: "flight_not_found",
      message: "This Flight attempt no longer exists.",
    };
  const retained =
    attempt.recovery?.state === "retained" ||
    ["queued", "provisioning", "running", "reviewing"].includes(attempt.status);
  const projectPath = retained ? attempt.target.worktreePath : attempt.target.basePath;
  const server =
    attempt.target.kind === "ssh"
      ? useServerStore.getState().getServer(attempt.target.serverId)
      : undefined;
  if (attempt.target.kind === "ssh" && !server)
    return {
      ok: false,
      code: "unsupported_target",
      message: "Restore this attempt's saved SSH host before inspecting its retained worktree.",
    };
  try {
    const workspace = ensureTargetWorkspace(
      {
        kind: attempt.target.kind,
        projectPath,
        serverId: server?.id,
        serverName: server?.name,
      },
      "terminal",
    );
    useAppStore.getState().setActiveView("workspace");
    recordWorkspaceAgentsEvent("flight_attempt_opened_workspace");
    return { ok: true, ...workspace };
  } catch (error) {
    return {
      ok: false,
      code: "workspace_not_found",
      message:
        error instanceof Error ? error.message : "The retained worktree could not be opened.",
    };
  }
}

export function linkConversationToFlight(
  conversationId: string,
  flightId: string,
  options: { openFlight?: boolean } = {},
): AgentHandoffResult<{
  conversationId: string;
  flightId: string;
  alreadyLinked: boolean;
}> {
  if (!conversationById(conversationId)) {
    return {
      ok: false,
      code: "conversation_not_found",
      message: "That agent conversation no longer exists.",
    };
  }
  const flight = useFlightStore.getState().flights.find((candidate) => candidate.id === flightId);
  if (!flight) {
    return {
      ok: false,
      code: "flight_not_found",
      message: "That Flight no longer exists.",
    };
  }

  const alreadyLinked = flight.linkedSessionIds.includes(conversationId);
  if (!alreadyLinked) {
    useFlightStore.getState().updateFlight(flightId, {
      linkedSessionIds: [...flight.linkedSessionIds, conversationId],
    });
  }
  if (options.openFlight) {
    useFlightStore.getState().setActiveFlight(flightId);
    useAppStore.getState().setActiveView("flights");
  }
  recordWorkspaceAgentsEvent("agent_linked_flight");
  return { ok: true, conversationId, flightId, alreadyLinked };
}
