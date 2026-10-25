//! Claude-Code-style sub-agent invocation.
//!
//! Exposes a `spawn_subagent` tool that the main agent can call to delegate a
//! focused, read-only research task to a fresh agent loop. The sub-agent runs
//! synchronously (no Tauri events), executes up to a small number of tool
//! calls against the parent's `ExecutionTarget`, and returns a single summary
//! paragraph.

use crate::core::execution::ExecutionTarget;
use crate::core::llm_provider::get_provider;
use crate::core::llm_types::{
    ChatMessage, ChatRole, ContentBlock, LlmRequest, MessageContent, StreamChunk, ToolCall,
    ToolDefinition,
};
use crate::core::subagent_role::{
    resolve_subagent_role, SubagentResult, SubagentStatus, SUBAGENT_MAX_OUTPUT_TOKENS,
};
use crate::core::tool_runtime;
use std::sync::Arc;
use tokio::sync::mpsc;

/// Tools a sub-agent may never hold, whatever its definition asks for. The
/// sub-agent loop below has no permission prompt, no plan-mode block, and no
/// pending-edit gate — it dispatches straight into `tool_runtime::execute_tool`
/// — so anything here would run on the model's authority alone, routing
/// around every gate the parent session enforces (`commands::api_agent`).
pub(crate) const SUBAGENT_DENIED_TOOLS: &[&str] =
    &["bash", "write_file", "edit_file", "create_pull_request"];

/// True when a sub-agent may execute `tool_name` given the tool set it was
/// handed. The set is the allowlist; the denied list is a floor beneath it.
pub(crate) fn subagent_tool_permitted(tool_name: &str, tools: &[ToolDefinition]) -> bool {
    !SUBAGENT_DENIED_TOOLS.contains(&tool_name) && tools.iter().any(|t| t.name == tool_name)
}

/// The provider/model of the SESSION whose tool loop is currently executing.
///
/// Q2 — sub-agent tools are agentic helpers, not auxiliary tasks: they derive
/// their provider from the parent session instead of aux routing, so a
/// MiniMax-only (or Ollama-only) user's `spawn_subagent` no longer dies on a
/// missing Anthropic key. `api_agent.rs` opens this scope around each tool
/// dispatch; nested sub-agent chains inherit it because the whole chain is
/// awaited inside the scope.
#[derive(Clone)]
pub struct ParentLlm {
    pub provider: String,
    pub model: String,
    pub tools: Arc<Vec<ToolDefinition>>,
    pub custom_agents: Arc<Vec<crate::commands::custom_agents::CustomAgentDef>>,
    pub enabled_mcp_server_ids: Option<Vec<String>>,
    pub mcp_trust_snapshot: Option<Vec<crate::core::mcp_bridge::McpTrustSnapshot>>,
    pub native_mcp_session: Arc<crate::core::mcp_session::NativeMcpSession>,
    pub tasks: Arc<crate::core::tool_tasks::SessionTasks>,
    pub record_usage: Arc<dyn Fn(ChildUsage) -> Result<(), String> + Send + Sync>,
    /// R7: reserves/settles each child model request under the parent session's
    /// root budget scope. `None` is the disabled path (journal off, or a host
    /// that never sets a budget): no reservation is made and behavior is
    /// unchanged.
    pub child_budget: Option<Arc<dyn ChildBudgetHook>>,
    /// R7: the parent turn's cancellation token. When the parent turn is
    /// stopped, the child loop observes it, aborts its in-flight provider stream
    /// and returns [`SubagentStatus::Cancelled`] instead of relying on the
    /// implicit future-drop. Nested children inherit the same token.
    pub cancel: tokio_util::sync::CancellationToken,
}

/// R7 child-request budget seam. Mirrors the runner's per-request admission
/// (`RuntimeServices::admit_request`/`settle_request`/`release_request`) so a
/// child reserves against the SAME root scope as its parent. Implemented by the
/// Tauri host; a fake serves the tests.
#[async_trait::async_trait]
pub trait ChildBudgetHook: Send + Sync {
    /// Reserve for one child request. `Ok(true)` means a durable reservation
    /// now exists and MUST be settled or released; `Ok(false)` means no
    /// reservation was made (journal off / no budget).
    async fn reserve(
        &self,
        request_id: &str,
        provider: &str,
        model: &str,
        messages: &[ChatMessage],
        max_tokens: u64,
    ) -> Result<bool, String>;
    /// Settle a reservation with the exact actual cost.
    async fn settle(&self, request_id: &str, actual_usd_micros: i64) -> Result<(), String>;
    /// Release a reservation that will not be settled.
    async fn release(&self, request_id: &str) -> Result<(), String>;
    /// Mark a reserved child request dispatched the moment it leaves for the
    /// provider, so a later release or a startup reconcile retains it as
    /// uncertain liability instead of freeing headroom the provider may have
    /// billed (R5). Default no-op for a hook that never reserves.
    async fn mark_dispatched(&self, _request_id: &str) -> Result<(), String> {
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ChildUsage {
    pub provider: String,
    pub model: String,
    /// The R7 reservation id this request was admitted under, when one was
    /// made. Carried onto the usage ledger row so startup reconciliation can
    /// settle the matching reservation instead of releasing it.
    pub request_id: Option<String>,
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cache_read: u64,
    pub cache_write: u64,
}

tokio::task_local! {
    pub static PARENT_LLM: ParentLlm;
    static SUBAGENT_DEPTH: usize;
}

/// The ambient parent-session LLM, when a tool loop opened the scope.
pub(crate) fn current_parent_llm() -> Option<ParentLlm> {
    PARENT_LLM.try_with(|parent| parent.clone()).ok()
}

const SUBAGENT_SYSTEM_PROMPT: &str = "You are a focused research sub-agent. Use the read-only tools to investigate the task. After 1-3 tool calls, return a concise one-paragraph summary. Do not produce code or recommendations beyond the summary.";

/// Tool definition advertised to the parent agent.
pub fn spawn_subagent_definition() -> ToolDefinition {
    ToolDefinition {
        name: "spawn_subagent".to_string(),
        description: "Run a focused sub-task in a fresh agent context with read-only tools (read_file, list_directory, grep, web_fetch). The sub-agent runs to completion and returns a single summary paragraph. Use for: research questions, codebase exploration, fact-finding. Do NOT use for: making edits, running shell commands.".to_string(),
        parameters: serde_json::json!({
            "type": "object",
            "properties": {
                "task": {
                    "type": "string",
                    "description": "One-sentence description of what to find."
                },
                "model": {
                    "type": "string",
                    "description": "Optional model override for the sub-agent, validated before dispatch. Omit to inherit the parent session's provider at its fast default."
                }
            },
            "required": ["task"]
        }),
    }
}

/// Build the read-only tool subset the sub-agent is allowed to call.
fn read_only_tool_definitions() -> Result<Vec<ToolDefinition>, String> {
    let allowed = ["read_file", "list_directory", "grep", "web_fetch"];
    let parent = current_parent_llm().ok_or("Sub-agent requires an active conversation")?;
    Ok(parent
        .tools
        .iter()
        .filter(|t| allowed.contains(&t.name.as_str()))
        .cloned()
        .collect())
}

/// Drain a response, retaining opaque provider state for the next tool round.
pub(crate) async fn collect_response(
    mut rx: mpsc::Receiver<StreamChunk>,
    provider: &str,
    model: &str,
    request_id: Option<&str>,
) -> Result<(String, Vec<ToolCall>, Option<serde_json::Value>, ChildUsage), String> {
    let mut text = String::new();
    let mut tool_calls: Vec<ToolCall> = Vec::new();
    let mut provider_reasoning = None;

    while let Some(chunk) = rx.recv().await {
        match chunk {
            StreamChunk::TextDelta { text: t } => text.push_str(&t),
            StreamChunk::ReasoningDetails { details } => provider_reasoning = Some(details),
            StreamChunk::ToolUseEnd {
                id,
                name,
                arguments,
            } => {
                tool_calls.push(ToolCall {
                    id,
                    name,
                    arguments,
                });
            }
            StreamChunk::Error { message } => return Err(message),
            StreamChunk::Done {
                input_tokens,
                output_tokens,
                cache_read_input_tokens,
                cache_creation_input_tokens,
            } => {
                let parent = current_parent_llm()
                    .ok_or("Sub-agent usage requires an active conversation")?;
                let usage = ChildUsage {
                    provider: provider.to_string(),
                    model: model.to_string(),
                    request_id: request_id.map(str::to_string),
                    input_tokens,
                    output_tokens,
                    cache_read: cache_read_input_tokens,
                    cache_write: cache_creation_input_tokens,
                };
                (parent.record_usage)(usage.clone())?;
                return Ok((text, tool_calls, provider_reasoning, usage));
            }
            _ => {}
        }
    }

    Err("Sub-agent stream ended without a completion record".to_string())
}

/// The USD cost of one child request. The SINGLE place the child's cost is
/// derived: the usage ledger (`commands::api_agent::child_usage_entry`) and the
/// budget settle both call this, so they cannot drift.
pub(crate) fn child_usage_cost_usd(usage: &ChildUsage) -> f64 {
    crate::commands::pricing::calculate_cost(
        &usage.model,
        crate::commands::pricing::billable_input_tokens(
            &usage.model,
            usage.input_tokens,
            usage.cache_read,
        ),
        usage.output_tokens,
        usage.cache_read,
        usage.cache_write,
    )
}

/// The exact actual micro-dollars for a child request.
fn child_actual_usd_micros(usage: &ChildUsage) -> i64 {
    (child_usage_cost_usd(usage) * 1_000_000.0).round() as i64
}

/// Fold one request's usage into a running child total.
fn merge_usage(total: &mut Option<ChildUsage>, next: ChildUsage) {
    match total {
        Some(total) => {
            total.input_tokens += next.input_tokens;
            total.output_tokens += next.output_tokens;
            total.cache_read += next.cache_read;
            total.cache_write += next.cache_write;
        }
        None => *total = Some(next),
    }
}

/// Shared agentic tool loop for the sub-agent tools (`spawn_subagent` and
/// custom `agent_*` tools). Runs up to `MAX_ITERATIONS` request→tool-dispatch
/// rounds against `provider`, recursing into `tool_runtime::execute_tool` for
/// each tool call (the recursion is boxed at `execute_tool`'s dispatch site).
///
/// Returns a structured [`SubagentResult`] so the caller can tell a completed
/// child from one that hit the round limit ([`SubagentStatus::Incomplete`]) or
/// was refused admission ([`SubagentStatus::Blocked`]). Hard failures that are
/// not a child outcome (recursion depth, missing parent, provider/stream error)
/// stay `Err`. `empty_error` is returned when the loop finishes without text.
///
/// Task-local depth bounds nested chains without limiting unrelated sessions.
#[allow(clippy::too_many_arguments)]
pub(crate) async fn run_agent_loop(
    provider: &dyn crate::core::llm_provider::LlmProvider,
    api_key: &str,
    model: String,
    system_prompt: String,
    tools: Vec<ToolDefinition>,
    max_tokens: u32,
    max_requests: u32,
    task: String,
    parent_target: &ExecutionTarget,
    empty_error: &str,
) -> Result<SubagentResult, String> {
    let depth = SUBAGENT_DEPTH.try_with(|depth| *depth).unwrap_or(0);
    if depth >= MAX_SUBAGENT_DEPTH {
        return Err(format!(
            "Sub-agent recursion depth ({MAX_SUBAGENT_DEPTH}) exceeded"
        ));
    }
    let mut child_context =
        current_parent_llm().ok_or("Sub-agent requires an active conversation")?;
    child_context.model = model.clone();
    child_context.tools = Arc::new(tools.clone());
    SUBAGENT_DEPTH
        .scope(
            depth + 1,
            PARENT_LLM.scope(
                child_context,
                run_agent_loop_inner(
                    provider,
                    api_key,
                    model,
                    system_prompt,
                    tools,
                    max_tokens,
                    max_requests,
                    task,
                    parent_target,
                    empty_error,
                ),
            ),
        )
        .await
}

/// Best-effort release of a child reservation that will not be settled. Errors
/// are logged, never allowed to mask the original failure.
async fn release_child_reservation(parent: &ParentLlm, request_id: &str) {
    if let Some(hook) = parent.child_budget.as_ref() {
        if let Err(error) = hook.release(request_id).await {
            tracing::warn!(
                request_id = %request_id,
                error = %error,
                "Failed to release a child budget reservation"
            );
        }
    }
}

#[allow(clippy::too_many_arguments)]
async fn run_agent_loop_inner(
    provider: &dyn crate::core::llm_provider::LlmProvider,
    api_key: &str,
    model: String,
    system_prompt: String,
    tools: Vec<ToolDefinition>,
    max_tokens: u32,
    max_requests: u32,
    task: String,
    parent_target: &ExecutionTarget,
    empty_error: &str,
) -> Result<SubagentResult, String> {
    let parent = current_parent_llm().ok_or("Sub-agent requires an active conversation")?;
    let child_run_id = uuid::Uuid::new_v4().to_string();
    let mut messages: Vec<ChatMessage> = vec![ChatMessage {
        role: ChatRole::User,
        content: MessageContent::text(task),
    }];

    let mut final_text = String::new();
    let mut total_usage: Option<ChildUsage> = None;
    // A child owns a separate conversation, stable across its tool rounds.
    let cache_key = uuid::Uuid::new_v4().to_string();

    for iteration in 0..max_requests {
        crate::commands::usage::ensure_usage_accounting_healthy()?;
        let request = LlmRequest {
            model: model.clone(),
            messages: messages.clone(),
            tools: tools.clone(),
            system_prompt: Some(system_prompt.clone()),
            max_tokens,
            temperature: None,
            attachments: Vec::new(),
            thinking_enabled: false,
            thinking_budget_tokens: 0,
            cache_key: Some(cache_key.clone()),
        };

        // R7: reserve against the parent's root scope BEFORE dispatch, exactly
        // as the runner does for its own requests. `None`/`Ok(false)` is the
        // disabled path and leaves this loop byte-identical.
        let request_id = format!("{child_run_id}:{iteration}:{}", uuid::Uuid::new_v4());
        let mut pending_reservation = false;
        if let Some(hook) = parent.child_budget.as_ref() {
            match hook
                .reserve(
                    &request_id,
                    &parent.provider,
                    &model,
                    &messages,
                    max_tokens as u64,
                )
                .await
            {
                Ok(reserved) => pending_reservation = reserved,
                Err(reason) => {
                    return Ok(SubagentResult {
                        child_run_id,
                        status: SubagentStatus::Blocked,
                        summary: reason.clone(),
                        incomplete_reason: Some(reason),
                        usage: total_usage,
                    });
                }
            }
        }

        // R5: the request is about to leave for the provider. Mark it dispatched
        // so a later release (provider error, collect failure) or a startup
        // reconcile retains the reservation as uncertain liability rather than
        // freeing headroom the provider may already have billed.
        if pending_reservation {
            if let Some(hook) = parent.child_budget.as_ref() {
                if let Err(error) = hook.mark_dispatched(&request_id).await {
                    release_child_reservation(&parent, &request_id).await;
                    return Err(error);
                }
            }
        }

        let (tx, rx) = mpsc::channel::<StreamChunk>(64);
        let stream_fut = provider.stream_chat(api_key, request, tx);
        // The reservation id rides the usage row only when a reservation was
        // actually made; the disabled/unconfigured path leaves it `None`.
        let collect_fut = collect_response(
            rx,
            &parent.provider,
            &model,
            if pending_reservation {
                Some(request_id.as_str())
            } else {
                None
            },
        );

        let (stream_res, collected) = tokio::select! {
            joined = async { tokio::join!(stream_fut, collect_fut) } => joined,
            _ = parent.cancel.cancelled() => {
                // R7: the parent turn was stopped. Dropping the joined future
                // aborts the provider stream; release the reservation (a
                // dispatched child becomes uncertain liability in the store) and
                // report an explicit Cancelled outcome rather than a silent drop.
                if pending_reservation {
                    release_child_reservation(&parent, &request_id).await;
                }
                return Ok(SubagentResult {
                    child_run_id,
                    status: SubagentStatus::Cancelled,
                    summary: "The parent turn was cancelled before the sub-agent finished."
                        .to_string(),
                    incomplete_reason: Some("parent_cancelled".to_string()),
                    usage: total_usage,
                });
            }
        };
        let (assistant_text, tool_calls, provider_reasoning, usage) = match collected {
            Ok(collected) => collected,
            Err(error) => {
                if pending_reservation {
                    release_child_reservation(&parent, &request_id).await;
                }
                return Err(error);
            }
        };
        // The usage row is durable (recorded in `collect_response`); settle the
        // reservation with the exact actual. The actual is NOT recorded again,
        // so root/child usage is never double-counted.
        if pending_reservation {
            if let Some(hook) = parent.child_budget.as_ref() {
                hook.settle(&request_id, child_actual_usd_micros(&usage))
                    .await?;
            }
        }
        merge_usage(&mut total_usage, usage);
        stream_res?;

        // Build the assistant turn (text + tool_use blocks) for history.
        let mut blocks: Vec<ContentBlock> = Vec::new();
        if let Some(details) = provider_reasoning {
            blocks.push(ContentBlock::ProviderReasoning { details });
        }
        if !assistant_text.is_empty() {
            blocks.push(ContentBlock::Text {
                text: assistant_text.clone(),
            });
        }
        for call in &tool_calls {
            blocks.push(ContentBlock::ToolUse {
                id: call.id.clone(),
                name: call.name.clone(),
                arguments: call.arguments.clone(),
            });
        }

        if tool_calls.is_empty() {
            // No tool calls => model's final answer.
            return if assistant_text.trim().is_empty() {
                Err(empty_error.to_string())
            } else {
                Ok(SubagentResult {
                    child_run_id,
                    status: SubagentStatus::Completed,
                    summary: assistant_text,
                    incomplete_reason: None,
                    usage: total_usage,
                })
            };
        }

        messages.push(ChatMessage {
            role: ChatRole::Assistant,
            content: MessageContent::Blocks(blocks),
        });

        // Dispatch each tool call and collect results into a single tool message.
        let mut result_blocks: Vec<ContentBlock> = Vec::with_capacity(tool_calls.len());
        for call in tool_calls {
            // The tool list handed to the model is the allowlist; a call
            // outside it (or to a denied tool) is refused, never executed.
            // Without this the list was advisory — the model could name
            // `bash` and this loop would run it with no gate at all.
            // Recurses into execute_tool — the future is boxed at that dispatch.
            let result = if subagent_tool_permitted(&call.name, &tools) {
                if call.name.starts_with("mcp__") {
                    let result = crate::core::mcp_bridge::execute_subagent_mcp_tool(
                        &call.name,
                        &call.arguments,
                        parent.enabled_mcp_server_ids.as_deref(),
                        parent.mcp_trust_snapshot.as_deref(),
                    )
                    .await;
                    crate::core::llm_types::ToolResult {
                        tool_call_id: call.id.clone(),
                        is_error: result.is_err(),
                        content: result.unwrap_or_else(|error| format!("Error: {error}")),
                    }
                } else {
                    tool_runtime::execute_tool_with_mcp_trust(
                        &call,
                        parent_target,
                        parent.enabled_mcp_server_ids.as_deref(),
                        parent.mcp_trust_snapshot.as_deref(),
                    )
                    .await
                }
            } else {
                tracing::warn!(
                    target: "packetbench::auth",
                    tool = %call.name,
                    "sub-agent requested a tool outside its allowlist; refused"
                );
                crate::core::llm_types::ToolResult {
                    tool_call_id: call.id.clone(),
                    content: format!(
                        "Error: tool '{}' is not available to this sub-agent.",
                        call.name
                    ),
                    is_error: true,
                }
            };
            result_blocks.push(ContentBlock::ToolResult {
                tool_call_id: result.tool_call_id,
                content: result.content,
                is_error: result.is_error,
            });
        }
        messages.push(ChatMessage {
            role: ChatRole::Tool,
            content: MessageContent::Blocks(result_blocks),
        });

        // Carry partial text forward so we still have something to return if
        // the loop terminates early via the iteration cap.
        if !assistant_text.is_empty() {
            final_text = assistant_text;
        }
    }

    Ok(SubagentResult {
        child_run_id,
        status: SubagentStatus::Incomplete,
        summary: final_text,
        incomplete_reason: Some(format!(
            "reached the {max_requests}-round limit without a final answer"
        )),
        usage: total_usage,
    })
}

/// Map a child outcome to the tool boundary: only a `Completed` child is a
/// successful tool call (`Ok`). Every other status is an `Err` so the model and
/// the UI see `is_error: true`, matching pre-R7 where an incomplete sub-agent
/// was an error. The structured status text is preserved in the message.
pub(crate) fn result_to_tool_output(result: SubagentResult) -> Result<String, String> {
    match result.status {
        SubagentStatus::Completed => Ok(result.to_tool_content()),
        SubagentStatus::Incomplete
        | SubagentStatus::Blocked
        | SubagentStatus::Failed
        | SubagentStatus::Cancelled => Err(result.to_tool_content()),
    }
}

/// The `model` argument as an override, or `None` for an absent OR blank value.
/// A blank argument is "inherit the parent route", exactly like a blank
/// custom-agent frontmatter model; only a non-blank structurally invalid value
/// is rejected downstream.
fn model_override_argument(args: &serde_json::Value) -> Option<&str> {
    args.get("model")
        .and_then(|model| model.as_str())
        .map(str::trim)
        .filter(|model| !model.is_empty())
}

/// Shared recursion-depth guard for sub-agent tools (spawn_subagent +
/// custom agents). Prevents an agent's prompt from triggering an
/// unbounded chain of sub-agent calls that would burn tokens and
/// eventually fail. 3 levels is more than any sane workflow needs.
pub(crate) const MAX_SUBAGENT_DEPTH: usize = 3;

/// Tool entry-point invoked from `tool_runtime::execute_tool`.
pub async fn execute_spawn_subagent(
    args: &serde_json::Value,
    parent_target: &ExecutionTarget,
) -> Result<String, String> {
    let task = args
        .get("task")
        .and_then(|t| t.as_str())
        .ok_or("Missing 'task' parameter")?
        .to_string();

    // Q2: run on the PARENT session's provider at its cheap tier (or the
    // validated override) — never on a hardcoded vendor the user may have no
    // key for. Resolve BEFORE the key/provider so an invalid override is
    // refused with no credential access and no spend. A blank argument inherits.
    let parent = current_parent_llm().ok_or("Sub-agent requires an active conversation")?;
    let tools = read_only_tool_definitions()?;
    let allowed_tools = tools.iter().map(|tool| tool.name.clone()).collect();
    let role = match resolve_subagent_role(
        model_override_argument(args),
        &parent.provider,
        &parent.model,
        "spawn_subagent",
        allowed_tools,
        SUBAGENT_MAX_OUTPUT_TOKENS,
    ) {
        Ok(role) => role,
        Err(error) => return Err(SubagentResult::failed(error.to_string()).to_tool_content()),
    };
    tracing::info!(
        role_id = %role.role_id,
        role_revision = role.role_revision,
        route_source = ?role.route_source,
        provider = %role.provider,
        model = %role.model,
        max_requests = role.max_requests,
        max_output_tokens = role.max_output_tokens,
        context_policy = %role.context_policy,
        allowed_tools = ?role.allowed_tools,
        "subagent role resolved"
    );

    let api_key = crate::commands::api_keys::load_api_key(&role.provider)
        .map_err(|e| format!("spawn_subagent requires a {} API key: {}", role.provider, e))?;
    let provider = get_provider(&role.provider)?;

    let result = run_agent_loop(
        &*provider,
        &api_key,
        role.model,
        SUBAGENT_SYSTEM_PROMPT.to_string(),
        tools,
        role.max_output_tokens,
        role.max_requests,
        task,
        parent_target,
        "Sub-agent finished without producing a summary",
    )
    .await?;
    tracing::info!(
        child_run_id = %result.child_run_id,
        status = ?result.status,
        input_tokens = result.usage.as_ref().map(|usage| usage.input_tokens).unwrap_or(0),
        output_tokens = result.usage.as_ref().map(|usage| usage.output_tokens).unwrap_or(0),
        "subagent finished"
    );
    result_to_tool_output(result)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The role's request ceiling, derived so this cannot drift from the spec.
    const MAX_ITERATIONS: usize = crate::core::subagent_role::SUBAGENT_MAX_REQUESTS as usize;

    fn def(name: &str) -> ToolDefinition {
        ToolDefinition {
            name: name.to_string(),
            description: String::new(),
            parameters: serde_json::json!({ "type": "object" }),
        }
    }

    #[test]
    fn subagent_allowlist_is_enforced_not_advisory() {
        let tools = vec![def("read_file"), def("grep")];
        assert!(subagent_tool_permitted("read_file", &tools));
        assert!(
            !subagent_tool_permitted("write_file", &tools),
            "not in list"
        );
        assert!(!subagent_tool_permitted("bash", &tools), "not in list");
        assert!(
            !subagent_tool_permitted("mcp__x__read", &tools),
            "unknown tools are refused"
        );
    }

    #[test]
    fn denied_tools_stay_denied_even_when_listed() {
        // A custom agent definition (possibly repo-supplied) can ask for
        // `bash`; the floor refuses it regardless of the list.
        let tools = vec![def("bash"), def("create_pull_request"), def("read_file")];
        for denied in SUBAGENT_DENIED_TOOLS {
            assert!(
                !subagent_tool_permitted(denied, &tools),
                "{denied} must be refused"
            );
        }
        assert!(subagent_tool_permitted("read_file", &tools));
    }

    fn parent(recorded: Arc<std::sync::Mutex<Vec<ChildUsage>>>) -> ParentLlm {
        ParentLlm {
            provider: "anthropic".into(),
            model: "claude-sonnet-4-6".into(),
            tools: Arc::new(vec![def("task_list"), def("read_file")]),
            custom_agents: Arc::new(vec![]),
            enabled_mcp_server_ids: Some(vec![]),
            mcp_trust_snapshot: Some(vec![]),
            native_mcp_session: Arc::new(Default::default()),
            tasks: Arc::new(Default::default()),
            record_usage: Arc::new(move |usage| {
                recorded.lock().unwrap().push(usage);
                Ok(())
            }),
            child_budget: None,
            cancel: tokio_util::sync::CancellationToken::new(),
        }
    }

    /// A fake child-budget hook that counts reserve/settle/release calls and
    /// records the settled actuals and reserved request ids. `reserve` reports a
    /// live reservation.
    #[derive(Default)]
    struct CountingBudget {
        reserves: std::sync::atomic::AtomicUsize,
        settles: std::sync::atomic::AtomicUsize,
        releases: std::sync::atomic::AtomicUsize,
        marks: std::sync::atomic::AtomicUsize,
        actuals: std::sync::Mutex<Vec<i64>>,
        reserved_ids: std::sync::Mutex<Vec<String>>,
    }

    impl CountingBudget {
        fn reserves(&self) -> usize {
            self.reserves.load(std::sync::atomic::Ordering::SeqCst)
        }
        fn settles(&self) -> usize {
            self.settles.load(std::sync::atomic::Ordering::SeqCst)
        }
        fn releases(&self) -> usize {
            self.releases.load(std::sync::atomic::Ordering::SeqCst)
        }
        fn marks(&self) -> usize {
            self.marks.load(std::sync::atomic::Ordering::SeqCst)
        }
        fn reserved_ids(&self) -> Vec<String> {
            self.reserved_ids.lock().unwrap().clone()
        }
    }

    #[async_trait::async_trait]
    impl ChildBudgetHook for CountingBudget {
        async fn reserve(
            &self,
            request_id: &str,
            _provider: &str,
            _model: &str,
            _messages: &[ChatMessage],
            _max_tokens: u64,
        ) -> Result<bool, String> {
            self.reserves
                .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            self.reserved_ids
                .lock()
                .unwrap()
                .push(request_id.to_string());
            Ok(true)
        }
        async fn settle(&self, _request_id: &str, actual_usd_micros: i64) -> Result<(), String> {
            self.settles
                .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            self.actuals.lock().unwrap().push(actual_usd_micros);
            Ok(())
        }
        async fn release(&self, _request_id: &str) -> Result<(), String> {
            self.releases
                .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            Ok(())
        }
        async fn mark_dispatched(&self, _request_id: &str) -> Result<(), String> {
            self.marks.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            Ok(())
        }
    }

    /// The disabled path: the journal is off or the session has no budget.
    struct UnconfiguredBudget;
    #[async_trait::async_trait]
    impl ChildBudgetHook for UnconfiguredBudget {
        async fn reserve(
            &self,
            _request_id: &str,
            _provider: &str,
            _model: &str,
            _messages: &[ChatMessage],
            _max_tokens: u64,
        ) -> Result<bool, String> {
            Ok(false)
        }
        async fn settle(&self, _request_id: &str, _actual_usd_micros: i64) -> Result<(), String> {
            panic!("an unconfigured budget must not settle");
        }
        async fn release(&self, _request_id: &str) -> Result<(), String> {
            panic!("an unconfigured budget must not release");
        }
    }

    /// A budget that refuses admission (e.g. the scope cap is exhausted).
    struct RefusingBudget;
    #[async_trait::async_trait]
    impl ChildBudgetHook for RefusingBudget {
        async fn reserve(
            &self,
            _request_id: &str,
            _provider: &str,
            _model: &str,
            _messages: &[ChatMessage],
            _max_tokens: u64,
        ) -> Result<bool, String> {
            Err("budget scope exceeded".to_string())
        }
        async fn settle(&self, _request_id: &str, _actual_usd_micros: i64) -> Result<(), String> {
            panic!("a refused child must not settle");
        }
        async fn release(&self, _request_id: &str) -> Result<(), String> {
            panic!("a refused child must not release");
        }
    }

    struct FixtureProvider {
        keep_calling: bool,
        barrier: Option<Arc<tokio::sync::Barrier>>,
    }
    #[async_trait::async_trait]
    impl crate::core::llm_provider::LlmProvider for FixtureProvider {
        fn provider_id(&self) -> &str {
            "anthropic"
        }
        async fn stream_chat(
            &self,
            _: &str,
            request: LlmRequest,
            tx: mpsc::Sender<StreamChunk>,
        ) -> Result<(), String> {
            if let Some(barrier) = &self.barrier {
                barrier.wait().await;
            }
            assert_eq!(current_parent_llm().unwrap().model, request.model);
            assert_eq!(
                current_parent_llm().unwrap().enabled_mcp_server_ids,
                Some(vec![])
            );
            assert_eq!(
                current_parent_llm()
                    .unwrap()
                    .mcp_trust_snapshot
                    .unwrap()
                    .len(),
                0
            );
            tx.send(StreamChunk::TextDelta {
                text: "partial-or-final".into(),
            })
            .await
            .unwrap();
            if self.keep_calling {
                tx.send(StreamChunk::ToolUseEnd {
                    id: "tool-1".into(),
                    name: "task_list".into(),
                    arguments: serde_json::json!({}),
                })
                .await
                .unwrap();
            }
            tx.send(StreamChunk::Done {
                input_tokens: 100,
                output_tokens: 10,
                cache_read_input_tokens: 20,
                cache_creation_input_tokens: 30,
            })
            .await
            .unwrap();
            Ok(())
        }
    }

    async fn run_fixture(provider: &FixtureProvider) -> Result<SubagentResult, String> {
        run_agent_loop(
            provider,
            "",
            "claude-haiku-4-5".into(),
            "".into(),
            vec![def("task_list")],
            20,
            MAX_ITERATIONS as u32,
            "task".into(),
            &ExecutionTarget::Local {
                project_path: ".".into(),
            },
            "empty",
        )
        .await
    }

    /// A provider that fails mid-stream, so the child releases its reservation.
    struct ErroringProvider;
    #[async_trait::async_trait]
    impl crate::core::llm_provider::LlmProvider for ErroringProvider {
        fn provider_id(&self) -> &str {
            "anthropic"
        }
        async fn stream_chat(
            &self,
            _: &str,
            _request: LlmRequest,
            tx: mpsc::Sender<StreamChunk>,
        ) -> Result<(), String> {
            tx.send(StreamChunk::TextDelta {
                text: "partial".into(),
            })
            .await
            .unwrap();
            tx.send(StreamChunk::Error {
                message: "boom".into(),
            })
            .await
            .unwrap();
            Ok(())
        }
    }

    /// A provider that, while streaming the OUTER child, runs a nested child
    /// loop. Used to prove the budget hook is inherited by the whole chain.
    struct NestedProvider;
    #[async_trait::async_trait]
    impl crate::core::llm_provider::LlmProvider for NestedProvider {
        fn provider_id(&self) -> &str {
            "anthropic"
        }
        async fn stream_chat(
            &self,
            _: &str,
            _request: LlmRequest,
            tx: mpsc::Sender<StreamChunk>,
        ) -> Result<(), String> {
            let inner = FixtureProvider {
                keep_calling: false,
                barrier: None,
            };
            let target = ExecutionTarget::Local {
                project_path: ".".into(),
            };
            run_agent_loop(
                &inner,
                "",
                "claude-haiku-4-5".into(),
                "".into(),
                vec![def("task_list")],
                20,
                MAX_ITERATIONS as u32,
                "inner".into(),
                &target,
                "empty",
            )
            .await
            .unwrap();
            tx.send(StreamChunk::TextDelta {
                text: "outer".into(),
            })
            .await
            .unwrap();
            tx.send(StreamChunk::Done {
                input_tokens: 1,
                output_tokens: 1,
                cache_read_input_tokens: 0,
                cache_creation_input_tokens: 0,
            })
            .await
            .unwrap();
            Ok(())
        }
    }

    struct ReplayFixtureProvider {
        replay: serde_json::Value,
        requests: std::sync::Mutex<Vec<LlmRequest>>,
    }

    #[async_trait::async_trait]
    impl crate::core::llm_provider::LlmProvider for ReplayFixtureProvider {
        fn provider_id(&self) -> &str {
            "google"
        }

        async fn stream_chat(
            &self,
            _: &str,
            request: LlmRequest,
            tx: mpsc::Sender<StreamChunk>,
        ) -> Result<(), String> {
            let first_round = request.messages.len() == 1;
            self.requests.lock().unwrap().push(request);
            if first_round {
                tx.send(StreamChunk::ToolUseEnd {
                    id: "signed-call".into(),
                    name: "task_list".into(),
                    arguments: serde_json::json!({}),
                })
                .await
                .unwrap();
                tx.send(StreamChunk::ReasoningDetails {
                    details: self.replay.clone(),
                })
                .await
                .unwrap();
            } else {
                tx.send(StreamChunk::TextDelta {
                    text: "finished".into(),
                })
                .await
                .unwrap();
            }
            tx.send(StreamChunk::Done {
                input_tokens: 10,
                output_tokens: 5,
                cache_read_input_tokens: 0,
                cache_creation_input_tokens: 0,
            })
            .await
            .unwrap();
            Ok(())
        }
    }

    #[tokio::test]
    async fn child_tool_rounds_preserve_opaque_replay_and_a_stable_private_session_key() {
        for replay in [
            serde_json::json!({"compat_provider":"google", "tool_metadata":{
                "signed-call":{"google":{"thought_signature":"opaque-signature"}}
            }}),
            serde_json::json!({"responses_provider":"xai", "output":[
                {"type":"reasoning", "encrypted_content":"opaque-reasoning"},
                {"type":"function_call", "call_id":"signed-call", "name":"task_list", "arguments":"{}"}
            ]}),
            serde_json::json!({"anthropic_content":[
                {"type":"thinking", "thinking":"private", "signature":"opaque-signature"},
                {"type":"tool_use", "id":"signed-call", "name":"task_list", "input":{}}
            ]}),
        ] {
            let provider = ReplayFixtureProvider {
                replay: replay.clone(),
                requests: Default::default(),
            };
            let recorded = Arc::new(std::sync::Mutex::new(vec![]));
            // Independent children must not share a cache/session identity.
            for _ in 0..2 {
                let result = PARENT_LLM
                    .scope(
                        parent(recorded.clone()),
                        run_agent_loop(
                            &provider,
                            "fixture-key",
                            "selected-model".into(),
                            "".into(),
                            vec![def("task_list")],
                            20,
                            MAX_ITERATIONS as u32,
                            "task".into(),
                            &ExecutionTarget::Local {
                                project_path: ".".into(),
                            },
                            "empty",
                        ),
                    )
                    .await
                    .unwrap();
                assert_eq!(result.status, SubagentStatus::Completed);
                assert_eq!(result.to_tool_content(), "finished");
            }
            let requests = provider.requests.lock().unwrap();
            assert_eq!(requests.len(), 4);
            for rounds in requests.chunks_exact(2) {
                let key = rounds[0].cache_key.as_deref().unwrap();
                assert!(uuid::Uuid::parse_str(key).is_ok());
                assert_eq!(rounds[1].cache_key.as_deref(), Some(key));
                let followup = &rounds[1].messages;
                assert_eq!(followup.len(), 3);
                assert_eq!(followup[1].role, ChatRole::Assistant);
                let MessageContent::Blocks(blocks) = &followup[1].content else {
                    panic!("tool follow-up must retain structured assistant content");
                };
                assert!(
                    matches!(&blocks[0], ContentBlock::ProviderReasoning { details } if details == &replay)
                );
                assert!(
                    matches!(&blocks[1], ContentBlock::ToolUse { id, .. } if id == "signed-call")
                );
                assert_eq!(followup[2].role, ChatRole::Tool);
                let MessageContent::Blocks(results) = &followup[2].content else {
                    panic!("tool follow-up must include the correlated result");
                };
                assert!(
                    matches!(&results[0], ContentBlock::ToolResult { tool_call_id, .. } if tool_call_id == "signed-call")
                );
            }
            assert_ne!(requests[0].cache_key, requests[2].cache_key);
            assert_eq!(recorded.lock().unwrap().len(), 4);
        }
    }

    #[tokio::test]
    async fn exhaustion_is_incomplete_and_every_child_request_is_accounted() {
        let recorded = Arc::new(std::sync::Mutex::new(vec![]));
        let result = PARENT_LLM
            .scope(
                parent(recorded.clone()),
                run_fixture(&FixtureProvider {
                    keep_calling: true,
                    barrier: None,
                }),
            )
            .await
            .unwrap();
        // Structured, not a bare string: the loop reports its own status.
        assert_eq!(result.status, SubagentStatus::Incomplete);
        assert!(result
            .incomplete_reason
            .as_deref()
            .is_some_and(|reason| !reason.is_empty()));
        // At the tool boundary an incomplete child is an ERROR, not a success
        // (pre-R7 semantics), carrying the structured status/reason text.
        let error = result_to_tool_output(result).unwrap_err();
        assert!(error.contains("incomplete"));
        assert!(error.contains("partial-or-final"));
        // Exactly one usage row per child request — no duplication.
        let rows = recorded.lock().unwrap();
        assert_eq!(rows.len(), MAX_ITERATIONS);
        assert!(rows.iter().all(|row| row.model == "claude-haiku-4-5"
            && row.input_tokens == 100
            && row.cache_write == 30));
    }

    #[tokio::test]
    async fn independent_children_can_overlap_beyond_three_and_nested_depth_is_bounded() {
        let barrier = Arc::new(tokio::sync::Barrier::new(4));
        let runs = (0..4).map(|_| {
            let barrier = barrier.clone();
            async move {
                let context = parent(Arc::new(std::sync::Mutex::new(vec![])));
                PARENT_LLM
                    .scope(
                        context,
                        run_fixture(&FixtureProvider {
                            keep_calling: false,
                            barrier: Some(barrier),
                        }),
                    )
                    .await
            }
        });
        let results = tokio::time::timeout(
            std::time::Duration::from_secs(2),
            futures::future::join_all(runs),
        )
        .await
        .unwrap();
        assert!(results.iter().all(Result::is_ok));
        let context = parent(Arc::new(std::sync::Mutex::new(vec![])));
        let error = PARENT_LLM
            .scope(
                context,
                SUBAGENT_DEPTH.scope(
                    MAX_SUBAGENT_DEPTH,
                    run_fixture(&FixtureProvider {
                        keep_calling: false,
                        barrier: None,
                    }),
                ),
            )
            .await
            .unwrap_err();
        assert!(error.contains("recursion depth"));
        assert!(
            SUBAGENT_DEPTH.try_with(|depth| *depth).is_err(),
            "depth must not leak after scope exit"
        );
    }

    #[tokio::test]
    async fn read_only_child_cannot_regain_tools_absent_from_parent() {
        let mut context = parent(Arc::new(std::sync::Mutex::new(vec![])));
        context.tools = Arc::new(vec![def("grep")]);
        PARENT_LLM
            .scope(context, async {
                let tools = read_only_tool_definitions().unwrap();
                assert_eq!(
                    tools
                        .iter()
                        .map(|tool| tool.name.as_str())
                        .collect::<Vec<_>>(),
                    vec!["grep"]
                );
            })
            .await;
    }

    #[tokio::test]
    async fn partial_stream_without_done_is_not_success() {
        let (tx, rx) = mpsc::channel(2);
        tx.send(StreamChunk::TextDelta {
            text: "still working".into(),
        })
        .await
        .unwrap();
        drop(tx);
        assert!(collect_response(rx, "anthropic", "claude-haiku-4-5", None)
            .await
            .unwrap_err()
            .contains("without a completion"));
    }

    #[test]
    fn spawn_subagent_definition_no_longer_advertises_an_ignored_model() {
        let definition = spawn_subagent_definition();
        assert!(!definition.description.to_lowercase().contains("ignored"));
        let model = definition.parameters["properties"]["model"]["description"]
            .as_str()
            .expect("model description");
        assert!(!model.to_lowercase().contains("ignored"));
        assert!(model.contains("override"));
    }

    #[test]
    fn only_a_completed_child_is_a_successful_tool_call() {
        for (status, is_ok) in [
            (SubagentStatus::Completed, true),
            (SubagentStatus::Incomplete, false),
            (SubagentStatus::Blocked, false),
            (SubagentStatus::Failed, false),
        ] {
            let result = SubagentResult {
                child_run_id: "child".to_string(),
                status,
                summary: "summary".to_string(),
                incomplete_reason: Some("reason".to_string()),
                usage: None,
            };
            assert_eq!(result_to_tool_output(result).is_ok(), is_ok, "{status:?}");
        }
    }

    #[test]
    fn a_blank_model_argument_is_an_inherit_not_an_override() {
        assert_eq!(
            model_override_argument(&serde_json::json!({ "model": "   " })),
            None
        );
        assert_eq!(
            model_override_argument(&serde_json::json!({ "task": "x" })),
            None
        );
        assert_eq!(
            model_override_argument(&serde_json::json!({ "model": " claude-opus-4-1 " })),
            Some("claude-opus-4-1")
        );
        // A blank argument therefore resolves as an inherited parent route.
        let spec = resolve_subagent_role(
            model_override_argument(&serde_json::json!({ "model": "   " })),
            "anthropic",
            "claude-sonnet-4-6",
            "spawn_subagent",
            Vec::new(),
            SUBAGENT_MAX_OUTPUT_TOKENS,
        )
        .unwrap();
        assert_eq!(spec.model, "claude-haiku-4-5");
        assert_eq!(
            spec.route_source,
            crate::core::subagent_role::RouteSource::InheritedParent
        );
    }

    #[tokio::test]
    async fn a_structurally_invalid_override_is_an_err_before_the_provider_is_reached() {
        let context = parent(Arc::new(std::sync::Mutex::new(vec![])));
        let args = serde_json::json!({ "task": "investigate", "model": "bad\nmodel" });
        let target = ExecutionTarget::Local {
            project_path: ".".into(),
        };
        let error = PARENT_LLM
            .scope(context, execute_spawn_subagent(&args, &target))
            .await
            .unwrap_err();
        // A rejected role never loads a credential or constructs a provider,
        // and it surfaces as an Err at the tool boundary (is_error: true).
        assert!(error.contains("failed"));
        assert!(error.contains("control characters"));
        assert!(!error.contains("API key"));
    }

    #[tokio::test]
    async fn child_budget_hook_reserves_and_settles_each_request_exactly_once() {
        let recorded = Arc::new(std::sync::Mutex::new(vec![]));
        let hook = Arc::new(CountingBudget::default());
        let mut context = parent(recorded.clone());
        context.child_budget = Some(hook.clone());
        let result = PARENT_LLM
            .scope(
                context,
                run_fixture(&FixtureProvider {
                    keep_calling: true,
                    barrier: None,
                }),
            )
            .await
            .unwrap();
        assert_eq!(result.status, SubagentStatus::Incomplete);
        assert_eq!(hook.reserves(), MAX_ITERATIONS);
        assert_eq!(hook.settles(), MAX_ITERATIONS);
        assert_eq!(hook.releases(), 0);
        // R5: every reserved child request is marked dispatched before streaming,
        // so a child that fails before settle retains uncertain liability.
        assert_eq!(hook.marks(), MAX_ITERATIONS);
        // Settlement is the actual cost, and usage is still recorded once.
        assert!(hook
            .actuals
            .lock()
            .unwrap()
            .iter()
            .all(|actual| *actual >= 0));
        // Every usage row carries the SAME request_id as its reservation, so a
        // crash before settle leaves a ledger row startup reconciliation can
        // match and settle instead of releasing.
        let mut recorded_ids: Vec<String> = recorded
            .lock()
            .unwrap()
            .iter()
            .map(|row| {
                row.request_id
                    .clone()
                    .expect("a reserved child usage row must carry its request_id")
            })
            .collect();
        let mut reserved_ids = hook.reserved_ids();
        assert_eq!(recorded_ids.len(), MAX_ITERATIONS);
        recorded_ids.sort();
        reserved_ids.sort();
        assert_eq!(recorded_ids, reserved_ids);
    }

    #[tokio::test]
    async fn a_cancelled_parent_stops_the_child_with_a_cancelled_status() {
        let recorded = Arc::new(std::sync::Mutex::new(vec![]));
        let hook = Arc::new(CountingBudget::default());
        let mut context = parent(recorded.clone());
        context.child_budget = Some(hook.clone());
        let cancel = context.cancel.clone();

        // A provider whose stream blocks on a 2-party barrier the test never
        // releases, so only cancellation can end the child.
        let provider = FixtureProvider {
            keep_calling: true,
            barrier: Some(Arc::new(tokio::sync::Barrier::new(2))),
        };

        let handle =
            tokio::spawn(async move { PARENT_LLM.scope(context, run_fixture(&provider)).await });

        // The child reserves and marks dispatch before it streams; wait for that
        // so cancellation lands while the child is genuinely in flight.
        for _ in 0..10_000 {
            if hook.marks() == 1 {
                break;
            }
            tokio::task::yield_now().await;
        }
        assert_eq!(
            hook.marks(),
            1,
            "the child marked dispatch before we cancel"
        );
        cancel.cancel();

        let result = tokio::time::timeout(std::time::Duration::from_secs(5), handle)
            .await
            .expect("the child must stop promptly on cancel")
            .unwrap()
            .unwrap();
        assert_eq!(result.status, SubagentStatus::Cancelled);
        assert_eq!(
            result.incomplete_reason.as_deref(),
            Some("parent_cancelled")
        );
        assert_eq!(hook.reserves(), 1);
        assert_eq!(hook.releases(), 1, "the in-flight child is released");
        assert_eq!(hook.settles(), 0, "a cancelled child never settles");
    }

    #[tokio::test]
    async fn nested_children_inherit_the_parent_budget_hook() {
        let recorded = Arc::new(std::sync::Mutex::new(vec![]));
        let hook = Arc::new(CountingBudget::default());
        let mut context = parent(recorded.clone());
        context.child_budget = Some(hook.clone());
        let target = ExecutionTarget::Local {
            project_path: ".".into(),
        };
        let result = PARENT_LLM
            .scope(
                context,
                run_agent_loop(
                    &NestedProvider,
                    "",
                    "claude-haiku-4-5".into(),
                    "".into(),
                    vec![def("task_list")],
                    20,
                    MAX_ITERATIONS as u32,
                    "outer".into(),
                    &target,
                    "empty",
                ),
            )
            .await
            .unwrap();
        assert_eq!(result.status, SubagentStatus::Completed);
        // One reservation for the outer child, one for the nested child: the
        // hook is inherited down the chain.
        assert_eq!(hook.reserves(), 2);
        assert_eq!(hook.settles(), 2);
        assert_eq!(hook.releases(), 0);
    }

    #[tokio::test]
    async fn an_absent_or_unconfigured_child_budget_makes_no_reservation() {
        // No hook at all: the disabled path.
        let recorded = Arc::new(std::sync::Mutex::new(vec![]));
        let result = PARENT_LLM
            .scope(
                parent(recorded.clone()),
                run_fixture(&FixtureProvider {
                    keep_calling: false,
                    barrier: None,
                }),
            )
            .await
            .unwrap();
        assert_eq!(result.status, SubagentStatus::Completed);
        assert!(
            recorded
                .lock()
                .unwrap()
                .iter()
                .all(|row| row.request_id.is_none()),
            "no reservation means no request_id on the usage row"
        );

        // Hook present but the journal is off / no session budget: it reports
        // no reservation, so settle/release are never called.
        let recorded = Arc::new(std::sync::Mutex::new(vec![]));
        let mut context = parent(recorded.clone());
        context.child_budget = Some(Arc::new(UnconfiguredBudget));
        let result = PARENT_LLM
            .scope(
                context,
                run_fixture(&FixtureProvider {
                    keep_calling: false,
                    barrier: None,
                }),
            )
            .await
            .unwrap();
        assert_eq!(result.status, SubagentStatus::Completed);
    }

    #[tokio::test]
    async fn a_refused_budget_blocks_the_child_before_dispatch() {
        let recorded = Arc::new(std::sync::Mutex::new(vec![]));
        let mut context = parent(recorded.clone());
        context.child_budget = Some(Arc::new(RefusingBudget));
        let result = PARENT_LLM
            .scope(
                context,
                run_fixture(&FixtureProvider {
                    keep_calling: false,
                    barrier: None,
                }),
            )
            .await
            .unwrap();
        assert_eq!(result.status, SubagentStatus::Blocked);
        assert!(result.to_tool_content().contains("blocked"));
        assert!(recorded.lock().unwrap().is_empty(), "no spend is recorded");
    }

    #[tokio::test]
    async fn a_failed_child_releases_its_reservation() {
        let recorded = Arc::new(std::sync::Mutex::new(vec![]));
        let hook = Arc::new(CountingBudget::default());
        let mut context = parent(recorded.clone());
        context.child_budget = Some(hook.clone());
        let error = PARENT_LLM
            .scope(
                context,
                run_agent_loop(
                    &ErroringProvider,
                    "",
                    "claude-haiku-4-5".into(),
                    "".into(),
                    vec![def("task_list")],
                    20,
                    MAX_ITERATIONS as u32,
                    "task".into(),
                    &ExecutionTarget::Local {
                        project_path: ".".into(),
                    },
                    "empty",
                ),
            )
            .await
            .unwrap_err();
        assert!(error.contains("boom"));
        assert_eq!(hook.reserves(), 1);
        assert_eq!(hook.settles(), 0);
        assert_eq!(hook.releases(), 1);
    }
}
