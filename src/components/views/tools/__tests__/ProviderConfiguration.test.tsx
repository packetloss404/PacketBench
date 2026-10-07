import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { NAMED_PROVIDERS } from "@/lib/named-providers";

const ipc = vi.hoisted(() => ({
  getProviderBaseUrl: vi.fn(),
  setProviderBaseUrl: vi.fn(),
  listProviderModels: vi.fn(),
}));
vi.mock("@/lib/tauri", async (original) => ({
  ...(await original<typeof import("@/lib/tauri")>()),
  ...ipc,
  getAuxProviderOptions: vi.fn().mockResolvedValue([]),
  getAuxRouteResolutions: vi.fn().mockResolvedValue([]),
  getOllamaBaseUrl: vi.fn().mockResolvedValue("http://localhost:11434"),
  getMinimaxBaseUrl: vi.fn().mockResolvedValue("https://api.minimax.io/v1"),
  getOllamaRuntimeOptions: vi.fn().mockResolvedValue({ numCtxCap: 16384, keepAlive: "30m" }),
  getCustomCompatBaseUrl: vi.fn().mockResolvedValue(null),
  getCustomCompatModels: vi.fn().mockResolvedValue([]),
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn().mockResolvedValue(() => {}) }));

import { ProviderEndpointsCard } from "../ProviderEndpointsCard";
import { ProviderRoutingCard } from "../ProviderRoutingCard";
import { useRoutingStore } from "@/stores/routingStore";
import { resolveLocalAttemptTarget } from "@/lib/attemptRouting";
import { ALL_TASK_TYPES } from "@/types/routing";
import { useLiveModelStore } from "@/stores/liveModelStore";

beforeEach(() => {
  vi.clearAllMocks();
  useLiveModelStore.getState().reset();
  useRoutingStore.setState({
    mappings: ALL_TASK_TYPES.map((taskType) => ({
      taskType,
      agentConfigId: "claude-code",
      model: null,
    })),
    auxMappings: [],
  });
  ipc.getProviderBaseUrl.mockImplementation(
    async (id) => NAMED_PROVIDERS.find((p) => p.id === id)?.baseUrl,
  );
  ipc.setProviderBaseUrl.mockImplementation(async (_id, url) => url);
  ipc.listProviderModels.mockResolvedValue([{ id: "new-release" }]);
});

describe("provider configuration", () => {
  it.each(NAMED_PROVIDERS)(
    "persists a discovered $name model for workflow routing and refreshes after invalidation",
    async ({ id }) => {
      render(<ProviderRoutingCard />);
      fireEvent.change(screen.getByLabelText("Implementation agent"), {
        target: { value: `api-${id}` },
      });
      const row = within(screen.getByRole("group", { name: "Implementation routing" }));
      fireEvent.click(row.getByText("Select model"));
      fireEvent.click(await screen.findByText("new-release"));
      expect(
        useRoutingStore.getState().mappings.find((m) => m.taskType === "implementation"),
      ).toMatchObject({ agentConfigId: `api-${id}`, model: "new-release" });
      expect(resolveLocalAttemptTarget("implementation", "/repo")).toMatchObject({
        provider: id,
        model: "new-release",
      });
      ipc.listProviderModels.mockResolvedValue([{ id: "next-release" }]);
      act(() => useLiveModelStore.getState().invalidate(id));
      fireEvent.click(row.getByText("new-release"));
      await screen.findByText("next-release");
      expect(row.getByText("new-release")).toBeInTheDocument();
    },
  );

  it("saves a local Sugar URL, discards the previous endpoint's models, and refreshes discovery", async () => {
    useLiveModelStore.setState({
      entries: {
        sugar: {
          provider: "sugar",
          status: "ready",
          models: [{ label: "Old", value: "old" }],
          fetchedAt: Date.now(),
        },
      },
    });
    render(<ProviderEndpointsCard />);
    const input = await screen.findByLabelText("Sugar");
    await waitFor(() => expect(input).toHaveValue("https://usesugar.dev/api/v1"));
    fireEvent.change(input, { target: { value: "http://localhost:3211/api/v1" } });
    fireEvent.click(screen.getByTitle("Save Sugar"));
    await waitFor(() =>
      expect(ipc.setProviderBaseUrl).toHaveBeenCalledWith("sugar", "http://localhost:3211/api/v1"),
    );
    await waitFor(() => expect(useLiveModelStore.getState().entries.sugar).toBeUndefined());
    fireEvent.click(screen.getByRole("button", { name: "Refresh Sugar models" }));
    await waitFor(() => expect(ipc.listProviderModels).toHaveBeenCalledWith("sugar"));
    await screen.findByText("(new-release)");
  });

  it("offers discovery for every direct vendor and displays credential failures", async () => {
    ipc.listProviderModels.mockRejectedValue("unauthorized: Replace the stored key");
    render(<ProviderEndpointsCard />);
    for (const name of [
      "Claude (API)",
      "OpenAI (API)",
      "Google Gemini",
      "xAI",
      "ClinePass",
      "OpenCode Go",
      "Ollama Cloud",
    ]) {
      expect(screen.getByRole("button", { name: `Refresh ${name} models` })).toBeInTheDocument();
    }
    fireEvent.click(screen.getByRole("button", { name: "Refresh xAI models" }));
    await screen.findByText("Replace the stored key");
  });
});
