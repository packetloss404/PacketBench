import type {
  CancelPendingToolsRequest,
  CancelRequest,
  EditResponseRequest,
  Emit,
  InjectUserTurnRequest,
  PermissionResponseRequest,
  RetryRequest,
  SendMessageRequest,
  SetModelRequest,
  SetPermissionModeRequest,
  StartSessionRequest,
} from "./protocol.js";
import { loadMcpFromFs } from "./mcp-config.js";
import { applyMcpTrustSnapshot } from "./mcp-trust.js";
import type { ProviderHandler } from "./providers/base.js";
import { EchoProvider } from "./providers/echo.js";
import { AnthropicProvider } from "./providers/anthropic.js";
import { OpenAIAgentsProvider } from "./providers/openai-agents.js";

type ProviderFactories = Record<string, () => ProviderHandler>;

// Factory map — every provider here authenticates with an **API key** handed
// over the wire by the Rust supervisor (`StartSessionRequest.apiKey`). No
// sidecar provider reads a subscription credential store any more.
//
//   - "claude-oauth"  → Anthropic Claude Agent SDK (keyring `api-key-anthropic`)
//   - "openai-agents" → OpenAI Agents SDK          (keyring `api-key-openai`)
//
// The `claude-oauth` key is a historical identifier, kept verbatim because
// persisted conversations store it in `AgentConversation.provider` and resume
// with it verbatim. It no longer implies OAuth; see providers/anthropic.ts.
//
// `openai-codex` was removed in 2026-07: without a ChatGPT subscription,
// shelling out to `codex exec` bought nothing over `openai-agents`, which
// talks to the same API with the same key.
//
// Add new providers by importing the handler and extending this record.
const PROVIDERS: ProviderFactories = {
  echo: () => new EchoProvider(),
  "claude-oauth": () => new AnthropicProvider(),
  "openai-agents": () => new OpenAIAgentsProvider(),
};

/**
 * Registry entry: the live handler plus the provider name it was created for.
 * The name is kept so `dispatch()` can produce human-readable error messages
 * like `openai-agents does not support retry` without a reverse lookup.
 */
interface SessionEntry {
  handler: ProviderHandler;
  provider: string;
  lifecycle: {
    cancelRequested: boolean;
    terminalEmitted: boolean;
  };
}

export class SessionRegistry {
  private sessions = new Map<string, SessionEntry>();
  private queues = new Map<string, Promise<void>>();

  constructor(private readonly providers: ProviderFactories = PROVIDERS) {}

  async start(req: StartSessionRequest, emit: Emit): Promise<void> {
    return this.enqueue(req.sessionId, () => this.startNow(req, emit));
  }

  private enqueue(sessionId: string, operation: () => Promise<void>): Promise<void> {
    const previous = this.queues.get(sessionId) ?? Promise.resolve();
    const next = previous.then(operation, operation);
    const tail = next.catch(() => undefined);
    this.queues.set(sessionId, tail);
    void tail.finally(() => {
      if (this.queues.get(sessionId) === tail) {
        this.queues.delete(sessionId);
      }
    });
    return next;
  }

  private async startNow(req: StartSessionRequest, emit: Emit): Promise<void> {
    const factory = this.providers[req.provider];
    if (!factory) {
      emit({
        type: "error",
        sessionId: req.sessionId,
        message: `Unknown provider: ${req.provider}`,
      });
      return;
    }
    if (this.sessions.has(req.sessionId)) {
      emit({
        type: "error",
        sessionId: req.sessionId,
        message: `Session already exists: ${req.sessionId}`,
      });
      return;
    }
    if (req.workspace?.kind === "ssh" && process.env.PACKETBENCH_REMOTE_SIDECAR !== "1") {
      emit({
        type: "error",
        sessionId: req.sessionId,
        message:
          "Remote SSH workspace metadata reached the local sidecar, but Sidecar-over-SSH transport is not active yet. PacketBench refused to treat the remote path as a local filesystem path.",
      });
      return;
    }
    // v8 (S8-Phase-B): remote-owned MCP config. When the supervisor set this
    // flag (remote SSH sessions only), source MCP servers from the sidecar's
    // OWN filesystem and replace whatever `mcpServers` was forwarded — the
    // supervisor deliberately sends an empty map so local commands/secrets
    // never cross SSH. Emitted BEFORE handler.start so the UX surfaces the
    // sourced servers (and any read errors) even if provider start fails.
    if (req.sourceMcpFromFs) {
      const { servers, summary } = await loadMcpFromFs(
        req.projectPath, req.sessionId, req.projectTrustDataDir,
      );
      req.mcpServers = servers;
      emit({ type: "mcp_sources", sessionId: req.sessionId, ...summary });
    }
    // MCPH4: omitted legacy authority migrates to conservative read-only
    // defaults. An explicit empty snapshot grants no MCP servers. F6: this
    // also probes each granted server for its real tool surface, so a
    // read-only session's allowlist reflects the servers' own readOnlyHint
    // annotations rather than a guess made from tool names.
    const trustedMcp = await applyMcpTrustSnapshot(
      req.mcpServers ?? {},
      req.mcpTrustSnapshot ?? undefined,
      req.projectPath,
    );
    req.mcpServers = trustedMcp.servers;
    req.mcpTrustSnapshot = trustedMcp.snapshots;
    const handler = factory();
    const entry: SessionEntry = {
      handler,
      provider: req.provider,
      lifecycle: { cancelRequested: false, terminalEmitted: false },
    };
    this.sessions.set(req.sessionId, entry);
    let startFailed = false;
    let starting = true;
    const lifecycleEmit = this.lifecycleEmit(req.sessionId, entry, emit);
    const startEmit: Emit = (event) => {
      if (starting && event.type === "error" && event.sessionId === req.sessionId) {
        startFailed = true;
      }
      lifecycleEmit(event);
    };
    try {
      await handler.start(req, startEmit);
      starting = false;
      if (startFailed) {
        this.sessions.delete(req.sessionId);
      }
    } catch (err) {
      starting = false;
      this.sessions.delete(req.sessionId);
      emit({
        type: "error",
        sessionId: req.sessionId,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  async dispatch(
    sessionId: string,
    req:
      | SendMessageRequest
      | PermissionResponseRequest
      | EditResponseRequest
      | CancelRequest
      | SetPermissionModeRequest
      | SetModelRequest
      | RetryRequest
      | CancelPendingToolsRequest
      | InjectUserTurnRequest,
    emit: Emit,
  ): Promise<void> {
    return this.enqueue(sessionId, () => this.dispatchNow(sessionId, req, emit));
  }

  private async dispatchNow(
    sessionId: string,
    req:
      | SendMessageRequest
      | PermissionResponseRequest
      | EditResponseRequest
      | CancelRequest
      | SetPermissionModeRequest
      | SetModelRequest
      | RetryRequest
      | CancelPendingToolsRequest
      | InjectUserTurnRequest,
    emit: Emit,
  ): Promise<void> {
    const entry = this.sessions.get(sessionId);
    if (!entry) {
      emit({
        type: "error",
        sessionId,
        message: `No active session: ${sessionId}`,
      });
      return;
    }
    const { handler, provider } = entry;
    const lifecycleEmit = this.lifecycleEmit(sessionId, entry, emit);
    try {
      switch (req.type) {
        case "send_message":
          entry.lifecycle.cancelRequested = false;
          entry.lifecycle.terminalEmitted = false;
          if (handler.sendMessage) await handler.sendMessage(req, lifecycleEmit);
          break;
        case "permission_response":
          if (handler.respondPermission) await handler.respondPermission(req, emit);
          break;
        case "edit_response":
          if (handler.respondEdit) await handler.respondEdit(req, emit);
          break;
        case "cancel":
          entry.lifecycle.cancelRequested = true;
          entry.lifecycle.terminalEmitted = false;
          if (handler.cancel) await handler.cancel(lifecycleEmit);
          lifecycleEmit({
            type: "done",
            sessionId,
            inputTokens: 0,
            outputTokens: 0,
            cancelled: true,
          });
          break;
        case "set_permission_mode":
          if (handler.setPermissionMode) {
            await handler.setPermissionMode(req, emit);
          } else {
            emit({
              type: "error",
              sessionId,
              message: `${provider} does not support set_permission_mode`,
            });
          }
          break;
        case "set_model":
          if (handler.setModel) {
            await handler.setModel(req, emit);
          } else {
            emit({
              type: "error",
              sessionId,
              message: `${provider} does not support set_model`,
            });
          }
          break;
        case "retry":
          entry.lifecycle.cancelRequested = false;
          entry.lifecycle.terminalEmitted = false;
          if (handler.retry) {
            await handler.retry(req, lifecycleEmit);
          } else {
            emit({
              type: "error",
              sessionId,
              message: `${provider} does not support retry`,
            });
          }
          break;
        case "cancel_pending_tools":
          if (handler.cancelPendingTools) {
            await handler.cancelPendingTools(req, emit);
          } else {
            emit({
              type: "error",
              sessionId,
              message: `${provider} does not support cancel_pending_tools`,
            });
          }
          break;
        case "inject_user_turn":
          entry.lifecycle.cancelRequested = false;
          entry.lifecycle.terminalEmitted = false;
          if (handler.injectUserTurn) {
            await handler.injectUserTurn(req, lifecycleEmit);
          } else {
            emit({
              type: "error",
              sessionId,
              message: `${provider} does not support inject_user_turn`,
            });
          }
          break;
      }
    } catch (err) {
      emit({
        type: "error",
        sessionId,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private lifecycleEmit(sessionId: string, entry: SessionEntry, emit: Emit): Emit {
    return (event) => {
      if (event.type === "done" && event.sessionId === sessionId) {
        if (entry.lifecycle.terminalEmitted) return;
        entry.lifecycle.terminalEmitted = true;
        emit(entry.lifecycle.cancelRequested ? { ...event, cancelled: true } : event);
        return;
      }
      if (event.type === "error" && event.sessionId === sessionId) {
        if (entry.lifecycle.terminalEmitted) return;
        entry.lifecycle.terminalEmitted = true;
      }
      emit(event);
    };
  }

  async close(sessionId: string): Promise<void> {
    return this.enqueue(sessionId, () => this.closeNow(sessionId));
  }

  private async closeNow(sessionId: string): Promise<void> {
    const entry = this.sessions.get(sessionId);
    if (!entry) return;
    this.sessions.delete(sessionId);
    const { handler } = entry;
    if (handler.close) {
      try {
        await handler.close();
      } catch (err) {
        process.stderr.write(
          `[sidecar] error closing session ${sessionId}: ${
            err instanceof Error ? err.message : String(err)
          }\n`,
        );
      }
    }
  }

  async closeAll(): Promise<void> {
    const ids = Array.from(new Set([...this.sessions.keys(), ...this.queues.keys()]));
    await Promise.all(ids.map((id) => this.close(id)));
  }
}
