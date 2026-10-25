//! The production agent turn loop, extracted behind [`RuntimeServices`].
//!
//! `run_turn` is the same request→tool→repeat loop that used to live in
//! `commands::api_agent::run_agent_loop`. The Tauri app drives it through
//! `TauriRuntimeServices`; a fake can drive it in tests. Event names/payloads,
//! gate semantics and error strings are unchanged.

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use serde::Serialize;
use serde_json::Value;
use tokio::sync::{mpsc, oneshot};
use tracing::{info, warn};

use uuid::Uuid;

use crate::core::agent_runtime::{
    BudgetAdmission, CheckpointBoundary, CheckpointStore, CheckpointWrite, EditDecision,
    PermissionDecision, PermissionMode, RunOutcome, RunRequest, RuntimeServices, ToolExecContext,
};
use crate::core::execution::ExecutionTarget;
use crate::core::hooks::{self, HookConfig, HookEvent};
use crate::core::llm_types::*;
use crate::core::runtime_capabilities;
use crate::core::runtime_context;
use crate::core::tool_runtime;

/// Maximum number of tool-use loop iterations per turn. Set high so a real
/// task runs to completion in one turn (like Cursor / Claude Code) instead of
/// hitting the cap mid-task and forcing the user to hit "Continue". Still
/// bounded to backstop a genuinely runaway agent.
const MAX_TOOL_ITERATIONS: usize = 150;

/// Output token budget requested from the provider. Shared by the R6 context
/// projection's `reservedOutputTokens`, the R5b admission `maxTokens` and the
/// `LlmRequest` itself so they cannot drift.
pub(crate) const MAX_OUTPUT_TOKENS: u64 = 16384;

/// Tools that require user permission in `AskForRisky` mode and are refused
/// outright in `DenyAll`. `create_pull_request` pushes the branch and opens a
/// PR under the user's GitHub identity — an outward-facing side effect that
/// must never run on the model's authority alone.
pub(crate) const RISKY_TOOLS: &[&str] = &["bash", "write_file", "edit_file", "create_pull_request"];
/// The only tools allowed while plan mode is active — read-only ones.
pub(crate) const PLAN_MODE_ALLOWED: &[&str] = &["read_file", "list_directory", "grep"];
/// Tools that mutate file content and therefore must go through the
/// pending-edit approval gate (and emit a pre-edit baseline when the gate is
/// off). Every entry here must also be in [`RISKY_TOOLS`].
pub(crate) const EDIT_TOOLS: &[&str] = &["write_file", "edit_file"];

// Event name helpers
fn chunk_event(session_id: &str) -> String {
    format!("api-agent:chunk:{}", session_id)
}
fn tool_start_event(session_id: &str) -> String {
    format!("api-agent:tool-start:{}", session_id)
}
fn tool_result_event(session_id: &str) -> String {
    format!("api-agent:tool-result:{}", session_id)
}
fn done_event(session_id: &str) -> String {
    format!("api-agent:done:{}", session_id)
}
pub(crate) fn error_event(session_id: &str) -> String {
    format!("api-agent:error:{}", session_id)
}
fn thinking_event(session_id: &str) -> String {
    format!("api-agent:thinking:{}", session_id)
}
fn thinking_stop_event(session_id: &str) -> String {
    format!("api-agent:thinking-stop:{}", session_id)
}
fn permission_request_event(session_id: &str) -> String {
    format!("api-agent:permission-request:{}", session_id)
}
fn pending_edit_event(session_id: &str) -> String {
    format!("api-agent:pending-edit:{}", session_id)
}
fn edit_baseline_event(session_id: &str) -> String {
    format!("api-agent:edit-baseline:{}", session_id)
}

fn emit<R: RuntimeServices, P: Serialize>(services: &R, event: &str, payload: P) {
    services
        .events()
        .emit(event, serde_json::to_value(payload).unwrap_or(Value::Null));
}

#[derive(Clone, Serialize)]
struct ToolStartPayload {
    id: String,
    name: String,
}

#[derive(Clone, Serialize)]
struct PermissionRequestPayload {
    id: String,
    name: String,
    arguments: String,
}

#[derive(Clone, Serialize)]
struct PendingEditPayload {
    id: String,
    path: String,
    content: String,
    /// Prior file content (None for new files) so the frontend can render
    /// a real before/after diff instead of just the new content.
    #[serde(skip_serializing_if = "Option::is_none")]
    before: Option<String>,
}

/// P1-7: non-blocking pre-edit baseline for auto-applied writes
/// (approve-writes off). The frontend records it so review surfaces diff
/// applied edits against the true "before" instead of live disk.
#[derive(Clone, Serialize)]
struct EditBaselinePayload {
    id: String,
    path: String,
    /// Pre-edit file content (None when the file did not exist).
    #[serde(skip_serializing_if = "Option::is_none")]
    before: Option<String>,
}

#[derive(Clone, Serialize)]
struct ThinkingPayload {
    text: String,
}

#[derive(Clone, Serialize)]
struct ToolResultPayload {
    id: String,
    name: String,
    content: String,
    is_error: bool,
    input: String,
}

#[derive(Clone, Serialize)]
struct DonePayload {
    input_tokens: u64,
    output_tokens: u64,
    cache_read_input_tokens: u64,
    cache_creation_input_tokens: u64,
    cancelled: bool,
}

#[derive(Clone, Serialize)]
pub(crate) struct ErrorPayload {
    pub(crate) message: String,
}

/// CE6 instrumentation — one line per LLM round trip recording the cache mix.
///
/// `hit` = cache reads as a share of all input-side tokens. It is
/// rate-independent, so it survives a stale pricing table and is the acceptance
/// signal for prompt caching (see `dev/cost-efficiency-loop.md`). Anthropic's
/// buckets are disjoint; OpenAI reports `read` as a subset of `input`, which
/// `pricing::billable_input_tokens` normalises at the cost call site.
fn log_cache_usage(
    session_id: &str,
    model: &str,
    iteration: usize,
    input_tokens: u64,
    cache_read: u64,
    cache_write: u64,
) {
    let denominator = input_tokens
        .saturating_add(cache_read)
        .saturating_add(cache_write);
    if denominator == 0 {
        return;
    }
    let hit = cache_read as f64 / denominator as f64;
    tracing::info!(
        target: "packetbench::cache",
        session_id = %session_id,
        model = %model,
        iteration,
        input_tokens,
        cache_read,
        cache_write,
        hit_rate = format!("{:.3}", hit),
        "CE6-CACHE: prompt-cache mix for one request"
    );
}

pub(crate) fn build_assistant_history_message(
    text_content: &str,
    tool_calls: &[ToolCall],
    provider_reasoning: Option<serde_json::Value>,
) -> Option<ChatMessage> {
    // A turn with neither text nor a tool call is skipped even when the
    // provider sent reasoning: replaying reasoning alone would produce an
    // assistant message with empty content, which the APIs reject.
    if tool_calls.is_empty() && text_content.trim().is_empty() {
        return None;
    }

    if tool_calls.is_empty() && provider_reasoning.is_none() {
        return Some(ChatMessage {
            role: ChatRole::Assistant,
            content: MessageContent::text(text_content),
        });
    }

    let mut blocks = Vec::new();
    // Reasoning leads the block list so it is replayed ahead of the content it
    // produced, matching the order the provider streamed it.
    if let Some(details) = provider_reasoning {
        blocks.push(ContentBlock::ProviderReasoning { details });
    }
    if !text_content.is_empty() {
        blocks.push(ContentBlock::Text {
            text: text_content.to_string(),
        });
    }
    for tc in tool_calls {
        blocks.push(ContentBlock::ToolUse {
            id: tc.id.clone(),
            name: tc.name.clone(),
            arguments: tc.arguments.clone(),
        });
    }

    Some(ChatMessage {
        role: ChatRole::Assistant,
        content: MessageContent::Blocks(blocks),
    })
}

/// Account each completed provider request before its tools or the next request
/// can run. Terminal events do not write aggregate rows, preventing duplicates.
pub(crate) fn require_provider_completion(
    completed: bool,
    result: Result<(), String>,
) -> Result<(), String> {
    result?;
    if !completed {
        return Err("Provider stream ended before its completion and usage marker; this request is incomplete".into());
    }
    Ok(())
}

/// Best-effort release of a budget reservation that will not be settled.
/// Errors are logged and never allowed to mask the original failure; the
/// pending flag is cleared first so no later path can double-release.
async fn release_pending_reservation<R: RuntimeServices>(
    services: &R,
    session_id: &str,
    request_id: &str,
    pending: &mut bool,
) {
    if !*pending {
        return;
    }
    *pending = false;
    if let Err(error) = services.release_request(session_id, request_id).await {
        warn!(
            session_id = %session_id,
            request_id = %request_id,
            error = %error,
            "Failed to release a budget reservation; the request stays reserved"
        );
    }
}

/// Persist one durable checkpoint when the journal is active. A `None` store is
/// the disabled-journal path: this is a no-op and the runner behaves exactly as
/// it did before R3b. A store error is propagated so a failed durable commit
/// blocks continuation rather than degrading into a best-effort log.
async fn persist_checkpoint(
    store: Option<&dyn CheckpointStore>,
    boundary: CheckpointBoundary,
    messages: &[ChatMessage],
    pending_effect_ids: Vec<String>,
    needs_reconciliation: bool,
) -> Result<(), String> {
    match store {
        None => Ok(()),
        Some(store) => {
            store
                .persist(&CheckpointWrite {
                    boundary,
                    messages: messages.to_vec(),
                    pending_effect_ids,
                    needs_reconciliation,
                })
                .await
        }
    }
}

/// Persist a checkpoint from the session's current history. The history read is
/// skipped entirely when the journal is disabled, so the disabled path adds no
/// work beyond the `checkpoints()` probe.
async fn persist_current_history<R: RuntimeServices>(
    services: &R,
    store: Option<&dyn CheckpointStore>,
    session_id: &str,
    boundary: CheckpointBoundary,
    pending_effect_ids: Vec<String>,
    needs_reconciliation: bool,
) -> Result<(), String> {
    let Some(store) = store else {
        return Ok(());
    };
    let messages = services.history(session_id).await;
    store
        .persist(&CheckpointWrite {
            boundary,
            messages,
            pending_effect_ids,
            needs_reconciliation,
        })
        .await
}

pub(crate) fn tool_is_advertised(name: &str, tools: &[ToolDefinition]) -> bool {
    tools.iter().any(|tool| tool.name == name)
}

pub(crate) fn filter_tools_for_execution(
    tools: &mut Vec<ToolDefinition>,
    execution: &ExecutionTarget,
) {
    if matches!(execution, ExecutionTarget::Ssh { .. }) {
        // Remote editing has no supported preview/apply implementation. Offer
        // read_file + write_file, which use the pinned SSH execution target.
        tools.retain(|tool| tool.name != "edit_file");
    }
}

/// Fire all SessionEnd hooks (best-effort; failures logged).
async fn fire_session_end_hooks(hooks_list: &[HookConfig], session_id: &str) {
    for hook in hooks_list
        .iter()
        .filter(|h| h.event == HookEvent::SessionEnd)
    {
        let payload = serde_json::json!({
            "session_id": session_id,
            "event": "SessionEnd",
        });
        if let Err(e) = hooks::run_hook(hook, payload).await {
            warn!(session_id = %session_id, error = %e, "SessionEnd hook failed");
        }
    }
}

#[allow(clippy::too_many_arguments)]
async fn finish_cancelled_agent_turn<R: RuntimeServices>(
    services: &R,
    session_id: &str,
    input_tokens: u64,
    output_tokens: u64,
    cache_read: u64,
    cache_write: u64,
    hooks_list: &[HookConfig],
) {
    services.deny_all_pending(session_id).await;

    if let Err(error) = services.drain_ssh(session_id).await {
        services.set_attempt_failed(session_id, error.clone()).await;
        emit(
            services,
            &error_event(session_id),
            ErrorPayload { message: error },
        );
        fire_session_end_hooks(hooks_list, session_id).await;
        return;
    }
    if let Err(error) = services.ensure_usage_healthy() {
        services.set_attempt_failed(session_id, error.clone()).await;
        emit(
            services,
            &error_event(session_id),
            ErrorPayload { message: error },
        );
        fire_session_end_hooks(hooks_list, session_id).await;
        return;
    }
    if let Err(error) = services.cancel_attempt(session_id).await {
        emit(
            services,
            &error_event(session_id),
            ErrorPayload { message: error },
        );
        fire_session_end_hooks(hooks_list, session_id).await;
        return;
    }
    emit(
        services,
        &done_event(session_id),
        DonePayload {
            input_tokens,
            output_tokens,
            cache_read_input_tokens: cache_read,
            cache_creation_input_tokens: cache_write,
            cancelled: true,
        },
    );

    fire_session_end_hooks(hooks_list, session_id).await;
}

/// The core agentic loop: call LLM → execute tools → repeat.
pub async fn run_turn<R: RuntimeServices>(
    services: &R,
    request: RunRequest,
    mut cancel_rx: oneshot::Receiver<()>,
) -> Result<RunOutcome, String> {
    let session_id = request.session_id.as_str();
    let session = services.session(session_id).await?;

    // R7: one cancellation token for this turn, shared with every child
    // sub-agent. It is cancelled alongside the oneshot in each cancel arm below,
    // so a Stop aborts in-flight children explicitly instead of relying on the
    // implicit future-drop.
    let child_cancel = tokio_util::sync::CancellationToken::new();

    // Durable checkpoint sink. `None` (journal disabled / unbound session) keeps
    // the exact pre-journal code path — every persist below is then a no-op.
    let checkpoint_store = services.checkpoints(session_id).await;
    let checkpoint_store = checkpoint_store.as_deref();

    let provider_name = session.provider.clone();
    let model = session.model.clone();
    let execution = session.execution.clone();
    let system_prompt = session.system_prompt.clone();
    let thinking_enabled = session.thinking_enabled;

    // Boundary 1 (runtime §4.1 step 1): the user turn is accepted into durable
    // history before any model call.
    persist_current_history(
        services,
        checkpoint_store,
        session_id,
        CheckpointBoundary::UserTurnAccepted,
        Vec::new(),
        false,
    )
    .await?;

    let _ = services.provider(&provider_name)?;
    let api_key = services.load_api_key(&provider_name)?;
    let tools = {
        let mut all = tool_runtime::tool_definitions_for_session(
            session.enabled_mcp_server_ids.as_deref(),
            session.mcp_trust_snapshot.as_deref(),
            &session.custom_agents,
        )
        .await;
        let mcp_tools = tokio::select! {
            // A cached discovery has no startup work to cancel. Preserve its
            // connections; the turn cancellation check below handles Stop.
            biased;
            result = session.native_mcp_session.tool_definitions() => result?,
            _ = &mut cancel_rx => {
                child_cancel.cancel();
                session.native_mcp_session.close().await;
                finish_cancelled_agent_turn(services, session_id, 0, 0, 0, 0, &[]).await;
                return Ok(RunOutcome::Cancelled);
            }
        };
        all.extend(mcp_tools);
        filter_tools_for_execution(&mut all, &execution);
        match session.allowed_tools.as_ref() {
            Some(allow) => all
                .into_iter()
                .filter(|t| allow.iter().any(|n| n == &t.name))
                .collect(),
            None => all,
        }
    };
    let frozen_tools = Arc::new(tools.clone());
    let tool_ctx = ToolExecContext {
        provider: provider_name.clone(),
        model: model.clone(),
        execution: execution.clone(),
        enabled_mcp_server_ids: session.enabled_mcp_server_ids.clone(),
        mcp_trust_snapshot: session.mcp_trust_snapshot.clone(),
        custom_agents: Arc::clone(&session.custom_agents),
        native_mcp_session: Arc::clone(&session.native_mcp_session),
        tasks: Arc::clone(&session.tasks),
        frozen_tools: Arc::clone(&frozen_tools),
        cancel: child_cancel.clone(),
    };
    let mut total_input_tokens: u64 = 0;
    let mut total_output_tokens: u64 = 0;
    let mut total_cache_read: u64 = 0;
    let mut total_cache_write: u64 = 0;

    // Load hooks once per loop (covers global + this session's project).
    let all_hooks = services.load_hooks(&execution);

    // Fire SessionStart hooks (best-effort, no veto).
    for hook in all_hooks
        .iter()
        .filter(|h| h.event == HookEvent::SessionStart)
    {
        let payload = serde_json::json!({
            "session_id": session_id,
            "provider": provider_name,
            "model": model,
        });
        if let Err(e) = hooks::run_hook(hook, payload).await {
            warn!(session_id = %session_id, error = %e, "SessionStart hook failed");
        }
    }

    // R4/H6: freeze this run's identity inputs into a durable manifest before any
    // model dispatch. No-op unless the host records manifests (runtime journal
    // enabled + a prepared run binding); fail-closed when the host does record.
    services.record_manifest(session_id).await?;

    for iteration in 0..MAX_TOOL_ITERATIONS {
        // Check cancellation
        if cancel_rx.try_recv().is_ok() {
            child_cancel.cancel();
            finish_cancelled_agent_turn(
                services,
                session_id,
                total_input_tokens,
                total_output_tokens,
                total_cache_read,
                total_cache_write,
                &all_hooks,
            )
            .await;
            return Ok(RunOutcome::Cancelled);
        }

        // Get current message history
        let messages = services.history(session_id).await;

        // R4b pre-dispatch capability guard (runtime §6/H5). Only the first
        // iteration can carry fresh user attachments, and the check runs BEFORE
        // the dispatch-intent checkpoint below and BEFORE the drain, so a
        // refused image neither records a dispatch intent nor gets consumed.
        // Fail-closed: `unsupported` and `unknown` both refuse; nothing is
        // silently dropped. Gated on the runtime authority being enabled, so the
        // disabled path stays byte-identical to pre-R4b.
        if iteration == 0
            && services.capability_guard_enabled()
            && services.has_pending_attachments(session_id).await
        {
            runtime_capabilities::require_route_supports_images(&provider_name, &model)
                .map_err(|error| error.to_string())?;
        }

        // R6 (H3) context accounting/projection. Gated on the runtime authority
        // being enabled so the disabled path stays byte-identical. The
        // projection is a NON-DRAINING count of the queued attachments, so a
        // refusal (overflow or budget) never consumes them — R4b's "nothing
        // silently dropped" guarantee holds. It runs BEFORE admission and the
        // dispatch-intent checkpoint, so an overflow blocks before any spend.
        // Count queued attachments ONCE, non-draining, only when the guard is on
        // so the disabled path does not probe. The count feeds both the context
        // projection and the R5 budget estimate.
        let attachment_count = if services.capability_guard_enabled() {
            services.pending_attachment_count(session_id).await
        } else {
            0
        };
        if services.capability_guard_enabled() {
            let window_tokens = session
                .context_window_tokens
                .filter(|window| *window > 0)
                .or_else(|| services.context_window_tokens(&provider_name, &model));
            let snapshot = runtime_context::project_context(
                &format!("{provider_name}:{model}"),
                &system_prompt,
                &messages,
                &tools,
                attachment_count,
                window_tokens,
                MAX_OUTPUT_TOKENS,
                0,
                services.now_ms(),
            );
            // The snapshot is committed BEFORE the model call (runtime §4.1
            // step 2). On overflow the store failure is deliberately ignored so
            // the overflow itself surfaces; on success a store failure fails
            // closed (`?`), like the dispatch-intent checkpoint.
            if let Err(error) = runtime_context::check_fit(&snapshot) {
                let _ = services
                    .record_context_snapshot(session_id, &snapshot)
                    .await;
                return Err(error.to_string());
            }
            services
                .record_context_snapshot(session_id, &snapshot)
                .await?;
        }

        // Build the provider BEFORE admission so a provider-construction
        // failure cannot strand a reservation. Behavior is otherwise identical.
        let provider_ref = services.provider(&provider_name)?;

        // R5b per-request budget admission. Runs BEFORE the dispatch-intent
        // checkpoint and the usage-health check so a refused request records no
        // intent and spends nothing. With no configured budget the host returns
        // `NotConfigured` and this is a no-op, so the disabled path is
        // byte-identical.
        let request_id = format!("{session_id}:{iteration}:{}", Uuid::new_v4());
        let mut pending_reservation = matches!(
            services
                .admit_request(
                    session_id,
                    &request_id,
                    &provider_name,
                    &model,
                    &system_prompt,
                    &messages,
                    &tools,
                    attachment_count,
                    MAX_OUTPUT_TOKENS,
                )
                .await?,
            BudgetAdmission::Reserved
        );

        // Boundary 2 (runtime §4.1 step 2): dispatch intent for the model
        // request is durable before the request goes out.
        if let Err(error) = persist_checkpoint(
            checkpoint_store,
            CheckpointBoundary::PreRequest,
            &messages,
            Vec::new(),
            false,
        )
        .await
        {
            release_pending_reservation(
                services,
                session_id,
                &request_id,
                &mut pending_reservation,
            )
            .await;
            return Err(error);
        }

        // Take pending attachments (only apply to iteration 0 — tool-result iterations don't re-attach).
        let pending_attachments = if iteration == 0 {
            services.take_pending_attachments(session_id).await
        } else {
            Vec::new()
        };

        let request = LlmRequest {
            model: model.clone(),
            messages,
            tools: tools.clone(),
            system_prompt: Some(system_prompt.clone()),
            max_tokens: MAX_OUTPUT_TOKENS as u32,
            temperature: None,
            attachments: pending_attachments,
            thinking_enabled,
            thinking_budget_tokens: 8000,
            // Stable for the life of the session, so every iteration of this
            // loop lands on the same OpenAI prompt-cache partition.
            cache_key: Some(session_id.to_string()),
        };

        if let Err(error) = services.ensure_usage_healthy() {
            release_pending_reservation(
                services,
                session_id,
                &request_id,
                &mut pending_reservation,
            )
            .await;
            return Err(error);
        }
        // R5: the request is about to leave for the provider. Mark it dispatched
        // so a later cancel/error or a crash retains its reservation as uncertain
        // liability instead of freeing headroom the provider may already have
        // billed. Marked AFTER the last pre-dispatch failure point
        // (`ensure_usage_healthy`), so a request that never left is still freed.
        if pending_reservation {
            if let Err(error) = services
                .mark_request_dispatched(session_id, &request_id)
                .await
            {
                release_pending_reservation(
                    services,
                    session_id,
                    &request_id,
                    &mut pending_reservation,
                )
                .await;
                return Err(error);
            }
        }
        // Stream the response
        let (tx, mut rx) = mpsc::channel::<StreamChunk>(64);
        let api_key_clone = api_key.clone();
        let request_clone = request;

        let stream_handle = tokio::spawn(async move {
            provider_ref
                .stream_chat(&api_key_clone, request_clone, tx)
                .await
        });

        let mut text_content = String::new();
        let mut tool_calls: Vec<ToolCall> = Vec::new();
        let mut current_tool_id = String::new();
        let mut current_tool_name = String::new();
        let mut current_tool_args = String::new();
        let mut got_error = false;
        let mut error_message: Option<String> = None;
        let mut request_completed = false;
        // Provider-owned reasoning payload for this assistant turn (MiniMax M3
        // `reasoning_details`). Stored verbatim on the history message so the
        // next iteration replays it and the interleaved-thinking chain holds.
        let mut provider_reasoning: Option<serde_json::Value> = None;

        // Process stream chunks
        loop {
            tokio::select! {
                _ = &mut cancel_rx => {
                    // R7: cancel in-flight child sub-agents of this turn too.
                    child_cancel.cancel();
                    // Abort the detached stream task so the provider's
                    // `stream_chat` stops holding the upstream HTTP connection
                    // and pushing into the now-dropped mpsc channel.
                    stream_handle.abort();
                    release_pending_reservation(
                        services,
                        session_id,
                        &request_id,
                        &mut pending_reservation,
                    )
                    .await;
                    finish_cancelled_agent_turn(
                        services,
                        session_id,
                        total_input_tokens,
                        total_output_tokens,
                        total_cache_read,
                        total_cache_write,
                        &all_hooks,
                    )
                    .await;
                    return Ok(RunOutcome::Cancelled);
                }
                chunk = rx.recv() => {
                    if let Some(chunk) = &chunk {
                        // Only a request with a live reservation carries a
                        // correlation id, so a no-budget run's ledger rows stay
                        // byte-identical to before R5b. The id is still live at
                        // the `Done` call because settle happens after it.
                        let request_id_arg = if pending_reservation {
                            Some(request_id.as_str())
                        } else {
                            None
                        };
                        match services.account_request_chunk(session_id, &provider_name, &model, request_id_arg, chunk) {
                            Ok(Some(actual)) => {
                                // The usage row is durable; settle the journal
                                // reservation with the exact actual.
                                if pending_reservation {
                                    if let Err(error) = services.settle_request(session_id, &request_id, actual).await {
                                        // The ledger append already succeeded;
                                        // leave the reservation reserved (the
                                        // conservative policy, matching a
                                        // failed append) rather than releasing.
                                        return Err(error);
                                    }
                                    pending_reservation = false;
                                }
                            }
                            Ok(None) => {}
                            Err(error) => {
                                // The ledger append failed, so the actual spend
                                // is unrecorded. Deliberately leave the
                                // reservation reserved rather than release it:
                                // freeing the headroom would let unrecorded
                                // spend be silently re-admitted. The failed
                                // append has already latched accounting
                                // unhealthy, which blocks further admission.
                                stream_handle.abort();
                                return Err(error);
                            }
                        }
                    }
                    match chunk {
                        None => break, // Channel closed
                        Some(StreamChunk::TextDelta { text }) => {
                            text_content.push_str(&text);
                            services.events().emit(&chunk_event(session_id), Value::String(text));
                        }
                        Some(StreamChunk::ToolUseStart { id, name }) => {
                            current_tool_id = id.clone();
                            current_tool_name = name.clone();
                            current_tool_args.clear();
                            emit(services, &tool_start_event(session_id), ToolStartPayload { id, name });
                        }
                        Some(StreamChunk::ToolUseInputDelta { delta }) => {
                            current_tool_args.push_str(&delta);
                        }
                        Some(StreamChunk::ToolUseEnd { id, name, arguments }) => {
                            tool_calls.push(ToolCall { id, name, arguments });
                            current_tool_id.clear();
                            current_tool_name.clear();
                            current_tool_args.clear();
                        }
                        Some(StreamChunk::Done {
                            input_tokens,
                            output_tokens,
                            cache_read_input_tokens,
                            cache_creation_input_tokens,
                        }) => {
                            request_completed = true;
                            total_input_tokens += input_tokens;
                            total_output_tokens += output_tokens;
                            total_cache_read += cache_read_input_tokens;
                            total_cache_write += cache_creation_input_tokens;
                            // CE6 instrumentation. Prompt caching fails
                            // SILENTLY when the prefix is under the model's
                            // minimum cacheable length, so the only proof it
                            // is working is a non-zero cache_read that rises
                            // from iteration 1 onward. Logged per iteration
                            // rather than per turn so a mid-turn invalidation
                            // (attachments, an MCP flap, a rewind) is visible
                            // as the iteration where reads drop back to zero.
                            log_cache_usage(
                                session_id,
                                &model,
                                iteration,
                                input_tokens,
                                cache_read_input_tokens,
                                cache_creation_input_tokens,
                            );
                            break;
                        }
                        Some(StreamChunk::ReasoningDetails { details }) => {
                            provider_reasoning = Some(details);
                        }
                        Some(StreamChunk::ThinkingDelta { text }) => {
                            emit(services, &thinking_event(session_id), ThinkingPayload { text });
                        }
                        Some(StreamChunk::ThinkingStop) => {
                            services.events().emit(&thinking_stop_event(session_id), Value::Null);
                        }
                        Some(StreamChunk::Error { message }) => {
                            services.set_attempt_failed(session_id, message.clone()).await;
                            emit(services, &error_event(session_id), ErrorPayload { message: message.clone() });
                            got_error = true;
                            error_message = Some(message);
                            break;
                        }
                    }
                }
            }
        }

        // Wait for the provider result. Provider-level failures that did not
        // arrive as a StreamChunk are surfaced by the outer loop exactly once.
        let stream_result = match stream_handle.await {
            Ok(result) => result,
            Err(e) => {
                release_pending_reservation(
                    services,
                    session_id,
                    &request_id,
                    &mut pending_reservation,
                )
                .await;
                return Err(format!("LLM stream task failed: {}", e));
            }
        };

        if got_error {
            // The detailed StreamChunk::Error was already emitted above.
            release_pending_reservation(
                services,
                session_id,
                &request_id,
                &mut pending_reservation,
            )
            .await;
            return Ok(RunOutcome::Failed(
                error_message.unwrap_or_else(|| "provider error".to_string()),
            ));
        }
        if let Err(error) = require_provider_completion(request_completed, stream_result) {
            release_pending_reservation(
                services,
                session_id,
                &request_id,
                &mut pending_reservation,
            )
            .await;
            return Err(error);
        }

        // The provider reported completion, so `account_request_chunk` should
        // have returned the actual on `Done` and settled. If the reservation is
        // still pending the host violated that contract; release it so no
        // reservation survives a completed iteration.
        if request_completed && pending_reservation {
            warn!(
                session_id = %session_id,
                request_id = %request_id,
                "Provider reported completion without an accounted actual; releasing the budget reservation"
            );
            release_pending_reservation(
                services,
                session_id,
                &request_id,
                &mut pending_reservation,
            )
            .await;
        }

        if let Some(assistant_msg) =
            build_assistant_history_message(&text_content, &tool_calls, provider_reasoning)
        {
            services.push_history(session_id, assistant_msg).await;
        }

        // Boundary 5 (runtime §4.1 step 3): the completed assistant typed blocks
        // and tool-call IDs are durable before any resulting tool is dispatched.
        if let Err(error) = persist_current_history(
            services,
            checkpoint_store,
            session_id,
            CheckpointBoundary::AssistantReceipt,
            Vec::new(),
            false,
        )
        .await
        {
            release_pending_reservation(
                services,
                session_id,
                &request_id,
                &mut pending_reservation,
            )
            .await;
            return Err(error);
        }

        // If no tool calls, we're done
        if tool_calls.is_empty() {
            services.set_attempt_reviewing(session_id).await;

            emit(
                services,
                &done_event(session_id),
                DonePayload {
                    input_tokens: total_input_tokens,
                    output_tokens: total_output_tokens,
                    cache_read_input_tokens: total_cache_read,
                    cache_creation_input_tokens: total_cache_write,
                    cancelled: false,
                },
            );

            fire_session_end_hooks(&all_hooks, session_id).await;
            return Ok(RunOutcome::Completed {
                input_tokens: total_input_tokens,
                output_tokens: total_output_tokens,
            });
        }

        // Re-read config for this iteration — plan_mode/permission_mode/approve_writes may flip mid-session.
        let (plan_mode_active, permission_mode, approve_writes) = {
            let flags = services.flags(session_id).await;
            (flags.plan_mode, flags.permission_mode, flags.approve_writes)
        };

        // Execute tool calls in parallel; each async block handles its own gates.
        let futures: Vec<_> = tool_calls
            .iter()
            .cloned()
            .map(|mut tc| {
                let tool_ctx = tool_ctx.clone();
                let hooks_for_tool = all_hooks.clone();
                async move {
                    if !tool_is_advertised(&tc.name, &tool_ctx.frozen_tools) {
                        let result = ToolResult {
                            tool_call_id: tc.id.clone(),
                            content: format!("Tool '{}' is outside this session's allowed tool set.", tc.name),
                            is_error: true,
                        };
                        emit(services, &tool_result_event(session_id), ToolResultPayload {
                            id: tc.id.clone(), name: tc.name.clone(), content: result.content.clone(),
                            is_error: true, input: serde_json::to_string(&tc.arguments).unwrap_or_default(),
                        });
                        return (tc.id.clone(), result);
                    }
                    // Plan mode gate
                    if plan_mode_active && !PLAN_MODE_ALLOWED.contains(&tc.name.as_str()) {
                        let err = ToolResult {
                            tool_call_id: tc.id.clone(),
                            content: format!(
                                "Plan mode is active — '{}' is disabled. Ask the user to exit plan mode first.",
                                tc.name
                            ),
                            is_error: true,
                        };
                        emit(services, &tool_result_event(session_id), ToolResultPayload {
                            id: tc.id.clone(),
                            name: tc.name.clone(),
                            content: err.content.clone(),
                            is_error: true,
                            input: serde_json::to_string(&tc.arguments).unwrap_or_default(),
                        });
                        return (tc.id.clone(), err);
                    }

                    // Permission gate (risky tools only)
                    if RISKY_TOOLS.contains(&tc.name.as_str()) {
                        let auto_allowed = services.is_tool_auto_allowed(session_id, &tc.name).await;

                        let should_ask = !auto_allowed
                            && matches!(permission_mode, PermissionMode::AskForRisky);
                        let should_deny = matches!(permission_mode, PermissionMode::DenyAll);

                        if should_deny {
                            let err = ToolResult {
                                tool_call_id: tc.id.clone(),
                                content: "Permissions: all risky tools are denied.".to_string(),
                                is_error: true,
                            };
                            emit(services, &tool_result_event(session_id), ToolResultPayload {
                                id: tc.id.clone(),
                                name: tc.name.clone(),
                                content: err.content.clone(),
                                is_error: true,
                                input: serde_json::to_string(&tc.arguments).unwrap_or_default(),
                            });
                            return (tc.id.clone(), err);
                        }

                        if should_ask {
                            let rx = services.register_permission(session_id, &tc.id).await;
                            emit(services, &permission_request_event(session_id), PermissionRequestPayload {
                                id: tc.id.clone(),
                                name: tc.name.clone(),
                                arguments: serde_json::to_string(&tc.arguments).unwrap_or_default(),
                            });
                            // A dropped response channel counts as a plain
                            // deny so the or-pattern below stays exhaustive.
                            match tokio::time::timeout(Duration::from_secs(300), rx)
                                .await
                                .map(|r| r.unwrap_or(PermissionDecision::Deny { reason: None }))
                            {
                                Ok(PermissionDecision::AllowOnce) => {
                                    // proceed
                                }
                                Ok(PermissionDecision::AllowAlways) => {
                                    services.allow_tool_always(session_id, &tc.name).await;
                                }
                                Ok(PermissionDecision::Deny { reason }) => {
                                    // Deny-and-continue: the reason steers the
                                    // model's next step instead of stalling it.
                                    let content = match reason
                                        .as_deref()
                                        .map(str::trim)
                                        .filter(|r| !r.is_empty())
                                    {
                                        Some(r) => format!(
                                            "User denied permission for this tool call. User's guidance: {}",
                                            r
                                        ),
                                        None => "User denied permission for this tool call."
                                            .to_string(),
                                    };
                                    let err = ToolResult {
                                        tool_call_id: tc.id.clone(),
                                        content,
                                        is_error: true,
                                    };
                                    emit(services, &tool_result_event(session_id), ToolResultPayload {
                                        id: tc.id.clone(),
                                        name: tc.name.clone(),
                                        content: err.content.clone(),
                                        is_error: true,
                                        input: serde_json::to_string(&tc.arguments).unwrap_or_default(),
                                    });
                                    return (tc.id.clone(), err);
                                }
                                Err(_) => {
                                    // Timed out — remove stale entry and deny.
                                    services.remove_permission(session_id, &tc.id).await;
                                    let err = ToolResult {
                                        tool_call_id: tc.id.clone(),
                                        content: "Permission request timed out.".to_string(),
                                        is_error: true,
                                    };
                                    emit(services, &tool_result_event(session_id), ToolResultPayload {
                                        id: tc.id.clone(),
                                        name: tc.name.clone(),
                                        content: err.content.clone(),
                                        is_error: true,
                                        input: serde_json::to_string(&tc.arguments).unwrap_or_default(),
                                    });
                                    return (tc.id.clone(), err);
                                }
                            }
                        }
                    }

                    // The approval gate is the only legitimate writer of the
                    // reserved merged-content argument — drop anything the
                    // model tried to smuggle in under that name.
                    if tc.name == "edit_file" {
                        if let Some(args) = tc.arguments.as_object_mut() {
                            args.remove(tool_runtime::APPROVED_CONTENT_ARG);
                        }
                    }

                    // Pending edit gate (write_file / edit_file with approve_writes enabled)
                    let is_edit_tool = EDIT_TOOLS.contains(&tc.name.as_str());
                    let is_write_file = tc.name == "write_file";
                    if is_edit_tool && approve_writes {
                        let path = match tc
                            .arguments
                            .get("path")
                            .and_then(|v| v.as_str())
                        {
                            Some(path) => path.to_string(),
                            None => {
                                let err = ToolResult {
                                    tool_call_id: tc.id.clone(),
                                    content: "Missing 'path' parameter".to_string(),
                                    is_error: true,
                                };
                                emit(services, &tool_result_event(session_id), ToolResultPayload {
                                    id: tc.id.clone(),
                                    name: tc.name.clone(),
                                    content: err.content.clone(),
                                    is_error: true,
                                    input: serde_json::to_string(&tc.arguments).unwrap_or_default(),
                                });
                                return (tc.id.clone(), err);
                            }
                        };
                        let resolved_local_path = match &tool_ctx.execution {
                            ExecutionTarget::Local { project_path } => {
                                match tool_runtime::resolve_workspace_path(
                                    &path,
                                    project_path,
                                    false,
                                ) {
                                    Ok(path) => Some(path),
                                    Err(e) => {
                                        let err = ToolResult {
                                            tool_call_id: tc.id.clone(),
                                            content: e,
                                            is_error: true,
                                        };
                                        emit(services, &tool_result_event(session_id), ToolResultPayload {
                                            id: tc.id.clone(),
                                            name: tc.name.clone(),
                                            content: err.content.clone(),
                                            is_error: true,
                                            input: serde_json::to_string(&tc.arguments).unwrap_or_default(),
                                        });
                                        return (tc.id.clone(), err);
                                    }
                                }
                            }
                            ExecutionTarget::Ssh { .. } => None,
                        };
                        // Read prior content for before/after diff. None for
                        // new files, remote targets, or unreadable paths.
                        let before = match &resolved_local_path {
                            Some(path) => tokio::fs::read_to_string(path).await.ok(),
                            None => None,
                        };

                        // The proposed post-edit file body: write_file carries
                        // it outright, edit_file materializes it by replaying
                        // its replacement onto the baseline so the diff the
                        // user approves is the diff that lands.
                        let content = if is_write_file {
                            match tc.arguments.get("content").and_then(|v| v.as_str()) {
                                Some(content) => content.to_string(),
                                None => {
                                    let err = ToolResult {
                                        tool_call_id: tc.id.clone(),
                                        content: "Missing 'content' parameter".to_string(),
                                        is_error: true,
                                    };
                                    emit(services, &tool_result_event(session_id), ToolResultPayload {
                                        id: tc.id.clone(),
                                        name: tc.name.clone(),
                                        content: err.content.clone(),
                                        is_error: true,
                                        input: serde_json::to_string(&tc.arguments).unwrap_or_default(),
                                    });
                                    return (tc.id.clone(), err);
                                }
                            }
                        } else {
                            let preview = if resolved_local_path.is_none() {
                                Err(tool_runtime::EDIT_FILE_REMOTE_UNSUPPORTED.to_string())
                            } else {
                                tool_runtime::preview_edit_file(&tc.arguments, before.as_deref())
                            };
                            match preview {
                                Ok(after) => after,
                                Err(e) => {
                                    let err = ToolResult {
                                        tool_call_id: tc.id.clone(),
                                        content: e,
                                        is_error: true,
                                    };
                                    emit(services, &tool_result_event(session_id), ToolResultPayload {
                                        id: tc.id.clone(),
                                        name: tc.name.clone(),
                                        content: err.content.clone(),
                                        is_error: true,
                                        input: serde_json::to_string(&tc.arguments).unwrap_or_default(),
                                    });
                                    return (tc.id.clone(), err);
                                }
                            }
                        };

                        let rx = services.register_edit(session_id, &tc.id).await;
                        emit(services, &pending_edit_event(session_id), PendingEditPayload {
                            id: tc.id.clone(),
                            path,
                            content,
                            before,
                        });
                        match tokio::time::timeout(Duration::from_secs(600), rx).await {
                            Ok(Ok(EditDecision::Apply { merged_content })) => {
                                // F2: per-hunk acceptance — swap in the
                                // user-merged file body before the tool runs
                                // so the actual write writes only the hunks
                                // the user picked, not the model's full
                                // `after`. edit_file carries it in a reserved
                                // argument its executor honours in place of
                                // the search/replace.
                                if let Some(merged) = merged_content {
                                    let key = if is_write_file {
                                        "content"
                                    } else {
                                        tool_runtime::APPROVED_CONTENT_ARG
                                    };
                                    if let Some(args) =
                                        tc.arguments.as_object_mut()
                                    {
                                        args.insert(
                                            key.to_string(),
                                            serde_json::Value::String(merged),
                                        );
                                    }
                                }
                            }
                            Ok(Ok(EditDecision::Reject)) | Ok(Err(_)) => {
                                let err = ToolResult {
                                    tool_call_id: tc.id.clone(),
                                    content: "User rejected this edit.".to_string(),
                                    is_error: true,
                                };
                                emit(services, &tool_result_event(session_id), ToolResultPayload {
                                    id: tc.id.clone(),
                                    name: tc.name.clone(),
                                    content: err.content.clone(),
                                    is_error: true,
                                    input: serde_json::to_string(&tc.arguments).unwrap_or_default(),
                                });
                                return (tc.id.clone(), err);
                            }
                            Err(_) => {
                                services.remove_edit(session_id, &tc.id).await;
                                let err = ToolResult {
                                    tool_call_id: tc.id.clone(),
                                    content: "Edit approval timed out.".to_string(),
                                    is_error: true,
                                };
                                emit(services, &tool_result_event(session_id), ToolResultPayload {
                                    id: tc.id.clone(),
                                    name: tc.name.clone(),
                                    content: err.content.clone(),
                                    is_error: true,
                                    input: serde_json::to_string(&tc.arguments).unwrap_or_default(),
                                });
                                return (tc.id.clone(), err);
                            }
                        }
                    } else if is_edit_tool {
                        // P1-7: no approval gate, but still capture the
                        // pre-edit baseline so review surfaces can diff the
                        // applied result against the true "before" instead
                        // of live disk. Local targets only — a remote read
                        // here could mislabel an existing file as new.
                        if let Some(path) = tc.arguments.get("path").and_then(|v| v.as_str()) {
                            if let ExecutionTarget::Local { project_path } = &tool_ctx.execution {
                                let before = match tool_runtime::resolve_workspace_path(
                                    path,
                                    project_path,
                                    false,
                                ) {
                                    Ok(resolved) => {
                                        tokio::fs::read_to_string(resolved).await.ok()
                                    }
                                    Err(_) => None,
                                };
                                emit(services, &edit_baseline_event(session_id), EditBaselinePayload {
                                    id: tc.id.clone(),
                                    path: path.to_string(),
                                    before,
                                });
                            }
                        }
                    }

                    // PreToolUse hooks — non-zero exit vetoes the tool call.
                    let mut vetoed_by: Option<String> = None;
                    for hook in hooks_for_tool
                        .iter()
                        .filter(|h| h.event == HookEvent::PreToolUse)
                    {
                        if !hooks::matches_tool_call(
                            hook.matcher.as_deref(),
                            &tc.name,
                            &tc.arguments,
                        ) {
                            continue;
                        }
                        let payload = serde_json::json!({
                            "session_id": session_id,
                            "event": "PreToolUse",
                            "tool_name": tc.name,
                            "tool_input": tc.arguments,
                        });
                        match hooks::run_hook(hook, payload).await {
                            Ok(res) if res.veto => {
                                vetoed_by = Some(hook.command.clone());
                                break;
                            }
                            Ok(_) => {}
                            Err(e) => {
                                warn!(
                                    session_id = %session_id,
                                    tool = %tc.name,
                                    error = %e,
                                    "PreToolUse hook failed (treating as allow)"
                                );
                            }
                        }
                    }

                    if let Some(hook_cmd) = vetoed_by {
                        let err = ToolResult {
                            tool_call_id: tc.id.clone(),
                            content: format!("Blocked by PreToolUse hook: {}", hook_cmd),
                            is_error: true,
                        };
                        emit(services, &tool_result_event(session_id), ToolResultPayload {
                            id: tc.id.clone(),
                            name: tc.name.clone(),
                            content: err.content.clone(),
                            is_error: true,
                            input: serde_json::to_string(&tc.arguments).unwrap_or_default(),
                        });
                        return (tc.id.clone(), err);
                    }

                    // Execute tool. The PARENT_LLM scope hands sub-agent
                    // tools the session's provider (Q2); everything else is
                    // oblivious to it.
                    let result = services
                        .execute_tool(session_id, tc.clone(), tool_ctx.clone())
                        .await;
                    emit(services, &tool_result_event(session_id), ToolResultPayload {
                        id: tc.id.clone(),
                        name: tc.name.clone(),
                        content: result.content.clone(),
                        is_error: result.is_error,
                        input: serde_json::to_string(&tc.arguments).unwrap_or_default(),
                    });

                    // PostToolUse hooks — best-effort; failures logged.
                    for hook in hooks_for_tool
                        .iter()
                        .filter(|h| h.event == HookEvent::PostToolUse)
                    {
                        if !hooks::matches_tool_call(
                            hook.matcher.as_deref(),
                            &tc.name,
                            &tc.arguments,
                        ) {
                            continue;
                        }
                        let payload = serde_json::json!({
                            "session_id": session_id,
                            "event": "PostToolUse",
                            "tool_name": tc.name,
                            "tool_input": tc.arguments,
                            "tool_result": result.content,
                            "is_error": result.is_error,
                        });
                        if let Err(e) = hooks::run_hook(hook, payload).await {
                            warn!(
                                session_id = %session_id,
                                tool = %tc.name,
                                error = %e,
                                "PostToolUse hook failed"
                            );
                        }
                    }

                    (tc.id.clone(), result)
                }
            })
            .collect();

        // Boundary 3 (runtime §4.1 steps 4–6): every tool's intent is durable,
        // with its effect id pending, before any tool runs. A crash after this
        // point but before the receipt leaves the effect unresolved.
        let tool_ids: Vec<String> = tool_calls.iter().map(|tc| tc.id.clone()).collect();
        if let Err(error) = persist_current_history(
            services,
            checkpoint_store,
            session_id,
            CheckpointBoundary::ToolIntent,
            tool_ids.clone(),
            false,
        )
        .await
        {
            release_pending_reservation(
                services,
                session_id,
                &request_id,
                &mut pending_reservation,
            )
            .await;
            return Err(error);
        }

        // R7: box the join so the tool futures SURVIVE the select and can be
        // polled again from the cancel arm. tokio's `select!` drops the losing
        // branch's futures BEFORE running the winning arm's handler, so a child
        // sub-agent inside `join_all` would otherwise be dropped before
        // `child_cancel.cancel()` ran and could never observe the token.
        let mut tool_futures = Box::pin(futures::future::join_all(futures));
        let raw_results = tokio::select! {
            results = &mut tool_futures => results,
            _ = &mut cancel_rx => {
                // Signal children first, then give them a bounded window to
                // observe the token: abort their provider stream, release their
                // reservation (a dispatched child becomes uncertain liability)
                // and return `Cancelled`. The timeout keeps Stop responsive even
                // if a child ignores the token.
                child_cancel.cancel();
                let _ = tokio::time::timeout(
                    std::time::Duration::from_secs(5),
                    &mut tool_futures,
                )
                .await;
                // The tools' outcome is now ambiguous, so mark the pending
                // effects for reconciliation; this is best-effort and never
                // changes the cancel outcome.
                let _ = persist_current_history(
                    services,
                    checkpoint_store,
                    session_id,
                    CheckpointBoundary::ToolIntent,
                    tool_ids.clone(),
                    true,
                )
                .await;
                release_pending_reservation(
                    services,
                    session_id,
                    &request_id,
                    &mut pending_reservation,
                )
                .await;
                finish_cancelled_agent_turn(
                    services,
                    session_id,
                    total_input_tokens,
                    total_output_tokens,
                    total_cache_read,
                    total_cache_write,
                    &all_hooks,
                )
                .await;
                return Ok(RunOutcome::Cancelled);
            }
        };

        // Rebuild tool_result_blocks in the original tool_calls order (critical for Anthropic pairing).
        let results_map: HashMap<String, ToolResult> = raw_results.into_iter().collect();
        let mut tool_result_blocks = Vec::with_capacity(tool_calls.len());
        for tc in &tool_calls {
            if let Some(result) = results_map.get(&tc.id) {
                tool_result_blocks.push(ContentBlock::ToolResult {
                    tool_call_id: result.tool_call_id.clone(),
                    content: result.content.clone(),
                    is_error: result.is_error,
                });
            }
        }

        // Append tool results as a tool message
        services
            .push_history(
                session_id,
                ChatMessage {
                    role: ChatRole::Tool,
                    content: MessageContent::Blocks(tool_result_blocks),
                },
            )
            .await;

        // Boundary 4 (runtime §4.1 step 7): the tool receipt plus the updated
        // typed history are durable before the next model request. Clearing the
        // pending ids here is what makes a completed tool non-replayable.
        if let Err(error) = persist_current_history(
            services,
            checkpoint_store,
            session_id,
            CheckpointBoundary::ToolReceipt,
            Vec::new(),
            false,
        )
        .await
        {
            release_pending_reservation(
                services,
                session_id,
                &request_id,
                &mut pending_reservation,
            )
            .await;
            return Err(error);
        }

        info!(
            session_id = %session_id,
            iteration = iteration,
            tool_count = tool_calls.len(),
            "Agent loop: executed tools, continuing"
        );
    }

    // Hit max iterations
    warn!(session_id = %session_id, "Agent loop hit max iterations ({})", MAX_TOOL_ITERATIONS);
    services.set_attempt_reviewing(session_id).await;

    emit(
        services,
        &done_event(session_id),
        DonePayload {
            input_tokens: total_input_tokens,
            output_tokens: total_output_tokens,
            cache_read_input_tokens: total_cache_read,
            cache_creation_input_tokens: total_cache_write,
            cancelled: false,
        },
    );

    fire_session_end_hooks(&all_hooks, session_id).await;
    Ok(RunOutcome::Completed {
        input_tokens: total_input_tokens,
        output_tokens: total_output_tokens,
    })
}
