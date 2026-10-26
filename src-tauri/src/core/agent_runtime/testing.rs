//! Test-only fakes for the R2c deterministic lane.
//!
//! Compiled only under `cfg(test)` (see `mod.rs`). This is not a second
//! runtime: [`ScriptedProvider`] implements the production [`LlmProvider`]
//! stream contract and [`FakeServices`] implements the same [`RuntimeServices`]
//! seam the Tauri adapter does, so `run_turn` executes unchanged against
//! scripted input. Nothing here ships.

use std::collections::{HashSet, VecDeque};
use std::sync::{Arc, Mutex};

#[cfg(test)]
use serde_json::json;
use serde_json::Value;
use tokio::sync::{mpsc, oneshot, Notify};

#[cfg(test)]
use crate::core::agent_runtime::runner::{run_turn, MAX_OUTPUT_TOKENS};
use crate::core::agent_runtime::{
    BudgetAdmission, CheckpointBoundary, CheckpointStore, CheckpointWrite, EditDecision, EventSink,
    FlightStatusSink, HistoryStore, PermissionBroker, PermissionDecision, PermissionMode,
    RecordingEventSink, RuntimeFlags, RuntimeServices, RuntimeSession, ToolExecContext,
};
#[cfg(test)]
use crate::core::agent_runtime::{RunOutcome, RunRequest};
use crate::core::execution::ExecutionTarget;
use crate::core::hooks::HookConfig;
use crate::core::llm_provider::LlmProvider;
use crate::core::llm_types::{
    ChatMessage, ImageAttachment, LlmRequest, StreamChunk, ToolCall, ToolDefinition, ToolResult,
};
use crate::core::mcp_session::NativeMcpSession;
use crate::core::runtime_context::ContextSnapshot;
#[cfg(test)]
use crate::core::runtime_context::{estimate_text_tokens, IMAGE_TOKEN_ESTIMATE};
#[cfg(test)]
use crate::core::tool_runtime;
use crate::core::tool_tasks::SessionTasks;

/// One scripted provider response.
pub enum ScriptStep {
    /// Send these chunks in order, then end the stream successfully.
    Chunks(Vec<StreamChunk>),
    /// Send these chunks, then park forever so the turn can only end through
    /// cancellation.
    ChunksThenBlock(Vec<StreamChunk>),
    /// Fail the stream without emitting any chunk.
    Fail(String),
}

/// A fake [`LlmProvider`] that replays a shared queue of scripted responses,
/// one per `stream_chat` call.
pub struct ScriptedProvider {
    queue: Arc<Mutex<VecDeque<ScriptStep>>>,
    stream_calls: Arc<Mutex<usize>>,
    started: Arc<Notify>,
    last_request: Arc<Mutex<Option<LlmRequest>>>,
}

#[async_trait::async_trait]
impl LlmProvider for ScriptedProvider {
    async fn stream_chat(
        &self,
        _api_key: &str,
        request: LlmRequest,
        tx: mpsc::Sender<StreamChunk>,
    ) -> Result<(), String> {
        *self.stream_calls.lock().expect("stream call count") += 1;
        *self.last_request.lock().expect("last request") = Some(request);
        self.started.notify_one();
        let step = self.queue.lock().expect("script queue").pop_front();
        match step {
            Some(ScriptStep::Chunks(chunks)) => {
                for chunk in chunks {
                    if tx.send(chunk).await.is_err() {
                        return Ok(());
                    }
                }
                Ok(())
            }
            Some(ScriptStep::ChunksThenBlock(chunks)) => {
                for chunk in chunks {
                    let _ = tx.send(chunk).await;
                }
                std::future::pending::<()>().await;
                Ok(())
            }
            Some(ScriptStep::Fail(message)) => Err(message),
            None => Err("scripted provider queue exhausted".into()),
        }
    }

    fn provider_id(&self) -> &str {
        "fake"
    }
}

/// A checkpoint store that records every durable write and can inject a fault
/// at a chosen boundary. A fault models a crash *before* the write commits: the
/// write is not recorded, so the prior durable state stands (a pending intent
/// with no receipt). This is how R3b exercises the mutation/receipt boundary
/// without changing production behavior.
#[derive(Default)]
pub struct FaultCheckpointStore {
    writes: Mutex<Vec<CheckpointWrite>>,
    fail_at: Mutex<Option<CheckpointBoundary>>,
    fail_remaining: Mutex<usize>,
}

impl FaultCheckpointStore {
    pub fn new() -> Self {
        Self::default()
    }

    /// Fail the next `times` persists at `boundary`, then succeed.
    pub fn fail_at(&self, boundary: CheckpointBoundary, times: usize) {
        *self.fail_at.lock().expect("fail_at") = Some(boundary);
        *self.fail_remaining.lock().expect("fail_remaining") = times;
    }

    /// Durable writes in order (a faulted write is absent, like a crash).
    pub fn writes(&self) -> Vec<CheckpointWrite> {
        self.writes.lock().expect("writes").clone()
    }

    pub fn last(&self) -> Option<CheckpointWrite> {
        self.writes.lock().expect("writes").last().cloned()
    }

    pub fn boundaries(&self) -> Vec<CheckpointBoundary> {
        self.writes
            .lock()
            .expect("writes")
            .iter()
            .map(|w| w.boundary)
            .collect()
    }
}

#[async_trait::async_trait]
impl CheckpointStore for FaultCheckpointStore {
    async fn persist(&self, write: &CheckpointWrite) -> Result<(), String> {
        let should_fail = {
            let fail_at = self.fail_at.lock().expect("fail_at");
            let mut remaining = self.fail_remaining.lock().expect("fail_remaining");
            if *fail_at == Some(write.boundary) && *remaining > 0 {
                *remaining -= 1;
                true
            } else {
                false
            }
        };
        if should_fail {
            return Err(format!("injected crash at {}", write.boundary.as_str()));
        }
        self.writes.lock().expect("writes").push(write.clone());
        Ok(())
    }
}

#[async_trait::async_trait]
impl CheckpointStore for Arc<FaultCheckpointStore> {
    async fn persist(&self, write: &CheckpointWrite) -> Result<(), String> {
        (**self).persist(write).await
    }
}

/// A fake host implementing every [`RuntimeServices`] sub-trait. It owns a
/// [`RecordingEventSink`] so tests can assert emission order and payloads.
pub struct FakeServices {
    sink: Arc<RecordingEventSink>,
    session: RuntimeSession,
    flags: RuntimeFlags,
    scripts: Arc<Mutex<VecDeque<ScriptStep>>>,
    stream_calls: Arc<Mutex<usize>>,
    started: Arc<Notify>,
    permissions: Mutex<VecDeque<PermissionDecision>>,
    auto_allowed: Mutex<HashSet<String>>,
    history: Mutex<Vec<ChatMessage>>,
    executed_tools: Mutex<Vec<String>>,
    attempt_reviewing: Mutex<usize>,
    attempt_failed: Mutex<Vec<String>>,
    cancel_attempt: Mutex<usize>,
    deny_all_pending: Mutex<usize>,
    drain_ssh: Mutex<usize>,
    checkpoint_store: Option<Arc<FaultCheckpointStore>>,
    has_pending_attachments: Mutex<bool>,
    attachment_drains: Mutex<usize>,
    capability_guard_enabled: Mutex<bool>,
    admission: Mutex<Result<BudgetAdmission, String>>,
    scripted_actual_usd_micros: Mutex<Option<i64>>,
    scripted_account_error: Mutex<Option<String>>,
    scripted_settle_error: Mutex<Option<String>>,
    admit_calls: Mutex<Vec<(String, String, String, String, u64)>>,
    settle_calls: Mutex<Vec<(String, String, i64)>>,
    release_calls: Mutex<Vec<(String, String)>>,
    mark_dispatched_calls: Mutex<Vec<(String, String)>>,
    manifest_calls: Mutex<usize>,
    context_window: Mutex<Option<u64>>,
    recorded_snapshots: Mutex<Vec<ContextSnapshot>>,
    pending_attachment_count_calls: Mutex<usize>,
    context_window_calls: Mutex<usize>,
    attachments: Mutex<Vec<ImageAttachment>>,
    last_request: Arc<Mutex<Option<LlmRequest>>>,
}

impl FakeServices {
    pub fn new(_session_id: &str) -> Self {
        Self {
            sink: Arc::new(RecordingEventSink::new()),
            session: RuntimeSession {
                provider: "fake".to_string(),
                model: "fake-model".to_string(),
                execution: ExecutionTarget::Local {
                    project_path: ".".to_string(),
                },
                system_prompt: "You are a test agent.".to_string(),
                thinking_enabled: false,
                allowed_tools: None,
                enabled_mcp_server_ids: None,
                mcp_trust_snapshot: None,
                custom_agents: Arc::new(Vec::new()),
                native_mcp_session: Arc::new(NativeMcpSession::default()),
                tasks: Arc::new(SessionTasks::default()),
                context_window_tokens: None,
            },
            flags: RuntimeFlags {
                plan_mode: false,
                permission_mode: PermissionMode::default(),
                approve_writes: false,
            },
            scripts: Arc::new(Mutex::new(VecDeque::new())),
            stream_calls: Arc::new(Mutex::new(0)),
            started: Arc::new(Notify::new()),
            permissions: Mutex::new(VecDeque::new()),
            auto_allowed: Mutex::new(HashSet::new()),
            history: Mutex::new(Vec::new()),
            executed_tools: Mutex::new(Vec::new()),
            attempt_reviewing: Mutex::new(0),
            attempt_failed: Mutex::new(Vec::new()),
            cancel_attempt: Mutex::new(0),
            deny_all_pending: Mutex::new(0),
            drain_ssh: Mutex::new(0),
            checkpoint_store: None,
            has_pending_attachments: Mutex::new(false),
            attachment_drains: Mutex::new(0),
            capability_guard_enabled: Mutex::new(false),
            admission: Mutex::new(Ok(BudgetAdmission::NotConfigured)),
            scripted_actual_usd_micros: Mutex::new(None),
            scripted_account_error: Mutex::new(None),
            scripted_settle_error: Mutex::new(None),
            admit_calls: Mutex::new(Vec::new()),
            settle_calls: Mutex::new(Vec::new()),
            release_calls: Mutex::new(Vec::new()),
            mark_dispatched_calls: Mutex::new(Vec::new()),
            manifest_calls: Mutex::new(0),
            context_window: Mutex::new(None),
            recorded_snapshots: Mutex::new(Vec::new()),
            pending_attachment_count_calls: Mutex::new(0),
            context_window_calls: Mutex::new(0),
            attachments: Mutex::new(Vec::new()),
            last_request: Arc::new(Mutex::new(None)),
        }
    }

    /// Queue (or clear) a pending attachment so the R4b image guard can be
    /// exercised. The drain itself stays empty; only the guard's pre-check sees
    /// this, which is exactly the "would refuse before dispatch" path.
    pub fn set_has_pending_attachments(&self, has: bool) {
        *self
            .has_pending_attachments
            .lock()
            .expect("attachments flag") = has;
    }

    /// Enable the R4b capability guard (mirrors the journal being enabled).
    pub fn set_capability_guard_enabled(&self, enabled: bool) {
        *self.capability_guard_enabled.lock().expect("guard flag") = enabled;
    }

    /// Script what the next `admit_request` returns: `NotConfigured`, `Reserved`
    /// or a refusal error.
    pub fn set_admission(&self, result: Result<BudgetAdmission, String>) {
        *self.admission.lock().expect("admission script") = result;
    }

    /// Script the actual micro-dollars `account_request_chunk` reports on `Done`.
    pub fn set_scripted_actual_usd_micros(&self, actual: Option<i64>) {
        *self
            .scripted_actual_usd_micros
            .lock()
            .expect("actual script") = actual;
    }

    /// Script `account_request_chunk` to fail on `Done` (models a ledger-append
    /// failure).
    pub fn set_scripted_account_error(&self, error: Option<String>) {
        *self
            .scripted_account_error
            .lock()
            .expect("account error script") = error;
    }

    /// Script `settle_request` to fail (models a journal write failure after the
    /// ledger append succeeded).
    pub fn set_scripted_settle_error(&self, error: Option<String>) {
        *self
            .scripted_settle_error
            .lock()
            .expect("settle error script") = error;
    }

    /// `(session_id, request_id, provider, model, max_tokens)` per admission.
    pub fn admit_calls(&self) -> Vec<(String, String, String, String, u64)> {
        self.admit_calls.lock().expect("admit calls").clone()
    }

    /// `(session_id, request_id, actual_usd_micros)` per settlement.
    pub fn settle_calls(&self) -> Vec<(String, String, i64)> {
        self.settle_calls.lock().expect("settle calls").clone()
    }

    /// `(session_id, request_id)` per release.
    pub fn release_calls(&self) -> Vec<(String, String)> {
        self.release_calls.lock().expect("release calls").clone()
    }

    /// `(session_id, request_id)` per dispatch mark (R5).
    pub fn mark_dispatched_calls(&self) -> Vec<(String, String)> {
        self.mark_dispatched_calls
            .lock()
            .expect("mark dispatched calls")
            .clone()
    }

    /// How many times the runner recorded a run manifest (R4/H6).
    pub fn manifest_calls(&self) -> usize {
        *self.manifest_calls.lock().expect("manifest calls")
    }

    /// How many times the runner drained queued attachments.
    pub fn attachment_drains(&self) -> usize {
        *self.attachment_drains.lock().expect("drain count")
    }

    /// Script the context window the runner projects against. `None` falls back
    /// to the real capability resolution for the session's route.
    pub fn set_context_window(&self, window: Option<u64>) {
        *self.context_window.lock().expect("context window script") = window;
    }

    /// Set the window carried on the session binding. When `Some`, the runner
    /// uses it in preference to the `context_window_tokens` trait method.
    pub fn set_session_context_window(&mut self, window: Option<u64>) {
        self.session.context_window_tokens = window;
    }

    /// The context snapshots recorded through `record_context_snapshot`.
    pub fn recorded_context_snapshots(&self) -> Vec<ContextSnapshot> {
        self.recorded_snapshots
            .lock()
            .expect("recorded snapshots")
            .clone()
    }

    /// Queue attachments that `take_pending_attachments` will drain into the
    /// next `LlmRequest`, and that `pending_attachment_count` counts.
    pub fn set_pending_attachments(&self, attachments: Vec<ImageAttachment>) {
        *self.attachments.lock().expect("pending attachments") = attachments;
    }

    /// The most recent `LlmRequest` handed to the provider, if any.
    pub fn last_request(&self) -> Option<LlmRequest> {
        self.last_request.lock().expect("last request").clone()
    }

    /// How many times the runner consulted the non-draining attachment count.
    pub fn pending_attachment_count_calls(&self) -> usize {
        *self
            .pending_attachment_count_calls
            .lock()
            .expect("count calls")
    }

    /// How many times the runner consulted the context window.
    pub fn context_window_calls(&self) -> usize {
        *self.context_window_calls.lock().expect("window calls")
    }

    /// Override the session's provider/model so a test can pick a route with a
    /// known (or unknown) vision capability.
    pub fn set_session_route(&mut self, provider: &str, model: &str) {
        self.session.provider = provider.to_string();
        self.session.model = model.to_string();
    }

    /// Override the session's tool allowlist. `Some(vec![])` removes every tool
    /// (useful for isolating non-tool token contributions).
    pub fn set_allowed_tools(&mut self, tools: Option<Vec<String>>) {
        self.session.allowed_tools = tools;
    }

    /// Install a durable checkpoint sink, enabling the journal path for this
    /// fake. Without it, `checkpoints()` returns `None` and the runner takes the
    /// unchanged pre-journal path.
    pub fn install_checkpoints(&mut self, store: Arc<FaultCheckpointStore>) {
        self.checkpoint_store = Some(store);
    }

    /// Append one scripted provider response, consumed in FIFO order.
    pub fn push_script(&self, step: ScriptStep) {
        self.scripts.lock().expect("script queue").push_back(step);
    }

    /// Script the next permission prompt response.
    pub fn script_permission(&self, decision: PermissionDecision) {
        self.permissions
            .lock()
            .expect("permission script")
            .push_back(decision);
    }

    /// Mark a tool as auto-allowed for this session (skips the prompt).
    pub fn allow_tool(&self, tool: &str) {
        self.auto_allowed
            .lock()
            .expect("auto allowed")
            .insert(tool.to_string());
    }

    pub fn set_permission_mode(&mut self, mode: PermissionMode) {
        self.flags.permission_mode = mode;
    }

    /// Snapshot of emitted `(kind, payload)` in emission order.
    pub fn recorded_events(&self) -> Vec<(String, Value)> {
        self.sink.events()
    }

    /// The tool names the runner actually executed, in order. A denied or
    /// plan-mode-blocked tool is never passed to `execute_tool`, so it does not
    /// appear here.
    pub fn executed_tools(&self) -> Vec<String> {
        self.executed_tools.lock().expect("executed tools").clone()
    }
}

#[async_trait::async_trait]
impl PermissionBroker for FakeServices {
    async fn register_permission(
        &self,
        _session_id: &str,
        _tool_id: &str,
    ) -> oneshot::Receiver<PermissionDecision> {
        let (tx, rx) = oneshot::channel();
        let decision = self
            .permissions
            .lock()
            .expect("permission script")
            .pop_front()
            .unwrap_or(PermissionDecision::Deny { reason: None });
        let _ = tx.send(decision);
        rx
    }

    async fn remove_permission(&self, _session_id: &str, _tool_id: &str) {}

    async fn register_edit(
        &self,
        _session_id: &str,
        _tool_id: &str,
    ) -> oneshot::Receiver<EditDecision> {
        let (tx, rx) = oneshot::channel();
        let _ = tx.send(EditDecision::Reject);
        rx
    }

    async fn remove_edit(&self, _session_id: &str, _tool_id: &str) {}

    async fn deny_all_pending(&self, _session_id: &str) {
        *self.deny_all_pending.lock().expect("deny count") += 1;
    }

    async fn allow_tool_always(&self, _session_id: &str, tool: &str) {
        self.auto_allowed
            .lock()
            .expect("auto allowed")
            .insert(tool.to_string());
    }

    async fn is_tool_auto_allowed(&self, _session_id: &str, tool: &str) -> bool {
        self.auto_allowed
            .lock()
            .expect("auto allowed")
            .contains(tool)
    }
}

#[async_trait::async_trait]
impl HistoryStore for FakeServices {
    async fn history(&self, _session_id: &str) -> Vec<ChatMessage> {
        self.history.lock().expect("history").clone()
    }

    async fn push_history(&self, _session_id: &str, message: ChatMessage) {
        self.history.lock().expect("history").push(message);
    }
}

#[async_trait::async_trait]
impl FlightStatusSink for FakeServices {
    async fn set_attempt_reviewing(&self, _session_id: &str) {
        *self.attempt_reviewing.lock().expect("reviewing count") += 1;
    }

    async fn set_attempt_failed(&self, _session_id: &str, message: String) {
        self.attempt_failed
            .lock()
            .expect("failed reasons")
            .push(message);
    }

    async fn cancel_attempt(&self, _session_id: &str) -> Result<(), String> {
        *self.cancel_attempt.lock().expect("cancel count") += 1;
        Ok(())
    }

    async fn drain_ssh(&self, _session_id: &str) -> Result<(), String> {
        *self.drain_ssh.lock().expect("drain count") += 1;
        Ok(())
    }
}

#[async_trait::async_trait]
impl RuntimeServices for FakeServices {
    fn events(&self) -> &dyn EventSink {
        self.sink.as_ref()
    }

    fn load_api_key(&self, _provider: &str) -> Result<String, String> {
        Ok("fake-key".to_string())
    }

    fn provider(&self, _name: &str) -> Result<Box<dyn LlmProvider>, String> {
        Ok(Box::new(ScriptedProvider {
            queue: Arc::clone(&self.scripts),
            stream_calls: Arc::clone(&self.stream_calls),
            started: Arc::clone(&self.started),
            last_request: Arc::clone(&self.last_request),
        }))
    }

    fn ensure_usage_healthy(&self) -> Result<(), String> {
        Ok(())
    }

    async fn session(&self, _session_id: &str) -> Result<RuntimeSession, String> {
        Ok(self.session.clone())
    }

    async fn flags(&self, _session_id: &str) -> RuntimeFlags {
        self.flags.clone()
    }

    async fn take_pending_attachments(&self, _session_id: &str) -> Vec<ImageAttachment> {
        *self.attachment_drains.lock().expect("drain count") += 1;
        std::mem::take(&mut *self.attachments.lock().expect("pending attachments"))
    }

    async fn has_pending_attachments(&self, _session_id: &str) -> bool {
        *self
            .has_pending_attachments
            .lock()
            .expect("attachments flag")
    }

    async fn pending_attachment_count(&self, _session_id: &str) -> usize {
        *self
            .pending_attachment_count_calls
            .lock()
            .expect("count calls") += 1;
        self.attachments.lock().expect("pending attachments").len()
    }

    fn capability_guard_enabled(&self) -> bool {
        *self.capability_guard_enabled.lock().expect("guard flag")
    }

    fn context_window_tokens(&self, provider: &str, model: &str) -> Option<u64> {
        *self.context_window_calls.lock().expect("window calls") += 1;
        match *self.context_window.lock().expect("context window script") {
            Some(window) => Some(window),
            None => crate::core::runtime_capabilities::resolve_capabilities(provider, model, None)
                .context_window
                .value()
                .copied(),
        }
    }

    async fn record_context_snapshot(
        &self,
        _session_id: &str,
        snapshot: &ContextSnapshot,
    ) -> Result<(), String> {
        self.recorded_snapshots
            .lock()
            .expect("recorded snapshots")
            .push(snapshot.clone());
        Ok(())
    }

    fn load_hooks(&self, _execution: &ExecutionTarget) -> Vec<HookConfig> {
        Vec::new()
    }

    async fn execute_tool(
        &self,
        _session_id: &str,
        call: ToolCall,
        _ctx: ToolExecContext,
    ) -> ToolResult {
        self.executed_tools
            .lock()
            .expect("executed tools")
            .push(call.name.clone());
        ToolResult {
            tool_call_id: call.id.clone(),
            content: format!("executed {}", call.name),
            is_error: false,
        }
    }

    fn account_request_chunk(
        &self,
        _session_id: &str,
        _provider: &str,
        _model: &str,
        _request_id: Option<&str>,
        chunk: &StreamChunk,
    ) -> Result<Option<i64>, String> {
        if matches!(chunk, StreamChunk::Done { .. }) {
            if let Some(error) = self
                .scripted_account_error
                .lock()
                .expect("account error script")
                .clone()
            {
                return Err(error);
            }
            Ok(*self
                .scripted_actual_usd_micros
                .lock()
                .expect("actual script"))
        } else {
            Ok(None)
        }
    }

    async fn admit_request(
        &self,
        session_id: &str,
        request_id: &str,
        provider: &str,
        model: &str,
        _system_prompt: &str,
        _messages: &[ChatMessage],
        _tools: &[ToolDefinition],
        _attachment_count: usize,
        max_tokens: u64,
    ) -> Result<BudgetAdmission, String> {
        self.admit_calls.lock().expect("admit calls").push((
            session_id.to_string(),
            request_id.to_string(),
            provider.to_string(),
            model.to_string(),
            max_tokens,
        ));
        self.admission.lock().expect("admission script").clone()
    }

    async fn settle_request(
        &self,
        session_id: &str,
        request_id: &str,
        actual_usd_micros: i64,
    ) -> Result<(), String> {
        self.settle_calls.lock().expect("settle calls").push((
            session_id.to_string(),
            request_id.to_string(),
            actual_usd_micros,
        ));
        if let Some(error) = self
            .scripted_settle_error
            .lock()
            .expect("settle error script")
            .clone()
        {
            return Err(error);
        }
        Ok(())
    }

    async fn release_request(&self, session_id: &str, request_id: &str) -> Result<(), String> {
        self.release_calls
            .lock()
            .expect("release calls")
            .push((session_id.to_string(), request_id.to_string()));
        Ok(())
    }

    async fn mark_request_dispatched(
        &self,
        session_id: &str,
        request_id: &str,
    ) -> Result<(), String> {
        self.mark_dispatched_calls
            .lock()
            .expect("mark dispatched calls")
            .push((session_id.to_string(), request_id.to_string()));
        Ok(())
    }

    async fn record_manifest(&self, _session_id: &str) -> Result<(), String> {
        *self.manifest_calls.lock().expect("manifest calls") += 1;
        Ok(())
    }

    async fn checkpoints(&self, _session_id: &str) -> Option<Box<dyn CheckpointStore>> {
        self.checkpoint_store
            .as_ref()
            .map(|store| Box::new(Arc::clone(store)) as Box<dyn CheckpointStore>)
    }
}

#[cfg(test)]
fn done(input: u64, output: u64) -> StreamChunk {
    StreamChunk::Done {
        input_tokens: input,
        output_tokens: output,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
    }
}

#[cfg(test)]
fn bash_call_script() -> ScriptStep {
    ScriptStep::Chunks(vec![
        StreamChunk::ToolUseStart {
            id: "t1".to_string(),
            name: "bash".to_string(),
        },
        StreamChunk::ToolUseInputDelta {
            delta: "{\"command\":\"echo hi\"}".to_string(),
        },
        StreamChunk::ToolUseEnd {
            id: "t1".to_string(),
            name: "bash".to_string(),
            arguments: serde_json::json!({ "command": "echo hi" }),
        },
        done(5, 4),
    ])
}

#[cfg(test)]
fn text_script(text: &str) -> ScriptStep {
    ScriptStep::Chunks(vec![
        StreamChunk::TextDelta {
            text: text.to_string(),
        },
        done(2, 1),
    ])
}

#[cfg(test)]
fn attachment() -> ImageAttachment {
    ImageAttachment {
        media_type: "image/png".to_string(),
        data_base64: "AAAA".to_string(),
    }
}

#[cfg(test)]
fn run_request(session_id: &str) -> RunRequest {
    RunRequest {
        session_id: session_id.to_string(),
    }
}

#[tokio::test]
async fn plain_text_stream_emits_ordered_chunks_then_done() {
    let services = FakeServices::new("s-text");
    services.push_script(ScriptStep::Chunks(vec![
        StreamChunk::TextDelta {
            text: "Hel".to_string(),
        },
        StreamChunk::TextDelta {
            text: "lo".to_string(),
        },
        done(3, 2),
    ]));

    let (_cancel_tx, cancel_rx) = oneshot::channel();
    let outcome = run_turn(&services, run_request("s-text"), cancel_rx)
        .await
        .unwrap();

    assert_eq!(
        outcome,
        RunOutcome::Completed {
            input_tokens: 3,
            output_tokens: 2
        }
    );
    let events = services.recorded_events();
    assert_eq!(events.len(), 3);
    assert_eq!(
        events[0],
        ("api-agent:chunk:s-text".to_string(), json!("Hel"))
    );
    assert_eq!(
        events[1],
        ("api-agent:chunk:s-text".to_string(), json!("lo"))
    );
    assert_eq!(events[2].0, "api-agent:done:s-text");
    assert_eq!(events[2].1["input_tokens"], json!(3));
    assert_eq!(events[2].1["output_tokens"], json!(2));
    assert_eq!(events[2].1["cancelled"], json!(false));
    assert_eq!(*services.attempt_reviewing.lock().unwrap(), 1);
}

#[tokio::test]
async fn pending_attachment_on_an_unknown_vision_route_is_refused_before_dispatch() {
    // The fake session's provider/model ("fake"/"fake-model") has no recorded
    // vision capability, so the R4b guard must fail closed BEFORE any provider
    // call. No script is queued: a dispatch would instead fail with "queue
    // exhausted", which this test distinguishes against.
    let mut services = FakeServices::new("s-image");
    let store = Arc::new(FaultCheckpointStore::new());
    services.install_checkpoints(Arc::clone(&store));
    services.set_capability_guard_enabled(true);
    services.set_has_pending_attachments(true);

    let (_cancel_tx, cancel_rx) = oneshot::channel();
    let error = run_turn(&services, run_request("s-image"), cancel_rx)
        .await
        .unwrap_err();

    assert!(
        error.contains("image"),
        "error must name the image: {error}"
    );
    assert!(
        error.contains("vision"),
        "error must name the capability: {error}"
    );
    // Nothing was dispatched, nothing was emitted, and the image was NOT
    // consumed: the guard runs before the drain and before the PreRequest
    // dispatch-intent checkpoint (only UserTurnAccepted was persisted).
    assert_eq!(*services.stream_calls.lock().unwrap(), 0);
    assert!(services.recorded_events().is_empty());
    assert_eq!(services.attachment_drains(), 0);
    assert_eq!(
        store.boundaries(),
        vec![CheckpointBoundary::UserTurnAccepted]
    );
}

#[tokio::test]
async fn pending_attachment_on_a_supported_vision_route_dispatches() {
    // A route with explicit static vision support passes the guard, so the
    // scripted response is consumed normally.
    let mut services = FakeServices::new("s-image-ok");
    services.set_session_route("api-claude", "claude-sonnet-4-5");
    services.set_capability_guard_enabled(true);
    services.set_has_pending_attachments(true);
    services.push_script(text_script("described the image"));

    let (_cancel_tx, cancel_rx) = oneshot::channel();
    let outcome = run_turn(&services, run_request("s-image-ok"), cancel_rx)
        .await
        .unwrap();

    assert_eq!(
        outcome,
        RunOutcome::Completed {
            input_tokens: 2,
            output_tokens: 1
        }
    );
    assert_eq!(*services.stream_calls.lock().unwrap(), 1);
    assert_eq!(services.attachment_drains(), 1);
}

#[tokio::test]
async fn pending_attachment_is_ignored_when_the_guard_is_disabled() {
    // With the runtime authority off (default), the disabled path is
    // byte-identical: the image is not refused.
    let services = FakeServices::new("s-image-off");
    services.set_has_pending_attachments(true);
    services.push_script(text_script("ok"));

    let (_cancel_tx, cancel_rx) = oneshot::channel();
    let outcome = run_turn(&services, run_request("s-image-off"), cancel_rx)
        .await
        .unwrap();

    assert_eq!(
        outcome,
        RunOutcome::Completed {
            input_tokens: 2,
            output_tokens: 1
        }
    );
    assert_eq!(*services.stream_calls.lock().unwrap(), 1);
}

#[tokio::test]
async fn tool_call_auto_allowed_emits_start_and_result() {
    let services = FakeServices::new("s-tool");
    services.allow_tool("bash");
    services.push_script(bash_call_script());
    services.push_script(text_script("all done"));

    let (_cancel_tx, cancel_rx) = oneshot::channel();
    let outcome = run_turn(&services, run_request("s-tool"), cancel_rx)
        .await
        .unwrap();

    assert_eq!(
        outcome,
        RunOutcome::Completed {
            input_tokens: 7,
            output_tokens: 5
        }
    );
    let events = services.recorded_events();
    let start = events
        .iter()
        .find(|(kind, _)| kind == "api-agent:tool-start:s-tool")
        .expect("tool-start emitted");
    assert_eq!(start.1["id"], json!("t1"));
    assert_eq!(start.1["name"], json!("bash"));
    let result = events
        .iter()
        .find(|(kind, _)| kind == "api-agent:tool-result:s-tool")
        .expect("tool-result emitted");
    assert_eq!(result.1["content"], json!("executed bash"));
    assert_eq!(result.1["is_error"], json!(false));
    assert!(
        !events
            .iter()
            .any(|(kind, _)| kind.starts_with("api-agent:permission-request:")),
        "auto-allowed tool must not prompt"
    );
    assert_eq!(
        services.executed_tools.lock().unwrap().as_slice(),
        &["bash".to_string()]
    );
}

#[tokio::test]
async fn denied_permission_skips_tool_and_emits_denial_result() {
    let services = FakeServices::new("s-deny");
    services.push_script(bash_call_script());
    services.push_script(text_script("ok"));
    services.script_permission(PermissionDecision::Deny {
        reason: Some("stop".to_string()),
    });

    let (_cancel_tx, cancel_rx) = oneshot::channel();
    let outcome = run_turn(&services, run_request("s-deny"), cancel_rx)
        .await
        .unwrap();

    assert_eq!(
        outcome,
        RunOutcome::Completed {
            input_tokens: 7,
            output_tokens: 5
        }
    );
    assert!(
        services.executed_tools.lock().unwrap().is_empty(),
        "denied tool must not execute"
    );
    let events = services.recorded_events();
    assert!(
        events
            .iter()
            .any(|(kind, _)| kind == "api-agent:permission-request:s-deny"),
        "denied path still prompts"
    );
    let result = events
        .iter()
        .find(|(kind, _)| kind == "api-agent:tool-result:s-deny")
        .expect("denial result emitted");
    assert_eq!(result.1["is_error"], json!(true));
    assert_eq!(
        result.1["content"],
        json!("User denied permission for this tool call. User's guidance: stop")
    );
}

#[tokio::test]
async fn cancel_via_oneshot_yields_cancelled_outcome_and_done() {
    let services = FakeServices::new("s-cancel");
    services.push_script(ScriptStep::ChunksThenBlock(vec![StreamChunk::TextDelta {
        text: "partial".to_string(),
    }]));

    let started = Arc::clone(&services.started);
    let (cancel_tx, cancel_rx) = oneshot::channel();
    let canceller = tokio::spawn(async move {
        started.notified().await;
        let _ = cancel_tx.send(());
    });

    let outcome = run_turn(&services, run_request("s-cancel"), cancel_rx)
        .await
        .unwrap();
    canceller.await.unwrap();

    assert_eq!(outcome, RunOutcome::Cancelled);
    let events = services.recorded_events();
    let done = events
        .iter()
        .find(|(kind, _)| kind == "api-agent:done:s-cancel")
        .expect("cancelled done emitted");
    assert_eq!(done.1["cancelled"], json!(true));
    assert_eq!(*services.deny_all_pending.lock().unwrap(), 1);
    assert_eq!(*services.cancel_attempt.lock().unwrap(), 1);
    assert_eq!(*services.attempt_reviewing.lock().unwrap(), 0);
}

#[tokio::test]
async fn provider_stream_error_fails_without_retry() {
    let services = FakeServices::new("s-err");
    services.push_script(ScriptStep::Chunks(vec![StreamChunk::Error {
        message: "boom".to_string(),
    }]));

    let (_cancel_tx, cancel_rx) = oneshot::channel();
    let outcome = run_turn(&services, run_request("s-err"), cancel_rx)
        .await
        .unwrap();

    assert_eq!(outcome, RunOutcome::Failed("boom".to_string()));
    let events = services.recorded_events();
    assert_eq!(events.len(), 1);
    assert_eq!(
        events[0],
        (
            "api-agent:error:s-err".to_string(),
            json!({ "message": "boom" })
        )
    );
    assert_eq!(*services.stream_calls.lock().unwrap(), 1);
    assert_eq!(
        services.attempt_failed.lock().unwrap().as_slice(),
        &["boom".to_string()]
    );
    assert_eq!(*services.attempt_reviewing.lock().unwrap(), 0);
}

#[tokio::test]
async fn provider_transport_error_propagates_as_err_once() {
    let services = FakeServices::new("s-transport");
    services.push_script(ScriptStep::Fail("network down".to_string()));

    let (_cancel_tx, cancel_rx) = oneshot::channel();
    let result = run_turn(&services, run_request("s-transport"), cancel_rx).await;

    assert_eq!(result, Err("network down".to_string()));
    assert_eq!(*services.stream_calls.lock().unwrap(), 1);
    assert!(services.recorded_events().is_empty());
}

#[tokio::test]
async fn journal_disabled_takes_the_unchanged_path() {
    let services = FakeServices::new("s-off");
    assert!(
        services.checkpoints("s-off").await.is_none(),
        "no store without an installed journal sink"
    );
    services.push_script(text_script("hi"));

    let (_cancel_tx, cancel_rx) = oneshot::channel();
    let outcome = run_turn(&services, run_request("s-off"), cancel_rx)
        .await
        .unwrap();
    assert_eq!(
        outcome,
        RunOutcome::Completed {
            input_tokens: 2,
            output_tokens: 1
        }
    );
}

#[tokio::test]
async fn journal_enabled_persists_every_boundary_in_order() {
    let mut services = FakeServices::new("s-journal");
    services.allow_tool("bash");
    services.push_script(bash_call_script());
    services.push_script(text_script("all done"));
    let store = Arc::new(FaultCheckpointStore::new());
    services.install_checkpoints(Arc::clone(&store));

    let (_cancel_tx, cancel_rx) = oneshot::channel();
    let outcome = run_turn(&services, run_request("s-journal"), cancel_rx)
        .await
        .unwrap();
    assert!(matches!(outcome, RunOutcome::Completed { .. }));

    assert_eq!(
        store.boundaries(),
        vec![
            CheckpointBoundary::UserTurnAccepted,
            CheckpointBoundary::PreRequest,
            CheckpointBoundary::AssistantReceipt,
            CheckpointBoundary::ToolIntent,
            CheckpointBoundary::ToolReceipt,
            CheckpointBoundary::PreRequest,
            CheckpointBoundary::AssistantReceipt,
        ]
    );

    let writes = store.writes();
    let intent = writes
        .iter()
        .find(|w| w.boundary == CheckpointBoundary::ToolIntent)
        .expect("tool intent written");
    assert_eq!(intent.pending_effect_ids, vec!["t1".to_string()]);
    let receipt = writes
        .iter()
        .find(|w| w.boundary == CheckpointBoundary::ToolReceipt)
        .expect("tool receipt written");
    assert!(
        receipt.pending_effect_ids.is_empty(),
        "a durable receipt clears the pending effect so it is never replayed"
    );
}

#[tokio::test]
async fn crash_after_mutation_before_receipt_marks_pending_and_never_replays() {
    let mut services = FakeServices::new("s-crash");
    services.allow_tool("bash");
    services.push_script(bash_call_script());
    let store = Arc::new(FaultCheckpointStore::new());
    services.install_checkpoints(Arc::clone(&store));
    // The mutation runs, then the receipt write "crashes" before it commits.
    store.fail_at(CheckpointBoundary::ToolReceipt, 1);

    let (_cancel_tx, cancel_rx) = oneshot::channel();
    let result = run_turn(&services, run_request("s-crash"), cancel_rx).await;
    assert!(
        result.is_err(),
        "a failed durable receipt must fail the turn"
    );

    // The tool executed exactly once and was never retried.
    assert_eq!(
        services.executed_tools.lock().unwrap().as_slice(),
        &["bash".to_string()]
    );
    // No receipt is durable; the last durable write is the pending intent, which
    // is what a later inspect/reconcile turns into needs_reconciliation.
    assert!(store
        .writes()
        .iter()
        .all(|w| w.boundary != CheckpointBoundary::ToolReceipt));
    let last = store.last().expect("a durable write");
    assert_eq!(last.boundary, CheckpointBoundary::ToolIntent);
    assert_eq!(last.pending_effect_ids, vec!["t1".to_string()]);
}

#[tokio::test]
async fn a_failed_user_turn_boundary_fails_closed_before_any_dispatch() {
    // The user-turn boundary is the first durable write. If it cannot commit the
    // turn must fail before anything is dispatched or durably recorded.
    let mut services = FakeServices::new("s-user-turn");
    services.push_script(text_script("should never run"));
    let store = Arc::new(FaultCheckpointStore::new());
    services.install_checkpoints(Arc::clone(&store));
    store.fail_at(CheckpointBoundary::UserTurnAccepted, 1);

    let (_cancel_tx, cancel_rx) = oneshot::channel();
    let result = run_turn(&services, run_request("s-user-turn"), cancel_rx).await;
    assert!(
        result.is_err(),
        "a failed user-turn boundary must fail the turn"
    );
    assert_eq!(*services.stream_calls.lock().unwrap(), 0);
    assert!(store.writes().is_empty());
}

#[tokio::test]
async fn a_failed_pre_request_boundary_fails_closed_before_provider_dispatch() {
    // The dispatch intent is durable BEFORE the provider request goes out, so a
    // request whose intent cannot be committed must never reach the provider.
    let mut services = FakeServices::new("s-pre-request");
    services.push_script(text_script("should never run"));
    let store = Arc::new(FaultCheckpointStore::new());
    services.install_checkpoints(Arc::clone(&store));
    store.fail_at(CheckpointBoundary::PreRequest, 1);

    let (_cancel_tx, cancel_rx) = oneshot::channel();
    let result = run_turn(&services, run_request("s-pre-request"), cancel_rx).await;
    assert!(
        result.is_err(),
        "a failed pre-request boundary must fail the turn"
    );
    assert_eq!(
        *services.stream_calls.lock().unwrap(),
        0,
        "no provider dispatch without a durable intent"
    );
    // The store records only SUCCESSFUL writes, so this proves no pre-request
    // boundary ever committed (the zero stream calls above are what prove the
    // request never went out).
    assert_eq!(store.boundaries(), vec![CheckpointBoundary::UserTurnAccepted]);
}

#[tokio::test]
async fn crashed_intent_reconciles_and_resumes_without_replaying() {
    use crate::core::runtime_checkpoint::{
        self, Checkpoint, CheckpointClassification, CheckpointLimits,
    };
    use crate::core::runtime_journal as journal;
    use crate::core::runtime_journal::open_at;
    use crate::core::runtime_types::{FrozenRuntimeLaunch, PrepareRuntimeRunInput};

    // 1. The runner crashes after the tool mutated but before its receipt.
    let mut services = FakeServices::new("s-reconcile");
    services.allow_tool("bash");
    services.push_script(bash_call_script());
    let store = Arc::new(FaultCheckpointStore::new());
    services.install_checkpoints(Arc::clone(&store));
    store.fail_at(CheckpointBoundary::ToolReceipt, 1);
    let (_cancel_tx, cancel_rx) = oneshot::channel();
    assert!(run_turn(&services, run_request("s-reconcile"), cancel_rx)
        .await
        .is_err());
    assert_eq!(services.executed_tools.lock().unwrap().len(), 1);

    // 2. Persist the last durable intent into a real journal run.
    let dir = std::env::temp_dir().join(format!("packetbench-reconcile-{}", uuid::Uuid::new_v4()));
    let connection = open_at(&dir.join("journal.db")).unwrap();
    let prepared = journal::prepare_operation(
        &connection,
        &PrepareRuntimeRunInput {
            operation_id: "op-reconcile".into(),
            conversation_id: "conv-reconcile".into(),
            kind: "initial".into(),
            retry_of_operation_id: None,
            request_digest: format!("sha256:{}", "ab".repeat(32)),
            launch: FrozenRuntimeLaunch {
                route: "fake".into(),
                model: "fake-model".into(),
                requested_isolation: "checkout".into(),
                draft_id: "d1".into(),
                draft_revision: "1".into(),
                project_key: "local:.".into(),
                base_path: ".".into(),
                execution: None,
                policy: None,
            },
        },
    )
    .unwrap();

    let last = store.last().expect("a durable write");
    let checkpoint = Checkpoint {
        checkpoint_id: uuid::Uuid::new_v4().to_string(),
        run_id: prepared.run_id.clone(),
        epoch: prepared.epoch,
        seq: 0,
        schema_version: runtime_checkpoint::CHECKPOINT_SCHEMA_VERSION,
        transport_version: runtime_checkpoint::CHECKPOINT_TRANSPORT_VERSION,
        model_route: "fake:fake-model".into(),
        manifest_hash: runtime_checkpoint::hash_payload("fake"),
        tool_policy_hash: runtime_checkpoint::hash_payload("bash"),
        mcp_hash: runtime_checkpoint::hash_payload(""),
        pending_effect_ids: last.pending_effect_ids.clone(),
        classification: CheckpointClassification::Private,
        messages: last.messages.clone(),
        created_at: 1,
    };
    let encoded = runtime_checkpoint::encode(&checkpoint, &CheckpointLimits::default()).unwrap();
    runtime_checkpoint::insert_checkpoint(&connection, &encoded, &CheckpointLimits::default())
        .unwrap();

    // 3. Inspect: the unresolved effect forces needs_reconciliation, but a typed
    //    resume is still offered (it must be settled, not replayed). A full
    //    matching live context verifies the policy/MCP hashes, which the durable
    //    binding cannot reconstruct on its own.
    let context = runtime_checkpoint::CompatibilityContext {
        schema_version: runtime_checkpoint::CHECKPOINT_SCHEMA_VERSION,
        transport_version: runtime_checkpoint::CHECKPOINT_TRANSPORT_VERSION,
        model_route: "fake:fake-model".into(),
        manifest_hash: runtime_checkpoint::hash_payload("fake"),
        tool_policy_hash: runtime_checkpoint::hash_payload("bash"),
        mcp_hash: runtime_checkpoint::hash_payload(""),
    };
    let inspection =
        journal::inspect_resume_with_compatibility(&connection, &prepared.run_id, Some(&context))
            .unwrap();
    assert!(inspection.needs_reconciliation);
    assert_eq!(inspection.pending_effect_ids, vec!["t1".to_string()]);

    // 4. Resume typed bumps the epoch and runs no tool.
    let resumed = journal::resume_run_with_compatibility(
        &connection,
        &prepared.run_id,
        0,
        "typed",
        inspection.inspected_revision.as_deref(),
        Some(&context),
    )
    .unwrap();
    assert_eq!(resumed.epoch, 1);
    assert_eq!(
        services.executed_tools.lock().unwrap().len(),
        1,
        "resume must not replay the completed tool"
    );
}

// --- R5b: per-request budget admission wired into the runner loop. ---------

#[tokio::test]
async fn budget_configured_settles_the_reservation_with_the_actual_on_done() {
    let services = FakeServices::new("s-budget-settle");
    services.set_admission(Ok(BudgetAdmission::Reserved));
    services.set_scripted_actual_usd_micros(Some(1234));
    services.push_script(text_script("ok"));

    let (_cancel_tx, cancel_rx) = oneshot::channel();
    let outcome = run_turn(&services, run_request("s-budget-settle"), cancel_rx)
        .await
        .unwrap();

    assert_eq!(
        outcome,
        RunOutcome::Completed {
            input_tokens: 2,
            output_tokens: 1
        }
    );
    let admits = services.admit_calls();
    assert_eq!(admits.len(), 1);
    assert_eq!(admits[0].0, "s-budget-settle");
    assert_eq!(admits[0].2, "fake");
    assert_eq!(admits[0].3, "fake-model");
    assert_eq!(admits[0].4, 16384);
    let settles = services.settle_calls();
    assert_eq!(settles.len(), 1);
    assert_eq!(settles[0].0, "s-budget-settle");
    assert_eq!(settles[0].1, admits[0].1, "settles the admitted request");
    assert_eq!(settles[0].2, 1234);
    assert!(services.release_calls().is_empty());
    // R5: the request is marked dispatched before it leaves for the provider.
    let marks = services.mark_dispatched_calls();
    assert_eq!(marks.len(), 1, "one dispatch mark for the one request");
    assert_eq!(marks[0].0, "s-budget-settle");
    assert_eq!(marks[0].1, admits[0].1);
}

#[tokio::test]
async fn budget_configured_releases_the_reservation_on_provider_error() {
    let services = FakeServices::new("s-budget-error");
    services.set_admission(Ok(BudgetAdmission::Reserved));
    services.set_scripted_actual_usd_micros(Some(999));
    services.push_script(ScriptStep::Chunks(vec![StreamChunk::Error {
        message: "boom".to_string(),
    }]));

    let (_cancel_tx, cancel_rx) = oneshot::channel();
    let outcome = run_turn(&services, run_request("s-budget-error"), cancel_rx)
        .await
        .unwrap();

    assert_eq!(outcome, RunOutcome::Failed("boom".to_string()));
    assert!(services.settle_calls().is_empty());
    let releases = services.release_calls();
    assert_eq!(releases.len(), 1);
    assert_eq!(releases[0].0, "s-budget-error");
    assert_eq!(releases[0].1, services.admit_calls()[0].1);
}

#[tokio::test]
async fn budget_append_failure_leaves_the_reservation_reserved() {
    // A failed ledger append must NOT release the reservation: freeing the
    // headroom would let unrecorded spend be silently re-admitted.
    let services = FakeServices::new("s-budget-append-fail");
    services.set_admission(Ok(BudgetAdmission::Reserved));
    services.set_scripted_account_error(Some("ledger append failed".to_string()));
    services.push_script(text_script("hi"));

    let (_cancel_tx, cancel_rx) = oneshot::channel();
    let error = run_turn(&services, run_request("s-budget-append-fail"), cancel_rx)
        .await
        .unwrap_err();

    assert!(error.contains("ledger append failed"), "got: {error}");
    assert!(services.settle_calls().is_empty());
    assert!(
        services.release_calls().is_empty(),
        "the reservation must stay reserved on an append failure"
    );
}

#[tokio::test]
async fn budget_configured_releases_the_reservation_on_cancellation() {
    let services = FakeServices::new("s-budget-cancel");
    services.set_admission(Ok(BudgetAdmission::Reserved));
    services.push_script(ScriptStep::ChunksThenBlock(vec![StreamChunk::TextDelta {
        text: "partial".to_string(),
    }]));

    let started = Arc::clone(&services.started);
    let (cancel_tx, cancel_rx) = oneshot::channel();
    let canceller = tokio::spawn(async move {
        started.notified().await;
        let _ = cancel_tx.send(());
    });

    let outcome = run_turn(&services, run_request("s-budget-cancel"), cancel_rx)
        .await
        .unwrap();
    canceller.await.unwrap();

    assert_eq!(outcome, RunOutcome::Cancelled);
    assert!(services.settle_calls().is_empty());
    let releases = services.release_calls();
    assert_eq!(releases.len(), 1);
    assert_eq!(releases[0].0, "s-budget-cancel");
    assert_eq!(releases[0].1, services.admit_calls()[0].1);
    // The request was dispatched before the cancel, so a real store retains the
    // reservation as uncertain rather than freeing the headroom.
    let marks = services.mark_dispatched_calls();
    assert_eq!(marks.len(), 1);
    assert_eq!(marks[0].1, services.admit_calls()[0].1);
}

#[tokio::test]
async fn the_runner_records_a_run_manifest_once_per_turn() {
    let services = FakeServices::new("s-manifest");
    services.push_script(text_script("hi"));

    let (_cancel_tx, cancel_rx) = oneshot::channel();
    let outcome = run_turn(&services, run_request("s-manifest"), cancel_rx)
        .await
        .unwrap();

    assert!(matches!(outcome, RunOutcome::Completed { .. }));
    assert_eq!(
        services.manifest_calls(),
        1,
        "one manifest per turn, before any dispatch"
    );
}

#[tokio::test]
async fn no_budget_reserves_nothing_and_leaves_the_event_stream_unchanged() {
    let services = FakeServices::new("s-no-budget");
    services.push_script(text_script("hi"));

    let (_cancel_tx, cancel_rx) = oneshot::channel();
    let outcome = run_turn(&services, run_request("s-no-budget"), cancel_rx)
        .await
        .unwrap();

    assert_eq!(
        outcome,
        RunOutcome::Completed {
            input_tokens: 2,
            output_tokens: 1
        }
    );
    // Admission is the budget probe, so it is always consulted; with no budget
    // it returns `NotConfigured` and no reservation lifecycle call follows.
    let admits = services.admit_calls();
    assert_eq!(admits.len(), 1);
    assert!(services.settle_calls().is_empty());
    assert!(services.release_calls().is_empty());
    // No reservation -> no dispatch marker either.
    assert!(services.mark_dispatched_calls().is_empty());
    let events = services.recorded_events();
    assert_eq!(events.len(), 2);
    assert_eq!(
        events[0],
        ("api-agent:chunk:s-no-budget".to_string(), json!("hi"))
    );
    assert_eq!(events[1].0, "api-agent:done:s-no-budget");
    assert_eq!(events[1].1["cancelled"], json!(false));
}

#[tokio::test]
async fn budget_refusal_fails_before_dispatch_and_reserves_nothing() {
    let services = FakeServices::new("s-budget-refused");
    services.set_admission(Err("No price is known for this route".to_string()));
    services.push_script(text_script("should never run"));

    let (_cancel_tx, cancel_rx) = oneshot::channel();
    let error = run_turn(&services, run_request("s-budget-refused"), cancel_rx)
        .await
        .unwrap_err();

    assert!(error.contains("No price is known"));
    assert_eq!(*services.stream_calls.lock().unwrap(), 0);
    assert!(services.recorded_events().is_empty());
    assert!(services.settle_calls().is_empty());
    assert!(services.release_calls().is_empty());
    // A refused request never dispatched, so nothing is marked.
    assert!(services.mark_dispatched_calls().is_empty());
}

#[tokio::test]
async fn a_multi_iteration_turn_settles_each_request_without_releasing() {
    let services = FakeServices::new("s-multi");
    services.allow_tool("bash");
    services.set_admission(Ok(BudgetAdmission::Reserved));
    services.set_scripted_actual_usd_micros(Some(50));
    services.push_script(bash_call_script());
    services.push_script(text_script("done"));

    let (_cancel_tx, cancel_rx) = oneshot::channel();
    let outcome = run_turn(&services, run_request("s-multi"), cancel_rx)
        .await
        .unwrap();
    assert!(matches!(outcome, RunOutcome::Completed { .. }));

    let admits = services.admit_calls();
    assert_eq!(admits.len(), 2, "one admission per provider iteration");
    assert_ne!(
        admits[0].1, admits[1].1,
        "each request gets a distinct request_id"
    );
    let settles = services.settle_calls();
    assert_eq!(settles.len(), 2, "each request settles");
    assert_eq!(settles[0].1, admits[0].1);
    assert_eq!(settles[1].1, admits[1].1);
    assert_eq!(settles[0].2, 50);
    assert_eq!(settles[1].2, 50);
    assert!(services.release_calls().is_empty());
    // Each provider iteration marks its own request dispatched before streaming.
    let marks = services.mark_dispatched_calls();
    assert_eq!(marks.len(), 2);
    assert_eq!(marks[0].1, admits[0].1);
    assert_eq!(marks[1].1, admits[1].1);
}

#[tokio::test]
async fn a_done_without_an_accounted_actual_releases_the_reservation() {
    // A host that reports `Done` but returns `None` from `account_request_chunk`
    // violates the contract; the reservation must not survive the iteration.
    let services = FakeServices::new("s-done-none");
    services.set_admission(Ok(BudgetAdmission::Reserved));
    services.set_scripted_actual_usd_micros(None);
    services.push_script(text_script("ok"));

    let (_cancel_tx, cancel_rx) = oneshot::channel();
    let outcome = run_turn(&services, run_request("s-done-none"), cancel_rx)
        .await
        .unwrap();

    assert_eq!(
        outcome,
        RunOutcome::Completed {
            input_tokens: 2,
            output_tokens: 1
        }
    );
    assert!(services.settle_calls().is_empty());
    let releases = services.release_calls();
    assert_eq!(releases.len(), 1);
    assert_eq!(releases[0].0, "s-done-none");
    assert_eq!(releases[0].1, services.admit_calls()[0].1);
}

#[tokio::test]
async fn a_settle_error_leaves_the_reservation_reserved_and_fails_the_turn() {
    // The ledger append already succeeded, so a settle failure must NOT release
    // the reservation; it surfaces as a turn error instead.
    let services = FakeServices::new("s-settle-error");
    services.set_admission(Ok(BudgetAdmission::Reserved));
    services.set_scripted_actual_usd_micros(Some(7));
    services.set_scripted_settle_error(Some("journal settle failed".to_string()));
    services.push_script(text_script("ok"));

    let (_cancel_tx, cancel_rx) = oneshot::channel();
    let error = run_turn(&services, run_request("s-settle-error"), cancel_rx)
        .await
        .unwrap_err();

    assert!(error.contains("journal settle failed"), "got: {error}");
    assert_eq!(services.settle_calls().len(), 1);
    assert!(
        services.release_calls().is_empty(),
        "a settle error must not release the reservation"
    );
}

// --- R6: context accounting/projection wired into the runner loop. -----------

#[tokio::test]
async fn context_projection_records_a_snapshot_when_the_window_fits() {
    let mut services = FakeServices::new("s-ctx-fit");
    let store = Arc::new(FaultCheckpointStore::new());
    services.install_checkpoints(Arc::clone(&store));
    services.set_capability_guard_enabled(true);
    services.set_context_window(Some(1_000_000));
    services.push_script(text_script("ok"));

    let (_cancel_tx, cancel_rx) = oneshot::channel();
    let outcome = run_turn(&services, run_request("s-ctx-fit"), cancel_rx)
        .await
        .unwrap();

    assert_eq!(
        outcome,
        RunOutcome::Completed {
            input_tokens: 2,
            output_tokens: 1
        }
    );
    assert_eq!(*services.stream_calls.lock().unwrap(), 1);
    let snapshots = services.recorded_context_snapshots();
    assert_eq!(snapshots.len(), 1, "one snapshot per provider iteration");
    assert_eq!(snapshots[0].window_tokens, Some(1_000_000));
    assert!(snapshots[0].blockers.is_empty());
    assert_eq!(snapshots[0].count_kind, "estimate");
}

#[tokio::test]
async fn context_projection_blocks_over_the_window_before_dispatch() {
    let mut services = FakeServices::new("s-ctx-block");
    let store = Arc::new(FaultCheckpointStore::new());
    services.install_checkpoints(Arc::clone(&store));
    services.set_capability_guard_enabled(true);
    services.set_context_window(Some(1));
    services.push_script(text_script("should never run"));

    let (_cancel_tx, cancel_rx) = oneshot::channel();
    let error = run_turn(&services, run_request("s-ctx-block"), cancel_rx)
        .await
        .unwrap_err();

    assert!(error.contains("blocked_context"), "got: {error}");
    // The overflow blocks before any provider dispatch or admission.
    assert_eq!(*services.stream_calls.lock().unwrap(), 0);
    assert!(services.recorded_events().is_empty());
    assert!(services.admit_calls().is_empty());
    let snapshots = services.recorded_context_snapshots();
    assert_eq!(snapshots.len(), 1);
    assert_eq!(snapshots[0].blockers, vec!["context_overflow".to_string()]);
}

#[tokio::test]
async fn context_projection_prefers_the_session_carried_window_over_the_trait_method() {
    let mut services = FakeServices::new("s-ctx-session-window");
    services.set_capability_guard_enabled(true);
    // The session carries a window that overflows; the trait method would
    // return a large window that fits. The session value must win.
    services.set_session_context_window(Some(1));
    services.set_context_window(Some(1_000_000));
    services.push_script(text_script("should never run"));

    let (_cancel_tx, cancel_rx) = oneshot::channel();
    let error = run_turn(&services, run_request("s-ctx-session-window"), cancel_rx)
        .await
        .unwrap_err();

    assert!(error.contains("blocked_context"), "got: {error}");
    assert_eq!(*services.stream_calls.lock().unwrap(), 0);
    assert_eq!(
        services.context_window_calls(),
        0,
        "the session window short-circuits the trait method"
    );
    let snapshots = services.recorded_context_snapshots();
    assert_eq!(snapshots.len(), 1);
    assert_eq!(snapshots[0].window_tokens, Some(1));
}

#[tokio::test]
async fn context_projection_falls_back_to_the_trait_window_when_the_session_carries_none() {
    let services = FakeServices::new("s-ctx-trait-window");
    services.set_capability_guard_enabled(true);
    // No session window, so the trait-method override governs.
    services.set_context_window(Some(1));
    services.push_script(text_script("should never run"));

    let (_cancel_tx, cancel_rx) = oneshot::channel();
    let error = run_turn(&services, run_request("s-ctx-trait-window"), cancel_rx)
        .await
        .unwrap_err();

    assert!(error.contains("blocked_context"), "got: {error}");
    assert_eq!(
        services.context_window_calls(),
        1,
        "the trait method is consulted when the session carries no window"
    );
    let snapshots = services.recorded_context_snapshots();
    assert_eq!(snapshots.len(), 1);
    assert_eq!(snapshots[0].window_tokens, Some(1));
}

#[tokio::test]
async fn context_projection_is_inert_when_the_journal_is_disabled() {
    let services = FakeServices::new("s-ctx-off");
    services.push_script(text_script("hi"));

    let (_cancel_tx, cancel_rx) = oneshot::channel();
    let outcome = run_turn(&services, run_request("s-ctx-off"), cancel_rx)
        .await
        .unwrap();

    assert_eq!(
        outcome,
        RunOutcome::Completed {
            input_tokens: 2,
            output_tokens: 1
        }
    );
    assert!(services.recorded_context_snapshots().is_empty());
    // The disabled path is byte-identical: no projection, unchanged events.
    let events = services.recorded_events();
    assert_eq!(events.len(), 2);
    assert_eq!(
        events[0],
        ("api-agent:chunk:s-ctx-off".to_string(), json!("hi"))
    );
    assert_eq!(events[1].0, "api-agent:done:s-ctx-off");
}

#[tokio::test]
async fn context_projection_blocks_image_only_overflow_before_dispatch() {
    let mut services = FakeServices::new("s-ctx-image");
    services.set_capability_guard_enabled(true);
    // No tools, so the only variable is the images: 5 * 2000 = 10000 tokens,
    // which with the reserved output exceeds a 20000 window, while the same
    // request with no images (7 + 16384) fits.
    services.set_allowed_tools(Some(Vec::new()));
    services.set_context_window(Some(20_000));
    services.set_pending_attachments(vec![attachment(); 5]);
    services.push_script(text_script("should never run"));

    let (_cancel_tx, cancel_rx) = oneshot::channel();
    let error = run_turn(&services, run_request("s-ctx-image"), cancel_rx)
        .await
        .unwrap_err();

    assert!(error.contains("blocked_context"), "got: {error}");
    assert_eq!(*services.stream_calls.lock().unwrap(), 0);
    // The images were counted, never consumed.
    assert_eq!(services.attachment_drains(), 0);
    assert!(services.recorded_events().is_empty());
    let snapshots = services.recorded_context_snapshots();
    assert_eq!(snapshots.len(), 1);
    assert_eq!(
        snapshots[0].counts.attachments_tokens,
        5 * IMAGE_TOKEN_ESTIMATE
    );
}

#[tokio::test]
async fn context_projection_blocks_tool_schema_only_overflow() {
    let mut services = FakeServices::new("s-ctx-tools");
    services.set_capability_guard_enabled(true);
    let tools = tool_runtime::tool_definitions_for_session(None, None, &[]).await;
    let tools_tokens: u64 = tools
        .iter()
        .map(|tool| estimate_text_tokens(&serde_json::to_string(tool).unwrap()))
        .sum();
    let system_tokens = estimate_text_tokens("You are a test agent.");
    // One token below the tool-bearing total: without the tool schemas this
    // request fits, with them it overflows.
    let window = system_tokens + MAX_OUTPUT_TOKENS + tools_tokens - 1;
    services.set_context_window(Some(window));
    services.push_script(text_script("should never run"));

    let (_cancel_tx, cancel_rx) = oneshot::channel();
    let error = run_turn(&services, run_request("s-ctx-tools"), cancel_rx)
        .await
        .unwrap_err();

    assert!(error.contains("blocked_context"), "got: {error}");
    assert_eq!(*services.stream_calls.lock().unwrap(), 0);
    let snapshots = services.recorded_context_snapshots();
    assert_eq!(snapshots.len(), 1);
    assert_eq!(snapshots[0].counts.tools_tokens, tools_tokens);
}

#[tokio::test]
async fn context_projection_projects_once_per_iteration() {
    let mut services = FakeServices::new("s-ctx-multi");
    services.set_capability_guard_enabled(true);
    services.set_context_window(Some(1_000_000));
    services.allow_tool("bash");
    services.push_script(bash_call_script());
    services.push_script(text_script("done"));

    let (_cancel_tx, cancel_rx) = oneshot::channel();
    let outcome = run_turn(&services, run_request("s-ctx-multi"), cancel_rx)
        .await
        .unwrap();
    assert!(matches!(outcome, RunOutcome::Completed { .. }));

    let snapshots = services.recorded_context_snapshots();
    assert_eq!(snapshots.len(), 2, "one snapshot per provider iteration");
    assert_ne!(
        snapshots[0].content_hash, snapshots[1].content_hash,
        "the histories differ, so the hashes must differ"
    );
}

#[tokio::test]
async fn context_projection_is_not_probed_when_the_journal_is_disabled() {
    let services = FakeServices::new("s-ctx-off-probe");
    services.push_script(text_script("hi"));

    let (_cancel_tx, cancel_rx) = oneshot::channel();
    let outcome = run_turn(&services, run_request("s-ctx-off-probe"), cancel_rx)
        .await
        .unwrap();
    assert!(matches!(outcome, RunOutcome::Completed { .. }));
    // The disabled path never consults the projection seams.
    assert_eq!(services.pending_attachment_count_calls(), 0);
    assert_eq!(services.context_window_calls(), 0);
    assert!(services.recorded_context_snapshots().is_empty());
}

#[tokio::test]
async fn drained_attachments_land_in_the_llm_request() {
    let mut services = FakeServices::new("s-ctx-attach");
    services.set_capability_guard_enabled(true);
    services.set_context_window(Some(1_000_000));
    services.set_pending_attachments(vec![attachment()]);
    services.push_script(text_script("ok"));

    let (_cancel_tx, cancel_rx) = oneshot::channel();
    let outcome = run_turn(&services, run_request("s-ctx-attach"), cancel_rx)
        .await
        .unwrap();
    assert!(matches!(outcome, RunOutcome::Completed { .. }));

    let request = services.last_request().expect("a dispatched request");
    assert_eq!(request.attachments.len(), 1);
    assert_eq!(services.attachment_drains(), 1);
}
