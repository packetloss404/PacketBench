import type { AgentConversation } from "@/types/agent-conversation";
import { useAgentStreamingStore } from "@/stores/agentStreamingStore";

/** Display tokens across root turns and the current conversation's child buckets.
 * Buckets are cumulative snapshots; reading them never consumes or changes usage. */
export function aggregateConversationTokens(
  conversation: Pick<AgentConversation, "id" | "messages">,
): number {
  let total = 0;
  for (const message of conversation.messages ?? []) {
    total +=
      (message.inputTokens ?? 0) + (message.outputTokens ?? 0) + (message.reasoningTokens ?? 0);
  }
  const buckets = useAgentStreamingStore.getState().getSubAgentTokens(conversation.id);
  for (const bucket of Object.values(buckets ?? {})) {
    total += bucket.inputTokens + bucket.outputTokens + bucket.reasoningTokens;
  }
  return total;
}
