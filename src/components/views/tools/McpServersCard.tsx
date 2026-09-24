import { useEffect, useMemo, useState } from "react";
import { Plug, Plus, Pencil, Trash2, Globe, FolderOpen, RefreshCw } from "lucide-react";
import { useMcpStore } from "@/stores/mcpStore";
import { useAgentSettingsStore } from "@/stores/agentSettingsStore";
import { McpServerModal } from "../McpServerModal";
import { Checkbox } from "@/components/ui/Checkbox";
import { ConfirmDeleteModal } from "@/components/ui/ConfirmDeleteModal";
import { mcpServerTransport, type McpServerEntry } from "@/types/mcp";

export function McpServersCard() {
  const { servers, loading, error, fetchServers, addServer, updateServer, removeServer } =
    useMcpStore();
  const defaultEnabledMcpServerIds = useAgentSettingsStore((s) => s.defaultEnabledMcpServerIds);
  const setDefaultEnabledMcpServerIds = useAgentSettingsStore(
    (s) => s.setDefaultEnabledMcpServerIds,
  );
  const [showModal, setShowModal] = useState(false);
  const [editEntry, setEditEntry] = useState<McpServerEntry | null>(null);
  // Was an in-place "Confirm" button swap with no cancel affordance and no
  // timeout — a mis-click armed it and the next click destroyed the server.
  const [pendingDelete, setPendingDelete] = useState<McpServerEntry | null>(null);

  useEffect(() => {
    fetchServers();
  }, [fetchServers]);

  const globalServers = servers.filter((s) => s.scope === "global");
  const projectServers = servers.filter((s) => s.scope === "project");

  // Default MCP set for newly started agent sessions. null = every
  // non-disabled server (mirrors the old header popover's semantics).
  const eligibleServers = useMemo(() => servers.filter((s) => !s.disabled), [servers]);
  const activeNames = useMemo(
    () =>
      defaultEnabledMcpServerIds === null
        ? new Set(eligibleServers.map((s) => s.name))
        : new Set(defaultEnabledMcpServerIds),
    [defaultEnabledMcpServerIds, eligibleServers],
  );

  function toggleDefaultServer(name: string) {
    const current = defaultEnabledMcpServerIds ?? eligibleServers.map((s) => s.name);
    const next = current.includes(name) ? current.filter((n) => n !== name) : [...current, name];
    setDefaultEnabledMcpServerIds(next);
  }

  function resetDefaultToAll() {
    setDefaultEnabledMcpServerIds(null);
  }

  function handleEdit(entry: McpServerEntry) {
    setEditEntry(entry);
    setShowModal(true);
  }

  function handleAdd() {
    setEditEntry(null);
    setShowModal(true);
  }

  async function handleSave(
    name: string,
    command: string,
    args: string[],
    env: Record<string, string>,
    scope: "global" | "project",
  ) {
    if (editEntry) {
      // Hand over where the row currently lives so a scope change MOVES the
      // server. The modal's Scope buttons are live while editing and read as
      // "this server's scope"; without the old scope the write only upserted
      // into the other file and left the original behind, so switching Global
      // to Project silently produced two servers of the same name.
      await updateServer(name, command, args, env, scope, editEntry.scope as "global" | "project");
    } else {
      await addServer(name, command, args, env, scope);
    }
  }

  async function handleDelete(entry: McpServerEntry) {
    setPendingDelete(null);
    await removeServer(entry.name, entry.scope as "global" | "project");
  }

  return (
    <div className="rounded-lg border border-bg-border bg-bg-secondary p-4">
      <div className="mb-4 flex items-center justify-between">
        <h3 className="flex items-center gap-2 text-xs font-semibold text-text-primary">
          <Plug size={12} className="text-accent-blue" />
          MCP Servers
          <span className="rounded bg-bg-elevated px-1.5 py-0.5 text-[10px] font-normal text-text-muted">
            {servers.length} server{servers.length !== 1 ? "s" : ""}
          </span>
        </h3>
        <div className="flex items-center gap-2">
          <button
            onClick={() => fetchServers()}
            className="p-1 text-text-muted transition-colors hover:text-text-primary"
            title="Refresh"
          >
            <RefreshCw size={11} className={loading ? "animate-spin" : ""} />
          </button>
          <button
            onClick={handleAdd}
            className="flex items-center gap-1 rounded px-2 py-1 text-[11px] text-accent-green transition-colors hover:bg-accent-green/10"
          >
            <Plus size={11} />
            Add
          </button>
        </div>
      </div>

      {error && (
        <div className="mb-3 rounded border border-red-500/20 bg-red-500/10 px-3 py-2 text-[11px] text-red-400">
          {error}
        </div>
      )}

      <p className="mb-3 text-[11px] text-text-muted">
        Local API conversations support global and trusted project MCP servers over stdio, HTTP and
        SSE. URL-based servers require network permission in MCP Hub. For MCP on an SSH host, choose
        an SDK provider; other API providers require all MCP servers to be deselected.
      </p>

      <div className="mb-3 flex flex-wrap items-center justify-between gap-2 rounded border border-bg-border bg-bg-primary px-3 py-1.5">
        <span className="text-[10px] text-text-muted">
          "On for agent sessions" sets which MCP servers new agent conversations start with. Applies
          to newly started agent conversations.
          {defaultEnabledMcpServerIds?.length === 0 &&
            " All MCP servers are disabled for new conversations."}
        </span>
        <button
          onClick={() => setDefaultEnabledMcpServerIds([])}
          className="shrink-0 text-[10px] text-text-muted transition-colors hover:text-text-primary"
          title="Start new agent conversations without MCP, including native API conversations on SSH"
        >
          Disable all
        </button>
        <button
          onClick={resetDefaultToAll}
          className="ml-2 shrink-0 text-[10px] text-text-muted transition-colors hover:text-text-primary"
          title="Reset to default — every non-disabled server is enabled"
        >
          Reset to all
        </button>
      </div>

      <div className="space-y-3">
        <ServerGroup
          title="Global"
          icon={<Globe size={11} className="text-accent-green" />}
          servers={globalServers}
          onEdit={handleEdit}
          onRequestDelete={setPendingDelete}
          activeNames={activeNames}
          onToggleDefault={toggleDefaultServer}
        />
        <ServerGroup
          title="Project"
          icon={<FolderOpen size={11} className="text-accent-blue" />}
          servers={projectServers}
          onEdit={handleEdit}
          onRequestDelete={setPendingDelete}
          activeNames={activeNames}
          onToggleDefault={toggleDefaultServer}
        />
      </div>

      {servers.length === 0 && !loading && (
        <div className="py-8 text-center text-[11px] text-text-muted">
          <Plug size={20} className="mx-auto mb-2 opacity-30" />
          <p>No MCP servers configured</p>
          <p className="mt-1 text-[10px]">Add servers to extend Claude Code with custom tools</p>
        </div>
      )}

      {showModal && (
        <McpServerModal
          onClose={() => {
            setShowModal(false);
            setEditEntry(null);
          }}
          onSave={handleSave}
          initial={
            editEntry
              ? {
                  name: editEntry.name,
                  command: editEntry.config.command,
                  args: editEntry.config.args ?? [],
                  env: editEntry.config.env ?? {},
                  scope: editEntry.scope as "global" | "project",
                }
              : undefined
          }
        />
      )}

      {pendingDelete && (
        <ConfirmDeleteModal
          title="Delete MCP server?"
          entityName={`${pendingDelete.name} (${pendingDelete.scope})`}
          description="is removed from the MCP config. Agent sessions lose the tools it provides."
          onConfirm={() => void handleDelete(pendingDelete)}
          onClose={() => setPendingDelete(null)}
        />
      )}
    </div>
  );
}

function ServerGroup({
  title,
  icon,
  servers,
  onEdit,
  onRequestDelete,
  activeNames,
  onToggleDefault,
}: {
  title: string;
  icon: React.ReactNode;
  servers: McpServerEntry[];
  onEdit: (entry: McpServerEntry) => void;
  onRequestDelete: (entry: McpServerEntry) => void;
  activeNames: Set<string>;
  onToggleDefault: (name: string) => void;
}) {
  if (servers.length === 0) return null;

  return (
    <div>
      <div className="mb-1.5 flex items-center gap-1.5">
        {icon}
        <span className="text-[10px] font-medium uppercase tracking-wider text-text-secondary">
          {title}
        </span>
        <span className="text-[10px] text-text-muted">({servers.length})</span>
      </div>
      <div className="space-y-1">
        {servers.map((entry) => {
          const key = `${entry.scope}:${entry.name}`;
          // `McpServerModal` edits exactly one shape: command + args + env.
          // An http/sse server has no `command` — it has `type` and `url` —
          // so the form opened blank on the Command field and refused to save
          // until the user invented one, at which point `upsert_mcp_server`
          // grafted a `command` onto an object that still carried `type`/`url`.
          // The server the user was trying to edit came out neither one thing
          // nor the other. Non-stdio entries are labelled and their Edit button
          // is disabled with the reason, rather than offering a form that
          // cannot describe them.
          const transport = mcpServerTransport(entry);
          const editable = transport === "stdio";
          return (
            <div
              key={key}
              className="group flex items-center gap-3 rounded-lg border border-bg-border bg-bg-primary px-3 py-2"
            >
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="text-[11px] font-medium text-text-primary">{entry.name}</span>
                  {!editable && (
                    <span
                      className="rounded bg-bg-elevated px-1 py-0.5 text-[9px] text-text-muted"
                      title="Remote transport — configured by url, not by a command"
                    >
                      {transport}
                    </span>
                  )}
                  {entry.disabled && (
                    <span className="rounded bg-bg-elevated px-1 py-0.5 text-[9px] text-text-muted">
                      disabled
                    </span>
                  )}
                </div>
                <div className="mt-0.5 truncate text-[10px] text-text-muted">
                  {editable ? (
                    <>
                      {entry.config.command}
                      {entry.config.args?.length ? ` ${entry.config.args.join(" ")}` : ""}
                    </>
                  ) : (
                    // The command line is empty for these; show the endpoint
                    // that actually defines them instead of a blank row.
                    String(entry.rawConfig?.url ?? `${transport} server`)
                  )}
                </div>
                {!entry.disabled && (
                  <Checkbox
                    checked={activeNames.has(entry.name)}
                    onChange={() => onToggleDefault(entry.name)}
                    label="On for agent sessions"
                    className="mt-1 text-[10px]"
                  />
                )}
              </div>
              <div className="flex items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100">
                <button
                  onClick={() => onEdit(entry)}
                  disabled={!editable}
                  className="p-1 text-text-muted transition-colors hover:text-accent-blue disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:text-text-muted"
                  title={
                    editable
                      ? "Edit"
                      : `This is a ${transport} server, defined by a url rather than a command. Edit it in the ${entry.scope === "global" ? "global settings" : ".mcp.json"} file; this form can only describe command-based servers.`
                  }
                >
                  <Pencil size={11} />
                </button>
                <button
                  onClick={() => onRequestDelete(entry)}
                  className="p-1 text-text-muted transition-colors hover:text-accent-red"
                  title={`Delete ${entry.name}`}
                  aria-label={`Delete ${entry.name}`}
                >
                  <Trash2 size={11} />
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
