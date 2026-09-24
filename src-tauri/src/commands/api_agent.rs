//! API-based agent session management.
//!
//! Implements the agentic tool-use loop: send messages to the LLM,
//! execute tool calls, feed results back, repeat until the model
//! produces a final text response.

use crate::commands::agent_sidecar::{is_sidecar_provider, SidecarManager, SIDECAR_PROVIDERS};
use crate::commands::api_keys;
use crate::commands::provider_stats;
use crate::core::execution::{ExecutionTarget, SshConfig};
use crate::core::hooks::{self, HookEvent};
use crate::core::llm_provider::{get_provider, IN_PROCESS_PROVIDERS};
use crate::core::llm_system_prompt::build_system_prompt;
use crate::core::llm_types::*;
use crate::core::tool_runtime;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tauri::Emitter;
use tokio::sync::{mpsc, oneshot, watch, Mutex};
use tracing::{info, warn};

/// Maximum number of tool-use loop iterations per turn. Set high so a real
/// task runs to completion in one turn (like Cursor / Claude Code) instead of
/// hitting the cap mid-task and forcing the user to hit "Continue". Still
/// bounded to backstop a genuinely runaway agent.
const MAX_TOOL_ITERATIONS: usize = 150;

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
    fn parse(s: &str) -> Option<Self> {
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

/// Shared state for managing active API agent sessions.
pub struct ApiAgentState {
    /// Exactly one in-process turn may own a session at a time. The turn id
    /// makes cleanup compare-and-remove so an older task can never clear a
    /// newer turn's cancellation handle.
    active_turns: Mutex<HashMap<String, ActiveTurn>>,
    next_turn_id: AtomicU64,
    /// Message histories keyed by session_id.
    histories: Mutex<HashMap<String, Vec<ChatMessage>>>,
    /// Session configs keyed by session_id.
    configs: Mutex<HashMap<String, SessionConfig>>,
    /// Pending permission prompts keyed by tool_call id.
    pending_permissions: Mutex<HashMap<(String, String), oneshot::Sender<PermissionDecision>>>,
    /// Pending write_file edits awaiting user approval, keyed by tool_call id.
    pending_edits: Mutex<HashMap<(String, String), oneshot::Sender<EditDecision>>>,
}

struct ActiveTurn {
    id: u64,
    cancel: Option<oneshot::Sender<()>>,
    finished: watch::Sender<bool>,
}

fn drain_session_pending<T>(
    pending: &mut HashMap<(String, String), T>,
    session_id: &str,
) -> Vec<T> {
    let keys: Vec<(String, String)> = pending
        .keys()
        .filter(|(owner, _)| owner == session_id)
        .cloned()
        .collect();
    keys.into_iter()
        .filter_map(|key| pending.remove(&key))
        .collect()
}

struct SessionConfig {
    provider: String,
    model: String,
    execution: ExecutionTarget,
    system_prompt: String,
    // New feature fields — all default to backward-compatible values.
    thinking_enabled: bool,
    pending_attachments: Vec<ImageAttachment>,
    plan_mode: bool,
    permission_mode: PermissionMode,
    auto_allow_tools: HashSet<String>,
    approve_writes: bool,
    /// Optional allowlist of tool names. None = all tools; Some(list) = only those.
    /// Used by the Scout profile for read-only investigation.
    allowed_tools: Option<Vec<String>>,
    /// Optional per-conversation MCP server allowlist. None = all enabled MCP
    /// servers; Some(empty) = no MCP servers.
    enabled_mcp_server_ids: Option<Vec<String>>,
    /// Frozen MCP authority captured when the conversation session starts.
    /// Settings edits cannot broaden this vector until an explicit reconnect.
    mcp_trust_snapshot: Option<Vec<crate::core::mcp_bridge::McpTrustSnapshot>>,
    native_mcp_session: Arc<crate::core::mcp_session::NativeMcpSession>,
    custom_agents: Arc<Vec<crate::commands::custom_agents::CustomAgentDef>>,
    tasks: Arc<crate::core::tool_tasks::SessionTasks>,
}

impl ApiAgentState {
    pub fn new() -> Self {
        Self {
            active_turns: Mutex::new(HashMap::new()),
            next_turn_id: AtomicU64::new(0),
            histories: Mutex::new(HashMap::new()),
            configs: Mutex::new(HashMap::new()),
            pending_permissions: Mutex::new(HashMap::new()),
            pending_edits: Mutex::new(HashMap::new()),
        }
    }

    async fn begin_turn(&self, session_id: &str) -> Result<(u64, oneshot::Receiver<()>), String> {
        loop {
            let mut turns = self.active_turns.lock().await;
            if let Some(turn) = turns.get(session_id) {
                // Subscribe while holding the ownership lock. `watch` retains
                // the completion value, so cleanup cannot race between this
                // check and `.changed()` and strand a queued follow-up.
                let mut finished = turn.finished.subscribe();
                drop(turns);
                let _ = finished.changed().await;
            } else {
                let id = self.next_turn_id.fetch_add(1, Ordering::Relaxed) + 1;
                let (cancel, receiver) = oneshot::channel();
                let (finished, _) = watch::channel(false);
                turns.insert(
                    session_id.to_string(),
                    ActiveTurn {
                        id,
                        cancel: Some(cancel),
                        finished,
                    },
                );
                return Ok((id, receiver));
            }
        }
    }

    async fn cancel_turn(&self, session_id: &str) -> bool {
        let cancel = {
            let mut turns = self.active_turns.lock().await;
            turns
                .get_mut(session_id)
                .and_then(|turn| turn.cancel.take())
        };
        if let Some(cancel) = cancel {
            let _ = cancel.send(());
            true
        } else {
            false
        }
    }

    async fn finish_turn(&self, session_id: &str, turn_id: u64) {
        let mut turns = self.active_turns.lock().await;
        let finished = if turns.get(session_id).is_some_and(|turn| turn.id == turn_id) {
            turns.remove(session_id).map(|turn| turn.finished)
        } else {
            None
        };
        drop(turns);
        if let Some(finished) = finished {
            let _ = finished.send(true);
        }
    }
}

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
fn error_event(session_id: &str) -> String {
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

async fn mark_attempt_reviewing_for_session(session_id: &str) {
    let _ = crate::commands::flight_attempts::update_attempt_status_by_session(
        session_id,
        crate::core::flight::AttemptStatus::Reviewing,
        None,
    )
    .await;
}

async fn mark_attempt_failed_for_session(session_id: &str, message: String) {
    let _ = crate::commands::flight_attempts::update_attempt_status_by_session(
        session_id,
        crate::core::flight::AttemptStatus::Failed,
        Some(message),
    )
    .await;
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

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ResumeMessage {
    role: ChatRole,
    content: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind")]
pub enum ApiAgentWorkspaceInput {
    #[serde(rename = "local", rename_all = "camelCase")]
    Local { project_path: String },
    #[serde(rename = "ssh", rename_all = "camelCase")]
    Ssh {
        server_id: Option<String>,
        host: String,
        port: u16,
        user: String,
        remote_path: String,
        key_path: Option<String>,
        auth_method: Option<String>,
        host_fingerprint: Option<String>,
    },
}

fn sidecar_workspace_value(
    project_path: &str,
    ssh_config: Option<&SshConfig>,
    workspace: Option<ApiAgentWorkspaceInput>,
) -> serde_json::Value {
    if let Some(cfg) = ssh_config {
        return serde_json::json!({
            "kind": "ssh",
            "serverId": cfg.target_id.clone(),
            "host": cfg.host.clone(),
            "port": cfg.port,
            "user": cfg.user.clone(),
            "remotePath": cfg.remote_path.clone(),
            "keyPath": cfg.key_path.clone(),
            "authMethod": cfg.auth_method.clone(),
            "hostFingerprint": cfg.host_fingerprint.clone(),
        });
    }

    if let Some(ApiAgentWorkspaceInput::Local { project_path }) = workspace {
        return serde_json::json!({
            "kind": "local",
            "projectPath": project_path,
        });
    }

    serde_json::json!({
        "kind": "local",
        "projectPath": project_path,
    })
}

fn build_start_history(
    resume_messages: Option<Vec<ResumeMessage>>,
    initial_message: &str,
) -> Vec<ChatMessage> {
    let mut messages: Vec<ChatMessage> = resume_messages
        .unwrap_or_default()
        .into_iter()
        .filter_map(|message| {
            let content = message.content.trim();
            if content.is_empty() {
                return None;
            }
            Some(ChatMessage {
                role: message.role,
                content: MessageContent::text(content.to_string()),
            })
        })
        .collect();
    messages.push(ChatMessage {
        role: ChatRole::User,
        content: MessageContent::text(initial_message),
    });
    messages
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

fn build_assistant_history_message(
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

#[cfg(test)]
mod tests {
    #[test]
    fn premature_provider_eof_is_incomplete_and_cannot_dispatch_tools_or_success() {
        assert!(super::require_provider_completion(false, Ok(()))
            .unwrap_err()
            .contains("incomplete"));
        assert!(super::require_provider_completion(true, Ok(())).is_ok());
        assert_eq!(
            super::require_provider_completion(true, Err("provider failed after done".into()))
                .unwrap_err(),
            "provider failed after done"
        );
    }

    #[test]
    fn completed_root_request_is_accounted_before_a_later_streamed_or_provider_error() {
        for streamed_error in [true, false] {
            let mut recorded = Vec::new();
            let done = StreamChunk::Done {
                input_tokens: 100,
                output_tokens: 25,
                cache_read_input_tokens: 20,
                cache_creation_input_tokens: 0,
            };
            super::account_native_request_chunk("parent", "openai", "gpt-5.5", &done, |entry| {
                recorded.push(entry.clone());
                Ok(())
            })
            .unwrap();
            if streamed_error {
                super::account_native_request_chunk(
                    "parent",
                    "openai",
                    "gpt-5.5",
                    &StreamChunk::Error {
                        message: "next request failed".into(),
                    },
                    |_| panic!("error is not new usage"),
                )
                .unwrap();
            } else {
                // A provider may return Err without emitting any stream chunk.
                let result: Result<(), String> = Err("next request failed".into());
                assert!(result.is_err());
            }
            assert_eq!(recorded.len(), 1);
            assert_eq!(recorded[0].input_tokens, 100);
            assert_eq!(recorded[0].session_id, "parent");
            assert_eq!(recorded[0].agent_id, None);
        }
    }

    #[test]
    fn native_request_accounting_failure_propagates_before_success_and_each_request_is_one_row() {
        let done = StreamChunk::Done {
            input_tokens: 10,
            output_tokens: 2,
            cache_read_input_tokens: 0,
            cache_creation_input_tokens: 0,
        };
        assert_eq!(
            super::account_native_request_chunk("parent", "openai", "gpt-5.5", &done, |_| Err(
                "disk full".into()
            ))
            .unwrap_err(),
            "disk full"
        );
        let mut recorded = Vec::new();
        for _ in 0..2 {
            super::account_native_request_chunk("parent", "openai", "gpt-5.5", &done, |entry| {
                recorded.push(entry.clone());
                Ok(())
            })
            .unwrap();
        }
        assert_eq!(recorded.len(), 2);
        assert_eq!(
            recorded.iter().map(|entry| entry.input_tokens).sum::<u64>(),
            20
        );
    }

    use super::*;
    use crate::commands::mcp::{McpServerConfig, McpServerEntry};
    use std::collections::HashMap;

    #[test]
    fn returned_known_tool_must_be_in_the_effective_session_allowlist() {
        let tools = vec![ToolDefinition {
            name: "grep".into(),
            description: String::new(),
            parameters: serde_json::json!({}),
        }];
        assert!(tool_is_advertised("grep", &tools));
        assert!(!tool_is_advertised("read_file", &tools));
        assert!(!tool_is_advertised("bash", &[]));
    }

    #[test]
    fn child_usage_keeps_actual_model_and_parent_session_attribution() {
        let entry = child_usage_entry(
            "parent-session",
            crate::core::tool_subagent::ChildUsage {
                provider: "anthropic".into(),
                model: "claude-haiku-4-5".into(),
                input_tokens: 100,
                output_tokens: 25,
                cache_read: 20,
                cache_write: 30,
            },
        );
        assert_eq!(entry.session_id, "parent-session");
        assert_eq!(entry.model, "claude-haiku-4-5");
        assert_eq!(entry.agent_id.as_deref(), Some("subagent"));
        assert_eq!(
            entry.cost_usd,
            crate::commands::pricing::calculate_cost("claude-haiku-4-5", 100, 25, 20, 30)
        );
    }

    #[test]
    fn create_pull_request_is_a_risky_tool() {
        // Pushing a branch and opening a PR is an outward-facing side effect
        // under the user's GitHub identity; it must go through the same gate
        // as bash rather than run on the model's authority.
        assert!(RISKY_TOOLS.contains(&"create_pull_request"));
        assert!(!PLAN_MODE_ALLOWED.contains(&"create_pull_request"));
    }

    #[test]
    fn permission_mode_defaults_to_asking() {
        assert_eq!(PermissionMode::default(), PermissionMode::AskForRisky);
        assert_eq!(PermissionMode::parse("auto"), Some(PermissionMode::Auto));
        assert_eq!(PermissionMode::parse("bogus"), None);
    }

    /// edit_file mutates files exactly like write_file, so it must sit behind
    /// the same three gates: risky-tool permission, the pending-edit approval
    /// gate, and the plan-mode block. A tool that writes without approval
    /// would be a security regression.
    #[test]
    fn edit_file_is_gated_like_write_file() {
        assert!(RISKY_TOOLS.contains(&"edit_file"));
        assert!(EDIT_TOOLS.contains(&"edit_file"));
        assert!(!PLAN_MODE_ALLOWED.contains(&"edit_file"));
        // Every edit tool must also be permission-gated.
        for tool in EDIT_TOOLS {
            assert!(
                RISKY_TOOLS.contains(tool),
                "{tool} bypasses the permission gate"
            );
        }
    }

    /// The gate materializes edit_file's proposed content the same way the
    /// executor will, so the diff the user approves is the diff that lands.
    #[test]
    fn edit_file_preview_feeds_the_pending_edit_payload() {
        let args = serde_json::json!({
            "path": "a.rs",
            "old_string": "let x = 1;",
            "new_string": "let x = 2;"
        });
        let after = tool_runtime::preview_edit_file(&args, Some("let x = 1;\n")).unwrap();
        assert_eq!(after, "let x = 2;\n");

        // An ambiguous edit fails in the gate too — nothing is ever queued for
        // approval that the executor would refuse.
        let ambiguous = tool_runtime::preview_edit_file(&args, Some("let x = 1;let x = 1;"));
        assert!(ambiguous.is_err());
    }

    #[test]
    fn build_assistant_history_message_skips_blank_turn_without_tools() {
        assert!(build_assistant_history_message("", &[], None).is_none());
        assert!(build_assistant_history_message(" \n\t", &[], None).is_none());
        // Reasoning alone is not a turn — replaying it would build an assistant
        // message with empty content, which the APIs reject.
        let details = serde_json::json!([{ "type": "reasoning.text", "text": "x" }]);
        assert!(build_assistant_history_message("", &[], Some(details)).is_none());
    }

    #[test]
    fn build_assistant_history_message_keeps_text_turn_without_tools() {
        let message = build_assistant_history_message("done", &[], None).unwrap();

        assert_eq!(message.role, ChatRole::Assistant);
        match message.content {
            MessageContent::Text(text) => assert_eq!(text, "done"),
            MessageContent::Blocks(_) => panic!("expected text content"),
        }
    }

    #[test]
    fn build_assistant_history_message_keeps_tool_turn_without_text() {
        let tool_calls = vec![ToolCall {
            id: "toolu_1".to_string(),
            name: "read_file".to_string(),
            arguments: serde_json::json!({ "path": "README.md" }),
        }];

        let message = build_assistant_history_message("", &tool_calls, None).unwrap();

        assert_eq!(message.role, ChatRole::Assistant);
        match message.content {
            MessageContent::Blocks(blocks) => {
                assert_eq!(blocks.len(), 1);
                match &blocks[0] {
                    ContentBlock::ToolUse {
                        id,
                        name,
                        arguments,
                    } => {
                        assert_eq!(id, "toolu_1");
                        assert_eq!(name, "read_file");
                        assert_eq!(arguments["path"], "README.md");
                    }
                    _ => panic!("expected tool use block"),
                }
            }
            MessageContent::Text(_) => panic!("expected block content"),
        }
    }

    /// MiniMax M3's interleaved-thinking contract: the reasoning payload has to
    /// survive into history alongside the tool call, ahead of the content it
    /// produced, or the reasoning chain breaks on the next tool round.
    #[test]
    fn build_assistant_history_message_preserves_provider_reasoning() {
        let details = serde_json::json!([{ "type": "reasoning.text", "index": 0, "text": "why" }]);
        let tool_calls = vec![ToolCall {
            id: "call_1".to_string(),
            name: "read_file".to_string(),
            arguments: serde_json::json!({}),
        }];

        let message =
            build_assistant_history_message("text", &tool_calls, Some(details.clone())).unwrap();

        match message.content {
            MessageContent::Blocks(blocks) => {
                assert_eq!(blocks.len(), 3);
                match &blocks[0] {
                    ContentBlock::ProviderReasoning { details: stored } => {
                        assert_eq!(stored, &details, "replayed verbatim");
                    }
                    _ => panic!("reasoning must lead the block list"),
                }
                assert!(matches!(blocks[1], ContentBlock::Text { .. }));
                assert!(matches!(blocks[2], ContentBlock::ToolUse { .. }));
            }
            MessageContent::Text(_) => panic!("expected block content"),
        }
    }

    /// A final (no-tool-call) turn that carried reasoning still keeps it, so a
    /// follow-up user turn resumes the same reasoning chain.
    #[test]
    fn build_assistant_history_message_keeps_reasoning_on_a_final_turn() {
        let details = serde_json::json!([{ "type": "reasoning.text", "index": 0, "text": "why" }]);

        let message = build_assistant_history_message("answer", &[], Some(details)).unwrap();

        match message.content {
            MessageContent::Blocks(blocks) => {
                assert_eq!(blocks.len(), 2);
                assert!(matches!(blocks[0], ContentBlock::ProviderReasoning { .. }));
            }
            MessageContent::Text(_) => panic!("expected block content"),
        }
    }

    #[test]
    fn mcp_entry_config_for_sidecar_preserves_non_stdio_server_shape() {
        let entry = McpServerEntry {
            name: "remote".to_string(),
            config: McpServerConfig {
                command: String::new(),
                args: Vec::new(),
                env: HashMap::new(),
            },
            raw_config: serde_json::json!({
                "type": "sse",
                "url": "https://example.test/mcp",
                "headers": { "Authorization": "Bearer token" },
                "disabled": false
            }),
            scope: "project".to_string(),
            disabled: false,
        };

        let config = mcp_entry_config_for_sidecar(entry);

        assert_eq!(
            config.get("type").and_then(serde_json::Value::as_str),
            Some("sse")
        );
        assert_eq!(
            config.get("url").and_then(serde_json::Value::as_str),
            Some("https://example.test/mcp")
        );
        assert!(config.contains_key("headers"));
        assert!(!config.contains_key("disabled"));
        assert!(!config.contains_key("command"));
    }

    #[test]
    fn mcp_entry_config_for_sidecar_keeps_stdio_fallback_fields() {
        let mut env = HashMap::new();
        env.insert("TOKEN".to_string(), "secret".to_string());
        let entry = McpServerEntry {
            name: "local".to_string(),
            config: McpServerConfig {
                command: "node".to_string(),
                args: vec!["server.js".to_string()],
                env,
            },
            raw_config: serde_json::json!({}),
            scope: "global".to_string(),
            disabled: false,
        };

        let config = mcp_entry_config_for_sidecar(entry);

        assert_eq!(
            config.get("type").and_then(serde_json::Value::as_str),
            Some("stdio")
        );
        assert_eq!(
            config.get("command").and_then(serde_json::Value::as_str),
            Some("node")
        );
        assert_eq!(config["args"][0], "server.js");
        assert_eq!(config["env"]["TOKEN"], "secret");
    }

    #[test]
    fn remote_mcp_directive_is_empty_map_and_flag_on() {
        // S8-Phase-B: remote (SSH) sessions forward an EMPTY server map plus
        // `sourceMcpFromFs = true` — the sidecar sources its own remote FS
        // config, so no local command/args/env/secret ever crosses SSH.
        let (servers, source_mcp_from_fs) = remote_mcp_directive();
        assert_eq!(servers, serde_json::json!({}));
        assert!(source_mcp_from_fs);
    }

    #[test]
    fn merge_mcp_entries_for_sidecar_project_disabled_shadows_global() {
        let global = McpServerEntry {
            name: "danger".to_string(),
            config: McpServerConfig {
                command: "node".to_string(),
                args: vec!["danger.js".to_string()],
                env: HashMap::new(),
            },
            raw_config: serde_json::json!({ "command": "node", "args": ["danger.js"] }),
            scope: "global".to_string(),
            disabled: false,
        };
        let project_disabled = McpServerEntry {
            name: "danger".to_string(),
            config: McpServerConfig {
                command: String::new(),
                args: Vec::new(),
                env: HashMap::new(),
            },
            raw_config: serde_json::json!({ "disabled": true }),
            scope: "project".to_string(),
            disabled: true,
        };

        let merged = merge_mcp_entries_for_sidecar(
            vec![global.clone(), project_disabled.clone()],
            None,
            true,
        );

        assert!(!merged.contains_key("danger"));

        // An UNTRUSTED project's `.mcp.json` can neither add a server nor
        // shadow the user's global one: the global entry survives untouched.
        let merged = merge_mcp_entries_for_sidecar(vec![global, project_disabled], None, false);
        assert!(merged.contains_key("danger"));
    }

    #[test]
    fn merge_mcp_entries_for_sidecar_drops_untrusted_project_servers() {
        let project = McpServerEntry {
            name: "repo-supplied".to_string(),
            config: McpServerConfig {
                command: "node".to_string(),
                args: vec!["evil.js".to_string()],
                env: HashMap::new(),
            },
            raw_config: serde_json::json!({ "command": "node", "args": ["evil.js"] }),
            scope: "project".to_string(),
            disabled: false,
        };
        let untrusted = merge_mcp_entries_for_sidecar(vec![project.clone()], None, false);
        assert!(
            untrusted.is_empty(),
            "a repo-supplied stdio server must not be spawned for an untrusted project"
        );
        let trusted = merge_mcp_entries_for_sidecar(vec![project], None, true);
        assert!(trusted.contains_key("repo-supplied"));
    }

    #[tokio::test]
    async fn active_turn_serializes_overlapping_work() {
        let state = ApiAgentState::new();
        let (first_id, _first_rx) = state.begin_turn("session-1").await.unwrap();
        let mut second = Box::pin(state.begin_turn("session-1"));

        assert!(tokio::time::timeout(Duration::from_millis(5), &mut second)
            .await
            .is_err());

        state.finish_turn("session-1", first_id).await;
        assert!(tokio::time::timeout(Duration::from_millis(50), &mut second)
            .await
            .is_ok());
    }

    #[tokio::test]
    async fn cancelled_turn_stays_owned_until_its_task_finishes() {
        let state = ApiAgentState::new();
        let (turn_id, receiver) = state.begin_turn("session-1").await.unwrap();

        assert!(state.cancel_turn("session-1").await);
        assert!(receiver.await.is_ok());
        let mut replacement = Box::pin(state.begin_turn("session-1"));
        assert!(
            tokio::time::timeout(Duration::from_millis(5), &mut replacement)
                .await
                .is_err()
        );

        state.finish_turn("session-1", turn_id).await;
        assert!(
            tokio::time::timeout(Duration::from_millis(50), &mut replacement)
                .await
                .is_ok()
        );
    }

    #[tokio::test]
    async fn stale_turn_cleanup_cannot_remove_a_newer_turn() {
        let state = ApiAgentState::new();
        let (old_id, _old_rx) = state.begin_turn("session-1").await.unwrap();
        state.finish_turn("session-1", old_id).await;
        let (new_id, _new_rx) = state.begin_turn("session-1").await.unwrap();

        state.finish_turn("session-1", old_id).await;

        let mut replacement = Box::pin(state.begin_turn("session-1"));
        assert!(
            tokio::time::timeout(Duration::from_millis(5), &mut replacement)
                .await
                .is_err()
        );
        state.finish_turn("session-1", new_id).await;
        assert!(
            tokio::time::timeout(Duration::from_millis(50), &mut replacement)
                .await
                .is_ok()
        );
    }

    #[test]
    fn pending_prompts_are_drained_by_session_only() {
        let mut pending = HashMap::from([
            (("session-a".to_string(), "tool-1".to_string()), 1),
            (("session-b".to_string(), "tool-1".to_string()), 2),
            (("session-a".to_string(), "tool-2".to_string()), 3),
        ]);

        let mut drained = drain_session_pending(&mut pending, "session-a");
        drained.sort_unstable();
        assert_eq!(drained, vec![1, 3]);
        assert_eq!(pending.len(), 1);
        assert_eq!(pending.values().copied().collect::<Vec<_>>(), vec![2]);
    }
}

/// Fire all SessionEnd hooks (best-effort; failures logged).
async fn fire_session_end_hooks(hooks_list: &[crate::core::hooks::HookConfig], session_id: &str) {
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

/// Map a provider name to the usage-log source string.
fn provider_to_source(provider: &str) -> &'static str {
    match provider {
        "claude" | "anthropic" | "api-claude" => "api-claude",
        "openai" | "api-openai" => "api-openai",
        "openai-agents" | "api-openai-agents" => "api-openai-agents",
        "minimax" | "api-minimax" => "api-minimax",
        "minimax-api" | "api-minimax-api" => "api-minimax-api",
        "openrouter" | "api-openrouter" => "api-openrouter",
        "ollama" | "api-ollama" => "api-ollama",
        "custom" | "api-custom" => "api-custom",
        _ => "api-claude",
    }
}

#[derive(Clone, Serialize)]
struct ErrorPayload {
    message: String,
}

/// S8-Phase-B: the remote-owned MCP directive. When a sidecar session targets
/// a remote (SSH) workspace, the sidecar process itself runs ON the remote host
/// and sources its OWN MCP config from the remote filesystem
/// (`~/.claude/settings.json` + `<project>/.mcp.json`, project-over-global). So
/// Rust forwards an EMPTY server map plus `sourceMcpFromFs = true` instead of
/// building the local config: local commands/secrets never cross SSH, stdio
/// command/args resolve against the remote PATH, and remote project-scoped
/// `.mcp.json` is finally honored. This supersedes Phase-A's local-HTTP
/// forwarding for remote sessions. Local sessions never use this path.
///
/// Returns `(empty_server_map, source_mcp_from_fs = true)`.
fn remote_mcp_directive() -> (serde_json::Value, bool) {
    (serde_json::Value::Object(serde_json::Map::new()), true)
}

/// Build the merged MCP server config to hand to the sidecar when starting a
/// subscription-auth session.
///
/// Sources:
/// - Global: `~/.claude/settings.json` under `mcpServers` (reader lives in
///   `commands::mcp`).
/// - Project: `<project_path>/.mcp.json` under `mcpServers`.
///
/// Merge rule: project entries override global entries on matching server
/// name. Entries with `disabled: true` are dropped.
///
/// Output shape (a JSON object keyed by server name):
/// ```json
/// {
///   "my-server": {
///     "type": "stdio",
///     "command": "/usr/local/bin/my-mcp",
///     "args": ["--flag"],
///     "env": { "TOKEN": "..." }
///   }
/// },
/// "http-server": {
///   "type": "sse",
///   "url": "https://example.test/mcp",
///   "headers": { "Authorization": "Bearer ..." }
/// }
/// ```
/// This preserves Claude/Codex MCP server shapes rather than coercing every
/// entry into stdio. `disabled` is consumed locally and not forwarded.
///
/// Failures reading either scope are logged to stderr; we fall back to
/// whichever scope succeeded (or an empty object if both fail). We never
/// fail the session over MCP config problems.
///
/// This is the LOCAL-session path only. Remote (SSH) sessions never call this —
/// they use [`remote_mcp_directive`] so no local command/args/env/secret ever
/// enters the remote start request.
///
/// `filter` (F9): per-conversation MCP server allowlist. `None` = all
/// enabled servers (back-compat for older conversations). `Some(&[])` =
/// explicitly none. Otherwise only servers whose `name` appears in the
/// slice are forwarded.
async fn build_mcp_config_for_sidecar(
    project_path: &str,
    filter: Option<&[String]>,
) -> serde_json::Value {
    use crate::commands::mcp;
    use serde_json::{Map, Value};

    // `read_mcp_servers` concatenates global entries first, then project
    // entries, so inserting into a map in the returned order naturally lets
    // project scope overwrite global on the same server name.
    let entries = match mcp::read_mcp_servers(project_path.to_string()).await {
        Ok(v) => v,
        Err(e) => {
            eprintln!(
                "build_mcp_config_for_sidecar: failed to read MCP servers for project '{}': {} — sending empty config",
                project_path, e
            );
            return Value::Object(Map::new());
        }
    };

    // `.mcp.json` is repo-supplied: a stdio entry is a command the sidecar
    // will spawn. Only a trusted project may contribute (or shadow) entries.
    let project_trusted = crate::core::project_trust::is_project_trusted(project_path);
    Value::Object(merge_mcp_entries_for_sidecar(
        entries,
        filter,
        project_trusted,
    ))
}

fn merge_mcp_entries_for_sidecar(
    entries: Vec<crate::commands::mcp::McpServerEntry>,
    filter: Option<&[String]>,
    project_trusted: bool,
) -> Map<String, Value> {
    let mut merged: Map<String, Value> = Map::new();
    for entry in entries {
        if entry.scope == "project" && !project_trusted {
            // Untrusted repo: its `.mcp.json` neither adds servers nor
            // disables the user's global ones. Logged once per entry so a
            // "my project server never starts" report is diagnosable.
            warn!(
                target: "packetbench::trust",
                server = %entry.name,
                "project-scope MCP server ignored: project is not in the trusted-projects list"
            );
            continue;
        }
        if let Some(allowed) = filter {
            if !allowed.iter().any(|name| name == &entry.name) {
                continue;
            }
        }
        let name = entry.name.clone();
        if entry.disabled {
            merged.remove(&name);
            continue;
        }
        let obj = mcp_entry_config_for_sidecar(entry);
        // Later (project-scope) insertions overwrite earlier (global-scope)
        // ones with the same key — Rust's `Map::insert` replaces the value.
        merged.insert(name, Value::Object(obj));
    }

    merged
}

fn mcp_entry_config_for_sidecar(entry: crate::commands::mcp::McpServerEntry) -> Map<String, Value> {
    let mut obj = match entry.raw_config {
        Value::Object(map) => map,
        _ => Map::new(),
    };
    obj.remove("disabled");

    let type_is_stdio = obj
        .get("type")
        .and_then(Value::as_str)
        .map(|transport| transport == "stdio")
        .unwrap_or(true);

    if type_is_stdio {
        obj.entry("type".to_string())
            .or_insert_with(|| Value::String("stdio".to_string()));
        if !entry.config.command.is_empty() {
            obj.entry("command".to_string())
                .or_insert_with(|| Value::String(entry.config.command));
        }
        obj.entry("args".to_string()).or_insert_with(|| {
            Value::Array(entry.config.args.into_iter().map(Value::String).collect())
        });
        if !entry.config.env.is_empty() {
            obj.entry("env".to_string())
                .or_insert_with(|| serde_json::json!(entry.config.env));
        }
    }

    obj
}

/// Start a new API agent session.
///
/// `resume_token`: opaque token captured from a prior `done` event (v3,
/// T3.B). When supplied and the provider is a sidecar provider, the sidecar
/// reuses the model-side conversation so the session continues across app
/// restarts. Ignored by in-process providers (their context is rebuilt from
/// the `messages` history the frontend keeps in `agentTaskStore`).
#[tauri::command]
pub async fn start_api_agent_session(
    app_handle: tauri::AppHandle,
    state: tauri::State<'_, Arc<ApiAgentState>>,
    sidecar: tauri::State<'_, Arc<SidecarManager>>,
    session_id: String,
    provider: String,
    model: String,
    project_path: String,
    initial_message: String,
    system_prompt_override: Option<String>,
    thinking_enabled: Option<bool>,
    attachments: Option<Vec<ImageAttachment>>,
    plan_mode: Option<bool>,
    ssh_config: Option<SshConfig>,
    allowed_tools: Option<Vec<String>>,
    resume_token: Option<String>,
    enabled_mcp_server_ids: Option<Vec<String>>,
    mcp_trust_snapshot: Option<Vec<crate::core::mcp_bridge::McpTrustSnapshot>>,
    resume_messages: Option<Vec<ResumeMessage>>,
    permission_mode: Option<String>,
    approve_writes: Option<bool>,
    command_path: Option<String>,
    workspace: Option<ApiAgentWorkspaceInput>,
) -> Result<(), String> {
    // v2 Tier 4 slice B: bump the local-only per-provider launch counter
    // before any routing decision so both sidecar and in-process launches are
    // counted. Best-effort — disk-write failures are logged to stderr and
    // never block the session start.
    provider_stats::record_launch(&provider);

    // Phase 3 slice C: if this provider runs in the sidecar, forward the start
    // request and return early. In-process providers fall through to the
    // existing LlmProvider runtime untouched.
    if is_sidecar_provider(&provider) {
        let is_remote_workspace = ssh_config.is_some();
        let sidecar_workspace = if is_remote_workspace {
            // The sidecar process itself runs on the remote host, so the
            // remote path is local from the sidecar's point of view. Sending
            // `kind: "ssh"` would correctly trip the sidecar's local-transport
            // guard, which is only meant to prevent accidental local execution.
            serde_json::json!({
                "kind": "local",
                "projectPath": project_path.clone(),
            })
        } else {
            sidecar_workspace_value(&project_path, None, workspace)
        };
        if provider == "openai-agents" && !is_remote_workspace {
            super::validate_project_path(&project_path)?;
        }
        let sys_prompt = system_prompt_override.clone().unwrap_or_default();
        let tools = allowed_tools.clone().unwrap_or_default();
        // Every sidecar provider is API-key authenticated. The key is loaded
        // here, from the OS keyring, and handed to the sidecar transiently in
        // `start_session.apiKey` — it is never persisted by the frontend or
        // the sidecar, and never written to the remote host on SSH launches.
        //
        // `claude-oauth` is a historical identifier: it is the Claude Agent SDK
        // row, and since 2026-07 it authenticates with `api-key-anthropic`
        // instead of the Claude.ai subscription credential store. Anthropic's
        // legal-and-compliance page directs third-party developers using the
        // Agent SDK to "use the API key authentication methods described in the
        // Quickstart instead", so the SDK stays and only the credential moved.
        // The id is unchanged because persisted conversations store it in
        // `AgentConversation.provider` and resume with it verbatim.
        //
        // PTY-backed `claude` / `codex` CLI sessions are untouched by this and
        // keep using their own OAuth logins — that is ordinary end-user use.
        let api_key = match provider.as_str() {
            "openai-agents" => Some(api_keys::load_api_key("openai")?),
            "claude-oauth" => Some(api_keys::load_api_key("anthropic")?),
            _ => None,
        };
        // MCP config. For LOCAL sessions, merge global (~/.claude/settings.json)
        // and project (.mcp.json) configs, drop disabled entries, and transform
        // into the shape the Claude Agent SDK expects (see
        // `build_mcp_config_for_sidecar`). For REMOTE (SSH) sessions, the
        // sidecar runs ON the remote host and sources its OWN config from the
        // remote filesystem, so we forward an empty map plus `sourceMcpFromFs`
        // (S8-Phase-B) — no local command/args/env/secret ever crosses SSH, and
        // the remote project-scoped `.mcp.json` is finally honored.
        let (mcp_servers, source_mcp_from_fs) = if is_remote_workspace {
            remote_mcp_directive()
        } else {
            (
                build_mcp_config_for_sidecar(&project_path, enabled_mcp_server_ids.as_deref())
                    .await,
                false,
            )
        };
        let sidecar_project_path = project_path.clone();
        // A locally pinned Codex executable path is not meaningful on the
        // remote host. Remote sidecars resolve provider CLIs from the remote
        // PATH; explicit remote overrides can be added once the server model
        // has a field for them.
        let sidecar_command_path = if is_remote_workspace {
            None
        } else {
            command_path.clone()
        };
        // v3: pass attachments through to the sidecar — Anthropic provider
        // builds an image-block content array when present.
        let attachments_json = match &attachments {
            Some(a) => serde_json::to_value(a).unwrap_or(serde_json::Value::Null),
            None => serde_json::Value::Null,
        };
        let resume_messages_json = match &resume_messages {
            Some(messages) => serde_json::to_value(messages).unwrap_or(serde_json::Value::Null),
            None => serde_json::Value::Null,
        };
        let mcp_trust_snapshot_json = match &mcp_trust_snapshot {
            Some(snapshot) => serde_json::to_value(snapshot).unwrap_or(serde_json::Value::Null),
            None => serde_json::Value::Null,
        };
        let result = if let Some(ssh_config) = ssh_config.clone() {
            sidecar
                .forward_start_ssh_with_mcp_trust(
                    session_id.clone(),
                    provider.clone(),
                    model.clone(),
                    sys_prompt,
                    tools,
                    mcp_servers,
                    source_mcp_from_fs,
                    sidecar_project_path,
                    initial_message.clone(),
                    api_key,
                    resume_token.clone(),
                    thinking_enabled,
                    plan_mode,
                    attachments_json,
                    resume_messages_json,
                    permission_mode.clone(),
                    approve_writes,
                    sidecar_command_path,
                    Some(sidecar_workspace),
                    mcp_trust_snapshot_json,
                    ssh_config,
                )
                .await
        } else {
            sidecar
                .forward_start_with_mcp_trust(
                    session_id.clone(),
                    provider.clone(),
                    model.clone(),
                    sys_prompt,
                    tools,
                    mcp_servers,
                    source_mcp_from_fs,
                    sidecar_project_path,
                    initial_message.clone(),
                    api_key,
                    resume_token.clone(),
                    thinking_enabled,
                    plan_mode,
                    attachments_json,
                    resume_messages_json,
                    permission_mode.clone(),
                    approve_writes,
                    sidecar_command_path,
                    Some(sidecar_workspace),
                    mcp_trust_snapshot_json,
                )
                .await
        };
        if let Err(e) = result {
            warn!(session_id = %session_id, error = %e, "Sidecar forward_start failed");
            let _ = app_handle.emit(
                &error_event(&session_id),
                ErrorPayload { message: e.clone() },
            );
            return Err(e);
        }
        return Ok(());
    }

    // Fail loudly, and early, on a provider id nothing here can route.
    //
    // The old failure mode was a red herring: an unroutable id (typically an
    // agent-config id with the `api-` prefix stripped, e.g. `api-claude` ->
    // "claude") sailed past this point and died inside `load_api_key` with
    // "No API key configured for claude", sending the user to Settings to fix
    // a key for a provider that does not exist. Name the bad id and the ids
    // that are actually accepted instead.
    if let Err(unknown) = get_provider(&provider) {
        let message = format!(
            "{unknown}. Expected a canonical provider id — one of {} (sidecar) or {} (in-process). \
             Agent-config ids must be mapped, not prefix-stripped: \"api-claude\" is \"anthropic\", not \"claude\".",
            SIDECAR_PROVIDERS.join(", "),
            IN_PROCESS_PROVIDERS.join(", "),
        );
        warn!(session_id = %session_id, provider = %provider, "Unroutable provider id");
        let _ = app_handle.emit(
            &error_event(&session_id),
            ErrorPayload {
                message: message.clone(),
            },
        );
        return Err(message);
    }

    // Decide execution target. For SSH we skip the local-path validation and
    // use the remote path as the workspace label in the prompt.
    let execution = if let Some(cfg) = ssh_config {
        ExecutionTarget::Ssh { config: cfg }
    } else {
        super::validate_project_path(&project_path)?;
        ExecutionTarget::Local {
            project_path: project_path.clone(),
        }
    };

    // Load API key (validates provider exists)
    let _api_key = api_keys::load_api_key(&provider)?;

    let prompt_workspace = execution.label();
    let system_prompt = match system_prompt_override {
        Some(p) if !p.is_empty() => p,
        _ => build_system_prompt(&prompt_workspace),
    };

    let parsed_permission_mode = match permission_mode.as_deref() {
        Some(mode) => PermissionMode::parse(mode)
            .ok_or_else(|| format!("Unknown permission mode: {}", mode))?,
        // Absent mode = ask. `Auto` (unprompted bash/write) is opt-in only.
        None => PermissionMode::default(),
    };

    let messages = build_start_history(resume_messages, &initial_message);
    let custom_agent_project = match &execution {
        ExecutionTarget::Local { project_path } => project_path.as_str(),
        ExecutionTarget::Ssh { .. } => "",
    };
    let custom_agents = Arc::new(crate::commands::custom_agents::discover_custom_agents(
        custom_agent_project,
    ));
    let native_mcp_session = Arc::new(match &execution {
        ExecutionTarget::Local { project_path } => {
            let entries = crate::commands::mcp::read_mcp_servers(project_path.clone()).await?;
            crate::core::mcp_session::NativeMcpSession::resolve(
                entries,
                project_path,
                crate::core::project_trust::is_project_trusted(project_path),
                enabled_mcp_server_ids.as_deref(),
                mcp_trust_snapshot.as_deref(),
            )?
        }
        ExecutionTarget::Ssh { .. } => {
            crate::core::mcp_session::NativeMcpSession::for_ssh(enabled_mcp_server_ids.as_deref())?
        }
    });

    // Claim the session before mutating its config/history. A duplicate start
    // cannot overwrite a live turn and inherit the old task's eventual cleanup.
    let (turn_id, cancel_rx) = state.begin_turn(&session_id).await?;

    // Store session config and history
    {
        let mut configs = state.configs.lock().await;
        configs.insert(
            session_id.clone(),
            SessionConfig {
                provider: provider.clone(),
                model: model.clone(),
                execution,
                system_prompt: system_prompt.clone(),
                thinking_enabled: thinking_enabled.unwrap_or(false),
                pending_attachments: attachments.unwrap_or_default(),
                plan_mode: plan_mode.unwrap_or(false),
                permission_mode: parsed_permission_mode,
                auto_allow_tools: HashSet::new(),
                approve_writes: approve_writes.unwrap_or(false),
                allowed_tools,
                enabled_mcp_server_ids,
                mcp_trust_snapshot,
                native_mcp_session,
                custom_agents,
                tasks: Arc::new(crate::core::tool_tasks::SessionTasks::default()),
            },
        );

        let mut histories = state.histories.lock().await;
        histories.insert(session_id.clone(), messages.clone());
    }

    let state_clone = Arc::clone(&state.inner());
    let session_id_clone = session_id.clone();

    info!(
        session_id = %session_id,
        provider = %provider,
        model = %model,
        "Starting API agent session"
    );

    // Spawn the agentic loop
    tokio::spawn(async move {
        let result = run_agent_loop(&app_handle, &state_clone, &session_id_clone, cancel_rx).await;

        if let Err(e) = &result {
            warn!(session_id = %session_id_clone, error = %e, "Agent loop error");
            mark_attempt_failed_for_session(&session_id_clone, e.clone()).await;
            let _ = app_handle.emit(
                &error_event(&session_id_clone),
                ErrorPayload { message: e.clone() },
            );
        }

        state_clone.finish_turn(&session_id_clone, turn_id).await;
    });

    Ok(())
}

/// Send a follow-up message to an active API agent session.
#[tauri::command]
pub async fn send_api_agent_message(
    app_handle: tauri::AppHandle,
    state: tauri::State<'_, Arc<ApiAgentState>>,
    sidecar: tauri::State<'_, Arc<SidecarManager>>,
    session_id: String,
    message: String,
    attachments: Option<Vec<ImageAttachment>>,
) -> Result<(), String> {
    // Phase 3 slice C: forward to sidecar if it owns this session.
    if sidecar.owns_session(&session_id).await {
        let attachments_json = match &attachments {
            Some(a) => serde_json::to_value(a).unwrap_or(serde_json::Value::Null),
            None => serde_json::Value::Null,
        };
        return sidecar
            .forward_send(session_id, message, attachments_json)
            .await;
    }

    // Claim the turn before appending the user message. A rapid follow-up waits
    // for the current owner without leaving a transcript entry that never ran.
    let (turn_id, cancel_rx) = state.begin_turn(&session_id).await?;
    let append_result = {
        let mut histories = state.histories.lock().await;
        match histories.get_mut(&session_id) {
            Some(history) => {
                history.push(ChatMessage {
                    role: ChatRole::User,
                    content: MessageContent::text(&message),
                });
                Ok(())
            }
            None => Err(format!("No active session: {}", session_id)),
        }
    };
    if let Err(error) = append_result {
        state.finish_turn(&session_id, turn_id).await;
        return Err(error);
    }

    // Replace per-turn attachments if caller provided new ones.
    if let Some(new_attachments) = attachments {
        let mut configs = state.configs.lock().await;
        if let Some(cfg) = configs.get_mut(&session_id) {
            cfg.pending_attachments = new_attachments;
        }
    }

    let state_clone = Arc::clone(&state.inner());
    let session_id_clone = session_id.clone();

    tokio::spawn(async move {
        let result = run_agent_loop(&app_handle, &state_clone, &session_id_clone, cancel_rx).await;

        if let Err(e) = &result {
            warn!(session_id = %session_id_clone, error = %e, "Agent loop error");
            mark_attempt_failed_for_session(&session_id_clone, e.clone()).await;
            let _ = app_handle.emit(
                &error_event(&session_id_clone),
                ErrorPayload { message: e.clone() },
            );
        }

        state_clone.finish_turn(&session_id_clone, turn_id).await;
    });

    Ok(())
}

/// Cancel an active API agent session.
#[tauri::command]
pub async fn cancel_api_agent_session(
    state: tauri::State<'_, Arc<ApiAgentState>>,
    sidecar: tauri::State<'_, Arc<SidecarManager>>,
    session_id: String,
) -> Result<(), String> {
    // Phase 3 slice C: forward to sidecar if it owns this session.
    if sidecar.owns_session(&session_id).await {
        return sidecar.forward_cancel(session_id).await;
    }

    if state.cancel_turn(&session_id).await {
        info!(session_id = %session_id, "API agent session cancelled");
    }
    Ok(())
}

/// Change the model for an active session. Subsequent turns will use the new model.
#[tauri::command]
pub async fn change_model(
    state: tauri::State<'_, Arc<ApiAgentState>>,
    sidecar: tauri::State<'_, Arc<SidecarManager>>,
    session_id: String,
    new_model: String,
) -> Result<(), String> {
    // Phase 3 slice C: forward to sidecar if it owns this session. The
    // Anthropic provider hot-swaps via SDK `setModel`; Codex stashes the
    // value for the next spawn.
    if sidecar.owns_session(&session_id).await {
        return sidecar.forward_set_model(session_id, new_model).await;
    }

    let mut configs = state.configs.lock().await;
    let config = configs
        .get_mut(&session_id)
        .ok_or_else(|| format!("No active session: {}", session_id))?;
    config.model = new_model;
    Ok(())
}

/// Toggle plan mode (read-only tool allowlist) for a session.
#[tauri::command]
pub async fn set_plan_mode(
    state: tauri::State<'_, Arc<ApiAgentState>>,
    sidecar: tauri::State<'_, Arc<SidecarManager>>,
    session_id: String,
    enabled: bool,
) -> Result<(), String> {
    // Phase 3 slice C: forward to sidecar if it owns this session. Translate
    // the legacy boolean into the SDK's permission-mode vocabulary:
    // `true` → "plan", `false` → "default".
    if sidecar.owns_session(&session_id).await {
        let mode = if enabled { "plan" } else { "default" };
        return sidecar
            .forward_set_permission_mode(session_id, mode.to_string())
            .await;
    }

    let mut configs = state.configs.lock().await;
    let config = configs
        .get_mut(&session_id)
        .ok_or_else(|| format!("No active session: {}", session_id))?;
    config.plan_mode = enabled;
    Ok(())
}

/// Change the permission mode for a session.
#[tauri::command]
pub async fn set_permission_mode(
    state: tauri::State<'_, Arc<ApiAgentState>>,
    sidecar: tauri::State<'_, Arc<SidecarManager>>,
    session_id: String,
    mode: String,
) -> Result<(), String> {
    // Phase 3 slice C: forward to sidecar if it owns this session. The
    // sidecar's Anthropic provider maps mode strings onto the SDK's
    // `setPermissionMode`; we pass the caller's string through verbatim so
    // the sidecar sees the same vocabulary the frontend picked.
    if sidecar.owns_session(&session_id).await {
        return sidecar.forward_set_permission_mode(session_id, mode).await;
    }

    let parsed =
        PermissionMode::parse(&mode).ok_or_else(|| format!("Unknown permission mode: {}", mode))?;
    let mut configs = state.configs.lock().await;
    let config = configs
        .get_mut(&session_id)
        .ok_or_else(|| format!("No active session: {}", session_id))?;
    config.permission_mode = parsed;
    Ok(())
}

/// Respond to a pending permission request.
#[tauri::command]
pub async fn respond_permission(
    state: tauri::State<'_, Arc<ApiAgentState>>,
    sidecar: tauri::State<'_, Arc<SidecarManager>>,
    session_id: String,
    tool_id: String,
    decision: String,
    reason: Option<String>,
) -> Result<(), String> {
    // Phase 3 slice C: forward to sidecar if it owns this session.
    if sidecar.owns_session(&session_id).await {
        return sidecar
            .forward_permission(session_id, tool_id, decision, reason)
            .await;
    }

    let decision = match decision.as_str() {
        "allow_once" => PermissionDecision::AllowOnce,
        "allow_always" => PermissionDecision::AllowAlways,
        "deny" => PermissionDecision::Deny { reason },
        _ => return Err(format!("Unknown decision: {}", decision)),
    };
    let sender = {
        let mut pending = state.pending_permissions.lock().await;
        pending.remove(&(session_id.clone(), tool_id.clone()))
    };
    if let Some(tx) = sender {
        let _ = tx.send(decision);
    } else {
        warn!(tool_id = %tool_id, "No pending permission for tool_id — likely already timed out or cancelled");
    }
    Ok(())
}

/// Toggle per-session approve-writes mode (user must confirm every write_file).
#[tauri::command]
pub async fn set_approve_writes(
    state: tauri::State<'_, Arc<ApiAgentState>>,
    sidecar: tauri::State<'_, Arc<SidecarManager>>,
    session_id: String,
    enabled: bool,
) -> Result<(), String> {
    // Phase 3 slice C: forward to sidecar if it owns this session. Translate
    // the legacy boolean into the SDK's permission-mode vocabulary:
    // `true` → "acceptEdits" (auto-apply writes), `false` → "default".
    // NOTE: this mapping is lossy — toggling approve_writes on top of an
    // already-customized permission mode will clobber that mode. It matches
    // the pre-sidecar in-process semantics, which also treated the two
    // knobs as orthogonal stores with the last-write winning.
    if sidecar.owns_session(&session_id).await {
        let mode = if enabled { "acceptEdits" } else { "default" };
        return sidecar
            .forward_set_permission_mode(session_id, mode.to_string())
            .await;
    }

    let mut configs = state.configs.lock().await;
    let config = configs
        .get_mut(&session_id)
        .ok_or_else(|| format!("No active session: {}", session_id))?;
    config.approve_writes = enabled;
    Ok(())
}

/// Respond to a pending write-file edit approval. v3: an optional
/// `merged_content` lets the frontend land a partial-apply result (per-hunk
/// acceptance). When present, the sidecar provider writes that content
/// directly and tells the SDK's tool to skip its own write.
#[tauri::command]
pub async fn respond_edit(
    state: tauri::State<'_, Arc<ApiAgentState>>,
    sidecar: tauri::State<'_, Arc<SidecarManager>>,
    session_id: String,
    tool_id: String,
    decision: String,
    merged_content: Option<String>,
) -> Result<(), String> {
    // Phase 3 slice C: forward to sidecar if it owns this session.
    if sidecar.owns_session(&session_id).await {
        let approved = match decision.as_str() {
            "apply" => true,
            "reject" => false,
            _ => return Err(format!("Unknown edit decision: {}", decision)),
        };
        return sidecar
            .forward_edit(session_id, tool_id, approved, merged_content)
            .await;
    }

    let decision = match decision.as_str() {
        "apply" => EditDecision::Apply { merged_content },
        "reject" => EditDecision::Reject,
        _ => return Err(format!("Unknown edit decision: {}", decision)),
    };
    let sender = {
        let mut pending = state.pending_edits.lock().await;
        pending.remove(&(session_id.clone(), tool_id.clone()))
    };
    if let Some(tx) = sender {
        let _ = tx.send(decision);
    } else {
        warn!(tool_id = %tool_id, "No pending edit for tool_id — likely already timed out or cancelled");
    }
    Ok(())
}

/// F8: drain this session's parked permission_request and pending_edit prompts as
/// denied without killing the agent loop. The tool gates each return a
/// "User cancelled this tool" result and the loop continues normally.
#[tauri::command]
pub async fn cancel_pending_tools(
    state: tauri::State<'_, Arc<ApiAgentState>>,
    sidecar: tauri::State<'_, Arc<SidecarManager>>,
    session_id: String,
) -> Result<(), String> {
    if sidecar.owns_session(&session_id).await {
        return sidecar.forward_cancel_pending_tools(session_id).await;
    }

    let perm_senders: Vec<_> = {
        let mut pending = state.pending_permissions.lock().await;
        drain_session_pending(&mut pending, &session_id)
    };
    for tx in perm_senders {
        let _ = tx.send(PermissionDecision::Deny { reason: None });
    }

    let edit_senders: Vec<_> = {
        let mut pending = state.pending_edits.lock().await;
        drain_session_pending(&mut pending, &session_id)
    };
    for tx in edit_senders {
        let _ = tx.send(EditDecision::Reject);
    }

    Ok(())
}

/// Retry / regenerate the last assistant turn. Optionally switch model first.
#[tauri::command]
pub async fn retry_last_turn(
    app_handle: tauri::AppHandle,
    state: tauri::State<'_, Arc<ApiAgentState>>,
    sidecar: tauri::State<'_, Arc<SidecarManager>>,
    session_id: String,
    new_model: Option<String>,
) -> Result<(), String> {
    // Phase 3 slice C: forward to sidecar if it owns this session. If the
    // caller asked for a model swap, push that first so the retry uses the
    // new model; then emit the retry frame itself.
    if sidecar.owns_session(&session_id).await {
        if let Some(model) = new_model {
            sidecar.forward_set_model(session_id.clone(), model).await?;
        }
        return sidecar.forward_retry(session_id).await;
    }

    // Claim before truncating so an overlapping retry cannot mutate the live
    // turn's history. Release the claim on every validation failure.
    let (turn_id, cancel_rx) = state.begin_turn(&session_id).await?;
    let truncate_result = {
        let mut histories = state.histories.lock().await;
        match histories.get_mut(&session_id) {
            Some(history) => {
                if let Some(last_assistant) = history
                    .iter()
                    .rposition(|m| matches!(m.role, ChatRole::Assistant))
                {
                    history.truncate(last_assistant);
                    Ok(())
                } else {
                    Err("No assistant turn to retry".to_string())
                }
            }
            None => Err(format!("No active session: {}", session_id)),
        }
    };
    if let Err(error) = truncate_result {
        state.finish_turn(&session_id, turn_id).await;
        return Err(error);
    }

    // Swap model if requested.
    if let Some(model) = new_model {
        let mut configs = state.configs.lock().await;
        if let Some(cfg) = configs.get_mut(&session_id) {
            cfg.model = model;
        }
    }

    let state_clone = Arc::clone(&state.inner());
    let session_id_clone = session_id.clone();

    tokio::spawn(async move {
        let result = run_agent_loop(&app_handle, &state_clone, &session_id_clone, cancel_rx).await;

        if let Err(e) = &result {
            warn!(session_id = %session_id_clone, error = %e, "Retry loop error");
            mark_attempt_failed_for_session(&session_id_clone, e.clone()).await;
            let _ = app_handle.emit(
                &error_event(&session_id_clone),
                ErrorPayload { message: e.clone() },
            );
        }

        state_clone.finish_turn(&session_id_clone, turn_id).await;
    });

    Ok(())
}

/// Clean up a session's state when done.
#[tauri::command]
pub async fn close_api_agent_session(
    state: tauri::State<'_, Arc<ApiAgentState>>,
    sidecar: tauri::State<'_, Arc<SidecarManager>>,
    session_id: String,
) -> Result<(), String> {
    // Phase 3 slice C: forward to sidecar if it owns this session.
    if sidecar.owns_session(&session_id).await {
        return sidecar.forward_close(session_id).await;
    }

    // Keep the active-turn marker until the task actually unwinds; this blocks
    // a replacement turn from racing with cleanup after close.
    state.cancel_turn(&session_id).await;
    // Remove history and config
    {
        let mut histories = state.histories.lock().await;
        histories.remove(&session_id);
    }
    {
        let mut configs = state.configs.lock().await;
        if let Some(config) = configs.remove(&session_id) {
            config.tasks.clear();
        }
    }
    let permission_senders = {
        let mut pending = state.pending_permissions.lock().await;
        drain_session_pending(&mut pending, &session_id)
    };
    for sender in permission_senders {
        let _ = sender.send(PermissionDecision::Deny { reason: None });
    }
    let edit_senders = {
        let mut pending = state.pending_edits.lock().await;
        drain_session_pending(&mut pending, &session_id)
    };
    for sender in edit_senders {
        let _ = sender.send(EditDecision::Reject);
    }
    info!(session_id = %session_id, "API agent session closed");
    Ok(())
}

/// The core agentic loop: call LLM → execute tools → repeat.
/// E8 — async-dispatched rollup of an in-process executor session's
/// turn totals onto the owning Flight DTO. Mirrors the sidecar-side hook
/// in `agent_sidecar::handle_event`'s `turn_summary` arm but lives here
/// for the LlmProvider-trait path (api-claude / api-openai / api-minimax
/// / api-openrouter / api-ollama). No-op when the session isn't linked
/// to any flight (the common standalone-chat case).
///
/// Called once after each committed root/child `UsageEntry`, so later provider
/// errors or cancellation cannot lose earlier request spend. Terminal events
/// report turn totals but do not repeat this rollup.
fn spawn_executor_cost_rollup(
    app_handle: &tauri::AppHandle,
    session_id: &str,
    model: &str,
    input_tokens: u64,
    output_tokens: u64,
    cache_read: u64,
    cache_write: u64,
    cost_usd: f64,
) {
    let app = app_handle.clone();
    let session_id = session_id.to_string();
    let model = model.to_string();
    tauri::async_runtime::spawn(async move {
        let state_snap = crate::core::storage::load_state();
        let owner = match crate::commands::flight_cost::flight_for_executor_session(
            &state_snap,
            &session_id,
        ) {
            Some(o) => o,
            None => return,
        };
        let total_tokens = input_tokens
            .saturating_add(output_tokens)
            .saturating_add(cache_read)
            .saturating_add(cache_write);
        if let Err(e) = crate::commands::flight_cost::accumulate_executor_cost(
            &owner.flight_id,
            total_tokens,
            cost_usd,
        )
        .await
        {
            warn!(
                flight_id = %owner.flight_id,
                session_id = %session_id,
                error = %e,
                "E8-ACCUM: failed to accumulate in-process executor cost"
            );
            return;
        }
        let _ = app.emit(
            "flight:cost-updated",
            serde_json::json!({
                "flightId": owner.flight_id,
                "inputTokens": input_tokens,
                "outputTokens": output_tokens,
                "cacheReadInputTokens": cache_read,
                "cacheCreationInputTokens": cache_write,
                "totalTokens": total_tokens,
                "costUsd": cost_usd,
                "source": "executor",
                "model": model,
            }),
        );
    });
}

fn child_usage_entry(
    session_id: &str,
    usage: crate::core::tool_subagent::ChildUsage,
) -> crate::commands::usage::UsageEntry {
    let cost = crate::commands::pricing::calculate_cost(
        &usage.model,
        crate::commands::pricing::billable_input_tokens(
            &usage.model,
            usage.input_tokens,
            usage.cache_read,
        ),
        usage.output_tokens,
        usage.cache_read,
        usage.cache_write,
    );
    crate::commands::usage::UsageEntry {
        ts: crate::commands::usage::current_timestamp_iso(),
        source: provider_to_source(&usage.provider).to_string(),
        model: usage.model,
        provider: Some(usage.provider),
        agent_id: Some("subagent".to_string()),
        session_id: session_id.to_string(),
        input_tokens: usage.input_tokens,
        output_tokens: usage.output_tokens,
        cache_read: usage.cache_read,
        cache_write: usage.cache_write,
        cost_usd: cost,
    }
}

fn record_child_usage(
    app: &tauri::AppHandle,
    session_id: &str,
    usage: crate::core::tool_subagent::ChildUsage,
) -> Result<(), String> {
    record_completed_usage(app, &child_usage_entry(session_id, usage))
}

fn record_completed_usage(
    app: &tauri::AppHandle,
    entry: &crate::commands::usage::UsageEntry,
) -> Result<(), String> {
    crate::commands::usage::append_usage_entry(entry)?;
    spawn_executor_cost_rollup(
        app,
        &entry.session_id,
        &entry.model,
        entry.input_tokens,
        entry.output_tokens,
        entry.cache_read,
        entry.cache_write,
        entry.cost_usd,
    );
    Ok(())
}

/// Account each completed provider request before its tools or the next request
/// can run. Terminal events do not write aggregate rows, preventing duplicates.
fn require_provider_completion(completed: bool, result: Result<(), String>) -> Result<(), String> {
    result?;
    if !completed {
        return Err("Provider stream ended before its completion and usage marker; this request is incomplete".into());
    }
    Ok(())
}

fn account_native_request_chunk(
    session_id: &str,
    provider: &str,
    model: &str,
    chunk: &StreamChunk,
    record: impl FnOnce(&crate::commands::usage::UsageEntry) -> Result<(), String>,
) -> Result<(), String> {
    if let StreamChunk::Done {
        input_tokens,
        output_tokens,
        cache_read_input_tokens,
        cache_creation_input_tokens,
    } = chunk
    {
        let mut entry = child_usage_entry(
            session_id,
            crate::core::tool_subagent::ChildUsage {
                provider: provider.into(),
                model: model.into(),
                input_tokens: *input_tokens,
                output_tokens: *output_tokens,
                cache_read: *cache_read_input_tokens,
                cache_write: *cache_creation_input_tokens,
            },
        );
        entry.agent_id = None;
        record(&entry)?;
    }
    Ok(())
}

fn tool_is_advertised(name: &str, tools: &[ToolDefinition]) -> bool {
    tools.iter().any(|tool| tool.name == name)
}

#[allow(clippy::too_many_arguments)]
async fn finish_cancelled_agent_turn(
    app_handle: &tauri::AppHandle,
    state: &Arc<ApiAgentState>,
    session_id: &str,
    input_tokens: u64,
    output_tokens: u64,
    cache_read: u64,
    cache_write: u64,
    hooks_list: &[crate::core::hooks::HookConfig],
) {
    let permission_senders = {
        let mut pending = state.pending_permissions.lock().await;
        drain_session_pending(&mut pending, session_id)
    };
    for sender in permission_senders {
        let _ = sender.send(PermissionDecision::Deny { reason: None });
    }
    let edit_senders = {
        let mut pending = state.pending_edits.lock().await;
        drain_session_pending(&mut pending, session_id)
    };
    for sender in edit_senders {
        let _ = sender.send(EditDecision::Reject);
    }

    if let Err(error) = crate::commands::usage::ensure_usage_accounting_healthy() {
        mark_attempt_failed_for_session(session_id, error.clone()).await;
        let _ = app_handle.emit(&error_event(session_id), ErrorPayload { message: error });
        fire_session_end_hooks(hooks_list, session_id).await;
        return;
    }
    let _ = app_handle.emit(
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

/// Tools that require user permission in `AskForRisky` mode and are refused
/// outright in `DenyAll`. `create_pull_request` pushes the branch and opens a
/// PR under the user's GitHub identity — an outward-facing side effect that
/// must never run on the model's authority alone.
const RISKY_TOOLS: &[&str] = &["bash", "write_file", "edit_file", "create_pull_request"];
/// The only tools allowed while plan mode is active — read-only ones.
const PLAN_MODE_ALLOWED: &[&str] = &["read_file", "list_directory", "grep"];
/// Tools that mutate file content and therefore must go through the
/// pending-edit approval gate (and emit a pre-edit baseline when the gate is
/// off). Every entry here must also be in [`RISKY_TOOLS`].
const EDIT_TOOLS: &[&str] = &["write_file", "edit_file"];

async fn run_agent_loop(
    app_handle: &tauri::AppHandle,
    state: &Arc<ApiAgentState>,
    session_id: &str,
    mut cancel_rx: oneshot::Receiver<()>,
) -> Result<(), String> {
    let (
        provider_name,
        model,
        execution,
        system_prompt,
        thinking_enabled,
        allowed_tools,
        enabled_mcp_server_ids,
        mcp_trust_snapshot,
        custom_agents,
        native_mcp_session,
        tasks,
    ) = {
        let configs = state.configs.lock().await;
        let config = configs
            .get(session_id)
            .ok_or_else(|| format!("No session config: {}", session_id))?;
        (
            config.provider.clone(),
            config.model.clone(),
            config.execution.clone(),
            config.system_prompt.clone(),
            config.thinking_enabled,
            config.allowed_tools.clone(),
            config.enabled_mcp_server_ids.clone(),
            config.mcp_trust_snapshot.clone(),
            Arc::clone(&config.custom_agents),
            Arc::clone(&config.native_mcp_session),
            Arc::clone(&config.tasks),
        )
    };

    let _ = get_provider(&provider_name)?;
    let api_key = api_keys::load_api_key(&provider_name)?;
    let tools = {
        let mut all = tool_runtime::tool_definitions_for_session(
            enabled_mcp_server_ids.as_deref(),
            mcp_trust_snapshot.as_deref(),
            &custom_agents,
        )
        .await;
        let mcp_tools = tokio::select! {
            // A cached discovery has no startup work to cancel. Preserve its
            // connections; the turn cancellation check below handles Stop.
            biased;
            result = native_mcp_session.tool_definitions() => result?,
            _ = &mut cancel_rx => {
                native_mcp_session.close().await;
                finish_cancelled_agent_turn(app_handle, state, session_id, 0, 0, 0, 0, &[]).await;
                return Ok(());
            }
        };
        all.extend(mcp_tools);
        match allowed_tools.as_ref() {
            Some(allow) => all
                .into_iter()
                .filter(|t| allow.iter().any(|n| n == &t.name))
                .collect(),
            None => all,
        }
    };
    let frozen_tools = Arc::new(tools.clone());
    let mut total_input_tokens: u64 = 0;
    let mut total_output_tokens: u64 = 0;
    let mut total_cache_read: u64 = 0;
    let mut total_cache_write: u64 = 0;

    // Load hooks once per loop (covers global + this session's project).
    let project_path_for_hooks = match &execution {
        ExecutionTarget::Local { project_path } => project_path.clone(),
        _ => String::new(),
    };
    let all_hooks = hooks::load_hooks_with_project(&project_path_for_hooks);

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

    for iteration in 0..MAX_TOOL_ITERATIONS {
        // Check cancellation
        if cancel_rx.try_recv().is_ok() {
            finish_cancelled_agent_turn(
                app_handle,
                state,
                session_id,
                total_input_tokens,
                total_output_tokens,
                total_cache_read,
                total_cache_write,
                &all_hooks,
            )
            .await;
            return Ok(());
        }

        // Get current message history
        let messages = {
            let histories = state.histories.lock().await;
            histories.get(session_id).cloned().unwrap_or_default()
        };

        // Take pending attachments (only apply to iteration 0 — tool-result iterations don't re-attach).
        let pending_attachments = if iteration == 0 {
            let mut configs = state.configs.lock().await;
            if let Some(cfg) = configs.get_mut(session_id) {
                std::mem::take(&mut cfg.pending_attachments)
            } else {
                Vec::new()
            }
        } else {
            Vec::new()
        };

        let request = LlmRequest {
            model: model.clone(),
            messages,
            tools: tools.clone(),
            system_prompt: Some(system_prompt.clone()),
            max_tokens: 16384,
            temperature: None,
            attachments: pending_attachments,
            thinking_enabled,
            thinking_budget_tokens: 8000,
            // Stable for the life of the session, so every iteration of this
            // loop lands on the same OpenAI prompt-cache partition.
            cache_key: Some(session_id.to_string()),
        };

        crate::commands::usage::ensure_usage_accounting_healthy()?;
        // Stream the response
        let (tx, mut rx) = mpsc::channel::<StreamChunk>(64);
        let provider_ref = get_provider(&provider_name)?;
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
        let mut request_completed = false;
        // Provider-owned reasoning payload for this assistant turn (MiniMax M3
        // `reasoning_details`). Stored verbatim on the history message so the
        // next iteration replays it and the interleaved-thinking chain holds.
        let mut provider_reasoning: Option<serde_json::Value> = None;

        // Process stream chunks
        loop {
            tokio::select! {
                _ = &mut cancel_rx => {
                    // Abort the detached stream task so the provider's
                    // `stream_chat` stops holding the upstream HTTP connection
                    // and pushing into the now-dropped mpsc channel.
                    stream_handle.abort();
                    finish_cancelled_agent_turn(
                        app_handle,
                        state,
                        session_id,
                        total_input_tokens,
                        total_output_tokens,
                        total_cache_read,
                        total_cache_write,
                        &all_hooks,
                    )
                    .await;
                    return Ok(());
                }
                chunk = rx.recv() => {
                    if let Some(chunk) = &chunk {
                        if let Err(error) = account_native_request_chunk(session_id, &provider_name, &model, chunk,
                            |entry| record_completed_usage(app_handle, entry)) {
                            stream_handle.abort();
                            return Err(error);
                        }
                    }
                    match chunk {
                        None => break, // Channel closed
                        Some(StreamChunk::TextDelta { text }) => {
                            text_content.push_str(&text);
                            let _ = app_handle.emit(&chunk_event(session_id), &text);
                        }
                        Some(StreamChunk::ToolUseStart { id, name }) => {
                            current_tool_id = id.clone();
                            current_tool_name = name.clone();
                            current_tool_args.clear();
                            let _ = app_handle.emit(
                                &tool_start_event(session_id),
                                ToolStartPayload { id, name },
                            );
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
                            let _ = app_handle.emit(
                                &thinking_event(session_id),
                                ThinkingPayload { text },
                            );
                        }
                        Some(StreamChunk::ThinkingStop) => {
                            let _ = app_handle.emit(&thinking_stop_event(session_id), ());
                        }
                        Some(StreamChunk::Error { message }) => {
                            mark_attempt_failed_for_session(session_id, message.clone()).await;
                            let _ = app_handle.emit(
                                &error_event(session_id),
                                ErrorPayload { message },
                            );
                            got_error = true;
                            break;
                        }
                    }
                }
            }
        }

        // Wait for the provider result. Provider-level failures that did not
        // arrive as a StreamChunk are surfaced by the outer loop exactly once.
        let stream_result = stream_handle
            .await
            .map_err(|e| format!("LLM stream task failed: {}", e))?;

        if got_error {
            // The detailed StreamChunk::Error was already emitted above.
            return Ok(());
        }
        require_provider_completion(request_completed, stream_result)?;

        if let Some(assistant_msg) =
            build_assistant_history_message(&text_content, &tool_calls, provider_reasoning)
        {
            let mut histories = state.histories.lock().await;
            if let Some(history) = histories.get_mut(session_id) {
                history.push(assistant_msg);
            }
        }

        // If no tool calls, we're done
        if tool_calls.is_empty() {
            mark_attempt_reviewing_for_session(session_id).await;

            let _ = app_handle.emit(
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
            return Ok(());
        }

        // Re-read config for this iteration — plan_mode/permission_mode/approve_writes may flip mid-session.
        let (plan_mode_active, permission_mode, approve_writes) = {
            let configs = state.configs.lock().await;
            if let Some(cfg) = configs.get(session_id) {
                (cfg.plan_mode, cfg.permission_mode, cfg.approve_writes)
            } else {
                // A session whose config vanished mid-turn must not fall back
                // to unprompted execution.
                (false, PermissionMode::default(), false)
            }
        };

        // Execute tool calls in parallel; each async block handles its own gates.
        let futures: Vec<_> = tool_calls
            .iter()
            .cloned()
            .map(|mut tc| {
                let execution = execution.clone();
                let app_handle = app_handle.clone();
                let session_id = session_id.to_string();
                let state = Arc::clone(state);
                let hooks_for_tool = all_hooks.clone();
                let enabled_mcp_server_ids = enabled_mcp_server_ids.clone();
                let mcp_trust_snapshot = mcp_trust_snapshot.clone();
                // Q2: sub-agent / custom-agent tools inherit the SESSION's
                // provider through this task-local scope (see
                // core::tool_subagent::PARENT_LLM).
                let parent_llm = crate::core::tool_subagent::ParentLlm {
                    provider: provider_name.clone(),
                    model: model.clone(),
                    tools: Arc::clone(&frozen_tools),
                    custom_agents: Arc::clone(&custom_agents),
                    enabled_mcp_server_ids: enabled_mcp_server_ids.clone(),
                    mcp_trust_snapshot: mcp_trust_snapshot.clone(),
                    native_mcp_session: Arc::clone(&native_mcp_session),
                    tasks: Arc::clone(&tasks),
                    record_usage: {
                        let app = app_handle.clone();
                        let session = session_id.clone();
                        Arc::new(move |usage| record_child_usage(&app, &session, usage))
                    },
                };
                async move {
                    if !tool_is_advertised(&tc.name, &parent_llm.tools) {
                        let result = ToolResult {
                            tool_call_id: tc.id.clone(),
                            content: format!("Tool '{}' is outside this session's allowed tool set.", tc.name),
                            is_error: true,
                        };
                        let _ = app_handle.emit(&tool_result_event(&session_id), ToolResultPayload {
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
                        let _ = app_handle.emit(
                            &tool_result_event(&session_id),
                            ToolResultPayload {
                                id: tc.id.clone(),
                                name: tc.name.clone(),
                                content: err.content.clone(),
                                is_error: true,
                                input: serde_json::to_string(&tc.arguments).unwrap_or_default(),
                            },
                        );
                        return (tc.id.clone(), err);
                    }

                    // Permission gate (risky tools only)
                    if RISKY_TOOLS.contains(&tc.name.as_str()) {
                        let auto_allowed = {
                            let configs = state.configs.lock().await;
                            configs
                                .get(&session_id)
                                .map(|c| c.auto_allow_tools.contains(&tc.name))
                                .unwrap_or(false)
                        };

                        let should_ask = !auto_allowed
                            && matches!(permission_mode, PermissionMode::AskForRisky);
                        let should_deny = matches!(permission_mode, PermissionMode::DenyAll);

                        if should_deny {
                            let err = ToolResult {
                                tool_call_id: tc.id.clone(),
                                content: "Permissions: all risky tools are denied.".to_string(),
                                is_error: true,
                            };
                            let _ = app_handle.emit(
                                &tool_result_event(&session_id),
                                ToolResultPayload {
                                    id: tc.id.clone(),
                                    name: tc.name.clone(),
                                    content: err.content.clone(),
                                    is_error: true,
                                    input: serde_json::to_string(&tc.arguments).unwrap_or_default(),
                                },
                            );
                            return (tc.id.clone(), err);
                        }

                        if should_ask {
                            let (tx, rx) = oneshot::channel::<PermissionDecision>();
                            {
                                let mut pending = state.pending_permissions.lock().await;
                                pending.insert((session_id.clone(), tc.id.clone()), tx);
                            }
                            let _ = app_handle.emit(
                                &permission_request_event(&session_id),
                                PermissionRequestPayload {
                                    id: tc.id.clone(),
                                    name: tc.name.clone(),
                                    arguments: serde_json::to_string(&tc.arguments)
                                        .unwrap_or_default(),
                                },
                            );
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
                                    let mut configs = state.configs.lock().await;
                                    if let Some(cfg) = configs.get_mut(&session_id) {
                                        cfg.auto_allow_tools.insert(tc.name.clone());
                                    }
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
                                    let _ = app_handle.emit(
                                        &tool_result_event(&session_id),
                                        ToolResultPayload {
                                            id: tc.id.clone(),
                                            name: tc.name.clone(),
                                            content: err.content.clone(),
                                            is_error: true,
                                            input: serde_json::to_string(&tc.arguments)
                                                .unwrap_or_default(),
                                        },
                                    );
                                    return (tc.id.clone(), err);
                                }
                                Err(_) => {
                                    // Timed out — remove stale entry and deny.
                                    {
                                        let mut pending = state.pending_permissions.lock().await;
                                        pending.remove(&(session_id.clone(), tc.id.clone()));
                                    }
                                    let err = ToolResult {
                                        tool_call_id: tc.id.clone(),
                                        content: "Permission request timed out.".to_string(),
                                        is_error: true,
                                    };
                                    let _ = app_handle.emit(
                                        &tool_result_event(&session_id),
                                        ToolResultPayload {
                                            id: tc.id.clone(),
                                            name: tc.name.clone(),
                                            content: err.content.clone(),
                                            is_error: true,
                                            input: serde_json::to_string(&tc.arguments)
                                                .unwrap_or_default(),
                                        },
                                    );
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
                                let _ = app_handle.emit(
                                    &tool_result_event(&session_id),
                                    ToolResultPayload {
                                        id: tc.id.clone(),
                                        name: tc.name.clone(),
                                        content: err.content.clone(),
                                        is_error: true,
                                        input: serde_json::to_string(&tc.arguments)
                                            .unwrap_or_default(),
                                    },
                                );
                                return (tc.id.clone(), err);
                            }
                        };
                        let resolved_local_path = match &execution {
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
                                        let _ = app_handle.emit(
                                            &tool_result_event(&session_id),
                                            ToolResultPayload {
                                                id: tc.id.clone(),
                                                name: tc.name.clone(),
                                                content: err.content.clone(),
                                                is_error: true,
                                                input: serde_json::to_string(&tc.arguments)
                                                    .unwrap_or_default(),
                                            },
                                        );
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
                                    let _ = app_handle.emit(
                                        &tool_result_event(&session_id),
                                        ToolResultPayload {
                                            id: tc.id.clone(),
                                            name: tc.name.clone(),
                                            content: err.content.clone(),
                                            is_error: true,
                                            input: serde_json::to_string(&tc.arguments)
                                                .unwrap_or_default(),
                                        },
                                    );
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
                                    let _ = app_handle.emit(
                                        &tool_result_event(&session_id),
                                        ToolResultPayload {
                                            id: tc.id.clone(),
                                            name: tc.name.clone(),
                                            content: err.content.clone(),
                                            is_error: true,
                                            input: serde_json::to_string(&tc.arguments)
                                                .unwrap_or_default(),
                                        },
                                    );
                                    return (tc.id.clone(), err);
                                }
                            }
                        };

                        let (tx, rx) = oneshot::channel::<EditDecision>();
                        {
                            let mut pending = state.pending_edits.lock().await;
                            pending.insert((session_id.clone(), tc.id.clone()), tx);
                        }
                        let _ = app_handle.emit(
                            &pending_edit_event(&session_id),
                            PendingEditPayload {
                                id: tc.id.clone(),
                                path,
                                content,
                                before,
                            },
                        );
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
                                let _ = app_handle.emit(
                                    &tool_result_event(&session_id),
                                    ToolResultPayload {
                                        id: tc.id.clone(),
                                        name: tc.name.clone(),
                                        content: err.content.clone(),
                                        is_error: true,
                                        input: serde_json::to_string(&tc.arguments)
                                            .unwrap_or_default(),
                                    },
                                );
                                return (tc.id.clone(), err);
                            }
                            Err(_) => {
                                {
                                    let mut pending = state.pending_edits.lock().await;
                                    pending.remove(&(session_id.clone(), tc.id.clone()));
                                }
                                let err = ToolResult {
                                    tool_call_id: tc.id.clone(),
                                    content: "Edit approval timed out.".to_string(),
                                    is_error: true,
                                };
                                let _ = app_handle.emit(
                                    &tool_result_event(&session_id),
                                    ToolResultPayload {
                                        id: tc.id.clone(),
                                        name: tc.name.clone(),
                                        content: err.content.clone(),
                                        is_error: true,
                                        input: serde_json::to_string(&tc.arguments)
                                            .unwrap_or_default(),
                                    },
                                );
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
                            if let ExecutionTarget::Local { project_path } = &execution {
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
                                let _ = app_handle.emit(
                                    &edit_baseline_event(&session_id),
                                    EditBaselinePayload {
                                        id: tc.id.clone(),
                                        path: path.to_string(),
                                        before,
                                    },
                                );
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
                        let _ = app_handle.emit(
                            &tool_result_event(&session_id),
                            ToolResultPayload {
                                id: tc.id.clone(),
                                name: tc.name.clone(),
                                content: err.content.clone(),
                                is_error: true,
                                input: serde_json::to_string(&tc.arguments).unwrap_or_default(),
                            },
                        );
                        return (tc.id.clone(), err);
                    }

                    // Execute tool. The PARENT_LLM scope hands sub-agent
                    // tools the session's provider (Q2); everything else is
                    // oblivious to it.
                    let result = crate::core::tool_subagent::PARENT_LLM
                        .scope(
                            parent_llm,
                            tool_runtime::execute_tool_with_mcp_trust(
                                &tc,
                                &execution,
                                enabled_mcp_server_ids.as_deref(),
                                mcp_trust_snapshot.as_deref(),
                            ),
                        )
                        .await;
                    let _ = app_handle.emit(
                        &tool_result_event(&session_id),
                        ToolResultPayload {
                            id: tc.id.clone(),
                            name: tc.name.clone(),
                            content: result.content.clone(),
                            is_error: result.is_error,
                            input: serde_json::to_string(&tc.arguments).unwrap_or_default(),
                        },
                    );

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

        let raw_results = tokio::select! {
            _ = &mut cancel_rx => {
                // Dropping join_all drops every in-flight tool future. Child
                // processes and network requests owned by those futures can
                // unwind immediately instead of waiting for the next model
                // iteration to observe cancellation.
                finish_cancelled_agent_turn(
                    app_handle,
                    state,
                    session_id,
                    total_input_tokens,
                    total_output_tokens,
                    total_cache_read,
                    total_cache_write,
                    &all_hooks,
                )
                .await;
                return Ok(());
            }
            results = futures::future::join_all(futures) => results,
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
        {
            let mut histories = state.histories.lock().await;
            if let Some(history) = histories.get_mut(session_id) {
                history.push(ChatMessage {
                    role: ChatRole::Tool,
                    content: MessageContent::Blocks(tool_result_blocks),
                });
            }
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
    mark_attempt_reviewing_for_session(session_id).await;

    let _ = app_handle.emit(
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
    Ok(())
}
