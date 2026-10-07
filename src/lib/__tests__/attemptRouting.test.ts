import { beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_ATTEMPT_AGENT,
  SUBSCRIPTION_OAUTH_AGENTS,
  attemptProviderFor,
  localAttemptTargetFromRoute,
  resolveAttemptExecutor,
  resolveLocalAttemptTarget,
} from "@/lib/attemptRouting";
import { useRoutingStore } from "@/stores/routingStore";
import { API_PROVIDERS, getDefaultModel } from "@/lib/api-models";
import type { AgentCli } from "@/stores/agentTaskStore";

/**
 * WI-1 — GitHub → "Draft patch" used to hardcode `api-claude-oauth` /
 * `claude-oauth`, spending the user's Claude subscription on an agentic run
 * they never picked a provider for. These pin the replacement: the routing
 * settings decide, and no automatic path can reach a subscription login.
 */
describe("attemptRouting", () => {
  beforeEach(() => {
    localStorage.clear();
    useRoutingStore.getState().resetToDefaults();
  });

  it("never resolves to a subscription-OAuth executor", () => {
    for (const oauthAgent of SUBSCRIPTION_OAUTH_AGENTS) {
      const executor = resolveAttemptExecutor({ agentConfigId: oauthAgent });
      expect(executor.agentConfigId).toBe(DEFAULT_ATTEMPT_AGENT);
      expect(SUBSCRIPTION_OAUTH_AGENTS.has(executor.agentConfigId)).toBe(false);
    }
  });

  it("honours a routing-settings pin naming an API executor", () => {
    useRoutingStore.getState().setMapping("implementation", "api-minimax", "MiniMax-M3");

    const target = resolveLocalAttemptTarget("implementation", "/repo");

    expect(target).toMatchObject({
      kind: "local",
      basePath: "/repo",
      baseBranch: "main",
      agentConfigId: "api-minimax",
      provider: "minimax",
      model: "MiniMax-M3",
    });
  });

  it("maps the executor to a canonical get_provider id", () => {
    // `api-claude` must become `anthropic`, not the naive prefix-strip
    // `claude`, which the Rust `get_provider` dispatch does not know.
    expect(localAttemptTargetFromRoute({ agentConfigId: "api-claude" }, "/repo").provider).toBe(
      "anthropic",
    );
  });

  it("falls back to the default executor when the pinned agent cannot run an attempt", () => {
    // `claude-code` is a PTY CLI agent; Flight attempts go through
    // `start_api_agent_session`, so it cannot back one.
    useRoutingStore.getState().setMapping("implementation", "claude-code", "MiniMax-M3");

    const target = resolveLocalAttemptTarget("implementation", "/repo");

    expect(target.agentConfigId).toBe(DEFAULT_ATTEMPT_AGENT);
    expect(target.provider).toBe("anthropic");
    // A model pinned for a different agent must not leak onto the fallback.
    expect(target.model).toBe(getDefaultModel(DEFAULT_ATTEMPT_AGENT));
    expect(target.model.length).toBeGreaterThan(0);
  });

  it("uses the default when the settings have never been touched", () => {
    const target = resolveLocalAttemptTarget("implementation", "/repo");
    expect(target.agentConfigId).toBe(DEFAULT_ATTEMPT_AGENT);
    expect(SUBSCRIPTION_OAUTH_AGENTS.has(target.agentConfigId)).toBe(false);
  });

  it("maps the agent id onto the backend provider string", () => {
    const target = localAttemptTargetFromRoute(
      { agentConfigId: "api-openrouter" },
      "/repo",
      "develop",
    );
    expect(target.provider).toBe("openrouter");
    expect(target.baseBranch).toBe("develop");
  });

  it("rejects a named provider route without a selected model before building a target", () => {
    expect(() => localAttemptTargetFromRoute({agentConfigId:"api-sugar"}, "/repo"))
      .toThrow("Choose a model");
  });

  it("always produces a non-empty model", () => {
    for (const agent of ["api-claude", "api-openai", "api-minimax", "api-openrouter"]) {
      const executor = resolveAttemptExecutor({ agentConfigId: agent });
      expect(executor.model).not.toBe("");
    }
  });
});

/**
 * The provider-id mapping for EVERY pickable executor, restated independently
 * of the map it checks.
 *
 * Most ids round-trip through a naive `agentConfigId.replace(/^api-/, "")`,
 * which is precisely why `api-claude` — the DEFAULT — shipped broken: it
 * yielded `"claude"`, which `get_provider` rejects and `load_api_key` reports
 * as a missing key for a provider that does not exist. `"anthropic"` is the
 * only correct answer.
 */
const EXPECTED_PROVIDER_IDS: ReadonlyArray<[AgentCli, string]> = [
  ["api-claude-oauth", "claude-oauth"],
  ["api-claude", "anthropic"],
  ["api-openai", "openai"],
  ["api-openai-agents", "openai-agents"],
  ["api-minimax", "minimax"],
  ["api-openrouter", "openrouter"],
  ["api-ollama", "ollama"],
  // LM2 — user-supplied OpenAI-compatible endpoint. The prefix-strip happens
  // to round-trip here, but the map stays the single authority.
  ["api-custom", "custom"],
  ["api-sugar", "sugar"],
  ["api-cline-pass", "cline-pass"],
  ["api-opencode-go", "opencode-go"],
  ["api-ollama-cloud", "ollama-cloud"],
  ["api-google", "google"],
  ["api-xai", "xai"],

];

describe("attemptProviderFor", () => {
  it.each(EXPECTED_PROVIDER_IDS)("maps %s to the backend provider %s", (agent, provider) => {
    expect(attemptProviderFor(agent)).toBe(provider);
  });

  it("covers every executor the launch picker offers", () => {
    expect(API_PROVIDERS.map((p) => p.agentCli).sort()).toEqual(
      EXPECTED_PROVIDER_IDS.map(([agent]) => agent).sort(),
    );
  });

  it("still maps the RETIRED codex id so a legacy record cannot mis-bill", () => {
    // `api-openai-codex` is gone from API_PROVIDERS, but its identity entry
    // survives in `apiAgentProvider`. Dropping it would send every stored
    // Codex record through the unknown-agent fallback and bill it to the
    // user's ANTHROPIC key. Routing is blocked separately, by
    // RETIRED_API_AGENTS — identity is not.
    expect(attemptProviderFor("api-openai-codex")).toBe("openai-codex");
    expect(API_PROVIDERS.some((p) => p.agentCli === "api-openai-codex")).toBe(false);
  });

  it("differs from a prefix-strip exactly where the P1 lived", () => {
    const stripped = (agent: string) => agent.replace(/^api-/, "");
    const divergent = EXPECTED_PROVIDER_IDS.filter(
      ([agent, provider]) => stripped(agent) !== provider,
    ).map(([agent]) => agent);

    // If this ever grows, the naive derivation is broken for more executors,
    // not fewer — never "fix" it by re-deriving.
    expect(divergent).toEqual(["api-claude"]);
    expect(attemptProviderFor("api-claude")).not.toBe(stripped("api-claude"));
  });

  it("resolves the retired identity-duplicate agent id through its alias", () => {
    expect(attemptProviderFor("api-minimax-api")).toBe("minimax");
  });
});
