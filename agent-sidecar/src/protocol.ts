// Shared wire protocol between the PacketBench Rust supervisor and this sidecar.
// The supervisor reads/writes newline-delimited JSON; every line is one of
// these envelopes. Do not change field names / types without updating the
// Rust side in lockstep.

// Bumped when the wire protocol changes in a way the supervisor must notice.
// Keep in lockstep with `EXPECTED_PROTOCOL_VERSION` in
// `src-tauri/src/commands/agent_sidecar/mod.rs`.
//
// v2 (Tier 3 slice B): added `set_permission_mode`, `set_model`, and `retry`
// request types.
//
// v3 (PacketBench Tier 3 slice A): adds first-class `attachments` on
// start/send, `mergedContent` on edit_response (per-hunk acceptance),
// `batchId`/`batchSize` on permission_request, and three new events:
// `plan_block` (structured TodoWrite mirror), `tool_output_extended`
// (exit code + modified paths), `turn_summary` (running tokens between
// turns). Old sidecars reply "Unknown request type" to v3-only requests,
// so the supervisor warns on version mismatch (does not refuse).
//
// v4 (F8): adds `cancel_pending_tools` request — drain parked
// permission/edit prompts as denied without killing the agent loop.
//
// v5 (Flight Planner E1): adds
//   - `inject_user_turn` request: typed wake-trigger/user-turn injection
//     into a long-lived session, used by the autonomous Flight Planner
//     wake bus and (eventually) the spec-mode chat path.
//   (v5 also shipped an in-process planner MCP surface — `planner_tool`
//   event, `planner_tool_result` request, and `StartSessionRequest.mcpKind`
//   — all removed in v7 when the Rust planner backend was amputated.)
//
// v6 (Flight Planner E6 — rate-limit handler): adds the `rate_limited`
// sidecar event. The Anthropic provider catches `RateLimitError` from the
// Claude Agent SDK's message iterator, parses the `retry-after` header
// when present, and emits this typed event alongside its existing `error`
// emit. It originally drove `FlightPlannerRegistry::on_rate_limited`
// (QuotaPaused + an auto-resume timer + a desktop notification); that
// registry went with the planner in v7, so the supervisor's `rate_limited`
// arm in `commands/agent_sidecar/handler.rs` now only logs the signal —
// the paired `error` event is what the session surfaces to the user.
//
// v7 (planner amputation): removes the in-process planner MCP surface —
// the `planner_tool` event, the `planner_tool_result` request, and
// `StartSessionRequest.mcpKind`. The Rust planner backend was deleted in
// C2-S1, so the sidecar no longer emits or accepts planner envelopes.
// `inject_user_turn` (shared re-entry) and `rate_limited` (generic 429
// surface) survive. Negotiation stays warn-only, so an old supervisor
// paired with a v7 sidecar (or vice versa) still connects.
//
// v8 (S8-Phase-B): adds `sourceMcpFromFs` on `start_session` — when true the
// sidecar sources its OWN MCP config from the remote filesystem
// (~/.claude/settings.json + <project>/.mcp.json, project-over-global) and runs
// ALL servers from there, ignoring `req.mcpServers`. Also adds the
// `mcp_sources` event reporting which servers were sourced (name/transport/
// scope) plus any read/parse errors — names/transport/scope only, never
// commands or secrets. Negotiation stays warn-only.
//
// v9 (G11): adds required `toolUseId` correlation to `edit_response` so one
// approval resolves exactly one pending edit instead of draining the session.
//
// v10 (G06/G36): adds `cancelled` to terminal `done` events. Cancellation is
// now an explicit terminal outcome rather than an indistinguishable success.
//
// v11 (MCPH4): freezes per-server MCP trust/capability authority into the
// session start request. The sidecar filters transports and tools against the
// snapshot; later Settings edits cannot silently broaden a running session.
// v12: remote filesystem MCP sourcing checks the execution host's project
// trust list BEFORE merging or probing repo-supplied commands.
export const PROTOCOL_VERSION = 12;

/** Image content a model can interpret natively. base64-encoded bytes. */
export type ImageAttachment = {
  media_type: string;
  data_base64: string;
};

export type ResumeMessage = {
  role: "user" | "assistant" | "system";
  content: string;
};

export type PermissionMode = "auto" | "ask_for_risky" | "allow_all" | "deny_all";

export type WorkspaceRef =
  | {
      kind: "local";
      projectPath: string;
    }
  | {
      kind: "ssh";
      serverId?: string | null;
      host: string;
      port: number;
      user: string;
      remotePath: string;
      keyPath?: string | null;
      authMethod?: "agent" | "key" | "password" | null;
      hostFingerprint?: string | null;
    };

export type McpTrustSnapshot = {
  schemaVersion: 1;
  serverId: string;
  serverName: string;
  workspacePath: string | null;
  allowReads: boolean;
  allowWrites: boolean;
  allowNetwork: boolean;
  allowedRoots: string[];
  allowedToolNames: string[];
  denialFloors: Array<"credentials" | "outside_workspace" | "protected_publish">;
  revision: number;
  updatedAt: number;
  capabilityCheckedAt?: number;
};

export type StartSessionRequest = {
  type: "start_session";
  sessionId: string;
  provider: string;
  model: string;
  systemPrompt: string;
  allowedTools: string[];
  mcpServers: Record<string, unknown>;
  /** v11: immutable authority captured by PacketBench at session start. An
   * omitted field is migrated by the sidecar to conservative read-only
   * defaults; an explicit empty array grants no MCP servers. */
  mcpTrustSnapshot?: McpTrustSnapshot[];
  projectPath: string;
  initialMessage: string;
  /** v4: API-key sidecar providers may receive a transient key from Rust.
   * This is never persisted by the frontend or sidecar. */
  apiKey?: string;
  resume?: string;
  thinkingEnabled?: boolean;
  planMode?: boolean;
  /** v3: image attachments inlined into the initial user message. */
  attachments?: ImageAttachment[];
  /** Persisted UI transcript used when a provider cannot resume from a
   * native session token, and as the seed for SDK memory sessions. */
  resumeMessages?: ResumeMessage[];
  permissionMode?: PermissionMode;
  approveWrites?: boolean;
  /** Optional absolute command path for CLI-backed providers. Introduced for
   * the retired `openai-codex` provider so PacketBench could honor a
   * user-pinned Codex binary instead of relying on PATH resolution. No
   * surviving provider is CLI-backed, so nothing sends it today; kept on the
   * wire because removing a field is a protocol break and the next
   * subprocess-backed provider will want it. */
  commandPath?: string;
  /** Structured workspace metadata. `projectPath` remains for v1/v6
   * compatibility with local sidecars; remote launches use this object to
   * avoid treating an SSH path as a local filesystem path. */
  workspace?: WorkspaceRef;
  /** v8 (S8-Phase-B): when true the sidecar sources its OWN MCP config from the
   * remote FS (~/.claude/settings.json + <project>/.mcp.json, project-over-global)
   * instead of req.mcpServers. v12 requires host project trust before merging
   * project entries; MCP tool authority is then applied before provider start.
   * Remote (SSH) sessions only; local commands/secrets never cross SSH.
   * Desktop enabled-server filtering is not applied to FS-sourced servers. */
  sourceMcpFromFs?: boolean;
  /** v12: home-relative data directory from the supervisor's brand module.
   * Missing/invalid values deny project MCP config; global config still loads. */
  projectTrustDataDir?: string;
};

export type SendMessageRequest = {
  type: "send_message";
  sessionId: string;
  content: string;
  /** v3: typed attachments (was unknown[]). */
  attachments?: ImageAttachment[];
};

export type PermissionResponseRequest = {
  type: "permission_response";
  sessionId: string;
  toolUseId: string;
  decision: "approve" | "allow_once" | "allow_always" | "deny";
  /** P1-9 deny-and-continue: optional user steering text carried with a
   * "deny". Providers fold it into the denial message the model sees so a
   * rejection redirects the agent instead of stalling the turn. Ignored
   * for allow decisions. */
  reason?: string;
};

export type EditResponseRequest = {
  type: "edit_response";
  sessionId: string;
  /** v9: exact pending edit/tool call this response resolves. */
  toolUseId: string;
  approved: boolean;
  /** v3: when set, the provider should write this content instead of the
   * tool's original `content`. Used by per-hunk diff acceptance — the
   * frontend sends a merged result keeping only the hunks the user picked. */
  mergedContent?: string;
};

export type CancelRequest = {
  type: "cancel";
  sessionId: string;
};

export type CloseSessionRequest = {
  type: "close_session";
  sessionId: string;
};

// Protocol v2 additions — previously stubbed on the Rust side. Slice B wires
// them through the sidecar end-to-end; slice C adds the Rust forwarders.
//
// `mode` values mirror the Anthropic SDK's `PermissionMode`. The Codex
// provider maps them onto its own approval flags.
export type SetPermissionModeRequest = {
  type: "set_permission_mode";
  sessionId: string;
  mode: "default" | "acceptEdits" | "bypassPermissions" | "plan" | "dontAsk" | PermissionMode;
};

export type SetModelRequest = {
  type: "set_model";
  sessionId: string;
  model: string;
};

export type RetryRequest = {
  type: "retry";
  sessionId: string;
};

/** v4+: drain every parked permission_request / pending_edit prompt as
 * denied WITHOUT killing the agent loop. The model sees synthetic
 * "User cancelled this tool" tool_results and continues generating. Use
 * `cancel` (not this) when the user wants the whole session to stop. */
export type CancelPendingToolsRequest = {
  type: "cancel_pending_tools";
  sessionId: string;
};

/** v5: inject a new user turn into a long-lived session. Used by the
 * Flight Planner wake bus (`source: "wake_trigger"`) and the spec-mode
 * chat path (`source: "user"`). Wake-trigger content is wrapped in
 * `<wake_trigger source="..." kind="...">...</wake_trigger>` by the
 * provider so the system prompt can distinguish re-entry from a human
 * turn; user content is pushed verbatim. */
export type InjectUserTurnRequest = {
  type: "inject_user_turn";
  sessionId: string;
  content: string;
  source: "user" | "wake_trigger";
  /** Wake-trigger provenance — currently informational, threaded into the
   * `<wake_trigger>` envelope's `kind` attribute. Ignored when
   * `source === "user"`. */
  trigger?: { kind: string; payload?: unknown };
  /** E6-CAPS: per-mode output `max_tokens` budget the Flight Planner wants
   * the provider to honor for this turn. The Claude Agent SDK (0.2.116) does
   * not expose a per-turn `max_tokens` setter, so the anthropic provider
   * currently logs a warning and falls back to the SDK's defaults. The
   * field is still threaded through so future SDK versions can pick it up
   * without another protocol change. */
  maxOutputTokens?: number;
};

export type SidecarRequest =
  | StartSessionRequest
  | SendMessageRequest
  | PermissionResponseRequest
  | EditResponseRequest
  | CancelRequest
  | CloseSessionRequest
  | SetPermissionModeRequest
  | SetModelRequest
  | RetryRequest
  | CancelPendingToolsRequest
  | InjectUserTurnRequest;

/** v3: structured todo/plan item produced by Anthropic's TodoWrite tool. */
export type PlanItem = {
  id?: string;
  content: string;
  status: "pending" | "in_progress" | "completed";
  activeForm?: string;
};

export type SidecarEvent =
  | { type: "chunk"; sessionId: string; text: string }
  | { type: "thinking"; sessionId: string; text: string }
  | { type: "thinking_stop"; sessionId: string }
  | { type: "tool_start"; sessionId: string; toolUseId: string; name: string; input?: unknown }
  | {
      type: "tool_result";
      sessionId: string;
      toolUseId: string;
      output: string;
      isError: boolean;
      name?: string;
      input?: unknown;
    }
  | {
      type: "permission_request";
      sessionId: string;
      toolUseId: string;
      name: string;
      input: unknown;
      /** v3: when the provider knows multiple permission requests are about
       * to land in the same logical batch, set these so the UI can offer an
       * "approve all N" rollup with the right denominator. */
      batchId?: string;
      batchSize?: number;
    }
  | {
      type: "pending_edit";
      sessionId: string;
      /** Exact SDK tool call parked by the provider. Required so the host's
       * edit_response resolves this edit rather than leaving the turn hung. */
      toolUseId: string;
      path: string;
      before?: string;
      after: string;
    }
  /** P1-7: non-blocking pre-edit baseline capture. Emitted for every
   * edit-bearing tool call that does NOT go through the blocking
   * `pending_edit` approval flow (approveWrites off), so the host can diff
   * applied edits against the true pre-edit content instead of live disk.
   * `before` is absent when the file did not exist. */
  | {
      type: "edit_baseline";
      sessionId: string;
      toolUseId?: string;
      path: string;
      before?: string;
    }
  | {
      type: "done";
      sessionId: string;
      inputTokens: number;
      outputTokens: number;
      cacheReadInputTokens?: number;
      cacheCreationInputTokens?: number;
      /** True only when this terminal event was produced by a user cancel. */
      cancelled?: boolean;
      /** v3: opaque token the supervisor can persist and re-send via
       * StartSessionRequest.resume to continue this conversation after a
       * cold start. Provider-defined; treated as a black box by the host. */
      resumeToken?: string;
    }
  | { type: "error"; sessionId: string; message: string }
  | { type: "ready"; pid: number; version: string; protocolVersion: number }
  // v3 additions ----------------------------------------------------------
  | {
      type: "plan_block";
      sessionId: string;
      items: PlanItem[];
    }
  | {
      type: "tool_output_extended";
      sessionId: string;
      toolUseId: string;
      exitCode?: number;
      modifiedPaths?: string[];
      stdout?: string;
      stderr?: string;
    }
  | {
      type: "turn_summary";
      sessionId: string;
      inputTokens: number;
      outputTokens: number;
      cacheReadInputTokens?: number;
      cacheCreationInputTokens?: number;
      /** Reasoning tokens (Codex 0.125+ exposes `usage.reasoning_tokens`,
       * OpenAI o-series). Billed at the OUTPUT rate. */
      reasoningTokens?: number;
      /** A3: Codex MultiAgentV2 sub-agent path address (e.g. `/root/agent_a`).
       * When present, the host attributes these tokens to a per-address
       * bucket on the conversation instead of accumulating to the root —
       * otherwise multi-agent flights would inflate the root's totals by
       * the children's spend. Empty/absent = root thread. */
      address?: string;
    }
  // v6 additions ----------------------------------------------------------
  /** Flight Planner E6: the underlying provider returned a rate-limit
   * error (HTTP 429 in Anthropic's case). Emitted IN ADDITION to the
   * regular `error` event, which is what actually surfaces the failure to
   * the user. The Rust supervisor consumes this in
   * `agent_sidecar::handle_event`, where it now only logs the signal — the
   * `FlightPlannerRegistry` that armed a QuotaPaused backoff window was
   * removed with the planner in v7. `retryAfterSeconds` is parsed from the
   * SDK error's `retry-after` header when present (Anthropic returns a
   * number-of-seconds value); the field is omitted when the header is
   * absent. Kept on the wire as the generic 429 surface. */
  | {
      type: "rate_limited";
      sessionId: string;
      retryAfterSeconds?: number;
      message?: string;
    }
  // v8 additions (S8-Phase-B) --------------------------------------------
  /** Reports which MCP servers the sidecar sourced from its OWN filesystem
   * for this session (when `sourceMcpFromFs` was set on start_session), plus
   * any read/parse errors encountered. Carries names/transport/scope and
   * error paths/messages ONLY — never commands, env, headers, or secrets. */
  | {
      type: "mcp_sources";
      sessionId: string;
      sources: { name: string; transport: "stdio" | "http" | "sse"; scope: "global" | "project" }[];
      readErrors: { scope: "global" | "project"; path: string; message: string }[];
    };

/** Wire shape for `rate_limited` (typed so the Anthropic provider and the
 * Rust supervisor can import a single name rather than re-spelling the
 * inline union arm). v6. */
export type RateLimitedEvent = Extract<SidecarEvent, { type: "rate_limited" }>;

export type Emit = (event: SidecarEvent) => void;
