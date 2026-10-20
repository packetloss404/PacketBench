import { describe, expect, it } from "vitest";
import {
  flightContextFromConversation,
  flightContextFromWorkspace,
  flightTargetInputError,
  initialFlightTargets,
} from "@/lib/flightLaunchContext";
import { DEFAULT_API_AGENT, getDefaultModel } from "@/lib/api-models";
import type { AgentConversation } from "@/types/agent-conversation";
import type { Workspace } from "@/types/workspace";
import type { ServerConfig } from "@/types/server";

const workspace = {
  id: "workspace",
  name: "Project",
  projectPath: "D:/repo",
  serverId: undefined,
  panes: [{ agentId: "codex" }],
} as unknown as Workspace;
const server = {
  id: "server",
  name: "Build host",
  host: "host",
  username: "dev",
  port: 22,
  hostFingerprint: "SHA256:pinned",
} as ServerConfig;
const conversation = {
  id: "chat",
  title: "Scoped change",
  mode: "api",
  agent: "api-google",
  model: "gemini-live",
  projectPath: "D:/repo/.pkt-worktrees/chat",
  messages: [
    { role: "user", content: "Make the dialog usable" },
    { role: "assistant", content: "Unapproved additional changes" },
  ],
  worktree: { basePath: "D:/repo", baseBranch: "develop" },
} as unknown as AgentConversation;

describe("Flight brief context", () => {
  it("inherits a Workspace repository without turning a PTY subscription into API credentials", () => {
    const context = flightContextFromWorkspace(workspace);
    expect(context).toMatchObject({ projectPath: "D:/repo", workspaceId: "workspace" });
    expect(context.agent).toBeUndefined();
    const [target] = initialFlightTargets(
      { ...context, agent: "codex", model: "subscription-model" },
      [workspace],
      [],
    );
    expect(target.agent).toBe(DEFAULT_API_AGENT);
    expect(target.model).toBe(getDefaultModel(DEFAULT_API_AGENT));
    expect(target.autoSelectAgent).toBe(true);
  });
  it("carries only the latest approved task and compatible API model from a conversation", () => {
    expect(flightContextFromConversation(conversation)).toMatchObject({
      objective: "Make the dialog usable",
      projectPath: "D:/repo",
      baseBranch: "develop",
      conversationId: "chat",
      agent: "api-google",
      model: "gemini-live",
    });
    expect(flightContextFromConversation({ ...conversation, mode: "pty" }).agent).toBeUndefined();
    expect(
      flightContextFromConversation({ ...conversation, agent: "api-openai-codex" }).agent,
    ).toBeUndefined();
  });
  it("uses the SSH Workspace repository rather than a local fallback and leaves a missing path editable", () => {
    const remote = { ...workspace, serverId: server.id, remoteProjectPath: "/srv/repo" };
    const [target] = initialFlightTargets(flightContextFromWorkspace(remote), [remote], [server]);
    expect(target).toMatchObject({ kind: "ssh", basePath: "/srv/repo", server });
    expect(flightTargetInputError({ ...target, baseBranch: "main" })).toBeNull();
    const [empty] = initialFlightTargets({ serverId: server.id }, [], [server]);
    expect(empty.basePath).toBe("");
    expect(flightTargetInputError(empty)).toContain("repository path");
  });
  it("blocks invalid paths, host pin gaps and invalid refs before provisioning", () => {
    const [target] = initialFlightTargets({ projectPath: "D:/repo", baseBranch: "main" }, [], []);
    expect(flightTargetInputError({ ...target, basePath: "relative/path" })).toContain("absolute");
    expect(flightTargetInputError({ ...target, basePath: "D:/repo\nother" })).toContain("control");
    expect(flightTargetInputError({ ...target, baseBranch: "--delete" })).toContain("valid Git");
    expect(
      flightTargetInputError({
        ...target,
        kind: "ssh",
        server: { ...server, hostFingerprint: undefined },
        basePath: "/srv/repo",
      }),
    ).toContain("host's key");
  });
});
