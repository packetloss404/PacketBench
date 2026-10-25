//! R2 seam: the boundary between the production agent runner and its host.
//!
//! R2a defined the seam contract and a test double; R2b moves the live
//! `run_agent_loop` behind it (`runner::run_turn`). The Tauri app implements
//! [`RuntimeServices`] in `commands::agent_runtime::TauriRuntimeServices`; a
//! headless fake implements the same trait for deterministic evaluation. The
//! runner is generic (static dispatch) so `async fn` in traits compiles without
//! a boxed-future requirement on the caller.
//!
//! R2b is a behavior-preserving extraction: event names/payloads, permission
//! and edit semantics, cancellation and error strings are identical to the
//! pre-extraction loop.

use std::sync::Arc;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::commands::custom_agents::CustomAgentDef;
use crate::core::execution::ExecutionTarget;
use crate::core::hooks::HookConfig;
use crate::core::llm_provider::LlmProvider;
use crate::core::llm_types::{
    ChatMessage, ImageAttachment, StreamChunk, ToolCall, ToolDefinition, ToolResult,
};
use crate::core::mcp_bridge::McpTrustSnapshot;
use crate::core::mcp_session::NativeMcpSession;
use crate::core::tool_tasks::SessionTasks;

pub mod runner;

#[cfg(any(test, feature = "runtime-eval"))]
pub mod testing;

/// Where durable/progress events go. The Tauri adapter emits `api-agent:*`;
/// the headless evaluation lane records them instead.
pub trait EventSink: Send + Sync {
    fn emit(&self, kind: &str, payload: Value);
}

/// Test/eval double that records emitted events in order.
#[derive(Default)]
pub struct RecordingEventSink {
    events: std::sync::Mutex<Vec<(String, Value)>>,
}

impl RecordingEventSink {
    pub fn new() -> Self {
        Self::default()
    }

    /// Snapshot of `(kind, payload)` in emission order.
    pub fn events(&self) -> Vec<(String, Value)> {
        self.events.lock().expect("recording sink poisoned").clone()
    }
}

impl EventSink for RecordingEventSink {
    fn emit(&self, kind: &str, payload: Value) {
        self.events
            .lock()
            .expect("recording sink poisoned")
            .push((kind.to_string(), payload));
    }
}

/// Permission modes for risky tool calls.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PermissionMode {
    /// Model's implicit authority — no prompts. Must be chosen explicitly;
    /// it is no longer the default (see `Default`).
    Auto,
    /// Prompt the user before running risky tools (bash, write_file,
    /// edit_file, create_pull_request). The fail-closed default: a session
    /// that never states a mode asks before every risky tool.
    AskForRisky,
    /// Allow all tools without prompts.
    AllowAll,
    /// Deny all risky tools.
    DenyAll,
}

impl Default for PermissionMode {
    fn default() -> Self {
        Self::AskForRisky
    }
}

impl PermissionMode {
    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "auto" => Some(Self::Auto),
            "ask_for_risky" => Some(Self::AskForRisky),
            "allow_all" => Some(Self::AllowAll),
            "deny_all" => Some(Self::DenyAll),
            _ => None,
        }
    }
}

#[derive(Debug, Clone)]
pub enum PermissionDecision {
    AllowOnce,
    AllowAlways,
    /// Deny-and-continue: `reason`, when present, is the user's steering
    /// text — folded into the synthetic tool result so the model is
    /// redirected instead of stalled on a bare refusal.
    Deny {
        reason: Option<String>,
    },
}

#[derive(Debug, Clone)]
pub enum EditDecision {
    /// Apply the edit. `merged_content`, when set, is the user-merged file
    /// body (per-hunk acceptance) — the agent loop swaps it in for the
    /// model's original `content` before invoking the write_file tool.
    Apply {
        merged_content: Option<String>,
    },
    Reject,
}

/// What a runner turn is asked to do.
///
/// R2b binds this to the session the runner already has state for: the loop
/// reads the resolved policy (provider, model, tool allowlist, permission
/// posture, MCP trust snapshot) from the session it is handed through
/// [`RuntimeServices`]. Moving that policy into the request is a later decision
/// (see the R2b decision record, ADR-2).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RunRequest {
    pub session_id: String,
}

/// Terminal outcome of one root turn.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RunOutcome {
    Completed {
        input_tokens: u64,
        output_tokens: u64,
    },
    Cancelled,
    Failed(String),
}

/// Outcome of a per-request budget admission check (R5b). `NotConfigured` is
/// the disabled path: no budget is set (or the journal is off), so the runner
/// takes no reservation and no settlement. `Reserved` means a durable
/// reservation now governs the request and MUST be settled or released.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BudgetAdmission {
    NotConfigured,
    Reserved,
}

/// The runtime-journal run a turn is bound to. Present only when the journal is
/// enabled and the session was prepared; the runner then persists checkpoints.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RuntimeRunBinding {
    pub run_id: String,
    pub epoch: i64,
}

/// Durable boundaries where typed history is persisted (runtime spec §4.1).
///
/// The runner writes one checkpoint per boundary. The order is: user turn
/// accepted, pre-request, tool intent, tool receipt, assistant receipt.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CheckpointBoundary {
    /// The user turn has been accepted into history, before any model call.
    UserTurnAccepted,
    /// A model request is about to be dispatched.
    PreRequest,
    /// A tool is about to run; its effect id is now pending.
    ToolIntent,
    /// A tool finished and its result is durably in history.
    ToolReceipt,
    /// A completed assistant turn is durably in history.
    AssistantReceipt,
}

impl CheckpointBoundary {
    pub fn as_str(self) -> &'static str {
        match self {
            CheckpointBoundary::UserTurnAccepted => "user_turn_accepted",
            CheckpointBoundary::PreRequest => "pre_request",
            CheckpointBoundary::ToolIntent => "tool_intent",
            CheckpointBoundary::ToolReceipt => "tool_receipt",
            CheckpointBoundary::AssistantReceipt => "assistant_receipt",
        }
    }
}

/// One durable checkpoint write from the runner. The store owns run identity,
/// compatibility hashes, sequence assignment, retention and redaction; the
/// runner only supplies the typed history and what is still pending.
#[derive(Debug, Clone)]
pub struct CheckpointWrite {
    pub boundary: CheckpointBoundary,
    /// Full typed history at this boundary (tool_use/tool_result pairing plus
    /// opaque provider reasoning), in order.
    pub messages: Vec<ChatMessage>,
    /// Effect ids whose receipt is not yet durable. Non-empty means the run has
    /// an unresolved effect and must be reconciled, never blind-replayed.
    pub pending_effect_ids: Vec<String>,
    /// True when the outcome is unknown/ambiguous (e.g. a tool ran but its
    /// receipt could not be committed).
    pub needs_reconciliation: bool,
}

/// Durable typed-history sink. Returned by [`RuntimeServices::checkpoints`] only
/// when the runtime journal is enabled and the turn is bound to a prepared run;
/// `None` means the runner takes its pre-journal path unchanged.
///
/// `persist` is async so a durable store can move its blocking write off the
/// runner's task (the Tauri store uses `spawn_blocking`). The runner still
/// `await`s it, so the boundary commit happens before it proceeds past that
/// boundary.
#[async_trait::async_trait]
pub trait CheckpointStore: Send + Sync {
    async fn persist(&self, write: &CheckpointWrite) -> Result<(), String>;
}

/// Immutable session binding read once at the start of a turn.
#[derive(Clone)]
pub struct RuntimeSession {
    pub provider: String,
    pub model: String,
    pub execution: ExecutionTarget,
    pub system_prompt: String,
    pub thinking_enabled: bool,
    pub allowed_tools: Option<Vec<String>>,
    pub enabled_mcp_server_ids: Option<Vec<String>>,
    pub mcp_trust_snapshot: Option<Vec<McpTrustSnapshot>>,
    pub custom_agents: Arc<Vec<CustomAgentDef>>,
    pub native_mcp_session: Arc<NativeMcpSession>,
    pub tasks: Arc<SessionTasks>,
    /// The frontend-supplied directional context window in tokens. `None`
    /// falls back to `context_window_tokens(provider, model)`.
    pub context_window_tokens: Option<u64>,
}

/// Per-iteration session flags (may flip mid-session).
#[derive(Clone)]
pub struct RuntimeFlags {
    pub plan_mode: bool,
    pub permission_mode: PermissionMode,
    pub approve_writes: bool,
}

/// Everything `execute_tool` needs from the turn's frozen session binding.
#[derive(Clone)]
pub struct ToolExecContext {
    pub provider: String,
    pub model: String,
    pub execution: ExecutionTarget,
    pub enabled_mcp_server_ids: Option<Vec<String>>,
    pub mcp_trust_snapshot: Option<Vec<McpTrustSnapshot>>,
    pub custom_agents: Arc<Vec<CustomAgentDef>>,
    pub native_mcp_session: Arc<NativeMcpSession>,
    pub tasks: Arc<SessionTasks>,
    pub frozen_tools: Arc<Vec<ToolDefinition>>,
}

/// Pending permission/edit prompt registration and response delivery.
#[async_trait::async_trait]
pub trait PermissionBroker {
    async fn register_permission(
        &self,
        session_id: &str,
        tool_id: &str,
    ) -> tokio::sync::oneshot::Receiver<PermissionDecision>;
    async fn remove_permission(&self, session_id: &str, tool_id: &str);
    async fn register_edit(
        &self,
        session_id: &str,
        tool_id: &str,
    ) -> tokio::sync::oneshot::Receiver<EditDecision>;
    async fn remove_edit(&self, session_id: &str, tool_id: &str);
    /// Drain every parked prompt for a session, denying edits/permissions.
    async fn deny_all_pending(&self, session_id: &str);
    async fn allow_tool_always(&self, session_id: &str, tool: &str);
    async fn is_tool_auto_allowed(&self, session_id: &str, tool: &str) -> bool;
}

/// Message history read/append for a session.
#[async_trait::async_trait]
pub trait HistoryStore {
    async fn history(&self, session_id: &str) -> Vec<ChatMessage>;
    async fn push_history(&self, session_id: &str, message: ChatMessage);
}

/// Flight attempt status and SSH transport cleanup.
#[async_trait::async_trait]
pub trait FlightStatusSink {
    async fn set_attempt_reviewing(&self, session_id: &str);
    async fn set_attempt_failed(&self, session_id: &str, message: String);
    async fn cancel_attempt(&self, session_id: &str) -> Result<(), String>;
    async fn drain_ssh(&self, session_id: &str) -> Result<(), String>;
}

/// The host surface the runner reaches for. One generic implementation serves
/// the live Tauri app; a fake serves the headless evaluation lane.
#[async_trait::async_trait]
pub trait RuntimeServices:
    PermissionBroker + HistoryStore + FlightStatusSink + Send + Sync
{
    fn events(&self) -> &dyn EventSink;
    fn load_api_key(&self, provider: &str) -> Result<String, String>;
    fn provider(&self, name: &str) -> Result<Box<dyn LlmProvider>, String>;
    fn ensure_usage_healthy(&self) -> Result<(), String>;
    async fn session(&self, session_id: &str) -> Result<RuntimeSession, String>;
    async fn flags(&self, session_id: &str) -> RuntimeFlags;
    async fn take_pending_attachments(&self, session_id: &str) -> Vec<ImageAttachment>;
    /// Whether the session has queued attachments, WITHOUT draining them. The
    /// runner checks this before persisting dispatch intent so a capability
    /// refusal (R4b) leaves no dispatch intent and does not consume the image.
    /// Required (no default) so a new host cannot silently disable the guard by
    /// forgetting to answer.
    async fn has_pending_attachments(&self, session_id: &str) -> bool;
    /// Non-draining COUNT of queued attachments. The R6 context projection needs
    /// only the number of images (each charged a flat `IMAGE_TOKEN_ESTIMATE`),
    /// so a refusal must never consume them: this reads the queue without
    /// draining it, keeping R4b's "nothing silently dropped" guarantee. Defaults
    /// to 0 for a host that never queues attachments.
    async fn pending_attachment_count(&self, _session_id: &str) -> usize {
        0
    }
    /// Whether the runtime authority (the journal) is enabled, which gates the
    /// R4b pre-dispatch capability guard. Defaults to `false`: when the feature
    /// is off the guard does not run and the disabled path is byte-identical to
    /// the pre-R4b behavior (runtime spec §3.1: guards apply "when the feature
    /// is enabled").
    fn capability_guard_enabled(&self) -> bool {
        false
    }
    /// The provider/model context window in tokens, or `None` when unknown. The
    /// default resolves it from the capability table; a host may override. The
    /// R6 context projection uses it to decide whether a request fits.
    fn context_window_tokens(&self, provider: &str, model: &str) -> Option<u64> {
        crate::core::runtime_capabilities::resolve_capabilities(provider, model, None)
            .context_window
            .value()
            .copied()
    }
    /// Record one context projection snapshot. The default is a no-op: a host
    /// that does not persist context accounting (or has the journal disabled)
    /// needs no override. The Tauri host writes to the `context_snapshots`
    /// table when the runtime journal is enabled.
    async fn record_context_snapshot(
        &self,
        _session_id: &str,
        _snapshot: &crate::core::runtime_context::ContextSnapshot,
    ) -> Result<(), String> {
        Ok(())
    }
    fn load_hooks(&self, execution: &ExecutionTarget) -> Vec<HookConfig>;
    async fn execute_tool(
        &self,
        session_id: &str,
        call: ToolCall,
        ctx: ToolExecContext,
    ) -> ToolResult;
    /// Account one streamed chunk. Returns `Some(actual_usd_micros)` exactly
    /// once, on the `Done` chunk for the request (after the raw usage row is
    /// durable), and `None` for every other chunk. The runner settles the
    /// journal reservation with the returned actual.
    fn account_request_chunk(
        &self,
        session_id: &str,
        provider: &str,
        model: &str,
        request_id: Option<&str>,
        chunk: &StreamChunk,
    ) -> Result<Option<i64>, String>;
    /// Admit a model request against the session's configured budget. Gated on
    /// a configured budget (scope key + limit): with none, or with the journal
    /// disabled, this is a no-op returning [`BudgetAdmission::NotConfigured`],
    /// so the disabled path is unchanged. The default is that no-op — a host
    /// that never sets a budget needs no override.
    async fn admit_request(
        &self,
        _session_id: &str,
        _request_id: &str,
        _provider: &str,
        _model: &str,
        _messages: &[ChatMessage],
        _max_tokens: u64,
    ) -> Result<BudgetAdmission, String> {
        Ok(BudgetAdmission::NotConfigured)
    }
    /// Settle a reservation with the exact actual cost. Default is a no-op for
    /// hosts that never reserve.
    async fn settle_request(
        &self,
        _session_id: &str,
        _request_id: &str,
        _actual_usd_micros: i64,
    ) -> Result<(), String> {
        Ok(())
    }
    /// Release a reservation that will not be settled (cancel, error, refusal
    /// after admission). Default is a no-op for hosts that never reserve. A host
    /// that reserved should also implement [`Self::mark_request_dispatched`] so
    /// a release of a dispatched request retains uncertain liability (R5).
    async fn release_request(&self, _session_id: &str, _request_id: &str) -> Result<(), String> {
        Ok(())
    }
    /// Mark a reserved request as actually dispatched to the provider, the
    /// moment it leaves for the network. Default is a no-op for hosts that never
    /// reserve. When set, a later release or a startup reconcile retains the
    /// reservation as uncertain liability instead of freeing headroom the
    /// provider may already have billed (R5).
    async fn mark_request_dispatched(
        &self,
        _session_id: &str,
        _request_id: &str,
    ) -> Result<(), String> {
        Ok(())
    }
    /// Durable checkpoint sink for this turn, or `None` when the runtime journal
    /// is disabled or the session is not bound to a prepared run. The default
    /// keeps the journal inert: the runner takes its pre-journal path.
    async fn checkpoints(&self, _session_id: &str) -> Option<Box<dyn CheckpointStore>> {
        None
    }
    fn now_ms(&self) -> i64 {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as i64)
            .unwrap_or(0)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn recording_sink_preserves_order_and_payload() {
        let sink = RecordingEventSink::new();
        sink.emit("chunk", json!({ "text": "a" }));
        sink.emit("done", json!({ "cancelled": false }));

        let events = sink.events();
        assert_eq!(events.len(), 2);
        assert_eq!(events[0].0, "chunk");
        assert_eq!(events[0].1, json!({ "text": "a" }));
        assert_eq!(events[1].0, "done");
    }

    #[test]
    fn run_outcome_is_comparable_for_fixtures() {
        assert_eq!(
            RunOutcome::Completed {
                input_tokens: 1,
                output_tokens: 2
            },
            RunOutcome::Completed {
                input_tokens: 1,
                output_tokens: 2
            }
        );
        assert_ne!(RunOutcome::Cancelled, RunOutcome::Failed("x".into()));
    }
}
