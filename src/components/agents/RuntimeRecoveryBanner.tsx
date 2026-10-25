import { useCallback, useEffect, useState } from "react";
import { AlertTriangle } from "lucide-react";
import { getConversationRuntime } from "@/lib/tauri";
import { resumeConversationRun } from "@/lib/runtimeRecovery";
import type { RuntimeRunSummary } from "@/generated/tauri-schema";

/**
 * R1/R3 recovery surface: when a conversation's durable run was left
 * `needs_reconciliation` by a crash (the startup reconcile marks it), offer a
 * **Resume** that continues from the run's durable history. Inert when the
 * runtime journal is disabled (the readout returns null) or the run is healthy.
 */
export function RuntimeRecoveryBanner({ conversationId }: { conversationId: string }) {
  const [run, setRun] = useState<RuntimeRunSummary | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setRun(await getConversationRuntime(conversationId));
    } catch {
      setRun(null);
    }
  }, [conversationId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Only a non-terminal run left by a crash is resumable; a healthy run has a
  // terminal (or running) state and shows nothing.
  if (!run || run.state !== "needs_reconciliation") return null;

  const onResume = async () => {
    setBusy(true);
    setError(null);
    try {
      await resumeConversationRun(run);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Resume failed.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      role="status"
      aria-live="polite"
      className="flex shrink-0 items-center gap-2 border-b border-bg-border bg-bg-secondary px-4 py-2 text-meta"
    >
      <AlertTriangle size={14} className="shrink-0 text-text-muted" />
      <span className="flex-1 text-text-secondary">
        This run was interrupted. Resume to continue from its durable history.
      </span>
      {error && <span className="text-accent-red">{error}</span>}
      <button
        type="button"
        onClick={() => void onResume()}
        disabled={busy}
        className="shrink-0 rounded border border-bg-border px-2 py-0.5 text-text-primary transition-colors hover:bg-bg-hover disabled:cursor-wait disabled:opacity-50 motion-reduce:transition-none"
      >
        {busy ? "Resuming…" : "Resume"}
      </button>
    </div>
  );
}
