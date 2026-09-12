import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import {
  writePty,
  killPty,
  startApiAgentSession,
  sendApiAgentMessage,
  cancelApiAgentSession,
  closeApiAgentSession,
  deleteConversationFile,
  changeAgentModel,
  setPlanMode as tauriSetPlanMode,
  setPermissionMode as tauriSetPermissionMode,
  setApproveWrites as tauriSetApproveWrites,
  retryLastTurn as tauriRetryLastTurn,
  exportConversationMarkdown,
  getGitStatus,
  removeConversationWorktree,
  type ImageAttachment,
  type ResumeMessage,
} from "@/lib/tauri";
import { isWorktreeDirty } from "@/lib/worktreeLifecycle";
import { conversationWorktree } from "@/lib/conversationWorktreeDisclosure";
import { buildResumeSshConfig, type ResumeSshConfig } from "@/lib/resumeSshConfig";
import { logSwallowed } from "@/lib/logSwallowed";
// Type-only: `capabilitiesFor` itself is deliberately NOT imported here. The
// store must not decide affordances — components do, from the descriptor —
// and a runtime import would drag `lib/agentCapabilities`' own dependency
// graph (serverStore, the api-models catalog) into every store consumer.
import type {  } from "@/lib/agentCapabilities";
/** Phase 2: SSH conversations now reference a `ServerConfig` from
 *  `serverStore` plus a per-session remote path. This payload is what the
 *  Agents UI hands to `createApiConversation` — it carries every field we
 *  need to start the backend session AND seed `AgentConversation.sshTarget`
 *  without re-reading `serverStore`. The legacy `SshTarget` type / store
 *  was deleted in Phase 2; persisted records were migrated into
 *  `serverStore`'s servers list. */
export interface AgentSshConfigInput {
  /** ServerConfig id from `serverStore`. Persisted on the conversation so
   *  later hydration can re-resolve the server (or fall back gracefully
   *  if the server was deleted). */
  serverId: string;
  /** Display name surfaced in the conversation sidebar / header. */
  name: string;
  host: string;
  port: number;
  user: string;
  /** Per-session remote project path. May differ from
   *  `ServerConfig.remotePath` (the server-level default). */
  remotePath: string;
  keyPath?: string | null;
  /** ServerConfig auth method. Remote sidecar sessions need this so stale
   *  saved passwords do not force password-auth when the server now uses key
   *  or SSH-agent auth. */
  authMethod?: "agent" | "key" | "password" | null;
  /** Pinned SHA256 host-key fingerprint, copied from
   *  `ServerConfig.hostFingerprint`. Forwarded to the backend so strict
   *  host-key checking applies. */
  hostFingerprint?: string | null;
}
import { generateId } from "@/lib/storage";
import {
  attachmentProvenance,
  assistantDerivativeProvenance,
  userIntentProvenance,
} from "@/lib/provenance";
import { useMemoryStore } from "@/stores/memoryStore";
import { useAgentApprovalStore } from "@/stores/agentApprovalStore";
import { useAgentSettingsStore } from "@/stores/agentSettingsStore";
import { useAgentPlanStore } from "@/stores/agentPlanStore";
import { useAgentStreamingStore } from "@/stores/agentStreamingStore";
import { useEditBaselineStore } from "@/stores/editBaselineStore";
import { useReviewStore } from "@/stores/reviewStore";
import { useAgentDraftStore } from "@/stores/agentDraftStore";
import { useMcpStore } from "@/stores/mcpStore";
import { useMcpTrustStore } from "@/stores/mcpTrustStore";
import { assertCostGuardrailsAllowLaunch } from "@/stores/costGuardrailStore";
import { loadAgentsMd } from "@/lib/agentsMd";
import type { GitHubRepo } from "@/types/github";
import type {
  AgentConversation,
  AgentMessage,
  AgentToolCall,
  DiffComment,
  PermissionMode,
} from "@/types/agent-conversation";
import { installApiAgentListeners } from "@/stores/apiAgentListeners";
import {
  scheduleSave,
  saveConversationNow,
  requestConversationSave,
  cancelPendingSave,
  deriveLegacyWorktree,
} from "@/stores/agentConversationPersistence";
import type { McpTrustSnapshot } from "@/types/mcp";
import { APP_NAME } from "@/lib/brand";

// `requestConversationSave` was historically defined here; re-export it so
// external importers (apiAgentListeners, agentPlanStore, slashCommandHandlers,
// …) keep importing it from `@/stores/agentTaskStore` unchanged after the
// persistence helpers moved to their sibling module.
export { requestConversationSave };

/** Centralized turn-failure unwind. Marks the conversation `failed`, and —
 * when a streaming placeholder id is given — flips that message's
 * `isStreaming` off and appends the error text so the assistant bubble can't
 * spin forever. Shared by createApiConversation / retryLastTurn /
 * resumeApiConversation catches and the promoted-queued send failure path,
 * which previously hand-rolled this (and sometimes forgot to clear the
 * placeholder, leaving a stuck spinner). */
export function failTurn(
  conversationId: string,
  streamingMessageId: string | null,
  error: unknown,
): void {
  let failed: AgentConversation | undefined;
  useAgentTaskStore.setState((s) => ({
    conversations: s.conversations.map((c) => {
      if (c.id !== conversationId) return c;
      const messages =
        streamingMessageId !== null
          ? c.messages.map((m) =>
              m.id === streamingMessageId
                ? { ...m, isStreaming: false, content: m.content + `\n\nError: ${error}` }
                : m,
            )
          : c.messages;
      const next: AgentConversation = {
        ...c,
        messages,
        status: "failed",
        updatedAt: Date.now(),
      };
      failed = next;
      return next;
    }),
  }));
  if (failed) scheduleSave(failed);
}

export type ApiAgentCli =
  | "api-claude-oauth"
  | "api-claude"
  | "api-openai-agents"
  | "api-openai"
  | "api-minimax"
  | "api-openrouter"
  | "api-ollama"
  | "api-custom";

export type AgentCli =
  | "claude-code"
  | "codex"
  | "opencode"
  | "packetcode"
  | "api-claude-oauth"
  | "api-claude"
  | "api-openai-agents"
  | "api-openai"
  | "api-minimax"
  | "api-openrouter"
  | "api-ollama"
  | "api-custom"
  | (string & {});

/** Retired provider-identity duplicates, mapped onto their canonical id.
 * `api-minimax-api` was a pure identity duplicate of `api-minimax` (same
 * Rust MiniMaxProvider, differing only in which keychain slot the provider
 * string selected) — collapsed here so stored conversations/guardrails
 * keep resolving after the consolidation. */
export const LEGACY_AGENT_ALIASES: Record<string, AgentCli> = {
  "api-minimax-api": "api-minimax",
};

/**
 * API provider ids withdrawn from the picker.
 *
 * Persisted conversations on these ids still hydrate and stay fully readable —
 * transcript, tool cards, diffs, plan, cost — but they cannot start a new turn.
 * Unlike {@link LEGACY_AGENT_ALIASES} these are deliberately NOT remapped: an
 * alias silently moves a conversation onto different credentials, which is
 * exactly the mis-billing hazard `apiAgentProvider`'s fallback warns about.
 *
 * `api-openai-codex` drove `codex exec` on a ChatGPT Plus/Pro subscription.
 * Without a subscription it bought nothing over `api-openai-agents`, which
 * reaches the same OpenAI API with the same API key — so the row, its sidecar
 * provider, and its registry entry were removed in 2026-07.
 *
 * NOTE: `api-claude-oauth` is deliberately NOT here. That row survives; it is
 * now the Claude Agent SDK authenticated with the `api-key-anthropic` keyring
 * entry rather than a Claude.ai subscription login. Only its credential and
 * label changed, so its conversations keep working.
 */
export const RETIRED_API_AGENTS: ReadonlySet<string> = new Set([
  "api-openai-codex",
  "api-packetcode",
]);

/**
 * The agent a retired id's *automation* consumers should fall back to.
 *
 * Applies only where PacketBench picks an executor on the user's behalf and a
 * silent skip would be worse than a substitution — chiefly a persisted
 * Reviewer Gate policy pinned to `api-openai-codex`, which must review with
 * *something* rather than quietly pass the attempt. It is NOT applied to
 * conversations: those go read-only and wait for an explicit user switch.
 */
export const RETIRED_API_AGENT_REPLACEMENTS: Readonly<Record<string, AgentCli>> = {
  "api-openai-codex": "api-openai-agents",
};

/** True when `agent` names a withdrawn provider that can no longer start or
 * continue a turn. */
export function isRetiredApiAgent(agent: string): boolean {
  return RETIRED_API_AGENTS.has(canonicalizeAgentCli(agent));
}

/** Resolve a retired agent id to its automation replacement. Pass-through for
 * every live id. See {@link RETIRED_API_AGENT_REPLACEMENTS} for when this is
 * appropriate — never for a user's conversation. */
export function resolveRetiredApiAgent(agent: AgentCli): AgentCli {
  return RETIRED_API_AGENT_REPLACEMENTS[canonicalizeAgentCli(agent)] ?? agent;
}

/** Resolve a possibly-legacy agent id to its canonical `AgentCli`. Pass-
 * through for anything not in the alias table (including unknown ids —
 * those are surfaced by `apiAgentProvider`'s own fallback, not here). */
export function canonicalizeAgentCli(agent: string): AgentCli {
  return LEGACY_AGENT_ALIASES[agent] ?? agent;
}

/** Check if an agent type uses API mode (vs PTY/CLI mode). */
export function isApiAgent(agent: AgentCli): boolean {
  return agent.startsWith("api-");
}

/** Get the provider name from an API agent type. */
export function apiAgentProvider(agent: AgentCli): string {
  const map: Partial<Record<AgentCli, string>> = {
    // Historical id. Since 2026-07 this is the Claude Agent SDK on the
    // `api-key-anthropic` keyring entry, NOT a Claude.ai subscription login.
    // The string is unchanged because persisted conversations store it in
    // `AgentConversation.provider` and resume with it verbatim.
    "api-claude-oauth": "claude-oauth",
    "api-claude": "anthropic",
    // RETIRED (see RETIRED_API_AGENTS). The entry is kept on purpose: dropping
    // it would send every legacy Codex conversation through the fallback below
    // and bill it to the user's Anthropic key. Identity still resolves; only
    // routing is withdrawn, by the retired-agent guards on the send paths.
    "api-openai-codex": "openai-codex",
    "api-openai-agents": "openai-agents",
    "api-openai": "openai",
    "api-minimax": "minimax",
    "api-openrouter": "openrouter",
    "api-ollama": "ollama",
    // LM2 — user-supplied OpenAI-compatible endpoint. Key optional.
    "api-custom": "custom",
  };
  // Canonicalise first so a legacy id hydrated from disk (`api-minimax-api`)
  // resolves through its alias instead of tripping the unknown-agent fallback.
  const provider = map[canonicalizeAgentCli(agent)];
  if (!provider) {
    // A missing entry means a new ApiAgentCli was added without updating this
    // map, or a malformed/legacy `api-*` agent was hydrated from disk. Silently
    // defaulting to Anthropic mis-bills against the wrong credentials, so log
    // it so the misconfiguration is diagnosable.
    logSwallowed("agentTaskStore.apiAgentProvider")(
      new Error(`Unknown API agent provider for "${agent}" — defaulting to anthropic`),
    );
    return "anthropic";
  }
  return provider;
}

/**
 * User-facing explanation shown wherever a retired provider's conversation
 * tries to take another turn. Kept in one place so the composer banner, the
 * blocked-send system message, and any future surface all say the same thing.
 */
/**
 * The provider id whose *credential* an API agent's auth badge should reflect.
 *
 * Usually identical to {@link apiAgentProvider}, which names the ROUTING
 * target. The two diverge for `api-claude-oauth`: it still routes to the
 * sidecar as `claude-oauth`, but since 2026-07 it authenticates with the
 * Anthropic API key, so its badge must show keyring status — not the
 * `claude-oauth` OAuth-file probe.
 *
 * That OAuth probe is emphatically NOT dead and must not be removed: it is the
 * launch gate for PTY `claude` / `codex` CLI sessions and for the multi-account
 * CLI feature (`useAccountLaunchGate`, `SubscriptionsCard`). The Agents pane
 * simply stops calling it.
 */
export function authProbeProvider(agent: AgentCli): string {
  const routing = apiAgentProvider(agent);
  return routing === "claude-oauth" ? "anthropic" : routing;
}

/**
 * Record — visibly and durably — that a turn was refused because the
 * conversation's provider has been withdrawn.
 *
 * Appended as a `system` message rather than surfaced as a transient toast so
 * the reason survives a reload and is legible in the transcript the user is
 * looking at. The conversation status is left alone: it is not *failed*, it is
 * complete and read-only.
 */
export function appendRetiredAgentNotice(conversationId: string, agent: AgentCli): void {
  let updated: AgentConversation | undefined;
  useAgentTaskStore.setState((s) => ({
    conversations: s.conversations.map((c) => {
      if (c.id !== conversationId) return c;
      // Don't stack duplicates when a user retries or a queue drains.
      const last = c.messages[c.messages.length - 1];
      if (last?.role === "system" && last.content === retiredApiAgentNotice(agent)) return c;
      const next: AgentConversation = {
        ...c,
        messages: [
          ...c.messages,
          {
            id: generateId("msg"),
            role: "system",
            content: retiredApiAgentNotice(agent),
            timestamp: Date.now(),
          },
        ],
        updatedAt: Date.now(),
      };
      updated = next;
      return next;
    }),
  }));
  if (updated) scheduleSave(updated);
}

export function retiredApiAgentNotice(agent: AgentCli): string {
  const canonical = canonicalizeAgentCli(agent);
  const replacement = RETIRED_API_AGENT_REPLACEMENTS[canonical];
  const base =
    canonical === "api-openai-codex"
      ? `This conversation used the OpenAI (ChatGPT Plus/Pro) provider, which ${APP_NAME} no longer offers — it required a ChatGPT subscription login. The transcript is preserved and stays fully readable.`
      : `This conversation used a provider ${APP_NAME} no longer offers (${canonical}). The transcript is preserved and stays fully readable.`;
  return replacement === "api-openai-agents"
    ? `${base} To continue, switch it to OpenAI Agents SDK (API) — the same OpenAI models, billed to your OpenAI API key.`
    : base;
}

/** Cleanup functions for API conversation event listeners. */
const apiConversationCleanup = new Map<string, () => void>();

/** In-flight installApiAgentListeners promises, keyed by conversation id.
 * Closes the TOCTOU where two concurrent resumes both pass the
 * apiConversationCleanup.has() check and double-install listener sets
 * (the second set() would overwrite the first cleanup fn, permanently
 * leaking the first set's listeners). */
const apiListenerInstallInFlight = new Map<string, Promise<void>>();

/** Conversations whose resumeApiConversation is currently mid-flight, so
 * sendMessage routes a concurrent second send into the queued-message path
 * instead of spawning a duplicate resume + session start. */
const apiResumeInFlight = new Set<string>();

/** Detach and forget the api-agent listener block for `id`, so the next
 * sendMessage routes through resumeApiConversation (F1) and re-creates the
 * backend session. Used when the backend reports the session no longer
 * exists (sidecar crash fan-out, "No active session"). */
export function releaseApiConversationListeners(id: string): void {
  const cleanup = apiConversationCleanup.get(id);
  if (cleanup) {
    cleanup();
    apiConversationCleanup.delete(id);
  }
}

/** Per-conversation guard so auto-failover never loops. Cleared whenever
 * the user sends a fresh user turn; replenished on a successful turn.
 * Exported so the listener module (apiAgentListeners.ts) can flip the
 * guard inside the rate-limit error handler without re-importing the
 * whole store surface. */
export const failoverGuard = new Set<string>();

/** Derive a display name for a projectPath (e.g. "owner/repo" or last two segments). */
export function repoDisplayName(projectPath: string, githubRepos: GitHubRepo[]): string {
  const segments = projectPath.replace(/\\/g, "/").split("/").filter(Boolean);
  const folderName = segments[segments.length - 1] ?? projectPath;
  const match = githubRepos.find((r) => r.name === folderName);
  if (match) return match.full_name;
  if (segments.length >= 2)
    return `${segments[segments.length - 2]}/${segments[segments.length - 1]}`;
  return folderName;
}

/** Max conversation raw output buffer (256 KB) */
const MAX_RAW_OUTPUT_SIZE = 256 * 1024;
const MAX_RESUME_MESSAGES = 80;
const MAX_RESUME_CHARS = 120_000;
const MAX_TOOL_RESUME_CHARS = 4_000;

function truncateResumeText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n... [truncated]`;
}

function toolCallsResumeText(toolCalls: AgentToolCall[] | undefined): string {
  if (!toolCalls || toolCalls.length === 0) return "";
  const lines = toolCalls.map((tc) => {
    const parts = [`- ${tc.name} (${tc.status})`];
    if (tc.input) parts.push(`input: ${truncateResumeText(tc.input, 800)}`);
    const output = tc.fullContent ?? tc.summary ?? "";
    if (output) parts.push(`result: ${truncateResumeText(output, MAX_TOOL_RESUME_CHARS)}`);
    return parts.join("\n  ");
  });
  return `Tool calls:\n${lines.join("\n")}`;
}

function messageResumeContent(message: AgentMessage): string {
  const parts = [message.content.trim()];
  if (message.role === "assistant") {
    const toolText = toolCallsResumeText(message.toolCalls);
    if (toolText) parts.push(toolText);
  }
  return parts.filter(Boolean).join("\n\n");
}

export function buildConversationResumeMessages(messages: AgentMessage[]): ResumeMessage[] {
  const normalized = messages
    .filter((m) => !m.isStreaming && !m.queued)
    .filter((m) => m.role === "user" || m.role === "assistant" || m.role === "system")
    .map((m) => ({
      role: m.role,
      content: messageResumeContent(m),
    }))
    .filter((m) => m.content.length > 0);

  const kept: ResumeMessage[] = [];
  let totalChars = 0;
  for (let i = normalized.length - 1; i >= 0; i -= 1) {
    const message = normalized[i];
    const nextChars = totalChars + message.content.length;
    if (kept.length >= MAX_RESUME_MESSAGES || nextChars > MAX_RESUME_CHARS) {
      break;
    }
    kept.unshift(message);
    totalChars = nextChars;
  }
  return kept;
}

/** Named-field options for `createApiConversation`. Replaces the former
 * ~18-positional-arg signature, which was a latent-bug magnet: callers passed
 * unreadable positional sequences and inserting one arg silently shifted every
 * caller. Only `agent`/`projectPath`/`model`/`initialMessage` are required; the
 * rest preserve their previous per-arg defaults when omitted. */
export interface CreateApiConversationOptions {
  agent: AgentCli;
  projectPath: string;
  model: string;
  initialMessage: string;
  systemPromptOverride?: string | null;
  thinkingEnabled?: boolean;
  planMode?: boolean;
  sshTarget?: AgentSshConfigInput | null;
  /** When set, use this id instead of generating a new one. Used by Flight
   * Deck attempts so the conversation id matches the backend session id. */
  explicitId?: string;
  /** When true, skip the start_api_agent_session backend call (the caller
   * has already started it). Used by Flight Deck attempts. */
  skipBackendStart?: boolean;
  /** Restrict the agent to this tool subset (e.g. Scout profile uses
   * read_file/list_directory/grep/web_fetch). Undefined = all tools. */
  allowedTools?: string[] | null;
  /** Inject the memory layer's project context into the system prompt.
   * Default false to preserve existing behavior. */
  memoryContextEnabled?: boolean;
  /** Image attachments inlined with the initial user message. Currently only
   * applied to the in-process LlmProvider path; sidecar Anthropic + Codex
   * ignore them until the protocol bump that wires them through. */
  attachments?: ImageAttachment[] | null;
  /** F9: per-conversation MCP server filter passed to the sidecar at
   * session start. null = all enabled servers. */
  enabledMcpServerIds?: string[] | null;
  /** Initial permission posture for the backend session. Must be supplied
   * before startApiAgentSession so the first turn doesn't race with a
   * post-create permission update. */
  permissionMode?: PermissionMode;
  approveWrites?: boolean;
}

/**
 * What the delete-time worktree discard did. Returned (never thrown) by
 * `deleteConversation` so the caller can toast a cleanup failure: the
 * conversation is gone either way, and a silently orphaned worktree is exactly
 * the bug this fan-out exists to fix.
 */
export interface WorktreeDiscardOutcome {
  worktreePath: string;
  branch: string;
  /** Directory + branch actually removed. */
  discarded: boolean;
  /** Populated when cleanup failed — the delete still happened. */
  error?: string;
}

interface AgentTaskStore {
  // --- Composer state ---
  // (Composer draft text lives in agentDraftStore — keyed per conversation,
  // plus a launch slot — so no draft can bleed across composers.)
  selectedRepo: string | null;

  // --- Conversation state ---
  conversations: AgentConversation[];
  selectedConversationId: string | null;
  /** Session ids whose Stop command has been sent but not yet acknowledged. */
  cancellingConversationIds: Set<string>;

  setSelectedRepo: (repo: string | null) => void;

  // --- Conversation actions ---
  createApiConversation: (options: CreateApiConversationOptions) => Promise<string>;
  sendMessage: (
    conversationId: string,
    content: string,
    attachments?: ImageAttachment[] | null,
  ) => void;
  addAssistantMessage: (
    conversationId: string,
    content: string,
    toolCalls?: AgentToolCall[],
  ) => void;
  updateAssistantMessage: (conversationId: string, messageId: string, content: string) => void;
  selectConversation: (id: string | null) => void;
  /**
   * Delete the conversation AND discard the worktree it ran in — the directory
   * plus its `pkt/<id>` branch (owner decision 2026-07-30, "Discard, surface the
   * confirm"; the confirm dialog states the consequence up front via
   * `lib/conversationWorktreeDisclosure`).
   *
   * The record removal is SYNCHRONOUS and unconditional; the worktree cleanup is
   * best-effort and cannot take the delete down with it. The returned promise
   * reports what happened so the caller can surface a cleanup failure instead of
   * leaving an orphaned directory the user never hears about. It resolves `null`
   * when there was no local worktree to discard, and NEVER rejects.
   */
  deleteConversation: (id: string) => Promise<WorktreeDiscardOutcome | null>;
  archiveConversation: (id: string) => void;
  unarchiveConversation: (id: string) => void;
  /** Rename a conversation from the sidebar. Trims the input and ignores a
   * blank result, so an accidental clear-and-commit leaves the old title
   * standing rather than persisting an empty row label. */
  renameConversation: (id: string, title: string) => void;
  /** P2-S2: flip a conversation's worktree lifecycle state (active → landed /
   * discarded) after a merge-back or discard, and persist. Materializes a
   * legacy conversation's derived worktree provenance onto the record if it
   * had none (so the state flip survives hydration). No-op when the
   * conversation has no worktree at all (ran in the project root). */
  setConversationWorktreeState: (id: string, state: "landed" | "discarded") => void;
  /** P2-S2: record the PR number opened for a conversation's worktree branch
   * (feeds the worktree safe-cleanup predicate). Materializes legacy
   * provenance like `setConversationWorktreeState`; no-op without a worktree. */
  recordConversationPr: (id: string, prNumber: number) => void;
  /** P2-S2: first-ever Discard wiring — remove the conversation's worktree dir
   * AND its `pkt/<id>` branch, then flip state → discarded. A DIRTY worktree
   * requires `opts.confirmed`; without it the call rejects and removes nothing
   * (no non-Discard removal path ever touches a dirty tree). Idempotent /
   * no-op when the conversation has no local worktree. */
  discardConversationWorktree: (id: string, opts?: { confirmed?: boolean }) => Promise<void>;
  appendRawOutput: (conversationId: string, text: string) => void;
  cancelActiveConversation: (id: string) => Promise<void>;
  changeModel: (id: string, newModel: string) => Promise<void>;
  setPlanMode: (id: string, enabled: boolean) => Promise<void>;
  setPermissionMode: (id: string, mode: PermissionMode) => Promise<void>;
  setApproveWrites: (id: string, enabled: boolean) => Promise<void>;
  /** B3: append a derived allowlist pattern to the conversation's
   * `allowedTools` (deduped). Read by the next turn's startApiAgentSession
   * via the resume path — no immediate backend call needed. Stays in
   * agentTaskStore because `allowedTools` is part of the persisted
   * conversation config (not approval state); the approval store's smart-
   * approval row delegates here AFTER respondPermission resolves so
   * subsequent same-pattern tool calls skip the prompt entirely. */
  appendAllowedToolPattern: (id: string, pattern: string) => void;
  /** B8: tag a child conversation with its parent's id so the chat
   * header can show a "← back to plan" link. Idempotent — calling
   * twice with the same parent is a no-op. */
  setParentConversation: (childId: string, parentId: string) => void;
  /** B1: queue a hover-`+` diff comment. Folded into the NEXT user
   * sendMessage as a "File comments:" preamble, then cleared. */
  addDiffComment: (id: string, comment: Omit<DiffComment, "id" | "createdAt">) => void;
  removeDiffComment: (id: string, commentId: string) => void;
  clearDiffComments: (id: string) => void;
  retryLastTurn: (id: string, newModel?: string) => Promise<void>;
  /** M2.7 — Cursor-style "edit a prior user message and re-run from there."
   * Truncates the transcript to before the target user message, cancels any
   * active turn, and dispatches the new content as a fresh user turn. The
   * model receives the truncated history on the next send and the agent runs
   * forward from that fork point. File-state rewind isn't part of this v1
   * pass — only the transcript forks. */
  forkAndResend: (id: string, messageId: string, newContent: string) => Promise<void>;
  exportConversation: (id: string) => Promise<string>;
  /** F1: re-establish a hydrated conversation that lost its live session
   * across an app restart. Re-attaches `api-agent:*` listeners and calls
   * `start_api_agent_session` with the conversation's `resumeToken` (when
   * present) plus `content` as the initial message. No-op when the
   * conversation already has live listeners or isn't an API conversation. */
  resumeApiConversation: (
    conversationId: string,
    content: string,
    attachments?: ImageAttachment[] | null,
  ) => Promise<void>;
  /** MCPH4: close the selected live API backend and discard only its frozen
   * MCP authority. The next user turn follows the normal resume path, captures
   * current trust, and re-establishes listeners. Refuses while a turn streams. */
  prepareMcpReconnect: (conversationId: string) => Promise<void>;
}

/**
 * Idempotency wrapper for the api-agent listener block. The handler logic
 * lives in `./apiAgentListeners.ts`; this wrapper enforces
 * "one listener set per conversation id" via the `apiConversationCleanup`
 * map (the source of truth for which conversations have live listeners).
 * Callers that need to detach early (delete / forkAndResend) read directly
 * from `apiConversationCleanup`.
 */
async function ensureApiAgentListeners(id: string): Promise<void> {
  if (apiConversationCleanup.has(id)) return;
  // Single-flight: installApiAgentListeners awaits ~14 sequential listen()
  // IPC registrations, so the map entry lands well after the has() check
  // above. Memoize the in-flight install so concurrent callers share one
  // listener set instead of double-installing (and orphaning) one.
  let install = apiListenerInstallInFlight.get(id);
  if (!install) {
    install = installApiAgentListeners(id)
      .then((cleanup) => {
        apiConversationCleanup.set(id, cleanup);
      })
      .finally(() => {
        // Clears on rejection too, so a failed install can be retried by
        // the next send exactly as today.
        apiListenerInstallInFlight.delete(id);
      });
    apiListenerInstallInFlight.set(id, install);
  }
  return install;
}

async function captureMcpTrustSnapshot(
  projectPath: string,
  enabledNames: string[] | null,
  remote: boolean,
): Promise<McpTrustSnapshot[] | undefined> {
  // Remote config and project trust belong to the execution host. Protocol
  // v12 gates repo-supplied commands there before probing; desktop paths and
  // trust grants must not be reused as remote authority.
  if (remote) return undefined;
  const mcpStore = useMcpStore.getState();
  if (mcpStore.servers.length === 0) {
    await mcpStore.fetchServers();
  }
  const refreshed = useMcpStore.getState();
  if (refreshed.error || !Array.isArray(refreshed.servers)) return undefined;
  return useMcpTrustStore.getState().snapshot(refreshed.servers, enabledNames, projectPath);
}

export const useAgentTaskStore = create<AgentTaskStore>((set, get) => ({
  selectedRepo: null,

  // --- Conversation state ---
  conversations: [],
  selectedConversationId: null,
  cancellingConversationIds: new Set(),

  setSelectedRepo: (repo) => set({ selectedRepo: repo }),

  // ─── Conversation actions ────────────────────────────────────────────

  createApiConversation: async ({
    agent,
    projectPath,
    model,
    initialMessage,
    systemPromptOverride,
    thinkingEnabled,
    planMode,
    sshTarget,
    explicitId,
    skipBackendStart,
    allowedTools,
    memoryContextEnabled,
    attachments,
    enabledMcpServerIds,
    permissionMode,
    approveWrites,
  }) => {
    // Retired-provider guard. Blocking the composer alone is not enough: a
    // profile, a flight relaunch, a "continue in" action, or a stale pane can
    // all reach this entry point directly. Without this the request would
    // travel to a backend with no route for the id and die as
    // `Unknown provider: openai-codex`, which reads as a bug rather than a
    // product statement.
    if (isRetiredApiAgent(agent)) {
      throw new Error(retiredApiAgentNotice(agent));
    }
    const id = explicitId ?? generateId("conv");
    const provider = apiAgentProvider(agent);
    const isRemoteConversation = Boolean(sshTarget);
    // Explicit callers (profiles, /new inheritance) always win; otherwise
    // fall back to the Settings-configured default MCP set (null = all
    // non-disabled servers, resolved sidecar-side).
    const resolvedMcpIds =
      enabledMcpServerIds ?? useAgentSettingsStore.getState().defaultEnabledMcpServerIds ?? null;
    const frozenMcpTrust = await captureMcpTrustSnapshot(
      projectPath,
      resolvedMcpIds,
      isRemoteConversation,
    );

    if (!skipBackendStart) {
      await assertCostGuardrailsAllowLaunch(provider);
    }

    // System-prompt assembly. Order (lowest in the prompt → highest):
    //   1. AGENTS.md / CLAUDE.md from the project root (the de-facto standard
    //      cross-tool instructions file).
    //   2. PacketBench memory layer (learned patterns + recent summaries),
    //      gated on the per-conversation `memoryContextEnabled` flag.
    //   3. Profile / explicit `systemPromptOverride` (lives last so it wins
    //      conflicts of intent — the user picked this profile deliberately).
    let effectiveSystemPrompt: string | null = systemPromptOverride ?? null;

    if (memoryContextEnabled) {
      const memoryBrief = useMemoryStore.getState().composeMemoryBrief(
        sshTarget
          ? {
              kind: "ssh",
              projectPath,
              serverId: sshTarget.serverId,
              remotePath: sshTarget.remotePath,
            }
          : { kind: "local", projectPath },
        { query: initialMessage },
      );
      if (memoryBrief.text.trim().length > 0) {
        const base = effectiveSystemPrompt ?? "";
        effectiveSystemPrompt = `${memoryBrief.text}\n\n---\n\n${base}`;
      }
    }

    // AGENTS.md prepend — async fetch, best-effort; failures are silent so a
    // missing file never blocks a launch.
    if (!isRemoteConversation) {
      try {
        const agentsMd = await loadAgentsMd(projectPath);
        if (agentsMd) {
          const base = effectiveSystemPrompt ?? "";
          effectiveSystemPrompt = `## Project guidance (from AGENTS.md cascade)\n\n${agentsMd}\n\n---\n\n${base}`;
        }
      } catch {
        // Best-effort; absent file is the common case.
      }
    }

    const now = Date.now();
    const displayBase = sshTarget
      ? sshTarget.name
      : (projectPath.replace(/\\/g, "/").split("/").filter(Boolean).pop() ?? projectPath);
    const modelShort = model.split("-").slice(0, 2).join("-");

    const userMsg: AgentMessage = {
      id: generateId("msg"),
      role: "user",
      content: initialMessage,
      timestamp: now,
    };
    userMsg.provenance = userIntentProvenance(userMsg.id, now);
    userMsg.evidence = attachments?.length
      ? attachmentProvenance(userMsg.id, attachments, now)
      : undefined;

    const conversation: AgentConversation = {
      id,
      title: `${displayBase} — ${modelShort}`,
      agent,
      projectPath,
      status: "active",
      messages: [userMsg],
      sessionId: id, // For API mode, sessionId == conversationId (used as event key)
      rawOutput: "",
      createdAt: now,
      updatedAt: now,
      mode: "api",
      provider,
      model,
      systemPromptOverride: effectiveSystemPrompt,
      queuedMessages: [],
      planMode: planMode ?? false,
      // Fail closed: a conversation that never chose a posture asks before
      // every risky tool. "auto" (unprompted bash/write) is an explicit choice.
      permissionMode: permissionMode ?? "ask_for_risky",
      approveWrites: approveWrites ?? false,
      thinkingEnabled: thinkingEnabled ?? false,
      sshTarget: sshTarget
        ? {
            // Phase 2: `id` carries the ServerConfig id from serverStore.
            // Persisted conversations keep the field named `id` to preserve
            // back-compat with hydrated records from before the rename.
            id: sshTarget.serverId,
            name: sshTarget.name,
            host: sshTarget.host,
            user: sshTarget.user,
            remotePath: sshTarget.remotePath,
          }
        : undefined,
      allowedTools: allowedTools ?? undefined,
      memoryContextEnabled: memoryContextEnabled ?? false,
      enabledMcpServerIds: resolvedMcpIds ?? undefined,
      mcpTrustSnapshot: frozenMcpTrust,
    };

    // Persist the initial prompt before exposing a running conversation or
    // starting the provider. A slow first response must not be its only save.
    // Let save failures reject to the launch UI; no provider work has begun.
    await saveConversationNow(conversation);
    set((s) => ({
      conversations: [conversation, ...s.conversations],
      selectedConversationId: id,
    }));

    // Hoisted above the try so the catch can clear streaming on this exact
    // placeholder by id (the backend start may reject before any event fires).
    const assistantMsgId = generateId("msg");
    try {
      // Create a streaming assistant message
      set((s) => ({
        conversations: s.conversations.map((c) =>
          c.id === id
            ? {
                ...c,
                messages: [
                  ...c.messages,
                  {
                    id: assistantMsgId,
                    role: "assistant" as const,
                    content: "",
                    timestamp: Date.now(),
                    isStreaming: true,
                  },
                ],
              }
            : c,
        ),
      }));

      await ensureApiAgentListeners(id);

      // Start the API agent session unless the caller already did so.
      if (!skipBackendStart) {
        const sshConfig = sshTarget
          ? {
              host: sshTarget.host,
              port: sshTarget.port,
              user: sshTarget.user,
              remote_path: sshTarget.remotePath,
              key_path: sshTarget.keyPath ?? null,
              auth_method: sshTarget.authMethod ?? null,
              // Phase 2: backend still calls this `target_id` for now. It
              // accepts the unified `ServerConfig.id`; the parallel backend
              // PR is unifying naming.
              target_id: sshTarget.serverId,
              host_fingerprint: sshTarget.hostFingerprint ?? null,
            }
          : null;
        await startApiAgentSession(
          id,
          provider,
          model,
          projectPath,
          initialMessage,
          effectiveSystemPrompt,
          thinkingEnabled ?? false,
          attachments ?? undefined,
          planMode ?? false,
          sshConfig,
          allowedTools ?? null,
          null, // resumeToken — fresh start
          resolvedMcpIds,
          null,
          permissionMode ?? "ask_for_risky",
          approveWrites ?? false,
          null, // commandPath — no surviving sidecar provider is CLI-backed
          undefined,
          frozenMcpTrust,
        );
      }
    } catch (e) {
      // `startApiAgentSession` rejected before any `api-agent:*` event could
      // fire, so the streaming placeholder would otherwise spin forever.
      // failTurn fails the conversation and clears the specific placeholder.
      logSwallowed("agentTaskStore.createApiConversation")(e);
      failTurn(id, assistantMsgId, e);
    }

    return id;
  },

  sendMessage: (conversationId, content, attachments) => {
    const conv = get().conversations.find((c) => c.id === conversationId);
    if (!conv) return;
    // Retired-provider guard (see RETIRED_API_AGENTS). The transcript stays
    // readable; only new turns are refused. Recorded as a system message so
    // the refusal is visible and persisted rather than silently swallowed —
    // this also catches queued messages and Monitor-driven sends that route
    // around the disabled composer.
    if (conv.mode === "api" && isRetiredApiAgent(conv.agent)) {
      appendRetiredAgentNotice(conversationId, conv.agent);
      return;
    }
    // Fresh user turn — re-arm auto-failover for this conversation.
    failoverGuard.delete(conversationId);

    // B1: fold queued hover-`+` diff comments into the prompt, then clear.
    // Format mirrors the Codex-App "File comments:" preamble — file:line
    // anchors give the model precise context without us having to re-send
    // the full diff (it's already in the conversation history).
    const queuedComments = conv.pendingDiffComments ?? [];
    let effectiveContent = content;
    if (queuedComments.length > 0) {
      const block = queuedComments.map((c) => `- ${c.path}:${c.line} — ${c.text}`).join("\n");
      effectiveContent = `File comments:\n${block}\n\n${content}`;
      // Clear immediately so the chip strip empties on click; if the send
      // ultimately fails, the comments are gone (acceptable — they're now
      // in the conversation history as part of the user message).
      get().clearDiffComments(conversationId);
    }

    // F1: hydrated API conversations have no live listeners — route the
    // first send-after-restart through the resume path so the Rust side
    // re-creates the session before the message arrives. If a resume is
    // already mid-flight, fall through to the isRunning queue below (the
    // resume synchronously set status "active" + a streaming placeholder)
    // instead of spawning a duplicate resume/session start.
    if (
      conv.mode === "api" &&
      !apiConversationCleanup.has(conversationId) &&
      !apiResumeInFlight.has(conversationId)
    ) {
      void get().resumeApiConversation(conversationId, effectiveContent, attachments);
      return;
    }
    // Continue with the comment-augmented content from here on.
    content = effectiveContent;

    // If the agent is still running (API mode), queue the message and show a queued bubble.
    const isRunning =
      conv.mode === "api" && conv.status === "active" && conv.messages.some((m) => m.isStreaming);

    if (isRunning) {
      const queuedMsg: AgentMessage = {
        id: generateId("msg"),
        role: "user",
        content,
        timestamp: Date.now(),
        queued: true,
      };
      queuedMsg.provenance = userIntentProvenance(queuedMsg.id, queuedMsg.timestamp);
      let updated: AgentConversation | undefined;
      set((s) => ({
        conversations: s.conversations.map((c) => {
          if (c.id !== conversationId) return c;
          const next: AgentConversation = {
            ...c,
            messages: [...c.messages, queuedMsg],
            queuedMessages: [...(c.queuedMessages ?? []), content],
            updatedAt: Date.now(),
          };
          updated = next;
          return next;
        }),
      }));
      if (updated) scheduleSave(updated);
      return;
    }

    const msg: AgentMessage = {
      id: generateId("msg"),
      role: "user",
      content,
      timestamp: Date.now(),
    };
    msg.provenance = userIntentProvenance(msg.id, msg.timestamp);
    msg.evidence = attachments?.length
      ? attachmentProvenance(msg.id, attachments, msg.timestamp)
      : undefined;

    let updatedAfterUser: AgentConversation | undefined;
    set((s) => ({
      conversations: s.conversations.map((c) => {
        if (c.id !== conversationId) return c;
        const next: AgentConversation = {
          ...c,
          messages: [...c.messages, msg],
          updatedAt: Date.now(),
          status: "active",
        };
        updatedAfterUser = next;
        return next;
      }),
    }));
    if (updatedAfterUser) scheduleSave(updatedAfterUser);

    if (conv.mode === "api") {
      // For API mode, create a new streaming assistant message and call the backend
      const assistantMsgId = generateId("msg");

      // Add streaming assistant message
      set((s) => ({
        conversations: s.conversations.map((c) =>
          c.id === conversationId
            ? {
                ...c,
                messages: [
                  ...c.messages,
                  {
                    id: assistantMsgId,
                    role: "assistant" as const,
                    content: "",
                    timestamp: Date.now(),
                    isStreaming: true,
                  },
                ],
              }
            : c,
        ),
      }));

      void sendApiAgentMessage(conversationId, content, attachments ?? undefined).catch((err) => {
        // Mark the conversation failed AND clear the streaming assistant
        // placeholder created just above — otherwise its spinner never stops.
        failTurn(conversationId, assistantMsgId, err);
        // "No active session" means the backend has no record of this id
        // (e.g. sidecar crashed and the supervisor cleared ownership). Drop
        // the listener block so the next send routes through
        // resumeApiConversation and re-creates the session (F1).
        if (String(err).includes("No active session")) {
          releaseApiConversationListeners(conversationId);
        }
      });
    } else {
      // PTY mode
      if (!conv.sessionId) return;
      void writePty(conv.sessionId, content + "\r");
    }
  },

  addAssistantMessage: (conversationId, content, toolCalls) => {
    const msg: AgentMessage = {
      id: generateId("msg"),
      role: "assistant",
      content,
      timestamp: Date.now(),
      toolCalls,
    };
    msg.provenance = assistantDerivativeProvenance(msg);

    set((s) => ({
      conversations: s.conversations.map((c) =>
        c.id === conversationId
          ? { ...c, messages: [...c.messages, msg], updatedAt: Date.now() }
          : c,
      ),
    }));
  },

  updateAssistantMessage: (conversationId, messageId, content) => {
    set((s) => ({
      conversations: s.conversations.map((c) =>
        c.id === conversationId
          ? {
              ...c,
              updatedAt: Date.now(),
              messages: c.messages.map((m) => (m.id === messageId ? { ...m, content } : m)),
            }
          : c,
      ),
    }));
  },

  selectConversation: (id) => {
    set({ selectedConversationId: id });
  },

  deleteConversation: (id) => {
    const conv = get().conversations.find((c) => c.id === id);
    // Resolve the worktree BEFORE the record leaves the store — afterwards its
    // provenance is unrecoverable and the checkout would be orphaned on disk.
    // Same resolver the confirm dialog quotes, so the warning the user approved
    // and the directory we remove can never diverge.
    const worktree = conv ? conversationWorktree(conv) : null;
    if (conv && (conv.status === "active" || conv.status === "idle")) {
      if (conv.mode === "api") {
        // Failure here orphans an API session in the backend (and
        // potentially keeps billing tokens) — log so it's diagnosable.
        void cancelApiAgentSession(id).catch(logSwallowed("agentTaskStore.cancelApiSession"));
        void closeApiAgentSession(id).catch(logSwallowed("agentTaskStore.closeApiSession"));
      } else if (conv.sessionId) {
        // Best-effort kill — swallow if PTY already exited.
        void killPty(conv.sessionId).catch(() => {});
      }
    }
    // Always release the registered api-agent:* event listeners regardless of
    // status — done/failed conversations still hold their ~13 listeners
    // (registered in apiAgentListeners.ts), which would otherwise leak.
    const cleanup = apiConversationCleanup.get(id);
    if (cleanup) {
      cleanup();
      apiConversationCleanup.delete(id);
    }
    // GC the substores. Approval-store `clearConversation` also routes
    // through maybeResolveTaskApproval so the Review queue isn't stuck on
    // a conversation that no longer exists.
    useAgentApprovalStore.getState().clearConversation(id);
    useAgentPlanStore.getState().clearConversation(id);
    useAgentStreamingStore.getState().clearConversation(id);
    useEditBaselineStore.getState().clearConversation(id);
    // Drop persisted Viewed marks so the review store's map stays bounded.
    useReviewStore.getState().clearConversation(id);
    // Drop the persisted composer draft so the localStorage map stays bounded.
    useAgentDraftStore.getState().clearDraft(id);
    // Best-effort remove persisted file (API mode only)
    if (conv?.mode === "api") {
      deleteConversationFile(id).catch((e) =>
        console.warn("Failed to delete conversation file:", e),
      );
    }
    // Cancel any pending debounced save
    cancelPendingSave(id);
    // Drop the per-conversation auto-failover guard so the module-scope Set
    // doesn't accumulate a stale entry (and can't mis-fire if the id is reused).
    failoverGuard.delete(id);
    set((s) => ({
      conversations: s.conversations.filter((c) => c.id !== id),
      selectedConversationId: s.selectedConversationId === id ? null : s.selectedConversationId,
    }));

    // Worktree discard fan-out. Runs AFTER the record is gone and force-deletes
    // the branch: the user already confirmed a dialog that named this path, this
    // branch, and (loudly) any uncommitted changes. No dirty-refusal here — the
    // record no longer exists, so refusing would strand the tree with nothing in
    // the UI pointing at it. A failure is caught and REPORTED, never swallowed
    // and never allowed to undo the delete.
    if (!worktree) return Promise.resolve(null);
    return removeConversationWorktree(worktree.basePath, id, true).then(
      (): WorktreeDiscardOutcome => ({
        worktreePath: worktree.worktreePath,
        branch: worktree.branch,
        discarded: true,
      }),
      (e): WorktreeDiscardOutcome => {
        console.warn("deleteConversation: worktree discard failed for", id, e);
        return {
          worktreePath: worktree.worktreePath,
          branch: worktree.branch,
          discarded: false,
          error: e instanceof Error ? e.message : String(e),
        };
      },
    );
  },

  archiveConversation: (id) => {
    let updated: AgentConversation | undefined;
    set((s) => ({
      conversations: s.conversations.map((c) => {
        if (c.id !== id) return c;
        const next: AgentConversation = { ...c, archived: true, updatedAt: Date.now() };
        updated = next;
        return next;
      }),
    }));
    if (updated) scheduleSave(updated);
  },

  unarchiveConversation: (id) => {
    let updated: AgentConversation | undefined;
    set((s) => ({
      conversations: s.conversations.map((c) => {
        if (c.id !== id) return c;
        const next: AgentConversation = { ...c, archived: false, updatedAt: Date.now() };
        updated = next;
        return next;
      }),
    }));
    if (updated) scheduleSave(updated);
  },

  renameConversation: (id, title) => {
    const next = title.trim();
    if (!next) return;
    let updated: AgentConversation | undefined;
    set((s) => ({
      conversations: s.conversations.map((c) => {
        if (c.id !== id || c.title === next) return c;
        const renamed: AgentConversation = { ...c, title: next, updatedAt: Date.now() };
        updated = renamed;
        return renamed;
      }),
    }));
    if (updated) scheduleSave(updated);
  },

  setConversationWorktreeState: (id, state) => {
    let updated: AgentConversation | undefined;
    set((s) => ({
      conversations: s.conversations.map((c) => {
        if (c.id !== id) return c;
        const base = c.worktree ?? deriveLegacyWorktree(c);
        if (!base) return c; // ran in project root — nothing to land/discard
        const next: AgentConversation = {
          ...c,
          worktree: { ...base, state },
          updatedAt: Date.now(),
        };
        updated = next;
        return next;
      }),
    }));
    if (updated) scheduleSave(updated);
  },

  recordConversationPr: (id, prNumber) => {
    let updated: AgentConversation | undefined;
    set((s) => ({
      conversations: s.conversations.map((c) => {
        if (c.id !== id) return c;
        const base = c.worktree ?? deriveLegacyWorktree(c);
        if (!base) return c;
        const next: AgentConversation = {
          ...c,
          worktree: { ...base, prNumber },
          updatedAt: Date.now(),
        };
        updated = next;
        return next;
      }),
    }));
    if (updated) scheduleSave(updated);
  },

  discardConversationWorktree: async (id, opts) => {
    const conv = get().conversations.find((c) => c.id === id);
    if (!conv) return;
    const wt = conv.worktree ?? deriveLegacyWorktree(conv);
    // No local worktree (ran in root, or an SSH conversation whose worktree
    // lives on the remote host) — nothing to discard locally.
    if (!wt || conv.sshTarget) return;

    // Dirty-check the worktree BEFORE removing anything. A dirty tree may only
    // be discarded with explicit confirmation; otherwise refuse and leave the
    // tree untouched (Bravo's safety spec — no non-Discard path removes a
    // dirty tree; Discard itself gates it behind confirm).
    let dirty: boolean;
    try {
      dirty = isWorktreeDirty(await getGitStatus(wt.worktreePath));
    } catch (e) {
      // If we can't determine cleanliness, treat as dirty and require confirm
      // so we never silently blow away unsaved work.
      console.warn("discardConversationWorktree: dirty-check failed for", id, e);
      dirty = true;
    }
    if (dirty && !opts?.confirmed) {
      throw new Error("Worktree has uncommitted changes. Confirm to discard and lose them.");
    }

    // Remove the worktree dir AND force-delete the pkt/<id> branch.
    await removeConversationWorktree(wt.basePath, conv.id, true);

    // Flip lifecycle → discarded and persist.
    get().setConversationWorktreeState(conv.id, "discarded");
  },

  cancelActiveConversation: async (id) => {
    if (get().cancellingConversationIds.has(id)) return;

    // Clear the queue SYNCHRONOUSLY before the backend cancel can emit its
    // `api-agent:done` — otherwise the done listener drains the queue and
    // re-sends the very message the user was cancelling (G33). Keep the turn
    // active and its streaming marker intact until Rust acknowledges Stop;
    // reporting Idle before that invoke resolves made a failed cancellation
    // look successful.
    let updated: AgentConversation | undefined;
    set((s) => {
      const cancellingConversationIds = new Set(s.cancellingConversationIds);
      cancellingConversationIds.add(id);
      return {
        cancellingConversationIds,
        conversations: s.conversations.map((c) => {
          if (c.id !== id) return c;
          const messages = c.messages.filter((m) => !m.queued);
          const next: AgentConversation = {
            ...c,
            messages,
            queuedMessages: [],
            updatedAt: Date.now(),
          };
          updated = next;
          return next;
        }),
      };
    });
    if (updated) scheduleSave(updated);

    try {
      await invoke("cancel_api_agent_session", { sessionId: id });
      // IPC success means the cancel command was accepted by Rust (and, for a
      // sidecar session, queued to its writer) — not that the provider has
      // stopped. `api-agent:done { cancelled: true }` is the authoritative
      // acknowledgement and clears the stopping state in apiAgentListeners.
    } catch (e) {
      set((s) => {
        const cancellingConversationIds = new Set(s.cancellingConversationIds);
        cancellingConversationIds.delete(id);
        return { cancellingConversationIds };
      });
      // The conversation intentionally remains active. The Stop control
      // becomes available again instead of falsely claiming the agent is idle.
      console.warn("cancel_api_agent_session failed; conversation remains active:", e);
    }
  },

  changeModel: async (id, newModel) => {
    const conversation = get().conversations.find((c) => c.id === id);
    if (!conversation || conversation.mode !== "api") return;
    // Hydrated idle conversations have no backend session yet, just as in
    // sendMessage's resume path. Their next launch reads the persisted model.
    // Live or starting sessions must still accept the change before UI updates.
    if (
      apiConversationCleanup.has(id) ||
      apiListenerInstallInFlight.has(id) ||
      apiResumeInFlight.has(id) ||
      conversation.status === "active"
    ) {
      await changeAgentModel(id, newModel);
    }
    let updated: AgentConversation | undefined;
    set((s) => ({
      conversations: s.conversations.map((c) => {
        if (c.id !== id) return c;
        const next: AgentConversation = { ...c, model: newModel, updatedAt: Date.now() };
        updated = next;
        return next;
      }),
    }));
    if (updated) await saveConversationNow(updated);
  },

  setPlanMode: async (id, enabled) => {
    await tauriSetPlanMode(id, enabled);
    // Entering plan mode starts a fresh planning round — re-arm approval so
    // approvePlan's idempotency guard (which kills repeat-click double-sends
    // within a round) can't dead-end a conversation that approved an earlier
    // plan.
    if (enabled) useAgentPlanStore.getState().resetPlanApproval(id);
    let updated: AgentConversation | undefined;
    set((s) => ({
      conversations: s.conversations.map((c) => {
        if (c.id !== id) return c;
        const next = { ...c, planMode: enabled, updatedAt: Date.now() };
        updated = next;
        return next;
      }),
    }));
    if (updated) scheduleSave(updated);
  },

  setPermissionMode: async (id, mode) => {
    await tauriSetPermissionMode(id, mode);
    let updated: AgentConversation | undefined;
    set((s) => ({
      conversations: s.conversations.map((c) => {
        if (c.id !== id) return c;
        const next = { ...c, permissionMode: mode, updatedAt: Date.now() };
        updated = next;
        return next;
      }),
    }));
    if (updated) scheduleSave(updated);
  },

  setApproveWrites: async (id, enabled) => {
    await tauriSetApproveWrites(id, enabled);
    let updated: AgentConversation | undefined;
    set((s) => ({
      conversations: s.conversations.map((c) => {
        if (c.id !== id) return c;
        const next = { ...c, approveWrites: enabled, updatedAt: Date.now() };
        updated = next;
        return next;
      }),
    }));
    if (updated) scheduleSave(updated);
  },

  setParentConversation: (childId, parentId) => {
    let updated: AgentConversation | undefined;
    set((s) => ({
      conversations: s.conversations.map((c) => {
        if (c.id !== childId) return c;
        if (c.parentConversationId === parentId) return c;
        const next: AgentConversation = {
          ...c,
          parentConversationId: parentId,
          updatedAt: Date.now(),
        };
        updated = next;
        return next;
      }),
    }));
    if (updated) scheduleSave(updated);
  },

  addDiffComment: (id, comment) => {
    if (!comment.text.trim()) return;
    const entry: DiffComment = {
      id: generateId("dc"),
      createdAt: Date.now(),
      ...comment,
    };
    let updated: AgentConversation | undefined;
    set((s) => ({
      conversations: s.conversations.map((c) => {
        if (c.id !== id) return c;
        const next: AgentConversation = {
          ...c,
          pendingDiffComments: [...(c.pendingDiffComments ?? []), entry],
          updatedAt: Date.now(),
        };
        updated = next;
        return next;
      }),
    }));
    if (updated) scheduleSave(updated);
  },

  removeDiffComment: (id, commentId) => {
    let updated: AgentConversation | undefined;
    set((s) => ({
      conversations: s.conversations.map((c) => {
        if (c.id !== id) return c;
        const next: AgentConversation = {
          ...c,
          pendingDiffComments: (c.pendingDiffComments ?? []).filter((d) => d.id !== commentId),
          updatedAt: Date.now(),
        };
        updated = next;
        return next;
      }),
    }));
    if (updated) scheduleSave(updated);
  },

  clearDiffComments: (id) => {
    let updated: AgentConversation | undefined;
    set((s) => ({
      conversations: s.conversations.map((c) => {
        if (c.id !== id) return c;
        if (!c.pendingDiffComments || c.pendingDiffComments.length === 0) return c;
        const next: AgentConversation = {
          ...c,
          pendingDiffComments: [],
          updatedAt: Date.now(),
        };
        updated = next;
        return next;
      }),
    }));
    if (updated) scheduleSave(updated);
  },

  appendAllowedToolPattern: (id, pattern) => {
    if (!pattern) return;
    let updated: AgentConversation | undefined;
    set((s) => ({
      conversations: s.conversations.map((c) => {
        if (c.id !== id) return c;
        const current = c.allowedTools ?? [];
        if (current.includes(pattern)) return c; // dedupe — no-op
        const next: AgentConversation = {
          ...c,
          allowedTools: [...current, pattern],
          updatedAt: Date.now(),
        };
        updated = next;
        return next;
      }),
    }));
    if (updated) scheduleSave(updated);
  },

  forkAndResend: async (id, messageId, newContent) => {
    const text = newContent.trim();
    if (!text) return;
    const state = get();
    const conv = state.conversations.find((c) => c.id === id);
    if (!conv) return;
    const idx = conv.messages.findIndex((m) => m.id === messageId);
    if (idx < 0) return;

    // Cancel any in-flight turn before truncating — leftover streams would
    // append to a transcript that no longer matches the model's history.
    if (conv.status === "active") {
      try {
        await state.cancelActiveConversation(id);
      } catch {
        // Best-effort; proceed even if cancel failed.
      }
    }
    if (conv.mode === "api") {
      try {
        await closeApiAgentSession(id);
      } catch {
        // Best-effort; the next send will start a fresh session locally.
      }
      const cleanup = apiConversationCleanup.get(id);
      if (cleanup) {
        cleanup();
        apiConversationCleanup.delete(id);
      }
    }

    // Truncate locally to before the edited user message and detach any
    // live session so sendMessage will spin up a fresh one with the
    // truncated history as resume context.
    let updated: AgentConversation | undefined;
    set((s) => ({
      conversations: s.conversations.map((c) => {
        if (c.id !== id) return c;
        const next: AgentConversation = {
          ...c,
          messages: c.messages.slice(0, idx),
          sessionId: null,
          resumeToken: undefined,
          status: "idle",
          updatedAt: Date.now(),
        };
        updated = next;
        return next;
      }),
    }));
    if (updated) scheduleSave(updated);
    // Fork wipes parked prompts and transient stream state — also wipes any
    // linked task approval since the Review queue would otherwise hang on a
    // turn we just truncated away from. clearConversation on the approval
    // store handles maybeResolveTaskApproval internally.
    useAgentApprovalStore.getState().clearConversation(id);
    useAgentStreamingStore.getState().clearThinking(id);
    // The plan substore holds post-restore-point state (TodoWrite checklist,
    // planApproved) that would otherwise survive the rewind as a stale
    // phantom over the truncated transcript. Clear it — PlanPanel falls back
    // to re-deriving any plan still present in the kept prefix from its
    // tool calls.
    useAgentPlanStore.getState().clearConversation(id);

    // Send the edited content as the next user turn — sendMessage handles
    // session re-establishment for api-mode conversations that lost their
    // live session.
    await get().sendMessage(id, text);
  },

  retryLastTurn: async (id, newModel) => {
    // Truncate messages locally: drop the last assistant message (and any trailing tool outputs).
    const retryMsgId = generateId("msg");
    let updated: AgentConversation | undefined;
    set((s) => ({
      conversations: s.conversations.map((c) => {
        if (c.id !== id) return c;
        const msgs = c.messages.slice();
        // Find last assistant index (from end) and truncate — but preserve any
        // trailing system messages (e.g. the auto-failover notice the error
        // listener appends after the failed assistant). `msgs.length = i` would
        // otherwise drop them along with the assistant.
        const trailingSystem: AgentMessage[] = [];
        for (let i = msgs.length - 1; i >= 0; i--) {
          if (msgs[i].role === "assistant") {
            msgs.length = i;
            break;
          }
          if (msgs[i].role === "system") trailingSystem.unshift(msgs[i]);
        }
        // Re-append the preserved system notice(s) so the user still sees the
        // failover happened, then a fresh streaming assistant shell.
        for (const sys of trailingSystem) msgs.push(sys);
        msgs.push({
          id: retryMsgId,
          role: "assistant",
          content: "",
          timestamp: Date.now(),
          isStreaming: true,
        });
        const next = {
          ...c,
          messages: msgs,
          status: "active" as const,
          model: newModel ?? c.model,
          updatedAt: Date.now(),
        };
        updated = next;
        return next;
      }),
    }));
    // Reset transient streaming state — a retry restarts the turn.
    useAgentStreamingStore.getState().clearThinking(id);
    try {
      await tauriRetryLastTurn(id, newModel);
    } catch (e) {
      // The backend rejected the retry start (rate limit, session gone,
      // sidecar down) — so no `api-agent:done`/`error` event will ever
      // arrive to clear the streaming shell we just pushed. failTurn fails
      // the conversation and clears that specific shell.
      failTurn(id, retryMsgId, e);
      return;
    }
    if (updated) scheduleSave(updated);
  },

  exportConversation: async (id) => {
    const conv = get().conversations.find((c) => c.id === id);
    if (!conv) return "";
    return await exportConversationMarkdown(
      conv.title,
      conv.model ?? "unknown",
      JSON.stringify(conv.messages),
    );
  },

  appendRawOutput: (conversationId, text) => {
    set((s) => ({
      conversations: s.conversations.map((c) => {
        if (c.id !== conversationId) return c;
        const newOutput = c.rawOutput + text;
        return {
          ...c,
          rawOutput:
            newOutput.length > MAX_RAW_OUTPUT_SIZE
              ? newOutput.slice(-MAX_RAW_OUTPUT_SIZE)
              : newOutput,
          updatedAt: Date.now(),
        };
      }),
    }));
  },

  /**
   * F1 — re-establish a hydrated conversation. Run when sendMessage is
   * called on an api-mode conversation that's been deserialized from disk
   * but has no live event listeners. Re-attaches the listener block then
   * calls `start_api_agent_session` with the conversation's resumeToken
   * (if any) and `content` as the initial message.
   *
   * Routes around `sendApiAgentMessage` because the Rust side has no
   * record of the session id — calling send before start would 404.
   */
  resumeApiConversation: async (conversationId, content, attachments) => {
    const conv = get().conversations.find((c) => c.id === conversationId);
    if (!conv || conv.mode !== "api" || !conv.provider || !conv.model) return;
    // Retired-provider guard. The hydrate-then-send path lands here first, so
    // this is the guard a restarted app actually hits for a stored Codex
    // conversation.
    if (isRetiredApiAgent(conv.agent)) {
      appendRetiredAgentNotice(conversationId, conv.agent);
      return;
    }
    // Belt-and-braces re-entry guard; sendMessage already routes around an
    // in-flight resume via apiResumeInFlight, but direct callers must not
    // be able to double-start the backend session either. The add happens
    // in this synchronous prefix (before any await) so no interleaving can
    // observe the flag unset mid-resume.
    if (apiResumeInFlight.has(conversationId)) return;
    apiResumeInFlight.add(conversationId);

    failoverGuard.delete(conversationId);

    // Append the user message + a streaming assistant placeholder so the
    // chat UI doesn't go blank between resume click and first chunk.
    const userMsg: AgentMessage = {
      id: generateId("msg"),
      role: "user",
      content,
      timestamp: Date.now(),
    };
    userMsg.provenance = userIntentProvenance(userMsg.id, userMsg.timestamp);
    userMsg.evidence = attachments?.length
      ? attachmentProvenance(userMsg.id, attachments, userMsg.timestamp)
      : undefined;
    const assistantMsgId = generateId("msg");
    let updated: AgentConversation | undefined;
    set((s) => ({
      conversations: s.conversations.map((c) => {
        if (c.id !== conversationId) return c;
        const next: AgentConversation = {
          ...c,
          messages: [
            ...c.messages,
            userMsg,
            {
              id: assistantMsgId,
              role: "assistant",
              content: "",
              timestamp: Date.now(),
              isStreaming: true,
            },
          ],
          status: "active",
          updatedAt: Date.now(),
        };
        updated = next;
        return next;
      }),
    }));
    if (updated) scheduleSave(updated);

    try {
      await ensureApiAgentListeners(conversationId);
      const resumeMessages = buildConversationResumeMessages(conv.messages);

      // S5: resolve the live ServerConfig from `serverStore` for the full
      // connection identity — host, user, port, keyPath, authMethod, and the
      // pinned host fingerprint — so a server renamed or repointed since the
      // conversation was created resumes to the right host, not the stale copy
      // frozen into the conversation. `remote_path` stays the conversation's own
      // working directory. See `buildResumeSshConfig` for the full contract.
      let sshConfig: ResumeSshConfig | null = null;
      if (conv.sshTarget) {
        const { useServerStore } = await import("@/stores/serverStore");
        const server = useServerStore.getState().getServer(conv.sshTarget.id);
        sshConfig = buildResumeSshConfig(conv.sshTarget, server);
      }
      let frozenMcpTrust = conv.mcpTrustSnapshot;
      if (frozenMcpTrust === undefined) {
        frozenMcpTrust = await captureMcpTrustSnapshot(
          conv.projectPath,
          conv.enabledMcpServerIds ?? null,
          Boolean(conv.sshTarget),
        );
        if (frozenMcpTrust !== undefined) {
          set((state) => ({
            conversations: state.conversations.map((candidate) =>
              candidate.id === conversationId
                ? { ...candidate, mcpTrustSnapshot: frozenMcpTrust }
                : candidate,
            ),
          }));
          const persisted = get().conversations.find(
            (candidate) => candidate.id === conversationId,
          );
          if (persisted) scheduleSave(persisted);
        }
      }

      await startApiAgentSession(
        conversationId,
        conv.provider,
        conv.model,
        conv.projectPath,
        content,
        // M1(c): resends replay the FROZEN system prompt captured at session
        // creation — the memory brief + AGENTS.md that were composed once in
        // createApiConversation and baked into `systemPromptOverride`. This is
        // intentional: memory is injected at session start only and is NOT
        // recomposed per resume, so a mid-session memory edit won't retro-apply.
        // The MemoryInjectionCard / HeaderOverflowMenu "injected at session
        // start" disclosure reflects exactly this behavior.
        conv.systemPromptOverride ?? null,
        conv.thinkingEnabled ?? false,
        attachments ?? undefined,
        conv.planMode ?? false,
        sshConfig,
        conv.allowedTools ?? null,
        conv.resumeToken ?? null,
        conv.enabledMcpServerIds ?? null,
        resumeMessages,
        conv.permissionMode ?? "ask_for_risky",
        conv.approveWrites ?? false,
        null, // commandPath — no surviving sidecar provider is CLI-backed
        undefined,
        frozenMcpTrust,
      );
    } catch (e) {
      console.warn("resumeApiConversation failed:", e);
      // Clear the streaming placeholder we appended above — no `api-agent:*`
      // event will arrive, so without this the assistant bubble spins forever.
      failTurn(conversationId, assistantMsgId, e);
      // Same session-loss recovery as sendMessage's catch: if the backend
      // rejected because it has no session under this id, drop the listener
      // block (ensureApiAgentListeners above may have registered it before
      // startApiAgentSession failed) so the next send re-routes through this
      // resume path instead of dying once more on the plain-send path.
      if (String(e).includes("No active session")) {
        releaseApiConversationListeners(conversationId);
      }
    } finally {
      apiResumeInFlight.delete(conversationId);
    }
  },

  prepareMcpReconnect: async (conversationId) => {
    const conversation = get().conversations.find((candidate) => candidate.id === conversationId);
    if (!conversation || conversation.mode !== "api") {
      throw new Error("Select an API conversation to reconnect MCP authority.");
    }
    if (conversation.messages.some((message) => message.isStreaming)) {
      throw new Error("Wait for or cancel the active turn before reconnecting MCP.");
    }
    await closeApiAgentSession(conversationId);
    const cleanup = apiConversationCleanup.get(conversationId);
    cleanup?.();
    apiConversationCleanup.delete(conversationId);

    let updated: AgentConversation | undefined;
    set((state) => ({
      conversations: state.conversations.map((candidate) => {
        if (candidate.id !== conversationId) return candidate;
        const next: AgentConversation = {
          ...candidate,
          status: "idle",
          mcpTrustSnapshot: undefined,
          updatedAt: Date.now(),
        };
        updated = next;
        return next;
      }),
    }));
    if (updated) scheduleSave(updated);
  },
}));
