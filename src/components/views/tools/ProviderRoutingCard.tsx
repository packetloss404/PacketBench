import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, Route, RotateCcw } from "lucide-react";
import { useRoutingStore } from "@/stores/routingStore";
import { useAgentStore } from "@/stores/agentStore";
import {
  ALL_AUX_TASK_CLASSES,
  ALL_TASK_TYPES,
  AUX_TASK_CLASS_CAVEATS,
  AUX_TASK_CLASS_GROUPS,
  AUX_TASK_CLASS_LABELS,
  TASK_TYPE_LABELS,
} from "@/types/routing";
import type { AuxProviderOption, AuxRouteResolution, AuxTaskClass } from "@/types/routing";
import {
  getAuxProviderOptions,
  getAuxRouteResolutions,
  listOllamaModels,
  type OllamaModel,
} from "@/lib/tauri";
import { logSwallowed } from "@/lib/logSwallowed";
import { getModelsForAgent } from "@/lib/models";
import { API_PROVIDERS } from "@/lib/api-models";
import { liveModelSource, resolveModelRows } from "@/lib/liveModels";
import { useLiveModelStore } from "@/stores/liveModelStore";
import { SUBSCRIPTION_OAUTH_AGENTS } from "@/lib/attemptRouting";
import type { TaskType } from "@/types/flight";
import { APP_NAME } from "@/lib/brand";
import type { AgentCli } from "@/stores/agentTaskStore";
import { ModelSelector } from "@/components/agents/composer/ModelSelector";
import { useOllamaModels } from "@/components/agents/hooks/useOllamaModels";

/**
 * API executors selectable as a workflow-role default.
 *
 * Subscription-OAuth rows are excluded on purpose (WI-1): a user may still pick
 * one by hand in a conversation, but nothing PacketBench routes automatically —
 * including "Draft patch" — may resolve to subscription credentials.
 */
const ROUTABLE_API_PROVIDERS = API_PROVIDERS.filter(
  (p) => !SUBSCRIPTION_OAUTH_AGENTS.has(p.agentCli),
);

/** Reuse conversation discovery, refresh and manual-ID entry for API roles. */
function WorkflowApiModelPicker({
  agent,
  model,
  onChange,
}: {
  agent: AgentCli;
  model: string;
  onChange: (model: string) => void;
}) {
  const { ollamaModels, refresh } = useOllamaModels(agent);
  return (
    <ModelSelector
      selectedAgent={agent}
      selectedModel={model}
      onModelChange={onChange}
      ollamaModels={ollamaModels}
      refreshOllamaModels={refresh}
      requiresTools
    />
  );
}

export function ProviderRoutingCard() {
  const mappings = useRoutingStore((s) => s.mappings);
  const setMapping = useRoutingStore((s) => s.setMapping);
  const resetToDefaults = useRoutingStore((s) => s.resetToDefaults);
  const agents = useAgentStore((s) => s.agents);

  function handleAgentChange(taskType: TaskType, agentConfigId: string) {
    setMapping(taskType, agentConfigId, null); // reset model when switching agent
  }

  function handleModelChange(taskType: TaskType, model: string | null) {
    const mapping = mappings.find((m) => m.taskType === taskType);
    if (mapping) {
      setMapping(taskType, mapping.agentConfigId, model);
    }
  }

  return (
    <div className="col-span-2 rounded-lg border border-bg-border bg-bg-secondary p-4">
      <div className="mb-3 flex items-center justify-between">
        <h3 className="flex items-center gap-2 text-xs font-semibold text-text-primary">
          <Route size={12} className="text-accent-blue" />
          AI Provider Routing
        </h3>
        <button
          onClick={resetToDefaults}
          className="flex items-center gap-1 rounded px-2 py-1 text-[10px] text-text-muted transition-colors hover:bg-bg-hover hover:text-text-primary"
          title="Reset all to defaults"
        >
          <RotateCcw size={10} />
          Reset All
        </button>
      </div>

      <p className="mb-3 text-[10px] text-text-muted">
        Assign a preferred AI agent and model for each workflow role. Tasks auto-fill from these
        defaults, and automatic Flight launches (such as GitHub → Draft patch) use the
        Implementation role. Only API executors can run a Flight attempt.
      </p>

      {/* Header row */}
      <div className="mb-1.5 grid grid-cols-[1fr_1fr_1fr] gap-2 px-3">
        <span className="text-[9px] font-medium uppercase tracking-wider text-text-muted">
          Role
        </span>
        <span className="text-[9px] font-medium uppercase tracking-wider text-text-muted">
          Agent
        </span>
        <span className="text-[9px] font-medium uppercase tracking-wider text-text-muted">
          Model
        </span>
      </div>

      <div className="flex flex-col gap-1.5">
        {ALL_TASK_TYPES.map((taskType) => {
          const mapping = mappings.find((m) => m.taskType === taskType);
          const agentId = mapping?.agentConfigId ?? "claude-code";
          const modelValue = mapping?.model ?? null;
          const apiProvider = ROUTABLE_API_PROVIDERS.find((p) => p.agentCli === agentId);
          const models = getModelsForAgent(agentId);
          const meta = TASK_TYPE_LABELS[taskType];
          const agent = agents.find((a) => a.id === agentId);

          return (
            <div
              key={taskType}
              role="group"
              aria-label={`${meta.label} routing`}
              className="grid grid-cols-[1fr_1fr_1fr] items-center gap-2 rounded border border-bg-border bg-bg-primary px-3 py-2"
            >
              {/* Role label */}
              <div className="min-w-0">
                <div className="text-[11px] font-medium text-text-primary">{meta.label}</div>
                <div className="text-[9px] text-text-muted">{meta.description}</div>
              </div>

              {/* Agent selector */}
              <select
                aria-label={`${meta.label} agent`}
                value={agentId}
                onChange={(e) => handleAgentChange(taskType, e.target.value)}
                className="truncate rounded border border-bg-border bg-bg-elevated px-2 py-1 text-[11px] text-text-primary focus:border-accent-green focus:outline-none"
              >
                <optgroup label="CLI agents">
                  {agents.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.name}
                      {!a.installed ? " (not installed)" : ""}
                    </option>
                  ))}
                </optgroup>
                <optgroup label="API executors">
                  {ROUTABLE_API_PROVIDERS.map((p) => (
                    <option key={p.agentCli} value={p.agentCli}>
                      {p.name}
                    </option>
                  ))}
                </optgroup>
              </select>

              {/* API roles share live discovery and manual entry with conversations. */}
              {apiProvider ? (
                <WorkflowApiModelPicker
                  agent={apiProvider.agentCli}
                  model={modelValue ?? ""}
                  onChange={(model) => handleModelChange(taskType, model)}
                />
              ) : (
                <select
                  value={modelValue ?? ""}
                  onChange={(e) => handleModelChange(taskType, e.target.value || null)}
                  className={`truncate rounded border border-bg-border bg-bg-elevated px-2 py-1 text-[11px] focus:border-accent-green focus:outline-none ${
                    agent && !agent.installed ? "text-text-muted" : "text-text-primary"
                  }`}
                >
                  {models.map((m) => (
                    <option key={m.value ?? "__default"} value={m.value ?? ""}>
                      {m.label}
                    </option>
                  ))}
                </select>
              )}
            </div>
          );
        })}
      </div>

      <AuxRoutingSection />
    </div>
  );
}

/**
 * WI-1 — routing for the auxiliary AI tasks PacketBench runs on the user's
 * behalf (spec import, Code Quality explanations, PR prose).
 *
 * These used to be hardwired to the Claude subscription sidecar with no user
 * choice at all. They now resolve through `core::aux_llm`: whatever is pinned
 * here, else the cheapest provider the user has an API key for. There is no
 * subscription-login option and there is no silent fallback — with no API key
 * configured the features fail with a pointer to Settings → API Keys, which is
 * exactly what the "Resolves to" column shows.
 */
function AuxRoutingSection() {
  const auxMappings = useRoutingStore((s) => s.auxMappings);
  const setAuxMapping = useRoutingStore((s) => s.setAuxMapping);
  const resetAuxToDefaults = useRoutingStore((s) => s.resetAuxToDefaults);

  const [providers, setProviders] = useState<AuxProviderOption[]>([]);
  const [resolutions, setResolutions] = useState<AuxRouteResolution[]>([]);
  const [ollamaModels, setOllamaModels] = useState<OllamaModel[] | null>(null);

  const refreshResolutions = useCallback(() => {
    getAuxRouteResolutions()
      .then(setResolutions)
      .catch(logSwallowed("ProviderRoutingCard.getAuxRouteResolutions"));
  }, []);

  useEffect(() => {
    getAuxProviderOptions()
      .then(setProviders)
      .catch(logSwallowed("ProviderRoutingCard.getAuxProviderOptions"));
  }, []);

  // Fetch the installed Ollama models once any row pins (or could pin)
  // Ollama — the model column offers real installed models, not the static
  // catalog guesses. A dead daemon degrades to a free-text-less empty list;
  // the "Resolves to" column stays the honest signal.
  const anyOllama = auxMappings.some((m) => m.provider === "ollama");
  useEffect(() => {
    if (!anyOllama || ollamaModels !== null) return;
    listOllamaModels()
      .then((models) => setOllamaModels(models ?? []))
      .catch(() => setOllamaModels([]));
  }, [anyOllama, ollamaModels]);

  // Live model lists for the pinned cloud providers, from the shared cache.
  // Subscribing to the whole map (rather than one entry) is deliberate: which
  // providers this card cares about changes as the user pins them.
  const liveEntries = useLiveModelStore((s) => s.entries);
  const ensureFreshModels = useLiveModelStore((s) => s.ensureFresh);
  const ensureModelListener = useLiveModelStore((s) => s.ensureListener);
  const pinnedProviders = auxMappings.map((m) => m.provider ?? "").join(",");
  const missingPinnedProviders = pinnedProviders
    .split(",")
    .filter((provider) => provider && !liveEntries[provider])
    .join(",");
  useEffect(() => {
    ensureModelListener();
    for (const provider of pinnedProviders.split(",")) {
      if (!provider) continue;
      const agent = API_PROVIDERS.find((p) => p.id === provider)?.agentCli;
      if (agent) ensureFreshModels(agent);
    }
  }, [pinnedProviders, missingPinnedProviders, ensureFreshModels, ensureModelListener]);

  // Re-read after every settings change so the resolved route stays honest —
  // the backend, not this component, decides what "Auto" means.
  useEffect(() => {
    refreshResolutions();
  }, [auxMappings, refreshResolutions]);

  function handleProviderChange(taskClass: AuxTaskClass, value: string) {
    // Switching provider clears the pinned model; the backend then uses that
    // provider's cheap-tier default (and, for Ollama, requires an explicit
    // pick — surfaced by the "Resolves to" column until one is made).
    setAuxMapping(taskClass, value === "" ? null : value, null);
  }

  function handleModelChange(taskClass: AuxTaskClass, value: string) {
    const mapping = auxMappings.find((m) => m.taskClass === taskClass);
    if (!mapping?.provider) return;
    setAuxMapping(taskClass, mapping.provider, value === "" ? null : value);
  }

  /** Model choices for a pinned provider. Every provider now lists what it
   * actually serves where it can say so, with the bundled catalog behind it;
   * Ollama keeps its own producer because it also reports install size and a
   * tools template. Aux task classes are tool-less single shots today, so no
   * supportsTools filter is applied — add one per-class if a tool-carrying aux
   * class ever lands.
   *
   * This function used to read `API_PROVIDERS.find(...).models` directly, which
   * was the third of three ad-hoc live/static precedence rules in the codebase
   * (with `ModelSelector` and `LaunchAsyncFlightModal`) and the only one that
   * gave a live list to Ollama alone. All three resolve through
   * `resolveModelRows` now. */
  function modelOptionsFor(provider: string): { value: string; label: string }[] {
    if (provider === "ollama") {
      return (ollamaModels ?? []).map((m) => ({ value: m.name, label: m.name }));
    }
    // Aux mappings are keyed by the catalog's provider id (`anthropic`,
    // `openai`, …); the live seam is keyed by agent, so map across.
    const agent = API_PROVIDERS.find((p) => p.id === provider)?.agentCli;
    if (!agent) return [];
    const liveProvider = liveModelSource(agent)?.provider;
    return resolveModelRows({
      agent,
      live: liveProvider ? liveEntries[liveProvider] : undefined,
    }).rows.map((m) => ({ value: m.value, label: m.label }));
  }

  function describeResolution(taskClass: AuxTaskClass): {
    text: string;
    error: boolean;
  } {
    const resolution = resolutions.find((r) => r.taskClass === taskClass);
    if (!resolution) return { text: "…", error: false };
    if (resolution.error) return { text: resolution.error, error: true };
    return {
      text: `${resolution.provider} · ${resolution.model}`,
      error: false,
    };
  }

  return (
    <div className="mt-5 border-t border-bg-border pt-4">
      <div className="mb-1.5 flex items-center justify-between">
        <h4 className="text-[11px] font-semibold text-text-primary">Auxiliary AI tasks</h4>
        <button
          onClick={resetAuxToDefaults}
          className="flex items-center gap-1 rounded px-2 py-1 text-[10px] text-text-muted transition-colors hover:bg-bg-hover hover:text-text-primary"
          title="Reset every auxiliary task to Auto"
        >
          <RotateCcw size={10} />
          Reset
        </button>
      </div>

      <p className="mb-3 text-[10px] text-text-muted">
        Short generation tasks {APP_NAME} runs for you.{" "}
        <span className="text-text-secondary">Auto</span> picks the cheapest provider you have an
        API key for. No task routed through this table uses a Claude or ChatGPT subscription login —
        a row flagged below is not routed through it yet and says what it does instead.
      </p>

      <div className="mb-1.5 grid grid-cols-[1fr_0.9fr_0.9fr_1.1fr] gap-2 px-3">
        <span className="text-[9px] font-medium uppercase tracking-wider text-text-muted">
          Task
        </span>
        <span className="text-[9px] font-medium uppercase tracking-wider text-text-muted">
          Provider
        </span>
        <span className="text-[9px] font-medium uppercase tracking-wider text-text-muted">
          Model
        </span>
        <span className="text-[9px] font-medium uppercase tracking-wider text-text-muted">
          Resolves to
        </span>
      </div>

      {/* Grouped once the flat list outgrows one screenful; a short list
          reads better ungrouped. */}
      {(ALL_AUX_TASK_CLASSES.length > 8
        ? AUX_TASK_CLASS_GROUPS
        : [{ label: "", classes: ALL_AUX_TASK_CLASSES }]
      ).map((group) => (
        <div key={group.label || "all"} className="mb-2 last:mb-0">
          {group.label && (
            <h5 className="mb-1 mt-2.5 px-1 text-[9px] font-semibold uppercase tracking-wider text-text-muted">
              {group.label}
            </h5>
          )}
          <div className="flex flex-col gap-1.5">
            {group.classes.map((taskClass) => {
              const mapping = auxMappings.find((m) => m.taskClass === taskClass);
              const meta = AUX_TASK_CLASS_LABELS[taskClass];
              const resolved = describeResolution(taskClass);
              const caveat = AUX_TASK_CLASS_CAVEATS[taskClass];
              const pinnedProvider = mapping?.provider ?? null;
              const models = pinnedProvider ? modelOptionsFor(pinnedProvider) : [];
              const requiresModel =
                pinnedProvider === "ollama" ||
                providers.some((p) => p.provider === pinnedProvider && !p.defaultModel);

              return (
                <div
                  key={taskClass}
                  className="grid grid-cols-[1fr_0.9fr_0.9fr_1.1fr] items-center gap-2 rounded border border-bg-border bg-bg-primary px-3 py-2"
                >
                  <div className="min-w-0">
                    <div className="text-[11px] font-medium text-text-primary">{meta.label}</div>
                    <div className="text-[9px] text-text-muted">{meta.description}</div>
                    {caveat && (
                      <div className="mt-0.5 flex items-start gap-1 text-[9px] text-accent-amber">
                        <AlertTriangle size={9} className="mt-px shrink-0" />
                        <span>{caveat}</span>
                      </div>
                    )}
                  </div>

                  <select
                    aria-label={`${meta.label} provider`}
                    value={pinnedProvider ?? ""}
                    onChange={(e) => handleProviderChange(taskClass, e.target.value)}
                    className="truncate rounded border border-bg-border bg-bg-elevated px-2 py-1 text-[11px] text-text-primary focus:border-accent-green focus:outline-none"
                  >
                    <option value="">Auto (cheapest configured)</option>
                    {providers.map((p) => (
                      <option key={p.provider} value={p.provider}>
                        {p.provider}
                        {p.configured ? "" : " (no key)"}
                      </option>
                    ))}
                  </select>

                  {/* Model pin. Empty = provider default — except Ollama,
                      where the backend refuses a model-less pin and this
                      select is the fix-it affordance. */}
                  <select
                    aria-label={`${meta.label} model`}
                    value={mapping?.model ?? ""}
                    onChange={(e) => handleModelChange(taskClass, e.target.value)}
                    disabled={!pinnedProvider}
                    className={`truncate rounded border bg-bg-elevated px-2 py-1 text-[11px] focus:border-accent-green focus:outline-none disabled:opacity-40 ${
                      requiresModel && !mapping?.model
                        ? "border-accent-red/60 text-accent-red"
                        : "border-bg-border text-text-primary"
                    }`}
                  >
                    <option value="">
                      {!pinnedProvider ? "—" : requiresModel ? "Pick a model…" : "Provider default"}
                    </option>
                    {models.map((m) => (
                      <option key={m.value} value={m.value}>
                        {m.label}
                      </option>
                    ))}
                  </select>

                  <div
                    className={`flex min-w-0 items-start gap-1 text-[10px] ${
                      resolved.error ? "text-accent-red" : "text-text-secondary"
                    }`}
                  >
                    {resolved.error && <AlertTriangle size={10} className="mt-0.5 shrink-0" />}
                    <span className="break-words">{resolved.text}</span>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}
