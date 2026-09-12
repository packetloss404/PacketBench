//! Node sidecar process supervisor.
//!
//! Spawns and maintains a long-lived `node agent-sidecar/dist/index.js` child
//! process, speaks a newline-delimited JSON protocol over stdin/stdout, and
//! translates sidecar events into the `api-agent:*` Tauri events the frontend
//! already listens on (see `api_agent.rs` for the existing shapes that this
//! supervisor must mirror exactly — the frontend cannot tell which backend
//! produced the event).
//!
//! Slice B of the SDK-sidecar plan: plumbing only. Slice C (the routing layer
//! in `api_agent.rs`) calls the `forward_*` methods exposed here; no Tauri
//! commands are registered from this module — except `get_sidecar_status`
//! below.

use std::sync::Arc;
use std::time::Duration;

mod events;
mod handler;
mod protocol;
mod status;
mod supervisor;

#[allow(unused_imports)]
pub use status::{SidecarLifetimeStats, SidecarStatus};
pub use supervisor::SidecarManager;

/// Providers whose sessions are routed through the Node sidecar rather than
/// the in-process Rust runtime. Keep in sync with slice C's dispatch logic.
///
/// Every entry authenticates with an **API key** loaded from the OS keyring by
/// `api_agent.rs` and handed to the sidecar over the wire. `claude-oauth` is a
/// historical identifier retained for persisted-conversation compatibility —
/// it now means "Claude Agent SDK on `api-key-anthropic`", not OAuth.
///
/// `openai-codex` was removed in 2026-07: it existed only to drive `codex exec`
/// on a ChatGPT subscription, and `openai-agents` reaches the same API with an
/// API key. The short id stays a valid *auth-probe* input in
/// `provider_auth.rs` because PTY Codex CLI sessions still use it.
pub const SIDECAR_PROVIDERS: &[&str] = &["claude-oauth", "openai-agents", "echo"];

/// Wire protocol version this supervisor was built against. Must match
/// `PROTOCOL_VERSION` in `agent-sidecar/src/protocol.ts`.
///
/// Negotiation is ASYMMETRIC (see [`MINIMUM_PROTOCOL_VERSION`]): a version
/// ABOVE this one is a warning, because every version through v10 added
/// optional request types that an older peer rejects loudly and cleanly. A
/// version BELOW the floor is refused.
///
/// v2 (Tier 3 slice B): added `set_permission_mode`, `set_model`, and `retry`
/// request types on the wire.
///
/// v3 (PacketBench Tier 3 slice A): added typed `attachments` on start/send,
/// `mergedContent` on edit_response, `batchId`/`batchSize` on
/// `permission_request`, `resumeToken` on `done`, and three new events:
/// `plan_block`, `tool_output_extended`, `turn_summary`.
///
/// v4 (F8): added `cancel_pending_tools` request — drains parked
/// permission/edit prompts as denied without killing the session.
///
/// v5 (Flight Planner E1): added `inject_user_turn` request (typed
/// wake-trigger injection — distinct from `send_message` so the planner
/// system prompt can reliably tell wake-triggered re-entry apart from a
/// real user message), plus an optional `mcpKind` field on
/// `start_session` so the sidecar can construct in-process MCP servers
/// (e.g. the Flight Planner tool surface) locally without those live
/// JS instances having to cross the wire.
///
/// v6 (rate-limit signal): added the `rate_limited` event. The Anthropic
/// provider catches `RateLimitError` (HTTP 429) and emits it alongside the
/// regular `error` emit; this supervisor records it to the log (the
/// `error` event already surfaces the failure to the session).
///
/// v7 (planner amputation): removed the in-process planner MCP surface —
/// the `planner_tool` event, the `planner_tool_result` request, and the
/// `mcpKind` field on `start_session`. The Rust planner backend was deleted
/// in C2-S1, so the supervisor no longer emits or accepts planner
/// envelopes. `inject_user_turn` and `rate_limited` survive. Negotiation
/// stays warn-only, so a v6 sidecar paired with a v7 supervisor (or vice
/// versa) still connects.
///
/// v8 (S8-Phase-B): added `sourceMcpFromFs` on `start_session` (remote-owned
/// MCP config sourcing — the sidecar reads its own ~/.claude/settings.json +
/// <project>/.mcp.json and runs ALL servers from there, ignoring the forwarded
/// `mcpServers`) plus the `mcp_sources` event reporting which servers were
/// sourced (name/transport/scope) and any read errors — no commands/secrets.
/// Negotiation stays warn-only.
///
/// v9 (G11): `edit_response` now carries the pending edit's `toolUseId`, so
/// providers resolve one exact approval instead of draining every edit.
///
/// v10 (G06/G36): `done` can carry `cancelled`, making user cancellation an
/// explicit terminal outcome without ending the reusable conversation.
///
/// v11 (MCPH4): `start_session` carries `mcpTrustSnapshot` — the frozen,
/// per-server MCP trust and capability authority for the session. The sidecar
/// filters transports and tools against it, so later Settings edits cannot
/// broaden a running session, and a read-only session runs only tools the
/// server annotated `readOnlyHint` or the user explicitly allowed.
///
/// v11 is the reason negotiation stopped being warn-only. Every earlier
/// version added REQUESTS: send one to a sidecar that predates it and you get
/// "Unknown request type" back — loud, immediate, and safe. v11 added a FIELD
/// on an existing request, and an older sidecar does not reject an unknown
/// JSON field; it ignores it and then runs every forwarded MCP server with no
/// filtering at all. The user sees a working session. The degradation is
/// silent and it is a security downgrade, which is why it is a floor and not
/// a warning.
/// v12 adds `projectTrustDataDir` and requires remote project trust before
/// repo-owned MCP commands can be merged or probed. v11 ignores this field,
/// so accepting it would preserve the SSH project-trust bypass.
pub(super) const EXPECTED_PROTOCOL_VERSION: u32 = 12;

/// Lowest protocol version this supervisor will start sessions against.
///
/// A sidecar advertising less than this is marked
/// [`status::SidecarState::Incompatible`] and every `start_session` is refused
/// with a message the user can act on. Raise this only when a version
/// introduces a security-relevant field (as v11 did) — not for ordinary
/// feature additions, which stay warn-only so mixed-version pairings keep
/// working.
pub(super) const MINIMUM_PROTOCOL_VERSION: u32 = 12;

/// Convenience predicate used by slice C to decide whether to call
/// `forward_*` vs. the existing Rust path.
pub fn is_sidecar_provider(provider: &str) -> bool {
    SIDECAR_PROVIDERS.contains(&provider)
}

/// Build the `~/.packetbench/usage.jsonl` row for one sidecar `turn_summary`
/// delta — the sidecar counterpart of the `UsageEntry` construction sites in
/// `api_agent.rs`, and the reason sidecar spend reaches the analytics rollup
/// (`read_usage_analytics`) and the daily/monthly budget guardrails at all.
///
/// Token counts are stored **raw** (the vendor's own figures — see
/// `usage::UsageEntry`); the cost normalises OpenAI-family superset prompt
/// counts through `pricing::billable_input_tokens`, exactly like the
/// in-process call sites. `source` prefixes the sidecar provider id with
/// `api-` (`claude-oauth` → `api-claude-oauth`, `openai-agents` →
/// `api-openai-agents`) so sidecar rows stay distinguishable from the
/// in-process `api-claude` / `api-openai` rows and the vendor-CLI-scraped
/// `claude-cli` / `codex` sources.
#[allow(clippy::too_many_arguments)]
pub(crate) fn sidecar_usage_entry(
    provider: &str,
    model: &str,
    session_id: &str,
    input_tokens: u64,
    output_tokens: u64,
    cache_read: u64,
    cache_write: u64,
) -> crate::commands::usage::UsageEntry {
    let cost = crate::commands::pricing::calculate_cost(
        model,
        crate::commands::pricing::billable_input_tokens(model, input_tokens, cache_read),
        output_tokens,
        cache_read,
        cache_write,
    );
    crate::commands::usage::UsageEntry {
        ts: crate::commands::usage::current_timestamp_iso(),
        source: format!("api-{provider}"),
        model: model.to_string(),
        provider: Some(provider.to_string()),
        agent_id: None,
        session_id: session_id.to_string(),
        input_tokens,
        output_tokens,
        cache_read,
        cache_write,
        cost_usd: cost,
    }
}

/// F7 — does a peer's advertised protocol version clear the security floor?
///
/// `None` (a `ready` event with no `protocolVersion` at all) does NOT clear it.
/// A sidecar old enough to omit the field is far older than v11, and "we could
/// not tell" is the same answer as "no" when the thing we could not tell is
/// whether MCP trust is enforced.
///
/// Shared by the local handshake ([`handler`]), the per-session SSH handshake,
/// and the `forward_start` gate, so all three refuse on identical terms.
pub(super) fn protocol_meets_floor(advertised: Option<u32>) -> bool {
    matches!(advertised, Some(version) if version >= MINIMUM_PROTOCOL_VERSION)
}

/// Maximum sidecar restarts allowed within `RESTART_WINDOW`.
pub(super) const MAX_RESTARTS_IN_WINDOW: usize = 3;
pub(super) const RESTART_WINDOW: Duration = Duration::from_secs(60);

/// Tauri event name emitted whenever the sidecar's lifecycle state transitions
/// (ready / restarting / down / not_started). The frontend status-bar chip
/// subscribes to this to update without polling.
pub(super) const SIDECAR_STATUS_EVENT: &str = "sidecar-status:changed";

// ---------------------------------------------------------------------------
// Tauri commands (v2 Tier 2 slice B)
// ---------------------------------------------------------------------------

/// Return the sidecar's current lifecycle status. The frontend status-bar
/// chip polls this on mount, then listens for `sidecar-status:changed` to get
/// live updates without further polling.
///
/// Never fails — the manager is always registered by `.setup()` before any
/// invoke handler can be called. Returns the default ("not_started") status
/// if the manager has not yet observed any lifecycle event.
#[tauri::command]
pub async fn get_sidecar_status(
    state: tauri::State<'_, Arc<SidecarManager>>,
) -> Result<SidecarStatus, String> {
    Ok(state.current_status().await)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sdk_providers_route_through_the_sidecar_forward_path() {
        // Both surviving sidecar providers go through the `forward_*` path,
        // which is provider-agnostic w.r.t. SSH. That is what makes them work
        // over the remote sidecar (no per-provider SSH gate); a regression that
        // dropped one here would force it local-only.
        assert!(is_sidecar_provider("claude-oauth"));
        assert!(is_sidecar_provider("openai-agents"));
        assert!(!is_sidecar_provider("api-openai"));
        assert!(!is_sidecar_provider("api-claude"));
    }

    #[test]
    fn protocol_floor_refuses_below_v12_and_accepts_at_or_above() {
        // The whole point of F7: v10 and older silently ignore
        // `mcpTrustSnapshot`, so they must not serve sessions.
        assert!(!protocol_meets_floor(Some(1)));
        assert!(!protocol_meets_floor(Some(10)));
        assert!(
            !protocol_meets_floor(Some(11)),
            "v11 ignores remote project trust"
        );
        assert!(protocol_meets_floor(Some(MINIMUM_PROTOCOL_VERSION)));
        // Newer than us stays warn-only — a forward-compatible sidecar still
        // enforces trust, it just knows about requests we do not send.
        assert!(protocol_meets_floor(Some(EXPECTED_PROTOCOL_VERSION + 5)));
    }

    #[test]
    fn protocol_floor_refuses_a_handshake_that_advertises_nothing() {
        // A pre-handshake build predates v11 by a wide margin. "Unknown" is a
        // refusal, not a pass.
        assert!(!protocol_meets_floor(None));
    }

    #[test]
    fn the_floor_requires_remote_project_trust() {
        // If someone bumps EXPECTED without thinking about MINIMUM, this test
        // is the reminder that raising the floor is a deliberate, separate
        // decision — it breaks mixed-version pairings on purpose.
        assert_eq!(MINIMUM_PROTOCOL_VERSION, 12);
        assert!(EXPECTED_PROTOCOL_VERSION >= MINIMUM_PROTOCOL_VERSION);
    }

    #[test]
    fn sidecar_usage_entry_matches_the_in_process_ledger_schema() {
        // The row must parse back as a `UsageEntry` and carry every key the
        // `api_agent.rs` construction sites write — analytics ingests both
        // through the same serde path, so a shape drift here silently drops
        // sidecar spend from the guardrail input.
        let entry = sidecar_usage_entry(
            "claude-oauth",
            "claude-sonnet-4-6",
            "sidecar-sess-1",
            1000,
            500,
            2000,
            3000,
        );
        assert_eq!(entry.source, "api-claude-oauth");
        assert_eq!(entry.model, "claude-sonnet-4-6");
        assert_eq!(entry.agent_id, None);
        assert_eq!(entry.session_id, "sidecar-sess-1");
        // Token counts are stored raw, per the `UsageEntry` contract.
        assert_eq!(
            (
                entry.input_tokens,
                entry.output_tokens,
                entry.cache_read,
                entry.cache_write
            ),
            (1000, 500, 2000, 3000)
        );
        // Anthropic buckets are disjoint: 1000×$3 + 500×$15 + 2000×$0.30 +
        // 3000×$3.75 per MTok.
        assert!(
            (entry.cost_usd - 0.02235).abs() < 1e-9,
            "expected 0.02235, got {}",
            entry.cost_usd
        );

        let line = serde_json::to_string(&entry).expect("serialize");
        let parsed: serde_json::Value = serde_json::from_str(&line).expect("parse");
        for key in [
            "ts",
            "source",
            "model",
            "agent_id",
            "session_id",
            "input_tokens",
            "output_tokens",
            "cache_read",
            "cache_write",
            "cost_usd",
        ] {
            assert!(parsed.get(key).is_some(), "row is missing key {key}");
        }
        let round_trip: crate::commands::usage::UsageEntry =
            serde_json::from_str(&line).expect("round-trip as UsageEntry");
        assert_eq!(round_trip.source, "api-claude-oauth");
    }

    #[test]
    fn sidecar_usage_entry_normalises_openai_superset_prompt_counts() {
        // gpt-5.5 reports `input_tokens` as a superset that already contains
        // the cached reads. The stored row keeps the vendor's raw 1000, but
        // the cost must bill only the 200 uncached prompt tokens: 200×$5 +
        // 200×$15 + 800×$2.50 per MTok.
        let entry = sidecar_usage_entry(
            "openai-agents",
            "gpt-5.5",
            "sidecar-sess-2",
            1000,
            200,
            800,
            0,
        );
        assert_eq!(entry.source, "api-openai-agents");
        assert_eq!(entry.input_tokens, 1000, "raw superset count is stored");
        assert!(
            (entry.cost_usd - 0.006).abs() < 1e-9,
            "expected 0.006, got {}",
            entry.cost_usd
        );
    }

    #[test]
    fn dropped_codex_provider_no_longer_routes_to_the_sidecar() {
        // `openai-codex` was the ChatGPT-subscription `codex exec` row. It is
        // gone from the picker and from the sidecar registry, so a stale
        // persisted conversation must NOT be forwarded to a sidecar that has
        // no factory for it — the frontend's RETIRED_API_AGENTS guard is the
        // user-facing half, and this is the backend half.
        assert!(!is_sidecar_provider("openai-codex"));
    }
}
