//! Anthropic Messages API provider.

use crate::core::llm_provider::{delimit_final_sse_line, LlmProvider};
use crate::core::llm_types::*;
use futures::StreamExt;
use reqwest::header::{HeaderValue, CONTENT_TYPE};
use tokio::sync::mpsc;

const ANTHROPIC_API_URL: &str = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION: &str = "2023-06-01";

/// CE6 — TTL for the automatic cache breakpoint.
///
/// `None` uses the API default 5-minute window: a cache *write* bills at 1.25x
/// base input and a read at 0.1x, so 5m breaks even after ~2 reads. `Some("1h")`
/// selects the 1-hour window, which bills writes at 2x and therefore needs ~3+
/// reads to break even.
///
/// Deliberately pinned to the 5-minute default. Our agent loop iterates many
/// times within seconds and every cache *read* refreshes the TTL for free, so
/// 5m already survives an entire turn; 1h only helps a user who returns to an
/// idle session between 5 minutes and 1 hour later, and charges every one-shot
/// turn 2x input for the privilege. Flip this to `Some("1h")` only with
/// measured evidence that the idle-return population is large (see
/// `dev/cost-efficiency-loop.md`, SPIKE-3).
const ANTHROPIC_CACHE_TTL: Option<&str> = None;

/// The automatic-caching marker: a single `cache_control` at the **top level**
/// of the request body. The API places the breakpoint on the last cacheable
/// block itself and advances it as the conversation grows, so we never
/// hand-manage breakpoints (that is CE11, deliberately not done yet).
///
/// Shape verified 2026-07-31 against
/// <https://platform.claude.com/docs/en/build-with-claude/prompt-caching>
/// ("Automatic caching ... the recommended starting point for most use cases")
/// and the `POST /v1/messages` reference, which lists a top-level optional
/// `cache_control` of type `CacheControlEphemeral` described as "Top-level
/// cache control automatically applies a cache_control marker to the last
/// cacheable block in the request." No beta header is required.
fn anthropic_cache_control() -> serde_json::Value {
    let mut control = serde_json::json!({ "type": "ephemeral" });
    if let Some(ttl) = ANTHROPIC_CACHE_TTL {
        control["ttl"] = serde_json::json!(ttl);
    }
    control
}

pub struct AnthropicProvider;

/// Convert our messages to Anthropic format (system prompt is separate, tool results use specific format).
/// If `attachments` is non-empty, inline them into the LAST ChatRole::User message as image blocks.
fn build_anthropic_messages(
    messages: &[ChatMessage],
    attachments: &[ImageAttachment],
) -> Vec<serde_json::Value> {
    let mut out = Vec::new();

    // Find the index of the last ChatRole::User message so we can attach images to it.
    let last_user_idx = messages
        .iter()
        .rposition(|m| matches!(m.role, ChatRole::User));

    for (idx, msg) in messages.iter().enumerate() {
        match &msg.role {
            ChatRole::User => {
                let is_last_user = Some(idx) == last_user_idx;
                if is_last_user && !attachments.is_empty() {
                    let mut content_blocks: Vec<serde_json::Value> = attachments
                        .iter()
                        .map(|a| {
                            serde_json::json!({
                                "type": "image",
                                "source": {
                                    "type": "base64",
                                    "media_type": a.media_type,
                                    "data": a.data_base64,
                                },
                            })
                        })
                        .collect();
                    content_blocks.push(serde_json::json!({
                        "type": "text",
                        "text": msg.content.as_text(),
                    }));
                    out.push(serde_json::json!({
                        "role": "user",
                        "content": content_blocks,
                    }));
                } else {
                    out.push(serde_json::json!({
                        "role": "user",
                        "content": msg.content.as_text(),
                    }));
                }
            }
            ChatRole::Assistant => match &msg.content {
                MessageContent::Text(text) => {
                    out.push(serde_json::json!({
                        "role": "assistant",
                        "content": text,
                    }));
                }
                MessageContent::Blocks(blocks) => {
                    if let Some(content) = blocks.iter().find_map(|b| match b {
                        ContentBlock::ProviderReasoning { details } => {
                            details.get("anthropic_content").and_then(|v| v.as_array())
                        }
                        _ => None,
                    }) {
                        out.push(serde_json::json!({"role":"assistant", "content":content}));
                        continue;
                    }
                    let content_blocks: Vec<serde_json::Value> = blocks
                        .iter()
                        .filter_map(|b| match b {
                            ContentBlock::Text { text } => Some(serde_json::json!({
                                "type": "text",
                                "text": text,
                            })),
                            ContentBlock::ToolUse {
                                id,
                                name,
                                arguments,
                            } => Some(serde_json::json!({
                                "type": "tool_use",
                                "id": id,
                                "name": name,
                                "input": arguments,
                            })),
                            _ => None,
                        })
                        .collect();
                    out.push(serde_json::json!({
                        "role": "assistant",
                        "content": content_blocks,
                    }));
                }
            },
            ChatRole::Tool => {
                // Anthropic uses role "user" with tool_result content blocks
                if let MessageContent::Blocks(blocks) = &msg.content {
                    let content_blocks: Vec<serde_json::Value> = blocks
                        .iter()
                        .filter_map(|b| match b {
                            ContentBlock::ToolResult {
                                tool_call_id,
                                content,
                                is_error,
                            } => Some(serde_json::json!({
                                "type": "tool_result",
                                "tool_use_id": tool_call_id,
                                "content": content,
                                "is_error": is_error,
                            })),
                            _ => None,
                        })
                        .collect();
                    out.push(serde_json::json!({
                        "role": "user",
                        "content": content_blocks,
                    }));
                }
            }
            ChatRole::System => {
                // System messages should be passed via the system parameter, not here
            }
        }
    }
    out
}

fn build_anthropic_tools(tools: &[ToolDefinition]) -> Vec<serde_json::Value> {
    tools
        .iter()
        .map(|t| {
            serde_json::json!({
                "name": t.name,
                "description": t.description,
                "input_schema": t.parameters,
            })
        })
        .collect()
}

/// Assemble the Messages API request body. Pure, so the caching contract is
/// unit-testable without a network call.
fn build_anthropic_body(request: &LlmRequest) -> serde_json::Value {
    let messages = build_anthropic_messages(&request.messages, &request.attachments);
    let tools = build_anthropic_tools(&request.tools);

    let mut body = serde_json::json!({
        "model": request.model,
        "messages": messages,
        "max_tokens": request.max_tokens,
        "stream": true,
        // CE6: automatic prompt caching. Must stay at the TOP level — a
        // block-level marker is a different (explicit-breakpoint) mode.
        "cache_control": anthropic_cache_control(),
    });

    if let Some(ref sp) = request.system_prompt {
        // Stays a bare string on purpose: automatic caching does not need the
        // system prompt promoted to a text-block array (that is only required
        // to hang an explicit per-block breakpoint off it).
        body["system"] = serde_json::json!(sp);
    }
    if !tools.is_empty() {
        body["tools"] = serde_json::Value::Array(tools);
    }
    if let Some(temp) = request.temperature {
        body["temperature"] = serde_json::json!(temp);
    }
    if request.thinking_enabled {
        body["thinking"] = serde_json::json!({
            "type": "enabled",
            "budget_tokens": request.thinking_budget_tokens,
        });
    }

    body
}

#[async_trait::async_trait]
impl LlmProvider for AnthropicProvider {
    async fn stream_chat(
        &self,
        api_key: &str,
        request: LlmRequest,
        tx: mpsc::Sender<StreamChunk>,
    ) -> Result<(), String> {
        stream_anthropic_at(
            ANTHROPIC_API_URL,
            reqwest::header::HeaderMap::new(),
            api_key,
            request,
            tx,
        )
        .await
    }

    fn provider_id(&self) -> &str {
        "anthropic"
    }
}

pub async fn stream_anthropic_at(
    url: &str,
    headers: reqwest::header::HeaderMap,
    api_key: &str,
    request: LlmRequest,
    tx: mpsc::Sender<StreamChunk>,
) -> Result<(), String> {
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|e| e.to_string())?;

    let mut body = build_anthropic_body(&request);
    if url != ANTHROPIC_API_URL {
        body.as_object_mut().unwrap().remove("cache_control");
    }

    tracing::info!(
        target: "packetbench::egress",
        service = "anthropic",
        model = %request.model,
        url = url,
        "LLM request"
    );
    let response = client
        .post(url)
        .headers(headers)
        .header("x-api-key", api_key)
        .header("anthropic-version", ANTHROPIC_VERSION)
        .header(CONTENT_TYPE, HeaderValue::from_static("application/json"))
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("Anthropic request failed: {}", e))?;
    // See the note in `llm_openai_compat.rs`: a failed call must not log at
    // the same level as a successful one.
    if response.status().is_success() {
        tracing::info!(
            target: "packetbench::egress",
            service = "anthropic",
            model = %request.model,
            status = response.status().as_u16(),
            "LLM response"
        );
    } else {
        tracing::warn!(
            target: "packetbench::egress",
            service = "anthropic",
            model = %request.model,
            status = response.status().as_u16(),
            "LLM response failed"
        );
    }

    if !response.status().is_success() {
        let status = response.status();
        let body_text = response
            .text()
            .await
            .unwrap_or_else(|_| "Failed to read response".to_string());
        return Err(format!("Anthropic API error ({}): {}", status, body_text));
    }

    let mut stream = response.bytes_stream();
    // F46: buffer raw bytes rather than lossy-decoding each chunk. A multibyte
    // UTF-8 char split across two chunks would otherwise be mangled into U+FFFD
    // by a per-chunk from_utf8_lossy. SSE lines are '\n'-terminated (an ASCII
    // byte that cannot occur mid-codepoint), so a complete line is always a
    // complete UTF-8 sequence; we only decode once a full line is buffered.
    let mut buffer: Vec<u8> = Vec::new();
    let mut current_tool_id = String::new();
    let mut current_tool_name = String::new();
    let mut current_tool_args = String::new();
    let mut current_block_type: &str = "";
    let mut input_tokens: u64 = 0;
    let mut output_tokens: u64 = 0;
    let mut cache_read_input_tokens: u64 = 0;
    let mut cache_creation_input_tokens: u64 = 0;

    let mut replay_blocks: Vec<serde_json::Value> = Vec::new();
    let mut stream_ended = false;
    loop {
        // RA1: if the consumer dropped the receiver, stop parsing the rest of
        // the upstream HTTP stream instead of draining it into a dead channel.
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
                    // SSE permits the final record at EOF without a trailing
                    // newline. Add a parser delimiter so it follows the exact
                    // same path as every other complete line.
                    delimit_final_sse_line(&mut buffer);
                }
            }
        }

        while let Some(line_end) = buffer.iter().position(|&b| b == b'\n') {
            let line_bytes: Vec<u8> = buffer.drain(..=line_end).collect();
            let line = String::from_utf8_lossy(&line_bytes).trim().to_string();

            if line.is_empty() || line.starts_with(':') {
                continue;
            }

            // Anthropic uses "event: <type>" lines followed by "data: <json>"
            if line.starts_with("event:") {
                continue; // We parse the data lines directly
            }

            if let Some(data) = line.strip_prefix("data:").map(str::trim) {
                if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(data) {
                    let event_type = parsed.get("type").and_then(|t| t.as_str()).unwrap_or("");

                    match event_type {
                        "message_start" => {
                            if let Some(usage) = parsed.get("message").and_then(|m| m.get("usage"))
                            {
                                input_tokens = usage
                                    .get("input_tokens")
                                    .and_then(|v| v.as_u64())
                                    .unwrap_or(0);
                                cache_read_input_tokens = usage
                                    .get("cache_read_input_tokens")
                                    .and_then(|v| v.as_u64())
                                    .unwrap_or(0);
                                cache_creation_input_tokens = usage
                                    .get("cache_creation_input_tokens")
                                    .and_then(|v| v.as_u64())
                                    .unwrap_or(0);
                            }
                        }
                        "content_block_start" => {
                            if let Some(cb) = parsed.get("content_block") {
                                replay_blocks.push(cb.clone());
                                let cb_type = cb.get("type").and_then(|t| t.as_str()).unwrap_or("");
                                if cb_type == "tool_use" {
                                    current_block_type = "tool_use";
                                    current_tool_id = cb
                                        .get("id")
                                        .and_then(|id| id.as_str())
                                        .unwrap_or("")
                                        .to_string();
                                    current_tool_name = cb
                                        .get("name")
                                        .and_then(|n| n.as_str())
                                        .unwrap_or("")
                                        .to_string();
                                    current_tool_args.clear();
                                    let _ = tx
                                        .send(StreamChunk::ToolUseStart {
                                            id: current_tool_id.clone(),
                                            name: current_tool_name.clone(),
                                        })
                                        .await;
                                } else if cb_type == "thinking" {
                                    current_block_type = "thinking";
                                } else if cb_type == "text" {
                                    current_block_type = "text";
                                }
                            }
                        }
                        "content_block_delta" => {
                            if let Some(delta) = parsed.get("delta") {
                                let delta_type =
                                    delta.get("type").and_then(|t| t.as_str()).unwrap_or("");
                                if let Some(block) = replay_blocks.last_mut() {
                                    let field = match delta_type {
                                        "text_delta" => Some("text"),
                                        "thinking_delta" => Some("thinking"),
                                        "signature_delta" => Some("signature"),
                                        _ => None,
                                    };
                                    if let Some(field) = field {
                                        let text = format!(
                                            "{}{}",
                                            block[field].as_str().unwrap_or(""),
                                            delta[field].as_str().unwrap_or("")
                                        );
                                        block[field] = serde_json::json!(text);
                                    }
                                }
                                match delta_type {
                                    "text_delta" => {
                                        if let Some(text) =
                                            delta.get("text").and_then(|t| t.as_str())
                                        {
                                            let _ = tx
                                                .send(StreamChunk::TextDelta {
                                                    text: text.to_string(),
                                                })
                                                .await;
                                        }
                                    }
                                    "input_json_delta" => {
                                        if let Some(partial) =
                                            delta.get("partial_json").and_then(|p| p.as_str())
                                        {
                                            current_tool_args.push_str(partial);
                                            let _ = tx
                                                .send(StreamChunk::ToolUseInputDelta {
                                                    delta: partial.to_string(),
                                                })
                                                .await;
                                        }
                                    }
                                    "thinking_delta" => {
                                        if let Some(text) =
                                            delta.get("thinking").and_then(|t| t.as_str())
                                        {
                                            let _ = tx
                                                .send(StreamChunk::ThinkingDelta {
                                                    text: text.to_string(),
                                                })
                                                .await;
                                        }
                                    }
                                    _ => {}
                                }
                            }
                        }
                        "content_block_stop" => {
                            if current_block_type == "tool_use" && !current_tool_id.is_empty() {
                                let args: serde_json::Value = if current_tool_args.is_empty() {
                                    replay_blocks
                                        .last()
                                        .and_then(|b| b.get("input"))
                                        .cloned()
                                        .unwrap_or_else(|| serde_json::json!({}))
                                } else {
                                    serde_json::from_str(&current_tool_args)
                                        .map_err(|_| "Invalid JSON in streamed tool arguments")?
                                };
                                if let Some(block) = replay_blocks.last_mut() {
                                    block["input"] = args.clone();
                                }
                                let _ = tx
                                    .send(StreamChunk::ToolUseEnd {
                                        id: current_tool_id.clone(),
                                        name: current_tool_name.clone(),
                                        arguments: args,
                                    })
                                    .await;
                                current_tool_id.clear();
                                current_tool_name.clear();
                                current_tool_args.clear();
                            } else if current_block_type == "thinking" {
                                let _ = tx.send(StreamChunk::ThinkingStop).await;
                            }
                            current_block_type = "";
                        }
                        "message_delta" => {
                            if let Some(usage) = parsed.get("usage") {
                                output_tokens = usage
                                    .get("output_tokens")
                                    .and_then(|v| v.as_u64())
                                    .unwrap_or(output_tokens);
                                cache_read_input_tokens = usage
                                    .get("cache_read_input_tokens")
                                    .and_then(|v| v.as_u64())
                                    .unwrap_or(cache_read_input_tokens);
                                cache_creation_input_tokens = usage
                                    .get("cache_creation_input_tokens")
                                    .and_then(|v| v.as_u64())
                                    .unwrap_or(cache_creation_input_tokens);
                            }
                        }
                        "message_stop" => {
                            let _ = tx
                                .send(StreamChunk::ReasoningDetails {
                                    details: serde_json::json!({"anthropic_content":replay_blocks}),
                                })
                                .await;
                            let _ = tx
                                .send(StreamChunk::Done {
                                    input_tokens,
                                    output_tokens,
                                    cache_read_input_tokens,
                                    cache_creation_input_tokens,
                                })
                                .await;
                            return Ok(());
                        }
                        "error" => {
                            let msg = parsed
                                .get("error")
                                .and_then(|e| e.get("message"))
                                .and_then(|m| m.as_str())
                                .unwrap_or("Unknown error");
                            return Err(msg.to_string());
                        }
                        _ => {}
                    }
                }
            }
        }

        if stream_ended {
            break;
        }
    }

    Err("Messages stream ended before message_stop".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request() -> LlmRequest {
        LlmRequest {
            model: "claude-opus-4-8".to_string(),
            messages: vec![ChatMessage {
                role: ChatRole::User,
                content: MessageContent::text("hello"),
            }],
            tools: vec![ToolDefinition {
                name: "read_file".to_string(),
                description: "read a file".to_string(),
                parameters: serde_json::json!({ "type": "object" }),
            }],
            system_prompt: Some("you are helpful".to_string()),
            max_tokens: 16384,
            temperature: None,
            attachments: Vec::new(),
            thinking_enabled: false,
            thinking_budget_tokens: 8000,
            cache_key: Some("session-1".to_string()),
        }
    }

    /// CE6 acceptance: every Anthropic request carries the automatic-caching
    /// marker at the TOP level of the body. A block-level marker is a
    /// different mode and would leave automatic caching off.
    #[test]
    fn body_carries_top_level_automatic_cache_control() {
        let body = build_anthropic_body(&request());

        assert_eq!(
            body["cache_control"],
            serde_json::json!({ "type": "ephemeral" }),
            "top-level cache_control must be an ephemeral marker"
        );
    }

    /// The default TTL is the 5-minute window, i.e. `ttl` is *absent*. A
    /// stray `"ttl": "1h"` would silently double every cache-write bill.
    #[test]
    fn cache_control_defaults_to_the_five_minute_ttl() {
        assert_eq!(ANTHROPIC_CACHE_TTL, None);
        assert!(
            anthropic_cache_control().get("ttl").is_none(),
            "omitting ttl selects the 5-minute default"
        );
    }

    /// Automatic caching does not require the system prompt to become a
    /// text-block array; keeping it a bare string keeps the prefix bytes
    /// identical to what shipped before CE6.
    #[test]
    fn system_prompt_stays_a_bare_string() {
        let body = build_anthropic_body(&request());
        assert_eq!(body["system"], serde_json::json!("you are helpful"));
    }

    /// The prefix must be byte-identical across iterations of one turn, or the
    /// cache is written rather than read every time. Nothing in the body may
    /// depend on a clock, a counter, or iteration index.
    #[test]
    fn body_is_byte_stable_across_identical_requests() {
        let first = serde_json::to_string(&build_anthropic_body(&request())).unwrap();
        let second = serde_json::to_string(&build_anthropic_body(&request())).unwrap();
        assert_eq!(first, second);
    }

    /// `cache_key` is an OpenAI-only concept; Anthropic keys off the prefix
    /// itself, so it must not leak into the body as an unknown parameter.
    #[test]
    fn cache_key_is_not_sent_to_anthropic() {
        let body = build_anthropic_body(&request());
        assert!(body.get("cache_key").is_none());
        assert!(body.get("prompt_cache_key").is_none());
    }

    /// A `ProviderReasoning` block belongs to the OpenAI-compatible MiniMax
    /// path. Anthropic's builder must ignore it rather than emit an unknown
    /// content block (which the API rejects).
    #[test]
    fn provider_reasoning_blocks_are_dropped_for_anthropic() {
        let messages = vec![ChatMessage {
            role: ChatRole::Assistant,
            content: MessageContent::Blocks(vec![
                ContentBlock::ProviderReasoning {
                    details: serde_json::json!([{ "type": "reasoning.text", "text": "hmm" }]),
                },
                ContentBlock::Text {
                    text: "answer".to_string(),
                },
            ]),
        }];

        let built = build_anthropic_messages(&messages, &[]);

        assert_eq!(built.len(), 1);
        let content = built[0]["content"].as_array().unwrap();
        assert_eq!(content.len(), 1, "only the text block survives");
        assert_eq!(content[0]["type"], "text");
    }
}
