import { useEffect, useMemo, useState } from "react";
import {
  Plane,
  Search,
  Plus,
  Users,
  Check,
  Sparkles,
  Brain,
  Trash2,
  BookmarkPlus,
  Archive,
  ArchiveRestore,
  Square,
  Loader2,
  Rocket,
} from "lucide-react";
import { useShallow } from "zustand/react/shallow";
import { useFlightStore } from "@/stores/flightStore";
import {
  describeFlightDeleteImpact,
  inspectFlightDeleteImpact,
  summarizeFlightDeleteImpact,
  useAsyncFlightStore,
  type FlightDeleteImpact,
} from "@/stores/asyncFlightStore";
import { ConfirmDeleteModal } from "@/components/ui/ConfirmDeleteModal";
import { useToast } from "@/components/ui/Toast";
import { reassignTargetFromEscalation } from "@/lib/flightCoordination";
import { buildCoordinationMemoryInput } from "@/lib/memoryCapture";
import { memoryScopeForWorkspace } from "@/lib/memoryWriteScope";
import { getProviderForAgent } from "@/lib/api-models";
import { useAgentTaskStore, type AgentCli } from "@/stores/agentTaskStore";
import { useMemoryStore } from "@/stores/memoryStore";
import { useAppStore } from "@/stores/appStore";
import { AsyncFlightGrid } from "@/components/flights/AsyncFlightGrid";
import { FlightPlanningCard } from "@/components/flights/FlightPlanningCard";
import { FlightIntegrationEvidence } from "@/components/flights/FlightIntegrationEvidence";
import { CooperativeFlightCard } from "@/components/flights/CooperativeFlightCard";
import { FlightCoordinationInbox } from "@/components/flights/FlightCoordinationInbox";
import { FlightAutonomyCard } from "@/components/flights/FlightAutonomyCard";
import { PacketAgentHandoffCard } from "@/components/flights/PacketAgentHandoffCard";
import { usePacketAgentStore } from "@/stores/packetAgentStore";
import { useAgentApprovalStore } from "@/stores/agentApprovalStore";
import { openConversationInAgents } from "@/stores/sessionGlue";
import { IssueFlightMirrorCard } from "@/components/flights/IssueFlightMirrorCard";
import { openMonitorWindow } from "@/lib/monitorWindows";
import { relativeTime } from "@/lib/time";
import { summarizeFlightAttention } from "@/lib/flightReview";
import { flightOwnedSessionIds, projectFlightLifecycle } from "@/lib/flightLifecycle";
import {
  FLIGHT_STATUS_CONFIG,
  FLIGHT_PRIORITY_COLORS,
  TASK_ROLE_CONFIG,
} from "@/lib/flight-colors";
import type {
  Flight,
  FlightPriority,
  FlightStatus,
  CoordinationEvent,
  CoordinationEventType,
  TaskRole,
} from "@/types/flight";

type GroupKey = "drafting" | "attention" | "active" | "ready" | "recent" | "archived";

type DesignDot = "green" | "blue" | "amber" | "red" | "muted" | "accent" | "purple";

const PRIORITY_LABEL: Record<FlightPriority, string> = {
  critical: "P0",
  high: "P1",
  medium: "P2",
  low: "P3",
};

const DOT_BG: Record<DesignDot, string> = {
  green: "bg-accent-green",
  blue: "bg-accent-blue",
  amber: "bg-accent-amber",
  red: "bg-accent-red",
  muted: "bg-text-muted",
  accent: "bg-accent-green",
  purple: "bg-accent-purple",
};

const EVENT_DOT: Record<CoordinationEventType, DesignDot> = {
  task_started: "amber",
  task_completed: "green",
  task_failed: "red",
  handoff: "blue",
  review_requested: "accent",
  review_resolved: "green",
  collision_warning: "amber",
  escalation: "red",
};

function shortId(id: string): string {
  const tail = id
    .replace(/^[a-z]+-/i, "")
    .slice(-4)
    .toUpperCase();
  return `F-${tail}`;
}

function flightAgentCount(flight: Flight): number {
  const ids = new Set<string>();
  for (const m of flight.milestones) {
    for (const t of m.tasks) {
      if (t.agentConfigId) ids.add(t.agentConfigId);
    }
  }
  if (ids.size > 0) return ids.size;
  return flight.linkedSessionIds.length;
}

function flightTasks(flight: Flight): {
  done: number;
  total: number;
  approvals: number;
  hasInProgress: boolean;
} {
  let done = 0;
  let total = 0;
  let approvals = 0;
  let hasInProgress = false;
  for (const m of flight.milestones) {
    for (const t of m.tasks) {
      total += 1;
      if (t.status === "done") done += 1;
      if (t.status === "approval_needed") approvals += 1;
      if (t.status === "running" || t.status === "queued") hasInProgress = true;
    }
  }
  return { done, total, approvals, hasInProgress };
}

function pendingApprovalCount(
  flight: Flight,
  permissions: ReadonlyMap<string, readonly unknown[]>,
  edits: ReadonlyMap<string, readonly unknown[]>,
) {
  return flightOwnedSessionIds(flight).reduce(
    (sum, sessionId) =>
      sum + (permissions.get(sessionId)?.length ?? 0) + (edits.get(sessionId)?.length ?? 0),
    0,
  );
}

function useFlightLifecycle(flight: Flight) {
  const permissions = useAgentApprovalStore((state) => state.permissions);
  const edits = useAgentApprovalStore((state) => state.edits);
  const conversations = useAgentTaskStore((state) => state.conversations);
  return projectFlightLifecycle(flight, {
    pendingApprovalCount: pendingApprovalCount(flight, permissions, edits),
    activeSessionCount: activeOwnedSessionCount(flight, conversations),
  });
}

function activeOwnedSessionCount(
  flight: Flight,
  conversations: readonly { id: string; status: string }[],
): number {
  const owned = new Set(flightOwnedSessionIds(flight));
  return conversations.filter(
    (conversation) => owned.has(conversation.id) && conversation.status === "active",
  ).length;
}

function classifyGroup(
  flight: Flight,
  status: FlightStatus,
  approvals: number,
  activeSessionCount: number,
): GroupKey {
  const phase = projectFlightLifecycle(flight, {
    pendingApprovalCount: approvals,
    activeSessionCount,
  }).phase;
  if (phase === "archived") return "archived";
  if (phase === "draft") return "drafting";
  if (phase === "needs_attention" || phase === "review") return "attention";
  if (phase === "ready_to_deliver") return "ready";
  if (phase === "delivered") return "recent";
  return status === "active" || phase === "running" ? "active" : "attention";
}

function formatCost(cost: number): string {
  if (!cost && cost !== 0) return "$0.00";
  if (cost >= 100) return `$${cost.toFixed(0)}`;
  return `$${cost.toFixed(2)}`;
}

function formatTokens(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
  if (tokens >= 1000) return `${(tokens / 1000).toFixed(1)}k`;
  return `${tokens}`;
}

function eventTimeShort(ts: number): string {
  const diff = Date.now() - ts;
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "now";
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  return `${days}d`;
}

export function FlightsView() {
  const { flights, activeFlightId, setActiveFlight, computeFlightStatus } = useFlightStore(
    useShallow((s) => ({
      flights: s.flights,
      activeFlightId: s.activeFlightId,
      setActiveFlight: s.setActiveFlight,
      computeFlightStatus: s.computeFlightStatus,
    })),
  );
  const openFlightBrief = useAppStore((state) => state.openFlightBrief);
  const permissions = useAgentApprovalStore((state) => state.permissions);
  const edits = useAgentApprovalStore((state) => state.edits);
  const conversations = useAgentTaskStore((state) => state.conversations);
  const [query, setQuery] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const [showArchived, setShowArchived] = useState(false);

  function handleStartFlight() {
    openFlightBrief();
  }

  function handleLaunchIntoFlight(flightId: string) {
    const target = flights.find((flight) => flight.id === flightId);
    if (!target) return;
    const attempt = target.attempts?.slice(-1)[0];
    openFlightBrief({
      flightId: target.delivery || target.archivedAt ? undefined : flightId,
      title: target.title,
      objective: target.objective,
      projectPath:
        attempt?.target.basePath ?? target.executionTarget?.basePath ?? target.projectPath,
      workspaceId: target.workspaceId,
      serverId: attempt
        ? attempt.target.kind === "ssh"
          ? attempt.target.serverId
          : undefined
        : target.executionTarget?.serverId,
      baseBranch: attempt?.baseBranch ?? target.gitBranch,
      agent: attempt?.agentConfigId as AgentCli | undefined,
      model: attempt?.model,
      acceptanceCriteria: target.reviewGatePolicy?.acceptanceCriteria,
      sourceLabel: target.title,
    });
  }

  const selectedId = useMemo(() => {
    if (
      activeFlightId &&
      flights.some((f) => f.id === activeFlightId && (showArchived || !f.archivedAt))
    ) {
      return activeFlightId;
    }
    return flights.find((flight) => showArchived || !flight.archivedAt)?.id ?? null;
  }, [flights, activeFlightId, showArchived]);

  useEffect(() => {
    if (selectedId && selectedId !== activeFlightId) {
      setActiveFlight(selectedId);
    }
  }, [selectedId, activeFlightId, setActiveFlight]);

  const selectedFlight = useMemo(
    () => flights.find((f) => f.id === selectedId) ?? null,
    [flights, selectedId],
  );

  const grouped = useMemo(() => {
    const filter = query.trim().toLowerCase();
    const buckets: Record<GroupKey, Flight[]> = {
      drafting: [],
      attention: [],
      active: [],
      ready: [],
      recent: [],
      archived: [],
    };
    for (const f of flights) {
      if (!showArchived && f.archivedAt) continue;
      if (filter) {
        const hay = `${f.title} ${f.objective ?? ""} ${f.id}`.toLowerCase();
        if (!hay.includes(filter)) continue;
      }
      const status = computeFlightStatus(f.id);
      buckets[
        classifyGroup(
          f,
          status,
          pendingApprovalCount(f, permissions, edits),
          activeOwnedSessionCount(f, conversations),
        )
      ].push(f);
    }
    return buckets;
  }, [flights, query, computeFlightStatus, showArchived, permissions, edits, conversations]);

  if (flights.length === 0) {
    return (
      <>
        <div className="flex flex-1 flex-col items-center justify-center gap-3 bg-bg-primary px-6 text-text-muted">
          <Plane size={32} />
          <span className="text-sm font-medium text-text-primary">No flights yet</span>
          <span className="max-w-md text-center text-xs">
            Give an agent a scoped change on an isolated branch. Review its changes and checks, then
            land the result or open a PR.
          </span>
          <div className="mt-2 flex flex-col items-center gap-2">
            <button
              onClick={handleStartFlight}
              className="flex items-center gap-2 rounded border border-accent-line bg-accent-soft px-4 py-2 text-sm font-medium text-accent-green transition-colors hover:bg-accent-green/15"
            >
              <Sparkles size={14} />
              New flight
            </button>
          </div>
        </div>
      </>
    );
  }

  return (
    <>
      <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-bg-primary md:flex-row">
        <FlightSidebar
          flights={flights}
          grouped={grouped}
          selectedId={selectedId}
          onSelect={setActiveFlight}
          query={query}
          onQueryChange={setQuery}
          searchOpen={searchOpen}
          onToggleSearch={() => setSearchOpen((v) => !v)}
          onCreate={handleStartFlight}
          computeStatus={computeFlightStatus}
          showArchived={showArchived}
          onToggleArchived={() => setShowArchived((value) => !value)}
        />
        <div className="flex min-w-0 flex-1 flex-col">
          {selectedFlight ? (
            <FlightDetailPane
              key={selectedFlight.id}
              flight={selectedFlight}
              status={computeFlightStatus(selectedFlight.id)}
              onLaunchAttempt={() => handleLaunchIntoFlight(selectedFlight.id)}
            />
          ) : (
            <EmptyDetail />
          )}
        </div>
      </div>
    </>
  );
}

function EmptyDetail() {
  return (
    <div className="flex flex-1 items-center justify-center bg-bg-primary">
      <div className="flex flex-col items-center gap-2 text-text-muted">
        <Plane size={28} />
        <span className="text-xs">No flight selected — pick one from the left</span>
      </div>
    </div>
  );
}

interface SidebarProps {
  flights: Flight[];
  grouped: Record<GroupKey, Flight[]>;
  selectedId: string | null;
  onSelect: (id: string) => void;
  query: string;
  onQueryChange: (q: string) => void;
  searchOpen: boolean;
  onToggleSearch: () => void;
  onCreate: () => void;
  computeStatus: (id: string) => FlightStatus;
  showArchived: boolean;
  onToggleArchived: () => void;
}

function FlightSidebar({
  flights,
  grouped,
  selectedId,
  onSelect,
  query,
  onQueryChange,
  searchOpen,
  onToggleSearch,
  onCreate,
  computeStatus,
  showArchived,
  onToggleArchived,
}: SidebarProps) {
  const groups: { key: GroupKey; label: string }[] = [
    { key: "attention", label: "Needs you" },
    { key: "active", label: "Running" },
    { key: "ready", label: "Ready to deliver" },
    { key: "drafting", label: "Drafts" },
    { key: "recent", label: "Delivered" },
    { key: "archived", label: "Archived" },
  ];

  return (
    <nav
      aria-label="Flights"
      className="flex max-h-56 min-h-0 w-full shrink-0 flex-col border-b border-bg-border bg-bg-secondary md:max-h-none md:w-56 md:border-b-0 md:border-r lg:w-64"
    >
      <div className="flex items-center gap-1.5 border-b border-line-soft px-2.5 py-2">
        <span className="text-[11px] font-semibold text-text-primary">Flights</span>
        <span className="rounded bg-bg-tertiary px-1.5 py-px font-mono text-[10px] text-text-muted">
          {flights.length}
        </span>
        <span className="flex-1" />
        <button
          onClick={onToggleSearch}
          className={`rounded p-1 transition-colors hover:bg-bg-hover ${
            searchOpen ? "bg-bg-hover text-text-primary" : "text-text-muted"
          }`}
          title="Search flights"
          aria-label="Search flights"
          aria-expanded={searchOpen}
        >
          <Search size={12} />
        </button>
        <button
          onClick={onCreate}
          className="rounded p-1 text-text-muted transition-colors hover:bg-bg-hover hover:text-accent-green"
          title="New flight"
          aria-label="New flight"
        >
          <Plus size={12} />
        </button>
      </div>

      {searchOpen && (
        <div className="border-b border-line-soft px-2.5 py-1.5">
          <input
            autoFocus
            type="text"
            value={query}
            onChange={(e) => onQueryChange(e.target.value)}
            placeholder="Filter by title, objective, id…"
            aria-label="Filter flights"
            className="w-full rounded border border-bg-border bg-bg-primary px-2 py-1 text-[11px] text-text-primary outline-none placeholder:text-text-faint focus:border-accent-line"
          />
        </div>
      )}

      <label className="flex items-center gap-2 border-b border-bg-border px-3 py-2 text-[11px] text-text-secondary">
        <input type="checkbox" checked={showArchived} onChange={onToggleArchived} /> Show archived
      </label>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {groups.map((g) => {
          const items = grouped[g.key];
          if (items.length === 0) return null;
          return (
            <div key={g.key}>
              <div className="sticky top-0 z-10 flex items-center justify-between border-y border-line-soft bg-bg-tertiary px-2.5 py-1.5 text-[10px] font-semibold uppercase tracking-[0.1em] text-text-muted">
                <span>{g.label}</span>
                <span className="font-mono">{items.length}</span>
              </div>
              {items.map((f) => (
                <FlightRow
                  key={f.id}
                  flight={f}
                  status={computeStatus(f.id)}
                  selected={f.id === selectedId}
                  onSelect={() => onSelect(f.id)}
                />
              ))}
            </div>
          );
        })}
        {Object.values(grouped).every((items) => items.length === 0) && (
          <div className="px-3 py-4 text-[10px] text-text-muted">No flights match.</div>
        )}
      </div>
    </nav>
  );
}

function FlightRow({
  flight,
  status,
  selected,
  onSelect,
}: {
  flight: Flight;
  status: FlightStatus;
  selected: boolean;
  onSelect: () => void;
}) {
  // Shared with the detail pane below, so selecting a row cannot change the
  // colour it was already showing (CLAUDE.md: flight status colours live in
  // `src/lib/flight-colors.ts`).
  const cfg = FLIGHT_STATUS_CONFIG[status];
  const pulse = status === "active";
  const agents = flightAgentCount(flight);
  const cost = formatCost(flight.totalCost);
  const priorityClass = FLIGHT_PRIORITY_COLORS[flight.priority];
  const statusLabel = useFlightLifecycle(flight).label;
  const toast = useToast();

  // Delete confirm. The old idiom here was a 3-second armed inline button;
  // it is now the shared ConfirmDeleteModal, because the delete no longer
  // just drops a row — it cancels the flight's running attempts and removes
  // their worktrees, and the user is owed those consequences up front.
  const [confirming, setConfirming] = useState(false);
  const [impact, setImpact] = useState<FlightDeleteImpact | null>(null);

  // Probe the live attempts (and their worktrees) only while the confirm is
  // open. `impact === null` renders as "checking…" rather than as "nothing
  // will be lost".
  useEffect(() => {
    if (!confirming) return;
    let stale = false;
    setImpact(null);
    void inspectFlightDeleteImpact(flight.id)
      .then((next) => {
        if (!stale) setImpact(next);
      })
      .catch((err) => {
        console.warn("[FlightsView] delete impact probe failed", err);
        if (!stale) setImpact(summarizeFlightDeleteImpact([]));
      });
    return () => {
      stale = true;
    };
  }, [confirming, flight.id]);

  // Tasks aren't cancelled by the delete (they have no worktree of their
  // own), but live ones are still work the user is throwing away.
  const liveTaskCount = useMemo(() => {
    let count = 0;
    for (const m of flight.milestones) {
      for (const t of m.tasks) {
        if (t.status === "running" || t.status === "queued" || t.status === "approval_needed") {
          count += 1;
        }
      }
    }
    return count;
  }, [flight.milestones]);

  const hasActiveWork = useMemo(
    () =>
      liveTaskCount > 0 ||
      (flight.attempts ?? []).some(
        (a) =>
          a.status === "running" ||
          a.status === "provisioning" ||
          a.status === "queued" ||
          a.status === "reviewing",
      ),
    [flight.attempts, liveTaskCount],
  );

  const deleteWarnings = useMemo(() => {
    const warnings = describeFlightDeleteImpact(impact);
    if (liveTaskCount > 0) {
      warnings.push(
        `${liveTaskCount} task${liveTaskCount === 1 ? "" : "s"} ${liveTaskCount === 1 ? "is" : "are"} still running or awaiting approval.`,
      );
    }
    return warnings;
  }, [impact, liveTaskCount]);

  const runDelete = () => {
    const flightName = flight.title || "Untitled";
    const cancelling = impact?.attemptCount ?? 0;
    setConfirming(false);
    if (cancelling > 0) {
      toast.show(
        `Cancelling ${cancelling} attempt${cancelling === 1 ? "" : "s"} and removing ${cancelling === 1 ? "its worktree" : "their worktrees"}…`,
      );
    }
    void useAsyncFlightStore
      .getState()
      .deleteFlightWithAttemptCleanup(flight.id)
      .then((failures) => {
        if (failures.length === 0) return;
        toast.error(
          `Deleted “${flightName}”, but ${failures.length} attempt cleanup${
            failures.length === 1 ? "" : "s"
          } failed: ${failures.map((f) => `${f.branch || f.attemptId || "flight"} — ${f.message}`).join(" | ")}`,
        );
      })
      .catch((err) => {
        toast.error(
          `Failed to delete “${flightName}”: ${err instanceof Error ? err.message : err}`,
        );
      });
  };
  // v0.8-H — "N patterns extracted" chip on completed flights. We
  // count every `flight_completed` / `task_completed` event tied to
  // this flight (by flightId) and the lessonsLearned bullets they
  // emitted, which are the closest analog to "patterns" in our current
  // schema.
  const memoryHits = useMemoryStore((s) => {
    if (status !== "done") return 0;
    let lessons = 0;
    let flightEvents = 0;
    for (const e of s.events) {
      if (e.type === "flight_completed" && e.payload.flightId === flight.id) {
        flightEvents += 1;
        lessons += e.payload.lessonsLearned.length;
      } else if (e.type === "task_completed" && e.payload.flightId === flight.id) {
        flightEvents += 1;
      }
    }
    return flightEvents > 0 ? lessons + flightEvents : 0;
  });
  const openMemoryView = useAppStore((s) => s.openMemoryView);

  const deleteTitle = hasActiveWork
    ? `Delete "${flight.title || "Untitled"}"? This flight has active work — its attempts will be cancelled and their worktrees removed.`
    : `Delete "${flight.title || "Untitled"}"`;

  return (
    <>
      <div
        role="button"
        aria-label={`${flight.title || "Untitled flight"} — ${statusLabel}`}
        aria-pressed={selected}
        tabIndex={0}
        onClick={onSelect}
        onKeyDown={(e) => {
          if (e.target !== e.currentTarget) return;
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            onSelect();
          }
        }}
        className={`group flex w-full cursor-pointer flex-col gap-1 border-b border-l-2 border-line-soft px-2.5 py-2 text-left transition-colors ${
          selected
            ? "border-l-accent-green bg-bg-elevated"
            : "border-l-transparent hover:bg-bg-tertiary"
        }`}
      >
        <div className="flex items-center gap-1.5">
          <span className="relative flex h-2 w-2 shrink-0 items-center justify-center">
            {pulse && (
              <span
                className={`absolute inset-0 rounded-full ${cfg.dot} animate-ping opacity-60`}
              />
            )}
            <span className={`relative h-1.5 w-1.5 rounded-full ${cfg.dot}`} />
          </span>
          <span className="font-mono text-[10px] text-text-muted">{shortId(flight.id)}</span>
          <span className="flex-1" />
          <span className={`font-mono text-[10px] font-semibold ${priorityClass}`}>
            {PRIORITY_LABEL[flight.priority]}
          </span>
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              setConfirming(true);
            }}
            className="rounded p-0.5 text-text-muted opacity-0 transition-colors hover:bg-accent-red/10 hover:text-accent-red focus:opacity-100 group-hover:opacity-100"
            title={deleteTitle}
            aria-label="Delete flight"
          >
            <Trash2 size={11} />
          </button>
        </div>
        <span
          className={`line-clamp-2 text-[12px] leading-snug ${
            selected ? "font-medium text-text-primary" : "text-text-secondary"
          }`}
        >
          {flight.title || "Untitled"}
        </span>
        <div className="flex items-center gap-2 text-[10px] text-text-muted">
          <span className="inline-flex items-center gap-1">
            <Users size={9} />
            <span>{agents}</span>
          </span>
          {memoryHits > 0 && (
            <span
              role="button"
              tabIndex={0}
              onClick={(e) => {
                e.stopPropagation();
                openMemoryView({ flightId: flight.id });
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  e.stopPropagation();
                  openMemoryView({ flightId: flight.id });
                }
              }}
              className="-mx-1 inline-flex cursor-pointer items-center gap-1 rounded px-1 text-accent-green transition-colors hover:bg-accent-green/10 hover:text-accent-green/80"
              title={`${memoryHits} memory entr${memoryHits === 1 ? "y" : "ies"} extracted from this flight. Click to view in Memory.`}
            >
              <Brain size={9} />
              <span>{memoryHits}</span>
            </span>
          )}
          <span className="font-mono">{cost}</span>
          <span className="flex-1" />
          <span className={`capitalize ${cfg.text}`}>{statusLabel}</span>
        </div>
      </div>
      {confirming && (
        <ConfirmDeleteModal
          title="Delete flight?"
          entityName={flight.title || "Untitled"}
          description="is removed along with its attempt history, and any issues linked to it are unassigned. Running attempts are cancelled and their git worktrees removed first."
          warningTitle="Deleting this also destroys"
          warnings={deleteWarnings}
          confirmLabel={impact && impact.attemptCount > 0 ? "Cancel attempts & delete" : "Delete"}
          onConfirm={runDelete}
          onClose={() => setConfirming(false)}
        />
      )}
    </>
  );
}

interface DetailProps {
  flight: Flight;
  status: FlightStatus;
  onLaunchAttempt: () => void;
}

function FlightDetailPane({ flight, status, onLaunchAttempt }: DetailProps) {
  const toast = useToast();
  const lifecycle = useFlightLifecycle(flight);
  const cfg = FLIGHT_STATUS_CONFIG[status];
  const tasks = flightTasks(flight);
  const archiveFlight = useFlightStore((state) => state.archiveFlight);
  const unarchiveFlight = useFlightStore((state) => state.unarchiveFlight);
  const stopFlight = useAsyncFlightStore((state) => state.stopFlight);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [archiveConfirm, setArchiveConfirm] = useState(false);
  const candidates = [...(flight.attempts ?? [])].reverse();
  const attemptToReview =
    lifecycle.nextAction === "deliver"
      ? candidates.find((attempt) => attempt.status === "completed" && !attempt.delivery)
      : (candidates.find((attempt) => attempt.recovery?.state === "retained") ??
        candidates.find((attempt) => attempt.status === "reviewing") ??
        candidates.find((attempt) => attempt.status === "failed"));
  const primaryLabel: Record<typeof lifecycle.nextAction, string> = {
    brief: flight.executionMode === "cooperative" ? "Open tasks" : "Review brief & run",
    stop: "Stop Flight",
    attention: "Resolve attention",
    review: "Review result",
    deliver: flight.executionMode === "cooperative" ? "Review & land Flight" : "Deliver result",
    archive: "Archive Flight",
    unarchive: "Restore Flight",
  };
  function focusResult() {
    const element = document.getElementById(
      flight.executionMode === "cooperative" && lifecycle.nextAction === "deliver"
        ? `flight-tasks-${flight.id}`
        : attemptToReview
          ? `flight-attempt-${attemptToReview.id}`
          : `flight-attention-${flight.id}`,
    );
    element?.scrollIntoView?.({ behavior: "smooth", block: "start" });
    element?.focus();
  }
  async function primaryAction() {
    if (busy) return;
    setError(null);
    if (lifecycle.nextAction === "brief") {
      if (flight.executionMode === "cooperative") {
        const tasks = document.getElementById(`flight-tasks-${flight.id}`);
        tasks?.scrollIntoView?.({ behavior: "smooth", block: "start" });
        tasks?.focus();
        return;
      }
      onLaunchAttempt();
      return;
    }
    if (["attention", "review", "deliver"].includes(lifecycle.nextAction)) {
      focusResult();
      return;
    }
    if (lifecycle.nextAction === "archive") {
      setArchiveConfirm(true);
      return;
    }
    setBusy(true);
    try {
      if (lifecycle.nextAction === "stop") await stopFlight(flight.id);
      else unarchiveFlight(flight.id);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  }
  async function stopNow() {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await stopFlight(flight.id);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  }
  const step =
    lifecycle.phase === "draft"
      ? 0
      : lifecycle.phase === "running" || lifecycle.phase === "needs_attention"
        ? 1
        : lifecycle.phase === "review"
          ? 2
          : 3;

  return (
    <div className="min-h-0 min-w-0 flex-1 overflow-y-auto bg-bg-primary">
      <div className="mx-auto flex w-full min-w-0 max-w-5xl flex-col gap-4 p-3 md:p-4">
        <header className="space-y-3 rounded-lg border border-bg-border bg-bg-secondary p-4">
          <div className="flex flex-wrap items-start gap-3">
            <div className="min-w-0 flex-1">
              <div className="mb-1 flex flex-wrap items-center gap-2 text-[11px]">
                <span className="font-mono text-text-muted">{shortId(flight.id)}</span>
                <span className={`rounded px-2 py-0.5 font-medium ${cfg.bg} ${cfg.text}`}>
                  {lifecycle.label}
                </span>
              </div>
              <h1 className="break-words text-lg font-semibold text-text-primary">
                {flight.title || "Untitled flight"}
              </h1>
            </div>
            <button
              type="button"
              disabled={busy}
              onClick={() => void primaryAction()}
              className="inline-flex items-center gap-1.5 rounded border border-accent-green/30 bg-accent-green/10 px-3 py-2 text-xs font-medium text-accent-green disabled:opacity-40"
            >
              {busy ? (
                <Loader2 size={12} className="animate-spin" />
              ) : lifecycle.nextAction === "stop" ? (
                <Square size={12} />
              ) : lifecycle.nextAction === "archive" ? (
                <Archive size={12} />
              ) : lifecycle.nextAction === "unarchive" ? (
                <ArchiveRestore size={12} />
              ) : (
                <Rocket size={12} />
              )}
              {primaryLabel[lifecycle.nextAction]}
            </button>
            {lifecycle.activeCount > 0 && lifecycle.nextAction !== "stop" && (
              <button
                type="button"
                disabled={busy}
                onClick={() => void stopNow()}
                className="inline-flex items-center gap-1.5 rounded border border-bg-border px-3 py-2 text-xs text-text-secondary disabled:opacity-40"
              >
                <Square size={12} /> Stop Flight
              </button>
            )}
          </div>
          <p className="text-xs leading-relaxed text-text-secondary">{lifecycle.summary}</p>
          <ol aria-label="Flight progress" className="flex flex-wrap gap-2 text-[11px]">
            {["Brief", "Run", "Review", "Deliver"].map((label, index) => (
              <li
                key={label}
                aria-current={index === step ? "step" : undefined}
                className={`rounded border px-2 py-1 ${index === step ? "border-accent-green/40 text-accent-green" : "border-bg-border text-text-muted"}`}
              >
                {index + 1}. {label}
              </li>
            ))}
          </ol>
          <div className="border-t border-bg-border pt-3">
            <h2 className="text-[11px] font-semibold uppercase tracking-wide text-text-muted">
              Outcome
            </h2>
            <p className="mt-1 whitespace-pre-wrap break-words text-xs text-text-primary">
              {flight.objective ||
                flight.prompt ||
                "Add a concrete outcome in the brief before running."}
            </p>
          </div>
          <p className="break-all font-mono text-[11px] text-text-muted">
            {flight.projectPath || "Project not selected"}
          </p>
          {(flight.reviewGatePolicy?.acceptanceCriteria.length ?? 0) > 0 && (
            <details>
              <summary className="cursor-pointer text-xs text-text-secondary">
                Acceptance checks ({flight.reviewGatePolicy!.acceptanceCriteria.length})
              </summary>
              <ul className="mt-2 list-disc space-y-1 break-words pl-4 text-xs text-text-secondary">
                {flight.reviewGatePolicy!.acceptanceCriteria.map((criterion, index) => (
                  <li key={index}>{criterion}</li>
                ))}
              </ul>
            </details>
          )}
          <div className="flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-text-muted">
            <span>
              Usage {formatCost(flight.totalCost)} · {formatTokens(flight.totalTokens)} tokens
            </span>
            <span>
              {flight.executionMode === "cooperative" ? "Cooperative tasks" : "Isolated attempts"} ·{" "}
              {flight.autonomyPolicy ? "Bounded automatic actions" : "Assisted"}
            </span>
            <span>Updated {relativeTime(flight.updatedAt)}</span>
          </div>
          {error && (
            <p role="alert" className="text-xs text-accent-red">
              {error}
            </p>
          )}
          {busy && (
            <p role="status" className="text-xs text-text-muted">
              Applying Flight action…
            </p>
          )}
        </header>

        <AttentionCard flight={flight} />
        <FlightPlanningCard flight={flight} />
        {flight.executionMode === "cooperative" && (
          <section id={`flight-tasks-${flight.id}`} tabIndex={-1} className="min-w-0 space-y-3">
            {lifecycle.phase === "ready_to_deliver" && (
              <FlightIntegrationEvidence flight={flight} />
            )}
            <CooperativeFlightCard flight={flight} />
          </section>
        )}
        <AsyncFlightGrid
          flight={flight}
          onLaunch={
            flight.archivedAt || flight.executionMode === "cooperative"
              ? undefined
              : onLaunchAttempt
          }
        />

        <details className="rounded border border-bg-border bg-bg-secondary p-3">
          <summary className="cursor-pointer text-xs font-medium text-text-secondary">
            Coordination and messages
          </summary>
          <div className="mt-3">
            <FlightCoordinationInbox flight={flight} />
          </div>
        </details>
        <details className="rounded border border-bg-border bg-bg-secondary p-3">
          <summary className="cursor-pointer text-xs font-medium text-text-secondary">
            Execution settings and integrations
          </summary>
          <div className="mt-3 space-y-3">
            <FlightAutonomyCard flight={flight} />
            {flight.executionMode !== "cooperative" && <CooperativeFlightCard flight={flight} />}
            <PacketAgentHandoffCard flight={flight} />
            <IssueFlightMirrorCard flight={flight} />
            <button
              type="button"
              onClick={() =>
                void openMonitorWindow({ kind: "flight", flightId: flight.id }).catch((reason) =>
                  toast.error(`Monitor could not be opened: ${String(reason)}`),
                )
              }
              className="rounded border border-bg-border px-3 py-1.5 text-xs text-text-secondary"
            >
              Open Flight Monitor
            </button>
          </div>
        </details>
        <details className="rounded border border-bg-border bg-bg-secondary p-3">
          <summary className="cursor-pointer text-xs font-medium text-text-secondary">
            Plan record, usage and activity history
          </summary>
          <div className="mt-3 space-y-3">
            <StatGrid flight={flight} tasks={tasks} sessions={flight.linkedSessionIds.length} />
            {flight.executionMode !== "cooperative" && (
              <MilestonesCard flight={flight} tasks={tasks} />
            )}
            <TimelineCard flight={flight} />
          </div>
        </details>
        {!flight.archivedAt && lifecycle.nextAction !== "archive" && (
          <button
            type="button"
            disabled={lifecycle.activeCount > 0 || tasks.hasInProgress}
            onClick={() => setArchiveConfirm(true)}
            className="self-start rounded px-2 py-1 text-[11px] text-text-muted hover:text-text-primary disabled:opacity-40"
          >
            {lifecycle.activeCount > 0 || tasks.hasInProgress
              ? "Stop active work before archiving"
              : "Archive without deleting history…"}
          </button>
        )}
      </div>
      {archiveConfirm && (
        <ConfirmDeleteModal
          title="Archive Flight?"
          entityName={flight.title}
          description="is hidden from the active list. Its results, branches and history are retained. Restore it from Show archived."
          confirmLabel="Archive Flight"
          warnings={
            lifecycle.phase === "running"
              ? ["Stop this Flight before archiving so all active work is settled."]
              : []
          }
          undoNote={null}
          onClose={() => setArchiveConfirm(false)}
          onConfirm={() => {
            try {
              archiveFlight(flight.id);
              setArchiveConfirm(false);
            } catch (reason) {
              setArchiveConfirm(false);
              setError(reason instanceof Error ? reason.message : String(reason));
            }
          }}
        />
      )}
    </div>
  );
}

function AttentionCard({ flight }: { flight: Flight }) {
  const permissions = useAgentApprovalStore((state) => state.permissions);
  const edits = useAgentApprovalStore((state) => state.edits);
  const packetAgentProjection = usePacketAgentStore((state) => state.deployments[flight.id]);
  const attention = summarizeFlightAttention(flight, packetAgentProjection);
  const lifecycle = useFlightLifecycle(flight);
  const sessions = new Set(flightOwnedSessionIds(flight));
  const pending = [...sessions]
    .map((sessionId) => ({
      sessionId,
      count: (permissions.get(sessionId)?.length ?? 0) + (edits.get(sessionId)?.length ?? 0),
    }))
    .filter((item) => item.count > 0);
  if (["delivered", "archived"].includes(lifecycle.phase) && pending.length === 0) return null;
  const attempts = (flight.attempts ?? []).filter(
    (attempt) =>
      attempt.recovery?.state === "retained" ||
      attempt.status === "reviewing" ||
      attempt.status === "failed" ||
      attempt.reviewGate?.status === "error",
  );
  if (
    lifecycle.attentionCount === 0 &&
    attention.total === 0 &&
    attempts.length === 0 &&
    pending.length === 0
  )
    return null;
  return (
    <section
      id={`flight-attention-${flight.id}`}
      tabIndex={-1}
      aria-label="Flight attention"
      className="space-y-2 rounded border border-accent-amber/30 bg-accent-amber/5 p-3"
    >
      <h2 className="text-xs font-semibold text-accent-amber">Needs you</h2>
      {pending.map(({ sessionId, count }) => (
        <div
          key={sessionId}
          className="flex flex-wrap items-center gap-2 text-xs text-text-secondary"
        >
          <p className="min-w-0 flex-1">
            {count} tool or file approval{count === 1 ? "" : "s"} waiting for your decision.
          </p>
          <button
            type="button"
            onClick={() => openConversationInAgents(sessionId)}
            className="rounded border border-accent-amber/30 px-2 py-1 text-[11px] text-accent-amber"
          >
            Review approvals
          </button>
        </div>
      ))}
      {attempts.map((attempt) => (
        <div
          key={attempt.id}
          className="flex flex-wrap items-start gap-2 text-xs text-text-secondary"
        >
          <p className="min-w-0 flex-1 break-words">
            {attempt.recovery?.state === "retained"
              ? "Preserved work needs a recovery decision."
              : (attempt.errorMessage ??
                attempt.reviewGate?.errorMessage ??
                (attempt.reviewGate?.status === "running"
                  ? "Independent reviewer is checking this result."
                  : "Review this result and its evidence before accepting."))}
          </p>
          <button
            type="button"
            className="rounded border border-accent-amber/30 px-2 py-1 text-[11px] text-accent-amber"
            onClick={() => {
              const target = document.getElementById(`flight-attempt-${attempt.id}`);
              target?.scrollIntoView?.({ behavior: "smooth", block: "start" });
              target?.focus();
            }}
          >
            Open result
          </button>
        </div>
      ))}
      {attempts.length === 0 && <p className="text-xs text-text-secondary">{lifecycle.summary}</p>}
      {attention.packetAgent && (
        <p className="text-xs text-text-secondary">
          PacketAgent needs attention. Open Execution settings and integrations to inspect its
          handoff.
        </p>
      )}
    </section>
  );
}
interface StatGridProps {
  flight: Flight;
  tasks: { done: number; total: number; approvals: number; hasInProgress: boolean };
  sessions: number;
}

function StatGrid({ flight, tasks, sessions }: StatGridProps) {
  const tasksValueClass = tasks.hasInProgress ? "text-accent-green" : "text-text-primary";
  const approvalsValueClass = tasks.approvals > 0 ? "text-accent-amber" : "text-text-primary";

  const cells: {
    label: string;
    value: string;
    valueClass?: string;
  }[] = [
    { label: "Cost", value: formatCost(flight.totalCost ?? 0) },
    { label: "Tokens", value: formatTokens(flight.totalTokens) },
    {
      label: "Tasks",
      value: tasks.total ? `${tasks.done}/${tasks.total}` : "0/0",
      valueClass: tasksValueClass,
    },
    {
      label: "Approvals",
      value: `${tasks.approvals}`,
      valueClass: approvalsValueClass,
    },
    { label: "Sessions", value: `${sessions}` },
    { label: "Updated", value: relativeTime(flight.updatedAt) },
  ];

  return (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
      {cells.map((c) => (
        <div
          key={c.label}
          className="flex flex-col gap-0.5 rounded border border-bg-border bg-bg-secondary px-2.5 py-2"
        >
          <span className="text-[10px] uppercase tracking-[0.08em] text-text-muted">{c.label}</span>
          <span
            className={`font-mono text-[14px] font-semibold leading-tight ${
              c.valueClass ?? "text-text-primary"
            }`}
          >
            {c.value}
          </span>
        </div>
      ))}
    </div>
  );
}

function MilestonesCard({
  flight,
  tasks,
}: {
  flight: Flight;
  tasks: { done: number; total: number };
}) {
  const rows = useMemo(() => {
    const out: {
      id: string;
      title: string;
      done: boolean;
      running: boolean;
      agent: string;
      role?: TaskRole;
    }[] = [];
    for (const m of flight.milestones) {
      for (const t of m.tasks) {
        out.push({
          id: t.id,
          title: t.title,
          done: t.status === "done",
          running:
            t.status === "running" || t.status === "queued" || t.status === "approval_needed",
          agent: t.agentConfigId || "—",
          role: t.role,
        });
      }
    }
    return out;
  }, [flight.milestones]);

  return (
    <div className="flex min-h-0 flex-col overflow-hidden rounded border border-bg-border bg-bg-secondary">
      <div className="flex items-center gap-1.5 border-b border-line-soft px-2.5 py-2">
        <span className="text-[11px] font-semibold text-text-primary">Milestones</span>
        <span className="flex-1" />
        <span className="font-mono text-[10px] text-text-muted">
          {tasks.total > 0 ? `${tasks.done} / ${tasks.total} done` : "—"}
        </span>
      </div>
      <div className="flex-1 overflow-y-auto">
        {rows.length === 0 ? (
          <div className="px-3 py-4 text-[11px] text-text-muted">No milestones defined yet.</div>
        ) : (
          <div className="flex flex-col gap-1.5 p-2.5">
            {rows.map((m) => (
              <div key={m.id} className="flex items-center gap-2 text-[11.5px]">
                <span
                  className={`relative flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded ${
                    m.done
                      ? "border border-accent-green bg-accent-green"
                      : m.running
                        ? "border border-accent-line"
                        : "border border-line-strong"
                  }`}
                >
                  {m.done ? (
                    <Check size={9} className="text-bg-primary" strokeWidth={3} />
                  ) : m.running ? (
                    <span className="relative flex h-1.5 w-1.5">
                      <span className="absolute inset-0 animate-ping rounded-full bg-accent-amber opacity-60" />
                      <span className="relative h-1.5 w-1.5 rounded-full bg-accent-amber" />
                    </span>
                  ) : null}
                </span>
                <span
                  className={`flex-1 truncate ${
                    m.done ? "text-text-muted line-through" : "text-text-secondary"
                  }`}
                >
                  {m.title}
                </span>
                {m.role && (
                  <span
                    className={`shrink-0 text-[9px] font-medium uppercase tracking-wide ${TASK_ROLE_CONFIG[m.role].color}`}
                  >
                    {TASK_ROLE_CONFIG[m.role].label}
                  </span>
                )}
                <span className="max-w-[140px] shrink-0 truncate text-[10px] text-text-muted">
                  {m.agent}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function TimelineCard({ flight }: { flight: Flight }) {
  const events = useMemo<CoordinationEvent[]>(() => {
    const log = flight.coordinationLog ?? [];
    return [...log].sort((a, b) => b.timestamp - a.timestamp).slice(0, 30);
  }, [flight.coordinationLog]);

  const live = flight.status === "active";

  return (
    <div className="flex min-h-0 flex-col overflow-hidden rounded border border-bg-border bg-bg-secondary">
      <div className="flex items-center gap-1.5 border-b border-line-soft px-2.5 py-2">
        <span className="text-[11px] font-semibold text-text-primary">Live timeline</span>
        <span className="flex-1" />
        {live ? (
          <span className="relative flex h-2 w-2 items-center justify-center">
            <span className="absolute inset-0 animate-ping rounded-full bg-accent-green opacity-60" />
            <span className="relative h-1.5 w-1.5 rounded-full bg-accent-green" />
          </span>
        ) : (
          <span className="h-1.5 w-1.5 rounded-full bg-text-muted" />
        )}
      </div>
      <div className="flex-1 overflow-y-auto">
        {events.length === 0 ? (
          <div className="px-3 py-4 text-[11px] text-text-muted">No timeline events yet.</div>
        ) : (
          <div className="flex flex-col gap-2 p-2.5 text-[11px]">
            {events.map((e) => (
              <TimelineRow key={e.id} event={e} flight={flight} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function TimelineRow({ event, flight }: { event: CoordinationEvent; flight: Flight }) {
  const dot = EVENT_DOT[event.type] ?? "muted";
  const actor = event.agentId || (event.type === "escalation" ? "you" : "system");
  const [dismissed, setDismissed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const [captured, setCaptured] = useState(false);
  const captureManually = useMemoryStore((s) => s.captureManually);

  const doCapture = () => {
    if (captured) return;
    captureManually(
      buildCoordinationMemoryInput(
        event,
        flight,
        memoryScopeForWorkspace(flight.workspaceId, flight.projectPath),
      ),
    );
    setCaptured(true);
  };

  // E5: an escalation that carries a concrete suggestion becomes a one-click
  // reassignment. Other event types render as display-only text.
  const target = reassignTargetFromEscalation(event, flight.attempts ?? []);
  const showAction = Boolean(target) && !dismissed;
  const agentLabel = target
    ? (getProviderForAgent(target.agentId as AgentCli)?.name ?? target.agentId)
    : "";

  const doReassign = () => {
    if (!target || busy) return;
    setBusy(true);
    setFailed(false);
    void useAsyncFlightStore
      .getState()
      .reassignAttempt(flight.id, target.attemptId, target.agentId)
      .then(() => setDismissed(true))
      .catch((err) => {
        // e.g. the new provider is over its cost guardrail, or the backend
        // launch failed. Surface it and let the user retry rather than leaving
        // an unhandled rejection with a silently re-enabled button.
        console.warn("reassignAttempt failed", err);
        setFailed(true);
      })
      .finally(() => setBusy(false));
  };

  return (
    <div className="group flex items-start gap-2">
      <span className="w-[32px] shrink-0 pt-px font-mono text-[10px] text-text-muted">
        {eventTimeShort(event.timestamp)}
      </span>
      <span className={`mt-1 h-1.5 w-1.5 shrink-0 rounded-full ${DOT_BG[dot]}`} />
      <span className="flex-1 leading-snug">
        <span className="font-medium text-text-primary">{actor}</span>{" "}
        <span className="text-text-secondary">{event.summary}</span>{" "}
        <button
          type="button"
          onClick={doCapture}
          disabled={captured}
          title={captured ? "Saved to memory" : "Add this event to project memory"}
          className="ml-0.5 inline-flex items-center gap-0.5 align-baseline text-[10px] text-text-muted opacity-0 transition-opacity hover:text-accent-green disabled:text-accent-green disabled:opacity-100 group-hover:opacity-100"
        >
          <BookmarkPlus size={10} />
          {captured ? "Saved" : "Memory"}
        </button>
        {showAction && (
          <span className="mt-1 flex items-center gap-2">
            <button
              type="button"
              disabled={busy}
              onClick={doReassign}
              className="rounded border border-accent-green/40 bg-accent-green/10 px-1.5 py-0.5 text-[10px] text-accent-green hover:bg-accent-green/20 disabled:opacity-50"
            >
              {busy
                ? "Reassigning…"
                : failed
                  ? `Retry — reassign to ${agentLabel}`
                  : `Reassign to ${agentLabel}`}
            </button>
            <button
              type="button"
              onClick={() => setDismissed(true)}
              className="rounded border border-bg-border px-1.5 py-0.5 text-[10px] text-text-muted hover:text-text-secondary"
            >
              Dismiss
            </button>
          </span>
        )}
      </span>
    </div>
  );
}
