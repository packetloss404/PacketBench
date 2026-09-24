import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2, RefreshCw, Sparkles } from "lucide-react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { codeQualityAiSummarize } from "@/lib/tauri";
import { MarkdownRenderer } from "@/components/common/MarkdownRenderer";
import {
  deleteQualityAISummaryCache,
  getQualityAISummaryCache,
  setQualityAISummaryCache,
} from "./qualityAIHelpers";

/**
 * v0.8.8 quality ai — bottom-of-modal AI summary panel.
 *
 * Streams a high-level Markdown summary of every failing check in a run
 * (lint / typecheck / tests / build). Same one-shot `claude-oauth`
 * scoped API-agent event pattern. The final markdown is
 * cached in a module-level Map keyed on `runHash` so re-opening the
 * modal with the same run doesn't re-stream.
 *
 * `runHash` is supplied by the parent — typically derived from the
 * concatenation of all check outputs (q2 owns the runner state, so the
 * parent component synthesizes a stable hash from the run id + each
 * check's exit code + output length). When the parent passes a fresh
 * hash, the cached panel is invalidated and the kickoff button reappears.
 */

interface CheckOutput {
  name: string;
  exitCode: number;
  output: string;
}

interface Props {
  /** Stable identifier for this run (cache key). */
  runHash: string;
  /** Display label used in the prompt header (project name). */
  projectName: string;
  /** Every failing check the user wants summarized. */
  checks: CheckOutput[];
  /** When true (parent has no failing checks), render nothing. */
  hidden?: boolean;
}

type Status =
  | { kind: "idle" }
  | { kind: "streaming"; partial: string }
  // `done` is semantically distinct from `idle`: after a stream completes
  // the cached summary is rendered and `runSummary` should NOT treat the
  // panel as "never started". Without this state, `idle` would imply
  // "show the kickoff button" which is wrong for a finished run.
  | { kind: "done" }
  | { kind: "error"; message: string };

export function QualityAISummary({ runHash, projectName, checks, hidden }: Props) {
  const cached = getQualityAISummaryCache(runHash);
  const [status, setStatus] = useState<Status>({ kind: "idle" });

  const unlistenChunkRef = useRef<UnlistenFn | null>(null);
  const unlistenDoneRef = useRef<UnlistenFn | null>(null);
  const unlistenErrorRef = useRef<UnlistenFn | null>(null);
  const accumulatedRef = useRef<string>("");
  const mountedRef = useRef(true);
  const sessionIdRef = useRef<string | null>(null);

  const tearDown = useCallback(() => {
    unlistenChunkRef.current?.();
    unlistenDoneRef.current?.();
    unlistenErrorRef.current?.();
    unlistenChunkRef.current = null;
    unlistenDoneRef.current = null;
    unlistenErrorRef.current = null;
  }, []);

  useEffect(() => {
    return () => {
      mountedRef.current = false;
      tearDown();
    };
  }, [tearDown]);

  const runSummary = useCallback(async () => {
    if (status.kind === "streaming") return;
    if (checks.length === 0) return;
    tearDown();
    accumulatedRef.current = "";
    // Invalidate any prior cached summary so a re-run doesn't render the
    // old result alongside the new partial stream.
    deleteQualityAISummaryCache(runHash);
    setStatus({ kind: "streaming", partial: "" });

    try {
      const sessionId = `quality-ai-summary-${crypto.randomUUID()}`;
      sessionIdRef.current = sessionId;

      const unlistenChunk = await listen<string>(`api-agent:chunk:${sessionId}`, (event) => {
        if (!mountedRef.current) return;
        if (sessionIdRef.current !== sessionId) return;
        accumulatedRef.current += event.payload;
        setStatus({ kind: "streaming", partial: accumulatedRef.current });
      });
      unlistenChunkRef.current = unlistenChunk;

      const unlistenDone = await listen(`api-agent:done:${sessionId}`, () => {
        if (!mountedRef.current) return;
        if (sessionIdRef.current !== sessionId) return;
        const final = accumulatedRef.current.trim();
        tearDown();
        setQualityAISummaryCache(runHash, final);
        setStatus({ kind: "done" });
      });
      unlistenDoneRef.current = unlistenDone;

      const unlistenError = await listen<{ message: string }>(
        `api-agent:error:${sessionId}`,
        (event) => {
          if (!mountedRef.current) return;
          if (sessionIdRef.current !== sessionId) return;
          tearDown();
          setStatus({
            kind: "error",
            message: event.payload?.message || "Summary failed",
          });
        },
      );
      unlistenErrorRef.current = unlistenError;

      const checkOutputs: Record<string, string> = {};
      const checkExitCodes: Record<string, number> = {};
      for (const c of checks) {
        checkOutputs[c.name] = c.output;
        checkExitCodes[c.name] = c.exitCode;
      }

      await codeQualityAiSummarize(runHash, projectName, checkOutputs, checkExitCodes, sessionId);
    } catch (e) {
      tearDown();
      setStatus({
        kind: "error",
        message: e instanceof Error ? e.message : String(e),
      });
    }
  }, [status.kind, checks, runHash, projectName, tearDown]);

  if (hidden) return null;

  const isStreaming = status.kind === "streaming";
  const hasResult = !isStreaming && !!cached;

  // Empty state — kickoff button only.
  if (!isStreaming && !cached && status.kind !== "error") {
    return (
      <div className="flex flex-col gap-2 border-t border-bg-border bg-bg-secondary p-3">
        <div className="flex items-center gap-2">
          <Sparkles size={12} className="text-accent-purple" />
          <span className="text-[11px] font-semibold text-text-primary">AI summary</span>
        </div>
        <p className="text-[10px] leading-relaxed text-text-muted">
          Get a structured Markdown summary of every failing check — what's failing, root-cause
          hypotheses, and the order to fix them.
        </p>
        <button
          type="button"
          onClick={runSummary}
          disabled={checks.length === 0}
          className="inline-flex items-center gap-1.5 self-start rounded border border-accent-purple/30 bg-accent-purple/15 px-2.5 py-1 text-[11px] font-medium text-accent-purple transition-colors hover:bg-accent-purple/25 disabled:opacity-50"
        >
          <Sparkles size={11} />
          Get AI summary
        </button>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2 border-t border-bg-border bg-bg-secondary p-3">
      <div className="flex items-center gap-2">
        <Sparkles size={12} className="text-accent-purple" />
        <span className="text-[11px] font-semibold text-text-primary">AI summary</span>
        {isStreaming && (
          <span className="inline-flex items-center gap-1 text-[10px] text-text-muted">
            <Loader2 size={10} className="animate-spin" />
            Streaming…
          </span>
        )}
      </div>

      {isStreaming && (
        <div className="max-h-72 overflow-y-auto whitespace-pre-wrap rounded border border-bg-border bg-bg-primary px-2 py-1.5 font-mono text-[10px] leading-relaxed text-text-secondary">
          {status.partial || (
            <span className="italic text-text-muted">Waiting for first chunk…</span>
          )}
        </div>
      )}

      {hasResult && cached && (
        <div className="max-h-96 overflow-y-auto rounded border border-bg-border bg-bg-primary p-3 text-xs text-text-primary">
          <MarkdownRenderer content={cached} />
        </div>
      )}

      {status.kind === "error" && (
        <div className="rounded border border-accent-red/30 bg-accent-red/10 px-3 py-2 text-[11px] text-accent-red">
          {status.message}
        </div>
      )}

      {(hasResult || status.kind === "error") && (
        <button
          type="button"
          onClick={runSummary}
          disabled={checks.length === 0}
          className="inline-flex items-center gap-1 self-start text-[10px] text-text-muted transition-colors hover:text-accent-purple disabled:opacity-50"
        >
          <RefreshCw size={10} />
          Re-run
        </button>
      )}
    </div>
  );
}
