import { memo, useEffect, useMemo, useState } from "react";
import { Bot } from "lucide-react";

import type { AgentToolCall } from "@/types/agent-conversation";
import { parseToolInput } from "@/lib/parseToolInput";
import { MarkdownRenderer } from "@/components/common/MarkdownRenderer";
import { useAgentSettingsStore } from "@/stores/agentSettingsStore";
import { BaseToolCard } from "./tool-cards/BaseToolCard";
import { StatusPill } from "./tool-cards/StatusPill";

interface SubagentInput {
  task: string;
  model?: string;
}

interface SubagentToolCallCardProps {
  toolCall: AgentToolCall;
  conversationId: string;
}

function parseSubagentInput(raw: string | undefined): SubagentInput {
  const parsed = parseToolInput(raw);
  // Undecodable input is treated as a bare task description.
  if (!parsed) return { task: raw ?? "" };
  const task = typeof parsed.task === "string" ? parsed.task : "";
  const model = typeof parsed.model === "string" ? parsed.model : undefined;
  return { task, model };
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1).trimEnd()}…`;
}

function SubagentToolCallCardImpl({
  toolCall,
  conversationId: _conversationId,
}: SubagentToolCallCardProps) {
  const verbosity = useAgentSettingsStore((s) => s.transcriptViewMode);
  const { task, model } = useMemo(() => parseSubagentInput(toolCall.input), [toolCall.input]);

  const [expanded, setExpanded] = useState(verbosity === "verbose");

  // Keep expand state in sync when the global view mode changes after the
  // card has mounted.
  useEffect(() => {
    setExpanded(verbosity === "verbose");
  }, [verbosity]);

  const body = toolCall.fullContent ?? toolCall.summary ?? "";
  const hasBody = body.trim().length > 0;
  const canToggle = verbosity !== "summary" && hasBody;

  const taskDisplay = task || "(no task)";
  const headerTask = expanded ? taskDisplay : truncate(taskDisplay, 80);

  const pill =
    toolCall.status === "running" ? (
      <StatusPill status="running" />
    ) : (
      <StatusPill status={toolCall.status} interrupted={toolCall.interrupted} variant="label" />
    );

  const subHeader =
    verbosity === "verbose" && model ? (
      <div className="truncate px-2 pb-1 font-mono text-meta text-text-faint">model: {model}</div>
    ) : undefined;

  return (
    <BaseToolCard
      icon={<Bot size={11} className="shrink-0 text-accent-green" />}
      kind="subagent"
      title={<span className="italic">{headerTask}</span>}
      titleAttr={taskDisplay}
      statusPill={pill}
      subHeader={subHeader}
      canToggle={canToggle}
      expanded={expanded}
      onToggle={() => setExpanded((v) => !v)}
      toggleLabel={{
        expanded: "Collapse summary",
        collapsed: "Expand summary",
      }}
      isError={toolCall.status === "error" && !toolCall.interrupted}
      footer={
        <div className="flex items-center gap-1 px-2 pb-1 text-meta uppercase tracking-wide text-text-faint">
          <Bot size={9} />
          <span>Sub-agent</span>
        </div>
      }
    >
      <div className="mx-1 mb-1 max-h-[320px] overflow-y-auto rounded-lg bg-bg-primary p-2 text-text-primary">
        <MarkdownRenderer content={body} className="text-ui leading-relaxed" />
        {verbosity === "verbose" && toolCall.input && (
          // `selectable`: the global `body { user-select: none }` otherwise
          // makes the raw tool input uncopyable.
          <pre className="selectable mt-2 whitespace-pre-wrap border-t border-bg-border pt-2 font-mono text-meta text-text-muted">
            {(() => {
              try {
                return JSON.stringify(JSON.parse(toolCall.input), null, 2);
              } catch {
                return toolCall.input;
              }
            })()}
          </pre>
        )}
      </div>
    </BaseToolCard>
  );
}

// Memoized so a streaming turn's frequent store updates only re-render
// the card whose toolCall reference actually changed, not all 40+ at once.
export const SubagentToolCallCard = memo(SubagentToolCallCardImpl);
