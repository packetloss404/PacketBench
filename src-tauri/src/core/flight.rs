use serde::{Deserialize, Serialize};

// === Flight Status & Priority ===

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FlightStatus {
    Draft,
    /// Legacy Flight Planner spec-mode status. Retained so persisted v1
    /// Flights deserialize losslessly; the current Flight Deck does not enter it.
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

impl FlightStatus {
    pub fn label(&self) -> &'static str {
        match self {
            Self::Draft => "Draft",
            Self::Spec => "Spec",
            Self::Planning => "Planning",
            Self::Ready => "Ready",
            Self::Active => "Active",
            Self::Paused => "Paused",
            Self::Review => "Review",
            Self::Done => "Done",
            Self::Failed => "Failed",
            Self::Cancelled => "Cancelled",
        }
    }
}

// === Legacy Flight Planner status ===
//
// This is the persisted form serialized into the Flight DTO. Kept in this
// module so the `Flight` struct's `planner_status` field doesn't need to
// import from the deleted planner command module. There is no live runtime
// registry; this enum is now only a wire/persistence compatibility shape.

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PlannerStatus {
    Idle,
    Awake,
    Paused,
    QuotaPaused,
    Completed,
    Failed,
}

impl PlannerStatus {
    pub fn label(&self) -> &'static str {
        match self {
            Self::Idle => "Idle",
            Self::Awake => "Awake",
            Self::Paused => "Paused",
            Self::QuotaPaused => "Quota Paused",
            Self::Completed => "Completed",
            Self::Failed => "Failed",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FlightPriority {
    Low,
    Medium,
    High,
    Critical,
}

impl FlightPriority {
    pub fn label(&self) -> &'static str {
        match self {
            Self::Low => "Low",
            Self::Medium => "Medium",
            Self::High => "High",
            Self::Critical => "Critical",
        }
    }
}

// === Milestone ===

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MilestoneStatus {
    Pending,
    Active,
    Done,
    Failed,
}

impl MilestoneStatus {
    pub fn label(&self) -> &'static str {
        match self {
            Self::Pending => "Pending",
            Self::Active => "Active",
            Self::Done => "Done",
            Self::Failed => "Failed",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Milestone {
    pub id: String,
    pub flight_id: String,
    pub title: String,
    pub description: String,
    pub order: usize,
    pub status: MilestoneStatus,
    pub tasks: Vec<Task>,
    pub validation_criteria: Vec<String>,
}

// === Task ===

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TaskStatus {
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

impl TaskStatus {
    pub fn label(&self) -> &'static str {
        match self {
            Self::Pending => "Pending",
            Self::Blocked => "Blocked",
            Self::Queued => "Queued",
            Self::Running => "Running",
            Self::ApprovalNeeded => "Needs Approval",
            Self::Paused => "Paused",
            Self::Done => "Done",
            Self::Failed => "Failed",
            Self::Cancelled => "Cancelled",
        }
    }

    pub fn is_terminal(&self) -> bool {
        matches!(self, Self::Done | Self::Failed | Self::Cancelled)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TaskType {
    Implementation,
    Testing,
    Review,
    Validation,
    Research,
    Refactor,
    Documentation,
}

impl TaskType {
    pub fn label(&self) -> &'static str {
        match self {
            Self::Implementation => "Impl",
            Self::Testing => "Test",
            Self::Review => "Review",
            Self::Validation => "Validate",
            Self::Research => "Research",
            Self::Refactor => "Refactor",
            Self::Documentation => "Docs",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TaskHandoff {
    pub summary: String,
    pub files_changed: Vec<String>,
    pub tests_needed: Vec<String>,
    pub follow_ups: Vec<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ValidationVerdict {
    Pass,
    Fail,
    Warn,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TaskValidationAssertion {
    pub label: String,
    pub status: ValidationVerdict,
    pub details: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TaskValidationReport {
    pub verdict: ValidationVerdict,
    pub summary: String,
    pub assertions: Vec<TaskValidationAssertion>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TaskResult {
    pub exit_code: Option<i32>,
    pub summary: String,
    pub files_changed: Vec<String>,
    pub errors: Vec<String>,
    pub duration_ms: u64,
    pub handoff: Option<TaskHandoff>,
    pub validation: Option<TaskValidationReport>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ReviewType {
    ToolCall,
    FileWrite,
    Command,
    MilestoneGate,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReviewPacket {
    pub id: String,
    pub task_id: String,
    pub flight_id: String,
    pub milestone_id: String,
    pub requested_at: u64,
    pub review_type: ReviewType,
    pub summary: String,
    pub diff: Option<String>,
    pub command: Option<String>,
    pub file_paths: Vec<String>,
    pub agent_id: Option<String>,
    pub session_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Task {
    pub id: String,
    pub milestone_id: String,
    pub flight_id: String,
    pub title: String,
    pub description: String,
    pub order: usize,
    pub status: TaskStatus,
    pub task_type: TaskType,
    pub agent_config_id: String,
    pub agent_args: Option<Vec<String>>,
    pub model: Option<String>,
    pub depends_on: Vec<String>,
    pub session_id: Option<String>,
    pub result: Option<TaskResult>,
    pub review_packet: Option<ReviewPacket>,
    pub created_at: u64,
    pub started_at: Option<u64>,
    pub completed_at: Option<u64>,
    pub cost: f64,
    pub tokens: u64,
    /// File/path claims used by Flight Planner collision gates. Paths are
    /// usually repo-relative and optional for legacy/manual tasks.
    #[serde(default)]
    pub owned_paths: Vec<String>,
    /// Legacy autonomous-Planner replan count. Read-compatible persisted data;
    /// the current attempt runtime does not increment this field.
    ///
    /// `#[serde(default)]` is critical for backwards-compat with existing
    /// persisted state — without it, old state files written before this
    /// field existed would fail to deserialize.
    #[serde(default)]
    pub replan_count: u32,
}

// === Approval Decision ===

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ApprovalDecisionType {
    Approved,
    Denied,
    ForceOverridden,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ApprovalDecision {
    pub id: String,
    pub review_packet_id: String,
    pub task_id: String,
    pub flight_id: String,
    pub decision: ApprovalDecisionType,
    pub decided_at: u64,
    pub reason: Option<String>,
}

// === Async Flight Attempts ===

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AttemptStatus {
    Queued,
    Provisioning,
    Running,
    Reviewing,
    Completed,
    Failed,
    Cancelled,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", tag = "kind")]
pub enum AttemptTarget {
    Local {
        base_path: String,
        worktree_path: String,
    },
    Ssh {
        #[serde(alias = "target_id", alias = "targetId")]
        server_id: String,
        base_path: String,
        worktree_path: String,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ReviewGateVerdict {
    Pass,
    ChangesRequested,
    Blocked,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ReviewGateStatus {
    Pending,
    Running,
    Passed,
    ChangesRequested,
    Blocked,
    Error,
    Overridden,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ReviewGateFindingSeverity {
    Info,
    Warning,
    Error,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReviewGateFinding {
    pub severity: ReviewGateFindingSeverity,
    pub title: String,
    pub details: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub file_path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub line: Option<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReviewGateReport {
    pub schema_version: u32,
    pub verdict: ReviewGateVerdict,
    pub summary: String,
    #[serde(default)]
    pub findings: Vec<ReviewGateFinding>,
    #[serde(default)]
    pub evidence: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReviewGatePolicy {
    #[serde(default)]
    pub enabled: bool,
    pub reviewer_agent_config_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reviewer_model: Option<String>,
    #[serde(default)]
    pub acceptance_criteria: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ReviewGateEvidence {
    pub fingerprint: String,
    pub context_fingerprint: String,
    #[serde(default)]
    pub context_json: String,
    pub base_sha: String,
    pub head_sha: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReviewerSession {
    pub session_id: String,
    pub provider: String,
    pub model: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AttemptReviewGate {
    pub status: ReviewGateStatus,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reviewer_conversation_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reviewer_agent_config_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reviewer_model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub evidence: Option<ReviewGateEvidence>,
    #[serde(default)]
    pub reviewer_sessions: Vec<ReviewerSession>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub report: Option<ReviewGateReport>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error_message: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub started_at: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub completed_at: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub overridden_at: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub override_reason: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FlightExecutionMode {
    Independent,
    Cooperative,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum IntegrationBranchStatus {
    Uninitialized,
    Ready,
    Integrating,
    NeedsAttention,
    Landed,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FlightIntegrationBranch {
    pub branch: String,
    pub base_branch: String,
    pub base_sha: String,
    pub head_sha: String,
    pub worktree_path: String,
    pub target_kind: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub target_id: Option<String>,
    pub status: IntegrationBranchStatus,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error_message: Option<String>,
    #[serde(default)]
    pub conflict_files: Vec<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AutonomyFlightMode {
    Assisted,
    SettingsDefault,
    Yolo,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AutonomyDefaultMode {
    Assisted,
    Yolo,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AutonomyToolPosture {
    ApprovalGated,
    AllowInProject,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AutonomyRunStatus {
    Idle,
    Running,
    Paused,
    Stopped,
    NeedsAttention,
    Completed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AutonomyActionStatus {
    Started,
    Completed,
    Failed,
    Denied,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AutonomyActionKind {
    Continue,
    RecoverAttempt,
    ReviewRemediation,
    RetryReview,
    AcceptReviewPass,
    LaunchReadyTask,
    IntegrateAttempt,
    SetToolPosture,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AutonomyPolicy {
    pub schema_version: u32,
    pub auto_recovery: bool,
    pub auto_review_remediation: bool,
    pub auto_run_task_graph: bool,
    pub tool_posture: AutonomyToolPosture,
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

impl Default for AutonomyPolicy {
    fn default() -> Self {
        Self {
            schema_version: 1,
            auto_recovery: true,
            auto_review_remediation: true,
            auto_run_task_graph: true,
            tool_posture: AutonomyToolPosture::ApprovalGated,
            max_total_cost: 25.0,
            max_duration_minutes: 120,
            max_retries_per_task: 2,
            max_review_rounds: 2,
            max_concurrent_agents: 3,
            allowed_roots: Vec::new(),
            allowed_targets: vec!["local".to_string()],
            allow_draft_pr_publishing: false,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AutonomyActionRecord {
    pub id: String,
    pub kind: AutonomyActionKind,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub subject_id: Option<String>,
    pub status: AutonomyActionStatus,
    pub reason: String,
    pub timestamp: u64,
    pub cost: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub metadata: Option<serde_json::Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AutonomyRuntime {
    pub status: AutonomyRunStatus,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub started_at: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub paused_at: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stopped_at: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub hard_stop_reason: Option<String>,
    #[serde(default)]
    pub action_history: Vec<AutonomyActionRecord>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub review_retry_counts: Option<std::collections::HashMap<String, u32>>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CoordinationMessageKind {
    Instruction,
    Question,
    Answer,
    Blocker,
    Finding,
    Handoff,
    Artifact,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CoordinationDeliveryStatus {
    Queued,
    Delivered,
    Acknowledged,
    Failed,
    Archived,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CoordinationMessageParty {
    pub kind: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
    pub display_name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CoordinationMessageRecipient {
    pub kind: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CoordinationArtifactRef {
    pub id: String,
    pub label: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub uri: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mime_type: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CoordinationAcknowledgement {
    pub by: CoordinationMessageParty,
    pub at: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CoordinationMessage {
    pub schema_version: u32,
    pub id: String,
    pub flight_id: String,
    pub kind: CoordinationMessageKind,
    pub sender: CoordinationMessageParty,
    pub recipient: CoordinationMessageRecipient,
    pub body: String,
    #[serde(default)]
    pub artifacts: Vec<CoordinationArtifactRef>,
    pub status: CoordinationDeliveryStatus,
    pub created_at: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub delivered_at: Option<u64>,
    #[serde(default)]
    pub acknowledgements: Vec<CoordinationAcknowledgement>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reply_to_id: Option<String>,
    pub dedupe_key: String,
    #[serde(default)]
    pub hop_count: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error_message: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Attempt {
    pub id: String,
    pub flight_id: String,
    pub target: AttemptTarget,
    pub agent_config_id: String,
    pub model: String,
    pub provider: String,
    pub branch: String,
    pub base_branch: String,
    pub session_id: String,
    pub status: AttemptStatus,
    /// Immutable ownership of prior builder sessions after explicit recovery.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_history: Option<Vec<ReviewerSession>>,
    #[serde(default)]
    pub started_at: Option<u64>,
    #[serde(default)]
    pub completed_at: Option<u64>,
    #[serde(default)]
    pub cost: f64,
    #[serde(default)]
    pub tokens: u64,
    #[serde(default)]
    pub error_message: Option<String>,
    /// E1: structured failure category derived from `error_message` at the
    /// moment the attempt goes `Failed` (via `core::error_classifier`). Stable
    /// snake_case label (`auth`/`timeout`/`rate_limit`/…); `None` unless the
    /// attempt failed. Lets the UI show more than free-text error output.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub failure_category: Option<String>,
    /// RG1: independent reviewer lifecycle and verdict. Absent for legacy
    /// attempts and Flights with the Reviewer Gate disabled.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub review_gate: Option<AttemptReviewGate>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub recovery: Option<AttemptRecovery>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub delivery: Option<FlightDelivery>,
    /// Cooperative graph task that owns this attempt.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub task_id: Option<String>,
    /// v0.8-G: when the parent Flight has `publish_attempts_as_prs == true`,
    /// the post-attempt pipeline pushes this attempt's branch to `origin`
    /// and opens a GitHub draft PR. The resulting PR number is recorded
    /// here so the Flight Detail UI can surface a "Draft PR #N" link.
    /// `None` if publishing is disabled or the publish step failed
    /// (errors are logged to the attempt's error_message; the attempt
    /// itself stays in whatever terminal state it earned naturally).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub draft_pr_number: Option<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RecoveryState {
    Retained,
    Discarded,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AttemptRecovery {
    pub state: RecoveryState,
    pub reason: String,
    pub retained_at: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DeliveryKind {
    Landed,
    PullRequest,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FlightDelivery {
    pub kind: DeliveryKind,
    pub delivered_at: u64,
    pub branch: String,
    pub base_branch: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub commit_sha: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pr_number: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pr_url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub attempt_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FlightExecutionTarget {
    pub kind: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub server_id: Option<String>,
    pub base_path: String,
}

// === Flight ===

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Flight {
    pub id: String,
    pub title: String,
    pub objective: String,
    pub status: FlightStatus,
    pub priority: FlightPriority,
    pub project_path: String,
    #[serde(default)]
    pub workspace_id: Option<String>,
    pub git_branch: Option<String>,
    pub milestones: Vec<Milestone>,
    pub linked_session_ids: Vec<String>,
    pub created_at: u64,
    pub updated_at: u64,
    pub completed_at: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub delivery: Option<FlightDelivery>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub archived_at: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stopped_at: Option<u64>,
    pub total_cost: f64,
    pub total_tokens: u64,
    #[serde(default)]
    pub prompt: Option<String>,
    #[serde(default)]
    pub attempts: Vec<Attempt>,
    /// RG1: opt-in reviewer policy. Absent means the gate is disabled.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub review_gate_policy: Option<ReviewGatePolicy>,
    /// Cooperative execution is opt-in; absent legacy values hydrate as the
    /// independent-attempt mode.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub execution_mode: Option<FlightExecutionMode>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub execution_target: Option<FlightExecutionTarget>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub integration_branch: Option<FlightIntegrationBranch>,
    #[serde(default)]
    pub coordination_inbox: Vec<CoordinationMessage>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub autonomy_mode: Option<AutonomyFlightMode>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub autonomy_policy: Option<AutonomyPolicy>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub autonomy_runtime: Option<AutonomyRuntime>,
    /// Normal API-agent conversation used to refine the current upfront plan.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub planning_conversation_id: Option<String>,
    /// Legacy autonomous-Planner session id. Read-compatible only.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub planner_session_id: Option<String>,
    /// Legacy autonomous-Planner status. Read-compatible only.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub planner_status: Option<PlannerStatus>,
    /// Legacy autonomous-Planner cost. Executor cost still rolls up through
    /// `flight_cost.rs`; no live code increments this compatibility field.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub planner_cost: Option<f64>,
    /// Legacy autonomous-Planner token count. Read-compatible only.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub planner_tokens: Option<u64>,
    /// Legacy autonomous-Planner provider id. Read-compatible only.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub planner_provider: Option<String>,
    /// v0.8-G: when set on an async-mode Flight, the executor pipeline
    /// pushes each attempt's branch to `origin` and opens a draft GitHub
    /// PR after the attempt reaches a terminal `completed`/`reviewing`
    /// state. The resulting PR number is written back to
    /// `Attempt.draft_pr_number`. Defaults to `false` for back-compat with
    /// previously-persisted Flights.
    #[serde(default)]
    pub publish_attempts_as_prs: bool,
    /// N3: append-only coordination timeline (handoff / task_failed /
    /// escalation events) rendered in FlightsView. Frontend-owned schema, so
    /// stored as opaque JSON here purely to round-trip through persistence
    /// (was previously frontend-only and lost on reload).
    #[serde(default)]
    pub coordination_log: Vec<serde_json::Value>,
}

impl Flight {
    /// Get all tasks across all milestones.
    pub fn all_tasks(&self) -> Vec<&Task> {
        self.milestones
            .iter()
            .flat_map(|m| m.tasks.iter())
            .collect()
    }

    /// Count done / total tasks.
    pub fn progress(&self) -> (usize, usize) {
        let tasks = self.all_tasks();
        let done = tasks
            .iter()
            .filter(|t| t.status == TaskStatus::Done)
            .count();
        (done, tasks.len())
    }

    /// Check if any tasks need attention (approval or failed).
    pub fn needs_attention(&self) -> bool {
        self.all_tasks()
            .iter()
            .any(|t| t.status == TaskStatus::ApprovalNeeded || t.status == TaskStatus::Failed)
    }
}

// === Flight Approval Request ===
//
// Persisted record from the deleted autonomous Planner approval flow. Kept so
// historical state loads losslessly; current Flight Deck code does not create
// or resolve these records.

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FlightApprovalRequest {
    /// `approval_id` — the value returned to the planner in the
    /// `pending_approval:<id>` sentinel.
    pub id: String,
    #[serde(alias = "missionId")]
    pub flight_id: String,
    pub question: String,
    /// Optional multiple-choice options. Empty vec = free-form text answer.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub options: Vec<String>,
    /// Unix millis when the planner filed the approval.
    pub awaiting_since: u64,
    pub resolved: bool,
    /// The option the user picked, or `"dismissed"` for a dismissed
    /// approval. `None` while `resolved == false`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resolution: Option<String>,
    /// Unix millis when the user resolved the approval.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resolved_at: Option<u64>,
}

// === Issue ===

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AcceptanceCriterion {
    pub id: String,
    pub text: String,
    pub checked: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Issue {
    pub id: String,
    pub ticket_id: String,
    pub title: String,
    pub description: String,
    pub status: String,
    pub priority: String,
    pub labels: Vec<String>,
    pub epic: Option<String>,
    pub session_id: Option<String>,
    pub flight_id: Option<String>,
    pub acceptance_criteria: Vec<AcceptanceCriterion>,
    pub blocked_by: Vec<String>,
    pub blocks: Vec<String>,
    pub created_at: u64,
    pub updated_at: u64,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_task(status: TaskStatus) -> Task {
        Task {
            id: uuid::Uuid::new_v4().to_string(),
            milestone_id: "m1".to_string(),
            flight_id: "f1".to_string(),
            title: "Test task".to_string(),
            description: String::new(),
            order: 0,
            status,
            task_type: TaskType::Implementation,
            agent_config_id: String::new(),
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
        }
    }

    fn make_milestone(tasks: Vec<Task>) -> Milestone {
        Milestone {
            id: "m1".to_string(),
            flight_id: "f1".to_string(),
            title: "Milestone 1".to_string(),
            description: String::new(),
            order: 0,
            status: MilestoneStatus::Active,
            tasks,
            validation_criteria: Vec::new(),
        }
    }

    fn make_flight(milestones: Vec<Milestone>) -> Flight {
        Flight {
            id: "f1".to_string(),
            title: "Test flight".to_string(),
            objective: String::new(),
            status: FlightStatus::Active,
            priority: FlightPriority::Medium,
            project_path: "/tmp/test".to_string(),
            workspace_id: None,
            git_branch: None,
            milestones,
            linked_session_ids: Vec::new(),
            created_at: 0,
            updated_at: 0,
            completed_at: None,
            total_cost: 0.0,
            total_tokens: 0,
            prompt: None,
            attempts: Vec::new(),
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
        }
    }

    #[test]
    fn all_tasks_returns_tasks_across_milestones() {
        let m1 = make_milestone(vec![make_task(TaskStatus::Done)]);
        let m2 = make_milestone(vec![
            make_task(TaskStatus::Pending),
            make_task(TaskStatus::Running),
        ]);
        let flight = make_flight(vec![m1, m2]);
        assert_eq!(flight.all_tasks().len(), 3);
    }

    #[test]
    fn progress_counts_done_tasks() {
        let t1 = make_task(TaskStatus::Done);
        let t2 = make_task(TaskStatus::Running);
        let flight = make_flight(vec![make_milestone(vec![t1, t2])]);
        let (done, total) = flight.progress();
        assert_eq!(done, 1);
        assert_eq!(total, 2);
    }

    #[test]
    fn needs_attention_detects_approval_needed() {
        let flight = make_flight(vec![make_milestone(vec![make_task(
            TaskStatus::ApprovalNeeded,
        )])]);
        assert!(flight.needs_attention());
    }

    #[test]
    fn needs_attention_detects_failed() {
        let flight = make_flight(vec![make_milestone(vec![make_task(TaskStatus::Failed)])]);
        assert!(flight.needs_attention());
    }

    #[test]
    fn needs_attention_false_when_all_ok() {
        let flight = make_flight(vec![make_milestone(vec![make_task(TaskStatus::Running)])]);
        assert!(!flight.needs_attention());
    }

    #[test]
    fn task_status_is_terminal() {
        assert!(TaskStatus::Done.is_terminal());
        assert!(TaskStatus::Failed.is_terminal());
        assert!(TaskStatus::Cancelled.is_terminal());
        assert!(!TaskStatus::Running.is_terminal());
        assert!(!TaskStatus::Pending.is_terminal());
        assert!(!TaskStatus::ApprovalNeeded.is_terminal());
    }

    #[test]
    fn task_replan_count_defaults_to_zero_on_deserialize() {
        // Old persisted state (pre-E5) won't have `replanCount` on Task.
        // The `#[serde(default)]` attribute must let it round-trip into a
        // zero-initialized field rather than failing deserialization.
        let json = r#"{
            "id": "t1",
            "milestone_id": "m1",
            "flight_id": "f1",
            "title": "x",
            "description": "y",
            "order": 0,
            "status": "queued",
            "task_type": "implementation",
            "agent_config_id": "claude-code",
            "depends_on": [],
            "session_id": null,
            "created_at": 0,
            "cost": 0.0,
            "tokens": 0
        }"#;
        let task: Task = serde_json::from_str(json).expect("legacy task json should parse");
        assert_eq!(task.replan_count, 0);
    }

    #[test]
    fn task_replan_count_round_trips() {
        let mut task = make_task(TaskStatus::Failed);
        task.replan_count = 2;
        let json = serde_json::to_string(&task).unwrap();
        let back: Task = serde_json::from_str(&json).unwrap();
        assert_eq!(back.replan_count, 2);
    }
}
