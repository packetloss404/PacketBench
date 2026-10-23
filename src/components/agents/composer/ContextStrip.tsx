import { useEffect, useId, useRef, useState } from "react";
import {
  ArrowDownToLine,
  FolderOpen,
  GitBranch as GitBranchIcon,
  Plug,
  Server,
} from "lucide-react";
import { gitSafetyCheck, type GitSafetyReport } from "@/lib/tauri";
import { useAgentSidebarPrefsStore } from "@/stores/agentSidebarPrefsStore";
import { Tooltip } from "@/components/ui/Tooltip";
import { Spinner } from "@/components/ui/Spinner";
import { ContextUsageRing } from "../ContextUsageRing";
import type { SessionCapabilities } from "@/lib/agentCapabilities";
import type { AgentConversation } from "@/types/agent-conversation";

/** Git poll cadence, carried over verbatim from the deleted SessionMetaLine. */
const POLL_INTERVAL_MS = 30_000;

/** Shared chip shell so every fact in the strip reads as the same object. */
const CHIP =
  "flex shrink-0 cursor-default items-center gap-1 rounded-md px-1.5 py-0.5 text-chip";

function basenameOf(path: string): string {
  const segs = path.replace(/\\/g, "/").split("/").filter(Boolean);
  return segs[segs.length - 1] ?? path;
}

interface ContextStripProps {
  conversation: AgentConversation;
  caps: SessionCapabilities;
}

/**
 * The Codex-style context strip that caps the floating composer card: what
 * this session is pointed at (project · ssh · git · MCP) on the left, and how
 * full its context window is on the right.
 *
 * This replaces the old full-bleed `SessionMetaLine` band. The band's two
 * facts — the project pill and the git branch/dirty/behind cluster, including
 * its 30s `gitSafetyCheck` poll — MOVED here rather than being duplicated;
 * there is exactly one interval per mounted conversation, as before.
 *
 * The MCP chip is READ-ONLY on purpose. PacketBench has no per-session MCP
 * consent toggle, so a clickable chip would be a false affordance.
 *
 * V8: the strip is a query container that wraps its chips onto a second row
 * instead of clipping them (the old `overflow-hidden` + `shrink-0` pair hid
 * host/project/branch at narrow widths). A focusable **Execution context**
 * disclosure always carries the FULL project path, host, remote path, branch
 * and permission posture so long names stay identifiable and copyable even
 * when the chip summaries truncate.
 */
export function ContextStrip({ conversation, caps }: ContextStripProps) {
  const projectLabels = useAgentSidebarPrefsStore((s) => s.projectLabels);
  const [report, setReport] = useState<GitSafetyReport | null>(null);
  const [gitLoading, setGitLoading] = useState(false);
  const gitCancelled = useRef(false);

  const [ctxOpen, setCtxOpen] = useState(false);
  const ctxButtonRef = useRef<HTMLButtonElement>(null);
  const ctxPopoverRef = useRef<HTMLDivElement>(null);
  const ctxId = useId();

  const isSsh = caps.remote;
  const projectPath = conversation.projectPath;
  const customLabel = projectLabels[projectPath];
  const displayLabel = customLabel || basenameOf(projectPath) || "(no project)";

  const openCtx = () => setCtxOpen(true);
  const closeCtx = () => {
    setCtxOpen(false);
    ctxButtonRef.current?.focus();
  };

  // Move focus into the disclosure popover when it opens so keyboard users
  // land on the full context instead of the toggle.
  useEffect(() => {
    if (ctxOpen) ctxPopoverRef.current?.focus();
  }, [ctxOpen]);

  // Per-conversation git safety poll (branch + dirty state + behind-upstream).
  // Skipped for SSH targets and project-less conversations.
  useEffect(() => {
    gitCancelled.current = false;
    if (isSsh || !projectPath) {
      setReport(null);
      return undefined;
    }

    const run = async () => {
      setGitLoading(true);
      try {
        const next = await gitSafetyCheck(projectPath);
        if (!gitCancelled.current) setReport(next);
      } catch {
        if (!gitCancelled.current) setReport(null);
      } finally {
        if (!gitCancelled.current) setGitLoading(false);
      }
    };

    void run();
    const interval = window.setInterval(run, POLL_INTERVAL_MS);
    return () => {
      gitCancelled.current = true;
      window.clearInterval(interval);
    };
  }, [projectPath, isSsh]);

  const mcpSources = conversation.mcpSources;
  const mcpCount = mcpSources?.sources.length ?? 0;
  const mcpErrorCount = mcpSources?.readErrors.length ?? 0;

  const sshHost = conversation.sshTarget?.host;
  const permissionPosture = conversation.permissionMode ?? "default";

  return (
    <div className="context-strip relative flex flex-wrap items-center gap-1.5 rounded-t-xl border border-b-0 border-bg-border bg-bg-secondary px-2.5 py-1">
      {/* Execution context disclosure — focusable, always present, and the
          source of the full (never truncated) host/project/branch identity. */}
      <button
        ref={ctxButtonRef}
        type="button"
        aria-expanded={ctxOpen}
        aria-controls={ctxId}
        aria-haspopup="dialog"
        onClick={() => (ctxOpen ? closeCtx() : openCtx())}
        className="flex shrink-0 cursor-default items-center gap-1 rounded-md border border-control-border px-1.5 py-0.5 text-chip text-text-secondary hover:text-text-primary focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring"
      >
        {isSsh ? <Server size={10} /> : <FolderOpen size={10} />}
        <span className="max-w-[140px] truncate">
          {isSsh ? `SSH: ${sshHost ?? "remote"}` : "Local"}
        </span>
      </button>

      {ctxOpen && (
        <div
          ref={ctxPopoverRef}
          id={ctxId}
          role="dialog"
          aria-label="Execution context"
          tabIndex={-1}
          onKeyDown={(e) => {
            if (e.key !== "Escape") return;
            e.preventDefault();
            e.stopPropagation();
            closeCtx();
          }}
          className="absolute left-0 top-full z-30 mt-1 max-w-sm min-w-[220px] rounded-md border border-bg-border bg-bg-secondary p-2 text-chip text-text-secondary shadow-md focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring"
        >
          <dl className="space-y-1">
            <div>
              <dt className="text-text-muted">Host</dt>
              <dd className="select-text break-all text-text-primary">
                {isSsh
                  ? `${conversation.sshTarget?.user ?? "?"}@${sshHost ?? "?"}`
                  : "Local"}
              </dd>
            </div>
            {isSsh && conversation.sshTarget?.remotePath && (
              <div>
                <dt className="text-text-muted">Remote path</dt>
                <dd className="select-text break-all font-mono text-text-primary">
                  {conversation.sshTarget.remotePath}
                </dd>
              </div>
            )}
            <div>
              <dt className="text-text-muted">Project</dt>
              <dd className="select-text break-all font-mono text-text-primary">
                {projectPath || "(no project)"}
              </dd>
            </div>
            {!isSsh && report?.isGitRepo && (
              <div>
                <dt className="text-text-muted">Branch</dt>
                <dd className="select-text break-all font-mono text-text-primary">
                  {report.branch ?? "?"}
                </dd>
              </div>
            )}
            <div>
              <dt className="text-text-muted">Permission</dt>
              <dd className="select-text text-text-primary">{permissionPosture}</dd>
            </div>
          </dl>
          <button
            type="button"
            onClick={closeCtx}
            className="mt-1.5 rounded border border-control-border px-1.5 py-0.5 text-chip text-text-secondary hover:text-text-primary focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring"
          >
            Close
          </button>
        </div>
      )}

      {/* Project */}
      <Tooltip content={projectPath || "No project"}>
        <span className={`${CHIP} min-w-0 text-text-muted`}>
          <FolderOpen size={10} />
          <span className="max-w-[160px] truncate">{displayLabel}</span>
        </span>
      </Tooltip>

      {/* SSH — omitted entirely for local sessions (caps.remote). */}
      {caps.remote && conversation.sshTarget && (
        <Tooltip
          content={`Tools run on ${conversation.sshTarget.user}@${conversation.sshTarget.host}:${conversation.sshTarget.remotePath}`}
        >
          <span className={`${CHIP} min-w-0 bg-accent-soft text-accent-green`}>
            <Server size={10} />
            <span className="max-w-[120px] truncate">
              {conversation.sshTarget.host}
            </span>
          </span>
        </Tooltip>
      )}

      {/* Git cluster */}
      {!isSsh && report && report.isGitRepo && (
        <span
          className={`${CHIP} ${report.isClean ? "text-text-muted" : "text-accent-amber"}`}
        >
          <GitBranchIcon size={10} />
          <span className="max-w-[140px] truncate font-mono">
            {report.branch ?? "?"}
          </span>
          {!report.isClean && (
            <Tooltip
              content={`${report.uncommittedCount} uncommitted change${
                report.uncommittedCount === 1 ? "" : "s"
              }`}
            >
              <span className="inline-flex items-center">
                <span className="h-1.5 w-1.5 rounded-full bg-accent-amber" />
              </span>
            </Tooltip>
          )}
          {report.behindUpstream > 0 && (
            <Tooltip content={`${report.behindUpstream} behind upstream`}>
              <span className="flex items-center text-accent-amber">
                <ArrowDownToLine size={9} />
                {report.behindUpstream}
              </span>
            </Tooltip>
          )}
        </span>
      )}

      {!isSsh && !gitLoading && report && !report.isGitRepo && (
        <span className={`${CHIP} text-text-faint`}>
          <FolderOpen size={10} />
          not a git repo
        </span>
      )}

      {!isSsh && gitLoading && !report && (
        <Spinner size={10} className="text-text-faint" />
      )}

      {/* MCP disclosure — read-only (no per-session consent toggle exists). */}
      {caps.mcp && mcpSources && (
        <Tooltip
          content={
            <div className="flex flex-col gap-0.5 text-left">
              {mcpCount > 0 ? (
                mcpSources.sources.map((s) => (
                  <span key={`${s.scope}:${s.name}`}>
                    {s.name} ({s.transport}, {s.scope})
                  </span>
                ))
              ) : (
                <span>No MCP servers sourced</span>
              )}
              {mcpErrorCount > 0 &&
                mcpSources.readErrors.map((e) => (
                  <span key={`err:${e.scope}:${e.path}`} className="text-accent-amber">
                    {e.scope}: {e.path} — {e.message}
                  </span>
                ))}
            </div>
          }
        >
          <span
            className={`${CHIP} ${mcpErrorCount > 0 ? "text-accent-amber" : "text-text-muted"}`}
          >
            <Plug size={10} />
            MCP {mcpCount}
            {mcpErrorCount > 0 ? ` (!${mcpErrorCount})` : ""}
          </span>
        </Tooltip>
      )}

      {/* Context ring — omitted when the adapter reports no window. */}
      {caps.contextWindow !== null && (
        <span className="ml-auto shrink-0 pl-1">
          <ContextUsageRing conversation={conversation} />
        </span>
      )}
    </div>
  );
}
