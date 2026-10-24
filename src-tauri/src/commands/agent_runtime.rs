//! R1a runtime journal commands. Inert unless `PACKETBENCH_RUNTIME_JOURNAL=1`.
//! Nothing in the live agent loop calls these yet; they exist so the substrate
//! can be exercised and validated before integration.

use crate::core::runtime_journal as journal;
use crate::core::runtime_types::{
    PrepareRuntimeRunInput, PrepareRuntimeRunResult, RuntimeEventView, RuntimeLaunchView,
    RuntimeRunSummary,
};

async fn on_blocking<T: Send + 'static>(
    work: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    tokio::task::spawn_blocking(work)
        .await
        .map_err(|e| format!("Runtime journal task failed: {e}"))?
}

#[tauri::command]
pub async fn prepare_runtime_run(
    input: PrepareRuntimeRunInput,
) -> Result<PrepareRuntimeRunResult, String> {
    on_blocking(move || {
        journal::with_journal(|connection| journal::prepare_operation(connection, &input))
    })
    .await
}

#[tauri::command]
pub async fn get_runtime_launch(operation_id: String) -> Result<RuntimeLaunchView, String> {
    on_blocking(move || {
        journal::with_journal(|connection| journal::get_operation(connection, &operation_id))
    })
    .await
}

#[tauri::command]
pub async fn get_runtime_run(run_id: String) -> Result<RuntimeRunSummary, String> {
    on_blocking(move || journal::with_journal(|connection| journal::get_run(connection, &run_id)))
        .await
}

#[tauri::command]
pub async fn list_runtime_events(
    run_id: String,
    after_seq: i64,
    limit: i64,
) -> Result<Vec<RuntimeEventView>, String> {
    on_blocking(move || {
        journal::with_journal(|connection| {
            journal::list_events(connection, &run_id, after_seq, limit)
        })
    })
    .await
}

#[tauri::command]
pub async fn cancel_runtime_run(
    operation_id: String,
    expected_epoch: i64,
) -> Result<RuntimeLaunchView, String> {
    on_blocking(move || {
        journal::with_journal(|connection| {
            journal::cancel_operation(connection, &operation_id, expected_epoch)
        })
    })
    .await
}

// --- R2b: Tauri implementation of the runner seam. Every method delegates to
// the existing `ApiAgentState`, keyring, provider registry, native MCP session,
// Flight status and hooks; no loop logic lives here.

use std::sync::Arc;

use serde_json::Value;
use tauri::{AppHandle, Emitter};
use tokio::sync::oneshot;

use crate::commands::api_agent::{
    account_native_request_chunk, mark_attempt_failed_for_session,
    mark_attempt_reviewing_for_session, record_child_usage, ApiAgentState,
};
use crate::commands::api_keys;
use crate::core::agent_runtime::{
    EditDecision, EventSink, FlightStatusSink, HistoryStore, PermissionBroker, PermissionDecision,
    RuntimeFlags, RuntimeServices, RuntimeSession, ToolExecContext,
};
use crate::core::execution::ExecutionTarget;
use crate::core::hooks::{self, HookConfig};
use crate::core::llm_provider::{get_provider, LlmProvider};
use crate::core::llm_types::{ChatMessage, ImageAttachment, StreamChunk, ToolCall, ToolResult};
use crate::core::tool_runtime;
use crate::core::tool_runtime_ssh::SSH_TOOL_OWNER;
use crate::core::tool_subagent::{ParentLlm, PARENT_LLM};

/// Forwards runner events to the Tauri event bus verbatim.
struct TauriEventSink {
    app: AppHandle,
}

impl EventSink for TauriEventSink {
    fn emit(&self, kind: &str, payload: Value) {
        let _ = self.app.emit(kind, payload);
    }
}

/// Live-app host for the agent runner.
pub struct TauriRuntimeServices {
    app_handle: AppHandle,
    state: Arc<ApiAgentState>,
    events: TauriEventSink,
}

impl TauriRuntimeServices {
    pub fn new(app_handle: AppHandle, state: Arc<ApiAgentState>) -> Self {
        Self {
            events: TauriEventSink {
                app: app_handle.clone(),
            },
            app_handle,
            state,
        }
    }
}

#[async_trait::async_trait]
impl PermissionBroker for TauriRuntimeServices {
    async fn register_permission(
        &self,
        session_id: &str,
        tool_id: &str,
    ) -> oneshot::Receiver<PermissionDecision> {
        self.state
            .runtime_register_permission(session_id, tool_id)
            .await
    }

    async fn remove_permission(&self, session_id: &str, tool_id: &str) {
        self.state
            .runtime_remove_permission(session_id, tool_id)
            .await
    }

    async fn register_edit(
        &self,
        session_id: &str,
        tool_id: &str,
    ) -> oneshot::Receiver<EditDecision> {
        self.state.runtime_register_edit(session_id, tool_id).await
    }

    async fn remove_edit(&self, session_id: &str, tool_id: &str) {
        self.state.runtime_remove_edit(session_id, tool_id).await
    }

    async fn deny_all_pending(&self, session_id: &str) {
        self.state.runtime_deny_all_pending(session_id).await
    }

    async fn allow_tool_always(&self, session_id: &str, tool: &str) {
        self.state.runtime_allow_tool_always(session_id, tool).await
    }

    async fn is_tool_auto_allowed(&self, session_id: &str, tool: &str) -> bool {
        self.state
            .runtime_is_tool_auto_allowed(session_id, tool)
            .await
    }
}

#[async_trait::async_trait]
impl HistoryStore for TauriRuntimeServices {
    async fn history(&self, session_id: &str) -> Vec<ChatMessage> {
        self.state.runtime_history(session_id).await
    }

    async fn push_history(&self, session_id: &str, message: ChatMessage) {
        self.state.runtime_push_history(session_id, message).await
    }
}

#[async_trait::async_trait]
impl FlightStatusSink for TauriRuntimeServices {
    async fn set_attempt_reviewing(&self, session_id: &str) {
        mark_attempt_reviewing_for_session(session_id).await
    }

    async fn set_attempt_failed(&self, session_id: &str, message: String) {
        mark_attempt_failed_for_session(session_id, message).await
    }

    async fn cancel_attempt(&self, session_id: &str) -> Result<(), String> {
        crate::commands::flight_attempts::cancel_builder_attempt_for_session(session_id)
            .await
            .map(|_| ())
    }

    async fn drain_ssh(&self, session_id: &str) -> Result<(), String> {
        crate::core::tool_runtime_ssh::drain_session(session_id).await
    }
}

#[async_trait::async_trait]
impl RuntimeServices for TauriRuntimeServices {
    fn events(&self) -> &dyn EventSink {
        &self.events
    }

    fn load_api_key(&self, provider: &str) -> Result<String, String> {
        api_keys::load_api_key(provider)
    }

    fn provider(&self, name: &str) -> Result<Box<dyn LlmProvider>, String> {
        get_provider(name)
    }

    fn ensure_usage_healthy(&self) -> Result<(), String> {
        crate::commands::usage::ensure_usage_accounting_healthy()
    }

    async fn session(&self, session_id: &str) -> Result<RuntimeSession, String> {
        self.state
            .runtime_session(session_id)
            .await
            .ok_or_else(|| format!("No session config: {}", session_id))
    }

    async fn flags(&self, session_id: &str) -> RuntimeFlags {
        self.state.runtime_flags(session_id).await
    }

    async fn take_pending_attachments(&self, session_id: &str) -> Vec<ImageAttachment> {
        self.state.runtime_take_attachments(session_id).await
    }

    fn load_hooks(&self, execution: &ExecutionTarget) -> Vec<HookConfig> {
        let project_path = match execution {
            ExecutionTarget::Local { project_path } => project_path.clone(),
            _ => String::new(),
        };
        hooks::load_hooks_with_project(&project_path)
    }

    async fn execute_tool(
        &self,
        session_id: &str,
        call: ToolCall,
        ctx: ToolExecContext,
    ) -> ToolResult {
        let app = self.app_handle.clone();
        let session = session_id.to_string();
        let parent_llm = ParentLlm {
            provider: ctx.provider.clone(),
            model: ctx.model.clone(),
            tools: Arc::clone(&ctx.frozen_tools),
            custom_agents: Arc::clone(&ctx.custom_agents),
            enabled_mcp_server_ids: ctx.enabled_mcp_server_ids.clone(),
            mcp_trust_snapshot: ctx.mcp_trust_snapshot.clone(),
            native_mcp_session: Arc::clone(&ctx.native_mcp_session),
            tasks: Arc::clone(&ctx.tasks),
            record_usage: {
                let app = app.clone();
                let session = session.clone();
                Arc::new(move |usage| record_child_usage(&app, &session, usage))
            },
        };
        let execution = ctx.execution.clone();
        let enabled = ctx.enabled_mcp_server_ids.clone();
        let trust = ctx.mcp_trust_snapshot.clone();
        PARENT_LLM
            .scope(
                parent_llm,
                SSH_TOOL_OWNER.scope(
                    session.clone(),
                    tool_runtime::execute_tool_with_mcp_trust(
                        &call,
                        &execution,
                        enabled.as_deref(),
                        trust.as_deref(),
                    ),
                ),
            )
            .await
    }

    fn account_request_chunk(
        &self,
        session_id: &str,
        provider: &str,
        model: &str,
        chunk: &StreamChunk,
    ) -> Result<(), String> {
        account_native_request_chunk(session_id, provider, model, chunk, |entry| {
            crate::commands::api_agent::record_completed_usage(&self.app_handle, entry)
        })
    }
}
