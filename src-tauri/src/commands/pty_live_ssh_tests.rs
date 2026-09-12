//! Opt-in native Workspace transport acceptance; no application test endpoint.
use super::*;
use serde_json::{json, Value};
use std::sync::mpsc::{channel, Receiver};
use std::time::Instant;

fn collect_until(
    output: &Receiver<String>,
    transcript: &mut String,
    marker: &str,
) -> Result<(), String> {
    let deadline = Instant::now() + Duration::from_secs(30);
    while !transcript.contains(marker) {
        let remaining = deadline.saturating_duration_since(Instant::now());
        let chunk = output.recv_timeout(remaining).map_err(|error| {
            format!(
                "Waiting for {marker}: {error}; observed {} bytes",
                transcript.len()
            )
        })?;
        transcript.push_str(&chunk);
    }
    Ok(())
}

#[test]
#[ignore = "requires the disposable, pinned OpenSSH fixture from acceptance:ssh"]
fn workspace_live_ssh_acceptance() {
    let input_path = std::env::var("ACCEPTANCE_INPUT").expect("ACCEPTANCE_INPUT");
    let output_path = std::env::var("ACCEPTANCE_OUTPUT").expect("ACCEPTANCE_OUTPUT");
    let spec: Value = serde_json::from_slice(&std::fs::read(input_path).unwrap()).unwrap();
    let args: Vec<String> = serde_json::from_value(spec["args"].clone()).unwrap();
    let mode = spec["mode"].as_str().unwrap();
    // This opt-in test accepts only the loopback fixture command, never a
    // user's saved SSH server or an arbitrary remote project.
    assert_eq!(args.get(args.len() - 2).unwrap(), "root@127.0.0.1");
    assert!(args
        .last()
        .unwrap()
        .contains("/opt/workspace-pty-fixture.mjs"));
    assert!(args.iter().any(|arg| arg == "StrictHostKeyChecking=yes"));
    let launch = resolve_pty_launch("ssh");
    let pair = native_pty_system()
        .openpty(PtySize {
            rows: 30,
            cols: 240,
            pixel_width: 0,
            pixel_height: 0,
        })
        .unwrap();
    let mut cmd = CommandBuilder::new(&launch.path);
    cmd.args(&args);
    cmd.cwd(std::env::var("HOME").unwrap());
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");
    let mut child = pair.slave.spawn_command(cmd).expect("spawn native SSH PTY");
    drop(pair.slave);
    let mut killer = child.clone_killer();
    let mut reader = pair.master.try_clone_reader().unwrap();
    let mut writer = pair.master.take_writer().unwrap();
    let (observed_tx, observed_rx) = channel();
    let (finished_tx, finished_rx) = channel();
    let reader_thread = thread::spawn(move || {
        let (sender, receiver) = crate::core::pty_output::output_channel();
        let dispatcher = thread::spawn(move || {
            crate::core::pty_output::dispatch_output(receiver, |data| {
                let _ = observed_tx.send(data);
            });
        });
        let mut pending = Vec::new();
        let mut bytes = [0u8; 8192];
        loop {
            match reader.read(&mut bytes) {
                Ok(0) => break,
                Ok(count) => {
                    let text =
                        crate::core::pty::decode_terminal_chunk(&bytes[..count], &mut pending);
                    if !text.is_empty() && sender.send(text).is_err() {
                        break;
                    }
                }
                Err(error) if is_terminal_pty_read_error(&error) => break,
                Err(_) => thread::sleep(Duration::from_millis(10)),
            }
        }
        if !pending.is_empty() {
            let _ = sender.send(String::from_utf8_lossy(&pending).into_owned());
        }
        drop(sender);
        dispatcher.join().unwrap();
        let _ = finished_tx.send(());
    });
    let mut transcript = String::new();
    let result = (|| -> Result<Value, String> {
        let send = |writer: &mut Box<dyn Write + Send>, input: &str| -> Result<(), String> {
            writer
                .write_all(format!("{input}\r").as_bytes())
                .map_err(|e| e.to_string())?;
            writer.flush().map_err(|e| e.to_string())
        };
        if mode != "wrong-host-key" {
            collect_until(&observed_rx, &mut transcript, "WS_CWD:/work/project")?;
            if !transcript.contains("WS_READY:stdin=1:stdout=1") {
                return Err("SSH did not allocate an interactive remote PTY".to_owned());
            }
            send(&mut writer, "PING:日本語🦀")?;
            collect_until(&observed_rx, &mut transcript, "WS_PONG:日本語🦀")?;
            pair.master
                .resize(PtySize {
                    rows: 42,
                    cols: 260,
                    pixel_width: 0,
                    pixel_height: 0,
                })
                .map_err(|e| e.to_string())?;
            // SSH delivers SIGWINCH asynchronously; retry only this harmless
            // observation until the remote PTY reports the requested size.
            for _ in 0..20 {
                send(&mut writer, "SIZE")?;
                thread::sleep(Duration::from_millis(50));
                while let Ok(chunk) = observed_rx.try_recv() {
                    transcript.push_str(&chunk);
                }
                if transcript.contains("WS_SIZE:42:260") {
                    break;
                }
            }
            if !transcript.contains("WS_SIZE:42:260") {
                return Err("Remote resize did not propagate".to_owned());
            }
            if mode == "disconnect" {
                std::fs::write(spec["readyPath"].as_str().unwrap(), b"ready")
                    .map_err(|e| e.to_string())?;
            } else {
                if mode == "burst" {
                    send(&mut writer, "BURST")?;
                    collect_until(&observed_rx, &mut transcript, "WS_BURST_DONE:10000")?;
                    let mut remaining = transcript.as_str();
                    for index in 0..10_000 {
                        let marker = format!("WS_BURST_LINE_{index:05}:");
                        let offset = remaining.find(&marker).ok_or_else(|| {
                            format!("Burst marker missing or out of order: {marker}")
                        })?;
                        remaining = &remaining[offset + marker.len()..];
                    }
                    if transcript.matches("WS_BURST_LINE_").count() != 10_000 {
                        return Err("Burst contains missing or duplicated lines".to_owned());
                    }
                    // ConPTY can redraw earlier screen text on resize. Use a
                    // fresh marker so that redraw cannot fake a second reply.
                    send(&mut writer, "PING:AFTER_BURST")?;
                    collect_until(&observed_rx, &mut transcript, "WS_PONG:AFTER_BURST")?;
                }
                let code = if mode == "failed-exit" { 7 } else { 0 };
                send(&mut writer, &format!("EXIT:{code}"))?;
            }
        }
        let deadline = Instant::now() + Duration::from_secs(30);
        let status = loop {
            while let Ok(chunk) = observed_rx.try_recv() {
                transcript.push_str(&chunk);
            }
            if let Some(status) = child.try_wait().map_err(|e| e.to_string())? {
                break status;
            }
            if Instant::now() >= deadline {
                return Err("SSH child did not exit".to_owned());
            }
            thread::sleep(Duration::from_millis(20));
        };
        let expected = match mode {
            "failed-exit" => 7,
            "wrong-host-key" => 255,
            _ => 0,
        };
        // Windows OpenSSH can report unsigned -1 (4294967295) when its
        // transport disappears. Preserve the observed nonzero code; do not
        // pretend every platform reports Unix ssh's conventional 255.
        if mode == "disconnect" && status.exit_code() == 0 {
            return Err("Disconnected transport was reported as successful".to_owned());
        }
        if mode != "disconnect" && status.exit_code() != expected {
            return Err(format!("Exit code {} != {expected}", status.exit_code()));
        }
        Ok(json!({"exitCode": status.exit_code()}))
    })();
    // Always reap this invocation's child, including failed assertions/timeouts.
    let _ = killer.kill();
    drop(writer);
    drop(pair.master);
    let drained = finished_rx.recv_timeout(Duration::from_secs(10)).is_ok();
    if drained {
        reader_thread.join().unwrap();
    }
    while let Ok(chunk) = observed_rx.try_recv() {
        transcript.push_str(&chunk);
    }
    let result = result.and_then(|mut evidence| {
        if !drained {
            return Err("PTY output reader did not drain after exit".to_owned());
        }
        if mode == "wrong-host-key" {
            if !transcript.contains("REMOTE HOST IDENTIFICATION HAS CHANGED")
                || transcript.contains("WS_READY")
            {
                return Err("Wrong host pin was not rejected before remote execution".to_owned());
            }
        } else if mode != "disconnect" {
            let code = if mode == "failed-exit" { 7 } else { 0 };
            if !transcript.contains(&format!("WS_FINAL:{code}")) {
                return Err("Final output lost before exit".to_owned());
            }
        }
        evidence["outputBytes"] = json!(transcript.len());
        evidence["unicodeRoundTrip"] = json!(transcript.contains("WS_PONG:日本語🦀"));
        evidence["remoteResize"] = json!(transcript.contains("WS_SIZE:42:260"));
        evidence["burstLines"] = json!(if mode == "burst" { 10_000 } else { 0 });
        evidence["postBurstInput"] = json!(transcript.contains("WS_PONG:AFTER_BURST"));
        evidence["drainedBeforeCompletion"] = json!(true);
        Ok(evidence)
    });
    let evidence = match &result {
        Ok(details) => {
            json!({"passed": true, "mode": mode, "sshBinary": launch.path, "details": details})
        }
        Err(error) => {
            json!({"passed": false, "mode": mode, "error": error, "outputTail": transcript.chars().rev().take(4000).collect::<String>().chars().rev().collect::<String>()})
        }
    };
    std::fs::write(output_path, serde_json::to_vec_pretty(&evidence).unwrap()).unwrap();
    assert!(result.is_ok(), "{}", result.unwrap_err());
}

/// Genuine CLI provider check. Arguments are generated from an existing
/// strict-pinned SSH configuration by scripts/acceptance/provider-ssh.mjs.
/// This exercises print-mode CLI execution through a native PTY, not its TUI.
#[test]
#[ignore = "requires an explicitly selected existing authenticated SSH CLI host"]
fn workspace_provider_ssh_acceptance() {
    let spec: Value =
        serde_json::from_slice(&std::fs::read(std::env::var("ACCEPTANCE_INPUT").unwrap()).unwrap())
            .unwrap();
    let args: Vec<String> = serde_json::from_value(spec["args"].clone()).unwrap();
    assert!(args.iter().any(|arg| arg == "StrictHostKeyChecking=yes"));
    assert!(args.last().unwrap().contains("'--safe-mode'"));
    assert!(args.last().unwrap().contains("'--no-session-persistence'"));
    assert!(args.last().unwrap().contains("'--tools' ''"));
    let launch = resolve_pty_launch("ssh");
    let pair = native_pty_system()
        .openpty(PtySize {
            rows: 30,
            cols: 5000,
            pixel_width: 0,
            pixel_height: 0,
        })
        .unwrap();
    let mut command = CommandBuilder::new(&launch.path);
    command.args(&args);
    command.env("TERM", "xterm-256color");
    let mut child = pair.slave.spawn_command(command).unwrap();
    drop(pair.slave);
    let mut killer = child.clone_killer();
    let writer = pair.master.take_writer().unwrap();
    let mut reader = pair.master.try_clone_reader().unwrap();
    let (observed_tx, observed_rx) = channel();
    let (finished_tx, finished_rx) = channel();
    let reader_thread = thread::spawn(move || {
        let (sender, receiver) = crate::core::pty_output::output_channel();
        let dispatcher = thread::spawn(move || {
            crate::core::pty_output::dispatch_output(receiver, |data| {
                let _ = observed_tx.send(data);
            });
        });
        let mut pending = Vec::new();
        let mut bytes = [0u8; 8192];
        loop {
            match reader.read(&mut bytes) {
                Ok(0) => break,
                Ok(count) => {
                    let text =
                        crate::core::pty::decode_terminal_chunk(&bytes[..count], &mut pending);
                    if !text.is_empty() && sender.send(text).is_err() {
                        break;
                    }
                }
                Err(error) if is_terminal_pty_read_error(&error) => break,
                Err(_) => thread::sleep(Duration::from_millis(10)),
            }
        }
        if !pending.is_empty() {
            let _ = sender.send(String::from_utf8_lossy(&pending).into_owned());
        }
        drop(sender);
        dispatcher.join().unwrap();
        let _ = finished_tx.send(());
    });
    let started = Instant::now();
    let mut output = String::new();
    let outcome = loop {
        while let Ok(chunk) = observed_rx.try_recv() {
            output.push_str(&chunk);
        }
        if output.len() > 2 * 1024 * 1024 {
            break Err("Provider acceptance exceeded output limit".to_owned());
        }
        match child.try_wait() {
            Ok(Some(status)) => break Ok(status.exit_code()),
            Err(error) => break Err(error.to_string()),
            _ => {}
        }
        if started.elapsed() > Duration::from_secs(90) {
            break Err("Provider acceptance timed out".to_owned());
        }
        thread::sleep(Duration::from_millis(20));
    };
    let _ = killer.kill();
    drop(writer);
    drop(pair.master);
    let drained = finished_rx.recv_timeout(Duration::from_secs(10)).is_ok();
    if drained {
        reader_thread.join().unwrap();
    }
    while let Ok(chunk) = observed_rx.try_recv() {
        output.push_str(&chunk);
    }
    let evidence = json!({
        "exitCode": outcome.as_ref().ok(), "error": outcome.as_ref().err(),
        "durationMs": started.elapsed().as_millis(), "drained": drained,
        "sshBinary": launch.path, "output": output,
    });
    std::fs::write(
        std::env::var("ACCEPTANCE_OUTPUT").unwrap(),
        serde_json::to_vec_pretty(&evidence).unwrap(),
    )
    .unwrap();
    assert!(drained, "Provider PTY output did not drain");
    assert_eq!(
        outcome.unwrap(),
        0,
        "Provider CLI failed; inspect bounded local evidence"
    );
}
