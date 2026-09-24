import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentConversation } from "@/types/agent-conversation";

const disk = new Map<string, string>();
const saveMock = vi.fn();
const startMock = vi.fn();
const changeModelMock = vi.fn();
const settingMock = vi.fn();
const budgetMock = vi.fn();
const sendMock = vi.fn();
const retryMock = vi.fn();
const listenerMock = vi.fn();

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn().mockResolvedValue(() => {}),
}));
vi.mock("@/stores/apiAgentListeners", () => ({
  installApiAgentListeners: (...args: unknown[]) => listenerMock(...args),
}));
vi.mock("@/lib/agentsMd", () => ({
  loadAgentsMd: vi.fn().mockResolvedValue(null),
}));
vi.mock("@/stores/costGuardrailStore", () => ({
  assertCostGuardrailsAllowLaunch: (...args: unknown[]) => budgetMock(...args),
}));
vi.mock("@/lib/tauri", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/tauri")>()),
  saveConversation: (...args: unknown[]) => saveMock(...args),
  loadConversations: async () => [...disk.values()],
  readMcpServers: async () => [],
  startApiAgentSession: (...args: unknown[]) => startMock(...args),
  changeAgentModel: (...args: unknown[]) => changeModelMock(...args),
  setPlanMode: (...args: unknown[]) => settingMock(...args),
  setPermissionMode: (...args: unknown[]) => settingMock(...args),
  setApproveWrites: (...args: unknown[]) => settingMock(...args),
  sendApiAgentMessage: (...args: unknown[]) => sendMock(...args),
  retryLastTurn: (...args: unknown[]) => retryMock(...args),
}));

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const launch = {
  agent: "api-ollama" as const,
  projectPath: "D:/projects/acceptance-fixture",
  model: "qwen2.5-coder:7b",
  initialMessage: "Keep this initial prompt through a restart.",
  memoryContextEnabled: false,
};

function saved(id: string): AgentConversation {
  return JSON.parse(disk.get(id)!);
}

async function loadStore() {
  const store = await import("@/stores/agentTaskStore");
  const persistence = await import("@/stores/agentConversationPersistence");
  return { ...store, ...persistence };
}

/** Real store and persistence code, with only IPC/provider boundaries replaced.
 * The JSON map outlives module resets, like conversation files outlive an app. */
describe("API conversation restart recovery", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    vi.doUnmock("@/stores/agentTaskStore");
    localStorage.clear();
    disk.clear();
    saveMock.mockImplementation(async (id: string, json: string) => {
      disk.set(id, json);
    });
    startMock.mockResolvedValue(undefined);
    changeModelMock.mockResolvedValue(undefined);
    settingMock.mockResolvedValue(undefined);
    budgetMock.mockResolvedValue(undefined);
    sendMock.mockResolvedValue(undefined);
    retryMock.mockResolvedValue(undefined);
    listenerMock.mockResolvedValue(() => {});
  });

  afterEach(async () => {
    const { useAgentTaskStore, cancelPendingSave, releaseApiConversationListeners } =
      await loadStore();
    for (const conv of useAgentTaskStore.getState().conversations) {
      cancelPendingSave(conv.id);
      releaseApiConversationListeners(conv.id);
    }
    vi.useRealTimers();
  });

  it("awaits the initial disk write before starting any provider work", async () => {
    const { useAgentTaskStore } = await loadStore();
    const write = deferred();
    saveMock.mockImplementationOnce(async (id: string, json: string) => {
      await write.promise;
      disk.set(id, json);
    });
    const creation = useAgentTaskStore.getState().createApiConversation(launch);
    await vi.waitFor(() => expect(saveMock).toHaveBeenCalledOnce());
    expect(startMock).not.toHaveBeenCalled();
    expect(useAgentTaskStore.getState().conversations).toHaveLength(0);

    write.resolve();
    const id = await creation;
    expect(startMock).toHaveBeenCalledOnce();
    expect(saved(id).messages).toEqual([
      expect.objectContaining({ role: "user", content: launch.initialMessage }),
    ]);
  });

  it("restores the initial prompt when shutdown precedes the first response, without restarting work", async () => {
    const first = await loadStore();
    const provider = deferred();
    startMock.mockReturnValueOnce(provider.promise);
    const creation = first.useAgentTaskStore.getState().createApiConversation(launch);
    await vi.waitFor(() => expect(startMock).toHaveBeenCalledOnce());
    const id = first.useAgentTaskStore.getState().conversations[0].id;
    expect(saved(id).status).toBe("active");
    first.releaseApiConversationListeners(id);
    // End the old invocation without delivering any chunks or a done event.
    provider.resolve();
    await creation;
    vi.resetModules();

    const restarted = await loadStore();
    await restarted.hydrateConversations();
    const restored = restarted.useAgentTaskStore.getState().conversations[0];
    expect(restored.id).toBe(id);
    expect(restored.status).toBe("idle");
    expect(restored.messages).toEqual([
      expect.objectContaining({ role: "user", content: launch.initialMessage, isStreaming: false }),
      expect.objectContaining({ role: "system", content: expect.stringContaining("interrupted") }),
    ]);
    expect(startMock).toHaveBeenCalledOnce();
    await restarted.hydrateConversations();
    expect(restarted.useAgentTaskStore.getState().conversations[0].messages).toHaveLength(2);
  });

  it("rejects a failed initial save without launching a provider or exposing an unsaved conversation", async () => {
    const { useAgentTaskStore } = await loadStore();
    saveMock.mockRejectedValueOnce(new Error("Disk full"));
    await expect(useAgentTaskStore.getState().createApiConversation(launch)).rejects.toThrow(
      "Disk full",
    );
    expect(startMock).not.toHaveBeenCalled();
    expect(useAgentTaskStore.getState().conversations).toHaveLength(0);
    expect(disk.size).toBe(0);
  });

  it("persists a restored model choice and uses it on the next launch after another restart", async () => {
    const first = await loadStore();
    const id = await first.useAgentTaskStore.getState().createApiConversation(launch);
    first.releaseApiConversationListeners(id);
    vi.resetModules();
    const restarted = await loadStore();
    await restarted.hydrateConversations();
    changeModelMock.mockRejectedValue(new Error(`No active session: ${id}`));

    await restarted.useAgentTaskStore.getState().changeModel(id, "qwen3.5:4b");
    expect(changeModelMock).not.toHaveBeenCalled();
    expect(saved(id).model).toBe("qwen3.5:4b");
    expect(restarted.useAgentTaskStore.getState().conversations[0].model).toBe("qwen3.5:4b");
    vi.resetModules();

    const again = await loadStore();
    await again.hydrateConversations();
    again.useAgentTaskStore.getState().sendMessage(id, "Continue with the selected model.");
    await vi.waitFor(() => expect(startMock).toHaveBeenCalledTimes(2));
    expect(startMock.mock.calls[1].slice(0, 5)).toEqual([
      id,
      "ollama",
      "qwen3.5:4b",
      launch.projectPath,
      "Continue with the selected model.",
    ]);
  });

  it("requires live backend acceptance before changing the displayed and saved model", async () => {
    const { useAgentTaskStore } = await loadStore();
    const id = await useAgentTaskStore.getState().createApiConversation(launch);
    // A completed turn retains its live session/listeners.
    useAgentTaskStore.setState((state) => ({
      conversations: state.conversations.map((conv) => ({ ...conv, status: "idle" })),
    }));
    changeModelMock.mockRejectedValueOnce(new Error("Unsupported model"));
    await expect(useAgentTaskStore.getState().changeModel(id, "unsupported")).rejects.toThrow(
      "Unsupported model",
    );
    expect(useAgentTaskStore.getState().conversations[0].model).toBe(launch.model);
    expect(saved(id).model).toBe(launch.model);

    const backend = deferred();
    changeModelMock.mockReturnValueOnce(backend.promise);
    const change = useAgentTaskStore.getState().changeModel(id, "qwen3.5:4b");
    expect(useAgentTaskStore.getState().conversations[0].model).toBe(launch.model);
    backend.resolve();
    await change;
    expect(changeModelMock).toHaveBeenLastCalledWith(id, "qwen3.5:4b");
    expect(saved(id).model).toBe("qwen3.5:4b");
  });

  it("does not let an older pending save undo a restored model choice", async () => {
    const {
      useAgentTaskStore,
      hydrateConversations,
      scheduleSave,
      releaseApiConversationListeners,
    } = await loadStore();
    const id = await useAgentTaskStore.getState().createApiConversation(launch);
    releaseApiConversationListeners(id);
    useAgentTaskStore.setState({ conversations: [] });
    await hydrateConversations();
    vi.useFakeTimers();
    scheduleSave(useAgentTaskStore.getState().conversations[0]);
    await useAgentTaskStore.getState().changeModel(id, "qwen3.5:4b");
    await vi.advanceTimersByTimeAsync(1000);
    expect(saved(id).model).toBe("qwen3.5:4b");
  });

  it("does not label live Monitor projections or completed conversations as interrupted", async () => {
    const { useAgentTaskStore, refreshConversationProjection, hydrateConversations } =
      await loadStore();
    const id = await useAgentTaskStore.getState().createApiConversation(launch);
    await refreshConversationProjection();
    expect(useAgentTaskStore.getState().conversations[0].messages).toHaveLength(1);
    disk.set(id, JSON.stringify({ ...saved(id), status: "idle" }));
    useAgentTaskStore.setState({ conversations: [] });
    await hydrateConversations();
    expect(useAgentTaskStore.getState().conversations[0].messages).toHaveLength(1);
  });

  it("persists restored execution settings without calling a missing backend, but rejects live changes", async () => {
    const first = await loadStore();
    const id = await first.useAgentTaskStore.getState().createApiConversation(launch);
    settingMock.mockRejectedValue(new Error("No active session"));
    await expect(first.useAgentTaskStore.getState().setPlanMode(id, true)).rejects.toThrow("No active session");
    first.releaseApiConversationListeners(id);
    vi.resetModules();
    const restarted = await loadStore();
    await restarted.hydrateConversations();
    settingMock.mockClear();
    await restarted.useAgentTaskStore.getState().setPlanMode(id, true);
    await restarted.useAgentTaskStore.getState().setPermissionMode(id, "deny_all");
    await restarted.useAgentTaskStore.getState().setApproveWrites(id, true);
    expect(settingMock).not.toHaveBeenCalled();
    expect(saved(id)).toMatchObject({ planMode: true, permissionMode: "deny_all", approveWrites: true });
  });

  it("applies the budget gate on both existing turns and restored launches", async () => {
    const first = await loadStore();
    const id = await first.useAgentTaskStore.getState().createApiConversation(launch);
    first.useAgentTaskStore.setState((state) => ({ conversations: state.conversations.map((conv) => ({ ...conv, status: "done" })) }));
    budgetMock.mockRejectedValue(new Error("Session budget reached"));
    first.useAgentTaskStore.getState().sendMessage(id, "Keep this blocked prompt");
    await vi.waitFor(() => expect(first.useAgentTaskStore.getState().conversations[0].status).toBe("failed"));
    expect(sendMock).not.toHaveBeenCalled();
    expect(first.useAgentTaskStore.getState().conversations[0].messages.some((m) => m.content.includes("Session budget reached"))).toBe(true);
    first.releaseApiConversationListeners(id);
    await first.useAgentTaskStore.getState().resumeApiConversation(id, "Resume");
    expect(startMock).toHaveBeenCalledTimes(1);
    expect(first.useAgentTaskStore.getState().conversations[0].status).toBe("failed");
  });

  it.each(["active", "done", "failed"] as const)("preserves %s status in Monitor projections", async (status) => {
    const { useAgentTaskStore, refreshConversationProjection } = await loadStore();
    const id = await useAgentTaskStore.getState().createApiConversation(launch);
    disk.set(id, JSON.stringify({ ...saved(id), status, messages: [{ id: "m", role: "assistant", content: "Live", timestamp: 1, isStreaming: status === "active" }] }));
    await refreshConversationProjection();
    expect(useAgentTaskStore.getState().conversations[0]).toMatchObject({ status, messages: [expect.objectContaining({ isStreaming: status === "active" })] });
  });

  it.each(["send", "resume", "retry"])("Stop revokes a pending %s admission before any provider dispatch", async (kind) => {
    const { useAgentTaskStore, releaseApiConversationListeners } = await loadStore();
    const id = await useAgentTaskStore.getState().createApiConversation(launch);
    useAgentTaskStore.setState((state) => ({ conversations: state.conversations.map((conv) => ({ ...conv, status: "done" })) }));
    const check = deferred();
    budgetMock.mockReturnValueOnce(check.promise);
    if (kind === "resume") releaseApiConversationListeners(id);
    const pending = kind === "retry" ? useAgentTaskStore.getState().retryLastTurn(id)
      : kind === "resume" ? useAgentTaskStore.getState().resumeApiConversation(id, "resume")
      : useAgentTaskStore.getState().sendMessage(id, "send");
    await useAgentTaskStore.getState().cancelActiveConversation(id);
    expect(useAgentTaskStore.getState().conversations[0].status).toBe("idle");
    check.resolve();
    await pending;
    await Promise.resolve();
    expect(startMock).toHaveBeenCalledTimes(1);
    expect(sendMock).not.toHaveBeenCalled();
    expect(retryMock).not.toHaveBeenCalled();
    expect(useAgentTaskStore.getState().conversations[0].messages.some((m) => m.isStreaming)).toBe(false);
  });

  it("a cancelled budget read cannot fail a newer turn when its rejection arrives late", async () => {
    const { useAgentTaskStore } = await loadStore();
    const id = await useAgentTaskStore.getState().createApiConversation(launch);
    useAgentTaskStore.setState((state) => ({ conversations: state.conversations.map((conv) => ({ ...conv, status: "done" })) }));
    let reject!: (error: Error) => void;
    budgetMock.mockReturnValueOnce(new Promise<void>((_resolve, fail) => { reject = fail; }));
    useAgentTaskStore.getState().sendMessage(id, "Old cancelled prompt");
    await useAgentTaskStore.getState().cancelActiveConversation(id);
    useAgentTaskStore.getState().sendMessage(id, "New turn");
    await vi.waitFor(() => expect(sendMock).toHaveBeenCalledOnce());
    reject(new Error("Late budget failure"));
    await Promise.resolve();
    await Promise.resolve();
    expect(useAgentTaskStore.getState().conversations[0].status).toBe("active");
    expect(useAgentTaskStore.getState().conversations[0].messages.some((m) => m.content.includes("Late budget failure"))).toBe(false);
  });

  it.each(["create", "resume"])("Stop during %s listener installation releases the abandoned session and permits resume", async (kind) => {
    const { useAgentTaskStore, releaseApiConversationListeners } = await loadStore();
    let id: string;
    let pending: Promise<unknown>;
    const install = deferred();
    const cleanup = vi.fn();
    if (kind === "resume") {
      id = await useAgentTaskStore.getState().createApiConversation(launch);
      releaseApiConversationListeners(id);
      listenerMock.mockImplementationOnce(async () => { await install.promise; return cleanup; });
      pending = useAgentTaskStore.getState().resumeApiConversation(id, "Resume");
    } else {
      listenerMock.mockImplementationOnce(async () => { await install.promise; return cleanup; });
      pending = useAgentTaskStore.getState().createApiConversation(launch);
      await vi.waitFor(() => expect(useAgentTaskStore.getState().conversations).toHaveLength(1));
      id = useAgentTaskStore.getState().conversations[0].id;
    }
    await vi.waitFor(() => expect(listenerMock).toHaveBeenCalledTimes(kind === "resume" ? 2 : 1));
    const starts = startMock.mock.calls.length;
    await useAgentTaskStore.getState().cancelActiveConversation(id);
    install.resolve();
    await pending;
    expect(startMock).toHaveBeenCalledTimes(starts);
    expect(cleanup).toHaveBeenCalledOnce();
    useAgentTaskStore.getState().sendMessage(id, "User retries explicitly");
    await vi.waitFor(() => expect(startMock).toHaveBeenCalledTimes(starts + 1));
    expect(sendMock).not.toHaveBeenCalled();
  });
});
