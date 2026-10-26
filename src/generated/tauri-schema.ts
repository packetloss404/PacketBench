// Auto-generated from Rust API DTOs. Run `pnpm generate:tauri-schema` to refresh.

export type WorkspaceAgentSlotDto = "terminal" | "claude-code" | "codex" | "opencode" | "packetcode" | "cursor" | "gemini" | "copilot" | "grok" | "droid" | "kimi" | "amp" | "antigravity" | "aider" | "custom-cli";

export type WorkspaceStatusDto = "active" | "archived";

export type ThemeDto = "dark" | "light";

export type GridPositionDto = { row: number, col: number, };

export type StageDraftAssetInput = { name: string, mimeType: string, dataBase64: string, };

export type StagedDraftAssetDto = { attachmentId: string, name: string, mimeType: string, byteLength: number, sha256: string, };

export type ReadDraftAssetDto = { mediaType: string, dataBase64: string, };

export type DraftAssetMeta = { attachmentId: string, name: string, mimeType: string, byteLength: number, sha256: string, createdAtMs: bigint, };

export type FrozenRuntimeLaunch = {
/**
 * Provider route id (e.g. "anthropic", "openai").
 */
route: string, model: string,
/**
 * Only "checkout" is accepted by R1a.
 */
requestedIsolation: string, draftId: string, draftRevision: string, projectKey: string, basePath: string,
/**
 * The immutable execution authority of the run (R1/R3). Absent on rows
 * written before this field existed; an existing turn is only refused when
 * both sides carry a binding that differs.
 */
execution?: FrozenExecutionBinding,
/**
 * The frozen policy identity of the run (R1/R3 restart recovery). Recorded
 * at prepare time from the same inputs the checkpoints are written with, so
 * a typed resume can still be verified after the app and backend session
 * have genuinely restarted, when no live session remains registered to
 * supply a live policy context. Absent on rows written before this field
 * existed; when absent, a resume without a live session refuses typed
 * fail-closed (the prior behaviour).
 */
policy?: FrozenPolicyIdentity, };

export type FrozenExecutionBinding = {
/**
 * "local" | "ssh"
 */
kind: string, serverId?: string, host?: string, hostFingerprint?: string, };

export type FrozenPolicyIdentity = { schemaVersion: bigint, transportVersion: bigint,
/**
 * `sha256:` of the effective tool allowlist (`*` when unrestricted).
 */
toolPolicyHash: string,
/**
 * `sha256:` of the frozen MCP trust snapshot (empty when none).
 */
mcpHash: string,
/**
 * `sha256:` of `provider:model:execution-label`.
 */
manifestHash: string,
/**
 * Non-secret account label the run was prepared under (e.g. `anthropic`).
 * Recorded for readout/audit; the account identity that actually gates a
 * resume is the provider carried in the manifest/model route, so this field
 * adds no enforcement of its own.
 */
account: string, };

export type PrepareRuntimeRunInput = { operationId: string, conversationId: string,
/**
 * "initial" or "existing".
 */
kind: string, retryOfOperationId?: string, requestDigest: string, launch: FrozenRuntimeLaunch, };

export type PrepareRuntimeRunResult = { operationId: string, conversationId: string, runId: string, epoch: number, phase: string,
/**
 * false when an identical operation+digest was already prepared.
 */
created: boolean, };

export type RuntimeRunSummary = { version: number, runtimeRunId: string, conversationId: string, operationId: string, epoch: number, state: string, resumeMode: string, latestDurableSeq: number, };

export type RuntimeLaunchView = { operationId: string, conversationId: string, runId: string, phase: string, requestDigest: string, createdAt: number, cancelledAt?: number, };

export type RuntimeEventView = { runId: string, seq: number, epoch: number, kind: string, payloadHash: string, createdAt: number, };

export type RuntimeContextSummary = { runId: string, projection?: RuntimeContextProjection, windowKnown: boolean,
/**
 * Human-readable policy note. Never a provider quota, reset or dollar
 * claim.
 */
policyNote: string, };

export type RuntimeContextProjection = { snapshotId: string, modelRoute: string,
/**
 * `"estimate"` — a conservative byte/3 heuristic, never a tokenizer.
 */
countKind: string, totalTokens: number, windowTokens: number | null, reservedOutputTokens: number, safetyMarginTokens: number, blockers: Array<string>, createdAt: number, };

export type ResumeInspection = { runId: string, conversationId: string, operationId: string, epoch: bigint, state: string, latestDurableSeq: bigint, permittedModes: Array<string>, incompatibilities: Array<string>, pendingEffectIds: Array<string>, needsReconciliation: boolean, checkpointId: string | null,
/**
 * Opaque revision token the caller echoes back to `resume_run`. Present iff
 * a checkpoint row exists (even a corrupt/newer one).
 */
inspectedRevision: string | null, };

export type RuntimeCapabilityView = { version: number, provider: string, model: string, tools: ToolsCapabilityView, vision: BoolCapabilityView, reasoning: ReasoningCapabilityView, structuredOutput: BoolCapabilityView, contextWindow: ContextWindowCapabilityView, resumability: ResumabilityCapabilityView, };

export type BoolCapabilityView = { state: string, provenance: string, reason?: string, value?: boolean, };

export type ToolsCapabilityView = { state: string, provenance: string, reason?: string, parallel?: boolean, };

export type ContextWindowCapabilityView = { state: string, provenance: string, reason?: string, window?: number, };

export type ReasoningCapabilityView = { state: string, provenance: string, reason?: string, controls?: Array<string>, outputBudgetSemantics?: string, };

export type ResumabilityCapabilityView = { state: string, provenance: string, reason?: string, mode?: string, formatVersion?: string, };

export type TerminalShellSelectionDto = { profile: string, executable?: string, args?: Array<string>, wslDistro?: string, };

export type CustomCliConfig = { name: string, command: string, args: Array<string>, env: { [key in string]?: string }, workingDirectory?: string, };

export type WorkspacePaneDto = { id: string, agentId: WorkspaceAgentSlotDto, sessionId: string | null, gridPosition: GridPositionDto, accentColor?: string, pinnedCommands?: Array<string>, taskId?: string, flightId?: string, agentConfigId?: string, initialPrompt?: string, overrideCommand?: string, overrideArgs?: Array<string>,
/**
 * Pane kind discriminant (tile program, P1-S1). Absent ⇒ terminal. `kind`
 * is the SOLE discriminant; `agent_id` is never overloaded — conversation
 * panes carry the inert carrier `agentId: "terminal"`.
 */
kind?: string,
/**
 * Set iff `kind == Some("conversation")`.
 */
conversationId?: string,
/**
 * Multi-account CLI support: the `CliAccount.id` this pane launches
 * under. Absent ⇒ ambient login (today's behaviour). Inert
 * `#[serde(default)]` mirror of core `WorkspacePane.account_id`.
 */
accountId?: string,
/**
 * Raw-terminal pane shell override. Absent means inherit/Auto.
 */
terminalShell?: TerminalShellSelectionDto, customCli?: CustomCliConfig,
/**
 * Set iff `kind == Some("file")` — the absolute path this viewer tile
 * shows. Inert `#[serde(default)]` mirror of core `WorkspacePane`.
 */
filePath?: string,
/**
 * Initial view mode for a `kind == Some("file")` pane (`"preview"` |
 * `"raw"`). Absent ⇒ the editor's own per-extension default.
 */
fileView?: string, };

export type GithubRepoDto = { owner: string, repo: string, };

export type ExecutionTargetRefDto = { "kind": "local" } | { "kind": "ssh", serverId: string, };

export type WorkspaceDto = { id: string, name: string, agents: Array<WorkspaceAgentSlotDto>, panes: Array<WorkspacePaneDto>, projectPath: string, prompt?: string, createdAt: number, updatedAt: number, status: WorkspaceStatusDto, bypassPermissions?: boolean, modelOverrides?: { [key in string]?: string | null }, effortOverrides?: { [key in string]?: string | null }, serverId?: string, remoteProjectPath?: string, githubRepo?: GithubRepoDto,
/**
 * Tile program (P1-S2): `"conversation"` for auto-materialized
 * conversation wrappers, else absent. Inert `#[ts(optional)]` mirror of
 * core `Workspace.origin`.
 */
origin?: string,
/**
 * Workspace raw-terminal shell override. Absent means app default/Auto.
 */
terminalShell?: TerminalShellSelectionDto,
/**
 * Hand-arranged mosaic tile layout, carried opaquely — the react-mosaic
 * tree is the frontend's shape and the backend never interprets it.
 * Absent ⇒ the pane-count preset. Inert `#[serde(default)]` mirror of
 * core `Workspace.layout`.
 */
layout?: unknown, executionTarget?: ExecutionTargetRefDto, };

export type ServerConfigDto = { id: string, name: string, host: string, port: number, username: string, authMethod: string, keyPath: string | null, remotePath: string | null, lastConnectedAt: bigint | null, installedAgents: Array<string>, hostFingerprint: string | null, };

export type CliAccountDto = { id: string, label: string,
/**
 * "claude-code" | "codex"
 */
cli: string, configDir: string, email: string | null,
/**
 * Millisecond epoch. Typed as `number` (not ts-rs' default `bigint`)
 * because these are `Date.now()` values, which are exactly
 * representable as f64 and are far friendlier to the store code.
 */
createdAt: number, lastUsedAt: number | null, };

export type PersistedUiStateDto = { selectedFlightId?: string, selectedView?: string, theme?: ThemeDto,
/**
 * IANA zone name, or an empty string to clear back to the host system
 * zone. Kept as a free string rather than an enum: the tz database has
 * ~600 zones and gains new ones, so an enum would need regenerating
 * whenever IANA publishes a release.
 */
timeZone?: string, };

export type OrchestratorSettingsDto = { maxParallelSessions: number, milestoneGating: boolean, projectPath: string, autoCommitTrailerEnabled: boolean, autoCommitTrailerFormat: string, autonomyDefaultMode?: AutonomyDefaultModeDto, autonomyDefaultPolicy?: AutonomyPolicyDto, };

export type AgentCapabilityDto = "code_edit" | "code_review" | "testing" | "research" | "shell" | "refactor";

export type ToolUsePatternDto = { pattern: string, tool: string, fileGroup?: number, };

export type AgentStatusPatternsDto = { approval: Array<string>, thinking: Array<string>, toolUse: Array<ToolUsePatternDto>, idle: Array<string>, };

export type AgentApprovalActionsDto = { approve: string, deny: string, abort: string, };

export type AgentConfigDto = { id: string, name: string, command: string, defaultArgs: Array<string>, description: string, installed: boolean, capabilities: Array<AgentCapabilityDto>, icon: string, color: string, statusPatterns: AgentStatusPatternsDto, approvalActions: AgentApprovalActionsDto, isBuiltin: boolean, };

export type FlightStatusDto = "draft" | "spec" | "planning" | "ready" | "active" | "paused" | "review" | "done" | "failed" | "cancelled";

export type PlannerStatusDto = "idle" | "awake" | "paused" | "quota_paused" | "completed" | "failed";

export type FlightApprovalRequestDto = { id: string, flightId: string, question: string, options: Array<string>, awaitingSince: number, resolved: boolean, resolution?: string, resolvedAt?: number, };

export type FlightPriorityDto = "low" | "medium" | "high" | "critical";

export type MilestoneStatusDto = "pending" | "active" | "done" | "failed";

export type TaskStatusDto = "pending" | "blocked" | "queued" | "running" | "approval_needed" | "paused" | "done" | "failed" | "cancelled";

export type TaskTypeDto = "implementation" | "testing" | "review" | "validation" | "research" | "refactor" | "documentation";

export type ValidationVerdictDto = "pass" | "fail" | "warn";

export type ReviewTypeDto = "tool_call" | "file_write" | "command" | "milestone_gate";

export type TaskHandoffDto = { summary: string, filesChanged: Array<string>, testsNeeded: Array<string>, followUps: Array<string>, };

export type TaskValidationAssertionDto = { label: string, status: ValidationVerdictDto, details?: string, };

export type TaskValidationReportDto = { verdict: ValidationVerdictDto, summary: string, assertions: Array<TaskValidationAssertionDto>, };

export type TaskResultDto = { exitCode: number | null, summary: string, filesChanged: Array<string>, errors: Array<string>, duration: number, handoff?: TaskHandoffDto, validation?: TaskValidationReportDto, };

export type ReviewPacketDto = { id: string, taskId: string, flightId: string, milestoneId: string, requestedAt: number, reviewType: ReviewTypeDto, summary: string, diff?: string, command?: string, filePaths: Array<string>, agentId?: string, sessionId?: string, };

export type TaskDto = { id: string, milestoneId: string, flightId: string, title: string, description: string, order: number, status: TaskStatusDto, type: TaskTypeDto, agentConfigId: string, agentArgs?: Array<string>, model?: string, dependsOn: Array<string>, sessionId: string | null, result?: TaskResultDto, reviewPacket?: ReviewPacketDto, createdAt: number, startedAt?: number, completedAt?: number, cost: number, tokens: number,
/**
 * Legacy autonomous-Planner replan count; read-compatible only.
 */
replanCount: number, ownedPaths?: Array<string>, };

export type MilestoneDto = { id: string, flightId: string, title: string, description: string, order: number, status: MilestoneStatusDto, tasks: Array<TaskDto>, validationCriteria: Array<string>, };

export type AttemptStatusDto = "queued" | "provisioning" | "running" | "reviewing" | "completed" | "failed" | "cancelled";

export type AttemptTargetDto = { "kind": "local", basePath: string, worktreePath: string, } | { "kind": "ssh", serverId: string, basePath: string, worktreePath: string, };

export type ReviewGateVerdictDto = "pass" | "changes_requested" | "blocked";

export type ReviewGateStatusDto = "pending" | "running" | "passed" | "changes_requested" | "blocked" | "error" | "overridden";

export type ReviewGateFindingSeverityDto = "info" | "warning" | "error";

export type ReviewGateFindingDto = { severity: ReviewGateFindingSeverityDto, title: string, details: string, filePath?: string, line?: number, };

export type ReviewGateReportDto = { schemaVersion: 1, verdict: ReviewGateVerdictDto, summary: string, findings: Array<ReviewGateFindingDto>, evidence: Array<string>, };

export type ReviewGatePolicyDto = { enabled: boolean, reviewerAgentConfigId: string, reviewerModel?: string, acceptanceCriteria: Array<string>, };

export type ReviewGateEvidenceDto = { fingerprint: string, contextFingerprint: string, contextJson: string, baseSha: string, headSha: string, };

export type ReviewerSessionDto = { sessionId: string, provider: string, model: string, };

export type AttemptReviewGateDto = { status: ReviewGateStatusDto, reviewerConversationId?: string, reviewerAgentConfigId?: string, reviewerModel?: string, evidence?: ReviewGateEvidenceDto, reviewerSessions: Array<ReviewerSessionDto>, report?: ReviewGateReportDto, errorMessage?: string, startedAt?: number, completedAt?: number, overriddenAt?: number, overrideReason?: string, };

export type FlightExecutionModeDto = "independent" | "cooperative";

export type IntegrationBranchStatusDto = "uninitialized" | "ready" | "integrating" | "needs_attention" | "landed";

export type FlightIntegrationBranchDto = { branch: string, baseBranch: string, baseSha: string, headSha: string, worktreePath: string, targetKind: string, targetId?: string, status: IntegrationBranchStatusDto, errorMessage?: string, conflictFiles: Array<string>, };

export type AutonomyFlightModeDto = "assisted" | "settings_default" | "yolo";

export type AutonomyDefaultModeDto = "assisted" | "yolo";

export type AutonomyToolPostureDto = "approval_gated" | "allow_in_project";

export type AutonomyRunStatusDto = "idle" | "running" | "paused" | "stopped" | "needs_attention" | "completed";

export type AutonomyActionStatusDto = "started" | "completed" | "failed" | "denied";

export type AutonomyActionKindDto = "continue" | "recover_attempt" | "review_remediation" | "retry_review" | "accept_review_pass" | "launch_ready_task" | "integrate_attempt" | "set_tool_posture";

export type AutonomyPolicyDto = { schemaVersion: 1, autoRecovery: boolean, autoReviewRemediation: boolean, autoRunTaskGraph: boolean, toolPosture: AutonomyToolPostureDto, maxTotalCost: number, maxDurationMinutes: number, maxRetriesPerTask: number, maxReviewRounds: number, maxConcurrentAgents: number, allowedRoots: Array<string>, allowedTargets: Array<string>, allowDraftPrPublishing: boolean, };

export type AutonomyActionRecordDto = { id: string, kind: AutonomyActionKindDto, subjectId?: string, status: AutonomyActionStatusDto, reason: string, timestamp: number, cost: number, metadata?: Record<string, string | number | boolean | null>, };

export type AutonomyRuntimeDto = { status: AutonomyRunStatusDto, startedAt?: number, pausedAt?: number, stoppedAt?: number, hardStopReason?: string, actionHistory: Array<AutonomyActionRecordDto>, reviewRetryCounts?: { [key in string]?: number }, };

export type CoordinationMessageKindDto = "instruction" | "question" | "answer" | "blocker" | "finding" | "handoff" | "artifact";

export type CoordinationDeliveryStatusDto = "queued" | "delivered" | "acknowledged" | "failed" | "archived";

export type CoordinationMessagePartyDto = { kind: string, id?: string, displayName: string, };

export type CoordinationMessageRecipientDto = { kind: string, id?: string, label?: string, };

export type CoordinationArtifactRefDto = { id: string, label: string, uri?: string, mimeType?: string, };

export type CoordinationAcknowledgementDto = { by: CoordinationMessagePartyDto, at: number, note?: string, };

export type CoordinationMessageDto = { schemaVersion: 1, id: string, flightId: string, kind: CoordinationMessageKindDto, sender: CoordinationMessagePartyDto, recipient: CoordinationMessageRecipientDto, body: string, artifacts: Array<CoordinationArtifactRefDto>, status: CoordinationDeliveryStatusDto, createdAt: number, deliveredAt?: number, acknowledgements: Array<CoordinationAcknowledgementDto>, replyToId?: string, dedupeKey: string, hopCount: number, errorMessage?: string, };

export type AttemptRecoveryDto = { state: 'retained' | 'discarded', reason: string, retainedAt: number, };

export type FlightDeliveryDto = { kind: 'landed' | 'pull_request', deliveredAt: number, branch: string, baseBranch: string, commitSha?: string, prNumber?: number, prUrl?: string, attemptId?: string, };

export type FlightExecutionTargetDto = { kind: 'local' | 'ssh', serverId?: string, basePath: string, };

export type AttemptDto = { id: string, flightId: string, target: AttemptTargetDto, agentConfigId: string, model: string, provider: string, branch: string, baseBranch: string, sessionId: string, status: AttemptStatusDto, sessionHistory?: Array<ReviewerSessionDto>, startedAt?: number, completedAt?: number, cost: number, tokens: number, errorMessage?: string,
/**
 * E1: structured failure category (stable snake_case label) derived when
 * the attempt failed; `None` otherwise.
 */
failureCategory?: string,
/**
 * RG1: independent reviewer lifecycle and verdict.
 */
reviewGate?: AttemptReviewGateDto, recovery?: AttemptRecoveryDto, delivery?: FlightDeliveryDto,
/**
 * Cooperative graph task that owns this attempt.
 */
taskId?: string,
/**
 * v0.8-G: when the parent Flight publishes attempts as draft PRs, the
 * resulting PR number is round-tripped here. Optional everywhere
 * because most attempts will not have a draft PR.
 */
draftPrNumber?: number, };

export type FlightDto = { id: string, title: string, objective: string, status: FlightStatusDto, priority: FlightPriorityDto, projectPath: string, workspaceId?: string, gitBranch?: string, milestones: Array<MilestoneDto>, linkedSessionIds: Array<string>, issueIds: Array<string>, createdAt: number, updatedAt: number, completedAt?: number, delivery?: FlightDeliveryDto, archivedAt?: number, stoppedAt?: number, totalCost: number, totalTokens: number, prompt?: string, attempts: Array<AttemptDto>,
/**
 * RG1: opt-in reviewer policy. Absent means disabled.
 */
reviewGatePolicy?: ReviewGatePolicyDto,
/**
 * Cooperative execution is opt-in; absent means independent.
 */
executionMode?: FlightExecutionModeDto, executionTarget?: FlightExecutionTargetDto, integrationBranch?: FlightIntegrationBranchDto, coordinationInbox: Array<CoordinationMessageDto>, autonomyMode?: AutonomyFlightModeDto, autonomyPolicy?: AutonomyPolicyDto, autonomyRuntime?: AutonomyRuntimeDto,
/**
 * Normal API-agent conversation used to refine the current upfront plan.
 */
planningConversationId?: string,
/**
 * Legacy autonomous-Planner session id; read-compatible only.
 */
plannerSessionId?: string,
/**
 * Legacy autonomous-Planner status; read-compatible only.
 */
plannerStatus?: PlannerStatusDto,
/**
 * Legacy autonomous-Planner cost; read-compatible only.
 */
plannerCost?: number,
/**
 * Legacy autonomous-Planner token count; read-compatible only.
 */
plannerTokens?: number,
/**
 * Legacy autonomous-Planner provider id; read-compatible only.
 */
plannerProvider?: string,
/**
 * v0.8-G: when true on an async-mode Flight, the executor pipeline
 * pushes each attempt's branch and opens a draft PR after the attempt
 * reaches a terminal state. Persisted so the toggle round-trips.
 */
publishAttemptsAsPrs: boolean,
/**
 * N3: append-only coordination timeline. Frontend-owned schema (opaque
 * here) — round-trips so handoff/escalation events survive reload.
 */
coordinationLog: any[], };

export type PersistedStateDto = { version: number, flights: Array<FlightDto>, agents: Array<AgentConfigDto>, issues: any[], settings: OrchestratorSettingsDto, ui: PersistedUiStateDto, workspaces: Array<WorkspaceDto>, memoryEvents: any[], memoryPatterns: any[], servers: Array<ServerConfigDto>, cliAccounts: Array<CliAccountDto>,
/**
 * `project path -> cli -> account id`. See
 * `core::storage::PersistedState::cli_account_defaults`.
 */
cliAccountDefaults: { [key in string]?: { [key in string]?: string } }, };
