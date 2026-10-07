use crate::commands::api_keys::get_api_key_exists;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

/// Unix timestamp (seconds since epoch) for "now", or 0 if the system clock
/// is misbehaving.
fn now_unix_secs() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/// Format a human-friendly relative expiry hint from an absolute Unix-seconds
/// expiry timestamp (e.g. `"Expires in 4 hours"`, `"Expires in 2 days"`,
/// `"Expired"`).
///
/// Buckets chosen to match what the UI actually wants to show in a small hint
/// chip — we don't need sub-hour precision, and beyond a few weeks users
/// don't care about the exact number.
fn format_relative_expiry(expires_at_unix_secs: i64) -> String {
    let now = now_unix_secs();
    let delta = expires_at_unix_secs - now;
    if delta <= 0 {
        return "Expired".to_string();
    }
    let mins = delta / 60;
    let hours = delta / 3600;
    let days = delta / 86_400;
    let weeks = delta / (86_400 * 7);

    if mins < 60 {
        if mins <= 1 {
            "Expires in 1 minute".to_string()
        } else {
            format!("Expires in {} minutes", mins)
        }
    } else if hours < 48 {
        if hours == 1 {
            "Expires in 1 hour".to_string()
        } else {
            format!("Expires in {} hours", hours)
        }
    } else if days < 14 {
        format!("Expires in {} days", days)
    } else {
        // days >= 14 so weeks >= 2
        format!("Expires in {} weeks", weeks)
    }
}

/// Turn a parsed expiry (Unix seconds) into a probe status.
///
/// - expired + refresh token available → `ready` with
///   "Session will auto-refresh on next use" (the Claude Agent SDK and
///   Codex CLI both refresh transparently when they receive an expired
///   access token alongside a valid refresh token — telling the user to
///   log in again when they don't need to would be a regression).
/// - expired + no refresh token → `login_required` with `run_again_hint`.
/// - within 72h → `ready` with "Expires in …" hint.
/// - further out → `ready` with empty hint.
///
/// We can't detect whether the refresh token itself has expired from the
/// credential file (it's opaque for Codex, and Claude doesn't surface
/// `refreshTokenExpiresAt`). If the refresh attempt fails on next use,
/// the SDK/CLI will surface its own error and the fs watcher will pick
/// up the credential-file change when the user re-logs in.
fn expiry_to_status(
    expires_at_unix_secs: i64,
    has_refresh_token: bool,
    run_again_hint: &str,
) -> ProviderAuthStatus {
    let now = now_unix_secs();
    let delta = expires_at_unix_secs - now;
    if delta <= 0 {
        if has_refresh_token {
            return ProviderAuthStatus {
                status: "ready".to_string(),
                hint: "Session will auto-refresh on next use".to_string(),
            };
        }
        return ProviderAuthStatus {
            status: "login_required".to_string(),
            hint: run_again_hint.to_string(),
        };
    }
    let within_72h = delta <= 72 * 3600;
    ProviderAuthStatus {
        status: "ready".to_string(),
        hint: if within_72h {
            format_relative_expiry(expires_at_unix_secs)
        } else {
            String::new()
        },
    }
}

/// Attempt to extract Claude OAuth expiry from a credentials file.
///
/// The Claude Code credentials file is JSON of the shape:
/// ```json
/// { "claudeAiOauth": { "expiresAt": 1777000000000, ... } }
/// ```
/// where `expiresAt` is Unix **milliseconds**.
///
/// Returns `None` if anything about the shape is unexpected — callers should
/// then fall back to the legacy "file exists = ready" behavior.
fn parse_claude_expiry_secs(bytes: &[u8]) -> Option<i64> {
    let v: serde_json::Value = serde_json::from_slice(bytes).ok()?;
    let millis = v
        .get("claudeAiOauth")
        .and_then(|o| o.get("expiresAt"))
        .and_then(|e| e.as_i64())?;
    Some(millis / 1000)
}

/// True if the Claude credentials file contains a non-empty
/// `claudeAiOauth.refreshToken`. The Claude Agent SDK will use this to
/// refresh an expired access token transparently.
fn parse_claude_has_refresh_token(bytes: &[u8]) -> bool {
    let v: serde_json::Value = match serde_json::from_slice(bytes) {
        Ok(v) => v,
        Err(_) => return false,
    };
    v.get("claudeAiOauth")
        .and_then(|o| o.get("refreshToken"))
        .and_then(|s| s.as_str())
        .map(|s| !s.is_empty())
        .unwrap_or(false)
}

/// Decode a base64url-encoded segment (no padding, `-`/`_` alphabet) into raw
/// bytes.
///
/// Used to peek at JWT payloads. Accepts the standard base64 alphabet too.
/// Returns `None` on any decoding error.
fn base64url_decode(input: &str) -> Option<Vec<u8>> {
    let bytes = input.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len() * 3 / 4 + 3);
    let mut buf: u32 = 0;
    let mut bits: u32 = 0;
    for &c in bytes {
        let val: u32 = match c {
            b'A'..=b'Z' => (c - b'A') as u32,
            b'a'..=b'z' => (c - b'a' + 26) as u32,
            b'0'..=b'9' => (c - b'0' + 52) as u32,
            b'-' | b'+' => 62,
            b'_' | b'/' => 63,
            b'=' => break,
            _ => return None,
        };
        buf = (buf << 6) | val;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((buf >> bits) as u8);
            buf &= (1 << bits) - 1;
        }
    }
    Some(out)
}

/// Attempt to extract Codex OAuth expiry from an `auth.json` file.
///
/// The Codex CLI stores OAuth tokens in JSON of the shape:
/// ```json
/// { "tokens": { "access_token": "<JWT>", ... }, "last_refresh": "…" }
/// ```
/// The `access_token` is a JWT whose payload carries an `exp` claim in Unix
/// **seconds**. `last_refresh` is RFC3339 but reflects the refresh time, not
/// expiry — so we parse the JWT payload instead.
///
/// Returns `None` if the shape or JWT can't be parsed — callers fall back to
/// the legacy "file exists = ready" behavior.
fn parse_codex_expiry_secs(bytes: &[u8]) -> Option<i64> {
    let v: serde_json::Value = serde_json::from_slice(bytes).ok()?;
    let token = v
        .get("tokens")
        .and_then(|t| t.get("access_token"))
        .and_then(|s| s.as_str())?;
    let payload_b64 = token.split('.').nth(1)?;
    let payload_bytes = base64url_decode(payload_b64)?;
    let payload: serde_json::Value = serde_json::from_slice(&payload_bytes).ok()?;
    payload.get("exp").and_then(|e| e.as_i64())
}

/// True if the Codex auth file contains a non-empty
/// `tokens.refresh_token`. The Codex CLI will use this to refresh an
/// expired access token on its next run.
fn parse_codex_has_refresh_token(bytes: &[u8]) -> bool {
    let v: serde_json::Value = match serde_json::from_slice(bytes) {
        Ok(v) => v,
        Err(_) => return false,
    };
    v.get("tokens")
        .and_then(|t| t.get("refresh_token"))
        .and_then(|s| s.as_str())
        .map(|s| !s.is_empty())
        .unwrap_or(false)
}

/// The credential files Claude Code may write inside its state root.
///
/// `root` is the equivalent of `~/.claude` — for a multi-account launch it is
/// whatever `CLAUDE_CONFIG_DIR` points at, because that env var relocates the
/// **whole** state root (credentials included) rather than just the config.
fn claude_credential_candidates(root: &Path) -> [PathBuf; 2] {
    [root.join("credentials"), root.join(".credentials.json")]
}

/// The credential files Codex may write inside its state root (`CODEX_HOME`,
/// default `~/.codex`).
fn codex_credential_candidates(root: &Path) -> [PathBuf; 2] {
    [root.join("auth.json"), root.join("credentials")]
}

/// Shared file-probe loop behind every OAuth-CLI status check.
///
/// Extracted verbatim from the original `probe_claude_oauth` /
/// `probe_codex_oauth` bodies (which were byte-for-byte identical apart from
/// their candidate paths and hint strings) so the ambient `~/.claude` probe and
/// the per-account `CLAUDE_CONFIG_DIR` probe cannot drift apart. The expiry and
/// refresh-token parsing is passed in as the *existing* helpers, unchanged.
///
/// `missing` is the status returned when none of the candidate paths exist at
/// all. It's a parameter rather than a constant because the honest answer
/// differs between the ambient case and a per-account config dir on macOS —
/// see [`claude_config_dir_missing_status`].
fn probe_oauth_credentials(
    candidates: &[PathBuf],
    parse_expiry: fn(&[u8]) -> Option<i64>,
    parse_has_refresh_token: fn(&[u8]) -> bool,
    expired_hint: &str,
    unreadable_hint: &str,
    missing: ProviderAuthStatus,
) -> ProviderAuthStatus {
    let unreadable = || ProviderAuthStatus {
        status: "login_required".to_string(),
        hint: unreadable_hint.to_string(),
    };
    let mut any_found = false;
    for path in candidates {
        match std::fs::metadata(path) {
            Ok(meta) if meta.is_file() => {
                any_found = true;
                if meta.len() == 0 {
                    continue;
                }
                // Try to parse + extract expiry. Fall back to "ready" with
                // empty hint if anything about the format is unexpected —
                // we don't want a credentials-format change to brick the
                // status indicator.
                match std::fs::read(path) {
                    Ok(bytes) => {
                        if let Some(exp_secs) = parse_expiry(&bytes) {
                            return expiry_to_status(
                                exp_secs,
                                parse_has_refresh_token(&bytes),
                                expired_hint,
                            );
                        }
                        return ProviderAuthStatus {
                            status: "ready".to_string(),
                            hint: String::new(),
                        };
                    }
                    Err(_) => return unreadable(),
                }
            }
            Ok(_) => {
                // Exists but isn't a regular file — treat as unreadable.
                any_found = true;
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(_) => return unreadable(),
        }
    }
    if any_found {
        // Found but empty / not a regular file.
        unreadable()
    } else {
        missing
    }
}

const CLAUDE_EXPIRED_HINT: &str = "Token expired — run `claude login` again";
const CLAUDE_UNREADABLE_HINT: &str = "Claude credentials unreadable";
const CLAUDE_LOGIN_HINT: &str = "Run `claude login` in a terminal";
const CODEX_EXPIRED_HINT: &str = "Token expired — run `codex login` again";
const CODEX_UNREADABLE_HINT: &str = "Codex credentials unreadable";
const CODEX_LOGIN_HINT: &str = "Run `codex login` in a terminal";

/// What to report when a **per-account** Claude config dir contains no
/// credential file at all.
///
/// On Linux/Windows, Claude Code always writes `.credentials.json` inside its
/// state root, so "no file" genuinely means "not logged in".
///
/// On macOS it does not: credentials go to the login Keychain instead, and
/// whether that Keychain item is namespaced per `CLAUDE_CONFIG_DIR` is
/// *unconfirmed* (binary analysis suggests a `sha256(configDir)` suffix;
/// anthropics/claude-code#20553 says otherwise). We deliberately do **not**
/// read the Keychain here — a probe that guesses at an unverified namespacing
/// scheme would be worse than one that admits it doesn't know. So macOS gets
/// an explicit `unknown`: callers must treat it as "may well be logged in"
/// (i.e. still launchable) rather than as a negative result.
///
/// The ambient (`~/.claude`) probe keeps returning `login_required` here so
/// that existing badges/consumers of the zero-arg command see byte-identical
/// behaviour; only the new per-dir command can surface `unknown`.
#[cfg(target_os = "macos")]
fn claude_config_dir_missing_status() -> ProviderAuthStatus {
    ProviderAuthStatus {
        status: "unknown".to_string(),
        hint: "No credential file in this config dir — macOS stores Claude credentials in the Keychain, which we can't attribute to an account".to_string(),
    }
}

#[cfg(not(target_os = "macos"))]
fn claude_config_dir_missing_status() -> ProviderAuthStatus {
    ProviderAuthStatus {
        status: "login_required".to_string(),
        hint: "Run `claude login` with CLAUDE_CONFIG_DIR set to this account".to_string(),
    }
}

/// Probe a specific Claude Code state root (`CLAUDE_CONFIG_DIR`).
pub(crate) fn probe_claude_oauth_in_dir(root: &Path) -> ProviderAuthStatus {
    probe_oauth_credentials(
        &claude_credential_candidates(root),
        parse_claude_expiry_secs,
        parse_claude_has_refresh_token,
        CLAUDE_EXPIRED_HINT,
        CLAUDE_UNREADABLE_HINT,
        claude_config_dir_missing_status(),
    )
}

/// Probe a specific Codex state root (`CODEX_HOME`).
///
/// Unlike Claude, Codex writes `auth.json` on disk on every platform (and its
/// `CODEX_HOME` relocation is confirmed to carry the credentials with it), so
/// "no file" is an honest `login_required` everywhere.
pub(crate) fn probe_codex_oauth_in_dir(root: &Path) -> ProviderAuthStatus {
    probe_oauth_credentials(
        &codex_credential_candidates(root),
        parse_codex_expiry_secs,
        parse_codex_has_refresh_token,
        CODEX_EXPIRED_HINT,
        CODEX_UNREADABLE_HINT,
        ProviderAuthStatus {
            status: "login_required".to_string(),
            hint: "Run `codex login` with CODEX_HOME set to this account".to_string(),
        },
    )
}

/// Probe whether the user has logged into Claude Code (`claude login`) with the
/// **ambient** default config dir (`~/.claude`).
///
/// Claude Code stores OAuth credentials in `~/.claude/credentials` on some
/// platforms/versions and `~/.claude/.credentials.json` on others, so we
/// check both paths. If the file parses as JSON and has a usable
/// `claudeAiOauth.expiresAt` field, we surface expiry information; otherwise
/// we fall back to the legacy "non-empty file = ready" behavior.
pub(crate) fn probe_claude_oauth() -> ProviderAuthStatus {
    let home = match dirs::home_dir() {
        Some(h) => h,
        None => {
            return ProviderAuthStatus {
                status: "login_required".to_string(),
                hint: CLAUDE_LOGIN_HINT.to_string(),
            };
        }
    };
    probe_oauth_credentials(
        &claude_credential_candidates(&home.join(".claude")),
        parse_claude_expiry_secs,
        parse_claude_has_refresh_token,
        CLAUDE_EXPIRED_HINT,
        CLAUDE_UNREADABLE_HINT,
        ProviderAuthStatus {
            status: "login_required".to_string(),
            hint: CLAUDE_LOGIN_HINT.to_string(),
        },
    )
}

/// Probe whether the user has logged into Codex CLI (`codex login` /
/// `codex auth login`) with the **ambient** default `~/.codex`.
///
/// Codex stores OAuth credentials under `~/.codex/` — depending on CLI
/// version, the token file may be `auth.json` or `credentials`, so we
/// check both paths. When `auth.json` is present we parse its JWT
/// `access_token` to surface expiry; otherwise we fall back to the legacy
/// "non-empty file = ready" behavior.
pub(crate) fn probe_codex_oauth() -> ProviderAuthStatus {
    let home = match dirs::home_dir() {
        Some(h) => h,
        None => {
            return ProviderAuthStatus {
                status: "login_required".to_string(),
                hint: CODEX_LOGIN_HINT.to_string(),
            };
        }
    };
    probe_oauth_credentials(
        &codex_credential_candidates(&home.join(".codex")),
        parse_codex_expiry_secs,
        parse_codex_has_refresh_token,
        CODEX_EXPIRED_HINT,
        CODEX_UNREADABLE_HINT,
        ProviderAuthStatus {
            status: "login_required".to_string(),
            hint: CODEX_LOGIN_HINT.to_string(),
        },
    )
}

#[derive(serde::Serialize, Clone, Debug)]
pub struct ProviderAuthStatus {
    pub status: String,
    pub hint: String,
}

/// Sign out of a subscription OAuth provider by deleting its credential
/// file(s). The auth watcher will pick up the change and emit
/// `provider-auth:changed` so the UI badges update without a refresh.
///
/// Supported providers: `claude-oauth`, `openai-codex`. Any other value is
/// an error — API-key providers use `delete_api_key` instead.
///
/// Missing files are treated as success (already signed out). Returns the
/// number of files actually removed.
#[tauri::command]
pub async fn sign_out_provider(provider: String) -> Result<u32, String> {
    let home = dirs::home_dir().ok_or_else(|| "Could not resolve home directory".to_string())?;
    let candidates: Vec<std::path::PathBuf> = match provider.as_str() {
        "claude-oauth" => vec![
            home.join(".claude").join("credentials"),
            home.join(".claude").join(".credentials.json"),
        ],
        "openai-codex" => vec![
            home.join(".codex").join("auth.json"),
            home.join(".codex").join("credentials"),
        ],
        other => return Err(format!("sign_out_provider does not support '{}'", other)),
    };
    let mut removed: u32 = 0;
    for path in &candidates {
        match std::fs::remove_file(path) {
            Ok(_) => removed += 1,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => {
                return Err(format!("Failed to remove {}: {}", path.display(), e));
            }
        }
    }
    Ok(removed)
}

#[tauri::command]
pub async fn get_provider_auth_status(provider: String) -> Result<ProviderAuthStatus, String> {
    match provider.as_str() {
        "anthropic" | "openai" | "openai-agents" | "minimax" | "minimax-api" | "openrouter"
        | "sugar" | "cline-pass" | "opencode-go" | "ollama-cloud" | "google" | "xai" => {
            let key_provider = if provider == "openai-agents" {
                "openai".to_string()
            } else {
                provider.clone()
            };
            let exists = get_api_key_exists(key_provider.clone()).await?;
            if exists {
                Ok(ProviderAuthStatus {
                    status: "ready".to_string(),
                    hint: String::new(),
                })
            } else {
                let label = match provider.as_str() {
                    "anthropic" => "Anthropic",
                    "openai" | "openai-agents" => "OpenAI",
                    "minimax" => "MiniMax (Token Plan)",
                    "minimax-api" => "MiniMax (API)",
                    "openrouter" => "OpenRouter",
                    _ => &provider,
                };
                Ok(ProviderAuthStatus {
                    status: "missing_key".to_string(),
                    hint: format!("Add your {} API key in Tools → API Keys", label),
                })
            }
        }
        "ollama" => {
            let base_url = crate::commands::ollama::resolve_base_url();
            let url = format!("{}/api/tags", base_url);
            let client = reqwest::Client::builder()
                .timeout(Duration::from_millis(500))
                .build()
                .map_err(|e| format!("Failed to build HTTP client: {}", e))?;
            match client.get(&url).send().await {
                Ok(resp) if resp.status().is_success() => Ok(ProviderAuthStatus {
                    status: "ready".to_string(),
                    hint: String::new(),
                }),
                _ => Ok(ProviderAuthStatus {
                    status: "service_down".to_string(),
                    hint: format!("Ollama not reachable at {}", base_url),
                }),
            }
        }
        // LM2 — custom OpenAI-compatible endpoint. "Configured" means a base
        // URL exists; the API key is optional and only upgrades the hint.
        "custom" => match crate::core::storage::resolve_custom_compat_base_url() {
            None => Ok(ProviderAuthStatus {
                status: "missing_key".to_string(),
                hint: format!(
                    "{}.",
                    crate::core::llm_custom_compat::CUSTOM_ENDPOINT_UNSET_HINT
                ),
            }),
            Some(base_url) => {
                let has_key = get_api_key_exists("custom".to_string())
                    .await
                    .unwrap_or(false);
                let hint = if has_key {
                    format!("{} — sending the saved API key", base_url)
                } else {
                    format!("{} — key optional, sent if configured", base_url)
                };
                Ok(ProviderAuthStatus {
                    status: "ready".to_string(),
                    hint,
                })
            }
        },
        "claude-oauth" => Ok(probe_claude_oauth()),
        "openai-codex" => Ok(probe_codex_oauth()),
        other => Err(format!("Unknown provider '{}'", other)),
    }
}

/// Per-account sibling of [`get_provider_auth_status`].
///
/// Multi-account CLI support relocates a CLI's entire state root via env var
/// (`CLAUDE_CONFIG_DIR` for claude-code, `CODEX_HOME` for codex), so a status
/// probe for a given account is the same probe pointed at that account's
/// `configDir`.
///
/// An empty/whitespace `config_dir` means "no account selected" and delegates
/// to the ambient zero-arg probe, so callers can pass the selected account's
/// dir (or `""`) unconditionally and always get the right answer — including
/// for the API-key providers, which have no per-dir notion at all.
///
/// A non-empty dir is only meaningful for the two OAuth CLIs; anything else is
/// a caller bug and errors loudly rather than silently ignoring the dir.
///
/// macOS caveat: see [`claude_config_dir_missing_status`] — a claude account
/// dir with no credential file on macOS returns `unknown`, not
/// `login_required`, because the credentials may be Keychain-resident.
/// Treat `unknown` as launchable.
#[tauri::command]
pub async fn get_provider_auth_status_for_dir(
    provider: String,
    config_dir: String,
) -> Result<ProviderAuthStatus, String> {
    let trimmed = config_dir.trim();
    if trimmed.is_empty() {
        return get_provider_auth_status(provider).await;
    }
    let root = Path::new(trimmed);
    match provider.as_str() {
        "claude-oauth" => Ok(probe_claude_oauth_in_dir(root)),
        "openai-codex" => Ok(probe_codex_oauth_in_dir(root)),
        other => Err(format!(
            "get_provider_auth_status_for_dir does not support '{}' — per-account config dirs apply to claude-oauth and openai-codex only",
            other
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn encode_base64url(bytes: &[u8]) -> String {
        // Minimal base64url encoder (no padding). Mirrors the decoder.
        const ALPHABET: &[u8; 64] =
            b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
        let mut out = String::with_capacity((bytes.len() * 4 + 2) / 3);
        let mut buf: u32 = 0;
        let mut bits: u32 = 0;
        for &b in bytes {
            buf = (buf << 8) | b as u32;
            bits += 8;
            while bits >= 6 {
                bits -= 6;
                let idx = (buf >> bits) & 0x3F;
                out.push(ALPHABET[idx as usize] as char);
                buf &= (1 << bits) - 1;
            }
        }
        if bits > 0 {
            let idx = (buf << (6 - bits)) & 0x3F;
            out.push(ALPHABET[idx as usize] as char);
        }
        out
    }

    #[test]
    fn base64url_roundtrip_small_payloads() {
        for raw in ["", "hi", "hello", "{\"exp\":1234567890}"].iter() {
            let enc = encode_base64url(raw.as_bytes());
            let dec = base64url_decode(&enc).expect("should decode");
            assert_eq!(dec, raw.as_bytes());
        }
    }

    #[test]
    fn format_relative_expiry_past_is_expired() {
        let past = now_unix_secs() - 3600;
        assert_eq!(format_relative_expiry(past), "Expired");
    }

    #[test]
    fn format_relative_expiry_minutes() {
        let soon = now_unix_secs() + 30 * 60;
        let s = format_relative_expiry(soon);
        assert!(s.contains("minutes"), "got: {}", s);
    }

    #[test]
    fn format_relative_expiry_hours() {
        let soon = now_unix_secs() + 4 * 3600;
        let s = format_relative_expiry(soon);
        assert!(s.contains("hours"), "got: {}", s);
    }

    #[test]
    fn format_relative_expiry_days() {
        let soon = now_unix_secs() + 3 * 86_400;
        let s = format_relative_expiry(soon);
        assert!(s.contains("days"), "got: {}", s);
    }

    #[test]
    fn format_relative_expiry_weeks() {
        let soon = now_unix_secs() + 30 * 86_400;
        let s = format_relative_expiry(soon);
        assert!(s.contains("weeks"), "got: {}", s);
    }

    #[test]
    fn expiry_to_status_past_without_refresh_token_is_login_required() {
        let past = now_unix_secs() - 10;
        let s = expiry_to_status(past, false, "run again");
        assert_eq!(s.status, "login_required");
        assert_eq!(s.hint, "run again");
    }

    #[test]
    fn expiry_to_status_past_with_refresh_token_is_ready_with_refresh_hint() {
        let past = now_unix_secs() - 10;
        let s = expiry_to_status(past, true, "run again");
        assert_eq!(s.status, "ready");
        assert_eq!(s.hint, "Session will auto-refresh on next use");
    }

    #[test]
    fn expiry_to_status_soon_is_ready_with_hint() {
        let soon = now_unix_secs() + 2 * 3600; // within 72h
        let s = expiry_to_status(soon, false, "run again");
        assert_eq!(s.status, "ready");
        assert!(!s.hint.is_empty());
    }

    #[test]
    fn expiry_to_status_far_out_is_ready_no_hint() {
        let far = now_unix_secs() + 30 * 86_400;
        let s = expiry_to_status(far, false, "run again");
        assert_eq!(s.status, "ready");
        assert_eq!(s.hint, "");
    }

    #[test]
    fn parse_claude_has_refresh_token_true_when_present() {
        let json = r#"{"claudeAiOauth":{"expiresAt":1,"refreshToken":"abc"}}"#;
        assert!(parse_claude_has_refresh_token(json.as_bytes()));
    }

    #[test]
    fn parse_claude_has_refresh_token_false_when_missing() {
        let json = r#"{"claudeAiOauth":{"expiresAt":1}}"#;
        assert!(!parse_claude_has_refresh_token(json.as_bytes()));
    }

    #[test]
    fn parse_claude_has_refresh_token_false_when_empty_string() {
        let json = r#"{"claudeAiOauth":{"refreshToken":""}}"#;
        assert!(!parse_claude_has_refresh_token(json.as_bytes()));
    }

    #[test]
    fn parse_claude_has_refresh_token_false_when_invalid_json() {
        assert!(!parse_claude_has_refresh_token(b"not json"));
    }

    #[test]
    fn parse_codex_has_refresh_token_true_when_present() {
        let json = r#"{"tokens":{"access_token":"x.y.z","refresh_token":"opaque"}}"#;
        assert!(parse_codex_has_refresh_token(json.as_bytes()));
    }

    #[test]
    fn parse_codex_has_refresh_token_false_when_missing() {
        let json = r#"{"tokens":{"access_token":"x.y.z"}}"#;
        assert!(!parse_codex_has_refresh_token(json.as_bytes()));
    }

    #[test]
    fn parse_codex_has_refresh_token_false_when_empty_string() {
        let json = r#"{"tokens":{"refresh_token":""}}"#;
        assert!(!parse_codex_has_refresh_token(json.as_bytes()));
    }

    #[test]
    fn parse_codex_has_refresh_token_false_when_invalid_json() {
        assert!(!parse_codex_has_refresh_token(b"garbage"));
    }

    #[test]
    fn parse_claude_expiry_extracts_millis() {
        let future_millis: i64 = (now_unix_secs() + 3600) * 1000;
        let json = format!(
            r#"{{"claudeAiOauth":{{"expiresAt":{},"accessToken":"x"}}}}"#,
            future_millis
        );
        let exp = parse_claude_expiry_secs(json.as_bytes()).expect("should parse");
        assert_eq!(exp, future_millis / 1000);
    }

    #[test]
    fn parse_claude_expiry_missing_field_returns_none() {
        let json = r#"{"claudeAiOauth":{"accessToken":"x"}}"#;
        assert!(parse_claude_expiry_secs(json.as_bytes()).is_none());
    }

    #[test]
    fn parse_claude_expiry_wrong_shape_returns_none() {
        let json = r#"{"not_what_we_expect":42}"#;
        assert!(parse_claude_expiry_secs(json.as_bytes()).is_none());
    }

    #[test]
    fn parse_claude_expiry_invalid_json_returns_none() {
        assert!(parse_claude_expiry_secs(b"not json at all").is_none());
    }

    #[test]
    fn parse_codex_expiry_extracts_jwt_exp() {
        let exp_secs: i64 = now_unix_secs() + 3600;
        let header = encode_base64url(br#"{"alg":"none","typ":"JWT"}"#);
        let payload_json = format!(r#"{{"exp":{},"sub":"x"}}"#, exp_secs);
        let payload = encode_base64url(payload_json.as_bytes());
        let sig = encode_base64url(b"sig");
        let jwt = format!("{}.{}.{}", header, payload, sig);
        let auth_json = format!(
            r#"{{"tokens":{{"access_token":"{}","id_token":"x","refresh_token":"y"}}}}"#,
            jwt
        );
        let exp = parse_codex_expiry_secs(auth_json.as_bytes()).expect("should parse");
        assert_eq!(exp, exp_secs);
    }

    #[test]
    fn parse_codex_expiry_missing_tokens_returns_none() {
        let json = r#"{"auth_mode":"ChatGPT"}"#;
        assert!(parse_codex_expiry_secs(json.as_bytes()).is_none());
    }

    #[test]
    fn parse_codex_expiry_non_jwt_access_token_returns_none() {
        let json = r#"{"tokens":{"access_token":"not-a-jwt"}}"#;
        assert!(parse_codex_expiry_secs(json.as_bytes()).is_none());
    }

    #[test]
    fn parse_codex_expiry_invalid_json_returns_none() {
        assert!(parse_codex_expiry_secs(b"garbage").is_none());
    }

    // ----------------------------------------------------------------
    // Per-account (parameterised config dir) probes.
    //
    // These use real temp dirs with fixture credential files so they
    // exercise the same filesystem path the ambient probes take, without
    // touching the developer's real `~/.claude` / `~/.codex`.
    // ----------------------------------------------------------------

    fn claude_creds_json(expires_in_secs: i64, refresh_token: Option<&str>) -> String {
        let millis = (now_unix_secs() + expires_in_secs) * 1000;
        match refresh_token {
            Some(rt) => format!(
                r#"{{"claudeAiOauth":{{"expiresAt":{},"accessToken":"at","refreshToken":"{}"}}}}"#,
                millis, rt
            ),
            None => format!(
                r#"{{"claudeAiOauth":{{"expiresAt":{},"accessToken":"at"}}}}"#,
                millis
            ),
        }
    }

    fn codex_auth_json(expires_in_secs: i64, refresh_token: Option<&str>) -> String {
        let exp = now_unix_secs() + expires_in_secs;
        let header = encode_base64url(br#"{"alg":"none","typ":"JWT"}"#);
        let payload = encode_base64url(format!(r#"{{"exp":{}}}"#, exp).as_bytes());
        let sig = encode_base64url(b"sig");
        let jwt = format!("{}.{}.{}", header, payload, sig);
        match refresh_token {
            Some(rt) => format!(
                r#"{{"tokens":{{"access_token":"{}","refresh_token":"{}"}}}}"#,
                jwt, rt
            ),
            None => format!(r#"{{"tokens":{{"access_token":"{}"}}}}"#, jwt),
        }
    }

    #[test]
    fn probe_claude_in_dir_ready_for_valid_credentials() {
        let dir = tempfile::tempdir().expect("tempdir");
        std::fs::write(
            dir.path().join(".credentials.json"),
            claude_creds_json(30 * 86_400, Some("rt")),
        )
        .expect("write");
        let s = probe_claude_oauth_in_dir(dir.path());
        assert_eq!(s.status, "ready", "hint: {}", s.hint);
        assert_eq!(s.hint, "");
    }

    #[test]
    fn probe_claude_in_dir_expired_without_refresh_is_login_required() {
        let dir = tempfile::tempdir().expect("tempdir");
        std::fs::write(
            dir.path().join(".credentials.json"),
            claude_creds_json(-3600, None),
        )
        .expect("write");
        let s = probe_claude_oauth_in_dir(dir.path());
        assert_eq!(s.status, "login_required");
        assert_eq!(s.hint, CLAUDE_EXPIRED_HINT);
    }

    #[test]
    fn probe_claude_in_dir_expired_with_refresh_is_ready() {
        let dir = tempfile::tempdir().expect("tempdir");
        std::fs::write(
            dir.path().join(".credentials.json"),
            claude_creds_json(-3600, Some("rt")),
        )
        .expect("write");
        let s = probe_claude_oauth_in_dir(dir.path());
        assert_eq!(s.status, "ready");
        assert_eq!(s.hint, "Session will auto-refresh on next use");
    }

    #[test]
    fn probe_claude_in_dir_reads_legacy_credentials_filename() {
        let dir = tempfile::tempdir().expect("tempdir");
        std::fs::write(
            dir.path().join("credentials"),
            claude_creds_json(30 * 86_400, None),
        )
        .expect("write");
        assert_eq!(probe_claude_oauth_in_dir(dir.path()).status, "ready");
    }

    #[test]
    fn probe_claude_in_dir_empty_file_is_login_required() {
        let dir = tempfile::tempdir().expect("tempdir");
        std::fs::write(dir.path().join(".credentials.json"), b"").expect("write");
        let s = probe_claude_oauth_in_dir(dir.path());
        assert_eq!(s.status, "login_required");
        assert_eq!(s.hint, CLAUDE_UNREADABLE_HINT);
    }

    /// Non-macOS: an empty config dir means genuinely not logged in.
    /// macOS is covered by `probe_claude_in_dir_missing_is_unknown_on_macos`.
    #[cfg(not(target_os = "macos"))]
    #[test]
    fn probe_claude_in_dir_missing_is_login_required_off_macos() {
        let dir = tempfile::tempdir().expect("tempdir");
        assert_eq!(
            probe_claude_oauth_in_dir(dir.path()).status,
            "login_required"
        );
    }

    /// macOS: credentials may live in the Keychain, so absence on disk is
    /// indeterminate, not negative. We never fabricate a Keychain read.
    #[cfg(target_os = "macos")]
    #[test]
    fn probe_claude_in_dir_missing_is_unknown_on_macos() {
        let dir = tempfile::tempdir().expect("tempdir");
        assert_eq!(probe_claude_oauth_in_dir(dir.path()).status, "unknown");
    }

    #[test]
    fn probe_claude_in_dir_nonexistent_dir_does_not_panic() {
        let dir = tempfile::tempdir().expect("tempdir");
        let missing = dir.path().join("no-such-account");
        let s = probe_claude_oauth_in_dir(&missing);
        assert!(s.status == "login_required" || s.status == "unknown");
    }

    #[test]
    fn probe_codex_in_dir_ready_for_valid_credentials() {
        let dir = tempfile::tempdir().expect("tempdir");
        std::fs::write(
            dir.path().join("auth.json"),
            codex_auth_json(30 * 86_400, Some("rt")),
        )
        .expect("write");
        let s = probe_codex_oauth_in_dir(dir.path());
        assert_eq!(s.status, "ready", "hint: {}", s.hint);
    }

    #[test]
    fn probe_codex_in_dir_expired_without_refresh_is_login_required() {
        let dir = tempfile::tempdir().expect("tempdir");
        std::fs::write(dir.path().join("auth.json"), codex_auth_json(-60, None)).expect("write");
        let s = probe_codex_oauth_in_dir(dir.path());
        assert_eq!(s.status, "login_required");
        assert_eq!(s.hint, CODEX_EXPIRED_HINT);
    }

    #[test]
    fn probe_codex_in_dir_missing_is_login_required_on_every_platform() {
        let dir = tempfile::tempdir().expect("tempdir");
        let s = probe_codex_oauth_in_dir(dir.path());
        assert_eq!(s.status, "login_required");
        assert!(s.hint.contains("CODEX_HOME"), "hint: {}", s.hint);
    }

    /// Two accounts with different credential state must not bleed into
    /// each other — the whole point of the per-dir probe.
    #[test]
    fn probe_in_dir_isolates_two_accounts() {
        let good = tempfile::tempdir().expect("tempdir");
        let bad = tempfile::tempdir().expect("tempdir");
        std::fs::write(
            good.path().join("auth.json"),
            codex_auth_json(30 * 86_400, Some("rt")),
        )
        .expect("write");
        std::fs::write(bad.path().join("auth.json"), codex_auth_json(-60, None)).expect("write");
        assert_eq!(probe_codex_oauth_in_dir(good.path()).status, "ready");
        assert_eq!(
            probe_codex_oauth_in_dir(bad.path()).status,
            "login_required"
        );
    }

    #[tokio::test]
    async fn for_dir_command_probes_the_given_dir() {
        let dir = tempfile::tempdir().expect("tempdir");
        std::fs::write(
            dir.path().join("auth.json"),
            codex_auth_json(30 * 86_400, Some("rt")),
        )
        .expect("write");
        let s = get_provider_auth_status_for_dir(
            "openai-codex".to_string(),
            dir.path().display().to_string(),
        )
        .await
        .expect("command should succeed");
        assert_eq!(s.status, "ready");
    }

    #[tokio::test]
    async fn for_dir_command_rejects_non_cli_providers() {
        let err = get_provider_auth_status_for_dir("anthropic".to_string(), "/tmp/whatever".into())
            .await
            .expect_err("api-key providers have no per-dir notion");
        assert!(err.contains("does not support"), "err: {}", err);
    }

    #[tokio::test]
    async fn for_dir_command_with_blank_dir_delegates_to_ambient() {
        // Blank dir == "no account selected". We can't assert the ambient
        // status (it depends on the dev machine), only that it resolves the
        // same way the zero-arg command does rather than erroring.
        let ambient = get_provider_auth_status("openai-codex".to_string())
            .await
            .expect("ambient probe");
        let delegated = get_provider_auth_status_for_dir("openai-codex".to_string(), "  ".into())
            .await
            .expect("blank dir should delegate");
        assert_eq!(ambient.status, delegated.status);
    }
}
