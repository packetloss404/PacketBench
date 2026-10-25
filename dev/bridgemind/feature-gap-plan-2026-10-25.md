# Desktop GUI feature gaps and phased follow-up

Planning decision: October 25, 2026, America/Chicago. The owner requested
backlog additions and a phased plan, with desktop completion first and no app
code changes yet. The same plan now includes the worthwhile Cursor, Codex and
Claude GUI findings; its original path is retained for existing links.
This document defines scope, reuse and phase gates;
[backlog.md](../../backlog.md) remains the only task/status ledger.

The order remains **existing desktop/runtime completion and acceptance →
existing Remote Agents program → bounded local workflow improvements → scoped
preview/result viewers → review and PR follow-up → optional product/host/
deployment-health design**. This plan adds no new
prerequisite to the desktop completion gate and makes no implementation,
deployment or acceptance claim. Calendar estimates require a refreshed baseline
and selection of an implementation slice.

## Evidence and interpretation

The October 25 read-only reviews compared official product material with
PacketBench source and its existing ledger. The latest public BridgeMind
release verified was v0.3.4, dated October 5. Release notes establish advertised
behavior, not independent testing of their desktop app. Some general docs have
conflicting platform statements; use dated, platform-specific evidence and
verify actual support before implementing an adapter.

- [v0.3.4](https://www.bridgemind.ai/changelog/bridgemind-one/v0-3-4)
  advertises exact CLI conversation restoration, an optional background
  terminal host, targeted task/prompt delivery and time-limited phone approvals.
- [v0.3.3](https://www.bridgemind.ai/changelog/bridgemind-one/v0-3-3)
  describes attention across agents and quieter background/rendering behavior.
- [v0.1.68, Windows/Linux](https://www.bridgemind.ai/changelog/bridgemind-one/v0-1-68)
  describes a browser element picker that prepares design/page context.
- [Agent Mode](https://docs.bridgemind.ai/docs/agent-mode) describes a teammate
  with its own brief, memory, skills, approved folders and multiple chats.
- [Routines](https://docs.bridgemind.ai/docs/routines) documents recurring fresh
  chats while the app is open; closing it stops that scheduler.

The subsequent GUI review adds these primary sources. Current documentation
establishes the described capability, not a release date for every feature:

- [Cursor Agents Window notes](https://cursor.com/docs/release-notes/agents-window)
  for 3.26/3.27 describe CSS editing/preview, retained view state and more
  reliable queue/steer behavior. [October 16 cloud-agent canvases](https://cursor.com/changelog/cloud-agent-canvases-and-environments)
  extends an existing results capability to cloud agents, not every local GUI.
- [Codex worktrees](https://learn.chatgpt.com/docs/environments/git-worktrees)
  documents conversation/Git handoff, managed snapshots and restore. The
  [Codex changelog](https://learn.chatgpt.com/docs/changelog) records GUI
  recovery and reader/queue fixes; CLI-only releases are not GUI additions.
- [Claude Code Desktop](https://code.claude.com/docs/en/desktop) documents app
  verification, side chats, review and PR follow-up. The
  [September 16 release notes](https://support.claude.com/en/articles/12138966-release-notes)
  describe richer editable artifacts across conversations.
- [Cursor Rollouts and Security Review, September 23](https://cursor.com/changelog/rollouts-and-security-reviewer)
  describes revision/deployment-oriented findings. [Codex Security](https://learn.chatgpt.com/docs/security/setup)
  documents persistent findings, validation evidence and remediation.

These sources motivate bounded reuse and additional gaps; they do not require
copying a cloud product, a vendor-specific model or a subscription transport.
[Claude Duet's October 21 announcement](https://claude.com/resources/articles/claude-duet) is a separate cloud/mobile research
preview, not proof of a new Claude Desktop feature. Its ongoing-work pattern
is already addressed by PacketAgent and later teammate design.

Repository planning baseline: `f9bf8376`, as observed during this documentation
pass. Five pre-existing modified Rust runtime files were present and left
untouched. The October 24 status audit and October 25
[advertised-feature acceptance inventory](../advertised-feature-acceptance-2026-10-25.md)
retain their own source/package identities and limits. Re-read the current
ledger before execution; this plan does not freeze their older residual lists.
The later Cursor/Codex/Claude documentation update observed HEAD `c86267de`;
application changes committed by other work do not become this plan's test
evidence. This update also changes documentation only.

## Ownership and duplicate avoidance

The following are extensions or reuse of current work, not new programs:

- **API-agent continuation and retained work:** R1/R3 and F2–F6 already own
  runtime transactions, typed recovery, frozen authority, drafts, assets,
  history and exact approval visibility. They stay in desktop completion.
- **Performance:** N1 and the existing workspace-performance/stream/PTY work
  own diagnosis, regression repair and measured responsiveness. Preserve prior
  scoped evidence instead of rewriting already-batched paths.
- **Browser context:** extend H8's optional rendered-app verification packet;
  add staged CSS previews and bounded visual checks after isolated capture.
  Do not create a second preview/browser task. General Computer Use stays paused.
- **Quota:** H9 already owns supported usage observations and honest unknown/
  stale/reset disclosures. This review creates no additional usage dashboard.
- **Phone decisions:** extend Remote Agents' existing approval/security
  contract, using its account/PWA-first, API-agent-only v1 boundary. Optional
  QR conveniences do not replace the selected sign-in design.
- **Durable execution and routines:** PacketAgent owns worker execution,
  checkpoints, triggers and scheduling after activation. Existing W9/PH10 and
  handoff-polish entries own interoperability and supervision proof. The live
  backlog records later implementation beyond the older July handoff table;
  do not recreate those source-complete slices from that historical table.
- **Review, coordination, Memory, MCP and dictation:** reuse existing Reviewer
  Gate, task graphs, Coordination Inbox, project Memory, MCP Hub/trust and
  dictation programs. Existing feature proof stays in its named desktop scope.
- **Evidence and result storage:** F2 owns durable assets and their retention;
  Packet Control owns its proposed terminal verification/evidence contract.
  GUI1 supplies richer viewers over existing references. H8 owns browser
  capture; no new artifact store or widened Packet Control execution scope.
- **Side questions and inline comments:**
  [SideChatOverlay](../../src/components/agents/SideChatOverlay.tsx) and
  [ReviewSurface](../../src/components/agents/review/ReviewSurface.tsx) already
  implement these surfaces. Reuse them; a competitor announcement does not
  make them new backlog features. Existing F3/F6/N1 work owns working-position
  continuity for currently supported viewers. New formats' state belongs to GUI1.

BM1–BM5 remain in the
[BridgeMind backlog section](../../backlog.md#bridgemind-follow-up--october-25-2026)
and GUI1–GUI5 are in its
[Cursor/Codex/Claude additions](../../backlog.md#cursor-codex-and-claude-additions).
Those sections own the task statuses. BM3 owns additional integration across existing projections;
it does not absorb their already-owned defects. BM4/BM5 authorize design work
when selected, not automatic implementation; the same limit applies to GUI5.

## Phase 0 — finish the existing desktop

Execute the [desktop completion plan](../agent-experience/08-desktop-completion-before-remote-agents.md)
and its current backlog residuals. Refresh source, working changes, flags,
installed package identity and active sessions before changing application
inputs. Finish safety/recovery/spend, truthful local/SSH launches, retained
work, accessible/readable controls and the named existing-feature matrices.

The N1 refinement belongs here: diagnose the observed native stall, then
measure typing and Stop responsiveness under sustained output, long-chat
reader anchoring, quiet-repository polling and hidden/minimized-window work.
Use the existing coalescers and output queues. Optimize only evidenced causes;
reduce background drawing/polling while maintaining execution and timely
decisions/cancellation. Record source/package, OS/WebView, fixture size, active
pane count, visible/hidden state and before/after observations. Select numeric
budgets from the established fixture and existing performance contract before
claiming improvement; do not invent a universal FPS or latency guarantee.

Use existing F3/F6/appearance acceptance to prove working-position continuity
for current surfaces: selected file/line, diff scope, expanded tools, transcript
anchor, draft caret/attachments and focus survive conversation switches and
restart. Fix reproduced residuals through their owners. New document viewers,
worktree transfer and Global Undo are not prerequisites for this proof.

**Exit:** the existing completion gate is earned: applicable source contracts,
independent integrated review, passing local gates, source-bound installed
payload and named native/local/SSH/provider/platform evidence. Missing hardware,
account or platform cases remain open under their actual prerequisites. A
browser fixture, build receipt or responding process does not close native
acceptance. No BM/GUI expansion is required for this exit.

## Phase 1 — resume the existing Remote Agents program

After Phase 0, follow the [canonical Remote Agents plan](../remoteagents/README.md),
including transport/replay/ACK/ticket/hello contracts, authenticated host
presence and reconnect/revocation, then backend-owned PWA conversations and
approval/cancel controls. Extend the existing PacketRelay; verify current
deployment/datastore reality before rollout. Preserve production fail-closed,
owned passkey/magic-link auth and the E2EE/external-beta requirements.

Within that existing approval work, define explicit opt-in and permission
expiry, visible device/host attribution and revocation. Every answer must bind
to the exact current request/run and be applied at most once. Prove expiry,
revocation, stale questions, reconnect/replay, desktop/phone answer races and
unpairing while a decision is in flight. Choose the lifetime in the security
contract; the competitor's 24-hour value is not a PacketBench decision.

**Exit:** the existing Remote Agents acceptance milestones and their required
evidence are satisfied for the selected rollout. Internal proof never implies
external-beta readiness. These refinements do not create another mobile client,
remote PTY control feature or independent approval authority. Preserve this
program's priority ahead of the optional expansion phases below.

## Phase 2 — continuity, targeted delivery, attention and worktree handoff

Implement BM1, BM2 and BM3 as separate, reviewable slices after the existing
programs. Refresh implementation evidence first; reuse any pieces already
landed by their owning tracks. GUI2 follows stable recovery/asset contracts;
its core local handoff does not require cross-host migration.

**BM1 — exact CLI recovery.** The current
[workspace normalizer](../../src/stores/workspaceStore.ts) clears transient PTY
ids, while [app shutdown](../../src-tauri/src/lib.rs) reaps PTY process trees.
Introduce a separately persisted provider conversation reference for supported
Claude Code/Codex terminal paths. Resolve resume through the original named
account/config directory, CLI launch resolver, checkout/worktree and execution
host, including SSH server identity and host-key checks. Persist references,
never credentials. Unsupported engines/versions must say so explicitly.

Resume and Start fresh are distinct choices. Explain whether a conversation
resumed, a new one started by choice, or recovery failed. A missing transcript,
signed-out account, changed host/folder or failed CLI must preserve the saved
reference and retry choice. Do not silently switch account or checkout, replay
an uncertain send, or report a restored layout as a resumed conversation.
Include explicitly closed panes in recovery only under bounded, inspectable
retention. Conversation recovery does not claim the prior process kept running.

**BM2 — one destination-aware delivery path.** Extend
[Prompt Library](../../src/components/workspace/PromptLibrary.tsx),
[prompt actions](../../src/stores/promptStore.ts) and existing Issue dispatch.
Use a shared target contract with stable identity and revalidation rather than
an ambiguous active-pane lookup. Offer existing terminal/conversation targets
or an explicit new Flight attempt. Preserve Agents ownership of conversations
and the retired new-Workspace-attachment boundary.

Start with an accessible Send to picker and draft insertion; drag/drop is an
optional entry point into the same path. Distinguish inserted, queued, accepted,
failed and unconfirmed delivery. A successful raw PTY write confirms transport
only. Avoid sending Enter into a newly appeared permission/trust menu; retain
the exact draft after partial failure and require inspection before resend.
Advance issue status only on confirmed acceptance, and use authoritative
Issue-to-Flight linkage when the destination is a Flight.
Queue versus steer is an explicit, adapter-supported choice on this same
delivery path. Send the latest saved edit, preserve queued target/context and
return cancelled queued text/attachments to the draft. Unsupported steering
must stay visibly unavailable; do not imitate it with unverified terminal keys.

**BM3 — consistent attention across surfaces.** Extend
[session status](../../src/lib/sessionStatus.ts), Fleet/Agents/Flight
projections, existing approval stores and notifications. Use authoritative
event and decision IDs for deduplication. Keep pending questions and failures
visible before ordinary activity; expose reason, age, task and destination.
Treat quiet/unknown PTY signals and suspected stalls as observations with
confidence, not fabricated failure or completion. Deep-link to the exact
existing approval/review/failure and preserve return anchors. A shared visual
queue must not become a second command/permission authority or a new scheduler.

**GUI2 — preserve the conversation while moving its work.** Extend existing
worktree lifecycle controls with explicit local checkout ↔ managed worktree
handoff. Preserve the logical conversation, current code and retained context;
stop/quiesce the current run before preparing a new immutable binding for its
next continuation. R1/R3 compatibility and ownership checks remain authoritative;
an old in-flight run must never silently adopt a new checkout. Engines whose
conversation state cannot continue there must retain the source and explain
the limitation rather than claim successful migration.

Validate branch ownership, source/destination revisions, dirty/untracked files
and dependent worktrees before transfer. Reuse Git lifecycle operations rather
than invent another worktree manager. A cleanup snapshot must be durable and
restorable before the managed checkout is deleted; failed snapshot/transfer
keeps the source available. Bound retention and protect active/pinned work.
Ignored files and secrets are not implicitly copied or uploaded. Cross-host
transfer needs an additional authority/capability design and is outside this
local-first slice; existing SSH launch/recovery work retains its owner.

**Exit:** targeted behavioral tests and source-bound packaged journeys cover
restart, closed-pane reopen, changed/missing identity, busy/exited targets,
partial/uncertain send, duplicate prevention, late events and reader navigation.
Test supported local and pinned SSH paths explicitly; label unsupported paths.
Reuse current reviewer gates rather than add a second dispatch/review engine.
GUI2 adds local source/destination conflict, dirty-work preservation, interrupted
handoff, missing snapshot and restore proof. Preserve rollback to the source;
starting a second chat or merging a branch alone is not conversation handoff.

## Phase 3 — result viewers and scoped development preview

**GUI1 — durable results in the existing panel system.** Extend file/editor
and review surfaces with read-only report/image/PDF/table/generated-file
viewers, export/download and links to the owning conversation/Flight, source
revision and evidence. Materialize local/SSH references through existing
authority and asset ownership; distinguish missing, stale and unsupported
content. Reuse the shell/right-panel and asset contracts, not another storage
service. Read-only formats can land independently of the browser investigation;
active HTML/interactive results require a proven isolation boundary first.

Restore supported page/zoom/selection/scroll state without blocking input, and
bound large/malformed content. Preserve source files and provenance when a
viewer cannot render. Expanding output formats does not authorize capturing
additional private data or sharing results through a new hosted service.

Deliver H8 in two bounded steps: evaluate a supported docked preview of the
development app; then add opt-in element context capture only if that preview
can maintain isolation. Reuse the shell/right-panel ownership contract rather
than create another navigation mode. Browser/MCP versus a native embedded
webview is a feasibility decision, not settled by this plan.

The proposed capture stages a reviewable screenshot/annotation, URL, selector,
bounded DOM/styles and available component information in the intended agent's
draft. Do not invent component provenance when unavailable. Page content stays
outside privileged Tauri/host APIs; extracted text is untrusted evidence and
cannot grant tool authority. Strip credentials/private fields and bound payloads.
Navigation, redirects and changed origins invalidate stale selection. Preserve
web_fetch SSRF protection and require a fresh, scoped preview authority.

After this path is proven, evaluate staged CSS edits with live previews and
opt-in bounded screenshots/DOM/error checks against user-selected local-app
criteria. Link results to the source revision and viewport; expose actions,
observations, failures and missing coverage. Human annotations, agent-operated
checks and independently captured verification are distinct evidence classes.
An attractive screenshot or a model's statement alone cannot supply a pass.
Keep these capabilities within H8; do not copy a vendor's automatic-verification
default or grant general desktop-control authority.

**Exit:** demonstrate the same local-app change being inspected, annotated,
delivered to the intended agent and verified. Record supported engines,
platforms and origins, permissions, context fidelity, private-field handling,
failure behavior and preview lifecycle/isolation tests. Optional browser
inspection does not resume paused general Computer Use.
GUI1 also needs restart/materialization, large/malformed/missing file, stale
reference, export and viewer-position proof for each supported format.

## Phase 4 — review outcomes and bounded PR follow-up

**GUI3 — security findings that survive the next review.** Extend Code Quality,
Reviewer Gate and existing line comments/diffs with findings keyed to the
repository, pinned base/head and scanner/reviewer version. Keep attack path,
evidence, assumptions, triage/dismissal rationale and fix references. Reuse the
existing review/evidence records and navigation; do not create a competing
review engine. A change in code or threat assumptions marks the result stale
until rechecked. A dismissed finding keeps its rationale without hiding a new
regression. No findings means the scan found none within its scope.

Start with explicit bounded review/verification against disposable fixtures.
Require actual evidence before marking a finding fixed; label model-only
assessment and unavailable validation. Privacy, provenance, permissions and
spend admission remain those of the existing runtime.

**GUI4 — follow one PR through checks and feedback.** Extend current Git host
integration and bounded repair/review, after their desktop proof, with an
explicit opt-in tied to a host/repository/PR/head and named feedback sources.
Validate provider capabilities rather than assume GitHub and Gitea parity.
Preserve existing draft/publish/ready/merge choices; no action in this loop
implicitly broadens that authorization. There is no requirement to enable
hosted CI for PacketBench; test against fixtures and selected user repositories
that already supply checks.

Deduplicate delivery, mark the observed head, stop/reconcile on human edits,
force-push, closure or target changes, and bound requests, spend, retries and
elapsed work. Treat comments/check logs as untrusted evidence. Use existing
approval/Stop and immutable review-freshness contracts. PacketAgent owns durable
subscriptions/reconnect when the desktop closes; no new desktop scheduler,
autonomous Flight planner or full CI dashboard is introduced. Existing Flight
repair/review acceptance is reused within its proven scope, not rerun under a
new label or treated as proof of external PR monitoring.

**Exit:** security triage survives reload and repeat scans; changed revisions
invalidate stale fixes; selected fixes retain test evidence. PR fixtures cover
duplicates/replay, simultaneous human changes, unknown checks, missing host
capabilities, budget exhaustion and Stop. Named live-host proof is required
before advertising the new follow-up behavior. Publishing/merge and deployment
actions remain within their explicit authorization.

## Phase 5 — optional design decisions

**BM4 — persistent teammate and routine supervision design.** Reuse
[profiles](../../src/types/profiles.ts), conversation history, project Memory,
skills and existing MCP trust. Define a stable identity, scoped history/memory,
approved places and inspect/edit/forget behavior. Specify engine changes and
active-chat compatibility. Propose how existing PacketAgent schedules and run
results could be surfaced without adding a desktop scheduler or duplicate
worker lifecycle. Validate existing W9/PH10 integration and ownership first.
Deliver a migration/reuse proposal, a bounded user journey and go/no-go; do
not add a new runtime, mode or automatic reflection loop on this plan alone.

**BM5 — background PTY host feasibility, after BM1.** Assess whether keeping an
existing terminal process alive across app quit/update solves a distinct need
that ordinary resume and the existing PacketAgent handoff leave open. Account
for authenticated local reattach, one owner, process identity, late host
response, duplicate prevention, output replay/deduplication, scrollback privacy,
retention, bounded resources, explicit end-all, process-tree cleanup and
uninstall/update/crash/reboot behavior. Separate remote SSH lifetime from local
process ownership and require per-platform proof. Keep current quit cleanup
until a separately selected design and implementation earn safe replacement.

**GUI5 — deployment-health feasibility.** Within PacketAgent's existing
durable execution ownership, design a bounded observer for a user project's
deployment of an exact commit to an exact environment. Specify intended effect,
available telemetry, baseline/window, evidence and healthy/regressed/inconclusive
criteria. Missing instrumentation or failed observation is inconclusive, not
healthy. Preserve per-environment status and handle late/duplicate deploy events
without crediting evidence to a different commit.

Reuse current deploy integration and Packet Control evidence references; keep
Monitor UI expansion under its existing item. Deliver a capability/integration
proposal, resource limits and go/no-go before implementation. This plan creates
no telemetry connection, hosted monitoring service, polling daemon, automatic
revert/rollback or self-healing loop. Evidence can propose an action; execution
still needs its own bounded authority.

**Exit:** recorded product/architecture decisions, reuse analysis and measurable
acceptance proposals. A go decision creates a later implementation slice through
the existing backlog; it does not retroactively change desktop acceptance.

## Execution and change boundaries

- This planning request changes repository documentation only. No app code,
  dependency, feature flag, credentials, installer, running session or scheduled
  automation is changed. The owner subsequently authorized committing and
  pushing these documentation updates; application changes and deployment
  remain outside that publication.
- Before implementation, refresh the live backlog and source; lease overlapping
  runtime, persistence, schema, status and UI files through the existing team
  process. Preserve concurrent edits and previously earned evidence.
- Each selected slice needs an explicit migration/failure path, relevant local
  gates and the named packaged/native proof. Completed source is distinct from
  installed acceptance; reuse passing evidence only within its stated identity.
- Re-check the queue before implementing: H8 owns visual editing/verification;
  BM2 owns queue/steer; F3/F6/N1 own continuity for existing surfaces; GUI1 owns
  additional viewers; GUI2 owns conversation transfer; GUI3 owns security
  finding lifecycle; GUI4 owns external PR follow-up; GUI5 is later design only.
- Keep the current Workspace/Agents routing and API-key/PTY auth boundaries.
  Retired providers, the autonomous Flight planner, Syndicate integration,
  Cost Dashboard and model-lab research remain outside this work. No 3D campus,
  gamification, broad plugin marketplace or extra CLI catalog is added here.
