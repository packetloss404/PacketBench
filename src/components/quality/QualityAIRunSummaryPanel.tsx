import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2, Play, RefreshCw, Sparkles } from "lucide-react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import {
  cancelQualityRun,
  qualityEvents,
  runQualityChecks,
  type QualityCheckDoneEvent,
  type QualityRunSummary,
} from "@/lib/tauri";
import { QualityAISummary } from "./QualityAISummary";
import { clearQualityAISummaryCache } from "./qualityAIHelpers";

/** Runs detected checks and summarizes required failures; diagnostic output/history
 * is not exposed by this aggregate view. */
interface Props {
  projectPath: string;
  projectName: string;
}

type Phase =
  | { kind: "idle" }
  | { kind: "running"; runId: string; doneByLabel: Record<string, QualityCheckDoneEvent> }
  | { kind: "complete"; runHash: string; checks: QualityCheckDoneEvent[]; cancelled: boolean }
  | { kind: "error"; message: string };

export function QualityAIRunSummaryPanel({ projectPath, projectName }: Props) {
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const unlistenCheckDoneRef = useRef<UnlistenFn | null>(null);
  const unlistenDoneRef = useRef<UnlistenFn | null>(null);
  const unlistenErrorRef = useRef<UnlistenFn | null>(null);
  const mountedRef = useRef(true);
  const runIdRef = useRef<string | null>(null);
  const cancelRequestedRef = useRef(false);
  const [cancelError, setCancelError] = useState<string | null>(null);
  const collectedRef = useRef<Record<string, QualityCheckDoneEvent>>({});

  const tearDown = useCallback(() => {
    unlistenCheckDoneRef.current?.();
    unlistenDoneRef.current?.();
    unlistenErrorRef.current?.();
    unlistenCheckDoneRef.current = null;
    unlistenDoneRef.current = null;
    unlistenErrorRef.current = null;
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    setPhase({ kind: "idle" });
    return () => {
      mountedRef.current = false;
      tearDown();
      // Best-effort cancel of any in-flight run when the modal closes.
      if (runIdRef.current) {
        void cancelQualityRun(runIdRef.current).catch(() => {});
        runIdRef.current = null;
      }
    };
  }, [projectPath, tearDown]);

  const runChecksAndSummarize = useCallback(async () => {
    if (runIdRef.current) return;
    tearDown();
    collectedRef.current = {};
    cancelRequestedRef.current = false;
    setCancelError(null);

    const runId = `quality-ai-run-${crypto.randomUUID()}`;
    runIdRef.current = runId;
    const current = () => mountedRef.current && runIdRef.current === runId;
    try {
      setPhase({ kind: "running", runId, doneByLabel: {} });

      // Subscribe BEFORE invoking — the first chunk can land before
      // `runQualityChecks` resolves.
      const unlistenCheckDone = await listen<QualityCheckDoneEvent>(
        qualityEvents.checkDone(runId),
        (event) => {
          if (!mountedRef.current) return;
          if (runIdRef.current !== runId) return;
          const ev = event.payload;
          collectedRef.current[ev.label] = ev;
          setPhase({
            kind: "running",
            runId,
            doneByLabel: { ...collectedRef.current },
          });
        },
      );
      if (!current()) {
        unlistenCheckDone();
        return;
      }
      unlistenCheckDoneRef.current = unlistenCheckDone;

      const unlistenDone = await listen<QualityRunSummary>(qualityEvents.done(runId), (event) => {
        if (!mountedRef.current) return;
        if (runIdRef.current !== runId) return;
        const checks = event.payload.checks;
        const runHash = buildRunHash(runId, checks);
        tearDown();
        runIdRef.current = null;
        // Wipe any prior cached summary for the same hash — defensive,
        // a fresh run id should already mint a fresh hash. Per-key
        // delete (peer review fix): avoids wiping another modal
        // instance's cached summary running in parallel.
        clearQualityAISummaryCache(runHash);
        setPhase({ kind: "complete", runHash, checks, cancelled: event.payload.cancelled });
      });
      if (!current()) {
        unlistenDone();
        return;
      }
      unlistenDoneRef.current = unlistenDone;

      const unlistenError = await listen<{ message: string }>(
        qualityEvents.error(runId),
        (event) => {
          if (!mountedRef.current) return;
          if (runIdRef.current !== runId) return;
          tearDown();
          runIdRef.current = null;
          setPhase({
            kind: "error",
            message: event.payload?.message || "Quality run failed",
          });
        },
      );
      if (!current()) {
        unlistenError();
        return;
      }
      unlistenErrorRef.current = unlistenError;

      if (cancelRequestedRef.current) {
        tearDown();
        runIdRef.current = null;
        setPhase({ kind: "complete", runHash: runId, checks: [], cancelled: true });
        return;
      }
      await runQualityChecks(projectPath, runId, null);
      // A cancellation while the invoke was registering the run may have found
      // no backend entry yet. Repeat after registration rather than lose intent.
      if (!current() || cancelRequestedRef.current) await cancelQualityRun(runId);
    } catch (e) {
      if (!current()) return;
      tearDown();
      runIdRef.current = null;
      setPhase({
        kind: "error",
        message: e instanceof Error ? e.message : String(e),
      });
    }
  }, [projectPath, tearDown]);

  const cancel = async () => {
    const runId = runIdRef.current;
    if (!runId) return;
    cancelRequestedRef.current = true;
    setCancelError(null);
    try {
      await cancelQualityRun(runId);
    } catch (error) {
      if (runIdRef.current === runId) setCancelError(String(error));
    }
  };

  if (phase.kind === "idle") {
    return (
      <div className="flex flex-col gap-2 rounded-lg border border-bg-border bg-bg-primary p-3">
        <div className="flex items-center gap-2">
          <Sparkles size={12} className="text-accent-purple" />
          <span className="text-[11px] font-semibold text-text-primary">AI run summary</span>
        </div>
        <p className="text-[10px] leading-relaxed text-text-muted">
          Run the project's lint / typecheck / test / build pipeline and get a structured AI summary
          of every failure — what's failing, root-cause hypotheses, and the order to fix them.
        </p>
        <button
          type="button"
          onClick={runChecksAndSummarize}
          className="inline-flex items-center gap-1.5 self-start rounded border border-accent-purple/30 bg-accent-purple/15 px-2.5 py-1 text-[11px] font-medium text-accent-purple transition-colors hover:bg-accent-purple/25"
        >
          <Play size={11} />
          Run checks + summarize
        </button>
      </div>
    );
  }

  if (phase.kind === "running") {
    const progress = Object.values(phase.doneByLabel);
    return (
      <div className="flex flex-col gap-2 rounded-lg border border-bg-border bg-bg-primary p-3">
        <div className="flex items-center gap-2">
          <Loader2 size={12} className="animate-spin text-accent-purple" />
          <span className="text-[11px] font-semibold text-text-primary">
            Running quality checks…
          </span>
          <button
            type="button"
            onClick={() => void cancel()}
            className="text-xs text-text-muted hover:text-text-primary"
          >
            Cancel checks
          </button>
        </div>
        {cancelError && (
          <p role="alert" className="text-xs text-accent-red">
            {cancelError}
          </p>
        )}
        <div className="flex flex-col gap-0.5 text-[10px] text-text-muted">
          {progress.length === 0 && <span className="italic">Spawning checks…</span>}
          {progress.map((p) => (
            <span key={p.checkId} className="font-mono">
              {p.status === "passed" ? "[ok]  " : "[fail]"} {p.label}
              {p.exitCode !== null && p.exitCode !== 0 && (
                <span className="text-accent-red"> (exit {p.exitCode})</span>
              )}
            </span>
          ))}
        </div>
      </div>
    );
  }

  if (phase.kind === "error") {
    return (
      <div className="flex flex-col gap-2 rounded-lg border border-bg-border bg-bg-primary p-3">
        <div className="flex items-center gap-2">
          <Sparkles size={12} className="text-accent-red" />
          <span className="text-[11px] font-semibold text-accent-red">Quality run failed</span>
        </div>
        <div className="rounded border border-accent-red/30 bg-accent-red/10 px-3 py-2 text-[11px] text-accent-red">
          {phase.message}
        </div>
        <button
          type="button"
          onClick={runChecksAndSummarize}
          className="inline-flex items-center gap-1 self-start text-[10px] text-text-muted transition-colors hover:text-accent-purple"
        >
          <RefreshCw size={10} />
          Retry
        </button>
      </div>
    );
  }

  if (phase.cancelled) {
    return (
      <div className="p-3 text-xs text-text-muted">
        Quality checks cancelled.
        <button type="button" onClick={runChecksAndSummarize} className="ml-2">
          Re-run checks
        </button>
      </div>
    );
  }

  // phase.kind === "complete"
  const failingChecks = phase.checks.filter(
    (c) => c.status !== "passed" && c.status !== "skipped" && !c.optional,
  );

  if (failingChecks.length === 0) {
    return (
      <div className="flex flex-col gap-2 rounded-lg border border-accent-green/20 bg-accent-green/5 p-3">
        <div className="flex items-center gap-2">
          <Sparkles size={12} className="text-accent-green" />
          <span className="text-[11px] font-semibold text-accent-green">All checks passed</span>
        </div>
        <p className="text-[10px] leading-relaxed text-text-muted">
          Every required check returned successfully. Nothing to summarize.
        </p>
        <button
          type="button"
          onClick={runChecksAndSummarize}
          className="inline-flex items-center gap-1 self-start text-[10px] text-text-muted transition-colors hover:text-accent-purple"
        >
          <RefreshCw size={10} />
          Re-run
        </button>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      <QualityAISummary
        runHash={phase.runHash}
        projectName={projectName}
        checks={failingChecks.map((c) => ({
          name: c.label,
          exitCode: c.exitCode ?? 1,
          output: c.output,
        }))}
      />
      <button
        type="button"
        onClick={runChecksAndSummarize}
        className="inline-flex items-center gap-1 self-start px-3 text-[10px] text-text-muted transition-colors hover:text-accent-purple"
      >
        <RefreshCw size={10} />
        Re-run checks
      </button>
    </div>
  );
}

/**
 * Build a stable cache key from the run id + each check's name + exit
 * code + output byte length. Same run = same hash; a re-run mints a
 * fresh run id and therefore a fresh hash, invalidating the cache.
 */
function buildRunHash(runId: string, checks: QualityCheckDoneEvent[]): string {
  const parts = [runId];
  for (const c of checks.slice().sort((a, b) => a.label.localeCompare(b.label))) {
    parts.push(`${c.label}:${c.exitCode ?? "x"}:${c.output.length}`);
  }
  return parts.join("|");
}
