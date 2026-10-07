use super::{
    llm_provider::LlmProvider,
    llm_types::*,
    provider_endpoints::{self, GoProtocol},
};
use reqwest::header::{HeaderMap, HeaderValue, USER_AGENT};
use tokio::sync::mpsc;

pub struct NamedProvider {
    id: String,
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{json, Value};

    fn request(model: &str) -> LlmRequest {
        serde_json::from_value(json!({"model":model, "messages":[{"role":"user", "content":"hi"}],
            "tools":[{"name":"read_file", "description":"read", "parameters":{"type":"object"}}], "cache_key":"session-123"})).unwrap()
    }

    #[tokio::test]
    async fn named_providers_send_real_wire_requests_and_stream_text() {
        let chat = "data: {\"choices\":[{\"delta\":{\"content\":\"hello\"},\"finish_reason\":\"stop\"}]}\n\ndata: [DONE]\n\n";
        let messages = "data: {\"type\":\"content_block_delta\",\"delta\":{\"type\":\"text_delta\",\"text\":\"hello\"}}\n\ndata: {\"type\":\"message_stop\"}\n\n";
        let responses = "data: {\"type\":\"response.output_text.delta\",\"delta\":\"hello\"}\n\ndata: {\"type\":\"response.completed\",\"response\":{\"status\":\"completed\",\"output\":[]}}\n\n";
        for (id, model, path, fixture) in [
            ("sugar", "sugar/conduit", "chat/completions", chat),
            ("cline-pass", "cline-pass/future", "chat/completions", chat),
            ("ollama-cloud", "future:cloud", "chat/completions", chat),
            ("google", "gemini-future", "chat/completions", chat),
            ("opencode-go", "glm-future", "chat/completions", chat),
            ("opencode-go", "minimax-future", "messages", messages),
            ("opencode-go", "qwen-future", "messages", messages),
            ("opencode-go", "gpt-future", "responses", responses),
            ("xai", "grok-future", "responses", responses),
        ] {
            let (base, server) = super::super::test_http::serve(fixture, "text/event-stream").await;
            let (tx, mut rx) = mpsc::channel(32);
            stream_at(id, &format!("{base}/v1"), "fixture-key", request(model), tx)
                .await
                .unwrap();
            let wire = server.await.unwrap();
            assert!(wire.starts_with(&format!("POST /v1/{path} ")), "{wire}");
            if id == "opencode-go" {
                assert!(wire.contains("x-opencode-session: session-123"));
            }
            assert!(wire.contains(if path == "messages" {
                "x-api-key: fixture-key"
            } else {
                "authorization: Bearer fixture-key"
            }));
            let body: Value = serde_json::from_str(wire.split("\r\n\r\n").nth(1).unwrap()).unwrap();
            assert_eq!(body["model"], model);
            if path == "chat/completions" {
                assert_eq!(body["stream_options"]["include_usage"], true);
            }
            assert_eq!(
                body["tools"][0][if path == "chat/completions" {
                    "function"
                } else {
                    "name"
                }]
                .is_null(),
                false
            );
            let mut text = String::new();
            let mut done = false;
            while let Some(chunk) = rx.recv().await {
                match chunk {
                    StreamChunk::TextDelta { text: delta } => text.push_str(&delta),
                    StreamChunk::Done { .. } => done = true,
                    _ => {}
                }
            }
            assert_eq!(text, "hello");
            assert!(done);
        }
    }

    #[tokio::test]
    async fn named_chat_usage_survives_the_final_usage_only_frame() {
        let fixture = "data: {\"choices\":[{\"delta\":{\"content\":\"hi\"},\"finish_reason\":\"stop\"}]}\n\ndata: {\"choices\":[],\"usage\":{\"prompt_tokens\":42,\"completion_tokens\":7}}\n\ndata: [DONE]\n\n";
        for id in [
            "sugar",
            "cline-pass",
            "opencode-go",
            "google",
            "ollama-cloud",
        ] {
            let (base, server) = super::super::test_http::serve(fixture, "text/event-stream").await;
            let (tx, mut rx) = mpsc::channel(32);
            stream_at(id, &base, "fixture-key", request("chat-model"), tx)
                .await
                .unwrap();
            let wire = server.await.unwrap();
            let body: Value = serde_json::from_str(wire.split("\r\n\r\n").nth(1).unwrap()).unwrap();
            assert_eq!(body["stream_options"]["include_usage"], true);
            let mut usage = None;
            while let Some(chunk) = rx.recv().await {
                if let StreamChunk::Done {
                    input_tokens,
                    output_tokens,
                    ..
                } = chunk
                {
                    usage = Some((input_tokens, output_tokens));
                }
            }
            assert_eq!(usage, Some((42, 7)), "{id}");
        }
    }

    #[tokio::test]
    async fn truncated_or_non_streaming_success_is_an_error() {
        for (id, model) in [
            ("sugar", "sugar/conduit"),
            ("opencode-go", "minimax-m3"),
            ("xai", "grok-future"),
        ] {
            let (base, server) = super::super::test_http::serve("{}", "application/json").await;
            let (tx, mut rx) = mpsc::channel(32);
            assert!(stream_at(id, &base, "fixture", request(model), tx)
                .await
                .is_err());
            while let Some(chunk) = rx.recv().await {
                assert!(!matches!(chunk, StreamChunk::Done { .. }));
            }
            server.await.unwrap();
        }
    }
}
impl NamedProvider {
    pub fn new(id: &str) -> Self {
        Self { id: id.to_string() }
    }
}

#[async_trait::async_trait]
impl LlmProvider for NamedProvider {
    async fn stream_chat(
        &self,
        key: &str,
        request: LlmRequest,
        tx: mpsc::Sender<StreamChunk>,
    ) -> Result<(), String> {
        let base = provider_endpoints::resolve(&self.id)?;
        stream_at(&self.id, &base, key, request, tx).await
    }

    fn provider_id(&self) -> &str {
        &self.id
    }
}

async fn stream_at(
    id: &str,
    base: &str,
    key: &str,
    request: LlmRequest,
    tx: mpsc::Sender<StreamChunk>,
) -> Result<(), String> {
    let mut headers = HeaderMap::new();
    headers.insert(
        USER_AGENT,
        HeaderValue::from_str(&format!(
            "{}/{}",
            super::brand::APP_NAME,
            env!("CARGO_PKG_VERSION")
        ))
        .map_err(|e| e.to_string())?,
    );
    if id == "opencode-go" {
        if let Some(session) = &request.cache_key {
            headers.insert(
                "x-opencode-session",
                HeaderValue::from_str(session).map_err(|_| "Invalid session ID")?,
            );
        }
        match provider_endpoints::go_protocol(&request.model) {
            GoProtocol::Messages => {
                return super::llm_anthropic::stream_anthropic_at(
                    &format!("{base}/messages"),
                    headers,
                    key,
                    request,
                    tx,
                )
                .await
            }
            GoProtocol::Responses => {
                return super::llm_responses::stream_responses(id, base, headers, key, request, tx)
                    .await
            }
            GoProtocol::Chat => {}
        }
    }
    if id == "xai" {
        return super::llm_responses::stream_responses(id, base, headers, key, request, tx).await;
    }
    super::llm_openai_compat::stream_chat_compat(
        &super::llm_openai_compat::OpenAiCompatConfig {
            base_url: base.to_string(),
            headers,
            provider_id: id.to_string(),
        },
        key,
        request,
        tx,
    )
    .await
}
