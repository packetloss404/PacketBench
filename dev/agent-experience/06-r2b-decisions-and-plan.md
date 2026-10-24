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

## R4 addendum (autonomous, 2026-10-23)

R4 (H5 capabilities + H6 manifest identity) splits into R4a (core modules + journal table) and R4b (commands + DTOs + tauri.ts/schema + frontend).

**Decisions:**

1. Capability provenance: a tri-state CapabilityKnowledge<T> = supported | unsupported | unknown, each with provenance (live_catalog | static | unknown). Unknown is NEVER treated as supported: when a run requires a behavior (e.g. image input) and capability is unsupported or unknown, fail before dispatch with a named error (no silent drop). Live catalogs (provider_models.rs LiveModel) are the first source; a small static table is second; otherwise unknown.
2. Manifest identity: a versioned, immutable run manifest (harness/tool-policy hashes, endpoint+model, repository revision, context version, parent/child request ids) stored in the journal by id+hash, resolvable after settings edits (a record, not a live-settings pointer).

**R4a (safe slice):** core/runtime_capabilities.rs + core/runtime_manifest.rs + a manifests/capability_snapshots journal table (v2->v3, additive, fail-closed), with tests (tri-state round-trip, unknown-blocks-image, manifest hash stable across settings edits, corrupt/newer preserved). No DTO/command/frontend.

**R4b (integration):** commands + api/mod.rs DTOs + generated schema + tauri.ts wrappers; wire capability checks before dispatch.

**Leases:** coordinator owns api/mod.rs/lib.rs/schema/tauri.ts; runtime implementer owns core/runtime_capabilities.rs, core/runtime_manifest.rs, the journal schema extension, and the runner/api_agent wiring window (R4b).

## R4b / R5 / R6 addendum (autonomous, 2026-10-23)

Grounded in a source review.

**R4b decisions:**

1. Capability DTO: add a concrete, non-generic `RuntimeCapabilityView` in `api/mod.rs` (built from a CapabilitySnapshot), not a ts-rs emit of the generic/tagged Rust enums.
2. Provenance: emit R4a's vocabulary (live_catalog | static | unknown); the spec's aspirational set is noted, not adopted.
3. Named providers (sugar/cline-pass/opencode-go/ollama-cloud/google/xai) stay `unknown` for v1 (fail-closed) until per-provider facts exist; document the behavior change.
4. No Rust live-catalog fetch in R4b (vision comes from the static table); live catalog is an R6 concern.
5. Reasoning capability is NOT enforced in v1 (only the image guard), to avoid breaking thinking-enabled runs.
6. One shared image-guard helper in `runtime_capabilities`, called by BOTH the native runner (before `ensure_usage_healthy`/provider) and the sidecar branch in `api_agent.rs`; refusal happens before any spend.
7. `get_runtime_capabilities` is compute-only and works with the journal off; `get_runtime_context_summary` is deferred to R6 (do not freeze its DTO now).
8. The image guard is gated on `runtime_journal::is_enabled()` (spec §3.1: guards apply "when the feature is enabled"), so the journal-off path is byte-identical to pre-R4b and the composer mismatch (it still advertises attachments universally) is not a live regression. Wiring the composer to `get_runtime_capabilities` is a prerequisite before the journal is enabled by default. The guard runs before the `PreRequest` dispatch-intent checkpoint and before the attachment drain, and before any side-effecting admission on the sidecar paths.

**R5 decisions:**

1. Admission policy source: the frontend stays the policy owner; the per-turn limits are passed to the backend as data (in the launch/send request), so backend admission needs no store migration.
2. The journal is authoritative for admission/liability; `usage.jsonl` stays the canonical raw ledger.
3. Two-phase bridge journal -> release -> ledger append -> journal settle; never nest the two locks.
4. Ceil-reserve / nearest-settle `UsdMicros`; overage becomes a labelled residual, never silently reopened.
5. Unpriced routes are strictly rejected in v1 (no fake zero).
6. First slice is single-scope, native path only, behind the journal flag; SDK soft-turn is excluded (no per-request claim).

**R6 decisions:**

1. Context accounting is backend-native over the durable `HistoryStore`, reusing existing memory/aux retrieval only for optional material (no general memory redesign).
2. No tokenizer in-repo: use a conservative estimator and label `countKind: estimate`; no strict guaranteed-fit mode.
3. Overflow blocks before spend (`blocked_context`) at the same seam as the R4b guard.
4. R6 depends on R3-R5; implement after R5.

## R5b addendum (confirmed 2026-10-23)

Native in-process path only; sidecar/SDK soft-turn excluded (no per-request claim).

1. **Estimate source: backend heuristic via pricing.** Reserve = `pricing::calculate_cost(model, input_tokens, output_tokens, 0, 0)` where `input_tokens = ceil(sum(serialized message chars) / 3)` (conservative) and `output_tokens = max_tokens` (16384). Reserve is then ceil-ed +10% by `UsdMicros::ceil_reserve`. A model with no `pricing_for(model)` is unpriced and refused **only when a budget is configured**. Documented as a conservative upper bound; R6 refines context accounting.
2. **Admission gating: only when a budget is passed.** No `budget_scope_key`/`budget_limit_usd` from the frontend => no reservation => byte-identical path. v1 scope is per-session (`local:<conversationId>`); daily/monthly/provider/flight caps stay frontend once-per-turn. Cross-session global enforcement is out of scope for the single-scope slice.
3. **Ledger bridge: correlate via `request_id`.** Add an additive optional `request_id` to `UsageEntry` (serde default, so historical rows parse). The runner generates one `request_id` per dispatch, reserves it, and after the provider `Done` the accounting path writes the raw row (carrying `request_id`) and the runner settles the journal reservation with the same actual. If the ledger append fails, the reservation stays reserved (accounting already blocks further admission). Locks are never nested: journal writes and the ledger write are separate calls.
4. Settle uses the exact actual (`nearest_settle`); an overage is a labelled residual. Error/cancel releases the reservation.

## R6 addendum (autonomous, 2026-10-23)

Native path only, gated on the runtime journal.

1. **Estimator:** conservative heuristic, `countKind: "estimate"` — `bytes/3` per text payload, `+4` per content block for framing, `IMAGE_TOKEN_ESTIMATE = 2000` per image, `PROVIDER_OVERHEAD_TOKENS = 16` per message. No tokenizer and no strict guaranteed-fit mode (spec step 2's fallback).
2. **Counts include** system text, tool schemas, images, opaque provider-reasoning envelopes and per-message serialization overhead. Overflow blocks before spend at the same seam as the R4b guard and records the snapshot (`blocked_context`).
3. **Deferred:** optional-material omission/retrieval (v1 blocks rather than trims; `omitted` stays empty), live-catalog context windows (static table only knows `anthropic`, so other rows resolve the window as unknown and never block), the `get_runtime_context_summary(runId)` read command, and versioned semantic compaction.
4. **Attachment counting is non-destructive** (`pending_attachment_count`), so a refusal never consumes a queued image.

## R7 addendum (autonomous, 2026-10-23)

Native path; gated on the journal + a configured budget for child reservation.

1. **Override:** `spawn_subagent`'s `model` is a validated override (`ExplicitOverride`); a blank value inherits (`InheritedParent`); a structurally invalid value is refused before any spend. Validation is structural only — the provider route is confirmed by `get_provider`/the key load.
2. **Structured outcome:** only `Completed` is a non-error tool call; `Incomplete`/`Blocked`/`Failed` return as errors so the parent sees a failure (preserves pre-R7 `is_error` semantics).
3. **Child budget:** child model requests reserve/settle under the parent's root scope via a `ChildBudgetHook` on `ParentLlm` (inherited by nested children), reusing the runner's admission path. Journal-off is byte-identical; journal-on/no-budget adds one read and no reservation.
4. **Known gap:** no cancellation token in the child loop (pre-existing); deferred.
