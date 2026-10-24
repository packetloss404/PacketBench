//! R3a typed checkpoints (H2): a validated, hash-addressed snapshot of the
//! provider-compatible conversation history a runtime run can continue from.
//!
//! Substrate only — nothing in the live agent loop calls this yet; R3b wires the
//! runner. The module is pure apart from the small store helpers at the bottom
//! that read/write the `checkpoints` table created by [`super::runtime_journal`].
//!
//! Privacy: a checkpoint is *private* local application data. It may contain
//! user code, tool results and opaque provider replay envelopes, so it cannot be
//! made replayable by redacting bytes in place. It must never contain raw
//! credentials: [`encode`] refuses a payload that looks like it carries a secret
//! rather than persisting it. Provider envelopes are stored opaque and are never
//! parsed as instructions.

use std::collections::BTreeSet;

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};

use super::llm_types::{ChatMessage, ContentBlock, MessageContent};

/// Checkpoint payload schema version. Bumped only for a breaking change to the
/// persisted typed-history shape. A newer checkpoint is rejected, never
/// downgraded to an older reader.
pub const CHECKPOINT_SCHEMA_VERSION: i64 = 1;

/// Adapter/transport protocol version the typed history was written for.
pub const CHECKPOINT_TRANSPORT_VERSION: i64 = 1;

/// Retain the latest N checkpoints per run; older ones are pruned. The plan
/// fixes this at 10 (`dev/agent-experience/06-r2b-decisions-and-plan.md`).
pub const CHECKPOINT_RETENTION_PER_RUN: usize = 10;

/// Bounded payload limits from runtime spec §3 (4 MiB single blob, 256 MiB per
/// run, 2 GiB total). Enforced by returning a named error, never by truncating.
#[derive(Debug, Clone, Copy)]
pub struct CheckpointLimits {
    pub max_blob_bytes: usize,
    pub max_run_bytes: usize,
    pub max_total_bytes: usize,
}

impl Default for CheckpointLimits {
    fn default() -> Self {
        Self {
            max_blob_bytes: 4 * 1024 * 1024,
            max_run_bytes: 256 * 1024 * 1024,
            max_total_bytes: 2 * 1024 * 1024 * 1024,
        }
    }
}

/// Named checkpoint failure. Callers must branch on the variant rather than
/// parse a string; every limit violation is a refusal, not a partial write.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CheckpointError {
    PayloadTooLarge {
        size: usize,
        limit: usize,
    },
    RunBudgetExceeded {
        run_id: String,
        size: usize,
        limit: usize,
    },
    TotalBudgetExceeded {
        size: usize,
        limit: usize,
    },
    SecretDetected {
        field: String,
    },
    NewerSchema {
        found: i64,
        supported: i64,
    },
    SchemaMismatch {
        expected: i64,
        found: i64,
    },
    TransportMismatch {
        expected: i64,
        found: i64,
    },
    ModelRouteMismatch {
        expected: String,
        found: String,
    },
    HashMismatch {
        expected: String,
        found: String,
    },
    DuplicateToolUseId {
        tool_call_id: String,
    },
    OrphanToolResult {
        tool_call_id: String,
    },
    IncompleteToolPairing {
        tool_call_id: String,
    },
    Encode(String),
    Decode(String),
    Store(String),
}

impl std::fmt::Display for CheckpointError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            CheckpointError::PayloadTooLarge { size, limit } => {
                write!(
                    f,
                    "Checkpoint payload is {size} bytes, over the {limit}-byte limit"
                )
            }
            CheckpointError::RunBudgetExceeded {
                run_id,
                size,
                limit,
            } => write!(
                f,
                "Run {run_id} checkpoint payload budget exceeded: {size} bytes over {limit}"
            ),
            CheckpointError::TotalBudgetExceeded { size, limit } => write!(
                f,
                "Total checkpoint payload budget exceeded: {size} bytes over {limit}"
            ),
            CheckpointError::SecretDetected { field } => {
                write!(
                    f,
                    "Refusing to persist a checkpoint with a secret-looking field at {field}"
                )
            }
            CheckpointError::NewerSchema { found, supported } => write!(
                f,
                "Checkpoint schema v{found} is newer than this build supports (v{supported})"
            ),
            CheckpointError::SchemaMismatch { expected, found } => write!(
                f,
                "Checkpoint schema v{found} does not match the expected v{expected}"
            ),
            CheckpointError::TransportMismatch { expected, found } => write!(
                f,
                "Checkpoint transport v{found} does not match the expected v{expected}"
            ),
            CheckpointError::ModelRouteMismatch { expected, found } => write!(
                f,
                "Checkpoint model route \"{found}\" does not match the expected \"{expected}\""
            ),
            CheckpointError::HashMismatch { expected, found } => {
                write!(
                    f,
                    "Checkpoint payload hash mismatch: expected {expected}, computed {found}"
                )
            }
            CheckpointError::DuplicateToolUseId { tool_call_id } => {
                write!(f, "Duplicate tool_use id: {tool_call_id}")
            }
            CheckpointError::OrphanToolResult { tool_call_id } => {
                write!(
                    f,
                    "tool_result references an unknown tool_use id: {tool_call_id}"
                )
            }
            CheckpointError::IncompleteToolPairing { tool_call_id } => {
                write!(f, "tool_use has no matching tool_result: {tool_call_id}")
            }
            CheckpointError::Encode(message) => write!(f, "Failed to encode checkpoint: {message}"),
            CheckpointError::Decode(message) => write!(f, "Failed to decode checkpoint: {message}"),
            CheckpointError::Store(message) => write!(f, "Checkpoint store error: {message}"),
        }
    }
}

impl std::error::Error for CheckpointError {}

impl From<CheckpointError> for String {
    fn from(error: CheckpointError) -> Self {
        error.to_string()
    }
}

/// How a checkpoint may be handled. `Private` is the normal persisted record;
/// `Redacted` marks an export artifact that is evidence, not replayable state.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CheckpointClassification {
    Private,
    Redacted,
}

impl CheckpointClassification {
    pub fn as_str(self) -> &'static str {
        match self {
            CheckpointClassification::Private => "private",
            CheckpointClassification::Redacted => "redacted",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "private" => Some(CheckpointClassification::Private),
            "redacted" => Some(CheckpointClassification::Redacted),
            _ => None,
        }
    }
}

/// A typed, provider-compatible checkpoint. `messages` is the durable history
/// the runner would rebuild a request from: tool_use/tool_result pairing plus
/// opaque provider reasoning envelopes, in order.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Checkpoint {
    pub checkpoint_id: String,
    pub run_id: String,
    pub epoch: i64,
    pub seq: i64,
    pub schema_version: i64,
    pub transport_version: i64,
    pub model_route: String,
    pub manifest_hash: String,
    pub tool_policy_hash: String,
    pub mcp_hash: String,
    #[serde(default)]
    pub pending_effect_ids: Vec<String>,
    pub classification: CheckpointClassification,
    pub messages: Vec<ChatMessage>,
    pub created_at: i64,
}

/// A checkpoint split into its metadata envelope and its serialized private
/// typed-history payload. This is the unit the store writes and reads.
#[derive(Debug, Clone)]
pub struct EncodedCheckpoint {
    pub checkpoint_id: String,
    pub run_id: String,
    pub epoch: i64,
    pub seq: i64,
    pub schema_version: i64,
    pub transport_version: i64,
    pub model_route: String,
    pub manifest_hash: String,
    pub tool_policy_hash: String,
    pub mcp_hash: String,
    pub pending_effect_ids: Vec<String>,
    pub classification: CheckpointClassification,
    pub payload: String,
    pub payload_hash: String,
    pub created_at: i64,
}

/// The current runtime's compatibility identity. A checkpoint whose hashes and
/// versions do not match is rejected or explicitly continued as a fresh run —
/// it is never silently replayed.
#[derive(Debug, Clone)]
pub struct CompatibilityContext {
    pub schema_version: i64,
    pub transport_version: i64,
    pub model_route: String,
    pub manifest_hash: String,
    pub tool_policy_hash: String,
    pub mcp_hash: String,
}

/// `sha256:<64 lower-case hex>` of the serialized payload.
pub fn hash_payload(payload: &str) -> String {
    format!("sha256:{:x}", Sha256::digest(payload.as_bytes()))
}

/// Validate a checkpoint against the current runtime's compatibility identity.
/// A newer checkpoint schema is rejected before any field comparison so it can
/// never be downgraded; a changed model route or policy hash is incompatible.
pub fn validate_compatibility(
    context: &CompatibilityContext,
    checkpoint: &Checkpoint,
) -> Result<(), CheckpointError> {
    if checkpoint.schema_version > CHECKPOINT_SCHEMA_VERSION {
        return Err(CheckpointError::NewerSchema {
            found: checkpoint.schema_version,
            supported: CHECKPOINT_SCHEMA_VERSION,
        });
    }
    if checkpoint.schema_version != context.schema_version {
        return Err(CheckpointError::SchemaMismatch {
            expected: context.schema_version,
            found: checkpoint.schema_version,
        });
    }
    if checkpoint.transport_version != context.transport_version {
        return Err(CheckpointError::TransportMismatch {
            expected: context.transport_version,
            found: checkpoint.transport_version,
        });
    }
    if checkpoint.model_route != context.model_route {
        return Err(CheckpointError::ModelRouteMismatch {
            expected: context.model_route.clone(),
            found: checkpoint.model_route.clone(),
        });
    }
    for (expected, found, label) in [
        (
            &context.manifest_hash,
            &checkpoint.manifest_hash,
            "manifest",
        ),
        (
            &context.tool_policy_hash,
            &checkpoint.tool_policy_hash,
            "tool-policy",
        ),
        (&context.mcp_hash, &checkpoint.mcp_hash, "mcp"),
    ] {
        if expected != found {
            return Err(CheckpointError::HashMismatch {
                expected: format!("{label}:{expected}"),
                found: format!("{label}:{found}"),
            });
        }
    }
    Ok(())
}

/// Structural validation: unique `tool_use` ids and no orphan `tool_result`.
/// A `tool_use` without a result is permitted here (the checkpoint may record an
/// in-flight effect); [`validate_replayable`] rejects it before a replay.
pub fn validate_structure(messages: &[ChatMessage]) -> Result<(), CheckpointError> {
    let (uses, results) = collect_tool_ids(messages)?;
    for id in &results {
        if !uses.contains(id) {
            return Err(CheckpointError::OrphanToolResult {
                tool_call_id: id.clone(),
            });
        }
    }
    Ok(())
}

/// Complete-pairing validation required before replaying typed history.
pub fn validate_replayable(messages: &[ChatMessage]) -> Result<(), CheckpointError> {
    let (uses, results) = collect_tool_ids(messages)?;
    for id in &uses {
        if !results.contains(id) {
            return Err(CheckpointError::IncompleteToolPairing {
                tool_call_id: id.clone(),
            });
        }
    }
    Ok(())
}

fn collect_tool_ids(
    messages: &[ChatMessage],
) -> Result<(BTreeSet<String>, BTreeSet<String>), CheckpointError> {
    let mut uses = BTreeSet::new();
    let mut results = BTreeSet::new();
    for message in messages {
        if let MessageContent::Blocks(blocks) = &message.content {
            for block in blocks {
                match block {
                    ContentBlock::ToolUse { id, .. } => {
                        if !uses.insert(id.clone()) {
                            return Err(CheckpointError::DuplicateToolUseId {
                                tool_call_id: id.clone(),
                            });
                        }
                    }
                    ContentBlock::ToolResult { tool_call_id, .. } => {
                        results.insert(tool_call_id.clone());
                    }
                    _ => {}
                }
            }
        }
    }
    Ok((uses, results))
}

/// Field names (normalized to lower-case alphanumerics) that must never be
/// persisted with a value.
const SECRET_FIELD_NAMES: &[&str] = &[
    "apikey",
    "authorization",
    "accesstoken",
    "refreshtoken",
    "idtoken",
    "clientsecret",
    "password",
    "passwd",
    "privatekey",
    "secret",
    "authtoken",
    "sessiontoken",
    "credential",
    "credentials",
    "bearer",
];

/// High-confidence credential value prefixes. A match refuses persistence.
const SECRET_VALUE_PREFIXES: &[&str] = &[
    "sk-",
    "sk_live_",
    "ghp_",
    "gho_",
    "github_pat_",
    "xoxb-",
    "xoxp-",
    "AKIA",
    "AIza",
    "-----BEGIN",
    "Bearer ",
];

fn normalize_field(name: &str) -> String {
    name.chars()
        .filter(|c| c.is_ascii_alphanumeric())
        .flat_map(|c| c.to_lowercase())
        .collect()
}

/// True when a value looks like a credential, not merely contains a prefix
/// substring. A prefix matches only at the start of the value or immediately
/// after a non-alphanumeric boundary, so ordinary words (`disk-usage`,
/// `task-list`, `risk-averse`) do not trip the guard.
fn looks_like_secret_value(text: &str) -> bool {
    let trimmed = text.trim();
    for prefix in SECRET_VALUE_PREFIXES {
        if trimmed.starts_with(prefix) {
            return true;
        }
        if let Some(index) = text.find(prefix) {
            let boundary_ok = text[..index]
                .chars()
                .next_back()
                .is_none_or(|c| !c.is_ascii_alphanumeric());
            if boundary_ok {
                return true;
            }
        }
    }
    false
}

/// Recursively look for credential material. Returns the path of the first
/// suspicious field, if any. Embedded JSON inside string values (common in tool
/// results) is parsed and scanned too, bounded by depth and length so hostile
/// input cannot force unbounded work.
fn scan_secrets(value: &Value, path: &str, depth: usize) -> Option<String> {
    if depth > 8 {
        return None;
    }
    match value {
        Value::Object(map) => {
            for (key, child) in map {
                if SECRET_FIELD_NAMES.contains(&normalize_field(key).as_str()) {
                    if child.as_str().is_some_and(|text| !text.is_empty()) {
                        return Some(format!("{path}.{key}"));
                    }
                }
                if let Some(found) = scan_secrets(child, &format!("{path}.{key}"), depth + 1) {
                    return Some(found);
                }
            }
            None
        }
        Value::Array(items) => {
            for (index, item) in items.iter().enumerate() {
                if let Some(found) = scan_secrets(item, &format!("{path}[{index}]"), depth + 1) {
                    return Some(found);
                }
            }
            None
        }
        Value::String(text) => {
            if looks_like_secret_value(text) {
                return Some(path.to_string());
            }
            let trimmed = text.trim();
            if (trimmed.starts_with('{') || trimmed.starts_with('[')) && trimmed.len() < 64 * 1024 {
                if let Ok(parsed) = serde_json::from_str::<Value>(trimmed) {
                    return scan_secrets(&parsed, path, depth + 1);
                }
            }
            None
        }
        _ => None,
    }
}

/// Encode a checkpoint: validate structure, refuse secret-looking payloads and
/// oversized blobs, and hash the serialized typed history.
pub fn encode(
    checkpoint: &Checkpoint,
    limits: &CheckpointLimits,
) -> Result<EncodedCheckpoint, CheckpointError> {
    validate_structure(&checkpoint.messages)?;
    let payload = serde_json::to_string(&checkpoint.messages)
        .map_err(|e| CheckpointError::Encode(e.to_string()))?;
    if payload.len() > limits.max_blob_bytes {
        return Err(CheckpointError::PayloadTooLarge {
            size: payload.len(),
            limit: limits.max_blob_bytes,
        });
    }
    let value = serde_json::to_value(&checkpoint.messages)
        .map_err(|e| CheckpointError::Encode(e.to_string()))?;
    if let Some(field) = scan_secrets(&value, "messages", 0) {
        return Err(CheckpointError::SecretDetected { field });
    }
    let payload_hash = hash_payload(&payload);
    Ok(EncodedCheckpoint {
        checkpoint_id: checkpoint.checkpoint_id.clone(),
        run_id: checkpoint.run_id.clone(),
        epoch: checkpoint.epoch,
        seq: checkpoint.seq,
        schema_version: checkpoint.schema_version,
        transport_version: checkpoint.transport_version,
        model_route: checkpoint.model_route.clone(),
        manifest_hash: checkpoint.manifest_hash.clone(),
        tool_policy_hash: checkpoint.tool_policy_hash.clone(),
        mcp_hash: checkpoint.mcp_hash.clone(),
        pending_effect_ids: checkpoint.pending_effect_ids.clone(),
        classification: checkpoint.classification,
        payload,
        payload_hash,
        created_at: checkpoint.created_at,
    })
}

/// Decode an encoded checkpoint. The stored hash is verified before parsing; a
/// mismatch or malformed payload is an error and never mutates the source row.
pub fn decode(encoded: &EncodedCheckpoint) -> Result<Checkpoint, CheckpointError> {
    let computed = hash_payload(&encoded.payload);
    if computed != encoded.payload_hash {
        return Err(CheckpointError::HashMismatch {
            expected: encoded.payload_hash.clone(),
            found: computed,
        });
    }
    let messages: Vec<ChatMessage> = serde_json::from_str(&encoded.payload)
        .map_err(|e| CheckpointError::Decode(e.to_string()))?;
    validate_structure(&messages)?;
    Ok(Checkpoint {
        checkpoint_id: encoded.checkpoint_id.clone(),
        run_id: encoded.run_id.clone(),
        epoch: encoded.epoch,
        seq: encoded.seq,
        schema_version: encoded.schema_version,
        transport_version: encoded.transport_version,
        model_route: encoded.model_route.clone(),
        manifest_hash: encoded.manifest_hash.clone(),
        tool_policy_hash: encoded.tool_policy_hash.clone(),
        mcp_hash: encoded.mcp_hash.clone(),
        pending_effect_ids: encoded.pending_effect_ids.clone(),
        classification: encoded.classification,
        messages,
        created_at: encoded.created_at,
    })
}

fn run_payload_bytes(connection: &Connection, run_id: &str) -> Result<usize, CheckpointError> {
    connection
        .query_row(
            "SELECT COALESCE(SUM(LENGTH(CAST(payload AS BLOB))), 0) FROM checkpoints WHERE run_id = ?1",
            params![run_id],
            |row| row.get::<_, i64>(0),
        )
        .map(|value| value.max(0) as usize)
        .map_err(|e| CheckpointError::Store(e.to_string()))
}

fn total_payload_bytes(connection: &Connection) -> Result<usize, CheckpointError> {
    connection
        .query_row(
            "SELECT COALESCE(SUM(LENGTH(CAST(payload AS BLOB))), 0) FROM checkpoints",
            [],
            |row| row.get::<_, i64>(0),
        )
        .map(|value| value.max(0) as usize)
        .map_err(|e| CheckpointError::Store(e.to_string()))
}

/// Insert an encoded checkpoint, enforcing the single-blob, per-run and total
/// budgets. Every violation is a named error and nothing is written.
pub fn insert_checkpoint(
    connection: &Connection,
    encoded: &EncodedCheckpoint,
    limits: &CheckpointLimits,
) -> Result<(), CheckpointError> {
    if encoded.payload.len() > limits.max_blob_bytes {
        return Err(CheckpointError::PayloadTooLarge {
            size: encoded.payload.len(),
            limit: limits.max_blob_bytes,
        });
    }
    let run_size = run_payload_bytes(connection, &encoded.run_id)? + encoded.payload.len();
    if run_size > limits.max_run_bytes {
        return Err(CheckpointError::RunBudgetExceeded {
            run_id: encoded.run_id.clone(),
            size: run_size,
            limit: limits.max_run_bytes,
        });
    }
    let total_size = total_payload_bytes(connection)? + encoded.payload.len();
    if total_size > limits.max_total_bytes {
        return Err(CheckpointError::TotalBudgetExceeded {
            size: total_size,
            limit: limits.max_total_bytes,
        });
    }
    let pending = serde_json::to_string(&encoded.pending_effect_ids)
        .map_err(|e| CheckpointError::Encode(e.to_string()))?;
    connection
        .execute(
            "INSERT INTO checkpoints (checkpoint_id, run_id, epoch, seq, schema_version, transport_version, \
             model_route, manifest_hash, tool_policy_hash, mcp_hash, payload, pending_effect_ids, payload_hash, \
             classification, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)",
            params![
                encoded.checkpoint_id,
                encoded.run_id,
                encoded.epoch,
                encoded.seq,
                encoded.schema_version,
                encoded.transport_version,
                encoded.model_route,
                encoded.manifest_hash,
                encoded.tool_policy_hash,
                encoded.mcp_hash,
                encoded.payload,
                pending,
                encoded.payload_hash,
                encoded.classification.as_str(),
                encoded.created_at,
            ],
        )
        .map_err(|e| CheckpointError::Store(e.to_string()))?;
    Ok(())
}

/// Load and decode a checkpoint by id. A corrupt row is left untouched: decode
/// failures are returned to the caller, never deleted or overwritten here.
pub fn load_checkpoint(
    connection: &Connection,
    checkpoint_id: &str,
) -> Result<Checkpoint, CheckpointError> {
    let row = connection
        .query_row(
            "SELECT checkpoint_id, run_id, epoch, seq, schema_version, transport_version, model_route, \
             manifest_hash, tool_policy_hash, mcp_hash, payload, pending_effect_ids, payload_hash, \
             classification, created_at FROM checkpoints WHERE checkpoint_id = ?1",
            params![checkpoint_id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, i64>(2)?,
                    row.get::<_, i64>(3)?,
                    row.get::<_, i64>(4)?,
                    row.get::<_, i64>(5)?,
                    row.get::<_, String>(6)?,
                    row.get::<_, String>(7)?,
                    row.get::<_, String>(8)?,
                    row.get::<_, String>(9)?,
                    row.get::<_, String>(10)?,
                    row.get::<_, String>(11)?,
                    row.get::<_, String>(12)?,
                    row.get::<_, String>(13)?,
                    row.get::<_, i64>(14)?,
                ))
            },
        )
        .optional()
        .map_err(|e| CheckpointError::Store(e.to_string()))?
        .ok_or_else(|| CheckpointError::Store(format!("Unknown checkpoint: {checkpoint_id}")))?;
    let classification = CheckpointClassification::parse(&row.13).ok_or_else(|| {
        CheckpointError::Store(format!("Unknown checkpoint classification: {}", row.13))
    })?;
    let pending_effect_ids: Vec<String> = serde_json::from_str(&row.11)
        .map_err(|e| CheckpointError::Decode(format!("pending_effect_ids: {e}")))?;
    let encoded = EncodedCheckpoint {
        checkpoint_id: row.0,
        run_id: row.1,
        epoch: row.2,
        seq: row.3,
        schema_version: row.4,
        transport_version: row.5,
        model_route: row.6,
        manifest_hash: row.7,
        tool_policy_hash: row.8,
        mcp_hash: row.9,
        pending_effect_ids,
        classification,
        payload: row.10,
        payload_hash: row.12,
        created_at: row.14,
    };
    decode(&encoded)
}

/// Keep the latest [`CHECKPOINT_RETENTION_PER_RUN`] checkpoints for a run and
/// delete older ones. Returns the number pruned.
///
/// Two guards (runtime spec §4.3, R3b review gaps):
/// * A checkpoint that still carries `pending_effect_ids` is never pruned — an
///   unacknowledged effect is reconciliation evidence, not retention garbage.
/// * Retention is ordered by `(epoch, seq)`, not `seq` alone, so a restarted
///   (higher-epoch) run's newest checkpoints always win over a stale epoch's.
pub fn prune_checkpoints(connection: &Connection, run_id: &str) -> Result<usize, CheckpointError> {
    connection
        .execute(
            "DELETE FROM checkpoints WHERE run_id = ?1 AND pending_effect_ids = '[]' \
             AND checkpoint_id NOT IN (\
             SELECT checkpoint_id FROM checkpoints WHERE run_id = ?1 \
             ORDER BY epoch DESC, seq DESC LIMIT ?2)",
            params![run_id, CHECKPOINT_RETENTION_PER_RUN as i64],
        )
        .map_err(|e| CheckpointError::Store(e.to_string()))
}

/// Insert then prune, the normal write path for a run.
pub fn store_checkpoint(
    connection: &Connection,
    encoded: &EncodedCheckpoint,
    limits: &CheckpointLimits,
) -> Result<(), CheckpointError> {
    insert_checkpoint(connection, encoded, limits)?;
    prune_checkpoints(connection, &encoded.run_id)?;
    Ok(())
}

/// The next monotonic checkpoint sequence for `(run_id, epoch)`, so a restart
/// or a later turn on the same run never collides with an existing seq.
pub fn next_checkpoint_seq(
    connection: &Connection,
    run_id: &str,
    epoch: i64,
) -> Result<i64, CheckpointError> {
    connection
        .query_row(
            "SELECT COALESCE(MAX(seq), -1) + 1 FROM checkpoints WHERE run_id = ?1 AND epoch = ?2",
            params![run_id, epoch],
            |row| row.get::<_, i64>(0),
        )
        .map_err(|e| CheckpointError::Store(e.to_string()))
}

/// Load the newest checkpoint for a run by `(epoch, seq)`, or `None` when the
/// run has none. A corrupt/newer row surfaces its decode error and is left in
/// place (never deleted, never downgraded).
pub fn load_latest_checkpoint(
    connection: &Connection,
    run_id: &str,
) -> Result<Option<Checkpoint>, CheckpointError> {
    let id: Option<String> = connection
        .query_row(
            "SELECT checkpoint_id FROM checkpoints WHERE run_id = ?1 \
             ORDER BY epoch DESC, seq DESC LIMIT 1",
            params![run_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(|e| CheckpointError::Store(e.to_string()))?;
    match id {
        Some(id) => load_checkpoint(connection, &id).map(Some),
        None => Ok(None),
    }
}

/// Resume-time compatibility check for one checkpoint against the current
/// runtime's model route and schema/transport versions. A newer schema is
/// refused before any field comparison so it is never downgraded.
pub fn check_resumable(
    checkpoint: &Checkpoint,
    expected_model_route: &str,
) -> Result<(), CheckpointError> {
    if checkpoint.schema_version > CHECKPOINT_SCHEMA_VERSION {
        return Err(CheckpointError::NewerSchema {
            found: checkpoint.schema_version,
            supported: CHECKPOINT_SCHEMA_VERSION,
        });
    }
    if checkpoint.schema_version != CHECKPOINT_SCHEMA_VERSION {
        return Err(CheckpointError::SchemaMismatch {
            expected: CHECKPOINT_SCHEMA_VERSION,
            found: checkpoint.schema_version,
        });
    }
    if checkpoint.transport_version != CHECKPOINT_TRANSPORT_VERSION {
        return Err(CheckpointError::TransportMismatch {
            expected: CHECKPOINT_TRANSPORT_VERSION,
            found: checkpoint.transport_version,
        });
    }
    if checkpoint.model_route != expected_model_route {
        return Err(CheckpointError::ModelRouteMismatch {
            expected: expected_model_route.to_string(),
            found: checkpoint.model_route.clone(),
        });
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::llm_types::ChatRole;
    use crate::core::runtime_journal::open_at;
    use crate::core::runtime_types::{FrozenRuntimeLaunch, PrepareRuntimeRunInput};
    use serde_json::json;
    use std::path::PathBuf;
    use uuid::Uuid;

    fn temp_db() -> PathBuf {
        std::env::temp_dir()
            .join(format!("packetbench-checkpoint-test-{}", Uuid::new_v4()))
            .join("journal.db")
    }

    fn open() -> Connection {
        open_at(&temp_db()).unwrap()
    }

    fn digest(n: u8) -> String {
        format!("sha256:{}", format!("{n:02x}").repeat(32))
    }

    fn setup_run(connection: &Connection, conversation_id: &str) -> String {
        let input = PrepareRuntimeRunInput {
            operation_id: format!("op-{}", Uuid::new_v4()),
            conversation_id: conversation_id.to_string(),
            kind: "initial".to_string(),
            retry_of_operation_id: None,
            request_digest: digest(1),
            launch: FrozenRuntimeLaunch {
                route: "anthropic".to_string(),
                model: "claude".to_string(),
                requested_isolation: "checkout".to_string(),
                draft_id: "draft-1".to_string(),
                draft_revision: "rev-1".to_string(),
                project_key: "local:D:/proj".to_string(),
                base_path: "D:/proj".to_string(),
            },
        };
        crate::core::runtime_journal::prepare_operation(connection, &input)
            .unwrap()
            .run_id
    }

    fn text(role: ChatRole, body: &str) -> ChatMessage {
        ChatMessage {
            role,
            content: MessageContent::text(body),
        }
    }

    fn blocks(role: ChatRole, blocks: Vec<ContentBlock>) -> ChatMessage {
        ChatMessage {
            role,
            content: MessageContent::Blocks(blocks),
        }
    }

    fn checkpoint(run_id: &str, seq: i64, messages: Vec<ChatMessage>) -> Checkpoint {
        Checkpoint {
            checkpoint_id: format!("ckpt-{seq}"),
            run_id: run_id.to_string(),
            epoch: 0,
            seq,
            schema_version: CHECKPOINT_SCHEMA_VERSION,
            transport_version: CHECKPOINT_TRANSPORT_VERSION,
            model_route: "anthropic".to_string(),
            manifest_hash: digest(2),
            tool_policy_hash: digest(3),
            mcp_hash: digest(4),
            pending_effect_ids: Vec::new(),
            classification: CheckpointClassification::Private,
            messages,
            created_at: 1_700_000_000_000,
        }
    }

    fn context() -> CompatibilityContext {
        CompatibilityContext {
            schema_version: CHECKPOINT_SCHEMA_VERSION,
            transport_version: CHECKPOINT_TRANSPORT_VERSION,
            model_route: "anthropic".to_string(),
            manifest_hash: digest(2),
            tool_policy_hash: digest(3),
            mcp_hash: digest(4),
        }
    }

    fn history() -> Vec<ChatMessage> {
        vec![
            text(ChatRole::System, "you are helpful"),
            text(ChatRole::User, "list the files"),
            blocks(
                ChatRole::Assistant,
                vec![ContentBlock::ToolUse {
                    id: "call-1".to_string(),
                    name: "bash".to_string(),
                    arguments: json!({ "command": "ls" }),
                }],
            ),
            blocks(
                ChatRole::User,
                vec![ContentBlock::ToolResult {
                    tool_call_id: "call-1".to_string(),
                    content: "a.txt\nb.txt".to_string(),
                    is_error: false,
                }],
            ),
            text(ChatRole::Assistant, "There are two files."),
        ]
    }

    #[test]
    fn encode_decode_round_trip_preserves_order_and_pairing() {
        let run_id = "run-round-trip";
        let original = checkpoint(run_id, 0, history());
        let encoded = encode(&original, &CheckpointLimits::default()).unwrap();
        let decoded = decode(&encoded).unwrap();

        assert_eq!(
            serde_json::to_value(&decoded.messages).unwrap(),
            serde_json::to_value(&original.messages).unwrap()
        );
        // Tool pairing survives: exactly one use and one matching result.
        validate_replayable(&decoded.messages).unwrap();
        let (uses, results) = collect_tool_ids(&decoded.messages).unwrap();
        assert_eq!(uses.len(), 1);
        assert_eq!(results.len(), 1);
        assert!(uses.contains("call-1"));
        assert!(results.contains("call-1"));
    }

    #[test]
    fn opaque_provider_reasoning_survives_round_trip() {
        let details = json!({
            "transport": "anthropic",
            "thinking": [{ "type": "thinking", "signature": "opaque-sig", "text": "plan" }],
        });
        let messages = vec![blocks(
            ChatRole::Assistant,
            vec![ContentBlock::ProviderReasoning {
                details: details.clone(),
            }],
        )];
        let encoded = encode(
            &checkpoint("run-reasoning", 0, messages),
            &CheckpointLimits::default(),
        )
        .unwrap();
        let decoded = decode(&encoded).unwrap();
        match &decoded.messages[0].content {
            MessageContent::Blocks(blocks) => match &blocks[0] {
                ContentBlock::ProviderReasoning { details: got } => assert_eq!(got, &details),
                other => panic!("expected provider reasoning, got {other:?}"),
            },
            other => panic!("expected blocks, got {other:?}"),
        }
    }

    #[test]
    fn corrupt_checkpoint_is_preserved_on_failed_decode() {
        let connection = open();
        let run_id = setup_run(&connection, "conv-corrupt");
        let encoded = encode(
            &checkpoint(&run_id, 0, history()),
            &CheckpointLimits::default(),
        )
        .unwrap();
        insert_checkpoint(&connection, &encoded, &CheckpointLimits::default()).unwrap();

        // Corrupt the stored payload; keep the hash consistent so decode reaches
        // the malformed-JSON path rather than short-circuiting on the hash.
        let broken = "{\"broken\":";
        connection
            .execute(
                "UPDATE checkpoints SET payload = ?1, payload_hash = ?2 WHERE checkpoint_id = ?3",
                params![broken, hash_payload(broken), encoded.checkpoint_id],
            )
            .unwrap();
        let result = load_checkpoint(&connection, &encoded.checkpoint_id);
        assert!(matches!(result, Err(CheckpointError::Decode(_))));

        // The row is still there, byte-for-byte as written.
        let (count, payload): (i64, String) = connection
            .query_row(
                "SELECT COUNT(*), MAX(payload) FROM checkpoints WHERE checkpoint_id = ?1",
                params![encoded.checkpoint_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(count, 1);
        assert_eq!(payload, broken);
    }

    #[test]
    fn newer_checkpoint_schema_is_rejected_not_downgraded() {
        let mut newer = checkpoint("run-newer", 0, history());
        newer.schema_version = CHECKPOINT_SCHEMA_VERSION + 1;
        let error = validate_compatibility(&context(), &newer).unwrap_err();
        assert!(matches!(
            error,
            CheckpointError::NewerSchema {
                found,
                supported
            } if found == CHECKPOINT_SCHEMA_VERSION + 1 && supported == CHECKPOINT_SCHEMA_VERSION
        ));
    }

    #[test]
    fn incompatible_model_route_and_policy_hash_are_rejected() {
        let mut rerouted = checkpoint("run-route", 0, history());
        rerouted.model_route = "openai".to_string();
        assert!(matches!(
            validate_compatibility(&context(), &rerouted),
            Err(CheckpointError::ModelRouteMismatch { .. })
        ));

        let mut repolicy = checkpoint("run-policy", 0, history());
        repolicy.tool_policy_hash = digest(9);
        assert!(matches!(
            validate_compatibility(&context(), &repolicy),
            Err(CheckpointError::HashMismatch { .. })
        ));
    }

    #[test]
    fn retention_keeps_the_latest_ten_and_prunes_older() {
        let connection = open();
        let run_id = setup_run(&connection, "conv-retention");
        for seq in 0..12 {
            let encoded = encode(
                &checkpoint(&run_id, seq, history()),
                &CheckpointLimits::default(),
            )
            .unwrap();
            insert_checkpoint(&connection, &encoded, &CheckpointLimits::default()).unwrap();
        }
        let pruned = prune_checkpoints(&connection, &run_id).unwrap();
        assert_eq!(pruned, 2);

        let remaining: Vec<i64> = connection
            .prepare("SELECT seq FROM checkpoints WHERE run_id = ?1 ORDER BY seq ASC")
            .unwrap()
            .query_map(params![run_id], |row| row.get(0))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap();
        assert_eq!(remaining, (2..12).collect::<Vec<i64>>());
    }

    #[test]
    fn redaction_guard_rejects_a_secret_looking_field() {
        let messages = vec![blocks(
            ChatRole::Assistant,
            vec![ContentBlock::ToolUse {
                id: "call-secret".to_string(),
                name: "http".to_string(),
                arguments: json!({ "headers": { "Authorization": "Bearer abc" } }),
            }],
        )];
        let error = encode(
            &checkpoint("run-secret", 0, messages),
            &CheckpointLimits::default(),
        )
        .unwrap_err();
        assert!(matches!(error, CheckpointError::SecretDetected { .. }));
    }

    #[test]
    fn ordinary_words_do_not_trip_the_secret_guard() {
        // Regression: `contains("sk-")` used to refuse "disk-usage"/"task-list".
        let messages = vec![text(
            ChatRole::User,
            "disk-usage and task-list and risk-averse are ordinary prose",
        )];
        assert!(encode(
            &checkpoint("run-words", 0, messages),
            &CheckpointLimits::default(),
        )
        .is_ok());
    }

    #[test]
    fn oversized_payload_returns_a_named_error_not_a_truncated_write() {
        let connection = open();
        let run_id = setup_run(&connection, "conv-oversize");
        let limits = CheckpointLimits {
            max_blob_bytes: 32,
            max_run_bytes: 1024,
            max_total_bytes: 4096,
        };
        let big = checkpoint(&run_id, 0, vec![text(ChatRole::User, &"x".repeat(256))]);
        let error = encode(&big, &limits).unwrap_err();
        assert!(matches!(error, CheckpointError::PayloadTooLarge { .. }));

        // The insert-side guard is exercised too: encode under the default
        // (large) limits, then refuse at insert time with the tight limits.
        let encoded = encode(&big, &CheckpointLimits::default()).unwrap();
        let insert_error = insert_checkpoint(&connection, &encoded, &limits).unwrap_err();
        assert!(matches!(
            insert_error,
            CheckpointError::PayloadTooLarge { .. }
        ));

        // Nothing was written for the refused blob.
        let count: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM checkpoints WHERE run_id = ?1",
                params![run_id],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(count, 0);
    }

    #[test]
    fn insert_enforces_run_and_total_budgets() {
        let connection = open();
        let run_id = setup_run(&connection, "conv-budget");
        let limits = CheckpointLimits {
            max_blob_bytes: 4096,
            max_run_bytes: 64,
            max_total_bytes: 4096,
        };
        let first = encode(
            &checkpoint(&run_id, 0, vec![text(ChatRole::User, &"a".repeat(8))]),
            &limits,
        )
        .unwrap();
        insert_checkpoint(&connection, &first, &limits).unwrap();

        let second = encode(
            &checkpoint(&run_id, 1, vec![text(ChatRole::User, &"b".repeat(8))]),
            &limits,
        )
        .unwrap();
        let error = insert_checkpoint(&connection, &second, &limits).unwrap_err();
        assert!(matches!(error, CheckpointError::RunBudgetExceeded { .. }));
    }

    #[test]
    fn orphan_tool_result_is_rejected() {
        let messages = vec![blocks(
            ChatRole::User,
            vec![ContentBlock::ToolResult {
                tool_call_id: "missing".to_string(),
                content: "x".to_string(),
                is_error: false,
            }],
        )];
        assert!(matches!(
            validate_structure(&messages),
            Err(CheckpointError::OrphanToolResult { .. })
        ));
    }

    #[test]
    fn embedded_json_secret_in_tool_result_is_rejected() {
        let messages = vec![blocks(
            ChatRole::User,
            vec![ContentBlock::ToolResult {
                tool_call_id: "call-1".to_string(),
                content: r#"{"password":"hunter2"}"#.to_string(),
                is_error: false,
            }],
        )];
        let mut with_use = vec![blocks(
            ChatRole::Assistant,
            vec![ContentBlock::ToolUse {
                id: "call-1".to_string(),
                name: "cat".to_string(),
                arguments: json!({ "path": "config.json" }),
            }],
        )];
        with_use.extend(messages);
        let error = encode(
            &checkpoint("run-embedded", 0, with_use),
            &CheckpointLimits::default(),
        )
        .unwrap_err();
        assert!(matches!(error, CheckpointError::SecretDetected { .. }));
    }

    #[test]
    fn pending_effect_checkpoints_are_never_pruned() {
        let connection = open();
        let run_id = setup_run(&connection, "conv-pending");
        // One ancient checkpoint that still carries an unacknowledged effect.
        let mut pending = checkpoint(&run_id, 0, history());
        pending.pending_effect_ids = vec!["effect-1".to_string()];
        let encoded = encode(&pending, &CheckpointLimits::default()).unwrap();
        insert_checkpoint(&connection, &encoded, &CheckpointLimits::default()).unwrap();
        // Then flood with empty-pending checkpoints so the old one falls outside
        // the retention window.
        for seq in 1..12 {
            let encoded = encode(
                &checkpoint(&run_id, seq, history()),
                &CheckpointLimits::default(),
            )
            .unwrap();
            insert_checkpoint(&connection, &encoded, &CheckpointLimits::default()).unwrap();
        }
        prune_checkpoints(&connection, &run_id).unwrap();

        let survivors: Vec<(i64, String)> = connection
            .prepare(
                "SELECT seq, pending_effect_ids FROM checkpoints WHERE run_id = ?1 ORDER BY seq",
            )
            .unwrap()
            .query_map(params![run_id], |row| Ok((row.get(0)?, row.get(1)?)))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap();
        // The pending checkpoint (seq 0) survives even though it is the oldest,
        // and only the latest ten empty ones remain.
        assert!(survivors.iter().any(|(seq, _)| *seq == 0));
        assert_eq!(survivors.len(), 11);
    }

    #[test]
    fn retention_orders_by_epoch_then_seq() {
        let connection = open();
        let run_id = setup_run(&connection, "conv-epoch-retention");
        // A stale epoch with a high seq must lose to a newer epoch's low seq.
        let mut stale = checkpoint(&run_id, 999, history());
        stale.epoch = 0;
        let mut fresh = checkpoint(&run_id, 0, history());
        fresh.epoch = 1;
        let stale = encode(&stale, &CheckpointLimits::default()).unwrap();
        let fresh = encode(&fresh, &CheckpointLimits::default()).unwrap();
        insert_checkpoint(&connection, &stale, &CheckpointLimits::default()).unwrap();
        insert_checkpoint(&connection, &fresh, &CheckpointLimits::default()).unwrap();

        let latest = load_latest_checkpoint(&connection, &run_id)
            .unwrap()
            .expect("a checkpoint");
        assert_eq!(latest.epoch, 1);
        assert_eq!(latest.seq, 0);
    }

    #[test]
    fn next_seq_is_monotonic_within_an_epoch() {
        let connection = open();
        let run_id = setup_run(&connection, "conv-next-seq");
        assert_eq!(next_checkpoint_seq(&connection, &run_id, 0).unwrap(), 0);
        let encoded = encode(
            &checkpoint(&run_id, 0, history()),
            &CheckpointLimits::default(),
        )
        .unwrap();
        insert_checkpoint(&connection, &encoded, &CheckpointLimits::default()).unwrap();
        assert_eq!(next_checkpoint_seq(&connection, &run_id, 0).unwrap(), 1);
        // A new epoch restarts at zero.
        assert_eq!(next_checkpoint_seq(&connection, &run_id, 1).unwrap(), 0);
    }

    #[test]
    fn check_resumable_rejects_newer_schema_and_model_mismatch() {
        let mut newer = checkpoint("run-newer-resume", 0, history());
        newer.schema_version = CHECKPOINT_SCHEMA_VERSION + 1;
        assert!(matches!(
            check_resumable(&newer, "anthropic"),
            Err(CheckpointError::NewerSchema { .. })
        ));

        let rerouted = checkpoint("run-route-resume", 0, history());
        assert!(matches!(
            check_resumable(&rerouted, "openai"),
            Err(CheckpointError::ModelRouteMismatch { .. })
        ));

        assert!(check_resumable(&rerouted, "anthropic").is_ok());
    }
}
