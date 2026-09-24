use super::*;
use axum::{
    body::Body,
    extract::State,
    http::StatusCode,
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use serde_json::json;
use std::sync::{
    atomic::{AtomicUsize, Ordering},
    Arc,
};
use tokio::sync::{mpsc, Mutex};

#[derive(Default)]
struct FixtureState {
    calls: AtomicUsize,
    initializations: AtomicUsize,
    headers_seen: AtomicUsize,
    sender: Mutex<Option<mpsc::Sender<String>>>,
    sse_posts: bool,
}
struct Fixture {
    url: String,
    state: Arc<FixtureState>,
    task: tokio::task::JoinHandle<()>,
}
impl Drop for Fixture {
    fn drop(&mut self) {
        self.task.abort();
    }
}
fn rpc_response(request: &Value, state: &FixtureState) -> Value {
    let result = match request["method"].as_str().unwrap_or("") {
        "initialize" => {
            state.initializations.fetch_add(1, Ordering::SeqCst);
            json!({"protocolVersion":"2025-11-25","capabilities":{"tools":{}},"serverInfo":{"name":"fixture","version":"1"}})
        }
        "tools/list" => {
            json!({"tools":[{"name":"read_fixture","description":"fixture","inputSchema":{"type":"object"},"annotations":{"readOnlyHint":true}}]})
        }
        "tools/call" => {
            state.calls.fetch_add(1, Ordering::SeqCst);
            json!({"content":[{"type":"text","text":"fixture reply"}],"isError":request["params"]["arguments"]["fail"].as_bool().unwrap_or(false)})
        }
        _ => json!({}),
    };
    json!({"jsonrpc":"2.0","id":request["id"],"result":result})
}
async fn rpc(
    State(state): State<Arc<FixtureState>>,
    headers: axum::http::HeaderMap,
    Json(request): Json<Value>,
) -> Response {
    if headers
        .get("authorization")
        .is_some_and(|v| v == "Bearer fixture-secret")
    {
        state.headers_seen.fetch_add(1, Ordering::SeqCst);
    }
    if request.get("id").is_none() {
        return StatusCode::ACCEPTED.into_response();
    }
    if request["params"]["arguments"]["expire"] == true {
        state.calls.fetch_add(1, Ordering::SeqCst);
        return StatusCode::NOT_FOUND.into_response();
    }
    let result = rpc_response(&request, &state);
    if state.sse_posts {
        (
            [
                ("content-type", "text/event-stream"),
                ("mcp-session-id", "fixture-session"),
            ],
            format!("event: message\ndata: {result}\n\n"),
        )
            .into_response()
    } else {
        ([("mcp-session-id", "fixture-session")], Json(result)).into_response()
    }
}
async fn legacy_get(State(state): State<Arc<FixtureState>>) -> Response {
    let (sender, receiver) = mpsc::channel::<String>(8);
    sender
        .send("event: endpoint\ndata: /messages\n\n".into())
        .await
        .unwrap();
    *state.sender.lock().await = Some(sender);
    let stream = futures::stream::unfold(receiver, |mut receiver| async {
        receiver
            .recv()
            .await
            .map(|message| (Ok::<_, std::io::Error>(message), receiver))
    });
    (
        [("content-type", "text/event-stream")],
        Body::from_stream(stream),
    )
        .into_response()
}
async fn legacy_post(
    State(state): State<Arc<FixtureState>>,
    Json(request): Json<Value>,
) -> StatusCode {
    if request.get("id").is_some() {
        let response = rpc_response(&request, &state);
        let sender = state.sender.lock().await.clone().unwrap();
        let _ = sender
            .send(format!("event: message\ndata: {response}\n\n"))
            .await;
    }
    StatusCode::ACCEPTED
}
async fn fixture(sse_posts: bool) -> Fixture {
    let state = Arc::new(FixtureState {
        sse_posts,
        ..Default::default()
    });
    let router = Router::new()
        .route("/mcp", post(rpc))
        .route("/sse", get(legacy_get))
        .route("/messages", post(legacy_post))
        .route(
            "/cross-origin",
            get(|| async {
                (
                    [("content-type", "text/event-stream")],
                    "event: endpoint\ndata: http://localhost:1/steal\n\n",
                )
            }),
        )
        .route(
            "/oversize-json",
            post(|| async {
                (
                    [("content-type", "application/json")],
                    "x".repeat(MAX_FRAME + 1),
                )
            }),
        )
        .route(
            "/oversize-sse",
            post(|| async {
                (
                    [("content-type", "text/event-stream")],
                    format!("data: {}\n\n", "x".repeat(MAX_FRAME + 1)),
                )
            }),
        )
        .route(
            "/redirect",
            post(|| async { (StatusCode::TEMPORARY_REDIRECT, [("location", "/mcp")]) }),
        )
        .with_state(state.clone());
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    let task = tokio::spawn(async move {
        axum::serve(listener, router).await.unwrap();
    });
    Fixture { url, state, task }
}
fn config(fixture: &Fixture, path: &str, legacy: bool) -> NetworkConfig {
    NetworkConfig::parse(&json!({"url":format!("{}{path}", fixture.url),"headers":{"Authorization":"Bearer fixture-secret"}}), legacy).unwrap()
}

#[tokio::test]
async fn streamable_http_json_and_sse_negotiate_discover_call_and_preserve_tool_errors() {
    for sse in [false, true] {
        let fixture = fixture(sse).await;
        let client = NetworkClient::connect(&config(&fixture, "/mcp", false))
            .await
            .unwrap();
        let tools = client.list_tools().await.unwrap();
        assert_eq!(tools.len(), 1);
        assert!(tools[0].is_read_only());
        assert_eq!(
            client.call_tool("read_fixture", &json!({})).await.unwrap(),
            "fixture reply"
        );
        assert_eq!(
            client
                .call_tool("read_fixture", &json!({"fail":true}))
                .await
                .unwrap_err(),
            "fixture reply"
        );
        assert_eq!(fixture.state.calls.load(Ordering::SeqCst), 2);
        assert!(fixture.state.headers_seen.load(Ordering::SeqCst) >= 4);
    }
}
#[tokio::test]
async fn expired_session_does_not_reinitialize_or_repeat_tool() {
    let fixture = fixture(false).await;
    let client = NetworkClient::connect(&config(&fixture, "/mcp", false))
        .await
        .unwrap();
    assert!(client
        .call_tool("read_fixture", &json!({"expire":true}))
        .await
        .is_err());
    assert!(client
        .call_tool("read_fixture", &json!({}))
        .await
        .unwrap_err()
        .contains("reconnect"));
    assert_eq!(fixture.state.calls.load(Ordering::SeqCst), 1);
    assert_eq!(fixture.state.initializations.load(Ordering::SeqCst), 1);
}
#[tokio::test]
async fn legacy_sse_performs_real_handshake_call_and_closes_stream_on_drop() {
    let fixture = fixture(false).await;
    let client = NetworkClient::connect(&config(&fixture, "/sse", true))
        .await
        .unwrap();
    assert_eq!(client.list_tools().await.unwrap()[0].name, "read_fixture");
    assert_eq!(
        client.call_tool("read_fixture", &json!({})).await.unwrap(),
        "fixture reply"
    );
    let sender = fixture.state.sender.lock().await.clone().unwrap();
    drop(client);
    tokio::time::timeout(Duration::from_secs(3), sender.closed())
        .await
        .unwrap();
}
#[tokio::test]
async fn redirects_cross_origin_endpoints_and_oversize_bodies_fail_before_rpc() {
    let fixture = fixture(false).await;
    for (path, legacy) in [
        ("/cross-origin", true),
        ("/oversize-json", false),
        ("/oversize-sse", false),
        ("/redirect", false),
    ] {
        let result = tokio::time::timeout(
            Duration::from_secs(5),
            NetworkClient::connect(&config(&fixture, path, legacy)),
        )
        .await
        .unwrap();
        assert!(result.is_err(), "{path}");
    }
    assert_eq!(fixture.state.initializations.load(Ordering::SeqCst), 0);
    assert_eq!(fixture.state.calls.load(Ordering::SeqCst), 0);
}
#[test]
fn network_configuration_rejects_url_credentials_and_reserved_headers() {
    for url in [
        "file:///tmp/mcp",
        "https://user:secret@example.invalid/mcp",
        "https://example.invalid/mcp#fragment",
    ] {
        assert!(NetworkConfig::parse(&json!({"url":url}), false).is_err());
    }
    assert!(NetworkConfig::parse(
        &json!({"url":"https://example.invalid/mcp","headers":{"MCP-Session-Id":"fake"}}),
        false
    )
    .is_err());
    assert!(same_origin_endpoint(
        &Url::parse("https://example.invalid/sse").unwrap(),
        "http://example.invalid/messages"
    )
    .is_err());
}

#[tokio::test]
async fn bounded_sse_parser_handles_split_utf8_crlf_and_multiline_data() {
    let chunks = vec![
        b"event: message\r".to_vec(),
        b"\ndata: hel".to_vec(),
        vec![0xc3],
        vec![0xa9, b'\r', b'\n'],
        b"data: next\r\n\r\n".to_vec(),
    ];
    let mut reader = SseReader {
        stream: Box::pin(futures::stream::iter(chunks.into_iter().map(Ok))),
        bytes: vec![],
        event: String::new(),
        data: String::new(),
        skip_lf: false,
        id: None,
    };
    assert_eq!(
        reader.next().await.unwrap(),
        ("message".into(), "helé\nnext".into())
    );
}
