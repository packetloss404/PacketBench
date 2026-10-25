import { inspectRuntimeResume, resumeRuntimeRun } from "@/lib/tauri";
import type { RuntimeRunSummary } from "@/generated/tauri-schema";

/**
 * Resume a conversation's interrupted durable run (R1/R3).
 *
 * Inspects the run and picks the strongest permitted mode — `typed` when the
 * live policy still matches the checkpoint, otherwise `semantic` — then
 * advances the durable epoch. A `typed` resume echoes the inspected revision
 * token so a stale inspection is rejected; a `semantic` resume needs none.
 *
 * Throws (with the backend's incompatibilities) when no mode is permitted.
 */
export async function resumeConversationRun(
  run: RuntimeRunSummary,
): Promise<RuntimeRunSummary> {
  const inspection = await inspectRuntimeResume(run.runtimeRunId);
  const mode = inspection.permittedModes.includes("typed")
    ? "typed"
    : inspection.permittedModes.includes("semantic")
      ? "semantic"
      : null;
  if (!mode) {
    throw new Error(
      inspection.incompatibilities.join("; ") || "This run cannot be resumed.",
    );
  }
  return resumeRuntimeRun(
    run.runtimeRunId,
    run.epoch,
    mode,
    mode === "typed" ? (inspection.inspectedRevision ?? null) : null,
  );
}
