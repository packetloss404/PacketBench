//! R1a runtime journal commands. Inert unless `PACKETBENCH_RUNTIME_JOURNAL=1`.
//! Nothing in the live agent loop calls these yet; they exist so the substrate
//! can be exercised and validated before integration.

use crate::core::runtime_capabilities::{self, RuntimeCapabilityView};
use crate::core::runtime_context::ContextSnapshot;
use crate::core::runtime_journal as journal;
use crate::core::runtime_types::{
    FrozenRuntimeLaunch, PrepareRuntimeRunInput, PrepareRuntimeRunResult, RuntimeContextProjection,
    RuntimeContextSummary, RuntimeEventView, RuntimeLaunchView, RuntimeRunSummary,
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

/// R4b: the capability readout for a provider/model. Compute-only — no journal
/// access and no provider dispatch — so it answers with the runtime journal
/// disabled. It grants no execution authority; the guard that actually refuses
/// an image is `runtime_capabilities::require_route_supports_images`, invoked
/// before dispatch by the runner (in-process) and the sidecar branch.
#[tauri::command]
pub fn get_runtime_capabilities(
    provider: String,
    model: String,
) -> Result<RuntimeCapabilityView, String> {
    Ok(runtime_capabilities::resolve_capabilities(&provider, &model, None).view())
}

/// R4b UX: whether the runtime guard is active. Read by the composer so an
/// image attach can be refused up front with an explanation rather than failing
/// at dispatch, and so the disabled path can stay byte-identical.
#[tauri::command]
pub fn get_runtime_guard_status() -> bool {
    journal::is_enabled()
}

/// R6 (H3) context/window readout. Returns the latest context projection
/// recorded for a run plus an honest window-policy disclosure. Read-only; with
/// the journal disabled it answers with no projection rather than erroring.
/// Never a provider quota, reset or dollar claim.
#[tauri::command]
pub async fn get_runtime_context_summary(run_id: String) -> Result<RuntimeContextSummary, String> {
    if !journal::is_enabled() {
        return Ok(summarize_context(
            &run_id,
            None,
            "The runtime journal is disabled, so no context projection is recorded.",
        ));
    }
    let run_id_for_query = run_id.clone();
    let snapshot = on_blocking(move || {
        journal::with_journal(|connection| {
            runtime_context::latest_context_snapshot(connection, &run_id_for_query)
                .map_err(String::from)
        })
    })
    .await?;
    Ok(summarize_context(&run_id, snapshot, ""))
}

/// Flatten a snapshot into the readout DTO and derive the honest window policy
/// note. Split out so the disclosure wording is unit-testable without a journal.
fn summarize_context(
    run_id: &str,
    snapshot: Option<ContextSnapshot>,
    disabled_note: &str,
) -> RuntimeContextSummary {
    let projection = snapshot.map(|s| RuntimeContextProjection {
        snapshot_id: s.snapshot_id,
        model_route: s.model_route,
        count_kind: s.count_kind,
        total_tokens: s.counts.total_tokens,
        window_tokens: s.window_tokens,
        reserved_output_tokens: s.reserved_output_tokens,
        safety_margin_tokens: s.safety_margin_tokens,
        blockers: s.blockers,
        created_at: s.created_at,
    });
    let window_known = projection.as_ref().and_then(|p| p.window_tokens).is_some();
    let policy_note = match &projection {
        None if !disabled_note.is_empty() => disabled_note.to_string(),
        None => "No context projection has been recorded for this run yet.".to_string(),
        Some(_) if window_known => {
            "Counts are a conservative byte/3 estimate, not a tokenizer. Dispatch is blocked \
             only when the estimate plus reserved output and margin exceeds the known window."
                .to_string()
        }
        Some(_) => "No model window is known for this route, so the projection could not block on \
             overflow. Counts are a conservative estimate, not a tokenizer."
            .to_string(),
    };
    RuntimeContextSummary {
        run_id: run_id.to_string(),
        projection,
        window_known,
        policy_note,
    }
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
use crate::commands::pricing;
use crate::core::agent_runtime::{
    BudgetAdmission, CheckpointBoundary, CheckpointStore, CheckpointWrite, EditDecision, EventSink,
    FlightStatusSink, HistoryStore, PermissionBroker, PermissionDecision, RuntimeFlags,
    RuntimeRunBinding, RuntimeServices, RuntimeSession, ToolExecContext,
};
use crate::core::execution::ExecutionTarget;
use crate::core::hooks::{self, HookConfig};
use crate::core::llm_provider::{get_provider, LlmProvider};
use crate::core::llm_types::{ChatMessage, ImageAttachment, StreamChunk, ToolCall, ToolResult};
use crate::core::runtime_budget::{
    self, BudgetError, BudgetScope, ReserveRequest, SettlementOutcome,
};
use crate::core::runtime_checkpoint::{
    self, Checkpoint, CheckpointClassification, CheckpointLimits, CompatibilityContext,
    CHECKPOINT_SCHEMA_VERSION, CHECKPOINT_TRANSPORT_VERSION,
};
use crate::core::runtime_context;
use crate::core::tool_runtime;
use crate::core::tool_runtime_ssh::SSH_TOOL_OWNER;
use crate::core::tool_subagent::{ChildBudgetHook, ParentLlm, PARENT_LLM};
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

    async fn has_pending_attachments(&self, session_id: &str) -> bool {
        self.state.runtime_has_attachments(session_id).await
    }

    async fn pending_attachment_count(&self, session_id: &str) -> usize {
        self.state
            .runtime_pending_attachment_count(session_id)
            .await
    }

    fn capability_guard_enabled(&self) -> bool {
        journal::is_enabled()
    }

    /// R6 context accounting. No-op unless the journal is enabled. The snapshot
    /// is nullable-by-run: a session with no run binding stores `(None, None)`
    /// rather than refusing, so context accounting still records when the run
    /// identity is unavailable.
    async fn record_context_snapshot(
        &self,
        session_id: &str,
        snapshot: &crate::core::runtime_context::ContextSnapshot,
    ) -> Result<(), String> {
        if !journal::is_enabled() {
            return Ok(());
        }
        let (run_id, epoch) = match self.state.runtime_run_binding(session_id).await {
            Some(binding) => (Some(binding.run_id), Some(binding.epoch)),
            None => (None, None),
        };
        let snapshot = snapshot.clone();
        on_blocking(move || {
            journal::with_journal(|connection| {
                runtime_context::insert_context_snapshot(
                    connection,
                    run_id.as_deref(),
                    epoch,
                    &snapshot,
                )
                .map_err(String::from)
            })
        })
        .await
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
            // R7: children reserve under this session's root budget scope on the
            // SAME journal path as the runner. With the journal OFF the hook is
            // absent, so the disabled path is byte-identical. With the journal
            // ON but no configured session budget the hook is present but only
            // adds one `runtime_session_budget` read and makes no reservation.
            child_budget: if journal::is_enabled() {
                Some(Arc::new(SessionChildBudget {
                    state: Arc::clone(&self.state),
                    session_id: session.clone(),
                }) as Arc<dyn ChildBudgetHook>)
            } else {
                None
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
        request_id: Option<&str>,
        chunk: &StreamChunk,
    ) -> Result<Option<i64>, String> {
        account_native_request_chunk(session_id, provider, model, request_id, chunk, |entry| {
            crate::commands::api_agent::record_completed_usage(&self.app_handle, entry)
        })
    }

    /// R5b admission. No-op unless the journal is enabled AND the session has a
    /// configured budget. The estimate is a conservative backend heuristic
    /// (`ceil(serialized bytes / 3)` input tokens plus the request's `max_tokens`
    /// output), priced through the shared table; an unpriced model is refused
    /// fail-closed rather than treated as free.
    async fn admit_request(
        &self,
        session_id: &str,
        request_id: &str,
        provider: &str,
        model: &str,
        messages: &[ChatMessage],
        max_tokens: u64,
    ) -> Result<BudgetAdmission, String> {
        admit_session_request(
            &self.state,
            session_id,
            request_id,
            provider,
            model,
            messages,
            max_tokens,
        )
        .await
    }

    /// Settle a reservation with the exact actual. A settle for a reservation
    /// that was never made is a bug, so `NotFound`/`Conflict` surface as errors;
    /// an overage is labelled with a warning.
    async fn settle_request(
        &self,
        _session_id: &str,
        request_id: &str,
        actual_usd_micros: i64,
    ) -> Result<(), String> {
        settle_reservation(request_id, actual_usd_micros).await
    }

    /// Best-effort release of an unsettled reservation. An absent reservation is
    /// ignored (release may race a settle); other errors surface. A request that
    /// was dispatched is retained as uncertain liability by the store.
    async fn release_request(&self, _session_id: &str, request_id: &str) -> Result<(), String> {
        release_reservation(request_id).await
    }

    /// Mark the reservation dispatched the instant the request leaves for the
    /// provider, so a later cancel/release or a crash retains uncertain
    /// liability rather than freeing headroom that may already be billed.
    async fn mark_request_dispatched(
        &self,
        _session_id: &str,
        request_id: &str,
    ) -> Result<(), String> {
        mark_reservation_dispatched(request_id).await
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

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// R5b admission, shared by the runner's per-request path and R7's child-request
/// hook. No-op unless the journal is enabled AND the session has a configured
/// budget. The estimate is a conservative backend heuristic
/// (`ceil(serialized bytes / 3)` input tokens plus the request's `max_tokens`
/// output), priced through the shared table; an unpriced model is refused
/// fail-closed rather than treated as free.
async fn admit_session_request(
    state: &ApiAgentState,
    session_id: &str,
    request_id: &str,
    provider: &str,
    model: &str,
    messages: &[ChatMessage],
    max_tokens: u64,
) -> Result<BudgetAdmission, String> {
    if !journal::is_enabled() {
        return Ok(BudgetAdmission::NotConfigured);
    }
    let Some((scope_key, limit_usd_micros)) = state.runtime_session_budget(session_id).await else {
        return Ok(BudgetAdmission::NotConfigured);
    };

    let serialized_chars: u64 = messages
        .iter()
        .map(|message| {
            serde_json::to_string(message)
                .map(|text| text.len() as u64)
                .unwrap_or(0)
        })
        .sum();
    let input_tokens = serialized_chars.div_ceil(3);
    let output_tokens = max_tokens;

    if pricing::pricing_for(model).is_none() {
        return Err(format!(
            "No price is known for provider \"{provider}\" model \"{model}\"; an unpriced request is refused while a budget is configured"
        ));
    }
    let cost = pricing::calculate_cost(model, input_tokens, output_tokens, 0, 0);
    let estimate_micros = (cost * 1_000_000.0).round() as i64;

    // A reservation is journalled against a run, so a budgeted request without
    // a run binding cannot be admitted. This is unreachable in practice (the
    // journal-enabled start path always binds a run), but it must fail closed
    // with a clear message rather than minting an identity.
    let (run_id, epoch) = match state.runtime_run_binding(session_id).await {
        Some(binding) => (binding.run_id, binding.epoch),
        None => {
            return Err(
                "Cannot admit a budgeted request: the session has no runtime run binding"
                    .to_string(),
            )
        }
    };
    let now = now_ms();
    let request_id = request_id.to_string();
    let provider = provider.to_string();
    let model = model.to_string();
    let scope = BudgetScope {
        scope_key,
        limit_usd_micros,
    };
    on_blocking(move || {
        journal::with_journal(|connection| {
            runtime_budget::reserve(
                connection,
                ReserveRequest {
                    request_id: &request_id,
                    run_id: &run_id,
                    epoch,
                    scope: &scope,
                    provider: &provider,
                    model: &model,
                    estimate_usd_micros: Some(estimate_micros),
                    now,
                },
            )
            .map(|_| ())
            .map_err(String::from)
        })
    })
    .await?;
    Ok(BudgetAdmission::Reserved)
}

/// Settle a reservation with the exact actual. A settle for a reservation that
/// was never made is a bug, so `NotFound`/`Conflict` surface as errors; an
/// overage is labelled with a warning.
async fn settle_reservation(request_id: &str, actual_usd_micros: i64) -> Result<(), String> {
    if !journal::is_enabled() {
        return Ok(());
    }
    let now = now_ms();
    let request_id_owned = request_id.to_string();
    let outcome = on_blocking(move || {
        journal::with_journal(|connection| {
            runtime_budget::settle(connection, &request_id_owned, actual_usd_micros, now)
                .map_err(String::from)
        })
    })
    .await?;
    if let SettlementOutcome::Overage {
        reserved_usd_micros,
        settled_usd_micros,
        overage_usd_micros,
    } = outcome
    {
        tracing::warn!(
            request_id = %request_id,
            reserved_usd_micros,
            settled_usd_micros,
            overage_usd_micros,
            "Budget request settled over its reservation; residual labelled by runtime_budget"
        );
    }
    Ok(())
}

/// Best-effort release of an unsettled reservation. An absent reservation is
/// ignored (release may race a settle); other errors surface.
async fn release_reservation(request_id: &str) -> Result<(), String> {
    if !journal::is_enabled() {
        return Ok(());
    }
    let now = now_ms();
    let request_id_owned = request_id.to_string();
    on_blocking(move || {
        journal::with_journal(|connection| {
            match runtime_budget::release(connection, &request_id_owned, now) {
                // Released (never dispatched) or Uncertain (dispatched; headroom
                // retained) are both successful outcomes for the caller.
                Ok(_outcome) => Ok(()),
                Err(BudgetError::NotFound { .. }) => Ok(()),
                Err(error) => Err(error.to_string()),
            }
        })
    })
    .await
}

/// Mark a reservation dispatched. No-op unless the runtime journal is enabled.
async fn mark_reservation_dispatched(request_id: &str) -> Result<(), String> {
    if !journal::is_enabled() {
        return Ok(());
    }
    let now = now_ms();
    let request_id_owned = request_id.to_string();
    on_blocking(move || {
        journal::with_journal(|connection| {
            runtime_budget::mark_dispatched(connection, &request_id_owned, now)
                .map_err(String::from)
        })
    })
    .await
}

/// Startup reconciliation of budget reservations stranded by the R5b crash
/// window (a crash between the usage-ledger append and the journal settle).
/// No-op unless the runtime journal is enabled. Reads the usage ledger, maps
/// each correlated `request_id` to its actual micro-dollars, and settles or
/// releases every stranded reservation. Safe only under the single-instance
/// guard (ADR-4). A ledger read/parse failure is surfaced, not swallowed —
/// reconciliation is best-effort at startup but must appear in the log.
pub fn reconcile_budget_on_startup() -> Result<(), String> {
    if !journal::is_enabled() {
        return Ok(());
    }
    let path = crate::commands::usage::usage_log_path()
        .ok_or_else(|| "Could not resolve usage ledger directory".to_string())?;
    let contents = crate::commands::usage::read_usage_ledger(&path)?.unwrap_or_default();
    let ledger = build_budget_ledger(&contents)?;
    let now = now_ms();
    let report = journal::with_journal(|connection| {
        runtime_budget::reconcile_reserved(connection, &ledger, now).map_err(String::from)
    })?;
    tracing::info!(
        settled = report.settled,
        released = report.released,
        uncertain = report.uncertain,
        "Reconciled stranded budget reservations on startup"
    );
    Ok(())
}

/// Build the `request_id -> actual micro-dollars` map reconciliation matches
/// reservations against. Rows without a `request_id` (parent native turns,
/// historical rows) are ignored; a malformed row is an error, never a silent
/// skip.
fn build_budget_ledger(contents: &str) -> Result<std::collections::HashMap<String, i64>, String> {
    let mut ledger: std::collections::HashMap<String, i64> = std::collections::HashMap::new();
    for (index, line) in contents.lines().enumerate() {
        if line.trim().is_empty() {
            continue;
        }
        let entry: crate::commands::usage::UsageEntry = serde_json::from_str(line)
            .map_err(|error| format!("Invalid usage row {}: {error}", index + 1))?;
        if let Some(request_id) = entry.request_id {
            ledger.insert(request_id, (entry.cost_usd * 1_000_000.0).round() as i64);
        }
    }
    Ok(ledger)
}

/// R7 child-request budget hook. Routes every child model request through the
/// SAME admission/settlement path as the parent's own requests, so a child
/// reserves against the parent session's root budget scope.
struct SessionChildBudget {
    state: Arc<ApiAgentState>,
    session_id: String,
}

#[async_trait::async_trait]
impl ChildBudgetHook for SessionChildBudget {
    async fn reserve(
        &self,
        request_id: &str,
        provider: &str,
        model: &str,
        messages: &[ChatMessage],
        max_tokens: u64,
    ) -> Result<bool, String> {
        match admit_session_request(
            &self.state,
            &self.session_id,
            request_id,
            provider,
            model,
            messages,
            max_tokens,
        )
        .await?
        {
            BudgetAdmission::Reserved => Ok(true),
            BudgetAdmission::NotConfigured => Ok(false),
        }
    }

    async fn settle(&self, request_id: &str, actual_usd_micros: i64) -> Result<(), String> {
        settle_reservation(request_id, actual_usd_micros).await
    }

    async fn release(&self, request_id: &str) -> Result<(), String> {
        release_reservation(request_id).await
    }

    async fn mark_dispatched(&self, request_id: &str) -> Result<(), String> {
        mark_reservation_dispatched(request_id).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn usage_row(request_id: Option<&str>, cost_usd: f64) -> String {
        serde_json::json!({
            "ts": "2026-09-24T12:00:00Z",
            "source": "test",
            "model": "gpt-5.5",
            "agent_id": null,
            "session_id": "s",
            "request_id": request_id,
            "input_tokens": 1,
            "output_tokens": 1,
            "cache_read": 0,
            "cache_write": 0,
            "cost_usd": cost_usd,
        })
        .to_string()
    }

    #[test]
    fn ledger_rows_without_a_request_id_are_ignored() {
        let contents = format!(
            "{}\n{}\n",
            usage_row(Some("req-1"), 0.25),
            usage_row(None, 9.0)
        );
        let ledger = build_budget_ledger(&contents).unwrap();
        assert_eq!(ledger.len(), 1);
        assert_eq!(ledger.get("req-1"), Some(&250_000));
    }

    #[test]
    fn a_corrupt_ledger_row_is_an_error_not_a_silent_skip() {
        assert!(build_budget_ledger("not json\n").is_err());
    }

    #[test]
    fn a_corrupt_temp_ledger_fails_the_read_gate_without_panicking() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("usage.jsonl");
        std::fs::write(&path, "not json\n").unwrap();
        assert!(crate::commands::usage::read_usage_ledger(&path).is_err());
    }

    #[test]
    fn summarize_context_discloses_unknown_windows_and_no_projection() {
        // No projection recorded.
        let none = summarize_context("run-1", None, "");
        assert!(none.projection.is_none());
        assert!(!none.window_known);
        assert!(none.policy_note.contains("No context projection"));

        // A disabled-journal note is used verbatim when supplied.
        let disabled = summarize_context("run-1", None, "journal disabled");
        assert_eq!(disabled.policy_note, "journal disabled");

        // A projection with a known window.
        let snapshot = crate::core::runtime_context::project_context(
            "fake:model",
            "system",
            &[],
            &[],
            0,
            Some(1_000_000),
            16384,
            0,
            5,
        );
        let known = summarize_context("run-1", Some(snapshot.clone()), "");
        assert!(known.window_known);
        assert_eq!(
            known.projection.as_ref().unwrap().window_tokens,
            Some(1_000_000)
        );
        assert!(known.policy_note.contains("blocked only when"));

        // The same projection with an unknown window never claims a block.
        let mut unknown_snapshot = snapshot;
        unknown_snapshot.window_tokens = None;
        let unknown = summarize_context("run-1", Some(unknown_snapshot), "");
        assert!(!unknown.window_known);
        assert!(unknown.policy_note.contains("could not block"));
    }
}
