use crate::core::execution::SshConfig;
use crate::core::git;
use crate::core::worktree::{self, RemoteCloneResult};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};
use tracing::{info, warn};

#[tauri::command]
pub async fn get_git_branch(project_path: String) -> Result<String, String> {
    tokio::task::spawn_blocking(move || {
        super::validate_project_path(&project_path)?;
        git::get_branch(&project_path)
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))?
}

#[tauri::command]
pub async fn get_git_status(project_path: String) -> Result<String, String> {
    tokio::task::spawn_blocking(move || {
        super::validate_project_path(&project_path)?;
        git::get_status(&project_path)
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))?
}

/// v0.8.5: payload for the `issue-watcher:fixed` Tauri event. Emitted
/// after a successful commit whose message contains one or more
/// `Fixes #N` trailers that match a known Issue (looked up in
/// `PersistedState.issues` by the trailing numeric portion of
/// `ticket_id`). The frontend `issueStore` listener consumes this and
/// flips the matching Issue to `done`.
///
/// `commit_sha` is the short SHA (`rev-parse --short HEAD`) at the time
/// of the commit; `commit_subject` is the first line of the commit
/// message. Both are best-effort — if either probe fails the values
/// default to empty strings and the listener gracefully tolerates that.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IssueFixedPayload {
    pub issue_id: String,
    pub ticket_id: String,
    pub issue_number: u32,
    pub commit_sha: String,
    pub commit_subject: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitCommitContextDto {
    #[serde(default)]
    pub flight_id: Option<String>,
    #[serde(default)]
    pub task_id: Option<String>,
    #[serde(default)]
    pub attempt_id: Option<String>,
    #[serde(default)]
    pub conversation_id: Option<String>,
    #[serde(default)]
    pub session_id: Option<String>,
}

impl From<GitCommitContextDto> for git::GitCommitContext {
    fn from(value: GitCommitContextDto) -> Self {
        Self {
            flight_id: value.flight_id,
            task_id: value.task_id,
            attempt_id: value.attempt_id,
            conversation_id: value.conversation_id,
            session_id: value.session_id,
        }
    }
}

/// v0.8.5: extract `N` from every `Fixes #N` (case-insensitive) trailer
/// in a commit message. Accepts standalone lines like `Fixes #42`,
/// `fixes #42`, `Fixes: #42`, and a handful of conventional synonyms
/// (`Closes`, `Resolves`). De-duplicated, preserving first-seen order.
///
/// Conservative: only matches when the keyword starts at the beginning
/// of a line (allowing leading whitespace) so prose like "this commit
/// fixes #42 in the docs" doesn't accidentally close issues — only
/// real trailers do.
fn parse_fixes_trailers(msg: &str) -> Vec<u32> {
    let mut out: Vec<u32> = Vec::new();
    let mut seen: std::collections::HashSet<u32> = std::collections::HashSet::new();
    for raw_line in msg.lines() {
        let line = raw_line.trim_start();
        // Find the first whitespace, `:` or `#` after a leading keyword.
        // We match three keywords: fixes / closes / resolves. Anything
        // else is left alone.
        let lower = line.to_ascii_lowercase();
        let after_kw = if lower.starts_with("fixes") {
            Some(&line[5..])
        } else if lower.starts_with("closes") {
            Some(&line[6..])
        } else if lower.starts_with("resolves") {
            Some(&line[8..])
        } else {
            None
        };
        let Some(after) = after_kw else { continue };
        // After the keyword we expect: optional `:`, then whitespace,
        // then `#` and digits. Reject anything else so "fixesthebar"
        // doesn't false-positive.
        let after = after.trim_start_matches(':');
        let after = after.trim_start();
        let Some(rest) = after.strip_prefix('#') else {
            continue;
        };
        let digits: String = rest.chars().take_while(|c| c.is_ascii_digit()).collect();
        if digits.is_empty() {
            continue;
        }
        // Reject trailing junk like `#42foo` so we don't mis-parse a
        // hash followed by a word. `#42`, `#42.`, `#42,` are all fine.
        let after_digits = &rest[digits.len()..];
        if let Some(next) = after_digits.chars().next() {
            if next.is_alphanumeric() {
                continue;
            }
        }
        let Ok(n) = digits.parse::<u32>() else {
            continue;
        };
        if seen.insert(n) {
            out.push(n);
        }
    }
    out
}

/// v0.8.5: parse the trailing numeric portion of a `ticket_id` like
/// `PKT-001` → `1`. Returns `None` when the id doesn't end in digits.
/// The matching is purely numeric and ignores the prefix, so different
/// ticket prefixes (the user-configurable `ticketPrefix` in the issue
/// store, default `PKT`) all flow through the same close-loop.
fn ticket_number(ticket_id: &str) -> Option<u32> {
    let last_dash = ticket_id.rfind('-')?;
    ticket_id[last_dash + 1..].parse::<u32>().ok()
}

/// v0.8.5: after a successful commit, emit one `issue-watcher:fixed`
/// event per `Fixes #N` trailer that resolves to a known Issue (by
/// `ticket_id` suffix match). Failures are logged at warn but never
/// propagate — the commit itself already succeeded.
fn emit_fixes_events(app_handle: &AppHandle, project_path: &str, commit_msg: &str) {
    let numbers = parse_fixes_trailers(commit_msg);
    if numbers.is_empty() {
        return;
    }

    // Best-effort SHA + subject lookup. If git rev-parse fails (e.g.
    // detached state we can't recover) we still emit with empty
    // commit_sha so the listener flips the Issue without the audit
    // metadata.
    let commit_sha = std::process::Command::new("git")
        .args(["rev-parse", "--short", "HEAD"])
        .current_dir(project_path)
        .output()
        .ok()
        .and_then(|o| {
            if o.status.success() {
                Some(String::from_utf8_lossy(&o.stdout).trim().to_string())
            } else {
                None
            }
        })
        .unwrap_or_default();

    let commit_subject = commit_msg.lines().next().unwrap_or("").trim().to_string();

    // Look up the issues persisted state. `load_state()` is sync I/O —
    // we're already on a `spawn_blocking` thread when called from
    // `git_commit`, so this is fine.
    let issues = crate::core::storage::load_state().issues;

    for number in numbers {
        let matched = issues
            .iter()
            .find(|i| ticket_number(&i.ticket_id) == Some(number));
        let Some(issue) = matched else {
            info!(
                number,
                "Fixes #N trailer found but no matching Issue in state"
            );
            continue;
        };
        if issue.status == "done" {
            info!(issue = %issue.id, number, "Issue already done, skipping watcher emit");
            continue;
        }
        let payload = IssueFixedPayload {
            issue_id: issue.id.clone(),
            ticket_id: issue.ticket_id.clone(),
            issue_number: number,
            commit_sha: commit_sha.clone(),
            commit_subject: commit_subject.clone(),
        };
        match app_handle.emit("issue-watcher:fixed", &payload) {
            Ok(_) => info!(
                issue = %issue.id,
                number,
                sha = %commit_sha,
                "Emitted issue-watcher:fixed",
            ),
            Err(e) => warn!(
                issue = %issue.id,
                error = %e,
                "Failed to emit issue-watcher:fixed event (non-fatal)",
            ),
        }
    }
}

/// P1-S4: read a file's committed `HEAD` content for the clickable
/// GitDashboard diff view. `Ok(None)` for untracked/new files or an
/// empty repo. See `git::get_file_head_content`.
#[tauri::command]
pub async fn get_file_head_content(
    project_path: String,
    rel_path: String,
) -> Result<Option<String>, String> {
    tokio::task::spawn_blocking(move || {
        super::validate_project_path(&project_path)?;
        git::get_file_head_content(&project_path, &rel_path)
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))?
}

#[tauri::command]
pub async fn git_commit(
    app_handle: AppHandle,
    project_path: String,
    message: String,
    stage_all: bool,
    context: Option<GitCommitContextDto>,
) -> Result<String, String> {
    tokio::task::spawn_blocking(move || {
        super::validate_project_path(&project_path)?;
        super::validate_input_size(&message, super::MAX_INPUT_SIZE, "Commit message")?;
        let result =
            git::commit_with_context(&project_path, &message, stage_all, context.map(Into::into))?;

        // v0.8.5: scan the committed message (read back from HEAD so we
        // include any auto-trailers the prepare-commit-msg hook just
        // appended) for `Fixes #N` lines. This is the synchronous
        // close-loop trigger — external commits made directly via the
        // terminal won't flow through here, but the common in-app commit
        // path does.
        let final_msg = std::process::Command::new("git")
            .args(["log", "-1", "--pretty=%B"])
            .current_dir(&project_path)
            .output()
            .ok()
            .and_then(|o| {
                if o.status.success() {
                    Some(String::from_utf8_lossy(&o.stdout).into_owned())
                } else {
                    None
                }
            })
            .unwrap_or_else(|| message.clone());

        emit_fixes_events(&app_handle, &project_path, &final_msg);

        Ok(result)
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))?
}

#[tauri::command]
pub async fn git_push(project_path: String) -> Result<String, String> {
    tokio::task::spawn_blocking(move || {
        super::validate_project_path(&project_path)?;
        git::push(&project_path)
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))?
}

#[tauri::command]
pub async fn git_pull(project_path: String) -> Result<String, String> {
    tokio::task::spawn_blocking(move || {
        super::validate_project_path(&project_path)?;
        git::pull(&project_path)
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))?
}

#[tauri::command]
pub async fn git_create_branch(
    project_path: String,
    branch_name: String,
    checkout: bool,
) -> Result<String, String> {
    tokio::task::spawn_blocking(move || {
        super::validate_project_path(&project_path)?;
        git::create_branch(&project_path, &branch_name, checkout)
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))?
}

/// P1-15: explicit `git add -- <paths>`. GitDashboard's per-file
/// staging control calls this before `git_commit` — `git_commit`
/// rejects `stage_all` commits, so this is the only way changes reach
/// the index through the in-app flow.
#[tauri::command]
pub async fn git_stage_files(project_path: String, paths: Vec<String>) -> Result<String, String> {
    tokio::task::spawn_blocking(move || {
        super::validate_project_path(&project_path)?;
        for p in &paths {
            super::validate_input_size(p, super::MAX_INPUT_SIZE, "File path")?;
        }
        git::stage_files(&project_path, &paths)
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))?
}

/// P1-15: explicit `git restore --staged -- <paths>` — the unstage
/// counterpart of `git_stage_files`.
#[tauri::command]
pub async fn git_unstage_files(project_path: String, paths: Vec<String>) -> Result<String, String> {
    tokio::task::spawn_blocking(move || {
        super::validate_project_path(&project_path)?;
        for p in &paths {
            super::validate_input_size(p, super::MAX_INPUT_SIZE, "File path")?;
        }
        git::unstage_files(&project_path, &paths)
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))?
}

/// v0.8-G: push a specific branch to `origin` with upstream tracking. Used
/// by the "Publish attempts as draft PRs" Flight option to push each
/// attempt's branch from inside its worktree before opening the draft PR.
/// `force=true` translates to `--force-with-lease` (safe force).
#[tauri::command]
pub async fn git_push_branch(
    project_path: String,
    branch_name: String,
    force: bool,
) -> Result<String, String> {
    tokio::task::spawn_blocking(move || {
        super::validate_project_path(&project_path)?;
        git::push_branch(&project_path, &branch_name, force)
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))?
}

/// v0.8-15: read `git remote get-url origin` so a new workspace can
/// auto-bind to its GitHub repo. Returns `Ok(None)` when the repo has
/// no `origin` remote configured (caller falls back to the manual
/// picker); `Err` only when the path is not a git repo or git itself
/// fails to spawn.
#[tauri::command]
pub async fn git_get_origin_url(project_path: String) -> Result<Option<String>, String> {
    tokio::task::spawn_blocking(move || {
        super::validate_project_path(&project_path)?;
        git::get_origin_url(&project_path)
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))?
}

#[tauri::command]
pub async fn git_safety_check(project_path: String) -> Result<git::GitSafetyReport, String> {
    tokio::task::spawn_blocking(move || {
        super::validate_project_path(&project_path)?;
        Ok(git::safety_check(&project_path))
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))?
}

/// T3.F: provision a git worktree for an Agents-pane conversation. The
/// worktree lives at `<project_path>/.pkt-worktrees/<conv_id>` on a new
/// branch `pkt/<conv_id>` based off `base_branch`. Returns the absolute
/// worktree path so the frontend can pass it to `start_api_agent_session`
/// as the conversation's `project_path` — every subsequent tool call then
/// runs inside the worktree.
///
/// Idempotent: if the worktree already exists, returns its path.
#[tauri::command]
pub async fn create_conversation_worktree(
    project_path: String,
    conv_id: String,
    base_branch: String,
) -> Result<String, String> {
    super::validate_project_path(&project_path)?;
    worktree::create_local_worktree(&project_path, &conv_id, &base_branch).await
}

/// T3.F: tear down a worktree previously created by
/// `create_conversation_worktree`. Idempotent — missing worktrees succeed.
///
/// P2-S2: `delete_branch` (default false) additionally force-deletes the
/// `pkt/<conv_id>` branch after the worktree dir is removed. The Discard flow
/// passes true so a discarded conversation leaves no dangling branch behind.
#[tauri::command]
pub async fn remove_conversation_worktree(
    project_path: String,
    conv_id: String,
    delete_branch: Option<bool>,
) -> Result<(), String> {
    super::validate_project_path(&project_path)?;
    worktree::remove_local_worktree(&project_path, &conv_id, delete_branch.unwrap_or(false)).await
}

/// P2-S1: land a conversation's `pkt/<convId>` branch into the root
/// checkout by squash-merging (the default), with ruled safety semantics.
/// Gated on the same clean-root guard as `git_safety_check`: refuses on a
/// dirty root; on conflict it recovers so BOTH the root checkout and the
/// conversation worktree are left byte-identical; on success it creates the
/// squash commit, removes the worktree dir, and force-deletes the branch
/// (`-D` — a squash leaves no ancestry for `-d`). The returned outcome lets
/// the caller flip `worktree.state -> "landed"`. `squash` defaults to
/// `true` when omitted.
///
/// The dirty-root check deliberately excludes the `.pkt-worktrees/`
/// directory: an active conversation worktree always registers it as
/// untracked in the root, so a literal `git_safety_check` would refuse every
/// merge (see `core::git::merge_conversation_branch`).
#[tauri::command]
pub async fn merge_conversation_branch(
    project_path: String,
    branch: String,
    squash: Option<bool>,
) -> Result<git::MergeBranchOutcome, String> {
    tokio::task::spawn_blocking(move || {
        super::validate_project_path(&project_path)?;
        git::merge_conversation_branch(&project_path, &branch, squash.unwrap_or(true))
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))?
}

/// v0.8.5 fix: provision a git worktree bound to a specific Issue and
/// install the `prepare-commit-msg` hook that appends `Fixes #N` plus a
/// `Run-By: PacketBench issue I-<id>` trailer to every commit made inside
/// the worktree. The worktree lives at
/// `<project_path>/.pkt-worktrees/<issue_id>` on branch `pkt/<issue_id>`.
///
/// Returns the absolute worktree path so the frontend can use it as the
/// new workspace's `projectPath`, ensuring the PTY runs inside the
/// worktree (where the hook is installed) rather than the bare project
/// root. Without this, the auto-Done close-loop never fires — commits
/// in the bare repo carry no `Fixes #N` trailer, so `git_commit`'s
/// trailer scanner has nothing to match.
///
/// Base branch is auto-detected via the current `HEAD` of the project,
/// falling back to `HEAD` when the probe fails (matches the
/// `createConversationWorktree` caller in AgentsView).
///
/// Idempotent: if the worktree already exists, the hook is re-installed
/// and the existing path is returned.
#[tauri::command]
pub async fn create_issue_worktree(
    issue_id: String,
    issue_number: u32,
    issue_title: String,
    project_path: String,
) -> Result<String, String> {
    super::validate_project_path(&project_path)?;

    // Detect the base branch from the project's current HEAD. Falls
    // back to `HEAD` (a detached-style ref git can still branch off
    // of) if the probe fails — matches the conversation-worktree
    // caller's behaviour in AgentsView.
    let base_branch = {
        let pp = project_path.clone();
        tokio::task::spawn_blocking(move || git::get_branch(&pp))
            .await
            .map_err(|e| format!("Task join error: {}", e))?
            .ok()
            .filter(|b| !b.trim().is_empty())
            .unwrap_or_else(|| "HEAD".to_string())
    };

    let issue = worktree::WorktreeIssue {
        issue_id: issue_id.clone(),
        issue_number,
        issue_title,
    };

    worktree::create_local_worktree_for_issue(&project_path, &issue_id, &base_branch, issue)
        .await
        .map_err(|e| format!("Issue worktree provision failed: {}", e))
}

/// Phase 3.3: minimum SSH config the remote git dashboard commands need.
/// The frontend builds this from a `Workspace.serverId` lookup against the
/// `serverStore`. Shared by `get_git_branch_remote`,
/// `get_git_status_remote`, and `clone_repo_remote`.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitServerConfigDto {
    pub id: String,
    pub host: String,
    pub port: u16,
    pub username: String,
    #[serde(default)]
    pub key_path: Option<String>,
    #[serde(default)]
    pub host_fingerprint: Option<String>,
}

impl GitServerConfigDto {
    fn into_ssh_config(self, remote_path: String) -> SshConfig {
        SshConfig {
            host: self.host,
            port: self.port,
            user: self.username,
            remote_path,
            key_path: self.key_path,
            auth_method: None,
            target_id: Some(self.id),
            host_fingerprint: self.host_fingerprint,
        }
    }
}

/// Phase 3.3: read the current branch on a remote SSH workspace. Mirrors
/// `get_git_branch` but routes through SSH using the saved
/// `ServerConfig`. Returns the same `String` shape so the frontend parser
/// can stay unchanged.
///
/// Errors:
/// - SSH connection failure → `"SSH ... failed: ..."` (verbatim from
///   `ssh_run`).
/// - Path not a git repo → `"Remote path '...' is not inside a git
///   repository"`.
#[tauri::command]
pub async fn get_git_branch_remote(
    server_config: GitServerConfigDto,
    remote_path: String,
) -> Result<String, String> {
    if remote_path.trim().is_empty() {
        return Err("Remote path cannot be empty".to_string());
    }
    let cfg = server_config.into_ssh_config(remote_path.clone());
    worktree::ssh_get_branch(&cfg, &remote_path).await
}

/// Phase 3.3: read `git status --short` on a remote SSH workspace. Output
/// is byte-identical to the local `get_git_status` command so the
/// frontend's `parseGitStatus` works without changes.
#[tauri::command]
pub async fn get_git_status_remote(
    server_config: GitServerConfigDto,
    remote_path: String,
) -> Result<String, String> {
    if remote_path.trim().is_empty() {
        return Err("Remote path cannot be empty".to_string());
    }
    let cfg = server_config.into_ssh_config(remote_path.clone());
    worktree::ssh_get_status(&cfg, &remote_path).await
}

const REVIEW_PATCH_DEFAULT_BYTES: usize = 65_536;
const REVIEW_PATCH_MIN_BYTES: usize = 4_096;
const REVIEW_PATCH_MAX_BYTES: usize = 131_072;

/// Bounded, transport-neutral git evidence for an independent Flight reviewer.
/// The full list of changed paths is retained even when the patch body is
/// truncated, so a reviewer can inspect omitted files with read-only tools.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitReviewEvidenceDto {
    pub base_ref: String,
    pub head_ref: String,
    pub diff_summary: String,
    pub changed_paths: Vec<String>,
    pub patch: String,
    pub patch_truncated: bool,
}

fn truncate_utf8(value: String, limit: usize) -> (String, bool) {
    if value.len() <= limit {
        return (value, false);
    }
    let mut end = limit;
    while end > 0 && !value.is_char_boundary(end) {
        end -= 1;
    }
    (value[..end].to_string(), true)
}

fn parse_changed_paths(diff_names: &str, untracked: &str) -> Vec<String> {
    let mut seen = std::collections::HashSet::new();
    diff_names
        .lines()
        .chain(untracked.lines())
        .map(str::trim)
        .filter(|path| !path.is_empty())
        .filter(|path| seen.insert((*path).to_string()))
        .map(str::to_string)
        .take(2_000)
        .collect()
}

fn local_git_read(path: &str, args: &[&str]) -> Result<String, String> {
    let mut command = std::process::Command::new("git");
    super::shared::hide_window(&mut command);
    let output = command
        .args(args)
        .current_dir(path)
        .output()
        .map_err(|e| format!("Failed to run git: {}", e))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!(
            "git {} failed (exit {}): {}",
            args.first().copied().unwrap_or("command"),
            output.status.code().unwrap_or(-1),
            stderr.trim()
        ));
    }
    Ok(String::from_utf8_lossy(&output.stdout).to_string())
}

fn build_local_review_evidence(
    project_path: &str,
    base_ref: &str,
    patch_limit: usize,
    requested_head: Option<&str>,
) -> Result<GitReviewEvidenceDto, String> {
    super::validate_project_path(project_path)?;
    let head_ref = local_git_read(
        project_path,
        &[
            "rev-parse",
            "--verify",
            &format!("{}^{{commit}}", requested_head.unwrap_or("HEAD")),
        ],
    )?
    .trim()
    .to_string();
    // Verify the requested base explicitly. Falling back to HEAD would turn a
    // missing/typoed base into an incomplete review.
    local_git_read(
        project_path,
        &["rev-parse", "--verify", &format!("{}^{{commit}}", base_ref)],
    )?;
    let diff = |flags: &[&str]| {
        let mut args = vec!["diff"];
        args.extend_from_slice(flags);
        args.push(base_ref);
        if requested_head.is_some() {
            args.push(&head_ref);
        }
        args.push("--");
        local_git_read(project_path, &args)
    };
    let summary = diff(&["--stat"])?;
    let names = diff(&["--name-only", "--diff-filter=ACDMRTUXB"])?;
    let patch = diff(&["--no-ext-diff", "--unified=3"])?;
    let untracked = if requested_head.is_none() {
        local_git_read(
            project_path,
            &["ls-files", "--others", "--exclude-standard"],
        )?
    } else {
        String::new()
    };
    let (patch, patch_truncated) = truncate_utf8(patch, patch_limit);
    Ok(GitReviewEvidenceDto {
        base_ref: base_ref.to_string(),
        head_ref,
        diff_summary: summary,
        changed_paths: parse_changed_paths(&names, &untracked),
        patch,
        patch_truncated,
    })
}

#[tauri::command]
pub async fn get_git_review_evidence(
    project_path: String,
    base_ref: String,
    server_config: Option<GitServerConfigDto>,
    max_patch_bytes: Option<usize>,
    head_ref: Option<String>,
) -> Result<GitReviewEvidenceDto, String> {
    if base_ref.trim().is_empty() {
        return Err("Review base ref cannot be empty".to_string());
    }
    super::validate_input_size(&base_ref, 512, "Review base ref")?;
    if let Some(head) = &head_ref {
        super::validate_input_size(head, 512, "Review head ref")?;
    }
    let patch_limit = max_patch_bytes
        .unwrap_or(REVIEW_PATCH_DEFAULT_BYTES)
        .clamp(REVIEW_PATCH_MIN_BYTES, REVIEW_PATCH_MAX_BYTES);

    if let Some(server_config) = server_config {
        if project_path.trim().is_empty() {
            return Err("Remote review path cannot be empty".to_string());
        }
        let cfg = server_config.into_ssh_config(project_path.clone());
        let verify = format!("{}^{{commit}}", base_ref);
        let run = |args: Vec<String>| {
            let cfg = cfg.clone();
            let path = project_path.clone();
            async move {
                let refs = args.iter().map(String::as_str).collect::<Vec<_>>();
                let (output, code) = worktree::ssh_git_read(&cfg, &path, &refs).await?;
                if code != 0 {
                    return Err(format!(
                        "remote git {} failed (exit {}): {}",
                        refs.first().copied().unwrap_or("command"),
                        code,
                        output.trim()
                    ));
                }
                Ok(output)
            }
        };
        let pinned = head_ref.is_some();
        let head_ref = run(vec![
            "rev-parse".into(),
            "--verify".into(),
            format!("{}^{{commit}}", head_ref.as_deref().unwrap_or("HEAD")),
        ])
        .await?
        .trim()
        .to_string();
        run(vec!["rev-parse".into(), "--verify".into(), verify]).await?;
        let diff = |flags: &[&str]| {
            let mut args: Vec<String> = vec!["diff".into()];
            args.extend(flags.iter().map(|flag| (*flag).to_string()));
            args.push(base_ref.clone());
            if pinned {
                args.push(head_ref.clone());
            }
            args.push("--".into());
            run(args)
        };
        let summary = diff(&["--stat"]).await?;
        let names = diff(&["--name-only", "--diff-filter=ACDMRTUXB"]).await?;
        let patch = diff(&["--no-ext-diff", "--unified=3"]).await?;
        let untracked = if !pinned {
            run(vec![
                "ls-files".into(),
                "--others".into(),
                "--exclude-standard".into(),
            ])
            .await?
        } else {
            String::new()
        };
        let (patch, patch_truncated) = truncate_utf8(patch, patch_limit);
        return Ok(GitReviewEvidenceDto {
            base_ref,
            head_ref,
            diff_summary: summary,
            changed_paths: parse_changed_paths(&names, &untracked),
            patch,
            patch_truncated,
        });
    }

    tokio::task::spawn_blocking(move || {
        build_local_review_evidence(&project_path, &base_ref, patch_limit, head_ref.as_deref())
    })
    .await
    .map_err(|e| format!("Review evidence task failed: {}", e))?
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FlightIntegrationBranchResult {
    pub branch: String,
    pub base_branch: String,
    pub base_sha: String,
    pub head_sha: String,
    pub worktree_path: String,
}

impl From<worktree::IntegrationBranchState> for FlightIntegrationBranchResult {
    fn from(value: worktree::IntegrationBranchState) -> Self {
        Self {
            branch: value.branch,
            base_branch: value.base_branch,
            base_sha: value.base_sha,
            head_sha: value.head_sha,
            worktree_path: value.worktree_path,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FlightIntegrationMergeResult {
    pub head_sha: String,
    pub conflict_files: Vec<String>,
}

fn integration_lock() -> &'static tokio::sync::Mutex<()> {
    static LOCK: std::sync::OnceLock<tokio::sync::Mutex<()>> = std::sync::OnceLock::new();
    LOCK.get_or_init(|| tokio::sync::Mutex::new(()))
}

/// Create or resume the isolated integration worktree for a cooperative Flight.
/// This never checks a branch out over the user's working tree.
#[tauri::command]
pub async fn prepare_flight_integration_branch(
    project_path: String,
    flight_id: String,
    base_branch: String,
    server_config: Option<GitServerConfigDto>,
) -> Result<FlightIntegrationBranchResult, String> {
    if base_branch.trim().is_empty() {
        return Err("Integration base branch cannot be empty".to_string());
    }
    super::validate_input_size(&flight_id, 256, "Flight id")?;
    super::validate_input_size(&base_branch, 512, "Integration base branch")?;
    let _guard = integration_lock().lock().await;
    if let Some(server_config) = server_config {
        let cfg = server_config.into_ssh_config(project_path.clone());
        return worktree::prepare_remote_integration_branch(
            &cfg,
            &project_path,
            &flight_id,
            &base_branch,
        )
        .await
        .map(Into::into);
    }
    tokio::task::spawn_blocking(move || {
        super::validate_project_path(&project_path)?;
        worktree::prepare_local_integration_branch(&project_path, &flight_id, &base_branch)
            .map(Into::into)
    })
    .await
    .map_err(|e| format!("Integration branch task failed: {}", e))?
}

/// Serially merge one accepted task branch into the Flight integration branch.
/// Conflicts are reported as data after an automatic merge abort, preserving
/// both worktrees and requiring an explicit recovery choice.
#[tauri::command]
pub async fn integrate_flight_attempt(
    integration_path: String,
    integration_branch: String,
    attempt_path: String,
    attempt_branch: String,
    server_config: Option<GitServerConfigDto>,
) -> Result<FlightIntegrationMergeResult, String> {
    let _guard = integration_lock().lock().await;
    let reviewed_head = super::flight_review::validate_integration(
        &integration_path,
        &attempt_path,
        &attempt_branch,
    )
    .await?;
    let result = if let Some(server_config) = server_config {
        let cfg = server_config.into_ssh_config(integration_path.clone());
        worktree::integrate_remote_attempt(
            &cfg,
            &integration_path,
            &integration_branch,
            &attempt_path,
            &reviewed_head,
        )
        .await?
    } else {
        let integration_path_for_task = integration_path.clone();
        let integration_branch_for_task = integration_branch.clone();
        let attempt_path_for_task = attempt_path.clone();
        let attempt_branch_for_task = reviewed_head;
        tokio::task::spawn_blocking(move || {
            super::validate_project_path(&integration_path_for_task)?;
            super::validate_project_path(&attempt_path_for_task)?;
            worktree::integrate_local_attempt(
                &integration_path_for_task,
                &integration_branch_for_task,
                &attempt_path_for_task,
                &attempt_branch_for_task,
            )
        })
        .await
        .map_err(|e| format!("Attempt integration task failed: {}", e))??
    };
    Ok(FlightIntegrationMergeResult {
        head_sha: result.head_sha,
        conflict_files: result.conflict_files,
    })
}

fn landing_attempts<'a>(
    flight: &'a crate::core::flight::Flight,
    expected_head_sha: &str,
    integration_branch: &str,
    base_branch: &str,
) -> Result<Vec<&'a crate::core::flight::Attempt>, String> {
    use crate::core::flight::{
        AttemptStatus, FlightExecutionMode, IntegrationBranchStatus, TaskStatus,
    };
    let integration = flight
        .integration_branch
        .as_ref()
        .ok_or("Flight integration is unavailable.")?;
    if flight.execution_mode != Some(FlightExecutionMode::Cooperative)
        || integration.status != IntegrationBranchStatus::Ready
        || integration.head_sha != expected_head_sha
        || integration.branch != integration_branch
        || integration.base_branch != base_branch
    {
        return Err("The Flight integration state changed. Review the current combined result before landing.".into());
    }
    let tasks: Vec<_> = flight
        .milestones
        .iter()
        .flat_map(|milestone| &milestone.tasks)
        .collect();
    if tasks.is_empty() || tasks.iter().any(|task| task.status != TaskStatus::Done) {
        return Err(
            "Every current Flight task must be accepted and integrated before final landing."
                .into(),
        );
    }
    let unique: std::collections::HashSet<_> = tasks.iter().map(|task| &task.id).collect();
    if unique.len() != tasks.len() {
        return Err("The current Flight plan contains duplicate task identities.".into());
    }
    if flight.attempts.iter().any(|attempt| {
        attempt
            .task_id
            .as_ref()
            .is_none_or(|id| !unique.contains(id))
    }) {
        return Err("The Flight has attempts outside its current task plan. Resolve the retained legacy work before final delivery.".into());
    }
    if flight.attempts.iter().any(|attempt| {
        matches!(
            attempt.status,
            AttemptStatus::Queued
                | AttemptStatus::Provisioning
                | AttemptStatus::Running
                | AttemptStatus::Reviewing
        ) || attempt
            .review_gate
            .as_ref()
            .is_some_and(|gate| gate.status == crate::core::flight::ReviewGateStatus::Running)
    }) {
        return Err("Stop or settle every builder and reviewer before final delivery.".into());
    }
    let mut latest = Vec::new();
    for task in &tasks {
        if task.depends_on.iter().any(|id| {
            id == &task.id
                || !tasks
                    .iter()
                    .any(|dependency| &dependency.id == id && dependency.status == TaskStatus::Done)
        }) {
            return Err("The current task graph has an unresolved dependency.".into());
        }
        let attempt = flight
            .attempts
            .iter()
            .filter(|attempt| attempt.task_id.as_deref() == Some(&task.id))
            .max_by_key(|attempt| attempt.started_at.unwrap_or(0))
            .ok_or("A completed task has no accepted attempt.")?;
        if attempt.status != AttemptStatus::Completed {
            return Err(
                "The latest attempt for every task must be accepted before landing.".into(),
            );
        }
        latest.push(attempt);
    }
    Ok(latest)
}

/// Explicitly land the reviewed Flight integration branch into its base
/// checkout. Clean-tree and exact-base-branch checks fail closed.
#[tauri::command]
pub async fn land_flight_integration(
    flight_id: String,
    expected_head_sha: String,
    project_path: String,
    base_branch: String,
    integration_branch: String,
    server_config: Option<GitServerConfigDto>,
) -> Result<String, String> {
    use crate::core::flight::{
        AttemptTarget, DeliveryKind, FlightDelivery, IntegrationBranchStatus,
    };
    let _guard = integration_lock().lock().await;
    let snapshot = crate::core::storage::load_state();
    let flight = snapshot
        .flights
        .iter()
        .find(|flight| flight.id == flight_id)
        .ok_or("Flight not found.")?;
    let integration = flight
        .integration_branch
        .as_ref()
        .ok_or("Flight integration is unavailable.")?;
    let latest = landing_attempts(
        flight,
        &expected_head_sha,
        &integration_branch,
        &base_branch,
    )?;
    let mut repository = latest[0].clone();
    repository.target = match &latest[0].target {
        AttemptTarget::Local { base_path, .. }
            if integration.target_kind == "local"
                && server_config.is_none()
                && base_path == &project_path =>
        {
            AttemptTarget::Local {
                base_path: base_path.clone(),
                worktree_path: base_path.clone(),
            }
        }
        AttemptTarget::Ssh {
            server_id,
            base_path,
            ..
        } if integration.target_kind == "ssh"
            && integration.target_id.as_ref() == Some(server_id)
            && server_config
                .as_ref()
                .is_some_and(|config| &config.id == server_id)
            && base_path == &project_path =>
        {
            AttemptTarget::Ssh {
                server_id: server_id.clone(),
                base_path: base_path.clone(),
                worktree_path: base_path.clone(),
            }
        }
        _ => {
            return Err(
                "The landing target does not match the saved Flight integration target.".into(),
            )
        }
    };
    if super::flight_review::read(
        &repository,
        &[
            "rev-parse",
            "--verify",
            &format!("{}^{{commit}}", integration.branch),
        ],
    )
    .await?
        != expected_head_sha
    {
        return Err("The combined integration branch changed. Review it before landing.".into());
    }
    let mut combined_worktree = repository.clone();
    match &mut combined_worktree.target {
        AttemptTarget::Local { worktree_path, .. } | AttemptTarget::Ssh { worktree_path, .. } => {
            *worktree_path = integration.worktree_path.clone()
        }
    }
    if !super::flight_review::read(
        &combined_worktree,
        &[
            "status",
            "--porcelain",
            "--untracked-files=all",
            "--ignore-submodules=none",
        ],
    )
    .await?
    .is_empty()
    {
        return Err("The combined integration worktree has uncommitted files. Commit or resolve them before final landing.".into());
    }
    for attempt in latest {
        let head = super::flight_review::reviewed_delivery_head(flight, attempt).await?;
        super::flight_review::read(
            &repository,
            &["merge-base", "--is-ancestor", &head, &expected_head_sha],
        )
        .await
        .map_err(|_| {
            "The latest accepted attempt is not included in the combined integration commit."
        })?;
    }
    if super::flight_review::read(
        &repository,
        &["merge-base", "--is-ancestor", &expected_head_sha, "HEAD"],
    )
    .await
    .is_ok()
    {
        return Err("The combined result is already included in the base checkout; no new delivery was recorded.".into());
    }
    let head = match &repository.target {
        AttemptTarget::Ssh { server_id, .. } => {
            let config =
                super::flight_attempts::resolve_server_ssh_config(server_id, &project_path)
                    .ok_or("The saved SSH target is unavailable or unverified.")?;
            if config
                .host_fingerprint
                .as_ref()
                .is_none_or(|fingerprint| fingerprint.trim().is_empty())
            {
                return Err("Pin the SSH host key before landing.".into());
            }
            worktree::land_remote_integration_branch(
                &config,
                &project_path,
                &base_branch,
                &expected_head_sha,
            )
            .await?
        }
        AttemptTarget::Local { .. } => {
            let path = project_path.clone();
            let base = base_branch.clone();
            let pinned = expected_head_sha.clone();
            tokio::task::spawn_blocking(move || {
                super::validate_project_path(&path)?;
                worktree::land_local_integration_branch(&path, &base, &pinned)
            })
            .await
            .map_err(|error| format!("Flight landing task failed: {error}"))??
        }
    };
    let delivered_head = head.clone();
    crate::core::storage::with_state_lock(move |snapshot| {
        let result = (|| {
            let flight = snapshot
                .flights
                .iter_mut()
                .find(|flight| flight.id == flight_id)
                .ok_or("Flight not found after landing.")?;
            flight.delivery = Some(FlightDelivery {
                kind: DeliveryKind::Landed,
                delivered_at: super::flight_runtime::now(),
                branch: integration_branch,
                base_branch,
                commit_sha: Some(delivered_head.clone()),
                pr_number: None,
                pr_url: None,
                attempt_id: None,
            });
            if let Some(integration) = &mut flight.integration_branch {
                integration.status = IntegrationBranchStatus::Landed;
                integration.head_sha = delivered_head;
            }
            flight.updated_at = super::flight_runtime::now();
            Ok(())
        })();
        std::future::ready(result)
    })
    .await?;
    Ok(head)
}

/// Result returned to the frontend after a successful remote clone.
/// Mirrors `core::worktree::RemoteCloneResult` but lives here so the
/// `tauri::command` signature stays in the command layer.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CloneRemoteResultDto {
    pub remote_path: String,
    pub default_branch: String,
}

impl From<RemoteCloneResult> for CloneRemoteResultDto {
    fn from(r: RemoteCloneResult) -> Self {
        Self {
            remote_path: r.remote_path,
            default_branch: r.default_branch,
        }
    }
}

/// Clone `repo_url` to `dest_path` on the SSH host described by
/// `server_config`. Behaviour & security guarantees live in
/// [`worktree::clone_repo_remote_ssh`]; this command is a thin wrapper
/// that turns the DTO into an `SshConfig`.
#[tauri::command]
pub async fn clone_repo_remote(
    server_id: String,
    server_config: GitServerConfigDto,
    repo_url: String,
    dest_path: String,
    branch: Option<String>,
) -> Result<CloneRemoteResultDto, String> {
    if !server_id.is_empty() && server_id != server_config.id {
        return Err(format!(
            "server_id '{}' does not match server_config.id '{}'",
            server_id, server_config.id
        ));
    }

    let cfg = server_config.into_ssh_config(dest_path.clone());
    let branch_ref = branch.as_deref();
    let result = worktree::clone_repo_remote_ssh(&cfg, &repo_url, &dest_path, branch_ref).await?;
    Ok(result.into())
}

// --- Remote git write commands (SSH) -----------------------------------------
//
// Mirror the local git_* write commands over SSH so the GitDashboard can lift
// its remote read-only gate. Each turns the DTO into an `SshConfig` and
// delegates to the `worktree::ssh_*` helper (which POSIX-quotes every argument).

/// Stage specific files on a remote SSH workspace (`git add -- <paths>`).
#[tauri::command]
pub async fn git_stage_files_remote(
    server_config: GitServerConfigDto,
    remote_path: String,
    paths: Vec<String>,
) -> Result<String, String> {
    if remote_path.trim().is_empty() {
        return Err("Remote path cannot be empty".to_string());
    }
    for p in &paths {
        super::validate_input_size(p, super::MAX_INPUT_SIZE, "File path")?;
    }
    let cfg = server_config.into_ssh_config(remote_path.clone());
    worktree::ssh_stage_files(&cfg, &remote_path, &paths).await
}

/// Unstage specific files on a remote SSH workspace
/// (`git restore --staged -- <paths>`).
#[tauri::command]
pub async fn git_unstage_files_remote(
    server_config: GitServerConfigDto,
    remote_path: String,
    paths: Vec<String>,
) -> Result<String, String> {
    if remote_path.trim().is_empty() {
        return Err("Remote path cannot be empty".to_string());
    }
    for p in &paths {
        super::validate_input_size(p, super::MAX_INPUT_SIZE, "File path")?;
    }
    let cfg = server_config.into_ssh_config(remote_path.clone());
    worktree::ssh_unstage_files(&cfg, &remote_path, &paths).await
}

/// Commit the staged index on a remote SSH workspace (`git commit -m <message>`).
#[tauri::command]
pub async fn git_commit_remote(
    server_config: GitServerConfigDto,
    remote_path: String,
    message: String,
) -> Result<String, String> {
    if remote_path.trim().is_empty() {
        return Err("Remote path cannot be empty".to_string());
    }
    super::validate_input_size(&message, super::MAX_INPUT_SIZE, "Commit message")?;
    if message.trim().is_empty() {
        return Err("Commit message cannot be empty".to_string());
    }
    let cfg = server_config.into_ssh_config(remote_path.clone());
    worktree::ssh_commit(&cfg, &remote_path, &message).await
}

/// S3: HEAD blob + working-tree content for one file on a remote SSH workspace,
/// so the GitDashboard per-file diff viewer works on remote rows too (it feeds
/// these two strings into the same `buildDiffRows` renderer as local diffs).
/// Either side is `null` when absent (new file → no head; deleted → no work).
#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteFileDiff {
    pub head: Option<String>,
    pub work: Option<String>,
}

/// S3: fetch the HEAD and working content of one file for the remote diff view.
/// `old_path`/`new_path` differ only for renames (diff new working vs old HEAD).
#[tauri::command]
pub async fn git_diff_file_remote(
    server_config: GitServerConfigDto,
    remote_path: String,
    old_path: String,
    new_path: String,
) -> Result<RemoteFileDiff, String> {
    if remote_path.trim().is_empty() {
        return Err("Remote path cannot be empty".to_string());
    }
    super::validate_input_size(&old_path, super::MAX_INPUT_SIZE, "File path")?;
    super::validate_input_size(&new_path, super::MAX_INPUT_SIZE, "File path")?;
    let cfg = server_config.into_ssh_config(remote_path.clone());
    let head = worktree::ssh_show_head(&cfg, &remote_path, &old_path).await?;
    let work = worktree::ssh_read_working_file(&cfg, &remote_path, &new_path).await?;
    Ok(RemoteFileDiff { head, work })
}

/// Push the current branch of a remote SSH workspace to origin.
#[tauri::command]
pub async fn git_push_remote(
    server_config: GitServerConfigDto,
    remote_path: String,
) -> Result<String, String> {
    if remote_path.trim().is_empty() {
        return Err("Remote path cannot be empty".to_string());
    }
    let cfg = server_config.into_ssh_config(remote_path.clone());
    worktree::ssh_push(&cfg, &remote_path).await
}

/// `git pull --ff-only` on a remote SSH workspace.
#[tauri::command]
pub async fn git_pull_remote(
    server_config: GitServerConfigDto,
    remote_path: String,
) -> Result<String, String> {
    if remote_path.trim().is_empty() {
        return Err("Remote path cannot be empty".to_string());
    }
    let cfg = server_config.into_ssh_config(remote_path.clone());
    worktree::ssh_pull(&cfg, &remote_path).await
}

/// Create a branch on a remote SSH workspace.
#[tauri::command]
pub async fn git_create_branch_remote(
    server_config: GitServerConfigDto,
    remote_path: String,
    branch_name: String,
    checkout: bool,
) -> Result<String, String> {
    if remote_path.trim().is_empty() {
        return Err("Remote path cannot be empty".to_string());
    }
    let cfg = server_config.into_ssh_config(remote_path.clone());
    worktree::ssh_create_branch(&cfg, &remote_path, &branch_name, checkout).await
}

// v0.8.5 — `Fixes #N` trailer parsing & ticket-id mapping tests. Kept
// alongside the parser so the canonical close-loop contract is locked
// down by the test suite.
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn final_landing_requires_current_tasks_latest_accepted_attempts_and_pinned_ready_head() {
        let mut flight: crate::core::flight::Flight = serde_json::from_str(r#"{"id":"f","title":"Final","objective":"Deliver combined work","status":"review","priority":"high","project_path":"fixture","git_branch":null,"linked_session_ids":[],"created_at":0,"updated_at":0,"completed_at":null,"total_cost":0,"total_tokens":0,"execution_mode":"cooperative",
        "integration_branch":{"branch":"integration","base_branch":"main","base_sha":"base","head_sha":"reviewed","worktree_path":"fixture/combined","target_kind":"local","status":"ready"},
        "milestones":[{"id":"m","flight_id":"f","title":"M","description":"","order":0,"status":"done","validation_criteria":[],"tasks":[{"id":"t","milestone_id":"m","flight_id":"f","title":"T","description":"","order":0,"status":"done","task_type":"implementation","agent_config_id":"api-openai","agent_args":null,"model":null,"depends_on":[],"session_id":null,"result":null,"review_packet":null,"created_at":0,"started_at":null,"completed_at":null,"cost":0,"tokens":0}]}],
        "attempts":[{"id":"a","flight_id":"f","target":{"kind":"local","base_path":"fixture","worktree_path":"fixture/a"},"agent_config_id":"api-openai","model":"m","provider":"openai","branch":"pkt/a","base_branch":"integration","session_id":"builder","status":"completed","task_id":"t","started_at":1}]}"#).unwrap();
        assert_eq!(
            landing_attempts(&flight, "reviewed", "integration", "main").unwrap()[0].id,
            "a"
        );
        assert!(landing_attempts(&flight, "stale", "integration", "main").is_err());
        let mut retry = flight.attempts[0].clone();
        retry.id = "newer".into();
        retry.started_at = Some(2);
        retry.status = crate::core::flight::AttemptStatus::Failed;
        flight.attempts.push(retry);
        assert!(landing_attempts(&flight, "reviewed", "integration", "main")
            .unwrap_err()
            .contains("latest"));
        flight.attempts.pop();
        flight.milestones[0].tasks[0].status = crate::core::flight::TaskStatus::Pending;
        assert!(landing_attempts(&flight, "reviewed", "integration", "main").is_err());
        flight.milestones[0].tasks[0].status = crate::core::flight::TaskStatus::Done;
        flight.milestones[0].tasks[0].depends_on = vec!["missing".into()];
        assert!(landing_attempts(&flight, "reviewed", "integration", "main").is_err());
        flight.milestones[0].tasks[0].depends_on.clear();
        flight.milestones[0].tasks[0].id = "replacement".into();
        assert!(landing_attempts(&flight, "reviewed", "integration", "main").is_err());
    }

    #[test]
    fn parse_fixes_trailers_matches_canonical_trailer() {
        let msg = "feat: add the thing\n\nFixes #42\nRun-By: PacketBench issue I-abc\n";
        assert_eq!(parse_fixes_trailers(msg), vec![42]);
    }

    #[test]
    fn parse_fixes_trailers_is_case_insensitive() {
        assert_eq!(parse_fixes_trailers("fixes #7"), vec![7]);
        assert_eq!(parse_fixes_trailers("FIXES #7"), vec![7]);
        assert_eq!(parse_fixes_trailers("Closes #7"), vec![7]);
        assert_eq!(parse_fixes_trailers("Resolves #7"), vec![7]);
    }

    #[test]
    fn parse_fixes_trailers_handles_colon_form() {
        // git-interpret-trailers tolerates both forms; we should too.
        assert_eq!(parse_fixes_trailers("Fixes: #99"), vec![99]);
    }

    #[test]
    fn parse_fixes_trailers_deduplicates() {
        let msg = "Fixes #1\nFixes #1\nFixes #2\n";
        assert_eq!(parse_fixes_trailers(msg), vec![1, 2]);
    }

    #[test]
    fn parse_fixes_trailers_ignores_prose_mentions() {
        // Conservative: only matches at start-of-line so a mention
        // inside the commit body doesn't false-positive.
        let msg = "feat: this also fixes #99 in the docs\n\nNo trailer here.";
        assert_eq!(parse_fixes_trailers(msg), Vec::<u32>::new());
    }

    #[test]
    fn parse_fixes_trailers_ignores_keyword_collisions() {
        // `fixesthebar` is not a trailer.
        assert_eq!(parse_fixes_trailers("fixesthebar #99"), Vec::<u32>::new());
        // `#42foo` is not a valid issue ref.
        assert_eq!(parse_fixes_trailers("Fixes #42foo"), Vec::<u32>::new());
    }

    #[test]
    fn parse_fixes_trailers_accepts_trailing_punctuation() {
        assert_eq!(parse_fixes_trailers("Fixes #42."), vec![42]);
        assert_eq!(parse_fixes_trailers("Fixes #42,"), vec![42]);
    }

    #[test]
    fn ticket_number_extracts_trailing_digits() {
        assert_eq!(ticket_number("PKT-001"), Some(1));
        assert_eq!(ticket_number("PKT-42"), Some(42));
        assert_eq!(ticket_number("ABC-007"), Some(7));
    }

    #[test]
    fn ticket_number_handles_custom_prefixes() {
        assert_eq!(ticket_number("CUSTOM-PREFIX-99"), Some(99));
    }

    #[test]
    fn ticket_number_rejects_non_numeric_tail() {
        assert_eq!(ticket_number("PKT-abc"), None);
        assert_eq!(ticket_number("PKT-"), None);
        assert_eq!(ticket_number("noprefix"), None);
    }
}
