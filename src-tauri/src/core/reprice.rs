//! One-time reprice of historical cost figures (the CE2 rate correction).
//!
//! # Why this exists
//!
//! Until commit `073cbf84` (CE2, 2026-07-31) PacketBench's model rate table was
//! wrong in three ways, and every dollar figure it ever stamped on disk
//! inherited the error:
//!
//! * **Claude Opus 4.5–4.8** were priced at `$15/$75` — the rate of the
//!   *deprecated* Opus 4.1. The real rate is `$5/$25`, so recorded Opus spend
//!   is overstated roughly **3x**. Opus is the default model, so this is the
//!   bulk of the damage.
//! * **Claude Haiku 4.5** was priced at `$0.80/$4` — the rate of the *retired*
//!   Haiku 3.5. The real rate is `$1/$5`, so Haiku spend is **understated ~20%**.
//! * **MiniMax M2-family** was priced `$0.40/$2.20` against an official
//!   `$0.30/$1.20`, and a `contains("minimax-m2")` rule additionally swallowed
//!   M2.5 and M2.7 — overstated roughly **1.6x**.
//!
//! CE2 fixed the *table*. It deliberately did not touch stored history,
//! because rewriting a user's own spend record is a product decision rather
//! than a refactor. That decision was taken on 2026-07-31; this module is it.
//!
//! # Why it still matters now that the Cost Dashboard is gone
//!
//! Commit `35dcb54` removed the cost *reporting* surface — there is no
//! dashboard, no live-spend chip, and no dollars in the session meta line. But
//! it deliberately **kept** the cost *safety* mechanism. The stale numbers are
//! therefore not merely cosmetic; they are the inputs to a hard stop:
//!
//! ```text
//! usage.jsonl `cost_usd`
//!   → commands::analytics::read_usage_analytics (daily / monthly / per-provider totals)
//!     → costGuardrailStore::assertCostGuardrailsAllowLaunch
//!       → throws, blocking the launch, when a configured cap is exceeded
//! ```
//!
//! A 3x-overstated Opus history makes a daily or monthly budget cap fire at
//! roughly a *third* of the spend the user actually authorised. Repricing is
//! what stops the guardrail from locking the user out of their own app.
//!
//! Persisted conversation `costUsd` values are also repriced. Session budget
//! admission uses these stamped prices as a fallback to the durable usage ledger.
//!
//! # Contract
//!
//! * **Recompute from tokens, never scale dollars.** Every rewritten value is
//!   derived from the record's own stored token counts through the shared
//!   table in `shared/model-pricing.json`. A record that does not carry enough
//!   token detail is left exactly as it is and counted as skipped.
//! * **Price each record at its own date.** `pricing::calculate_cost_at` is
//!   called with the date the record was written, so a row that predates a
//!   scheduled rate change (Claude Sonnet 5's introductory window ends
//!   2026-08-31) keeps that era's rate. Today's rates are never applied
//!   uniformly.
//! * **Reproduce the writer's arithmetic exactly.** The two artifacts were
//!   priced by two different call paths, and each is repriced through the same
//!   arithmetic its writer used — only with the corrected table and the
//!   record's own date. See `reprice_ledger` and `reprice_conversations`.
//! * **Back up before writing.** `usage.jsonl.pre-reprice-<date>` and
//!   `conversations.pre-reprice-<date>/`, never overwritten, never deleted.
//! * **Mark the boundary.** Rewritten records carry `repriced_at` /
//!   `repricedAt` plus the prior value in `cost_usd_before` / `costUsdBefore`.
//!   Records whose value did not change are not marked and not rewritten.
//! * **Idempotent.** The per-record marker is the real guard; the
//!   `PersistedState::cost_reprice_v1_at` flag is only a fast path so a mature
//!   ledger isn't rescanned every launch.
//! * **Safe on a fresh install.** If neither artifact exists the pass returns
//!   before touching anything — in particular without creating a state file.
//!
//! # Deliberately NOT repriced
//!
//! The flight-side dollar fields in `state.v1.json` — `flights[].total_cost`,
//! `attempts[].cost`, `milestones[].tasks[].cost`, `planner_cost`, and
//! `autonomy_runtime.action_history[].cost` — are running sums accompanied
//! only by a single collapsed `tokens` total (input + output + cache-read +
//! cache-write added together), with no per-class split and no per-turn model
//! or timestamp. Recomputing them would require inventing an input/output
//! ratio, which the contract above forbids. They are reported, not guessed.
//! (`storage::save_flights` also merges `total_cost` with `max()`, so a
//! lowered value would be pushed back up by the next frontend snapshot
//! anyway.) The practical consequence: a **per-flight** budget cap can still
//! trip early on a flight whose spend predates CE2.
//!
//! Also untouched: `localStorage["packetbench:cost-guardrails"]` (those dollars
//! are user-authored *limits*, not recorded spend) and the orphaned
//! `conversations/<id>/checkpoints/*.json` snapshots.
//!
//! Those snapshots are stale code's leftovers but real user data. The
//! CheckpointPanel's "Save now" button shipped from **0.5.0** (2026-05-04)
//! through **0.9.4** and wrote one file per click; 0.10.0 replaced the panel
//! with inline Restore (`0c4de9c0`), and `commands/checkpoints.rs` — the last
//! code that could read one back — was deleted on 2026-08-29 (`e8aa573c`). So
//! there is no live writer or reader *now*, but `migration::migrate_data_dir`
//! renames the whole tree forward on each rebrand, which means an install that
//! ran any of those releases still carries its snapshots under
//! `~/.packetbench` today. Repricing them would rewrite user data that no
//! reader will ever consult again, so they are left byte-for-byte as they are.

use serde_json::{Map, Value};
use std::path::{Path, PathBuf};
use tracing::{info, warn};

use crate::commands::pricing;
use crate::commands::usage;

/// Per-artifact tally, logged after the pass and asserted by the tests.
#[derive(Debug, Default, Clone, PartialEq)]
pub struct RepriceStats {
    /// Records examined (excludes blank lines / non-record files).
    pub scanned: u64,
    /// Records whose stored dollar figure was rewritten.
    pub repriced: u64,
    /// Records that recomputed to the value already stored (e.g. Sonnet,
    /// whose rate CE2 did not change). Not marked, not rewritten.
    pub unchanged: u64,
    /// Records already carrying a reprice marker from an earlier run.
    pub already_marked: u64,
    /// Model id absent, or not present in the shared table on that date.
    pub skipped_unknown_model: u64,
    /// Not enough stored token detail to recompute the figure.
    pub skipped_no_tokens: u64,
    /// No usable timestamp, so the record cannot be priced at its own date.
    pub skipped_no_date: u64,
    /// Line/file that did not parse as JSON. Preserved byte-for-byte.
    pub skipped_malformed: u64,
    /// Sum of the stored figures across the records that were rewritten.
    pub before_usd: f64,
    /// Sum of the recomputed figures across the records that were rewritten.
    pub after_usd: f64,
}

impl RepriceStats {
    fn touched(&self) -> bool {
        self.repriced > 0
    }
}

/// Costs are fractions of a cent; anything under this is the same number.
/// (Recomputation is bit-deterministic, so in practice the delta is either 0
/// or large — this only guards against a formula that reassociates.)
const EPSILON_USD: f64 = 1e-12;

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/// Run the one-time reprice, if it has not already run on this install.
///
/// Best-effort: every failure is logged and swallowed so a bad ledger can
/// never block app startup. Called once from `lib::run`, after
/// `migrate_data_dir` (so the data directory has settled) and before the Tauri
/// builder starts — nothing is writing either artifact at that point.
pub fn reprice_historical_costs() {
    let Some(ledger) = usage::usage_log_path() else {
        return;
    };
    let Ok(conversations) = crate::commands::conversations::conversations_dir() else {
        return;
    };
    run_reprice(&ledger, &conversations);
}

/// Testable core. Paths are injected so the tests can drive a tempdir; the
/// `PersistedState` flag is read/written through `storage`, which the tests
/// redirect with `redirect_data_dir_for_test`.
fn run_reprice(ledger: &Path, conversations: &Path) -> Option<(RepriceStats, RepriceStats)> {
    // Fresh install: no ledger, no conversations, nothing to do. Return BEFORE
    // touching `storage`, so we never create a state file on a clean machine.
    if !ledger.exists() && !conversations.exists() {
        return None;
    }

    if let Some(at) = crate::core::storage::load_state().cost_reprice_v1_at {
        // Already done. The per-record markers would make a rerun a no-op
        // anyway; this just avoids rescanning a large ledger every launch.
        info!(repriced_at = %at, "Historical cost reprice already applied; skipping");
        return None;
    }

    // A retained write journal refers to exact ledger bytes and offsets.
    // Startup migration must preserve that evidence until accounting is repaired.
    if let Err(error) = usage::read_usage_ledger(ledger) {
        warn!(%error, "Historical cost reprice deferred until usage accounting is reconciled");
        return None;
    }

    let now = usage::current_timestamp_iso();
    let date = now.chars().take(10).collect::<String>();

    let ledger_stats = match reprice_ledger(ledger, &now, &date) {
        Ok(stats) => stats,
        Err(e) => {
            warn!(error = %e, "Historical cost reprice: ledger pass failed; leaving it untouched");
            RepriceStats::default()
        }
    };
    let conv_stats = match reprice_conversations(conversations, &now, &date) {
        Ok(stats) => stats,
        Err(e) => {
            warn!(error = %e, "Historical cost reprice: conversation pass failed; leaving them untouched");
            RepriceStats::default()
        }
    };

    info!(
        ledger_scanned = ledger_stats.scanned,
        ledger_repriced = ledger_stats.repriced,
        ledger_unchanged = ledger_stats.unchanged,
        ledger_skipped_unknown_model = ledger_stats.skipped_unknown_model,
        ledger_skipped_no_tokens = ledger_stats.skipped_no_tokens,
        ledger_skipped_no_date = ledger_stats.skipped_no_date,
        ledger_skipped_malformed = ledger_stats.skipped_malformed,
        ledger_before_usd = ledger_stats.before_usd,
        ledger_after_usd = ledger_stats.after_usd,
        messages_scanned = conv_stats.scanned,
        messages_repriced = conv_stats.repriced,
        messages_unchanged = conv_stats.unchanged,
        messages_skipped_unknown_model = conv_stats.skipped_unknown_model,
        messages_skipped_no_tokens = conv_stats.skipped_no_tokens,
        messages_before_usd = conv_stats.before_usd,
        messages_after_usd = conv_stats.after_usd,
        "Historical cost reprice complete (CE2 rate correction). \
         Flight rollups in state.v1.json are NOT repriced: they store a collapsed \
         token total with no per-class split, so they cannot be recomputed without guessing."
    );

    if let Err(e) = crate::core::storage::update_state(|state| {
        state.cost_reprice_v1_at = Some(now.clone());
    }) {
        // Not fatal: the per-record markers keep a rerun idempotent, we would
        // just rescan next launch.
        warn!(error = %e, "Failed to persist the cost-reprice marker; the pass will rescan next launch");
    }

    Some((ledger_stats, conv_stats))
}

// ---------------------------------------------------------------------------
// Backups
// ---------------------------------------------------------------------------

/// Pick a `<name>.pre-reprice-<date>` sibling that does not already exist, so
/// a backup is never overwritten (and never deleted — recovery beats tidiness).
fn backup_target(original: &Path, suffix: &str) -> Result<PathBuf, String> {
    let name = original
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or_else(|| format!("unusable path {}", original.display()))?;
    let parent = original
        .parent()
        .ok_or_else(|| format!("no parent for {}", original.display()))?;
    let base = parent.join(format!("{}.pre-reprice-{}", name, suffix));
    if !base.exists() {
        return Ok(base);
    }
    for n in 2..100 {
        let candidate = parent.join(format!("{}.pre-reprice-{}-{}", name, suffix, n));
        if !candidate.exists() {
            return Ok(candidate);
        }
    }
    Err(format!(
        "could not find a free backup name next to {}",
        original.display()
    ))
}

/// Write `contents` to `path` via a sibling temp file + rename, so a crash
/// mid-write cannot leave a half-rewritten ledger.
///
/// The suffix is *appended* rather than replacing the extension, so the temp
/// file for `usage.jsonl` is `usage.jsonl.reprice-tmp` and cannot collide with
/// a real artifact. A leftover temp (crash between write and rename) is inert:
/// `load_conversations` only reads `*.json`, and the ledger is read by name.
fn write_atomic(path: &Path, contents: &str) -> Result<(), String> {
    let mut tmp = path.as_os_str().to_os_string();
    tmp.push(".reprice-tmp");
    let tmp = PathBuf::from(tmp);
    std::fs::write(&tmp, contents).map_err(|e| format!("write {}: {}", tmp.display(), e))?;
    std::fs::rename(&tmp, path).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        format!("rename into {}: {}", path.display(), e)
    })
}

// ---------------------------------------------------------------------------
// Pass 1 — the usage ledger
// ---------------------------------------------------------------------------

/// Reprice `~/.packetbench/usage.jsonl` in place.
///
/// **Arithmetic.** The three writers in `commands::api_agent` stamp
/// `cost_usd = pricing::calculate_cost(model, billable_input_tokens(...),
/// output_tokens, cache_read, cache_write)` — an additive sum over four
/// disjoint buckets, with the whole cache-write total billed at the 5-minute
/// TTL. This pass computes the same thing, changing exactly two things: the
/// table is now correct, and the date is the record's own `ts` rather than
/// "today".
///
/// The `billable_input_tokens` step matters. A `UsageEntry` stores the vendor's
/// **raw** numbers, and OpenAI-family endpoints report `prompt_tokens` as a
/// superset that already contains the cached reads — so pricing the stored
/// `input_tokens` and `cache_read` as if they were disjoint double-counts the
/// cache. The shared table records which vendors do this as
/// `inputIncludesCacheRead`, and rows for those vendors have the cached reads
/// subtracted before pricing, exactly as the live writer now does. (This is
/// CE1; historical OpenAI rows predate it, so they get both corrections at
/// once. That is deliberate — it leaves history and new rows on one
/// convention.) The subtraction is driven by the rate row resolved for the
/// record's own date, so it stays date-aware like everything else here.
///
/// Lines are rewritten only when the figure actually changes; every other line
/// (blank, malformed, unchanged, skipped) is emitted byte-for-byte as read.
fn reprice_ledger(path: &Path, now_iso: &str, today: &str) -> Result<RepriceStats, String> {
    let mut stats = RepriceStats::default();
    if !path.exists() {
        return Ok(stats);
    }
    let raw =
        std::fs::read_to_string(path).map_err(|e| format!("read {}: {}", path.display(), e))?;

    let mut out: Vec<String> = Vec::new();
    for line in raw.lines() {
        if line.trim().is_empty() {
            out.push(line.to_string());
            continue;
        }
        let mut value: Value = match serde_json::from_str(line) {
            Ok(v) => v,
            Err(_) => {
                stats.skipped_malformed += 1;
                out.push(line.to_string());
                continue;
            }
        };
        let Some(obj) = value.as_object_mut() else {
            stats.skipped_malformed += 1;
            out.push(line.to_string());
            continue;
        };
        stats.scanned += 1;

        if obj.contains_key("repriced_at") {
            stats.already_marked += 1;
            out.push(line.to_string());
            continue;
        }
        let Some(old) = obj.get("cost_usd").and_then(Value::as_f64) else {
            // Not a cost-bearing record.
            stats.skipped_no_tokens += 1;
            out.push(line.to_string());
            continue;
        };
        let Some(date) = obj.get("ts").and_then(Value::as_str).and_then(iso_date) else {
            stats.skipped_no_date += 1;
            out.push(line.to_string());
            continue;
        };
        let Some(model) = obj.get("model").and_then(Value::as_str).map(str::to_string) else {
            stats.skipped_unknown_model += 1;
            out.push(line.to_string());
            continue;
        };
        // Every writer emits all four buckets, so requiring all four is the
        // right strictness: a record missing any of them predates the current
        // shape and cannot be recomputed honestly.
        let buckets = ["input_tokens", "output_tokens", "cache_read", "cache_write"];
        if !buckets
            .iter()
            .all(|k| obj.get(*k).map(Value::is_u64).unwrap_or(false))
        {
            stats.skipped_no_tokens += 1;
            out.push(line.to_string());
            continue;
        }
        // Unknown model: `calculate_cost_at` would return 0.0, which would
        // silently erase a real recorded figure. Leave it alone.
        let Some(rates) = pricing::pricing_for_at(&model, &date) else {
            stats.skipped_unknown_model += 1;
            out.push(line.to_string());
            continue;
        };
        let u = |k: &str| obj.get(k).and_then(Value::as_u64).unwrap_or(0);
        let cache_read = u("cache_read");
        let input = if rates.input_includes_cache_read {
            u("input_tokens").saturating_sub(cache_read)
        } else {
            u("input_tokens")
        };
        let new = pricing::calculate_cost_at(
            &model,
            &date,
            input,
            u("output_tokens"),
            cache_read,
            u("cache_write"),
            0,
        );

        if (new - old).abs() <= EPSILON_USD {
            stats.unchanged += 1;
            out.push(line.to_string());
            continue;
        }

        obj.insert("cost_usd".to_string(), json_f64(new));
        obj.insert("cost_usd_before".to_string(), json_f64(old));
        obj.insert(
            "repriced_at".to_string(),
            Value::String(now_iso.to_string()),
        );
        stats.repriced += 1;
        stats.before_usd += old;
        stats.after_usd += new;
        out.push(serde_json::to_string(&value).map_err(|e| format!("reserialize record: {}", e))?);
    }

    if !stats.touched() {
        return Ok(stats);
    }

    let backup = backup_target(path, today)?;
    std::fs::copy(path, &backup)
        .map_err(|e| format!("back up {} to {}: {}", path.display(), backup.display(), e))?;
    info!(backup = %backup.display(), "Backed up usage ledger before repricing");

    let mut contents = out.join("\n");
    if !contents.is_empty() {
        contents.push('\n');
    }
    write_atomic(path, &contents)?;
    Ok(stats)
}

// ---------------------------------------------------------------------------
// Pass 2 — persisted conversation messages
// ---------------------------------------------------------------------------

/// Reprice `messages[].costUsd` across `~/.packetbench/conversations/*.json`.
///
/// **Arithmetic.** These figures were stamped by `estimateTurnCostUsd` in
/// `src/lib/conversationCost.ts`, whose `costForTurn` differs from the ledger
/// path in two ways that must be reproduced exactly:
///
/// * reasoning tokens bill at the **output** rate and are added to `output`;
/// * when the table marks the vendor `inputIncludesCacheRead` (OpenAI), the
///   cached reads are **subtracted** from the reported prompt tokens before
///   pricing, because the cost primitive is additive over disjoint buckets.
///
/// The model lives once per conversation (`AgentConversation.model`), not per
/// message; a conversation whose model was switched mid-thread therefore
/// reprices every turn at the latest model. This is a historical migration
/// limitation; current session admission prefers already stamped turn prices.
///
/// Only top-level `*.json` files are considered — the same single-level,
/// files-only shape `load_conversations` reads, so the pass sees exactly the
/// documents the app itself sees. Subdirectories are skipped structurally
/// rather than by name; the only thing that ever created one was the retired
/// checkpoint writer, whose snapshots are deliberately out of scope (see the
/// module header).
fn reprice_conversations(dir: &Path, now_iso: &str, today: &str) -> Result<RepriceStats, String> {
    let mut stats = RepriceStats::default();
    if !dir.exists() {
        return Ok(stats);
    }
    let entries =
        std::fs::read_dir(dir).map_err(|e| format!("read dir {}: {}", dir.display(), e))?;

    let mut backup_dir: Option<PathBuf> = None;
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        if path
            .extension()
            .and_then(|e| e.to_str())
            .map(|e| !e.eq_ignore_ascii_case("json"))
            .unwrap_or(true)
        {
            continue;
        }
        let raw = match std::fs::read_to_string(&path) {
            Ok(raw) => raw,
            Err(e) => {
                warn!(path = %path.display(), error = %e, "Reprice: unreadable conversation, skipping");
                continue;
            }
        };
        let mut value: Value = match serde_json::from_str(&raw) {
            Ok(v) => v,
            Err(_) => {
                stats.skipped_malformed += 1;
                continue;
            }
        };
        let changed = reprice_conversation_value(&mut value, now_iso, &mut stats);
        if !changed {
            continue;
        }

        // Back up the untouched original before the first rewrite.
        let backup_root = match &backup_dir {
            Some(d) => d.clone(),
            None => {
                let d = backup_target(dir, today)?;
                std::fs::create_dir_all(&d)
                    .map_err(|e| format!("create {}: {}", d.display(), e))?;
                info!(backup = %d.display(), "Backing up conversations before repricing");
                backup_dir = Some(d.clone());
                d
            }
        };
        let name = path.file_name().unwrap_or_default();
        std::fs::copy(&path, backup_root.join(name))
            .map_err(|e| format!("back up {}: {}", path.display(), e))?;

        let serialized = serde_json::to_string(&value)
            .map_err(|e| format!("reserialize conversation: {}", e))?;
        write_atomic(&path, &serialized)?;
    }
    Ok(stats)
}

/// Reprice one conversation document in place. Returns whether anything
/// changed.
fn reprice_conversation_value(value: &mut Value, now_iso: &str, stats: &mut RepriceStats) -> bool {
    let Some(obj) = value.as_object_mut() else {
        return false;
    };
    let model = obj.get("model").and_then(Value::as_str).map(str::to_string);
    let Some(messages) = obj.get_mut("messages").and_then(Value::as_array_mut) else {
        return false;
    };

    let mut changed = false;
    for message in messages.iter_mut() {
        let Some(m) = message.as_object_mut() else {
            continue;
        };
        // Only messages that actually carry a stored dollar figure are in
        // scope; user messages and unpriced turns have none.
        let Some(old) = m.get("costUsd").and_then(Value::as_f64) else {
            continue;
        };
        stats.scanned += 1;

        if m.contains_key("repricedAt") {
            stats.already_marked += 1;
            continue;
        }
        let Some(model) = model.as_deref() else {
            stats.skipped_unknown_model += 1;
            continue;
        };
        let Some(ts) = m.get("timestamp").and_then(Value::as_u64) else {
            stats.skipped_no_date += 1;
            continue;
        };
        // The estimator treats each token field as optional (`?? 0`), so at
        // least one must be present for the recomputation to mean anything.
        let fields = [
            "inputTokens",
            "outputTokens",
            "cacheReadTokens",
            "cacheWriteTokens",
            "reasoningTokens",
        ];
        if !fields
            .iter()
            .any(|k| m.get(*k).map(Value::is_u64) == Some(true))
        {
            stats.skipped_no_tokens += 1;
            continue;
        }
        let date = usage::iso_date_from_millis(ts);
        let Some(rates) = pricing::pricing_for_at(model, &date) else {
            stats.skipped_unknown_model += 1;
            continue;
        };

        let u = |m: &Map<String, Value>, k: &str| m.get(k).and_then(Value::as_u64).unwrap_or(0);
        let raw_input = u(m, "inputTokens");
        let cache_read = u(m, "cacheReadTokens");
        let input = if rates.input_includes_cache_read {
            raw_input.saturating_sub(cache_read)
        } else {
            raw_input
        };
        let output = u(m, "outputTokens").saturating_add(u(m, "reasoningTokens"));
        let new = pricing::calculate_cost_at(
            model,
            &date,
            input,
            output,
            cache_read,
            u(m, "cacheWriteTokens"),
            0,
        );

        if (new - old).abs() <= EPSILON_USD {
            stats.unchanged += 1;
            continue;
        }
        m.insert("costUsd".to_string(), json_f64(new));
        m.insert("costUsdBefore".to_string(), json_f64(old));
        m.insert("repricedAt".to_string(), Value::String(now_iso.to_string()));
        stats.repriced += 1;
        stats.before_usd += old;
        stats.after_usd += new;
        changed = true;
    }
    changed
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/// Extract the `YYYY-MM-DD` prefix of an ISO 8601 timestamp, validating the
/// shape so a garbage `ts` cannot silently select the wrong rate window.
fn iso_date(ts: &str) -> Option<String> {
    if ts.len() < 10 || !ts.is_char_boundary(10) {
        return None;
    }
    let head = &ts[..10];
    let bytes = head.as_bytes();
    let digits_ok = |i: usize| bytes[i].is_ascii_digit();
    let shaped = (0..4).all(digits_ok)
        && bytes[4] == b'-'
        && (5..7).all(digits_ok)
        && bytes[7] == b'-'
        && (8..10).all(digits_ok);
    shaped.then(|| head.to_string())
}

/// `serde_json::Number` rejects NaN/inf; a non-finite cost falls back to 0.0
/// rather than panicking the migration.
fn json_f64(v: f64) -> Value {
    serde_json::Number::from_f64(v)
        .map(Value::Number)
        .unwrap_or_else(|| Value::Number(serde_json::Number::from(0)))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const NOW: &str = "2026-07-31T12:00:00Z";
    const TODAY: &str = "2026-07-31";

    fn tmpdir(label: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "packetbench-reprice-{}-{}-{:?}",
            label,
            std::process::id(),
            std::thread::current().id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("create tempdir");
        dir
    }

    fn ledger_line(model: &str, ts: &str, input: u64, output: u64, cost: f64) -> String {
        serde_json::to_string(&json!({
            "ts": ts,
            "source": "packetbench-api",
            "model": model,
            "agent_id": null,
            "session_id": "s-1",
            "input_tokens": input,
            "output_tokens": output,
            "cache_read": 0,
            "cache_write": 0,
            "cost_usd": cost,
        }))
        .unwrap()
    }

    fn read_lines(path: &Path) -> Vec<Value> {
        std::fs::read_to_string(path)
            .unwrap()
            .lines()
            .filter(|l| !l.trim().is_empty())
            .map(|l| serde_json::from_str(l).unwrap())
            .collect()
    }

    // -- the three headline rate corrections -------------------------------

    /// Opus was billed at the deprecated 4.1 rate ($15/$75); the real rate is
    /// $5/$25, so 1M in + 1M out drops from $90 to $30 — the 3x overstatement.
    #[test]
    fn reprices_opus_down_by_three_x() {
        let dir = tmpdir("opus");
        let path = dir.join("usage.jsonl");
        std::fs::write(
            &path,
            format!(
                "{}\n",
                ledger_line(
                    "claude-opus-4-8",
                    "2026-06-01T10:00:00Z",
                    1_000_000,
                    1_000_000,
                    90.0
                )
            ),
        )
        .unwrap();

        let stats = reprice_ledger(&path, NOW, TODAY).unwrap();
        assert_eq!(stats.repriced, 1);
        assert_eq!(stats.scanned, 1);

        let rows = read_lines(&path);
        assert_eq!(rows[0]["cost_usd"].as_f64().unwrap(), 30.0);
        assert_eq!(rows[0]["cost_usd_before"].as_f64().unwrap(), 90.0);
        assert_eq!(rows[0]["repriced_at"].as_str().unwrap(), NOW);
        std::fs::remove_dir_all(&dir).ok();
    }

    /// Haiku 4.5 was billed at the retired 3.5 rate ($0.80/$4); the real rate
    /// is $1/$5, so the figure goes UP ~25% — the migration must be able to
    /// raise a value, not just lower it.
    #[test]
    fn reprices_haiku_up() {
        let dir = tmpdir("haiku");
        let path = dir.join("usage.jsonl");
        std::fs::write(
            &path,
            format!(
                "{}\n",
                ledger_line(
                    "claude-haiku-4-5",
                    "2026-06-01T10:00:00Z",
                    1_000_000,
                    1_000_000,
                    4.8
                )
            ),
        )
        .unwrap();

        let stats = reprice_ledger(&path, NOW, TODAY).unwrap();
        assert_eq!(stats.repriced, 1);
        let rows = read_lines(&path);
        assert_eq!(rows[0]["cost_usd"].as_f64().unwrap(), 6.0);
        assert_eq!(rows[0]["cost_usd_before"].as_f64().unwrap(), 4.8);
        assert!(
            stats.after_usd > stats.before_usd,
            "Haiku spend was understated"
        );
        std::fs::remove_dir_all(&dir).ok();
    }

    /// MiniMax M2 was $0.40/$2.20 against an official $0.30/$1.20, and the
    /// `contains("minimax-m2")` rule swallowed M2.7 too. Both reprice to the
    /// official rate: 1M + 1M = $2.60 → $1.50.
    #[test]
    fn reprices_minimax_family_including_m2_7() {
        let dir = tmpdir("minimax");
        let path = dir.join("usage.jsonl");
        std::fs::write(
            &path,
            format!(
                "{}\n{}\n",
                ledger_line(
                    "MiniMax-M2",
                    "2026-06-01T10:00:00Z",
                    1_000_000,
                    1_000_000,
                    2.6
                ),
                ledger_line(
                    "MiniMax-M2.7",
                    "2026-06-01T10:00:00Z",
                    1_000_000,
                    1_000_000,
                    2.6
                ),
            ),
        )
        .unwrap();

        let stats = reprice_ledger(&path, NOW, TODAY).unwrap();
        assert_eq!(stats.repriced, 2);
        let rows = read_lines(&path);
        for row in &rows {
            assert!(
                (row["cost_usd"].as_f64().unwrap() - 1.5).abs() < 1e-9,
                "expected $1.50, got {}",
                row["cost_usd"]
            );
        }
        std::fs::remove_dir_all(&dir).ok();
    }

    /// A `UsageEntry` stores the vendor's raw numbers, and OpenAI's
    /// `prompt_tokens` already contains its cached reads. Pricing the stored
    /// buckets as disjoint would double-count the cache. gpt-5: 1M prompt of
    /// which 400k cached → 600k fresh @ $5 + 400k cached @ $2.50 = $4.00, not
    /// the $6.00 a naive additive sum gives.
    #[test]
    fn subtracts_cached_reads_for_vendors_that_report_a_superset() {
        let dir = tmpdir("openai-ledger");
        let path = dir.join("usage.jsonl");
        let line = serde_json::to_string(&json!({
            "ts": "2026-06-01T10:00:00Z",
            "source": "packetbench-api",
            "model": "gpt-5",
            "agent_id": null,
            "session_id": "s-1",
            "input_tokens": 1_000_000,
            "output_tokens": 0,
            "cache_read": 400_000,
            "cache_write": 0,
            "cost_usd": 6.0,
        }))
        .unwrap();
        std::fs::write(&path, format!("{line}\n")).unwrap();

        let stats = reprice_ledger(&path, NOW, TODAY).unwrap();
        assert_eq!(stats.repriced, 1);
        let rows = read_lines(&path);
        assert!(
            (rows[0]["cost_usd"].as_f64().unwrap() - 4.0).abs() < 1e-9,
            "expected $4.00, got {}",
            rows[0]["cost_usd"]
        );
        // The stored token counts are the vendor's own and must not be rewritten.
        assert_eq!(rows[0]["input_tokens"].as_u64().unwrap(), 1_000_000);
        assert_eq!(rows[0]["cache_read"].as_u64().unwrap(), 400_000);
        std::fs::remove_dir_all(&dir).ok();
    }

    /// Anthropic's buckets are already disjoint, so nothing is subtracted:
    /// Opus 4.8 with 1M fresh input + 1M cache read = $5 + $0.50 = $5.50.
    #[test]
    fn leaves_disjoint_vendor_buckets_alone() {
        let dir = tmpdir("anthropic-ledger");
        let path = dir.join("usage.jsonl");
        let line = serde_json::to_string(&json!({
            "ts": "2026-06-01T10:00:00Z",
            "source": "packetbench-api",
            "model": "claude-opus-4-8",
            "agent_id": null,
            "session_id": "s-1",
            "input_tokens": 1_000_000,
            "output_tokens": 0,
            "cache_read": 1_000_000,
            "cache_write": 0,
            "cost_usd": 16.5,
        }))
        .unwrap();
        std::fs::write(&path, format!("{line}\n")).unwrap();

        reprice_ledger(&path, NOW, TODAY).unwrap();
        let rows = read_lines(&path);
        assert!(
            (rows[0]["cost_usd"].as_f64().unwrap() - 5.5).abs() < 1e-9,
            "expected $5.50, got {}",
            rows[0]["cost_usd"]
        );
        std::fs::remove_dir_all(&dir).ok();
    }

    // -- date-aware selection ----------------------------------------------

    /// Sonnet 5 is $2/$10 through 2026-08-31 and $3/$15 from 2026-09-01. A row
    /// dated inside the introductory window must keep that era's rate even
    /// though the pass itself runs later, and a row dated after it must not.
    #[test]
    fn prices_each_record_at_its_own_date() {
        let dir = tmpdir("dated");
        let path = dir.join("usage.jsonl");
        std::fs::write(
            &path,
            format!(
                "{}\n{}\n",
                ledger_line(
                    "claude-sonnet-5",
                    "2026-08-15T10:00:00Z",
                    1_000_000,
                    0,
                    15.0
                ),
                ledger_line(
                    "claude-sonnet-5",
                    "2026-09-15T10:00:00Z",
                    1_000_000,
                    0,
                    15.0
                ),
            ),
        )
        .unwrap();

        // Run "today" well after the rollover to prove the date used is the
        // record's, not the run's.
        let stats = reprice_ledger(&path, "2026-12-01T00:00:00Z", "2026-12-01").unwrap();
        assert_eq!(stats.repriced, 2);
        let rows = read_lines(&path);
        assert_eq!(
            rows[0]["cost_usd"].as_f64().unwrap(),
            2.0,
            "introductory window"
        );
        assert_eq!(rows[1]["cost_usd"].as_f64().unwrap(), 3.0, "post-rollover");
        std::fs::remove_dir_all(&dir).ok();
    }

    // -- skip rather than corrupt ------------------------------------------

    #[test]
    fn skips_records_without_the_tokens_to_recompute() {
        let dir = tmpdir("skip");
        let path = dir.join("usage.jsonl");
        // Missing every token bucket, plus an unknown model, plus a malformed
        // line, plus an unusable timestamp.
        let no_tokens = r#"{"ts":"2026-06-01T10:00:00Z","source":"x","model":"claude-opus-4-8","session_id":"s","cost_usd":9.0}"#;
        let unknown_model = ledger_line(
            "some-unreleased-model",
            "2026-06-01T10:00:00Z",
            100,
            100,
            7.0,
        );
        let bad_ts = ledger_line("claude-opus-4-8", "nope", 1_000_000, 1_000_000, 90.0);
        let malformed = "{not json";
        std::fs::write(
            &path,
            format!("{no_tokens}\n{unknown_model}\n{bad_ts}\n{malformed}\n"),
        )
        .unwrap();
        let before = std::fs::read_to_string(&path).unwrap();

        let stats = reprice_ledger(&path, NOW, TODAY).unwrap();
        assert_eq!(stats.repriced, 0);
        assert_eq!(stats.skipped_no_tokens, 1);
        assert_eq!(stats.skipped_unknown_model, 1);
        assert_eq!(stats.skipped_no_date, 1);
        assert_eq!(stats.skipped_malformed, 1);
        assert_eq!(
            std::fs::read_to_string(&path).unwrap(),
            before,
            "nothing was rewritten, so the file must be byte-identical"
        );
        assert!(
            !dir.join(format!("usage.jsonl.pre-reprice-{TODAY}"))
                .exists(),
            "no backup when nothing changed"
        );
        std::fs::remove_dir_all(&dir).ok();
    }

    /// Sonnet 4.6's rate was already correct, so its rows recompute to the
    /// stored value: no marker, no rewrite, no backup.
    #[test]
    fn leaves_already_correct_records_unmarked() {
        let dir = tmpdir("unchanged");
        let path = dir.join("usage.jsonl");
        std::fs::write(
            &path,
            format!(
                "{}\n",
                ledger_line(
                    "claude-sonnet-4-6",
                    "2026-06-01T10:00:00Z",
                    1_000_000,
                    1_000_000,
                    18.0
                )
            ),
        )
        .unwrap();
        let before = std::fs::read_to_string(&path).unwrap();

        let stats = reprice_ledger(&path, NOW, TODAY).unwrap();
        assert_eq!(stats.unchanged, 1);
        assert_eq!(stats.repriced, 0);
        assert_eq!(std::fs::read_to_string(&path).unwrap(), before);
        std::fs::remove_dir_all(&dir).ok();
    }

    // -- backups + idempotency ---------------------------------------------

    #[test]
    fn backs_up_before_writing_and_is_idempotent() {
        let dir = tmpdir("idempotent");
        let path = dir.join("usage.jsonl");
        let original = format!(
            "{}\n{}\n",
            ledger_line(
                "claude-opus-4-8",
                "2026-06-01T10:00:00Z",
                1_000_000,
                1_000_000,
                90.0
            ),
            ledger_line(
                "claude-sonnet-4-6",
                "2026-06-02T10:00:00Z",
                1_000_000,
                1_000_000,
                18.0
            ),
        );
        std::fs::write(&path, &original).unwrap();

        let first = reprice_ledger(&path, NOW, TODAY).unwrap();
        assert_eq!(first.repriced, 1);
        let backup = dir.join(format!("usage.jsonl.pre-reprice-{TODAY}"));
        assert!(
            backup.exists(),
            "backup must exist before the rewrite lands"
        );
        assert_eq!(
            std::fs::read_to_string(&backup).unwrap(),
            original,
            "backup must be the untouched original"
        );
        let after_first = std::fs::read_to_string(&path).unwrap();

        // Second run: the marker short-circuits, nothing is rewritten, and the
        // existing backup is neither overwritten nor duplicated.
        let second = reprice_ledger(&path, "2026-08-01T00:00:00Z", "2026-08-01").unwrap();
        assert_eq!(second.repriced, 0);
        assert_eq!(second.already_marked, 1);
        assert_eq!(second.unchanged, 1);
        assert_eq!(std::fs::read_to_string(&path).unwrap(), after_first);
        assert_eq!(std::fs::read_to_string(&backup).unwrap(), original);
        assert!(!dir.join("usage.jsonl.pre-reprice-2026-08-01").exists());

        // And the value is still the once-repriced one, not re-derived twice.
        let rows = read_lines(&path);
        assert_eq!(rows[0]["cost_usd"].as_f64().unwrap(), 30.0);
        assert_eq!(rows[0]["cost_usd_before"].as_f64().unwrap(), 90.0);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn never_overwrites_an_existing_backup() {
        let dir = tmpdir("backup-collision");
        let path = dir.join("usage.jsonl");
        std::fs::write(
            &path,
            format!(
                "{}\n",
                ledger_line(
                    "claude-opus-4-8",
                    "2026-06-01T10:00:00Z",
                    1_000_000,
                    1_000_000,
                    90.0
                )
            ),
        )
        .unwrap();
        let squatter = dir.join(format!("usage.jsonl.pre-reprice-{TODAY}"));
        std::fs::write(&squatter, "PRECIOUS").unwrap();

        reprice_ledger(&path, NOW, TODAY).unwrap();
        assert_eq!(std::fs::read_to_string(&squatter).unwrap(), "PRECIOUS");
        assert!(dir
            .join(format!("usage.jsonl.pre-reprice-{TODAY}-2"))
            .exists());
        std::fs::remove_dir_all(&dir).ok();
    }

    // -- conversations ------------------------------------------------------

    fn conversation(model: &str, message: Value) -> Value {
        json!({
            "id": "c-1",
            "title": "t",
            "agent": "api-claude",
            "projectPath": "/p",
            "status": "idle",
            "mode": "api",
            "model": model,
            "sessionId": null,
            "rawOutput": "",
            "createdAt": 1_780_000_000_000u64,
            "updatedAt": 1_780_000_000_000u64,
            "messages": [message],
        })
    }

    /// 2026-06-01T00:00:00Z in ms.
    const JUNE_MS: u64 = 1_780_272_000_000;

    #[test]
    fn reprices_conversation_messages_from_tokens() {
        let dir = tmpdir("conv");
        let convs = dir.join("conversations");
        std::fs::create_dir_all(&convs).unwrap();
        std::fs::write(
            convs.join("c-1.json"),
            serde_json::to_string(&conversation(
                "claude-opus-4-8",
                json!({
                    "id": "m-1",
                    "role": "assistant",
                    "content": "hi",
                    "timestamp": JUNE_MS,
                    "inputTokens": 1_000_000,
                    "outputTokens": 1_000_000,
                    "costUsd": 90.0,
                }),
            ))
            .unwrap(),
        )
        .unwrap();

        let stats = reprice_conversations(&convs, NOW, TODAY).unwrap();
        assert_eq!(stats.repriced, 1);

        let after: Value =
            serde_json::from_str(&std::fs::read_to_string(convs.join("c-1.json")).unwrap())
                .unwrap();
        let m = &after["messages"][0];
        assert_eq!(m["costUsd"].as_f64().unwrap(), 30.0);
        assert_eq!(m["costUsdBefore"].as_f64().unwrap(), 90.0);
        assert_eq!(m["repricedAt"].as_str().unwrap(), NOW);

        let backup = dir.join(format!("conversations.pre-reprice-{TODAY}"));
        assert!(
            backup.join("c-1.json").exists(),
            "original must be backed up"
        );
        let backed: Value =
            serde_json::from_str(&std::fs::read_to_string(backup.join("c-1.json")).unwrap())
                .unwrap();
        assert_eq!(backed["messages"][0]["costUsd"].as_f64().unwrap(), 90.0);

        // Idempotent: second pass sees the marker and does nothing.
        let again = reprice_conversations(&convs, NOW, TODAY).unwrap();
        assert_eq!(again.repriced, 0);
        assert_eq!(again.already_marked, 1);
        std::fs::remove_dir_all(&dir).ok();
    }

    /// OpenAI reports prompt tokens as a SUPERSET of its cached reads, so the
    /// estimator subtracts before pricing. gpt-5: 1M prompt of which 400k
    /// cached, 0 output → 600k fresh @ $5 + 400k cached @ $2.50 = $4.00.
    #[test]
    fn honours_input_includes_cache_read_for_openai_messages() {
        let dir = tmpdir("conv-openai");
        let convs = dir.join("conversations");
        std::fs::create_dir_all(&convs).unwrap();
        std::fs::write(
            convs.join("c-1.json"),
            serde_json::to_string(&conversation(
                "gpt-5",
                json!({
                    "id": "m-1",
                    "role": "assistant",
                    "content": "hi",
                    "timestamp": JUNE_MS,
                    "inputTokens": 1_000_000,
                    "cacheReadTokens": 400_000,
                    "outputTokens": 0,
                    "costUsd": 1.0,
                }),
            ))
            .unwrap(),
        )
        .unwrap();

        reprice_conversations(&convs, NOW, TODAY).unwrap();
        let after: Value =
            serde_json::from_str(&std::fs::read_to_string(convs.join("c-1.json")).unwrap())
                .unwrap();
        assert!(
            (after["messages"][0]["costUsd"].as_f64().unwrap() - 4.0).abs() < 1e-9,
            "got {}",
            after["messages"][0]["costUsd"]
        );
        std::fs::remove_dir_all(&dir).ok();
    }

    /// Reasoning tokens bill at the OUTPUT rate, exactly as `costForTurn` does.
    /// Opus 4.8: 1M reasoning, nothing else → 1M @ $25 = $25.
    #[test]
    fn bills_reasoning_tokens_at_the_output_rate() {
        let dir = tmpdir("conv-reasoning");
        let convs = dir.join("conversations");
        std::fs::create_dir_all(&convs).unwrap();
        std::fs::write(
            convs.join("c-1.json"),
            serde_json::to_string(&conversation(
                "claude-opus-4-8",
                json!({
                    "id": "m-1",
                    "role": "assistant",
                    "content": "hi",
                    "timestamp": JUNE_MS,
                    "inputTokens": 0,
                    "outputTokens": 0,
                    "reasoningTokens": 1_000_000,
                    "costUsd": 75.0,
                }),
            ))
            .unwrap(),
        )
        .unwrap();

        reprice_conversations(&convs, NOW, TODAY).unwrap();
        let after: Value =
            serde_json::from_str(&std::fs::read_to_string(convs.join("c-1.json")).unwrap())
                .unwrap();
        assert_eq!(after["messages"][0]["costUsd"].as_f64().unwrap(), 25.0);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn skips_conversation_messages_without_a_model_or_tokens() {
        let dir = tmpdir("conv-skip");
        let convs = dir.join("conversations");
        std::fs::create_dir_all(&convs).unwrap();

        let mut no_model = conversation(
            "claude-opus-4-8",
            json!({
                "id": "m-1", "role": "assistant", "content": "x",
                "timestamp": JUNE_MS, "inputTokens": 1_000_000, "costUsd": 15.0,
            }),
        );
        no_model.as_object_mut().unwrap().remove("model");
        std::fs::write(
            convs.join("a.json"),
            serde_json::to_string(&no_model).unwrap(),
        )
        .unwrap();

        let no_tokens = conversation(
            "claude-opus-4-8",
            json!({ "id": "m-1", "role": "assistant", "content": "x", "timestamp": JUNE_MS, "costUsd": 15.0 }),
        );
        std::fs::write(
            convs.join("b.json"),
            serde_json::to_string(&no_tokens).unwrap(),
        )
        .unwrap();

        let a_before = std::fs::read_to_string(convs.join("a.json")).unwrap();
        let b_before = std::fs::read_to_string(convs.join("b.json")).unwrap();

        let stats = reprice_conversations(&convs, NOW, TODAY).unwrap();
        assert_eq!(stats.repriced, 0);
        assert_eq!(stats.skipped_unknown_model, 1);
        assert_eq!(stats.skipped_no_tokens, 1);
        assert_eq!(
            std::fs::read_to_string(convs.join("a.json")).unwrap(),
            a_before
        );
        assert_eq!(
            std::fs::read_to_string(convs.join("b.json")).unwrap(),
            b_before
        );
        assert!(!dir
            .join(format!("conversations.pre-reprice-{TODAY}"))
            .exists());
        std::fs::remove_dir_all(&dir).ok();
    }

    /// The walk is top-level and file-only, so it must never descend into
    /// `conversations/<id>/`. The only thing that ever put a subdirectory
    /// there was the checkpoint writer retired in 0.10.0, and installs that
    /// ran 0.5.0–0.9.4 still carry those snapshots (see the module header) —
    /// so this fences a future recursive walk out of real user data, not out
    /// of a hypothetical.
    ///
    /// The fixture carries a top-level `model`, which the real writer never
    /// wrote (its payload was `{createdAt, messageCount, messages}`), on
    /// purpose: a faithful payload would be skipped as unpriceable even by a
    /// recursive walk, leaving the file byte-identical for the wrong reason.
    /// This one is maximally repriceable, so a walk that reached it would
    /// rewrite it and fail loudly.
    #[test]
    fn ignores_checkpoint_subdirectories() {
        let dir = tmpdir("conv-checkpoints");
        let convs = dir.join("conversations");
        let chk = convs.join("sess-1").join("checkpoints");
        std::fs::create_dir_all(&chk).unwrap();
        let snapshot = serde_json::to_string(&json!({
            "model": "claude-opus-4-8",
            "messages": [{ "id": "m", "role": "assistant", "content": "x",
                           "timestamp": JUNE_MS, "inputTokens": 1_000_000, "costUsd": 15.0 }],
        }))
        .unwrap();
        std::fs::write(chk.join("1_chk_1.json"), &snapshot).unwrap();

        let stats = reprice_conversations(&convs, NOW, TODAY).unwrap();
        assert_eq!(stats.scanned, 0);
        assert_eq!(
            std::fs::read_to_string(chk.join("1_chk_1.json")).unwrap(),
            snapshot
        );
        std::fs::remove_dir_all(&dir).ok();
    }

    // -- orchestration -----------------------------------------------------

    #[test]
    fn fresh_install_is_a_total_no_op() {
        let dir = tmpdir("fresh");
        let _guard = crate::core::storage::redirect_data_dir_for_test(dir.clone());

        let result = run_reprice(&dir.join("usage.jsonl"), &dir.join("conversations"));
        assert!(result.is_none(), "nothing to do on a fresh install");
        assert_eq!(
            std::fs::read_dir(&dir).unwrap().count(),
            0,
            "a fresh install must not gain a state file, a backup, or anything else"
        );
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn run_reprice_sets_the_flag_and_skips_on_the_next_launch() {
        let dir = tmpdir("flag");
        let _guard = crate::core::storage::redirect_data_dir_for_test(dir.clone());
        let ledger = dir.join("usage.jsonl");
        std::fs::write(
            &ledger,
            format!(
                "{}\n",
                ledger_line(
                    "claude-opus-4-8",
                    "2026-06-01T10:00:00Z",
                    1_000_000,
                    1_000_000,
                    90.0
                )
            ),
        )
        .unwrap();

        let (stats, _) = run_reprice(&ledger, &dir.join("conversations")).expect("pass runs");
        assert_eq!(stats.repriced, 1);
        assert_eq!(stats.before_usd, 90.0);
        assert_eq!(stats.after_usd, 30.0);
        assert!(crate::core::storage::load_state()
            .cost_reprice_v1_at
            .is_some());

        // Second launch short-circuits on the flag.
        assert!(
            run_reprice(&ledger, &dir.join("conversations")).is_none(),
            "the flag must short-circuit the whole pass"
        );
        let rows = read_lines(&ledger);
        assert_eq!(rows[0]["cost_usd"].as_f64().unwrap(), 30.0);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn startup_reprice_preserves_unresolved_usage_journal_offsets() {
        let dir = tmpdir("pending-usage");
        let _guard = crate::core::storage::redirect_data_dir_for_test(dir.clone());
        let ledger = dir.join("usage.jsonl");
        let line = format!(
            "{}\n",
            ledger_line(
                "claude-opus-4-8",
                "2026-06-01T10:00:00Z",
                1_000_000,
                1_000_000,
                90.0
            )
        );
        std::fs::write(&ledger, &line).unwrap();
        let pending = dir.join("usage-pending");
        std::fs::create_dir(&pending).unwrap();
        let journal = serde_json::to_vec(&json!({ "prior_len": 0, "line": line })).unwrap();
        std::fs::write(pending.join("pending.json"), &journal).unwrap();

        assert!(run_reprice(&ledger, &dir.join("conversations")).is_none());
        assert_eq!(std::fs::read_to_string(&ledger).unwrap(), line);
        assert_eq!(
            std::fs::read(pending.join("pending.json")).unwrap(),
            journal
        );
        assert!(crate::core::storage::load_state()
            .cost_reprice_v1_at
            .is_none());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn iso_date_rejects_garbage_timestamps() {
        assert_eq!(
            iso_date("2026-06-01T10:00:00Z").as_deref(),
            Some("2026-06-01")
        );
        assert_eq!(iso_date("2026-06-01").as_deref(), Some("2026-06-01"));
        assert_eq!(iso_date("nope"), None);
        assert_eq!(iso_date("20260601T10"), None);
        assert_eq!(iso_date(""), None);
    }
}
