//! Git worktree provisioning for async parallel agents.
//!
//! Each Attempt runs inside a dedicated git worktree on a branch named
//! `pkt/<attempt_id>`. Worktrees live under `<base>/.pkt-worktrees/<attempt_id>`.
//! Local worktrees use `tokio::process::Command::new("git")`. Remote worktrees
//! reuse `tool_runtime_ssh::ssh_run` so the existing keychain-password flow
//! applies automatically.

use crate::core::execution::{sh_quote, SshConfig};
use serde::Serialize;
use std::process::Stdio;
use tokio::process::Command;
use tracing::{info, warn};

const WORKTREES_DIR: &str = ".pkt-worktrees";
const INTEGRATIONS_DIR: &str = ".pkt-flight-integrations";

/// Phase 3.2: maximum time we'll wait for a remote `git clone` to finish.
/// Large monorepos over slow links can take a while; the existing
/// per-command 30 s budget in `ssh_run_for_worktree` is far too short.
const REMOTE_CLONE_TIMEOUT_SECS: u64 = 10 * 60;

/// Branch name for an attempt. Stable + grep-friendly.
pub fn branch_name(attempt_id: &str) -> String {
    format!("pkt/{}", attempt_id)
}

/// Worktree path for an attempt, given its base path.
pub fn worktree_path(base: &str, attempt_id: &str) -> Result<String, String> {
    validate_worktree_component(attempt_id)?;
    let trimmed = base.trim_end_matches(['/', '\\']);
    Ok(format!("{}/{}/{}", trimmed, WORKTREES_DIR, attempt_id))
}

/// Worktree path for a Flight's cooperative integration branch, given its base
/// path. Mirrors the layout `prepare_local_integration_branch` /
/// `prepare_remote_integration_branch` create (`<base>/.pkt-flight-integrations/<flight_id>`)
/// so the teardown path can find it without an attempt id — integration
/// worktrees are flight-keyed, which is exactly why nothing could remove them
/// before.
pub fn integration_worktree_path(base: &str, flight_id: &str) -> Result<String, String> {
    validate_worktree_component(flight_id)?;
    let trimmed = base.trim_end_matches(['/', '\\']);
    Ok(format!("{}/{}/{}", trimmed, INTEGRATIONS_DIR, flight_id))
}

/// S3: defense-in-depth guard for a repo-relative path that will be handed to a
/// remote `git add`/`restore`/`show`. Rejects absolute paths and any `..`
/// traversal component. Sub-directory separators ARE allowed (`src/foo.rs`),
/// unlike `validate_worktree_component`. Shell-safety is handled separately by
/// `sh_quote` at the call site — this stops path escape, not injection.
pub fn validate_remote_rel_path(path: &str) -> Result<(), String> {
    if path.trim().is_empty() {
        return Err("Path cannot be empty".to_string());
    }
    if std::path::Path::new(path).is_absolute() || path.starts_with('/') || path.starts_with('\\') {
        return Err(format!(
            "Path must be repo-relative, not absolute: {}",
            path
        ));
    }
    // Split on both separators so a Windows-style `..\` is caught too.
    let has_traversal = path.split(['/', '\\']).any(|seg| seg == "..");
    if has_traversal {
        return Err(format!("Path cannot contain '..' traversal: {}", path));
    }
    Ok(())
}

fn validate_worktree_component(component: &str) -> Result<(), String> {
    if component.is_empty() {
        return Err("Worktree id cannot be empty".to_string());
    }
    if std::path::Path::new(component).is_absolute() {
        return Err("Worktree id cannot be absolute".to_string());
    }
    if component == "." || component == ".." || component.contains("..") {
        return Err("Worktree id cannot contain traversal components".to_string());
    }
    if component.contains('/') || component.contains('\\') {
        return Err("Worktree id cannot contain path separators".to_string());
    }
    if !component
        .chars()
        .all(|character| character.is_ascii_alphanumeric() || matches!(character, '-' | '_'))
    {
        return Err("Worktree id may contain only ASCII letters, digits, '-' and '_'".to_string());
    }
    Ok(())
}

// --- Local ---

async fn run_local_git(cwd: &str, args: &[&str]) -> Result<(String, String, i32), String> {
    let mut cmd = Command::new("git");
    cmd.current_dir(cwd);
    for a in args {
        cmd.arg(a);
    }
    cmd.stdin(Stdio::null());
    cmd.stdout(Stdio::piped());
    cmd.stderr(Stdio::piped());

    #[cfg(target_os = "windows")]
    {
        cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
    }

    let output = cmd
        .output()
        .await
        .map_err(|e| format!("Failed to spawn git: {}", e))?;
    Ok((
        String::from_utf8_lossy(&output.stdout).into_owned(),
        String::from_utf8_lossy(&output.stderr).into_owned(),
        output.status.code().unwrap_or(-1),
    ))
}

/// v0.8: optional flight context the worktree provisioner forwards to the
/// auto-trailer hook installer. When `None`, the trailer format's
/// `{flightId}` / `{flightTitle}` placeholders are filled with `"unknown"`
/// and `""` respectively. Used by callers that aren't flight-tied (e.g.
/// agents-pane conversation worktrees in `commands/git.rs`).
#[derive(Debug, Clone, Default)]
pub struct WorktreeFlight {
    pub flight_id: Option<String>,
    pub flight_title: Option<String>,
}

/// v0.8.5: issue context the worktree provisioner forwards to the
/// auto-trailer hook installer for Issue-bound worktrees. The hook for
/// these worktrees writes two trailers:
///   `Fixes #{issue_number}`
///   `Run-By: PacketBench issue I-{issue_id}`
/// so that on commit the synchronous git_commit watcher can flip the
/// matching Issue to `done` via the `issue-watcher:fixed` event.
#[derive(Debug, Clone)]
pub struct WorktreeIssue {
    pub issue_id: String,
    pub issue_number: u32,
    pub issue_title: String,
}

/// Create a local git worktree at `<base>/.pkt-worktrees/<attempt_id>` checked
/// out to a new branch `pkt/<attempt_id>` based on `base_branch`. Idempotent —
/// if the worktree already exists, returns its path without erroring.
///
/// v0.8-16 (revised): conditionally installs a `prepare-commit-msg` hook
/// inside the worktree's `.git/hooks` directory so every commit made
/// inside the worktree gets a configurable trailer. The hook installer
/// reads `OrchestratorSettings.auto_commit_trailer_*` from the
/// persisted state and skips installation entirely when the user has
/// turned the feature off.
pub async fn create_local_worktree(
    base: &str,
    attempt_id: &str,
    base_branch: &str,
) -> Result<String, String> {
    create_local_worktree_with_flight(base, attempt_id, base_branch, WorktreeFlight::default())
        .await
}

/// v0.8: like `create_local_worktree` but accepts flight metadata so the
/// auto-trailer hook can substitute real values for `{flightId}` and
/// `{flightTitle}` placeholders.
pub async fn create_local_worktree_with_flight(
    base: &str,
    attempt_id: &str,
    base_branch: &str,
    flight: WorktreeFlight,
) -> Result<String, String> {
    let path = worktree_path(base, attempt_id)?;
    let branch = branch_name(attempt_id);

    if std::path::Path::new(&path).exists() {
        info!(path = %path, "Worktree already exists, reusing");
        // Idempotently re-install the hook so older worktrees pick it up
        // on next launch.
        if let Err(e) = install_prepare_commit_msg_hook(&path, attempt_id, &flight).await {
            warn!(path = %path, error = %e, "Failed to install prepare-commit-msg hook on existing worktree (non-fatal)");
        }
        return Ok(path);
    }

    let (_, stderr, code) = run_local_git(
        base,
        &["worktree", "add", "-b", &branch, &path, base_branch],
    )
    .await?;
    if code != 0 {
        return Err(format!(
            "git worktree add failed (exit {}): {}",
            code,
            stderr.trim()
        ));
    }
    info!(path = %path, branch = %branch, "Created local worktree");

    // v0.8-16: auto-trailer hook. Non-fatal if it fails — the worktree
    // is still usable, the commit just won't carry the trailer.
    if let Err(e) = install_prepare_commit_msg_hook(&path, attempt_id, &flight).await {
        warn!(path = %path, error = %e, "Failed to install prepare-commit-msg hook (non-fatal)");
    }

    Ok(path)
}

/// v0.8.5: create a local git worktree dedicated to a specific Issue and
/// install a `prepare-commit-msg` hook that appends two trailers to every
/// commit made inside it:
///   `Fixes #{issue_number}`
///   `Run-By: PacketBench issue I-{issue_id}`
///
/// Mirrors `create_local_worktree_with_flight` but uses
/// `install_prepare_commit_msg_hook_for_issue` for the trailer logic.
/// Idempotent: existing worktrees re-receive the hook install on next
/// launch so older worktrees pick up the trailers.
///
/// Trailer installation respects `OrchestratorSettings.auto_commit_trailer_enabled`
/// — turning the toggle off skips hook installation entirely, matching
/// the flight-bound variant's behaviour.
pub async fn create_local_worktree_for_issue(
    base: &str,
    attempt_id: &str,
    base_branch: &str,
    issue: WorktreeIssue,
) -> Result<String, String> {
    let path = worktree_path(base, attempt_id)?;
    let branch = branch_name(attempt_id);

    if std::path::Path::new(&path).exists() {
        info!(path = %path, issue = %issue.issue_id, "Issue worktree already exists, reusing");
        if let Err(e) = install_prepare_commit_msg_hook_for_issue(&path, &issue).await {
            warn!(
                path = %path,
                issue = %issue.issue_id,
                error = %e,
                "Failed to install issue prepare-commit-msg hook on existing worktree (non-fatal)",
            );
        }
        return Ok(path);
    }

    let (_, stderr, code) = run_local_git(
        base,
        &["worktree", "add", "-b", &branch, &path, base_branch],
    )
    .await?;
    if code != 0 {
        return Err(format!(
            "git worktree add failed (exit {}): {}",
            code,
            stderr.trim()
        ));
    }
    info!(path = %path, branch = %branch, issue = %issue.issue_id, "Created local issue worktree");

    if let Err(e) = install_prepare_commit_msg_hook_for_issue(&path, &issue).await {
        warn!(
            path = %path,
            issue = %issue.issue_id,
            error = %e,
            "Failed to install issue prepare-commit-msg hook (non-fatal)",
        );
    }

    Ok(path)
}

/// v0.8: render the user-supplied trailer format with the live flight
/// values. Recognised placeholders: `{flightId}`, `{attemptId}`,
/// `{flightTitle}`. Anything else is passed through unchanged so users
/// can keep literal braces if they need to.
pub(crate) fn render_trailer_format(
    format: &str,
    flight_id: &str,
    attempt_id: &str,
    flight_title: &str,
) -> String {
    format
        .replace("{flightId}", flight_id)
        .replace("{attemptId}", attempt_id)
        .replace("{flightTitle}", flight_title)
}

/// v0.8: strip shell-meaningful characters out of trailer values before
/// they hit the hook script. The script writes them via a single-quoted
/// `printf` literal so quotes are the only real escape hazard, but we
/// also drop control characters / newlines so a malicious flight title
/// can't smuggle extra trailers in.
fn sanitize_trailer_value(s: &str) -> String {
    s.chars()
        .map(|c| if c.is_control() || c == '\'' { ' ' } else { c })
        .collect::<String>()
        .trim()
        .to_string()
}

/// v0.8-16 (revised): write a `prepare-commit-msg` hook inside the
/// worktree's git directory that appends the user-configured trailer to
/// every commit message that does not already carry one.
///
/// Behaviour driven by `OrchestratorSettings`:
/// - `auto_commit_trailer_enabled = false` → no hook is written; any
///   pre-existing hook from earlier runs is left alone.
/// - `auto_commit_trailer_format` → format string; placeholders
///   `{flightId}`, `{attemptId}`, `{flightTitle}` are substituted from
///   the supplied `flight` context. Unspecified placeholders fall back
///   to `"unknown"` / `""`.
///
/// Cross-platform notes:
/// - On POSIX, `chmod +x` is required for git to invoke the hook.
/// - On Windows with Git for Windows, the bundled MSYS shell honours
///   the `#!/bin/sh` shebang for hooks named `prepare-commit-msg`
///   (no extension), so the same script file works as-is. We make the
///   file executable on POSIX only.
///
/// The hook lives at `<worktree>/.git/hooks/prepare-commit-msg`.
/// Worktrees have a `.git` *file* (not directory) pointing at the main
/// repo's `worktrees/<id>` dir; we resolve it via `rev-parse
/// --git-path hooks` so both styles work.
/// Shared plumbing for installing a `prepare-commit-msg` hook.
///
/// Consults the persisted orchestration settings (`load_state` is sync, so it
/// runs on a worker thread to keep the file I/O off the tokio executor),
/// honors the `auto_commit_trailer_enabled` toggle, resolves the
/// worktree-scoped hooks dir (`git rev-parse --git-path hooks`, falling back to
/// `.git/hooks`), writes the script produced by `build_script`, and makes it
/// executable on Unix (Windows' MSYS sh honours the shebang, so the missing +x
/// bit is fine there). `build_script` receives the loaded settings — the flight
/// variant needs `auto_commit_trailer_format`, the issue variant ignores it —
/// and is only invoked when the toggle is enabled. Returns the written hook
/// path, or `None` when installation was skipped because the toggle is off.
/// GP4: does a PATH contain a POSIX shell (sh/bash) that git could use to run a
/// hook? Git for Windows bundles its own `sh`, but a vanilla Windows-OpenSSH /
/// plain-git environment may have none — in which case the POSIX
/// `prepare-commit-msg` hook silently no-ops. `exists` is injected for testing.
// Only consumed on Windows (the warn path) and in tests; `#[cfg]` avoids a
// dead_code warning on the documented Linux/macOS build targets.
#[cfg(any(windows, test))]
fn posix_shell_on_path_with<F: Fn(&std::path::Path) -> bool>(path_var: &str, exists: F) -> bool {
    let sep = if cfg!(windows) { ';' } else { ':' };
    path_var.split(sep).filter(|d| !d.is_empty()).any(|dir| {
        ["sh.exe", "bash.exe", "sh", "bash"]
            .iter()
            .any(|exe| exists(&std::path::Path::new(dir).join(exe)))
    })
}

async fn write_prepare_commit_msg_hook(
    worktree_path: &str,
    skip_note: &str,
    build_script: impl FnOnce(&crate::core::orchestrator::OrchestratorSettings) -> String,
) -> Result<Option<std::path::PathBuf>, String> {
    let settings = tokio::task::spawn_blocking(|| crate::core::storage::load_state().settings)
        .await
        .map_err(|e| format!("settings load join error: {}", e))?;

    if !settings.auto_commit_trailer_enabled {
        info!(path = %worktree_path, "{}", skip_note);
        return Ok(None);
    }

    let (stdout, _, code) =
        run_local_git(worktree_path, &["rev-parse", "--git-path", "hooks"]).await?;
    if code != 0 {
        return Err(format!(
            "git rev-parse --git-path hooks failed (exit {})",
            code
        ));
    }
    let rel = stdout.trim();
    if rel.is_empty() {
        return Err("git rev-parse returned empty hooks path".to_string());
    }
    // `rel` is relative to the worktree CWD. Join manually rather than
    // depending on `std::path::PathBuf::is_absolute` behaviour across platforms.
    let hooks_dir = if std::path::Path::new(rel).is_absolute() {
        std::path::PathBuf::from(rel)
    } else {
        std::path::PathBuf::from(worktree_path).join(rel)
    };

    if let Err(e) = std::fs::create_dir_all(&hooks_dir) {
        return Err(format!("create_dir_all({:?}) failed: {}", hooks_dir, e));
    }

    let hook_path = hooks_dir.join("prepare-commit-msg");
    let script = build_script(&settings);
    if let Err(e) = std::fs::write(&hook_path, script) {
        return Err(format!("write {:?} failed: {}", hook_path, e));
    }

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if let Ok(meta) = std::fs::metadata(&hook_path) {
            let mut perms = meta.permissions();
            perms.set_mode(0o755);
            if let Err(e) = std::fs::set_permissions(&hook_path, perms) {
                warn!(path = ?hook_path, error = %e, "chmod +x on hook failed (non-fatal)");
            }
        }
    }

    // GP4: on Windows, the POSIX hook only runs if git can find an `sh`. Warn
    // (once, non-fatal) when none is discoverable so the silent no-op is visible.
    #[cfg(windows)]
    {
        let has_sh = std::env::var("PATH")
            .map(|p| posix_shell_on_path_with(&p, |x| x.exists()))
            .unwrap_or(false);
        if !has_sh {
            warn!(
                path = ?hook_path,
                "prepare-commit-msg hook installed but no POSIX shell (sh/bash) is on PATH — \
                 the auto-trailer hook will not run under vanilla Windows OpenSSH. Install Git \
                 for Windows (it bundles sh) to enable it."
            );
        }
    }

    Ok(Some(hook_path))
}

#[cfg(test)]
mod gp4_tests {
    use super::posix_shell_on_path_with;
    use std::path::Path;

    #[test]
    fn detects_sh_on_path() {
        let sep = if cfg!(windows) { ";" } else { ":" };
        let path = ["/usr/local/bin", "/opt/git/bin"].join(sep);
        // sh present only in the second dir.
        let exists = |p: &Path| {
            p == Path::new("/opt/git/bin").join("sh")
                || p == Path::new("/opt/git/bin").join("sh.exe")
        };
        assert!(posix_shell_on_path_with(&path, exists));
    }

    #[test]
    fn reports_missing_sh() {
        let sep = if cfg!(windows) { ";" } else { ":" };
        let path = ["/usr/local/bin", "/opt/git/bin"].join(sep);
        assert!(!posix_shell_on_path_with(&path, |_| false));
    }

    #[test]
    fn empty_path_has_no_shell() {
        // No directories to probe, so nothing is found even if `exists` says yes.
        assert!(!posix_shell_on_path_with("", |_| true));
    }
}

async fn install_prepare_commit_msg_hook(
    worktree_path: &str,
    attempt_id: &str,
    flight: &WorktreeFlight,
) -> Result<(), String> {
    // Flight metadata: prefer explicit values from the caller, fall
    // back to the legacy worktree-grandparent-name heuristic for the
    // flight id, and finally to `"unknown"`. Title defaults to empty.
    let flight_id = flight
        .flight_id
        .as_deref()
        .map(|s| s.to_string())
        .unwrap_or_else(|| {
            std::path::Path::new(worktree_path)
                .parent()
                .and_then(|p| p.parent())
                .and_then(|p| p.file_name())
                .and_then(|n| n.to_str())
                .map(|s| s.to_string())
                .unwrap_or_else(|| "unknown".to_string())
        });
    let flight_title = flight.flight_title.as_deref().unwrap_or("").to_string();

    let flight_id_safe = sanitize_trailer_value(&flight_id);
    let attempt_id_safe = sanitize_trailer_value(attempt_id);
    let flight_title_safe = sanitize_trailer_value(&flight_title);

    // Hook script. POSIX-sh; Git for Windows runs MSYS sh against the
    // shebang. Use a `case` rather than `grep -q` to keep the script
    // dependency-free. The trailer is injected into a single-quoted
    // `printf` arg so `$VAR` / backticks inside the trailer are literal. We
    // strip quotes from the trailer up front so the single-quoted literal
    // can't be broken out of.
    let installed = write_prepare_commit_msg_hook(
        worktree_path,
        "Auto-trailer disabled in settings; skipping hook install",
        |settings| {
            let trailer_line = sanitize_trailer_value(&render_trailer_format(
                &settings.auto_commit_trailer_format,
                &flight_id_safe,
                &attempt_id_safe,
                &flight_title_safe,
            ));
            format!(
                "#!/bin/sh\n\
                 # PacketBench auto-trailer — appended to commits made inside this worktree.\n\
                 # v0.8: installed by core/worktree.rs::install_prepare_commit_msg_hook.\n\
                 FILE=\"$1\"\n\
                 MSG=$(cat \"$FILE\")\n\
                 case \"$MSG\" in\n\
                   *\"Run-By: PacketBench\"*) exit 0 ;;\n\
                 esac\n\
                 printf '\\n%s\\n' '{trailer}' >> \"$FILE\"\n",
                trailer = trailer_line,
            )
        },
    )
    .await?;

    // TODO(v0.8-16): consider also dropping a `prepare-commit-msg.cmd` shim for
    // environments where the MSYS sh shim is missing from PATH. The native Git
    // for Windows install always ships it, so this is a low-priority follow-up.

    if let Some(hook_path) = installed {
        info!(
            path = ?hook_path,
            flight = %flight_id_safe,
            attempt = %attempt_id_safe,
            "Installed prepare-commit-msg auto-trailer hook",
        );
    }
    Ok(())
}

/// v0.8.5: write a `prepare-commit-msg` hook inside an Issue-bound
/// worktree that appends two trailers to every commit message:
///
///   `Fixes #{issue_number}`
///   `Run-By: PacketBench issue I-{issue_id}`
///
/// Idempotent: if the commit message already contains either trailer
/// (e.g. the user typed `Fixes #N` themselves or a previous commit was
/// being amended), the hook detects it via a POSIX `case` match and
/// skips writing the duplicate. This means a user who manually wrote
/// `Fixes #42` will see exactly one `Fixes #42` line, not two.
///
/// Behaviour respects `OrchestratorSettings.auto_commit_trailer_enabled`
/// — turning the toggle off skips hook installation entirely. The
/// trailer format is fixed (not `auto_commit_trailer_format`) because
/// the v0.8.5 close-loop watcher needs to parse a stable `Fixes #N`
/// pattern; allowing arbitrary format strings would break the watcher.
async fn install_prepare_commit_msg_hook_for_issue(
    worktree_path: &str,
    issue: &WorktreeIssue,
) -> Result<(), String> {
    let issue_id_safe = sanitize_trailer_value(&issue.issue_id);
    let issue_number = issue.issue_number;

    // Hook script. Two idempotency checks:
    //   - skip the `Fixes #N` write if the message already contains it
    //     (word-boundary anchored via grep -E so `Fixes #4` doesn't match
    //     a pre-existing `Fixes #42`)
    //   - skip the `Run-By` write if any existing `Run-By: PacketBench` line
    //     is present (so amended commits don't stack lineage trailers)
    //
    // Single-quoted printf literals — `$` / backticks inside the sanitized
    // values are already neutralised by sanitize_trailer_value().
    let installed = write_prepare_commit_msg_hook(
        worktree_path,
        "Auto-trailer disabled in settings; skipping issue hook install",
        |_settings| {
            let fixes_trailer = format!("Fixes #{}", issue_number);
            let run_by_trailer = format!("Run-By: PacketBench issue I-{}", issue_id_safe);
            format!(
                "#!/bin/sh\n\
                 # PacketBench auto-trailer (issue v0.8.5) — appended to commits made inside this issue worktree.\n\
                 FILE=\"$1\"\n\
                 MSG=$(cat \"$FILE\")\n\
                 if ! printf '%s' \"$MSG\" | grep -Eq '(^|[^0-9])Fixes #{number}([^0-9]|$)'; then\n\
                   printf '\\n%s\\n' '{fixes}' >> \"$FILE\"\n\
                 fi\n\
                 case \"$MSG\" in\n\
                   *\"Run-By: PacketBench\"*) ;;\n\
                   *) printf '%s\\n' '{run_by}' >> \"$FILE\" ;;\n\
                 esac\n",
                number = issue_number,
                fixes = fixes_trailer,
                run_by = run_by_trailer,
            )
        },
    )
    .await?;

    if let Some(hook_path) = installed {
        info!(
            path = ?hook_path,
            issue = %issue_id_safe,
            number = issue_number,
            "Installed prepare-commit-msg auto-trailer hook (issue)",
        );
    }
    Ok(())
}

/// Outcome of a best-effort worktree teardown.
///
/// Teardown failures are **data, not errors**: the caller (attempt cancel,
/// terminal-status teardown, flight delete) must still complete its state
/// transition, but the frontend has to be able to tell the user that a git
/// worktree is still sitting on disk. Before this existed, every removal
/// failure was `warn!`-logged and swallowed, so a wedged worktree looked
/// exactly like a clean delete.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeCleanupOutcome {
    /// The worktree we tried to remove — named so the user can go and finish
    /// the job by hand when we could not.
    pub worktree_path: String,
    /// True when nothing is left on disk (removed now, or already absent).
    pub removed: bool,
    /// The branch the worktree had checked out, when the caller knows it.
    pub branch: Option<String>,
    /// True when `branch` was deleted as part of this teardown.
    pub branch_deleted: bool,
    /// Why the branch survived. Set only when branch deletion was requested
    /// and did not happen (typically: it still holds unmerged commits).
    pub branch_retained: Option<String>,
    /// `git status --porcelain` lines observed immediately before a forced
    /// removal — i.e. the uncommitted work this teardown destroyed. Populated
    /// by the integration-worktree paths; attempt worktrees are dirty-checked
    /// by the frontend before the delete is confirmed.
    pub dirty_paths: Vec<String>,
    /// Non-fatal failure message. Present ⇒ `removed` is false.
    pub error: Option<String>,
    /// The removal could not even be attempted here (SSH server record is
    /// gone), so the worktree is still on the remote host.
    pub deferred: bool,
}

impl WorktreeCleanupOutcome {
    pub fn for_path(worktree_path: impl Into<String>) -> Self {
        Self {
            worktree_path: worktree_path.into(),
            ..Default::default()
        }
    }

    /// True when the caller should report this teardown to the user.
    pub fn needs_attention(&self) -> bool {
        self.error.is_some() || self.deferred || !self.removed
    }
}

/// Remove a local git worktree. Idempotent — missing worktree is not an error.
///
/// When `delete_branch` is true, the `pkt/<attempt_id>` branch is additionally
/// force-deleted (`git branch -D`) AFTER the worktree dir is gone — git refuses
/// to delete a branch that is still checked out in a linked worktree, so order
/// matters. Branch deletion is best-effort (a missing/absent branch is not an
/// error): the caller — currently only the conversation Discard path — treats
/// the dir removal as the operation that must succeed. Flight cleanup passes
/// false to preserve its prior behavior (worktree removed, branch retained).
pub async fn remove_local_worktree(
    base: &str,
    attempt_id: &str,
    delete_branch: bool,
) -> Result<(), String> {
    let path = worktree_path(base, attempt_id)?;
    if !std::path::Path::new(&path).exists() {
        return Ok(());
    }
    let (_, stderr, code) = run_local_git(base, &["worktree", "remove", "--force", &path]).await?;
    if code != 0 {
        warn!(path = %path, stderr = %stderr.trim(), "git worktree remove failed");
        return Err(format!(
            "git worktree remove failed (exit {}): {}",
            code,
            stderr.trim()
        ));
    }
    if delete_branch {
        let branch = branch_name(attempt_id);
        match run_local_git(base, &["branch", "-D", &branch]).await {
            Ok((_, stderr, code)) if code != 0 => {
                // Non-fatal: the worktree is already gone; a leftover branch is
                // a cleanup miss, not a failure of the discard itself.
                warn!(branch = %branch, stderr = %stderr.trim(), "git branch -D failed after worktree remove (non-fatal)");
            }
            Ok(_) => {}
            Err(e) => {
                warn!(branch = %branch, error = %e, "git branch -D errored after worktree remove (non-fatal)");
            }
        }
    }
    Ok(())
}

/// Git's non-force dirty check protects edits racing an accepted result.
pub async fn remove_attempt_worktree_safely(
    base: &str,
    attempt_id: &str,
    ssh: Option<&SshConfig>,
) -> Result<(), String> {
    let path = worktree_path(base, attempt_id)?;
    let (output, code) = if let Some(config) = ssh {
        ssh_git(config, base, &["worktree", "remove", "--", &path]).await?
    } else {
        if !std::path::Path::new(&path).exists() {
            return Ok(());
        }
        let (stdout, stderr, code) =
            run_local_git(base, &["worktree", "remove", "--", &path]).await?;
        (format!("{stdout}{stderr}"), code)
    };
    if code != 0 {
        return Err(format!(
            "Worktree retained: non-destructive cleanup refused ({code}): {}",
            output.trim()
        ));
    }
    Ok(())
}

// --- Remote (SSH) ---

async fn ssh_git(cfg: &SshConfig, base: &str, args: &[&str]) -> Result<(String, i32), String> {
    let joined = args
        .iter()
        .map(|a| sh_quote(a))
        .collect::<Vec<_>>()
        .join(" ");
    let cmd = format!("cd {} && git {}", sh_quote(base), joined);
    let output = crate::core::tool_runtime_ssh::ssh_run_for_worktree(cfg, &cmd).await?;
    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).to_string();
    let combined = if stderr.is_empty() {
        stdout
    } else {
        format!("{}\n{}", stdout, stderr)
    };
    Ok((combined, output.status.code().unwrap_or(-1)))
}

/// Run a read-only git command for command-layer evidence collection. Arguments
/// are individually shell-quoted by `ssh_git`; callers still receive the exit
/// code so a missing base ref can be surfaced instead of silently weakening a
/// review.
pub(crate) async fn ssh_git_read(
    cfg: &SshConfig,
    base: &str,
    args: &[&str],
) -> Result<(String, i32), String> {
    ssh_git(cfg, base, args).await
}

#[derive(Debug, Clone)]
pub struct IntegrationBranchState {
    pub branch: String,
    pub base_branch: String,
    pub base_sha: String,
    pub head_sha: String,
    pub worktree_path: String,
}

#[derive(Debug, Clone)]
pub struct IntegrationMergeState {
    pub head_sha: String,
    pub conflict_files: Vec<String>,
}

fn integration_branch_name(flight_id: &str) -> Result<String, String> {
    validate_worktree_component(flight_id)?;
    Ok(format!("packetbench/flight/{}", flight_id))
}

fn git_stdout(cwd: &str, args: &[&str]) -> Result<String, String> {
    let output = std::process::Command::new("git")
        .args(args)
        .current_dir(cwd)
        .output()
        .map_err(|e| format!("Failed to run git: {}", e))?;
    if !output.status.success() {
        return Err(format!(
            "git {} failed (exit {}): {}",
            args.first().copied().unwrap_or("command"),
            output.status.code().unwrap_or(-1),
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

pub fn prepare_local_integration_branch(
    base: &str,
    flight_id: &str,
    base_branch: &str,
) -> Result<IntegrationBranchState, String> {
    let branch = integration_branch_name(flight_id)?;
    let base_sha = git_stdout(base, &["rev-parse", &format!("{}^{{commit}}", base_branch)])?;
    let path = std::path::Path::new(base)
        .join(".pkt-flight-integrations")
        .join(flight_id);
    if path.exists() {
        let path_str = path.to_string_lossy().to_string();
        let actual = git_stdout(&path_str, &["rev-parse", "--abbrev-ref", "HEAD"])?;
        if actual != branch {
            return Err(format!(
                "Integration worktree ref mismatch: expected '{}', found '{}'.",
                branch, actual
            ));
        }
        let head_sha = git_stdout(&path_str, &["rev-parse", "HEAD"])?;
        return Ok(IntegrationBranchState {
            branch,
            base_branch: base_branch.to_string(),
            base_sha,
            head_sha,
            worktree_path: path_str,
        });
    }
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create integration directory: {}", e))?;
    }
    let path_str = path.to_string_lossy().to_string();
    let branch_exists = std::process::Command::new("git")
        .args([
            "show-ref",
            "--verify",
            "--quiet",
            &format!("refs/heads/{}", branch),
        ])
        .current_dir(base)
        .status()
        .map_err(|e| format!("Failed to inspect integration branch: {}", e))?
        .success();
    if branch_exists {
        git_stdout(base, &["worktree", "add", &path_str, &branch])?;
    } else {
        git_stdout(
            base,
            &["worktree", "add", "-b", &branch, &path_str, base_branch],
        )?;
    }
    let head_sha = git_stdout(&path_str, &["rev-parse", "HEAD"])?;
    Ok(IntegrationBranchState {
        branch,
        base_branch: base_branch.to_string(),
        base_sha,
        head_sha,
        worktree_path: path_str,
    })
}

pub async fn prepare_remote_integration_branch(
    cfg: &SshConfig,
    base: &str,
    flight_id: &str,
    base_branch: &str,
) -> Result<IntegrationBranchState, String> {
    let branch = integration_branch_name(flight_id)?;
    let verify = format!("{}^{{commit}}", base_branch);
    let (base_sha, base_code) = ssh_git(cfg, base, &["rev-parse", &verify]).await?;
    if base_code != 0 {
        return Err(format!(
            "Remote integration base ref '{}' is invalid: {}",
            base_branch,
            base_sha.trim()
        ));
    }
    let path = format!(
        "{}/.pkt-flight-integrations/{}",
        base.trim_end_matches('/'),
        flight_id
    );
    let parent = format!("{}/.pkt-flight-integrations", base.trim_end_matches('/'));
    let mkdir = format!("mkdir -p -- {}", sh_quote(&parent));
    let mkdir_output = crate::core::tool_runtime_ssh::ssh_run_for_worktree(cfg, &mkdir).await?;
    if !mkdir_output.status.success() {
        return Err(format!(
            "Failed to create remote integration directory: {}",
            String::from_utf8_lossy(&mkdir_output.stderr).trim()
        ));
    }

    let (actual, actual_code) = ssh_git(cfg, &path, &["rev-parse", "--abbrev-ref", "HEAD"]).await?;
    if actual_code == 0 {
        if actual.trim() != branch {
            return Err(format!(
                "Remote integration worktree ref mismatch: expected '{}', found '{}'.",
                branch,
                actual.trim()
            ));
        }
    } else {
        let ref_name = format!("refs/heads/{}", branch);
        let (_, branch_code) =
            ssh_git(cfg, base, &["show-ref", "--verify", "--quiet", &ref_name]).await?;
        let (out, code) = if branch_code == 0 {
            ssh_git(cfg, base, &["worktree", "add", &path, &branch]).await?
        } else {
            ssh_git(
                cfg,
                base,
                &["worktree", "add", "-b", &branch, &path, base_branch],
            )
            .await?
        };
        if code != 0 {
            return Err(format!(
                "Remote integration worktree creation failed: {}",
                out.trim()
            ));
        }
    }
    let (head_sha, head_code) = ssh_git(cfg, &path, &["rev-parse", "HEAD"]).await?;
    if head_code != 0 {
        return Err(format!(
            "Remote integration HEAD lookup failed: {}",
            head_sha.trim()
        ));
    }
    Ok(IntegrationBranchState {
        branch,
        base_branch: base_branch.to_string(),
        base_sha: base_sha.trim().to_string(),
        head_sha: head_sha.trim().to_string(),
        worktree_path: path,
    })
}

pub fn integrate_local_attempt(
    integration_path: &str,
    integration_branch: &str,
    attempt_path: &str,
    attempt_branch: &str,
) -> Result<IntegrationMergeState, String> {
    let actual = git_stdout(integration_path, &["rev-parse", "--abbrev-ref", "HEAD"])?;
    if actual != integration_branch {
        return Err(format!(
            "Integration ref mismatch: expected '{}', found '{}'.",
            integration_branch, actual
        ));
    }
    if !git_stdout(attempt_path, &["status", "--porcelain"])?.is_empty() {
        return Err("Attempt worktree has uncommitted changes. Ask the builder to commit before integration.".to_string());
    }
    if !git_stdout(integration_path, &["status", "--porcelain"])?.is_empty() {
        return Err("Integration worktree has uncommitted changes. Commit or discard them in the integration worktree before integrating.".to_string());
    }
    let output = std::process::Command::new("git")
        .args(["merge", "--no-ff", "--no-edit", attempt_branch])
        .current_dir(integration_path)
        .output()
        .map_err(|e| format!("Failed to merge attempt: {}", e))?;
    if !output.status.success() {
        let conflicts = git_stdout(
            integration_path,
            &["diff", "--name-only", "--diff-filter=U"],
        )
        .unwrap_or_default()
        .lines()
        .map(str::to_string)
        .collect::<Vec<_>>();
        let _ = std::process::Command::new("git")
            .args(["merge", "--abort"])
            .current_dir(integration_path)
            .output();
        if conflicts.is_empty() {
            // Non-conflict failure (missing branch ref, overwrite refusal, ...):
            // returning Ok here would let the caller mark the task integrated
            // even though nothing merged. Fail closed with git's reason.
            let stderr = String::from_utf8_lossy(&output.stderr);
            let stdout = String::from_utf8_lossy(&output.stdout);
            let detail = if stderr.trim().is_empty() {
                stdout.trim().to_string()
            } else {
                stderr.trim().to_string()
            };
            return Err(format!(
                "Attempt merge failed without producing conflicts: {}",
                detail
            ));
        }
        return Ok(IntegrationMergeState {
            head_sha: git_stdout(integration_path, &["rev-parse", "HEAD"])?,
            conflict_files: conflicts,
        });
    }
    Ok(IntegrationMergeState {
        head_sha: git_stdout(integration_path, &["rev-parse", "HEAD"])?,
        conflict_files: Vec::new(),
    })
}

pub async fn integrate_remote_attempt(
    cfg: &SshConfig,
    integration_path: &str,
    integration_branch: &str,
    attempt_path: &str,
    attempt_branch: &str,
) -> Result<IntegrationMergeState, String> {
    let (actual, code) = ssh_git(
        cfg,
        integration_path,
        &["rev-parse", "--abbrev-ref", "HEAD"],
    )
    .await?;
    if code != 0 || actual.trim() != integration_branch {
        return Err(format!(
            "Remote integration ref mismatch: expected '{}', found '{}'.",
            integration_branch,
            actual.trim()
        ));
    }
    let (dirty, dirty_code) = ssh_git(cfg, attempt_path, &["status", "--porcelain"]).await?;
    if dirty_code != 0 || !dirty.trim().is_empty() {
        return Err("Remote attempt worktree has uncommitted changes. Ask the builder to commit before integration.".to_string());
    }
    let (int_dirty, int_dirty_code) =
        ssh_git(cfg, integration_path, &["status", "--porcelain"]).await?;
    if int_dirty_code != 0 || !int_dirty.trim().is_empty() {
        return Err(
            "Remote integration worktree has uncommitted changes. Commit or discard them before integrating.".to_string(),
        );
    }
    let (merge, merge_code) = ssh_git(
        cfg,
        integration_path,
        &["merge", "--no-ff", "--no-edit", attempt_branch],
    )
    .await?;
    if merge_code != 0 {
        let (conflicts_raw, _) = ssh_git(
            cfg,
            integration_path,
            &["diff", "--name-only", "--diff-filter=U"],
        )
        .await?;
        let _ = ssh_git(cfg, integration_path, &["merge", "--abort"]).await;
        let conflicts: Vec<String> = conflicts_raw
            .lines()
            .map(str::trim)
            .filter(|path| !path.is_empty())
            .map(str::to_string)
            .collect();
        if conflicts.is_empty() {
            // Non-conflict failure: returning Ok would let the caller mark the
            // task integrated even though nothing merged. Fail closed with
            // git's reason (`merge` carries combined stdout+stderr).
            return Err(format!(
                "Remote attempt merge failed without producing conflicts: {}",
                merge.trim()
            ));
        }
        let (head, _) = ssh_git(cfg, integration_path, &["rev-parse", "HEAD"]).await?;
        return Ok(IntegrationMergeState {
            head_sha: head.trim().to_string(),
            conflict_files: conflicts,
        });
    }
    let (head, head_code) = ssh_git(cfg, integration_path, &["rev-parse", "HEAD"]).await?;
    if head_code != 0 {
        return Err(format!(
            "Remote integration HEAD lookup failed: {}",
            merge.trim()
        ));
    }
    Ok(IntegrationMergeState {
        head_sha: head.trim().to_string(),
        conflict_files: Vec::new(),
    })
}

fn root_is_clean_for_integration(status: &str) -> bool {
    status.lines().all(|line| {
        let path = line.get(3..).unwrap_or("").replace('\\', "/");
        path.starts_with(".pkt-worktrees/") || path.starts_with(".pkt-flight-integrations/")
    })
}

pub fn land_local_integration_branch(
    base: &str,
    base_branch: &str,
    integration_branch: &str,
) -> Result<String, String> {
    let actual = git_stdout(base, &["rev-parse", "--abbrev-ref", "HEAD"])?;
    if actual != base_branch {
        return Err(format!(
            "Landing requires the base checkout on '{}'; it is currently on '{}'.",
            base_branch, actual
        ));
    }
    let status = git_stdout(base, &["status", "--porcelain"])?;
    if !root_is_clean_for_integration(&status) {
        return Err("Landing requires a clean base working tree.".to_string());
    }
    if let Err(err) = git_stdout(base, &["merge", "--no-ff", "--no-edit", integration_branch]) {
        // The merge runs in the user's primary checkout: never leave it
        // mid-merge (MERGE_HEAD + conflict markers). Best-effort abort,
        // mirroring land_remote_integration_branch.
        let _ = git_stdout(base, &["merge", "--abort"]);
        return Err(format!("Flight landing failed: {}", err));
    }
    git_stdout(base, &["rev-parse", "HEAD"])
}

/// Land an independent accepted attempt into its saved remote base checkout.
/// The command driver is also exercised locally by hermetic Git fixtures.
pub async fn land_remote_attempt_at_ref(
    cfg: &SshConfig,
    base: &str,
    base_branch: &str,
    attempt_branch: &str,
    expected_sha: &str,
    squash: bool,
) -> Result<super::git::MergeBranchOutcome, String> {
    if cfg
        .host_fingerprint
        .as_ref()
        .is_none_or(|fingerprint| fingerprint.trim().is_empty())
    {
        return Err("Pin the saved SSH server's host key before landing.".into());
    }
    super::flight_landing::merge_at_ref(
        |args| {
            let cfg = cfg.clone();
            let base = base.to_string();
            async move {
                let refs: Vec<_> = args.iter().map(String::as_str).collect();
                ssh_git(&cfg, &base, &refs).await
            }
        },
        base_branch,
        attempt_branch,
        expected_sha,
        squash,
    )
    .await
}

pub async fn land_remote_integration_branch(
    cfg: &SshConfig,
    base: &str,
    base_branch: &str,
    integration_branch: &str,
) -> Result<String, String> {
    let (actual, actual_code) = ssh_git(cfg, base, &["rev-parse", "--abbrev-ref", "HEAD"]).await?;
    if actual_code != 0 || actual.trim() != base_branch {
        return Err(format!(
            "Remote landing requires the base checkout on '{}'; it is currently on '{}'.",
            base_branch,
            actual.trim()
        ));
    }
    let (status, status_code) = ssh_git(cfg, base, &["status", "--porcelain"]).await?;
    if status_code != 0 || !root_is_clean_for_integration(&status) {
        return Err("Remote landing requires a clean base working tree.".to_string());
    }
    let (merge, merge_code) = ssh_git(
        cfg,
        base,
        &["merge", "--no-ff", "--no-edit", integration_branch],
    )
    .await?;
    if merge_code != 0 {
        let _ = ssh_git(cfg, base, &["merge", "--abort"]).await;
        return Err(format!("Remote Flight landing failed: {}", merge.trim()));
    }
    let (head, head_code) = ssh_git(cfg, base, &["rev-parse", "HEAD"]).await?;
    if head_code != 0 {
        return Err(format!(
            "Remote landing HEAD lookup failed: {}",
            head.trim()
        ));
    }
    Ok(head.trim().to_string())
}

/// Non-empty `git status --porcelain` lines inside a local worktree. Never
/// fails the teardown: an unreadable tree reports no dirt but is not treated as
/// verified-clean by the caller either (the frontend's pre-delete probe is what
/// asks the user for consent).
async fn local_worktree_dirt(path: &str) -> Vec<String> {
    match run_local_git(path, &["status", "--porcelain"]).await {
        Ok((stdout, _, 0)) => stdout
            .lines()
            .map(|line| line.trim_end().to_string())
            .filter(|line| !line.is_empty())
            .collect(),
        _ => Vec::new(),
    }
}

/// Remove a Flight's cooperative integration worktree. Idempotent.
///
/// Symmetric with `remove_local_worktree`, but flight-keyed rather than
/// attempt-keyed: nothing else could reach `<base>/.pkt-flight-integrations/<flight_id>`,
/// so deleting a cooperative Flight used to abandon it.
///
/// Semantics:
/// - The removal is forced (`--force`), matching attempt teardown. Any
///   uncommitted work found immediately beforehand is reported back in
///   `dirty_paths` so the destruction is never silent.
/// - Removal failure is returned as data (`error` + `removed: false`), not an
///   `Err` — the caller is tearing a Flight down and must finish.
/// - Branch deletion (when `delete_branch`) uses the SAFE `git branch -d`.
///   The integration branch can hold merged-but-unlanded attempt work, and
///   unlike an attempt branch it is the only ref to it; `-D` would make that
///   unreachable. A refusal is reported in `branch_retained`, not an error.
pub async fn remove_local_integration_worktree(
    base: &str,
    flight_id: &str,
    delete_branch: bool,
) -> Result<WorktreeCleanupOutcome, String> {
    let path = integration_worktree_path(base, flight_id)?;
    let branch = integration_branch_name(flight_id)?;
    let mut outcome = WorktreeCleanupOutcome {
        branch: Some(branch.clone()),
        ..WorktreeCleanupOutcome::for_path(path.clone())
    };

    if !std::path::Path::new(&path).exists() {
        outcome.removed = true;
    } else {
        outcome.dirty_paths = local_worktree_dirt(&path).await;
        let (_, stderr, code) =
            run_local_git(base, &["worktree", "remove", "--force", &path]).await?;
        if code == 0 {
            outcome.removed = true;
        } else {
            warn!(path = %path, stderr = %stderr.trim(), "git worktree remove failed (integration)");
            outcome.error = Some(format!(
                "git worktree remove failed (exit {}): {}",
                code,
                stderr.trim()
            ));
        }
    }

    if delete_branch && outcome.removed {
        match run_local_git(base, &["branch", "-d", &branch]).await {
            Ok((_, _, 0)) => outcome.branch_deleted = true,
            Ok((_, stderr, code)) => {
                warn!(branch = %branch, stderr = %stderr.trim(), "integration branch retained");
                outcome.branch_retained = Some(format!(
                    "branch '{}' was kept (git branch -d exit {}): {}",
                    branch,
                    code,
                    stderr.trim()
                ));
            }
            Err(e) => {
                outcome.branch_retained = Some(format!("branch '{}' was kept: {}", branch, e));
            }
        }
    }

    Ok(outcome)
}

/// Remote twin of `remove_local_integration_worktree`. Same non-fatal
/// reporting contract; `not a working tree` is treated as already-gone.
pub async fn remove_remote_integration_worktree(
    cfg: &SshConfig,
    base: &str,
    flight_id: &str,
    delete_branch: bool,
) -> Result<WorktreeCleanupOutcome, String> {
    let path = integration_worktree_path(base, flight_id)?;
    let branch = integration_branch_name(flight_id)?;
    let mut outcome = WorktreeCleanupOutcome {
        branch: Some(branch.clone()),
        ..WorktreeCleanupOutcome::for_path(path.clone())
    };

    if let Ok((status, 0)) = ssh_git(cfg, &path, &["status", "--porcelain"]).await {
        outcome.dirty_paths = status
            .lines()
            .map(|line| line.trim_end().to_string())
            .filter(|line| !line.is_empty())
            .collect();
    }

    let (combined, code) = ssh_git(cfg, base, &["worktree", "remove", "--force", &path]).await?;
    if code == 0 || combined.contains("not a working tree") {
        outcome.removed = true;
    } else {
        warn!(path = %path, output = %combined.trim(), "remote git worktree remove failed (integration)");
        outcome.error = Some(format!(
            "remote git worktree remove failed (exit {}): {}",
            code,
            combined.trim()
        ));
    }

    if delete_branch && outcome.removed {
        match ssh_git(cfg, base, &["branch", "-d", &branch]).await {
            Ok((_, 0)) => outcome.branch_deleted = true,
            Ok((out, code)) => {
                outcome.branch_retained = Some(format!(
                    "branch '{}' was kept (git branch -d exit {}): {}",
                    branch,
                    code,
                    out.trim()
                ));
            }
            Err(e) => {
                outcome.branch_retained = Some(format!("branch '{}' was kept: {}", branch, e));
            }
        }
    }

    Ok(outcome)
}

/// Create a remote git worktree. Idempotent.
pub async fn create_remote_worktree(
    cfg: &SshConfig,
    base: &str,
    attempt_id: &str,
    base_branch: &str,
) -> Result<String, String> {
    let path = worktree_path(base, attempt_id)?;
    let branch = branch_name(attempt_id);

    let (_, code) = ssh_git(cfg, base, &["rev-parse", "--git-dir"]).await?;
    if code != 0 {
        return Err("Remote base path is not a git repo".to_string());
    }

    // Use `[ -d ... ]` to short-circuit if the worktree already exists.
    let check = format!("if [ -d {} ]; then echo EXISTS; fi", sh_quote(&path),);
    let existing = crate::core::tool_runtime_ssh::ssh_run_for_worktree(cfg, &check).await?;
    if String::from_utf8_lossy(&existing.stdout).contains("EXISTS") {
        info!(path = %path, "Remote worktree already exists, reusing");
        return Ok(path);
    }

    let (combined, code) = ssh_git(
        cfg,
        base,
        &["worktree", "add", "-b", &branch, &path, base_branch],
    )
    .await?;
    if code != 0 {
        return Err(format!(
            "remote git worktree add failed (exit {}): {}",
            code,
            combined.trim()
        ));
    }
    info!(path = %path, branch = %branch, "Created remote worktree");
    Ok(path)
}

/// Phase 3.2: structured result returned by `clone_repo_remote_ssh`. The
/// `default_branch` is whatever `git -C <dest> rev-parse --abbrev-ref HEAD`
/// reports immediately after the clone — usually `main` or `master`.
#[derive(Debug, Clone, serde::Serialize)]
pub struct RemoteCloneResult {
    pub remote_path: String,
    pub default_branch: String,
}

/// Phase 3.2: validate user-supplied tokens against a tight allowlist so
/// nothing dangerous reaches the remote shell. `sh_quote` already prevents
/// argument breakout, but rejecting obvious sentinels here surfaces clearer
/// errors and gives defence-in-depth against future refactors that might
/// stop quoting somewhere downstream.
fn validate_clone_branch(name: &str) -> Result<(), String> {
    if name.is_empty() {
        return Err("Branch name cannot be empty".to_string());
    }
    if name.starts_with('-') {
        return Err("Branch name cannot start with '-'".to_string());
    }
    // Reject the usual shell + ref-format troublemakers. Spaces / control
    // chars / shell metacharacters / git's own forbidden ref tokens.
    for ch in name.chars() {
        if ch.is_control() {
            return Err("Branch name contains control characters".to_string());
        }
        if matches!(
            ch,
            ' ' | '\t'
                | '~'
                | '^'
                | ':'
                | '?'
                | '*'
                | '['
                | '\\'
                | '"'
                | '\''
                | '`'
                | '$'
                | ';'
                | '|'
                | '&'
                | '<'
                | '>'
                | '('
                | ')'
                | '{'
                | '}'
        ) {
            return Err(format!("Branch name contains invalid character '{}'", ch));
        }
    }
    if name.contains("..") || name.ends_with('/') || name.ends_with(".lock") {
        return Err("Branch name has invalid form".to_string());
    }
    Ok(())
}

fn validate_clone_dest_path(path: &str) -> Result<(), String> {
    if path.is_empty() {
        return Err("Destination path cannot be empty".to_string());
    }
    if path.starts_with('-') {
        return Err("Destination path cannot start with '-'".to_string());
    }
    for ch in path.chars() {
        if ch.is_control() {
            return Err("Destination path contains control characters".to_string());
        }
        if matches!(ch, '\0' | '\n' | '\r' | '\'' | '"' | '`' | '$') {
            return Err(format!(
                "Destination path contains forbidden character '{}'",
                ch.escape_default()
            ));
        }
    }
    Ok(())
}

fn validate_clone_repo_url(url: &str) -> Result<(), String> {
    if url.is_empty() {
        return Err("Repository URL cannot be empty".to_string());
    }
    if url.starts_with('-') {
        return Err("Repository URL cannot start with '-'".to_string());
    }
    for ch in url.chars() {
        if ch.is_control() {
            return Err("Repository URL contains control characters".to_string());
        }
        if matches!(ch, '\0' | '\n' | '\r' | '\'' | '"' | '`' | '$') {
            return Err(format!(
                "Repository URL contains forbidden character '{}'",
                ch.escape_default()
            ));
        }
    }
    Ok(())
}

/// Phase 3.2: clone a remote repo into `dest_path` on the SSH host. Returns
/// the absolute path on the remote plus the freshly-cloned default branch.
///
/// Security:
/// - All arguments are POSIX single-quoted via `sh_quote`.
/// - Inputs go through allowlist validators (`validate_clone_*`) so the
///   model/UI cannot smuggle `-`-prefixed flags, control characters, or
///   shell metacharacters.
/// - `git clone -- <repo_url> <dest_path>` uses the `--` separator so the
///   positional args can never be re-interpreted as flags (e.g. an attacker
///   cannot inject `--upload-pack=<malicious>` even if the prefix check were
///   somehow bypassed).
/// - Timeout: 10 minutes (`REMOTE_CLONE_TIMEOUT_SECS`).
pub async fn clone_repo_remote_ssh(
    cfg: &SshConfig,
    repo_url: &str,
    dest_path: &str,
    branch: Option<&str>,
) -> Result<RemoteCloneResult, String> {
    validate_clone_repo_url(repo_url)?;
    validate_clone_dest_path(dest_path)?;
    if let Some(b) = branch {
        validate_clone_branch(b)?;
    }

    // Build: git clone [--branch <branch>] -- <repo_url> <dest_path>
    let mut argv: Vec<String> = vec!["clone".into()];
    if let Some(b) = branch {
        argv.push("--branch".into());
        argv.push(b.to_string());
    }
    argv.push("--".into());
    argv.push(repo_url.to_string());
    argv.push(dest_path.to_string());

    let quoted = argv
        .iter()
        .map(|a| sh_quote(a))
        .collect::<Vec<_>>()
        .join(" ");
    let cmd = format!("git {}", quoted);

    info!(
        host = %cfg.host,
        dest = %dest_path,
        "Starting remote git clone (timeout {}s)",
        REMOTE_CLONE_TIMEOUT_SECS,
    );

    let output =
        crate::core::tool_runtime_ssh::ssh_run_with_timeout(cfg, &cmd, REMOTE_CLONE_TIMEOUT_SECS)
            .await?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
        let combined = if stderr.is_empty() { stdout } else { stderr };
        return Err(format!(
            "git clone failed (exit {}): {}",
            output.status.code().unwrap_or(-1),
            combined
        ));
    }

    // Resolve the default branch from the freshly-cloned repo so the
    // workspace knows what HEAD ended up on.
    let head_cmd = format!(
        "git -C {dest} rev-parse --abbrev-ref HEAD",
        dest = sh_quote(dest_path)
    );
    let head_out = crate::core::tool_runtime_ssh::ssh_run_for_worktree(cfg, &head_cmd).await?;
    let default_branch = if head_out.status.success() {
        String::from_utf8_lossy(&head_out.stdout).trim().to_string()
    } else {
        // Non-fatal — clone itself succeeded. Fall back to whatever the
        // user asked for, or a conventional default.
        branch.map(str::to_string).unwrap_or_else(|| "main".into())
    };

    info!(
        host = %cfg.host,
        dest = %dest_path,
        branch = %default_branch,
        "Remote git clone succeeded",
    );
    Ok(RemoteCloneResult {
        remote_path: dest_path.to_string(),
        default_branch,
    })
}

/// Phase 3.3: classification of a remote path the dashboard might try to
/// inspect. Lets the frontend distinguish "host unreachable" from "path is
/// not a git repo" so it can show the right message.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RemoteRepoState {
    /// `<remote_path>/.git` (or equivalent) exists.
    GitRepo,
    /// SSH succeeded but the directory is not inside a git working tree.
    NotARepo,
}

/// Run `git -C <remote_path> rev-parse --is-inside-work-tree`. Returns the
/// classification, or an error if the SSH connection itself failed.
async fn ssh_classify_repo(cfg: &SshConfig, remote_path: &str) -> Result<RemoteRepoState, String> {
    let cmd = format!(
        "git -C {p} rev-parse --is-inside-work-tree 2>/dev/null",
        p = sh_quote(remote_path)
    );
    let output = crate::core::tool_runtime_ssh::ssh_run_for_worktree(cfg, &cmd).await?;
    if output.status.success() {
        let stdout = String::from_utf8_lossy(&output.stdout);
        if stdout.trim() == "true" {
            return Ok(RemoteRepoState::GitRepo);
        }
    }
    Ok(RemoteRepoState::NotARepo)
}

/// Phase 3.3: read `git status --short` on the remote and return the raw
/// porcelain output (no trailing newline). Frontend parses the same way it
/// parses the local `get_git_status` output.
pub async fn ssh_get_status(cfg: &SshConfig, remote_path: &str) -> Result<String, String> {
    match ssh_classify_repo(cfg, remote_path).await? {
        RemoteRepoState::NotARepo => {
            return Err(format!(
                "Remote path '{}' is not inside a git repository",
                remote_path
            ));
        }
        RemoteRepoState::GitRepo => {}
    }
    let cmd = format!("git -C {p} status --short", p = sh_quote(remote_path));
    let output = crate::core::tool_runtime_ssh::ssh_run_for_worktree(cfg, &cmd).await?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(format!(
            "git status failed (exit {}): {}",
            output.status.code().unwrap_or(-1),
            stderr
        ));
    }
    Ok(String::from_utf8_lossy(&output.stdout).to_string())
}

/// Phase 3.3: read the current branch (`rev-parse --abbrev-ref HEAD`) on
/// the remote.
pub async fn ssh_get_branch(cfg: &SshConfig, remote_path: &str) -> Result<String, String> {
    match ssh_classify_repo(cfg, remote_path).await? {
        RemoteRepoState::NotARepo => {
            return Err(format!(
                "Remote path '{}' is not inside a git repository",
                remote_path
            ));
        }
        RemoteRepoState::GitRepo => {}
    }
    let cmd = format!(
        "git -C {p} rev-parse --abbrev-ref HEAD",
        p = sh_quote(remote_path)
    );
    let output = crate::core::tool_runtime_ssh::ssh_run_for_worktree(cfg, &cmd).await?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(format!(
            "git rev-parse failed (exit {}): {}",
            output.status.code().unwrap_or(-1),
            stderr
        ));
    }
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

// --- Remote git write operations (SSH) ---------------------------------------
//
// These mirror the local `core::git` write ops (`stage_files`, `commit`,
// `push`, `pull`, `create_branch`) over SSH via `ssh_git`, which POSIX-quotes
// every argument through `sh_quote` — so commit messages, paths, and branch
// names cannot break out of the remote shell command. The safety guards from
// the local ops (protected-branch refusal on push, clean-worktree checks) are
// mirrored to keep behaviour consistent across local and remote workspaces.

/// True when `git status --porcelain` on the remote is empty.
async fn ssh_worktree_clean(cfg: &SshConfig, remote_path: &str) -> Result<bool, String> {
    let (out, code) = ssh_git(cfg, remote_path, &["status", "--porcelain"]).await?;
    if code != 0 {
        return Err(format!("git status failed (exit {}): {}", code, out.trim()));
    }
    Ok(out.trim().is_empty())
}

/// `git add -- <paths>` on the remote (stage specific files).
pub async fn ssh_stage_files(
    cfg: &SshConfig,
    remote_path: &str,
    paths: &[String],
) -> Result<String, String> {
    if paths.is_empty() {
        return Ok(String::new());
    }
    // S3: reject path escape before the paths reach the remote `git add`.
    for p in paths {
        validate_remote_rel_path(p)?;
    }
    let mut args: Vec<&str> = vec!["add", "--"];
    args.extend(paths.iter().map(|s| s.as_str()));
    let (out, code) = ssh_git(cfg, remote_path, &args).await?;
    if code != 0 {
        return Err(format!("git add failed (exit {}): {}", code, out.trim()));
    }
    Ok(out)
}

/// `git restore --staged -- <paths>` on the remote (unstage specific files).
pub async fn ssh_unstage_files(
    cfg: &SshConfig,
    remote_path: &str,
    paths: &[String],
) -> Result<String, String> {
    if paths.is_empty() {
        return Ok(String::new());
    }
    for p in paths {
        validate_remote_rel_path(p)?;
    }
    let mut args: Vec<&str> = vec!["restore", "--staged", "--"];
    args.extend(paths.iter().map(|s| s.as_str()));
    let (out, code) = ssh_git(cfg, remote_path, &args).await?;
    if code != 0 {
        return Err(format!(
            "git restore failed (exit {}): {}",
            code,
            out.trim()
        ));
    }
    Ok(out)
}

/// `git commit -m <message>` on the remote — commits the already-staged index
/// (no `stage_all`, matching the local commit's safety model).
pub async fn ssh_commit(
    cfg: &SshConfig,
    remote_path: &str,
    message: &str,
) -> Result<String, String> {
    let (out, code) = ssh_git(cfg, remote_path, &["commit", "-m", message]).await?;
    if code != 0 {
        return Err(format!("git commit failed (exit {}): {}", code, out.trim()));
    }
    Ok(out)
}

/// Push the remote workspace's current branch to origin. Mirrors the local
/// `git::push` guards: refuses main/master, refuses a dirty worktree, and sets
/// upstream tracking on first push.
pub async fn ssh_push(cfg: &SshConfig, remote_path: &str) -> Result<String, String> {
    let (branch_out, code) =
        ssh_git(cfg, remote_path, &["rev-parse", "--abbrev-ref", "HEAD"]).await?;
    if code != 0 {
        return Err(format!(
            "git rev-parse failed (exit {}): {}",
            code,
            branch_out.trim()
        ));
    }
    let branch = branch_out.trim().to_string();
    if branch == "main" || branch == "master" {
        return Err(format!(
            "Refusing to push '{}' from the in-app toolbar. Use a terminal if you intend to push this protected branch.",
            branch
        ));
    }
    if !ssh_worktree_clean(cfg, remote_path).await? {
        return Err(
            "Cannot push with local changes present. Commit or stash them first.".to_string(),
        );
    }
    // No upstream set → push with -u to establish tracking; else a plain push.
    let (_, up_code) = ssh_git(
        cfg,
        remote_path,
        &["rev-parse", "--abbrev-ref", "@{upstream}"],
    )
    .await?;
    let (out, code) = if up_code != 0 {
        ssh_git(cfg, remote_path, &["push", "-u", "origin", &branch]).await?
    } else {
        ssh_git(cfg, remote_path, &["push"]).await?
    };
    if code != 0 {
        return Err(friendly_push_error(&out, code));
    }
    Ok(out)
}

/// S3: turn git's raw push failure into a message that says what to do next.
/// A non-fast-forward rejection is the common one (remote moved on) and its
/// default output ("Updates were rejected because the tip of your current
/// branch is behind…") buries the fix, so we lead with it.
pub fn friendly_push_error(out: &str, code: i32) -> String {
    let lower = out.to_lowercase();
    if lower.contains("non-fast-forward")
        || lower.contains("fetch first")
        || (lower.contains("rejected") && lower.contains("behind"))
    {
        return format!(
            "Push rejected: the remote branch has commits you don't have yet. \
             Pull (or rebase) to integrate them, then push again.\n\n{}",
            out.trim()
        );
    }
    format!("git push failed (exit {}): {}", code, out.trim())
}

/// S3: read a file's committed `HEAD` blob from the remote for the diff viewer.
/// `Ok(None)` when the path isn't in HEAD (new/untracked file, empty repo).
/// Reviewer fix: reads only stdout (git warnings on stderr are discarded so they
/// can't corrupt the baseline) and enforces the same 2 MB cap as the working
/// side via `git cat-file -s` before materializing the blob.
pub async fn ssh_show_head(
    cfg: &SshConfig,
    base: &str,
    rel: &str,
) -> Result<Option<String>, String> {
    validate_remote_rel_path(rel)?;
    let script = format!(
        "cd {base} || exit 12\n\
         r={rel}\n\
         if ! git cat-file -e \"HEAD:$r\" 2>/dev/null; then exit 44; fi\n\
         sz=$(git cat-file -s \"HEAD:$r\" 2>/dev/null) || exit 44\n\
         if [ \"$sz\" -gt {max} ]; then exit 45; fi\n\
         git show \"HEAD:$r\" 2>/dev/null\n",
        base = sh_quote(base),
        rel = sh_quote(rel),
        max = crate::core::tool_runtime_ssh::MAX_FILE_SIZE,
    );
    let output = crate::core::tool_runtime_ssh::ssh_run_for_worktree(cfg, &script).await?;
    match output.status.code().unwrap_or(-1) {
        0 => Ok(Some(String::from_utf8_lossy(&output.stdout).to_string())),
        // 44 = not in HEAD (added file / empty repo); 12 = not a repo → no baseline.
        44 | 12 => Ok(None),
        45 => Err("File is too large to diff (over 2 MB)".to_string()),
        code => {
            let stderr = String::from_utf8_lossy(&output.stderr);
            Err(format!(
                "git show HEAD failed (exit {}): {}",
                code,
                stderr.trim()
            ))
        }
    }
}

/// S3: read a working-tree file's content from the remote for the diff viewer.
/// `Ok(None)` when the file doesn't exist on disk (deleted file).
///
/// Reviewer fix (security): a symlink LEAF returns its link text (git's own
/// representation of a symlink — and we never read the target, so a tracked
/// `creds -> /etc/passwd` can't leak), while regular files are realpath-confined
/// so a symlinked PARENT directory can't escape the workspace either. Size-capped
/// to the shared `MAX_FILE_SIZE`.
pub async fn ssh_read_working_file(
    cfg: &SshConfig,
    base: &str,
    rel: &str,
) -> Result<Option<String>, String> {
    use crate::core::tool_runtime_ssh::{
        confine_prelude, confinement_error, ConfineTarget, MAX_FILE_SIZE,
    };
    validate_remote_rel_path(rel)?;
    let full = format!("{}/{}", base.trim_end_matches(['/', '\\']), rel);
    let full_q = sh_quote(&full);
    let script = format!(
        "f={f}\n\
         if [ -L \"$f\" ]; then readlink -- \"$f\"; exit 0; fi\n\
         if [ ! -e \"$f\" ]; then exit 44; fi\n\
         if [ ! -f \"$f\" ]; then exit 46; fi\n\
         {confine}\
         sz=$(wc -c <\"$f\")\n\
         if [ \"$sz\" -gt {max} ]; then exit 45; fi\n\
         cat -- \"$f\"\n",
        f = full_q,
        confine = confine_prelude(&sh_quote(base), "\"$f\"", ConfineTarget::Existing),
        max = MAX_FILE_SIZE,
    );
    let output = crate::core::tool_runtime_ssh::ssh_run_for_worktree(cfg, &script).await?;
    let code = output.status.code().unwrap_or(-1);
    match code {
        0 => Ok(Some(String::from_utf8_lossy(&output.stdout).to_string())),
        44 => Ok(None), // deleted / absent working file
        45 => Err("File is too large to diff (over 2 MB)".to_string()),
        46 => Err("Path is not a regular file".to_string()),
        _ => {
            if let Some(msg) = confinement_error(code) {
                return Err(msg);
            }
            let stderr = String::from_utf8_lossy(&output.stderr);
            Err(format!(
                "read working file failed (exit {}): {}",
                code,
                stderr.trim()
            ))
        }
    }
}

/// `git pull --ff-only` on the remote, refusing when the worktree is dirty
/// (mirrors the local `git::pull`).
pub async fn ssh_pull(cfg: &SshConfig, remote_path: &str) -> Result<String, String> {
    if !ssh_worktree_clean(cfg, remote_path).await? {
        return Err(
            "Cannot pull with local changes present. Commit, stash, or discard them first."
                .to_string(),
        );
    }
    let (out, code) = ssh_git(cfg, remote_path, &["pull", "--ff-only"]).await?;
    if code != 0 {
        return Err(format!("git pull failed (exit {}): {}", code, out.trim()));
    }
    Ok(out)
}

/// Create a branch on the remote (`git checkout -b` / `git branch --`), reusing
/// the same `validate_branch_name` guard as the local path.
pub async fn ssh_create_branch(
    cfg: &SshConfig,
    remote_path: &str,
    branch_name: &str,
    checkout: bool,
) -> Result<String, String> {
    crate::core::git::validate_branch_name(branch_name)?;
    // `checkout -b -- <name>` is broken (git reads `--` as the branch name), so
    // mirror the local op: `checkout -b <name>` for checkout, `branch -- <name>`
    // otherwise. `validate_branch_name` already rejects leading `-`.
    let (out, code) = if checkout {
        ssh_git(cfg, remote_path, &["checkout", "-b", branch_name]).await?
    } else {
        ssh_git(cfg, remote_path, &["branch", "--", branch_name]).await?
    };
    if code != 0 {
        return Err(format!(
            "git branch create failed (exit {}): {}",
            code,
            out.trim()
        ));
    }
    Ok(out)
}

/// Remove a remote git worktree. Idempotent.
pub async fn remove_remote_worktree(
    cfg: &SshConfig,
    base: &str,
    attempt_id: &str,
) -> Result<(), String> {
    let path = worktree_path(base, attempt_id)?;
    let (combined, code) = ssh_git(cfg, base, &["worktree", "remove", "--force", &path]).await?;
    if code != 0 && !combined.contains("not a working tree") {
        warn!(path = %path, output = %combined.trim(), "remote git worktree remove failed");
        return Err(format!(
            "remote git worktree remove failed (exit {}): {}",
            code,
            combined.trim()
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn worktree_path_strips_trailing_slashes() {
        assert_eq!(
            worktree_path("/repo", "a").unwrap(),
            "/repo/.pkt-worktrees/a"
        );
        assert_eq!(
            worktree_path("/repo/", "a").unwrap(),
            "/repo/.pkt-worktrees/a"
        );
        assert_eq!(
            worktree_path("/repo\\", "a").unwrap(),
            "/repo/.pkt-worktrees/a"
        );
    }

    #[test]
    fn branch_name_uses_pkt_prefix() {
        assert_eq!(branch_name("abc123"), "pkt/abc123");
    }

    #[test]
    fn worktree_path_handles_windows_base() {
        assert_eq!(
            worktree_path("D:\\projects\\demo", "att-1").unwrap(),
            "D:\\projects\\demo/.pkt-worktrees/att-1"
        );
    }

    #[test]
    fn worktree_component_rejects_path_escape() {
        for invalid in ["", ".", "..", "../x", "x/../y", "/tmp/x", "x/y", "x\\y"] {
            assert!(
                worktree_path("/repo", invalid).is_err(),
                "{invalid:?} should be rejected"
            );
        }
    }

    #[test]
    fn worktree_component_rejects_non_ascii_or_shell_punctuation() {
        for invalid in ["attempt id", "attempt.dot", "attempt💥", "attempt;echo"] {
            assert!(
                worktree_path("/repo", invalid).is_err(),
                "{invalid:?} should be rejected"
            );
        }
        assert!(worktree_path("/repo", "att_UUID-123").is_ok());
    }

    // --- S3: remote git polish ---

    #[test]
    fn validate_remote_rel_path_accepts_repo_relative() {
        for ok in ["file.rs", "src/foo.rs", "a/b/c.txt", "dir/.hidden"] {
            assert!(validate_remote_rel_path(ok).is_ok(), "{ok:?} should be ok");
        }
    }

    #[test]
    fn validate_remote_rel_path_rejects_escape_and_absolute() {
        for bad in [
            "",
            "  ",
            "..",
            "../x",
            "a/../b",
            "a/..",
            "/etc/passwd",
            "\\\\server\\share",
            "..\\win",
            "a\\..\\b",
        ] {
            assert!(
                validate_remote_rel_path(bad).is_err(),
                "{bad:?} should be rejected"
            );
        }
    }

    #[test]
    fn friendly_push_error_explains_non_fast_forward() {
        let raw = "! [rejected] main -> main (non-fast-forward)\nUpdates were rejected because the tip of your current branch is behind";
        let msg = friendly_push_error(raw, 1);
        assert!(msg.contains("remote branch has commits you don't have"));
        assert!(msg.contains("Pull"));
    }

    #[test]
    fn friendly_push_error_passes_through_other_failures() {
        let msg = friendly_push_error("fatal: could not read from remote", 128);
        assert!(msg.contains("git push failed (exit 128)"));
    }

    // --- Phase 3.2 input validation ---

    #[test]
    fn validate_clone_branch_rejects_flag_injection() {
        assert!(validate_clone_branch("--upload-pack=evil").is_err());
        assert!(validate_clone_branch("-D").is_err());
    }

    #[test]
    fn validate_clone_branch_rejects_metacharacters() {
        assert!(validate_clone_branch("foo bar").is_err());
        assert!(validate_clone_branch("foo;rm -rf /").is_err());
        assert!(validate_clone_branch("foo`echo`").is_err());
        assert!(validate_clone_branch("foo$bar").is_err());
        assert!(validate_clone_branch("foo:bar").is_err());
    }

    #[test]
    fn validate_clone_branch_accepts_common_names() {
        assert!(validate_clone_branch("main").is_ok());
        assert!(validate_clone_branch("release/v1.2.3").is_ok());
        assert!(validate_clone_branch("feat-foo_bar").is_ok());
    }

    #[test]
    fn validate_clone_branch_rejects_empty() {
        assert!(validate_clone_branch("").is_err());
    }

    #[test]
    fn validate_clone_dest_path_rejects_flag_injection() {
        assert!(validate_clone_dest_path("--upload-pack=evil").is_err());
        assert!(validate_clone_dest_path("-o/etc").is_err());
    }

    #[test]
    fn validate_clone_dest_path_rejects_shell_meta() {
        assert!(validate_clone_dest_path("/tmp/foo`evil`").is_err());
        assert!(validate_clone_dest_path("/tmp/$(evil)").is_err());
        assert!(validate_clone_dest_path("/tmp/foo\nbar").is_err());
    }

    #[test]
    fn validate_clone_dest_path_accepts_unix_paths() {
        assert!(validate_clone_dest_path("/home/alice/proj").is_ok());
        assert!(validate_clone_dest_path("/var/www/site-1").is_ok());
    }

    #[test]
    fn validate_clone_repo_url_rejects_flag_injection() {
        assert!(validate_clone_repo_url("--upload-pack=evil").is_err());
    }

    #[test]
    fn validate_clone_repo_url_accepts_common_urls() {
        assert!(validate_clone_repo_url("git@github.com:foo/bar.git").is_ok());
        assert!(validate_clone_repo_url("https://github.com/foo/bar.git").is_ok());
        assert!(validate_clone_repo_url("ssh://git@host:22/foo/bar.git").is_ok());
    }

    #[test]
    fn validate_clone_repo_url_rejects_shell_meta() {
        assert!(validate_clone_repo_url("https://x.git'; rm -rf /;'").is_err());
        assert!(validate_clone_repo_url("https://x.git`evil`").is_err());
    }

    // --- v0.8 auto-trailer format ---

    #[test]
    fn render_trailer_format_substitutes_known_placeholders() {
        assert_eq!(
            render_trailer_format(
                "Run-By: PacketBench flight F-{flightId} attempt A-{attemptId}",
                "abc",
                "att1",
                "Title",
            ),
            "Run-By: PacketBench flight F-abc attempt A-att1"
        );
    }

    #[test]
    fn render_trailer_format_substitutes_flight_title() {
        assert_eq!(
            render_trailer_format("[{flightTitle}] F-{flightId}", "abc", "att1", "Hello World"),
            "[Hello World] F-abc"
        );
    }

    #[test]
    fn render_trailer_format_passes_unknown_placeholders_through() {
        // Users keeping literal braces (e.g. for templating) should be
        // unaffected by the substitution pass.
        assert_eq!(
            render_trailer_format("custom {other} {flightId}", "abc", "att1", ""),
            "custom {other} abc"
        );
    }

    #[test]
    fn sanitize_trailer_value_strips_quotes_and_newlines() {
        assert_eq!(sanitize_trailer_value("foo'bar\nbaz"), "foo bar baz");
        assert_eq!(sanitize_trailer_value("  trimmed  "), "trimmed");
    }

    // --- v0.8.5 issue trailer ---

    #[test]
    fn worktree_issue_struct_holds_fields() {
        let wi = WorktreeIssue {
            issue_id: "abc123".to_string(),
            issue_number: 42,
            issue_title: "Fix the foo".to_string(),
        };
        assert_eq!(wi.issue_number, 42);
        assert_eq!(wi.issue_id, "abc123");
        assert_eq!(wi.issue_title, "Fix the foo");
    }

    #[test]
    fn sanitize_trailer_value_neutralises_quote_smuggling_attempts() {
        // The hook script wraps trailer values in single-quoted printf
        // literals; the sanitiser must strip both quote characters and
        // control bytes so an issue title can't smuggle extra trailer
        // lines into the commit message.
        let attack = "foo'\n\rRun-By: evil";
        let cleaned = sanitize_trailer_value(attack);
        assert!(
            !cleaned.contains('\''),
            "single-quote leaked: {:?}",
            cleaned
        );
        assert!(!cleaned.contains('\n'), "newline leaked: {:?}", cleaned);
        assert!(
            !cleaned.contains('\r'),
            "carriage return leaked: {:?}",
            cleaned
        );
    }

    #[test]
    fn rendered_user_format_is_sanitized_after_substitution() {
        let rendered = render_trailer_format(
            "Run-By: {flightId}'\nprintf pwned",
            "safe-flight",
            "attempt",
            "title",
        );
        let cleaned = sanitize_trailer_value(&rendered);
        assert_eq!(cleaned, "Run-By: safe-flight  printf pwned");
        assert!(!cleaned.contains('\''));
        assert!(!cleaned.contains('\n'));
    }

    // --- P2-S2: remove_local_worktree delete_branch flag ---

    /// Build a fixture repo with a conversation worktree at
    /// `.pkt-worktrees/<conv_id>` on branch `pkt/<conv_id>`, mirroring how
    /// `create_local_worktree` provisions them. Uses the std (sync) git binary
    /// for setup so the async removal under test is the only tokio call.
    fn fixture_repo_with_worktree(tag: &str, conv_id: &str) -> std::path::PathBuf {
        use std::time::{SystemTime, UNIX_EPOCH};
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let root = std::env::temp_dir().join(format!("packetbench-wtdel-{}-{}", tag, nanos));
        std::fs::create_dir_all(&root).expect("create temp repo dir");
        let git = |args: &[&str]| {
            let ok = std::process::Command::new("git")
                .args(args)
                .current_dir(&root)
                .output()
                .expect("git run")
                .status
                .success();
            assert!(ok, "git {:?} failed", args);
        };
        git(&["init", "-q"]);
        git(&["config", "user.email", "test@packetbench.test"]);
        git(&["config", "user.name", "PacketBench Test"]);
        git(&["checkout", "-q", "-b", "main"]);
        std::fs::write(root.join("f.txt"), "base\n").expect("write f.txt");
        git(&["add", "f.txt"]);
        git(&["commit", "-q", "-m", "init"]);
        let wt = format!(".pkt-worktrees/{}", conv_id);
        let branch = format!("pkt/{}", conv_id);
        git(&["worktree", "add", "-q", "-b", &branch, &wt, "main"]);
        root
    }

    fn branch_exists(root: &std::path::Path, branch: &str) -> bool {
        let out = std::process::Command::new("git")
            .args(["branch", "--list", branch])
            .current_dir(root)
            .output()
            .expect("git branch --list");
        !String::from_utf8_lossy(&out.stdout).trim().is_empty()
    }

    #[tokio::test]
    async fn remove_local_worktree_without_flag_leaks_the_branch() {
        let conv = "conv-keep";
        let root = fixture_repo_with_worktree("keep", conv);
        let base = root.to_string_lossy().to_string();
        let wt = root.join(".pkt-worktrees").join(conv);

        remove_local_worktree(&base, conv, false)
            .await
            .expect("worktree removal succeeds");

        assert!(!wt.exists(), "worktree dir should be gone");
        // Prior behavior preserved: the branch is retained (flight cleanup).
        assert!(
            branch_exists(&root, &format!("pkt/{}", conv)),
            "branch must survive when delete_branch is false"
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    #[tokio::test]
    async fn remove_local_worktree_with_flag_deletes_dir_and_branch() {
        let conv = "conv-discard";
        let root = fixture_repo_with_worktree("discard", conv);
        let base = root.to_string_lossy().to_string();
        let wt = root.join(".pkt-worktrees").join(conv);
        // Commit work on the branch so it is NOT reachable from main — a plain
        // `-d` would refuse; the Discard path uses `-D` (force).
        std::fs::write(wt.join("f.txt"), "base\nfrom-conv\n").unwrap();
        let git_wt = |args: &[&str]| {
            let ok = std::process::Command::new("git")
                .args(args)
                .current_dir(&wt)
                .output()
                .expect("git run")
                .status
                .success();
            assert!(ok, "git {:?} failed in worktree", args);
        };
        git_wt(&["add", "-A"]);
        git_wt(&["commit", "-q", "-m", "conv work"]);

        remove_local_worktree(&base, conv, true)
            .await
            .expect("worktree removal succeeds");

        assert!(!wt.exists(), "worktree dir should be gone");
        assert!(
            !branch_exists(&root, &format!("pkt/{}", conv)),
            "branch must be force-deleted when delete_branch is true"
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    #[tokio::test]
    async fn remove_local_worktree_missing_is_ok() {
        let conv = "conv-missing";
        let root = fixture_repo_with_worktree("missing", conv);
        let base = root.to_string_lossy().to_string();
        // Remove once (with flag) then again — the second call is a no-op.
        remove_local_worktree(&base, conv, true)
            .await
            .expect("first removal");
        remove_local_worktree(&base, conv, true)
            .await
            .expect("idempotent second removal");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[tokio::test]
    async fn cooperative_integration_prepares_merges_and_lands_without_switching_root() {
        let root = fixture_repo_with_worktree("coop-land", "unrelated");
        let base = root.to_string_lossy().to_string();
        let root_branch_before = git_stdout(&base, &["rev-parse", "--abbrev-ref", "HEAD"]).unwrap();
        let integration =
            prepare_local_integration_branch(&base, "flight-coop-land", "main").unwrap();
        assert_eq!(root_branch_before, "main");
        assert_eq!(
            git_stdout(&base, &["rev-parse", "--abbrev-ref", "HEAD"]).unwrap(),
            "main",
            "preparing integration must not switch the user's checkout"
        );

        let attempt_path = create_local_worktree(&base, "coop-task", &integration.branch)
            .await
            .unwrap();
        std::fs::write(
            std::path::Path::new(&attempt_path).join("task.txt"),
            "cooperative\n",
        )
        .unwrap();
        git_stdout(&attempt_path, &["add", "task.txt"]).unwrap();
        git_stdout(&attempt_path, &["commit", "-m", "task"]).unwrap();

        let merged = integrate_local_attempt(
            &integration.worktree_path,
            &integration.branch,
            &attempt_path,
            &branch_name("coop-task"),
        )
        .unwrap();
        assert!(merged.conflict_files.is_empty());
        assert!(std::path::Path::new(&integration.worktree_path)
            .join("task.txt")
            .exists());

        let landed = land_local_integration_branch(&base, "main", &integration.branch).unwrap();
        assert!(!landed.is_empty());
        assert!(root.join("task.txt").exists());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[tokio::test]
    async fn cooperative_integration_reports_conflicts_and_preserves_attempts() {
        let root = fixture_repo_with_worktree("coop-conflict", "unrelated");
        let base = root.to_string_lossy().to_string();
        let integration =
            prepare_local_integration_branch(&base, "flight-coop-conflict", "main").unwrap();
        let first = create_local_worktree(&base, "coop-first", &integration.branch)
            .await
            .unwrap();
        let second = create_local_worktree(&base, "coop-second", &integration.branch)
            .await
            .unwrap();
        for (path, value, message) in [
            (&first, "first\n", "first task"),
            (&second, "second\n", "second task"),
        ] {
            std::fs::write(std::path::Path::new(path).join("f.txt"), value).unwrap();
            git_stdout(path, &["add", "f.txt"]).unwrap();
            git_stdout(path, &["commit", "-m", message]).unwrap();
        }
        let first_merge = integrate_local_attempt(
            &integration.worktree_path,
            &integration.branch,
            &first,
            &branch_name("coop-first"),
        )
        .unwrap();
        assert!(first_merge.conflict_files.is_empty());
        let conflict = integrate_local_attempt(
            &integration.worktree_path,
            &integration.branch,
            &second,
            &branch_name("coop-second"),
        )
        .unwrap();
        assert_eq!(conflict.conflict_files, vec!["f.txt"]);
        assert!(std::path::Path::new(&first).exists());
        assert!(std::path::Path::new(&second).exists());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[tokio::test]
    async fn cooperative_integration_rejects_dirty_integration_worktree() {
        let root = fixture_repo_with_worktree("coop-dirty-int", "unrelated");
        let base = root.to_string_lossy().to_string();
        let integration =
            prepare_local_integration_branch(&base, "flight-coop-dirty-int", "main").unwrap();
        let attempt_path = create_local_worktree(&base, "coop-dirty-task", &integration.branch)
            .await
            .unwrap();
        std::fs::write(
            std::path::Path::new(&attempt_path).join("task.txt"),
            "cooperative\n",
        )
        .unwrap();
        git_stdout(&attempt_path, &["add", "task.txt"]).unwrap();
        git_stdout(&attempt_path, &["commit", "-m", "task"]).unwrap();
        // Leftover file in the integration worktree (e.g. an aborted manual
        // conflict resolution) must block integration, not be silently
        // reported as a successful merge.
        std::fs::write(
            std::path::Path::new(&integration.worktree_path).join("stray.txt"),
            "leftover\n",
        )
        .unwrap();

        let err = integrate_local_attempt(
            &integration.worktree_path,
            &integration.branch,
            &attempt_path,
            &branch_name("coop-dirty-task"),
        )
        .unwrap_err();
        assert!(
            err.contains("Integration worktree has uncommitted changes"),
            "unexpected error: {}",
            err
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    #[tokio::test]
    async fn cooperative_integration_fails_closed_on_non_conflict_merge_failure() {
        let root = fixture_repo_with_worktree("coop-nonconflict", "unrelated");
        let base = root.to_string_lossy().to_string();
        let integration =
            prepare_local_integration_branch(&base, "flight-coop-nonconflict", "main").unwrap();
        let attempt_path = create_local_worktree(&base, "coop-nc-task", &integration.branch)
            .await
            .unwrap();
        let before = git_stdout(&integration.worktree_path, &["rev-parse", "HEAD"]).unwrap();

        // A missing attempt branch ref fails the merge with zero unmerged
        // entries — previously reported as Ok { conflict_files: [] }.
        let err = integrate_local_attempt(
            &integration.worktree_path,
            &integration.branch,
            &attempt_path,
            "pkt/does-not-exist",
        )
        .unwrap_err();
        assert!(
            err.contains("failed without producing conflicts"),
            "unexpected error: {}",
            err
        );
        assert_eq!(
            git_stdout(&integration.worktree_path, &["rev-parse", "HEAD"]).unwrap(),
            before,
            "integration HEAD must be unchanged after a failed merge"
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    #[tokio::test]
    async fn land_local_integration_branch_aborts_conflicted_merge() {
        let root = fixture_repo_with_worktree("coop-land-conflict", "unrelated");
        let base = root.to_string_lossy().to_string();
        let integration =
            prepare_local_integration_branch(&base, "flight-coop-land-conflict", "main").unwrap();
        let attempt_path = create_local_worktree(&base, "coop-lc-task", &integration.branch)
            .await
            .unwrap();
        std::fs::write(
            std::path::Path::new(&attempt_path).join("f.txt"),
            "base\nattempt\n",
        )
        .unwrap();
        git_stdout(&attempt_path, &["add", "f.txt"]).unwrap();
        git_stdout(&attempt_path, &["commit", "-m", "attempt work"]).unwrap();
        let merged = integrate_local_attempt(
            &integration.worktree_path,
            &integration.branch,
            &attempt_path,
            &branch_name("coop-lc-task"),
        )
        .unwrap();
        assert!(merged.conflict_files.is_empty());
        // Diverge main with a conflicting commit after the integration branch
        // was prepared, so landing conflicts.
        std::fs::write(root.join("f.txt"), "base\nmainline\n").unwrap();
        git_stdout(&base, &["add", "f.txt"]).unwrap();
        git_stdout(&base, &["commit", "-m", "mainline work"]).unwrap();

        let err = land_local_integration_branch(&base, "main", &integration.branch).unwrap_err();
        assert!(
            err.contains("Flight landing failed"),
            "unexpected error: {}",
            err
        );
        assert!(
            !root.join(".git").join("MERGE_HEAD").exists(),
            "landing failure must not leave the base checkout mid-merge"
        );
        let status = git_stdout(&base, &["status", "--porcelain"]).unwrap();
        assert!(
            root_is_clean_for_integration(&status),
            "base working tree must be restored after aborted landing: {}",
            status
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    // --- Integration-worktree teardown (flight delete) ---

    #[test]
    fn integration_worktree_path_matches_the_prepared_layout() {
        assert_eq!(
            integration_worktree_path("/repo", "flight-1").unwrap(),
            "/repo/.pkt-flight-integrations/flight-1"
        );
        assert_eq!(
            integration_worktree_path("/repo/", "flight-1").unwrap(),
            "/repo/.pkt-flight-integrations/flight-1"
        );
        // Same component guard as attempt worktrees — a flight id can never
        // escape the repo.
        for invalid in ["", "..", "../x", "a/b", "a\\b", "flight 1"] {
            assert!(
                integration_worktree_path("/repo", invalid).is_err(),
                "{invalid:?} should be rejected"
            );
        }
    }

    #[tokio::test]
    async fn remove_local_integration_worktree_removes_dir_and_reports_dirt() {
        let root = fixture_repo_with_worktree("int-remove", "unrelated");
        let base = root.to_string_lossy().to_string();
        let integration = prepare_local_integration_branch(&base, "flight-remove", "main").unwrap();
        assert!(std::path::Path::new(&integration.worktree_path).exists());
        // Uncommitted work in the integration worktree: the forced removal
        // destroys it, so it MUST be named in the outcome rather than lost
        // silently.
        std::fs::write(
            std::path::Path::new(&integration.worktree_path).join("stray.txt"),
            "leftover\n",
        )
        .unwrap();

        let outcome = remove_local_integration_worktree(&base, "flight-remove", true)
            .await
            .expect("teardown runs");

        assert!(outcome.removed, "worktree must be gone: {:?}", outcome);
        assert!(outcome.error.is_none());
        assert!(!std::path::Path::new(&integration.worktree_path).exists());
        assert_eq!(
            outcome.worktree_path,
            integration_worktree_path(&base, "flight-remove").unwrap()
        );
        assert!(
            outcome.dirty_paths.iter().any(|l| l.contains("stray.txt")),
            "destroyed uncommitted work must be reported: {:?}",
            outcome.dirty_paths
        );
        // Nothing was ever merged into it, so the branch is fully merged into
        // main and the safe `-d` deletion succeeds.
        assert!(outcome.branch_deleted, "{:?}", outcome);
        assert!(!branch_exists(&root, &integration.branch));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[tokio::test]
    async fn remove_local_integration_worktree_keeps_an_unmerged_branch() {
        let root = fixture_repo_with_worktree("int-unmerged", "unrelated");
        let base = root.to_string_lossy().to_string();
        let integration =
            prepare_local_integration_branch(&base, "flight-unmerged", "main").unwrap();
        // Merged-but-never-landed attempt work: the integration branch is the
        // only ref to it. Removing the worktree must not make it unreachable.
        let attempt_path = create_local_worktree(&base, "int-task", &integration.branch)
            .await
            .unwrap();
        std::fs::write(
            std::path::Path::new(&attempt_path).join("task.txt"),
            "cooperative\n",
        )
        .unwrap();
        git_stdout(&attempt_path, &["add", "task.txt"]).unwrap();
        git_stdout(&attempt_path, &["commit", "-m", "task"]).unwrap();
        integrate_local_attempt(
            &integration.worktree_path,
            &integration.branch,
            &attempt_path,
            &branch_name("int-task"),
        )
        .unwrap();

        let outcome = remove_local_integration_worktree(&base, "flight-unmerged", true)
            .await
            .expect("teardown runs");

        assert!(outcome.removed);
        assert!(!outcome.branch_deleted, "unmerged branch must survive");
        assert!(
            outcome
                .branch_retained
                .as_deref()
                .unwrap_or_default()
                .contains(&integration.branch),
            "retention must be reported: {:?}",
            outcome.branch_retained
        );
        assert!(branch_exists(&root, &integration.branch));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[tokio::test]
    async fn remove_local_integration_worktree_is_idempotent() {
        let root = fixture_repo_with_worktree("int-idem", "unrelated");
        let base = root.to_string_lossy().to_string();
        prepare_local_integration_branch(&base, "flight-idem", "main").unwrap();

        remove_local_integration_worktree(&base, "flight-idem", false)
            .await
            .expect("first teardown");
        let second = remove_local_integration_worktree(&base, "flight-idem", false)
            .await
            .expect("second teardown");

        assert!(second.removed, "absent worktree counts as removed");
        assert!(second.error.is_none());
        assert!(second.dirty_paths.is_empty());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[tokio::test]
    async fn remove_local_integration_worktree_reports_removal_failure() {
        // A directory that looks like an integration worktree but whose base
        // is not a git repo: `git worktree remove` fails, and the failure has
        // to come back as data instead of being logged and swallowed.
        use std::time::{SystemTime, UNIX_EPOCH};
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let root = std::env::temp_dir().join(format!("packetbench-int-fail-{}", nanos));
        let path = root.join(".pkt-flight-integrations").join("flight-fail");
        std::fs::create_dir_all(&path).unwrap();
        let base = root.to_string_lossy().to_string();

        let outcome = remove_local_integration_worktree(&base, "flight-fail", true)
            .await
            .expect("teardown reports failure as data, not Err");

        assert!(!outcome.removed);
        assert!(
            outcome
                .error
                .as_deref()
                .unwrap_or_default()
                .contains("git worktree remove failed"),
            "unexpected error: {:?}",
            outcome.error
        );
        assert!(outcome.needs_attention());
        assert!(path.exists(), "the failed-to-remove dir is still there");
        assert!(
            !outcome.branch_deleted,
            "branch deletion must not run after a failed removal"
        );
        let _ = std::fs::remove_dir_all(&root);
    }
}
