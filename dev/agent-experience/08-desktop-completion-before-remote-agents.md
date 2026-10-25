# Desktop/runtime completion before Remote Agents

Owner sequencing decision: October 24, 2026, America/Chicago, after the initial
documentation audit/publication. This replaces the Remote-Agents-first order
recorded in documentation commit `4da14806`. The application audit baseline
remains `922ddcc9`; refresh current source and evidence before implementation.

**Finish the existing desktop/runtime work and its acceptance first. Resume
Remote Agents afterward.** [backlog.md](../../backlog.md) remains the only task
ledger. This document defines execution order and completion evidence, not a
second set of task statuses. The original track specifications remain targets;
[the audit](../documentation-audit-2026-10-24.md) identifies committed slices and
remaining contracts. Reuse completed work.

## Scope and team

The active scope is existing runtime safety/recovery, Agents/Workspace/Flight
reliability, readability/accessibility, current feature hardening, and native,
provider, SSH, hardware and platform acceptance within their existing scopes.
Optional product expansion is outside this completion gate.

Use a coordinator plus runtime, flow and appearance implementers within
available concurrency. Refresh ownership as work moves into integration and
acceptance; reuse idle implementers for independent review. Serialize shared
stores, DTOs, IPC registration, schema generation and overlapping UI edits.
Do not run competing full gates, destructive sidecar installs or native-control
sessions. Each worker must preserve others' edits.

Composer research/model development now belongs to the separate
[packetbench-model-lab project](https://github.com/packetloss404/packetbench-model-lab/blob/main/docs/PLAN.md),
at `D:/projects/packetbench-model-lab`; its active plan and progress live there.
Preserve that project, historical Composer research and unrelated summary edits in `dev/README.md`.
Do not modify, format, stage or commit them. Leave unrelated sibling repository
changes intact. This desktop task does not start Remote Agents implementation.

## Phase 0 — establish the current baseline

Read local instructions, the hub, current status, ROADMAP, backlog, HANDOFF and
the affected agent-experience tracks. Inventory HEAD, working changes, runtime
flags, schema, installed package identity and active sessions. Identify what is
already implemented before assigning residuals. Preserve an isolated state
backup before migration/restart tests; use disposable repositories and profiles.
Use the published desktop-first plan when selecting an isolated checkout;
`4da14806` alone still contains the superseded order. If additional plan updates
are uncommitted, carry only this team's scoped changes into the new worktree.
Preserve unrelated edits in place and never use broad staging to transfer them.

Start N1 responsiveness diagnosis immediately alongside independent source
repairs. Capture repeatable navigation/timing/process evidence. A responding
process or a negative reproduction does not establish a causal fix; record the
remaining uncertainty and the actual acceptance coverage.

## Phase 1 — runtime authority, recovery and spend safety

Complete the backend prepare/start/cancel/reconcile transaction, immutable
checkout/SSH authority, owner/revision/predecessor checks, one root run per turn
and terminal projection. Finish policy-compatible typed provider continuation,
tool-effect reconciliation and durable image ownership. Unknown tool outcomes
must not be replayed blindly.

Retain dispatched requests' uncertain cost liability through cancellation,
restart and missing usage. Include system/tool/image input and required budget
scopes; make native/SDK enforcement strength explicit. Complete production
manifest identity, context/window policy/readout, child cancellation and the
required adapter hooks or limitations. Reuse the production executor for fault
and recovery tests. Default-on activation requires its own earned evidence.

## Phase 2 — preserve work and make flow truthful

Fix SSH contextual New, failed-start draft retention and truthful backend launch
phases/cancel acknowledgement. Finish project-scoped drafts, unreadable attachment
blocking, message/submission/checkpoint pins, conservative GC for unknown/newer
envelopes and the specified grace/capacity rules.

Enforce Flight history restrictions at authoritative mutation boundaries.
Reveal the exact approval above review from every entry point and restore the
reader's position. Complete native fork/rewind/restart, search continuity and
IME/history evidence. Preserve existing Flight review freshness, reviewer cost
attribution and retry-limit behavior.

## Phase 3 — finish readability and interaction

Complete semantic typography/App scaling and terminal-dialog updates; use one
rendered sidebar-width/reset owner. Finish primary controls' target sizes,
accessible names, focus, narrow headers/drawer/action lane, code metrics and
actual composited contrast. Verify the 320/480/680px and enlarged-text matrix,
Windows IME, keyboard navigation and reader restoration. Windows and macOS need
separate native evidence.

## Phase 4 — existing feature hardening and integration proof

Revalidate older bounded source items against current code and owner decisions
before editing. Close applicable sidecar resilience, Settings/task-role wiring,
failed/exact edit behavior, MCP/trust, Memory scale/interoperability and shell
issues. Do not resurrect retired ACP providers, the autonomous Flight planner,
Syndicate execution targets or the Cost Dashboard from old bullets.

Run the existing provider and SDK local/SSH matrices; Flight Reviewer Gate,
cooperative integration, Coordination Inbox and bounded YOLO; GitHub/Gitea issue
sync; MCP trust/restart; Memory editor interoperability; Monitor behavior; and
dictation/headset/platform recovery. Include existing PacketAgent/PacketCode
interoperability proof where its documented fixture is available. Keep external
dependency evidence separate from implementation owned by this repository.

## Phase 5 — source-bound packaged acceptance

Run focused tests per slice, then relevant integrated gates and final full local
quality gates. Build from the chosen source after application inputs change,
record source/resource/payload identity, and use that exact package for installed
acceptance. Preserve user sessions and data during an installer update.

Prove native local and disposable pinned Docker Linux SSH journeys: launch,
Stop/cancel, app restart/resume, ambiguous-effect recovery, approval over review,
repair, fresh review, delivery and archive/restore. Verify drafts, attachments,
history, usage and authority across restart. Exercise Workspace/Settings shell,
credential and denial cases. Complete macOS and other currently required
platform evidence on their actual environments.

Record account, hardware and platform cases that cannot run as open gates with
the exact missing prerequisite; continue independent work. Do not count them as
passes or declare full acceptance. Signing/notarization/updater credentials and
distribution remain subject to existing owner decisions. Local quality gates
remain the policy; this reordering does not authorize hosted CI or publication.

## Exit and handoff to Remote Agents

Before calling the desktop completion gate passed, show completed in-scope
source contracts, no unresolved blocking safety findings, independent integrated
review, passing applicable gates, a source-bound installed payload and the named
native/integration matrices. Keep any unavailable evidence visibly open; a
source pass does not close it. Update backlog and HANDOFF with exact commits,
commands/results, evidence paths, accepted limitations and remaining blockers.

Remote Agents follows this gate. Keep its production feature fail-closed while
waiting. Its later team must extend the existing `D:/projects/packetrelay` Rust
service, preserving existing protocols and reusing identity/ACL/audit/persistence
work. Refresh deployment reality before rollout; retain owned passkey/magic-link
auth, E2EE and external-beta security requirements.

Quota disclosure, rendered-app verification, supported-plan feasibility,
Packet Control, Global Undo, Monitor expansion, Windows-OpenSSH/larger-transfer
expansion and dictation-engine benchmarks retain their optional/deferred status.
General Computer Use remains paused; native iOS follows the Remote Agents PWA.
Composer research/model training belongs to its separate packetbench-model-lab project. None silently
becomes a prerequisite for finishing the existing desktop.
