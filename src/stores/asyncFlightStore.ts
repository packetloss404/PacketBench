import { create } from "zustand";
import {
  launchFlightAsync,
  cancelFlightAttempt,
  cleanupAttemptWorktreeSsh,
  cleanupFlightIntegrationWorktree,
  worktreeCleanupNeedsAttention,
  type WorktreeCleanupOutcome,
  getGitStatus,
  getGitStatusRemote,
  markAttemptStatus,
  mergeConversationBranch,
  setAttemptDraftPr,
  summarizeFlight,
  gitPushRemote,
  integrateFlightAttempt,
  landFlightIntegration,
  prepareFlightIntegrationBranch,
  toGitServerConfigInput,
  type AttemptTargetSpec,
} from "@/lib/tauri";
import { isWorktreeDirty } from "@/lib/worktreeLifecycle";
import {
  buildFlightSummaryInput,
  buildAttemptSessionLogs,
  parseFlightRetrospective,
} from "@/lib/flightRetrospective";
import { publishBranchAsPr } from "@/lib/gitPublish";
import { useFlightStore } from "@/stores/flightStore";
import {
  useAgentTaskStore,
  type AgentCli,
  type CreateApiConversationOptions,
} from "@/stores/agentTaskStore";
import { useServerStore } from "@/stores/serverStore";
import { useWorkspaceStore } from "@/stores/workspaceStore";
import { useGitHubStore } from "@/stores/githubStore";
import { assertCostGuardrailsAllowLaunch } from "@/stores/costGuardrailStore";
import { useMemoryStore, type MemoryBriefScope } from "@/stores/memoryStore";
import { memoryScopeForWorkspace } from "@/lib/memoryWriteScope";
import { getMemorySettings } from "@/stores/memorySettingsStore";
import type { FlightCompletedPayload } from "@/types/memory";
import type { Attempt, AttemptStatus, Flight } from "@/types/flight";
import { claimedPathsOverlap, normalizeClaimedPath } from "@/lib/pathCollisions";
import {
  detachAttemptTerminalListeners,
  syncAsyncAttemptTerminalListeners,
} from "@/stores/asyncAttemptTerminalListeners";
import { maybeEscalate, recordAttemptFailure } from "@/lib/flightCoordination";
import { getDefaultModel, getProviderForAgent } from "@/lib/api-models";
import { attemptProviderFor } from "@/lib/attemptRouting";
import type { ServerConfig } from "@/types/server";
import { reviewerGateAllowsAcceptance } from "@/lib/reviewerGate";
import {
  overrideReviewGate,
  retryReviewGate,
  sendReviewFindingsToBuilder,
} from "@/stores/reviewerGateRuntime";
import {
  buildCooperativeTaskPrompt,
  selectReadyCooperativeTasks,
  validateCooperativeAssignments,
  validateCooperativeGraph,
} from "@/lib/cooperativeFlight";
import type { Task } from "@/types/flight";
import { APP_NAME } from "@/lib/brand";

export interface AsyncLaunchOptions {
  allowPathCollisions?: boolean;
}

export type AsyncLaunchPathCollision =
  | {
      kind: "duplicate_target";
      path: string;
      message: string;
    }
  | {
      kind: "active_attempt";
      path: string;
      message: string;
      flightId: string;
      attemptId: string;
    }
  | {
      kind: "task_owned_path";
      path: string;
      message: string;
      flightId: string;
      taskId: string;
      otherTaskId: string;
    };

// === Flight deletion fan-out ===
//
// Deleting a Flight used to abandon its attempts: the API sessions kept
// running and their git worktrees stayed on disk (or on the SSH host) with
// nothing left in the UI pointing at them. Delete now cancels that work
// first, and the confirm names what is about to be destroyed.

/** Attempt statuses that already released their session and worktree. */
const TERMINAL_ATTEMPT_STATUSES: ReadonlySet<AttemptStatus> = new Set([
  "completed",
  "failed",
  "cancelled",
]);

/**
 * Attempts that still own live resources. `reviewing` counts: the agent has
 * stopped, but the backend only tears the worktree down on a *terminal*
 * transition, so a reviewing attempt's worktree is still on disk.
 */
export function attemptsNeedingCleanup(flight: Flight | undefined): Attempt[] {
  return (flight?.attempts ?? []).filter(
    (attempt) => !TERMINAL_ATTEMPT_STATUSES.has(attempt.status),
  );
}

/** `unknown` = the probe could not run (worktree not provisioned yet, host
 *  unreachable, server record gone). Treated as "may hold uncommitted work". */
export type AttemptWorktreeCleanliness = "clean" | "dirty" | "unknown";

export interface FlightDeleteImpactEntry {
  attemptId: string;
  branch: string;
  status: AttemptStatus;
  worktreePath: string;
  cleanliness: AttemptWorktreeCleanliness;
}

/** The cooperative integration worktree a delete will also remove. */
export interface FlightDeleteIntegrationImpact {
  branch: string;
  worktreePath: string;
  cleanliness: AttemptWorktreeCleanliness;
}

export interface FlightDeleteImpact {
  entries: FlightDeleteImpactEntry[];
  /** Non-terminal attempts that will be cancelled. */
  attemptCount: number;
  /** Worktrees that will be removed — one per cancelled attempt. */
  worktreeCount: number;
  dirtyCount: number;
  unknownCount: number;
  /**
   * Present on cooperative Flights that prepared an integration branch. It is
   * counted separately from `worktreeCount` because it is not attempt-keyed —
   * it belongs to the Flight itself.
   */
  integration?: FlightDeleteIntegrationImpact;
}

/** One attempt whose teardown did not fully succeed. The Flight is deleted
 *  regardless; this is what the UI reports so nothing is lost silently.
 *  The flight-level integration worktree reports here too, with an empty
 *  `attemptId` and the integration branch. */
export interface FlightCleanupFailure {
  attemptId: string;
  branch: string;
  message: string;
}

/**
 * Turn a reported worktree teardown into a user-facing failure line, or null
 * when the teardown actually succeeded. This is the bridge that closes the
 * old hole: Rust reports removal failures as data instead of `warn!`-logging
 * them, and every reported failure lands in the delete toast.
 */
export function describeCleanupOutcome(
  outcome: WorktreeCleanupOutcome | null | undefined,
  what: string,
): string | null {
  if (!outcome || !worktreeCleanupNeedsAttention(outcome)) return null;
  if (outcome.deferred) {
    return `${what} ${outcome.worktreePath} was left in place — its SSH server is no longer configured.`;
  }
  const reason = outcome.error ?? "the removal did not complete";
  return `${what} ${outcome.worktreePath} could not be removed: ${reason}`;
}

interface AsyncFlightStore {
  /** Launch N parallel attempts on a Flight. Persists Attempts on the Flight. */
  launchAsync: (
    flightId: string,
    prompt: string,
    targets: AttemptTargetSpec[],
    options?: AsyncLaunchOptions,
  ) => Promise<Attempt[]>;

  /**
   * Cancel a single attempt: closes the API session, removes worktree, marks
   * Cancelled.
   *
   * Resolves to a user-facing description of anything the teardown left
   * behind, or null when the worktree is really gone. The backend used to
   * `warn!` a failed `git worktree remove` and return success, so a stuck
   * worktree was indistinguishable from a clean cancel.
   */
  cancelAttempt: (flightId: string, attemptId: string) => Promise<string | null>;

  /**
   * Delete a Flight and take its live work down with it: every non-terminal
   * attempt is cancelled through the normal cancel path (session closed,
   * worktree removed), and the cooperative integration worktree — which is
   * flight-keyed and therefore unreachable from any attempt command — is
   * removed too, before the Flight record is dropped.
   *
   * Best-effort by contract — the delete ALWAYS happens. Per-attempt cleanup
   * failures are collected and returned so the caller can surface them
   * instead of the app silently leaking a session or a worktree.
   */
  deleteFlightWithAttemptCleanup: (flightId: string) => Promise<FlightCleanupFailure[]>;

  /** Set an attempt's status from the UI (e.g. user clicks Accept/Reject). */
  setAttemptStatus: (
    flightId: string,
    attemptId: string,
    status: Extract<AttemptStatus, "reviewing" | "completed" | "failed" | "cancelled">,
  ) => Promise<void>;

  /**
   * E4: relaunch a failed attempt on a different agent. Rebuilds a launch
   * target from the failed attempt (same repo/branch, the new agent's default
   * model), records a `handoff` coordination event, and appends a fresh attempt
   * via `launchAsync`. The failed record is kept for history.
   */
  reassignAttempt: (flightId: string, attemptId: string, newAgentConfigId: string) => Promise<void>;

  /**
   * F2: land an accepted attempt's branch into the base checkout by
   * squash-merging it, reusing the same `merge_conversation_branch` command the
   * Agents worktree bar uses. Safe to run after acceptance: the accept path
   * removes the worktree but keeps `pkt/<attemptId>`, and the Rust side treats
   * an absent worktree as clean. Rejects the merge when the base checkout is
   * dirty or the merge conflicts, leaving both trees untouched.
   */
  landAttempt: (flightId: string, attemptId: string) => Promise<AttemptLandResult>;

  /**
   * F2: open a draft PR for an attempt's branch on demand, rather than only via
   * the pre-launch "publish attempts as draft PRs" checkbox. Same pipeline the
   * automatic publish uses, so the PR number lands on `Attempt.draftPrNumber`.
   */
  publishAttemptPr: (flightId: string, attemptId: string) => Promise<void>;

  retryReviewGate: (flightId: string, attemptId: string) => Promise<void>;
  overrideReviewGate: (flightId: string, attemptId: string, reason: string) => Promise<void>;
  sendReviewFindingsToBuilder: (flightId: string, attemptId: string) => Promise<void>;
  prepareCooperativeFlight: (flightId: string) => Promise<void>;
  launchReadyTasks: (flightId: string, taskIds?: string[]) => Promise<void>;
  landCooperativeFlight: (flightId: string) => Promise<void>;
}

/**
 * E4 (pure): build a launch target from a failed attempt, swapping in a new
 * agent + its default model, reusing the attempt's repo base / branch. SSH
 * targets are reconstructed from the saved `ServerConfig` (the Attempt record
 * intentionally doesn't persist connection details); returns `null` when that
 * server is no longer configured.
 */
export function buildReassignSpec(
  failed: Attempt,
  newAgentConfigId: string,
  lookupServer: (id: string) => ServerConfig | undefined,
): AttemptTargetSpec | null {
  // Canonical `get_provider` id via the shared map — never a prefix-strip;
  // `api-claude` is `anthropic`, not `claude` (see `attemptProviderFor`).
  const provider = attemptProviderFor(newAgentConfigId);
  const model = (failed.agentConfigId === newAgentConfigId ? failed.model?.trim() : "") || getDefaultModel(newAgentConfigId as AgentCli);
  if (!model) throw new Error("Select this provider and a model in the Flight launch dialog before retrying.");
  if (failed.target.kind === "local") {
    return {
      kind: "local",
      basePath: failed.target.basePath,
      baseBranch: failed.baseBranch,
      agentConfigId: newAgentConfigId,
      provider,
      model,
    };
  }
  const server = lookupServer(failed.target.serverId);
  if (!server) return null;
  return {
    kind: "ssh",
    targetId: server.id,
    host: server.host,
    port: server.port,
    user: server.username,
    keyPath: server.keyPath ?? null,
    authMethod: server.authMethod,
    hostFingerprint: server.hostFingerprint ?? null,
    basePath: failed.target.basePath,
    baseBranch: failed.baseBranch,
    agentConfigId: newAgentConfigId,
    provider,
    model,
  };
}

function applyAttemptsToFlightLocal(flightId: string, attempts: Attempt[], prompt: string) {
  useFlightStore.setState((state) => ({
    flights: state.flights.map((flight) => {
      if (flight.id !== flightId) return flight;
      const attemptsById = new Map((flight.attempts ?? []).map((attempt) => [attempt.id, attempt]));
      for (const attempt of attempts) {
        attemptsById.set(attempt.id, attempt);
      }
      return {
        ...flight,
        attempts: Array.from(attemptsById.values()),
        prompt: flight.prompt ?? prompt,
        updatedAt: Date.now(),
      };
    }),
  }));
}

function patchAttempt(flightId: string, attemptId: string, patch: Partial<Attempt>) {
  const flight = useFlightStore.getState().flights.find((f) => f.id === flightId);
  if (!flight || !flight.attempts) return;
  const next = flight.attempts.map((a) => (a.id === attemptId ? { ...a, ...patch } : a));
  useFlightStore.getState().updateFlight(flightId, { attempts: next });
}

function patchTask(flightId: string, taskId: string, patch: Partial<Task>) {
  const flight = useFlightStore.getState().flights.find((candidate) => candidate.id === flightId);
  if (!flight) return;
  useFlightStore.getState().updateFlight(flightId, {
    milestones: flight.milestones.map((milestone) => ({
      ...milestone,
      tasks: milestone.tasks.map((task) => (task.id === taskId ? { ...task, ...patch } : task)),
    })),
  });
}

function cooperativeTarget(flight: Flight): {
  projectPath: string;
  server?: ServerConfig;
} {
  const workspace = flight.workspaceId
    ? useWorkspaceStore
        .getState()
        .workspaces.find((candidate) => candidate.id === flight.workspaceId)
    : undefined;
  if (!workspace?.serverId) return { projectPath: flight.projectPath };
  const server = useServerStore.getState().getServer(workspace.serverId);
  if (!server) throw new Error("The cooperative Flight's SSH server is no longer configured.");
  if (!server.hostFingerprint) {
    throw new Error("Verify and pin the cooperative Flight's SSH host key before launching.");
  }
  return {
    projectPath: workspace.remoteProjectPath || flight.projectPath,
    server,
  };
}

async function ensureCooperativeIntegration(flightId: string): Promise<Flight> {
  const flight = useFlightStore.getState().flights.find((candidate) => candidate.id === flightId);
  if (!flight) throw new Error(`Flight '${flightId}' was not found.`);
  if (flight.integrationBranch?.status === "ready") return flight;
  const target = cooperativeTarget(flight);
  const baseBranch = flight.gitBranch || "main";
  const prepared = await prepareFlightIntegrationBranch(
    target.projectPath,
    flight.id,
    baseBranch,
    target.server ? toGitServerConfigInput(target.server) : null,
  );
  useFlightStore.getState().updateFlight(flight.id, {
    executionMode: "cooperative",
    integrationBranch: {
      ...prepared,
      targetKind: target.server ? "ssh" : "local",
      targetId: target.server?.id,
      status: "ready",
      conflictFiles: [],
    },
  });
  await useFlightStore.getState().flushPersistence();
  return useFlightStore.getState().flights.find((candidate) => candidate.id === flightId) ?? flight;
}

async function integrateCooperativeAttempt(flight: Flight, attempt: Attempt): Promise<void> {
  if (!attempt.taskId) return;
  const integration = flight.integrationBranch;
  if (!integration) throw new Error("Prepare the Flight integration branch before acceptance.");
  const gate = reviewerGateAllowsAcceptance(flight, attempt);
  if (!gate.allowed) throw new Error(gate.reason);
  const server =
    integration.targetKind === "ssh" && integration.targetId
      ? useServerStore.getState().getServer(integration.targetId)
      : undefined;
  if (integration.targetKind === "ssh" && !server) {
    throw new Error("The integration SSH server is no longer configured.");
  }
  useFlightStore.getState().updateFlight(flight.id, {
    integrationBranch: {
      ...integration,
      status: "integrating",
      errorMessage: undefined,
      conflictFiles: [],
    },
  });
  try {
    const result = await integrateFlightAttempt({
      integrationPath: integration.worktreePath,
      integrationBranch: integration.branch,
      attemptPath: attempt.target.worktreePath,
      attemptBranch: attempt.branch,
      serverConfig: server ? toGitServerConfigInput(server) : null,
    });
    if (result.conflictFiles.length > 0) {
      patchTask(flight.id, attempt.taskId, {
        status: "blocked",
        blockedReason: `Integration conflict: ${result.conflictFiles.join(", ")}`,
      });
      useFlightStore.getState().updateFlight(flight.id, {
        status: "paused",
        integrationBranch: {
          ...integration,
          headSha: result.headSha,
          status: "needs_attention",
          errorMessage: "Task integration conflicted and was aborted.",
          conflictFiles: result.conflictFiles,
        },
      });
      useFlightStore.getState().appendCoordinationEvent(flight.id, {
        type: "collision_warning",
        taskId: attempt.taskId,
        agentId: attempt.agentConfigId,
        summary: `Integration conflict stopped the cooperative path: ${result.conflictFiles.join(", ")}.`,
        metadata: {
          attemptId: attempt.id,
          conflictFiles: result.conflictFiles.join(","),
        },
      });
      await useFlightStore.getState().flushPersistence();
      throw new Error("Integration conflict requires attention before this task can be accepted.");
    }
    patchTask(flight.id, attempt.taskId, {
      status: "done",
      completedAt: Date.now(),
      blockedReason: undefined,
    });
    const latest = useFlightStore
      .getState()
      .flights.find((candidate) => candidate.id === flight.id);
    useFlightStore.getState().updateFlight(flight.id, {
      status: "active",
      integrationBranch: {
        ...(latest?.integrationBranch ?? integration),
        headSha: result.headSha,
        status: "ready",
        errorMessage: undefined,
        conflictFiles: [],
      },
    });
    useFlightStore.getState().appendCoordinationEvent(flight.id, {
      type: "task_completed",
      taskId: attempt.taskId,
      agentId: attempt.agentConfigId,
      summary: "Accepted and integrated the cooperative task branch.",
      metadata: { attemptId: attempt.id, integrationHead: result.headSha },
    });
    await useFlightStore.getState().flushPersistence();
  } catch (error) {
    const current = useFlightStore
      .getState()
      .flights.find((candidate) => candidate.id === flight.id)?.integrationBranch;
    if (current?.status !== "needs_attention") {
      useFlightStore.getState().updateFlight(flight.id, {
        integrationBranch: {
          ...(current ?? integration),
          status: "needs_attention",
          errorMessage: error instanceof Error ? error.message : String(error),
        },
      });
    }
    throw error;
  }
}

/**
 * Where to run the branch push from. A terminal attempt has already had its
 * worktree force-removed by `mark_attempt_status`, but the `pkt/<attemptId>`
 * branch survives in the base repo (Rust passes `delete_branch: false`), so a
 * post-hoc publish pushes from the base checkout instead. Non-terminal
 * attempts keep pushing from the worktree exactly as before.
 */
export function attemptPushPath(attempt: Attempt): string {
  return TERMINAL_ATTEMPT_STATUSES.has(attempt.status)
    ? attempt.target.basePath
    : attempt.target.worktreePath;
}

/**
 * v0.8-G: post-attempt publish pipeline. Called only for attempts on
 * Flights with `publishAttemptsAsPrs == true` that finish in a clean
 * state. Pushes the attempt's worktree branch to `origin`, opens a
 * draft PR with the flight objective as the body, and records the
 * resulting PR number on the attempt.
 *
 * Errors are intentionally swallowed (warn-logged + written into
 * `errorMessage`) so a flaky publish never knocks the attempt itself
 * out of its earned terminal status.
 */
async function publishAttemptAsDraftPr(flight: Flight, attempt: Attempt): Promise<void> {
  // Resolve the GitHub repo target from the user's currently-selected
  // repo. The PRModal already uses this same source-of-truth; for
  // async-Flight publish we follow the same UX contract.
  const selectedRepo = useGitHubStore.getState().config.selectedRepo;
  if (!selectedRepo) {
    console.warn(
      "publishAttemptAsDraftPr: no GitHub repo selected; skipping for attempt",
      attempt.id,
    );
    patchAttempt(flight.id, attempt.id, {
      errorMessage:
        "Draft-PR publish skipped: no GitHub repo selected. Connect a repo in the GitHub pane to enable publishing.",
    });
    return;
  }

  // GP5: pick the push transport. Local pushes from the app's checkout; SSH
  // pushes from the remote worktree host (`git_push_remote`) so origin has the
  // branch before we open the PR via the GitHub API — no remote `gh` needed.
  // NOTE: this assumes the remote worktree's `origin` resolves to the same repo
  // the GitHub pane has selected. If a user points the SSH host's origin at a
  // different repo/host than `selectedRepo`, the push lands on one repo and the
  // PR create runs against another (surfaced as a push/create-stage error, not
  // silent). Cross-repo publish is out of scope for GP5.
  const worktreePath = attemptPushPath(attempt);
  let remotePush: (() => Promise<void>) | undefined;
  if (attempt.target.kind === "ssh") {
    const server = useServerStore.getState().getServer(attempt.target.serverId);
    if (!server) {
      patchAttempt(flight.id, attempt.id, {
        errorMessage: "Draft-PR publish skipped: the SSH server for this attempt no longer exists.",
      });
      return;
    }
    // Use the shared converter so hostFingerprint is always forwarded (avoids a
    // silent TOFU downgrade) — don't hand-roll the shape here.
    const serverConfig = toGitServerConfigInput(server);
    remotePush = async () => {
      await gitPushRemote(serverConfig, worktreePath);
    };
  }

  const branchName = attempt.branch;
  const baseBranch = attempt.baseBranch || "main";

  // 1–3. Build the PR body from the flight objective / prompt (capped at the
  //   PR-body size GitHub accepts, ~65 KiB, so we never trip a 422), then push
  //   the branch + open the draft PR through the shared publish path
  //   (`gitPublish.publishBranchAsPr`). Errors are classified by stage and
  //   surfaced onto the attempt with the same copy as before (behavior-
  //   preserving extraction — flights and sessions call the same path now).
  let body = flight.objective || flight.prompt || "";
  body = body.slice(0, 60_000);
  body = `Auto-generated from ${APP_NAME} Flight \`${flight.id}\` attempt \`${attempt.id}\`.\n\n${body}`;

  const title = `[Flight ${flight.title}] Attempt ${attempt.id}`.slice(0, 256);

  const result = await publishBranchAsPr({
    worktreePath,
    branch: branchName,
    baseBranch,
    owner: selectedRepo.owner,
    repo: selectedRepo.repo,
    title,
    body,
    draft: true,
    remotePush,
  });

  if (!result.ok) {
    if (result.stage === "push") {
      console.warn("publishAttemptAsDraftPr: push failed for", attempt.id, result.message);
      patchAttempt(flight.id, attempt.id, {
        errorMessage: `Draft-PR publish: branch push failed — ${result.message}`,
      });
    } else {
      console.warn("publishAttemptAsDraftPr: create_pr failed for", attempt.id, result.message);
      patchAttempt(flight.id, attempt.id, {
        errorMessage: `Draft-PR publish: GitHub create_pr failed — ${result.message}`,
      });
    }
    return;
  }

  const prNumber = result.prNumber;

  if (prNumber == null) {
    console.warn(
      "publishAttemptAsDraftPr: create_pr succeeded but did not return a PR number",
      attempt.id,
    );
    return;
  }

  // 4. Record the PR number on the attempt + persist.
  //
  // v0.8 race-fix: roll back the optimistic in-memory write if the backend
  // persist fails. Without the rollback, the store would still claim the
  // PR was set; on app restart the publish guard (`!attempt.draftPrNumber`)
  // would re-publish a fresh duplicate PR.
  patchAttempt(flight.id, attempt.id, { draftPrNumber: prNumber });
  try {
    await setAttemptDraftPr(flight.id, attempt.id, prNumber);
  } catch (err) {
    const msg = typeof err === "string" ? err : ((err as Error)?.message ?? "unknown error");
    console.warn("publishAttemptAsDraftPr: failed to persist draft PR number", attempt.id, err);
    patchAttempt(flight.id, attempt.id, {
      draftPrNumber: undefined,
      errorMessage: `Failed to persist draft PR #${prNumber}: ${msg}`,
    });
  }
}

// Module-level map tracking attempts currently mid-publish. Publishing must
// finish before the backend marks an attempt completed because that terminal
// transition removes the local worktree. The map also deduplicates concurrent
// completion clicks before either call records the resulting PR number.
const publishingAttempts = new Map<string, Promise<void>>();
const ACTIVE_ATTEMPT_STATUSES: ReadonlySet<AttemptStatus> = new Set([
  "queued",
  "provisioning",
  "running",
]);

type ClaimRoot = {
  scope: string;
  path: string;
  displayPath: string;
  branch: string;
  caseSensitive: boolean;
};

function targetClaimRoot(target: AttemptTargetSpec): ClaimRoot | null {
  const caseSensitive = target.kind === "ssh";
  const path = normalizeClaimedPath(target.basePath, { caseSensitive });
  if (!path) return null;
  const branch = target.baseBranch.trim().toLowerCase() || "main";
  if (target.kind === "local") {
    return {
      scope: "local",
      path,
      displayPath: target.basePath,
      branch,
      caseSensitive,
    };
  }
  return {
    scope: `ssh:${target.targetId || `${target.user}@${target.host}:${target.port}`}`,
    path,
    displayPath: `${target.targetId || target.host}:${target.basePath}`,
    branch,
    caseSensitive,
  };
}

function attemptClaimRoot(attempt: Attempt): ClaimRoot | null {
  const caseSensitive = attempt.target.kind === "ssh";
  const path = normalizeClaimedPath(attempt.target.basePath, { caseSensitive });
  if (!path) return null;
  const branch = attempt.baseBranch.trim().toLowerCase() || "main";
  if (attempt.target.kind === "local") {
    return {
      scope: "local",
      path,
      displayPath: attempt.target.basePath,
      branch,
      caseSensitive,
    };
  }
  return {
    scope: `ssh:${attempt.target.serverId}`,
    path,
    displayPath: `${attempt.target.serverId}:${attempt.target.basePath}`,
    branch,
    caseSensitive,
  };
}

function claimRootsOverlap(left: ClaimRoot, right: ClaimRoot): boolean {
  return (
    left.scope === right.scope &&
    left.branch === right.branch &&
    claimedPathsOverlap(left.path, right.path, {
      caseSensitive: left.caseSensitive || right.caseSensitive,
    })
  );
}

function getFlightTasks(flight: Flight) {
  return flight.milestones.flatMap((milestone) => milestone.tasks);
}

export function findAsyncLaunchPathCollisions(
  flightId: string | null,
  targets: AttemptTargetSpec[],
  flights = useFlightStore.getState().flights,
): AsyncLaunchPathCollision[] {
  const collisions: AsyncLaunchPathCollision[] = [];
  const targetRoots = targets
    .map((target, index) => ({ index, root: targetClaimRoot(target) }))
    .filter((entry): entry is { index: number; root: ClaimRoot } => Boolean(entry.root));

  for (let i = 0; i < targetRoots.length; i += 1) {
    for (let j = i + 1; j < targetRoots.length; j += 1) {
      const left = targetRoots[i];
      const right = targetRoots[j];
      if (!claimRootsOverlap(left.root, right.root)) continue;
      collisions.push({
        kind: "duplicate_target",
        path: left.root.displayPath,
        message: `Selected targets ${left.index + 1} and ${right.index + 1} both claim ${left.root.displayPath} on ${left.root.branch}.`,
      });
    }
  }

  for (const flight of flights) {
    for (const attempt of flight.attempts ?? []) {
      if (!ACTIVE_ATTEMPT_STATUSES.has(attempt.status)) continue;
      const existingRoot = attemptClaimRoot(attempt);
      if (!existingRoot) continue;
      for (const { root } of targetRoots) {
        if (!claimRootsOverlap(root, existingRoot)) continue;
        collisions.push({
          kind: "active_attempt",
          path: root.displayPath,
          flightId: flight.id,
          attemptId: attempt.id,
          message: `Attempt ${attempt.id} is already ${attempt.status} on ${existingRoot.displayPath} (${existingRoot.branch}).`,
        });
      }
    }
  }

  if (flightId) {
    const flight = flights.find((entry) => entry.id === flightId);
    const activeTasks = flight
      ? getFlightTasks(flight).filter(
          (task) =>
            (task.status === "queued" || task.status === "running") &&
            (task.ownedPaths?.length ?? 0) > 0,
        )
      : [];
    for (let i = 0; i < activeTasks.length; i += 1) {
      for (let j = i + 1; j < activeTasks.length; j += 1) {
        const left = activeTasks[i];
        const right = activeTasks[j];
        for (const leftPath of left.ownedPaths ?? []) {
          const rightPath = (right.ownedPaths ?? []).find((path) =>
            claimedPathsOverlap(leftPath, path),
          );
          if (!rightPath) continue;
          collisions.push({
            kind: "task_owned_path",
            path: leftPath,
            flightId,
            taskId: left.id,
            otherTaskId: right.id,
            message: `Task "${left.title}" and "${right.title}" both claim ${leftPath} / ${rightPath}.`,
          });
        }
      }
    }
  }

  return collisions;
}

export function formatAsyncLaunchPathCollisionMessage(
  collisions: AsyncLaunchPathCollision[],
): string {
  const preview = collisions
    .slice(0, 5)
    .map((collision) => `- ${collision.message}`)
    .join("\n");
  const more = collisions.length > 5 ? `\n- ${collisions.length - 5} more conflict(s)` : "";
  return [
    "Async Flight launch blocked because active executor work already claims the same path.",
    preview + more,
    "Cancel, complete, or block/serialize the conflicting work before launching.",
  ].join("\n");
}

export function assertAsyncLaunchPathGate(
  flightId: string | null,
  targets: AttemptTargetSpec[],
  options: AsyncLaunchOptions = {},
): void {
  if (options.allowPathCollisions) return;
  const collisions = findAsyncLaunchPathCollisions(flightId, targets);
  if (collisions.length > 0) {
    throw new Error(formatAsyncLaunchPathCollisionMessage(collisions));
  }
}

function composeAsyncLaunchPrompt(
  prompt: string,
  flight: Flight | undefined,
  targets: AttemptTargetSpec[],
): string {
  // Flight-prompt injection is opt-out via memory settings. When disabled,
  // launches carry the raw user prompt with no ambient project memory.
  if (!getMemorySettings().injectIntoFlightPrompts) return prompt;
  if (targets.length === 0) return prompt;

  // Every target must agree on one scope, or we cannot say which project's
  // memory this launch is entitled to. A mixed local/ssh fan-out, or an ssh
  // fan-out spanning two servers, gets no brief rather than an arbitrary one.
  const kinds = new Set(targets.map((target) => target.kind));
  if (kinds.size !== 1) return prompt;
  const kind = targets[0].kind;
  // `AttemptTargetSpec.targetId` IS the `ServerConfig.id`, which is what
  // `remoteMemoryProjectKey` keys on.
  const serverIds = new Set(
    targets.map((target) => (target.kind === "ssh" ? target.targetId : "")),
  );
  if (serverIds.size !== 1) return prompt;

  const candidatePaths = [
    // A remote flight's `projectPath` is a path on the remote host; the local
    // mirror must never be mixed in, so only remote targets contribute here.
    kind === "ssh" ? undefined : flight?.projectPath,
    ...targets.map((target) => target.basePath),
  ].filter((path): path is string => Boolean(path?.trim()));
  const normalized = new Set(candidatePaths.map((path) => path.replace(/\\/g, "/").toLowerCase()));
  if (normalized.size !== 1) return prompt;

  const [projectPath] = candidatePaths;
  const serverId = [...serverIds][0];
  const scope: MemoryBriefScope =
    kind === "ssh"
      ? {
          kind: "ssh",
          projectPath,
          serverId,
          remotePath: projectPath,
          workspaceId: flight?.workspaceId ?? null,
        }
      : { kind: "local", projectPath, workspaceId: flight?.workspaceId ?? null };
  const brief = useMemoryStore.getState().composeMemoryBrief(scope, { query: prompt });
  if (!brief.text.trim()) return prompt;
  // M5: remember which learned patterns rode along in this brief so their
  // confidence can be rerated when the flight settles.
  if (flight) {
    const patternIds = brief.items.filter((i) => i.kind === "pattern").map((i) => i.id);
    useMemoryStore.getState().recordInjectedPatterns(flight.id, patternIds);
  }
  return `${brief.text}\n\n---\n\n${prompt}`;
}

async function attachAttemptConversation(attempt: Attempt, prompt: string): Promise<void> {
  let sshTarget: CreateApiConversationOptions["sshTarget"] = null;
  if (attempt.target.kind === "ssh") {
    const server = useServerStore.getState().getServer(attempt.target.serverId);
    if (server) {
      sshTarget = {
        serverId: server.id,
        name: server.name,
        host: server.host,
        port: server.port,
        user: server.username,
        remotePath: attempt.target.basePath,
        keyPath: server.keyPath ?? null,
        authMethod: server.authMethod,
        hostFingerprint: server.hostFingerprint ?? null,
      };
    }
  }

  await useAgentTaskStore.getState().createApiConversation({
    agent: attempt.agentConfigId as AgentCli,
    projectPath: attempt.target.worktreePath,
    model: attempt.model,
    initialMessage: prompt,
    systemPromptOverride: null,
    thinkingEnabled: false,
    planMode: false,
    sshTarget,
    explicitId: attempt.sessionId,
    skipBackendStart: true,
  });
}

/**
 * Wave-M2: derive a `flight_completed` memory event from the terminal
 * state of an async Flight's attempts. Called once, at the moment the
 * Flight transitions into its terminal `done` state (all attempts
 * settled, at least one completed). The payload is assembled from the
 * data available on the Flight + its Attempts — there is no separate LLM
 * retrospective — so `lessonsLearned` is derived from failing attempts'
 * error messages rather than model-authored insight.
 */
function buildFlightCompletedPayload(flight: Flight): FlightCompletedPayload {
  const attempts = flight.attempts ?? [];
  const completed = attempts.filter((a) => a.status === "completed");
  const failed = attempts.filter((a) => a.status === "failed");
  const cancelled = attempts.filter((a) => a.status === "cancelled");

  const describe = (a: Attempt) => `Attempt on \`${a.branch}\` (${a.model})`;

  const whatWorked = completed.map(describe);
  const whatFailed = failed.map(
    (a) => `${describe(a)}${a.errorMessage ? `: ${a.errorMessage}` : ""}`,
  );
  const lessonsLearned = failed
    .filter((a) => Boolean(a.errorMessage))
    .map((a) => `On \`${a.branch}\`, avoid what caused: ${a.errorMessage}`);

  const parts = [`${completed.length}/${attempts.length} attempt(s) completed`];
  if (failed.length) parts.push(`${failed.length} failed`);
  if (cancelled.length) parts.push(`${cancelled.length} cancelled`);
  const summary =
    `Flight "${flight.title}" finished: ${parts.join(", ")}.` +
    (flight.objective ? ` Objective: ${flight.objective}` : "");

  return {
    flightId: flight.id,
    flightTitle: flight.title,
    summary,
    whatWorked,
    whatFailed,
    lessonsLearned,
    suggestedImprovements: [],
    tags: ["flight"],
  };
}

/**
 * Fire `captureFlightCompleted` exactly on the non-`done` → `done`
 * transition. `statusBefore` is sampled before the attempt patch; the
 * current status is recomputed here from the freshly-patched flight.
 * Guarding on the transition (rather than the raw target status) means a
 * flight that reaches `done` via any last-attempt outcome — completed,
 * cancelled, or a mixed terminal set — captures once and never re-fires
 * on subsequent no-op status writes. `captureFlightCompleted` itself
 * respects the `captureFlights` setting.
 */
// A flight is settled once it reaches one of these. `done` = at least one
// completed attempt and no failures; `failed` = any failed attempt (incl. mixed
// terminal sets); `paused` = every attempt cancelled.
const TERMINAL_FLIGHT_STATUSES = new Set(["done", "failed", "paused"]);

/** Flights whose attempts are being cancelled as part of a delete. Their
 *  cancels must not be read as the Flight *finishing* — no memory capture, no
 *  retrospective, no confidence rerating for a record the user is discarding. */
const flightsBeingDeleted = new Set<string>();

function captureFlightCompletionOnTransition(flightId: string, statusBefore: string): void {
  if (flightsBeingDeleted.has(flightId)) return;
  // Fire once, on the transition from a non-terminal status into any terminal
  // one — not just `done`, so the M5 decay path is reachable and provenance is
  // always cleaned up.
  if (TERMINAL_FLIGHT_STATUSES.has(statusBefore)) return;
  const flightStore = useFlightStore.getState();
  const status = flightStore.computeFlightStatus(flightId);
  if (!TERMINAL_FLIGHT_STATUSES.has(status)) return;
  const flight = flightStore.flights.find((f) => f.id === flightId);
  if (!flight) return;
  const memory = useMemoryStore.getState();

  // M5: rerate the patterns injected into this flight's launch brief. `done`
  // bumps their confidence, `failed` decays it. An all-cancelled (`paused`)
  // flight is a user abort, not a pattern failure, so drop its provenance
  // without rerating.
  if (status === "paused") {
    memory.clearInjectedPatterns(flightId);
  } else {
    memory.adjustConfidenceForFlight(flightId, status === "done");
  }

  // Memory capture + the LLM retrospective are only meaningful for a flight
  // that actually landed work — keep those gated on `done`.
  if (status !== "done") return;
  memory.captureFlightCompleted(
    buildFlightCompletedPayload(flight),
    memoryScopeForWorkspace(flight.workspaceId, flight.projectPath),
  );
  // M9: opt-in LLM retrospective enrichment (fire-and-forget). Runs after the
  // mechanical capture so a missing/unauthed CLI just leaves the derived
  // payload in place.
  void enrichFlightRetrospective(flight);
}

/**
 * M9: replace the mechanically-derived `lessonsLearned` (and sibling fields)
 * with a model-authored retrospective when learning is enabled. Best-effort:
 * any failure (CLI absent, non-JSON output, non-local project) is swallowed and
 * the already-captured mechanical payload stands.
 */
async function enrichFlightRetrospective(flight: Flight): Promise<void> {
  const settings = getMemorySettings();
  if (!settings.captureFlights || !settings.summarizeSessions) return;
  if (!flight.projectPath?.trim()) return;
  // Remote/SSH attempts don't have a validatable local project_path for the
  // Rust command; only enrich all-local flights.
  const attempts = flight.attempts ?? [];
  if (attempts.some((a) => a.target.kind !== "local")) return;
  try {
    const raw = await summarizeFlight(
      flight.projectPath,
      buildFlightSummaryInput(flight),
      buildAttemptSessionLogs(flight),
    );
    const retro = parseFlightRetrospective(raw);
    if (retro) useMemoryStore.getState().updateFlightRetrospective(flight.id, retro);
  } catch (err) {
    console.warn("flight retrospective enrichment failed", err);
  }
}

/**
 * Frontend fallback sweep for a remote attempt worktree — the only path that
 * carries live host/user/key details. Returns a failure message instead of
 * swallowing it, so the delete fan-out can report a remote worktree that is
 * still sitting on the host.
 */
async function cleanupSshAttemptWorktree(
  flightId: string,
  attempt: Attempt,
): Promise<string | null> {
  if (attempt.target.kind !== "ssh") return null;
  const server = useServerStore.getState().getServer(attempt.target.serverId);
  if (!server) {
    console.warn(
      "SSH worktree cleanup skipped because the saved server no longer exists:",
      attempt.target.serverId,
    );
    return `Remote worktree ${attempt.target.worktreePath} was left in place — SSH server '${attempt.target.serverId}' is no longer configured.`;
  }

  try {
    await cleanupAttemptWorktreeSsh({
      flightId,
      attemptId: attempt.id,
      host: server.host,
      port: server.port,
      user: server.username,
      keyPath: server.keyPath ?? null,
      basePath: attempt.target.basePath,
      targetId: server.id,
      hostFingerprint: server.hostFingerprint ?? null,
    });
    return null;
  } catch (err) {
    console.warn("SSH worktree cleanup failed:", err);
    return `Remote worktree ${attempt.target.worktreePath} could not be removed: ${cleanupErrorMessage(err)}`;
  }
}

/** Probe one attempt's worktree for uncommitted work. Never throws: an
 *  unreadable tree reports `unknown`, which the confirm words as "could not be
 *  checked" rather than pretending it was clean. */
export async function inspectAttemptWorktree(
  attempt: Attempt,
): Promise<AttemptWorktreeCleanliness> {
  try {
    if (attempt.target.kind === "local") {
      const status = await getGitStatus(attempt.target.worktreePath);
      return isWorktreeDirty(status) ? "dirty" : "clean";
    }
    const server = useServerStore.getState().getServer(attempt.target.serverId);
    if (!server) return "unknown";
    const status = await getGitStatusRemote(
      toGitServerConfigInput(server),
      attempt.target.worktreePath,
    );
    return isWorktreeDirty(status) ? "dirty" : "clean";
  } catch (err) {
    console.warn("[flight delete] worktree dirty-check failed for", attempt.id, err);
    return "unknown";
  }
}

/** Pure: roll a set of probed attempts up into the counts the confirm shows. */
export function summarizeFlightDeleteImpact(
  entries: FlightDeleteImpactEntry[],
  integration?: FlightDeleteIntegrationImpact,
): FlightDeleteImpact {
  return {
    entries,
    attemptCount: entries.length,
    worktreeCount: entries.length,
    dirtyCount: entries.filter((entry) => entry.cleanliness === "dirty").length,
    unknownCount: entries.filter((entry) => entry.cleanliness === "unknown").length,
    ...(integration ? { integration } : {}),
  };
}

/** Probe the cooperative integration worktree the same way attempts are
 *  probed, so its uncommitted work is named in the confirm before the delete
 *  force-removes it. */
async function inspectIntegrationWorktree(
  flight: Flight | undefined,
): Promise<FlightDeleteIntegrationImpact | undefined> {
  const integration = flight?.integrationBranch;
  if (!integration) return undefined;
  let cleanliness: AttemptWorktreeCleanliness = "unknown";
  try {
    if (integration.targetKind === "local") {
      cleanliness = isWorktreeDirty(await getGitStatus(integration.worktreePath))
        ? "dirty"
        : "clean";
    } else {
      const server = integration.targetId
        ? useServerStore.getState().getServer(integration.targetId)
        : undefined;
      if (server) {
        const status = await getGitStatusRemote(
          toGitServerConfigInput(server),
          integration.worktreePath,
        );
        cleanliness = isWorktreeDirty(status) ? "dirty" : "clean";
      }
    }
  } catch (err) {
    console.warn("[flight delete] integration worktree dirty-check failed", err);
  }
  return {
    branch: integration.branch,
    worktreePath: integration.worktreePath,
    cleanliness,
  };
}

/**
 * What deleting this Flight will actually destroy. Runs the dirty-check per
 * attempt in parallel so the confirm can name uncommitted work before the
 * user commits to losing it.
 */
export async function inspectFlightDeleteImpact(flightId: string): Promise<FlightDeleteImpact> {
  const flight = useFlightStore.getState().flights.find((f) => f.id === flightId);
  const attempts = attemptsNeedingCleanup(flight);
  const [entries, integration] = await Promise.all([
    Promise.all(
      attempts.map(async (attempt) => ({
        attemptId: attempt.id,
        branch: attempt.branch,
        status: attempt.status,
        worktreePath: attempt.target.worktreePath,
        cleanliness: await inspectAttemptWorktree(attempt),
      })),
    ),
    inspectIntegrationWorktree(flight),
  ]);
  return summarizeFlightDeleteImpact(entries, integration);
}

function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
  return count === 1 ? singular : pluralForm;
}

/**
 * Pure: the `warnings[]` lines for the delete confirm. `null` means the probe
 * is still running, which the confirm says out loud rather than showing a
 * reassuring empty callout.
 */
export function describeFlightDeleteImpact(impact: FlightDeleteImpact | null): string[] {
  if (!impact) return ["Checking this flight's attempts for uncommitted work…"];
  if (impact.attemptCount === 0) return describeIntegrationImpact(impact);

  const byStatus = new Map<AttemptStatus, number>();
  for (const entry of impact.entries) {
    byStatus.set(entry.status, (byStatus.get(entry.status) ?? 0) + 1);
  }
  const statusSummary = Array.from(byStatus.entries())
    .map(([status, count]) => `${count} ${status}`)
    .join(", ");

  const lines = [
    `${impact.attemptCount} ${plural(impact.attemptCount, "attempt")} will be cancelled (${statusSummary}).`,
    `${impact.worktreeCount} git ${plural(impact.worktreeCount, "worktree")} will be removed.`,
  ];

  const dirty = impact.entries.filter((entry) => entry.cleanliness === "dirty");
  if (dirty.length > 0) {
    lines.push(
      `${dirty.length} ${plural(dirty.length, "worktree has", "worktrees have")} uncommitted changes that will be lost: ${dirty
        .map((entry) => entry.branch)
        .join(", ")}.`,
    );
  }
  if (impact.unknownCount > 0) {
    lines.push(
      `${impact.unknownCount} ${plural(impact.unknownCount, "worktree")} could not be checked for uncommitted changes.`,
    );
  }
  return [...lines, ...describeIntegrationImpact(impact)];
}

/** Which way the user is settling an attempt from the tile. */
export type AttemptDecision = "accept" | "reject";

/**
 * F2: what Accept / Reject actually destroy. Both transitions are terminal, and
 * both reach `git worktree remove --force` in `mark_attempt_status` — so both
 * are owed the same up-front accounting the Flight delete confirm already gives.
 *
 * Pure, so the wording is testable without a git repo. `cleanliness === null`
 * means the dirty probe is still running and says so rather than rendering a
 * reassuring empty callout.
 */
export function describeAttemptDecisionImpact(
  decision: AttemptDecision,
  attempt: Attempt,
  cleanliness: AttemptWorktreeCleanliness | null,
  flight?: Flight,
): string[] {
  if (cleanliness === null) return ["Checking this attempt's worktree for uncommitted work…"];

  const lines: string[] = [];
  if (decision === "accept") {
    lines.push("The attempt is marked completed and its agent session is closed.");
  } else {
    lines.push("The attempt is marked failed and its agent session is closed.");
  }
  lines.push(`Its git worktree ${attempt.target.worktreePath} is force-removed.`);

  if (cleanliness === "dirty") {
    lines.push(
      `That worktree has uncommitted changes right now — they are destroyed, and a later Land only takes what is committed on ${attempt.branch}.`,
    );
  } else if (cleanliness === "unknown") {
    lines.push(
      "The worktree could not be checked for uncommitted changes, so anything unsaved there may be destroyed.",
    );
  }

  if (decision === "accept") {
    if (flight?.publishAttemptsAsPrs && !attempt.draftPrNumber) {
      lines.push(`A draft PR for ${attempt.branch} is opened before the worktree is removed.`);
    }
    lines.push(
      `Branch ${attempt.branch} is kept — use Land or Open PR on this tile afterwards to merge it.`,
    );
  } else {
    lines.push(`Branch ${attempt.branch} is kept, so the work is still recoverable from git.`);
  }
  return lines;
}

/**
 * F2: whether this attempt's branch can be landed straight into the base
 * checkout. `merge_conversation_branch` is local-only, so an SSH attempt has to
 * go through a PR instead of an in-app merge.
 */
export function attemptLandability(attempt: Attempt): { allowed: boolean; reason: string } {
  if (attempt.target.kind === "ssh") {
    return {
      allowed: false,
      reason:
        "Landing merges into the local checkout; this attempt ran on an SSH host. Open a PR for its branch instead.",
    };
  }
  if (!TERMINAL_ATTEMPT_STATUSES.has(attempt.status)) {
    return { allowed: false, reason: "Accept or reject this attempt before landing its branch." };
  }
  return {
    allowed: true,
    reason: `Squash-merge ${attempt.branch} into the current branch of ${attempt.target.basePath}.`,
  };
}

/** Outcome of `landAttempt`, worded for the tile. */
export interface AttemptLandResult {
  landed: boolean;
  commitSha?: string;
  message: string;
}

/** The integration worktree is removed by the same delete, so it is named on
 *  its own line — including when it holds uncommitted work that the forced
 *  removal will destroy. */
function describeIntegrationImpact(impact: FlightDeleteImpact): string[] {
  const integration = impact.integration;
  if (!integration) return [];
  const lines = [
    `The cooperative integration worktree (${integration.branch}) will be removed; the branch is kept if it still holds unlanded work.`,
  ];
  if (integration.cleanliness === "dirty") {
    lines.push(
      `The integration worktree has uncommitted changes that will be lost: ${integration.worktreePath}.`,
    );
  } else if (integration.cleanliness === "unknown") {
    lines.push("The integration worktree could not be checked for uncommitted changes.");
  }
  return lines;
}

/**
 * The repo root an integration worktree was created under. Derived from the
 * worktree path itself (`<base>/.pkt-flight-integrations/<flightId>`) so the
 * teardown targets exactly the tree that was prepared, even when the Flight's
 * recorded project path has since changed. Falls back to the Flight's project
 * path for records written before that layout.
 */
export function integrationBasePath(flight: Flight): string | null {
  const worktreePath = flight.integrationBranch?.worktreePath;
  if (!worktreePath) return null;
  const marker = "/.pkt-flight-integrations/";
  const normalized = worktreePath.replace(/\\/g, "/");
  const index = normalized.lastIndexOf(marker);
  if (index > 0) return normalized.slice(0, index);
  return flight.projectPath || null;
}

/**
 * Remove a deleted Flight's cooperative integration worktree. Best-effort and
 * non-fatal, exactly like attempt teardown: anything left behind comes back as
 * a `FlightCleanupFailure` for the delete toast rather than being swallowed.
 */
async function cleanupFlightIntegration(
  flight: Flight | undefined,
): Promise<FlightCleanupFailure | null> {
  const integration = flight?.integrationBranch;
  if (!flight || !integration) return null;
  const basePath = integrationBasePath(flight);
  if (!basePath) return null;

  const asFailure = (message: string): FlightCleanupFailure => ({
    // Not attempt-keyed — the integration worktree belongs to the Flight.
    attemptId: "",
    branch: integration.branch,
    message,
  });

  try {
    const outcome = await cleanupFlightIntegrationWorktree({
      flightId: flight.id,
      basePath,
      serverId: integration.targetKind === "ssh" ? (integration.targetId ?? null) : null,
      // Safe `-d` on the Rust side: an unmerged integration branch is kept and
      // reported rather than force-deleted, because it can be the only ref to
      // merged-but-unlanded attempt work.
      deleteBranch: true,
    });
    if (outcome?.dirtyPaths?.length) {
      console.warn(
        "[flight delete] integration worktree removed with uncommitted changes:",
        outcome.dirtyPaths,
      );
    }
    const problem = describeCleanupOutcome(outcome, "Integration worktree");
    return problem ? asFailure(problem) : null;
  } catch (err) {
    return asFailure(
      `Integration worktree ${integration.worktreePath} could not be removed: ${cleanupErrorMessage(err)}`,
    );
  }
}

function cleanupErrorMessage(err: unknown): string {
  if (typeof err === "string") return err;
  if (err instanceof Error) return err.message;
  return String(err);
}

export const useAsyncFlightStore = create<AsyncFlightStore>(() => ({
  launchAsync: async (flightId, prompt, targets, options = {}) => {
    assertAsyncLaunchPathGate(flightId, targets, options);
    for (const target of targets) {
      await assertCostGuardrailsAllowLaunch(target.provider, flightId);
    }
    const flight = useFlightStore.getState().flights.find((f) => f.id === flightId);
    const promptForLaunch = composeAsyncLaunchPrompt(prompt, flight, targets);
    const attemptIdsBefore = new Set((flight?.attempts ?? []).map((attempt) => attempt.id));
    let attempts: Attempt[];
    try {
      attempts = await launchFlightAsync(flightId, promptForLaunch, targets, {
        allowPathCollisions: options.allowPathCollisions,
      });
    } catch (error) {
      // Multi-target provisioning is sequential. If a later target fails,
      // earlier attempts may already be persisted and running even though the
      // command rejects. Rehydrate and attach those partial successes so they
      // remain visible/controllable, then preserve the original launch error.
      await useFlightStore.getState().hydrateFromBackend();
      const partialAttempts =
        useFlightStore
          .getState()
          .flights.find((current) => current.id === flightId)
          ?.attempts?.filter((attempt) => !attemptIdsBefore.has(attempt.id)) ?? [];
      for (const attempt of partialAttempts) {
        try {
          await attachAttemptConversation(attempt, promptForLaunch);
        } catch (attachError) {
          console.warn(
            "Failed to attach partial Flight attempt listeners:",
            attempt.id,
            attachError,
          );
        }
      }
      throw error;
    }

    const flightsWithAttempts = useFlightStore.getState().flights.map((currentFlight) => {
      if (currentFlight.id !== flightId) return currentFlight;
      return {
        ...currentFlight,
        attempts: [...(currentFlight.attempts ?? []), ...attempts],
        prompt: currentFlight.prompt ?? promptForLaunch,
        updatedAt: Date.now(),
      };
    });

    // Register terminal listeners before mutating local state so a very fast
    // `api-agent:done/error` event cannot land between backend start and the
    // listener install. The backend already persisted the attempts, so this
    // local projection deliberately avoids saving and clobbering a fresher
    // backend terminal status.
    await syncAsyncAttemptTerminalListeners(flightsWithAttempts);
    await useFlightStore
      .getState()
      .hydrateFromBackend()
      .catch((err) => console.warn("Failed to hydrate async launch attempts:", err));
    const latestFlight = useFlightStore.getState().flights.find((f) => f.id === flightId);
    const latestAttempts = attempts.map(
      (attempt) => latestFlight?.attempts?.find((current) => current.id === attempt.id) ?? attempt,
    );
    applyAttemptsToFlightLocal(flightId, latestAttempts, promptForLaunch);

    // For each attempt, register a frontend AgentConversation that listens to
    // the same backend event channel (apiAgent*Event(sessionId)) so AttemptTile
    // can render the live stream. The backend has already started the session;
    // we pass `skipBackendStart=true`.
    for (const a of attempts) {
      try {
        await attachAttemptConversation(a, promptForLaunch);
      } catch (err) {
        console.warn("Failed to attach attempt listeners:", a.id, err);
      }
    }

    return attempts;
  },

  cancelAttempt: async (flightId, attemptId) => {
    const flight = useFlightStore.getState().flights.find((f) => f.id === flightId);
    const attempt = flight?.attempts?.find((a) => a.id === attemptId);

    // Sample the flight's rolled-up status BEFORE the patch — same
    // non-`done` → `done` transition guard as `setAttemptStatus` (see
    // captureFlightCompletionOnTransition). Cancelling the last outstanding
    // attempt while a sibling has already completed is a real terminal
    // "done" transition and must capture too.
    const statusBefore = useFlightStore.getState().computeFlightStatus(flightId);

    // The command reports its worktree teardown instead of swallowing a
    // failed `git worktree remove` — cancellation itself still succeeds.
    const outcome = await cancelFlightAttempt(flightId, attemptId);
    patchAttempt(flightId, attemptId, {
      status: "cancelled",
      completedAt: Date.now(),
    });
    if (attempt) {
      detachAttemptTerminalListeners(attempt.sessionId);
    }

    captureFlightCompletionOnTransition(flightId, statusBefore);

    // N2: cancelling the last non-terminal attempt can leave the flight stuck
    // (a sibling already failed) — evaluate an escalation *suggestion*. A cancel
    // is not itself a failure, so no `task_failed` event is recorded here.
    maybeEscalate(flightId);

    // SSH cleanup needs connection details that the backend Attempt record
    // intentionally does not persist, so finish it from the saved Server.
    // When the backend deferred (or failed) the remote removal, this sweep is
    // the authority on whether the worktree is really gone.
    if (attempt && attempt.target.kind === "ssh") {
      // The sweep runs last and is authoritative for a remote worktree: it
      // reports a still-unreachable host or a missing server record, and a
      // clean sweep means the worktree really is gone even if the backend's
      // own attempt at it failed (its `remove` tolerates an absent worktree).
      return await cleanupSshAttemptWorktree(flightId, attempt);
    }

    return describeCleanupOutcome(outcome, "Worktree");
  },

  deleteFlightWithAttemptCleanup: async (flightId) => {
    const failures: FlightCleanupFailure[] = [];
    const flight = useFlightStore.getState().flights.find((f) => f.id === flightId);
    const pending = attemptsNeedingCleanup(flight);

    // Suppress the flight-completed memory capture (and its fire-and-forget
    // LLM retrospective) for the cancels below: the user is deleting this
    // Flight, not settling it, so it must not mint memory on its way out.
    flightsBeingDeleted.add(flightId);
    try {
      for (const attempt of pending) {
        try {
          // The normal cancel path: closes the API session, marks the attempt
          // Cancelled, and removes the local/remote worktree. It now reports
          // what it could NOT remove — a failed `git worktree remove`, or a
          // remote worktree whose server record is gone — instead of leaving
          // a stuck worktree looking like a clean delete.
          const leftBehind = await useAsyncFlightStore
            .getState()
            .cancelAttempt(flightId, attempt.id);
          if (leftBehind) {
            failures.push({
              attemptId: attempt.id,
              branch: attempt.branch,
              message: leftBehind,
            });
          }
        } catch (err) {
          failures.push({
            attemptId: attempt.id,
            branch: attempt.branch,
            message: `Cancel failed — the session and its worktree at ${attempt.target.worktreePath} may still be live: ${cleanupErrorMessage(err)}`,
          });
        }
        try {
          // Whatever happened above, never leave a terminal listener bound to
          // a Flight that is about to stop existing.
          detachAttemptTerminalListeners(attempt.sessionId);
        } catch (err) {
          failures.push({
            attemptId: attempt.id,
            branch: attempt.branch,
            message: cleanupErrorMessage(err),
          });
        }
      }

      // The cooperative integration worktree is flight-keyed, so no attempt
      // cleanup can reach it — without this it outlives its Flight forever.
      const integrationFailure = await cleanupFlightIntegration(flight);
      if (integrationFailure) failures.push(integrationFailure);
    } catch (err) {
      // Belt and braces: cleanup must never take the delete down with it.
      failures.push({
        attemptId: "",
        branch: "",
        message: `Attempt cleanup stopped early: ${cleanupErrorMessage(err)}`,
      });
    } finally {
      flightsBeingDeleted.delete(flightId);
    }

    useFlightStore.getState().deleteFlight(flightId);
    return failures;
  },

  setAttemptStatus: async (flightId, attemptId, status) => {
    // Sample the flight's rolled-up status BEFORE the patch so we can detect
    // the non-`done` → `done` transition and capture a flight_completed
    // memory event exactly once (see captureFlightCompletionOnTransition).
    const statusBefore = useFlightStore.getState().computeFlightStatus(flightId);

    const flightBefore = useFlightStore.getState().flights.find((f) => f.id === flightId);
    const attemptBefore = flightBefore?.attempts?.find((a) => a.id === attemptId);

    if (status === "completed" && flightBefore && attemptBefore) {
      const gate = reviewerGateAllowsAcceptance(flightBefore, attemptBefore);
      if (!gate.allowed) throw new Error(gate.reason);
      // The Rust command enforces the same persisted policy. Flush a freshly
      // parsed pass/override before asking it to complete the attempt.
      if (flightBefore.reviewGatePolicy?.enabled) {
        await useFlightStore.getState().flushPersistence();
      }
      if (flightBefore.executionMode === "cooperative" && attemptBefore.taskId) {
        await integrateCooperativeAttempt(flightBefore, attemptBefore);
      }
    }

    // Publish while the local worktree still exists. `markAttemptStatus(...,
    // "completed")` removes it, so the old fire-and-forget ordering made every
    // enabled local draft-PR publish fail at `git push` with a missing cwd.
    if (
      status === "completed" &&
      flightBefore?.publishAttemptsAsPrs &&
      attemptBefore &&
      !attemptBefore.draftPrNumber
    ) {
      let publish = publishingAttempts.get(attemptBefore.id);
      if (!publish) {
        publish = publishAttemptAsDraftPr(flightBefore, attemptBefore).finally(() => {
          publishingAttempts.delete(attemptBefore.id);
        });
        publishingAttempts.set(attemptBefore.id, publish);
      }
      await publish;
    }

    // Terminal statuses tear the worktree down; the command reports a failed
    // removal instead of swallowing it. There is no toast on this path (the
    // user is accepting/rejecting, not deleting), so it is logged loudly —
    // the delete path is what surfaces it to the UI.
    const teardown = await markAttemptStatus(flightId, attemptId, status);
    const teardownProblem = describeCleanupOutcome(teardown, "Worktree");
    if (teardownProblem) console.warn("[attempt teardown]", attemptId, teardownProblem);
    patchAttempt(flightId, attemptId, {
      status,
      ...(status === "completed" || status === "failed" || status === "cancelled"
        ? { completedAt: Date.now() }
        : {}),
    });
    if (status === "completed" || status === "failed" || status === "cancelled") {
      const flight = useFlightStore.getState().flights.find((f) => f.id === flightId);
      const attempt = flight?.attempts?.find((a) => a.id === attemptId);
      if (attempt) detachAttemptTerminalListeners(attempt.sessionId);
      if (attemptBefore) {
        const sshProblem = await cleanupSshAttemptWorktree(flightId, attemptBefore);
        if (sshProblem) console.warn("[attempt teardown]", attemptId, sshProblem);
      }
    }

    // N2: a rejected/failed attempt records a coordination event and, when the
    // flight is now stuck, an escalation *suggestion* (never an auto-action).
    if (status === "failed") {
      const attempt = useFlightStore
        .getState()
        .flights.find((f) => f.id === flightId)
        ?.attempts?.find((a) => a.id === attemptId);
      recordAttemptFailure(flightId, attemptId, attempt?.errorMessage);
    } else if (status === "cancelled") {
      // A cancel isn't a failure, so no `task_failed` — but it may complete a
      // stuck state if a sibling already failed. Suggest, don't act.
      maybeEscalate(flightId);
    }

    // Flight-completion memory capture. Runs on the terminal-success
    // transition regardless of which attempt outcome triggered it.
    captureFlightCompletionOnTransition(flightId, statusBefore);
  },

  landAttempt: async (flightId, attemptId) => {
    const flight = useFlightStore.getState().flights.find((f) => f.id === flightId);
    const attempt = flight?.attempts?.find((a) => a.id === attemptId);
    if (!flight || !attempt) throw new Error("This attempt no longer exists.");

    const gate = attemptLandability(attempt);
    if (!gate.allowed) throw new Error(gate.reason);

    // Squash by default, matching the Agents worktree bar: an attempt branch is
    // a throwaway line of agent commits, not history worth preserving.
    const outcome = await mergeConversationBranch(attempt.target.basePath, attempt.branch, true);
    if (outcome.nothingToLand) {
      return {
        landed: false,
        message: `Nothing to land — ${attempt.branch} has no commits the checkout doesn't already have. The branch is left in place.`,
      };
    }
    return {
      landed: true,
      commitSha: outcome.commitSha,
      message: `Landed ${attempt.branch} as ${outcome.commitSha.slice(0, 8)}${
        outcome.branchDeleted ? " and deleted the branch" : ""
      }.`,
    };
  },

  publishAttemptPr: async (flightId, attemptId) => {
    const flight = useFlightStore.getState().flights.find((f) => f.id === flightId);
    const attempt = flight?.attempts?.find((a) => a.id === attemptId);
    if (!flight || !attempt) throw new Error("This attempt no longer exists.");
    if (attempt.draftPrNumber) {
      throw new Error(`Draft PR #${attempt.draftPrNumber} is already open for ${attempt.branch}.`);
    }

    // Share the dedupe map with the automatic post-accept publish so a manual
    // click during an in-flight automatic publish joins it instead of opening a
    // second PR for the same branch.
    let publish = publishingAttempts.get(attemptId);
    if (!publish) {
      publish = publishAttemptAsDraftPr(flight, attempt).finally(() => {
        publishingAttempts.delete(attemptId);
      });
      publishingAttempts.set(attemptId, publish);
    }
    await publish;

    // The automatic pipeline deliberately swallows publish failures onto the
    // attempt so a flaky push can't undo an earned status. A manual click is
    // owed the failure directly.
    const after = useFlightStore
      .getState()
      .flights.find((f) => f.id === flightId)
      ?.attempts?.find((a) => a.id === attemptId);
    if (!after?.draftPrNumber) {
      throw new Error(after?.errorMessage ?? "The draft PR was not opened.");
    }
  },

  reassignAttempt: async (flightId, attemptId, newAgentConfigId) => {
    const flight = useFlightStore.getState().flights.find((f) => f.id === flightId);
    const failed = flight?.attempts?.find((a) => a.id === attemptId);
    if (!flight || !failed) return;

    const spec = buildReassignSpec(failed, newAgentConfigId, (id) =>
      useServerStore.getState().getServer(id),
    );
    if (!spec) {
      console.warn(
        `reassignAttempt: cannot rebuild target for attempt '${attemptId}' — SSH server no longer configured`,
      );
      return;
    }

    const toLabel = getProviderForAgent(newAgentConfigId as AgentCli)?.name ?? newAgentConfigId;
    useFlightStore.getState().appendCoordinationEvent(flightId, {
      type: "handoff",
      taskId: attemptId,
      agentId: newAgentConfigId,
      summary: `Reassigned to ${toLabel} after the ${failed.provider} attempt failed.`,
      metadata: { reassignedFromAttemptId: attemptId, toAgentId: newAgentConfigId },
    });

    // Reuse the normal launch path — it provisions a fresh worktree and appends
    // a new attempt to this flight, leaving the failed record in place.
    const prompt = flight.prompt ?? flight.objective ?? "";
    await useAsyncFlightStore.getState().launchAsync(flightId, prompt, [spec]);
  },

  retryReviewGate,
  overrideReviewGate,
  sendReviewFindingsToBuilder,

  prepareCooperativeFlight: async (flightId) => {
    await ensureCooperativeIntegration(flightId);
  },

  launchReadyTasks: async (flightId, taskIds) => {
    let flight = useFlightStore.getState().flights.find((candidate) => candidate.id === flightId);
    if (!flight) throw new Error(`Flight '${flightId}' was not found.`);
    const graphIssues = validateCooperativeGraph(flight);
    const assignmentIssues = validateCooperativeAssignments(flight);
    if (graphIssues.length > 0 || assignmentIssues.length > 0) {
      throw new Error([...graphIssues, ...assignmentIssues][0].message);
    }
    flight = await ensureCooperativeIntegration(flightId);
    const selected = new Set(taskIds ?? []);
    const ready = selectReadyCooperativeTasks(flight).filter(
      (task) => selected.size === 0 || selected.has(task.id),
    );
    if (ready.length === 0) throw new Error("No cooperative tasks are ready to launch.");
    const integration = flight.integrationBranch;
    if (!integration) throw new Error("The Flight integration branch is unavailable.");
    const target = cooperativeTarget(flight);
    for (const task of ready) {
      patchTask(flight.id, task.id, { status: "queued", blockedReason: undefined });
      const provider = attemptProviderFor(task.agentConfigId);
      const spec: AttemptTargetSpec = target.server
        ? {
            kind: "ssh",
            targetId: target.server.id,
            host: target.server.host,
            port: target.server.port,
            user: target.server.username,
            keyPath: target.server.keyPath ?? null,
            authMethod: target.server.authMethod,
            hostFingerprint: target.server.hostFingerprint ?? null,
            basePath: target.projectPath,
            baseBranch: integration.branch,
            agentConfigId: task.agentConfigId,
            provider,
            model: task.model!,
            taskId: task.id,
          }
        : {
            kind: "local",
            basePath: target.projectPath,
            baseBranch: integration.branch,
            agentConfigId: task.agentConfigId,
            provider,
            model: task.model!,
            taskId: task.id,
          };
      try {
        await useAsyncFlightStore
          .getState()
          .launchAsync(flight.id, buildCooperativeTaskPrompt(flight, task), [spec], {
            allowPathCollisions: true,
          });
        patchTask(flight.id, task.id, { status: "running", startedAt: Date.now() });
        useFlightStore.getState().appendCoordinationEvent(flight.id, {
          type: "task_started",
          taskId: task.id,
          taskTitle: task.title,
          agentId: task.agentConfigId,
          summary: `Launched cooperative task '${task.title}' from ${integration.branch}.`,
          metadata: { integrationHead: integration.headSha },
        });
      } catch (error) {
        patchTask(flight.id, task.id, {
          status: "failed",
          blockedReason: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }
    }
  },

  landCooperativeFlight: async (flightId) => {
    const flight = useFlightStore.getState().flights.find((candidate) => candidate.id === flightId);
    if (!flight?.integrationBranch) {
      throw new Error("The Flight integration branch is unavailable.");
    }
    const tasks = flight.milestones.flatMap((milestone) => milestone.tasks);
    if (tasks.length === 0 || tasks.some((task) => task.status !== "done")) {
      throw new Error("Every cooperative task must be integrated before final landing.");
    }
    if (flight.integrationBranch.status !== "ready") {
      throw new Error("Resolve the integration branch before final landing.");
    }
    const target = cooperativeTarget(flight);
    const headSha = await landFlightIntegration({
      projectPath: target.projectPath,
      baseBranch: flight.integrationBranch.baseBranch,
      integrationBranch: flight.integrationBranch.branch,
      serverConfig: target.server ? toGitServerConfigInput(target.server) : null,
    });
    useFlightStore.getState().updateFlight(flight.id, {
      status: "done",
      completedAt: Date.now(),
      integrationBranch: {
        ...flight.integrationBranch,
        headSha,
        status: "landed",
      },
    });
    useFlightStore.getState().appendCoordinationEvent(flight.id, {
      type: "task_completed",
      summary: `Explicitly landed ${flight.integrationBranch.branch} into ${flight.integrationBranch.baseBranch}.`,
      metadata: { integrationHead: headSha, landedBy: "user" },
    });
    await useFlightStore.getState().flushPersistence();
  },
}));
