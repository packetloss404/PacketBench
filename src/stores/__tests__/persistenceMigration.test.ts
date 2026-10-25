import { describe, it, expect, beforeEach, vi } from "vitest";
import type { Flight } from "@/types/flight";
import type { PersistedState } from "@/lib/tauri";
import type { AgentConversation } from "@/types/agent-conversation";

// === Mocks ===

const mockLoadPersistedState = vi.fn();
const mockSaveFlightsSlice = vi.fn().mockResolvedValue(undefined);
const mockSaveUiSlice = vi.fn().mockResolvedValue(undefined);
const mockSaveIssuesSlice = vi.fn().mockResolvedValue(undefined);

vi.mock("@/lib/tauri", () => ({
  loadPersistedState: (...args: unknown[]) => mockLoadPersistedState(...args),
  saveFlightsSlice: (...args: unknown[]) => mockSaveFlightsSlice(...args),
  saveUiSlice: (...args: unknown[]) => mockSaveUiSlice(...args),
  saveIssuesSlice: (...args: unknown[]) => mockSaveIssuesSlice(...args),
}));

vi.mock("@/stores/routingStore", () => ({
  useRoutingStore: {
    getState: vi.fn().mockReturnValue({
      resolveForTask: vi.fn().mockReturnValue({ agentConfigId: "claude-code", model: undefined }),
    }),
  },
}));

vi.mock("@/stores/issueStore", () => ({
  useIssueStore: {
    getState: vi.fn().mockReturnValue({
      issues: [],
      assignToFlight: vi.fn(),
    }),
  },
}));

// --- Helpers ---

function makeFlight(overrides: Partial<Flight> = {}): Flight {
  return {
    id: `flight_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    title: "Test Flight",
    objective: "Test objective",
    status: "draft",
    priority: "medium",
    projectPath: "/tmp/test",
    workspaceId: null,
    milestones: [],
    linkedSessionIds: [],
    issueIds: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
    totalCost: 0,
    totalTokens: 0,
    ...overrides,
  };
}

function makePersistedState(flights: Flight[]): PersistedState {
  return {
    version: 1,
    flights,
    agents: [],
    issues: [],
    settings: {
      maxParallelSessions: 3,
      milestoneGating: true,
      projectPath: "/tmp/test",
    },
    ui: {
      selectedFlightId: null,
      selectedView: null,
      theme: null,
    },
    workspaces: [],
    memoryEvents: [],
    memoryPatterns: [],
    servers: [],
    cliAccounts: [],
    cliAccountDefaults: {},
  };
}

// --- Tests ---

describe("flightStore backend persistence", () => {
  beforeEach(async () => {
    // Clear localStorage
    localStorage.clear();
    // Reset all mocks
    vi.clearAllMocks();
    mockSaveFlightsSlice.mockResolvedValue(undefined);
    mockSaveUiSlice.mockResolvedValue(undefined);
    mockLoadPersistedState.mockReset();

    // Re-import flightStore fresh by resetting the module registry
    vi.resetModules();
  });

  async function getStore() {
    const mod = await import("@/stores/flightStore");
    return mod.useFlightStore;
  }

  it("loads from backend on hydrate", async () => {
    const backendFlight = makeFlight({ id: "flight_backend_1", title: "Backend Flight" });
    mockLoadPersistedState.mockResolvedValue(makePersistedState([backendFlight]));

    const store = await getStore();
    await store.getState().hydrateFromBackend();

    const { flights } = store.getState();
    expect(flights).toHaveLength(1);
    expect(flights[0].id).toBe("flight_backend_1");
    expect(flights[0].title).toBe("Backend Flight");
  });

  it("uses backend state when backend is empty", async () => {
    mockLoadPersistedState.mockResolvedValue(makePersistedState([]));

    const store = await getStore();
    await store.getState().hydrateFromBackend();

    const { flights } = store.getState();
    expect(flights).toHaveLength(0);
  });

  it("prefers backend state when backend has data", async () => {
    const backendFlights = [
      makeFlight({ id: "flight_b1", title: "Backend 1" }),
      makeFlight({ id: "flight_b2", title: "Backend 2" }),
      makeFlight({ id: "flight_b3", title: "Backend 3" }),
    ];
    mockLoadPersistedState.mockResolvedValue(makePersistedState(backendFlights));

    const store = await getStore();
    await store.getState().hydrateFromBackend();

    const { flights } = store.getState();
    expect(flights).toHaveLength(3);
    expect(flights.map((f) => f.id)).toEqual(["flight_b1", "flight_b2", "flight_b3"]);
  });

  it("keeps the current in-memory state when backend fails", async () => {
    mockLoadPersistedState.mockRejectedValue(new Error("Backend unavailable"));

    const store = await getStore();
    await store.getState().hydrateFromBackend();

    const { flights } = store.getState();
    expect(flights).toHaveLength(0);
  });

  it("saves to backend via saveFlightsSlice when addFlight is called", async () => {
    mockLoadPersistedState.mockResolvedValue(makePersistedState([]));

    const store = await getStore();

    // Clear any calls from initialization
    mockSaveFlightsSlice.mockClear();
    mockSaveUiSlice.mockClear();

    store.getState().addFlight({
      title: "New Flight",
      objective: "Test objective",
      priority: "high",
      projectPath: "/tmp/test",
    });

    // saveState calls syncFlightsToBackend which calls saveFlightsSlice
    // Give the async void call a tick to resolve
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(mockSaveFlightsSlice).toHaveBeenCalled();
  });

  it("hydrateFromBackend accepts a pre-fetched persisted state", async () => {
    const prefetchedFlight = makeFlight({ id: "flight_prefetched", title: "Prefetched" });
    const persisted = makePersistedState([prefetchedFlight]);

    const store = await getStore();
    await store.getState().hydrateFromBackend(persisted);

    const { flights } = store.getState();
    expect(flights).toHaveLength(1);
    expect(flights[0].id).toBe("flight_prefetched");
    // Should NOT have called loadPersistedState since we passed data directly
    expect(mockLoadPersistedState).not.toHaveBeenCalled();
  });
});

describe("storage utility migration pattern", () => {
  const TEST_KEY = "packetbench:test-migration";

  beforeEach(() => {
    localStorage.clear();
  });

  it("loadFromStorage returns fallback when key is missing", async () => {
    // Dynamic import to get fresh module
    const { loadFromStorage } = await import("@/lib/storage");
    const result = loadFromStorage<{ items: string[] }>(TEST_KEY, { items: [] });
    expect(result).toEqual({ items: [] });
  });

  it("loadFromStorage returns parsed data when key exists", async () => {
    localStorage.setItem(TEST_KEY, JSON.stringify({ items: ["a", "b"] }));
    const { loadFromStorage } = await import("@/lib/storage");
    const result = loadFromStorage<{ items: string[] }>(TEST_KEY, { items: [] });
    expect(result).toEqual({ items: ["a", "b"] });
  });

  it("loadFromStorage returns fallback on corrupt JSON", async () => {
    localStorage.setItem(TEST_KEY, "{not valid json");
    const { loadFromStorage } = await import("@/lib/storage");
    const result = loadFromStorage<{ items: string[] }>(TEST_KEY, { items: [] });
    expect(result).toEqual({ items: [] });
  });

  it("saveToStorage writes JSON to localStorage", async () => {
    const { saveToStorage } = await import("@/lib/storage");
    saveToStorage(TEST_KEY, { items: ["x"] });
    const raw = localStorage.getItem(TEST_KEY);
    expect(raw).not.toBeNull();
    expect(JSON.parse(raw!)).toEqual({ items: ["x"] });
  });

  it("removeFromStorage clears the key", async () => {
    localStorage.setItem(TEST_KEY, "data");
    const { removeFromStorage } = await import("@/lib/storage");
    removeFromStorage(TEST_KEY);
    expect(localStorage.getItem(TEST_KEY)).toBeNull();
  });

  it("generateId produces unique prefixed IDs", async () => {
    const { generateId } = await import("@/lib/storage");
    const id1 = generateId("test");
    const id2 = generateId("test");
    expect(id1).toMatch(/^test_/);
    expect(id2).toMatch(/^test_/);
    expect(id1).not.toBe(id2);
  });
});

// === P2-20 — persisted-data safety for the state-layer pruning ===
//
// Deleting ideationStore/goalStore and pruning the AgentConversation mirror
// fields + api-minimax-api provider variant must not corrupt or crash on
// existing users' persisted state. Stale localStorage keys from the cut
// stores must be silently ignored, and legacy conversation files carrying
// the retired mirror fields / provider id must hydrate into a clean shape.

describe("orphaned localStorage keys from cut stores are silently ignored", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.resetModules();
  });

  it("moduleStore ignores a persisted 'ideation' entry and only carries registry modules", async () => {
    // Legacy `packetbench:modules` blob from a build that still had the
    // ideation module enabled. `mergeWithDefaults` iterates the current
    // registry only, so the orphaned "ideation" key must not survive.
    localStorage.setItem(
      "packetbench:modules",
      JSON.stringify({
        ideation: { enabled: true },
        quality: { enabled: true },
      }),
    );
    // Brand-storageKey'd orphans from the cut goal/ideation stores — never
    // read again, but must not throw on presence.
    localStorage.setItem(
      "packetbench:goals",
      JSON.stringify({ version: 1, goals: [{ id: "goal-1", title: "Stale goal" }] }),
    );
    localStorage.setItem(
      "packetbench:ideation-sessions",
      JSON.stringify({ "session-1": { id: "session-1", ideas: [] } }),
    );

    const { useModuleStore } = await import("@/stores/moduleStore");
    const { moduleRegistry } = await import("@/modules/registry");

    const states = useModuleStore.getState().states;
    const registryIds = moduleRegistry.map((m) => m.id).sort();

    expect(Object.keys(states).sort()).toEqual(registryIds);
    expect(states).not.toHaveProperty("ideation");
    expect(states.quality?.enabled).toBe(true);
  });
});

describe("legacy conversation hydration strips mirror fields and canonicalizes agent ids", () => {
  const listenMock = vi.fn();
  const invokeMock = vi.fn();
  const loadConversationsMockLocal = vi.fn();
  const saveConversationMockLocal = vi.fn().mockResolvedValue(undefined);

  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    localStorage.clear();
    listenMock.mockResolvedValue(() => {});
    invokeMock.mockResolvedValue(undefined);
    saveConversationMockLocal.mockResolvedValue(undefined);
  });

  async function setupHydration(rawConversations: string[]) {
    loadConversationsMockLocal.mockResolvedValue(rawConversations);

    vi.doMock("@tauri-apps/api/event", () => ({
      listen: (...args: unknown[]) => listenMock(...args),
    }));
    vi.doMock("@tauri-apps/api/core", () => ({
      invoke: (...args: unknown[]) => invokeMock(...args),
    }));
    vi.doMock("@/lib/agentsMd", () => ({
      loadAgentsMd: vi.fn().mockResolvedValue(null),
    }));
    vi.doMock("@/stores/memoryStore", () => ({
      useMemoryStore: {
        getState: vi.fn(() => ({})),
      },
    }));
    vi.doMock("@/stores/layoutStore", () => ({
      useLayoutStore: { getState: vi.fn(() => ({ setProjectPath: vi.fn() })) },
    }));
    vi.doMock("@/lib/tauri", () => ({
      createPtySession: vi.fn(),
      writePty: vi.fn(),
      killPty: vi.fn(),
      readPtyTranscript: vi.fn().mockResolvedValue({ data: "" }),
      listPtySessions: vi.fn().mockResolvedValue([]),
      detectAgent: vi.fn(),
      loadPersistedState: vi.fn(),
      saveAgentsSlice: vi.fn().mockResolvedValue(undefined),
      startApiAgentSession: vi.fn().mockResolvedValue(undefined),
      sendApiAgentMessage: vi.fn(),
      cancelApiAgentSession: vi.fn(),
      cancelPendingTools: vi.fn(),
      closeApiAgentSession: vi.fn(),
      saveConversation: (...args: unknown[]) => saveConversationMockLocal(...args),
      loadConversations: (...args: unknown[]) => loadConversationsMockLocal(...args),
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

    const { useAgentTaskStore, canonicalizeAgentCli } = await import("@/stores/agentTaskStore");
    const { useAgentPlanStore } = await import("@/stores/agentPlanStore");
    const { hydrateConversations, refreshConversationProjection } =
      await import("@/stores/agentConversationPersistence");
    return {
      useAgentTaskStore,
      useAgentPlanStore,
      hydrateConversations,
      refreshConversationProjection,
      canonicalizeAgentCli,
    };
  }

  it("hydrates a legacy conversation file, strips mirror keys, and canonicalizes api-minimax-api", async () => {
    const legacyConversation = {
      id: "conv-legacy-1",
      title: "Legacy conversation",
      agent: "api-minimax-api",
      projectPath: "/repo",
      status: "active", // must be coerced to "idle" on hydrate
      messages: [{ id: "m1", role: "assistant", content: "hi", timestamp: 1, isStreaming: true }],
      sessionId: null,
      rawOutput: "",
      createdAt: 1,
      updatedAt: 2,
      mode: "api",
      queuedMessages: ["queued turn"],
      // Legacy/ephemeral mirror fields that must be stripped on hydrate:
      plan: [{ id: "p1", content: "Step one", status: "pending" }],
      planApproved: true,
      pendingPermissions: [{ id: "perm-1", name: "bash", arguments: "{}" }],
      pendingEdits: [{ id: "edit-1", path: "src/a.ts", content: "x" }],
      thinkingStream: "some partial thinking...",
      subAgentTokens: {
        "/root/agent_a": {
          inputTokens: 1,
          outputTokens: 1,
          reasoningTokens: 0,
          cacheReadTokens: 0,
        },
      },
      workspaceId: "workspace-legacy-1",
      spec: { title: "old spec fsm" },
      specStage: "planning",
    };

    const { useAgentTaskStore, useAgentPlanStore, hydrateConversations } = await setupHydration([
      JSON.stringify(legacyConversation),
    ]);

    hydrateConversations();
    // Let the loadConversations().then(...) microtask chain settle.
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));

    const hydrated = useAgentTaskStore
      .getState()
      .conversations.find((c) => c.id === "conv-legacy-1");
    expect(hydrated).toBeDefined();
    expect(hydrated?.status).toBe("idle");
    expect(hydrated?.agent).toBe("api-minimax");
    expect(hydrated?.messages[0]?.isStreaming).toBe(false);
    expect(hydrated?.queuedMessages).toEqual([]);

    // Every legacy/ephemeral mirror key must be stripped from the in-store record.
    for (const key of [
      "plan",
      "planApproved",
      "pendingPermissions",
      "pendingEdits",
      "thinkingStream",
      "subAgentTokens",
      "workspaceId",
      "spec",
      "specStage",
    ]) {
      expect(hydrated).not.toHaveProperty(key);
    }

    // The plan substore — not the conversation record — is the ONE
    // persistence mechanism for plan/planApproved (P1-11).
    expect(useAgentPlanStore.getState().getPlan("conv-legacy-1")).toEqual(legacyConversation.plan);
    expect(useAgentPlanStore.getState().getPlanApproved("conv-legacy-1")).toBe(true);
  });

  it("hydrates a Monitor projection without persisting cold-start auto-archive changes", async () => {
    const oldDoneConversation = {
      id: "conv-monitor-readonly",
      title: "Old completed conversation",
      agent: "api-openai",
      projectPath: "/repo",
      status: "done",
      messages: [],
      sessionId: "conv-monitor-readonly",
      rawOutput: "",
      createdAt: Date.now() - 30 * 86_400_000,
      updatedAt: Date.now() - 20 * 86_400_000,
      mode: "api",
    };
    const { useAgentTaskStore, refreshConversationProjection } = await setupHydration([
      JSON.stringify(oldDoneConversation),
    ]);

    await refreshConversationProjection();

    expect(saveConversationMockLocal).not.toHaveBeenCalled();
    expect(
      useAgentTaskStore
        .getState()
        .conversations.find((conversation) => conversation.id === oldDoneConversation.id)?.archived,
    ).toBe(true);
  });

  it("atomically replaces the Monitor projection on every refresh without writing", async () => {
    const firstConversation = {
      id: "conv-monitor-first",
      title: "First projection",
      agent: "api-openai",
      projectPath: "/repo",
      status: "done",
      messages: [],
      sessionId: null,
      rawOutput: "",
      createdAt: 1,
      updatedAt: 2,
      mode: "api",
    };
    const secondConversation = {
      ...firstConversation,
      id: "conv-monitor-second",
      title: "Second projection",
      updatedAt: 3,
    };
    const { useAgentTaskStore, refreshConversationProjection } = await setupHydration([]);
    loadConversationsMockLocal.mockReset();
    loadConversationsMockLocal
      .mockResolvedValueOnce([JSON.stringify(firstConversation)])
      .mockResolvedValueOnce([JSON.stringify(secondConversation)]);

    await refreshConversationProjection();
    expect(useAgentTaskStore.getState().conversations.map(({ id }) => id)).toEqual([
      firstConversation.id,
    ]);

    await refreshConversationProjection();
    expect(useAgentTaskStore.getState().conversations.map(({ id }) => id)).toEqual([
      secondConversation.id,
    ]);
    expect(loadConversationsMockLocal).toHaveBeenCalledTimes(2);
    expect(saveConversationMockLocal).not.toHaveBeenCalled();
  });

  it("preserves the Monitor projection when a refresh read fails", async () => {
    const existingConversation: AgentConversation = {
      id: "conv-monitor-existing",
      title: "Last safe projection",
      agent: "api-openai",
      projectPath: "/repo",
      status: "idle",
      messages: [],
      sessionId: null,
      rawOutput: "",
      createdAt: 1,
      updatedAt: 2,
      mode: "api",
      queuedMessages: [],
    };
    const { useAgentTaskStore, refreshConversationProjection } = await setupHydration([]);
    useAgentTaskStore.setState({ conversations: [existingConversation] });
    loadConversationsMockLocal.mockRejectedValueOnce(new Error("backend busy"));

    await expect(refreshConversationProjection()).rejects.toThrow("backend busy");

    expect(useAgentTaskStore.getState().conversations).toEqual([existingConversation]);
    expect(saveConversationMockLocal).not.toHaveBeenCalled();
  });

  it("allows main-window hydration to retry after a failed first read", async () => {
    const recoveredConversation = {
      id: "conv-hydration-recovered",
      title: "Recovered",
      agent: "api-openai",
      projectPath: "/repo",
      status: "done",
      messages: [],
      sessionId: null,
      rawOutput: "",
      createdAt: 1,
      updatedAt: Date.now(),
      mode: "api",
    };
    const { useAgentTaskStore, hydrateConversations } = await setupHydration([]);
    loadConversationsMockLocal.mockReset();
    loadConversationsMockLocal
      .mockRejectedValueOnce(new Error("backend starting"))
      .mockResolvedValueOnce([JSON.stringify(recoveredConversation)]);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    try {
      await hydrateConversations();
      expect(useAgentTaskStore.getState().conversations).toHaveLength(0);

      await hydrateConversations();
      expect(useAgentTaskStore.getState().conversations.map(({ id }) => id)).toEqual([
        recoveredConversation.id,
      ]);
      expect(loadConversationsMockLocal).toHaveBeenCalledTimes(2);
    } finally {
      warn.mockRestore();
    }
  });

  it("skips malformed conversation JSON without throwing", async () => {
    const { useAgentTaskStore, hydrateConversations } = await setupHydration(["{not valid json"]);

    expect(() => hydrateConversations()).not.toThrow();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(useAgentTaskStore.getState().conversations).toHaveLength(0);
  });

  it("canonicalizeAgentCli passes through unknown/unaliased agent ids unchanged", async () => {
    const { canonicalizeAgentCli } = await setupHydration([]);

    expect(canonicalizeAgentCli("api-claude")).toBe("api-claude");
    expect(canonicalizeAgentCli("some-future-provider")).toBe("some-future-provider");
    expect(canonicalizeAgentCli("api-minimax-api")).toBe("api-minimax");
  });

  // ── Retired provider: api-openai-codex (removed 2026-07) ──────────────
  //
  // The ChatGPT-subscription Codex row is gone from the picker, the sidecar
  // registry, and SIDECAR_PROVIDERS. Its persisted conversations must still
  // hydrate, still read, and must NOT be silently remapped onto another
  // vendor's credentials.
  it("hydrates a conversation on the retired api-openai-codex id without crashing", async () => {
    const retiredConversation = {
      id: "conv-retired-codex",
      title: "Codex work",
      agent: "api-openai-codex",
      provider: "openai-codex",
      model: "gpt-5.5",
      projectPath: "/repo",
      status: "idle",
      messages: [
        { id: "m1", role: "user", content: "do the thing", timestamp: 1 },
        { id: "m2", role: "assistant", content: "done", timestamp: 2 },
      ],
      sessionId: "sess-codex",
      rawOutput: "",
      createdAt: 1,
      updatedAt: 2,
      mode: "api",
    };

    const { useAgentTaskStore, hydrateConversations } = await setupHydration([
      JSON.stringify(retiredConversation),
    ]);

    expect(() => hydrateConversations()).not.toThrow();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));

    const conv = useAgentTaskStore
      .getState()
      .conversations.find((c) => c.id === "conv-retired-codex");
    expect(conv).toBeDefined();
    // Transcript intact.
    expect(conv?.messages).toHaveLength(2);
    // Identity preserved verbatim — NOT aliased onto another provider.
    // Aliasing would bill a Codex conversation to a different vendor's key.
    expect(conv?.agent).toBe("api-openai-codex");
    expect(conv?.provider).toBe("openai-codex");
  });

  it("refuses new turns on a retired-provider conversation and says why", async () => {
    const { useAgentTaskStore, hydrateConversations } = await setupHydration([
      JSON.stringify({
        id: "conv-retired-send",
        title: "Codex work",
        agent: "api-openai-codex",
        provider: "openai-codex",
        model: "gpt-5.5",
        projectPath: "/repo",
        status: "idle",
        messages: [{ id: "m1", role: "user", content: "hi", timestamp: 1 }],
        sessionId: "sess-codex",
        rawOutput: "",
        createdAt: 1,
        updatedAt: 2,
        mode: "api",
      }),
    ]);

    hydrateConversations();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));

    // sendMessage on a hydrated conversation normally routes into
    // resumeApiConversation; the retired guard must intercept before any
    // backend call, otherwise this reaches the sidecar and dies as
    // "Unknown provider: openai-codex".
    useAgentTaskStore.getState().sendMessage("conv-retired-send", "another turn");
    await new Promise((resolve) => setTimeout(resolve, 0));

    const conv = useAgentTaskStore
      .getState()
      .conversations.find((c) => c.id === "conv-retired-send");
    const last = conv?.messages[conv.messages.length - 1];
    expect(last?.role).toBe("system");
    expect(last?.content).toMatch(/no longer offers/i);
    expect(last?.content).toMatch(/OpenAI Agents SDK/);
    // The user's turn was refused, not queued or half-sent.
    expect(conv?.messages.some((m) => m.content === "another turn")).toBe(false);
    expect(conv?.status).not.toBe("failed");
  });

  it("substitutes a retired reviewer id for automation, but never a conversation", async () => {
    const { resolveRetiredApiAgent, isRetiredApiAgent } = await import(
      "@/stores/agentTaskStore"
    );

    // Automation (Reviewer Gate) resolves to the replacement so a persisted
    // policy still reviews rather than silently passing the attempt.
    expect(resolveRetiredApiAgent("api-openai-codex")).toBe("api-openai-agents");
    // Everything live passes through untouched.
    expect(resolveRetiredApiAgent("api-claude-oauth")).toBe("api-claude-oauth");
    expect(resolveRetiredApiAgent("api-openai")).toBe("api-openai");

    // The Agent SDK row survives the OAuth removal — it was re-authenticated
    // with the Anthropic API key, not retired. Putting it in the retired set
    // would strand every conversation on it.
    expect(isRetiredApiAgent("api-claude-oauth")).toBe(false);
    expect(isRetiredApiAgent("api-openai-codex")).toBe(true);
  });

  it("routes the Agent SDK row's auth badge to the Anthropic key, not the OAuth probe", async () => {
    const { authProbeProvider, apiAgentProvider } = await import(
      "@/stores/agentTaskStore"
    );

    // Routing target is unchanged — the sidecar registry key is still
    // `claude-oauth`, which is what persisted conversations resume with.
    expect(apiAgentProvider("api-claude-oauth")).toBe("claude-oauth");
    // The BADGE, however, must reflect the credential actually used. The
    // `claude-oauth` probe reads ~/.claude and belongs to the PTY CLI launch
    // gate; the Agents pane must not call it.
    expect(authProbeProvider("api-claude-oauth")).toBe("anthropic");
    // Every other row's badge and routing agree.
    for (const agent of ["api-claude", "api-openai", "api-openai-agents", "api-ollama"]) {
      expect(authProbeProvider(agent)).toBe(apiAgentProvider(agent));
    }
  });

  it("createApiConversation rejects a retired provider id outright", async () => {
    const { useAgentTaskStore } = await setupHydration([]);

    await expect(
      useAgentTaskStore.getState().createApiConversation({
        agent: "api-openai-codex",
        projectPath: "/repo",
        model: "gpt-5.5",
        initialMessage: "go",
        thinkingEnabled: false,
        planMode: false,
        sshTarget: null,
      }),
    ).rejects.toThrow(/no longer offers/i);
  });
});
