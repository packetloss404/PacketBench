//! Shared OpenAI-compatible chat completions implementation.
//!
//! Used by OpenAI, MiniMax, OpenRouter, and Ollama providers.

use crate::core::llm_provider::delimit_final_sse_line;
use crate::core::llm_types::*;
use futures::StreamExt;
use reqwest::header::{HeaderMap, HeaderValue, AUTHORIZATION, CONTENT_TYPE};
use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use tokio::sync::mpsc;

/// Configuration for an OpenAI-compatible endpoint.
pub struct OpenAiCompatConfig {
    pub base_url: String,
    pub headers: HeaderMap,
    pub provider_id: String,
}

/// Per-process memo of "does this endpoint accept optional parameter X?",
/// keyed by `"<param>|<endpoint scope>"`. Populated by the negotiate-once /
/// retry-without pattern below so one 400 does not repeat on every turn.
fn compat_capabilities() -> &'static Mutex<HashMap<String, bool>> {
    static CAPABILITIES: OnceLock<Mutex<HashMap<String, bool>>> = OnceLock::new();
    CAPABILITIES.get_or_init(|| Mutex::new(HashMap::new()))
}

fn capability_key(param: &str, scope: &str) -> String {
    format!("{}|{}", param, scope)
}

fn cached_capability(param: &str, scope: &str) -> Option<bool> {
    compat_capabilities()
        .lock()
        .ok()
        .and_then(|capabilities| capabilities.get(&capability_key(param, scope)).copied())
}

fn remember_capability(param: &str, scope: &str, supported: bool) {
    if let Ok(mut capabilities) = compat_capabilities().lock() {
        capabilities.insert(capability_key(param, scope), supported);
    }
}

/// Does this error body look like "I do not know that optional parameter"
/// (as opposed to a real request error we must surface)? Conservative on
/// purpose: only an explicit 400 naming the parameter counts.
fn rejects_parameter(status: reqwest::StatusCode, body: &str, param: &str) -> bool {
    if status != reqwest::StatusCode::BAD_REQUEST {
        return false;
    }
    let message = body.to_ascii_lowercase();
    message.contains(param)
        && [
            "unknown",
            "unrecognized",
            "unsupported",
            "not permitted",
            "extra inputs",
            "invalid parameter",
        ]
        .iter()
        .any(|needle| message.contains(needle))
}

fn rejects_stream_usage(status: reqwest::StatusCode, body: &str) -> bool {
    rejects_parameter(status, body, "stream_options")
}

/// Convert our internal messages to the OpenAI chat format.
/// If `attachments` is non-empty, inline them into the LAST ChatRole::User message as image_url blocks.
fn build_openai_messages(
    messages: &[ChatMessage],
    system_prompt: Option<&str>,
    attachments: &[ImageAttachment],
    provider: &str,
) -> Vec<serde_json::Value> {
    let mut out = Vec::new();

    if let Some(sp) = system_prompt {
        out.push(serde_json::json!({
            "role": "system",
            "content": sp,
        }));
    }

    let last_user_idx = messages
        .iter()
        .rposition(|m| matches!(m.role, ChatRole::User));

    for (idx, msg) in messages.iter().enumerate() {
        match &msg.role {
            ChatRole::User => {
                let is_last_user = Some(idx) == last_user_idx;
                if is_last_user && !attachments.is_empty() {
                    let mut parts: Vec<serde_json::Value> = vec![serde_json::json!({
                        "type": "text",
                        "text": msg.content.as_text(),
                    })];
                    for a in attachments {
                        parts.push(serde_json::json!({
                            "type": "image_url",
                            "image_url": {
                                "url": format!("data:{};base64,{}", a.media_type, a.data_base64),
                            },
                        }));
                    }
                    out.push(serde_json::json!({
                        "role": "user",
                        "content": parts,
                    }));
                } else {
                    out.push(serde_json::json!({
                        "role": "user",
                        "content": msg.content.as_text(),
                    }));
                }
            }
            ChatRole::Assistant => {
                // Check if content has tool call blocks
                if let MessageContent::Blocks(blocks) = &msg.content {
                    let mut text_parts = Vec::new();
                    let mut tool_calls = Vec::new();
                    let mut reasoning: Option<serde_json::Value> = None;
                    for block in blocks {
                        match block {
                            ContentBlock::Text { text } => text_parts.push(text.clone()),
                            ContentBlock::ToolUse {
                                id,
                                name,
                                arguments,
                            } => {
                                tool_calls.push(serde_json::json!({
                                    "id": id,
                                    "type": "function",
                                    "function": {
                                        "name": name,
                                        "arguments": arguments.to_string(),
                                    },
                                }));
                            }
                            ContentBlock::ProviderReasoning { details } => {
                                reasoning = Some(details.clone());
                            }
                            _ => {}
                        }
                    }
                    let mut entry = serde_json::json!({ "role": "assistant" });
                    if !text_parts.is_empty() {
                        entry["content"] = serde_json::Value::String(text_parts.join("\n"));
                    } else {
                        entry["content"] = serde_json::Value::Null;
                    }
                    if !tool_calls.is_empty() {
                        entry["tool_calls"] = serde_json::Value::Array(tool_calls);
                    }
                    // MiniMax M3 interleaved thinking: the provider's own
                    // reasoning payload must be replayed verbatim on the
                    // assistant turn, or the reasoning chain breaks across
                    // tool rounds and the model degrades at agent work.
                    // Providers that never emit one never get the field.
                    if let Some(details) = reasoning {
                        if details["compat_provider"] == provider {
                            if let Some(value) = details.get("reasoning_content") {
                                entry["reasoning_content"] = value.clone();
                            }
                            if let Some(value) = details.get("reasoning_details") {
                                entry["reasoning_details"] = value.clone();
                            }
                            if let Some(calls) = entry["tool_calls"].as_array_mut() {
                                for call in calls {
                                    let id = call["id"].as_str().unwrap_or("").to_string();
                                    if let Some(extra) = details["tool_metadata"].get(&id) {
                                        call["extra_content"] = extra.clone();
                                    }
                                }
                            }
                        } else if details.is_array() {
                            entry["reasoning_details"] = details;
                        }
                    }
                    out.push(entry);
                } else {
                    out.push(serde_json::json!({
                        "role": "assistant",
                        "content": msg.content.as_text(),
                    }));
                }
            }
            ChatRole::Tool => {
                // Tool results reference the tool_call_id
                if let MessageContent::Blocks(blocks) = &msg.content {
                    for block in blocks {
                        if let ContentBlock::ToolResult {
                            tool_call_id,
                            content,
                            ..
                        } = block
                        {
                            out.push(serde_json::json!({
                                "role": "tool",
                                "tool_call_id": tool_call_id,
                                "content": content,
                            }));
                        }
                    }
                }
            }
            ChatRole::System => {
                out.push(serde_json::json!({
                    "role": "system",
                    "content": msg.content.as_text(),
                }));
            }
        }
    }
    out
}

/// Convert our tool definitions to the OpenAI function-calling format.
fn build_openai_tools(tools: &[ToolDefinition]) -> Vec<serde_json::Value> {
    tools
        .iter()
        .map(|t| {
            serde_json::json!({
                "type": "function",
                "function": {
                    "name": t.name,
                    "description": t.description,
                    "parameters": t.parameters,
                },
            })
        })
        .collect()
}

/// G16: per-`index` accumulator for a streamed tool call. OpenAI-compatible
/// streams send parallel tool calls distinguished only by a `tool_calls[].index`,
/// and their argument deltas can interleave — so we accumulate each call's id /
/// name / args independently instead of a single "current tool" scalar (which
/// collapsed or cross-contaminated parallel calls).
#[derive(Default)]
struct ToolCallAcc {
    id: String,
    name: String,
    args: String,
    started: bool,
}

/// G16: fold one streamed `tool_calls[]` delta into the per-index accumulator,
/// returning the `ToolUseStart` / `ToolUseInputDelta` chunks to emit for it.
/// Pure (no I/O) so the parallel/interleaved behavior is unit-testable.
fn accumulate_tool_call_delta(
    tc: &serde_json::Value,
    calls: &mut std::collections::BTreeMap<i64, ToolCallAcc>,
) -> Vec<StreamChunk> {
    let mut out = Vec::new();
    let index = tc.get("index").and_then(|i| i.as_i64()).unwrap_or(0);
    let new_id = tc
        .get("id")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty());
    let acc = calls.entry(index).or_default();

    // Non-standard providers that OMIT `index` reuse slot 0 for sequential
    // calls. A new, different `id` at an already-started slot therefore means the
    // previous call finished — roll it before starting the new one. (Compliant
    // providers send `id` only on a call's first delta, so this never fires for
    // real parallel calls, which land on distinct indexes.)
    if let Some(id) = new_id {
        if acc.started && !acc.id.is_empty() && acc.id != id {
            if let Some(end) = finish_tool_acc(std::mem::take(acc)) {
                out.push(end);
            }
        }
        acc.id = id.to_string();
    }
    let function = match tc.get("function") {
        Some(f) => f,
        None => return out,
    };
    if let Some(name) = function.get("name").and_then(|n| n.as_str()) {
        if !name.is_empty() {
            acc.name = name.to_string();
        }
    }
    // Emit ToolUseStart once, when the call is first identified.
    if !acc.started && (!acc.id.is_empty() || !acc.name.is_empty()) {
        acc.started = true;
        out.push(StreamChunk::ToolUseStart {
            id: acc.id.clone(),
            name: acc.name.clone(),
        });
    }
    if let Some(args_delta) = function.get("arguments").and_then(|a| a.as_str()) {
        acc.args.push_str(args_delta);
        out.push(StreamChunk::ToolUseInputDelta {
            delta: args_delta.to_string(),
        });
    }
    out
}

/// Build the terminal `ToolUseEnd` for one accumulated call, parsing its args
/// (warning + coercing to `{}` on malformed JSON). None for an empty slot.
fn finish_tool_acc(acc: ToolCallAcc) -> Option<StreamChunk> {
    if acc.id.is_empty() && acc.name.is_empty() && acc.args.is_empty() {
        return None;
    }
    let name_for_log = acc.name.clone();
    let args = serde_json::from_str(&acc.args).unwrap_or_else(|e| {
        tracing::warn!(error = %e, tool = %name_for_log, "malformed tool-arg JSON from stream; coercing to empty object");
        serde_json::Value::Object(serde_json::Map::new())
    });
    Some(StreamChunk::ToolUseEnd {
        id: acc.id,
        name: acc.name,
        arguments: args,
    })
}

/// Fields of a `reasoning_details` object that stream in fragments and must be
/// concatenated. Everything else (`type`, `id`, `format`, `index`, `signature`)
/// is a scalar that the last delta wins.
const REASONING_TEXT_FIELDS: [&str; 3] = ["text", "summary", "data"];

/// Accumulator for MiniMax-style `reasoning_details`, which arrive spread
/// across streaming deltas as an array of objects distinguished by `index`.
///
/// The payload is treated as **opaque**: we never interpret it, we only have to
/// hand the completed array back to the provider verbatim on the next request
/// (MiniMax M3's interleaved-thinking contract). A `BTreeMap` keyed on `index`
/// keeps replay order identical to the provider's.
#[derive(Default)]
struct ReasoningAcc {
    entries: std::collections::BTreeMap<i64, serde_json::Map<String, serde_json::Value>>,
}

impl ReasoningAcc {
    /// Fold one delta's `reasoning_details` array in, returning the
    /// newly-arrived human-readable text so the caller can stream it to the
    /// thinking pane. Pure (no I/O) so the fragment handling is unit-testable.
    fn absorb(&mut self, raw: &serde_json::Value) -> String {
        let Some(items) = raw.as_array() else {
            return String::new();
        };
        let mut fresh = String::new();
        for item in items {
            let Some(obj) = item.as_object() else {
                continue;
            };
            let index = obj.get("index").and_then(|i| i.as_i64()).unwrap_or(0);
            let slot = self.entries.entry(index).or_default();
            for (key, value) in obj {
                if REASONING_TEXT_FIELDS.contains(&key.as_str()) {
                    let Some(fragment) = value.as_str() else {
                        continue;
                    };
                    // "data" is opaque/encrypted — accumulate it, but never
                    // surface it as thinking text.
                    if key != "data" {
                        fresh.push_str(fragment);
                    }
                    match slot.get_mut(key) {
                        Some(serde_json::Value::String(existing)) => existing.push_str(fragment),
                        _ => {
                            slot.insert(
                                key.clone(),
                                serde_json::Value::String(fragment.to_string()),
                            );
                        }
                    }
                } else {
                    slot.insert(key.clone(), value.clone());
                }
            }
        }
        fresh
    }

    fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    /// The completed array, in `index` order, ready to replay.
    fn finish(&mut self) -> serde_json::Value {
        serde_json::Value::Array(
            std::mem::take(&mut self.entries)
                .into_values()
                .map(serde_json::Value::Object)
                .collect(),
        )
    }
}

/// Drain the accumulator into a `ToolUseEnd` per call, in `index` order. Pure.
fn drain_tool_calls(calls: &mut std::collections::BTreeMap<i64, ToolCallAcc>) -> Vec<StreamChunk> {
    std::mem::take(calls)
        .into_iter()
        .filter_map(|(_index, acc)| finish_tool_acc(acc))
        .collect()
}

/// Emit `ToolUseEnd` for every accumulated tool call, then clear the
/// accumulator. Called at each stream terminator (finish_reason, `[DONE]`, and
/// the post-loop finalize).
async fn flush_tool_calls(
    tx: &mpsc::Sender<StreamChunk>,
    calls: &mut std::collections::BTreeMap<i64, ToolCallAcc>,
) {
    for chunk in drain_tool_calls(calls) {
        let _ = tx.send(chunk).await;
    }
}

/// Terminal sequence for one streamed turn: flush accumulated tool calls,
/// close the thinking block, hand back the provider's reasoning payload, then
/// signal `Done`.
///
/// `ReasoningDetails` must precede `Done` — consumers stop reading at `Done`.
///
/// Token semantics are the **vendor's own, unmodified**: OpenAI-family
/// endpoints report `prompt_tokens` as a SUPERSET that already contains
/// `prompt_tokens_details.cached_tokens`, whereas Anthropic's buckets are
/// disjoint. Normalising here would double-subtract, because both cost engines
/// already branch on the shared table's `inputIncludesCacheRead` flag. There is
/// no cache-*write* count to report: OpenAI-style caching is automatic and
/// writes are not billed or counted.
#[allow(clippy::too_many_arguments)]
async fn finish_compat_turn(
    tx: &mpsc::Sender<StreamChunk>,
    tool_calls: &mut std::collections::BTreeMap<i64, ToolCallAcc>,
    reasoning: &mut ReasoningAcc,
    thinking_open: &mut bool,
    input_tokens: u64,
    output_tokens: u64,
    cached_tokens: u64,
    replay: &mut CompatReplay,
) {
    flush_tool_calls(tx, tool_calls).await;
    if *thinking_open {
        *thinking_open = false;
        let _ = tx.send(StreamChunk::ThinkingStop).await;
    }
    let details = if replay.has_data() {
        let mut details = replay.finish();
        if !reasoning.is_empty() {
            details["reasoning_details"] = reasoning.finish();
        }
        Some(details)
    } else if !reasoning.is_empty() {
        Some(reasoning.finish())
    } else {
        None
    };
    if let Some(details) = details {
        let _ = tx.send(StreamChunk::ReasoningDetails { details }).await;
    }
    let _ = tx
        .send(StreamChunk::Done {
            input_tokens,
            output_tokens,
            cache_read_input_tokens: cached_tokens,
            cache_creation_input_tokens: 0,
        })
        .await;
}

/// Preserve signed tool metadata (Gemini) and reasoning content (coding gateways).
#[derive(Default)]
struct CompatReplay {
    provider: String,
    reasoning: String,
    calls: std::collections::BTreeMap<i64, (String, Option<serde_json::Value>)>,
    completed: std::collections::HashMap<String, serde_json::Value>,
}
impl CompatReplay {
    fn new(provider: &str) -> Self {
        Self {
            provider: provider.into(),
            ..Self::default()
        }
    }
    fn absorb(&mut self, delta: &serde_json::Value) {
        if let Some(text) = delta["reasoning_content"].as_str() {
            self.reasoning.push_str(text);
        }
        if let Some(calls) = delta["tool_calls"].as_array() {
            for call in calls {
                let index = call["index"].as_i64().unwrap_or(0);
                let entry = self.calls.entry(index).or_default();
                if let Some(id) = call["id"].as_str() {
                    if !entry.0.is_empty() && entry.0 != id {
                        if let Some(extra) = entry.1.take() {
                            self.completed.insert(entry.0.clone(), extra);
                        }
                    }
                    entry.0 = id.to_string();
                }
                if let Some(extra) = call.get("extra_content") {
                    entry.1 = Some(extra.clone());
                }
            }
        }
    }
    fn has_data(&self) -> bool {
        !self.reasoning.is_empty()
            || !self.completed.is_empty()
            || self.calls.values().any(|(_, extra)| extra.is_some())
    }
    fn finish(&self) -> serde_json::Value {
        let mut details = serde_json::json!({"compat_provider":self.provider, "tool_metadata":{}});
        if !self.reasoning.is_empty() {
            details["reasoning_content"] = serde_json::json!(self.reasoning);
        }
        for (id, extra) in &self.completed {
            details["tool_metadata"][id] = extra.clone();
        }
        for (id, extra) in self.calls.values() {
            if let Some(extra) = extra {
                details["tool_metadata"][id] = extra.clone();
            }
        }
        details
    }
}

/// Stream a chat completion from an OpenAI-compatible endpoint.
pub async fn stream_chat_compat(
    config: &OpenAiCompatConfig,
    api_key: &str,
    request: LlmRequest,
    tx: mpsc::Sender<StreamChunk>,
) -> Result<(), String> {
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|e| e.to_string())?;
    let url = format!("{}/chat/completions", config.base_url.trim_end_matches('/'));

    let messages = build_openai_messages(
        &request.messages,
        request.system_prompt.as_deref(),
        &request.attachments,
        &config.provider_id,
    );
    let tools = build_openai_tools(&request.tools);

    let mut body = serde_json::json!({
        "model": request.model,
        "messages": messages,
        "stream": true,
        "max_tokens": request.max_tokens,
    });

    // Ollama capability varies by build. Unknown endpoints optimistically
    // negotiate usage once; an explicit unsupported-parameter response is
    // retried without the option and cached for this app process.
    let ollama_usage = config.provider_id == "ollama"
        && cached_capability("stream_options", &config.base_url) != Some(false);
    if matches!(
        config.provider_id.as_str(),
        "openai"
            | "openrouter"
            | "minimax"
            | "sugar"
            | "cline-pass"
            | "opencode-go"
            | "ollama-cloud"
            | "google"
    ) || ollama_usage
    {
        body["stream_options"] = serde_json::json!({ "include_usage": true });
    }

    // MiniMax M3 interleaved thinking. Without `reasoning_split` the model's
    // chain of thought is embedded in `content` inside `<think>` tags, which we
    // would then have to preserve byte-for-byte through the UI. With it, the
    // reasoning arrives as a structured `reasoning_details` array that we
    // accumulate below and replay on the assistant turn — which is what
    // MiniMax's docs require to keep the reasoning chain alive across tool
    // rounds. Scoped per model, because older MiniMax models may 400 on the
    // parameter; that case is negotiated away exactly once (see below).
    let reasoning_scope = format!("{}|{}", config.base_url, request.model);
    let minimax_reasoning_split = config.provider_id == "minimax"
        && cached_capability("reasoning_split", &reasoning_scope) != Some(false);
    if minimax_reasoning_split {
        body["reasoning_split"] = serde_json::json!(true);
    }

    // OpenAI prompt caching is automatic on the prefix hash; `prompt_cache_key`
    // only influences which cache partition the request routes to, raising the
    // hit rate for a long agent loop that re-sends the same prefix. OpenAI-only
    // on purpose — MiniMax / OpenRouter / Ollama do not document the field and
    // a stray unknown parameter is a 400 risk for zero benefit.
    // https://developers.openai.com/api/docs/guides/prompt-caching
    if config.provider_id == "openai" {
        if let Some(ref key) = request.cache_key {
            if !key.is_empty() {
                body["prompt_cache_key"] = serde_json::json!(key);
            }
        }
    }

    if !tools.is_empty() {
        body["tools"] = serde_json::Value::Array(tools);
    }
    if let Some(temp) = request.temperature {
        body["temperature"] = serde_json::json!(temp);
    }

    let mut headers = config.headers.clone();
    if !api_key.is_empty() {
        headers.insert(
            AUTHORIZATION,
            HeaderValue::from_str(&format!("Bearer {}", api_key))
                .map_err(|e| format!("Invalid API key format: {}", e))?,
        );
    }
    headers.insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));

    tracing::info!(
        target: "packetbench::egress",
        service = "openai-compat",
        base_url = %config.base_url,
        model = %request.model,
        "LLM request"
    );
    let response = client
        .post(&url)
        .headers(headers.clone())
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("Request failed: {}", e))?;
    // A non-2xx here is a failed call, so it must not log at the same level as
    // a successful one. Eight 429s in 3 ms read as ordinary traffic while every
    // session summary was being dropped (dogfooding, 2026-09-06) — a failure
    // indistinguishable from success in the log is the same defect class this
    // audit spent its time on.
    if response.status().is_success() {
        tracing::info!(
            target: "packetbench::egress",
            service = "openai-compat",
            base_url = %config.base_url,
            model = %request.model,
            status = response.status().as_u16(),
            "LLM response"
        );
    } else {
        tracing::warn!(
            target: "packetbench::egress",
            service = "openai-compat",
            base_url = %config.base_url,
            model = %request.model,
            status = response.status().as_u16(),
            "LLM response failed"
        );
    }

    let response = if response.status().is_success() {
        if ollama_usage {
            remember_capability("stream_options", &config.base_url, true);
        }
        response
    } else {
        let status = response.status();
        let body_text = response
            .text()
            .await
            .unwrap_or_else(|_| "Failed to read response body".to_string());

        // Negotiate away any optional parameter this endpoint explicitly
        // rejected, remember the answer for the process, and retry once.
        let mut drop_params: Vec<&str> = Vec::new();
        if ollama_usage && rejects_stream_usage(status, &body_text) {
            remember_capability("stream_options", &config.base_url, false);
            drop_params.push("stream_options");
        }
        if minimax_reasoning_split && rejects_parameter(status, &body_text, "reasoning_split") {
            tracing::warn!(
                model = %request.model,
                "MiniMax endpoint rejected reasoning_split; falling back to <think>-in-content"
            );
            remember_capability("reasoning_split", &reasoning_scope, false);
            drop_params.push("reasoning_split");
        }

        if drop_params.is_empty() {
            return Err(format!(
                "{} API error ({}): {}",
                config.provider_id, status, body_text
            ));
        }

        let object = body
            .as_object_mut()
            .expect("OpenAI-compatible request body is an object");
        for param in drop_params {
            object.remove(param);
        }
        client
            .post(&url)
            .headers(headers)
            .json(&body)
            .send()
            .await
            .map_err(|e| format!("{} compatibility retry failed: {}", config.provider_id, e))?
    };

    if !response.status().is_success() {
        let status = response.status();
        let body_text = response
            .text()
            .await
            .unwrap_or_else(|_| "Failed to read response body".to_string());
        return Err(format!(
            "{} API error ({}): {}",
            config.provider_id, status, body_text
        ));
    }

    let mut stream = response.bytes_stream();
    // F46: buffer raw bytes rather than lossy-decoding each chunk. A multibyte
    // UTF-8 char split across two chunks would otherwise be mangled into U+FFFD
    // by a per-chunk from_utf8_lossy. SSE lines are '\n'-terminated (an ASCII
    // byte that cannot occur mid-codepoint), so a complete line is always a
    // complete UTF-8 sequence; we only decode once a full line is buffered.
    let mut buffer: Vec<u8> = Vec::new();
    // G16: tool calls keyed by their streamed `index` (BTreeMap → emitted in
    // index order), so parallel calls with interleaving arg deltas don't collapse.
    let mut tool_calls_acc: std::collections::BTreeMap<i64, ToolCallAcc> =
        std::collections::BTreeMap::new();
    let mut input_tokens: u64 = 0;
    let mut output_tokens: u64 = 0;
    let mut cached_tokens: u64 = 0;
    let mut reasoning = ReasoningAcc::default();
    let mut thinking_open = false;
    let mut replay = CompatReplay::new(&config.provider_id);
    let mut completed = false;

    let mut stream_ended = false;
    loop {
        // RA1: if the consumer dropped the receiver, stop parsing the rest of the
        // upstream HTTP stream instead of draining it into a dead channel.
        if tx.is_closed() {
            return Ok(());
        }
        if !stream_ended {
            match stream.next().await {
                Some(chunk_result) => {
                    let chunk = chunk_result.map_err(|e| format!("Stream error: {}", e))?;
                    buffer.extend_from_slice(&chunk);
                }
                None => {
                    stream_ended = true;
                    delimit_final_sse_line(&mut buffer);
                }
            }
        }

        // Process complete SSE lines
        while let Some(line_end) = buffer.iter().position(|&b| b == b'\n') {
            let line_bytes: Vec<u8> = buffer.drain(..=line_end).collect();
            let line = String::from_utf8_lossy(&line_bytes).trim().to_string();

            if line.is_empty() || line.starts_with(':') {
                continue;
            }

            if line == "data: [DONE]" {
                finish_compat_turn(
                    &tx,
                    &mut tool_calls_acc,
                    &mut reasoning,
                    &mut thinking_open,
                    input_tokens,
                    output_tokens,
                    cached_tokens,
                    &mut replay,
                )
                .await;
                return Ok(());
            }

            if let Some(data) = line.strip_prefix("data:").map(str::trim) {
                if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(data) {
                    if let Some(error) = parsed.get("error") {
                        return Err(format!("{} stream error: {}", config.provider_id, error));
                    }
                    // Extract usage if present
                    if let Some(usage) = parsed.get("usage") {
                        input_tokens = usage
                            .get("prompt_tokens")
                            .and_then(|v| v.as_u64())
                            .unwrap_or(input_tokens);
                        output_tokens = usage
                            .get("completion_tokens")
                            .and_then(|v| v.as_u64())
                            .unwrap_or(output_tokens);
                        // CE9: real cache-read counts instead of a hardcoded 0.
                        // Chat Completions reports them at
                        // `usage.prompt_tokens_details.cached_tokens`, as a
                        // SUBSET of `prompt_tokens` (see finish_compat_turn).
                        cached_tokens = usage
                            .get("prompt_tokens_details")
                            .and_then(|d| d.get("cached_tokens"))
                            .and_then(|v| v.as_u64())
                            .unwrap_or(cached_tokens);
                    }

                    if let Some(choices) = parsed.get("choices").and_then(|c| c.as_array()) {
                        for choice in choices {
                            let delta = match choice.get("delta") {
                                Some(d) => d,
                                None => continue,
                            };

                            replay.absorb(delta);
                            if let Some(text) =
                                delta.get("reasoning_content").and_then(|v| v.as_str())
                            {
                                thinking_open = true;
                                let _ = tx
                                    .send(StreamChunk::ThinkingDelta {
                                        text: text.to_string(),
                                    })
                                    .await;
                            }
                            // Provider-owned reasoning (MiniMax M3
                            // `reasoning_split`). Accumulated for verbatim
                            // replay in history, and mirrored to the thinking
                            // pane so the reasoning stays visible now that it
                            // no longer arrives inside `content`.
                            if let Some(details) = delta.get("reasoning_details") {
                                let fresh = reasoning.absorb(details);
                                if !fresh.is_empty() {
                                    thinking_open = true;
                                    let _ =
                                        tx.send(StreamChunk::ThinkingDelta { text: fresh }).await;
                                }
                            }

                            // Text content
                            if let Some(content) = delta.get("content").and_then(|c| c.as_str()) {
                                if !content.is_empty() {
                                    let _ = tx
                                        .send(StreamChunk::TextDelta {
                                            text: content.to_string(),
                                        })
                                        .await;
                                }
                            }

                            // Tool calls. G16: several may stream in parallel,
                            // distinguished only by `index`; accumulate each
                            // independently rather than flushing on every new
                            // name (which collapsed/cross-contaminated them).
                            if let Some(tool_calls) =
                                delta.get("tool_calls").and_then(|tc| tc.as_array())
                            {
                                for tc in tool_calls {
                                    for chunk in accumulate_tool_call_delta(tc, &mut tool_calls_acc)
                                    {
                                        let _ = tx.send(chunk).await;
                                    }
                                }
                            }

                            // finish_reason terminates the turn — flush every
                            // accumulated tool call (in index order). "stop" is a
                            // defensive extra terminator; flush_tool_calls is a
                            // no-op when nothing was accumulated.
                            if let Some(finish_reason) =
                                choice.get("finish_reason").and_then(|f| f.as_str())
                            {
                                completed = true;
                                if finish_reason == "tool_calls"
                                    || finish_reason == "stop"
                                    || finish_reason == "function_call"
                                {
                                    flush_tool_calls(&tx, &mut tool_calls_acc).await;
                                }
                            }
                        }
                    }
                }
            }
        }

        if stream_ended {
            break;
        }
    }

    if !completed {
        return Err(format!(
            "{} stream ended before completion",
            config.provider_id
        ));
    }
    // A finish_reason is sufficient even when the endpoint omits [DONE].
    finish_compat_turn(
        &tx,
        &mut tool_calls_acc,
        &mut reasoning,
        &mut thinking_open,
        input_tokens,
        output_tokens,
        cached_tokens,
        &mut replay,
    )
    .await;

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::collections::BTreeMap;

    #[test]
    fn signature_replay_handles_repeated_ids_and_indexless_sequential_calls() {
        let mut replay = CompatReplay::new("google");
        replay.absorb(&serde_json::json!({"tool_calls":[{"id":"a", "extra_content":{"google":{"thought_signature":"A"}}}]}));
        replay.absorb(&serde_json::json!({"tool_calls":[{"id":"a"}]}));
        replay.absorb(&serde_json::json!({"tool_calls":[{"id":"b", "extra_content":{"google":{"thought_signature":"B"}}}]}));
        assert_eq!(
            replay.finish()["tool_metadata"]["a"]["google"]["thought_signature"],
            "A"
        );
        assert_eq!(
            replay.finish()["tool_metadata"]["b"]["google"]["thought_signature"],
            "B"
        );
    }

    #[test]
    fn gemini_signatures_survive_parallel_tool_streams_and_history_replay() {
        let mut replay = CompatReplay::new("google");
        replay.absorb(
            &serde_json::json!({"tool_calls":[{"index":0,"id":"first"},{"index":1,"id":"second"}]}),
        );
        replay.absorb(&serde_json::json!({"tool_calls":[{"index":0,"extra_content":{"google":{"thought_signature":"opaque"}}}]}));
        let messages = vec![ChatMessage {
            role: ChatRole::Assistant,
            content: MessageContent::Blocks(vec![
                ContentBlock::ToolUse {
                    id: "first".into(),
                    name: "read_file".into(),
                    arguments: serde_json::json!({}),
                },
                ContentBlock::ToolUse {
                    id: "second".into(),
                    name: "read_file".into(),
                    arguments: serde_json::json!({}),
                },
                ContentBlock::ProviderReasoning {
                    details: replay.finish(),
                },
            ]),
        }];
        let built = build_openai_messages(&messages, None, &[], "google");
        assert_eq!(
            built[0]["tool_calls"][0]["extra_content"]["google"]["thought_signature"],
            "opaque"
        );
        assert!(built[0]["tool_calls"][1].get("extra_content").is_none());
        let other = build_openai_messages(&messages, None, &[], "openai");
        assert!(other[0]["tool_calls"][0].get("extra_content").is_none());
    }

    #[test]
    fn parallel_tool_calls_do_not_cross_contaminate() {
        // G16: interleaved deltas — call 0 starts, call 1 starts, THEN call 0's
        // args, then call 1's args. The old single-scalar parser appended call
        // 0's args onto call 1 (cross-contamination); per-index accumulation
        // keeps them separate.
        let mut acc: BTreeMap<i64, ToolCallAcc> = BTreeMap::new();
        let deltas = [
            json!({"index":0,"id":"call_a","function":{"name":"foo","arguments":""}}),
            json!({"index":1,"id":"call_b","function":{"name":"bar","arguments":""}}),
            json!({"index":0,"function":{"arguments":"{\"x\":1}"}}),
            json!({"index":1,"function":{"arguments":"{\"y\":2}"}}),
        ];
        for d in &deltas {
            let _ = accumulate_tool_call_delta(d, &mut acc);
        }
        let ends = drain_tool_calls(&mut acc);
        assert_eq!(ends.len(), 2, "one ToolUseEnd per parallel call");
        match (&ends[0], &ends[1]) {
            (
                StreamChunk::ToolUseEnd {
                    id: id0,
                    name: n0,
                    arguments: a0,
                },
                StreamChunk::ToolUseEnd {
                    id: id1,
                    name: n1,
                    arguments: a1,
                },
            ) => {
                // Emitted in index order, each with its OWN id/name/args.
                assert_eq!(id0, "call_a");
                assert_eq!(n0, "foo");
                assert_eq!(a0["x"], 1);
                assert_eq!(id1, "call_b");
                assert_eq!(n1, "bar");
                assert_eq!(a1["y"], 2);
            }
            _ => panic!("expected two ToolUseEnd chunks"),
        }
        assert!(acc.is_empty(), "drain clears the accumulator");
    }

    #[test]
    fn accumulate_emits_tool_use_start_once_per_index() {
        let mut acc: BTreeMap<i64, ToolCallAcc> = BTreeMap::new();
        let first = accumulate_tool_call_delta(
            &json!({"index":0,"id":"a","function":{"name":"foo","arguments":"{"}}),
            &mut acc,
        );
        assert!(matches!(first[0], StreamChunk::ToolUseStart { .. }));
        // A second delta for the same index must NOT re-emit ToolUseStart.
        let more =
            accumulate_tool_call_delta(&json!({"index":0,"function":{"arguments":"}"}}), &mut acc);
        assert!(more
            .iter()
            .all(|c| !matches!(c, StreamChunk::ToolUseStart { .. })));
        let ends = drain_tool_calls(&mut acc);
        assert_eq!(ends.len(), 1);
    }

    #[test]
    fn index_omitting_provider_sequential_calls_do_not_collapse() {
        // A non-standard server that omits `index` and streams two calls back to
        // back (each with its own id). The new-id-at-started-slot guard rolls the
        // first call before starting the second, so they don't merge.
        let mut acc: BTreeMap<i64, ToolCallAcc> = BTreeMap::new();
        let mut emitted: Vec<StreamChunk> = Vec::new();
        for d in [
            json!({"id":"c1","function":{"name":"foo","arguments":"{\"x\":1}"}}),
            json!({"id":"c2","function":{"name":"bar","arguments":"{\"y\":2}"}}),
        ] {
            emitted.extend(accumulate_tool_call_delta(&d, &mut acc));
        }
        emitted.extend(drain_tool_calls(&mut acc));
        let ends: Vec<_> = emitted
            .iter()
            .filter(|c| matches!(c, StreamChunk::ToolUseEnd { .. }))
            .collect();
        assert_eq!(ends.len(), 2, "two distinct calls, not one merged");
        if let StreamChunk::ToolUseEnd { id, arguments, .. } = ends[0] {
            assert_eq!(id, "c1");
            assert_eq!(arguments["x"], 1);
        }
        if let StreamChunk::ToolUseEnd { id, arguments, .. } = ends[1] {
            assert_eq!(id, "c2");
            assert_eq!(arguments["y"], 2);
        }
    }

    #[test]
    fn single_tool_call_still_works() {
        let mut acc: BTreeMap<i64, ToolCallAcc> = BTreeMap::new();
        for d in [
            json!({"index":0,"id":"c1","function":{"name":"do","arguments":"{\"a\":"}}),
            json!({"index":0,"function":{"arguments":"true}"}}),
        ] {
            let _ = accumulate_tool_call_delta(&d, &mut acc);
        }
        let ends = drain_tool_calls(&mut acc);
        assert_eq!(ends.len(), 1);
        if let StreamChunk::ToolUseEnd {
            id,
            name,
            arguments,
        } = &ends[0]
        {
            assert_eq!(id, "c1");
            assert_eq!(name, "do");
            assert_eq!(arguments["a"], true);
        } else {
            panic!("expected ToolUseEnd");
        }
    }

    /// MiniMax M3 streams `reasoning_details` in fragments keyed by `index`.
    /// Text fields concatenate; scalars are carried through untouched so the
    /// array we replay is the array the provider built.
    #[test]
    fn reasoning_details_accumulate_by_index_and_concatenate_text() {
        let mut acc = ReasoningAcc::default();
        let a = acc.absorb(&json!([{
            "type": "reasoning.text",
            "id": "reasoning-text-1",
            "format": "MiniMax-response-v1",
            "index": 0,
            "text": "Let me "
        }]));
        let b = acc.absorb(&json!([{ "index": 0, "text": "think." }]));
        let c = acc.absorb(&json!([{ "index": 1, "type": "reasoning.text", "text": "Second." }]));

        assert_eq!(a, "Let me ");
        assert_eq!(b, "think.");
        assert_eq!(c, "Second.");

        let finished = acc.finish();
        let items = finished.as_array().unwrap();
        assert_eq!(items.len(), 2, "one entry per index, in index order");
        assert_eq!(items[0]["text"], "Let me think.");
        assert_eq!(items[0]["format"], "MiniMax-response-v1");
        assert_eq!(items[0]["id"], "reasoning-text-1");
        assert_eq!(items[1]["text"], "Second.");
    }

    /// Encrypted reasoning still round-trips, but must never be shown to the
    /// user as thinking text.
    #[test]
    fn encrypted_reasoning_accumulates_without_surfacing_as_thinking() {
        let mut acc = ReasoningAcc::default();
        let surfaced = acc.absorb(&json!([{
            "type": "reasoning.encrypted", "index": 0, "data": "AAAA"
        }]));
        assert_eq!(surfaced, "", "opaque blobs are not thinking text");
        assert_eq!(acc.finish()[0]["data"], "AAAA");
    }

    /// The MiniMax contract: the assistant turn replayed to the model carries
    /// its `reasoning_details` back verbatim alongside content and tool calls.
    #[test]
    fn assistant_turn_replays_provider_reasoning_details() {
        let details = json!([{ "type": "reasoning.text", "index": 0, "text": "why" }]);
        let messages = vec![ChatMessage {
            role: ChatRole::Assistant,
            content: MessageContent::Blocks(vec![
                ContentBlock::ProviderReasoning {
                    details: details.clone(),
                },
                ContentBlock::Text {
                    text: "calling a tool".to_string(),
                },
                ContentBlock::ToolUse {
                    id: "call_1".to_string(),
                    name: "get_weather".to_string(),
                    arguments: json!({ "location": "SF" }),
                },
            ]),
        }];

        let built = build_openai_messages(&messages, None, &[], "minimax");

        assert_eq!(built.len(), 1);
        assert_eq!(built[0]["reasoning_details"], details);
        assert_eq!(built[0]["content"], "calling a tool");
        assert_eq!(built[0]["tool_calls"][0]["id"], "call_1");
    }

    /// Providers that never emit reasoning must not gain an empty field —
    /// an unexpected key is a 400 risk and changes the cached prefix bytes.
    #[test]
    fn assistant_turn_without_reasoning_omits_the_field() {
        let messages = vec![ChatMessage {
            role: ChatRole::Assistant,
            content: MessageContent::Blocks(vec![ContentBlock::Text {
                text: "plain".to_string(),
            }]),
        }];

        let built = build_openai_messages(&messages, None, &[], "minimax");

        assert!(built[0].get("reasoning_details").is_none());
    }

    #[test]
    fn parameter_rejection_detection_is_per_parameter() {
        assert!(rejects_parameter(
            reqwest::StatusCode::BAD_REQUEST,
            "reasoning_split: Extra inputs are not permitted",
            "reasoning_split"
        ));
        // A rejection naming a DIFFERENT parameter must not drop ours.
        assert!(!rejects_parameter(
            reqwest::StatusCode::BAD_REQUEST,
            "unknown parameter: stream_options",
            "reasoning_split"
        ));
        // Real errors are surfaced, never negotiated away.
        assert!(!rejects_parameter(
            reqwest::StatusCode::TOO_MANY_REQUESTS,
            "reasoning_split unsupported",
            "reasoning_split"
        ));
    }

    #[test]
    fn ollama_usage_negotiation_only_retries_explicit_parameter_rejections() {
        assert!(rejects_stream_usage(
            reqwest::StatusCode::BAD_REQUEST,
            "stream_options: Extra inputs are not permitted"
        ));
        assert!(rejects_stream_usage(
            reqwest::StatusCode::BAD_REQUEST,
            "unrecognized request argument supplied: stream_options"
        ));
        assert!(!rejects_stream_usage(
            reqwest::StatusCode::BAD_REQUEST,
            "model was not found"
        ));
        assert!(!rejects_stream_usage(
            reqwest::StatusCode::INTERNAL_SERVER_ERROR,
            "stream_options unsupported"
        ));
    }
}
