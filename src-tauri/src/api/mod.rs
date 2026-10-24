use std::collections::{BTreeMap, HashMap};

use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::commands::draft_assets::{
    DraftAssetMeta, ReadDraftAssetDto, StageDraftAssetInput, StagedDraftAssetDto,
};
use crate::core::runtime_types::{
    FrozenRuntimeLaunch, PrepareRuntimeRunInput, PrepareRuntimeRunResult, RuntimeEventView,
    RuntimeLaunchView, RuntimeRunSummary,
};
use crate::core::{
    agent_config as core_agent, flight as core_flight, orchestrator as core_orchestrator,
    storage as core_storage, workspace as core_workspace,
};

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub enum WorkspaceAgentSlotDto {
    #[serde(rename = "terminal")]
    Terminal,
    #[serde(rename = "claude-code")]
    ClaudeCode,
    #[serde(rename = "codex")]
    Codex,
    #[serde(rename = "opencode")]
    Opencode,
    #[serde(rename = "packetcode")]
    Packetcode,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
pub enum WorkspaceStatusDto {
    Active,
    Archived,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
pub enum ThemeDto {
    Dark,
    Light,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct GridPositionDto {
    pub row: usize,
    pub col: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct TerminalShellSelectionDto {
    pub profile: String,
    #[ts(optional)]
    pub executable: Option<String>,
    #[ts(optional)]
    pub args: Option<Vec<String>>,
    #[ts(optional)]
    pub wsl_distro: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct WorkspacePaneDto {
    pub id: String,
    pub agent_id: WorkspaceAgentSlotDto,
    pub session_id: Option<String>,
    pub grid_position: GridPositionDto,
    #[ts(optional)]
    pub accent_color: Option<String>,
    #[ts(optional)]
    pub pinned_commands: Option<Vec<String>>,
    #[ts(optional)]
    pub task_id: Option<String>,
    #[ts(optional)]
    pub flight_id: Option<String>,
    #[ts(optional)]
    pub agent_config_id: Option<String>,
    #[ts(optional)]
    pub initial_prompt: Option<String>,
    #[ts(optional)]
    pub override_command: Option<String>,
    #[ts(optional)]
    pub override_args: Option<Vec<String>>,
    /// Pane kind discriminant (tile program, P1-S1). Absent ⇒ terminal. `kind`
    /// is the SOLE discriminant; `agent_id` is never overloaded — conversation
    /// panes carry the inert carrier `agentId: "terminal"`.
    #[serde(default)]
    #[ts(optional)]
    pub kind: Option<String>,
    /// Set iff `kind == Some("conversation")`.
    #[serde(default)]
    #[ts(optional)]
    pub conversation_id: Option<String>,
    /// Multi-account CLI support: the `CliAccount.id` this pane launches
    /// under. Absent ⇒ ambient login (today's behaviour). Inert
    /// `#[serde(default)]` mirror of core `WorkspacePane.account_id`.
    #[serde(default)]
    #[ts(optional)]
    pub account_id: Option<String>,
    /// Raw-terminal pane shell override. Absent means inherit/Auto.
    #[serde(default)]
    #[ts(optional)]
    pub terminal_shell: Option<TerminalShellSelectionDto>,
    /// Set iff `kind == Some("file")` — the absolute path this viewer tile
    /// shows. Inert `#[serde(default)]` mirror of core `WorkspacePane`.
    #[serde(default)]
    #[ts(optional)]
    pub file_path: Option<String>,
    /// Initial view mode for a `kind == Some("file")` pane (`"preview"` |
    /// `"raw"`). Absent ⇒ the editor's own per-extension default.
    #[serde(default)]
    #[ts(optional)]
    pub file_view: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    tag = "kind"
)]
#[ts(rename_all = "camelCase")]
pub enum ExecutionTargetRefDto {
    Local,
    Ssh {
        #[ts(rename = "serverId")]
        server_id: String,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct GithubRepoDto {
    pub owner: String,
    pub repo: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceDto {
    pub id: String,
    pub name: String,
    pub agents: Vec<WorkspaceAgentSlotDto>,
    pub panes: Vec<WorkspacePaneDto>,
    pub project_path: String,
    #[ts(optional)]
    pub prompt: Option<String>,
    #[ts(type = "number")]
    pub created_at: u64,
    #[ts(type = "number")]
    pub updated_at: u64,
    pub status: WorkspaceStatusDto,
    #[ts(optional)]
    pub bypass_permissions: Option<bool>,
    #[ts(optional)]
    pub model_overrides: Option<HashMap<String, Option<String>>>,
    #[ts(optional)]
    pub effort_overrides: Option<HashMap<String, Option<String>>>,
    #[ts(optional)]
    pub server_id: Option<String>,
    #[ts(optional)]
    pub remote_project_path: Option<String>,
    #[ts(optional)]
    pub github_repo: Option<GithubRepoDto>,
    /// Tile program (P1-S2): `"conversation"` for auto-materialized
    /// conversation wrappers, else absent. Inert `#[ts(optional)]` mirror of
    /// core `Workspace.origin`.
    #[ts(optional)]
    pub origin: Option<String>,
    /// Workspace raw-terminal shell override. Absent means app default/Auto.
    #[serde(default)]
    #[ts(optional)]
    pub terminal_shell: Option<TerminalShellSelectionDto>,
    /// Hand-arranged mosaic tile layout, carried opaquely — the react-mosaic
    /// tree is the frontend's shape and the backend never interprets it.
    /// Absent ⇒ the pane-count preset. Inert `#[serde(default)]` mirror of
    /// core `Workspace.layout`.
    #[serde(default)]
    #[ts(optional)]
    #[ts(type = "unknown")]
    pub layout: Option<serde_json::Value>,
    #[serde(default)]
    #[ts(optional)]
    pub execution_target: Option<ExecutionTargetRefDto>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct PersistedUiStateDto {
    #[ts(optional)]
    pub selected_flight_id: Option<String>,
    #[ts(optional)]
    pub selected_view: Option<String>,
    #[ts(optional)]
    pub theme: Option<ThemeDto>,
    /// IANA zone name, or an empty string to clear back to the host system
    /// zone. Kept as a free string rather than an enum: the tz database has
    /// ~600 zones and gains new ones, so an enum would need regenerating
    /// whenever IANA publishes a release.
    #[ts(optional)]
    pub time_zone: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct OrchestratorSettingsDto {
    pub max_parallel_sessions: usize,
    pub milestone_gating: bool,
    pub project_path: String,
    #[serde(default = "crate::api::default_auto_commit_trailer_enabled_dto")]
    pub auto_commit_trailer_enabled: bool,
    #[serde(default = "crate::api::default_auto_commit_trailer_format_dto")]
    pub auto_commit_trailer_format: String,
    #[serde(default)]
    #[ts(optional)]
    pub autonomy_default_mode: Option<AutonomyDefaultModeDto>,
    #[serde(default)]
    #[ts(optional)]
    pub autonomy_default_policy: Option<AutonomyPolicyDto>,
}

pub(crate) fn default_auto_commit_trailer_enabled_dto() -> bool {
    true
}

pub(crate) fn default_auto_commit_trailer_format_dto() -> String {
    core_orchestrator::DEFAULT_AUTO_COMMIT_TRAILER_FORMAT.to_string()
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
pub enum AgentCapabilityDto {
    CodeEdit,
    CodeReview,
    Testing,
    Research,
    Shell,
    Refactor,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ToolUsePatternDto {
    pub pattern: String,
    pub tool: String,
    #[ts(optional)]
    pub file_group: Option<usize>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct AgentStatusPatternsDto {
    pub approval: Vec<String>,
    pub thinking: Vec<String>,
    pub tool_use: Vec<ToolUsePatternDto>,
    pub idle: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct AgentApprovalActionsDto {
    pub approve: String,
    pub deny: String,
    pub abort: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct AgentConfigDto {
    pub id: String,
    pub name: String,
    pub command: String,
    pub default_args: Vec<String>,
    pub description: String,
    pub installed: bool,
    pub capabilities: Vec<AgentCapabilityDto>,
    pub icon: String,
    pub color: String,
    pub status_patterns: AgentStatusPatternsDto,
    pub approval_actions: AgentApprovalActionsDto,
    pub is_builtin: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
pub enum FlightStatusDto {
    Draft,
    /// Legacy autonomous-Planner spec status; read-compatible only.
    Spec,
    Planning,
    Ready,
    Active,
    Paused,
    Review,
    Done,
    Failed,
    Cancelled,
}

/// Legacy autonomous-Planner status mirror retained for persisted DTOs.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, TS, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum PlannerStatusDto {
    Idle,
    Awake,
    Paused,
    QuotaPaused,
    Completed,
    Failed,
}

/// Legacy autonomous-Planner approval record retained for persisted DTOs.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct FlightApprovalRequestDto {
    pub id: String,
    #[serde(alias = "missionId")]
    pub flight_id: String,
    pub question: String,
    #[serde(default)]
    pub options: Vec<String>,
    #[ts(type = "number")]
    pub awaiting_since: u64,
    pub resolved: bool,
    #[serde(default)]
    #[ts(optional)]
    pub resolution: Option<String>,
    #[serde(default)]
    #[ts(optional)]
    #[ts(type = "number")]
    pub resolved_at: Option<u64>,
}

impl From<core_flight::FlightApprovalRequest> for FlightApprovalRequestDto {
    fn from(value: core_flight::FlightApprovalRequest) -> Self {
        Self {
            id: value.id,
            flight_id: value.flight_id,
            question: value.question,
            options: value.options,
            awaiting_since: value.awaiting_since,
            resolved: value.resolved,
            resolution: value.resolution,
            resolved_at: value.resolved_at,
        }
    }
}

impl From<FlightApprovalRequestDto> for core_flight::FlightApprovalRequest {
    fn from(value: FlightApprovalRequestDto) -> Self {
        Self {
            id: value.id,
            flight_id: value.flight_id,
            question: value.question,
            options: value.options,
            awaiting_since: value.awaiting_since,
            resolved: value.resolved,
            resolution: value.resolution,
            resolved_at: value.resolved_at,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
pub enum FlightPriorityDto {
    Low,
    Medium,
    High,
    Critical,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
pub enum MilestoneStatusDto {
    Pending,
    Active,
    Done,
    Failed,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
pub enum TaskStatusDto {
    Pending,
    Blocked,
    Queued,
    Running,
    ApprovalNeeded,
    Paused,
    Done,
    Failed,
    Cancelled,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
pub enum TaskTypeDto {
    Implementation,
    Testing,
    Review,
    Validation,
    Research,
    Refactor,
    Documentation,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
pub enum ValidationVerdictDto {
    Pass,
    Fail,
    Warn,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
pub enum ReviewTypeDto {
    ToolCall,
    FileWrite,
    Command,
    MilestoneGate,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct TaskHandoffDto {
    pub summary: String,
    pub files_changed: Vec<String>,
    pub tests_needed: Vec<String>,
    pub follow_ups: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct TaskValidationAssertionDto {
    pub label: String,
    pub status: ValidationVerdictDto,
    #[ts(optional)]
    pub details: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct TaskValidationReportDto {
    pub verdict: ValidationVerdictDto,
    pub summary: String,
    pub assertions: Vec<TaskValidationAssertionDto>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct TaskResultDto {
    pub exit_code: Option<i32>,
    pub summary: String,
    pub files_changed: Vec<String>,
    pub errors: Vec<String>,
    #[ts(type = "number")]
    pub duration: u64,
    #[ts(optional)]
    pub handoff: Option<TaskHandoffDto>,
    #[ts(optional)]
    pub validation: Option<TaskValidationReportDto>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ReviewPacketDto {
    pub id: String,
    pub task_id: String,
    pub flight_id: String,
    pub milestone_id: String,
    #[ts(type = "number")]
    pub requested_at: u64,
    pub review_type: ReviewTypeDto,
    pub summary: String,
    #[ts(optional)]
    pub diff: Option<String>,
    #[ts(optional)]
    pub command: Option<String>,
    pub file_paths: Vec<String>,
    #[ts(optional)]
    pub agent_id: Option<String>,
    #[ts(optional)]
    pub session_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct TaskDto {
    pub id: String,
    pub milestone_id: String,
    pub flight_id: String,
    pub title: String,
    pub description: String,
    pub order: usize,
    pub status: TaskStatusDto,
    #[serde(rename = "type")]
    pub task_type: TaskTypeDto,
    pub agent_config_id: String,
    #[ts(optional)]
    pub agent_args: Option<Vec<String>>,
    #[ts(optional)]
    pub model: Option<String>,
    pub depends_on: Vec<String>,
    pub session_id: Option<String>,
    #[ts(optional)]
    pub result: Option<TaskResultDto>,
    #[ts(optional)]
    pub review_packet: Option<ReviewPacketDto>,
    #[ts(type = "number")]
    pub created_at: u64,
    #[ts(optional)]
    #[ts(type = "number")]
    pub started_at: Option<u64>,
    #[ts(optional)]
    #[ts(type = "number")]
    pub completed_at: Option<u64>,
    pub cost: f64,
    #[ts(type = "number")]
    pub tokens: u64,
    /// Legacy autonomous-Planner replan count; read-compatible only.
    #[serde(default)]
    pub replan_count: u32,
    #[serde(default)]
    #[ts(optional)]
    pub owned_paths: Option<Vec<String>>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct MilestoneDto {
    pub id: String,
    pub flight_id: String,
    pub title: String,
    pub description: String,
    pub order: usize,
    pub status: MilestoneStatusDto,
    pub tasks: Vec<TaskDto>,
    pub validation_criteria: Vec<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
pub enum AttemptStatusDto {
    Queued,
    Provisioning,
    Running,
    Reviewing,
    Completed,
    Failed,
    Cancelled,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case", tag = "kind")]
pub enum AttemptTargetDto {
    Local {
        #[serde(rename = "basePath")]
        base_path: String,
        #[serde(rename = "worktreePath")]
        worktree_path: String,
    },
    Ssh {
        #[serde(rename = "serverId", alias = "targetId", alias = "target_id")]
        #[ts(rename = "serverId")]
        server_id: String,
        #[serde(rename = "basePath")]
        base_path: String,
        #[serde(rename = "worktreePath")]
        worktree_path: String,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
pub enum ReviewGateVerdictDto {
    Pass,
    ChangesRequested,
    Blocked,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
pub enum ReviewGateStatusDto {
    Pending,
    Running,
    Passed,
    ChangesRequested,
    Blocked,
    Error,
    Overridden,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
pub enum ReviewGateFindingSeverityDto {
    Info,
    Warning,
    Error,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ReviewGateFindingDto {
    pub severity: ReviewGateFindingSeverityDto,
    pub title: String,
    pub details: String,
    #[serde(default)]
    #[ts(optional)]
    pub file_path: Option<String>,
    #[serde(default)]
    #[ts(optional)]
    #[ts(type = "number")]
    pub line: Option<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ReviewGateReportDto {
    #[ts(type = "1")]
    pub schema_version: u32,
    pub verdict: ReviewGateVerdictDto,
    pub summary: String,
    #[serde(default)]
    pub findings: Vec<ReviewGateFindingDto>,
    #[serde(default)]
    pub evidence: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ReviewGatePolicyDto {
    #[serde(default)]
    pub enabled: bool,
    pub reviewer_agent_config_id: String,
    #[serde(default)]
    #[ts(optional)]
    pub reviewer_model: Option<String>,
    #[serde(default)]
    pub acceptance_criteria: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ReviewGateEvidenceDto {
    pub fingerprint: String,
    pub context_fingerprint: String,
    #[serde(default)]
    pub context_json: String,
    pub base_sha: String,
    pub head_sha: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ReviewerSessionDto {
    pub session_id: String,
    pub provider: String,
    pub model: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct AttemptReviewGateDto {
    pub status: ReviewGateStatusDto,
    #[serde(default)]
    #[ts(optional)]
    pub reviewer_conversation_id: Option<String>,
    #[serde(default)]
    #[ts(optional)]
    pub reviewer_agent_config_id: Option<String>,
    #[serde(default)]
    #[ts(optional)]
    pub reviewer_model: Option<String>,
    #[serde(default)]
    #[ts(optional)]
    pub evidence: Option<ReviewGateEvidenceDto>,
    #[serde(default)]
    pub reviewer_sessions: Vec<ReviewerSessionDto>,
    #[serde(default)]
    #[ts(optional)]
    pub report: Option<ReviewGateReportDto>,
    #[serde(default)]
    #[ts(optional)]
    pub error_message: Option<String>,
    #[serde(default)]
    #[ts(optional)]
    #[ts(type = "number")]
    pub started_at: Option<u64>,
    #[serde(default)]
    #[ts(optional)]
    #[ts(type = "number")]
    pub completed_at: Option<u64>,
    #[serde(default)]
    #[ts(optional)]
    #[ts(type = "number")]
    pub overridden_at: Option<u64>,
    #[serde(default)]
    #[ts(optional)]
    pub override_reason: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
pub enum FlightExecutionModeDto {
    Independent,
    Cooperative,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
pub enum IntegrationBranchStatusDto {
    Uninitialized,
    Ready,
    Integrating,
    NeedsAttention,
    Landed,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct FlightIntegrationBranchDto {
    pub branch: String,
    pub base_branch: String,
    pub base_sha: String,
    pub head_sha: String,
    pub worktree_path: String,
    pub target_kind: String,
    #[serde(default)]
    #[ts(optional)]
    pub target_id: Option<String>,
    pub status: IntegrationBranchStatusDto,
    #[serde(default)]
    #[ts(optional)]
    pub error_message: Option<String>,
    #[serde(default)]
    pub conflict_files: Vec<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
pub enum AutonomyFlightModeDto {
    Assisted,
    SettingsDefault,
    Yolo,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
pub enum AutonomyDefaultModeDto {
    Assisted,
    Yolo,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
pub enum AutonomyToolPostureDto {
    ApprovalGated,
    AllowInProject,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
pub enum AutonomyRunStatusDto {
    Idle,
    Running,
    Paused,
    Stopped,
    NeedsAttention,
    Completed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
pub enum AutonomyActionStatusDto {
    Started,
    Completed,
    Failed,
    Denied,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
pub enum AutonomyActionKindDto {
    Continue,
    RecoverAttempt,
    ReviewRemediation,
    RetryReview,
    AcceptReviewPass,
    LaunchReadyTask,
    IntegrateAttempt,
    SetToolPosture,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct AutonomyPolicyDto {
    #[ts(type = "1")]
    pub schema_version: u32,
    pub auto_recovery: bool,
    pub auto_review_remediation: bool,
    pub auto_run_task_graph: bool,
    pub tool_posture: AutonomyToolPostureDto,
    pub max_total_cost: f64,
    pub max_duration_minutes: u32,
    pub max_retries_per_task: u32,
    pub max_review_rounds: u32,
    pub max_concurrent_agents: u32,
    #[serde(default)]
    pub allowed_roots: Vec<String>,
    #[serde(default)]
    pub allowed_targets: Vec<String>,
    #[serde(default)]
    pub allow_draft_pr_publishing: bool,
}

impl Default for AutonomyPolicyDto {
    fn default() -> Self {
        core_flight::AutonomyPolicy::default().into()
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct AutonomyActionRecordDto {
    pub id: String,
    pub kind: AutonomyActionKindDto,
    #[serde(default)]
    #[ts(optional)]
    pub subject_id: Option<String>,
    pub status: AutonomyActionStatusDto,
    pub reason: String,
    #[ts(type = "number")]
    pub timestamp: u64,
    pub cost: f64,
    #[serde(default)]
    #[ts(optional)]
    #[ts(type = "Record<string, string | number | boolean | null>")]
    pub metadata: Option<serde_json::Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct AutonomyRuntimeDto {
    pub status: AutonomyRunStatusDto,
    #[serde(default)]
    #[ts(optional)]
    #[ts(type = "number")]
    pub started_at: Option<u64>,
    #[serde(default)]
    #[ts(optional)]
    #[ts(type = "number")]
    pub paused_at: Option<u64>,
    #[serde(default)]
    #[ts(optional)]
    #[ts(type = "number")]
    pub stopped_at: Option<u64>,
    #[serde(default)]
    #[ts(optional)]
    pub hard_stop_reason: Option<String>,
    #[serde(default)]
    pub action_history: Vec<AutonomyActionRecordDto>,
    #[serde(default)]
    #[ts(optional)]
    pub review_retry_counts: Option<std::collections::HashMap<String, u32>>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
pub enum CoordinationMessageKindDto {
    Instruction,
    Question,
    Answer,
    Blocker,
    Finding,
    Handoff,
    Artifact,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
pub enum CoordinationDeliveryStatusDto {
    Queued,
    Delivered,
    Acknowledged,
    Failed,
    Archived,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct CoordinationMessagePartyDto {
    pub kind: String,
    #[serde(default)]
    #[ts(optional)]
    pub id: Option<String>,
    pub display_name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct CoordinationMessageRecipientDto {
    pub kind: String,
    #[serde(default)]
    #[ts(optional)]
    pub id: Option<String>,
    #[serde(default)]
    #[ts(optional)]
    pub label: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct CoordinationArtifactRefDto {
    pub id: String,
    pub label: String,
    #[serde(default)]
    #[ts(optional)]
    pub uri: Option<String>,
    #[serde(default)]
    #[ts(optional)]
    pub mime_type: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct CoordinationAcknowledgementDto {
    pub by: CoordinationMessagePartyDto,
    #[ts(type = "number")]
    pub at: u64,
    #[serde(default)]
    #[ts(optional)]
    pub note: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct CoordinationMessageDto {
    #[ts(type = "1")]
    pub schema_version: u32,
    pub id: String,
    pub flight_id: String,
    pub kind: CoordinationMessageKindDto,
    pub sender: CoordinationMessagePartyDto,
    pub recipient: CoordinationMessageRecipientDto,
    pub body: String,
    #[serde(default)]
    pub artifacts: Vec<CoordinationArtifactRefDto>,
    pub status: CoordinationDeliveryStatusDto,
    #[ts(type = "number")]
    pub created_at: u64,
    #[serde(default)]
    #[ts(optional)]
    #[ts(type = "number")]
    pub delivered_at: Option<u64>,
    #[serde(default)]
    pub acknowledgements: Vec<CoordinationAcknowledgementDto>,
    #[serde(default)]
    #[ts(optional)]
    pub reply_to_id: Option<String>,
    pub dedupe_key: String,
    #[serde(default)]
    pub hop_count: u32,
    #[serde(default)]
    #[ts(optional)]
    pub error_message: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct AttemptRecoveryDto {
    #[ts(type = "'retained' | 'discarded'")]
    pub state: String,
    pub reason: String,
    #[ts(type = "number")]
    pub retained_at: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct FlightDeliveryDto {
    #[ts(type = "'landed' | 'pull_request'")]
    pub kind: String,
    #[ts(type = "number")]
    pub delivered_at: u64,
    pub branch: String,
    pub base_branch: String,
    #[serde(default)]
    #[ts(optional)]
    pub commit_sha: Option<String>,
    #[serde(default)]
    #[ts(optional)]
    pub pr_number: Option<u32>,
    #[serde(default)]
    #[ts(optional)]
    pub pr_url: Option<String>,
    #[serde(default)]
    #[ts(optional)]
    pub attempt_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct FlightExecutionTargetDto {
    #[ts(type = "'local' | 'ssh'")]
    pub kind: String,
    #[serde(default)]
    #[ts(optional)]
    pub server_id: Option<String>,
    pub base_path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct AttemptDto {
    pub id: String,
    pub flight_id: String,
    pub target: AttemptTargetDto,
    pub agent_config_id: String,
    pub model: String,
    pub provider: String,
    pub branch: String,
    pub base_branch: String,
    pub session_id: String,
    pub status: AttemptStatusDto,
    #[serde(default)]
    #[ts(optional)]
    pub session_history: Option<Vec<ReviewerSessionDto>>,
    #[serde(default)]
    #[ts(optional)]
    #[ts(type = "number")]
    pub started_at: Option<u64>,
    #[serde(default)]
    #[ts(optional)]
    #[ts(type = "number")]
    pub completed_at: Option<u64>,
    #[serde(default)]
    pub cost: f64,
    #[serde(default)]
    #[ts(type = "number")]
    pub tokens: u64,
    #[serde(default)]
    #[ts(optional)]
    pub error_message: Option<String>,
    /// E1: structured failure category (stable snake_case label) derived when
    /// the attempt failed; `None` otherwise.
    #[serde(default)]
    #[ts(optional)]
    pub failure_category: Option<String>,
    /// RG1: independent reviewer lifecycle and verdict.
    #[serde(default)]
    #[ts(optional)]
    pub review_gate: Option<AttemptReviewGateDto>,
    #[serde(default)]
    #[ts(optional)]
    pub recovery: Option<AttemptRecoveryDto>,
    #[serde(default)]
    #[ts(optional)]
    pub delivery: Option<FlightDeliveryDto>,
    /// Cooperative graph task that owns this attempt.
    #[serde(default)]
    #[ts(optional)]
    pub task_id: Option<String>,
    /// v0.8-G: when the parent Flight publishes attempts as draft PRs, the
    /// resulting PR number is round-tripped here. Optional everywhere
    /// because most attempts will not have a draft PR.
    #[serde(default)]
    #[ts(optional)]
    #[ts(type = "number")]
    pub draft_pr_number: Option<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct FlightDto {
    pub id: String,
    pub title: String,
    pub objective: String,
    pub status: FlightStatusDto,
    pub priority: FlightPriorityDto,
    pub project_path: String,
    #[serde(default)]
    #[ts(optional)]
    pub workspace_id: Option<String>,
    #[ts(optional)]
    pub git_branch: Option<String>,
    pub milestones: Vec<MilestoneDto>,
    pub linked_session_ids: Vec<String>,
    #[serde(default)]
    pub issue_ids: Vec<String>,
    #[ts(type = "number")]
    pub created_at: u64,
    #[ts(type = "number")]
    pub updated_at: u64,
    #[ts(optional)]
    #[ts(type = "number")]
    pub completed_at: Option<u64>,
    #[serde(default)]
    #[ts(optional)]
    pub delivery: Option<FlightDeliveryDto>,
    #[serde(default)]
    #[ts(optional)]
    #[ts(type = "number")]
    pub archived_at: Option<u64>,
    #[serde(default)]
    #[ts(optional)]
    #[ts(type = "number")]
    pub stopped_at: Option<u64>,
    pub total_cost: f64,
    #[ts(type = "number")]
    pub total_tokens: u64,
    #[serde(default)]
    #[ts(optional)]
    pub prompt: Option<String>,
    #[serde(default)]
    pub attempts: Vec<AttemptDto>,
    /// RG1: opt-in reviewer policy. Absent means disabled.
    #[serde(default)]
    #[ts(optional)]
    pub review_gate_policy: Option<ReviewGatePolicyDto>,
    /// Cooperative execution is opt-in; absent means independent.
    #[serde(default)]
    #[ts(optional)]
    pub execution_mode: Option<FlightExecutionModeDto>,
    #[serde(default)]
    #[ts(optional)]
    pub execution_target: Option<FlightExecutionTargetDto>,
    #[serde(default)]
    #[ts(optional)]
    pub integration_branch: Option<FlightIntegrationBranchDto>,
    #[serde(default)]
    pub coordination_inbox: Vec<CoordinationMessageDto>,
    #[serde(default)]
    #[ts(optional)]
    pub autonomy_mode: Option<AutonomyFlightModeDto>,
    #[serde(default)]
    #[ts(optional)]
    pub autonomy_policy: Option<AutonomyPolicyDto>,
    #[serde(default)]
    #[ts(optional)]
    pub autonomy_runtime: Option<AutonomyRuntimeDto>,
    /// Normal API-agent conversation used to refine the current upfront plan.
    #[serde(default)]
    #[ts(optional)]
    pub planning_conversation_id: Option<String>,
    /// Legacy autonomous-Planner session id; read-compatible only.
    #[serde(default)]
    #[ts(optional)]
    pub planner_session_id: Option<String>,
    /// Legacy autonomous-Planner status; read-compatible only.
    #[serde(default)]
    #[ts(optional)]
    pub planner_status: Option<PlannerStatusDto>,
    /// Legacy autonomous-Planner cost; read-compatible only.
    #[serde(default)]
    #[ts(optional)]
    pub planner_cost: Option<f64>,
    /// Legacy autonomous-Planner token count; read-compatible only.
    #[serde(default)]
    #[ts(optional)]
    #[ts(type = "number")]
    pub planner_tokens: Option<u64>,
    /// Legacy autonomous-Planner provider id; read-compatible only.
    #[serde(default)]
    #[ts(optional)]
    pub planner_provider: Option<String>,
    /// v0.8-G: when true on an async-mode Flight, the executor pipeline
    /// pushes each attempt's branch and opens a draft PR after the attempt
    /// reaches a terminal state. Persisted so the toggle round-trips.
    #[serde(default)]
    pub publish_attempts_as_prs: bool,
    /// N3: append-only coordination timeline. Frontend-owned schema (opaque
    /// here) — round-trips so handoff/escalation events survive reload.
    #[serde(default)]
    #[ts(type = "any[]")]
    pub coordination_log: Vec<serde_json::Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ServerConfigDto {
    pub id: String,
    pub name: String,
    pub host: String,
    pub port: u16,
    pub username: String,
    pub auth_method: String,
    #[serde(default)]
    pub key_path: Option<String>,
    #[serde(default)]
    pub remote_path: Option<String>,
    #[serde(default)]
    pub last_connected_at: Option<u64>,
    #[serde(default)]
    pub installed_agents: Vec<String>,
    #[serde(default)]
    pub host_fingerprint: Option<String>,
}

impl From<core_storage::ServerConfig> for ServerConfigDto {
    fn from(s: core_storage::ServerConfig) -> Self {
        Self {
            id: s.id,
            name: s.name,
            host: s.host,
            port: s.port,
            username: s.username,
            auth_method: s.auth_method,
            key_path: s.key_path,
            remote_path: s.remote_path,
            last_connected_at: s.last_connected_at,
            installed_agents: s.installed_agents,
            host_fingerprint: s.host_fingerprint,
        }
    }
}

impl From<ServerConfigDto> for core_storage::ServerConfig {
    fn from(s: ServerConfigDto) -> Self {
        Self {
            id: s.id,
            name: s.name,
            host: s.host,
            port: s.port,
            username: s.username,
            auth_method: s.auth_method,
            key_path: s.key_path,
            remote_path: s.remote_path,
            last_connected_at: s.last_connected_at,
            installed_agents: s.installed_agents,
            host_fingerprint: s.host_fingerprint,
        }
    }
}

/// A named CLI login. See `core::storage::CliAccount` — the record holds no
/// secrets, only the config directory the CLI is pointed at.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct CliAccountDto {
    pub id: String,
    pub label: String,
    /// "claude-code" | "codex"
    pub cli: String,
    pub config_dir: String,
    #[serde(default)]
    pub email: Option<String>,
    /// Millisecond epoch. Typed as `number` (not ts-rs' default `bigint`)
    /// because these are `Date.now()` values, which are exactly
    /// representable as f64 and are far friendlier to the store code.
    #[ts(type = "number")]
    pub created_at: u64,
    #[serde(default)]
    #[ts(type = "number | null")]
    pub last_used_at: Option<u64>,
}

impl From<core_storage::CliAccount> for CliAccountDto {
    fn from(a: core_storage::CliAccount) -> Self {
        Self {
            id: a.id,
            label: a.label,
            cli: a.cli,
            config_dir: a.config_dir,
            email: a.email,
            created_at: a.created_at,
            last_used_at: a.last_used_at,
        }
    }
}

impl From<CliAccountDto> for core_storage::CliAccount {
    fn from(a: CliAccountDto) -> Self {
        Self {
            id: a.id,
            label: a.label,
            cli: a.cli,
            config_dir: a.config_dir,
            email: a.email,
            created_at: a.created_at,
            last_used_at: a.last_used_at,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct PersistedStateDto {
    pub version: u32,
    pub flights: Vec<FlightDto>,
    pub agents: Vec<AgentConfigDto>,
    #[serde(default)]
    #[ts(type = "any[]")]
    pub issues: Vec<core_flight::Issue>,
    pub settings: OrchestratorSettingsDto,
    pub ui: PersistedUiStateDto,
    #[serde(default)]
    pub workspaces: Vec<WorkspaceDto>,
    #[serde(default)]
    #[ts(type = "any[]")]
    pub memory_events: Vec<serde_json::Value>,
    #[serde(default)]
    #[ts(type = "any[]")]
    pub memory_patterns: Vec<serde_json::Value>,
    #[serde(default)]
    pub servers: Vec<ServerConfigDto>,
    #[serde(default)]
    pub cli_accounts: Vec<CliAccountDto>,
    /// `project path -> cli -> account id`. See
    /// `core::storage::PersistedState::cli_account_defaults`.
    #[serde(default)]
    pub cli_account_defaults: BTreeMap<String, BTreeMap<String, String>>,
}

impl From<core_workspace::GridPosition> for GridPositionDto {
    fn from(value: core_workspace::GridPosition) -> Self {
        Self {
            row: value.row,
            col: value.col,
        }
    }
}

impl From<GridPositionDto> for core_workspace::GridPosition {
    fn from(value: GridPositionDto) -> Self {
        Self {
            row: value.row,
            col: value.col,
        }
    }
}

impl From<String> for WorkspaceAgentSlotDto {
    fn from(value: String) -> Self {
        match value.as_str() {
            "terminal" => Self::Terminal,
            "claude-code" => Self::ClaudeCode,
            "codex" => Self::Codex,
            "opencode" => Self::Opencode,
            "packetcode" => Self::Packetcode,
            // Unknown or retired slots (e.g. the removed "gemini" CLI) degrade
            // to a plain terminal pane so persisted workspaces keep loading.
            _ => Self::Terminal,
        }
    }
}

impl From<WorkspaceAgentSlotDto> for String {
    fn from(value: WorkspaceAgentSlotDto) -> Self {
        match value {
            WorkspaceAgentSlotDto::Terminal => "terminal".to_string(),
            WorkspaceAgentSlotDto::ClaudeCode => "claude-code".to_string(),
            WorkspaceAgentSlotDto::Codex => "codex".to_string(),
            WorkspaceAgentSlotDto::Opencode => "opencode".to_string(),
            WorkspaceAgentSlotDto::Packetcode => "packetcode".to_string(),
        }
    }
}

impl From<String> for WorkspaceStatusDto {
    fn from(value: String) -> Self {
        match value.as_str() {
            "archived" => Self::Archived,
            _ => Self::Active,
        }
    }
}

impl From<WorkspaceStatusDto> for String {
    fn from(value: WorkspaceStatusDto) -> Self {
        match value {
            WorkspaceStatusDto::Active => "active".to_string(),
            WorkspaceStatusDto::Archived => "archived".to_string(),
        }
    }
}

impl From<core_workspace::WorkspacePane> for WorkspacePaneDto {
    fn from(value: core_workspace::WorkspacePane) -> Self {
        Self {
            id: value.id,
            agent_id: value.agent_id.into(),
            session_id: value.session_id,
            grid_position: value.grid_position.into(),
            accent_color: value.accent_color,
            pinned_commands: value.pinned_commands,
            task_id: value.task_id,
            flight_id: value.flight_id,
            agent_config_id: value.agent_config_id,
            initial_prompt: value.initial_prompt,
            override_command: value.override_command,
            override_args: value.override_args,
            kind: value.kind,
            conversation_id: value.conversation_id,
            account_id: value.account_id,
            terminal_shell: value.terminal_shell.map(Into::into),
            file_path: value.file_path,
            file_view: value.file_view,
        }
    }
}

impl From<WorkspacePaneDto> for core_workspace::WorkspacePane {
    fn from(value: WorkspacePaneDto) -> Self {
        Self {
            id: value.id,
            agent_id: value.agent_id.into(),
            session_id: value.session_id,
            grid_position: value.grid_position.into(),
            accent_color: value.accent_color,
            pinned_commands: value.pinned_commands,
            task_id: value.task_id,
            flight_id: value.flight_id,
            agent_config_id: value.agent_config_id,
            initial_prompt: value.initial_prompt,
            override_command: value.override_command,
            override_args: value.override_args,
            kind: value.kind,
            conversation_id: value.conversation_id,
            account_id: value.account_id,
            terminal_shell: value.terminal_shell.map(Into::into),
            file_path: value.file_path,
            file_view: value.file_view,
        }
    }
}

impl From<core_workspace::ExecutionTargetRef> for ExecutionTargetRefDto {
    fn from(value: core_workspace::ExecutionTargetRef) -> Self {
        match value {
            core_workspace::ExecutionTargetRef::Local => Self::Local,
            core_workspace::ExecutionTargetRef::Ssh { server_id } => Self::Ssh { server_id },
        }
    }
}

impl From<ExecutionTargetRefDto> for core_workspace::ExecutionTargetRef {
    fn from(value: ExecutionTargetRefDto) -> Self {
        match value {
            ExecutionTargetRefDto::Local => Self::Local,
            ExecutionTargetRefDto::Ssh { server_id } => Self::Ssh { server_id },
        }
    }
}

impl From<core_workspace::TerminalShellSelection> for TerminalShellSelectionDto {
    fn from(value: core_workspace::TerminalShellSelection) -> Self {
        Self {
            profile: value.profile,
            executable: value.executable,
            args: value.args,
            wsl_distro: value.wsl_distro,
        }
    }
}

impl From<TerminalShellSelectionDto> for core_workspace::TerminalShellSelection {
    fn from(value: TerminalShellSelectionDto) -> Self {
        Self {
            profile: value.profile,
            executable: value.executable,
            args: value.args,
            wsl_distro: value.wsl_distro,
        }
    }
}

impl From<core_workspace::GithubRepo> for GithubRepoDto {
    fn from(value: core_workspace::GithubRepo) -> Self {
        Self {
            owner: value.owner,
            repo: value.repo,
        }
    }
}

impl From<GithubRepoDto> for core_workspace::GithubRepo {
    fn from(value: GithubRepoDto) -> Self {
        Self {
            owner: value.owner,
            repo: value.repo,
        }
    }
}

impl From<core_workspace::Workspace> for WorkspaceDto {
    fn from(value: core_workspace::Workspace) -> Self {
        Self {
            id: value.id,
            name: value.name,
            agents: value.agents.into_iter().map(Into::into).collect(),
            panes: value.panes.into_iter().map(Into::into).collect(),
            project_path: value.project_path,
            prompt: value.prompt,
            created_at: value.created_at,
            updated_at: value.updated_at,
            status: value.status.into(),
            bypass_permissions: value.bypass_permissions,
            model_overrides: value.model_overrides,
            effort_overrides: value.effort_overrides,
            server_id: value.server_id,
            remote_project_path: value.remote_project_path,
            github_repo: value.github_repo.map(Into::into),
            origin: value.origin,
            terminal_shell: value.terminal_shell.map(Into::into),
            layout: value.layout,
            execution_target: value.execution_target.map(Into::into),
        }
    }
}

impl From<WorkspaceDto> for core_workspace::Workspace {
    fn from(value: WorkspaceDto) -> Self {
        Self {
            id: value.id,
            name: value.name,
            agents: value.agents.into_iter().map(Into::into).collect(),
            panes: value.panes.into_iter().map(Into::into).collect(),
            project_path: value.project_path,
            prompt: value.prompt,
            created_at: value.created_at,
            updated_at: value.updated_at,
            status: value.status.into(),
            bypass_permissions: value.bypass_permissions,
            model_overrides: value.model_overrides,
            effort_overrides: value.effort_overrides,
            server_id: value.server_id,
            remote_project_path: value.remote_project_path,
            github_repo: value.github_repo.map(Into::into),
            origin: value.origin,
            terminal_shell: value.terminal_shell.map(Into::into),
            layout: value.layout,
            execution_target: value.execution_target.map(Into::into),
        }
    }
}

impl From<core_storage::PersistedUiState> for PersistedUiStateDto {
    fn from(value: core_storage::PersistedUiState) -> Self {
        Self {
            selected_flight_id: value.selected_flight_id,
            selected_view: value.selected_view,
            theme: value.theme.and_then(|theme| match theme.as_str() {
                "dark" => Some(ThemeDto::Dark),
                "light" => Some(ThemeDto::Light),
                _ => None,
            }),
            time_zone: value.time_zone,
        }
    }
}

impl From<PersistedUiStateDto> for core_storage::PersistedUiState {
    fn from(value: PersistedUiStateDto) -> Self {
        Self {
            selected_flight_id: value.selected_flight_id,
            selected_view: value.selected_view,
            theme: value.theme.map(|theme| match theme {
                ThemeDto::Dark => "dark".to_string(),
                ThemeDto::Light => "light".to_string(),
            }),
            time_zone: value.time_zone,
        }
    }
}

impl From<core_orchestrator::OrchestratorSettings> for OrchestratorSettingsDto {
    fn from(value: core_orchestrator::OrchestratorSettings) -> Self {
        Self {
            max_parallel_sessions: value.max_parallel_sessions,
            milestone_gating: value.milestone_gating,
            project_path: value.project_path,
            auto_commit_trailer_enabled: value.auto_commit_trailer_enabled,
            auto_commit_trailer_format: value.auto_commit_trailer_format,
            autonomy_default_mode: Some(value.autonomy_default_mode.into()),
            autonomy_default_policy: Some(value.autonomy_default_policy.into()),
        }
    }
}

impl From<OrchestratorSettingsDto> for core_orchestrator::OrchestratorSettings {
    fn from(value: OrchestratorSettingsDto) -> Self {
        Self {
            max_parallel_sessions: value.max_parallel_sessions,
            milestone_gating: value.milestone_gating,
            project_path: value.project_path,
            auto_commit_trailer_enabled: value.auto_commit_trailer_enabled,
            auto_commit_trailer_format: value.auto_commit_trailer_format,
            autonomy_default_mode: value
                .autonomy_default_mode
                .unwrap_or(AutonomyDefaultModeDto::Assisted)
                .into(),
            autonomy_default_policy: value.autonomy_default_policy.unwrap_or_default().into(),
        }
    }
}

impl From<core_agent::AgentCapability> for AgentCapabilityDto {
    fn from(value: core_agent::AgentCapability) -> Self {
        match value {
            core_agent::AgentCapability::CodeEdit => Self::CodeEdit,
            core_agent::AgentCapability::CodeReview => Self::CodeReview,
            core_agent::AgentCapability::Testing => Self::Testing,
            core_agent::AgentCapability::Research => Self::Research,
            core_agent::AgentCapability::Shell => Self::Shell,
            core_agent::AgentCapability::Refactor => Self::Refactor,
        }
    }
}

impl From<AgentCapabilityDto> for core_agent::AgentCapability {
    fn from(value: AgentCapabilityDto) -> Self {
        match value {
            AgentCapabilityDto::CodeEdit => Self::CodeEdit,
            AgentCapabilityDto::CodeReview => Self::CodeReview,
            AgentCapabilityDto::Testing => Self::Testing,
            AgentCapabilityDto::Research => Self::Research,
            AgentCapabilityDto::Shell => Self::Shell,
            AgentCapabilityDto::Refactor => Self::Refactor,
        }
    }
}

impl From<core_agent::ToolUsePattern> for ToolUsePatternDto {
    fn from(value: core_agent::ToolUsePattern) -> Self {
        Self {
            pattern: value.pattern,
            tool: value.tool,
            file_group: value.file_group,
        }
    }
}

impl From<ToolUsePatternDto> for core_agent::ToolUsePattern {
    fn from(value: ToolUsePatternDto) -> Self {
        Self {
            pattern: value.pattern,
            tool: value.tool,
            file_group: value.file_group,
        }
    }
}

impl From<core_agent::AgentStatusPatterns> for AgentStatusPatternsDto {
    fn from(value: core_agent::AgentStatusPatterns) -> Self {
        Self {
            approval: value.approval,
            thinking: value.thinking,
            tool_use: value.tool_use.into_iter().map(Into::into).collect(),
            idle: value.idle,
        }
    }
}

impl From<AgentStatusPatternsDto> for core_agent::AgentStatusPatterns {
    fn from(value: AgentStatusPatternsDto) -> Self {
        Self {
            approval: value.approval,
            thinking: value.thinking,
            tool_use: value.tool_use.into_iter().map(Into::into).collect(),
            idle: value.idle,
        }
    }
}

impl From<core_agent::AgentApprovalActions> for AgentApprovalActionsDto {
    fn from(value: core_agent::AgentApprovalActions) -> Self {
        Self {
            approve: value.approve,
            deny: value.deny,
            abort: value.abort,
        }
    }
}

impl From<AgentApprovalActionsDto> for core_agent::AgentApprovalActions {
    fn from(value: AgentApprovalActionsDto) -> Self {
        Self {
            approve: value.approve,
            deny: value.deny,
            abort: value.abort,
        }
    }
}

impl From<core_agent::AgentConfig> for AgentConfigDto {
    fn from(value: core_agent::AgentConfig) -> Self {
        Self {
            id: value.id,
            name: value.name,
            command: value.command,
            default_args: value.default_args,
            description: value.description,
            installed: value.installed,
            capabilities: value.capabilities.into_iter().map(Into::into).collect(),
            icon: value.icon,
            color: value.color,
            status_patterns: value.status_patterns.into(),
            approval_actions: value.approval_actions.into(),
            is_builtin: value.is_builtin,
        }
    }
}

impl From<AgentConfigDto> for core_agent::AgentConfig {
    fn from(value: AgentConfigDto) -> Self {
        Self {
            id: value.id,
            name: value.name,
            command: value.command,
            default_args: value.default_args,
            description: value.description,
            installed: value.installed,
            capabilities: value.capabilities.into_iter().map(Into::into).collect(),
            icon: value.icon,
            color: value.color,
            status_patterns: value.status_patterns.into(),
            approval_actions: value.approval_actions.into(),
            is_builtin: value.is_builtin,
        }
    }
}

macro_rules! impl_enum_conversion {
    ($dto:ty, $core:ty, { $($core_variant:path => $dto_variant:path),+ $(,)? }) => {
        impl From<$core> for $dto {
            fn from(value: $core) -> Self {
                match value {
                    $($core_variant => $dto_variant,)+
                }
            }
        }

        impl From<$dto> for $core {
            fn from(value: $dto) -> Self {
                match value {
                    $($dto_variant => $core_variant,)+
                }
            }
        }
    };
}

impl_enum_conversion!(FlightStatusDto, core_flight::FlightStatus, {
    core_flight::FlightStatus::Draft => FlightStatusDto::Draft,
    core_flight::FlightStatus::Spec => FlightStatusDto::Spec,
    core_flight::FlightStatus::Planning => FlightStatusDto::Planning,
    core_flight::FlightStatus::Ready => FlightStatusDto::Ready,
    core_flight::FlightStatus::Active => FlightStatusDto::Active,
    core_flight::FlightStatus::Paused => FlightStatusDto::Paused,
    core_flight::FlightStatus::Review => FlightStatusDto::Review,
    core_flight::FlightStatus::Done => FlightStatusDto::Done,
    core_flight::FlightStatus::Failed => FlightStatusDto::Failed,
    core_flight::FlightStatus::Cancelled => FlightStatusDto::Cancelled
});

impl_enum_conversion!(PlannerStatusDto, core_flight::PlannerStatus, {
    core_flight::PlannerStatus::Idle => PlannerStatusDto::Idle,
    core_flight::PlannerStatus::Awake => PlannerStatusDto::Awake,
    core_flight::PlannerStatus::Paused => PlannerStatusDto::Paused,
    core_flight::PlannerStatus::QuotaPaused => PlannerStatusDto::QuotaPaused,
    core_flight::PlannerStatus::Completed => PlannerStatusDto::Completed,
    core_flight::PlannerStatus::Failed => PlannerStatusDto::Failed
});

impl_enum_conversion!(FlightPriorityDto, core_flight::FlightPriority, {
    core_flight::FlightPriority::Low => FlightPriorityDto::Low,
    core_flight::FlightPriority::Medium => FlightPriorityDto::Medium,
    core_flight::FlightPriority::High => FlightPriorityDto::High,
    core_flight::FlightPriority::Critical => FlightPriorityDto::Critical
});

impl_enum_conversion!(MilestoneStatusDto, core_flight::MilestoneStatus, {
    core_flight::MilestoneStatus::Pending => MilestoneStatusDto::Pending,
    core_flight::MilestoneStatus::Active => MilestoneStatusDto::Active,
    core_flight::MilestoneStatus::Done => MilestoneStatusDto::Done,
    core_flight::MilestoneStatus::Failed => MilestoneStatusDto::Failed
});

impl_enum_conversion!(TaskStatusDto, core_flight::TaskStatus, {
    core_flight::TaskStatus::Pending => TaskStatusDto::Pending,
    core_flight::TaskStatus::Blocked => TaskStatusDto::Blocked,
    core_flight::TaskStatus::Queued => TaskStatusDto::Queued,
    core_flight::TaskStatus::Running => TaskStatusDto::Running,
    core_flight::TaskStatus::ApprovalNeeded => TaskStatusDto::ApprovalNeeded,
    core_flight::TaskStatus::Paused => TaskStatusDto::Paused,
    core_flight::TaskStatus::Done => TaskStatusDto::Done,
    core_flight::TaskStatus::Failed => TaskStatusDto::Failed,
    core_flight::TaskStatus::Cancelled => TaskStatusDto::Cancelled
});

impl_enum_conversion!(TaskTypeDto, core_flight::TaskType, {
    core_flight::TaskType::Implementation => TaskTypeDto::Implementation,
    core_flight::TaskType::Testing => TaskTypeDto::Testing,
    core_flight::TaskType::Review => TaskTypeDto::Review,
    core_flight::TaskType::Validation => TaskTypeDto::Validation,
    core_flight::TaskType::Research => TaskTypeDto::Research,
    core_flight::TaskType::Refactor => TaskTypeDto::Refactor,
    core_flight::TaskType::Documentation => TaskTypeDto::Documentation
});

impl_enum_conversion!(ValidationVerdictDto, core_flight::ValidationVerdict, {
    core_flight::ValidationVerdict::Pass => ValidationVerdictDto::Pass,
    core_flight::ValidationVerdict::Fail => ValidationVerdictDto::Fail,
    core_flight::ValidationVerdict::Warn => ValidationVerdictDto::Warn
});

impl_enum_conversion!(ReviewTypeDto, core_flight::ReviewType, {
    core_flight::ReviewType::ToolCall => ReviewTypeDto::ToolCall,
    core_flight::ReviewType::FileWrite => ReviewTypeDto::FileWrite,
    core_flight::ReviewType::Command => ReviewTypeDto::Command,
    core_flight::ReviewType::MilestoneGate => ReviewTypeDto::MilestoneGate
});

impl From<core_flight::TaskHandoff> for TaskHandoffDto {
    fn from(value: core_flight::TaskHandoff) -> Self {
        Self {
            summary: value.summary,
            files_changed: value.files_changed,
            tests_needed: value.tests_needed,
            follow_ups: value.follow_ups,
        }
    }
}

impl From<TaskHandoffDto> for core_flight::TaskHandoff {
    fn from(value: TaskHandoffDto) -> Self {
        Self {
            summary: value.summary,
            files_changed: value.files_changed,
            tests_needed: value.tests_needed,
            follow_ups: value.follow_ups,
        }
    }
}

impl From<core_flight::TaskValidationAssertion> for TaskValidationAssertionDto {
    fn from(value: core_flight::TaskValidationAssertion) -> Self {
        Self {
            label: value.label,
            status: value.status.into(),
            details: value.details,
        }
    }
}

impl From<TaskValidationAssertionDto> for core_flight::TaskValidationAssertion {
    fn from(value: TaskValidationAssertionDto) -> Self {
        Self {
            label: value.label,
            status: value.status.into(),
            details: value.details,
        }
    }
}

impl From<core_flight::TaskValidationReport> for TaskValidationReportDto {
    fn from(value: core_flight::TaskValidationReport) -> Self {
        Self {
            verdict: value.verdict.into(),
            summary: value.summary,
            assertions: value.assertions.into_iter().map(Into::into).collect(),
        }
    }
}

impl From<TaskValidationReportDto> for core_flight::TaskValidationReport {
    fn from(value: TaskValidationReportDto) -> Self {
        Self {
            verdict: value.verdict.into(),
            summary: value.summary,
            assertions: value.assertions.into_iter().map(Into::into).collect(),
        }
    }
}

impl From<core_flight::TaskResult> for TaskResultDto {
    fn from(value: core_flight::TaskResult) -> Self {
        Self {
            exit_code: value.exit_code,
            summary: value.summary,
            files_changed: value.files_changed,
            errors: value.errors,
            duration: value.duration_ms,
            handoff: value.handoff.map(Into::into),
            validation: value.validation.map(Into::into),
        }
    }
}

impl From<TaskResultDto> for core_flight::TaskResult {
    fn from(value: TaskResultDto) -> Self {
        Self {
            exit_code: value.exit_code,
            summary: value.summary,
            files_changed: value.files_changed,
            errors: value.errors,
            duration_ms: value.duration,
            handoff: value.handoff.map(Into::into),
            validation: value.validation.map(Into::into),
        }
    }
}

impl From<core_flight::ReviewPacket> for ReviewPacketDto {
    fn from(value: core_flight::ReviewPacket) -> Self {
        Self {
            id: value.id,
            task_id: value.task_id,
            flight_id: value.flight_id,
            milestone_id: value.milestone_id,
            requested_at: value.requested_at,
            review_type: value.review_type.into(),
            summary: value.summary,
            diff: value.diff,
            command: value.command,
            file_paths: value.file_paths,
            agent_id: value.agent_id,
            session_id: value.session_id,
        }
    }
}

impl From<ReviewPacketDto> for core_flight::ReviewPacket {
    fn from(value: ReviewPacketDto) -> Self {
        Self {
            id: value.id,
            task_id: value.task_id,
            flight_id: value.flight_id,
            milestone_id: value.milestone_id,
            requested_at: value.requested_at,
            review_type: value.review_type.into(),
            summary: value.summary,
            diff: value.diff,
            command: value.command,
            file_paths: value.file_paths,
            agent_id: value.agent_id,
            session_id: value.session_id,
        }
    }
}

impl From<core_flight::Task> for TaskDto {
    fn from(value: core_flight::Task) -> Self {
        Self {
            id: value.id,
            milestone_id: value.milestone_id,
            flight_id: value.flight_id,
            title: value.title,
            description: value.description,
            order: value.order,
            status: value.status.into(),
            task_type: value.task_type.into(),
            agent_config_id: value.agent_config_id,
            agent_args: value.agent_args,
            model: value.model,
            depends_on: value.depends_on,
            session_id: value.session_id,
            result: value.result.map(Into::into),
            review_packet: value.review_packet.map(Into::into),
            created_at: value.created_at,
            started_at: value.started_at,
            completed_at: value.completed_at,
            cost: value.cost,
            tokens: value.tokens,
            owned_paths: if value.owned_paths.is_empty() {
                None
            } else {
                Some(value.owned_paths)
            },
            replan_count: value.replan_count,
        }
    }
}

impl From<TaskDto> for core_flight::Task {
    fn from(value: TaskDto) -> Self {
        Self {
            id: value.id,
            milestone_id: value.milestone_id,
            flight_id: value.flight_id,
            title: value.title,
            description: value.description,
            order: value.order,
            status: value.status.into(),
            task_type: value.task_type.into(),
            agent_config_id: value.agent_config_id,
            agent_args: value.agent_args,
            model: value.model,
            depends_on: value.depends_on,
            session_id: value.session_id,
            result: value.result.map(Into::into),
            review_packet: value.review_packet.map(Into::into),
            created_at: value.created_at,
            started_at: value.started_at,
            completed_at: value.completed_at,
            cost: value.cost,
            tokens: value.tokens,
            owned_paths: value.owned_paths.unwrap_or_default(),
            replan_count: value.replan_count,
        }
    }
}

impl From<core_flight::Milestone> for MilestoneDto {
    fn from(value: core_flight::Milestone) -> Self {
        Self {
            id: value.id,
            flight_id: value.flight_id,
            title: value.title,
            description: value.description,
            order: value.order,
            status: value.status.into(),
            tasks: value.tasks.into_iter().map(Into::into).collect(),
            validation_criteria: value.validation_criteria,
        }
    }
}

impl From<MilestoneDto> for core_flight::Milestone {
    fn from(value: MilestoneDto) -> Self {
        Self {
            id: value.id,
            flight_id: value.flight_id,
            title: value.title,
            description: value.description,
            order: value.order,
            status: value.status.into(),
            tasks: value.tasks.into_iter().map(Into::into).collect(),
            validation_criteria: value.validation_criteria,
        }
    }
}

impl From<core_flight::AttemptStatus> for AttemptStatusDto {
    fn from(s: core_flight::AttemptStatus) -> Self {
        match s {
            core_flight::AttemptStatus::Queued => Self::Queued,
            core_flight::AttemptStatus::Provisioning => Self::Provisioning,
            core_flight::AttemptStatus::Running => Self::Running,
            core_flight::AttemptStatus::Reviewing => Self::Reviewing,
            core_flight::AttemptStatus::Completed => Self::Completed,
            core_flight::AttemptStatus::Failed => Self::Failed,
            core_flight::AttemptStatus::Cancelled => Self::Cancelled,
        }
    }
}

impl From<AttemptStatusDto> for core_flight::AttemptStatus {
    fn from(s: AttemptStatusDto) -> Self {
        match s {
            AttemptStatusDto::Queued => Self::Queued,
            AttemptStatusDto::Provisioning => Self::Provisioning,
            AttemptStatusDto::Running => Self::Running,
            AttemptStatusDto::Reviewing => Self::Reviewing,
            AttemptStatusDto::Completed => Self::Completed,
            AttemptStatusDto::Failed => Self::Failed,
            AttemptStatusDto::Cancelled => Self::Cancelled,
        }
    }
}

impl From<core_flight::AttemptTarget> for AttemptTargetDto {
    fn from(t: core_flight::AttemptTarget) -> Self {
        match t {
            core_flight::AttemptTarget::Local {
                base_path,
                worktree_path,
            } => Self::Local {
                base_path,
                worktree_path,
            },
            core_flight::AttemptTarget::Ssh {
                server_id,
                base_path,
                worktree_path,
            } => Self::Ssh {
                server_id,
                base_path,
                worktree_path,
            },
        }
    }
}

impl From<AttemptTargetDto> for core_flight::AttemptTarget {
    fn from(t: AttemptTargetDto) -> Self {
        match t {
            AttemptTargetDto::Local {
                base_path,
                worktree_path,
            } => Self::Local {
                base_path,
                worktree_path,
            },
            AttemptTargetDto::Ssh {
                server_id,
                base_path,
                worktree_path,
            } => Self::Ssh {
                server_id,
                base_path,
                worktree_path,
            },
        }
    }
}

impl From<core_flight::ReviewGateVerdict> for ReviewGateVerdictDto {
    fn from(value: core_flight::ReviewGateVerdict) -> Self {
        match value {
            core_flight::ReviewGateVerdict::Pass => Self::Pass,
            core_flight::ReviewGateVerdict::ChangesRequested => Self::ChangesRequested,
            core_flight::ReviewGateVerdict::Blocked => Self::Blocked,
        }
    }
}

impl From<ReviewGateVerdictDto> for core_flight::ReviewGateVerdict {
    fn from(value: ReviewGateVerdictDto) -> Self {
        match value {
            ReviewGateVerdictDto::Pass => Self::Pass,
            ReviewGateVerdictDto::ChangesRequested => Self::ChangesRequested,
            ReviewGateVerdictDto::Blocked => Self::Blocked,
        }
    }
}

impl From<core_flight::ReviewGateStatus> for ReviewGateStatusDto {
    fn from(value: core_flight::ReviewGateStatus) -> Self {
        match value {
            core_flight::ReviewGateStatus::Pending => Self::Pending,
            core_flight::ReviewGateStatus::Running => Self::Running,
            core_flight::ReviewGateStatus::Passed => Self::Passed,
            core_flight::ReviewGateStatus::ChangesRequested => Self::ChangesRequested,
            core_flight::ReviewGateStatus::Blocked => Self::Blocked,
            core_flight::ReviewGateStatus::Error => Self::Error,
            core_flight::ReviewGateStatus::Overridden => Self::Overridden,
        }
    }
}

impl From<ReviewGateStatusDto> for core_flight::ReviewGateStatus {
    fn from(value: ReviewGateStatusDto) -> Self {
        match value {
            ReviewGateStatusDto::Pending => Self::Pending,
            ReviewGateStatusDto::Running => Self::Running,
            ReviewGateStatusDto::Passed => Self::Passed,
            ReviewGateStatusDto::ChangesRequested => Self::ChangesRequested,
            ReviewGateStatusDto::Blocked => Self::Blocked,
            ReviewGateStatusDto::Error => Self::Error,
            ReviewGateStatusDto::Overridden => Self::Overridden,
        }
    }
}

impl From<core_flight::ReviewGateFindingSeverity> for ReviewGateFindingSeverityDto {
    fn from(value: core_flight::ReviewGateFindingSeverity) -> Self {
        match value {
            core_flight::ReviewGateFindingSeverity::Info => Self::Info,
            core_flight::ReviewGateFindingSeverity::Warning => Self::Warning,
            core_flight::ReviewGateFindingSeverity::Error => Self::Error,
        }
    }
}

impl From<ReviewGateFindingSeverityDto> for core_flight::ReviewGateFindingSeverity {
    fn from(value: ReviewGateFindingSeverityDto) -> Self {
        match value {
            ReviewGateFindingSeverityDto::Info => Self::Info,
            ReviewGateFindingSeverityDto::Warning => Self::Warning,
            ReviewGateFindingSeverityDto::Error => Self::Error,
        }
    }
}

impl From<core_flight::ReviewGateFinding> for ReviewGateFindingDto {
    fn from(value: core_flight::ReviewGateFinding) -> Self {
        Self {
            severity: value.severity.into(),
            title: value.title,
            details: value.details,
            file_path: value.file_path,
            line: value.line,
        }
    }
}

impl From<ReviewGateFindingDto> for core_flight::ReviewGateFinding {
    fn from(value: ReviewGateFindingDto) -> Self {
        Self {
            severity: value.severity.into(),
            title: value.title,
            details: value.details,
            file_path: value.file_path,
            line: value.line,
        }
    }
}

impl From<core_flight::ReviewGateReport> for ReviewGateReportDto {
    fn from(value: core_flight::ReviewGateReport) -> Self {
        Self {
            schema_version: value.schema_version,
            verdict: value.verdict.into(),
            summary: value.summary,
            findings: value.findings.into_iter().map(Into::into).collect(),
            evidence: value.evidence,
        }
    }
}

impl From<ReviewGateReportDto> for core_flight::ReviewGateReport {
    fn from(value: ReviewGateReportDto) -> Self {
        Self {
            schema_version: value.schema_version,
            verdict: value.verdict.into(),
            summary: value.summary,
            findings: value.findings.into_iter().map(Into::into).collect(),
            evidence: value.evidence,
        }
    }
}

impl From<core_flight::ReviewGatePolicy> for ReviewGatePolicyDto {
    fn from(value: core_flight::ReviewGatePolicy) -> Self {
        Self {
            enabled: value.enabled,
            reviewer_agent_config_id: value.reviewer_agent_config_id,
            reviewer_model: value.reviewer_model,
            acceptance_criteria: value.acceptance_criteria,
        }
    }
}

impl From<ReviewGatePolicyDto> for core_flight::ReviewGatePolicy {
    fn from(value: ReviewGatePolicyDto) -> Self {
        Self {
            enabled: value.enabled,
            reviewer_agent_config_id: value.reviewer_agent_config_id,
            reviewer_model: value.reviewer_model,
            acceptance_criteria: value.acceptance_criteria,
        }
    }
}

impl From<core_flight::ReviewGateEvidence> for ReviewGateEvidenceDto {
    fn from(value: core_flight::ReviewGateEvidence) -> Self {
        Self {
            fingerprint: value.fingerprint,
            context_fingerprint: value.context_fingerprint,
            context_json: value.context_json,
            base_sha: value.base_sha,
            head_sha: value.head_sha,
        }
    }
}

impl From<ReviewGateEvidenceDto> for core_flight::ReviewGateEvidence {
    fn from(value: ReviewGateEvidenceDto) -> Self {
        Self {
            fingerprint: value.fingerprint,
            context_fingerprint: value.context_fingerprint,
            context_json: value.context_json,
            base_sha: value.base_sha,
            head_sha: value.head_sha,
        }
    }
}

impl From<core_flight::ReviewerSession> for ReviewerSessionDto {
    fn from(value: core_flight::ReviewerSession) -> Self {
        Self {
            session_id: value.session_id,
            provider: value.provider,
            model: value.model,
        }
    }
}

impl From<ReviewerSessionDto> for core_flight::ReviewerSession {
    fn from(value: ReviewerSessionDto) -> Self {
        Self {
            session_id: value.session_id,
            provider: value.provider,
            model: value.model,
        }
    }
}

impl From<core_flight::AttemptReviewGate> for AttemptReviewGateDto {
    fn from(value: core_flight::AttemptReviewGate) -> Self {
        Self {
            status: value.status.into(),
            reviewer_conversation_id: value.reviewer_conversation_id,
            reviewer_agent_config_id: value.reviewer_agent_config_id,
            reviewer_model: value.reviewer_model,
            evidence: value.evidence.map(Into::into),
            reviewer_sessions: value
                .reviewer_sessions
                .into_iter()
                .map(Into::into)
                .collect(),
            report: value.report.map(Into::into),
            error_message: value.error_message,
            started_at: value.started_at,
            completed_at: value.completed_at,
            overridden_at: value.overridden_at,
            override_reason: value.override_reason,
        }
    }
}

impl From<AttemptReviewGateDto> for core_flight::AttemptReviewGate {
    fn from(value: AttemptReviewGateDto) -> Self {
        Self {
            status: value.status.into(),
            reviewer_conversation_id: value.reviewer_conversation_id,
            reviewer_agent_config_id: value.reviewer_agent_config_id,
            reviewer_model: value.reviewer_model,
            evidence: value.evidence.map(Into::into),
            reviewer_sessions: value
                .reviewer_sessions
                .into_iter()
                .map(Into::into)
                .collect(),
            report: value.report.map(Into::into),
            error_message: value.error_message,
            started_at: value.started_at,
            completed_at: value.completed_at,
            overridden_at: value.overridden_at,
            override_reason: value.override_reason,
        }
    }
}

impl From<core_flight::FlightExecutionMode> for FlightExecutionModeDto {
    fn from(value: core_flight::FlightExecutionMode) -> Self {
        match value {
            core_flight::FlightExecutionMode::Independent => Self::Independent,
            core_flight::FlightExecutionMode::Cooperative => Self::Cooperative,
        }
    }
}

impl From<FlightExecutionModeDto> for core_flight::FlightExecutionMode {
    fn from(value: FlightExecutionModeDto) -> Self {
        match value {
            FlightExecutionModeDto::Independent => Self::Independent,
            FlightExecutionModeDto::Cooperative => Self::Cooperative,
        }
    }
}

impl From<core_flight::IntegrationBranchStatus> for IntegrationBranchStatusDto {
    fn from(value: core_flight::IntegrationBranchStatus) -> Self {
        match value {
            core_flight::IntegrationBranchStatus::Uninitialized => Self::Uninitialized,
            core_flight::IntegrationBranchStatus::Ready => Self::Ready,
            core_flight::IntegrationBranchStatus::Integrating => Self::Integrating,
            core_flight::IntegrationBranchStatus::NeedsAttention => Self::NeedsAttention,
            core_flight::IntegrationBranchStatus::Landed => Self::Landed,
        }
    }
}

impl From<IntegrationBranchStatusDto> for core_flight::IntegrationBranchStatus {
    fn from(value: IntegrationBranchStatusDto) -> Self {
        match value {
            IntegrationBranchStatusDto::Uninitialized => Self::Uninitialized,
            IntegrationBranchStatusDto::Ready => Self::Ready,
            IntegrationBranchStatusDto::Integrating => Self::Integrating,
            IntegrationBranchStatusDto::NeedsAttention => Self::NeedsAttention,
            IntegrationBranchStatusDto::Landed => Self::Landed,
        }
    }
}

impl From<core_flight::FlightIntegrationBranch> for FlightIntegrationBranchDto {
    fn from(value: core_flight::FlightIntegrationBranch) -> Self {
        Self {
            branch: value.branch,
            base_branch: value.base_branch,
            base_sha: value.base_sha,
            head_sha: value.head_sha,
            worktree_path: value.worktree_path,
            target_kind: value.target_kind,
            target_id: value.target_id,
            status: value.status.into(),
            error_message: value.error_message,
            conflict_files: value.conflict_files,
        }
    }
}

impl From<FlightIntegrationBranchDto> for core_flight::FlightIntegrationBranch {
    fn from(value: FlightIntegrationBranchDto) -> Self {
        Self {
            branch: value.branch,
            base_branch: value.base_branch,
            base_sha: value.base_sha,
            head_sha: value.head_sha,
            worktree_path: value.worktree_path,
            target_kind: value.target_kind,
            target_id: value.target_id,
            status: value.status.into(),
            error_message: value.error_message,
            conflict_files: value.conflict_files,
        }
    }
}

impl From<core_flight::AutonomyFlightMode> for AutonomyFlightModeDto {
    fn from(value: core_flight::AutonomyFlightMode) -> Self {
        match value {
            core_flight::AutonomyFlightMode::Assisted => Self::Assisted,
            core_flight::AutonomyFlightMode::SettingsDefault => Self::SettingsDefault,
            core_flight::AutonomyFlightMode::Yolo => Self::Yolo,
        }
    }
}

impl From<AutonomyFlightModeDto> for core_flight::AutonomyFlightMode {
    fn from(value: AutonomyFlightModeDto) -> Self {
        match value {
            AutonomyFlightModeDto::Assisted => Self::Assisted,
            AutonomyFlightModeDto::SettingsDefault => Self::SettingsDefault,
            AutonomyFlightModeDto::Yolo => Self::Yolo,
        }
    }
}

impl From<core_flight::AutonomyDefaultMode> for AutonomyDefaultModeDto {
    fn from(value: core_flight::AutonomyDefaultMode) -> Self {
        match value {
            core_flight::AutonomyDefaultMode::Assisted => Self::Assisted,
            core_flight::AutonomyDefaultMode::Yolo => Self::Yolo,
        }
    }
}

impl From<AutonomyDefaultModeDto> for core_flight::AutonomyDefaultMode {
    fn from(value: AutonomyDefaultModeDto) -> Self {
        match value {
            AutonomyDefaultModeDto::Assisted => Self::Assisted,
            AutonomyDefaultModeDto::Yolo => Self::Yolo,
        }
    }
}

impl From<core_flight::AutonomyToolPosture> for AutonomyToolPostureDto {
    fn from(value: core_flight::AutonomyToolPosture) -> Self {
        match value {
            core_flight::AutonomyToolPosture::ApprovalGated => Self::ApprovalGated,
            core_flight::AutonomyToolPosture::AllowInProject => Self::AllowInProject,
        }
    }
}

impl From<AutonomyToolPostureDto> for core_flight::AutonomyToolPosture {
    fn from(value: AutonomyToolPostureDto) -> Self {
        match value {
            AutonomyToolPostureDto::ApprovalGated => Self::ApprovalGated,
            AutonomyToolPostureDto::AllowInProject => Self::AllowInProject,
        }
    }
}

impl From<core_flight::AutonomyRunStatus> for AutonomyRunStatusDto {
    fn from(value: core_flight::AutonomyRunStatus) -> Self {
        match value {
            core_flight::AutonomyRunStatus::Idle => Self::Idle,
            core_flight::AutonomyRunStatus::Running => Self::Running,
            core_flight::AutonomyRunStatus::Paused => Self::Paused,
            core_flight::AutonomyRunStatus::Stopped => Self::Stopped,
            core_flight::AutonomyRunStatus::NeedsAttention => Self::NeedsAttention,
            core_flight::AutonomyRunStatus::Completed => Self::Completed,
        }
    }
}

impl From<AutonomyRunStatusDto> for core_flight::AutonomyRunStatus {
    fn from(value: AutonomyRunStatusDto) -> Self {
        match value {
            AutonomyRunStatusDto::Idle => Self::Idle,
            AutonomyRunStatusDto::Running => Self::Running,
            AutonomyRunStatusDto::Paused => Self::Paused,
            AutonomyRunStatusDto::Stopped => Self::Stopped,
            AutonomyRunStatusDto::NeedsAttention => Self::NeedsAttention,
            AutonomyRunStatusDto::Completed => Self::Completed,
        }
    }
}

impl From<core_flight::AutonomyActionStatus> for AutonomyActionStatusDto {
    fn from(value: core_flight::AutonomyActionStatus) -> Self {
        match value {
            core_flight::AutonomyActionStatus::Started => Self::Started,
            core_flight::AutonomyActionStatus::Completed => Self::Completed,
            core_flight::AutonomyActionStatus::Failed => Self::Failed,
            core_flight::AutonomyActionStatus::Denied => Self::Denied,
        }
    }
}

impl From<AutonomyActionStatusDto> for core_flight::AutonomyActionStatus {
    fn from(value: AutonomyActionStatusDto) -> Self {
        match value {
            AutonomyActionStatusDto::Started => Self::Started,
            AutonomyActionStatusDto::Completed => Self::Completed,
            AutonomyActionStatusDto::Failed => Self::Failed,
            AutonomyActionStatusDto::Denied => Self::Denied,
        }
    }
}

impl From<core_flight::AutonomyActionKind> for AutonomyActionKindDto {
    fn from(value: core_flight::AutonomyActionKind) -> Self {
        match value {
            core_flight::AutonomyActionKind::Continue => Self::Continue,
            core_flight::AutonomyActionKind::RecoverAttempt => Self::RecoverAttempt,
            core_flight::AutonomyActionKind::ReviewRemediation => Self::ReviewRemediation,
            core_flight::AutonomyActionKind::RetryReview => Self::RetryReview,
            core_flight::AutonomyActionKind::AcceptReviewPass => Self::AcceptReviewPass,
            core_flight::AutonomyActionKind::LaunchReadyTask => Self::LaunchReadyTask,
            core_flight::AutonomyActionKind::IntegrateAttempt => Self::IntegrateAttempt,
            core_flight::AutonomyActionKind::SetToolPosture => Self::SetToolPosture,
        }
    }
}

impl From<AutonomyActionKindDto> for core_flight::AutonomyActionKind {
    fn from(value: AutonomyActionKindDto) -> Self {
        match value {
            AutonomyActionKindDto::Continue => Self::Continue,
            AutonomyActionKindDto::RecoverAttempt => Self::RecoverAttempt,
            AutonomyActionKindDto::ReviewRemediation => Self::ReviewRemediation,
            AutonomyActionKindDto::RetryReview => Self::RetryReview,
            AutonomyActionKindDto::AcceptReviewPass => Self::AcceptReviewPass,
            AutonomyActionKindDto::LaunchReadyTask => Self::LaunchReadyTask,
            AutonomyActionKindDto::IntegrateAttempt => Self::IntegrateAttempt,
            AutonomyActionKindDto::SetToolPosture => Self::SetToolPosture,
        }
    }
}

impl From<core_flight::AutonomyPolicy> for AutonomyPolicyDto {
    fn from(value: core_flight::AutonomyPolicy) -> Self {
        Self {
            schema_version: value.schema_version,
            auto_recovery: value.auto_recovery,
            auto_review_remediation: value.auto_review_remediation,
            auto_run_task_graph: value.auto_run_task_graph,
            tool_posture: value.tool_posture.into(),
            max_total_cost: value.max_total_cost,
            max_duration_minutes: value.max_duration_minutes,
            max_retries_per_task: value.max_retries_per_task,
            max_review_rounds: value.max_review_rounds,
            max_concurrent_agents: value.max_concurrent_agents,
            allowed_roots: value.allowed_roots,
            allowed_targets: value.allowed_targets,
            allow_draft_pr_publishing: value.allow_draft_pr_publishing,
        }
    }
}

impl From<AutonomyPolicyDto> for core_flight::AutonomyPolicy {
    fn from(value: AutonomyPolicyDto) -> Self {
        Self {
            schema_version: value.schema_version,
            auto_recovery: value.auto_recovery,
            auto_review_remediation: value.auto_review_remediation,
            auto_run_task_graph: value.auto_run_task_graph,
            tool_posture: value.tool_posture.into(),
            max_total_cost: value.max_total_cost,
            max_duration_minutes: value.max_duration_minutes,
            max_retries_per_task: value.max_retries_per_task,
            max_review_rounds: value.max_review_rounds,
            max_concurrent_agents: value.max_concurrent_agents,
            allowed_roots: value.allowed_roots,
            allowed_targets: value.allowed_targets,
            allow_draft_pr_publishing: value.allow_draft_pr_publishing,
        }
    }
}

impl From<core_flight::AutonomyActionRecord> for AutonomyActionRecordDto {
    fn from(value: core_flight::AutonomyActionRecord) -> Self {
        Self {
            id: value.id,
            kind: value.kind.into(),
            subject_id: value.subject_id,
            status: value.status.into(),
            reason: value.reason,
            timestamp: value.timestamp,
            cost: value.cost,
            metadata: value.metadata,
        }
    }
}

impl From<AutonomyActionRecordDto> for core_flight::AutonomyActionRecord {
    fn from(value: AutonomyActionRecordDto) -> Self {
        Self {
            id: value.id,
            kind: value.kind.into(),
            subject_id: value.subject_id,
            status: value.status.into(),
            reason: value.reason,
            timestamp: value.timestamp,
            cost: value.cost,
            metadata: value.metadata,
        }
    }
}

impl From<core_flight::AutonomyRuntime> for AutonomyRuntimeDto {
    fn from(value: core_flight::AutonomyRuntime) -> Self {
        Self {
            status: value.status.into(),
            started_at: value.started_at,
            paused_at: value.paused_at,
            stopped_at: value.stopped_at,
            hard_stop_reason: value.hard_stop_reason,
            action_history: value.action_history.into_iter().map(Into::into).collect(),
            review_retry_counts: value.review_retry_counts,
        }
    }
}

impl From<AutonomyRuntimeDto> for core_flight::AutonomyRuntime {
    fn from(value: AutonomyRuntimeDto) -> Self {
        Self {
            status: value.status.into(),
            started_at: value.started_at,
            paused_at: value.paused_at,
            stopped_at: value.stopped_at,
            hard_stop_reason: value.hard_stop_reason,
            action_history: value.action_history.into_iter().map(Into::into).collect(),
            review_retry_counts: value.review_retry_counts,
        }
    }
}

impl From<core_flight::CoordinationMessageKind> for CoordinationMessageKindDto {
    fn from(value: core_flight::CoordinationMessageKind) -> Self {
        match value {
            core_flight::CoordinationMessageKind::Instruction => Self::Instruction,
            core_flight::CoordinationMessageKind::Question => Self::Question,
            core_flight::CoordinationMessageKind::Answer => Self::Answer,
            core_flight::CoordinationMessageKind::Blocker => Self::Blocker,
            core_flight::CoordinationMessageKind::Finding => Self::Finding,
            core_flight::CoordinationMessageKind::Handoff => Self::Handoff,
            core_flight::CoordinationMessageKind::Artifact => Self::Artifact,
        }
    }
}

impl From<CoordinationMessageKindDto> for core_flight::CoordinationMessageKind {
    fn from(value: CoordinationMessageKindDto) -> Self {
        match value {
            CoordinationMessageKindDto::Instruction => Self::Instruction,
            CoordinationMessageKindDto::Question => Self::Question,
            CoordinationMessageKindDto::Answer => Self::Answer,
            CoordinationMessageKindDto::Blocker => Self::Blocker,
            CoordinationMessageKindDto::Finding => Self::Finding,
            CoordinationMessageKindDto::Handoff => Self::Handoff,
            CoordinationMessageKindDto::Artifact => Self::Artifact,
        }
    }
}

impl From<core_flight::CoordinationDeliveryStatus> for CoordinationDeliveryStatusDto {
    fn from(value: core_flight::CoordinationDeliveryStatus) -> Self {
        match value {
            core_flight::CoordinationDeliveryStatus::Queued => Self::Queued,
            core_flight::CoordinationDeliveryStatus::Delivered => Self::Delivered,
            core_flight::CoordinationDeliveryStatus::Acknowledged => Self::Acknowledged,
            core_flight::CoordinationDeliveryStatus::Failed => Self::Failed,
            core_flight::CoordinationDeliveryStatus::Archived => Self::Archived,
        }
    }
}

impl From<CoordinationDeliveryStatusDto> for core_flight::CoordinationDeliveryStatus {
    fn from(value: CoordinationDeliveryStatusDto) -> Self {
        match value {
            CoordinationDeliveryStatusDto::Queued => Self::Queued,
            CoordinationDeliveryStatusDto::Delivered => Self::Delivered,
            CoordinationDeliveryStatusDto::Acknowledged => Self::Acknowledged,
            CoordinationDeliveryStatusDto::Failed => Self::Failed,
            CoordinationDeliveryStatusDto::Archived => Self::Archived,
        }
    }
}

impl From<core_flight::CoordinationMessageParty> for CoordinationMessagePartyDto {
    fn from(value: core_flight::CoordinationMessageParty) -> Self {
        Self {
            kind: value.kind,
            id: value.id,
            display_name: value.display_name,
        }
    }
}

impl From<CoordinationMessagePartyDto> for core_flight::CoordinationMessageParty {
    fn from(value: CoordinationMessagePartyDto) -> Self {
        Self {
            kind: value.kind,
            id: value.id,
            display_name: value.display_name,
        }
    }
}

impl From<core_flight::CoordinationMessageRecipient> for CoordinationMessageRecipientDto {
    fn from(value: core_flight::CoordinationMessageRecipient) -> Self {
        Self {
            kind: value.kind,
            id: value.id,
            label: value.label,
        }
    }
}

impl From<CoordinationMessageRecipientDto> for core_flight::CoordinationMessageRecipient {
    fn from(value: CoordinationMessageRecipientDto) -> Self {
        Self {
            kind: value.kind,
            id: value.id,
            label: value.label,
        }
    }
}

impl From<core_flight::CoordinationArtifactRef> for CoordinationArtifactRefDto {
    fn from(value: core_flight::CoordinationArtifactRef) -> Self {
        Self {
            id: value.id,
            label: value.label,
            uri: value.uri,
            mime_type: value.mime_type,
        }
    }
}

impl From<CoordinationArtifactRefDto> for core_flight::CoordinationArtifactRef {
    fn from(value: CoordinationArtifactRefDto) -> Self {
        Self {
            id: value.id,
            label: value.label,
            uri: value.uri,
            mime_type: value.mime_type,
        }
    }
}

impl From<core_flight::CoordinationAcknowledgement> for CoordinationAcknowledgementDto {
    fn from(value: core_flight::CoordinationAcknowledgement) -> Self {
        Self {
            by: value.by.into(),
            at: value.at,
            note: value.note,
        }
    }
}

impl From<CoordinationAcknowledgementDto> for core_flight::CoordinationAcknowledgement {
    fn from(value: CoordinationAcknowledgementDto) -> Self {
        Self {
            by: value.by.into(),
            at: value.at,
            note: value.note,
        }
    }
}

impl From<core_flight::CoordinationMessage> for CoordinationMessageDto {
    fn from(value: core_flight::CoordinationMessage) -> Self {
        Self {
            schema_version: value.schema_version,
            id: value.id,
            flight_id: value.flight_id,
            kind: value.kind.into(),
            sender: value.sender.into(),
            recipient: value.recipient.into(),
            body: value.body,
            artifacts: value.artifacts.into_iter().map(Into::into).collect(),
            status: value.status.into(),
            created_at: value.created_at,
            delivered_at: value.delivered_at,
            acknowledgements: value.acknowledgements.into_iter().map(Into::into).collect(),
            reply_to_id: value.reply_to_id,
            dedupe_key: value.dedupe_key,
            hop_count: value.hop_count,
            error_message: value.error_message,
        }
    }
}

impl From<CoordinationMessageDto> for core_flight::CoordinationMessage {
    fn from(value: CoordinationMessageDto) -> Self {
        Self {
            schema_version: value.schema_version,
            id: value.id,
            flight_id: value.flight_id,
            kind: value.kind.into(),
            sender: value.sender.into(),
            recipient: value.recipient.into(),
            body: value.body,
            artifacts: value.artifacts.into_iter().map(Into::into).collect(),
            status: value.status.into(),
            created_at: value.created_at,
            delivered_at: value.delivered_at,
            acknowledgements: value.acknowledgements.into_iter().map(Into::into).collect(),
            reply_to_id: value.reply_to_id,
            dedupe_key: value.dedupe_key,
            hop_count: value.hop_count,
            error_message: value.error_message,
        }
    }
}

impl From<core_flight::AttemptRecovery> for AttemptRecoveryDto {
    fn from(value: core_flight::AttemptRecovery) -> Self {
        Self {
            state: match value.state {
                core_flight::RecoveryState::Retained => "retained",
                core_flight::RecoveryState::Discarded => "discarded",
            }
            .into(),
            reason: value.reason,
            retained_at: value.retained_at,
        }
    }
}
impl From<AttemptRecoveryDto> for core_flight::AttemptRecovery {
    fn from(value: AttemptRecoveryDto) -> Self {
        Self {
            state: if value.state == "discarded" {
                core_flight::RecoveryState::Discarded
            } else {
                core_flight::RecoveryState::Retained
            },
            reason: value.reason,
            retained_at: value.retained_at,
        }
    }
}
impl From<core_flight::FlightDelivery> for FlightDeliveryDto {
    fn from(value: core_flight::FlightDelivery) -> Self {
        Self {
            kind: match value.kind {
                core_flight::DeliveryKind::Landed => "landed",
                core_flight::DeliveryKind::PullRequest => "pull_request",
            }
            .into(),
            delivered_at: value.delivered_at,
            branch: value.branch,
            base_branch: value.base_branch,
            commit_sha: value.commit_sha,
            pr_number: value.pr_number,
            pr_url: value.pr_url,
            attempt_id: value.attempt_id,
        }
    }
}
impl From<FlightDeliveryDto> for core_flight::FlightDelivery {
    fn from(value: FlightDeliveryDto) -> Self {
        Self {
            kind: if value.kind == "pull_request" {
                core_flight::DeliveryKind::PullRequest
            } else {
                core_flight::DeliveryKind::Landed
            },
            delivered_at: value.delivered_at,
            branch: value.branch,
            base_branch: value.base_branch,
            commit_sha: value.commit_sha,
            pr_number: value.pr_number,
            pr_url: value.pr_url,
            attempt_id: value.attempt_id,
        }
    }
}

impl From<core_flight::FlightExecutionTarget> for FlightExecutionTargetDto {
    fn from(value: core_flight::FlightExecutionTarget) -> Self {
        Self {
            kind: value.kind,
            server_id: value.server_id,
            base_path: value.base_path,
        }
    }
}
impl From<FlightExecutionTargetDto> for core_flight::FlightExecutionTarget {
    fn from(value: FlightExecutionTargetDto) -> Self {
        Self {
            kind: value.kind,
            server_id: value.server_id,
            base_path: value.base_path,
        }
    }
}

impl From<core_flight::Attempt> for AttemptDto {
    fn from(a: core_flight::Attempt) -> Self {
        Self {
            id: a.id,
            flight_id: a.flight_id,
            target: a.target.into(),
            agent_config_id: a.agent_config_id,
            model: a.model,
            provider: a.provider,
            branch: a.branch,
            base_branch: a.base_branch,
            session_id: a.session_id,
            status: a.status.into(),
            started_at: a.started_at,
            completed_at: a.completed_at,
            cost: a.cost,
            tokens: a.tokens,
            error_message: a.error_message,
            failure_category: a.failure_category,
            review_gate: a.review_gate.map(Into::into),
            session_history: a
                .session_history
                .map(|sessions| sessions.into_iter().map(Into::into).collect()),
            recovery: a.recovery.map(Into::into),
            delivery: a.delivery.map(Into::into),
            task_id: a.task_id,
            draft_pr_number: a.draft_pr_number,
        }
    }
}

impl From<AttemptDto> for core_flight::Attempt {
    fn from(a: AttemptDto) -> Self {
        Self {
            id: a.id,
            flight_id: a.flight_id,
            target: a.target.into(),
            agent_config_id: a.agent_config_id,
            model: a.model,
            provider: a.provider,
            branch: a.branch,
            base_branch: a.base_branch,
            session_id: a.session_id,
            status: a.status.into(),
            started_at: a.started_at,
            completed_at: a.completed_at,
            cost: a.cost,
            tokens: a.tokens,
            error_message: a.error_message,
            failure_category: a.failure_category,
            review_gate: a.review_gate.map(Into::into),
            session_history: a
                .session_history
                .map(|sessions| sessions.into_iter().map(Into::into).collect()),
            recovery: a.recovery.map(Into::into),
            delivery: a.delivery.map(Into::into),
            task_id: a.task_id,
            draft_pr_number: a.draft_pr_number,
        }
    }
}

impl From<core_flight::Flight> for FlightDto {
    fn from(value: core_flight::Flight) -> Self {
        Self {
            id: value.id,
            title: value.title,
            objective: value.objective,
            status: value.status.into(),
            priority: value.priority.into(),
            project_path: value.project_path,
            workspace_id: value.workspace_id,
            git_branch: value.git_branch,
            milestones: value.milestones.into_iter().map(Into::into).collect(),
            linked_session_ids: value.linked_session_ids,
            issue_ids: Vec::new(),
            created_at: value.created_at,
            updated_at: value.updated_at,
            completed_at: value.completed_at,
            total_cost: value.total_cost,
            total_tokens: value.total_tokens,
            prompt: value.prompt,
            attempts: value.attempts.into_iter().map(Into::into).collect(),
            review_gate_policy: value.review_gate_policy.map(Into::into),
            execution_mode: value.execution_mode.map(Into::into),
            execution_target: value.execution_target.map(Into::into),
            integration_branch: value.integration_branch.map(Into::into),
            coordination_inbox: value
                .coordination_inbox
                .into_iter()
                .map(Into::into)
                .collect(),
            autonomy_mode: value.autonomy_mode.map(Into::into),
            autonomy_policy: value.autonomy_policy.map(Into::into),
            autonomy_runtime: value.autonomy_runtime.map(Into::into),
            delivery: value.delivery.map(Into::into),
            archived_at: value.archived_at,
            stopped_at: value.stopped_at,
            planning_conversation_id: value.planning_conversation_id,
            planner_session_id: value.planner_session_id,
            planner_status: value.planner_status.map(Into::into),
            planner_cost: value.planner_cost,
            planner_tokens: value.planner_tokens,
            planner_provider: value.planner_provider,
            publish_attempts_as_prs: value.publish_attempts_as_prs,
            coordination_log: value.coordination_log,
        }
    }
}

impl From<FlightDto> for core_flight::Flight {
    fn from(value: FlightDto) -> Self {
        Self {
            id: value.id,
            title: value.title,
            objective: value.objective,
            status: value.status.into(),
            priority: value.priority.into(),
            project_path: value.project_path,
            workspace_id: value.workspace_id,
            git_branch: value.git_branch,
            milestones: value.milestones.into_iter().map(Into::into).collect(),
            linked_session_ids: value.linked_session_ids,
            created_at: value.created_at,
            updated_at: value.updated_at,
            completed_at: value.completed_at,
            total_cost: value.total_cost,
            total_tokens: value.total_tokens,
            prompt: value.prompt,
            attempts: value.attempts.into_iter().map(Into::into).collect(),
            review_gate_policy: value.review_gate_policy.map(Into::into),
            execution_mode: value.execution_mode.map(Into::into),
            execution_target: value.execution_target.map(Into::into),
            integration_branch: value.integration_branch.map(Into::into),
            coordination_inbox: value
                .coordination_inbox
                .into_iter()
                .map(Into::into)
                .collect(),
            autonomy_mode: value.autonomy_mode.map(Into::into),
            autonomy_policy: value.autonomy_policy.map(Into::into),
            autonomy_runtime: value.autonomy_runtime.map(Into::into),
            delivery: value.delivery.map(Into::into),
            archived_at: value.archived_at,
            stopped_at: value.stopped_at,
            planning_conversation_id: value.planning_conversation_id,
            planner_session_id: value.planner_session_id,
            planner_status: value.planner_status.map(Into::into),
            planner_cost: value.planner_cost,
            planner_tokens: value.planner_tokens,
            planner_provider: value.planner_provider,
            publish_attempts_as_prs: value.publish_attempts_as_prs,
            coordination_log: value.coordination_log,
        }
    }
}

impl From<core_storage::PersistedState> for PersistedStateDto {
    fn from(value: core_storage::PersistedState) -> Self {
        Self {
            version: value.version,
            flights: value.flights.into_iter().map(Into::into).collect(),
            agents: value.agents.into_iter().map(Into::into).collect(),
            issues: value.issues,
            settings: value.settings.into(),
            ui: value.ui.into(),
            workspaces: value.workspaces.into_iter().map(Into::into).collect(),
            memory_events: value.memory_events,
            memory_patterns: value.memory_patterns,
            servers: value.servers.into_iter().map(Into::into).collect(),
            cli_accounts: value.cli_accounts.into_iter().map(Into::into).collect(),
            cli_account_defaults: value.cli_account_defaults,
        }
    }
}

impl From<PersistedStateDto> for core_storage::PersistedState {
    fn from(value: PersistedStateDto) -> Self {
        Self {
            version: value.version,
            flights: value.flights.into_iter().map(Into::into).collect(),
            agents: value.agents.into_iter().map(Into::into).collect(),
            issues: value.issues,
            settings: value.settings.into(),
            ui: value.ui.into(),
            workspaces: value.workspaces.into_iter().map(Into::into).collect(),
            retrospectives: Vec::new(),
            memory_events: value.memory_events,
            memory_patterns: value.memory_patterns,
            servers: value.servers.into_iter().map(Into::into).collect(),
            cli_accounts: value.cli_accounts.into_iter().map(Into::into).collect(),
            cli_account_defaults: value.cli_account_defaults,
            // Flight approvals only travel as part of the planner state
            // surface; the legacy DTO→core round-trip used by the
            // settings save path does not carry them, so we drop them
            // here. (The frontend reads approvals through a dedicated
            // flight-planner query, not through PersistedStateDto.)
            flight_approvals: Vec::new(),
            // Backend-only one-time migration marker; never travels over the
            // DTO. `commands::state::save_persisted_state` re-applies the
            // on-disk value after `*state = incoming`.
            cost_reprice_v1_at: None,
        }
    }
}

#[doc(hidden)]
pub fn generated_typescript_schema() -> String {
    let mut lines = vec![
        "// Auto-generated from Rust API DTOs. Run `pnpm generate:tauri-schema` to refresh."
            .to_string(),
        String::new(),
    ];

    macro_rules! push_decl {
        ($ty:ty) => {{
            let decl = <$ty as TS>::decl()
                .lines()
                .map(str::trim_end)
                .collect::<Vec<_>>()
                .join("\n");
            lines.push(format!("export {decl}\n"));
        }};
    }

    push_decl!(WorkspaceAgentSlotDto);
    push_decl!(WorkspaceStatusDto);
    push_decl!(ThemeDto);
    push_decl!(GridPositionDto);
    push_decl!(StageDraftAssetInput);
    push_decl!(StagedDraftAssetDto);
    push_decl!(ReadDraftAssetDto);
    push_decl!(DraftAssetMeta);
    push_decl!(FrozenRuntimeLaunch);
    push_decl!(PrepareRuntimeRunInput);
    push_decl!(PrepareRuntimeRunResult);
    push_decl!(RuntimeRunSummary);
    push_decl!(RuntimeLaunchView);
    push_decl!(RuntimeEventView);
    push_decl!(TerminalShellSelectionDto);
    push_decl!(WorkspacePaneDto);
    push_decl!(GithubRepoDto);
    push_decl!(ExecutionTargetRefDto);
    push_decl!(WorkspaceDto);
    push_decl!(ServerConfigDto);
    push_decl!(CliAccountDto);
    push_decl!(PersistedUiStateDto);
    push_decl!(OrchestratorSettingsDto);
    push_decl!(AgentCapabilityDto);
    push_decl!(ToolUsePatternDto);
    push_decl!(AgentStatusPatternsDto);
    push_decl!(AgentApprovalActionsDto);
    push_decl!(AgentConfigDto);
    push_decl!(FlightStatusDto);
    push_decl!(PlannerStatusDto);
    push_decl!(FlightApprovalRequestDto);
    push_decl!(FlightPriorityDto);
    push_decl!(MilestoneStatusDto);
    push_decl!(TaskStatusDto);
    push_decl!(TaskTypeDto);
    push_decl!(ValidationVerdictDto);
    push_decl!(ReviewTypeDto);
    push_decl!(TaskHandoffDto);
    push_decl!(TaskValidationAssertionDto);
    push_decl!(TaskValidationReportDto);
    push_decl!(TaskResultDto);
    push_decl!(ReviewPacketDto);
    push_decl!(TaskDto);
    push_decl!(MilestoneDto);
    push_decl!(AttemptStatusDto);
    push_decl!(AttemptTargetDto);
    push_decl!(ReviewGateVerdictDto);
    push_decl!(ReviewGateStatusDto);
    push_decl!(ReviewGateFindingSeverityDto);
    push_decl!(ReviewGateFindingDto);
    push_decl!(ReviewGateReportDto);
    push_decl!(ReviewGatePolicyDto);
    push_decl!(ReviewGateEvidenceDto);
    push_decl!(ReviewerSessionDto);
    push_decl!(AttemptReviewGateDto);
    push_decl!(FlightExecutionModeDto);
    push_decl!(IntegrationBranchStatusDto);
    push_decl!(FlightIntegrationBranchDto);
    push_decl!(AutonomyFlightModeDto);
    push_decl!(AutonomyDefaultModeDto);
    push_decl!(AutonomyToolPostureDto);
    push_decl!(AutonomyRunStatusDto);
    push_decl!(AutonomyActionStatusDto);
    push_decl!(AutonomyActionKindDto);
    push_decl!(AutonomyPolicyDto);
    push_decl!(AutonomyActionRecordDto);
    push_decl!(AutonomyRuntimeDto);
    push_decl!(CoordinationMessageKindDto);
    push_decl!(CoordinationDeliveryStatusDto);
    push_decl!(CoordinationMessagePartyDto);
    push_decl!(CoordinationMessageRecipientDto);
    push_decl!(CoordinationArtifactRefDto);
    push_decl!(CoordinationAcknowledgementDto);
    push_decl!(CoordinationMessageDto);
    push_decl!(AttemptRecoveryDto);
    push_decl!(FlightDeliveryDto);
    push_decl!(FlightExecutionTargetDto);
    push_decl!(AttemptDto);
    push_decl!(FlightDto);
    push_decl!(PersistedStateDto);

    lines.join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn persisted_state_dto_serializes_with_camel_case_transport_keys() {
        let dto = PersistedStateDto {
            version: 1,
            flights: vec![FlightDto {
                id: "flight-1".into(),
                title: "Flight".into(),
                objective: "Objective".into(),
                status: FlightStatusDto::Active,
                priority: FlightPriorityDto::High,
                project_path: "/test".into(),
                workspace_id: None,
                git_branch: Some("main".into()),
                milestones: vec![MilestoneDto {
                    id: "ms-1".into(),
                    flight_id: "flight-1".into(),
                    title: "Milestone".into(),
                    description: "Desc".into(),
                    order: 0,
                    status: MilestoneStatusDto::Active,
                    tasks: vec![TaskDto {
                        id: "task-1".into(),
                        milestone_id: "ms-1".into(),
                        flight_id: "flight-1".into(),
                        title: "Task".into(),
                        description: "Desc".into(),
                        order: 0,
                        status: TaskStatusDto::Running,
                        task_type: TaskTypeDto::Implementation,
                        agent_config_id: "claude-code".into(),
                        agent_args: None,
                        model: None,
                        depends_on: Vec::new(),
                        session_id: None,
                        result: Some(TaskResultDto {
                            exit_code: Some(0),
                            summary: "ok".into(),
                            files_changed: vec!["src/main.rs".into()],
                            errors: Vec::new(),
                            duration: 10,
                            handoff: None,
                            validation: None,
                        }),
                        review_packet: None,
                        created_at: 0,
                        started_at: None,
                        completed_at: None,
                        cost: 0.0,
                        tokens: 0,
                        owned_paths: None,
                        replan_count: 0,
                    }],
                    validation_criteria: Vec::new(),
                }],
                linked_session_ids: vec!["session-1".into()],
                issue_ids: Vec::new(),
                created_at: 0,
                updated_at: 0,
                completed_at: None,
                total_cost: 0.0,
                total_tokens: 0,
                prompt: None,
                attempts: vec![],
                review_gate_policy: None,
                execution_mode: None,
                execution_target: None,
                integration_branch: None,
                coordination_inbox: Vec::new(),
                autonomy_mode: None,
                autonomy_policy: None,
                autonomy_runtime: None,
                delivery: None,
                archived_at: None,
                stopped_at: None,
                planning_conversation_id: None,
                planner_session_id: None,
                planner_status: None,
                planner_cost: None,
                planner_tokens: None,
                planner_provider: None,
                publish_attempts_as_prs: false,
                coordination_log: Vec::new(),
            }],
            agents: Vec::new(),
            issues: Vec::new(),
            settings: OrchestratorSettingsDto {
                max_parallel_sessions: 3,
                milestone_gating: true,
                project_path: "/test".into(),
                auto_commit_trailer_enabled: true,
                auto_commit_trailer_format: core_orchestrator::DEFAULT_AUTO_COMMIT_TRAILER_FORMAT
                    .into(),
                autonomy_default_mode: Some(AutonomyDefaultModeDto::Assisted),
                autonomy_default_policy: Some(AutonomyPolicyDto::default()),
            },
            ui: PersistedUiStateDto {
                selected_flight_id: None,
                selected_view: None,
                theme: Some(ThemeDto::Dark),
                time_zone: None,
            },
            workspaces: Vec::new(),
            memory_events: Vec::new(),
            memory_patterns: Vec::new(),
            servers: Vec::new(),
            cli_accounts: Vec::new(),
            cli_account_defaults: BTreeMap::new(),
        };

        let value = serde_json::to_value(dto).unwrap();
        assert!(value["settings"].get("maxParallelSessions").is_some());
        assert!(value["settings"].get("milestoneGating").is_some());
        assert!(value["settings"].get("projectPath").is_some());
        assert!(value["flights"][0].get("projectPath").is_some());
        assert!(value["flights"][0]["milestones"][0]
            .get("flightId")
            .is_some());
        assert!(value["flights"][0]["milestones"][0]["tasks"][0]
            .get("milestoneId")
            .is_some());
        assert!(value["flights"][0]["milestones"][0]["tasks"][0]
            .get("agentConfigId")
            .is_some());
        assert!(value["flights"][0]["milestones"][0]["tasks"][0]["result"]
            .get("filesChanged")
            .is_some());
        assert_eq!(value["ui"]["theme"], "dark");
    }

    #[test]
    fn workspace_dto_preserves_frontend_metadata_through_core_round_trip() {
        let json = r#"{
            "id": "workspace-1",
            "name": "Workspace",
            "agents": ["codex"],
            "panes": [
                {
                    "id": "pane-1",
                    "agentId": "codex",
                    "sessionId": "session-1",
                    "gridPosition": { "row": 0, "col": 0 },
                    "accentColor": "accent-green",
                    "pinnedCommands": ["pnpm test"],
                    "taskId": "task-1",
                    "flightId": "flight-1",
                    "agentConfigId": "codex",
                    "initialPrompt": "Start here",
                    "overrideCommand": "codex",
                    "overrideArgs": ["--ask-for-approval", "never"]
                }
            ],
            "projectPath": "/repo",
            "prompt": null,
            "createdAt": 1,
            "updatedAt": 2,
            "status": "active",
            "githubRepo": { "owner": "openai", "repo": "packetbench" }
        }"#;

        let dto: WorkspaceDto = serde_json::from_str(json).expect("workspace dto should parse");
        let core: core_workspace::Workspace = dto.into();

        let pane = &core.panes[0];
        assert_eq!(pane.accent_color.as_deref(), Some("accent-green"));
        assert_eq!(
            pane.pinned_commands.as_deref(),
            Some(&["pnpm test".to_string()][..])
        );
        assert_eq!(pane.task_id.as_deref(), Some("task-1"));
        assert_eq!(pane.flight_id.as_deref(), Some("flight-1"));
        assert_eq!(pane.agent_config_id.as_deref(), Some("codex"));
        assert_eq!(pane.initial_prompt.as_deref(), Some("Start here"));
        assert_eq!(pane.override_command.as_deref(), Some("codex"));
        assert_eq!(
            pane.override_args.as_deref(),
            Some(&["--ask-for-approval".to_string(), "never".to_string()][..])
        );
        let github_repo = core
            .github_repo
            .as_ref()
            .expect("github repo should persist");
        assert_eq!(github_repo.owner, "openai");
        assert_eq!(github_repo.repo, "packetbench");

        let back: WorkspaceDto = core.into();
        let value = serde_json::to_value(back).unwrap();
        assert_eq!(value["githubRepo"]["owner"], "openai");
        assert_eq!(value["githubRepo"]["repo"], "packetbench");
        assert_eq!(value["panes"][0]["accentColor"], "accent-green");
        assert_eq!(value["panes"][0]["pinnedCommands"][0], "pnpm test");
        assert_eq!(value["panes"][0]["taskId"], "task-1");
        assert_eq!(value["panes"][0]["flightId"], "flight-1");
        assert_eq!(value["panes"][0]["agentConfigId"], "codex");
        assert_eq!(value["panes"][0]["initialPrompt"], "Start here");
        assert_eq!(value["panes"][0]["overrideCommand"], "codex");
        assert_eq!(value["panes"][0]["overrideArgs"][0], "--ask-for-approval");
        assert_eq!(value["panes"][0]["overrideArgs"][1], "never");
    }

    #[test]
    fn conversation_pane_round_trips_kind_and_conversation_id_through_core() {
        // Tile program (P1-S1): a conversation pane carries the inert carrier
        // agentId "terminal" plus the kind discriminant + conversationId; all
        // three must survive DTO → core → DTO with camelCase transport keys.
        let json = r#"{
            "id": "workspace-1",
            "name": "Workspace",
            "agents": [],
            "panes": [
                {
                    "id": "pane-conv",
                    "agentId": "terminal",
                    "sessionId": null,
                    "gridPosition": { "row": 0, "col": 1 },
                    "kind": "conversation",
                    "conversationId": "conv-123"
                }
            ],
            "projectPath": "/repo",
            "prompt": null,
            "createdAt": 1,
            "updatedAt": 2,
            "status": "active"
        }"#;

        let dto: WorkspaceDto = serde_json::from_str(json).expect("workspace dto should parse");
        let core: core_workspace::Workspace = dto.into();

        let pane = &core.panes[0];
        assert_eq!(pane.agent_id, "terminal");
        assert_eq!(pane.kind.as_deref(), Some("conversation"));
        assert_eq!(pane.conversation_id.as_deref(), Some("conv-123"));

        let back: WorkspaceDto = core.into();
        let value = serde_json::to_value(back).unwrap();
        // Inert carrier: never serialized as agentId "conversation".
        assert_eq!(value["panes"][0]["agentId"], "terminal");
        assert_eq!(value["panes"][0]["kind"], "conversation");
        assert_eq!(value["panes"][0]["conversationId"], "conv-123");
    }

    #[test]
    fn task_dto_replan_count_round_trips_through_core_and_camel_case() {
        // Core Task → TaskDto → Core Task should preserve replan_count.
        let mut task = core_flight::Task {
            id: "t1".into(),
            milestone_id: "m1".into(),
            flight_id: "f1".into(),
            title: "x".into(),
            description: String::new(),
            order: 0,
            status: core_flight::TaskStatus::Failed,
            task_type: core_flight::TaskType::Implementation,
            agent_config_id: "claude-code".into(),
            agent_args: None,
            model: None,
            depends_on: Vec::new(),
            session_id: None,
            result: None,
            review_packet: None,
            created_at: 0,
            started_at: None,
            completed_at: None,
            cost: 0.0,
            tokens: 0,
            owned_paths: Vec::new(),
            replan_count: 0,
        };
        task.replan_count = 2;

        let dto: TaskDto = task.into();
        assert_eq!(dto.replan_count, 2);

        // Wire shape: camelCase `replanCount` is what the frontend reads.
        let value = serde_json::to_value(&dto).unwrap();
        assert_eq!(value["replanCount"], 2);

        // Round-trip back through core_flight::Task.
        let back: core_flight::Task = dto.into();
        assert_eq!(back.replan_count, 2);
    }

    #[test]
    fn task_dto_replan_count_defaults_when_missing_in_camel_case_json() {
        // Frontend / legacy persisted state may emit a TaskDto JSON without
        // `replanCount` — `#[serde(default)]` on the DTO must let us
        // deserialize cleanly with the field set to 0.
        let json = r#"{
            "id": "t1",
            "milestoneId": "m1",
            "flightId": "f1",
            "title": "x",
            "description": "",
            "order": 0,
            "status": "queued",
            "type": "implementation",
            "agentConfigId": "claude-code",
            "dependsOn": [],
            "sessionId": null,
            "createdAt": 0,
            "cost": 0.0,
            "tokens": 0
        }"#;
        let dto: TaskDto = serde_json::from_str(json).expect("legacy task dto should parse");
        assert_eq!(dto.replan_count, 0);
    }

    #[test]
    fn ssh_attempt_target_accepts_legacy_ids_and_emits_server_id() {
        for legacy_key in ["targetId", "target_id"] {
            let json = format!(
                r#"{{
                    "kind": "ssh",
                    "{legacy_key}": "server-1",
                    "basePath": "/repo",
                    "worktreePath": "/repo/worktree"
                }}"#
            );
            let dto: AttemptTargetDto =
                serde_json::from_str(&json).expect("legacy SSH attempt target should parse");
            assert!(matches!(
                dto,
                AttemptTargetDto::Ssh { ref server_id, .. } if server_id == "server-1"
            ));
        }

        let dto = AttemptTargetDto::Ssh {
            server_id: "server-1".into(),
            base_path: "/repo".into(),
            worktree_path: "/repo/worktree".into(),
        };
        let value = serde_json::to_value(dto).expect("SSH attempt target should serialize");
        assert_eq!(value["serverId"], "server-1");
        assert!(value.get("targetId").is_none());
        assert!(value.get("target_id").is_none());
    }
}
