import { listen } from "@tauri-apps/api/event";
import {
  apiAgentChunkEvent,
  apiAgentToolStartEvent,
  apiAgentToolResultEvent,
  apiAgentDoneEvent,
  apiAgentErrorEvent,
  apiAgentThinkingEvent,
  apiAgentThinkingStopEvent,
  apiAgentPermissionRequestEvent,
  apiAgentPendingEditEvent,
  apiAgentEditBaselineEvent,
  apiAgentPlanBlockEvent,
  apiAgentToolOutputExtendedEvent,
  apiAgentTurnSummaryEvent,
  apiAgentMcpSourcesEvent,
} from "@/lib/events";
import { generateId } from "@/lib/storage";
import { toProjectRelativePath } from "@/lib/parseToolInput";
import { classifyToolTier, decideApprovalGate } from "@/lib/approvalTiers";
// Pure util module (no React) — deriveMode is P0-4's one bijection over the
// conversation's permission flags and stays the single source of truth for
// what posture a session is in.
import { deriveMode } from "@/components/agents/agentModeChipUtils";
import { createStreamCoalescer } from "@/lib/streamCoalescer";
import { sendApiAgentMessage } from "@/lib/tauri";
import { estimateTurnCostUsd } from "@/lib/conversationCost";
import {
  assistantDerivativeProvenance,
  activeTurnEvidence,
  derivedArtifactProvenance,
  provenanceNeedsRiskGate,
  safeToolLocator,
  taintingEvidence,
  toolResultProvenance,
} from "@/lib/provenance";
import {
  isAccountLevelExhaustion,
  looksLikeRateLimit,
  pickFailoverModel,
} from "@/lib/autoFailover";
import { capabilitiesFor } from "@/lib/agentCapabilities";
import { useLiveModelStore } from "@/stores/liveModelStore";
import {
  notifySessionComplete,
  notifySessionError,
  notifyApprovalNeeded,
} from "@/lib/notifications";
import { useAgentSettingsStore } from "@/stores/agentSettingsStore";
import { useAgentApprovalStore } from "@/stores/agentApprovalStore";
import { useEditBaselineStore } from "@/stores/editBaselineStore";
import { useAgentPlanStore } from "@/stores/agentPlanStore";
import { useAgentStreamingStore } from "@/stores/agentStreamingStore";
import { auditSourceChain, useProvenanceAuditStore } from "@/stores/provenanceAuditStore";
import {
  useAgentTaskStore,
  requestConversationSave,
  failoverGuard,
  failTurn,
  releaseApiConversationListeners,
  runBudgetedApiTurn,
} from "@/stores/agentTaskStore";
import type {
  AgentConversation,
  AgentMessage,
  AgentPlanItem,
  AgentToolCall,
  PendingPermission,
  PendingEdit,
} from "@/types/agent-conversation";

// S8-Phase-B: prefix marking the `role:"system"` notice appended when the
// remote sidecar reports MCP config read errors. Used both to build the notice
// and to dedup prior copies before re-appending (mcp_sources re-fires on every
// session (re)start), so a broken remote config never stacks duplicates.
const REMOTE_MCP_NOTICE_PREFIX = "(remote MCP:";

type ToolResultEventPayload = {
  id: string;
  name: string;
  content: string;
  is_error: boolean;
  input: string;
};

function applyToolResult(
  messages: AgentMessage[],
  payload: ToolResultEventPayload,
  projectPath?: string,
  remote = false,
): AgentMessage[] {
  let targetIndex = -1;
  for (let index = messages.length - 1; index >= 0; index--) {
    if (messages[index].toolCalls?.some((tool) => tool.id === payload.id)) {
      targetIndex = index;
      break;
    }
  }
  if (targetIndex === -1) {
    for (let index = messages.length - 1; index >= 0; index--) {
      if (messages[index].role === "assistant") {
        targetIndex = index;
        break;
      }
    }
  }
  if (targetIndex === -1) return messages;

  return messages.map((message, index) => {
    if (index !== targetIndex) return message;
    const existing = message.toolCalls ?? [];
    const result = {
      id: payload.id,
      name: payload.name,
      status: (payload.is_error ? "error" : "done") as AgentToolCall["status"],
      summary: payload.content.slice(0, 200),
      fullContent: payload.content,
      input: payload.input || undefined,
      provenance: toolResultProvenance({
        toolId: payload.id,
        name: payload.name,
        input: payload.input,
        content: payload.content,
        projectPath,
        remote,
      }),
    };
    const matching = existing.findIndex((tool) => tool.id === payload.id);
    const toolCalls =
      matching >= 0
        ? existing.map((tool, toolIndex) =>
            toolIndex === matching
              ? {
                  ...tool,
                  ...result,
                  name: payload.name || tool.name,
                  input: payload.input || tool.input,
                }
              : tool,
          )
        : [...existing, result];
    return { ...message, toolCalls };
  });
}

function sendPromotedQueuedMessage(
  conversationId: string,
  content: string,
  afterMessageId: string,
): void {
  const setState = useAgentTaskStore.setState;
  const getState = useAgentTaskStore.getState;
  if (!getState().conversations.some((c) => c.id === conversationId)) return;

  failoverGuard.delete(conversationId);

  const assistantMsg: AgentMessage = {
    id: generateId("msg"),
    role: "assistant",
    content: "",
    timestamp: Date.now(),
    isStreaming: true,
  };

  let updated = false;
  setState((s) => ({
    conversations: s.conversations.map((c) => {
      if (c.id !== conversationId) return c;
      let inserted = false;
      const messages: AgentMessage[] = [];
      for (const message of c.messages) {
        messages.push(message);
        if (!inserted && message.id === afterMessageId) {
          messages.push(assistantMsg);
          inserted = true;
        }
      }
      if (!inserted) messages.push(assistantMsg);
      updated = true;
      return {
        ...c,
        messages,
        status: "active",
        updatedAt: Date.now(),
      };
    }),
  }));
  if (updated) requestConversationSave(conversationId);

  const conversation = getState().conversations.find((c) => c.id === conversationId);
  if (!conversation) return;
  void runBudgetedApiTurn(conversation, (dispatch) => dispatch(() =>
    sendApiAgentMessage(conversationId, content, undefined),
  )).catch((err) => {
    // failTurn also clears the streaming placeholder we just inserted —
    // previously this only flipped status to "failed", leaving the assistant
    // bubble spinning forever.
    failTurn(conversationId, assistantMsg.id, err);
    // Same session-loss recovery as sendMessage's catch: "No active session"
    // means the backend has no record of this id, so drop the listener block
    // and let the next send route through resumeApiConversation (F1) instead
    // of failing once more on the dead plain-send path.
    if (String(err).includes("No active session")) {
      releaseApiConversationListeners(conversationId);
    }
  });
}

/**
 * Install the full set of `api-agent:*` event listeners for a session.
 * Returns an unlisten function that detaches every listener registered here.
 *
 * The cleanup map (`apiConversationCleanup`) and its semantics live in
 * `agentTaskStore` — this module is purely the listener wiring. Idempotency
 * is enforced by the caller, which only invokes this once per conversation
 * and stores the returned unlisten fn in that map.
 *
 * Both backends (in-process `LlmProvider` + Node sidecar) emit the same
 * `api-agent:{kind}:{sessionId}` events, so this single handler set covers
 * every provider.
 */
export async function installApiAgentListeners(conversationId: string): Promise<() => void> {
  const id = conversationId;
  const setState = useAgentTaskStore.setState;
  const getState = useAgentTaskStore.getState;

  // rAF-coalesced application of streaming deltas. Token/thinking events can
  // arrive dozens of times per second, and writing the store per event
  // rebuilt the conversations array (and re-ran every subscribed selector)
  // once per token. Buffer the deltas and land at most one store write + one
  // save request per frame, replacing only this conversation's entry instead
  // of remapping the whole array. done/error/thinking-stop call `flushNow()`
  // first so a settling turn never loses or reorders tail chunks.
  const coalescer = createStreamCoalescer(({ content, thinking }) => {
    if (thinking) {
      useAgentStreamingStore.getState().appendThinking(id, thinking);
    }
    const conversations = getState().conversations;
    const index = conversations.findIndex((c) => c.id === id);
    if (index === -1) return;
    const conv = conversations[index];
    let touched = false;
    const messages = conv.messages.map((m) => {
      if (m.isStreaming && m.role === "assistant") {
        touched = true;
        return {
          ...m,
          content: content ? m.content + content : m.content,
          thinking: thinking ? (m.thinking ?? "") + thinking : m.thinking,
        };
      }
      return m;
    });
    if (!touched) return;
    const next = [...conversations];
    next[index] = { ...conv, messages, updatedAt: Date.now() };
    setState({ conversations: next });
    requestConversationSave(id);
  });

  const chunkUnlisten = await listen<string>(apiAgentChunkEvent(id), (event) => {
    coalescer.pushContent(event.payload);
  });

  // `input` (raw tool-input JSON) arrives with tool_start on the sidecar
  // path (Claude Code / Codex forward it at tool_use time) and with
  // tool_result on the in-process path. Stash whichever arrives so the
  // transcript edit layer can parse Write/Edit/apply_patch calls.
  const toolStartUnlisten = await listen<{
    id: string;
    name: string;
    input?: string | null;
  }>(apiAgentToolStartEvent(id), (event) => {
    let touched = false;
    setState((s) => ({
      conversations: s.conversations.map((c) => {
        if (c.id !== id) return c;
        const messages = c.messages.map((m) => {
          if (m.isStreaming && m.role === "assistant") {
            const toolCalls: AgentToolCall[] = [
              ...(m.toolCalls ?? []),
              {
                id: event.payload.id,
                name: event.payload.name,
                status: "running" as const,
                input: event.payload.input ?? undefined,
                provenance: toolResultProvenance({
                  toolId: event.payload.id,
                  name: event.payload.name,
                  input: event.payload.input ?? undefined,
                  projectPath: c.projectPath,
                  remote: Boolean(c.sshTarget),
                }),
              },
            ];
            return { ...m, toolCalls };
          }
          return m;
        });
        touched = true;
        return { ...c, messages, updatedAt: Date.now() };
      }),
    }));
    if (touched) requestConversationSave(id);
  });

  const toolResultUnlisten = await listen<ToolResultEventPayload>(
    apiAgentToolResultEvent(id),
    (event) => {
      let touched = false;
      setState((s) => ({
        conversations: s.conversations.map((c) => {
          if (c.id !== id) return c;
          const messages = applyToolResult(
            c.messages,
            event.payload,
            c.projectPath,
            Boolean(c.sshTarget),
          );
          touched = true;
          return { ...c, messages, updatedAt: Date.now() };
        }),
      }));
      if (touched) requestConversationSave(id);
    },
  );

  const doneUnlisten = await listen<{
    input_tokens: number;
    output_tokens: number;
    cache_read_input_tokens: number;
    cache_creation_input_tokens: number;
    resume_token?: string | null;
    cancelled?: boolean;
  }>(apiAgentDoneEvent(id), (event) => {
    // Land any buffered stream deltas before flipping isStreaming off —
    // otherwise the pending frame would find no streaming message and the
    // turn's tail chunks would be lost.
    coalescer.flushNow();
    let updated: AgentConversation | undefined;
    let nextQueued: string | undefined;
    let promotedQueuedMessageId: string | undefined;
    setState((s) => {
      const cancellingConversationIds = new Set(s.cancellingConversationIds);
      cancellingConversationIds.delete(id);
      return {
        cancellingConversationIds,
        conversations: s.conversations.map((c) => {
          if (c.id !== id) return c;
          const messages = c.messages.map((m) => {
            if (!m.isStreaming) return m;
            const settled: AgentMessage = {
              ...m,
              isStreaming: false,
              inputTokens: event.payload.input_tokens,
              outputTokens: event.payload.output_tokens,
              cacheReadTokens: event.payload.cache_read_input_tokens,
              cacheWriteTokens: event.payload.cache_creation_input_tokens,
              // Stamp the estimated USD cost at receipt time so render
              // surfaces never need per-message IPC (undefined when the
              // model has no pricing entry). Reasoning tokens landed on
              // the message via earlier turn-summary events.
              costUsd:
                estimateTurnCostUsd(c.model, {
                  inputTokens: event.payload.input_tokens,
                  outputTokens: event.payload.output_tokens,
                  cacheReadTokens: event.payload.cache_read_input_tokens,
                  cacheWriteTokens: event.payload.cache_creation_input_tokens,
                  reasoningTokens: m.reasoningTokens,
                }) ?? undefined,
            };
            settled.provenance = assistantDerivativeProvenance(settled, activeTurnEvidence(c));
            return settled;
          });
          const queued = c.queuedMessages ?? [];
          let remainingQueued = queued;
          const shouldDrainQueued = !event.payload.cancelled && queued.length > 0;
          if (shouldDrainQueued) {
            nextQueued = queued[0];
            remainingQueued = queued.slice(1);
          } else if (event.payload.cancelled) {
            // Cancelled turn: never auto-send a message the user queued behind
            // a turn they just killed. Mirror cancelActiveConversation (G33):
            // clear the queue and drop `queued:true` bubbles so none stick.
            remainingQueued = [];
          }
          let promotedDrainingBubble = false;
          const visibleMessages = shouldDrainQueued
            ? messages.map((m) => {
                if (!promotedDrainingBubble && m.queued) {
                  promotedDrainingBubble = true;
                  promotedQueuedMessageId = m.id;
                  return { ...m, queued: undefined };
                }
                return m;
              })
            : event.payload.cancelled
              ? messages.filter((m) => !m.queued)
              : messages;
          const newResume = event.payload.resume_token ?? c.resumeToken;
          const next: AgentConversation = {
            ...c,
            messages: visibleMessages,
            status: "idle",
            updatedAt: Date.now(),
            queuedMessages: remainingQueued,
            resumeToken: newResume ?? undefined,
          };
          updated = next;
          return next;
        }),
      };
    });
    if (updated) requestConversationSave(id);
    // Turn done — reset transient streaming state. Reasoning text already
    // landed on the assistant message; the live delta buffer is now stale.
    useAgentStreamingStore.getState().clearThinking(id);
    if (nextQueued !== undefined) {
      const drained = nextQueued;
      const afterMessageId = promotedQueuedMessageId;
      setTimeout(() => {
        if (afterMessageId) {
          sendPromotedQueuedMessage(id, drained, afterMessageId);
        } else {
          getState().sendMessage(id, drained);
        }
      }, 0);
    }
    if (!event.payload.cancelled && updated && getState().selectedConversationId !== id) {
      // Route through the pref-gated helper so desktop notifications honor the
      // user's notificationStore settings (enabled / onlyWhenUnfocused /
      // onSessionComplete / per-session debounce) instead of bypassing them.
      void notifySessionComplete(id, updated.title);
    }
  });

  const errorUnlisten = await listen<{ message: string }>(apiAgentErrorEvent(id), (event) => {
    // Same as `done`: buffered deltas must land while the message is still
    // streaming, and before any failover retry forks the transcript.
    coalescer.flushNow();
    const conv = getState().conversations.find((c) => c.id === id);
    if (
      conv &&
      conv.mode === "api" &&
      conv.model &&
      useAgentSettingsStore.getState().autoFailoverEnabled &&
      !getState().cancellingConversationIds.has(id) &&
      !failoverGuard.has(id) &&
      looksLikeRateLimit(event.payload.message) &&
      // A drained quota / credit balance is an ACCOUNT-level wall: every model
      // the session's provider can reach shares it, and `retryLastTurn` can
      // only swap the model, never the provider. Retrying would burn a request
      // and show a "retrying on X" notice for a retry that cannot succeed.
      !isAccountLevelExhaustion(event.payload.message)
    ) {
      // Hand the failover ladder the models this session can ACTUALLY reach —
      // an engine's own enumeration or a live provider list — instead of
      // letting it scan the bundled catalog for a row containing `conv.model`.
      // That scan returned null for any model the bundle had never heard of,
      // which silently disabled failover at the one moment it exists for.
      // Reading the store here is fine: this is an event handler, not render.
      const sessionModels = capabilitiesFor(
        conv,
        useLiveModelStore.getState().answerFor(conv.agent),
      ).models.map((m) => m.value);
      const fallback = pickFailoverModel(conv.model, sessionModels);
      if (fallback && fallback !== conv.model) {
        failoverGuard.add(id);
        const noticeMsg: AgentMessage = {
          id: generateId("msg"),
          role: "system",
          content: `(auto-failover: ${conv.model} hit "${event.payload.message.slice(0, 80)}" — retrying on ${fallback})`,
          timestamp: Date.now(),
        };
        setState((s) => ({
          conversations: s.conversations.map((c) =>
            c.id === id
              ? {
                  ...c,
                  messages: [...c.messages, noticeMsg],
                  updatedAt: Date.now(),
                }
              : c,
          ),
        }));
        void getState().retryLastTurn(id, fallback);
        return;
      }
    }

    let updated: AgentConversation | undefined;
    setState((s) => {
      const cancellingConversationIds = new Set(s.cancellingConversationIds);
      cancellingConversationIds.delete(id);
      return {
        cancellingConversationIds,
        conversations: s.conversations.map((c) => {
          if (c.id !== id) return c;
          const messages = c.messages.map((m) =>
            m.isStreaming
              ? {
                  ...m,
                  isStreaming: false,
                  content: m.content + `\n\nError: ${event.payload.message}`,
                }
              : m,
          );
          const next = {
            ...c,
            messages,
            status: "failed" as const,
            updatedAt: Date.now(),
          };
          updated = next;
          return next;
        }),
      };
    });
    if (updated) requestConversationSave(id);
    if (updated) {
      // Pref-gated error notification (honors onSessionError + debounce).
      void notifySessionError(id, updated.title);
    }

    // Session-loss sentinels from the Rust sidecar supervisor: the crash
    // fan-out (supervisor.rs SIDECAR_RESTART_RECOVERABLE_ERROR), the
    // restart-loop give-up message, and the per-session SSH sidecar exit
    // handler. In all cases the supervisor has cleared session ownership,
    // so a resend via send_api_agent_message can only 404 with "No active
    // session". Release the listener block (deferred past this event
    // dispatch) so the next sendMessage takes the F1 resume path and
    // re-creates the session — making "please resend your message" true.
    // Keep these substrings in sync with
    // src-tauri/src/commands/agent_sidecar/supervisor.rs.
    //
    // Intentionally NOT in this set: the SSH spawn failure ("Failed to
    // spawn SSH sidecar for ...", supervisor.rs). It surfaces only as a
    // start_session command rejection — never as an api-agent:error event
    // — so it is handled by the send/resume catches' "No active session"
    // recovery, not here.
    const msg = event.payload.message;
    const sessionLost =
      msg.includes("Sidecar restarted") ||
      msg.includes("Sidecar crashed and could not restart") ||
      /^SSH sidecar for .+ (exited|wait failed)/.test(msg);
    if (sessionLost) {
      setTimeout(() => releaseApiConversationListeners(id), 0);
    }
  });

  const thinkingUnlisten = await listen<{ text: string }>(apiAgentThinkingEvent(id), (event) => {
    // Reasoning deltas accumulate in agentStreamingStore (ephemeral) and
    // mirror onto the streaming assistant message's `thinking` field so the
    // persisted transcript keeps the full chain of thought — both applied
    // per-frame by the coalescer above.
    coalescer.pushThinking(event.payload.text);
  });

  const thinkingStopUnlisten = await listen<unknown>(apiAgentThinkingStopEvent(id), () => {
    // Flush so the final buffered reasoning deltas land on the message (and
    // in the live store) before the live buffer is cleared.
    coalescer.flushNow();
    useAgentStreamingStore.getState().clearThinking(id);
  });

  const permissionReqUnlisten = await listen<PendingPermission>(
    apiAgentPermissionRequestEvent(id),
    (event) => {
      // Gate on conversation existence: if the conversation was deleted
      // mid-flight, dropping the prompt and skipping the task wake-up is
      // the right behavior. agentApprovalStore.addPendingPermission also
      // fires the orchestrator `approval_needed` flip internally.
      const conv = getState().conversations.find((c) => c.id === id);
      if (!conv) return;
      // P1-9 tiered gating: read/search tools never prompt; in-project
      // edits auto-apply into the post-hoc review bar (baselines from
      // P1-7, surface from P1-8). Only shell/network/out-of-project
      // requests fall through to a blocking prompt. The mode chip rules:
      // tiering applies under Default/yolo, reads-only under manual, and
      // plan / deny-risky postures keep every prompt.
      const tier = classifyToolTier(event.payload.name, event.payload.arguments, conv.projectPath);
      const sourceChain = taintingEvidence(conv);
      const provenanceGate = provenanceNeedsRiskGate(conv, tier);
      if (decideApprovalGate(deriveMode(conv), tier) === "auto_allow" && !provenanceGate) {
        useProvenanceAuditStore.getState().record({
          conversationId: id,
          toolId: event.payload.id,
          action: event.payload.name,
          target: safeToolLocator(event.payload.name, event.payload.arguments, conv.projectPath),
          decision: "auto_allowed",
          effectivePolicy: deriveMode(conv),
          sourceChain: auditSourceChain(sourceChain),
        });
        void useAgentApprovalStore.getState().autoAllowPermission(id, event.payload.id);
        return;
      }
      const pendingPermission: PendingPermission = {
        ...event.payload,
        sourceChain,
        safeTarget: safeToolLocator(event.payload.name, event.payload.arguments, conv.projectPath),
        effectivePolicy: provenanceGate
          ? `${deriveMode(conv)} + evidence boundary`
          : deriveMode(conv),
      };
      useAgentApprovalStore.getState().addPendingPermission(id, pendingPermission);
      useProvenanceAuditStore.getState().record({
        conversationId: id,
        toolId: event.payload.id,
        action: event.payload.name,
        target: safeToolLocator(event.payload.name, event.payload.arguments, conv.projectPath),
        decision: "prompted",
        effectivePolicy: pendingPermission.effectivePolicy ?? deriveMode(conv),
        sourceChain: auditSourceChain(sourceChain),
      });
      // Long autonomous runs pause here for approval — ping the user (pref-gated
      // + per-session debounced) so they know an unattended run needs them.
      void notifyApprovalNeeded(id, conv.title);
    },
  );

  const pendingEditUnlisten = await listen<PendingEdit>(apiAgentPendingEditEvent(id), (event) => {
    const conv = getState().conversations.find((c) => c.id === id);
    if (!conv) return;
    // Gated writes carry their pre-edit baseline on `before` — record it so
    // review surfaces diff against the true "before" after the edit applies.
    // Both the baseline key AND the stored pending edit are keyed project-
    // relative: the runtimes emit raw tool paths (absolute for Claude Code /
    // Codex), while the transcript edit layer keys descriptors project-
    // relative — the review surface dedupes, deep-links and displays pending
    // edits against those keys, so a raw absolute path would render the same
    // file twice and double-count it.
    const relativePath = toProjectRelativePath(event.payload.path, conv.projectPath);
    useEditBaselineStore
      .getState()
      .recordBaseline(id, relativePath, event.payload.before ?? null, event.payload.id);
    const parents = taintingEvidence(conv);
    useAgentApprovalStore.getState().addPendingEdit(id, {
      ...event.payload,
      path: relativePath,
      provenance: derivedArtifactProvenance(
        event.payload.id,
        `Proposed edit · ${relativePath}`,
        parents,
      ),
    });
    void notifyApprovalNeeded(id, conv.title);
  });

  // P1-7: non-blocking baseline capture for auto-applied writes (approve-
  // writes off). Every edit-bearing tool call stores the pre-edit file
  // content; `before` is null/absent when the file did not exist. Keys are
  // project-relative to match the canonical edit descriptors.
  const editBaselineUnlisten = await listen<{
    id: string;
    path: string;
    before?: string | null;
  }>(apiAgentEditBaselineEvent(id), (event) => {
    const conv = getState().conversations.find((c) => c.id === id);
    if (!conv) return;
    useEditBaselineStore
      .getState()
      .recordBaseline(
        id,
        toProjectRelativePath(event.payload.path, conv.projectPath),
        event.payload.before ?? null,
        event.payload.id,
      );
  });

  const planBlockUnlisten = await listen<{ items: AgentPlanItem[] }>(
    apiAgentPlanBlockEvent(id),
    (event) => {
      // setPlan now requests its own conversation save (snapshotForPersist
      // reads the plan back out of agentPlanStore), so no extra save here.
      useAgentPlanStore.getState().setPlan(id, event.payload.items);
    },
  );

  // F6: live token totals between turns. Update the streaming assistant
  // message's tokens so the per-turn token pill reflects mid-stream usage
  // instead of waiting for the final `done` payload. A2: also forward
  // `reasoning_tokens` (Codex 0.125+) so the guardrail rollup accounts for
  // GPT-5.5's reasoning slice. A3: when `address` is set (Codex
  // MultiAgentV2 sub-agent), accumulate into a per-address bucket on
  // the conversation INSTEAD of mutating the streaming message — the
  // root thread's tokens belong to the user-visible turn; sub-agent
  // tokens are included in the token readout via aggregateConversationTokens.
  const turnSummaryUnlisten = await listen<{
    input_tokens: number;
    output_tokens: number;
    cache_read_input_tokens: number;
    cache_creation_input_tokens: number;
    reasoning_tokens?: number | null;
    address?: string | null;
  }>(apiAgentTurnSummaryEvent(id), (event) => {
    const address = event.payload.address ?? "";
    if (address.length > 0) {
      // Sub-agent: replace the bucket in agentStreamingStore (Codex emits
      // cumulative totals). conversationCost.ts reads from the store.
      useAgentStreamingStore.getState().setSubAgentBucket(id, address, {
        inputTokens: event.payload.input_tokens,
        outputTokens: event.payload.output_tokens,
        reasoningTokens: event.payload.reasoning_tokens ?? 0,
        cacheReadTokens: event.payload.cache_read_input_tokens,
      });
      return;
    }
    // Root thread: mutate the streaming message as before.
    let touched = false;
    setState((s) => ({
      conversations: s.conversations.map((c) => {
        if (c.id !== id) return c;
        const messages = c.messages.map((m) =>
          m.isStreaming && m.role === "assistant"
            ? {
                ...m,
                inputTokens: event.payload.input_tokens,
                outputTokens: event.payload.output_tokens,
                cacheReadTokens: event.payload.cache_read_input_tokens,
                cacheWriteTokens: event.payload.cache_creation_input_tokens,
                reasoningTokens: event.payload.reasoning_tokens ?? m.reasoningTokens,
                costUsd:
                  estimateTurnCostUsd(c.model, {
                    inputTokens: event.payload.input_tokens,
                    outputTokens: event.payload.output_tokens,
                    cacheReadTokens: event.payload.cache_read_input_tokens,
                    cacheWriteTokens: event.payload.cache_creation_input_tokens,
                    reasoningTokens: event.payload.reasoning_tokens ?? m.reasoningTokens,
                  }) ?? undefined,
              }
            : m,
        );
        touched = true;
        return { ...c, messages, updatedAt: Date.now() };
      }),
    }));
    if (touched) requestConversationSave(id);
  });

  // F5: structured tool metadata — exit code / modified paths / stdout /
  // stderr — arrives after the matching tool_result. Merge into the
  // already-rendered tool call so the chat surface can show exit code etc.
  const toolOutputExtendedUnlisten = await listen<{
    id: string;
    exit_code?: number | null;
    modified_paths?: string[] | null;
    stdout?: string | null;
    stderr?: string | null;
  }>(apiAgentToolOutputExtendedEvent(id), (event) => {
    let touched = false;
    setState((s) => ({
      conversations: s.conversations.map((c) => {
        if (c.id !== id) return c;
        const messages = c.messages.map((m) => {
          if (!m.toolCalls) return m;
          let mutated = false;
          const toolCalls = m.toolCalls.map((tc) => {
            if (tc.id !== event.payload.id) return tc;
            mutated = true;
            return {
              ...tc,
              exitCode: event.payload.exit_code ?? tc.exitCode,
              modifiedPaths: event.payload.modified_paths ?? tc.modifiedPaths,
              stdout: event.payload.stdout ?? tc.stdout,
              stderr: event.payload.stderr ?? tc.stderr,
            };
          });
          return mutated ? { ...m, toolCalls } : m;
        });
        touched = true;
        return { ...c, messages, updatedAt: Date.now() };
      }),
    }));
    if (touched) requestConversationSave(id);
  });

  // S8-Phase-B (Slice B): the remote sidecar reports which MCP servers it
  // sourced from its OWN filesystem (name/transport/scope only — never
  // commands or secrets), plus any read/parse errors. Stamp the summary onto
  // the conversation so the SessionMetaLine pill can surface it, and — when
  // any source failed to load — append a one-time system notice naming the
  // failing paths (mirrors the auto-failover notice pattern above) so the
  // silent backend warn is replaced by a visible signal.
  const mcpSourcesUnlisten = await listen<{
    sources: { name: string; transport: "stdio" | "http" | "sse"; scope: "global" | "project" }[];
    readErrors: { scope: "global" | "project"; path: string; message: string }[];
  }>(apiAgentMcpSourcesEvent(id), (event) => {
    const sources = event.payload.sources ?? [];
    const readErrors = event.payload.readErrors ?? [];
    const noticeMsg: AgentMessage | null =
      readErrors.length > 0
        ? {
            id: generateId("msg"),
            role: "system",
            content: `${REMOTE_MCP_NOTICE_PREFIX} loaded ${sources.length}, ${readErrors.length} config file${
              readErrors.length === 1 ? "" : "s"
            } could not be read — ${readErrors.map((e) => e.path).join(", ")})`,
            timestamp: Date.now(),
            provenance: toolResultProvenance({
              toolId: `mcp-sources-${id}`,
              name: "mcp__remote_config__sources",
              content: JSON.stringify({ sources, readErrors: readErrors.length }),
              remote: true,
            }),
          }
        : null;
    setState((s) => ({
      conversations: s.conversations.map((c) => {
        if (c.id !== id) return c;
        // Idempotent: `mcp_sources` re-fires on every session (re)start —
        // resume-after-restart (resumeApiConversation) and retryLastTurn both
        // re-issue createSession, which re-emits this event against the same,
        // already-persisted message list. Strip any prior remote-MCP notice
        // before re-appending so a broken remote config yields exactly one
        // notice reflecting the LATEST summary, not a fresh duplicate stacked
        // below the persisted one each restart/retry.
        const base = c.messages.filter(
          (m) => !(m.role === "system" && m.content.startsWith(REMOTE_MCP_NOTICE_PREFIX)),
        );
        return {
          ...c,
          mcpSources: { sources, readErrors },
          messages: noticeMsg ? [...base, noticeMsg] : base,
          updatedAt: Date.now(),
        };
      }),
    }));
    requestConversationSave(id);
  });

  return () => {
    coalescer.dispose();
    chunkUnlisten();
    toolStartUnlisten();
    toolResultUnlisten();
    doneUnlisten();
    errorUnlisten();
    thinkingUnlisten();
    thinkingStopUnlisten();
    permissionReqUnlisten();
    pendingEditUnlisten();
    editBaselineUnlisten();
    planBlockUnlisten();
    toolOutputExtendedUnlisten();
    turnSummaryUnlisten();
    mcpSourcesUnlisten();
  };
}
