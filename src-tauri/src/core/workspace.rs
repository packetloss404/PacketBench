use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GridPosition {
    pub row: usize,
    pub col: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct TerminalShellSelection {
    pub profile: String,
    #[serde(default)]
    pub executable: Option<String>,
    #[serde(default)]
    pub args: Option<Vec<String>>,
    #[serde(default)]
    pub wsl_distro: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, ts_rs::TS)]
#[serde(rename_all = "camelCase")]
pub struct CustomCliConfig {
    pub name: String,
    pub command: String,
    pub args: Vec<String>,
    pub env: std::collections::BTreeMap<String, String>,
    #[ts(optional)]
    pub working_directory: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorkspacePane {
    pub id: String,
    pub agent_id: String,
    pub session_id: Option<String>,
    pub grid_position: GridPosition,
    #[serde(default)]
    pub accent_color: Option<String>,
    #[serde(default)]
    pub pinned_commands: Option<Vec<String>>,
    #[serde(default)]
    pub task_id: Option<String>,
    #[serde(default)]
    pub flight_id: Option<String>,
    #[serde(default)]
    pub agent_config_id: Option<String>,
    #[serde(default)]
    pub initial_prompt: Option<String>,
    #[serde(default)]
    pub override_command: Option<String>,
    #[serde(default)]
    pub override_args: Option<Vec<String>>,
    /// Pane kind discriminant (tile program, P1-S1). `None` ⇒ terminal, so an
    /// old binary that never wrote this field degrades to a harmless terminal
    /// pane. `kind` is the SOLE discriminant; `agent_id` is never overloaded
    /// with "conversation" — conversation panes persist the inert carrier
    /// `agent_id: "terminal"`. Precedent: `task_id`/`flight_id` above.
    #[serde(default)]
    pub kind: Option<String>,
    /// Set iff `kind == Some("conversation")` — the owning conversation id.
    #[serde(default)]
    pub conversation_id: Option<String>,
    /// Multi-account CLI support: the `CliAccount.id` this pane launches under,
    /// or `None` ⇒ ambient login (today's behaviour, and what an old binary
    /// that never wrote this field degrades to). Only meaningful for the
    /// `claude-code` / `codex` slots; the runtime translates it into
    /// `CLAUDE_CONFIG_DIR` / `CODEX_HOME`. Precedent: `task_id`/`flight_id`
    /// above — an inert `#[serde(default)]` mirror.
    #[serde(default)]
    pub account_id: Option<String>,
    /// Optional raw-terminal shell override. Absent means inherit the
    /// workspace/app default; old binaries therefore degrade to Auto.
    #[serde(default)]
    pub terminal_shell: Option<TerminalShellSelection>,
    /// Immutable snapshot of the Custom CLI profile chosen for this pane.
    #[serde(default)]
    pub custom_cli: Option<CustomCliConfig>,
    /// Set iff `kind == Some("file")` — the absolute path this viewer tile
    /// shows. A file pane with no path self-heals to a terminal pane on the
    /// frontend, so an old binary that strips this field degrades cleanly.
    #[serde(default)]
    pub file_path: Option<String>,
    /// Initial view mode for a file pane (`"preview"` | `"raw"`). Absent ⇒ the
    /// editor's per-extension default (markdown renders, everything else raw).
    #[serde(default)]
    pub file_view: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    tag = "kind"
)]
pub enum ExecutionTargetRef {
    Local,
    Ssh { server_id: String },
}

/// Tolerant deserializer for `Workspace::execution_target`. The Syndicate
/// integration was removed in 2026-08 (Syndicate is no longer part of the
/// Packet* family), but state files written while it existed can still carry
/// `{"kind": "syndicate", ...}` targets. Any unknown kind loads as `None`
/// (⇒ legacy local/SSH normalization) instead of failing the whole state load.
fn tolerant_execution_target<'de, D>(
    deserializer: D,
) -> Result<Option<ExecutionTargetRef>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let value = Option::<serde_json::Value>::deserialize(deserializer)?;
    Ok(value.and_then(|v| serde_json::from_value(v).ok()))
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GithubRepo {
    pub owner: String,
    pub repo: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Workspace {
    pub id: String,
    pub name: String,
    pub agents: Vec<String>,
    pub panes: Vec<WorkspacePane>,
    pub project_path: String,
    pub prompt: Option<String>,
    pub created_at: u64,
    pub updated_at: u64,
    pub status: String,
    pub bypass_permissions: Option<bool>,
    pub model_overrides: Option<std::collections::HashMap<String, Option<String>>>,
    pub effort_overrides: Option<std::collections::HashMap<String, Option<String>>>,
    #[serde(default)]
    pub server_id: Option<String>,
    #[serde(default)]
    pub remote_project_path: Option<String>,
    #[serde(default)]
    pub github_repo: Option<GithubRepo>,
    /// Workspace origin marker (tile program, P1-S2). `Some("conversation")`
    /// tags an auto-materialized conversation wrapper (deterministic id
    /// `ws-wrap-<convId>`) created by `sessionGlue.openSession`. `None` ⇒ a
    /// normal user-created workspace, so an old binary that never wrote this
    /// field degrades cleanly. Inert `#[serde(default)]` mirror — same
    /// downgrade pattern as the pane-level `kind`/`conversation_id`.
    #[serde(default)]
    pub origin: Option<String>,
    /// Workspace-level raw-terminal shell override. Absent means inherit the
    /// app default (which itself defaults to Auto).
    #[serde(default)]
    pub terminal_shell: Option<TerminalShellSelection>,
    /// The user's hand-arranged mosaic tile layout, stored opaquely as the
    /// react-mosaic tree the frontend owns. `None` ⇒ fall back to the
    /// pane-count preset, which is what every session did before this field
    /// existed and what an old binary that strips it degrades to. The backend
    /// never interprets the shape; the frontend reconciles its leaves against
    /// the real pane list on load, so a stale or malformed tree cannot render
    /// a pane twice or lose one.
    #[serde(default)]
    pub layout: Option<serde_json::Value>,
    /// New workspaces persist the tagged execution target. `None` is retained
    /// only for legacy records and normalizes to local/SSH from the historical
    /// fields in the frontend. Deserialization is tolerant: a target of an
    /// unknown kind (e.g. `"syndicate"`, written before that integration was
    /// removed) degrades to `None` rather than rejecting the record.
    #[serde(default, deserialize_with = "tolerant_execution_target")]
    pub execution_target: Option<ExecutionTargetRef>,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn conversation_pane() -> WorkspacePane {
        WorkspacePane {
            id: "pane-conv".to_string(),
            // Inert carrier: conversation panes persist agent_id "terminal",
            // never "conversation" — `kind` is the sole discriminant.
            agent_id: "terminal".to_string(),
            session_id: None,
            grid_position: GridPosition { row: 0, col: 1 },
            accent_color: None,
            pinned_commands: None,
            task_id: None,
            flight_id: None,
            agent_config_id: None,
            initial_prompt: None,
            override_command: None,
            override_args: None,
            kind: Some("conversation".to_string()),
            conversation_id: Some("conv-123".to_string()),
            account_id: None,
            terminal_shell: None,
            custom_cli: None,
            file_path: None,
            file_view: None,
        }
    }

    #[test]
    fn conversation_pane_serde_round_trips_kind_and_conversation_id() {
        let pane = conversation_pane();
        let json = serde_json::to_string(&pane).unwrap();
        let back: WorkspacePane = serde_json::from_str(&json).unwrap();

        assert_eq!(back.agent_id, "terminal");
        assert_eq!(back.kind.as_deref(), Some("conversation"));
        assert_eq!(back.conversation_id.as_deref(), Some("conv-123"));
    }

    #[test]
    fn old_binary_pane_without_kind_defaults_to_terminal() {
        // Simulate a pane written by an old binary that never knew about the
        // kind/conversation_id fields: both must default to None (terminal).
        let legacy = r#"{
            "id": "pane-1",
            "agent_id": "terminal",
            "session_id": null,
            "grid_position": { "row": 0, "col": 0 }
        }"#;
        let pane: WorkspacePane = serde_json::from_str(legacy).unwrap();

        assert_eq!(pane.agent_id, "terminal");
        assert!(pane.kind.is_none());
        assert!(pane.conversation_id.is_none());
        // Multi-account: absent ⇒ ambient login, exactly today's behaviour.
        assert!(pane.account_id.is_none());
        assert!(pane.terminal_shell.is_none());
    }

    #[test]
    fn pane_account_id_round_trips() {
        let pane = WorkspacePane {
            id: "pane-cli".to_string(),
            agent_id: "claude-code".to_string(),
            session_id: None,
            grid_position: GridPosition { row: 0, col: 0 },
            accent_color: None,
            pinned_commands: None,
            task_id: None,
            flight_id: None,
            agent_config_id: None,
            initial_prompt: None,
            override_command: None,
            override_args: None,
            kind: None,
            conversation_id: None,
            account_id: Some("acct-personal".to_string()),
            terminal_shell: None,
            custom_cli: None,
            file_path: None,
            file_view: None,
        };
        let json = serde_json::to_string(&pane).unwrap();
        let back: WorkspacePane = serde_json::from_str(&json).unwrap();
        assert_eq!(back.account_id.as_deref(), Some("acct-personal"));
    }

    fn wrapper_workspace() -> Workspace {
        Workspace {
            id: "ws-wrap-conv-123".to_string(),
            name: "my task".to_string(),
            agents: vec![],
            panes: vec![conversation_pane()],
            project_path: "/proj".to_string(),
            prompt: None,
            created_at: 1,
            updated_at: 1,
            status: "active".to_string(),
            bypass_permissions: None,
            model_overrides: None,
            effort_overrides: None,
            server_id: None,
            remote_project_path: None,
            github_repo: None,
            origin: Some("conversation".to_string()),
            layout: None,
            terminal_shell: None,
            execution_target: None,
        }
    }

    #[test]
    fn persisted_syndicate_target_degrades_to_none_not_an_error() {
        // A workspace saved while the (now removed) Syndicate integration
        // existed can carry a tagged `syndicate` execution target. It must
        // load — with the target dropped — not fail the whole state file.
        let json = serde_json::to_string(&wrapper_workspace()).unwrap();
        let mut value: serde_json::Value = serde_json::from_str(&json).unwrap();
        value["execution_target"] = serde_json::json!({
            "kind": "syndicate",
            "machineId": "machine-1",
            "workspaceId": "ws-host-1",
            "serverConfigId": "srv-1"
        });
        let back: Workspace = serde_json::from_value(value).unwrap();
        assert!(back.execution_target.is_none());

        // Known kinds still round-trip through the tolerant path.
        let mut ssh = wrapper_workspace();
        ssh.execution_target = Some(ExecutionTargetRef::Ssh {
            server_id: "srv-1".to_string(),
        });
        let json = serde_json::to_string(&ssh).unwrap();
        let back: Workspace = serde_json::from_str(&json).unwrap();
        assert_eq!(back.execution_target, ssh.execution_target);
    }

    #[test]
    fn wrapper_workspace_origin_round_trips() {
        let ws = wrapper_workspace();
        let json = serde_json::to_string(&ws).unwrap();
        let back: Workspace = serde_json::from_str(&json).unwrap();
        assert_eq!(back.origin.as_deref(), Some("conversation"));
    }

    #[test]
    fn old_binary_workspace_without_origin_defaults_to_none() {
        // A workspace written by an old binary that never knew about `origin`
        // must default to None — an inert #[serde(default)] mirror.
        let legacy = r#"{
            "id": "ws-1",
            "name": "legacy",
            "agents": [],
            "panes": [],
            "project_path": "/proj",
            "prompt": null,
            "created_at": 1,
            "updated_at": 1,
            "status": "active",
            "bypass_permissions": null,
            "model_overrides": null,
            "effort_overrides": null
        }"#;
        let ws: Workspace = serde_json::from_str(legacy).unwrap();
        assert!(ws.origin.is_none());
        assert!(ws.terminal_shell.is_none());
    }

    #[test]
    fn old_binary_resave_strips_carrier_to_plain_terminal() {
        // Round-trip through a struct that has NO knowledge of the new fields
        // (the shape an old binary would re-serialize) and confirm the pane
        // parses back as a plain terminal pane — the inert-carrier arm, not a
        // deserialization failure. The full self-heal sweep lands in P1-S2.
        #[derive(serde::Serialize, serde::Deserialize)]
        struct LegacyPane {
            id: String,
            agent_id: String,
            session_id: Option<String>,
            grid_position: GridPosition,
        }

        let conv = conversation_pane();
        // An old binary re-serializing only knows the legacy fields.
        let legacy = LegacyPane {
            id: conv.id.clone(),
            agent_id: conv.agent_id.clone(),
            session_id: conv.session_id.clone(),
            grid_position: conv.grid_position.clone(),
        };
        let json = serde_json::to_string(&legacy).unwrap();
        let reloaded: WorkspacePane = serde_json::from_str(&json).unwrap();

        assert_eq!(reloaded.agent_id, "terminal");
        assert!(reloaded.kind.is_none());
        assert!(reloaded.conversation_id.is_none());
        assert!(reloaded.account_id.is_none());
        assert!(reloaded.terminal_shell.is_none());
    }

    #[test]
    fn terminal_shell_overrides_round_trip_and_default_absent() {
        let mut pane = conversation_pane();
        pane.kind = None;
        pane.conversation_id = None;
        pane.terminal_shell = Some(TerminalShellSelection {
            profile: "wsl".to_string(),
            executable: Some("wsl.exe".to_string()),
            args: None,
            wsl_distro: Some("Ubuntu".to_string()),
        });
        let json = serde_json::to_string(&pane).unwrap();
        let back: WorkspacePane = serde_json::from_str(&json).unwrap();
        assert_eq!(back.terminal_shell, pane.terminal_shell);

        let mut workspace = wrapper_workspace();
        workspace.terminal_shell = Some(TerminalShellSelection {
            profile: "git-bash".to_string(),
            executable: Some("C:\\Program Files\\Git\\bin\\bash.exe".to_string()),
            args: Some(vec!["--login".to_string(), "-i".to_string()]),
            wsl_distro: None,
        });
        let json = serde_json::to_string(&workspace).unwrap();
        let back: Workspace = serde_json::from_str(&json).unwrap();
        assert_eq!(back.terminal_shell, workspace.terminal_shell);
    }
}
