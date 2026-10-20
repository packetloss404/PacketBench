import { useEffect, useRef } from "react";
import { API_PROVIDERS } from "@/lib/api-models";
import { resolveModelRows } from "@/lib/liveModels";
import type { AgentCli } from "@/stores/agentTaskStore";
import { ProviderPicker } from "@/components/agents/composer/ProviderPicker";
import { ModelSelector } from "@/components/agents/composer/ModelSelector";
import { useProviderAuthStatus } from "@/components/agents/hooks/useProviderAuthStatus";
import { useLiveModels } from "@/components/agents/hooks/useLiveModels";
import { useOllamaModels } from "@/components/agents/hooks/useOllamaModels";
import { useCustomModels } from "@/components/agents/hooks/useCustomModels";

interface Props {
  agent: AgentCli;
  model: string;
  onChange: (agent: AgentCli, model: string) => void;
  onReadinessChange?: (error: string | null) => void;
  autoSelectAgent?: boolean;
  label?: string;
}

/** Same auth probes, catalogs and model control as the normal Agents surface. */
export function FlightAgentPicker({
  agent,
  model,
  onChange,
  onReadinessChange,
  autoSelectAgent = false,
  label = "Execution agent",
}: Props) {
  const { authStatus, refreshAuthStatuses } = useProviderAuthStatus();
  const { answer } = useLiveModels(agent);
  const { ollamaModels, refresh } = useOllamaModels(agent);
  const { customModels } = useCustomModels(agent);
  const userSelected = useRef(!autoSelectAgent);
  const selectedAgent = useRef(agent);
  selectedAgent.current = agent;
  const callbacks = useRef({ onChange, onReadinessChange });
  callbacks.current = { onChange, onReadinessChange };
  const auth = authStatus[agent];
  const resolution = resolveModelRows({ agent, live: answer });
  const rows =
    agent === "api-ollama" && Array.isArray(ollamaModels)
      ? ollamaModels
          .filter((item) => item.supportsTools !== false)
          .map((item) => ({ value: item.name, label: item.name }))
      : agent === "api-custom" && Array.isArray(customModels)
        ? customModels.map((value) => ({ value, label: value }))
        : resolution.rows;
  const firstModel = rows[0]?.value;
  let error: string | null = null;
  if (!auth || auth === "loading") error = "Checking API access…";
  else if (auth.status !== "ready")
    error = auth.hint || "Configure API access in Settings, then refresh.";
  else if (!model.trim()) error = "Choose a model or enter its model ID.";
  else if (agent === "api-ollama") {
    if (!Array.isArray(ollamaModels))
      error = ollamaModels === "loading" ? "Loading installed models…" : ollamaModels.error;
    else if (!ollamaModels.some((item) => item.name === model && item.supportsTools !== false))
      error = "Choose an installed model with tool support.";
  }

  useEffect(() => {
    if (userSelected.current || (auth && auth !== "loading" && auth.status === "ready")) return;
    const ready = API_PROVIDERS.find((provider) => {
      const entry = authStatus[provider.agentCli];
      return entry && entry !== "loading" && entry.status === "ready";
    });
    if (ready && ready.agentCli !== agent) callbacks.current.onChange(ready.agentCli, "");
  }, [agent, auth, authStatus]);
  useEffect(() => {
    if (!model && firstModel) callbacks.current.onChange(agent, firstModel);
  }, [agent, firstModel, model]);
  useEffect(() => {
    callbacks.current.onReadinessChange?.(error);
  }, [agent, model, error]);

  return (
    <div role="group" aria-label={label} className="min-w-0 space-y-1.5">
      <div className="text-[10px] font-medium text-text-secondary">{label} · API usage</div>
      <div className="flex flex-wrap items-center gap-2 rounded border border-bg-border bg-bg-primary px-2 py-2 text-xs">
        <ProviderPicker
          selectedAgent={agent}
          onAgentChange={(value) => {
            userSelected.current = true;
            selectedAgent.current = value;
            callbacks.current.onChange(value, "");
          }}
          onModelChange={(value) => callbacks.current.onChange(selectedAgent.current, value)}
          authStatus={authStatus}
          refreshAuthStatuses={refreshAuthStatuses}
        />
        <ModelSelector
          selectedAgent={agent}
          selectedModel={model}
          onModelChange={(value) => callbacks.current.onChange(agent, value)}
          ollamaModels={ollamaModels}
          refreshOllamaModels={refresh}
          requiresTools
        />
      </div>
      {error && (
        <p role="status" className="text-[10px] text-accent-amber">
          {error}
        </p>
      )}
    </div>
  );
}
