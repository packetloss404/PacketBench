import { computeContextOccupancy } from "@/lib/modelContext";
import type { AgentConversation, AgentMessage } from "@/types/agent-conversation";

/** Token totals for the composer's context/input/output statusline.
 * Cost accounting and budget enforcement live separately in sessionCost and costGuardrails. */
export interface SessionUsage {
  /** Resident context of the latest completed turn (input + cache). */
  contextTokens: number;
  /** Prompt-side tokens across the whole session. */
  totalInput: number;
  /** Completion-side tokens (output + reasoning) across the whole session. */
  totalOutput: number;
}

/**
 * Compact token count: 820 -> "820", 41234 -> "41.2k", 1200000 -> "1.2M".
 * The M threshold sits just below 1M so 999,950+ rounds to "1M", not "1000k".
 */
export function fmtTokens(n: number): string {
  const scaled = (value: number, suffix: string) => {
    const rounded = Math.round(value * 10) / 10;
    const text = Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
    return text + suffix;
  };
  if (n >= 999_950) return scaled(n / 1_000_000, "M");
  if (n >= 1000) return scaled(n / 1000, "k");
  return String(n);
}

/** Format known nonzero token segments; null when there is nothing to show. */
export function usageStatusline(usage: SessionUsage | null): string | null {
  if (!usage) return null;
  const segments: string[] = [];
  if (usage.contextTokens > 0) segments.push(`ctx ${fmtTokens(usage.contextTokens)} tok`);
  if (usage.totalInput > 0) segments.push(`in ${fmtTokens(usage.totalInput)}`);
  if (usage.totalOutput > 0) segments.push(`out ${fmtTokens(usage.totalOutput)}`);
  return segments.length > 0 ? segments.join(" · ") : null;
}

/** True when a message reported any token counts at all. */
function hasUsage(m: AgentMessage): boolean {
  return (
    (m.inputTokens ?? 0) > 0 ||
    (m.outputTokens ?? 0) > 0 ||
    (m.cacheReadTokens ?? 0) > 0 ||
    (m.cacheWriteTokens ?? 0) > 0
  );
}

/**
 * Roll a conversation up into a `SessionUsage`.
 *
 * `contextTokens` is the resident window of the LATEST reporting turn (the
 * same `computeContextOccupancy` math ContextUsageRing paints) — not a
 * cross-turn sum, which would multi-count the re-sent window. `totalInput` /
 * `totalOutput` ARE cumulative token totals.
 */
export function sessionUsageFor(
  conversation: Pick<AgentConversation, "messages" | "model">,
): SessionUsage | null {
  let totalInput = 0;
  let totalOutput = 0;
  let latest: AgentMessage | undefined;

  for (const m of conversation.messages ?? []) {
    if (m.role !== "assistant") continue;
    totalInput += (m.inputTokens ?? 0) + (m.cacheReadTokens ?? 0) + (m.cacheWriteTokens ?? 0);
    totalOutput += (m.outputTokens ?? 0) + (m.reasoningTokens ?? 0);
    if (hasUsage(m)) latest = m;
  }

  if (totalInput === 0 && totalOutput === 0) return null;

  const contextTokens = latest
    ? computeContextOccupancy({
        inputTokens: latest.inputTokens,
        cacheReadTokens: latest.cacheReadTokens,
        cacheWriteTokens: latest.cacheWriteTokens,
        model: conversation.model,
      }).usedTokens
    : 0;

  return { contextTokens, totalInput, totalOutput };
}
