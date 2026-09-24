import { calculateCostUsd, ratesForModel, type PricedAt } from "@/lib/modelPricing";

/**
 * Conversation cost estimation.
 *
 * NOTE (2026-07-31): the user-facing cost REPORTING surface was removed. What
 * remains here is measurement, not display — `estimateTurnCostUsd` stamps
 * `costUsd` on assistant messages at receipt time. The dollar figures feed the budget guardrails
 * (`lib/costGuardrails.ts`), which stop runaway agents. Do not add formatting
 * helpers here; there is no dashboard to format for any more.
 *
 * Rates come from `shared/model-pricing.json` via `lib/modelPricing.ts` — the
 * same file the Rust engine compiles in. This module used to carry its own
 * `COST_PER_MTOK` table that disagreed with Rust's on three shipped models;
 * that table is gone and must not come back. Add rates to the shared JSON.
 *
 * Every cache class is priced at its own published rate (read / 5-minute write
 * / 1-hour write) rather than one blended ratio.
 */

/** Raw per-turn token counts as the listeners record them. */
export interface TurnTokens {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  reasoningTokens?: number;
}

/**
 * Public accessor for input/output rates — used by api-models.ts to populate
 * ModelSelector's price display so no second table has to be hand-mirrored.
 */
export function getModelRates(model: string | undefined): { input: number; output: number } | null {
  const rates = ratesForModel(model);
  if (!rates) return null;
  return { input: rates.input, output: rates.output };
}

/**
 * Price one turn's raw token counts.
 *
 * The shared cost primitive is additive over DISJOINT buckets, so vendors that
 * report prompt tokens as a superset of their cached reads (OpenAI
 * `cached_tokens`) are normalised here, driven by the table's
 * `inputIncludesCacheRead` flag. Anthropic's buckets are already disjoint and
 * are no longer wrongly subtracted. Reasoning tokens bill at the output rate.
 *
 * `at` is the moment the turn was billed — pass the message timestamp so a
 * later published rate change never reprices an old turn.
 */
function costForTurn(model: string | undefined, tokens: TurnTokens, at?: PricedAt): number | null {
  const rates = ratesForModel(model, at);
  if (!rates) return null;
  const rawInput = tokens.inputTokens ?? 0;
  const cacheRead = tokens.cacheReadTokens ?? 0;
  return calculateCostUsd(
    model,
    {
      input: rates.inputIncludesCacheRead ? Math.max(0, rawInput - cacheRead) : rawInput,
      output: (tokens.outputTokens ?? 0) + (tokens.reasoningTokens ?? 0),
      cacheRead,
      cacheWrite5m: tokens.cacheWriteTokens ?? 0,
    },
    at,
  );
}

/**
 * Estimate the USD cost of a single turn. Returns `null` when the model is
 * unknown so budget guardrails can preserve missing pricing rather than
 * treating it as zero spend.
 *
 * Used to stamp `costUsd` on assistant messages at receipt time
 * (apiAgentListeners) — no per-message IPC.
 */
export function estimateTurnCostUsd(
  model: string | undefined,
  tokens: TurnTokens,
  at?: PricedAt,
): number | null {
  return costForTurn(model, tokens, at);
}
