import type { AgentToolCall } from "@/types/agent-conversation";

/** A terminal cancellation is not a successful tool result or an exit code. */
export function interruptRunningToolCalls(toolCalls: AgentToolCall[]): AgentToolCall[] {
  if (!toolCalls.some((tool) => tool.status === "running")) return toolCalls;
  return toolCalls.map((tool) =>
    tool.status === "running" ? { ...tool, status: "error", interrupted: true } : tool,
  );
}
