import {
  useCallback,
  useDeferredValue,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
} from "react";
import {
  Archive,
  ArchiveRestore,
  BellRing,
  FolderOpen,
  Pin,
  Plus,
  Search,
  Server,
  Trash2,
} from "lucide-react";
import { useAgentTaskStore } from "@/stores/agentTaskStore";
import { useAgentApprovalStore } from "@/stores/agentApprovalStore";
import {
  useAgentSidebarPrefsStore,
  clampSidebarWidth,
  AGENT_SIDEBAR_DEFAULT_WIDTH,
  AGENT_SIDEBAR_MIN_WIDTH,
  AGENT_SIDEBAR_MAX_WIDTH,
} from "@/stores/agentSidebarPrefsStore";
import { useReviewStore } from "@/stores/reviewStore";
import {
  searchAgentConversations,
  type AgentSearchConversationResult,
  type AgentSearchHit,
} from "@/lib/agentSearch";
import { API_PROVIDERS } from "@/lib/api-models";
import { capabilitiesFor } from "@/lib/agentCapabilities";
import { ConfirmDeleteConversationModal } from "@/components/agents/ConfirmDeleteConversationModal";
import { Badge } from "@/components/ui/Badge";
import { EmptyState } from "@/components/ui/EmptyState";
import type { AgentConversation } from "@/types/agent-conversation";

type StatusFilter =
  | "all"
  | "running"
  | "needsYou"
  | "failed"
  | "finished"
  | "archived";

interface AgentSidebarProps {
  selectedId: string | null;
  onSelect: (conversationId: string) => void;
  onNewAgent: () => void;
}

function formatRelativeTime(timestamp: number): string {
  const elapsed = Date.now() - timestamp;
  if (elapsed < 60_000) return "now";
  const minutes = Math.floor(elapsed / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

function providerLabel(agent: string): string {
  const provider = API_PROVIDERS.find((candidate) => candidate.agentCli === agent);
  if (provider) {
    return provider.name.replace(" (API)", "").replace(" (Local)", "");
  }
  return agent;
}

/** Normalize separators + trailing slashes without touching case (Mac/SSH
 * paths are case-sensitive; collapsing to a canonical base is done by the
 * backend resolver when it exists). */
function normalizePath(path: string): string {
  return path.replace(/\\/g, "/").replace(/\/+$/, "");
}

/** F5: the stable base checkout a conversation belongs to. A worktree
 * conversation groups under its `worktree.basePath`, never under a path that
 * changes per thread. */
function baseProjectPath(conversation: AgentConversation): string {
  return conversation.worktree?.basePath ?? conversation.projectPath;
}

function projectKey(conversation: AgentConversation): string {
  if (conversation.sshTarget) {
    // Two repositories on one host stay distinguishable; `remotePath` is the
    // stable remote checkout identity, not the display name.
    return `ssh:${conversation.sshTarget.id}:${normalizePath(conversation.sshTarget.remotePath)}`;
  }
  return `local:${normalizePath(baseProjectPath(conversation))}`;
}

function projectLabel(conversation: AgentConversation, labels: Record<string, string>): string {
  if (conversation.sshTarget) {
    const parts = conversation.sshTarget.remotePath.replace(/\\/g, "/").split("/").filter(Boolean);
    const repo = parts[parts.length - 1] ?? conversation.sshTarget.remotePath;
    return `${repo} @ ${conversation.sshTarget.name}`;
  }
  const base = baseProjectPath(conversation);
  const custom = labels[base] ?? labels[conversation.projectPath];
  if (custom) return custom;
  const parts = normalizePath(base).split("/").filter(Boolean);
  return parts[parts.length - 1] ?? base;
}

/**
 * The four states a session row's dot can report. This replaces the old
 * `statusIcon` + `getStatusColor` pair, which painted `idle` and `active` the
 * SAME green (so a running turn was indistinguishable from a parked session)
 * and had no state at all for "this session is blocked on you".
 */
type DotState = "running" | "attention" | "failed" | "idle";

/**
 * Derivation (spec — Sidebar): a pending permission/edit outranks everything
 * because it is the only state that needs the user to come back; then a live
 * turn; then a failed one. `done` and `idle` both read as parked.
 */
function dotStateFor(status: AgentConversation["status"], attention: boolean): DotState {
  if (attention) return "attention";
  if (status === "active") return "running";
  if (status === "failed") return "failed";
  return "idle";
}

function StatusDot({ state }: { state: DotState }) {
  const tone =
    state === "running"
      ? "bg-accent-blue text-accent-blue shadow-[0_0_6px_currentColor] animate-pulse motion-reduce:animate-none"
      : state === "attention"
        ? "bg-accent-amber text-accent-amber shadow-[0_0_6px_currentColor]"
        : state === "failed"
          ? "bg-accent-red"
          : "bg-text-faint";
  return (
    <span
      aria-hidden="true"
      data-status={state}
      className={`h-[6px] w-[6px] shrink-0 rounded-full ${tone}`}
    />
  );
}

function statusWord(state: DotState): string {
  if (state === "attention") return "waiting for your answer";
  if (state === "running") return "running";
  if (state === "failed") return "failed";
  return "idle";
}

function sortConversations(
  conversations: AgentConversation[],
  prefs: Record<string, { pinned?: boolean }>,
): AgentConversation[] {
  return [...conversations].sort((left, right) => {
    const leftPinned = prefs[left.id]?.pinned === true;
    const rightPinned = prefs[right.id]?.pinned === true;
    if (leftPinned !== rightPinned) return leftPinned ? -1 : 1;
    return right.updatedAt - left.updatedAt;
  });
}

/** Safe text highlighting — segments split on literal `matchRanges` offsets.
 * No HTML interpolation: every match is a React text node in a `<mark>`. */
function HighlightedExcerpt({
  excerpt,
  matchRanges,
}: {
  excerpt: string;
  matchRanges: Array<{ start: number; end: number }>;
}) {
  if (matchRanges.length === 0) return <>{excerpt}</>;
  const parts: ReactNode[] = [];
  let cursor = 0;
  matchRanges.forEach((range, index) => {
    if (range.start > cursor) {
      parts.push(<span key={`plain-${index}`}>{excerpt.slice(cursor, range.start)}</span>);
    }
    parts.push(
      <mark
        key={`match-${index}`}
        className="rounded-sm bg-accent-amber/25 text-text-primary"
      >
        {excerpt.slice(range.start, range.end)}
      </mark>,
    );
    cursor = range.end;
  });
  if (cursor < excerpt.length) {
    parts.push(<span key="tail">{excerpt.slice(cursor)}</span>);
  }
  return <>{parts}</>;
}

export function AgentSidebar({ selectedId, onSelect, onNewAgent }: AgentSidebarProps) {
  const conversations = useAgentTaskStore((state) => state.conversations);
  const archiveConversation = useAgentTaskStore((state) => state.archiveConversation);
  const unarchiveConversation = useAgentTaskStore((state) => state.unarchiveConversation);
  const renameConversation = useAgentTaskStore((state) => state.renameConversation);
  const pendingPermissions = useAgentApprovalStore((state) => state.permissions);
  const pendingEdits = useAgentApprovalStore((state) => state.edits);
  const prefs = useAgentSidebarPrefsStore((state) => state.prefs);
  const togglePinned = useAgentSidebarPrefsStore((state) => state.togglePinned);
  const projectLabels = useAgentSidebarPrefsStore((state) => state.projectLabels);
  const width = useAgentSidebarPrefsStore((state) => state.width);
  const setWidth = useAgentSidebarPrefsStore((state) => state.setWidth);

  const [filter, setFilter] = useState<StatusFilter>("all");
  const [query, setQuery] = useState("");
  const [includeArchived, setIncludeArchived] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<AgentConversation | null>(null);
  // Inline rename: the row being edited plus its draft text.
  const [editing, setEditing] = useState<{
    id: string;
    draft: string;
  } | null>(null);
  const deferredQuery = useDeferredValue(query.trim());
  const needsYouIds = useMemo(() => {
    const result = new Set<string>();
    for (const conversation of conversations) {
      if (
        (pendingPermissions.get(conversation.id)?.length ?? 0) > 0 ||
        (pendingEdits.get(conversation.id)?.length ?? 0) > 0
      ) {
        result.add(conversation.id);
      }
    }
    return result;
  }, [conversations, pendingPermissions, pendingEdits]);

  // F7 — distinct filter states. `running` no longer swallows `idle`, and
  // `failed` is its own state rather than being laundered into `done`.
  const counts = useMemo(() => {
    const result = { all: 0, running: 0, needsYou: 0, failed: 0, finished: 0, archived: 0 };
    for (const conversation of conversations) {
      if (conversation.archived) {
        result.archived += 1;
        continue;
      }
      result.all += 1;
      if (needsYouIds.has(conversation.id)) result.needsYou += 1;
      if (conversation.status === "active") result.running += 1;
      else if (conversation.status === "failed") result.failed += 1;
      else if (conversation.status === "done") result.finished += 1;
    }
    return result;
  }, [conversations, needsYouIds]);

  const filtered = useMemo(() => {
    let result = conversations.filter((conversation) =>
      filter === "archived" ? conversation.archived : !conversation.archived,
    );
    if (filter === "running") {
      result = result.filter((conversation) => conversation.status === "active");
    } else if (filter === "needsYou") {
      result = result.filter((conversation) => needsYouIds.has(conversation.id));
    } else if (filter === "failed") {
      result = result.filter((conversation) => conversation.status === "failed");
    } else if (filter === "finished") {
      result = result.filter((conversation) => conversation.status === "done");
    }
    return sortConversations(result, prefs);
  }, [conversations, filter, prefs, needsYouIds]);

  // F7 — search produces grouped matching-thread results (not a flat filter).
  const searchResults = useMemo<AgentSearchConversationResult[]>(() => {
    if (!deferredQuery) return [];
    const scope = conversations.filter((c) =>
      filter === "archived" ? c.archived : !c.archived || includeArchived,
    );
    return searchAgentConversations(scope, deferredQuery, { includeArchived });
  }, [conversations, deferredQuery, filter, includeArchived]);

  const needsYou = useMemo(
    () =>
      filter === "archived" || deferredQuery
        ? []
        : filtered.filter((conversation) => needsYouIds.has(conversation.id)),
    [deferredQuery, filter, filtered, needsYouIds],
  );

  const groups = useMemo(() => {
    const map = new Map<string, AgentConversation[]>();
    for (const conversation of filtered) {
      if (needsYouIds.has(conversation.id) && needsYou.length > 0) continue;
      const key = projectKey(conversation);
      const group = map.get(key) ?? [];
      group.push(conversation);
      map.set(key, group);
    }
    return map;
  }, [filtered, needsYou.length, needsYouIds]);

  const commitRename = useCallback(() => {
    if (!editing) return;
    const { id, draft } = editing;
    setEditing(null);
    const next = draft.trim();

    const conversation = conversations.find((c) => c.id === id);
    if (!next || next === (conversation?.title ?? "")) return;
    renameConversation(id, next);
  }, [conversations, editing, renameConversation]);

  // F7 — navigating a search hit: select the conversation and, for a message
  // hit, arm the stable message/revision target for MessageList to consume.
  const navigateToHit = useCallback(
    (result: AgentSearchConversationResult, hit?: AgentSearchHit) => {
      onSelect(result.conversationId);
      if (hit?.messageId) {
        useReviewStore.getState().setSearchNavigation({
          conversationId: result.conversationId,
          messageId: hit.messageId,
          transcriptRevisionId: hit.transcriptRevisionId,
          token: `search:${result.conversationId}:${hit.messageId}:${Date.now()}`,
        });
      }
    },
    [onSelect],
  );

  // V7 — resizable sidebar. Drag updates one measured layout per frame and
  // persists only on release; keyboard + double-click give the same control.
  const [dragWidth, setDragWidth] = useState<number | null>(null);
  const appliedWidth = dragWidth ?? width;
  const dragRef = useRef<{ startX: number; startWidth: number } | null>(null);
  const currentDragWidthRef = useRef(width);
  const rafRef = useRef<number | null>(null);

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    dragRef.current = { startX: event.clientX, startWidth: width };
    currentDragWidthRef.current = width;
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    if (!dragRef.current) return;
    const next = clampSidebarWidth(
      dragRef.current.startWidth + (event.clientX - dragRef.current.startX),
    );
    currentDragWidthRef.current = next;
    if (rafRef.current == null) {
      rafRef.current = requestAnimationFrame(() => {
        rafRef.current = null;
        setDragWidth(currentDragWidthRef.current);
      });
    }
  };
  const endDrag = () => {
    if (!dragRef.current) return;
    dragRef.current = null;
    if (rafRef.current != null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    setWidth(currentDragWidthRef.current);
    setDragWidth(null);
  };
  const onSeparatorKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Home") {
      event.preventDefault();
      setWidth(AGENT_SIDEBAR_MIN_WIDTH);
      return;
    }
    if (event.key === "End") {
      event.preventDefault();
      setWidth(AGENT_SIDEBAR_MAX_WIDTH);
      return;
    }
    const step = event.shiftKey ? 32 : 8;
    if (event.key === "ArrowLeft") {
      event.preventDefault();
      setWidth(width - step);
    } else if (event.key === "ArrowRight") {
      event.preventDefault();
      setWidth(width + step);
    }
  };

  const renderConversation = (conversation: AgentConversation, attention: boolean) => {
    const selected = conversation.id === selectedId;
    const pinned = prefs[conversation.id]?.pinned === true;
    const dot = dotStateFor(conversation.status, attention);
    const busy = conversation.status === "active";
    const canRename = !busy && capabilitiesFor(conversation).canRename;
    const rowShell = `group relative rounded-lg ${selected ? "bg-bg-hover" : ""}`;
    const fullTitle = conversation.title || "(untitled)";

    if (editing?.id === conversation.id) {
      return (
        <div
          key={conversation.id}
          className={`${rowShell} flex items-center gap-2 py-[5px] pl-[26px] pr-2`}
        >
          <StatusDot state={dot} />
          <input
            aria-label="Rename conversation"
            autoFocus
            value={editing.draft}
            onChange={(event) =>
              setEditing({
                id: conversation.id,
                draft: event.target.value,
              })
            }
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                commitRename();
              } else if (event.key === "Escape") {
                event.preventDefault();
                setEditing(null);
              }
            }}
            onBlur={commitRename}
            className="min-w-0 flex-1 rounded-md border border-accent-blue bg-bg-elevated px-1 py-px text-ui text-text-primary outline-none"
          />
        </div>
      );
    }

    return (
      <div key={conversation.id} className={rowShell}>
        <button
          type="button"
          onClick={() => onSelect(conversation.id)}
          onDoubleClick={() => {
            if (canRename) {
              setEditing({
                id: conversation.id,
                draft: conversation.title ?? "",
              });
            }
          }}
          onKeyDown={(event) => {
            if (event.key === "F2" && canRename) {
              event.preventDefault();
              setEditing({
                id: conversation.id,
                draft: conversation.title ?? "",
              });
            }
          }}
          // The complete title + provider + status are disclosed on hover /
          // focus, so a long title is never reduced to its truncated cell.
          title={`${fullTitle} — ${providerLabel(conversation.agent)} · ${statusWord(dot)}${
            canRename ? " — double-click or F2 to rename" : ""
          }`}
          aria-label={`${fullTitle}, ${providerLabel(conversation.agent)}, ${statusWord(dot)}`}
          className={`flex w-full items-center gap-2 rounded-lg py-[5px] pl-[26px] pr-2 text-left text-ui transition-colors ${
            selected
              ? "text-text-primary"
              : "text-text-secondary hover:bg-bg-elevated hover:text-text-primary"
          }`}
          aria-current={selected ? "page" : undefined}
        >
          <StatusDot state={dot} />
          <span className="min-w-0 flex-1 truncate">{fullTitle}</span>
          {/* The hover actions sit ON this cell, so it fades rather than
              reflowing the row when the pointer arrives. */}
          <span className="shrink-0 font-mono text-meta text-text-faint transition-opacity group-focus-within:opacity-0 group-hover:opacity-0">
            {formatRelativeTime(conversation.updatedAt)}
          </span>
        </button>
        <div className="absolute right-1 top-1/2 flex -translate-y-1/2 items-center opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100">
          <button
            type="button"
            onClick={() => togglePinned(conversation.id)}
            className={`rounded p-0.5 hover:bg-bg-tertiary ${
              pinned ? "text-accent-amber" : "text-text-muted"
            }`}
            title={pinned ? "Unpin conversation" : "Pin conversation"}
          >
            <Pin size={10} className={pinned ? "fill-accent-amber" : ""} />
          </button>
          <button
            type="button"
            onClick={() =>
              conversation.archived
                ? unarchiveConversation(conversation.id)
                : archiveConversation(conversation.id)
            }
            className="rounded p-0.5 text-text-muted hover:bg-bg-tertiary hover:text-accent-green"
            title={conversation.archived ? "Unarchive conversation" : "Archive conversation"}
          >
            {conversation.archived ? <ArchiveRestore size={10} /> : <Archive size={10} />}
          </button>
          <button
            type="button"
            onClick={() => setPendingDelete(conversation)}
            className="rounded p-0.5 text-text-muted hover:bg-bg-tertiary hover:text-accent-red"
            title="Delete conversation"
          >
            <Trash2 size={10} />
          </button>
        </div>
      </div>
    );
  };

  const renderSearchResult = (result: AgentSearchConversationResult) => {
    const titleHit = result.hits.find((h) => h.field === "title");
    const messageHits = result.hits.filter((h) => h.field === "message");
    const projectHit = result.hits.find((h) => h.field === "project");
    return (
      <section key={result.conversationId} className="mb-2">
        <button
          type="button"
          onClick={() => navigateToHit(result, titleHit ?? projectHit)}
          className="flex w-full items-center gap-2 rounded-lg px-2 py-1 text-left text-ui font-semibold text-text-primary hover:bg-bg-elevated"
        >
          <span className="min-w-0 flex-1 truncate">{result.title || "(untitled)"}</span>
          {result.archived && <Badge tone="neutral">Archived</Badge>}
        </button>
        <div className="mb-0.5 px-2 text-meta text-text-faint">
          {result.totalMatches} match{result.totalMatches === 1 ? "" : "es"}
          {result.hasMore && <span className="text-accent-blue"> · more matches</span>}
        </div>
        <div className="flex flex-col gap-1">
          {messageHits.map((hit) => (
            <button
              key={`${hit.messageId ?? "proj"}-${hit.field}`}
              type="button"
              onClick={() => navigateToHit(result, hit)}
              className="rounded-md px-2 py-1 text-left text-meta text-text-secondary transition-colors hover:bg-bg-elevated hover:text-text-primary"
            >
              <HighlightedExcerpt excerpt={hit.excerpt} matchRanges={hit.matchRanges} />
            </button>
          ))}
        </div>
      </section>
    );
  };

  return (
    <>
      <aside
        className="flex shrink-0 flex-col overflow-hidden border-r border-bg-border bg-bg-secondary"
        style={{ width: appliedWidth }}
      >
        <div className="flex items-center gap-1.5 px-3 pb-1 pt-2.5">
          <span className="text-ui font-semibold text-text-primary">Agents</span>
          <Badge>{counts.all}</Badge>
          {needsYouIds.size > 0 && <Badge tone="amber">{needsYouIds.size}</Badge>}
          <span className="flex-1" />
        </div>

        <div className="px-2.5 pb-1 pt-1">
          <label className="flex items-center gap-1.5 rounded-lg border border-bg-border bg-bg-primary px-2 py-1">
            <Search size={11} className="shrink-0 text-text-muted" />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search conversations…"
              className="min-w-0 flex-1 bg-transparent text-ui text-text-primary placeholder:text-text-muted focus:outline-none"
            />
          </label>
          {deferredQuery && filter !== "archived" && (
            <label className="mt-1 flex items-center gap-1.5 px-0.5 text-meta text-text-muted">
              <input
                type="checkbox"
                checked={includeArchived}
                onChange={(event) => setIncludeArchived(event.target.checked)}
                className="h-3 w-3"
              />
              Include archived
            </label>
          )}
          <div className="mt-1.5 flex flex-wrap items-center gap-0.5">
            {(
              [
                ["all", "All"],
                ["running", "Running"],
                ["needsYou", "Needs you"],
                ["failed", "Failed"],
                ["finished", "Finished"],
                ["archived", "Archived"],
              ] as const
            ).map(([value, label]) => (
              <button
                key={value}
                type="button"
                onClick={() => setFilter(value)}
                className={`rounded-md px-1.5 py-0.5 text-meta transition-colors ${
                  filter === value
                    ? "bg-bg-hover text-text-primary"
                    : "text-text-muted hover:bg-bg-elevated hover:text-text-primary"
                }`}
              >
                {label}
                <span className="ml-0.5 opacity-60">({counts[value]})</span>
              </button>
            ))}
          </div>
        </div>

        <div className="flex-1 overflow-y-auto px-2.5 py-3">
          {deferredQuery ? (
            searchResults.length === 0 ? (
              <EmptyState
                className="py-16"
                icon={<Search size={22} />}
                title="No matching conversations"
                description="Try a different title, project, or message."
              />
            ) : (
              searchResults.map(renderSearchResult)
            )
          ) : filtered.length === 0 ? (
            <EmptyState
              className="py-16"
              icon={<BellRing size={22} />}
              title="No conversations yet"
              description="Start your first one with New agent below."
            />
          ) : (
            <>
              {needsYou.length > 0 && (
                <section>
                  <div className="flex items-center gap-1.5 px-2 pb-1 pt-1">
                    <BellRing size={10} className="text-accent-amber" />
                    <span className="text-meta uppercase tracking-[0.09em] text-accent-amber">
                      Needs you
                    </span>
                    <span className="ml-auto font-mono text-meta text-accent-amber">
                      {needsYou.length}
                    </span>
                  </div>
                  {needsYou.map((conversation) => renderConversation(conversation, true))}
                </section>
              )}
              {Array.from(groups.entries()).map(([key, conversationsInProject]) => {
                const example = conversationsInProject[0];
                if (!example) return null;
                return (
                  <section key={key}>
                    <div
                      className="flex items-center gap-2 rounded-lg px-2 py-[4.5px] text-ui font-semibold text-text-primary"
                      title={baseProjectPath(example)}
                    >
                      {example.sshTarget ? (
                        <Server size={10} className="shrink-0 text-accent-green" />
                      ) : (
                        <FolderOpen size={10} className="shrink-0 text-text-muted" />
                      )}
                      <span className="min-w-0 flex-1 truncate">
                        {projectLabel(example, projectLabels)}
                      </span>
                      <span className="shrink-0 font-mono text-meta text-text-faint">
                        {conversationsInProject.length}
                      </span>
                    </div>
                    {conversationsInProject.map((conversation) =>
                      renderConversation(conversation, false),
                    )}
                  </section>
                );
              })}
            </>
          )}
        </div>

        {/* Footer CTA — the ONE create control in this sidebar (the header "+"
            that called this identical handler is gone, mirroring FleetSidebar). */}
        <div className="border-t border-line-soft p-2.5">
          <button
            type="button"
            onClick={onNewAgent}
            title="New agent — opens the launch composer"
            className="flex w-full items-center justify-center gap-1.5 rounded-lg border border-accent-line bg-accent-green/15 px-2 py-1.5 text-ui font-medium text-accent-green transition-colors hover:bg-accent-green/25"
          >
            <Plus size={11} />
            New agent
          </button>
        </div>

        {/* Delete discards the conversation's worktree + branch; the shared
            confirm names them (and any uncommitted changes) before the click. */}
        {pendingDelete && (
          <ConfirmDeleteConversationModal
            conversationId={pendingDelete.id}
            title={pendingDelete.title}
            onClose={() => setPendingDelete(null)}
          />
        )}
      </aside>

      {/* V7 — the resize splitter. 8px hit area, 2px visible grip, drag +
          keyboard (Home/End/arrows) + double-click reset. */}
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize conversations sidebar"
        aria-valuemin={AGENT_SIDEBAR_MIN_WIDTH}
        aria-valuemax={AGENT_SIDEBAR_MAX_WIDTH}
        aria-valuenow={appliedWidth}
        tabIndex={0}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onDoubleClick={() => setWidth(AGENT_SIDEBAR_DEFAULT_WIDTH)}
        onKeyDown={onSeparatorKeyDown}
        className="group flex w-2 shrink-0 cursor-col-resize items-center justify-center border-r border-bg-border bg-bg-secondary transition-colors hover:bg-bg-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-blue"
      >
        <div className="h-8 w-0.5 rounded-full bg-bg-border transition-colors group-hover:bg-accent-blue group-focus-visible:bg-accent-blue" />
      </div>
    </>
  );
}
