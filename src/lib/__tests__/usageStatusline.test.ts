import { afterEach, describe, expect, it } from "vitest";
import { fmtTokens, sessionUsageFor, usageStatusline } from "@/lib/usageStatusline";
import { aggregateConversationTokens } from "@/lib/conversationTokens";
import { useAgentStreamingStore } from "@/stores/agentStreamingStore";
import type { AgentMessage } from "@/types/agent-conversation";

function assistant(over: Partial<AgentMessage>): AgentMessage {
  return {
    id: over.id ?? "m",
    role: "assistant",
    content: "",
    timestamp: 1,
    ...over,
  };
}

describe("fmtTokens", () => {
  it("scales into k and M, with the M threshold just under 1M", () => {
    expect(fmtTokens(820)).toBe("820");
    expect(fmtTokens(41_234)).toBe("41.2k");
    expect(fmtTokens(1_200_000)).toBe("1.2M");
    // 999,950 rounds to "1M", never "1000k".
    expect(fmtTokens(999_950)).toBe("1M");
  });
});

describe("usageStatusline", () => {
  const usage = {
    contextTokens: 41_200,
    totalInput: 82_000,
    totalOutput: 12_000,
  };

  it("renders only the token segments", () => {
    expect(usageStatusline(usage)).toBe("ctx 41.2k tok · in 82k · out 12k");
  });

  it("drops zero segments and returns null when there is nothing to say", () => {
    expect(usageStatusline({ contextTokens: 0, totalInput: 500, totalOutput: 0 })).toBe("in 500");
    expect(usageStatusline({ contextTokens: 0, totalInput: 0, totalOutput: 0 })).toBeNull();
    expect(usageStatusline(null)).toBeNull();
  });
});

describe("sessionUsageFor", () => {
  it("sums input/output across turns but takes context from the latest turn", () => {
    const usage = sessionUsageFor({
      model: "claude-opus-4-8",
      messages: [
        assistant({
          id: "a1",
          inputTokens: 1000,
          outputTokens: 200,
          cacheReadTokens: 500,
          costUsd: 0.5,
        }),
        { id: "u1", role: "user", content: "hi", timestamp: 2 },
        assistant({
          id: "a2",
          inputTokens: 3000,
          outputTokens: 400,
          reasoningTokens: 100,
          costUsd: 1.25,
        }),
      ],
    });
    // in = 1000 + 500 (cache) + 3000; out = 200 + 400 + 100.
    expect(usage).toEqual({
      contextTokens: 3000,
      totalInput: 4500,
      totalOutput: 700,
    });
  });

  it("returns null for a conversation that has reported nothing", () => {
    expect(sessionUsageFor({ model: "claude-opus-4-8", messages: [] })).toBeNull();
  });
});

describe("conversation token readouts", () => {
  afterEach(() => useAgentStreamingStore.setState({ subAgentTokens: new Map() }));
  it("combines root and child snapshots without double-counting cached prompt tokens", () => {
    const conversation = {
      id: "root",
      messages: [
        assistant({
          inputTokens: 100,
          outputTokens: 20,
          reasoningTokens: 5,
          cacheReadTokens: 40,
          costUsd: 9,
        }),
      ],
    };
    const streams = useAgentStreamingStore.getState();
    streams.setSubAgentBucket("root", "child", {
      inputTokens: 50,
      outputTokens: 10,
      reasoningTokens: 2,
      cacheReadTokens: 25,
    });
    streams.setSubAgentBucket("other", "child", {
      inputTokens: 1000,
      outputTokens: 1000,
      reasoningTokens: 1000,
      cacheReadTokens: 0,
    });
    expect(aggregateConversationTokens(conversation)).toBe(187);
    expect(aggregateConversationTokens(conversation)).toBe(187);
    streams.setSubAgentBucket("root", "child", {
      inputTokens: 60,
      outputTokens: 20,
      reasoningTokens: 3,
      cacheReadTokens: 25,
    });
    expect(aggregateConversationTokens(conversation)).toBe(208);
    streams.clearConversation("root");
    expect(aggregateConversationTokens(conversation)).toBe(125);
    expect(conversation.messages[0].costUsd).toBe(9);
  });
});
