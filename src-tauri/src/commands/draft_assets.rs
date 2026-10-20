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
    let json = serde_json::to_string(meta).map_err(|e| format!("Failed to serialize metadata: {e}"))?;
    fs::write(meta_path(dir, &meta.attachment_id), json)
        .map_err(|e| format!("Failed to write attachment metadata: {e}"))
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

    let attachment_id = Uuid::new_v4().to_string();
    let sha256 = format!("{:x}", Sha256::digest(&bytes));
    let meta = DraftAssetMeta {
        attachment_id: attachment_id.clone(),
        name: input.name.clone(),
        mime_type: input.mime_type.clone(),
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

fn gc_in(dir: &Path, keep: &HashSet<String>) -> Result<usize, String> {
    let mut removed = 0usize;
    for entry in fs::read_dir(dir).map_err(|e| format!("Failed to read draft-assets dir: {e}"))? {
        let entry = entry.map_err(|e| format!("Failed to read a draft-assets entry: {e}"))?;
        let file_name = entry.file_name().to_string_lossy().into_owned();
        if !file_name.ends_with(".bin") {
            continue;
        }
        let id = file_name.trim_end_matches(".bin").to_string();
        if validate_attachment_id(&id).is_err() || keep.contains(&id) {
            continue;
        }
        let _ = fs::remove_file(entry.path());
        let _ = fs::remove_file(meta_path(dir, &id));
        removed += 1;
    }
    Ok(removed)
}

#[tauri::command]
pub fn stage_agent_draft_asset(input: StageDraftAssetInput) -> Result<StagedDraftAssetDto, String> {
    stage_in(&assets_dir()?, &input)
}

#[tauri::command]
pub fn read_agent_draft_asset(attachment_id: String) -> Result<ReadDraftAssetDto, String> {
    read_in(&assets_dir()?, &attachment_id)
}

#[tauri::command]
pub fn release_agent_draft_asset(attachment_id: String) -> Result<(), String> {
    release_in(&assets_dir()?, &attachment_id)
}

#[tauri::command]
pub fn gc_agent_draft_assets(keep: Vec<String>) -> Result<usize, String> {
    let keep: HashSet<String> = keep.into_iter().collect();
    gc_in(&assets_dir()?, &keep)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir() -> PathBuf {
        let id = Uuid::new_v4().to_string();
        std::env::temp_dir().join(format!("packetbench-draft-assets-test-{id}"))
    }

    fn base64_bytes(prefix: u8) -> String {
        BASE64.encode(vec![prefix; 64])
    }

    #[test]
    fn stages_reads_and_releases_round_trip() {
        let dir = temp_dir();
        fs::create_dir_all(&dir).unwrap();
        let input = StageDraftAssetInput {
            name: "shot.png".into(),
            mime_type: "image/png".into(),
            data_base64: base64_bytes(1),
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
                data_base64: base64_bytes(2),
            },
        )
        .unwrap_err();
        assert!(err.contains("Only image"));
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
                data_base64: base64_bytes(3),
            },
        )
        .unwrap();
        // Truncate the bytes behind the metadata's back.
        fs::write(bin_path(&dir, &staged.attachment_id), vec![9u8; 8]).unwrap();
        assert!(read_in(&dir, &staged.attachment_id).unwrap_err().contains("digest"));
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
                data_base64: base64_bytes(4),
            },
        )
        .unwrap();
        let b = stage_in(
            &dir,
            &StageDraftAssetInput {
                name: "b.png".into(),
                mime_type: "image/png".into(),
                data_base64: base64_bytes(5),
            },
        )
        .unwrap();

        let removed = gc_in(&dir, &HashSet::from([a.attachment_id.clone()])).unwrap();
        assert_eq!(removed, 1);
        assert!(read_in(&dir, &a.attachment_id).is_ok());
        assert!(read_in(&dir, &b.attachment_id).is_err());
        fs::remove_dir_all(&dir).ok();
    }
}
