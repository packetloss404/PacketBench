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
use crate::core::tool_subagent::current_parent_llm;

const TOOL_PREFIX: &str = "agent_";

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

fn build_allowed_tools(
    agent: &CustomAgentDef,
    parent_tools: &[ToolDefinition],
) -> Vec<ToolDefinition> {
    let allowed: Vec<String> = if agent.allowed_tools.is_empty() {
        DEFAULT_READ_ONLY_TOOLS
            .iter()
            .map(|s| s.to_string())
            .collect()
    } else {
        filter_subagent_tools(&agent.name, agent.allowed_tools.clone())
    };

    parent_tools
        .iter()
        .filter(|t| allowed.iter().any(|name| name == &t.name))
        .cloned()
        .collect()
}

/// Tool entry-point for `agent_*` invocations dispatched from `tool_runtime::execute_tool`.
#[allow(dead_code)]
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
    // the user may have no key for. An explicit frontmatter `model` still
    // wins (it is the agent author's choice); the derived cheap-tier model is
    // only the default.
    let (provider_id, derived_model) = crate::core::tool_subagent::subagent_provider_and_model();
    let api_key = crate::commands::api_keys::load_api_key(&provider_id)
        .map_err(|e| format!("Custom agent requires a {} API key: {}", provider_id, e))?;

    let provider = get_provider(&provider_id)?;
    let tools = build_allowed_tools(agent, &parent.tools);
    let model = agent
        .model
        .as_ref()
        .map(|m| m.trim().to_string())
        .filter(|m| !m.is_empty())
        .unwrap_or(derived_model);

    crate::core::tool_subagent::run_agent_loop(
        &*provider,
        &api_key,
        model,
        agent.system_prompt.clone(),
        tools,
        4096,
        task,
        parent_target,
        "Custom agent finished without producing output",
    )
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

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
        let tools = build_allowed_tools(&agent, &parent);
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
}
