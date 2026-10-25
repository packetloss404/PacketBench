import { useState, useMemo } from "react";
import { Plus, Search, Sparkles } from "lucide-react";
import {
  useIssueStore,
  type Issue,
  type IssueStatus,
} from "@/stores/issueStore";
import { useFlightStore } from "@/stores/flightStore";
import { useWorkspaceStore } from "@/stores/workspaceStore";
import { useLayoutStore } from "@/stores/layoutStore";
import { APP_NAME_LOWER } from "@/lib/brand";
import { IssueCard } from "./IssueCard";
import { NewIssueForm } from "./NewIssueForm";
import { IssueDetail } from "./IssueDetail";
import { ConfirmDeleteIssueModal } from "./ConfirmDeleteIssueModal";
import {
  IssueFilterChips,
  type IssueFilterSelection,
} from "./IssueFilterChips";
// v0.8.5 — spec → issues import. Sibling component so we don't take a
// hard dependency on the views/ tree.
import { SpecImportModal } from "./SpecImportModal";

/**
 * v0.8.5: Kanban columns.
 *
 * Six user-facing columns, each backed by one or more `IssueStatus` values:
 *
 *   Backlog     — `backlog`
 *   Up Next     — `up_next` + legacy `todo`
 *   In Progress — `in_progress`
 *   In Review   — `in_review` (manual) OR display-only auto-promote when a
 *                 linked Flight has an attempt with a draft PR open
 *   Done        — `done`
 *
 * `blocked` and `needs_human` have their own **Needs Attention** column (E7)
 * so escalated / blocked work is visible instead of hidden inside In Progress —
 * a flight-attempt escalation flags its linked issues `needs_human`, landing
 * them here. `qa` still rolls into In Review so nothing disappears off the board.
 */
interface BoardColumn {
  key: string;
  label: string;
  /** Statuses that belong to this column. */
  statuses: IssueStatus[];
  /** Target status when an issue is dropped on this column. */
  dropTarget: IssueStatus;
}

const BOARD_COLUMNS: BoardColumn[] = [
  { key: "backlog", label: "Backlog", statuses: ["backlog"], dropTarget: "backlog" },
  { key: "up_next", label: "Up Next", statuses: ["up_next", "todo"], dropTarget: "up_next" },
  { key: "in_progress", label: "In Progress", statuses: ["in_progress"], dropTarget: "in_progress" },
  {
    key: "blocked",
    label: "Needs Attention",
    statuses: ["blocked", "needs_human"],
    dropTarget: "needs_human",
  },
  { key: "in_review", label: "In Review", statuses: ["in_review", "qa"], dropTarget: "in_review" },
  { key: "done", label: "Done", statuses: ["done"], dropTarget: "done" },
];

const EMPTY_FILTERS: IssueFilterSelection = {
  labels: [],
  epics: [],
  workspaces: [],
  assignees: [],
};

/**
 * Map every IssueStatus to a board column key. Statuses not listed above
 * fall back to Backlog so we never lose an Issue. Computed once.
 */
const STATUS_TO_COLUMN: Record<IssueStatus, string> = (() => {
  const map: Partial<Record<IssueStatus, string>> = {};
  for (const col of BOARD_COLUMNS) {
    for (const s of col.statuses) map[s] = col.key;
  }
  // Ensure exhaustive coverage at compile time by listing the union explicitly.
  const all: IssueStatus[] = [
    "backlog",
    "up_next",
    "todo",
    "in_progress",
    "in_review",
    "qa",
    "done",
    "blocked",
    "needs_human",
  ];
  for (const s of all) if (!map[s]) map[s] = "backlog";
  return map as Record<IssueStatus, string>;
})();

export function IssueBoard() {
  const issues = useIssueStore((s) => s.issues);
  const labels = useIssueStore((s) => s.labels);
  const epics = useIssueStore((s) => s.epics);
  const moveIssue = useIssueStore((s) => s.moveIssue);
  const flights = useFlightStore((s) => s.flights);
  const workspaces = useWorkspaceStore((s) => s.workspaces);
  const activeWorkspace = useWorkspaceStore((s) => s.workspaces.find((w) => w.id === s.activeWorkspaceId));

  const [showNewIssue, setShowNewIssue] = useState(false);
  const [showSpecImport, setShowSpecImport] = useState(false);
  // Bind-at-open: capture the projectPath when the user opens the spec import
  // modal so a workspace switch mid-edit doesn't suddenly retarget the AI
  // extraction call or stamp drafts with a different project.
  const [specImportProjectPath, setSpecImportProjectPath] = useState<string>("");
  const [newIssueColumn, setNewIssueColumn] = useState<IssueStatus>("up_next");
  const [dragOverColumn, setDragOverColumn] = useState<string | null>(null);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [selectedIssueId, setSelectedIssueId] = useState<string | null>(null);
  // Delete confirm for the card affordance. Owned by the board rather than the
  // card so the dialog survives the card unmounting when the delete lands.
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null);

  const [filterText, setFilterText] = useState("");
  const [filterFlight, setFilterFlight] = useState<string>("all");
  const [filterLabel, setFilterLabel] = useState<string>("all");

  // v0.8.5 chip filter state (local, not persisted).
  const [chipFilters, setChipFilters] = useState<IssueFilterSelection>(EMPTY_FILTERS);

  // Build the option set for chip filters.
  // Workspaces: only those with at least one linked Issue (per spec).
  const workspaceOptions = useMemo(() => {
    const linkedIds = new Set(
      issues
        .map((i) => i.workspaceId)
        .filter((id): id is string => typeof id === "string" && id.length > 0),
    );
    return workspaces
      .filter((w) => linkedIds.has(w.id))
      .map((w) => ({ id: w.id, name: w.name }));
  }, [issues, workspaces]);

  // Assignees: distinct non-empty values pulled from current issues.
  const assigneeOptions = useMemo(() => {
    const set = new Set<string>();
    for (const i of issues) {
      if (i.assignee && i.assignee.trim().length > 0) set.add(i.assignee);
    }
    return [...set].sort((a, b) => a.localeCompare(b));
  }, [issues]);

  const filteredIssues = useMemo(() => {
    return issues.filter((issue) => {
      // Free-text filter (toolbar, owned by Agent A — preserve behaviour).
      if (filterText) {
        const q = filterText.toLowerCase();
        const labelMatch = issue.labels.some((l) => l.toLowerCase().includes(q));
        const assigneeMatch = issue.assignee?.toLowerCase().includes(q) ?? false;
        const flight = flights.find((f) => f.issueIds.includes(issue.id));
        const flightMatch = flight ? flight.title.toLowerCase().includes(q) : false;
        if (
          !issue.title.toLowerCase().includes(q) &&
          !issue.description.toLowerCase().includes(q) &&
          !issue.ticketId.toLowerCase().includes(q) &&
          !labelMatch &&
          !assigneeMatch &&
          !flightMatch
        ) {
          return false;
        }
      }
      if (filterLabel !== "all" && !issue.labels.includes(filterLabel)) return false;
      if (filterFlight === "unassigned" && issue.flightId !== null) return false;
      if (filterFlight !== "all" && filterFlight !== "unassigned" && issue.flightId !== filterFlight) return false;

      // Chip filters (v0.8.5): within each category OR, across categories AND.
      if (chipFilters.labels.length > 0) {
        const hit = chipFilters.labels.some((l) => issue.labels.includes(l));
        if (!hit) return false;
      }
      if (chipFilters.epics.length > 0) {
        if (!issue.epic || !chipFilters.epics.includes(issue.epic)) return false;
      }
      if (chipFilters.workspaces.length > 0) {
        if (!issue.workspaceId || !chipFilters.workspaces.includes(issue.workspaceId)) return false;
      }
      if (chipFilters.assignees.length > 0) {
        if (!issue.assignee || !chipFilters.assignees.includes(issue.assignee)) return false;
      }
      return true;
    });
  }, [issues, flights, filterText, filterFlight, filterLabel, chipFilters]);

  const totalIssues = filteredIssues.length;
  const projectName = activeWorkspace?.name ?? APP_NAME_LOWER;

  /**
   * Display-only column override: an Issue with a linked Flight whose
   * attempts have a draft PR is shown in "In Review" regardless of its
   * stored status. We never mutate `issue.status` from here — moving the
   * card explicitly via drag still updates the underlying status.
   */
  function effectiveColumnKey(issue: Issue): string {
    if (issue.flightId) {
      const flight = flights.find((f) => f.id === issue.flightId);
      if (flight?.attempts?.some((a) => typeof a.draftPrNumber === "number")) {
        return "in_review";
      }
    }
    return STATUS_TO_COLUMN[issue.status] ?? "backlog";
  }

  function handleDragStart(e: React.DragEvent, issueId: string) {
    e.dataTransfer.setData("text/plain", issueId);
    e.dataTransfer.effectAllowed = "move";
    setDraggingId(issueId);
  }

  function handleDragEnd() {
    setDraggingId(null);
    setDragOverColumn(null);
  }

  function handleDragOver(e: React.DragEvent, columnKey: string) {
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    setDragOverColumn(columnKey);
  }

  function handleDragLeave() {
    setDragOverColumn(null);
  }

  function handleDrop(e: React.DragEvent, target: IssueStatus) {
    e.preventDefault();
    const issueId = e.dataTransfer.getData("text/plain");
    if (issueId) {
      moveIssue(issueId, target);
    }
    setDragOverColumn(null);
    setDraggingId(null);
  }

  function getIssuesForColumn(colKey: string): Issue[] {
    return filteredIssues.filter((i) => effectiveColumnKey(i) === colKey);
  }

  return (
    <div className="flex flex-1 flex-col gap-2.5 bg-bg-primary p-3 min-h-0 h-full">
      {/* Toolbar — owned by Agent A. Do not modify in this slice. */}
      <div className="flex items-center gap-2">
        <span className="text-[13px] font-semibold text-text-primary">
          Backlog &middot; {projectName}
        </span>
        <span className="rounded-full border border-bg-border bg-bg-secondary px-1.5 py-0 text-[10px] text-text-muted">
          {totalIssues} issue{totalIssues === 1 ? "" : "s"}
        </span>
        <div className="flex-1" />
        <div className="flex items-center gap-1.5 rounded-md border border-bg-border bg-bg-secondary px-2 py-1 text-[11px] text-text-secondary min-w-[200px]">
          <Search size={11} className="text-text-muted flex-shrink-0" />
          <input
            type="text"
            value={filterText}
            onChange={(e) => setFilterText(e.target.value)}
            placeholder="Filter by label, agent, flight…"
            className="flex-1 bg-transparent text-text-primary placeholder:text-text-muted focus:outline-none"
          />
        </div>
        <select
          value={filterLabel}
          onChange={(e) => setFilterLabel(e.target.value)}
          className="rounded-md border border-bg-border bg-bg-secondary px-2 py-1 text-[11px] text-text-secondary focus:border-accent-line focus:outline-none"
        >
          <option value="all">All labels</option>
          {labels.map((l) => (
            <option key={l} value={l}>{l}</option>
          ))}
        </select>
        <select
          value={filterFlight}
          onChange={(e) => setFilterFlight(e.target.value)}
          className="rounded-md border border-bg-border bg-bg-secondary px-2 py-1 text-[11px] text-text-secondary focus:border-accent-line focus:outline-none"
        >
          <option value="all">All flights</option>
          <option value="unassigned">Unassigned</option>
          {flights.map((f) => (
            <option key={f.id} value={f.id}>{f.title}</option>
          ))}
        </select>
        {/* v0.8.5 — Import spec button. Opens SpecImportModal, which mounts
            a one-shot claude-oauth sidecar session to break a pasted spec
            into Issue tickets. */}
        <button
          onClick={() => {
            // Capture the active project path at the moment the modal opens.
            // Read the workspace fresh (vs. closing over `activeWorkspace`)
            // and fall back to the live layoutStore value before opening.
            const ws = useWorkspaceStore.getState();
            const active = ws.workspaces.find((w) => w.id === ws.activeWorkspaceId);
            setSpecImportProjectPath(
              active?.projectPath ||
                useLayoutStore.getState().projectPath ||
                "",
            );
            setShowSpecImport(true);
          }}
          className="inline-flex items-center gap-1.5 rounded-md border border-bg-border bg-bg-secondary px-2 py-1 text-[11px] text-text-secondary transition-colors hover:border-line-strong hover:text-text-primary"
        >
          <Sparkles size={11} />
          Import spec
        </button>
        <button
          onClick={() => {
            setNewIssueColumn("up_next");
            setShowNewIssue(true);
          }}
          className="inline-flex items-center gap-1.5 rounded-md border border-accent-line bg-accent-soft px-2 py-1 text-[11px] font-medium text-accent-green transition-colors hover:bg-accent-green/20"
        >
          <Plus size={11} />
          New issue
        </button>
      </div>

      {/* v0.8.5: filter chips strip — multi-select chip filters that compose
          with (logical AND) the toolbar's text/label/flight selects above. */}
      <IssueFilterChips
        labels={labels}
        epics={epics}
        workspaces={workspaceOptions}
        assignees={assigneeOptions}
        selection={chipFilters}
        onChange={setChipFilters}
      />

      {/* Six Kanban columns (Backlog / Up Next / In Progress / Needs
          Attention / In Review / Done). Statuses that aren't first-class
          columns (qa/todo) roll up into the nearest column so nothing falls
          off the board.

          Layout: a single flex row, never a wrapping grid. `grid-cols-5` used
          to orphan the sixth column onto a second row with a dead right half.
          Columns share the width evenly (`flex-1 basis-0`) down to
          `min-w-[180px]`, below which the row scrolls horizontally instead of
          wrapping. At 1280px the six columns still fit without a scrollbar. */}
      <div className="flex flex-1 gap-2.5 min-h-0 overflow-x-auto">
        {BOARD_COLUMNS.map((col) => {
          const columnIssues = getIssuesForColumn(col.key);
          const isDragOver = dragOverColumn === col.key;

          return (
            <div
              key={col.key}
              data-testid="issue-board-column"
              className={`flex min-h-0 flex-1 basis-0 min-w-[180px] flex-col overflow-hidden rounded-md border bg-bg-secondary transition-colors ${
                isDragOver ? "border-accent-line" : "border-bg-border"
              }`}
              onDragOver={(e) => handleDragOver(e, col.key)}
              onDragLeave={handleDragLeave}
              onDrop={(e) => handleDrop(e, col.dropTarget)}
              onDragEnd={handleDragEnd}
            >
              <div className="flex items-center gap-1.5 border-b border-line-soft bg-bg-secondary px-2.5 py-2">
                <span className="text-[11px] font-semibold text-text-primary">
                  {col.label}
                </span>
                <span className="rounded-full border border-bg-border bg-bg-tertiary px-1.5 text-[10px] text-text-muted">
                  {columnIssues.length}
                </span>
                <div className="flex-1" />
                <button
                  onClick={() => {
                    setNewIssueColumn(col.dropTarget);
                    setShowNewIssue(true);
                  }}
                  className="text-text-faint transition-colors hover:text-text-secondary"
                >
                  <Plus size={11} />
                </button>
              </div>

              <div className="flex flex-1 flex-col gap-2 overflow-y-auto p-2">
                {isDragOver && draggingId && (
                  <div className="mx-1 h-1 rounded-full bg-accent-line transition-all" />
                )}
                {columnIssues.map((issue) => (
                  <IssueCard
                    key={issue.id}
                    issue={issue}
                    onDragStart={(e) => handleDragStart(e, issue.id)}
                    onClick={() => setSelectedIssueId(issue.id)}
                    isDragging={draggingId === issue.id}
                    onRequestDelete={() => setPendingDeleteId(issue.id)}
                  />
                ))}
                <button
                  onClick={() => {
                    setNewIssueColumn(col.dropTarget);
                    setShowNewIssue(true);
                  }}
                  className="inline-flex items-center justify-center gap-1.5 rounded-md border border-dashed border-line-strong bg-transparent px-2 py-1.5 text-[11px] text-text-faint transition-colors hover:border-text-muted hover:text-text-muted"
                >
                  <Plus size={11} />
                  Add
                </button>
              </div>
            </div>
          );
        })}
      </div>

      {showNewIssue && (
        <NewIssueForm
          defaultStatus={newIssueColumn}
          onClose={() => setShowNewIssue(false)}
        />
      )}

      {selectedIssueId && (
        <IssueDetail
          issueId={selectedIssueId}
          onClose={() => setSelectedIssueId(null)}
        />
      )}

      {/* Card-level delete confirm. Deleting the issue whose detail panel is
          open also closes that panel, so we never leave a detail pane pointed
          at a record that no longer exists. */}
      {pendingDeleteId && (
        <ConfirmDeleteIssueModal
          issueId={pendingDeleteId}
          onDeleted={() => {
            if (selectedIssueId === pendingDeleteId) setSelectedIssueId(null);
          }}
          onClose={() => setPendingDeleteId(null)}
        />
      )}

      {/* v0.8.5 — Spec import modal. Wired in the toolbar above. We snapshot
          the active workspace's project path at the moment the user opens the
          modal (see the Import-spec button) so a workspace switch while the
          modal is open doesn't retarget the AI extraction call or stamp the
          drafts with a different project. The modal short-circuits rendering
          when `open` is false so the mount can stay live. */}
      <SpecImportModal
        open={showSpecImport}
        onClose={() => setShowSpecImport(false)}
        projectPath={specImportProjectPath}
      />
    </div>
  );
}
