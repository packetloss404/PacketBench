import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LaunchConversationParams } from "@/lib/launchConversation";
import { makeSshUri } from "@/lib/ssh-uri";
import { launchDraftKey } from "@/stores/agentDraftStore";
import { flagsForMode } from "@/components/agents/agentModeChipUtils";
import type { ServerConfig } from "@/types/server";
import type { AgentProfile } from "@/types/profiles";
import type { MemoryEvent } from "@/types/memory";

/**
 * Unit coverage for the launch extraction (tile-program P1-S3, D). Exercises
 * the REAL `agentTaskStore.createApiConversation` so the worktree stamp lands
 * on the real conversation record; only the Tauri boundary (backend start +
 * worktree provisioning) is mocked. Asserts:
 *   - worktree mode stamps `conversation.worktree` with
 *     basePath / worktreePath / branch / baseBranch / state:"active".
 *   - provisioning failure is fail-closed (F1): no conversation is created,
 *     no agent starts and the draft survives for a retry or explicit Local
 *     launch.
 */

const listenMock = vi.fn();
const invokeMock = vi.fn();
const startApiAgentSessionMock = vi.fn();
const getGitBranchMock = vi.fn();
const createConversationWorktreeMock = vi.fn();

vi.mock("@tauri-apps/api/event", () => ({
  listen: (...args: unknown[]) => listenMock(...args),
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

vi.mock("@/lib/agentsMd", () => ({
  loadAgentsMd: vi.fn().mockResolvedValue(null),
}));

// NOTE: memoryStore is intentionally NOT mocked. These tests exercise the
// REAL launchConversation → createApiConversation → composeMemoryBrief
// injection seam (the artery M1 restored); only the Tauri boundary below is
// stubbed so the outgoing system prompt handed to startApiAgentSession can be
// inspected directly.

vi.mock("@/stores/layoutStore", () => ({
  useLayoutStore: {
    getState: vi.fn(() => ({ setProjectPath: vi.fn() })),
  },
}));

vi.mock("@/lib/tauri", () => ({
  createPtySession: vi.fn(),
  writePty: vi.fn(),
  killPty: vi.fn(),
  readPtyTranscript: vi.fn().mockResolvedValue({ data: "" }),
  listPtySessions: vi.fn().mockResolvedValue([]),
  detectAgent: vi.fn(),
  loadPersistedState: vi.fn(),
  saveAgentsSlice: vi.fn().mockResolvedValue(undefined),
  startApiAgentSession: (...args: unknown[]) => startApiAgentSessionMock(...args),
  sendApiAgentMessage: vi.fn(),
  cancelApiAgentSession: vi.fn().mockResolvedValue(undefined),
  cancelPendingTools: vi.fn(),
  closeApiAgentSession: vi.fn().mockResolvedValue(undefined),
  saveConversation: vi.fn().mockResolvedValue(undefined),
  loadConversations: vi.fn().mockResolvedValue([]),
  deleteConversationFile: vi.fn().mockResolvedValue(undefined),
  changeAgentModel: vi.fn(),
  setPlanMode: vi.fn(),
  setPermissionMode: vi.fn(),
  respondPermission: vi.fn(),
  setApproveWrites: vi.fn(),
  respondEdit: vi.fn(),
  retryLastTurn: vi.fn(),
  exportConversationMarkdown: vi.fn(),
  saveWorkspacesSlice: vi.fn().mockResolvedValue(undefined),
  saveServersSlice: vi.fn().mockResolvedValue(undefined),
  getGitBranch: (...args: unknown[]) => getGitBranchMock(...args),
  createConversationWorktree: (...args: unknown[]) => createConversationWorktreeMock(...args),
  // memoryStore's module-level imports (unused by these tests but must exist).
  saveMemorySlice: vi.fn().mockResolvedValue(undefined),
  summarizeSession: vi.fn(),
  extractPatterns: vi.fn(),
  togglePinnedPattern: vi.fn(),
}));

const SELECTED_REPO = "D:/projects/example";
// Launch drafts are project-scoped; the launcher clears this key on success.
const LAUNCH_KEY = launchDraftKey(SELECTED_REPO);

function baseParams(overrides: Partial<LaunchConversationParams> = {}): LaunchConversationParams {
  return {
    rawText: "do the thing",
    attachments: [],
    selectedRepo: SELECTED_REPO,
    selectedAgent: "api-openai",
    selectedModel: "gpt-4o",
    agentMode: "agent",
    composerMode: "local",
    profile: undefined,
    setLaunchError: vi.fn(),
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.resetModules();
  vi.doUnmock("@/stores/agentTaskStore");
  localStorage.clear();
  listenMock.mockResolvedValue(() => {});
  invokeMock.mockResolvedValue(undefined);
  startApiAgentSessionMock.mockResolvedValue(undefined);
});

describe("launchConversation — worktree stamping", () => {
  it("stamps conversation.worktree (basePath/worktreePath/branch/baseBranch/state) when provisioning succeeds", async () => {
    const wtPath = `${SELECTED_REPO}/.pkt-worktrees/generated`;
    getGitBranchMock.mockResolvedValue("main");
    createConversationWorktreeMock.mockResolvedValue(wtPath);

    const { useAgentTaskStore } = await import("@/stores/agentTaskStore");
    const { launchConversation } = await import("@/lib/launchConversation");

    const dispatched = await launchConversation(baseParams({ composerMode: "worktree" }));
    expect(dispatched).toBe(true);

    await vi.waitFor(() => {
      const conv = useAgentTaskStore.getState().conversations[0];
      expect(conv?.worktree).toBeDefined();
    });

    const conv = useAgentTaskStore.getState().conversations[0];
    expect(createConversationWorktreeMock).toHaveBeenCalledTimes(1);
    // The conversation runs INSIDE the worktree.
    expect(conv?.projectPath).toBe(wtPath);
    expect(conv?.worktree).toEqual({
      basePath: SELECTED_REPO,
      worktreePath: wtPath,
      branch: `pkt/${conv?.id}`,
      baseBranch: "main",
      createdAt: expect.any(Number),
      state: "active",
    });
  });

  it("reports launch phases through onPhase on success", async () => {
    const phases: string[] = [];
    getGitBranchMock.mockResolvedValue("main");
    createConversationWorktreeMock.mockResolvedValue(`${SELECTED_REPO}/.pkt-worktrees/ok`);

    const { launchConversation } = await import("@/lib/launchConversation");

    await launchConversation(
      baseParams({ composerMode: "worktree", onPhase: (phase) => phases.push(phase) }),
    );

    expect(phases[0]).toBe("preparing");
    expect(phases).toContain("starting");
    expect(phases[phases.length - 1]).toBe("running");
  });

  it("falls back to HEAD as baseBranch when the current branch can't be read", async () => {
    const wtPath = `${SELECTED_REPO}/.pkt-worktrees/generated`;
    getGitBranchMock.mockRejectedValue(new Error("detached"));
    createConversationWorktreeMock.mockResolvedValue(wtPath);

    const { useAgentTaskStore } = await import("@/stores/agentTaskStore");
    const { launchConversation } = await import("@/lib/launchConversation");

    launchConversation(baseParams({ composerMode: "worktree" }));

    await vi.waitFor(() => {
      expect(useAgentTaskStore.getState().conversations[0]?.worktree).toBeDefined();
    });

    expect(useAgentTaskStore.getState().conversations[0]?.worktree?.baseBranch).toBe("HEAD");
    // getGitBranch was cut off with an explicit HEAD base handed to provisioning.
    expect(createConversationWorktreeMock).toHaveBeenCalledWith(
      SELECTED_REPO,
      expect.any(String),
      "HEAD",
    );
  });
});

describe("launchConversation — fail-closed worktree provisioning (F1)", () => {
  it("starts nothing and creates no conversation when provisioning throws", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    getGitBranchMock.mockResolvedValue("main");
    createConversationWorktreeMock.mockRejectedValue(new Error("worktree add failed"));

    const { useAgentTaskStore } = await import("@/stores/agentTaskStore");
    const { launchConversation } = await import("@/lib/launchConversation");

    const phases: string[] = [];
    const launched = await launchConversation(
      baseParams({ composerMode: "worktree", onPhase: (phase) => phases.push(phase) }),
    );

    expect(launched).toBe(false);
    expect(phases[phases.length - 1]).toBe("failed");
    expect(createConversationWorktreeMock).toHaveBeenCalledTimes(1);
    expect(useAgentTaskStore.getState().conversations).toHaveLength(0);
    expect(startApiAgentSessionMock).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it("reports an actionable failure and keeps the draft for a retry", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const setLaunchError = vi.fn();
    getGitBranchMock.mockResolvedValue("main");
    createConversationWorktreeMock.mockRejectedValue(new Error("worktree add failed"));

    const { useAgentDraftStore } = await import("@/stores/agentDraftStore");
    const { useAgentTaskStore } = await import("@/stores/agentTaskStore");
    const { launchConversation } = await import("@/lib/launchConversation");

    useAgentDraftStore.getState().setDraft(LAUNCH_KEY, "keep this prompt");

    const launched = await launchConversation(
      baseParams({ composerMode: "worktree", setLaunchError }),
    );

    expect(launched).toBe(false);
    expect(useAgentTaskStore.getState().conversations).toHaveLength(0);

    const message = setLaunchError.mock.calls
      .map(([arg]) => arg)
      .find((arg): arg is string => typeof arg === "string");
    expect(message).toBeDefined();
    expect(message).toContain("nothing was launched");
    expect(message).toContain("Local");
    // The underlying git failure has to survive into the message — "it failed"
    // with no reason is barely better than silence.
    expect(message).toContain("worktree add failed");
    expect(useAgentDraftStore.getState().drafts[LAUNCH_KEY]).toBe("keep this prompt");
    warnSpy.mockRestore();
  });

  it("does not raise a launch error when provisioning succeeds", async () => {
    const setLaunchError = vi.fn();
    getGitBranchMock.mockResolvedValue("main");
    createConversationWorktreeMock.mockResolvedValue(`${SELECTED_REPO}/.pkt-worktrees/ok`);

    const { useAgentTaskStore } = await import("@/stores/agentTaskStore");
    const { launchConversation } = await import("@/lib/launchConversation");

    await launchConversation(baseParams({ composerMode: "worktree", setLaunchError }));

    await vi.waitFor(() => {
      expect(useAgentTaskStore.getState().conversations[0]?.worktree).toBeDefined();
    });

    expect(setLaunchError.mock.calls.every(([arg]) => arg === null)).toBe(true);
  });

  it("local (non-worktree) mode never provisions a worktree and stamps none", async () => {
    const { useAgentTaskStore } = await import("@/stores/agentTaskStore");
    const { launchConversation } = await import("@/lib/launchConversation");

    launchConversation(baseParams({ composerMode: "local" }));

    await vi.waitFor(() => {
      expect(useAgentTaskStore.getState().conversations[0]).toBeDefined();
    });

    const conv = useAgentTaskStore.getState().conversations[0];
    expect(createConversationWorktreeMock).not.toHaveBeenCalled();
    expect(conv?.projectPath).toBe(SELECTED_REPO);
    expect(conv?.worktree).toBeUndefined();
  });
});

describe("launchConversation — P3-S4 draft-tile additions", () => {
  it("fires onLaunched with the new conversation id (draft-tile pane materialization)", async () => {
    const { useAgentTaskStore } = await import("@/stores/agentTaskStore");
    const { launchConversation } = await import("@/lib/launchConversation");

    const onLaunched = vi.fn();
    launchConversation(baseParams({ onLaunched }));

    await vi.waitFor(() => {
      expect(useAgentTaskStore.getState().conversations[0]).toBeDefined();
    });
    const conv = useAgentTaskStore.getState().conversations[0];
    await vi.waitFor(() => {
      expect(onLaunched).toHaveBeenCalledWith(conv?.id);
    });
  });

  it("postureOverride expresses the full PermissionMode range (deny_all) the four buttons can't", async () => {
    const { useAgentTaskStore } = await import("@/stores/agentTaskStore");
    const { launchConversation } = await import("@/lib/launchConversation");

    // agentMode "agent" would map to permissionMode "auto"; the override wins.
    launchConversation(baseParams({ agentMode: "agent", postureOverride: flagsForMode("deny") }));

    await vi.waitFor(() => {
      expect(useAgentTaskStore.getState().conversations[0]).toBeDefined();
    });
    const conv = useAgentTaskStore.getState().conversations[0];
    expect(conv?.permissionMode).toBe("deny_all");
    expect(conv?.planMode).toBe(false);
  });

  it("inherits the workspace SSH server as conversation.sshTarget for a remote launch", async () => {
    const { useServerStore } = await import("@/stores/serverStore");
    const server: ServerConfig = {
      id: "srv-1",
      name: "Box",
      host: "example.com",
      port: 22,
      username: "ian",
      authMethod: "agent",
      remotePath: "/srv/app",
      installedAgents: [],
      hostFingerprint: "SHA256:fp",
    };
    useServerStore.setState({ servers: [server] });

    const { useAgentTaskStore } = await import("@/stores/agentTaskStore");
    const { launchConversation } = await import("@/lib/launchConversation");

    const ok = await launchConversation(
      baseParams({
        selectedAgent: "api-claude",
        selectedRepo: makeSshUri("srv-1", "/srv/app"),
      }),
    );
    expect(ok).toBe(true);

    await vi.waitFor(() => {
      expect(useAgentTaskStore.getState().conversations[0]).toBeDefined();
    });
    const conv = useAgentTaskStore.getState().conversations[0];
    expect(conv?.sshTarget?.id).toBe("srv-1");
    expect(conv?.sshTarget?.host).toBe("example.com");
    expect(conv?.projectPath).toBe("/srv/app");
  });
});

function profile(overrides: Partial<AgentProfile> = {}): AgentProfile {
  return {
    id: "prof-1",
    name: "Reviewer",
    description: "",
    systemPrompt: "",
    allowedTools: null,
    memoryContextEnabled: true,
    permissionMode: "auto",
    planMode: false,
    isBuiltin: false,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

function sessionEvent(id: string, projectPath: string, summary: string): MemoryEvent {
  return {
    id,
    type: "session_completed",
    timestamp: Date.now(),
    projectPath,
    payload: {
      sessionId: id,
      agentId: "api-openai",
      durationMs: 100,
      status: "done",
      summary,
      filesModified: [],
      keyDecisions: [],
    },
  };
}

/**
 * The injection seam itself — proving the REAL launchConversation →
 * createApiConversation → composeMemoryBrief chain lands (or withholds) the
 * project memory brief in the exact `systemPrompt` argument handed to
 * startApiAgentSession. Every other consumer test mocks memoryStore out; this
 * suite uses the real store so the seam has committed coverage post-M1
 * (profile resolution now live).
 */
describe("launchConversation — real memory-injection seam", () => {
  const MEMORY_MARKER = "PacketBench Memory Brief";

  // The system-prompt argument to startApiAgentSession is positional index 5:
  //   (id, provider, model, projectPath, initialMessage, systemPrompt, ...).
  function outgoingSystemPrompt(): string | null {
    const call = startApiAgentSessionMock.mock.calls[0];
    return (call?.[5] ?? null) as string | null;
  }

  it("P1: memoryContextEnabled=false withholds the brief even when memory exists", async () => {
    const { useMemoryStore } = await import("@/stores/memoryStore");
    const { useAgentTaskStore } = await import("@/stores/agentTaskStore");
    const { launchConversation } = await import("@/lib/launchConversation");

    useMemoryStore.setState({
      patterns: [
        {
          id: "p-1",
          pattern: "Prefer lucide icons and theme tokens over raw colors.",
          category: "convention",
          confidence: 0.9,
          extractedAt: Date.now(),
          projectPath: SELECTED_REPO,
        },
      ],
    });

    launchConversation(baseParams({ profile: profile({ memoryContextEnabled: false }) }));

    await vi.waitFor(() => {
      expect(startApiAgentSessionMock).toHaveBeenCalled();
    });

    const prompt = outgoingSystemPrompt();
    expect(prompt ?? "").not.toContain(MEMORY_MARKER);
    expect(prompt ?? "").not.toContain("Prefer lucide icons");

    const conv = useAgentTaskStore.getState().conversations[0];
    expect(conv?.systemPromptOverride ?? "").not.toContain(MEMORY_MARKER);
  });

  it("P0: memory is ON by default — a profile-less launch injects the brief (product ruling 2026-07-09)", async () => {
    const { useMemoryStore } = await import("@/stores/memoryStore");
    const { launchConversation } = await import("@/lib/launchConversation");

    useMemoryStore.setState({
      patterns: [
        {
          id: "p-default",
          pattern: "Default-on memory ruling pin.",
          category: "convention",
          confidence: 0.9,
          extractedAt: Date.now(),
          projectPath: SELECTED_REPO,
        },
      ],
    });

    launchConversation(baseParams({ profile: undefined }));

    await vi.waitFor(() => {
      expect(startApiAgentSessionMock).toHaveBeenCalled();
    });

    expect(outgoingSystemPrompt() ?? "").toContain(MEMORY_MARKER);
    expect(outgoingSystemPrompt() ?? "").toContain("Default-on memory ruling pin.");
  });

  it("P2: an enabled profile prepends the brief (with seeded pattern) ahead of the profile prompt", async () => {
    const { useMemoryStore } = await import("@/stores/memoryStore");
    const { useAgentTaskStore } = await import("@/stores/agentTaskStore");
    const { launchConversation } = await import("@/lib/launchConversation");

    useMemoryStore.setState({
      patterns: [
        {
          id: "p-1",
          pattern: "Prefer lucide icons and theme tokens over raw colors.",
          category: "convention",
          confidence: 0.9,
          extractedAt: Date.now(),
          projectPath: SELECTED_REPO,
        },
      ],
    });

    launchConversation(
      baseParams({
        profile: profile({
          memoryContextEnabled: true,
          systemPrompt: "PROFILE_DIRECTIVE_SENTINEL",
        }),
      }),
    );

    await vi.waitFor(() => {
      expect(startApiAgentSessionMock).toHaveBeenCalled();
    });

    const prompt = outgoingSystemPrompt() ?? "";
    expect(prompt).toContain(MEMORY_MARKER);
    expect(prompt).toContain("Prefer lucide icons");
    expect(prompt).toContain("PROFILE_DIRECTIVE_SENTINEL");
    // The brief lands BEFORE the profile's own directive (memory is context,
    // the profile prompt wins conflicts by living last).
    expect(prompt.indexOf(MEMORY_MARKER)).toBeLessThan(
      prompt.indexOf("PROFILE_DIRECTIVE_SENTINEL"),
    );

    const conv = useAgentTaskStore.getState().conversations[0];
    expect(conv?.systemPromptOverride ?? "").toContain(MEMORY_MARKER);
  });

  it("P3: an SSH launch injects remote-keyed memory and excludes local-path items", async () => {
    const { useServerStore } = await import("@/stores/serverStore");
    const { useMemoryStore, remoteMemoryProjectKey } = await import("@/stores/memoryStore");
    const { launchConversation } = await import("@/lib/launchConversation");

    const server: ServerConfig = {
      id: "srv-1",
      name: "Box",
      host: "example.com",
      port: 22,
      username: "ian",
      authMethod: "agent",
      remotePath: "/srv/app",
      installedAgents: [],
      hostFingerprint: "SHA256:fp",
    };
    useServerStore.setState({ servers: [server] });

    useMemoryStore.setState({
      events: [
        sessionEvent(
          "remote-1",
          remoteMemoryProjectKey("srv-1", "/srv/app"),
          "REMOTE_DEPLOY_NOTE pin the host key before deploy.",
        ),
      ],
      patterns: [
        {
          id: "local-1",
          pattern: "LOCAL_ONLY_PATTERN never leaves the workstation.",
          category: "convention",
          confidence: 0.95,
          extractedAt: Date.now(),
          projectPath: "D:/projects/app",
        },
      ],
    });

    launchConversation(
      baseParams({
        selectedAgent: "api-claude",
        selectedRepo: makeSshUri("srv-1", "/srv/app"),
        profile: profile({
          memoryContextEnabled: true,
          systemPrompt: "PROFILE_DIRECTIVE_SENTINEL",
        }),
      }),
    );

    await vi.waitFor(() => {
      expect(startApiAgentSessionMock).toHaveBeenCalled();
    });

    const prompt = outgoingSystemPrompt() ?? "";
    expect(prompt).toContain(MEMORY_MARKER);
    expect(prompt).toContain("REMOTE_DEPLOY_NOTE");
    expect(prompt).not.toContain("LOCAL_ONLY_PATTERN");
  });
});

describe("launchConversation — failed backend start (F4)", () => {
  it("reports failure and retains the draft when the backend start rejects", async () => {
    startApiAgentSessionMock.mockRejectedValue(new Error("provider exploded"));
    const setLaunchError = vi.fn();
    const phases: string[] = [];

    const { useAgentDraftStore } = await import("@/stores/agentDraftStore");
    const { useAgentTaskStore } = await import("@/stores/agentTaskStore");
    const { launchConversation } = await import("@/lib/launchConversation");

    useAgentDraftStore.getState().setDraft(LAUNCH_KEY, "keep this prompt");

    const launched = await launchConversation(
      baseParams({ setLaunchError, onPhase: (phase) => phases.push(phase) }),
    );

    expect(launched).toBe(false);
    expect(phases[phases.length - 1]).toBe("failed");
    // A rejected start must never be reported as a running turn.
    expect(phases).not.toContain("running");

    const message = setLaunchError.mock.calls
      .map(([arg]) => arg)
      .find(
        (arg): arg is string =>
          typeof arg === "string" && arg.includes("failed before the agent produced a response"),
      );
    expect(message).toBeDefined();

    // The failed conversation record still exists so the failure is inspectable…
    expect(useAgentTaskStore.getState().conversations[0]?.status).toBe("failed");
    // …but the user's draft is NOT cleared — it is theirs to retry.
    expect(useAgentDraftStore.getState().drafts[LAUNCH_KEY]).toBe("keep this prompt");
  });

  it("clears the draft only once a start actually succeeds", async () => {
    const { useAgentDraftStore } = await import("@/stores/agentDraftStore");
    const { launchConversation } = await import("@/lib/launchConversation");

    useAgentDraftStore.getState().setDraft(LAUNCH_KEY, "send this");

    const launched = await launchConversation(baseParams());

    expect(launched).toBe(true);
    expect(useAgentDraftStore.getState().drafts[LAUNCH_KEY]).toBeUndefined();
  });
});

describe("launchConversation — synchronous guards (behavior parity)", () => {
  it("returns false for empty text and dispatches nothing", async () => {
    const { launchConversation } = await import("@/lib/launchConversation");
    expect(launchConversation(baseParams({ rawText: "   " }))).toBe(false);
    expect(startApiAgentSessionMock).not.toHaveBeenCalled();
  });

  it("returns false when no repo is selected", async () => {
    const { launchConversation } = await import("@/lib/launchConversation");
    expect(launchConversation(baseParams({ selectedRepo: null }))).toBe(false);
  });
});
