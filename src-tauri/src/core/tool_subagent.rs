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
use crate::core::tool_runtime;
use std::sync::Arc;
use tokio::sync::mpsc;

const MAX_ITERATIONS: usize = 8;

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
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ChildUsage {
    pub provider: String,
    pub model: String,
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

/// Provider + cheap-tier model for a sub-agent turn: the parent session's
/// provider when known (fixes the MiniMax-only-user defect), else the
/// historical Anthropic default.
pub(crate) fn subagent_provider_and_model() -> (String, String) {
    match current_parent_llm() {
        Some(parent) => {
            let model = crate::core::aux_llm::cheap_tier_model(&parent.provider, &parent.model);
            (parent.provider, model)
        }
        None => ("anthropic".to_string(), "claude-haiku-4-5".to_string()),
    }
}

const SUBAGENT_SYSTEM_PROMPT: &str = "You are a focused research sub-agent. Use the read-only tools to investigate the task. After 1-3 tool calls, return a concise one-paragraph summary. Do not produce code or recommendations beyond the summary.";

/// Tool definition advertised to the parent agent.
#[allow(dead_code)]
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
                    "description": "Optional model override (currently ignored — sub-agent always uses a fast default)."
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

/// Drain a `StreamChunk` receiver into (assistant text, tool calls).
pub(crate) async fn collect_response(
    mut rx: mpsc::Receiver<StreamChunk>,
    provider: &str,
    model: &str,
) -> Result<(String, Vec<ToolCall>), String> {
    let mut text = String::new();
    let mut tool_calls: Vec<ToolCall> = Vec::new();

    while let Some(chunk) = rx.recv().await {
        match chunk {
            StreamChunk::TextDelta { text: t } => text.push_str(&t),
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
                (parent.record_usage)(ChildUsage {
                    provider: provider.to_string(),
                    model: model.to_string(),
                    input_tokens,
                    output_tokens,
                    cache_read: cache_read_input_tokens,
                    cache_write: cache_creation_input_tokens,
                })?;
                return Ok((text, tool_calls));
            }
            _ => {}
        }
    }

    Err("Sub-agent stream ended without a completion record".to_string())
}

/// Shared agentic tool loop for the sub-agent tools (`spawn_subagent` and
/// custom `agent_*` tools). Runs up to `MAX_ITERATIONS` request→tool-dispatch
/// rounds against `provider`, recursing into `tool_runtime::execute_tool` for
/// each tool call (the recursion is boxed at `execute_tool`'s dispatch site),
/// and returns the final assistant text. `empty_error` is returned when the
/// loop finishes without producing any text.
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
    task: String,
    parent_target: &ExecutionTarget,
    empty_error: &str,
) -> Result<String, String> {
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
                    task,
                    parent_target,
                    empty_error,
                ),
            ),
        )
        .await
}

#[allow(clippy::too_many_arguments)]
async fn run_agent_loop_inner(
    provider: &dyn crate::core::llm_provider::LlmProvider,
    api_key: &str,
    model: String,
    system_prompt: String,
    tools: Vec<ToolDefinition>,
    max_tokens: u32,
    task: String,
    parent_target: &ExecutionTarget,
    empty_error: &str,
) -> Result<String, String> {
    let parent = current_parent_llm().ok_or("Sub-agent requires an active conversation")?;
    let mut messages: Vec<ChatMessage> = vec![ChatMessage {
        role: ChatRole::User,
        content: MessageContent::text(task),
    }];

    let mut final_text = String::new();

    for _ in 0..MAX_ITERATIONS {
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
            cache_key: None,
        };

        let (tx, rx) = mpsc::channel::<StreamChunk>(64);
        let stream_fut = provider.stream_chat(api_key, request, tx);
        let collect_fut = collect_response(rx, &parent.provider, &model);

        let (stream_res, collected) = tokio::join!(stream_fut, collect_fut);
        stream_res?;
        let (assistant_text, tool_calls) = collected?;

        // Build the assistant turn (text + tool_use blocks) for history.
        let mut blocks: Vec<ContentBlock> = Vec::new();
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
                Ok(assistant_text)
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

    Err(format!("Sub-agent incomplete: reached the {MAX_ITERATIONS}-round limit without a final answer. Partial progress: {final_text}"))
}

/// Shared recursion-depth guard for sub-agent tools (spawn_subagent +
/// custom agents). Prevents an agent's prompt from triggering an
/// unbounded chain of sub-agent calls that would burn tokens and
/// eventually fail. 3 levels is more than any sane workflow needs.
pub(crate) const MAX_SUBAGENT_DEPTH: usize = 3;

/// Tool entry-point invoked from `tool_runtime::execute_tool`.
#[allow(dead_code)]
pub async fn execute_spawn_subagent(
    args: &serde_json::Value,
    parent_target: &ExecutionTarget,
) -> Result<String, String> {
    let task = args
        .get("task")
        .and_then(|t| t.as_str())
        .ok_or("Missing 'task' parameter")?
        .to_string();

    // Q2: run on the PARENT session's provider at its cheap tier — never on
    // a hardcoded vendor the user may have no key for.
    let (provider_id, model) = subagent_provider_and_model();
    let api_key = crate::commands::api_keys::load_api_key(&provider_id)
        .map_err(|e| format!("spawn_subagent requires a {} API key: {}", provider_id, e))?;

    let provider = get_provider(&provider_id)?;
    let tools = read_only_tool_definitions()?;

    run_agent_loop(
        &*provider,
        &api_key,
        model,
        SUBAGENT_SYSTEM_PROMPT.to_string(),
        tools,
        2048,
        task,
        parent_target,
        "Sub-agent finished without producing a summary",
    )
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

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

    async fn run_fixture(provider: &FixtureProvider) -> Result<String, String> {
        run_agent_loop(
            provider,
            "",
            "claude-haiku-4-5".into(),
            "".into(),
            vec![def("task_list")],
            20,
            "task".into(),
            &ExecutionTarget::Local {
                project_path: ".".into(),
            },
            "empty",
        )
        .await
    }

    #[tokio::test]
    async fn exhaustion_is_incomplete_and_every_child_request_is_accounted() {
        let recorded = Arc::new(std::sync::Mutex::new(vec![]));
        let error = PARENT_LLM
            .scope(
                parent(recorded.clone()),
                run_fixture(&FixtureProvider {
                    keep_calling: true,
                    barrier: None,
                }),
            )
            .await
            .unwrap_err();
        assert!(error.contains("incomplete"));
        assert!(error.contains("partial-or-final"));
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
        assert!(collect_response(rx, "anthropic", "claude-haiku-4-5")
            .await
            .unwrap_err()
            .contains("without a completion"));
    }
}
