//! R6 (H3) context accounting/projection.
//!
//! A pure, backend-native projection of the durable history onto a token
//! budget. There is no tokenizer and no retrieval/memory integration in v1:
//! every count is a conservative **estimate** (labelled `countKind:
//! "estimate"`) — a conservative heuristic that over-estimates bulk text, while
//! framing (per-message and per-block envelopes) is approximated. Optional-
//! material omission is deferred, so an overflow **blocks** before spend rather
//! than trimming the history, and the snapshot records that nothing was omitted.
//!
//! The module is pure apart from the small store helpers at the bottom that
//! read/write the `context_snapshots` table created by
//! [`super::runtime_journal`].

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::core::llm_types::{ChatMessage, ContentBlock, MessageContent, ToolDefinition};

/// Snapshot wire version. Bumped only for a breaking change to the persisted
/// shape; a newer snapshot row is refused by the store, never downgraded.
pub const CONTEXT_SCHEMA_VERSION: i64 = 1;

/// Conservative per-image token cost. Images are billed by pixels, not bytes,
/// so a byte heuristic is meaningless; this is a deliberately high flat charge.
pub const IMAGE_TOKEN_ESTIMATE: u64 = 2000;

/// Per-message provider serialization overhead: role tags, delimiters and the
/// envelope a provider wraps around each message. Small but never zero.
pub const PROVIDER_OVERHEAD_TOKENS: u64 = 16;

/// Per-block framing charge. A message with many small blocks (tool calls,
/// results, images) pays more envelope than a single long text block, so this is
/// added once per [`ContentBlock`] to approximate that framing.
pub const BLOCK_OVERHEAD_TOKENS: u64 = 4;

/// Named context failure. Callers branch on the variant rather than parse a
/// string. `Overflow` means "do not dispatch".
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ContextError {
    /// The projected request plus its reserved output and safety margin would
    /// exceed the model's context window. Nothing is dispatched.
    Overflow {
        total_tokens: u64,
        window_tokens: u64,
        reserved_output_tokens: u64,
        safety_margin_tokens: u64,
    },
    Encode(String),
    Decode(String),
    Store(String),
}

impl std::fmt::Display for ContextError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ContextError::Overflow {
                total_tokens,
                window_tokens,
                reserved_output_tokens,
                safety_margin_tokens,
            } => write!(
                f,
                "Context blocked_context: estimated {total_tokens} tokens plus reserved output {reserved_output_tokens} and safety margin {safety_margin_tokens} exceed the {window_tokens}-token context window"
            ),
            ContextError::Encode(message) => {
                write!(f, "Failed to encode context snapshot: {message}")
            }
            ContextError::Decode(message) => {
                write!(f, "Failed to decode context snapshot: {message}")
            }
            ContextError::Store(message) => write!(f, "Context snapshot store error: {message}"),
        }
    }
}

impl std::error::Error for ContextError {}

impl From<ContextError> for String {
    fn from(error: ContextError) -> Self {
        error.to_string()
    }
}

/// The token breakdown for one projection. `totalTokens` is the saturating sum
/// of the other fields.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContextCounts {
    pub system_prompt_tokens: u64,
    pub messages_tokens: u64,
    pub tools_tokens: u64,
    pub attachments_tokens: u64,
    pub provider_reasoning_tokens: u64,
    pub provider_overhead_tokens: u64,
    pub total_tokens: u64,
}

/// One class of optional content that was left out of the projection. v1 never
/// populates this (omission is deferred); the type exists so a later policy can
/// record what it dropped without a wire change.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OmittedContent {
    pub kind: String,
    pub reason: String,
    pub count: u64,
}

/// An immutable, content-addressed projection of one request against a window.
/// The content hash covers exactly the deterministic fields (never
/// `created_at`), so identical inputs always hash identically.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContextSnapshot {
    pub version: i64,
    pub snapshot_id: String,
    pub content_hash: String,
    pub model_route: String,
    pub count_kind: String,
    pub window_tokens: Option<u64>,
    pub reserved_output_tokens: u64,
    pub safety_margin_tokens: u64,
    pub counts: ContextCounts,
    pub omitted: Vec<OmittedContent>,
    pub blockers: Vec<String>,
    pub created_at: i64,
}

/// The canonical, deterministic view hashed for snapshot identity. A struct
/// serializes in declaration order, so the bytes are stable across processes;
/// `created_at` and the derived id are excluded, but `version` and `count_kind`
/// are included so a schema or count-policy change yields a new id.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ContextHashInput<'a> {
    version: i64,
    count_kind: &'a str,
    model_route: &'a str,
    window_tokens: Option<u64>,
    reserved_output_tokens: u64,
    safety_margin_tokens: u64,
    counts: &'a ContextCounts,
    omitted: &'a [OmittedContent],
    blockers: &'a [String],
}

/// A conservative token estimate for text: `ceil(bytes / 3)`. This is **not** a
/// tokenizer — a conservative heuristic that over-estimates bulk text; framing
/// is approximated. Multi-byte content is counted by its UTF-8 byte length, not
/// its character count.
pub fn estimate_text_tokens(s: &str) -> u64 {
    (s.len() as u64).div_ceil(3)
}

/// `(content_tokens, reasoning_tokens)` for one message. Every block pays a flat
/// framing charge; opaque provider reasoning envelopes are counted (as
/// reasoning) so a replayable chain is never silently free.
fn estimate_message_tokens(message: &ChatMessage) -> (u64, u64) {
    match &message.content {
        MessageContent::Text(text) => (estimate_text_tokens(text), 0),
        MessageContent::Blocks(blocks) => {
            let mut content_tokens = 0u64;
            let mut reasoning_tokens = 0u64;
            for block in blocks {
                content_tokens = content_tokens.saturating_add(BLOCK_OVERHEAD_TOKENS);
                match block {
                    ContentBlock::Text { text } => {
                        content_tokens = content_tokens.saturating_add(estimate_text_tokens(text));
                    }
                    ContentBlock::ToolResult { content, .. } => {
                        content_tokens =
                            content_tokens.saturating_add(estimate_text_tokens(content));
                    }
                    ContentBlock::ToolUse { arguments, .. } => {
                        let serialized = serde_json::to_string(arguments).unwrap_or_default();
                        content_tokens =
                            content_tokens.saturating_add(estimate_text_tokens(&serialized));
                    }
                    ContentBlock::Image { .. } => {
                        content_tokens = content_tokens.saturating_add(IMAGE_TOKEN_ESTIMATE);
                    }
                    ContentBlock::ProviderReasoning { details } => {
                        let serialized = serde_json::to_string(details).unwrap_or_default();
                        reasoning_tokens =
                            reasoning_tokens.saturating_add(estimate_text_tokens(&serialized));
                    }
                }
            }
            (content_tokens, reasoning_tokens)
        }
    }
}

fn content_hash(snapshot: &ContextSnapshot) -> String {
    let canonical = ContextHashInput {
        version: snapshot.version,
        count_kind: &snapshot.count_kind,
        model_route: &snapshot.model_route,
        window_tokens: snapshot.window_tokens,
        reserved_output_tokens: snapshot.reserved_output_tokens,
        safety_margin_tokens: snapshot.safety_margin_tokens,
        counts: &snapshot.counts,
        omitted: &snapshot.omitted,
        blockers: &snapshot.blockers,
    };
    let json = serde_json::to_string(&canonical).unwrap_or_default();
    format!("sha256:{:x}", Sha256::digest(json.as_bytes()))
}

/// The content-addressed id derived from a hash. Identical inputs always yield
/// the same id.
fn snapshot_id_for(content_hash: &str) -> String {
    let hex = content_hash.strip_prefix("sha256:").unwrap_or(content_hash);
    format!("ctx-{hex}")
}

/// Project one request against a window. `window_tokens` of `None` means the
/// window is unknown, so no strict fit is enforced and no blocker is recorded.
/// `attachment_count` is a COUNT of queued images, not their bytes: the caller
/// must not drain them to project (a refusal must leave them queued).
///
/// `omitted` is always empty in v1: optional-material omission is deferred, so
/// an overflow blocks instead of trimming and the snapshot records that nothing
/// was left out.
#[allow(clippy::too_many_arguments)]
pub fn project_context(
    model_route: &str,
    system_prompt: &str,
    messages: &[ChatMessage],
    tools: &[ToolDefinition],
    attachment_count: usize,
    window_tokens: Option<u64>,
    reserved_output_tokens: u64,
    safety_margin_tokens: u64,
    now: i64,
) -> ContextSnapshot {
    let system_prompt_tokens = estimate_text_tokens(system_prompt);

    let mut messages_tokens = 0u64;
    let mut provider_reasoning_tokens = 0u64;
    for message in messages {
        let (content, reasoning) = estimate_message_tokens(message);
        messages_tokens = messages_tokens.saturating_add(content);
        provider_reasoning_tokens = provider_reasoning_tokens.saturating_add(reasoning);
    }

    let tools_tokens = tools.iter().fold(0u64, |acc, tool| {
        let serialized = serde_json::to_string(tool).unwrap_or_default();
        acc.saturating_add(estimate_text_tokens(&serialized))
    });

    let attachments_tokens = (attachment_count as u64).saturating_mul(IMAGE_TOKEN_ESTIMATE);
    let provider_overhead_tokens = (messages.len() as u64).saturating_mul(PROVIDER_OVERHEAD_TOKENS);

    let total_tokens = system_prompt_tokens
        .saturating_add(messages_tokens)
        .saturating_add(tools_tokens)
        .saturating_add(attachments_tokens)
        .saturating_add(provider_reasoning_tokens)
        .saturating_add(provider_overhead_tokens);

    let counts = ContextCounts {
        system_prompt_tokens,
        messages_tokens,
        tools_tokens,
        attachments_tokens,
        provider_reasoning_tokens,
        provider_overhead_tokens,
        total_tokens,
    };

    let mut snapshot = ContextSnapshot {
        version: CONTEXT_SCHEMA_VERSION,
        snapshot_id: String::new(),
        content_hash: String::new(),
        model_route: model_route.to_string(),
        count_kind: "estimate".to_string(),
        window_tokens,
        reserved_output_tokens,
        safety_margin_tokens,
        counts,
        omitted: Vec::new(),
        blockers: Vec::new(),
        created_at: now,
    };
    snapshot.blockers = if overflow(&snapshot).is_some() {
        vec!["context_overflow".to_string()]
    } else {
        Vec::new()
    };
    let hash = content_hash(&snapshot);
    snapshot.snapshot_id = snapshot_id_for(&hash);
    snapshot.content_hash = hash;
    snapshot
}

/// The single overflow predicate: `Some((total, window, reserved_output,
/// safety_margin))` iff a known window is exceeded. Both `project_context` (for
/// `blockers`) and `check_fit` (for the error) derive from this, so they cannot
/// drift. An unknown window (`None`) is never an overflow.
fn overflow(snapshot: &ContextSnapshot) -> Option<(u64, u64, u64, u64)> {
    let window = snapshot.window_tokens?;
    let total = snapshot.counts.total_tokens;
    let used = total
        .saturating_add(snapshot.reserved_output_tokens)
        .saturating_add(snapshot.safety_margin_tokens);
    if used > window {
        Some((
            total,
            window,
            snapshot.reserved_output_tokens,
            snapshot.safety_margin_tokens,
        ))
    } else {
        None
    }
}

/// Strict fit check. An unknown window (`None`) has no strict fit and is always
/// `Ok`; a known window refuses when the total plus reserved output and safety
/// margin exceeds it. Derived from the numbers via [`overflow`], never from
/// `snapshot.blockers`, so a caller-supplied or stale blocker list cannot change
/// the outcome.
pub fn check_fit(snapshot: &ContextSnapshot) -> Result<(), ContextError> {
    match overflow(snapshot) {
        Some((total_tokens, window_tokens, reserved_output_tokens, safety_margin_tokens)) => {
            Err(ContextError::Overflow {
                total_tokens,
                window_tokens,
                reserved_output_tokens,
                safety_margin_tokens,
            })
        }
        None => Ok(()),
    }
}

/// Insert an immutable context snapshot addressed by `snapshot_id`. Re-inserting
/// the same id is idempotent (the first record wins); `run_id`/`epoch` are
/// nullable because a snapshot can be projected for a session with no run
/// binding.
pub fn insert_context_snapshot(
    connection: &Connection,
    run_id: Option<&str>,
    epoch: Option<i64>,
    snapshot: &ContextSnapshot,
) -> Result<(), ContextError> {
    let payload =
        serde_json::to_string(snapshot).map_err(|e| ContextError::Encode(e.to_string()))?;
    connection
        .execute(
            "INSERT OR IGNORE INTO context_snapshots \
             (snapshot_id, content_hash, run_id, epoch, model_route, payload, created_at) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![
                snapshot.snapshot_id,
                snapshot.content_hash,
                run_id,
                epoch,
                snapshot.model_route,
                payload,
                snapshot.created_at
            ],
        )
        .map_err(|e| ContextError::Store(e.to_string()))?;
    Ok(())
}

/// Load and verify a context snapshot by id. The payload is re-hashed and
/// compared against both the stored hash and the snapshot's own hash; a
/// mismatch is a named error and the row is left untouched. A newer schema
/// version is refused, never downgraded.
pub fn load_context_snapshot(
    connection: &Connection,
    snapshot_id: &str,
) -> Result<ContextSnapshot, ContextError> {
    let (payload, stored_hash): (String, String) = connection
        .query_row(
            "SELECT payload, content_hash FROM context_snapshots WHERE snapshot_id = ?1",
            params![snapshot_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()
        .map_err(|e| ContextError::Store(e.to_string()))?
        .ok_or_else(|| ContextError::Store(format!("Unknown context snapshot: {snapshot_id}")))?;
    let snapshot: ContextSnapshot =
        serde_json::from_str(&payload).map_err(|e| ContextError::Decode(e.to_string()))?;
    if snapshot.version > CONTEXT_SCHEMA_VERSION {
        return Err(ContextError::Decode(format!(
            "context snapshot {snapshot_id} schema v{} is newer than this build supports (v{CONTEXT_SCHEMA_VERSION}); preserved read-only",
            snapshot.version
        )));
    }
    let computed = content_hash(&snapshot);
    if computed != stored_hash || computed != snapshot.content_hash {
        return Err(ContextError::Decode(format!(
            "context snapshot {snapshot_id} content hash mismatch: stored {stored_hash}, computed {computed}"
        )));
    }
    Ok(snapshot)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::llm_types::ChatRole;
    use crate::core::runtime_journal::open_at;
    use serde_json::json;
    use std::path::PathBuf;
    use uuid::Uuid;

    fn temp_db() -> PathBuf {
        std::env::temp_dir()
            .join(format!("packetbench-context-test-{}", Uuid::new_v4()))
            .join("journal.db")
    }

    fn text_message(text: &str) -> ChatMessage {
        ChatMessage {
            role: ChatRole::User,
            content: MessageContent::text(text),
        }
    }

    fn blocks_message() -> ChatMessage {
        ChatMessage {
            role: ChatRole::User,
            content: MessageContent::Blocks(vec![
                ContentBlock::Text {
                    text: "abcd".to_string(),
                },
                ContentBlock::ToolUse {
                    id: "t1".to_string(),
                    name: "bash".to_string(),
                    arguments: json!({ "a": 1 }),
                },
                ContentBlock::ToolResult {
                    tool_call_id: "t1".to_string(),
                    content: "hello".to_string(),
                    is_error: false,
                },
                ContentBlock::Image {
                    media_type: "image/png".to_string(),
                    data_base64: "AAAA".to_string(),
                },
                ContentBlock::ProviderReasoning {
                    details: json!({ "r": true }),
                },
            ]),
        }
    }

    fn tool() -> ToolDefinition {
        ToolDefinition {
            name: "bash".to_string(),
            description: "run a command".to_string(),
            parameters: json!({ "type": "object" }),
        }
    }

    #[test]
    fn estimator_is_conservative_and_monotonic() {
        assert_eq!(estimate_text_tokens(""), 0);
        assert!(estimate_text_tokens("a") >= 1);
        assert!(estimate_text_tokens("hello world") >= estimate_text_tokens("hello"));
        // bytes/3: three ASCII bytes is one token, four rounds up to two.
        assert_eq!(estimate_text_tokens("abc"), 1);
        assert_eq!(estimate_text_tokens("abcd"), 2);
        // Multi-byte content is counted by its UTF-8 byte length (2 bytes here).
        assert_eq!(estimate_text_tokens("é"), 1);
    }

    #[test]
    fn counts_include_tools_images_reasoning_and_overhead() {
        let snapshot = project_context(
            "fake:fake-model",
            "",
            &[blocks_message()],
            &[tool()],
            1,
            None,
            0,
            0,
            1,
        );

        // 2 (text) + 3 (tool_use args) + 2 (tool_result) + 2000 (image) = 2007,
        // plus 5 blocks * 4 framing = 2027.
        assert_eq!(snapshot.counts.messages_tokens, 2027);
        // The opaque reasoning envelope is counted as reasoning, not content.
        assert_eq!(snapshot.counts.provider_reasoning_tokens, 4);
        assert_eq!(snapshot.counts.attachments_tokens, IMAGE_TOKEN_ESTIMATE);
        assert_eq!(
            snapshot.counts.provider_overhead_tokens,
            PROVIDER_OVERHEAD_TOKENS
        );
        let expected_tools = estimate_text_tokens(&serde_json::to_string(&tool()).unwrap());
        assert_eq!(snapshot.counts.tools_tokens, expected_tools);
        assert_eq!(
            snapshot.counts.total_tokens,
            snapshot.counts.system_prompt_tokens
                + snapshot.counts.messages_tokens
                + snapshot.counts.tools_tokens
                + snapshot.counts.attachments_tokens
                + snapshot.counts.provider_reasoning_tokens
                + snapshot.counts.provider_overhead_tokens
        );
        assert_eq!(snapshot.count_kind, "estimate");
        assert!(snapshot.omitted.is_empty());
    }

    #[test]
    fn a_within_window_projection_has_no_blockers() {
        let snapshot = project_context(
            "fake:fake-model",
            "system",
            &[text_message("hi")],
            &[],
            0,
            Some(1_000_000),
            16384,
            0,
            1,
        );
        assert!(snapshot.blockers.is_empty());
        assert!(check_fit(&snapshot).is_ok());
    }

    #[test]
    fn an_over_window_projection_blocks_with_named_numbers() {
        let snapshot = project_context(
            "fake:fake-model",
            "",
            &[text_message("abc")],
            &[],
            0,
            Some(100),
            16384,
            0,
            1,
        );
        // 1 (message) + 16 (overhead) = 17.
        assert_eq!(snapshot.counts.total_tokens, 17);
        assert_eq!(snapshot.blockers, vec!["context_overflow".to_string()]);

        let error = check_fit(&snapshot).unwrap_err();
        assert!(error.to_string().contains("blocked_context"));
        match error {
            ContextError::Overflow {
                total_tokens,
                window_tokens,
                reserved_output_tokens,
                safety_margin_tokens,
            } => {
                assert_eq!(total_tokens, 17);
                assert_eq!(window_tokens, 100);
                assert_eq!(reserved_output_tokens, 16384);
                assert_eq!(safety_margin_tokens, 0);
            }
            other => panic!("expected an overflow error, got {other:?}"),
        }
    }

    #[test]
    fn an_unknown_window_never_blocks() {
        let snapshot = project_context(
            "fake:fake-model",
            "system",
            &[text_message(
                "a very long message that would overflow a small window",
            )],
            &[],
            0,
            None,
            16384,
            0,
            1,
        );
        assert!(snapshot.blockers.is_empty());
        assert!(check_fit(&snapshot).is_ok());
        assert_eq!(snapshot.window_tokens, None);
    }

    #[test]
    fn content_hash_is_stable_and_sensitive_but_ignores_created_at() {
        let base = project_context(
            "fake:fake-model",
            "system",
            &[text_message("hi")],
            &[],
            0,
            Some(1_000_000),
            16384,
            0,
            1,
        );
        // A different timestamp must not change the identity.
        let later = project_context(
            "fake:fake-model",
            "system",
            &[text_message("hi")],
            &[],
            0,
            Some(1_000_000),
            16384,
            0,
            9_999,
        );
        assert_eq!(base.content_hash, later.content_hash);
        assert_eq!(base.snapshot_id, later.snapshot_id);

        // Changing any counted input changes the hash.
        let changed_route = project_context(
            "other:model",
            "system",
            &[text_message("hi")],
            &[],
            0,
            Some(1_000_000),
            16384,
            0,
            1,
        );
        assert_ne!(base.content_hash, changed_route.content_hash);
        let changed_prompt = project_context(
            "fake:fake-model",
            "different",
            &[text_message("hi")],
            &[],
            0,
            Some(1_000_000),
            16384,
            0,
            1,
        );
        assert_ne!(base.content_hash, changed_prompt.content_hash);
        let changed_window = project_context(
            "fake:fake-model",
            "system",
            &[text_message("hi")],
            &[],
            0,
            Some(500_000),
            16384,
            0,
            1,
        );
        assert_ne!(base.content_hash, changed_window.content_hash);
        let changed_message = project_context(
            "fake:fake-model",
            "system",
            &[text_message("hi there")],
            &[],
            0,
            Some(1_000_000),
            16384,
            0,
            1,
        );
        assert_ne!(base.content_hash, changed_message.content_hash);
    }

    #[test]
    fn context_snapshot_store_round_trips_and_refuses_corruption_and_newer_versions() {
        let connection = open_at(&temp_db()).unwrap();
        connection
            .execute(
                "INSERT INTO runs (run_id, conversation_id, operation_id, root_run_id, epoch, state, latest_seq) \
                 VALUES ('run-1', 'conv-1', 'op-1', 'run-1', 0, 'prepared', 0)",
                [],
            )
            .unwrap();

        let snapshot = project_context(
            "fake:fake-model",
            "system",
            &[text_message("hi")],
            &[tool()],
            0,
            Some(1_000_000),
            16384,
            0,
            42,
        );
        insert_context_snapshot(&connection, Some("run-1"), Some(0), &snapshot).unwrap();
        let loaded = load_context_snapshot(&connection, &snapshot.snapshot_id).unwrap();
        assert_eq!(loaded, snapshot);

        // Re-inserting the same id is idempotent and preserves the first record.
        insert_context_snapshot(&connection, None, None, &snapshot).unwrap();
        let count: i64 = connection
            .query_row("SELECT COUNT(*) FROM context_snapshots", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(count, 1);

        // Corrupt the stored payload; the row stays in place and is refused.
        connection
            .execute(
                "UPDATE context_snapshots SET payload = ?1 WHERE snapshot_id = ?2",
                params!["{\"broken\":", snapshot.snapshot_id],
            )
            .unwrap();
        assert!(matches!(
            load_context_snapshot(&connection, &snapshot.snapshot_id),
            Err(ContextError::Decode(_))
        ));
        let count: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM context_snapshots WHERE snapshot_id = ?1",
                params![snapshot.snapshot_id],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(count, 1);

        // A snapshot written by a newer build is refused, never downgraded.
        let mut newer = project_context(
            "fake:newer-model",
            "system",
            &[text_message("hi")],
            &[],
            0,
            Some(1_000_000),
            16384,
            0,
            42,
        );
        newer.version = CONTEXT_SCHEMA_VERSION + 1;
        insert_context_snapshot(&connection, None, None, &newer).unwrap();
        assert!(matches!(
            load_context_snapshot(&connection, &newer.snapshot_id),
            Err(ContextError::Decode(_))
        ));
        let count: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM context_snapshots WHERE snapshot_id = ?1",
                params![newer.snapshot_id],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(count, 1);
    }
}
