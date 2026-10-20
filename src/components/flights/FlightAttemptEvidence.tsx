import { useEffect, useState } from "react";
import { FileCode2, Loader2, RefreshCw } from "lucide-react";
import { getGitReviewEvidence, toGitServerConfigInput, type GitReviewEvidence } from "@/lib/tauri";
import { extractReviewChecks } from "@/lib/reviewerGate";
import { useServerStore } from "@/stores/serverStore";
import type { AgentConversation } from "@/types/agent-conversation";
import type { Attempt } from "@/types/flight";

/** Keep code, check provenance and the reviewed commit together. Loading a diff
 * is read-only; acceptance/delivery still validate freshness in the backend. */
export function FlightAttemptEvidence({
  attempt,
  conversation,
  heading = "Changes and checks",
  range,
  description,
  showChecks = true,
}: {
  attempt: Pick<
    Attempt,
    "id" | "target" | "status" | "branch" | "baseBranch" | "reviewGate" | "recovery"
  >;
  conversation?: AgentConversation;
  heading?: string;
  range?: { baseSha: string; headSha: string };
  description?: string;
  showChecks?: boolean;
}) {
  const servers = useServerStore((state) => state.servers);
  const [evidence, setEvidence] = useState<GitReviewEvidence | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [revision, setRevision] = useState(0);
  const snapshot = attempt.reviewGate?.evidence;
  const baseSha = range?.baseSha ?? snapshot?.baseSha;
  const headSha = range?.headSha ?? snapshot?.headSha;
  const basePath = attempt.target.basePath;
  const worktreePath = attempt.target.worktreePath;
  const serverId = attempt.target.kind === "ssh" ? attempt.target.serverId : null;
  const retained = attempt.recovery?.state === "retained";
  const settled = ["completed", "failed", "cancelled"].includes(attempt.status) && !retained;
  const checks = extractReviewChecks(conversation);
  const reviewable = ["reviewing", "completed", "failed", "cancelled"].includes(attempt.status);

  useEffect(() => {
    if (!reviewable) {
      setEvidence(null);
      setError(null);
      setLoading(false);
      return;
    }
    let current = true;
    setLoading(true);
    setError(null);
    setEvidence(null);
    void (async () => {
      const server = serverId ? servers.find((item) => item.id === serverId) : undefined;
      if (serverId && !server?.hostFingerprint) {
        throw new Error(
          "The saved SSH host must be available and verified to inspect this result.",
        );
      }
      // A committed result remains inspectable after its worktree is cleaned.
      // Failed/stopped attempts may have retained dirty work; inspect that path.
      const path = settled ? basePath : worktreePath;
      const result = await getGitReviewEvidence(
        path,
        baseSha ?? attempt.baseBranch,
        server ? toGitServerConfigInput(server) : null,
        65_536,
        retained ? undefined : (headSha ?? (settled ? attempt.branch : undefined)),
      );
      if (!result || !Array.isArray(result.changedPaths))
        throw new Error(
          "Change evidence is unavailable. Inspect the branch in Workspace or try again.",
        );
      if (current) setEvidence(result);
    })()
      .catch((reason) => {
        if (current) setError(reason instanceof Error ? reason.message : String(reason));
      })
      .finally(() => {
        if (current) setLoading(false);
      });
    return () => {
      current = false;
    };
  }, [
    attempt.id,
    attempt.status,
    attempt.branch,
    attempt.baseBranch,
    basePath,
    worktreePath,
    serverId,
    retained,
    settled,
    baseSha,
    headSha,
    reviewable,
    revision,
    servers,
  ]);

  return (
    <section
      aria-label={heading}
      className="min-w-0 space-y-3 border-t border-bg-border px-3 py-3 text-xs"
    >
      <div className="flex flex-wrap items-center gap-2">
        <FileCode2 size={13} className="text-accent-blue" />
        <h4 className="font-semibold text-text-primary">{heading}</h4>
        {reviewable && (
          <button
            type="button"
            disabled={loading}
            onClick={() => setRevision((value) => value + 1)}
            className="ml-auto flex items-center gap-1 rounded border border-bg-border px-2 py-1 text-[11px] text-text-secondary disabled:opacity-50"
          >
            {loading ? <Loader2 size={11} className="animate-spin" /> : <RefreshCw size={11} />}{" "}
            Refresh changes
          </button>
        )}
      </div>
      {!reviewable && (
        <p className="text-text-muted">
          The agent is working. Changes will appear here when a result is ready.
        </p>
      )}
      {loading && (
        <p role="status" className="text-text-muted">
          Loading changed files and diff…
        </p>
      )}
      {error && (
        <p role="alert" className="break-words text-accent-amber">
          {error}
        </p>
      )}
      {evidence && (
        <>
          <p className="text-[11px] text-text-muted">
            {description ??
              (retained
                ? "Preserved work, including uncommitted changes."
                : snapshot
                  ? "Reviewed commit snapshot. Current code and criteria are rechecked when you accept or deliver."
                  : "Current change evidence. No independent review snapshot is attached.")}
          </p>
          <p className="break-words font-mono text-[11px] text-text-muted">
            {evidence.baseRef.slice(0, 12)} → {evidence.headRef.slice(0, 12)}
          </p>
          <div className="space-y-1">
            <p className="font-medium text-text-secondary">
              {evidence.changedPaths.length} changed file
              {evidence.changedPaths.length === 1 ? "" : "s"}
            </p>
            {evidence.changedPaths.length > 0 ? (
              <ul
                aria-label="Changed files"
                className="max-h-32 overflow-y-auto rounded border border-bg-border bg-bg-secondary px-3 py-2 font-mono text-[11px] text-text-secondary"
              >
                {evidence.changedPaths.map((path) => (
                  <li className="break-all" key={path}>
                    {path}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-text-muted">No changes found in this range.</p>
            )}
          </div>
          {evidence.patch && (
            <details open>
              <summary className="cursor-pointer font-medium text-text-secondary">
                Code diff
              </summary>
              <pre
                aria-label="Code diff"
                tabIndex={0}
                className="mt-2 max-h-80 overflow-auto rounded border border-bg-border bg-bg-secondary p-3 font-mono text-[11px] leading-relaxed text-text-secondary"
              >
                {evidence.patch}
              </pre>
            </details>
          )}
          {evidence.patchTruncated && (
            <p className="text-accent-amber">
              This diff is truncated. Inspect the remaining files in Workspace before accepting.
            </p>
          )}
        </>
      )}
      {showChecks && (
        <details open={checks.length > 0}>
          <summary className="cursor-pointer font-medium text-text-secondary">
            Builder-reported checks ({checks.length})
          </summary>
          <p className="mt-1 text-[11px] text-text-muted">
            These are tool results from the builder transcript. They were not independently executed
            by the reviewer.
          </p>
          {checks.length === 0 ? (
            <p className="mt-2 text-text-muted">No check results have been reported.</p>
          ) : (
            <ul className="mt-2 space-y-2">
              {checks.map((check, index) => (
                <li key={`${check.tool}-${index}`} className="rounded border border-bg-border p-2">
                  <span
                    className={check.status === "error" ? "text-accent-red" : "text-text-secondary"}
                  >
                    {check.status === "error" ? "Tool error" : "Tool completed"} · {check.tool}
                  </span>
                  {check.command && (
                    <pre className="mt-1 whitespace-pre-wrap break-all font-mono text-[11px] text-text-secondary">
                      {check.command}
                    </pre>
                  )}
                  {check.summary && (
                    <pre className="mt-1 whitespace-pre-wrap break-words text-[11px] text-text-muted">
                      {check.summary}
                    </pre>
                  )}
                </li>
              ))}
            </ul>
          )}
        </details>
      )}
    </section>
  );
}
