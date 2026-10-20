import { memo, useEffect, useMemo, useState } from "react";
import { CheckSquare, ChevronRight, Square, XCircle } from "lucide-react";

import type { AgentToolCall } from "@/types/agent-conversation";
import { Spinner } from "@/components/ui/Spinner";
import { useAgentSettingsStore } from "@/stores/agentSettingsStore";

interface TaskListCardProps {
  toolCall: AgentToolCall;
}

type ParsedStatus = "pending" | "in_progress" | "completed";

interface ParsedTask {
  status: ParsedStatus;
  title: string;
}

/**
 * Parse the markdown checklist returned by the `task_list` tool.
 *
 * Format (one per line):
 *   - [ ] pending title
 *   - [~] in-progress title
 *   - [x] completed title
 *
 * Anything else is ignored so the card degrades gracefully if the agent
 * adds notes around the list.
 */
function parseChecklist(content: string): ParsedTask[] {
  const lines = content.split("\n");
  const out: ParsedTask[] = [];
  for (const raw of lines) {
    const m = raw.match(/^\s*-\s*\[(.)\]\s*(.+?)\s*$/);
    if (!m) continue;
    const marker = m[1].toLowerCase();
    const title = m[2];
    let status: ParsedStatus;
    if (marker === "x") status = "completed";
    else if (marker === "~") status = "in_progress";
    else if (marker === " " || marker === "") status = "pending";
    else continue;
    out.push({ status, title });
  }
  return out;
}

function StatusIcon({ status }: { status: ParsedStatus }) {
  if (status === "completed") {
    return <CheckSquare size={11} className="shrink-0 text-accent-green" />;
  }
  if (status === "in_progress") {
    return <Spinner size={11} className="shrink-0 text-accent-blue" label="in progress" />;
  }
  return <Square size={11} className="shrink-0 text-text-muted" />;
}

function rowClassName(status: ParsedStatus): string {
  if (status === "completed") return "text-accent-green line-through opacity-80";
  if (status === "in_progress") return "text-accent-blue";
  return "text-text-muted";
}

function TaskListCardImpl({ toolCall }: TaskListCardProps) {
  const verbosity = useAgentSettingsStore((s) => s.transcriptViewMode);
  const [expanded, setExpanded] = useState(verbosity !== "summary");

  // Keep expand state in sync when the global view mode changes after the
  // card has mounted (live keyboard cycling must visibly affect this card,
  // not just its initial mount state).
  useEffect(() => {
    setExpanded(verbosity !== "summary");
  }, [verbosity]);

  const content = toolCall.fullContent ?? toolCall.summary ?? "";
  const tasks = useMemo(() => parseChecklist(content), [content]);

  const counts = useMemo(() => {
    let pending = 0;
    let inProgress = 0;
    let completed = 0;
    for (const t of tasks) {
      if (t.status === "completed") completed++;
      else if (t.status === "in_progress") inProgress++;
      else pending++;
    }
    return { pending, inProgress, completed, total: tasks.length };
  }, [tasks]);

  if (toolCall.interrupted) {
    return (
      <div className="rounded border border-bg-border px-2 py-1 text-ui text-accent-amber">
        task_list · Interrupted
      </div>
    );
  }
  if (toolCall.status === "error") {
    return (
      <div className="flex items-center gap-1.5 rounded border border-accent-red/30 bg-accent-red/5 px-2 py-1 text-ui text-accent-red">
        <XCircle size={11} />
        <span className="font-mono">task_list</span>
        <span className="truncate">{content || "failed"}</span>
      </div>
    );
  }

  // While streaming, parsing may yield nothing — fall back to a tiny header.
  if (tasks.length === 0) {
    return (
      <div className="flex items-center gap-1.5 rounded border border-bg-border bg-bg-hover px-2 py-1 text-ui text-text-muted">
        {toolCall.status === "running" ? <Spinner size={11} /> : <Square size={11} />}
        <span className="font-mono">task_list</span>
        <span className="text-text-muted/80">{content.trim() || "no tasks"}</span>
      </div>
    );
  }

  return (
    <div className="rounded border border-bg-border bg-bg-hover">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
        className="flex w-full items-center gap-1.5 rounded-t px-2 py-1 text-left transition-colors hover:bg-bg-elevated"
      >
        <ChevronRight
          size={12}
          className={`shrink-0 transition-transform motion-reduce:transition-none ${
            expanded ? "rotate-90" : ""
          }`}
        />
        <CheckSquare size={12} className="text-accent-green" />
        <span className="font-mono text-ui text-text-secondary">tasks</span>
        <span className="text-meta text-text-muted">
          {counts.completed}/{counts.total} done
          {counts.inProgress > 0 ? ` · ${counts.inProgress} in progress` : ""}
        </span>
      </button>
      {expanded && (
        <ul className="space-y-0.5 px-2 pb-1.5 pt-0.5">
          {tasks.map((t, i) => (
            <li
              key={`${i}-${t.title}`}
              className={`flex items-center gap-1.5 text-ui leading-snug ${rowClassName(t.status)}`}
            >
              <StatusIcon status={t.status} />
              <span className="truncate">{t.title}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// Memoized so a streaming turn's frequent store updates only re-render
// the card whose toolCall reference actually changed, not all 40+ at once.
export const TaskListCard = memo(TaskListCardImpl);
