import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PersistedState } from "@/lib/tauri";

const mocks = vi.hoisted(() => ({
  detectCliCatalog: vi.fn(),
  loadPersistedState: vi.fn(),
  saveAgentsSlice: vi.fn(),
}));

vi.mock("@/lib/tauri", () => ({
  detectCliCatalog: mocks.detectCliCatalog,
  loadPersistedState: mocks.loadPersistedState,
  saveAgentsSlice: mocks.saveAgentsSlice,
}));

describe("agentStore", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    mocks.saveAgentsSlice.mockResolvedValue(undefined);
  });

  it("hydrates persisted built-in command and default args overrides", async () => {
    const { useAgentStore } = await import("@/stores/agentStore");

    await useAgentStore.getState().hydrateFromBackend({
      agents: [
        {
          id: "codex",
          command: "C:\\tools\\codex-wrapper.cmd",
          defaultArgs: ["--ask-for-approval", "never"],
          installed: true,
          isBuiltin: true,
        },
      ],
    } as unknown as PersistedState);

    const codex = useAgentStore.getState().getAgent("codex");

    expect(codex).toMatchObject({
      command: "C:\\tools\\codex-wrapper.cmd",
      defaultArgs: ["--ask-for-approval", "never"],
      installed: true,
      isBuiltin: true,
    });
  });

  it("keeps custom agents while resetBuiltins restores built-in defaults", async () => {
    const { useAgentStore } = await import("@/stores/agentStore");

    useAgentStore.getState().addAgent({
      id: "custom-echo",
      name: "Echo Agent",
      command: "echo-agent",
      defaultArgs: ["--verbose"],
      description: "Custom test CLI",
      installed: false,
      capabilities: [],
      icon: "TerminalSquare",
      color: "text-text-muted",
      statusPatterns: {
        approval: [],
        thinking: [],
        toolUse: [],
        idle: [],
      },
      isBuiltin: false,
    });
    useAgentStore.getState().updateAgent("codex", {
      command: "C:\\tools\\codex-wrapper.cmd",
      defaultArgs: ["--debug"],
    });

    useAgentStore.getState().resetBuiltins();

    expect(useAgentStore.getState().getAgent("codex")).toMatchObject({
      command: "codex",
      defaultArgs: [],
      isBuiltin: true,
    });
    expect(useAgentStore.getState().getAgent("custom-echo")).toMatchObject({
      command: "echo-agent",
      defaultArgs: ["--verbose"],
      isBuiltin: false,
    });
  });

  it("keeps Amp's preset command after detection finds the executable inside WSL", async () => {
    vi.stubGlobal("navigator", { userAgent: "Windows NT 10.0" });
    try {
      const { useAgentStore } = await import("@/stores/agentStore");
      const amp = useAgentStore.getState().getAgent("amp")!;
      useAgentStore.setState({ agents: [amp] });
      mocks.detectCliCatalog.mockResolvedValue([{ id: "amp", installed: true, path: "/home/dev/.local/bin/amp", version: "1.2.3", source: "wsl" }]);
      await useAgentStore.getState().detectInstalled();
      expect(useAgentStore.getState().getAgent("amp")).toMatchObject({ installed: true, command: "amp" });
    } finally { vi.unstubAllGlobals(); }
  });

  it("resolves PacketCode from its canonical binary instead of a stale persisted command", async () => {
    const { useAgentStore } = await import("@/stores/agentStore");
    const { useCliOverrideStore } = await import("@/stores/cliOverrideStore");
    useCliOverrideStore.setState({ overrides: {} });
    const packetCode = useAgentStore.getState().getAgent("packetcode");
    expect(packetCode).toBeDefined();
    useAgentStore.setState({
      agents: [{ ...packetCode!, command: "C:\\old-portable\\packetcode.exe" }],
    });
    mocks.detectCliCatalog.mockResolvedValue([
      {
        id: "packetcode",
        installed: true,
        version: "packetcode v0.5.1",
        path: "C:\\Users\\ian\\bin\\packetcode.exe",
      },
    ]);

    await useAgentStore.getState().detectInstalled();

    expect(mocks.detectCliCatalog).toHaveBeenCalledWith([
      { id: "packetcode", binary: "packetcode" },
    ]);
    expect(useAgentStore.getState().getAgent("packetcode")?.command).toBe(
      "C:\\Users\\ian\\bin\\packetcode.exe",
    );
  });
});
