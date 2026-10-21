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
    if provider == "sugar" {
        if let Ok(raw) = std::env::var("SUGAR_TASK_API_ROOT") {
            if !raw.trim().is_empty() {
                return task_bridge_base_url(&raw);
            }
        }
    }
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

/// Explicit per-process bridge connection. Saved endpoints and keyring credentials stay intact.
fn task_bridge_base_url(raw: &str) -> Result<String, String> {
    let invalid = || {
        "SUGAR_TASK_API_ROOT must be the loopback API root printed by Sugar's task bridge."
            .to_string()
    };
    let url = reqwest::Url::parse(raw).map_err(|_| invalid())?;
    let parts: Vec<_> = url.path().split('/').collect();
    if url.scheme() != "http"
        || url.host_str() != Some("127.0.0.1")
        || url.port().unwrap_or(0) <= 3050
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || parts.len() != 5
        || parts[1] != "task"
        || parts[3] != "api"
        || parts[4] != "v1"
        || uuid::Uuid::parse_str(parts[2])
            .map(|id| id.get_version_num() != 4)
            .unwrap_or(true)
        || url.as_str() != raw
    {
        return Err(invalid());
    }
    Ok(url.to_string())
}

#[cfg(test)]
mod task_bridge_tests {
    use super::*;
    #[test]
    fn accepts_only_the_explicit_local_task_bridge() {
        let root = "http://127.0.0.1:3218/task/36dcc4a4-e386-4b1a-882c-dfb58d68a20c/api/v1";
        assert_eq!(task_bridge_base_url(root).unwrap(), root);
        for invalid in [
            root.replace("127.0.0.1", "example.com"),
            root.replace("3218", "3000"),
            format!("{root}?key=secret"),
        ] {
            assert!(task_bridge_base_url(&invalid).is_err());
        }
    }
}
