import { Rocket } from "lucide-react";
import { AttemptTile } from "./AttemptTile";
import type { Flight } from "@/types/flight";

export function AsyncFlightGrid({ flight, onLaunch }: { flight: Flight; onLaunch?: () => void }) {
  const attempts = flight.attempts ?? [];
  const sorted = [...attempts].sort((left, right) => {
    const rank = (attempt: (typeof attempts)[number]) =>
      attempt.delivery
        ? -1
        : attempt.recovery?.state === "retained"
          ? 0
          : attempt.status === "failed" && flight.delivery
            ? 3
            : attempt.status === "reviewing" || attempt.status === "failed"
              ? 0
              : attempt.status === "running" ||
                  attempt.status === "provisioning" ||
                  attempt.status === "queued"
                ? 1
                : 2;
    return rank(left) - rank(right) || (right.startedAt ?? 0) - (left.startedAt ?? 0);
  });
  return (
    <section aria-label="Flight attempts" className="min-w-0 space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-sm font-semibold text-text-primary">
          {attempts.length > 0 ? "Work and results" : "Ready to run"}
        </h2>
        <span className="text-[11px] text-text-muted">
          {attempts.length} attempt{attempts.length === 1 ? "" : "s"}
        </span>
        {onLaunch && (
          <button
            type="button"
            onClick={onLaunch}
            className="ml-auto inline-flex items-center gap-1.5 rounded border border-accent-line bg-accent-soft px-3 py-1.5 text-xs font-medium text-accent-green hover:bg-accent-green/15"
          >
            <Rocket size={12} />
            {attempts.length === 0 ? "Launch attempt" : "New attempt"}
          </button>
        )}
      </div>
      {attempts.length === 0 ? (
        <p className="rounded border border-dashed border-bg-border p-4 text-xs text-text-muted">
          No attempts yet. Review the outcome and checks, then choose an agent to run this work on
          an isolated branch.
        </p>
      ) : (
        <div className="grid min-w-0 grid-cols-1 gap-4">
          {sorted.map((attempt) => (
            <AttemptTile
              key={attempt.id}
              flight={flight}
              attempt={attempt}
              onNewAttempt={onLaunch}
            />
          ))}
        </div>
      )}
    </section>
  );
}
