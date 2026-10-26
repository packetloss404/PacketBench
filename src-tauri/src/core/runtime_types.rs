//! R1a runtime wire/domain types.
//!
//! Bounded subset of the full runtime contract (dev/agent-experience/01-runtime.md):
//! launch identity + idempotency only. States/phases are validated strings at
//! the wire boundary; typed unions land with later packets.

use serde::{Deserialize, Serialize};
use ts_rs::TS;

pub const RUNTIME_SCHEMA_VERSION: i64 = 1;
pub const MAX_EVENTS_PAGE: i64 = 256;
pub const MAX_ID_LEN: usize = 128;

/// Non-terminal → terminal launch phases. `provisioning`/`started`/`running`
/// are declared for forward compatibility; R1a only writes prepared/cancelled.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RuntimePhase {
    Prepared,
    Provisioning,
    Started,
    Running,
    Stopping,
    Cancelled,
    Completed,
    Failed,
}

impl RuntimePhase {
    pub fn as_str(self) -> &'static str {
        match self {
            RuntimePhase::Prepared => "prepared",
            RuntimePhase::Provisioning => "provisioning",
            RuntimePhase::Started => "started",
            RuntimePhase::Running => "running",
            RuntimePhase::Stopping => "stopping",
            RuntimePhase::Cancelled => "cancelled",
            RuntimePhase::Completed => "completed",
            RuntimePhase::Failed => "failed",
        }
    }

    pub fn is_terminal(self) -> bool {
        matches!(
            self,
            RuntimePhase::Cancelled | RuntimePhase::Completed | RuntimePhase::Failed
        )
    }
}

pub fn is_terminal_phase(phase: &str) -> bool {
    matches!(phase, "cancelled" | "completed" | "failed")
}

/// Checked `sha256:<64 lower-case hex>`.
pub fn validate_sha256_digest(value: &str) -> Result<(), String> {
    let Some(hex) = value.strip_prefix("sha256:") else {
        return Err("digest must start with sha256:".to_string());
    };
    if hex.len() != 64
        || !hex
            .chars()
            .all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase())
    {
        return Err("digest must be 64 lower-case hex characters".to_string());
    }
    Ok(())
}

pub fn validate_id(field: &str, value: &str) -> Result<(), String> {
    if value.is_empty() || value.len() > MAX_ID_LEN {
        return Err(format!("{field} must be 1..={MAX_ID_LEN} characters"));
    }
    if value.chars().any(|c| c.is_control()) {
        return Err(format!("{field} must not contain control characters"));
    }
    Ok(())
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct FrozenRuntimeLaunch {
    /// Provider route id (e.g. "anthropic", "openai").
    pub route: String,
    pub model: String,
    /// Only "checkout" is accepted by R1a.
    pub requested_isolation: String,
    pub draft_id: String,
    pub draft_revision: String,
    pub project_key: String,
    pub base_path: String,
    /// The immutable execution authority of the run (R1/R3). Absent on rows
    /// written before this field existed; an existing turn is only refused when
    /// both sides carry a binding that differs.
    #[serde(default)]
    #[ts(optional)]
    pub execution: Option<FrozenExecutionBinding>,
    /// The frozen policy identity of the run (R1/R3 restart recovery). Recorded
    /// at prepare time from the same inputs the checkpoints are written with, so
    /// a typed resume can still be verified after the app and backend session
    /// have genuinely restarted, when no live session remains registered to
    /// supply a live policy context. Absent on rows written before this field
    /// existed; when absent, a resume without a live session refuses typed
    /// fail-closed (the prior behaviour).
    #[serde(default)]
    #[ts(optional)]
    pub policy: Option<FrozenPolicyIdentity>,
}

/// The frozen policy identity of a run. Records only hashes and a non-secret
/// account label — never a secret, raw tool list or MCP configuration. It is the
/// durable stand-in for the live [`crate::core::runtime_checkpoint::CompatibilityContext`]
/// when a genuine restart has left no live session.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct FrozenPolicyIdentity {
    pub schema_version: i64,
    pub transport_version: i64,
    /// `sha256:` of the effective tool allowlist (`*` when unrestricted).
    pub tool_policy_hash: String,
    /// `sha256:` of the frozen MCP trust snapshot (empty when none).
    pub mcp_hash: String,
    /// `sha256:` of `provider:model:execution-label`.
    pub manifest_hash: String,
    /// Non-secret account label the run was prepared under (e.g. `anthropic`),
    /// so a resume cannot silently substitute another account.
    pub account: String,
}

/// The immutable execution authority of a run. Local carries no host identity;
/// SSH carries the server id, host and verified host-key pin, so a resumed or
/// extended run cannot silently target a different host.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct FrozenExecutionBinding {
    /// "local" | "ssh"
    pub kind: String,
    #[ts(optional)]
    pub server_id: Option<String>,
    #[ts(optional)]
    pub host: Option<String>,
    #[ts(optional)]
    pub host_fingerprint: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct PrepareRuntimeRunInput {
    pub operation_id: String,
    pub conversation_id: String,
    /// "initial" or "existing".
    pub kind: String,
    #[ts(optional)]
    pub retry_of_operation_id: Option<String>,
    pub request_digest: String,
    pub launch: FrozenRuntimeLaunch,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct PrepareRuntimeRunResult {
    pub operation_id: String,
    pub conversation_id: String,
    pub run_id: String,
    #[ts(type = "number")]
    pub epoch: i64,
    pub phase: String,
    /// false when an identical operation+digest was already prepared.
    pub created: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeRunSummary {
    #[ts(type = "number")]
    pub version: i64,
    pub runtime_run_id: String,
    pub conversation_id: String,
    pub operation_id: String,
    #[ts(type = "number")]
    pub epoch: i64,
    pub state: String,
    pub resume_mode: String,
    #[ts(type = "number")]
    pub latest_durable_seq: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeLaunchView {
    pub operation_id: String,
    pub conversation_id: String,
    pub run_id: String,
    pub phase: String,
    pub request_digest: String,
    #[ts(type = "number")]
    pub created_at: i64,
    #[ts(optional)]
    #[ts(type = "number")]
    pub cancelled_at: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeEventView {
    pub run_id: String,
    #[ts(type = "number")]
    pub seq: i64,
    #[ts(type = "number")]
    pub epoch: i64,
    pub kind: String,
    pub payload_hash: String,
    #[ts(type = "number")]
    pub created_at: i64,
}

/// R6 (H3) context/window readout for one run. The latest projection recorded
/// for the run, plus an honest window-policy disclosure. `window_known == false`
/// means no model window was available, so the projection could not have blocked
/// on overflow (an unknown window never blocks) — a disclosure, not a pass.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeContextSummary {
    pub run_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub projection: Option<RuntimeContextProjection>,
    pub window_known: bool,
    /// Human-readable policy note. Never a provider quota, reset or dollar
    /// claim.
    pub policy_note: String,
}

/// A flattened view of one [`crate::core::runtime_context::ContextSnapshot`].
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeContextProjection {
    pub snapshot_id: String,
    pub model_route: String,
    /// `"estimate"` — a conservative byte/3 heuristic, never a tokenizer.
    pub count_kind: String,
    #[ts(type = "number")]
    pub total_tokens: u64,
    #[ts(type = "number | null")]
    pub window_tokens: Option<u64>,
    #[ts(type = "number")]
    pub reserved_output_tokens: u64,
    #[ts(type = "number")]
    pub safety_margin_tokens: u64,
    pub blockers: Vec<String>,
    #[ts(type = "number")]
    pub created_at: i64,
}
