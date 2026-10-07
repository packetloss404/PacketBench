pub mod agent;
pub mod agent_sidecar;
pub mod agents_md;
pub mod analytics;
pub mod api_agent;
pub mod api_keys;
pub mod auth_watcher;
// WI-1 — auxiliary LLM routing settings surface (see core::aux_llm).
pub mod aux_routing;
pub mod cli_account;
pub mod code_quality;
// v0.8.8 quality autofix
pub mod code_quality_autofix;
pub mod conversations;
pub mod crashes;
pub mod custom_agents;
pub mod dictation;
pub mod error_classifier;
pub mod flight_attempts;
pub mod fs;
pub mod git;
pub mod git_host_probe;
pub mod github;
pub mod history;
pub mod insights;
// LM2 — custom OpenAI-compatible endpoint configuration.
pub mod custom_compat;
// v0.8.5 — issues spec import.
pub mod flight_cost;
pub mod issues;
pub mod mcp;
pub mod memory;
pub mod minimax;
pub mod monitor_windows;
pub mod ollama;
pub mod packet_agent;
pub mod packet_agent_stream;
pub mod pricing;
pub mod project_memory;
pub mod provider_auth;
pub mod provider_endpoints;
pub mod provider_models;
pub mod provider_stats;
pub mod pty;
pub mod quality_runner;
pub mod shared;
pub mod side_chat;
pub mod skills;
pub mod slash_commands;
pub mod spec;
pub mod ssh_keys;
pub mod state;
pub mod statusline;
pub mod usage;
pub mod webview_storage_mirror;

use std::path::Path;

/// Validate that a project path is a real, existing directory.
pub fn validate_project_path(path: &str) -> Result<(), String> {
    let p = Path::new(path);
    if path.is_empty() {
        return Err("Project path cannot be empty".to_string());
    }
    if !p.is_absolute() {
        return Err(format!("Project path must be absolute: {}", path));
    }
    if !p.is_dir() {
        return Err(format!("Project path is not a directory: {}", path));
    }
    Ok(())
}

/// Longest accepted memory scope label. Generous for a deep remote path,
/// far short of anything that could be used as a smuggling channel.
const MAX_MEMORY_SCOPE_LEN: usize = 1024;

/// Validate a *memory scope label*.
///
/// The aux-LLM memory commands (`summarize_session`, `extract_patterns`) take a
/// scope only to attribute the request — neither one opens, reads, writes, or
/// executes anything at that location, and the value never reaches the model.
/// A LOCAL scope is still a real directory and is validated as one. A REMOTE
/// scope is the frontend's `ssh:<serverId>:<remotePath>` key, which names a
/// directory on another host and therefore cannot pass an `is_dir` check on
/// this machine; rejecting it is what kept remote workspaces from ever getting
/// a session summary or a learned pattern.
pub fn validate_memory_scope(scope: &str) -> Result<(), String> {
    if scope.is_empty() {
        return Err("Memory scope cannot be empty".to_string());
    }
    if scope.len() > MAX_MEMORY_SCOPE_LEN {
        return Err("Memory scope is too long".to_string());
    }
    if scope.contains('\0') {
        return Err("Memory scope contains an invalid character".to_string());
    }
    if let Some(rest) = scope.strip_prefix("ssh:") {
        // `ssh:<serverId>:<remotePath>` — both halves must be present, so a
        // bare "ssh:" cannot be used to skip validation entirely.
        return match rest.split_once(':') {
            Some((server_id, remote_path)) if !server_id.is_empty() && !remote_path.is_empty() => {
                Ok(())
            }
            _ => Err(format!("Malformed remote memory scope: {}", scope)),
        };
    }
    validate_project_path(scope)
}

/// Check that a path does not escape above the given workspace root via `..` or symlinks.
pub fn is_within_workspace(path: &str, workspace: &str) -> Result<(), String> {
    let canonical_workspace = std::fs::canonicalize(workspace)
        .map_err(|e| format!("Cannot resolve workspace '{}': {}", workspace, e))?;
    let canonical_path = std::fs::canonicalize(path)
        .map_err(|e| format!("Cannot resolve path '{}': {}", path, e))?;

    if !canonical_path.starts_with(&canonical_workspace) {
        return Err(format!(
            "Path '{}' is outside the workspace '{}'",
            path, workspace
        ));
    }
    Ok(())
}

/// Like `is_within_workspace`, but permits a not-yet-existing final
/// component so commands that create files can be validated. The parent
/// directory must exist and resolve inside the workspace.
pub fn is_within_workspace_for_write(path: &str, workspace: &str) -> Result<(), String> {
    let p = Path::new(path);
    // Existing entries (including symlinks, even dangling ones) go through
    // the strict check so symlink targets are always resolved.
    if p.symlink_metadata().is_ok() {
        return is_within_workspace(path, workspace);
    }
    // New file: the final component must be a real file name (rejects
    // paths ending in `..`), and the parent must resolve into the workspace.
    if p.file_name().is_none() {
        return Err(format!("Invalid file path '{}'", path));
    }
    let parent = p
        .parent()
        .ok_or_else(|| format!("Path '{}' has no parent directory", path))?;
    let canonical_workspace = std::fs::canonicalize(workspace)
        .map_err(|e| format!("Cannot resolve workspace '{}': {}", workspace, e))?;
    let canonical_parent = std::fs::canonicalize(parent).map_err(|e| {
        format!(
            "Parent directory does not exist: {}: {}",
            parent.display(),
            e
        )
    })?;
    if !canonical_parent.starts_with(&canonical_workspace) {
        return Err(format!(
            "Path '{}' is outside the workspace '{}'",
            path, workspace
        ));
    }
    Ok(())
}

/// Maximum allowed input size for text payloads (1 MB).
pub const MAX_INPUT_SIZE: usize = 1_000_000;

/// Maximum allowed size for PTY write payloads (64 KB).
pub const MAX_PTY_WRITE_SIZE: usize = 65_536;

/// Validate that an input string does not exceed the given size limit.
pub fn validate_input_size(input: &str, max_size: usize, field_name: &str) -> Result<(), String> {
    if input.len() > max_size {
        return Err(format!(
            "{} exceeds maximum size ({} bytes, limit {})",
            field_name,
            input.len(),
            max_size
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validate_project_path_rejects_empty() {
        let result = validate_project_path("");
        assert!(result.is_err());
    }

    #[test]
    fn validate_project_path_rejects_relative() {
        let result = validate_project_path("relative/path");
        assert!(result.is_err());
    }

    #[test]
    fn memory_scope_accepts_remote_scope_key() {
        // The whole point: a remote scope names a directory on ANOTHER host, so
        // it can never pass an is_dir check here.
        assert!(validate_memory_scope("ssh:srv-1:/srv/app").is_ok());
        assert!(validate_memory_scope("ssh:srv-1:c:/srv/app").is_ok());
    }

    #[test]
    fn memory_scope_rejects_malformed_remote_keys() {
        assert!(validate_memory_scope("ssh:").is_err());
        assert!(validate_memory_scope("ssh:srv-1").is_err());
        assert!(validate_memory_scope("ssh::/srv/app").is_err());
        assert!(validate_memory_scope("ssh:srv-1:").is_err());
    }

    #[test]
    fn memory_scope_still_validates_local_paths_as_directories() {
        assert!(validate_memory_scope("").is_err());
        assert!(validate_memory_scope("relative/path").is_err());
        let dir = tempfile::tempdir().expect("tempdir");
        assert!(validate_memory_scope(dir.path().to_str().unwrap()).is_ok());
    }

    #[test]
    fn memory_scope_rejects_oversized_and_nul_bearing_labels() {
        assert!(validate_memory_scope(&"x".repeat(MAX_MEMORY_SCOPE_LEN + 1)).is_err());
        assert!(validate_memory_scope("ssh:srv-1:/srv/\0app").is_err());
    }

    #[test]
    fn validate_input_size_accepts_within_limit() {
        let result = validate_input_size("hello", MAX_INPUT_SIZE, "test");
        assert!(result.is_ok());
    }

    #[test]
    fn validate_input_size_rejects_over_limit() {
        let big = "x".repeat(MAX_INPUT_SIZE + 1);
        let result = validate_input_size(&big, MAX_INPUT_SIZE, "test");
        assert!(result.is_err());
    }

    #[test]
    fn validate_input_size_exact_limit_passes() {
        let exact = "x".repeat(MAX_INPUT_SIZE);
        let result = validate_input_size(&exact, MAX_INPUT_SIZE, "test");
        assert!(result.is_ok());
    }

    #[test]
    fn within_workspace_for_write_accepts_new_file_in_workspace() {
        let ws = tempfile::tempdir().expect("tempdir");
        let target = ws.path().join("AGENTS.md");
        let result =
            is_within_workspace_for_write(target.to_str().unwrap(), ws.path().to_str().unwrap());
        assert!(result.is_ok(), "unexpected err: {:?}", result);
    }

    #[test]
    fn within_workspace_for_write_rejects_parent_escape() {
        let outer = tempfile::tempdir().expect("tempdir");
        let ws = outer.path().join("ws");
        std::fs::create_dir(&ws).expect("mkdir ws");
        let escape = ws.join("..").join("outside.txt");
        let result = is_within_workspace_for_write(escape.to_str().unwrap(), ws.to_str().unwrap());
        assert!(result.is_err());
    }

    #[test]
    fn within_workspace_for_write_rejects_dotdot_final_component() {
        let ws = tempfile::tempdir().expect("tempdir");
        let target = ws.path().join("..");
        let result =
            is_within_workspace_for_write(target.to_str().unwrap(), ws.path().to_str().unwrap());
        assert!(result.is_err());
    }

    #[test]
    fn within_workspace_for_write_existing_file_uses_strict_check() {
        let ws = tempfile::tempdir().expect("tempdir");
        let target = ws.path().join("existing.txt");
        std::fs::write(&target, "x").expect("write");
        let result =
            is_within_workspace_for_write(target.to_str().unwrap(), ws.path().to_str().unwrap());
        assert!(result.is_ok(), "unexpected err: {:?}", result);
    }
}

pub mod named_provider_models;
