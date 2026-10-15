use super::*;
use std::sync::{Arc, Mutex};

fn fixture() -> tempfile::TempDir {
    let dir = tempfile::tempdir().unwrap();
    std::fs::create_dir_all(dir.path().join("src")).unwrap();
    std::fs::write(dir.path().join("src/cart.ts"), "export function total(items: number[]) {\n  return items.length; // should sum prices\n}\n").unwrap();
    dir
}
fn project(dir: &tempfile::TempDir) -> ReadOnlyProject {
    ReadOnlyProject::new(dir.path().to_str().unwrap()).unwrap()
}
fn done() -> StreamChunk {
    StreamChunk::Done {
        input_tokens: 10,
        output_tokens: 5,
        cache_read_input_tokens: 2,
        cache_creation_input_tokens: 0,
    }
}
fn question() -> ChatMessage {
    ChatMessage {
        role: ChatRole::User,
        content: MessageContent::text("Read src/cart.ts and explain the total bug."),
    }
}
fn request(dir: &tempfile::TempDir) -> ResearchRequest {
    ResearchRequest {
        task: AuxTaskClass::AgentChat,
        route: AuxRoute {
            provider: "sugar".into(),
            model: "sugar/conduit".into(),
            explicit: true,
        },
        project_path: dir.path().to_str().unwrap().into(),
        session_id: "research-test".into(),
        messages: vec![question()],
    }
}

#[test]
fn tools_reject_escape_credentials_links_and_writes() {
    let dir = fixture();
    let p = project(&dir);
    for path in [
        "../outside",
        "..\\outside",
        "/etc/passwd",
        "C:/secret",
        "src/cart.ts:stream",
        ".env",
        "credentials.json",
        "node_modules/x",
        ".git/config",
    ] {
        assert!(
            p.execute("read_file", &json!({"path":path})).is_err(),
            "accepted {path}"
        );
    }
    for name in ["bash", "write_file", "edit_file", "web_fetch", "mcp"] {
        assert!(p
            .execute(name, &json!({"path":"src/cart.ts","content":"changed"}))
            .is_err());
    }
    assert!(std::fs::read_to_string(dir.path().join("src/cart.ts"))
        .unwrap()
        .contains("items.length"));
    assert_eq!(readonly_tools().len(), 3);
    #[cfg(windows)]
    {
        if std::os::windows::fs::symlink_file(
            dir.path().join("src/cart.ts"),
            dir.path().join("linked.ts"),
        )
        .is_ok()
        {
            assert!(p.read("linked.ts").is_err());
        }
    }
    #[cfg(unix)]
    {
        std::os::unix::fs::symlink(dir.path().join("src/cart.ts"), dir.path().join("linked.ts"))
            .unwrap();
        assert!(p.read("linked.ts").is_err());
    }
}

#[test]
fn read_and_search_show_lines_and_omit_sensitive_paths() {
    let dir = fixture();
    let p = project(&dir);
    std::fs::write(dir.path().join("credentials.json"), "HIDDEN_MARKER").unwrap();
    std::fs::create_dir(dir.path().join("secret-folder")).unwrap();
    std::fs::write(dir.path().join("secret-folder/x.txt"), "HIDDEN_MARKER").unwrap();
    std::fs::write(dir.path().join(".env"), "HIDDEN_MARKER").unwrap();
    let line = p
        .execute(
            "read_file",
            &json!({"path":"src/cart.ts","start_line":2,"max_lines":1}),
        )
        .unwrap();
    assert!(line.contains("2:   return items.length"));
    assert!(!line.contains("1: export"));
    let search = p
        .execute("search_files", &json!({"query":"items.length"}))
        .unwrap();
    assert!(search.contains("src/cart.ts:2:"));
    assert!(!p
        .execute("search_files", &json!({"query":"HIDDEN_MARKER"}))
        .unwrap()
        .contains("HIDDEN_MARKER"));
    let listing = p.execute("list_directory", &json!({"path":"."})).unwrap();
    assert!(listing.contains("src/"));
    assert!(!listing.contains("secret"));
    assert!(!listing.contains("credentials"));
}

#[test]
fn reads_are_bounded_and_binary_files_are_refused() {
    let dir = fixture();
    let p = project(&dir);
    std::fs::write(dir.path().join("binary.bin"), [0, 1, 2]).unwrap();
    assert!(p.read("binary.bin").is_err());
    std::fs::write(
        dir.path().join("large.txt"),
        vec![b'a'; MAX_FILE_BYTES as usize + 1],
    )
    .unwrap();
    assert!(p.read("large.txt").is_err());
    std::fs::write(dir.path().join("text.txt"), "界".repeat(20_000)).unwrap();
    let result = p.execute("read_file", &json!({"path":"text.txt"})).unwrap();
    assert!(result.len() < MAX_RESULT_BYTES + 100);
    assert!(result.contains("truncated"));
}

struct ScriptedProvider {
    requests: Arc<Mutex<Vec<LlmRequest>>>,
    turns: Mutex<std::collections::VecDeque<Vec<StreamChunk>>>,
}
#[async_trait::async_trait]
impl LlmProvider for ScriptedProvider {
    async fn stream_chat(
        &self,
        _key: &str,
        request: LlmRequest,
        tx: mpsc::Sender<StreamChunk>,
    ) -> Result<(), String> {
        self.requests.lock().unwrap().push(request);
        let chunks = self.turns.lock().unwrap().pop_front().unwrap_or_default();
        for chunk in chunks {
            tx.send(chunk).await.map_err(|e| e.to_string())?;
        }
        Ok(())
    }
    fn provider_id(&self) -> &str {
        "sugar"
    }
}
fn scripted(turns: Vec<Vec<StreamChunk>>) -> (Box<dyn LlmProvider>, Arc<Mutex<Vec<LlmRequest>>>) {
    let requests = Arc::new(Mutex::new(Vec::new()));
    (
        Box::new(ScriptedProvider {
            requests: requests.clone(),
            turns: Mutex::new(turns.into()),
        }),
        requests,
    )
}

#[tokio::test]
async fn loop_replays_tool_results_reasoning_selected_model_and_usage() {
    let dir = fixture();
    let req = request(&dir);
    let (provider, requests) = scripted(vec![
        vec![
            StreamChunk::ReasoningDetails {
                details: json!({"signature":"opaque"}),
            },
            StreamChunk::ToolUseEnd {
                id: "read1".into(),
                name: "read_file".into(),
                arguments: json!({"path":"src/cart.ts"}),
            },
            done(),
        ],
        vec![
            StreamChunk::TextDelta {
                text: "src/cart.ts:2 returns the count instead of the sum.".into(),
            },
            done(),
        ],
    ]);
    let mut metered = Vec::new();
    let text = research_loop(
        req,
        project(&dir),
        provider,
        "test-key".into(),
        |_| {},
        |usage| {
            metered.push(usage.input_tokens);
            Ok(())
        },
    )
    .await
    .unwrap();
    assert!(text.contains("instead of the sum"));
    assert_eq!(metered, vec![10, 10]);
    let requests = requests.lock().unwrap();
    assert_eq!(requests.len(), 2);
    assert!(requests.iter().all(|r| r.model == "sugar/conduit"));
    assert!(serde_json::to_string(&requests[1].messages)
        .unwrap()
        .contains("opaque"));
    assert!(serde_json::to_string(&requests[1].messages)
        .unwrap()
        .contains("items.length"));
    assert!(requests.iter().all(|r| r.tools.iter().all(|t| [
        "read_file",
        "list_directory",
        "search_files"
    ]
    .contains(&t.name.as_str()))));
}

#[tokio::test]
async fn incomplete_and_empty_provider_responses_fail() {
    let dir = fixture();
    for turn in [
        vec![StreamChunk::TextDelta {
            text: "Partial".into(),
        }],
        vec![done()],
    ] {
        let (provider, _) = scripted(vec![turn]);
        assert!(research_loop(
            request(&dir),
            project(&dir),
            provider,
            "test-key".into(),
            |_| {},
            |_| Ok(())
        )
        .await
        .is_err());
    }
}

#[tokio::test]
async fn step_limit_cannot_loop_forever() {
    let dir = fixture();
    let turns = (0..MAX_ROUNDS)
        .map(|i| {
            vec![
                StreamChunk::ToolUseEnd {
                    id: format!("call{i}"),
                    name: "bash".into(),
                    arguments: json!({"command":"touch changed"}),
                },
                done(),
            ]
        })
        .collect();
    let (provider, requests) = scripted(turns);
    let error = research_loop(
        request(&dir),
        project(&dir),
        provider,
        "test-key".into(),
        |_| {},
        |_| Ok(()),
    )
    .await
    .unwrap_err();
    assert!(error.contains("step limit"));
    assert_eq!(requests.lock().unwrap().len(), MAX_ROUNDS);
    assert!(!dir.path().join("changed").exists());
}

#[tokio::test]
async fn dropping_stream_guard_aborts_provider_task() {
    let task = tokio::spawn(std::future::pending::<()>());
    let guard = AbortOnDrop(task.abort_handle());
    drop(guard);
    assert!(task.await.unwrap_err().is_cancelled());
}

#[tokio::test]
#[ignore = "Calls live Sugar with the saved key; requires PACKETBENCH_LIVE_SUGAR_TEST=1"]
async fn sugar_live_insights_and_issue_investigation() {
    assert_eq!(
        std::env::var("PACKETBENCH_LIVE_SUGAR_TEST").as_deref(),
        Ok("1")
    );
    let dir = fixture();
    std::fs::write(
        dir.path().join("research-marker.txt"),
        "INSIGHTS_MARKER_8F2K",
    )
    .unwrap();
    let route = || AuxRoute {
        provider: "sugar".into(),
        model: "sugar/conduit".into(),
        explicit: true,
    };
    let streamed = Mutex::new(String::new());
    let answer=crate::commands::insights::research_chat(route(),dir.path().to_str().unwrap().into(),"sugar-insights-live".into(),vec![crate::commands::insights::AgentChatMessage {role:"user".into(),content:"Read research-marker.txt using the file tool and reply with its exact contents. Remember the code word MARBLE for my next question.".into()}],None,|text|streamed.lock().unwrap().push_str(text)).await.unwrap();
    assert!(answer.contains("INSIGHTS_MARKER_8F2K"));
    assert_eq!(answer, *streamed.lock().unwrap());
    let followup = crate::commands::insights::research_chat(
        route(),
        dir.path().to_str().unwrap().into(),
        "sugar-insights-followup".into(),
        vec![
            crate::commands::insights::AgentChatMessage {
                role: "user".into(),
                content: "Remember the code word MARBLE.".into(),
            },
            crate::commands::insights::AgentChatMessage {
                role: "assistant".into(),
                content: answer,
            },
            crate::commands::insights::AgentChatMessage {
                role: "user".into(),
                content: "What code word did I ask you to remember? Reply with just that word."
                    .into(),
            },
        ],
        None,
        |_| {},
    )
    .await
    .unwrap();
    assert!(followup.contains("MARBLE"));
    println!("Sugar Insights chat: file tools, streaming, and history passed");
    let investigation=crate::commands::github::research_issue(route(),dir.path().to_str().unwrap().into(),"Cart total counts items instead of adding prices","In src/cart.ts, total([10,20]) returns 2 instead of 30. Inspect the actual source with your file tools and explain the root cause and suggested fix. Do not modify files.").await.unwrap();
    assert!(investigation.contains("src/cart.ts"));
    assert!(investigation.contains("length"));
    assert!(std::fs::read_to_string(dir.path().join("src/cart.ts"))
        .unwrap()
        .contains("return items.length"));
    println!("Sugar issue investigation: source inspection and root-cause analysis passed");
}
