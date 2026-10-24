# R2b plan and decision record

Status: **proposed — Step 0 for approval before any R2b code.** This document
records the decisions R2b depends on and the concrete extraction plan. It is a
planning artifact; `backlog.md` remains the sole status ledger. Source baseline
for the checks below: `codex/agent-experience` (2026-10-23).

## Why this document exists

R2b extracts the production agent runner (`run_agent_loop`,
`src-tauri/src/commands/api_agent.rs:2363`) behind the `RuntimeServices` seam so
the same runner serves the live Tauri app and a headless fake provider. The
runtime review flagged four decisions that change the seam's shape; getting them
wrong means rewriting R2b and R5. They are recorded here with a recommended
resolution and the evidence checked in source.

## Decision record

### ADR-1 — RuntimeServices seam shape

**Context.** `run_agent_loop` currently reaches directly for `ApiAgentState`
(histories, configs, pending permission/edit `oneshot` senders), `api_keys`,
the provider registry, the native MCP session, `custom_agents`/`tasks`,
`app_handle.emit`, Flight attempt status, hooks and the cost rollup.

**Recommended.** Define one generic (statically dispatched) trait — not
`dyn` — so `async fn` in traits works without a boxed-future crate:

```rust
pub trait RuntimeServices {
    fn events(&self) -> &dyn EventSink;
    fn load_api_key(&self, provider: &str) -> Result<String, String>;
    fn provider(&self, name: &str) -> Result<Box<dyn LlmProvider>, String>;
    fn tool_definitions(&self, session_id: &str) -> Vec<ToolDefinition>;
    async fn execute_tool(&self, session_id: &str, call: ToolCall) -> ToolResult;
    async fn await_permission(&self, session_id: &str, call: &ToolCall) -> PermissionDecision;
    fn mcp_session(&self) -> Option<std::sync::Arc<McpSessionHandle>>;
    async fn set_attempt_status(&self, session_id: &str, state: AttemptState);
    fn hooks(&self) -> Vec<HookConfig>;
    fn history(&self) -> &dyn HistoryStore;
    fn now_ms(&self) -> i64;
}
```

Tauri implements it by delegating to today's code; a fake implements it for
tests. R2b does **not** change any event name/payload, permission flow or error
string.

**Consequences.** R2b is a behavior-preserving refactor; the fake provider
(R2c) and the journal/budget layers (R3/R5) plug into this seam later.

### ADR-2 — Policy authority (profiles, allowedTools, MCP trust, budget)

**Context (checked).** All four are frontend-owned localStorage today:
`profileStore.ts:12` (`agent-profiles`), `mcpTrustStore.ts:42`
(`mcp-hub-trust-v1`), `costGuardrailStore.ts:20` (`cost-guardrails`), and
`allowedTools` is a caller-supplied array (`api_agent.rs:1283`).

**Recommended.** For R2b, **do not move policy to the backend.** The seam
receives already-resolved values in `RunRequest` (model, allowedTools, posture,
trust snapshot, budget policy reference) and the backend validates _shape and
consistency_ only. Making the backend authoritative is a separate, later
decision (it touches three stores and their persistence) and must not be
smuggled into a behavior-preserving extraction.

**Consequences.** R2b stays low-risk. R5 (budget) revisits this with an explicit
ADR.

### ADR-3 — Retry semantics

**Context (checked).** `retry_last_turn` (`api_agent.rs:1998`) truncates the
last assistant message from history and re-runs it — i.e. **regenerate** — and
forwards `retry` to the sidecar when it owns the session.

**Recommended.** Keep regenerate as-is. The journal's `retryOfOperationId` /
`previousRunId` semantics (runtime §2.2: a new linked operation after a _proven
pre-dispatch_ failure) are a distinct concept. R2b must not change retry
behavior; the mapping between "user pressed Retry (regenerate)" and a new linked
runtime run is decided in R3.

**Consequences.** No retry behavior change in R2b; R3 documents the mapping.

### ADR-4 — Single-instance / writer ownership

**Context (checked).** No `tauri-plugin-single-instance` in `Cargo.toml`; the
writer token is the in-process `active_turns` claim (`api_agent.rs:92`). Two app
processes could each believe they own a worktree.

**Recommended.** R2b keeps the in-process claim as the writer token and does not
claim cross-process safety. Add either an OS single-instance guard or DB-backed
leases **before** the journal is enabled by default (target: the packet that
flips `PACKETBENCH_RUNTIME_JOURNAL` on). Do not imply multi-process safety until
then.

**Consequences.** R1a/R2a remain inert by default, which is safe; enabling the
journal is gated on this.

## R2b extraction plan

**Goal.** `core/agent_runtime/runner.rs::run_turn<R: RuntimeServices>(services,
request, cancel_rx) -> Result<RunOutcome, String>` contains the loop; Tauri and
a fake both call it. No behavior change.

**Move order (one coordinated window):**

1. Extend `core/agent_runtime/mod.rs`: `RunRequest` fields the loop needs;
   `RuntimeServices` (ADR-1) + sub-traits (`PermissionBroker`, `HistoryStore`,
   `McpSessionHandle`, `FlightStatusSink`).
2. Implement `TauriRuntimeServices` in `commands/agent_runtime.rs` delegating to
   the existing `ApiAgentState`, keyring, provider registry, MCP session, Flight
   status and hooks. No logic moves into the adapter.
3. Move the body of `run_agent_loop` into `core/agent_runtime/runner.rs`,
   replacing direct calls with `services.*`. Event names/payloads unchanged.
4. Point the three call sites (`api_agent.rs:1656`, `:1747`, `:2052`) at
   `run_turn` with a `TauriRuntimeServices`.
5. Leave `retry_last_turn`, permission/edit response paths and cancel semantics
   exactly as they are.

**File ownership.** Runtime implementer: `core/agent_runtime/**`,
`commands/agent_runtime.rs`. Coordinator (me): `api_agent.rs` integration
window, `lib.rs`, `api/mod.rs`, generated schema, `tauri.ts`.

**Test gates.**

- `cargo test --lib` (all existing loop-adjacent tests unchanged).
- Existing `api_agent` unit tests (history build, permission, cancel) pass
  unmodified.
- New `core/agent_runtime` runner test with fake services (this is R2c, but the
  seam must be test-shaped from day one).
- Frontend gates unaffected (no frontend change) but run once at integration.

**Acceptance (R2 packet).** Tauri and the fake execute the same runner; event,
permission, error and cancel behavior remain compatible. Native tool + SSH drain
regressions are a separate native lane (deferred; needs the WDIO/pywinauto
tooling).

## R3–R8 sequence (one implementer + one independent reviewer each)

| Packet                               | Depends on                     | Decisions still needed                              | Reviewer focus                          |
| ------------------------------------ | ------------------------------ | --------------------------------------------------- | --------------------------------------- |
| **R3** H2 checkpoints/restart        | R2b                            | ADR-3 retry mapping; checkpoint retention/redaction | crash-after-mutation, no blind replay   |
| **R4** H5 capabilities + H6 manifest | R2b                            | capability provenance source                        | no silent image/tool drop               |
| **R5** H4 budget + ledger bridge     | R3–R4                          | ADR-2 authority; journal↔usage.jsonl reconciliation | no shared-allowance duplication         |
| **R6** H3 context projection         | R3–R5                          | context source (backend vs frontend memory)         | overflow blocks before spend            |
| **R7** H7 role resolver + SDK parity | R3–R6                          | aux routing change window                           | no ignored model field                  |
| **R8** H1 eval suite + rollout proof | R2b (det. lane) / R3–R7 (live) | live provider/account/spend policy                  | same-executor parity, retained failures |

Each packet: implementer works only in its leased files → coordinator runs
packet tests + affected gates → independent reviewer checks the diff against the
packet's acceptance criteria (outside the files it authored) → coordinator fixes
material findings → commit + push. No two writers on a shared file at once.

## Open questions for sign-off

1. **ADR-1 seam shape** — accept the generic trait + sub-traits above, or trim
   it (e.g. drop `mcp_session`/`hooks` behind a single `ExecutionContext`)?
2. **ADR-2** — confirm policy stays frontend-owned through R2b (my
   recommendation), with backend authority deferred to R5.
3. **ADR-3** — confirm `retry_last_turn` stays regenerate and the journal retry
   identity is mapped in R3, not R2b.
4. **ADR-4** — confirm the single-instance/lease work is a prerequisite to
   enabling the journal by default.
5. **Sequencing** — confirm R2b lands and is reviewed **alone** before R3 starts.

Approve these (or amend) and R2b begins.

## R3 addendum (approved 2026-10-23)

R3 (H2 typed checkpoints/restart) splits into R3a and R3b.

**Decisions (recommended, approved):**

1. Retention/redaction: checkpoints are private journal payloads, retained latest 10 per run (older pruned); spec payload limits (4 MiB single blob, 256 MiB per run, 2 GiB total); never persist raw secrets/keys; provider replay envelopes stored opaque but classified; export/delete redact by default.
2. Retry mapping: user Retry stays regenerate and creates a NEW linked run via previousRunId; the journal retryOfOperationId is reserved for a proven pre-dispatch failure.
3. Checkpoint scope: typed history (tool_use/tool_result pairing + opaque provider reasoning) plus schema/transport/model/policy hashes; incompatible state is rejected or explicitly continued as a fresh (semantic) run; a crash after a mutation without a durable receipt yields needs_reconciliation, never blind replay.
4. Restart continues the same runId at epoch+1 via CAS; resume does not start the provider.

**R3a (safe slice):** journal checkpoint tables + core/runtime_checkpoint.rs with typed checkpoint encode/decode, compatibility validation and retention/pruning, plus tests (corrupt/newer preserved, retention bounds, redaction). No runner integration.

**R3b (integration):** runner/api_agent.rs restart + resume wiring and crash-injection tests around every section-4 boundary.

**Leases:** coordinator owns the journal schema/migration and generated artifacts; runtime implementer owns core/runtime_checkpoint.rs (R3a) and runner.rs + the api_agent.rs window (R3b).
