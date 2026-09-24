import { invoke } from "@tauri-apps/api/core";
import type {
  AgentConfigDto,
  PersistedStateDto,
  PersistedUiStateDto,
  WorkspaceDto,
} from "@/generated/tauri-schema";
import type { AgentConfig } from "@/types/agent";
import type {
  Attempt,
  AttemptReviewGate,
  Flight,
  Milestone,
  ReviewType,
  Task,
  TaskResult,
} from "@/types/flight";
import type { Issue } from "@/stores/issueStore";
import type {
  StatusLineData,
  CodexStatusLineData,
  OpenCodeStatusLineData,
} from "@/types/statusline";
import type { Workspace } from "@/types/workspace";
import type { MemoryEvent, LearnedPattern } from "@/types/memory";
import type {
  CreateProjectMemoryInput,
  ProjectMemoryNote,
  ProjectMemorySnapshot,
  UpdateProjectMemoryInput,
} from "@/types/project-memory";
import type { ServerConfig } from "@/types/server";
import type { CliAccount, CliAccountCli } from "@/types/cliAccount";
import type { PacketAgentRequest, PacketAgentResponse } from "@/types/packet-agent";
import type { TerminalShellProbe } from "@/types/terminal-shell";
import { normalizeTerminalShellSelection } from "@/lib/terminalShells";
import { isValidMosaicTree } from "@/lib/mosaicPresets";

type WorkspacePaneDtoWithFrontendMetadata = WorkspaceDto["panes"][number] &
  Pick<Workspace["panes"][number], "pinnedCommands">;

type WorkspaceDtoWithFrontendMetadata = Omit<WorkspaceDto, "panes"> & {
  panes: WorkspacePaneDtoWithFrontendMetadata[];
  githubRepo?: Workspace["githubRepo"];
};

// Filesystem
export async function getCwd(): Promise<string> {
  return invoke<string>("get_cwd");
}

// PacketAgent W9 handoff
export async function setPacketAgentToken(token: string): Promise<void> {
  return invoke("set_packet_agent_token", { token });
}

export async function getPacketAgentTokenExists(): Promise<boolean> {
  return invoke<boolean>("get_packet_agent_token_exists");
}

export async function deletePacketAgentToken(): Promise<void> {
  return invoke("delete_packet_agent_token");
}

export async function packetAgentRequest(
  request: PacketAgentRequest,
): Promise<PacketAgentResponse> {
  return invoke<PacketAgentResponse>("packet_agent_request", { request });
}

/** PH6: payload of `packet-agent:event:{deploymentId}` — one SSE data frame. */
export interface PacketAgentStreamEventPayload {
  eventId?: string;
  eventType?: string;
  data: unknown;
}

/** PH6: payload of `packet-agent:stream-status:{deploymentId}`. */
export interface PacketAgentStreamStatusPayload {
  state: "connected" | "reconnecting" | "stopped" | "error";
  cursor?: string;
  message?: string;
  consecutiveFailures: number;
}

/** Start (or restart) the Rust-side SSE consumer for one worker deployment.
 * The bearer token never reaches the webview — Rust loads it from the OS
 * credential store. */
export async function startPacketAgentStream(args: {
  endpoint: string;
  workspaceId: string;
  deploymentId: string;
  cursor?: string;
}): Promise<void> {
  return invoke("start_packet_agent_stream", {
    endpoint: args.endpoint,
    workspaceId: args.workspaceId,
    deploymentId: args.deploymentId,
    cursor: args.cursor ?? null,
  });
}

export async function stopPacketAgentStream(deploymentId: string): Promise<void> {
  return invoke("stop_packet_agent_stream", { deploymentId });
}

/** True only when `path` exists and is a directory. Used by bootstrap to
 *  validate a persisted project path before adopting it. */
export async function pathIsDir(path: string): Promise<boolean> {
  return invoke<boolean>("path_is_dir", { path });
}

export async function listSubdirectories(dirPath: string): Promise<string[]> {
  return invoke<string[]>("list_subdirectories", { dirPath });
}

export async function listDirectory(
  dirPath: string,
  workspace: string,
): Promise<
  {
    name: string;
    path: string;
    is_dir: boolean;
    size: number;
    extension: string | null;
  }[]
> {
  return invoke("list_directory", { dirPath, workspace });
}

export async function readFileContents(filePath: string, workspace: string): Promise<string> {
  return invoke<string>("read_file_contents", { filePath, workspace });
}

export async function writeFileContents(
  filePath: string,
  workspace: string,
  content: string,
): Promise<void> {
  return invoke("write_file_contents", { filePath, workspace, content });
}

// PTY session management
// PTY spawns go through a serialized queue with a small gap between them.
// Each spawn does a fork()+exec() in the backend, and macOS aborts a fork
// child pre-exec when forks happen in a tight burst inside a heavily-threaded
// process (Tauri's embedded WebKit spawns many threads). Restoring a workspace
// fired ~5 spawns within ~70ms, which crashed several fork children
// ("crashed on child side of fork pre-exec"). Spacing the forks lets background
// thread activity settle between them so the children can exec cleanly.
const PTY_SPAWN_GAP_MS = 150;
let ptySpawnQueue: Promise<unknown> = Promise.resolve();

export async function createPtySession(
  projectPath: string,
  cols: number,
  rows: number,
  command: string,
  args: string[] | null,
  env?: Record<string, string> | null,
): Promise<string> {
  const run = async (): Promise<string> => {
    const id = await invoke<string>("create_pty_session", {
      projectPath,
      cols,
      rows,
      command,
      args,
      env: env ?? null,
    });
    await new Promise((resolve) => setTimeout(resolve, PTY_SPAWN_GAP_MS));
    return id;
  };
  // Chain onto the queue regardless of whether the previous spawn succeeded.
  const result = ptySpawnQueue.then(run, run) as Promise<string>;
  ptySpawnQueue = result.catch(() => {});
  return result;
}

export async function writePty(sessionId: string, data: string): Promise<void> {
  return invoke("write_pty", { sessionId, data });
}

export async function resizePty(sessionId: string, cols: number, rows: number): Promise<void> {
  return invoke("resize_pty", { sessionId, cols, rows });
}

export async function probeTerminalShell(
  command: string,
  projectPath: string,
): Promise<TerminalShellProbe> {
  return invoke<TerminalShellProbe>("probe_terminal_shell", { command, projectPath });
}

export async function listWslDistributions(): Promise<string[]> {
  return invoke<string[]>("list_wsl_distributions");
}

export async function killPty(sessionId: string): Promise<void> {
  return invoke("kill_pty", { sessionId });
}

/**
 * Payload for the scoped `pty:exit:{sessionId}` event.
 *
 * Historically this event carried only the bare session-id string; the
 * fields below are additive. Listeners that only used the old shape (or
 * ignore the payload entirely) keep working. `exitCode` is `null` when the
 * backend couldn't read the child's status; `0` is success, non-zero is a
 * failed agent. `terminated` is `true` when an orchestrator action (flight
 * pause/cancel) killed the session, so it must NOT be scored as a
 * successful task completion.
 */
export interface PtyExitPayload {
  sessionId: string;
  exitCode: number | null;
  terminated: boolean;
}

/**
 * What actually happened to a PTY child — four mutually exclusive cases.
 *
 * This replaces the old `ptyExitSucceeded` boolean, which collapsed all four
 * into "success"/"failure" and so made a crashed CLI indistinguishable from a
 * session the user closed on purpose. Every consumer that renders or scores an
 * exit needs the distinction:
 *
 * - `clean`   — exit code 0. The CLI did its job and returned.
 * - `failed`  — a non-zero exit code we actually observed. The CLI died or
 *   refused to run; `exitCode` is worth showing to the user.
 * - `killed`  — PacketBench (or the user through it) terminated the session:
 *   Kill, Restart, pane close, `kill_pty`. A deliberate control action, so it
 *   is NOT a crash — but it is not a successful task completion either, and
 *   consumers that score outcomes must not count it as one. `exitCode` is
 *   whatever the OS reported for the kill and carries no meaning.
 * - `unknown` — no exit status was observed at all: the backend could not read
 *   the child's status, or the frontend only learned the session was gone by
 *   its absence from `list_pty_sessions`. An absence of evidence, never to be
 *   laundered into `clean`.
 */
export type PtyExitOutcome =
  | { kind: "clean" }
  | { kind: "failed"; exitCode: number }
  | { kind: "killed"; exitCode: number | null }
  | { kind: "unknown" };

/** Shared singleton for the "we never saw a status" case. */
export const PTY_EXIT_UNKNOWN: PtyExitOutcome = { kind: "unknown" };

/**
 * Normalize a `pty:exit` event payload across the old (bare session-id
 * string) and new ({@link PtyExitPayload}) shapes. Callers that care about
 * the real outcome should use the returned `exitCode` / `terminated`;
 * callers that only need to know the session ended can ignore them.
 */
export function parsePtyExitPayload(payload: unknown): PtyExitPayload {
  if (payload && typeof payload === "object") {
    const p = payload as Partial<PtyExitPayload>;
    return {
      sessionId: typeof p.sessionId === "string" ? p.sessionId : "",
      exitCode: typeof p.exitCode === "number" ? p.exitCode : null,
      terminated: p.terminated === true,
    };
  }
  // Legacy bare-string payload (session id). It carries no status at all, so
  // the fields stay null/false and {@link ptyExitOutcome} classifies it as
  // `unknown` — NOT as a clean exit.
  return {
    sessionId: typeof payload === "string" ? payload : "",
    exitCode: null,
    terminated: false,
  };
}

/** Classify an already-normalized {@link PtyExitPayload}. */
export function ptyExitOutcomeOf(exit: PtyExitPayload | null): PtyExitOutcome {
  if (!exit) return PTY_EXIT_UNKNOWN;
  // A deliberate kill is scored first: the code the OS reports for a killed
  // process (1 on Windows, 137 on Unix) says nothing about the CLI.
  if (exit.terminated) return { kind: "killed", exitCode: exit.exitCode };
  if (exit.exitCode === null) return PTY_EXIT_UNKNOWN;
  if (exit.exitCode === 0) return { kind: "clean" };
  return { kind: "failed", exitCode: exit.exitCode };
}

/**
 * Classify a raw `pty:exit` event payload.
 *
 * Shared so the terminal pane, the transient-PTY runner and the install
 * verifier cannot drift on what counts as a failure. A legacy bare-string
 * payload carries no status, so it classifies as `unknown` — honest, and
 * distinct from the `clean` it used to be laundered into.
 */
export function ptyExitOutcome(payload: unknown): PtyExitOutcome {
  return ptyExitOutcomeOf(parsePtyExitPayload(payload));
}

/**
 * Human-readable meaning for a non-zero PTY exit code, when we recognise it.
 *
 * The Windows NTSTATUS values are the ones that matter in practice: they are
 * the "this CLI binary is broken, it is not your config" cases, and they are
 * exactly what a `.cmd`-wrapped CLI dying milliseconds after `cmd.exe` started
 * successfully looks like. Codes arrive as the unsigned 32-bit value the OS
 * reported; the `>>> 0` normalization also accepts the sign-wrapped form in
 * case anything upstream narrows to i32.
 */
export function describePtyExitCode(exitCode: number): string | null {
  switch (exitCode >>> 0) {
    case 0xc0000005:
      return "access violation — the CLI crashed on startup";
    case 0xc000007b:
      return "bad image format — 32/64-bit or corrupt executable";
    case 0xc0000135:
      return "a required DLL was not found";
    case 0xc0000139:
      return "entry point not found — mismatched runtime";
    case 0xc000013a:
      return "terminated by Ctrl+C";
    case 0xc0000409:
      return "stack buffer overrun";
    case 126:
      return "command found but not executable";
    case 127:
      return "command not found";
    case 130:
      return "interrupted (SIGINT)";
    case 137:
      return "killed (SIGKILL)";
    case 139:
      return "segmentation fault";
    default:
      return null;
  }
}

/** One-line description of an exit outcome, for tooltips and status lines. */
export function describePtyExitOutcome(outcome: PtyExitOutcome): string {
  switch (outcome.kind) {
    case "clean":
      return "Session ended (exit code 0)";
    case "failed": {
      const why = describePtyExitCode(outcome.exitCode);
      return why
        ? `Session ended — exit code ${outcome.exitCode}: ${why}`
        : `Session ended — exit code ${outcome.exitCode}`;
    }
    case "killed":
      return `Session stopped by ${APP_NAME}`;
    case "unknown":
      return "Session ended — exit status could not be read";
  }
}

/** Short status-pill text for an exit outcome (`null` = nothing to show). */
export function ptyExitPillLabel(outcome: PtyExitOutcome | null): string | null {
  if (!outcome) return null;
  switch (outcome.kind) {
    case "failed":
      return `exit ${outcome.exitCode}`;
    case "killed":
      return "stopped";
    case "unknown":
      return "ended";
    case "clean":
      return null;
  }
}

// Code quality
export interface CrashEntry {
  timestamp: string;
  path: string;
  summary: string;
}

export async function listCrashes(): Promise<CrashEntry[]> {
  return invoke<CrashEntry[]>("list_crashes");
}

export async function readCrash(path: string): Promise<string> {
  return invoke<string>("read_crash", { path });
}

export async function deleteCrash(path: string): Promise<void> {
  await invoke("delete_crash", { path });
}

export async function analyzeCodeQuality(projectPath: string): Promise<CodeQualityReport> {
  return invoke<CodeQualityReport>("analyze_code_quality", { projectPath });
}

// v0.8.8 quality autofix — actionable fixers
export type QualityFixer = "eslint" | "prettier" | "cargo_fix" | "npm_audit_fix";

export interface QualityFixerAvailability {
  eslint: boolean;
  prettier: boolean;
  cargo_fix: boolean;
  npm_audit_fix: boolean;
  prettier_target_count: number | null;
  eslint_fixable_count: number | null;
}

export interface QualityFixRunResult {
  fixer: string;
  run_id: string;
  success: boolean;
  exit_code: number;
  duration_ms: number;
  stdout_tail: string;
  stderr_tail: string;
}

/** Probe a project for which auto-fixers are wired up (eslint config,
 *  prettier config, Cargo.toml, package.json). Cheap — no subprocess. */
export async function codeQualityProbeFixers(
  projectPath: string,
): Promise<QualityFixerAvailability> {
  return invoke<QualityFixerAvailability>("code_quality_probe_fixers", { projectPath });
}

/** Spawn the chosen fixer. The backend streams stdout/stderr via
 *  `quality-fix:chunk:<runId>` Tauri events and a final
 *  `quality-fix:done:<runId>` event. Subscribe BEFORE awaiting this
 *  promise so the first chunk doesn't race with `listen()`. */
export async function codeQualityRunFix(
  projectPath: string,
  fixer: QualityFixer,
  runId: string,
): Promise<QualityFixRunResult> {
  return invoke<QualityFixRunResult>("code_quality_run_fix", {
    projectPath,
    fixer,
    runId,
  });
}

export interface CodeQualityReport {
  total_files: number;
  total_code_lines: number;
  total_lines: number;
  total_comment_lines: number;
  total_blank_lines: number;
  language_count: number;
  languages: {
    name: string;
    extension: string;
    files: number;
    code_lines: number;
    comment_lines: number;
    blank_lines: number;
    total_lines: number;
  }[];
  avg_complexity: number;
  test_files: number;
  test_lines: number;
  top_complex_files: { path: string; language: string; lines: number; complexity: number }[];
  comment_ratio: number;
  test_ratio: number;
  org_score: number;
}

// ---------------------------------------------------------------------------
// Quality runner — multi-check lint/typecheck/test/cargo executor
// ---------------------------------------------------------------------------

/** A single quality check. Mirrors `commands::quality_runner::QualityCheck`
 *  on the Rust side. Pass `null` to `runQualityChecks(checks)` to
 *  auto-detect from the project layout. */
export interface QualityCheck {
  id: string;
  label: string;
  command: string;
  args: string[];
  cwd?: string | null;
  timeoutSecs?: number | null;
  env?: Record<string, string>;
  optional?: boolean;
}

export type QualityCheckStatus =
  | "passed"
  | "failed"
  | "cancelled"
  | "timed-out"
  | "missing-tool"
  | "spawn-error"
  | "skipped";

export interface QualityCheckStartEvent {
  runId: string;
  checkId: string;
  label: string;
  command: string;
  args: string[];
  cwd: string;
  startedAt: number;
}

export interface QualityChunkEvent {
  runId: string;
  checkId: string;
  /** `"stdout"` or `"stderr"`. */
  stream: "stdout" | "stderr";
  line: string;
}

export interface QualityCheckDoneEvent {
  runId: string;
  checkId: string;
  label: string;
  output: string;
  truncated: boolean;
  exitCode: number | null;
  status: QualityCheckStatus;
  error: string | null;
  startedAt: number;
  completedAt: number;
  durationMs: number;
  optional: boolean;
}

export interface QualityRunSummary {
  runId: string;
  projectPath: string;
  checks: QualityCheckDoneEvent[];
  startedAt: number;
  completedAt: number;
  durationMs: number;
  cancelled: boolean;
  allPassed: boolean;
}

/** Best-effort detection of which quality checks make sense for a project.
 *  Reads `package.json` scripts, `Cargo.toml` location, etc. Returns
 *  whatever it finds — the empty list means "no checks configured". */
export async function detectQualityChecks(projectPath: string): Promise<QualityCheck[]> {
  return invoke<QualityCheck[]>("detect_quality_checks", { projectPath });
}

/** Kick off a quality run. Subscribe to the `quality:*:<runId>` events
 *  via `listen()` BEFORE awaiting this — the first chunk can arrive
 *  before this promise resolves. Pass `null` for `checks` to
 *  auto-detect. */
export async function runQualityChecks(
  projectPath: string,
  runId: string,
  checks: QualityCheck[] | null,
): Promise<string> {
  return invoke<string>("run_quality_checks", { projectPath, runId, checks });
}

/** Request cancellation of an in-flight quality run. Returns `true` if
 *  the run existed and was signalled, `false` if there was no such run
 *  (e.g. it already finished). The in-progress child process is killed
 *  via `start_kill` and `kill_on_drop` reaps it. */
export async function cancelQualityRun(runId: string): Promise<boolean> {
  return invoke<boolean>("cancel_quality_run", { runId });
}

/** Tauri event names for the quality runner. Helpers so callers don't
 *  spell the magic strings wrong. */
export const qualityEvents = {
  checkStart: (runId: string) => `quality:check-start:${runId}`,
  chunk: (runId: string) => `quality:chunk:${runId}`,
  checkDone: (runId: string) => `quality:check-done:${runId}`,
  done: (runId: string) => `quality:done:${runId}`,
  error: (runId: string) => `quality:error:${runId}`,
};

/** Request cancellation of an in-flight `code_quality_run_fix`
 *  invocation. Returns `true` if a matching run was active and was
 *  signalled, `false` if no such run was found (e.g. it already
 *  completed). Mirrors `cancelQualityRun` semantics — the running
 *  child is `start_kill`'d via a shared slot so cancellation lands
 *  within milliseconds. */
export async function cancelQualityFix(runId: string): Promise<boolean> {
  return invoke<boolean>("cancel_quality_fix", { runId });
}

// Memory

export async function saveServersSlice(servers: ServerConfig[]): Promise<void> {
  return invoke("save_servers_slice", { servers });
}

/**
 * Sticky per-project CLI-account choice: `project path -> cli -> account id`.
 * A `Partial` inner record because a project may have picked an account for
 * one CLI and not the other.
 */
export type CliAccountDefaults = Record<string, Partial<Record<CliAccountCli, string>>>;

/**
 * Persist the CLI-account slice. Accounts and their sticky defaults travel
 * together — a default naming an account that did not survive the same write
 * would silently route the next session to the ambient login.
 *
 * Mirrors `saveServersSlice`: the store owns the list and re-sends the whole
 * slice on every mutation, so the backend never merges.
 */
export async function saveCliAccountsSlice(
  accounts: CliAccount[],
  defaults: CliAccountDefaults,
): Promise<void> {
  return invoke("save_cli_accounts_slice", {
    accounts: accounts.map(toDtoCliAccount),
    defaults,
  });
}

export async function saveMemorySlice(
  memoryEvents: MemoryEvent[],
  memoryPatterns?: LearnedPattern[],
): Promise<void> {
  return invoke("save_memory_slice", { memoryEvents, memoryPatterns: memoryPatterns ?? [] });
}

/**
 * v0.8-H — atomically flip the `pinned` flag on a single learned pattern.
 * Returns the new pinned state, or `null` if no pattern matched the id
 * (e.g. it was deleted on a different tab between the click and the call).
 * The memory store also mirrors the change in-memory so the UI is snappy.
 */
export async function togglePinnedPattern(patternId: string): Promise<boolean | null> {
  return invoke<boolean | null>("toggle_pinned_pattern", { patternId });
}

export async function summarizeSession(projectPath: string, sessionLog: string): Promise<string> {
  return invoke<string>("summarize_session", { projectPath, sessionLog });
}

export async function extractPatterns(projectPath: string, summaries: string): Promise<string> {
  return invoke<string>("extract_patterns", { projectPath, summaries });
}

/**
 * Result of a codebase key-file scan. Mirrors the Rust
 * `commands::memory::CodebaseScanResult`.
 *
 * `response` is the model's raw JSON array (`[{path, summary}]`); every other
 * field describes the local walk that produced the manifest, straight from
 * `core::aux_context::ScanStats`. The model cannot know whether a bound
 * clipped the walk, so `truncated` is the only trustworthy answer to "did I
 * see the whole project?" — the UI must not present a truncated scan as a
 * complete one.
 */
export interface CodebaseScanResult {
  response: string;
  filesListed: number;
  filesSeen: number;
  excerptCount: number;
  symlinksSkipped: number;
  sensitiveSkipped: number;
  truncated: boolean;
  timedOut: boolean;
}

/**
 * Walk a LOCAL project (this machine's filesystem only) and index its key
 * files through the `memory-scan` auxiliary route. Rejects — before reading a
 * single file — when no auxiliary provider is configured.
 */
export async function scanCodebaseMemory(projectPath: string): Promise<CodebaseScanResult> {
  return invoke<CodebaseScanResult>("scan_codebase_memory", { projectPath });
}

/** M9: input to the `summarize_flight` LLM retrospective. Mirrors the Rust
 *  `FlightSummaryInput` DTO, which carries `#[serde(rename_all = "camelCase")]`
 *  so these camelCase keys deserialize into its snake_case fields (Tauri only
 *  auto-converts the top-level command args, not nested struct fields). */
export interface FlightSummaryInput {
  title: string;
  objective: string;
  priority: string;
  status: string;
  taskCount: number;
  tasksDone: number;
  tasksFailed: number;
  durationDescription: string;
}

/** M9: generate a rich flight retrospective (returns the model's JSON string). */
export async function summarizeFlight(
  projectPath: string,
  flightSummary: FlightSummaryInput,
  sessionLogs: string,
): Promise<string> {
  return invoke<string>("summarize_flight", { projectPath, flightSummary, sessionLogs });
}

export async function listProjectMemory(projectPath: string): Promise<ProjectMemorySnapshot> {
  return invoke<ProjectMemorySnapshot>("list_project_memory", { projectPath });
}

export async function createProjectMemory(
  projectPath: string,
  input: CreateProjectMemoryInput,
): Promise<ProjectMemoryNote> {
  return invoke<ProjectMemoryNote>("create_project_memory", { projectPath, input });
}

export async function updateProjectMemory(
  projectPath: string,
  input: UpdateProjectMemoryInput,
): Promise<ProjectMemoryNote> {
  return invoke<ProjectMemoryNote>("update_project_memory", { projectPath, input });
}

export async function archiveProjectMemory(
  projectPath: string,
  id: string,
  expectedRevision: string,
): Promise<ProjectMemoryNote> {
  return invoke<ProjectMemoryNote>("archive_project_memory", {
    projectPath,
    id,
    expectedRevision,
  });
}

export async function watchProjectMemory(projectPath: string): Promise<void> {
  return invoke("watch_project_memory", { projectPath });
}

// Git
export async function getGitBranch(projectPath: string): Promise<string> {
  return invoke<string>("get_git_branch", { projectPath });
}

export async function getGitStatus(projectPath: string): Promise<string> {
  return invoke<string>("get_git_status", { projectPath });
}

/** Phase 3.3: minimum SSH config the remote git commands need. The
 *  frontend builds this by looking up the workspace's `serverId` in
 *  `serverStore`. Field names are camelCase so the Tauri layer can
 *  deserialize them via `#[serde(rename_all = "camelCase")]`. */
export interface GitServerConfigInput {
  id: string;
  host: string;
  port: number;
  username: string;
  keyPath?: string | null;
  hostFingerprint?: string | null;
}

/** Convert a saved `ServerConfig` to the minimum shape the remote git +
 *  clone commands accept. Centralised so callers can't accidentally
 *  forget to forward `hostFingerprint` (which would silently downgrade
 *  to TOFU). */
export function toGitServerConfigInput(server: ServerConfig): GitServerConfigInput {
  return {
    id: server.id,
    host: server.host,
    port: server.port,
    username: server.username,
    keyPath: server.keyPath ?? null,
    hostFingerprint: server.hostFingerprint ?? null,
  };
}

/** Phase 3.3: remote variant of `getGitBranch`. Runs `git rev-parse
 *  --abbrev-ref HEAD` on the remote host described by `serverConfig`. */
export async function getGitBranchRemote(
  serverConfig: GitServerConfigInput,
  remotePath: string,
): Promise<string> {
  return invoke<string>("get_git_branch_remote", { serverConfig, remotePath });
}

/** Phase 3.3: remote variant of `getGitStatus`. Returns `git status
 *  --short` output verbatim so the existing parser keeps working. */
export async function getGitStatusRemote(
  serverConfig: GitServerConfigInput,
  remotePath: string,
): Promise<string> {
  return invoke<string>("get_git_status_remote", { serverConfig, remotePath });
}

export interface GitReviewEvidence {
  baseRef: string;
  headRef: string;
  diffSummary: string;
  changedPaths: string[];
  patch: string;
  patchTruncated: boolean;
}

/** Collect a bounded git evidence packet for the Flight Reviewer Gate.
 * `serverConfig` selects SSH execution; null runs against the local worktree. */
export async function getGitReviewEvidence(
  projectPath: string,
  baseRef: string,
  serverConfig: GitServerConfigInput | null,
  maxPatchBytes = 65_536,
): Promise<GitReviewEvidence> {
  return invoke<GitReviewEvidence>("get_git_review_evidence", {
    projectPath,
    baseRef,
    serverConfig,
    maxPatchBytes,
  });
}

export interface PreparedFlightIntegrationBranch {
  branch: string;
  baseBranch: string;
  baseSha: string;
  headSha: string;
  worktreePath: string;
}

export async function prepareFlightIntegrationBranch(
  projectPath: string,
  flightId: string,
  baseBranch: string,
  serverConfig: GitServerConfigInput | null,
): Promise<PreparedFlightIntegrationBranch> {
  return invoke<PreparedFlightIntegrationBranch>("prepare_flight_integration_branch", {
    projectPath,
    flightId,
    baseBranch,
    serverConfig,
  });
}

export interface FlightIntegrationMergeResult {
  headSha: string;
  conflictFiles: string[];
}

export async function integrateFlightAttempt(args: {
  integrationPath: string;
  integrationBranch: string;
  attemptPath: string;
  attemptBranch: string;
  serverConfig: GitServerConfigInput | null;
}): Promise<FlightIntegrationMergeResult> {
  return invoke<FlightIntegrationMergeResult>("integrate_flight_attempt", {
    integrationPath: args.integrationPath,
    integrationBranch: args.integrationBranch,
    attemptPath: args.attemptPath,
    attemptBranch: args.attemptBranch,
    serverConfig: args.serverConfig,
  });
}

export async function landFlightIntegration(args: {
  projectPath: string;
  baseBranch: string;
  integrationBranch: string;
  serverConfig: GitServerConfigInput | null;
}): Promise<string> {
  return invoke<string>("land_flight_integration", {
    projectPath: args.projectPath,
    baseBranch: args.baseBranch,
    integrationBranch: args.integrationBranch,
    serverConfig: args.serverConfig,
  });
}

/** Remote write variants of the git dashboard commands (over SSH). */
export async function gitStageFilesRemote(
  serverConfig: GitServerConfigInput,
  remotePath: string,
  paths: string[],
): Promise<string> {
  return invoke<string>("git_stage_files_remote", { serverConfig, remotePath, paths });
}

export async function gitUnstageFilesRemote(
  serverConfig: GitServerConfigInput,
  remotePath: string,
  paths: string[],
): Promise<string> {
  return invoke<string>("git_unstage_files_remote", { serverConfig, remotePath, paths });
}

export async function gitCommitRemote(
  serverConfig: GitServerConfigInput,
  remotePath: string,
  message: string,
): Promise<string> {
  return invoke<string>("git_commit_remote", { serverConfig, remotePath, message });
}

export async function gitPushRemote(
  serverConfig: GitServerConfigInput,
  remotePath: string,
): Promise<string> {
  return invoke<string>("git_push_remote", { serverConfig, remotePath });
}

export async function gitPullRemote(
  serverConfig: GitServerConfigInput,
  remotePath: string,
): Promise<string> {
  return invoke<string>("git_pull_remote", { serverConfig, remotePath });
}

/** S3: HEAD blob + working content of one file on a remote SSH workspace, for
 *  the per-file diff viewer (fed into the same buildDiffRows renderer as local).
 *  Either side is null when absent (new file → no head; deleted → no work). */
export interface RemoteFileDiff {
  head: string | null;
  work: string | null;
}

export async function gitDiffFileRemote(
  serverConfig: GitServerConfigInput,
  remotePath: string,
  oldPath: string,
  newPath: string,
): Promise<RemoteFileDiff> {
  return invoke<RemoteFileDiff>("git_diff_file_remote", {
    serverConfig,
    remotePath,
    oldPath,
    newPath,
  });
}

export async function gitCreateBranchRemote(
  serverConfig: GitServerConfigInput,
  remotePath: string,
  branchName: string,
  checkout: boolean,
): Promise<string> {
  return invoke<string>("git_create_branch_remote", {
    serverConfig,
    remotePath,
    branchName,
    checkout,
  });
}

/** Phase 3.2: clone `repoUrl` into `destPath` on the SSH host. Returns
 *  the remote path that was created plus the freshly-cloned default
 *  branch (`git rev-parse --abbrev-ref HEAD`). The Tauri layer
 *  validates `branch`, `destPath`, and `repoUrl` against a tight
 *  allowlist before running anything on the remote shell. */
export interface CloneRemoteResult {
  remotePath: string;
  defaultBranch: string;
}

export async function cloneRepoRemote(args: {
  serverId: string;
  serverConfig: GitServerConfigInput;
  repoUrl: string;
  destPath: string;
  branch?: string | null;
}): Promise<CloneRemoteResult> {
  return invoke<CloneRemoteResult>("clone_repo_remote", {
    serverId: args.serverId,
    serverConfig: args.serverConfig,
    repoUrl: args.repoUrl,
    destPath: args.destPath,
    branch: args.branch ?? null,
  });
}

/**
 * Commit staged changes in `projectPath` with the given message.
 *
 * v0.8.5 — close-loop side effect: after the commit succeeds, the Rust
 * side re-reads the final HEAD commit message (so any
 * prepare-commit-msg auto-trailers are included) and scans it for
 * `Fixes #N` / `Closes #N` / `Resolves #N` trailers. When a trailer
 * resolves to a known local Issue (matched by the numeric tail of its
 * `ticketId`), the backend emits an `issue-watcher:fixed` Tauri event
 * with the shape:
 *
 * ```
 * { issueId, ticketId, issueNumber, commitSha, commitSubject }
 * ```
 *
 * The frontend listener in `issueStore.ts` consumes this and flips the
 * Issue to `done` (plus a system audit comment). External commits made
 * directly via the terminal bypass this path; the trailer-installed
 * worktree hook still appends `Fixes #N` to them, but only commits made
 * through `gitCommit` trigger the synchronous watcher.
 */
export async function gitCommit(
  projectPath: string,
  message: string,
  stageAll: boolean,
  context?: {
    flightId?: string | null;
    taskId?: string | null;
    attemptId?: string | null;
    conversationId?: string | null;
    sessionId?: string | null;
  } | null,
): Promise<string> {
  return invoke<string>("git_commit", {
    projectPath,
    message,
    stageAll,
    context: context
      ? {
          flightId: context.flightId ?? null,
          taskId: context.taskId ?? null,
          attemptId: context.attemptId ?? null,
          conversationId: context.conversationId ?? null,
          sessionId: context.sessionId ?? null,
        }
      : null,
  });
}

export async function gitPush(projectPath: string): Promise<string> {
  return invoke<string>("git_push", { projectPath });
}

export async function gitPull(projectPath: string): Promise<string> {
  return invoke<string>("git_pull", { projectPath });
}

export async function gitCreateBranch(
  projectPath: string,
  branchName: string,
  checkout: boolean,
): Promise<string> {
  return invoke<string>("git_create_branch", { projectPath, branchName, checkout });
}

/** P1-15: explicit `git add -- <paths>` for the per-file staging control
 *  in GitDashboard. `git_commit` rejects `stage_all` commits, so this is
 *  the only path that puts changes in the index through the in-app flow. */
export async function gitStageFiles(projectPath: string, paths: string[]): Promise<string> {
  return invoke<string>("git_stage_files", { projectPath, paths });
}

/** P1-15: explicit `git restore --staged -- <paths>` — the unstage
 *  counterpart of `gitStageFiles`. */
export async function gitUnstageFiles(projectPath: string, paths: string[]): Promise<string> {
  return invoke<string>("git_unstage_files", { projectPath, paths });
}

/**
 * v0.8-15: read `git remote get-url origin` for a project path. Returns
 * the remote URL when configured, `null` when the repo has no `origin`
 * remote, and throws when the path is not a git repo or git fails to
 * spawn. Used by `WorkspaceCreationModal` to auto-bind the new
 * workspace to its GitHub repo.
 */
export async function gitGetOriginUrl(projectPath: string): Promise<string | null> {
  return invoke<string | null>("git_get_origin_url", { projectPath });
}

/**
 * T3.F: provision a git worktree for an Agents-pane conversation. Returns
 * the absolute path the conversation should use as its `projectPath` so
 * every tool call lands inside the worktree on a dedicated branch
 * (`pkt/<convId>`). Idempotent.
 */
export async function createConversationWorktree(
  projectPath: string,
  convId: string,
  baseBranch: string,
): Promise<string> {
  return invoke<string>("create_conversation_worktree", {
    projectPath,
    convId,
    baseBranch,
  });
}

/**
 * P2-S2: tear down a conversation worktree. `deleteBranch` (default false)
 * additionally force-deletes the `pkt/<convId>` branch after the worktree dir is
 * removed — the Discard path passes true so a discarded conversation leaves no
 * dangling branch (the plain `git worktree remove --force` on the Rust side
 * otherwise leaks it). Idempotent — a missing worktree succeeds.
 */
export async function removeConversationWorktree(
  projectPath: string,
  convId: string,
  deleteBranch = false,
): Promise<void> {
  return invoke("remove_conversation_worktree", { projectPath, convId, deleteBranch });
}

/**
 * P2-S1: outcome of a successful {@link mergeConversationBranch}. Mirrors the
 * Rust `MergeBranchOutcome`. The two cleanup flags are non-fatal — the merge
 * already landed; a `false` only means post-merge cleanup was incomplete.
 */
export interface MergeBranchOutcome {
  /** SHA after the squash commit (unchanged prior HEAD if already merged). */
  commitSha: string;
  /** The `pkt/<convId>` branch was force-deleted (`-D`). */
  branchDeleted: boolean;
  /** The conversation worktree directory was removed. */
  worktreeRemoved: boolean;
  /** The squash produced no commit — the branch had no changes vs. the root.
   * When true NOTHING was landed: the caller must NOT flip `state → "landed"`
   * (no commit, worktree + branch left in place for an explicit Discard). */
  nothingToLand: boolean;
}

/**
 * P2-S1: land a conversation's `pkt/<convId>` branch into the root checkout
 * by squash-merging (default). Ruled safety semantics: refuses on a dirty
 * root; on conflict leaves both the root checkout and the worktree
 * byte-intact and rejects; on success force-deletes the branch and removes
 * the worktree dir. The returned outcome lets the caller flip
 * `worktree.state -> "landed"`.
 */
export async function mergeConversationBranch(
  projectPath: string,
  branch: string,
  squash = true,
): Promise<MergeBranchOutcome> {
  return invoke<MergeBranchOutcome>("merge_conversation_branch", {
    projectPath,
    branch,
    squash,
  });
}

/**
 * v0.8.5 fix: provision a git worktree bound to a specific Issue. The
 * Rust side installs a `prepare-commit-msg` hook that appends
 * `Fixes #{issueNumber}` and `Run-By: PacketBench issue I-{issueId}` to
 * every commit, so the `git_commit` watcher can flip the matching
 * Issue to `done` via the `issue-watcher:fixed` event. Returns the
 * absolute worktree path the workspace should use as its
 * `projectPath`. Idempotent.
 */
export async function createIssueWorktree(
  issueId: string,
  issueNumber: number,
  issueTitle: string,
  projectPath: string,
): Promise<string> {
  return invoke<string>("create_issue_worktree", {
    issueId,
    issueNumber,
    issueTitle,
    projectPath,
  });
}

/**
 * A4: resolve the AGENTS.md / CLAUDE.md cascade for `cwd`. Walks
 * `~/.claude/AGENTS{.override,}.md` → git-root → cwd, picks one of
 * `AGENTS.override.md` / `AGENTS.md` / `CLAUDE.md` per directory,
 * concatenates root → leaf with source-attribution headers, caps at
 * 32 KiB. Returns null when nothing was found anywhere.
 */
export async function resolveAgentsMd(cwd: string): Promise<string | null> {
  return invoke<string | null>("resolve_agents_md", { cwd });
}

export async function readStatusLineStates(): Promise<StatusLineData[]> {
  return invoke<StatusLineData[]>("read_statusline_states");
}

export async function readCodexStatusLineStates(): Promise<CodexStatusLineData[]> {
  return invoke<CodexStatusLineData[]>("read_codex_statusline_states");
}

export async function readOpenCodeStatusLineStates(): Promise<OpenCodeStatusLineData[]> {
  return invoke<OpenCodeStatusLineData[]>("read_opencode_statusline_states");
}

// PTY session management (extended)
export async function killPtyAndWait(
  sessionId: string,
  timeoutMs: number = 5000,
): Promise<boolean> {
  return invoke<boolean>("kill_pty_and_wait", { sessionId, timeoutMs });
}

export async function listPtySessions(): Promise<
  { id: string; project_path: string; pid: number | null; alive: boolean }[]
> {
  return invoke("list_pty_sessions");
}

export async function readPtyTranscript(
  sessionId: string,
): Promise<{ session_id: string; data: string; truncated: boolean; sequence?: number }> {
  return invoke("read_pty_transcript", { sessionId });
}

// SSH helpers
export async function sshExec(commandArgs: string[], password?: string | null): Promise<string> {
  return invoke<string>("ssh_exec", { commandArgs, password: password ?? null });
}

/** One discovered SSH host key — matches `commands::pty::HostKey`. */
export interface HostKey {
  algorithm: string;
  /** Raw `known_hosts`-format line from `ssh-keyscan`. */
  key: string;
  /** SHA256:<base64> fingerprint derived via `ssh-keygen -lf -`. */
  fingerprint: string;
}

/** Run `ssh-keyscan` on a host and return its public host keys + SHA256
 *  fingerprints. Used by the Servers UI on first save so the user can
 *  verify and pin the host key before any traffic is sent. */
export async function sshFetchFingerprint(host: string, port: number): Promise<HostKey[]> {
  return invoke<HostKey[]>("ssh_fetch_fingerprint", { host, port });
}

/** Append a `known_hosts`-format line to the app-managed known_hosts
 *  file. Called after the user confirms the fingerprint shown by
 *  `sshFetchFingerprint`. Idempotent. */
export async function sshPinHost(host: string, port: number, hostkeyLine: string): Promise<void> {
  return invoke("ssh_pin_host", { host, port, hostkeyLine });
}

/** Absolute path of the app-managed `known_hosts` file. Fetch once at
 *  startup and cache in `serverStore.knownHostsPath`. */
export async function getAppKnownHostsPath(): Promise<string> {
  return invoke<string>("get_app_known_hosts_path");
}

/** Result of probing a remote filesystem path over SSH. */
export interface RemotePathCheck {
  exists: boolean;
  isDirectory: boolean;
  isGitRepo: boolean;
}

/** Probe a remote SSH host to check whether `remotePath` exists, is a
 *  directory, and contains `.git`. Used by the workspace creation modal
 *  for live validation of the "Remote project path" input. Times out at
 *  8s. When `hostFingerprint` is provided, SSH connects with strict
 *  host-key checking against the app-managed known_hosts file. */
export async function sshCheckRemotePath(args: {
  targetId?: string | null;
  host: string;
  port: number;
  user: string;
  authMethod: "agent" | "key" | "password";
  keyPath?: string | null;
  password?: string | null;
  hostFingerprint?: string | null;
  remotePath: string;
}): Promise<RemotePathCheck> {
  return invoke<RemotePathCheck>("ssh_check_remote_path", {
    targetId: args.targetId ?? null,
    host: args.host,
    port: args.port,
    user: args.user,
    authMethod: args.authMethod,
    keyPath: args.keyPath ?? null,
    password: args.password ?? null,
    hostFingerprint: args.hostFingerprint ?? null,
    remotePath: args.remotePath,
  });
}

export async function getSshPasswordExists(targetId: string): Promise<boolean> {
  return invoke<boolean>("get_ssh_password_exists", { targetId });
}

/** Store a remote-server password in the OS credential store. The password is
 * never part of `ServerConfig` or any persisted frontend state. */
export async function setSshPassword(serverId: string, password: string): Promise<void> {
  return invoke("set_ssh_password", { serverId, password });
}

/**
 * Purge the OS-keyring password for a server (current + legacy service).
 * Called when a `ServerConfig` is deleted — otherwise the secret outlives the
 * record forever. Missing credential = success, so key/agent-auth hosts are a
 * no-op.
 */
export async function deleteSshPassword(serverId: string): Promise<void> {
  return invoke("delete_ssh_password", { serverId });
}

// Async parallel agent attempts (Flight Deck "one prompt → N agents")
export type AttemptTargetSpec =
  | {
      kind: "local";
      basePath: string;
      baseBranch: string;
      agentConfigId: string;
      provider: string;
      model: string;
      taskId?: string;
    }
  | {
      kind: "ssh";
      targetId: string;
      host: string;
      port: number;
      user: string;
      keyPath?: string | null;
      authMethod?: "agent" | "key" | "password" | null;
      /** Phase 2: pinned SHA256 host-key fingerprint, copied from
       *  `ServerConfig.hostFingerprint`. When omitted, the per-attempt
       *  SSH connection falls back to TOFU `accept-new` and the Rust
       *  side logs a warning. */
      hostFingerprint?: string | null;
      basePath: string;
      baseBranch: string;
      agentConfigId: string;
      provider: string;
      model: string;
      taskId?: string;
    };

export async function launchFlightAsync(
  flightId: string,
  prompt: string,
  targets: AttemptTargetSpec[],
  options: { allowPathCollisions?: boolean } = {},
): Promise<Attempt[]> {
  const dtoTargets = targets.map((t) => {
    if (t.kind === "local") {
      return {
        kind: "local",
        base_path: t.basePath,
        base_branch: t.baseBranch,
        agent_config_id: t.agentConfigId,
        provider: t.provider,
        model: t.model,
        task_id: t.taskId ?? null,
      };
    }
    return {
      kind: "ssh",
      target_id: t.targetId,
      host: t.host,
      port: t.port,
      user: t.user,
      key_path: t.keyPath ?? null,
      auth_method: t.authMethod ?? null,
      host_fingerprint: t.hostFingerprint ?? null,
      base_path: t.basePath,
      base_branch: t.baseBranch,
      agent_config_id: t.agentConfigId,
      provider: t.provider,
      model: t.model,
      task_id: t.taskId ?? null,
    };
  });
  const dtoAttempts = await invoke<PersistedStateDto["flights"][number]["attempts"]>(
    "launch_flight_async",
    {
      flightId,
      prompt,
      targets: dtoTargets,
      allowPathCollisions: options.allowPathCollisions ?? false,
    },
  );
  return dtoAttempts.map(fromDtoAttempt);
}

/**
 * Outcome of a best-effort git worktree teardown (`core::worktree::WorktreeCleanupOutcome`).
 *
 * Removal failures are reported as DATA: the attempt is still cancelled and
 * the Flight is still deleted, but the caller can tell the user that a
 * worktree is still on disk instead of showing a clean delete. Before this
 * existed the Rust side `warn!`-logged every failure and returned success.
 */
export interface WorktreeCleanupOutcome {
  /** The worktree we tried to remove — named so the user can finish by hand. */
  worktreePath: string;
  /** True when nothing is left behind (removed now, or already absent). */
  removed: boolean;
  branch: string | null;
  branchDeleted: boolean;
  /** Why the branch survived (unmerged work). Only set when deletion was asked for. */
  branchRetained: string | null;
  /** Uncommitted lines seen immediately before a forced removal. */
  dirtyPaths: string[];
  /** Non-fatal failure message; present ⇒ `removed` is false. */
  error: string | null;
  /** Could not even be attempted here (SSH server record is gone). */
  deferred: boolean;
}

/** True when a teardown outcome is something the user must be told about. */
export function worktreeCleanupNeedsAttention(outcome: WorktreeCleanupOutcome): boolean {
  return Boolean(outcome.error) || outcome.deferred || !outcome.removed;
}

export async function cancelFlightAttempt(
  flightId: string,
  attemptId: string,
): Promise<WorktreeCleanupOutcome> {
  return invoke("cancel_flight_attempt", { flightId, attemptId });
}

/**
 * Remove a Flight's cooperative integration worktree (and, when asked, its
 * `packetbench/flight/<id>` branch). Flight-keyed rather than attempt-keyed, so
 * none of the attempt cleanup commands can reach it — without this a deleted
 * cooperative Flight left `.pkt-flight-integrations/<id>` behind forever.
 *
 * Branch deletion is the SAFE `git branch -d`; an unmerged branch is retained
 * and reported in `branchRetained` rather than force-deleted.
 */
export async function cleanupFlightIntegrationWorktree(args: {
  flightId: string;
  basePath: string;
  /** Saved SSH server id for a remote integration worktree; null for local. */
  serverId?: string | null;
  deleteBranch: boolean;
}): Promise<WorktreeCleanupOutcome> {
  return invoke("cleanup_flight_integration_worktree", {
    flightId: args.flightId,
    basePath: args.basePath,
    serverId: args.serverId ?? null,
    deleteBranch: args.deleteBranch,
  });
}

export async function cleanupAttemptWorktreeSsh(args: {
  flightId: string;
  attemptId: string;
  host: string;
  port: number;
  user: string;
  keyPath?: string | null;
  basePath: string;
  targetId: string;
  /** Phase 2: pinned SHA256 host-key fingerprint, sourced from the saved
   *  `ServerConfig.hostFingerprint`. */
  hostFingerprint?: string | null;
}): Promise<void> {
  return invoke("cleanup_attempt_worktree_ssh", {
    flightId: args.flightId,
    attemptId: args.attemptId,
    host: args.host,
    port: args.port,
    user: args.user,
    keyPath: args.keyPath ?? null,
    basePath: args.basePath,
    targetId: args.targetId,
    hostFingerprint: args.hostFingerprint ?? null,
  });
}

export async function markAttemptStatus(
  flightId: string,
  attemptId: string,
  status: "reviewing" | "completed" | "failed" | "cancelled",
): Promise<WorktreeCleanupOutcome | null> {
  // Terminal statuses tear the worktree down and report the outcome; a
  // non-terminal transition returns null (nothing was removed).
  return invoke("mark_attempt_status", { flightId, attemptId, status });
}

/**
 * Persist an attempt's Reviewer Gate record.
 *
 * The gate is backend-owned like every other attempt lifecycle field: the
 * Rust snapshot merge keeps its own copy of an existing attempt, so a
 * `reviewGate` written into a whole-slice flight save is discarded and
 * `mark_attempt_status("completed")` would never see a verdict. Write through
 * here instead of relying on `flightStore` persistence.
 *
 * Pass `null` to clear the record.
 */
export async function setAttemptReviewGate(
  flightId: string,
  attemptId: string,
  reviewGate: AttemptReviewGate | null,
): Promise<void> {
  return invoke("set_attempt_review_gate", { flightId, attemptId, reviewGate });
}

// Git safety check
export type GitSafetyReport = {
  isGitRepo: boolean;
  branch: string | null;
  hasUpstream: boolean;
  isClean: boolean;
  uncommittedCount: number;
  behindUpstream: number;
  warnings: string[];
};

export async function gitSafetyCheck(projectPath: string): Promise<GitSafetyReport> {
  const payload = await invoke<{
    is_git_repo: boolean;
    branch: string | null;
    has_upstream: boolean;
    is_clean: boolean;
    uncommitted_count: number;
    behind_upstream: number;
    warnings: string[];
  }>("git_safety_check", { projectPath });
  return {
    isGitRepo: payload.is_git_repo,
    branch: payload.branch,
    hasUpstream: payload.has_upstream,
    isClean: payload.is_clean,
    uncommittedCount: payload.uncommitted_count,
    behindUpstream: payload.behind_upstream,
    warnings: payload.warnings,
  };
}

// Agent detection
export async function detectAgent(command: string): Promise<boolean> {
  return invoke<boolean>("detect_agent", { command });
}

// v0.8.3 cli detection — captures version + resolved path for each catalog entry.
// v0.8.7: optional `manualPath` lets the user pin detection to a specific
// absolute binary path, bypassing PATH lookup.
export interface DetectCatalogItem {
  id: string;
  binary: string;
  manualPath?: string;
}

/**
 * Which tier of the shared Rust launch resolver
 * (`core::agent::CliLaunchSource`) chose a CLI's binary. The SAME resolver
 * runs on the PTY spawn path, so a reported path is the path that launches.
 */
export type CliLaunchSource =
  | "settings"
  | "legacyPin"
  | "path"
  | "installerLocation"
  | "bareName";

export interface DetectCatalogResult {
  id: string;
  installed: boolean;
  version: string | null;
  path: string | null;
  /** Resolution tier that chose `path`; null when nothing resolved. */
  source: CliLaunchSource | null;
}

export async function detectCliCatalog(
  items: Array<DetectCatalogItem>,
): Promise<DetectCatalogResult[]> {
  return invoke<DetectCatalogResult[]>("detect_cli_catalog", { items });
}

export interface CliLaunchInspection {
  command: string;
  path: string;
  source: CliLaunchSource;
  /** False when resolution fell through to the bare command name. */
  resolved: boolean;
  version: string | null;
  rejectedSettingsPath: string | null;
}

/** Resolve one CLI command exactly as a Workspace PTY pane would. */
export async function inspectCliLaunch(
  command: string,
  manualPath?: string | null,
): Promise<CliLaunchInspection> {
  return invoke<CliLaunchInspection>("inspect_cli_launch", {
    command,
    manualPath: manualPath?.trim() || null,
  });
}

/**
 * Redacted, pasteable launch-resolution report: per CLI, its id, resolved
 * path, tier and version — and nothing else. Home directories are abbreviated
 * to `~`; no keys, tokens, or environment are included.
 */
export async function cliLaunchDiagnostics(
  items: Array<DetectCatalogItem>,
): Promise<string> {
  return invoke<string>("cli_launch_diagnostics", { items });
}

export interface PacketCodeProviderSummary {
  configured: number;
  ready: number;
  warning: number;
  failed: number;
}

export interface PacketCodeIntegrationProbe {
  healthy: boolean;
  executablePath: string;
  version: string;
  exitCode: number | null;
  schemaVersion: number;
  doctorStatus: "ok" | "warn" | "fail";
  effectiveHome: string | null;
  homeSource: "default" | "environment" | null;
  providerSummary: PacketCodeProviderSummary;
  doctor: Record<string, unknown>;
}

/** @deprecated PacketCode is no longer special — use {@link CliLaunchSource}. */
export type PacketCodeLaunchSource = CliLaunchSource;

export interface PacketCodeInstallationInspection {
  installerExecutablePath: string;
  installerVersion: string | null;
  activeExecutablePath: string | null;
  activeVersion: string | null;
  activeSource: CliLaunchSource | null;
  workspaceUsesInstaller: boolean;
}

export async function inspectPacketCodeInstallation(
  manualPath?: string | null,
): Promise<PacketCodeInstallationInspection> {
  return invoke<PacketCodeInstallationInspection>("inspect_packetcode_installation", {
    manualPath: manualPath?.trim() || null,
  });
}

export async function probePacketCodeIntegration(
  manualPath?: string | null,
  dataHome?: string | null,
): Promise<PacketCodeIntegrationProbe> {
  return invoke<PacketCodeIntegrationProbe>("probe_packetcode_integration", {
    manualPath: manualPath?.trim() || null,
    dataHome: dataHome?.trim() || null,
  });
}

type PersistedSettings = {
  maxParallelSessions: number;
  milestoneGating: boolean;
  projectPath: string;
  /** v0.8: when true, the worktree provisioner installs a
   * prepare-commit-msg hook with the configured trailer. Optional in
   * the TS surface so older persisted states round-trip cleanly. */
  autoCommitTrailerEnabled?: boolean;
  /** v0.8: format string for the auto-trailer (placeholders:
   * `{flightId}`, `{attemptId}`, `{flightTitle}`). */
  autoCommitTrailerFormat?: string;
  autonomyDefaultMode?: "assisted" | "yolo";
  autonomyDefaultPolicy?: import("@/types/flight").AutonomyPolicy;
};

type PersistedUi = {
  selectedFlightId?: string | null;
  selectedView?: string | null;
  theme?: "dark" | "light" | null;
  /** IANA zone name. `null`/`""`/absent all mean "follow the host zone". */
  timeZone?: string | null;
};

export type PersistedState = {
  version: number;
  flights: Flight[];
  agents: AgentConfig[];
  issues: Issue[];
  settings: PersistedSettings;
  ui: PersistedUi;
  workspaces: Workspace[];
  memoryEvents: MemoryEvent[];
  memoryPatterns: LearnedPattern[];
  servers: ServerConfig[];
  /** Named per-CLI logins — see `src/types/cliAccount.ts`. */
  cliAccounts: CliAccount[];
  /** Sticky per-project account choice: `project path -> cli -> account id`. */
  cliAccountDefaults: CliAccountDefaults;
};

function normalizeOptionalRecord(record?: {
  [key: string]: string | null | undefined;
}): Record<string, string | null> | undefined {
  if (!record) return undefined;
  const normalized: Record<string, string | null> = {};
  for (const [key, value] of Object.entries(record)) {
    if (value !== undefined) {
      normalized[key] = value;
    }
  }
  return normalized;
}

function toOptional<T>(value: T | null | undefined): T | undefined {
  return value ?? undefined;
}

function toUiPatchString(value: string | null | undefined): string | undefined {
  if (value === undefined) return undefined;
  return value ?? "";
}

function fromDtoAgent(agent: AgentConfigDto): AgentConfig {
  return {
    id: agent.id,
    name: agent.name,
    command: agent.command,
    defaultArgs: agent.defaultArgs,
    description: agent.description,
    installed: agent.installed,
    capabilities: agent.capabilities,
    icon: agent.icon,
    color: agent.color,
    statusPatterns: {
      approval: agent.statusPatterns.approval,
      thinking: agent.statusPatterns.thinking,
      toolUse: agent.statusPatterns.toolUse.map((tool) => ({
        pattern: tool.pattern,
        tool: tool.tool,
        fileGroup: tool.fileGroup,
      })),
      idle: agent.statusPatterns.idle,
    },
    approvalActions: agent.approvalActions,
    isBuiltin: agent.isBuiltin,
  };
}

function toDtoAgent(agent: AgentConfig): AgentConfigDto {
  return {
    id: agent.id,
    name: agent.name,
    command: agent.command,
    defaultArgs: agent.defaultArgs,
    description: agent.description,
    installed: agent.installed,
    capabilities: agent.capabilities,
    icon: agent.icon,
    color: agent.color,
    statusPatterns: {
      approval: agent.statusPatterns.approval,
      thinking: agent.statusPatterns.thinking,
      toolUse: agent.statusPatterns.toolUse.map((tool) => ({
        pattern: tool.pattern,
        tool: tool.tool,
        fileGroup: tool.fileGroup,
      })),
      idle: agent.statusPatterns.idle,
    },
    approvalActions: agent.approvalActions ?? { approve: "y\n", deny: "n\n", abort: "\u0003" },
    isBuiltin: agent.isBuiltin,
  };
}

function fromDtoTaskResult(
  result: NonNullable<
    PersistedStateDto["flights"][number]["milestones"][number]["tasks"][number]["result"]
  >,
): TaskResult {
  return {
    exitCode: result.exitCode,
    summary: result.summary,
    filesChanged: result.filesChanged,
    errors: result.errors,
    duration: result.duration,
    handoff: result.handoff
      ? {
          summary: result.handoff.summary,
          filesChanged: result.handoff.filesChanged,
          testsNeeded: result.handoff.testsNeeded,
          followUps: result.handoff.followUps,
        }
      : undefined,
    validation: result.validation
      ? {
          verdict: result.validation.verdict,
          summary: result.validation.summary,
          assertions: result.validation.assertions.map(
            (assertion): NonNullable<TaskResult["validation"]>["assertions"][number] => ({
              label: assertion.label,
              status: assertion.status,
              details: assertion.details,
            }),
          ),
        }
      : undefined,
  };
}

function toDtoTaskResult(
  result: TaskResult,
): NonNullable<
  PersistedStateDto["flights"][number]["milestones"][number]["tasks"][number]["result"]
> {
  return {
    exitCode: result.exitCode,
    summary: result.summary,
    filesChanged: result.filesChanged,
    errors: result.errors,
    duration: result.duration,
    handoff: result.handoff
      ? {
          summary: result.handoff.summary,
          filesChanged: result.handoff.filesChanged,
          testsNeeded: result.handoff.testsNeeded,
          followUps: result.handoff.followUps,
        }
      : undefined,
    validation: result.validation
      ? {
          verdict: result.validation.verdict,
          summary: result.validation.summary,
          assertions: result.validation.assertions.map((assertion) => ({
            label: assertion.label,
            status: assertion.status,
            details: assertion.details,
          })),
        }
      : undefined,
  };
}

function fromDtoTask(
  task: PersistedStateDto["flights"][number]["milestones"][number]["tasks"][number],
): Task {
  return {
    id: task.id,
    milestoneId: task.milestoneId,
    flightId: task.flightId,
    title: task.title,
    description: task.description,
    order: task.order,
    status: task.status,
    type: task.type,
    agentConfigId: task.agentConfigId,
    agentArgs: task.agentArgs,
    model: task.model,
    dependsOn: task.dependsOn,
    sessionId: task.sessionId,
    result: task.result ? fromDtoTaskResult(task.result) : undefined,
    reviewPacket: task.reviewPacket
      ? {
          id: task.reviewPacket.id,
          taskId: task.reviewPacket.taskId,
          flightId: task.reviewPacket.flightId,
          milestoneId: task.reviewPacket.milestoneId,
          requestedAt: task.reviewPacket.requestedAt,
          reviewType: task.reviewPacket.reviewType as ReviewType,
          summary: task.reviewPacket.summary,
          diff: task.reviewPacket.diff,
          command: task.reviewPacket.command,
          filePaths: task.reviewPacket.filePaths,
          agentId: task.reviewPacket.agentId,
          sessionId: task.reviewPacket.sessionId,
        }
      : undefined,
    createdAt: task.createdAt,
    startedAt: task.startedAt,
    completedAt: task.completedAt,
    cost: task.cost,
    tokens: task.tokens,
    ownedPaths: task.ownedPaths ?? [],
    // Flight Planner replan counter — surfaced from the DTO so renderers
    // can show `N / 3` budget headroom in the failure-wake body.
    replanCount: task.replanCount,
  };
}

function toDtoTask(
  task: Task,
): PersistedStateDto["flights"][number]["milestones"][number]["tasks"][number] {
  return {
    id: task.id,
    milestoneId: task.milestoneId,
    flightId: task.flightId,
    title: task.title,
    description: task.description,
    order: task.order,
    status: task.status,
    type: task.type,
    agentConfigId: task.agentConfigId,
    agentArgs: task.agentArgs,
    model: task.model,
    dependsOn: task.dependsOn,
    sessionId: task.sessionId,
    result: task.result ? toDtoTaskResult(task.result) : undefined,
    reviewPacket: task.reviewPacket
      ? {
          id: task.reviewPacket.id,
          taskId: task.reviewPacket.taskId,
          flightId: task.reviewPacket.flightId,
          milestoneId: task.reviewPacket.milestoneId,
          requestedAt: task.reviewPacket.requestedAt,
          reviewType: task.reviewPacket.reviewType,
          summary: task.reviewPacket.summary,
          diff: task.reviewPacket.diff,
          command: task.reviewPacket.command,
          filePaths: task.reviewPacket.filePaths,
          agentId: task.reviewPacket.agentId,
          sessionId: task.reviewPacket.sessionId,
        }
      : undefined,
    createdAt: task.createdAt,
    startedAt: task.startedAt,
    completedAt: task.completedAt,
    cost: task.cost,
    tokens: task.tokens,
    ownedPaths: task.ownedPaths ?? [],
    // Flight Planner replan counter — mirrored from the registry on each
    // `bump_replan_count`. Default to 0 for legacy tasks that predate E5.
    replanCount: task.replanCount ?? 0,
  };
}

function fromDtoAttempt(a: PersistedStateDto["flights"][number]["attempts"][number]): Attempt {
  return {
    id: a.id,
    flightId: a.flightId,
    target: a.target,
    agentConfigId: a.agentConfigId,
    model: a.model,
    provider: a.provider,
    branch: a.branch,
    baseBranch: a.baseBranch,
    sessionId: a.sessionId,
    status: a.status,
    startedAt: a.startedAt,
    completedAt: a.completedAt,
    cost: a.cost,
    tokens: a.tokens,
    errorMessage: a.errorMessage,
    failureCategory: a.failureCategory as Attempt["failureCategory"],
    reviewGate: a.reviewGate,
    taskId: a.taskId,
    draftPrNumber: a.draftPrNumber,
  };
}

function toDtoAttempt(a: Attempt): PersistedStateDto["flights"][number]["attempts"][number] {
  return {
    id: a.id,
    flightId: a.flightId,
    target: a.target,
    agentConfigId: a.agentConfigId,
    model: a.model,
    provider: a.provider,
    branch: a.branch,
    baseBranch: a.baseBranch,
    sessionId: a.sessionId,
    status: a.status,
    startedAt: a.startedAt,
    completedAt: a.completedAt,
    cost: a.cost,
    tokens: a.tokens,
    errorMessage: a.errorMessage,
    failureCategory: a.failureCategory,
    reviewGate: a.reviewGate,
    taskId: a.taskId,
    draftPrNumber: a.draftPrNumber,
  };
}

type PersistedIssueDto = {
  id?: string;
  ticket_id?: string;
  title?: string;
  description?: string;
  status?: string;
  priority?: string;
  labels?: string[];
  epic?: string | null;
  session_id?: string | null;
  flight_id?: string | null;
  acceptance_criteria?: Array<{ id?: string; text?: string; checked?: boolean }>;
  blocked_by?: string[];
  blocks?: string[];
  created_at?: number;
  updated_at?: number;
};

function fromDtoIssue(raw: unknown): Issue {
  const issue = (raw ?? {}) as PersistedIssueDto;
  return {
    id: issue.id ?? "",
    ticketId: issue.ticket_id ?? "",
    title: issue.title ?? "",
    description: issue.description ?? "",
    status: (issue.status ?? "todo") as Issue["status"],
    priority: (issue.priority ?? "medium") as Issue["priority"],
    labels: issue.labels ?? [],
    epic: issue.epic ?? null,
    sessionId: issue.session_id ?? undefined,
    flightId: issue.flight_id ?? null,
    acceptanceCriteria: (issue.acceptance_criteria ?? []).map((criterion) => ({
      id: criterion.id ?? "",
      text: criterion.text ?? "",
      checked: Boolean(criterion.checked),
    })),
    blockedBy: issue.blocked_by ?? [],
    blocks: issue.blocks ?? [],
    createdAt: issue.created_at ?? Date.now(),
    updatedAt: issue.updated_at ?? Date.now(),
  };
}

function toDtoIssue(issue: Issue): PersistedIssueDto {
  return {
    id: issue.id,
    ticket_id: issue.ticketId,
    title: issue.title,
    description: issue.description,
    status: issue.status,
    priority: issue.priority,
    labels: issue.labels,
    epic: issue.epic,
    session_id: issue.sessionId ?? null,
    flight_id: issue.flightId,
    acceptance_criteria: issue.acceptanceCriteria.map((criterion) => ({
      id: criterion.id,
      text: criterion.text,
      checked: criterion.checked,
    })),
    blocked_by: issue.blockedBy,
    blocks: issue.blocks,
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
  };
}

function fromDtoFlight(flight: PersistedStateDto["flights"][number]): Flight {
  return {
    id: flight.id,
    title: flight.title,
    objective: flight.objective,
    status: flight.status,
    priority: flight.priority,
    projectPath: flight.projectPath,
    workspaceId: flight.workspaceId ?? null,
    gitBranch: flight.gitBranch,
    milestones: flight.milestones.map(
      (milestone): Milestone => ({
        id: milestone.id,
        flightId: milestone.flightId,
        title: milestone.title,
        description: milestone.description,
        order: milestone.order,
        status: milestone.status,
        tasks: milestone.tasks.map(fromDtoTask),
        validationCriteria: milestone.validationCriteria,
      }),
    ),
    linkedSessionIds: flight.linkedSessionIds,
    issueIds: flight.issueIds ?? [],
    createdAt: flight.createdAt,
    updatedAt: flight.updatedAt,
    completedAt: flight.completedAt,
    totalCost: flight.totalCost,
    totalTokens: flight.totalTokens,
    prompt: flight.prompt,
    attempts: (flight.attempts ?? []).map(fromDtoAttempt),
    reviewGatePolicy: flight.reviewGatePolicy,
    executionMode: flight.executionMode,
    integrationBranch: flight.integrationBranch
      ? {
          ...flight.integrationBranch,
          targetKind: flight.integrationBranch.targetKind === "ssh" ? "ssh" : "local",
          conflictFiles: flight.integrationBranch.conflictFiles ?? [],
        }
      : undefined,
    coordinationInbox: flight.coordinationInbox?.map((message) => ({
      ...message,
      sender: {
        ...message.sender,
        kind: message.sender.kind as "user" | "agent" | "system",
      },
      recipient: {
        ...message.recipient,
        kind: message.recipient.kind as "flight" | "role" | "task" | "attempt" | "session",
      },
      acknowledgements: message.acknowledgements.map((acknowledgement) => ({
        ...acknowledgement,
        by: {
          ...acknowledgement.by,
          kind: acknowledgement.by.kind as "user" | "agent" | "system",
        },
      })),
    })),
    autonomyMode: flight.autonomyMode,
    autonomyPolicy: flight.autonomyPolicy,
    autonomyRuntime: flight.autonomyRuntime,
    planningConversationId: flight.planningConversationId,
    plannerSessionId: flight.plannerSessionId,
    plannerStatus: flight.plannerStatus,
    plannerCost: flight.plannerCost,
    plannerTokens: flight.plannerTokens,
    plannerProvider: flight.plannerProvider,
    publishAttemptsAsPrs: flight.publishAttemptsAsPrs ?? false,
    coordinationLog: flight.coordinationLog ?? [],
  };
}

function toDtoFlight(flight: Flight): PersistedStateDto["flights"][number] {
  return {
    id: flight.id,
    title: flight.title,
    objective: flight.objective,
    status: flight.status,
    priority: flight.priority,
    projectPath: flight.projectPath,
    workspaceId: toOptional(flight.workspaceId),
    gitBranch: flight.gitBranch,
    milestones: flight.milestones.map((milestone) => ({
      id: milestone.id,
      flightId: milestone.flightId,
      title: milestone.title,
      description: milestone.description,
      order: milestone.order,
      status: milestone.status,
      tasks: milestone.tasks.map(toDtoTask),
      validationCriteria: milestone.validationCriteria,
    })),
    linkedSessionIds: flight.linkedSessionIds,
    issueIds: flight.issueIds,
    createdAt: flight.createdAt,
    updatedAt: flight.updatedAt,
    completedAt: flight.completedAt,
    totalCost: flight.totalCost,
    totalTokens: flight.totalTokens,
    prompt: flight.prompt,
    attempts: (flight.attempts ?? []).map(toDtoAttempt),
    reviewGatePolicy: flight.reviewGatePolicy,
    executionMode: flight.executionMode,
    integrationBranch: flight.integrationBranch
      ? {
          ...flight.integrationBranch,
          conflictFiles: flight.integrationBranch.conflictFiles ?? [],
        }
      : undefined,
    coordinationInbox: flight.coordinationInbox ?? [],
    autonomyMode: flight.autonomyMode,
    autonomyPolicy: flight.autonomyPolicy,
    autonomyRuntime: flight.autonomyRuntime,
    planningConversationId: flight.planningConversationId,
    plannerSessionId: flight.plannerSessionId,
    plannerStatus: flight.plannerStatus,
    plannerCost: flight.plannerCost,
    plannerTokens: flight.plannerTokens,
    plannerProvider: flight.plannerProvider,
    publishAttemptsAsPrs: flight.publishAttemptsAsPrs ?? false,
    coordinationLog: flight.coordinationLog ?? [],
  };
}

function fromDtoWorkspace(workspace: WorkspaceDto): Workspace {
  const workspaceWithMetadata = workspace as WorkspaceDtoWithFrontendMetadata;
  return {
    id: workspace.id,
    name: workspace.name,
    agents: workspace.agents,
    panes: workspaceWithMetadata.panes.map((pane) => ({
      id: pane.id,
      agentId: pane.agentId,
      sessionId: pane.sessionId,
      gridPosition: pane.gridPosition,
      pinnedCommands: pane.pinnedCommands,
      // Tile program (P1-S1): thread the kind discriminant + conversationId
      // through hydration or they silently drop on the next save. The invariant
      // (conversationId set iff kind==="conversation", absent kind ⇒ terminal)
      // is enforced by normalizePanes in workspaceStore, which runs over this
      // hydrated result.
      kind:
        pane.kind === "conversation" ? "conversation" : pane.kind === "file" ? "file" : undefined,
      conversationId: pane.conversationId,
      // File viewer tiles: thread path + view mode through hydration or a tiled
      // file silently degrades to a terminal on the next load. The invariant
      // (filePath set iff kind==="file") is enforced by normalizePanes below.
      filePath: pane.filePath,
      fileView: pane.fileView === "preview" || pane.fileView === "raw" ? pane.fileView : undefined,
      // Multi-account CLI support: thread the selected account id through
      // hydration or it silently drops on the next save. Absent ⇒ ambient.
      accountId: pane.accountId,
      terminalShell: pane.terminalShell
        ? normalizeTerminalShellSelection(pane.terminalShell)
        : undefined,
    })),
    projectPath: workspace.projectPath,
    prompt: workspace.prompt,
    createdAt: workspace.createdAt,
    updatedAt: workspace.updatedAt,
    status: workspace.status,
    bypassPermissions: workspace.bypassPermissions,
    modelOverrides: normalizeOptionalRecord(workspace.modelOverrides),
    effortOverrides: normalizeOptionalRecord(workspace.effortOverrides),
    serverId: workspace.serverId,
    remoteProjectPath: workspace.remoteProjectPath,
    executionTarget: workspace.executionTarget,
    githubRepo: workspaceWithMetadata.githubRepo,
    // Tile program (P1-S2): thread the workspace `origin` marker through
    // hydration so conversation wrappers survive a load/save round-trip; an
    // unknown value degrades to undefined (a normal workspace).
    origin: workspace.origin === "conversation" ? "conversation" : undefined,
    terminalShell: workspace.terminalShell
      ? normalizeTerminalShellSelection(workspace.terminalShell)
      : undefined,
    // The saved tile arrangement crosses the boundary as opaque JSON (Rust
    // never interprets it). Shape-validate on the way in; a malformed tree
    // degrades to undefined and the container falls back to the preset.
    layout: isValidMosaicTree(workspace.layout) ? workspace.layout : undefined,
  };
}

function toDtoWorkspace(workspace: Workspace): WorkspaceDtoWithFrontendMetadata {
  return {
    id: workspace.id,
    name: workspace.name,
    agents: workspace.agents,
    panes: workspace.panes.map((pane, index) => ({
      id: pane.id,
      agentId: pane.agentId,
      sessionId: pane.sessionId,
      gridPosition: pane.gridPosition ?? { row: 0, col: index },
      pinnedCommands: pane.pinnedCommands,
      // Tile program (P1-S1): only conversation panes carry kind/conversationId
      // in the persisted shape — terminal panes stay byte-identical so old
      // binaries and the five-field-era round-trip are unaffected. The inert
      // carrier `agentId: "terminal"` is set at pane construction, so a
      // downgraded binary that ignores `kind` renders a harmless terminal pane.
      ...(pane.kind === "conversation"
        ? { kind: "conversation" as const, conversationId: pane.conversationId }
        : {}),
      // Same rule for file tiles: only a file pane carries kind/filePath, so
      // terminal panes stay byte-identical to the pre-viewer persisted shape.
      ...(pane.kind === "file" && pane.filePath
        ? {
            kind: "file" as const,
            filePath: pane.filePath,
            ...(pane.fileView ? { fileView: pane.fileView } : {}),
          }
        : {}),
      // Multi-account CLI support: only panes bound to an explicit account
      // carry the field — an ambient pane stays byte-identical to the
      // pre-multi-account shape, so an old binary round-trip is unaffected.
      ...(pane.accountId ? { accountId: pane.accountId } : {}),
      ...(pane.terminalShell ? { terminalShell: pane.terminalShell } : {}),
    })),
    projectPath: workspace.projectPath,
    prompt: workspace.prompt,
    createdAt: workspace.createdAt,
    updatedAt: workspace.updatedAt,
    status: workspace.status,
    bypassPermissions: workspace.bypassPermissions,
    modelOverrides: workspace.modelOverrides,
    effortOverrides: workspace.effortOverrides,
    serverId: workspace.serverId,
    remoteProjectPath: workspace.remoteProjectPath,
    executionTarget: workspace.executionTarget,
    githubRepo: workspace.githubRepo,
    // Tile program (P1-S2): persist the `origin` marker only when set — a
    // normal workspace stays byte-identical to the pre-tile shape.
    ...(workspace.origin === "conversation" ? { origin: "conversation" as const } : {}),
    ...(workspace.terminalShell ? { terminalShell: workspace.terminalShell } : {}),
    // Only workspaces the user has actually arranged carry a layout, so an
    // untouched workspace stays byte-identical to the pre-persistence shape.
    ...(workspace.layout ? { layout: workspace.layout } : {}),
  } satisfies WorkspaceDtoWithFrontendMetadata;
}

function fromDtoPersistedState(state: PersistedStateDto): PersistedState {
  return {
    version: state.version,
    flights: state.flights.map(fromDtoFlight),
    agents: state.agents.map(fromDtoAgent),
    issues: (state.issues ?? []).map(fromDtoIssue),
    settings: {
      maxParallelSessions: state.settings.maxParallelSessions,
      milestoneGating: state.settings.milestoneGating,
      projectPath: state.settings.projectPath,
      autoCommitTrailerEnabled: state.settings.autoCommitTrailerEnabled,
      autoCommitTrailerFormat: state.settings.autoCommitTrailerFormat,
      autonomyDefaultMode: state.settings.autonomyDefaultMode,
      autonomyDefaultPolicy: state.settings.autonomyDefaultPolicy,
    },
    ui: {
      selectedFlightId: state.ui.selectedFlightId ?? null,
      selectedView: state.ui.selectedView ?? null,
      theme: state.ui.theme ?? null,
    },
    workspaces: state.workspaces.map(fromDtoWorkspace),
    memoryEvents: (state.memoryEvents ?? []) as MemoryEvent[],
    memoryPatterns: (state.memoryPatterns ?? []) as LearnedPattern[],
    servers: (state.servers ?? []).map(fromDtoServer),
    cliAccounts: (state.cliAccounts ?? []).map(fromDtoCliAccount),
    cliAccountDefaults: fromDtoCliAccountDefaults(state.cliAccountDefaults),
  };
}

function fromDtoCliAccount(a: PersistedStateDto["cliAccounts"][number]): CliAccount {
  return {
    id: a.id,
    label: a.label,
    // The DTO carries `cli` as a plain string for forward compatibility.
    // Anything unrecognized is coerced to claude-code rather than dropped so
    // a stale record stays visible (and deletable) in Settings.
    cli: a.cli === "codex" ? "codex" : "claude-code",
    configDir: a.configDir,
    email: a.email ?? undefined,
    createdAt: Number(a.createdAt),
    lastUsedAt: a.lastUsedAt != null ? Number(a.lastUsedAt) : undefined,
  };
}

function toDtoCliAccount(a: CliAccount): PersistedStateDto["cliAccounts"][number] {
  return {
    id: a.id,
    label: a.label,
    cli: a.cli,
    configDir: a.configDir,
    email: a.email ?? null,
    createdAt: a.createdAt,
    lastUsedAt: a.lastUsedAt ?? null,
  };
}

/** ts-rs types map values as optional; normalize to a dense record. */
function fromDtoCliAccountDefaults(
  defaults: PersistedStateDto["cliAccountDefaults"] | undefined,
): CliAccountDefaults {
  const out: CliAccountDefaults = {};
  for (const [projectPath, perCli] of Object.entries(defaults ?? {})) {
    if (!perCli) continue;
    const entry: Partial<Record<CliAccountCli, string>> = {};
    if (typeof perCli["claude-code"] === "string") entry["claude-code"] = perCli["claude-code"];
    if (typeof perCli.codex === "string") entry.codex = perCli.codex;
    if (Object.keys(entry).length > 0) out[projectPath] = entry;
  }
  return out;
}

function fromDtoServer(s: PersistedStateDto["servers"][number]): ServerConfig {
  return {
    id: s.id,
    name: s.name,
    host: s.host,
    port: s.port,
    username: s.username,
    authMethod: s.authMethod as ServerConfig["authMethod"],
    keyPath: s.keyPath ?? undefined,
    remotePath: s.remotePath ?? undefined,
    hostFingerprint: s.hostFingerprint ?? undefined,
    lastConnectedAt: s.lastConnectedAt != null ? Number(s.lastConnectedAt) : undefined,
    installedAgents: s.installedAgents,
  };
}

function toDtoServer(s: ServerConfig): PersistedStateDto["servers"][number] {
  return {
    id: s.id,
    name: s.name,
    host: s.host,
    port: s.port,
    username: s.username,
    authMethod: s.authMethod,
    keyPath: s.keyPath ?? null,
    remotePath: s.remotePath ?? null,
    hostFingerprint: s.hostFingerprint ?? null,
    lastConnectedAt: s.lastConnectedAt != null ? BigInt(s.lastConnectedAt) : null,
    installedAgents: s.installedAgents,
  };
}

function toDtoPersistedState(state: PersistedState): PersistedStateDto {
  return {
    version: state.version,
    flights: state.flights.map(toDtoFlight),
    agents: state.agents.map(toDtoAgent),
    issues: state.issues.map(toDtoIssue),
    settings: {
      maxParallelSessions: state.settings.maxParallelSessions,
      milestoneGating: state.settings.milestoneGating,
      projectPath: state.settings.projectPath,
      autoCommitTrailerEnabled: state.settings.autoCommitTrailerEnabled ?? true,
      autoCommitTrailerFormat:
        state.settings.autoCommitTrailerFormat ??
        "Run-By: PacketBench flight F-{flightId} attempt A-{attemptId}",
      autonomyDefaultMode: state.settings.autonomyDefaultMode ?? "assisted",
      autonomyDefaultPolicy: state.settings.autonomyDefaultPolicy ?? {
        schemaVersion: 1,
        autoRecovery: true,
        autoReviewRemediation: true,
        autoRunTaskGraph: true,
        toolPosture: "approval_gated",
        maxTotalCost: 25,
        maxDurationMinutes: 120,
        maxRetriesPerTask: 2,
        maxReviewRounds: 2,
        maxConcurrentAgents: 3,
        allowedRoots: [],
        allowedTargets: ["local"],
        allowDraftPrPublishing: false,
      },
    },
    ui: {
      selectedFlightId: toOptional(state.ui.selectedFlightId),
      selectedView: toOptional(state.ui.selectedView),
      theme: toOptional(state.ui.theme),
    },
    workspaces: state.workspaces.map(toDtoWorkspace),
    memoryEvents: state.memoryEvents,
    memoryPatterns: state.memoryPatterns,
    servers: state.servers.map(toDtoServer),
    cliAccounts: state.cliAccounts.map(toDtoCliAccount),
    cliAccountDefaults: state.cliAccountDefaults,
  };
}

// === Persisted state ===

export async function loadPersistedState(): Promise<PersistedState> {
  const payload = await invoke<PersistedStateDto>("load_persisted_state");
  return fromDtoPersistedState(payload);
}

export async function savePersistedState(state: PersistedState): Promise<void> {
  return invoke("save_persisted_state", { state: toDtoPersistedState(state) });
}

export async function saveFlightsSlice(flights: Flight[]): Promise<void> {
  return invoke("save_flights_slice", { flights: flights.map(toDtoFlight) });
}

export async function saveAgentsSlice(agents: AgentConfig[]): Promise<void> {
  return invoke("save_agents_slice", { agents: agents.map(toDtoAgent) });
}

export async function saveWorkspacesSlice(workspaces: Workspace[]): Promise<void> {
  return invoke("save_workspaces_slice", { workspaces: workspaces.map(toDtoWorkspace) });
}

/**
 * v0.8.5 (CRITICAL FIX 2): mirror the local `issueStore` array into the Rust
 * `PersistedState.issues` slice. The Rust `git_commit` command's
 * `emit_fixes_events` helper resolves `Fixes #N` trailers against
 * `load_state().issues` to find the matching local Issue by ticket-id
 * suffix; before this binding existed the slice was always empty/stale and
 * the auto-Done event listener never fired.
 *
 * The Rust `core::flight::Issue` struct uses snake_case field names without
 * a `#[serde(rename_all)]`, so the payload must use those names verbatim.
 * Frontend-only fields (`comments`, `assignee`, `workspaceId`,
 * `sentToWorkspaceAt`, `specImportBatchId`) are dropped — they have no
 * backend counterpart and aren't needed for the `Fixes #N` lookup.
 */
export async function saveIssuesSlice(issues: Issue[]): Promise<void> {
  const payload = issues.map(toDtoIssue);
  return invoke("save_issues_slice", { issues: payload });
}

export async function saveSettingsSlice(settings: PersistedState["settings"]): Promise<void> {
  return invoke("save_settings_slice", { settings });
}

export async function saveUiSlice(ui: PersistedState["ui"]): Promise<void> {
  const payload: PersistedUiStateDto = {};
  const selectedFlightId = toUiPatchString(ui.selectedFlightId);
  const selectedView = toUiPatchString(ui.selectedView);
  if (selectedFlightId !== undefined) payload.selectedFlightId = selectedFlightId;
  if (selectedView !== undefined) payload.selectedView = selectedView;
  if (ui.theme !== undefined && ui.theme !== null) payload.theme = ui.theme;
  // `null` is a meaningful value here (follow the system zone), and the Rust
  // side maps an empty string back to `None`, so send "" rather than dropping
  // the key — otherwise clearing an explicit zone could never be persisted.
  if (ui.timeZone !== undefined) payload.timeZone = ui.timeZone ?? "";
  return invoke("save_ui_slice", { ui: payload });
}

export async function parseSpecToFlight(specText: string): Promise<string> {
  return invoke<string>("parse_spec_to_flight", { specText });
}

export async function parseSpecToTickets(specText: string): Promise<string> {
  return invoke<string>("parse_spec_to_tickets", { specText });
}

// v0.8.5 — Issues spec import.
//
// Mounts a one-shot `claude-oauth` sidecar session that breaks the pasted
// spec into discrete issue drafts. Returns the parsed array directly; the
// modal advances from paste → review on the resolved promise.
export interface ExtractedIssueDraft {
  title: string;
  body: string;
  labels?: string[];
  acceptanceCriteria?: string[];
  suggestedEpic?: string;
}

export async function issuesExtractFromSpec(
  specText: string,
  projectPath: string,
): Promise<ExtractedIssueDraft[]> {
  return invoke<ExtractedIssueDraft[]>("issues_extract_from_spec", {
    specText,
    projectPath,
  });
}

export async function askAgentChatStream(
  projectPath: string,
  messages: { role: string; content: string }[],
  sessionContext?: string,
  requestId?: string,
): Promise<void> {
  return invoke("ask_agent_chat_stream", {
    projectPath,
    messages,
    sessionContext: sessionContext || null,
    requestId: requestId || null,
  });
}

// GitHub integration
export async function githubSetToken(token: string): Promise<void> {
  return invoke("github_set_token", { token });
}

export async function githubClearToken(): Promise<void> {
  return invoke("github_clear_token");
}

export async function githubHasToken(): Promise<boolean> {
  return invoke<boolean>("github_has_token");
}

// G2: multi-connection git-host config (GitHub + Gitea/Forgejo + GitLab).
// Mirrors `GitHostKind` in `src-tauri/src/core/git_host.rs`.
export type GitHostKind = "github" | "gitea" | "gitlab";

export interface GitHostConnectionInfo {
  id: string;
  kind: GitHostKind;
  baseUrl: string;
  label: string;
  hasToken: boolean;
}

export async function gitHostListConnections(): Promise<GitHostConnectionInfo[]> {
  return invoke<GitHostConnectionInfo[]>("git_host_list_connections");
}

/**
 * Add a self-hosted / third-party host (base URL + access token). Returns the
 * new connection id.
 *
 * `kind` selects the API dialect: `"gitea"` → `/api/v1`, `"gitlab"` →
 * `/api/v4`. `"github"` is rejected — the GitHub connection is implicit and
 * always present. Pass the **instance origin**, not the API root; the backend
 * appends the suffix (and tolerates one already being there). For GitLab that
 * origin is `https://gitlab.com` on SaaS just as much as it is
 * `https://gitlab.internal` self-hosted.
 *
 * The token never round-trips back to the frontend — it goes straight into the
 * OS keyring under the new connection's account.
 */
export async function gitHostAddConnection(
  kind: Exclude<GitHostKind, "github">,
  baseUrl: string,
  label: string,
  token: string,
): Promise<string> {
  return invoke<string>("git_host_add_connection", { kind, baseUrl, label, token });
}

/**
 * Add a Gitea/Forgejo host. Retained so existing call sites keep working;
 * new code should use {@link gitHostAddConnection}.
 */
export async function gitHostAddGitea(
  baseUrl: string,
  label: string,
  token: string,
): Promise<string> {
  return gitHostAddConnection("gitea", baseUrl, label, token);
}

export async function gitHostRemoveConnection(id: string): Promise<void> {
  return invoke("git_host_remove_connection", { id });
}

export async function gitHostSetToken(id: string, token: string): Promise<void> {
  return invoke("git_host_set_token", { id, token });
}

/**
 * How a replacement token is validated before it is allowed to overwrite the
 * working one. Structurally the wizard descriptor's `probe` block — see
 * `GitHostProbeSpec` in `lib/gitHostWizard.ts`, which is what call sites pass.
 */
export interface GitHostProbeSpecPayload {
  apiPrefix: string;
  identityPath: string;
  authScheme: "bearer" | "token" | "private-token";
  accept?: string | null;
  scopeHeader?: string | null;
  scopePath?: string | null;
  scopeField?: string | null;
  loginFields: string[];
}

/**
 * An in-place edit of an existing connection. Omitted fields are left alone —
 * in particular, omitting `token` leaves the stored credential completely
 * untouched, which is what makes renaming possible without re-typing a token.
 *
 * `kind` / `baseUrl` are assertions, not edits: the backend refuses the update
 * if either differs from what it has stored, because changing one would make
 * this a different connection (different keyring account, different repos).
 */
export interface GitHostConnectionUpdate {
  label?: string;
  /** Required alongside `probe`; never returned, never logged. */
  token?: string;
  /** Required whenever `token` is set — there is no unvalidated write path. */
  probe?: GitHostProbeSpecPayload;
  kind?: GitHostKind;
  baseUrl?: string;
}

/**
 * Rotate a connection's token and/or rename it, keyed by connection id.
 *
 * The token is rewritten under the connection's *existing* keyring account, so
 * nothing else has to be re-pointed. It is probed against the connection's
 * stored base URL first: anything short of a clean pass rejects the whole
 * update and leaves the previous credential exactly where it was.
 *
 * The token goes into this call and no further — it is never returned, never
 * stored in a Zustand store, and never echoed in the rejection message.
 */
export async function gitHostUpdateConnection(
  id: string,
  update: GitHostConnectionUpdate,
): Promise<void> {
  return invoke("git_host_update_connection", { id, update });
}

export async function gitHostHasToken(id: string): Promise<boolean> {
  return invoke<boolean>("git_host_has_token", { id });
}

/** G4: set which connection the git-host commands target (per-workspace). */
export async function gitHostSetActive(id: string): Promise<void> {
  return invoke("git_host_set_active", { id });
}

// GP3: GitHub OAuth device-flow auth.
export interface DeviceFlowStart {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  interval: number;
  expiresIn: number;
}

export type DeviceFlowStatus = "authorized" | "pending" | "slow_down" | "error";

export interface DeviceFlowPoll {
  status: DeviceFlowStatus;
  message: string | null;
  /**
   * Opaque handle to the credential GitHub minted and Rust parked in memory —
   * present only on `authorized`. It is NOT the token: a device-flow token
   * never crosses into the frontend at all. Pass it to
   * {@link githubDeviceFlowProbePending} to check it and
   * {@link githubDeviceFlowCommit} to accept it.
   */
  pendingId: string | null;
}

export async function githubDeviceFlowStart(): Promise<DeviceFlowStart> {
  return invoke<DeviceFlowStart>("github_device_flow_start");
}

/**
 * Poll for authorization. On `authorized` nothing has been saved yet — the
 * credential is parked in Rust behind `pendingId` until it has been probed and
 * committed, so a device-flow token gets the same validate-then-save ordering
 * as a pasted one.
 */
export async function githubDeviceFlowPoll(deviceCode: string): Promise<DeviceFlowPoll> {
  return invoke<DeviceFlowPoll>("github_device_flow_poll", { deviceCode });
}

// The probe over a parked credential lives in `lib/gitHostProbe.ts` alongside
// the pasted-token probe it shares a result type with.

/** Accept a probed credential into the keyring. Refused if no probe passed. */
export async function githubDeviceFlowCommit(pendingId: string): Promise<void> {
  return invoke("github_device_flow_commit", { pendingId });
}

/** Drop a parked credential the user walked away from. Idempotent. */
export async function githubDeviceFlowDiscard(pendingId: string): Promise<void> {
  return invoke("github_device_flow_discard", { pendingId });
}

/** Whether an OAuth app client id is configured — gate the device-flow button on this. */
export async function githubOauthConfigured(): Promise<boolean> {
  return invoke<boolean>("github_oauth_configured");
}

// GP6: repo releases (raw passthrough JSON — parse into GitHubRelease[]).
export interface GitHubRelease {
  id: number;
  tag_name: string;
  name: string | null;
  html_url: string;
  published_at: string | null;
  draft: boolean;
  prerelease: boolean;
  body: string | null;
}

export async function githubListReleases(owner: string, repo: string): Promise<string> {
  return invoke<string>("github_list_releases", { owner, repo });
}

export async function githubListRepos(): Promise<string> {
  return invoke<string>("github_list_repos");
}

export async function githubGetAuthenticatedUser(): Promise<{
  login: string;
  avatarUrl: string;
}> {
  return invoke<{ login: string; avatarUrl: string }>("github_get_authenticated_user");
}

export async function githubListIssues(owner: string, repo: string): Promise<string> {
  return invoke<string>("github_list_issues", { owner, repo });
}

export async function githubGetIssue(
  owner: string,
  repo: string,
  issueNumber: number,
): Promise<string> {
  return invoke<string>("github_get_issue", { owner, repo, issueNumber });
}

export async function githubCreateIssue(
  owner: string,
  repo: string,
  title: string,
  body: string,
): Promise<string> {
  return invoke<string>("github_create_issue", { owner, repo, title, body });
}

export async function githubUpdateIssue(
  owner: string,
  repo: string,
  number: number,
  title: string,
  body: string,
): Promise<string> {
  return invoke<string>("github_update_issue", { owner, repo, number, title, body });
}

/**
 * v0.8-G: extended with optional `draft` flag. When omitted, GitHub
 * defaults to a normal (ready-for-review) PR. When `true`, GitHub opens
 * the PR in draft state — used by the "Publish attempts as draft PRs"
 * Flight option to surface each attempt's branch as a reviewable draft.
 */
export async function githubCreatePr(
  owner: string,
  repo: string,
  title: string,
  body: string,
  head: string,
  base: string,
  draft?: boolean,
  connectionId?: string,
): Promise<string> {
  return invoke<string>("github_create_pr", {
    owner,
    repo,
    title,
    body,
    head,
    base,
    draft: draft ?? null,
    connectionId: connectionId ?? null,
  });
}

export async function githubListPrs(owner: string, repo: string): Promise<string> {
  return invoke<string>("github_list_prs", { owner, repo });
}

export async function githubGetPrDiff(
  owner: string,
  repo: string,
  prNumber: number,
): Promise<string> {
  return invoke<string>("github_get_pr_diff", { owner, repo, prNumber });
}

// === v0.8-A: PR actions =====================================================
//
// PR lifecycle controls. Backend commands live in
// `src-tauri/src/commands/github.rs`; see `PRActionBar.tsx` for the UI.

export type GitHubMergeMethod = "merge" | "squash" | "rebase";

export interface GitHubMergeResult {
  sha: string;
  merged: boolean;
  message: string;
}

/** PUT /repos/{owner}/{repo}/pulls/{number}/merge */
export async function githubMergePr(
  owner: string,
  repo: string,
  number: number,
  mergeMethod: GitHubMergeMethod,
): Promise<GitHubMergeResult> {
  return invoke<GitHubMergeResult>("github_merge_pr", {
    owner,
    repo,
    number,
    mergeMethod,
  });
}

/** PATCH /repos/{owner}/{repo}/pulls/{number} state=closed */
export async function githubClosePr(owner: string, repo: string, number: number): Promise<string> {
  return invoke<string>("github_close_pr", { owner, repo, number });
}

/** PATCH /repos/{owner}/{repo}/pulls/{number} state=open */
export async function githubReopenPr(owner: string, repo: string, number: number): Promise<string> {
  return invoke<string>("github_reopen_pr", { owner, repo, number });
}

/** GraphQL convertPullRequestToDraft / markPullRequestReadyForReview. */
export async function githubSetPrDraftState(
  owner: string,
  repo: string,
  number: number,
  draft: boolean,
): Promise<boolean> {
  return invoke<boolean>("github_convert_pr_to_draft", {
    owner,
    repo,
    number,
    draft,
  });
}

// === v0.8-B: CI / check-run status =========================================

import type { GitHubPrChecks as _GitHubPrChecks } from "@/types/github";

/** Aggregate of Checks API + legacy combined-status for a PR's head SHA. */
export async function githubGetPrChecks(
  owner: string,
  repo: string,
  prNumber: number,
): Promise<_GitHubPrChecks> {
  return invoke<_GitHubPrChecks>("github_get_pr_checks", {
    owner,
    repo,
    prNumber,
  });
}

// === Notifications inbox ====================================================
//
// The authenticated user's cross-repo notification threads. Backend lives in
// `src-tauri/src/commands/github.rs` (`github_list_notifications` /
// `github_mark_notification_read`). Mirrors the camelCase DTO.

export interface GithubNotification {
  /** Thread id — used to mark the thread read. */
  id: string;
  unread: boolean;
  /** Why this notification arrived (mention, review_requested, assign, …). */
  reason: string;
  updatedAt: string;
  title: string;
  /** Issue | PullRequest | Commit | Release | Discussion | … */
  subjectType: string;
  /** Browser url for the subject, derived from the API subject url. */
  htmlUrl: string;
  repository: string;
}

/** GET /notifications — unread threads by default, all threads when `all`. */
export async function githubListNotifications(all?: boolean): Promise<GithubNotification[]> {
  return invoke<GithubNotification[]>("github_list_notifications", {
    all: all ?? null,
  });
}

/** PATCH /notifications/threads/{threadId} — mark a single thread read. */
export async function githubMarkNotificationRead(threadId: string): Promise<void> {
  return invoke("github_mark_notification_read", { threadId });
}

export async function githubInvestigateIssue(
  projectPath: string,
  owner: string,
  repo: string,
  issueNumber: number,
): Promise<string> {
  return invoke<string>("github_investigate_issue", {
    projectPath,
    owner,
    repo,
    issueNumber,
  });
}

// === v0.8-F: AI catch-me-up digest + AI issue triage ======================
//
// Backend lives in `src-tauri/src/commands/github.rs`. The digest streams
// over the standard `api-agent:chunk:<sessionId>` / `api-agent:done:...`
// channel so the same listener wiring used by the Agents pane can hydrate
// the digest panel. Triage is one-shot — it returns the parsed
// suggestions inline.

/**
 * Fire-and-forget. The frontend generates a fresh sessionId, subscribes
 * to `api-agent:chunk:<sessionId>` / `api-agent:done:<sessionId>` /
 * `api-agent:error:<sessionId>` before calling, and tears down the
 * listeners on done/error.
 */
export async function githubAiCatchUp(
  sessionId: string,
  owner: string,
  repo: string,
  sinceIso8601: string | null,
): Promise<void> {
  return invoke("github_ai_catch_up", {
    sessionId,
    owner,
    repo,
    sinceIso8601,
  });
}

export async function githubAiTriage(
  owner: string,
  repo: string,
  issueNumbers: number[],
): Promise<import("@/types/github").TriageSuggestion[]> {
  return invoke<import("@/types/github").TriageSuggestion[]>("github_ai_triage", {
    owner,
    repo,
    issueNumbers,
  });
}

// === v0.8-E: AI PR description + AI pre-flight code review =================
//
// Both commands kick off a one-shot `claude-oauth` sidecar session in the
// backend and return the freshly minted `sessionId`. The caller subscribes
// to the existing `api-agent:chunk:<sessionId>` / `api-agent:done:<sessionId>`
// / `api-agent:error:<sessionId>` events to receive streamed chunks and
// detect completion. See `PRDescriptionButton.tsx` and `PRReviewPanel.tsx`
// for the canonical consumer pattern.

/**
 * Start a one-shot AI PR-description generation session. Returns the
 * `sessionId` to subscribe to; the call itself does not wait for the
 * assistant turn to finish.
 */
export async function githubAiPrDescription(
  owner: string,
  repo: string,
  base: string,
  head: string,
  draftTitle?: string,
  linkedIssueNumbers?: number[],
  // v0.8 race-fix: callers SHOULD pre-allocate the session id (e.g.
  // `crypto.randomUUID()` with a "gh-pr-desc-" prefix) and attach the
  // `api-agent:chunk|done|error:<sid>` listeners BEFORE invoking, so the
  // sidecar can't emit chunks before subscription. When omitted the
  // backend mints a UUID (legacy callers).
  sessionIdOverride?: string,
): Promise<string> {
  return invoke<string>("github_ai_pr_description", {
    owner,
    repo,
    base,
    head,
    draftTitle: draftTitle ?? null,
    linkedIssueNumbers: linkedIssueNumbers ?? null,
    sessionIdOverride: sessionIdOverride ?? null,
  });
}

/**
 * Start a one-shot AI PR-review session for an existing pull request.
 * Returns the `sessionId` to subscribe to.
 */
export async function githubAiPrReview(
  owner: string,
  repo: string,
  prNumber: number,
  // v0.8 race-fix: see `githubAiPrDescription::sessionIdOverride`.
  sessionIdOverride?: string,
): Promise<string> {
  return invoke<string>("github_ai_pr_review", {
    owner,
    repo,
    prNumber,
    sessionIdOverride: sessionIdOverride ?? null,
  });
}

// === v0.8-C: issue interactivity bindings ==================================
//
// Comment list/post, state toggles, assignee/label/milestone mutators, repo
// metadata pickers, and paginated list variants.

import type { GitHubIssueComment } from "@/types/github";

export async function githubListIssueComments(
  owner: string,
  repo: string,
  number: number,
): Promise<GitHubIssueComment[]> {
  return invoke<GitHubIssueComment[]>("github_list_issue_comments", {
    owner,
    repo,
    number,
  });
}

export async function githubPostIssueComment(
  owner: string,
  repo: string,
  number: number,
  body: string,
): Promise<GitHubIssueComment> {
  return invoke<GitHubIssueComment>("github_post_issue_comment", {
    owner,
    repo,
    number,
    body,
  });
}

export async function githubCloseIssue(
  owner: string,
  repo: string,
  number: number,
): Promise<string> {
  return invoke<string>("github_close_issue", { owner, repo, number });
}

export async function githubReopenIssue(
  owner: string,
  repo: string,
  number: number,
): Promise<string> {
  return invoke<string>("github_reopen_issue", { owner, repo, number });
}

export async function githubSetIssueAssignees(
  owner: string,
  repo: string,
  number: number,
  assignees: string[],
): Promise<string> {
  return invoke<string>("github_set_issue_assignees", {
    owner,
    repo,
    number,
    assignees,
  });
}

export async function githubSetIssueLabels(
  owner: string,
  repo: string,
  number: number,
  labels: string[],
): Promise<string> {
  return invoke<string>("github_set_issue_labels", {
    owner,
    repo,
    number,
    labels,
  });
}

export async function githubSetIssueMilestone(
  owner: string,
  repo: string,
  number: number,
  milestone: number | null,
): Promise<string> {
  return invoke<string>("github_set_issue_milestone", {
    owner,
    repo,
    number,
    milestone,
  });
}

export async function githubListRepoLabels(owner: string, repo: string): Promise<string> {
  return invoke<string>("github_list_repo_labels", { owner, repo });
}

export async function githubListRepoMilestones(owner: string, repo: string): Promise<string> {
  return invoke<string>("github_list_repo_milestones", { owner, repo });
}

export async function githubCreateRepoMilestone(
  owner: string,
  repo: string,
  title: string,
  description: string,
): Promise<string> {
  return invoke<string>("github_create_repo_milestone", {
    owner,
    repo,
    title,
    description,
  });
}

export async function githubListRepoAssignableUsers(owner: string, repo: string): Promise<string> {
  return invoke<string>("github_list_repo_assignable_users", { owner, repo });
}

export async function githubListIssuesPage(
  owner: string,
  repo: string,
  state: "open" | "closed" | "all",
  page: number,
): Promise<string> {
  return invoke<string>("github_list_issues_page", { owner, repo, state, page });
}

export async function githubListPrsPage(
  owner: string,
  repo: string,
  state: "open" | "closed" | "all",
  page: number,
): Promise<string> {
  return invoke<string>("github_list_prs_page", { owner, repo, state, page });
}

export async function githubListReposPage(page: number): Promise<string> {
  return invoke<string>("github_list_repos_page", { page });
}

// === v0.8-G: PR modal upgrades ============================================
//
// Backs the upgraded `PRModal` (branch autocomplete + reviewer/label/
// milestone pickers) and the "Publish attempts as draft PRs" Flight
// option. The reviewer/label/milestone calls run AFTER `githubCreatePr`
// returns the new PR number, so the modal applies them in a single
// progress-tracked sequence.

export interface GitHubBranchInfo {
  name: string;
  sha: string;
  isProtected: boolean;
}

/** List a repository's branches (up to 100). */
export async function githubListBranches(owner: string, repo: string): Promise<GitHubBranchInfo[]> {
  return invoke<GitHubBranchInfo[]>("github_list_branches", { owner, repo });
}

/** Request review on an existing PR. Empty `reviewers` is a no-op. */
export async function githubSetPrReviewers(
  owner: string,
  repo: string,
  number: number,
  reviewers: string[],
): Promise<string> {
  return invoke<string>("github_set_pr_reviewers", {
    owner,
    repo,
    number,
    reviewers,
  });
}

/** Replace the full label set on a PR. Passing `[]` clears all labels. */
export async function githubSetPrLabels(
  owner: string,
  repo: string,
  number: number,
  labels: string[],
): Promise<string> {
  return invoke<string>("github_set_pr_labels", {
    owner,
    repo,
    number,
    labels,
  });
}

/** Set or clear the milestone on a PR. `null` clears. */
export async function githubSetPrMilestone(
  owner: string,
  repo: string,
  number: number,
  milestone: number | null,
): Promise<string> {
  return invoke<string>("github_set_pr_milestone", {
    owner,
    repo,
    number,
    milestone,
  });
}

/**
 * v0.8-G: push a specific local branch to `origin` (sets upstream
 * tracking on first push). Used by the post-attempt publish pipeline to
 * push the attempt's worktree branch before opening a draft PR.
 */
export async function gitPushBranch(
  projectPath: string,
  branchName: string,
  force: boolean = false,
): Promise<string> {
  return invoke<string>("git_push_branch", {
    projectPath,
    branchName,
    force,
  });
}

/** v0.8-G: record the draft PR number on an attempt after publishing. */
export async function setAttemptDraftPr(
  flightId: string,
  attemptId: string,
  prNumber: number,
): Promise<void> {
  return invoke("set_attempt_draft_pr", {
    flightId,
    attemptId,
    prNumber,
  });
}

/** v0.8-G: persist the Flight `publishAttemptsAsPrs` toggle. */
export async function setFlightPublishAttemptsAsPrs(
  flightId: string,
  enabled: boolean,
): Promise<void> {
  return invoke("set_flight_publish_attempts_as_prs", {
    flightId,
    enabled,
  });
}

// Prompt history
export async function readPromptHistory(): Promise<string> {
  return invoke<string>("read_prompt_history");
}

// MCP server management
import type { McpServerDiagnostic, McpServerEntry, McpTrustSnapshot } from "@/types/mcp";
import { APP_NAME } from "@/lib/brand";

export async function readMcpServers(projectPath: string): Promise<McpServerEntry[]> {
  return invoke<McpServerEntry[]>("read_mcp_servers", { projectPath });
}

export async function writeMcpServer(
  projectPath: string,
  name: string,
  command: string,
  args: string[],
  env: Record<string, string>,
  scope: string,
): Promise<void> {
  return invoke("write_mcp_server", { projectPath, name, command, args, env, scope });
}

export async function deleteMcpServer(
  projectPath: string,
  name: string,
  scope: string,
): Promise<void> {
  return invoke("delete_mcp_server", { projectPath, name, scope });
}

export async function diagnoseMcpServer(
  projectPath: string,
  name: string,
  scope: "global" | "project",
): Promise<McpServerDiagnostic> {
  return invoke<McpServerDiagnostic>("diagnose_mcp_server", {
    projectPath,
    name,
    scope,
  });
}

// N3 — PacketBench-as-MCP-server lifecycle (the Rust-hosted Streamable HTTP server)
export interface McpServerStatus {
  running: boolean;
  port: number | null;
  /** Bearer token external MCP clients must send. Null when stopped. */
  token: string | null;
  /** URL to paste into a client's MCP config. Null when stopped. */
  url: string | null;
  /** Whether the append-only write tool is enabled on the running server. */
  allowWrites: boolean;
  /**
   * The tool names the running server ACTUALLY serves, after its per-tool
   * allowlist was applied. Reported by the backend rather than derived here so
   * the card cannot claim a restriction the router is not enforcing. Empty
   * when stopped.
   */
  servedTools: string[];
}

/** One tool the provider server can expose, as the Rust router defines it. */
export interface McpProviderToolInfo {
  name: string;
  description: string;
}

/**
 * The canonical provider tool catalogue, read from the Rust router.
 *
 * The frontend used to keep its own hardcoded copy, which had silently drifted
 * from the router. Since `allowedTools` is now enforced, a stale catalogue
 * would switch off tools the user was never shown — so the backend is the
 * single source of truth for what exists.
 */
export async function mcpServerAvailableTools(): Promise<McpProviderToolInfo[]> {
  return invoke<McpProviderToolInfo[]>("mcp_server_available_tools");
}

/**
 * Start the provider server.
 *
 * `allowedTools` is the per-tool allowlist and is enforced by the Rust router
 * at both `tools/list` and `tools/call`. Pass `null` to serve every tool.
 * An empty array is a real answer — serve nothing — not an absent one.
 */
export async function mcpServerStart(
  port: number,
  allowWrites: boolean,
  allowedTools: string[] | null,
): Promise<McpServerStatus> {
  return invoke<McpServerStatus>("mcp_server_start", { port, allowWrites, allowedTools });
}

export async function mcpServerStop(): Promise<McpServerStatus> {
  return invoke<McpServerStatus>("mcp_server_stop");
}

export async function mcpServerStatus(): Promise<McpServerStatus> {
  return invoke<McpServerStatus>("mcp_server_status");
}

/** One MCP access (tool call or resource read) recorded by the server. */
export interface McpActivityEntry {
  /** Monotonic per-run id — used to dedupe the backlog against live events. */
  seq: number;
  /** "tool" or "resource". */
  kind: string;
  /** Tool name or resource URI. */
  name: string;
  /** Epoch milliseconds. */
  at: number;
}

export async function mcpServerRecentActivity(): Promise<McpActivityEntry[]> {
  return invoke<McpActivityEntry[]>("mcp_server_recent_activity");
}

// Usage analytics
export async function readUsageAnalytics(): Promise<string> {
  return invoke<string>("read_usage_analytics");
}

// Dictation
export function listAudioDevices(): Promise<unknown> {
  return invoke("list_audio_devices");
}

export function startRecordingCmd(
  deviceId?: string | null,
  deviceIndex?: number | null,
): Promise<void> {
  return invoke("start_recording", {
    deviceId: deviceId ?? null,
    deviceIndex: deviceIndex ?? null,
  });
}

export function stopRecordingCmd(): Promise<import("@/types/dictation").DictationResult> {
  return invoke("stop_recording");
}

export function cancelRecordingCmd(): Promise<void> {
  return invoke("cancel_recording");
}

export function deliverDictationText(text: string, paste: boolean): Promise<void> {
  return invoke("deliver_dictation_text", { text, paste });
}

/** Remove one transcript. Rejects when `id` matched no row, so a caller that
 *  dropped the row optimistically can put it back. */
export function deleteDictationEntry(id: number): Promise<void> {
  return invoke("delete_dictation_entry", { id });
}

/** Remove every transcript. Resolves with the number of rows deleted. */
export function clearDictationHistory(): Promise<number> {
  return invoke("clear_dictation_history");
}

export function getDictationHistory(limit: number, offset: number): Promise<string> {
  return invoke<string>("get_dictation_history", { limit, offset });
}

export function getDictationAnalytics(): Promise<string> {
  return invoke<string>("get_dictation_analytics");
}

export function searchDictationHistory(query: string): Promise<string> {
  return invoke<string>("search_dictation_history", { query });
}

export function getDictationSettings(): Promise<string> {
  return invoke<string>("get_dictation_settings");
}

export function setDictationSettings(settings: string): Promise<void> {
  return invoke("set_dictation_settings", { settings });
}

export function downloadWhisperModel(size: string): Promise<void> {
  return invoke("download_whisper_model", { size });
}

export function listWhisperModels(): Promise<unknown> {
  return invoke("list_whisper_models");
}

/** Remove a downloaded Whisper model file and its checksum marker.
 *  Rejects any size that is not one of the shipped model ids. */
export function deleteWhisperModel(size: string): Promise<void> {
  return invoke("delete_whisper_model", { size });
}

export function testAudioDevice(
  deviceId?: string | null,
  deviceIndex?: number | null,
  durationMs = 1_500,
): Promise<import("@/types/dictation").AudioDeviceTestResult> {
  return invoke("test_audio_device", {
    deviceId: deviceId ?? null,
    deviceIndex: deviceIndex ?? null,
    durationMs,
  });
}

// API Keys
export async function setApiKey(provider: string, key: string): Promise<void> {
  return invoke("set_api_key", { provider, key });
}

export async function getApiKeyExists(provider: string): Promise<boolean> {
  return invoke<boolean>("get_api_key_exists", { provider });
}

export async function deleteApiKey(provider: string): Promise<void> {
  return invoke("delete_api_key", { provider });
}

// === WI-1: auxiliary AI routing ===========================================
//
// The routing store owns persistence (localStorage `packetbench:routing-aux`)
// and mirrors it into the backend, which is where resolution happens — only
// Rust can see the OS keyring, so only Rust can answer "which providers are
// actually configured, and which is cheapest". See
// `src-tauri/src/core/aux_llm.rs`.

/**
 * Replace the backend's mirror of the auxiliary routing settings. Keys are
 * `AuxTaskClass` ids; a task class with `provider: null` is omitted, which the
 * backend reads as "Auto (cheapest configured)".
 */
export async function setAuxRoutingOverrides(
  overrides: Record<string, { provider?: string | null; model?: string | null }>,
): Promise<void> {
  return invoke("set_aux_routing_overrides", { overrides });
}

/** What every auxiliary task class resolves to right now. */
export async function getAuxRouteResolutions(): Promise<
  import("@/types/routing").AuxRouteResolution[]
> {
  return invoke<import("@/types/routing").AuxRouteResolution[]>("get_aux_route_resolutions");
}

/** Providers an auxiliary task class may be pinned to, with credential status. */
export async function getAuxProviderOptions(): Promise<
  import("@/types/routing").AuxProviderOption[]
> {
  return invoke<import("@/types/routing").AuxProviderOption[]>("get_aux_provider_options");
}

export type ProviderAuthStatus = {
  status:
    | "ready"
    | "login_required"
    | "missing_key"
    | "service_down"
    | "coming_soon"
    /**
     * Indeterminate — we could not prove either way. Emitted only by
     * `getProviderAuthStatusForDir` for a claude account dir on macOS, where
     * credentials live in the login Keychain and we deliberately do not
     * guess at the (unconfirmed) per-config-dir namespacing. Treat as
     * "probably fine": show a caveat, do NOT block a launch on it.
     */
    | "unknown";
  hint: string; // short CTA/explanation, e.g. "Run claude login" or "Ollama not reachable"
};

export async function getProviderAuthStatus(provider: string): Promise<ProviderAuthStatus> {
  return invoke("get_provider_auth_status", { provider });
}

/**
 * Per-account sibling of {@link getProviderAuthStatus}: probes the credential
 * state of one CLI account's `configDir` (what a launch points
 * `CLAUDE_CONFIG_DIR` / `CODEX_HOME` at).
 *
 * Pass `""` for `configDir` to mean "no account selected" — the backend then
 * delegates to the ambient zero-arg probe, so this is safe to call
 * unconditionally, including for API-key providers. A non-empty `configDir`
 * is only supported for `claude-oauth` and `openai-codex` and rejects
 * otherwise.
 */
export async function getProviderAuthStatusForDir(
  provider: string,
  configDir: string,
): Promise<ProviderAuthStatus> {
  return invoke("get_provider_auth_status_for_dir", { provider, configDir });
}

export type CliAccountSeedResult = {
  createdDir: boolean;
  copied: string[];
  skippedExisting: string[];
};

/**
 * Create a CLI account's config dir and carry the NON-SECRET configuration
 * (`settings.json` / `config.toml`) over from the ambient dir.
 *
 * `CLAUDE_CONFIG_DIR` / `CODEX_HOME` relocate the CLI's whole state root, so a
 * fresh account dir would otherwise start with no statusline hook and none of
 * the MCP servers PacketBench writes into `~/.claude/settings.json` — a blank
 * status bar and missing tools with nothing on screen to explain it.
 *
 * Credential files are never copied (the allowlist is hard-coded in Rust):
 * cloning the login would defeat the entire point of a second account.
 * Existing files in the target are never overwritten.
 */
export async function seedCliAccountConfigDir(
  sourceDir: string,
  targetDir: string,
): Promise<CliAccountSeedResult> {
  return invoke("seed_cli_account_config_dir", { sourceDir, targetDir });
}

/**
 * Sign out of a subscription OAuth provider by deleting its credential
 * file(s). Supported providers: `claude-oauth`, `openai-codex`. Returns
 * the number of files removed (0 if already signed out).
 */
export async function signOutProvider(provider: string): Promise<number> {
  return invoke<number>("sign_out_provider", { provider });
}

// Ollama local model discovery — queries the Ollama daemon's /api/tags
// endpoint to list models the user has pulled locally. Returns an empty
// array when the daemon is reachable but has no models. Throws on
// connection failure.
export type OllamaModel = {
  name: string;
  size: number | null;
  modified_at: string | null;
  /** `false` = daemon says the model has no tools template (disable in
   * tool-carrying pickers); `null`/`undefined` = unknown (old daemon) and
   * must render as a normal, selectable row. */
  supportsTools?: boolean | null;
  /** Trained context window in tokens, when reported. */
  contextLength?: number | null;
};

export async function getOllamaBaseUrl(): Promise<string> {
  return invoke<string>("get_ollama_base_url");
}

export async function setOllamaBaseUrl(baseUrl: string | null): Promise<string> {
  return invoke<string>("set_ollama_base_url", { baseUrl });
}

export async function listOllamaModels(): Promise<OllamaModel[]> {
  return invoke("list_ollama_models");
}

// Live per-provider model discovery — asks the provider itself what it will
// serve right now, so pickers need not ship a hardcoded catalog.
//
// Every field but `id` is optional because no two provider catalogs publish the
// same thing. `null` means "the provider did not say" and MUST fall back to the
// local table — never render it as a zero. Coverage as of the Rust
// implementation (`src-tauri/src/commands/provider_models.rs`):
//
//   anthropic   id, displayName, contextWindow, maxOutput      (no pricing)
//   openai      id only                                        (noisy list, filtered)
//   openrouter  id, displayName, contextWindow, maxOutput, pricing
//   minimax     id only
//   ollama      id, contextWindow (newer daemons only)
//   custom      id only
// Optional AND nullable, deliberately. Serde emits every key, so the wire
// always carries `null` rather than omitting the field — but callers that
// CONSTRUCT a LiveModel (tests, fixtures, a future non-IPC producer) should not
// have to spell out five nulls to say "unknown". `?: T | null` accepts both,
// and every reader already treats the two identically.
export type LiveModel = {
  /** The exact string to send as `model`. */
  id: string;
  displayName?: string | null;
  /** Input context window in tokens. */
  contextWindow?: number | null;
  /** Maximum output tokens per response. */
  maxOutput?: number | null;
  /** USD per 1M input tokens. Only OpenRouter publishes this live. */
  inputPerMTok?: number | null;
  /** USD per 1M output tokens. Only OpenRouter publishes this live. */
  outputPerMTok?: number | null;
};

// Live-model error classification is pure, so it lives in its own module —
// see the note at the top of `lib/liveModelErrors.ts`. Re-exported here so the
// command and the way you read its failures stay discoverable together.
export {
  parseLiveModelError,
  isLiveModelSetupError,
  type LiveModelError,
  type LiveModelErrorKind,
} from "@/lib/liveModelErrors";

/**
 * List the models `provider` will serve right now.
 *
 * Accepts either the keyring provider name (`anthropic`, `openai`,
 * `openrouter`, `minimax`, `minimax-api`, `ollama`, `custom`) or the `AgentCli`
 * id (`api-claude`, `api-claude-oauth`, `api-openai`, `api-openai-agents`,
 * `api-openrouter`, `api-minimax`, `api-ollama`, `api-custom`).
 *
 * Rejects with a tagged string; run it through {@link parseLiveModelError}.
 */
export async function listProviderModels(
  provider: string,
): Promise<LiveModel[]> {
  return invoke("list_provider_models", { provider });
}

// LM2 — custom OpenAI-compatible endpoint (vLLM / LM Studio / LiteLLM /
// Together, …). The base URL is stored INCLUDING its `/v1`-style path prefix
// and used verbatim as `{base}/chat/completions`; `null` means unconfigured
// (there is no default). The model list is manual — no cross-server
// discovery route exists.
export async function getCustomCompatBaseUrl(): Promise<string | null> {
  return invoke("get_custom_compat_base_url");
}

export async function setCustomCompatBaseUrl(
  baseUrl: string | null,
): Promise<string | null> {
  return invoke("set_custom_compat_base_url", { baseUrl });
}

export async function getCustomCompatModels(): Promise<string[]> {
  return invoke("get_custom_compat_models");
}

export async function setCustomCompatModels(models: string[]): Promise<string[]> {
  return invoke("set_custom_compat_models", { models });
}

/**
 * Ollama local-runtime knobs, sent on every native `/api/chat` request.
 *
 * `numCtxCap` is a CEILING, not an absolute value: the model's own trained
 * context window (read from `/api/show`) wins when it is smaller, because
 * exceeding it degrades quality via rope scaling. Raising the cap costs VRAM
 * (KV cache is roughly 128 KiB/token on a 7-8B model); leaving it too low means
 * Ollama silently drops the oldest messages.
 *
 * `keepAlive` is how long the daemon keeps the model resident after a turn.
 * Ollama's own default (`5m`) expires inside a normal agent loop and every
 * expiry costs a cold reload.
 */
export type OllamaRuntimeOptions = {
  numCtxCap: number;
  keepAlive: string;
  defaultNumCtxCap: number;
  defaultKeepAlive: string;
};

export async function getOllamaRuntimeOptions(): Promise<OllamaRuntimeOptions> {
  return invoke<OllamaRuntimeOptions>("get_ollama_runtime_options");
}

/** Pass `null` for either field to clear the override and restore the default. */
export async function setOllamaRuntimeOptions(
  numCtxCap: number | null,
  keepAlive: string | null,
): Promise<OllamaRuntimeOptions> {
  return invoke<OllamaRuntimeOptions>("set_ollama_runtime_options", {
    numCtxCap,
    keepAlive,
  });
}

/**
 * MiniMax endpoint. MiniMax serves the same API from two hosts —
 * `https://api.minimax.io/v1` (global, the default) and
 * `https://api.minimaxi.com/v1` (mainland China) — and a key is only valid
 * against one of them. Pass `null` to reset to the default.
 */
export async function getMinimaxBaseUrl(): Promise<string> {
  return invoke<string>("get_minimax_base_url");
}

export async function setMinimaxBaseUrl(baseUrl: string | null): Promise<string> {
  return invoke<string>("set_minimax_base_url", { baseUrl });
}

export interface ImageAttachment {
  media_type: string;
  data_base64: string;
}

export interface ResumeMessage {
  role: "user" | "assistant" | "system";
  content: string;
}

export interface SshConfigInput {
  host: string;
  port: number;
  user: string;
  remote_path: string;
  key_path?: string | null;
  auth_method?: "agent" | "key" | "password" | null;
  /** Phase 2: callers should derive this from `ServerConfig` (the canonical
   *  SSH model) so flight attempts and API-agent sessions pin host keys
   *  instead of falling back to TOFU. Frontend conversion site lives in
   *  `agentTaskStore` (per-message build) and `LaunchAsyncFlightModal`
   *  (per-attempt spec build). */
  target_id?: string | null;
  host_fingerprint?: string | null;
}

export type ApiAgentWorkspaceInput =
  | {
      kind: "local";
      projectPath: string;
    }
  | {
      kind: "ssh";
      serverId?: string | null;
      host: string;
      port: number;
      user: string;
      remotePath: string;
      keyPath?: string | null;
      authMethod?: "agent" | "key" | "password" | null;
      hostFingerprint?: string | null;
    };

function apiAgentWorkspaceFrom(
  projectPath: string,
  sshConfig?: SshConfigInput | null,
): ApiAgentWorkspaceInput {
  if (!sshConfig) return { kind: "local", projectPath };
  return {
    kind: "ssh",
    serverId: sshConfig.target_id ?? null,
    host: sshConfig.host,
    port: sshConfig.port,
    user: sshConfig.user,
    remotePath: sshConfig.remote_path,
    keyPath: sshConfig.key_path ?? null,
    authMethod: sshConfig.auth_method ?? null,
    hostFingerprint: sshConfig.host_fingerprint ?? null,
  };
}

export interface SlashCommandDef {
  name: string;
  description: string;
  body: string;
  source: string;
}

// API Agent Sessions
export async function startApiAgentSession(
  sessionId: string,
  provider: string,
  model: string,
  projectPath: string,
  initialMessage: string,
  systemPromptOverride?: string | null,
  thinkingEnabled?: boolean,
  attachments?: ImageAttachment[],
  planMode?: boolean,
  sshConfig?: SshConfigInput | null,
  allowedTools?: string[] | null,
  /** v3: opaque resume token from a prior `done` event. Lets sidecar
   * providers continue the model-side conversation across app restarts. */
  resumeToken?: string | null,
  /** F9: per-conversation MCP server filter. null = all enabled servers
   * (back-compat). [] = explicitly none. Otherwise only listed names are
   * forwarded to the sidecar. Applied on session start; no mid-session
   * swap (sidecar protocol has no `set_mcp_servers`). */
  enabledMcpServerIds?: string[] | null,
  /** Persisted transcript used when rehydrating providers that do not have a
   * native provider resume token, or when restoring in-process histories. */
  resumeMessages?: ResumeMessage[] | null,
  permissionMode?: "auto" | "ask_for_risky" | "allow_all" | "deny_all" | null,
  approveWrites?: boolean | null,
  commandPath?: string | null,
  workspace?: ApiAgentWorkspaceInput | null,
  /** MCPH4: immutable per-server authority captured for this session. */
  mcpTrustSnapshot?: McpTrustSnapshot[] | null,
): Promise<void> {
  return invoke("start_api_agent_session", {
    sessionId,
    provider,
    model,
    projectPath,
    initialMessage,
    systemPromptOverride: systemPromptOverride ?? null,
    thinkingEnabled: thinkingEnabled ?? null,
    attachments: attachments ?? null,
    planMode: planMode ?? null,
    sshConfig: sshConfig ?? null,
    allowedTools: allowedTools ?? null,
    resumeToken: resumeToken ?? null,
    enabledMcpServerIds: enabledMcpServerIds ?? null,
    resumeMessages: resumeMessages ?? null,
    permissionMode: permissionMode ?? null,
    approveWrites: approveWrites ?? null,
    commandPath: commandPath ?? null,
    workspace: workspace ?? apiAgentWorkspaceFrom(projectPath, sshConfig),
    mcpTrustSnapshot: mcpTrustSnapshot ?? null,
  });
}

export async function sendApiAgentMessage(
  sessionId: string,
  message: string,
  attachments?: ImageAttachment[],
): Promise<void> {
  return invoke("send_api_agent_message", {
    sessionId,
    message,
    attachments: attachments ?? null,
  });
}

export async function setPlanMode(sessionId: string, enabled: boolean): Promise<void> {
  return invoke("set_plan_mode", { sessionId, enabled });
}

export async function setPermissionMode(
  sessionId: string,
  mode: "auto" | "ask_for_risky" | "allow_all" | "deny_all",
): Promise<void> {
  return invoke("set_permission_mode", { sessionId, mode });
}

export async function respondPermission(
  sessionId: string,
  toolId: string,
  decision: "allow_once" | "allow_always" | "deny",
  /** P1-9 deny-and-continue: optional steering text carried with a "deny".
   * The provider folds it into the synthetic tool result so the model is
   * redirected instead of stalled. Ignored for allow decisions. */
  reason?: string,
): Promise<void> {
  return invoke("respond_permission", {
    sessionId,
    toolId,
    decision,
    reason: reason ?? null,
  });
}

export async function setApproveWrites(sessionId: string, enabled: boolean): Promise<void> {
  return invoke("set_approve_writes", { sessionId, enabled });
}

export async function respondEdit(
  sessionId: string,
  toolId: string,
  decision: "apply" | "reject",
  /** v3: when set, the sidecar provider writes this content directly
   * (per-hunk acceptance) instead of letting the model's full `after`
   * land. In-process providers ignore this for now. */
  mergedContent?: string,
): Promise<void> {
  return invoke("respond_edit", {
    sessionId,
    toolId,
    decision,
    mergedContent: mergedContent ?? null,
  });
}

export async function retryLastTurn(sessionId: string, newModel?: string): Promise<void> {
  return invoke("retry_last_turn", { sessionId, newModel: newModel ?? null });
}

export async function exportConversationMarkdown(
  title: string,
  model: string,
  messagesJson: string,
): Promise<string> {
  return invoke<string>("export_conversation_markdown", { title, model, messagesJson });
}

export async function listSlashCommands(projectPath: string): Promise<SlashCommandDef[]> {
  return invoke<SlashCommandDef[]>("list_slash_commands", { projectPath });
}

export interface SkillDef {
  name: string;
  description: string;
  argumentHint?: string;
  userInvocable: boolean;
  source: string;
  body: string;
}

export async function listSkills(projectPath: string): Promise<SkillDef[]> {
  return invoke<SkillDef[]>("list_skills", { projectPath });
}

export async function cancelApiAgentSession(sessionId: string): Promise<void> {
  return invoke("cancel_api_agent_session", { sessionId });
}

/**
 * F8: drain parked permission/edit prompts as denied without killing the
 * agent loop. The model continues with synthetic "User cancelled this tool"
 * tool_results. Use `cancelApiAgentSession` instead when the user wants the
 * whole conversation to stop.
 */
export async function cancelPendingTools(sessionId: string): Promise<void> {
  return invoke("cancel_pending_tools", { sessionId });
}

export async function closeApiAgentSession(sessionId: string): Promise<void> {
  return invoke("close_api_agent_session", { sessionId });
}

// API Agent: persistence + utilities
export async function saveConversation(id: string, data: string): Promise<void> {
  return invoke("save_conversation", { id, data });
}

export async function loadConversations(): Promise<string[]> {
  return invoke<string[]>("load_conversations");
}

export async function deleteConversationFile(id: string): Promise<void> {
  return invoke("delete_conversation_file", { id });
}

export async function changeAgentModel(sessionId: string, newModel: string): Promise<void> {
  return invoke("change_model", { sessionId, newModel });
}

export async function listProjectFiles(
  projectPath: string,
  filter?: string,
  limit?: number,
): Promise<string[]> {
  return invoke<string[]>("list_project_files", {
    projectPath,
    filter: filter ?? null,
    limit: limit ?? null,
  });
}

export async function readFileForDiff(
  projectPath: string,
  relPath: string,
): Promise<string | null> {
  return invoke<string | null>("read_file_for_diff", { projectPath, relPath });
}

/** P1-S4: a file's committed content at `HEAD` for the clickable
 *  GitDashboard diff view. `null` for untracked/new files or an empty repo
 *  (nothing to diff against → the whole working file reads as added). */
export async function getFileHeadContent(
  projectPath: string,
  relPath: string,
): Promise<string | null> {
  return invoke<string | null>("get_file_head_content", { projectPath, relPath });
}

// Side chat — fire-and-forget, but request-scoped. Every stream event carries
// `requestId`; closing/stopping the overlay cancels only that request.
export async function askSideChatStream(
  requestId: string,
  question: string,
  context: string,
): Promise<void> {
  return invoke("ask_side_chat_stream", { requestId, question, context });
}

export async function cancelSideChatStream(requestId: string): Promise<boolean> {
  return invoke<boolean>("cancel_side_chat_stream", { requestId });
}

// === Sidecar lifecycle (v2 Tier 2 slice B) =================================
//
// The Node agent-sidecar is supervised by the Rust backend. This surface lets
// the status-bar chip show its current state and react to transitions.

// Cross-restart counters persisted in `~/.packetbench/sidecar-stats.json`
// (v2 Tier 4 slice A). Populated on every `getSidecarStatus` poll and every
// `sidecar-status:changed` event. All fields snake_case to match the Rust
// wire format verbatim.
export type SidecarLifetimeStats = {
  total_starts: number;
  total_crashes: number;
  last_crash_time: string | null;
  last_version: string | null;
  last_error: string | null;
  total_uptime_secs: number;
};

export type SidecarStatus = {
  /** `incompatible` (F7): the sidecar handshook below the protocol security
   * floor, so it would run MCP servers without this session's trust rules.
   * It is alive but refused — sessions will not start against it. */
  state: "ready" | "restarting" | "down" | "not_started" | "incompatible";
  restart_count: number;
  last_error: string | null;
  pid: number | null;
  version: string | null;
  lifetime: SidecarLifetimeStats;
};

export async function getSidecarStatus(): Promise<SidecarStatus> {
  return invoke<SidecarStatus>("get_sidecar_status");
}

// === Provider launch stats (v2 Tier 4 slice B) =============================
//
// Local-only per-provider launch counter. Increments once per
// `start_api_agent_session` call. Nothing is reported externally; this binding
// just exposes the counter so the existing cost/analytics view could consume
// it later if desired.

export type ProviderLaunchStats = {
  counts: Record<string, number>;
  last_launch: Record<string, string>;
};

export async function getProviderLaunchStats(): Promise<ProviderLaunchStats> {
  return invoke<ProviderLaunchStats>("get_provider_launch_stats");
}

// Code Quality summaries use the configured auxiliary API route and stream
// api-agent:{chunk,done,error}:<sessionId> events to QualityAISummary.

/**
 * Start a one-shot AI summary of every failing check in a run. Returns
 * the `sessionId` to subscribe to.
 *
 * `runId` is an opaque caller-supplied key (frontend uses it for client-
 * side caching so re-opening the modal doesn't re-stream the same
 * summary). `checkOutputs` is keyed by display name (`lint`, `typecheck`,
 * `tests`, `build`, …) and contains the combined stdout/stderr from the
 * check. `checkExitCodes` is parallel and optional (defaults to `1` for
 * missing entries).
 */
export async function codeQualityAiSummarize(
  runId: string,
  projectName: string,
  checkOutputs: Record<string, string>,
  checkExitCodes?: Record<string, number>,
  sessionIdOverride?: string,
): Promise<string> {
  return invoke<string>("code_quality_ai_summarize", {
    runId,
    projectName,
    checkOutputs,
    checkExitCodes: checkExitCodes ?? null,
    sessionIdOverride: sessionIdOverride ?? null,
  });
}

// ---------------------------------------------------------------------------
// Durable localStorage mirror
// ---------------------------------------------------------------------------

/**
 * Read the durable copy of the webview's `packetbench:*` keyspace from the app
 * data dir. Returns `{}` when there is no mirror, or when the file on disk was
 * unreadable or corrupt — "nothing to restore" either way.
 *
 * See `src/lib/storageMirror.ts` for why this exists: `localStorage` is scoped
 * to the bundle identifier, so an identifier change starts the app against an
 * empty store.
 */
export async function loadWebviewStorageMirror(): Promise<Record<string, string>> {
  return invoke<Record<string, string>>("load_webview_storage_mirror");
}

/**
 * Replace the durable mirror with a complete snapshot of the `packetbench:*`
 * keyspace. Whole-snapshot, not a delta, so deletions propagate.
 */
export async function saveWebviewStorageMirror(
  entries: Record<string, string>,
): Promise<void> {
  return invoke<void>("save_webview_storage_mirror", { entries });
}
