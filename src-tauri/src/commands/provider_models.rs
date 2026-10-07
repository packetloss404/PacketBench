//! Live model discovery across the API-agent providers.
//!
//! Every provider we can query publishes some form of `GET .../models`. This
//! module calls those endpoints and normalises the wildly different payloads
//! into one [`LiveModel`] row so the frontend can stop shipping a hardcoded
//! catalog.
//!
//! Structurally this follows [`crate::commands::ollama::list_ollama_models`]:
//! a short `reqwest` timeout, connect/timeout errors mapped to human strings,
//! non-2xx surfaced with status + URL, and — importantly — **one pure parse
//! function per wire shape**, unit-tested against inline fixtures with no
//! network access.
//!
//! ## What each provider actually gives us
//!
//! | Provider | id | display name | context | max output | pricing |
//! |---|---|---|---|---|---|
//! | anthropic | yes | yes | yes | yes | no |
//! | openai | yes | no | no | no | no |
//! | openrouter | yes | yes | yes | yes | **yes** |
//! | minimax | yes | no | no | no | no |
//! | ollama | yes | no | newer daemons | no | n/a |
//! | custom | yes | no | no | no | no |
//!
//! OpenRouter is the only source of live pricing; everything else leaves the
//! two `*_per_mtok` fields `None` and the caller falls back to its own table.
//!
//! ## Error encoding
//!
//! The command returns `Result<_, String>` (the convention throughout
//! `commands/`), so the states the UI renders differently are carried as a
//! machine-readable tag prefix — `"<tag>: <human message>"`. See [`ERR_NO_KEY`]
//! and friends; `src/lib/tauri.ts` parses them back into a discriminated union.

use serde::{Deserialize, Serialize};
use std::time::Duration;
use tracing::{info, warn};

/// Timeout for the remote catalog endpoints. Longer than Ollama's 2s because
/// these are internet round trips, short enough that a hung provider does not
/// wedge a picker.
const REMOTE_TIMEOUT: Duration = Duration::from_millis(10_000);

/// Ceiling on Anthropic cursor pages. At `limit=1000` per page this is far
/// beyond any plausible catalog; it exists only so a server that never clears
/// `has_more` cannot spin us forever.
const MAX_ANTHROPIC_PAGES: usize = 10;

/// Anthropic's dated API version header. Mirrors `core::llm_anthropic`.
const ANTHROPIC_VERSION: &str = "2023-06-01";

// ---------------------------------------------------------------------------
// Error tags
// ---------------------------------------------------------------------------

/// Keyed provider with no credential in the keyring. Expected and benign —
/// render as "connect this provider", never as a failure.
pub const ERR_NO_KEY: &str = "no-key";
/// `custom` with no base URL saved. Same benign class as [`ERR_NO_KEY`].
pub const ERR_NOT_CONFIGURED: &str = "not-configured";
/// A key *was* sent and the provider rejected it (HTTP 401/403, or MiniMax's
/// HTTP-200 error envelope). This is the earliest cheap signal that a stored
/// keyring secret went stale.
pub const ERR_UNAUTHORIZED: &str = "unauthorized";
/// Connect failure, timeout, other non-2xx, or an unparseable body.
pub const ERR_NETWORK: &str = "network";
/// The OS credential store itself failed — distinct from "no key stored".
pub const ERR_CREDENTIAL_STORE: &str = "credential-store";
/// Unknown provider id. A programmer error, not a user-facing state.
pub const ERR_UNSUPPORTED: &str = "unsupported";

fn tagged(tag: &str, message: impl AsRef<str>) -> String {
    format!("{}: {}", tag, message.as_ref())
}

// ---------------------------------------------------------------------------
// Wire model
// ---------------------------------------------------------------------------

/// One model a provider says it can serve right now.
///
/// Every field but `id` is optional because no two provider catalogs agree on
/// what they publish. `None` means "the provider did not say", and callers must
/// fall back rather than render a zero.
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LiveModel {
    /// The exact string to send as `model`.
    pub id: String,
    /// Human label, when the provider publishes one distinct from the id.
    pub display_name: Option<String>,
    /// Input context window in tokens.
    pub context_window: Option<u64>,
    /// Maximum output tokens per response.
    pub max_output: Option<u64>,
    /// USD per 1M input tokens.
    #[serde(rename = "inputPerMTok")]
    pub input_per_mtok: Option<f64>,
    /// USD per 1M output tokens.
    #[serde(rename = "outputPerMTok")]
    pub output_per_mtok: Option<f64>,
}

impl LiveModel {
    /// An id-only row — the shape every bare OpenAI-compatible `/models`
    /// endpoint gives us.
    fn id_only(id: impl Into<String>) -> Self {
        LiveModel {
            id: id.into(),
            display_name: None,
            context_window: None,
            max_output: None,
            input_per_mtok: None,
            output_per_mtok: None,
        }
    }
}

// ---------------------------------------------------------------------------
// Provider id normalisation
// ---------------------------------------------------------------------------

/// Map the ids the frontend has on hand — keyring provider names *and*
/// `AgentCli` values — onto the six catalogs we know how to fetch.
///
/// Accepting both spellings matters because the picker rows are keyed by
/// `AgentCli` (`api-claude`, `api-openrouter`, …) while the keyring and
/// `load_api_key` speak the short names (`anthropic`, `openrouter`, …).
///
/// `minimax-api` stays distinct from `minimax` because — exactly as in
/// [`crate::core::llm_provider::get_provider`] — the two hit the same endpoint
/// but read different keyring slots (Token Plan vs pay-as-you-go).
fn canonical_provider(provider: &str) -> Option<&'static str> {
    match provider.trim().to_ascii_lowercase().as_str() {
        "anthropic" | "claude" | "api-claude" | "claude-oauth" | "api-claude-oauth" => {
            Some("anthropic")
        }
        "openai" | "api-openai" | "openai-agents" | "api-openai-agents" => Some("openai"),
        "openrouter" | "api-openrouter" => Some("openrouter"),
        "minimax" | "api-minimax" => Some("minimax"),
        "minimax-api" => Some("minimax-api"),
        "ollama" | "api-ollama" => Some("ollama"),
        "custom" | "api-custom" => Some("custom"),
        "sugar" | "api-sugar" => Some("sugar"),
        "cline-pass" | "api-cline-pass" => Some("cline-pass"),
        "opencode-go" | "api-opencode-go" => Some("opencode-go"),
        "ollama-cloud" | "api-ollama-cloud" => Some("ollama-cloud"),
        "google" | "api-google" => Some("google"),
        "xai" | "api-xai" => Some("xai"),

        _ => None,
    }
}

// ---------------------------------------------------------------------------
// Credential helpers
// ---------------------------------------------------------------------------

/// Load a required key, keeping "none stored" distinct from "credential store
/// broke". `load_api_key` collapses both into `Err(String)`, so we match on the
/// shared prefix it exports rather than re-implementing the keyring walk
/// (which includes the legacy-service migration).
pub(super) fn require_api_key(provider: &str) -> Result<String, String> {
    match crate::commands::api_keys::load_api_key(provider) {
        Ok(key) if key.trim().is_empty() => Err(tagged(
            ERR_NO_KEY,
            format!(
                "{} {}. Set one in Settings > API Keys.",
                crate::commands::api_keys::NO_API_KEY_PREFIX,
                provider
            ),
        )),
        Ok(key) => Ok(key),
        Err(e) if e.starts_with(crate::commands::api_keys::NO_API_KEY_PREFIX) => {
            Err(tagged(ERR_NO_KEY, e))
        }
        Err(e) => Err(tagged(ERR_CREDENTIAL_STORE, e)),
    }
}

/// Load a key if there is one, without ever gating on it. OpenRouter's catalog
/// is anonymous; sending the key only personalises the response.
fn optional_api_key(provider: &str) -> Option<String> {
    match crate::commands::api_keys::load_api_key(provider) {
        Ok(key) if !key.trim().is_empty() => Some(key),
        _ => None,
    }
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

pub(super) fn http_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .timeout(REMOTE_TIMEOUT)
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|e| tagged(ERR_NETWORK, format!("Failed to build HTTP client: {}", e)))
}

/// Send a prepared request and return the body text, classifying failures into
/// the tag vocabulary above. 401/403 is the stale-key signal and is kept
/// distinct from every other non-2xx.
pub(super) async fn fetch_text(
    req: reqwest::RequestBuilder,
    label: &str,
    url: &str,
) -> Result<String, String> {
    let resp = req.send().await.map_err(|e| {
        if e.is_connect() || e.is_timeout() {
            tagged(ERR_NETWORK, format!("{} not reachable at {}", label, url))
        } else {
            tagged(ERR_NETWORK, format!("Failed to reach {}: {}", label, e))
        }
    })?;

    let status = resp.status();
    if status == reqwest::StatusCode::UNAUTHORIZED || status == reqwest::StatusCode::FORBIDDEN {
        return Err(tagged(
            ERR_UNAUTHORIZED,
            format!(
                "{} rejected the stored API key (HTTP {}). Re-enter it in Settings > API Keys.",
                label,
                status.as_u16()
            ),
        ));
    }
    if !status.is_success() {
        return Err(tagged(
            ERR_NETWORK,
            format!("{} returned HTTP {} from {}", label, status.as_u16(), url),
        ));
    }

    resp.text().await.map_err(|e| {
        tagged(
            ERR_NETWORK,
            format!("Failed to read {} response: {}", label, e),
        )
    })
}

/// Build the `/models` URL for an OpenAI-compatible base that may or may not
/// already carry its version prefix.
///
/// MiniMax bases are normalised to always end in `/v1`; `custom` bases are
/// stored verbatim and *usually* but not always do. Blindly appending
/// `/v1/models` produces `…/v1/v1/models`, which is the likeliest failure mode
/// here, so detect an existing version segment first.
fn openai_compat_models_url(base: &str) -> String {
    let trimmed = base.trim_end_matches('/');
    if has_version_segment(trimmed) {
        format!("{}/models", trimmed)
    } else {
        format!("{}/v1/models", trimmed)
    }
}

/// True when the last path segment looks like an API version (`v1`, `v2`,
/// `v1beta`, …) rather than an ordinary path component that happens to start
/// with `v`.
fn has_version_segment(url: &str) -> bool {
    let last = url.rsplit('/').next().unwrap_or_default();
    let mut chars = last.chars();
    matches!(chars.next(), Some('v')) && matches!(chars.next(), Some(c) if c.is_ascii_digit())
}

/// Treat a reported `0` the same as an absent field. Anthropic returns `0` for
/// models whose limits it does not publish, and a literal zero window would
/// render as a broken model rather than an unknown one.
fn positive(value: Option<u64>) -> Option<u64> {
    value.filter(|v| *v > 0)
}

// ---------------------------------------------------------------------------
// Anthropic
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
struct AnthropicModelsPage {
    #[serde(default)]
    data: Vec<AnthropicModelEntry>,
    #[serde(default)]
    has_more: bool,
    #[serde(default)]
    last_id: Option<String>,
}

#[derive(Deserialize)]
struct AnthropicModelEntry {
    id: String,
    #[serde(default)]
    display_name: Option<String>,
    #[serde(default)]
    max_input_tokens: Option<u64>,
    #[serde(default)]
    max_tokens: Option<u64>,
}

/// One page of `GET https://api.anthropic.com/v1/models`. Returns the rows plus
/// the cursor state.
///
/// Pure — no network. `max_input_tokens` / `max_tokens` of `0` or `null` are
/// normalised to `None`.
fn parse_anthropic_page(body: &str) -> Result<(Vec<LiveModel>, bool, Option<String>), String> {
    let page: AnthropicModelsPage = serde_json::from_str(body).map_err(|e| {
        tagged(
            ERR_NETWORK,
            format!("Failed to parse Anthropic /v1/models response: {}", e),
        )
    })?;

    let models = page
        .data
        .into_iter()
        .filter(|e| !e.id.trim().is_empty())
        .map(|entry| LiveModel {
            id: entry.id,
            display_name: entry.display_name.filter(|n| !n.trim().is_empty()),
            context_window: positive(entry.max_input_tokens),
            max_output: positive(entry.max_tokens),
            // Anthropic's models endpoint publishes no pricing.
            input_per_mtok: None,
            output_per_mtok: None,
        })
        .collect();

    Ok((models, page.has_more, page.last_id))
}

async fn list_anthropic_models() -> Result<Vec<LiveModel>, String> {
    // A normal user key, not an admin key — `/v1/models` is readable with the
    // same credential the chat runtime uses.
    let key = require_api_key("anthropic")?;
    let client = http_client()?;
    let url = "https://api.anthropic.com/v1/models";

    let mut all: Vec<LiveModel> = Vec::new();
    let mut after_id: Option<String> = None;

    for _ in 0..MAX_ANTHROPIC_PAGES {
        let mut req = client
            .get(url)
            .header("x-api-key", key.trim())
            .header("anthropic-version", ANTHROPIC_VERSION)
            .query(&[("limit", "1000")]);
        if let Some(cursor) = after_id.as_deref() {
            req = req.query(&[("after_id", cursor)]);
        }

        let body = fetch_text(req, "Anthropic", url).await?;
        let (models, has_more, last_id) = parse_anthropic_page(&body)?;
        all.extend(models);

        match (has_more, last_id) {
            // `has_more` with no cursor would re-request the same page forever.
            (true, Some(cursor)) if !cursor.trim().is_empty() => after_id = Some(cursor),
            _ => return Ok(all),
        }
    }

    warn!(
        pages = MAX_ANTHROPIC_PAGES,
        "Anthropic model listing hit the page cap; returning a partial catalog"
    );
    Ok(all)
}

// ---------------------------------------------------------------------------
// OpenAI-shaped `{object:"list", data:[{id, …}]}`
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
struct OpenAiCompatModelsResponse {
    #[serde(default)]
    data: Vec<OpenAiCompatModelEntry>,
}

#[derive(Deserialize)]
struct OpenAiCompatModelEntry {
    id: String,
}

/// Parse a bare OpenAI-compatible `/models` body into id-only rows, unfiltered.
/// Used for `minimax` and `custom`, where we have no basis to guess which ids
/// are chat models.
fn parse_openai_compat_ids(body: &str, label: &str) -> Result<Vec<LiveModel>, String> {
    let parsed: OpenAiCompatModelsResponse = serde_json::from_str(body).map_err(|e| {
        tagged(
            ERR_NETWORK,
            format!("Failed to parse {} /models response: {}", label, e),
        )
    })?;
    Ok(parsed
        .data
        .into_iter()
        .filter(|e| !e.id.trim().is_empty())
        .map(|e| LiveModel::id_only(e.id))
        .collect())
}

/// Substrings that mark a non-chat OpenAI model. The `/v1/models` payload
/// carries nothing that distinguishes modalities — no `object` subtype, no
/// capability list — so the id is the only signal available.
const OPENAI_NON_CHAT_SUBSTRINGS: &[&str] = &[
    "embedding",   // text-embedding-3-large
    "moderation",  // omni-moderation-latest
    "whisper",     // whisper-1
    "tts",         // tts-1, gpt-4o-mini-tts
    "dall-e",      // dall-e-3
    "sora",        // video generation
    "-image",      // gpt-image-1-mini (suffix form)
    "image-",      // gpt-image-1 (infix form)
    "-audio",      // gpt-4o-audio-preview
    "-realtime",   // gpt-4o-realtime-preview — bidirectional, not this shape
    "-transcribe", // gpt-4o-transcribe
];

/// Prefixes of the legacy `/v1/completions`-only families. Matched as prefixes
/// rather than substrings so `ada` cannot swallow an unrelated future id.
const OPENAI_LEGACY_COMPLETION_PREFIXES: &[&str] = &[
    "ada",
    "babbage",
    "curie",
    "davinci",
    "code-davinci",
    "text-ada",
    "text-babbage",
    "text-curie",
    "text-davinci",
];

/// Heuristic: is this id a chat-completions model?
///
/// Deliberately a *denylist*. An allowlist of known families would silently
/// hide every model OpenAI ships after this code was written, which is the
/// exact failure a live catalog exists to avoid.
fn openai_id_is_chat_model(id: &str) -> bool {
    let lower = id.trim().to_ascii_lowercase();
    if lower.is_empty() {
        return false;
    }
    if OPENAI_NON_CHAT_SUBSTRINGS
        .iter()
        .any(|needle| lower.contains(needle))
    {
        return false;
    }
    if OPENAI_LEGACY_COMPLETION_PREFIXES
        .iter()
        .any(|prefix| lower.starts_with(prefix))
    {
        return false;
    }
    true
}

/// Parse OpenAI's `/v1/models`, dropping non-chat ids.
///
/// Safety net: if the heuristic would empty a non-empty catalog, return the
/// unfiltered list. A naming change that trips every rule should degrade to a
/// noisy picker, never to an empty one.
fn parse_openai_models(body: &str) -> Result<Vec<LiveModel>, String> {
    let all = parse_openai_compat_ids(body, "OpenAI")?;
    let filtered: Vec<LiveModel> = all
        .iter()
        .filter(|m| openai_id_is_chat_model(&m.id))
        .cloned()
        .collect();

    if filtered.is_empty() && !all.is_empty() {
        warn!("OpenAI model filter removed every row; returning the unfiltered catalog");
        return Ok(all);
    }
    Ok(filtered)
}

async fn list_openai_models() -> Result<Vec<LiveModel>, String> {
    let key = require_api_key("openai")?;
    let client = http_client()?;
    let url = "https://api.openai.com/v1/models";
    let body = fetch_text(client.get(url).bearer_auth(key.trim()), "OpenAI", url).await?;
    parse_openai_models(&body)
}

// ---------------------------------------------------------------------------
// OpenRouter
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
struct OpenRouterModelsResponse {
    #[serde(default)]
    data: Vec<OpenRouterModelEntry>,
}

#[derive(Deserialize)]
struct OpenRouterModelEntry {
    id: String,
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    context_length: Option<u64>,
    #[serde(default)]
    pricing: Option<OpenRouterPricing>,
    #[serde(default)]
    top_provider: Option<OpenRouterTopProvider>,
}

#[derive(Deserialize)]
struct OpenRouterPricing {
    #[serde(default)]
    prompt: Option<String>,
    #[serde(default)]
    completion: Option<String>,
}

#[derive(Deserialize)]
struct OpenRouterTopProvider {
    #[serde(default)]
    context_length: Option<u64>,
    #[serde(default)]
    max_completion_tokens: Option<u64>,
}

/// OpenRouter quotes prices as decimal **strings in USD per single token**
/// (`"0.000000834"`). Scale to per-MTok and round to 6dp so the binary→decimal
/// residue (`0.8340000000000001`) never reaches the UI.
///
/// `"0"` is a real free model and stays `Some(0.0)`; negatives (OpenRouter's
/// variable-pricing sentinel, e.g. `openrouter/auto`) become `None`.
fn per_token_string_to_per_mtok(raw: &str) -> Option<f64> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return None;
    }
    let per_token: f64 = trimmed.parse().ok()?;
    if !per_token.is_finite() || per_token < 0.0 {
        return None;
    }
    let per_mtok = per_token * 1_000_000.0;
    Some((per_mtok * 1_000_000.0).round() / 1_000_000.0)
}

/// Pure parse of `GET https://openrouter.ai/api/v1/models`.
///
/// `top_provider.context_length` wins over the top-level `context_length`: the
/// former is what the model will actually be served with.
fn parse_openrouter_models(body: &str) -> Result<Vec<LiveModel>, String> {
    let parsed: OpenRouterModelsResponse = serde_json::from_str(body).map_err(|e| {
        tagged(
            ERR_NETWORK,
            format!("Failed to parse OpenRouter /v1/models response: {}", e),
        )
    })?;

    Ok(parsed
        .data
        .into_iter()
        .filter(|e| !e.id.trim().is_empty())
        .map(|entry| {
            let top = entry.top_provider;
            let context_window = positive(
                top.as_ref()
                    .and_then(|t| t.context_length)
                    .or(entry.context_length),
            );
            let max_output = positive(top.as_ref().and_then(|t| t.max_completion_tokens));
            let (input, output) = match entry.pricing {
                Some(p) => (
                    p.prompt.as_deref().and_then(per_token_string_to_per_mtok),
                    p.completion
                        .as_deref()
                        .and_then(per_token_string_to_per_mtok),
                ),
                None => (None, None),
            };
            LiveModel {
                id: entry.id,
                display_name: entry.name.filter(|n| !n.trim().is_empty()),
                context_window,
                max_output,
                input_per_mtok: input,
                output_per_mtok: output,
            }
        })
        .collect())
}

async fn list_openrouter_models() -> Result<Vec<LiveModel>, String> {
    let client = http_client()?;
    let url = "https://openrouter.ai/api/v1/models";

    // The catalog is public. Send the key only if one happens to be stored —
    // never gate on it, or an unconfigured user sees no models at all.
    let mut req = client.get(url);
    if let Some(key) = optional_api_key("openrouter") {
        req = req.bearer_auth(key.trim().to_string());
    }

    let body = fetch_text(req, "OpenRouter", url).await?;
    parse_openrouter_models(&body)
}

// ---------------------------------------------------------------------------
// MiniMax
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
struct MiniMaxErrorEnvelope {
    #[serde(default, rename = "type")]
    kind: Option<String>,
    #[serde(default)]
    error: Option<MiniMaxErrorBody>,
}

#[derive(Deserialize)]
struct MiniMaxErrorBody {
    #[serde(default)]
    message: Option<String>,
    #[serde(default)]
    http_code: Option<serde_json::Value>,
    #[serde(default, rename = "type")]
    kind: Option<String>,
}

/// `http_code` arrives as the string `"401"` on the observed responses, but the
/// docs are inconsistent about it, so accept a number too.
fn minimax_http_code(value: Option<&serde_json::Value>) -> Option<u16> {
    match value? {
        serde_json::Value::String(s) => s.trim().parse().ok(),
        serde_json::Value::Number(n) => n.as_u64().and_then(|v| u16::try_from(v).ok()),
        _ => None,
    }
}

/// Parse MiniMax's `/v1/models`.
///
/// MiniMax's error envelope is **not** OpenAI's — it is
/// `{"type":"error","error":{"type":"authorized_error","message":"…","http_code":"401"}}`
/// and can arrive on an HTTP 200, which is why a shared OpenAI-compat error
/// parser never recognises it. Detect it here so a stale key reports as
/// [`ERR_UNAUTHORIZED`] instead of a confusing empty catalog.
fn parse_minimax_models(body: &str) -> Result<Vec<LiveModel>, String> {
    if let Ok(envelope) = serde_json::from_str::<MiniMaxErrorEnvelope>(body) {
        if envelope.kind.as_deref() == Some("error") {
            if let Some(err) = envelope.error {
                let code = minimax_http_code(err.http_code.as_ref());
                let detail = err
                    .message
                    .filter(|m| !m.trim().is_empty())
                    .or_else(|| err.kind.clone())
                    .unwrap_or_else(|| "no detail given".to_string());
                let is_auth = matches!(code, Some(401) | Some(403))
                    || err.kind.as_deref() == Some("authorized_error");
                return Err(if is_auth {
                    tagged(
                        ERR_UNAUTHORIZED,
                        format!(
                            "MiniMax rejected the stored API key: {}. Re-enter it in Settings > API Keys.",
                            detail
                        ),
                    )
                } else {
                    tagged(
                        ERR_NETWORK,
                        format!("MiniMax returned an error: {}", detail),
                    )
                });
            }
        }
    }

    parse_openai_compat_ids(body, "MiniMax")
}

/// The catalog is identical for both MiniMax keyring slots, so a credential in
/// either one is enough to read it. Try the slot the caller named first, then
/// the other; report the *named* slot's error when neither holds a key.
fn require_minimax_api_key(preferred: &str) -> Result<String, String> {
    let fallback = if preferred == "minimax" {
        "minimax-api"
    } else {
        "minimax"
    };
    match require_api_key(preferred) {
        Ok(key) => Ok(key),
        Err(e) if e.starts_with(ERR_NO_KEY) => require_api_key(fallback).map_err(|_| e),
        Err(e) => Err(e),
    }
}

async fn list_minimax_models(key_provider: &str) -> Result<Vec<LiveModel>, String> {
    let key = require_minimax_api_key(key_provider)?;
    let client = http_client()?;
    // `resolve_minimax_base_url` normalises to a base ending in `/v1` (global
    // `api.minimax.io`, mainland `api.minimaxi.com`, or an override).
    let base = crate::core::storage::resolve_minimax_base_url();
    let url = openai_compat_models_url(&base);
    let body = fetch_text(client.get(&url).bearer_auth(key.trim()), "MiniMax", &url).await?;
    parse_minimax_models(&body)
}

// ---------------------------------------------------------------------------
// Ollama
// ---------------------------------------------------------------------------

/// Project the existing `/api/tags` rows onto the shared contract.
///
/// Pure so the projection is testable without a daemon. `list_ollama_models`
/// keeps its own shape and its own callers — this only re-reads its output.
fn live_models_from_ollama(models: Vec<crate::commands::ollama::OllamaModel>) -> Vec<LiveModel> {
    models
        .into_iter()
        .map(|m| LiveModel {
            id: m.name,
            display_name: None,
            // Newer daemons report `details.context_length` inline; older ones
            // report nothing and `list_ollama_models` back-fills from
            // `/api/show` where it can. Either way absence stays `None`.
            context_window: m.context_length.map(u64::from).filter(|v| *v > 0),
            max_output: None,
            // Local inference has no per-token price.
            input_per_mtok: None,
            output_per_mtok: None,
        })
        .collect()
}

async fn list_ollama_live_models() -> Result<Vec<LiveModel>, String> {
    // Reuse the existing command wholesale: it already owns base-URL
    // resolution, the inline capabilities read, and the `/api/show` fallback
    // for daemons too old to report `details.context_length`.
    let models = crate::commands::ollama::list_ollama_models()
        .await
        .map_err(|e| tagged(ERR_NETWORK, e))?;
    Ok(live_models_from_ollama(models))
}

// ---------------------------------------------------------------------------
// Custom OpenAI-compatible endpoint
// ---------------------------------------------------------------------------

async fn list_custom_models() -> Result<Vec<LiveModel>, String> {
    let base = crate::core::storage::resolve_custom_compat_base_url().ok_or_else(|| {
        tagged(
            ERR_NOT_CONFIGURED,
            format!(
                "No custom OpenAI-compatible endpoint is configured. {}.",
                crate::core::llm_custom_compat::CUSTOM_ENDPOINT_UNSET_HINT
            ),
        )
    })?;

    let client = http_client()?;
    let url = openai_compat_models_url(&base);

    // The key is optional here exactly as it is for chat: many local servers
    // require none, and `load_api_key("custom")` returns an empty string.
    let mut req = client.get(&url);
    if let Some(key) = optional_api_key("custom") {
        req = req.bearer_auth(key.trim().to_string());
    }

    let body = fetch_text(req, "Custom endpoint", &url).await?;
    parse_openai_compat_ids(&body, "Custom endpoint")
}

// ---------------------------------------------------------------------------
// Command
// ---------------------------------------------------------------------------

/// Enumerate the models a provider will serve right now.
///
/// Accepts either the keyring provider name (`anthropic`, `openai`, …) or the
/// `AgentCli` id (`api-claude`, `api-openrouter`, …).
#[tauri::command]
pub async fn list_provider_models(provider: String) -> Result<Vec<LiveModel>, String> {
    let canonical = canonical_provider(&provider).ok_or_else(|| {
        tagged(
            ERR_UNSUPPORTED,
            format!("Live model discovery is not supported for '{}'.", provider),
        )
    })?;

    let models = match canonical {
        "anthropic" => list_anthropic_models().await,
        "openai" => list_openai_models().await,
        "openrouter" => list_openrouter_models().await,
        slot @ ("minimax" | "minimax-api") => list_minimax_models(slot).await,
        "ollama" => list_ollama_live_models().await,
        "custom" => list_custom_models().await,
        name if crate::core::provider_endpoints::NAMED_PROVIDERS.contains(&name) => {
            super::named_provider_models::list_models(name).await
        }
        other => Err(tagged(
            ERR_UNSUPPORTED,
            format!("Live model discovery is not supported for '{}'.", other),
        )),
    }?;

    info!(
        provider = %canonical,
        count = models.len(),
        "Listed live provider models"
    );
    Ok(models)
}

// ---------------------------------------------------------------------------
// Tests — all pure, all against inline fixtures, no network.
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    /// Shape of a real `GET https://api.anthropic.com/v1/models` page, with the
    /// zero/null limit cases the endpoint actually emits.
    const ANTHROPIC_PAGE: &str = r#"{
        "data": [
            {
                "type": "model",
                "id": "claude-opus-4-1-20250805",
                "display_name": "Claude Opus 4.1",
                "created_at": "2025-08-05T00:00:00Z",
                "max_input_tokens": 200000,
                "max_tokens": 32000
            },
            {
                "type": "model",
                "id": "claude-3-haiku-20240307",
                "display_name": "Claude Haiku 3",
                "created_at": "2024-03-07T00:00:00Z",
                "max_input_tokens": 0,
                "max_tokens": null
            }
        ],
        "has_more": true,
        "first_id": "claude-opus-4-1-20250805",
        "last_id": "claude-3-haiku-20240307"
    }"#;

    #[test]
    fn anthropic_page_carries_window_output_and_cursor() {
        let (models, has_more, last_id) = parse_anthropic_page(ANTHROPIC_PAGE).unwrap();
        assert_eq!(models.len(), 2);
        assert_eq!(models[0].id, "claude-opus-4-1-20250805");
        assert_eq!(models[0].display_name.as_deref(), Some("Claude Opus 4.1"));
        assert_eq!(models[0].context_window, Some(200_000));
        assert_eq!(models[0].max_output, Some(32_000));
        // Anthropic publishes no pricing on this endpoint.
        assert_eq!(models[0].input_per_mtok, None);
        assert_eq!(models[0].output_per_mtok, None);

        assert!(has_more);
        assert_eq!(last_id.as_deref(), Some("claude-3-haiku-20240307"));
    }

    #[test]
    fn anthropic_zero_and_null_limits_are_unknown_not_zero() {
        let (models, _, _) = parse_anthropic_page(ANTHROPIC_PAGE).unwrap();
        assert_eq!(models[1].context_window, None, "0 must not survive as 0");
        assert_eq!(models[1].max_output, None);
    }

    #[test]
    fn anthropic_last_page_reports_no_cursor() {
        let body =
            r#"{"data":[{"id":"claude-x","display_name":"X"}],"has_more":false,"last_id":null}"#;
        let (models, has_more, last_id) = parse_anthropic_page(body).unwrap();
        assert_eq!(models.len(), 1);
        // Absent limit fields are unknown, not zero.
        assert_eq!(models[0].context_window, None);
        assert!(!has_more);
        assert!(last_id.is_none());
    }

    #[test]
    fn anthropic_garbage_body_is_a_network_class_error() {
        let err = parse_anthropic_page("<html>502 Bad Gateway</html>").unwrap_err();
        assert!(err.starts_with(ERR_NETWORK), "got {}", err);
    }

    /// Shape of `GET https://api.openai.com/v1/models` — deliberately noisy,
    /// since the payload carries nothing to separate the modalities.
    const OPENAI_LIST: &str = r#"{
        "object": "list",
        "data": [
            { "id": "gpt-5", "object": "model", "created": 1754000000, "owned_by": "system" },
            { "id": "gpt-4o", "object": "model", "created": 1715367049, "owned_by": "system" },
            { "id": "o3-mini", "object": "model", "created": 1737146383, "owned_by": "system" },
            { "id": "chatgpt-4o-latest", "object": "model", "created": 1723515131, "owned_by": "system" },
            { "id": "text-embedding-3-large", "object": "model", "created": 1705953180, "owned_by": "system" },
            { "id": "whisper-1", "object": "model", "created": 1677532384, "owned_by": "openai-internal" },
            { "id": "tts-1", "object": "model", "created": 1681940951, "owned_by": "openai-internal" },
            { "id": "gpt-4o-mini-tts", "object": "model", "created": 1742403959, "owned_by": "system" },
            { "id": "omni-moderation-latest", "object": "model", "created": 1731689265, "owned_by": "system" },
            { "id": "dall-e-3", "object": "model", "created": 1698785189, "owned_by": "system" },
            { "id": "gpt-image-1", "object": "model", "created": 1745517030, "owned_by": "system" },
            { "id": "gpt-4o-audio-preview", "object": "model", "created": 1727460443, "owned_by": "system" },
            { "id": "gpt-4o-realtime-preview", "object": "model", "created": 1727659998, "owned_by": "system" },
            { "id": "gpt-4o-transcribe", "object": "model", "created": 1742068463, "owned_by": "system" },
            { "id": "davinci-002", "object": "model", "created": 1692634301, "owned_by": "system" },
            { "id": "babbage-002", "object": "model", "created": 1692634615, "owned_by": "system" }
        ]
    }"#;

    #[test]
    fn openai_filter_keeps_chat_models_and_drops_the_rest() {
        let models = parse_openai_models(OPENAI_LIST).unwrap();
        let ids: Vec<&str> = models.iter().map(|m| m.id.as_str()).collect();
        assert_eq!(ids, vec!["gpt-5", "gpt-4o", "o3-mini", "chatgpt-4o-latest"]);
    }

    #[test]
    fn openai_rows_are_id_only() {
        let models = parse_openai_models(OPENAI_LIST).unwrap();
        assert_eq!(models[0].display_name, None);
        assert_eq!(models[0].context_window, None);
        assert_eq!(models[0].max_output, None);
        assert_eq!(models[0].input_per_mtok, None);
        assert_eq!(models[0].output_per_mtok, None);
    }

    #[test]
    fn openai_filter_covers_each_documented_family() {
        for id in [
            "text-embedding-3-small",
            "omni-moderation-2024-09-26",
            "whisper-1",
            "tts-1-hd",
            "gpt-4o-mini-tts",
            "dall-e-2",
            "gpt-image-1-mini",
            "gpt-4o-audio-preview-2024-12-17",
            "gpt-4o-realtime-preview",
            "gpt-4o-mini-transcribe",
            "sora-2",
            "davinci-002",
            "babbage-002",
            "text-davinci-003",
            "ada",
            "curie",
        ] {
            assert!(!openai_id_is_chat_model(id), "{} should be filtered", id);
        }

        for id in [
            "gpt-5",
            "gpt-5-mini",
            "gpt-4.1",
            "gpt-4o",
            "gpt-4o-mini",
            "o1",
            "o3",
            "o4-mini",
            "chatgpt-4o-latest",
            "codex-mini-latest",
            "computer-use-preview",
            "gpt-4o-search-preview",
        ] {
            assert!(openai_id_is_chat_model(id), "{} should be kept", id);
        }
    }

    #[test]
    fn openai_filter_falls_back_rather_than_returning_nothing() {
        // Every id trips a rule; an empty picker is worse than a noisy one.
        let body = r#"{"object":"list","data":[{"id":"whisper-1"},{"id":"tts-1"}]}"#;
        let models = parse_openai_models(body).unwrap();
        assert_eq!(models.len(), 2);
    }

    #[test]
    fn openai_empty_catalog_stays_empty() {
        let models = parse_openai_models(r#"{"object":"list","data":[]}"#).unwrap();
        assert!(models.is_empty());
    }

    /// Shape of `GET https://openrouter.ai/api/v1/models`, including the
    /// per-token *string* pricing, a free row, and the variable-pricing router.
    const OPENROUTER_LIST: &str = r#"{
        "data": [
            {
                "id": "anthropic/claude-sonnet-4.5",
                "name": "Anthropic: Claude Sonnet 4.5",
                "context_length": 1000000,
                "pricing": {
                    "prompt": "0.000003",
                    "completion": "0.000015",
                    "image": "0.0048",
                    "request": "0"
                },
                "top_provider": {
                    "context_length": 200000,
                    "max_completion_tokens": 64000,
                    "is_moderated": true
                }
            },
            {
                "id": "meta-llama/llama-3.3-70b-instruct:free",
                "name": "Meta: Llama 3.3 70B Instruct (free)",
                "context_length": 65536,
                "pricing": { "prompt": "0", "completion": "0" },
                "top_provider": { "context_length": null, "max_completion_tokens": null }
            },
            {
                "id": "openrouter/auto",
                "name": "Auto Router",
                "context_length": 2000000,
                "pricing": { "prompt": "-1", "completion": "-1" }
            },
            {
                "id": "some/odd-model",
                "name": "Odd",
                "context_length": 8192
            }
        ],
        "total_count": 4
    }"#;

    #[test]
    fn openrouter_pricing_strings_become_usd_per_mtok() {
        let models = parse_openrouter_models(OPENROUTER_LIST).unwrap();
        assert_eq!(models[0].id, "anthropic/claude-sonnet-4.5");
        assert_eq!(
            models[0].display_name.as_deref(),
            Some("Anthropic: Claude Sonnet 4.5")
        );
        assert_eq!(models[0].input_per_mtok, Some(3.0));
        assert_eq!(models[0].output_per_mtok, Some(15.0));
    }

    #[test]
    fn openrouter_prefers_top_provider_limits() {
        let models = parse_openrouter_models(OPENROUTER_LIST).unwrap();
        // 200000 (top_provider) wins over 1000000 (top-level).
        assert_eq!(models[0].context_window, Some(200_000));
        assert_eq!(models[0].max_output, Some(64_000));
        // Nulls fall back to the top-level window and leave max_output unknown.
        assert_eq!(models[1].context_window, Some(65_536));
        assert_eq!(models[1].max_output, None);
    }

    #[test]
    fn openrouter_free_is_zero_and_variable_is_unknown() {
        let models = parse_openrouter_models(OPENROUTER_LIST).unwrap();
        assert_eq!(models[1].input_per_mtok, Some(0.0), "free is a real price");
        assert_eq!(models[2].input_per_mtok, None, "-1 means variable");
        assert_eq!(models[3].input_per_mtok, None, "absent pricing block");
        assert_eq!(models[3].context_window, Some(8192));
    }

    #[test]
    fn tiny_per_token_prices_survive_the_scale_without_float_noise() {
        // The literal value from the OpenRouter payload.
        assert_eq!(per_token_string_to_per_mtok("0.000000834"), Some(0.834));
        assert_eq!(per_token_string_to_per_mtok("0.00000015"), Some(0.15));
        assert_eq!(per_token_string_to_per_mtok("0.0000012"), Some(1.2));
        assert_eq!(per_token_string_to_per_mtok("0"), Some(0.0));
        assert_eq!(per_token_string_to_per_mtok("-1"), None);
        assert_eq!(per_token_string_to_per_mtok(""), None);
        assert_eq!(per_token_string_to_per_mtok("free"), None);
    }

    #[test]
    fn minimax_success_body_is_id_only() {
        let body = r#"{"object":"list","data":[
            {"id":"MiniMax-M2","object":"model"},
            {"id":"MiniMax-Text-01","object":"model"}
        ]}"#;
        let models = parse_minimax_models(body).unwrap();
        assert_eq!(models.len(), 2);
        assert_eq!(models[0].id, "MiniMax-M2");
        assert_eq!(models[0].context_window, None);
    }

    #[test]
    fn minimax_non_openai_error_envelope_reads_as_unauthorized() {
        // MiniMax can serve this on an HTTP 200, which is why a shared
        // OpenAI-compat error parser never recognises it.
        let body = r#"{"type":"error","error":{"type":"authorized_error","message":"invalid api key","http_code":"401"}}"#;
        let err = parse_minimax_models(body).unwrap_err();
        assert!(err.starts_with(ERR_UNAUTHORIZED), "got {}", err);
        assert!(err.contains("invalid api key"));
    }

    #[test]
    fn minimax_non_auth_error_envelope_reads_as_network() {
        let body = r#"{"type":"error","error":{"type":"rate_limit_error","message":"slow down","http_code":429}}"#;
        let err = parse_minimax_models(body).unwrap_err();
        assert!(err.starts_with(ERR_NETWORK), "got {}", err);
        assert!(err.contains("slow down"));
    }

    #[test]
    fn minimax_http_code_accepts_string_or_number() {
        assert_eq!(
            minimax_http_code(Some(&serde_json::json!("401"))),
            Some(401)
        );
        assert_eq!(minimax_http_code(Some(&serde_json::json!(429))), Some(429));
        assert_eq!(minimax_http_code(Some(&serde_json::json!(null))), None);
        assert_eq!(minimax_http_code(None), None);
    }

    #[test]
    fn ollama_projection_carries_the_context_window_through() {
        let models = live_models_from_ollama(vec![
            crate::commands::ollama::OllamaModel {
                name: "qwen2.5-coder:7b".to_string(),
                size: Some(1),
                modified_at: None,
                supports_tools: Some(true),
                context_length: Some(32768),
            },
            crate::commands::ollama::OllamaModel {
                name: "llama3:8b".to_string(),
                size: None,
                modified_at: None,
                supports_tools: None,
                context_length: None,
            },
        ]);
        assert_eq!(models[0].id, "qwen2.5-coder:7b");
        assert_eq!(models[0].context_window, Some(32768));
        assert_eq!(models[1].context_window, None, "old daemons say nothing");
        // Local models report no output cap and cost nothing per token.
        assert_eq!(models[0].max_output, None);
        assert_eq!(models[0].input_per_mtok, None);
    }

    #[test]
    fn compat_base_urls_never_double_the_version_segment() {
        assert_eq!(
            openai_compat_models_url("https://api.minimax.io/v1"),
            "https://api.minimax.io/v1/models"
        );
        assert_eq!(
            openai_compat_models_url("http://localhost:8000/v1/"),
            "http://localhost:8000/v1/models"
        );
        assert_eq!(
            openai_compat_models_url("http://localhost:1234"),
            "http://localhost:1234/v1/models"
        );
        assert_eq!(
            openai_compat_models_url("https://gateway.example.com/openai"),
            "https://gateway.example.com/openai/v1/models"
        );
        assert_eq!(
            openai_compat_models_url("https://gateway.example.com/v2"),
            "https://gateway.example.com/v2/models"
        );
    }

    #[test]
    fn version_segment_detection_is_not_fooled_by_names_starting_with_v() {
        assert!(has_version_segment("http://x/v1"));
        assert!(has_version_segment("http://x/v2beta"));
        assert!(!has_version_segment("http://x/vertex"));
        assert!(!has_version_segment("http://x/api"));
    }

    #[test]
    fn provider_aliases_cover_keyring_names_and_agent_cli_ids() {
        assert_eq!(canonical_provider("anthropic"), Some("anthropic"));
        assert_eq!(canonical_provider("api-claude"), Some("anthropic"));
        assert_eq!(canonical_provider("api-claude-oauth"), Some("anthropic"));
        assert_eq!(canonical_provider("api-openai-agents"), Some("openai"));
        assert_eq!(canonical_provider("api-minimax"), Some("minimax"));
        // Distinct keyring slot, same endpoint — must not collapse into
        // `minimax` or the Token Plan credential becomes unreachable.
        assert_eq!(canonical_provider("minimax-api"), Some("minimax-api"));
        assert_eq!(canonical_provider(" API-OpenRouter "), Some("openrouter"));
        assert_eq!(canonical_provider("api-custom"), Some("custom"));
        assert_eq!(canonical_provider(""), None);
    }

    #[test]
    fn error_tags_are_distinct_and_prefix_parseable() {
        let tags = [
            ERR_NO_KEY,
            ERR_NOT_CONFIGURED,
            ERR_UNAUTHORIZED,
            ERR_NETWORK,
            ERR_CREDENTIAL_STORE,
            ERR_UNSUPPORTED,
        ];
        for (i, a) in tags.iter().enumerate() {
            for b in tags.iter().skip(i + 1) {
                assert_ne!(a, b);
            }
        }
        let message = tagged(ERR_NO_KEY, "nothing stored");
        assert_eq!(message, "no-key: nothing stored");
        assert_eq!(message.split_once(": ").unwrap().0, ERR_NO_KEY);
    }

    #[test]
    fn wire_shape_matches_the_frontend_contract() {
        let model = LiveModel {
            id: "claude-opus-4-1".to_string(),
            display_name: Some("Claude Opus 4.1".to_string()),
            context_window: Some(200_000),
            max_output: Some(32_000),
            input_per_mtok: Some(15.0),
            output_per_mtok: Some(75.0),
        };
        let json = serde_json::to_value(&model).unwrap();
        assert_eq!(json["id"], serde_json::json!("claude-opus-4-1"));
        assert_eq!(json["displayName"], serde_json::json!("Claude Opus 4.1"));
        assert_eq!(json["contextWindow"], serde_json::json!(200_000));
        assert_eq!(json["maxOutput"], serde_json::json!(32_000));
        // Capital T — `rename_all = "camelCase"` alone would emit `inputPerMtok`.
        assert_eq!(json["inputPerMTok"], serde_json::json!(15.0));
        assert_eq!(json["outputPerMTok"], serde_json::json!(75.0));

        let bare = serde_json::to_value(LiveModel::id_only("gpt-5")).unwrap();
        assert!(bare["displayName"].is_null());
        assert!(bare["contextWindow"].is_null());
    }
}
