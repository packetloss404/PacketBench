// === Flight Status & Priority ===
import type { ProvenanceEnvelope } from "@/types/provenance";

export type FlightStatus =
  | "spec"
  | "draft"
  | "planning"
  | "ready"
  | "active"
  | "paused"
  | "review"
  | "done"
  | "failed"
  | "cancelled";

export type FlightPriority = "low" | "medium" | "high" | "critical";

// === Milestone ===

export interface Milestone {
  id: string;
  flightId: string;
  title: string;
  description: string;
  order: number;
  status: "pending" | "active" | "done" | "failed";
  tasks: Task[];
  validationCriteria: string[];
}

// === Task ===

export type TaskRole = "coordinator" | "builder" | "reviewer" | "scout";

export type TaskStatus =
  | "pending"
  | "blocked"
  | "queued"
  | "running"
  | "approval_needed"
  | "paused"
  | "done"
  | "failed"
  | "cancelled";

export type TaskType =
  | "implementation"
  | "testing"
  | "review"
  | "validation"
  | "research"
  | "refactor"
  | "documentation";

export type ValidationVerdict = "pass" | "fail" | "warn";

export interface TaskHandoff {
  summary: string;
  filesChanged: string[];
  testsNeeded: string[];
  followUps: string[];
}

export interface TaskValidationAssertion {
  label: string;
  status: ValidationVerdict;
  details?: string;
}

export interface TaskValidationReport {
  verdict: ValidationVerdict;
  summary: string;
  assertions: TaskValidationAssertion[];
}

export interface TaskResult {
  exitCode: number | null;
  summary: string;
  filesChanged: string[];
  errors: string[];
  duration: number;
  handoff?: TaskHandoff;
  validation?: TaskValidationReport;
}

export type ReviewType = "tool_call" | "file_write" | "command" | "milestone_gate";

export interface ReviewPacket {
  id: string;
  taskId: string;
  flightId: string;
  milestoneId: string;
  requestedAt: number;
  reviewType: ReviewType;
  summary: string;
  diff?: string;
  command?: string;
  filePaths: string[];
  agentId?: string;
  sessionId?: string;
  provenance?: ProvenanceEnvelope;
}

export interface Task {
  id: string;
  milestoneId: string;
  flightId: string;
  title: string;
  description: string;
  order: number;
  status: TaskStatus;
  type: TaskType;
  role?: TaskRole;
  ownedPaths?: string[];
  agentConfigId: string;
  agentArgs?: string[];
  model?: string;
  dependsOn: string[];
  sessionId: string | null;
  blockedReason?: string;
  handoffLog?: TaskHandoff[];
  result?: TaskResult;
  reviewPacket?: ReviewPacket;
  createdAt: number;
  startedAt?: number;
  completedAt?: number;
  cost: number;
  tokens: number;
  /** Legacy autonomous-Planner replan count; read-compatible only. */
  replanCount?: number;
}

// === Coordination Events ===

export type CoordinationEventType =
  | "task_started"
  | "task_completed"
  | "task_failed"
  | "handoff"
  | "review_requested"
  | "review_resolved"
  | "collision_warning"
  | "escalation";

export interface CoordinationEvent {
  id: string;
  flightId: string;
  type: CoordinationEventType;
  taskId?: string;
  taskTitle?: string;
  agentId?: string;
  summary: string;
  timestamp: number;
  metadata?: Record<string, string>;
  provenance?: ProvenanceEnvelope;
}

// === Async Flight Attempts ===
// An Attempt is one parallel agent session, bound to a git worktree on either
// the local filesystem or a remote SSH host. Flights can also carry an upfront
// conversation-backed plan in `milestones[]`; attempts remain independently
// launchable and are not autonomously scheduled from those tasks.

export type AttemptStatus =
  | "queued"
  | "provisioning"
  | "running"
  | "reviewing"
  | "completed"
  | "failed"
  | "cancelled";

/**
 * E1: structured failure category for a failed attempt (stable snake_case
 * labels mirroring the Rust `AiErrorCategory`). Derived from the attempt's
 * error output at the moment it fails.
 */
export type AttemptFailureCategory =
  | "auth"
  | "billing"
  | "rate_limit"
  | "context_overflow"
  | "timeout"
  | "server_error"
  | "not_installed"
  | "unknown";

export type ReviewGateVerdict = "pass" | "changes_requested" | "blocked";

export type ReviewGateStatus =
  | "pending"
  | "running"
  | "passed"
  | "changes_requested"
  | "blocked"
  | "error"
  | "overridden";

export type ReviewGateFindingSeverity = "info" | "warning" | "error";

export interface ReviewGateFinding {
  severity: ReviewGateFindingSeverity;
  title: string;
  details: string;
  filePath?: string;
  line?: number;
}

export interface ReviewGateReport {
  schemaVersion: 1;
  verdict: ReviewGateVerdict;
  summary: string;
  findings: ReviewGateFinding[];
  evidence: string[];
  provenance?: ProvenanceEnvelope;
}

export interface ReviewGatePolicy {
  enabled: boolean;
  reviewerAgentConfigId: string;
  reviewerModel?: string;
  acceptanceCriteria: string[];
}

export interface ReviewGateEvidence {
  fingerprint: string;
  contextFingerprint: string;
  contextJson?: string;
  baseSha: string;
  headSha: string;
}

export interface ReviewerSession {
  sessionId: string;
  provider: string;
  model: string;
}

export interface AttemptReviewGate {
  status: ReviewGateStatus;
  reviewerConversationId?: string;
  reviewerAgentConfigId?: string;
  reviewerModel?: string;
  evidence?: ReviewGateEvidence;
  reviewerSessions?: ReviewerSession[];
  report?: ReviewGateReport;
  errorMessage?: string;
  startedAt?: number;
  completedAt?: number;
  overriddenAt?: number;
  overrideReason?: string;
}

export type FlightExecutionMode = "independent" | "cooperative";
export type IntegrationBranchStatus =
  | "uninitialized"
  | "ready"
  | "integrating"
  | "needs_attention"
  | "landed";

export interface FlightIntegrationBranch {
  branch: string;
  baseBranch: string;
  baseSha: string;
  headSha: string;
  worktreePath: string;
  targetKind: "local" | "ssh";
  targetId?: string;
  status: IntegrationBranchStatus;
  errorMessage?: string;
  conflictFiles?: string[];
}

export type CoordinationMessageKind =
  | "instruction"
  | "question"
  | "answer"
  | "blocker"
  | "finding"
  | "handoff"
  | "artifact";
export type CoordinationDeliveryStatus =
  | "queued"
  | "delivered"
  | "acknowledged"
  | "failed"
  | "archived";
export type CoordinationRecipientKind = "flight" | "role" | "task" | "attempt" | "session";

export interface CoordinationMessageParty {
  kind: "user" | "agent" | "system";
  id?: string;
  displayName: string;
}

export interface CoordinationMessageRecipient {
  kind: CoordinationRecipientKind;
  id?: string;
  label?: string;
}

export interface CoordinationArtifactRef {
  id: string;
  label: string;
  uri?: string;
  mimeType?: string;
  provenance?: ProvenanceEnvelope;
}

export interface CoordinationAcknowledgement {
  by: CoordinationMessageParty;
  at: number;
  note?: string;
}

export interface CoordinationMessage {
  schemaVersion: 1;
  id: string;
  flightId: string;
  kind: CoordinationMessageKind;
  sender: CoordinationMessageParty;
  recipient: CoordinationMessageRecipient;
  body: string;
  artifacts: CoordinationArtifactRef[];
  status: CoordinationDeliveryStatus;
  createdAt: number;
  deliveredAt?: number;
  acknowledgements: CoordinationAcknowledgement[];
  replyToId?: string;
  dedupeKey: string;
  hopCount: number;
  errorMessage?: string;
  provenance?: ProvenanceEnvelope;
}

export type AutonomyFlightMode = "assisted" | "settings_default" | "yolo";
export type AutonomyToolPosture = "approval_gated" | "allow_in_project";
export type AutonomyRunStatus =
  | "idle"
  | "running"
  | "paused"
  | "stopped"
  | "needs_attention"
  | "completed";
export type AutonomyActionStatus = "started" | "completed" | "failed" | "denied";
export type AutonomyActionKind =
  | "continue"
  | "recover_attempt"
  | "review_remediation"
  | "retry_review"
  | "accept_review_pass"
  | "launch_ready_task"
  | "integrate_attempt"
  | "set_tool_posture";

/** Versioned, bounded authority snapshot. A Flight never follows later Settings
 * edits silently: settings_default copies the effective policy at opt-in time. */
export interface AutonomyPolicy {
  schemaVersion: 1;
  autoRecovery: boolean;
  autoReviewRemediation: boolean;
  autoRunTaskGraph: boolean;
  toolPosture: AutonomyToolPosture;
  maxTotalCost: number;
  maxDurationMinutes: number;
  maxRetriesPerTask: number;
  maxReviewRounds: number;
  maxConcurrentAgents: number;
  allowedRoots: string[];
  /** "local" or a canonical ServerConfig id. */
  allowedTargets: string[];
  allowDraftPrPublishing: boolean;
}

export interface AutonomyActionRecord {
  id: string;
  kind: AutonomyActionKind;
  subjectId?: string;
  status: AutonomyActionStatus;
  reason: string;
  timestamp: number;
  cost: number;
  metadata?: Record<string, string | number | boolean | null>;
}

export interface AutonomyRuntime {
  status: AutonomyRunStatus;
  startedAt?: number;
  pausedAt?: number;
  stoppedAt?: number;
  hardStopReason?: string;
  actionHistory: AutonomyActionRecord[];
  reviewRetryCounts?: Record<string, number>;
}

export type AttemptTarget =
  | { kind: "local"; basePath: string; worktreePath: string }
  | { kind: "ssh"; serverId: string; basePath: string; worktreePath: string };

export interface AttemptRecovery {
  state: "retained" | "discarded";
  reason: string;
  retainedAt: number;
}

export interface FlightDelivery {
  kind: "landed" | "pull_request";
  deliveredAt: number;
  branch: string;
  baseBranch: string;
  commitSha?: string;
  prNumber?: number;
  prUrl?: string;
  attemptId?: string;
}

export interface FlightExecutionTarget {
  kind: "local" | "ssh";
  serverId?: string;
  basePath: string;
}

export interface Attempt {
  id: string;
  flightId: string;
  target: AttemptTarget;
  agentConfigId: string;
  model: string;
  provider: string;
  branch: string;
  baseBranch: string;
  sessionId: string;
  status: AttemptStatus;
  sessionHistory?: ReviewerSession[];
  startedAt?: number;
  completedAt?: number;
  cost: number;
  tokens: number;
  errorMessage?: string;
  /** E1: structured failure category, set when the attempt fails. */
  failureCategory?: AttemptFailureCategory;
  /** RG1: independent reviewer state for this attempt. */
  reviewGate?: AttemptReviewGate;
  recovery?: AttemptRecovery;
  delivery?: FlightDelivery;
  /** Cooperative graph task that owns this isolated attempt. */
  taskId?: string;
  /**
   * v0.8-G: PR number of the draft PR opened for this attempt's branch
   * when the parent Flight has `publishAttemptsAsPrs == true`. Undefined
   * when publishing is disabled, the publish step hasn't run yet, or the
   * publish failed (errors are stored in `errorMessage`).
   */
  draftPrNumber?: number;
}

// === Flight ===

export interface Flight {
  id: string;
  title: string;
  objective: string;
  status: FlightStatus;
  priority: FlightPriority;
  projectPath: string;
  workspaceId: string | null;
  gitBranch?: string;
  milestones: Milestone[];
  linkedSessionIds: string[];
  /** Legacy issue linking (PacketBench-specific) */
  issueIds: string[];
  createdAt: number;
  updatedAt: number;
  completedAt?: number;
  delivery?: FlightDelivery;
  archivedAt?: number;
  stoppedAt?: number;
  coordinationLog?: CoordinationEvent[];
  totalCost: number;
  totalTokens: number;
  /** The single user prompt for an async-mode Flight. */
  prompt?: string;
  /** Parallel agent attempts. Non-empty = async-mode Flight. */
  attempts?: Attempt[];
  /** RG1: opt-in independent reviewer policy. Absent means disabled. */
  reviewGatePolicy?: ReviewGatePolicy;
  /** Undefined is the backward-compatible independent-attempt mode. */
  executionMode?: FlightExecutionMode;
  executionTarget?: FlightExecutionTarget;
  /** Isolated branch/worktree where accepted cooperative tasks converge. */
  integrationBranch?: FlightIntegrationBranch;
  /** Versioned, append-only coordination mailbox. */
  coordinationInbox?: CoordinationMessage[];
  /** Assisted is the backward-compatible default when absent. */
  autonomyMode?: AutonomyFlightMode;
  /** Exact bounded policy snapshot used by this Flight. */
  autonomyPolicy?: AutonomyPolicy;
  /** Persisted supervision state and append-only action history. */
  autonomyRuntime?: AutonomyRuntime;
  /** Normal API-agent conversation used to refine the current upfront plan. */
  planningConversationId?: string;
  // Legacy autonomous-Planner fields — retained only for lossless hydration.
  plannerSessionId?: string;
  plannerStatus?: "idle" | "awake" | "paused" | "quota_paused" | "completed" | "failed";
  plannerCost?: number;
  plannerTokens?: number;
  /** Legacy autonomous-Planner provider id; read-compatible only. */
  plannerProvider?: string;
  /**
   * v0.8-G: when true on an async-mode Flight, the executor pipeline
   * pushes each attempt's branch to origin and opens a draft GitHub PR
   * after the attempt reaches a terminal state. The resulting PR number
   * is written back to `Attempt.draftPrNumber`. Defaults to false for
   * back-compat with previously-persisted Flights.
   */
  publishAttemptsAsPrs?: boolean;
}
