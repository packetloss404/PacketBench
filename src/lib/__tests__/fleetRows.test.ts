/**
 * Tile program (P4-S2) — fleetRows: the pure unified-row projection.
 *
 * Covers the ruled row model: workspaces AND unplaced legacy conversations as
 * ONE list; a placed conversation is never double-listed; single-tile vs
 * multi-tile row shape; needs-you derived from `sessionStatus`; archived rows
 * first-class under the Archived filter; search/filter/pin parity; stable
 * virtual-row identity.
 */
import { describe, expect, it } from "vitest";
import { buildFleetProjection, type BuildFleetInput } from "@/lib/fleetRows";
import type { Attention } from "@/lib/sessionIndex";
import type { AgentConversation } from "@/types/agent-conversation";
import type { Workspace, WorkspacePane } from "@/types/workspace";

function conv(overrides: Partial<AgentConversation> = {}): AgentConversation {
  return {
    id: "conv-1",
    title: "My Task",
    agent: "api-claude",
    projectPath: "/proj",
    status: "idle",
    messages: [],
    sessionId: "conv-1",
    rawOutput: "",
    createdAt: 1,
    updatedAt: 1,
    mode: "api",
    ...overrides,
  };
}

function conversationPane(conversationId: string, id = `pane-${conversationId}`): WorkspacePane {
  return { id, agentId: "terminal", sessionId: null, kind: "conversation", conversationId };
}
function terminalPane(id: string, sessionId: string | null = null): WorkspacePane {
  return { id, agentId: "codex", sessionId };
}
function workspace(overrides: Partial<Workspace> = {}): Workspace {
  return {
    id: "ws-1",
    name: "Workspace One",
    agents: [],
    panes: [],
    projectPath: "/proj",
    createdAt: 1,
    updatedAt: 10,
    status: "active",
    ...overrides,
  };
}

function baseInput(over: Partial<BuildFleetInput> = {}): BuildFleetInput {
  return {
    workspaces: [],
    conversations: [],
    conversationAttention: new Map<string, Attention>(),
    workspaceStatuses: new Map<string, Attention>(),
    attemptSessionIds: new Set<string>(),
    prefs: {},
    filter: "all",
    query: "",
    ...over,
  };
}

function allRows(p: ReturnType<typeof buildFleetProjection>) {
  return [...p.needsYou, ...p.groups.flatMap((g) => g.rows)];
}

describe("buildFleetProjection — unified rows", () => {
  it("lists a workspace AND an unplaced conversation as one list", () => {
    const p = buildFleetProjection(
      baseInput({
        workspaces: [workspace({ id: "ws-1", panes: [terminalPane("t1", "sess")] })],
        conversations: [conv({ id: "conv-unplaced" })],
        workspaceStatuses: new Map([["ws-1", "idle"]]),
        conversationAttention: new Map([["conv-unplaced", "idle"]]),
      }),
    );
    const ids = allRows(p)
      .map((r) => r.id)
      .sort();
    expect(ids).toEqual(["conv-unplaced", "ws-1"]);
    const virt = allRows(p).find((r) => r.id === "conv-unplaced");
    expect(virt?.kind).toBe("virtual");
  });

  it("does NOT double-list a placed conversation (workspace row only)", () => {
    const p = buildFleetProjection(
      baseInput({
        workspaces: [
          workspace({ id: "ws-wrap", panes: [conversationPane("conv-1")], origin: "conversation" }),
        ],
        conversations: [conv({ id: "conv-1" })],
        workspaceStatuses: new Map([["ws-wrap", "idle"]]),
        conversationAttention: new Map([["conv-1", "idle"]]),
      }),
    );
    const rows = allRows(p);
    expect(rows).toHaveLength(1);
    expect(rows[0].kind).toBe("workspace");
  });

  it("excludes flight-attempt conversations from virtual rows", () => {
    const p = buildFleetProjection(
      baseInput({
        conversations: [conv({ id: "attempt-1" }), conv({ id: "normal-1" })],
        attemptSessionIds: new Set(["attempt-1"]),
        conversationAttention: new Map([
          ["attempt-1", "idle"],
          ["normal-1", "idle"],
        ]),
      }),
    );
    const ids = allRows(p).map((r) => r.id);
    expect(ids).toEqual(["normal-1"]);
  });

  it("can exclude unplaced conversations while retaining placed workspace rows", () => {
    const p = buildFleetProjection(
      baseInput({
        workspaces: [
          workspace({
            id: "ws-placed",
            panes: [conversationPane("conv-placed")],
          }),
        ],
        conversations: [
          conv({ id: "conv-placed", title: "Placed" }),
          conv({ id: "conv-unplaced", title: "Agents only" }),
        ],
        workspaceStatuses: new Map([["ws-placed", "idle"]]),
        conversationAttention: new Map([
          ["conv-placed", "idle"],
          ["conv-unplaced", "idle"],
        ]),
        includeVirtualConversations: false,
      }),
    );

    expect(allRows(p).map((row) => row.id)).toEqual(["ws-placed"]);
    expect(allRows(p)[0]?.kind).toBe("workspace");
  });
});

describe("buildFleetProjection — row shape", () => {
  it("single-tile workspace is singleTile with one chip", () => {
    const p = buildFleetProjection(
      baseInput({
        workspaces: [workspace({ id: "ws-1", panes: [conversationPane("conv-1")] })],
        conversations: [conv({ id: "conv-1", agent: "api-claude" })],
        workspaceStatuses: new Map([["ws-1", "idle"]]),
      }),
    );
    const row = allRows(p)[0];
    expect(row.singleTile).toBe(true);
    expect(row.chips).toHaveLength(1);
    expect(row.chips[0].label).toBe("Saved conversation");
  });

  it("multi-tile workspace aggregates chips with counts", () => {
    const p = buildFleetProjection(
      baseInput({
        workspaces: [
          workspace({
            id: "ws-1",
            panes: [
              conversationPane("c-claude", "p1"),
              conversationPane("c-codex-a", "p2"),
              conversationPane("c-codex-b", "p3"),
              terminalPane("p4", "sess"),
            ],
          }),
        ],
        conversations: [
          conv({ id: "c-claude", agent: "claude-code" }),
          conv({ id: "c-codex-a", agent: "codex" }),
          conv({ id: "c-codex-b", agent: "codex" }),
        ],
        workspaceStatuses: new Map([["ws-1", "working"]]),
      }),
    );
    const row = allRows(p)[0];
    expect(row.singleTile).toBe(false);
    const saved = row.chips.find((c) => c.label === "Saved conversation");
    expect(saved?.count).toBe(3);
    expect(row.chips.find((c) => c.label === "Codex")?.count).toBe(1);
  });

  it("separates viewers, saved conversations and real CLI panes in Fleet summaries", () => {
    const p = buildFleetProjection(
      baseInput({
        workspaces: [
          workspace({
            id: "ws-mixed",
            panes: [
              { ...terminalPane("shell", "shell-session"), agentId: "terminal" },
              { ...terminalPane("codex-a", "a"), agentId: "codex" },
              { ...terminalPane("codex-b", "b"), agentId: "codex" },
              { ...terminalPane("readme", ""), kind: "file", filePath: "/repo/README.md" },
              { ...terminalPane("config", ""), kind: "file", filePath: "/repo/config.json" },
              conversationPane("missing-history"),
            ],
          }),
        ],
        workspaceStatuses: new Map([["ws-mixed", "idle"]]),
      }),
    );
    expect(allRows(p)[0].chips.map(({ label, count }) => ({ label, count }))).toEqual([
      { label: "Terminal", count: 1 },
      { label: "Codex", count: 2 },
      { label: "File viewer", count: 2 },
      { label: "Saved conversation", count: 1 },
    ]);
  });
});

describe("buildFleetProjection — needs-you (from sessionStatus)", () => {
  it("routes a needs_you workspace into the needs-you group with the offending pane", () => {
    const p = buildFleetProjection(
      baseInput({
        workspaces: [
          workspace({
            id: "ws-1",
            panes: [conversationPane("c-idle", "p1"), conversationPane("c-needs", "p2")],
          }),
        ],
        conversations: [conv({ id: "c-idle" }), conv({ id: "c-needs" })],
        workspaceStatuses: new Map([["ws-1", "needs_you"]]),
        conversationAttention: new Map([
          ["c-idle", "idle"],
          ["c-needs", "needs_you"],
        ]),
      }),
    );
    expect(p.needsYou).toHaveLength(1);
    const row = p.needsYou[0];
    expect(row.kind).toBe("workspace");
    expect(row.kind === "workspace" && row.needsYouPaneId).toBe("p2");
  });
});

describe("buildFleetProjection — archived + filters", () => {
  it("archived rows are first-class only under the archived filter", () => {
    const input = baseInput({
      conversations: [conv({ id: "live", archived: false }), conv({ id: "gone", archived: true })],
      conversationAttention: new Map([
        ["live", "idle"],
        ["gone", "done"],
      ]),
    });
    const all = buildFleetProjection({ ...input, filter: "all" });
    expect(allRows(all).map((r) => r.id)).toEqual(["live"]);

    const archived = buildFleetProjection({ ...input, filter: "archived" });
    expect(allRows(archived).map((r) => r.id)).toEqual(["gone"]);
    expect(archived.counts.archived).toBe(1);
  });

  it("active vs done filter partitions by attention", () => {
    const input = baseInput({
      conversations: [conv({ id: "a" }), conv({ id: "d" })],
      conversationAttention: new Map<string, Attention>([
        ["a", "working"],
        ["d", "done"],
      ]),
    });
    expect(allRows(buildFleetProjection({ ...input, filter: "active" })).map((r) => r.id)).toEqual([
      "a",
    ]);
    expect(allRows(buildFleetProjection({ ...input, filter: "done" })).map((r) => r.id)).toEqual([
      "d",
    ]);
  });
});

describe("buildFleetProjection — search / pin", () => {
  it("search matches title and message body with a snippet, skips archived", () => {
    const p = buildFleetProjection(
      baseInput({
        conversations: [
          conv({ id: "byTitle", title: "Refactor the parser" }),
          conv({
            id: "byMsg",
            title: "Untitled",
            messages: [
              { id: "m", role: "user", content: "please fix the PARSER bug", timestamp: 1 },
            ],
          }),
          conv({ id: "archived-hit", title: "parser cleanup", archived: true }),
        ],
        query: "parser",
      }),
    );
    const ids = p.searchRows.map((r) => r.id).sort();
    expect(ids).toEqual(["byMsg", "byTitle"]);
    expect(p.snippets.get("byMsg")).toContain("PARSER");
  });

  it("pinned rows float to the top of their group", () => {
    const p = buildFleetProjection(
      baseInput({
        conversations: [
          conv({ id: "old", updatedAt: 100 }),
          conv({ id: "pinnedOld", updatedAt: 1 }),
        ],
        conversationAttention: new Map<string, Attention>([
          ["old", "idle"],
          ["pinnedOld", "idle"],
        ]),
        prefs: { pinnedOld: { pinned: true } },
      }),
    );
    const rows = p.groups.flatMap((g) => g.rows);
    expect(rows[0].id).toBe("pinnedOld");
  });
});

describe("buildFleetProjection — counts", () => {
  it("all excludes archived; active + done partition the non-archived set", () => {
    const p = buildFleetProjection(
      baseInput({
        conversations: [conv({ id: "a1" }), conv({ id: "d1" }), conv({ id: "z1", archived: true })],
        conversationAttention: new Map<string, Attention>([
          ["a1", "working"],
          ["d1", "failed"],
          ["z1", "done"],
        ]),
      }),
    );
    expect(p.counts).toEqual({ all: 2, active: 1, done: 1, archived: 1 });
  });
});
