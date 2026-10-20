# Flight runtime and experience review — 2026-10-19

Review date: 2026-10-19. Git baseline:
`4698ca9c4ce848e4cfe6ddfb0648ea360256ef5e` (0.14.9). The working tree already
contained the loop/graph research and changed during this review as the
authorized runtime repairs were implemented. Source references identify the
reviewed functions; line numbers describe the review-time source and can move.

Scope: a separate team reviewed the existing Flight runtime, GUI components,
and end-to-end product journey while the implementation team repaired review
freshness, reviewer cost attribution, and reviewer retry limits. This is a
dated assessment and proposed overhaul, not a second task register. Open work
belongs in [`backlog.md`](../backlog.md).

The owner subsequently authorized implementation in the recommended order.
The implementation follow-up at the end of this document supersedes proposal
status for the completed source changes. Native/provider acceptance and the
adoption baseline remain separate evidence requirements.

**Evidence boundary:** this review inspected repository source. It did not
inspect a rendered native Flight workflow, call a paid provider, alter user
data, or complete a packaged local/SSH acceptance matrix. The owner reports
that Flights are not used. The adoption causes below are hypotheses supported
by implementation evidence; no usage funnel or productivity gain was measured.
The earlier research is in
[`loop-and-graph-engineering-alignment-2026-10-19.md`](./loop-and-graph-engineering-alignment-2026-10-19.md).

## Recommendation

Make the first useful Flight a single scoped change: **send work from a
Workspace or issue, run it in an isolated branch, and receive a result that is
easy to review and land.** The first overhaul slice should be:

```text
Workspace / issue → brief → run → attention → review → Land / Open PR → archive
```

Keep Workspaces as the daily surface, as required by
[`ROADMAP.md`](../ROADMAP.md), lines 9–11. Keep the current Flight CRUD/runtime
separation, worktree isolation, independent review, bounded remediation,
pinned SSH targets, and explicit landing. Prove this complete path before
making cooperative execution the main pitch. Comparing alternative solutions
and dividing one change across a task graph should be explicit advanced
choices with different explanations.

The strongest adoption hypothesis is the amount of workflow a user must learn
before receiving this basic benefit. The interface currently asks users to
configure a multi-agent system, navigate between planning and execution, and
interpret several overlapping completion concepts. Visual restyling alone
will not resolve that.

## Current journey

1. **Find a starting point.** Global New → New Flight and Flight Deck's New
   flight open the same launch dialog. Global creation is implemented in
   [Toolbar.tsx](../src/components/layout/Toolbar.tsx), lines 201–207 and
   323–331. The empty Flight Deck explains worktree attempts and offers New
   flight in [FlightsView.tsx](../src/components/views/FlightsView.tsx), lines
   254–278.
2. **Configure execution before creating the work item.** The dialog is titled
   "Launch parallel agents". It starts with no selected target, a prompt,
   optional title, target/branch/provider/model rows, supervision choices,
   draft-PR publication, and optional independent review. The prompt explains
   that every agent runs the same prompt independently. See
   [LaunchAsyncFlightModal.tsx](../src/components/flights/LaunchAsyncFlightModal.tsx),
   lines 93–122 and 566–764.
3. **Choose direct launch or a planning detour.** Plan first creates a
   read-only API-agent conversation, links it to the Flight, and navigates to
   Agents. The user returns to Flight Deck and applies the latest structured
   plan. See `handlePlanFirst`, lines 394–462, and
   [FlightPlanningCard.tsx](../src/components/flights/FlightPlanningCard.tsx),
   lines 35–55.
4. **Discover cooperative execution later.** A cooperative graph card appears
   only once milestones exist. Enabling it assigns defaults; each task then
   has provider/model/path controls and ready tasks can be launched. This is
   different from the launch dialog's independent attempts. See
   [CooperativeFlightCard.tsx](../src/components/flights/CooperativeFlightCard.tsx),
   lines 39–119 and 203–276.
5. **Supervise a long detail page.** Statistics, planning, supervision,
   PacketAgent handoff, issue mirroring, cooperative graph, coordination
   inbox, attempt chats, attention, output review, milestones, and timeline
   share one vertical stack. Attention and output appear after attempts. See
   `FlightDetailPane` in [FlightsView.tsx](../src/components/views/FlightsView.tsx),
   lines 728–754.
6. **Accept and deliver in separate actions.** Accept sets the attempt to
   completed and removes its worktree; the branch remains. Land and Open PR
   then appear as separate actions. The Flight can already display done. See
   [AttemptTile.tsx](../src/components/flights/AttemptTile.tsx), lines 154–160,
   374–418, and 487–499, and `computeStatusFromAttempts` in
   [flightStore.ts](../src/stores/flightStore.ts), lines 71–93.

### Contextual entry is incomplete

An Agents conversation's Add to Flight action links a reference to an
**existing** Flight. With no active Flights, the modal tells the user to create
one in Flight Deck first. It does not convert conversation context into an
execution brief. See
[AddConversationToFlightModal.tsx](../src/components/agents/AddConversationToFlightModal.tsx),
lines 53–60, and `linkConversationToFlight` in
[agentHandoffs.ts](../src/lib/agentHandoffs.ts), lines 267–303.

Local issue details assign to existing Flights, with no create-and-run handoff
at that point: [IssueDetail.tsx](../src/components/issues/IssueDetail.tsx), lines
458–499. GitHub's Plan flight button stages a Flight from the issue body and
navigates to Flight Deck; its feedback then instructs the user to click Launch
attempt. It does not start a planning conversation. See `handlePlanFlight` in
[GitHubView.tsx](../src/components/views/GitHubView.tsx), lines 1016–1043.

Workspaces have a global New Flight entry, but their ordinary delegation
handoff opens Agents. A contextual Send to Flight should carry project/host,
task text, source issue, and relevant approved context directly into the brief.
It should not require the user to create a Flight elsewhere first.

### API execution has a billing boundary

Flight builder and cooperative provider selectors use `API_PROVIDERS`.
Workspace panes use PTY CLIs and may use subscription logins. A Workspace
Claude/Codex login does not authenticate an API Flight. The brief must show the
actual API provider/model and usage implications before launch. Inherit
project, host, and base branch from Workspace; inherit provider/model only from
a compatible API context, otherwise use an authenticated API default with a
visible choice. Do not revive retired API transports or silently reinterpret a
subscription CLI as an API provider. The existing separation is documented in
[`AGENTS.md`](../AGENTS.md), "Conversation Tiles & Sidecar".

## Runtime repairs already authorized

The accompanying implementation repairs three existing contracts:

- **Freshness:** the backend captures the entire committed attempt HEAD, a
  pinned base, and frozen objective/prompt/criteria/task context. The reviewer
  receives that commit range and context. Recording a pass, accepting a result,
  cooperative integration, and later delivery validate this identity. Dirty,
  staged, and untracked changes must be committed or removed before review;
  oversized required criteria fail explicitly instead of being omitted.
  Unbound legacy passes become retryable errors. Delivery uses the reviewed
  commit so a later branch update cannot substitute unreviewed code.
- **Accounting:** reviewer sessions are registered before provider startup in
  a durable owner/provider/model ledger. Native and sidecar usage lookup keeps
  that ownership across retries and verdict resets, including delayed usage
  from an earlier reviewer. Actual reported usage is attributed; unavailable
  usage or pricing is not invented.
- **Retries:** automatic reviewer retries have a persisted per-attempt count
  independent of the bounded action log, exponential backoff (1–60 seconds),
  and the existing `maxReviewRounds` cap. The allowance is saved before a
  provider can start; exhaustion requires attention. Policy changes and
  Pause/Stop/runtime disposal are rechecked during startup. Manual retries
  remain explicit actions.

An accepted attempt's worktree is already removed. If its retained branch
changes, delivery is blocked and the verdict becomes an error. The tile
explains recovery and retains explicit override; it does not offer a reviewer
retry that cannot run on the removed worktree. Reconstructing a review worktree
or launching a new reviewed attempt directly from this state belongs in F05/F06.
Implementation results and final gates are recorded in Verification status.

Exact-state freshness does not itself establish independent test execution.
The reviewer is read-only; builder-reported checks remain contextual evidence
unless an execution adapter independently captures them. Combined integration
verification also remains a separate proof obligation. The repaired identity
checks bind individual attempts; final cooperative `land_flight_integration`
still delivers its integration-branch ref. A final verified integration SHA
must be pinned before that path can promise an independently verified combined
deliverable, including protection from commits added directly to that branch.

## Prioritized findings and acceptance criteria

The priorities below express impact in this dated review. They do not authorize
all proposed code changes or establish a delivery schedule.

### F01 — P1: preserve work during interruption and make Stop complete

**Observed:** startup recovery demotes queued/provisioning/running attempts and
hands them to a sweep. The sweep calls cleanup that reaches forced worktree
removal. Committed branches survive, but dirty and untracked work can be lost
on restart without the normal decision dialog. See
[orchestrator.rs](../src-tauri/src/core/orchestrator.rs), lines 118–136,
`sweep_interrupted_attempts` in
[flight_attempts.rs](../src-tauri/src/commands/flight_attempts.rs), lines
975–1004, and `remove_local_worktree` in
[worktree.rs](../src-tauri/src/core/worktree.rs), line 669.

Stop also filters cancellation to queued/provisioning/running attempts. A
reviewer or remediation call can be active while its attempt remains reviewing.
The backend attempt cancellation path closes the builder session, not every
Flight-owned session. See `stopFlightAutonomy` in
[boundedAutonomyRuntime.ts](../src/stores/boundedAutonomyRuntime.ts) and
`cancel_flight_attempt` in
[flight_attempts.rs](../src-tauri/src/commands/flight_attempts.rs).

**Change:** preserve interrupted dirty worktrees for inspection/recovery;
separate stopping sessions from discarding files. Define Stop for all
Flight-owned builder/reviewer/remediation sessions and drain in-flight starts.

**Accept when:** restart preserves committed, staged, unstaged, and untracked
work; the UI offers inspect/resume/discard with the exact path; Stop during
review, remediation, provider startup, and builder execution stops all owned
sessions and cannot launch a replacement afterward. Cover local and pinned
SSH behavior without inventing a resumable backend session after restart.

### F02 — P1: keep graph identity through retries and plan revisions

**Observed:** `reassignAttempt` rebuilds an execution spec without the failed
attempt's `taskId`, then launches `flight.prompt`/objective instead of the
task-specific prompt. The retry can become a generic attempt rather than
progressing its DAG node. See [asyncFlightStore.ts](../src/stores/asyncFlightStore.ts),
lines 272–298 and 1695–1722; compare the task-aware launch at lines 1733–1788.

Apply latest plan replaces all milestones and resets status to ready.
`materializeFlightPlan` generates new task IDs, while existing attempts keep
their old IDs. `integrateCooperativeAttempt` checks that a task ID exists on
the attempt, but not that it still belongs to the current plan; `patchTask`
silently finds no matching task. Old work can integrate without completing any
node in the new graph. The freshness repair rejects an existing pass when its
task context changes, but task membership still needs explicit validation for
ungated, overridden, or newly reviewed orphan attempts. See
[FlightPlanningCard.tsx](../src/components/flights/FlightPlanningCard.tsx), lines
43–47 and 83–85; [flightPlanning.ts](../src/lib/flightPlanning.ts), lines
182–206; and [asyncFlightStore.ts](../src/stores/asyncFlightStore.ts),
`integrateCooperativeAttempt` and `patchTask`, lines 326–333 and 385–441.

**Change:** retries must preserve task identity, scope, ownership, and the
task-specific execution brief. Initially block wholesale plan replacement
once execution exists. Later support explicit versioned revisions with stable
IDs and reconciliation; reject integration from an orphaned/stale task.

**Accept when:** a failed graph task retries its own brief and completes its
original node; dependent tasks become ready; applying the same plan twice does
not erase live/completed work; execution-time replacement is blocked with an
explanation; a stale task attempt cannot merge silently.

### F03 — P1: use a delivery state that matches the user's finish line

**Observed:** attempt rollup takes precedence over task/issue state. A
completed first graph attempt can yield done while later nodes remain pending.
For independent attempts, accepted already means done before landing.
Completion memory/retrospective capture uses that derived state. See
[flightStore.ts](../src/stores/flightStore.ts), lines 71–93, and
`captureFlightCompletionOnTransition` in
[asyncFlightStore.ts](../src/stores/asyncFlightStore.ts), lines 955–988.

**Change:** distinguish execution, review readiness, acceptance, integration,
and final delivery. For cooperative execution, require all required nodes to
be integrated before final review/landing. Preserve explicit landing or PR
state so reopening the app does not depend on a transient tile message.

**Accept when:** accepting the first node of a two-node dependency graph leaves
the Flight active; reviewable/accepted work remains visibly ready to land;
landed or published results show the actual destination and result; completion
notifications and learning capture fire only at the defined lifecycle event.

### F04 — P1: make target and model selection work for current providers

**Observed:** builder and cooperative model selectors map
`API_PROVIDERS.models` directly. Named API providers intentionally have no
bundled models; the default provider is Sugar. These selectors do not use the
live model resolution already used by the reviewer selector. A field can be
empty or unable to offer a valid model even when another surface has a live
catalog. See [MultiTargetPicker.tsx](../src/components/flights/MultiTargetPicker.tsx),
line 276; [CooperativeFlightCard.tsx](../src/components/flights/CooperativeFlightCard.tsx),
line 251; and [api-models.ts](../src/lib/api-models.ts), `DEFAULT_API_AGENT` and
the named provider rows.

SSH selection uses `server.remotePath ?? ""`; the comment promises an editable
path input, but picked rows render branch/provider/model controls and no path
input. A server with no default path has no way to specify the repository in
this dialog. See [MultiTargetPicker.tsx](../src/components/flights/MultiTargetPicker.tsx),
lines 139–142 and 234–289.

**Change:** share the established live catalog/auth/model capability selector
with Agents and reviewers. Show and edit the selected project path, especially
for SSH. Validate a real repository/base branch before launch and retain input
after failure.

**Accept when:** Sugar and each live-only provider have meaningful loading,
missing-key, unavailable-catalog, valid-model, and tool-capability states;
restored model values remain intelligible; a pinned SSH server without a
default remote path can select a repository and launch a disposable attempt.

### F05 — P2: provide one brief and a continuing execution path

**Observed:** creation defaults to no target and independent parallel attempts.
Plan first requires a selected execution agent before planning; applying the
plan and enabling the task graph are later separate actions. Once an attempt
exists, `AsyncFlightGrid` renders the grid without a launch affordance; Launch
attempt is confined to its zero-attempt state. See
[LaunchAsyncFlightModal.tsx](../src/components/flights/LaunchAsyncFlightModal.tsx),
lines 303–320 and 618–621, and
[AsyncFlightGrid.tsx](../src/components/flights/AsyncFlightGrid.tsx), lines 15–33
and 52–62.

**Change:** contextual create-or-reuse handoffs, project-scoped brief, one-agent
assisted default, optional inline plan preview, and an explicit Run again/Add
alternative action after a first attempt. Put comparison and cooperative
execution behind an explicit mode choice. Show outcome, scope, checks,
provider, and bounds before advanced options. Replace YOLO with wording that
describes bounded automatic actions.

**Accept when:** a Workspace/issue user can create and launch a scoped Flight
without visiting Flight Deck first; defaults match the current project; a
failed first attempt can be retried or a new alternative added without making
a duplicate Flight; planned tasks can be inspected and edited before launch.

### F06 — P2: make attention and review the main work, with real evidence

**Observed:** integration configuration and statistics precede the actual work
and attention. The separate Output review card lists reported/owned paths;
attempt review summarizes findings/messages without a first-class code diff
and check evidence view. Users must reconstruct whether the result is useful.
See `FlightDetailPane` and `OutputReviewCard` in
[FlightsView.tsx](../src/components/views/FlightsView.tsx), lines 728–754 and
819–913, and [AttemptTile.tsx](../src/components/flights/AttemptTile.tsx).

**Change:** a stable header with outcome, project/branch, lifecycle state, and
one next action. Immediately below it, show the reason for attention and the
action needed. Use a primary work/review region plus secondary activity/details.
Move PacketAgent, issue-mirror, and unused execution setup into relevant
secondary settings. Review must combine summary, diff, checks, reviewer
findings, evidence freshness, and delivery destination.

**Accept when:** from the top of the page a user can identify what is happening,
what they must do, and what will happen next; an approval jumps to its exact
item; a failed check shows its output; no review badge implies execution of a
check that was only builder-reported. Local and remote diffs work from the
same review journey. Evidence capture against the combined integration tree
is proved separately before claiming verified end-to-end delivery.

### F07 — P2: make summaries and navigation agree with the lifecycle

**Observed:** grouping places only spec in Drafting; draft/planning/ready fall
into Recent, and review falls into Active. Approval statistics count task
approval state, which does not represent every attempt/reviewer waiting state.
Output review can display ready whenever there are no pending task approvals,
even with no reported files. See `classifyGroup`, `StatGrid`, and
`OutputReviewCard` in [FlightsView.tsx](../src/components/views/FlightsView.tsx),
lines 155–162, 849–877, and 931–945.

**Change:** derive list grouping, header, attention count, and primary action
from the same lifecycle projection. Use Draft / Running / Needs you / Ready
to land / Delivered or equivalent clear product language. An empty result
should say no result yet. Preserve internal compatibility status values behind
the projection.

**Accept when:** list/detail/Monitor agree on paused, interrupted, reviewing,
accepted, landed, partially failed, and cancelled cases; counts lead to actual
actionable items; no incomplete Flight is presented as ready or delivered.

### F08 — P2: allow ordered tasks to touch the same files safely

**Observed:** `validateCooperativeAssignments` checks owned-path overlap across
every task pair without considering dependencies. A builder and a downstream
test/fix task that intentionally change the same files are rejected even
though they cannot run together. See
[cooperativeFlight.ts](../src/lib/cooperativeFlight.ts), lines 151–169.

**Change:** evaluate write conflicts for tasks that may execute concurrently.
Permit ordered ownership reuse while keeping unordered overlap blocked. Show
the relevant dependency/ownership reason beside the tasks.

**Accept when:** A → B with overlapping paths runs serially and receives the
integrated predecessor state; independent A/B with overlapping paths cannot
run concurrently; cycles/missing dependencies remain rejected. Keep repair
loops outside the acyclic dependency graph.

### F09 — P2: verify the complete layout and keyboard flow

**Observed:** attempt grids use a 380px minimum column width; cooperative rows
have several fixed/minimum-width columns; small text and unlabeled native
controls are common. Disabled choices and async actions rely heavily on
tooltips/local inline feedback. These are source risks, not measured render
failures. See [AsyncFlightGrid.tsx](../src/components/flights/AsyncFlightGrid.tsx),
line 55; [CooperativeFlightCard.tsx](../src/components/flights/CooperativeFlightCard.tsx),
line 206; and [MultiTargetPicker.tsx](../src/components/flights/MultiTargetPicker.tsx),
lines 241–289.

**Change:** responsive single-column states, readable primary text, persistent
labels, keyboard-operable mode selection, explicit pending/error/success
states, and announced async feedback. Restore focus to the initiating action
when closing a plan/review/confirmation surface.

**Accept when:** the complete launch → approval → failed review → repair → land
journey works by keyboard; no primary action or selected project/model is
clipped at supported narrow window widths; screen-reader names identify every
input/action; busy operations cannot duplicate; failures leave a useful retry
path. Confirm in the packaged WebView as well as DOM/component tests.

## Proposed flow in more detail

1. **Send to Flight from context.** Create or reuse a Flight with project/host,
   branch, source issue, task text, and intentionally selected context. Preserve
   ordinary Agents conversations and the CLI-first Workspace boundary.
2. **Approve a brief.** Outcome, scope, acceptance checks, agent/model, target,
   usage bounds, and delivery preference are the main fields. Auth/path/model
   failures explain a concrete repair. Advanced options are collapsed.
3. **Optionally refine a plan.** Preview human-readable steps in the Flight and
   validate the structured result. Permit edits before execution. After launch,
   use a protected/versioned revision path rather than replacing task records.
4. **Run and supervise.** One status and next action explain progress. Put
   attention ahead of logs. Keep transcripts, graph details, and history
   available without making them the default reading task. Stop preserves work.
5. **Review the result.** Show changes and evidence together, including stale
   or unavailable evidence. Request a repair in context. Distinguish model
   review from executed checks and show what the human is accepting.
6. **Deliver.** Land or Open PR against the stated destination. Persist the
   result and handle conflicts in the same flow. Completion follows the actual
   delivery contract, not the first accepted builder.
7. **Archive and clean up.** Show retained branches, worktrees, PRs, and recovery
   material. Archive retains the record; deletion/discard explains its effect
   separately. Do not use deletion as the routine finish action.

### Keep, simplify, defer

- **Keep:** isolated attempts; `flightStore`/`asyncFlightStore` ownership;
  reviewer gates; bounded remediation; restart pause; pinned SSH; issue and
  conversation references; action history; explicit landing.
- **Simplify the default:** one agent, assisted mode, inherited project,
  outcome/checks before agent machinery, one attention queue, one review area.
  Keep publishing, supervision policy, and external handoffs accessible as
  secondary controls.
- **Keep as explicit expert choices:** independent alternative solutions and
  cooperative task execution. Their cost/coordination implications differ.
- **Defer:** general graph editor, another planner/scheduler, dynamic graph
  rewriting, recurring discovery, recipe marketplace, and new execution
  transports. Do not revive the removed autonomous Planner runtime.

## Phased overhaul

**Phase 0 — trustworthy runtime.** Build on the three scoped repairs above.
Address work preservation, complete Stop, stable
task identity, and accurate completion before widening automatic execution.
Use disposable repositories with deterministic failing/passing checks and
record exact source/package/target identity. Existing packaged local and
pinned-SSH proof obligations remain open until executed.

**Phase 1 — one complete vertical slice.** Workspace/issue → brief → one-agent
run → attention → review → Land/Open PR → archive. Include the current-provider
model picker, editable SSH path, relaunch, honest lifecycle projection, and
keyboard/narrow-layout coverage. Reuse the existing runtime and avoid a broad
store or navigation rewrite.

**Phase 2 — planning and cooperative work within that lifecycle.** Add editable
plan preview, protected revisions, stable IDs, task-specific recovery, ordered
ownership reuse, and dependency/blocker explanation. Verify the combined
integration tree. Show graph structure when it explains a blocker; do not
require users to become graph operators for a single change.

**Phase 3 — evidence-led expansion.** Add reusable briefs/recipes or more
execution choices only after owner tasks demonstrate repeated value. Compare
cooperative execution with the same class of single-agent work; measure cost,
elapsed time, human intervention, and successful delivery. No speed or savings
claim follows from agent count alone.

## Owner dogfood and success measures

Use a small set of real tasks the owner would otherwise perform in Workspace:
a bug fix with a deterministic regression check, a UI change, a task started
from a local issue, a provider/model failure with retry, and a pinned-SSH change
when an appropriate disposable target is available. Include a deliberate
restart with dirty/untracked work, Stop during review/remediation, stale review
evidence, and a landing conflict in controlled fixtures.

For each task, record whether the user could identify the next step without
instruction, where they abandoned or returned to Workspace, and what manual
repair was necessary. Ask whether they chose a Flight for the next comparable
task. This tests adoption directly; a completed demonstration alone does not.

Measure the local funnel: contextual entry → brief completed → successful
launch → reviewable result → delivered/PR → second Flight. Record launch
failure/abandon reason, time to launch, time waiting for attention, human
interventions, retry/review rounds, successful delivery cost, and
cleanup/recovery failures. Separate API cost from PTY subscription use and
show unknown pricing as unknown.

Existing dogfood counters include linking a Flight and opening its Workspace
or Monitor, but not this lifecycle funnel. See
[workspaceAgentsDogfoodStore.ts](../src/stores/workspaceAgentsDogfoodStore.ts),
lines 4–33. Extend local evidence deliberately; do not assume these existing
counters establish the cause of low adoption. Set quantitative targets after a
baseline and keep payloads free of task prompts, repository contents, and
credentials unless the owner explicitly chooses an evidence export.

## Verification status

This document is a source review with proposed acceptance criteria. It does
not certify a rendered GUI, native responsiveness, provider reliability, SSH
completion, or crash recovery. The reviewed runtime tests exercise portions
of these contracts, but passing focused tests does not prove the full
builder → review → repair → fresh review → delivery journey. The overhaul
findings below were subsequently authorized and implemented; the following
eight-gate record applies to the earlier scoped runtime repairs only. The
overhaul implementation and its separate final validation follow this record.

All eight affected quality-gate categories passed across the initial run and
the focused reruns on October 19:

- `rust:check`, `rust:test`: 1,067 Rust tests passed, 9 intentionally ignored.
- `check:tauri-schema`: the generated Rust/TypeScript schema matches; the
  explicit export test passed.
- `test`: 301 frontend test files / 2,945 tests passed.
- `e2e`: 14 mocked Chromium browser tests passed. The visual-audit cases
  soft-skipped their GitHub navigation step at both viewport sizes; this does
  not certify that view or the native Flight journey.
- `lint:src`, `build`, `typecheck`: passed.

The changed-file selector skipped `format:check`, `remoteagents:check`, and
`sidecar:check` because their inputs were unaffected. Changed frontend sources
and the dated reports received targeted Prettier checks; the final whitespace
check passed. No dependency installation, packaged build, installation, paid
provider call, or live SSH acceptance was performed.

The first frontend run caught a new fixture reimplementing provider mapping;
the fixture now uses the real shared helper. The first browser run lost a page
execution context while a source edit overlapped Vite. Frozen-source sandboxed
restarts then stalled before cases began; the unchanged browser gate passed
outside the sandbox on an isolated local port. Lint and TypeScript were
rechecked after the fixture correction. The project-matching cached pnpm
9.15.4 ran existing installed tools, with temporary files inside the ignored
repository cache.

Raw local logs: [initial affected run](../test-results/flight-runtime-gates-2026-10-19.log),
[full frontend rerun](../test-results/flight-runtime-frontend-rerun-2026-10-19.log),
and [final browser/lint/TypeScript run](../test-results/flight-runtime-final-browser-gates-2026-10-19.log).
The frontend rerun was interrupted only after its complete passing unit-test
result, when the subsequent browser startup stalled. These logs are ignored
local artifacts; the durable result record is this document.

## Authorized overhaul implementation follow-up

The second October 19 implementation preserves the existing Flight runtime and
normal read-only planning conversations. It implements the source overhaul in
the priority order above:

1. **Preservation and complete Stop.** Restart retains interrupted worktrees
   with exact local/SSH paths. Inspect, explicit fresh-session Resume and
   confirmed Discard are separate actions. Stop fences and drains startup,
   builders, reviewers, repair turns and the linked planner. Ownership ledgers
   retain old builder/reviewer cost attribution; replaced builder sessions
   cannot start again. Stop timestamps stay monotonic through an explicit new
   run. Acceptance requires committed clean work and uses non-force cleanup;
   a cleanup refusal retains visible recovery metadata. Deletion first stops
   all owned roles and includes retained terminal attempts; failed Stop keeps
   the Flight record.
2. **Graph identity.** Stable plan-key IDs survive repeated previews. Applying
   a replacement plan after execution starts is rejected in the store and
   native persistence. A task retry preserves its ID, brief, dependency and
   integration branch. Dependency-ordered tasks can share files; concurrent
   writers remain blocked. Orphan/current-task/active-agent checks protect
   final combined delivery.
3. **Truthful delivery.** One lifecycle projection drives grouping, detail,
   approval/attention, active planner state and compatibility status. Accept
   means ready to deliver. Actual Land/PR records establish delivery and
   success memory. Native landing uses the saved reviewed/integration SHA.
   Publication resolves the saved target's effective push origin, pins the
   configured Git host and pushes the selected commit/refspec. Recording an
   already-created PR retries its delivery record without opening another PR.
   Cooperative task PR settings cannot prematurely finish a partial graph.
4. **A usable brief.** Single-agent Assisted is the default. Shared provider
   auth and live model controls support the current provider rows. Repository,
   pinned SSH host, path and base branch remain visible and validated; the
   approved execution target is saved independently of mutable Workspace
   settings. Compare and cooperative execution are explicit advanced choices.
5. **Context and continuation.** Workspace, local issue, GitHub issue and
   conversation entry open the common brief with relevant context and links.
   New attempt remains available after the first result. Failed startup reuses
   its Flight. Planning pre-registers its conversation owner before dispatch,
   can be stopped and never silently restarts execution.
6. **Review and attention first.** The detail page leads with the next action,
   blockers and results. Code, changed paths, builder-reported checks, reviewer
   findings and their code identity share an evidence surface; retained work
   includes tracked working-tree changes and untracked filenames. Repair
   turns invalidate old verdicts and re-enter active work accounting before
   provider dispatch. Combined integration has its own pinned diff and explicit
   final Land action. History and integrations are collapsed. Archive/restore
   preserves results and branches; active owned sessions prevent archive.
7. **Constrained layouts and review.** Loaded Chromium fixtures exercise the
   production Flight components at 1024×768, including keyboard focus, no
   horizontal page overflow, evidence, archive/restore and confirmed retained
   discard. Separate GUI, runtime and final bug-review passes caught and
   repaired cross-flow errors beyond the focused component cases.

**Proof limits:** the browser harness mocks native/provider calls. Hermetic
Rust tests use disposable Git repositories for preservation, freshness,
immutable integration and safe cleanup. No native package was installed, paid
provider turn started, live SSH host changed or adoption improvement measured.
Builder-reported checks and the combined diff are labelled as contextual
evidence; an independent check-execution adapter is not claimed. The remaining
native/SSH delivery and second-Flight dogfood evidence is recorded once in
[`backlog.md`](../backlog.md), rather than duplicating a new proof program here.

### Final overhaul validation

All **nine affected gate categories passed**, across the frozen full changed
run and a frontend rerun after correcting one obsolete test assertion:

- `rust:check` and `rust:test`: **1,083 tests passed**, with 9 intentionally
  ignored across the native suites. These include interruption preservation,
  clean-only acceptance, review freshness, safe landing, repair admission,
  historical-session rejection and monotonic Stop stamps.
- `check:tauri-schema`: **1 export/schema test passed**, generated TypeScript
  matches Rust.
- `test`: **310 files / 3,052 tests passed**. The initial run's sole failure
  expected the old `spec` display label. The corrected compatibility test
  expects the common Draft lifecycle while asserting saved `status: spec`
  remains readable and unchanged. No production code changed for this rerun.
- `e2e`: **17 mocked Chromium tests passed**, including all three new Flight
  flows at 1024×768. The current review screenshot was inspected. The existing
  general visual audit soft-skipped its GitHub navigation substep at both
  viewport sizes; it does not establish loaded GitHub/native acceptance.
- `format:check`, `lint:src`, `build` and `typecheck` passed. Lint retains 9
  existing Fast Refresh warnings and zero errors. Frontend tests, lint and
  TypeScript were rerun after the fixture correction. Final diff whitespace
  and report/test formatting checks passed.

`remoteagents:check` and `sidecar:check` were excluded by the changed-file
selector because no files in their input trees changed. This record does not
claim those gates ran. No dependencies were installed. The final read-only
cross-flow bug review found no additional confirmed blocker after the
historical-session and Stop-stamp fixes.

Local raw logs: [full affected run](../test-results/flight-overhaul-final-gates-2026-10-19.log)
and [passing full frontend/lint/TypeScript rerun](../test-results/flight-overhaul-final-frontend-2026-10-19.log).
These ignored artifacts support this durable result record. The mocked browser
server ran on isolated localhost port 1436 and exited with the completed gate.

### Native local and Docker SSH follow-up — October 19

The owner subsequently authorized building, installing and exercising the full
journey with the configured Sugar/Conduit API provider. The native walkthrough
uses disposable repositories locally and on a pinned Linux SSH server in an
isolated local Docker container. It preserves the existing user profile and
keeps desktop control sessions closed during builds, tests and provider waits.

The local Flight completed Stop, application restart, Resume, an independent
changes-requested review, repair, a fresh passing review, acceptance, Land,
archive, restore and a second archive. Stop occurred while a real tool command
was running: the tracked index, dirty files and untracked checkpoint survived,
and its delayed grandchild did not write after cancellation. Independent tests
passed all four cases on both the reviewed commit and the delivered main tree;
the test file still matches its baseline hash. Land recorded squash commit
`f5495516d41791c5cd2cc3f02276cc83b1a9f966`. Both reviewer sessions and the
historical builder owners remain attributable to the Flight.

The native runs also exposed defects beyond the mocked journey: listener and
startup ordering, resume admission, cancelled-turn settlement, repair admission,
clipped provider menus, interrupted tool rendering, SSH builder inheritance of
unsupported MCP defaults, and warm-origin project history overwriting the
canonical history mirror. Focused fixes and regression checks were added. The
history repair merged the seven original paths with two current paths while
preserving every unrelated mirror value. Three subsequent native boots kept all
nine exact paths. SSH tool advertising also now omits unsupported `edit_file`
before the frozen dispatch allowlist is formed; local tools remain unchanged.

The first actual SSH Stop failed: its grandchild wrote the delayed marker after
Stop despite the retained worktree and cancellation status. The failed attempt
and proof remain intact. This established that the earlier separate SSH client
probe was insufficient. The corrected runner keeps a supervised SSH connection
alive through cancellation, uses a remote process-group lease, and requires a
completion acknowledgement. Stop and Resume wait for owned-command cleanup;
uncertain cleanup blocks a replacement owner. Seven focused SSH tests passed,
including a real `execute_bash` Docker case covering abort, timeout, default
signal behavior, background commands, preservation and SSH failure
acknowledgement.
Built-in remote bash now requires `setsid` and fails explicitly when it is absent;
this acceptance used Linux SSH and does not validate other remote platforms.

The repeated native SSH Stop occurred 30,734 ms into a command whose child would
write at 120 seconds. After 125 seconds both owned processes were no longer
executing, no delayed marker existed, and HEAD, index and all saved file hashes
matched the checkpoint. An app restart preserved the same worktree and a new
builder owner resumed it. A separate intermediate run stopped after its shorter
probe deadline; that run is retained as invalid timing evidence, not counted as
another cancellation failure or a passing proof.

A real provider HTTP 522 then exposed another defect: marking a clean attempt
Failed removed its worktree and recorded misleading accepted-cleanup metadata.
Failed and Cancelled now retain the worktree, committed and uncommitted output,
error, usage and owner history after cleanup is drained. Acceptance now persists
Completed only after cleanup and source/review identity checks succeed. The
native retention/acceptance module passed 33 tests; frontend status hydration,
fallback cleanup and decision-copy regressions passed 104 tests.

The HTTP-522 fixture was restored manually from its exact saved branch and HEAD
before the corrected native build resumed it. This was a scoped fixture repair,
not evidence that the old build automatically recovered the deleted worktree.
Original failure metadata, committed data and owner history remain preserved.
The resumed builder finished the intentionally incomplete first result; an
independent reviewer requested the missing RangeError guard. Send findings
admitted a real repair turn and invalidated the old review. The repaired commit
`8c8bb09051ee5df948aaee703ee6581507ed799d` independently passes all four
unchanged tests and has a clean worktree. A fresh reviewer passed with that
exact source SHA and a new combined evidence fingerprint. Native Accept then
completed non-force worktree cleanup and UI hydration; Land delivered squash
commit `f7d31a167e4aabdfa0bb3b5cd3b65a152e963153` to SSH main. Archive, restore
and rearchive preserved delivery, reviewer evidence, every owner and usage.

The final independent verifier passed for both hosts: four tests on each main
tree and each immutable reviewed commit, unchanged baseline test hashes, exact
checkpoint preservation, absent delayed markers, current review/context
fingerprints, delivery tree identity, archive/restore invariants and usage
rollups. The three owned Flight ledgers match 42,688, 282,834 and 401,351 tokens
respectively, including historical builders and both reviews. Verified Git
bundles preserve the delivered repositories and reviewed source commits. Only
the disposable SSH container was stopped; its filesystem and the failed
attempts remain intact.

One local acceptance action completed native cleanup but left the frontend
showing its busy state until the app reopened. Scoped completion diagnostics
were added; a subsequent local Land completed normally. SSH acceptance then
completed its native request in 3,134 ms, followed by hydration and a settled
frontend action in the same second. The original local busy-state observation
was not reproduced and has no confirmed cause; this successful retest is not
claimed as a diagnosed fix.

The final source review found one additional recovery error-path gap: a native
status request could save Failed/Retained and then reject cleanup, leaving the
frontend on Reviewing until reload. The frontend now refreshes authoritative
state on that rejection before returning the original error. The targeted
regression includes a second hydration failure so it cannot mask the native
error. This companion fix and the SSH tool-catalogue filter follow the live
walkthrough; their validation is source/gate coverage, not a repeated paid run.

The final affected run also found a real cancelled-admission race: rejecting an
old dispatch receipt inside a shared failure catch could mark a newer turn
Failed. Existing-send and restored-resume receipt rejection now happen outside
that failure unwind. The original failing assertion remains unchanged; two
additional receipt regressions verify that cancellation rejects while the newer
turn remains Active with one streaming assistant and no stale error. The
focused restart/queued-send set passed all 29 tests. This final correction is
covered by source tests and the frontend gates, after the paid walkthrough.

Raw local proof is under
`test-results/acceptance/flight-native-2026-10-19/`, including
`local-verify-stop.json`, `local-rearchived-final-proof.json`,
`ssh-first-stop-failed.json`, `ssh-verify-stop.json`, `ssh-final-review.json`,
`final-final-proof.json`, `repository-exports.json` and
`history-preservation-repair.json`. These are
ignored local artifacts. Recorded Sugar token usage has no configured USD
rate, so a zero-dollar ledger is not evidence of free usage or an independently
verified bill. This fixture does not establish WAN reliability, every provider,
Windows SSH, cooperative execution, PR publication or improved adoption.

### Final native follow-up validation and packaging boundary

All ten relevant gate categories passed across the final affected run, the
corrected frontend rerun and an explicit sidecar run:

- Rust check and **1,118 passing native tests**, with 10 intentionally ignored
  across the standard suites. The Docker SSH test is ignored in the standard
  suite but passed in the separate seven-test live-fixture run above.
- Schema export: **1 passing test** with generated TypeScript parity.
- Frontend: **312 files / 3,138 tests passed** after correcting the actual
  cancelled-admission receipt race. The initial affected run failed its one
  original regression; that result is retained, not discarded or relabelled.
- Chromium: **18 tests passed**, including loaded narrow Flight review,
  keyboard archive/restore, retained-work decisions and provider-menu placement.
  The general visual audit still soft-skips GitHub navigation at two widths;
  those cases do not establish GitHub acceptance.
- Formatting, lint, typecheck, production frontend build and sidecar protocol,
  registry, trust and provider-auth smoke checks passed. Lint retains 9 existing
  Fast Refresh warnings and zero errors. Final targeted formatting and diff
  whitespace checks passed. The final read-only review found no further
  confirmed issue after the recovery-refresh and receipt fixes.

`remoteagents:check` was excluded because its source tree is unchanged. Raw
ignored logs are `test-results/flight-native-final-gates-2026-10-19.log`,
`test-results/flight-native-final-frontend-2026-10-19.log` and
`test-results/flight-native-final-sidecar-2026-10-19.log`.

The full paid local/SSH walkthrough ran in native debug builds with the live
frontend, through build E2. The final installer includes the later SSH catalogue,
rejected-status refresh and cancelled-receipt fixes; these received the source
and gate coverage above. The installer receives payload-hash, packaged-sidecar,
normal-launch and persisted-state smoke verification rather than another paid
walkthrough. The source was frozen before canonical packaging so the manifest
identifies the exact source snapshot. The later documentation closeout changes
no application inputs. The installation manifest and final
launch/state results are linked from the ignored local
`test-results/acceptance/flight-native-2026-10-19/installer-update.json` record;
that record, not an older same-version installer, establishes completion of the
installer update.

### Installed-app smoke and workstation handoff

The October 19 local 0.14.9 update is installed and the final smoke check passed.
Both NSIS and MSI built successfully; NSIS installation exited 0 and all **8,683**
installed files match the manifest. Bundled Node is **24.15.0**; the packaged
sidecar passed two protocol-**12** turns. Installed executable SHA-256:
`6a69c35cbbdca49d1b09b5076ceb70bd9ad3b86996a2ac2464965e53b2dc55cb`.

The build's exact source contents were subsequently committed as
`0b6dbf52d2f32fadf190e9b8f88e1c56941a8f2b`. Source SHA-256
`9d313c532e63e5e9fa80bca2668cf572c132ad22baf0b113886402e4115b2d3a`
matches the manifest before and after that commit. Documentation-only closeout
does not require another build. This is a local rebuild of 0.14.9; the existing
release tag is unchanged.

The installed executable opened a responding native window with the packaged
sidecar ready. Its archived local result showed the delivered main SHA, passed
review, usage and Restore action. Independent persisted-state checks confirmed
both local and SSH delivery records, review fingerprints, reviewer owners and
usage totals match the completed walkthrough. All seven original and two recent
project-history paths remain unique with non-regressing timestamps.

All three test Flights are now archived and hidden from the active list. The
installed app is left open on `D:/projects/PacketBench`; the owned inspection
workspace was rebound to that repository. Retained worktrees/branches, failed
attempt evidence and verified Git bundles remain recoverable. The disposable
SSH container is stopped and its filesystem is preserved. Owned development
servers are closed. Each desktop burst ended with the control kernel reset;
desktop control is released.

The canonical manifest and installation evidence live under
`test-results/acceptance/windows/2026-10-20T01-56-47-983Z/` (UTC timestamp).
The fixture evidence directory additionally contains `installed-state-proof.json`,
`installed-app-boot-history-proof.json` and `installed-source-commit.json`.
These ignored artifacts are local verification records and are not published
with the source. README and HANDOFF now describe the current build and the
Assisted brief → review/repair → fresh review → Accept → Land → archive path.
The workstation is ready for owner dogfooding; the broader proof limits above
remain open in the single backlog.
