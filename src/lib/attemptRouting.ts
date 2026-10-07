/**
 * Attempt-target routing for launches the user did not configure by hand.
 *
 * ## Why this exists (WI-1 of `dev/oauth-removal-plan.md`)
 *
 * GitHub → AI Investigation → **Draft patch** used to build its attempt target
 * inline with `agentConfigId: "api-claude-oauth"` / `provider: "claude-oauth"`
 * hardcoded. That spent the user's Claude *subscription* on a full agentic
 * worktree run they never picked a provider for — the same class of exposure as
 * the four Rust auxiliary features, just on the frontend.
 *
 * Automatic launches now resolve through the routing settings' workflow roles
 * (Settings → AI Provider Routing), falling back to the same default a manual
 * Flight launch offers. Retired / non-catalog agents are refused outright
 * rather than obeyed, so nothing PacketBench routes on the user's behalf can
 * land on a provider that cannot run.
 *
 * Since 2026-07 no picker row uses subscription credentials at all: the
 * Claude Agent SDK row authenticates with the Anthropic API key, and the
 * ChatGPT-subscription Codex row was removed.
 */

import { API_PROVIDERS, getDefaultModel } from "@/lib/api-models";
import { useRoutingStore } from "@/stores/routingStore";
import { apiAgentProvider, canonicalizeAgentCli, type AgentCli } from "@/stores/agentTaskStore";
import type { AttemptTargetSpec } from "@/lib/tauri";
import type { TaskType } from "@/types/flight";

/**
 * Agents that may never be picked by an automatic launch.
 *
 * Originally the two subscription-OAuth rows. Both are gone as such:
 * `api-openai-codex` was removed outright in 2026-07, and `api-claude-oauth`
 * is now the Claude Agent SDK on an Anthropic API key, so it is a perfectly
 * legitimate automatic target and is no longer listed.
 *
 * The retired id stays here as belt-and-braces: `isUsableAttemptAgent` already
 * rejects it for having no `API_PROVIDERS` row, and this makes the intent
 * explicit rather than incidental.
 */
export const SUBSCRIPTION_OAUTH_AGENTS: ReadonlySet<string> = new Set(["api-openai-codex"]);

/**
 * Fallback executor for an automatic launch. Matches `MultiTargetPicker`'s
 * `defaultAgent`, so an auto-launched attempt looks exactly like the one the
 * user would get by opening the launch modal and pressing go.
 */
export const DEFAULT_ATTEMPT_AGENT: AgentCli = "api-claude";

/** Flight attempts run through `start_api_agent_session`, so the executor must
 * be an API agent — a PTY CLI agent id (`claude-code`, `codex`, …) cannot back
 * an attempt. */
function isUsableAttemptAgent(agentConfigId: string): boolean {
  if (SUBSCRIPTION_OAUTH_AGENTS.has(agentConfigId)) return false;
  return API_PROVIDERS.some((p) => p.agentCli === agentConfigId);
}

/**
 * The canonical backend provider id for an attempt executor — the ONE place
 * any attempt spec may derive `AttemptTargetSpec.provider`.
 *
 * `flight_attempts.rs` forwards this string verbatim to
 * `start_api_agent_session`, which routes it either to the sidecar
 * (`SIDECAR_PROVIDERS`) or to the Rust `get_provider` dispatch. Neither knows
 * agent-config ids, so the naive `agentConfigId.replace(/^api-/, "")` that
 * used to live in `pickedToSpec` / `asyncFlightStore` was wrong for the
 * DEFAULT executor: `api-claude` → `"claude"`, which `get_provider` rejects
 * and `load_api_key` reports as a missing key for a provider that does not
 * exist. Every other id happened to round-trip, which is exactly why the bug
 * survived — so route through the authoritative map instead of re-deriving.
 *
 * Legacy hydrated ids are canonicalised first (`api-minimax-api` →
 * `api-minimax` → `"minimax"`).
 */
export function attemptProviderFor(agentConfigId: string): string {
  return apiAgentProvider(canonicalizeAgentCli(agentConfigId));
}

/**
 * Pick the executor for an automatic launch of `taskType`.
 *
 * Honours a routing-settings pin when it names a usable API agent; otherwise
 * falls back to [`DEFAULT_ATTEMPT_AGENT`]. A pin naming a PTY CLI agent (which
 * cannot execute an attempt) or a subscription-OAuth agent is ignored rather
 * than obeyed — silently launching on the wrong credentials is the failure
 * mode this whole change exists to remove.
 */
export function resolveAttemptExecutor(route: { agentConfigId: string; model?: string }): {
  agentConfigId: AgentCli;
  model: string;
} {
  const agentConfigId = isUsableAttemptAgent(route.agentConfigId)
    ? (route.agentConfigId as AgentCli)
    : DEFAULT_ATTEMPT_AGENT;

  // A model pinned for a different agent must not leak across; only keep it
  // when the pinned agent survived.
  const pinnedModel =
    agentConfigId === route.agentConfigId && route.model?.trim() ? route.model.trim() : "";

  const model = pinnedModel || getDefaultModel(agentConfigId);
  if (!model) {
    throw new Error(
      "Choose a model for this workflow role in Settings → AI Provider Routing before launching a Flight.",
    );
  }
  return { agentConfigId, model };
}

/** Build a local worktree attempt target for an automatic launch. */
export function localAttemptTargetFromRoute(
  route: { agentConfigId: string; model?: string },
  basePath: string,
  baseBranch = "main",
): AttemptTargetSpec {
  const executor = resolveAttemptExecutor(route);
  return {
    kind: "local",
    basePath,
    baseBranch,
    agentConfigId: executor.agentConfigId,
    // The canonical backend provider id, via the same map `agentTaskStore`
    // uses when it starts an API conversation. Mis-mapping a provider is how
    // requests end up billed to the wrong credentials — or, for `api-claude`,
    // fail outright — so every attempt spec goes through this one helper.
    provider: attemptProviderFor(executor.agentConfigId),
    model: executor.model,
  };
}

/** Read the live routing settings and build a local attempt target. */
export function resolveLocalAttemptTarget(
  taskType: TaskType,
  basePath: string,
  baseBranch = "main",
): AttemptTargetSpec {
  const route = useRoutingStore.getState().resolveForTask(taskType);
  return localAttemptTargetFromRoute(route, basePath, baseBranch);
}
