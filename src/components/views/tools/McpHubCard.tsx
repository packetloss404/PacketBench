import { useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import {
  Activity,
  CheckCircle2,
  ExternalLink,
  PackagePlus,
  RefreshCw,
  Search,
  ShieldCheck,
  TriangleAlert,
} from "lucide-react";
import { Modal } from "@/components/ui/Modal";
import { MCP_CATALOG, materializeCatalogCommand } from "@/lib/mcpCatalog";
import { mcpRootsEnforced } from "@/lib/mcpRoots";
import { diagnoseMcpServer } from "@/lib/tauri";
import { useAgentTaskStore } from "@/stores/agentTaskStore";
import { useLayoutStore } from "@/stores/layoutStore";
import { useMcpStore } from "@/stores/mcpStore";
import { defaultMcpTrustProfile, useMcpTrustStore } from "@/stores/mcpTrustStore";
import { useProvenanceAuditStore } from "@/stores/provenanceAuditStore";
import { mcpServerId, type McpCatalogManifest, type McpServerEntry } from "@/types/mcp";
import { McpProviderCard } from "./McpProviderCard";
import { McpRootsEditor } from "./McpRootsEditor";
import { McpServersCard } from "./McpServersCard";
import { APP_NAME } from "@/lib/brand";

function catalogServerName(manifest: McpCatalogManifest): string {
  return manifest.id.replace(/^official-/, "");
}

function effectiveProfile(server: McpServerEntry, projectPath: string) {
  const state = useMcpTrustStore.getState();
  const id = mcpServerId(server);
  return state.profiles[id] ?? defaultMcpTrustProfile(server, projectPath, state.capabilities[id]);
}

export function McpHubCard() {
  const projectPath = useLayoutStore((state) => state.projectPath);
  const selectedConversationId = useAgentTaskStore((state) => state.selectedConversationId);
  const selectedConversation = useAgentTaskStore((state) =>
    state.conversations.find((conversation) => conversation.id === state.selectedConversationId),
  );
  const prepareMcpReconnect = useAgentTaskStore((state) => state.prepareMcpReconnect);
  const servers = useMcpStore((state) => state.servers);
  const fetchServers = useMcpStore((state) => state.fetchServers);
  const addServer = useMcpStore((state) => state.addServer);
  const profiles = useMcpTrustStore((state) => state.profiles);
  const capabilities = useMcpTrustStore((state) => state.capabilities);
  const setProfile = useMcpTrustStore((state) => state.setProfile);
  const recordDiagnostic = useMcpTrustStore((state) => state.recordDiagnostic);
  const auditEntries = useProvenanceAuditStore((state) => state.entries);
  const recordAudit = useProvenanceAuditStore((state) => state.record);
  const [query, setQuery] = useState("");
  const [review, setReview] = useState<McpCatalogManifest | null>(null);
  const [installScope, setInstallScope] = useState<"global" | "project">("project");
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    void fetchServers();
  }, [fetchServers]);

  const normalizedQuery = query.trim().toLowerCase();
  const catalog = useMemo(
    () =>
      MCP_CATALOG.filter((manifest) =>
        `${manifest.name} ${manifest.description} ${manifest.capabilitySummary.join(" ")}`
          .toLowerCase()
          .includes(normalizedQuery),
      ),
    [normalizedQuery],
  );
  const visibleServers = useMemo(
    () =>
      servers.filter((server) =>
        `${server.name} ${server.scope} ${server.config.command}`
          .toLowerCase()
          .includes(normalizedQuery),
      ),
    [normalizedQuery, servers],
  );

  async function runDiagnostic(server: McpServerEntry) {
    const key = mcpServerId(server);
    setBusyKey(key);
    setNotice(null);
    try {
      const diagnostic = await diagnoseMcpServer(projectPath, server.name, server.scope);
      recordDiagnostic(server, diagnostic);
      recordAudit({
        conversationId: "mcp-hub",
        toolId: key,
        action: "MCP capability diagnostic",
        target: `${server.scope}:${server.name}`,
        decision: "diagnostic",
        effectivePolicy: `transport=${diagnostic.transport}; state=${diagnostic.state}; tools=${diagnostic.tools.length}`,
        sourceChain: [],
      });
      setNotice(`${server.name}: ${diagnostic.message}`);
    } catch (error) {
      setNotice(`${server.name}: ${String(error)}`);
    } finally {
      setBusyKey(null);
    }
  }

  async function installCatalogEntry() {
    if (!review || !projectPath) return;
    const name = catalogServerName(review);
    const command = materializeCatalogCommand(review, projectPath);
    setBusyKey(`catalog:${review.id}`);
    setNotice(null);
    try {
      await addServer(name, command.command, command.args, command.env, installScope);
      setReview(null);
      setNotice(
        `${review.name} was added to ${installScope} MCP config. Start a new agent session after reviewing its trust profile.`,
      );
      recordAudit({
        conversationId: "mcp-hub",
        toolId: `catalog:${review.id}`,
        action: "MCP catalog config added",
        target: `${installScope}:${name}`,
        decision: "catalog_installed",
        effectivePolicy: "config-only; no command executed; read-only trust default",
        sourceChain: [],
      });
    } catch (error) {
      setNotice(`Install failed: ${String(error)}`);
    } finally {
      setBusyKey(null);
    }
  }

  function updateTrust(
    server: McpServerEntry,
    patch: Parameters<typeof setProfile>[1],
    detail: string,
  ) {
    setProfile(server, patch, projectPath);
    recordAudit({
      conversationId: "mcp-hub",
      toolId: mcpServerId(server),
      action: "MCP trust profile changed",
      target: `${server.scope}:${server.name}`,
      decision: "profile_changed",
      effectivePolicy: `${detail}; applies on new/reconnected sessions`,
      sourceChain: [],
    });
  }

  async function reconnectSelectedConversation(withoutMcp = false) {
    if (!selectedConversationId) return;
    setBusyKey("reconnect");
    setNotice(null);
    try {
      if (withoutMcp) await prepareMcpReconnect(selectedConversationId, []);
      else await prepareMcpReconnect(selectedConversationId);
      recordAudit({
        conversationId: "mcp-hub",
        toolId: selectedConversationId,
        action: "MCP session reconnect prepared",
        target: selectedConversation?.title ?? selectedConversationId,
        decision: "profile_changed",
        effectivePolicy: withoutMcp
          ? "backend closed; all MCP servers explicitly disabled for this conversation"
          : "backend closed; current trust will freeze on the next user turn",
        sourceChain: [],
      });
      setNotice(
        withoutMcp
          ? "MCP is disabled for the selected conversation. Its backend was closed safely; the next user turn will reconnect without MCP servers."
          : "The selected agent backend was closed safely. Its next user turn will reconnect with the current MCP trust snapshot.",
      );
    } catch (error) {
      setNotice(String(error));
    } finally {
      setBusyKey(null);
    }
  }

  return (
    <div className="space-y-4">
      <section className="rounded-lg border border-bg-border bg-bg-secondary p-4">
        <div className="mb-3 flex items-start justify-between gap-3">
          <div>
            <h3 className="flex items-center gap-2 text-xs font-semibold text-text-primary">
              <ShieldCheck size={13} className="text-accent-green" />
              Local-first MCP Hub
            </h3>
            <p className="mt-1 max-w-2xl text-[10px] leading-relaxed text-text-muted">
              Discover servers, diagnose live capabilities, and freeze read/write/network/root
              authority into each {APP_NAME}-managed MCP session. Trust edits never broaden a
              running session.
            </p>
          </div>
          <div className="flex flex-wrap items-center justify-end gap-2">
            <button
              onClick={() => void reconnectSelectedConversation()}
              disabled={
                !selectedConversation ||
                selectedConversation.mode !== "api" ||
                busyKey === "reconnect"
              }
              title="Close the selected API-agent backend; its next turn reconnects with current MCP trust"
              className="rounded border border-accent-green/30 bg-accent-green/10 px-2 py-1 text-[9px] text-accent-green disabled:cursor-not-allowed disabled:opacity-40"
            >
              {busyKey === "reconnect" ? "Preparing…" : "Reconnect selected"}
            </button>
            <button
              onClick={() => void reconnectSelectedConversation(true)}
              disabled={
                !selectedConversation ||
                selectedConversation.mode !== "api" ||
                busyKey === "reconnect"
              }
              title="Disable all MCP servers for the selected API conversation and close its backend; its next turn reconnects without MCP, including on SSH"
              className="rounded border border-bg-border px-2 py-1 text-[9px] text-text-secondary disabled:cursor-not-allowed disabled:opacity-40"
            >
              Reconnect without MCP
            </button>
            <span className="rounded bg-bg-elevated px-2 py-1 text-[9px] text-text-muted">
              Session trust
            </span>
          </div>
        </div>

        <label className="mb-4 flex items-center gap-2 rounded border border-bg-border bg-bg-primary px-3 py-2">
          <Search size={12} className="text-text-muted" />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search catalog, servers, and capabilities"
            aria-label="Search MCP Hub"
            className="min-w-0 flex-1 bg-transparent text-[11px] text-text-primary outline-none placeholder:text-text-faint"
          />
        </label>

        {notice && (
          <div className="mb-3 rounded border border-bg-border bg-bg-primary px-3 py-2 text-[10px] text-text-secondary">
            {notice}
          </div>
        )}

        <div className="mb-4">
          <div className="mb-2 flex items-center gap-2">
            <PackagePlus size={11} className="text-accent-blue" />
            <h4 className="text-[10px] font-semibold uppercase tracking-wider text-text-secondary">
              Curated catalog
            </h4>
            <span className="text-[9px] text-text-muted">review before install</span>
          </div>
          <div className="grid gap-2 sm:grid-cols-2">
            {catalog.map((manifest) => {
              const configured = servers.some(
                (server) => server.name === catalogServerName(manifest),
              );
              return (
                <div
                  key={manifest.id}
                  className="rounded border border-bg-border bg-bg-primary p-3"
                >
                  <div className="flex items-start justify-between gap-2">
                    <div>
                      <div className="text-[11px] font-medium text-text-primary">
                        {manifest.name}
                      </div>
                      <div className="mt-1 text-[10px] leading-relaxed text-text-muted">
                        {manifest.description}
                      </div>
                    </div>
                    {configured ? (
                      <span className="flex items-center gap-1 text-[9px] text-accent-green">
                        <CheckCircle2 size={10} />
                        Configured
                      </span>
                    ) : (
                      <button
                        onClick={() => setReview(manifest)}
                        className="shrink-0 rounded border border-accent-blue/30 bg-accent-blue/10 px-2 py-1 text-[10px] text-accent-blue hover:bg-accent-blue/15"
                      >
                        Review
                      </button>
                    )}
                  </div>
                  <div className="mt-2 text-[9px] text-text-faint">
                    {manifest.capabilitySummary.join(" · ")}
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        <div>
          <div className="mb-2 flex items-center gap-2">
            <Activity size={11} className="text-accent-purple" />
            <h4 className="text-[10px] font-semibold uppercase tracking-wider text-text-secondary">
              Health and frozen trust
            </h4>
          </div>
          {visibleServers.length === 0 ? (
            <div className="rounded border border-bg-border bg-bg-primary px-3 py-3 text-[10px] text-text-muted">
              No configured servers match this search.
            </div>
          ) : (
            <div className="space-y-2">
              {visibleServers.map((server) => {
                const id = mcpServerId(server);
                const profile = profiles[id] ?? effectiveProfile(server, projectPath);
                const diagnostic = capabilities[id];
                return (
                  <div key={id} className="rounded border border-bg-border bg-bg-primary p-3">
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="text-[11px] font-medium text-text-primary">
                            {server.name}
                          </span>
                          <span className="rounded bg-bg-elevated px-1 py-0.5 text-[9px] text-text-muted">
                            {server.scope}
                          </span>
                          {/* `notProbed` reads as "not probed" and never as a
                              measured verdict: the doctor speaks stdio only,
                              so an http/sse server's health is UNKNOWN. It
                              used to be reported as `degraded`, which made
                              every healthy remote server look broken and
                              taught users to ignore the chip entirely.
                              `degraded` now gets its own amber so a real
                              measured problem is visually distinct from both
                              "fine" and "not checked". The message rides on
                              the title so the explanation outlives the
                              transient notice banner. */}
                          <span
                            title={diagnostic?.message}
                            className={`text-[9px] ${
                              diagnostic?.state === "connected"
                                ? "text-accent-green"
                                : diagnostic?.state === "failed"
                                  ? "text-accent-red"
                                  : diagnostic?.state === "degraded"
                                    ? "text-accent-amber"
                                    : "text-text-muted"
                            }`}
                          >
                            {diagnostic?.state === "notProbed"
                              ? "not probed"
                              : (diagnostic?.state ?? "not diagnosed")}
                            {diagnostic?.latencyMs !== undefined
                              ? ` · ${diagnostic.latencyMs} ms`
                              : ""}
                          </span>
                        </div>
                        <div className="mt-1 truncate text-[9px] text-text-faint">
                          {server.config.command} {(server.config.args ?? []).join(" ")}
                        </div>
                      </div>
                      <button
                        onClick={() => void runDiagnostic(server)}
                        disabled={busyKey === id}
                        className="flex shrink-0 items-center gap-1 rounded px-2 py-1 text-[10px] text-accent-blue hover:bg-accent-blue/10 disabled:opacity-50"
                      >
                        <RefreshCw size={10} className={busyKey === id ? "animate-spin" : ""} />
                        Diagnose
                      </button>
                    </div>

                    <div className="mt-3 flex flex-wrap gap-3">
                      <TrustToggle
                        label="Read"
                        checked={profile.allowReads}
                        onChange={(checked) =>
                          updateTrust(
                            server,
                            checked
                              ? { allowReads: true }
                              : { allowReads: false, allowWrites: false },
                            checked ? "read granted" : "read/write revoked",
                          )
                        }
                      />
                      <TrustToggle
                        label="Write"
                        checked={profile.allowWrites}
                        onChange={(checked) =>
                          updateTrust(
                            server,
                            { allowWrites: checked, allowReads: checked || profile.allowReads },
                            checked ? "write granted" : "write revoked",
                          )
                        }
                      />
                      <TrustToggle
                        label="Network transport"
                        checked={profile.allowNetwork}
                        onChange={(checked) =>
                          updateTrust(
                            server,
                            { allowNetwork: checked },
                            checked ? "network transport granted" : "network transport revoked",
                          )
                        }
                      />
                    </div>

                    <McpRootsEditor
                      serverLabel={server.name}
                      roots={profile.allowedRoots}
                      workspacePath={profile.workspacePath ?? projectPath}
                      enforced={mcpRootsEnforced(profile.denialFloors)}
                      onChange={(allowedRoots, detail) =>
                        updateTrust(server, { allowedRoots }, detail)
                      }
                    />
                    {diagnostic?.tools.length ? (
                      <div className="mt-2 flex flex-wrap gap-1">
                        {diagnostic.tools.map((tool) => {
                          const allowed = profile.allowedToolNames.includes(tool.name);
                          return (
                            <button
                              key={tool.name}
                              title={tool.description || tool.name}
                              onClick={() =>
                                updateTrust(
                                  server,
                                  {
                                    allowedToolNames: allowed
                                      ? profile.allowedToolNames.filter(
                                          (name) => name !== tool.name,
                                        )
                                      : [...profile.allowedToolNames, tool.name],
                                  },
                                  allowed
                                    ? `tool revoked: ${tool.name}`
                                    : `tool granted: ${tool.name}`,
                                )
                              }
                              className={`rounded border px-1.5 py-0.5 text-[9px] ${
                                allowed
                                  ? "border-accent-green/30 bg-accent-green/10 text-accent-green"
                                  : "border-bg-border text-text-muted"
                              }`}
                            >
                              {tool.name}
                            </button>
                          );
                        })}
                      </div>
                    ) : null}
                    <div className="mt-2 flex items-start gap-1 text-[9px] text-text-faint">
                      <TriangleAlert size={9} className="mt-0.5 shrink-0" />
                      Credential, outside-workspace, and protected publish operations remain
                      blocked. Start or reconnect a session to apply changes.
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        <div className="mt-4 border-t border-bg-border pt-3">
          <div className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-text-secondary">
            Recent Hub activity
          </div>
          {auditEntries.filter((entry) => entry.conversationId === "mcp-hub").length === 0 ? (
            <div className="text-[9px] text-text-faint">No Hub changes in the audit window.</div>
          ) : (
            <div className="space-y-1">
              {auditEntries
                .filter((entry) => entry.conversationId === "mcp-hub")
                .slice(-5)
                .reverse()
                .map((entry) => (
                  <div
                    key={entry.id}
                    className="flex items-center gap-2 rounded border border-bg-border bg-bg-primary px-2 py-1 text-[9px]"
                  >
                    <span className="text-text-secondary">{entry.action}</span>
                    <span className="truncate text-text-faint">{entry.target}</span>
                    <span className="ml-auto text-text-muted">
                      {entry.decision.replaceAll("_", " ")}
                    </span>
                  </div>
                ))}
            </div>
          )}
        </div>
      </section>

      <McpServersCard />
      <McpProviderCard />

      {review && (
        <CatalogReviewModal
          manifest={review}
          projectPath={projectPath}
          scope={installScope}
          setScope={setInstallScope}
          busy={busyKey === `catalog:${review.id}`}
          onClose={() => setReview(null)}
          onInstall={() => void installCatalogEntry()}
        />
      )}
    </div>
  );
}

function TrustToggle({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label className="flex items-center gap-1.5 text-[10px] text-text-secondary">
      <input
        type="checkbox"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
        className="accent-accent-green"
      />
      {label}
    </label>
  );
}

function CatalogReviewModal({
  manifest,
  projectPath,
  scope,
  setScope,
  busy,
  onClose,
  onInstall,
}: {
  manifest: McpCatalogManifest;
  projectPath: string;
  scope: "global" | "project";
  setScope: (scope: "global" | "project") => void;
  busy: boolean;
  onClose: () => void;
  onInstall: () => void;
}) {
  const command = materializeCatalogCommand(manifest, projectPath);
  return (
    <Modal
      title={`Review ${manifest.name}`}
      icon={<ShieldCheck size={14} className="text-accent-green" />}
      onClose={busy ? () => undefined : onClose}
      closeDisabled={busy}
      closeOnEscape
      width="w-[600px]"
      footer={
        <div className="flex items-center justify-between gap-3">
          <span className="text-[9px] text-text-muted">
            Nothing runs during install; {APP_NAME} only writes the reviewed config entry.
          </span>
          <button
            onClick={onInstall}
            disabled={busy || !projectPath}
            className="rounded bg-accent-green px-3 py-1.5 text-[11px] text-bg-primary hover:opacity-90 disabled:opacity-50"
          >
            {busy ? "Installing…" : "Approve and add"}
          </button>
        </div>
      }
    >
      <div className="space-y-4 p-5 text-[10px] text-text-secondary">
        <ReviewRow label="Official source">
          <a
            href={manifest.officialSource}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 text-accent-blue hover:underline"
          >
            {manifest.officialSource}
            <ExternalLink size={9} />
          </a>
        </ReviewRow>
        <ReviewRow label="Command">
          <code className="break-all text-text-primary">
            {[command.command, ...command.args].join(" ")}
          </code>
        </ReviewRow>
        <ReviewRow label="Files changed">
          {scope === "project" ? `${projectPath}\\.mcp.json` : "~/.claude/settings.json"}
        </ReviewRow>
        <ReviewRow label="Capabilities">{manifest.capabilitySummary.join(", ")}</ReviewRow>
        <ReviewRow label="Required secrets">
          {manifest.requiredSecrets.length
            ? `${manifest.requiredSecrets.join(", ")} (read from the process environment; never stored by the catalog)`
            : "None"}
        </ReviewRow>
        <ReviewRow label="Network">
          {manifest.needsNetwork ? manifest.networkUse : "No network use expected"}
        </ReviewRow>
        <ReviewRow label="Removal">{manifest.removal}</ReviewRow>

        <div>
          <div className="mb-1 text-[9px] uppercase tracking-wider text-text-muted">
            Config scope
          </div>
          <div className="flex gap-2">
            {(["project", "global"] as const).map((candidate) => (
              <button
                key={candidate}
                onClick={() => setScope(candidate)}
                className={`rounded border px-2 py-1 text-[10px] ${
                  scope === candidate
                    ? "border-accent-green/30 bg-accent-green/10 text-accent-green"
                    : "border-bg-border text-text-muted"
                }`}
              >
                {candidate}
              </button>
            ))}
          </div>
        </div>
      </div>
    </Modal>
  );
}

function ReviewRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <div className="mb-1 text-[9px] uppercase tracking-wider text-text-muted">{label}</div>
      <div>{children}</div>
    </div>
  );
}
