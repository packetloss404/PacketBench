//! Inbound event dispatcher — translates a parsed sidecar event into the
//! matching `api-agent:*` Tauri event(s) and runs any side effects
//! (one-shot waiter resolution, executor cost accumulation, lifetime
//! bookkeeping for the `ready` handshake, etc.).

use std::time::Instant;

use serde_json::Value;
use tauri::Emitter;
use tracing::{error, info, warn};

use super::events::{
    chunk_event, done_event, edit_baseline_event, error_event, mcp_sources_event,
    pending_edit_event, permission_request_event, plan_block_event, thinking_event,
    thinking_stop_event, tool_output_extended_event, tool_result_event, tool_start_event,
    turn_summary_event, DonePayload, EditBaselinePayload, ErrorPayload, McpReadError,
    McpSourceInfo, McpSourcesPayload, PendingEditPayload, PermissionRequestPayload,
    PlanBlockPayload, PlanItemPayload, ThinkingPayload, ToolOutputExtendedPayload,
    ToolResultPayload, ToolStartPayload, TurnSummaryPayload,
};
use super::status::SidecarState;
use super::supervisor::SidecarManager;
use super::{protocol_meets_floor, EXPECTED_PROTOCOL_VERSION, MINIMUM_PROTOCOL_VERSION};

impl SidecarManager {
    /// Translate a parsed sidecar event into a Tauri event.
    pub(super) async fn handle_event(&self, value: Value) {
        let event_type = value.get("type").and_then(|v| v.as_str()).unwrap_or("");
        let session_id = value
            .get("sessionId")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();

        match event_type {
            "ready" => {
                let pid = value.get("pid").and_then(|v| v.as_u64()).unwrap_or(0);
                let version = value.get("version").and_then(|v| v.as_str());
                let protocol_version = value
                    .get("protocolVersion")
                    .and_then(|v| v.as_u64())
                    .map(|v| v as u32);

                match (version, protocol_version) {
                    (Some(ver), Some(proto)) => {
                        info!(
                            pid,
                            version = ver,
                            protocol_version = proto,
                            "sidecar ready: pid={}, version={}, protocolVersion={}",
                            pid,
                            ver,
                            proto
                        );
                        if proto != EXPECTED_PROTOCOL_VERSION {
                            warn!(
                                expected = EXPECTED_PROTOCOL_VERSION,
                                got = proto,
                                "sidecar protocol version mismatch: expected {}, got {} — some features may misbehave",
                                EXPECTED_PROTOCOL_VERSION,
                                proto
                            );
                        }
                    }
                    _ => {
                        warn!(
                            pid,
                            "sidecar ready event is missing version/protocol — running against a pre-handshake build"
                        );
                    }
                }

                // F7: record the handshake so `forward_start` can gate on it,
                // and refuse outright below the security floor. A sidecar that
                // predates v11 silently ignores `mcpTrustSnapshot` and runs
                // every MCP server unfiltered, so "old but alive" is a worse
                // outcome than "refused" — it looks like it works.
                self.record_protocol_handshake(protocol_version.unwrap_or(0));
                if !protocol_meets_floor(protocol_version) {
                    let detail = match protocol_version {
                        Some(proto) => format!(
                            "The agent sidecar speaks protocol v{proto}, but PacketBench requires \
                             v{MINIMUM_PROTOCOL_VERSION} or newer. A sidecar this old ignores \
                             required MCP trust checks, including remote project trust, \
                             so API-agent sessions are disabled. Reinstall PacketBench, \
                             or clear PACKETBENCH_SIDECAR_PATH if you set it."
                        ),
                        None => format!(
                            "The agent sidecar completed its handshake without advertising a \
                             protocol version, so PacketBench cannot confirm it enforces per-session \
                             MCP trust rules (v{MINIMUM_PROTOCOL_VERSION}+). API-agent sessions \
                             are disabled. Reinstall PacketBench, or clear PACKETBENCH_SIDECAR_PATH \
                             if you set it."
                        ),
                    };
                    error!(
                        pid,
                        minimum = MINIMUM_PROTOCOL_VERSION,
                        got = ?protocol_version,
                        "refusing to use sidecar below the protocol security floor"
                    );
                    let captured_version = version.map(|v| v.to_string());
                    let captured_pid = if pid == 0 { None } else { Some(pid as u32) };
                    self.update_status(|s| {
                        s.state = SidecarState::Incompatible;
                        s.pid = captured_pid;
                        s.version = captured_version.clone();
                        s.last_error = Some(detail.clone());
                        s.session_start = None;
                    })
                    .await;
                    self.fail_owned_sessions(&detail).await;
                    return;
                }

                // Lift the `ready` signal into the lifecycle status so the
                // frontend chip flips from "restarting" / "not_started" to
                // "ready" and can surface pid + version on hover.
                let captured_version = version.map(|v| v.to_string());
                let captured_pid = if pid == 0 { None } else { Some(pid as u32) };
                self.update_status(|s| {
                    s.state = SidecarState::Ready;
                    s.pid = captured_pid;
                    if captured_version.is_some() {
                        s.version = captured_version.clone();
                    }
                    // Successful handshake clears the stale error. Hover text
                    // should only show the *current* trouble, not ancient.
                    s.last_error = None;
                    // Lifetime bookkeeping: every successful handshake is one
                    // more `total_starts`, records the version, and opens a
                    // new uptime window anchored at `session_start`.
                    s.lifetime.total_starts = s.lifetime.total_starts.saturating_add(1);
                    if captured_version.is_some() {
                        s.lifetime.last_version = captured_version;
                    }
                    s.session_start = Some(Instant::now());
                })
                .await;
            }
            "chunk" => {
                // Match `api_agent.rs` exactly: the frontend listens with
                // `listen<string>`, so the payload is the raw text string —
                // not an object wrapper.
                let text = value
                    .get("text")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();
                let _ = self
                    .app_handle
                    .emit(&chunk_event(&session_id), text.clone());

                // E10-SUMMARIZE — if a one-shot waiter exists for this
                // session, append the chunk to its buffer. Cheap lookup;
                // no-op for the vast majority of sessions that never
                // registered a waiter.
                if !text.is_empty() {
                    let mut waiters = self.oneshot_waiters.lock().await;
                    if let Some(waiter) = waiters.get_mut(&session_id) {
                        waiter.buffer.push_str(&text);
                    }
                }
            }
            "thinking" => {
                let text = value
                    .get("text")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();
                let _ = self
                    .app_handle
                    .emit(&thinking_event(&session_id), ThinkingPayload { text });
            }
            "thinking_stop" => {
                let _ = self.app_handle.emit(&thinking_stop_event(&session_id), ());
            }
            "tool_start" => {
                // Sidecar uses `toolUseId`; frontend expects `id`. Translate.
                let id = value
                    .get("toolUseId")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();
                let name = value
                    .get("name")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();
                // P1-7: forward the raw tool input (as a JSON string) so the
                // transcript edit layer can parse Write/Edit/apply_patch
                // calls — sidecar tool_result events don't echo it back.
                let input = value.get("input").map(|v| match v {
                    Value::String(s) => s.clone(),
                    other => serde_json::to_string(other).unwrap_or_default(),
                });
                let _ = self.app_handle.emit(
                    &tool_start_event(&session_id),
                    ToolStartPayload { id, name, input },
                );
            }
            "tool_result" => {
                let id = value
                    .get("toolUseId")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();
                // The sidecar may or may not echo the tool name / input back
                // on the result. Fall back to empty string; the frontend
                // treats them as display metadata only.
                let name = value
                    .get("name")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();
                let output = value.get("output");
                let content = match output {
                    Some(Value::String(s)) => s.clone(),
                    Some(v) => serde_json::to_string(v).unwrap_or_default(),
                    None => String::new(),
                };
                let is_error = value
                    .get("isError")
                    .and_then(|v| v.as_bool())
                    .unwrap_or(false);
                let input = value
                    .get("input")
                    .map(|v| serde_json::to_string(v).unwrap_or_default())
                    .unwrap_or_default();
                let _ = self.app_handle.emit(
                    &tool_result_event(&session_id),
                    ToolResultPayload {
                        id,
                        name,
                        content,
                        is_error,
                        input,
                    },
                );
            }
            "permission_request" => {
                let id = value
                    .get("toolUseId")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();
                let name = value
                    .get("name")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();
                let arguments = value
                    .get("input")
                    .or_else(|| value.get("arguments"))
                    .map(|v| match v {
                        Value::String(s) => s.clone(),
                        other => serde_json::to_string(other).unwrap_or_default(),
                    })
                    .unwrap_or_default();
                let batch_id = value
                    .get("batchId")
                    .and_then(|v| v.as_str())
                    .map(String::from);
                let batch_size = value.get("batchSize").and_then(|v| v.as_u64());
                let _ = self.app_handle.emit(
                    &permission_request_event(&session_id),
                    PermissionRequestPayload {
                        id,
                        name,
                        arguments,
                        batch_id,
                        batch_size,
                    },
                );
            }
            "pending_edit" => {
                let id = value
                    .get("toolUseId")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();
                let path = value
                    .get("path")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();
                // Sidecar protocol carries `after` as the new content; older
                // bundled sidecars may still emit `content`. Accept either.
                let content = value
                    .get("after")
                    .or_else(|| value.get("content"))
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();
                let before = value
                    .get("before")
                    .and_then(|v| v.as_str())
                    .map(String::from);
                let _ = self.app_handle.emit(
                    &pending_edit_event(&session_id),
                    PendingEditPayload {
                        id,
                        path,
                        content,
                        before,
                    },
                );
            }
            "edit_baseline" => {
                // P1-7: non-blocking pre-edit baseline for auto-applied
                // writes. `before` absent = the file did not exist.
                let id = value
                    .get("toolUseId")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();
                let path = value
                    .get("path")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();
                let before = value
                    .get("before")
                    .and_then(|v| v.as_str())
                    .map(String::from);
                let _ = self.app_handle.emit(
                    &edit_baseline_event(&session_id),
                    EditBaselinePayload { id, path, before },
                );
            }
            "done" => {
                let input_tokens = value
                    .get("inputTokens")
                    .and_then(|v| v.as_u64())
                    .unwrap_or(0);
                let output_tokens = value
                    .get("outputTokens")
                    .and_then(|v| v.as_u64())
                    .unwrap_or(0);
                let cache_read_input_tokens = value
                    .get("cacheReadInputTokens")
                    .and_then(|v| v.as_u64())
                    .unwrap_or(0);
                let cache_creation_input_tokens = value
                    .get("cacheCreationInputTokens")
                    .and_then(|v| v.as_u64())
                    .unwrap_or(0);
                let resume_token = value
                    .get("resumeToken")
                    .and_then(|v| v.as_str())
                    .map(String::from);
                let cancelled = value
                    .get("cancelled")
                    .and_then(|v| v.as_bool())
                    .unwrap_or(false);
                if !cancelled {
                    let _ = crate::commands::flight_attempts::update_attempt_status_by_session(
                        &session_id,
                        crate::core::flight::AttemptStatus::Reviewing,
                        None,
                    )
                    .await;
                }
                let _ = self.app_handle.emit(
                    &done_event(&session_id),
                    DonePayload {
                        input_tokens,
                        output_tokens,
                        cache_read_input_tokens,
                        cache_creation_input_tokens,
                        cancelled,
                        resume_token,
                    },
                );

                // E10-SUMMARIZE — resolve any one-shot waiter for this
                // session with the accumulated buffer. Remove the entry
                // so subsequent terminal events (in pathological races)
                // don't try to re-send. `send` ignores the result because
                // a dropped receiver (caller-side timeout / cancel) is
                // not an error from the supervisor's perspective.
                {
                    let mut waiters = self.oneshot_waiters.lock().await;
                    if let Some(mut waiter) = waiters.remove(&session_id) {
                        if let Some(sender) = waiter.sender.take() {
                            let _ = sender.send(Ok(std::mem::take(&mut waiter.buffer)));
                        }
                    }
                }

                // A `done` event marks the current turn complete, not the
                // lifetime of the sidecar conversation. Keep ownership so the
                // next send/cancel/model change still routes to the sidecar.
            }
            "plan_block" => {
                let items: Vec<PlanItemPayload> = value
                    .get("items")
                    .and_then(|v| v.as_array())
                    .map(|arr| {
                        arr.iter()
                            .filter_map(|item| {
                                let content =
                                    item.get("content").and_then(|v| v.as_str())?.to_string();
                                let status = item
                                    .get("status")
                                    .and_then(|v| v.as_str())
                                    .unwrap_or("pending")
                                    .to_string();
                                let id = item.get("id").and_then(|v| v.as_str()).map(String::from);
                                let active_form = item
                                    .get("activeForm")
                                    .and_then(|v| v.as_str())
                                    .map(String::from);
                                Some(PlanItemPayload {
                                    id,
                                    content,
                                    status,
                                    active_form,
                                })
                            })
                            .collect()
                    })
                    .unwrap_or_default();
                let _ = self
                    .app_handle
                    .emit(&plan_block_event(&session_id), PlanBlockPayload { items });
            }
            "mcp_sources" => {
                // S8-Phase-B (Slice B): pure translation of the remote
                // sidecar's MCP-sourcing summary. Names/transport/scope +
                // read errors only — the sidecar never puts secrets here.
                let sources: Vec<McpSourceInfo> = value
                    .get("sources")
                    .and_then(|v| v.as_array())
                    .map(|arr| {
                        arr.iter()
                            .filter_map(|item| {
                                let name = item.get("name").and_then(|v| v.as_str())?.to_string();
                                let transport = item
                                    .get("transport")
                                    .and_then(|v| v.as_str())
                                    .unwrap_or("stdio")
                                    .to_string();
                                let scope = item
                                    .get("scope")
                                    .and_then(|v| v.as_str())
                                    .unwrap_or("project")
                                    .to_string();
                                Some(McpSourceInfo {
                                    name,
                                    transport,
                                    scope,
                                })
                            })
                            .collect()
                    })
                    .unwrap_or_default();
                let read_errors: Vec<McpReadError> = value
                    .get("readErrors")
                    .and_then(|v| v.as_array())
                    .map(|arr| {
                        arr.iter()
                            .filter_map(|item| {
                                let scope = item
                                    .get("scope")
                                    .and_then(|v| v.as_str())
                                    .unwrap_or("project")
                                    .to_string();
                                let path = item.get("path").and_then(|v| v.as_str())?.to_string();
                                let message = item
                                    .get("message")
                                    .and_then(|v| v.as_str())
                                    .unwrap_or("")
                                    .to_string();
                                Some(McpReadError {
                                    scope,
                                    path,
                                    message,
                                })
                            })
                            .collect()
                    })
                    .unwrap_or_default();
                let _ = self.app_handle.emit(
                    &mcp_sources_event(&session_id),
                    McpSourcesPayload {
                        sources,
                        read_errors,
                    },
                );
            }
            "tool_output_extended" => {
                let id = value
                    .get("toolUseId")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();
                let exit_code = value.get("exitCode").and_then(|v| v.as_i64());
                let modified_paths =
                    value
                        .get("modifiedPaths")
                        .and_then(|v| v.as_array())
                        .map(|arr| {
                            arr.iter()
                                .filter_map(|s| s.as_str().map(String::from))
                                .collect()
                        });
                let stdout = value
                    .get("stdout")
                    .and_then(|v| v.as_str())
                    .map(String::from);
                let stderr = value
                    .get("stderr")
                    .and_then(|v| v.as_str())
                    .map(String::from);
                let _ = self.app_handle.emit(
                    &tool_output_extended_event(&session_id),
                    ToolOutputExtendedPayload {
                        id,
                        exit_code,
                        modified_paths,
                        stdout,
                        stderr,
                    },
                );
            }
            "turn_summary" => {
                let input_tokens = value
                    .get("inputTokens")
                    .and_then(|v| v.as_u64())
                    .unwrap_or(0);
                let output_tokens = value
                    .get("outputTokens")
                    .and_then(|v| v.as_u64())
                    .unwrap_or(0);
                let cache_read_input_tokens = value
                    .get("cacheReadInputTokens")
                    .and_then(|v| v.as_u64())
                    .unwrap_or(0);
                let cache_creation_input_tokens = value
                    .get("cacheCreationInputTokens")
                    .and_then(|v| v.as_u64())
                    .unwrap_or(0);
                let reasoning_tokens = value.get("reasoningTokens").and_then(|v| v.as_u64());
                let address = value
                    .get("address")
                    .and_then(|v| v.as_str())
                    .filter(|s| !s.is_empty())
                    .map(String::from);
                let address_for_async = address.clone();
                let _ = self.app_handle.emit(
                    &turn_summary_event(&session_id),
                    TurnSummaryPayload {
                        input_tokens,
                        output_tokens,
                        cache_read_input_tokens,
                        cache_creation_input_tokens,
                        reasoning_tokens,
                        address,
                    },
                );

                // E8-ACCUM — accumulate this turn's token + cost spend onto
                // the owning Flight DTO for executor sidecar sessions linked
                // to a flight via `attempt.session_id` or `task.session_id`.
                // Rolls up onto `flight.total_tokens` / `total_cost`; lookup
                // via the on-disk PersistedState. After persisting, emits the
                // fixed-name `flight:cost-updated` event consumed by the
                // bootstrap-registered flightStore listener so the frontend's
                // in-memory `flight.totalCost` / `totalTokens` (budget
                // hard-stop, launch guardrail, StatGrid cost chip) track the
                // spend live instead of waiting for the next hydrate.
                //
                // The same delta also feeds the PacketBench-owned usage ledger
                // (`~/.packetbench/usage.jsonl`) — for EVERY sidecar session,
                // flight-linked or not — so sidecar spend reaches the
                // analytics rollup and the daily/monthly budget guardrails
                // that read it. The two writes are independent stores: the
                // flight rollup is a per-flight display total, the ledger is
                // the guardrail input.
                //
                // Provider semantics differ: the Anthropic provider emits
                // genuine per-message deltas, but the retired `openai-codex`
                // provider emitted SESSION-CUMULATIVE running totals on every
                // `token_count` update ("replace, not accumulate"). The
                // provider is gone, so this snapshot-delta path is reachable
                // only for historical flight attempts persisted with
                // `provider == "openai-codex"`; it is retained so old data
                // cannot double-count, not because any live session uses it.
                //
                // Async-dispatched so we never block the sidecar event loop
                // on the `with_state_lock` mutex, and short-circuits cleanly
                // for sessions with neither ledger metadata nor a flight
                // role.
                let session_for_async = session_id.clone();
                let app_for_async = self.app_handle.clone();
                let snapshots = std::sync::Arc::clone(&self.exec_token_snapshots);
                let usage_meta = std::sync::Arc::clone(&self.session_usage_meta);
                // Order guard for the cumulative-delta accounting below: the
                // rollup runs in an unordered spawned task whose
                // variable-latency load_state() means a newer/larger codex
                // snapshot can reach the lock before an older/smaller one —
                // which would read as a counter reset and re-roll the full
                // session-cumulative as new spend. Stamp each turn_summary
                // with a monotonic sequence HERE (events for one session are
                // dispatched sequentially by their reader loop, so stamps
                // reflect per-session arrival order) and drop out-of-order
                // events under the lock; the next in-order event's delta
                // self-corrects.
                let seq = self
                    .exec_turn_seq
                    .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                tauri::async_runtime::spawn(async move {
                    // Two independent consumers of this turn's delta:
                    //   * the usage ledger (`~/.packetbench/usage.jsonl`) — fed for
                    //     EVERY sidecar session via the supervisor's start-time
                    //     provider/model registry, so standalone chats meter too;
                    //   * the flight cost rollup — only for sessions linked to a
                    //     flight via attempt/task session_id.
                    let meta = usage_meta.lock().await.get(&session_for_async).cloned();
                    let state_snap = crate::core::storage::load_state();
                    let owner = crate::commands::flight_cost::flight_for_executor_session(
                        &state_snap,
                        &session_for_async,
                    );
                    if meta.is_none() && owner.is_none() {
                        return;
                    }
                    // Retired-Codex `turn_summary` events carried
                    // session-cumulative totals — accumulate only the delta
                    // since the previous snapshot. Every live provider
                    // (claude-oauth / openai-agents) reports per-turn. The
                    // discriminator stays the flight linkage's provider field
                    // (historical codex task sessions are only reachable
                    // through it); ownerless sessions are always per-turn.
                    let cumulative = owner.as_ref().is_some_and(|o| o.provider == "openai-codex");
                    let (d_in, d_out, d_cr, d_cc) = if cumulative {
                        let key = (
                            session_for_async.clone(),
                            address_for_async.unwrap_or_default(),
                        );
                        let cur = [
                            input_tokens,
                            output_tokens,
                            cache_read_input_tokens,
                            cache_creation_input_tokens,
                        ];
                        let mut map = snapshots.lock().await;
                        let prev_entry = map.get(&key).copied();
                        if let Some((prev_seq, _)) = prev_entry {
                            if seq < prev_seq {
                                // Out-of-order arrival: a newer snapshot was
                                // already processed for this (session,
                                // address). Drop this event — its spend is
                                // subsumed by the newer snapshot's delta.
                                return;
                            }
                        }
                        let prev = prev_entry.map(|(_, totals)| totals).unwrap_or([0; 4]);
                        // Counter reset (new codex process): any component
                        // shrinking means the cumulative counter restarted —
                        // re-baseline at zero so the new spend is counted
                        // once in full.
                        let base = if (0..4).any(|i| cur[i] < prev[i]) {
                            [0; 4]
                        } else {
                            prev
                        };
                        map.insert(key, (seq, cur));
                        (
                            cur[0] - base[0],
                            cur[1] - base[1],
                            cur[2] - base[2],
                            cur[3] - base[3],
                        )
                    } else {
                        (
                            input_tokens,
                            output_tokens,
                            cache_read_input_tokens,
                            cache_creation_input_tokens,
                        )
                    };
                    let exec_total_tokens = d_in
                        .saturating_add(d_out)
                        .saturating_add(d_cr)
                        .saturating_add(d_cc);
                    if exec_total_tokens == 0 {
                        // Nothing new to roll up (repeat cumulative snapshot).
                        return;
                    }
                    // Usage ledger first, so a missing/foreign flight can
                    // never drop the spend from the guardrail input
                    // (`read_usage_analytics` → costGuardrails). Prefer the
                    // start-time registry — it tracks `set_model` hot-swaps
                    // and carries the real sidecar provider id — and fall
                    // back to the flight linkage's fields for sessions whose
                    // registry entry is already gone. This is the ONLY
                    // ledger writer for sidecar sessions (the `done` event
                    // carries turn totals already summed here), so each
                    // turn is recorded exactly once.
                    let ledger = meta
                        .as_ref()
                        .map(|m| (m.provider.clone(), m.model.clone()))
                        .or_else(|| {
                            owner
                                .as_ref()
                                .map(|o| (o.provider.clone(), o.model.clone()))
                        });
                    if let Some((provider, model)) = ledger {
                        // Skip the dev-only echo smoke provider and
                        // model-less task linkages — a row that can't be
                        // priced or attributed is noise in analytics.
                        if provider != "echo" && !model.is_empty() {
                            let entry = super::sidecar_usage_entry(
                                &provider,
                                &model,
                                &session_for_async,
                                d_in,
                                d_out,
                                d_cr,
                                d_cc,
                            );
                            if let Err(e) = crate::commands::usage::append_usage_entry(&entry) {
                                warn!(
                                    session_id = %session_for_async,
                                    error = %e,
                                    "Failed to persist sidecar API-agent usage"
                                );
                            }
                        }
                    }
                    let Some(owner) = owner else {
                        // Standalone chat: metered above, no flight to roll
                        // up onto.
                        return;
                    };
                    let exec_cost_usd = crate::commands::pricing::calculate_cost(
                        &owner.model,
                        d_in,
                        d_out,
                        d_cr,
                        d_cc,
                    );
                    if let Err(e) = crate::commands::flight_cost::accumulate_executor_cost(
                        &owner.flight_id,
                        exec_total_tokens,
                        exec_cost_usd,
                    )
                    .await
                    {
                        warn!(
                            flight_id = %owner.flight_id,
                            error = %e,
                            "E8-ACCUM: failed to accumulate executor cost"
                        );
                    } else {
                        let _ = app_for_async.emit(
                            "flight:cost-updated",
                            serde_json::json!({
                                "flightId": owner.flight_id,
                                "inputTokens": d_in,
                                "outputTokens": d_out,
                                "cacheReadInputTokens": d_cr,
                                "cacheCreationInputTokens": d_cc,
                                "totalTokens": exec_total_tokens,
                                "costUsd": exec_cost_usd,
                                "source": "executor",
                            }),
                        );
                    }
                });
            }
            "error" => {
                let message = value
                    .get("message")
                    .and_then(|v| v.as_str())
                    .unwrap_or("unknown sidecar error")
                    .to_string();
                let _ = crate::commands::flight_attempts::update_attempt_status_by_session(
                    &session_id,
                    crate::core::flight::AttemptStatus::Failed,
                    Some(message.clone()),
                )
                .await;
                let _ = self.app_handle.emit(
                    &error_event(&session_id),
                    ErrorPayload {
                        message: message.clone(),
                    },
                );
                // Per-turn errors are recoverable: the sidecar registry only
                // deletes a session on START-time failure (session-registry.ts
                // startNow), and the codex provider spawns a fresh
                // `codex exec resume` every turn. Ownership is lifecycle
                // state (see protocol.rs forward_send) — dropping it here
                // would reroute the next send/retry into the in-process
                // runtime ("No active session") and permanently brick the
                // conversation while leaking the sidecar-side session.
                // Lifetime cleanup is owned by forward_close and by the
                // supervisor's crash fan-out, both of which already clear
                // ownership and the SSH remote route.

                // E10-SUMMARIZE — resolve any one-shot waiter for this
                // session with the error. The compaction summarizer treats
                // `Err` as a hard fail and degrades gracefully (no compaction
                // this cycle), so we propagate the SDK / sidecar message
                // verbatim.
                {
                    let mut waiters = self.oneshot_waiters.lock().await;
                    if let Some(mut waiter) = waiters.remove(&session_id) {
                        if let Some(sender) = waiter.sender.take() {
                            let _ = sender.send(Err(message.clone()));
                        }
                    }
                }
                // Record the most-recent per-session error so the chip's
                // tooltip has something meaningful if the supervisor later
                // transitions to `down`. Does not change `state`.
                self.update_status(|s| {
                    s.last_error = Some(message.clone());
                })
                .await;
            }
            "rate_limited" => {
                // v6 (E6-CEILING-RATELIMIT): the Anthropic provider caught
                // a `RateLimitError` (HTTP 429) from the SDK and surfaced
                // it as a typed event alongside its regular `error` emit.
                // The regular `error` event has already been emitted (see
                // above), so the session surfaces the failure to the user;
                // here we just record the rate-limit signal to the log.
                let retry_after_seconds = value.get("retryAfterSeconds").and_then(|v| v.as_f64());
                let message = value
                    .get("message")
                    .and_then(|v| v.as_str())
                    .map(String::from);
                tracing::info!(
                    session_id = %session_id,
                    retry_after_seconds = ?retry_after_seconds,
                    message = ?message,
                    "sidecar reported rate-limit error"
                );
            }
            other => {
                warn!(
                    event_type = %other,
                    "agent sidecar emitted unknown event type"
                );
            }
        }
    }
}

/// Trim a string for log output.
pub(super) fn truncate(s: &str, max: usize) -> String {
    if s.len() <= max {
        s.to_string()
    } else {
        // G03: `max` may land in the middle of a multibyte UTF-8 codepoint, which
        // would panic when slicing. Walk back to the nearest char boundary first.
        let mut end = max;
        while end > 0 && !s.is_char_boundary(end) {
            end -= 1;
        }
        format!("{}…", &s[..end])
    }
}
