//! Frozen MCP trust enforcement and provider-safe tool naming.
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::path::{Component, Path, PathBuf};

const MAX_PROVIDER_TOOL_NAME_LEN: usize = 64;
const MCP_TOOL_PREFIX: &str = "mcp__";
const HASH_SUFFIX_LEN: usize = 12;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpTrustSnapshot {
    pub schema_version: u8,
    pub server_id: String,
    pub server_name: String,
    pub workspace_path: Option<String>,
    pub allow_reads: bool,
    pub allow_writes: bool,
    pub allow_network: bool,
    #[serde(default)]
    pub allowed_roots: Vec<String>,
    #[serde(default)]
    pub allowed_tool_names: Vec<String>,
    #[serde(default)]
    pub denial_floors: Vec<String>,
    pub revision: u64,
    pub updated_at: u64,
    pub capability_checked_at: Option<u64>,
}

/// Word tokens that name a mutation. Matched against the tool name split into
/// words (`applyPatch` / `apply_patch` / `apply-patch` all tokenize the same),
/// so this catches names the substring pass below misses without the false
/// positives a bare `contains("put")` would produce.
///
/// Mirrors `MUTATING_TOKENS` in `agent-sidecar/src/mcp-trust.ts`. Keep the two
/// in lockstep: they are the same floor enforced on two transports.
const MUTATING_TOKENS: &[&str] = &[
    "write",
    "create",
    "update",
    "delete",
    "remove",
    "move",
    "rename",
    "post",
    "send",
    "merge",
    "push",
    "publish",
    "archive",
    "close",
    "reopen",
    "assign",
    "set",
    "execute",
    "run",
    "exec",
    "edit",
    "patch",
    "apply",
    "commit",
    "mkdir",
    "rmdir",
    "chmod",
    "chown",
    "append",
    "prepend",
    "put",
    "save",
    "store",
    "modify",
    "insert",
    "upsert",
    "drop",
    "truncate",
    "alter",
    "upload",
    "install",
    "uninstall",
    "mutate",
    "destroy",
    "purge",
    "wipe",
    "overwrite",
    "replace",
    "unlink",
    "mount",
    "unmount",
    "format",
    "kill",
    "terminate",
    "revoke",
    "grant",
    "restart",
    "reset",
];

/// Split a tool name into lowercase word tokens, breaking on non-alphanumerics
/// and on camelCase humps.
fn tool_name_tokens(name: &str) -> Vec<String> {
    let mut tokens = Vec::new();
    let mut current = String::new();
    let mut previous_lower_or_digit = false;
    for ch in name.chars() {
        if ch.is_ascii_alphanumeric() {
            if ch.is_ascii_uppercase() && previous_lower_or_digit && !current.is_empty() {
                tokens.push(std::mem::take(&mut current));
            }
            current.push(ch.to_ascii_lowercase());
            previous_lower_or_digit = ch.is_ascii_lowercase() || ch.is_ascii_digit();
        } else if !current.is_empty() {
            tokens.push(std::mem::take(&mut current));
            previous_lower_or_digit = false;
        }
    }
    if !current.is_empty() {
        tokens.push(current);
    }
    tokens
}

fn suspected_mutation(name: &str) -> bool {
    let lowered = name.to_ascii_lowercase();
    // Legacy substring pass — catches glued-together names like `rewriteFile`
    // whose tokens ("rewrite") are not themselves in the token list.
    let substring_hit = [
        "write", "create", "update", "delete", "remove", "move", "rename", "post", "send", "merge",
        "push", "publish", "archive", "close", "reopen", "assign", "set", "execute", "run",
    ]
    .iter()
    .any(|needle| lowered.contains(needle));
    if substring_hit {
        return true;
    }
    let tokens = tool_name_tokens(name);
    tokens
        .iter()
        .any(|token| MUTATING_TOKENS.contains(&token.as_str()))
}

fn credential_tool(name: &str) -> bool {
    let name = name.to_ascii_lowercase();
    [
        "credential",
        "secret",
        "token",
        "password",
        "keyring",
        "private_key",
        "auth",
    ]
    .iter()
    .any(|needle| name.contains(needle))
}

fn protected_publish_tool(name: &str) -> bool {
    let name = name.to_ascii_lowercase();
    [
        "push",
        "publish",
        "merge",
        "release",
        "deploy",
        "tag",
        "pull_request",
    ]
    .iter()
    .any(|needle| name.contains(needle))
}

fn trust_for_server<'a>(
    snapshots: Option<&'a [McpTrustSnapshot]>,
    server: &str,
) -> Option<&'a McpTrustSnapshot> {
    snapshots?
        .iter()
        .find(|snapshot| snapshot.server_name == server)
}

/// F6 — read-only sessions run an ALLOWLIST, not a denylist.
///
/// `read_only_hint` is the tool's own `readOnlyHint` annotation as reported by
/// its MCP server (`None` when the caller has no listing to consult). When the
/// session is read-only a tool runs only if the server annotated it read-only
/// or the user explicitly granted it in `allowed_tool_names`; everything else,
/// including every tool we simply do not recognize, is refused. The verb floor
/// (`suspected_mutation`) then applies on top, so an obviously-mutating name
/// stays blocked even if it somehow reached the allowlist.
pub(crate) fn trust_allows_advertisement(
    snapshots: Option<&[McpTrustSnapshot]>,
    server: &str,
    tool: &str,
    read_only_hint: Option<bool>,
) -> bool {
    let Some(snapshot) = trust_for_server(snapshots, server) else {
        // No trust field is a legacy session. Treat it as read-only with no
        // user grants: only a server-annotated read-only tool that also clears
        // the floors may run.
        return read_only_hint == Some(true)
            && !suspected_mutation(tool)
            && !credential_tool(tool)
            && !protected_publish_tool(tool);
    };
    if !snapshot.allow_reads {
        return false;
    }
    if snapshot.capability_checked_at.is_some()
        && !snapshot
            .allowed_tool_names
            .iter()
            .any(|allowed| allowed == tool)
    {
        return false;
    }
    if snapshot
        .denial_floors
        .iter()
        .any(|floor| floor == "credentials")
        && credential_tool(tool)
    {
        return false;
    }
    if snapshot
        .denial_floors
        .iter()
        .any(|floor| floor == "protected_publish")
        && protected_publish_tool(tool)
    {
        return false;
    }
    if snapshot.allow_writes {
        return true;
    }
    if suspected_mutation(tool) {
        return false;
    }
    read_only_hint == Some(true)
        || snapshot
            .allowed_tool_names
            .iter()
            .any(|allowed| allowed == tool)
}

fn normalize_lexical(path: &Path) -> PathBuf {
    let mut output = PathBuf::new();
    for component in path.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                output.pop();
            }
            other => output.push(other.as_os_str()),
        }
    }
    output
}

fn path_inside_root(candidate: &str, root: &str) -> bool {
    let root = normalize_lexical(Path::new(root));
    let candidate_path = Path::new(candidate);
    let candidate = if candidate_path.is_absolute() {
        normalize_lexical(candidate_path)
    } else {
        normalize_lexical(&root.join(candidate_path))
    };
    candidate.starts_with(root)
}

fn path_arguments(value: &Value, key: &str, output: &mut Vec<String>) {
    match value {
        Value::String(value)
            if [
                "path",
                "file",
                "folder",
                "directory",
                "dir",
                "root",
                "cwd",
                "workspace",
            ]
            .iter()
            .any(|needle| key.to_ascii_lowercase().contains(needle)) =>
        {
            output.push(value.clone());
        }
        Value::Array(values) => {
            for value in values {
                path_arguments(value, key, output);
            }
        }
        Value::Object(values) => {
            for (child_key, value) in values {
                path_arguments(value, child_key, output);
            }
        }
        _ => {}
    }
}

pub(crate) fn enforce_tool_trust(
    snapshots: Option<&[McpTrustSnapshot]>,
    server: &str,
    tool: &str,
    args: &Value,
    read_only_hint: Option<bool>,
) -> Result<(), String> {
    if !trust_allows_advertisement(snapshots, server, tool, read_only_hint) {
        return Err(format!(
            "MCP tool '{server}/{tool}' is outside this session's frozen read-only authority. \
             Allow the tool or enable writes for '{server}' in Settings → MCP Hub."
        ));
    }
    let Some(snapshot) = trust_for_server(snapshots, server) else {
        return Ok(());
    };
    if snapshot
        .denial_floors
        .iter()
        .any(|floor| floor == "outside_workspace")
    {
        let mut paths = Vec::new();
        path_arguments(args, "", &mut paths);
        if paths.iter().any(|candidate| {
            snapshot.allowed_roots.is_empty()
                || !snapshot
                    .allowed_roots
                    .iter()
                    .any(|root| path_inside_root(candidate, root))
        }) {
            return Err(
                "MCP path access outside the frozen workspace roots is blocked".to_string(),
            );
        }
    }
    Ok(())
}

/// Sanitize a name into a tool-name-safe slug.
/// Provider tool name regex is roughly `^[a-zA-Z0-9_-]{1,64}$`.
fn sanitize(name: &str) -> String {
    let mut out: String = name
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '_' || c == '-' {
                c
            } else {
                '_'
            }
        })
        .collect();
    if out.is_empty() {
        out.push('_');
    }
    out
}

fn stable_name_hash(server: &str, tool: &str) -> String {
    // FNV-1a 64-bit: tiny, deterministic, and plenty for provider-name suffixes.
    let mut hash = 0xcbf29ce484222325_u64;
    for b in server
        .as_bytes()
        .iter()
        .chain([0xff_u8].iter())
        .chain(tool.as_bytes().iter())
    {
        hash ^= u64::from(*b);
        hash = hash.wrapping_mul(0x100000001b3);
    }
    format!("{:016x}", hash)
}

fn truncate_ascii(s: &str, max_len: usize) -> &str {
    &s[..s.len().min(max_len)]
}

/// Build the canonical agent-facing tool name for a (server, tool) pair.
pub(crate) fn make_tool_name(server: &str, tool: &str) -> String {
    let server_slug = sanitize(server);
    let tool_slug = sanitize(tool);
    let simple = format!("{MCP_TOOL_PREFIX}{server_slug}__{tool_slug}");
    if simple.len() <= MAX_PROVIDER_TOOL_NAME_LEN && server_slug == server && tool_slug == tool {
        return simple;
    }

    let hash = &stable_name_hash(server, tool)[..HASH_SUFFIX_LEN];
    let fixed_len = MCP_TOOL_PREFIX.len() + "__".len() + "_".len() + HASH_SUFFIX_LEN;
    let budget = MAX_PROVIDER_TOOL_NAME_LEN.saturating_sub(fixed_len);
    let mut server_budget = server_slug.len().min(budget / 2);
    let mut tool_budget = tool_slug.len().min(budget - server_budget);

    let unused_tool_budget = budget - server_budget - tool_budget;
    if unused_tool_budget > 0 && server_budget < server_slug.len() {
        let extra = (server_slug.len() - server_budget).min(unused_tool_budget);
        server_budget += extra;
    }

    let unused_server_budget = budget - server_budget - tool_budget;
    if unused_server_budget > 0 && tool_budget < tool_slug.len() {
        let extra = (tool_slug.len() - tool_budget).min(unused_server_budget);
        tool_budget += extra;
    }

    format!(
        "{MCP_TOOL_PREFIX}{}__{}_{}",
        truncate_ascii(&server_slug, server_budget),
        truncate_ascii(&tool_slug, tool_budget),
        hash
    )
}

pub async fn execute_mcp_tool_with_trust(
    name: &str,
    args: &Value,
    _selected: Option<&[String]>,
    _snapshots: Option<&[McpTrustSnapshot]>,
) -> Result<String, String> {
    let parent = crate::core::tool_subagent::current_parent_llm()
        .ok_or("MCP tools require an active session with frozen configuration")?;
    parent.native_mcp_session.execute(name, args, false).await
}

pub(crate) fn enforce_subagent_tool_trust(
    snapshots: Option<&[McpTrustSnapshot]>,
    server: &str,
    tool: &str,
    args: &Value,
    read_only: bool,
) -> Result<(), String> {
    // Delegation keeps both the child's existing read-only floor and the
    // parent's selection/roots. Parent write grants cannot elevate a child.
    enforce_tool_trust(None, server, tool, args, Some(read_only))?;
    enforce_tool_trust(snapshots, server, tool, args, Some(read_only))
}

pub async fn execute_subagent_mcp_tool(
    name: &str,
    args: &Value,
    enabled_server_ids: Option<&[String]>,
    trust_snapshots: Option<&[McpTrustSnapshot]>,
) -> Result<String, String> {
    let _ = (enabled_server_ids, trust_snapshots);
    let parent = crate::core::tool_subagent::current_parent_llm()
        .ok_or("MCP tools require an active session with frozen configuration")?;
    parent.native_mcp_session.execute(name, args, true).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn delegated_mcp_keeps_roots_and_read_only_floor_even_with_parent_write_grant() {
        let mut parent = snapshot();
        parent.allow_writes = true;
        parent.allowed_tool_names.push("write_file".into());
        let snapshots = [parent];
        assert!(enforce_subagent_tool_trust(
            Some(&snapshots),
            "test",
            "read_file",
            &serde_json::json!({"path":"src/main.rs"}),
            true
        )
        .is_ok());
        assert!(enforce_subagent_tool_trust(
            Some(&snapshots),
            "test",
            "read_file",
            &serde_json::json!({"path":"../outside.txt"}),
            true
        )
        .is_err());
        assert!(enforce_subagent_tool_trust(
            Some(&snapshots),
            "test",
            "write_file",
            &serde_json::json!({"path":"src/main.rs"}),
            false
        )
        .is_err());
    }

    #[tokio::test]
    async fn delegated_mcp_cannot_resolve_a_server_excluded_by_parent() {
        let error = execute_subagent_mcp_tool(
            "mcp__excluded__read_file",
            &serde_json::json!({}),
            Some(&[]),
            Some(&[]),
        )
        .await
        .unwrap_err();
        assert!(
            error.contains("MCP tools require an active session"),
            "{error}"
        );
    }

    #[test]
    fn long_mcp_tool_names_fit_provider_limit_and_keep_hash() {
        let name = make_tool_name(
            "very-long-server-name-that-would-overflow-provider-tool-name-limits",
            "very-long-tool-name-that-also-would-overflow-provider-tool-name-limits",
        );
        assert!(name.len() <= MAX_PROVIDER_TOOL_NAME_LEN);
        assert!(name.starts_with("mcp__"));
        assert_eq!(name.rsplit('_').next().unwrap().len(), HASH_SUFFIX_LEN);
    }

    #[test]
    fn sanitized_names_get_hash_suffix_to_avoid_collisions() {
        let dotted = make_tool_name("server.name", "tool.name");
        let underscored = make_tool_name("server_name", "tool_name");
        assert_ne!(dotted, underscored);
        assert!(dotted.len() <= MAX_PROVIDER_TOOL_NAME_LEN);
    }

    #[test]
    fn simple_names_stay_readable() {
        assert_eq!(make_tool_name("github", "search"), "mcp__github__search");
    }

    fn snapshot() -> McpTrustSnapshot {
        McpTrustSnapshot {
            schema_version: 1,
            server_id: "global:test".to_string(),
            server_name: "test".to_string(),
            workspace_path: Some("/workspace".to_string()),
            allow_reads: true,
            allow_writes: false,
            allow_network: true,
            allowed_roots: vec!["/workspace".to_string()],
            allowed_tool_names: vec!["read_file".to_string(), "write_file".to_string()],
            denial_floors: vec![
                "credentials".to_string(),
                "outside_workspace".to_string(),
                "protected_publish".to_string(),
            ],
            revision: 1,
            updated_at: 1,
            capability_checked_at: Some(1),
        }
    }

    #[test]
    fn trust_snapshot_filters_mutations_and_denial_floors() {
        let snapshot = snapshot();
        assert!(trust_allows_advertisement(
            Some(std::slice::from_ref(&snapshot)),
            "test",
            "read_file",
            Some(true)
        ));
        assert!(!trust_allows_advertisement(
            Some(std::slice::from_ref(&snapshot)),
            "test",
            "write_file",
            Some(false)
        ));
        assert!(!trust_allows_advertisement(
            Some(std::slice::from_ref(&snapshot)),
            "test",
            "read_credentials",
            Some(true)
        ));
    }

    #[test]
    fn trust_snapshot_rejects_paths_outside_workspace() {
        let snapshot = snapshot();
        let snapshots = [snapshot];
        assert!(enforce_tool_trust(
            Some(&snapshots),
            "test",
            "read_file",
            &serde_json::json!({ "path": "src/main.rs" }),
            Some(true),
        )
        .is_ok());
        assert!(enforce_tool_trust(
            Some(&snapshots),
            "test",
            "read_file",
            &serde_json::json!({ "path": "../secret.txt" }),
            Some(true),
        )
        .is_err());
    }

    /// An EMPTY root list is the strictest state, not the open one.
    ///
    /// The MCP Hub's roots editor lets a user delete their last root, which is
    /// only safe because of this: with no roots, every path-like argument is
    /// refused. If this ever inverted to "empty means unrestricted", deleting
    /// the last row in that editor would silently remove all protection.
    #[test]
    fn empty_allowed_roots_denies_every_path_argument() {
        let mut snapshot = snapshot();
        snapshot.allowed_roots.clear();
        let snapshots = [snapshot];
        for path in ["/workspace/src/main.rs", "/etc/shadow", "relative.txt"] {
            assert!(
                enforce_tool_trust(
                    Some(&snapshots),
                    "test",
                    "read_file",
                    &serde_json::json!({ "path": path }),
                    Some(true),
                )
                .is_err(),
                "empty root list admitted '{path}'"
            );
        }
        // A call with no path-like argument is unaffected: roots constrain
        // path arguments, they are not a second read gate.
        assert!(enforce_tool_trust(
            Some(&snapshots),
            "test",
            "read_file",
            &serde_json::json!({ "query": "anything" }),
            Some(true),
        )
        .is_ok());
    }

    /// Roots that LOOK restrictive but match everything.
    ///
    /// `normalize_lexical` drops `CurDir`, so a root of "." or "" reduces to an
    /// empty path, and `Path::starts_with("")` is true for every path on the
    /// machine. Read as an allowlist entry, `.` looks like "the current
    /// directory"; it is in fact "the whole filesystem", and the Node sidecar
    /// reads the same value as its own working directory instead.
    ///
    /// This is pinned rather than fixed here on purpose: `path_inside_root` is
    /// a checker and must keep failing closed on whatever it is handed. The
    /// defence is that nothing may STORE such a value —
    /// `normalizeMcpRoot` in `src/lib/mcpRoots.ts` refuses "", ".", "./" and
    /// any `.`/`..` segment, and is the only writer the Hub offers. If this
    /// test ever starts failing because the checker was tightened, delete it;
    /// if it starts failing because the checker was loosened, do not.
    #[test]
    fn degenerate_roots_match_everything_and_must_never_be_stored() {
        for root in ["", ".", "./"] {
            assert!(
                path_inside_root("/etc/shadow", root),
                "expected the known-degenerate root {root:?} to match everything"
            );
        }
        // The values the editor stores instead do not have this property.
        assert!(!path_inside_root("/etc/shadow", "/workspace"));
    }

    /// Containment is component-wise, so a sibling directory whose name merely
    /// starts with the root's name is outside it.
    #[test]
    fn sibling_directory_with_a_shared_name_prefix_is_outside_the_root() {
        assert!(!path_inside_root("/workspace-evil/a.txt", "/workspace"));
        assert!(path_inside_root("/workspace/a.txt", "/workspace"));
    }

    #[cfg(windows)]
    #[test]
    fn windows_root_matching_is_case_sensitive_except_for_the_drive_letter() {
        // The drive letter is normalised by std; every other segment is not.
        assert!(path_inside_root("c:\\repo\\src\\a.txt", "C:\\repo"));
        assert!(!path_inside_root("C:\\REPO\\src\\a.txt", "C:\\repo"));
        // Separator spelling does not matter on Windows.
        assert!(path_inside_root("C:/repo/src/a.txt", "C:\\repo"));
    }

    #[cfg(windows)]
    #[test]
    fn windows_verbatim_and_drive_relative_roots_are_unusable() {
        // A verbatim prefix never compares equal to an ordinary path, in
        // either direction: such a root would silently match nothing.
        assert!(!path_inside_root("C:\\repo\\a.txt", "\\\\?\\C:\\repo"));
        assert!(!path_inside_root("\\\\?\\C:\\repo\\a.txt", "C:\\repo"));
        // A drive-relative root is read here as the WHOLE drive, while the
        // sidecar reads it as that drive's current directory. Refused by the
        // editor for exactly this disagreement.
        assert!(path_inside_root("C:\\Windows\\System32\\config\\SAM", "C:"));
    }

    /// F6 — the exact names the 2026-08-05 review drove through the old
    /// 19-word substring denylist and out the other side as "non-mutating".
    /// Every one of them executed in a session the user had set read-only.
    const READ_ONLY_BYPASS_NAMES: &[&str] = &[
        "edit_file",
        "apply_patch",
        "commit",
        "mkdir",
        "chmod",
        "exec",
        "git_commit",
        "append_to_file",
        "put_object",
        "save",
        "store",
        "modify",
        "insert_row",
        "drop_table",
    ];

    #[test]
    fn read_only_session_denies_every_known_bypass_name() {
        let snapshot = snapshot();
        assert!(!snapshot.allow_writes);
        let snapshots = [snapshot];
        for name in READ_ONLY_BYPASS_NAMES {
            // Hostile case: the server claims the tool is read-only AND the
            // user's allowlist contains it. The verb floor still refuses.
            let mut permissive = snapshots[0].clone();
            permissive.allowed_tool_names.push((*name).to_string());
            assert!(
                !trust_allows_advertisement(
                    Some(std::slice::from_ref(&permissive)),
                    "test",
                    name,
                    Some(true)
                ),
                "read-only session advertised mutating tool '{name}'"
            );
            assert!(
                enforce_tool_trust(
                    std::slice::from_ref(&permissive).into(),
                    "test",
                    name,
                    &serde_json::json!({}),
                    Some(true),
                )
                .is_err(),
                "read-only session executed mutating tool '{name}'"
            );
        }
    }

    #[test]
    fn read_only_session_denies_unannotated_tools_it_was_never_granted() {
        // Neither obviously mutating nor known read-only: the old code let it
        // through because no denylist word matched. Unknown must fail closed.
        let mut snapshot = snapshot();
        snapshot.capability_checked_at = None;
        snapshot.allowed_tool_names = vec!["read_file".to_string()];
        let snapshots = [snapshot];
        assert!(!trust_allows_advertisement(
            Some(&snapshots),
            "test",
            "query_ledger",
            None
        ));
        assert!(!trust_allows_advertisement(
            Some(&snapshots),
            "test",
            "query_ledger",
            Some(false)
        ));
        // The two ways a tool earns its place: the server's annotation…
        assert!(trust_allows_advertisement(
            Some(&snapshots),
            "test",
            "query_ledger",
            Some(true)
        ));
        // …or the user's explicit grant.
        assert!(trust_allows_advertisement(
            Some(&snapshots),
            "test",
            "read_file",
            None
        ));
    }

    #[test]
    fn write_enabled_session_still_runs_mutating_tools() {
        // The allowlist inversion is scoped to read-only sessions. A user who
        // granted writes must not lose their write tools.
        let mut snapshot = snapshot();
        snapshot.allow_writes = true;
        snapshot.capability_checked_at = None;
        let snapshots = [snapshot];
        assert!(trust_allows_advertisement(
            Some(&snapshots),
            "test",
            "write_file",
            Some(false)
        ));
        // Denial floors are not overridable by allow_writes.
        assert!(!trust_allows_advertisement(
            Some(&snapshots),
            "test",
            "push_release",
            Some(false)
        ));
    }

    #[test]
    fn legacy_sessions_without_a_snapshot_are_read_only_too() {
        // No trust field at all (a pre-v11 persisted session). Only a
        // server-annotated read-only tool may run.
        assert!(trust_allows_advertisement(
            None,
            "test",
            "read_file",
            Some(true)
        ));
        assert!(!trust_allows_advertisement(None, "test", "read_file", None));
        for name in READ_ONLY_BYPASS_NAMES {
            assert!(
                !trust_allows_advertisement(None, "test", name, Some(true)),
                "legacy session advertised mutating tool '{name}'"
            );
        }
    }

    #[test]
    fn tokenizer_splits_camel_case_and_separators() {
        assert_eq!(tool_name_tokens("applyPatch"), vec!["apply", "patch"]);
        assert_eq!(tool_name_tokens("apply_patch"), vec!["apply", "patch"]);
        assert_eq!(tool_name_tokens("apply-patch"), vec!["apply", "patch"]);
        assert!(suspected_mutation("applyPatch"));
        assert!(suspected_mutation("insertRow"));
        // `put` as a whole word is a mutation; `output` as a substring is not.
        assert!(suspected_mutation("put_object"));
        assert!(!suspected_mutation("get_output"));
    }
}
