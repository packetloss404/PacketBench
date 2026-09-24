import type { AgentCli } from "@/stores/agentTaskStore";
import type { AgentConversation } from "@/types/agent-conversation";
import type { AgentMode } from "@/components/agents/AgentModeChip";
import { getProviderForAgent, providerSupportsApprovals, type ApiModel } from "@/lib/api-models";
import { modesForApprovals } from "@/components/agents/agentModeChipUtils";
import { getModelContextWindow } from "@/lib/modelContext";
import { type LiveModelAnswer } from "@/lib/liveModels";
import { isRemoteConversation } from "@/lib/remoteConversation";

/**
 * THE capability descriptor for an agent session.
 *
 * ## Why this exists
 *
 * Chrome must render from CAPABILITIES, never from provider identity. Before
 * this module, a dozen components each answered "can this session do X?" by
 * asking "is this session `api-claude-oauth`?" — so every new provider needed
 * a sweep through the whole Agents pane, and every miss shipped a control that
 * did nothing (or hid one that would have worked).
 *
 * Identity may still feed LABELS (the provider name on a model chip, the
 * auth-probe key). It may never decide whether a control exists.
 *
 * ## Contract for changing this file
 *
 * The initial implementation returns EXACTLY today's behavior. Where today's
 * behavior *is* an identity check, that identity check is encoded here — once,
 * marked `IDENTITY (widen later)` — rather than being deleted. Moving the
 * branching to one place is the win; changing what it decides is a separate,
 * deliberate step. When a provider gains a capability, widen the field here and
 * every consumer follows for free.
 */
export interface SessionCapabilities {
  // ── permission & safety ────────────────────────────────────────────────
  /** The adapter can pause a tool call and wait for a user decision. */
  canApprovePerTool: boolean;
  /** Postures this session may present, in cycle order. Empty → no mode chip. */
  permissionModes: AgentMode[];
  /** Which wording the postures are labelled with. */
  permissionVocabulary: "approval" | "sandbox";
  /** The "Approve writes" fine flag is meaningful for this session. */
  canGateWrites: boolean;
  /** Read-only plan mode can be entered. */
  canPlanMode: boolean;

  // ── model & inference ──────────────────────────────────────────────────
  /**
   * Rows this session can switch between.
   *
   * Empty does NOT mean "no picker" — read {@link modelsAreAuthoritative} to
   * tell the two empties apart before deciding what to render.
   */
  models: ApiModel[];
  /**
   * Did {@link models} come from the session's OWN backend (a live provider
   * enumeration) rather than the shipped catalog?
   *
   * This is the `[]` disambiguator, and it exists because the two empty lists
   * mean opposite things. An authoritative `[]` is a backend that was asked and
   * named nothing — the catalog must NOT stand in, because its ids are ones the
   * backend may refuse. A non-authoritative `[]` is simply a row with no bundled
   * models and no answer yet, where the catalog is the right fallback and the
   * picker should still offer refresh / free-text entry. Collapsing them is the
   * bug `lib/liveModels.ts` documents at length.
   */
  modelsAreAuthoritative: boolean;
  /** Reasoning-effort levels the adapter accepts; null → no effort control. */
  effortLevels: string[] | null;
  /** Turns can carry extended-thinking text. */
  emitsThinking: boolean;
  /** The adapter emits structured plan/todo blocks (not a prose heuristic). */
  structuredPlans: boolean;

  // ── tools & edits ──────────────────────────────────────────────────────
  /** Edits arrive as structured pending-edit payloads that can be reviewed. */
  structuredEdits: boolean;
  /** An in-flight turn can be cancelled. */
  canCancelTurn: boolean;
  /** A message typed mid-stream is queued rather than dropped. */
  canQueueWhileStreaming: boolean;

  // ── composer inputs ────────────────────────────────────────────────────
  /** `@` opens a file picker rooted at this session's project. */
  fileMentions: boolean;
  /** `/` opens the slash-command palette. */
  slashCommands: boolean;
  /** Images can be pasted/dropped into the composer. */
  imageAttachments: boolean;

  // ── context & accounting ───────────────────────────────────────────────
  /** Total context window in tokens; null → no ContextUsageRing. */
  contextWindow: number | null;
  /** Turns report token counts (drives the statusline's ctx/in/out). */
  reportsUsage: boolean;

  // ── environment ────────────────────────────────────────────────────────
  /** Tools execute on a remote host — the local filesystem is NOT this one. */
  remote: boolean;
  /** MCP servers were sourced for this session (read-only disclosure). */
  mcp: boolean;
  /** The session can be renamed in place. */
  canRename: boolean;
  /** A prior user turn can be edited/retried, forking the conversation. */
  canFork: boolean;
  /**
   * This session authenticates through a provider credential PacketBench holds,
   * so a live auth badge is meaningful. PTY/CLI sessions carry their own login
   * and surface it elsewhere.
   */
  usesProviderCredential: boolean;
}

/**
 * The subset of a conversation capabilities are derived from. Deliberately
 * structural so callers can pass partial/derived records (and tests can pass
 * literals) — same convention as `RemoteAwareConversation`.
 */
export type CapabilityConversation = Pick<
  AgentConversation,
  "agent" | "mode" | "model" | "projectPath" | "sshTarget" | "mcpSources"
>;

/**
 * The AUTHORITATIVE model rows for this session, or `undefined` to keep the
 * bundled catalog.
 *
 * Any transport that can name its own models feeds this resolution, under two
 * degradation rules —
 *
 * - a FAILED or never-issued enumeration returns `undefined`, so the shipped
 *   catalog stands and a capability fetch that never happened can never take
 *   an affordance away;
 * - a SETTLED enumeration returns its rows, empty included, because a backend
 *   that was asked and named nothing has genuinely told us it serves none, and
 *   offering bundled ids it may refuse is the silent no-op this module exists
 *   to prevent.
 *
 * Purity is why `live` is a PARAMETER. `capabilitiesFor` may not read a store
 * or issue IPC (see its docblock), so the caller subscribes to
 * `stores/liveModelStore` and passes the answer down.
 */
function authoritativeModels(live: LiveModelAnswer | undefined): ApiModel[] | undefined {
  if (live?.status === "ready" && live.models !== undefined) return live.models;
  return undefined;
}

/**
 * IDENTITY (widen later) — "this session is an API agent, not a PTY CLI".
 *
 * Today this is a prefix test on the `AgentCli` id, which is what
 * `AgentHeaderBadges` did inline. It deliberately does NOT go through the
 * `API_PROVIDERS` catalog: retired ids (`api-openai-codex`) have no catalog
 * row but ARE api sessions, and a stored conversation on one must keep its
 * auth badge. Replace with a real transport/capability flag on the agent
 * record when one exists.
 */
function isApiAgentId(agent: AgentCli): boolean {
  return typeof agent === "string" && agent.startsWith("api-");
}

/**
 * IDENTITY (widen later) — "this adapter emits structured plan blocks".
 *
 * Only the Claude rows stream `api-agent:plan-block:*` TodoWrite payloads
 * today, which is the branch PlanPanel carries inline. Any adapter that starts
 * emitting plan blocks should be added here (or, better, should advertise the
 * capability at session start so this list can go away).
 */
function emitsStructuredPlans(agent: AgentCli): boolean {
  return agent === "api-claude" || agent === "api-claude-oauth";
}

/**
 * Resolve what a session can do. Pure — no store reads, no IPC — so every
 * consumer can call it during render without a subscription.
 */
export function capabilitiesFor(
  conversation: CapabilityConversation,
  /**
   * This provider's live model enumeration, when the caller has one.
   *
   * Passed in rather than read, so this function stays pure. Omitting it keeps
   * the pre-seam answer exactly: the provider falls back to the catalog.
   */
  live?: LiveModelAnswer,
): SessionCapabilities {
  const agent = conversation.agent;
  const isApi = conversation.mode === "api";
  const canApprovePerTool = providerSupportsApprovals(agent);
  const mcpSources = conversation.mcpSources;
  /**
   * Rows the session's own backend named, or `undefined` for "nobody has told
   * us". Computed once — the two fields below must never disagree about which
   * of the two empty lists this is.
   */
  const backendModels = authoritativeModels(live);

  return {
    // Source: api-models.providerSupportsApprovals (catalog `supportsApprovals`,
    // defaulting to true) — exactly what AgentModeChip asked for itself.
    canApprovePerTool,
    // Source: agentModeChipUtils.modesForApprovals. The mode chip only ever
    // mounted for `mode === "api"` conversations, so PTY gets an empty set.
    permissionModes: isApi ? modesForApprovals(canApprovePerTool) : [],
    permissionVocabulary: canApprovePerTool ? "approval" : "sandbox",
    // The "Approve writes" row lives in the mode chip's popover, which mounts
    // on the same `mode === "api"` condition.
    canGateWrites: isApi,
    canPlanMode: isApi,

    // Source: a live provider enumeration passed in by the caller, else
    // api-models.API_PROVIDERS. A catalog row is a
    // SEED, not an authority — the backend's own answer supersedes it.
    //
    // An empty `models` is NOT "no picker" any more. That equation is what made
    // a live list's failure mode invisible: it collapsed "this provider serves
    // nothing" into "this provider was never asked" and rendered both as a
    // dead label. `modelsAreAuthoritative` tells them apart; consumers gate the
    // picker on `providerEnumeratesLive` instead of on the length.
    models: backendModels ?? getProviderForAgent(agent)?.models ?? [],
    modelsAreAuthoritative: backendModels !== undefined,
    // No API-agent surface exposes a reasoning-effort control today (the
    // `--effort` flag is a PTY/CLI workspace concept). null = omit the control.
    effortLevels: null,
    // ThinkingBlock renders whenever a message carries `thinking` text, which
    // only API sessions ever produce. NOT gated on `conversation.thinkingEnabled`
    // — that flag is a launch-time request, not a report of what arrived.
    emitsThinking: isApi,
    structuredPlans: emitsStructuredPlans(agent),

    // Pending edits / ReviewBar / diff surfaces all mount on `mode === "api"`.
    structuredEdits: isApi,
    // The composer's Stop button renders for any active conversation today,
    // with no provider or mode test.
    canCancelTurn: true,
    // agentTaskStore.sendMessage queues into `queuedMessages` for every
    // conversation kind.
    canQueueWhileStreaming: true,

    // FileMentionPopover is gated on having a project path to scan.
    fileMentions: !!conversation.projectPath,
    // Builtin + project + template slash commands are offered to every chat
    // session.
    slashCommands: true,
    // Attachment staging (paste/drop) is variant-agnostic in the composer.
    imageAttachments: true,

    // Source: modelContext.getModelContextWindow, which always resolves a
    // directional number (unknown ids fall back to the field median), so this
    // is non-null today. Kept nullable so an adapter that genuinely cannot
    // report a window can omit the ring instead of inventing one.
    contextWindow: getModelContextWindow(conversation.model),
    // Api sessions report usage.
    reportsUsage: isApi,
    // Source: remoteConversation.isRemoteConversation.
    remote: isRemoteConversation(conversation),
    // Source: the `mcp_sources` event persisted on the conversation (same
    // condition SessionMetaLine used for its pill).
    mcp: !!mcpSources && (mcpSources.sources.length > 0 || mcpSources.readErrors.length > 0),
    // Every conversation record is renamable; the sidebar has simply never
    // offered the affordance. Busy-state gating stays the caller's job.
    canRename: true,
    // MessageList offers edit/restore on every user turn regardless of mode.
    canFork: true,
    usesProviderCredential: isApiAgentId(agent),
  };
}
