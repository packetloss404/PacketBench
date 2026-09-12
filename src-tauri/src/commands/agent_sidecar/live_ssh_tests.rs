//! Opt-in real OpenSSH acceptance. The runner owns the disposable host and
//! supplies an isolated HOME; normal `cargo test` never contacts a server.
use super::*;
use serde_json::json;

#[tokio::test]
#[ignore = "requires scripts/validate-live-ssh.mjs and its disposable OpenSSH host"]
async fn live_ssh_acceptance() {
    let input = std::env::var("ACCEPTANCE_INPUT").expect("acceptance input path");
    let output = std::env::var("ACCEPTANCE_OUTPUT").expect("acceptance output path");
    let spec: Value = serde_json::from_slice(&std::fs::read(input).unwrap()).unwrap();
    let config: SshConfig = serde_json::from_value(spec["ssh"].clone()).unwrap();
    assert!(config
        .host_fingerprint
        .as_deref()
        .is_some_and(|s| !s.is_empty()));
    assert_eq!(config.auth_method.as_deref(), Some("key"));
    // Constrain this test to the fixture. It must never become a convenient
    // arbitrary-host runner with request payloads from an untrusted file.
    assert_eq!(config.host, "127.0.0.1");
    validate_remote_sidecar_target(&config).unwrap();
    let mut cmd = Command::new("ssh");
    // Disable ambient ssh_config and multiplexing for independent connections.
    // All host verification/auth arguments still come from the production DTO.
    cmd.args([
        "-F",
        "none",
        "-o",
        "ControlMaster=no",
        "-o",
        "ControlPath=none",
    ])
    .args(config.ssh_args(false))
    .arg(remote_sidecar_launch_script(&config))
    .stdin(Stdio::piped())
    .stdout(Stdio::piped())
    .stderr(Stdio::piped())
    .kill_on_drop(true);
    hide_window_async(&mut cmd);
    let mut child = cmd.spawn().expect("launch OpenSSH");
    let mut stdin = child.stdin.take().unwrap();
    let mut stdout = BufReader::new(child.stdout.take().unwrap());
    let mut stderr = child.stderr.take().unwrap();
    let errors = tokio::spawn(async move {
        use tokio::io::AsyncReadExt;
        let mut bytes = Vec::new();
        stderr.read_to_end(&mut bytes).await.unwrap();
        String::from_utf8_lossy(&bytes).into_owned()
    });
    let handshake = await_remote_handshake(&mut stdout).await;
    let mut events = Vec::new();
    let result: Result<(), String> = async {
        handshake.clone()?;
        // Use the exact production wire encoder, including the remote host's
        // branded trusted-projects location. The key is deliberately fake.
        let mut request = super::super::protocol::encode_start_session(
            "acceptance",
            "echo".into(),
            "echo".into(),
            String::new(),
            vec![],
            json!({}),
            true,
            config.remote_path.clone(),
            "first turn".into(),
            Some("acceptance-sentinel-not-a-real-key".into()),
            None,
            None,
            None,
            Value::Null,
            Value::Null,
            None,
            None,
            None,
            Some(
                json!({"kind":"ssh", "serverId":"acceptance", "host":config.host,
                "port":config.port, "user":config.user, "remotePath":config.remote_path}),
            ),
            Value::Null,
        );
        for text in ["first turn", "second turn"] {
            stdin
                .write_all(format!("{request}\n").as_bytes())
                .await
                .map_err(|e| e.to_string())?;
            let mut chunks = String::new();
            tokio::time::timeout(Duration::from_secs(40), async {
                let mut buffer = Vec::new();
                loop {
                    let line = read_capped_line(&mut stdout, &mut buffer)
                        .await
                        .map_err(|e| e.to_string())?
                        .ok_or("EOF before done")?;
                    let event: Value = serde_json::from_str(&line).map_err(|e| e.to_string())?;
                    if event["sessionId"] != "acceptance" {
                        continue;
                    }
                    let kind = event["type"].as_str().unwrap_or_default().to_owned();
                    if kind == "chunk" {
                        chunks.push_str(event["text"].as_str().unwrap_or_default());
                    }
                    if kind == "error" {
                        return Err(format!("sidecar error: {event}"));
                    }
                    events.push(event);
                    if kind == "done" {
                        break;
                    }
                }
                Ok::<(), String>(())
            })
            .await
            .map_err(|_| "turn timed out")??;
            if chunks != text {
                return Err(format!("echo mismatch: {chunks:?}"));
            }
            request =
                json!({"type":"send_message", "sessionId":"acceptance", "content":"second turn"});
        }
        Ok(())
    }
    .await;
    drop(stdin);
    // Bound cleanup even for an old peer that deliberately keeps stdin open.
    if tokio::time::timeout(Duration::from_secs(3), child.wait())
        .await
        .is_err()
    {
        child.kill().await.unwrap();
        child.wait().await.unwrap();
    }
    let stderr = tokio::time::timeout(Duration::from_secs(3), errors)
        .await
        .unwrap()
        .unwrap();
    let report = json!({
        "version": env!("CARGO_PKG_VERSION"), "protocol": EXPECTED_PROTOCOL_VERSION,
        "dataDir": crate::core::brand::DATA_DIR_NAME,
        "handshakeAccepted": handshake.is_ok(), "error": result.as_ref().err(),
        "events": events, "stderr": stderr,
    });
    std::fs::write(output, serde_json::to_vec_pretty(&report).unwrap()).unwrap();
    if let Some(expected) = spec["expectedError"].as_str() {
        assert!(
            result.as_ref().is_err_and(|e| e.contains(expected)),
            "{result:?}"
        );
        assert!(
            handshake.is_err(),
            "rejection must precede request transmission"
        );
        if let Some(expected) = spec["expectedStderr"].as_str() {
            assert!(
                stderr.contains(expected),
                "unexpected SSH diagnostic: {stderr}"
            );
        }
    } else {
        result.unwrap();
    }
}
