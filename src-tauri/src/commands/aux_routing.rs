//! Tauri surface for the auxiliary LLM routing settings.
//!
//! The frontend routing store (`src/stores/routingStore.ts`) owns persistence;
//! this module keeps the backend's in-memory mirror current and reports what a
//! given task class currently resolves to so the settings card can show the
//! live answer instead of a promise. See [`crate::core::aux_llm`] for the
//! resolution rules.

use std::collections::HashMap;

use serde::Serialize;
use tauri::State;

use crate::core::aux_llm::{
    self, AuxOverrides, AuxRouteOverride, AuxRoutingState, AuxTaskClass, AUX_PROVIDERS,
};

/// One row for the settings card: what this task class resolves to right now,
/// or why it can't resolve.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AuxRouteResolution {
    pub task_class: String,
    pub label: String,
    pub provider: Option<String>,
    pub model: Option<String>,
    /// True when a routing-settings pin produced this route.
    pub explicit: bool,
    /// Present instead of provider/model when resolution failed.
    pub error: Option<String>,
}

/// One selectable auxiliary provider, for the settings card's picker.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AuxProviderOption {
    pub provider: String,
    pub default_model: String,
    pub needs_api_key: bool,
    /// Whether a keyring credential exists for it right now.
    pub configured: bool,
}

/// Replace the backend's mirror of the auxiliary routing settings.
///
/// Keys are `AuxTaskClass` wire ids; unknown ids are ignored rather than
/// failing the whole push, so an older backend paired with a newer frontend
/// degrades to automatic routing for the classes it doesn't know.
#[tauri::command]
pub async fn set_aux_routing_overrides(
    state: State<'_, AuxRoutingState>,
    overrides: HashMap<String, AuxRouteOverride>,
) -> Result<(), String> {
    let mut parsed = AuxOverrides::new();
    for (id, value) in overrides {
        match AuxTaskClass::from_id(&id) {
            Some(task) => {
                parsed.insert(task, value);
            }
            None => {
                tracing::warn!(task_class = %id, "set_aux_routing_overrides: unknown task class ignored");
            }
        }
    }
    state.replace(parsed);
    Ok(())
}

/// What every auxiliary task class resolves to against the current settings and
/// the current keyring.
#[tauri::command]
pub async fn get_aux_route_resolutions(
    state: State<'_, AuxRoutingState>,
) -> Result<Vec<AuxRouteResolution>, String> {
    let overrides = state.snapshot();
    let configured = aux_llm::configured_aux_providers();

    Ok(AuxTaskClass::ALL
        .iter()
        .map(
            |task| match aux_llm::resolve_aux_route(*task, &overrides, &configured) {
                Ok(route) => AuxRouteResolution {
                    task_class: task.id().to_string(),
                    label: task.label().to_string(),
                    provider: Some(route.provider),
                    model: Some(route.model),
                    explicit: route.explicit,
                    error: None,
                },
                Err(error) => AuxRouteResolution {
                    task_class: task.id().to_string(),
                    label: task.label().to_string(),
                    provider: None,
                    model: None,
                    explicit: false,
                    error: Some(error),
                },
            },
        )
        .collect())
}

/// The providers an auxiliary task class may be pinned to, plus whether each
/// currently has a credential.
#[tauri::command]
pub async fn get_aux_provider_options() -> Result<Vec<AuxProviderOption>, String> {
    let configured = aux_llm::configured_aux_providers();
    Ok(AUX_PROVIDERS
        .iter()
        .map(|candidate| AuxProviderOption {
            provider: candidate.provider.to_string(),
            default_model: candidate.default_model.to_string(),
            needs_api_key: candidate.needs_api_key,
            configured: !candidate.needs_api_key
                || configured.iter().any(|c| c == candidate.provider),
        })
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The four auxiliary features' source, compiled in so the assertion below
    /// can't drift from what actually ships.
    const AUXILIARY_FEATURE_SOURCES: &[(&str, &str)] = &[
        ("commands/issues.rs", include_str!("issues.rs")),
        ("commands/code_quality.rs", include_str!("code_quality.rs")),
        ("commands/github.rs", include_str!("github.rs")),
        ("commands/insights.rs", include_str!("insights.rs")),
    ];

    /// §6 of `dev/oauth-removal-plan.md` asks for this as a standing check:
    /// *"after Stage A, no code path under `src-tauri/src` can reach
    /// `forward_start` with `\"claude-oauth\"`."*
    ///
    /// The three auxiliary command modules were the only callers of a bare
    /// `forward_start`. `api_agent.rs` still starts sidecar sessions, but only
    /// through its routing layer, which is gated by `is_sidecar_provider` and
    /// driven by the provider the user picked.
    #[test]
    fn auxiliary_features_never_start_a_sidecar_session() {
        for (name, source) in AUXILIARY_FEATURE_SOURCES {
            assert!(
                !source.contains(".forward_start"),
                "{} calls forward_start — auxiliary features must route through core::aux_llm",
                name
            );
        }
    }

    /// LM4 (3C-2/3C-5) — the migrated pure-text surfaces must stay off the
    /// Claude CLI, and the de-hardcoded surfaces must stay off a literal
    /// model id.
    ///
    /// 3C-3 memory half (done): `scan_codebase_memory` now assembles its
    /// context in `core::aux_context` and runs one seam turn, so **no**
    /// `run_claude` caller survives in memory.rs. Project-aware chat and issue
    /// investigation use the bounded `core::aux_research` read-only loop.
    #[test]
    fn migrated_surfaces_stay_on_the_aux_seam() {
        assert!(
            !include_str!("spec.rs").contains("run_claude("),
            "spec.rs regressed onto the Claude CLI"
        );
        assert_eq!(
            include_str!("memory.rs").matches("run_claude(").count(),
            0,
            "memory.rs is fully migrated (3C-3 memory half) — it must not call the Claude CLI"
        );
        // Mechanism-1 sites: the provider/model choice must come from the
        // routing seam, never a string literal.
        for (name, source) in [
            ("side_chat.rs", include_str!("side_chat.rs")),
            ("github.rs", include_str!("github.rs")),
        ] {
            assert!(
                !source.contains("\"claude-haiku-4-5\""),
                "{} re-hardcoded a model id",
                name
            );
        }
    }

    /// Every auxiliary feature must be reachable from the routing settings, or
    /// it is silently unroutable and the settings card lies again.
    #[test]
    fn every_task_class_reports_a_resolution_row() {
        let overrides = aux_llm::AuxOverrides::new();
        let rows: Vec<_> = AuxTaskClass::ALL
            .iter()
            .map(|task| aux_llm::resolve_aux_route(*task, &overrides, &[]))
            .collect();
        assert_eq!(rows.len(), AuxTaskClass::ALL.len());
        // With nothing configured, every row must be an honest error rather
        // than a route.
        assert!(rows.iter().all(|r| r.is_err()));
    }

    /// Both project-aware auxiliary features must honour Settings and stay off CLI credentials.
    #[test]
    fn project_research_surfaces_honour_routing() {
        for (source, task) in [
            (include_str!("github.rs"), "AuxTaskClass::IssueInvestigate"),
            (include_str!("insights.rs"), "AuxTaskClass::AgentChat"),
        ] {
            assert!(source.contains(task));
            assert!(!source.contains("run_claude("));
            assert!(!source.contains("claude_command()"));
        }
        assert!(!include_str!("../../../src/types/routing.ts").contains("Not applied yet"));
    }

    #[test]
    fn unknown_task_class_ids_are_ignored_not_fatal() {
        // A newer frontend pushing a task class this build doesn't know must
        // degrade to automatic routing, not poison the whole settings push.
        assert_eq!(AuxTaskClass::from_id("some-future-task"), None);
    }

    #[test]
    fn provider_options_never_offer_a_subscription_login() {
        for candidate in AUX_PROVIDERS {
            assert_ne!(candidate.provider, "claude-oauth");
            assert_ne!(candidate.provider, "openai-codex");
        }
    }
}
