//! One default-distribution WSL route shared by discovery and PTY launch.
use std::process::Stdio;
use std::time::Duration;
use tokio::process::Command;

const PATH_SETUP: &str = "export PATH=\"$HOME/.local/bin:$PATH\"; ";
const RESOLVE: &str = "cli=$(command -v \"$1\") && [ -x \"$cli\" ] || { printf '%s\\n' 'CLI not found in the default WSL distribution. Install it inside WSL, then rescan CLI Clients in Settings.' >&2; exit 127; }; shift; ";
const PATH_MARKER: &str = "__CLI_WSL_PATH__=";

fn shell_args(cwd: &str, script: String, command: &str, args: &[String]) -> Vec<String> {
    let mut result = vec![
        "--cd".into(),
        cwd.into(),
        "--exec".into(),
        "/bin/sh".into(),
        "-lc".into(),
        script,
        "workspace-cli".into(),
        command.into(),
    ];
    result.extend_from_slice(args);
    result
}

fn validate_command(command: &str) -> Result<(), String> {
    let preset = super::cli_registry::wsl_preset(command)
        .ok_or_else(|| "This CLI has no registered WSL launch route".to_string())?;
    if command.contains(['\0', '\r', '\n'])
        || (command != preset.binary && !command.starts_with('/'))
    {
        return Err("WSL CLI overrides must be absolute Linux executable paths; clear the Windows path override to use automatic discovery".into());
    }
    Ok(())
}

pub fn launch_args(command: &str, args: &[String], cwd: &str) -> Result<Vec<String>, String> {
    validate_command(command)?;
    // Positional parameters preserve argument boundaries; neither the folder
    // nor user arguments are interpolated into shell source.
    Ok(shell_args(
        cwd,
        format!(
        "{PATH_SETUP}{RESOLVE}export TERM=xterm-256color COLORTERM=truecolor; exec \"$cli\" \"$@\""
    ),
        command,
        args,
    ))
}

pub fn probe_args(command: &str) -> Result<Vec<String>, String> {
    validate_command(command)?;
    let version = super::cli_registry::wsl_preset(command)
        .and_then(|preset| preset.version_argument.as_deref())
        .unwrap_or("--version");
    Ok(shell_args(
        "~",
        format!("{PATH_SETUP}{RESOLVE}printf '{PATH_MARKER}%s\\n' \"$cli\"; exec \"$cli\" \"$@\""),
        command,
        &[version.into()],
    ))
}

#[derive(Debug, Default)]
pub struct WslCliProbe {
    pub path: Option<String>,
    pub version: Option<String>,
}

fn parse_probe(success: bool, stdout: &[u8], stderr: &[u8]) -> WslCliProbe {
    if !success {
        return WslCliProbe::default();
    }
    let output = String::from_utf8_lossy(stdout);
    let mut lines = output.lines();
    let path = lines
        .find_map(|line| line.strip_prefix(PATH_MARKER))
        .map(str::trim)
        .filter(|path| path.starts_with('/'))
        .map(str::to_string);
    if path.is_none() {
        return WslCliProbe::default();
    }
    let error_output = String::from_utf8_lossy(stderr);
    let version = lines
        .chain(error_output.lines())
        .map(str::trim)
        .find(|line| !line.is_empty())
        .map(|line| line.chars().take(60).collect());
    WslCliProbe { path, version }
}

pub async fn probe(command: &str) -> WslCliProbe {
    let Ok(args) = probe_args(command) else {
        return WslCliProbe::default();
    };
    match run(&args).await {
        Some(output) => parse_probe(output.status.success(), &output.stdout, &output.stderr),
        None => WslCliProbe::default(),
    }
}

async fn run(args: &[String]) -> Option<std::process::Output> {
    let host =
        super::agent::resolve_cli_launch(&super::agent::CliLaunchSpec::from_command("wsl")).await;
    if !host.is_resolved() {
        return None;
    }
    let mut child = Command::new(&host.path);
    child
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    #[cfg(windows)]
    child.creation_flags(0x0800_0000);
    match tokio::time::timeout(Duration::from_secs(15), child.output()).await {
        Ok(Ok(output)) => Some(output),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wsl_route_preserves_windows_folders_and_literal_cli_arguments() {
        let cwd = r"D:\projects\folder with spaces & quotes";
        let extra = vec!["two words".into(), "$(touch nope); echo nope".into()];
        let args = launch_args("amp", &extra, cwd).unwrap();
        assert_eq!(&args[..5], ["--cd", cwd, "--exec", "/bin/sh", "-lc"]);
        assert!(!args[5].contains(cwd));
        assert!(!args[5].contains(&extra[1]));
        assert_eq!(&args[7..], ["amp", &extra[0], &extra[1]]);
        assert!(args[5].contains("exec \"$cli\" \"$@\""));
    }

    #[test]
    fn probe_uses_the_same_shell_and_discovery_as_launch_and_amp_version_command() {
        let args = probe_args("amp").unwrap();
        assert_eq!(&args[..5], ["--cd", "~", "--exec", "/bin/sh", "-lc"]);
        assert!(args[5].starts_with(&format!("{PATH_SETUP}{RESOLVE}")));
        assert_eq!(&args[7..], ["amp", "version"]);
        assert!(launch_args(r"C:\tools\amp.exe", &[], r"D:\repo").is_err());
        assert!(launch_args("/home/dev/.local/bin/amp", &[], r"D:\repo").is_ok());
    }

    #[test]
    fn probe_rejects_failed_wsl_and_ignores_login_chatter() {
        let output = b"login message\n__CLI_WSL_PATH__=/home/dev/.local/bin/amp\n1.2.3\n";
        let probe = parse_probe(true, output, b"");
        assert_eq!(probe.path.as_deref(), Some("/home/dev/.local/bin/amp"));
        assert_eq!(probe.version.as_deref(), Some("1.2.3"));
        assert!(parse_probe(false, output, b"failed").path.is_none());
        assert!(parse_probe(true, b"WSL is not installed", b"")
            .path
            .is_none());
    }

    #[cfg(windows)]
    #[tokio::test]
    #[ignore = "requires an installed default WSL distribution"]
    async fn live_wsl_route_preserves_cwd_arguments_and_detection() {
        let cache = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .unwrap()
            .join("node_modules/.cache");
        std::fs::create_dir_all(&cache).unwrap();
        let folder = tempfile::Builder::new()
            .prefix("amp wsl smoke ")
            .tempdir_in(cache)
            .unwrap();
        let windows_binary = folder.path().join("amp");
        std::fs::write(&windows_binary, b"#!/bin/sh\nif [ \"${1-}\" = version ]; then printf 'amp-wsl-smoke 1.0.0\\n'; exit 0; fi\nprintf '%s\\n' \"$PWD\" \"$TERM\" \"$COLORTERM\" \"$@\"\n").unwrap();
        let translated = run(&[
            "--cd".into(),
            "~".into(),
            "--exec".into(),
            "wslpath".into(),
            "-u".into(),
            windows_binary.to_string_lossy().into_owned(),
        ])
        .await
        .expect("WSL must run");
        assert!(
            translated.status.success(),
            "{}",
            String::from_utf8_lossy(&translated.stderr)
        );
        let linux_binary = String::from_utf8_lossy(&translated.stdout)
            .trim()
            .to_string();
        let chmod = run(&[
            "--cd".into(),
            "~".into(),
            "--exec".into(),
            "chmod".into(),
            "+x".into(),
            linux_binary.clone(),
        ])
        .await
        .unwrap();
        assert!(chmod.status.success());
        let detected = probe(&linux_binary).await;
        assert_eq!(detected.path.as_deref(), Some(linux_binary.as_str()));
        assert_eq!(detected.version.as_deref(), Some("amp-wsl-smoke 1.0.0"));
        let extra = vec![
            "two words".into(),
            "$(printf EXPANDED)".into(),
            "a\"b'c & d".into(),
        ];
        let args = launch_args(&linux_binary, &extra, &folder.path().to_string_lossy()).unwrap();
        let output = run(&args).await.unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        let output = String::from_utf8_lossy(&output.stdout);
        let lines: Vec<_> = output.lines().collect();
        assert_eq!(lines[0], linux_binary.rsplit_once('/').unwrap().0);
        assert_eq!(&lines[1..3], ["xterm-256color", "truecolor"]);
        assert_eq!(&lines[3..], extra);
        assert!(probe(&format!("{}/missing/amp", lines[0]))
            .await
            .path
            .is_none());
    }
}
