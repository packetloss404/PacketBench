//! Named services use isolated credentials and configurable API roots.

pub const NAMED_PROVIDERS: &[&str] = &[
    "sugar",
    "cline-pass",
    "opencode-go",
    "ollama-cloud",
    "google",
    "xai",
];

pub fn default_base_url(provider: &str) -> Result<&'static str, String> {
    match provider {
        "sugar" => Ok("https://usesugar.dev/api/v1"),
        "cline-pass" => Ok("https://api.cline.bot/api/v1"),
        "opencode-go" => Ok("https://opencode.ai/zen/go/v1"),
        "ollama-cloud" => Ok("https://ollama.com/v1"),
        "google" => Ok("https://generativelanguage.googleapis.com/v1beta/openai"),
        "xai" => Ok("https://api.x.ai/v1"),
        _ => Err(format!("Unknown configurable provider: {provider}")),
    }
}

pub fn resolve(provider: &str) -> Result<String, String> {
    let default = default_base_url(provider)?;
    Ok(super::storage::load_named_provider_base_url(provider)
        .unwrap_or_else(|| default.to_string()))
}

#[derive(Debug, PartialEq)]
pub enum GoProtocol {
    Chat,
    Messages,
    Responses,
}

/// Go's model list contains IDs, not transport metadata. These family rules
/// follow https://opencode.ai/docs/go/#endpoints; no inference request is retried
/// against another protocol (that could double-bill a completed request).
pub fn go_protocol(model: &str) -> GoProtocol {
    if model.starts_with("minimax-") || model.starts_with("qwen") {
        GoProtocol::Messages
    } else if model.starts_with("gpt-")
        || model.starts_with("muse-")
        || (model.starts_with("grok-") && model != "grok-4.5")
    {
        GoProtocol::Responses
    } else {
        GoProtocol::Chat
    }
}
