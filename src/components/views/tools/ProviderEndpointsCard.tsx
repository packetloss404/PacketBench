import { useEffect, useState, useMemo, type ReactNode } from "react";
import { Check, RotateCcw, Server } from "lucide-react";
import {
  getProviderBaseUrl,
  setProviderBaseUrl,
  getCustomCompatBaseUrl,
  getCustomCompatModels,
  getMinimaxBaseUrl,
  getOllamaBaseUrl,
  getOllamaRuntimeOptions,
  setCustomCompatBaseUrl,
  setCustomCompatModels,
  setMinimaxBaseUrl,
  setOllamaBaseUrl,
  setOllamaRuntimeOptions,
  type OllamaRuntimeOptions,
} from "@/lib/tauri";

import { NAMED_PROVIDERS } from "@/lib/named-providers";
import { useLiveModelStore } from "@/stores/liveModelStore";
import { ProviderModelsCard } from "./ProviderModelsCard";

type EndpointRowProps = {
  id: string;
  label: string;
  /** The built-in default, shown as a hint and used as the input placeholder. */
  fallback: string;
  load: () => Promise<string>;
  save: (baseUrl: string | null) => Promise<string>;
  /** Rendered under the input to explain what the saved value is used for. */
  describe: (effective: string) => ReactNode;
};

/**
 * One editable provider base URL. Both rows behave identically — load the
 * effective value on mount, save a backend-normalized override, reset back to
 * the built-in default — so the behaviour lives here once rather than being
 * duplicated per provider.
 */
function EndpointRow({ id, label, fallback, load, save, describe }: EndpointRowProps) {
  const [effective, setEffective] = useState(fallback);
  const [draft, setDraft] = useState(fallback);
  const [status, setStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    load()
      .then((url) => {
        if (cancelled) return;
        setEffective(url);
        setDraft(url);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(String(err));
        setStatus("error");
      });
    return () => {
      cancelled = true;
    };
  }, [load]);

  async function apply(next: string | null) {
    setStatus("saving");
    setError(null);
    try {
      const applied = await save(next);
      setEffective(applied);
      setDraft(applied);
      setStatus("saved");
    } catch (err) {
      setStatus("error");
      setError(String(err));
    }
  }

  const hasChanges = draft.trim() !== effective;

  return (
    <div>
      <div className="mb-1 flex items-center justify-between">
        <label htmlFor={id} className="text-[11px] text-text-secondary">
          {label}
        </label>
        <span className="text-[10px] text-text-muted">Default: {fallback}</span>
      </div>
      <div className="flex items-center gap-1.5">
        <input
          id={id}
          type="url"
          value={draft}
          onChange={(e) => {
            setDraft(e.target.value);
            setStatus("idle");
            setError(null);
          }}
          placeholder={fallback}
          className="min-w-0 flex-1 rounded border border-bg-border bg-bg-primary px-2 py-1.5 text-[11px] text-text-primary placeholder:text-text-muted focus:border-accent-green focus:outline-none"
        />
        <button
          type="button"
          onClick={() => void apply(draft.trim())}
          disabled={!hasChanges || status === "saving" || !draft.trim()}
          className="rounded p-1.5 text-accent-green transition-colors hover:bg-accent-green/10 disabled:opacity-40 disabled:hover:bg-transparent"
          title={`Save ${label}`}
        >
          <Check size={12} />
        </button>
        <button
          type="button"
          onClick={() => void apply(null)}
          disabled={status === "saving"}
          className="rounded p-1.5 text-text-muted transition-colors hover:bg-bg-hover hover:text-text-primary disabled:opacity-40"
          title={`Reset ${label}`}
        >
          <RotateCcw size={12} />
        </button>
      </div>
      <div className="mt-1.5 rounded border border-bg-border bg-bg-primary px-3 py-2 text-[10px] text-text-muted">
        {describe(effective)}
      </div>
      {status === "saved" && <div className="mt-1 text-[10px] text-accent-green">Saved.</div>}
      {error && <div className="mt-1 text-[10px] text-accent-red">{error}</div>}
    </div>
  );
}

/**
 * Ollama's two local-runtime knobs. They live here rather than in a generic
 * settings slice because they are meaningless for any other provider: only the
 * native `/api/chat` route can carry them, and getting them wrong is invisible
 * — an under-sized context window makes Ollama drop the oldest messages with
 * no error, which reads as model stupidity rather than misconfiguration.
 */
function OllamaRuntimeRow() {
  const [options, setOptions] = useState<OllamaRuntimeOptions | null>(null);
  const [capDraft, setCapDraft] = useState("");
  const [keepAliveDraft, setKeepAliveDraft] = useState("");
  const [status, setStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [error, setError] = useState<string | null>(null);

  function adopt(next: OllamaRuntimeOptions) {
    setOptions(next);
    setCapDraft(String(next.numCtxCap));
    setKeepAliveDraft(next.keepAlive);
  }

  useEffect(() => {
    let cancelled = false;
    getOllamaRuntimeOptions()
      .then((next) => {
        if (!cancelled) adopt(next);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(String(err));
        setStatus("error");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  async function apply(cap: number | null, keepAlive: string | null) {
    setStatus("saving");
    setError(null);
    try {
      adopt(await setOllamaRuntimeOptions(cap, keepAlive));
      setStatus("saved");
    } catch (err) {
      setStatus("error");
      setError(String(err));
    }
  }

  const parsedCap = Number.parseInt(capDraft, 10);
  const capValid = Number.isFinite(parsedCap) && parsedCap > 0;
  const hasChanges =
    options !== null &&
    (String(options.numCtxCap) !== capDraft.trim() || options.keepAlive !== keepAliveDraft.trim());

  return (
    <div>
      <div className="mb-1 flex items-center justify-between">
        <span className="text-[11px] text-text-secondary">Ollama local runtime</span>
        <span className="text-[10px] text-text-muted">
          Defaults: {options?.defaultNumCtxCap ?? 16384} tokens,{" "}
          {options?.defaultKeepAlive ?? "30m"}
        </span>
      </div>
      <div className="flex items-center gap-1.5">
        <label htmlFor="ollama-num-ctx-cap" className="sr-only">
          Ollama context cap
        </label>
        <input
          id="ollama-num-ctx-cap"
          type="number"
          min={2048}
          step={1024}
          value={capDraft}
          onChange={(e) => {
            setCapDraft(e.target.value);
            setStatus("idle");
            setError(null);
          }}
          placeholder="16384"
          className="min-w-0 flex-1 rounded border border-bg-border bg-bg-primary px-2 py-1.5 text-[11px] text-text-primary placeholder:text-text-muted focus:border-accent-green focus:outline-none"
        />
        <label htmlFor="ollama-keep-alive" className="sr-only">
          Ollama keep-alive
        </label>
        <input
          id="ollama-keep-alive"
          type="text"
          value={keepAliveDraft}
          onChange={(e) => {
            setKeepAliveDraft(e.target.value);
            setStatus("idle");
            setError(null);
          }}
          placeholder="30m"
          className="w-20 shrink-0 rounded border border-bg-border bg-bg-primary px-2 py-1.5 text-[11px] text-text-primary placeholder:text-text-muted focus:border-accent-green focus:outline-none"
        />
        <button
          type="button"
          onClick={() => void apply(parsedCap, keepAliveDraft.trim())}
          disabled={!hasChanges || !capValid || status === "saving" || !keepAliveDraft.trim()}
          className="rounded p-1.5 text-accent-green transition-colors hover:bg-accent-green/10 disabled:opacity-40 disabled:hover:bg-transparent"
          title="Save Ollama runtime options"
        >
          <Check size={12} />
        </button>
        <button
          type="button"
          onClick={() => void apply(null, null)}
          disabled={status === "saving"}
          className="rounded p-1.5 text-text-muted transition-colors hover:bg-bg-hover hover:text-text-primary disabled:opacity-40"
          title="Reset Ollama runtime options"
        >
          <RotateCcw size={12} />
        </button>
      </div>
      <div className="mt-1.5 rounded border border-bg-border bg-bg-primary px-3 py-2 text-[10px] text-text-muted">
        Context cap (tokens) and keep-alive, sent as{" "}
        <span className="text-text-secondary">options.num_ctx</span> and{" "}
        <span className="text-text-secondary">keep_alive</span> on every request. The cap is a
        ceiling — a model with a smaller trained window uses its own. Ollama&apos;s default window
        is 4096 tokens and it drops older messages <em>silently</em> when a prompt exceeds it, so
        too low is worse than too high. Raising the cap costs VRAM (roughly 128 KiB per token on a
        7–8B model).
      </div>
      {status === "saved" && <div className="mt-1 text-[10px] text-accent-green">Saved.</div>}
      {error && <div className="mt-1 text-[10px] text-accent-red">{error}</div>}
    </div>
  );
}

/**
 * LM2 — the custom OpenAI-compatible endpoint (vLLM, LM Studio, LiteLLM,
 * Together, any server speaking `POST {base}/chat/completions`). Unlike the
 * rows above there is NO default URL — unset means the provider is
 * unconfigured — and the URL is stored INCLUDING its `/v1`-style path prefix
 * and used verbatim. The model list is manual: no discovery route works
 * across these servers, so the picker shows exactly what is entered here.
 */
function CustomCompatRow() {
  const [effectiveUrl, setEffectiveUrl] = useState<string | null>(null);
  const [urlDraft, setUrlDraft] = useState("");
  const [modelsDraft, setModelsDraft] = useState("");
  const [savedModels, setSavedModels] = useState<string[]>([]);
  const [status, setStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    Promise.all([getCustomCompatBaseUrl(), getCustomCompatModels()])
      .then(([url, models]) => {
        if (cancelled) return;
        const list = models ?? [];
        setEffectiveUrl(url ?? null);
        setUrlDraft(url ?? "");
        setSavedModels(list);
        setModelsDraft(list.join("\n"));
      })
      .catch((err) => {
        if (cancelled) return;
        setError(String(err));
        setStatus("error");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  async function apply(nextUrl: string | null, nextModels: string[]) {
    setStatus("saving");
    setError(null);
    try {
      const appliedUrl = await setCustomCompatBaseUrl(nextUrl);
      const appliedModels = (await setCustomCompatModels(nextModels)) ?? [];
      setEffectiveUrl(appliedUrl ?? null);
      setUrlDraft(appliedUrl ?? "");
      setSavedModels(appliedModels);
      setModelsDraft(appliedModels.join("\n"));
      setStatus("saved");
    } catch (err) {
      setStatus("error");
      setError(String(err));
    }
  }

  const draftModels = modelsDraft
    .split("\n")
    .map((m) => m.trim())
    .filter(Boolean);
  const hasChanges =
    urlDraft.trim() !== (effectiveUrl ?? "") || draftModels.join("\n") !== savedModels.join("\n");

  return (
    <div>
      <div className="mb-1 flex items-center justify-between">
        <label htmlFor="custom-compat-base-url" className="text-[11px] text-text-secondary">
          Custom OpenAI-compatible
        </label>
        <span className="text-[10px] text-text-muted">No default — unset disables the row</span>
      </div>
      <div className="flex items-center gap-1.5">
        <input
          id="custom-compat-base-url"
          type="url"
          value={urlDraft}
          onChange={(e) => {
            setUrlDraft(e.target.value);
            setStatus("idle");
            setError(null);
          }}
          placeholder="http://localhost:8000/v1"
          className="min-w-0 flex-1 rounded border border-bg-border bg-bg-primary px-2 py-1.5 text-[11px] text-text-primary placeholder:text-text-muted focus:border-accent-green focus:outline-none"
        />
        <button
          type="button"
          onClick={() => void apply(urlDraft.trim() || null, draftModels)}
          disabled={!hasChanges || status === "saving"}
          className="rounded p-1.5 text-accent-green transition-colors hover:bg-accent-green/10 disabled:opacity-40 disabled:hover:bg-transparent"
          title="Save custom endpoint"
        >
          <Check size={12} />
        </button>
        <button
          type="button"
          onClick={() => void apply(null, [])}
          disabled={status === "saving"}
          className="rounded p-1.5 text-text-muted transition-colors hover:bg-bg-hover hover:text-text-primary disabled:opacity-40"
          title="Clear custom endpoint and model list"
        >
          <RotateCcw size={12} />
        </button>
      </div>
      <label htmlFor="custom-compat-models" className="sr-only">
        Custom endpoint model list
      </label>
      <textarea
        id="custom-compat-models"
        value={modelsDraft}
        onChange={(e) => {
          setModelsDraft(e.target.value);
          setStatus("idle");
          setError(null);
        }}
        rows={3}
        placeholder={"Model ids — one per line\nqwen2.5-72b-instruct"}
        className="mt-1.5 w-full resize-none rounded border border-bg-border bg-bg-primary px-2 py-1.5 text-[11px] text-text-primary placeholder:text-text-muted focus:border-accent-green focus:outline-none"
      />
      <div className="mt-1.5 rounded border border-bg-border bg-bg-primary px-3 py-2 text-[10px] text-text-muted">
        Any server speaking the OpenAI chat-completions protocol: vLLM, LM Studio, LiteLLM,
        Together, … The URL is used verbatim as{" "}
        <span className="text-text-secondary">{effectiveUrl ?? "{base}"}/chat/completions</span>, so
        include the <span className="text-text-secondary">/v1</span> prefix if your server uses one.
        API key is optional — save one under <span className="text-text-secondary">custom</span> in
        API Keys and it is sent as a Bearer token; without one, no Authorization header is sent.
        Models are listed manually (one id per line) — the picker offers exactly these.
      </div>
      {status === "saved" && <div className="mt-1 text-[10px] text-accent-green">Saved.</div>}
      {error && <div className="mt-1 text-[10px] text-accent-red">{error}</div>}
    </div>
  );
}

function NamedEndpointRow({ provider }: { provider: (typeof NAMED_PROVIDERS)[number] }) {
  const callbacks = useMemo(
    () => ({
      load: () => getProviderBaseUrl(provider.id),
      save: async (url: string | null) => {
        const saved = await setProviderBaseUrl(provider.id, url);
        useLiveModelStore.getState().invalidate(provider.id);
        return saved;
      },
    }),
    [provider.id],
  );
  return (
    <EndpointRow
      id={`${provider.id}-base-url`}
      label={provider.name}
      fallback={provider.baseUrl}
      {...callbacks}
      describe={() => provider.description}
    />
  );
}

export function ProviderEndpointsCard() {
  return (
    <div className="rounded-lg border border-bg-border bg-bg-secondary p-4">
      <h3 className="mb-3 flex items-center gap-2 text-xs font-semibold text-text-primary">
        <Server size={12} className="text-accent-blue" />
        Provider Endpoints
      </h3>

      <div className="space-y-4">
        <EndpointRow
          id="ollama-base-url"
          label="Ollama base URL"
          fallback="http://localhost:11434"
          load={getOllamaBaseUrl}
          save={setOllamaBaseUrl}
          describe={(url) => (
            <>
              API chat uses the native <span className="text-text-secondary">{url}/api/chat</span>{" "}
              (the only route that accepts num_ctx / keep_alive); model discovery uses{" "}
              <span className="text-text-secondary">{url}/api/tags</span>. Endpoints without{" "}
              <span className="text-text-secondary">/api/chat</span> fall back to{" "}
              <span className="text-text-secondary">{url}/v1</span>, where the context window cannot
              be set.
            </>
          )}
        />

        <OllamaRuntimeRow />

        <EndpointRow
          id="minimax-base-url"
          label="MiniMax base URL"
          fallback="https://api.minimax.io/v1"
          load={getMinimaxBaseUrl}
          save={setMinimaxBaseUrl}
          describe={(url) => (
            <>
              MiniMax chat uses <span className="text-text-secondary">{url}</span>. Mainland-China
              accounts must switch this to{" "}
              <span className="text-text-secondary">https://api.minimaxi.com/v1</span> — a key is
              valid against only one host.
            </>
          )}
        />

        {NAMED_PROVIDERS.map((provider) => (
          <NamedEndpointRow key={provider.id} provider={provider} />
        ))}
        <CustomCompatRow />
        <ProviderModelsCard />
      </div>
    </div>
  );
}
