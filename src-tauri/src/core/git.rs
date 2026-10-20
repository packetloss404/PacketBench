use super::shared::{hide_window, validate_project_path};
use std::process::Command;
use tracing::info;

fn status_lines(project_path: &str) -> Result<Vec<String>, String> {
    Ok(get_status(project_path)?
        .lines()
        .map(|line| line.trim_end().to_string())
        .filter(|line| !line.is_empty())
        .collect())
}

fn worktree_is_clean(project_path: &str) -> Result<bool, String> {
    Ok(status_lines(project_path)?.is_empty())
}

fn has_staged_changes(project_path: &str) -> Result<bool, String> {
    Ok(status_lines(project_path)?.iter().any(|line| {
        if line.starts_with("??") {
            return false;
        }

        line.chars().next().map(|c| c != ' ').unwrap_or(false)
    }))
}

fn git_command(args: &[&str], cwd: &str) -> Result<std::process::Output, String> {
    validate_project_path(cwd)?;
    info!(command = ?args, cwd = %cwd, "Running git command");
    let mut cmd = Command::new("git");
    cmd.args(args).current_dir(cwd);
    hide_window(&mut cmd);
    let output = cmd
        .output()
        .map_err(|e| format!("Failed to run git: {}", e))?;

    // Audit log
    let success = output.status.success();
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    if success {
        info!(command = ?args, cwd = %cwd, "Git command succeeded");
    } else {
        tracing::warn!(command = ?args, cwd = %cwd, stderr = %stderr, "Git command failed");
    }

    Ok(output)
}

fn git_command_result(args: &[&str], cwd: &str) -> Result<String, String> {
    let output = git_command(args, cwd)?;
    if output.status.success() {
        Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        Err(if stderr.is_empty() {
            format!("git {} failed", args[0])
        } else {
            stderr
        })
    }
}

/// A4: discover the git repo root containing `cwd`. Used by the
/// AGENTS.md cascading resolver to walk root → cwd. Returns `Err` when
/// `cwd` is not inside a git working tree (the caller falls back to
/// treating `cwd` as the only directory).
pub fn get_toplevel(cwd: &str) -> Result<String, String> {
    git_command_result(&["rev-parse", "--show-toplevel"], cwd)
}

/// v0.8-15: read the `origin` remote URL for `cwd`. Returns `Ok(None)`
/// when the repo has no `origin` remote (so the caller can fall back to
/// a manual GitHub repo selector). Returns `Err` only when `cwd` is not
/// a git repository or git itself fails.
pub fn get_origin_url(cwd: &str) -> Result<Option<String>, String> {
    let output = git_command(&["remote", "get-url", "origin"], cwd)?;
    if output.status.success() {
        let url = String::from_utf8_lossy(&output.stdout).trim().to_string();
        if url.is_empty() {
            Ok(None)
        } else {
            Ok(Some(url))
        }
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr).to_string();
        // Git returns exit 2 with "No such remote 'origin'" when origin
        // isn't configured — treat that as Ok(None) so workspaces created
        // from non-GitHub repos don't error out.
        if stderr.contains("No such remote") || stderr.contains("no such remote") {
            return Ok(None);
        }
        Err(stderr.trim().to_string())
    }
}

/// v0.8-15: parse a GitHub remote URL into `(owner, repo)`. Accepts the
/// three forms git typically emits:
///   - `git@github.com:owner/repo.git`
///   - `https://github.com/owner/repo.git`
///   - `https://github.com/owner/repo`
/// Trailing `.git` is stripped. Anything that does not match a GitHub
/// host or lacks the `owner/repo` shape returns `None` so the caller
/// (workspace creation) silently skips auto-binding.
pub fn parse_github_remote(url: &str) -> Option<(String, String)> {
    let trimmed = url.trim();
    if trimmed.is_empty() {
        return None;
    }

    // Locate the `host:path` boundary. SSH-style URLs use `:` as the
    // separator (`git@github.com:owner/repo.git`); HTTPS-style URLs use
    // `/` after the host.
    let after_host: &str = if let Some(rest) = trimmed.strip_prefix("git@github.com:") {
        rest
    } else if let Some(rest) = trimmed.strip_prefix("ssh://git@github.com/") {
        rest
    } else if let Some(rest) = trimmed.strip_prefix("https://github.com/") {
        rest
    } else if let Some(rest) = trimmed.strip_prefix("http://github.com/") {
        rest
    } else if let Some(rest) = trimmed.strip_prefix("git://github.com/") {
        rest
    } else {
        return None;
    };

    // Strip an optional `.git` suffix and any trailing slash.
    let stripped = after_host
        .trim_end_matches('/')
        .strip_suffix(".git")
        .unwrap_or_else(|| after_host.trim_end_matches('/'));

    let mut parts = stripped.splitn(2, '/');
    let owner = parts.next()?.trim();
    let repo = parts.next()?.trim();
    if owner.is_empty() || repo.is_empty() {
        return None;
    }
    // Reject anything with further path segments (e.g. tree URLs).
    if repo.contains('/') {
        return None;
    }
    Some((owner.to_string(), repo.to_string()))
}

pub fn get_branch(project_path: &str) -> Result<String, String> {
    git_command_result(&["rev-parse", "--abbrev-ref", "HEAD"], project_path)
        .map_err(|_| "Not a git repository or git not found".to_string())
}

pub fn get_status(project_path: &str) -> Result<String, String> {
    let output = git_command(&["status", "--short"], project_path)?;
    if output.status.success() {
        Ok(String::from_utf8_lossy(&output.stdout).to_string())
    } else {
        Err("Failed to get git status".to_string())
    }
}

/// P1-S4 (clickable git rows): read a file's committed content at `HEAD`
/// so the frontend can diff it against the working-tree copy through the
/// shared DiffRows engine. Returns:
/// - `Ok(Some(content))` — the file exists in `HEAD` (content returned
///   verbatim, NO trimming, so the diff is byte-faithful);
/// - `Ok(None)` — the path is untracked / newly added, or the repo has no
///   commit yet (nothing to diff against → treat the whole file as added);
/// - `Err(..)` — any other git failure.
///
/// `rel_path` is repo-root-relative with forward slashes (as produced by
/// `git status --short`). Callers pass the NEW-side path for renames.
pub fn get_file_head_content(project_path: &str, rel_path: &str) -> Result<Option<String>, String> {
    let spec = format!("HEAD:{}", rel_path);
    let output = git_command(&["show", &spec], project_path)?;
    if output.status.success() {
        return Ok(Some(String::from_utf8_lossy(&output.stdout).to_string()));
    }
    let stderr = String::from_utf8_lossy(&output.stderr).to_lowercase();
    // Path not present in HEAD (untracked / newly added), or no HEAD yet
    // (fresh repo) — both mean "no prior content", i.e. a fully-added file.
    let no_prior = stderr.contains("does not exist")
        || stderr.contains("exists on disk, but not in")
        || stderr.contains("bad revision")
        || stderr.contains("unknown revision")
        || stderr.contains("invalid object name")
        || stderr.contains("ambiguous argument");
    if no_prior {
        Ok(None)
    } else {
        Err(stderr.trim().to_string())
    }
}

#[derive(Debug, Clone, Default)]
pub struct GitCommitContext {
    pub flight_id: Option<String>,
    pub task_id: Option<String>,
    pub attempt_id: Option<String>,
    pub conversation_id: Option<String>,
    pub session_id: Option<String>,
}

fn clean_trailer_value(value: &str) -> Option<String> {
    let cleaned = value
        .trim()
        .chars()
        .filter(|ch| !ch.is_control())
        .collect::<String>();
    if cleaned.is_empty() {
        None
    } else {
        Some(cleaned)
    }
}

pub fn append_packetbench_context_trailers(message: &str, context: &GitCommitContext) -> String {
    let mut trailers: Vec<String> = Vec::new();
    if let Some(value) = context.flight_id.as_deref().and_then(clean_trailer_value) {
        trailers.push(format!("PacketBench-Flight: {}", value));
    }
    if let Some(value) = context.task_id.as_deref().and_then(clean_trailer_value) {
        trailers.push(format!("PacketBench-Task: {}", value));
    }
    if let Some(value) = context.attempt_id.as_deref().and_then(clean_trailer_value) {
        trailers.push(format!("PacketBench-Attempt: {}", value));
    }
    if let Some(value) = context
        .conversation_id
        .as_deref()
        .and_then(clean_trailer_value)
    {
        trailers.push(format!("PacketBench-Conversation: {}", value));
    }
    if let Some(value) = context.session_id.as_deref().and_then(clean_trailer_value) {
        trailers.push(format!("PacketBench-Session: {}", value));
    }

    if trailers.is_empty() {
        return message.trim().to_string();
    }

    let mut out = message.trim_end().to_string();
    if !out.ends_with("\n\n") {
        if out.ends_with('\n') {
            out.push('\n');
        } else {
            out.push_str("\n\n");
        }
    }
    out.push_str(&trailers.join("\n"));
    out
}

pub fn commit(project_path: &str, message: &str, stage_all: bool) -> Result<String, String> {
    commit_with_context(project_path, message, stage_all, None)
}

pub fn commit_with_context(
    project_path: &str,
    message: &str,
    stage_all: bool,
    context: Option<GitCommitContext>,
) -> Result<String, String> {
    let trimmed_message = message.trim();
    if trimmed_message.is_empty() {
        return Err("Commit message is required".to_string());
    }

    if stage_all {
        return Err(
            "Stage-all commits are disabled in the in-app flow. Stage files explicitly first."
                .to_string(),
        );
    }

    if !has_staged_changes(project_path)? {
        return Err("No staged changes to commit. Stage files explicitly first.".to_string());
    }

    let final_message = context
        .as_ref()
        .map(|ctx| append_packetbench_context_trailers(trimmed_message, ctx))
        .unwrap_or_else(|| trimmed_message.to_string());
    git_command_result(&["commit", "-m", &final_message], project_path)
}

/// P1-15: guard for individual file paths passed to `stage_files` /
/// `unstage_files`. Deliberately minimal — the `--` end-of-options
/// separator used below already prevents flag injection (a path like
/// `-weird` is passed through fine), and git itself rejects paths
/// outside the repo. We only reject inputs that can't possibly be a
/// real path: empty/whitespace-only strings and embedded NUL bytes
/// (which would truncate the arg when handed to the OS process API).
fn validate_stage_path(p: &str) -> Result<(), String> {
    if p.trim().is_empty() {
        return Err("File path cannot be empty".to_string());
    }
    if p.contains('\0') {
        return Err("File path contains invalid characters".to_string());
    }
    Ok(())
}

/// P1-15: explicit `git add -- <paths>` for the per-file staging UI.
/// GitDashboard's commit flow always stages specific files before
/// calling `commit_with_context` — `stage_all` commits are rejected
/// there, so this is the only path that puts changes in the index.
pub fn stage_files(project_path: &str, paths: &[String]) -> Result<String, String> {
    if paths.is_empty() {
        return Err("No files to stage".to_string());
    }
    for p in paths {
        validate_stage_path(p)?;
    }
    let mut args: Vec<&str> = vec!["add", "--"];
    args.extend(paths.iter().map(String::as_str));
    git_command_result(&args, project_path)
}

/// P1-15: explicit `git restore --staged -- <paths>` — the unstage
/// counterpart of `stage_files`. Known limitation (not solved here):
/// `git restore --staged` fails on a repo with an unborn HEAD (no
/// commits yet); the resulting error surfaces in the dashboard's
/// feedback toast, which is acceptable for this slice.
pub fn unstage_files(project_path: &str, paths: &[String]) -> Result<String, String> {
    if paths.is_empty() {
        return Err("No files to unstage".to_string());
    }
    for p in paths {
        validate_stage_path(p)?;
    }
    let mut args: Vec<&str> = vec!["restore", "--staged", "--"];
    args.extend(paths.iter().map(String::as_str));
    git_command_result(&args, project_path)
}

pub fn push(project_path: &str) -> Result<String, String> {
    let branch = get_branch(project_path)?;
    if branch == "main" || branch == "master" {
        return Err(format!(
            "Refusing to push '{}' from the in-app toolbar. Use the terminal if you intend to push this protected branch.",
            branch
        ));
    }

    if !worktree_is_clean(project_path)? {
        return Err(
            "Cannot push with local changes present. Commit or stash them first.".to_string(),
        );
    }

    // Check upstream tracking
    let upstream = git_command_result(&["rev-parse", "--abbrev-ref", "@{upstream}"], project_path);
    if upstream.is_err() {
        // No upstream set — push with -u to set tracking
        return git_command_result(&["push", "-u", "origin", &branch], project_path);
    }

    // Check if behind upstream
    let behind = git_command_result(&["rev-list", "HEAD..@{upstream}", "--count"], project_path)
        .unwrap_or_default();
    if behind.trim() != "0" {
        return Err(format!(
            "Local branch is {} commit(s) behind upstream. Pull first.",
            behind.trim()
        ));
    }

    git_command_result(&["push"], project_path)
}

pub fn pull(project_path: &str) -> Result<String, String> {
    if !worktree_is_clean(project_path)? {
        return Err(
            "Cannot pull with local changes present. Commit, stash, or discard them first."
                .to_string(),
        );
    }

    git_command_result(&["pull", "--ff-only"], project_path)
}

pub fn create_branch(
    project_path: &str,
    branch_name: &str,
    checkout: bool,
) -> Result<String, String> {
    validate_branch_name(branch_name)?;
    if checkout {
        // NOTE: `git checkout -b -- <name>` is broken — git parses `--` as
        // the new branch name and `<name>` as the commit-ish to branch from
        // ("fatal: '<name>' is not a commit and a branch '--' cannot be
        // created from it"). `git branch -- <name>` works because branch
        // accepts `--` as end-of-options, but `checkout -b` does not. Flag
        // injection is already prevented by `validate_branch_name`
        // (rejects names starting with `-`).
        git_command_result(&["checkout", "-b", branch_name], project_path)
    } else {
        git_command_result(&["branch", "--", branch_name], project_path)
    }
}

/// v0.8-G: explicit-branch push for "Publish attempts as draft PRs". Unlike
/// `push`, this targets a specific branch by name (the attempt's worktree
/// branch), sets upstream tracking on first push, and intentionally
/// bypasses the main/master guard since attempt branches always live under
/// the `att_<uuid>` namespace. It still refuses if the worktree at
/// `project_path` is dirty — caller is expected to commit before publish.
pub fn push_branch(project_path: &str, branch_name: &str, force: bool) -> Result<String, String> {
    validate_branch_name(branch_name)?;
    if !worktree_is_clean(project_path)? {
        return Err(
            "Cannot push with local changes present. Commit or stash them first.".to_string(),
        );
    }
    let mut args: Vec<&str> = Vec::with_capacity(6);
    args.push("push");
    if force {
        args.push("--force-with-lease");
    }
    args.push("-u");
    args.push("origin");
    args.push(branch_name);
    git_command_result(&args, project_path)
}

pub(crate) fn validate_branch_name(name: &str) -> Result<(), String> {
    if name.is_empty() {
        return Err("Branch name cannot be empty".to_string());
    }
    if name.starts_with('-') {
        return Err("Branch name cannot start with '-'".to_string());
    }
    if name.contains("..")
        || name.contains(' ')
        || name.contains('~')
        || name.contains('^')
        || name.contains(':')
        || name.contains('\\')
        || name.contains('\x7f')
        || name.contains('\0')
    {
        return Err("Branch name contains invalid characters".to_string());
    }
    if name.ends_with('/') || name.ends_with(".lock") || name.ends_with('.') {
        return Err("Branch name has an invalid suffix".to_string());
    }
    Ok(())
}

/// Pre-flight safety check for git state
#[derive(serde::Serialize)]
pub struct GitSafetyReport {
    pub is_git_repo: bool,
    pub branch: Option<String>,
    pub has_upstream: bool,
    pub is_clean: bool,
    pub uncommitted_count: usize,
    pub behind_upstream: usize,
    pub warnings: Vec<String>,
}

pub fn safety_check(project_path: &str) -> GitSafetyReport {
    let branch = get_branch(project_path).ok();
    let is_git_repo = branch.is_some();

    if !is_git_repo {
        return GitSafetyReport {
            is_git_repo: false,
            branch: None,
            has_upstream: false,
            is_clean: false,
            uncommitted_count: 0,
            behind_upstream: 0,
            warnings: vec!["Not a git repository".to_string()],
        };
    }

    let lines = status_lines(project_path).unwrap_or_default();
    let uncommitted_count = lines.len();
    let is_clean = uncommitted_count == 0;

    let has_upstream =
        git_command_result(&["rev-parse", "--abbrev-ref", "@{upstream}"], project_path).is_ok();

    let behind_upstream = if has_upstream {
        git_command_result(&["rev-list", "HEAD..@{upstream}", "--count"], project_path)
            .ok()
            .and_then(|s| s.trim().parse().ok())
            .unwrap_or(0)
    } else {
        0
    };

    let mut warnings = Vec::new();
    if !is_clean {
        warnings.push(format!("{} uncommitted change(s)", uncommitted_count));
    }
    if !has_upstream {
        warnings.push("No upstream tracking branch set".to_string());
    }
    if behind_upstream > 0 {
        warnings.push(format!("{} commit(s) behind upstream", behind_upstream));
    }
    if branch.as_deref() == Some("main") || branch.as_deref() == Some("master") {
        warnings.push("On protected branch — consider creating a feature branch".to_string());
    }

    GitSafetyReport {
        is_git_repo,
        branch,
        has_upstream,
        is_clean,
        uncommitted_count,
        behind_upstream,
        warnings,
    }
}

/// P2-S1: outcome of a successful `merge_conversation_branch`. Carries the
/// squash-commit SHA plus the two cleanup flags the caller needs to flip
/// `worktree.state -> "landed"`. A `false` cleanup flag is non-fatal — the
/// merge itself already landed; it only means post-merge cleanup was
/// incomplete (e.g. the worktree was already gone).
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MergeBranchOutcome {
    /// SHA (`rev-parse HEAD`) after the squash commit. When the branch was
    /// already fully merged this is the unchanged prior HEAD.
    pub commit_sha: String,
    /// The `pkt/<convId>` branch was deleted at its expected commit.
    pub branch_deleted: bool,
    /// The conversation worktree directory was removed.
    pub worktree_removed: bool,
    /// The squash produced no commit — the branch had no changes vs. the root
    /// (already merged / empty). When true NOTHING was landed and the caller
    /// MUST NOT report "landed": no commit was created, the branch and the
    /// (verified-clean) worktree are left in place so the user can Discard
    /// explicitly. Guards against a dishonest "Landed" on an empty branch.
    pub nothing_to_land: bool,
}

/// P2-S1: land a conversation's work by squash-merging its `pkt/<convId>`
/// branch into the root checkout's current branch, then cleaning up.
///
/// Ruled safety semantics:
/// - **Dirty-root refusal.** Refuses (Err, nothing touched) when the root
///   checkout has any uncommitted change. NOTE: an active conversation
///   worktree always registers `.pkt-worktrees/` as untracked in the root,
///   so the clean check deliberately excludes that path — a literal
///   `safety_check`/`git_safety_check` (which counts it) would refuse every
///   merge. Real user dirt (tracked-file edits, other untracked files)
///   still refuses.
/// - **Conflict recovery.** `git merge --squash` records no `MERGE_HEAD`,
///   so `git merge --abort` does not apply; on any merge failure we
///   `git reset --hard HEAD` (safe precisely because the root was verified
///   clean) leaving BOTH the root checkout AND the conversation worktree
///   byte-identical to their pre-merge state. Returns Err.
/// - **Success.** Creates the squash commit, then removes the unchanged clean
///   worktree and deletes the source ref at the expected commit.
pub fn merge_conversation_branch(
    project_path: &str,
    branch: &str,
    squash: bool,
) -> Result<MergeBranchOutcome, String> {
    validate_branch_name(branch)?;
    let expected_sha = conversation_branch_head(project_path, branch)?;
    merge_conversation_branch_at_ref(project_path, branch, squash, &expected_sha)
}

/// Land the exact reviewed commit, even if the source branch moves while Git
/// runs hooks or creates the destination commit. Cleanup locks and compares the
/// source ref before removing its worktree, so newer work is retained.
pub fn merge_conversation_branch_at_ref(
    project_path: &str,
    branch: &str,
    squash: bool,
    expected_sha: &str,
) -> Result<MergeBranchOutcome, String> {
    validate_branch_name(branch)?;
    if !matches!(expected_sha.len(), 40 | 64)
        || !expected_sha.bytes().all(|byte| byte.is_ascii_hexdigit())
    {
        return Err("The reviewed commit must be a full Git commit SHA.".to_string());
    }
    let expected_sha = expected_sha.to_ascii_lowercase();
    if conversation_branch_head(project_path, branch)? != expected_sha {
        return Err(
            "The retained branch changed after review. Review it again before landing.".to_string(),
        );
    }

    // --- Dirty-root guard (git_safety_check semantics; see doc note) -----
    if get_branch(project_path).is_err() {
        return Err("Not a git repository".to_string());
    }
    let dirt = root_dirt_ignoring_worktrees(project_path)?;
    if !dirt.is_empty() {
        return Err(format!(
            "Cannot land: the root checkout has {} uncommitted change(s). Commit or stash them first.",
            dirt.len()
        ));
    }

    // --- Dirty-worktree guard (ruled: "every non-Discard removal path
    // dirty-checks first" / "Discard is the only path allowed to remove a
    // dirty tree"). Forced removal would silently blow away uncommitted work (tracked edits OR
    // untracked agent output) that a squash of only the *committed* branch
    // tip never lands. Refuse first, touching nothing. -------------------
    let wt_dirt = conversation_worktree_dirt(project_path, branch)?;
    if !wt_dirt.is_empty() {
        return Err(format!(
            "Cannot land: the conversation worktree has {} uncommitted change(s). Commit them in the worktree first (Finish → Commit), then land.",
            wt_dirt.len()
        ));
    }

    // --- Merge (+ explicit conflict recovery) ----------------------------
    let head_before = git_command_result(&["rev-parse", "HEAD"], project_path)?;
    let commit_sha = squash_merge_into_head(project_path, &expected_sha, branch, squash)?;

    // Nothing was landed: the squash staged no changes (branch already merged
    // / empty), so HEAD did not move. Do NOT clean up and do NOT report as a
    // landing — leave the (verified-clean) worktree + branch so the user can
    // Discard explicitly rather than get a dishonest "Landed" on empty work.
    if commit_sha == head_before {
        return Ok(MergeBranchOutcome {
            commit_sha,
            branch_deleted: false,
            worktree_removed: false,
            nothing_to_land: true,
        });
    }

    // --- Cleanup (best-effort; the merge already landed) -----------------
    let (worktree_removed, branch_deleted) =
        cleanup_conversation_branch_at_ref(project_path, branch, &expected_sha);

    Ok(MergeBranchOutcome {
        commit_sha,
        branch_deleted,
        worktree_removed,
        nothing_to_land: false,
    })
}

fn conversation_branch_head(project_path: &str, branch: &str) -> Result<String, String> {
    git_command_result(
        &[
            "rev-parse",
            "--verify",
            &format!("refs/heads/{branch}^{{commit}}"),
        ],
        project_path,
    )
}

/// Hold a compare-and-swap deletion transaction open during worktree cleanup.
/// A plain check followed by `worktree remove` could remove newer committed
/// files if another process advanced the branch between those commands.
fn cleanup_conversation_branch_at_ref(
    project_path: &str,
    branch: &str,
    expected_sha: &str,
) -> (bool, bool) {
    use std::io::{BufRead, BufReader, Write};
    use std::process::Stdio;

    let mut command = Command::new("git");
    command
        .args(["update-ref", "--no-deref", "--stdin"])
        .current_dir(project_path)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    hide_window(&mut command);
    let Ok(mut child) = command.spawn() else {
        return (false, false);
    };
    let mut worktree_removed = false;
    let deleted = (|| -> Option<bool> {
        let mut input = child.stdin.take()?;
        let mut output = BufReader::new(child.stdout.take()?);
        write!(
            input,
            "start\ndelete refs/heads/{branch} {expected_sha}\nprepare\n"
        )
        .ok()?;
        input.flush().ok()?;
        for expected_reply in ["start: ok", "prepare: ok"] {
            let mut reply = String::new();
            output.read_line(&mut reply).ok()?;
            if reply.trim() != expected_reply {
                return None;
            }
        }

        // The ref is now locked at the reviewed SHA. A newly dirty worktree
        // must still survive: removal deliberately does not use --force.
        worktree_removed =
            remove_conversation_worktree_dir_at_ref(project_path, branch, expected_sha);
        let checked_out = format!("branch refs/heads/{branch}");
        let worktrees =
            git_command_result(&["worktree", "list", "--porcelain"], project_path).ok()?;
        if worktrees.lines().any(|line| line == checked_out) {
            // Dropping stdin aborts the transaction and leaves this ref intact.
            return Some(false);
        }
        input.write_all(b"commit\n").ok()?;
        input.flush().ok()?;
        let mut reply = String::new();
        output.read_line(&mut reply).ok()?;
        Some(reply.trim() == "commit: ok")
    })()
    .unwrap_or(false);
    // All stdin handles have been dropped, so EOF also aborts an uncommitted
    // transaction. Reap the helper before returning and releasing its locks.
    let success = child.wait().is_ok_and(|status| status.success());
    (worktree_removed, deleted && success)
}

/// Non-empty `git status --short` lines for the conversation worktree that
/// `branch` (`pkt/<convId>`) is checked out in. Empty when the worktree dir is
/// absent or `branch` is not a `pkt/` branch (nothing to force-remove). Any
/// uncommitted change here — a tracked edit OR an untracked file — counts as
/// dirty, matching `isWorktreeDirty` on the TS side, so Merge back refuses
/// rather than `git worktree remove --force` over unsaved work.
fn conversation_worktree_dirt(project_path: &str, branch: &str) -> Result<Vec<String>, String> {
    let conv_id = match branch.strip_prefix("pkt/") {
        Some(id) if !id.is_empty() => id,
        _ => return Ok(Vec::new()),
    };
    let path = match crate::core::worktree::worktree_path(project_path, conv_id) {
        Ok(p) => p,
        Err(_) => return Ok(Vec::new()),
    };
    if !std::path::Path::new(&path).exists() {
        return Ok(Vec::new());
    }
    let out = git_command_result(&["status", "--short"], &path)?;
    Ok(out
        .lines()
        .map(|l| l.trim_end().to_string())
        .filter(|l| !l.is_empty())
        .collect())
}

/// Non-empty lines from `git status --short` with the `.pkt-worktrees/`
/// worktree parent excluded — an active conversation worktree always shows
/// up there as untracked and must not count as user dirt.
fn root_dirt_ignoring_worktrees(project_path: &str) -> Result<Vec<String>, String> {
    let out = git_command_result(
        &["status", "--short", "--", ".", ":(exclude).pkt-worktrees"],
        project_path,
    )?;
    Ok(out
        .lines()
        .map(|l| l.trim_end().to_string())
        .filter(|l| !l.is_empty())
        .collect())
}

/// Squash-merge `branch` into HEAD and create the commit. On any merge
/// failure, recover the root to its pre-merge clean state and return Err.
fn squash_merge_into_head(
    project_path: &str,
    source_ref: &str,
    branch_label: &str,
    squash: bool,
) -> Result<String, String> {
    let mut args: Vec<&str> = vec!["merge"];
    if squash {
        args.push("--squash");
    } else {
        args.push("--no-ff");
        args.push("--no-edit");
    }
    args.push(source_ref);

    let output = git_command(&args, project_path)?;
    if !output.status.success() {
        // Recover. `--abort` handles the `--no-ff` case (has MERGE_HEAD); it
        // is a harmless no-op for squash (no MERGE_HEAD). The unconditional
        // hard reset restores index + working tree to the pre-merge HEAD —
        // safe because the caller verified the root was clean, so nothing of
        // the user's is discarded.
        let _ = git_command(&["merge", "--abort"], project_path);
        let _ = git_command(&["reset", "--hard", "HEAD"], project_path);
        let stdout = String::from_utf8_lossy(&output.stdout);
        let stderr = String::from_utf8_lossy(&output.stderr);
        let conflicted = stdout.contains("CONFLICT") || stderr.contains("CONFLICT");
        let detail = {
            let s = stderr.trim();
            if s.is_empty() {
                stdout.trim().to_string()
            } else {
                s.to_string()
            }
        };
        return Err(if conflicted {
            format!(
                "Merge conflict — nothing was landed; your checkout and the worktree are unchanged. {}",
                detail
            )
        } else {
            format!("Merge failed — nothing was landed. {}", detail)
        });
    }

    if squash {
        // `git merge --squash` stages without committing. If nothing was
        // staged the branch was already merged / empty — return HEAD.
        if !has_staged_changes(project_path)? {
            return git_command_result(&["rev-parse", "HEAD"], project_path);
        }
        let msg = format!("Merge branch '{}' (squash)", branch_label);
        let commit = git_command(&["commit", "-m", &msg], project_path)?;
        if !commit.status.success() {
            let _ = git_command(&["reset", "--hard", "HEAD"], project_path);
            let stderr = String::from_utf8_lossy(&commit.stderr).trim().to_string();
            return Err(format!("Squash commit failed — nothing landed. {}", stderr));
        }
    }
    git_command_result(&["rev-parse", "HEAD"], project_path)
}

/// Remove the unchanged, clean worktree dir for `pkt/<convId>` via
/// `git worktree remove` (which also prunes the admin metadata). Returns true when the
/// dir is gone afterwards. Best-effort: derives the conv id from the `pkt/`
/// branch prefix and reuses `worktree::worktree_path`.
fn remove_conversation_worktree_dir_at_ref(
    project_path: &str,
    branch: &str,
    expected_sha: &str,
) -> bool {
    let conv_id = match branch.strip_prefix("pkt/") {
        Some(id) if !id.is_empty() => id,
        _ => return false,
    };
    let path = match crate::core::worktree::worktree_path(project_path, conv_id) {
        Ok(p) => p,
        Err(_) => return false,
    };
    if !std::path::Path::new(&path).exists() {
        return true;
    }
    if get_branch(&path).as_deref() != Ok(branch)
        || git_command_result(&["rev-parse", "HEAD"], &path).as_deref() != Ok(expected_sha)
    {
        return false;
    }
    git_command(&["worktree", "remove", &path], project_path)
        .map(|o| o.status.success())
        .unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    /// Init a throwaway git repo in a unique temp dir with one committed
    /// file. Mirrors the tempdir convention used elsewhere (no extra
    /// dev-dependency). Returns the repo path.
    fn fixture_repo(tag: &str, rel: &str, committed: &str) -> std::path::PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let dir = std::env::temp_dir().join(format!("packetbench-githead-{}-{}", tag, nanos));
        std::fs::create_dir_all(&dir).expect("create temp repo dir");
        let run = |args: &[&str]| {
            let ok = Command::new("git")
                .args(args)
                .current_dir(&dir)
                .output()
                .expect("git run")
                .status
                .success();
            assert!(ok, "git {:?} failed", args);
        };
        run(&["init", "-q"]);
        run(&["config", "user.email", "test@packetbench.test"]);
        run(&["config", "user.name", "PacketBench Test"]);
        std::fs::write(dir.join(rel), committed).expect("write file");
        run(&["add", rel]);
        run(&["commit", "-q", "-m", "init"]);
        dir
    }

    #[test]
    fn get_file_head_content_returns_committed_version_not_working_copy() {
        let repo = fixture_repo("committed", "foo.txt", "line1\n");
        let path = repo.to_string_lossy().to_string();
        // Dirty the working copy — HEAD content must still be the committed one.
        std::fs::write(repo.join("foo.txt"), "line1\nline2\n").unwrap();
        let head = get_file_head_content(&path, "foo.txt").expect("ok");
        assert_eq!(head, Some("line1\n".to_string()));
        let _ = std::fs::remove_dir_all(&repo);
    }

    #[test]
    fn get_file_head_content_is_none_for_untracked_file() {
        let repo = fixture_repo("untracked", "foo.txt", "hi\n");
        let path = repo.to_string_lossy().to_string();
        std::fs::write(repo.join("new.txt"), "brand new\n").unwrap();
        let head = get_file_head_content(&path, "new.txt").expect("ok");
        assert_eq!(head, None);
        let _ = std::fs::remove_dir_all(&repo);
    }

    #[test]
    fn validate_branch_name_rejects_flag_injection() {
        assert!(validate_branch_name("--delete").is_err());
        assert!(validate_branch_name("-D").is_err());
    }

    #[test]
    fn validate_branch_name_rejects_empty() {
        assert!(validate_branch_name("").is_err());
    }

    #[test]
    fn validate_branch_name_rejects_double_dot() {
        assert!(validate_branch_name("foo..bar").is_err());
    }

    #[test]
    fn validate_branch_name_rejects_bad_suffixes() {
        assert!(validate_branch_name("branch/").is_err());
        assert!(validate_branch_name("branch.lock").is_err());
        assert!(validate_branch_name("branch.").is_err());
    }

    #[test]
    fn validate_branch_name_rejects_special_chars() {
        assert!(validate_branch_name("feat ~thing").is_err());
        assert!(validate_branch_name("feat^thing").is_err());
        assert!(validate_branch_name("feat:thing").is_err());
        assert!(validate_branch_name("feat\\thing").is_err());
    }

    #[test]
    fn validate_branch_name_accepts_valid_names() {
        assert!(validate_branch_name("feature/foo").is_ok());
        assert!(validate_branch_name("fix-123").is_ok());
        assert!(validate_branch_name("release/v1.0.0").is_ok());
        assert!(validate_branch_name("my_branch").is_ok());
    }

    #[test]
    fn append_packetbench_context_trailers_adds_flight_task_metadata() {
        let msg = append_packetbench_context_trailers(
            "feat: land work",
            &GitCommitContext {
                flight_id: Some("flight-123".to_string()),
                task_id: Some("task-456".to_string()),
                ..GitCommitContext::default()
            },
        );
        assert!(msg.contains("PacketBench-Flight: flight-123"));
        assert!(msg.contains("PacketBench-Task: task-456"));
        assert!(msg.starts_with("feat: land work\n\n"));
    }

    #[test]
    fn append_packetbench_context_trailers_sanitizes_control_chars() {
        let msg = append_packetbench_context_trailers(
            "fix: thing\n",
            &GitCommitContext {
                conversation_id: Some("conv-1\nBAD".to_string()),
                ..GitCommitContext::default()
            },
        );
        assert!(msg.contains("PacketBench-Conversation: conv-1BAD"));
        assert!(!msg.contains("\nBAD"));
    }

    // v0.8-15 — workspace auto-bind helpers
    #[test]
    fn parse_github_remote_ssh_form() {
        assert_eq!(
            parse_github_remote("git@github.com:packetloss404/PacketBench.git"),
            Some(("packetloss404".to_string(), "PacketBench".to_string()))
        );
    }

    #[test]
    fn parse_github_remote_https_with_git_suffix() {
        assert_eq!(
            parse_github_remote("https://github.com/foo/bar.git"),
            Some(("foo".to_string(), "bar".to_string()))
        );
    }

    #[test]
    fn parse_github_remote_https_without_git_suffix() {
        assert_eq!(
            parse_github_remote("https://github.com/foo/bar"),
            Some(("foo".to_string(), "bar".to_string()))
        );
    }

    #[test]
    fn parse_github_remote_trailing_slash() {
        assert_eq!(
            parse_github_remote("https://github.com/foo/bar/"),
            Some(("foo".to_string(), "bar".to_string()))
        );
    }

    #[test]
    fn parse_github_remote_rejects_non_github_host() {
        assert_eq!(parse_github_remote("https://gitlab.com/foo/bar.git"), None);
        assert_eq!(parse_github_remote("git@gitlab.com:foo/bar.git"), None);
    }

    #[test]
    fn parse_github_remote_rejects_malformed() {
        assert_eq!(parse_github_remote(""), None);
        assert_eq!(parse_github_remote("not a url"), None);
        assert_eq!(parse_github_remote("https://github.com/just-owner"), None);
        assert_eq!(
            parse_github_remote("https://github.com/owner/repo/tree/main"),
            None
        );
    }

    // P1-15 — per-file staging path validation
    #[test]
    fn validate_stage_path_rejects_empty() {
        assert!(validate_stage_path("").is_err());
    }

    #[test]
    fn validate_stage_path_rejects_whitespace_only() {
        assert!(validate_stage_path("  ").is_err());
    }

    #[test]
    fn validate_stage_path_rejects_nul_byte() {
        assert!(validate_stage_path("a\0b").is_err());
    }

    #[test]
    fn validate_stage_path_accepts_normal_paths() {
        assert!(validate_stage_path("src/main.rs").is_ok());
        // Allowed because the `--` end-of-options separator in
        // `stage_files`/`unstage_files` prevents this from being
        // interpreted as a flag.
        assert!(validate_stage_path("-weird").is_ok());
    }

    // ----------------------------------------------------------------
    // P2-S1 — merge_conversation_branch fixture tests
    // ----------------------------------------------------------------

    /// Run git in `dir`, asserting success.
    fn git_ok(dir: &std::path::Path, args: &[&str]) {
        let ok = Command::new("git")
            .args(args)
            .current_dir(dir)
            .output()
            .expect("git run")
            .status
            .success();
        assert!(ok, "git {:?} failed in {:?}", args, dir);
    }

    /// Build a fixture repo with one committed file plus a conversation
    /// worktree at `.pkt-worktrees/<conv_id>` on branch `pkt/<conv_id>`,
    /// mirroring how `create_local_worktree` provisions them. Returns the
    /// root repo path.
    fn fixture_repo_with_worktree(tag: &str, conv_id: &str) -> std::path::PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let root = std::env::temp_dir().join(format!("packetbench-merge-{}-{}", tag, nanos));
        std::fs::create_dir_all(&root).expect("create temp repo dir");
        git_ok(&root, &["init", "-q"]);
        git_ok(&root, &["config", "user.email", "test@packetbench.test"]);
        git_ok(&root, &["config", "user.name", "PacketBench Test"]);
        // Keep fixture bytes deterministic on Windows hosts where the user's
        // global core.autocrlf setting would otherwise rewrite LF on checkout.
        git_ok(&root, &["config", "core.autocrlf", "false"]);
        git_ok(&root, &["config", "core.eol", "lf"]);
        // Deterministic base-branch name across git versions/hosts.
        git_ok(&root, &["checkout", "-q", "-b", "main"]);
        std::fs::write(root.join("f.txt"), "base\n").expect("write f.txt");
        git_ok(&root, &["add", "f.txt"]);
        git_ok(&root, &["commit", "-q", "-m", "init"]);
        // Provision the conversation worktree the way the app does.
        let wt = format!(".pkt-worktrees/{}", conv_id);
        let branch = format!("pkt/{}", conv_id);
        git_ok(
            &root,
            &["worktree", "add", "-q", "-b", &branch, &wt, "main"],
        );
        root
    }

    #[test]
    fn merge_conversation_branch_squash_lands_and_cleans_up() {
        let conv = "conv1";
        let root = fixture_repo_with_worktree("happy", conv);
        let wt = root.join(".pkt-worktrees").join(conv);
        // Do work + commit inside the worktree.
        std::fs::write(wt.join("f.txt"), "base\nfrom-conv\n").unwrap();
        std::fs::write(wt.join("added.txt"), "new\n").unwrap();
        git_ok(&wt, &["add", "-A"]);
        git_ok(&wt, &["commit", "-q", "-m", "conv work"]);

        let base = root.to_string_lossy().to_string();
        let out = merge_conversation_branch(&base, &format!("pkt/{}", conv), true)
            .expect("merge should succeed");

        // Squash commit landed on the base branch.
        let log = git_command_result(&["log", "--oneline", "-1"], &base).unwrap();
        assert!(
            log.contains("squash"),
            "expected squash commit, got: {}",
            log
        );
        assert_eq!(
            out.commit_sha,
            git_command_result(&["rev-parse", "HEAD"], &base).unwrap()
        );
        // Changes are present in the root checkout.
        assert_eq!(
            std::fs::read_to_string(root.join("f.txt")).unwrap(),
            "base\nfrom-conv\n"
        );
        assert!(root.join("added.txt").exists());
        // Branch deleted, worktree dir removed.
        assert!(out.branch_deleted);
        assert!(out.worktree_removed);
        assert!(!wt.exists(), "worktree dir should be gone");
        let branches =
            git_command_result(&["branch", "--list", &format!("pkt/{}", conv)], &base).unwrap();
        assert!(
            branches.trim().is_empty(),
            "branch should be deleted, got: {}",
            branches
        );

        let _ = std::fs::remove_dir_all(&root);
    }

    fn install_landing_hook(root: &std::path::Path, body: &str) {
        git_ok(root, &["config", "core.hooksPath", ".git/hooks"]);
        let path = root.join(".git/hooks/pre-commit");
        std::fs::write(&path, format!("#!/bin/sh\n{body}\n")).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
    }

    #[test]
    fn merge_conversation_branch_at_ref_refuses_a_branch_advanced_after_review() {
        let conv = "review-moved";
        let branch = format!("pkt/{conv}");
        let root = fixture_repo_with_worktree("review-moved", conv);
        let wt = root.join(".pkt-worktrees").join(conv);
        std::fs::write(wt.join("f.txt"), "reviewed\n").unwrap();
        git_ok(&wt, &["commit", "-qam", "reviewed"]);
        let base = root.to_string_lossy().to_string();
        let reviewed = conversation_branch_head(&base, &branch).unwrap();
        std::fs::write(wt.join("f.txt"), "unreviewed\n").unwrap();
        std::fs::write(wt.join("later.txt"), "retain newer work\n").unwrap();
        git_ok(&wt, &["add", "-A"]);
        git_ok(&wt, &["commit", "-qm", "newer work"]);
        let advanced = conversation_branch_head(&base, &branch).unwrap();
        let root_head = git_command_result(&["rev-parse", "HEAD"], &base).unwrap();

        let error = merge_conversation_branch_at_ref(&base, &branch, true, &reviewed)
            .expect_err("a stale reviewed SHA must refuse before merging");
        assert!(error.contains("changed after review"), "{error}");
        assert_eq!(
            git_command_result(&["rev-parse", "HEAD"], &base).unwrap(),
            root_head
        );
        assert_eq!(conversation_branch_head(&base, &branch).unwrap(), advanced);
        assert_eq!(
            std::fs::read_to_string(root.join("f.txt")).unwrap(),
            "base\n"
        );
        assert_eq!(
            std::fs::read_to_string(wt.join("f.txt")).unwrap(),
            "unreviewed\n"
        );
        assert!(wt.join("later.txt").exists());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn merge_conversation_branch_at_ref_keeps_a_branch_advanced_during_landing() {
        let conv = "review-hook";
        let branch = format!("pkt/{conv}");
        let root = fixture_repo_with_worktree("review-hook", conv);
        let wt = root.join(".pkt-worktrees").join(conv);
        std::fs::write(wt.join("f.txt"), "reviewed\n").unwrap();
        git_ok(&wt, &["commit", "-qam", "reviewed"]);
        let base = root.to_string_lossy().to_string();
        let reviewed = conversation_branch_head(&base, &branch).unwrap();
        std::fs::write(wt.join("f.txt"), "unreviewed\n").unwrap();
        std::fs::write(wt.join("later.txt"), "retain newer work\n").unwrap();
        git_ok(&wt, &["add", "-A"]);
        git_ok(&wt, &["commit", "-qm", "newer work"]);
        let advanced = conversation_branch_head(&base, &branch).unwrap();
        git_ok(&wt, &["reset", "--hard", &reviewed]);
        install_landing_hook(
            &root,
            &format!(
                "unset GIT_INDEX_FILE GIT_DIR GIT_WORK_TREE\ngit -C '.pkt-worktrees/{conv}' reset --hard {advanced}"
            ),
        );

        let outcome = merge_conversation_branch_at_ref(&base, &branch, true, &reviewed)
            .expect("the immutable reviewed commit can still land");
        assert!(!outcome.nothing_to_land);
        assert!(!outcome.branch_deleted, "never delete the advanced ref");
        assert!(!outcome.worktree_removed, "never remove the newer worktree");
        assert_eq!(
            std::fs::read_to_string(root.join("f.txt")).unwrap(),
            "reviewed\n"
        );
        assert!(
            !root.join("later.txt").exists(),
            "unreviewed content must not land"
        );
        assert_eq!(conversation_branch_head(&base, &branch).unwrap(), advanced);
        assert_eq!(
            std::fs::read_to_string(wt.join("f.txt")).unwrap(),
            "unreviewed\n"
        );
        assert!(wt.join("later.txt").exists());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn merge_conversation_branch_at_ref_keeps_worktree_dirt_created_during_landing() {
        let conv = "review-dirty-hook";
        let branch = format!("pkt/{conv}");
        let root = fixture_repo_with_worktree("review-dirty-hook", conv);
        let wt = root.join(".pkt-worktrees").join(conv);
        std::fs::write(wt.join("f.txt"), "reviewed\n").unwrap();
        git_ok(&wt, &["commit", "-qam", "reviewed"]);
        let base = root.to_string_lossy().to_string();
        let reviewed = conversation_branch_head(&base, &branch).unwrap();
        install_landing_hook(
            &root,
            &format!("printf 'unsaved\\n' > '.pkt-worktrees/{conv}/unsaved.txt'"),
        );

        let outcome = merge_conversation_branch_at_ref(&base, &branch, true, &reviewed)
            .expect("the reviewed code lands before cleanup notices new dirt");
        assert!(!outcome.nothing_to_land);
        assert!(!outcome.branch_deleted);
        assert!(!outcome.worktree_removed);
        assert_eq!(
            std::fs::read_to_string(root.join("f.txt")).unwrap(),
            "reviewed\n"
        );
        assert_eq!(conversation_branch_head(&base, &branch).unwrap(), reviewed);
        assert_eq!(
            std::fs::read_to_string(wt.join("unsaved.txt")).unwrap(),
            "unsaved\n"
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn merge_conversation_branch_refuses_dirty_root() {
        let conv = "conv2";
        let root = fixture_repo_with_worktree("dirty", conv);
        let wt = root.join(".pkt-worktrees").join(conv);
        std::fs::write(wt.join("f.txt"), "base\nfrom-conv\n").unwrap();
        git_ok(&wt, &["add", "-A"]);
        git_ok(&wt, &["commit", "-q", "-m", "conv work"]);
        // Dirty the ROOT (a real, tracked-file edit — not the worktree dir).
        std::fs::write(root.join("f.txt"), "base\nlocal-uncommitted\n").unwrap();

        let base = root.to_string_lossy().to_string();
        let err = merge_conversation_branch(&base, &format!("pkt/{}", conv), true)
            .expect_err("dirty root must refuse");
        assert!(err.contains("uncommitted"), "unexpected error: {}", err);
        // Nothing landed: branch + worktree still present, root edit intact.
        assert!(wt.exists());
        assert_eq!(
            std::fs::read_to_string(root.join("f.txt")).unwrap(),
            "base\nlocal-uncommitted\n"
        );
        let branches =
            git_command_result(&["branch", "--list", &format!("pkt/{}", conv)], &base).unwrap();
        assert!(
            !branches.trim().is_empty(),
            "branch must survive a refused merge"
        );

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn merge_conversation_branch_conflict_leaves_both_intact() {
        let conv = "conv3";
        let root = fixture_repo_with_worktree("conflict", conv);
        let wt = root.join(".pkt-worktrees").join(conv);
        // Worktree changes the shared line + adds a file, then commits.
        std::fs::write(wt.join("f.txt"), "from-conv\n").unwrap();
        std::fs::write(wt.join("wt-only.txt"), "wt\n").unwrap();
        git_ok(&wt, &["add", "-A"]);
        git_ok(&wt, &["commit", "-q", "-m", "conv work"]);
        // Root diverges on the SAME line and commits (root stays clean).
        std::fs::write(root.join("f.txt"), "from-root\n").unwrap();
        git_ok(&root, &["add", "f.txt"]);
        git_ok(&root, &["commit", "-q", "-m", "root diverge"]);

        let base = root.to_string_lossy().to_string();
        // Capture byte-level pre-state of both checkouts.
        let root_head_before = git_command_result(&["rev-parse", "HEAD"], &base).unwrap();
        let root_f_before = std::fs::read(root.join("f.txt")).unwrap();
        let wt_f_before = std::fs::read(wt.join("f.txt")).unwrap();
        let wt_only_before = std::fs::read(wt.join("wt-only.txt")).unwrap();

        let err = merge_conversation_branch(&base, &format!("pkt/{}", conv), true)
            .expect_err("conflict must be refused");
        assert!(err.contains("conflict"), "unexpected error: {}", err);

        // Root checkout is byte-identical (HEAD + working file) and clean.
        assert_eq!(
            git_command_result(&["rev-parse", "HEAD"], &base).unwrap(),
            root_head_before
        );
        assert_eq!(std::fs::read(root.join("f.txt")).unwrap(), root_f_before);
        assert!(
            root_dirt_ignoring_worktrees(&base).unwrap().is_empty(),
            "root must be clean after conflict recovery"
        );
        // Worktree untouched (branch + files intact, byte-identical).
        assert!(wt.exists());
        assert_eq!(std::fs::read(wt.join("f.txt")).unwrap(), wt_f_before);
        assert_eq!(
            std::fs::read(wt.join("wt-only.txt")).unwrap(),
            wt_only_before
        );
        let branches =
            git_command_result(&["branch", "--list", &format!("pkt/{}", conv)], &base).unwrap();
        assert!(
            !branches.trim().is_empty(),
            "branch must survive a conflict"
        );

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn merge_conversation_branch_rejects_flag_injection_branch() {
        let root = fixture_repo_with_worktree("inject", "conv4");
        let base = root.to_string_lossy().to_string();
        assert!(merge_conversation_branch(&base, "--delete", true).is_err());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn merge_conversation_branch_refuses_dirty_worktree() {
        // Ruled invariant: no non-Discard path removes a dirty tree. An
        // uncommitted change in the conversation worktree (here: a brand-new
        // untracked file that a squash of the committed tip would never land)
        // must make Merge back refuse, leaving the worktree + branch intact.
        let conv = "conv5";
        let root = fixture_repo_with_worktree("dirtywt", conv);
        let wt = root.join(".pkt-worktrees").join(conv);
        // Commit one thing so the branch IS ahead of base...
        std::fs::write(wt.join("f.txt"), "base\nfrom-conv\n").unwrap();
        git_ok(&wt, &["add", "-A"]);
        git_ok(&wt, &["commit", "-q", "-m", "conv work"]);
        // ...but leave an uncommitted tail in the worktree (tracked edit +
        // untracked agent output) that force-removal would silently destroy.
        std::fs::write(wt.join("f.txt"), "base\nfrom-conv\nuncommitted-tail\n").unwrap();
        std::fs::write(wt.join("agent-output.txt"), "unsaved\n").unwrap();

        let base = root.to_string_lossy().to_string();
        let root_head_before = git_command_result(&["rev-parse", "HEAD"], &base).unwrap();
        let err = merge_conversation_branch(&base, &format!("pkt/{}", conv), true)
            .expect_err("dirty worktree must refuse");
        assert!(err.contains("uncommitted"), "unexpected error: {}", err);

        // Nothing removed: worktree dir + its unsaved files survive, branch
        // survives, root HEAD unchanged (no squash commit landed).
        assert!(wt.exists(), "dirty worktree must not be force-removed");
        assert_eq!(
            std::fs::read_to_string(wt.join("f.txt")).unwrap(),
            "base\nfrom-conv\nuncommitted-tail\n"
        );
        assert!(
            wt.join("agent-output.txt").exists(),
            "untracked work must survive"
        );
        assert_eq!(
            git_command_result(&["rev-parse", "HEAD"], &base).unwrap(),
            root_head_before
        );
        let branches =
            git_command_result(&["branch", "--list", &format!("pkt/{}", conv)], &base).unwrap();
        assert!(
            !branches.trim().is_empty(),
            "branch must survive a refused merge"
        );

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn merge_conversation_branch_nothing_to_land_keeps_worktree() {
        // Clean worktree with ZERO commits ahead of base: there is nothing to
        // land. The command must NOT report a landing, NOT create a commit,
        // and NOT remove the (clean) worktree/branch — the caller keeps it so
        // the user can Discard explicitly instead of seeing a false "Landed".
        let conv = "conv6";
        let root = fixture_repo_with_worktree("empty", conv);
        let wt = root.join(".pkt-worktrees").join(conv);

        let base = root.to_string_lossy().to_string();
        let head_before = git_command_result(&["rev-parse", "HEAD"], &base).unwrap();
        let out = merge_conversation_branch(&base, &format!("pkt/{}", conv), true)
            .expect("empty branch is a no-op success, not an error");

        assert!(
            out.nothing_to_land,
            "empty branch must flag nothing_to_land"
        );
        assert!(!out.branch_deleted);
        assert!(!out.worktree_removed);
        // HEAD unchanged (no squash commit), worktree + branch preserved.
        assert_eq!(out.commit_sha, head_before);
        assert_eq!(
            git_command_result(&["rev-parse", "HEAD"], &base).unwrap(),
            head_before
        );
        assert!(wt.exists(), "clean-but-empty worktree must be kept");
        let branches =
            git_command_result(&["branch", "--list", &format!("pkt/{}", conv)], &base).unwrap();
        assert!(
            !branches.trim().is_empty(),
            "branch must survive when nothing landed"
        );

        let _ = std::fs::remove_dir_all(&root);
    }
}
