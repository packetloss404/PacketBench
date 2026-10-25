# PacketBench Documentation Hub

Last reconciled: October 24, 2026 (America/Chicago), source `922ddcc9`.

**Start here for every document. Finish the existing desktop/runtime work and acceptance before Remote Agents.**
The source is committed and pushed; the full agent-experience target and latest installed-source verification remain incomplete.

## Read in this order

1. [Current product/delivery status](./current-status.md) — verified facts, enabled/default boundaries and remaining work.
2. [ROADMAP](../ROADMAP.md) — desktop/runtime completion and acceptance first, then Remote Agents.
3. [backlog](../backlog.md) — the only live task/status ledger.
4. [HANDOFF](../HANDOFF.md) — the next team restart point and installed evidence.
5. [Full Markdown catalog](./documentation-map.md) — all tracked documents, grouped by purpose; local instructions identified separately.

## Current programs and operations

- [Desktop completion plan](./agent-experience/08-desktop-completion-before-remote-agents.md) and [team dispatch](./agent-experience/05-agent-dispatch-and-acceptance.md) — current implementation and acceptance order.
- [Remote Agents](./remoteagents/README.md) — follows desktop completion/acceptance; later extend existing PacketRelay through transport/security contracts and internal presence.
- [Agents/runtime target specification](./agent-experience/README.md) — committed implementation slices plus the remaining safety, flow and appearance work; Composer excluded.
- [October 24 verification report](./documentation-audit-2026-10-24.md) — source/commit/installed-payload evidence, per-packet gaps and audit limits.
- [October 25 advertised-feature acceptance](./advertised-feature-acceptance-2026-10-25.md) — README feature inventory, browser/source/native evidence boundaries and this team's fresh results. It does not promote historical tests to current native acceptance.
- [Local quality gates](./local-quality-gates.md), [installer/SSH acceptance](./installer-ssh-acceptance.md), [multi-platform build](./multi-platform-build.md), [macOS plan](./macos-release-plan.md).
- [Operations runbook](../docs/runbooks.md) — September 2026 source snapshot; verify commands against current source before operating.
- [SDK limitations](./agent-experience/07-sdk-limitations.md) — actual current transport limits, distinct from the target design.
- [Archived programs](./archive/README.md) — historical decisions/evidence; do not resume retired products.
- Composer research/model development now belongs to the separate [packetbench-model-lab project](https://github.com/packetloss404/packetbench-model-lab/blob/main/docs/PLAN.md), at `D:/projects/packetbench-model-lab`; the historical research entry is preserved below.

## How documentation is consolidated

One hub and catalog make the material reachable without relocating root contracts, old reports or evidence.
Current facts live in current-status, task statuses in backlog, ordering in ROADMAP and restart actions in HANDOFF.
Track specs define the target, while dated reports preserve what was observed on their named source/package.
Historical completed-source labels do not prove deployment or current acceptance.
The reference tables below retain dated records; use the current status page to interpret their remaining scope.

Public user documentation is maintained in the separate [ianlan-docs repository](https://github.com/packetloss404/ianlan-docs).
This audit changes local repository documentation only and does not publish that site.

## Dated release and proof records

| Document                                                                                   | Status                                                                                                                                                                                                                                                                                    |
| ------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`flight-overhaul-review-2026-10-19.md`](./flight-overhaul-review-2026-10-19.md)           | **OCTOBER 19 EVIDENCE** — local/SSH walkthrough and earlier installer proof; does not identify the October 23 installed payload or October 24 source.                                                                                                                                     |
| [`provider-release-0.14.9.md`](./provider-release-0.14.9.md)                               | **TAGGED BASELINE** — October 6 0.14.9 release, tag v0.14.9, installer and launch evidence. The later local rebuild does not move this tag.                                                                                                                                               |
| [`existing-code-stabilization-2026-09-24.md`](./existing-code-stabilization-2026-09-24.md) | **PREVIOUS CHECKPOINT** — audit/follow-up fixes, eleven gate categories, exact 0.14.8 build/install evidence and owner dogfooding next.                                                                                                                                                   |
| [`workspace-release-0.14.7.md`](./workspace-release-0.14.7.md)                             | **BUILT** — summary/zoom/Monitor fixes, isolated native WebView2 profiles, eleven full gates, fifteen OpenSSH cases and both Windows installers passed. Exact source and artifact hashes recorded.                                                                                        |
| [`proof-audit-2026-08-01.md`](./proof-audit-2026-08-01.md)                                 | **DATED SNAPSHOT** - exact August 1 source/package proof; superseded for current counts and package identity by v0.10.3, but still authoritative for why each external gate remained open                                                                                                 |
| [`acceptance.md`](./acceptance.md)                                                         | **HISTORICAL MATRIX** — rows describe 0.13.2. Current 0.14.1 installer/OpenSSH proof is in [`installer-ssh-evidence-2026-09-08.md`](./installer-ssh-evidence-2026-09-08.md); later GUI/provider/hardware observations are in the September 8 GUI report. Existing ticks are not promoted. |
| [`local-quality-gates.md`](./local-quality-gates.md)                                       | Current local gate commands and release-check composition                                                                                                                                                                                                                                 |
| [`beta-distribution-trust-runbook.md`](./beta-distribution-trust-runbook.md)               | Signing/updater/release-candidate runbook. Signing itself is **deferred on cost** (owner decision 2026-08-27, terms in `../backlog.md`); this runbook is what to execute when the deferral's trigger fires, not open work                                                                 |
| [`multi-platform-build.md`](./multi-platform-build.md)                                     | Windows/macOS/Linux prerequisites and build flow                                                                                                                                                                                                                                          |
| [`macos-release-plan.md`](./macos-release-plan.md)                                         | **ACTIVE PLAN** - owns macOS code signing, notarization, entitlements, the arm64 bundle decision, and the macOS acceptance matrix; macOS targets v1.1                                                                                                                                     |
| [`updater-setup.md`](./updater-setup.md)                                                   | Tauri updater runbook; updater is not enabled                                                                                                                                                                                                                                             |
| [`release-v0.10.2.md`](./release-v0.10.2.md)                                               | Historical immutable release record                                                                                                                                                                                                                                                       |

## Product contract references

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
(`D:\projects\packetrelay`) belongs to PacketBench, with Railway the historical
target in that decision; current topology requires the October 24 reconciliation.
Where they describe the relay as Syndicate infrastructure on Cloud Run, read
that as history.

## Program specifications and evidence references

| Track                    | Canonical document                                                                                 | Current boundary                                                                                                                                                                                                                                                                                                                                                                                                  |
| ------------------------ | -------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Remote Agents            | [`remoteagents/README.md`](./remoteagents/README.md)                                               | **AFTER DESKTOP ACCEPTANCE; INCOMPLETE.** Desktop gates/PWA/relay routes remain fail-closed or scaffolded. Committed persistence substrate exists; historical Railway and later local datacenter notes are distinct from current live deployment proof.                                                                                                                                                           |
| Remote provider parity   | [`sidecar-over-ssh-verification.md`](./sidecar-over-ssh-verification.md)                           | Surviving Claude Agent SDK/OpenAI Agents SDK pinned-SSH matrix remains                                                                                                                                                                                                                                                                                                                                            |
| SSH/workspaces           | [`ssh-remote-loop.md`](./ssh-remote-loop.md)                                                       | S1-S8 shipped; Windows-OpenSSH and larger streamed transfers remain later/environment-gated                                                                                                                                                                                                                                                                                                                       |
| Flight Reviewer          | [`bridgemind/reviewer-gate-loop.md`](./bridgemind/reviewer-gate-loop.md)                           | Source/automated proof complete; RG8 packaged local/SSH/manual gate remains                                                                                                                                                                                                                                                                                                                                       |
| Cooperative Flights      | [`bridgemind/cooperative-flight-graph-loop.md`](./bridgemind/cooperative-flight-graph-loop.md)     | Source/automated proof complete; CG9 landing/release-like gate remains                                                                                                                                                                                                                                                                                                                                            |
| Coordination Inbox       | [`bridgemind/coordination-inbox-loop.md`](./bridgemind/coordination-inbox-loop.md)                 | Source/automated proof complete; CI9 real-runtime matrix remains                                                                                                                                                                                                                                                                                                                                                  |
| Bounded YOLO             | [`bridgemind/autonomy-policy-loop.md`](./bridgemind/autonomy-policy-loop.md)                       | Source/automated proof complete; AP9 adversarial/release-like matrix remains                                                                                                                                                                                                                                                                                                                                      |
| PacketAgent handoff      | [`bridgemind/packetagent-handoff-loop.md`](./bridgemind/packetagent-handoff-loop.md)               | **PH2–PH9 source complete (2026-08-26), both repos merged** — consumer (contract probe, multi-source builders, SSE stream, approvals, typed evidence, attention queue) + server surface (contract route, attention ops, mint CLI). Only PH10 live e2e remains (running instance)                                                                                                                                  |
| PacketCode integration   | [`bridgemind/packetcode-bridgecode-loop.md`](./bridgemind/packetcode-bridgecode-loop.md)           | Source hardening complete; published signed release and cross-product proof remain                                                                                                                                                                                                                                                                                                                                |
| Project Memory           | [`bridgemind/project-local-memory-hub-loop.md`](./bridgemind/project-local-memory-hub-loop.md)     | MH1-MH7 source complete; MH8/MH9 editor/package proof remains                                                                                                                                                                                                                                                                                                                                                     |
| MCP Hub                  | [`bridgemind/local-first-mcp-hub-loop.md`](./bridgemind/local-first-mcp-hub-loop.md)               | Source complete; MCPH3/MCPH8 local/SSH/provider/package proof remains                                                                                                                                                                                                                                                                                                                                             |
| Trust/provenance         | [`bridgemind/trust-provenance-loop.md`](./bridgemind/trust-provenance-loop.md)                     | TP1-TP7 source complete; TP8 environment proof remains                                                                                                                                                                                                                                                                                                                                                            |
| Dictation                | [`bridgemind/dictation-repair-hardening-loop.md`](./bridgemind/dictation-repair-hardening-loop.md) | DV1-DV16 source complete; physical/package matrix remains                                                                                                                                                                                                                                                                                                                                                         |
| Issue-to-Flight          | [`issue-flight-mirror-design.md`](./issue-flight-mirror-design.md)                                 | P0-P3 source complete; packaged GitHub/Gitea proof remains                                                                                                                                                                                                                                                                                                                                                        |
| Monitor                  | [`send-to-monitor-plan.md`](./send-to-monitor-plan.md)                                             | Windows lifecycle fixes installed in 0.14.3; native opening, projection, two-display and shutdown proof recorded. Stale-entity, Flight, denial-integration and full keyboard/responsive cases remain.                                                                                                                                                                                                             |
| Local model routing      | [`local-model-routing.md`](./local-model-routing.md)                                               | **Mostly landed (2026-08-26):** Ollama tool-capability picker gating, `api-custom` OpenAI-compatible provider (LM2), usage-ledger provider field + spend-split script, subagent parent-provider derivation, fail-closed local routing, per-row model pins, pure-text aux migrations. Remaining: codebase-dependent aux migrations (3C-3), and the local-opt-in banner gated on a green `ollama_e2e --ignored` run |
| API-agent auth cleanup   | [`oauth-removal-plan.md`](./oauth-removal-plan.md)                                                 | Credential migration complete; explicit retired-conversation provider switch remains                                                                                                                                                                                                                                                                                                                              |
| Cost controls/efficiency | [`cost-efficiency-loop.md`](./cost-efficiency-loop.md)                                             | Reporting surface removed; caching/edit improvements partly complete; live measurement and bounded edit debt remain                                                                                                                                                                                                                                                                                               |
| Packet Control           | [`packet-control-loop.md`](./packet-control-loop.md)                                               | Proposed, not started; shared evidence contract must precede implementation                                                                                                                                                                                                                                                                                                                                       |
| Computer Use             | [`computer-use-plan.md`](./computer-use-plan.md)                                                   | **STILL PAUSED 2026-08-16** by owner decision; design and decisions complete (browser tier first, Rust in-process, approval-gated, Windows-only v1); §7-PAUSE of the plan is the pickup runbook. The 2026-08-27 unpause covered Remote Agents only — the two pauses were same-day siblings but are no longer linked                                                                                               |
| 2026-08-01 P1 pass       | [`high-priority-real-work-loop-2026-08-01.md`](./high-priority-real-work-loop-2026-08-01.md)       | Evidence record for the runtime-authority correctness pass (`fd8c226`); source and review complete                                                                                                                                                                                                                                                                                                                |
| GitHub pane v9 residue   | [`github-pane-v9-loop.md`](./github-pane-v9-loop.md)                                               | Scoped GitHub-pane deferrals; remaining work is tracked in `../backlog.md`                                                                                                                                                                                                                                                                                                                                        |

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

- [Agents/runtime implementation handoff](./agent-experience/README.md)
  turns the October 19 review into proposed technical contracts, work packets,
  ownership/dependencies, migrations, failure tests, future agent prompts and
  local/SSH/native acceptance. It is documentation only. Composer research is
  owned by the separate packetbench-model-lab project and excluded; existing-runtime evaluation remains.
- [Composer research and experimental path](./composer-research-2026-10-19.md)
  preserves the historical Composer/model/harness assessment. The canonical
  [active plan](https://github.com/packetloss404/packetbench-model-lab/blob/main/docs/PLAN.md)
  and preparation now live in the private **packetbench-model-lab** repository.
  Local unpaid preparation is approved; GPU rentals, paid API calls, training
  and deployment remain unapproved. The transferred starting proposal is
  archived in that repository; this research report is no longer the active plan.
- [Agent harness, Cursor and desktop experience review](./agent-harness-and-experience-review-2026-10-19.md)
  is the October 19 fresh runtime/GUI/journey assessment at `e5d31084`.
  It verifies Cursor ownership/weekly plans and official ChatGPT-plan options,
  separates owned-harness feasibility from model training, and documents
  typography, Agents reliability and native/Mac evidence limits. Proposed work
  is indexed in `../backlog.md`; it is not an implemented overhaul.
- [Flight runtime and experience review](./flight-overhaul-review-2026-10-19.md)
  records separate runtime, GUI and journey reviews, the implemented overhaul,
  local/Docker SSH Stop/restart/repair/delivery/archive walkthroughs, final gates
  and installed-app smoke. One-agent Assisted is the default. The report keeps
  source, paid native walkthrough and installed-package evidence distinct.
- [Loop and graph engineering alignment](./loop-and-graph-engineering-alignment-2026-10-19.md)
  reviews Cherny/Osmani and Kopadze against source `4698ca9c` on October 19.
  Existing Flight loops/DAGs are present; the subsequent overhaul implements
  freshness, reviewer usage and retry-accounting repairs. Remaining follow-ups
  live in `../backlog.md`; this research remains a dated source assessment.
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
