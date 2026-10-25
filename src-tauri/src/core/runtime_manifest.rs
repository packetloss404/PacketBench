//! R4a run manifests (H6): a versioned, immutable, content-addressed record of
//! the inputs a run was prepared with.
//!
//! R4b wires this into the live loop: `run_turn` calls
//! `RuntimeServices::record_manifest` once per turn, and the Tauri host derives
//! the identity from the frozen session binding and inserts it here. The module
//! is pure apart from the small store helpers at the bottom that read/write the
//! `manifests` table created by [`super::runtime_journal`].
//!
//! A manifest is a **record, not a pointer to live settings**. It freezes the
//! harness hash, tool-policy hash, endpoint/model, repository revision, context
//! version and the parent/child request ids at prepare time, and is resolvable
//! by id afterwards even if the settings that produced it have since changed.
//! The content hash gives reproducible identity — the same inputs always hash the
//! same, and any changed field changes the hash. It is not evidence that an
//! outcome is correct.

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use super::runtime_types::validate_sha256_digest;

/// Manifest wire version. Bumped only for a breaking change to the persisted
/// shape; a newer manifest row is refused by the store, never downgraded.
pub const MANIFEST_SCHEMA_VERSION: i64 = 1;

/// Upper bound on the free-text identity fields. Keeps a hostile or accidental
/// giant value out of the database and the content hash.
const MAX_FIELD_LEN: usize = 512;

/// Named manifest failure. Callers branch on the variant rather than parse a
/// string.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ManifestError {
    InvalidField { field: String, reason: String },
    NewerSchema { found: i64, supported: i64 },
    Encode(String),
    Decode(String),
    Store(String),
}

impl std::fmt::Display for ManifestError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ManifestError::InvalidField { field, reason } => {
                write!(f, "Invalid manifest field \"{field}\": {reason}")
            }
            ManifestError::NewerSchema { found, supported } => write!(
                f,
                "Run manifest schema v{found} is newer than this build supports (v{supported})"
            ),
            ManifestError::Encode(message) => write!(f, "Failed to encode run manifest: {message}"),
            ManifestError::Decode(message) => write!(f, "Failed to decode run manifest: {message}"),
            ManifestError::Store(message) => write!(f, "Run manifest store error: {message}"),
        }
    }
}

impl std::error::Error for ManifestError {}

impl From<ManifestError> for String {
    fn from(error: ManifestError) -> Self {
        error.to_string()
    }
}

/// The immutable identity inputs of a run manifest. The content hash is computed
/// over exactly these fields (never over `created_at` or the derived id), so
/// identical inputs hash identically regardless of when the manifest was built.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ManifestIdentity {
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub parent_request_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub child_request_id: Option<String>,
    /// The endpoint the run was prepared against (e.g. `api.anthropic.com`).
    pub endpoint: String,
    /// The exact model id sent to the provider.
    pub model: String,
    /// `sha256:` digest of the harness/profile revision.
    pub harness_hash: String,
    /// `sha256:` digest of the effective tool policy.
    pub tool_policy_hash: String,
    /// Repository revision the run was prepared at.
    pub repository_revision: String,
    /// Context projection policy version.
    pub context_version: String,
}

fn validate_field(field: &str, value: &str) -> Result<(), ManifestError> {
    if value.trim().is_empty() {
        return Err(ManifestError::InvalidField {
            field: field.to_string(),
            reason: "must not be empty".to_string(),
        });
    }
    if value.len() > MAX_FIELD_LEN {
        return Err(ManifestError::InvalidField {
            field: field.to_string(),
            reason: format!("must be at most {MAX_FIELD_LEN} characters"),
        });
    }
    if value.chars().any(|c| c.is_control()) {
        return Err(ManifestError::InvalidField {
            field: field.to_string(),
            reason: "must not contain control characters".to_string(),
        });
    }
    Ok(())
}

impl ManifestIdentity {
    pub fn validate(&self) -> Result<(), ManifestError> {
        validate_sha256_digest(&self.harness_hash).map_err(|reason| {
            ManifestError::InvalidField {
                field: "harnessHash".to_string(),
                reason,
            }
        })?;
        validate_sha256_digest(&self.tool_policy_hash).map_err(|reason| {
            ManifestError::InvalidField {
                field: "toolPolicyHash".to_string(),
                reason,
            }
        })?;
        for (field, value) in [
            ("endpoint", &self.endpoint),
            ("model", &self.model),
            ("repositoryRevision", &self.repository_revision),
            ("contextVersion", &self.context_version),
        ] {
            validate_field(field, value)?;
        }
        if let Some(parent) = &self.parent_request_id {
            validate_field("parentRequestId", parent)?;
        }
        if let Some(child) = &self.child_request_id {
            validate_field("childRequestId", child)?;
        }
        Ok(())
    }
}

/// `sha256:<64 lower-case hex>` over the canonical serialization of the
/// identity. A struct serializes in declaration order, so the bytes are stable
/// across processes; any changed field changes the hash.
pub fn content_hash(identity: &ManifestIdentity) -> Result<String, ManifestError> {
    identity.validate()?;
    let canonical =
        serde_json::to_string(identity).map_err(|e| ManifestError::Encode(e.to_string()))?;
    Ok(format!("sha256:{:x}", Sha256::digest(canonical.as_bytes())))
}

/// The id derived from a content hash. Content-addressed, so identical inputs
/// always yield the same id.
pub fn manifest_id_for(content_hash: &str) -> String {
    let hex = content_hash.strip_prefix("sha256:").unwrap_or(content_hash);
    format!("run-manifest-{hex}")
}

/// A built, immutable run manifest.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunManifest {
    pub version: i64,
    pub manifest_id: String,
    pub content_hash: String,
    pub identity: ManifestIdentity,
    pub created_at: i64,
}

impl RunManifest {
    /// Build a manifest from its identity. The id and content hash are derived
    /// from the identity alone; `created_at` is recorded but never hashed.
    pub fn new(identity: ManifestIdentity, created_at: i64) -> Result<Self, ManifestError> {
        let content_hash = content_hash(&identity)?;
        let manifest_id = manifest_id_for(&content_hash);
        Ok(RunManifest {
            version: MANIFEST_SCHEMA_VERSION,
            manifest_id,
            content_hash,
            identity,
            created_at,
        })
    }
}

/// Insert a manifest. Addressed by `manifest_id` (derived from the content
/// hash), so re-inserting the same identity is idempotent and the first written
/// record is preserved.
pub fn insert_manifest(
    connection: &Connection,
    manifest: &RunManifest,
) -> Result<(), ManifestError> {
    if manifest.version > MANIFEST_SCHEMA_VERSION {
        return Err(ManifestError::NewerSchema {
            found: manifest.version,
            supported: MANIFEST_SCHEMA_VERSION,
        });
    }
    let payload =
        serde_json::to_string(manifest).map_err(|e| ManifestError::Encode(e.to_string()))?;
    connection
        .execute(
            "INSERT OR IGNORE INTO manifests (manifest_id, content_hash, payload, created_at) \
             VALUES (?1, ?2, ?3, ?4)",
            params![
                manifest.manifest_id,
                manifest.content_hash,
                payload,
                manifest.created_at
            ],
        )
        .map_err(|e| ManifestError::Store(e.to_string()))?;
    Ok(())
}

/// Load and verify a manifest by id. The stored payload is re-hashed and
/// compared against both the stored hash and the manifest's own hash; a
/// mismatch is a named error and the row is left untouched.
pub fn load_manifest(
    connection: &Connection,
    manifest_id: &str,
) -> Result<RunManifest, ManifestError> {
    let (payload, stored_hash): (String, String) = connection
        .query_row(
            "SELECT payload, content_hash FROM manifests WHERE manifest_id = ?1",
            params![manifest_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()
        .map_err(|e| ManifestError::Store(e.to_string()))?
        .ok_or_else(|| ManifestError::Store(format!("Unknown manifest: {manifest_id}")))?;
    let manifest: RunManifest =
        serde_json::from_str(&payload).map_err(|e| ManifestError::Decode(e.to_string()))?;
    if manifest.version > MANIFEST_SCHEMA_VERSION {
        return Err(ManifestError::NewerSchema {
            found: manifest.version,
            supported: MANIFEST_SCHEMA_VERSION,
        });
    }
    let computed = content_hash(&manifest.identity)?;
    if computed != stored_hash || computed != manifest.content_hash {
        return Err(ManifestError::Decode(format!(
            "manifest {manifest_id} content hash mismatch: stored {stored_hash}, computed {computed}"
        )));
    }
    Ok(manifest)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::runtime_journal::open_at;
    use std::path::PathBuf;
    use uuid::Uuid;

    fn temp_db() -> PathBuf {
        std::env::temp_dir()
            .join(format!("packetbench-manifest-test-{}", Uuid::new_v4()))
            .join("journal.db")
    }

    fn digest(n: u8) -> String {
        format!("sha256:{}", format!("{n:02x}").repeat(32))
    }

    fn identity() -> ManifestIdentity {
        ManifestIdentity {
            parent_request_id: Some("req-parent".to_string()),
            child_request_id: None,
            endpoint: "api.anthropic.com".to_string(),
            model: "claude-sonnet-4-5".to_string(),
            harness_hash: digest(1),
            tool_policy_hash: digest(2),
            repository_revision: "abc1234".to_string(),
            context_version: "ctx-v1".to_string(),
        }
    }

    #[test]
    fn content_hash_is_stable_for_identical_inputs() {
        let a = RunManifest::new(identity(), 1_000).unwrap();
        let b = RunManifest::new(identity(), 9_999).unwrap();
        // Same identity -> same hash and id even though the timestamps differ.
        assert_eq!(a.content_hash, b.content_hash);
        assert_eq!(a.manifest_id, b.manifest_id);
        assert_eq!(a.content_hash, content_hash(&identity()).unwrap());
    }

    #[test]
    fn content_hash_changes_when_any_field_changes() {
        let base = identity();
        let base_hash = content_hash(&base).unwrap();

        let mut parent = base.clone();
        parent.parent_request_id = Some("other-parent".to_string());
        let mut child = base.clone();
        child.child_request_id = Some("req-child".to_string());
        let mut endpoint = base.clone();
        endpoint.endpoint = "api.openai.com".to_string();
        let mut model = base.clone();
        model.model = "claude-opus-4-1".to_string();
        let mut harness = base.clone();
        harness.harness_hash = digest(7);
        let mut policy = base.clone();
        policy.tool_policy_hash = digest(8);
        let mut revision = base.clone();
        revision.repository_revision = "def5678".to_string();
        let mut context = base.clone();
        context.context_version = "ctx-v2".to_string();

        for (label, changed) in [
            ("parent", parent),
            ("child", child),
            ("endpoint", endpoint),
            ("model", model),
            ("harness", harness),
            ("policy", policy),
            ("revision", revision),
            ("context", context),
        ] {
            let changed_hash = content_hash(&changed).unwrap();
            assert_ne!(
                base_hash, changed_hash,
                "{label} change must alter the hash"
            );
        }
    }

    #[test]
    fn manifest_is_retrievable_by_id_after_a_settings_change() {
        let connection = open_at(&temp_db()).unwrap();
        let original = RunManifest::new(identity(), 1_000).unwrap();
        insert_manifest(&connection, &original).unwrap();

        // Simulate a settings edit: the live identity is now different, but the
        // stored manifest must still resolve to the values it was prepared with.
        let mut edited = identity();
        edited.model = "claude-opus-4-1".to_string();
        edited.tool_policy_hash = digest(9);
        let _ = RunManifest::new(edited, 2_000).unwrap();

        let loaded = load_manifest(&connection, &original.manifest_id).unwrap();
        assert_eq!(loaded, original);
        assert_eq!(loaded.identity.model, "claude-sonnet-4-5");
        assert_eq!(loaded.identity.tool_policy_hash, digest(2));
    }

    #[test]
    fn reinserting_the_same_identity_is_idempotent() {
        let connection = open_at(&temp_db()).unwrap();
        let first = RunManifest::new(identity(), 1_000).unwrap();
        let second = RunManifest::new(identity(), 5_000).unwrap();
        insert_manifest(&connection, &first).unwrap();
        insert_manifest(&connection, &second).unwrap();
        let count: i64 = connection
            .query_row("SELECT COUNT(*) FROM manifests", [], |row| row.get(0))
            .unwrap();
        assert_eq!(count, 1);
        // The first record wins; the later timestamp is not written.
        assert_eq!(
            load_manifest(&connection, &first.manifest_id).unwrap(),
            first
        );
    }

    #[test]
    fn manifest_identity_rejects_bad_hashes_and_empty_fields() {
        let mut bad_harness = identity();
        bad_harness.harness_hash = "not-a-digest".to_string();
        assert!(matches!(
            content_hash(&bad_harness),
            Err(ManifestError::InvalidField { field, .. }) if field == "harnessHash"
        ));

        let mut bad_policy = identity();
        bad_policy.tool_policy_hash = "sha256:XYZ".to_string();
        assert!(matches!(
            content_hash(&bad_policy),
            Err(ManifestError::InvalidField { field, .. }) if field == "toolPolicyHash"
        ));

        let mut empty_model = identity();
        empty_model.model = "   ".to_string();
        assert!(matches!(
            content_hash(&empty_model),
            Err(ManifestError::InvalidField { field, .. }) if field == "model"
        ));

        let mut control = identity();
        control.repository_revision = "abc\n123".to_string();
        assert!(matches!(
            content_hash(&control),
            Err(ManifestError::InvalidField { field, .. }) if field == "repositoryRevision"
        ));
    }

    #[test]
    fn corrupt_manifest_payload_is_refused_and_preserved() {
        let connection = open_at(&temp_db()).unwrap();
        let manifest = RunManifest::new(identity(), 1_000).unwrap();
        insert_manifest(&connection, &manifest).unwrap();

        connection
            .execute(
                "UPDATE manifests SET payload = ?1 WHERE manifest_id = ?2",
                params!["{\"broken\":", manifest.manifest_id],
            )
            .unwrap();
        assert!(matches!(
            load_manifest(&connection, &manifest.manifest_id),
            Err(ManifestError::Decode(_))
        ));
        let count: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM manifests WHERE manifest_id = ?1",
                params![manifest.manifest_id],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(count, 1);
    }

    #[test]
    fn newer_manifest_schema_is_refused_on_insert() {
        let connection = open_at(&temp_db()).unwrap();
        let mut manifest = RunManifest::new(identity(), 1_000).unwrap();
        manifest.version = MANIFEST_SCHEMA_VERSION + 1;
        assert!(matches!(
            insert_manifest(&connection, &manifest),
            Err(ManifestError::NewerSchema { .. })
        ));
    }
}
