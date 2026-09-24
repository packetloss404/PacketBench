import { useEffect, useMemo, useRef, useState } from "react";
import { Bot, Loader2, Square } from "lucide-react";
import { useAgentTaskStore } from "@/stores/agentTaskStore";
import { openConversationInAgents } from "@/stores/sessionGlue";
import { aggregateConversationTokens } from "@/lib/conversationTokens";
import { useConversationAttention } from "@/lib/sessionStatus";

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

/**
 * Toolbar chip + dropdown for running API conversations. Mirrors Claude
 * Code's `Ctrl+B / /tasks` background-agent tray: shows how many agents are
 * currently doing work, with one click to jump into any of them. Lives in
 * the Toolbar so it's reachable from any view, not just the Agents pane —
 * users can navigate away to triage issues, deploy, etc., and still see a
 * persistent indicator of agents still chewing.
 */
export function RunningAgentsChip() {
  const conversations = useAgentTaskStore((s) => s.conversations);
  const cancelActiveConversation = useAgentTaskStore((s) => s.cancelActiveConversation);
  const cancellingConversationIds = useAgentTaskStore((s) => s.cancellingConversationIds);

  const [open, setOpen] = useState(false);
  const wrapperRef = useRef<HTMLDivElement>(null);

  // Tile program (P4-S1): "running" is derived from the SINGLE status truth
  // (sessionStatus attention === "working"), not a bespoke streaming scan, so
  // the chip, the tab-strip dot, and the sidebar can never disagree.
  const attention = useConversationAttention();
  const running = useMemo(
    () => conversations.filter((c) => c.mode === "api" && attention.get(c.id) === "working"),
    [conversations, attention],
  );

  // Close on outside click.
  useEffect(() => {
    if (!open) return;
    function onClick(e: MouseEvent) {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, [open]);

  if (running.length === 0) return null;

  return (
    <div className="relative" ref={wrapperRef}>
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1.5 rounded bg-accent-green/15 px-2 py-0.5 text-xs text-accent-green transition-colors hover:bg-accent-green/25"
        title={`${running.length} agent${running.length === 1 ? "" : "s"} running — click to inspect`}
      >
        <Loader2 size={11} className="animate-spin" />
        <span>{running.length}</span>
      </button>

      {open && (
        <div className="absolute right-0 top-full z-50 mt-1 w-72 rounded-lg border border-bg-border bg-bg-secondary py-1 shadow-xl">
          <div className="px-3 py-1 text-[10px] uppercase tracking-wider text-text-muted">
            Running agents
          </div>
          {running.map((conv) => {
            const totalTokens = aggregateConversationTokens(conv);
            const stopping = cancellingConversationIds?.has(conv.id) ?? false;
            return (
              <div
                key={conv.id}
                className="flex items-center gap-2 px-2 py-1.5 transition-colors hover:bg-bg-hover"
              >
                <Bot size={11} className="shrink-0 text-accent-green" />
                <button
                  type="button"
                  onClick={() => {
                    openConversationInAgents(conv.id);
                    setOpen(false);
                  }}
                  className="flex min-w-0 flex-1 flex-col text-left"
                  title={`Open "${conv.title}" in Agents`}
                >
                  <span className="truncate text-[11px] text-text-primary">{conv.title}</span>
                  <span className="text-[9px] text-text-muted">
                    {conv.model ?? "?"} · {fmtTokens(totalTokens)} tok
                  </span>
                </button>
                <button
                  type="button"
                  onClick={() => void cancelActiveConversation(conv.id)}
                  disabled={stopping}
                  className="rounded p-1 text-text-muted hover:bg-bg-hover hover:text-accent-red disabled:cursor-wait disabled:opacity-60"
                  title={stopping ? "Waiting for Stop acknowledgement" : "Stop this agent"}
                >
                  <Square size={10} className={stopping ? "animate-pulse" : undefined} />
                </button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
