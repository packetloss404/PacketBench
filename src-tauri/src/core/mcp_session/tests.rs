use super::*;
use crate::commands::mcp::McpServerConfig;
use serde_json::json;

const PROJECT: &str = "/workspace/project";

fn entry(name: &str, scope: &str, command: &str) -> McpServerEntry {
    McpServerEntry {
        name: name.into(),
        scope: scope.into(),
        disabled: false,
        config: McpServerConfig {
            command: command.into(),
            args: vec!["--fixture".into()],
            env: HashMap::from([("FIXTURE".into(), "frozen".into())]),
        },
        raw_config: json!({"command": command}),
    }
}

fn trust(name: &str, scope: &str) -> McpTrustSnapshot {
    McpTrustSnapshot {
        schema_version: 1,
        server_id: format!("{scope}:{name}"),
        server_name: name.into(),
        workspace_path: Some(PROJECT.into()),
        allow_reads: true,
        allow_writes: false,
        allow_network: false,
        allowed_roots: vec![PROJECT.into()],
        allowed_tool_names: vec!["read_file".into()],
        denial_floors: vec!["outside_workspace".into()],
        revision: 1,
        updated_at: 1,
        capability_checked_at: Some(1),
    }
}

fn error(result: Result<NativeMcpSession, String>) -> String {
    match result {
        Ok(_) => panic!("expected configuration rejection"),
        Err(error) => error,
    }
}

#[test]
fn trusted_project_overrides_global_independent_of_input_order_and_freezes_config() {
    let global = entry("same", "global", "global-command");
    let project = entry("same", "project", "project-command");
    for entries in [
        vec![global.clone(), project.clone()],
        vec![project.clone(), global.clone()],
    ] {
        let mut snapshots = vec![trust("same", "global"), trust("same", "project")];
        let session =
            NativeMcpSession::resolve(entries, PROJECT, true, None, Some(&snapshots)).unwrap();
        snapshots[1].allow_writes = true;
        snapshots[1].allowed_roots = vec!["/".into()];
        assert_eq!(session.servers.len(), 1);
        let server = &session.servers[0];
        assert_eq!(server.trust[0].server_id, "project:same");
        assert!(!server.trust[0].allow_writes);
        assert_eq!(server.trust[0].allowed_roots, [PROJECT]);
        match &server.config {
            TransportConfig::Stdio {
                command,
                args,
                env,
                cwd,
            } => {
                assert_eq!(command, "project-command");
                assert_eq!(args, &["--fixture"]);
                assert_eq!(env.get("FIXTURE").map(String::as_str), Some("frozen"));
                assert_eq!(cwd, &PathBuf::from(PROJECT));
            }
            TransportConfig::Network(_) => panic!("project stdio override changed transport"),
        }
    }
}

#[test]
fn untrusted_or_disabled_project_shadow_never_falls_back_to_global() {
    let selected = vec!["same".into()];
    for (trusted, disabled) in [(false, false), (true, true)] {
        let mut project = entry("same", "project", "project-command");
        project.disabled = disabled;
        let entries = vec![entry("same", "global", "global-command"), project];
        let automatic =
            NativeMcpSession::resolve(entries.clone(), PROJECT, trusted, None, None).unwrap();
        assert!(automatic.servers.is_empty());
        assert!(error(NativeMcpSession::resolve(
            entries,
            PROJECT,
            trusted,
            Some(&selected),
            None,
        ))
        .contains("disabled or its project is not trusted"));
    }
}

#[test]
fn explicit_selection_rejects_missing_and_disabled_but_empty_selects_nothing() {
    let selected = vec!["missing".into()];
    assert!(error(NativeMcpSession::resolve(
        vec![],
        PROJECT,
        true,
        Some(&selected),
        None,
    ))
    .contains("not configured"));
    let mut disabled = entry("disabled", "global", "fixture");
    disabled.disabled = true;
    assert!(error(NativeMcpSession::resolve(
        vec![disabled.clone()],
        PROJECT,
        true,
        Some(&["disabled".into()]),
        None,
    ))
    .contains("disabled"));
    let session = NativeMcpSession::resolve(
        vec![disabled, entry("other", "project", "fixture")],
        PROJECT,
        false,
        Some(&[]),
        Some(&[]),
    )
    .unwrap();
    assert!(session.servers.is_empty());
}

#[test]
fn supplied_snapshot_requires_exact_scope_name_workspace_and_unique_match() {
    let mut wrong_scope = trust("same", "project");
    let mut wrong_name = trust("same", "global");
    wrong_name.server_name = "different".into();
    let mut wrong_workspace = trust("same", "global");
    wrong_workspace.workspace_path = Some("/workspace/other".into());
    let mut missing_workspace = trust("same", "global");
    missing_workspace.workspace_path = None;
    // Matching the name alone must never grant another scope's authority.
    wrong_scope.allow_writes = true;
    for snapshots in [
        vec![],
        vec![wrong_scope],
        vec![wrong_name],
        vec![wrong_workspace],
        vec![missing_workspace],
        vec![trust("same", "global"), trust("same", "global")],
    ] {
        assert!(error(NativeMcpSession::resolve(
            vec![entry("same", "global", "fixture")],
            PROJECT,
            true,
            None,
            Some(&snapshots),
        ))
        .contains("unambiguous trust snapshot"));
    }
}

#[test]
fn denied_reads_cannot_become_a_connected_server() {
    let mut snapshot = trust("same", "global");
    snapshot.allow_reads = false;
    let session = NativeMcpSession::resolve(
        vec![entry("same", "global", "fixture")],
        PROJECT,
        true,
        Some(&["same".into()]),
        Some(&[snapshot]),
    )
    .unwrap();
    assert!(session.servers.is_empty());
}

#[test]
fn network_transports_require_explicit_frozen_network_permission() {
    for kind in ["http", "sse"] {
        let mut network = entry("network", "global", "");
        network.raw_config = json!({"type": kind, "url": "https://example.invalid/mcp"});
        let selected = vec!["network".into()];
        let mut snapshot = trust("network", "global");
        for snapshots in [None, Some(vec![snapshot.clone()])] {
            let result = NativeMcpSession::resolve(
                vec![network.clone()],
                PROJECT,
                true,
                Some(&selected),
                snapshots.as_deref(),
            );
            assert!(error(result).contains("explicit network permission"));
            let automatic = NativeMcpSession::resolve(
                vec![network.clone()],
                PROJECT,
                true,
                None,
                snapshots.as_deref(),
            )
            .unwrap();
            assert!(automatic.servers.is_empty());
        }
        snapshot.allow_network = true;
        let session = NativeMcpSession::resolve(
            vec![network],
            PROJECT,
            true,
            Some(&selected),
            Some(&[snapshot]),
        )
        .unwrap();
        assert_eq!(session.servers.len(), 1);
        assert!(matches!(
            session.servers[0].config,
            TransportConfig::Network(_)
        ));
    }
}

#[test]
fn ssh_refuses_implicit_or_nonempty_mcp_selection_and_allows_explicit_empty() {
    assert!(error(NativeMcpSession::for_ssh(None)).contains("SSH execution host"));
    assert!(error(NativeMcpSession::for_ssh(Some(&["remote".into()])))
        .contains("Desktop MCP configuration was not read"));
    assert!(NativeMcpSession::for_ssh(Some(&[]))
        .unwrap()
        .servers
        .is_empty());
}
