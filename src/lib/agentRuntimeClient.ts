import {
  cancelRuntimeRun,
  getRuntimeLaunch,
  getRuntimeRun,
  listRuntimeEvents,
  prepareRuntimeRun,
} from "@/lib/tauri";
import type {
  FrozenRuntimeLaunch,
  PrepareRuntimeRunInput,
  PrepareRuntimeRunResult,
  RuntimeEventView,
  RuntimeLaunchView,
  RuntimeRunSummary,
} from "@/generated/tauri-schema";

/**
 * R1a runtime-journal client. The backend is inert unless
 * `PACKETBENCH_RUNTIME_JOURNAL=1`; this module is the seam the UX track will
 * consume once launch admission moves to the journal.
 */

/** Deterministic JSON with sorted object keys (canonical payload for digests). */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
}

/** `sha256:<64 lower-case hex>` of the canonical JSON payload. */
export async function computeRequestDigest(payload: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalJson(payload));
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  const hex = Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return `sha256:${hex}`;
}

export interface PrepareLaunchArgs {
  operationId: string;
  conversationId: string;
  kind: "initial" | "existing";
  launch: FrozenRuntimeLaunch;
  retryOfOperationId?: string;
}

/**
 * Prepare a runtime run: computes the canonical request digest, then calls the
 * idempotent backend. Repeating the same operation + payload returns the same
 * IDs; a changed payload is a backend conflict.
 */
export async function prepareRuntimeLaunch(
  args: PrepareLaunchArgs,
): Promise<PrepareRuntimeRunResult> {
  const input: PrepareRuntimeRunInput = {
    operationId: args.operationId,
    conversationId: args.conversationId,
    kind: args.kind,
    retryOfOperationId: args.retryOfOperationId,
    requestDigest: await computeRequestDigest({
      kind: args.kind,
      launch: args.launch,
      retryOfOperationId: args.retryOfOperationId ?? null,
    }),
    launch: args.launch,
  };
  return prepareRuntimeRun(input);
}

export const agentRuntimeClient = {
  prepareRuntimeLaunch,
  computeRequestDigest,
  canonicalJson,
  getLaunch: (operationId: string): Promise<RuntimeLaunchView> => getRuntimeLaunch(operationId),
  getRun: (runId: string): Promise<RuntimeRunSummary> => getRuntimeRun(runId),
  listEvents: (runId: string, afterSeq = -1, limit = 256): Promise<RuntimeEventView[]> =>
    listRuntimeEvents(runId, afterSeq, limit),
  cancel: (operationId: string, expectedEpoch: number): Promise<RuntimeLaunchView> =>
    cancelRuntimeRun(operationId, expectedEpoch),
};
