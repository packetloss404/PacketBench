# Agents and runtime implementation handoff

Prepared October 19, 2026 (America/Chicago; research also retrieved October 20
UTC). Original design baseline: `e5d31084e5d2c4861723dca4d4c2931a64b0f732`,
with review/documentation changes that were uncommitted at preparation time.

**October 24 verification: substantial implementation slices are committed and
pushed through `922ddcc9`; the full target remains partial and latest installed
source is not verified.** Read [current status](../current-status.md) and the
[packet-by-packet audit](../documentation-audit-2026-10-24.md) before executing
the remaining work. Remote Agents is now the highest product implementation
priority. This document preserves the target design; it is not proof that all
contracts are implemented/enabled. [backlog.md](../../backlog.md) is the task ledger.
Packet definitions here specify the work; they are not another checked backlog.

## Start here

Read the local `AGENTS.md`, [current handoff](../../HANDOFF.md),
[full review](../agent-harness-and-experience-review-2026-10-19.md) and this file.
Then read the track you own and the cross-track acceptance contract:

- [Runtime design](./01-runtime.md): typed continuation, effects, reservations,
  context/capabilities, run identity, subagents and production-executor tests.
- [Agents flow design](./02-agents-flow.md): launch/draft/history isolation,
  stable projects, attention, reader position and keyboard input.
- [Appearance and accessibility](./03-appearance-accessibility.md): typography,
  contrast, scale, code, action targets, sidebar and constrained layouts.
- [Integrations and evidence](./04-integrations-and-validation.md): N1 hang
  diagnosis, usage provenance, optional browser verification and official
  ChatGPT-plan feasibility boundaries.
- [Agent dispatch and acceptance](./05-agent-dispatch-and-acceptance.md): role
  prompts, file leases, gates, native scenarios and delivery requirements.
- [R2b decision record](./06-r2b-decisions-and-plan.md): historical extraction
  decisions; the source extraction is committed.
- [Current transport limitations](./07-sdk-limitations.md): actual opt-in and
  native/SDK evidence boundaries.
- [Historical implementation notes](./09-implementation-notes-through-2026-10-24.md):
  former HANDOFF narrative; current audit/status supersedes stale claims.

The installed 0.14.9 executable now has hash `b91c617d…cfaa1f9` and matches the
available October 23 NSIS payload, but no source/payload manifest ties it to
October 24 HEAD. The October 19 `0b6dbf52` package is historical. The current
process responds at rest; navigation/restart/native acceptance and N1 diagnosis
remain unverified. See HANDOFF/current status for exact evidence.

## Scope and exclusions

Implement repairs and design improvements to the existing application. Preserve
the daily CLI Workspace, structured Agents conversations, and explicit Flight
review/delivery workflow. They remain distinct surfaces using shared contracts.

**Composer research has moved to another thread.** This package excludes model
training, open-weight adaptation, Composer comparisons, a branded competitor
agent and a new commercial harness product. Existing-runtime evaluation is
included to verify correctness and reliability; it is not a Composer program.
Do not assign agents to redo that research or make those experiments a dependency.

Also excluded: autonomous Flight planner revival, a graph editor/database,
new billing dashboard, a remote relay/auth program, hosted CI, broad provider
expansion, or unrelated refactors. Official ChatGPT-plan support is a bounded
later feasibility packet; it is not assumed shipped or enabled by this plan.
No provider credentials, user projects or installed application state should
be altered merely to prepare the work.

## Architectural decisions for this implementation

These are concrete proposed choices. Reopen one only when a fresh source check
or test demonstrates an incompatibility; record the reason and amend all
affected specs before changing a shared contract.

### D1: One backend authority and journal

The runtime owns launch idempotency, run epochs, tool/effect receipts, checkpoints
and spend reservations in one local SQLite journal using the repository's
existing rusqlite dependency. The frontend transcript stays a display projection;
`usage.jsonl` stays the canonical raw usage ledger. Do not create another agent
loop, a frontend authority store or a separate launch database.

Use a dedicated connection actor off the UI thread, short transactions and the
runtime spec's durability configuration. The journal never lives on an SSH
filesystem. SSH tools operate through the existing pinned execution boundary.
The runtime owner implements journal schema/migrations; the coordinator owns
cross-language exports and command registration.

### D2: Project, execution, conversation and run are different identities

- `AgentProjectRef` is the stable base-project grouping identity. A worktree
  does not become a new project; SSH identity includes host record plus repo.
- `ExecutionBinding` is the exact immutable target of a run: local/SSH,
  base path, selected worktree, verified host pin and relevant revision.
- `executionResourceId` records the owned checkout plus borrower references.
  A journal writer token excludes concurrent PacketBench-managed writers on
  the same resource. It is not a filesystem lock against user editors, PTYs or
  external programs; validate revision/file baselines to detect outside drift.
  Borrowed checkout cleanup cannot delete its owner's work, and unresolved
  effects are never unlocked merely by a timeout.
- `conversationId` is stable readable history. A genuine Fork creates a new
  conversation and records its parent; transcript rewind preserves a revision.
- `operationId` deduplicates one launch transaction with its payload digest.
  Repeating it returns the same IDs, rather than starting another agent.
- `runtimeRunId` identifies one root user turn, all its model/tool rounds and
  children. Restart continues that ID at a new CAS epoch; a follow-up creates
  another run linked to its predecessor. Provider session IDs remain separate.

The root run binds shared budget scopes. Child agents inherit that root, not
duplicated spending allowance. All commands and asynchronous events identify
the operation/run/conversation/epoch needed to reject stale updates.
The runtime spec is the canonical wire-type definition. The flow spec references
it rather than maintain a second incompatible DTO. Initial conversation creation
and a new turn in an existing conversation have distinct validated admission.
Network retransmission returns the same operation's current state; a deliberate
retry of a proven failure creates a new linked operation/run. Unknown dispatch
or effect outcomes require reconciliation before either path can execute again.

### D3: Launch freezes intent; failure does not broaden it

Prepare validates a frozen provider/model, project/execution target, authority,
draft revision and budget binding. `prepare_runtime_run` records the operation
before dispatch. `start_runtime_run(expectedEpoch)` is the one start boundary.
Flow orchestration is frontend-owned; backend validation/idempotency is
runtime-owned. Cancellation leaves a tombstone and late success is reconciled.

An isolated launch failure stays failed. Offer Retry or a distinct explicit
project-checkout operation with a new identity. Never quietly fall back to the
root checkout, another host, billing class or provider. The current API-agent
events remain canonical; extend them coherently rather than add a competing bus.

### D4: Recovery reports what is known

`RuntimeRunSummary` is the public backend snapshot. The smaller additive
`AgentConversationRuntimeProjection` exposes run identity, `runtimeState` and
`resumeMode` (`typed`, `semantic`, `none`) to conversation state. Use the canonical
runtime definitions rather than retype the summary as the conversation DTO.
Secrets, provider replay envelopes and raw effect receipts stay backend-owned.

Typed recovery validates model/endpoint, target and frozen authority. A crash
after a mutation may leave an ambiguous outcome: reconcile or request attention,
never blindly repeat. Semantic continuation is labelled as transcript context
with current files, and cannot imply restored files or exact runtime replay.

### D5: One appearance owner, one scale application

Add `appearanceStore`, schema version 1, under `storageKey('appearance')`:

```ts
type AppearancePreferencesV1 = {
  schemaVersion: 1;
  uiScalePercent: 100 | 110 | 125 | 150 | 175 | 200;
  transcriptFontSizePx: number; // integer base size, 13..22, default 15
  density: "comfortable" | "compact";
  agentSidebarWidthPx: number; // base CSS width, 240..480, default 300
};
```

The control label is **App scale**. Let `S = uiScalePercent / 100`.
`resolveAppearanceMetrics` computes final absolute CSS font values once:
transcript = selected base × S; other nonterminal fonts = their base × S.
Thus 15px becomes 30px at 200%; 22px becomes 44px. Do not nest CSS zoom,
transforms or a second font multiplier. Sidebar width is a layout preference,
not another text multiplier; clamp to the available viewport.

`appStore.theme` remains the sole theme owner. Tool expansion/verbosity remains
separate. Add separately owned `terminalSettingsStore.terminalFontSizePx`,
integer10..32/default13, persisted with `storageKey('terminal-font-size')` while
preserving the existing shell key. A Terminal text size control updates live
xterm font/fit without restarting the PTY. Source does not establish such a
control already shipped. One root hook applies appearance; Monitor subscribes without
writing preferences or remounting active sessions. The appearance spec defines
the exact metrics, shortcuts, migration and viewport behavior.

### D6: Honest usage and capability disclosure

Reserve request spend in the backend; report enforcement strength rather than
claim hidden SDK requests have a hard cap. Model capability values are
supported/unsupported/unknown with provenance, not booleans that silently
interpret missing data. Distinguish provider-reported quota, application policy,
measured tokens and estimated dollars. Existing PTY Codex percentage readings
do not establish a reset window or full allowance when missing.

### D7: Shared files have one writer

Behavior changes land before visual application in Composer/sidebar/context/
review files. Runtime journal/module work can proceed alongside isolated
appearance-token work. The coordinator serializes all edits to
`agentTaskStore.ts`, `AgentConversation`, `tauri.ts`, generated schema,
`lib.rs`, protocol DTOs and the shared UI files. Agents submit precise edits
through that owner; they do not each run a broad formatter or regenerate schema.
See the dispatch document for the lease schedule.

## Work order and release boundaries

### Wave 0: Rebase the plan onto reality

Inventory current source, local modifications, installed source identity and
active user sessions. Preserve unrelated local edits, including separate Composer research. Reconcile
source changes and contract names before implementation; never assume the old
PID/window or an earlier snapshot is still current. Capture an isolated backup
of relevant state before migration tests. Run focused baseline tests without
opening/control-locking the desktop.

Start N1 evidence collection. Source-only repairs can proceed independently;
native release readiness cannot close while responsiveness remains unexplained.
If a later fresh session cannot reproduce N1, record the negative result and
remaining uncertainty rather than claim a causal fix.

### Wave 1: Protect work and make it readable

First deliver fail-closed worktree launch, complete draft identity, genuine
fork/preserved rewind, launch deduplication/cancellation and IME/history safety.
Runtime journal/effects/checkpoints and request reservations proceed in parallel
with shared typography/contrast/scale foundations. P1 safety is not scheduled
behind P2 interface polish. Immediate root-checkout fallback prevention must
not wait for every later runtime capability to be complete.

Merge small vertical slices through an integration branch. Each slice keeps
existing constructors and historical conversations readable. New checkpoint/
reservation guarantees remain unavailable for a route until its adapter passes
the corresponding tests; no misleading success badge is permitted.
For F2, the first useful slice scopes the complete in-memory draft by identity
and reports attachment rejection; keyed remount alone is insufficient because
it loses the original draft. Durable asset service/pins follow before typed
image recovery is enabled. Retain missing-image blockers rather than claiming
the minimal scope repair already supplies crash-durable attachment replay.

### Wave 2: Complete continuity and runtime contracts

Land stable project grouping, contextual New, exact attention targeting,
search/reader restoration and the visual application under serial UI leases.
Add model-window/context/capability manifests, run attribution and explicit
subagent roles. Reuse the production executor for fixture evaluations.

### Wave 3: Prove the whole existing flow

Run the integrated gates and source-identified local/Linux Docker SSH journeys,
including Stop, restart/continue, ambiguous-tool recovery, approval over review,
repair, fresh evidence, delivery and archive. Recheck existing Flight/Workspace
contracts without reimplementing their completed overhaul.

Windows and Mac have separate native evidence. Browser fixtures do not close
native WebView, process cancellation, font fallback, credential or SSH gates.
If Mac hardware is unavailable, leave that claim open explicitly.

### Wave 4: Bounded later integrations

Only after the core flow is stable, evaluate supported browser verification
and official ChatGPT-plan transport. Each has explicit local scope, threat
boundaries, adapter-strength disclosure and a stop decision. Neither blocks
core Agents repairs nor authorizes Composer research.

## Coverage of the full review

- N1: responsiveness diagnosis and native evidence → integration spec.
- F1–F8: Agents scope/drafts/history/startup/projects/attention/search/input → flow.
- V1–V8: scale/contrast/settings/code/targets/names/sidebar/reflow → appearance.
- H2/H4: typed recovery and request admission → runtime first safety tranche.
- H3/H5/H6/H7: context/capabilities/attribution/subagents → runtime contracts.
- H1: same-executor evaluation of the existing runtime → runtime and acceptance.
- H8/H9: rendered-app verification and evidence-backed usage → integrations.
- Official ChatGPT-plan opportunity → later feasibility packet, no retired ID reuse.
- Composer/model development → explicitly outside this package.

## Exit criteria for the future team

Deliver the assigned packets, their tests and a whole-flow review with exact
source/package evidence. An incomplete platform/provider gate remains open;
do not convert simulated coverage or an earlier release's pass count into proof.
Update backlog status and HANDOFF with what actually changed, tested and remains.
Build/install only when application inputs changed and that execution task
includes workstation installation. Do not repeat an installer for docs alone.

Current preparation validation is limited to design peer review, document
formatting, link/reference checks and a documentation-only diff. It is not
validation of any proposed DTO, migration, security property or new application
behavior. The dispatch document contains the precise future verification steps.

Preparation checks passed: installed Prettier on all six package documents and
the full review; 133 relative source/document links and six local heading
anchors across those seven documents; `git diff --check`; and an independent
recalculation of the appearance palette's minima across both sets of five
surfaces. An independent design review found and cleared four material contract
conflicts (wire types, retry identity, durable assets and existing-turn admission).
No product gates or native/provider checks were run in this documentation pass.
The separate Composer thread's files were preserved and excluded from this
package's validation and implementation scope.
