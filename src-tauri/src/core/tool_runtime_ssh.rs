//! SSH implementations of API-agent tools. Each fn runs a small shell
//! script on the remote host via the system `ssh` binary.

use crate::commands::ssh_keys;
use crate::core::execution::{resolve_remote_path, sh_quote, SshConfig};
use std::time::Duration;
use tokio::io::AsyncWriteExt;
use tracing::info;

tokio::task_local! {
    pub(crate) static SSH_TOOL_OWNER: String;
}

type CleanupResult = Option<Result<(), String>>;
type CleanupReceiver = tokio::sync::watch::Receiver<CleanupResult>;
type CleanupOwners = std::collections::HashMap<String, Vec<CleanupReceiver>>;
static SSH_CLEANUPS: std::sync::OnceLock<std::sync::Mutex<CleanupOwners>> =
    std::sync::OnceLock::new();

fn cleanup_owners() -> std::sync::MutexGuard<'static, CleanupOwners> {
    SSH_CLEANUPS
        .get_or_init(Default::default)
        .lock()
        .unwrap_or_else(|error| error.into_inner())
}

fn register_cleanup(owner: String, receiver: CleanupReceiver) {
    let mut owners = cleanup_owners();
    owners.retain(|_, receivers| {
        receivers.retain(|receiver| !matches!(*receiver.borrow(), Some(Ok(()))));
        !receivers.is_empty()
    });
    owners.entry(owner).or_default().push(receiver);
}

/// A cancelled API turn must not release its owner or admit a replacement
/// before its SSH transport acknowledges group cleanup. Errors stay visible
/// to every reader, including Stop and a subsequent recovery admission.
pub(crate) async fn drain_session(session_id: &str) -> Result<(), String> {
    let receivers = cleanup_owners()
        .get(session_id)
        .cloned()
        .unwrap_or_default();
    for mut receiver in receivers {
        tokio::time::timeout(Duration::from_secs(15), async {
            loop {
                if let Some(result) = receiver.borrow().clone() {
                    return result;
                }
                receiver.changed().await.map_err(|_| {
                    "SSH cleanup ended without an acknowledgement; worktree retained.".to_string()
                })?;
            }
        })
        .await
        .map_err(|_| "SSH cleanup has not acknowledged Stop; worktree retained.".to_string())??;
    }
    let mut owners = cleanup_owners();
    if let Some(receivers) = owners.get_mut(session_id) {
        receivers.retain(|receiver| !matches!(*receiver.borrow(), Some(Ok(()))));
        if receivers.is_empty() {
            owners.remove(session_id);
        }
    }
    Ok(())
}

pub(crate) const MAX_FILE_SIZE: u64 = 2_000_000;
const MAX_OUTPUT_SIZE: usize = 262_144;
const DEFAULT_BASH_TIMEOUT: u64 = 30;
const SSH_OVERHEAD_SECS: u64 = 10;

/// Exit code emitted by the remote scripts when the resolved (symlink-followed)
/// path escapes the workspace base.
pub(crate) const EXIT_ESCAPE: i32 = 8;
/// Exit code emitted by the remote scripts when neither `realpath` nor
/// `readlink -f` is available, so confinement cannot be verified (fail closed).
pub(crate) const EXIT_NO_REALPATH: i32 = 9;

/// S8: portable canonicalizer shell function injected before any confinement
/// check. Prefers `realpath`, falls back to `readlink -f` (present on BusyBox /
/// minimal remotes that lack `realpath`), and fails CLOSED with
/// [`EXIT_NO_REALPATH`] only when neither exists. Both resolve symlinks and
/// require the path (or, for a parent probe, that path) to exist — matching the
/// previous `realpath --` semantics. Defining it more than once in a single
/// script (write_file uses two preludes) is harmless.
fn resolve_fn_def() -> String {
    format!(
        "__pkt_resolve() {{\n\
         if command -v realpath >/dev/null 2>&1; then realpath -- \"$1\"\n\
         elif command -v readlink >/dev/null 2>&1; then readlink -f -- \"$1\"\n\
         else exit {nr}; fi\n\
         }}\n",
        nr = EXIT_NO_REALPATH,
    )
}

/// Emit a POSIX-sh confinement prelude that realpath-resolves the workspace
/// `base` (which may itself be reached via a symlink) and the resolved
/// target, then verifies the target stays inside the base. Fails CLOSED:
/// missing `realpath` exits [`EXIT_NO_REALPATH`] and an escape exits
/// [`EXIT_ESCAPE`].
///
/// This complements (does not replace) the cheap lexical
/// [`resolve_remote_path`] first-pass — this realpath check is the
/// authoritative confinement because it follows symlinks on the remote.
///
/// `base_q` / `tgt_q` are already `sh_quote`d shell words. `resolve_target`
/// selects whether the target itself must resolve (`Existing`, for read /
/// list / grep) or only its parent directory must resolve (`Parent`, for
/// write_file whose leaf may not exist yet — mirroring the local
/// canonicalize-the-parent behaviour).
pub(crate) enum ConfineTarget {
    /// The target path must already exist and realpath-resolve.
    Existing,
    /// Only the target's parent must resolve (leaf may be created).
    Parent,
}

pub(crate) fn confine_prelude(base_q: &str, tgt_q: &str, mode: ConfineTarget) -> String {
    // `realpath -- <base>` first; if realpath is missing on the remote the
    // command fails and we exit EXIT_NO_REALPATH (fail closed). The trailing
    // slash on both the base and the candidate prevents "/workspace-evil"
    // from matching "/workspace".
    let base_line = format!(
        "{resolve}__base=$(__pkt_resolve {base}) || exit {nr}\n",
        resolve = resolve_fn_def(),
        base = base_q,
        nr = EXIT_NO_REALPATH
    );
    match mode {
        ConfineTarget::Existing => format!(
            "{base}__rp=$(__pkt_resolve {tgt}) || exit {nr}\n\
             case \"$__rp/\" in \"$__base\"/*) : ;; *) exit {esc};; esac\n",
            base = base_line,
            tgt = tgt_q,
            nr = EXIT_NO_REALPATH,
            esc = EXIT_ESCAPE,
        ),
        // Resolve the parent (the leaf may not exist yet), AND — if the leaf
        // already exists — resolve the leaf itself. A pre-existing symlinked
        // leaf pointing outside the workspace would otherwise be written
        // through even though its parent is in-workspace; the local tool
        // (tool_runtime.rs) canonicalizes an existing leaf for exactly this
        // reason, so we mirror that defense rather than confining the parent
        // alone.
        ConfineTarget::Parent => format!(
            "{base}__rp=$(__pkt_resolve \"$(dirname -- {tgt})\") || exit {nr}\n\
             case \"$__rp/\" in \"$__base\"/*) : ;; *) exit {esc};; esac\n\
             if [ -e {tgt} ] || [ -L {tgt} ]; then\n\
             __rpl=$(__pkt_resolve {tgt}) || exit {nr}\n\
             case \"$__rpl/\" in \"$__base\"/*) : ;; *) exit {esc};; esac\n\
             fi\n",
            base = base_line,
            tgt = tgt_q,
            nr = EXIT_NO_REALPATH,
            esc = EXIT_ESCAPE,
        ),
    }
}

/// Confine the nearest existing ancestor of a path before creating any missing
/// directories. This closes the window where `mkdir -p` could follow an
/// existing in-workspace symlink to a directory outside the workspace before
/// the normal parent confinement ran.
fn confine_creation_ancestor_prelude(base_q: &str, tgt_q: &str) -> String {
    format!(
        "{resolve}__base=$(__pkt_resolve {base}) || exit {nr}\n\
         __probe=$(dirname -- {tgt})\n\
         while [ ! -e \"$__probe\" ] && [ ! -L \"$__probe\" ]; do\n\
         __next=$(dirname -- \"$__probe\")\n\
         [ \"$__next\" = \"$__probe\" ] && exit {esc}\n\
         __probe=$__next\n\
         done\n\
         __ancestor=$(__pkt_resolve \"$__probe\") || exit {nr}\n\
         case \"$__ancestor/\" in \"$__base\"/*) : ;; *) exit {esc};; esac\n",
        resolve = resolve_fn_def(),
        base = base_q,
        tgt = tgt_q,
        nr = EXIT_NO_REALPATH,
        esc = EXIT_ESCAPE,
    )
}

/// Map a remote-script exit status to a confinement-specific error message,
/// or `None` if the failure was not a confinement failure (caller handles
/// the generic case).
pub(crate) fn confinement_error(code: i32) -> Option<String> {
    match code {
        EXIT_ESCAPE => {
            Some("Path escapes the workspace (resolved outside via symlink)".to_string())
        }
        EXIT_NO_REALPATH => Some(
            "Remote host lacks both 'realpath' and 'readlink'; cannot verify workspace confinement"
                .to_string(),
        ),
        _ => None,
    }
}

/// Look up a saved SSH password from the keychain for this target.
fn load_password(config: &SshConfig) -> Option<String> {
    let id = config.target_id.as_ref()?;
    ssh_keys::load_ssh_password(id).ok().flatten()
}

/// Run an SSH command. If a password is saved in the keychain for this
/// target, `BatchMode=yes` is dropped so SSH will accept interactive auth.
/// On Windows the password is piped to ssh's stdin (OpenSSH-for-Windows reads
/// it from a non-TTY stdin); on Unix the self-reinvoked askpass helper supplies
/// it without exposing the secret in argv or an environment value.
///
/// Note: on Windows, when password auth is in use the remote process's stdin
/// is occupied by the password — callers cannot use `stdin_data` and must
/// embed any payload directly in `remote_cmd` (e.g. via heredoc).
async fn ssh_run(
    config: &SshConfig,
    remote_cmd: &str,
    timeout_secs: u64,
) -> Result<std::process::Output, String> {
    ssh_run_inner(config, remote_cmd, timeout_secs, None).await
}

/// Bash keeps SSH stdin open as a lifetime lease. Its remote supervisor kills
/// only that invocation's isolated process group when the lease reaches EOF.
/// A pseudo-terminal alone cannot stop descendants which ignore SIGHUP.
async fn ssh_run_inner(
    config: &SshConfig,
    remote_cmd: &str,
    timeout_secs: u64,
    completion_marker: Option<&str>,
) -> Result<std::process::Output, String> {
    let keep_stdin_open = completion_marker.is_some();
    let completion_marker = completion_marker.map(str::to_owned);
    let password = load_password(config);
    let password_auth = password.is_some();

    let mut cmd = tokio::process::Command::new("ssh");
    cmd.args(config.ssh_args(password_auth));
    cmd.arg(remote_cmd);
    cmd.stdout(std::process::Stdio::piped());
    cmd.stderr(std::process::Stdio::piped());
    cmd.stdin(std::process::Stdio::piped());
    // Reap the ssh child if we bail out on the timeout below instead of leaving
    // it running; dropping the `Child` then terminates the OS process.
    cmd.kill_on_drop(true);

    #[cfg(target_os = "windows")]
    {
        cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
    }

    #[cfg(unix)]
    let _askpass_guard = password
        .as_deref()
        .map(|pw| crate::core::ssh_askpass::arm(&mut cmd, pw))
        .transpose()?;

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("Failed to spawn ssh: {}", e))?;

    let mut stdin_lease = None;
    if let Some(mut stdin) = child.stdin.take() {
        // F06/F11: only OpenSSH-for-Windows reads the auth password from a
        // non-TTY stdin. On Unix, ssh reads it from /dev/tty instead, so writing
        // it to stdin does nothing for authentication — and worse, on a
        // ControlMaster-multiplexed connection the client performs no auth at all
        // and forwards those stdin bytes straight to the remote command, leaking
        // the password. So feed the password only on Windows; elsewhere just
        // close stdin so the remote sees EOF.
        if keep_stdin_open {
            stdin_lease = Some(stdin);
        } else {
            #[cfg(windows)]
            if let Some(pw) = password.as_ref() {
                stdin
                    .write_all(format!("{}\n", pw).as_bytes())
                    .await
                    .map_err(|e| format!("Failed to write ssh stdin: {}", e))?;
            }
            stdin.shutdown().await.ok();
        }
    }

    let finished = if keep_stdin_open {
        let (sender, receiver) = tokio::sync::watch::channel(None);
        if let Ok(owner) = SSH_TOOL_OWNER.try_with(Clone::clone) {
            register_cleanup(owner, receiver);
        }
        Some(sender)
    } else {
        None
    };
    let collect = async move {
        let result = match tokio::time::timeout(
            Duration::from_secs(timeout_secs + SSH_OVERHEAD_SECS),
            child.wait_with_output(),
        )
        .await
        {
            Ok(Ok(mut output)) => {
                if let Some(marker) = completion_marker {
                    let marker = marker.as_bytes();
                    if let Some(offset) = output
                        .stderr
                        .windows(marker.len())
                        .rposition(|window| window == marker)
                    {
                        output.stderr.drain(offset..offset + marker.len());
                        Ok(output)
                    } else {
                        Err("SSH ended without confirmed remote process cleanup; worktree retained.".into())
                    }
                } else {
                    Ok(output)
                }
            }
            Ok(Err(error)) => Err(format!("SSH failed: {error}")),
            Err(_) => Err(format!(
                "SSH command timed out after {timeout_secs} seconds"
            )),
        };
        if let Some(finished) = finished {
            finished.send_replace(Some(result.as_ref().map(|_| ()).map_err(Clone::clone)));
        }
        result
    };
    let output = if keep_stdin_open {
        // Cancellation must close the lease while ssh is still alive to send
        // EOF. Dropping Child here kills the transport before it forwards EOF.
        // This bounded collector survives its caller only long enough to reap
        // the supervised remote group and collect its cancellation response.
        let collector = tokio::spawn(collect);
        #[cfg(windows)]
        if let (Some(pw), Some(stdin)) = (password.as_ref(), stdin_lease.as_mut()) {
            stdin
                .write_all(format!("{}\n", pw).as_bytes())
                .await
                .map_err(|e| format!("Failed to write ssh stdin: {}", e))?;
        }
        collector
            .await
            .map_err(|e| format!("SSH collector failed: {}", e))??
    } else {
        collect.await?
    };

    drop(stdin_lease);

    Ok(output)
}

/// The group leader stays alive until completion is acknowledged, so its PID
/// cannot be reused while a cancellation can still target the group. A single
/// mkdir claim prevents timeout and EOF from issuing two kills. Successful
/// commands release the leader without killing intentional background work.
fn supervised_bash_script(command: &str, timeout_secs: u64, completion_marker: &str) -> String {
    let runner = r#"__pkt_dir=$1
trap ':' HUP INT TERM
printf '%s\n' "$$" > "$__pkt_dir/group.tmp" && mv -- "$__pkt_dir/group.tmp" "$__pkt_dir/group" || exit 125
while [ ! -f "$__pkt_dir/go" ] && [ ! -f "$__pkt_dir/cancel-requested" ]; do sleep 0.1; done
if [ -f "$__pkt_dir/cancel-requested" ]; then
  __pkt_status=124
else
  sh -c "$2" </dev/null
  __pkt_status=$?
fi
printf '%s\n' "$__pkt_status" > "$__pkt_dir/status.tmp"
mv -- "$__pkt_dir/status.tmp" "$__pkt_dir/status"
while [ ! -f "$__pkt_dir/release" ]; do sleep 0.1; done
exit "$__pkt_status""#;
    format!(
        r#"command -v setsid >/dev/null 2>&1 || {{ printf '%s\n' 'Remote bash requires setsid for safe cancellation' >&2; exit 125; }}
__pkt_dir=$(mktemp -d) || exit 125
trap ':' HUP INT TERM
__pkt_kill_group() {{
  : > "$__pkt_dir/cancel-requested"
  if [ -s "$__pkt_dir/group" ] && mkdir "$__pkt_dir/kill" 2>/dev/null; then
    if [ ! -f "$__pkt_dir/status" ] && [ -s "$__pkt_dir/group" ]; then
      IFS= read -r __pkt_group < "$__pkt_dir/group"
      case "$__pkt_group" in ''|*[!0-9]*) : ;; *) kill -KILL "-$__pkt_group" 2>/dev/null || : ;; esac
    fi
  fi
}}
exec 3<&0
(
  trap ':' HUP INT TERM
  while IFS= read -r __pkt_line <&3; do :; done
  : > "$__pkt_dir/cancel-requested"
  __pkt_start=0
  while [ ! -s "$__pkt_dir/group" ] && [ "$__pkt_start" -lt 100 ]; do
    sleep 0.1
    __pkt_start=$((__pkt_start + 1))
  done
  __pkt_kill_group
  : > "$__pkt_dir/cancelled"
  exec sleep 86400
) &
__pkt_watcher=$!
setsid sh -c {runner} sh "$__pkt_dir" {command} </dev/null 3<&- &
__pkt_job=$!
__pkt_start=0
while [ ! -s "$__pkt_dir/group" ] && [ ! -f "$__pkt_dir/cancel-requested" ] && [ "$__pkt_start" -lt 100 ]; do
  sleep 0.1
  __pkt_start=$((__pkt_start + 1))
done
if [ -s "$__pkt_dir/group" ] && [ ! -f "$__pkt_dir/cancel-requested" ]; then
  : > "$__pkt_dir/go"
else
  __pkt_kill_group
fi
__pkt_ticks=0
while [ ! -f "$__pkt_dir/status" ] && [ ! -f "$__pkt_dir/cancelled" ] && [ "$__pkt_ticks" -lt {ticks} ]; do
  sleep 0.1
  __pkt_ticks=$((__pkt_ticks + 1))
done
if [ -f "$__pkt_dir/status" ]; then
  IFS= read -r __pkt_status < "$__pkt_dir/status"
else
  __pkt_kill_group
  __pkt_status=124
fi
kill -KILL "$__pkt_watcher" 2>/dev/null || :
wait "$__pkt_watcher" 2>/dev/null || :
: > "$__pkt_dir/release"
wait "$__pkt_job" 2>/dev/null || :
rm -f -- "$__pkt_dir/group.tmp" "$__pkt_dir/group" "$__pkt_dir/go" "$__pkt_dir/cancel-requested" "$__pkt_dir/status.tmp" "$__pkt_dir/status" "$__pkt_dir/cancelled" "$__pkt_dir/release"
rmdir "$__pkt_dir/kill" 2>/dev/null || :
rmdir "$__pkt_dir" 2>/dev/null || :
printf '%s' {completion_marker} >&2
exit "$__pkt_status""#,
        runner = sh_quote(runner),
        command = sh_quote(command),
        completion_marker = sh_quote(completion_marker),
        ticks = timeout_secs.saturating_mul(10).max(1),
    )
}

/// Public wrapper around `ssh_run` for non-tool consumers (e.g., worktree
/// provisioning). Uses a 30s timeout suitable for short git commands.
pub async fn ssh_run_for_worktree(
    config: &SshConfig,
    remote_cmd: &str,
) -> Result<std::process::Output, String> {
    ssh_run(config, remote_cmd, 30).await
}

/// Public wrapper for long-running remote git operations (Phase 3.2 — `git
/// clone` of large repos can take many minutes). Caller picks the timeout
/// in seconds.
pub async fn ssh_run_with_timeout(
    config: &SshConfig,
    remote_cmd: &str,
    timeout_secs: u64,
) -> Result<std::process::Output, String> {
    ssh_run(config, remote_cmd, timeout_secs).await
}

pub async fn execute_read_file(
    args: &serde_json::Value,
    config: &SshConfig,
) -> Result<String, String> {
    let path = args
        .get("path")
        .and_then(|p| p.as_str())
        .ok_or("Missing 'path' parameter")?;

    let full = resolve_remote_path(&config.remote_path, path)?;
    info!(remote_path = %full, "Tool(ssh): read_file");

    let script = format!(
        "p={q}\n\
         {confine}\
         if [ ! -f \"$p\" ]; then echo \"ERR:not_file:$p\" >&2; exit 2; fi\n\
         sz=$(wc -c <\"$p\")\n\
         if [ \"$sz\" -gt {max} ]; then echo \"ERR:too_large:$sz\" >&2; exit 3; fi\n\
         cat -- \"$p\"\n",
        q = sh_quote(&full),
        confine = confine_prelude(
            &sh_quote(&config.remote_path),
            "\"$p\"",
            ConfineTarget::Existing
        ),
        max = MAX_FILE_SIZE,
    );

    let output = ssh_run(config, &script, 60).await?;

    if !output.status.success() {
        let code = output.status.code().unwrap_or(-1);
        if let Some(msg) = confinement_error(code) {
            return Err(msg);
        }
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!(
            "read_file failed (exit {}): {}",
            code,
            stderr.trim()
        ));
    }

    Ok(String::from_utf8_lossy(&output.stdout).to_string())
}

pub async fn execute_write_file(
    args: &serde_json::Value,
    config: &SshConfig,
) -> Result<String, String> {
    let path = args
        .get("path")
        .and_then(|p| p.as_str())
        .ok_or("Missing 'path' parameter")?;
    let content = args
        .get("content")
        .and_then(|c| c.as_str())
        .ok_or("Missing 'content' parameter")?;

    let full = resolve_remote_path(&config.remote_path, path)?;
    info!(remote_path = %full, bytes = content.len(), "Tool(ssh): write_file");

    // Embed the content via a single-quoted heredoc so we don't depend on
    // the SSH stdin (which may be carrying the password).
    let eof = crate::core::shared::pick_heredoc_terminator(content, "PACKETBENCH_EOF_");
    // Confine the nearest existing ancestor before creation, then create and
    // re-confine the final parent/leaf immediately before writing. The `cat >
    // ... <<'EOF'` and its heredoc body must stay adjacent and untouched.
    let script = format!(
        "p={q}\n\
         {ancestor_confine}\
         mkdir -p \"$(dirname \"$p\")\" || exit 5\n\
         {confine}\
         cat > \"$p\" <<'{eof}'\n\
         {content}\n\
         {eof}\n",
        q = sh_quote(&full),
        ancestor_confine =
            confine_creation_ancestor_prelude(&sh_quote(&config.remote_path), "\"$p\""),
        confine = confine_prelude(
            &sh_quote(&config.remote_path),
            "\"$p\"",
            ConfineTarget::Parent
        ),
        eof = eof,
        content = content,
    );

    let output = ssh_run(config, &script, 60).await?;

    if !output.status.success() {
        let code = output.status.code().unwrap_or(-1);
        if let Some(msg) = confinement_error(code) {
            return Err(msg);
        }
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!(
            "write_file failed (exit {}): {}",
            code,
            stderr.trim()
        ));
    }

    Ok(format!(
        "Successfully wrote {} bytes to {}",
        content.len(),
        path
    ))
}

pub async fn execute_list_directory(
    args: &serde_json::Value,
    config: &SshConfig,
) -> Result<String, String> {
    let path = args.get("path").and_then(|p| p.as_str()).unwrap_or(".");

    let full = resolve_remote_path(&config.remote_path, path)?;
    info!(remote_path = %full, "Tool(ssh): list_directory");

    let script = format!(
        "p={q}\n\
         {confine}\
         if [ ! -d \"$p\" ]; then echo \"ERR:not_dir:$p\" >&2; exit 2; fi\n\
         cd \"$p\" || exit 4\n\
         ls -A1 2>/dev/null | head -500 | while IFS= read -r name; do\n\
           case \"$name\" in .*) continue;; esac\n\
           if [ -d \"$name\" ]; then\n\
             echo \"[DIR] $name\"\n\
           else\n\
             echo \"$name\"\n\
           fi\n\
         done | sort\n",
        q = sh_quote(&full),
        confine = confine_prelude(
            &sh_quote(&config.remote_path),
            "\"$p\"",
            ConfineTarget::Existing
        ),
    );

    let output = ssh_run(config, &script, 30).await?;

    if !output.status.success() {
        let code = output.status.code().unwrap_or(-1);
        if let Some(msg) = confinement_error(code) {
            return Err(msg);
        }
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!(
            "list_directory failed (exit {}): {}",
            code,
            stderr.trim()
        ));
    }

    Ok(String::from_utf8_lossy(&output.stdout)
        .trim_end()
        .to_string())
}

pub async fn execute_bash(args: &serde_json::Value, config: &SshConfig) -> Result<String, String> {
    let command = args
        .get("command")
        .and_then(|c| c.as_str())
        .ok_or("Missing 'command' parameter")?;
    let timeout_secs = args
        .get("timeout")
        .and_then(|t| t.as_u64())
        .unwrap_or(DEFAULT_BASH_TIMEOUT)
        .min(120);

    info!(command = %command, timeout = %timeout_secs, "Tool(ssh): bash");

    let command = format!("cd {} && {}", sh_quote(&config.remote_path), command);
    let marker = format!(
        "\n__SSH_GROUP_FINISHED_{}__\n",
        uuid::Uuid::new_v4().simple()
    );
    let remote_cmd = supervised_bash_script(&command, timeout_secs, &marker);

    // Keep stdin's lease alive while collecting output. Dropping this future
    // closes it, triggering remote group cancellation before any late writes.
    let output = ssh_run_inner(config, &remote_cmd, timeout_secs, Some(&marker)).await?;

    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);

    let mut result = String::new();
    if !stdout.is_empty() {
        result.push_str(stdout.replace("\r\n", "\n").as_str());
    }
    if !stderr.is_empty() {
        if !result.is_empty() {
            result.push_str("\n--- stderr ---\n");
        }
        result.push_str(stderr.replace("\r\n", "\n").as_str());
    }

    if result.len() > MAX_OUTPUT_SIZE {
        crate::core::tool_runtime::truncate_to_char_boundary(&mut result, MAX_OUTPUT_SIZE);
        result.push_str("\n... [output truncated]");
    }

    let exit_code = output.status.code().unwrap_or(-1);
    if exit_code != 0 {
        if result.is_empty() {
            result = format!("[exit code: {}]", exit_code);
        } else {
            result.push_str(&format!("\n[exit code: {}]", exit_code));
        }
        return Err(result);
    }

    Ok(result)
}

pub async fn execute_grep(args: &serde_json::Value, config: &SshConfig) -> Result<String, String> {
    let pattern = args
        .get("pattern")
        .and_then(|p| p.as_str())
        .ok_or("Missing 'pattern' parameter")?;
    let search_path = args.get("path").and_then(|p| p.as_str()).unwrap_or(".");
    let include = args.get("include").and_then(|i| i.as_str());

    let full = resolve_remote_path(&config.remote_path, search_path)?;
    info!(pattern = %pattern, remote_path = %full, "Tool(ssh): grep");

    // Bind the resolved path to `p` so the confinement prelude can realpath
    // it and `exit` (8/9) BEFORE grep runs if it escapes the workspace. The
    // grep pipeline's own exit status is masked by `head`, so a confinement
    // failure is only observable via this early `exit`.
    let mut cmd = format!(
        "p={q}\n{confine}",
        q = sh_quote(&full),
        confine = confine_prelude(
            &sh_quote(&config.remote_path),
            "\"$p\"",
            ConfineTarget::Existing
        ),
    );
    cmd.push_str(
        "grep -rEn --color=never \
         --exclude-dir=.git --exclude-dir=node_modules \
         --exclude-dir=target --exclude-dir=dist --exclude-dir=build",
    );
    if let Some(inc) = include {
        cmd.push_str(" --include=");
        cmd.push_str(&sh_quote(inc));
    }
    cmd.push_str(&format!(
        " -e {} \"$p\" 2>/dev/null | head -100\n",
        sh_quote(pattern),
    ));

    let output = ssh_run(config, &cmd, 60).await?;

    if !output.status.success() {
        let code = output.status.code().unwrap_or(-1);
        if let Some(msg) = confinement_error(code) {
            return Err(msg);
        }
        // Any other nonzero status (e.g. grep exit 1 = no matches) is not an
        // error here — fall through to the stdout-based handling below.
    }

    let text = String::from_utf8_lossy(&output.stdout)
        .trim_end()
        .to_string();
    if text.is_empty() {
        Ok(format!("No matches found for pattern '{}'", pattern))
    } else {
        Ok(text)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn cleanup_drain_waits_only_for_its_pending_owner() {
        let owner = uuid::Uuid::new_v4().to_string();
        let unrelated = uuid::Uuid::new_v4().to_string();
        let (finished, receiver) = tokio::sync::watch::channel(None);
        register_cleanup(owner.clone(), receiver);
        let (_other_finished, other_receiver) = tokio::sync::watch::channel(None);
        register_cleanup(unrelated.clone(), other_receiver);
        let mut drain = Box::pin(drain_session(&owner));
        assert!(tokio::time::timeout(Duration::from_millis(20), &mut drain)
            .await
            .is_err());
        finished.send_replace(Some(Ok(())));
        tokio::time::timeout(Duration::from_secs(1), drain)
            .await
            .unwrap()
            .unwrap();
        assert!(!cleanup_owners().contains_key(&owner));
        cleanup_owners().remove(&unrelated);
    }

    #[tokio::test]
    async fn cleanup_failure_is_sticky_for_stop_and_recovery_readers() {
        let owner = uuid::Uuid::new_v4().to_string();
        let (_finished, receiver) =
            tokio::sync::watch::channel(Some(Err("not acknowledged".into())));
        register_cleanup(owner.clone(), receiver);
        for _ in 0..2 {
            assert_eq!(drain_session(&owner).await.unwrap_err(), "not acknowledged");
        }
        cleanup_owners().remove(&owner);
    }

    /// Opt-in integration against an existing disposable, pinned SSH fixture.
    /// Every file/process belongs to a fresh directory, never a live attempt.
    #[tokio::test]
    #[ignore = "requires PACKETBENCH_SSH_TEST_FIXTURE pointing at a disposable SSH fixture"]
    async fn real_ssh_bash_cancellation_timeout_and_background_lifetimes() {
        let fixture: serde_json::Value = serde_json::from_slice(
            &std::fs::read(std::env::var("PACKETBENCH_SSH_TEST_FIXTURE").unwrap()).unwrap(),
        )
        .unwrap();
        let root = format!(
            "/work/flight-runtime-stop-{}",
            uuid::Uuid::new_v4().simple()
        );
        let config = SshConfig {
            host: fixture["server"]["host"].as_str().unwrap().into(),
            port: fixture["port"].as_u64().unwrap() as u16,
            user: fixture["server"]["username"].as_str().unwrap().into(),
            remote_path: root.clone(),
            key_path: Some(fixture["keyPath"].as_str().unwrap().into()),
            auth_method: Some("key".into()),
            target_id: None,
            host_fingerprint: Some(fixture["hostFingerprint"].as_str().unwrap().into()),
        };
        async fn read(config: &SshConfig, command: &str) -> String {
            let output = ssh_run(config, command, 15).await.unwrap();
            assert!(
                output.status.success(),
                "{}",
                String::from_utf8_lossy(&output.stderr)
            );
            String::from_utf8(output.stdout).unwrap()
        }
        let setup = format!(
            "mkdir -- {root} && cd {root} && git init -q && printf 'staged content\\n' > staged.txt && printf 'preserved untracked\\n' > untouched.txt && git add staged.txt",
            root = sh_quote(&root),
        );
        read(&config, &setup).await;
        let evidence = format!("cd {} && sha256sum .git/index && git diff --cached --binary && cat staged.txt untouched.txt", sh_quote(&root));
        let before = read(&config, &evidence).await;
        fn command(root: &str, label: &str, delay_ms: u64, background: bool) -> String {
            let child = format!(
                "process.on('SIGHUP',()=>{{}});process.on('SIGTERM',()=>{{}});const fs=require('node:fs');fs.writeFileSync({ready},String(process.pid));setTimeout(()=>fs.writeFileSync({late},'survived'),{delay_ms});",
                ready = serde_json::to_string(&format!("{root}/{label}.ready")).unwrap(),
                late = serde_json::to_string(&format!("{root}/{label}.late")).unwrap(),
            );
            let parent = format!(
                "const fs=require('node:fs');const child=require('node:child_process').spawn(process.execPath,['-e',{child}],{{stdio:'ignore'}});fs.writeFileSync({owner},JSON.stringify([process.pid,child.pid]));{finish}",
                child = serde_json::to_string(&child).unwrap(),
                owner = serde_json::to_string(&format!("{root}/{label}.owners")).unwrap(),
                finish = if background { "child.unref();" } else { "setTimeout(()=>{},20000);" },
            );
            format!("node -e {}", sh_quote(&parent))
        }
        let config_for_task = config.clone();
        let args = serde_json::json!({"command":command(&root,"abort",6000,false),"timeout":20});
        let owner = uuid::Uuid::new_v4().to_string();
        let task_owner = owner.clone();
        let task = tokio::spawn(async move {
            SSH_TOOL_OWNER
                .scope(task_owner, execute_bash(&args, &config_for_task))
                .await
        });
        let mut ready = false;
        for _ in 0..30 {
            let output = ssh_run(
                &config,
                &format!("test -f {}", sh_quote(&format!("{root}/abort.ready"))),
                5,
            )
            .await
            .unwrap();
            if output.status.success() {
                ready = true;
                break;
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        assert!(ready, "remote grandchild did not start");
        task.abort();
        assert!(task.await.unwrap_err().is_cancelled());
        drain_session(&owner)
            .await
            .expect("Stop must await remote cancellation acknowledgement");
        let check_stopped = format!(
            "const fs=require('node:fs');const root={root};const pids=JSON.parse(fs.readFileSync(root+'/abort.owners'));if(pids.some(pid=>{{try{{return fs.readFileSync('/proc/'+pid+'/cmdline','utf8').includes(root)}}catch{{return false}}}}))process.exit(1);",
            root = serde_json::to_string(&root).unwrap(),
        );
        read(&config, &format!("node -e {}", sh_quote(&check_stopped))).await;
        let timeout_args =
            serde_json::json!({"command":command(&root,"timeout",3000,false),"timeout":1});
        let timeout_error = execute_bash(&timeout_args, &config).await.unwrap_err();
        assert!(timeout_error.contains("124"), "{timeout_error}");
        let normal_args =
            serde_json::json!({"command":command(&root,"background",500,true),"timeout":10});
        execute_bash(&normal_args, &config).await.unwrap();
        let started = std::time::Instant::now();
        let signal_args = serde_json::json!({"command":"timeout 1 sleep 5","timeout":10});
        let signal_error = execute_bash(&signal_args, &config).await.unwrap_err();
        assert!(signal_error.contains("124"), "{signal_error}");
        assert!(
            started.elapsed() < Duration::from_secs(3),
            "user command inherited ignored TERM"
        );
        tokio::time::sleep(Duration::from_secs(7)).await;
        let verify = format!(
            "const fs=require('node:fs');const root={root};const active=label=>JSON.parse(fs.readFileSync(root+'/'+label+'.owners')).filter(pid=>{{try{{return fs.readFileSync('/proc/'+pid+'/cmdline','utf8').includes(root)}}catch{{return false}}}});console.log(JSON.stringify({{abortLate:fs.existsSync(root+'/abort.late'),timeoutLate:fs.existsSync(root+'/timeout.late'),backgroundLate:fs.existsSync(root+'/background.late'),abortActive:active('abort'),timeoutActive:active('timeout')}}));",
            root = serde_json::to_string(&root).unwrap(),
        );
        let result: serde_json::Value =
            serde_json::from_str(&read(&config, &format!("node -e {}", sh_quote(&verify))).await)
                .unwrap();
        assert_eq!(result["abortLate"], false, "{result}");
        assert_eq!(result["timeoutLate"], false, "{result}");
        assert_eq!(result["backgroundLate"], true, "{result}");
        assert_eq!(
            result["abortActive"].as_array().unwrap().len(),
            0,
            "{result}"
        );
        assert_eq!(
            result["timeoutActive"].as_array().unwrap().len(),
            0,
            "{result}"
        );
        assert_eq!(
            read(&config, &evidence).await,
            before,
            "Stop changed staged or untracked files"
        );
        let failed_owner = uuid::Uuid::new_v4().to_string();
        let missing_marker = format!("\nmissing-{}\n", uuid::Uuid::new_v4());
        let unacknowledged = SSH_TOOL_OWNER
            .scope(
                failed_owner.clone(),
                ssh_run_inner(&config, "exit 255", 5, Some(&missing_marker)),
            )
            .await
            .unwrap_err();
        assert!(unacknowledged.contains("without confirmed"));
        for _ in 0..2 {
            assert!(drain_session(&failed_owner)
                .await
                .unwrap_err()
                .contains("without confirmed"));
        }
        cleanup_owners().remove(&failed_owner);
    }

    #[test]
    fn parent_confine_also_rejects_existing_symlinked_leaf() {
        // Regression: confining only the parent dir let a pre-existing
        // symlinked leaf (link -> /etc) be written through, since dirname is
        // in-workspace. The Parent prelude must also resolve+confine the leaf
        // when it already exists, mirroring the local canonicalize-the-leaf
        // defense in tool_runtime.rs.
        let s = confine_prelude("'/ws'", "\"$p\"", ConfineTarget::Parent);
        assert!(s.contains("dirname --"), "parent dir is resolved");
        assert!(
            s.contains("if [ -e \"$p\" ] || [ -L \"$p\" ]; then"),
            "existing-leaf branch present"
        );
        assert!(
            s.contains("__rpl=$(__pkt_resolve \"$p\")"),
            "leaf is canonicalized"
        );
        // base + parent + leaf each fail closed, plus the one in the resolver
        // fn's neither-tool-available branch (S8).
        assert_eq!(
            s.matches(&format!("exit {}", EXIT_NO_REALPATH)).count(),
            4,
            "fail-closed on base, parent, leaf, and no-resolver"
        );
        // parent-escape and leaf-escape are both rejected.
        assert_eq!(
            s.matches(&format!("exit {}", EXIT_ESCAPE)).count(),
            2,
            "escape rejected for parent and leaf"
        );
    }

    #[test]
    fn existing_confine_has_no_leaf_or_parent_branch() {
        let s = confine_prelude("'/ws'", "\"$p\"", ConfineTarget::Existing);
        assert!(!s.contains("dirname --"));
        assert!(!s.contains("__rpl"));
        // base + the single existing-target resolve, plus the resolver fn's
        // no-tool branch (S8).
        assert_eq!(s.matches(&format!("exit {}", EXIT_NO_REALPATH)).count(), 3);
        assert_eq!(s.matches(&format!("exit {}", EXIT_ESCAPE)).count(), 1);
    }

    #[test]
    fn creation_ancestor_is_confined_before_mkdir() {
        let ancestor = confine_creation_ancestor_prelude("'/ws'", "\"$p\"");
        let script = format!(
            "p='/ws/new/file'\n{}mkdir -p \"$(dirname \"$p\")\"\n",
            ancestor
        );

        let confine_pos = script.find("__ancestor=$(__pkt_resolve").unwrap();
        let mkdir_pos = script.find("mkdir -p").unwrap();
        assert!(confine_pos < mkdir_pos);
        assert!(ancestor.contains("while [ ! -e \"$__probe\" ] && [ ! -L \"$__probe\" ]"));
        assert!(ancestor.contains("case \"$__ancestor/\""));
    }

    // S8: the confinement resolver prefers realpath, falls back to readlink -f
    // (BusyBox / minimal remotes), and fails closed only when neither exists.
    #[test]
    fn resolver_falls_back_to_readlink_then_fails_closed() {
        let s = confine_prelude("'/ws'", "\"$p\"", ConfineTarget::Existing);
        assert!(
            s.contains("command -v realpath >/dev/null 2>&1; then realpath -- \"$1\""),
            "prefers realpath"
        );
        assert!(
            s.contains("command -v readlink >/dev/null 2>&1; then readlink -f -- \"$1\""),
            "falls back to readlink -f"
        );
        assert!(
            s.contains(&format!("else exit {}", EXIT_NO_REALPATH)),
            "fails closed when neither tool exists"
        );
        // The resolver function is defined before it is first used.
        let def_pos = s.find("__pkt_resolve() {").unwrap();
        let use_pos = s.find("__base=$(__pkt_resolve").unwrap();
        assert!(def_pos < use_pos, "resolver defined before use");
    }
}
