/**
 * F7 — matching-turn search (pure module).
 *
 * Produces grouped matching-thread results over currently-loaded conversations
 * with a small capped set of matching-turn excerpts, an explicit match count,
 * and a `More matches` flag. Search is LITERAL by default: the query is never
 * interpreted as a regex, and highlights are emitted as plain `matchRanges`
 * offsets for safe text-node highlighting (no HTML interpolation).
 *
 * Navigation targets are stable message/revision identities — never array
 * positions — so a hit survives a shifting queue or a reordered transcript.
 * A title/project hit carries no `messageId`; the caller falls back to the
 * conversation's remembered reader anchor.
 */
import type { AgentConversation, AgentMessage } from "@/types/agent-conversation";

export type AgentSearchField = "title" | "project" | "message";

export interface AgentSearchHit {
  conversationId: string;
  /** Saved-revision id for a hit inside rewind history (absent for active). */
  transcriptRevisionId?: string;
  projectKey: string;
  /** Absent only for a title/project match. */
  messageId?: string;
  field: AgentSearchField;
  excerpt: string;
  matchRanges: Array<{ start: number; end: number }>;
}

export interface AgentSearchConversationResult {
  conversationId: string;
  title: string;
  projectKey: string;
  archived: boolean;
  status: AgentConversation["status"];
  /** Total literal match occurrences across title/project/messages. */
  totalMatches: number;
  /** Title + project hits plus the capped matching-turn excerpts. */
  hits: AgentSearchHit[];
  /** True when more matching turns exist than the excerpt cap shows. */
  hasMore: boolean;
}

export interface AgentSearchOptions {
  /** Include archived conversations (default false). */
  includeArchived?: boolean;
  /** Cap on matching-turn excerpts per conversation (default 3). */
  excerptCap?: number;
  /** Approximate length of each excerpt window (default 120). */
  excerptLength?: number;
}

export const DEFAULT_EXCERPT_CAP = 3;
export const DEFAULT_EXCERPT_LENGTH = 120;

export function normalizeQuery(query: string): string {
  return query.trim();
}

/** All literal (case-insensitive, non-regex) occurrences of `query` in `text`. */
export function literalMatchRanges(
  text: string,
  query: string,
): Array<{ start: number; end: number }> {
  if (!query) return [];
  const lower = text.toLowerCase();
  const needle = query.toLowerCase();
  if (needle.length === 0) return [];
  const ranges: Array<{ start: number; end: number }> = [];
  let from = 0;
  while (from <= lower.length - needle.length) {
    const idx = lower.indexOf(needle, from);
    if (idx === -1) break;
    ranges.push({ start: idx, end: idx + needle.length });
    from = idx + Math.max(1, needle.length);
  }
  return ranges;
}

export function countLiteralMatches(text: string, query: string): number {
  return literalMatchRanges(text, query).length;
}

/**
 * Build a single excerpt window around the first match. Leading/trailing
 * ellipses mark truncation, and `matchRanges` are re-based onto the emitted
 * excerpt so consumers can highlight without re-searching.
 */
export function buildExcerpt(
  text: string,
  query: string,
  maxLength: number = DEFAULT_EXCERPT_LENGTH,
): { excerpt: string; matchRanges: Array<{ start: number; end: number }> } {
  const ranges = literalMatchRanges(text, query);
  if (ranges.length === 0) {
    const excerpt = text.length > maxLength ? `${text.slice(0, maxLength)}…` : text;
    return { excerpt, matchRanges: [] };
  }
  const first = ranges[0];
  const half = Math.floor(maxLength / 2);
  let start = Math.max(0, first.start - half);
  const end = Math.min(text.length, start + maxLength);
  if (end - start < maxLength) start = Math.max(0, end - maxLength);
  const prefix = start > 0 ? "…" : "";
  const suffix = end < text.length ? "…" : "";
  const excerpt = `${prefix}${text.slice(start, end)}${suffix}`;
  const shift = prefix.length;
  const matchRanges = ranges
    .filter((r) => r.start >= start && r.end <= end)
    .map((r) => ({ start: r.start - start + shift, end: r.end - start + shift }));
  return { excerpt, matchRanges };
}

/** Normalize separators + trailing slashes without touching case. */
function normalizePath(path: string): string {
  return path.replace(/\\/g, "/").replace(/\/+$/, "");
}

function baseProjectPath(conversation: AgentConversation): string {
  return conversation.worktree?.basePath ?? conversation.projectPath;
}

function computeProjectKey(conversation: AgentConversation): string {
  if (conversation.sshTarget) {
    return `ssh:${conversation.sshTarget.id}:${normalizePath(conversation.sshTarget.remotePath)}`;
  }
  return `local:${normalizePath(baseProjectPath(conversation))}`;
}

function projectSearchText(conversation: AgentConversation): string {
  if (conversation.sshTarget) return conversation.sshTarget.remotePath;
  return baseProjectPath(conversation);
}

interface SearchableMessage {
  message: AgentMessage;
  revisionId?: string;
}

function collectMessages(conversation: AgentConversation): SearchableMessage[] {
  const out: SearchableMessage[] = conversation.messages.map((message) => ({ message }));
  for (const revision of conversation.transcriptRevisions ?? []) {
    for (const message of revision.messages) {
      out.push({ message, revisionId: revision.revisionId });
    }
  }
  return out;
}

export function searchAgentConversations(
  conversations: readonly AgentConversation[],
  rawQuery: string,
  options: AgentSearchOptions = {},
): AgentSearchConversationResult[] {
  const query = normalizeQuery(rawQuery);
  if (!query) return [];

  const includeArchived = options.includeArchived ?? false;
  const cap = options.excerptCap ?? DEFAULT_EXCERPT_CAP;
  const maxLength = options.excerptLength ?? DEFAULT_EXCERPT_LENGTH;

  const results: AgentSearchConversationResult[] = [];

  for (const conversation of conversations) {
    if (conversation.archived && !includeArchived) continue;

    const projectKey = computeProjectKey(conversation);
    const hits: AgentSearchHit[] = [];
    let totalMatches = 0;

    const title = conversation.title ?? "";
    const titleRanges = literalMatchRanges(title, query);
    if (titleRanges.length > 0) {
      totalMatches += titleRanges.length;
      hits.push({
        conversationId: conversation.id,
        projectKey,
        field: "title",
        excerpt: title,
        matchRanges: titleRanges,
      });
    }

    const projectText = projectSearchText(conversation);
    const projectRanges = literalMatchRanges(projectText, query);
    if (projectRanges.length > 0) {
      totalMatches += projectRanges.length;
      hits.push({
        conversationId: conversation.id,
        projectKey,
        field: "project",
        excerpt: projectText,
        matchRanges: projectRanges,
      });
    }

    const messageHits: AgentSearchHit[] = [];
    let matchingTurnCount = 0;
    for (const { message, revisionId } of collectMessages(conversation)) {
      const count = countLiteralMatches(message.content ?? "", query);
      if (count === 0) continue;
      totalMatches += count;
      matchingTurnCount += 1;
      if (messageHits.length < cap) {
        const { excerpt, matchRanges } = buildExcerpt(message.content ?? "", query, maxLength);
        messageHits.push({
          conversationId: conversation.id,
          transcriptRevisionId: revisionId,
          projectKey,
          messageId: message.id,
          field: "message",
          excerpt,
          matchRanges,
        });
      }
    }
    hits.push(...messageHits);

    if (totalMatches > 0) {
      results.push({
        conversationId: conversation.id,
        title,
        projectKey,
        archived: !!conversation.archived,
        status: conversation.status,
        totalMatches,
        hits,
        hasMore: matchingTurnCount > messageHits.length,
      });
    }
  }

  return results;
}
