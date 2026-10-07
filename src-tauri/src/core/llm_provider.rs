use crate::core::llm_types::{LlmRequest, StreamChunk};
use tokio::sync::mpsc;

/// Trait implemented by each LLM provider (Anthropic, OpenAI, etc.).
///
/// Providers stream response chunks through the provided channel sender.
/// The caller listens on the receiver and emits Tauri events accordingly.
#[async_trait::async_trait]
pub trait LlmProvider: Send + Sync {
    /// Stream a chat completion response.
    ///
    /// Sends `StreamChunk` variants through `tx` as they arrive.
    /// Must send `StreamChunk::Done`, send `StreamChunk::Error`, or return an
    /// error for the caller to surface.
    async fn stream_chat(
        &self,
        api_key: &str,
        request: LlmRequest,
        tx: mpsc::Sender<StreamChunk>,
    ) -> Result<(), String>;

    /// Return the provider identifier (e.g., "anthropic", "openai").
    fn provider_id(&self) -> &str;
}

/// Turn a non-empty EOF remainder into one normal parser line. SSE streams do
/// not require the final record to end in a newline.
pub(crate) fn delimit_final_sse_line(buffer: &mut Vec<u8>) {
    if !buffer.is_empty() && !buffer.ends_with(b"\n") {
        buffer.push(b'\n');
    }
}

/// Every provider id [`get_provider`] can resolve, for error messages that
/// tell the caller what a valid id actually looks like. Keep in sync with the
/// match arms below.
pub const IN_PROCESS_PROVIDERS: &[&str] = &[
    "anthropic",
    "openai",
    "minimax",
    "minimax-api",
    "openrouter",
    "ollama",
    "custom",
    "sugar",
    "cline-pass",
    "opencode-go",
    "ollama-cloud",
    "google",
    "xai",
];

/// Get a provider instance by name.
///
/// `name` is a *provider* id, never an agent-config id: the frontend's
/// `api-claude` maps to `"anthropic"`, not `"claude"`. Callers that derive one
/// from the other by stripping the `api-` prefix produce ids this match
/// rejects — see `attemptProviderFor` in `src/lib/attemptRouting.ts`.
pub fn get_provider(name: &str) -> Result<Box<dyn LlmProvider>, String> {
    match name {
        "anthropic" => Ok(Box::new(super::llm_anthropic::AnthropicProvider)),
        "openai" => Ok(Box::new(super::llm_openai::OpenAiProvider)),
        // Token Plan and pay-as-you-go API both use the same OpenAI-compatible
        // MiniMax endpoint; they differ only by which keyring key supplies the
        // credential (provider string -> `api-key-{provider}`).
        "minimax" | "minimax-api" => Ok(Box::new(super::llm_minimax::MiniMaxProvider)),
        "openrouter" => Ok(Box::new(super::llm_openrouter::OpenRouterProvider)),
        "ollama" => Ok(Box::new(super::llm_ollama::OllamaProvider)),
        // LM2: user-supplied OpenAI-compatible endpoint (vLLM / LM Studio /
        // LiteLLM / Together, …). Key optional — `api-key-custom` when set.
        "custom" => Ok(Box::new(super::llm_custom_compat::CustomCompatProvider)),
        name if super::provider_endpoints::NAMED_PROVIDERS.contains(&name) => {
            Ok(Box::new(super::llm_named::NamedProvider::new(name)))
        }
        _ => Err(format!("Unknown provider: {}", name)),
    }
}

#[cfg(test)]
mod tests {
    use super::delimit_final_sse_line;
    use super::{get_provider, IN_PROCESS_PROVIDERS};

    #[test]
    fn every_advertised_in_process_provider_resolves() {
        for name in IN_PROCESS_PROVIDERS {
            assert!(
                get_provider(name).is_ok(),
                "IN_PROCESS_PROVIDERS advertises '{name}' but get_provider rejects it"
            );
        }
    }

    #[test]
    fn agent_config_ids_are_not_provider_ids() {
        // The P1 this guards: a caller deriving the provider by stripping the
        // `api-` prefix from an agent-config id hands us "claude", which is
        // NOT the id of the Anthropic provider.
        for bogus in ["claude", "api-claude", "claude-oauth", "openai-codex"] {
            let err = get_provider(bogus).err().unwrap_or_else(|| {
                panic!("get_provider must reject the agent-config id '{bogus}'")
            });
            assert!(
                err.contains(bogus),
                "unknown-provider error must name the offending id, got: {err}"
            );
        }
        assert!(get_provider("anthropic").is_ok());
    }

    #[test]
    fn final_sse_record_without_newline_gets_parser_delimiter() {
        let mut buffer = b"data: {\"type\":\"message_stop\"}".to_vec();
        delimit_final_sse_line(&mut buffer);
        assert!(buffer.ends_with(b"\n"));
        assert_eq!(buffer.iter().filter(|byte| **byte == b'\n').count(), 1);
    }

    #[test]
    fn empty_or_already_delimited_sse_buffer_is_unchanged() {
        let mut empty = Vec::new();
        delimit_final_sse_line(&mut empty);
        assert!(empty.is_empty());

        let mut complete = b"data: [DONE]\n".to_vec();
        delimit_final_sse_line(&mut complete);
        assert_eq!(complete, b"data: [DONE]\n");
    }
}
