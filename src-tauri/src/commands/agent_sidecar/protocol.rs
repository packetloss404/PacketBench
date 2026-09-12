//! Outbound request encoders — the `forward_*` methods that slice C's
//! routing layer in `api_agent.rs` calls. Each method shapes a JSON
//! request, then pushes it onto the supervisor's stdin writer channel.

use serde_json::{json, Value};

use super::supervisor::SidecarManager;
use crate::core::execution::SshConfig;

impl SidecarManager {
    // NOTE (WI-1, `dev/oauth-removal-plan.md`): the bare `forward_start`
    // convenience wrapper lived here until the four auxiliary features (spec
    // import, the two Code Quality AI actions, the two GitHub PR AI actions)
    // stopped calling it with a hardcoded `"claude-oauth"` provider. It had no
    // other callers, so it was removed with them. Its absence is the guarantee
    // that every remaining path into the sidecar comes from
    // `api_agent.rs`'s routing layer, which is gated by `is_sidecar_provider`.

    /// Forward a start request with MCPH4's frozen per-session MCP authority.
    #[allow(clippy::too_many_arguments)]
    pub async fn forward_start_with_mcp_trust(
        &self,
        session_id: String,
        provider: String,
        model: String,
        system_prompt: String,
        allowed_tools: Vec<String>,
        mcp_servers: Value,
        source_mcp_from_fs: bool,
        project_path: String,
        initial_message: String,
        api_key: Option<String>,
        resume: Option<String>,
        thinking_enabled: Option<bool>,
        plan_mode: Option<bool>,
        attachments: Value,
        resume_messages: Value,
        permission_mode: Option<String>,
        approve_writes: Option<bool>,
        command_path: Option<String>,
        workspace: Option<Value>,
        mcp_trust_snapshot: Value,
    ) -> Result<(), String> {
        self.forward_start_inner(
            session_id,
            provider,
            model,
            system_prompt,
            allowed_tools,
            mcp_servers,
            source_mcp_from_fs,
            project_path,
            initial_message,
            api_key,
            resume,
            thinking_enabled,
            plan_mode,
            attachments,
            resume_messages,
            permission_mode,
            approve_writes,
            command_path,
            workspace,
            mcp_trust_snapshot,
            None,
        )
        .await
    }

    /// SSH equivalent of `forward_start_with_mcp_trust`.
    #[allow(clippy::too_many_arguments)]
    pub async fn forward_start_ssh_with_mcp_trust(
        &self,
        session_id: String,
        provider: String,
        model: String,
        system_prompt: String,
        allowed_tools: Vec<String>,
        mcp_servers: Value,
        source_mcp_from_fs: bool,
        project_path: String,
        initial_message: String,
        api_key: Option<String>,
        resume: Option<String>,
        thinking_enabled: Option<bool>,
        plan_mode: Option<bool>,
        attachments: Value,
        resume_messages: Value,
        permission_mode: Option<String>,
        approve_writes: Option<bool>,
        command_path: Option<String>,
        workspace: Option<Value>,
        mcp_trust_snapshot: Value,
        ssh_config: SshConfig,
    ) -> Result<(), String> {
        self.forward_start_inner(
            session_id,
            provider,
            model,
            system_prompt,
            allowed_tools,
            mcp_servers,
            source_mcp_from_fs,
            project_path,
            initial_message,
            api_key,
            resume,
            thinking_enabled,
            plan_mode,
            attachments,
            resume_messages,
            permission_mode,
            approve_writes,
            command_path,
            workspace,
            mcp_trust_snapshot,
            Some(ssh_config),
        )
        .await
    }

    #[allow(clippy::too_many_arguments)]
    async fn forward_start_inner(
        &self,
        session_id: String,
        provider: String,
        model: String,
        system_prompt: String,
        allowed_tools: Vec<String>,
        mcp_servers: Value,
        source_mcp_from_fs: bool,
        project_path: String,
        initial_message: String,
        api_key: Option<String>,
        resume: Option<String>,
        thinking_enabled: Option<bool>,
        plan_mode: Option<bool>,
        attachments: Value,
        resume_messages: Value,
        permission_mode: Option<String>,
        approve_writes: Option<bool>,
        command_path: Option<String>,
        workspace: Option<Value>,
        mcp_trust_snapshot: Value,
        ssh_config: Option<SshConfig>,
    ) -> Result<(), String> {
        // F7: the v11 `mcpTrustSnapshot` below is only authority if the peer
        // reading it understands v11. An older sidecar drops the field on the
        // floor and runs every MCP server unfiltered, so refuse rather than
        // hand a live API key and an unenforced trust snapshot to a peer that
        // will quietly ignore half of it.
        //
        // SSH spawning waits for that peer's compatible ready handshake
        // before returning. The local handshake says nothing about it.
        if ssh_config.is_none() {
            self.assert_protocol_floor().await?;
        }
        if let Some(config) = ssh_config.as_ref() {
            self.spawn_remote_sidecar_for_session(&session_id, &provider, config)
                .await?;
        }
        {
            let mut sessions = self.owned_sessions.lock().await;
            sessions.insert(session_id.clone());
        }
        // Record the session's provider + model so the `turn_summary` handler
        // can attribute and price usage-ledger rows even for sessions that own
        // no flight role. Removed by `forget_owned_session` on the failure
        // path below and at every other session-death cleanup site.
        {
            let mut meta = self.session_usage_meta.lock().await;
            meta.insert(
                session_id.clone(),
                super::supervisor::SessionUsageMeta {
                    provider: provider.clone(),
                    model: model.clone(),
                },
            );
        }
        let req = encode_start_session(
            &session_id,
            provider,
            model,
            system_prompt,
            allowed_tools,
            mcp_servers,
            source_mcp_from_fs,
            project_path,
            initial_message,
            api_key,
            resume,
            thinking_enabled,
            plan_mode,
            attachments,
            resume_messages,
            permission_mode,
            approve_writes,
            command_path,
            workspace,
            mcp_trust_snapshot,
        );
        let result = self.send_json_for_session(&session_id, req).await;
        if result.is_err() {
            self.forget_owned_session(&session_id).await;
            self.close_remote_session(&session_id).await;
        }
        result
    }

    /// Forward a send_message request for an existing sidecar session.
    pub async fn forward_send(
        &self,
        session_id: String,
        content: String,
        attachments: Value,
    ) -> Result<(), String> {
        let req = json!({
            "type": "send_message",
            "sessionId": session_id,
            "content": content,
            "attachments": attachments,
        });
        // Ownership is lifecycle state, not writer availability. The local
        // supervisor or remote-process waiter clears it authoritatively if the
        // transport really exited; a transient closed writer must not reroute a
        // later message into the in-process runtime.
        self.send_json_for_session(&session_id, req).await
    }

    /// Forward a permission decision to the sidecar. `reason`, when set on a
    /// deny, carries the user's steering text — providers fold it into the
    /// synthetic tool result so the model is redirected, not just refused.
    pub async fn forward_permission(
        &self,
        session_id: String,
        tool_use_id: String,
        decision: String,
        reason: Option<String>,
    ) -> Result<(), String> {
        let mut req = json!({
            "type": "permission_response",
            "sessionId": session_id,
            "toolUseId": tool_use_id,
            "decision": decision,
        });
        if let Some(r) = reason {
            req["reason"] = json!(r);
        }
        self.send_json_for_session(&session_id, req).await
    }

    /// Forward a pending-edit approval/rejection to the sidecar. v3:
    /// `merged_content` carries an override file body for per-hunk
    /// acceptance — when present, the provider writes that content directly
    /// instead of letting the SDK's tool land its full `after`.
    pub async fn forward_edit(
        &self,
        session_id: String,
        tool_use_id: String,
        approved: bool,
        merged_content: Option<String>,
    ) -> Result<(), String> {
        let req = json!({
            "type": "edit_response",
            "sessionId": session_id,
            "toolUseId": tool_use_id,
            "approved": approved,
            "mergedContent": merged_content,
        });
        self.send_json_for_session(&session_id, req).await
    }

    /// Forward a permission-mode change to the sidecar. Slice C's routing layer
    /// translates the legacy `set_plan_mode` / `set_approve_writes` booleans
    /// into one of the protocol's mode strings (`"default"`, `"plan"`,
    /// `"acceptEdits"`, `"bypassPermissions"`) before calling this.
    pub async fn forward_set_permission_mode(
        &self,
        session_id: String,
        mode: String,
    ) -> Result<(), String> {
        let req = json!({
            "type": "set_permission_mode",
            "sessionId": session_id,
            "mode": mode,
        });
        self.send_json_for_session(&session_id, req).await
    }

    /// Forward a model swap to the sidecar. Providers that can't hot-swap
    /// (e.g. Codex one-shot exec) stash the value for the next spawn.
    pub async fn forward_set_model(&self, session_id: String, model: String) -> Result<(), String> {
        let req = json!({
            "type": "set_model",
            "sessionId": session_id,
            "model": model.clone(),
        });
        let result = self.send_json_for_session(&session_id, req).await;
        // Keep the usage-ledger metadata in step with the sidecar's active
        // model so subsequent turn_summary rows price against the right rates.
        if result.is_ok() {
            if let Some(meta) = self.session_usage_meta.lock().await.get_mut(&session_id) {
                meta.model = model;
            }
        }
        result
    }

    /// Forward a retry / regenerate-last-turn request to the sidecar.
    pub async fn forward_retry(&self, session_id: String) -> Result<(), String> {
        let req = json!({
            "type": "retry",
            "sessionId": session_id,
        });
        self.send_json_for_session(&session_id, req).await
    }

    /// Forward a turn cancel to the sidecar. Cancellation emits an explicit
    /// `done { cancelled: true }` terminal event but intentionally keeps the
    /// conversation and (for SSH) its remote sidecar alive for follow-up
    /// turns. `forward_close` owns lifetime cleanup and releases both routes.
    pub async fn forward_cancel(&self, session_id: String) -> Result<(), String> {
        let req = json!({
            "type": "cancel",
            "sessionId": session_id,
        });
        self.send_json_for_session(&session_id, req).await
    }

    /// F8: drain any parked permission/edit prompts as denied without
    /// killing the agent loop. Used by the per-conversation "Cancel
    /// pending" UI affordance.
    pub async fn forward_cancel_pending_tools(&self, session_id: String) -> Result<(), String> {
        let req = json!({
            "type": "cancel_pending_tools",
            "sessionId": session_id,
        });
        self.send_json_for_session(&session_id, req).await
    }

    /// Forward a close request and remove from owned sessions.
    pub async fn forward_close(&self, session_id: String) -> Result<(), String> {
        let req = json!({
            "type": "close_session",
            "sessionId": session_id,
        });
        let result = self.send_json_for_session(&session_id, req).await;
        self.forget_owned_session(&session_id).await;
        self.close_remote_session(&session_id).await;
        result
    }
}

/// Encode a `start_session` request as the wire JSON the sidecar consumes.
/// Extracted as a pure seam so the wire shape — including S8-Phase-B's
/// `sourceMcpFromFs` flag — is unit-testable without a live supervisor.
#[allow(clippy::too_many_arguments)]
pub(super) fn encode_start_session(
    session_id: &str,
    provider: String,
    model: String,
    system_prompt: String,
    allowed_tools: Vec<String>,
    mcp_servers: Value,
    source_mcp_from_fs: bool,
    project_path: String,
    initial_message: String,
    api_key: Option<String>,
    resume: Option<String>,
    thinking_enabled: Option<bool>,
    plan_mode: Option<bool>,
    attachments: Value,
    resume_messages: Value,
    permission_mode: Option<String>,
    approve_writes: Option<bool>,
    command_path: Option<String>,
    workspace: Option<Value>,
    mcp_trust_snapshot: Value,
) -> Value {
    json!({
        "type": "start_session",
        "sessionId": session_id,
        "provider": provider,
        "model": model,
        "systemPrompt": system_prompt,
        "allowedTools": allowed_tools,
        "mcpServers": mcp_servers,
        "mcpTrustSnapshot": mcp_trust_snapshot,
        "sourceMcpFromFs": source_mcp_from_fs,
        "projectTrustDataDir": crate::core::brand::DATA_DIR_NAME,
        "projectPath": project_path,
        "initialMessage": initial_message,
        "apiKey": api_key,
        "resume": resume,
        "thinkingEnabled": thinking_enabled,
        "planMode": plan_mode,
        "attachments": attachments,
        "resumeMessages": resume_messages,
        "permissionMode": permission_mode,
        "approveWrites": approve_writes,
        "commandPath": command_path,
        "workspace": workspace.unwrap_or_else(|| {
            json!({
                "kind": "local",
                "projectPath": project_path,
            })
        }),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn encode_start_session_carries_source_mcp_from_fs_and_empty_servers() {
        // S8-Phase-B: a remote launch forwards an empty `mcpServers` map plus
        // `sourceMcpFromFs = true` so the sidecar sources its own remote FS
        // config — assert both land on the wire.
        let req = encode_start_session(
            "sess-1",
            "echo".to_string(),
            "echo".to_string(),
            String::new(),
            Vec::new(),
            json!({}),
            true,
            "/srv/app".to_string(),
            "hi".to_string(),
            None,
            None,
            None,
            None,
            Value::Null,
            Value::Null,
            None,
            None,
            None,
            None,
            Value::Null,
        );
        assert_eq!(req["type"], "start_session");
        assert_eq!(req["mcpServers"], json!({}));
        assert_eq!(req["sourceMcpFromFs"], json!(true));
        assert_eq!(
            req["projectTrustDataDir"],
            json!(crate::core::brand::DATA_DIR_NAME)
        );
    }

    #[test]
    fn encode_start_session_local_flag_off() {
        let req = encode_start_session(
            "sess-2",
            "echo".to_string(),
            "echo".to_string(),
            String::new(),
            Vec::new(),
            json!({ "srv": { "type": "stdio", "command": "node" } }),
            false,
            "/home/me/app".to_string(),
            "hi".to_string(),
            None,
            None,
            None,
            None,
            Value::Null,
            Value::Null,
            None,
            None,
            None,
            None,
            Value::Null,
        );
        assert_eq!(req["sourceMcpFromFs"], json!(false));
        assert_eq!(req["mcpServers"]["srv"]["command"], "node");
    }
}
