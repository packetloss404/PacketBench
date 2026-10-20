import { memo, useMemo, useState } from "react";
import { ChevronRight, Compass, XCircle } from "lucide-react";
import { parseToolInput } from "@/lib/parseToolInput";
import type { AgentToolCall } from "@/types/agent-conversation";

interface ExplorationRollupCardProps {
  toolCalls: AgentToolCall[];
  /** Whether the owning message is still streaming. Nothing ever settles a
   * tool call's "running" status on cancel/error/restart, so a settled
   * message can carry orphaned running calls forever — they must not keep
   * the card in its live "Exploring… (N in flight)" state. */
  isStreaming?: boolean;
}

/** True when this call settled with status === "error". Failed calls must
 * never vanish into a neutral rollup — surfaced as a red mark on the entry
 * and counted in the collapsed row. */
interface FailableEntry {
  id: string;
  failed: boolean;
}

interface ExplorationStats {
  fileReads: (FailableEntry & { path: string })[];
  searches: (FailableEntry & { query: string })[];
  listings: (FailableEntry & { path: string })[];
  /** Exploration calls still in flight (tool_start seen, no result yet).
   * Their input isn't known until the result event lands, so they only
   * contribute a live "N in flight" count. */
  running: number;
  /** Settled exploration calls whose status is "error". */
  failed: number;
  interrupted: number;
}

const READ_TOOLS = new Set(["read_file", "Read"]);
const SEARCH_TOOLS = new Set(["grep", "Grep", "glob", "Glob", "search"]);
const LIST_TOOLS = new Set(["list_directory", "list_files", "LS", "ls"]);

/** True when `name` is one of the exploration tools this card rolls up
 * (read/search/list). The single classifier ToolCallRenderer filters on so
 * the "which tools are exploration" list lives in exactly one place. */
export function isExplorationToolName(name: string): boolean {
  return READ_TOOLS.has(name) || SEARCH_TOOLS.has(name) || LIST_TOOLS.has(name);
}

function pickPath(args: Record<string, unknown>): string {
  const candidates = ["path", "file_path", "rel_path", "filename", "file"];
  for (const key of candidates) {
    const v = args[key];
    if (typeof v === "string" && v.length > 0) return v;
  }
  return "";
}

function pickQuery(args: Record<string, unknown>): string {
  const candidates = ["query", "pattern", "search", "regex"];
  for (const key of candidates) {
    const v = args[key];
    if (typeof v === "string" && v.length > 0) return v;
  }
  return "";
}

function ExplorationRollupCardImpl({ toolCalls, isStreaming }: ExplorationRollupCardProps) {
  const [expanded, setExpanded] = useState(false);

  const stats = useMemo<ExplorationStats>(() => {
    const fileReads: ExplorationStats["fileReads"] = [];
    const searches: ExplorationStats["searches"] = [];
    const listings: ExplorationStats["listings"] = [];
    let running = 0;
    let failed = 0;
    let interrupted = 0;
    for (const tc of toolCalls) {
      const isExploration = isExplorationToolName(tc.name);
      if (!isExploration) continue;
      if (tc.interrupted) {
        interrupted += 1;
        continue;
      }
      if (tc.status === "running") {
        running += 1;
        continue;
      }
      const isFailed = tc.status === "error";
      if (isFailed) failed += 1;
      const args = parseToolInput(tc.input) ?? {};
      if (READ_TOOLS.has(tc.name)) {
        const path = pickPath(args) || tc.file || "";
        if (path) fileReads.push({ id: tc.id, path, failed: isFailed });
      } else if (SEARCH_TOOLS.has(tc.name)) {
        const query = pickQuery(args);
        if (query) searches.push({ id: tc.id, query, failed: isFailed });
      } else if (LIST_TOOLS.has(tc.name)) {
        const path = pickPath(args);
        if (path) listings.push({ id: tc.id, path, failed: isFailed });
      }
    }
    return { fileReads, searches, listings, running, failed, interrupted };
  }, [toolCalls]);

  // Once the message has settled, any still-"running" calls are orphans
  // (cancelled turn, backend error, or hydrated transcript) — ignore them so
  // the card can't display "Exploring… (N in flight)" forever, matching the
  // pre-rollup behavior where such calls simply became invisible at settle.
  // Error status is disjoint from running, so the failed counter is untouched
  // by this settle-orphan gate.
  const running = isStreaming ? stats.running : 0;
  const total = stats.fileReads.length + stats.searches.length + stats.listings.length;
  // A lone failed exploration call (e.g. unparseable input, so it never made
  // it into fileReads/searches/listings) must still surface the card — never
  // let it vanish into a neutral rollup.
  if (total === 0 && running === 0 && stats.failed === 0 && stats.interrupted === 0) return null;

  const summaryParts: string[] = [];
  if (stats.fileReads.length > 0) {
    summaryParts.push(`${stats.fileReads.length} file${stats.fileReads.length === 1 ? "" : "s"}`);
  }
  if (stats.searches.length > 0) {
    summaryParts.push(`${stats.searches.length} search${stats.searches.length === 1 ? "" : "es"}`);
  }
  if (stats.listings.length > 0) {
    summaryParts.push(`${stats.listings.length} listing${stats.listings.length === 1 ? "" : "s"}`);
  }
  // Live/incremental: the card is THE streaming representation of exploration
  // tools (they never render individual cards), so counts tick up as results
  // land and only the verb flips at stream settle — no layout snap.
  const verb =
    running > 0
      ? "Exploring"
      : total === 0 && stats.interrupted > 0
        ? "Exploration interrupted"
        : "Explored";
  const summary =
    summaryParts.length > 0
      ? `${verb} ${summaryParts.join(", ")}${running > 0 ? ` (${running} in flight)` : ""}`
      : running > 0
        ? `Exploring (${running} in flight)…`
        : // Reachable only when the only exploration activity is a failed
          // call with unparseable input (no path/query to list) — the
          // failed-count segment below carries the detail.
          verb;

  return (
    // `bg-bg-hover` is the app's PRESSED token — as a resting fill it made this
    // card read as permanently hovered, the same bug wave 1 fixed on
    // BaseToolCard. It now matches the one card background in the transcript.
    <div className="overflow-hidden rounded-xl border border-bg-border bg-bg-tertiary text-ui text-text-muted transition-colors hover:border-line-strong">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
        className="flex w-full items-center gap-2 px-3 py-2 text-left transition-colors hover:text-text-primary"
      >
        <ChevronRight
          size={12}
          className={`shrink-0 transition-transform motion-reduce:transition-none ${
            expanded ? "rotate-90" : ""
          }`}
        />
        <Compass size={12} className="shrink-0 text-text-muted" />
        <span className="flex-1 truncate text-ui text-text-secondary">{summary}</span>
        {stats.failed > 0 && (
          <span className="shrink-0 text-ui text-accent-red">· {stats.failed} failed</span>
        )}
        {stats.interrupted > 0 && (
          <span className="shrink-0 text-ui text-accent-amber">
            · {stats.interrupted} interrupted
          </span>
        )}
      </button>
      {expanded && (
        <div className="selectable flex max-h-64 flex-col gap-0.5 overflow-y-auto border-t border-bg-border px-3 pb-2">
          {stats.fileReads.length > 0 && (
            <div className="pt-1">
              <div className="mb-0.5 text-meta uppercase tracking-wide text-text-faint">Read</div>
              {stats.fileReads.map((r) => (
                <div
                  key={r.id}
                  className={`flex items-center gap-1 truncate font-mono text-meta ${
                    r.failed ? "text-accent-red" : "text-text-secondary"
                  }`}
                  title={r.path}
                >
                  {r.failed && <XCircle size={9} className="shrink-0" />}
                  {r.path}
                </div>
              ))}
            </div>
          )}
          {stats.searches.length > 0 && (
            <div className="pt-1">
              <div className="mb-0.5 text-meta uppercase tracking-wide text-text-faint">
                Searched
              </div>
              {stats.searches.map((s) => (
                <div
                  key={s.id}
                  className={`flex items-center gap-1 truncate font-mono text-meta ${
                    s.failed ? "text-accent-red" : "text-text-secondary"
                  }`}
                  title={s.query}
                >
                  {s.failed && <XCircle size={9} className="shrink-0" />}
                  {s.query}
                </div>
              ))}
            </div>
          )}
          {stats.listings.length > 0 && (
            <div className="pt-1">
              <div className="mb-0.5 text-meta uppercase tracking-wide text-text-faint">Listed</div>
              {stats.listings.map((l) => (
                <div
                  key={l.id}
                  className={`flex items-center gap-1 truncate font-mono text-meta ${
                    l.failed ? "text-accent-red" : "text-text-secondary"
                  }`}
                  title={l.path}
                >
                  {l.failed && <XCircle size={9} className="shrink-0" />}
                  {l.path}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// Memoized so a streaming turn's frequent store updates only re-render
// the card whose toolCall reference actually changed, not all 40+ at once.
export const ExplorationRollupCard = memo(ExplorationRollupCardImpl);
