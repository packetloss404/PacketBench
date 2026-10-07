import { RefreshCw } from "lucide-react";
import { API_PROVIDERS } from "@/lib/api-models";
import { liveModelSource } from "@/lib/liveModels";
import { useLiveModelStore } from "@/stores/liveModelStore";

const providers = API_PROVIDERS.filter((p) => {
  const source = liveModelSource(p.agentCli);
  return source?.producer === "ipc" && source.provider === p.id;
});

export function ProviderModelsCard() {
  const entries = useLiveModelStore((s) => s.entries);
  const refresh = useLiveModelStore((s) => s.ensureFresh);
  return (
    <div className="space-y-2">
      <h4 className="text-xs font-medium text-text-primary">Current models</h4>
      <p className="text-[11px] text-text-muted">
        Model pickers refresh on use. Refresh here after changing a key or subscription. A catalog
        listing does not confirm your plan includes every model.
      </p>
      {providers.map((provider) => {
        const answer = entries[provider.id];
        const loading = answer?.status === "loading";
        return (
          <div key={provider.id} className="rounded border border-bg-border p-2">
            <div className="flex items-center justify-between gap-2">
              <span className="text-[11px] text-text-secondary">{provider.name}</span>
              <button
                type="button"
                disabled={loading}
                onClick={() => refresh(provider.agentCli, { force: true })}
                className="flex items-center gap-1 text-[11px] text-accent-green disabled:opacity-40"
                aria-label={`Refresh ${provider.name} models`}
              >
                <RefreshCw size={11} className={loading ? "animate-spin" : ""} />
                {loading ? "Refreshing…" : "Refresh models"}
              </button>
            </div>
            {answer?.error && (
              <p role="status" className="mt-1 text-[11px] text-accent-amber">
                {answer.error}
              </p>
            )}
            {answer?.status === "ready" && (
              <details className="mt-1 text-[11px] text-text-muted">
                <summary>
                  {(answer.models ?? []).length} models ·{" "}
                  {new Date(answer.fetchedAt ?? Date.now()).toLocaleTimeString()}
                </summary>
                <ul className="mt-1 max-h-40 overflow-auto">
                  {(answer.models ?? []).map((m) => (
                    <li key={m.value}>
                      {m.label} <span className="text-text-muted">({m.value})</span>
                    </li>
                  ))}
                </ul>
              </details>
            )}
          </div>
        );
      })}
    </div>
  );
}
