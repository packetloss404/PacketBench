//! Test-only fakes for the R2c deterministic lane.
//!
//! Compiled only under `cfg(test)` (see `mod.rs`). This is not a second
//! runtime: [`ScriptedProvider`] implements the production [`LlmProvider`]
//! stream contract and [`FakeServices`] implements the same [`RuntimeServices`]
//! seam the Tauri adapter does, so `run_turn` executes unchanged against
//! scripted input. Nothing here ships.

use std::collections::{HashSet, VecDeque};
use std::sync::{Arc, Mutex};

use serde_json::{json, Value};
use tokio::sync::{mpsc, oneshot, Notify};

use crate::core::agent_runtime::runner::run_turn;
use crate::core::agent_runtime::{
    EditDecision, EventSink, FlightStatusSink, HistoryStore, PermissionBroker, PermissionDecision,
    PermissionMode, RecordingEventSink, RunOutcome, RunRequest, RuntimeFlags, RuntimeServices,
    RuntimeSession, ToolExecContext,
};
use crate::core::execution::ExecutionTarget;
use crate::core::hooks::HookConfig;
use crate::core::llm_provider::LlmProvider;
use crate::core::llm_types::{
    ChatMessage, ImageAttachment, LlmRequest, StreamChunk, ToolCall, ToolResult,
};
use crate::core::mcp_session::NativeMcpSession;
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
}

#[async_trait::async_trait]
impl LlmProvider for ScriptedProvider {
    async fn stream_chat(
        &self,
        _api_key: &str,
        _request: LlmRequest,
        tx: mpsc::Sender<StreamChunk>,
    ) -> Result<(), String> {
        *self.stream_calls.lock().expect("stream call count") += 1;
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
        }
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
        Vec::new()
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
        _chunk: &StreamChunk,
    ) -> Result<(), String> {
        Ok(())
    }
}

fn done(input: u64, output: u64) -> StreamChunk {
    StreamChunk::Done {
        input_tokens: input,
        output_tokens: output,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
    }
}

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

fn text_script(text: &str) -> ScriptStep {
    ScriptStep::Chunks(vec![
        StreamChunk::TextDelta {
            text: text.to_string(),
        },
        done(2, 1),
    ])
}

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
