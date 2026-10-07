import { useCallback, useEffect } from "react";
import type { AgentCli } from "@/stores/agentTaskStore";
import { liveModelSource, type LiveModelAnswer } from "@/lib/liveModels";
import { useLiveModelStore } from "@/stores/liveModelStore";

export interface UseLiveModelsResult {
  /**
   * The shared cache's answer for this agent's provider, or `undefined` when
   * the provider does not enumerate live (or nothing has been asked yet).
   * Hand it straight to `resolveModelRows`.
   */
  answer: LiveModelAnswer | undefined;
  /** Explicit user Refresh — skips the TTL. */
  refresh: () => void;
}

/**
 * Subscribe to a provider's live model list.
 *
 * Mirrors `useOllamaModels` / `useCustomModels` in shape, but every consumer
 * shares ONE cache and ONE `provider-auth:changed` subscription (see
 * `stores/liveModelStore.ts`) — mounting six conversation tiles issues one
 * fetch per vendor, not one per tile.
 *
 * Mounting never blocks: whatever is cached renders immediately and a refresh
 * runs behind it only when the TTL has lapsed.
 */
export function useLiveModels(agent: AgentCli): UseLiveModelsResult {
  const provider = liveModelSource(agent)?.provider;
  const answer = useLiveModelStore((s) => (provider ? s.entries[provider] : undefined));
  const ensureFresh = useLiveModelStore((s) => s.ensureFresh);
  const ensureListener = useLiveModelStore((s) => s.ensureListener);

  const needsFetch = answer === undefined;
  useEffect(() => {
    ensureListener();
    ensureFresh(agent);
  }, [agent, ensureFresh, ensureListener, needsFetch]);

  const refresh = useCallback(() => {
    ensureFresh(agent, { force: true });
  }, [agent, ensureFresh]);

  return { answer, refresh };
}
