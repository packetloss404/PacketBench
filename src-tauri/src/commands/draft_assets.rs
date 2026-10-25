//! Draft attachment asset service (F2B).
//!
//! Draft image bytes live in app-data (`<data_dir>/draft-assets`) so they can
//! survive an app restart, while the frontend persists only metadata refs in
//! its mirrored envelope. Bytes are keyed by a generated id — never by a
//! caller-supplied path — and validated (type prefix, size, base64, digest).
//! This is the durability half of draft handling: the in-memory F2A staging
//! remains the session-time read/write path, and typed image replay still
//! requires the runtime checkpoint work in 01-runtime.md.

use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use ts_rs::TS;
use uuid::Uuid;

use crate::core::storage;

/// Per-image cap, matching the frontend constant (`MAX_IMAGE_BYTES`).
const MAX_IMAGE_BYTES: usize = 5 * 1024 * 1024;
const ASSET_DIR: &str = "draft-assets";

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct StageDraftAssetInput {
    pub name: String,
    pub mime_type: String,
    pub data_base64: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct StagedDraftAssetDto {
    pub attachment_id: String,
    pub name: String,
    pub mime_type: String,
    pub byte_length: usize,
    pub sha256: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ReadDraftAssetDto {
    pub media_type: String,
    pub data_base64: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct DraftAssetMeta {
    pub attachment_id: String,
    pub name: String,
    pub mime_type: String,
    pub byte_length: usize,
    pub sha256: String,
    pub created_at_ms: u128,
}

fn now_ms() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0)
}

fn assets_dir() -> Result<PathBuf, String> {
    let dir = storage::data_dir().join(ASSET_DIR);
    fs::create_dir_all(&dir).map_err(|e| format!("Failed to create draft-assets dir: {e}"))?;
    Ok(dir)
}

fn validate_attachment_id(id: &str) -> Result<(), String> {
    if id.is_empty()
        || id.len() > 64
        || !id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
    {
        return Err("Invalid attachment id".into());
    }
    Ok(())
}

fn meta_path(dir: &Path, id: &str) -> PathBuf {
    dir.join(format!("{id}.meta.json"))
}

fn bin_path(dir: &Path, id: &str) -> PathBuf {
    dir.join(format!("{id}.bin"))
}

fn write_meta(dir: &Path, meta: &DraftAssetMeta) -> Result<(), String> {
    let json =
        serde_json::to_string(meta).map_err(|e| format!("Failed to serialize metadata: {e}"))?;
    fs::write(meta_path(dir, &meta.attachment_id), json)
        .map_err(|e| format!("Failed to write attachment metadata: {e}"))
}

/// Content sniffing for the image formats the composer accepts. The declared
/// MIME is only a hint; the stored type is derived from the bytes so a caller
/// cannot label arbitrary content as an image.
fn detect_image_mime(bytes: &[u8]) -> Option<&'static str> {
    if bytes.starts_with(&[0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A]) {
        return Some("image/png");
    }
    if bytes.starts_with(&[0xFF, 0xD8, 0xFF]) {
        return Some("image/jpeg");
    }
    if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        return Some("image/gif");
    }
    if bytes.len() >= 12 && &bytes[0..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        return Some("image/webp");
    }
    None
}

fn stage_in(dir: &Path, input: &StageDraftAssetInput) -> Result<StagedDraftAssetDto, String> {
    if !input.mime_type.starts_with("image/") {
        return Err("Only image attachments are supported".to_string());
    }
    let bytes = BASE64
        .decode(input.data_base64.as_bytes())
        .map_err(|e| format!("Image payload is not valid base64: {e}"))?;
    if bytes.is_empty() {
        return Err("Image payload is empty".to_string());
    }
    if bytes.len() > MAX_IMAGE_BYTES {
        return Err("Image must be 5 MiB or smaller".to_string());
    }
    let detected = detect_image_mime(&bytes)
        .ok_or_else(|| "Unsupported image content".to_string())?
        .to_string();

    let attachment_id = Uuid::new_v4().to_string();
    let sha256 = format!("{:x}", Sha256::digest(&bytes));
    let meta = DraftAssetMeta {
        attachment_id: attachment_id.clone(),
        name: input.name.clone(),
        mime_type: detected,
        byte_length: bytes.len(),
        sha256: sha256.clone(),
        created_at_ms: now_ms(),
    };
    // Metadata first; a partial write leaves a meta with no bytes, which read
    // treats as missing and gc collects.
    write_meta(dir, &meta)?;
    fs::write(bin_path(dir, &attachment_id), &bytes)
        .map_err(|e| format!("Failed to write attachment bytes: {e}"))?;
    Ok(StagedDraftAssetDto {
        attachment_id,
        name: meta.name,
        mime_type: meta.mime_type,
        byte_length: bytes.len(),
        sha256,
    })
}

fn read_in(dir: &Path, attachment_id: &str) -> Result<ReadDraftAssetDto, String> {
    validate_attachment_id(attachment_id)?;
    let meta: DraftAssetMeta = serde_json::from_str(
        &fs::read_to_string(meta_path(dir, attachment_id))
            .map_err(|_| "Attachment is missing".to_string())?,
    )
    .map_err(|e| format!("Attachment metadata is corrupt: {e}"))?;
    let bytes = fs::read(bin_path(dir, attachment_id))
        .map_err(|_| "Attachment bytes are missing".to_string())?;
    let digest = format!("{:x}", Sha256::digest(&bytes));
    if digest != meta.sha256 {
        return Err("Attachment bytes failed digest verification".to_string());
    }
    Ok(ReadDraftAssetDto {
        media_type: meta.mime_type,
        data_base64: BASE64.encode(&bytes),
    })
}

fn release_in(dir: &Path, attachment_id: &str) -> Result<(), String> {
    validate_attachment_id(attachment_id)?;
    let _ = fs::remove_file(bin_path(dir, attachment_id));
    let _ = fs::remove_file(meta_path(dir, attachment_id));
    Ok(())
}

/// Unreferenced draft assets younger than this are kept, so a crash in the
/// window between staging bytes and writing the v2 envelope is not mistaken for
/// an orphan.
const GC_GRACE_MS: u128 = 24 * 60 * 60 * 1000;
/// Aggregate cap on the whole draft-assets directory. Over it, the oldest
/// unreferenced assets are reclaimed even within the grace window.
const MAX_TOTAL_BYTES: u64 = 100 * 1024 * 1024;

fn read_created_at_ms(dir: &Path, id: &str) -> Option<u128> {
    let raw = fs::read_to_string(meta_path(dir, id)).ok()?;
    let meta: DraftAssetMeta = serde_json::from_str(&raw).ok()?;
    Some(meta.created_at_ms)
}

/// Remove an asset's bytes + metadata. Returns `true` only when the bytes were
/// actually removed, so the capacity pass's accounting is truthful.
fn remove_asset(dir: &Path, id: &str) -> bool {
    let bin_removed = fs::remove_file(bin_path(dir, id)).is_ok();
    let _ = fs::remove_file(meta_path(dir, id));
    bin_removed
}

fn gc_in(
    dir: &Path,
    keep: &HashSet<String>,
    now: u128,
    max_total_bytes: u64,
) -> Result<usize, String> {
    let mut total_bytes: u64 = 0;
    // (id, created_at, bytes) for every unreferenced asset whose age is known.
    let mut unreferenced: Vec<(String, u128, u64)> = Vec::new();
    for entry in fs::read_dir(dir).map_err(|e| format!("Failed to read draft-assets dir: {e}"))? {
        let entry = entry.map_err(|e| format!("Failed to read a draft-assets entry: {e}"))?;
        let file_name = entry.file_name().to_string_lossy().into_owned();
        if !file_name.ends_with(".bin") {
            continue;
        }
        let id = file_name.trim_end_matches(".bin").to_string();
        let bytes = entry.metadata().map(|meta| meta.len()).unwrap_or(0);
        total_bytes = total_bytes.saturating_add(bytes);
        if validate_attachment_id(&id).is_err() || keep.contains(&id) {
            continue;
        }
        // An unreadable metadata file means the age is unknown: keep it
        // conservatively rather than treating it as ancient (age 0).
        let Some(created) = read_created_at_ms(dir, &id) else {
            continue;
        };
        unreferenced.push((id, created, bytes));
    }
    // Oldest first, so the capacity pass reclaims the least-recently-staged.
    unreferenced.sort_by_key(|(_, created, _)| *created);

    let mut removed = 0usize;
    let mut over = total_bytes.saturating_sub(max_total_bytes);
    for (id, created, bytes) in &unreferenced {
        let past_grace = now.saturating_sub(*created) >= GC_GRACE_MS;
        let needed_for_capacity = over > 0;
        if !past_grace && !needed_for_capacity {
            continue;
        }
        if remove_asset(dir, id) {
            removed += 1;
            over = over.saturating_sub(*bytes);
        }
    }
    Ok(removed)
}

#[tauri::command]
pub async fn stage_agent_draft_asset(
    input: StageDraftAssetInput,
) -> Result<StagedDraftAssetDto, String> {
    // base64 decode + SHA-256 + up to 5 MiB write must not run on the Tauri
    // main thread (same freeze class as the statusline/analytics commands).
    tokio::task::spawn_blocking(move || {
        let dir = assets_dir()?;
        stage_in(&dir, &input)
    })
    .await
    .map_err(|e| format!("Draft asset staging task failed: {e}"))?
}

#[tauri::command]
pub async fn read_agent_draft_asset(attachment_id: String) -> Result<ReadDraftAssetDto, String> {
    tokio::task::spawn_blocking(move || {
        let dir = assets_dir()?;
        read_in(&dir, &attachment_id)
    })
    .await
    .map_err(|e| format!("Draft asset read task failed: {e}"))?
}

#[tauri::command]
pub async fn release_agent_draft_asset(attachment_id: String) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        let dir = assets_dir()?;
        release_in(&dir, &attachment_id)
    })
    .await
    .map_err(|e| format!("Draft asset release task failed: {e}"))?
}

#[tauri::command]
pub async fn gc_agent_draft_assets(keep: Vec<String>) -> Result<usize, String> {
    tokio::task::spawn_blocking(move || {
        let keep: HashSet<String> = keep.into_iter().collect();
        let dir = assets_dir()?;
        gc_in(&dir, &keep, now_ms(), MAX_TOTAL_BYTES)
    })
    .await
    .map_err(|e| format!("Draft asset gc task failed: {e}"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir() -> PathBuf {
        let id = Uuid::new_v4().to_string();
        std::env::temp_dir().join(format!("packetbench-draft-assets-test-{id}"))
    }

    fn png_base64(seed: u8) -> String {
        let mut bytes = vec![0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A];
        bytes.extend(std::iter::repeat(seed).take(56));
        BASE64.encode(bytes)
    }

    #[test]
    fn stages_reads_and_releases_round_trip() {
        let dir = temp_dir();
        fs::create_dir_all(&dir).unwrap();
        let input = StageDraftAssetInput {
            name: "shot.png".into(),
            mime_type: "image/png".into(),
            data_base64: png_base64(1),
        };
        let staged = stage_in(&dir, &input).unwrap();
        assert!(staged.attachment_id.len() > 0);
        assert_eq!(staged.byte_length, 64);
        assert_eq!(staged.sha256.len(), 64);

        let read = read_in(&dir, &staged.attachment_id).unwrap();
        assert_eq!(read.media_type, "image/png");
        assert_eq!(read.data_base64, input.data_base64);

        release_in(&dir, &staged.attachment_id).unwrap();
        assert!(read_in(&dir, &staged.attachment_id).is_err());
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn rejects_non_image_types_and_oversized_payloads() {
        let dir = temp_dir();
        fs::create_dir_all(&dir).unwrap();
        let too_large = BASE64.encode(vec![0u8; MAX_IMAGE_BYTES + 1]);
        let err = stage_in(
            &dir,
            &StageDraftAssetInput {
                name: "huge.png".into(),
                mime_type: "image/png".into(),
                data_base64: too_large,
            },
        )
        .unwrap_err();
        assert!(err.contains("5 MiB"));

        let err = stage_in(
            &dir,
            &StageDraftAssetInput {
                name: "notes.txt".into(),
                mime_type: "text/plain".into(),
                data_base64: png_base64(2),
            },
        )
        .unwrap_err();
        assert!(err.contains("Only image"));
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn rejects_content_that_is_not_a_known_image() {
        let dir = temp_dir();
        fs::create_dir_all(&dir).unwrap();
        let err = stage_in(
            &dir,
            &StageDraftAssetInput {
                name: "fake.png".into(),
                mime_type: "image/png".into(),
                data_base64: BASE64.encode(vec![0u8; 32]),
            },
        )
        .unwrap_err();
        assert!(err.contains("Unsupported image content"));
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn stores_the_detected_type_not_the_declared_one() {
        let dir = temp_dir();
        fs::create_dir_all(&dir).unwrap();
        let staged = stage_in(
            &dir,
            &StageDraftAssetInput {
                name: "mislabeled.jpg".into(),
                mime_type: "image/jpeg".into(),
                data_base64: png_base64(7),
            },
        )
        .unwrap();
        assert_eq!(staged.mime_type, "image/png");
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn detects_digest_mismatch_on_read() {
        let dir = temp_dir();
        fs::create_dir_all(&dir).unwrap();
        let staged = stage_in(
            &dir,
            &StageDraftAssetInput {
                name: "a.png".into(),
                mime_type: "image/png".into(),
                data_base64: png_base64(3),
            },
        )
        .unwrap();
        // Truncate the bytes behind the metadata's back.
        fs::write(bin_path(&dir, &staged.attachment_id), vec![9u8; 8]).unwrap();
        assert!(read_in(&dir, &staged.attachment_id)
            .unwrap_err()
            .contains("digest"));
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn gc_removes_only_unreferenced_assets() {
        let dir = temp_dir();
        fs::create_dir_all(&dir).unwrap();
        let a = stage_in(
            &dir,
            &StageDraftAssetInput {
                name: "a.png".into(),
                mime_type: "image/png".into(),
                data_base64: png_base64(4),
            },
        )
        .unwrap();
        let b = stage_in(
            &dir,
            &StageDraftAssetInput {
                name: "b.png".into(),
                mime_type: "image/png".into(),
                data_base64: png_base64(5),
            },
        )
        .unwrap();

        // Far-future `now` so the freshly-created assets are past the grace window.
        let removed = gc_in(
            &dir,
            &HashSet::from([a.attachment_id.clone()]),
            u128::MAX,
            MAX_TOTAL_BYTES,
        )
        .unwrap();
        assert_eq!(removed, 1);
        assert!(read_in(&dir, &a.attachment_id).is_ok());
        assert!(read_in(&dir, &b.attachment_id).is_err());
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn gc_keeps_a_recently_staged_unreferenced_asset_within_grace() {
        let dir = temp_dir();
        fs::create_dir_all(&dir).unwrap();
        let a = stage_in(
            &dir,
            &StageDraftAssetInput {
                name: "a.png".into(),
                mime_type: "image/png".into(),
                data_base64: png_base64(6),
            },
        )
        .unwrap();
        let created = read_created_at_ms(&dir, &a.attachment_id).unwrap();

        // Unreferenced but just staged: within the grace window -> kept.
        assert_eq!(
            gc_in(&dir, &HashSet::new(), created + 1_000, MAX_TOTAL_BYTES).unwrap(),
            0
        );
        assert!(read_in(&dir, &a.attachment_id).is_ok());
        // Past the grace window -> reclaimed.
        assert_eq!(
            gc_in(
                &dir,
                &HashSet::new(),
                created + GC_GRACE_MS + 1,
                MAX_TOTAL_BYTES
            )
            .unwrap(),
            1
        );
        assert!(read_in(&dir, &a.attachment_id).is_err());
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn gc_capacity_pass_reclaims_oldest_unreferenced_even_within_grace() {
        let dir = temp_dir();
        fs::create_dir_all(&dir).unwrap();
        let a = stage_in(
            &dir,
            &StageDraftAssetInput {
                name: "a.png".into(),
                mime_type: "image/png".into(),
                data_base64: png_base64(7),
            },
        )
        .unwrap();
        let b = stage_in(
            &dir,
            &StageDraftAssetInput {
                name: "b.png".into(),
                mime_type: "image/png".into(),
                data_base64: png_base64(8),
            },
        )
        .unwrap();
        // A tiny cap below the combined size, and a `now` within the grace window,
        // so only the capacity pass can reclaim.
        let cap = (a.byte_length + b.byte_length) as u64 - 1;
        let now = read_created_at_ms(&dir, &a.attachment_id).unwrap() + 1;
        let removed = gc_in(&dir, &HashSet::from([b.attachment_id.clone()]), now, cap).unwrap();
        assert_eq!(removed, 1);
        assert!(
            read_in(&dir, &a.attachment_id).is_err(),
            "the oldest unreferenced asset is reclaimed for capacity"
        );
        assert!(
            read_in(&dir, &b.attachment_id).is_ok(),
            "a referenced asset is never reclaimed"
        );
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn gc_keeps_an_asset_whose_metadata_is_unreadable() {
        let dir = temp_dir();
        fs::create_dir_all(&dir).unwrap();
        let a = stage_in(
            &dir,
            &StageDraftAssetInput {
                name: "a.png".into(),
                mime_type: "image/png".into(),
                data_base64: png_base64(9),
            },
        )
        .unwrap();
        // Unknown age (unreadable metadata) is kept conservatively, even with a
        // far-future `now` and no keep list.
        fs::remove_file(meta_path(&dir, &a.attachment_id)).unwrap();
        assert_eq!(
            gc_in(&dir, &HashSet::new(), u128::MAX, MAX_TOTAL_BYTES).unwrap(),
            0
        );
        fs::remove_dir_all(&dir).ok();
    }
}
