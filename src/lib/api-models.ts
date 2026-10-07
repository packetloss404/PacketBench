import { NAMED_PROVIDERS } from "@/lib/named-providers";
import type { AgentCli } from "@/stores/agentTaskStore";
import { getModelContextWindow } from "@/lib/modelContext";
import { getModelRates } from "@/lib/conversationCost";

export interface ApiModel {
  label: string;
  value: string;
  /**
   * Total context-window size in tokens. Sourced from the shared
   * `getModelContextWindow` helper (see modelContext.ts) — not duplicated —
   * and populated for every known model below.
   */
  contextWindow?: number;
  /**
   * USD price per 1M tokens (input / output). Sourced from
   * conversationCost.ts's `getModelRates`, which reads the ONE pricing table
   * (`shared/model-pricing.json`, shared with the Rust engine) — not
   * duplicated here.
   */
  pricing?: { input: number; output: number };
}

export interface ApiProviderInfo {
  id: string;
  agentCli: AgentCli;
  name: string;
  models: ApiModel[];
  needsKey: boolean;
  /**
   * P1-S4: whether this provider's adapter can honor a per-tool approval
   * round-trip. Undefined is treated as `true` (approval-capable). When
   * `false`, the mode pickers filter to only the postures the adapter can
   * actually enforce (see `agentModeChipUtils.modesForApprovals`).
   *
   * No catalog row sets this today. It was introduced for the OpenAI Codex
   * `exec` adapter, which mapped EVERY PermissionMode to a sandbox+`never`
   * tuple because its stdin was closed; that row was removed in 2026-07. The
   * flag and its plumbing are kept because "this adapter cannot pause for
   * approval" is a real property a future adapter may have, and discovering
   * it again the hard way is worse than carrying an unused boolean.
   */
  supportsApprovals?: boolean;
}

export const API_PROVIDERS: ApiProviderInfo[] = [
  ...NAMED_PROVIDERS.map((p) => ({
    id: p.id,
    agentCli: `api-${p.id}` as AgentCli,
    name: p.name,
    needsKey: true,
    models: [],
  })),
  {
    // Historical id — the row is the Claude Agent SDK, which since 2026-07
    // authenticates with the `api-key-anthropic` keyring entry instead of a
    // Claude.ai subscription login. Anthropic's legal-and-compliance page
    // directs Agent SDK developers to "use the API key authentication
    // methods described in the Quickstart instead", so the SDK — and the
    // capabilities only it provides (targeted edit tool, structured plan
    // blocks, real permission modes, MCP, Claude Code settings sourcing) —
    // stays; only the credential changed. The ids are unchanged because
    // persisted conversations store `api-claude-oauth` / `claude-oauth` and
    // resume with them verbatim.
    id: "anthropic-oauth",
    agentCli: "api-claude-oauth",
    name: "Claude Agent SDK (API)",
    needsKey: true,
    // Ids are the exact published strings, never date-suffixed — Anthropic's
    // current ids are complete as written, and appending a snapshot date
    // produces a model that does not exist. `models[0]` is the row's default
    // for NEW conversations; persisted ones keep whatever id they stored.
    models: [
      { label: "Claude Opus 5", value: "claude-opus-5" },
      { label: "Claude Sonnet 5", value: "claude-sonnet-5" },
      { label: "Claude Opus 4.8", value: "claude-opus-4-8" },
      { label: "Claude Opus 4.7", value: "claude-opus-4-7" },
      { label: "Claude Sonnet 4.6", value: "claude-sonnet-4-6" },
      { label: "Claude Haiku 4.5", value: "claude-haiku-4-5" },
    ],
  },
  {
    id: "anthropic",
    agentCli: "api-claude",
    name: "Claude (API)",
    needsKey: true,
    // Three ids here carried a snapshot date (`claude-opus-4-6-20250415`,
    // `claude-sonnet-4-6-20250414`, `claude-haiku-4-5-20251001`). Anthropic's
    // published ids are complete without one, so those three named models that
    // do not exist and would have 404'd on first use. Never append a date.
    models: [
      { label: "Claude Opus 5", value: "claude-opus-5" },
      { label: "Claude Sonnet 5", value: "claude-sonnet-5" },
      { label: "Claude Opus 4.8", value: "claude-opus-4-8" },
      { label: "Claude Opus 4.7", value: "claude-opus-4-7" },
      { label: "Claude Opus 4.6", value: "claude-opus-4-6" },
      { label: "Claude Sonnet 4.6", value: "claude-sonnet-4-6" },
      { label: "Claude Haiku 4.5", value: "claude-haiku-4-5" },
    ],
  },
  // REMOVED 2026-07: `openai-codex` / `api-openai-codex`, the
  // "OpenAI (ChatGPT Plus/Pro)" row that drove `codex exec` as a subprocess on
  // a ChatGPT subscription login. Without a subscription it bought nothing over
  // the `openai-agents` row below, which reaches the same OpenAI API with the
  // same API key and — unlike Codex `exec` — can service a per-tool approval
  // round-trip. Persisted conversations on the id stay readable; see
  // `RETIRED_API_AGENTS` in `agentTaskStore.ts`.
  {
    id: "openai",
    agentCli: "api-openai",
    name: "OpenAI (API)",
    needsKey: true,
    models: [
      { label: "GPT-5.5 (default)", value: "gpt-5.5" },
      { label: "ChatGPT 5.4", value: "chatgpt-5.4" },
      { label: "GPT-4o", value: "gpt-4o" },
      { label: "o3", value: "o3" },
      { label: "o4-mini", value: "o4-mini" },
    ],
  },
  {
    id: "openai-agents",
    agentCli: "api-openai-agents",
    name: "OpenAI Agents SDK (API)",
    needsKey: true,
    models: [
      { label: "GPT-5.5 (default)", value: "gpt-5.5" },
      { label: "ChatGPT 5.4", value: "chatgpt-5.4" },
      { label: "GPT-4o", value: "gpt-4o" },
      { label: "o3", value: "o3" },
      { label: "o4-mini", value: "o4-mini" },
    ],
  },
  {
    id: "minimax",
    agentCli: "api-minimax",
    name: "MiniMax (Token Plan)",
    needsKey: true,
    models: [
      { label: "M3", value: "MiniMax-M3" },
      { label: "M2.5", value: "MiniMax-M2.5" },
      { label: "M2", value: "MiniMax-M2" },
    ],
  },
  {
    id: "openrouter",
    agentCli: "api-openrouter",
    name: "OpenRouter",
    needsKey: true,
    models: [
      { label: "Auto (best available)", value: "openrouter/auto" },
      { label: "Claude Opus 4.8", value: "anthropic/claude-opus-4-8" },
      { label: "Claude Opus 4.7", value: "anthropic/claude-opus-4-7" },
      { label: "Claude Opus 4.6", value: "anthropic/claude-opus-4-6" },
      { label: "Claude Sonnet 4.6", value: "anthropic/claude-sonnet-4-6" },
      { label: "GPT-5.5", value: "openai/gpt-5.5" },
      { label: "ChatGPT 5.4", value: "openai/chatgpt-5.4" },
      { label: "Gemini 2.5 Pro", value: "google/gemini-2.5-pro" },
      { label: "Llama 4 Maverick", value: "meta-llama/llama-4-maverick" },
    ],
  },
  {
    id: "ollama",
    agentCli: "api-ollama",
    name: "Ollama (Local)",
    needsKey: false,
    models: [
      { label: "Llama 3.3 70B", value: "llama3.3:70b" },
      { label: "Qwen 3 32B", value: "qwen3:32b" },
      { label: "DeepSeek Coder V2", value: "deepseek-coder-v2" },
      { label: "CodeLlama 34B", value: "codellama:34b" },
    ],
  },
  {
    // LM2 — user-supplied OpenAI-compatible endpoint (vLLM, LM Studio,
    // LiteLLM, Together, …). Models are a runtime-managed manual list (see
    // `useCustomModels`) exactly like Ollama's live list, so the static
    // catalog carries none. `needsKey: false` — the endpoint may require no
    // key; the auth badge reflects whether a base URL is configured instead.
    id: "custom",
    agentCli: "api-custom",
    name: "Custom endpoint (OpenAI-compatible)",
    needsKey: false,
    models: [],
  },
];

/**
 * THE builder for a picker row. Every `ApiModel` that reaches a picker — the
 * static rows below, a live provider list — is
 * constructed here, so a row can never arrive without its ctx/price chips
 * resolved.
 *
 * This used to be a one-shot `for` loop over `API_PROVIDERS` at module load.
 * That decorated exactly the rows that existed at import time, which meant any
 * row built later (an engine enumeration, a live fetch, a user-typed id)
 * rendered with no context-window and no price and nothing said so — the
 * chips just weren't there. Decoration belongs to row CONSTRUCTION, not to a
 * module-load pass over one array, so it lives in a function now and the array
 * below is frozen so nothing can push an undecorated row into it.
 *
 * Sources, both imported and neither duplicated: context from
 * `modelContext.getModelContextWindow`, price from
 * `conversationCost.getModelRates` (→ `shared/model-pricing.json`, shared with
 * the Rust engine).
 *
 * Caller-supplied metadata wins where present: a provider enumerating its own
 * models is the authority on them, and a brand-new id is exactly the case our
 * bundled tables cannot answer. The zero-rate guard is preserved either way —
 * a free/local model has a real 0/0 entry, and "$0.00" is a fiction rather
 * than a price.
 */
export function buildApiModel(input: {
  value: string;
  label?: string;
  /** Provider-reported window, when it reported one. */
  contextWindow?: number;
  /** Provider-reported USD per 1M tokens, when it reported them. */
  pricing?: { input: number; output: number };
}): ApiModel {
  const reportedWindow =
    typeof input.contextWindow === "number" && input.contextWindow > 0
      ? input.contextWindow
      : undefined;
  const row: ApiModel = {
    label: input.label || input.value,
    value: input.value,
    contextWindow: reportedWindow ?? getModelContextWindow(input.value),
  };
  const rates = input.pricing ?? getModelRates(input.value);
  if (rates && (rates.input > 0 || rates.output > 0)) row.pricing = rates;
  return row;
}

// Rebuild every static row through the shared builder, then freeze so a later
// `push` of an undecorated row is a TypeError rather than a picker with
// missing chips. Freezing is also what makes `agent-catalog.ts`'s aliased
// `models: p.models` reference safe by construction.
for (const provider of API_PROVIDERS) {
  const rows = provider.models.map((model) =>
    Object.freeze(buildApiModel({ value: model.value, label: model.label })),
  );
  provider.models = Object.freeze(rows) as unknown as ApiModel[];
}
Object.freeze(API_PROVIDERS);

/** Get provider info by agent CLI identifier. */
export function getProviderForAgent(agent: AgentCli): ApiProviderInfo | undefined {
  return API_PROVIDERS.find((p) => p.agentCli === agent);
}

/**
 * Get the default model for a provider — the FIRST BUNDLED row, or `""`.
 *
 * The empty string is a silent failure everywhere: the request goes out naming
 * no model and comes back a 400. Rows whose models arrive live (`api-custom`,
 * and `api-ollama` beyond its bundled seeds) answer `""` until their first
 * enumeration lands, so callers that launch a turn must reject an empty model
 * rather than passing it through unexamined; `launchConversation` does. This
 * function stays deliberately
 * bundle-only and synchronous — it is called from render paths and from
 * non-React stores, so it must never read a cache or issue IPC. Where a live
 * list is available, resolve through `liveModels.resolveModelRows` and take
 * `rows[0]` instead.
 */
export function getDefaultModel(agent: AgentCli): string {
  const provider = getProviderForAgent(agent);
  return provider?.models[0]?.value ?? "";
}

/**
 * P1-S4: whether the given agent's adapter can honor a per-tool approval
 * round-trip. Providers with no catalog entry (e.g. PTY CLI agents, and
 * retired ids) and providers that omit the flag are treated as
 * approval-capable. No live row sets it `false`; see `supportsApprovals`.
 */
export function providerSupportsApprovals(agent: AgentCli): boolean {
  return getProviderForAgent(agent)?.supportsApprovals ?? true;
}

export type ModelSpeed = "fast" | "balanced" | "thorough";

/** Heuristic mapping of a model id to a Cursor-style speed label. */
export function getModelSpeed(modelId: string | undefined | null): ModelSpeed {
  if (!modelId) return "balanced";
  const id = modelId.toLowerCase();
  // Anthropic
  if (id.includes("haiku")) return "fast";
  if (id.includes("opus")) return "thorough";
  if (id.includes("sonnet")) return "balanced";
  // OpenAI
  if (id.includes("o3")) return "thorough";
  if (id.includes("o4-mini") || id.includes("4o-mini")) return "fast";
  if (id.includes("gpt-5.5") || id.includes("chatgpt-5.4") || id.includes("gpt-5-codex")) {
    return "balanced";
  }
  if (id.includes("gpt-4o") || id.includes("gpt-5")) return "balanced";
  // MiniMax
  if (id.includes("highspeed")) return "fast";
  if (id.includes("minimax")) return "balanced";
  // OpenRouter
  if (id.includes("auto")) return "balanced";
  // Gemini / Llama / Ollama — generally local or general-purpose
  if (id.includes("flash") || id.includes("mini")) return "fast";
  if (id.includes("70b") || id.includes("405b") || id.includes("32b")) return "thorough";
  return "balanced";
}

export const MODEL_SPEED_LABEL: Record<ModelSpeed, string> = {
  fast: "Fast",
  balanced: "Balanced",
  thorough: "Thorough",
};
