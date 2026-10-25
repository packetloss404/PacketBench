import { beforeEach, describe, expect, it, vi } from "vitest";

// Deliberately does NOT mock `@/lib/tauri`: the real wrapper must run so this
// suite asserts the ACTUAL `invoke("start_api_agent_session", {...})` payload.
// That is what catches a positional-arg misbinding at the store call site,
// which a mocked-wrapper positional assertion cannot.
const invokeMock = vi.fn();
const listenMock = vi.fn();

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: (...args: unknown[]) => listenMock(...args),
}));

vi.mock("@/lib/agentsMd", () => ({
  loadAgentsMd: vi.fn().mockResolvedValue(null),
}));

vi.mock("@/stores/memoryStore", () => ({
  useMemoryStore: {
    getState: vi.fn(() => ({
      composeMemoryBrief: () => ({
        text: "",
        items: [],
        charBudget: 1800,
        truncated: false,
        scopeKey: "D:/projects/example",
      }),
    })),
  },
}));

vi.mock("@/stores/layoutStore", () => ({
  useLayoutStore: {
    getState: vi.fn(() => ({ setProjectPath: vi.fn() })),
  },
}));

describe("API conversation context-window wiring", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    localStorage.clear();
    listenMock.mockResolvedValue(() => {});
    invokeMock.mockResolvedValue(undefined);
  });

  it("sends contextWindowTokens and leaves the budget keys null when no session budget is set", async () => {
    const { useAgentTaskStore } = await import("@/stores/agentTaskStore");

    await useAgentTaskStore.getState().createApiConversation({
      agent: "api-openai",
      projectPath: "D:/projects/example",
      model: "gpt-5.5",
      initialMessage: "Build the thing",
    });

    const startCall = invokeMock.mock.calls.find(
      ([command]) => command === "start_api_agent_session",
    );
    expect(startCall, "start_api_agent_session must be invoked").toBeDefined();
    const payload = startCall?.[1] as Record<string, unknown>;
    expect(payload.contextWindowTokens).toBe(400_000);
    expect(payload.budgetScopeKey).toBeNull();
    expect(payload.budgetLimitUsd).toBeNull();
  });
});
