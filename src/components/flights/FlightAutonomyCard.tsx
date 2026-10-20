import { useMemo, useState } from "react";
import { AlertTriangle, CirclePause, CirclePlay, ShieldAlert, Square } from "lucide-react";
import {
  pauseFlightAutonomy,
  startFlightAutonomy,
  stopFlightAutonomy,
} from "@/stores/boundedAutonomyRuntime";
import type { Flight } from "@/types/flight";
import { APP_NAME } from "@/lib/brand";

function formatCost(value: number): string {
  return `$${Math.max(0, value).toFixed(2)}`;
}

export function FlightAutonomyCard({ flight }: { flight: Flight }) {
  const [error, setError] = useState<string | null>(null);
  const [stopArmed, setStopArmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const runtime = flight.autonomyRuntime;
  const policy = flight.autonomyPolicy;
  const modeLabel =
    flight.autonomyMode === "yolo"
      ? "Bounded automatic actions"
      : flight.autonomyMode === "settings_default"
        ? policy
          ? "Bounded automatic actions · Settings snapshot"
          : "Assisted · Settings snapshot"
        : "Assisted";
  const recentActions = useMemo(
    () => [...(runtime?.actionHistory ?? [])].reverse().slice(0, 8),
    [runtime?.actionHistory],
  );
  const elapsedMinutes =
    runtime?.startedAt !== undefined
      ? Math.max(0, Math.floor((Date.now() - runtime.startedAt) / 60_000))
      : 0;

  async function run(action: () => void | Promise<void>) {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="rounded border border-bg-border bg-bg-secondary/35 px-3 py-2.5">
      <div className="flex items-center gap-2">
        <ShieldAlert size={12} className={policy ? "text-accent-amber" : "text-text-muted"} />
        <span className="text-[11px] font-medium text-text-secondary">
          Supervision · {modeLabel}
        </span>
        {runtime && (
          <span className="ml-auto rounded border border-bg-border px-1.5 py-0.5 text-[9px] uppercase tracking-wide text-text-muted">
            {runtime.status.replace(/_/g, " ")}
          </span>
        )}
      </div>

      {!policy ? (
        <p className="mt-1.5 text-[10px] leading-relaxed text-text-muted">
          {APP_NAME} recommends actions; launches, retries, review acceptance, and integration stay
          under your control.
        </p>
      ) : (
        <>
          <div className="mt-2 grid grid-cols-4 gap-2 text-[10px] text-text-muted">
            <div>
              <span className="block text-[9px] uppercase tracking-wide">Cost left</span>
              <span className="text-text-secondary">
                {formatCost(policy.maxTotalCost - flight.totalCost)}
              </span>
            </div>
            <div>
              <span className="block text-[9px] uppercase tracking-wide">Time left</span>
              <span className="text-text-secondary">
                {Math.max(0, policy.maxDurationMinutes - elapsedMinutes)}m
              </span>
            </div>
            <div>
              <span className="block text-[9px] uppercase tracking-wide">Retry cap</span>
              <span className="text-text-secondary">{policy.maxRetriesPerTask}/task</span>
            </div>
            <div>
              <span className="block text-[9px] uppercase tracking-wide">Concurrency</span>
              <span className="text-text-secondary">{policy.maxConcurrentAgents}</span>
            </div>
          </div>
          <p className="mt-2 text-[10px] leading-relaxed text-text-muted">
            {[
              policy.autoRecovery && "recovery",
              policy.autoReviewRemediation && "review remediation",
              policy.autoRunTaskGraph && "cooperative graph",
              policy.toolPosture === "allow_in_project" && "in-project tools",
            ]
              .filter(Boolean)
              .join(" · ") || "No autonomous adapters enabled"}
            . Final base-branch landing and reviewer overrides are always manual.
          </p>

          {runtime?.hardStopReason && (
            <div className="mt-2 flex items-start gap-1.5 rounded border border-accent-amber/30 bg-accent-amber/10 px-2 py-1 text-[10px] text-accent-amber">
              <AlertTriangle size={10} className="mt-px shrink-0" />
              {runtime.hardStopReason}
            </div>
          )}

          <div className="mt-2 flex flex-wrap gap-1.5">
            {runtime && ["idle", "paused", "needs_attention"].includes(runtime.status) && (
              <button
                type="button"
                disabled={busy}
                onClick={() => run(() => startFlightAutonomy(flight.id))}
                className="flex items-center gap-1 rounded border border-accent-green/35 bg-accent-green/10 px-2 py-0.5 text-[10px] text-accent-green"
              >
                <CirclePlay size={10} /> {runtime.status === "idle" ? "Start" : "Resume"}
              </button>
            )}
            {runtime?.status === "running" && (
              <button
                type="button"
                disabled={busy}
                onClick={() => run(() => pauseFlightAutonomy(flight.id))}
                className="flex items-center gap-1 rounded border border-bg-border px-2 py-0.5 text-[10px] text-text-secondary"
              >
                <CirclePause size={10} /> Pause
              </button>
            )}
            {runtime && !["stopped", "completed"].includes(runtime.status) && (
              <button
                type="button"
                disabled={busy}
                onClick={() => {
                  if (!stopArmed) {
                    setStopArmed(true);
                    return;
                  }
                  run(() => stopFlightAutonomy(flight.id, true));
                  setStopArmed(false);
                }}
                onBlur={() => setStopArmed(false)}
                className="flex items-center gap-1 rounded border border-accent-red/30 px-2 py-0.5 text-[10px] text-accent-red"
              >
                <Square size={9} /> {stopArmed ? "Confirm stop & retain work" : "Stop"}
              </button>
            )}
          </div>

          {recentActions.length > 0 && (
            <div className="mt-2 border-t border-bg-border pt-2">
              <div className="mb-1 text-[9px] uppercase tracking-wide text-text-muted">
                Autonomous action history
              </div>
              <div className="space-y-1">
                {recentActions.map((action) => (
                  <div key={action.id} className="flex gap-2 text-[10px] text-text-muted">
                    <span
                      className={
                        action.status === "failed"
                          ? "text-accent-red"
                          : action.status === "completed"
                            ? "text-accent-green"
                            : "text-accent-amber"
                      }
                    >
                      {action.status}
                    </span>
                    <span className="text-text-secondary">{action.kind.replace(/_/g, " ")}</span>
                    {action.subjectId && (
                      <span className="truncate font-mono">{action.subjectId}</span>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}
        </>
      )}

      {error && <p className="mt-2 text-[10px] text-accent-red">{error}</p>}
    </div>
  );
}
