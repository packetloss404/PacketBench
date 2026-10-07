//! Direct OpenAI: Responses for modern reasoning models, Chat Completions for legacy models.

use crate::core::llm_openai_compat::{stream_chat_compat, OpenAiCompatConfig};
use crate::core::llm_provider::LlmProvider;
use crate::core::llm_types::*;
use reqwest::header::HeaderMap;
use tokio::sync::mpsc;

const OPENAI_BASE_URL: &str = "https://api.openai.com/v1";

pub struct OpenAiProvider;

#[async_trait::async_trait]
impl LlmProvider for OpenAiProvider {
    async fn stream_chat(
        &self,
        api_key: &str,
        request: LlmRequest,
        tx: mpsc::Sender<StreamChunk>,
    ) -> Result<(), String> {
        if request.model.starts_with("gpt-5")
            || request.model.starts_with("gpt-6")
            || request.model.starts_with("o1")
            || request.model.starts_with("o3")
            || request.model.starts_with("o4")
        {
            return super::llm_responses::stream_responses(
                "openai",
                OPENAI_BASE_URL,
                HeaderMap::new(),
                api_key,
                request,
                tx,
            )
            .await;
        }
        let config = OpenAiCompatConfig {
            base_url: OPENAI_BASE_URL.to_string(),
            headers: HeaderMap::new(),
            provider_id: "openai".to_string(),
        };
        stream_chat_compat(&config, api_key, request, tx).await
    }

    fn provider_id(&self) -> &str {
        "openai"
    }
}
