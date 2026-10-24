//! R4a capability knowledge (H5): a tri-state, provenance-carrying answer to
//! "does this provider/model support X?".
//!
//! Substrate only — nothing in the live agent loop calls this yet; R4b wires the
//! pre-dispatch checks. The module is pure apart from the small store helpers at
//! the bottom that read/write the `capability_snapshots` table created by
//! [`super::runtime_journal`].
//!
//! The load-bearing rule from the runtime spec (§6): **unknown is never treated
//! as supported**. A capability is only `supported` when a source actually said
//! so; an unsupported or unknown behavior that a run *requires* fails before
//! dispatch with a named error, so nothing (an image, a tool, a reasoning
//! control) is silently dropped.
//!
//! Provenance precedence (R4 addendum, `06-r2b-decisions-and-plan.md`): a live
//! catalog entry (`commands::provider_models::LiveModel`) is the first source; a
//! small static table is second; otherwise the value is `unknown`. Live catalogs
//! can only speak to context window; the static table covers the rest.

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::commands::provider_models::LiveModel;

/// Snapshot wire version. Bumped only for a breaking change to the persisted
/// shape; a newer snapshot row is refused by the store, never downgraded.
pub const CAPABILITY_SCHEMA_VERSION: i64 = 1;

/// Where a capability value came from. `Unknown` is a provenance of last resort:
/// nothing is known about the value, so it must not be read as support.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CapabilityProvenance {
    LiveCatalog,
    Static,
    Unknown,
}

impl CapabilityProvenance {
    pub fn as_str(self) -> &'static str {
        match self {
            CapabilityProvenance::LiveCatalog => "live_catalog",
            CapabilityProvenance::Static => "static",
            CapabilityProvenance::Unknown => "unknown",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "live_catalog" => Some(CapabilityProvenance::LiveCatalog),
            "static" => Some(CapabilityProvenance::Static),
            "unknown" => Some(CapabilityProvenance::Unknown),
            _ => None,
        }
    }
}

/// The three states a capability can be in. Kept separate from
/// [`CapabilityKnowledge`] so callers can branch on the state without matching
/// the whole payload.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CapabilityState {
    Supported,
    Unsupported,
    Unknown,
}

impl CapabilityState {
    pub fn as_str(self) -> &'static str {
        match self {
            CapabilityState::Supported => "supported",
            CapabilityState::Unsupported => "unsupported",
            CapabilityState::Unknown => "unknown",
        }
    }
}

/// A tri-state capability answer. Only [`CapabilityKnowledge::Supported`] grants
/// anything; `Unsupported` and `Unknown` are both non-support and must be handled
/// identically by a pre-dispatch guard.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "state", rename_all = "snake_case")]
pub enum CapabilityKnowledge<T> {
    Supported {
        value: T,
        provenance: CapabilityProvenance,
    },
    Unsupported {
        reason: String,
        provenance: CapabilityProvenance,
    },
    Unknown {
        reason: String,
        provenance: CapabilityProvenance,
    },
}

impl<T> CapabilityKnowledge<T> {
    pub fn supported(value: T, provenance: CapabilityProvenance) -> Self {
        CapabilityKnowledge::Supported { value, provenance }
    }

    pub fn unsupported(reason: impl Into<String>, provenance: CapabilityProvenance) -> Self {
        CapabilityKnowledge::Unsupported {
            reason: reason.into(),
            provenance,
        }
    }

    pub fn unknown(reason: impl Into<String>) -> Self {
        CapabilityKnowledge::Unknown {
            reason: reason.into(),
            provenance: CapabilityProvenance::Unknown,
        }
    }

    pub fn state(&self) -> CapabilityState {
        match self {
            CapabilityKnowledge::Supported { .. } => CapabilityState::Supported,
            CapabilityKnowledge::Unsupported { .. } => CapabilityState::Unsupported,
            CapabilityKnowledge::Unknown { .. } => CapabilityState::Unknown,
        }
    }

    pub fn provenance(&self) -> CapabilityProvenance {
        match self {
            CapabilityKnowledge::Supported { provenance, .. }
            | CapabilityKnowledge::Unsupported { provenance, .. }
            | CapabilityKnowledge::Unknown { provenance, .. } => *provenance,
        }
    }

    /// True only for an explicit `supported` answer. `unsupported` and `unknown`
    /// both return false — this is the single predicate that keeps unknown from
    /// being laundered into support.
    pub fn is_supported(&self) -> bool {
        matches!(self, CapabilityKnowledge::Supported { .. })
    }

    pub fn value(&self) -> Option<&T> {
        match self {
            CapabilityKnowledge::Supported { value, .. } => Some(value),
            _ => None,
        }
    }

    pub fn reason(&self) -> Option<&str> {
        match self {
            CapabilityKnowledge::Unsupported { reason, .. }
            | CapabilityKnowledge::Unknown { reason, .. } => Some(reason),
            CapabilityKnowledge::Supported { .. } => None,
        }
    }
}

/// Whether the model can call tools, and whether it can call them in parallel.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolCapability {
    pub parallel: bool,
}

/// The reasoning controls a route exposes and how output budget is shared.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReasoningCapability {
    pub controls: Vec<String>,
    pub output_budget_semantics: String,
}

/// How a run can be continued. `Typed` means a tested versioned format exists;
/// `Semantic` means only a fresh continuation is offered.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ResumeMode {
    Typed,
    Semantic,
}

/// Whether/how a run is resumable.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResumabilityCapability {
    pub mode: ResumeMode,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub format_version: Option<String>,
}

/// A frozen set of capability answers for one provider/model. This is the unit
/// the store writes and reads; it carries no execution authority of its own.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CapabilitySnapshot {
    pub version: i64,
    pub provider: String,
    pub model: String,
    pub tools: CapabilityKnowledge<ToolCapability>,
    pub vision: CapabilityKnowledge<bool>,
    pub reasoning: CapabilityKnowledge<ReasoningCapability>,
    pub structured_output: CapabilityKnowledge<bool>,
    pub context_window: CapabilityKnowledge<u64>,
    pub resumability: CapabilityKnowledge<ResumabilityCapability>,
}

/// Named capability failure. Callers branch on the variant rather than parse a
/// string. Every variant means "do not dispatch".
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CapabilityError {
    /// A required behavior is unsupported or unknown. Nothing is dispatched.
    CapabilityUnavailable {
        capability: String,
        state: CapabilityState,
        provenance: CapabilityProvenance,
        reason: String,
    },
    /// An attachment was supplied but the route cannot accept it. This is the
    /// "never silently drop an attachment" guard.
    AttachmentUnsupported {
        attachment: String,
        capability: String,
        state: CapabilityState,
        reason: String,
    },
    Encode(String),
    Decode(String),
    Store(String),
}

impl std::fmt::Display for CapabilityError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            CapabilityError::CapabilityUnavailable {
                capability,
                state,
                provenance,
                reason,
            } => write!(
                f,
                "Required capability \"{capability}\" is {} (provenance {}): {reason}",
                state.as_str(),
                provenance.as_str()
            ),
            CapabilityError::AttachmentUnsupported {
                attachment,
                capability,
                state,
                reason,
            } => write!(
                f,
                "Cannot send {attachment} attachment: capability \"{capability}\" is {} ({reason})",
                state.as_str()
            ),
            CapabilityError::Encode(message) => {
                write!(f, "Failed to encode capability snapshot: {message}")
            }
            CapabilityError::Decode(message) => {
                write!(f, "Failed to decode capability snapshot: {message}")
            }
            CapabilityError::Store(message) => {
                write!(f, "Capability snapshot store error: {message}")
            }
        }
    }
}

impl std::error::Error for CapabilityError {}

impl From<CapabilityError> for String {
    fn from(error: CapabilityError) -> Self {
        error.to_string()
    }
}

/// Fail-closed guard: return the value only when the capability is explicitly
/// `supported`; otherwise return a named error. `unsupported` and `unknown` are
/// treated identically because both mean "we cannot claim this works".
pub fn require_supported<'a, T>(
    capability: &str,
    knowledge: &'a CapabilityKnowledge<T>,
) -> Result<&'a T, CapabilityError> {
    match knowledge {
        CapabilityKnowledge::Supported { value, .. } => Ok(value),
        CapabilityKnowledge::Unsupported { reason, provenance } => {
            Err(CapabilityError::CapabilityUnavailable {
                capability: capability.to_string(),
                state: CapabilityState::Unsupported,
                provenance: *provenance,
                reason: reason.clone(),
            })
        }
        CapabilityKnowledge::Unknown { reason, provenance } => {
            Err(CapabilityError::CapabilityUnavailable {
                capability: capability.to_string(),
                state: CapabilityState::Unknown,
                provenance: *provenance,
                reason: reason.clone(),
            })
        }
    }
}

impl CapabilitySnapshot {
    /// Guard an image attachment: refuse before dispatch when vision is not
    /// explicitly supported, so an image is never silently dropped.
    pub fn require_image_input(&self) -> Result<(), CapabilityError> {
        // `Supported(false)` must refuse too — a tri-state `supported` variant
        // that carries `false` still means the model cannot take images.
        if let CapabilityKnowledge::Supported { value: false, .. } = &self.vision {
            return Err(CapabilityError::AttachmentUnsupported {
                attachment: "image".to_string(),
                capability: "vision".to_string(),
                state: CapabilityState::Unsupported,
                reason: "the model does not accept image input".to_string(),
            });
        }
        require_supported("vision", &self.vision)
            .map(|_| ())
            .map_err(|error| match error {
                CapabilityError::CapabilityUnavailable {
                    capability,
                    state,
                    reason,
                    ..
                } => CapabilityError::AttachmentUnsupported {
                    attachment: "image".to_string(),
                    capability,
                    state,
                    reason,
                },
                other => other,
            })
    }
}

/// The static fallback table for one provider/model. Every field is `None` when
/// the table does not know the answer, which resolves to `unknown`.
#[derive(Default)]
struct StaticCapabilities {
    tools: Option<ToolCapability>,
    vision: Option<bool>,
    reasoning: Option<ReasoningCapability>,
    structured_output: Option<bool>,
    context_window: Option<u64>,
    resumability: Option<ResumabilityCapability>,
}

/// Map the ids the callers have on hand (`AgentCli` values *and* keyring names)
/// onto the provider families the static table knows. Mirrors
/// `commands::provider_models::canonical_provider` but is intentionally tiny —
/// it only needs to be good enough to pick a static row.
fn normalize_provider(provider: &str) -> String {
    let lower = provider.trim().to_ascii_lowercase();
    match lower.as_str() {
        "api-claude" | "api-claude-oauth" | "claude-oauth" | "claude" => "anthropic".to_string(),
        "api-openai" | "api-openai-agents" | "openai-agents" => "openai".to_string(),
        "api-minimax" | "minimax-api" => "minimax".to_string(),
        "api-openrouter" => "openrouter".to_string(),
        "api-ollama" => "ollama".to_string(),
        "api-custom" => "custom".to_string(),
        other => other.to_string(),
    }
}

fn claude_supports_vision(model: &str) -> bool {
    [
        "claude-3",
        "claude-4",
        "claude-sonnet",
        "claude-opus",
        "claude-haiku",
    ]
    .iter()
    .any(|needle| model.contains(needle))
}

fn claude_supports_reasoning(model: &str) -> bool {
    [
        "claude-3-7",
        "claude-4",
        "claude-opus-4",
        "claude-sonnet-4",
        "claude-haiku-4",
    ]
    .iter()
    .any(|needle| model.contains(needle))
}

fn openai_supports_vision(model: &str) -> bool {
    ["gpt-4o", "gpt-4.1", "gpt-5", "chatgpt-4o", "o1", "o3", "o4"]
        .iter()
        .any(|needle| model.contains(needle))
}

fn openai_supports_reasoning(model: &str) -> bool {
    let stripped = model.trim_start_matches("openai/");
    ["o1", "o3", "o4"]
        .iter()
        .any(|prefix| stripped.starts_with(prefix))
}

/// The small static table. Deliberately conservative: a value is only recorded
/// when it is stable enough to be a useful fallback, and context windows are a
/// lower-bound default that a live catalog overrides.
fn static_capabilities(provider: &str, model: &str) -> StaticCapabilities {
    let provider = normalize_provider(provider);
    let model = model.to_ascii_lowercase();
    let mut caps = StaticCapabilities::default();

    match provider.as_str() {
        "anthropic" => {
            caps.tools = Some(ToolCapability { parallel: true });
            if claude_supports_vision(&model) {
                caps.vision = Some(true);
            }
            caps.structured_output = Some(true);
            if claude_supports_reasoning(&model) {
                caps.reasoning = Some(ReasoningCapability {
                    controls: vec!["thinking".to_string()],
                    output_budget_semantics: "shared_with_completion".to_string(),
                });
            }
            // Conservative fallback; the live catalog is authoritative and
            // publishes the real window.
            caps.context_window = Some(200_000);
            caps.resumability = Some(ResumabilityCapability {
                mode: ResumeMode::Semantic,
                format_version: None,
            });
        }
        "openai" => {
            caps.tools = Some(ToolCapability { parallel: true });
            if openai_supports_vision(&model) {
                caps.vision = Some(true);
            }
            caps.structured_output = Some(true);
            if openai_supports_reasoning(&model) {
                caps.reasoning = Some(ReasoningCapability {
                    controls: vec!["reasoning_effort".to_string()],
                    output_budget_semantics: "shared_with_completion".to_string(),
                });
            }
            // OpenAI's `/v1/models` publishes no window, so there is no static
            // fallback and the field stays unknown without a live entry.
            caps.resumability = Some(ResumabilityCapability {
                mode: ResumeMode::Semantic,
                format_version: None,
            });
        }
        "ollama" => {
            // Local models vary too much for a static tool/vision claim; only
            // the continuation mode is stable.
            caps.resumability = Some(ResumabilityCapability {
                mode: ResumeMode::Semantic,
                format_version: None,
            });
        }
        // OpenRouter proxies arbitrary upstreams, MiniMax/custom/named routes
        // publish nothing we can stand behind, so every field stays unknown.
        _ => {}
    }

    caps
}

/// Resolve a capability snapshot for `provider`/`model`, preferring a live
/// catalog entry when one is supplied. `live` is only ever read for its context
/// window; a `None` window falls through to the static table.
pub fn resolve_capabilities(
    provider: &str,
    model: &str,
    live: Option<&LiveModel>,
) -> CapabilitySnapshot {
    let static_caps = static_capabilities(provider, model);

    let tools = match static_caps.tools {
        Some(value) => CapabilityKnowledge::supported(value, CapabilityProvenance::Static),
        None => CapabilityKnowledge::unknown(format!(
            "no static tool capability is recorded for provider \"{provider}\""
        )),
    };

    let vision = match static_caps.vision {
        Some(value) => CapabilityKnowledge::supported(value, CapabilityProvenance::Static),
        None => CapabilityKnowledge::unknown(format!(
            "no vision capability is recorded for provider \"{provider}\" model \"{model}\""
        )),
    };

    let reasoning = match static_caps.reasoning {
        Some(value) => CapabilityKnowledge::supported(value, CapabilityProvenance::Static),
        None => CapabilityKnowledge::unknown(format!(
            "no reasoning capability is recorded for provider \"{provider}\" model \"{model}\""
        )),
    };

    let structured_output = match static_caps.structured_output {
        Some(value) => CapabilityKnowledge::supported(value, CapabilityProvenance::Static),
        None => CapabilityKnowledge::unknown(format!(
            "no structured-output capability is recorded for provider \"{provider}\""
        )),
    };

    let context_window = match live.and_then(|entry| entry.context_window) {
        Some(window) => {
            CapabilityKnowledge::supported(window, CapabilityProvenance::LiveCatalog)
        }
        None => match static_caps.context_window {
            Some(window) => CapabilityKnowledge::supported(window, CapabilityProvenance::Static),
            None => CapabilityKnowledge::unknown(format!(
                "no live catalog entry and no static context window for provider \"{provider}\" model \"{model}\""
            )),
        },
    };

    let resumability = match static_caps.resumability {
        Some(value) => CapabilityKnowledge::supported(value, CapabilityProvenance::Static),
        None => CapabilityKnowledge::unknown(format!(
            "no resumability capability is recorded for provider \"{provider}\""
        )),
    };

    CapabilitySnapshot {
        version: CAPABILITY_SCHEMA_VERSION,
        provider: provider.to_string(),
        model: model.to_string(),
        tools,
        vision,
        reasoning,
        structured_output,
        context_window,
        resumability,
    }
}

fn snapshot_hash(payload: &str) -> String {
    format!("sha256:{:x}", Sha256::digest(payload.as_bytes()))
}

/// Insert an immutable capability snapshot addressed by `snapshot_id`, with its
/// content hash stored alongside. Re-inserting the same id is a conflict rather
/// than a silent overwrite.
pub fn insert_capability_snapshot(
    connection: &Connection,
    snapshot_id: &str,
    snapshot: &CapabilitySnapshot,
    created_at: i64,
) -> Result<(), CapabilityError> {
    let payload =
        serde_json::to_string(snapshot).map_err(|e| CapabilityError::Encode(e.to_string()))?;
    connection
        .execute(
            "INSERT INTO capability_snapshots (snapshot_id, content_hash, payload, created_at) \
             VALUES (?1, ?2, ?3, ?4)",
            params![snapshot_id, snapshot_hash(&payload), payload, created_at],
        )
        .map_err(|e| CapabilityError::Store(e.to_string()))?;
    Ok(())
}

/// Load and verify a capability snapshot by id. A hash mismatch or malformed
/// payload is a named error; the row is left untouched.
pub fn load_capability_snapshot(
    connection: &Connection,
    snapshot_id: &str,
) -> Result<CapabilitySnapshot, CapabilityError> {
    let (payload, stored_hash): (String, String) = connection
        .query_row(
            "SELECT payload, content_hash FROM capability_snapshots WHERE snapshot_id = ?1",
            params![snapshot_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()
        .map_err(|e| CapabilityError::Store(e.to_string()))?
        .ok_or_else(|| {
            CapabilityError::Store(format!("Unknown capability snapshot: {snapshot_id}"))
        })?;
    let computed = snapshot_hash(&payload);
    if computed != stored_hash {
        return Err(CapabilityError::Decode(format!(
            "capability snapshot {snapshot_id} hash mismatch: expected {stored_hash}, computed {computed}"
        )));
    }
    let snapshot: CapabilitySnapshot =
        serde_json::from_str(&payload).map_err(|e| CapabilityError::Decode(e.to_string()))?;
    if snapshot.version > CAPABILITY_SCHEMA_VERSION {
        return Err(CapabilityError::Decode(format!(
            "capability snapshot {snapshot_id} schema v{} is newer than this build supports (v{CAPABILITY_SCHEMA_VERSION}); preserved read-only",
            snapshot.version
        )));
    }
    Ok(snapshot)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::runtime_journal::open_at;
    use std::path::PathBuf;
    use uuid::Uuid;

    fn temp_db() -> PathBuf {
        std::env::temp_dir()
            .join(format!("packetbench-capability-test-{}", Uuid::new_v4()))
            .join("journal.db")
    }

    fn live(id: &str, context_window: Option<u64>) -> LiveModel {
        LiveModel {
            id: id.to_string(),
            display_name: None,
            context_window,
            max_output: None,
            input_per_mtok: None,
            output_per_mtok: None,
        }
    }

    #[test]
    fn tri_state_knowledge_round_trips_with_provenance() {
        let supported: CapabilityKnowledge<bool> =
            CapabilityKnowledge::supported(true, CapabilityProvenance::LiveCatalog);
        let unsupported: CapabilityKnowledge<bool> =
            CapabilityKnowledge::unsupported("no image tokens", CapabilityProvenance::Static);
        let unknown: CapabilityKnowledge<bool> =
            CapabilityKnowledge::unknown("provider did not say");

        for original in [&supported, &unsupported, &unknown] {
            let json = serde_json::to_string(original).unwrap();
            let decoded: CapabilityKnowledge<bool> = serde_json::from_str(&json).unwrap();
            assert_eq!(&decoded, original);
            assert_eq!(decoded.state(), original.state());
            assert_eq!(decoded.provenance(), original.provenance());
        }

        assert_eq!(supported.state(), CapabilityState::Supported);
        assert_eq!(supported.provenance(), CapabilityProvenance::LiveCatalog);
        assert_eq!(supported.value(), Some(&true));
        assert_eq!(unsupported.state(), CapabilityState::Unsupported);
        assert_eq!(unsupported.reason(), Some("no image tokens"));
        assert_eq!(unknown.state(), CapabilityState::Unknown);
        assert_eq!(unknown.provenance(), CapabilityProvenance::Unknown);

        // The tag is on the wire so a frontend can branch without guessing.
        let json = serde_json::to_value(&unknown).unwrap();
        assert_eq!(json["state"], serde_json::json!("unknown"));
        assert_eq!(json["provenance"], serde_json::json!("unknown"));
    }

    #[test]
    fn unknown_and_unsupported_are_never_supported() {
        let unknown: CapabilityKnowledge<bool> = CapabilityKnowledge::unknown("no data");
        let unsupported: CapabilityKnowledge<bool> =
            CapabilityKnowledge::unsupported("nope", CapabilityProvenance::Static);
        assert!(!unknown.is_supported());
        assert!(!unsupported.is_supported());
        assert!(unknown.value().is_none());
        assert!(unsupported.value().is_none());
    }

    #[test]
    fn unknown_vision_blocks_an_image_before_dispatch() {
        // OpenRouter records no static vision capability, so vision is unknown.
        let snapshot = resolve_capabilities("api-openrouter", "some/odd-model", None);
        assert_eq!(snapshot.vision.state(), CapabilityState::Unknown);

        let error = snapshot.require_image_input().unwrap_err();
        match error {
            CapabilityError::AttachmentUnsupported {
                attachment,
                capability,
                state,
                ..
            } => {
                assert_eq!(attachment, "image");
                assert_eq!(capability, "vision");
                assert_eq!(state, CapabilityState::Unknown);
            }
            other => panic!("expected a named attachment error, got {other:?}"),
        }
        // The generic guard agrees and names the capability.
        let generic = require_supported("vision", &snapshot.vision).unwrap_err();
        assert!(matches!(
            generic,
            CapabilityError::CapabilityUnavailable {
                capability,
                state: CapabilityState::Unknown,
                ..
            } if capability == "vision"
        ));
    }

    #[test]
    fn supported_vision_passes_the_image_guard() {
        let snapshot = resolve_capabilities("api-claude", "claude-sonnet-4-5", None);
        assert_eq!(snapshot.vision.state(), CapabilityState::Supported);
        assert!(snapshot.require_image_input().is_ok());
    }

    #[test]
    fn supported_false_vision_is_refused() {
        let mut snapshot = resolve_capabilities("api-claude", "claude-sonnet-4-5", None);
        snapshot.vision = CapabilityKnowledge::supported(false, CapabilityProvenance::Static);
        assert!(matches!(
            snapshot.require_image_input(),
            Err(CapabilityError::AttachmentUnsupported { .. })
        ));
    }

    #[test]
    fn live_catalog_window_wins_over_the_static_table() {
        let live_entry = live("claude-sonnet-4-5", Some(1_000_000));
        let resolved = resolve_capabilities("anthropic", "claude-sonnet-4-5", Some(&live_entry));
        assert_eq!(resolved.context_window.value(), Some(&1_000_000));
        assert_eq!(
            resolved.context_window.provenance(),
            CapabilityProvenance::LiveCatalog
        );

        // Without a live entry the static fallback is used and labelled so.
        let static_only = resolve_capabilities("anthropic", "claude-sonnet-4-5", None);
        assert_eq!(static_only.context_window.value(), Some(&200_000));
        assert_eq!(
            static_only.context_window.provenance(),
            CapabilityProvenance::Static
        );

        // A live entry that is silent on the window also falls through to static.
        let silent = live("claude-sonnet-4-5", None);
        let from_silent = resolve_capabilities("anthropic", "claude-sonnet-4-5", Some(&silent));
        assert_eq!(from_silent.context_window.value(), Some(&200_000));
        assert_eq!(
            from_silent.context_window.provenance(),
            CapabilityProvenance::Static
        );
    }

    #[test]
    fn unknown_provider_leaves_context_window_unknown() {
        let resolved = resolve_capabilities("api-openrouter", "some/odd-model", None);
        assert_eq!(resolved.context_window.state(), CapabilityState::Unknown);
        assert_eq!(resolved.tools.state(), CapabilityState::Unknown);
        assert_eq!(resolved.structured_output.state(), CapabilityState::Unknown);
    }

    #[test]
    fn capability_snapshot_store_round_trips_and_detects_corruption() {
        let connection = open_at(&temp_db()).unwrap();
        let snapshot = resolve_capabilities(
            "anthropic",
            "claude-sonnet-4-5",
            Some(&live("claude-sonnet-4-5", Some(1_000_000))),
        );
        insert_capability_snapshot(&connection, "snap-1", &snapshot, 42).unwrap();
        let loaded = load_capability_snapshot(&connection, "snap-1").unwrap();
        assert_eq!(loaded, snapshot);

        // Corrupt the stored payload; the hash check refuses it and the row
        // stays in place.
        connection
            .execute(
                "UPDATE capability_snapshots SET payload = ?1 WHERE snapshot_id = ?2",
                params!["{\"broken\":", "snap-1"],
            )
            .unwrap();
        assert!(matches!(
            load_capability_snapshot(&connection, "snap-1"),
            Err(CapabilityError::Decode(_))
        ));
        let count: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM capability_snapshots WHERE snapshot_id = ?1",
                params!["snap-1"],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(count, 1);
    }
}
