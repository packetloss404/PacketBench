//! R1a runtime journal commands. Inert unless `PACKETBENCH_RUNTIME_JOURNAL=1`.
//! Nothing in the live agent loop calls these yet; they exist so the substrate
//! can be exercised and validated before integration.

use crate::core::runtime_journal as journal;
use crate::core::runtime_types::{
    FrozenRuntimeLaunch, PrepareRuntimeRunInput, PrepareRuntimeRunResult, RuntimeEventView,
    RuntimeLaunchView, RuntimeRunSummary,
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

// --- R3b: resume. `inspect` is read-only (no dispatch); `resume` advances the
// durable epoch and does NOT start the provider. Both are inert unless the
// journal is enabled, and both are registered in `lib.rs`.

#[tauri::command]
pub async fn inspect_runtime_resume(run_id: String) -> Result<journal::ResumeInspection, String> {
    on_blocking(move || {
        journal::with_journal(|connection| journal::inspect_resume(connection, &run_id))
    })
    .await
}

#[tauri::command]
pub async fn resume_runtime_run(
    run_id: String,
    expected_epoch: i64,
    mode: String,
    inspected_revision: Option<String>,
) -> Result<RuntimeRunSummary, String> {
    on_blocking(move || {
        journal::with_journal(|connection| {
            journal::resume_run(
                connection,
                &run_id,
                expected_epoch,
                &mode,
                inspected_revision.as_deref(),
            )
        })
    })
    .await
}

/// Bind a freshly prepared runtime run to a session when the journal is enabled.
/// Returns `Ok(None)` (a no-op) when the journal is off, so the disabled path is
/// byte-identical to today. A journal failure is surfaced, not swallowed.
pub async fn prepare_session_run(
    session_id: &str,
    provider: &str,
    model: &str,
    project_path: &str,
) -> Result<Option<RuntimeRunBinding>, String> {
    if !journal::is_enabled() {
        return Ok(None);
    }
    let operation_id = format!("op-{}-{}", session_id, Uuid::new_v4());
    let request_digest = runtime_checkpoint::hash_payload(&format!(
        "{}:{}:{}:{}",
        session_id, provider, model, project_path
    ));
    let conversation_id = session_id.to_string();
    let draft_id = session_id.to_string();
    let route = provider.to_string();
    let model = model.to_string();
    let project_key = format!("local:{}", project_path);
    let base_path = project_path.to_string();
    let result = on_blocking(move || {
        journal::with_journal(|connection| {
            // A conversation that already has a durable owner is a restart or a
            // follow-up turn: it must prepare as `existing`, which allocates a
            // new run linked to the prior root run via `previous_run_id`.
            // `initial` is only valid for a conversation that has never been
            // journaled — `prepare_operation` rejects a second `initial` for an
            // already-owned conversation, which used to abort every restart.
            let kind = if journal::conversation_has_owner(connection, &conversation_id)? {
                "existing"
            } else {
                "initial"
            };
            let input = PrepareRuntimeRunInput {
                operation_id,
                conversation_id,
                kind: kind.to_string(),
                retry_of_operation_id: None,
                request_digest,
                launch: FrozenRuntimeLaunch {
                    route,
                    model,
                    requested_isolation: "checkout".to_string(),
                    draft_id,
                    draft_revision: "1".to_string(),
                    project_key,
                    base_path,
                },
            };
            journal::prepare_operation(connection, &input)
        })
    })
    .await?;
    Ok(Some(RuntimeRunBinding {
        run_id: result.run_id,
        epoch: result.epoch,
    }))
}

/// Derive the checkpoint compatibility identity from a frozen session binding.
///
/// The policy hashes are computed here and *stored* in each checkpoint at write
/// time. The resume path, however, only has the durable `frozen_input` (route,
/// model, project), which does **not** record `allowed_tools` or the MCP trust
/// snapshot — so it cannot reconstruct these hashes. Resume therefore refuses
/// typed replay fail-closed rather than claiming an unverified policy match
/// (see `runtime_checkpoint::check_resumable_typed`). Only when a full
/// [`CompatibilityContext`] can be supplied is `validate_compatibility` run.
fn checkpoint_compatibility(session: &RuntimeSession) -> CompatibilityContext {
    let model_route = format!("{}:{}", session.provider, session.model);
    let manifest_hash = runtime_checkpoint::hash_payload(&format!(
        "{}:{}:{}",
        session.provider,
        session.model,
        session.execution.label()
    ));
    let tool_policy = match &session.allowed_tools {
        Some(list) => {
            let mut sorted = list.clone();
            sorted.sort();
            sorted.join(",")
        }
        None => "*".to_string(),
    };
    let mcp = match &session.mcp_trust_snapshot {
        Some(snapshot) => serde_json::to_string(snapshot).unwrap_or_default(),
        None => String::new(),
    };
    CompatibilityContext {
        schema_version: CHECKPOINT_SCHEMA_VERSION,
        transport_version: CHECKPOINT_TRANSPORT_VERSION,
        model_route,
        manifest_hash,
        tool_policy_hash: runtime_checkpoint::hash_payload(&tool_policy),
        mcp_hash: runtime_checkpoint::hash_payload(&mcp),
    }
}

/// Durable checkpoint sink backed by the runtime journal. Bound to one run and
/// one compatibility context; assigns sequence numbers and enforces retention.
pub struct JournalCheckpointStore {
    binding: RuntimeRunBinding,
    compatibility: CompatibilityContext,
}

impl JournalCheckpointStore {
    pub fn new(binding: RuntimeRunBinding, compatibility: CompatibilityContext) -> Self {
        Self {
            binding,
            compatibility,
        }
    }
}

#[async_trait::async_trait]
impl CheckpointStore for JournalCheckpointStore {
    async fn persist(&self, write: &CheckpointWrite) -> Result<(), String> {
        let binding = self.binding.clone();
        let compatibility = self.compatibility.clone();
        let messages = write.messages.clone();
        let pending_effect_ids = write.pending_effect_ids.clone();
        let needs_reconciliation = write.needs_reconciliation;
        let boundary = write.boundary;
        // The runner awaits this future, so the boundary checkpoint is committed
        // (or its failure surfaced) before the runner proceeds past the boundary.
        // The blocking SQLite write runs on a dedicated worker so it never
        // stalls the async runner task.
        on_blocking(move || {
            journal::with_journal(move |connection| {
                let seq = runtime_checkpoint::next_checkpoint_seq(
                    connection,
                    &binding.run_id,
                    binding.epoch,
                )
                .map_err(String::from)?;
                let now = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map(|d| d.as_millis() as i64)
                    .unwrap_or(0);
                let checkpoint = Checkpoint {
                    checkpoint_id: Uuid::new_v4().to_string(),
                    run_id: binding.run_id.clone(),
                    epoch: binding.epoch,
                    seq,
                    schema_version: compatibility.schema_version,
                    transport_version: compatibility.transport_version,
                    model_route: compatibility.model_route.clone(),
                    manifest_hash: compatibility.manifest_hash.clone(),
                    tool_policy_hash: compatibility.tool_policy_hash.clone(),
                    mcp_hash: compatibility.mcp_hash.clone(),
                    pending_effect_ids,
                    classification: CheckpointClassification::Private,
                    messages,
                    created_at: now,
                };
                let encoded = runtime_checkpoint::encode(&checkpoint, &CheckpointLimits::default())
                    .map_err(String::from)?;
                runtime_checkpoint::store_checkpoint(
                    connection,
                    &encoded,
                    &CheckpointLimits::default(),
                )
                .map_err(String::from)?;
                if needs_reconciliation {
                    journal::mark_run_needs_reconciliation(connection, &binding.run_id)?;
                } else if boundary == CheckpointBoundary::UserTurnAccepted {
                    connection
                        .execute(
                            "UPDATE runs SET state = 'running' WHERE run_id = ?1",
                            rusqlite::params![binding.run_id],
                        )
                        .map_err(|e| format!("Failed to mark run running: {e}"))?;
                }
                Ok(())
            })
        })
        .await
    }
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
    CheckpointBoundary, CheckpointStore, CheckpointWrite, EditDecision, EventSink,
    FlightStatusSink, HistoryStore, PermissionBroker, PermissionDecision, RuntimeFlags,
    RuntimeRunBinding, RuntimeServices, RuntimeSession, ToolExecContext,
};
use crate::core::execution::ExecutionTarget;
use crate::core::hooks::{self, HookConfig};
use crate::core::llm_provider::{get_provider, LlmProvider};
use crate::core::llm_types::{ChatMessage, ImageAttachment, StreamChunk, ToolCall, ToolResult};
use crate::core::runtime_checkpoint::{
    self, Checkpoint, CheckpointClassification, CheckpointLimits, CompatibilityContext,
    CHECKPOINT_SCHEMA_VERSION, CHECKPOINT_TRANSPORT_VERSION,
};
use crate::core::tool_runtime;
use crate::core::tool_runtime_ssh::SSH_TOOL_OWNER;
use crate::core::tool_subagent::{ParentLlm, PARENT_LLM};
use uuid::Uuid;

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

    /// The real store only when the journal is enabled AND this session is bound
    /// to a prepared run; otherwise `None`, which keeps the runner on its exact
    /// pre-journal path.
    async fn checkpoints(&self, session_id: &str) -> Option<Box<dyn CheckpointStore>> {
        if !journal::is_enabled() {
            return None;
        }
        let binding = self.state.runtime_run_binding(session_id).await?;
        let session = self.state.runtime_session(session_id).await?;
        Some(Box::new(JournalCheckpointStore::new(
            binding,
            checkpoint_compatibility(&session),
        )))
    }
}
