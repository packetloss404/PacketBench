//! Frozen native-session MCP configuration, discovery and connections.
use crate::{
    commands::mcp::McpServerEntry,
    core::{
        llm_types::ToolDefinition,
        mcp_bridge::{self, McpTrustSnapshot},
        mcp_client::{McpClient, McpToolInfo},
        mcp_network::{NetworkClient, NetworkConfig},
    },
};
use serde_json::Value;
use std::{
    collections::{BTreeMap, HashMap},
    path::PathBuf,
};
use tokio::sync::{Mutex, OnceCell};

enum TransportConfig {
    Stdio {
        command: String,
        args: Vec<String>,
        env: HashMap<String, String>,
        cwd: PathBuf,
    },
    Network(NetworkConfig),
}
enum Client {
    Stdio(McpClient),
    Network(NetworkClient),
}
struct Server {
    name: String,
    config: TransportConfig,
    // A scope/root-matched snapshot only. Never match another scope by name.
    trust: Vec<McpTrustSnapshot>,
    client: Mutex<Option<Client>>,
}
struct Tool {
    server: usize,
    original: String,
    read_only: bool,
}
struct Discovery {
    definitions: Vec<ToolDefinition>,
    tools: HashMap<String, Tool>,
}

#[derive(Default)]
pub struct NativeMcpSession {
    servers: Vec<Server>,
    discovery: OnceCell<Result<Discovery, String>>,
}

impl NativeMcpSession {
    pub fn for_ssh(selected: Option<&[String]>) -> Result<Self, String> {
        if selected.is_some_and(|names| names.is_empty()) {
            return Ok(Self::default());
        }
        Err("Native API providers cannot connect MCP servers on an SSH execution host. Choose an SDK provider for remote-owned MCP, or explicitly deselect all MCP servers for this conversation. Desktop MCP configuration was not read.".into())
    }

    pub fn resolve(
        entries: Vec<McpServerEntry>,
        project: &str,
        project_trusted: bool,
        selected: Option<&[String]>,
        snapshots: Option<&[McpTrustSnapshot]>,
    ) -> Result<Self, String> {
        let mut by_name = BTreeMap::new();
        // Override before filtering: an untrusted/disabled project entry must
        // never silently select a same-named global command instead.
        for entry in entries.iter().filter(|e| e.scope == "global") {
            by_name.insert(entry.name.clone(), entry);
        }
        for entry in entries.iter().filter(|e| e.scope == "project") {
            by_name.insert(entry.name.clone(), entry);
        }
        if let Some(selected) = selected {
            for name in selected {
                if !by_name.contains_key(name) {
                    return Err(format!(
                        "Selected MCP server '{name}' is not configured for this workspace"
                    ));
                }
            }
        }
        let mut servers = vec![];
        for (name, entry) in by_name {
            if selected.is_some_and(|names| !names.contains(&name)) {
                continue;
            }
            if entry.disabled || (entry.scope == "project" && !project_trusted) {
                if selected.is_some() {
                    return Err(format!("Selected MCP server '{name}' is disabled or its project is not trusted. Enable it and trust this project, or deselect it."));
                }
                continue;
            }
            let id = format!("{}:{}", entry.scope, name);
            let trust: Vec<_> = snapshots
                .unwrap_or_default()
                .iter()
                .filter(|s| {
                    s.server_id == id
                        && s.server_name == name
                        && s.workspace_path.as_deref() == Some(project)
                })
                .cloned()
                .collect();
            // A supplied but mismatched snapshot is not legacy authority.
            if snapshots.is_some() && trust.len() != 1 {
                return Err(format!("MCP server '{name}' has no unambiguous trust snapshot for this scope and workspace. Reconnect after reviewing MCP trust."));
            }
            if trust.first().is_some_and(|s| !s.allow_reads) {
                continue;
            }
            let kind = entry
                .raw_config
                .get("type")
                .and_then(Value::as_str)
                .unwrap_or(if entry.raw_config.get("url").is_some() {
                    "http"
                } else {
                    "stdio"
                });
            let config = match kind {
                "stdio" => {
                    if entry.config.command.trim().is_empty() {
                        return Err(format!("MCP server '{name}' has no command"));
                    }
                    TransportConfig::Stdio {
                        command: entry.config.command.clone(),
                        args: entry.config.args.clone(),
                        env: entry.config.env.clone(),
                        cwd: PathBuf::from(project),
                    }
                }
                "http" | "sse" => {
                    if !trust.first().is_some_and(|s| s.allow_network) {
                        if selected.is_none() {
                            continue;
                        }
                        return Err(format!("MCP server '{name}' requires explicit network permission in Settings → MCP Hub before connecting"));
                    }
                    TransportConfig::Network(
                        NetworkConfig::parse(&entry.raw_config, kind == "sse")
                            .map_err(|e| format!("MCP server '{name}': {e}"))?,
                    )
                }
                _ => {
                    return Err(format!(
                    "MCP server '{name}' uses an unsupported transport; select stdio, http or sse"
                ))
                }
            };
            servers.push(Server {
                name,
                config,
                trust,
                client: Mutex::new(None),
            });
        }
        Ok(Self {
            servers,
            discovery: OnceCell::new(),
        })
    }

    async fn discover(&self) -> Result<Discovery, String> {
        let mut definitions = vec![];
        let mut mapping = HashMap::new();
        let mut clients = vec![];
        for (index, server) in self.servers.iter().enumerate() {
            let mut client = match &server.config {
                TransportConfig::Stdio {
                    command,
                    args,
                    env,
                    cwd,
                } => Client::Stdio(
                    McpClient::spawn_in_directory(&server.name, command, args, env, Some(cwd))
                        .await
                        .map_err(|e| e.to_string())?,
                ),
                TransportConfig::Network(config) => {
                    Client::Network(NetworkClient::connect(config).await?)
                }
            };
            let tools: Vec<McpToolInfo> = match &mut client {
                Client::Stdio(client) => client.list_tools().await.map_err(|e| e.to_string())?,
                Client::Network(client) => client.list_tools().await?,
            };
            for tool in tools {
                let read_only = tool.is_read_only();
                if !mcp_bridge::trust_allows_advertisement(
                    server.trust(),
                    &server.name,
                    &tool.name,
                    Some(read_only),
                ) {
                    continue;
                }
                let name = mcp_bridge::make_tool_name(&server.name, &tool.name);
                if mapping.contains_key(&name) {
                    return Err("MCP tools have colliding provider names".into());
                }
                mapping.insert(
                    name.clone(),
                    Tool {
                        server: index,
                        original: tool.name,
                        read_only,
                    },
                );
                definitions.push(ToolDefinition {
                    name,
                    description: tool.description,
                    parameters: tool.input_schema,
                });
            }
            clients.push(client);
        }
        for (server, client) in self.servers.iter().zip(clients) {
            *server.client.lock().await = Some(client);
        }
        Ok(Discovery {
            definitions,
            tools: mapping,
        })
    }

    pub async fn tool_definitions(&self) -> Result<Vec<ToolDefinition>, String> {
        let result = self
            .discovery
            .get_or_init(|| async {
                let result = self.discover().await;
                if result.is_err() {
                    // Failed startup must release servers already opened in this pass.
                    for server in &self.servers {
                        *server.client.lock().await = None;
                    }
                }
                result
            })
            .await;
        result
            .as_ref()
            .map(|d| d.definitions.clone())
            .map_err(Clone::clone)
    }

    pub async fn close(&self) {
        for server in &self.servers {
            *server.client.lock().await = None;
        }
    }

    pub async fn execute(&self, name: &str, args: &Value, child: bool) -> Result<String, String> {
        let discovery = self
            .discovery
            .get()
            .ok_or("MCP discovery has not completed")?
            .as_ref()
            .map_err(Clone::clone)?;
        let tool = discovery
            .tools
            .get(name)
            .ok_or("MCP tool is not in this session's frozen advertisement")?;
        let server = &self.servers[tool.server];
        if child {
            mcp_bridge::enforce_subagent_tool_trust(
                server.trust(),
                &server.name,
                &tool.original,
                args,
                tool.read_only,
            )?;
        } else {
            mcp_bridge::enforce_tool_trust(
                server.trust(),
                &server.name,
                &tool.original,
                args,
                Some(tool.read_only),
            )?;
        }
        let mut slot = server.client.lock().await;
        match slot
            .as_mut()
            .ok_or("MCP connection closed; reconnect this conversation explicitly")?
        {
            Client::Stdio(client) => match client.call_tool(&tool.original, args).await {
                Ok(output) => Ok(output),
                Err(error) => {
                    let disconnected = error.is_connection();
                    let message = error.to_string();
                    if disconnected {
                        *slot = None;
                    }
                    Err(message)
                }
            },
            Client::Network(client) => {
                let result = client.call_tool(&tool.original, args).await;
                if client.is_closed() {
                    *slot = None;
                }
                result
            }
        }
    }
}
impl Server {
    fn trust(&self) -> Option<&[McpTrustSnapshot]> {
        if self.trust.is_empty() {
            None
        } else {
            Some(&self.trust)
        }
    }
}

#[cfg(test)]
mod tests;
