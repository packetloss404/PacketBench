import { create } from "zustand";

/**
 * Streaming transient state for API conversations: extended-thinking deltas
 * and Codex MultiAgentV2 sub-agent token buckets. Both reset between turns
 * and never persist. Split out of agentTaskStore so chunks-per-second-tier
 * mutations don't churn the conversation-list selectors that drive the
 * sidebar.
 */

/** Codex MultiAgentV2 sub-agent token totals per address path. */
export interface SubAgentTokenBucket {
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  cacheReadTokens: number;
}

interface AgentStreamingState {
  /** Accumulating extended-thinking text during the current streaming
   * turn, keyed by conversationId. Cleared on `api-agent:thinking-stop`
   * or when the turn completes. */
  thinkingStream: Map<string, string>;
  /** A3: Codex MultiAgentV2 sub-agent token totals, keyed by
   * conversationId → address (`/root/agent_a` etc). `aggregateConversationTokens`
   * includes these snapshots in the token readout. Durable budget costs are
   * tracked separately in the usage ledger. */
  subAgentTokens: Map<string, Record<string, SubAgentTokenBucket>>;

  /** Append reasoning delta. Called from the `api-agent:thinking` listener. */
  appendThinking: (conversationId: string, delta: string) => void;
  /** Reset on `api-agent:thinking-stop`, on turn done, or on
   * fork/retry/checkpoint-restore. */
  clearThinking: (conversationId: string) => void;
  /** Replace a sub-agent bucket. Codex emits cumulative totals — replace,
   * not increment. */
  setSubAgentBucket: (conversationId: string, address: string, bucket: SubAgentTokenBucket) => void;

  getThinking: (conversationId: string) => string;
  getSubAgentTokens: (conversationId: string) => Record<string, SubAgentTokenBucket> | undefined;

  clearConversation: (conversationId: string) => void;
}

export const useAgentStreamingStore = create<AgentStreamingState>((set, get) => ({
  thinkingStream: new Map(),
  subAgentTokens: new Map(),

  appendThinking: (conversationId, delta) => {
    set((s) => {
      const next = new Map(s.thinkingStream);
      const existing = next.get(conversationId) ?? "";
      next.set(conversationId, existing + delta);
      return { thinkingStream: next };
    });
  },

  clearThinking: (conversationId) => {
    set((s) => {
      if (!s.thinkingStream.has(conversationId)) return s;
      const next = new Map(s.thinkingStream);
      next.delete(conversationId);
      return { thinkingStream: next };
    });
  },

  setSubAgentBucket: (conversationId, address, bucket) => {
    set((s) => {
      const next = new Map(s.subAgentTokens);
      const existing = next.get(conversationId) ?? {};
      next.set(conversationId, { ...existing, [address]: bucket });
      return { subAgentTokens: next };
    });
  },

  getThinking: (conversationId) => get().thinkingStream.get(conversationId) ?? "",
  getSubAgentTokens: (conversationId) => get().subAgentTokens.get(conversationId),

  clearConversation: (conversationId) => {
    set((s) => {
      const hasThinking = s.thinkingStream.has(conversationId);
      const hasSub = s.subAgentTokens.has(conversationId);
      if (!hasThinking && !hasSub) return s;
      const nextThinking = new Map(s.thinkingStream);
      const nextSub = new Map(s.subAgentTokens);
      nextThinking.delete(conversationId);
      nextSub.delete(conversationId);
      return { thinkingStream: nextThinking, subAgentTokens: nextSub };
    });
  },
}));
