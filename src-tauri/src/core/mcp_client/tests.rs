use super::*;

#[test]
fn structured_tool_content_is_preserved_without_text() {
    assert_eq!(
        extract_text_content(&json!({"structuredContent":{"count":2}})),
        "{\"count\":2}"
    );
    assert_eq!(
        extract_text_content(&json!({"content":[],"structuredContent":{"count":2}})),
        "{\"count\":2}"
    );
    assert_eq!(
        extract_text_content(
            &json!({"content":[{"type":"text","text":"readable"}],"structuredContent":{"count":2}})
        ),
        "readable"
    );
}

#[tokio::test]
async fn real_stdio_child_uses_frozen_cwd_env_pagination_and_drops_process_tree() {
    let dir = tempfile::tempdir().unwrap();
    let script = dir.path().join("fixture.cjs");
    let heartbeat = dir.path().join("heartbeat");
    std::fs::write(&script, r#"
const fs = require('fs');
const {spawn} = require('child_process');
const heartbeat = process.argv[2];
spawn(process.execPath, ['-e', `setInterval(()=>require('fs').writeFileSync(process.argv[1],String(Date.now())),25)`, heartbeat], {stdio:'ignore', windowsHide:true});
require('readline').createInterface({input:process.stdin}).on('line', line=>{
 const r=JSON.parse(line); if(r.id===undefined) return;
 let result={};
 if(r.method==='initialize') result={protocolVersion:'2024-11-05',capabilities:{tools:{}},serverInfo:{name:'fixture',version:'1'}};
 if(r.method==='tools/list') result={tools:[{name:r.params.cursor?'second':'first',inputSchema:{type:'object'},annotations:{readOnlyHint:true}}], ...(r.params.cursor?{}:{nextCursor:'page2'})};
 if(r.method==='tools/call') result={content:[{type:'text',text:JSON.stringify({cwd:process.cwd(),token:process.env.FIXTURE_TOKEN})}]};
 process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:r.id,result})+'\n');
});
"#).unwrap();
    let mut client = McpClient::spawn_in_directory(
        "fixture",
        "node",
        &[
            script.to_string_lossy().into(),
            heartbeat.to_string_lossy().into(),
        ],
        &HashMap::from([("FIXTURE_TOKEN".into(), "frozen-value".into())]),
        Some(dir.path()),
    )
    .await
    .unwrap();
    let tools = client.list_tools().await.unwrap();
    assert_eq!(
        tools
            .iter()
            .map(|tool| tool.name.as_str())
            .collect::<Vec<_>>(),
        vec!["first", "second"]
    );
    let result: Value =
        serde_json::from_str(&client.call_tool("first", &json!({})).await.unwrap()).unwrap();
    assert_eq!(
        std::path::Path::new(result["cwd"].as_str().unwrap()),
        dir.path()
    );
    assert_eq!(result["token"], "frozen-value");
    tokio::time::timeout(Duration::from_secs(5), async {
        while !heartbeat.exists() {
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
    })
    .await
    .unwrap();
    drop(client);
    // A still-running grandchild would update this file repeatedly.
    tokio::time::sleep(Duration::from_millis(100)).await;
    let stopped = std::fs::read_to_string(&heartbeat).unwrap();
    tokio::time::sleep(Duration::from_millis(200)).await;
    assert_eq!(std::fs::read_to_string(&heartbeat).unwrap(), stopped);
}
