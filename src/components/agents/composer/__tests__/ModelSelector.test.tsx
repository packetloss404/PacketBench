/**
 * ModelSelector — capability first, catalog second.
 *
 * The picker used to key entirely off `API_PROVIDERS.find(p => p.agentCli ===
 * selectedAgent)` and render NOTHING when that lookup missed, which meant a
 * session's real choices (carried on `caps.models`) were ignored in favour of
 * the shipped catalog. These assertions pin both halves: an authoritative list
 * wins when there is one, and every caller that passes no `models` at all
 * behaves exactly as it did before.
 */
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ModelSelector } from "@/components/agents/composer/ModelSelector";
import { API_PROVIDERS, type ApiModel } from "@/lib/api-models";
import type { AgentCli } from "@/stores/agentTaskStore";

function renderSelector(
  over: {
    selectedAgent?: AgentCli;
    selectedModel?: string;
    models?: ApiModel[];
    modelsAreAuthoritative?: boolean;
  } = {},
) {
  const onModelChange = vi.fn();
  render(
    <ModelSelector
      dropUp
      selectedAgent={over.selectedAgent ?? ("api-claude" as AgentCli)}
      selectedModel={over.selectedModel ?? ""}
      onModelChange={onModelChange}
      models={over.models}
      modelsAreAuthoritative={over.modelsAreAuthoritative}
      ollamaModels={[]}
      refreshOllamaModels={vi.fn()}
    />,
  );
  return { onModelChange };
}

/** Open the drop-up and read the option rows. */
function openOptions(): string[] {
  fireEvent.click(screen.getByRole("button", { expanded: false }));
  return screen.getAllByRole("option").map((o) => o.textContent ?? "");
}

const catalogFor = (agent: string): ApiModel[] =>
  API_PROVIDERS.find((p) => p.agentCli === agent)?.models ?? [];

describe("ModelSelector — authoritative models vs the seeded catalog", () => {
  it("does not pretend the first live model is selected", () => {
    renderSelector({ selectedAgent: "api-google", models: [{ label: "Latest Gemini", value: "gemini-latest" }], modelsAreAuthoritative: true });
    expect(screen.getByText("Select model")).toBeTruthy();
    expect(screen.queryByText("Latest Gemini")).toBeNull();
  });

  it("keeps a pinned model visible after it disappears from discovery", () => {
    renderSelector({ selectedAgent: "api-sugar", selectedModel: "sugar/pinned", models: [{ label: "Conduit", value: "sugar/conduit" }], modelsAreAuthoritative: true });
    expect(screen.getByText("sugar/pinned")).toBeTruthy();
  });

  it("offers the authoritative list, not the catalog seed, when caps supplies one", () => {
    const liveRows: ApiModel[] = [
      { label: "glm-4.7", value: "glm-4.7" },
      { label: "kimi-k2.5", value: "kimi-k2.5" },
    ];
    renderSelector({ selectedModel: "glm-4.7", models: liveRows });

    const options = openOptions();
    expect(options).toHaveLength(2);
    expect(options[0]).toContain("glm-4.7");
    expect(options[1]).toContain("kimi-k2.5");
    // The shipped catalog rows must not leak in alongside them.
    const seeded = catalogFor("api-claude").map((m) => m.label);
    expect(options.some((option) => seeded.some((label) => option.includes(label)))).toBe(
      false,
    );
  });

  it("labels the trigger from the authoritative list", () => {
    renderSelector({
      selectedModel: "kimi-k2.5",
      models: [
        { label: "glm-4.7", value: "glm-4.7" },
        { label: "kimi-k2.5", value: "kimi-k2.5" },
      ],
    });
    expect(screen.getByText("kimi-k2.5")).toBeTruthy();
  });

  it("selects an authoritative model by its own id", () => {
    const { onModelChange } = renderSelector({
      models: [{ label: "glm-4.7", value: "glm-4.7" }],
    });
    openOptions();
    fireEvent.click(screen.getByRole("option", { name: /glm-4\.7/ }));
    expect(onModelChange).toHaveBeenCalledWith("glm-4.7");
  });

  it("falls back to the catalog when caps carries nothing", () => {
    // `undefined` is "never asked / the ask failed" — the catalog answer.
    renderSelector({ selectedAgent: "api-claude" as AgentCli });
    const options = openOptions();
    const catalog = catalogFor("api-claude");
    expect(catalog.length).toBeGreaterThan(0);
    expect(options).toHaveLength(catalog.length);
    for (const model of catalog) {
      expect(options.some((o) => o.includes(model.label))).toBe(true);
    }
  });

  it("falls back to the catalog for a NON-AUTHORITATIVE empty caps list", () => {
    // The `[]` ruling, half one. An empty list that is not flagged
    // authoritative is "nothing has answered yet" — the catalog stands, and a
    // fetch that never landed cannot empty the picker.
    renderSelector({ selectedAgent: "api-claude" as AgentCli, models: [] });
    expect(openOptions()).toHaveLength(catalogFor("api-claude").length);
  });

  it("lets an AUTHORITATIVE empty caps list override the catalog", () => {
    // The `[]` ruling, half two — and the disagreement this seam settled. This
    // component used to read every `[]` as "use the catalog" while
    // `agentCapabilities.ts` read it as "serves none"; the two are opposite
    // answers to the same array, so the distinction now lives in a flag rather
    // than in the length. A backend that was ASKED and named nothing must not
    // have bundled ids it may refuse offered on its behalf.
    renderSelector({
      selectedAgent: "api-claude" as AgentCli,
      models: [],
      modelsAreAuthoritative: true,
    });
    fireEvent.click(screen.getByRole("button", { expanded: false }));
    expect(screen.queryAllByRole("option")).toHaveLength(0);
    // Crucially NOT unmounted: an empty list is a state the user can act on.
    expect(screen.getByRole("listbox")).toBeTruthy();
  });

  it("always offers the typed id, so enumeration is a convenience not a gate", () => {
    // A model published this morning is in no catalog — bundled or live — and
    // without this row the picker would be the only way to change model and
    // would silently refuse to name it.
    const { onModelChange } = renderSelector({ selectedAgent: "api-claude" as AgentCli });
    fireEvent.click(screen.getByRole("button", { expanded: false }));
    fireEvent.change(screen.getByPlaceholderText("Search models…"), {
      target: { value: "claude-opus-9-preview" },
    });
    fireEvent.click(screen.getByText(/Use .claude-opus-9-preview./));
    // Case preserved — a lower-cased matching needle would not round-trip an
    // id like `MiniMax-M3`.
    expect(onModelChange).toHaveBeenCalledWith("claude-opus-9-preview");
  });

  it("renders nothing when neither caps nor the catalog has a row", () => {
    const { container } = render(
      <ModelSelector
        dropUp
        selectedAgent={"pty-nonesuch" as AgentCli}
        selectedModel=""
        onModelChange={vi.fn()}
        ollamaModels={[]}
        refreshOllamaModels={vi.fn()}
      />,
    );
    expect(container.firstChild).toBeNull();
  });

  it("leaves Ollama on its live daemon probe, ignoring caps.models", () => {
    render(
      <ModelSelector
        dropUp
        selectedAgent={"api-ollama" as AgentCli}
        selectedModel="llama3.2"
        onModelChange={vi.fn()}
        // A caps list must not displace the installed-model probe.
        models={[{ label: "not-installed", value: "not-installed" }]}
        ollamaModels={[{ name: "llama3.2", size: 2_000_000_000, modified_at: "2026-01-01" }]}
        refreshOllamaModels={vi.fn()}
      />,
    );
    const options = openOptions();
    expect(options).toHaveLength(1);
    expect(options[0]).toContain("llama3.2");
  });
});
