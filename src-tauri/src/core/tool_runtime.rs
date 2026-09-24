//! Tool execution runtime for API-based agents.
//!
//! Provides a registry of tools that LLM agents can call, along with
//! JSON Schema definitions that get sent to the provider API.

use crate::core::execution::ExecutionTarget;
use crate::core::llm_types::{ToolCall, ToolDefinition, ToolResult};
use crate::core::tool_runtime_ssh;
use std::path::{Path, PathBuf};
use tracing::info;

/// Maximum file size for tool reads (2 MB).
const MAX_FILE_SIZE: u64 = 2_000_000;

/// Maximum command output size (256 KB).
const MAX_OUTPUT_SIZE: usize = 262_144;

/// Default bash command timeout in seconds.
const DEFAULT_TIMEOUT_SECS: u64 = 30;

/// Resolve a user-provided path and validate that it stays inside the workspace.
///
/// Existing path components are canonicalized so symlink targets are checked,
/// while missing leaf components are resolved after the nearest existing
/// ancestor has been canonicalized.
pub(crate) fn resolve_workspace_path(
    path: &str,
    project_path: &str,
    must_exist: bool,
) -> Result<PathBuf, String> {
    let canonical_workspace = std::fs::canonicalize(project_path)
        .map_err(|e| format!("Cannot resolve workspace: {}", e))?;

    let requested = Path::new(path);
    let full = if requested.is_absolute() {
        requested.to_path_buf()
    } else {
        Path::new(project_path).join(requested)
    };

    if must_exist || std::fs::symlink_metadata(&full).is_ok() {
        let canonical_path = std::fs::canonicalize(&full)
            .map_err(|e| format!("Cannot resolve path '{}': {}", full.display(), e))?;
        if !canonical_path.starts_with(&canonical_workspace) {
            return Err(format!("Path '{}' is outside the project workspace", path));
        }
        return Ok(canonical_path);
    }

    let mut existing = full.as_path();
    while !existing.exists() {
        existing = existing
            .parent()
            .ok_or_else(|| format!("Cannot resolve path '{}'", full.display()))?;
    }

    let canonical_existing = std::fs::canonicalize(existing)
        .map_err(|e| format!("Cannot resolve path '{}': {}", existing.display(), e))?;
    if !canonical_existing.starts_with(&canonical_workspace) {
        return Err(format!("Path '{}' is outside the project workspace", path));
    }

    let suffix = full
        .strip_prefix(existing)
        .unwrap_or_else(|_| Path::new(""));
    let mut resolved = canonical_existing;
    for component in suffix.components() {
        match component {
            std::path::Component::Normal(part) => resolved.push(part),
            std::path::Component::CurDir => {}
            std::path::Component::ParentDir => {
                resolved.pop();
            }
            std::path::Component::Prefix(_) | std::path::Component::RootDir => {
                return Err(format!("Cannot resolve path '{}'", full.display()));
            }
        }
    }

    if !resolved.starts_with(&canonical_workspace) {
        return Err(format!("Path '{}' is outside the project workspace", path));
    }

    Ok(resolved)
}

/// Validate that an existing path is within the project workspace.
fn validate_path(path: &str, project_path: &str) -> Result<String, String> {
    resolve_workspace_path(path, project_path, true).map(|p| p.to_string_lossy().to_string())
}

pub(crate) fn truncate_to_char_boundary(s: &mut String, max_bytes: usize) {
    if s.len() <= max_bytes {
        return;
    }
    let mut boundary = max_bytes;
    while boundary > 0 && !s.is_char_boundary(boundary) {
        boundary -= 1;
    }
    s.truncate(boundary);
}

/// Get all tool definitions for the API request.
///
/// Async because MCP discovery spawns child processes and performs JSON-RPC
/// over stdio. Callers must `.await` it.
pub async fn tool_definitions() -> Vec<ToolDefinition> {
    tool_definitions_with_mcp_allowlist(None).await
}

pub async fn tool_definitions_with_mcp_allowlist(
    enabled_mcp_server_ids: Option<&[String]>,
) -> Vec<ToolDefinition> {
    tool_definitions_with_mcp_trust(enabled_mcp_server_ids, None).await
}

pub async fn tool_definitions_with_mcp_trust(
    enabled_mcp_server_ids: Option<&[String]>,
    mcp_trust_snapshot: Option<&[crate::core::mcp_bridge::McpTrustSnapshot]>,
) -> Vec<ToolDefinition> {
    let agents = crate::commands::custom_agents::discover_custom_agents("");
    tool_definitions_for_session(enabled_mcp_server_ids, mcp_trust_snapshot, &agents).await
}

pub async fn tool_definitions_for_session(
    _enabled_mcp_server_ids: Option<&[String]>,
    _mcp_trust_snapshot: Option<&[crate::core::mcp_bridge::McpTrustSnapshot]>,
    custom_agents: &[crate::commands::custom_agents::CustomAgentDef],
) -> Vec<ToolDefinition> {
    let base = vec![
        ToolDefinition {
            name: "read_file".to_string(),
            description: "Read the contents of a file. Returns the file text. Use this to understand existing code before making changes.".to_string(),
            parameters: serde_json::json!({
                "type": "object",
                "properties": {
                    "path": {
                        "type": "string",
                        "description": "File path relative to the project root, or absolute path within the project."
                    }
                },
                "required": ["path"]
            }),
        },
        ToolDefinition {
            name: "write_file".to_string(),
            description: "Write content to a file. Creates the file if it doesn't exist, or overwrites it. Creates parent directories as needed.".to_string(),
            parameters: serde_json::json!({
                "type": "object",
                "properties": {
                    "path": {
                        "type": "string",
                        "description": "File path relative to the project root, or absolute path within the project."
                    },
                    "content": {
                        "type": "string",
                        "description": "The full content to write to the file."
                    }
                },
                "required": ["path", "content"]
            }),
        },
        ToolDefinition {
            name: "edit_file".to_string(),
            description: "Make a targeted edit to an existing file by replacing an exact string. PREFER THIS over write_file when changing a file that already exists — you only send the lines that change instead of the whole file. 'old_string' must match the file byte-for-byte, including all whitespace and indentation, and must be unique in the file unless 'replace_all' is true; include a few surrounding lines to make it unique. Read the file first so the match is exact.".to_string(),
            parameters: serde_json::json!({
                "type": "object",
                "properties": {
                    "path": {
                        "type": "string",
                        "description": "File path relative to the project root, or absolute path within the project. The file must already exist — use write_file to create a new file."
                    },
                    "old_string": {
                        "type": "string",
                        "description": "The exact text to replace, copied verbatim from the file including leading whitespace and indentation. Must not be empty."
                    },
                    "new_string": {
                        "type": "string",
                        "description": "The replacement text. Must differ from old_string. Use an empty string to delete the matched text."
                    },
                    "replace_all": {
                        "type": "boolean",
                        "description": "Replace every occurrence of old_string instead of requiring exactly one match. Default false."
                    }
                },
                "required": ["path", "old_string", "new_string"]
            }),
        },
        ToolDefinition {
            name: "list_directory".to_string(),
            description: "List files and directories in a given path. Returns names with [DIR] prefix for directories.".to_string(),
            parameters: serde_json::json!({
                "type": "object",
                "properties": {
                    "path": {
                        "type": "string",
                        "description": "Directory path relative to the project root. Use '.' for the project root."
                    }
                },
                "required": ["path"]
            }),
        },
        ToolDefinition {
            name: "bash".to_string(),
            description: "Execute a shell command in the project directory. Returns stdout and stderr. Use for running tests, builds, git commands, etc.".to_string(),
            parameters: serde_json::json!({
                "type": "object",
                "properties": {
                    "command": {
                        "type": "string",
                        "description": "The shell command to execute."
                    },
                    "timeout": {
                        "type": "integer",
                        "description": "Timeout in seconds (default 30, max 120)."
                    }
                },
                "required": ["command"]
            }),
        },
        ToolDefinition {
            name: "grep".to_string(),
            description: "Search for a pattern in files. Returns matching lines with file paths and line numbers.".to_string(),
            parameters: serde_json::json!({
                "type": "object",
                "properties": {
                    "pattern": {
                        "type": "string",
                        "description": "Regex pattern to search for."
                    },
                    "path": {
                        "type": "string",
                        "description": "Directory or file to search in, relative to project root. Default: '.'."
                    },
                    "include": {
                        "type": "string",
                        "description": "Glob pattern to filter files (e.g., '*.rs', '*.ts')."
                    }
                },
                "required": ["pattern"]
            }),
        },
        crate::core::tool_web::web_fetch_definition(),
        crate::core::tool_subagent::spawn_subagent_definition(),
        crate::core::tool_pull_request::create_pull_request_definition(),
    ];
    // Append MCP tool defs discovered from user-configured servers.
    let mut all = base;
    all.extend(crate::core::tool_tasks::task_tool_definitions());
    // Append custom-agent tool defs (~/.claude/agents/<name>.md).
    all.extend(crate::core::tool_custom_agent::custom_agent_definitions(
        custom_agents,
    ));
    // Append GitHub tools (gh_list_issues, gh_get_issue, gh_list_prs).
    all.extend(crate::core::tool_github::github_tool_definitions());
    all
}

/// Execute a tool call against either the local project or a remote SSH host.
pub async fn execute_tool(call: &ToolCall, target: &ExecutionTarget) -> ToolResult {
    execute_tool_with_mcp_allowlist(call, target, None).await
}

pub async fn execute_tool_with_mcp_allowlist(
    call: &ToolCall,
    target: &ExecutionTarget,
    enabled_mcp_server_ids: Option<&[String]>,
) -> ToolResult {
    execute_tool_with_mcp_trust(call, target, enabled_mcp_server_ids, None).await
}

pub async fn execute_tool_with_mcp_trust(
    call: &ToolCall,
    target: &ExecutionTarget,
    enabled_mcp_server_ids: Option<&[String]>,
    mcp_trust_snapshot: Option<&[crate::core::mcp_bridge::McpTrustSnapshot]>,
) -> ToolResult {
    let result = match call.name.as_str() {
        "read_file" => match target {
            ExecutionTarget::Local { project_path } => {
                execute_read_file(&call.arguments, project_path).await
            }
            ExecutionTarget::Ssh { config } => {
                tool_runtime_ssh::execute_read_file(&call.arguments, config).await
            }
        },
        "write_file" => match target {
            ExecutionTarget::Local { project_path } => {
                execute_write_file(&call.arguments, project_path).await
            }
            ExecutionTarget::Ssh { config } => {
                tool_runtime_ssh::execute_write_file(&call.arguments, config).await
            }
        },
        "edit_file" => match target {
            ExecutionTarget::Local { project_path } => {
                execute_edit_file(&call.arguments, project_path).await
            }
            // Remote edits would need a read-modify-write round trip that the
            // approval gate cannot preview, so we fail closed rather than
            // half-wire it. write_file remains available over SSH.
            ExecutionTarget::Ssh { .. } => Err(EDIT_FILE_REMOTE_UNSUPPORTED.to_string()),
        },
        "list_directory" => match target {
            ExecutionTarget::Local { project_path } => {
                execute_list_directory(&call.arguments, project_path).await
            }
            ExecutionTarget::Ssh { config } => {
                tool_runtime_ssh::execute_list_directory(&call.arguments, config).await
            }
        },
        "bash" => match target {
            ExecutionTarget::Local { project_path } => {
                execute_bash(&call.arguments, project_path).await
            }
            ExecutionTarget::Ssh { config } => {
                tool_runtime_ssh::execute_bash(&call.arguments, config).await
            }
        },
        "grep" => match target {
            ExecutionTarget::Local { project_path } => {
                execute_grep(&call.arguments, project_path).await
            }
            ExecutionTarget::Ssh { config } => {
                tool_runtime_ssh::execute_grep(&call.arguments, config).await
            }
        },
        "web_fetch" => {
            // Host-agnostic: always runs from the PacketBench process.
            let _ = target;
            crate::core::tool_web::execute_web_fetch(&call.arguments).await
        }
        "spawn_subagent" => {
            // Boxed because spawn_subagent recursively calls execute_tool, and
            // async fn cannot be directly recursive without indirection.
            Box::pin(crate::core::tool_subagent::execute_spawn_subagent(
                &call.arguments,
                target,
            ))
            .await
        }
        "create_pull_request" => {
            crate::core::tool_pull_request::execute_create_pull_request(&call.arguments, target)
                .await
        }
        "task_create" => crate::core::tool_subagent::current_parent_llm()
            .ok_or_else(|| "Task tools require an active conversation".to_string())
            .and_then(|parent| {
                crate::core::tool_tasks::execute_task_create(&parent.tasks, &call.arguments)
            }),
        "task_update" => crate::core::tool_subagent::current_parent_llm()
            .ok_or_else(|| "Task tools require an active conversation".to_string())
            .and_then(|parent| {
                crate::core::tool_tasks::execute_task_update(&parent.tasks, &call.arguments)
            }),
        "task_list" => crate::core::tool_subagent::current_parent_llm()
            .ok_or_else(|| "Task tools require an active conversation".to_string())
            .and_then(|parent| {
                crate::core::tool_tasks::execute_task_list(&parent.tasks, &call.arguments)
            }),
        name if name.starts_with("mcp__") => {
            crate::core::mcp_bridge::execute_mcp_tool_with_trust(
                name,
                &call.arguments,
                enabled_mcp_server_ids,
                mcp_trust_snapshot,
            )
            .await
        }
        name if name.starts_with("gh_") => {
            // Host-agnostic: GitHub API calls go from the PacketBench process.
            let _ = target;
            crate::core::tool_github::execute_github_tool(name, &call.arguments).await
        }
        name if name.starts_with("agent_") => {
            // Boxed: custom agents recursively call execute_tool for nested tool dispatch.
            Box::pin(crate::core::tool_custom_agent::execute_custom_agent(
                name,
                &call.arguments,
                target,
            ))
            .await
        }
        _ => Err(format!("Unknown tool: {}", call.name)),
    };

    match result {
        Ok(content) => ToolResult {
            tool_call_id: call.id.clone(),
            content,
            is_error: false,
        },
        Err(err) => ToolResult {
            tool_call_id: call.id.clone(),
            content: format!("Error: {}", err),
            is_error: true,
        },
    }
}

async fn execute_read_file(args: &serde_json::Value, project_path: &str) -> Result<String, String> {
    let path = args
        .get("path")
        .and_then(|p| p.as_str())
        .ok_or("Missing 'path' parameter")?;

    let full_path = validate_path(path, project_path)?;
    info!(path = %full_path, "Tool: read_file");

    let metadata =
        std::fs::metadata(&full_path).map_err(|e| format!("Cannot access '{}': {}", path, e))?;

    if !metadata.is_file() {
        return Err(format!("'{}' is not a file", path));
    }

    if metadata.len() > MAX_FILE_SIZE {
        return Err(format!(
            "File too large ({} bytes, limit {} bytes)",
            metadata.len(),
            MAX_FILE_SIZE
        ));
    }

    std::fs::read_to_string(&full_path).map_err(|e| format!("Failed to read '{}': {}", path, e))
}

async fn execute_write_file(
    args: &serde_json::Value,
    project_path: &str,
) -> Result<String, String> {
    let path = args
        .get("path")
        .and_then(|p| p.as_str())
        .ok_or("Missing 'path' parameter")?;
    let content = args
        .get("content")
        .and_then(|c| c.as_str())
        .ok_or("Missing 'content' parameter")?;

    let full_path = resolve_workspace_path(path, project_path, false)?;
    let canonical_workspace = std::fs::canonicalize(project_path)
        .map_err(|e| format!("Cannot resolve workspace: {}", e))?;

    if let Some(parent) = full_path.parent() {
        if !parent.starts_with(&canonical_workspace) {
            return Err(format!("Path '{}' is outside the project workspace", path));
        }
        if !parent.exists() {
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("Failed to create directories: {}", e))?;
        }
        let canonical_parent =
            std::fs::canonicalize(parent).map_err(|e| format!("Cannot resolve parent: {}", e))?;
        if !canonical_parent.starts_with(&canonical_workspace) {
            return Err(format!("Path '{}' is outside the project workspace", path));
        }
    }

    if std::fs::symlink_metadata(&full_path).is_ok() {
        let canonical_target = std::fs::canonicalize(&full_path)
            .map_err(|e| format!("Cannot resolve path '{}': {}", path, e))?;
        if !canonical_target.starts_with(&canonical_workspace) {
            return Err(format!("Path '{}' is outside the project workspace", path));
        }
    }

    info!(path = %full_path.display(), "Tool: write_file");
    std::fs::write(&full_path, content)
        .map_err(|e| format!("Failed to write '{}': {}", path, e))?;

    Ok(format!(
        "Successfully wrote {} bytes to {}",
        content.len(),
        path
    ))
}

/// Error returned when `edit_file` is called on an SSH execution target.
pub(crate) const EDIT_FILE_REMOTE_UNSUPPORTED: &str =
    "edit_file is not available for remote SSH sessions. Read the file with read_file, then send the full updated content with write_file.";

/// Reserved argument the pending-edit approval gate injects when the user
/// accepts only some hunks: the exact file body to write, replacing the
/// tool's own search/replace. It is deliberately not part of the tool schema
/// and the gate strips any model-supplied value before execution.
pub(crate) const APPROVED_CONTENT_ARG: &str = "__packetbench_approved_content";

/// Maximum characters of context echoed back in an `edit_file` result.
const EDIT_SNIPPET_MAX_CHARS: usize = 800;
/// Maximum lines of context echoed back in an `edit_file` result.
const EDIT_SNIPPET_MAX_LINES: usize = 12;
/// Maximum characters of a single snippet line.
const EDIT_SNIPPET_MAX_LINE_CHARS: usize = 200;

struct EditArgs<'a> {
    path: &'a str,
    old_string: &'a str,
    new_string: &'a str,
    replace_all: bool,
}

fn parse_edit_args(args: &serde_json::Value) -> Result<EditArgs<'_>, String> {
    let path = args
        .get("path")
        .and_then(|p| p.as_str())
        .ok_or("Missing 'path' parameter")?;
    let old_string = args
        .get("old_string")
        .and_then(|s| s.as_str())
        .ok_or("Missing 'old_string' parameter")?;
    let new_string = args
        .get("new_string")
        .and_then(|s| s.as_str())
        .ok_or("Missing 'new_string' parameter")?;
    let replace_all = args
        .get("replace_all")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    Ok(EditArgs {
        path,
        old_string,
        new_string,
        replace_all,
    })
}

/// Outcome of a successful exact-string replacement.
struct EditOutcome {
    /// Full file content after the replacement(s).
    content: String,
    /// Number of occurrences replaced.
    replacements: usize,
    /// Byte offset of the first replacement. Valid in both the before and
    /// after strings — everything ahead of it is byte-identical.
    first_offset: usize,
}

/// Apply exact-string replacement with no silent fallbacks: an absent match,
/// an ambiguous match, an empty needle, or a no-op edit are all hard errors so
/// the model has to fix its input instead of corrupting the file.
fn apply_exact_edit(
    content: &str,
    old_string: &str,
    new_string: &str,
    replace_all: bool,
) -> Result<EditOutcome, String> {
    if old_string.is_empty() {
        return Err(
            "'old_string' must not be empty. To create a new file or replace an entire file, use write_file instead."
                .to_string(),
        );
    }
    if old_string == new_string {
        return Err(
            "'old_string' and 'new_string' are identical, so this edit would change nothing."
                .to_string(),
        );
    }

    let matches: Vec<usize> = content.match_indices(old_string).map(|(i, _)| i).collect();
    if matches.is_empty() {
        return Err(
            "'old_string' was not found in the file. It must match the file exactly, including all whitespace and indentation. Re-read the file and copy the text verbatim."
                .to_string(),
        );
    }
    if matches.len() > 1 && !replace_all {
        return Err(format!(
            "'old_string' appears {} times in the file, so the edit is ambiguous and was NOT applied. Add more surrounding lines to 'old_string' so it matches exactly one location, or set 'replace_all': true to change every occurrence.",
            matches.len()
        ));
    }

    let first_offset = matches[0];
    if replace_all {
        Ok(EditOutcome {
            content: content.replace(old_string, new_string),
            replacements: matches.len(),
            first_offset,
        })
    } else {
        let mut out = String::with_capacity(content.len() + new_string.len());
        out.push_str(&content[..first_offset]);
        out.push_str(new_string);
        out.push_str(&content[first_offset + old_string.len()..]);
        Ok(EditOutcome {
            content: out,
            replacements: 1,
            first_offset,
        })
    }
}

/// Compute the post-edit file body without touching disk. Used by the
/// pending-edit approval gate to render a before/after diff for `edit_file`
/// the same way it renders one for `write_file`.
pub(crate) fn preview_edit_file(
    args: &serde_json::Value,
    before: Option<&str>,
) -> Result<String, String> {
    let edit = parse_edit_args(args)?;
    let before = before.ok_or_else(|| {
        format!(
            "Cannot read '{}'. edit_file requires an existing readable file — use write_file to create one.",
            edit.path
        )
    })?;
    let outcome = apply_exact_edit(before, edit.old_string, edit.new_string, edit.replace_all)?;
    Ok(outcome.content)
}

/// Render a compact confirmation: what changed, how many times, and a few
/// numbered lines around the first replacement so the model can verify
/// without a follow-up read_file.
fn format_edit_result(path: &str, after: &str, outcome: &EditOutcome, new_len: usize) -> String {
    let start_line = after[..outcome.first_offset].matches('\n').count();
    let end_line = after[..outcome.first_offset + new_len]
        .matches('\n')
        .count();
    let from = start_line.saturating_sub(2);
    let to = end_line + 2;

    let mut snippet = String::new();
    let mut emitted = 0usize;
    let mut omitted = 0usize;
    for (idx, line) in after.lines().enumerate() {
        if idx < from || idx > to {
            continue;
        }
        if emitted >= EDIT_SNIPPET_MAX_LINES || snippet.len() >= EDIT_SNIPPET_MAX_CHARS {
            omitted += 1;
            continue;
        }
        let mut text = line.to_string();
        truncate_to_char_boundary(&mut text, EDIT_SNIPPET_MAX_LINE_CHARS);
        if text.len() < line.len() {
            text.push('…');
        }
        snippet.push_str(&format!("{:>5} | {}\n", idx + 1, text));
        emitted += 1;
    }
    if omitted > 0 {
        snippet.push_str(&format!("      … {} more line(s)\n", omitted));
    }

    let plural = if outcome.replacements == 1 {
        "replacement"
    } else {
        "replacements"
    };
    format!(
        "Edited {} ({} {}).\n{}",
        path,
        outcome.replacements,
        plural,
        snippet.trim_end()
    )
}

async fn execute_edit_file(args: &serde_json::Value, project_path: &str) -> Result<String, String> {
    let path = args
        .get("path")
        .and_then(|p| p.as_str())
        .ok_or("Missing 'path' parameter")?;

    // must_exist = true: edit_file never creates files, and this is the same
    // symlink-resolving workspace confinement read_file enforces.
    let full_path = validate_path(path, project_path)?;

    let metadata =
        std::fs::metadata(&full_path).map_err(|e| format!("Cannot access '{}': {}", path, e))?;
    if !metadata.is_file() {
        return Err(format!("'{}' is not a file", path));
    }
    if metadata.len() > MAX_FILE_SIZE {
        return Err(format!(
            "File too large ({} bytes, limit {} bytes)",
            metadata.len(),
            MAX_FILE_SIZE
        ));
    }

    // Per-hunk acceptance: the approval gate replaced the edit with the exact
    // body the user picked.
    if let Some(approved) = args.get(APPROVED_CONTENT_ARG).and_then(|v| v.as_str()) {
        info!(path = %full_path, "Tool: edit_file (user-merged content)");
        std::fs::write(&full_path, approved)
            .map_err(|e| format!("Failed to write '{}': {}", path, e))?;
        return Ok(format!(
            "Edited {} — the user applied a modified version of this edit ({} bytes written). Re-read the file before editing it again.",
            path,
            approved.len()
        ));
    }

    let edit = parse_edit_args(args)?;
    let before = std::fs::read_to_string(&full_path)
        .map_err(|e| format!("Failed to read '{}': {}", path, e))?;

    let outcome = apply_exact_edit(&before, edit.old_string, edit.new_string, edit.replace_all)?;

    info!(path = %full_path, replacements = outcome.replacements, "Tool: edit_file");
    std::fs::write(&full_path, &outcome.content)
        .map_err(|e| format!("Failed to write '{}': {}", path, e))?;

    Ok(format_edit_result(
        path,
        &outcome.content,
        &outcome,
        edit.new_string.len(),
    ))
}

async fn execute_list_directory(
    args: &serde_json::Value,
    project_path: &str,
) -> Result<String, String> {
    let path = args.get("path").and_then(|p| p.as_str()).unwrap_or(".");

    let full_path = validate_path(path, project_path)?;
    info!(path = %full_path, "Tool: list_directory");

    let entries =
        std::fs::read_dir(&full_path).map_err(|e| format!("Failed to list '{}': {}", path, e))?;

    let skip_dirs = crate::core::shared::SKIP_DIRS;
    let mut lines: Vec<String> = Vec::new();

    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        if name.starts_with('.') {
            continue;
        }
        let is_dir = entry.metadata().map(|m| m.is_dir()).unwrap_or(false);

        if is_dir && skip_dirs.contains(&name.as_str()) {
            continue;
        }

        if is_dir {
            lines.push(format!("[DIR] {}", name));
        } else {
            lines.push(name);
        }
    }

    lines.sort();
    Ok(lines.join("\n"))
}

/// S1: force-kill an entire process tree rooted at `pid`.
///
/// `execute_bash` runs `sh -c` / `cmd /C`, which routinely fork grandchildren
/// (`foo &`, pipelines, sub-shells). `kill_on_drop` only reaps the direct child,
/// orphaning those. On timeout we kill the whole tree so nothing outlives the
/// deadline — parity with the sidecar's `killTree`.
#[cfg(unix)]
pub(crate) fn kill_process_tree(pid: u32) {
    // The child leads its own process group (see `process_group(0)` at spawn),
    // so a negative pid signals every process in that group, not just `sh`.
    unsafe {
        libc::kill(-(pid as i32), libc::SIGKILL);
    }
}

#[cfg(windows)]
pub(crate) fn kill_process_tree(pid: u32) {
    use std::os::windows::process::CommandExt;
    // taskkill walks the tree from `pid` (/T) and force-kills it (/F). It must
    // run while the root is still alive, otherwise the snapshot can't reach
    // reparented grandchildren — so the caller kills before dropping the child.
    let _ = std::process::Command::new("taskkill")
        .args(["/F", "/T", "/PID", &pid.to_string()])
        .creation_flags(0x08000000) // CREATE_NO_WINDOW
        .status();
}

async fn execute_bash(args: &serde_json::Value, project_path: &str) -> Result<String, String> {
    let command = args
        .get("command")
        .and_then(|c| c.as_str())
        .ok_or("Missing 'command' parameter")?;

    let timeout_secs = args
        .get("timeout")
        .and_then(|t| t.as_u64())
        .unwrap_or(DEFAULT_TIMEOUT_SECS)
        .min(120);

    info!(command = %command, timeout = %timeout_secs, "Tool: bash");

    let mut cmd = if cfg!(target_os = "windows") {
        let mut c = tokio::process::Command::new("cmd");
        c.args(["/C", command]);
        c
    } else {
        let mut c = tokio::process::Command::new("sh");
        c.args(["-c", command]);
        c
    };

    cmd.current_dir(project_path);
    cmd.stdout(std::process::Stdio::piped());
    cmd.stderr(std::process::Stdio::piped());
    // Backstop reap of the direct child if the `Child` is dropped; the timeout
    // path below additionally kills the whole tree (grandchildren included).
    cmd.kill_on_drop(true);

    // S1: give the child its own process group so a timeout can signal every
    // descendant, not just the `sh`/`cmd` we spawned directly.
    #[cfg(unix)]
    cmd.process_group(0);

    #[cfg(target_os = "windows")]
    {
        cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
    }

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("Failed to spawn command: {}", e))?;
    // Captured before `wait()` — `Child::id()` returns `None` once it has exited.
    let child_pid = child.id();

    // Drain stdout/stderr concurrently with the wait so a command that fills the
    // OS pipe buffer (>64 KB) can't deadlock into a false timeout. The pipe
    // handles are taken out of `child` so awaiting exit only borrows the child —
    // we keep ownership so the tree can be killed while it's still alive.
    let mut stdout_pipe = child.stdout.take();
    let mut stderr_pipe = child.stderr.take();
    let read_stdout = async {
        use tokio::io::AsyncReadExt;
        let mut buf = Vec::new();
        if let Some(p) = stdout_pipe.as_mut() {
            let _ = p.read_to_end(&mut buf).await;
        }
        buf
    };
    let read_stderr = async {
        use tokio::io::AsyncReadExt;
        let mut buf = Vec::new();
        if let Some(p) = stderr_pipe.as_mut() {
            let _ = p.read_to_end(&mut buf).await;
        }
        buf
    };

    let run = async { tokio::join!(child.wait(), read_stdout, read_stderr) };
    let (status, out_bytes, err_bytes) =
        match tokio::time::timeout(std::time::Duration::from_secs(timeout_secs), run).await {
            Ok((status_res, out, err)) => (
                status_res.map_err(|e| format!("Command failed: {}", e))?,
                out,
                err,
            ),
            Err(_) => {
                // S1: kill the whole tree before the `Child` is dropped, so
                // grandchildren don't outlive the deadline.
                if let Some(pid) = child_pid {
                    kill_process_tree(pid);
                }
                let _ = child.start_kill();
                return Err(format!("Command timed out after {} seconds", timeout_secs));
            }
        };

    let stdout = String::from_utf8_lossy(&out_bytes);
    let stderr = String::from_utf8_lossy(&err_bytes);

    let mut result = String::new();
    if !stdout.is_empty() {
        result.push_str(&stdout);
    }
    if !stderr.is_empty() {
        if !result.is_empty() {
            result.push_str("\n--- stderr ---\n");
        }
        result.push_str(&stderr);
    }

    // Truncate if too large
    if result.len() > MAX_OUTPUT_SIZE {
        truncate_to_char_boundary(&mut result, MAX_OUTPUT_SIZE);
        result.push_str("\n... [output truncated]");
    }

    let exit_code = status.code().unwrap_or(-1);
    if exit_code != 0 {
        result.push_str(&format!("\n[exit code: {}]", exit_code));
        return Err(result);
    }

    Ok(result)
}

async fn execute_grep(args: &serde_json::Value, project_path: &str) -> Result<String, String> {
    let pattern = args
        .get("pattern")
        .and_then(|p| p.as_str())
        .ok_or("Missing 'pattern' parameter")?;

    let search_path = args.get("path").and_then(|p| p.as_str()).unwrap_or(".");

    let include = args.get("include").and_then(|i| i.as_str());

    let full_path = validate_path(search_path, project_path)?;
    info!(pattern = %pattern, path = %full_path, "Tool: grep");

    let re =
        regex::Regex::new(pattern).map_err(|e| format!("Invalid regex '{}': {}", pattern, e))?;

    let skip_dirs = crate::core::shared::SKIP_DIRS;
    let mut results: Vec<String> = Vec::new();
    let max_results = 100;

    fn walk_dir(
        dir: &Path,
        re: &regex::Regex,
        include: Option<&str>,
        skip_dirs: &[&str],
        results: &mut Vec<String>,
        max_results: usize,
        base_path: &Path,
    ) {
        if results.len() >= max_results {
            return;
        }

        let entries = match std::fs::read_dir(dir) {
            Ok(e) => e,
            Err(_) => return,
        };

        for entry in entries.flatten() {
            if results.len() >= max_results {
                return;
            }

            let name = entry.file_name().to_string_lossy().to_string();
            if name.starts_with('.') {
                continue;
            }

            let path = entry.path();
            // Never follow symlinks: `read_file`/`write_file`/`edit_file`
            // canonicalize and reject an escape, so grep must not be the one
            // tool that reads through a link pointing outside the workspace.
            let metadata = match std::fs::symlink_metadata(&path) {
                Ok(m) => m,
                Err(_) => continue,
            };
            if metadata.file_type().is_symlink() {
                continue;
            }
            let is_dir = metadata.is_dir();

            if is_dir {
                if skip_dirs.contains(&name.as_str()) {
                    continue;
                }
                walk_dir(
                    &path,
                    re,
                    include,
                    skip_dirs,
                    results,
                    max_results,
                    base_path,
                );
            } else {
                // Check include glob
                if let Some(glob_pattern) = include {
                    if let Ok(glob) = glob::Pattern::new(glob_pattern) {
                        if !glob.matches(&name) {
                            continue;
                        }
                    }
                }

                // Read and search file
                if let Ok(content) = std::fs::read_to_string(&path) {
                    let rel_path = path
                        .strip_prefix(base_path)
                        .unwrap_or(&path)
                        .to_string_lossy();

                    for (line_num, line) in content.lines().enumerate() {
                        if results.len() >= max_results {
                            break;
                        }
                        if re.is_match(line) {
                            results.push(format!("{}:{}: {}", rel_path, line_num + 1, line.trim()));
                        }
                    }
                }
            }
        }
    }

    let base = Path::new(&full_path);
    walk_dir(
        base,
        &re,
        include,
        &skip_dirs,
        &mut results,
        max_results,
        base,
    );

    if results.is_empty() {
        Ok(format!("No matches found for pattern '{}'", pattern))
    } else {
        let mut output = results.join("\n");
        if results.len() >= max_results {
            output.push_str(&format!("\n... [limited to {} results]", max_results));
        }
        Ok(output)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::llm_types::ToolCall;
    use serde_json::json;
    use uuid::Uuid;

    fn temp_workspace(name: &str) -> (PathBuf, PathBuf) {
        let base = std::env::temp_dir().join("packetbench-tests").join(format!(
            "{}-{}",
            name,
            Uuid::new_v4()
        ));
        let workspace = base.join("workspace");
        std::fs::create_dir_all(&workspace).unwrap();
        (base, workspace)
    }

    #[cfg(unix)]
    fn symlink_dir(original: &Path, link: &Path) -> std::io::Result<()> {
        std::os::unix::fs::symlink(original, link)
    }

    #[cfg(windows)]
    fn symlink_dir(original: &Path, link: &Path) -> std::io::Result<()> {
        std::os::windows::fs::symlink_dir(original, link)
    }

    #[tokio::test]
    async fn write_file_rejects_escape_before_creating_parent_dirs() {
        let (base, workspace) = temp_workspace("write-escape");
        let outside = base.join("outside");
        let args = json!({
            "path": "../outside/nested/file.txt",
            "content": "nope"
        });

        let err = execute_write_file(&args, &workspace.to_string_lossy())
            .await
            .unwrap_err();

        assert!(err.contains("outside the project workspace"));
        assert!(!outside.exists());
        let _ = std::fs::remove_dir_all(base);
    }

    #[tokio::test]
    async fn write_file_rejects_symlink_parent_target_outside_workspace() {
        let (base, workspace) = temp_workspace("write-symlink");
        let outside = base.join("outside");
        std::fs::create_dir_all(&outside).unwrap();
        let link = workspace.join("link");
        if symlink_dir(&outside, &link).is_err() {
            let _ = std::fs::remove_dir_all(base);
            return;
        }
        let args = json!({
            "path": "link/evil.txt",
            "content": "nope"
        });

        let err = execute_write_file(&args, &workspace.to_string_lossy())
            .await
            .unwrap_err();

        assert!(err.contains("outside the project workspace"));
        assert!(!outside.join("evil.txt").exists());
        let _ = std::fs::remove_dir_all(base);
    }

    #[tokio::test]
    async fn grep_does_not_follow_symlinks_out_of_the_workspace() {
        let (base, workspace) = temp_workspace("grep-symlink");
        let outside = base.join("outside");
        std::fs::create_dir_all(&outside).unwrap();
        std::fs::write(outside.join("secret.txt"), "TOP_SECRET_MARKER\n").unwrap();
        std::fs::write(workspace.join("inside.txt"), "TOP_SECRET_MARKER\n").unwrap();
        let link = workspace.join("link");
        if symlink_dir(&outside, &link).is_err() {
            let _ = std::fs::remove_dir_all(base);
            return;
        }

        let out = execute_grep(
            &json!({ "pattern": "TOP_SECRET_MARKER" }),
            &workspace.to_string_lossy(),
        )
        .await
        .unwrap();

        assert!(out.contains("inside.txt"), "{out}");
        assert!(
            !out.contains("secret.txt"),
            "grep must not read through a symlink that leaves the workspace: {out}"
        );
        let _ = std::fs::remove_dir_all(base);
    }

    /* ------------------------------ edit_file ------------------------------ */

    const SAMPLE: &str = "fn main() {\n    let x = 1;\n    println!(\"{}\", x);\n}\n";

    fn seed(workspace: &Path, name: &str, body: &str) -> PathBuf {
        let file = workspace.join(name);
        std::fs::write(&file, body).unwrap();
        file
    }

    async fn edit(workspace: &Path, args: serde_json::Value) -> Result<String, String> {
        execute_edit_file(&args, &workspace.to_string_lossy()).await
    }

    #[tokio::test]
    async fn edit_file_replaces_exact_match_and_reports_context() {
        let (base, workspace) = temp_workspace("edit-exact");
        let file = seed(&workspace, "main.rs", SAMPLE);

        let out = edit(
            &workspace,
            json!({
                "path": "main.rs",
                "old_string": "    let x = 1;",
                "new_string": "    let x = 42;"
            }),
        )
        .await
        .unwrap();

        assert_eq!(
            std::fs::read_to_string(&file).unwrap(),
            "fn main() {\n    let x = 42;\n    println!(\"{}\", x);\n}\n"
        );
        assert!(out.contains("1 replacement"), "{out}");
        // Compact confirmation with a verifiable snippet, not the whole file.
        assert!(out.contains("let x = 42;"), "{out}");
        assert!(out.len() < 400, "result should stay compact: {out}");
        let _ = std::fs::remove_dir_all(base);
    }

    #[tokio::test]
    async fn edit_file_not_found_errors_and_leaves_file_untouched() {
        let (base, workspace) = temp_workspace("edit-missing-needle");
        let file = seed(&workspace, "main.rs", SAMPLE);

        let err = edit(
            &workspace,
            json!({
                "path": "main.rs",
                "old_string": "let y = 1;",
                "new_string": "let y = 2;"
            }),
        )
        .await
        .unwrap_err();

        assert!(err.contains("not found"), "{err}");
        assert_eq!(std::fs::read_to_string(&file).unwrap(), SAMPLE);
        let _ = std::fs::remove_dir_all(base);
    }

    #[tokio::test]
    async fn edit_file_ambiguous_match_errors_without_writing() {
        let (base, workspace) = temp_workspace("edit-ambiguous");
        let body = "a = 1;\nb = 2;\na = 1;\n";
        let file = seed(&workspace, "dup.txt", body);

        let err = edit(
            &workspace,
            json!({
                "path": "dup.txt",
                "old_string": "a = 1;",
                "new_string": "a = 9;"
            }),
        )
        .await
        .unwrap_err();

        assert!(err.contains("appears 2 times"), "{err}");
        assert!(err.contains("replace_all"), "{err}");
        // Critically: no silent first-match edit.
        assert_eq!(std::fs::read_to_string(&file).unwrap(), body);
        let _ = std::fs::remove_dir_all(base);
    }

    #[tokio::test]
    async fn edit_file_replace_all_replaces_every_occurrence() {
        let (base, workspace) = temp_workspace("edit-replace-all");
        let file = seed(&workspace, "dup.txt", "a = 1;\nb = 2;\na = 1;\n");

        let out = edit(
            &workspace,
            json!({
                "path": "dup.txt",
                "old_string": "a = 1;",
                "new_string": "a = 9;",
                "replace_all": true
            }),
        )
        .await
        .unwrap();

        assert_eq!(
            std::fs::read_to_string(&file).unwrap(),
            "a = 9;\nb = 2;\na = 9;\n"
        );
        assert!(out.contains("2 replacements"), "{out}");
        let _ = std::fs::remove_dir_all(base);
    }

    #[tokio::test]
    async fn edit_file_identical_strings_error() {
        let (base, workspace) = temp_workspace("edit-identical");
        let file = seed(&workspace, "main.rs", SAMPLE);

        let err = edit(
            &workspace,
            json!({
                "path": "main.rs",
                "old_string": "    let x = 1;",
                "new_string": "    let x = 1;"
            }),
        )
        .await
        .unwrap_err();

        assert!(err.contains("identical"), "{err}");
        assert_eq!(std::fs::read_to_string(&file).unwrap(), SAMPLE);
        let _ = std::fs::remove_dir_all(base);
    }

    #[tokio::test]
    async fn edit_file_rejects_empty_old_string() {
        let (base, workspace) = temp_workspace("edit-empty");
        let file = seed(&workspace, "main.rs", SAMPLE);

        let err = edit(
            &workspace,
            json!({
                "path": "main.rs",
                "old_string": "",
                "new_string": "// header\n"
            }),
        )
        .await
        .unwrap_err();

        assert!(err.contains("must not be empty"), "{err}");
        assert!(err.contains("write_file"), "{err}");
        assert_eq!(std::fs::read_to_string(&file).unwrap(), SAMPLE);
        let _ = std::fs::remove_dir_all(base);
    }

    #[tokio::test]
    async fn edit_file_is_whitespace_and_indentation_sensitive() {
        let (base, workspace) = temp_workspace("edit-whitespace");
        let file = seed(&workspace, "main.rs", SAMPLE);

        // Tab-indented instead of space-indented → must not match.
        let err = edit(
            &workspace,
            json!({
                "path": "main.rs",
                "old_string": "\tlet x = 1;",
                "new_string": "\tlet x = 2;"
            }),
        )
        .await
        .unwrap_err();
        assert!(err.contains("not found"), "{err}");
        assert_eq!(std::fs::read_to_string(&file).unwrap(), SAMPLE);

        // Extra internal whitespace → must not match either.
        let err = edit(
            &workspace,
            json!({
                "path": "main.rs",
                "old_string": "let x  = 1;",
                "new_string": "let x  = 2;"
            }),
        )
        .await
        .unwrap_err();
        assert!(err.contains("not found"), "{err}");
        assert_eq!(std::fs::read_to_string(&file).unwrap(), SAMPLE);

        // Trailing-newline sensitivity: a multi-line needle must match verbatim.
        let out = edit(
            &workspace,
            json!({
                "path": "main.rs",
                "old_string": "    let x = 1;\n    println!(\"{}\", x);\n",
                "new_string": "    let x = 1;\n"
            }),
        )
        .await
        .unwrap();
        assert!(out.contains("1 replacement"), "{out}");
        assert_eq!(
            std::fs::read_to_string(&file).unwrap(),
            "fn main() {\n    let x = 1;\n}\n"
        );
        let _ = std::fs::remove_dir_all(base);
    }

    #[tokio::test]
    async fn edit_file_rejects_path_outside_workspace() {
        let (base, workspace) = temp_workspace("edit-escape");
        let outside = base.join("outside");
        std::fs::create_dir_all(&outside).unwrap();
        let secret = outside.join("secret.txt");
        std::fs::write(&secret, "top secret\n").unwrap();

        let err = edit(
            &workspace,
            json!({
                "path": "../outside/secret.txt",
                "old_string": "top secret",
                "new_string": "pwned"
            }),
        )
        .await
        .unwrap_err();

        assert!(err.contains("outside the project workspace"), "{err}");
        assert_eq!(std::fs::read_to_string(&secret).unwrap(), "top secret\n");
        let _ = std::fs::remove_dir_all(base);
    }

    #[tokio::test]
    async fn edit_file_rejects_symlink_escaping_workspace() {
        let (base, workspace) = temp_workspace("edit-symlink");
        let outside = base.join("outside");
        std::fs::create_dir_all(&outside).unwrap();
        let secret = outside.join("secret.txt");
        std::fs::write(&secret, "top secret\n").unwrap();
        let link = workspace.join("link");
        if symlink_dir(&outside, &link).is_err() {
            let _ = std::fs::remove_dir_all(base);
            return;
        }

        let err = edit(
            &workspace,
            json!({
                "path": "link/secret.txt",
                "old_string": "top secret",
                "new_string": "pwned"
            }),
        )
        .await
        .unwrap_err();

        assert!(err.contains("outside the project workspace"), "{err}");
        assert_eq!(std::fs::read_to_string(&secret).unwrap(), "top secret\n");
        let _ = std::fs::remove_dir_all(base);
    }

    #[tokio::test]
    async fn edit_file_requires_an_existing_file() {
        let (base, workspace) = temp_workspace("edit-nonexistent");

        let err = edit(
            &workspace,
            json!({
                "path": "nope.txt",
                "old_string": "a",
                "new_string": "b"
            }),
        )
        .await
        .unwrap_err();

        assert!(err.contains("Cannot resolve path"), "{err}");
        assert!(!workspace.join("nope.txt").exists());
        let _ = std::fs::remove_dir_all(base);
    }

    #[tokio::test]
    async fn edit_file_missing_arguments_error() {
        let (base, workspace) = temp_workspace("edit-args");
        seed(&workspace, "main.rs", SAMPLE);

        let err = edit(&workspace, json!({ "path": "main.rs", "new_string": "x" }))
            .await
            .unwrap_err();
        assert!(err.contains("old_string"), "{err}");

        let err = edit(&workspace, json!({ "path": "main.rs", "old_string": "x" }))
            .await
            .unwrap_err();
        assert!(err.contains("new_string"), "{err}");
        let _ = std::fs::remove_dir_all(base);
    }

    // The approval gate injects the user's merged file body under a reserved
    // argument when only some hunks were accepted; the executor writes that
    // verbatim instead of running its own replacement.
    #[tokio::test]
    async fn edit_file_honours_approved_merged_content() {
        let (base, workspace) = temp_workspace("edit-merged");
        let file = seed(&workspace, "main.rs", SAMPLE);

        let mut args = json!({
            "path": "main.rs",
            "old_string": "    let x = 1;",
            "new_string": "    let x = 42;"
        });
        args.as_object_mut().unwrap().insert(
            APPROVED_CONTENT_ARG.to_string(),
            serde_json::Value::String("user picked this\n".to_string()),
        );

        let out = edit(&workspace, args).await.unwrap();

        assert_eq!(
            std::fs::read_to_string(&file).unwrap(),
            "user picked this\n"
        );
        assert!(out.contains("modified version"), "{out}");
        let _ = std::fs::remove_dir_all(base);
    }

    #[tokio::test]
    async fn edit_file_dispatches_through_execute_tool() {
        let (base, workspace) = temp_workspace("edit-dispatch");
        let file = seed(&workspace, "main.rs", SAMPLE);
        let call = ToolCall {
            id: "tool-edit".to_string(),
            name: "edit_file".to_string(),
            arguments: json!({
                "path": "main.rs",
                "old_string": "let x = 1;",
                "new_string": "let x = 7;"
            }),
        };
        let target = ExecutionTarget::Local {
            project_path: workspace.to_string_lossy().to_string(),
        };

        let result = execute_tool(&call, &target).await;

        assert!(!result.is_error, "{}", result.content);
        assert!(std::fs::read_to_string(&file)
            .unwrap()
            .contains("let x = 7;"));
        let _ = std::fs::remove_dir_all(base);
    }

    #[tokio::test]
    async fn edit_file_is_rejected_on_ssh_targets() {
        let call = ToolCall {
            id: "tool-edit-ssh".to_string(),
            name: "edit_file".to_string(),
            arguments: json!({
                "path": "main.rs",
                "old_string": "a",
                "new_string": "b"
            }),
        };
        let target = ExecutionTarget::Ssh {
            config: crate::core::execution::SshConfig {
                host: "example.invalid".to_string(),
                port: 22,
                user: "nobody".to_string(),
                remote_path: "/srv/app".to_string(),
                key_path: None,
                auth_method: None,
                target_id: None,
                host_fingerprint: None,
            },
        };

        let result = execute_tool(&call, &target).await;

        assert!(result.is_error);
        assert!(result.content.contains("not available for remote SSH"));
        assert!(result.content.contains("write_file"));
    }

    #[test]
    fn preview_edit_file_matches_what_the_executor_would_write() {
        let after = preview_edit_file(
            &json!({
                "path": "main.rs",
                "old_string": "    let x = 1;",
                "new_string": "    let x = 42;"
            }),
            Some(SAMPLE),
        )
        .unwrap();
        assert_eq!(
            after,
            "fn main() {\n    let x = 42;\n    println!(\"{}\", x);\n}\n"
        );
    }

    #[test]
    fn preview_edit_file_propagates_edit_errors_to_the_gate() {
        let ambiguous = preview_edit_file(
            &json!({ "path": "d.txt", "old_string": "a", "new_string": "b" }),
            Some("aa"),
        )
        .unwrap_err();
        assert!(ambiguous.contains("appears 2 times"), "{ambiguous}");

        let no_baseline = preview_edit_file(
            &json!({ "path": "d.txt", "old_string": "a", "new_string": "b" }),
            None,
        )
        .unwrap_err();
        assert!(
            no_baseline.contains("existing readable file"),
            "{no_baseline}"
        );
    }

    #[tokio::test]
    async fn tool_definitions_include_edit_file_schema() {
        // Empty allowlist: exercise the real definition path without spawning
        // the user's configured MCP servers.
        let defs = tool_definitions_with_mcp_allowlist(Some(&[])).await;
        let def = defs
            .iter()
            .find(|d| d.name == "edit_file")
            .expect("edit_file must be offered to the in-process providers");

        let required = def.parameters["required"].as_array().unwrap();
        for key in ["path", "old_string", "new_string"] {
            assert!(
                required.iter().any(|v| v == key),
                "{key} must be required: {:?}",
                required
            );
        }
        let props = def.parameters["properties"].as_object().unwrap();
        assert_eq!(props["replace_all"]["type"], "boolean");
        assert!(!props.contains_key(APPROVED_CONTENT_ARG));
    }

    #[tokio::test]
    async fn local_bash_nonzero_exit_is_error() {
        let (base, workspace) = temp_workspace("bash-error");
        let command = if cfg!(windows) { "exit /B 7" } else { "exit 7" };
        let call = ToolCall {
            id: "tool-1".to_string(),
            name: "bash".to_string(),
            arguments: json!({ "command": command }),
        };
        let target = ExecutionTarget::Local {
            project_path: workspace.to_string_lossy().to_string(),
        };

        let result = execute_tool(&call, &target).await;

        assert!(result.is_error);
        assert!(result.content.contains("[exit code: 7]"));
        let _ = std::fs::remove_dir_all(base);
    }

    // S1: a timed-out bash command must take its whole process tree with it —
    // not just the `sh` we spawned, but backgrounded grandchildren too.
    #[cfg(unix)]
    #[tokio::test]
    async fn local_bash_timeout_kills_grandchildren() {
        let (base, workspace) = temp_workspace("bash-reap");
        let pidfile = workspace.join("grandchild.pid");
        // Background a long `sleep` (the grandchild), record its pid, then block
        // in a foreground `sleep` so the shell outlives the 1s timeout.
        let command = format!(
            "sleep 60 & echo $! > {}; sleep 60",
            pidfile.to_string_lossy()
        );
        let args = json!({ "command": command, "timeout": 1 });

        let result = execute_bash(&args, workspace.to_str().unwrap()).await;
        assert!(result.is_err(), "command should have timed out");

        // Let the process-group SIGKILL propagate.
        tokio::time::sleep(std::time::Duration::from_millis(400)).await;

        let pid: i32 = std::fs::read_to_string(&pidfile)
            .expect("grandchild pid file")
            .trim()
            .parse()
            .expect("valid pid");
        // kill(pid, 0) probes existence: 0 = alive, -1/ESRCH = reaped.
        let alive = unsafe { libc::kill(pid, 0) } == 0;
        if alive {
            // Don't leak the process if the assertion is about to fail.
            unsafe { libc::kill(pid, libc::SIGKILL) };
        }
        let _ = std::fs::remove_dir_all(base);
        assert!(!alive, "grandchild sleep (pid {pid}) survived the timeout");
    }
}
