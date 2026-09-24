use crate::commands::shared::home_dir;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::io::{Read, Seek, SeekFrom};
use std::path::PathBuf;

#[derive(Debug, Serialize, Clone)]
pub struct ModelUsage {
    pub source: String,
    pub model: String,
    pub sessions: u32,
    #[serde(rename = "inputTokens")]
    pub input_tokens: u64,
    #[serde(rename = "outputTokens")]
    pub output_tokens: u64,
    #[serde(rename = "costUsd")]
    pub cost_usd: f64,
    #[serde(rename = "pricingStatus")]
    pub pricing_status: crate::commands::pricing::PricingStatus,
}

#[derive(Debug, Serialize, Clone)]
pub struct DailyCost {
    pub date: String,
    #[serde(rename = "costUsd")]
    pub cost_usd: f64,
}

#[derive(Debug, Serialize, Clone)]
pub struct AnalyticsData {
    #[serde(rename = "sessionCostsById")]
    pub session_costs_by_id: HashMap<String, f64>,
    #[serde(rename = "totalCostUsd")]
    pub total_cost_usd: f64,
    #[serde(rename = "totalSessions")]
    pub total_sessions: u32,
    #[serde(rename = "totalInputTokens")]
    pub total_input_tokens: u64,
    #[serde(rename = "totalOutputTokens")]
    pub total_output_tokens: u64,
    #[serde(rename = "modelUsage")]
    pub model_usage: Vec<ModelUsage>,
    #[serde(rename = "dailyCosts")]
    pub daily_costs: Vec<DailyCost>,
    #[serde(rename = "todayCostUsd")]
    pub today_cost_usd: f64,
    #[serde(rename = "currentMonthCostUsd")]
    pub current_month_cost_usd: f64,
    #[serde(rename = "unknownPricingModelUsage")]
    pub unknown_pricing_model_usage: Vec<ModelUsage>,
}

/// Shape of ~/.claude/cost-tally.json entries
#[derive(Debug, Deserialize)]
struct CostTallyEntry {
    #[serde(default)]
    model: Option<String>,
    #[serde(default)]
    cost: Option<f64>,
    #[serde(default, alias = "costUsd")]
    cost_usd: Option<f64>,
    #[serde(default)]
    date: Option<String>,
    #[serde(default, alias = "inputTokens")]
    input_tokens: Option<u64>,
    #[serde(default, alias = "outputTokens")]
    output_tokens: Option<u64>,
    #[serde(default)]
    sessions: Option<u32>,
}

#[tauri::command]
pub async fn read_usage_analytics() -> Result<String, String> {
    // A mature Codex install can have several gigabytes of JSONL history.
    // Running filesystem discovery/parsing in a synchronous Tauri command
    // starves the native event loop (including custom-protocol assets and every
    // other invoke). Keep the command asynchronous even though the parser is
    // mostly I/O-bound so the window remains interactive during refresh.
    tauri::async_runtime::spawn_blocking(read_usage_analytics_blocking)
        .await
        .map_err(|error| format!("Usage analytics worker failed: {error}"))?
}

fn read_usage_analytics_blocking() -> Result<String, String> {
    let home = home_dir()
        .ok_or_else(|| "Could not resolve home directory for usage analytics".to_string())?;

    let claude_dir = PathBuf::from(&home).join(".claude");

    // Try reading cost-tally.json
    let cost_tally_path = claude_dir.join("cost-tally.json");
    let cost_entries = read_cost_tally(&cost_tally_path);

    // Aggregate data
    let mut total_cost: f64 = 0.0;
    let mut total_sessions: u32 = 0;
    let mut total_input: u64 = 0;
    let mut total_output: u64 = 0;

    let mut model_map: HashMap<String, ModelUsage> = HashMap::new();
    let mut daily_map: HashMap<String, f64> = HashMap::new();
    let mut session_costs_by_id = HashMap::new();

    for entry in &cost_entries {
        let cost = entry.cost_usd.or(entry.cost).unwrap_or(0.0);
        let model = entry.model.clone().unwrap_or_else(|| "unknown".to_string());
        let input = entry.input_tokens.unwrap_or(0);
        let output = entry.output_tokens.unwrap_or(0);
        let sessions = entry.sessions.unwrap_or(1);
        let source = "claude-cli".to_string();
        let pricing_status = crate::commands::pricing::pricing_status_for(&model);

        total_cost += cost;
        total_sessions += sessions;
        total_input += input;
        total_output += output;

        let key = format!("{}::{}", source, model);
        let usage = model_map.entry(key).or_insert(ModelUsage {
            source: source.clone(),
            model: model.clone(),
            sessions: 0,
            input_tokens: 0,
            output_tokens: 0,
            cost_usd: 0.0,
            pricing_status,
        });
        usage.source = source.clone();
        usage.pricing_status = merge_pricing_status(usage.pricing_status, pricing_status);
        usage.sessions += sessions;
        usage.input_tokens += input;
        usage.output_tokens += output;
        usage.cost_usd += cost;

        if let Some(date) = &entry.date {
            *daily_map.entry(date.clone()).or_insert(0.0) += cost;
        }
    }

    // Ingest ~/.packetbench/usage.jsonl (written by the in-process API agents,
    // the aux router, and the sidecar turn_summary handler)
    let usage_jsonl_path = PathBuf::from(&home)
        .join(crate::core::brand::DATA_DIR_NAME)
        .join("usage.jsonl");
    if let Some(contents) = read_usage_ledger(&usage_jsonl_path)? {
        ingest_usage_jsonl(
            &contents,
            &mut total_cost,
            &mut total_sessions,
            &mut total_input,
            &mut total_output,
            &mut model_map,
            &mut daily_map,
            &mut session_costs_by_id,
        );
    }

    // Ingest ~/.codex/sessions/*.jsonl (written by Codex CLI)
    let codex_sessions_dir = PathBuf::from(&home).join(".codex").join("sessions");
    if codex_sessions_dir.exists() {
        let mut codex_files: Vec<PathBuf> = Vec::new();
        collect_jsonl_files_recursive(&codex_sessions_dir, &mut codex_files);

        for path in codex_files {
            // Codex token_count values are cumulative per session, so only the
            // newest token_count plus newest turn_context are needed. Read from
            // EOF in bounded chunks and stop as soon as both are found instead
            // of reparsing the complete transcript (which can exceed 200 MB).
            let Some(session_usage) = read_latest_codex_session_usage(&path) else {
                continue;
            };

            let model = session_usage.model.unwrap_or_else(|| "unknown".to_string());
            let latest_input = session_usage.input_tokens;
            let latest_output = session_usage.output_tokens;
            let latest_cached = session_usage.cached_input_tokens;
            let pricing_status = crate::commands::pricing::pricing_status_for(&model);
            // Price at the rates in effect on the session's OWN date, not
            // today's, so a published rate change is never applied
            // retroactively to a session that already happened.
            let priced_on = session_usage.date.clone().unwrap_or_else(today_date_string);
            let cost = crate::commands::pricing::calculate_cost_at(
                &model,
                &priced_on,
                latest_input,
                latest_output,
                latest_cached,
                0,
                0,
            );
            let source = "codex".to_string();
            let sessions: u32 = 1;

            total_cost += cost;
            total_sessions += sessions;
            total_input += latest_input;
            total_output += latest_output;

            let key = format!("{}::{}", source, model);
            let usage = model_map.entry(key).or_insert(ModelUsage {
                source: source.clone(),
                model: model.clone(),
                sessions: 0,
                input_tokens: 0,
                output_tokens: 0,
                cost_usd: 0.0,
                pricing_status,
            });
            usage.source = source.clone();
            usage.pricing_status = merge_pricing_status(usage.pricing_status, pricing_status);
            usage.sessions += sessions;
            usage.input_tokens += latest_input;
            usage.output_tokens += latest_output;
            usage.cost_usd += cost;

            if let Some(date) = session_usage.date {
                *daily_map.entry(date).or_insert(0.0) += cost;
            }
        }
    }

    // Also try reading stats-cache.json for additional data
    let stats_path = claude_dir.join("stats-cache.json");
    if let Ok(contents) = fs::read_to_string(&stats_path) {
        if let Ok(stats) = serde_json::from_str::<serde_json::Value>(&contents) {
            // Extract any additional session/cost data from stats cache
            if let Some(total) = stats.get("totalCost").and_then(|v| v.as_f64()) {
                if total > total_cost {
                    total_cost = total;
                }
            }
            if let Some(count) = stats.get("totalSessions").and_then(|v| v.as_u64()) {
                if count as u32 > total_sessions {
                    total_sessions = count as u32;
                }
            }
        }
    }

    let mut model_usage: Vec<ModelUsage> = model_map.into_values().collect();
    model_usage.sort_by(|a, b| {
        b.cost_usd
            .partial_cmp(&a.cost_usd)
            .unwrap_or(std::cmp::Ordering::Equal)
    });

    let today = today_date_string();
    let current_month = today.get(..7).unwrap_or("").to_string();
    let today_cost_usd = daily_map.get(&today).copied().unwrap_or(0.0);
    let current_month_cost_usd: f64 = daily_map
        .iter()
        .filter(|(date, _)| date.starts_with(&current_month))
        .map(|(_, cost)| *cost)
        .sum();

    let mut daily_costs: Vec<DailyCost> = daily_map
        .into_iter()
        .map(|(date, cost_usd)| DailyCost { date, cost_usd })
        .collect();
    daily_costs.sort_by(|a, b| a.date.cmp(&b.date));

    // Keep last 30 days
    if daily_costs.len() > 30 {
        daily_costs = daily_costs.split_off(daily_costs.len() - 30);
    }

    let unknown_pricing_model_usage = model_usage
        .iter()
        .filter(|usage| {
            usage.pricing_status == crate::commands::pricing::PricingStatus::Unknown
                && usage.input_tokens.saturating_add(usage.output_tokens) > 0
        })
        .cloned()
        .collect();

    let data = AnalyticsData {
        session_costs_by_id,
        total_cost_usd: total_cost,
        total_sessions,
        total_input_tokens: total_input,
        total_output_tokens: total_output,
        model_usage,
        daily_costs,
        today_cost_usd,
        current_month_cost_usd,
        unknown_pricing_model_usage,
    };

    serde_json::to_string(&data)
        .map_err(|error| format!("Could not serialize usage analytics: {error}"))
}

/// Fold `~/.packetbench/usage.jsonl` lines into the aggregation accumulators.
/// One row = one `UsageEntry` = one completed request's spend. The public read
/// validates the complete ledger first and refuses malformed/truncated rows;
/// this aggregation helper tolerates blank lines. Extracted so the
/// ledger→rollup behaviour — the input the daily/monthly budget guardrails
/// evaluate — is testable without touching the real home directory.
#[allow(clippy::too_many_arguments)]
fn ingest_usage_jsonl(
    contents: &str,
    total_cost: &mut f64,
    total_sessions: &mut u32,
    total_input: &mut u64,
    total_output: &mut u64,
    model_map: &mut HashMap<String, ModelUsage>,
    daily_map: &mut HashMap<String, f64>,
    session_costs_by_id: &mut HashMap<String, f64>,
) {
    for line in contents.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let entry: crate::commands::usage::UsageEntry = match serde_json::from_str(line) {
            Ok(e) => e,
            Err(_) => continue,
        };

        let cost = entry.cost_usd;
        if !entry.session_id.is_empty() && cost.is_finite() && cost >= 0.0 {
            *session_costs_by_id
                .entry(entry.session_id.clone())
                .or_insert(0.0) += cost;
        }
        let input = entry.input_tokens;
        let output = entry.output_tokens;
        let sessions: u32 = 1;
        let pricing_status = crate::commands::pricing::pricing_status_for(&entry.model);

        *total_cost += cost;
        *total_sessions += sessions;
        *total_input += input;
        *total_output += output;

        let key = format!("{}::{}", entry.source, entry.model);
        let usage = model_map.entry(key).or_insert(ModelUsage {
            source: entry.source.clone(),
            model: entry.model.clone(),
            sessions: 0,
            input_tokens: 0,
            output_tokens: 0,
            cost_usd: 0.0,
            pricing_status,
        });
        usage.source = entry.source.clone();
        usage.pricing_status = merge_pricing_status(usage.pricing_status, pricing_status);
        usage.sessions += sessions;
        usage.input_tokens += input;
        usage.output_tokens += output;
        usage.cost_usd += cost;

        // Daily date = first 10 chars of ISO 8601 timestamp, or today as fallback
        let date = if let Some(date) = entry.ts.get(..10) {
            date.to_string()
        } else {
            today_date_string()
        };
        *daily_map.entry(date).or_insert(0.0) += cost;
    }
}

fn read_cost_tally(path: &PathBuf) -> Vec<CostTallyEntry> {
    let contents = match fs::read_to_string(path) {
        Ok(c) => c,
        Err(_) => return vec![],
    };

    // Could be an array or an object with entries
    if let Ok(entries) = serde_json::from_str::<Vec<CostTallyEntry>>(&contents) {
        return entries;
    }

    // Try as a map of date -> entry
    if let Ok(map) = serde_json::from_str::<HashMap<String, serde_json::Value>>(&contents) {
        let mut entries = Vec::new();
        for (date, value) in map {
            if let Ok(mut entry) = serde_json::from_value::<CostTallyEntry>(value) {
                if entry.date.is_none() {
                    entry.date = Some(date);
                }
                entries.push(entry);
            }
        }
        return entries;
    }

    vec![]
}

/// Missing ledger is a new installation; every other read failure must block
/// budget admission rather than report fabricated zero spend.
fn read_usage_ledger(path: &std::path::Path) -> Result<Option<String>, String> {
    crate::commands::usage::read_usage_ledger(path)
}

fn merge_pricing_status(
    current: crate::commands::pricing::PricingStatus,
    next: crate::commands::pricing::PricingStatus,
) -> crate::commands::pricing::PricingStatus {
    use crate::commands::pricing::PricingStatus;
    match (current, next) {
        (PricingStatus::Unknown, _) | (_, PricingStatus::Unknown) => PricingStatus::Unknown,
        (PricingStatus::Priced, _) | (_, PricingStatus::Priced) => PricingStatus::Priced,
        _ => PricingStatus::Free,
    }
}

fn collect_jsonl_files_recursive(dir: &std::path::Path, out: &mut Vec<PathBuf>) {
    let entries = match fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return,
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            collect_jsonl_files_recursive(&path, out);
        } else if path.extension().and_then(|e| e.to_str()) == Some("jsonl") {
            out.push(path);
        }
    }
}

#[derive(Debug, PartialEq, Eq)]
struct CodexSessionUsage {
    model: Option<String>,
    input_tokens: u64,
    output_tokens: u64,
    cached_input_tokens: u64,
    date: Option<String>,
}

const CODEX_REVERSE_READ_CHUNK_BYTES: u64 = 256 * 1024;

fn contains_bytes(haystack: &[u8], needle: &[u8]) -> bool {
    haystack
        .windows(needle.len())
        .any(|candidate| candidate == needle)
}

/// Read a Codex JSONL session from newest to oldest and stop once its latest
/// cumulative token record and model context are known.
///
/// Chunk carry-over preserves lines split across read boundaries. Lines that
/// are not plausible token/model records are rejected by a byte prefilter
/// before serde sees them, so large tool outputs never become JSON values.
fn read_latest_codex_session_usage(path: &std::path::Path) -> Option<CodexSessionUsage> {
    let mut file = fs::File::open(path).ok()?;
    let mut position = file.metadata().ok()?.len();
    if position == 0 {
        return None;
    }

    let mut leading_fragment = Vec::<u8>::new();
    let mut latest_model: Option<String> = None;
    let mut latest_tokens: Option<(u64, u64, u64, Option<String>)> = None;

    while position > 0 && (latest_model.is_none() || latest_tokens.is_none()) {
        let read_len = position.min(CODEX_REVERSE_READ_CHUNK_BYTES);
        let start = position - read_len;
        file.seek(SeekFrom::Start(start)).ok()?;

        let mut block = vec![0_u8; read_len as usize];
        file.read_exact(&mut block).ok()?;
        block.extend_from_slice(&leading_fragment);

        let complete_start = if start == 0 {
            0
        } else if let Some(first_newline) = block.iter().position(|byte| *byte == b'\n') {
            first_newline + 1
        } else {
            leading_fragment = block;
            position = start;
            continue;
        };

        for line in block[complete_start..].split(|byte| *byte == b'\n').rev() {
            if line.is_empty() {
                continue;
            }

            if latest_tokens.is_none()
                && contains_bytes(line, b"\"token_count\"")
                && contains_bytes(line, b"\"event_msg\"")
            {
                if let Ok(parsed) = serde_json::from_slice::<serde_json::Value>(line) {
                    let payload = parsed.get("payload");
                    if parsed.get("type").and_then(|value| value.as_str()) == Some("event_msg")
                        && payload
                            .and_then(|value| value.get("type"))
                            .and_then(|value| value.as_str())
                            == Some("token_count")
                    {
                        let usage = payload
                            .and_then(|value| value.get("info"))
                            .and_then(|value| value.get("total_token_usage"));
                        let input = usage
                            .and_then(|value| value.get("input_tokens"))
                            .and_then(|value| value.as_u64())
                            .unwrap_or(0);
                        let output = usage
                            .and_then(|value| value.get("output_tokens"))
                            .and_then(|value| value.as_u64())
                            .unwrap_or(0);
                        let cached = usage
                            .and_then(|value| value.get("cached_input_tokens"))
                            .or_else(|| usage.and_then(|value| value.get("cached_tokens")))
                            .and_then(|value| value.as_u64())
                            .unwrap_or(0);
                        let date = parsed
                            .get("timestamp")
                            .and_then(|value| value.as_str())
                            .filter(|timestamp| timestamp.len() >= 10)
                            .map(|timestamp| timestamp[..10].to_string());
                        latest_tokens = Some((input, output, cached, date));
                    }
                }
            }

            if latest_model.is_none()
                && contains_bytes(line, b"\"turn_context\"")
                && contains_bytes(line, b"\"model\"")
            {
                if let Ok(parsed) = serde_json::from_slice::<serde_json::Value>(line) {
                    if parsed.get("type").and_then(|value| value.as_str()) == Some("turn_context") {
                        latest_model = parsed
                            .get("payload")
                            .and_then(|value| value.get("model"))
                            .and_then(|value| value.as_str())
                            .map(str::to_owned);
                    }
                }
            }

            if latest_model.is_some() && latest_tokens.is_some() {
                break;
            }
        }

        leading_fragment = if start == 0 {
            Vec::new()
        } else {
            block[..complete_start.saturating_sub(1)].to_vec()
        };
        position = start;
    }

    let (input_tokens, output_tokens, cached_input_tokens, date) = latest_tokens?;
    Some(CodexSessionUsage {
        model: latest_model,
        input_tokens,
        output_tokens,
        cached_input_tokens,
        date,
    })
}

fn today_date_string() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    // Convert to YYYY-MM-DD in UTC. Simple manual conversion to avoid extra deps.
    let days = (secs / 86_400) as i64;
    let (y, m, d) = days_to_ymd(days);
    format!("{:04}-{:02}-{:02}", y, m, d)
}

fn days_to_ymd(days_since_epoch: i64) -> (i32, u32, u32) {
    // Days since 1970-01-01 -> Gregorian Y/M/D. Algorithm from Howard Hinnant.
    let z = days_since_epoch + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = (z - era * 146_097) as u64;
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = y + if m <= 2 { 1 } else { 0 };
    (y as i32, m as u32, d as u32)
}

#[cfg(test)]
mod tests {
    #[test]
    fn usage_ledger_missing_is_empty_but_unreadable_is_an_error() {
        let directory = tempfile::tempdir().unwrap();
        assert!(
            super::read_usage_ledger(&directory.path().join("missing.jsonl"))
                .unwrap()
                .is_none()
        );
        // A directory is not a readable ledger, consistently on all platforms.
        assert!(super::read_usage_ledger(directory.path())
            .unwrap_err()
            .contains("Could not read usage ledger"));
        let invalid_utf8 = directory.path().join("invalid.jsonl");
        std::fs::write(&invalid_utf8, [0xff]).unwrap();
        assert!(super::read_usage_ledger(&invalid_utf8).is_err());
    }

    use super::*;
    use std::io::Write;

    fn token_line(input: u64, output: u64, cached: u64, date: &str) -> String {
        serde_json::json!({
            "timestamp": format!("{date}T12:34:56Z"),
            "type": "event_msg",
            "payload": {
                "type": "token_count",
                "info": {
                    "total_token_usage": {
                        "input_tokens": input,
                        "output_tokens": output,
                        "cached_input_tokens": cached
                    }
                }
            }
        })
        .to_string()
    }

    fn model_line(model: &str) -> String {
        serde_json::json!({
            "type": "turn_context",
            "payload": { "model": model }
        })
        .to_string()
    }

    /// A sidecar session's `turn_summary` ledger rows must surface in the
    /// analytics rollup — totals, per-model usage, and the daily buckets the
    /// `today` / `current month` budget guardrails are computed from. Built
    /// with the real sidecar entry constructor so this breaks if either side
    /// of the ledger schema drifts.
    #[test]
    fn sidecar_ledger_rows_roll_up_into_analytics() {
        let claude = crate::commands::agent_sidecar::sidecar_usage_entry(
            "claude-oauth",
            "claude-sonnet-4-6",
            "sidecar-sess-1",
            1000,
            500,
            2000,
            3000,
        );
        let openai = crate::commands::agent_sidecar::sidecar_usage_entry(
            "openai-agents",
            "gpt-5.5",
            "sidecar-sess-2",
            1000,
            200,
            800,
            0,
        );
        assert!(claude.cost_usd > 0.0 && openai.cost_usd > 0.0);
        let contents = format!(
            "{}\n\nnot json\n{}\n",
            serde_json::to_string(&claude).unwrap(),
            serde_json::to_string(&openai).unwrap(),
        );

        let mut total_cost = 0.0;
        let mut total_sessions = 0u32;
        let mut total_input = 0u64;
        let mut total_output = 0u64;
        let mut model_map = HashMap::new();
        let mut daily_map = HashMap::new();
        let mut session_costs_by_id = HashMap::new();
        ingest_usage_jsonl(
            &contents,
            &mut total_cost,
            &mut total_sessions,
            &mut total_input,
            &mut total_output,
            &mut model_map,
            &mut daily_map,
            &mut session_costs_by_id,
        );

        assert_eq!(
            session_costs_by_id.get("sidecar-sess-2"),
            Some(&openai.cost_usd)
        );
        // A separately attributed child request must accumulate into its
        // parent's session total, without replacing the parent-model row.
        let mut child = openai.clone();
        child.model = "gpt-5-mini".into();
        child.agent_id = Some("subagent".into());
        child.cost_usd = 0.125;
        let mut child_sessions = HashMap::new();
        ingest_usage_jsonl(
            &format!(
                "{}\n{}",
                serde_json::to_string(&openai).unwrap(),
                serde_json::to_string(&child).unwrap()
            ),
            &mut 0.0,
            &mut 0,
            &mut 0,
            &mut 0,
            &mut HashMap::new(),
            &mut HashMap::new(),
            &mut child_sessions,
        );
        assert_eq!(child_sessions["sidecar-sess-2"], openai.cost_usd + 0.125);

        assert_eq!(total_sessions, 2);
        assert_eq!(total_input, 2000);
        assert_eq!(total_output, 700);
        let expected_cost = claude.cost_usd + openai.cost_usd;
        assert!(
            (total_cost - expected_cost).abs() < 1e-12,
            "sidecar spend must reach the rollup total: expected {expected_cost}, got {total_cost}"
        );

        let claude_usage = model_map
            .get("api-claude-oauth::claude-sonnet-4-6")
            .expect("claude-oauth sidecar row must appear in model usage");
        assert_eq!(claude_usage.sessions, 1);
        assert!((claude_usage.cost_usd - claude.cost_usd).abs() < 1e-12);
        assert!(model_map.contains_key("api-openai-agents::gpt-5.5"));

        // Both rows were stamped just now, so the guardrails' daily bucket
        // for the entries' own date must carry the full spend.
        let date = claude.ts[..10].to_string();
        let daily = daily_map
            .get(&date)
            .copied()
            .expect("sidecar spend must land in a daily cost bucket");
        assert!((daily - expected_cost).abs() < 1e-12);
    }

    #[test]
    fn reverse_reader_uses_latest_cumulative_values() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("session.jsonl");
        let mut file = fs::File::create(&path).unwrap();
        writeln!(file, "{}", model_line("gpt-old")).unwrap();
        writeln!(file, "{}", token_line(10, 2, 1, "2026-07-28")).unwrap();
        writeln!(file, "{}", model_line("gpt-new")).unwrap();
        writeln!(file, "{}", token_line(25, 7, 5, "2026-07-29")).unwrap();

        assert_eq!(
            read_latest_codex_session_usage(&path),
            Some(CodexSessionUsage {
                model: Some("gpt-new".to_string()),
                input_tokens: 25,
                output_tokens: 7,
                cached_input_tokens: 5,
                date: Some("2026-07-29".to_string()),
            })
        );
    }

    #[test]
    fn reverse_reader_handles_records_split_across_chunks() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("session.jsonl");
        let mut file = fs::File::create(&path).unwrap();
        writeln!(file, "{}", model_line("gpt-split")).unwrap();
        writeln!(
            file,
            "{}",
            serde_json::json!({
                "type": "response_item",
                "payload": "x".repeat(CODEX_REVERSE_READ_CHUNK_BYTES as usize + 37)
            })
        )
        .unwrap();
        writeln!(file, "{}", token_line(99, 11, 8, "2026-07-29")).unwrap();

        assert_eq!(
            read_latest_codex_session_usage(&path),
            Some(CodexSessionUsage {
                model: Some("gpt-split".to_string()),
                input_tokens: 99,
                output_tokens: 11,
                cached_input_tokens: 8,
                date: Some("2026-07-29".to_string()),
            })
        );
    }

    #[test]
    fn reverse_reader_ignores_trailing_partial_json() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("session.jsonl");
        let mut file = fs::File::create(&path).unwrap();
        writeln!(file, "{}", model_line("gpt-stable")).unwrap();
        writeln!(file, "{}", token_line(40, 4, 3, "2026-07-29")).unwrap();
        write!(file, "{{\"type\":\"event_msg\",\"payload\":").unwrap();

        assert_eq!(
            read_latest_codex_session_usage(&path),
            Some(CodexSessionUsage {
                model: Some("gpt-stable".to_string()),
                input_tokens: 40,
                output_tokens: 4,
                cached_input_tokens: 3,
                date: Some("2026-07-29".to_string()),
            })
        );
    }
}
