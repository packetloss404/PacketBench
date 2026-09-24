import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import {
  GitBranch,
  RefreshCw,
  ArrowDownToLine,
  ArrowUpFromLine,
  Check,
  FileEdit,
  FilePlus,
  FileX,
  FileQuestion,
  Loader2,
  AlertCircle,
  GitBranchPlus,
  Server,
  FileCheck2,
  ShieldCheck,
  Link2,
  X,
} from "lucide-react";
import {
  getGitBranch,
  getGitStatus,
  getGitBranchRemote,
  getGitStatusRemote,
  gitPush,
  gitPull,
  gitCreateBranch,
  gitStageFilesRemote,
  gitUnstageFilesRemote,
  gitCommitRemote,
  gitPushRemote,
  gitPullRemote,
  gitDiffFileRemote,
  gitCreateBranchRemote,
  getFileHeadContent,
  readFileForDiff,
  toGitServerConfigInput,
} from "@/lib/tauri";
import {
  type ChangedFile,
  parseGitStatus,
  stageFile,
  unstageFile,
  stageAllFiles,
  unstageAllFiles,
  commitStaged,
  findLinkedIssue,
  pathsForStagingOp,
} from "@/lib/gitCommitFlow";
import {
  buildDiffRows,
  DiffRowView,
  languageForPath,
  type DiffRow,
} from "@/components/agents/diff/DiffRows";
import { useServerStore } from "@/stores/serverStore";
import { useFlightStore } from "@/stores/flightStore";
import { useAppStore } from "@/stores/appStore";
import { useIssueStore } from "@/stores/issueStore";
import {
  matchGitFilesToFlightTasks,
  flightReviewKey,
  type FlightReviewTaskRef,
} from "@/lib/flightReview";
import { WorktreeLifecycleBar } from "@/components/workspace/WorktreeLifecycleBar";
import { ReviewPacketPanel } from "@/components/workspace/ReviewPacketPanel";
import { useAgentApprovalStore } from "@/stores/agentApprovalStore";
import { openConversationInAgents } from "@/stores/sessionGlue";
import { APP_NAME } from "@/lib/brand";

function statusIcon(status: string) {
  switch (status) {
    case "M":
      return <FileEdit size={11} className="text-yellow-400" />;
    case "A":
      return <FilePlus size={11} className="text-accent-green" />;
    case "D":
      return <FileX size={11} className="text-red-400" />;
    case "??":
      return <FileQuestion size={11} className="text-text-muted" />;
    case "R":
      return <FileEdit size={11} className="text-blue-400" />;
    default:
      return <FileEdit size={11} className="text-text-muted" />;
  }
}

function statusColor(status: string): string {
  switch (status) {
    case "M":
      return "text-yellow-400";
    case "A":
      return "text-accent-green";
    case "D":
      return "text-red-400";
    case "??":
      return "text-text-muted";
    case "R":
      return "text-blue-400";
    default:
      return "text-text-secondary";
  }
}

interface GitDashboardProps {
  projectPath: string;
  workspaceId?: string;
  /** Phase 3.3: when set, the dashboard reads git state from the matching
   *  saved server via SSH instead of the local filesystem. `projectPath`
   *  is then treated as the *remote* working tree on the host. */
  serverId?: string;
  /** P2-S3: when set, mount the {@link WorktreeLifecycleBar} for this
   *  conversation's `pkt/<convId>` worktree (Merge back / Create PR / Discard /
   *  Keep). This is the ONE endings surface — GitDashboard, never a per-tile
   *  git panel or a separate commit modal. Absent on the plain workspace git
   *  view. */
  conversationId?: string;
}

/** Phase 3.3: structured failure modes for git state loads. The dashboard
 *  uses these to pick between "Not a git repo", "Unable to connect, retry?"
 *  and the generic error toast — instead of dumping every error into a
 *  toast and leaving the panel stuck on a spinner. */
type LoadError =
  | { kind: "server-missing"; msg: string }
  | { kind: "not-a-repo"; msg: string }
  | { kind: "connection"; msg: string }
  | { kind: "other"; msg: string };

function classifyError(err: unknown): LoadError {
  const raw = err instanceof Error ? err.message : String(err);
  const lower = raw.toLowerCase();
  if (lower.includes("is not inside a git repository") || lower.includes("not a git repository")) {
    return { kind: "not-a-repo", msg: raw };
  }
  if (
    lower.includes("ssh failed") ||
    lower.includes("ssh command timed out") ||
    lower.includes("failed to spawn ssh") ||
    lower.includes("connection refused") ||
    lower.includes("connection reset") ||
    lower.includes("permission denied") ||
    lower.includes("host key verification failed")
  ) {
    return { kind: "connection", msg: raw };
  }
  return { kind: "other", msg: raw };
}

function shortFlightId(id: string): string {
  return `F-${id
    .replace(/^[a-z]+-/i, "")
    .slice(-4)
    .toUpperCase()}`;
}

function reviewTitle(refs: FlightReviewTaskRef[]): string {
  return refs
    .map((ref) => `${shortFlightId(ref.flightId)} / ${ref.taskTitle} (${ref.relation})`)
    .join("\n");
}

/** Per-row staging checkbox. A plain `<input>` doesn't support the
 *  `indeterminate` visual state via a prop — it has to be set on the DOM
 *  node directly, hence the ref effect. */
function StageCheckbox({
  file,
  disabled,
  onToggle,
}: {
  file: ChangedFile;
  disabled: boolean;
  onToggle: () => void;
}) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (ref.current) {
      ref.current.indeterminate = file.staged && file.unstaged;
    }
  }, [file.staged, file.unstaged]);
  return (
    <input
      ref={ref}
      type="checkbox"
      checked={file.staged && !file.unstaged}
      disabled={disabled}
      onChange={onToggle}
      onClick={(e) => e.stopPropagation()}
      className="h-3 w-3 shrink-0 accent-accent-green disabled:opacity-40"
      title={file.staged ? "Staged — click to unstage" : "Unstaged — click to stage"}
    />
  );
}

/** Isolate all async results and editor state by repository and execution host. */
export function GitDashboard(props: GitDashboardProps) {
  const server = useServerStore((state) =>
    state.servers.find((item) => item.id === props.serverId),
  );
  const scope = JSON.stringify([props.projectPath, props.workspaceId, props.serverId, server]);
  return <ScopedGitDashboard key={scope} {...props} />;
}

function ScopedGitDashboard({
  projectPath,
  workspaceId,
  serverId,
  conversationId,
}: GitDashboardProps) {
  const [branch, setBranch] = useState<string>("");
  const [files, setFiles] = useState<ChangedFile[]>([]);
  const [loading, setLoading] = useState(false);
  const [commitMsg, setCommitMsg] = useState("");
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [stagingBusy, setStagingBusy] = useState(false);
  const [feedback, setFeedback] = useState<{ type: "ok" | "err"; msg: string } | null>(null);
  const [newBranch, setNewBranch] = useState("");
  const [showBranchInput, setShowBranchInput] = useState(false);
  const [loadError, setLoadError] = useState<LoadError | null>(null);

  // P1-S4: clickable file rows open a read-only diff (HEAD vs working tree)
  // rendered through the shared DiffRows engine — no more blind commits.
  const [diff, setDiff] = useState<{
    path: string;
    status: "loading" | "ready" | "error";
    rows: DiffRow[];
    error?: string;
  } | null>(null);

  // N4: the changed file whose linked flight review packet(s) are being viewed.
  const [packetRefs, setPacketRefs] = useState<FlightReviewTaskRef[] | null>(null);

  const server = useServerStore((s) =>
    serverId ? s.servers.find((srv) => srv.id === serverId) : undefined,
  );
  const flights = useFlightStore((s) => s.flights);
  const setActiveFlight = useFlightStore((s) => s.setActiveFlight);
  const setActiveView = useAppStore((s) => s.setActiveView);
  const issues = useIssueStore((s) => s.issues);
  const isRemote = !!serverId;
  // Server config for remote (SSH) git write commands; null for local workspaces.
  const serverConfig = useMemo(() => (server ? toGitServerConfigInput(server) : null), [server]);

  const reviewContext = useMemo(
    () =>
      matchGitFilesToFlightTasks(
        files.map((file) => file.path),
        flights,
        { projectPath, workspaceId: workspaceId ?? null },
      ),
    [files, flights, projectPath, workspaceId],
  );

  // N4: session ids with a live pending approval prompt, so the review panel can
  // deep-link to where the (session-scoped) approve/reject actually happens.
  const pendingPermissions = useAgentApprovalStore((s) => s.permissions);
  const pendingEdits = useAgentApprovalStore((s) => s.edits);
  const pendingApprovalSessionIds = useMemo(() => {
    const ids = new Set<string>();
    for (const [cid, list] of pendingPermissions) if (list.length) ids.add(cid);
    for (const [cid, list] of pendingEdits) if (list.length) ids.add(cid);
    return ids;
  }, [pendingPermissions, pendingEdits]);

  // All flight-linked refs across changed files — used by the aggregate banner
  // to open the same review panel the per-file chips open.
  const allReviewRefs = useMemo(
    () => [...reviewContext.matchesByPath.values()].flatMap((m) => m.refs),
    [reviewContext.matchesByPath],
  );

  const commitCandidateFiles = useMemo(() => files.filter((file) => file.staged), [files]);
  const stagedCount = commitCandidateFiles.length;

  const commitContext = useMemo(() => {
    const candidatePaths = new Set(commitCandidateFiles.map((file) => flightReviewKey(file.path)));
    const refs = [...reviewContext.matchesByPath.entries()]
      .filter(([path]) => candidatePaths.has(path))
      .flatMap(([, match]) => match.refs);
    const flightIds = [...new Set(refs.map((ref) => ref.flightId))];
    const taskIds = [...new Set(refs.map((ref) => ref.taskId))];
    const attemptIds = [...new Set(refs.map((ref) => ref.attemptId).filter(Boolean))];
    const sessionIds = [...new Set(refs.map((ref) => ref.sessionId).filter(Boolean))];
    if (flightIds.length === 0 && taskIds.length === 0) return null;
    return {
      flightId: flightIds.length === 1 ? flightIds[0] : null,
      taskId: taskIds.length === 1 ? taskIds[0] : null,
      attemptId: attemptIds.length === 1 ? attemptIds[0] : null,
      sessionId: sessionIds.length === 1 ? sessionIds[0] : null,
    };
  }, [commitCandidateFiles, reviewContext.matchesByPath]);

  // P1-15: transplanted from CommitModal — auto-seed the commit message
  // with a `Fixes #N` trailer when the active workspace is bound to an
  // open Issue, so the server-side close-loop can flip it to `done`.
  const linkedIssue = useMemo(
    () => findLinkedIssue(issues, workspaceId ?? null),
    [issues, workspaceId],
  );
  const seededRef = useRef(false);
  // Monotonic token so a stale diff fetch can't clobber a newer selection.
  const diffReqRef = useRef(0);

  const refreshGeneration = useRef(0);
  const refresh = useCallback(async () => {
    const generation = ++refreshGeneration.current;
    if (!projectPath) return;
    setLoading(true);
    setLoadError(null);
    try {
      if (isRemote) {
        if (!server) {
          setLoadError({
            kind: "server-missing",
            msg: `Server '${serverId}' is no longer configured. Reconnect or attach the workspace to a different server.`,
          });
          setBranch("");
          setFiles([]);
          return;
        }
        const serverConfig = toGitServerConfigInput(server);
        const [b, s] = await Promise.all([
          getGitBranchRemote(serverConfig, projectPath),
          getGitStatusRemote(serverConfig, projectPath),
        ]);
        if (generation !== refreshGeneration.current) return;
        setBranch(b.trim());
        setFiles(parseGitStatus(s));
      } else {
        const [b, s] = await Promise.all([getGitBranch(projectPath), getGitStatus(projectPath)]);
        if (generation !== refreshGeneration.current) return;
        setBranch(b.trim());
        setFiles(parseGitStatus(s));
      }
    } catch (e: unknown) {
      if (generation !== refreshGeneration.current) return;
      const classified = classifyError(e);
      setLoadError(classified);
      setBranch("");
      setFiles([]);
    } finally {
      if (generation === refreshGeneration.current) setLoading(false);
    }
  }, [projectPath, isRemote, server, serverId]);

  const invalidateRefresh = useCallback(() => {
    refreshGeneration.current++;
  }, []);
  useEffect(() => {
    void refresh();
    return invalidateRefresh;
  }, [refresh, invalidateRefresh]);

  // Auto-clear feedback after 4s
  useEffect(() => {
    if (!feedback) return;
    const t = setTimeout(() => setFeedback(null), 4000);
    return () => clearTimeout(t);
  }, [feedback]);

  // Escape closes the diff overlay.
  useEffect(() => {
    if (!diff) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        diffReqRef.current++;
        setDiff(null);
      }
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [diff]);

  // N4: Escape closes the review-packet overlay.
  useEffect(() => {
    if (!packetRefs) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setPacketRefs(null);
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [packetRefs]);

  // P1-15: a workspace switch must not carry a half-typed message (or a
  // stale `Fixes #N` seed) into another repo — this replaces
  // CommitModal's snapshotted-path guard now that GitDashboard stays
  // mounted across active-workspace changes.
  useEffect(() => {
    seededRef.current = false;
    setCommitMsg("");
    // Don't carry an open diff across a workspace/repo switch.
    diffReqRef.current++;
    setDiff(null);
  }, [projectPath, workspaceId]);

  useEffect(() => {
    if (isRemote) return;
    if (seededRef.current) return;
    if (!linkedIssue) return;
    seededRef.current = true;
    setCommitMsg((prev) => (prev.length > 0 ? prev : `Fixes #${linkedIssue.num}\n\n`));
  }, [isRemote, linkedIssue]);

  // Guard against a remote workspace whose server config hasn't resolved (still
  // loading, or the server was deleted). Without this, the write handlers below
  // would fall through to the LOCAL git command run against a remote path.
  function remoteConfigMissing(): boolean {
    if (isRemote && !serverConfig) {
      setFeedback({
        type: "err",
        msg: "Remote server config is not available — reopen the workspace.",
      });
      return true;
    }
    return false;
  }

  async function handleCommit() {
    if (!commitMsg.trim() || stagedCount === 0) return;
    if (remoteConfigMissing()) return;
    const path = projectPath;
    setActionLoading("commit");
    try {
      const result =
        isRemote && serverConfig
          ? await gitCommitRemote(serverConfig, path, commitMsg)
          : await commitStaged(path, commitMsg, commitContext);
      setCommitMsg("");
      setFeedback({ type: "ok", msg: result || "Committed successfully" });
      await refresh();
    } catch (e: unknown) {
      setFeedback({ type: "err", msg: `Commit failed: ${e}` });
    } finally {
      setActionLoading(null);
    }
  }

  async function handlePush() {
    if (remoteConfigMissing()) return;
    setActionLoading("push");
    try {
      const result =
        isRemote && serverConfig
          ? await gitPushRemote(serverConfig, projectPath)
          : await gitPush(projectPath);
      setFeedback({ type: "ok", msg: result || "Pushed successfully" });
    } catch (e: unknown) {
      setFeedback({ type: "err", msg: `Push failed: ${e}` });
    } finally {
      setActionLoading(null);
    }
  }

  async function handlePull() {
    if (remoteConfigMissing()) return;
    setActionLoading("pull");
    try {
      const result =
        isRemote && serverConfig
          ? await gitPullRemote(serverConfig, projectPath)
          : await gitPull(projectPath);
      setFeedback({ type: "ok", msg: result || "Pulled successfully" });
      await refresh();
    } catch (e: unknown) {
      setFeedback({ type: "err", msg: `Pull failed: ${e}` });
    } finally {
      setActionLoading(null);
    }
  }

  async function handleCreateBranch() {
    if (!newBranch.trim()) return;
    if (remoteConfigMissing()) return;
    setActionLoading("branch");
    try {
      if (isRemote && serverConfig) {
        await gitCreateBranchRemote(serverConfig, projectPath, newBranch.trim(), true);
      } else {
        await gitCreateBranch(projectPath, newBranch.trim(), true);
      }
      setNewBranch("");
      setShowBranchInput(false);
      setFeedback({ type: "ok", msg: `Switched to new branch: ${newBranch.trim()}` });
      await refresh();
    } catch (e: unknown) {
      setFeedback({ type: "err", msg: `Branch creation failed: ${e}` });
    } finally {
      setActionLoading(null);
    }
  }

  async function handleToggleStage(file: ChangedFile) {
    if (stagingBusy) return;
    if (remoteConfigMissing()) return;
    setStagingBusy(true);
    try {
      const fullyStaged = file.staged && !file.unstaged;
      if (isRemote && serverConfig) {
        const paths = pathsForStagingOp(file);
        if (fullyStaged) {
          await gitUnstageFilesRemote(serverConfig, projectPath, paths);
        } else {
          await gitStageFilesRemote(serverConfig, projectPath, paths);
        }
      } else if (fullyStaged) {
        await unstageFile(projectPath, file);
      } else {
        await stageFile(projectPath, file);
      }
      await refresh();
    } catch (e: unknown) {
      setFeedback({ type: "err", msg: `${file.staged ? "Unstage" : "Stage"} failed: ${e}` });
    } finally {
      setStagingBusy(false);
    }
  }

  async function handleStageAll() {
    if (stagingBusy) return;
    if (remoteConfigMissing()) return;
    setStagingBusy(true);
    try {
      if (isRemote && serverConfig) {
        const paths = files.filter((f) => f.unstaged).flatMap(pathsForStagingOp);
        if (paths.length > 0) await gitStageFilesRemote(serverConfig, projectPath, paths);
      } else {
        await stageAllFiles(projectPath, files);
      }
      await refresh();
    } catch (e: unknown) {
      setFeedback({ type: "err", msg: `Stage all failed: ${e}` });
    } finally {
      setStagingBusy(false);
    }
  }

  async function handleUnstageAll() {
    if (stagingBusy) return;
    if (remoteConfigMissing()) return;
    setStagingBusy(true);
    try {
      if (isRemote && serverConfig) {
        const paths = files.filter((f) => f.staged).flatMap(pathsForStagingOp);
        if (paths.length > 0) await gitUnstageFilesRemote(serverConfig, projectPath, paths);
      } else {
        await unstageAllFiles(projectPath, files);
      }
      await refresh();
    } catch (e: unknown) {
      setFeedback({ type: "err", msg: `Unstage all failed: ${e}` });
    } finally {
      setStagingBusy(false);
    }
  }

  // P1-S4: open the HEAD-vs-working diff for a file. Reuses the shared
  // DiffRows engine (`buildDiffRows`) over a plain git fetch — HEAD content
  // via `getFileHeadContent`, working content via `readFileForDiff`. Renames
  // arrive as "old -> new": diff the new-side working copy against the
  // old-side HEAD blob. A monotonic request token discards stale responses
  // when a second row is clicked mid-load.
  const openDiff = useCallback(
    async (file: ChangedFile) => {
      const paths = pathsForStagingOp(file);
      const oldPath = paths[0];
      const newPath = paths[paths.length - 1];
      const reqId = ++diffReqRef.current;
      setDiff({ path: newPath, status: "loading", rows: [] });
      try {
        let head: string | null;
        let work: string | null;
        if (isRemote) {
          // S3: remote workspaces fetch both sides over SSH in one round-trip.
          if (!serverConfig) throw new Error("Remote server config unavailable");
          const d = await gitDiffFileRemote(serverConfig, projectPath, oldPath, newPath);
          head = d.head;
          work = d.work;
        } else {
          [head, work] = await Promise.all([
            getFileHeadContent(projectPath, oldPath),
            readFileForDiff(projectPath, newPath),
          ]);
        }
        if (diffReqRef.current !== reqId) return;
        const rows = buildDiffRows(head ?? "", work ?? "");
        setDiff({ path: newPath, status: "ready", rows });
      } catch (e: unknown) {
        if (diffReqRef.current !== reqId) return;
        setDiff({ path: newPath, status: "error", rows: [], error: String(e) });
      }
    },
    [projectPath, isRemote, serverConfig],
  );

  // Remote (SSH) workspaces support write actions (stage / commit / push /
  // pull / create-branch) via the git_*_remote commands, and — since S3 — the
  // per-file diff viewer too (via `git_diff_file_remote`), so rows are
  // interactive on remote as well when a server config is available.
  const hasUnstaged = files.some((f) => f.unstaged);

  return (
    <div className="relative flex h-full flex-col overflow-hidden text-ui">
      {/* Header: branch + actions */}
      <div className="flex shrink-0 items-center justify-between border-b border-bg-border bg-bg-secondary px-3 py-2">
        <div className="flex min-w-0 items-center gap-2">
          {isRemote ? (
            <Server size={12} className="shrink-0 text-accent-blue" />
          ) : (
            <GitBranch size={12} className="shrink-0 text-accent-green" />
          )}
          <span className="truncate font-medium text-text-primary">
            {branch || (loadError ? "—" : "...")}
          </span>
          {isRemote && (
            <span
              className="shrink-0 rounded-full bg-accent-blue/10 px-1.5 py-0.5 font-mono text-meta text-accent-blue"
              title={server ? `${server.username}@${server.host}` : "remote"}
            >
              remote
            </span>
          )}
          <button
            onClick={() => setShowBranchInput((v) => !v)}
            className="p-0.5 text-text-muted transition-colors hover:text-text-primary"
            title="Create branch"
          >
            <GitBranchPlus size={11} />
          </button>
        </div>
        <div className="flex items-center gap-1">
          <button
            onClick={handlePull}
            disabled={!!actionLoading}
            className="flex items-center gap-1 rounded bg-bg-tertiary px-1.5 py-0.5 text-ui text-text-secondary transition-colors hover:bg-bg-border hover:text-text-primary disabled:opacity-40"
            title="Pull"
          >
            {actionLoading === "pull" ? (
              <Loader2 size={10} className="animate-spin" />
            ) : (
              <ArrowDownToLine size={10} />
            )}
            Pull
          </button>
          <button
            onClick={handlePush}
            disabled={!!actionLoading}
            className="flex items-center gap-1 rounded bg-bg-tertiary px-1.5 py-0.5 text-ui text-text-secondary transition-colors hover:bg-bg-border hover:text-text-primary disabled:opacity-40"
            title="Push"
          >
            {actionLoading === "push" ? (
              <Loader2 size={10} className="animate-spin" />
            ) : (
              <ArrowUpFromLine size={10} />
            )}
            Push
          </button>
          <button
            onClick={refresh}
            disabled={loading}
            className="p-1 text-text-muted transition-colors hover:text-text-primary disabled:opacity-40"
            title="Refresh"
          >
            <RefreshCw size={11} className={loading ? "animate-spin" : ""} />
          </button>
        </div>
      </div>

      {/* New branch input */}
      {showBranchInput && (
        <div className="flex items-center gap-1.5 border-b border-bg-border bg-bg-secondary px-3 py-1.5">
          <input
            type="text"
            value={newBranch}
            onChange={(e) => setNewBranch(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleCreateBranch()}
            placeholder="new-branch-name"
            className="flex-1 rounded border border-bg-border bg-bg-primary px-2 py-0.5 text-ui text-text-primary placeholder:text-text-muted focus:border-accent-green/50 focus:outline-none"
            autoFocus
          />
          <button
            onClick={handleCreateBranch}
            disabled={!newBranch.trim() || !!actionLoading}
            className="rounded bg-accent-green/20 px-1.5 py-0.5 text-ui text-accent-green transition-colors hover:bg-accent-green/30 disabled:opacity-40"
          >
            {actionLoading === "branch" ? <Loader2 size={10} className="animate-spin" /> : "Create"}
          </button>
        </div>
      )}

      {/* Feedback toast */}
      {feedback && (
        <div
          className={`flex shrink-0 items-center gap-1.5 px-3 py-1.5 text-meta ${
            feedback.type === "ok"
              ? "bg-accent-green/10 text-accent-green"
              : "bg-red-500/10 text-red-400"
          }`}
        >
          {feedback.type === "ok" ? <Check size={10} /> : <AlertCircle size={10} />}
          <span className="truncate">{feedback.msg}</span>
        </div>
      )}

      {/* P2-S3: the four-action worktree endings bar — only when this
          dashboard was opened for a specific conversation's worktree. */}
      {conversationId && (
        <WorktreeLifecycleBar
          conversationId={conversationId}
          isRemote={isRemote}
          onFeedback={setFeedback}
          onLanded={refresh}
        />
      )}

      {!loadError && reviewContext.linkedFileCount > 0 && (
        <div className="mx-2 mt-2 shrink-0 rounded border border-accent-amber/30 bg-accent-amber/5 px-2 py-1.5">
          <div className="flex items-center gap-1.5">
            <ShieldCheck size={11} className="shrink-0 text-accent-amber" />
            <span className="text-ui font-semibold text-text-primary">Flight review context</span>
            <span className="flex-1" />
            <button
              type="button"
              onClick={() => allReviewRefs.length > 0 && setPacketRefs(allReviewRefs)}
              className="text-ui text-accent-amber transition-colors hover:text-accent-amber/80"
            >
              Review
            </button>
          </div>
          <div className="mt-0.5 text-meta leading-relaxed text-text-muted">
            {reviewContext.linkedFileCount} of {files.length} changed file
            {reviewContext.linkedFileCount === 1 ? "" : "s"} map to {reviewContext.taskCount} flight
            task
            {reviewContext.taskCount === 1 ? "" : "s"}.
            {reviewContext.pendingApprovalCount > 0
              ? ` ${reviewContext.pendingApprovalCount} approval${reviewContext.pendingApprovalCount === 1 ? "" : "s"} still pending.`
              : " Open the review packet for task and attempt context."}
          </div>
        </div>
      )}

      {/* Select-all affordance — local workspaces only */}
      {!loadError && files.length > 0 && (
        <div className="flex shrink-0 items-center gap-2 border-b border-bg-border px-3 py-1 text-ui text-text-muted">
          <span>
            {stagedCount} of {files.length} staged
          </span>
          <span className="flex-1" />
          <button
            type="button"
            onClick={handleStageAll}
            disabled={stagingBusy || !hasUnstaged}
            className="rounded px-1.5 py-0.5 text-text-secondary transition-colors hover:bg-bg-secondary hover:text-text-primary disabled:opacity-40"
          >
            Stage all
          </button>
          <button
            type="button"
            onClick={handleUnstageAll}
            disabled={stagingBusy || stagedCount === 0}
            className="rounded px-1.5 py-0.5 text-text-secondary transition-colors hover:bg-bg-secondary hover:text-text-primary disabled:opacity-40"
          >
            Unstage all
          </button>
        </div>
      )}

      {/* Changed files list */}
      <div className="flex-1 overflow-y-auto px-1 py-1">
        {loadError && (
          <div className="flex flex-col items-center gap-2 px-3 py-4 text-ui">
            <AlertCircle size={20} className="text-accent-amber" />
            <div className="text-center text-text-secondary">
              {loadError.kind === "server-missing" && (
                <span className="text-accent-red">{loadError.msg}</span>
              )}
              {loadError.kind === "not-a-repo" && (
                <>
                  <div className="font-medium text-text-primary">Not a git repository</div>
                  <div className="mt-0.5 text-meta text-text-muted">{projectPath}</div>
                </>
              )}
              {loadError.kind === "connection" && (
                <>
                  <div className="font-medium text-text-primary">Unable to connect</div>
                  <div className="mt-1 break-words text-meta text-text-muted">{loadError.msg}</div>
                </>
              )}
              {loadError.kind === "other" && (
                <>
                  <div className="font-medium text-text-primary">Failed to load git info</div>
                  <div className="mt-1 break-words text-meta text-text-muted">{loadError.msg}</div>
                </>
              )}
            </div>
            {loadError.kind !== "not-a-repo" && (
              <button
                onClick={refresh}
                disabled={loading}
                className="mt-1 flex items-center gap-1.5 rounded bg-bg-tertiary px-2 py-1 text-ui text-text-secondary transition-colors hover:bg-bg-border hover:text-text-primary disabled:opacity-40"
              >
                {loading ? <Loader2 size={10} className="animate-spin" /> : <RefreshCw size={10} />}
                Retry
              </button>
            )}
          </div>
        )}
        {!loadError && files.length === 0 && !loading && (
          <div className="flex items-center justify-center py-6 text-ui text-text-muted">
            Working tree clean
          </div>
        )}
        {!loadError && loading && files.length === 0 && (
          <div className="flex items-center justify-center gap-1.5 py-6 text-ui text-text-muted">
            <Loader2 size={11} className="animate-spin" />
            Loading{isRemote ? " over SSH" : ""}...
          </div>
        )}
        {!loadError &&
          files.map((f, i) => {
            const match = reviewContext.matchesByPath.get(flightReviewKey(f.path));
            const primaryRef = match?.refs[0];
            // S3: remote rows are interactive too when we have a server config.
            const rowInteractive = !isRemote || !!serverConfig;
            return (
              <div
                key={`${f.path}-${i}`}
                onClick={rowInteractive ? () => openDiff(f) : undefined}
                role={rowInteractive ? "button" : undefined}
                tabIndex={rowInteractive ? 0 : undefined}
                onKeyDown={
                  rowInteractive
                    ? (e) => {
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault();
                          openDiff(f);
                        }
                      }
                    : undefined
                }
                aria-current={diff?.path === f.path ? true : undefined}
                title={rowInteractive ? `${f.path} — click to view diff` : f.path}
                className={`group flex items-center gap-1.5 rounded px-2 py-[3px] transition-colors hover:bg-bg-secondary ${
                  rowInteractive ? "cursor-pointer" : ""
                } ${diff?.path === f.path ? "bg-bg-secondary" : ""}`}
              >
                <StageCheckbox
                  file={f}
                  disabled={stagingBusy}
                  onToggle={() => handleToggleStage(f)}
                />
                {statusIcon(f.status)}
                <span className={`w-5 shrink-0 font-mono text-meta ${statusColor(f.status)}`}>
                  {f.status}
                </span>
                <span className="truncate text-ui text-text-secondary">{f.path}</span>
                {match && primaryRef && (
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      setPacketRefs(match.refs);
                    }}
                    onKeyDown={(e) => {
                      // Don't let Enter/Space bubble to the row handler (which
                      // opens the git diff) — the chip opens the review panel.
                      if (e.key === "Enter" || e.key === " ") e.stopPropagation();
                    }}
                    title={reviewTitle(match.refs)}
                    className={`ml-auto inline-flex min-w-0 max-w-[112px] shrink-0 items-center gap-1 rounded border px-1.5 py-0.5 text-meta transition-colors ${
                      match.refs.some((r) => r.taskStatus === "approval_needed")
                        ? "border-accent-amber/40 bg-accent-amber/15 text-accent-amber hover:bg-accent-amber/25"
                        : "border-bg-border bg-bg-secondary text-text-muted hover:bg-bg-hover hover:text-text-secondary"
                    }`}
                  >
                    {match.refs.some((r) => r.taskStatus === "approval_needed") ? (
                      <AlertCircle size={9} className="shrink-0" />
                    ) : (
                      <FileCheck2 size={9} className="shrink-0" />
                    )}
                    <span className="truncate">
                      {shortFlightId(primaryRef.flightId)} · {primaryRef.taskTitle}
                    </span>
                  </button>
                )}
              </div>
            );
          })}
      </div>

      {/* Commit section — local and remote (SSH) workspaces. The Fixes-trailer
          seeding + linked-issue banner are local-only (their effects early-out
          on remote); the commit itself routes through git_commit_remote. */}
      {
        <div className="shrink-0 space-y-1.5 border-t border-bg-border bg-bg-secondary px-3 py-2">
          {linkedIssue && (
            <div
              className="flex items-center gap-1.5 text-meta text-text-muted"
              title={`This commit will auto-close ${linkedIssue.issue.ticketId} when it lands.`}
            >
              <Link2 size={10} className="shrink-0 text-accent-blue/70" />
              <span className="truncate">
                Linked to Issue #{linkedIssue.num}:{" "}
                <span className="text-text-secondary">{linkedIssue.issue.title}</span>
              </span>
            </div>
          )}
          {reviewContext.linkedFileCount > 0 ? (
            <div className="flex items-center gap-1.5 text-meta text-accent-amber">
              <FileCheck2 size={10} />
              <span className="truncate">
                Review context is available for {reviewContext.linkedFileCount} flight-linked file
                {reviewContext.linkedFileCount === 1 ? "" : "s"}.
              </span>
            </div>
          ) : (
            <div className="text-meta text-text-muted">
              {stagedCount === 0
                ? "Commits staged files only — stage files above"
                : `Flight-linked commits receive ${APP_NAME} trailers when a task match is found.`}
            </div>
          )}
          <textarea
            value={commitMsg}
            onChange={(e) => setCommitMsg(e.target.value)}
            placeholder="Commit message..."
            rows={2}
            className="w-full resize-none rounded border border-bg-border bg-bg-primary px-2 py-1 text-ui text-text-primary placeholder:text-text-muted focus:border-accent-green/50 focus:outline-none"
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
                e.preventDefault();
                handleCommit();
              }
            }}
          />
          <button
            onClick={handleCommit}
            disabled={!commitMsg.trim() || stagedCount === 0 || !!actionLoading}
            className="flex w-full items-center justify-center gap-1.5 rounded bg-accent-green/20 py-1 text-ui font-medium text-accent-green transition-colors hover:bg-accent-green/30 disabled:cursor-not-allowed disabled:opacity-30"
          >
            {actionLoading === "commit" ? (
              <Loader2 size={11} className="animate-spin" />
            ) : (
              <Check size={11} />
            )}
            Commit staged
          </button>
        </div>
      }

      {/* P1-S4: diff overlay — HEAD vs working tree for the clicked file,
          rendered through the shared DiffRows engine. */}
      {diff && (
        <div className="absolute inset-0 z-30 flex flex-col bg-bg-primary">
          <div className="flex shrink-0 items-center gap-2 border-b border-bg-border bg-bg-secondary px-3 py-2">
            <FileEdit size={12} className="shrink-0 text-text-muted" />
            <span className="truncate font-mono text-ui text-text-primary" title={diff.path}>
              {diff.path}
            </span>
            <span className="flex-1" />
            <button
              type="button"
              onClick={() => {
                diffReqRef.current++;
                setDiff(null);
              }}
              className="p-0.5 text-text-muted transition-colors hover:text-text-primary"
              aria-label="Close diff"
              title="Close diff (Esc)"
            >
              <X size={13} />
            </button>
          </div>
          <div className="flex-1 overflow-auto">
            {diff.status === "loading" && (
              <div className="flex items-center justify-center gap-1.5 py-6 text-ui text-text-muted">
                <Loader2 size={11} className="animate-spin" />
                Loading diff...
              </div>
            )}
            {diff.status === "error" && (
              <div className="flex flex-col items-center gap-2 px-3 py-6 text-ui">
                <AlertCircle size={18} className="text-accent-amber" />
                <div className="break-words text-center text-meta text-text-muted">
                  {diff.error || "Failed to load diff"}
                </div>
              </div>
            )}
            {diff.status === "ready" &&
              (diff.rows.length === 0 ? (
                <div className="flex items-center justify-center py-6 text-ui text-text-muted">
                  No changes against HEAD
                </div>
              ) : (
                <div className="min-w-max py-1">
                  {diff.rows.map((row) => (
                    <DiffRowView key={row.key} row={row} language={languageForPath(diff.path)} />
                  ))}
                </div>
              ))}
          </div>
        </div>
      )}

      {packetRefs && (
        <ReviewPacketPanel
          refs={packetRefs}
          flights={flights}
          pendingApprovalSessionIds={pendingApprovalSessionIds}
          onOpenFlight={(flightId) => {
            setActiveFlight(flightId);
            setActiveView("flights");
            setPacketRefs(null);
          }}
          onOpenApproval={(conversationId) => {
            setPacketRefs(null);
            openConversationInAgents(conversationId);
          }}
          onOpenDiff={(filePath) => {
            const file = files.find((candidate) => candidate.path === filePath);
            setPacketRefs(null);
            if (file) void openDiff(file);
            else {
              setFeedback({
                type: "err",
                msg: `The review packet file is no longer in the working-tree diff: ${filePath}`,
              });
            }
          }}
          onClose={() => setPacketRefs(null)}
        />
      )}
    </div>
  );
}
