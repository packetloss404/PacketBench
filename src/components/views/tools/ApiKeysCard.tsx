import { useState, useEffect } from "react";
import { Key, Check, X, Eye, EyeOff, Trash2 } from "lucide-react";
import { setApiKey, getApiKeyExists, deleteApiKey } from "@/lib/tauri";
import { NAMED_PROVIDERS } from "@/lib/named-providers";
import { useLiveModelStore } from "@/stores/liveModelStore";
import { emit } from "@tauri-apps/api/event";
import { CardHeader } from "./CardHeader";
import { ConfirmDeleteModal } from "@/components/ui/ConfirmDeleteModal";

interface ProviderEntry {
  id: string;
  name: string;
  description: string;
  needsKey: boolean;
  /** Key accepted but not required (LM2 custom endpoint): show the Set Key /
   * Update / Delete controls without ever gating readiness on the key. */
  optionalKey?: boolean;
}

const PROVIDERS: ProviderEntry[] = [
  ...NAMED_PROVIDERS.map((p) => ({ ...p, needsKey: true })),
  { id: "anthropic", name: "Anthropic", description: "Claude Opus, Sonnet, Haiku", needsKey: true },
  { id: "openai", name: "OpenAI", description: "GPT-5.5, GPT-4o, o3", needsKey: true },
  {
    id: "minimax",
    name: "MiniMax (Token Plan)",
    description: "Coding/Token Plan key · M3, M2.5, M2",
    needsKey: true,
  },
  { id: "openrouter", name: "OpenRouter", description: "100+ models, one key", needsKey: true },
  { id: "ollama", name: "Ollama", description: "Local models, no key needed", needsKey: false },
  {
    id: "custom",
    name: "Custom endpoint",
    description: "OpenAI-compatible server · key optional, sent as Bearer when set",
    needsKey: false,
    optionalKey: true,
  },
];

export function ApiKeysCard() {
  const [keyStatus, setKeyStatus] = useState<Record<string, boolean>>({});
  const [editing, setEditing] = useState<string | null>(null);
  const [inputValue, setInputValue] = useState("");
  const [showValue, setShowValue] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<ProviderEntry | null>(null);

  useEffect(() => {
    void loadStatus();
  }, []);

  async function loadStatus() {
    const status: Record<string, boolean> = {};
    for (const p of PROVIDERS) {
      try {
        status[p.id] = await getApiKeyExists(p.id);
      } catch {
        status[p.id] = false;
      }
    }
    setKeyStatus(status);
  }

  async function handleSave(providerId: string) {
    if (!inputValue.trim()) return;
    setSaving(true);
    try {
      setError(null);
      await setApiKey(providerId, inputValue.trim());
      useLiveModelStore.getState().invalidate(providerId);
      void emit("provider-auth:changed", { provider: providerId }).catch(() => {});
      setKeyStatus((s) => ({ ...s, [providerId]: true }));
      setEditing(null);
      setInputValue("");
    } catch (err) {
      setError(String(err));
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete(providerId: string) {
    try {
      setError(null);
      await deleteApiKey(providerId);
      useLiveModelStore.getState().invalidate(providerId);
      void emit("provider-auth:changed", { provider: providerId }).catch(() => {});
      setKeyStatus((s) => ({ ...s, [providerId]: false }));
    } catch (err) {
      setError(String(err));
    }
  }

  return (
    <div className="rounded-lg border border-bg-border bg-bg-secondary p-4">
      <CardHeader
        icon={Key}
        iconColor="text-accent-amber"
        title="API Keys"
        className="mb-4 flex items-center gap-2"
      />

      <p className="mb-4 text-[10px] text-text-muted">
        Configure API keys for each provider. Keys are stored securely in your OS credential store.
      </p>

      {error && (
        <p role="alert" className="mb-2 text-xs text-accent-red">
          {error}
        </p>
      )}
      <div className="flex flex-col gap-2">
        {PROVIDERS.map((provider) => (
          <div
            key={provider.id}
            className="flex items-center gap-3 rounded-lg border border-bg-border bg-bg-primary px-3 py-2.5"
          >
            {/* Status dot */}
            <div
              className={`h-2 w-2 flex-shrink-0 rounded-full ${
                keyStatus[provider.id] ? "bg-accent-green" : "bg-text-muted/30"
              }`}
            />

            {/* Provider info */}
            <div className="min-w-0 flex-1">
              <div className="text-[11px] font-medium text-text-primary">{provider.name}</div>
              <div className="text-[10px] text-text-muted">{provider.description}</div>
            </div>

            {/* Actions */}
            {editing === provider.id ? (
              <div className="flex items-center gap-1.5">
                <div className="relative">
                  <input
                    type={showValue ? "text" : "password"}
                    value={inputValue}
                    onChange={(e) => setInputValue(e.target.value)}
                    placeholder="sk-..."
                    className="w-48 rounded border border-bg-border bg-bg-secondary px-2 py-1 pr-7 text-[11px] text-text-primary placeholder:text-text-muted focus:border-accent-green focus:outline-none"
                    onKeyDown={(e) => {
                      if (e.key === "Enter") void handleSave(provider.id);
                      if (e.key === "Escape") {
                        setEditing(null);
                        setInputValue("");
                      }
                    }}
                    autoFocus
                  />
                  <button
                    onClick={() => setShowValue(!showValue)}
                    className="absolute right-1.5 top-1/2 -translate-y-1/2 text-text-muted hover:text-text-secondary"
                  >
                    {showValue ? <EyeOff size={10} /> : <Eye size={10} />}
                  </button>
                </div>
                <button
                  onClick={() => void handleSave(provider.id)}
                  disabled={saving || !inputValue.trim()}
                  className="rounded p-1 text-accent-green hover:bg-accent-green/10 disabled:opacity-50"
                >
                  <Check size={11} />
                </button>
                <button
                  onClick={() => {
                    setEditing(null);
                    setInputValue("");
                  }}
                  className="p-1 text-text-muted hover:text-text-primary"
                >
                  <X size={11} />
                </button>
              </div>
            ) : provider.needsKey || provider.optionalKey ? (
              <div className="flex items-center gap-1.5">
                <button
                  onClick={() => {
                    setEditing(provider.id);
                    setInputValue("");
                    setShowValue(false);
                  }}
                  className="rounded px-2 py-1 text-[10px] text-accent-green transition-colors hover:bg-accent-green/10"
                >
                  {keyStatus[provider.id] ? "Update" : "Set Key"}
                </button>
                {keyStatus[provider.id] && (
                  <button
                    onClick={() => setPendingDelete(provider)}
                    className="p-1 text-text-muted transition-colors hover:text-accent-red"
                    title={`Delete ${provider.name} API key`}
                    aria-label={`Delete ${provider.name} API key`}
                  >
                    <Trash2 size={10} />
                  </button>
                )}
              </div>
            ) : (
              <span className="text-[10px] text-accent-green">Ready</span>
            )}
          </div>
        ))}
      </div>

      {pendingDelete && (
        <ConfirmDeleteModal
          title="Delete API key?"
          entityName={`${pendingDelete.name} API key`}
          description="is removed from the OS credential store. Sessions using this provider will fail to start until a new key is set."
          onConfirm={() => {
            void handleDelete(pendingDelete.id);
            setPendingDelete(null);
          }}
          onClose={() => setPendingDelete(null)}
        />
      )}
    </div>
  );
}
