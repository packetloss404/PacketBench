//! Session-owned MCP JSON-RPC client over child-process stdio.
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::process::Stdio;
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, ChildStdout, Command};
use tracing::{debug, info, warn};

const MCP_PROTOCOL_VERSION: &str = "2024-11-05";
const REQUEST_TIMEOUT_SECS: u64 = 30;

/// Transport failures invalidate a connection; tool-level failures leave it usable.
#[derive(Debug, Clone)]
pub enum McpError {
    /// Transport/process is broken; reconnect explicitly.
    Connection(String),
    /// A live server returned an error or unexpected payload; keep the client.
    Protocol(String),
}

impl McpError {
    /// True for transport/process failures; false for live-server tool errors.
    pub fn is_connection(&self) -> bool {
        matches!(self, McpError::Connection(_))
    }
}

impl std::fmt::Display for McpError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            McpError::Connection(msg) | McpError::Protocol(msg) => f.write_str(msg),
        }
    }
}

impl std::error::Error for McpError {}

/// Lossy conversion so existing `String`-returning boundaries keep working;
/// the connection/protocol distinction is dropped here, so map at the call
/// site (not via `?`/`.into()`) when connection invalidation depends on it.
impl From<McpError> for String {
    fn from(e: McpError) -> String {
        e.to_string()
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct McpToolInfo {
    pub name: String,
    #[serde(default)]
    pub description: String,
    #[serde(rename = "inputSchema", alias = "input_schema")]
    pub input_schema: Value,
    /// MCP tool annotations. `read_only_hint` is the server's own statement
    /// that a tool has no side effects, and it is what
    /// `mcp_bridge::trust_allows_advertisement` requires before letting a tool
    /// run in a read-only session. Absent annotations mean "unknown", which is
    /// treated as "not read-only".
    #[serde(default)]
    pub annotations: Option<McpToolAnnotations>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpToolAnnotations {
    #[serde(default)]
    pub read_only_hint: Option<bool>,
    #[serde(default)]
    pub destructive_hint: Option<bool>,
}

impl McpToolInfo {
    /// True only when the server explicitly annotated this tool read-only and
    /// did not simultaneously flag it destructive.
    pub fn is_read_only(&self) -> bool {
        match &self.annotations {
            Some(annotations) => {
                annotations.read_only_hint == Some(true)
                    && annotations.destructive_hint != Some(true)
            }
            None => false,
        }
    }
}

/// One spawned MCP server connection. Owns the child process plus the
/// stdin writer and a buffered stdout reader. JSON-RPC request IDs
/// increment monotonically per client.
pub struct McpClient {
    server_name: String,
    child: Child,
    stdin: ChildStdin,
    stdout: BufReader<ChildStdout>,
    next_id: i64,
}

impl Drop for McpClient {
    fn drop(&mut self) {
        // Check the root is still ours before using its PID; Windows taskkill
        // must run before the wrapper exits to reach its descendants.
        if matches!(self.child.try_wait(), Ok(None)) {
            if let Some(pid) = self.child.id() {
                crate::core::tool_runtime::kill_process_tree(pid);
            }
        }
    }
}

impl McpClient {
    /// Spawn the MCP server child process and perform the JSON-RPC
    /// `initialize` handshake. Sends `notifications/initialized` after
    /// receiving the initialize response.
    pub async fn spawn(
        server_name: &str,
        command: &str,
        args: &[String],
        env: &HashMap<String, String>,
    ) -> Result<Self, McpError> {
        Self::spawn_in_directory(server_name, command, args, env, None).await
    }

    pub async fn spawn_in_directory(
        server_name: &str,
        command: &str,
        args: &[String],
        env: &HashMap<String, String>,
        cwd: Option<&std::path::Path>,
    ) -> Result<Self, McpError> {
        info!(server = %server_name, cmd = %command, "Spawning MCP server");

        // Resolve `.cmd` wrappers on Windows for npm-installed binaries.
        let resolved_command = resolve_command_for_platform(command);

        let mut cmd = Command::new(&resolved_command);
        cmd.args(args);
        #[cfg(unix)]
        cmd.process_group(0);
        if let Some(cwd) = cwd {
            cmd.current_dir(cwd);
        }
        for (k, v) in env {
            cmd.env(k, v);
        }
        cmd.stdin(Stdio::piped());
        cmd.stdout(Stdio::piped());
        cmd.stderr(Stdio::piped());
        // Reap the child if the `initialize` handshake fails (timeout / garbage
        // output / closed stdout) and `spawn()` returns Err, or on session
        // teardown; dropping the `Child` then terminates the OS process.
        cmd.kill_on_drop(true);

        #[cfg(target_os = "windows")]
        {
            cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
        }

        let mut child = cmd.spawn().map_err(|e| {
            McpError::Connection(format!(
                "Failed to spawn MCP server '{}': {}",
                server_name, e
            ))
        })?;

        let stdin = child.stdin.take().ok_or_else(|| {
            McpError::Connection(format!("MCP server '{}' has no stdin", server_name))
        })?;
        let stdout = child.stdout.take().ok_or_else(|| {
            McpError::Connection(format!("MCP server '{}' has no stdout", server_name))
        })?;

        // Drain stderr in the background so the child doesn't block on a
        // full pipe; surface it as warn-level traces for debugging.
        if let Some(stderr) = child.stderr.take() {
            let server = server_name.to_string();
            tokio::spawn(async move {
                let mut reader = BufReader::new(stderr).lines();
                while let Ok(Some(line)) = reader.next_line().await {
                    warn!(server = %server, "MCP stderr: {}", line);
                }
            });
        }

        let mut client = McpClient {
            server_name: server_name.to_string(),
            child,
            stdin,
            stdout: BufReader::new(stdout),
            next_id: 1,
        };

        // initialize handshake
        let init_params = json!({
            "protocolVersion": MCP_PROTOCOL_VERSION,
            "capabilities": {},
            "clientInfo": {
                "name": crate::core::brand::APP_NAME,
                "version": "0.2"
            }
        });

        let _resp = client.request("initialize", init_params).await?;

        // Per MCP spec the client must send `notifications/initialized` after
        // a successful initialize response.
        client
            .notify("notifications/initialized", json!({}))
            .await?;

        info!(server = %server_name, "MCP server initialized");
        Ok(client)
    }

    /// Discover the server's tools via `tools/list`.
    pub async fn list_tools(&mut self) -> Result<Vec<McpToolInfo>, McpError> {
        let mut tools = vec![];
        let mut cursor = Value::Null;
        for _ in 0..64 {
            let params = if cursor.is_null() {
                json!({})
            } else {
                json!({"cursor":cursor})
            };
            let resp = self.request("tools/list", params).await?;
            let page: Vec<McpToolInfo> = serde_json::from_value(
                resp.get("tools")
                    .cloned()
                    .ok_or_else(|| McpError::Protocol("tools/list missing tools".into()))?,
            )
            .map_err(|_| McpError::Protocol("Invalid MCP tool list".into()))?;
            tools.extend(page);
            if tools.len() > 4096 {
                return Err(McpError::Protocol(
                    "MCP server advertises more than 4096 tools".into(),
                ));
            }
            cursor = resp.get("nextCursor").cloned().unwrap_or(Value::Null);
            if cursor.is_null() {
                return Ok(tools);
            }
        }
        Err(McpError::Protocol("MCP discovery exceeds 64 pages".into()))
    }

    /// Invoke a tool via `tools/call`. Joins all text content blocks from
    /// the response into a single string.
    pub async fn call_tool(&mut self, name: &str, arguments: &Value) -> Result<String, McpError> {
        let params = json!({
            "name": name,
            "arguments": arguments,
        });
        let resp = self.request("tools/call", params).await?;

        // Surface server-reported errors explicitly. A tool `isError` result is
        // a SUCCESSFUL protocol response describing a tool-level failure on a
        // live server — classify as Protocol so it leaves the connection usable.
        if let Some(is_error) = resp.get("isError").and_then(|v| v.as_bool()) {
            if is_error {
                let text = extract_text_content(&resp);
                return Err(McpError::Protocol(if text.is_empty() {
                    format!("MCP tool '{}' reported an error", name)
                } else {
                    text
                }));
            }
        }

        Ok(extract_text_content(&resp))
    }

    /// Best-effort graceful shutdown: send the `cancelled` notification,
    /// close stdin, then attempt to reap the child.
    pub async fn shutdown(mut self) {
        let _ = self
            .notify(
                "notifications/cancelled",
                json!({ "reason": "client shutdown" }),
            )
            .await;
        let _ = self.stdin.shutdown().await;
        // Don't block forever; if the child doesn't exit, kill it.
        match tokio::time::timeout(Duration::from_secs(2), self.child.wait()).await {
            Ok(_) => {}
            Err(_) => {
                let _ = self.child.start_kill();
            }
        }
    }

    /// Send a JSON-RPC request and wait for the matching response.
    async fn request(&mut self, method: &str, params: Value) -> Result<Value, McpError> {
        let id = self.next_id;
        self.next_id += 1;

        let req = json!({
            "jsonrpc": "2.0",
            "id": id,
            "method": method,
            "params": params,
        });

        self.write_message(&req).await?;

        // Loop reading lines until we find a response with the matching id.
        // Skip notifications and unrelated messages.
        let read_fut = async {
            loop {
                let mut line = String::new();
                let n = self
                    .stdout
                    .read_line(&mut line)
                    .await
                    .map_err(|e| McpError::Connection(format!("MCP read error: {}", e)))?;
                if n == 0 {
                    return Err(McpError::Connection(format!(
                        "MCP server '{}' closed stdout unexpectedly",
                        self.server_name
                    )));
                }
                let trimmed = line.trim();
                if trimmed.is_empty() {
                    continue;
                }
                let val: Value = match serde_json::from_str(trimmed) {
                    Ok(v) => v,
                    Err(e) => {
                        debug!(server = %self.server_name, "Skipping non-JSON line: {} ({})", trimmed, e);
                        continue;
                    }
                };
                let resp_id = val.get("id").and_then(|v| v.as_i64());
                if resp_id != Some(id) {
                    debug!(server = %self.server_name, "Skipping unrelated message id={:?}", resp_id);
                    continue;
                }
                if let Some(err) = val.get("error") {
                    let msg = err
                        .get("message")
                        .and_then(|v| v.as_str())
                        .unwrap_or("unknown JSON-RPC error");
                    // A JSON-RPC error object means the server is alive and
                    // responded — protocol-level, never evict.
                    return Err(McpError::Protocol(format!(
                        "MCP error from '{}': {}",
                        self.server_name, msg
                    )));
                }
                return Ok(val.get("result").cloned().unwrap_or(Value::Null));
            }
        };

        tokio::time::timeout(Duration::from_secs(REQUEST_TIMEOUT_SECS), read_fut)
            .await
            .map_err(|_| {
                McpError::Connection(format!(
                    "MCP server '{}' timed out responding to '{}'",
                    self.server_name, method
                ))
            })?
    }

    /// Send a JSON-RPC notification (no id, no response expected).
    async fn notify(&mut self, method: &str, params: Value) -> Result<(), McpError> {
        let msg = json!({
            "jsonrpc": "2.0",
            "method": method,
            "params": params,
        });
        self.write_message(&msg).await
    }

    async fn write_message(&mut self, msg: &Value) -> Result<(), McpError> {
        let mut line = serde_json::to_string(msg)
            .map_err(|e| McpError::Connection(format!("Failed to serialize MCP message: {}", e)))?;
        line.push('\n');
        self.stdin
            .write_all(line.as_bytes())
            .await
            .map_err(|e| McpError::Connection(format!("MCP write error: {}", e)))?;
        self.stdin
            .flush()
            .await
            .map_err(|e| McpError::Connection(format!("MCP flush error: {}", e)))?;
        Ok(())
    }
}

/// Extract joined text from the `content` array of a tools/call response.
pub(crate) fn extract_text_content(resp: &Value) -> String {
    let content = match resp.get("content").and_then(|v| v.as_array()) {
        Some(arr) => arr,
        None => {
            return resp
                .get("structuredContent")
                .map(Value::to_string)
                .unwrap_or_default()
        }
    };
    let mut out = String::new();
    for block in content {
        let ty = block.get("type").and_then(|v| v.as_str()).unwrap_or("");
        if ty == "text" {
            if let Some(text) = block.get("text").and_then(|v| v.as_str()) {
                if !out.is_empty() {
                    out.push('\n');
                }
                out.push_str(text);
            }
        }
    }
    if out.is_empty() {
        if let Some(content) = resp.get("structuredContent") {
            return content.to_string();
        }
    }
    out
}

/// On Windows, npm-installed binaries are typically `.cmd` shims. If the
/// caller passed a bare command name like `npx`, try the `.cmd` form first.
fn resolve_command_for_platform(command: &str) -> String {
    #[cfg(target_os = "windows")]
    {
        // If the caller already supplied an extension or path separator,
        // trust them. Otherwise probe PATH for `<cmd>.cmd`.
        if command.contains('/')
            || command.contains('\\')
            || command.to_lowercase().ends_with(".exe")
            || command.to_lowercase().ends_with(".cmd")
            || command.to_lowercase().ends_with(".bat")
        {
            return command.to_string();
        }
        if let Ok(path_var) = std::env::var("PATH") {
            for dir in std::env::split_paths(&path_var) {
                for ext in ["cmd", "bat", "exe"] {
                    let candidate = dir.join(format!("{}.{}", command, ext));
                    if candidate.is_file() {
                        return candidate.to_string_lossy().to_string();
                    }
                }
            }
        }
    }
    command.to_string()
}

#[cfg(test)]
mod tests;
