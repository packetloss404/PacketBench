/**
 * Live model enumeration — the provider-agnostic seam.
 *
 * ## What this generalises
 *
 * Asking a backend "which models do you actually serve?" and preferring that
 * answer over the shipped catalog is the mechanism for EVERY provider. The
 * three concerns are expressed once, without naming a vendor:
 *
 * - {@link LIVE_MODEL_PROVIDERS} — WHO enumerates, and by which producer.
 * - {@link liveModelRow} — HOW one enumerated id becomes a picker row.
 * - {@link resolveModelRows} — WHICH list wins when several exist.
 *
 * ## The `[]` ambiguity, resolved
 *
 * Two call sites disagreed about what an empty list means:
 * `agentCapabilities.ts` treated `[]` as "this backend serves no models" (so it
 * overrode the catalog), while `ModelSelector.tsx` treated `[]` as "nothing to
 * say, use the catalog". Both readings are defensible for a bare `ApiModel[]`,
 * which is exactly why a bare `ApiModel[]` is the wrong carrier.
 *
 * **The ruling: emptiness is only meaningful when it is an ANSWER.** The
 * distinction lives in the STATUS, never in the length:
 *
 * | carrier                              | meaning                                  |
 * |--------------------------------------|------------------------------------------|
 * | `undefined` list                     | never asked / the ask failed → use bundle |
 * | `status: "ready"`, `models: []`      | the provider answered "I serve none"      |
 * | `status: "ready"`, `models: [...]`   | the provider's real list                  |
 * | any non-`ready` status               | not an answer → use bundle                |
 *
 * So `[]` overrides the catalog (agentCapabilities was right) but ONLY when it
 * arrived as a settled answer, and an empty result never unmounts the picker
 * for a live-enumerating provider (ModelSelector's instinct was right about the
 * consequence, wrong about the cause). A provider that genuinely serves nothing
 * gets an explicit empty state with a Refresh and free-text entry, not silence.
 *
 * ## What this seam is NOT
 *
 * It is not a gate. Live enumeration is a convenience: a model published this
 * morning must still be typeable into the picker, so every surface that
 * consumes a resolution also offers free-text entry
 * (`ModelSelector`'s "Use …" row).
 */

import type { AgentCli } from "@/stores/agentTaskStore";
import { listProviderModels, type LiveModel } from "@/lib/tauri";
// From the pure module, NOT from `lib/tauri` — see that file's header. A
// test that stubs the IPC surface must still get real classification.
import { parseLiveModelError } from "@/lib/liveModelErrors";
import { buildApiModel, getProviderForAgent, type ApiModel } from "@/lib/api-models";

/** The IPC DTO is authoritative; absent metadata is nullable on the wire. */
export type { LiveModel } from "@/lib/tauri";

/**
 * Where a provider's live list comes from.
 *
 * Only `ipc` rows go through {@link fetchLiveModels} and the shared cache. The
 * other two already have working, provider-specific producers that carry
 * metadata the generic `LiveModel` DTO cannot express — Ollama's per-model
 * tools template — so they keep their producers and converge on this module's
 * ROW BUILDER and PRECEDENCE instead. That is the whole point: one answer to "which list wins", many
 * transports, exactly as the `api-agent:*` event contract does for streaming.
 */
export type LiveModelProducer = "ipc" | "ollama" | "custom";

export interface LiveModelSource {
  /**
   * Key handed to `listProviderModels`. Deliberately the VENDOR, not the row:
   * both Claude rows and both OpenAI rows enumerate the same account's models,
   * so they share one cache entry and one round trip.
   */
  provider: string;
  producer: LiveModelProducer;
  /**
   * How long a settled answer is served before a background refresh is issued.
   * Cached rows are always served immediately; the TTL only decides when the
   * refresh fires, never whether the picker waits.
   */
  ttlMs: number;
  /**
   * Whether discovery requires a saved API key. Providers without bundled
   * models show setup guidance until discovery succeeds.
   */
  needsKey: boolean;
}

/** Refresh on use after one hour; explicit Refresh always bypasses this TTL. */
export const CLOUD_MODEL_TTL_MS = 60 * 60 * 1000;
/** Thirty seconds — a local `ollama pull` should show up almost immediately. */
export const LOCAL_MODEL_TTL_MS = 30 * 1000;

/**
 * THE registry of live-enumerating providers.
 *
 * This replaces three hardcoded lists that had drifted apart: ModelSelector's
 * `isOllama || isCustom` mount exemption, `LaunchAsyncFlightModal`'s
 * Ollama-only live branch, and `ProviderRoutingCard`'s `provider === "ollama"`
 * branch. Adding a provider here is now the whole change.
 */
export const LIVE_MODEL_PROVIDERS: Partial<Record<AgentCli, LiveModelSource>> = {
  "api-sugar": { provider: "sugar", producer: "ipc", ttlMs: CLOUD_MODEL_TTL_MS, needsKey: true },
  "api-cline-pass": {
    provider: "cline-pass",
    producer: "ipc",
    ttlMs: CLOUD_MODEL_TTL_MS,
    needsKey: true,
  },
  "api-opencode-go": {
    provider: "opencode-go",
    producer: "ipc",
    ttlMs: CLOUD_MODEL_TTL_MS,
    needsKey: true,
  },
  "api-ollama-cloud": {
    provider: "ollama-cloud",
    producer: "ipc",
    ttlMs: CLOUD_MODEL_TTL_MS,
    needsKey: true,
  },
  "api-google": { provider: "google", producer: "ipc", ttlMs: CLOUD_MODEL_TTL_MS, needsKey: true },
  "api-xai": { provider: "xai", producer: "ipc", ttlMs: CLOUD_MODEL_TTL_MS, needsKey: true },

  "api-claude-oauth": {
    provider: "anthropic",
    producer: "ipc",
    ttlMs: CLOUD_MODEL_TTL_MS,
    needsKey: true,
  },
  "api-claude": {
    provider: "anthropic",
    producer: "ipc",
    ttlMs: CLOUD_MODEL_TTL_MS,
    needsKey: true,
  },
  "api-openai": {
    provider: "openai",
    producer: "ipc",
    ttlMs: CLOUD_MODEL_TTL_MS,
    needsKey: true,
  },
  "api-openai-agents": {
    provider: "openai",
    producer: "ipc",
    ttlMs: CLOUD_MODEL_TTL_MS,
    needsKey: true,
  },
  "api-minimax": {
    provider: "minimax",
    producer: "ipc",
    ttlMs: CLOUD_MODEL_TTL_MS,
    needsKey: true,
  },
  "api-openrouter": {
    provider: "openrouter",
    producer: "ipc",
    ttlMs: CLOUD_MODEL_TTL_MS,
    needsKey: true,
  },
  // Localhost daemon, no credential. Its producer stays `useOllamaModels`
  // because the daemon also reports a tools template per model, which decides
  // whether a row is SELECTABLE for a tool-carrying turn.
  "api-ollama": {
    provider: "ollama",
    producer: "ollama",
    ttlMs: LOCAL_MODEL_TTL_MS,
    needsKey: false,
  },
  // A user-managed manual list read back over IPC (`useCustomModels`). No
  // bundled catalog exists to fall back to, which is why its empty state — an
  // unconditional "Edit models…" row into Settings — is the pattern every
  // other empty state here copies.
  "api-custom": {
    provider: "custom",
    producer: "custom",
    ttlMs: LOCAL_MODEL_TTL_MS,
    needsKey: false,
  },
};

/**
 * Does this agent's provider enumerate its own models?
 *
 * The predicate that replaces `ModelSelector`'s hardcoded
 * `api-ollama | api-custom` exemption. Its consequence is
 * load-bearing: a live-enumerating provider's picker MUST mount even with zero
 * rows, because zero rows is a state the user can act on (refresh, type an id,
 * open Settings) and unmounting turns it into a dead read-only label.
 */
export function providerEnumeratesLive(agent: AgentCli): boolean {
  return LIVE_MODEL_PROVIDERS[agent] !== undefined;
}

/** The registry entry for an agent, or `undefined` for a static/PTY row. */
export function liveModelSource(agent: AgentCli): LiveModelSource | undefined {
  return LIVE_MODEL_PROVIDERS[agent];
}

/**
 * One enumerated model as a picker row — THE shared row builder for live data.
 *
 * Generalises `agentCapabilities.engineModelRow`, which was the reference
 * implementation: context via the shared `getModelContextWindow`, pricing via
 * the shared rate table, and the zero-rate guard that keeps a free/local model
 * unpriced rather than labelled "$0/$0".
 *
 * The one addition is precedence: metadata the PROVIDER reported wins over the
 * bundled tables, because the vendor is the authority on its own model and a
 * brand-new id is precisely the case where our tables have nothing. Everything
 * it did not report still falls through to the shared helpers, so a live row is
 * never less informative than a catalog row.
 */
export function liveModelRow(model: LiveModel, provider?: string): ApiModel {
  const reported =
    typeof model.inputPerMTok === "number" && typeof model.outputPerMTok === "number"
      ? { input: model.inputPerMTok, output: model.outputPerMTok }
      : undefined;
  const row = buildApiModel({
    value: model.id,
    label: model.displayName || model.id,
    // `null` is the wire's "provider did not say" — OpenAI, MiniMax and
    // custom never report one, and Ollama does not on older daemons. It
    // must degrade to the local table, NOT render as a zero-token window.
    contextWindow: model.contextWindow ?? undefined,
    pricing: reported,
  });
  // A local model name served by a cloud gateway is not evidence of free usage.
  if (
    provider &&
    provider !== "ollama" &&
    !reported &&
    row.pricing?.input === 0 &&
    row.pricing.output === 0
  )
    delete row.pricing;
  return row;
}

/** How the last enumeration for a provider resolved. */
export type LiveModelStatus =
  /** Never asked. */
  | "idle"
  /** A request is in flight. Any `models` present are the last good answer. */
  | "loading"
  /** Settled. `models` is the answer — INCLUDING when it is empty. */
  | "ready"
  /** The request failed (transport, 5xx, timeout). */
  | "failed"
  /**
   * The credential was REJECTED (401/403). Different from `no-key`: the user
   * has a key and it does not work, which is worth saying out loud.
   */
  | "unauthorized"
  /** A keyed provider with no key in the keyring. Not an error — just unasked. */
  | "no-key"
  /**
   * This build has no `listProviderModels` binding. The whole seam degrades to
   * the bundled catalog, which is exactly today's behaviour.
   */
  | "unsupported";

export interface LiveModelAnswer {
  status: LiveModelStatus;
  /**
   * Rows from the last SUCCESSFUL enumeration. `undefined` means no
   * enumeration has ever succeeded — the case that must fall back to the
   * bundled catalog. An empty array is a real answer; see the `[]` ruling in
   * this module's header.
   */
  models?: ApiModel[];
  /** When `models` was fetched. Absent until one lands. */
  fetchedAt?: number;
  /** Human-readable reason for `failed` / `unauthorized`. */
  error?: string;
}

/** Which list a resolution ended up serving. */
export type ModelRowSource =
  /** The session's own backend answered (live enumeration). */
  | "live"
  /** The shipped `API_PROVIDERS` rows. */
  | "bundled"
  /** Neither — a PTY/unknown agent with no catalog row. */
  | "none";

export interface ModelRowResolution {
  rows: ApiModel[];
  source: ModelRowSource;
  /** Live rows served from cache while a refresh runs behind them. */
  stale: boolean;
  /** This provider enumerates live, so the picker mounts even at zero rows. */
  enumeratesLive: boolean;
  /**
   * Why the rows are what they are, when that is not self-evident. Surfaced
   * next to the picker so a bundled fallback is BADGED rather than silently
   * passed off as the provider's real catalog.
   */
  notice: string | null;
}

export interface ResolveModelRowsInput {
  agent: AgentCli;
  /**
   * Rows the caller already knows are authoritative for THIS session, from a
   * backend that enumerated them onto the conversation record.
   *
   * `undefined` means "no opinion". A defined value WINS, empty included: a
   * backend that was asked and named nothing has told us something, and
   * offering bundled ids it may refuse is the silent no-op this seam exists to
   * prevent.
   */
  authoritative?: ApiModel[];
  /** The shared cache's entry for this provider, when one exists. */
  live?: LiveModelAnswer;
}

/**
 * THE precedence function. Every surface that shows a model list resolves
 * through this, so the three ad-hoc branches that used to disagree
 * (`ModelSelector`, `LaunchAsyncFlightModal`, `ProviderRoutingCard`) now cannot.
 *
 * Order: session-authoritative → settled live answer → stale live answer →
 * bundled catalog → nothing.
 */
export function resolveModelRows(input: ResolveModelRowsInput): ModelRowResolution {
  const { agent, authoritative, live } = input;
  const enumeratesLive = providerEnumeratesLive(agent);
  const bundled = getProviderForAgent(agent)?.models ?? [];

  const base = { enumeratesLive, stale: false } as const;

  // 1. The session's own backend spoke. Empty included — see the `[]` ruling.
  if (authoritative !== undefined) {
    return {
      ...base,
      rows: authoritative,
      source: "live",
      notice:
        authoritative.length === 0
          ? "This session's backend reports no models. Turns use its configured default."
          : null,
    };
  }

  // 2. A settled enumeration. Empty included, for the same reason.
  if (live?.status === "ready" && live.models !== undefined) {
    return {
      ...base,
      rows: live.models,
      source: "live",
      notice:
        live.models.length === 0
          ? "The provider reported no models. Refresh, or type a model id."
          : null,
    };
  }

  // 3. A refresh is running (or failed) over a list that DID land once. Serve
  //    it — a stale real answer beats a bundled guess, and beats a spinner.
  if (live?.models !== undefined && live.models.length > 0) {
    return {
      ...base,
      rows: live.models,
      stale: true,
      source: "live",
      notice:
        live.status === "failed"
          ? `Showing the last known list — ${live.error ?? "refresh failed"}`
          : null,
    };
  }

  // 4. Use a bundled fallback when one exists; otherwise retain setup/error
  //    guidance so a live-only provider does not present a silent empty menu.
  return {
    ...base,
    rows: bundled,
    source: bundled.length > 0 ? "bundled" : "none",
    notice:
      bundled.length > 0
        ? bundledNotice(live?.status, live?.error)
        : enumeratesLive
          ? (live?.error ??
            (live?.status === "loading" ? "Loading models…" : "Refresh, or type a model id."))
          : null,
  };
}

/** Why the bundled catalog is standing in, in the user's words. */
function bundledNotice(status: LiveModelStatus | undefined, error?: string): string | null {
  switch (status) {
    case "no-key":
      return "Built-in model list — add an API key in Settings to load this provider's own.";
    case "unauthorized":
      return `Built-in model list — the provider rejected the API key${error ? ` (${error})` : ""}.`;
    case "failed":
      return `Built-in model list — could not reach the provider${error ? ` (${error})` : ""}.`;
    case "loading":
      return "Built-in model list — loading this provider's own…";
    default:
      // `idle` / `unsupported` / no entry: the pre-seam behaviour, and nothing
      // has gone wrong. Saying "built-in" here would be noise on every picker.
      return null;
  }
}

/**
 * Call the `listProviderModels` binding, if this build has one.
 *
 * ## The one-line integration point
 *
 * The Rust command and its `src/lib/tauri.ts` binding are landing separately
 * from this seam, and `src/lib/tauri.ts` is owned elsewhere. Rather than break
 * the build on a symbol that does not exist yet, this looks the export up at
 * runtime and reports `unsupported` when it is absent — which resolves every
 * picker to the bundled catalog, i.e. exactly today's behaviour.
 *
 * When the binding lands, this whole function may be replaced by a direct
 * Now a direct call to `listProviderModels`; nothing else in the
 * seam changes.
 */
export async function fetchLiveModels(provider: string): Promise<LiveModel[] | "unsupported"> {
  const result = await listProviderModels(provider);
  return Array.isArray(result) ? result : [];
}

/**
 * Classify a failed enumeration.
 *
 * "Key absent" and "key rejected" are genuinely different states — the first is
 * a setup step the user has not done, the second is a credential that is wrong
 * — and collapsing them produces the least actionable message in either case.
 */
export function classifyLiveModelError(error: unknown): {
  status: Extract<LiveModelStatus, "failed" | "unauthorized" | "no-key" | "unsupported">;
  message: string;
} {
  // The backend tags every rejection (`"<kind>: <message>"`), so classify on
  // the TAG, never on the prose.
  //
  // This function first sniffed the message for "401", "unauthorized", "no api
  // key" and friends. That works until a provider phrases a rejection
  // differently, or localises it, or happens to mention "authentication" while
  // failing for an unrelated reason — and each of those misroutes the user to
  // the wrong remedy silently. MiniMax alone returns an auth failure inside an
  // HTTP 200 body, which no status-string heuristic would ever have caught.
  const parsed = parseLiveModelError(error);
  switch (parsed.kind) {
    // Two shapes of "you have not connected this yet". Benign: prompt to
    // configure rather than rendering a failure.
    case "no-key":
    case "not-configured":
      return { status: "no-key", message: parsed.message };
    // A key WAS sent and rejected — the earliest cheap signal that a stored
    // keyring secret went stale.
    case "unauthorized":
      return { status: "unauthorized", message: parsed.message };
    // This provider has no live catalog at all; not a failure, and it must not
    // empty a picker. Falls through to the bundled rows.
    case "unsupported":
      return { status: "unsupported", message: parsed.message };
    // `network` and `credential-store` are both retryable and both leave the
    // last good rows standing.
    default:
      return { status: "failed", message: parsed.message };
  }
}
