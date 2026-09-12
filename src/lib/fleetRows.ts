/**
 * Tile program (P4-S2) — fleetRows: the PURE workspace/compatibility
 * projection used by FleetSidebar.
 *
 * The row unit is the workspace (ruled). This module folds two independent
 * engines into a configurable list of rows:
 *   - a `workspace` row for every workspace (its rolled-up status from
 *     `sessionStatus`, its member tiles as agent-colored chips);
 *   - optionally, a `virtual` row for every conversation that has NO tile anywhere
 *     (unplaced) — the derived-projection "no bulk migration" model: a legacy
 *     conversation appears as a first-class row and materializes a wrapper
 *     workspace only when clicked (`sessionGlue.openSession`).
 *
 * A placed conversation is represented by the workspace row holding its tile,
 * never by a second virtual row. WA1's Workspace surface disables virtual rows
 * so Agents owns unplaced conversations while compatibility panes remain.
 *
 * Pure and total: it takes fully-materialized inputs (no stores) so it is
 * trivially testable and re-runs cheaply from memoized store slices. The status
 * on every row comes from `sessionStatus` — this module never re-derives
 * attention.
 */
import type { AgentConversation } from "@/types/agent-conversation";
import type { Workspace } from "@/types/workspace";
import { isSshWorkspace } from "@/types/workspace";
import type { Attention } from "@/lib/sessionIndex";
import { API_PROVIDERS } from "@/lib/api-models";
import { getAgentColor } from "@/lib/agentColors";
import { workspacePaneSummaryIdentity } from "@/lib/workspacePaneSummary";

export type FleetFilter = "all" | "active" | "done" | "archived";

/** One aggregated agent chip on a multi-tile workspace row. */
export interface FleetChip {
  /** Short agent label ("Claude", "Codex", "Terminal"). */
  label: string;
  /** Number of tiles of this agent in the workspace. */
  count: number;
  /** Agent-color text token. */
  colorClass: string;
  /** A member tile of this agent is asking for the user (amber per-chip dot). */
  needsYou: boolean;
}

interface FleetRowBase {
  /** Row identity. Stable across restarts: workspace.id or conversationId. */
  id: string;
  title: string;
  projectPath: string;
  attention: Attention;
  updatedAt: number;
  archived: boolean;
  /** Single-tile rows render like a conversation row (line-2 chips omitted). */
  singleTile: boolean;
  /** Agent chips (line 2) — empty for single-tile rows. */
  chips: FleetChip[];
  /** SSH grouping metadata. */
  isSsh: boolean;
  /**
   * Tile program (P4-S3): a member/own conversation holds an unlanded worktree
   * (`worktree.state === "active"`). Drives the standing "worktree pending" chip
   * — the visible signal that archiving Kept the tree rather than losing it.
   */
  worktreePending: boolean;
}

export interface WorkspaceFleetRow extends FleetRowBase {
  kind: "workspace";
  workspaceId: string;
  /** The pane to focus+flash on a needs-you click (the first member asking). */
  needsYouPaneId?: string;
}

export interface VirtualFleetRow extends FleetRowBase {
  kind: "virtual";
  conversationId: string;
}

export type FleetRow = WorkspaceFleetRow | VirtualFleetRow;

export interface FleetGroup {
  key: string;
  projectPath: string;
  isSsh: boolean;
  /** SSH server display name, when the group is a remote target. */
  sshName?: string;
  rows: FleetRow[];
}

export interface FleetProjection {
  /** Rows demanding attention, pulled to the top (empty while searching). */
  needsYou: FleetRow[];
  /** The remaining rows grouped by project. */
  groups: FleetGroup[];
  /** Flat, pinned-first list when a search query is active. */
  searchRows: FleetRow[];
  /** Search snippets keyed by row id (title or first message match). */
  snippets: Map<string, string>;
  counts: { all: number; active: number; done: number; archived: number };
}

export interface BuildFleetInput {
  workspaces: readonly Workspace[];
  conversations: readonly AgentConversation[];
  conversationAttention: ReadonlyMap<string, Attention>;
  workspaceStatuses: ReadonlyMap<string, Attention>;
  attemptSessionIds: ReadonlySet<string>;
  prefs: Record<string, { pinned?: boolean }>;
  filter: FleetFilter;
  /** Raw search text (trimmed by the caller is fine — trimmed again here). */
  query: string;
  /**
   * Compatibility switch. Defaults true for persisted projection callers and
   * pure tests. Workspace passes false under the WA1 split because unplaced
   * conversations now belong to the Agents sidebar.
   */
  includeVirtualConversations?: boolean;
}

// ─── Labels ─────────────────────────────────────────────────────────────────

/** Short display label for an agent CLI / api-agent id. */
export function agentLabelFor(agent: string): string {
  if (agent === "terminal") return "Terminal";
  const provider = API_PROVIDERS.find((p) => p.agentCli === agent);
  if (provider) return provider.name.replace(" (API)", "").replace(" (Local)", "");
  const labels: Record<string, string> = {
    "claude-code": "Claude",
    codex: "Codex",
    opencode: "OpenCode",
    packetcode: "PacketCode",
  };
  return labels[agent] ?? agent;
}

export function basenameOf(path: string): string {
  const segments = path.replace(/\\/g, "/").split("/").filter(Boolean);
  return segments[segments.length - 1] ?? path;
}

/** Build a short match snippet around the first hit of `q` in `content`. */
export function buildSnippet(content: string, q: string): string | null {
  const idx = content.toLowerCase().indexOf(q);
  if (idx < 0) return null;
  const half = Math.max(0, Math.floor((60 - q.length) / 2));
  const start = Math.max(0, idx - half);
  const end = Math.min(content.length, idx + q.length + half);
  let snippet = content.slice(start, end).replace(/\s+/g, " ").trim();
  if (start > 0) snippet = "..." + snippet;
  if (end < content.length) snippet = snippet + "...";
  return snippet;
}

// ─── Attention classification ───────────────────────────────────────────────

function isDoneAttention(a: Attention): boolean {
  return a === "done" || a === "failed";
}

// ─── Chip aggregation ───────────────────────────────────────────────────────

function buildChips(
  workspace: Workspace,
  conversationAttention: ReadonlyMap<string, Attention>,
): { chips: FleetChip[]; needsYouPaneId?: string } {
  // Aggregate panes by agent label; a chip carries a needs-you dot if ANY of
  // its tiles is asking for the user.
  const order: string[] = [];
  const byLabel = new Map<string, FleetChip>();
  let needsYouPaneId: string | undefined;

  for (const pane of workspace.panes) {
    const identity = workspacePaneSummaryIdentity(pane);
    let paneNeeds = false;
    if (pane.kind === "conversation" && pane.conversationId) {
      paneNeeds = conversationAttention.get(pane.conversationId) === "needs_you";
    }
    if (paneNeeds && needsYouPaneId === undefined) needsYouPaneId = pane.id;

    const label = identity.label;
    const existing = byLabel.get(label);
    if (existing) {
      existing.count += 1;
      existing.needsYou = existing.needsYou || paneNeeds;
    } else {
      order.push(label);
      byLabel.set(label, {
        label,
        count: 1,
        colorClass: identity.color.text,
        needsYou: paneNeeds,
      });
    }
  }
  return { chips: order.map((l) => byLabel.get(l)!), needsYouPaneId };
}

// ─── Row synthesis ──────────────────────────────────────────────────────────

function groupKeyFor(isSsh: boolean, targetId: string | undefined, projectPath: string): string {
  return isSsh ? `ssh:${targetId ?? ""}:${projectPath}` : `local:${projectPath}`;
}

/** conversationId set for every conversation with a tile in some workspace. */
function placedConversationIds(workspaces: readonly Workspace[]): Set<string> {
  const placed = new Set<string>();
  for (const w of workspaces) {
    for (const p of w.panes) {
      if (p.kind === "conversation" && p.conversationId) placed.add(p.conversationId);
    }
  }
  return placed;
}

interface RowMeta {
  row: FleetRow;
  groupKey: string;
  sshName?: string;
  /** Text corpus for search: title + workspace name + member messages. */
  searchText: string;
  /** First message snippet source (for a message-body match). */
  messageMatchSource: (q: string) => string | null;
  pinned: boolean;
}

function sortByPinThenRecent(a: RowMeta, b: RowMeta): number {
  if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
  return b.row.updatedAt - a.row.updatedAt;
}

/** The one projection entry point. Pure. */
export function buildFleetProjection(input: BuildFleetInput): FleetProjection {
  const {
    workspaces,
    conversations,
    conversationAttention,
    workspaceStatuses,
    attemptSessionIds,
    prefs,
    filter,
    query,
    includeVirtualConversations = true,
  } = input;

  const convById = new Map<string, AgentConversation>();
  for (const c of conversations) convById.set(c.id, c);
  const placed = placedConversationIds(workspaces);

  const metas: RowMeta[] = [];

  // Workspace rows — one per workspace.
  for (const w of workspaces) {
    const attention = workspaceStatuses.get(w.id) ?? "idle";
    const { chips, needsYouPaneId } = buildChips(w, conversationAttention);
    const singleTile = w.panes.length <= 1;
    const isSsh = isSshWorkspace(w);
    // Member conversation content for search.
    const memberConvs: AgentConversation[] = [];
    for (const p of w.panes) {
      if (p.kind === "conversation" && p.conversationId) {
        const c = convById.get(p.conversationId);
        if (c) memberConvs.push(c);
      }
    }
    const searchText = [w.name, ...memberConvs.map((c) => c.title ?? "")].join(" ").toLowerCase();
    const worktreePending = memberConvs.some((c) => c.worktree?.state === "active");
    const row: WorkspaceFleetRow = {
      kind: "workspace",
      id: w.id,
      workspaceId: w.id,
      title: w.name,
      projectPath: w.projectPath,
      attention,
      updatedAt: w.updatedAt,
      archived: w.status === "archived",
      singleTile,
      // Chips are always computed; the renderer shows the single agent label
      // for single-tile rows (like today's conversation rows) and the full
      // aggregated chip line for multi-tile rows.
      chips,
      isSsh,
      needsYouPaneId,
      worktreePending,
    };
    metas.push({
      row,
      groupKey: groupKeyFor(isSsh, w.serverId, w.projectPath),
      searchText,
      messageMatchSource: (q) => {
        for (const c of memberConvs) {
          const msg = c.messages?.find((m) => m.content?.toLowerCase().includes(q));
          if (msg) return buildSnippet(msg.content, q);
        }
        return null;
      },
      pinned: !!prefs[w.id]?.pinned,
    });
  }

  // Virtual rows — one per UNPLACED, non-flight conversation.
  for (const c of includeVirtualConversations ? conversations : []) {
    if (attemptSessionIds.has(c.id)) continue;
    if (placed.has(c.id)) continue;
    const attention = conversationAttention.get(c.id) ?? "idle";
    const isSsh = !!c.sshTarget;
    const row: VirtualFleetRow = {
      kind: "virtual",
      id: c.id,
      conversationId: c.id,
      title: c.title,
      projectPath: c.projectPath,
      attention,
      updatedAt: c.updatedAt,
      archived: c.archived ?? false,
      singleTile: true,
      chips: [
        {
          label: agentLabelFor(c.agent),
          count: 1,
          colorClass: getAgentColor(c.agent).text,
          needsYou: attention === "needs_you",
        },
      ],
      isSsh,
      worktreePending: c.worktree?.state === "active",
    };
    metas.push({
      row,
      groupKey: groupKeyFor(isSsh, c.sshTarget?.id, c.projectPath),
      sshName: c.sshTarget?.name,
      searchText: (c.title ?? "").toLowerCase(),
      messageMatchSource: (q) => {
        const msg = c.messages?.find((m) => m.content?.toLowerCase().includes(q));
        return msg ? buildSnippet(msg.content, q) : null;
      },
      pinned: !!prefs[c.id]?.pinned,
    });
  }

  // Counts across the union (all = non-archived).
  const counts = { all: 0, active: 0, done: 0, archived: 0 };
  for (const m of metas) {
    if (m.row.archived) {
      counts.archived += 1;
      continue;
    }
    counts.all += 1;
    if (isDoneAttention(m.row.attention)) counts.done += 1;
    else counts.active += 1;
  }

  const trimmed = query.trim().toLowerCase();
  const searching = trimmed.length > 0;

  // ── Search mode: flat pinned-first list across non-archived rows ──
  if (searching) {
    const snippets = new Map<string, string>();
    const hits: RowMeta[] = [];
    for (const m of metas) {
      if (m.row.archived) continue;
      if (m.searchText.includes(trimmed)) {
        hits.push(m);
        snippets.set(m.row.id, m.row.title || "(untitled)");
        continue;
      }
      const snippet = m.messageMatchSource(trimmed);
      if (snippet) {
        hits.push(m);
        snippets.set(m.row.id, snippet);
      }
    }
    hits.sort(sortByPinThenRecent);
    return {
      needsYou: [],
      groups: [],
      searchRows: hits.map((m) => m.row),
      snippets,
      counts,
    };
  }

  // ── Filter ──
  const passesFilter = (m: RowMeta): boolean => {
    if (filter === "archived") return m.row.archived;
    if (m.row.archived) return false;
    if (filter === "all") return true;
    if (filter === "active") return !isDoneAttention(m.row.attention);
    return isDoneAttention(m.row.attention); // "done"
  };
  const visible = metas.filter(passesFilter);

  // ── Needs-you pseudo-group (never under the archived filter) ──
  const needsYouMetas: RowMeta[] = [];
  const restMetas: RowMeta[] = [];
  for (const m of visible) {
    if (filter !== "archived" && !m.row.archived && m.row.attention === "needs_you") {
      needsYouMetas.push(m);
    } else {
      restMetas.push(m);
    }
  }
  needsYouMetas.sort(sortByPinThenRecent);

  // ── Project groups over the rest ──
  const groupMap = new Map<
    string,
    { meta: RowMeta[]; projectPath: string; isSsh: boolean; sshName?: string }
  >();
  for (const m of restMetas) {
    let g = groupMap.get(m.groupKey);
    if (!g) {
      g = { meta: [], projectPath: m.row.projectPath, isSsh: m.row.isSsh, sshName: m.sshName };
      groupMap.set(m.groupKey, g);
    }
    g.meta.push(m);
    if (!g.sshName && m.sshName) g.sshName = m.sshName;
  }

  const groups: FleetGroup[] = [];
  for (const [key, g] of groupMap) {
    g.meta.sort(sortByPinThenRecent);
    groups.push({
      key,
      projectPath: g.projectPath,
      isSsh: g.isSsh,
      sshName: g.sshName,
      rows: g.meta.map((m) => m.row),
    });
  }
  // Deterministic group order: most-recent activity first.
  groups.sort((a, b) => {
    const at = Math.max(0, ...a.rows.map((r) => r.updatedAt));
    const bt = Math.max(0, ...b.rows.map((r) => r.updatedAt));
    return bt - at;
  });

  return {
    needsYou: needsYouMetas.map((m) => m.row),
    groups,
    searchRows: [],
    snippets: new Map(),
    counts,
  };
}
