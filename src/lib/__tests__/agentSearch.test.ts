import { describe, expect, it } from "vitest";
import {
  buildExcerpt,
  countLiteralMatches,
  literalMatchRanges,
  normalizeQuery,
  searchAgentConversations,
} from "@/lib/agentSearch";
import type { AgentConversation, AgentMessage } from "@/types/agent-conversation";

function message(id: string, content: string): AgentMessage {
  return { id, role: "user", content, timestamp: 1 };
}

function conversation(overrides: Partial<AgentConversation> = {}): AgentConversation {
  return {
    id: "conv-1",
    title: "Title",
    agent: "api-openai",
    projectPath: "/repo",
    status: "idle",
    messages: [],
    sessionId: null,
    rawOutput: "",
    createdAt: 1,
    updatedAt: 1,
    mode: "api",
    provider: "openai",
    model: "gpt-4o",
    ...overrides,
  };
}

describe("literal matching", () => {
  it("treats the query literally — never as a regex", () => {
    expect(literalMatchRanges("file.open then file(open", "file.open")).toEqual([
      { start: 0, end: 9 },
    ]);
    expect(countLiteralMatches("a.c", "a.c")).toBe(1);
    // "a.c" is not a wildcard: it must NOT match "abc".
    expect(countLiteralMatches("abc", "a.c")).toBe(0);
    // Regex metacharacters in the query stay literal.
    expect(countLiteralMatches("sum(1,2)", "(")).toBe(1);
  });

  it("finds every overlapping-free occurrence, case-insensitively", () => {
    expect(literalMatchRanges("CAT cat Cat", "cat")).toEqual([
      { start: 0, end: 3 },
      { start: 4, end: 7 },
      { start: 8, end: 11 },
    ]);
    expect(countLiteralMatches("cat(cat)cat", "cat")).toBe(3);
  });
});

describe("buildExcerpt", () => {
  it("centres the window on the first match and re-bases ranges onto the excerpt", () => {
    const text = `${"a".repeat(100)}NEEDLE${"b".repeat(100)}`;
    const { excerpt, matchRanges } = buildExcerpt(text, "needle", 20);

    expect(excerpt.startsWith("…")).toBe(true);
    expect(excerpt.endsWith("…")).toBe(true);
    expect(excerpt.toLowerCase()).toContain("needle");
    for (const range of matchRanges) {
      expect(excerpt.slice(range.start, range.end).toLowerCase()).toBe("needle");
    }
  });

  it("returns the raw prefix with no ranges when there is no match", () => {
    const { excerpt, matchRanges } = buildExcerpt("no match here", "needle", 20);
    expect(matchRanges).toEqual([]);
    expect(excerpt).toBe("no match here");
  });
});

describe("searchAgentConversations", () => {
  it("groups hits per conversation with an explicit match count", () => {
    const conversations = [
      conversation({
        id: "c1",
        title: "Refactor auth",
        projectPath: "/repo/a",
        messages: [message("m1", "needle one needle"), message("m2", "two needle")],
      }),
      conversation({
        id: "c2",
        title: "Other",
        projectPath: "/repo/b",
        messages: [message("m3", "needle here")],
      }),
    ];

    const results = searchAgentConversations(conversations, "needle");
    expect(results).toHaveLength(2);

    const c1 = results.find((r) => r.conversationId === "c1")!;
    expect(c1.totalMatches).toBe(3);
    const c2 = results.find((r) => r.conversationId === "c2")!;
    expect(c2.totalMatches).toBe(1);
  });

  it("caps matching-turn excerpts and flags More matches", () => {
    const messages = Array.from({ length: 5 }, (_, i) => message(`m${i}`, `needle ${i}`));
    const results = searchAgentConversations([conversation({ id: "c1", messages })], "needle", {
      excerptCap: 3,
    });
    const result = results[0];
    expect(result.hits.filter((h) => h.field === "message")).toHaveLength(3);
    expect(result.hasMore).toBe(true);
    expect(result.totalMatches).toBe(5);
  });

  it("title/project hits carry no messageId; message hits do", () => {
    const results = searchAgentConversations(
      [
        conversation({
          id: "c1",
          title: "Deploy needle service",
          projectPath: "/repo",
          messages: [message("m1", "hello needle")],
        }),
      ],
      "needle",
    );
    const result = results[0];
    expect(result.hits.some((h) => h.field === "title" && h.messageId === undefined)).toBe(true);
    expect(result.hits.some((h) => h.field === "message" && h.messageId === "m1")).toBe(true);
  });

  it("excludes archived conversations unless includeArchived is set", () => {
    const conversations = [
      conversation({ id: "c1", title: "needle a" }),
      conversation({ id: "c2", title: "needle b", archived: true }),
    ];
    expect(searchAgentConversations(conversations, "needle").map((r) => r.conversationId)).toEqual([
      "c1",
    ]);
    expect(
      searchAgentConversations(conversations, "needle", { includeArchived: true })
        .map((r) => r.conversationId)
        .sort(),
    ).toEqual(["c1", "c2"]);
  });

  it("searches saved rewind revisions and tags the revision id", () => {
    const conversations = [
      conversation({
        id: "c1",
        transcriptRevisions: [
          {
            revisionId: "rev-1",
            conversationId: "c1",
            operation: "transcript_rewind",
            throughMessageId: "m1",
            messageCount: 1,
            messages: [message("old-1", "archived needle")],
            createdAt: 1,
          },
        ],
      }),
    ];
    const results = searchAgentConversations(conversations, "needle");
    expect(results).toHaveLength(1);
    const hit = results[0].hits.find((h) => h.field === "message")!;
    expect(hit.transcriptRevisionId).toBe("rev-1");
    expect(hit.messageId).toBe("old-1");
  });

  it("normalizes the query and returns empty for blank input", () => {
    expect(normalizeQuery("  needle  ")).toBe("needle");
    expect(searchAgentConversations([conversation()], "   ")).toEqual([]);
  });
});
