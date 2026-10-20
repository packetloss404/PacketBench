use std::collections::BTreeMap;

use crate::api::{
    AgentConfigDto, CliAccountDto, FlightDto, OrchestratorSettingsDto, PersistedStateDto,
    PersistedUiStateDto, ServerConfigDto, WorkspaceDto,
};
use crate::core::flight::Issue;
use crate::core::orchestrator::OrchestratorSettings;
use crate::core::storage::{self};

#[tauri::command]
pub fn load_persisted_state() -> Result<PersistedStateDto, String> {
    let started = std::time::Instant::now();
    tracing::info!("Persisted state read started");
    let state: PersistedStateDto = storage::load_state().into();
    tracing::info!(
        elapsed_ms = started.elapsed().as_millis() as u64,
        version = state.version,
        flights = state.flights.len(),
        "Persisted state read completed"
    );
    Ok(state)
}

/// Bulk-save the persisted state.
///
/// **Issue-slice contract:** the `issues` and `retrospectives` fields of the
/// incoming DTO are *intentionally ignored*. Those two slices are owned
/// exclusively by [`save_issues_slice`] and [`save_retrospectives`]; this bulk
/// save always keeps whatever is already on disk for them. That prevents a
/// concurrent slice write — landing between the frontend's
/// `load_persisted_state` and this call — from being silently clobbered by a
/// stale bulk snapshot. Callers must persist issue / retrospective changes
/// through those dedicated slice commands, never by stuffing them into the DTO
/// passed here.
#[tauri::command]
pub async fn save_persisted_state(state: PersistedStateDto) -> Result<(), String> {
    let incoming: crate::core::storage::PersistedState = state.into();
    storage::update_state_async(|state| {
        // Take the on-disk issues/retrospectives aside, overwrite everything
        // else with `incoming`, then put the slice-owned data back — so the
        // incoming DTO's issues/retrospectives are dropped, not persisted.
        // See the issue-slice contract on this function.
        let preserved_issues = std::mem::take(&mut state.issues);
        let preserved_retros = std::mem::take(&mut state.retrospectives);
        // Backend-only marker: `PersistedStateDto` has no field for it, so a
        // frontend bulk save would otherwise clear it and make the one-time
        // cost-reprice pass rescan the ledger on every subsequent launch.
        let preserved_reprice = state.cost_reprice_v1_at.take();
        *state = incoming;
        state.issues = preserved_issues;
        state.retrospectives = preserved_retros;
        state.cost_reprice_v1_at = preserved_reprice;
    })
    .await
}

#[tauri::command]
pub async fn save_flights_slice(flights: Vec<FlightDto>) -> Result<(), String> {
    storage::save_flights(flights.into_iter().map(Into::into).collect()).await
}

#[tauri::command]
pub async fn save_agents_slice(agents: Vec<AgentConfigDto>) -> Result<(), String> {
    storage::save_agents(agents.into_iter().map(Into::into).collect()).await
}

#[tauri::command]
pub async fn save_settings_slice(settings: OrchestratorSettingsDto) -> Result<(), String> {
    // Persist to disk. Everything that reads settings (e.g. the worktree
    // auto-trailer hook) loads them fresh from disk via `load_state().settings`,
    // so there is no in-memory copy left to keep in sync.
    let settings: OrchestratorSettings = settings.into();
    storage::save_settings(settings).await
}

#[tauri::command]
pub async fn save_ui_slice(ui: PersistedUiStateDto) -> Result<(), String> {
    storage::save_ui(ui.into()).await
}

#[tauri::command]
pub async fn save_issues_slice(issues: Vec<Issue>) -> Result<(), String> {
    storage::save_issues(issues).await
}

#[tauri::command]
pub async fn save_workspaces_slice(workspaces: Vec<WorkspaceDto>) -> Result<(), String> {
    storage::save_workspaces(workspaces.into_iter().map(Into::into).collect()).await
}

#[tauri::command]
pub async fn save_memory_slice(
    memory_events: Vec<serde_json::Value>,
    memory_patterns: Vec<serde_json::Value>,
) -> Result<(), String> {
    storage::save_memory(memory_events, memory_patterns).await
}

#[tauri::command]
pub async fn save_servers_slice(servers: Vec<ServerConfigDto>) -> Result<(), String> {
    storage::save_servers(servers.into_iter().map(Into::into).collect()).await
}

/// Persist the CLI-account slice (records + sticky per-project defaults).
///
/// Mirrors [`save_servers_slice`]: the frontend store owns the list and
/// re-sends the whole slice on every mutation, so the backend never has to
/// merge. `defaults` maps `project path -> cli -> account id`; entries whose
/// account no longer exists are the store's responsibility to prune before
/// calling.
#[tauri::command]
pub async fn save_cli_accounts_slice(
    accounts: Vec<CliAccountDto>,
    defaults: BTreeMap<String, BTreeMap<String, String>>,
) -> Result<(), String> {
    storage::save_cli_accounts(accounts.into_iter().map(Into::into).collect(), defaults).await
}
