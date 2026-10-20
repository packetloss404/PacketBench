import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentCli } from "@/stores/agentTaskStore";

const agentState = vi.hoisted(() => ({
  selectedRepo: "D:\\projects\\PacketBench" as string | null,
  selectedConversationId: null as string | null,
  selectConversation: vi.fn(),
}));
const launchConversation = vi.hoisted(() => vi.fn((_params: unknown) => true));
const setComposerMode = vi.hoisted(() => vi.fn());

vi.mock("@/stores/agentTaskStore", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/stores/agentTaskStore")>()),
  apiAgentProvider: (agent: AgentCli) => agent,
  useAgentTaskStore: (selector: (state: typeof agentState) => unknown) => selector(agentState),
}));

vi.mock("@/stores/agentSettingsStore", () => ({
  useAgentSettingsStore: (
    selector: (state: {
      composerMode: "local";
      setComposerMode: typeof setComposerMode;
    }) => unknown,
  ) => selector({ composerMode: "local", setComposerMode }),
}));

vi.mock("@/stores/profileStore", () => ({
  useProfileStore: (
    selector: (state: { defaultProfileId: string; getProfile: () => undefined }) => unknown,
  ) => selector({ defaultProfileId: "default", getProfile: () => undefined }),
}));

vi.mock("@/lib/launchConversation", () => ({
  launchConversation: (params: unknown) => launchConversation(params),
}));

vi.mock("@/lib/tauri", () => ({
  getProviderAuthStatus: vi.fn().mockResolvedValue({ status: "login_required" }),
}));

vi.mock("@/components/agents/AgentSidebar", () => ({
  AgentSidebar: ({ onNewAgent }: { onNewAgent: () => void }) => (
    <button onClick={onNewAgent}>Sidebar new agent</button>
  ),
}));

vi.mock("@/components/agents/AgentChatPane", () => ({
  AgentChatPane: ({ conversationId }: { conversationId: string }) => (
    <div data-testid="agent-chat">{conversationId}</div>
  ),
}));

vi.mock("@/components/agents/AgentInspectorPane", () => ({
  AgentInspectorPane: ({ conversationId }: { conversationId: string }) => (
    <div data-testid="agent-inspector">{conversationId}</div>
  ),
}));

vi.mock("@/components/agents/AgentsOnboarding", () => ({
  AgentsOnboarding: () => null,
}));

vi.mock("@/components/agents/composer/Composer", () => ({
  Composer: ({ onLaunch }: { onLaunch: (text: string, attachments: []) => boolean }) => (
    <button onClick={() => onLaunch("Build the feature", [])}>Launch agent</button>
  ),
}));

import { AgentsView } from "@/components/views/AgentsView";
import { getProviderAuthStatus } from "@/lib/tauri";
import { getDefaultModel } from "@/lib/api-models";

describe("AgentsView", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getProviderAuthStatus).mockResolvedValue({ status: "login_required", hint: "" });
    agentState.selectedRepo = "D:\\projects\\PacketBench";
    agentState.selectedConversationId = null;
  });

  it("renders the same-window launcher when no conversation is selected", () => {
    render(<AgentsView />);

    expect(screen.getByText("New agent")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Launch agent" })).toBeInTheDocument();
  });

  it("launches headlessly without a Workspace-placement callback", () => {
    render(<AgentsView />);

    fireEvent.click(screen.getByRole("button", { name: "Launch agent" }));

    expect(launchConversation).toHaveBeenCalledTimes(1);
    const params = launchConversation.mock.calls[0][0] as Record<string, unknown>;
    expect(params).toMatchObject({
      rawText: "Build the feature",
      selectedRepo: "D:\\projects\\PacketBench",
    });
    expect(params).not.toHaveProperty("onLaunched");
    expect(params.onCreated).toEqual(expect.any(Function));
  });

  it("prefers Sugar over other connected providers and launches Conduit", async () => {
    vi.mocked(getProviderAuthStatus).mockResolvedValue({ status: "ready", hint: "" });
    await act(async () => {
      render(<AgentsView />);
    });
    fireEvent.click(screen.getByRole("button", { name: "Launch agent" }));
    expect(launchConversation.mock.calls[0][0]).toMatchObject({
      selectedAgent: "api-sugar",
      selectedModel: "sugar/conduit",
    });
  });

  it("falls back to another connected provider with that provider's model", async () => {
    vi.mocked(getProviderAuthStatus).mockImplementation(async (provider) => ({
      status: provider === "openai" ? "ready" : "missing_key",
      hint: "",
    }));
    await act(async () => {
      render(<AgentsView />);
    });
    fireEvent.click(screen.getByRole("button", { name: "Launch agent" }));
    expect(launchConversation.mock.lastCall?.[0]).toMatchObject({
      selectedAgent: "api-openai",
      selectedModel: getDefaultModel("api-openai"),
    });
  });

  it("respects an explicitly pinned provider and model", () => {
    render(<AgentsView pinnedAgent="api-ollama" pinnedModel="qwen3.5:4b" />);
    fireEvent.click(screen.getByRole("button", { name: "Launch agent" }));
    expect(launchConversation.mock.calls[0][0]).toMatchObject({
      selectedAgent: "api-ollama",
      selectedModel: "qwen3.5:4b",
    });
    expect(getProviderAuthStatus).not.toHaveBeenCalled();
  });

  it("keeps a failed launch alert visible instead of auto-dismissing", () => {
    vi.useFakeTimers();
    try {
      launchConversation.mockImplementationOnce((params: unknown) => {
        (params as { setLaunchError: (message: string) => void }).setLaunchError(
          "Worktree provisioning failed — nothing was launched.",
        );
        return false;
      });

      render(<AgentsView />);
      fireEvent.click(screen.getByRole("button", { name: "Launch agent" }));

      expect(screen.getByRole("alert")).toHaveTextContent("nothing was launched");
      act(() => {
        vi.advanceTimersByTime(10_000);
      });
      expect(screen.getByRole("alert")).toHaveTextContent("nothing was launched");
    } finally {
      vi.useRealTimers();
    }
  });

  it("renders the selected conversation and inspector in the main window", () => {
    agentState.selectedConversationId = "conv-1";

    render(<AgentsView />);

    expect(screen.getByTestId("agent-chat")).toHaveTextContent("conv-1");
    expect(screen.getByTestId("agent-inspector")).toHaveTextContent("conv-1");
    expect(screen.queryByRole("button", { name: "Launch agent" })).toBeNull();
  });
});
