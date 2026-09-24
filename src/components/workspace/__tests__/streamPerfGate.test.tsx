/**
 * Synthetic store-write timing and subscriber-isolation checks.
 * These exercise four conversation updates; they do not measure browser paint,
 * native frame rate, real provider streaming, or an automatic fallback.
 */
import { render } from "@testing-library/react";
import { act, Profiler } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentConversation, AgentMessage } from "@/types/agent-conversation";

// --- agentTaskStore module-init needs the tauri surface stubbed. ---
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn().mockResolvedValue(() => {}) }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@/lib/agentsMd", () => ({ loadAgentsMd: vi.fn().mockResolvedValue(null) }));
vi.mock("@/stores/memoryStore", () => ({
  useMemoryStore: {
    getState: vi.fn(() => ({
      composeMemoryBrief: vi.fn(() => ({ text: "" })),
    })),
  },
}));
vi.mock("@/lib/tauri", () => ({
  createPtySession: vi.fn(),
  writePty: vi.fn(),
  killPty: vi.fn(),
  readPtyTranscript: vi.fn().mockResolvedValue({ data: "" }),
  listPtySessions: vi.fn().mockResolvedValue([]),
  detectAgent: vi.fn(),
  loadPersistedState: vi.fn(),
  saveAgentsSlice: vi.fn().mockResolvedValue(undefined),
  startApiAgentSession: vi.fn().mockResolvedValue(undefined),
  sendApiAgentMessage: vi.fn().mockResolvedValue(undefined),
  cancelApiAgentSession: vi.fn().mockResolvedValue(undefined),
  cancelPendingTools: vi.fn(),
  closeApiAgentSession: vi.fn().mockResolvedValue(undefined),
  saveConversation: vi.fn().mockResolvedValue(undefined),
  loadConversations: vi.fn().mockResolvedValue([]),
  deleteConversationFile: vi.fn(),
  changeAgentModel: vi.fn(),
  setPlanMode: vi.fn(),
  setPermissionMode: vi.fn(),
  respondPermission: vi.fn(),
  setApproveWrites: vi.fn(),
  respondEdit: vi.fn(),
  retryLastTurn: vi.fn(),
  exportConversationMarkdown: vi.fn(),
  saveWorkspacesSlice: vi.fn().mockResolvedValue(undefined),
}));

import { useAgentTaskStore } from "@/stores/agentTaskStore";

function streamingConv(id: string): AgentConversation {
  return {
    id,
    title: `Conv ${id}`,
    agent: "api-openai",
    projectPath: "/repo",
    status: "active",
    messages: [
      { id: `${id}-u`, role: "user", content: "go", timestamp: 1 } as AgentMessage,
      {
        id: `${id}-a`,
        role: "assistant",
        content: "",
        timestamp: 2,
        isStreaming: true,
      } as AgentMessage,
    ],
    sessionId: id,
    rawOutput: "",
    createdAt: 1,
    updatedAt: 1,
    mode: "api",
    provider: "openai",
    model: "gpt-4o",
  };
}

/**
 * One coalesced flush for `id`: append `delta` to the streaming assistant
 * message, replacing ONLY this conversation's entry (stable references for
 * every other conversation). This is exactly the write shape of the coalescer
 * `apply` in apiAgentListeners.ts.
 */
function flush(id: string, delta: string) {
  const conversations = useAgentTaskStore.getState().conversations;
  const index = conversations.findIndex((c) => c.id === id);
  if (index === -1) return;
  const conv = conversations[index];
  const messages = conv.messages.map((m) =>
    m.isStreaming && m.role === "assistant" ? { ...m, content: m.content + delta } : m,
  );
  const next = [...conversations];
  next[index] = { ...conv, messages, updatedAt: Date.now() };
  useAgentTaskStore.setState({ conversations: next });
}

function p95(samples: number[]): number {
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))];
}

beforeEach(() => {
  useAgentTaskStore.setState({ conversations: [] });
});

describe("Synthetic conversation update performance", () => {
  it("keeps p95 synthetic four-conversation update time below 16 ms", () => {
    const ids = ["s1", "s2", "s3", "s4"];
    useAgentTaskStore.setState({ conversations: ids.map(streamingConv) });

    const FRAMES = 300;
    const delta = "x".repeat(40); // ~40-char coalesced delta per frame per stream
    const frameTimes: number[] = [];

    for (let f = 0; f < FRAMES; f++) {
      const t0 = performance.now();
      for (const id of ids) flush(id, delta); // all four tiles flush this frame
      frameTimes.push(performance.now() - t0);
    }

    const measured = p95(frameTimes);
    // Record for the run log (visible with --reporter=verbose / on failure).
    console.log(`[perf-gate] p95 per-frame apply (4 streams): ${measured.toFixed(3)} ms`);

    // CPU-work regression bound for this synthetic workload.
    expect(measured).toBeLessThan(16);

    // Sanity: every stream actually accumulated its full transcript in order.
    const convs = useAgentTaskStore.getState().conversations;
    for (const id of ids) {
      const a = convs.find((c) => c.id === id)!.messages.find((m) => m.role === "assistant")!;
      expect(a.content).toBe(delta.repeat(FRAMES));
    }
  });
});

describe("Profiler assertion — non-streaming tiles do not re-render on another tile's flush", () => {
  it("a subscriber to conversation B does NOT re-render when only conversation A flushes", () => {
    useAgentTaskStore.setState({
      conversations: [streamingConv("A"), streamingConv("B")],
    });

    const commits: Record<string, number> = { A: 0, B: 0 };
    // onRender fires once per commit that touches the Profiler's subtree, so a
    // tile that does not re-render produces no commit for its Profiler.
    const onRender = (id: string) => {
      commits[id] += 1;
    };

    // Probe mirrors AgentChatPane's own selector: `find(c => c.id === id)`.
    // Zustand re-renders only when the SELECTED value's reference changes;
    // replacing only A's array entry keeps B's object reference stable.
    function Probe({ id }: { id: string }) {
      useAgentTaskStore((s) => s.conversations.find((c) => c.id === id));
      return null;
    }

    render(
      <>
        <Profiler id="A" onRender={onRender}>
          <Probe id="A" />
        </Profiler>
        <Profiler id="B" onRender={onRender}>
          <Probe id="B" />
        </Profiler>
      </>,
    );
    expect(commits).toEqual({ A: 1, B: 1 }); // both committed once on mount

    // Flush A repeatedly — B's slice reference never changes.
    act(() => {
      flush("A", "aaa");
      flush("A", "bbb");
      flush("A", "ccc");
    });

    expect(commits.A).toBeGreaterThan(1); // A re-rendered on its own flushes
    expect(commits.B).toBe(1); // B did NOT re-render on A's flushes
  });
});
