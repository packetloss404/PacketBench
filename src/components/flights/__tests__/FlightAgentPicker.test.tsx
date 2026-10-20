import { useState } from "react";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentCli } from "@/stores/agentTaskStore";

const fixture = vi.hoisted(() => ({
  auth: {} as Record<string, { status: string; hint?: string }>,
  models: {} as Record<string, { value: string; label: string }[]>,
  ollama: [] as { name: string; supportsTools?: boolean }[],
  ready: vi.fn(),
}));
vi.mock("@/components/agents/hooks/useProviderAuthStatus", () => ({
  useProviderAuthStatus: () => ({ authStatus: fixture.auth, refreshAuthStatuses: vi.fn() }),
}));
vi.mock("@/components/agents/hooks/useLiveModels", () => ({
  useLiveModels: (agent: string) => ({
    answer: { status: "ready", models: fixture.models[agent] ?? [] },
    refresh: vi.fn(),
  }),
}));
vi.mock("@/components/agents/hooks/useOllamaModels", () => ({
  useOllamaModels: () => ({ ollamaModels: fixture.ollama, refresh: vi.fn() }),
}));
vi.mock("@/components/agents/hooks/useCustomModels", () => ({
  useCustomModels: () => ({ customModels: [], refresh: vi.fn() }),
}));
import { FlightAgentPicker } from "@/components/flights/FlightAgentPicker";

function Harness({
  agent: initial,
  model: initialModel = "",
  auto = false,
}: {
  agent: AgentCli;
  model?: string;
  auto?: boolean;
}) {
  const [selection, setSelection] = useState({ agent: initial, model: initialModel });
  return (
    <>
      <FlightAgentPicker
        {...selection}
        autoSelectAgent={auto}
        onChange={(agent, model) => setSelection({ agent, model })}
        onReadinessChange={fixture.ready}
      />
      <output>
        {selection.agent}:{selection.model}
      </output>
    </>
  );
}
beforeEach(() => {
  fixture.auth = {};
  fixture.models = {};
  fixture.ollama = [];
  fixture.ready.mockClear();
});

describe("shared Flight API selection", () => {
  it.each([
    "api-sugar",
    "api-cline-pass",
    "api-opencode-go",
    "api-ollama-cloud",
    "api-google",
    "api-xai",
  ] as AgentCli[])("selects the live model for %s with an empty bundled catalog", async (agent) => {
    fixture.auth[agent] = { status: "ready" };
    fixture.models[agent] = [{ value: "served-model", label: "Served model" }];
    render(<Harness agent={agent} />);
    await screen.findByText(`${agent}:served-model`);
    expect(screen.getByText("Served model")).toBeInTheDocument();
    await waitFor(() => expect(fixture.ready).toHaveBeenLastCalledWith(null));
  });
  it("chooses an authenticated API default without assuming the user's CLI login is an API key", async () => {
    fixture.auth["api-sugar"] = { status: "missing_key", hint: "Add API key" };
    fixture.auth["api-google"] = { status: "ready" };
    fixture.models["api-google"] = [{ value: "gemini-live", label: "Live Gemini" }];
    render(<Harness agent="api-sugar" auto />);
    await screen.findByText("api-google:gemini-live");
    await waitFor(() => expect(fixture.ready).toHaveBeenLastCalledWith(null));
  });
  it("preserves a deliberate provider choice while explaining missing API access", async () => {
    fixture.auth["api-openai"] = { status: "missing_key", hint: "Add an OpenAI API key" };
    fixture.auth["api-google"] = { status: "ready" };
    render(<Harness agent="api-openai" model="my-model" />);
    expect(screen.getByText("api-openai:my-model")).toBeInTheDocument();
    await waitFor(() => expect(fixture.ready).toHaveBeenLastCalledWith("Add an OpenAI API key"));
  });
  it("blocks an installed Ollama model that cannot call tools", async () => {
    fixture.auth["api-ollama"] = { status: "ready" };
    fixture.ollama = [{ name: "no-tools", supportsTools: false }];
    render(<Harness agent="api-ollama" model="no-tools" />);
    await waitFor(() =>
      expect(fixture.ready).toHaveBeenLastCalledWith(
        "Choose an installed model with tool support.",
      ),
    );
  });
  it("keeps the newly selected provider when its model callback fires in the same click", async () => {
    fixture.auth["api-sugar"] = { status: "ready" };
    fixture.auth["api-google"] = { status: "ready" };
    fixture.models["api-google"] = [{ value: "gemini-live", label: "Live Gemini" }];
    render(<Harness agent="api-sugar" model="sugar/conduit" />);
    fireEvent.click(screen.getByRole("button", { name: /Sugar/ }));
    fireEvent.click(screen.getByText("Google Gemini"));
    await screen.findByText("api-google:gemini-live");
  });
});
