import { useEffect, useMemo, useRef, useState } from "react";
import {
  ChevronRight,
  File as FileIcon,
  FileText,
  Eye,
  FileDiff,
  FolderTree,
  AlertCircle,
} from "lucide-react";
import { useAgentTaskStore } from "@/stores/agentTaskStore";
import { useEditorStore } from "@/stores/editorStore";
import { aggregateConversationDiffs, type PerFileDiffStat } from "@/lib/aggregateConversationDiffs";
import { aggregateConversationTokens } from "@/lib/conversationTokens";
import { API_PROVIDERS } from "@/lib/api-models";
import { AgentPreviewPane } from "./AgentPreviewPane";
import { ReviewSurface } from "./review/ReviewSurface";
import { AgentFilePane } from "./AgentFilePane";
import { EditorDockPanel } from "@/components/editor/EditorDockPanel";
import { RightDock, type RightDockPanel } from "@/components/layout/RightDock";
import { useRightDockStore } from "@/stores/rightDockStore";
import { usePreviewPaneStore } from "@/stores/previewPaneStore";
import { openInEditor } from "@/lib/openInEditor";
import { isRemoteConversation, REMOTE_UNSUPPORTED_TOOLTIP } from "@/lib/remoteConversation";
import { useUnviewedCount } from "./review/useUnviewedCount";
import { Spinner } from "@/components/ui/Spinner";
import { EmptyState } from "@/components/ui/EmptyState";

interface AgentInspectorPaneProps {
  conversationId: string;
}

/**
 * D2 — the Agents surface's `RightDock` host.
 *
 * The five inspector "tabs" are now dock panels (plus the reconnected Editor
 * from D5), so mutual exclusion, width arbitration and collapse are the dock's
 * job rather than five pieces of local component state. Preview in particular
 * is a real dock panel now instead of a free-floating global (P0-3).
 *
 * B4 (wave 2b) cut the tab strip from six panels to three, because six tabs at
 * a 260px minimum width is a filing cabinet, not an inspector:
 *   - Inspector folded into the Diff panel's header (same content, one click
 *     away, next to the diffs it describes);
 *   - Files folded into the Editor (the browser IS how you open a buffer, and
 *     an Editor with no file open had nothing else to show);
 *   - Plan dropped entirely — `PlanPanel` was mounted TWICE, here and inline in
 *     `AgentChatPane`. The plan belongs in the conversation, so the inline one
 *     survives and this duplicate is gone.
 * The dock itself now ships collapsed (see `rightDockStore` defaults), so the
 * Agents view is a two-pane shell until something asks for a panel.
 */
export function AgentInspectorPane({ conversationId }: AgentInspectorPaneProps) {
  const conversation = useAgentTaskStore((s) =>
    s.conversations.find((c) => c.id === conversationId),
  );
  const unreviewedCount = useUnviewedCount(conversationId);
  const openPanel = useRightDockStore((s) => s.openPanel);
  // D3 / P0-4: Preview + Editor read LOCAL disk, so they are disabled (not
  // hidden) for SSH-backed conversations until a remote file contract exists.
  const remote = isRemoteConversation(conversation);

  // Auto-reveal the Preview panel when a NEW preview target lands for THIS
  // conversation (a .md click in chat, a plan-shaped response). Scoped by
  // conversation id, so conversation B never steals conversation A's preview.
  const previewTarget = usePreviewPaneStore((s) => s.target);
  const previewSignature =
    previewTarget && previewTarget.conversationId === conversationId
      ? `${previewTarget.activeTab}:${previewTarget.markdownPath ?? ""}:${previewTarget.planContent.length}`
      : null;
  const prevPreviewSignatureRef = useRef(previewSignature);
  useEffect(() => {
    if (previewSignature && previewSignature !== prevPreviewSignatureRef.current && !remote) {
      openPanel("agents", "preview");
    }
    prevPreviewSignatureRef.current = previewSignature;
  }, [previewSignature, remote, openPanel]);

  // There is no peer "reveal the Plan panel" effect any more. It used to fire
  // on the rising edge of "plan arrives" and open a dock panel that no longer
  // exists — which would now open the dock onto whatever panel happens to sort
  // first, hijacking the view for a plan that is already visible inline in the
  // conversation. The inline `PlanPanel` in `AgentChatPane` is the reveal.

  const panels = useMemo<RightDockPanel[]>(() => {
    if (!conversation) return [];
    return [
      {
        id: "preview",
        label: "Preview",
        icon: Eye,
        disabled: remote,
        disabledReason: REMOTE_UNSUPPORTED_TOOLTIP,
        render: () => (
          <AgentPreviewPane
            conversationId={conversationId}
            projectPath={conversation.projectPath}
            remote={remote}
            embedded
          />
        ),
      },
      {
        id: "diff",
        label: "Diff",
        icon: FileDiff,
        badge: unreviewedCount,
        render: () => (
          <div className="flex min-h-0 flex-1 flex-col">
            {/* The old Inspector tab, folded in as this panel's header: the
                file/session facts describe the very diffs below them. */}
            <InspectorHeader conversationId={conversationId} />
            <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
              {conversation.mode === "api" ? (
                <ReviewSurface conversationId={conversationId} embedded />
              ) : (
                <div className="flex flex-1 items-center justify-center bg-bg-primary">
                  <EmptyState
                    icon={<FileDiff size={24} />}
                    title="Diffs are only tracked for API-mode conversations."
                  />
                </div>
              )}
            </div>
          </div>
        ),
      },
      {
        id: "editor",
        label: "Editor",
        icon: FileText,
        disabled: remote,
        disabledReason: REMOTE_UNSUPPORTED_TOOLTIP,
        render: () => (
          <EditorPanel
            conversationId={conversationId}
            projectPath={conversation.projectPath}
            sshTarget={conversation.sshTarget ?? null}
            remote={remote}
          />
        ),
      },
    ];
  }, [conversation, conversationId, remote, unreviewedCount]);

  if (!conversation) return null;

  return <RightDock surface="agents" panels={panels} ariaLabel="Inspector views" />;
}

/* ------------------------------------------------------------------ */
/* Folded panels                                                       */
/* ------------------------------------------------------------------ */

/**
 * The former Inspector tab, folded into the Diff panel's header.
 *
 * Collapsed by default: the diffs are what the panel is FOR, and the session
 * facts are reference material. Opening it never navigates away, so the diff
 * list is still one click behind.
 */
function InspectorHeader({ conversationId }: { conversationId: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="shrink-0 border-b border-line-soft bg-bg-secondary">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-center gap-1.5 px-2.5 py-1.5 text-left transition-colors hover:bg-bg-tertiary"
      >
        <ChevronRight
          size={10}
          className={`shrink-0 text-text-muted transition-transform motion-reduce:transition-none ${
            open ? "rotate-90" : ""
          }`}
        />
        <span className="text-meta uppercase tracking-[0.09em] text-text-faint">
          Session details
        </span>
      </button>
      {open && (
        <div className="max-h-[240px] overflow-auto border-t border-line-soft">
          <InspectorContent conversationId={conversationId} />
        </div>
      )}
    </div>
  );
}

/**
 * The former Files tab, folded into the Editor.
 *
 * The browser is how a buffer gets opened, and an Editor with no file open had
 * nothing else to say — so an empty Editor IS the browser. Once a buffer exists
 * a toggle strip switches back and forth without leaving the panel.
 */
function EditorPanel({
  conversationId,
  projectPath,
  sshTarget,
  remote,
}: {
  conversationId: string;
  projectPath: string;
  sshTarget: { host: string; user: string; remotePath: string } | null;
  remote: boolean;
}) {
  const openFileCount = useEditorStore((s) => s.openFiles.length);
  const [browsing, setBrowsing] = useState(false);
  const showBrowser = browsing || openFileCount === 0;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {openFileCount > 0 && (
        <div className="flex shrink-0 items-center border-b border-line-soft bg-bg-secondary px-2 py-1">
          <button
            type="button"
            onClick={() => setBrowsing((v) => !v)}
            aria-pressed={browsing}
            className="flex items-center gap-1.5 rounded-md px-1.5 py-0.5 text-meta text-text-muted transition-colors hover:bg-bg-tertiary hover:text-text-primary"
          >
            <FolderTree size={10} />
            {browsing ? "Back to editor" : "Browse files"}
          </button>
        </div>
      )}
      {showBrowser ? (
        <AgentFilePane
          conversationId={conversationId}
          projectPath={projectPath}
          sshTarget={sshTarget}
          // D5 / P1-5: Files advertised a preview path that was never wired
          // — `onSelectFile` had no producer. Rows now open the file in the
          // dock Editor, which renders `.md` through MarkdownRenderer.
          onSelectFile={(absolutePath) => {
            openInEditor(absolutePath, { projectPath, remote, surface: "agents" });
            setBrowsing(false);
          }}
        />
      ) : (
        <EditorDockPanel />
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Inspector content                                                   */
/* ------------------------------------------------------------------ */

function InspectorContent({ conversationId }: { conversationId: string }) {
  const conversation = useAgentTaskStore((s) =>
    s.conversations.find((c) => c.id === conversationId),
  );
  const [files, setFiles] = useState<PerFileDiffStat[]>([]);
  const [totals, setTotals] = useState<{ adds: number; dels: number; count: number }>({
    adds: 0,
    dels: 0,
    count: 0,
  });
  const [filesLoading, setFilesLoading] = useState(false);
  const [filesError, setFilesError] = useState(false);
  const [unavailableCount, setUnavailableCount] = useState(0);

  const messageCount = conversation?.messages.length ?? 0;
  useEffect(() => {
    if (!conversation || conversation.mode !== "api") {
      setFiles([]);
      setTotals({ adds: 0, dels: 0, count: 0 });
      setFilesLoading(false);
      setFilesError(false);
      setUnavailableCount(0);
      return;
    }
    let cancelled = false;
    setFilesLoading(true);
    setFilesError(false);
    void (async () => {
      try {
        const r = await aggregateConversationDiffs(conversation);
        if (cancelled) return;
        setFiles(r.perFile);
        setTotals({ adds: r.totalAdds, dels: r.totalDels, count: r.fileCount });
        setUnavailableCount(r.unavailableCount);
      } catch {
        if (!cancelled) {
          setFiles([]);
          setTotals({ adds: 0, dels: 0, count: 0 });
          setUnavailableCount(0);
          setFilesError(true);
        }
      } finally {
        if (!cancelled) setFilesLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversation?.id, conversation?.mode, messageCount]);

  // Tick once a minute so the "Started" relative time stays fresh.
  const [, setNowTick] = useState(0);
  useEffect(() => {
    const id = window.setInterval(() => setNowTick((n) => n + 1), 60_000);
    return () => window.clearInterval(id);
  }, []);

  // Session metadata
  const provider = API_PROVIDERS.find((p) => p.agentCli === conversation?.agent);
  const modelLabel =
    provider?.models.find((m) => m.value === conversation?.model)?.label ??
    conversation?.model ??
    "—";
  const startedRel = conversation ? relTime(Date.now() - conversation.createdAt) : "—";
  // Tokens only. The dollar figure that used to sit next to this was part of
  // the cost reporting surface removed on 2026-07-31; token counts stay because
  // they are the measurement the prompt-caching work depends on.
  const totalTokens = conversation ? aggregateConversationTokens(conversation) : 0;

  return (
    <>
      {/* Files changed */}
      <div>
        <SectionHeader
          label="Files changed"
          right={`${totals.count} · +${totals.adds} −${totals.dels}`}
        />
        <div className="flex flex-col gap-1.5 p-2">
          {filesLoading ? (
            <span className="flex items-center gap-1.5 px-1 py-1 text-ui text-text-muted">
              <Spinner size={10} />
              Computing edits…
            </span>
          ) : filesError ? (
            <span className="flex items-center gap-1.5 px-1 py-1 text-ui text-accent-red">
              <AlertCircle size={10} />
              Could not compute edits.
            </span>
          ) : files.length === 0 ? (
            <span className="px-1 py-1 text-ui text-text-muted">
              No edits in this conversation yet.
            </span>
          ) : (
            <>
              {unavailableCount > 0 && (
                <span className="flex items-center gap-1.5 px-1 py-1 text-ui text-accent-amber">
                  <AlertCircle size={10} />
                  {unavailableCount} {unavailableCount === 1 ? "file" : "files"} could not be diffed
                  — totals are incomplete.
                </span>
              )}
              {files.map((f, i) => (
                <FileChangedRow key={i} stat={f} />
              ))}
            </>
          )}
        </div>
      </div>

      {/* Session info */}
      <div>
        <SectionHeader label="Session" />
        <div className="flex flex-col gap-1.5 px-2.5 py-2 text-ui text-text-secondary">
          <KvRow
            k="Agent"
            v={
              <span>
                {/* Identity feeds the LABEL, never the chrome. `getAgentColor`
                    used to tint this row per provider, which is exactly the
                    identity-driven chrome the capability rule forbids — the
                    provider name is text, not a colour. */}
                <span className="font-medium text-text-primary">
                  {agentDisplayName(conversation?.agent ?? "")}
                </span>
                <span className="text-text-muted"> · {modelLabel}</span>
              </span>
            }
          />
          {conversation?.sshTarget && (
            <KvRow
              k="Host"
              v={
                <span className="font-mono text-accent-blue">
                  {conversation.sshTarget.user}@{conversation.sshTarget.host}
                </span>
              }
            />
          )}
          <KvRow
            k="Worktree"
            v={
              <span
                className="truncate font-mono text-ui"
                title={conversation?.projectPath ?? undefined}
              >
                {conversation?.projectPath ?? "—"}
              </span>
            }
          />
          <KvRow k="Started" v={startedRel} />
          <KvRow k="Tokens" v={<span className="font-mono">{totalTokens.toLocaleString()}</span>} />
        </div>
      </div>
    </>
  );
}

function SectionHeader({ label, right }: { label: string; right?: string }) {
  return (
    <div className="flex items-center gap-1.5 border-y border-line-soft bg-bg-tertiary px-2.5 py-1.5 text-meta font-semibold uppercase tracking-wide text-text-faint">
      <span>{label}</span>
      <span className="flex-1" />
      {right && (
        <span className="font-mono text-meta normal-case tracking-normal text-text-secondary">
          {right}
        </span>
      )}
    </div>
  );
}

function FileChangedRow({ stat }: { stat: PerFileDiffStat }) {
  const cells = 24;
  // D3 / P0-4: a failed/remote diff is NOT a zero-line diff. Say so instead of
  // rendering "+0 −0", which reads as "this file didn't really change".
  if (stat.unavailable) {
    return (
      <div className="rounded border border-accent-amber/30 bg-bg-tertiary px-2 py-1.5">
        <div className="flex items-center gap-1.5">
          <AlertCircle size={10} className="shrink-0 text-accent-amber" />
          <span className="flex-1 truncate font-mono text-ui text-text-primary" title={stat.path}>
            {basename(stat.path)}
          </span>
          <span className="shrink-0 text-meta text-accent-amber">
            {stat.unavailable === "remote" ? "diff unavailable (SSH)" : "diff unavailable"}
          </span>
        </div>
      </div>
    );
  }
  const pos = stat.adds + stat.dels;
  const addsCells = pos === 0 ? 0 : Math.max(1, Math.round((stat.adds / pos) * cells));
  const delsCells = pos === 0 ? 0 : Math.max(stat.dels > 0 ? 1 : 0, cells - addsCells);
  return (
    <div className="rounded border border-bg-border bg-bg-tertiary px-2 py-1.5">
      <div className="mb-1 flex items-center gap-1.5">
        <FileIcon size={10} className="text-text-muted" />
        <span className="flex-1 truncate font-mono text-ui text-text-primary" title={stat.path}>
          {basename(stat.path)}
        </span>
        <span className="font-mono text-meta text-accent-green">+{stat.adds}</span>
        <span className="font-mono text-meta text-accent-red">−{stat.dels}</span>
      </div>
      <div className="flex h-[3px] gap-px overflow-hidden rounded">
        {Array.from({ length: cells }).map((_, j) => {
          const filled =
            j < addsCells
              ? "bg-accent-green"
              : j < addsCells + delsCells
                ? "bg-accent-red"
                : "bg-bg-elevated";
          return <div key={j} className={`flex-1 ${filled} opacity-90`} />;
        })}
      </div>
    </div>
  );
}

function KvRow({ k, v }: { k: string; v: React.ReactNode }) {
  return (
    <div className="flex items-start gap-2">
      <span className="w-[70px] text-text-muted">{k}</span>
      <span className="min-w-0 flex-1 truncate">{v}</span>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

function basename(p: string): string {
  const segs = p.replace(/\\/g, "/").split("/").filter(Boolean);
  return segs[segs.length - 1] ?? p;
}

function relTime(ms: number): string {
  if (ms < 60_000) return "just now";
  const m = Math.floor(ms / 60_000);
  if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

function agentDisplayName(agent: string): string {
  const provider = API_PROVIDERS.find((p) => p.agentCli === agent);
  if (provider) return provider.name.replace(" (API)", "").replace(" (Local)", "");
  const labels: Record<string, string> = {
    "claude-code": "Claude",
    codex: "Codex",
    opencode: "OpenCode",
    packetcode: "PacketCode",
    // Retired transport; kept so a stored conversation on the id still reads.
    "api-packetcode": "PacketCode (ACP)",
  };
  return labels[agent] ?? agent;
}
