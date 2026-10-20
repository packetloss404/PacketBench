import { memo, useEffect, useState } from "react";
import { FileEdit } from "lucide-react";
import { BaseToolCard } from "../tool-cards/BaseToolCard";
import { StatusPill } from "../tool-cards/StatusPill";
import { toolRowMeta } from "../tool-cards/toolRowMeta";
import { isEditToolName, materializeEdits, parseEditToolCalls } from "@/lib/parseToolInput";
import { countLineChanges } from "@/lib/diffUtils";
import { useEditBaselineStore } from "@/stores/editBaselineStore";
import { useReviewStore } from "@/stores/reviewStore";
import { useAgentSettingsStore } from "@/stores/agentSettingsStore";
import type { AgentToolCall } from "@/types/agent-conversation";
import { ProvenanceChip } from "@/components/common/ProvenanceChip";

function ToolCallCardImpl({
  toolCall,
  conversationId,
  projectPath,
}: {
  toolCall: AgentToolCall;
  conversationId: string;
  projectPath: string;
}) {
  const verbosity = useAgentSettingsStore((s) => s.transcriptViewMode);
  const [expanded, setExpanded] = useState(verbosity === "verbose");

  // Keep expand state in sync when the global view mode changes after the
  // card has mounted.
  useEffect(() => {
    setExpanded(verbosity === "verbose");
  }, [verbosity]);

  // Normalized edit descriptor: fires for every provider's edit tools
  // (write_file, Write/Edit/MultiEdit/NotebookEdit, apply_patch), not just
  // the legacy in-process `write_file`. `projectPath` relativizes absolute
  // Claude Code / Codex paths so disk fallbacks and baseline keys line up.
  const edits = isEditToolName(toolCall.name) ? parseEditToolCalls(toolCall, projectPath) : [];
  const singleEdit = edits.length === 1 ? edits[0] : null;
  // Pre-edit content recorded for THIS call (per-tool-call baseline) so the
  // diff stays truthful after the edit applies. Subscribed so a baseline
  // arriving after the card mounted re-renders it.
  const callBaseline = useEditBaselineStore((s) => s.byToolCall.get(toolCall.id));
  const baselineContent =
    callBaseline && singleEdit && callBaseline.path === singleEdit.path
      ? callBaseline.content
      : undefined;
  // Replacement chains (Edit/MultiEdit) need the baseline to materialize;
  // without one there is nothing to diff — fall through to the generic card.
  const writeFileInput = singleEdit
    ? (() => {
        const after = materializeEdits([singleEdit], baselineContent ?? null);
        return after !== null ? { path: singleEdit.path, content: after } : null;
      })()
    : null;

  const statusPill =
    toolCall.status === "running" ? (
      <StatusPill status="running" />
    ) : (
      <StatusPill status={toolCall.status} interrupted={toolCall.interrupted} variant="label" />
    );

  const isError = toolCall.status === "error" && !toolCall.interrupted;

  // P1-8: inline transcript edits collapse to a one-line file chip
  // (DiffPaneTrigger-style +N/-M). Clicking deep-links into the canonical
  // review surface focused on this file — the full diff (with the protected
  // per-row comment composer) lives there, not in the transcript.
  if (writeFileInput) {
    const baseName = writeFileInput.path.split(/[\\/]/).pop() ?? writeFileInput.path;
    const counts =
      baselineContent !== undefined
        ? countLineChanges(baselineContent ?? "", writeFileInput.content)
        : null;
    const isNewFile = baselineContent === null;
    return (
      <button
        type="button"
        onClick={() =>
          useReviewStore.getState().openForConversation(conversationId, writeFileInput.path)
        }
        title={`Review ${writeFileInput.path}`}
        // Same resting fill + radius + header padding as BaseToolCard: the
        // transcript must show exactly ONE card background, so the edit chip
        // sits on bg-bg-tertiary too and only its border responds to hover.
        className={`flex w-full items-center gap-2 rounded-xl border px-3 py-2 text-left transition-colors ${
          isError
            ? "border-accent-red/40 bg-accent-red/5"
            : "border-bg-border bg-bg-tertiary hover:border-line-strong"
        }`}
      >
        <FileEdit size={12} className="shrink-0 text-text-secondary" />
        <span className="shrink-0 font-mono text-meta uppercase tracking-[0.05em] text-text-faint">
          Edit
        </span>
        <span className="truncate font-mono text-ui text-text-primary">{baseName}</span>
        {isNewFile && (
          <span className="shrink-0 font-mono text-meta font-semibold uppercase tracking-[0.05em] text-accent-green">
            new
          </span>
        )}
        {counts && (
          <span className="flex shrink-0 items-center gap-1 font-mono text-meta">
            <span className="text-accent-green">+{counts.added}</span>
            <span className="text-accent-red">-{counts.removed}</span>
          </span>
        )}
        <span className="flex-1" />
        {statusPill}
      </button>
    );
  }

  // Generic bucket (not an edit chip, not bash/subagent/task_list — those
  // have dedicated cards): a uniform one-line verb row — icon · verb ·
  // target · status — expandable on click, through the same BaseToolCard
  // shell bash/subagent rows use.
  const summary = toolCall.summary ?? "";
  const body = toolCall.fullContent ?? summary;
  const canToggle = verbosity !== "summary" && body.trim().length > 0;
  const meta = toolRowMeta(toolCall);
  const Icon = meta.icon;

  return (
    <BaseToolCard
      icon={<Icon size={11} className="shrink-0 text-text-muted" />}
      // Eyebrow carries the raw tool id the model actually called; the title
      // carries the humanized verb + target. Suppressed for the toolRowMeta
      // fallback, where verb IS the tool name and the two would duplicate.
      kind={meta.verb === toolCall.name ? undefined : toolCall.name}
      title={
        <span className="flex min-w-0 items-center gap-1.5">
          <span className="shrink-0 text-text-primary">{meta.verb}</span>
          {meta.target && (
            <span className="min-w-0 truncate font-mono text-text-muted">{meta.target}</span>
          )}
        </span>
      }
      titleAttr={meta.target}
      headerActions={<ProvenanceChip envelope={toolCall.provenance} />}
      statusPill={statusPill}
      canToggle={canToggle}
      expanded={expanded}
      onToggle={() => setExpanded((v) => !v)}
      toggleLabel={{ expanded: "Collapse output", collapsed: "Expand output" }}
      isError={isError}
    >
      {/* `selectable` is load-bearing: `body { user-select: none }` is global
          (src/index.css), so without it tool output cannot be copied at all.
          Full-bleed with a divider now that the card clips its own corners. */}
      <pre className="selectable max-h-[320px] overflow-auto whitespace-pre-wrap border-t border-bg-border bg-bg-primary px-3 py-2.5 font-mono text-ui text-text-primary">
        {body}
      </pre>
      {verbosity === "verbose" && toolCall.input && (
        <pre className="selectable max-h-48 overflow-auto whitespace-pre-wrap border-t border-line-soft bg-bg-secondary px-3 py-2 font-mono text-meta text-text-muted">
          input: {toolCall.input}
        </pre>
      )}
    </BaseToolCard>
  );
}

// Memoized so a streaming turn's frequent store updates only re-render
// the card whose toolCall reference actually changed, not all 40+ at once.
export const ToolCallCard = memo(ToolCallCardImpl);
