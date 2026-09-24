import { estimateTurnCostUsd } from "@/lib/conversationCost";
import type { AgentConversation } from "@/types/agent-conversation";

/** Prefer stamped turn prices, never reprice historical turns after a model change.
 * The durable ledger also includes child requests. Take the larger observation,
 * not their sum: both observations include the root turns. */
export function sessionCostUsd(
  conversation: AgentConversation,
  ledger: Record<string, number> = {},
): number {
  const recorded = conversation.messages.reduce((sum, message) => {
    if (message.role !== "assistant") return sum;
    const cost =
      message.costUsd ?? estimateTurnCostUsd(conversation.model, message, message.timestamp);
    return sum + (typeof cost === "number" && Number.isFinite(cost) ? Math.max(0, cost) : 0);
  }, 0);
  const durable = ledger[conversation.id];
  return Math.max(recorded, Number.isFinite(durable) ? Math.max(0, durable) : 0);
}
