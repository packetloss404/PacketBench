import { useEffect, useState } from "react";
import {
  ChevronDown,
  ChevronRight,
  Plus,
  Trash2,
  Play,
  Target,
  X,
  LayoutGrid,
  UserPlus,
  Check,
  ExternalLink,
} from "lucide-react";
import { Modal } from "@/components/ui/Modal";
import { useIssueStore, type Issue, type IssueStatus } from "@/stores/issueStore";
import { useFlightStore } from "@/stores/flightStore";
import { useAppStore } from "@/stores/appStore";
import { useLayoutStore } from "@/stores/layoutStore";
import { useWorkspaceStore } from "@/stores/workspaceStore";
import { writePty } from "@/lib/tauri";
import { getLabelColor, getPriorityColor } from "@/lib/colors";
import { ConfirmDeleteIssueModal } from "./ConfirmDeleteIssueModal";
import { IssueDependencyList } from "./IssueDependencyList";
import { IssueCommentList } from "./IssueCommentList";
import { IssueCommentComposer } from "./IssueCommentComposer";
import { MarkdownRenderer } from "@/components/common/MarkdownRenderer";
import { useToast } from "@/components/ui/Toast";

interface IssueDetailProps {
  issueId: string;
  onClose: () => void;
}

const STATUS_BUTTONS: { key: IssueStatus; label: string }[] = [
  { key: "backlog", label: "Backlog" },
  { key: "up_next", label: "Up Next" },
  { key: "todo", label: "To Do" },
  { key: "in_progress", label: "In Progress" },
  { key: "in_review", label: "In Review" },
  { key: "qa", label: "QA" },
  { key: "done", label: "Done" },
  { key: "blocked", label: "Blocked" },
  { key: "needs_human", label: "Needs Human" },
];

function getStatusButtonColor(status: IssueStatus, isActive: boolean): string {
  if (!isActive)
    return "bg-bg-primary border-bg-border text-text-muted hover:bg-bg-hover hover:text-text-secondary";
  switch (status) {
    case "backlog":
      return "bg-text-faint/20 border-text-faint/40 text-text-secondary";
    case "up_next":
      return "bg-accent-blue/15 border-accent-blue/35 text-accent-blue";
    case "todo":
      return "bg-text-muted/20 border-text-muted/40 text-text-primary";
    case "in_progress":
      return "bg-accent-blue/20 border-accent-blue/40 text-accent-blue";
    case "in_review":
      return "bg-accent-purple/20 border-accent-purple/40 text-accent-purple";
    case "qa":
      return "bg-accent-amber/20 border-accent-amber/40 text-accent-amber";
    case "done":
      return "bg-accent-green/20 border-accent-green/40 text-accent-green";
    case "blocked":
      return "bg-accent-red/20 border-accent-red/40 text-accent-red";
    case "needs_human":
      return "bg-accent-purple/20 border-accent-purple/40 text-accent-purple";
    default:
      return "bg-bg-elevated border-bg-border text-text-primary";
  }
}

function formatDate(timestamp: number): string {
  const d = new Date(timestamp);
  return (
    d.toLocaleDateString("en-US", {
      month: "numeric",
      day: "numeric",
      year: "numeric",
    }) +
    " at " +
    d.toLocaleTimeString("en-US", {
      hour: "2-digit",
      minute: "2-digit",
      hour12: true,
    })
  );
}

/**
 * v0.8.5: IssueDetail — the unified detail panel that opens when a Kanban
 * card is clicked. Combines status controls, acceptance-criteria management,
 * dependencies, flight assignment, the v0.8.5-B workspace handoff link
 * (read-only here; CTA lives on the card), assignee editing, and the new
 * inline comment thread.
 *
 * Mounted by IssueBoard as its issue detail panel.
 */
export function IssueDetail({ issueId, onClose }: IssueDetailProps) {
  const issues = useIssueStore((s) => s.issues);
  const moveIssue = useIssueStore((s) => s.moveIssue);
  const updateIssue = useIssueStore((s) => s.updateIssue);
  const toggleCriterion = useIssueStore((s) => s.toggleCriterion);
  const addCriterion = useIssueStore((s) => s.addCriterion);
  const removeCriterion = useIssueStore((s) => s.removeCriterion);
  const addBlockedBy = useIssueStore((s) => s.addBlockedBy);
  const removeBlockedBy = useIssueStore((s) => s.removeBlockedBy);
  const addBlocks = useIssueStore((s) => s.addBlocks);
  const removeBlocks = useIssueStore((s) => s.removeBlocks);
  const assignToFlight = useIssueStore((s) => s.assignToFlight);

  const flights = useFlightStore((s) => s.flights);
  const addIssueToFlight = useFlightStore((s) => s.addIssueToFlight);
  const removeIssueFromFlight = useFlightStore((s) => s.removeIssueFromFlight);

  const workspaces = useWorkspaceStore((s) => s.workspaces);
  const toast = useToast();

  const [showDepGraph, setShowDepGraph] = useState(false);
  const [newCriterionText, setNewCriterionText] = useState("");
  const [showWorkspacePicker, setShowWorkspacePicker] = useState(false);
  const [editingAssignee, setEditingAssignee] = useState(false);
  const [assigneeDraft, setAssigneeDraft] = useState("");
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  // A nested confirm (comment delete) owns Escape while it is open — see the
  // `closeOnEscape` note on the Modal below.
  const [nestedConfirmOpen, setNestedConfirmOpen] = useState(false);

  const foundIssue = issues.find((i) => i.id === issueId);

  // The issue can vanish under us — deleted from this panel's own footer, from
  // the board's card affordance, or by any other store writer. Navigate away
  // rather than sitting on a blank detail pane.
  useEffect(() => {
    if (!foundIssue) onClose();
  }, [foundIssue, onClose]);

  if (!foundIssue) return null;
  const issue = foundIssue;

  const priorityInfo = getPriorityColor(issue.priority);
  const checkedCount = issue.acceptanceCriteria.filter((c) => c.checked).length;
  const totalCriteria = issue.acceptanceCriteria.length;
  const comments = issue.comments ?? [];

  const blockedByIssues = issue.blockedBy
    .map((id) => issues.find((i) => i.id === id))
    .filter(Boolean) as Issue[];
  const blocksIssues = issue.blocks
    .map((id) => issues.find((i) => i.id === id))
    .filter(Boolean) as Issue[];

  const availableForBlockedBy = issues.filter(
    (i) => i.id !== issue.id && !issue.blockedBy.includes(i.id) && !issue.blocks.includes(i.id),
  );
  const availableForBlocks = issues.filter(
    (i) => i.id !== issue.id && !issue.blocks.includes(i.id) && !issue.blockedBy.includes(i.id),
  );

  const linkedWorkspace = issue.workspaceId
    ? workspaces.find((w) => w.id === issue.workspaceId)
    : null;

  function handleAddCriterion() {
    if (!newCriterionText.trim()) return;
    addCriterion(issueId, newCriterionText.trim());
    setNewCriterionText("");
  }

  function startEditingAssignee() {
    setAssigneeDraft(issue.assignee ?? "");
    setEditingAssignee(true);
  }

  function commitAssignee() {
    const next = assigneeDraft.trim();
    updateIssue(issueId, { assignee: next.length === 0 ? undefined : next });
    setEditingAssignee(false);
  }

  function buildIssuePrompt(): string {
    const lines: string[] = [];
    lines.push(`Work on this issue:`);
    lines.push(``);
    lines.push(`## ${issue.ticketId}: ${issue.title}`);
    if (issue.description) {
      lines.push(``);
      lines.push(issue.description);
    }
    if (issue.acceptanceCriteria.length > 0) {
      lines.push(``);
      lines.push(`### Acceptance Criteria`);
      for (const c of issue.acceptanceCriteria) {
        lines.push(`- [${c.checked ? "x" : " "}] ${c.text}`);
      }
    }
    if (issue.labels.length > 0) {
      lines.push(``);
      lines.push(`Labels: ${issue.labels.join(", ")}`);
    }
    if (issue.priority) {
      lines.push(`Priority: ${issue.priority}`);
    }
    return lines.join("\n");
  }

  async function handleSendToWorkspace(workspaceId: string) {
    const ws = useWorkspaceStore.getState().workspaces.find((w) => w.id === workspaceId);
    if (!ws) return;
    const paneWithSession = ws.panes.find((p) => p.sessionId);
    if (!paneWithSession?.sessionId) return;

    const prompt = buildIssuePrompt();
    await writePty(paneWithSession.sessionId, prompt + "\r");

    // Stamp the linkage on the Issue so the card reflects "→ Workspace"
    // and we never re-offer the Send CTA for an Issue that's already in
    // a workspace. Mirrors what `sendIssueToWorkspace` does for new
    // workspaces; this branch is the "send to an existing pane" path.
    useIssueStore.getState().updateIssue(issue.id, {
      workspaceId,
      sessionId: paneWithSession.sessionId,
      sentToWorkspaceAt: Date.now(),
      status: issue.status === "done" ? issue.status : "in_progress",
    });

    useWorkspaceStore.getState().setActiveWorkspace(workspaceId);
    useAppStore.getState().setActiveView("workspace");
    onClose();
  }

  async function handleCreateAndSend() {
    // Use the canonical orchestrator action so the Issue picks up the
    // worktree-with-hook (auto-Done loop) and the linkage stamps land in
    // one place. The card's CTA goes through the same path.
    const result = await useIssueStore.getState().sendIssueToWorkspace(issue.id);
    // A degraded handoff still opens a workspace, so the only signal the user
    // would otherwise get is the auto-Done that never arrives days later.
    if (result?.warning) toast.error(result.warning);
    onClose();
  }

  function jumpToLinkedWorkspace() {
    if (!linkedWorkspace) return;
    useWorkspaceStore.getState().setActiveWorkspace(linkedWorkspace.id);
    useAppStore.getState().setActiveView("workspace");
    onClose();
  }

  function buildDepGraph(): string[] {
    const lines: string[] = [];
    lines.push(`${issue.ticketId}`);
    if (blockedByIssues.length > 0) {
      for (const b of blockedByIssues) {
        const marker = b.status === "done" ? "[done]" : "[pending]";
        lines.push(`  <- ${b.ticketId} ${marker}`);
      }
    }
    if (blocksIssues.length > 0) {
      for (const b of blocksIssues) {
        const marker = b.status === "done" ? "[done]" : "[pending]";
        lines.push(`  -> ${b.ticketId} ${marker}`);
      }
    }
    return lines;
  }

  const titleWithMeta = (
    <>
      <span className={issue.status === "done" ? "line-through opacity-60" : ""}>
        {issue.ticketId}: {issue.title}
      </span>
      <div className="mt-1 flex flex-wrap items-center gap-2">
        <span className={`text-[11px] font-medium ${priorityInfo.cls}`}>{priorityInfo.text}</span>
        <span className="text-[10px] text-text-muted">{formatDate(issue.createdAt)}</span>
        {issue.labels.map((label) => {
          const color = getLabelColor(label);
          return (
            <span
              key={label}
              className={`rounded px-1.5 py-0.5 text-[9px] font-medium ${color.bg} ${color.text}`}
            >
              {label}
            </span>
          );
        })}
        {issue.epic && (
          <span className="rounded bg-accent-purple/15 px-1.5 py-0.5 text-[9px] font-medium text-accent-purple">
            {issue.epic}
          </span>
        )}
      </div>
    </>
  );

  return (
    <Modal
      onClose={onClose}
      title=""
      width="w-[600px]"
      // While a delete confirm is layered on top, that dialog owns Escape:
      // window listeners fire in mount order, so without this the panel would
      // close out from under the confirm the user is still reading.
      closeOnEscape={!confirmingDelete && !nestedConfirmOpen}
      footer={
        <div className="flex items-center justify-between">
          <button
            type="button"
            onClick={() => setConfirmingDelete(true)}
            title={`Delete ${issue.ticketId}`}
            className="inline-flex items-center gap-1.5 rounded px-2 py-1 text-[11px] text-text-muted transition-colors hover:bg-accent-red/10 hover:text-accent-red"
          >
            <Trash2 size={11} />
            Delete issue
          </button>
          <button
            type="button"
            onClick={onClose}
            className="rounded px-3 py-1 text-[11px] text-text-secondary transition-colors hover:bg-bg-hover"
          >
            Close
          </button>
        </div>
      }
    >
      <div className="border-b border-bg-border px-5 pb-3 pt-1">
        <h2 className="text-sm font-semibold leading-snug text-text-primary">{titleWithMeta}</h2>
      </div>

      <div className="flex flex-col gap-4 px-5 py-4">
        {/* Description (markdown so notes from spec import render properly) */}
        {issue.description && (
          <div className="text-xs leading-relaxed text-text-secondary">
            <MarkdownRenderer content={issue.description} />
          </div>
        )}

        {/* Status buttons row */}
        <div>
          <label className="mb-1.5 block text-[10px] uppercase tracking-wider text-text-muted">
            Status
          </label>
          <div className="flex flex-wrap gap-1.5">
            {STATUS_BUTTONS.map((s) => (
              <button
                key={s.key}
                onClick={() => moveIssue(issueId, s.key)}
                className={`rounded border px-2.5 py-1 text-[11px] transition-colors ${getStatusButtonColor(s.key, issue.status === s.key)}`}
              >
                {s.label}
              </button>
            ))}
          </div>
        </div>

        {/* Linked workspace pill (read-only — handoff CTA lives on the card) */}
        {linkedWorkspace && (
          <div>
            <label className="mb-1.5 block text-[10px] uppercase tracking-wider text-text-muted">
              Workspace
            </label>
            <button
              type="button"
              onClick={jumpToLinkedWorkspace}
              className="group inline-flex items-center gap-2 rounded border border-bg-border bg-bg-primary px-2.5 py-1.5 transition-colors hover:border-accent-green/40"
            >
              <LayoutGrid size={12} className="flex-shrink-0 text-accent-green" />
              <span className="truncate text-[11px] text-text-primary">{linkedWorkspace.name}</span>
              <ExternalLink
                size={10}
                className="text-text-muted transition-colors group-hover:text-accent-green"
              />
            </button>
          </div>
        )}

        {/* Work on this issue (only when no linked workspace) */}
        {!linkedWorkspace &&
          (!showWorkspacePicker ? (
            <button
              onClick={() => setShowWorkspacePicker(true)}
              className="flex items-center justify-center gap-2 rounded-lg border border-accent-green/30 bg-accent-green/15 py-2.5 text-xs font-medium text-accent-green transition-colors hover:bg-accent-green/25"
            >
              <Play size={14} />
              Work on this issue
            </button>
          ) : (
            <WorkspacePicker
              onSelect={(wsId) => void handleSendToWorkspace(wsId)}
              onCreate={handleCreateAndSend}
              onCancel={() => setShowWorkspacePicker(false)}
            />
          ))}

        {/* Assignee */}
        <div>
          <label className="mb-1.5 block text-[10px] uppercase tracking-wider text-text-muted">
            Assignee
          </label>
          {editingAssignee ? (
            <div className="flex items-center gap-1.5">
              <input
                type="text"
                autoFocus
                value={assigneeDraft}
                onChange={(e) => setAssigneeDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    commitAssignee();
                  } else if (e.key === "Escape") {
                    e.preventDefault();
                    setEditingAssignee(false);
                  }
                }}
                placeholder='username, email, or "me"'
                className="flex-1 rounded border border-bg-border bg-bg-primary px-2 py-1 text-[11px] text-text-primary placeholder:text-text-muted focus:border-accent-green focus:outline-none"
              />
              <button
                type="button"
                onClick={commitAssignee}
                className="p-1 text-accent-green transition-colors hover:text-accent-green/80"
                title="Save"
              >
                <Check size={12} />
              </button>
              <button
                type="button"
                onClick={() => setEditingAssignee(false)}
                className="p-1 text-text-muted transition-colors hover:text-text-secondary"
                title="Cancel"
              >
                <X size={12} />
              </button>
            </div>
          ) : issue.assignee ? (
            <button
              type="button"
              onClick={startEditingAssignee}
              className="inline-flex items-center gap-1.5 rounded border border-bg-border bg-bg-primary px-2.5 py-1 text-[11px] text-text-primary transition-colors hover:border-accent-green/40"
            >
              <UserPlus size={11} className="text-accent-green" />
              {issue.assignee}
            </button>
          ) : (
            <button
              type="button"
              onClick={startEditingAssignee}
              className="inline-flex items-center gap-1.5 rounded border border-dashed border-bg-border bg-bg-primary px-2.5 py-1 text-[11px] text-text-muted transition-colors hover:border-line-strong hover:text-text-secondary"
            >
              <UserPlus size={11} />
              Assign...
            </button>
          )}
        </div>

        {/* Flight assignment */}
        <div>
          <label className="mb-1.5 block text-[10px] uppercase tracking-wider text-text-muted">
            Flight
          </label>
          {issue.flightId ? (
            <div className="flex items-center gap-2 rounded border border-bg-border bg-bg-primary px-2.5 py-1.5">
              <Target size={12} className="flex-shrink-0 text-accent-green" />
              <span className="flex-1 truncate text-[11px] text-text-primary">
                {flights.find((f) => f.id === issue.flightId)?.title || "Unknown flight"}
              </span>
              <button
                onClick={() => {
                  if (issue.flightId) {
                    removeIssueFromFlight(issue.flightId, issue.id);
                    assignToFlight(issue.id, null);
                  }
                }}
                className="flex-shrink-0 p-0.5 text-text-muted transition-colors hover:text-accent-red"
                title="Remove from flight"
              >
                <X size={10} />
              </button>
            </div>
          ) : (
            <select
              className="w-full rounded border border-bg-border bg-bg-primary px-2 py-1.5 text-[11px] text-text-secondary focus:border-accent-green focus:outline-none"
              value=""
              onChange={(e) => {
                if (e.target.value) {
                  addIssueToFlight(e.target.value, issue.id);
                  assignToFlight(issue.id, e.target.value);
                }
              }}
            >
              <option value="">Assign to flight...</option>
              {flights.map((f) => (
                <option key={f.id} value={f.id}>
                  {f.title}
                </option>
              ))}
            </select>
          )}
        </div>

        <IssueDependencyList
          label="Blocked By"
          emptyText="No blockers"
          selectPlaceholder="Select blocking issue..."
          linkedIssues={blockedByIssues}
          availableIssues={availableForBlockedBy}
          onAdd={(targetId) => addBlockedBy(issueId, targetId)}
          onRemove={(targetId) => removeBlockedBy(issueId, targetId)}
        />

        <IssueDependencyList
          label="Blocks"
          emptyText="No downstream issues"
          selectPlaceholder="Select issue to block..."
          linkedIssues={blocksIssues}
          availableIssues={availableForBlocks}
          onAdd={(targetId) => addBlocks(issueId, targetId)}
          onRemove={(targetId) => removeBlocks(issueId, targetId)}
        />

        {(blockedByIssues.length > 0 || blocksIssues.length > 0) && (
          <div>
            <button
              onClick={() => setShowDepGraph(!showDepGraph)}
              className="flex items-center gap-1 text-[10px] uppercase tracking-wider text-text-muted transition-colors hover:text-text-secondary"
            >
              {showDepGraph ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
              Dependency Graph
            </button>
            {showDepGraph && (
              <div className="mt-1.5 rounded border border-bg-border bg-bg-primary p-2">
                <pre className="font-mono text-[10px] leading-relaxed text-text-secondary">
                  {buildDepGraph().join("\n")}
                </pre>
              </div>
            )}
          </div>
        )}

        {/* Acceptance Criteria */}
        <div>
          <label className="mb-1.5 block text-[10px] uppercase tracking-wider text-text-muted">
            Acceptance Criteria ({checkedCount}/{totalCriteria} complete)
          </label>
          {issue.acceptanceCriteria.length > 0 ? (
            <div className="flex flex-col gap-1.5">
              {issue.acceptanceCriteria.map((criterion) => (
                <div key={criterion.id} className="group flex items-start gap-2">
                  <input
                    type="checkbox"
                    checked={criterion.checked}
                    onChange={() => toggleCriterion(issueId, criterion.id)}
                    className="mt-0.5 cursor-pointer accent-[#00ff41]"
                  />
                  <span
                    className={`flex-1 text-[11px] leading-snug ${
                      criterion.checked ? "text-text-muted line-through" : "text-text-secondary"
                    }`}
                  >
                    {criterion.text}
                  </span>
                  <button
                    onClick={() => removeCriterion(issueId, criterion.id)}
                    className="flex-shrink-0 p-0.5 text-text-muted opacity-0 transition-opacity hover:text-accent-red group-hover:opacity-100"
                  >
                    <Trash2 size={10} />
                  </button>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-[10px] text-text-muted">No acceptance criteria defined</p>
          )}

          <div className="mt-2 flex items-center gap-1.5">
            <input
              type="text"
              value={newCriterionText}
              onChange={(e) => setNewCriterionText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  handleAddCriterion();
                }
              }}
              placeholder="Add criterion..."
              className="flex-1 rounded border border-bg-border bg-bg-primary px-2 py-1 text-[11px] text-text-primary placeholder:text-text-muted focus:border-accent-green focus:outline-none"
            />
            <button
              onClick={handleAddCriterion}
              disabled={!newCriterionText.trim()}
              className="p-1 text-text-muted transition-colors hover:text-accent-green disabled:opacity-30"
            >
              <Plus size={14} />
            </button>
          </div>
        </div>

        {/* Comments thread (v0.8.5) */}
        <div>
          <label className="mb-1.5 block text-[10px] uppercase tracking-wider text-text-muted">
            Comments
          </label>
          <IssueCommentList
            issueId={issueId}
            comments={comments}
            onConfirmingChange={setNestedConfirmOpen}
          />
          <div className="mt-2">
            <IssueCommentComposer issueId={issueId} />
          </div>
        </div>
      </div>

      {/* Layered on top of this panel. `Modal` renders a viewport-fixed
          overlay, so nesting it here paints it above the detail panel rather
          than inside the scrolling body. */}
      {confirmingDelete && (
        <ConfirmDeleteIssueModal
          issueId={issueId}
          onDeleted={onClose}
          onClose={() => setConfirmingDelete(false)}
        />
      )}
    </Modal>
  );
}

function WorkspacePicker({
  onSelect,
  onCreate,
  onCancel,
}: {
  onSelect: (workspaceId: string) => void;
  onCreate: () => void;
  onCancel: () => void;
}) {
  const workspaces = useWorkspaceStore((s) => s.workspaces);
  const projectPath = useLayoutStore((s) => s.projectPath);
  const projectName = projectPath.split(/[/\\]/).pop() || "Workspace";

  const activeWorkspaces = workspaces.filter(
    (w) =>
      w.status === "active" &&
      w.projectPath.replace(/\\/g, "/").toLowerCase() ===
        projectPath.replace(/\\/g, "/").toLowerCase(),
  );

  const workspacesWithSessions = activeWorkspaces.filter((w) => w.panes.some((p) => p.sessionId));

  return (
    <div className="rounded-lg border border-bg-border bg-bg-primary p-3">
      <div className="mb-2 flex items-center justify-between">
        <span className="text-[10px] font-medium uppercase tracking-wider text-text-muted">
          Send to workspace
        </span>
        <button onClick={onCancel} className="text-text-muted hover:text-text-primary">
          <X size={12} />
        </button>
      </div>
      <div className="flex flex-col gap-1">
        {workspacesWithSessions.map((ws) => (
          <button
            key={ws.id}
            onClick={() => onSelect(ws.id)}
            className="flex w-full items-center gap-2 rounded-lg border border-bg-border bg-bg-secondary px-3 py-2 text-left transition-colors hover:border-accent-green/30 hover:bg-bg-hover"
          >
            <LayoutGrid size={12} className="flex-shrink-0 text-text-muted" />
            <span className="truncate text-[11px] font-medium text-text-primary">{ws.name}</span>
            <span className="ml-auto flex-shrink-0 text-[10px] text-text-muted">
              {ws.panes.filter((p) => p.sessionId).length} active
            </span>
          </button>
        ))}
        <button
          onClick={onCreate}
          className="flex w-full items-center gap-2 rounded-lg border border-accent-green/20 bg-accent-green/5 px-3 py-2 text-left transition-colors hover:bg-accent-green/10"
        >
          <Plus size={12} className="flex-shrink-0 text-accent-green" />
          <span className="truncate text-[11px] font-medium text-accent-green">
            Create workspace "{projectName}"
          </span>
        </button>
      </div>
    </div>
  );
}
