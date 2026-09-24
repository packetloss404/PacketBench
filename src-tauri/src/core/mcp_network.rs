//! Native network MCP. Streamable HTTP uses the official SDK; legacy SSE is
//! adapted to the same SDK's JSON-RPC client over a bounded duplex stream.
//! No tool request is replayed after a transport failure.
use crate::core::mcp_client::{extract_text_content, McpToolInfo};
use futures::{Stream, StreamExt};
use reqwest::{
    header::{HeaderMap, HeaderName, HeaderValue},
    Client, Url,
};
use rmcp::{
    service::RunningService,
    transport::{
        streamable_http_client::StreamableHttpClientTransportConfig, StreamableHttpClientTransport,
    },
    RoleClient, ServiceExt,
};
use serde_json::Value;
use std::{collections::HashMap, pin::Pin, time::Duration};
use tokio::io::AsyncWriteExt;
use tokio_util::codec::{FramedRead, LinesCodec};

const TIMEOUT: Duration = Duration::from_secs(30);
const MAX_FRAME: usize = 1024 * 1024;

// The SDK owns negotiation, session IDs and JSON-RPC. Its stock reqwest
// implementation buffers arbitrary response bodies, so limit them here before
// deserialization and never include remote bodies/URLs in transport errors.
#[derive(Clone)]
struct BoundedHttp(Client);
type HttpError = rmcp::transport::streamable_http_client::StreamableHttpError<std::io::Error>;
fn http_error(message: &'static str) -> HttpError {
    HttpError::Io(std::io::Error::other(message))
}
impl BoundedHttp {
    fn request(
        &self,
        method: reqwest::Method,
        uri: &str,
        session: Option<&str>,
        auth: Option<String>,
        headers: HashMap<HeaderName, HeaderValue>,
    ) -> reqwest::RequestBuilder {
        let mut request = self
            .0
            .request(method, uri)
            .headers(headers.into_iter().collect())
            .header("accept", "application/json, text/event-stream");
        if let Some(session) = session {
            request = request.header("mcp-session-id", session);
        }
        if let Some(auth) = auth {
            request = request.bearer_auth(auth);
        }
        request
    }
}
impl rmcp::transport::streamable_http_client::StreamableHttpClient for BoundedHttp {
    type Error = std::io::Error;
    async fn post_message(
        &self,
        uri: std::sync::Arc<str>,
        message: rmcp::model::ClientJsonRpcMessage,
        session: Option<std::sync::Arc<str>>,
        auth: Option<String>,
        headers: HashMap<HeaderName, HeaderValue>,
    ) -> Result<rmcp::transport::streamable_http_client::StreamableHttpPostResponse, HttpError>
    {
        use rmcp::transport::streamable_http_client::StreamableHttpPostResponse as Response;
        let response = tokio::time::timeout(
            TIMEOUT,
            self.request(
                reqwest::Method::POST,
                &uri,
                session.as_deref(),
                auth,
                headers,
            )
            .json(&message)
            .send(),
        )
        .await
        .map_err(|_| http_error("MCP HTTP response timed out"))?
        .map_err(|_| http_error("MCP HTTP request failed"))?;
        if response.status().as_u16() == 404 && session.is_some() {
            return Err(HttpError::SessionExpired);
        }
        if !response.status().is_success() {
            return Err(http_error(
                "MCP HTTP server rejected request; check configured authentication",
            ));
        }
        if matches!(response.status().as_u16(), 202 | 204) {
            return Ok(Response::Accepted);
        }
        let session = response
            .headers()
            .get("mcp-session-id")
            .and_then(|v| v.to_str().ok())
            .map(str::to_owned);
        let content_type = response
            .headers()
            .get("content-type")
            .and_then(|v| v.to_str().ok())
            .unwrap_or("")
            .split(';')
            .next()
            .unwrap_or("");
        if content_type == "text/event-stream" {
            return Ok(Response::Sse(bounded_events(response), session));
        }
        if content_type != "application/json" {
            return Err(http_error(
                "MCP HTTP response needs JSON or SSE content type",
            ));
        }
        let body = tokio::time::timeout(TIMEOUT, bounded_body(response))
            .await
            .map_err(|_| http_error("MCP JSON response timed out"))??;
        let message =
            serde_json::from_slice(&body).map_err(|_| http_error("Invalid MCP JSON response"))?;
        Ok(Response::Json(message, session))
    }
    async fn get_stream(
        &self,
        uri: std::sync::Arc<str>,
        session: std::sync::Arc<str>,
        last_event_id: Option<String>,
        auth: Option<String>,
        headers: HashMap<HeaderName, HeaderValue>,
    ) -> Result<
        futures::stream::BoxStream<'static, Result<sse_stream::Sse, sse_stream::Error>>,
        HttpError,
    > {
        let mut request = self.request(reqwest::Method::GET, &uri, Some(&session), auth, headers);
        if let Some(id) = last_event_id {
            request = request.header("last-event-id", id);
        }
        let response = tokio::time::timeout(TIMEOUT, request.send())
            .await
            .map_err(|_| http_error("MCP event stream timed out"))?
            .map_err(|_| http_error("MCP event stream request failed"))?;
        if response.status().as_u16() == 405 {
            return Err(HttpError::ServerDoesNotSupportSse);
        }
        if !response.status().is_success() {
            return Err(http_error("MCP event stream rejected"));
        }
        if !response
            .headers()
            .get("content-type")
            .and_then(|v| v.to_str().ok())
            .is_some_and(|v| v.split(';').next() == Some("text/event-stream"))
        {
            return Err(http_error("MCP event stream needs SSE content type"));
        }
        Ok(bounded_events(response))
    }
    async fn delete_session(
        &self,
        uri: std::sync::Arc<str>,
        session: std::sync::Arc<str>,
        auth: Option<String>,
        headers: HashMap<HeaderName, HeaderValue>,
    ) -> Result<(), HttpError> {
        let response = self
            .request(reqwest::Method::DELETE, &uri, Some(&session), auth, headers)
            .timeout(TIMEOUT)
            .send()
            .await
            .map_err(|_| http_error("MCP session close failed"))?;
        if response.status().is_success() || response.status().as_u16() == 405 {
            Ok(())
        } else {
            Err(http_error("MCP session close rejected"))
        }
    }
}
async fn bounded_body(response: reqwest::Response) -> Result<Vec<u8>, HttpError> {
    let mut stream = response.bytes_stream();
    let mut body = vec![];
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|_| http_error("MCP response stream failed"))?;
        if body.len() + chunk.len() > MAX_FRAME {
            return Err(http_error("MCP response exceeds 1 MiB"));
        }
        body.extend_from_slice(&chunk);
    }
    Ok(body)
}
fn bounded_events(
    response: reqwest::Response,
) -> futures::stream::BoxStream<'static, Result<sse_stream::Sse, sse_stream::Error>> {
    futures::stream::unfold(Some(SseReader::new(response)), |reader| async move {
        let mut reader = reader?;
        match reader.next().await {
            Ok((event, data)) => {
                let item = sse_stream::Sse {
                    event: Some(event),
                    data: Some(data),
                    id: reader.id.clone(),
                    retry: None,
                };
                Some((Ok(item), Some(reader)))
            }
            Err(error) => Some((
                Err(sse_stream::Error::Body(Box::new(std::io::Error::other(
                    error,
                )))),
                None,
            )),
        }
    })
    .boxed()
}

#[derive(Clone)]
pub struct NetworkConfig {
    url: Url,
    headers: HeaderMap,
    legacy_sse: bool,
}

impl NetworkConfig {
    pub fn parse(raw: &Value, legacy_sse: bool) -> Result<Self, String> {
        let url = Url::parse(
            raw.get("url")
                .and_then(Value::as_str)
                .ok_or("MCP network server needs a URL")?,
        )
        .map_err(|_| "Invalid MCP network URL")?;
        if !matches!(url.scheme(), "http" | "https")
            || url.host_str().is_none()
            || !url.username().is_empty()
            || url.password().is_some()
            || url.fragment().is_some()
        {
            return Err(
                "MCP URL must be HTTP(S), without embedded credentials or fragments".into(),
            );
        }
        let mut headers = HeaderMap::new();
        if let Some(value) = raw.get("headers") {
            for (key, value) in value.as_object().ok_or("MCP headers must be an object")? {
                let name = HeaderName::from_bytes(key.as_bytes())
                    .map_err(|_| "Invalid MCP header name")?;
                if matches!(
                    name.as_str(),
                    "host"
                        | "content-length"
                        | "transfer-encoding"
                        | "connection"
                        | "accept"
                        | "content-type"
                        | "mcp-session-id"
                        | "mcp-protocol-version"
                ) {
                    return Err("MCP headers cannot override transport protocol headers".into());
                }
                let mut value = HeaderValue::from_str(
                    value.as_str().ok_or("MCP header values must be strings")?,
                )
                .map_err(|_| "Invalid MCP header value")?;
                value.set_sensitive(true);
                headers.insert(name, value);
            }
        }
        Ok(Self {
            url,
            headers,
            legacy_sse,
        })
    }
}

struct AdapterTask(tokio::task::JoinHandle<()>);
impl Drop for AdapterTask {
    fn drop(&mut self) {
        self.0.abort();
    }
}

pub struct NetworkClient {
    service: RunningService<RoleClient, ()>,
    _adapter: Option<AdapterTask>,
}

impl NetworkClient {
    pub async fn connect(config: &NetworkConfig) -> Result<Self, String> {
        // Redirects must not forward static authorization to a different origin.
        let client = Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .connect_timeout(Duration::from_secs(10))
            .build()
            .map_err(|_| "Cannot create MCP HTTP client")?;
        if config.legacy_sse {
            return tokio::time::timeout(TIMEOUT, Self::connect_legacy(client, config))
                .await
                .map_err(|_| "MCP SSE initialization timed out")?;
        }
        let headers: HashMap<_, _> = config
            .headers
            .iter()
            .map(|(k, v)| (k.clone(), v.clone()))
            .collect();
        let transport = StreamableHttpClientTransport::with_client(
            BoundedHttp(client),
            StreamableHttpClientTransportConfig::with_uri(config.url.as_str())
                .custom_headers(headers)
                .reinit_on_expired_session(false),
        );
        let service = tokio::time::timeout(TIMEOUT, ().serve(transport))
            .await
            .map_err(|_| "MCP HTTP initialization timed out")?
            .map_err(|_| {
                "MCP HTTP initialization failed; check endpoint, headers and server availability"
            })?;
        Ok(Self {
            service,
            _adapter: None,
        })
    }

    async fn connect_legacy(client: Client, config: &NetworkConfig) -> Result<Self, String> {
        let response = client
            .get(config.url.clone())
            .headers(config.headers.clone())
            .header("accept", "text/event-stream")
            .send()
            .await
            .map_err(|_| "MCP SSE connection failed")?;
        if !response.status().is_success()
            || !response
                .headers()
                .get("content-type")
                .and_then(|v| v.to_str().ok())
                .is_some_and(|v| v.split(';').next() == Some("text/event-stream"))
        {
            return Err("MCP SSE endpoint did not return an event stream".into());
        }
        let mut events = SseReader::new(response);
        let endpoint = loop {
            let (kind, data) = events.next().await?;
            if kind == "endpoint" {
                break same_origin_endpoint(&config.url, &data)?;
            }
        };
        let (sdk, adapter) = tokio::io::duplex(64 * 1024);
        let headers = config.headers.clone();
        let task = AdapterTask(tokio::spawn(async move {
            let (read, mut write) = tokio::io::split(adapter);
            let mut lines = FramedRead::new(read, LinesCodec::new_with_max_length(MAX_FRAME));
            loop {
                tokio::select! {
                    line = lines.next() => {
                        let Some(Ok(line)) = line else { break; };
                        // One POST only. In particular, an expired session or disconnect
                        // cannot repeat a tool with side effects.
                        let result = client.post(endpoint.clone()).headers(headers.clone())
                            .header("content-type", "application/json").body(line).timeout(TIMEOUT).send().await;
                        if !result.is_ok_and(|response| response.status().is_success()) { break; }
                    }
                    event = events.next() => {
                        let Ok((kind, data)) = event else { break; };
                        if kind == "endpoint" { break; } // frozen endpoint, no authority switch
                        if kind != "message" { continue; }
                        let Ok(value) = serde_json::from_str::<Value>(&data) else { break; };
                        let mut line = value.to_string(); line.push('\n');
                        if write.write_all(line.as_bytes()).await.is_err() { break; }
                    }
                }
            }
        }));
        let service = ()
            .serve(sdk)
            .await
            .map_err(|_| "MCP SSE initialization failed; check server availability and headers")?;
        Ok(Self {
            service,
            _adapter: Some(task),
        })
    }

    pub async fn list_tools(&self) -> Result<Vec<McpToolInfo>, String> {
        let tools = tokio::time::timeout(TIMEOUT, async {
            let mut tools = vec![];
            let mut cursor = None;
            for _ in 0..64 {
                let mut params = rmcp::model::PaginatedRequestParams::default();
                params.cursor = cursor;
                let page = self
                    .service
                    .peer()
                    .list_tools(Some(params))
                    .await
                    .map_err(|_| "MCP tool discovery failed")?;
                tools.extend(page.tools);
                if tools.len() > 4096 {
                    return Err("MCP server advertises more than 4096 tools");
                }
                cursor = page.next_cursor;
                if cursor.is_none() {
                    return Ok(tools);
                }
            }
            Err("MCP tool discovery exceeds 64 pages")
        })
        .await
        .map_err(|_| "MCP tool discovery timed out")??;
        tools
            .into_iter()
            .map(|tool| {
                let mut value = serde_json::to_value(tool).map_err(|_| "Invalid MCP tool")?;
                if value.get("description").is_none() {
                    value["description"] = Value::String(String::new());
                }
                serde_json::from_value(value).map_err(|_| "Invalid MCP tool schema".into())
            })
            .collect()
    }

    pub fn is_closed(&self) -> bool {
        self.service.is_closed()
    }

    pub async fn call_tool(&self, name: &str, arguments: &Value) -> Result<String, String> {
        if self.is_closed() {
            return Err(
                "MCP connection closed; reconnect explicitly before another attempt".into(),
            );
        }
        let params = serde_json::from_value(serde_json::json!({"name":name,"arguments":arguments}))
            .map_err(|_| "MCP tool arguments must be an object")?;
        let result = match tokio::time::timeout(TIMEOUT, self.service.peer().call_tool(params))
            .await
        {
            Ok(Ok(result)) => result,
            failure => {
                self.service.cancellation_token().cancel();
                if let Some(adapter) = &self._adapter {
                    adapter.0.abort();
                }
                return Err(if failure.is_err() {
                    "MCP tool request timed out; its outcome is unknown. Inspect the server and reconnect explicitly before retrying."
                } else {
                    "MCP tool request failed; it was not retried. Reconnect explicitly before another attempt."
                }.into());
            }
        };
        let value = serde_json::to_value(result).map_err(|_| "Invalid MCP tool response")?;
        let text = extract_text_content(&value);
        if value.get("isError").and_then(Value::as_bool) == Some(true) {
            return Err(if text.is_empty() {
                "MCP tool reported an error".into()
            } else {
                text
            });
        }
        Ok(text)
    }
}

fn same_origin_endpoint(base: &Url, endpoint: &str) -> Result<Url, String> {
    let endpoint = base
        .join(endpoint)
        .map_err(|_| "Invalid MCP SSE endpoint")?;
    if endpoint.origin() != base.origin()
        || !endpoint.username().is_empty()
        || endpoint.password().is_some()
        || endpoint.fragment().is_some()
    {
        return Err("MCP SSE POST endpoint must stay on the configured origin".into());
    }
    Ok(endpoint)
}

type ByteStream = Pin<Box<dyn Stream<Item = Result<Vec<u8>, String>> + Send>>;
struct SseReader {
    stream: ByteStream,
    bytes: Vec<u8>,
    event: String,
    data: String,
    skip_lf: bool,
    id: Option<String>,
}
impl SseReader {
    fn new(response: reqwest::Response) -> Self {
        Self {
            stream: Box::pin(response.bytes_stream().map(|r| {
                r.map(|b| b.to_vec())
                    .map_err(|_| "MCP SSE stream failed".into())
            })),
            bytes: vec![],
            event: String::new(),
            data: String::new(),
            skip_lf: false,
            id: None,
        }
    }
    async fn next(&mut self) -> Result<(String, String), String> {
        loop {
            if self.skip_lf && !self.bytes.is_empty() {
                if self.bytes[0] == b'\n' {
                    self.bytes.remove(0);
                }
                self.skip_lf = false;
            }
            if let Some(index) = self.bytes.iter().position(|b| *b == b'\n' || *b == b'\r') {
                self.skip_lf = self.bytes[index] == b'\r';
                let line: Vec<_> = self.bytes.drain(..=index).collect();
                let line = std::str::from_utf8(&line[..index])
                    .map_err(|_| "Invalid UTF-8 in MCP SSE frame")?;
                if line.is_empty() {
                    let event = std::mem::take(&mut self.event);
                    if self.data.is_empty() {
                        continue;
                    }
                    let mut data = std::mem::take(&mut self.data);
                    data.pop();
                    return Ok((
                        if event.is_empty() {
                            "message".into()
                        } else {
                            event
                        },
                        data,
                    ));
                }
                let (key, value) = line.split_once(':').unwrap_or((line, ""));
                let value = value.strip_prefix(' ').unwrap_or(value);
                match key {
                    "id" if !value.contains('\0') => self.id = Some(value.into()),
                    "event" => self.event = value.into(),
                    "data" => {
                        self.data.push_str(value);
                        self.data.push('\n');
                    }
                    _ => {}
                }
                if self.data.len() + self.event.len() > MAX_FRAME {
                    return Err("MCP SSE frame exceeds 1 MiB".into());
                }
                continue;
            }
            let bytes = self
                .stream
                .next()
                .await
                .ok_or("MCP SSE connection closed")??;
            if self.bytes.len() + bytes.len() > MAX_FRAME {
                return Err("MCP SSE line exceeds 1 MiB".into());
            }
            self.bytes.extend(bytes);
        }
    }
}

#[cfg(test)]
mod tests;
