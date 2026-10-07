//! API key management for LLM providers using the OS credential store.

use crate::core::brand::{KEYRING_SERVICE, LEGACY_KEYRING_SERVICE};
use tracing::{info, warn};

/// Leading text of the "nothing is stored" error from [`load_api_key`].
///
/// Callers that must tell "the user has not connected this provider yet" apart
/// from "the credential store itself failed" match on this prefix rather than
/// re-walking the keyring (which would skip the legacy-service migration).
/// [`load_api_key`] interpolates this constant, so the two cannot drift.
pub const NO_API_KEY_PREFIX: &str = "No API key configured for";

const VALID_PROVIDERS: &[&str] = &[
    "anthropic",
    "openai",
    "minimax",
    "minimax-api",
    "openrouter",
    "ollama",
    "custom",
    "sugar",
    "cline-pass",
    "opencode-go",
    "ollama-cloud",
    "google",
    "xai",
];

fn validate_provider(provider: &str) -> Result<(), String> {
    if !VALID_PROVIDERS.contains(&provider) {
        return Err(format!(
            "Unknown provider '{}'. Valid: {}",
            provider,
            VALID_PROVIDERS.join(", ")
        ));
    }
    Ok(())
}

fn keyring_entry(provider: &str) -> Option<keyring::Entry> {
    match keyring::Entry::new(KEYRING_SERVICE, &format!("api-key-{}", provider)) {
        Ok(entry) => Some(entry),
        Err(e) => {
            warn!("Failed to create keyring entry for {}: {}", provider, e);
            None
        }
    }
}

/// Legacy keyring entry for one-shot migration from the old "packetcode" service.
fn legacy_keyring_entry(provider: &str) -> Option<keyring::Entry> {
    keyring::Entry::new(LEGACY_KEYRING_SERVICE, &format!("api-key-{}", provider)).ok()
}

fn migrate_legacy_api_key(
    provider: &str,
    key: String,
    write_new: impl FnOnce(&str) -> keyring::Result<()>,
    delete_legacy: impl FnOnce() -> keyring::Result<()>,
) -> Result<String, String> {
    if let Err(e) = write_new(&key) {
        warn!(
            provider = %provider,
            error = %e,
            "Failed to migrate API key from legacy keyring service; keeping legacy credential"
        );
        return Ok(key);
    }

    match delete_legacy() {
        Ok(()) | Err(keyring::Error::NoEntry) => {
            info!(provider = %provider, "Migrated API key from legacy keyring service");
        }
        Err(e) => {
            warn!(
                provider = %provider,
                error = %e,
                "Failed to delete legacy API key after migration"
            );
        }
    }

    Ok(key)
}

fn delete_api_key_credentials(
    provider: &str,
    delete_current: impl FnOnce() -> keyring::Result<()>,
    delete_legacy: impl FnOnce() -> keyring::Result<()>,
) -> Result<(), String> {
    let mut first_error: Option<keyring::Error> = None;

    for result in [delete_current(), delete_legacy()] {
        match result {
            Ok(()) | Err(keyring::Error::NoEntry) => {}
            Err(e) if first_error.is_none() => {
                first_error = Some(e);
            }
            Err(_) => {}
        }
    }

    if let Some(e) = first_error {
        return Err(format!("Failed to delete API key: {}", e));
    }

    info!(provider = %provider, "API key deleted");
    Ok(())
}

/// Interpret a keyring read without collapsing credential-store failures into
/// the same state as a genuinely absent credential.
fn keyring_lookup_exists(
    provider: &str,
    result: keyring::Result<String>,
) -> Result<Option<bool>, String> {
    match result {
        Ok(_) => Ok(Some(true)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(format!("Failed to check API key for {}: {}", provider, e)),
    }
}

/// Load an API key for a provider. Internal only — not exposed to frontend.
pub fn load_api_key(provider: &str) -> Result<String, String> {
    if provider == "ollama" {
        // Ollama doesn't need an API key
        return Ok(String::new());
    }

    let entry = keyring_entry(provider)
        .ok_or_else(|| format!("Credential store unavailable for {}", provider))?;

    match entry.get_password() {
        Ok(key) => {
            // Auth-path audit line: which provider's key was loaded, never the
            // value. `target` lets `RUST_LOG=packetbench::auth=info` isolate it.
            info!(target: "packetbench::auth", provider = %provider, outcome = "found", "API key loaded from keyring");
            Ok(key)
        }
        Err(keyring::Error::NoEntry) => {
            // Fall back to the legacy "packetcode" keyring service and migrate on success.
            if let Some(legacy) = legacy_keyring_entry(provider) {
                if let Ok(key) = legacy.get_password() {
                    info!(target: "packetbench::auth", provider = %provider, outcome = "legacy", "API key found under legacy keyring service");
                    return migrate_legacy_api_key(
                        provider,
                        key,
                        |key| entry.set_password(key),
                        || legacy.delete_credential(),
                    );
                }
            }
            // LM2: the custom OpenAI-compatible endpoint treats its key as
            // optional — many local/self-hosted servers require none. An
            // empty key makes `stream_chat_compat` skip the Authorization
            // header entirely.
            if provider == "custom" {
                return Ok(String::new());
            }
            info!(target: "packetbench::auth", provider = %provider, outcome = "missing", "no API key configured");
            Err(format!(
                "{} {}. Set one in Settings > API Keys.",
                NO_API_KEY_PREFIX, provider
            ))
        }
        Err(e) => {
            warn!(target: "packetbench::auth", provider = %provider, outcome = "store_error", error = %e, "credential store failed while reading an API key");
            Err(format!("Failed to read API key for {}: {}", provider, e))
        }
    }
}

#[tauri::command]
pub async fn set_api_key(provider: String, key: String) -> Result<(), String> {
    validate_provider(&provider)?;

    if provider == "ollama" {
        return Err("Ollama does not require an API key.".to_string());
    }

    if key.trim().is_empty() {
        return Err("API key cannot be empty.".to_string());
    }

    let entry =
        keyring_entry(&provider).ok_or_else(|| "Credential store unavailable".to_string())?;

    entry
        .set_password(key.trim())
        .map_err(|e| format!("Failed to store API key: {}", e))?;

    info!(provider = %provider, "API key stored");
    Ok(())
}

#[tauri::command]
pub async fn get_api_key_exists(provider: String) -> Result<bool, String> {
    validate_provider(&provider)?;

    if provider == "ollama" {
        return Ok(true); // Ollama doesn't need a key
    }

    let entry = match keyring_entry(&provider) {
        Some(e) => e,
        None => return Ok(false),
    };

    if let Some(exists) = keyring_lookup_exists(&provider, entry.get_password())? {
        return Ok(exists);
    }

    // Check legacy keyring service; don't migrate here (read-only path).
    if let Some(legacy) = legacy_keyring_entry(&provider) {
        if let Some(exists) = keyring_lookup_exists(&provider, legacy.get_password())? {
            return Ok(exists);
        }
    }

    Ok(false)
}

#[tauri::command]
pub async fn delete_api_key(provider: String) -> Result<(), String> {
    validate_provider(&provider)?;

    if provider == "ollama" {
        return Ok(());
    }

    let entry = keyring_entry(&provider);
    let legacy = legacy_keyring_entry(&provider);

    delete_api_key_credentials(
        &provider,
        || match entry {
            Some(entry) => entry.delete_credential(),
            None => Ok(()),
        },
        || match legacy {
            Some(legacy) => legacy.delete_credential(),
            None => Ok(()),
        },
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::Cell;

    #[test]
    fn legacy_api_key_migration_deletes_only_after_new_write_succeeds() {
        let write_completed = Cell::new(false);
        let delete_observed_write = Cell::new(false);

        let result = migrate_legacy_api_key(
            "openai",
            "sk-test".to_string(),
            |key| {
                assert_eq!(key, "sk-test");
                write_completed.set(true);
                Ok(())
            },
            || {
                delete_observed_write.set(write_completed.get());
                Ok(())
            },
        );

        assert_eq!(result.as_deref(), Ok("sk-test"));
        assert!(delete_observed_write.get());
    }

    #[test]
    fn legacy_api_key_migration_returns_legacy_when_new_write_fails() {
        let delete_called = Cell::new(false);

        let result = migrate_legacy_api_key(
            "openai",
            "sk-test".to_string(),
            |_| Err(keyring::Error::Invalid("password".into(), "denied".into())),
            || {
                delete_called.set(true);
                Ok(())
            },
        );

        assert_eq!(result.as_deref(), Ok("sk-test"));
        assert!(!delete_called.get());
    }

    #[test]
    fn delete_api_key_credentials_deletes_legacy_when_current_is_missing() {
        let legacy_deleted = Cell::new(false);

        let result = delete_api_key_credentials(
            "openai",
            || Err(keyring::Error::NoEntry),
            || {
                legacy_deleted.set(true);
                Ok(())
            },
        );

        assert!(result.is_ok());
        assert!(legacy_deleted.get());
    }

    #[test]
    fn keyring_lookup_distinguishes_missing_from_unavailable() {
        assert_eq!(
            keyring_lookup_exists("openai", Err(keyring::Error::NoEntry)),
            Ok(None)
        );

        let error = keyring_lookup_exists(
            "openai",
            Err(keyring::Error::Invalid(
                "credential".into(),
                "locked".into(),
            )),
        )
        .unwrap_err();
        assert!(error.contains("Failed to check API key for openai"));
        assert!(error.contains("locked"));
    }
}
