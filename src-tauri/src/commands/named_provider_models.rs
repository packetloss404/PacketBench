use super::provider_models::{fetch_text, http_client, require_api_key, LiveModel};
use serde_json::Value;

fn rows<'a>(body: &'a Value, field: &str) -> Result<&'a Vec<Value>, String> {
    body.get(field)
        .and_then(Value::as_array)
        .ok_or_else(|| format!("network: Invalid model catalog: missing {field} array"))
}

pub(crate) fn parse_catalog(provider: &str, body: &Value) -> Result<Vec<LiveModel>, String> {
    let field = match provider {
        "cline-pass" => "clinePass",
        "ollama-cloud" | "google" | "xai" => "models",
        _ => "data",
    };
    let mut models = Vec::new();
    for row in rows(body, field)? {
        if provider == "google"
            && !row["supportedGenerationMethods"]
                .as_array()
                .is_some_and(|methods| methods.iter().any(|m| m == "generateContent"))
        {
            continue;
        }
        let id = if matches!(provider, "google" | "ollama-cloud") {
            row["name"].as_str()
        } else {
            row["id"].as_str()
        };
        let id = id
            .filter(|s| !s.trim().is_empty())
            .ok_or_else(|| "network: Model catalog contains an invalid ID".to_string())?;
        let id = if provider == "google" {
            id.strip_prefix("models/").unwrap_or(id)
        } else {
            id
        };
        if provider == "cline-pass" && !id.starts_with("cline-pass/") {
            return Err("network: ClinePass catalog contains a non-Pass model".to_string());
        }
        // These require audio/image output rather than our text + tool contract.
        if provider == "google"
            && ["image", "-tts", "native-audio", "robotics"]
                .iter()
                .any(|part| id.contains(part))
        {
            continue;
        }
        if provider == "ollama-cloud"
            && row["capabilities"].as_array().is_some_and(|caps| {
                caps.iter().any(|c| c == "embedding") && !caps.iter().any(|c| c == "completion")
            })
        {
            continue;
        }
        if models.iter().any(|m: &LiveModel| m.id == id) {
            continue;
        }
        models.push(LiveModel {
            id: id.to_string(),
            display_name: row["displayName"]
                .as_str()
                .or_else(|| row["name"].as_str())
                .map(str::to_string),
            context_window: row["inputTokenLimit"]
                .as_u64()
                .or_else(|| row["context_length"].as_u64())
                .filter(|v| *v > 0),
            max_output: row["outputTokenLimit"].as_u64().filter(|v| *v > 0),
            // A subscription catalog is not evidence of zero-priced inference.
            input_per_mtok: None,
            output_per_mtok: None,
        });
    }
    Ok(models)
}

pub async fn list_models(provider: &str) -> Result<Vec<LiveModel>, String> {
    let key = require_api_key(provider)?;
    let base = crate::core::provider_endpoints::resolve(provider)?;
    list_models_at(provider, &base, &key).await
}

async fn list_models_at(provider: &str, base: &str, key: &str) -> Result<Vec<LiveModel>, String> {
    let url = match provider {
        "cline-pass" => format!("{base}/ai/cline/recommended-models"),
        "ollama-cloud" => format!("{}/api/tags", base.strip_suffix("/v1").unwrap_or(base)),
        "google" => format!(
            "{}/models",
            base.strip_suffix("/openai")
                .ok_or("not-configured: Google API base must end in /openai")?
        ),
        "xai" => format!("{base}/language-models"),
        _ => format!("{base}/models"),
    };
    let client = http_client()?;
    let mut all = Vec::new();
    let mut cursor = String::new();
    let mut seen = std::collections::HashSet::new();
    for _ in 0..100 {
        let mut req = client.get(&url);
        // Cline's Pass inventory is public. Its success does not validate a key.
        if provider == "google" {
            req = req
                .header("x-goog-api-key", key.trim())
                .query(&[("pageSize", "1000")]);
            if !cursor.is_empty() {
                req = req.query(&[("pageToken", &cursor)]);
            }
        } else if provider != "cline-pass" {
            req = req.bearer_auth(key.trim());
        }
        let text = fetch_text(req, provider, &url).await?;
        let body: Value = serde_json::from_str(&text)
            .map_err(|_| "network: Invalid model catalog JSON".to_string())?;
        for model in parse_catalog(provider, &body)? {
            if !all.iter().any(|m: &LiveModel| m.id == model.id) {
                all.push(model);
            }
        }
        let next = body["nextPageToken"].as_str().unwrap_or("");
        if provider != "google" || next.is_empty() {
            return Ok(all);
        }
        if !seen.insert(next.to_string()) {
            return Err("network: Model catalog repeated a page cursor".to_string());
        }
        cursor = next.to_string();
    }
    Err("network: Model catalog exceeded the page limit".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[tokio::test]
    async fn discovery_uses_the_configured_root_and_provider_catalog_path() {
        for (provider, suffix, path, fixture, expected) in [
            (
                "sugar",
                "/api/v1",
                "/api/v1/models",
                json!({"data":[{"id":"sugar/conduit"}]}),
                "sugar/conduit",
            ),
            (
                "opencode-go",
                "/zen/go/v1",
                "/zen/go/v1/models",
                json!({"data":[{"id":"future"}]}),
                "future",
            ),
            (
                "cline-pass",
                "/api/v1",
                "/api/v1/ai/cline/recommended-models",
                json!({"clinePass":[{"id":"cline-pass/future"}]}),
                "cline-pass/future",
            ),
            (
                "ollama-cloud",
                "/v1",
                "/api/tags",
                json!({"models":[{"name":"future:cloud"}]}),
                "future:cloud",
            ),
            (
                "google",
                "/v1beta/openai",
                "/v1beta/models?pageSize=1000",
                json!({"models":[{"name":"models/future", "supportedGenerationMethods":["generateContent"]}]}),
                "future",
            ),
            (
                "xai",
                "/v1",
                "/v1/language-models",
                json!({"models":[{"id":"grok-future"}]}),
                "grok-future",
            ),
        ] {
            let (base, server) =
                crate::core::test_http::serve(&fixture.to_string(), "application/json").await;
            let models = list_models_at(provider, &format!("{base}{suffix}"), "fixture-key")
                .await
                .unwrap();
            assert_eq!(models[0].id, expected);
            let wire = server.await.unwrap();
            assert!(wire.starts_with(&format!("GET {path} ")), "{wire}");
            if provider == "cline-pass" {
                assert!(!wire.contains("fixture-key"));
            } else {
                assert!(wire.contains(if provider == "google" {
                    "x-goog-api-key: fixture-key"
                } else {
                    "authorization: Bearer fixture-key"
                }));
            }
        }
    }
    #[test]
    fn pass_catalog_never_imports_metered_recommendations() {
        let models = parse_catalog("cline-pass", &json!({"recommended":[{"id":"paid/model"}], "clinePass":[{"id":"cline-pass/current", "name":"Current"}]})).unwrap();
        assert_eq!(models.len(), 1);
        assert_eq!(models[0].id, "cline-pass/current");
        assert_eq!(models[0].input_per_mtok, None);
        assert!(parse_catalog("cline-pass", &json!({"data":[]})).is_err());
        assert!(parse_catalog("cline-pass", &json!({"clinePass":[{"id":"paid/model"}]})).is_err());
    }
    #[test]
    fn google_uses_capabilities_and_returns_limits_and_exact_wire_ids() {
        let models = parse_catalog("google", &json!({"models":[
            {"name":"models/gemini-future", "supportedGenerationMethods":["generateContent"], "inputTokenLimit":1000000},
            {"name":"models/embedding", "supportedGenerationMethods":["embedContent"]},
            {"name":"models/gemini-image", "supportedGenerationMethods":["generateContent"]}
        ]})).unwrap();
        assert_eq!(models.len(), 1);
        assert_eq!(models[0].id, "gemini-future");
        assert_eq!(models[0].context_window, Some(1000000));
    }
    #[test]
    fn service_catalogs_keep_new_ids_without_bundled_allowlists() {
        for provider in ["sugar", "opencode-go"] {
            assert_eq!(
                parse_catalog(provider, &json!({"data":[{"id":"future/model"}]})).unwrap()[0].id,
                "future/model"
            );
        }
        assert_eq!(
            parse_catalog("ollama-cloud", &json!({"models":[{"name":"future:cloud"}]})).unwrap()[0]
                .id,
            "future:cloud"
        );
        assert_eq!(
            parse_catalog("xai", &json!({"models":[{"id":"grok-future"}]})).unwrap()[0].id,
            "grok-future"
        );
    }
}
