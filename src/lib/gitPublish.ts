/**
 * Shared branch → draft-PR publish path, extracted behavior-preserving from
 * `asyncFlightStore.publishAttemptAsDraftPr` (P2-S2). Both async Flight attempts
 * and Agents conversations open PRs the same way: push the worktree branch to
 * origin, then open a (draft) PR. The RESULT records the PR number so the caller
 * can persist it on its own engine record (`Attempt.draftPrNumber` /
 * `AgentConversation.worktree.prNumber`) — that recorded number feeds the
 * worktree safe-cleanup predicate (`worktreeLifecycle.isWorktreeSafeToCleanup`).
 *
 * This helper owns ONLY the git+GitHub calls and their error classification; the
 * caller owns repo selection, PR title/body composition, SSH gating, and
 * persistence. Keeping those in the caller preserves each owner's existing UX
 * contract and byte-identical error surfaces.
 */
import {
  gitPushBranch,
  githubCreatePr,
  gitGetOriginUrl,
  gitHostListConnections,
} from "@/lib/tauri";

import { resolveConnectionForRemote } from "@/lib/gitHostResolve";

export interface PublishBranchAsPrInput {
  /** Absolute path to push from (the worktree checkout). */
  worktreePath: string;
  /** The branch to push + open a PR for (`pkt/<id>` / `packetbench/<id>`). */
  branch: string;
  /** The PR base branch. */
  baseBranch: string;
  /** GitHub repo owner. */
  owner: string;
  /** GitHub repo name. */
  repo: string;
  /** Pin API authority instead of following the globally selected host. */
  connectionId?: string;
  /** Pre-composed PR title (already length-capped by the caller). */
  title: string;
  /** Pre-composed PR body (already length-capped by the caller). */
  body: string;
  /** Open as a draft PR. Defaults to true (the async-Flight contract). */
  draft?: boolean;
  /** GP5: transport-agnostic push. When provided (SSH attempts), it replaces
   *  the local `git push` — the branch is pushed from the remote worktree host
   *  so origin has it before the PR is opened via the GitHub API. */
  remotePush?: () => Promise<void>;
}

export type PublishBranchAsPrResult =
  | {
      ok: true;
      /**
       * The opened PR's number, or null when GitHub returned success without a
       * number (the caller treats null as "published but unrecorded" — do not
       * persist a number, but do not retry either).
       */
      prNumber: number | null;
    }
  | {
      ok: false;
      /** Which step failed — lets the caller pick its existing error copy. */
      stage: "push" | "create_pr";
      /** Human-readable failure detail (already string-normalized). */
      message: string;
    };

function errMessage(err: unknown, fallback: string): string {
  return typeof err === "string" ? err : ((err as Error)?.message ?? fallback);
}

/**
 * Push `branch` to origin then open a (draft) PR. Returns a discriminated result
 * rather than throwing so callers keep their fire-and-forget, status-preserving
 * flows. Behavior mirrors the previous inline flight logic exactly: push first
 * (sets upstream), then create_pr; the PR number is read from the returned JSON
 * `number` field.
 */
export async function publishBranchAsPr(
  input: PublishBranchAsPrInput,
): Promise<PublishBranchAsPrResult> {
  // 1. Push the branch to origin (sets upstream on first push). SSH attempts
  //    supply a `remotePush` that pushes from the remote worktree host instead.
  try {
    if (input.remotePush) {
      await input.remotePush();
    } else {
      await gitPushBranch(input.worktreePath, input.branch, false);
    }
  } catch (err) {
    return { ok: false, stage: "push", message: errMessage(err, "push failed") };
  }

  // 2. Open the PR.
  let prNumber: number | null = null;
  try {
    const json = await githubCreatePr(
      input.owner,
      input.repo,
      input.title,
      input.body,
      input.branch,
      input.baseBranch,
      input.draft ?? true,
      ...(input.connectionId ? [input.connectionId] : []),
    );
    const pr = JSON.parse(json) as { number?: number };
    if (typeof pr.number === "number") prNumber = pr.number;
  } catch (err) {
    return { ok: false, stage: "create_pr", message: errMessage(err, "create_pr failed") };
  }

  return { ok: true, prNumber };
}

/** Resolve the worktree's actual origin before any publication side effect. */
export async function resolveWorktreePrTarget(worktreePath: string): Promise<{
  owner: string;
  repo: string;
  connectionId: string;
}> {
  const origin = (await gitGetOriginUrl(worktreePath))?.trim() ?? "";
  const connections = await gitHostListConnections();
  const resolved = resolveConnectionForRemote(origin, connections);
  if (!resolved.connectionId || resolved.ambiguous) {
    throw new Error(
      "The worktree origin must match exactly one configured Git host. Check Git host connections before publishing.",
    );
  }
  const connection = connections.find((item) => item.id === resolved.connectionId)!;
  let path: string;
  if (origin.includes("://")) {
    const url = new URL(origin);
    if (!["https:", "http:", "ssh:", "git:"].includes(url.protocol) || url.search || url.hash)
      throw new Error("Unsupported worktree origin URL.");
    path = url.pathname;
  } else {
    const match = origin.match(/^(?:[^@/]+@)?[^:/@]+:(.+)$/);
    if (!match) throw new Error("Unsupported worktree origin URL.");
    path = match[1];
  }
  const segments = path
    .replace(/^\/+|\/+$/g, "")
    .replace(/\.git$/, "")
    .split("/");
  if (
    segments.length < 2 ||
    (connection.kind !== "gitlab" && segments.length !== 2) ||
    segments.some(
      (segment) => !/^[a-zA-Z0-9_.-]+$/.test(segment) || segment === "." || segment === "..",
    )
  ) {
    throw new Error("Cannot identify a repository from the worktree origin URL.");
  }
  return {
    owner: segments.slice(0, -1).join("/"),
    repo: segments[segments.length - 1],
    connectionId: resolved.connectionId,
  };
}
