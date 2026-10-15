//! Opt-in live Sugar acceptance through the same adapter used by the desktop app.
//! Uses the existing OS-keyring credential and only synthetic content.
use super::*;
use serde_json::json;

#[derive(Default)]
struct Turn {
    text: String,
    blocks: Vec<ContentBlock>,
    calls: Vec<ToolCall>,
    done: bool,
}

async fn live_turn(key: &str, messages: Vec<ChatMessage>, tools: Vec<ToolDefinition>) -> Turn {
    tokio::time::timeout(std::time::Duration::from_secs(120), async {
        let (tx, mut rx) = mpsc::channel(64);
        let key = key.to_string();
        let provider = super::super::llm_provider::get_provider("sugar").unwrap();
        let request: LlmRequest = serde_json::from_value(json!({
            "model":"sugar/conduit", "messages":messages, "tools":tools,
            "max_tokens":2048, "cache_key":"packetbench-sugar-acceptance"
        }))
        .unwrap();
        let producer = tokio::spawn(async move { provider.stream_chat(&key, request, tx).await });
        let mut turn = Turn::default();
        while let Some(chunk) = rx.recv().await {
            match chunk {
                StreamChunk::TextDelta { text } => turn.text.push_str(&text),
                StreamChunk::ToolUseEnd {
                    id,
                    name,
                    arguments,
                } => {
                    turn.calls.push(ToolCall {
                        id: id.clone(),
                        name: name.clone(),
                        arguments: arguments.clone(),
                    });
                    turn.blocks.push(ContentBlock::ToolUse {
                        id,
                        name,
                        arguments,
                    });
                }
                StreamChunk::ReasoningDetails { details } => turn
                    .blocks
                    .push(ContentBlock::ProviderReasoning { details }),
                StreamChunk::Done { .. } => turn.done = true,
                StreamChunk::Error { .. } => panic!("Sugar emitted a native stream error"),
                _ => {}
            }
        }
        assert!(
            producer.await.unwrap().is_ok(),
            "Sugar native transport failed"
        );
        assert!(turn.done, "Sugar stream ended without Done");
        if !turn.text.is_empty() {
            turn.blocks.insert(
                0,
                ContentBlock::Text {
                    text: turn.text.clone(),
                },
            );
        }
        turn
    })
    .await
    .expect("Sugar live turn exceeded the 120-second limit")
}

fn user(text: &str) -> ChatMessage {
    ChatMessage {
        role: ChatRole::User,
        content: MessageContent::text(text),
    }
}

#[tokio::test]
#[ignore = "Calls live Sugar using the saved key; requires PACKETBENCH_LIVE_SUGAR_TEST=1"]
async fn sugar_live_packetbench_acceptance() {
    assert_eq!(
        std::env::var("PACKETBENCH_LIVE_SUGAR_TEST").as_deref(),
        Ok("1")
    );
    assert_eq!(
        provider_endpoints::resolve("sugar").unwrap(),
        "https://usesugar.dev/api/v1"
    );
    let key = crate::commands::api_keys::load_api_key("sugar")
        .expect("Connect Sugar in PacketBench first");
    let models = crate::commands::provider_models::list_provider_models("sugar".into())
        .await
        .unwrap();
    assert!(models.iter().any(|m| m.id == "sugar/conduit"));
    println!("Sugar native catalog: passed ({} models)", models.len());

    let mut messages = vec![user("Synthetic integration test. Remember the code word MARBLE. Reply with exactly PACKETBENCH_NATIVE_SUGAR_OK.")];
    let first = live_turn(&key, messages.clone(), vec![]).await;
    assert!(first.text.contains("PACKETBENCH_NATIVE_SUGAR_OK"));
    messages.push(ChatMessage {
        role: ChatRole::Assistant,
        content: MessageContent::Blocks(first.blocks),
    });
    messages.push(user(
        "Reply with only the code word I asked you to remember.",
    ));
    let followup = live_turn(&key, messages, vec![]).await;
    assert!(followup.text.contains("MARBLE"));
    println!("Sugar native streaming and follow-up: passed");

    let tools = vec![ToolDefinition {
        name: "read_test_marker".into(),
        description: "Read the synthetic integration-test file.".into(),
        parameters: json!({"type":"object","properties":{},"required":[]}),
    }];
    let mut messages = vec![user("Call read_test_marker exactly once with no arguments. After receiving the result, reply with that exact value only.")];
    let tool_turn = live_turn(&key, messages.clone(), tools.clone()).await;
    assert_eq!(tool_turn.calls.len(), 1);
    assert_eq!(tool_turn.calls[0].name, "read_test_marker");
    let path = std::env::temp_dir().join(format!(
        "packetbench-sugar-test-{}.txt",
        uuid::Uuid::new_v4()
    ));
    std::fs::write(&path, "PACKETBENCH_NATIVE_FILE_OK_7Q3M").unwrap();
    let value = std::fs::read_to_string(&path).unwrap();
    std::fs::remove_file(&path).unwrap();
    let id = tool_turn.calls[0].id.clone();
    messages.push(ChatMessage {
        role: ChatRole::Assistant,
        content: MessageContent::Blocks(tool_turn.blocks),
    });
    messages.push(ChatMessage {
        role: ChatRole::Tool,
        content: MessageContent::Blocks(vec![ContentBlock::ToolResult {
            tool_call_id: id,
            content: value.clone(),
            is_error: false,
        }]),
    });
    let final_turn = live_turn(&key, messages, tools).await;
    assert!(final_turn.text.contains(&value));
    println!("Sugar native local-file tool and result round-trip: passed");
}
