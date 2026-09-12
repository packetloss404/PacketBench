# PacketBench Development Plans

Last reconciled: 2026-09-12

This directory contains active implementation plans, proof runbooks, research,
and historical evidence. It is not a second backlog.

The consolidation installer and live OpenSSH workflow is documented in
[`installer-ssh-acceptance.md`](./installer-ssh-acceptance.md). It produces
timestamped source, artifact and runtime evidence under `test-results/acceptance/`.

Current Workspace controls/readability and browser/native-SSH acceptance:
[`workspace-usability-evidence-2026-09-11.md`](./workspace-usability-evidence-2026-09-11.md).
This also records the correction to Playwright output isolation; earlier raw
acceptance directories were removed, while tracked dated reports survived.

The preliminary 0.14.7 source and native WebView2 profiling evidence is in
[`workspace-release-0.14.7.md`](./workspace-release-0.14.7.md). It records the
Workspace summary and Monitor concurrency fixes; build/full gates and installed
0.14.7 checks are pending. The real Claude provider test is deferred at the
user's request because subscription renewal is required.

Use these documents in order:

1. [`../HANDOFF.md`](../HANDOFF.md) - exact restart state and release artifacts
2. [`../backlog.md`](../backlog.md) - only live item-level task register
3. [`../ROADMAP.md`](../ROADMAP.md) - product direction and ordering
4. [`../docs/reports/state-of-the-ade-2026-07-30.md`](../docs/reports/state-of-the-ade-2026-07-30.md), Section 0 - current consolidated audit state
5. [`../docs/reports/fable5-review-2026-08-05.md`](../docs/reports/fable5-review-2026-08-05.md) - the 2026-08-05 seven-team deep review, its twelve P1 findings, and the v1.0.0 scope and plan
6. A plan below only when executing its linked backlog item

Do not treat status tokens inside dated audits or files under `archive/` as live
work. Completed work belongs in `CHANGELOG.md`.

## Current release and proof

| Document                                                                     | Status                                                                                                                                                                                    |
| ---------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`../CHANGELOG.md`](../CHANGELOG.md) | **CURRENT BUILD RECORD** — 0.14.6 built and installed with shared Workspace controls, readable layouts, native eight-column restart proof and 15/15 OpenSSH cases. Exact hashes and scope: [`workspace-usability-evidence-2026-09-11.md`](./workspace-usability-evidence-2026-09-11.md). Latest annotated release tag remains v0.10.3. |
| [`workspace-release-0.14.7.md`](./workspace-release-0.14.7.md) | **PRELIMINARY** — summary/Monitor source fixes and isolated native WebView2 cold/warm output profiles complete; full gates, packaging and installed 0.14.7 checks pending. |
| [`proof-audit-2026-08-01.md`](./proof-audit-2026-08-01.md)                   | **DATED SNAPSHOT** - exact August 1 source/package proof; superseded for current counts and package identity by v0.10.3, but still authoritative for why each external gate remained open |
| [`acceptance.md`](./acceptance.md) | **HISTORICAL MATRIX** — rows describe 0.13.2. Current 0.14.1 installer/OpenSSH proof is in [`installer-ssh-evidence-2026-09-08.md`](./installer-ssh-evidence-2026-09-08.md); later GUI/provider/hardware observations are in the September 8 GUI report. Existing ticks are not promoted. |
| [`local-quality-gates.md`](./local-quality-gates.md)                         | Current local gate commands and release-check composition                                                                                                                                 |
| [`beta-distribution-trust-runbook.md`](./beta-distribution-trust-runbook.md) | Signing/updater/release-candidate runbook. Signing itself is **deferred on cost** (owner decision 2026-08-27, terms in `../backlog.md`); this runbook is what to execute when the deferral's trigger fires, not open work |
| [`multi-platform-build.md`](./multi-platform-build.md)                       | Windows/macOS/Linux prerequisites and build flow                                                                                                                                          |
| [`macos-release-plan.md`](./macos-release-plan.md)                           | **ACTIVE PLAN** - owns macOS code signing, notarization, entitlements, the arm64 bundle decision, and the macOS acceptance matrix; macOS targets v1.1                                     |
| [`updater-setup.md`](./updater-setup.md)                                     | Tauri updater runbook; updater is not enabled                                                                                                                                             |
| [`release-v0.10.2.md`](./release-v0.10.2.md)                                 | Historical immutable release record                                                                                                                                                       |

## Current product contracts

The September 11 Workspace reliability pass and its 0.14.4/0.14.5 build evidence
are tracked in [`workspace-evidence-2026-09-11.md`](./workspace-evidence-2026-09-11.md).

| Area                         | Canonical document                                                                                                         | Status                                                                                                                    |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Workspace/Agents             | [`workspace-agents-restructuring-goal.md`](./workspace-agents-restructuring-goal.md)                                       | **COMPLETE** - CLI/PacketCode-first Workspaces; first-class same-window Agents; no new Workspace conversation attachments |
| Route/compatibility contract | [`workspace-agents-wa0-route-contract.md`](./workspace-agents-wa0-route-contract.md)                                       | **LOCKED; WA1-WA4 COMPLETE**                                                                                              |
| Handoff evidence             | [`workspace-agents-wa3-handoff-evidence.md`](./workspace-agents-wa3-handoff-evidence.md)                                   | Source complete; local/SSH/external-runtime proof remains                                                                 |
| Attachment retirement        | [`workspace-agents-wa4-dogfood-gate.md`](./workspace-agents-wa4-dogfood-gate.md)                                           | **COMPLETE** - `Open alongside Workspace` retired; saved panes preserved                                                  |
| Completion audit             | [`workspace-agents-completion-audit-2026-07-29.md`](./workspace-agents-completion-audit-2026-07-29.md)                     | **COMPLETE**                                                                                                              |
| Settings                     | [`workspace-agent-settings-decision-2026-07-29.md`](./workspace-agent-settings-decision-2026-07-29.md)                     | Six-group IA and P1 authority/security complete; bounded P2 and packaged/live proof remain                                |
| Main shell/right dock        | [`main-shell-navigation-and-right-panel-audit-2026-07-29.md`](./main-shell-navigation-and-right-panel-audit-2026-07-29.md) | Decisions implemented; MS4 accessibility/responsive proof and bounded residue remain                                      |

The former Tile program is archived under
[`archive/tile-program/`](./archive/tile-program/). It executed useful substrate
work, but its final Agents-tab-retirement direction was explicitly superseded
by the current Workspace/Agents contract. Do not resume it.

The Syndicate execution-target program is archived under
[`archive/syndicate/`](./archive/syndicate/). Syndicate separated from the
Packet\* product family on 2026-08-27 and the integration was removed from the
product in `68ce85ee`; those documents are historical records only. The
`method-b-request.md` inside that folder — at
[`archive/syndicate/syndicate-proof/method-b-request.md`](./archive/syndicate/syndicate-proof/method-b-request.md)
— must not be sent. `syndicate_relay.rs` no longer exists in the tree; the copy
at `d87fb125` lives only in git history and remains the reference device-half
implementation of the controller relay protocol for the Remote Agents work.
Those documents also predate the 2026-08-27 decision that PacketRelay
(`D:\projects\packetrelay`) belongs to PacketBench and deploys to Railway;
where they describe the relay as Syndicate infrastructure on Cloud Run, read
that as history.

## Active implementation and proof plans

| Track                       | Canonical document                                                                                 | Current boundary                                                                                                                                                                                                                                                    |
| --------------------------- | -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Remote Agents               | [`remoteagents/README.md`](./remoteagents/README.md)                                               | **ACTIVE; Sprint 0 complete 2026-09-01.** Foundations, ownership map, feature-off source deployment, and Railway/PostgreSQL substrate are verified; the final IaC plan is clean. Remote Agents remains disabled/fail-closed and Sprint 1/auth has not started. E2EE, auth security review, and PostgreSQL PITR + scheduled volume backups + offsite restore drill remain external-beta gates; [`remoteagents/10-pause-record.md`](./remoteagents/10-pause-record.md) is historical context |
| Remote provider parity      | [`sidecar-over-ssh-verification.md`](./sidecar-over-ssh-verification.md)                           | Surviving Claude Agent SDK/OpenAI Agents SDK pinned-SSH matrix remains                                                                                                                                                                                              |
| SSH/workspaces              | [`ssh-remote-loop.md`](./ssh-remote-loop.md)                                                       | S1-S8 shipped; Windows-OpenSSH and larger streamed transfers remain later/environment-gated                                                                                                                                                                         |
| Flight Reviewer             | [`bridgemind/reviewer-gate-loop.md`](./bridgemind/reviewer-gate-loop.md)                           | Source/automated proof complete; RG8 packaged local/SSH/manual gate remains                                                                                                                                                                                         |
| Cooperative Flights         | [`bridgemind/cooperative-flight-graph-loop.md`](./bridgemind/cooperative-flight-graph-loop.md)     | Source/automated proof complete; CG9 landing/release-like gate remains                                                                                                                                                                                              |
| Coordination Inbox          | [`bridgemind/coordination-inbox-loop.md`](./bridgemind/coordination-inbox-loop.md)                 | Source/automated proof complete; CI9 real-runtime matrix remains                                                                                                                                                                                                    |
| Bounded YOLO                | [`bridgemind/autonomy-policy-loop.md`](./bridgemind/autonomy-policy-loop.md)                       | Source/automated proof complete; AP9 adversarial/release-like matrix remains                                                                                                                                                                                        |
| PacketAgent handoff         | [`bridgemind/packetagent-handoff-loop.md`](./bridgemind/packetagent-handoff-loop.md)               | **PH2–PH9 source complete (2026-08-26), both repos merged** — consumer (contract probe, multi-source builders, SSE stream, approvals, typed evidence, attention queue) + server surface (contract route, attention ops, mint CLI). Only PH10 live e2e remains (running instance) |
| PacketCode integration      | [`bridgemind/packetcode-bridgecode-loop.md`](./bridgemind/packetcode-bridgecode-loop.md)           | Source hardening complete; published signed release and cross-product proof remain                                                                                                                                                                                  |
| Project Memory              | [`bridgemind/project-local-memory-hub-loop.md`](./bridgemind/project-local-memory-hub-loop.md)     | MH1-MH7 source complete; MH8/MH9 editor/package proof remains                                                                                                                                                                                                       |
| MCP Hub                     | [`bridgemind/local-first-mcp-hub-loop.md`](./bridgemind/local-first-mcp-hub-loop.md)               | Source complete; MCPH3/MCPH8 local/SSH/provider/package proof remains                                                                                                                                                                                               |
| Trust/provenance            | [`bridgemind/trust-provenance-loop.md`](./bridgemind/trust-provenance-loop.md)                     | TP1-TP7 source complete; TP8 environment proof remains                                                                                                                                                                                                              |
| Dictation                   | [`bridgemind/dictation-repair-hardening-loop.md`](./bridgemind/dictation-repair-hardening-loop.md) | DV1-DV16 source complete; physical/package matrix remains                                                                                                                                                                                                           |
| Issue-to-Flight             | [`issue-flight-mirror-design.md`](./issue-flight-mirror-design.md)                                 | P0-P3 source complete; packaged GitHub/Gitea proof remains                                                                                                                                                                                                          |
| Monitor | [`send-to-monitor-plan.md`](./send-to-monitor-plan.md) | Windows lifecycle fixes installed in 0.14.3; native opening, projection, two-display and shutdown proof recorded. Stale-entity, Flight, denial-integration and full keyboard/responsive cases remain. |
| Local model routing         | [`local-model-routing.md`](./local-model-routing.md)                                               | **Mostly landed (2026-08-26):** Ollama tool-capability picker gating, `api-custom` OpenAI-compatible provider (LM2), usage-ledger provider field + spend-split script, subagent parent-provider derivation, fail-closed local routing, per-row model pins, pure-text aux migrations. Remaining: codebase-dependent aux migrations (3C-3), and the local-opt-in banner gated on a green `ollama_e2e --ignored` run |
| API-agent auth cleanup      | [`oauth-removal-plan.md`](./oauth-removal-plan.md)                                                 | Credential migration complete; explicit retired-conversation provider switch remains                                                                                                                                                                                |
| Cost controls/efficiency    | [`cost-efficiency-loop.md`](./cost-efficiency-loop.md)                                             | Reporting surface removed; caching/edit improvements partly complete; live measurement and bounded edit debt remain                                                                                                                                                 |
| Packet Control              | [`packet-control-loop.md`](./packet-control-loop.md)                                               | Proposed, not started; shared evidence contract must precede implementation                                                                                                                                                                                         |
| Computer Use                | [`computer-use-plan.md`](./computer-use-plan.md)                                                   | **STILL PAUSED 2026-08-16** by owner decision; design and decisions complete (browser tier first, Rust in-process, approval-gated, Windows-only v1); §7-PAUSE of the plan is the pickup runbook. The 2026-08-27 unpause covered Remote Agents only — the two pauses were same-day siblings but are no longer linked                                                       |
| 2026-08-01 P1 pass          | [`high-priority-real-work-loop-2026-08-01.md`](./high-priority-real-work-loop-2026-08-01.md)       | Evidence record for the runtime-authority correctness pass (`fd8c226`); source and review complete                                                                                                                                                                  |
| GitHub pane v9 residue      | [`github-pane-v9-loop.md`](./github-pane-v9-loop.md)                                               | Scoped GitHub-pane deferrals; remaining work is tracked in `../backlog.md`                                                                                                                                                                                          |

The packaged Flight-supervision matrices (RG8/CG9/CI9/AP9) share one evidence
file: [`bridgemind/flight-supervision-proof-2026-07-28.md`](./bridgemind/flight-supervision-proof-2026-07-28.md).

Where a row above disagrees with the status line inside its own plan document,
the row wins — it is reconciled against source, the plan headers are not.
Verified on 2026-08-27: the Local model routing row (`local-model-routing.md`
still opens "IN PROGRESS ... barring picker gating", but `supports_tools`
gating, `llm_custom_compat`, and `scripts/aux-spend-split.mjs` are all in the
tree) and the PacketAgent handoff row (`packetagent-handoff-loop.md` still
lists PH9 as `queued`, but `src/lib/packetAgentAttention.ts` and
`packetAgentProjection.ts` exist). Every "packaged proof remains" claim spot-
checked also held: Monitor v1 is source-complete behind
`src-tauri/src/commands/monitor_windows.rs`, TP8 is genuinely environment-
gated, and the local-opt-in banner's gate `src-tauri/tests/ollama_e2e.rs` is
still `#[ignore]`d pending a live daemon.

All document links in this file resolve as of 2026-08-27.

## Research and reference

- [`competitors.md`](./competitors.md) indexes the competitive research.
- [`bridgemind/bridgespace-competitive-brief.md`](./bridgemind/bridgespace-competitive-brief.md)
  and [`bridgemind/bridgeswarm-teardown.md`](./bridgemind/bridgeswarm-teardown.md)
  are product/landscape references, not task registers.
- [`mobile/README.md`](./mobile/README.md) is explicitly superseded for
  implementation by `remoteagents/`; keep it only as earlier research.
- Shipped zen-workspace feature/history notes now live in
  [`archive/zen-workspace/`](./archive/zen-workspace/).
- [`spike-macos-keychain-namespacing.md`](./spike-macos-keychain-namespacing.md)
  states why Claude Code's macOS Keychain namespacing matters and what we do
  with each outcome. It is no longer environment-gated: the runnable procedure
  and pass/fail criteria are §6 of
  [`macos-release-plan.md`](./macos-release-plan.md).

## Archive

[`archive/`](./archive/) is cold storage for completed, superseded, or dated
planning material. Notable boundaries:

- Flight Planner v1 documents describe a deleted runtime; do not restore it.
- `archive/tile-program/` describes the superseded plan to retire Agents into
  Workspace conversation tiles. The current product contract reversed that
  direction while preserving saved-pane compatibility.
- Reliability low-finding and July P1/P2 loop documents are complete.
- Historical code reviews and positioning documents may explain decisions but
  do not create work outside `../backlog.md`.
