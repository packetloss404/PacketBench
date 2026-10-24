//! R1a runtime journal: one local SQLite database owning launch operations,
//! runs and append-only run events. Substrate only — nothing in the live agent
//! loop calls this yet, and every command is gated behind
//! `PACKETBENCH_RUNTIME_JOURNAL=1` (default off).
//!
//! Durability: rollback journal + `synchronous=FULL` + foreign keys, one
//! serialized connection. Migrations use `PRAGMA user_version`; a newer schema
//! or a corrupt file fails closed rather than guessing.

use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};

use rusqlite::{params, Connection, OptionalExtension};
use sha2::{Digest, Sha256};
use uuid::Uuid;

use super::runtime_types::{
    validate_id, validate_sha256_digest, FrozenRuntimeLaunch, PrepareRuntimeRunInput,
    PrepareRuntimeRunResult, RuntimeEventView, RuntimeLaunchView, RuntimeRunSummary,
    MAX_EVENTS_PAGE,
};

/// On-disk journal schema version, tracked by `PRAGMA user_version`.
///
/// R3a (H2 typed checkpoints) bumps this from 1 to 2 to add the `checkpoints`
/// table. This is the JOURNAL migration target; it is deliberately separate from
/// `runtime_types::RUNTIME_SCHEMA_VERSION`, which is the `RuntimeRunSummary`
/// wire version (still 1). A file written by a newer build is refused, never
/// downgraded.
pub const JOURNAL_SCHEMA_VERSION: i64 = 2;

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn hash_text(text: &str) -> String {
    format!("sha256:{:x}", Sha256::digest(text.as_bytes()))
}

/// Kill switch: the runtime journal is inert unless explicitly enabled.
pub fn is_enabled() -> bool {
    std::env::var("PACKETBENCH_RUNTIME_JOURNAL")
        .map(|v| v == "1")
        .unwrap_or(false)
}

fn journal_path() -> Result<PathBuf, String> {
    let dir = crate::core::storage::data_dir().join("agent-runtime");
    std::fs::create_dir_all(&dir).map_err(|e| format!("Failed to create runtime dir: {e}"))?;
    Ok(dir.join("journal.db"))
}

static JOURNAL: OnceLock<Mutex<Connection>> = OnceLock::new();

/// Run `f` against the single journal connection. The caller must already be on
/// a blocking worker thread (commands use `spawn_blocking`). Fail-closed: a
/// failed open/migration returns an error and does not cache a connection.
pub fn with_journal<T>(f: impl FnOnce(&Connection) -> Result<T, String>) -> Result<T, String> {
    if !is_enabled() {
        return Err(
            "The runtime journal is disabled. Set PACKETBENCH_RUNTIME_JOURNAL=1 to enable it."
                .to_string(),
        );
    }
    let mutex = match JOURNAL.get() {
        Some(mutex) => mutex,
        None => {
            let connection = open_at(&journal_path()?)?;
            let _ = JOURNAL.set(Mutex::new(connection));
            JOURNAL.get().expect("just set")
        }
    };
    let guard = mutex
        .lock()
        .map_err(|_| "Runtime journal lock poisoned".to_string())?;
    f(&guard)
}

/// Open (creating if absent), apply durability pragmas and migrate. Used by the
/// command path and by tests with an explicit temp path.
pub fn open_at(path: &Path) -> Result<Connection, String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create journal dir: {e}"))?;
    }
    let connection =
        Connection::open(path).map_err(|e| format!("Failed to open runtime journal: {e}"))?;
    connection
        .execute_batch(
            "PRAGMA journal_mode=DELETE;\n\
             PRAGMA synchronous=FULL;\n\
             PRAGMA foreign_keys=ON;\n\
             PRAGMA busy_timeout=5000;",
        )
        .map_err(|e| format!("Failed to configure runtime journal: {e}"))?;
    migrate(&connection)?;
    Ok(connection)
}

/// Apply migrations by `user_version`. A version newer than this build supports
/// is refused (never downgraded); a corrupt/truncated file surfaces the SQLite
/// error instead of panicking.
pub fn migrate(connection: &Connection) -> Result<(), String> {
    let mut version: i64 = connection
        .query_row("PRAGMA user_version", [], |row| row.get(0))
        .map_err(|e| format!("Runtime journal is unreadable: {e}"))?;

    if version > JOURNAL_SCHEMA_VERSION {
        return Err(format!(
            "Runtime journal schema v{version} is newer than this build supports (v{JOURNAL_SCHEMA_VERSION}). Update PacketBench."
        ));
    }
    if version < 1 {
        connection
            .execute_batch(
                "BEGIN;\n\
                 CREATE TABLE launch_operations (\n\
                   operation_id TEXT PRIMARY KEY,\n\
                   conversation_id TEXT NOT NULL,\n\
                   kind TEXT NOT NULL,\n\
                   retry_of_operation_id TEXT,\n\
                   request_digest TEXT NOT NULL,\n\
                   frozen_input TEXT NOT NULL,\n\
                   run_id TEXT NOT NULL UNIQUE,\n\
                   phase TEXT NOT NULL,\n\
                   created_at INTEGER NOT NULL,\n\
                   cancelled_at INTEGER\n\
                 );\n\
                 CREATE TABLE conversation_owners (\n\
                   conversation_id TEXT PRIMARY KEY,\n\
                   project_key TEXT NOT NULL,\n\
                   revision INTEGER NOT NULL,\n\
                   latest_root_run_id TEXT\n\
                 );\n\
                 CREATE TABLE runs (\n\
                   run_id TEXT PRIMARY KEY,\n\
                   conversation_id TEXT NOT NULL,\n\
                   operation_id TEXT NOT NULL,\n\
                   previous_run_id TEXT,\n\
                   parent_run_id TEXT,\n\
                   root_run_id TEXT NOT NULL,\n\
                   epoch INTEGER NOT NULL,\n\
                   state TEXT NOT NULL,\n\
                   latest_seq INTEGER NOT NULL DEFAULT 0,\n\
                   instance_id TEXT\n\
                 );\n\
                 CREATE TABLE run_events (\n\
                   run_id TEXT NOT NULL,\n\
                   seq INTEGER NOT NULL,\n\
                   epoch INTEGER NOT NULL,\n\
                   kind TEXT NOT NULL,\n\
                   payload TEXT NOT NULL,\n\
                   payload_hash TEXT NOT NULL,\n\
                   created_at INTEGER NOT NULL,\n\
                   PRIMARY KEY (run_id, seq),\n\
                   FOREIGN KEY (run_id) REFERENCES runs(run_id)\n\
                 );\n\
                 CREATE INDEX idx_run_events_run_seq ON run_events(run_id, seq);\n\
                 PRAGMA user_version = 1;\n\
                 COMMIT;",
            )
            .map_err(|e| format!("Failed to initialize runtime journal schema: {e}"))?;
        version = 1;
    }
    if version < 2 {
        connection
            .execute_batch(
                "BEGIN;\n\
                 CREATE TABLE checkpoints (\n\
                   checkpoint_id TEXT PRIMARY KEY,\n\
                   run_id TEXT NOT NULL,\n\
                   epoch INTEGER NOT NULL,\n\
                   seq INTEGER NOT NULL,\n\
                   schema_version INTEGER NOT NULL,\n\
                   transport_version INTEGER NOT NULL,\n\
                   model_route TEXT NOT NULL,\n\
                   manifest_hash TEXT NOT NULL,\n\
                   tool_policy_hash TEXT NOT NULL,\n\
                   mcp_hash TEXT NOT NULL,\n\
                   payload TEXT NOT NULL,\n\
                   pending_effect_ids TEXT NOT NULL,\n\
                   payload_hash TEXT NOT NULL,\n\
                   classification TEXT NOT NULL,\n\
                   created_at INTEGER NOT NULL,\n\
                   FOREIGN KEY (run_id) REFERENCES runs(run_id)\n\
                 );\n\
                 CREATE INDEX idx_checkpoints_run_seq ON checkpoints(run_id, seq);\n\
                 PRAGMA user_version = 2;\n\
                 COMMIT;",
            )
            .map_err(|e| format!("Failed to migrate runtime journal to v2: {e}"))?;
    }
    Ok(())
}

fn insert_event(
    connection: &Connection,
    run_id: &str,
    epoch: i64,
    kind: &str,
    payload: &str,
) -> Result<(), String> {
    let seq: i64 = connection
        .query_row(
            "SELECT COALESCE(MAX(seq), -1) + 1 FROM run_events WHERE run_id = ?1",
            params![run_id],
            |row| row.get(0),
        )
        .map_err(|e| format!("Failed to read run event sequence: {e}"))?;
    connection
        .execute(
            "INSERT INTO run_events (run_id, seq, epoch, kind, payload, payload_hash, created_at) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![
                run_id,
                seq,
                epoch,
                kind,
                payload,
                hash_text(payload),
                now_ms()
            ],
        )
        .map_err(|e| format!("Failed to append run event: {e}"))?;
    connection
        .execute(
            "UPDATE runs SET latest_seq = ?1 WHERE run_id = ?2",
            params![seq, run_id],
        )
        .map_err(|e| format!("Failed to update run sequence: {e}"))?;
    Ok(())
}

fn operation_view(
    connection: &Connection,
    operation_id: &str,
) -> Result<RuntimeLaunchView, String> {
    connection
        .query_row(
            "SELECT operation_id, conversation_id, run_id, phase, request_digest, created_at, cancelled_at \
             FROM launch_operations WHERE operation_id = ?1",
            params![operation_id],
            |row| {
                Ok(RuntimeLaunchView {
                    operation_id: row.get(0)?,
                    conversation_id: row.get(1)?,
                    run_id: row.get(2)?,
                    phase: row.get(3)?,
                    request_digest: row.get(4)?,
                    created_at: row.get(5)?,
                    cancelled_at: row.get(6)?,
                })
            },
        )
        .optional()
        .map_err(|e| format!("Failed to read operation: {e}"))?
        .ok_or_else(|| format!("Unknown operation: {operation_id}"))
}

/// Idempotent prepare. Same `operation_id` + same digest returns the original
/// IDs; a changed digest is a conflict; a cancelled operation is never revived.
pub fn prepare_operation(
    connection: &Connection,
    input: &PrepareRuntimeRunInput,
) -> Result<PrepareRuntimeRunResult, String> {
    validate_id("operationId", &input.operation_id)?;
    validate_id("conversationId", &input.conversation_id)?;
    validate_sha256_digest(&input.request_digest)?;
    validate_id("draftId", &input.launch.draft_id)?;
    if input.launch.requested_isolation != "checkout" {
        return Err("R1a only supports requestedIsolation \"checkout\"".to_string());
    }
    if input.kind != "initial" && input.kind != "existing" {
        return Err("kind must be \"initial\" or \"existing\"".to_string());
    }
    if let Some(retry) = &input.retry_of_operation_id {
        validate_id("retryOfOperationId", retry)?;
    }

    if let Some(existing) = connection
        .query_row(
            "SELECT request_digest, run_id, phase FROM launch_operations WHERE operation_id = ?1",
            params![input.operation_id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                ))
            },
        )
        .optional()
        .map_err(|e| format!("Failed to read operation: {e}"))?
    {
        let (digest, run_id, phase) = existing;
        if digest != input.request_digest {
            return Err(format!(
                "Operation {} already exists with a different request digest",
                input.operation_id
            ));
        }
        let epoch: i64 = connection
            .query_row(
                "SELECT epoch FROM runs WHERE run_id = ?1",
                params![run_id],
                |row| row.get(0),
            )
            .map_err(|e| format!("Failed to read run: {e}"))?;
        return Ok(PrepareRuntimeRunResult {
            operation_id: input.operation_id.clone(),
            conversation_id: input.conversation_id.clone(),
            run_id,
            epoch,
            phase,
            created: false,
        });
    }

    let frozen = serde_json::to_string(&input.launch)
        .map_err(|e| format!("Failed to serialize frozen launch: {e}"))?;
    let run_id = Uuid::new_v4().to_string();
    let now = now_ms();

    connection
        .execute_batch("BEGIN IMMEDIATE")
        .map_err(|e| format!("Failed to begin prepare: {e}"))?;

    let result = (|| -> Result<(), String> {
        let owner: Option<(String, i64, Option<String>)> = connection
            .query_row(
                "SELECT project_key, revision, latest_root_run_id FROM conversation_owners WHERE conversation_id = ?1",
                params![input.conversation_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .optional()
            .map_err(|e| format!("Failed to read conversation owner: {e}"))?;

        let previous_run_id = match (input.kind.as_str(), owner.as_ref()) {
            ("initial", Some(_)) => {
                return Err(
                    "Conversation already has an initial owner; use kind \"existing\"".to_string(),
                )
            }
            ("existing", None) => {
                return Err("No conversation owner exists for an existing turn".to_string())
            }
            ("initial", None) => None,
            ("existing", Some((_, _, latest))) => latest.clone(),
            _ => unreachable!(),
        };

        match owner {
            Some((_, revision, _)) => {
                connection
                    .execute(
                        "UPDATE conversation_owners SET revision = ?1, latest_root_run_id = ?2 WHERE conversation_id = ?3",
                        params![revision + 1, run_id, input.conversation_id],
                    )
                    .map_err(|e| format!("Failed to update conversation owner: {e}"))?;
            }
            None => {
                connection
                    .execute(
                        "INSERT INTO conversation_owners (conversation_id, project_key, revision, latest_root_run_id) \
                         VALUES (?1, ?2, 1, ?3)",
                        params![input.conversation_id, input.launch.project_key, run_id],
                    )
                    .map_err(|e| format!("Failed to insert conversation owner: {e}"))?;
            }
        }

        connection
            .execute(
                "INSERT INTO runs (run_id, conversation_id, operation_id, previous_run_id, parent_run_id, root_run_id, epoch, state, latest_seq, instance_id) \
                 VALUES (?1, ?2, ?3, ?4, NULL, ?1, 0, 'prepared', 0, NULL)",
                params![run_id, input.conversation_id, input.operation_id, previous_run_id],
            )
            .map_err(|e| format!("Failed to insert run: {e}"))?;

        connection
            .execute(
                "INSERT INTO launch_operations (operation_id, conversation_id, kind, retry_of_operation_id, request_digest, frozen_input, run_id, phase, created_at, cancelled_at) \
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'prepared', ?8, NULL)",
                params![
                    input.operation_id,
                    input.conversation_id,
                    input.kind,
                    input.retry_of_operation_id,
                    input.request_digest,
                    frozen,
                    run_id,
                    now
                ],
            )
            .map_err(|e| format!("Failed to insert operation: {e}"))?;

        insert_event(connection, &run_id, 0, "prepared", "{}")?;
        Ok(())
    })();

    match result {
        Ok(()) => {
            connection
                .execute_batch("COMMIT")
                .map_err(|e| format!("Failed to commit prepare: {e}"))?;
            Ok(PrepareRuntimeRunResult {
                operation_id: input.operation_id.clone(),
                conversation_id: input.conversation_id.clone(),
                run_id,
                epoch: 0,
                phase: "prepared".to_string(),
                created: true,
            })
        }
        Err(e) => {
            let _ = connection.execute_batch("ROLLBACK");
            Err(e)
        }
    }
}

pub fn get_operation(
    connection: &Connection,
    operation_id: &str,
) -> Result<RuntimeLaunchView, String> {
    validate_id("operationId", operation_id)?;
    operation_view(connection, operation_id)
}

pub fn get_run(connection: &Connection, run_id: &str) -> Result<RuntimeRunSummary, String> {
    validate_id("runId", run_id)?;
    connection
        .query_row(
            "SELECT run_id, conversation_id, operation_id, epoch, state, latest_seq FROM runs WHERE run_id = ?1",
            params![run_id],
            |row| {
                Ok(RuntimeRunSummary {
                    version: super::runtime_types::RUNTIME_SCHEMA_VERSION,
                    runtime_run_id: row.get(0)?,
                    conversation_id: row.get(1)?,
                    operation_id: row.get(2)?,
                    epoch: row.get(3)?,
                    state: row.get(4)?,
                    resume_mode: "none".to_string(),
                    latest_durable_seq: row.get(5)?,
                })
            },
        )
        .optional()
        .map_err(|e| format!("Failed to read run: {e}"))?
        .ok_or_else(|| format!("Unknown run: {run_id}"))
}

pub fn list_events(
    connection: &Connection,
    run_id: &str,
    after_seq: i64,
    limit: i64,
) -> Result<Vec<RuntimeEventView>, String> {
    validate_id("runId", run_id)?;
    if after_seq < -1 {
        return Err("afterSeq must be >= -1".to_string());
    }
    let capped = limit.clamp(1, MAX_EVENTS_PAGE);
    let mut statement = connection
        .prepare(
            "SELECT run_id, seq, epoch, kind, payload_hash, created_at FROM run_events \
             WHERE run_id = ?1 AND seq > ?2 ORDER BY seq ASC LIMIT ?3",
        )
        .map_err(|e| format!("Failed to prepare event query: {e}"))?;
    let rows = statement
        .query_map(params![run_id, after_seq, capped], |row| {
            Ok(RuntimeEventView {
                run_id: row.get(0)?,
                seq: row.get(1)?,
                epoch: row.get(2)?,
                kind: row.get(3)?,
                payload_hash: row.get(4)?,
                created_at: row.get(5)?,
            })
        })
        .map_err(|e| format!("Failed to query events: {e}"))?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|e| format!("Failed to read events: {e}"))
}

/// Cancel a prepared operation (tombstone). Terminal operations are returned
/// unchanged; a stale epoch is rejected. Never revives a cancelled operation.
pub fn cancel_operation(
    connection: &Connection,
    operation_id: &str,
    expected_epoch: i64,
) -> Result<RuntimeLaunchView, String> {
    validate_id("operationId", operation_id)?;
    if expected_epoch < 0 {
        return Err("expectedEpoch must be >= 0".to_string());
    }
    let current = operation_view(connection, operation_id)?;
    if super::runtime_types::is_terminal_phase(&current.phase) {
        return Ok(current);
    }
    let epoch: i64 = connection
        .query_row(
            "SELECT epoch FROM runs WHERE run_id = ?1",
            params![current.run_id],
            |row| row.get(0),
        )
        .map_err(|e| format!("Failed to read run: {e}"))?;
    if epoch != expected_epoch {
        return Err(format!(
            "Stale epoch for operation {operation_id}: expected {expected_epoch}, current {epoch}"
        ));
    }
    connection
        .execute(
            "UPDATE launch_operations SET phase = 'cancelled', cancelled_at = ?1 WHERE operation_id = ?2",
            params![now_ms(), operation_id],
        )
        .map_err(|e| format!("Failed to cancel operation: {e}"))?;
    connection
        .execute(
            "UPDATE runs SET state = 'cancelled' WHERE run_id = ?1",
            params![current.run_id],
        )
        .map_err(|e| format!("Failed to cancel run: {e}"))?;
    insert_event(connection, &current.run_id, epoch, "cancelled", "{}")?;
    operation_view(connection, operation_id)
}

/// Convenience used by tests/commands that need the frozen launch round-trip.
pub fn frozen_launch_for(
    connection: &Connection,
    operation_id: &str,
) -> Result<FrozenRuntimeLaunch, String> {
    let raw: String = connection
        .query_row(
            "SELECT frozen_input FROM launch_operations WHERE operation_id = ?1",
            params![operation_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(|e| format!("Failed to read frozen launch: {e}"))?
        .ok_or_else(|| format!("Unknown operation: {operation_id}"))?;
    serde_json::from_str(&raw).map_err(|e| format!("Corrupt frozen launch: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::runtime_types::FrozenRuntimeLaunch;

    fn temp_db() -> PathBuf {
        std::env::temp_dir()
            .join(format!(
                "packetbench-runtime-journal-test-{}",
                Uuid::new_v4()
            ))
            .join("journal.db")
    }

    fn input(operation_id: &str, digest: &str) -> PrepareRuntimeRunInput {
        PrepareRuntimeRunInput {
            operation_id: operation_id.to_string(),
            conversation_id: "conv-1".to_string(),
            kind: "initial".to_string(),
            retry_of_operation_id: None,
            request_digest: digest.to_string(),
            launch: FrozenRuntimeLaunch {
                route: "anthropic".to_string(),
                model: "claude".to_string(),
                requested_isolation: "checkout".to_string(),
                draft_id: "draft-1".to_string(),
                draft_revision: "rev-1".to_string(),
                project_key: "local:D:/proj".to_string(),
                base_path: "D:/proj".to_string(),
            },
        }
    }

    fn digest(n: u8) -> String {
        format!("sha256:{}", format!("{n:02x}").repeat(32))
    }

    #[test]
    fn same_operation_and_digest_returns_same_ids() {
        let connection = open_at(&temp_db()).unwrap();
        let first = prepare_operation(&connection, &input("op-1", &digest(1))).unwrap();
        let second = prepare_operation(&connection, &input("op-1", &digest(1))).unwrap();
        assert!(first.created);
        assert!(!second.created);
        assert_eq!(first.run_id, second.run_id);
        assert_eq!(first.epoch, 0);
        assert_eq!(second.phase, "prepared");
    }

    #[test]
    fn changed_digest_is_a_conflict() {
        let connection = open_at(&temp_db()).unwrap();
        prepare_operation(&connection, &input("op-1", &digest(1))).unwrap();
        let err = prepare_operation(&connection, &input("op-1", &digest(2))).unwrap_err();
        assert!(err.contains("different request digest"));
    }

    #[test]
    fn cancel_is_a_tombstone_that_never_revives() {
        let connection = open_at(&temp_db()).unwrap();
        prepare_operation(&connection, &input("op-1", &digest(1))).unwrap();
        let cancelled = cancel_operation(&connection, "op-1", 0).unwrap();
        assert_eq!(cancelled.phase, "cancelled");
        assert!(cancelled.cancelled_at.is_some());
        // Idempotent re-cancel returns the terminal state.
        let again = cancel_operation(&connection, "op-1", 0).unwrap();
        assert_eq!(again.phase, "cancelled");
        // A stale epoch is rejected.
        let mut second = input("op-2", &digest(3));
        second.conversation_id = "conv-2".to_string();
        prepare_operation(&connection, &second).unwrap();
        assert!(cancel_operation(&connection, "op-2", 9).is_err());
    }

    #[test]
    fn newer_schema_version_fails_closed() {
        let path = temp_db();
        let connection = open_at(&path).unwrap();
        connection
            .execute_batch("PRAGMA user_version = 99")
            .unwrap();
        drop(connection);
        let err = open_at(&path).unwrap_err();
        assert!(err.contains("newer than this build supports"));
    }

    #[test]
    fn fresh_journal_is_at_v2_with_checkpoints_table() {
        let connection = open_at(&temp_db()).unwrap();
        let version: i64 = connection
            .query_row("PRAGMA user_version", [], |row| row.get(0))
            .unwrap();
        assert_eq!(version, JOURNAL_SCHEMA_VERSION);
        let tables: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'checkpoints'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(tables, 1);
    }

    #[test]
    fn v1_journal_migrates_to_v2_additively() {
        let connection = open_at(&temp_db()).unwrap();
        // Seed a v1 row so the additive migration's "no data touched" claim is
        // actually asserted (not just the table's existence).
        connection
            .execute(
                "INSERT INTO runs (run_id, conversation_id, operation_id, root_run_id, epoch, state, latest_seq) \
                 VALUES ('run-1', 'conv-1', 'op-1', 'run-1', 0, 'prepared', 0)",
                [],
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO launch_operations (operation_id, conversation_id, kind, request_digest, frozen_input, run_id, phase, created_at) \
                 VALUES ('op-1', 'conv-1', 'initial', ?1, '{}', 'run-1', 'prepared', 1)",
                params![digest(1)],
            )
            .unwrap();
        // Simulate a file written by the v1 build.
        connection
            .execute_batch("DROP TABLE checkpoints; PRAGMA user_version = 1;")
            .unwrap();
        migrate(&connection).unwrap();
        let version: i64 = connection
            .query_row("PRAGMA user_version", [], |row| row.get(0))
            .unwrap();
        assert_eq!(version, 2);
        let tables: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'checkpoints'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(tables, 1);
        // The seeded v1 row survives the additive migration.
        let surviving: i64 = connection
            .query_row("SELECT COUNT(*) FROM launch_operations", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(surviving, 1);
        // The v1 tables survive the additive migration.
        let runs: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'runs'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(runs, 1);
    }

    #[test]
    fn truncated_file_fails_closed_without_panicking() {
        let path = temp_db();
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, b"not a sqlite database at all").unwrap();
        let result = open_at(&path);
        assert!(result.is_err());
    }

    #[test]
    fn events_are_append_only_and_paginated() {
        let connection = open_at(&temp_db()).unwrap();
        let prepared = prepare_operation(&connection, &input("op-1", &digest(1))).unwrap();
        cancel_operation(&connection, "op-1", 0).unwrap();
        let events = list_events(&connection, &prepared.run_id, -1, 10).unwrap();
        assert_eq!(events.len(), 2);
        assert_eq!(events[0].kind, "prepared");
        assert_eq!(events[1].kind, "cancelled");
        let after = list_events(&connection, &prepared.run_id, 0, 10).unwrap();
        assert_eq!(after.len(), 1);
        assert_eq!(after[0].kind, "cancelled");
    }

    #[test]
    fn frozen_launch_round_trips() {
        let connection = open_at(&temp_db()).unwrap();
        prepare_operation(&connection, &input("op-1", &digest(1))).unwrap();
        let frozen = frozen_launch_for(&connection, "op-1").unwrap();
        assert_eq!(frozen.model, "claude");
        assert_eq!(frozen.requested_isolation, "checkout");
    }

    #[test]
    fn existing_turn_requires_an_owner() {
        let connection = open_at(&temp_db()).unwrap();
        let mut existing = input("op-2", &digest(2));
        existing.kind = "existing".to_string();
        assert!(prepare_operation(&connection, &existing).is_err());
    }

    #[test]
    fn rejects_non_checkout_isolation_and_bad_digest() {
        let connection = open_at(&temp_db()).unwrap();
        let mut worktree = input("op-1", &digest(1));
        worktree.launch.requested_isolation = "worktree".to_string();
        assert!(prepare_operation(&connection, &worktree).is_err());
        let bad = input("op-2", "not-a-digest");
        assert!(prepare_operation(&connection, &bad).is_err());
    }
}
