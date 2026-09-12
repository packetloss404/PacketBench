//! Auxiliary LLM seam — the single entry point every non-agentic product
//! feature uses to reach a model.
//!
//! ## Why this exists (WI-1 of `dev/oauth-removal-plan.md`)
//!
//! Four shipped features used to call `SidecarManager::forward_start` with the
//! hardcoded `"claude-oauth"` provider: spec import, the two Code Quality AI
//! actions, and the two GitHub PR AI actions. That routed the user's Claude
//! **subscription** OAuth credentials through the Claude Agent SDK for work the
//! user never picked a provider for — the exact configuration Anthropic's
//! Claude Code terms describe as not permitted for third-party developers.
//! Those call sites bypassed `is_sidecar_provider` entirely, so removing the
//! `api-claude-oauth` picker row would have left 100% of that routing intact.
//!
//! Everything here routes through the in-process [`LlmProvider`] trait against
//! an OS-keyring `api-key-*` credential. **No path in this module can reach a
//! subscription-OAuth provider.** `claude-oauth` / `openai-codex` are not
//! members of [`AUX_PROVIDERS`], so they cannot be produced by resolution nor
//! accepted as an override.
//!
//! ## What it does
//!
//! * [`AuxTaskClass`] enumerates the auxiliary surfaces.
//! * [`resolve_aux_route`] maps a task class to a `(provider, model)` pair,
//!   honouring the user's routing settings (Settings → AI Provider Routing →
//!   "Auxiliary AI tasks") and otherwise auto-selecting the **cheapest
//!   configured** provider.
//! * [`run_aux_oneshot`] and [`spawn_aux_stream`] execute the turn. The
//!   streaming variant emits the canonical `api-agent:chunk|done|error:<sid>`
//!   events, so the existing frontend listeners did not have to change when
//!   their backend moved off the sidecar.
//!
//! ## "Cheapest configured"
//!
//! Ranking is derived from the shared rate table (`shared/model-pricing.json`
//! via [`crate::commands::pricing`]), never from a hardcoded provider order.
//! Each candidate's default auxiliary model is priced against a representative
//! auxiliary workload ([`RANK_INPUT_TOKENS`] / [`RANK_OUTPUT_TOKENS`] — these
//! features ship a large diff / log / spec and get back short prose) and the
//! lowest total wins. Models the table doesn't know rank last rather than
//! ranking as free.
//!
//! "Configured" means an OS-keyring `api-key-<provider>` credential exists.
//! Ollama has no credential, so it is never auto-selected — a stopped daemon
//! would otherwise silently win every ranking at $0. It stays explicitly
//! selectable in the routing settings.
//!
//! ## Failing honestly
//!
//! With no configured provider, resolution returns an error naming the feature
//! and pointing at Settings → API Keys. It never falls back to a subscription
//! credential and never silently no-ops.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};
use tauri::Emitter;
use tokio::sync::mpsc;
use tracing::{info, warn};

use crate::commands::api_keys;
use crate::commands::pricing;
use crate::core::llm_provider::get_provider;
use crate::core::llm_types::{ChatMessage, ChatRole, LlmRequest, MessageContent, StreamChunk};

// ---------------------------------------------------------------------------
// Task classes
// ---------------------------------------------------------------------------

/// One auxiliary (non-agentic) LLM surface.
///
/// These are short, single-shot, structured-output tasks: parse a spec,
/// explain a lint error, write PR prose. They do not need a frontier model and
/// they are not part of the agentic coding loop, which keeps its own
/// user-selected provider.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum AuxTaskClass {
    /// Spec / PRD → issue drafts (`issues_extract_from_spec`).
    SpecImport,
    /// Code Quality "explain this diagnostic".
    CodeQualityExplain,
    /// Code Quality "summarize this run".
    CodeQualitySummarize,
    /// GitHub AI PR description.
    PrDescription,
    /// GitHub AI pre-flight PR review.
    PrReview,
    // --- LM4 (3C-1) — classes for the surfaces migrating off run_claude. ---
    /// Memory: codebase key-file scan (`scan_codebase_memory`).
    MemoryScan,
    /// Memory: session log → summary (`summarize_session`).
    SessionSummarize,
    /// Memory: session summaries → recurring patterns (`extract_patterns`).
    PatternExtract,
    /// Flight retrospective (`summarize_flight`).
    FlightRetrospective,
    /// Spec text → structured flight plan (`parse_spec_to_flight`).
    SpecToFlight,
    /// Spec text → ticket array (`parse_spec_to_tickets`).
    SpecToTickets,
    /// GitHub issue investigation (`github_investigate_issue`).
    IssueInvestigate,
    /// Insights agent chat (`ask_agent_chat_stream`).
    AgentChat,
    /// The floating side-chat overlay (`ask_side_chat_stream`).
    SideChat,
    /// GitHub "catch me up" digest (`github_ai_catch_up`).
    /// (Explicit rename: kebab-case would split the camel hump into
    /// `git-hub-catch-up`.)
    #[serde(rename = "github-catch-up")]
    GitHubCatchUp,
    /// GitHub AI issue triage (`github_ai_triage`).
    #[serde(rename = "github-triage")]
    GitHubTriage,
}

impl AuxTaskClass {
    /// Every task class, in the order the settings card lists them.
    pub const ALL: &'static [AuxTaskClass] = &[
        AuxTaskClass::SpecImport,
        AuxTaskClass::SpecToFlight,
        AuxTaskClass::SpecToTickets,
        AuxTaskClass::CodeQualityExplain,
        AuxTaskClass::CodeQualitySummarize,
        AuxTaskClass::PrDescription,
        AuxTaskClass::PrReview,
        AuxTaskClass::GitHubCatchUp,
        AuxTaskClass::GitHubTriage,
        AuxTaskClass::IssueInvestigate,
        AuxTaskClass::MemoryScan,
        AuxTaskClass::SessionSummarize,
        AuxTaskClass::PatternExtract,
        AuxTaskClass::FlightRetrospective,
        AuxTaskClass::AgentChat,
        AuxTaskClass::SideChat,
    ];

    /// Stable wire id, shared with the TypeScript `AuxTaskClass` union.
    pub fn id(self) -> &'static str {
        match self {
            AuxTaskClass::SpecImport => "spec-import",
            AuxTaskClass::CodeQualityExplain => "code-quality-explain",
            AuxTaskClass::CodeQualitySummarize => "code-quality-summarize",
            AuxTaskClass::PrDescription => "pr-description",
            AuxTaskClass::PrReview => "pr-review",
            AuxTaskClass::MemoryScan => "memory-scan",
            AuxTaskClass::SessionSummarize => "session-summarize",
            AuxTaskClass::PatternExtract => "pattern-extract",
            AuxTaskClass::FlightRetrospective => "flight-retrospective",
            AuxTaskClass::SpecToFlight => "spec-to-flight",
            AuxTaskClass::SpecToTickets => "spec-to-tickets",
            AuxTaskClass::IssueInvestigate => "issue-investigate",
            AuxTaskClass::AgentChat => "agent-chat",
            AuxTaskClass::SideChat => "side-chat",
            AuxTaskClass::GitHubCatchUp => "github-catch-up",
            AuxTaskClass::GitHubTriage => "github-triage",
        }
    }

    /// Human label used in user-facing error text.
    pub fn label(self) -> &'static str {
        match self {
            AuxTaskClass::SpecImport => "Spec import",
            AuxTaskClass::CodeQualityExplain => "Code Quality explain",
            AuxTaskClass::CodeQualitySummarize => "Code Quality summary",
            AuxTaskClass::PrDescription => "AI PR description",
            AuxTaskClass::PrReview => "AI PR review",
            AuxTaskClass::MemoryScan => "Codebase memory scan",
            AuxTaskClass::SessionSummarize => "Session summary",
            AuxTaskClass::PatternExtract => "Pattern extraction",
            AuxTaskClass::FlightRetrospective => "Flight retrospective",
            AuxTaskClass::SpecToFlight => "Spec → flight plan",
            AuxTaskClass::SpecToTickets => "Spec → tickets",
            AuxTaskClass::IssueInvestigate => "Issue investigation",
            AuxTaskClass::AgentChat => "Agent chat",
            AuxTaskClass::SideChat => "Side chat",
            AuxTaskClass::GitHubCatchUp => "GitHub catch-up digest",
            AuxTaskClass::GitHubTriage => "GitHub issue triage",
        }
    }

    pub fn from_id(id: &str) -> Option<AuxTaskClass> {
        AuxTaskClass::ALL.iter().copied().find(|t| t.id() == id)
    }
}

// ---------------------------------------------------------------------------
// Candidate providers
// ---------------------------------------------------------------------------

/// One provider eligible to serve auxiliary tasks.
///
/// Membership of this table is the compliance boundary: it holds only
/// in-process [`crate::core::llm_provider::LlmProvider`] ids that authenticate
/// from a keyring `api-key-*` slot. The subscription-OAuth sidecar providers
/// (`claude-oauth`, `openai-codex`) are deliberately absent and must stay that
/// way.
#[derive(Debug, Clone, Copy)]
pub struct AuxProviderCandidate {
    /// `get_provider` / `api-key-<provider>` id.
    pub provider: &'static str,
    /// Cheap-tier model used when the user has not pinned one. Also the model
    /// priced when ranking this candidate.
    pub default_model: &'static str,
    /// False only for Ollama, which authenticates with nothing. Candidates
    /// with `needs_api_key == false` are excluded from automatic selection.
    pub needs_api_key: bool,
}

/// Auxiliary provider candidates. Order here is only the tie-break for equal
/// cost — the real ordering comes from the shared pricing table.
pub const AUX_PROVIDERS: &[AuxProviderCandidate] = &[
    AuxProviderCandidate {
        provider: "anthropic",
        default_model: "claude-haiku-4-5",
        needs_api_key: true,
    },
    AuxProviderCandidate {
        provider: "openai",
        default_model: "o4-mini",
        needs_api_key: true,
    },
    AuxProviderCandidate {
        provider: "minimax",
        default_model: "MiniMax-M2",
        needs_api_key: true,
    },
    AuxProviderCandidate {
        provider: "openrouter",
        // The `anthropic/` route prefix is stripped when matching the shared
        // rate table, so this prices as claude-haiku-4-5.
        default_model: "anthropic/claude-haiku-4-5",
        needs_api_key: true,
    },
    AuxProviderCandidate {
        provider: "ollama",
        default_model: "qwen3:32b",
        needs_api_key: false,
    },
];

pub fn aux_candidate(provider: &str) -> Option<&'static AuxProviderCandidate> {
    AUX_PROVIDERS.iter().find(|c| c.provider == provider)
}

/// Q2 — the cheap-tier model for a provider, for AGENTIC helpers (sub-agent /
/// custom-agent tools) that derive their model from the PARENT session's
/// provider rather than from aux routing (they are excluded from aux routing
/// on purpose: they carry tools and run inside the parent's loop).
///
/// * Keyed cloud providers map to their [`AUX_PROVIDERS`] cheap default
///   (anthropic → haiku, openai → o4-mini, …).
/// * `ollama` (and `custom`) return the parent's own model: a local install
///   has no knowable "cheap tier", and the parent's model is the one proven
///   loaded.
/// * Unknown providers also fall back to the parent model rather than
///   guessing a vendor.
pub fn cheap_tier_model(provider: &str, parent_model: &str) -> String {
    match provider {
        "ollama" | "custom" => parent_model.to_string(),
        "minimax-api" => "MiniMax-M2".to_string(),
        "openai-agents" => "o4-mini".to_string(),
        other => match aux_candidate(other) {
            Some(candidate) => candidate.default_model.to_string(),
            None => parent_model.to_string(),
        },
    }
}

/// Representative auxiliary workload used to rank candidates: a big diff / log
/// / spec in, short prose out.
const RANK_INPUT_TOKENS: u64 = 20_000;
const RANK_OUTPUT_TOKENS: u64 = 1_500;

/// USD cost of the representative workload on `model`, or `None` when the
/// shared table has no entry (such models rank last, never free).
pub fn aux_rank_cost(model: &str) -> Option<f64> {
    pricing::pricing_for(model)?;
    Some(pricing::calculate_cost(
        model,
        RANK_INPUT_TOKENS,
        RANK_OUTPUT_TOKENS,
        0,
        0,
    ))
}

// ---------------------------------------------------------------------------
// Routing overrides + resolution
// ---------------------------------------------------------------------------

/// A user-pinned route for one task class, mirrored from the frontend routing
/// settings. `provider: None` means "Auto (cheapest configured)".
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuxRouteOverride {
    #[serde(default)]
    pub provider: Option<String>,
    #[serde(default)]
    pub model: Option<String>,
}

pub type AuxOverrides = HashMap<AuxTaskClass, AuxRouteOverride>;

/// A resolved auxiliary route.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AuxRoute {
    pub provider: String,
    pub model: String,
    /// True when the route came from an explicit routing-settings pin rather
    /// than automatic cheapest-configured selection.
    pub explicit: bool,
}

fn trimmed(value: &Option<String>) -> Option<&str> {
    value.as_deref().map(str::trim).filter(|s| !s.is_empty())
}

/// The honest no-provider failure. Never suggests, and never silently uses, a
/// subscription login.
fn no_provider_error(task: AuxTaskClass) -> String {
    format!(
        "{} needs an AI provider, but no API key is configured. Add one in \
         Settings → API Keys (Anthropic, OpenAI, MiniMax, or OpenRouter). \
         PacketBench does not route these features through a Claude or ChatGPT \
         subscription login.",
        task.label()
    )
}

/// Pure resolution: routing settings first, otherwise the cheapest configured
/// provider. `configured` lists provider ids with a keyring credential.
///
/// Kept free of I/O so the ranking and the failure paths are unit-testable.
pub fn resolve_aux_route(
    task: AuxTaskClass,
    overrides: &AuxOverrides,
    configured: &[String],
) -> Result<AuxRoute, String> {
    if let Some(pinned) = overrides.get(&task) {
        if let Some(provider) = trimmed(&pinned.provider) {
            let candidate = aux_candidate(provider).ok_or_else(|| {
                format!(
                    "{} is routed to '{}', which is not an auxiliary provider. \
                     Set the route back to Auto in Settings → AI Provider Routing.",
                    task.label(),
                    provider
                )
            })?;

            if candidate.needs_api_key && !configured.iter().any(|c| c == provider) {
                return Err(format!(
                    "{} is routed to {}, but no {} API key is configured. Add one in \
                     Settings → API Keys, or set the route back to Auto.",
                    task.label(),
                    provider,
                    provider
                ));
            }

            // 3E-4: pinning Ollama REQUIRES an explicit model. The candidate
            // default ("qwen3:32b") is a guess about what the user has
            // pulled, and a wrong guess fails at turn time with a confusing
            // daemon error instead of here with an actionable one.
            let model = match trimmed(&pinned.model) {
                Some(model) => model.to_string(),
                None if candidate.provider == "ollama" => {
                    return Err(format!(
                        "{} is routed to Ollama without a model. Pick an installed model in \
                         Settings → AI Provider Routing, or set the route back to Auto.",
                        task.label()
                    ));
                }
                None => candidate.default_model.to_string(),
            };
            return Ok(AuxRoute {
                provider: provider.to_string(),
                model,
                explicit: true,
            });
        }
    }

    let mut ranked: Vec<(f64, usize, &AuxProviderCandidate)> = AUX_PROVIDERS
        .iter()
        .enumerate()
        .filter(|(_, c)| c.needs_api_key && configured.iter().any(|k| k == c.provider))
        .map(|(index, c)| (aux_rank_cost(c.default_model).unwrap_or(f64::MAX), index, c))
        .collect();

    ranked.sort_by(|a, b| {
        a.0.partial_cmp(&b.0)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then(a.1.cmp(&b.1))
    });

    match ranked.first() {
        Some((_, _, candidate)) => Ok(AuxRoute {
            provider: candidate.provider.to_string(),
            model: candidate.default_model.to_string(),
            explicit: false,
        }),
        None => Err(no_provider_error(task)),
    }
}

/// Provider ids with a non-empty keyring credential right now.
pub fn configured_aux_providers() -> Vec<String> {
    AUX_PROVIDERS
        .iter()
        .filter(|c| c.needs_api_key)
        .filter(|c| matches!(api_keys::load_api_key(c.provider), Ok(key) if !key.trim().is_empty()))
        .map(|c| c.provider.to_string())
        .collect()
}

// ---------------------------------------------------------------------------
// Managed state
// ---------------------------------------------------------------------------

/// In-memory mirror of the frontend's auxiliary routing settings.
///
/// The frontend (`src/stores/routingStore.ts`) is the persistence owner and
/// pushes the whole map through `set_aux_routing_overrides` on hydrate and on
/// every change. Before the first push the map is empty, which resolves to the
/// same automatic cheapest-configured route the defaults describe — so a boot
/// race can only mean "default routing", never a wrong credential.
#[derive(Default)]
pub struct AuxRoutingState {
    overrides: Mutex<AuxOverrides>,
}

impl AuxRoutingState {
    pub fn snapshot(&self) -> AuxOverrides {
        self.overrides
            .lock()
            .map(|guard| guard.clone())
            .unwrap_or_default()
    }

    pub fn replace(&self, next: AuxOverrides) {
        if let Ok(mut guard) = self.overrides.lock() {
            *guard = next;
        }
    }

    /// Resolve `task` against the live settings and the live keyring.
    pub fn resolve(&self, task: AuxTaskClass) -> Result<AuxRoute, String> {
        resolve_aux_route(task, &self.snapshot(), &configured_aux_providers())
    }
}

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

/// Default output budget for an auxiliary turn. Generous enough for a full PR
/// description or a multi-issue spec extraction, far below an agentic loop.
pub const AUX_MAX_TOKENS: u32 = 8192;

/// Outcome of one auxiliary turn.
#[derive(Debug, Clone, Default)]
pub struct AuxTurn {
    pub text: String,
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cache_read: u64,
    pub cache_write: u64,
}

fn build_request(
    route: &AuxRoute,
    session_id: &str,
    system_prompt: String,
    user_turn: String,
) -> LlmRequest {
    LlmRequest {
        model: route.model.clone(),
        messages: vec![ChatMessage {
            role: ChatRole::User,
            content: MessageContent::text(user_turn),
        }],
        tools: Vec::new(),
        system_prompt: Some(system_prompt),
        max_tokens: AUX_MAX_TOKENS,
        // Auxiliary tasks are structured-output tasks; keep them near-determin-
        // istic so a re-run of the same spec import produces the same drafts.
        temperature: Some(0.2),
        attachments: Vec::new(),
        thinking_enabled: false,
        thinking_budget_tokens: 0,
        cache_key: Some(session_id.to_string()),
    }
}

fn chunk_event(session_id: &str) -> String {
    format!("api-agent:chunk:{}", session_id)
}
fn done_event(session_id: &str) -> String {
    format!("api-agent:done:{}", session_id)
}
fn error_event(session_id: &str) -> String {
    format!("api-agent:error:{}", session_id)
}

/// `api-agent:done` payload. Field-for-field the shape `api_agent.rs` and the
/// sidecar supervisor emit, so frontend listeners stay transport-agnostic.
#[derive(Clone, Serialize)]
struct AuxDonePayload {
    input_tokens: u64,
    output_tokens: u64,
    cache_read_input_tokens: u64,
    cache_creation_input_tokens: u64,
    cancelled: bool,
}

#[derive(Clone, Serialize)]
struct AuxErrorPayload {
    message: String,
}

/// Drive one auxiliary turn to completion, optionally streaming text deltas out
/// as `api-agent:chunk:<sid>` events.
async fn drive(
    route: &AuxRoute,
    request: LlmRequest,
    emit_to: Option<(&tauri::AppHandle, &str)>,
) -> Result<AuxTurn, String> {
    let api_key = api_keys::load_api_key(&route.provider)?;
    let provider = get_provider(&route.provider)?;

    let (tx, mut rx) = mpsc::channel::<StreamChunk>(64);
    let provider_task =
        tokio::spawn(async move { provider.stream_chat(&api_key, request, tx).await });

    let mut turn = AuxTurn::default();
    let mut error: Option<String> = None;

    while let Some(chunk) = rx.recv().await {
        match chunk {
            StreamChunk::TextDelta { text } => {
                if text.is_empty() {
                    continue;
                }
                if let Some((app, session_id)) = emit_to {
                    if let Err(e) = app.emit(&chunk_event(session_id), text.clone()) {
                        warn!(session_id = %session_id, error = %e, "aux_llm: failed to emit chunk");
                    }
                }
                turn.text.push_str(&text);
            }
            StreamChunk::Done {
                input_tokens,
                output_tokens,
                cache_read_input_tokens,
                cache_creation_input_tokens,
            } => {
                turn.input_tokens = input_tokens;
                turn.output_tokens = output_tokens;
                turn.cache_read = cache_read_input_tokens;
                turn.cache_write = cache_creation_input_tokens;
                break;
            }
            StreamChunk::Error { message } => {
                error = Some(message);
                break;
            }
            // Auxiliary turns ship no tools and disable thinking.
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
        Err(join_err) => {
            if error.is_none() {
                error = Some(format!("Provider task panicked: {}", join_err));
            }
        }
    }

    match error {
        Some(message) => Err(message),
        None => Ok(turn),
    }
}

/// Append the turn to `~/.packetbench/usage.jsonl`. Auxiliary spend was invisible
/// while these features ran on the subscription sidecar (which writes no usage
/// rows at all); metering them is a side benefit of the move.
fn record_usage(task: AuxTaskClass, route: &AuxRoute, session_id: &str, turn: &AuxTurn) {
    if turn.input_tokens == 0 && turn.output_tokens == 0 {
        return;
    }
    let cost = pricing::calculate_cost(
        &route.model,
        turn.input_tokens,
        turn.output_tokens,
        turn.cache_read,
        turn.cache_write,
    );
    let entry = crate::commands::usage::UsageEntry {
        ts: crate::commands::usage::current_timestamp_iso(),
        source: "aux".to_string(),
        model: route.model.clone(),
        provider: Some(route.provider.clone()),
        agent_id: Some(task.id().to_string()),
        session_id: session_id.to_string(),
        input_tokens: turn.input_tokens,
        output_tokens: turn.output_tokens,
        cache_read: turn.cache_read,
        cache_write: turn.cache_write,
        cost_usd: cost,
    };
    if let Err(e) = crate::commands::usage::append_usage_entry(&entry) {
        warn!(task = task.id(), error = %e, "aux_llm: failed to persist usage entry");
    }
}

// ---------------------------------------------------------------------------
// Q3 — local-route failure policy: fail CLOSED, one retry, typed error
// ---------------------------------------------------------------------------

/// Delay before the single retry of a connection-shaped local failure —
/// enough for a daemon that is mid-restart, short enough not to feel hung.
const OLLAMA_RETRY_DELAY: std::time::Duration = std::time::Duration::from_secs(2);

/// Does this provider error look like "the daemon is not there" (as opposed
/// to a real model/request error that a retry cannot fix)? Keyed on the
/// stable messages `core::llm_ollama` / `commands::ollama` produce from
/// reqwest's `is_connect() || is_timeout()`.
fn is_ollama_connection_error(message: &str) -> bool {
    message.contains("Ollama not reachable")
}

/// Delays before each rate-limit retry, longest-tolerable-last.
///
/// Two attempts after the first. These are background turns with nobody
/// waiting on them, so the budget is set by how long a transient limit lasts
/// rather than by user patience — but not so long that a workspace close keeps
/// the gate occupied for minutes.
const RATE_LIMIT_RETRY_DELAYS: [std::time::Duration; 2] = [
    std::time::Duration::from_secs(2),
    std::time::Duration::from_secs(6),
];

/// Does this failure look like provider rate limiting?
///
/// Matched on the message because that is all `drive` returns. Both clients
/// format non-2xx identically — `"{provider} API error ({status}): {body}"`
/// (`llm_openai_compat.rs`, `llm_anthropic.rs`) — and `StatusCode`'s `Display`
/// starts with the number, so `"API error (429"` is an exact anchor rather
/// than a substring that could match a body quoting the digits.
///
/// Same idiom as [`is_ollama_connection_error`] above: this file already
/// classifies transport failures by inspecting the message.
fn is_rate_limited(message: &str) -> bool {
    message.contains("API error (429")
}

/// Deterministic 0-500 ms jitter, derived from the session id.
///
/// Two turns hold the gate at once, so without jitter both would retry in
/// lockstep and hand the provider the same burst that caused the 429. Derived
/// from the id rather than a random source so no new dependency is needed and
/// a given turn's timing is reproducible when reading a log.
fn retry_jitter(session_id: &str) -> std::time::Duration {
    let spread = session_id
        .bytes()
        .fold(0u64, |acc, b| acc.wrapping_mul(31).wrapping_add(b as u64));
    std::time::Duration::from_millis(spread % 500)
}

/// The Q3 typed, actionable error. NO automatic escalation to a cloud
/// provider — the task was routed locally on purpose, and silently billing a
/// cloud key instead would be worse than failing.
fn local_route_unavailable_error(task: AuxTaskClass) -> String {
    format!(
        "Local model unavailable (Ollama at {} did not respond). This task is routed \
         locally; run `ollama serve`, or switch {} to Auto in Settings → AI Provider Routing.",
        crate::core::storage::resolve_ollama_root_base_url(),
        task.label()
    )
}

/// Two turns per provider and lane (at most four per provider). Background
/// memory capture cannot occupy the interactive lane, even during retries;
/// one provider's failure cannot stall a different provider's requests.
const MAX_CONCURRENT_AUX_TURNS: usize = 2;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
enum AuxLane {
    Background,
    Interactive,
}

fn aux_lane(task: AuxTaskClass) -> AuxLane {
    match task {
        AuxTaskClass::SessionSummarize
        | AuxTaskClass::PatternExtract
        | AuxTaskClass::FlightRetrospective => AuxLane::Background,
        _ => AuxLane::Interactive,
    }
}

#[derive(Default)]
struct AuxTurnQueues {
    permits: Mutex<HashMap<(String, AuxLane), Arc<tokio::sync::Semaphore>>>,
}

impl AuxTurnQueues {
    fn for_turn(&self, provider: &str, task: AuxTaskClass) -> Arc<tokio::sync::Semaphore> {
        // The short map lock is never held across an await. The public route
        // resolver restricts provider ids to AUX_PROVIDERS, bounding this map.
        let mut permits = self.permits.lock().unwrap_or_else(|e| e.into_inner());
        permits
            .entry((provider.to_string(), aux_lane(task)))
            .or_insert_with(|| Arc::new(tokio::sync::Semaphore::new(MAX_CONCURRENT_AUX_TURNS)))
            .clone()
    }
}

fn aux_turn_permits(provider: &str, task: AuxTaskClass) -> Arc<tokio::sync::Semaphore> {
    static QUEUES: std::sync::OnceLock<AuxTurnQueues> = std::sync::OnceLock::new();
    QUEUES
        .get_or_init(AuxTurnQueues::default)
        .for_turn(provider, task)
}

/// [`drive`], plus the local-route failure policy: when the route is Ollama
/// and the failure is connection-shaped, retry exactly once after
/// [`OLLAMA_RETRY_DELAY`]; if it still fails, replace the raw transport error
/// with the typed, actionable message. Non-connection failures and cloud
/// routes pass through untouched.
async fn drive_with_local_policy(
    task: AuxTaskClass,
    route: &AuxRoute,
    session_id: &str,
    system_prompt: &str,
    user_turn: &str,
    emit_to: Option<(&tauri::AppHandle, &str)>,
) -> Result<AuxTurn, String> {
    // Held for the whole turn, streaming and rate-limit backoff included.
    // `drive_with_local_policy` does not recurse — it calls `drive` at most
    // twice per attempt, for the one Ollama retry — so holding a permit across
    // it cannot deadlock.
    //
    // Holding it through the backoff is deliberate: if the provider is
    // refusing work, occupying the slot is backpressure rather than waste.
    // Releasing it would let the next queued turn fire straight into the same
    // limit.
    let _permit = aux_turn_permits(&route.provider, task)
        .acquire_owned()
        .await
        .map_err(|_| "aux turn concurrency gate closed".to_string())?;

    let mut attempt = 0usize;
    loop {
        match drive_local_route_once(task, route, session_id, system_prompt, user_turn, emit_to)
            .await
        {
            Ok(turn) => return Ok(turn),
            Err(message)
                if is_rate_limited(&message) && attempt < RATE_LIMIT_RETRY_DELAYS.len() =>
            {
                let delay = RATE_LIMIT_RETRY_DELAYS[attempt] + retry_jitter(session_id);
                warn!(
                    task = task.id(),
                    session_id = %session_id,
                    provider = %route.provider,
                    attempt = attempt + 1,
                    of = RATE_LIMIT_RETRY_DELAYS.len(),
                    delay_ms = delay.as_millis() as u64,
                    "aux_llm: provider rate limited — backing off and retrying"
                );
                tokio::time::sleep(delay).await;
                attempt += 1;
            }
            Err(message) => {
                if is_rate_limited(&message) {
                    // Distinct from the per-attempt warning: this is the one
                    // that says the work was actually dropped.
                    warn!(
                        task = task.id(),
                        session_id = %session_id,
                        provider = %route.provider,
                        attempts = attempt + 1,
                        "aux_llm: giving up after rate-limit retries — this turn is lost"
                    );
                }
                return Err(message);
            }
        }
    }
}

/// One attempt, including the Ollama local-route retry policy.
///
/// Split out of [`drive_with_local_policy`] so the rate-limit backoff can wrap
/// a whole attempt. Retrying is safe for a streaming caller: a non-2xx fails
/// before any chunk is emitted, so no partial output reaches the UI to be
/// duplicated.
async fn drive_local_route_once(
    task: AuxTaskClass,
    route: &AuxRoute,
    session_id: &str,
    system_prompt: &str,
    user_turn: &str,
    emit_to: Option<(&tauri::AppHandle, &str)>,
) -> Result<AuxTurn, String> {
    let request = build_request(
        route,
        session_id,
        system_prompt.to_string(),
        user_turn.to_string(),
    );
    match drive(route, request, emit_to).await {
        Ok(turn) => Ok(turn),
        Err(message) if route.provider == "ollama" && is_ollama_connection_error(&message) => {
            warn!(
                task = task.id(),
                session_id = %session_id,
                error = %message,
                "aux_llm: local route connection failure — retrying once"
            );
            tokio::time::sleep(OLLAMA_RETRY_DELAY).await;
            let retry_request = build_request(
                route,
                session_id,
                system_prompt.to_string(),
                user_turn.to_string(),
            );
            match drive(route, retry_request, emit_to).await {
                Ok(turn) => Ok(turn),
                Err(retry_message) if is_ollama_connection_error(&retry_message) => {
                    Err(local_route_unavailable_error(task))
                }
                Err(retry_message) => Err(retry_message),
            }
        }
        Err(message) => Err(message),
    }
}

/// Run an auxiliary turn and return the whole response text.
///
/// Used by callers with a blocking, request/response shape (spec import).
pub async fn run_aux_oneshot(
    task: AuxTaskClass,
    route: &AuxRoute,
    session_id: &str,
    system_prompt: String,
    user_turn: String,
) -> Result<String, String> {
    info!(
        task = task.id(),
        provider = %route.provider,
        model = %route.model,
        explicit_route = route.explicit,
        session_id = %session_id,
        "aux_llm: one-shot turn"
    );
    let turn =
        drive_with_local_policy(task, route, session_id, &system_prompt, &user_turn, None).await?;
    record_usage(task, route, session_id, &turn);
    Ok(turn.text)
}

/// Run an auxiliary turn in the background, streaming
/// `api-agent:chunk|done|error:<session_id>` exactly as the API-agent runtimes
/// do. Used by callers whose UI already subscribes to those events.
pub fn spawn_aux_stream(
    app_handle: tauri::AppHandle,
    task: AuxTaskClass,
    route: AuxRoute,
    session_id: String,
    system_prompt: String,
    user_turn: String,
) {
    info!(
        task = task.id(),
        provider = %route.provider,
        model = %route.model,
        explicit_route = route.explicit,
        session_id = %session_id,
        "aux_llm: streaming turn"
    );
    tokio::spawn(async move {
        match drive_with_local_policy(
            task,
            &route,
            &session_id,
            &system_prompt,
            &user_turn,
            Some((&app_handle, &session_id)),
        )
        .await
        {
            Ok(turn) => {
                record_usage(task, &route, &session_id, &turn);
                if turn.text.trim().is_empty() {
                    let _ = app_handle.emit(
                        &error_event(&session_id),
                        AuxErrorPayload {
                            message: "The model returned an empty response.".to_string(),
                        },
                    );
                    return;
                }
                let _ = app_handle.emit(
                    &done_event(&session_id),
                    AuxDonePayload {
                        input_tokens: turn.input_tokens,
                        output_tokens: turn.output_tokens,
                        cache_read_input_tokens: turn.cache_read,
                        cache_creation_input_tokens: turn.cache_write,
                        cancelled: false,
                    },
                );
            }
            Err(message) => {
                warn!(
                    task = task.id(),
                    session_id = %session_id,
                    error = %message,
                    "aux_llm: turn failed"
                );
                let _ = app_handle.emit(&error_event(&session_id), AuxErrorPayload { message });
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The gate that stops a workspace close from stampeding the provider.
    ///
    /// Regression fence for the 2026-09-06 dogfooding finding: eight
    /// `session-summarize` turns fired within 3 ms when a workspace with eight
    /// terminals was closed, the provider 429'd all eight, and every summary
    /// was lost. This asserts the third concurrent caller waits instead.
    #[tokio::test]
    async fn aux_turns_are_bounded_rather_than_stampeding() {
        let queues = AuxTurnQueues::default();
        let gate = queues.for_turn("minimax", AuxTaskClass::SessionSummarize);
        assert_eq!(
            gate.available_permits(),
            MAX_CONCURRENT_AUX_TURNS,
            "gate should start fully available; another test may be holding permits"
        );

        let first = gate.acquire().await.expect("gate open");
        let second = gate.acquire().await.expect("gate open");
        assert_eq!(gate.available_permits(), 0);

        // The stampede case: a third turn becoming due at the same instant must
        // queue, not fire.
        assert!(
            gate.try_acquire().is_err(),
            "a third concurrent aux turn must wait, not stampede the provider"
        );

        drop(first);
        let third = gate
            .try_acquire()
            .expect("a permit frees up when a turn finishes");
        drop(third);
        drop(second);
        assert_eq!(gate.available_permits(), MAX_CONCURRENT_AUX_TURNS);
    }

    #[tokio::test]
    async fn background_backlog_does_not_block_interactive_or_another_provider() {
        let queues = AuxTurnQueues::default();
        let background = queues.for_turn("minimax", AuxTaskClass::SessionSummarize);
        let _busy = background
            .acquire_many(MAX_CONCURRENT_AUX_TURNS as u32)
            .await
            .unwrap();
        // These permits model in-flight work, including a turn in retry backoff.
        let more_background = queues.for_turn("minimax", AuxTaskClass::PatternExtract);
        assert!(more_background.try_acquire().is_err());
        let other_provider = queues.for_turn("openai", AuxTaskClass::SessionSummarize);
        assert!(other_provider.try_acquire().is_ok());
        let interactive = queues.for_turn("minimax", AuxTaskClass::SideChat);
        let _chat = interactive
            .acquire_many(MAX_CONCURRENT_AUX_TURNS as u32)
            .await
            .unwrap();
        let more_interactive = queues.for_turn("minimax", AuxTaskClass::SpecImport);
        assert!(
            more_interactive.try_acquire().is_err(),
            "interactive lane must stay bounded"
        );
        drop(_busy);
        assert!(more_background.try_acquire().is_ok());
        // A dropped/cancelled future releases its owned lane permit as well.
        let owned = more_background.clone().acquire_owned().await.unwrap();
        drop(owned);
        assert_eq!(
            more_background.available_permits(),
            MAX_CONCURRENT_AUX_TURNS
        );
    }

    /// The classifier must key off the real message both clients produce, not
    /// a hopeful substring. F26 follow-up.
    #[test]
    fn rate_limit_classifier_matches_what_the_clients_actually_format() {
        // `"{provider} API error ({status}): {body}"` with StatusCode's Display.
        assert!(is_rate_limited(
            "minimax API error (429 Too Many Requests): {\"error\":\"rate limited\"}"
        ));
        assert!(is_rate_limited(
            "Anthropic API error (429 Too Many Requests): overloaded"
        ));

        // Other failures must NOT be retried — a 400 or 401 will fail
        // identically every time and retrying only wastes the gate.
        assert!(!is_rate_limited(
            "minimax API error (400 Bad Request): bad parameter"
        ));
        assert!(!is_rate_limited(
            "minimax API error (401 Unauthorized): bad key"
        ));
        assert!(!is_rate_limited("Ollama not reachable"));

        // A body that merely quotes the number is not a 429 status.
        assert!(!is_rate_limited(
            "minimax API error (400 Bad Request): max_tokens must be under 429"
        ));
    }

    /// Two turns retrying in lockstep would hand the provider the same burst
    /// that caused the 429 in the first place.
    #[test]
    fn retry_jitter_differs_per_session_and_stays_bounded() {
        let a = retry_jitter("session-summarize-b3ccd130-862d-4db1-b68f-43d8bf90c4f1");
        let b = retry_jitter("session-summarize-a901d369-a10a-4a16-a860-3476d4c24826");
        assert_ne!(a, b, "concurrent turns must not back off in lockstep");
        for id in [
            "",
            "x",
            "session-summarize-4cfd4b33-71b1-4ed2-bed7-c18d5c96ae49",
        ] {
            assert!(retry_jitter(id) < std::time::Duration::from_millis(500));
        }
    }

    /// The budget is what stops a lost summary being silent AND stops a
    /// rate-limited turn holding the gate for minutes.
    #[test]
    fn rate_limit_retry_budget_is_bounded_and_ordered() {
        assert_eq!(
            RATE_LIMIT_RETRY_DELAYS.len(),
            2,
            "two attempts after the first"
        );
        assert!(
            RATE_LIMIT_RETRY_DELAYS.windows(2).all(|w| w[0] < w[1]),
            "delays must back off, not stay flat"
        );
        let worst: std::time::Duration = RATE_LIMIT_RETRY_DELAYS.iter().sum();
        assert!(
            worst <= std::time::Duration::from_secs(10),
            "a rate-limited turn must not occupy one of only {} slots for long",
            MAX_CONCURRENT_AUX_TURNS
        );
    }

    fn configured(ids: &[&str]) -> Vec<String> {
        ids.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn no_subscription_oauth_provider_is_an_aux_candidate() {
        // The compliance invariant. If this ever fails, WI-1 has regressed.
        for candidate in AUX_PROVIDERS {
            assert_ne!(candidate.provider, "claude-oauth");
            assert_ne!(candidate.provider, "openai-codex");
        }
    }

    #[test]
    fn every_aux_candidate_is_a_real_in_process_provider() {
        for candidate in AUX_PROVIDERS {
            assert!(
                get_provider(candidate.provider).is_ok(),
                "{} is not dispatchable by get_provider",
                candidate.provider
            );
        }
    }

    #[test]
    fn every_aux_default_model_is_priced_by_the_shared_table() {
        // Ollama is free-by-design (local), so it is allowed to price at zero;
        // the metered candidates must all be rankable.
        for candidate in AUX_PROVIDERS.iter().filter(|c| c.needs_api_key) {
            let cost = aux_rank_cost(candidate.default_model);
            assert!(
                cost.is_some_and(|c| c > 0.0),
                "{} default model {} has no rate in shared/model-pricing.json",
                candidate.provider,
                candidate.default_model
            );
        }
    }

    #[test]
    fn auto_picks_the_cheapest_configured_provider() {
        // All four metered providers configured: MiniMax is cheapest in the
        // shared table (0.30 / 1.20 per Mtok).
        let route = resolve_aux_route(
            AuxTaskClass::PrReview,
            &AuxOverrides::new(),
            &configured(&["anthropic", "openai", "minimax", "openrouter"]),
        )
        .expect("a route");
        assert_eq!(route.provider, "minimax");
        assert_eq!(route.model, "MiniMax-M2");
        assert!(!route.explicit);
    }

    #[test]
    fn auto_ranking_follows_the_pricing_table_not_declaration_order() {
        // anthropic is declared first, openai second — but claude-haiku-4-5
        // (1.00 / 5.00) beats o4-mini (1.10 / 4.40) on the representative
        // workload, and o4-mini wins nothing by being declared later.
        let anthropic_only = resolve_aux_route(
            AuxTaskClass::SpecImport,
            &AuxOverrides::new(),
            &configured(&["openai"]),
        )
        .expect("a route");
        assert_eq!(anthropic_only.provider, "openai");

        let both = resolve_aux_route(
            AuxTaskClass::SpecImport,
            &AuxOverrides::new(),
            &configured(&["anthropic", "openai"]),
        )
        .expect("a route");
        assert_eq!(both.provider, "anthropic");

        let anthropic_cost = aux_rank_cost("claude-haiku-4-5").expect("priced");
        let openai_cost = aux_rank_cost("o4-mini").expect("priced");
        assert!(anthropic_cost < openai_cost);
    }

    #[test]
    fn auto_ignores_unconfigured_providers() {
        let route = resolve_aux_route(
            AuxTaskClass::PrDescription,
            &AuxOverrides::new(),
            &configured(&["openrouter"]),
        )
        .expect("a route");
        assert_eq!(route.provider, "openrouter");
    }

    #[test]
    fn auto_never_selects_ollama() {
        // Ollama prices at zero and would win every ranking, but a stopped
        // daemon is indistinguishable from a configured one here.
        let err = resolve_aux_route(
            AuxTaskClass::CodeQualityExplain,
            &AuxOverrides::new(),
            &configured(&["ollama"]),
        )
        .unwrap_err();
        assert!(err.contains("no API key is configured"), "{}", err);
    }

    #[test]
    fn no_configured_provider_fails_with_a_settings_pointer() {
        for task in AuxTaskClass::ALL {
            let err = resolve_aux_route(*task, &AuxOverrides::new(), &[]).unwrap_err();
            assert!(err.contains(task.label()), "{}", err);
            assert!(err.contains("Settings → API Keys"), "{}", err);
            // The error must never nudge the user back toward a subscription —
            // it names one only to say it is not used.
            assert!(!err.contains("claude-oauth"), "{}", err);
            assert!(
                err.contains(
                    "does not route these features through a Claude or ChatGPT subscription login"
                ),
                "{}",
                err
            );
        }
    }

    #[test]
    fn routing_settings_override_the_automatic_choice() {
        let mut overrides = AuxOverrides::new();
        overrides.insert(
            AuxTaskClass::PrReview,
            AuxRouteOverride {
                provider: Some("anthropic".to_string()),
                model: Some("claude-sonnet-4-6".to_string()),
            },
        );

        let pinned = resolve_aux_route(
            AuxTaskClass::PrReview,
            &overrides,
            &configured(&["anthropic", "minimax"]),
        )
        .expect("a route");
        assert_eq!(pinned.provider, "anthropic");
        assert_eq!(pinned.model, "claude-sonnet-4-6");
        assert!(pinned.explicit);

        // A pin is per-task-class: other classes keep auto-selecting.
        let auto = resolve_aux_route(
            AuxTaskClass::SpecImport,
            &overrides,
            &configured(&["anthropic", "minimax"]),
        )
        .expect("a route");
        assert_eq!(auto.provider, "minimax");
    }

    #[test]
    fn override_without_a_model_uses_the_candidate_default() {
        let mut overrides = AuxOverrides::new();
        overrides.insert(
            AuxTaskClass::SpecImport,
            AuxRouteOverride {
                provider: Some("openai".to_string()),
                model: None,
            },
        );
        let route = resolve_aux_route(
            AuxTaskClass::SpecImport,
            &overrides,
            &configured(&["openai"]),
        )
        .expect("a route");
        assert_eq!(route.model, "o4-mini");
    }

    #[test]
    fn override_to_an_unconfigured_provider_fails_rather_than_falling_back() {
        let mut overrides = AuxOverrides::new();
        overrides.insert(
            AuxTaskClass::PrDescription,
            AuxRouteOverride {
                provider: Some("openai".to_string()),
                model: None,
            },
        );
        // MiniMax IS configured — a silent fallback would be easy and wrong.
        let err = resolve_aux_route(
            AuxTaskClass::PrDescription,
            &overrides,
            &configured(&["minimax"]),
        )
        .unwrap_err();
        assert!(err.contains("no openai API key is configured"), "{}", err);
    }

    #[test]
    fn override_to_a_subscription_provider_is_rejected() {
        // Belt and braces: even a hand-edited localStorage entry cannot route
        // an auxiliary feature at subscription credentials.
        for provider in ["claude-oauth", "openai-codex"] {
            let mut overrides = AuxOverrides::new();
            overrides.insert(
                AuxTaskClass::PrReview,
                AuxRouteOverride {
                    provider: Some(provider.to_string()),
                    model: None,
                },
            );
            let err = resolve_aux_route(
                AuxTaskClass::PrReview,
                &overrides,
                &configured(&["anthropic"]),
            )
            .unwrap_err();
            assert!(err.contains("not an auxiliary provider"), "{}", err);
        }
    }

    #[test]
    fn ollama_stays_selectable_explicitly_without_a_key() {
        let mut overrides = AuxOverrides::new();
        overrides.insert(
            AuxTaskClass::CodeQualitySummarize,
            AuxRouteOverride {
                provider: Some("ollama".to_string()),
                model: Some("qwen3:32b".to_string()),
            },
        );
        let route = resolve_aux_route(AuxTaskClass::CodeQualitySummarize, &overrides, &[])
            .expect("a route");
        assert_eq!(route.provider, "ollama");
    }

    #[test]
    fn pinning_ollama_without_a_model_is_a_validation_error() {
        // 3E-4: the static default ("qwen3:32b") is a guess about what the
        // user has pulled; requiring an explicit model turns a confusing
        // turn-time daemon error into an actionable settings error.
        let mut overrides = AuxOverrides::new();
        overrides.insert(
            AuxTaskClass::CodeQualitySummarize,
            AuxRouteOverride {
                provider: Some("ollama".to_string()),
                model: None,
            },
        );
        let err =
            resolve_aux_route(AuxTaskClass::CodeQualitySummarize, &overrides, &[]).unwrap_err();
        assert!(err.contains("without a model"), "{}", err);
        assert!(err.contains("Settings → AI Provider Routing"), "{}", err);

        // Cloud pins keep their provider default — only Ollama requires the
        // explicit choice.
        let mut cloud = AuxOverrides::new();
        cloud.insert(
            AuxTaskClass::CodeQualitySummarize,
            AuxRouteOverride {
                provider: Some("anthropic".to_string()),
                model: None,
            },
        );
        let route = resolve_aux_route(
            AuxTaskClass::CodeQualitySummarize,
            &cloud,
            &configured(&["anthropic"]),
        )
        .expect("a route");
        assert_eq!(route.model, "claude-haiku-4-5");
    }

    #[test]
    fn blank_override_strings_fall_back_to_auto() {
        let mut overrides = AuxOverrides::new();
        overrides.insert(
            AuxTaskClass::PrReview,
            AuxRouteOverride {
                provider: Some("   ".to_string()),
                model: Some("".to_string()),
            },
        );
        let route = resolve_aux_route(
            AuxTaskClass::PrReview,
            &overrides,
            &configured(&["anthropic"]),
        )
        .expect("a route");
        assert_eq!(route.provider, "anthropic");
        assert!(!route.explicit);
    }

    #[test]
    fn cheap_tier_model_follows_the_parent_provider() {
        // Q2 — the MiniMax-only-user defect: a sub-agent must never demand a
        // vendor the parent session does not use.
        assert_eq!(
            cheap_tier_model("anthropic", "claude-opus-4-8"),
            "claude-haiku-4-5"
        );
        assert_eq!(cheap_tier_model("openai", "gpt-5.5"), "o4-mini");
        assert_eq!(cheap_tier_model("openai-agents", "gpt-5.5"), "o4-mini");
        assert_eq!(cheap_tier_model("minimax", "MiniMax-M3"), "MiniMax-M2");
        assert_eq!(cheap_tier_model("minimax-api", "MiniMax-M3"), "MiniMax-M2");
        assert_eq!(
            cheap_tier_model("openrouter", "openai/gpt-5.5"),
            "anthropic/claude-haiku-4-5"
        );
        // Local providers keep the parent's own (proven-loaded) model.
        assert_eq!(
            cheap_tier_model("ollama", "qwen2.5-coder:7b"),
            "qwen2.5-coder:7b"
        );
        assert_eq!(cheap_tier_model("custom", "some-model"), "some-model");
        // Unknown providers fall back to the parent model, never to a vendor.
        assert_eq!(cheap_tier_model("mystery", "parent-model"), "parent-model");
    }

    #[test]
    fn connection_shaped_ollama_errors_are_recognised() {
        // Q3 — keyed on the stable message llm_ollama/commands::ollama emit
        // for reqwest is_connect()/is_timeout() failures.
        assert!(is_ollama_connection_error(
            "Ollama not reachable at http://localhost:11434"
        ));
        assert!(!is_ollama_connection_error(
            "Ollama API error (500): model requires more system memory"
        ));
        assert!(!is_ollama_connection_error(
            "The Ollama model 'x' does not support tool calling (no tools template)."
        ));
    }

    #[test]
    fn local_route_failure_error_is_typed_and_actionable() {
        let err = local_route_unavailable_error(AuxTaskClass::SpecImport);
        assert!(err.contains("Local model unavailable"), "{}", err);
        assert!(err.contains("ollama serve"), "{}", err);
        assert!(err.contains("Spec import"), "{}", err);
        assert!(err.contains("Settings → AI Provider Routing"), "{}", err);
        // NO automatic escalation: the error must not promise a cloud
        // fallback of any kind.
        assert!(!err.to_lowercase().contains("falling back"), "{}", err);
    }

    #[test]
    fn task_class_ids_round_trip() {
        for task in AuxTaskClass::ALL {
            assert_eq!(AuxTaskClass::from_id(task.id()), Some(*task));
            // Serde must agree with `id()` so the TS union stays in sync.
            let json = serde_json::to_string(task).expect("serialize");
            assert_eq!(json, format!("\"{}\"", task.id()));
        }
        assert_eq!(AuxTaskClass::from_id("nope"), None);
    }

    #[test]
    fn state_defaults_to_auto_before_the_frontend_pushes_settings() {
        let state = AuxRoutingState::default();
        assert!(state.snapshot().is_empty());

        let mut overrides = AuxOverrides::new();
        overrides.insert(
            AuxTaskClass::SpecImport,
            AuxRouteOverride {
                provider: Some("anthropic".to_string()),
                model: None,
            },
        );
        state.replace(overrides.clone());
        assert_eq!(state.snapshot(), overrides);
    }
}
