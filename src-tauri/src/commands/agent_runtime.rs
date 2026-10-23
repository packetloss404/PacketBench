//! R1a runtime journal commands. Inert unless `PACKETBENCH_RUNTIME_JOURNAL=1`.
//! Nothing in the live agent loop calls these yet; they exist so the substrate
//! can be exercised and validated before integration.

use crate::core::runtime_journal as journal;
use crate::core::runtime_types::{
    PrepareRuntimeRunInput, PrepareRuntimeRunResult, RuntimeEventView, RuntimeLaunchView,
    RuntimeRunSummary,
};

async fn on_blocking<T: Send + 'static>(
    work: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    tokio::task::spawn_blocking(work)
        .await
        .map_err(|e| format!("Runtime journal task failed: {e}"))?
}

#[tauri::command]
pub async fn prepare_runtime_run(
    input: PrepareRuntimeRunInput,
) -> Result<PrepareRuntimeRunResult, String> {
    on_blocking(move || {
        journal::with_journal(|connection| journal::prepare_operation(connection, &input))
    })
    .await
}

#[tauri::command]
pub async fn get_runtime_launch(operation_id: String) -> Result<RuntimeLaunchView, String> {
    on_blocking(move || {
        journal::with_journal(|connection| journal::get_operation(connection, &operation_id))
    })
    .await
}

#[tauri::command]
pub async fn get_runtime_run(run_id: String) -> Result<RuntimeRunSummary, String> {
    on_blocking(move || journal::with_journal(|connection| journal::get_run(connection, &run_id)))
        .await
}

#[tauri::command]
pub async fn list_runtime_events(
    run_id: String,
    after_seq: i64,
    limit: i64,
) -> Result<Vec<RuntimeEventView>, String> {
    on_blocking(move || {
        journal::with_journal(|connection| {
            journal::list_events(connection, &run_id, after_seq, limit)
        })
    })
    .await
}

#[tauri::command]
pub async fn cancel_runtime_run(
    operation_id: String,
    expected_epoch: i64,
) -> Result<RuntimeLaunchView, String> {
    on_blocking(move || {
        journal::with_journal(|connection| {
            journal::cancel_operation(connection, &operation_id, expected_epoch)
        })
    })
    .await
}
