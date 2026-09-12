use super::shared::lock_mutex;
use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;
use tracing::{info, warn};

use portable_pty::{
    native_pty_system, Child as PtyChild, ChildKiller as PtyChildKiller, CommandBuilder, MasterPty,
    PtySize,
};
use serde::Serialize;
use tauri::{AppHandle, Emitter, State};
use tokio::process::Command as TokioCommand;
use tokio::time::timeout;
use uuid::Uuid;

use crate::core::brand::{CLAUDE_STATUSLINE_DIR_ENV, CLAUDE_STATUSLINE_HELPER_ENV};

#[cfg(test)]
#[path = "pty_live_ssh_tests.rs"]
mod live_ssh_tests;

fn pty_output_event(session_id: &str) -> String {
    format!("pty:output:{}", session_id)
}

fn pty_exit_event(session_id: &str) -> String {
    format!("pty:exit:{}", session_id)
}

/// Commands allowed to be spawned in a PTY session.
const ALLOWED_COMMANDS: &[&str] = &[
    "claude",
    "codex",
    "opencode",
    "packetcode",
    "bash",
    "sh",
    "zsh",
    "powershell",
    "pwsh",
    "cmd",
    "wsl",
    "fish",
    "nu",
    "xonsh",
    "ssh",
];

const ALLOWED_SHELL_COMMANDS: &[&str] = &[
    "bash",
    "sh",
    "zsh",
    "powershell",
    "pwsh",
    "cmd",
    "wsl",
    "fish",
    "nu",
    "xonsh",
];

/// Extract the program name from a command string for allowlist checks.
/// Strips any directory components and a trailing executable extension so a
/// manually-pinned absolute path (e.g. `D:\tools\packetcode.exe`) validates
/// against the bare-name allowlist by its program name (`packetcode`).
/// Lowercased for case-insensitive comparison on Windows.
fn command_program_name(command: &str) -> String {
    let stem = std::path::Path::new(command)
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or(command);
    stem.to_ascii_lowercase()
}

/// Read the app pin for `command` under `home` — a `<DATA_DIR>/<command>-bin`
/// file whose contents are the absolute path of the binary to launch instead
/// of whatever PATH resolution would find.
///
/// FAULT this exists to fix: the pin used to be read inside the `cfg(not(windows))`
/// resolver only, so on Windows — the primary platform — the documented escape
/// hatch did nothing at all and gave no hint that it had been ignored. The read
/// is platform-neutral now and both resolvers consult it after any explicit
/// Settings-selected path.
///
/// Takes `home` explicitly so the behaviour is testable without touching the
/// developer's real home directory.
#[cfg(test)]
fn pinned_cli_binary_in(home: &std::path::Path, command: &str) -> Option<String> {
    crate::core::agent::app_pinned_cli_binary_in(home, command)
}

/// Resolve the exact binary a PTY pane will spawn, and the tier that chose it.
///
/// This delegates to [`crate::core::agent::resolve_cli_launch_sync`] — the SAME
/// tier order every reporting surface calls (`detect_cli_catalog`,
/// `inspect_cli_launch`, `inspect_packetcode_installation`). There used to be
/// two implementations of the ladder, one here and one in `core::agent`, and
/// two implementations of the same order drift: a readout that disagrees with
/// what actually spawns is worse than no readout at all.
///
/// FAULT the shared install-directory tier exists to fix: the install
/// directory was searched by the surface that decides whether an agent is
/// PRESENT (which sets the catalog's `installed` flag) but NOT by the PTY
/// resolver that launches the pane. A packetcode installed exactly where its
/// own installer puts it was reported as installed, offered in the Workspace
/// agent list, and then died the instant a pane opened, because `where
/// packetcode` finds nothing and the spawn fell through to the bare name.
///
/// The ONE thing that stays here is Git Bash. `bash` is a terminal shell, not
/// a CLI agent, and `where bash` can resolve the legacy WSL launcher in
/// System32, so Git for Windows' documented install directories are consulted
/// AHEAD of `PATH` for it. That precedence is long-standing and deliberately
/// unchanged — folding it into the agent tier order (where install directories
/// come last) would change which `bash` launches.
fn resolve_pty_launch(command: &str) -> crate::core::agent::ResolvedCliLaunch {
    let spec = crate::core::agent::CliLaunchSpec::from_command(command);

    #[cfg(windows)]
    if command_program_name(command) == "bash" {
        use crate::core::agent::{CliLaunchSource, ResolvedCliLaunch};

        // Settings and the app pin still outrank Git for Windows.
        let before_path = crate::core::agent::resolve_cli_launch_with(&spec, |_| None);
        if matches!(
            before_path.source,
            CliLaunchSource::Settings | CliLaunchSource::LegacyPin
        ) {
            return before_path;
        }
        if let Some(git_bash) = crate::core::agent::git_bash_fallback_candidates()
            .into_iter()
            .find(|candidate| candidate.is_file())
        {
            return ResolvedCliLaunch {
                path: git_bash.to_string_lossy().into_owned(),
                source: CliLaunchSource::InstallerLocation,
                rejected_settings_path: before_path.rejected_settings_path,
            };
        }
    }

    crate::core::agent::resolve_cli_launch_sync(&spec)
}

/// A neutral, empty working directory for panes opened without a project.
/// Lives in the app data dir so an agent's cwd scan finds nothing sensitive
/// (avoids macOS TCC prompts for ~/Music, ~/Pictures, … that scanning $HOME
/// triggers). Created on demand.
fn neutral_scratch_cwd() -> Option<String> {
    let dir = dirs::home_dir()?
        .join(crate::core::brand::DATA_DIR_NAME)
        .join("scratch");
    std::fs::create_dir_all(&dir).ok()?;
    Some(dir.to_string_lossy().into_owned())
}

/// Info about a running PTY session
#[derive(Clone, Serialize)]
pub struct PtySessionInfo {
    pub id: String,
    pub project_path: String,
    pub pid: Option<u32>,
    pub alive: bool,
}

#[derive(Clone, Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct TerminalShellProbe {
    pub available: bool,
    pub executable: String,
    pub version: Option<String>,
    pub working_directory: String,
    pub platform: String,
}

fn decode_console_output(bytes: &[u8]) -> String {
    let looks_utf16 = bytes.starts_with(&[0xff, 0xfe])
        || bytes
            .chunks_exact(2)
            .take(16)
            .any(|pair| pair.get(1) == Some(&0));
    if looks_utf16 {
        let start = if bytes.starts_with(&[0xff, 0xfe]) {
            2
        } else {
            0
        };
        let words: Vec<u16> = bytes[start..]
            .chunks_exact(2)
            .map(|pair| u16::from_le_bytes([pair[0], pair[1]]))
            .collect();
        String::from_utf16_lossy(&words)
    } else {
        String::from_utf8_lossy(bytes).into_owned()
    }
}

fn first_probe_line(stdout: &[u8], stderr: &[u8]) -> Option<String> {
    [stdout, stderr].into_iter().find_map(|bytes| {
        decode_console_output(bytes)
            .lines()
            .map(|line| line.trim().trim_matches('\0'))
            .find(|line| !line.is_empty())
            .map(|line| line.chars().take(120).collect())
    })
}

async fn probe_shell_version(path: &str, program: &str) -> Option<String> {
    let mut command = if cfg!(windows) && path.to_ascii_lowercase().ends_with(".cmd") {
        let mut command = TokioCommand::new("cmd.exe");
        command.arg("/c").arg(path);
        command
    } else {
        TokioCommand::new(path)
    };

    match program {
        "cmd" => {
            command.args(["/c", "ver"]);
        }
        "powershell" | "pwsh" => {
            command.args([
                "-NoLogo",
                "-NoProfile",
                "-Command",
                "$PSVersionTable.PSVersion.ToString()",
            ]);
        }
        "wsl" => {
            command.arg("--version");
        }
        _ => {
            command.arg("--version");
        }
    }
    command.stdin(std::process::Stdio::null());
    command.stdout(std::process::Stdio::piped());
    command.stderr(std::process::Stdio::piped());
    command.kill_on_drop(true);
    #[cfg(target_os = "windows")]
    {
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    let child = command.spawn().ok()?;
    match timeout(Duration::from_secs(4), child.wait_with_output()).await {
        Ok(Ok(output)) => first_probe_line(&output.stdout, &output.stderr),
        _ => None,
    }
}

#[tauri::command]
pub async fn probe_terminal_shell(
    command: String,
    project_path: String,
) -> Result<TerminalShellProbe, String> {
    let program = command_program_name(&command);
    if !ALLOWED_SHELL_COMMANDS
        .iter()
        .any(|candidate| *candidate == program)
    {
        return Err(format!(
            "'{}' is not a supported terminal shell. Supported shells: {:?}",
            command, ALLOWED_SHELL_COMMANDS
        ));
    }

    let explicit = std::path::Path::new(&command);
    let executable = if explicit.is_absolute() || command.contains('/') || command.contains('\\') {
        if !crate::core::agent::is_executable_file(&command) {
            return Err(format!("Shell executable was not found: {}", command));
        }
        command.clone()
    } else {
        let catalog_id = if cfg!(windows) && program == "bash" {
            "git-bash"
        } else {
            "terminal-shell"
        };
        crate::core::agent::resolve_catalog_path(catalog_id, &command)
            .await
            .ok_or_else(|| format!("Shell '{}' was not found on PATH", command))?
    };

    let working_directory = if std::path::Path::new(project_path.trim()).is_dir() {
        project_path
    } else {
        neutral_scratch_cwd().unwrap_or_default()
    };
    let version = probe_shell_version(&executable, &program).await;

    Ok(TerminalShellProbe {
        available: true,
        executable,
        version,
        working_directory,
        platform: std::env::consts::OS.to_string(),
    })
}

#[tauri::command]
pub async fn list_wsl_distributions() -> Result<Vec<String>, String> {
    #[cfg(not(target_os = "windows"))]
    {
        Ok(Vec::new())
    }
    #[cfg(target_os = "windows")]
    {
        let mut command = TokioCommand::new("wsl.exe");
        command.args(["--list", "--quiet"]);
        command.stdin(std::process::Stdio::null());
        command.stdout(std::process::Stdio::piped());
        command.stderr(std::process::Stdio::piped());
        command.kill_on_drop(true);
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
        let child = command
            .spawn()
            .map_err(|error| format!("Unable to start WSL detection: {}", error))?;
        let output = timeout(Duration::from_secs(5), child.wait_with_output())
            .await
            .map_err(|_| "WSL distribution detection timed out".to_string())?
            .map_err(|error| format!("WSL distribution detection failed: {}", error))?;
        if !output.status.success() {
            return Ok(Vec::new());
        }
        let mut distributions = Vec::new();
        for line in decode_console_output(&output.stdout).lines() {
            let distro = line
                .trim()
                .trim_start_matches('*')
                .trim()
                .trim_matches('\0');
            if !distro.is_empty() && !distributions.iter().any(|existing| existing == distro) {
                distributions.push(distro.to_string());
            }
        }
        Ok(distributions)
    }
}

/// Payload for scoped PTY output. The monotonically increasing sequence lets
/// the frontend join a transcript snapshot with live events without guessing
/// based on repeated terminal text.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PtyOutputPayload {
    pub data: String,
    pub sequence: u64,
}

/// Payload for the scoped `pty:exit:{session_id}` event.
///
/// Historically this event carried only the session id string. It now
/// carries the captured child exit code and a `terminated` flag so the
/// frontend can score orchestrated task completion against the REAL
/// outcome (non-zero exit → failure) and distinguish a backend-initiated
/// kill (flight pause/cancel) from a natural exit.
///
/// Backward compatibility: listeners that ignore the payload (or only used
/// the old bare-string session id) keep working — the new fields are
/// additive and optional on the TS side.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PtyExitPayload {
    /// Session id — same value the event was historically keyed by.
    pub session_id: String,
    /// Child process exit code, when it could be captured. `None` when the
    /// child status couldn't be read (e.g. it was force-killed and reaped
    /// elsewhere). `0` means success; non-zero means the agent failed.
    ///
    /// Widened from `i32` to `i64` so a Windows NTSTATUS exit (`0xC0000005`
    /// access violation, `0xC0000135` missing DLL — the common "this CLI
    /// binary is broken" cases) reaches the UI as the unsigned value the OS
    /// actually reported instead of a sign-wrapped negative number nobody can
    /// look up.
    pub exit_code: Option<i64>,
    /// Whether the session was terminated by PacketBench rather than exiting
    /// on its own — i.e. `kill_pty` ran (Kill, Restart, pane close, or any
    /// programmatic stop). A deliberate control action, so the frontend must
    /// render it distinctly from a crash AND must not score it as a
    /// successful task completion.
    pub terminated: bool,
}

fn is_terminal_pty_read_error(error: &std::io::Error) -> bool {
    let err_str = error.to_string();
    err_str.contains("broken pipe")
        || err_str.contains("The pipe has been ended")
        || error.kind() == std::io::ErrorKind::BrokenPipe
        // Unix PTYs commonly report EIO once the slave side closes.
        || error.raw_os_error() == Some(5)
}

/// Shared handle to the spawned child so the reader thread can capture the
/// exit code after the read loop ends, while the manager can still kill it.
type SharedChild = Arc<Mutex<Box<dyn PtyChild + Send>>>;
type SharedChildKiller = Arc<Mutex<Box<dyn PtyChildKiller + Send + Sync>>>;

/// Internal state for one PTY session
struct PtySession {
    info: PtySessionInfo,
    child: SharedChild,
    killer: SharedChildKiller,
    writer: Box<dyn Write + Send>,
    master: Box<dyn MasterPty + Send>,
    kill_flag: Arc<std::sync::atomic::AtomicBool>,
}

/// Manages all PTY sessions
pub struct PtyManager {
    sessions: HashMap<String, PtySession>,
}

impl PtyManager {
    pub fn new() -> Self {
        Self {
            sessions: HashMap::new(),
        }
    }
}

/// Process groups to signal when tearing down a PTY session.
///
/// The spawned child is `setsid`'d into its own session, so its pid IS its
/// group id; the terminal's foreground group is collected too in case job
/// control moved the running command into a distinct one. `0` would broadcast
/// to our own group and `1` is init, so both are dropped.
///
/// Kept pure and pid-typed (rather than `libc::pid_t`) so the selection rules
/// stay testable on a Windows host.
#[cfg_attr(not(unix), allow(dead_code))]
fn pty_kill_group_ids(child_pid: Option<u32>, foreground_leader: Option<i32>) -> Vec<i32> {
    let mut groups: Vec<i32> = Vec::new();
    for candidate in [child_pid.map(|pid| pid as i32), foreground_leader]
        .into_iter()
        .flatten()
    {
        if candidate > 1 && !groups.contains(&candidate) {
            groups.push(candidate);
        }
    }
    groups
}

/// `taskkill` arguments that reap a PTY child and everything below it.
#[cfg_attr(not(windows), allow(dead_code))]
fn taskkill_tree_args(pid: u32) -> [String; 4] {
    [
        "/T".to_string(),
        "/F".to_string(),
        "/PID".to_string(),
        pid.to_string(),
    ]
}

/// Terminate a PTY session's ENTIRE process tree.
///
/// `portable-pty`'s own killer is not enough. On Unix it sends a bare `SIGHUP`
/// to the direct child, and every PTY child is a `setsid` session leader, so
/// descendants never receive it. On Windows a `.cmd`-wrapped CLI is spawned as
/// `cmd.exe /c codex.cmd`, and `TerminateProcess` on that handle kills only
/// `cmd.exe`. Either way the real agent survives pane close — untracked, since
/// the session entry is dropped — and holds the pty slave open, which leaves
/// this session's reader thread blocked on `read()` forever.
///
/// Mirrors the group signalling in `core::pty` and the Windows tree kill in
/// `commands::agent_sidecar::supervisor::kill_process_tree`.
fn kill_pty_process_tree(session_id: &str, session: &mut PtySession) {
    session
        .kill_flag
        .store(true, std::sync::atomic::Ordering::Relaxed);

    // Whether a whole-tree signal actually went out. When it did, the
    // direct-handle kill below is expected to fail against an already-reaped
    // child and must not be reported as a problem.
    #[cfg(unix)]
    let tree_signalled = {
        let groups = pty_kill_group_ids(
            session.info.pid,
            session.master.process_group_leader().map(|pid| pid as i32),
        );
        let signalled = !groups.is_empty();
        for gid in groups {
            // Negative pid = whole group. SIGTERM for a chance to unwind, then
            // SIGKILL to guarantee the reap.
            let group = -(gid as libc::pid_t);
            unsafe {
                libc::kill(group, libc::SIGTERM);
                libc::kill(group, libc::SIGKILL);
            }
        }
        signalled
    };

    #[cfg(windows)]
    let tree_signalled = match session.info.pid {
        Some(pid) => {
            use std::os::windows::process::CommandExt;
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            match std::process::Command::new("taskkill")
                .args(taskkill_tree_args(pid))
                .creation_flags(CREATE_NO_WINDOW)
                .status()
            {
                Ok(status) => status.success(),
                Err(e) => {
                    warn!(session_id = %session_id, error = %e, "taskkill failed for PTY process tree");
                    false
                }
            }
        }
        None => false,
    };

    #[cfg(not(any(unix, windows)))]
    let tree_signalled = false;

    // Backstop via portable-pty: the only path when no pid was reported, and a
    // harmless no-op once the tree kill has done the work.
    match session.killer.lock() {
        Ok(mut killer) => {
            if let Err(e) = killer.kill() {
                if tree_signalled {
                    tracing::debug!(session_id = %session_id, error = %e, "PTY child already reaped by tree kill");
                } else {
                    warn!(session_id = %session_id, error = %e, "Failed to kill PTY child process");
                }
            }
        }
        Err(_) => {
            warn!(session_id = %session_id, "PTY child killer mutex poisoned")
        }
    }
}

/// Tear down every live PTY session's process tree.
///
/// Called on app exit: without it, quitting PacketBench leaves every running
/// `claude` / `codex` agent alive and unreachable — nothing in the app can find
/// them again once the process is gone.
pub fn shutdown_pty_sessions(manager: &SharedPtyManager) {
    // A poisoned manager mutex must not block shutdown; the sessions still
    // need reaping.
    let mut sessions: Vec<(String, PtySession)> = match manager.lock() {
        Ok(mut mgr) => mgr.sessions.drain().collect(),
        Err(poisoned) => poisoned.into_inner().sessions.drain().collect(),
    };

    if sessions.is_empty() {
        return;
    }

    info!(
        count = sessions.len(),
        "Terminating PTY sessions on app exit"
    );
    for (session_id, session) in sessions.iter_mut() {
        session.info.alive = false;
        kill_pty_process_tree(session_id, session);
    }
}

fn wait_for_pty_child_exit(
    session_id: &str,
    child: &SharedChild,
    timeout: std::time::Duration,
) -> bool {
    let start = std::time::Instant::now();
    loop {
        // The reader thread owns the blocking `wait()` used to capture the
        // exit code for `PtyExitPayload`. Avoid blocking behind that same
        // mutex here; otherwise kill_pty_and_wait can hang instead of timing
        // out when the reader is already waiting.
        match child.try_lock() {
            Ok(mut child) => match child.try_wait() {
                Ok(Some(_)) | Err(_) => return true,
                Ok(None) if start.elapsed() < timeout => {
                    std::thread::sleep(std::time::Duration::from_millis(25));
                }
                Ok(None) => {
                    warn!(session_id = %session_id, ?timeout, "PTY kill timed out");
                    return false;
                }
            },
            Err(std::sync::TryLockError::WouldBlock) if start.elapsed() < timeout => {
                std::thread::sleep(std::time::Duration::from_millis(25));
            }
            Err(std::sync::TryLockError::WouldBlock) => {
                warn!(session_id = %session_id, ?timeout, "PTY kill timed out waiting for child handle");
                return false;
            }
            Err(std::sync::TryLockError::Poisoned(_)) => return true,
        }
    }
}

pub type SharedPtyManager = Arc<Mutex<PtyManager>>;

pub fn create_shared_pty_manager() -> SharedPtyManager {
    Arc::new(Mutex::new(PtyManager::new()))
}

#[tauri::command]
pub fn create_pty_session(
    app: AppHandle,
    manager: State<'_, SharedPtyManager>,
    project_path: String,
    cols: u16,
    rows: u16,
    command: String,
    args: Option<Vec<String>>,
    env: Option<std::collections::HashMap<String, String>>,
) -> Result<String, String> {
    // Validate command against allowlist. Match on the program name so a
    // manually-pinned absolute path for a known agent (e.g.
    // `D:\projects\packetcode\bin\packetcode.exe`) is accepted by its
    // basename while still rejecting arbitrary programs.
    let program = command_program_name(&command);
    if !ALLOWED_COMMANDS.iter().any(|&c| c == program) {
        return Err(format!(
            "Command '{}' is not allowed. Allowed commands: {:?}",
            command, ALLOWED_COMMANDS
        ));
    }

    // Validate project_path is a real directory (skip for SSH — remote path is not local)
    let project_path = if command == "ssh" {
        dirs::home_dir()
            .map(|p| p.to_string_lossy().to_string())
            .unwrap_or_else(|| {
                // No home dir resolvable — falling back to the caller-supplied path keeps SSH alive
                // but signals an environment issue worth investigating.
                warn!(fallback = %project_path, "dirs::home_dir() returned None for SSH session; using caller path");
                project_path.clone()
            })
    } else {
        let trimmed = project_path.trim();
        // Never launch an interactive CLI at the filesystem root (or with no
        // path at all). An agent spawned at "/" can wander the entire disk and
        // is exactly what triggers broad macOS file-access prompts. Fall back to
        // the user's home directory — the conventional default working dir
        // (what Terminal.app uses) — instead of "/".
        if trimmed.is_empty() || trimmed == "/" {
            // No project selected. Do NOT fall back to "/" (whole-disk wander)
            // OR the home directory: an agent like claude scans its cwd for
            // context, and scanning $HOME walks into ~/Music, ~/Pictures,
            // ~/Documents, … which triggers macOS TCC permission prompts
            // attributed to the app. Use a dedicated empty scratch dir instead —
            // nothing sensitive to scan, no prompts.
            neutral_scratch_cwd().unwrap_or_else(|| {
                warn!(
                    requested = %project_path,
                    "no project path and scratch dir unavailable; falling back to caller path"
                );
                project_path.clone()
            })
        } else {
            let project_dir = std::path::Path::new(trimmed);
            if !project_dir.is_dir() {
                return Err(format!(
                    "Project path '{}' is not a valid directory",
                    project_path
                ));
            }
            project_path
        }
    };

    info!(command = %command, project_path = %project_path, "Creating PTY session");

    let session_id = Uuid::new_v4().to_string();

    let pty_system = native_pty_system();

    let pair = pty_system
        .openpty(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| format!("Failed to open PTY: {}", e))?;

    // Build the command: launch the specified CLI interactively.
    // On Windows, CLIs may be installed as .exe (e.g. claude.exe) or .cmd
    // wrappers (e.g. codex.cmd). Resolution filters GUI app aliases before
    // choosing the matching spawn strategy.
    // `spawned_program` is the program this PTY's direct child actually runs,
    // which is not always the resolved CLI: a `.cmd` wrapper runs under
    // `cmd.exe`. The orphan registry matches on it, so it must name the real
    // child image.
    let launch = resolve_pty_launch(&command);
    info!(
        command = %command,
        resolved = %launch.path,
        source = launch.source.as_str(),
        rejected_settings_path = ?launch.rejected_settings_path,
        "Resolved PTY launch binary"
    );
    let resolved = launch.path;

    #[cfg(windows)]
    let (mut cmd, spawned_program) = {
        if resolved.to_ascii_lowercase().ends_with(".cmd") {
            // .cmd batch scripts must go through cmd.exe /c
            let mut c = CommandBuilder::new("cmd.exe");
            c.arg("/c");
            c.arg(&resolved);
            (c, "cmd.exe".to_string())
        } else {
            // Native .exe — spawn directly
            (CommandBuilder::new(&resolved), resolved)
        }
    };
    #[cfg(not(windows))]
    let (mut cmd, spawned_program) = (CommandBuilder::new(&resolved), resolved);
    cmd.cwd(&project_path);

    // Append any extra arguments (e.g. --model)
    if let Some(extra_args) = &args {
        for arg in extra_args {
            cmd.arg(arg);
        }
    }

    // Clear env vars that make Claude think it's inside another session
    if program == "claude" {
        // PacketBench owns the native Claude status bar. Inject a session-local
        // collector through Claude's supported `--settings` seam instead of
        // requiring users to install a script or edit ~/.claude/settings.json.
        // User settings remain loaded; this additional object overrides only
        // statusLine for the PacketBench-launched process.
        cmd.arg("--settings");
        cmd.arg(crate::core::claude_statusline::settings_json());
        cmd.env_remove("CLAUDECODE");
        cmd.env_remove("CLAUDE_CODE_ENTRYPOINT");
        // The app manages claude's lifecycle; an auto-update mid-session can swap
        // in a build that's incompatible with our PTY (claude 2.1.185 panics on
        // its first PTY write). Stop the launched binary from self-updating so a
        // pinned-good version (see `resolve_pinned_cli_binary`) stays put.
        cmd.env("DISABLE_AUTOUPDATER", "1");
        // Tell statusline.ps1 to suppress terminal output (PacketBench has its own native status bar).
        // PACKETCODE env var retained for backwards compatibility with any existing scripts.
        cmd.env("PACKETBENCH", "1");
        cmd.env("PACKETCODE", "1");
    }

    // PTY is a real terminal — advertise a common modern terminal profile so CLIs
    // enable their interactive UI and 24-bit color output.
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");

    // Apply any extra environment variables from the frontend
    if let Some(extra_env) = &env {
        for (key, value) in extra_env {
            cmd.env(key, value);
        }
    }

    if program == "claude" {
        let helper = std::env::current_exe()
            .map_err(|error| format!("Could not resolve the Claude status-line helper: {error}"))?;
        let state_dir = crate::core::claude_statusline::default_state_dir().ok_or_else(|| {
            "Could not resolve the Claude status-line state directory".to_string()
        })?;
        // Apply internal values after pane-supplied env so they cannot be
        // redirected by persisted Workspace state.
        cmd.env(CLAUDE_STATUSLINE_HELPER_ENV, helper);
        cmd.env(CLAUDE_STATUSLINE_DIR_ENV, state_dir);
    }

    // Spawn the child process in the PTY
    let child = pair.slave.spawn_command(cmd).map_err(|e| {
        format!(
            "Failed to spawn {} in PTY: {}. Is {} installed?",
            command, e, command
        )
    })?;

    let killer: SharedChildKiller = Arc::new(Mutex::new(child.clone_killer()));
    let pid = child.process_id();
    // Record the pid so a crash / force-quit that never reaches the exit
    // handler gets swept on the next launch (`reap_orphaned_pty_children`).
    if let Some(pid) = pid {
        crate::core::pty::record_spawned_pid(pid, &spawned_program);
    }
    let child: SharedChild = Arc::new(Mutex::new(child));

    let writer = pair
        .master
        .take_writer()
        .map_err(|e| format!("Failed to take PTY writer: {}", e))?;

    let mut reader = pair
        .master
        .try_clone_reader()
        .map_err(|e| format!("Failed to clone PTY reader: {}", e))?;

    let kill_flag = Arc::new(std::sync::atomic::AtomicBool::new(false));

    let info = PtySessionInfo {
        id: session_id.clone(),
        project_path: project_path.clone(),
        pid,
        alive: true,
    };

    let session = PtySession {
        info: info.clone(),
        child: child.clone(),
        killer,
        writer,
        master: pair.master,
        kill_flag: kill_flag.clone(),
    };

    {
        let mut mgr = lock_mutex(&manager)?;
        mgr.sessions.insert(session_id.clone(), session);
    }

    // Spawn a thread to read PTY output and emit events
    let sid = session_id.clone();
    let app_handle = app.clone();
    let mgr_ref = manager.inner().clone();
    let exit_child = child.clone();

    thread::spawn(move || {
        let (output_tx, output_rx) = crate::core::pty_output::output_channel();
        let output_sid = sid.clone();
        let output_app = app_handle.clone();
        let output_dispatcher = thread::spawn(move || {
            crate::core::pty_output::dispatch_output(output_rx, |data| {
                // Append exactly the batch we emit. A snapshot sequence must
                // never cover part of an event that a mounting pane will skip.
                let sequence = crate::core::pty::append_transcript(&output_sid, &data);
                let payload = PtyOutputPayload { data, sequence };
                if let Err(e) = output_app.emit(&pty_output_event(&output_sid), &payload) {
                    warn!(session_id = %output_sid, error = %e, "Failed to emit scoped pty output");
                }
            });
        });
        let mut buf = [0u8; 8192];
        // Carry-over bytes from incomplete UTF-8 sequences at read boundaries
        let mut pending: Vec<u8> = Vec::new();
        loop {
            if kill_flag.load(std::sync::atomic::Ordering::Relaxed) {
                break;
            }

            match reader.read(&mut buf) {
                Ok(0) => break, // EOF — process exited
                Ok(n) => {
                    let data = crate::core::pty::decode_terminal_chunk(&buf[..n], &mut pending);
                    if !data.is_empty() && output_tx.send(data).is_err() {
                        warn!(session_id = %sid, "PTY output dispatcher stopped unexpectedly");
                        break;
                    }
                }
                Err(e) => {
                    if is_terminal_pty_read_error(&e) {
                        break;
                    }
                    // Transient errors — retry
                    thread::sleep(std::time::Duration::from_millis(10));
                }
            }
        }

        // A truncated final UTF-8 sequence still represents output; expose it
        // as replacement text rather than silently dropping the final bytes.
        if !pending.is_empty() {
            let _ = output_tx.send(String::from_utf8_lossy(&pending).into_owned());
        }
        drop(output_tx);
        // The final output event and its transcript record must precede exit.
        if output_dispatcher.join().is_err() {
            warn!(session_id = %sid, "PTY output dispatcher panicked");
        }

        // Remove session so stale entries cannot accumulate.
        if let Ok(mut mgr) = mgr_ref.lock() {
            mgr.sessions.remove(&sid);
        }

        // Capture the child exit code now that the read loop has ended. The
        // child may already have been reaped by an explicit `kill()`, in
        // which case `wait()` errors and we report `None`.
        let exit_code = match exit_child.lock() {
            Ok(mut child) => match child.wait() {
                Ok(status) => Some(status.exit_code() as i64),
                Err(e) => {
                    warn!(session_id = %sid, error = %e, "Failed to read PTY child exit status");
                    None
                }
            },
            Err(_) => None,
        };
        // `kill_flag` is set by `kill_pty_process_tree` BEFORE any signal goes
        // out, so reading it here tells us whether this exit was a deliberate
        // stop (Kill, Restart, pane close) or the child dying on its own.
        // Reporting it honestly is what lets the frontend distinguish "the
        // user closed this" from "the CLI crashed" — previously this was
        // hardcoded `false` and every kill looked like a natural exit whose
        // code (1 on Windows, 137 on Unix) then read as a crash.
        let terminated = kill_flag.load(std::sync::atomic::Ordering::Relaxed);

        info!(session_id = %sid, exit_code = ?exit_code, terminated, "PTY session exited");
        let payload = PtyExitPayload {
            session_id: sid.clone(),
            exit_code,
            terminated,
        };
        if let Err(e) = app_handle.emit(&pty_exit_event(&sid), &payload) {
            warn!(session_id = %sid, error = %e, "Failed to emit scoped pty exit");
        }
    });

    Ok(session_id)
}

#[tauri::command]
pub fn write_pty(
    manager: State<'_, SharedPtyManager>,
    session_id: String,
    data: String,
) -> Result<(), String> {
    super::validate_input_size(&data, super::MAX_PTY_WRITE_SIZE, "PTY write data")?;
    let mut mgr = lock_mutex(&manager)?;
    let session = mgr
        .sessions
        .get_mut(&session_id)
        .ok_or_else(|| format!("PTY session {} not found", session_id))?;

    session
        .writer
        .write_all(data.as_bytes())
        .map_err(|e| format!("Failed to write to PTY: {}", e))?;
    session
        .writer
        .flush()
        .map_err(|e| format!("Failed to flush PTY: {}", e))?;

    Ok(())
}

#[tauri::command]
pub fn resize_pty(
    manager: State<'_, SharedPtyManager>,
    session_id: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    let mgr = lock_mutex(&manager)?;
    let session = mgr
        .sessions
        .get(&session_id)
        .ok_or_else(|| format!("PTY session {} not found", session_id))?;

    session
        .master
        .resize(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| format!("Failed to resize PTY: {}", e))?;

    Ok(())
}

#[tauri::command]
pub fn kill_pty(manager: State<'_, SharedPtyManager>, session_id: String) -> Result<(), String> {
    kill_pty_session(&manager, &session_id)
}

fn kill_pty_session(manager: &SharedPtyManager, session_id: &str) -> Result<(), String> {
    let mut mgr = lock_mutex(manager)?;
    if let Some(mut session) = mgr.sessions.remove(session_id) {
        info!(session_id = %session_id, "Killing PTY session");
        session.info.alive = false;
        kill_pty_process_tree(session_id, &mut session);
    } else {
        // Not an error: the reader thread removes the entry itself when the
        // agent exits on its own, so closing a pane whose CLI already quit —
        // the common case — lands here. `kill_pty_and_wait` has always treated
        // this as a non-failure too.
        info!(session_id = %session_id, "PTY session already gone; nothing to kill");
    }

    Ok(())
}

#[tauri::command]
pub fn list_pty_sessions(
    manager: State<'_, SharedPtyManager>,
) -> Result<Vec<PtySessionInfo>, String> {
    let mgr = lock_mutex(&manager)?;
    Ok(mgr.sessions.values().map(|s| s.info.clone()).collect())
}

#[tauri::command]
pub fn kill_pty_and_wait(
    manager: State<'_, SharedPtyManager>,
    session_id: String,
    timeout_ms: Option<u64>,
) -> Result<bool, String> {
    const DEFAULT_TIMEOUT_MS: u64 = 200;
    const MAX_TIMEOUT_MS: u64 = 30_000;

    let timeout = std::time::Duration::from_millis(
        timeout_ms.unwrap_or(DEFAULT_TIMEOUT_MS).min(MAX_TIMEOUT_MS),
    );
    kill_pty_session_and_wait(&manager, &session_id, timeout)
}

fn kill_pty_session_and_wait(
    manager: &SharedPtyManager,
    session_id: &str,
    timeout: std::time::Duration,
) -> Result<bool, String> {
    let mut mgr = lock_mutex(manager)?;
    info!(session_id = %session_id, "Killing PTY session and waiting for exit");
    if let Some(mut session) = mgr.sessions.remove(session_id) {
        session.info.alive = false;
        kill_pty_process_tree(session_id, &mut session);
        let child = session.child.clone();
        drop(mgr);

        Ok(wait_for_pty_child_exit(session_id, &child, timeout))
    } else {
        Ok(false)
    }
}

#[tauri::command]
pub fn read_pty_transcript(session_id: String) -> Result<crate::core::pty::PtyTranscript, String> {
    crate::core::pty::read_transcript(&session_id)
}

/// OpenSSH options that make `ssh` execute a LOCAL program or read a local
/// file of the caller's choosing. The webview builds `ssh_exec` argv itself
/// (`src/lib/ssh.ts::buildSshExecArgs`) and never uses these, so refusing them
/// costs nothing and stops a compromised or confused webview from turning a
/// remote-probe command into local code execution (`-o ProxyCommand=…`).
const SSH_EXEC_DENIED_OPTIONS: &[&str] = &[
    "proxycommand",
    "localcommand",
    "permitlocalcommand",
    "knownhostscommand",
    "proxyusefdpass",
    "include",
];

/// Reject argv for `ssh_exec` that names a denied option (any `-o Name=…`,
/// `-oName=…`, or a bare `Name=…` after `-o`), a custom config file (`-F`,
/// which can carry every denied option), or a log-file sink (`-E`).
pub(crate) fn validate_ssh_exec_args(args: &[String]) -> Result<(), String> {
    let denied_option = |value: &str| {
        let name = value.split('=').next().unwrap_or("").trim().to_ascii_lowercase();
        SSH_EXEC_DENIED_OPTIONS.contains(&name.as_str())
    };
    let mut expect_option_value = false;
    for arg in args {
        if expect_option_value {
            expect_option_value = false;
            if denied_option(arg) {
                return Err(format!("ssh option '{}' is not permitted", arg));
            }
            continue;
        }
        if arg == "-o" {
            expect_option_value = true;
            continue;
        }
        if let Some(inline) = arg.strip_prefix("-o") {
            if denied_option(inline) {
                return Err(format!("ssh option '{}' is not permitted", arg));
            }
            continue;
        }
        if arg == "-F" || arg.starts_with("-F") || arg == "-E" || arg.starts_with("-E") {
            return Err(format!("ssh flag '{}' is not permitted", arg));
        }
    }
    Ok(())
}

/// Run an SSH command as a regular process (not PTY). Windows OpenSSH receives
/// an optional password over stdin; Unix OpenSSH uses the self-reinvoked
/// askpass helper because it never reads a login password from stdin.
#[tauri::command]
pub async fn ssh_exec(
    command_args: Vec<String>,
    password: Option<String>,
) -> Result<String, String> {
    use std::process::Stdio;
    use tokio::io::AsyncWriteExt;

    validate_ssh_exec_args(&command_args)?;
    info!(
        target: "packetbench::egress",
        service = "ssh",
        argc = command_args.len(),
        target = %command_args
            .iter()
            .find(|a| a.contains('@') && !a.starts_with('-'))
            .map(String::as_str)
            .unwrap_or("-"),
        "ssh_exec"
    );

    let mut cmd = tokio::process::Command::new("ssh");
    for arg in &command_args {
        cmd.arg(arg);
    }

    cmd.stdin(Stdio::piped());
    cmd.stdout(Stdio::piped());
    cmd.stderr(Stdio::piped());

    #[cfg(unix)]
    let _askpass_guard = password
        .as_deref()
        .map(|pw| crate::core::ssh_askpass::arm(&mut cmd, pw))
        .transpose()?;

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("Failed to spawn ssh: {}", e))?;

    // OpenSSH-for-Windows accepts the password on stdin. Unix must only close
    // this pipe: writing the password can leak it to a multiplexed remote
    // command when no authentication exchange occurs.
    #[cfg(windows)]
    {
        if let Some(pw) = password.as_ref() {
            if let Some(mut stdin) = child.stdin.take() {
                let _ = stdin.write_all(format!("{}\n", pw).as_bytes()).await;
                let _ = stdin.flush().await;
                drop(stdin);
            }
        }
    }
    #[cfg(unix)]
    drop(child.stdin.take());

    let output = child
        .wait_with_output()
        .await
        .map_err(|e| format!("SSH process failed: {}", e))?;

    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).to_string();

    Ok(format!("{}{}", stdout, stderr))
}

/// One discovered host key (algorithm + raw `known_hosts`-format line +
/// derived SHA256 fingerprint). The frontend shows the fingerprint to the
/// user for confirmation; the `key` line is what gets appended to the
/// app-managed `known_hosts` file via `ssh_pin_host`.
#[derive(Clone, Debug, Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HostKey {
    pub algorithm: String,
    pub key: String,
    pub fingerprint: String,
}

/// Run `ssh-keyscan` for the given host:port and return parsed host keys
/// (one per discovered algorithm). Fingerprints are derived via
/// `ssh-keygen -lf -`. Used by the Servers UI on first save so the user
/// can verify and pin the key before any traffic is sent.
#[tauri::command]
pub async fn ssh_fetch_fingerprint(host: String, port: u16) -> Result<Vec<HostKey>, String> {
    use std::process::Stdio;
    use tokio::io::AsyncWriteExt;

    let mut keyscan = tokio::process::Command::new("ssh-keyscan");
    keyscan
        .arg("-T")
        .arg("8")
        .arg("-t")
        .arg("ed25519,rsa,ecdsa")
        .arg("-p")
        .arg(port.to_string())
        .arg(&host);
    keyscan.stdin(Stdio::null());
    keyscan.stdout(Stdio::piped());
    keyscan.stderr(Stdio::piped());

    let output = keyscan
        .output()
        .await
        .map_err(|e| format!("Failed to run ssh-keyscan: {}. Is OpenSSH installed?", e))?;

    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).to_string();
    let lines: Vec<&str> = stdout
        .lines()
        .filter(|l| !l.trim().is_empty() && !l.starts_with('#'))
        .collect();

    if lines.is_empty() {
        let hint = if stderr.to_lowercase().contains("no route to host")
            || stderr.to_lowercase().contains("timed out")
            || stderr.to_lowercase().contains("connection refused")
        {
            stderr.trim().to_string()
        } else {
            format!("ssh-keyscan returned no keys for {}:{}", host, port)
        };
        return Err(hint);
    }

    let mut results: Vec<HostKey> = Vec::with_capacity(lines.len());
    for line in &lines {
        // Each line looks like: `<host>[:port] <algorithm> <base64-key>`.
        // Extract algorithm for the result struct (frontend displays it
        // alongside the fingerprint).
        let mut parts = line.split_whitespace();
        let _host_part = parts.next();
        let algorithm = parts
            .next()
            .unwrap_or_else(|| {
                // Malformed keyscan line — empty alg is harmless downstream but useful to flag.
                warn!(line = %line, "ssh-keyscan line missing algorithm token");
                ""
            })
            .to_string();

        // Derive the SHA256 fingerprint by piping the keyscan line to
        // `ssh-keygen -lf -`. Output: "<bits> SHA256:<...> <comment> (<alg>)".
        let mut keygen = tokio::process::Command::new("ssh-keygen");
        keygen.arg("-l").arg("-f").arg("-");
        keygen.stdin(Stdio::piped());
        keygen.stdout(Stdio::piped());
        keygen.stderr(Stdio::piped());

        let mut child = keygen
            .spawn()
            .map_err(|e| format!("Failed to spawn ssh-keygen: {}", e))?;
        if let Some(mut stdin) = child.stdin.take() {
            let _ = stdin.write_all(line.as_bytes()).await;
            let _ = stdin.write_all(b"\n").await;
            let _ = stdin.flush().await;
            drop(stdin);
        }
        let out = child
            .wait_with_output()
            .await
            .map_err(|e| format!("ssh-keygen failed: {}", e))?;

        let fp_line = String::from_utf8_lossy(&out.stdout).trim().to_string();
        // Pluck the SHA256:<...> token out of the keygen output.
        let fingerprint = fp_line
            .split_whitespace()
            .find(|tok| tok.starts_with("SHA256:"))
            .unwrap_or_else(|| {
                // ssh-keygen output format changed or input was rejected — empty fingerprint
                // gets filtered out below, but the cause is otherwise invisible.
                warn!(keygen_output = %fp_line, "ssh-keygen output missing SHA256 token");
                ""
            })
            .to_string();

        if !fingerprint.is_empty() {
            results.push(HostKey {
                algorithm,
                key: line.to_string(),
                fingerprint,
            });
        }
    }

    if results.is_empty() {
        return Err("Failed to derive SHA256 fingerprints from ssh-keyscan output".to_string());
    }
    Ok(results)
}

/// Append a `known_hosts`-format line to the app-managed file. Idempotent:
/// duplicate lines are skipped. Called by the Servers UI after the user
/// confirms the fingerprint shown by `ssh_fetch_fingerprint`.
#[tauri::command]
pub fn ssh_pin_host(host: String, port: u16, hostkey_line: String) -> Result<(), String> {
    use std::io::BufRead;

    let _ = (host, port); // host/port already encoded in the keyscan line
    let trimmed = hostkey_line.trim();
    if trimmed.is_empty() {
        return Err("Empty host key line".to_string());
    }

    let path = crate::core::execution::ensure_known_hosts_dir()?;
    // De-dupe: skip if the exact line already exists.
    if path.exists() {
        if let Ok(file) = std::fs::File::open(&path) {
            for line in std::io::BufReader::new(file).lines().map_while(Result::ok) {
                if line.trim() == trimmed {
                    return Ok(());
                }
            }
        }
    }

    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .map_err(|e| format!("Failed to open {:?}: {}", path, e))?;
    use std::io::Write;
    writeln!(file, "{}", trimmed).map_err(|e| format!("Failed to write known_hosts: {}", e))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600));
    }
    Ok(())
}

/// Return the absolute path of the app-managed `known_hosts` file. The
/// frontend fetches this once at startup and passes it into
/// `buildSshArgs` so JS-side SSH invocations match the Rust-side pinning.
#[tauri::command]
pub fn get_app_known_hosts_path() -> Result<String, String> {
    let path = crate::core::execution::ensure_known_hosts_dir()?;
    Ok(path.to_string_lossy().to_string())
}

/// Result of probing a remote filesystem path over SSH.
///
/// Used by the workspace creation modal to validate that the user-supplied
/// remote project path exists and is a directory before persisting a new
/// remote workspace. `is_git_repo` is a hint shown next to the path field.
#[derive(Clone, Debug, Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemotePathCheck {
    pub exists: bool,
    pub is_directory: bool,
    pub is_git_repo: bool,
}

fn resolve_remote_probe_password(
    auth_method: &str,
    supplied_password: Option<String>,
    target_id: Option<&str>,
    load_saved: impl FnOnce(&str) -> Result<Option<String>, String>,
) -> Result<Option<String>, String> {
    if auth_method != "password" {
        return Ok(None);
    }
    if let Some(password) = supplied_password.filter(|value| !value.is_empty()) {
        return Ok(Some(password));
    }
    let target_id = target_id
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| "Password authentication requires a saved server target id".to_string())?;
    load_saved(target_id)?
        .ok_or_else(|| {
            "No saved SSH password is available for this server. Re-save it in Servers settings."
                .to_string()
        })
        .map(Some)
}

/// Probe a remote SSH host to determine whether `remote_path` exists, is a
/// directory, and contains a `.git` directory. Used by the workspace
/// creation modal for live validation of the "Remote project path" input.
///
/// Times out after 8 seconds. Host-key pinning: when `host_fingerprint` is
/// `Some` we use the app-managed `known_hosts` file with
/// `StrictHostKeyChecking=yes`;
/// otherwise we fall back to TOFU `accept-new`. Callers that care about
/// safety should require a verified fingerprint before invoking this.
#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub async fn ssh_check_remote_path(
    host: String,
    port: u16,
    user: String,
    target_id: Option<String>,
    auth_method: String,
    key_path: Option<String>,
    password: Option<String>,
    host_fingerprint: Option<String>,
    remote_path: String,
) -> Result<RemotePathCheck, String> {
    if remote_path.trim().is_empty() {
        return Err("Remote path is empty".to_string());
    }

    let mut args: Vec<String> = vec![
        "-p".to_string(),
        port.to_string(),
        "-o".to_string(),
        "ConnectTimeout=8".to_string(),
        "-o".to_string(),
        "NumberOfPasswordPrompts=1".to_string(),
    ];

    if host_fingerprint.is_some() {
        let kh = crate::core::execution::app_known_hosts_path();
        args.push("-o".to_string());
        args.push("StrictHostKeyChecking=yes".to_string());
        args.push("-o".to_string());
        args.push(format!("UserKnownHostsFile={}", kh.to_string_lossy()));
    } else {
        tracing::warn!(
            host = %host,
            port = %port,
            "ssh_check_remote_path without pinned fingerprint — TOFU fallback"
        );
        args.push("-o".to_string());
        args.push("StrictHostKeyChecking=accept-new".to_string());
    }

    // Auth heuristics: if we have a
    // password to pipe to stdin, allow interactive password auth;
    // otherwise require key-only / BatchMode so SSH cannot hang.
    let pw_in = resolve_remote_probe_password(
        &auth_method,
        password,
        target_id.as_deref(),
        crate::commands::ssh_keys::load_ssh_password,
    )?;
    if pw_in.is_none() {
        args.push("-o".to_string());
        args.push("BatchMode=yes".to_string());
    } else {
        args.push("-o".to_string());
        args.push("PreferredAuthentications=password,keyboard-interactive".to_string());
    }

    if let Some(kp) = key_path.as_ref().filter(|s| !s.trim().is_empty()) {
        args.push("-i".to_string());
        args.push(kp.clone());
    }

    args.push(format!("{}@{}", user, host));

    let quoted = crate::core::execution::sh_quote(&remote_path);
    // Single-line POSIX shell probe — emits exactly one of:
    //   DIR_GIT | DIR | FILE | MISSING
    let probe = format!(
        "P={}; if [ -e \"$P\" ]; then if [ -d \"$P\" ]; then if [ -d \"$P/.git\" ]; then echo DIR_GIT; else echo DIR; fi; else echo FILE; fi; else echo MISSING; fi",
        quoted
    );
    args.push(probe);

    // Enforce an outer timeout in case SSH itself hangs despite ConnectTimeout.
    let fut = ssh_exec(args, pw_in);
    let output = match tokio::time::timeout(std::time::Duration::from_secs(8), fut).await {
        Ok(res) => res?,
        Err(_) => return Err("Probe timed out after 8s".to_string()),
    };

    let trimmed = output.trim();
    // Walk lines from the end — the probe's echo is always last; earlier
    // lines may contain SSH banners / motd noise.
    let tag = trimmed.lines().rev().find_map(|line| {
        let t = line.trim();
        match t {
            "DIR_GIT" | "DIR" | "FILE" | "MISSING" => Some(t),
            _ => None,
        }
    });

    match tag {
        Some("DIR_GIT") => Ok(RemotePathCheck {
            exists: true,
            is_directory: true,
            is_git_repo: true,
        }),
        Some("DIR") => Ok(RemotePathCheck {
            exists: true,
            is_directory: true,
            is_git_repo: false,
        }),
        Some("FILE") => Ok(RemotePathCheck {
            exists: true,
            is_directory: false,
            is_git_repo: false,
        }),
        Some("MISSING") => Ok(RemotePathCheck {
            exists: false,
            is_directory: false,
            is_git_repo: false,
        }),
        _ => {
            let lower = trimmed.to_lowercase();
            let msg =
                if lower.contains("permission denied") || lower.contains("authentication failed") {
                    "Authentication failed — verify the server credentials."
                } else if lower.contains("could not resolve")
                    || lower.contains("name or service not known")
                {
                    "Could not resolve host."
                } else if lower.contains("connection refused") {
                    "Connection refused."
                } else if lower.contains("connection timed out")
                    || lower.contains("operation timed out")
                {
                    "Connection timed out."
                } else if lower.contains("host key verification failed") {
                    "Host key verification failed — re-pin the host key on the Servers page."
                } else if trimmed.is_empty() {
                    "SSH returned no output."
                } else {
                    return Err(trimmed.to_string());
                };
            Err(msg.to_string())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use portable_pty::ExitStatus;
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
    // The Windows candidate selector moved next to the tier order in
    // `core::agent` so the launcher and the reporting sweep apply one rule.
    #[cfg(windows)]
    use crate::core::agent::select_windows_command_candidate;

    #[test]
    fn wsl_utf16_console_output_decodes_without_nul_bytes() {
        let encoded: Vec<u8> = "Ubuntu\r\nDebian\r\n"
            .encode_utf16()
            .flat_map(u16::to_le_bytes)
            .collect();
        assert_eq!(decode_console_output(&encoded), "Ubuntu\r\nDebian\r\n");
    }

    /// The `<DATA_DIR>/<command>-bin` pin is documented as the escape hatch for
    /// forcing a specific CLI binary. It was read only by the POSIX resolver,
    /// so on Windows it silently did nothing. These cover the platform-neutral
    /// read that both resolvers now share.
    #[test]
    fn app_pin_resolves_to_the_pinned_binary_on_every_platform() {
        let home = tempfile::tempdir().expect("tempdir");
        let data_dir = home.path().join(crate::core::brand::DATA_DIR_NAME);
        std::fs::create_dir_all(&data_dir).expect("data dir");

        // The pinned target must exist on disk for the pin to be honoured.
        let target = home.path().join("pinned-claude");
        std::fs::write(&target, b"#!/bin/sh\n").expect("target");
        std::fs::write(
            data_dir.join("claude-bin"),
            format!("{}\n", target.display()),
        )
        .expect("pin");

        assert_eq!(
            pinned_cli_binary_in(home.path(), "claude").as_deref(),
            Some(target.to_string_lossy().as_ref()),
        );
    }

    #[test]
    fn app_pin_is_keyed_on_the_program_name_not_the_whole_command() {
        let home = tempfile::tempdir().expect("tempdir");
        let data_dir = home.path().join(crate::core::brand::DATA_DIR_NAME);
        std::fs::create_dir_all(&data_dir).expect("data dir");
        let target = home.path().join("pinned-codex");
        std::fs::write(&target, b"#!/bin/sh\n").expect("target");
        std::fs::write(data_dir.join("codex-bin"), target.to_string_lossy().as_ref())
            .expect("pin");

        // A command that already arrived as a path still finds its pin.
        assert_eq!(
            pinned_cli_binary_in(home.path(), r"D:\tools\codex.exe").as_deref(),
            Some(target.to_string_lossy().as_ref()),
        );
    }

    #[test]
    fn app_pin_is_ignored_when_absent_empty_or_dangling() {
        let home = tempfile::tempdir().expect("tempdir");
        let data_dir = home.path().join(crate::core::brand::DATA_DIR_NAME);
        std::fs::create_dir_all(&data_dir).expect("data dir");

        // No pin file at all.
        assert_eq!(pinned_cli_binary_in(home.path(), "claude"), None);

        // Present but blank.
        std::fs::write(data_dir.join("claude-bin"), "   \n").expect("pin");
        assert_eq!(pinned_cli_binary_in(home.path(), "claude"), None);

        // Present but pointing at a binary that isn't there — must fall through
        // to PATH resolution rather than handing back a path that can't spawn.
        std::fs::write(
            data_dir.join("claude-bin"),
            home.path().join("gone").to_string_lossy().as_ref(),
        )
        .expect("pin");
        assert_eq!(pinned_cli_binary_in(home.path(), "claude"), None);
    }

    #[test]
    fn no_cli_resolves_through_another_products_install_directories() {
        // The install-directory tier exists because an installer that does not
        // touch PATH otherwise leaves a CLI detected-but-unlaunchable. Four
        // agents now have one, each evidence-backed: packetcode's installer
        // says outright that it skips PATH, Claude Code's native installer
        // targets `~/.local/bin`, and codex/opencode are npm packages whose
        // global bin is npm's documented default prefix.
        //
        // The rule that has to hold as that list grows is ISOLATION: every
        // candidate must be named for the CLI that asked. A tier that hands
        // back another product's binary is worse than no tier at all.
        for command in ALLOWED_COMMANDS.iter() {
            for candidate in crate::core::agent::install_dir_candidates(command) {
                assert_eq!(
                    candidate.file_stem().and_then(|name| name.to_str()),
                    Some(*command),
                    "{command} must not resolve through another product's install directories \
                     (got {})",
                    candidate.display()
                );
            }
        }

        // Shells are not agents and get no tier here: Git for Windows'
        // directories are consulted by `resolve_pty_launch` ahead of PATH,
        // deliberately, because `where bash` finds the WSL launcher first.
        for shell in ALLOWED_SHELL_COMMANDS.iter() {
            assert!(
                crate::core::agent::install_dir_candidates(shell).is_empty(),
                "{shell} is a shell profile, not an agent with an installer"
            );
        }
    }

    #[test]
    fn install_detection_and_the_pty_tier_search_the_same_places() {
        // The invariant the tier exists for: the binary the PTY launcher
        // spawns must be the one the reporting surfaces name. That is no
        // longer two lists that have to be kept in step — both call
        // `core::agent::resolve_cli_launch*`, which reads its install
        // directories from one place. This pins that wiring down so a future
        // edit cannot quietly reintroduce a second ladder.
        let candidates = crate::core::agent::install_dir_candidates("packetcode");
        assert_eq!(
            candidates,
            crate::core::agent::packetcode_fallback_candidates(),
            "the shared resolver must search packetcode's citation-backed list"
        );
        assert!(
            !candidates.is_empty(),
            "packetcode must have install candidates"
        );
        for candidate in &candidates {
            assert_eq!(
                candidate.file_stem().and_then(|s| s.to_str()),
                Some("packetcode"),
                "{} is not a packetcode binary",
                candidate.display()
            );
        }

        // And the launcher really does go through that shared resolver: for a
        // CLI with no pin and no settings path, the PTY's own entry point and
        // the reporting entry point agree exactly.
        let spec = crate::core::agent::CliLaunchSpec::from_command("packetcode");
        assert_eq!(
            resolve_pty_launch("packetcode"),
            crate::core::agent::resolve_cli_launch_sync(&spec)
        );
    }

    #[test]
    fn ssh_exec_refuses_local_execution_options() {
        let ok = |args: &[&str]| validate_ssh_exec_args(&args.iter().map(|s| s.to_string()).collect::<Vec<_>>());
        assert!(ok(&["-o", "ConnectTimeout=10", "-o", "StrictHostKeyChecking=yes", "-p", "22", "u@h", "echo hi"]).is_ok());
        assert!(ok(&["-o", "ProxyCommand=calc.exe", "u@h"]).is_err());
        assert!(ok(&["-oProxyCommand=calc.exe", "u@h"]).is_err());
        assert!(ok(&["-o", "proxycommand = calc", "u@h"]).is_err(), "case/space insensitive");
        assert!(ok(&["-o", "LocalCommand=rm -rf x", "-o", "PermitLocalCommand=yes", "u@h"]).is_err());
        assert!(ok(&["-o", "KnownHostsCommand=/tmp/x", "u@h"]).is_err());
        assert!(ok(&["-F", "/tmp/evil_config", "u@h"]).is_err());
        assert!(ok(&["-F/tmp/evil_config", "u@h"]).is_err());
        assert!(ok(&["-E", "/tmp/log", "u@h"]).is_err());
        // The remote command string is opaque and may mention the words.
        assert!(ok(&["u@h", "grep ProxyCommand ~/.ssh/config"]).is_ok());
    }

    #[test]
    fn shell_probe_allowlist_excludes_arbitrary_programs() {
        assert!(ALLOWED_SHELL_COMMANDS.contains(&"pwsh"));
        assert!(ALLOWED_SHELL_COMMANDS.contains(&"bash"));
        assert!(!ALLOWED_SHELL_COMMANDS.contains(&"calc"));
        assert!(!ALLOWED_SHELL_COMMANDS.contains(&"node"));
    }

    #[cfg(windows)]
    #[test]
    fn codex_resolution_prefers_cli_wrapper_over_windows_store_desktop_app() {
        let lines = [
            r"C:\Users\ian\AppData\Roaming\npm\codex",
            r"C:\Users\ian\AppData\Roaming\npm\codex.cmd",
            r"C:\Program Files\WindowsApps\OpenAI.Codex_1.0_x64__id\app\resources\codex.exe",
        ];

        assert_eq!(
            select_windows_command_candidate("codex", &lines).as_deref(),
            Some(r"C:\Users\ian\AppData\Roaming\npm\codex.cmd"),
        );
    }

    #[cfg(windows)]
    #[test]
    fn codex_resolution_accepts_a_non_store_native_cli() {
        let lines = [r"C:\tools\codex.exe"];

        assert_eq!(
            select_windows_command_candidate("codex", &lines).as_deref(),
            Some(r"C:\tools\codex.exe"),
        );
    }

    #[cfg(windows)]
    #[test]
    fn codex_resolution_rejects_a_store_only_desktop_candidate() {
        let lines =
            [r"C:\Program Files\WindowsApps\OpenAI.Codex_1.0_x64__id\app\resources\codex.exe"];

        assert_eq!(select_windows_command_candidate("codex", &lines), None);
    }

    /// REGRESSION: this is the shape `where` actually prints for a Store
    /// install — the app-execution alias, not the package payload. The old
    /// filter matched only `\windowsapps\openai.codex_`, so this path sailed
    /// through as a valid `.exe` and the pane died with `Access is denied`.
    #[cfg(windows)]
    #[test]
    fn codex_resolution_rejects_the_app_execution_alias_form() {
        let lines = [r"C:\Users\ian\AppData\Local\Microsoft\WindowsApps\codex.exe"];

        assert_eq!(select_windows_command_candidate("codex", &lines), None);
    }

    /// The npm layout on a real machine: `where` lists the extensionless shell
    /// shim FIRST and only `.cmd` is spawnable by Windows.
    #[cfg(windows)]
    #[test]
    fn codex_resolution_skips_the_extensionless_npm_shim() {
        let lines = [
            r"C:\Users\ian\AppData\Roaming\npm\codex",
            r"C:\Users\ian\AppData\Roaming\npm\codex.cmd",
        ];

        assert_eq!(
            select_windows_command_candidate("codex", &lines).as_deref(),
            Some(r"C:\Users\ian\AppData\Roaming\npm\codex.cmd"),
        );
    }

    /// The alias problem is not Codex-specific. This machine has a
    /// `WindowsApps\bash.exe` WSL alias, and `bash` is on the PTY allowlist.
    #[cfg(windows)]
    #[test]
    fn packaged_app_aliases_are_rejected_for_every_command_not_just_codex() {
        let alias = [r"C:\Users\ian\AppData\Local\Microsoft\WindowsApps\bash.exe"];
        assert_eq!(select_windows_command_candidate("bash", &alias), None);

        // A real executable still wins when both are present.
        let both = [
            r"C:\Users\ian\AppData\Local\Microsoft\WindowsApps\bash.exe",
            r"C:\Program Files\Git\bin\bash.exe",
        ];
        assert_eq!(
            select_windows_command_candidate("bash", &both).as_deref(),
            Some(r"C:\Program Files\Git\bin\bash.exe"),
        );
    }

    /// A CLI that is installed but NOT on `PATH` must still launch. Before the
    /// install-directory tier covered them, `codex` and `claude` had no rescue
    /// after a `PATH` miss and fell straight through to the bare name.
    #[test]
    fn npm_and_native_installed_clis_have_a_documented_install_tier() {
        for program in ["codex", "opencode", "claude", "packetcode"] {
            assert!(
                !crate::core::agent::install_dir_candidates(program).is_empty(),
                "{program} should have a documented install-directory tier"
            );
        }
        // Still empty for a CLI with no documented off-PATH location, so the
        // tier stays evidence-backed rather than a guess for everything.
        assert!(crate::core::agent::install_dir_candidates("gh-copilot").is_empty());
    }

    #[derive(Debug)]
    struct FakeKiller {
        killed: Arc<AtomicBool>,
    }

    impl PtyChildKiller for FakeKiller {
        fn kill(&mut self) -> std::io::Result<()> {
            self.killed.store(true, Ordering::Relaxed);
            Ok(())
        }

        fn clone_killer(&self) -> Box<dyn PtyChildKiller + Send + Sync> {
            Box::new(Self {
                killed: self.killed.clone(),
            })
        }
    }

    #[derive(Debug)]
    struct FakeChild {
        exited: Arc<AtomicBool>,
        try_wait_calls: Arc<AtomicUsize>,
    }

    impl PtyChildKiller for FakeChild {
        fn kill(&mut self) -> std::io::Result<()> {
            self.exited.store(true, Ordering::Relaxed);
            Ok(())
        }

        fn clone_killer(&self) -> Box<dyn PtyChildKiller + Send + Sync> {
            Box::new(FakeKiller {
                killed: self.exited.clone(),
            })
        }
    }

    impl PtyChild for FakeChild {
        fn try_wait(&mut self) -> std::io::Result<Option<ExitStatus>> {
            self.try_wait_calls.fetch_add(1, Ordering::Relaxed);
            if self.exited.load(Ordering::Relaxed) {
                Ok(Some(ExitStatus::with_exit_code(7)))
            } else {
                Ok(None)
            }
        }

        fn wait(&mut self) -> std::io::Result<ExitStatus> {
            Ok(ExitStatus::with_exit_code(7))
        }

        fn process_id(&self) -> Option<u32> {
            Some(123)
        }

        #[cfg(windows)]
        fn as_raw_handle(&self) -> Option<std::os::windows::io::RawHandle> {
            None
        }
    }

    fn shared_fake_child(exited: bool) -> (SharedChild, Arc<AtomicUsize>) {
        let try_wait_calls = Arc::new(AtomicUsize::new(0));
        let child = FakeChild {
            exited: Arc::new(AtomicBool::new(exited)),
            try_wait_calls: try_wait_calls.clone(),
        };
        (Arc::new(Mutex::new(Box::new(child))), try_wait_calls)
    }

    #[test]
    fn pty_exit_payload_serializes_exit_code_and_terminated() {
        let payload = PtyExitPayload {
            session_id: "session-1".to_string(),
            exit_code: Some(42),
            terminated: true,
        };

        let value = serde_json::to_value(payload).expect("serialize payload");

        assert_eq!(value["sessionId"], "session-1");
        assert_eq!(value["exitCode"], 42);
        assert_eq!(value["terminated"], true);
    }

    /// A Windows NTSTATUS crash code must survive the wire as the value the
    /// OS reported. With the old `i32` field `0xC0000005` serialized as
    /// `-1073741819`, which no user can look up and no decoder recognised.
    #[test]
    fn pty_exit_payload_preserves_ntstatus_exit_codes() {
        let payload = PtyExitPayload {
            session_id: "session-1".to_string(),
            exit_code: Some(u32::from_str_radix("C0000005", 16).unwrap() as i64),
            terminated: false,
        };

        let value = serde_json::to_value(payload).expect("serialize payload");

        assert_eq!(value["exitCode"], 3_221_225_477i64);
    }

    #[test]
    fn terminal_pty_read_error_detects_broken_pipe_and_eio() {
        let broken = std::io::Error::new(std::io::ErrorKind::BrokenPipe, "broken pipe");
        assert!(is_terminal_pty_read_error(&broken));

        let eio = std::io::Error::from_raw_os_error(5);
        assert!(is_terminal_pty_read_error(&eio));
    }

    #[test]
    fn pty_kill_targets_the_child_process_group_not_just_the_child() {
        // The child is `setsid`'d, so its pid IS the group id. Signalling the
        // group is the whole point: a bare kill of the direct child leaves the
        // agent's descendants alive.
        assert_eq!(pty_kill_group_ids(Some(4242), None), vec![4242]);
    }

    #[test]
    fn pty_kill_adds_the_terminal_foreground_group_when_it_differs() {
        assert_eq!(pty_kill_group_ids(Some(4242), Some(4310)), vec![4242, 4310]);
        // Job control left the running command in the leader's own group.
        assert_eq!(pty_kill_group_ids(Some(4242), Some(4242)), vec![4242]);
    }

    #[test]
    fn pty_kill_never_signals_our_own_group_or_init() {
        // `kill(-0, …)` broadcasts to OUR group and would take down PacketBench
        // itself; 1 is init.
        assert!(pty_kill_group_ids(Some(0), Some(1)).is_empty());
        assert!(pty_kill_group_ids(None, None).is_empty());
    }

    #[test]
    fn taskkill_args_terminate_the_whole_child_tree() {
        // Without /T only `cmd.exe` dies and the wrapped CLI survives.
        assert_eq!(
            taskkill_tree_args(4242),
            ["/T", "/F", "/PID", "4242"].map(String::from)
        );
    }

    #[test]
    fn killing_an_unknown_session_succeeds_instead_of_erroring() {
        // The reader thread removes the entry itself on EOF, so a pane whose
        // agent already exited has no entry left by the time the user closes
        // it. That is the common case, not a failure.
        let manager = create_shared_pty_manager();

        assert_eq!(kill_pty_session(&manager, "no-such-session"), Ok(()));
        assert_eq!(
            kill_pty_session_and_wait(
                &manager,
                "no-such-session",
                std::time::Duration::from_millis(10),
            ),
            Ok(false)
        );
    }

    #[test]
    fn shutting_down_with_no_sessions_is_a_no_op() {
        let manager = create_shared_pty_manager();
        shutdown_pty_sessions(&manager);
        assert!(manager.lock().expect("lock manager").sessions.is_empty());
    }

    #[test]
    fn wait_for_pty_child_exit_reports_completed_child() {
        let (child, try_wait_calls) = shared_fake_child(true);

        assert!(wait_for_pty_child_exit(
            "session-1",
            &child,
            std::time::Duration::from_millis(50),
        ));
        assert_eq!(try_wait_calls.load(Ordering::Relaxed), 1);
    }

    #[test]
    fn wait_for_pty_child_exit_times_out_when_reader_holds_child_lock() {
        let (child, try_wait_calls) = shared_fake_child(false);
        let _reader_wait_guard = child.lock().expect("lock child");

        assert!(!wait_for_pty_child_exit(
            "session-1",
            &child,
            std::time::Duration::from_millis(5),
        ));
        assert_eq!(try_wait_calls.load(Ordering::Relaxed), 0);
    }

    #[test]
    fn remote_probe_resolves_saved_password_by_target_id() {
        let password =
            resolve_remote_probe_password("password", None, Some("server-1"), |target| {
                assert_eq!(target, "server-1");
                Ok(Some("secret".to_string()))
            })
            .unwrap();

        assert_eq!(password.as_deref(), Some("secret"));
    }

    #[test]
    fn remote_probe_never_loads_password_for_key_auth() {
        let password = resolve_remote_probe_password("key", None, Some("server-1"), |_| {
            panic!("saved password loader must not run for key auth")
        })
        .unwrap();

        assert!(password.is_none());
    }

    #[test]
    fn remote_probe_reports_missing_saved_password() {
        let error = resolve_remote_probe_password("password", None, Some("server-1"), |_| Ok(None))
            .unwrap_err();

        assert!(error.contains("No saved SSH password"));
    }

    #[test]
    fn unresolvable_command_preserves_the_requested_name() {
        // Appending a fabricated extension would hide the real executable name
        // and turn the eventual spawn failure into a misleading
        // "*.cmd not found".
        let home = tempfile::tempdir().expect("tempdir");
        let spec = crate::core::agent::CliLaunchSpec::new("packetbench-missing-cli", None)
            .with_home(Some(home.path().to_path_buf()));
        let resolved = crate::core::agent::resolve_cli_launch_sync(&spec);
        assert_eq!(resolved.path, "packetbench-missing-cli");
        assert_eq!(
            resolved.source,
            crate::core::agent::CliLaunchSource::BareName
        );
    }
}
