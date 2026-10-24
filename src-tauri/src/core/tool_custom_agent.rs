//! Claude-Code-style custom sub-agent dispatcher.
//!
//! Each custom agent file (`<home>/.claude/agents/<name>.md` or
//! `<project>/.claude/agents/<name>.md`) is exposed as a single tool named
//! `agent_<sanitized_name>` that the main agent can call. Invocation spins
//! up a sub-agent loop with the agent's own system prompt, model, and
//! allowed tool subset.

use crate::commands::custom_agents::CustomAgentDef;
use crate::core::execution::ExecutionTarget;
use crate::core::llm_provider::get_provider;
use crate::core::llm_types::ToolDefinition;
use crate::core::subagent_role::{resolve_subagent_role, SubagentResult};
use crate::core::tool_subagent::{current_parent_llm, result_to_tool_output};

const TOOL_PREFIX: &str = "agent_";

/// Output ceiling for a custom agent (unchanged from the pre-R7 literal).
const CUSTOM_AGENT_MAX_OUTPUT_TOKENS: u32 = 4096;

/// Default tool allowlist when an agent's frontmatter `tools` array is
/// empty or omitted — mirrors the read-only set used by `spawn_subagent`.
const DEFAULT_READ_ONLY_TOOLS: &[&str] = &["read_file", "list_directory", "grep", "web_fetch"];

/// Sanitize an agent name into a tool-name suffix: lowercase ASCII alnum,
/// other characters become underscores, collapsed runs.
fn sanitize_name(name: &str) -> String {
    let mut out = String::with_capacity(name.len());
    let mut last_underscore = false;
    for ch in name.chars() {
        if ch.is_ascii_alphanumeric() {
            out.push(ch.to_ascii_lowercase());
            last_underscore = false;
        } else if !last_underscore && !out.is_empty() {
            out.push('_');
            last_underscore = true;
        }
    }
    while out.ends_with('_') {
        out.pop();
    }
    out
}

/// Advertise the same trusted, frozen definitions that invocation will use.
pub fn custom_agent_definitions(agents: &[CustomAgentDef]) -> Vec<ToolDefinition> {
    agents
        .iter()
        .filter_map(|a| {
            let suffix = sanitize_name(&a.name);
            if suffix.is_empty() {
                return None;
            }
            Some(ToolDefinition {
                name: format!("{}{}", TOOL_PREFIX, suffix),
                description: a.description.clone(),
                parameters: serde_json::json!({
                    "type": "object",
                    "properties": {
                        "task": {
                            "type": "string",
                            "description": "What you want this sub-agent to do."
                        }
                    },
                    "required": ["task"]
                }),
            })
        })
        .collect()
}

fn find_agent<'a>(tool_name: &str, agents: &'a [CustomAgentDef]) -> Option<&'a CustomAgentDef> {
    let suffix = tool_name.strip_prefix(TOOL_PREFIX)?;
    agents.iter().find(|a| sanitize_name(&a.name) == suffix)
}

/// Build the tool subset this agent is allowed to call. Empty `allowed_tools`
/// falls back to the read-only default set.
/// Strip the tools a sub-agent may never hold (see
/// `tool_subagent::SUBAGENT_DENIED_TOOLS`) from a definition's requested
/// list, logging each drop by agent name so a definition that silently lost
/// `bash` is explainable from the log.
fn filter_subagent_tools(agent_name: &str, requested: Vec<String>) -> Vec<String> {
    requested
        .into_iter()
        .filter(|name| {
            let denied = crate::core::tool_subagent::SUBAGENT_DENIED_TOOLS.contains(&name.as_str());
            if denied {
                tracing::warn!(
                    target: "packetbench::auth",
                    agent = %agent_name,
                    tool = %name,
                    "custom agent definition requested a tool sub-agents may not hold; dropped"
                );
            }
            !denied
        })
        .collect()
}

/// The names this agent asks for, before intersecting with the parent's
/// authority: the read-only default when it names none, else its requested list
/// with the denied-mutation floor applied.
fn requested_allowed_tools(agent: &CustomAgentDef) -> Vec<String> {
    if agent.allowed_tools.is_empty() {
        DEFAULT_READ_ONLY_TOOLS
            .iter()
            .map(|s| s.to_string())
            .collect()
    } else {
        filter_subagent_tools(&agent.name, agent.allowed_tools.clone())
    }
}

/// The definitions this agent may hold, intersected with the parent's frozen
/// authority. `allowed` is the already-floored request from
/// [`requested_allowed_tools`].
fn allowed_tool_definitions(
    allowed: &[String],
    parent_tools: &[ToolDefinition],
) -> Vec<ToolDefinition> {
    parent_tools
        .iter()
        .filter(|t| allowed.iter().any(|name| name == &t.name))
        .cloned()
        .collect()
}

/// Tool entry-point for `agent_*` invocations dispatched from `tool_runtime::execute_tool`.
pub async fn execute_custom_agent(
    name: &str,
    args: &serde_json::Value,
    parent_target: &ExecutionTarget,
) -> Result<String, String> {
    let task = args
        .get("task")
        .and_then(|t| t.as_str())
        .ok_or("Missing 'task' parameter")?
        .to_string();

    let parent = current_parent_llm().ok_or("Custom agent requires an active conversation")?;
    let agent = find_agent(name, &parent.custom_agents).ok_or_else(|| {
        format!(
            "Custom agent not in this session's frozen definitions: '{}'",
            name
        )
    })?;

    // Q2: run on the PARENT session's provider — never on a hardcoded vendor
    // the user may have no key for. A non-empty frontmatter `model` is the
    // explicit override (the agent author's choice); otherwise the derived
    // cheap tier is inherited. The SAME role resolver as `spawn_subagent`, so
    // the route is validated before any credential is loaded. The floored
    // request is computed ONCE so a denied tool is logged once, not twice.
    let role_id = format!("agent_{}", sanitize_name(&agent.name));
    let model_override = agent
        .model
        .as_deref()
        .map(str::trim)
        .filter(|model| !model.is_empty());
    let allowed = requested_allowed_tools(agent);
    let role = match resolve_subagent_role(
        model_override,
        &parent.provider,
        &parent.model,
        &role_id,
        allowed.clone(),
        CUSTOM_AGENT_MAX_OUTPUT_TOKENS,
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
        .map_err(|e| format!("Custom agent requires a {} API key: {}", role.provider, e))?;
    let provider = get_provider(&role.provider)?;
    let tools = allowed_tool_definitions(&allowed, &parent.tools);

    let result = crate::core::tool_subagent::run_agent_loop(
        &*provider,
        &api_key,
        role.model,
        agent.system_prompt.clone(),
        tools,
        role.max_output_tokens,
        role.max_requests,
        task,
        parent_target,
        "Custom agent finished without producing output",
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
    use crate::core::tool_subagent::{ParentLlm, PARENT_LLM};
    use std::sync::Arc;

    #[test]
    fn project_definition_is_advertised_and_invoked_from_the_same_snapshot() {
        let agent = CustomAgentDef {
            name: "Project Reviewer".into(),
            description: "project-only instructions".into(),
            model: None,
            color: None,
            allowed_tools: vec![],
            system_prompt: "trusted project body".into(),
            source: "project".into(),
        };
        let frozen = vec![agent];
        let tools = custom_agent_definitions(&frozen);
        assert_eq!(tools[0].name, "agent_project_reviewer");
        let invoked = find_agent(&tools[0].name, &frozen).unwrap();
        assert_eq!(invoked.description, tools[0].description);
        assert_eq!(invoked.system_prompt, "trusted project body");
    }

    #[test]
    fn custom_tools_intersect_parent_authority_without_rediscovery_or_fallback() {
        let agent = CustomAgentDef {
            name: "reviewer".into(),
            description: "".into(),
            model: None,
            color: None,
            allowed_tools: vec![
                "mcp__excluded__read".into(),
                "web_fetch".into(),
                "read_file".into(),
            ],
            system_prompt: "".into(),
            source: "global".into(),
        };
        let parent = vec![ToolDefinition {
            name: "read_file".into(),
            description: "".into(),
            parameters: serde_json::json!({}),
        }];
        let tools = allowed_tool_definitions(&requested_allowed_tools(&agent), &parent);
        assert_eq!(tools.len(), 1);
        assert_eq!(tools[0].name, "read_file");
    }

    #[test]
    fn custom_agents_cannot_be_granted_execution_tools() {
        let requested = vec![
            "read_file".to_string(),
            "bash".to_string(),
            "write_file".to_string(),
            "edit_file".to_string(),
            "create_pull_request".to_string(),
            "web_fetch".to_string(),
        ];
        let kept = filter_subagent_tools("reviewer", requested);
        assert_eq!(kept, vec!["read_file".to_string(), "web_fetch".to_string()]);
    }

    #[test]
    fn sanitize_basic() {
        assert_eq!(sanitize_name("code-reviewer"), "code_reviewer");
        assert_eq!(sanitize_name("Doc Writer"), "doc_writer");
        assert_eq!(sanitize_name("test--agent--"), "test_agent");
        assert_eq!(sanitize_name("API Surface 2"), "api_surface_2");
    }

    #[test]
    fn custom_agent_route_uses_the_shared_resolver_with_the_floor_applied() {
        let agent = CustomAgentDef {
            name: "reviewer".into(),
            description: "".into(),
            model: Some("claude-opus-4-1".into()),
            color: None,
            allowed_tools: vec![
                "read_file".into(),
                "bash".into(),
                "write_file".into(),
                "edit_file".into(),
            ],
            system_prompt: "".into(),
            source: "global".into(),
        };
        // The denied-mutation floor still applies before resolution.
        let allowed = requested_allowed_tools(&agent);
        assert_eq!(allowed, vec!["read_file".to_string()]);

        let role = resolve_subagent_role(
            agent.model.as_deref(),
            "anthropic",
            "claude-sonnet-4-6",
            "agent_reviewer",
            allowed,
            CUSTOM_AGENT_MAX_OUTPUT_TOKENS,
        )
        .unwrap();
        assert_eq!(
            role.route_source,
            crate::core::subagent_role::RouteSource::ExplicitOverride
        );
        assert_eq!(role.model, "claude-opus-4-1");
        assert_eq!(role.max_output_tokens, CUSTOM_AGENT_MAX_OUTPUT_TOKENS);
        assert_eq!(role.allowed_tools, vec!["read_file".to_string()]);
        for denied in ["bash", "write_file", "edit_file"] {
            assert!(
                !role.allowed_tools.iter().any(|name| name == denied),
                "{denied} must be filtered out"
            );
        }
    }

    #[test]
    fn a_blank_frontmatter_model_inherits_the_parent_route() {
        let agent = CustomAgentDef {
            name: "reviewer".into(),
            description: "".into(),
            model: Some("   ".into()),
            color: None,
            allowed_tools: vec![],
            system_prompt: "".into(),
            source: "global".into(),
        };
        let model_override = agent
            .model
            .as_deref()
            .map(str::trim)
            .filter(|model| !model.is_empty());
        let role = resolve_subagent_role(
            model_override,
            "anthropic",
            "claude-sonnet-4-6",
            "agent_reviewer",
            vec![],
            CUSTOM_AGENT_MAX_OUTPUT_TOKENS,
        )
        .unwrap();
        assert_eq!(
            role.route_source,
            crate::core::subagent_role::RouteSource::InheritedParent
        );
        assert_eq!(role.model, "claude-haiku-4-5");
    }

    fn parent_with(agents: Vec<CustomAgentDef>) -> ParentLlm {
        ParentLlm {
            provider: "anthropic".into(),
            model: "claude-sonnet-4-6".into(),
            tools: Arc::new(Vec::new()),
            custom_agents: Arc::new(agents),
            enabled_mcp_server_ids: Some(vec![]),
            mcp_trust_snapshot: Some(vec![]),
            native_mcp_session: Arc::new(Default::default()),
            tasks: Arc::new(Default::default()),
            record_usage: Arc::new(|_| Ok(())),
            child_budget: None,
        }
    }

    #[tokio::test]
    async fn an_invalid_frontmatter_model_is_refused_before_the_provider() {
        let agent = CustomAgentDef {
            name: "reviewer".into(),
            description: "".into(),
            model: Some("bad\nmodel".into()),
            color: None,
            allowed_tools: vec!["read_file".into()],
            system_prompt: "".into(),
            source: "global".into(),
        };
        let context = parent_with(vec![agent]);
        let args = serde_json::json!({ "task": "x" });
        let target = ExecutionTarget::Local {
            project_path: ".".into(),
        };
        let error = PARENT_LLM
            .scope(
                context,
                execute_custom_agent("agent_reviewer", &args, &target),
            )
            .await
            .unwrap_err();
        // Rejected before any credential load or provider construction.
        assert!(error.contains("failed"));
        assert!(error.contains("control characters"));
        assert!(!error.contains("API key"));
    }
}
