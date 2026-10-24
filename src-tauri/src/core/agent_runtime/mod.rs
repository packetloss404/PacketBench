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

#[cfg(test)]
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
    fn load_hooks(&self, execution: &ExecutionTarget) -> Vec<HookConfig>;
    async fn execute_tool(
        &self,
        session_id: &str,
        call: ToolCall,
        ctx: ToolExecContext,
    ) -> ToolResult;
    fn account_request_chunk(
        &self,
        session_id: &str,
        provider: &str,
        model: &str,
        chunk: &StreamChunk,
    ) -> Result<(), String>;
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
