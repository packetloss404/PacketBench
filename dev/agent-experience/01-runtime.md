# Runtime handoff: durable continuation, bounded requests and measurable execution

> October 24 source verification: R1–R8 have committed slices, while the full
> contract remains partial and journal paths default off. Read
> [the implementation audit](../documentation-audit-2026-10-24.md) and
> [current status](../current-status.md) before treating any target below as an
> enabled guarantee. The later owner decision puts desktop/runtime completion
> and acceptance before Remote Agents; use [the completion plan](./08-desktop-completion-before-remote-agents.md).

Status: proposed implementation design; no product implementation is authorized by this document alone.
Design date: 2026-10-19 America/Chicago; narrow source verification and technical references retrieved 2026-10-20 UTC.
Source baseline: e5d31084e5d2c4861723dca4d4c2931a64b0f732.
Working tree already contains the prior research/documentation edits; preserve them.

This track implements H2, H4, H3, H5, H6, H7 and H1 from the
[full review](../agent-harness-and-experience-review-2026-10-19.md). It improves the
existing native/SDK runtime. It does not introduce a second agent executor, a
new autonomous Flight planner, an inference service, or a model-development program.
The completed Flight review, cost ownership, retry limits, Stop, worktree
retention and immutable delivery rules are compatibility requirements, not work
to redo here. Root planning and the UX/integration tracks own their own documents.

## 1. Current implementation and the boundary of this proposal

| Existing source evidence at the baseline                                                                                                                                         | Current capability                                                                                                                 | Design implication                                                                                                        |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| [llm_provider.rs](../../src-tauri/src/core/llm_provider.rs), lines 9 and 59                                                                                                      | Native streaming provider trait and provider dispatch already exist.                                                               | Inject this seam into the production runner; do not duplicate the tool loop.                                              |
| [api_agent.rs](../../src-tauri/src/commands/api_agent.rs), lines 2363, 2459 and 2494                                                                                             | Main loop is private, tied to AppHandle, bounded at 150 iterations, and uses fixed 16,384 output / 8,000 thinking allowances.      | Separate event delivery from execution and calculate each request envelope.                                               |
| [llm_types.rs](../../src-tauri/src/core/llm_types.rs), line 78                                                                                                                   | Live history preserves opaque provider reasoning.                                                                                  | Preserve private typed state, not a rendered-text approximation, where the adapter supports it.                           |
| [api_agent.rs](../../src-tauri/src/commands/api_agent.rs), lines 363 and 418; [agentTaskStore.ts](../../src/stores/agentTaskStore.ts), lines 474–525                             | Resume accepts role/content text; tool results are summarized/truncated; latest-message bounds are character based.                | Legacy continuation remains explicitly semantic; do not invent missing tool receipts or signed state.                     |
| [agentConversationPersistence.ts](../../src/stores/agentConversationPersistence.ts), lines 48–71; [conversations.rs](../../src-tauri/src/commands/conversations.rs), lines 42–49 | UI transcript saves are debounced; the backend treats the JSON as opaque and writes it directly.                                   | A UI transcript cannot be the mutation-safety journal. Keep it a projection.                                              |
| [agentTaskStore.ts](../../src/stores/agentTaskStore.ts), line 390; [costGuardrailStore.ts](../../src/stores/costGuardrailStore.ts), line 166                                     | Budget preflight is once per root user turn against recorded usage.                                                                | Backend admission must cover every observable model request and shared descendants.                                       |
| [usage.rs](../../src-tauri/src/commands/usage.rs), lines 23 and 112–214                                                                                                          | Raw usage.jsonl accounting already has a fail-closed pending-write journal.                                                        | Preserve it as canonical raw accounting; add correlation/idempotency rather than a competing cost total.                  |
| [provider_models.rs](../../src-tauri/src/commands/provider_models.rs), line 87; [llm_types.rs](../../src-tauri/src/core/llm_types.rs), line 154                                  | Catalog metadata includes window/output/pricing; common request controls have provider-specific behavior.                          | Capability knowledge must carry its source and uncertainty.                                                               |
| [tool_subagent.rs](../../src-tauri/src/core/tool_subagent.rs), lines 19, 79, 89 and 106; [aux_llm.rs](../../src-tauri/src/core/aux_llm.rs), line 286                             | Read-only child loops, parent usage attribution and cheap-tier routing exist; spawn_subagent advertises an ignored model override. | Make routing/child outcomes explicit without expanding child authority.                                                   |
| [protocol.ts](../../agent-sidecar/src/protocol.ts), lines 69 and 118; [openai-agents.ts](../../agent-sidecar/src/providers/openai-agents.ts), line 305                           | Sidecar v12 uses SDK-specific state; OpenAI SDK uses MemorySession seeded from the resume text DTO.                                | Do not assert native checkpoint or per-request budget parity for SDK routes.                                              |
| [api_agent.rs](../../src-tauri/src/commands/api_agent.rs), lines 184, 2318 and 3190; [flight_runtime.rs](../../src-tauri/src/commands/flight_runtime.rs), line 508               | Stop/recovery already drain owned SSH cleanup.                                                                                     | The new run state must wait for the same cleanup acknowledgements before releasing writers or reporting a completed Stop. |

Line references are baseline navigation aids and will move during implementation.
The source review did not run providers, tests, builds, migrations or account operations.

## 2. Chosen bounded architecture

Use one backend-owned local SQLite journal for launch operations, run lifecycle,
requests, effects, checkpoints, reservations and execution-resource references.
Use the existing rusqlite dependency; do not add a second launch database.
UI transcript JSON and Zustand remain readable projections. Existing
usage.jsonl remains canonical raw provider accounting.

A dedicated blocking actor owns one database connection; async commands await
bounded replies. Initial configuration is rollback journal DELETE,
synchronous FULL, foreign_keys ON and a bounded busy timeout. Do not select WAL
for v1: single-writer admission does not need it, and current SQLite documentation
identifies version-dependent WAL-reset hazards. This avoids requiring a new
SQLite upgrade merely to implement the design. Do not place the journal in the
project, worktree, SSH filesystem, synced workspace or a shared network store.
Resolve its local path through the existing brand/data-dir seam. An unsupported
filesystem or failed durable commit blocks new execution with an actionable
storage error. Do not block the Tauri UI thread on database I/O.

Proposed modules, all new unless stated otherwise:

- core/agent_runtime/: production runner and service interfaces.
- core/runtime_types.rs: domain types, validators and versioned hashes.
- core/runtime_journal.rs: the one connection actor, migrations and transactions.
- core/runtime_checkpoint.rs: typed history validation and recovery decisions.
- core/runtime_budget.rs: admission, reservations and reconciliation.
- core/runtime_context.rs: accounting and bounded context projection.
- core/runtime_capabilities.rs: model/transport/target capability snapshots.
- commands/agent_runtime.rs: thin authenticated Tauri lifecycle/query commands.
- src/lib/agentRuntimeClient.ts: typed frontend client/projection helpers.
- src-tauri/tests/runtime_recovery.rs and runtime_eval/: fault fixtures and cases.

Retain existing provider adapters, permission/edit brokers, local/SSH tool
executors, MCP trust rules, cleanup guards, provider replay envelopes and cost
rollups. Extract them through adapters, not wholesale rewrites.

### 2.1 Identity, epochs and writer ownership

A root RuntimeRun is ONE user turn, including every model request, tool round,
approval and descendant. A subsequent follow-up is a new run with previousRunId.
Restart continues the same runId with an incremented epoch. This is distinct
from conversationId, provider SDK thread/token, Flight attempt ID and native
session ID. An SDK thread may span several runs; no equality between these IDs
is assumed.

The root run is the budget root. Each child has childRunId and parentRunId and
shares the root admission policy plus applicable conversation, Flight, provider,
account, daily and monthly scopes. Do not allocate the full root allowance again
to every child. The root ID survives a restart; a new user turn still shares the
conversation/Flight/day/month totals and any unresolved prior liability.

The backend assigns and validates stable AgentProjectRef identity. Base-project
identity does not change when an execution uses a worktree. Do not lowercase
paths on SSH or case-sensitive filesystems. SSH host labels are presentation.

```ts
type AgentProjectRef =
  | { version: 1; projectKey: string; kind: "local"; basePath: string }
  | { version: 1; projectKey: string; kind: "ssh"; serverId: string; basePath: string };

// Validated `sha256:<64 lower-case hex>` of versioned, domain-separated
// canonical JSON. An assertion from the caller is not backend authority.
type SnapshotRevision = string;

type RequestedExecutionBinding = {
  version: 1;
  project: AgentProjectRef;
  expectedProjectAuthorityHash: SnapshotRevision;
} & (
  | {
      requestedIsolation: "checkout";
      source: { kind: "project_checkout"; worktreePath: string };
    }
  | {
      requestedIsolation: "worktree";
      baseBranch: string;
      expectedBaseHead: string;
    }
  | {
      requestedIsolation: "checkout";
      source: {
        kind: "borrowed_resource";
        executionResourceId: string;
        expectedResourceRevision: number;
        worktreePath: string;
      };
    }
);

type ExecutionBinding = {
  version: 1;
  executionResourceId: string;
  ownership: "owned" | "borrowed";
  basePath: string;
  worktreePath: string; // exact resolved execution directory
  branch?: string;
  gitHead?: string; // observed revision, not proof files are clean
  executionAuthorityHash: SnapshotRevision;
  resourceRevision: number;
} & (
  | { kind: "local"; project: Extract<AgentProjectRef, { kind: "local" }> }
  | {
      kind: "ssh";
      project: Extract<AgentProjectRef, { kind: "ssh" }>;
      serverId: string;
      hostFingerprint: string;
      sshAuthorityHash: SnapshotRevision;
    }
);
```

RequestedExecutionBinding is untrusted input. Resolve it from current registered
project/server records and approved provisioning. Freeze ExecutionBinding before
returning prepared. Store no password, private key, API credential or auth header.
Both requested and resolved bindings are versioned and contain AgentProjectRef;
the backend rejects mismatching nested/top-level project identity. The exact
worktreePath is REQUIRED on every resolved binding, including a non-worktree
checkout. A new-worktree request cannot supply proof of a not-yet-created path;
the backend selects and records that path during provisioning. A checkout request
must name the project's registered checkout or an admitted borrowed resource,
not an arbitrary caller path. A follow-up reuses its conversation's validated
resource; preparation does not provision another worktree for every turn.

expectedProjectAuthorityHash comes from the backend's target-resolution query;
compare it to fresh registered project/host authority during prepare. Compute
executionAuthorityHash over the resolved project, executionResourceId, exact
path, local/SSH kind and SSH authority when present. SSH authority hashes bind
the canonical host, port, user and verified host pin, not a display label or
server ID alone. Policy hashes in section 2.2 separately bind permission/tools/
MCP/profile authority. Use one versioned canonical serializer: sorted object keys,
normalized explicit nulls, defined list ordering and path strings canonicalized
only by their actual host rules. Never hash secrets or accept a caller's hash as
proof of authorization. Content hashes identify snapshots; they are not signatures.
On SSH dispatch/restart, re-resolve credentials and compare the saved host/user/
port/pin authority identity; reusing a server ID does not authorize repointing it.
A new journaled SSH mutation requires a verified host pin. A missing/mismatched
pin blocks rather than falling back to local execution or silent TOFU.

Execution-resource rows record the cleanup owner and borrowers. A writable
resource has one writer token (runId, epoch) across PacketBench-managed runs.
This is admission exclusion, not a filesystem/global lock: user editors, PTYs
and external processes may still write. Reobserve Git/file baselines before
effects and after approval; known drift blocks the pending mutation and requires
inspection or renewed intent. A check cannot eliminate an external write racing
after it, so do not promise exclusive OS access or universal compare-and-swap
filesystem semantics. Read-only children may share the
root resource within their intersected authority. A semantic fork can borrow
current parent files only after the parent settles and explicit borrow admission
succeeds; child delete releases its reference and never deletes the parent's
worktree. Parent discard must check borrowers and pending writers. A fresh
worktree is a separate explicit operation and does not claim to clone dirty files.
No time-to-live releases an unknown mutation or unconfirmed remote process.

Resource lifetime follows durable ownership, not a timer. During preparation
the launch operation is the provisional cleanup owner. Provisioning records the
exact created path and its creation receipt; attachment then binds the existing
conversation or Flight attempt as cleanup owner, without copying ownership to
borrowers. A failed attachment leaves that registered resource retained and
inspectable under its operation ID. Existing Flight attempt ownership is not
transferred to the conversation merely because the UI attaches it. Cleanup
requires a settled owner, no active borrower/writer, acknowledged process drain,
fresh target checks and the existing non-destructive cleanup operation. Persist
cleanup intent/result; an interrupted cleanup is inspected at the exact saved
path and never treated as proof that files were removed. A missing worktree
does not release unresolved external effects or billing evidence.

### 2.2 Shared launch contract with the UX track

The UX track owns React orchestration and scoped drafts; runtime owns durable
IDs, admission and state. Reserve operationId, requested conversationId and runId
in this journal BEFORE worktree provisioning. Do not provision an unowned path
and try to register it afterwards.

```ts
// Import these from existing source types; do not create another permission enum.
// PermissionMode = "auto" | "ask_for_risky" | "allow_all" | "deny_all".
type RuntimePosture = {
  planMode: boolean;
  permissionMode: PermissionMode;
  approveWrites: boolean;
};

type RuntimeProfileSnapshot = {
  systemPrompt: string;
  allowedTools: string[] | null;
  memoryContextEnabled: boolean;
  permissionMode: PermissionMode;
  planMode: boolean;
  pinnedModel: string | null;
};

type FrozenRuntimeLaunch = {
  agent: AgentCli; // validated API agent ID; PTY launch is a separate contract
  provider: string; // validated existing canonical backend provider ID
  model: string; // exact selected model, never inferred from provider prefixes
  profileId?: string;
  profileRevision?: SnapshotRevision;
  profileSnapshot?: RuntimeProfileSnapshot;
  initialMessage: string; // this turn's private input, never a summary field
  systemPrompt: string | null;
  posture: RuntimePosture;
  thinkingEnabled: boolean;
  memoryContextEnabled: boolean;
  allowedTools: string[]; // explicit resolved tool IDs, no ambient null/all
  enabledMcpServerIds: string[]; // explicit [] means built-in tools only
  toolPolicyHash: SnapshotRevision;
  mcpTrustSnapshotHash: SnapshotRevision;
  attachmentIds: string[]; // F2 opaque asset IDs, backend resolves/pins metadata
};

type PrepareAgentLaunchInput = {
  version: 1;
  operationId: string;
  conversation:
    | { kind: "initial"; conversationId: string } // frontend preallocated
    | {
        kind: "existing";
        conversationId: string;
        previousRunId: string | null; // null only for legacy/unbound history
        expectedConversationRevision: number;
      };
  retryOf?: { operationId: string; runtimeRunId: string };
  project: AgentProjectRef;
  execution: RequestedExecutionBinding;
  draftId: string;
  draftRevision: number;
  frozenLaunch: FrozenRuntimeLaunch;
};

type LaunchOperationPhase =
  | "accepted"
  | "provisioning"
  | "prepared"
  | "starting"
  | "running"
  | "settled"
  | "cancelled"
  | "failed"
  | "outcome_unknown";

type RuntimeLaunchSummary = {
  version: 1;
  operationId: string;
  conversationId: string;
  runtimeRunId: string;
  epoch: number;
  phase: LaunchOperationPhase;
  latestDurableSeq: number;
  retryOf?: { operationId: string; runtimeRunId: string };
  blocker?: { code: string; message: string };
};

type PreparedRuntimeRun = RuntimeLaunchSummary & {
  execution: ExecutionBinding;
  phase: "prepared";
};

type PrepareRuntimeRunResult = {
  operation: RuntimeLaunchSummary;
  prepared?: PreparedRuntimeRun; // present iff operation.phase === "prepared"
};
```

RuntimePosture reuses [PermissionMode](../../src/types/agent-conversation.ts),
line 72, and existing conversation planMode/approveWrites fields, lines 140–145;
the native enum is [api_agent.rs](../../src-tauri/src/commands/api_agent.rs),
line 35. There is no free-form posture string. Missing/invalid posture fails
validation; defaults are resolved visibly before prepare. An existing policy
floor may further restrict the posture but never silently broaden it.

profileId/profileRevision/profileSnapshot are either all present or all absent.
The current [AgentProfile](../../src/types/profiles.ts), line 13, has no immutable
revision, so freeze its behavior-affecting fields and compute SnapshotRevision
from that private snapshot. Do not use updatedAt as a revision. Omit mutable
labels/descriptions from policy identity. Explicit launch overrides are separate
frozen fields and their effective intersection is hashed in toolPolicyHash.
Resolved system prompts, tools, MCP trust, hooks and posture are revalidated
against current backend authority at prepare/start; a changed hash requires a
new explicitly reviewed intent. null/all/default inputs from legacy UI controls
must be resolved to an explicit bounded list before this wire request. The
target-resolution query supplies candidate hashes; prepare recomputes and checks
them. The provider/agent pair must match existing centralized mappings; no
prefix stripping, route guessing or cross-provider fallback is added here.

Store draftId/revision AND the frozen intent payload/hash. A backend cannot
validate a browser-only draft reference without that snapshot. Attachment IDs
must resolve to approved, project/draft-scoped F2 assets; pin exact bytes/digests
before returning prepared. F2 owns the asset service and byte storage; runtime
owns durable operation/message/checkpoint references, not another image store.
Hashes alone are not attachment bytes or authority.

Repeated operationId with the same canonical request digest returns the same
IDs and current phase, including provisioning-in-progress. A changed digest is
a conflict, not a second launch. Retransmission only queries/returns durable
state: it never repeats provisioning, resets a failed/cancelled operation or
dispatches another provider call. A cancelled operation tombstone never becomes
prepared again. A duplicate start for the same operation/run/epoch similarly
returns current state; its durable dispatch claim cannot be acquired twice.

Initial preparation reserves a previously unowned conversationId and allocates
one new root run. Reject an initial conversationId already reserved/owned by a
different operation or project. Existing-conversation preparation allocates a
NEW operation and root run in that SAME conversation: verify its backend owner,
AgentProjectRef, exact execution resource, expectedConversationRevision and
previousRunId. The previous ID must be that conversation's latest root run,
including failed turns; null is legal only when no journaled turn exists.
Bind legacy history through a backend-validated conversation owner record before
accepting null, rather than trusting browser-supplied ownership. Require the
prior run settled, no unacknowledged writer/effect and no overlapping prepared
turn. CAS advances the backend conversation revision in the prepare transaction.
The transcript can retain failed messages; that is separate from admission.

A deliberate retry of a PROVEN failed pre-dispatch operation uses a fresh
operationId and retryOf linking its old operation/run. It is new explicit intent,
not network retransmission. For a failed initial launch it requires a distinct
initial conversationId; preserve the earlier failed operation and its retained
resources. Any resource reuse is a separate explicit borrow/recovery decision,
never silent cleanup or a second ownership claim. For a failed turn in an
existing conversation, use the existing variant, same validated conversation,
new run, latest previousRunId and fresh expectedConversationRevision. The
backend proves no paid/model dispatch or mutation occurred before permitting
this retry classification. Unknown outcomes require reconciliation, not an
automatic retry or a newly allocated ID used to bypass the blocker. Once a run
has dispatched, continuation uses inspect/resume of that run or a separately
authorized new turn only after its effects/resources are settled. Restart uses
the same runId at a new epoch and never prepare with retryOf. New retry runs
remain subject to shared conversation/Flight/account/window liabilities; they
do not refresh the allowance.

Preparation phases: accepted -> provisioning -> prepared. Cancellation is legal
in every nonterminal phase. Provisioning receipts bind exact created resources;
a crash between worktree creation and receipt means inspect the expected exact
resource before deciding ownership, never force-remove or silently use checkout.
The API is async: PrepareRuntimeRunResult always carries the operation's IDs/
phase, and prepared appears only after binding resolution. get/status events
resolve that same operation. A repeated prepare with the same digest may read
its state, but is never required to advance it. starting means durable dispatch
intent has been recorded; running requires the adapter's start acknowledgement.
If the boundary cannot be reconciled after a crash, phase is outcome_unknown
and the run is interrupted/needs_reconciliation. settled means the root turn
is terminal; it does not assert delivery or erase the terminal outcome. These
operation phases are backend projections, not another frontend state machine.

The client durably attaches the prepared conversation and installs listeners,
then calls start_runtime_run with operationId, runtimeRunId and expectedEpoch.
Provider dispatch occurs only after the backend rechecks cancellation, authority,
resource writer, journal health, capabilities, context and budget. A delayed
client completion cannot reopen a cancelled operation. Cancel first invalidates
the live admission token, then commits its fence and drains any started work.

## 3. Storage and DTO contracts

Use additive Rust domain structs plus explicit DTO conversions in api/mod.rs;
export through the existing generated_typescript_schema mechanism. Do not hand
edit src/generated/tauri-schema.ts or trust persisted frontend runtime fields.
New fields on AgentConversation are optional projection references only.

```ts
type RuntimeState =
  | "prepared"
  | "running"
  | "awaiting_approval"
  | "stopping"
  | "interrupted"
  | "needs_reconciliation"
  | "blocked_budget"
  | "blocked_context"
  | "blocked_capability"
  | "completed"
  | "cancelled"
  | "failed";

type ResumeMode = "typed" | "semantic" | "none";
type UsdMicros = string; // checked unsigned decimal, never float arithmetic
type RuntimeRunSummary = {
  version: 1;
  runtimeRunId: string;
  conversationId: string;
  operationId: string;
  previousRunId?: string;
  parentRunId?: string;
  budgetRootRunId: string;
  epoch: number;
  state: RuntimeState;
  resumeMode: ResumeMode;
  latestDurableSeq: number;
  execution: ExecutionBinding;
  capabilitySnapshotId: string;
  manifestId: string;
  contextSummary: ContextAccounting;
  budget: BudgetDisclosure;
  blocker?: { code: string; message: string; effectIds?: string[] };
};

type AgentConversationRuntimeProjection = {
  runtimeRunId?: string;
  runtimeState?: RuntimeState;
  resumeMode?: ResumeMode;
};
```

Limits for epoch/sequence are checked safe DTO integers; storage may use i64,
but never silently convert an arbitrary u64 to imprecise JavaScript Number.
Money micros are decimal strings at IPC boundaries and checked integer arithmetic
in Rust. Reject negative, nonfinite, overlong and overflowing inputs.

Proposed schema tables:

| Table                                                | Required keys and responsibility                                                                                                                                                                                  |
| ---------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| launch_operations                                    | operation_id PK, conversation_id FK, initial/existing kind, retry_of operation/run, request_digest, draft_id/revision, private frozen_input, run_id unique, phase, created_at, cancelled_at, provisioning_receipt |
| conversation_owners                                  | conversation_id PK, stable project identity, execution_resource_id, revision, latest root run; unique initial owner operation, CAS for each existing-conversation turn                                            |
| runs                                                 | run_id PK, conversation_id, operation_id, previous/parent/root IDs, epoch, state, manifest_id, checkpoint_id, latest_seq, instance_id                                                                             |
| run_events                                           | (run_id, seq) PK, epoch, kind, request/effect IDs, private typed payload or blob reference, payload hash, timestamp; append-only                                                                                  |
| checkpoints                                          | checkpoint_id PK, run_id/epoch/seq, schema/transport versions, compatibility hashes, private typed history, pending-effect IDs, payload hash                                                                      |
| requests                                             | request_id PK, run_id/root_id, epoch, state, input/context digest, effective model/route, reservation_id, usage_id, raw usage receipt, dispatch/finish times                                                      |
| tool_effects                                         | effect_id PK, run_id/epoch, tool_call_id, argument/policy digest, mutability class, state, intent/receipt refs, before/expected-after observations, reconciliation evidence                                       |
| budget_reservations                                  | reservation_id PK, request_id unique, policy revision, billing identity, rate snapshot, scoped reserved amounts/tokens, state, actual/provisional debit, reconciliation reason                                    |
| execution_resources                                  | resource_id PK, exact binding, cleanup owner, resource_revision, writer run/epoch, cleanup state                                                                                                                  |
| execution_resource_refs                              | (resource_id, referencing conversation/run) PK, owned/borrowed relation                                                                                                                                           |
| manifests / capability_snapshots / context_snapshots | immutable ID/hash-addressed validated private records; public summary separated from private payload                                                                                                              |
| runtime_blobs                                        | content hash PK, bounded decoded bytes, classification, retention state; kept transactional with referencing events                                                                                               |
| asset_refs                                           | F2 opaque asset ID + referencing operation/message/checkpoint, digest/size/version, durable pin state; one journal actor, bytes remain in the F2 asset service                                                    |

Use foreign keys, unique constraints, checked enums, migration user_version and
one actor transaction boundary. Do not hold a database transaction across model,
tool, SSH, SDK, UI-approval or filesystem-provisioning awaits. Persist intent,
release transaction, perform effect, then persist receipt. The database does not
make the external effect atomic.

Initial bounded limits: 4 MiB decoded single replay/blob payload, 64 KiB public
summary, 256 events per query page, 256 MiB private payload budget per run and
2 GiB total private journal payload. Measure normal tool-output sizes before
enabling by default. If an adapter needs a larger opaque envelope, block with
a named compatibility error rather than truncate it. A full/disk-failed journal
pauses before the next request/effect; it must not turn into a best-effort log.
These proposed limits are configuration defaults, not claims about current usage.

### 3.1 Commands and events

All commands validate IDs, expected epoch, conversation/operation relationship,
execution authority and current backend ownership. UI state is never proof.

- resolve_runtime_launch_context(project, requestedRoute) -> validated project authority expectation and explicit policy/tool candidate hashes; no provider dispatch, credentials or execution authority granted.
- prepare_runtime_run(input) -> PrepareRuntimeRunResult; applies initial or existing-conversation admission from section 2.2.
- get_runtime_run(runId), get_runtime_launch(operationId), list_runtime_events(runId, afterSeq, limit).
- start_runtime_run(operationId, runId, expectedEpoch) -> acknowledged start/state.
- cancel_runtime_run(operationId, runId, expectedEpoch) -> stopping/terminal summary; await cleanup before reporting cancelled.
- inspect_runtime_resume(runId) -> permitted modes, incompatibilities, pending effects and context/usage uncertainties; no dispatch.
- resume_runtime_run(runId, expectedEpoch, mode, inspectedRevision) -> prepared new epoch. It does NOT start the provider.
- reconcile_runtime_effect(runId, expectedEpoch, effectId, resolution, reason, observationRef) -> new summary. This command does not rerun the tool.
- get_runtime_capabilities(routeRef, targetRef), get_runtime_context_summary(runId).
- export_runtime_run(runId, redactionMode) -> validated redacted artifact.
- delete_runtime_history(conversationId, expectedRevision) -> deny while active/unknown without an explicit safe retention resolution.

Retain api-agent:{kind}:{sessionId} streaming/approval events for compatibility.
Add api-agent:runtime-state:{sessionId} with RuntimeRunSummary and
api-agent:runtime-event:{sessionId} with runId, epoch, durableSeq and a redacted
event summary. Streaming text is provisional until the durable assistant receipt
is committed. Clients deduplicate durableSeq and ignore old epochs; missed events
are recoverable by querying afterSeq. Do not send raw checkpoint blobs through
Zustand, localStorage, generic events, logs or attention badges.

The existing start/send/retry/permission/edit entry points must enter these same
backend guards when the feature is enabled. A caller cannot bypass reservations
or an unknown effect by using the old IPC command. Thin compatibility wrappers
are acceptable; a second authority path is not.

## 4. H2: typed continuation and the mutation/receipt boundary

Typed continuation means validated provider-compatible input reconstruction, NOT
exactly-once tools, byte-identical model output, restored files or free replay.

### 4.1 Persisted sequence

1. Commit immutable manifest/authority and prepared root identity.
2. Before a model call, commit request ID, context snapshot, reservation and dispatch intent.
3. Execute the request. Streaming deltas may be provisional. Commit the completed
   assistant typed blocks, raw usage receipt and tool-call IDs before dispatching
   any resulting tool. An incomplete stream is not a complete assistant receipt.
4. For each tool, classify read-only/mutating/external/unknown. Unknown defaults
   to mutating. Commit the tool intent, arguments, authority revision, resource
   writer and any relevant before/expected-after observation.
5. Obtain and commit any required approval correlated to run/epoch/tool-call/
   argument hash. An approval is for those exact arguments; edited arguments
   require a fresh intent. Cancelled/old-epoch approvals cannot execute.
6. Commit dispatch intent, then invoke the EXISTING tool executor. Pre/post hooks
   capable of mutation are effects too; they cannot run before durable admission.
   Recheck the target/resource and tool-specific before observations after any
   approval wait. Record external drift; writer admission covers managed runs
   only and cannot stop an unrelated editor or PTY from changing the files.
7. Commit tool receipt plus typed history/checkpoint update in one transaction,
   before acknowledging durable completion or sending the next model request.
8. Settle raw usage through the canonical usage ledger bridge, then its reservation.
   Durable assistant/tool input and budget blockers must be settled before continuation.

Group tool-use/result blocks and provider reasoning according to each adapter's
valid replay grammar. The native collector already preserves provider envelopes;
do not parse signed content as instructions or discard fields the adapter needs.
SDK handling must use its declared supported state format, not native assumptions.

### 4.2 Crash and uncertainty matrix

| Crash/cancellation point                                  | Required recovery                                                                                                                                   |
| --------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| Before durable prepare                                    | No run may start. A repeated operation resolves or creates the same prepared identity.                                                              |
| After prepare, before provider start                      | Safe prepared run; resume/start only after explicit epoch admission.                                                                                |
| Reserved, provably not dispatched                         | Release reservation with a durable not_sent receipt.                                                                                                |
| Dispatch intent committed, network delivery uncertain     | Request outcome/usage unknown; do not infer unspent and do not blindly issue an identical paid retry.                                               |
| Assistant tool call received but not durably complete     | Execute no tool from the provisional response.                                                                                                      |
| Tool intent/approval committed, no durable dispatch claim | Safe to admit dispatch once under the same epoch, after authority revalidation.                                                                     |
| Dispatch claim committed, before actual mutation          | Indistinguishable after crash from mutation with a missing receipt; reconcile, do not assume it never ran.                                          |
| MUTATION SUCCEEDS, process crashes before durable receipt | Mark effect unknown and run needs_reconciliation. Preserve files/branch and block automatic mutation/retry.                                         |
| Durable receipt/checkpoint committed, UI event lost       | Reproject the receipt by seq; never execute the completed tool again.                                                                               |
| Usage appended, DB settlement missing                     | Locate the exact usageId/requestId and settle once. Conflicting/partial ledger evidence remains blocked.                                            |
| Stop requested while process/tool runs                    | Persist fence, revoke admission, stop/drain processes and SSH collectors. Release writer only after acknowledgement or report needs_reconciliation. |
| SDK/SSH disconnect with no durable acknowledgement        | Interrupted/unknown, not completed or safely cancelled. A new epoch cannot acquire that resource yet.                                               |

For supported file writes, capture existence/type and before hash and the expected
post-write content hash BEFORE dispatch. Reconciliation may observe the exact
expected content and record observed_applied, with fresh provenance; this is not
a recovered original stdout/exit code. If the file differs, keep it unresolved.
Do not treat matching local files as proof that an arbitrary shell command or
external publication had no additional effects.

For bash, MCP mutations, SDK-owned tools, hooks and external operations without
a proven reconciliation method, require explicit inspection/acknowledgement.
A user can accept an unknown outcome and create a fresh semantic continuation,
but the record must retain that uncertainty/reason. Never offer a hidden
automatic replay. Replaying an HTTP operation is safe only when that specific
API and adapter implement a stable idempotency contract; an argument hash is
not a universal idempotency key.

### 4.3 Checkpoint validation, privacy and migration

A checkpoint includes schemaVersion, run/epoch/seq, adapter ID/version, protocol
version, provider/model identity, endpoint/billing reference identities, manifest/
tool-policy/MCP hashes, execution-resource binding, context projection version,
typed messages, F2 attachment asset references, complete tool correlation and
pending-effect states. Validate
hashes, monotonic sequences, sizes, allowed roles, unique tool IDs and complete
use/result pairing before replay. Parse unknown provider envelope JSON only as
bounded inert data; adapters consume only their own namespaced payload.

A newer schema or incompatible adapter is read-only. A failed checksum or
malformed sequence quarantines the original and offers diagnostics/explicit
semantic continuation; it never silently becomes an empty session. Migrations
are transactional, additive/versioned, fixture tested and preserve the source.
Never fabricate typed state for legacy transcript JSON: mark legacy_semantic.
Existing conversations stay readable. No startup migration calls a provider.

Do not persist API keys, auth headers, refresh tokens, password/key material,
credential-bearing endpoint URLs or environment dumps. The private checkpoint
CAN contain user code, tool results and opaque provider replay data: exact replay
cannot be achieved by redacting bytes in place. Treat it as sensitive local
application data with explicit new-runtime disclosure, OS user-only access and
no cloud sync/export by default. Do not claim encryption at rest unless a real
audited implementation is added. Credential-bearing resume handles are keyring
references, never public summary fields or ordinary checkpoint credentials;
nonsecret adapter replay identifiers remain private checkpoint state.

The durable attachment service is the planned [F2 asset contract](./02-agents-flow.md#durable-drafts-and-assets),
not an optional second vault. H2 depends on F2B durable assets for turns with
attachments; F2A session-only staging cannot support typed restart. F2 owns
decoded-byte validation, private byte storage, reattachment and retention UI.
H2 stores opaque asset IDs, immutable digest/size metadata and durable pins for
its operation/messages/checkpoints. It never duplicates image bytes in the
journal, transcript or localStorage. The F2 implementation and runtime journal
owner coordinate one asset-ref table/actor transaction; no separate launch or
asset-ownership database is introduced.

Commit validated asset bytes through F2 before committing the preparation pin.
A crash between file commit and reference commit can leave an unreferenced
asset, not a falsely prepared run. A missing/corrupt asset during pinning,
checkpoint validation or replay blocks typed execution before provider spend.
Hash, filename, excerpt and transcript placeholder are not substitutes for the
bytes. Reattach only if exact digest/type/size validation succeeds; a changed
image is new explicit intent. Semantic continuation requires visible omitted-
evidence disclosure and renewed user intent; it never happens automatically.
Draft-chip removal cannot unpin a saved message/checkpoint or unknown operation.
F2 garbage collection checks committed draft/message/runtime/checkpoint refs
and pending intents before deletion. Cross-store crash recovery preserves
ambiguous assets until reference scans reconcile; it never evicts them to meet
a draft staging cap. Conversation deletion releases refs only after the runtime
retention/reconciliation rules permit it.

Public summaries contain hashes/counts/IDs and sanitized blockers only. Export
uses an allowlist: timings, IDs, route labels, outcome grades and explicitly
selected redacted source excerpts. Opaque reasoning and auth material are never
exported. Redacted exports are evidence, not replayable checkpoints; changing
the private checkpoint to redact it invalidates replay and its hash.

Default private terminal payload retention is 30 days, bounded by the limits in
section 3. Never prune active runs, unacknowledged effects or unresolved billing
evidence merely to satisfy retention. Retain minimal reconciliation/accounting
records until resolved. Archive is not delete. Delete cancels/drains first and
respects execution-resource borrowers; it never deletes owned worktree files
as a side effect of removing conversation history. Backup uses SQLite's backup
API or a quiescent closed database, not a live database-file-only copy.

## 5. H4: request reservations and canonical usage reconciliation

The new database is canonical for admission/liability, not a second raw usage
ledger. Store estimates and reservations separately from actual vendor amounts.
Never add a reservation or provisional debit into existing actual Flight/session
cost rollups. The existing parent/reviewer/session-history attribution remains.

```ts
type BudgetDisclosure = {
  version: 1;
  enforcement: "reserved_request" | "soft_turn" | "none";
  pricing: "known" | "free" | "unknown";
  budgetRootRunId: string;
  policyRevision: string;
  reservedUsdMicros?: UsdMicros;
  actualUsdMicros?: UsdMicros;
  unresolvedLiabilityUsdMicros?: UsdMicros;
  maxRequestsRemaining?: number;
  uncertainty?: string;
};

type RequestReservation = {
  version: 1;
  reservationId: string;
  requestId: string;
  runId: string;
  budgetRootRunId: string;
  billingIdentityRef: string; // opaque account/connection identity, not a secret
  scopeWindowIds: string[]; // immutable scope + period identities at admission
  pricingSnapshotId?: string;
  maximumInputTokens?: number;
  maximumOutputTokens: number;
  reservedUsdMicros?: UsdMicros;
  state: "reserved" | "dispatching" | "settled" | "released_not_sent" | "closed_unknown";
};
```

### 5.1 Admission and cap strength

An atomic transaction checks actual committed charges plus all active
reservations plus closed-unknown liabilities against EVERY applicable scope,
then reserves once. Child-local limits are additional ceilings, never new money.
Two concurrent requests cannot reserve the same remaining allowance.
Period scopes freeze their actual window identity and policy timezone at
admission; crossing midnight or restarting cannot free an old reservation or
charge a late receipt twice in a different window. Historical-window liabilities
remain visible/reconcilable, while a genuinely new period uses its own cap plus
all applicable continuing conversation/Flight/account scopes. Never infer a
provider subscription reset window from a local daily budget period.

For a native metered request with a known rate and defensible token upper bound,
reserve the worst supported input/output/reasoning/cache charge and set output
limits before dispatch. Reconcile raw usage using provider-specific bucket
semantics from the existing pricing seam. An estimate is not an upper bound.
Billing prices/rounding or provider behavior outside a verified contract mean
the UI describes a local bound, not a vendor invoice guarantee.

For an SDK hiding its internal model calls, declare soft_turn. V1 checks before
the SDK turn, enforces exposed turn/count limits and cancels when observable
limits are reached, but does NOT promise per-request dollars. A strict USD
policy must reject such a route unless a tested adapter hook can reserve before
each internal request with sufficient input/output bounds. Do not infer that
the installed SDK exposes such a hook. Network retry attempts that can be billed
need their own request/reservation; transport retries cannot silently multiply
one allowance.

Unknown-priced metered routes are blocked under a strict dollar policy. An
explicit per-run policy may permit them with token/request/wall-clock limits and
an unknown-pricing disclosure; there is no inferred dollar guarantee or fake
zero-priced usage. Known local/free routes use explicit pricing evidence, not
model-name guesses. Changing billing class, account, endpoint or model requires
a new manifest/admission; no silent paid fallback.

### 5.2 Cancellation, abandoned requests and restart

- Cancel before any dispatch claim: release with durable not_sent evidence.
- Cancel after dispatch may have occurred: retain liability until final usage or
  verified rejection/not-sent evidence arrives. Aborted stream is not proof of no charge.
- Process restart: never expire outstanding reservations to zero. Inspect current
  request state, retained usage evidence and owned cleanup before permitting more work.
- After cleanup is acknowledged but usage remains unavailable, close the open
  reservation as closed_unknown with a clearly labelled provisional liability
  up to its reserved upper bound. This is not an actual UsageEntry or invoice.
  It stops a permanent in-flight lock without manufacturing extra allowance.
- Reconciliation can replace that liability with verified actual usage or an
  explicit user/admin resolution with reason/evidence. Record an append-only
  adjustment; do not rewrite historical actual usage or silently erase liability.
- If no defensible monetary upper bound existed, strict USD admission would
  already have refused the route. Soft-policy unknown requests close with
  unresolved token/request counts and explicit cost uncertainty.
- A cleanup failure remains needs_reconciliation and retains the writer even
  after provisional cost closure. Money reconciliation does not stop a process.

### 5.3 Bridge to usage.jsonl

Add optional, defaulted runId, requestId, usageId, parentRequestId and
billingIdentityRef fields to UsageEntry; older rows remain valid and unbound.
Define append_usage_once under the existing ledger lock: an exact existing
usageId with the same canonical receipt hash is a no-op; a mismatched duplicate
or truncated/corrupt row fails closed. Do not use timestamps or model names as
deduplication keys. Existing pending journals and health errors remain authoritative.

Sequence: save raw provider usage receipt in requests -> append_usage_once ->
mark usage committed and settle reservation. There is no cross-file transaction.
A crash before/after append is resolved by exact ID/hash evidence and existing
pending-write validation. If the filesystem journal cannot establish whether
the row was appended, preserve evidence and block rather than appending twice.

Runtime requests may finish after cancellation or another writer failure:
preserve all late receipts and keep historical owner attribution. SDK aggregate
usage gets an aggregate usage ID and source classification; do not invent
per-request rows or count both an aggregate and its constituent rows.

## 6. H5/H3: capabilities and context accounting

A capability snapshot freezes what the route/adapter actually knows. It never
grants execution authority; MCP trust, permission posture, project/host identity
and the tool allowlist remain separate intersected gates.

```ts
type CapabilityKnowledge<T> =
  | {
      state: "supported";
      value: T;
      source: "adapter_contract" | "provider_metadata" | "verified_override";
    }
  | { state: "unsupported"; reason: string }
  | { state: "unknown"; reason: string };

type CapabilitySnapshot = {
  version: 1;
  id: string;
  provider: string;
  model: string;
  transport: "native" | "sdk";
  adapterVersion: string;
  endpointIdentityHash: string;
  billingIdentityRef: string;
  observedAt: number;
  expiresAt?: number;
  tools: CapabilityKnowledge<{ parallel: boolean }>;
  vision: CapabilityKnowledge<true>;
  structuredOutput: CapabilityKnowledge<true>;
  reasoning: CapabilityKnowledge<{ controls: string[]; outputBudgetSemantics: string }>;
  contextWindow: CapabilityKnowledge<number>;
  maxOutput: CapabilityKnowledge<number>;
  restart: CapabilityKnowledge<{ mode: "typed" | "semantic"; formatVersion?: string }>;
  budgetAdmission: CapabilityKnowledge<"per_request" | "turn_only">;
};

type ContextAccounting = {
  version: 1;
  snapshotId: string;
  windowTokens?: number;
  promptTokens?: number;
  countKind: "exact" | "upper_bound" | "estimate" | "unavailable";
  reservedOutputTokens: number;
  reservedReasoningTokens?: number;
  safetyMarginTokens: number;
  truncated: false; // no silent mutation of required input
  omittedOptionalItems: number;
  blockers: string[];
};
```

Freeze adapter/version + endpoint/model identity when prepared. Later metadata
changes cannot silently alter a running run. Expiry causes revalidation before
a new request; changed authority or incompatible behavior blocks rather than
mutating its manifest. A verified user override can document a non-security
capability, but cannot override a denied tool, host pin or hard budget condition.

Minimum behavior: unsupported vision never silently drops an attachment;
unsupported reasoning controls fail or require an explicit changed run option;
unknown tools/structured outputs/context bounds remain unknown. Read-only/SSH
tool filtering remains in force even if the model supports a tool in principle.

### 6.1 Context projection algorithm, v1

1. Build a private context snapshot from durable typed history and frozen prompt/
   tool/authority inputs, not from a mutable React transcript.
2. Obtain the model window/output semantics from the capability snapshot. Apply
   an adapter tokenizer or tested conservative upper bound; otherwise label the
   estimate and refuse strict guaranteed-fit mode. Include system text, tool
   schemas, provider serialization overhead, images and opaque envelopes.
3. Reserve output/reasoning capacity according to that adapter's semantics.
   Never subtract reasoning twice if it shares the completion allowance.
4. Pin user objective, constraints, instruction precedence, active plan,
   unresolved approvals/effects and all current tool-use/result groups. Treat
   opaque replay blocks as indivisible. They are not a source of user instructions.
5. Select optional context using existing scoped lexical memory/retrieval and
   file/symbol references, with canonical host/path and revision/content hashes.
   Preserve existing exclusions for sensitive sources and source provenance.
   No embeddings, graph database or broad automatic codebase dump in v1.
6. Omit/retrieve again the lowest-priority optional material first. Never truncate
   required user instructions or split tool-result pairings to fit a window.
7. If the pinned set cannot fit, enter blocked_context before dispatch. Offer
   an explicitly reviewed smaller selection or a semantic continuation; do not
   submit an overflowing request and rely on provider truncation.
8. A later compaction feature creates a versioned SummaryArtifact with source
   seq range, hashes and authoring method. Its summarizer is a separately
   admitted/budgeted request. It may replace only complete resolved history
   groups allowed by the adapter; retain private source history. Start with
   deterministic omission/retrieval and add model summaries only after evals.

Changing files after a checkpoint does not restore old files. inspect_runtime_resume
reports changed HEAD/known file observations and stale excerpts. Read-only
refresh can construct a new context snapshot; pending mutation uncertainty still
requires reconciliation. Changing host/path/project or accepting a different
provider/model is a fresh explicitly linked run, not a hidden typed resume.
SSH project guidance must be read on the registered pinned host, never from a
desktop path with the same string.

## 7. H6/H7: manifests, child roles and adapter boundaries

RunManifest v1 freezes root user intent hash, previous/parent/root IDs, project/
execution resource, provider/model/endpoint/billing identity, native or SDK
adapter/protocol versions, app source identity when available, profile/harness
revision and prompt hash, effective tool-schema hash, MCP trust snapshot hash,
context policy version, budget policy/rate snapshot, and timestamps. Private
payload references stay local; public manifest exposes non-secret identity and
digests. A hash provides reproducible identity, not evidence that an outcome is
correct or the contents safe.

Record correlated request/tool/approval timings, durable outcome and interruption
reason; do not log raw prompt/reasoning/credential bodies. Link actual usage by
usageId/requestId, and retain builder/reviewer/child distinctions. SDK aggregates
remain aggregates. Do not mix provider allowance/plan resets into token cost
estimates; integration-track quota records are separate evidence with their own
source/observed/stale fields.

SubagentRoleSpec v1 is an immutable role ID/revision, explicit provider/model/
billing route, allowed read-only tools, output schema, maxRequests/maxOutput/
duration ceiling, root budget reference and context policy. Default role may
inherit the exact parent route, but must say so. Remove the ignored model field
or honor a validated model override; do not keep an advertised no-op.
Cross-provider/account fallback requires explicit route admission and disclosure.

SubagentResult v1 contains childRunId, status completed/incomplete/blocked/failed/
cancelled, summary, typed findings, evidence references (path/host/revision or
tool receipt), usage linkage and incomplete reason. Evidence is untrusted output;
it cannot grant tools or overwrite root instructions. Keep existing recursion,
tool intersection and denied-mutation floors. No child shell/edit authority is
added by this track. Existing custom-agent definitions use this same role
resolver instead of another policy ladder.

### 7.1 Native versus SDK enforcement

| Contract                     | Native route                                                 | SDK route at v1 rollout                                                                                                                   |
| ---------------------------- | ------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Typed provider input         | Existing ChatMessage/ContentBlock history can be journaled.  | Only a tested versioned adapter export/resume format qualifies. A token or text seed alone is not equivalent.                             |
| Tool mutation intent/receipt | Wrap the existing executor and approval broker.              | Journal before SDK-owned mutation through a tested hook/handshake; otherwise interrupted work is semantic/unknown and cannot auto-resume. |
| Request budget               | Reserve before every native model request and child request. | soft_turn unless a real before-request hook with required bounds is verified.                                                             |
| Context fit                  | Native serializer/accounting is visible.                     | Do not claim fit where SDK owns hidden context/compaction. Expose its declared evidence and limits.                                       |
| Cancellation                 | Existing local/SSH guards plus journal drain.                | Require SDK cancellation and remote supervisor acknowledgement; state may remain stopping/unknown on disconnect.                          |

Current sidecar protocol is v12. New journaled tool/admission handshakes require
a versioned extension and explicit feature negotiation. Proposed v13 messages
include runId/epoch/requestId, before_effect(effectId,digest), effect_admission,
effect_receipt and optional before_model_request/reservation response. A child
must wait for admission, not merely emit a notice after executing. Sidecar
schema/codec/supervisor/remote bootstrap and tests change together.

An older sidecar may continue only through explicitly supported legacy semantics
when policy allows; it cannot ignore required safety fields for a journaled run.
Refuse the stronger mode if the handshake/features are missing. Raise the global
minimum protocol floor only when the coordinator has shipped the security
contract across bundled and SSH sidecars; never weaken the current v12 trust floor.
No claim that a particular installed SDK exposes all proposed hooks is made here.

## 8. H1: same-executor regression and evaluation seam

Extract the production runner behind RuntimeServices: provider/SDK transport,
ToolExecutor, PermissionBroker, Journal, Budget, Context, Clock and EventSink.
Keep Tauri as an adapter. The headless entry point invokes the same native runner
or existing SDK handler factory; it does not implement its own request/tool loop.

Use the offline-by-default `runtime-eval` Cargo example and versioned fixture
cases. Run it with `cargo run --features runtime-eval --example runtime-eval -- --all`
or `pnpm acceptance:runtime-eval`. It lives in `src-tauri/examples/runtime_eval.rs`
so Tauri's production binary discovery cannot accidentally include this
developer-only CLI. Mock
providers implement the existing LlmProvider stream contract and replay recorded
synthetic events; they are not another agent runtime. Any accidental network/
keyring/ambient MCP dependency fails the offline test. Live evaluation requires
an explicit provider/account/target selection and spend policy; never run it as
part of routine tests or on a developer's real project/profile.

EvaluationCase v1 specifies caseId/version, repository fixture + starting commit,
task input, execution binding, harness/config digest, budget, verifier identity
and outcome criteria. RunResult records manifestId, repetitions/seed where
applicable, correctness, infrastructure errors, incomplete/blocked status,
interventions, time and actual/provisional/unknown spend separately.
A model-authored assertion is not a passing grade.

Use disposable copies, empty scoped homes and no production credentials/MCP.
For real mutating model trials, isolate the executor in a disposable container
or equivalent restricted account; hide grading material outside the agent's
mount/authority. A Git worktree alone is not OS isolation, and unrestricted bash
can otherwise read a supposedly hidden grader on the same host. Keep platform-
specific Windows/SSH tool fixtures in the regression lane and report the exact
environment; browser-only tests cannot establish native shell/SSH acceptance.

Start with deterministic recovery/capability/budget cases, then a proposed 20–30
held-out tasks with three trials/configuration. Compare one change at a time to
the same model/route baseline. Predeclare quality/nonregression and cost/latency
thresholds before live trials; do not invent a parity score or discard failures.
The harness result corpus contains redacted evidence, not a training dataset.

## 9. Implementable work packets and ownership

A packet is a unit of ownership, not permission for several agents to edit the
same integration file concurrently. The coordinator assigns one current owner
and serializes shared contract/call-site windows. Workers must not revert other
tracks. Existing Flight, profile, MCP, provider mapping and pricing fixtures stay.

| Packet                                                  | Dependencies                                                       | Exclusive implementation ownership for its assigned agent                                                                                                                                                                                                              | Deliverable / meaningful regression                                                                                                                                                                                                                                           |
| ------------------------------------------------------- | ------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R1 Contracts + one journal                              | Global project/launch contract agreed with UX                      | New core/runtime_types.rs, core/runtime_journal.rs and runtime_journal tests. Coordinator owns serialized patches to api/mod.rs, lib.rs, commands/mod.rs, tauri.ts, generated schema and optional conversation projection fields.                                      | Transactional migrations, actor, operations/runs/resources/IDs. Same operation+digest returns same IDs; changed digest fails; cancel during provisioning never revives; one writer across borrowed resources; power-loss/truncated DB fixtures fail closed.                   |
| R2 Same runner extraction + deterministic adapter tests | R1 minimal types                                                   | New core/agent_runtime/ and exclusive api_agent.rs refactor window; existing provider/tool modules are wrapped, not rewritten.                                                                                                                                         | Tauri and headless fake provider execute the same runner. Event/permission/error/cancel behavior remains compatible. Full native tool and SSH drain regressions pass before further behavior changes.                                                                         |
| R3 H2 intents/checkpoints/restart                       | R1, R2                                                             | New core/runtime_checkpoint.rs and commands/agent_runtime.rs; journal schema extension by the R1 owner or one coordinated handoff. api_agent.rs integration remains with the current runtime owner. UX integrates client use in its owned launch/resume orchestration. | Crash injection around every boundary in section 4; especially mutation success before durable receipt. Exact completed tools never rerun; unknown effects block; stale epoch/permission rejected; legacy transcript explicitly semantic; corrupt/newer checkpoint preserved. |
| R4 H5 capabilities + H6 manifest identity               | R1, R2                                                             | New core/runtime_capabilities.rs and core/runtime_manifest.rs; coordinator serializes LiveModel/LlmRequest/API DTO extensions and tauri.ts/schema changes. Integration owner supplies SDK capability evidence.                                                         | Supported/unsupported/unknown is round-tripped; no silent image/control drop; endpoint/model/policy change cannot reuse incompatible checkpoint; manifest remains resolvable after settings edits.                                                                            |
| R5 H4 request admission + ledger bridge                 | R1–R4                                                              | New core/runtime_budget.rs; exclusive commands/usage.rs + focused pricing/cost attribution integration window; runtime owner integrates per-request native/child admission. SDK owner owns only sidecar provider/protocol hooks when proven.                           | Parallel near-limit requests, child/shared scopes, cancellation before/after wire, missing usage, crash after ledger append, duplicate receipt IDs, unpriced policy, SDK soft-limit disclosure, late usage after cancellation.                                                |
| R6 H3 context projection                                | R3–R5                                                              | New core/runtime_context.rs and context fixtures; runtime owner integrates request construction. Existing memory/context functions are reused through adapters; no general memory redesign.                                                                            | Counts include schemas/images/opaque payloads; pairings/instructions survive; required overflow blocks before spend; omitted optional content recorded; SSH context never reads desktop aliases; semantic compaction is versioned and charged.                                |
| R7 H7 explicit role resolver + SDK parity lane          | R3–R6                                                              | core/tool_subagent.rs, core/tool_custom_agent.rs, role resolver tests. Existing aux_llm routing is changed only in an assigned serialized window. SDK owner handles agent-sidecar/protocol/provider changes with Rust supervisor owner.                                | No ignored model field, inherited route explicit, invalid route before spend, structured incomplete outcome, denied write tools remain denied, recursion/budget/cancel inherited, root/child usage not duplicated.                                                            |
| R8 H1 task suite + rollout proof                        | R2 deterministic lane can start early; live comparison waits R3–R7 | src-tauri/examples/runtime_eval.rs (feature-gated Cargo example), runtime_eval fixtures/results schema and scripts/acceptance/runtime-\* helpers. Gate catalog/package-script changes belong to the coordinator.                                                       | Same-executor fixture parity, mandatory crash/unknown-effect cases, redacted exports, held-out trials with all failures retained, local + pinned SSH + declared SDK limitations.                                                                                              |

Frontend shared source cannot be owned wholesale by two agents. Runtime supplies
agentRuntimeClient.ts and DTOs; the UX owner applies the prepared/start/cancel/
resume/fork projection changes to agentTaskStore.ts and React flows in a scheduled
window. Future integration workers must obtain the same coordination for
agent-sidecar protocol/provider files and the Rust supervisor. Do not generate
schemas while another worker runs tsc/Vitest against that file.

R1 serializes the F2 asset-ref schema lease with the UX asset-service owner.
R3 typed checkpoint/replay for attachment-bearing turns depends on F2B durable
bytes/pins; text-only checkpoint fixtures can proceed earlier. F2A session-only
staging must not be represented as durable attachment recovery.

## 10. Regression matrix, gates and delivery proof

Required deterministic regressions are behavior/fault tests, not assertions
mirroring JSON field names:

- Operation retry/cancel at every await, crash after provisioning before receipt,
  altered draft revision, ID collision and startup listener failure.
- Complete root turn 1; prepare turn 2 in the same owner-valid conversation;
  prove a pre-dispatch failure; deliberately retry with new operation/run plus
  retryOf and latest previousRunId; restart the successful retry at a new epoch.
  The conversation remains the same, completed turn 1 is retained, no duplicate
  provider dispatch occurs and shared liability does not reset. A stale revision,
  mismatched owner, unknown turn-2 dispatch or same-ID failed-operation resend
  cannot admit that retry. A failed initial launch instead requires a distinct
  new initial conversation ID.
- Pin an F2 image in a prepared run/checkpoint; remove its draft chip and restart.
  The bytes remain and replay validates their digest. Missing/corrupt bytes block
  before spend; a replacement image needs renewed intent. Interrupted pin/GC
  and conversation deletion cannot remove an unresolved checkpoint's asset.
- Tool succeeds and then receipt commit fails: no automatic replay, files remain,
  error survives restart; observed-applied reconciliation is visibly different
  from an original tool receipt.
- Duplicate/out-of-order tool IDs, incomplete tool-result pairs, malformed/oversized
  opaque data, newer schema and changed provider/model/endpoint/policy/pin.
- Stop while awaiting permission, native stream, local child, SSH grandchild,
  child subagent and SDK tool. Missing acknowledgement blocks writer/restart.
- Concurrent shared-scope budgets; request dispatched but no usage; reservation
  released only on proven not_sent; duplicate/partial ledger writes and delayed
  usage reconcile once; provisional liability is not actual cost.
- Context below/at/above window; large tool schema, image and signed-envelope
  overhead; no dropped objective or half tool pair; scoped retrieval provenance.
- Default read-only child authority cannot be broadened through definitions,
  model output, MCP annotations or a newly changed Settings snapshot.
- Export and deletion cannot expose raw reasoning/auth data or delete a borrowed
  worktree. Pruning cannot free an unresolved writer or erase billing liability.
- Journal unavailable/full/corrupt and interrupted migrations fail before paid
  dispatch or mutation. No fallback to an unjournaled execution path.
- Existing Flight review/ownership/cap/recovery/immutable delivery fixtures pass
  unchanged; these safety fixes are neither weakened nor reimplemented.

While iterating, run only the affected new Rust module/integration filters,
the modified native/provider/sidecar regressions and focused store tests.
Examples for future implementation (not executed for this document):

```text
cd src-tauri
cargo test --lib runtime_journal
cargo test --lib runtime_checkpoint
cargo test --lib runtime_budget
cargo test --test runtime_recovery
cargo test --lib core::tool_runtime_ssh::tests
```

An ignored real SSH case requires an explicitly selected disposable pinned
fixture; ordinary cargo test must not discover user profiles or call providers.
Run full sidecar smokes after its protocol/provider work, and generate/check
Tauri schema after contract changes. Frontend runtime/launch/receipt tests belong
in the correct Vitest node/dom project; do not move environment guards to make
tests pass.

Before the merge/release handoff, the coordinator runs pnpm gates:changed,
then pnpm gates:full at the final integrated source; avoid redundant simultaneous
Cargo/schema/sidecar/Vite jobs. See [local gate runner](../local-quality-gates.md)
for contention, schema generation and web-mode Playwright limits. Record actual
commands, source/hash, platform and skipped gates; a planned test is not a pass.

A final installed native proof must exercise local and pinned SSH launch,
approval, mutation, Stop, restart, unknown-effect reconciliation, reviewed
continuation and delivery without losing work. SDK proof states the actual
restart/budget strength. Capture latency, interventions, context preservation,
priced/unpriced usage and evidence paths. No provider can be called by a
headless fixture merely because an API key exists on the developer's machine.

## 11. Rollout and revert

1. Land schema/types and disabled journal reader/fixtures. Existing conversations
   remain readable; take a quiescent migration backup and verify restoration.
2. Extract the production runner with no user-visible behavior change; compare
   deterministic traces and all current safety gates.
3. Opt in native journaled new runs first. Enforce intents/receipts, epoch fences,
   resume validation and budget disclosure together; no partial safety claim.
   Legacy runs stay explicitly semantic and are not silently reclassified.
4. Enable strict reservations only for verified native route/count/pricing
   combinations. Other routes remain explicitly soft/unsupported under a strict
   policy. Enable SDK journaled execution only after handshake/receipt proof.
5. Add context/role improvements one policy revision at a time using the same
   evaluation lane. Retain the previous policy for new runs only; active runs
   keep their frozen manifest and authority.
6. After native local/SSH and appropriate SDK proof, enable by default for new
   sessions. Do not switch an active run's executor/format in place.

A kill switch denies NEW journaled admission while preserving inspectors,
cancel/drain, reconciliation and export. It never sends an unresolved run into
the legacy executor to make it appear available. Reverting UI code cannot erase
new journal blockers. Before downgrading to an older binary that knows nothing
about the journal, stop/drain all owned work, reconcile unknown effects/usage,
close or explicitly export needed continuations and back up the journal plus
usage evidence. An old binary is not claimed to honor new fences.

No schema down-migration deletes runtime evidence. Keep a forward-readable
minimal summary when disabling payload features. If migration cannot be
completed, open the existing data read-only and report the blocker; preserve
the original files. Roll back a policy revision by selecting an earlier policy
for a NEW run, not by modifying a completed manifest or rewriting vendor usage.

## 12. Narrow technical research and remaining proof obligations

These references support failure/durability choices; they do not establish
implemented support or re-copy the broader landscape review.

- [SQLite atomic commit](https://www.sqlite.org/atomiccommit.html), official
  living documentation, retrieved 2026-10-20 UTC. Database atomicity depends on
  filesystem/storage assumptions and does not encompass a tool's external side
  effect. Proposed consequence: full-sync durable intent/receipt transactions
  with explicit unknown outcomes, not an exactly-once claim.
- [SQLite WAL](https://www.sqlite.org/wal.html), official page last updated
  2026-08-25, retrieved 2026-10-20 UTC. WAL requires same-host coordination and
  the page identifies a WAL-reset fix in 3.51.3/later or listed backports.
  Proposed consequence: one connection, rollback journal for v1; any future WAL
  change verifies the actual bundled engine/version and adds its own migration
  and concurrency proof. This review did not execute SQLite version queries.
- [AWS Builders' Library: making retries safe with idempotent APIs](https://aws.amazon.com/builders-library/making-retries-safe-with-idempotent-APIs/),
  official engineering article, retrieved 2026-10-20 UTC; no publication date
  asserted. Caller intent/request identity must be stable and retry semantics
  explicit. Proposed consequence: operation IDs and request/receipt hashes,
  without treating arbitrary shell/MCP effects as idempotent.

Implementation-time proof obligations, with bounded defaults already chosen:

- SDK-specific export/resume and before-request/mutation hooks must be verified
  against the actual locked versions. Until then their modes remain semantic/
  soft_turn; no undocumented SDK behavior is a dependency.
- No universal tokenizer/rate bound is assumed. Strict fit/USD admission stays
  unavailable for unknown combinations until an adapter proves it.
- Filesystem fsync/locking behavior and SQLite corruption/full-disk recovery
  require Windows and macOS/local-filesystem tests; SSH effects need the actual
  pinned remote acknowledgement path. Linux/container results do not prove Mac
  or Windows native behavior.
- Runtime-private data protection and default retention disclosure need UX/
  security review. Exact replay requires retained bytes; exports are redacted
  separately. Do not promise ciphertext storage without implementing it.
- Cross-track coordinator signs off the AgentProjectRef, launch operation,
  execution-resource/fork, run summary and schema ownership contracts before
  parallel implementation begins. Remaining product preferences do not justify
  weakening the chosen fail-closed safety defaults.

No tests/builds/providers/accounts were exercised while authoring this handoff.
Only this assigned runtime design file is owned by this author.
