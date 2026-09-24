use crate::commands::git_host_probe::{
    GitHostProbeOutcome, GitHostProbeRequest, GitHostProbeResult, GitHostProbeSpec,
};
use crate::core::brand::{
    DATA_DIR_NAME, KEYRING_SERVICE, LEGACY_DATA_DIR_NAME, LEGACY_KEYRING_SERVICE,
    USER_AGENT as BRAND_USER_AGENT,
};
use crate::core::git_host::{
    self, host_label_from_url, sanitize_host_error, GitHost, GitHostKind, HostCapability,
    ListState, RepoRef,
};
use reqwest::header::{ACCEPT, LINK, USER_AGENT};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use tauri::{AppHandle, Emitter, State};
use tokio::sync::RwLock;
use tracing::{info, warn};
use zeroize::Zeroizing;

/// Validate a single opaque identifier (notification thread ids, and anything
/// else that is not a repo coordinate).
///
/// Repository coordinates no longer come through here — they go through
/// [`RepoRef::new`], which additionally permits the nested namespaces GitLab
/// subgroups require while still validating each segment.
fn validate_github_name(name: &str, field: &str) -> Result<(), String> {
    if name.is_empty() {
        return Err(format!("{} cannot be empty", field));
    }
    if name.len() > 100 {
        return Err(format!("{} is too long", field));
    }
    if !name
        .chars()
        .all(|c| c.is_alphanumeric() || c == '-' || c == '_' || c == '.')
    {
        return Err(format!(
            "{} contains invalid characters (allowed: alphanumeric, -, _, .)",
            field
        ));
    }
    Ok(())
}

fn token_file_path() -> Option<std::path::PathBuf> {
    super::shared::home_dir().map(|h| {
        std::path::PathBuf::from(h)
            .join(DATA_DIR_NAME)
            .join("github-token")
    })
}

/// Also check the old data dir for pre-rename installs.
fn legacy_token_file_path() -> Option<std::path::PathBuf> {
    super::shared::home_dir().map(|h| {
        std::path::PathBuf::from(h)
            .join(LEGACY_DATA_DIR_NAME)
            .join("github-token")
    })
}

fn keyring_entry() -> Option<keyring::Entry> {
    match keyring::Entry::new(KEYRING_SERVICE, "github-token") {
        Ok(entry) => Some(entry),
        Err(e) => {
            warn!("Failed to create keyring entry: {}", e);
            None
        }
    }
}

fn legacy_keyring_entry() -> Option<keyring::Entry> {
    keyring::Entry::new(LEGACY_KEYRING_SERVICE, "github-token").ok()
}

fn delete_keyring_credential(entry: Option<keyring::Entry>, label: &str) {
    if let Some(entry) = entry {
        match entry.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => {}
            Err(e) => warn!(
                "Failed to delete {} GitHub token from keyring: {}",
                label, e
            ),
        }
    }
}

fn clear_persisted_token() {
    delete_keyring_credential(keyring_entry(), "current");
    delete_keyring_credential(legacy_keyring_entry(), "legacy");

    for path in [token_file_path(), legacy_token_file_path()]
        .into_iter()
        .flatten()
    {
        let _ = std::fs::remove_file(path);
    }
}

// ============================================================================
// G2 — multi-connection git-host config (GitHub + Gitea/Forgejo)
//
// Connection *metadata* for Gitea hosts persists to `git-hosts.json` (not a
// secret; the base URL is required to build any request). Every connection's
// *token* persists in the OS keyring keyed by connection id — so no re-prompt
// after restart, for GitHub and Gitea alike. The GitHub connection is always
// present implicitly (id "github").
// ============================================================================

pub const GITHUB_CONNECTION_ID: &str = "github";

/// A configured git-host connection. Serialized (minus the token) to
/// `git-hosts.json` for Gitea hosts.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitHostConnection {
    pub id: String,
    pub kind: GitHostKind,
    /// GitHub: `https://api.github.com`. Gitea: the instance origin
    /// (e.g. `https://git.example.com`), `/api/v1` appended when building URLs.
    pub base_url: String,
    pub label: String,
}

/// The one origin a github.com credential may ever be sent to. Device-flow
/// tokens are minted by github.com, so the probe that validates one is pinned
/// here rather than taking an origin from the caller.
const GITHUB_API_BASE: &str = "https://api.github.com";

impl GitHostConnection {
    fn github() -> Self {
        Self {
            id: GITHUB_CONNECTION_ID.to_string(),
            kind: GitHostKind::GitHub,
            base_url: GITHUB_API_BASE.to_string(),
            label: "GitHub".to_string(),
        }
    }

    /// Resolve this connection to a `GitHost` for request building.
    fn to_host(&self) -> GitHost {
        GitHost::from_parts(self.kind, &self.base_url)
    }
}

/// Keyring account name for a connection's token. The GitHub connection reuses
/// the historical `github-token` account so existing tokens carry over.
fn host_token_account(id: &str) -> String {
    if id == GITHUB_CONNECTION_ID {
        "github-token".to_string()
    } else {
        format!("git-host-token-{}", id)
    }
}

fn host_token_entry(id: &str) -> Option<keyring::Entry> {
    keyring::Entry::new(KEYRING_SERVICE, &host_token_account(id)).ok()
}

fn load_host_token(id: &str) -> Option<String> {
    let raw = host_token_entry(id)?.get_password().ok()?;
    let trimmed = raw.trim();
    (!trimmed.is_empty()).then(|| trimmed.to_string())
}

fn save_host_token(id: &str, token: &str) -> Result<(), String> {
    host_token_entry(id)
        .ok_or_else(|| "OS keyring unavailable".to_string())?
        .set_password(token)
        .map_err(|e| format!("Failed to store token in keyring: {}", e))
}

fn delete_host_token(id: &str) {
    if let Some(entry) = host_token_entry(id) {
        match entry.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => {}
            Err(e) => warn!("Failed to delete token for '{}' from keyring: {}", id, e),
        }
    }
}

fn git_hosts_config_path() -> Option<std::path::PathBuf> {
    super::shared::home_dir().map(|h| {
        std::path::PathBuf::from(h)
            .join(DATA_DIR_NAME)
            .join("git-hosts.json")
    })
}

/// Whether a connection is persisted to `git-hosts.json`.
///
/// Everything except GitHub: the GitHub connection is seeded implicitly on
/// every launch, so writing it would create a duplicate on load. This used to
/// be spelled `kind == Gitea` on both sides, which silently *dropped* any
/// other kind on the next save — a GitLab connection would vanish on restart.
fn is_persisted_connection(c: &GitHostConnection) -> bool {
    c.kind != GitHostKind::GitHub && c.id != GITHUB_CONNECTION_ID
}

/// Load persisted self-hosted/third-party connections (metadata only).
fn load_host_connections() -> Vec<GitHostConnection> {
    let Some(path) = git_hosts_config_path() else {
        return vec![];
    };
    let Ok(raw) = std::fs::read_to_string(&path) else {
        return vec![];
    };
    serde_json::from_str::<Vec<GitHostConnection>>(&raw)
        .unwrap_or_default()
        .into_iter()
        .filter(is_persisted_connection)
        .collect()
}

fn save_host_connections(conns: &[GitHostConnection]) -> Result<(), String> {
    let path = git_hosts_config_path().ok_or_else(|| "no data dir".to_string())?;
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let persisted: Vec<&GitHostConnection> = conns
        .iter()
        .filter(|c| is_persisted_connection(c))
        .collect();
    let json = serde_json::to_string_pretty(&persisted).map_err(|e| e.to_string())?;
    std::fs::write(&path, json).map_err(|e| format!("Failed to write git-hosts.json: {}", e))
}

/// Migrate any legacy GitHub token (legacy keyring service / plaintext files)
/// into the current keyring account, then remove the plaintext copies. Unlike
/// the old scrub-on-load, the token now PERSISTS in the current keyring so the
/// user isn't re-prompted after restart.
fn migrate_github_token_to_keyring() {
    if load_host_token(GITHUB_CONNECTION_ID).is_some() {
        // Already in the current keyring — clear any leftover legacy copies.
        for path in [token_file_path(), legacy_token_file_path()]
            .into_iter()
            .flatten()
        {
            let _ = std::fs::remove_file(path);
        }
        delete_keyring_credential(legacy_keyring_entry(), "legacy");
        return;
    }

    let mut found: Option<String> = None;
    if let Some(entry) = legacy_keyring_entry() {
        if let Ok(token) = entry.get_password() {
            let trimmed = token.trim();
            if !trimmed.is_empty() {
                found = Some(trimmed.to_string());
            }
        }
    }
    if found.is_none() {
        for path in [token_file_path(), legacy_token_file_path()]
            .into_iter()
            .flatten()
        {
            if let Ok(raw) = std::fs::read_to_string(&path) {
                let raw = Zeroizing::new(raw);
                let trimmed = raw.trim();
                if !trimmed.is_empty() {
                    found = Some(trimmed.to_string());
                    break;
                }
            }
        }
    }

    let mut migrated = false;
    if let Some(token) = found {
        match save_host_token(GITHUB_CONNECTION_ID, &token) {
            Ok(()) => {
                migrated = true;
                info!("Migrated legacy GitHub token into the OS keyring");
            }
            // Do NOT delete the source copies if the write failed — that would
            // erase the only copy of the token (data loss).
            Err(e) => warn!("Failed to migrate GitHub token into keyring: {}", e),
        }
    }

    // Only supersede the legacy plaintext/keyring copies once the token is
    // safely in the current keyring account (just migrated, or already present).
    if migrated || load_host_token(GITHUB_CONNECTION_ID).is_some() {
        for path in [token_file_path(), legacy_token_file_path()]
            .into_iter()
            .flatten()
        {
            let _ = std::fs::remove_file(path);
        }
        delete_keyring_credential(legacy_keyring_entry(), "legacy");
    }
}

pub struct GitHubAuthState {
    /// All connections: GitHub (implicit, always present) + persisted Gitea.
    connections: RwLock<Vec<GitHostConnection>>,
    /// Connection id → token, hydrated from the OS keyring on startup and kept
    /// there (no re-prompt after restart).
    tokens: RwLock<HashMap<String, String>>,
    /// G4: the connection the pane's commands target, set per-workspace by the
    /// frontend (`git_host_set_active`) from the resolved origin remote.
    active_connection_id: RwLock<String>,
}

impl GitHubAuthState {
    pub fn new() -> Self {
        migrate_github_token_to_keyring();

        let mut connections = vec![GitHostConnection::github()];
        connections.extend(load_host_connections());

        let mut tokens = HashMap::new();
        for c in &connections {
            if let Some(t) = load_host_token(&c.id) {
                tokens.insert(c.id.clone(), t);
            }
        }

        Self {
            connections: RwLock::new(connections),
            tokens: RwLock::new(tokens),
            active_connection_id: RwLock::new(GITHUB_CONNECTION_ID.to_string()),
        }
    }

    /// Resolve a connection by id.
    async fn connection(&self, id: &str) -> Option<GitHostConnection> {
        self.connections
            .read()
            .await
            .iter()
            .find(|c| c.id == id)
            .cloned()
    }
}

pub fn create_github_auth_state() -> GitHubAuthState {
    GitHubAuthState::new()
}

/// Build an authenticated client + resolved `GitHost` for a connection id. The
/// Gitea command groups (G4–G12) route through this; GitHub commands keep using
/// `github_client_from_state` (the `"github"` connection). G3 feeds the
/// per-workspace connection id here.
async fn git_host_session(
    auth: &GitHubAuthState,
    connection_id: &str,
) -> Result<(reqwest::Client, GitHost), String> {
    let conn = auth
        .connection(connection_id)
        .await
        .ok_or_else(|| format!("Unknown git-host connection '{}'.", connection_id))?;
    let token = auth
        .tokens
        .read()
        .await
        .get(connection_id)
        .cloned()
        .ok_or_else(|| format!("No token for '{}'. Connect first.", conn.label))?;
    let host = conn.to_host();
    let client = host.build_client(&token)?;
    Ok((client, host))
}

/// Build a client + host for whichever connection is currently active (set
/// per-workspace by the frontend). The Gitea-aware command groups (G4+) route
/// through this instead of `github_client_from_state`.
#[allow(dead_code)] // consumed as each command group is routed (G4+)
async fn active_host_session(auth: &GitHubAuthState) -> Result<(reqwest::Client, GitHost), String> {
    let id = auth.active_connection_id.read().await.clone();
    git_host_session(auth, &id).await
}

/// G4: set the connection the pane's commands target (resolved per-workspace on
/// the frontend from the repo's origin remote).
#[tauri::command]
pub async fn git_host_set_active(
    auth: State<'_, GitHubAuthState>,
    id: String,
) -> Result<(), String> {
    if auth.connection(&id).await.is_none() {
        return Err(format!("Unknown connection '{}'.", id));
    }
    *auth.active_connection_id.write().await = id;
    Ok(())
}

/// Resolve the active session *and* the repo coordinate in one step.
///
/// The coordinate is validated first so a malformed owner/repo still fails
/// before any keyring read or client build, preserving the old error ordering.
async fn repo_session(
    auth: &GitHubAuthState,
    owner: &str,
    repo: &str,
) -> Result<(reqwest::Client, GitHost, RepoRef), String> {
    let r = RepoRef::new(owner, repo)?;
    let (client, host) = active_host_session(auth).await?;
    Ok((client, host, r))
}

async fn repo_session_for_connection(
    auth: &GitHubAuthState,
    owner: &str,
    repo: &str,
    connection_id: Option<&str>,
) -> Result<(reqwest::Client, GitHost, RepoRef), String> {
    let r = RepoRef::new(owner, repo)?;
    let (client, host) = match connection_id {
        Some(id) => git_host_session(auth, id).await?,
        None => active_host_session(auth).await?,
    };
    Ok((client, host, r))
}

/// The active connection resolved to a `GitHost` (without building a client).
///
/// This replaces the old `active_host_kind`, which returned a bare kind that
/// every call site then compared against `GitHostKind::Gitea` by hand — the
/// deny-list shape that failed open. Returning the whole host means callers ask
/// it what it supports instead of enumerating what it isn't.
async fn active_host(auth: &GitHubAuthState) -> GitHost {
    let id = auth.active_connection_id.read().await.clone();
    auth.connection(&id)
        .await
        .map(|c| c.to_host())
        .unwrap_or_else(GitHost::github)
}

/// Refuse a command whose host lacks the capability it needs.
///
/// This replaces the family of `if active_host_kind() == Gitea { refuse }`
/// guards. Those were a **deny-list**, and a deny-list fails open: every one of
/// them let an unrecognised host kind through, and the command then went on to
/// hit its hardcoded `https://api.github.com/...` URL — sending the GitHub
/// token to GitHub carrying the *other* host's owner/repo/ids. The capability
/// table in `core::git_host` is an explicit per-kind allow-list, so a host that
/// was never considered is refused rather than silently mis-routed.
async fn require_capability(auth: &GitHubAuthState, cap: HostCapability) -> Result<(), String> {
    let host = active_host(auth).await;
    if host.supports(cap) {
        Ok(())
    } else {
        Err(host.unsupported(cap))
    }
}

/// Build an authenticated client for the given host + token. GitHub construction
/// is byte-identical to the previous inline builder (Bearer + vnd.github+json +
/// brand UA).
fn github_client(token: &str) -> Result<reqwest::Client, String> {
    GitHost::github().build_client(token)
}

/// Log the raw failure body (never surfaced to the user — it can echo tokens
/// and private repo data) and return the sanitized, host-named message.
async fn host_error_from_response(resp: reqwest::Response) -> String {
    let status = resp.status();
    let label = host_label_from_url(resp.url());
    warn!(
        "{} API error {}: {}",
        label,
        status,
        resp.text().await.unwrap_or_default()
    );
    sanitize_host_error(&label, status)
}

async fn github_response_text(resp: reqwest::Response) -> Result<String, String> {
    if !resp.status().is_success() {
        return Err(host_error_from_response(resp).await);
    }
    resp.text()
        .await
        .map_err(|e| format!("Failed to read response: {}", e))
}

/// Project a raw JSON **array** body into the canonical GitHub-shaped wire DTO.
///
/// The frontend is written against GitHub's field names throughout
/// (`src/types/github.ts`), so rather than teach ~30 React components a third
/// vocabulary the projection happens here. GitHub and Gitea already speak the
/// canonical shape, so this is a no-op for them and the body passes through
/// byte-for-byte; only GitLab's payloads are rewritten. A non-array body (an
/// error envelope that slipped through) also passes through untouched so the
/// original text still reaches the user.
fn normalize_list(
    host: &GitHost,
    body: String,
    f: fn(&serde_json::Value) -> serde_json::Value,
) -> Result<String, String> {
    if host.kind != GitHostKind::GitLab {
        return Ok(body);
    }
    let v: serde_json::Value =
        serde_json::from_str(&body).map_err(|e| format!("Failed to parse response: {}", e))?;
    serde_json::to_string(&git_host::normalize_array(&v, f))
        .map_err(|e| format!("Failed to serialize response: {}", e))
}

/// Single-object counterpart to [`normalize_list`].
fn normalize_one(
    host: &GitHost,
    body: String,
    f: fn(&serde_json::Value) -> serde_json::Value,
) -> Result<String, String> {
    if host.kind != GitHostKind::GitLab {
        return Ok(body);
    }
    let v: serde_json::Value =
        serde_json::from_str(&body).map_err(|e| format!("Failed to parse response: {}", e))?;
    if !v.is_object() {
        return Ok(body);
    }
    serde_json::to_string(&f(&v)).map_err(|e| format!("Failed to serialize response: {}", e))
}

#[tauri::command]
pub async fn github_set_token(
    auth: State<'_, GitHubAuthState>,
    token: String,
) -> Result<(), String> {
    let trimmed = token.trim();
    if trimmed.is_empty() {
        return Err("GitHub token cannot be empty".to_string());
    }
    save_host_token(GITHUB_CONNECTION_ID, trimmed)?;
    auth.tokens
        .write()
        .await
        .insert(GITHUB_CONNECTION_ID.to_string(), trimmed.to_string());
    info!("GitHub token set (persisted to keyring)");
    Ok(())
}

#[tauri::command]
pub async fn github_clear_token(auth: State<'_, GitHubAuthState>) -> Result<(), String> {
    delete_host_token(GITHUB_CONNECTION_ID);
    // Scrub any lingering legacy plaintext/keyring copies too.
    clear_persisted_token();
    auth.tokens.write().await.remove(GITHUB_CONNECTION_ID);
    info!("GitHub token cleared");
    Ok(())
}

#[tauri::command]
pub async fn github_has_token(auth: State<'_, GitHubAuthState>) -> Result<bool, String> {
    Ok(auth.tokens.read().await.contains_key(GITHUB_CONNECTION_ID))
}

// ---- GP3: GitHub OAuth device-flow auth (GitHub only) ----

const GITHUB_DEVICE_CODE_URL: &str = "https://github.com/login/device/code";
const GITHUB_DEVICE_TOKEN_URL: &str = "https://github.com/login/oauth/access_token";
const GITHUB_DEVICE_SCOPES: &str = "repo read:org notifications";

/// The OAuth App client id: runtime override first, then the baked brand const.
fn github_oauth_client_id() -> Option<String> {
    if let Ok(id) = std::env::var("PACKETBENCH_GITHUB_CLIENT_ID") {
        let id = id.trim().to_string();
        if !id.is_empty() {
            return Some(id);
        }
    }
    let baked = crate::core::brand::GITHUB_OAUTH_CLIENT_ID;
    (!baked.is_empty()).then(|| baked.to_string())
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceFlowStart {
    pub device_code: String,
    pub user_code: String,
    pub verification_uri: String,
    pub interval: u64,
    pub expires_in: u64,
}

/// Begin GitHub OAuth device flow — returns the user-code + verification URL the
/// user visits, plus the poll interval.
#[tauri::command]
pub async fn github_device_flow_start() -> Result<DeviceFlowStart, String> {
    let client_id = github_oauth_client_id().ok_or_else(|| {
        "GitHub OAuth app not configured — paste a personal access token instead.".to_string()
    })?;
    let client = reqwest::Client::new();
    let resp = client
        .post(GITHUB_DEVICE_CODE_URL)
        .header(ACCEPT, "application/json")
        .header(USER_AGENT, BRAND_USER_AGENT)
        .form(&[
            ("client_id", client_id.as_str()),
            ("scope", GITHUB_DEVICE_SCOPES),
        ])
        .send()
        .await
        .map_err(|e| format!("Request failed: {}", e))?;
    let body = github_response_text(resp).await?;
    let v: serde_json::Value = serde_json::from_str(&body)
        .map_err(|e| format!("Failed to parse device response: {}", e))?;
    // GitHub can return HTTP 200 with an `{"error": ...}` body (e.g. a suspended
    // or misconfigured OAuth app). Without device_code the poll loop would spin
    // to expiry showing a blank code — surface the error instead of empty codes.
    let device_code = v["device_code"].as_str().unwrap_or_default();
    if device_code.is_empty() {
        let msg = v["error_description"]
            .as_str()
            .or_else(|| v["error"].as_str())
            .unwrap_or("GitHub did not return a device code");
        return Err(msg.to_string());
    }
    Ok(DeviceFlowStart {
        device_code: device_code.to_string(),
        user_code: v["user_code"].as_str().unwrap_or_default().to_string(),
        verification_uri: v["verification_uri"]
            .as_str()
            .unwrap_or("https://github.com/login/device")
            .to_string(),
        interval: v["interval"].as_u64().unwrap_or(5),
        expires_in: v["expires_in"].as_u64().unwrap_or(900),
    })
}

/// Whether a GitHub OAuth app client id is configured (env or baked brand const).
/// The device-flow UI gates its button on this so stock builds don't show an
/// affordance that always errors.
#[tauri::command]
pub fn github_oauth_configured() -> bool {
    github_oauth_client_id().is_some()
}

// ---- The parked (un-accepted) device-flow credential ----------------------
//
// GitHub minting a token is not PacketBench accepting it. This flow used to
// write the token to the keyring the instant GitHub said "authorized", which
// is the exact inversion the setup wizard exists to undo: a credential whose
// org-restricted grants make it useless would land in the keyring, and the
// user would find out only when a repo action failed.
//
// So a freshly minted token is parked HERE, in process memory, and reaches the
// keyring only after passing the very same probe that gates a pasted token.
// It never leaves Rust: `github_device_flow_poll` hands back an opaque handle,
// and the probe/commit/discard commands take that handle, never a credential.

/// How long a parked credential stays usable. Comfortably longer than the
/// authorise-then-verify round trip, short enough that an abandoned wizard does
/// not leave a live token in memory for the life of the process.
const PENDING_DEVICE_AUTH_TTL_SECS: u64 = 20 * 60;

struct PendingDeviceAuth {
    id: String,
    token: Zeroizing<String>,
    minted: std::time::Instant,
    /// Set by `github_device_flow_probe_pending` on a clean probe, and cleared
    /// again by anything less. `commit` refuses without it, so there is no path
    /// from "GitHub authorised it" to "it is in the keyring" that skips
    /// validation — the frontend cannot opt out by not asking.
    verified: bool,
}

/// Holds at most one un-committed device-flow credential.
#[derive(Default)]
pub struct DeviceAuthState {
    pending: std::sync::Mutex<Option<PendingDeviceAuth>>,
}

const PENDING_UNKNOWN: &str =
    "That sign-in is no longer in progress — start the browser authorisation again.";
const PENDING_EXPIRED: &str =
    "That sign-in took too long and was discarded — start the browser authorisation again.";
const PENDING_UNVERIFIED: &str =
    "This credential has not been checked against GitHub yet, so it was not saved.";

impl DeviceAuthState {
    fn lock(&self) -> std::sync::MutexGuard<'_, Option<PendingDeviceAuth>> {
        // A panic in another holder must not wedge sign-in permanently; the
        // slot is a single owned value, so there is no torn state to inherit.
        self.pending.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Park a freshly minted token, dropping (and zeroizing) any previous one.
    fn stash(&self, token: String) -> String {
        let id = uuid::Uuid::new_v4().to_string();
        *self.lock() = Some(PendingDeviceAuth {
            id: id.clone(),
            token: Zeroizing::new(token),
            minted: std::time::Instant::now(),
            verified: false,
        });
        id
    }

    /// The parked credential for `id`, if it is still the current one and has
    /// not aged out. An aged-out entry is dropped on the way past.
    fn token_for(&self, id: &str) -> Result<String, String> {
        let mut slot = self.lock();
        match slot.as_ref() {
            Some(p) if p.id != id => Err(PENDING_UNKNOWN.to_string()),
            Some(p) if p.minted.elapsed().as_secs() > PENDING_DEVICE_AUTH_TTL_SECS => {
                *slot = None;
                Err(PENDING_EXPIRED.to_string())
            }
            Some(p) => Ok(p.token.to_string()),
            None => Err(PENDING_UNKNOWN.to_string()),
        }
    }

    /// Record the outcome of a probe against the parked credential.
    fn set_verified(&self, id: &str, verified: bool) {
        if let Some(p) = self.lock().as_mut() {
            if p.id == id {
                p.verified = verified;
            }
        }
    }

    /// Hand over the parked credential for persistence, but only if a probe has
    /// vouched for it. Consumes the slot either way it succeeds.
    fn take_verified(&self, id: &str) -> Result<Zeroizing<String>, String> {
        let mut slot = self.lock();
        match slot.as_ref() {
            Some(p) if p.id != id => return Err(PENDING_UNKNOWN.to_string()),
            Some(p) if p.minted.elapsed().as_secs() > PENDING_DEVICE_AUTH_TTL_SECS => {
                *slot = None;
                return Err(PENDING_EXPIRED.to_string());
            }
            Some(p) if !p.verified => return Err(PENDING_UNVERIFIED.to_string()),
            Some(_) => {}
            None => return Err(PENDING_UNKNOWN.to_string()),
        }
        Ok(slot.take().expect("checked above").token)
    }

    /// Drop the parked credential. Idempotent, and a no-op for a stale handle.
    fn discard(&self, id: &str) {
        let mut slot = self.lock();
        if slot.as_ref().is_some_and(|p| p.id == id) {
            *slot = None;
        }
    }
}

pub fn create_device_auth_state() -> DeviceAuthState {
    DeviceAuthState::default()
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceFlowPoll {
    /// `authorized` | `pending` | `slow_down` | `error`.
    pub status: String,
    pub message: Option<String>,
    /// Opaque handle to the credential GitHub just minted and this process
    /// parked. Present only on `authorized`. **Not** the token.
    pub pending_id: Option<String>,
}

/// Poll for the device-flow token. On `authorized` the token is parked in
/// memory and an opaque handle is returned; nothing is written to the keyring
/// until [`github_device_flow_commit`], and that refuses a handle no probe has
/// vouched for.
#[tauri::command]
pub async fn github_device_flow_poll(
    device: State<'_, DeviceAuthState>,
    device_code: String,
) -> Result<DeviceFlowPoll, String> {
    let client_id =
        github_oauth_client_id().ok_or_else(|| "GitHub OAuth app not configured.".to_string())?;
    let client = reqwest::Client::new();
    let resp = client
        .post(GITHUB_DEVICE_TOKEN_URL)
        .header(ACCEPT, "application/json")
        .header(USER_AGENT, BRAND_USER_AGENT)
        .form(&[
            ("client_id", client_id.as_str()),
            ("device_code", device_code.as_str()),
            ("grant_type", "urn:ietf:params:oauth:grant-type:device_code"),
        ])
        .send()
        .await
        .map_err(|e| format!("Request failed: {}", e))?;
    let body = resp
        .text()
        .await
        .map_err(|e| format!("Failed to read response: {}", e))?;
    let v: serde_json::Value = serde_json::from_str(&body)
        .map_err(|e| format!("Failed to parse token response: {}", e))?;

    if let Some(token) = v["access_token"].as_str() {
        let pending_id = device.stash(token.to_string());
        info!("GitHub device-flow authorized; credential held pending verification");
        return Ok(DeviceFlowPoll {
            status: "authorized".to_string(),
            message: None,
            pending_id: Some(pending_id),
        });
    }

    let status = match v["error"].as_str() {
        Some("authorization_pending") => "pending",
        Some("slow_down") => "slow_down",
        _ => "error",
    };
    let message = if status == "error" {
        Some(
            v["error_description"]
                .as_str()
                .or_else(|| v["error"].as_str())
                .unwrap_or("Device flow failed")
                .to_string(),
        )
    } else {
        None
    };
    Ok(DeviceFlowPoll {
        status: status.to_string(),
        message,
        pending_id: None,
    })
}

/// Check the parked device-flow credential against GitHub — the same
/// non-persisting probe that gates a pasted token, so both credential kinds
/// produce the same verdict (identity, and the scopes GitHub reports on
/// `x-oauth-scopes`) rather than one of them getting a free pass.
///
/// The origin is pinned to `api.github.com`: this credential was minted by
/// github.com and there is no other address it could legitimately be sent to.
/// Only the descriptor's paths/headers come from the caller.
#[tauri::command]
pub async fn github_device_flow_probe_pending(
    device: State<'_, DeviceAuthState>,
    pending_id: String,
    probe: GitHostProbeSpec,
) -> Result<GitHostProbeResult, String> {
    let token = device.token_for(&pending_id)?;
    let result = crate::commands::git_host_probe::probe_credential(
        probe.into_request(GITHUB_API_BASE.to_string(), token),
    )
    .await?;
    device.set_verified(&pending_id, result.outcome == GitHostProbeOutcome::Ok);
    Ok(result)
}

/// Accept a probed device-flow credential: keyring first, then the in-memory
/// map, exactly as a rotation does. Refuses a handle that no probe has vouched
/// for, so "GitHub authorised it" is never on its own enough to be stored.
#[tauri::command]
pub async fn github_device_flow_commit(
    auth: State<'_, GitHubAuthState>,
    device: State<'_, DeviceAuthState>,
    pending_id: String,
) -> Result<(), String> {
    let token = device.take_verified(&pending_id)?;
    save_host_token(GITHUB_CONNECTION_ID, &token)?;
    auth.tokens
        .write()
        .await
        .insert(GITHUB_CONNECTION_ID.to_string(), token.to_string());
    info!("GitHub device-flow credential verified and persisted to keyring");
    Ok(())
}

/// Drop a parked credential the user walked away from. Idempotent.
#[tauri::command]
pub fn github_device_flow_discard(device: State<'_, DeviceAuthState>, pending_id: String) {
    device.discard(&pending_id);
}

// ---- G2: multi-connection commands (GitHub + Gitea) ----

/// Connection info surfaced to the frontend (token value never leaves Rust).
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitHostConnectionInfo {
    pub id: String,
    pub kind: GitHostKind,
    pub base_url: String,
    pub label: String,
    pub has_token: bool,
}

#[tauri::command]
pub async fn git_host_list_connections(
    auth: State<'_, GitHubAuthState>,
) -> Result<Vec<GitHostConnectionInfo>, String> {
    let conns = auth.connections.read().await;
    let tokens = auth.tokens.read().await;
    Ok(conns
        .iter()
        .map(|c| GitHostConnectionInfo {
            id: c.id.clone(),
            kind: c.kind,
            base_url: c.base_url.clone(),
            label: c.label.clone(),
            has_token: tokens.contains_key(&c.id),
        })
        .collect())
}

/// Derive a stable, unique connection id from a kind + base URL host.
///
/// The kind is part of the id (`gitea-…` / `gitlab-…`) so the same hostname can
/// legitimately host two different kinds without colliding, and so an id is
/// self-describing in logs and in the keyring account name.
fn unique_connection_id(
    kind: GitHostKind,
    base_url: &str,
    existing: &[GitHostConnection],
) -> String {
    let host = base_url
        .split("://")
        .nth(1)
        .unwrap_or(base_url)
        .split('/')
        .next()
        .unwrap_or("host");
    let slug: String = host
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() {
                c.to_ascii_lowercase()
            } else {
                '-'
            }
        })
        .collect();
    let prefix = match kind {
        GitHostKind::Gitea => "gitea",
        GitHostKind::GitLab => "gitlab",
        GitHostKind::GitHub => "github",
    };
    let base = format!("{}-{}", prefix, slug.trim_matches('-'));
    if !existing.iter().any(|c| c.id == base) {
        return base;
    }
    (2..)
        .map(|n| format!("{}-{}", base, n))
        .find(|candidate| !existing.iter().any(|c| &c.id == candidate))
        .unwrap_or(base)
}

/// Add a self-hosted / third-party git-host connection.
///
/// `base_url` is the **instance origin** — the API suffix (`/api/v1` for Gitea,
/// `/api/v4` for GitLab) is appended by `GitHost`, idempotently, so a pasted
/// API root also works. gitlab.com is not special-cased: GitLab serves
/// `/api/v4` under the instance origin on SaaS exactly as it does self-hosted.
///
/// The token goes straight to the OS keyring under this connection's own
/// account (`git-host-token-{id}`) and is never returned to the frontend or
/// written to `git-hosts.json`.
#[tauri::command]
pub async fn git_host_add_connection(
    auth: State<'_, GitHubAuthState>,
    kind: GitHostKind,
    base_url: String,
    label: String,
    token: String,
) -> Result<String, String> {
    // The GitHub connection is seeded implicitly and owns the historical
    // `github-token` keyring account; a second one would shadow it.
    if kind == GitHostKind::GitHub {
        return Err("The GitHub connection is built in and cannot be added.".to_string());
    }
    let base = base_url.trim().trim_end_matches('/');
    if !(base.starts_with("http://") || base.starts_with("https://")) {
        return Err(format!(
            "{} base URL must start with http:// or https://",
            kind.label()
        ));
    }
    // The PAT is sent as a bearer/token header on every request to this
    // origin; a public plaintext origin would expose it. Self-hosted
    // instances on localhost / a private network may stay http.
    let parsed = reqwest::Url::parse(base)
        .map_err(|_| format!("{} base URL is not a valid URL", kind.label()))?;
    crate::core::shared::require_https_unless_local(
        &parsed,
        &format!("{} base URL", kind.label()),
    )?;
    let token = token.trim();
    if token.is_empty() {
        return Err(format!("{} token cannot be empty", kind.label()));
    }
    let label = {
        let l = label.trim();
        if l.is_empty() {
            base.to_string()
        } else {
            l.to_string()
        }
    };

    let mut conns = auth.connections.write().await;
    let id = unique_connection_id(kind, base, &conns);
    conns.push(GitHostConnection {
        id: id.clone(),
        kind,
        base_url: base.to_string(),
        label,
    });
    save_host_connections(&conns)?;
    drop(conns);

    save_host_token(&id, token)?;
    auth.tokens
        .write()
        .await
        .insert(id.clone(), token.to_string());
    info!("Added {} connection '{}'", kind.label(), id);
    Ok(id)
}

#[tauri::command]
pub async fn git_host_remove_connection(
    auth: State<'_, GitHubAuthState>,
    id: String,
) -> Result<(), String> {
    if id == GITHUB_CONNECTION_ID {
        return Err("The GitHub connection cannot be removed.".to_string());
    }
    let mut conns = auth.connections.write().await;
    let before = conns.len();
    conns.retain(|c| c.id != id);
    if conns.len() == before {
        return Err(format!("Unknown connection '{}'.", id));
    }
    save_host_connections(&conns)?;
    drop(conns);

    delete_host_token(&id);
    auth.tokens.write().await.remove(&id);
    // If the removed connection was active, fall back to GitHub so subsequent
    // commands don't resolve to a now-unknown connection.
    {
        let mut active = auth.active_connection_id.write().await;
        if *active == id {
            *active = GITHUB_CONNECTION_ID.to_string();
        }
    }
    info!("Removed git-host connection '{}'", id);
    Ok(())
}

/// Overwrite a connection's token **without validating it first**.
///
/// Retained for the paths that have already validated (or that deliberately
/// cannot, like the device flow). User-driven rotation must go through
/// [`git_host_update_connection`] instead: this one will happily replace a
/// working credential with a dead one.
#[tauri::command]
pub async fn git_host_set_token(
    auth: State<'_, GitHubAuthState>,
    id: String,
    token: String,
) -> Result<(), String> {
    let token = token.trim();
    if token.is_empty() {
        return Err("Token cannot be empty".to_string());
    }
    if auth.connection(&id).await.is_none() {
        return Err(format!("Unknown connection '{}'.", id));
    }
    save_host_token(&id, token)?;
    auth.tokens.write().await.insert(id, token.to_string());
    Ok(())
}

#[tauri::command]
pub async fn git_host_has_token(
    auth: State<'_, GitHubAuthState>,
    id: String,
) -> Result<bool, String> {
    Ok(auth.tokens.read().await.contains_key(&id))
}

// ---- Editing an existing connection in place (rotation + rename) ----------
//
// Before this, the only way to give an existing host a fresh token was to
// remove the connection and run the setup wizard again — because
// `git_host_add_connection` mints a NEW id via `unique_connection_id`, so
// re-running the wizard against a host you already have produces a second
// connection rather than rotating the first. Tokens expire on a schedule
// (GitHub and GitLab PATs both carry an expiry), so rotation is the ordinary
// case, and remove-then-re-add makes the ordinary case pass through a window
// in which the user has no working credential at all.
//
// The property this code exists to guarantee: **a rotation that does not end
// in a working credential leaves the working one exactly where it was.** Every
// ordering decision below follows from that.

/// An in-place edit of an existing connection. Every field is optional; an
/// absent field means "leave this alone".
///
/// `kind` / `base_url` are *assertions*, not edits: supply them and they must
/// match what is stored. Changing either would make this a different
/// connection with a different keyring account and a different set of repos —
/// adding a new connection is the correct move there, so this refuses.
#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitHostConnectionUpdate {
    /// New display label. `None` leaves the stored label alone.
    pub label: Option<String>,
    /// New credential. `None` leaves the stored token *completely untouched* —
    /// which is what makes a label-only edit possible without re-typing a
    /// token the user may not have a copy of any more.
    pub token: Option<String>,
    /// The host descriptor used to validate `token` before it is written.
    /// Required whenever `token` is present; there is no unvalidated path.
    pub probe: Option<GitHostProbeSpec>,
    /// Caller's belief about this connection's kind. Refused if it differs.
    pub kind: Option<GitHostKind>,
    /// Caller's belief about this connection's base URL. Refused if it differs.
    pub base_url: Option<String>,
}

/// What an update resolves to once every guard has passed.
#[derive(Debug, PartialEq, Eq)]
struct ConnectionUpdatePlan {
    /// A label to persist, when it actually differs from the stored one.
    label: Option<String>,
    /// Whether the stored credential is being replaced.
    rotates_token: bool,
}

/// Compare two base URLs the way the add path normalises them, so echoing back
/// `https://git.example.com/` for a stored `https://git.example.com` is not
/// mistaken for an attempt to change the address.
fn same_base_url(a: &str, b: &str) -> bool {
    a.trim().trim_end_matches('/') == b.trim().trim_end_matches('/')
}

/// Every guard that can be decided without touching the network or the keyring.
///
/// Deliberately pure: the refusals below are the ones most worth pinning in a
/// test, and they must all run *before* the probe, which must in turn run
/// before any write.
fn plan_connection_update(
    conn: &GitHostConnection,
    update: &GitHostConnectionUpdate,
) -> Result<ConnectionUpdatePlan, String> {
    if let Some(kind) = update.kind {
        if kind != conn.kind {
            return Err(format!(
                "A connection's host kind cannot be changed ({} → {}). Add a new connection instead.",
                conn.kind.label(),
                kind.label()
            ));
        }
    }
    if let Some(base_url) = update.base_url.as_deref() {
        if !same_base_url(base_url, &conn.base_url) {
            return Err(
                "A connection's address cannot be changed. Add a new connection for the new address instead."
                    .to_string(),
            );
        }
    }

    let label = match update.label.as_deref().map(str::trim) {
        None => None,
        Some("") => return Err("Display name cannot be empty.".to_string()),
        Some(l) if l == conn.label => None,
        // The GitHub connection is seeded fresh on every launch and is excluded
        // from `git-hosts.json`, so a renamed label would silently revert on
        // restart. Refuse rather than pretend. Reached only when the label
        // actually differs — the arm above absorbs a re-submitted one.
        Some(_) if conn.id == GITHUB_CONNECTION_ID => {
            return Err(
                "The built-in GitHub connection's name is fixed — only its token can be changed."
                    .to_string(),
            );
        }
        Some(l) => Some(l.to_string()),
    };

    let rotates_token = match update.token.as_deref().map(str::trim) {
        None => false,
        Some("") => return Err("Token cannot be empty.".to_string()),
        Some(_) => true,
    };
    if rotates_token && update.probe.is_none() {
        // Refusing here rather than saving unvalidated is the whole point: a
        // caller that cannot describe how to check the credential cannot be
        // allowed to replace a working one with it.
        return Err(
            "A replacement token must be verified against the host before it is saved.".to_string(),
        );
    }

    if label.is_none() && !rotates_token {
        return Err("Nothing to update.".to_string());
    }
    Ok(ConnectionUpdatePlan {
        label,
        rotates_token,
    })
}

/// Why a rotation was refused, built from the probe *outcome* alone.
///
/// Never interpolates the token, and never the response body: `detail` is
/// omitted here even though the probe already scrubs it, because the outcome
/// class is what tells the user what to do.
fn rotation_refusal(outcome: GitHostProbeOutcome) -> String {
    let reason = match outcome {
        GitHostProbeOutcome::InvalidToken => "the host rejected it",
        GitHostProbeOutcome::Forbidden => {
            "the host recognised it but refused the request (SSO authorization, IP allow-list, or a revoked token)"
        }
        GitHostProbeOutcome::RateLimited => "the host is rate-limiting this credential",
        GitHostProbeOutcome::NotAHost => "the host's API did not answer as expected",
        GitHostProbeOutcome::Unreachable => "the host could not be contacted",
        GitHostProbeOutcome::TlsError => "the host's TLS certificate could not be verified",
        GitHostProbeOutcome::ServerError => "the host returned a server error",
        GitHostProbeOutcome::Unknown => {
            "the host answered in a way PacketBench does not recognise"
        }
        // Unreachable in practice; a green probe never lands here.
        GitHostProbeOutcome::Ok => "of an internal error",
    };
    format!(
        "The new token was not saved because {}. The existing credential is unchanged.",
        reason
    )
}

/// The update, with its two effects injected.
///
/// Split out from the command so the ordering guarantee can be tested without
/// an OS keyring or a live host: the tests below drive this with a fake probe
/// and a counting token writer and assert that a red probe reaches neither.
///
/// Order of operations, and why:
///  1. Guards (`plan_connection_update`) — cheapest, and nothing has moved yet.
///  2. Probe — network, still nothing written.
///  3. Label — non-secret metadata; rolled back in memory if the file write
///     fails, so the in-memory list never disagrees with `git-hosts.json`.
///  4. Token — last, and only on a green probe. A failure at 3 leaves the old
///     (working) token; a failure at 4 leaves the old token *and* the old
///     label is already correct. Neither order can lose a credential.
async fn update_connection_inner<P, Fut>(
    auth: &GitHubAuthState,
    id: &str,
    update: GitHostConnectionUpdate,
    probe: P,
    // `+ Sync` so the returned future stays `Send`: Tauri requires it of every
    // async command, and a `&dyn Fn` is only `Send` when the `Fn` is `Sync`.
    persist_connections: &(dyn Fn(&[GitHostConnection]) -> Result<(), String> + Sync),
    persist_token: &(dyn Fn(&str, &str) -> Result<(), String> + Sync),
) -> Result<(), String>
where
    P: FnOnce(GitHostProbeRequest) -> Fut,
    Fut: std::future::Future<Output = Result<GitHostProbeResult, String>>,
{
    let conn = auth
        .connection(id)
        .await
        .ok_or_else(|| format!("Unknown connection '{}'.", id))?;
    let plan = plan_connection_update(&conn, &update)?;

    // (2) Validate the replacement before the old one is anywhere near being
    // overwritten. The origin comes from the STORED connection, never from the
    // request, so a rotation cannot be redirected to another host.
    let new_token = if plan.rotates_token {
        let token = update
            .token
            .as_deref()
            .unwrap_or_default()
            .trim()
            .to_string();
        let spec = update.probe.clone().ok_or_else(|| {
            "A replacement token must be verified before it is saved.".to_string()
        })?;
        let result = probe(spec.into_request(conn.base_url.clone(), token.clone())).await?;
        if result.outcome != GitHostProbeOutcome::Ok {
            return Err(rotation_refusal(result.outcome));
        }
        Some(token)
    } else {
        None
    };

    // (3) Label.
    if let Some(new_label) = plan.label.clone() {
        let mut conns = auth.connections.write().await;
        let Some(slot) = conns.iter_mut().find(|c| c.id == id) else {
            return Err(format!("Unknown connection '{}'.", id));
        };
        let previous = std::mem::replace(&mut slot.label, new_label);
        if let Err(e) = persist_connections(&conns) {
            if let Some(slot) = conns.iter_mut().find(|c| c.id == id) {
                slot.label = previous;
            }
            return Err(e);
        }
    }

    // (4) Token. The keyring is written first; the in-memory map is only
    // updated once the durable copy is there, so a keyring failure cannot
    // leave this process using a credential that will not survive a restart.
    if let Some(token) = new_token {
        persist_token(id, &token)?;
        auth.tokens.write().await.insert(id.to_string(), token);
        info!("Rotated the token for git-host connection '{}'", id);
    }
    Ok(())
}

/// Edit an existing connection in place: a new token, a new display name, or
/// both. Keyed by connection id, so nothing else has to be re-pointed — the
/// token is rewritten under the connection's existing keyring account.
///
/// Works for the built-in GitHub connection too (`id == "github"`), whose
/// account is the historical `github-token`; only its *label* is fixed.
///
/// A replacement token is probed against the connection's stored base URL
/// first, and anything short of a clean pass aborts the whole update with the
/// previous credential untouched.
#[tauri::command]
pub async fn git_host_update_connection(
    auth: State<'_, GitHubAuthState>,
    id: String,
    update: GitHostConnectionUpdate,
) -> Result<(), String> {
    update_connection_inner(
        &auth,
        &id,
        update,
        crate::commands::git_host_probe::probe_credential,
        &save_host_connections,
        &save_host_token,
    )
    .await
}

/// Client for the commands that legitimately target `api.github.com` directly
/// (the AI features, the GraphQL draft toggle, check-runs, inline reviews).
///
/// **This used to read the token of the connection literally named `github`,
/// not the token of the *active* connection.** Every caller is preceded by a
/// capability guard, so on a correctly-guarded path the two coincide — but the
/// coupling was implicit, and the one command that shipped without its guard
/// (`github_reply_to_pr_review_comment`, fixed in `b3de2bdf`) turned that into
/// a live credential leak. Resolving the *active* connection and asserting its
/// kind makes the invariant explicit and enforced here, so a future
/// missing-guard bug fails closed instead of reaching for the GitHub token.
async fn github_client_from_state(auth: &GitHubAuthState) -> Result<reqwest::Client, String> {
    let id = auth.active_connection_id.read().await.clone();
    let conn = auth
        .connection(&id)
        .await
        // An unresolvable active id means we cannot prove which host this is,
        // so we refuse rather than defaulting to GitHub and its token.
        .ok_or_else(|| format!("Unknown git-host connection '{}'.", id))?;
    if conn.kind != GitHostKind::GitHub {
        return Err(format!(
            "This action is available on GitHub workspaces only — the active connection is {}.",
            conn.kind.label()
        ));
    }
    let token = auth
        .tokens
        .read()
        .await
        .get(&conn.id)
        .cloned()
        .ok_or_else(|| "GitHub token not set. Connect first.".to_string())?;
    github_client(&token)
}

async fn github_get_issue_with_client(
    client: &reqwest::Client,
    host: &GitHost,
    r: &RepoRef,
    issue_number: u32,
) -> Result<String, String> {
    let resp = client
        .get(host.url(&host.issue_path(r, issue_number)))
        .send()
        .await
        .map_err(|e| format!("Request failed: {}", e))?;
    let body = github_response_text(resp).await?;
    normalize_one(host, body, git_host::normalize_issue)
}

#[tauri::command]
pub async fn github_list_repos(auth: State<'_, GitHubAuthState>) -> Result<String, String> {
    let (client, host) = active_host_session(auth.inner()).await?;
    let resp = client
        .get(host.url(&host.user_repos_path(1)))
        .send()
        .await
        .map_err(|e| format!("Request failed: {}", e))?;
    let body = github_response_text(resp).await?;
    normalize_list(&host, body, git_host::normalize_repo)
}

#[derive(serde::Serialize)]
pub struct GhUser {
    pub login: String,
    #[serde(rename = "avatarUrl")]
    pub avatar_url: String,
}

/// Fetch the authenticated user (`GET /user`). Used to render the correct
/// "Connected · {username}" badge regardless of which org's repo is selected.
#[tauri::command]
pub async fn github_get_authenticated_user(
    auth: State<'_, GitHubAuthState>,
) -> Result<GhUser, String> {
    // G4: route to the active host. GitHub and Gitea both return
    // {login, avatar_url} from `/user`; GitLab returns {username, avatar_url}
    // and is projected onto the same shape.
    let (client, host) = active_host_session(auth.inner()).await?;
    let resp = client
        .get(host.url(host.user_path()))
        .send()
        .await
        .map_err(|e| format!("Request failed: {}", e))?;
    let body = normalize_one(
        &host,
        github_response_text(resp).await?,
        git_host::normalize_authenticated_user,
    )?;
    let parsed: serde_json::Value =
        serde_json::from_str(&body).map_err(|e| format!("Failed to parse user: {}", e))?;
    let login = parsed["login"]
        .as_str()
        .filter(|s| !s.is_empty())
        .ok_or_else(|| format!("{} /user response missing a username", host.kind.label()))?
        .to_string();
    let avatar_url = parsed["avatar_url"].as_str().unwrap_or("").to_string();
    Ok(GhUser { login, avatar_url })
}

/// GP6: list a repo's releases. GitHub and Gitea share
/// `/repos/{o}/{r}/releases`; GitLab's `/projects/{p}/releases` is projected
/// onto the same shape.
#[tauri::command]
pub async fn github_list_releases(
    auth: State<'_, GitHubAuthState>,
    owner: String,
    repo: String,
) -> Result<String, String> {
    let (client, host, r) = repo_session(auth.inner(), &owner, &repo).await?;
    let resp = client
        .get(host.url(&host.releases_path(&r, 30)))
        .send()
        .await
        .map_err(|e| format!("Request failed: {}", e))?;
    let body = github_response_text(resp).await?;
    normalize_list(&host, body, git_host::normalize_release)
}

#[tauri::command]
pub async fn github_list_issues(
    auth: State<'_, GitHubAuthState>,
    owner: String,
    repo: String,
) -> Result<String, String> {
    let (client, host, r) = repo_session(auth.inner(), &owner, &repo).await?;
    let resp = client
        .get(host.url(&host.issues_path(&r, ListState::Open, 50, 1)))
        .send()
        .await
        .map_err(|e| format!("Request failed: {}", e))?;
    let body = normalize_list(
        &host,
        github_response_text(resp).await?,
        git_host::normalize_issue,
    )?;
    // GitHub's /issues endpoint returns BOTH issues and PRs; PRs carry a
    // `pull_request` object on each item. Strip them server-side so the
    // Issues tab badge and list show only real issues. (GitLab's issue
    // endpoint never returns merge requests, so nothing is filtered there.)
    match serde_json::from_str::<Vec<serde_json::Value>>(&body) {
        Ok(items) => {
            let filtered: Vec<serde_json::Value> = items
                .into_iter()
                .filter(|item| item.get("pull_request").is_none())
                .collect();
            serde_json::to_string(&filtered)
                .map_err(|e| format!("Failed to serialize issues: {}", e))
        }
        // If the response is not an array (e.g. error envelope leaked through),
        // pass it through unchanged so the frontend can surface the original
        // error text.
        Err(_) => Ok(body),
    }
}

#[tauri::command]
pub async fn github_get_issue(
    auth: State<'_, GitHubAuthState>,
    owner: String,
    repo: String,
    issue_number: u32,
) -> Result<String, String> {
    let (client, host, r) = repo_session(auth.inner(), &owner, &repo).await?;
    github_get_issue_with_client(&client, &host, &r, issue_number).await
}

/// GP7: create a host issue for an Issue↔Flight mirror. Labels and milestone
/// are applied through the existing host-aware mutators so Gitea's id-based
/// label contract remains centralized.
#[tauri::command]
pub async fn github_create_issue(
    auth: State<'_, GitHubAuthState>,
    owner: String,
    repo: String,
    title: String,
    body: String,
) -> Result<String, String> {
    super::validate_input_size(&title, 512, "issue title")?;
    super::validate_input_size(&body, 250_000, "issue body")?;
    if title.trim().is_empty() {
        return Err("Issue title cannot be empty".to_string());
    }
    let (client, host, r) = repo_session(auth.inner(), &owner, &repo).await?;
    // GitLab names the prose field `description`; sending `body` there is
    // accepted and silently ignored, producing an issue with no text.
    let body_field = match host.kind {
        GitHostKind::GitLab => "description",
        _ => "body",
    };
    let response = client
        .post(host.url(&host.issues_create_path(&r)))
        .json(&serde_json::json!({ "title": title.trim(), body_field: body }))
        .send()
        .await
        .map_err(|error| format!("Request failed: {error}"))?;
    let text = github_response_text(response).await?;
    normalize_one(&host, text, git_host::normalize_issue)
}

/// GP7: update mirror-owned prose/title in one revision-fenced write.
#[tauri::command]
pub async fn github_update_issue(
    auth: State<'_, GitHubAuthState>,
    owner: String,
    repo: String,
    number: u32,
    title: String,
    body: String,
) -> Result<String, String> {
    super::validate_input_size(&title, 512, "issue title")?;
    super::validate_input_size(&body, 250_000, "issue body")?;
    if title.trim().is_empty() {
        return Err("Issue title cannot be empty".to_string());
    }
    patch_issue(auth.inner(), &owner, &repo, number, |host| {
        let body_field = match host.kind {
            GitHostKind::GitLab => "description",
            _ => "body",
        };
        serde_json::json!({ "title": title.trim(), body_field: body })
    })
    .await
}

/// `POST /repos/{owner}/{repo}/pulls` — create a Pull Request.
///
/// v0.8-G: extended with an optional `draft` flag. When omitted (legacy
/// callers), GitHub treats the PR as a normal, ready-for-review PR. When
/// `Some(true)`, GitHub opens the PR in draft state. Repos must support
/// draft PRs (free public + paid private). If the repo doesn't, GitHub
/// returns a 422 and the error surfaces verbatim.
#[tauri::command]
pub async fn github_create_pr(
    auth: State<'_, GitHubAuthState>,
    owner: String,
    repo: String,
    title: String,
    body: String,
    head: String,
    base: String,
    draft: Option<bool>,
    connection_id: Option<String>,
) -> Result<String, String> {
    let (client, host, r) =
        repo_session_for_connection(auth.inner(), &owner, &repo, connection_id.as_deref()).await?;
    // Field names, and the very meaning of "draft", differ per host — see
    // `GitHost::create_change_request_body`.
    let payload = host.create_change_request_body(&title, &body, &head, &base, draft);
    let resp = client
        .post(host.url(&host.change_requests_create_path(&r)))
        .json(&payload)
        .send()
        .await
        .map_err(|e| format!("Request failed: {}", e))?;
    let text = github_response_text(resp).await?;
    normalize_one(&host, text, git_host::normalize_change_request)
}

#[tauri::command]
pub async fn github_list_prs(
    auth: State<'_, GitHubAuthState>,
    owner: String,
    repo: String,
) -> Result<String, String> {
    let (client, host, r) = repo_session(auth.inner(), &owner, &repo).await?;
    let resp = client
        .get(host.url(&host.change_requests_path(&r, ListState::Open, 30, 1)))
        .send()
        .await
        .map_err(|e| format!("Request failed: {}", e))?;
    let body = github_response_text(resp).await?;
    normalize_list(&host, body, git_host::normalize_change_request)
}

#[tauri::command]
pub async fn github_get_pr_diff(
    auth: State<'_, GitHubAuthState>,
    owner: String,
    repo: String,
    pr_number: u32,
) -> Result<String, String> {
    // G6: three hosts, three mechanisms, one unified-diff result — GitHub via a
    // media-type Accept header on the PR resource, Gitea via a `.diff` URL
    // suffix, GitLab via its `raw_diffs` sub-resource. Route through the active
    // host's client so auth is correct for all three.
    let (client, host, r) = repo_session(auth.inner(), &owner, &repo).await?;
    let url = host.url(&host.change_request_diff_path(&r, pr_number));
    let mut req = client.get(url);
    if let Some(accept) = host.change_request_diff_accept() {
        req = req.header(ACCEPT, accept);
    }
    let resp = req
        .send()
        .await
        .map_err(|e| format!("Request failed: {}", e))?;

    github_response_text(resp).await
}

// === v0.8-C: issue interactivity (comments, state, labels, assignees,
// milestones, repo metadata pickers, pagination) ===========================

/// Comment DTO matching GitHub's `/issues/{n}/comments` response shape with a
/// thin avatar URL projection.
#[derive(serde::Serialize)]
pub struct GhCommentUser {
    pub login: String,
    pub avatar_url: String,
}

#[derive(serde::Serialize)]
pub struct GhIssueComment {
    pub id: u64,
    pub user: GhCommentUser,
    pub body: String,
    pub created_at: String,
    pub updated_at: String,
    pub html_url: String,
}

fn parse_comment(v: &serde_json::Value) -> GhIssueComment {
    let user = v.get("user");
    GhIssueComment {
        id: v.get("id").and_then(|x| x.as_u64()).unwrap_or(0),
        user: GhCommentUser {
            login: user
                .and_then(|u| u.get("login"))
                .and_then(|x| x.as_str())
                .unwrap_or("")
                .to_string(),
            avatar_url: user
                .and_then(|u| u.get("avatar_url"))
                .and_then(|x| x.as_str())
                .unwrap_or("")
                .to_string(),
        },
        body: v
            .get("body")
            .and_then(|x| x.as_str())
            .unwrap_or("")
            .to_string(),
        created_at: v
            .get("created_at")
            .and_then(|x| x.as_str())
            .unwrap_or("")
            .to_string(),
        updated_at: v
            .get("updated_at")
            .and_then(|x| x.as_str())
            .unwrap_or("")
            .to_string(),
        html_url: v
            .get("html_url")
            .and_then(|x| x.as_str())
            .unwrap_or("")
            .to_string(),
    }
}

#[tauri::command]
pub async fn github_list_issue_comments(
    auth: State<'_, GitHubAuthState>,
    owner: String,
    repo: String,
    number: u32,
) -> Result<Vec<GhIssueComment>, String> {
    let (client, host, r) = repo_session(auth.inner(), &owner, &repo).await?;
    let resp = client
        .get(host.url(&host.issue_comments_path(&r, number, 100)))
        .send()
        .await
        .map_err(|e| format!("Request failed: {}", e))?;
    let body = normalize_list(
        &host,
        github_response_text(resp).await?,
        git_host::normalize_comment,
    )?;
    let arr: Vec<serde_json::Value> =
        serde_json::from_str(&body).map_err(|e| format!("Failed to parse comments: {}", e))?;
    Ok(arr.iter().map(parse_comment).collect())
}

#[tauri::command]
pub async fn github_post_issue_comment(
    auth: State<'_, GitHubAuthState>,
    owner: String,
    repo: String,
    number: u32,
    body: String,
) -> Result<GhIssueComment, String> {
    let trimmed = body.trim();
    if trimmed.is_empty() {
        return Err("Comment body cannot be empty".to_string());
    }
    let (client, host, r) = repo_session(auth.inner(), &owner, &repo).await?;
    let resp = client
        .post(host.url(&host.issue_comment_create_path(&r, number)))
        .json(&serde_json::json!({ "body": trimmed }))
        .send()
        .await
        .map_err(|e| format!("Request failed: {}", e))?;
    let text = normalize_one(
        &host,
        github_response_text(resp).await?,
        git_host::normalize_comment,
    )?;
    let v: serde_json::Value =
        serde_json::from_str(&text).map_err(|e| format!("Failed to parse comment: {}", e))?;
    Ok(parse_comment(&v))
}

/// Update an issue in place. The payload is built by the caller *from the
/// resolved host*, because the field names diverge (`state` vs `state_event`,
/// `body` vs `description`, `milestone` vs `milestone_id`) and GitLab silently
/// ignores an unknown field rather than erroring — a mis-named field there is a
/// 200 OK that changes nothing.
async fn patch_issue<F>(
    auth: &GitHubAuthState,
    owner: &str,
    repo: &str,
    number: u32,
    build_payload: F,
) -> Result<String, String>
where
    F: FnOnce(&GitHost) -> serde_json::Value,
{
    let (client, host, r) = repo_session(auth, owner, repo).await?;
    let payload = build_payload(&host);
    let resp = client
        // GitLab updates with PUT where GitHub and Gitea use PATCH.
        .request(host.update_method(), host.url(&host.issue_path(&r, number)))
        .json(&payload)
        .send()
        .await
        .map_err(|e| format!("Request failed: {}", e))?;
    let text = github_response_text(resp).await?;
    normalize_one(&host, text, git_host::normalize_issue)
}

#[tauri::command]
pub async fn github_close_issue(
    auth: State<'_, GitHubAuthState>,
    owner: String,
    repo: String,
    number: u32,
) -> Result<String, String> {
    patch_issue(auth.inner(), &owner, &repo, number, |host| {
        host.state_change_body(false)
    })
    .await
}

#[tauri::command]
pub async fn github_reopen_issue(
    auth: State<'_, GitHubAuthState>,
    owner: String,
    repo: String,
    number: u32,
) -> Result<String, String> {
    patch_issue(auth.inner(), &owner, &repo, number, |host| {
        host.state_change_body(true)
    })
    .await
}

#[tauri::command]
pub async fn github_set_issue_assignees(
    auth: State<'_, GitHubAuthState>,
    owner: String,
    repo: String,
    number: u32,
    assignees: Vec<String>,
) -> Result<String, String> {
    // GitLab assigns by numeric `assignee_ids`, not by username. The frontend
    // only ever has logins, and GitLab would accept + ignore an `assignees`
    // field, so refuse instead of pretending the write landed.
    require_capability(auth.inner(), HostCapability::AssigneesByLogin).await?;
    patch_issue(
        auth.inner(),
        &owner,
        &repo,
        number,
        |_| serde_json::json!({ "assignees": assignees }),
    )
    .await
}

#[tauri::command]
pub async fn github_set_issue_labels(
    auth: State<'_, GitHubAuthState>,
    owner: String,
    repo: String,
    number: u32,
    labels: Vec<String>,
) -> Result<String, String> {
    let (client, host, r) = repo_session(auth.inner(), &owner, &repo).await?;
    // Three contracts for one operation:
    //   GitHub — PUT /issues/{n}/labels with an array of label *names*
    //   Gitea  — the same sub-resource, but an array of label *ids*
    //   GitLab — no sub-resource at all: a comma-joined string on the issue
    let Some(labels_path) = host.issue_labels_path(&r, number) else {
        return patch_issue(auth.inner(), &owner, &repo, number, |host| {
            host.labels_body_from_names(&labels)
        })
        .await;
    };
    let payload = match host.kind {
        GitHostKind::Gitea => {
            let ids = resolve_gitea_label_ids(&client, &host, &r, &labels).await?;
            // Labels PUT is a full replace — if the caller asked for labels but
            // NONE resolved to a Gitea id, refuse rather than silently clearing
            // every existing label.
            if !labels.is_empty() && ids.is_empty() {
                return Err(
                    "None of the requested labels exist on this Gitea repository.".to_string(),
                );
            }
            serde_json::json!({ "labels": ids })
        }
        _ => host.labels_body_from_names(&labels),
    };
    let resp = client
        .put(host.url(&labels_path))
        .json(&payload)
        .send()
        .await
        .map_err(|e| format!("Request failed: {}", e))?;
    github_response_text(resp).await
}

/// Gitea's issue-label PUT takes label ids, not names. Fetch the repo's labels
/// and map the requested names to ids (unknown names are dropped).
async fn resolve_gitea_label_ids(
    client: &reqwest::Client,
    host: &GitHost,
    r: &RepoRef,
    names: &[String],
) -> Result<Vec<u64>, String> {
    let url = host.url(&host.labels_path(r, 100));
    let resp = client
        .get(url)
        .send()
        .await
        .map_err(|e| format!("Request failed: {}", e))?;
    let body = github_response_text(resp).await?;
    let all: Vec<serde_json::Value> =
        serde_json::from_str(&body).map_err(|e| format!("Failed to parse labels: {}", e))?;
    let ids = names
        .iter()
        .filter_map(|name| {
            all.iter()
                .find(|l| l["name"].as_str() == Some(name.as_str()))
                .and_then(|l| l["id"].as_u64())
        })
        .collect();
    Ok(ids)
}

#[tauri::command]
pub async fn github_set_issue_milestone(
    auth: State<'_, GitHubAuthState>,
    owner: String,
    repo: String,
    number: u32,
    milestone: Option<u64>,
) -> Result<String, String> {
    patch_issue(auth.inner(), &owner, &repo, number, |host| {
        host.milestone_body(milestone)
    })
    .await
}

#[tauri::command]
pub async fn github_list_repo_labels(
    auth: State<'_, GitHubAuthState>,
    owner: String,
    repo: String,
) -> Result<String, String> {
    let (client, host, r) = repo_session(auth.inner(), &owner, &repo).await?;
    let resp = client
        .get(host.url(&host.labels_path(&r, 100)))
        .send()
        .await
        .map_err(|e| format!("Request failed: {}", e))?;
    let body = github_response_text(resp).await?;
    normalize_list(&host, body, git_host::normalize_label)
}

#[tauri::command]
pub async fn github_list_repo_milestones(
    auth: State<'_, GitHubAuthState>,
    owner: String,
    repo: String,
) -> Result<String, String> {
    let (client, host, r) = repo_session(auth.inner(), &owner, &repo).await?;
    let resp = client
        .get(host.url(&host.milestones_path(&r, 100)))
        .send()
        .await
        .map_err(|e| format!("Request failed: {}", e))?;
    let body = github_response_text(resp).await?;
    normalize_list(&host, body, git_host::normalize_milestone_row)
}

#[tauri::command]
pub async fn github_create_repo_milestone(
    auth: State<'_, GitHubAuthState>,
    owner: String,
    repo: String,
    title: String,
    description: String,
) -> Result<String, String> {
    super::validate_input_size(&title, 512, "milestone title")?;
    super::validate_input_size(&description, 10_000, "milestone description")?;
    if title.trim().is_empty() {
        return Err("Milestone title cannot be empty".to_string());
    }
    let (client, host, r) = repo_session(auth.inner(), &owner, &repo).await?;
    let response = client
        .post(host.url(&host.milestones_create_path(&r)))
        .json(&serde_json::json!({
            "title": title.trim(),
            "description": description
        }))
        .send()
        .await
        .map_err(|error| format!("Request failed: {error}"))?;
    let body = github_response_text(response).await?;
    normalize_one(&host, body, git_host::normalize_milestone_row)
}

#[tauri::command]
pub async fn github_list_repo_assignable_users(
    auth: State<'_, GitHubAuthState>,
    owner: String,
    repo: String,
) -> Result<String, String> {
    let (client, host, r) = repo_session(auth.inner(), &owner, &repo).await?;
    let resp = client
        .get(host.url(&host.assignable_users_path(&r, 100)))
        .send()
        .await
        .map_err(|e| format!("Request failed: {}", e))?;
    let body = github_response_text(resp).await?;
    normalize_list(&host, body, git_host::normalize_member)
}

#[tauri::command]
pub async fn github_list_issues_page(
    auth: State<'_, GitHubAuthState>,
    owner: String,
    repo: String,
    state: String,
    page: u32,
) -> Result<String, String> {
    let (client, host, r) = repo_session(auth.inner(), &owner, &repo).await?;
    let resp = client
        .get(host.url(&host.issues_path(&r, ListState::parse(&state), 30, page)))
        .send()
        .await
        .map_err(|e| format!("Request failed: {}", e))?;
    // All three hosts emit RFC5988 Link headers with rel="next". (GitLab also
    // sends `x-next-page`, but its Link header is documented and present, so
    // one detection path serves every host.)
    let has_more = resp
        .headers()
        .get(LINK)
        .and_then(|value| value.to_str().ok())
        .is_some_and(|link| link.contains("rel=\"next\""));
    let body = normalize_list(
        &host,
        github_response_text(resp).await?,
        git_host::normalize_issue,
    )?;
    match serde_json::from_str::<Vec<serde_json::Value>>(&body) {
        Ok(items) => {
            let filtered: Vec<serde_json::Value> = items
                .into_iter()
                .filter(|item| item.get("pull_request").is_none())
                .collect();
            serde_json::to_string(&serde_json::json!({
                "items": filtered,
                "has_more": has_more,
            }))
            .map_err(|e| format!("Failed to serialize issues: {}", e))
        }
        Err(_) => Ok(body),
    }
}

#[tauri::command]
pub async fn github_list_prs_page(
    auth: State<'_, GitHubAuthState>,
    owner: String,
    repo: String,
    state: String,
    page: u32,
) -> Result<String, String> {
    let (client, host, r) = repo_session(auth.inner(), &owner, &repo).await?;
    let resp = client
        .get(host.url(&host.change_requests_path(&r, ListState::parse(&state), 30, page)))
        .send()
        .await
        .map_err(|e| format!("Request failed: {}", e))?;
    let body = github_response_text(resp).await?;
    normalize_list(&host, body, git_host::normalize_change_request)
}

#[tauri::command]
pub async fn github_list_repos_page(
    auth: State<'_, GitHubAuthState>,
    page: u32,
) -> Result<String, String> {
    let (client, host) = active_host_session(auth.inner()).await?;
    let resp = client
        .get(host.url(&host.user_repos_path(page)))
        .send()
        .await
        .map_err(|e| format!("Request failed: {}", e))?;
    let body = github_response_text(resp).await?;
    normalize_list(&host, body, git_host::normalize_repo)
}

#[tauri::command]
pub async fn github_investigate_issue(
    auth: State<'_, GitHubAuthState>,
    project_path: String,
    owner: String,
    repo: String,
    issue_number: u32,
) -> Result<String, String> {
    super::validate_project_path(&project_path)?;
    require_capability(auth.inner(), HostCapability::AiAssist).await?;
    validate_github_name(&owner, "owner")?;
    validate_github_name(&repo, "repo")?;
    let client = github_client_from_state(auth.inner()).await?;

    // Guarded to GitHub above, so the coordinate is a plain two-segment one.
    let issue_ref = RepoRef::new(&owner, &repo)?;
    let issue_json =
        github_get_issue_with_client(&client, &GitHost::github(), &issue_ref, issue_number).await?;
    let issue: serde_json::Value =
        serde_json::from_str(&issue_json).map_err(|e| format!("Failed to parse issue: {}", e))?;

    let title = issue["title"].as_str().unwrap_or("Unknown");
    let body = issue["body"].as_str().unwrap_or("No description");

    // v0.8-E: prompt construction moved to `core::github_ai_prompts` so all
    // GitHub AI features share one home. Behaviour here is identical to the
    // pre-v0.8-E inline format — same string, same `run_claude` invocation.
    let prompt = crate::core::github_ai_prompts::investigate_issue_prompt(title, body);

    crate::claude::binary::run_claude(&prompt, Some(&project_path)).await
}

// === v0.8-E: AI PR description + AI pre-flight code review =================
//
// Both commands run a one-shot auxiliary LLM turn and stream assistant
// chunks to the frontend over the existing `api-agent:chunk:<sessionId>` /
// `api-agent:done:<sessionId>` event channels — the same wire shape every
// API-agent conversation uses, so the frontend listener code in
// `PRDescriptionButton.tsx` / `PRReviewPanel.tsx` is just a thin
// chunk-buffer + done-resolver pair.
//
// WI-1 (`dev/oauth-removal-plan.md`): these used to fire
// `SidecarManager::forward_start("claude-oauth")`, silently routing the
// user's Claude subscription credentials. Provider + model now come from the
// routing layer (`core::aux_llm`) — the configured route, else the cheapest
// configured API key, else a clear error. Never OAuth.
//
// The Tauri command itself returns the freshly minted `session_id` to the
// caller and does NOT block on the assistant turn; `spawn_aux_stream` owns
// the turn and emits the terminal `done` / `error` event.

/// Maximum raw diff bytes shipped to the model. PR-description prompts get
/// less context than reviews; bumping either is cheap.
const PR_DESCRIPTION_DIFF_CAP_BYTES: usize = 50 * 1024;
const PR_REVIEW_DIFF_CAP_BYTES: usize = 75 * 1024;
const PR_DESCRIPTION_COMMIT_CAP: usize = 50;
/// Task classes for the routing layer. Provider and model come from
/// `core::aux_llm` — there are no provider/model constants here, by design.
const AI_PR_DESCRIPTION_TASK: crate::core::aux_llm::AuxTaskClass =
    crate::core::aux_llm::AuxTaskClass::PrDescription;
const AI_PR_REVIEW_TASK: crate::core::aux_llm::AuxTaskClass =
    crate::core::aux_llm::AuxTaskClass::PrReview;

/// Cut `text` to at most `cap` bytes ending on a UTF-8 boundary. Returns
/// `(text, was_truncated, original_byte_len)`. Appends a graceful marker
/// when truncated so the model sees a clean stop.
fn truncate_for_model(text: &str, cap: usize) -> (String, bool, usize) {
    let original_len = text.len();
    if original_len <= cap {
        return (text.to_string(), false, original_len);
    }
    let mut end = cap;
    while end > 0 && !text.is_char_boundary(end) {
        end -= 1;
    }
    let mut s = text[..end].to_string();
    s.push_str(&format!(
        "\n\n... (truncated, original size {} bytes)\n",
        original_len
    ));
    (s, true, original_len)
}

/// `GET /repos/{o}/{r}/compare/{base}...{head}` with `Accept:
/// application/vnd.github.v3.diff` — returns the raw unified diff blob.
async fn fetch_compare_patch(
    auth: &GitHubAuthState,
    owner: &str,
    repo: &str,
    base: &str,
    head: &str,
) -> Result<String, String> {
    // Sibling defect to `github_client_from_state`: this used to read the
    // token of the connection named "github" out of the map itself and build a
    // bare client around it, so it had its own private answer to "which
    // credential for which host". Routing through the one accessor means the
    // GitHub-kind assertion cannot be skipped here. Only the media type is
    // per-request, so it goes on the request rather than the client.
    let client = github_client_from_state(auth).await?;
    let url = format!(
        "https://api.github.com/repos/{}/{}/compare/{}...{}",
        owner, repo, base, head
    );
    let resp = client
        .get(&url)
        .header(ACCEPT, "application/vnd.github.v3.diff")
        .send()
        .await
        .map_err(|e| format!("Request failed: {}", e))?;
    github_response_text(resp).await
}

/// `GET /repos/{o}/{r}/commits?sha={head}&per_page=N` — fetch the latest N
/// commits on `head`. Returns message strings only, reversed to
/// chronological order.
async fn fetch_commit_messages(
    auth: &GitHubAuthState,
    owner: &str,
    repo: &str,
    head: &str,
    per_page: usize,
) -> Result<Vec<String>, String> {
    let client = github_client_from_state(auth).await?;
    let url = format!(
        "https://api.github.com/repos/{}/{}/commits?sha={}&per_page={}",
        owner, repo, head, per_page
    );
    let resp = client
        .get(&url)
        .send()
        .await
        .map_err(|e| format!("Request failed: {}", e))?;
    let body = github_response_text(resp).await?;
    let arr: Vec<serde_json::Value> =
        serde_json::from_str(&body).map_err(|e| format!("Failed to parse commits: {}", e))?;
    let mut msgs: Vec<String> = arr
        .iter()
        .filter_map(|v| {
            v.get("commit")
                .and_then(|c| c.get("message"))
                .and_then(|m| m.as_str())
        })
        .map(|s| s.to_string())
        .collect();
    msgs.reverse();
    Ok(msgs)
}

/// Fetch one issue's title + body. Failures (404, private, network) are
/// returned as `None` so the caller silently skips rather than failing the
/// whole command.
async fn fetch_issue_title_body(
    client: &reqwest::Client,
    owner: &str,
    repo: &str,
    number: u32,
) -> Option<(String, String)> {
    let url = format!(
        "https://api.github.com/repos/{}/{}/issues/{}",
        owner, repo, number
    );
    let resp = client.get(&url).send().await.ok()?;
    if !resp.status().is_success() {
        return None;
    }
    let body = resp.text().await.ok()?;
    let v: serde_json::Value = serde_json::from_str(&body).ok()?;
    let title = v
        .get("title")
        .and_then(|x| x.as_str())
        .unwrap_or("")
        .to_string();
    let issue_body = v
        .get("body")
        .and_then(|x| x.as_str())
        .unwrap_or("")
        .to_string();
    Some((title, issue_body))
}

/// `github_ai_pr_description` — kick off a one-shot auxiliary LLM turn that
/// writes a structured PR description from a base..head diff, the branch's
/// recent commits, and (optionally) the linked-issue bodies.
///
/// Returns the freshly minted `session_id`. The caller subscribes to
/// `api-agent:chunk:<sessionId>` for streamed text deltas and
/// `api-agent:done:<sessionId>` for completion. The command does not wait
/// for the assistant turn to finish.
///
/// Returns `Err` before any model call when no API provider is configured;
/// see [`crate::core::aux_llm`].
#[tauri::command]
pub async fn github_ai_pr_description(
    app_handle: tauri::AppHandle,
    auth: State<'_, GitHubAuthState>,
    routing: State<'_, crate::core::aux_llm::AuxRoutingState>,
    owner: String,
    repo: String,
    base: String,
    head: String,
    draft_title: Option<String>,
    linked_issue_numbers: Option<Vec<u32>>,
    // v0.8 race-fix: lets the frontend pre-allocate the session id (e.g.
    // via `crypto.randomUUID()`) BEFORE invoking, so listeners can be
    // attached first and no early chunks are dropped. Falls back to a
    // server-side UUID when the caller doesn't supply one.
    session_id_override: Option<String>,
) -> Result<String, String> {
    validate_github_name(&owner, "owner")?;
    validate_github_name(&repo, "repo")?;

    // Resolve the route BEFORE the GitHub fetches so "no provider configured"
    // fails instantly instead of after a multi-second diff download.
    let route = routing.resolve(AI_PR_DESCRIPTION_TASK)?;

    require_capability(auth.inner(), HostCapability::AiAssist).await?;

    let auth_inner = auth.inner();

    let (diff_result, commits_result) = tokio::join!(
        fetch_compare_patch(auth_inner, &owner, &repo, &base, &head),
        fetch_commit_messages(auth_inner, &owner, &repo, &head, PR_DESCRIPTION_COMMIT_CAP),
    );
    let diff_raw = diff_result?;
    let commit_messages = commits_result.unwrap_or_else(|e| {
        warn!(
            error = %e,
            "github_ai_pr_description: commit fetch failed, continuing without commit context"
        );
        Vec::new()
    });

    let linked_inputs: Vec<(u32, String, String)> = if let Some(nums) = linked_issue_numbers {
        let client = github_client_from_state(auth_inner).await?;
        let futures = nums.iter().map(|n| {
            let client = client.clone();
            let owner = owner.clone();
            let repo = repo.clone();
            let n = *n;
            async move {
                fetch_issue_title_body(&client, &owner, &repo, n)
                    .await
                    .map(|(t, b)| (n, t, b))
            }
        });
        let results = futures::future::join_all(futures).await;
        results.into_iter().flatten().collect()
    } else {
        Vec::new()
    };

    let (diff_text, truncated, original) =
        truncate_for_model(&diff_raw, PR_DESCRIPTION_DIFF_CAP_BYTES);

    let linked_refs: Vec<crate::core::github_ai_prompts::LinkedIssueInput<'_>> = linked_inputs
        .iter()
        .map(
            |(n, t, b)| crate::core::github_ai_prompts::LinkedIssueInput {
                number: *n,
                title: t.as_str(),
                body: b.as_str(),
            },
        )
        .collect();

    let user_turn = crate::core::github_ai_prompts::pr_description_user_turn(
        &owner,
        &repo,
        &base,
        &head,
        draft_title.as_deref(),
        &diff_text,
        truncated,
        original,
        &commit_messages,
        &linked_refs,
    );

    let session_id = session_id_override
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| format!("ai-pr-description-{}", uuid::Uuid::new_v4()));

    info!(
        owner = %owner,
        repo = %repo,
        base = %base,
        head = %head,
        session_id = %session_id,
        provider = %route.provider,
        model = %route.model,
        "AI PR description session started"
    );

    crate::core::aux_llm::spawn_aux_stream(
        app_handle,
        AI_PR_DESCRIPTION_TASK,
        route,
        session_id.clone(),
        crate::core::github_ai_prompts::PR_DESCRIPTION_SYSTEM_PROMPT.to_string(),
        user_turn,
    );

    Ok(session_id)
}

/// `github_ai_pr_review` — kick off a one-shot auxiliary LLM turn that
/// produces a structured pre-flight code review (Blocking / Asks / Nits
/// sections) over an existing PR's diff.
///
/// Returns the freshly minted `session_id`. See [`github_ai_pr_description`]
/// for the event-channel + lifecycle contract and the no-provider error.
#[tauri::command]
pub async fn github_ai_pr_review(
    app_handle: tauri::AppHandle,
    auth: State<'_, GitHubAuthState>,
    routing: State<'_, crate::core::aux_llm::AuxRoutingState>,
    owner: String,
    repo: String,
    pr_number: u32,
    // v0.8 race-fix: see `github_ai_pr_description::session_id_override`.
    // Frontend pre-allocates the session id so it can subscribe BEFORE the
    // turn starts emitting chunks.
    session_id_override: Option<String>,
) -> Result<String, String> {
    validate_github_name(&owner, "owner")?;
    validate_github_name(&repo, "repo")?;

    // Resolve the route before the GitHub fetches — fail fast, fail clearly.
    let route = routing.resolve(AI_PR_REVIEW_TASK)?;

    require_capability(auth.inner(), HostCapability::AiAssist).await?;

    let client = github_client_from_state(auth.inner()).await?;
    let pr_url = format!(
        "https://api.github.com/repos/{}/{}/pulls/{}",
        owner, repo, pr_number
    );
    let pr_resp = client
        .get(&pr_url)
        .send()
        .await
        .map_err(|e| format!("Request failed: {}", e))?;
    let pr_body_text = github_response_text(pr_resp).await?;
    let pr_json: serde_json::Value =
        serde_json::from_str(&pr_body_text).map_err(|e| format!("Failed to parse PR: {}", e))?;
    let pr_title = pr_json
        .get("title")
        .and_then(|x| x.as_str())
        .unwrap_or("(untitled)")
        .to_string();
    let pr_body = pr_json
        .get("body")
        .and_then(|x| x.as_str())
        .unwrap_or("")
        .to_string();

    // Same request, different media type — reuse the already-resolved client
    // rather than reading the token out of the map again and hand-rolling a
    // second one. (That second copy was a private answer to "which credential
    // for which host", the exact drift this pass exists to remove.)
    let diff_resp = client
        .get(&pr_url)
        .header(ACCEPT, "application/vnd.github.v3.diff")
        .send()
        .await
        .map_err(|e| format!("Request failed: {}", e))?;
    let diff_raw = github_response_text(diff_resp).await?;

    let (diff_text, truncated, original) = truncate_for_model(&diff_raw, PR_REVIEW_DIFF_CAP_BYTES);

    let user_turn = crate::core::github_ai_prompts::pr_review_user_turn(
        &owner, &repo, pr_number, &pr_title, &pr_body, &diff_text, truncated, original,
    );

    let session_id = session_id_override
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| format!("ai-pr-review-{}", uuid::Uuid::new_v4()));

    info!(
        owner = %owner,
        repo = %repo,
        pr = pr_number,
        session_id = %session_id,
        provider = %route.provider,
        model = %route.model,
        "AI PR review session started"
    );

    crate::core::aux_llm::spawn_aux_stream(
        app_handle,
        AI_PR_REVIEW_TASK,
        route,
        session_id.clone(),
        crate::core::github_ai_prompts::PR_REVIEW_SYSTEM_PROMPT.to_string(),
        user_turn,
    );

    Ok(session_id)
}

// === v0.8-G: PR modal upgrades =============================================
//
// These commands back the upgraded `PRModal` (branch autocomplete, reviewer
// / label / milestone pickers) and the "Publish attempts as draft PRs"
// option on async Flights. They mirror the same auth + error-sanitization
// pattern as the rest of `github.rs`.

/// One branch row, derived from `GET /repos/{owner}/{repo}/branches`. We
/// keep the schema minimal — name + SHA are enough for autocomplete and
/// for triggering downstream fetches.
#[derive(serde::Serialize)]
pub struct GitHubBranch {
    pub name: String,
    pub sha: String,
    #[serde(rename = "isProtected")]
    pub is_protected: bool,
}

/// `GET /repos/{owner}/{repo}/branches?per_page=100` — list a repository's
/// branches. GitHub returns up to 30 by default; we bump to 100 to make
/// the picker useful on busy repos without paginating. The frontend
/// further sorts/filters (recent-first via local heuristics).
#[tauri::command]
pub async fn github_list_branches(
    auth: State<'_, GitHubAuthState>,
    owner: String,
    repo: String,
) -> Result<Vec<GitHubBranch>, String> {
    let (client, host, r) = repo_session(auth.inner(), &owner, &repo).await?;
    let resp = client
        .get(host.url(&host.branches_path(&r, 100)))
        .send()
        .await
        .map_err(|e| format!("Request failed: {}", e))?;
    let body = github_response_text(resp).await?;
    let raw: Vec<serde_json::Value> =
        serde_json::from_str(&body).map_err(|e| format!("Failed to parse branches: {}", e))?;

    let mut out: Vec<GitHubBranch> = Vec::with_capacity(raw.len());
    for b in raw {
        let name = b["name"].as_str().unwrap_or("").to_string();
        if name.is_empty() {
            continue;
        }
        // GitHub exposes the tip SHA as commit.sha; Gitea and GitLab as
        // commit.id.
        let sha = b["commit"]["sha"]
            .as_str()
            .or_else(|| b["commit"]["id"].as_str())
            .unwrap_or("")
            .to_string();
        let is_protected = b["protected"].as_bool().unwrap_or(false);
        out.push(GitHubBranch {
            name,
            sha,
            is_protected,
        });
    }
    Ok(out)
}

/// `POST /repos/{owner}/{repo}/pulls/{number}/requested_reviewers` —
/// request review from a set of users on an existing PR. GitHub silently
/// ignores users who can't be assigned (not collaborators); errors only
/// fire on malformed input or auth failures.
#[tauri::command]
pub async fn github_set_pr_reviewers(
    auth: State<'_, GitHubAuthState>,
    owner: String,
    repo: String,
    number: u32,
    reviewers: Vec<String>,
) -> Result<String, String> {
    if reviewers.is_empty() {
        return Ok("{}".to_string());
    }
    // Only GitHub has a `requested_reviewers` sub-resource that takes logins.
    // GitLab's MR update takes numeric `reviewer_ids`; Gitea's review-request
    // model differs again. Refuse rather than POSTing to a path that does not
    // exist on the active host.
    require_capability(auth.inner(), HostCapability::RequestReviewers).await?;
    let (client, host, r) = repo_session(auth.inner(), &owner, &repo).await?;
    let url = host.url(&format!(
        "{}/requested_reviewers",
        host.change_request_path(&r, number)
    ));
    let payload = serde_json::json!({ "reviewers": reviewers });
    let resp = client
        .post(url)
        .json(&payload)
        .send()
        .await
        .map_err(|e| format!("Request failed: {}", e))?;
    github_response_text(resp).await
}

/// `PUT /repos/{owner}/{repo}/issues/{number}/labels` — set labels on a PR
/// (PRs are issues in GitHub's data model, so the issues endpoint works).
/// PUT replaces the full label set; an empty list clears all labels.
#[tauri::command]
pub async fn github_set_pr_labels(
    auth: State<'_, GitHubAuthState>,
    owner: String,
    repo: String,
    number: u32,
    labels: Vec<String>,
) -> Result<String, String> {
    let (client, host, r) = repo_session(auth.inner(), &owner, &repo).await?;
    // On GitHub/Gitea a PR *is* an issue, so the issue label sub-resource
    // works. GitLab keeps merge requests and issues separate: labels are a
    // comma-joined string on the MR itself.
    let Some(labels_path) = host.issue_labels_path(&r, number) else {
        let resp = client
            .request(
                host.update_method(),
                host.url(&host.change_request_path(&r, number)),
            )
            .json(&host.labels_body_from_names(&labels))
            .send()
            .await
            .map_err(|e| format!("Request failed: {}", e))?;
        return github_response_text(resp).await;
    };
    // Gitea expects label ids; GitHub accepts names.
    let payload = match host.kind {
        GitHostKind::Gitea => {
            let ids = resolve_gitea_label_ids(&client, &host, &r, &labels).await?;
            // Labels PUT is a full replace — if the caller asked for labels but
            // NONE resolved to a Gitea id, refuse rather than silently clearing
            // every existing label.
            if !labels.is_empty() && ids.is_empty() {
                return Err(
                    "None of the requested labels exist on this Gitea repository.".to_string(),
                );
            }
            serde_json::json!({ "labels": ids })
        }
        _ => host.labels_body_from_names(&labels),
    };
    let resp = client
        .put(host.url(&labels_path))
        .json(&payload)
        .send()
        .await
        .map_err(|e| format!("Request failed: {}", e))?;
    github_response_text(resp).await
}

/// `PATCH /repos/{owner}/{repo}/issues/{number}` — set (or clear) the
/// milestone on a PR. `Some(n)` assigns, `None` clears (GitHub uses a
/// literal `null` for clearing rather than field omission).
#[tauri::command]
pub async fn github_set_pr_milestone(
    auth: State<'_, GitHubAuthState>,
    owner: String,
    repo: String,
    number: u32,
    milestone: Option<u64>,
) -> Result<String, String> {
    let (client, host, r) = repo_session(auth.inner(), &owner, &repo).await?;
    // GitHub/Gitea: a PR is an issue, so PATCH the issue resource. GitLab:
    // merge requests are their own resource, so PUT the MR.
    let path = match host.kind {
        GitHostKind::GitLab => host.change_request_path(&r, number),
        _ => host.issue_path(&r, number),
    };
    let resp = client
        .request(host.update_method(), host.url(&path))
        .json(&host.milestone_body(milestone))
        .send()
        .await
        .map_err(|e| format!("Request failed: {}", e))?;
    github_response_text(resp).await
}

// === v0.8-F: AI catch-me-up digest + AI issue triage =======================
//
// Both features go through the in-process Anthropic `LlmProvider` so they
// run regardless of which sidecar provider the user has configured (no
// CLI dependency, no sidecar dependency). The digest emits on the
// existing `api-agent:*` event channel so the digest panel can reuse
// `apiAgentChunkEvent` / `apiAgentDoneEvent` / `apiAgentErrorEvent` from
// the agent infrastructure rather than inventing a parallel event family.

// LM4 (3C-5): the catch-up / triage provider+model used to be hardcoded here
// (anthropic / claude-haiku-4-5). Both now resolve through the auxiliary
// routing seam under the `github-catch-up` / `github-triage` task classes.
// Only the provider/model CHOICE moved — each feature keeps its own request
// building, streaming, and parsing.
const TRIAGE_BATCH_MAX: usize = 20;

/// Lightweight `YYYY-MM-DDTHH:MM:SSZ` parser. Hand-rolled to avoid
/// adding chrono as a direct dep.
fn parse_iso_millis_v0_8_f(s: &str) -> Option<i64> {
    if s.len() < 20 {
        return None;
    }
    let bytes = s.as_bytes();
    if bytes[4] != b'-'
        || bytes[7] != b'-'
        || bytes[10] != b'T'
        || bytes[13] != b':'
        || bytes[16] != b':'
    {
        return None;
    }
    let year: i64 = s.get(0..4)?.parse().ok()?;
    let month: i64 = s.get(5..7)?.parse().ok()?;
    let day: i64 = s.get(8..10)?.parse().ok()?;
    let hour: i64 = s.get(11..13)?.parse().ok()?;
    let minute: i64 = s.get(14..16)?.parse().ok()?;
    let second: i64 = s.get(17..19)?.parse().ok()?;

    let (y, m) = if month <= 2 {
        (year - 1, month + 9)
    } else {
        (year, month - 3)
    };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let doy = (153 * (m - 3) + 2) / 5 + day - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146_097 + doe - 719_468;
    let secs = days * 86_400 + hour * 3600 + minute * 60 + second;
    Some(secs * 1000)
}

fn format_rfc3339_utc(unix_millis: i64) -> String {
    let secs = unix_millis.div_euclid(1000);
    let mut days = secs.div_euclid(86_400);
    let mut secs_of_day = secs.rem_euclid(86_400);
    if secs_of_day < 0 {
        secs_of_day += 86_400;
        days -= 1;
    }
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = (if mp < 10 { mp + 3 } else { mp - 9 }) as u32;
    let year = y + (if mp >= 10 { 1 } else { 0 });
    let hour = (secs_of_day / 3600) as u32;
    let minute = ((secs_of_day % 3600) / 60) as u32;
    let second = (secs_of_day % 60) as u32;
    format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}Z",
        year, m, d, hour, minute, second
    )
}

fn default_since_iso() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let now_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0);
    format_rfc3339_utc(now_ms - 7 * 24 * 60 * 60 * 1000)
}

fn since_label_for(since_iso: &str) -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    if since_iso.len() < 20 {
        return since_iso.to_string();
    }
    let parsed = parse_iso_millis_v0_8_f(since_iso);
    let now_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0);
    if let Some(ms) = parsed {
        let delta_h = ((now_ms - ms) / 3_600_000).max(1);
        if delta_h <= 36 {
            return format!("{} hours ago", delta_h);
        }
        let delta_d = (delta_h / 24).max(1);
        return format!("{} days ago", delta_d);
    }
    since_iso.to_string()
}

/// Triage DTO returned to the frontend. `suggestedLabels` / `duplicateOf`
/// use camelCase to match `src/types/github.ts`.
#[derive(Serialize, Deserialize, Clone)]
pub struct TriageSuggestion {
    pub number: u32,
    #[serde(rename = "suggestedLabels")]
    pub suggested_labels: Vec<String>,
    pub priority: String,
    pub rationale: String,
    #[serde(rename = "duplicateOf", skip_serializing_if = "Option::is_none")]
    pub duplicate_of: Option<u32>,
}

// NOTE: chunk events emit a raw `String` payload (see `ai_chunk_event`
// emit site below) — this matches the canonical `api-agent:chunk:<sid>`
// contract used by `agent_sidecar.rs` and `api_agent.rs`. There is
// deliberately no `AiChunkPayload` struct.
#[derive(Clone, Serialize)]
struct AiDonePayload {}
#[derive(Clone, Serialize)]
struct AiErrorPayload {
    message: String,
}

fn ai_chunk_event(session_id: &str) -> String {
    format!("api-agent:chunk:{}", session_id)
}
fn ai_done_event(session_id: &str) -> String {
    format!("api-agent:done:{}", session_id)
}
fn ai_error_event(session_id: &str) -> String {
    format!("api-agent:error:{}", session_id)
}

fn render_activity_block(
    events: &[serde_json::Value],
    closed_issues: &[serde_json::Value],
    merged_prs: &[serde_json::Value],
    stale_open_prs: &[serde_json::Value],
) -> String {
    let mut out = String::new();

    if !merged_prs.is_empty() {
        out.push_str("# Merged PRs\n");
        for pr in merged_prs {
            let num = pr.get("number").and_then(|v| v.as_u64()).unwrap_or(0);
            let title = pr.get("title").and_then(|v| v.as_str()).unwrap_or("");
            let user = pr
                .get("user")
                .and_then(|u| u.get("login"))
                .and_then(|v| v.as_str())
                .unwrap_or("?");
            let merged_at = pr.get("merged_at").and_then(|v| v.as_str()).unwrap_or("");
            out.push_str(&format!(
                "- PR #{} by @{} ({}): {}\n",
                num, user, merged_at, title
            ));
        }
        out.push('\n');
    }

    if !closed_issues.is_empty() {
        out.push_str("# Closed issues\n");
        for iss in closed_issues {
            let num = iss.get("number").and_then(|v| v.as_u64()).unwrap_or(0);
            let title = iss.get("title").and_then(|v| v.as_str()).unwrap_or("");
            let closed_at = iss.get("closed_at").and_then(|v| v.as_str()).unwrap_or("");
            out.push_str(&format!("- #{} (closed {}): {}\n", num, closed_at, title));
        }
        out.push('\n');
    }

    if !stale_open_prs.is_empty() {
        out.push_str("# Open PRs needing review (>= 1 day stale)\n");
        for pr in stale_open_prs {
            let num = pr.get("number").and_then(|v| v.as_u64()).unwrap_or(0);
            let title = pr.get("title").and_then(|v| v.as_str()).unwrap_or("");
            let user = pr
                .get("user")
                .and_then(|u| u.get("login"))
                .and_then(|v| v.as_str())
                .unwrap_or("?");
            let updated_at = pr.get("updated_at").and_then(|v| v.as_str()).unwrap_or("");
            out.push_str(&format!(
                "- PR #{} by @{} (last touched {}): {}\n",
                num, user, updated_at, title
            ));
        }
        out.push('\n');
    }

    if !events.is_empty() {
        out.push_str("# Repo events\n");
        for ev in events.iter().take(40) {
            let kind = ev.get("type").and_then(|v| v.as_str()).unwrap_or("?");
            let actor = ev
                .get("actor")
                .and_then(|a| a.get("login"))
                .and_then(|v| v.as_str())
                .unwrap_or("?");
            let created_at = ev.get("created_at").and_then(|v| v.as_str()).unwrap_or("");
            let what = match kind {
                "IssueCommentEvent" | "IssuesEvent" => ev
                    .pointer("/payload/issue/title")
                    .and_then(|v| v.as_str())
                    .unwrap_or(""),
                "PullRequestEvent" | "PullRequestReviewEvent" | "PullRequestReviewCommentEvent" => {
                    ev.pointer("/payload/pull_request/title")
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                }
                "PushEvent" => ev
                    .pointer("/payload/ref")
                    .and_then(|v| v.as_str())
                    .unwrap_or(""),
                _ => "",
            };
            out.push_str(&format!(
                "- {} by @{} ({}): {}\n",
                kind, actor, created_at, what
            ));
        }
    }

    if out.is_empty() {
        out.push_str("(no activity in window)\n");
    }
    out
}

/// v0.8-F — AI catch-me-up digest. Streams a four-section markdown
/// summary of recent repo activity. Emits `api-agent:chunk:<sessionId>`
/// per text delta, then `api-agent:done:<sessionId>` on success or
/// `api-agent:error:<sessionId>` with `{ message }` on failure.
#[tauri::command]
pub async fn github_ai_catch_up(
    app_handle: AppHandle,
    auth: State<'_, GitHubAuthState>,
    routing: State<'_, crate::core::aux_llm::AuxRoutingState>,
    session_id: String,
    owner: String,
    repo: String,
    since_iso8601: Option<String>,
) -> Result<(), String> {
    validate_github_name(&owner, "owner")?;
    validate_github_name(&repo, "repo")?;
    require_capability(auth.inner(), HostCapability::AiAssist).await?;
    if session_id.trim().is_empty() {
        return Err("session_id cannot be empty".to_string());
    }

    let since = since_iso8601
        .as_ref()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(default_since_iso);

    let client = github_client_from_state(auth.inner()).await?;

    async fn fetch_array(client: &reqwest::Client, url: &str) -> Vec<serde_json::Value> {
        let resp = match client.get(url).send().await {
            Ok(r) => r,
            Err(e) => {
                warn!("catch_up: fetch failed for {}: {}", url, e);
                return Vec::new();
            }
        };
        if !resp.status().is_success() {
            warn!("catch_up: non-2xx for {}: {}", url, resp.status());
            return Vec::new();
        }
        match resp.text().await {
            Ok(body) => serde_json::from_str::<Vec<serde_json::Value>>(&body).unwrap_or_default(),
            Err(_) => Vec::new(),
        }
    }

    let events_url = format!(
        "https://api.github.com/repos/{}/{}/events?per_page=100",
        owner, repo
    );
    let closed_issues_url = format!(
        "https://api.github.com/repos/{}/{}/issues?state=closed&since={}&per_page=30",
        owner, repo, since
    );
    let merged_prs_url = format!(
        "https://api.github.com/repos/{}/{}/pulls?state=closed&sort=updated&direction=desc&per_page=30",
        owner, repo
    );
    let open_prs_url = format!(
        "https://api.github.com/repos/{}/{}/pulls?state=open&sort=updated&direction=desc&per_page=30",
        owner, repo
    );

    let (events_raw, closed_issues_raw, closed_prs_raw, open_prs_raw) = tokio::join!(
        fetch_array(&client, &events_url),
        fetch_array(&client, &closed_issues_url),
        fetch_array(&client, &merged_prs_url),
        fetch_array(&client, &open_prs_url),
    );

    let since_ms = parse_iso_millis_v0_8_f(&since).unwrap_or(0);

    let events: Vec<serde_json::Value> = events_raw
        .into_iter()
        .filter(|ev| {
            ev.get("created_at")
                .and_then(|v| v.as_str())
                .and_then(parse_iso_millis_v0_8_f)
                .map(|ms| ms >= since_ms)
                .unwrap_or(false)
        })
        .collect();

    let closed_issues: Vec<serde_json::Value> = closed_issues_raw
        .into_iter()
        .filter(|i| i.get("pull_request").is_none())
        .collect();

    let merged_prs: Vec<serde_json::Value> = closed_prs_raw
        .into_iter()
        .filter(|pr| {
            let merged_at = pr.get("merged_at").and_then(|v| v.as_str());
            match merged_at {
                Some(s) => parse_iso_millis_v0_8_f(s)
                    .map(|ms| ms >= since_ms)
                    .unwrap_or(false),
                None => false,
            }
        })
        .collect();

    let now_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0);
    let one_day_ms: i64 = 24 * 60 * 60 * 1000;
    let stale_open_prs: Vec<serde_json::Value> = open_prs_raw
        .into_iter()
        .filter(|pr| {
            pr.get("updated_at")
                .and_then(|v| v.as_str())
                .and_then(parse_iso_millis_v0_8_f)
                .map(|ms| (now_ms - ms) >= one_day_ms)
                .unwrap_or(false)
        })
        .collect();

    let activity_block =
        render_activity_block(&events, &closed_issues, &merged_prs, &stale_open_prs);

    let since_label = since_label_for(&since);
    let (system_prompt, user_turn) = crate::core::github_ai_prompts::catch_up_prompt(
        &owner,
        &repo,
        &since_label,
        &activity_block,
    );

    super::validate_input_size(&user_turn, super::MAX_INPUT_SIZE, "Catch-up user turn")?;

    let route = routing.resolve(crate::core::aux_llm::AuxTaskClass::GitHubCatchUp)?;
    let api_key = crate::commands::api_keys::load_api_key(&route.provider)
        .map_err(|e| format!("AI digest needs a {} API key. {}", route.provider, e))?;

    info!(
        owner = %owner,
        repo = %repo,
        since = %since,
        provider = %route.provider,
        model = %route.model,
        events = events.len(),
        closed_issues = closed_issues.len(),
        merged_prs = merged_prs.len(),
        stale_prs = stale_open_prs.len(),
        "github_ai_catch_up: streaming digest",
    );

    let provider = crate::core::llm_provider::get_provider(&route.provider)
        .map_err(|e| format!("Provider unavailable: {}", e))?;

    let messages = vec![crate::core::llm_types::ChatMessage {
        role: crate::core::llm_types::ChatRole::User,
        content: crate::core::llm_types::MessageContent::text(user_turn),
    }];
    let request = crate::core::llm_types::LlmRequest {
        model: route.model.clone(),
        messages,
        tools: Vec::new(),
        system_prompt: Some(system_prompt),
        max_tokens: 2048,
        temperature: Some(0.3),
        attachments: Vec::new(),
        thinking_enabled: false,
        thinking_budget_tokens: 0,
        cache_key: None,
    };

    let handle = app_handle.clone();
    let sid = session_id.clone();
    tokio::spawn(async move {
        let (tx, mut rx) = tokio::sync::mpsc::channel::<crate::core::llm_types::StreamChunk>(64);
        let provider_task =
            tokio::spawn(async move { provider.stream_chat(&api_key, request, tx).await });

        let mut error: Option<String> = None;
        let mut total: usize = 0;
        while let Some(chunk) = rx.recv().await {
            match chunk {
                crate::core::llm_types::StreamChunk::TextDelta { text } => {
                    if text.is_empty() {
                        continue;
                    }
                    total += text.len();
                    // Contract: `api-agent:chunk:<sid>` payload is a raw
                    // string, matching the sidecar / api_agent emitters.
                    // (Other v0.8-F emitters had wrapped the text in a
                    // `{delta}` envelope, which broke the AICatchUp listener
                    // until we noticed during peer review.)
                    let _ = handle.emit(&ai_chunk_event(&sid), &text);
                }
                crate::core::llm_types::StreamChunk::Error { message } => {
                    error = Some(message);
                    break;
                }
                crate::core::llm_types::StreamChunk::Done { .. } => break,
                _ => {}
            }
        }
        match provider_task.await {
            Ok(Ok(())) => {}
            Ok(Err(e)) => {
                if error.is_none() {
                    error = Some(e);
                }
            }
            Err(je) => {
                if error.is_none() {
                    error = Some(format!("Provider task panicked: {}", je));
                }
            }
        }
        if let Some(message) = error {
            warn!("github_ai_catch_up error: {}", message);
            let _ = handle.emit(&ai_error_event(&sid), AiErrorPayload { message });
            return;
        }
        if total == 0 {
            let _ = handle.emit(
                &ai_error_event(&sid),
                AiErrorPayload {
                    message: "The model returned an empty digest.".to_string(),
                },
            );
            return;
        }
        let _ = handle.emit(&ai_done_event(&sid), AiDonePayload {});
    });

    Ok(())
}

fn truncate_chars_v0_8_f(s: &str, max_chars: usize) -> String {
    if s.chars().count() <= max_chars {
        s.to_string()
    } else {
        let kept: String = s.chars().take(max_chars).collect();
        format!("{}…", kept)
    }
}

fn strip_json_fences(s: &str) -> &str {
    let t = s.trim();
    let after_open = if let Some(rest) = t.strip_prefix("```json") {
        rest.trim_start_matches('\n').trim_start()
    } else if let Some(rest) = t.strip_prefix("```") {
        rest.trim_start_matches('\n').trim_start()
    } else {
        t
    };
    if let Some(end) = after_open.rfind("```") {
        after_open[..end].trim_end()
    } else {
        after_open
    }
}

/// v0.8-F — AI issue triage. Synchronous (non-streaming): fetches each
/// issue's title+body and the repo's label set, runs one model turn,
/// parses the JSON-only response, returns it. Frontend slices selections
/// larger than `TRIAGE_BATCH_MAX` into multiple invocations.
#[tauri::command]
pub async fn github_ai_triage(
    auth: State<'_, GitHubAuthState>,
    routing: State<'_, crate::core::aux_llm::AuxRoutingState>,
    owner: String,
    repo: String,
    issue_numbers: Vec<u32>,
) -> Result<Vec<TriageSuggestion>, String> {
    validate_github_name(&owner, "owner")?;
    validate_github_name(&repo, "repo")?;
    require_capability(auth.inner(), HostCapability::AiAssist).await?;
    if issue_numbers.is_empty() {
        return Ok(Vec::new());
    }
    if issue_numbers.len() > TRIAGE_BATCH_MAX {
        return Err(format!(
            "Too many issues in one batch ({}). Limit is {}.",
            issue_numbers.len(),
            TRIAGE_BATCH_MAX
        ));
    }

    let client = github_client_from_state(auth.inner()).await?;
    let triage_ref = RepoRef::new(&owner, &repo)?;

    let mut issue_payloads: Vec<serde_json::Value> = Vec::with_capacity(issue_numbers.len());
    for n in &issue_numbers {
        let body =
            github_get_issue_with_client(&client, &GitHost::github(), &triage_ref, *n).await?;
        let parsed: serde_json::Value = serde_json::from_str(&body)
            .map_err(|e| format!("Failed to parse issue #{}: {}", n, e))?;
        let title = parsed
            .get("title")
            .and_then(|v| v.as_str())
            .unwrap_or("(no title)")
            .to_string();
        let body_text = parsed
            .get("body")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        issue_payloads.push(serde_json::json!({
            "number": *n,
            "title": title,
            // Cap bodies so a batch of 20 long issues doesn't blow past
            // the model's context. ~1k chars per issue is plenty.
            "body": truncate_chars_v0_8_f(&body_text, 1000),
        }));
    }

    let labels_url = format!(
        "https://api.github.com/repos/{}/{}/labels?per_page=100",
        owner, repo
    );
    let labels_body = match client.get(&labels_url).send().await {
        Ok(resp) => github_response_text(resp).await.unwrap_or_default(),
        Err(_) => String::new(),
    };
    let label_names: Vec<String> = serde_json::from_str::<Vec<serde_json::Value>>(&labels_body)
        .unwrap_or_default()
        .into_iter()
        .filter_map(|l| {
            l.get("name")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string())
        })
        .collect();

    let issues_block = serde_json::to_string_pretty(&issue_payloads)
        .map_err(|e| format!("Failed to render issues block: {}", e))?;

    let (system_prompt, user_turn) =
        crate::core::github_ai_prompts::triage_prompt(&owner, &repo, &label_names, &issues_block);

    super::validate_input_size(&user_turn, super::MAX_INPUT_SIZE, "Triage user turn")?;

    let route = routing.resolve(crate::core::aux_llm::AuxTaskClass::GitHubTriage)?;
    let api_key = crate::commands::api_keys::load_api_key(&route.provider)
        .map_err(|e| format!("AI triage needs a {} API key. {}", route.provider, e))?;

    info!(
        owner = %owner,
        repo = %repo,
        provider = %route.provider,
        model = %route.model,
        issue_count = issue_numbers.len(),
        label_count = label_names.len(),
        "github_ai_triage: running",
    );

    let provider = crate::core::llm_provider::get_provider(&route.provider)
        .map_err(|e| format!("Provider unavailable: {}", e))?;

    let messages = vec![crate::core::llm_types::ChatMessage {
        role: crate::core::llm_types::ChatRole::User,
        content: crate::core::llm_types::MessageContent::text(user_turn),
    }];
    let request = crate::core::llm_types::LlmRequest {
        model: route.model.clone(),
        messages,
        tools: Vec::new(),
        system_prompt: Some(system_prompt),
        max_tokens: 4096,
        temperature: Some(0.1),
        attachments: Vec::new(),
        thinking_enabled: false,
        thinking_budget_tokens: 0,
        cache_key: None,
    };

    let (tx, mut rx) = tokio::sync::mpsc::channel::<crate::core::llm_types::StreamChunk>(64);
    let provider_task =
        tokio::spawn(async move { provider.stream_chat(&api_key, request, tx).await });

    let mut buf = String::new();
    let mut stream_error: Option<String> = None;
    while let Some(chunk) = rx.recv().await {
        match chunk {
            crate::core::llm_types::StreamChunk::TextDelta { text } => {
                buf.push_str(&text);
            }
            crate::core::llm_types::StreamChunk::Error { message } => {
                stream_error = Some(message);
                break;
            }
            crate::core::llm_types::StreamChunk::Done { .. } => break,
            _ => {}
        }
    }
    match provider_task.await {
        Ok(Ok(())) => {}
        Ok(Err(e)) => {
            if stream_error.is_none() {
                stream_error = Some(e);
            }
        }
        Err(je) => {
            if stream_error.is_none() {
                stream_error = Some(format!("Provider task panicked: {}", je));
            }
        }
    }
    if let Some(msg) = stream_error {
        return Err(msg);
    }
    if buf.trim().is_empty() {
        return Err("The model returned an empty triage response.".to_string());
    }

    let trimmed = buf.trim();
    let stripped = strip_json_fences(trimmed);

    let suggestions: Vec<TriageSuggestion> = serde_json::from_str(stripped).map_err(|e| {
        warn!(
            "github_ai_triage: JSON parse failed: {} — raw response (truncated): {}",
            e,
            truncate_chars_v0_8_f(stripped, 500)
        );
        format!("Triage response was not valid JSON: {}", e)
    })?;

    Ok(suggestions)
}

// === v0.8-A (re-shipped): PR lifecycle actions ============================
//
// Backs the `PRActionBar` component. Four commands map to GitHub's REST
// (merge / close / reopen) and GraphQL (draft toggle) surfaces.
//
//   - `github_merge_pr`            → PUT  /repos/{o}/{r}/pulls/{n}/merge
//   - `github_close_pr`            → PATCH /repos/{o}/{r}/pulls/{n}  {state:"closed"}
//   - `github_reopen_pr`           → PATCH /repos/{o}/{r}/pulls/{n}  {state:"open"}
//   - `github_convert_pr_to_draft` → REST  GET /pulls/{n} for node_id,
//                                    then GraphQL
//                                    convertPullRequestToDraft /
//                                    markPullRequestReadyForReview.
//
// All four route through `github_client_from_state`, so the same token-not-
// set error path the rest of the file uses applies here.

#[derive(serde::Serialize)]
pub struct GitHubMergeResult {
    pub sha: String,
    pub merged: bool,
    pub message: String,
}

fn validate_merge_method(method: &str) -> Result<&'static str, String> {
    match method {
        "merge" => Ok("merge"),
        "squash" => Ok("squash"),
        "rebase" => Ok("rebase"),
        other => Err(format!(
            "Invalid merge method '{}'. Expected merge | squash | rebase.",
            other
        )),
    }
}

/// `PUT /repos/{owner}/{repo}/pulls/{number}/merge` — merge an open PR.
#[tauri::command]
pub async fn github_merge_pr(
    auth: State<'_, GitHubAuthState>,
    owner: String,
    repo: String,
    number: u32,
    merge_method: String,
) -> Result<GitHubMergeResult, String> {
    let method = validate_merge_method(&merge_method)?;
    let (client, host, r) = repo_session(auth.inner(), &owner, &repo).await?;
    // GitHub: PUT with `merge_method`, returns {sha, merged, message}.
    // Gitea:  POST with `Do`, returns an empty 2xx body on success.
    // GitLab: PUT with `squash`, returns the merged MR (no `sha`/`merged`).
    let (verb, payload) = host.merge_request_shape(method)?;
    let resp = client
        .request(verb, host.url(&host.change_request_merge_path(&r, number)))
        .json(&payload)
        .send()
        .await
        .map_err(|e| format!("Request failed: {}", e))?;

    if !host.merge_returns_body() {
        // Empty body — treat any 2xx as a successful merge.
        if !resp.status().is_success() {
            return Err(host_error_from_response(resp).await);
        }
        return Ok(GitHubMergeResult {
            sha: String::new(),
            merged: true,
            message: "Merged".to_string(),
        });
    }

    let body = github_response_text(resp).await?;
    let v: serde_json::Value = serde_json::from_str(&body)
        .map_err(|e| format!("Failed to parse merge response: {}", e))?;
    if host.kind == GitHostKind::GitLab {
        // GitLab answers with the MR itself: `state` becomes "merged" and
        // `merge_commit_sha` holds what GitHub calls `sha`.
        let merged = v.get("state").and_then(|x| x.as_str()) == Some("merged");
        return Ok(GitHubMergeResult {
            sha: v
                .get("merge_commit_sha")
                .or_else(|| v.get("squash_commit_sha"))
                .and_then(|x| x.as_str())
                .unwrap_or("")
                .to_string(),
            merged,
            message: if merged { "Merged" } else { "Not merged" }.to_string(),
        });
    }
    Ok(GitHubMergeResult {
        sha: v
            .get("sha")
            .and_then(|x| x.as_str())
            .unwrap_or("")
            .to_string(),
        merged: v.get("merged").and_then(|x| x.as_bool()).unwrap_or(false),
        message: v
            .get("message")
            .and_then(|x| x.as_str())
            .unwrap_or("")
            .to_string(),
    })
}

async fn patch_pr_state(
    auth: &GitHubAuthState,
    owner: &str,
    repo: &str,
    number: u32,
    open: bool,
) -> Result<String, String> {
    let (client, host, r) = repo_session(auth, owner, repo).await?;
    let resp = client
        .request(
            host.update_method(),
            host.url(&host.change_request_path(&r, number)),
        )
        // GitHub/Gitea set `state`; GitLab takes a `state_event` verb and
        // silently ignores a `state` field, so this must be host-derived.
        .json(&host.state_change_body(open))
        .send()
        .await
        .map_err(|e| format!("Request failed: {}", e))?;
    let text = github_response_text(resp).await?;
    normalize_one(&host, text, git_host::normalize_change_request)
}

/// Close an open change request.
#[tauri::command]
pub async fn github_close_pr(
    auth: State<'_, GitHubAuthState>,
    owner: String,
    repo: String,
    number: u32,
) -> Result<String, String> {
    patch_pr_state(auth.inner(), &owner, &repo, number, false).await
}

/// Reopen a closed change request.
#[tauri::command]
pub async fn github_reopen_pr(
    auth: State<'_, GitHubAuthState>,
    owner: String,
    repo: String,
    number: u32,
) -> Result<String, String> {
    patch_pr_state(auth.inner(), &owner, &repo, number, true).await
}

/// Toggle a PR between draft and ready-for-review. REST returns the PR's
/// GraphQL `node_id`; we then call `convertPullRequestToDraft` or
/// `markPullRequestReadyForReview` depending on the requested target state.
#[tauri::command]
pub async fn github_convert_pr_to_draft(
    auth: State<'_, GitHubAuthState>,
    owner: String,
    repo: String,
    number: u32,
    draft: bool,
) -> Result<bool, String> {
    validate_github_name(&owner, "owner")?;
    validate_github_name(&repo, "repo")?;
    // G10: the draft toggle uses GitHub's GraphQL API. Gitea marks drafts via a
    // `WIP:` title prefix and GitLab via a `Draft:` one; neither has a mutation
    // to call, so the capability table refuses both.
    require_capability(auth.inner(), HostCapability::DraftToggle).await?;
    let client = github_client_from_state(auth.inner()).await?;

    // Step 1: REST fetch to resolve the GraphQL node_id for this PR.
    let pr_url = format!(
        "https://api.github.com/repos/{}/{}/pulls/{}",
        owner, repo, number
    );
    let pr_resp = client
        .get(&pr_url)
        .send()
        .await
        .map_err(|e| format!("Request failed: {}", e))?;
    let pr_body = github_response_text(pr_resp).await?;
    let pr_json: serde_json::Value = serde_json::from_str(&pr_body)
        .map_err(|e| format!("Failed to parse PR response: {}", e))?;
    let node_id = pr_json
        .get("node_id")
        .and_then(|x| x.as_str())
        .ok_or_else(|| "PR response missing node_id".to_string())?;

    // Step 2: GraphQL mutation. The two mutations have identical input shape
    // ({pullRequestId}) and both return {pullRequest{isDraft}}.
    let (mutation_name, response_key) = if draft {
        ("convertPullRequestToDraft", "convertPullRequestToDraft")
    } else {
        (
            "markPullRequestReadyForReview",
            "markPullRequestReadyForReview",
        )
    };
    let query = format!(
        "mutation($id: ID!) {{ {mutation}(input: {{pullRequestId: $id}}) {{ pullRequest {{ isDraft }} }} }}",
        mutation = mutation_name,
    );
    let gql_body = serde_json::json!({
        "query": query,
        "variables": { "id": node_id },
    });
    let gql_resp = client
        .post("https://api.github.com/graphql")
        .json(&gql_body)
        .send()
        .await
        .map_err(|e| format!("GraphQL request failed: {}", e))?;
    let gql_text = github_response_text(gql_resp).await?;
    let gql_json: serde_json::Value = serde_json::from_str(&gql_text)
        .map_err(|e| format!("Failed to parse GraphQL response: {}", e))?;

    // GraphQL surfaces errors in the response body rather than HTTP status.
    if let Some(errors) = gql_json.get("errors").and_then(|x| x.as_array()) {
        if !errors.is_empty() {
            let msg = errors
                .iter()
                .filter_map(|e| e.get("message").and_then(|x| x.as_str()))
                .collect::<Vec<_>>()
                .join("; ");
            return Err(format!("GitHub GraphQL error: {}", msg));
        }
    }

    let is_draft = gql_json
        .get("data")
        .and_then(|d| d.get(response_key))
        .and_then(|m| m.get("pullRequest"))
        .and_then(|p| p.get("isDraft"))
        .and_then(|x| x.as_bool())
        .unwrap_or(draft);

    Ok(is_draft)
}

// === v0.8-B: CI / check-run status (re-shipped) ===========================
//
// Aggregates the modern Checks API (`/commits/{sha}/check-runs`) with the
// legacy combined-status API (`/commits/{sha}/status`) into a single DTO.
// The frontend (`PrCheckPill.tsx`, `PRChecksTab.tsx`) consumes the camelCase
// shape declared in `src/types/github.ts`.

#[derive(Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct GitHubCheckRunDto {
    pub id: i64,
    pub name: String,
    /// `queued | in_progress | completed`. Legacy combined-status entries
    /// are flattened into this shape: `pending → in_progress`, anything
    /// else → `completed`.
    pub status: String,
    /// `success | failure | neutral | cancelled | skipped | timed_out |
    /// action_required` — only present when `status == "completed"`.
    pub conclusion: Option<String>,
    pub html_url: Option<String>,
    pub started_at: Option<String>,
    pub completed_at: Option<String>,
    pub duration_ms: Option<i64>,
    pub app_name: Option<String>,
}

#[derive(Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct GitHubPrChecksDto {
    pub combined_state: String,
    pub total: i64,
    pub passing: i64,
    pub failing: i64,
    pub pending: i64,
    pub runs: Vec<GitHubCheckRunDto>,
}

/// Best-effort RFC3339 → unix-millis parser. Accepts the shape GitHub emits:
/// `YYYY-MM-DDTHH:MM:SSZ` and variants with fractional seconds / offsets.
/// Returns `None` on any parse problem so duration_ms gracefully degrades.
fn parse_rfc3339_to_ms(s: &str) -> Option<i64> {
    if s.len() < 19 {
        return None;
    }
    let year: i64 = s.get(0..4)?.parse().ok()?;
    let month: i64 = s.get(5..7)?.parse().ok()?;
    let day: i64 = s.get(8..10)?.parse().ok()?;
    let hour: i64 = s.get(11..13)?.parse().ok()?;
    let minute: i64 = s.get(14..16)?.parse().ok()?;
    let second: i64 = s.get(17..19)?.parse().ok()?;

    // days-from-civil (Hinnant): inverse of `format_rfc3339_utc` above.
    let y = if month <= 2 { year - 1 } else { year };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let m_adj = if month > 2 { month - 3 } else { month + 9 };
    let doy = (153 * m_adj + 2) / 5 + day - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146_097 + doe - 719_468;
    let secs = days * 86_400 + hour * 3600 + minute * 60 + second;
    Some(secs * 1000)
}

fn duration_ms_between(started: Option<&str>, completed: Option<&str>) -> Option<i64> {
    let s = parse_rfc3339_to_ms(started?)?;
    let c = parse_rfc3339_to_ms(completed?)?;
    let d = c - s;
    if d < 0 {
        None
    } else {
        Some(d)
    }
}

/// Roll up bucket counts into a single combined state. Mirrors the docstring
/// in PrCheckPill: failure-class wins, then pending-class, then success,
/// then neutral, then "none" for empty.
fn rollup_combined_state(total: i64, passing: i64, failing: i64, pending: i64) -> &'static str {
    if total == 0 {
        return "none";
    }
    if failing > 0 {
        return "failure";
    }
    if pending > 0 {
        return "pending";
    }
    if passing > 0 {
        return "success";
    }
    "neutral"
}

/// Aggregate Checks API + legacy combined-status for a PR's head commit.
#[tauri::command]
pub async fn github_get_pr_checks(
    auth: State<'_, GitHubAuthState>,
    owner: String,
    repo: String,
    pr_number: u32,
) -> Result<GitHubPrChecksDto, String> {
    validate_github_name(&owner, "owner")?;
    validate_github_name(&repo, "repo")?;
    // G10: only GitHub has a check-runs API. Gitea has combined commit status
    // only; GitLab splits the concept into pipelines + commit statuses. Degrade
    // to an empty summary rather than 404-ing (or, worse, asking GitHub about
    // another host's SHA).
    if !active_host(auth.inner())
        .await
        .supports(HostCapability::CheckRuns)
    {
        return Ok(GitHubPrChecksDto {
            combined_state: "none".to_string(),
            total: 0,
            passing: 0,
            failing: 0,
            pending: 0,
            runs: vec![],
        });
    }
    let client = github_client_from_state(auth.inner()).await?;

    // --- Step A: PR head SHA -------------------------------------------------
    let pr_url = format!(
        "https://api.github.com/repos/{}/{}/pulls/{}",
        owner, repo, pr_number
    );
    let pr_resp = client
        .get(&pr_url)
        .send()
        .await
        .map_err(|e| format!("Request failed: {}", e))?;
    let pr_body = github_response_text(pr_resp).await?;
    let pr_json: serde_json::Value = serde_json::from_str(&pr_body)
        .map_err(|e| format!("Failed to parse PR response: {}", e))?;
    let head_sha = pr_json
        .get("head")
        .and_then(|h| h.get("sha"))
        .and_then(|s| s.as_str())
        .ok_or_else(|| "PR response missing head.sha".to_string())?
        .to_string();

    // --- Step B: check-runs --------------------------------------------------
    let runs_url = format!(
        "https://api.github.com/repos/{}/{}/commits/{}/check-runs?per_page=100",
        owner, repo, head_sha
    );
    let runs_resp = client
        .get(&runs_url)
        .send()
        .await
        .map_err(|e| format!("Request failed: {}", e))?;
    let runs_body = github_response_text(runs_resp).await?;
    let runs_json: serde_json::Value = serde_json::from_str(&runs_body)
        .map_err(|e| format!("Failed to parse check-runs response: {}", e))?;
    let empty_vec: Vec<serde_json::Value> = Vec::new();
    let raw_runs = runs_json
        .get("check_runs")
        .and_then(|v| v.as_array())
        .unwrap_or(&empty_vec);

    let mut runs: Vec<GitHubCheckRunDto> = Vec::with_capacity(raw_runs.len());
    for r in raw_runs.iter() {
        let id = r.get("id").and_then(|v| v.as_i64()).unwrap_or(0);
        let name = r
            .get("name")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        let status = r
            .get("status")
            .and_then(|v| v.as_str())
            .unwrap_or("completed")
            .to_string();
        let conclusion = r
            .get("conclusion")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string());
        let html_url = r
            .get("html_url")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string());
        let started_at = r
            .get("started_at")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string());
        let completed_at = r
            .get("completed_at")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string());
        let app_name = r
            .get("app")
            .and_then(|a| a.get("name"))
            .and_then(|v| v.as_str())
            .map(|s| s.to_string());
        let duration_ms = duration_ms_between(started_at.as_deref(), completed_at.as_deref());
        runs.push(GitHubCheckRunDto {
            id,
            name,
            status,
            conclusion,
            html_url,
            started_at,
            completed_at,
            duration_ms,
            app_name,
        });
    }

    // --- Step C: legacy combined status -------------------------------------
    let status_url = format!(
        "https://api.github.com/repos/{}/{}/commits/{}/status",
        owner, repo, head_sha
    );
    let status_resp = client
        .get(&status_url)
        .send()
        .await
        .map_err(|e| format!("Request failed: {}", e))?;
    let status_body = github_response_text(status_resp).await?;
    let status_json: serde_json::Value = serde_json::from_str(&status_body)
        .map_err(|e| format!("Failed to parse status response: {}", e))?;
    let raw_statuses = status_json
        .get("statuses")
        .and_then(|v| v.as_array())
        .unwrap_or(&empty_vec);

    for s in raw_statuses.iter() {
        let id = s.get("id").and_then(|v| v.as_i64()).unwrap_or(0);
        let context = s
            .get("context")
            .and_then(|v| v.as_str())
            .unwrap_or("status")
            .to_string();
        let state = s.get("state").and_then(|v| v.as_str()).unwrap_or("pending");
        // Flatten legacy state into the modern (status, conclusion) pair.
        let (mapped_status, mapped_conclusion): (&str, Option<&str>) = match state {
            "success" => ("completed", Some("success")),
            "failure" | "error" => ("completed", Some("failure")),
            "pending" => ("in_progress", None),
            other => ("completed", Some(other)),
        };
        let html_url = s
            .get("target_url")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string());
        let created_at = s
            .get("created_at")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string());
        let updated_at = s
            .get("updated_at")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string());
        let duration_ms = duration_ms_between(created_at.as_deref(), updated_at.as_deref());
        runs.push(GitHubCheckRunDto {
            id,
            name: context,
            status: mapped_status.to_string(),
            conclusion: mapped_conclusion.map(|s| s.to_string()),
            html_url,
            started_at: created_at,
            completed_at: updated_at,
            duration_ms,
            app_name: Some("legacy-status".to_string()),
        });
    }

    // --- Bucket + rollup -----------------------------------------------------
    let mut passing: i64 = 0;
    let mut failing: i64 = 0;
    let mut pending: i64 = 0;
    for r in runs.iter() {
        if r.status != "completed" {
            pending += 1;
            continue;
        }
        match r.conclusion.as_deref() {
            Some("success") => passing += 1,
            Some("failure") | Some("cancelled") | Some("timed_out") | Some("action_required") => {
                failing += 1
            }
            _ => {}
        }
    }
    let total = runs.len() as i64;
    let combined_state = rollup_combined_state(total, passing, failing, pending).to_string();

    Ok(GitHubPrChecksDto {
        combined_state,
        total,
        passing,
        failing,
        pending,
        runs,
    })
}

// === v0.8-13: PR reviews surface (read-only) ===============================
//
// Two commands fetch the existing review history for a PR so the frontend
// can render an overview of formal reviews plus per-file inline comment
// threads. Adding new comments is out of scope for v0.8 (v1.1).
//
// Both commands return camelCase DTOs (matching the rest of the v0.8
// surface) so the React side can `invoke<...>()` directly.

#[derive(Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct GhReviewUser {
    pub login: String,
    pub avatar_url: String,
}

#[derive(Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct PullRequestReview {
    pub id: u64,
    pub user: GhReviewUser,
    pub body: String,
    /// `APPROVED | CHANGES_REQUESTED | COMMENTED | DISMISSED | PENDING`
    pub state: String,
    pub submitted_at: Option<String>,
    pub html_url: String,
}

#[derive(Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct PullRequestReviewComment {
    pub id: u64,
    /// The review this comment belongs to (when posted as part of a formal
    /// review). Top-level inline comments may omit this.
    pub pull_request_review_id: Option<u64>,
    /// When this comment is a reply to another comment, the parent's id.
    pub in_reply_to_id: Option<u64>,
    pub user: GhReviewUser,
    pub body: String,
    pub path: String,
    /// Line number on the diff (HEAD side). May be null for outdated
    /// comments on lines that no longer exist.
    pub line: Option<u32>,
    pub original_line: Option<u32>,
    /// `LEFT | RIGHT` — which side of the diff the comment is anchored to.
    pub side: Option<String>,
    pub created_at: String,
    pub html_url: String,
}

fn parse_review_user(v: Option<&serde_json::Value>) -> GhReviewUser {
    GhReviewUser {
        login: v
            .and_then(|u| u.get("login"))
            .and_then(|x| x.as_str())
            .unwrap_or("")
            .to_string(),
        avatar_url: v
            .and_then(|u| u.get("avatar_url"))
            .and_then(|x| x.as_str())
            .unwrap_or("")
            .to_string(),
    }
}

fn parse_pr_review(v: &serde_json::Value) -> PullRequestReview {
    PullRequestReview {
        id: v.get("id").and_then(|x| x.as_u64()).unwrap_or(0),
        user: parse_review_user(v.get("user")),
        body: v
            .get("body")
            .and_then(|x| x.as_str())
            .unwrap_or("")
            .to_string(),
        // G11: normalize the review-state enum. Gitea emits REQUEST_CHANGES /
        // COMMENT; the frontend keys on GitHub's CHANGES_REQUESTED / COMMENTED.
        state: match v
            .get("state")
            .and_then(|x| x.as_str())
            .unwrap_or("COMMENTED")
        {
            "REQUEST_CHANGES" => "CHANGES_REQUESTED",
            "COMMENT" => "COMMENTED",
            other => other,
        }
        .to_string(),
        submitted_at: v
            .get("submitted_at")
            .and_then(|x| x.as_str())
            .map(|s| s.to_string()),
        html_url: v
            .get("html_url")
            .and_then(|x| x.as_str())
            .unwrap_or("")
            .to_string(),
    }
}

fn parse_pr_review_comment(v: &serde_json::Value) -> PullRequestReviewComment {
    PullRequestReviewComment {
        id: v.get("id").and_then(|x| x.as_u64()).unwrap_or(0),
        pull_request_review_id: v.get("pull_request_review_id").and_then(|x| x.as_u64()),
        in_reply_to_id: v.get("in_reply_to_id").and_then(|x| x.as_u64()),
        user: parse_review_user(v.get("user")),
        body: v
            .get("body")
            .and_then(|x| x.as_str())
            .unwrap_or("")
            .to_string(),
        path: v
            .get("path")
            .and_then(|x| x.as_str())
            .unwrap_or("")
            .to_string(),
        line: v.get("line").and_then(|x| x.as_u64()).map(|n| n as u32),
        original_line: v
            .get("original_line")
            .and_then(|x| x.as_u64())
            .map(|n| n as u32),
        side: v
            .get("side")
            .and_then(|x| x.as_str())
            .map(|s| s.to_string()),
        created_at: v
            .get("created_at")
            .and_then(|x| x.as_str())
            .unwrap_or("")
            .to_string(),
        html_url: v
            .get("html_url")
            .and_then(|x| x.as_str())
            .unwrap_or("")
            .to_string(),
    }
}

/// `GET /repos/{owner}/{repo}/pulls/{pr_number}/reviews` — list formal PR
/// reviews (Approved / Changes Requested / Commented / Dismissed /
/// Pending).
#[tauri::command]
pub async fn github_list_pr_reviews(
    auth: State<'_, GitHubAuthState>,
    owner: String,
    repo: String,
    pr_number: u32,
) -> Result<Vec<PullRequestReview>, String> {
    let (client, host, r) = repo_session(auth.inner(), &owner, &repo).await?;
    // GitHub and Gitea both serve `/pulls/{n}/reviews`. GitLab has no review
    // *object* at all, so asking for one would 404 (or, before the capability
    // table, would have gone out on a `/repos/...` path GitLab does not have).
    // Degrade to an empty list — the reviews tab renders "no reviews".
    if !host.supports(HostCapability::PrReviews) {
        return Ok(vec![]);
    }
    let resp = client
        .get(host.url(&host.reviews_path(&r, pr_number, 100)))
        .send()
        .await
        .map_err(|e| format!("Request failed: {}", e))?;
    let body = github_response_text(resp).await?;
    let arr: Vec<serde_json::Value> =
        serde_json::from_str(&body).map_err(|e| format!("Failed to parse PR reviews: {}", e))?;
    Ok(arr.iter().map(parse_pr_review).collect())
}

/// `GET /repos/{owner}/{repo}/pulls/{pr_number}/comments` — list inline
/// review comments (line-anchored). These are the threaded conversations
/// the frontend groups by `path` and then chains by `in_reply_to_id`.
#[tauri::command]
pub async fn github_list_pr_review_comments(
    auth: State<'_, GitHubAuthState>,
    owner: String,
    repo: String,
    pr_number: u32,
) -> Result<Vec<PullRequestReviewComment>, String> {
    let (client, host, r) = repo_session(auth.inner(), &owner, &repo).await?;
    // Only GitHub's line-anchored comment model matches what the frontend
    // threads by `path` + `in_reply_to_id`. Gitea's listing is flat; GitLab
    // puts line comments on discussions with a three-SHA position hash.
    // Degrade to an empty thread list rather than erroring (authoring is
    // gated by the same capability below).
    if !host.supports(HostCapability::InlineReviewComments) {
        return Ok(vec![]);
    }
    let url = host.url(&host.review_comments_path(&r, pr_number, 100));
    let resp = client
        .get(url)
        .send()
        .await
        .map_err(|e| format!("Request failed: {}", e))?;
    let body = github_response_text(resp).await?;
    let arr: Vec<serde_json::Value> = serde_json::from_str(&body)
        .map_err(|e| format!("Failed to parse PR review comments: {}", e))?;
    Ok(arr.iter().map(parse_pr_review_comment).collect())
}

/// `POST /repos/{owner}/{repo}/pulls/{n}/comments` — author a new inline review
/// comment anchored to a line of the diff. `side` is `RIGHT` (new file) or
/// `LEFT` (old file); `line` is the file line number on that side. The PR head
/// sha needed for `commit_id` is resolved here, so the caller only supplies the
/// anchor.
#[tauri::command]
pub async fn github_post_pr_review_comment(
    auth: State<'_, GitHubAuthState>,
    owner: String,
    repo: String,
    pr_number: u32,
    path: String,
    line: u32,
    side: String,
    body: String,
) -> Result<PullRequestReviewComment, String> {
    validate_github_name(&owner, "owner")?;
    validate_github_name(&repo, "repo")?;
    let trimmed = body.trim();
    if trimmed.is_empty() {
        return Err("Comment body cannot be empty".to_string());
    }
    require_capability(auth.inner(), HostCapability::InlineReviewComments).await?;
    // GitHub only accepts LEFT/RIGHT; default anything else to RIGHT (new file).
    let side_norm = if side.eq_ignore_ascii_case("LEFT") {
        "LEFT"
    } else {
        "RIGHT"
    };
    let client = github_client_from_state(auth.inner()).await?;

    // Resolve the PR head sha for `commit_id` (mirrors github_get_pr_diff).
    let pr_url = format!(
        "https://api.github.com/repos/{}/{}/pulls/{}",
        owner, repo, pr_number
    );
    let pr_resp = client
        .get(&pr_url)
        .send()
        .await
        .map_err(|e| format!("Request failed: {}", e))?;
    let pr_body = github_response_text(pr_resp).await?;
    let pr_json: serde_json::Value = serde_json::from_str(&pr_body)
        .map_err(|e| format!("Failed to parse PR response: {}", e))?;
    let head_sha = pr_json
        .get("head")
        .and_then(|h| h.get("sha"))
        .and_then(|s| s.as_str())
        .ok_or_else(|| "PR response missing head.sha".to_string())?
        .to_string();

    let url = format!(
        "https://api.github.com/repos/{}/{}/pulls/{}/comments",
        owner, repo, pr_number
    );
    let resp = client
        .post(&url)
        .json(&serde_json::json!({
            "body": trimmed,
            "commit_id": head_sha,
            "path": path,
            "line": line,
            "side": side_norm,
        }))
        .send()
        .await
        .map_err(|e| format!("Request failed: {}", e))?;
    let text = github_response_text(resp).await?;
    let v: serde_json::Value =
        serde_json::from_str(&text).map_err(|e| format!("Failed to parse comment: {}", e))?;
    Ok(parse_pr_review_comment(&v))
}

/// `POST /repos/{owner}/{repo}/pulls/{n}/comments/{comment_id}/replies` — reply
/// to an existing inline review comment thread.
#[tauri::command]
pub async fn github_reply_to_pr_review_comment(
    auth: State<'_, GitHubAuthState>,
    owner: String,
    repo: String,
    pr_number: u32,
    comment_id: u64,
    body: String,
) -> Result<PullRequestReviewComment, String> {
    validate_github_name(&owner, "owner")?;
    validate_github_name(&repo, "repo")?;
    let trimmed = body.trim();
    if trimmed.is_empty() {
        return Err("Comment body cannot be empty".to_string());
    }
    // Same guard as `github_post_pr_review_comment` — this command hardcodes
    // `api.github.com`, so without it a Gitea workspace fires the GitHub token
    // at GitHub carrying a Gitea owner/repo/comment id.
    require_capability(auth.inner(), HostCapability::InlineReviewComments).await?;
    let client = github_client_from_state(auth.inner()).await?;
    let url = format!(
        "https://api.github.com/repos/{}/{}/pulls/{}/comments/{}/replies",
        owner, repo, pr_number, comment_id
    );
    let resp = client
        .post(&url)
        .json(&serde_json::json!({ "body": trimmed }))
        .send()
        .await
        .map_err(|e| format!("Request failed: {}", e))?;
    let text = github_response_text(resp).await?;
    let v: serde_json::Value =
        serde_json::from_str(&text).map_err(|e| format!("Failed to parse comment: {}", e))?;
    Ok(parse_pr_review_comment(&v))
}

// === Notifications inbox ===================================================
//
// The GitHub notifications API returns the authenticated user's notification
// threads across all repos. Each thread has a `subject` (the Issue/PR/etc.
// it concerns) whose `url` is an *API* url; we derive a browser `html_url`
// from it so the frontend can open the subject in the system browser.

#[derive(Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct GithubNotification {
    /// Thread id (used to mark the thread read).
    pub id: String,
    pub unread: bool,
    /// Why this notification was received (e.g. `mention`, `review_requested`,
    /// `assign`, `subscribed`, `state_change`).
    pub reason: String,
    pub updated_at: String,
    pub title: String,
    /// `Issue | PullRequest | Commit | Release | Discussion | ...`
    pub subject_type: String,
    /// Browser url for the subject, derived from the API `subject.url`.
    /// Falls back to the repository url when no subject url is present.
    pub html_url: String,
    pub repository: String,
}

/// Convert a GitHub *API* url into its browser (`html_url`) equivalent.
///
/// The notifications API only exposes API urls on `subject.url` (e.g.
/// `https://api.github.com/repos/o/r/pulls/12`). We rewrite the host and the
/// `pulls` → `pull` path segment so the link opens in a browser. Unknown
/// shapes fall back to the repository html url.
///
/// `web_base` comes from the *active* host rather than being hardcoded to
/// `https://github.com`. This fallback fires whenever `subject.html_url` is
/// absent, and emitting a github.com link for a self-hosted instance would send
/// the user to a stranger's repository (or a 404) — the link-level echo of the
/// wrong-host bug this pass exists to close.
fn notification_subject_html_url(
    web_base: &str,
    api_base: &str,
    subject_type: &str,
    subject_url: Option<&str>,
    repo_full_name: &str,
) -> String {
    let repo_html = format!("{}/{}", web_base, repo_full_name);
    // Releases resolve by tag in the browser, not by the numeric API id, so the
    // notification alone can't yield a canonical release page — send the user to
    // the repo's releases list instead of a 404-ing `/releases/{id}` URL.
    if subject_type.eq_ignore_ascii_case("Release") {
        return format!("{}/releases", repo_html);
    }
    let Some(url) = subject_url else {
        return repo_html;
    };
    let Some(rest) = url.strip_prefix(&format!("{}/repos/", api_base)) else {
        return repo_html;
    };
    // `rest` looks like "o/r/pulls/12", "o/r/issues/5", or "o/r/commits/{sha}".
    // Map the API path segments to their browser equivalents (issues map 1:1;
    // pulls→pull, commits→commit are the two that differ). Unknown shapes fall
    // through to the rewritten path.
    let html = rest
        .replacen("/pulls/", "/pull/", 1)
        .replacen("/commits/", "/commit/", 1);
    format!("{}/{}", web_base, html)
}

fn parse_notification(host: &GitHost, v: &serde_json::Value) -> GithubNotification {
    let repository = v
        .get("repository")
        .and_then(|r| r.get("full_name"))
        .and_then(|x| x.as_str())
        .unwrap_or("")
        .to_string();
    let subject = v.get("subject");
    let subject_url = subject.and_then(|s| s.get("url")).and_then(|x| x.as_str());
    let subject_type = subject
        .and_then(|s| s.get("type"))
        .and_then(|x| x.as_str())
        .unwrap_or("");
    // G12: Gitea provides a ready-made subject.html_url; GitHub does not, so we
    // synthesize one from the API subject URL there.
    let subject_html_url = subject
        .and_then(|s| s.get("html_url"))
        .and_then(|x| x.as_str())
        .filter(|s| !s.is_empty());
    GithubNotification {
        // GitHub ids are strings; Gitea's are numbers.
        id: v
            .get("id")
            .and_then(|x| {
                x.as_str()
                    .map(str::to_string)
                    .or_else(|| x.as_u64().map(|n| n.to_string()))
            })
            .unwrap_or_default(),
        unread: v.get("unread").and_then(|x| x.as_bool()).unwrap_or(false),
        reason: v
            .get("reason")
            .and_then(|x| x.as_str())
            .unwrap_or("")
            .to_string(),
        updated_at: v
            .get("updated_at")
            .and_then(|x| x.as_str())
            .unwrap_or("")
            .to_string(),
        title: subject
            .and_then(|s| s.get("title"))
            .and_then(|x| x.as_str())
            .unwrap_or("")
            .to_string(),
        subject_type: subject_type.to_string(),
        html_url: subject_html_url.map(str::to_string).unwrap_or_else(|| {
            notification_subject_html_url(
                &host.web_base(),
                &host.api_base,
                subject_type,
                subject_url,
                &repository,
            )
        }),
        repository,
    }
}

/// `GET /notifications` — list the authenticated user's notification threads.
/// When `all` is false (or omitted) only unread threads are returned.
#[tauri::command]
pub async fn github_list_notifications(
    auth: State<'_, GitHubAuthState>,
    all: Option<bool>,
) -> Result<Vec<GithubNotification>, String> {
    let (client, host) = active_host_session(auth.inner()).await?;
    // GitLab has no notification inbox — its analogue is Todos, a different
    // resource with a different shape. Return nothing rather than 404-ing the
    // whole pane on a `/notifications` path GitLab does not serve.
    if !host.supports(HostCapability::Notifications) {
        return Ok(vec![]);
    }
    let all = all.unwrap_or(false);
    let url = host.url(&host.notifications_path(all, 50));
    let resp = client
        .get(url)
        .send()
        .await
        .map_err(|e| format!("Request failed: {}", e))?;
    let body = github_response_text(resp).await?;
    let arr: Vec<serde_json::Value> =
        serde_json::from_str(&body).map_err(|e| format!("Failed to parse notifications: {}", e))?;
    Ok(arr.iter().map(|v| parse_notification(&host, v)).collect())
}

/// `PATCH /notifications/threads/{thread_id}` — mark a single notification
/// thread as read. Returns `Ok(())` on success.
#[tauri::command]
pub async fn github_mark_notification_read(
    auth: State<'_, GitHubAuthState>,
    thread_id: String,
) -> Result<(), String> {
    validate_github_name(&thread_id, "thread_id")?;
    let (client, host) = active_host_session(auth.inner()).await?;
    require_capability(auth.inner(), HostCapability::Notifications).await?;
    // GitHub marks a thread read with a bare PATCH; Gitea needs ?to-status=read.
    let path = match host.kind {
        GitHostKind::Gitea => format!("/notifications/threads/{}?to-status=read", thread_id),
        _ => format!("/notifications/threads/{}", thread_id),
    };
    let resp = client
        .patch(host.url(&path))
        .send()
        .await
        .map_err(|e| format!("Request failed: {}", e))?;
    // On success GitHub returns 205 (reset content) with an empty body, so we
    // check the status directly rather than reading a JSON body.
    if !resp.status().is_success() {
        return Err(host_error_from_response(resp).await);
    }
    Ok(())
}

#[cfg(test)]
impl DeviceAuthState {
    /// Rewind the parked credential's mint time so TTL behaviour is testable
    /// without sleeping for twenty minutes.
    fn age_by(&self, secs: u64) {
        if let Some(p) = self.lock().as_mut() {
            p.minted = p
                .minted
                .checked_sub(std::time::Duration::from_secs(secs))
                .expect("test clock underflow");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validate_github_name_accepts_valid() {
        assert!(validate_github_name("valid-repo", "repo").is_ok());
    }

    #[test]
    fn validate_github_name_rejects_empty() {
        assert!(validate_github_name("", "repo").is_err());
    }

    #[test]
    fn validate_github_name_rejects_too_long() {
        let long = "a".repeat(101);
        assert!(validate_github_name(&long, "repo").is_err());
    }

    #[test]
    fn validate_github_name_rejects_invalid_chars() {
        assert!(validate_github_name("repo;drop", "repo").is_err());
    }

    #[test]
    fn strip_json_fences_handles_plain() {
        assert_eq!(strip_json_fences("[]"), "[]");
        assert_eq!(strip_json_fences("  [1,2]  "), "[1,2]");
    }

    #[test]
    fn strip_json_fences_handles_fenced() {
        assert_eq!(strip_json_fences("```json\n[1,2]\n```"), "[1,2]");
        assert_eq!(strip_json_fences("```\n[1,2]\n```"), "[1,2]");
    }

    #[test]
    fn truncate_chars_v0_8_f_respects_char_count() {
        assert_eq!(truncate_chars_v0_8_f("hello", 10), "hello");
        assert_eq!(truncate_chars_v0_8_f("helloworld", 5), "hello…");
    }

    #[test]
    fn format_rfc3339_utc_known_value() {
        let ms: i64 = 1_705_322_096_000;
        assert_eq!(format_rfc3339_utc(ms), "2024-01-15T12:34:56Z");
    }

    #[test]
    fn default_since_iso_returns_valid_rfc3339() {
        let s = default_since_iso();
        assert_eq!(s.len(), 20);
        assert!(s.ends_with('Z'));
        assert_eq!(&s[4..5], "-");
        assert_eq!(&s[10..11], "T");
    }

    // --- host-named errors -------------------------------------------------
    // Regression: every sanitized failure used to read "GitHub API error",
    // including responses that came back from a self-hosted Gitea/Forgejo.

    fn url(s: &str) -> reqwest::Url {
        reqwest::Url::parse(s).expect("test url")
    }

    #[test]
    fn host_label_names_github_cloud() {
        assert_eq!(
            host_label_from_url(&url("https://api.github.com/repos/o/r/pulls/1")),
            "GitHub"
        );
    }

    #[test]
    fn host_label_names_the_gitea_instance_that_answered() {
        assert_eq!(
            host_label_from_url(&url("https://git.example.com/api/v1/repos/o/r/issues")),
            "git.example.com"
        );
    }

    #[test]
    fn sanitized_error_does_not_blame_github_for_a_gitea_response() {
        let msg = sanitize_host_error(
            &host_label_from_url(&url("https://git.example.com/api/v1/user")),
            reqwest::StatusCode::UNAUTHORIZED,
        );
        assert_eq!(
            msg,
            "git.example.com API error 401: unauthorized — check your git.example.com token"
        );
        assert!(!msg.contains("GitHub"));
    }

    #[test]
    fn sanitized_error_still_names_github_for_a_github_response() {
        let label = host_label_from_url(&url("https://api.github.com/user"));
        assert_eq!(
            sanitize_host_error(&label, reqwest::StatusCode::UNAUTHORIZED),
            "GitHub API error 401: unauthorized — check your GitHub token"
        );
        assert_eq!(
            sanitize_host_error(&label, reqwest::StatusCode::INTERNAL_SERVER_ERROR),
            "GitHub API error 500: GitHub server error — try again later"
        );
    }

    #[test]
    fn sanitized_error_keeps_host_neutral_reasons_unchanged() {
        let label = host_label_from_url(&url("https://git.example.com/api/v1/user"));
        assert_eq!(
            sanitize_host_error(&label, reqwest::StatusCode::NOT_FOUND),
            "git.example.com API error 404: not found — the resource may not exist or may be private"
        );
    }

    // --- capability guards (the denial paths) -------------------------------
    //
    // Regression the guards exist for: `github_reply_to_pr_review_comment`
    // hardcodes `https://api.github.com/...` but shipped without the guard its
    // sibling `github_post_pr_review_comment` had, so a Gitea workspace sent
    // the GitHub token to GitHub with a Gitea repo path (fixed in b3de2bdf).
    // The guards are now an allow-list, so a host kind nobody wrote a
    // deny-branch for is refused rather than admitted.

    fn auth_state(connections: Vec<GitHostConnection>, active: &str) -> GitHubAuthState {
        GitHubAuthState {
            connections: RwLock::new(connections),
            tokens: RwLock::new(HashMap::new()),
            active_connection_id: RwLock::new(active.to_string()),
        }
    }

    fn auth_state_with_tokens(
        connections: Vec<GitHostConnection>,
        active: &str,
        tokens: &[(&str, &str)],
    ) -> GitHubAuthState {
        let map: HashMap<String, String> = tokens
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect();
        GitHubAuthState {
            connections: RwLock::new(connections),
            tokens: RwLock::new(map),
            active_connection_id: RwLock::new(active.to_string()),
        }
    }

    #[tokio::test]
    async fn explicit_pr_connection_stays_pinned_when_active_connection_changes() {
        let auth = auth_state_with_tokens(
            vec![GitHostConnection::github(), gitea_connection()],
            "github",
            &[("github", "fixture-token"), ("gitea-1", "fixture-token")],
        );
        let (_, pinned, _) = repo_session_for_connection(&auth, "owner", "repo", Some("gitea-1"))
            .await
            .unwrap();
        assert_eq!(pinned.kind, GitHostKind::Gitea);
        assert_eq!(*auth.active_connection_id.read().await, "github");
        let (_, legacy, _) = repo_session_for_connection(&auth, "owner", "repo", None)
            .await
            .unwrap();
        assert_eq!(legacy.kind, GitHostKind::GitHub);
        assert!(
            repo_session_for_connection(&auth, "owner", "repo", Some("missing"))
                .await
                .is_err()
        );
        assert!(
            repo_session_for_connection(&auth, "owner", "repo", Some(""))
                .await
                .is_err()
        );
    }

    fn gitea_connection() -> GitHostConnection {
        GitHostConnection {
            id: "gitea-1".to_string(),
            kind: GitHostKind::Gitea,
            base_url: "https://git.example.com".to_string(),
            label: "Self-hosted".to_string(),
        }
    }

    fn gitlab_connection() -> GitHostConnection {
        GitHostConnection {
            id: "gitlab-gitlab-com".to_string(),
            kind: GitHostKind::GitLab,
            base_url: "https://gitlab.com".to_string(),
            label: "GitLab".to_string(),
        }
    }

    #[tokio::test]
    async fn inline_review_guard_refuses_a_gitea_workspace() {
        let auth = auth_state(
            vec![GitHostConnection::github(), gitea_connection()],
            "gitea-1",
        );
        let err = require_capability(&auth, HostCapability::InlineReviewComments)
            .await
            .expect_err("Gitea must be refused before any api.github.com request");
        assert!(err.contains("Gitea"), "unexpected message: {err}");
    }

    #[tokio::test]
    async fn inline_review_guard_refuses_a_gitlab_workspace() {
        // THE fail-open regression: the old guard was `if kind == Gitea`, so a
        // GitLab workspace passed straight through into the hardcoded
        // api.github.com request.
        let auth = auth_state(
            vec![GitHostConnection::github(), gitlab_connection()],
            "gitlab-gitlab-com",
        );
        let err = require_capability(&auth, HostCapability::InlineReviewComments)
            .await
            .expect_err("GitLab must be refused before any api.github.com request");
        assert!(err.contains("GitLab"), "unexpected message: {err}");
    }

    #[tokio::test]
    async fn ai_assist_guard_refuses_every_non_github_host() {
        for (conns, active, name) in [
            (
                vec![GitHostConnection::github(), gitea_connection()],
                "gitea-1",
                "Gitea",
            ),
            (
                vec![GitHostConnection::github(), gitlab_connection()],
                "gitlab-gitlab-com",
                "GitLab",
            ),
        ] {
            let auth = auth_state(conns, active);
            let err = require_capability(&auth, HostCapability::AiAssist)
                .await
                .expect_err("the AI commands hardcode api.github.com and must be refused");
            assert!(err.contains(name), "expected {name} in: {err}");
        }
    }

    #[tokio::test]
    async fn check_runs_and_notifications_stay_available_on_gitea() {
        // Guard against the allow-list quietly narrowing Gitea's existing
        // surface while adding GitLab.
        let auth = auth_state(
            vec![GitHostConnection::github(), gitea_connection()],
            "gitea-1",
        );
        assert!(require_capability(&auth, HostCapability::Notifications)
            .await
            .is_ok());
        assert!(require_capability(&auth, HostCapability::PrReviews)
            .await
            .is_ok());
        assert!(require_capability(&auth, HostCapability::RequestReviewers)
            .await
            .is_ok());
        // ...and that check-runs is still refused there, as before.
        assert!(require_capability(&auth, HostCapability::CheckRuns)
            .await
            .is_err());
    }

    #[tokio::test]
    async fn inline_review_guard_allows_a_github_workspace() {
        let auth = auth_state(vec![GitHostConnection::github()], GITHUB_CONNECTION_ID);
        assert!(
            require_capability(&auth, HostCapability::InlineReviewComments)
                .await
                .is_ok()
        );
    }

    #[tokio::test]
    async fn inline_review_guard_defaults_to_github_for_an_unknown_connection() {
        // `active_host_kind` falls back to GitHub when the active id resolves to
        // nothing; the guard must not block on that path. The hard stop for
        // that case is `github_client_from_state`, below — it refuses to hand
        // out a credential it cannot attribute to a host.
        let auth = auth_state(vec![GitHostConnection::github()], "vanished");
        assert!(
            require_capability(&auth, HostCapability::InlineReviewComments)
                .await
                .is_ok()
        );
    }

    // --- github_client_from_state picks the ACTIVE connection ---------------

    #[tokio::test]
    async fn github_only_client_refuses_a_non_github_active_connection() {
        // Previously this read the token of the connection literally named
        // "github" regardless of which connection was active, so a missing
        // capability guard upstream meant the GitHub PAT went out to
        // api.github.com carrying another host's ids. It now fails closed.
        let auth = auth_state_with_tokens(
            vec![GitHostConnection::github(), gitlab_connection()],
            "gitlab-gitlab-com",
            &[
                (GITHUB_CONNECTION_ID, "gh-secret"),
                ("gitlab-gitlab-com", "gl-secret"),
            ],
        );
        let err = github_client_from_state(&auth)
            .await
            .err()
            .expect("a GitLab-active workspace must not receive a GitHub client");
        assert!(err.contains("GitLab"), "unexpected message: {err}");
        assert!(!err.contains("gh-secret"));
    }

    #[tokio::test]
    async fn github_only_client_refuses_an_unresolvable_active_connection() {
        // No connection, no proof of which host this is — refuse rather than
        // defaulting to GitHub and reaching for its token.
        let auth = auth_state_with_tokens(
            vec![GitHostConnection::github()],
            "vanished",
            &[(GITHUB_CONNECTION_ID, "gh-secret")],
        );
        assert!(github_client_from_state(&auth).await.is_err());
    }

    #[tokio::test]
    async fn github_only_client_works_on_a_github_workspace() {
        let auth = auth_state_with_tokens(
            vec![GitHostConnection::github(), gitlab_connection()],
            GITHUB_CONNECTION_ID,
            &[(GITHUB_CONNECTION_ID, "gh-secret")],
        );
        assert!(github_client_from_state(&auth).await.is_ok());
    }

    // --- connection persistence --------------------------------------------

    #[test]
    fn every_non_github_kind_is_persisted() {
        // Regression: `save_gitea_connections` filtered on `kind == Gitea`, so
        // a GitLab connection was silently dropped on the next save and
        // vanished on restart.
        assert!(is_persisted_connection(&gitea_connection()));
        assert!(is_persisted_connection(&gitlab_connection()));
        assert!(!is_persisted_connection(&GitHostConnection::github()));
    }

    #[test]
    fn connection_ids_are_prefixed_by_kind_and_deduplicated() {
        let existing = vec![GitHostConnection::github()];
        assert_eq!(
            unique_connection_id(GitHostKind::GitLab, "https://gitlab.com", &existing),
            "gitlab-gitlab-com"
        );
        assert_eq!(
            unique_connection_id(GitHostKind::Gitea, "https://git.example.com", &existing),
            "gitea-git-example-com"
        );
        // The same hostname serving two kinds does not collide.
        let mut two = existing.clone();
        two.push(gitlab_connection());
        assert_eq!(
            unique_connection_id(GitHostKind::Gitea, "https://gitlab.com", &two),
            "gitea-gitlab-com"
        );
        // A second connection to the same host is suffixed.
        assert_eq!(
            unique_connection_id(GitHostKind::GitLab, "https://gitlab.com", &two),
            "gitlab-gitlab-com-2"
        );
    }

    // --- notification links stay on the host that issued them ---------------

    #[test]
    fn notification_fallback_link_uses_the_active_hosts_web_origin() {
        let gh = GitHost::github();
        assert_eq!(
            notification_subject_html_url(
                &gh.web_base(),
                &gh.api_base,
                "PullRequest",
                Some("https://api.github.com/repos/o/r/pulls/12"),
                "o/r"
            ),
            "https://github.com/o/r/pull/12"
        );
        // A self-hosted instance must not be linked to github.com.
        let gt = GitHost::gitea("https://git.example.com");
        let link = notification_subject_html_url(
            &gt.web_base(),
            &gt.api_base,
            "Issue",
            Some("https://git.example.com/api/v1/repos/o/r/issues/5"),
            "o/r",
        );
        assert_eq!(link, "https://git.example.com/o/r/issues/5");
        assert!(!link.contains("github.com"));
        // Unknown subject shapes fall back to the repo page on the same host.
        assert_eq!(
            notification_subject_html_url(&gt.web_base(), &gt.api_base, "Release", None, "o/r"),
            "https://git.example.com/o/r/releases"
        );
    }

    // --- editing / rotating an existing connection ---------------------------
    //
    // The property under test throughout: a rotation that does not end in a
    // verified credential must leave the working one exactly where it was.

    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Mutex;

    fn probe_spec() -> GitHostProbeSpec {
        GitHostProbeSpec {
            api_prefix: "/api/v4".to_string(),
            identity_path: "/user".to_string(),
            auth_scheme: "private-token".to_string(),
            accept: Some("application/json".to_string()),
            scope_header: None,
            scope_path: None,
            scope_field: None,
            login_fields: vec!["username".to_string()],
        }
    }

    fn probe_ok() -> GitHostProbeResult {
        GitHostProbeResult {
            outcome: GitHostProbeOutcome::Ok,
            status: Some(200),
            login: Some("octocat".to_string()),
            avatar_url: None,
            scopes: Some(vec!["api".to_string()]),
            detail: None,
            endpoint: "https://gitlab.com/api/v4/user".to_string(),
        }
    }

    fn probe_failed(outcome: GitHostProbeOutcome) -> GitHostProbeResult {
        GitHostProbeResult {
            outcome,
            status: Some(401),
            login: None,
            avatar_url: None,
            scopes: None,
            detail: Some("The host rejected this token.".to_string()),
            endpoint: "https://gitlab.com/api/v4/user".to_string(),
        }
    }

    /// Records every keyring/config write so a test can assert one never happened.
    #[derive(Default)]
    struct Writes {
        tokens: Mutex<Vec<(String, String)>>,
        connections: Mutex<Vec<Vec<GitHostConnection>>>,
        fail_token_write: bool,
    }

    impl Writes {
        fn token_writer(&self) -> impl Fn(&str, &str) -> Result<(), String> + '_ {
            move |id: &str, token: &str| {
                if self.fail_token_write {
                    return Err("OS keyring unavailable".to_string());
                }
                self.tokens
                    .lock()
                    .unwrap()
                    .push((id.to_string(), token.to_string()));
                Ok(())
            }
        }
        fn connection_writer(&self) -> impl Fn(&[GitHostConnection]) -> Result<(), String> + '_ {
            move |conns: &[GitHostConnection]| {
                self.connections.lock().unwrap().push(conns.to_vec());
                Ok(())
            }
        }
        fn token_writes(&self) -> Vec<(String, String)> {
            self.tokens.lock().unwrap().clone()
        }
    }

    fn rotation(token: &str) -> GitHostConnectionUpdate {
        GitHostConnectionUpdate {
            token: Some(token.to_string()),
            probe: Some(probe_spec()),
            ..Default::default()
        }
    }

    fn gitlab_state() -> GitHubAuthState {
        auth_state_with_tokens(
            vec![GitHostConnection::github(), gitlab_connection()],
            "gitlab-gitlab-com",
            &[
                (GITHUB_CONNECTION_ID, "gh-old-secret"),
                ("gitlab-gitlab-com", "glpat-old-secret"),
            ],
        )
    }

    #[tokio::test]
    async fn rotation_replaces_the_token_once_the_host_accepts_it() {
        let auth = gitlab_state();
        let writes = Writes::default();
        let probes = AtomicUsize::new(0);

        update_connection_inner(
            &auth,
            "gitlab-gitlab-com",
            rotation("glpat-new-secret"),
            |req| {
                probes.fetch_add(1, Ordering::SeqCst);
                // The origin must come from the STORED connection, never the
                // request — otherwise a rotation could be pointed elsewhere.
                assert_eq!(req.base_url, "https://gitlab.com");
                assert_eq!(req.token, "glpat-new-secret");
                async { Ok(probe_ok()) }
            },
            &writes.connection_writer(),
            &writes.token_writer(),
        )
        .await
        .expect("a green probe must save");

        assert_eq!(probes.load(Ordering::SeqCst), 1);
        assert_eq!(
            writes.token_writes(),
            vec![(
                "gitlab-gitlab-com".to_string(),
                "glpat-new-secret".to_string()
            )],
            "the token must land under the SAME connection id"
        );
        assert_eq!(
            auth.tokens.read().await.get("gitlab-gitlab-com").unwrap(),
            "glpat-new-secret"
        );
        // Nothing else moved.
        assert_eq!(
            auth.tokens.read().await.get(GITHUB_CONNECTION_ID).unwrap(),
            "gh-old-secret"
        );
        assert_eq!(auth.connections.read().await.len(), 2, "no new connection");
    }

    #[tokio::test]
    async fn a_rejected_token_leaves_the_working_one_in_place() {
        // THE property. Every red outcome must abort before any write.
        for outcome in [
            GitHostProbeOutcome::InvalidToken,
            GitHostProbeOutcome::Forbidden,
            GitHostProbeOutcome::RateLimited,
            GitHostProbeOutcome::NotAHost,
            GitHostProbeOutcome::Unreachable,
            GitHostProbeOutcome::TlsError,
            GitHostProbeOutcome::ServerError,
            GitHostProbeOutcome::Unknown,
        ] {
            let auth = gitlab_state();
            let writes = Writes::default();

            let err = update_connection_inner(
                &auth,
                "gitlab-gitlab-com",
                rotation("glpat-DEAD-secret"),
                |_req| async move { Ok(probe_failed(outcome)) },
                &writes.connection_writer(),
                &writes.token_writer(),
            )
            .await
            .expect_err("a red probe must refuse the rotation");

            assert!(
                writes.token_writes().is_empty(),
                "{outcome:?}: nothing may reach the keyring"
            );
            assert_eq!(
                auth.tokens.read().await.get("gitlab-gitlab-com").unwrap(),
                "glpat-old-secret",
                "{outcome:?}: the working credential must survive"
            );
            assert!(
                !err.contains("glpat-DEAD-secret"),
                "{outcome:?}: the error echoed the token back"
            );
            assert!(err.contains("unchanged"), "{outcome:?}: unhelpful: {err}");
        }
    }

    #[tokio::test]
    async fn a_probe_that_cannot_run_at_all_also_keeps_the_old_token() {
        // The probe command itself can reject the arguments (unencodable token,
        // malformed descriptor path). That is not a green light either.
        let auth = gitlab_state();
        let writes = Writes::default();

        update_connection_inner(
            &auth,
            "gitlab-gitlab-com",
            rotation("glpat-new-secret"),
            |_req| async { Err("Token cannot be encoded as an HTTP header value.".to_string()) },
            &writes.connection_writer(),
            &writes.token_writer(),
        )
        .await
        .expect_err("a probe error must not be treated as a pass");

        assert!(writes.token_writes().is_empty());
        assert_eq!(
            auth.tokens.read().await.get("gitlab-gitlab-com").unwrap(),
            "glpat-old-secret"
        );
    }

    #[tokio::test]
    async fn a_keyring_write_failure_leaves_the_process_on_the_old_token() {
        // If the durable copy did not land, the in-memory copy must not either
        // — otherwise this session would run on a credential that vanishes at
        // restart, and the user would have no idea which one is live.
        let auth = gitlab_state();
        let writes = Writes {
            fail_token_write: true,
            ..Default::default()
        };

        update_connection_inner(
            &auth,
            "gitlab-gitlab-com",
            rotation("glpat-new-secret"),
            |_req| async { Ok(probe_ok()) },
            &writes.connection_writer(),
            &writes.token_writer(),
        )
        .await
        .expect_err("a keyring failure must surface");

        assert_eq!(
            auth.tokens.read().await.get("gitlab-gitlab-com").unwrap(),
            "glpat-old-secret"
        );
    }

    #[tokio::test]
    async fn a_label_only_edit_never_asks_for_a_token() {
        let auth = gitlab_state();
        let writes = Writes::default();

        update_connection_inner(
            &auth,
            "gitlab-gitlab-com",
            GitHostConnectionUpdate {
                label: Some("  Work GitLab  ".to_string()),
                ..Default::default()
            },
            |_req| async {
                panic!("a label-only edit must not probe — there is no new credential");
            },
            &writes.connection_writer(),
            &writes.token_writer(),
        )
        .await
        .expect("renaming must not require re-entering a token");

        assert!(
            writes.token_writes().is_empty(),
            "the stored token must not be rewritten by a rename"
        );
        assert_eq!(
            auth.tokens.read().await.get("gitlab-gitlab-com").unwrap(),
            "glpat-old-secret"
        );
        assert_eq!(
            auth.connections.read().await[1].label,
            "Work GitLab",
            "the label is trimmed and applied"
        );
        assert_eq!(writes.connections.lock().unwrap().len(), 1);
    }

    #[tokio::test]
    async fn the_github_singleton_rotates_under_its_historical_account() {
        // The built-in connection stores its token as `github-token`, not
        // `git-host-token-github`. Rotation must reach that same account so
        // nothing else has to be re-pointed.
        let auth = gitlab_state();
        let writes = Writes::default();

        update_connection_inner(
            &auth,
            GITHUB_CONNECTION_ID,
            rotation("ghp-new-secret"),
            |req| {
                assert_eq!(req.base_url, "https://api.github.com");
                async { Ok(probe_ok()) }
            },
            &writes.connection_writer(),
            &writes.token_writer(),
        )
        .await
        .expect("the GitHub singleton must be rotatable");

        assert_eq!(
            writes.token_writes(),
            vec![(
                GITHUB_CONNECTION_ID.to_string(),
                "ghp-new-secret".to_string()
            )]
        );
        assert_eq!(host_token_account(GITHUB_CONNECTION_ID), "github-token");
    }

    #[tokio::test]
    async fn an_unknown_connection_is_refused_before_anything_is_probed() {
        let auth = gitlab_state();
        let writes = Writes::default();

        let err = update_connection_inner(
            &auth,
            "gitea-does-not-exist",
            rotation("glpat-new-secret"),
            |_req| async {
                panic!("an unknown connection must never reach the probe");
            },
            &writes.connection_writer(),
            &writes.token_writer(),
        )
        .await
        .expect_err("unknown ids must be refused");
        assert!(err.contains("Unknown connection"), "unexpected: {err}");
        assert!(writes.token_writes().is_empty());
    }

    // --- the pure guards ---------------------------------------------------

    #[test]
    fn changing_kind_or_base_url_is_refused_as_a_different_connection() {
        let conn = gitlab_connection();

        let err = plan_connection_update(
            &conn,
            &GitHostConnectionUpdate {
                kind: Some(GitHostKind::Gitea),
                label: Some("renamed".to_string()),
                ..Default::default()
            },
        )
        .expect_err("a kind change is a different connection");
        assert!(err.contains("cannot be changed"), "unexpected: {err}");

        let err = plan_connection_update(
            &conn,
            &GitHostConnectionUpdate {
                base_url: Some("https://gitlab.internal".to_string()),
                label: Some("renamed".to_string()),
                ..Default::default()
            },
        )
        .expect_err("an address change is a different connection");
        assert!(err.contains("cannot be changed"), "unexpected: {err}");
    }

    #[test]
    fn echoing_back_the_unchanged_kind_and_url_is_not_a_change() {
        // The UI sends both as an optimistic-concurrency assertion; a trailing
        // slash difference must not read as an attempted edit.
        let conn = gitlab_connection();
        let plan = plan_connection_update(
            &conn,
            &GitHostConnectionUpdate {
                kind: Some(GitHostKind::GitLab),
                base_url: Some("https://gitlab.com/".to_string()),
                label: Some("Work".to_string()),
                ..Default::default()
            },
        )
        .expect("an unchanged assertion must pass");
        assert_eq!(
            plan,
            ConnectionUpdatePlan {
                label: Some("Work".to_string()),
                rotates_token: false,
            }
        );
    }

    #[test]
    fn a_token_without_a_way_to_check_it_is_refused() {
        // No descriptor means no validation, and an unvalidated write is
        // exactly the failure mode this command exists to remove.
        let err = plan_connection_update(
            &gitlab_connection(),
            &GitHostConnectionUpdate {
                token: Some("glpat-new".to_string()),
                probe: None,
                ..Default::default()
            },
        )
        .expect_err("an unverifiable token must be refused");
        assert!(err.contains("verified"), "unexpected: {err}");
    }

    #[test]
    fn empty_fields_and_no_op_updates_are_refused() {
        let conn = gitlab_connection();
        assert!(plan_connection_update(
            &conn,
            &GitHostConnectionUpdate {
                token: Some("   ".to_string()),
                probe: Some(probe_spec()),
                ..Default::default()
            }
        )
        .is_err());
        assert!(plan_connection_update(
            &conn,
            &GitHostConnectionUpdate {
                label: Some("  ".to_string()),
                ..Default::default()
            }
        )
        .is_err());
        // Re-submitting the same label with no token changes nothing.
        assert!(plan_connection_update(
            &conn,
            &GitHostConnectionUpdate {
                label: Some(conn.label.clone()),
                ..Default::default()
            }
        )
        .is_err());
        assert!(plan_connection_update(&conn, &GitHostConnectionUpdate::default()).is_err());
    }

    #[test]
    fn the_github_singletons_label_is_fixed_but_its_token_is_not() {
        let conn = GitHostConnection::github();
        let err = plan_connection_update(
            &conn,
            &GitHostConnectionUpdate {
                label: Some("My GitHub".to_string()),
                ..Default::default()
            },
        )
        .expect_err("a rename would silently revert on restart");
        assert!(err.contains("fixed"), "unexpected: {err}");

        let plan = plan_connection_update(
            &conn,
            &GitHostConnectionUpdate {
                token: Some("ghp-new".to_string()),
                probe: Some(probe_spec()),
                ..Default::default()
            },
        )
        .expect("rotation must still work on the singleton");
        assert!(plan.rotates_token);
        assert_eq!(plan.label, None);
    }

    #[test]
    fn a_rotation_refusal_never_carries_the_credential() {
        for outcome in [
            GitHostProbeOutcome::InvalidToken,
            GitHostProbeOutcome::Forbidden,
            GitHostProbeOutcome::RateLimited,
            GitHostProbeOutcome::NotAHost,
            GitHostProbeOutcome::Unreachable,
            GitHostProbeOutcome::TlsError,
            GitHostProbeOutcome::ServerError,
            GitHostProbeOutcome::Unknown,
            GitHostProbeOutcome::Ok,
        ] {
            let message = rotation_refusal(outcome);
            assert!(message.contains("existing credential is unchanged"));
            assert!(!message.contains("glpat"));
        }
    }

    // ---- Device-flow: the parked credential ------------------------------
    //
    // The property under test is the ordering the wizard depends on: GitHub
    // minting a token is not enough to put it in the keyring. Only a probe
    // that came back clean can, and only once.

    #[test]
    fn a_parked_device_credential_is_not_committable_until_a_probe_vouches_for_it() {
        let state = DeviceAuthState::default();
        let id = state.stash("gho_parked".to_string());

        // FAULT this pins: the old poll wrote to the keyring the instant
        // GitHub said "authorized", so an under-scoped or unusable credential
        // was persisted before anything had looked at it.
        let refused = state.take_verified(&id).unwrap_err();
        assert!(refused.contains("not been checked"));

        state.set_verified(&id, true);
        assert_eq!(state.take_verified(&id).unwrap().as_str(), "gho_parked");
        // Consumed: a second commit has nothing to write.
        assert!(state.take_verified(&id).is_err());
    }

    #[test]
    fn a_failed_probe_revokes_a_previous_pass() {
        let state = DeviceAuthState::default();
        let id = state.stash("gho_parked".to_string());
        state.set_verified(&id, true);
        // "Verify again" landing on a red verdict must not leave the earlier
        // green one standing as the thing commit checks.
        state.set_verified(&id, false);
        assert!(state.take_verified(&id).is_err());
    }

    #[test]
    fn a_stale_handle_reaches_neither_the_token_nor_the_commit() {
        let state = DeviceAuthState::default();
        let first = state.stash("gho_first".to_string());
        state.set_verified(&first, true);
        // Starting a second sign-in replaces the parked credential; the first
        // handle must not still be able to commit the second one's token.
        let second = state.stash("gho_second".to_string());
        assert!(state.token_for(&first).is_err());
        assert!(state.take_verified(&first).is_err());
        state.set_verified(&second, true);
        assert_eq!(state.take_verified(&second).unwrap().as_str(), "gho_second");
    }

    #[test]
    fn set_verified_ignores_a_handle_that_is_not_the_parked_one() {
        let state = DeviceAuthState::default();
        state.stash("gho_current".to_string());
        state.set_verified("some-other-handle", true);
        // The current entry stays unverified: a stale handle cannot vouch for it.
        let id = {
            let slot = state.lock();
            slot.as_ref().expect("parked").id.clone()
        };
        assert!(state.take_verified(&id).is_err());
    }

    #[test]
    fn an_abandoned_sign_in_ages_out_instead_of_lingering() {
        let state = DeviceAuthState::default();
        let id = state.stash("gho_abandoned".to_string());
        state.set_verified(&id, true);
        state.age_by(PENDING_DEVICE_AUTH_TTL_SECS + 1);

        let expired = state.token_for(&id).unwrap_err();
        assert!(expired.contains("took too long"));
        // And the read dropped it, so the credential is gone from memory too.
        assert!(state.lock().is_none());
    }

    #[test]
    fn discard_drops_the_credential_and_is_safe_to_repeat() {
        let state = DeviceAuthState::default();
        let id = state.stash("gho_walked_away".to_string());
        state.discard(&id);
        assert!(state.lock().is_none());
        state.discard(&id);
        state.discard("never-existed");
    }

    #[test]
    fn no_device_flow_message_can_carry_the_credential() {
        let state = DeviceAuthState::default();
        let id = state.stash("gho_SECRET_CANARY".to_string());
        state.age_by(PENDING_DEVICE_AUTH_TTL_SECS + 1);
        for message in [
            state.token_for(&id).unwrap_err(),
            state.take_verified("bogus").unwrap_err(),
            PENDING_UNKNOWN.to_string(),
            PENDING_EXPIRED.to_string(),
            PENDING_UNVERIFIED.to_string(),
        ] {
            assert!(!message.contains("gho_"), "leaked in: {}", message);
        }
    }
}
