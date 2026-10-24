//! H7 (R7) — the one explicit child-role resolver.
//!
//! `spawn_subagent` and the custom `agent_*` tools both derive their provider,
//! model and route from the parent session through this module instead of a
//! second policy ladder. The route is always stated ([`RouteSource`]); a caller
//! model override is validated before any credential is loaded or provider is
//! constructed.
//!
//! Validation is structural only. An override that is non-empty, within the
//! length bound and free of control characters passes here even when no
//! provider serves it. The provider/route pair is confirmed downstream by
//! `get_provider` and the keyring load, which fail before spend for an
//! unroutable provider. This module deliberately stays free of I/O so
//! resolution is unit-testable.

use serde::{Deserialize, Serialize};

use crate::core::aux_llm::cheap_tier_model;
use crate::core::tool_subagent::ChildUsage;

/// Role revision for the v1 resolver. Bumped only for an incompatible change to
/// how a role resolves, never for an ordinary default tweak.
pub const ROLE_REVISION: i64 = 1;

/// The request ceiling of one child. `tool_subagent::MAX_ITERATIONS` derives
/// from this so the loop bound and the role spec cannot drift.
pub const SUBAGENT_MAX_REQUESTS: u32 = 8;

/// The default child output budget used by `spawn_subagent`.
pub const SUBAGENT_MAX_OUTPUT_TOKENS: u32 = 2048;

/// Versioned context-fit policy the child runs under (R6 estimate model).
pub const SUBAGENT_CONTEXT_POLICY: &str = "estimate-v1";

/// Longest accepted model override. Model ids are short; anything longer is a
/// malformed input, not a real route.
pub const MAX_MODEL_OVERRIDE_LEN: usize = 128;

/// Where a child's route came from. Always explicit — the default role inherits
/// the parent route and says so rather than leaving it implicit.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RouteSource {
    /// Derived from the parent session: parent provider at its cheap tier.
    InheritedParent,
    /// A caller- or frontmatter-supplied model on the parent provider.
    ExplicitOverride,
}

/// An immutable, resolved child role. One role per child invocation.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct SubagentRoleSpec {
    pub role_id: String,
    pub role_revision: i64,
    pub provider: String,
    pub model: String,
    pub route_source: RouteSource,
    pub allowed_tools: Vec<String>,
    pub max_requests: u32,
    pub max_output_tokens: u32,
    pub context_policy: String,
}

/// A refused role. Means "do not dispatch".
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RoleError {
    /// The supplied model override failed structural validation.
    InvalidModel { reason: String },
}

impl std::fmt::Display for RoleError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            RoleError::InvalidModel { reason } => {
                write!(f, "Invalid sub-agent model override: {reason}")
            }
        }
    }
}

impl std::error::Error for RoleError {}

/// Structural validation of a caller model override: non-empty after trimming,
/// at most [`MAX_MODEL_OVERRIDE_LEN`] characters, no control characters.
pub fn validate_model_override(model: &str) -> Result<(), RoleError> {
    let trimmed = model.trim();
    if trimmed.is_empty() {
        return Err(RoleError::InvalidModel {
            reason: "model override must not be empty".to_string(),
        });
    }
    if trimmed.chars().count() > MAX_MODEL_OVERRIDE_LEN {
        return Err(RoleError::InvalidModel {
            reason: format!("model override must be at most {MAX_MODEL_OVERRIDE_LEN} characters"),
        });
    }
    if model.chars().any(char::is_control) {
        return Err(RoleError::InvalidModel {
            reason: "model override must not contain control characters".to_string(),
        });
    }
    Ok(())
}

/// Resolve the immutable role for one child invocation.
///
/// * `Some(m)` — an explicit override: validated, then paired with the parent
///   provider (`ExplicitOverride`).
/// * `None` — inherit the parent route at its cheap tier (`InheritedParent`).
///
/// `max_output_tokens` is the caller's own ceiling (spawn vs. custom agent).
pub fn resolve_subagent_role(
    input_model: Option<&str>,
    parent_provider: &str,
    parent_model: &str,
    role_id: &str,
    allowed_tools: Vec<String>,
    max_output_tokens: u32,
) -> Result<SubagentRoleSpec, RoleError> {
    let (model, route_source) = match input_model {
        Some(model) => {
            validate_model_override(model)?;
            (model.trim().to_string(), RouteSource::ExplicitOverride)
        }
        None => (
            cheap_tier_model(parent_provider, parent_model),
            RouteSource::InheritedParent,
        ),
    };
    Ok(SubagentRoleSpec {
        role_id: role_id.to_string(),
        role_revision: ROLE_REVISION,
        provider: parent_provider.to_string(),
        model,
        route_source,
        allowed_tools,
        max_requests: SUBAGENT_MAX_REQUESTS,
        max_output_tokens,
        context_policy: SUBAGENT_CONTEXT_POLICY.to_string(),
    })
}

/// Terminal status of one child run. `Incomplete` is a bounded loop that ran
/// out of rounds; `Blocked` is a refusal (e.g. budget) before completion.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SubagentStatus {
    Completed,
    Incomplete,
    Blocked,
    Failed,
}

/// Structured outcome of one child run. Rendered to the parent through
/// [`SubagentResult::to_tool_content`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SubagentResult {
    pub child_run_id: String,
    pub status: SubagentStatus,
    pub summary: String,
    pub incomplete_reason: Option<String>,
    pub usage: Option<ChildUsage>,
}

impl SubagentResult {
    /// A failed child outcome for a role that never dispatched (e.g. a rejected
    /// model override). Carries a fresh `child_run_id` so the parent still has a
    /// correlated identity for the attempt.
    pub fn failed(summary: String) -> Self {
        SubagentResult {
            child_run_id: uuid::Uuid::new_v4().to_string(),
            status: SubagentStatus::Failed,
            summary,
            incomplete_reason: None,
            usage: None,
        }
    }

    /// A stable, human-readable tool result. The completed case is the bare
    /// summary (the pre-R7 shape); every other status states itself explicitly.
    pub fn to_tool_content(&self) -> String {
        match self.status {
            SubagentStatus::Completed => self.summary.clone(),
            SubagentStatus::Incomplete => {
                let reason = self
                    .incomplete_reason
                    .as_deref()
                    .unwrap_or("no final answer was produced");
                if self.summary.trim().is_empty() {
                    format!("Sub-agent incomplete: {reason}.")
                } else {
                    format!(
                        "Sub-agent incomplete: {reason}. Partial progress: {}",
                        self.summary
                    )
                }
            }
            SubagentStatus::Blocked => {
                let reason = self
                    .incomplete_reason
                    .as_deref()
                    .filter(|r| !r.is_empty())
                    .unwrap_or(&self.summary);
                format!("Sub-agent blocked: {reason}")
            }
            SubagentStatus::Failed => format!("Sub-agent failed: {}", self.summary),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn no_override_inherits_the_parent_route_explicitly() {
        let spec = resolve_subagent_role(
            None,
            "anthropic",
            "claude-sonnet-4-6",
            "spawn_subagent",
            vec!["read_file".to_string()],
            SUBAGENT_MAX_OUTPUT_TOKENS,
        )
        .unwrap();
        assert_eq!(spec.provider, "anthropic");
        assert_eq!(spec.model, "claude-haiku-4-5");
        assert_eq!(spec.route_source, RouteSource::InheritedParent);
        assert_eq!(spec.role_id, "spawn_subagent");
        assert_eq!(spec.role_revision, ROLE_REVISION);
        assert_eq!(spec.max_requests, SUBAGENT_MAX_REQUESTS);
        assert_eq!(spec.max_output_tokens, SUBAGENT_MAX_OUTPUT_TOKENS);
        assert_eq!(spec.context_policy, SUBAGENT_CONTEXT_POLICY);
        assert_eq!(spec.allowed_tools, vec!["read_file".to_string()]);
    }

    #[test]
    fn a_valid_override_wins_and_is_marked_explicit() {
        let spec = resolve_subagent_role(
            Some("claude-opus-4-1"),
            "anthropic",
            "claude-sonnet-4-6",
            "spawn_subagent",
            Vec::new(),
            SUBAGENT_MAX_OUTPUT_TOKENS,
        )
        .unwrap();
        assert_eq!(spec.provider, "anthropic");
        assert_eq!(spec.model, "claude-opus-4-1");
        assert_eq!(spec.route_source, RouteSource::ExplicitOverride);
    }

    #[test]
    fn the_caller_ceiling_is_carried_into_the_role() {
        let spec = resolve_subagent_role(
            None,
            "anthropic",
            "claude-sonnet-4-6",
            "agent_reviewer",
            Vec::new(),
            4096,
        )
        .unwrap();
        assert_eq!(spec.max_output_tokens, 4096);
        assert_eq!(spec.max_requests, SUBAGENT_MAX_REQUESTS);
    }

    #[test]
    fn ollama_inherits_the_parent_model_because_it_has_no_cheap_tier() {
        let spec = resolve_subagent_role(
            None,
            "ollama",
            "qwen3:32b",
            "spawn_subagent",
            Vec::new(),
            SUBAGENT_MAX_OUTPUT_TOKENS,
        )
        .unwrap();
        assert_eq!(spec.model, "qwen3:32b");
        assert_eq!(spec.route_source, RouteSource::InheritedParent);
    }

    #[test]
    fn invalid_overrides_are_rejected_before_any_route_is_formed() {
        for bad in ["", "   ", "line\nbreak", "tab\there", "nul\0byte"] {
            assert!(
                matches!(
                    validate_model_override(bad),
                    Err(RoleError::InvalidModel { .. })
                ),
                "{bad:?} must be rejected"
            );
            assert!(matches!(
                resolve_subagent_role(
                    Some(bad),
                    "anthropic",
                    "claude",
                    "role",
                    Vec::new(),
                    SUBAGENT_MAX_OUTPUT_TOKENS
                ),
                Err(RoleError::InvalidModel { .. })
            ));
        }
        let too_long = "m".repeat(MAX_MODEL_OVERRIDE_LEN + 1);
        assert!(matches!(
            validate_model_override(&too_long),
            Err(RoleError::InvalidModel { .. })
        ));
        assert!(validate_model_override(&"m".repeat(MAX_MODEL_OVERRIDE_LEN)).is_ok());
    }

    #[test]
    fn status_and_route_source_serialize_as_snake_case() {
        assert_eq!(
            serde_json::to_string(&RouteSource::InheritedParent).unwrap(),
            "\"inherited_parent\""
        );
        assert_eq!(
            serde_json::to_string(&SubagentStatus::Incomplete).unwrap(),
            "\"incomplete\""
        );
    }

    #[test]
    fn completed_result_renders_the_bare_summary() {
        let result = SubagentResult {
            child_run_id: "child-1".to_string(),
            status: SubagentStatus::Completed,
            summary: "the answer".to_string(),
            incomplete_reason: None,
            usage: None,
        };
        assert_eq!(result.to_tool_content(), "the answer");
    }

    #[test]
    fn incomplete_and_failed_results_state_their_status_and_reason() {
        let incomplete = SubagentResult {
            child_run_id: "child-1".to_string(),
            status: SubagentStatus::Incomplete,
            summary: "partial".to_string(),
            incomplete_reason: Some("reached the 8-round limit".to_string()),
            usage: None,
        };
        let rendered = incomplete.to_tool_content();
        assert!(rendered.contains("incomplete"));
        assert!(rendered.contains("reached the 8-round limit"));
        assert!(rendered.contains("partial"));

        let failed = SubagentResult::failed(
            RoleError::InvalidModel {
                reason: "model override must not be empty".to_string(),
            }
            .to_string(),
        );
        assert!(failed.to_tool_content().contains("failed"));
        assert!(failed.to_tool_content().contains("must not be empty"));
    }
}
