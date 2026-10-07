//! Stateless Responses transport: replay provider-owned output items between
//! tool rounds, including encrypted reasoning, without creating server sessions.
use super::llm_types::*;
use futures::StreamExt;
use reqwest::header::HeaderMap;
use serde_json::{json, Value};
use tokio::sync::mpsc;

fn body(provider: &str, request: &LlmRequest) -> Value {
    let mut input = Vec::new();
    let last_user = request
        .messages
        .iter()
        .rposition(|m| m.role == ChatRole::User);
    for (index, message) in request.messages.iter().enumerate() {
        if let MessageContent::Blocks(blocks) = &message.content {
            let replay = blocks.iter().find_map(|block| match block {
                ContentBlock::ProviderReasoning { details }
                    if details["responses_provider"] == provider =>
                {
                    details["output"].as_array()
                }
                _ => None,
            });
            if let Some(output) = replay {
                input.extend(output.iter().cloned());
                continue;
            }
            for block in blocks {
                match block {
                    ContentBlock::ToolUse { id, name, arguments } => input.push(json!({"type":"function_call", "call_id":id, "name":name, "arguments":arguments.to_string()})),
                    ContentBlock::ToolResult { tool_call_id, content, .. } => input.push(json!({"type":"function_call_output", "call_id":tool_call_id, "output":content})),
                    ContentBlock::Text { text } => input.push(json!({"role":message.role, "content":text})),
                    _ => {},
                }
            }
        } else if Some(index) == last_user && !request.attachments.is_empty() {
            let mut content = vec![json!({"type":"input_text", "text":message.content.as_text()})];
            content.extend(request.attachments.iter().map(|a| json!({"type":"input_image", "image_url":format!("data:{};base64,{}", a.media_type, a.data_base64)})));
            input.push(json!({"role":"user", "content":content}));
        } else {
            input.push(json!({"role":message.role, "content":message.content.as_text()}));
        }
    }
    let mut body = json!({"model":request.model, "input":input, "stream":true, "store":false,
        "max_output_tokens":request.max_tokens, "include":["reasoning.encrypted_content"]});
    if let Some(prompt) = &request.system_prompt {
        body["instructions"] = json!(prompt);
    }
    if !request.tools.is_empty() {
        body["tools"] = json!(request.tools.iter().map(|t| json!({"type":"function", "name":t.name, "description":t.description, "parameters":t.parameters, "strict":false})).collect::<Vec<_>>());
    }
    body
}

fn complete(provider: &str, response: &Value) -> Result<Vec<StreamChunk>, String> {
    if response["status"] != "completed" {
        return Err("Responses request did not complete".to_string());
    }
    let output = response["output"]
        .as_array()
        .ok_or("Responses completion omitted output")?;
    let mut chunks = Vec::new();
    for item in output {
        if item["type"] == "function_call" {
            let id = item["call_id"]
                .as_str()
                .filter(|s| !s.is_empty())
                .ok_or("Tool call omitted call_id")?;
            let name = item["name"]
                .as_str()
                .filter(|s| !s.is_empty())
                .ok_or("Tool call omitted name")?;
            let arguments = serde_json::from_str(
                item["arguments"]
                    .as_str()
                    .ok_or("Tool call omitted arguments")?,
            )
            .map_err(|_| "Tool call returned invalid JSON arguments")?;
            chunks.push(StreamChunk::ToolUseStart {
                id: id.into(),
                name: name.into(),
            });
            chunks.push(StreamChunk::ToolUseEnd {
                id: id.into(),
                name: name.into(),
                arguments,
            });
        }
    }
    chunks.push(StreamChunk::ReasoningDetails {
        details: json!({"responses_provider":provider, "output":output}),
    });
    let usage = &response["usage"];
    let cached = usage["input_tokens_details"]["cached_tokens"]
        .as_u64()
        .unwrap_or(0);
    chunks.push(StreamChunk::Done {
        input_tokens: usage["input_tokens"].as_u64().unwrap_or(0),
        output_tokens: usage["output_tokens"].as_u64().unwrap_or(0),
        cache_read_input_tokens: cached,
        cache_creation_input_tokens: 0,
    });
    Ok(chunks)
}

pub async fn stream_responses(
    provider: &str,
    base: &str,
    headers: HeaderMap,
    key: &str,
    request: LlmRequest,
    tx: mpsc::Sender<StreamChunk>,
) -> Result<(), String> {
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(|e| e.to_string())?;
    let response = client
        .post(format!("{base}/responses"))
        .headers(headers)
        .bearer_auth(key)
        .json(&body(provider, &request))
        .send()
        .await
        .map_err(|e| format!("{provider} request failed: {e}"))?;
    if !response.status().is_success() {
        return Err(format!(
            "{provider} API error ({}): {}",
            response.status(),
            response.text().await.unwrap_or_default()
        ));
    }
    let mut stream = response.bytes_stream();
    let mut buffer = Vec::new();
    let mut ended = false;
    loop {
        if !ended {
            tokio::select! {
                _ = tx.closed() => return Ok(()),
                next = stream.next() => match next {
                    Some(chunk) => buffer.extend_from_slice(&chunk.map_err(|e| e.to_string())?),
                    None => { ended = true; super::llm_provider::delimit_final_sse_line(&mut buffer); }
                }
            }
        }
        if buffer.len() > 8 * 1024 * 1024 {
            return Err("Responses event exceeded 8 MiB".into());
        }
        while let Some(end) = buffer.iter().position(|b| *b == b'\n') {
            let bytes: Vec<_> = buffer.drain(..=end).collect();
            let line = std::str::from_utf8(&bytes)
                .map_err(|_| "Invalid UTF-8 in response")?
                .trim();
            let Some(data) = line.strip_prefix("data:").map(str::trim) else {
                continue;
            };
            if data == "[DONE]" {
                continue;
            }
            let event: Value =
                serde_json::from_str(data).map_err(|_| "Invalid Responses event JSON")?;
            match event["type"].as_str().unwrap_or("") {
                "response.output_text.delta" | "response.refusal.delta" => {
                    if let Some(text) = event["delta"].as_str() {
                        let _ = tx.send(StreamChunk::TextDelta { text: text.into() }).await;
                    }
                }
                "response.reasoning_summary_text.delta" => {
                    if let Some(text) = event["delta"].as_str() {
                        let _ = tx
                            .send(StreamChunk::ThinkingDelta { text: text.into() })
                            .await;
                    }
                }
                "response.reasoning_summary_text.done" => {
                    let _ = tx.send(StreamChunk::ThinkingStop).await;
                }
                "response.completed" => {
                    for chunk in complete(provider, &event["response"])? {
                        if tx.send(chunk).await.is_err() {
                            return Ok(());
                        }
                    }
                    return Ok(());
                }
                "error" | "response.failed" | "response.incomplete" => {
                    return Err(format!("{provider} response failed: {event}"))
                }
                _ => {}
            }
        }
        if ended {
            return Err(format!("{provider} stream ended before response.completed"));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn next_tool_round_replays_output_once_with_the_matching_result() {
        let output = json!([
            {"type":"reasoning", "encrypted_content":"opaque"},
            {"type":"function_call", "call_id":"call-2", "name":"read_file", "arguments":"{}"}
        ]);
        let request: LlmRequest = serde_json::from_value(json!({"model":"grok-future", "tools":[], "messages":[
            {"role":"assistant", "content":[
                {"type":"tool_use", "id":"call-2", "name":"read_file", "arguments":{}},
                {"type":"provider_reasoning", "details":{"responses_provider":"xai", "output":output}}
            ]},
            {"role":"tool", "content":[{"type":"tool_result", "tool_call_id":"call-2", "content":"contents"}]}
        ]})).unwrap();
        let body = body("xai", &request);
        assert_eq!(body["input"].as_array().unwrap().len(), 3);
        assert_eq!(body["input"][0], output[0]);
        assert_eq!(body["input"][1], output[1]);
        assert_eq!(
            body["input"][2],
            json!({"type":"function_call_output", "call_id":"call-2", "output":"contents"})
        );
        assert_eq!(body["store"], false);
    }
    #[test]
    fn completion_preserves_reasoning_and_correlates_tools() {
        let response = json!({"status":"completed", "output":[{"type":"reasoning", "encrypted_content":"opaque"},
            {"type":"function_call", "call_id":"call-2", "name":"read_file", "arguments":"{\"path\":\"a\"}"}],
            "usage":{"input_tokens":100, "input_tokens_details":{"cached_tokens":60}, "output_tokens":12}});
        let chunks = complete("opencode-go", &response).unwrap();
        assert!(
            matches!(&chunks[1], StreamChunk::ToolUseEnd { id, arguments, .. } if id == "call-2" && arguments["path"] == "a")
        );
        assert!(
            matches!(&chunks[2], StreamChunk::ReasoningDetails { details } if details["output"][0]["encrypted_content"] == "opaque")
        );
        assert!(matches!(
            &chunks[3],
            StreamChunk::Done {
                input_tokens: 100,
                cache_read_input_tokens: 60,
                ..
            }
        ));
    }
    #[test]
    fn failed_or_malformed_completions_never_execute_tools() {
        assert!(complete("xai", &json!({"status":"incomplete", "output":[]})).is_err());
        assert!(complete("xai", &json!({"status":"completed", "output":[{"type":"function_call", "call_id":"a", "name":"shell", "arguments":"{"}]})).is_err());
    }
}
