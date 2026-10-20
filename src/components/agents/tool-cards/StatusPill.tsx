import { CheckCircle2, XCircle } from "lucide-react";

import type { AgentToolCall } from "@/types/agent-conversation";
import { Spinner } from "@/components/ui/Spinner";

type StatusPillProps =
  | { status: Extract<AgentToolCall["status"], "running"> }
  | {
      // "label" renders done/error literals; "exit-code" formats `exit N` and
      // colours by code === 0 (used by bash where a real exit number is more
      // informative than the binary status flag).
      status: Exclude<AgentToolCall["status"], "running">;
      variant: "label";
    }
  | {
      status: Exclude<AgentToolCall["status"], "running">;
      variant: "exit-code";
      exitCode: number;
    };

// No fill, no chip: the card itself is the only surface in the transcript that
// paints a background. Status reads as a colour-coded uppercase mono label so a
// long transcript can be scanned down the right edge.
const PILL_BASE =
  "inline-flex shrink-0 items-center gap-1 text-meta font-mono font-semibold uppercase tracking-[0.05em]";

export function StatusPill(props: StatusPillProps & { interrupted?: boolean }) {
  if (props.interrupted) {
    return <span className={`${PILL_BASE} text-accent-amber`}>Interrupted</span>;
  }
  if (props.status === "running") {
    return (
      <span className={`${PILL_BASE} text-accent-blue`}>
        <Spinner size={10} label="running" />
        running
      </span>
    );
  }

  if (props.variant === "exit-code") {
    const ok = props.exitCode === 0;
    return (
      <span className={`${PILL_BASE} ${ok ? "text-accent-green" : "text-accent-red"}`}>
        {ok ? <CheckCircle2 size={10} /> : <XCircle size={10} />}
        exit {props.exitCode}
      </span>
    );
  }

  const isError = props.status === "error";
  return (
    <span className={`${PILL_BASE} ${isError ? "text-accent-red" : "text-accent-green"}`}>
      {isError ? <XCircle size={10} /> : <CheckCircle2 size={10} />}
      {isError ? "error" : "done"}
    </span>
  );
}
