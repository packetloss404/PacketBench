# Desktop completion team dispatch and acceptance

> Before reusing these original prompts, read [current status](../current-status.md)
> and [the committed-source audit](../documentation-audit-2026-10-24.md).
> Implement the remaining assigned tranche, not already-landed R/F/V slices.
> The owner's later October 24 decision puts desktop/runtime completion and
> acceptance before Remote Agents. [The completion plan](./08-desktop-completion-before-remote-agents.md)
> defines current scope, phases and the exit gate.

Design only, October 19, 2026. Read [the package entry point](./README.md) and
the assigned track before editing product code. [backlog.md](../../backlog.md)
owns live status. Composer research/model development now belongs to the separate
[packetbench-model-lab project](https://github.com/packetloss404/packetbench-model-lab/blob/main/docs/PLAN.md),
at `D:/projects/packetbench-model-lab`. Model training and competitor-agent
development remain excluded from every prompt below.

## Coordinator bootstrap prompt

```text
Complete PacketBench's existing desktop/runtime work and acceptance before
Remote Agents, at
D:\projects\PacketBench. Read AGENTS.md, HANDOFF.md, backlog.md and
dev/agent-experience/README.md, then every affected track specification.
Also read dev/current-status.md and dev/documentation-audit-2026-10-24.md.
Use dev/agent-experience/08-desktop-completion-before-remote-agents.md for the
current phase order and exit gate. The Remote-Agents-first order published in
4da14806 is superseded. Verify already-committed slices and implement only the
current residuals; preserve completed work.

You are not alone in the codebase. Preserve unrelated changes and other
agents' edits. Do not modify, format, stage or commit Composer research or its
pre-existing summary changes in dev/README.md. Inventory current HEAD,
changes, runtime/schema contracts and installed evidence before implementing.
The design used e5d31084; reconcile intervening changes instead of overwriting
them. Create/reuse an appropriate codex/ branch/worktree according to AGENTS.
Use the published desktop-first plan before branching; 4da14806 alone has the
old ordering. Carry any additional uncommitted plan edits into an isolated
checkout only when they belong to this team.
Leave Composer and other unrelated edits in place; never stage everything.

Scope: existing-runtime safety/recovery, Agents/Workspace/Flight reliability,
readability/accessibility, applicable older bounded defects, existing feature
integration proof and source-bound installed/platform acceptance. Composer research
and model development belong to the separate D:\projects\packetbench-model-lab
project. Do not modify that project or add model training, a competitor harness product,
a graph editor, billing dashboard, autonomous Flight planner or unrelated work.

Assign one runtime agent, one flow agent, one appearance agent and yourself
as integration/quality owner, within available concurrency slots. Give each
an explicit packet and file ownership. Maintain serialized leases for shared
files and schema generation. Reuse idle agents for independent review when
implementation work settles; don't exceed available slots.
Refresh ownership for legacy hardening, provider/feature and platform acceptance
after P1 source repairs. Do not start Remote Agents implementation in parallel.

Begin with fail-closed isolation/draft/history repairs and N1 evidence, while
runtime journal/budget and isolated appearance foundations proceed in parallel.
Do not let P2 polish delay P1 safety. Commit small tested vertical slices.
Do not concurrently run destructive sidecar installs, schema generation,
full gate suites or native desktop control from multiple agents.

Use the same production executor for runtime tests. Preserve host-key pins,
frozen authority, opaque provider replay, raw usage accounting, Flight review
freshness and existing Workspace session behavior. Unknown mutation outcome
requires reconciliation; no blind replay, root-checkout/provider fallback or
invented quota/reset information.

Run packet-focused tests, integrated relevant gates and the documented native
local/Docker Linux SSH journeys. Record exact source/package identity and
remaining platform/provider limits. Desktop control must use short bursts and
release/reset immediately; no control session during builds, waits or research.

Recheck old bounded source findings before fixing them; retired providers and
closed programs stay retired. Cover existing provider/SDK, Flight supervision,
MCP/Memory/trust, Git host, shell/credentials, Monitor and dictation/hardware
matrices. Preserve existing distribution/signing decisions and local-gate policy.
Use actual Windows/Mac evidence for platform claims. If an account, hardware or
platform prerequisite is absent, keep the case open and continue other work.

Update backlog/HANDOFF with actual results. Build/install only if application
inputs changed and the assigned execution task includes installation. A source
test pass is not native evidence. Do not claim Mac parity without a Mac run.
Finish with an independent review of the integrated flow and a concise account
of changes, checks, unresolved issues and evidence paths.
Desktop completion needs the source contracts, no blocking safety findings,
passing applicable gates and a source-bound installed payload with the named
native/integration evidence. Never label unavailable evidence passed or begin
Remote Agents automatically while this gate is incomplete. Its later team
will extend existing D:\projects\packetrelay, preserving completed work.
```

This prompt grants no new publication/account action by itself. The actual
future task specifies whether commits, push, merge, paid live calls and install
are included. Do not ask repeatedly for actions already authorized in that
task, and do not infer paid inference from a hermetic test requirement.

## Role prompts and handoff outputs

### Runtime implementer

```text
You own the assigned packets in dev/agent-experience/01-runtime.md and their
new runtime modules/tests. You are not alone; preserve others' work. The
coordinator exclusively integrates api_agent.rs/agentTaskStore.ts/shared
DTOs, command registration and generated schema unless explicitly leased.

Reuse the existing local journal and production-executor seam; finish their
assigned incomplete contracts. Preserve
usage.jsonl as raw accounting. Keep SQLite work off the UI thread. Validate
operation IDs, payload digests and run epochs; journal effects before dispatch.
Handle ambiguous completed mutations without automatic replay. Reserve and
reconcile concurrent parent/child spend, including restart/cancel/lost usage.
Label native/SDK recovery and enforcement strengths honestly.

No Composer or model-development work. Use injected providers, fake clocks
and disposable repositories for fault tests; never real keys or user projects.
Return changed files, contract additions, crash-point coverage, gate output
and any unresolved adapter guarantees. Request a shared-file lease with an
exact proposed patch when needed; don't edit around another writer.
```

### Agents-flow implementer

```text
You own the assigned packets in dev/agent-experience/02-agents-flow.md and
behavioral changes/tests in launch, draft, history, attention, search and
keyboard code. You are not alone; preserve other work. Shared Composer,
AgentSidebar, AgentChatPane, ContextStrip and store/schema edits require the
coordinator's active lease. Behavior lands before visual application.

Use the agreed backend launch/run journal; don't build another database or
executor. Never broaden a failed isolation/billing/host choice. Key the full
draft including attachments. Fork preserves the original; transcript rewind
does not claim file restoration. Handle cancellation and stale async replies.
Make attention reveal the exact blocker and restore review/reader position.
Protect IME and history drafts; keep Workspace and Flight handoffs explicit.

Use delayed/rejected fake adapters and disposable fixtures. Return meaningful
failure/recovery tests, migration behavior, exact contract changes and native
scenarios still needed. No paid prompts, provider/account changes, Composer
research or unrelated refactors.
```

### Appearance/accessibility implementer

```text
You own the assigned packets in
dev/agent-experience/03-appearance-accessibility.md: appearanceStore, pure
metrics, theme/type tokens, named/focusable actions and responsive application.
You are not alone; preserve other work. Do not concurrently edit the flow
owner's Composer/sidebar/context/header files; apply visual changes after the
coordinator leases them. appStore.theme remains the only theme owner.

Use the final App scale contract: all nonterminal fonts scale once; transcript
size is a base preference. No nested CSS zoom/transform. Finish the separately
owned terminal text preference/control and transient dialog migration against
current source. Preserve shipped controls and prove enlargement there too.
Separate tool verbosity/density from font size. Keep Inter initially, validate
actual contrast surfaces and code themes, and retain useful execution context
at narrow widths. Use brand helpers and theme tokens.

Test computed styles, contrast, accessible names/focus, hit targets and reflow,
including 22px base with200% App scale. Browser evidence isn't native Windows
or Mac proof. Return font/layout measurements and remaining platform limits.
No new product features, Composer research, settings changes on the user's
live profile or large unrelated formatting passes.
```

### Integration, native evidence and independent review

The coordinator initially owns I0 and cross-track integration. After a track
settles, reuse its agent for a review **outside the files it authored**, or use
the available independent review role. Assign review findings by concrete
trigger, expected/actual outcome and missing test, not general style preference.

The reviewer checks the final integrated changes, including shared state
authority, cancelled preparation, attachment isolation, fork/resource ownership,
crash windows, reservation loss, protocol downgrade, appearance multiplication,
attention overlay and old-data migration. A review is not a replacement for
running tests or native evidence. Fix material findings, rerun affected checks
and have the integrated diff reviewed again when changes alter guarantees.

## File ownership and serialization rules

Track docs list precise candidates. This global lease rule takes precedence
when those lists overlap:

- Runtime agent: new `src-tauri/src/core/agent_runtime/` modules, runtime unit/
  fault tests and extraction patches. Root remains sole owner of integrations
  into the existing native agent loop until leased.
- Flow agent: launch/draft/project/attention/search behavior helpers and tests.
  It receives the first source lease for shared conversation UI behavior.
- Appearance agent: new appearance store/hook/metrics, `src/index.css`,
  `tailwind.config.ts`, shared code styling and Appearance settings. It receives
  shared conversation UI files after the behavior lease closes.
- Coordinator: `src/types/agent-conversation.ts`, `src/lib/tauri.ts`,
  `src/generated/tauri-schema.ts`, `src-tauri/src/lib.rs`, root protocol/export
  DTOs, migration orchestration, `vitest.config.ts`, shared e2e fixtures,
  `package.json`, integration tests, backlog and handoff.
- `agentTaskStore.ts` has one active writer at a time. Runtime projections,
  fork/rewind, draft and budget changes all request that lease. Do not split
  the whole store merely to claim independent file ownership.

The coordinator records lease grants/releases in team messages or its execution
notes. A patch handoff states expected base revision and public API changes.
After integration, affected agents reread the new seam and adjust their work.
Do not revert another agent's patch because it fails a stale local assumption.
Avoid an unconditional shared-file formatting sweep.

No two agents run schema generation simultaneously. Protocol version/floor
changes are reviewed together with both Rust and TypeScript peers. Security
fields must not be silently ignored by old peers; additive UI convenience
fields alone do not justify a new minimum protocol floor. Freeze/review this
decision per adapter, preserving current floor12 until a demonstrated contract
change requires otherwise.

## Test strategy and actual entry points

### While implementing

Use existing test locations and add named cases at the changed seam. Examples:

```text
pnpm exec vitest run src/lib/__tests__/launchConversation.test.ts
pnpm exec vitest run src/components/agents/composer/__tests__/buildComposerKeyboardHandler.test.ts
pnpm exec vitest run src/components/agents/__tests__/AgentSidebar.test.tsx
pnpm exec vitest run src/stores/__tests__/agentTaskStoreWorktreeLifecycle.test.ts
cargo test --manifest-path src-tauri/Cargo.toml --lib <implemented_test_filter>
```

The placeholder filter is not an existing test name. Confirm paths/current test
names after the baseline scan and substitute the new focused cases. DOM tests
must be in `DOM_TEST_GLOBS` in `vitest.config.ts`; a docblock cannot choose jsdom.
Avoid tests that merely echo helpers. Inject delayed start, ambiguous mutation,
concurrent request, stale epoch, wrong project, cancelled operation and restart.

### At integrated boundaries

Use the existing scheduler so contending Cargo/schema/sidecar/Vite/CPU work is
serialized. Do not run several independent gate commands from separate agents.

```text
pnpm gates:fast
pnpm gates:changed
pnpm gates:full
```

Use fast during iteration, changed for an integrated affected-surface check,
and full once at the final source. Do not rerun unchanged passing suites without
a new failure/change/concern. A packet changing protocol/provider routing needs
`sidecar:check`; DTO/persistence changes need `check:tauri-schema` and Rust tests.
Final full includes all relevant tiers; any excluded unrelated tree is named
with an explicit reason and cannot be called a full pass.

For scheduler inspection without running gates:

```text
node scripts/quality-gates.mjs --tier full --dry-run
node scripts/quality-gates.mjs --tier full --only check:tauri-schema,rust:check,rust:test
```

The second command runs gates; it is not a dry run. The `--only` selection is
useful for backend work, not a replacement for final frontend/native checks.
Actual supported flags were verified with the runner's `--help` during design.

The normal pnpm shim in this environment previously attempted a Corepack
download that restricted-network DNS could not resolve. Use an existing trusted
installed pnpm/runtime or resolve the environment normally; do not silently
change lockfiles/package-manager versions. For documentation formatting alone,
the already installed formatter can be invoked without Corepack:

```text
node node_modules/prettier/bin/prettier.cjs --check dev/agent-experience
git diff --check
```

### Source changes that require explicit companion checks

- SQLite schema/checkpoint/launch: migration old/new/corrupt/unsupported future
  version, crash durability and actor-queue shutdown; no main-thread blocking.
- Tool effects and reservations: fault injection before/after each durable
  boundary, concurrent run epochs, cancel/unknown usage and restart.
- SDK/structured adapters: wire handshake, dropped/duplicated/out-of-order events,
  partial completion and old peer refusing unsupported guarantees.
- Flow/drafts: image metadata/blob ownership, cancel/delete/GC and same-component
  project switching; launch duplicate/cancel and preserved original thread.
- Appearance: computed values and actual foreground/background contrast,
  accessible names/focus, sidebar/ContextStrip reflow and no session remount.
- Flight/Workspace: review freshness/cost/retry/Stop/recovery/delivery invariants
  and existing terminal model/font/resizing ownership.

## Native and whole-flow acceptance scenarios

Use disposable local repositories and a pinned local Docker Linux SSH fixture.
The earlier user authorized isolated Docker for this workstream; do not infer
permission to mutate a saved production SSH host. Inventory any retained owned
fixture before reuse. Never delete a user repository or force-remove unknown
worktrees. The prior disposable container is stopped; reusing it requires a
fresh state check, not assuming it is still the same fixture.

### A: Launch, isolation and cancellation

Choose a project/model/isolation mode; delay auth and worktree preparation.
Change selection explicitly, press Enter repeatedly and cancel before/after
backend preparation. Confirm one operation, no unwanted fallback, no orphan
writer, no lost draft, and ignored stale responses. Inject worktree failure;
confirm the root checkout is unchanged and Retry is persistent.

### B: Conversation identity and input

Stage a fixture screenshot in project A; visit B and return. Check complete
draft isolation/retention, visible attachment errors and no stale URL reuse.
Test IME candidate confirmation, multiline/history recall and draft restoration.
Fork an earlier turn and verify original history survives. Rewind transcript
with explicit disclosure and preserved history; verify files have the promised
unchanged state. Test a dirty worktree and owned/borrowed checkout cleanup.

### C: Runtime crash and ambiguous effects

Stop/restart at provider dispatch, before a mutating tool, after external success
but before its durable result, and after checkpoint persistence. Verify epoch
CAS, replay envelopes/IDs, no blind side effect, explicit reconciliation and
truthful semantic fallback. Change model/host/permission/tool snapshot and ensure
incompatible replay is rejected or explicitly continued under a fresh binding.
Repeat relevant cases over pinned SSH, including remote disconnect and the
existing setsid prerequisite/process-tree cancellation behavior.

### D: Budgets, child work and usage

Race two requests for the same remaining allowance, exercise multiple rounds
and read-only children, cancel with missing final usage and restart pending
reservations. Verify no shared allowance duplication, double accounting or
permanent blockage after a proven safe release. Unpriced usage is unknown,
not free. If an adapter cannot hard-bound internal requests, the UI says so.
Show missing/stale Codex quota separately from measured tokens and local caps.

### E: Attention, navigation and readable review

Open review; trigger a fixture approval and use global/header attention actions.
The exact permission with correct host/scope becomes visible/focused; returning
restores the review anchor. Search an old phrase, open that turn, switch away
and back. Identify similar long titles under the same base project and two
repositories on one SSH host. Contextual New visibly targets the chosen project.

### F: Display and platform matrix

Test dark/light, comfortable/compact, base13/15/22px, App scale100/125/150/200%,
and the base22+200% extreme. Cover 320/480/680px tiles and common laptop/wide
window sizes; save actual dimensions. Terminal enlargement uses its own control.
Check code scrolling without hiding actions, long paths/title, CJK/emoji glyphs,
named actions, tab/focus navigation and accessible tooltips. On Windows include
actual OS100/125/150% display scale; do not conflate it with App scale.

Mac native evidence requires a Mac, its actual WebView/font fallback and native
keyboard/VoiceOver behavior. If unavailable, leave it explicitly open; do not
claim cross-platform parity from CSS tokens or browser screenshots. Actual
screen-reader checks use tools available on the platform without changing
security/privacy settings through automation.

### G: Integrated local and SSH delivery

Take one existing-runtime task through brief/start, steering/Stop,
restart/continue, approval, change review, repair, fresh independent review,
Accept/Land (or the assigned supported delivery route), archive and restore.
Verify immutable reviewed commit/check results, target checkout, retained work,
usage attribution and persisted history. Repeat on the Docker SSH fixture.
These are existing Flight contracts, not a new autonomous planner.

Paid-provider calls are only exercised when the actual execution task includes
them and the account is available. Otherwise use injected/echo fixtures and
keep live billing/model quality unverified. Do not treat echo as proof of real
model behavior. Benchmark the current runtime only; Composer work stays separate.

## Evidence and cleanup contract

Each integrated run writes ignored evidence under
`test-results/acceptance/agent-experience/<UTC timestamp>/`. Include a compact
manifest with schemaVersion, packet/finding IDs, HEAD, dirty flag and full source
fingerprint, OS/architecture/WebView, binary hash if native, fixture revision,
host/pin identity, provider/transport, command/start/end/exit results, observed
font/window/scales, artifact references and explicit pass/fail/unknown/skipped
outcomes. No tokens, raw signed reasoning or personal account identifiers.

Reuse source/hash helpers in `scripts/acceptance/common.mjs`. A feature branch
SHA alone does not identify dirty input files. Link installed payload checks
to the exact manifest; a matching version string is insufficient. Store first
failures alongside corrected reruns. Keep native/provider/browser/hermetic
scopes separate in summaries.

At completion: release desktop control; stop only owned dev servers/containers;
preserve required bundles/retained worktrees/evidence; remove only verified
task-owned disposable material. Verify absolute paths before recursive removal
and use one native shell end-to-end. Don't clean unrelated user sessions or
remote resources. Build scripts can prune sidecar dev dependencies—restore them
through the existing supported script when needed.

## Definition of done

Assigned behavior is implemented, migration/recovery scenarios pass, relevant
gates pass on final source, material independent review findings are addressed,
and native evidence supports every readiness claim made. Outstanding platform,
account or ambiguous N1 evidence remains explicit in backlog/HANDOFF. Optional
I2/I3 experiments may finish with a justified keep-disabled decision; they are
not necessary to ship the core repairs. No Composer research is required.
