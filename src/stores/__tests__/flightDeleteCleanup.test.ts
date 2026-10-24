/**
 * Flight delete fan-out.
 *
 * Deleting a Flight used to drop the record and abandon everything it owned:
 * queued/provisioning/running/reviewing attempts kept their API sessions and
 * their git worktrees stayed on disk (or on the SSH host) with nothing in the
 * UI pointing at them. These tests pin the approved behaviour:
 *
 *   - every non-terminal attempt is cancelled through the normal cancel path
 *     (which is what closes the session and removes the worktree);
 *   - terminal attempts with retained worktrees are explicitly cleaned up;
 *   - preserving Stop fences startup before destructive cleanup; Stop failure
 *     keeps the Flight record and prevents destructive cleanup;
 *   - cleanup is best-effort: a failing attempt is REPORTED, never allowed to
 *     abort the delete;
 *   - the confirm's counts (attempts, worktrees, dirty worktrees) are derived
 *     from a real dirty-check, not guessed.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Attempt, Flight } from "@/types/flight";
import type { WorktreeCleanupOutcome } from "@/lib/tauri";

const mocks = vi.hoisted(() => ({
  cancelFlightAttempt: vi.fn(),
  stopFlightSessions: vi.fn(),
  loadPersistedState: vi.fn(),
  cleanupAttemptWorktreeSsh: vi.fn(),
  cleanupFlightIntegrationWorktree: vi.fn(),
  getGitStatus: vi.fn(),
  getGitStatusRemote: vi.fn(),
  getServer: vi.fn(),
  captureFlightCompleted: vi.fn(),
  adjustConfidenceForFlight: vi.fn(),
  clearInjectedPatterns: vi.fn(),
  assignToFlight: vi.fn(),
  issues: [] as { id: string; flightId: string | null }[],
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn().mockResolvedValue(() => {}),
}));

vi.mock("@/lib/tauri", () => ({
  launchFlightAsync: vi.fn(),
  cancelFlightAttempt: mocks.cancelFlightAttempt,
  stopFlightSessions: mocks.stopFlightSessions,
  cleanupAttemptWorktreeSsh: mocks.cleanupAttemptWorktreeSsh,
  cleanupFlightIntegrationWorktree: mocks.cleanupFlightIntegrationWorktree,
  // Real implementation — the whole point is that a reported failure is
  // recognised as one.
  worktreeCleanupNeedsAttention: (outcome: {
    error: string | null;
    removed: boolean;
    deferred: boolean;
  }) => Boolean(outcome.error) || outcome.deferred || !outcome.removed,
  getGitStatus: mocks.getGitStatus,
  getGitStatusRemote: mocks.getGitStatusRemote,
  markAttemptStatus: vi.fn().mockResolvedValue(undefined),
  setAttemptDraftPr: vi.fn(),
  summarizeFlight: vi.fn(),
  gitPushRemote: vi.fn(),
  integrateFlightAttempt: vi.fn(),
  landFlightIntegration: vi.fn(),
  prepareFlightIntegrationBranch: vi.fn(),
  toGitServerConfigInput: (server: { id: string }) => ({ id: server.id }),
  loadPersistedState: mocks.loadPersistedState,
  saveFlightsSlice: vi.fn().mockResolvedValue(undefined),
  saveUiSlice: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/stores/costGuardrailStore", () => ({
  assertCostGuardrailsAllowLaunch: vi.fn(),
  useCostGuardrailStore: { getState: () => ({ sessionLimitUsd: null }) },
}));

vi.mock("@/stores/agentTaskStore", () => ({
  useAgentTaskStore: {
    getState: () => ({ conversations: [], createApiConversation: vi.fn() }),
  },
}));

vi.mock("@/stores/serverStore", () => ({
  useServerStore: { getState: () => ({ getServer: mocks.getServer }) },
}));

vi.mock("@/stores/githubStore", () => ({
  useGitHubStore: { getState: () => ({ config: { selectedRepo: null } }) },
}));

vi.mock("@/stores/workspaceStore", () => ({
  useWorkspaceStore: { getState: () => ({ workspaces: [] }) },
}));

vi.mock("@/stores/memoryStore", () => ({
  useMemoryStore: {
    getState: () => ({
      composeMemoryBrief: vi.fn().mockReturnValue({ text: "", items: [] }),
      captureFlightCompleted: mocks.captureFlightCompleted,
      adjustConfidenceForFlight: mocks.adjustConfidenceForFlight,
      clearInjectedPatterns: mocks.clearInjectedPatterns,
      recordInjectedPatterns: vi.fn(),
      updateFlightRetrospective: vi.fn(),
    }),
  },
}));

vi.mock("@/stores/issueStore", () => ({
  useIssueStore: {
    getState: () => ({ issues: mocks.issues, assignToFlight: mocks.assignToFlight }),
  },
}));

import {
  attemptsNeedingCleanup,
  describeFlightDeleteImpact,
  inspectFlightDeleteImpact,
  summarizeFlightDeleteImpact,
  useAsyncFlightStore,
} from "@/stores/asyncFlightStore";
import { useFlightStore } from "@/stores/flightStore";
import { useAgentApprovalStore } from "@/stores/agentApprovalStore";
import { registerFlightStartup } from "@/lib/flightRunControl";

function attempt(overrides: Partial<Attempt> = {}): Attempt {
  const id = overrides.id ?? "att-running";
  return {
    id,
    flightId: "flight-1",
    target: {
      kind: "local",
      basePath: "D:\\Repo",
      worktreePath: `D:\\Repo\\.git\\packetbench-worktrees\\${id}`,
    },
    agentConfigId: "api-claude",
    model: "claude-sonnet-4-6",
    provider: "claude",
    branch: `packetbench/${id}`,
    baseBranch: "main",
    sessionId: `sess-${id}`,
    status: "running",
    cost: 0,
    tokens: 0,
    ...overrides,
  };
}

function sshAttempt(overrides: Partial<Attempt> = {}): Attempt {
  return attempt({
    id: "att-ssh",
    sessionId: "sess-ssh",
    branch: "packetbench/att-ssh",
    target: {
      kind: "ssh",
      serverId: "server-1",
      basePath: "/srv/repo",
      worktreePath: "/srv/repo/.git/packetbench-worktrees/att-ssh",
    },
    ...overrides,
  });
}

function flight(overrides: Partial<Flight> = {}): Flight {
  return {
    id: "flight-1",
    title: "Doomed flight",
    objective: "Do work",
    status: "active",
    priority: "medium",
    projectPath: "D:/repo",
    workspaceId: null,
    milestones: [],
    linkedSessionIds: [],
    issueIds: [],
    createdAt: 1,
    updatedAt: 1,
    totalCost: 0,
    totalTokens: 0,
    attempts: [],
    ...overrides,
  };
}

function seed(f: Flight) {
  mocks.issues = f.issueIds.map((id) => ({ id, flightId: f.id }));
  useFlightStore.setState({ flights: [f], activeFlightId: f.id });
}

/** A backend `WorktreeCleanupOutcome` — clean unless overridden. */
function outcome(overrides: Partial<WorktreeCleanupOutcome> = {}): WorktreeCleanupOutcome {
  return {
    worktreePath: "D:\\Repo\\.pkt-worktrees\\att-run",
    removed: true,
    branch: null,
    branchDeleted: false,
    branchRetained: null,
    dirtyPaths: [],
    error: null,
    deferred: false,
    ...overrides,
  };
}

const INTEGRATION: NonNullable<Flight["integrationBranch"]> = {
  branch: "packetbench/flight/flight-1",
  baseBranch: "main",
  baseSha: "aaa",
  headSha: "bbb",
  worktreePath: "D:\\Repo\\.pkt-flight-integrations\\flight-1",
  targetKind: "local",
  status: "ready",
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.cancelFlightAttempt.mockResolvedValue(outcome());
  mocks.stopFlightSessions.mockResolvedValue(undefined);
  mocks.loadPersistedState.mockImplementation(async () => ({
    flights: useFlightStore.getState().flights,
    ui: { selectedFlightId: useFlightStore.getState().activeFlightId },
  }));
  mocks.issues = [];
  mocks.cleanupAttemptWorktreeSsh.mockResolvedValue(undefined);
  mocks.cleanupFlightIntegrationWorktree.mockResolvedValue(
    outcome({ worktreePath: INTEGRATION.worktreePath, branch: INTEGRATION.branch }),
  );
  mocks.getGitStatus.mockResolvedValue("");
  mocks.getGitStatusRemote.mockResolvedValue("");
  mocks.getServer.mockReturnValue({
    id: "server-1",
    name: "box",
    host: "example.test",
    port: 22,
    username: "ian",
    authMethod: "key",
    keyPath: null,
    hostFingerprint: "SHA256:abc",
  });
  useFlightStore.setState({ flights: [], activeFlightId: null });
  useAgentApprovalStore.setState({ permissions: new Map(), edits: new Map() });
});

describe("Stop approval recovery", () => {
  it("clears current and historical owned approval queues after preserving Stop, keeping unrelated prompts", async () => {
    const owned = ["builder", "previous-builder", "reviewer", "planner"];
    seed(
      flight({
        planningConversationId: "planner",
        attempts: [
          attempt({
            sessionId: "builder",
            sessionHistory: [{ sessionId: "previous-builder", provider: "openai", model: "old" }],
            reviewGate: { status: "running", reviewerConversationId: "reviewer" },
          }),
        ],
      }),
    );
    useAgentApprovalStore.setState({
      permissions: new Map(
        [...owned, "unrelated"].map((id) => [id, [{ id: "tool", name: "bash", arguments: "{}" }]]),
      ),
      edits: new Map(owned.map((id) => [id, [{ id: "edit", path: "file", content: "change" }]])),
    });
    await useAsyncFlightStore.getState().stopFlight("flight-1");
    for (const id of owned) {
      expect(useAgentApprovalStore.getState().permissions.has(id)).toBe(false);
      expect(useAgentApprovalStore.getState().edits.has(id)).toBe(false);
    }
    expect(useAgentApprovalStore.getState().permissions.has("unrelated")).toBe(true);
    expect(mocks.cancelFlightAttempt).not.toHaveBeenCalled();
  });

  it("keeps still-live permission prompts when native Stop fails", async () => {
    seed(flight({ attempts: [attempt({ sessionId: "builder" })] }));
    useAgentApprovalStore.setState({
      permissions: new Map([["builder", [{ id: "tool", name: "bash", arguments: "{}" }]]]),
    });
    mocks.stopFlightSessions.mockRejectedValueOnce(new Error("host unreachable"));
    await expect(useAsyncFlightStore.getState().stopFlight("flight-1")).rejects.toThrow(
      "host unreachable",
    );
    expect(useAgentApprovalStore.getState().permissions.get("builder")).toHaveLength(1);
  });
});

describe("attemptsNeedingCleanup", () => {
  it("selects every non-terminal status and excludes terminal records without retained work", () => {
    const f = flight({
      attempts: [
        attempt({ id: "a-queued", status: "queued" }),
        attempt({ id: "a-prov", status: "provisioning" }),
        attempt({ id: "a-run", status: "running" }),
        attempt({ id: "a-review", status: "reviewing" }),
        attempt({ id: "a-done", status: "completed" }),
        attempt({ id: "a-failed", status: "failed" }),
        attempt({ id: "a-cancelled", status: "cancelled" }),
      ],
    });

    expect(attemptsNeedingCleanup(f).map((a) => a.id)).toEqual([
      "a-queued",
      "a-prov",
      "a-run",
      "a-review",
    ]);
  });

  it.each(["completed", "failed", "cancelled"] as const)(
    "includes a %s attempt whose worktree was retained",
    (status) => {
      const kept = attempt({
        id: "retained",
        status,
        recovery: { state: "retained", reason: "Work preserved", retainedAt: 1 },
      });
      expect(attemptsNeedingCleanup(flight({ attempts: [kept] }))).toEqual([kept]);
    },
  );

  it("tolerates a missing flight and an attempt-less flight", () => {
    expect(attemptsNeedingCleanup(undefined)).toEqual([]);
    expect(attemptsNeedingCleanup(flight({ attempts: undefined }))).toEqual([]);
  });
});

describe("deleteFlightWithAttemptCleanup", () => {
  it("preserves Stop before cleanup and recomputes retained attempts from the hydrated result", async () => {
    seed(flight({ attempts: [attempt({ id: "a-running", status: "running" })] }));
    mocks.stopFlightSessions.mockImplementation(async () => {
      expect(mocks.cancelFlightAttempt).not.toHaveBeenCalled();
      const current = useFlightStore.getState().flights[0];
      useFlightStore.setState({
        flights: [
          {
            ...current,
            attempts: [
              attempt({
                id: "a-running",
                status: "cancelled",
                recovery: { state: "retained", reason: "Stopped", retainedAt: 1 },
              }),
              attempt({
                id: "late-startup",
                status: "cancelled",
                recovery: { state: "retained", reason: "Startup stopped", retainedAt: 1 },
              }),
            ],
          },
        ],
      });
    });
    await expect(
      useAsyncFlightStore.getState().deleteFlightWithAttemptCleanup("flight-1"),
    ).resolves.toEqual([]);
    expect(mocks.stopFlightSessions).toHaveBeenCalledWith("flight-1");
    expect(mocks.loadPersistedState).toHaveBeenCalled();
    expect(mocks.cancelFlightAttempt.mock.calls.map((call) => call[1])).toEqual([
      "a-running",
      "late-startup",
    ]);
    expect(useFlightStore.getState().flights).toEqual([]);
  });

  it("cleans up a previously stopped cancelled attempt's retained worktree on explicit delete", async () => {
    seed(
      flight({
        attempts: [
          attempt({
            id: "stopped-work",
            status: "cancelled",
            recovery: { state: "retained", reason: "User stopped the Flight", retainedAt: 1 },
          }),
        ],
      }),
    );
    await useAsyncFlightStore.getState().deleteFlightWithAttemptCleanup("flight-1");
    expect(mocks.cancelFlightAttempt).toHaveBeenCalledWith("flight-1", "stopped-work");
    expect(useFlightStore.getState().flights).toEqual([]);
  });

  it("waits for pending startup to settle before destructive cleanup", async () => {
    seed(flight({ attempts: [attempt({ id: "pending", status: "provisioning" })] }));
    const startup = registerFlightStartup("flight-1");
    const deletion = useAsyncFlightStore.getState().deleteFlightWithAttemptCleanup("flight-1");
    try {
      await vi.waitFor(() => expect(mocks.stopFlightSessions).toHaveBeenCalledOnce());
      expect(startup.isCurrent()).toBe(false);
      expect(mocks.cancelFlightAttempt).not.toHaveBeenCalled();
      expect(useFlightStore.getState().flights).toHaveLength(1);
    } finally {
      startup.finish();
    }
    await expect(deletion).resolves.toEqual([]);
    expect(mocks.cancelFlightAttempt).toHaveBeenCalledWith("flight-1", "pending");
  });

  it("keeps the Flight record when preserving Stop fails", async () => {
    mocks.stopFlightSessions.mockRejectedValueOnce(new Error("Stop could not reach the SSH host"));
    seed(
      flight({
        attempts: [sshAttempt()],
        executionMode: "cooperative",
        integrationBranch: INTEGRATION,
      }),
    );
    await expect(
      useAsyncFlightStore.getState().deleteFlightWithAttemptCleanup("flight-1"),
    ).rejects.toThrow("Stop could not reach the SSH host");
    expect(useFlightStore.getState().flights.map((item) => item.id)).toEqual(["flight-1"]);
    expect(mocks.cancelFlightAttempt).not.toHaveBeenCalled();
    expect(mocks.cleanupAttemptWorktreeSsh).not.toHaveBeenCalled();
    expect(mocks.cleanupFlightIntegrationWorktree).not.toHaveBeenCalled();
  });

  it("cancels every non-terminal attempt and removes their worktrees", async () => {
    seed(
      flight({
        attempts: [
          attempt({ id: "a-run", sessionId: "s-run", status: "running" }),
          attempt({ id: "a-review", sessionId: "s-review", status: "reviewing" }),
          sshAttempt({ id: "a-ssh", sessionId: "s-ssh", status: "queued" }),
        ],
      }),
    );

    const failures = await useAsyncFlightStore
      .getState()
      .deleteFlightWithAttemptCleanup("flight-1");

    expect(failures).toEqual([]);
    // The cancel command is what closes the session AND removes the worktree
    // (local inline, remote via the saved ServerConfig) on the Rust side.
    expect(mocks.cancelFlightAttempt.mock.calls.map((c) => c[1])).toEqual([
      "a-run",
      "a-review",
      "a-ssh",
    ]);
    // SSH worktrees additionally get the frontend fallback sweep, which is the
    // only path that carries host/user/key details.
    expect(mocks.cleanupAttemptWorktreeSsh).toHaveBeenCalledTimes(1);
    expect(mocks.cleanupAttemptWorktreeSsh).toHaveBeenCalledWith(
      expect.objectContaining({ attemptId: "a-ssh", basePath: "/srv/repo" }),
    );
    expect(useFlightStore.getState().flights).toEqual([]);
  });

  it("leaves terminal attempts without retained work alone", async () => {
    seed(
      flight({
        attempts: [
          attempt({ id: "a-done", status: "completed" }),
          attempt({ id: "a-failed", status: "failed" }),
          sshAttempt({ id: "a-cancelled", status: "cancelled" }),
        ],
      }),
    );

    const failures = await useAsyncFlightStore
      .getState()
      .deleteFlightWithAttemptCleanup("flight-1");

    expect(failures).toEqual([]);
    expect(mocks.cancelFlightAttempt).not.toHaveBeenCalled();
    expect(mocks.cleanupAttemptWorktreeSsh).not.toHaveBeenCalled();
    expect(useFlightStore.getState().flights).toEqual([]);
  });

  it("still completes the delete when one attempt fails to clean up, and reports it", async () => {
    mocks.cancelFlightAttempt.mockImplementation(async (_flightId: string, attemptId: string) => {
      if (attemptId === "a-bad") throw new Error("pty is wedged");
    });
    seed(
      flight({
        attempts: [
          attempt({ id: "a-bad", sessionId: "s-bad", status: "running" }),
          attempt({ id: "a-good", sessionId: "s-good", status: "running" }),
        ],
      }),
    );

    const failures = await useAsyncFlightStore
      .getState()
      .deleteFlightWithAttemptCleanup("flight-1");

    // The delete itself is never lost.
    expect(useFlightStore.getState().flights).toEqual([]);
    // The healthy sibling is still cancelled — cleanup does not stop halfway.
    expect(mocks.cancelFlightAttempt.mock.calls.map((c) => c[1])).toEqual(["a-bad", "a-good"]);
    expect(failures).toHaveLength(1);
    expect(failures[0].attemptId).toBe("a-bad");
    expect(failures[0].branch).toBe("packetbench/a-bad");
    expect(failures[0].message).toContain("pty is wedged");
    // The message names the worktree that may survive, so the user can go
    // clean it up by hand.
    expect(failures[0].message).toContain("packetbench-worktrees");
  });

  it("reports a worktree the backend could not remove, instead of a clean delete", async () => {
    // The hole this closes: cancel_flight_attempt used to warn!-log a failed
    // `git worktree remove` and return success, so the toast never fired.
    mocks.cancelFlightAttempt.mockResolvedValue(
      outcome({
        worktreePath: "D:\\Repo\\.pkt-worktrees\\att-stuck",
        removed: false,
        error: "git worktree remove failed (exit 128): is dirty",
      }),
    );
    seed(flight({ attempts: [attempt({ id: "att-stuck", status: "running" })] }));

    const failures = await useAsyncFlightStore
      .getState()
      .deleteFlightWithAttemptCleanup("flight-1");

    expect(useFlightStore.getState().flights).toEqual([]);
    expect(failures).toHaveLength(1);
    expect(failures[0].attemptId).toBe("att-stuck");
    expect(failures[0].branch).toBe("packetbench/att-stuck");
    // Names the path AND the git reason so the user can finish by hand.
    expect(failures[0].message).toContain("D:\\Repo\\.pkt-worktrees\\att-stuck");
    expect(failures[0].message).toContain("git worktree remove failed");
  });

  it("reports a deferred remote teardown returned by the backend", async () => {
    // Backend could not resolve the saved server; the frontend sweep can't
    // either, so the remote worktree is still on the host.
    mocks.getServer.mockReturnValue(undefined);
    mocks.cancelFlightAttempt.mockResolvedValue(
      outcome({
        worktreePath: "/srv/repo/.pkt-worktrees/att-ssh",
        removed: false,
        deferred: true,
      }),
    );
    seed(flight({ attempts: [sshAttempt({ status: "running" })] }));

    const failures = await useAsyncFlightStore
      .getState()
      .deleteFlightWithAttemptCleanup("flight-1");

    expect(failures).toHaveLength(1);
    expect(failures[0].message).toContain("/srv/repo/.git/packetbench-worktrees/att-ssh");
    expect(failures[0].message).toContain("no longer configured");
  });

  it("cancelAttempt resolves the teardown problem so single cancels can report it too", async () => {
    mocks.cancelFlightAttempt.mockResolvedValue(
      outcome({ worktreePath: "/w/att-run", removed: false, error: "device busy" }),
    );
    seed(flight({ attempts: [attempt({ id: "att-run", status: "running" })] }));

    await expect(
      useAsyncFlightStore.getState().cancelAttempt("flight-1", "att-run"),
    ).resolves.toContain("device busy");
  });

  it("reports a remote worktree that cannot be reached because its server is gone", async () => {
    mocks.getServer.mockReturnValue(undefined);
    seed(flight({ attempts: [sshAttempt({ status: "running" })] }));

    const failures = await useAsyncFlightStore
      .getState()
      .deleteFlightWithAttemptCleanup("flight-1");

    expect(useFlightStore.getState().flights).toEqual([]);
    expect(failures).toHaveLength(1);
    expect(failures[0].message).toContain("left in place");
    expect(failures[0].message).toContain("server-1");
  });

  it("deletes a flight with no attempts without touching the cancel path", async () => {
    seed(flight({ attempts: [] }));

    await expect(
      useAsyncFlightStore.getState().deleteFlightWithAttemptCleanup("flight-1"),
    ).resolves.toEqual([]);
    expect(mocks.cancelFlightAttempt).not.toHaveBeenCalled();
    expect(useFlightStore.getState().flights).toEqual([]);
  });

  it("unassigns linked issues, like the plain record delete does", async () => {
    seed(flight({ issueIds: ["issue-1", "issue-2"] }));

    await useAsyncFlightStore.getState().deleteFlightWithAttemptCleanup("flight-1");

    expect(mocks.assignToFlight).toHaveBeenCalledWith("issue-1", null);
    expect(mocks.assignToFlight).toHaveBeenCalledWith("issue-2", null);
  });

  it("removes the cooperative integration worktree, which no attempt cleanup can reach", async () => {
    seed(
      flight({
        executionMode: "cooperative",
        integrationBranch: INTEGRATION,
        attempts: [attempt({ id: "a-run", status: "running" })],
      }),
    );

    const failures = await useAsyncFlightStore
      .getState()
      .deleteFlightWithAttemptCleanup("flight-1");

    expect(failures).toEqual([]);
    expect(mocks.cleanupFlightIntegrationWorktree).toHaveBeenCalledTimes(1);
    expect(mocks.cleanupFlightIntegrationWorktree).toHaveBeenCalledWith({
      flightId: "flight-1",
      // Derived from the prepared worktree path, not guessed from projectPath.
      basePath: "D:/Repo",
      serverId: null,
      // Safe `-d` on the Rust side: unmerged integration work is kept.
      deleteBranch: true,
    });
  });

  it("passes the saved server id for a remote integration worktree", async () => {
    seed(
      flight({
        executionMode: "cooperative",
        integrationBranch: {
          ...INTEGRATION,
          worktreePath: "/srv/repo/.pkt-flight-integrations/flight-1",
          targetKind: "ssh",
          targetId: "server-1",
        },
      }),
    );

    await useAsyncFlightStore.getState().deleteFlightWithAttemptCleanup("flight-1");

    expect(mocks.cleanupFlightIntegrationWorktree).toHaveBeenCalledWith(
      expect.objectContaining({ basePath: "/srv/repo", serverId: "server-1" }),
    );
  });

  it("reports an integration worktree that could not be removed", async () => {
    mocks.cleanupFlightIntegrationWorktree.mockResolvedValue(
      outcome({
        worktreePath: INTEGRATION.worktreePath,
        branch: INTEGRATION.branch,
        removed: false,
        error: "git worktree remove failed (exit 128): locked",
      }),
    );
    seed(flight({ executionMode: "cooperative", integrationBranch: INTEGRATION }));

    const failures = await useAsyncFlightStore
      .getState()
      .deleteFlightWithAttemptCleanup("flight-1");

    expect(useFlightStore.getState().flights).toEqual([]);
    expect(failures).toHaveLength(1);
    expect(failures[0].branch).toBe("packetbench/flight/flight-1");
    expect(failures[0].attemptId).toBe("");
    expect(failures[0].message).toContain(INTEGRATION.worktreePath);
    expect(failures[0].message).toContain("locked");
  });

  it("still deletes the flight when the integration cleanup command throws", async () => {
    mocks.cleanupFlightIntegrationWorktree.mockRejectedValue(new Error("ssh down"));
    seed(flight({ executionMode: "cooperative", integrationBranch: INTEGRATION }));

    const failures = await useAsyncFlightStore
      .getState()
      .deleteFlightWithAttemptCleanup("flight-1");

    expect(useFlightStore.getState().flights).toEqual([]);
    expect(failures).toHaveLength(1);
    expect(failures[0].message).toContain("ssh down");
  });

  it("does not call integration cleanup for a flight that never prepared one", async () => {
    seed(flight({ attempts: [attempt({ status: "running" })] }));

    await useAsyncFlightStore.getState().deleteFlightWithAttemptCleanup("flight-1");

    expect(mocks.cleanupFlightIntegrationWorktree).not.toHaveBeenCalled();
  });

  it("does not mint flight-completion memory from a delete", async () => {
    // Cancelling the last attempt normally settles the flight and captures a
    // `flight_completed` memory event. A delete is a discard, not a landing.
    seed(
      flight({
        attempts: [
          attempt({ id: "a-done", status: "completed" }),
          attempt({ id: "a-run", status: "running" }),
        ],
      }),
    );

    await useAsyncFlightStore.getState().deleteFlightWithAttemptCleanup("flight-1");

    expect(mocks.captureFlightCompleted).not.toHaveBeenCalled();
    expect(mocks.adjustConfidenceForFlight).not.toHaveBeenCalled();
  });
});

describe("inspectFlightDeleteImpact", () => {
  it("includes retained terminal work in the destructive delete warning", async () => {
    mocks.getGitStatus.mockResolvedValue("?? kept.txt");
    seed(
      flight({
        attempts: [
          attempt({
            id: "stopped-work",
            status: "cancelled",
            recovery: { state: "retained", reason: "Stopped", retainedAt: 1 },
          }),
        ],
      }),
    );
    const impact = await inspectFlightDeleteImpact("flight-1");
    expect(impact).toMatchObject({ attemptCount: 1, worktreeCount: 1, dirtyCount: 1 });
    expect(impact.entries[0]).toMatchObject({
      attemptId: "stopped-work",
      status: "cancelled",
      cleanliness: "dirty",
    });
    expect(
      describeFlightDeleteImpact(impact).some((line) =>
        line.includes("uncommitted changes that will be lost"),
      ),
    ).toBe(true);
  });

  it("counts non-terminal attempts and dirty-checks each worktree", async () => {
    mocks.getGitStatus.mockImplementation(async (path: string) =>
      path.endsWith("a-dirty") ? " M src/foo.ts\n?? new.txt" : "",
    );
    seed(
      flight({
        attempts: [
          attempt({ id: "a-clean", status: "running" }),
          attempt({ id: "a-dirty", status: "reviewing" }),
          attempt({ id: "a-done", status: "completed" }),
        ],
      }),
    );

    const impact = await inspectFlightDeleteImpact("flight-1");

    expect(impact.attemptCount).toBe(2);
    expect(impact.worktreeCount).toBe(2);
    expect(impact.dirtyCount).toBe(1);
    expect(impact.unknownCount).toBe(0);
    expect(impact.entries.find((e) => e.attemptId === "a-dirty")?.cleanliness).toBe("dirty");
    expect(impact.entries.find((e) => e.attemptId === "a-clean")?.cleanliness).toBe("clean");
  });

  it("dirty-checks SSH worktrees over the saved server", async () => {
    mocks.getGitStatusRemote.mockResolvedValue(" M src/remote.ts");
    seed(flight({ attempts: [sshAttempt({ status: "running" })] }));

    const impact = await inspectFlightDeleteImpact("flight-1");

    expect(mocks.getGitStatusRemote).toHaveBeenCalledWith(
      { id: "server-1" },
      "/srv/repo/.git/packetbench-worktrees/att-ssh",
    );
    expect(impact.dirtyCount).toBe(1);
  });

  it("reports an unreadable worktree as unknown rather than clean", async () => {
    mocks.getGitStatus.mockRejectedValue(new Error("not a git repository"));
    seed(flight({ attempts: [attempt({ status: "provisioning" })] }));

    const impact = await inspectFlightDeleteImpact("flight-1");

    expect(impact.unknownCount).toBe(1);
    expect(impact.dirtyCount).toBe(0);
  });

  it("dirty-checks the cooperative integration worktree too", async () => {
    mocks.getGitStatus.mockImplementation(async (path: string) =>
      path.includes("flight-integrations") ? " M src/merged.ts" : "",
    );
    seed(
      flight({
        executionMode: "cooperative",
        integrationBranch: INTEGRATION,
        attempts: [attempt({ status: "running" })],
      }),
    );

    const impact = await inspectFlightDeleteImpact("flight-1");

    // Counted separately: it is not attempt-keyed.
    expect(impact.attemptCount).toBe(1);
    expect(impact.dirtyCount).toBe(0);
    expect(impact.integration).toEqual({
      branch: "packetbench/flight/flight-1",
      worktreePath: INTEGRATION.worktreePath,
      cleanliness: "dirty",
    });
    const lines = describeFlightDeleteImpact(impact);
    expect(lines.some((line) => line.includes("cooperative integration worktree"))).toBe(true);
    expect(lines.some((line) => line.includes("uncommitted changes that will be lost"))).toBe(true);
  });

  it("returns an empty impact for an unknown flight", async () => {
    await expect(inspectFlightDeleteImpact("nope")).resolves.toEqual(
      summarizeFlightDeleteImpact([]),
    );
  });
});

describe("describeFlightDeleteImpact", () => {
  it("says it is still checking while the probe is in flight", () => {
    expect(describeFlightDeleteImpact(null)).toEqual([
      "Checking this flight's attempts for uncommitted work…",
    ]);
  });

  it("warns about nothing when there is no live work", () => {
    expect(describeFlightDeleteImpact(summarizeFlightDeleteImpact([]))).toEqual([]);
  });

  it("names the attempt count, the worktree count and the dirty branches", () => {
    const lines = describeFlightDeleteImpact(
      summarizeFlightDeleteImpact([
        {
          attemptId: "a1",
          branch: "packetbench/a1",
          status: "running",
          worktreePath: "/w/a1",
          cleanliness: "dirty",
        },
        {
          attemptId: "a2",
          branch: "packetbench/a2",
          status: "running",
          worktreePath: "/w/a2",
          cleanliness: "clean",
        },
        {
          attemptId: "a3",
          branch: "packetbench/a3",
          status: "reviewing",
          worktreePath: "/w/a3",
          cleanliness: "unknown",
        },
      ]),
    );

    expect(lines[0]).toBe("3 attempts will be cancelled (2 running, 1 reviewing).");
    expect(lines[1]).toBe("3 git worktrees will be removed.");
    expect(lines[2]).toBe("1 worktree has uncommitted changes that will be lost: packetbench/a1.");
    expect(lines[3]).toBe("1 worktree could not be checked for uncommitted changes.");
  });

  it("names the integration worktree even when no attempt is live", () => {
    const lines = describeFlightDeleteImpact(
      summarizeFlightDeleteImpact([], {
        branch: "packetbench/flight/flight-1",
        worktreePath: "/repo/.pkt-flight-integrations/flight-1",
        cleanliness: "clean",
      }),
    );

    expect(lines).toEqual([
      "The cooperative integration worktree (packetbench/flight/flight-1) will be removed; the branch is kept if it still holds unlanded work.",
    ]);
  });

  it("reads correctly for a single attempt", () => {
    const lines = describeFlightDeleteImpact(
      summarizeFlightDeleteImpact([
        {
          attemptId: "a1",
          branch: "packetbench/a1",
          status: "queued",
          worktreePath: "/w/a1",
          cleanliness: "clean",
        },
      ]),
    );

    expect(lines).toEqual([
      "1 attempt will be cancelled (1 queued).",
      "1 git worktree will be removed.",
    ]);
  });
});
