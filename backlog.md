# PacketBench Backlog

## Current completion order — reconciled October 24, 2026

**Finish the existing desktop/runtime work and acceptance before Remote Agents.**
This later October 24 owner decision supersedes the Remote-Agents-first order
published in `4da14806`. Follow [the completion plan](dev/agent-experience/08-desktop-completion-before-remote-agents.md).
This is the
single live task ledger. [Current status](dev/current-status.md) gives verified
facts; [the source/deployment audit](dev/documentation-audit-2026-10-24.md) maps
committed slices to missing target contracts. Checked historical source slices
below do not close these residuals or prove deployment. Source `922ddcc9` is
committed and pushed; latest installed-source identity remains unverified.

1. **Runtime/desktop safety:** start N1 diagnosis and complete the actual
   backend launch/turn/recovery transaction, uncertain spend retention and
   typed policy/image recovery. Preserve host identity, drafts and approvals.
2. **Agents flow and readability:** finish retained assets, truthful SSH/start
   behavior, authoritative history/attention, scale/control migration, reader
   continuity and keyboard/IME proof. Reuse already-landed F/V slices.
3. **Existing feature hardening/proof:** refresh older bounded source findings;
   close applicable provider/SDK/MCP/Memory/Flight/inbox/YOLO/Git host issues,
   dictation/Monitor hardware and platform cases within their existing scope.
4. **Desktop completion/acceptance gate:** independent integrated review,
   focused plus final full local quality gates, source-bound installers and
   native local/Docker SSH Stop/restart/repair/review/delivery/archive evidence.
   Windows/macOS/provider/hardware matrices retain named prerequisites; keep
   unavailable evidence open. Signing/updater retain owner decisions.
5. **Remote Agents, afterward:** close transport/replay/ACK/ticket/hello/E2EE
   contracts, then internal presence and backend/PWA control. Extend existing
   `D:/projects/packetrelay`; preserve its committed foundation and compatibility.
   External beta still needs auth/recovery/encryption/revocation, datastore and
   phone/push/security/load proof. Keep production fail-closed while waiting.
   [The canonical plan](dev/remoteagents/README.md) retains its full requirements.
6. **Later integrations:** quota disclosure, scoped app verification and
   supported-plan feasibility; native iOS follows the PWA. Composer research
   belongs to the separate packetbench-model-lab project and remains excluded.

The [October 25 desktop GUI follow-up plan](dev/bridgemind/feature-gap-plan-2026-10-25.md)
preserves this order: desktop acceptance, existing Remote Agents, then bounded
workflow, preview/results and review additions. It covers BridgeMind, Cursor,
Codex and Claude; BM1–BM5 and GUI1–GUI5 are below. Existing N1, F3/F6, H8/H9,
Remote Agents, Packet Control and PacketAgent work retain their current owners.

### Verified agent-experience residuals

- [~] **P1 — Current-source advertised-feature acceptance.** The October 25
      team audit maps the README's advertised operations to source/browser
      coverage and named native/live prerequisites in
      [the acceptance inventory](dev/advertised-feature-acceptance-2026-10-25.md).
      DONE: the latest isolated result for all twelve local gates passes
      (3,296 Vitest, 24 Chromium, 1,300 Rust library tests, 12 offline evaluator
      cases); a complete Vitest rerun closes the initial cold-import timeout
      without removing assertions. Disposable Linux SSH passed 15/15 native
      sidecar/PTY cases. The report preserves exact source/evidence identities;
      the concurrent-source shared-checkout run is exploratory only.
      Browser journeys use a simulated Tauri bridge; sidecar SDK doubles,
      shared-protocol/PWA builds, fixture SSH and old installed navigation do
      not close real provider, production-host SSH, installed GUI/PTY, keyring,
      hardware or host-integration acceptance. DONE: clean build source
      `04cd0e16` produced both unsigned Windows x64 installers; both delivered
      copies passed all 8,683 payload hashes plus bundled Node/protocol/two-turn
      echo checks. Exact source/artifact hashes and retained logs are in the
      audit receipt. Readiness passed with zero failures and 17 disclosed
      warnings; no installer or main app was executed. GitHub had zero statuses,
      check runs and Actions runs for that pushed build source. The owner
      requested verified installers without reinstalling; installed native and
      full named live integration acceptance remain open. Signing/updater
      deferrals retain their existing owner-only scope.
      REFRESHED (clean tree `2dded7c7`, sourceSha256 `de0a9186…`): the disposable
      Docker Linux SSH matrix re-ran 15/15 (9 sidecar + 6 Workspace PTY,
      evidence `test-results/acceptance/live-ssh/2026-10-26T00-40-43-658Z`), and
      a clean build produced both unsigned Windows x64 installers with 8,683
      exact payload hashes each plus bundled Node v24.15.0/protocol-v12/two-turn
      echo (manifest `test-results/acceptance/windows/2026-10-26T01-03-05-816Z`,
      payload report `test-results/acceptance/payloads-3e2a92f1777f4a04a7e5a349800b683d`).
      The SSH runner needed an integration fix first (commit `2dded7c7`). OPEN
      and unchanged: installed GUI journeys, real provider/paid calls, macOS,
      Windows IME/display-scale and microphone/headset hardware evidence.

- [~] **P1 — R1/R3 production transaction and recovery.** DONE: the public
      resume path now derives and verifies the live policy context, so a
      compatible checkpoint offers `typed` (commit `f6cc73ae`); the run manifest
      is recorded in production (commit `8187c8a3`); a finished turn now records
      its terminal run state (epoch-CAS, `finished` event) from all three
      api_agent spawn sites (commit `63b44dfa`); a UI Stop now also cancels the
      journalled launch operation so the operation phase and run state agree
      (commit `c3c239d5`); startup now reconciles crash-stranded non-terminal runs
      to `needs_reconciliation` and an existing turn is refused for an unrelated
      project owner (commit `8f74d19c`); the immutable execution authority
      (local/SSH host + host-key pin) is frozen in the launch and a changed
      target is refused on an existing turn (commit `9a5b316e`); a typed resume
      reconstructs and seeds the provider history from the latest replayable
      checkpoint and refreshes the session epoch (commit `afb146dd`, review
      fixes `7c9f5890`); each user turn (initial/follow-up/retry) now prepares
      its own run linked to its predecessor (commit `ea830f7b`, review fix
      `d2a4a102`); a conversation's durable run state is exposed and a Resume
      action is wired into the conversation view (commits `6a75e071`,
      `b4d7a7a7`, `6a24774d`). DONE (restart recovery): a run now freezes its
      policy identity at prepare time (`FrozenRuntimeLaunch.policy`), so a typed
      resume verifies without a live session and survives a genuine app+backend
      restart (commit `3106f396`); the restarted session seeds the durable typed
      checkpoint instead of the text transcript, gated on an explicit TYPED
      resume (commits `a80af42a`, review fix `de0a9e32`); the preparation and
      dispatch boundaries have crash-injection coverage (commit `cb9b18ff`).
      OPEN: typed image pins; the rest of the §4.2 runner-level crash-injection
      matrix (effects/cancellation/recovery already covered; extend as adapters
      land); the frontend resume action is only reachable from the
      `needs_reconciliation` banner and has no native GUI evidence. Keep
      native/SDK strength explicit.
- [~] **P1 — R5 uncertain liability and truthful budget strength.** DONE: a
      durable `dispatched_at` marker (journal v5→v6, additive) is set by the
      runner and the R7 child loop at the last pre-dispatch point; `release`
      retains a dispatched reservation as `uncertain` (which still counts toward
      committed spend) instead of freeing it, and `reconcile_reserved` retains a
      dispatched-but-absent row rather than releasing it (commits `d1a92522`,
      `e8fcb3ae`). OPEN: system/tool/image input in the estimate and scope
      ownership; a proven-safe release path for `uncertain` liability; and the
      activation/cap claims (journal still default-off, budgets conditional — do
      not enable merely because a prerequisite commit landed).
- [~] **P1 — F2 retained assets and delivery failure.** DONE: GC never reclaims
      assets whose v2 envelope is newer/unknown or corrupt (commits `02641d6e`,
      `764cdbd5`); a send is blocked (never silently drops an image) when a
      staged durable ref's bytes are unreadable (commit `905e574d`); launch
      drafts are scoped by project identity (commit `354a6e78`). OPEN:
      message/submission/checkpoint ownership pins and grace/aggregate-capacity
      rules (the checkpoint pins couple to R1/R3 typed image recovery).
- [~] **P1 — F4/F5 wrong-target and failed-start behavior.** DONE: contextual New
      preserves SSH server identity via `makeSshUri`, and a rejected backend
      start retains the draft and reports failure instead of claiming Running
      (commit `02641d6e`); the launcher now has a shared operation handle with a
      duplicate-Start guard and a revision-guarded auto-pick
      (`agentLaunchStore`, commits `9b5ce1b6`, `753828a4`); UI Stop already keeps
      the turn active until the authoritative `api-agent:done {cancelled}` (a
      failed invoke restores) with no fixed timeout. OPEN: tie the phase strip
      to backend prepare/start/cancel outcomes (labels still substitute for the
      durable phase); keep a preparing item visible in the conversation/project
      list; freeze + display effective provider/model/posture overrides; GUI
      evidence for the launch/Stop/restart journey.
- [~] **P1 — F3/F6 authoritative history and attention.** DONE: the exact
      permission/plan/failure attention closes the review overlay so the target
      is visible, and the return anchor survives (commit `02641d6e`); the Flight
      transcript-mutation restriction is now enforced at the store boundary
      (`forkConversation`/`rewindConversation` refuse a Flight-owned
      conversation), not only in the UI (commit `46e0094d`). OPEN: exact
      approval routing and reader-return from every entry point.
- [~] **P2 — V3–V8 final migration.** DONE: one rendered sidebar-width/reset
      owner (`appearanceStore.agentSidebarWidthPx` with legacy migration) and the
      transient terminal dialog now follows the terminal text preference;
      mic/Stop/Send carry accessible names and 32px targets (commits `ae1d8ee7`,
      `43c8d45a`). OPEN: legacy typography/geometry scaling, narrow header/drawer/
      action lane and actual composited contrast.
- [~] **P2 — R4/R6/R7/R8 remaining contract/evidence.** DONE: the R6
      context/window readout (`get_runtime_context_summary` with a window-known
      disclosure and a hash-verified latest-snapshot store, commit `88d34a54`)
      and explicit R7 child cancellation (a per-turn cancellation token threaded
      into the child loop; `SubagentStatus::Cancelled`; commits `6d3498e5`,
      corrected `b2cb653b`), and production R4 manifest recording (identity
      derived at turn start and inserted into the `manifests` table, commit
      `8187c8a3`). OPEN: the conservative window/counting policy for non-Anthropic
      routes (the static table resolves an unknown window that never blocks) and
      SDK hooks/declarations. Retain offline v1 success
      separately from unimplemented live/repeated/isolated task evidence. No
      model-training or Composer research is included.
- [ ] **P1 — Installed-source and native verification.** The October 23 installed
      executable matches its available NSIS payload, but no source manifest
      binds it to `922ddcc9`. N1 navigation diagnosis, native IME/appearance/
      restart and local/SSH whole-flow acceptance remain. The current process
      responding at rest does not close these cases.

## BridgeMind follow-up — October 25, 2026

Expanded October 25 with the Cursor, Codex and Claude GUI review. Planning
only; no application changes or new acceptance results. The
[phased plan](dev/bridgemind/feature-gap-plan-2026-10-25.md) records source
evidence, dependencies and exit criteria. This backlog remains the only task
ledger. All BM/GUI items follow desktop completion and the existing Remote
Agents program; none expands the current desktop completion gate.

- [ ] **P2 — BM1 exact CLI conversation recovery.** Extend existing named
      Claude Code/Codex PTY panes with a provider-supported conversation identity
      distinct from the transient PTY id. Bind recovery to the original CLI
      account/config directory, checkout/worktree and local/SSH host identity.
      Offer explicit Resume/Start fresh and a truthful recovery outcome; retain
      failed/missing/unsupported resumes without falling back to another account,
      folder or conversation. Do not replay an unconfirmed prompt. Acceptance:
      packaged restart and closed-pane reopen; missing transcript/account/folder,
      changed SSH identity and CLI update/failure; no duplicate process or send.
      Reuse multi-account and workspace persistence. R1/R3 API-agent continuation
      remains its own existing item; this does not keep a process alive on quit.
- [ ] **P2 — BM2 destination-aware issue and prompt delivery.** Extend the
      existing Issue dispatch and Prompt Library with one target-selection
      contract for an existing terminal/conversation or an explicitly launched
      Flight attempt. Saved prompts insert a retained draft by default; adding
      drag/drop must use the same path and have a keyboard-accessible equivalent.
      Distinguish inserted, queued, accepted, failed and delivery-unconfirmed;
      never infer agent acceptance from a successful PTY write. Change issue
      status only on confirmed execution acceptance. Preserve exact input and
      target on failure, prevent duplicate pending delivery and revalidate the
      account/host/worktree before submission. Acceptance covers busy/exited
      targets, approval dialogs, partial writes, stale targets and retry/reload.
      Extend this same delivery path with explicit queue/steer behavior only
      where the adapter supports it; edits must send the saved version, and
      cancelling a queued prompt returns its text/attachments to the draft.
      Preserve the Workspace/Agents ownership contract and authoritative
      Issue-to-Flight linkage; no new conversation attachments to Workspaces.
- [ ] **P2 — BM3 consistent cross-surface attention.** Extend existing
      Fleet/Agents/Flight attention projections, approval stores, notifications
      and Coordination Inbox with shared ordering, reason, age and exact-target
      navigation. Reuse authoritative event/decision identities to deduplicate;
      do not create another queue or approval authority. Pending decisions and
      failures remain visible ahead of ordinary activity/review. Label heuristic
      stalls and unknown PTY state honestly; quiet output alone is not failure.
      Acceptance covers multiple workspaces/Flights, late/out-of-order events,
      cancelled decisions, review overlays, reader return anchors and reconnect.
      Existing F3/F6 repairs and PacketAgent PH9 proof remain under their owners;
      this item owns only the additional cross-surface integration.
- [ ] **P3 — BM4 persistent teammate design.** Later bounded product design
      over existing profiles, conversations, project Memory and skills/MCP trust:
      define stable teammate identity, per-teammate history/memory scope,
      approved folders, engine-change behavior and inspect/edit/forget controls.
      Deliver a reuse/migration proposal and explicit go/no-go before any new
      runtime or UI mode. Do not duplicate Memory/MCP programs, silently broaden
      authority or turn a reusable profile into an always-on worker. Routine
      execution continues to belong to PacketAgent; evaluate schedule/result
      visibility through its existing handoff, with no desktop cron scheduler.
- [ ] **P3 — BM5 background PTY host feasibility.** After BM1, evaluate the
      additional value of preserving an existing CLI process through desktop
      quit/update against the PacketAgent handoff. Deliver an architecture and
      explicit go/no-go covering single ownership, authenticated local attach,
      duplicate prevention, scrollback privacy/retention, process-tree cleanup,
      update/crash/reboot behavior and per-platform acceptance. Preserve current
      quit cleanup until a separately selected implementation earns those gates.
      This is research, not a new daemon commitment or PacketAgent replacement.

### Cursor, Codex and Claude additions

- [ ] **P2 — GUI1 task-linked result viewers.** Extend existing file/editor
      and review surfaces with task-linked report, image, PDF, table and
      generated-file viewers, download/export and links back to source/run/
      revision. Reuse durable-asset ownership, provenance and Packet Control
      evidence references; do not create another artifact store or capture
      runtime. Start with read-only supported formats. Isolate active HTML or
      interactive content from privileged host APIs before enabling it.
      Acceptance covers local/SSH materialization, large/malformed/missing
      files, stale revisions, restart and per-view position restoration.
      Unavailable formats/remote access must be explicit. H8 owns browser
      capture; Packet Control keeps its existing terminal-evidence scope.
- [ ] **P2 — GUI2 conversation/worktree handoff and recoverable cleanup.**
      Add explicit movement of the same logical conversation between its local
      checkout and a managed worktree, preserving context and staged work.
      Reuse current worktree lifecycle and BM1 identities. Quiesce the active
      run and prepare a new immutable execution binding for continuation;
      never retarget an in-flight run. Preserve dirty/untracked work, enforce
      branch ownership and provide recoverable, bounded snapshots before
      managed cleanup. Verify snapshot persistence before deletion; protect
      active/pinned work and keep ignored/secret files outside implicit copies.
      Acceptance covers dirty destinations, branch conflicts, interrupted
      transfer/restore, duplicate handoff and missing snapshots. Cross-host
      migration requires a separate capability/authority design; neither SSH
      nor cloud migration is implied. This is distinct from BM1 resume and
      existing Merge/Keep/Discard, not a replacement worktree implementation.
- [ ] **P2 — GUI3 persistent security findings.** Extend Code Quality,
      Reviewer Gate and existing review-comment/diff surfaces with stable
      findings bound to repository/base/head and scanner/reviewer identity.
      Retain attack-path evidence, assumptions, triage/dismissal reasons and
      fix links; revalidate against the changed revision before claiming fixed.
      Preserve findings across reviews without duplicate issues or another
      review engine. Acceptance covers moved code, repeated scans, stale
      verdicts, changed threat context and false-positive decisions. A review
      reporting no findings is not a clean-security guarantee. Use bounded
      fixtures and existing permission/budget gates for verification.
- [ ] **P2 — GUI4 opt-in PR follow-up.** Extend existing Git host integration,
      review freshness and bounded remediation with an explicitly enabled
      follow-up for one PR's failing checks or new review feedback. Freeze
      repository/host/PR/head identity, authority, spend/retry limits and Stop;
      deduplicate events and revalidate after human changes, force-push or
      closure. Incoming comments/check logs are untrusted evidence, not new
      authorization. Reuse PacketAgent for durable triggers beyond app lifetime;
      do not add a desktop scheduler, full CI dashboard or hosted CI for this
      repository. Show proposed repairs/results and retain deliberate publish,
      ready-for-review and merge actions. Acceptance covers stale heads,
      duplicate/replayed events, unavailable host capabilities and cap exhaustion.
      Existing Flight repair/review proof remains under its current owner.
- [ ] **P3 — GUI5 deployment-health feasibility.** Later design only: map
      user-project deployment events to an exact commit, environment and bounded
      observation window, with expected signals and explicit inconclusive
      outcomes when telemetry is missing. Reuse PacketAgent trigger/lifecycle
      ownership, existing deploy integration and Packet Control evidence;
      avoid a second monitor daemon or review store. Deliver an integration/
      capability proposal and go/no-go with healthy/regressed/inconclusive
      evidence criteria, noisy/late-event handling and approval boundaries.
      Do not enable telemetry connections, automatic rollback or remediation
      from this planning entry. Existing Monitor UI expansion remains separate.

Existing work extended by this review, without duplicate task rows:

- N1 owns responsiveness diagnosis and measured visible/hidden-window behavior.
- F3/F6 and current flow/appearance acceptance own restoration of existing
  file/diff/transcript/draft/focus state; BM2 owns queue/steer delivery semantics.
- H8 owns scoped preview, optional element/CSS context and bounded visual
  verification; H9 continues to own evidence-backed usage disclosure.
- Remote Agents owns phone approval controls; PacketAgent W9/PH10 owns durable
  continuation proof, with existing handoff polish owning remaining UI work.
- Side questions and inline diff comments already exist; harden/prove their
  current behavior rather than create competing implementations. GUI1/GUI3
  reuse those surfaces and existing asset/evidence contracts.
- Existing reviewer gates, task graphs, Memory, MCP and dictation tracks remain
  authoritative; a competitor feature does not reopen completed source work.

## Agent harness and experience review — October 19

This section is the dated incremental implementation log for October 19–24.
Its checked rows mean the named source slice landed. Earlier residual sentences
and test counts describe those checkpoints; the reconciled residuals above and
current audit supersede stale "uncommitted", "not started" or full-completion
interpretations. Full target specs remain in `dev/agent-experience/`.

The [original review](dev/agent-harness-and-experience-review-2026-10-19.md) is
dated research/source evidence with one unresolved native observation. Checked
rows now record committed slices; current residuals above govern completion.
Finding IDs below resolve to detailed source references and acceptance criteria.
The subsequent [future-team implementation handoff](dev/agent-experience/README.md)
adds researched contracts, packets, dependencies/file leases, migrations,
fault tests and dispatch prompts. The target remains incomplete despite the
committed slices below. Composer research is in the separate packetbench-model-lab project and
excluded from that team. H1 evaluation applies to the existing production runtime.

### Desktop-completion tranche — October 24 (later), commits `02641d6e`, `ae1d8ee7`, `764cdbd5`, `43c8d45a`

Coordinator pass over the source-confirmed residuals in
[the audit](dev/documentation-audit-2026-10-24.md). Frontend flow/appearance
only; **no Rust, build, install, provider or native/Docker run was performed**.
All four commits are on `main`, staged selectively so the concurrent
Composer/model-lab edits were preserved and excluded.

- **F5 contextual New preserves SSH identity** — `AgentsView.handleNewAgent`
  rebuilds `ssh://<serverId>?path=<remotePath>` via `makeSshUri` instead of
  handing a bare remote path to `setSelectedRepo` (which would launch locally);
  worktree conversations still resolve to their base checkout.
- **F4 failed start retains the draft** — `launchConversation` detects the
  `failed` conversation that `createApiConversation` returns after a rejected
  backend start, reports failure and keeps the draft/attachments instead of
  showing Running and clearing the composer.
- **F2 conservative draft-asset GC** — `gcOrphanDraftAssets` reads the raw v2
  envelope and refuses to reclaim when it is newer/unknown or corrupt, so an
  unreadable envelope can never yield an empty keep set and wipe its images.
- **F6 approval visibility** — permission/plan/failure attention closes the
  review overlay (the return anchor survives) so the exact card is visible.
- **V3/V7 single sidebar-width owner** — `appearanceStore.agentSidebarWidthPx`
  is the one rendered owner; the drag/keyboard separator and Appearance reset
  write it. A legacy `agent-sidebar-prefs.width` is adopted once (also when
  appearance prefs exist, while the width is still default) and then consumed.
- **V3 transient terminal font** — `TransientPtyModal` follows
  `terminalSettingsStore.terminalFontSizePx` and updates live.
- **V5/V6 primary controls** — mic/Stop/Send gained `aria-label`s and 32px
  targets.

Evidence: focused Vitest (launchConversation, AgentsView, agentDraftStore,
agentAttention, AgentSidebar, appearanceStore) plus a full local `vitest run`
(330 files / 3286 tests), `tsc --noEmit`, `eslint src` (0 errors) and
`format:check` all pass on this source. An independent read-only review of the
commits found no blocking defects; its non-blocking findings (legacy width
adoption, failure wording, remote URI fallback) were fixed in `43c8d45a`.
Open: Phase 1 runtime/recovery/spend, the remaining F2/F3/F6/V3–V8 items, N1
diagnosis, and every build/install/native/Docker acceptance case — no native
evidence was produced here.

### Plan execution — desktop completion gate

**A1 one-root-run-per-turn + resume wiring + F3 boundary guard (R1/R3, F3),
commits `ea830f7b`, `d2a4a102`, `6a75e071`, `b4d7a7a7`, `6a24774d`, `46e0094d`.**
Follow-up and retry turns now prepare + bind a fresh run linked to their
predecessor instead of reopening the session's first run (`ea830f7b`); the run's
project path is derived from the execution target in one place so the owner guard
cannot trip on a divergent path (`d2a4a102`, peer-review fix). A conversation's
durable run state is exposed (`latest_run_for_conversation` +
`get_conversation_runtime` + `getConversationRuntime`), `ResumeInspection` is
exported to TS, and a `RuntimeRecoveryBanner` offers a Resume action that
inspects and continues from the run's durable history (`6a75e071`, `b4d7a7a7`,
`6a24774d`). The F3 Flight transcript-mutation restriction is now enforced at the
store boundary — `forkConversation`/`rewindConversation` refuse a Flight-owned
conversation (`46e0094d`). Evidence: full lib suite passed; full frontend suite
**335 files / 3333 tests**; `check:tauri-schema` passes; tsc/eslint clean.
Remaining Phase-A: typed image pins (blocked on the typed-image-recovery
contract), the §4.2 runner-level crash-injection matrix, and the F4 frontend
operation-handle.

**Real restart recovery + native acceptance refresh, commits `3106f396`,
`cb9b18ff`, `a80af42a`, `de0a9e32`, `2dded7c7`.** A run now freezes its policy
identity (schema/transport versions, tool-policy and MCP-trust hashes, account
label) into the launch operation at prepare time, derived from the same inputs
the checkpoints are written with, so a typed resume can be verified when no live
session remains after a genuine app+backend restart (`3106f396`). A restarted
session then seeds the durable typed checkpoint instead of the frontend text
transcript — gated on an explicit TYPED resume, a replayable checkpoint and no
unresolved effect, so an unconfirmed prompt is never replayed and a semantic
resume is never silently upgraded (`a80af42a`, review fix `de0a9e32`).
Runner-level crash injection covers the preparation and dispatch boundaries
(`cb9b18ff`). An independent review found the semantic→typed upgrade hole and
the review fixes landed in `de0a9e32`.

Native/live evidence on the frozen tree (`2dded7c7`, sourceSha256 `de0a9186…`,
dirty false): the disposable Docker Linux SSH matrix passed 15/15 cases
(`test-results/acceptance/live-ssh/2026-10-26T00-40-43-658Z`), and
`pnpm acceptance:build` + the payload verifier passed both unsigned Windows x64
installers with 8,683 exact payload hashes each, bundled Node v24.15.0 and
protocol-v12 two-turn echo (`test-results/acceptance/windows/2026-10-26T01-03-05-816Z`,
`test-results/acceptance/payloads-3e2a92f1777f4a04a7e5a349800b683d`). The SSH
runner itself was broken by `b4d7a7a7`'s extensionless Workspace-CLI-registry
import and bare JSON import, which Node's ESM/type-stripping loader cannot
resolve; fixed in `2dded7c7`. `pnpm gates:full` passed all 12 gates on
`2dded7c7`. Still open (concrete prerequisites): installed GUI journeys,
real/paid provider calls, macOS, Windows IME/display-scale and
microphone/headset evidence — see the acceptance item above.

**Durable launch phase + image pins (F4/F2B), commits `0a6a0787`, `00eda634`.**
The launch phase now derives from the durable run state — `prepared`→starting,
`running`→running, `needs_reconciliation`→unknown, `failed`/`cancelled`→failed —
so a promise resolution no longer announces Running and an ambiguous outcome is
never laundered into success (`0a6a0787`). Durable image `pin`/`unpin` commands
land and GC skips pinned assets regardless of the caller's in-memory keep set,
so a submission/checkpoint holds retention across restart and pinning a missing
asset fails closed (`00eda634`). OPEN (source, not external): the send path still
ships inline base64 and must migrate to stage→pin→reference `attachment_id`;
typed checkpoint image replay; `closed_unknown` budget reconciliation; F6
approval/reader routing from every entry point; V3–V8 legacy scaling/contrast
residuals. See `dev/agent-experience/acceptance-handoff-2026-10-26.md`.

**Authoritative launch identity (F4), commit `a349ae99`.** `start_api_agent_session`
now returns the prepared runtime run summary (operation/run id, epoch, phase)
when the journal is enabled, and the store stores it as a read-only
`conversation.runtime` projection — the launcher's missing operation/run
identity for authoritative phase reporting and cancel/inspect. Sidecar and
disabled starts return null. Full gates green at `a349ae99`; both installers
rebuilt + payload-verified (NSIS `01b2bcaf…`, MSI `837f27fe…`); Docker SSH
15/15 at `test-results/acceptance/live-ssh/2026-10-26T02-26-07-171Z`. Native GUI
acceptance handed to a desktop session via
`dev/agent-experience/acceptance-handoff-2026-10-26.md`.

**F4 launch operation handle (F4), commits `9b5ce1b6`, `753828a4`.** A new
`agentLaunchStore` is the canonical launch transaction: an honest phase
(`idle/preparing/ready/starting/cancelling/running/failed/unknown`), a draft
revision, and `begin()` which refuses a duplicate Start for the SAME in-flight
revision — even across a remount — so a repeated Enter/click yields one
operation/run/worktree. `AgentsView` reads its phase from the store and routes
`handleLaunch` through `begin()`; an explicit provider/model/mode/profile change
bumps the revision and starts a distinct operation, and the credential auto-pick
captures the revision it started under so a late probe result can only apply
while the automatic selection is still current (`753828a4`). Evidence: focused
Vitest (store 5 + AgentsView 12), tsc and eslint clean. Remaining F4: connect the
phases to authoritative backend prepare/start/cancel outcomes; keep a preparing
item visible in the conversation/project list; freeze + show effective
profile/model/posture overrides; Stop/cancel must acknowledge from backend state
(no fixed timeout, and a local ack is not proof an unreachable SSH process
stopped).

**A1 typed-resume continuation (R1/R3), commits `afb146dd`, `7c9f5890`.** An
epoch change advanced the journal but never continued the provider.
`resume_runtime_run` now, on a typed resume, loads the run's latest checkpoint
(`load_latest_checkpoint`), refuses to reconstruct when an unresolved effect is
pending or the history is not replayable (`validate_replayable`), seeds the live
session's provider history (`ApiAgentState::runtime_seed_history`), and refreshes
the session binding to the resumed epoch. A peer review of the A1 series also
fixed: `finish_run` mirrors the terminal phase onto the launch operation and
`cancel_operation` guards its run update (no cancel-after-complete clobber); the
execution-binding conflict ignores a later-populated TOFU pin. Known limitation:
the seed requires a live session, so it does not fire after a bare restart
(where only `semantic` is offered) — that is the unwired frontend resume flow.
Evidence: full lib suite **1306 passed / 0 failed**, runtime-eval **12/12**,
fmt clean.

**A1 immutable execution authority (R1/R3), commit `9a5b316e`.** The frozen
launch captured route/model/project but not the execution target, so an existing
turn could extend a conversation against a different SSH host undetected (the
`project_key` is path-only). `FrozenRuntimeLaunch` now carries an optional
`FrozenExecutionBinding` (kind + SSH server id, host, verified host-key pin);
`prepare_session_run` freezes it from the `ExecutionTarget`, and
`prepare_operation` refuses an existing turn whose binding differs from the
owner's (compared only when both sides carry a binding, so legacy rows load).
Schema regenerated. Evidence: full lib suite **1303 passed / 0 failed**,
`check:tauri-schema` passes, runtime-eval **12/12**, fmt clean.

**A1 startup reconciliation + owner validation (R1/R3), commit `8f74d19c`.**
`runtime_journal::reconcile_runs_on_startup` marks every non-terminal run
`needs_reconciliation` (with a `reconciled` event) — the journal is
single-instance, so such runs belong to a dead process — and is idempotent;
`agent_runtime::reconcile_runs_on_startup` wraps it and `lib.rs` calls it beside
the budget reconcile. `prepare_operation` now also refuses an existing turn whose
`project_key` differs from the conversation owner's (unrelated-owner guard).
Evidence: full lib suite **1302 passed / 0 failed**, runtime-eval **12/12**, fmt
clean. (One unrelated Windows process-timing test flaked under concurrent CPU
load and passed in isolation and on rerun.)

**A1 cancel unification (R1/R3), commit `c3c239d5`.** A UI Stop only signalled
the running turn, leaving the journalled launch operation in its prepared phase
while the run ended. `runtime_journal::run_operation_id` maps a run to its
operation; `agent_runtime::cancel_session_run` best-effort cancels the bound
run's operation (no-op unless the journal is enabled and the session is bound);
`cancel_api_agent_session` calls it after the turn cancel. Evidence: full lib
suite **1300 passed / 0 failed**, runtime-eval **12/12**, fmt clean. (This
commit was briefly swept onto a concurrent agent's branch and moved back to
`main`.)

**A1 first slice (R1/R3 terminal projection), commit `63b44dfa`.** The journalled
run stayed `prepared` after a turn ended, so its durable projection was
untruthful. `runtime_journal::finish_run` adds an epoch-CAS terminal transition
(`completed`/`cancelled`/`failed`) with a `finished` event (idempotent and
stale-epoch-safe); `agent_runtime::finish_session_run` is the host helper (no-op
unless the journal is enabled and the session is bound); all three api_agent
`run_turn` spawn sites (start, follow-up, retry) record it. Behind the
default-off journal. Evidence: full lib suite **1300 passed / 0 failed**, 3 new
`finish_run` tests, runtime-eval **12/12**, fmt clean. Remaining A1 slices: the
actual prepare/start/cancel/reconcile bridge, immutable execution/SSH authority,
owner/revision/predecessor validation, one root run per turn, typed image pins,
and the §4.2 crash-injection matrix.

**A2a/A2b (F2B), commits `905e574d`, `354a6e78`, `914f0ea5`.** `stagedToImageAttachments`
now returns `{ attachments, unreadable }`; the Composer marks unreadable chips
missing (new `agentDraftStore.markAttachmentUnreadable`), raises a visible
rejection and blocks both the launch and chat send while keeping the draft (the
all-in-memory case stays on the synchronous fast path). Launch drafts are scoped
by project identity via `agentDraftStore.launchDraftKey(projectRef)` so switching
projects restores that project's own draft; the legacy `__launch__` slot remains
for a null project. Evidence: full frontend suite 331 files / **3296 tests pass**;
new `agentDraftAssets` suite, a Composer unreadable-at-send case, a Composer
project-switch case and a `launchDraftKey` unit test.

### Phase 1 runtime tranche — R5 uncertain budget liability, commits `d1a92522`, `e8fcb3ae`

Bounded Rust slice of Phase 1 (Rust only; no build, install, provider or native
run). The budget ledger previously freed a reservation whenever its request was
absent from the usage ledger — on the runner cancel path and in the startup
reconcile — so a request that had actually reached the provider could have its
headroom silently re-admitted, contradicting the module's own ledger-append
fail-closed policy.

- Journal v5→v6 (additive): `dispatched_at` on `requests` and
  `budget_reservations`; a migrated row defaults NULL (never dispatched).
- `runtime_budget::mark_dispatched` sets it; the runner calls it at the last
  pre-dispatch point (after `ensure_usage_healthy`, before the provider stream)
  and the R7 child loop mirrors it before `stream_chat`.
- `release` returns a `ReleaseOutcome`: a dispatched request becomes `uncertain`
  (still counted toward the scope's committed spend); only a never-dispatched
  request is freed. `reconcile_reserved` retains a dispatched-but-absent row as
  `uncertain` and reports the new count.

Evidence: `cargo check --lib` clean (only pre-existing warnings); full local
`cargo test --lib` **1291 passed / 0 failed / 9 ignored**; the offline
`runtime-eval --all` lane **12/12 pass**; 4 new budget unit tests, runner-level
dispatch-mark assertions, and a child-loop mark assertion. An independent
read-only review found no blocking defects; its substantive finding (the R7
child path did not mark dispatch) and nits (non-transactional marker, stale
module doc) were fixed in `e8fcb3ae`.

**R6 context/window readout, commit `88d34a54`.** `get_runtime_context_summary`
returns the latest context projection for a run plus an honest window-policy
disclosure (`windowKnown`, `policyNote`); it answers with no projection when the
journal is disabled rather than erroring, and is never a quota/dollar claim. A
new `runtime_context::latest_context_snapshot` selects the newest row and
decodes it through the hash-verifying path. New TS DTOs are registered and bound
(`RuntimeContextSummary`/`RuntimeContextProjection`). Evidence: full lib suite
**1293 passed / 0 failed**, runtime-eval **12/12**, `check:tauri-schema` and
`tsc --noEmit` pass.

**R7 explicit child cancellation, commit `6d3498e5`.** A per-turn
`CancellationToken` is created in `run_turn`, cancelled in every parent cancel
arm, and threaded through `ToolExecContext` into `ParentLlm`; the child loop
selects on it, drops its provider stream, releases its reservation (a dispatched
child becomes uncertain liability) and returns the new `SubagentStatus::Cancelled`
instead of relying on the implicit future-drop. Nested children inherit the
token.

**R7 correction, commit `b2cb653b`.** An independent read-only review found the
token inert on the production path: tokio's `select!` drops the losing branch's
futures *before* the winning arm's handler runs, so the tool-round `join_all`
(and every child in it) was dropped before `child_cancel.cancel()` executed. The
fix boxes the join, borrows it in the select, and on cancel awaits it under a 5s
timeout so children observe the token, abort and release; the cancellation test
now runs the child inline (matching production) and the status-mapping test
covers `Cancelled`. Residual: cancellation is observed at the child's stream
boundary, so a long child *tool dispatch* delays it (bounded by the 5s grace),
and there is no runner-level integration test for the parent select shape.

Evidence: full lib suite **1294 passed / 0 failed**, runtime-eval **12/12**, fmt
clean.

**R4 production manifest recording, commit `8187c8a3`.** `run_turn` calls
`RuntimeServices::record_manifest` once per turn before dispatch; the Tauri host
derives the identity from the frozen session binding — endpoint (resolved base
URL, provider id fallback), model, harness hash (effective system prompt),
tool-policy hash (reused from the checkpoint compatibility context), repository
revision (local git HEAD, else an explicit `unresolved` marker), context version
— and inserts a content-addressed `RunManifest` (fail-closed when enabled and
bound). `core::git::get_head_revision` is the new HEAD resolver. Evidence: full
lib suite **1296 passed / 0 failed** (manifest-identity + runner-call tests),
runtime-eval **12/12**, fmt clean. An independent review approved it (no blocking
defects); its follow-ups landed in `d9c5189d`: identity derivation + insert run
on the blocking worker (the local git subprocess never blocks the async
runtime), an invalid identity is skipped with a warning instead of failing the
turn (write failures stay fail-closed), and the MCP trust hash is folded into the
manifest `tool_policy_hash` so two runs differing only in MCP authority do not
collide.

**R1/R3 typed-resume wiring, commit `f6cc73ae`.** The journal's typed-resume
logic (`inspect_resume_with_compatibility`/`resume_run_with_compatibility`) was
already complete and tested, but the public commands always passed
`current=None`, so `typed` was unreachable and only `semantic` was offered.
`inspect_runtime_resume`/`resume_runtime_run` now take
`State<Arc<ApiAgentState>>`, derive the live `CompatibilityContext` from the
run's conversation session when it is still registered, and pass it through (a
missing session stays semantic-only, fail-closed). `journal::run_conversation_id`
maps a run to its conversation. Evidence: full lib suite **1297 passed / 0
failed**, runtime-eval **12/12**, fmt clean. Open: the full
prepare/start/cancel/reconcile bridge, owner/revision/predecessor validation, one
root run per turn, terminal projection, typed image pins, conservative window
policy for non-Anthropic routes, and the remaining R8 evidence; the journal is
still default-off.

- [ ] **P1 — Isolate installed Windows unresponsiveness (N1).** Flight Deck
      rendered, automated Agents navigation timed out, the next capture showed
      Not Responding and process checks agreed. Separate app/main-thread and
      accessibility/automation causes; preserve work/evidence and verify ordinary
      navigation, restart and recovery before closing. Earlier Flight smoke
      does not establish current whole-app responsiveness.
      October 25 follow-up: reuse the existing streaming/PTY batching and
      workspace-performance evidence; measure typing/Stop latency during heavy
      output, long-transcript reader anchoring, quiet-repository polling and
      hidden/minimized-window work on the source-bound installed package.
      Diagnose before optimizing; reduce rendering/polling without suspending
      execution, cancellations or approval tracking. Record fixture/source,
      before/after timings and limits; browser/synthetic throughput is not native
      proof. This extends N1, not a new performance program.
- [x] **P1 — Fail closed on worktree provisioning (F1).** Source implementation:
      a provisioning failure now starts no agent, creates no conversation and
      performs no root-checkout fallback; the draft and staged images survive
      for Retry or an explicit Local launch, and the error stays visible.
      Focused Vitest (`launchConversation`, `Composer`, `AgentsView`), TypeScript
      and ESLint pass. Native Windows acceptance remains open; installed payload
      was not rebuilt.
- [x] **P1 — Complete draft and attachment identity (F2A).** Staged images now
      live in an in-memory map keyed by conversation/launch identity, so A→B→A
      keeps A's images without leaking them into B. Late decodes bind to the
      draft that started them and are discarded after clear/send; unsupported
      type/size/read failures are visible; chips disclose **Kept in this
      session**. Text persistence is unchanged; bytes deliberately do not
      survive process exit. Focused Vitest (draft store, Composer) plus
      TypeScript/ESLint pass. Durable assets and native paste/drop restart checks
      remain open (F2B).
- [x] **P1 — Fork and truthful transcript rewind (F3 core).** Edit & fork now
      creates a real child conversation with lineage and leaves the parent
      byte-identical. Rewind saves the later transcript as a revision, truncates
      through the selected turn, changes no files and starts no turn; Stop
      failure aborts it. A read-only **View previous history** surface exposes
      saved revisions, and parent deletion retains a checkout still referenced by
      a fork. Discard and archive cleanup apply the same dependent-fork guard.
      Focused store/UI tests and TypeScript/ESLint pass.
- [x] **P1 — Durable draft assets (F2B core).** A backend draft-asset service
      (`stage`/`read`/`release`/`gc`) stores image bytes in app-data with
      type/size/base64/digest validation and no caller-controlled paths. The
      frontend persists a versioned `agent-drafts-v2` envelope holding only
      metadata refs (never bytes or blob URLs), hydrates refs back as staged
      chips, re-reads previews on demand after restart, and materializes wire
      attachments from refs when in-memory bytes are gone. Staging/read/gc run
      on a blocking worker thread, never the Tauri main thread. The legacy v1
      text map still migrates. Rust unit tests and focused Vitest pass.
- [ ] **P1 — Draft asset residuals and runtime pins.** Submission/checkpoint
      ownership refs, a global (cross-draft) capacity cap, H2 typed-image replay
      validation, and native WebView paste/drop/restart evidence. (Type sniffing,
      per-draft 20 MiB cap, startup GC and missing-asset handling are done.)
- [x] **P1 — Flight-owned transcript gating (F3).** Conversations that are the
      runtime-owned builder or reviewer for a Flight attempt now disable
      transcript fork/rewind with a visible note; a Flight's planning
      conversation is correctly excluded. Gating is applied in the chat pane;
      a programmatic store guard is still open. Focused tests pass.
- [x] **P1 — Old message links resolve to saved revisions (F3).** A navigation
      target whose message a rewind moved into a saved revision now opens the
      history modal with that message revealed and focused, instead of dropping
      the link. Focused test added.
- [ ] **P1 — F3 remaining.** Native local/SSH restart evidence for lineage and
      revisions.
      The current flow/appearance acceptance also owns working-position
      continuity across conversation switches and restart: supported file/line,
      diff scope, expanded tools, transcript anchor, draft caret/attachments and
      focus. Reuse existing restore paths and reproduce residuals before fixing;
      this does not require adding new document viewers or expanding Global Undo.
- [x] **P1 — Comfortable reading defaults (V1).** Shared tokens raised to
      comfortable sizes (UI 13/20, meta 12/16, transcript 15/24, composer 15/22,
      code 13/20, chip 12/18) with new composer/code/heading roles; the composer
      and markdown code consumers moved onto them. Raw `text-[Npx]` consumers
      remain a recorded residual.
- [x] **P1 — Informative-text contrast (V2).** Dark/light muted and faint now
      clear 4.5:1 on all five surfaces; `text-faint` aliases muted; added
      `decorative`, `control-border`, `focus-ring` and `on-accent` tokens. A
      token-level contrast test gates the palette; composited accent-alpha and
      disabled states still need their own checks.
- [x] **P1 — App scale and terminal text size (V3).** `appearanceStore`
      (storageKey `appearance`) with App scale 100–200%, reading base 13–22,
      density and sidebar width; one `resolveAppearanceMetrics` resolver and one
      root `useApplyAppearance` writer + Ctrl/Cmd `+`/`-`/`0` shortcuts; an
      Appearance card (with save-failure warning) and a separately owned
      terminal text size (10–32, storageKey `terminal-font-size`) applied live
      via xterm. Native enlarged-text evidence remains open.
- [x] **P1 — Safe IME and history input (F8).** The composer now ignores
      Enter/Escape/arrows and shortcuts while an IME composition is active
      (`isComposing` and legacy keyCode 229). Leaving history restores the
      pre-recall draft; a deliberate edit after recall is never overwritten by
      ArrowDown; history resets on conversation switch. Focused handler and
      Composer tests pass; native IME confirmation remains unverified.
- [x] **P1 — Stable preparation and explicit choices (F4 core).** Late auth
      probes no longer overwrite a provider/model/profile the user picked while
      they were in flight, and a slow launch no longer steals conversation
      selection (`selectOnCreate: false` + guarded re-select). Single-flight
      holds through async settlement. Focused tests, TypeScript and ESLint pass.
- [x] **P2 — Stable base-project grouping (F5 core).** Worktree and root
      conversations now group under their `worktree.basePath`, two
      repositories on one SSH host are labelled `repo @ server`, and New opens
      against the selected conversation's base project. Focused sidebar/Agents
      tests, TypeScript and ESLint pass.
- [ ] **P2 — Preparation phase surface and cancel tombstones (F4 residual).**
      The shared `agentLaunchStore` operation handle, duplicate-Start guard,
      revision-bumped selection and revision-guarded auto-pick landed
      (`9b5ce1b6`, `753828a4`); phase labels landed in `581cd5c2`. Still open:
      connect the phases to authoritative backend prepare/start/cancel outcomes;
      keep a preparing item in the conversation/project list when navigating
      away; freeze + show effective profile/model/posture overrides; Stop/cancel
      must acknowledge from backend state (no fixed timeout, and a local ack is
      not proof an unreachable SSH process stopped). F6 has a helper/header slice
      but approval reveal over review and global routing remain; F7 anchors are
      persisted.
- [x] **P2 — Shared GUI accessibility and layout (V4–V8).** Theme-aware code
      (V4), 32/36px targets (V5), accessible names + opaque focus ring (V6),
      resizable 240–480px sidebar with full-title disclosure (V7) and narrow
      execution-context disclosure (V8) are implemented with focused tests, and
      the Monitor window now projects appearance + theme read-only. Remaining:
      migrate raw `text-[Npx]` consumers, composited accent-alpha/disabled state
      checks, and native evidence.
- [x] **P1 — Runtime journal substrate (R1a).** One local SQLite journal
      (`core/runtime_journal.rs`) with rollback journal + `synchronous=FULL` +
      foreign keys owns launch operations, conversation owners, runs and
      append-only events. Idempotent `prepare` (same operation+digest → same
      IDs; changed digest → conflict), cancel tombstone that never revives,
      `user_version` migrations that fail closed on a newer/corrupt file, and
      epoch-checked cancellation. Exposed through five `*_runtime_*` commands
      that are **inert unless `PACKETBENCH_RUNTIME_JOURNAL=1`**; nothing in the
      live agent loop calls them yet. Rust unit tests + a TS client/digest test
      pass. R2c (fake-provider parity) and H2/H4 integration remain.
- [x] **P1 — Runtime runner seam (R2a).** New `core/agent_runtime/` module
      defines the host boundary: an `EventSink` trait, a `RecordingEventSink`
      test/eval double, `RunRequest` and `RunOutcome`.
- [x] **P1 — Same-runner extraction (R2b).** `run_agent_loop` moved to
      `core/agent_runtime/runner.rs::run_turn<R: RuntimeServices>` (generic,
      static dispatch); `TauriRuntimeServices` delegates to the existing
      state/keyring/provider/MCP/Flight/hooks; the three call sites
      (start/send/retry) rewired. Behavior-preserving: `cargo test --lib`
      1136/0 (baseline), `rustfmt` clean, and an independent review found no
      blockers (events, permission/edit ordering + strings, cancel drain,
      usage/hooks, error-return set all unchanged). Decisions recorded in
      `dev/agent-experience/06-r2b-decisions-and-plan.md`. R2c (fake-provider
      parity tests) and R3+ remain.
- [x] **P1 — Fake-provider parity tests (R2c).** `#[cfg(test)]` fakes
      (`ScriptedProvider` implementing the real `LlmProvider` contract +
      `FakeServices`) drive `run_turn` headlessly; 6 tests cover text streaming,
      auto-allowed tool call, denied permission (proves non-execution), cancel,
      `StreamChunk::Error` → `Failed`, and raw transport `Err`. `cargo test --lib`
      1142/0; independent review found no blockers. Gaps (not blockers):
      edit-approval, PreToolUse veto, MCP/plan-mode paths, and history
      `tool_use`↔`tool_result` pairing assertions.
- [x] **P1 — Checkpoint schema and module (R3a).** Journal migrates v1→v2
      additively (fail-closed on a newer/corrupt file); new
      `core/runtime_checkpoint.rs` encodes/decodes typed history (tool_use↔
      tool_result pairing + opaque provider reasoning), validates
      schema/transport/model/policy compatibility, prunes to the latest 10 per
      run, refuses secret-looking payloads (token-aware, not substring), and
      returns named errors for blob/run/total budget violations. `cargo test
--lib` 1156/0; independent review found no blockers (fixed a latent
      redaction false-positive and a byte-vs-char budget bug it found). **R3b
      must**: validate schema on load, guard pruning against active runs /
      `pending_effect_ids`, order retention by `(epoch, seq)`, and wire
      runner/restart with crash-injection tests.
- [x] **P1 — Checkpoint integration and resume (R3b).** The runner persists
      typed checkpoints at five durable boundaries (user turn, pre-request,
      assistant receipt, tool intent, tool receipt) and supports
      `inspect_runtime_resume` / `resume_runtime_run` (CAS epoch+1, no dispatch,
      corrupt/newer preserved, explicit `semantic` fallback), all behind
      `PACKETBENCH_RUNTIME_JOURNAL` (default off). The disabled path is
      byte-identical (independently verified). `cargo test --lib` 1170/0.
      **Must fix before enabling by default:** (1) restart/continue of an
      existing conversation sends `kind:"initial"` with a fresh operation id and
      hard-fails the owner check; (2) checkpoint persistence runs synchronously
      on the async runner task; (3) resume does not enforce policy/MCP hashes.
      **Before R5:** per-turn run identity (follow-ups currently reuse the
      initial binding, not a new linked run).
- [x] **P1 — R3b must-fixes.** Restart/continue now selects `kind` from
      `conversation_has_owner` (so an owned conversation uses `existing` and
      links `previous_run_id`); checkpoint persistence is `async` and runs on
      `spawn_blocking` (no SQLite work on the runner task); resume is fail-closed
      — `check_resumable_typed` returns `PolicyUnverified` without a live
      `CompatibilityContext`, so the command surface offers only `semantic`.
      `cargo test --lib` 1174/0; independent review: safe, no blockers.
      **Still open before enabling by default:** wire a real
      `CompatibilityContext` into the resume path (or delete the now-unreachable
      typed branch) and add a direct `prepare_session_run` kind-selection test.
- [x] **P1 — Capability and manifest modules (R4a).** `core/runtime_capabilities.rs`
      (tri-state supported/unsupported/unknown with provenance; `unknown` is
      never treated as supported; the image guard refuses unsupported, unknown
      and `Supported(false)`) and `core/runtime_manifest.rs` (versioned,
      content-addressed, immutable run manifest with a stable hash). Journal
      v2→v3 adds `manifests` + `capability_snapshots` (additive, fail-closed on
      newer/corrupt; loads refuse newer versions). `cargo test --lib` 1190/0;
      independent review: safe, no blockers.
- [x] **P1 — Capability wiring + readout (R4b).** `get_runtime_capabilities`
      (compute-only; works with the journal off) + a concrete, ts-rs-friendly
      `RuntimeCapabilityView` DTO, generated schema, and `tauri.ts` /
      `agentRuntimeClient.ts` wrappers. One shared
      `runtime_capabilities::require_route_supports_images` helper guards BOTH
      transports (in-process runner before the PreRequest dispatch-intent
      checkpoint and before the attachment drain; sidecar start and follow-up
      before any side-effecting admission/`begin_builder_turn`), refusing
      `unsupported` **and** `unknown` so an image is never silently dropped.
      Gated on `runtime_journal::is_enabled()` (spec §3.1: guards apply "when the
      feature is enabled"), so the journal-off path is byte-identical to
      pre-R4b. `cargo test --lib` 1196/0; gates full-tier green. **Follow-up
      (UX):** when the runtime is enabled, the composer still advertises image
      attachments universally (`agentCapabilities.imageAttachments`), so wire
      that to `get_runtime_capabilities` before enabling the journal by default.
      Named providers (sugar/cline-pass/opencode-go/ollama-cloud/google/xai) and
      `api-openrouter`/`api-minimax`/`api-custom` resolve vision `unknown` →
      refused while enabled; widen the static table only with evidence.
- [x] **P1 — Budget admission substrate (R5a).** Journal v4 (additive, fail-closed)
      adds `requests` + `budget_reservations`; `core/runtime_budget.rs` implements
      single-scope, in-journal request admission: unpriced is a strict reject
      (never zero), a reserve ceils the estimate by 10% headroom, admission sums
      only _active_ reservations inside one `BEGIN IMMEDIATE` transaction, a
      duplicate `request_id` is a conflict, settlement is the exact actual with a
      labelled overage (never a silent reopen), and release frees headroom.
      Negative amounts and malformed ids are refused. Substrate only — nothing in
      the live loop calls it yet. `cargo test --lib` 1214/0; independent review
      findings (negative-amount bypass, check-outside-transaction, unguarded
      UPDATEs) all fixed. **R5b remains:** wire runner per-request admission + the
      two-phase `usage.jsonl` bridge, passing per-turn limits from the frontend.
      Hard precondition: callers must go through `with_journal` (its process-global
      connection mutex is what makes the admission read race-free).
- [x] **P1 — Per-request budget wiring + ledger bridge (R5b).** The native runner
      reserves per model request before the `PreRequest` dispatch intent (and
      before any spend) when the session has a budget, settles on the provider
      `Done` with the exact actual, and releases on provider error/cancellation.
      The scope is a **cumulative** spend cap (already-spent + reserved +
      requested). Estimate is a conservative backend heuristic (serialized
      message bytes / 3 input tokens + `max_tokens` output, priced); an unpriced
      model is refused only when a budget is configured. `UsageEntry` gains an
      additive optional `request_id` so the raw ledger row correlates with the
      journal reservation (settle happens after the append; locks are never
      nested). Frontend passes `local:<conversationId>` + the session limit; no
      budget => no reservation => byte-identical (ledger rows included). 1228/0;
      full gates green; independent review findings (cumulative cap, Done-without-
      actual leak, unwrapped `?`, ledger byte-identity, run-binding fallback,
      settle-error policy) all fixed. **Known limits:** (a) a crash between the
      ledger append and the journal settle (or between admit and append) leaves a
      `reserved` row with no startup reconciliation pass yet — follow-up; (b) only
      the per-session cap is enforced at request granularity (daily/monthly/
      provider/flight stay frontend once-per-turn); (c) flight-launched API
      sessions pass no budget, so R5b does not cover them.
- [x] **P1 — Context projection + overflow blocking (R6).** Journal v5 (additive)
      adds `context_snapshots`; `core/runtime_context.rs` provides a conservative
      estimator (`countKind: "estimate"`, bytes/3 + a per-block framing charge +
      `IMAGE_TOKEN_ESTIMATE` per image, no tokenizer, no strict guaranteed-fit
      mode), a content-addressed `ContextSnapshot` (counts include system text,
      tool schemas, per-message overhead, images and opaque reasoning envelopes),
      `check_fit`, and hash-verified store helpers. The native runner projects
      before `admit_request`/the `PreRequest` intent/any spend and enters
      `blocked_context` (recording the snapshot) on overflow; attachments are
      counted non-destructively (a refusal consumes nothing). Gated on the journal
      so the disabled path is byte-identical. 1244/0; full gates green; independent
      review findings (disabled-path drain order, per-block framing, single
      overflow predicate, hash fields, FK) all fixed. **Deferred:** live-catalog
      context windows (the static table only knows `anthropic`, so OpenAI/named
      rows never block on overflow yet), optional-material omission/retrieval
      (v1 blocks instead of trimming; `omitted` is empty), the
      `get_runtime_context_summary(runId)` read command, and semantic compaction.
- [x] **P1 — Explicit subagent role resolver + child parity (R7).** New
      `core/subagent_role.rs` unifies `spawn_subagent` and custom agents on one
      resolver: an explicit `RouteSource` (`InheritedParent` vs `ExplicitOverride`),
      a validated `model` override (the previously-ignored field now works; blank
      inherits; structurally invalid is rejected before any spend), a structured
      `SubagentResult` (`Completed`/`Incomplete`/`Blocked`/`Failed` — only
      `Completed` is a non-error tool call), and per-role `max_requests`/
      `max_output_tokens`. Child model requests reserve/settle against the parent's
      root budget scope via a `ChildBudgetHook` on `ParentLlm` (inherited by nested
      children), reusing the runner's admission path and gated on journal+budget.
      Read-only/denied-tool floors, recursion depth and single-counted child usage
      are preserved. 1264/0; full gates green; review findings (non-Completed
      outcomes were wrongly `Ok`, blank-override asymmetry, decorative fields,
      duplicated cost derivation) all fixed. **Known gap:** the child loop has no
      cancellation token (a Stop during a child tool round is not honored) —
      pre-existing, follow-up.
- [x] **P2 — Offline same-executor eval lane (R8 v1).** New `runtime-eval` Cargo
      feature + `src-tauri/examples/runtime_eval.rs` driving the SAME `run_turn`
      via the `FakeServices`/`ScriptedProvider` deterministic lane (no second
      loop). `src-tauri/src/runtime_eval/` holds versioned `EvaluationCase v1`/
      `RunResult v1` (all spec fields, actual/provisional/unknown spend split), a
      fixture loader with a load-bearing `harnessConfigDigest`, deterministic
      grading from harness observations (never model text), and an honest
      redaction guard. 12 JSON fixtures cover text/tool/permission/cancel/
      provider-error/budget refusal+settle/context overflow/checkpoint crash/
      journal fail-closed/ledger-append-failure; two JSON Schemas + a consistency
      test. Offline-by-default; `--live` hard-refuses (explicit provider/account/
      spend-policy required). New `scripts/acceptance/runtime-eval.mjs` +
      `acceptance:runtime-eval` + a `runtime:eval` gate. 1275/0; all 7 gates
      green; review findings (missing repo-fixture/starting-commit fields,
      unenforced schemas, shallow fixtures, empty sourceIdentity, placeholder
      digest) all fixed. **Deferred (live lane):** 20–30 held-out tasks × 3 trials
      against a real provider/account under a predeclared spend policy and
      OS/container isolation; the remaining offline checkpoint-layer cases
      (duplicate/out-of-order tool ids, newer-schema quarantine); and the SDK-lane
      limitation declarations.
      **October 25 packaging correction:** the developer CLI is a feature-gated
      Cargo example, invoked with `--example runtime-eval`, so Tauri does not
      try bundling an optional executable absent from the production build.
      The first clean packaging attempt found this blocker before producing
      installers. Four target regressions, actual Cargo metadata, the release
      gate, production `cargo check --bins` and a fresh 12/12 offline example
      run pass. The clean `04cd0e16` retry subsequently produced both installer
      formats, and both delivered copies passed complete noninstalling payload
      checks. Exact source/evidence is in the acceptance inventory; this does
      not claim installed GUI or live-model acceptance.
- [x] **P1 — Journal default-on prerequisites + SDK declaration.** Added a
      single-instance guard (`tauri-plugin-single-instance`, registered first; a
      second launch focuses the existing window) — the ADR-4 prerequisite before
      the journal can be enabled by default. Added startup budget reconciliation
      (`runtime_budget::reconcile_reserved` + `reconcile_budget_on_startup`, gated
      on the journal, non-fatal, runs synchronously pre-event-loop so no request
      can race the ledger snapshot): a `reserved` row present in `usage.jsonl`
      settles at the ledger actual; an orphaned row is released. Child/subagent
      usage rows now carry their reservation `request_id` (R7 hook) so child
      reservations reconcile too. Wrote `dev/agent-experience/07-sdk-limitations.md`
      declaring native guarantees vs the weaker SDK/soft-turn claims and the v12
      protocol floor. 1285/0; review findings (child fail-open release, sync-call
      justification, test strength) all fixed. **Still open:** native
      visual/IME/restart evidence needs the user/tooling.
- [x] **P2 — Composer capability wiring.** Added `get_runtime_guard_status()` +
      `src/stores/runtimeGuardStore.ts`; when the guard is enabled AND the route's
      vision is not explicitly `supported`, the composer disables the image-attach
      control (button, paste, drop, drag-enter) with a tooltip, and the send path
      blocks a staged image that meets a now-unsupported route. Guard-off behavior
      is unchanged (no capability probe). `capabilitiesFor` stays pure via an
      optional override. Covers both the chat and launch variants. 1287/0; all 7
      gates green; review findings (ungated send path + launch variant, accessible
      tooltip, drop test, PTY probe noise) all fixed.
- [x] **P2 — Context live-catalog windows.** The frontend-supplied directional
      window (`getModelContextWindow`) is now carried on the session
      (`RuntimeSession.context_window_tokens`) and used by R6's overflow guard,
      falling back to the backend static table when absent; non-positive values
      are dropped, and the sidecar path deliberately does not consume it (the SDK
      owns hidden context). This closes the "OpenAI/named rows never block on
      overflow" gap. 1287/0; all 7 gates green. Review caught a frontend
      positional-arg misbinding that would have broken every default (no-budget)
      API conversation start — fixed with a real-invoke wire-contract test. Note:
      the window is a curated/heuristic estimate (200_000 default for unknown
      ids), so a false PASS is possible for an unknown id whose true window is
      smaller; the guard only runs when the journal is enabled.
- [ ] **P1 — Typed agent continuation (H2).** Preserve versioned tool/results,
      opaque replay state and frozen authority; label incompatible/lossy fallback
      and prevent completed-tool re-execution. Existing September transcript
      recovery proof remains valid for its narrower scope.
- [ ] **P1 — Request-level spend admission (H4).** Reserve/reconcile concurrent
      parent/child requests and later loop iterations; preserve unknown pricing
      and accurately describe SDK enforcement limits. This expands the existing
      per-run cap item below rather than creating a second budget program.
- [ ] **P2 — Measured production harness (H1/H3/H5–H7).** Add an injectable
      production executor/evaluation seam, versioned run/context/capability
      manifests and explicit subagent routes. Evaluate held-out task outcomes,
      latency, cost and interventions before adding retrieval/graph complexity.
      No Composer/model program is included. Extend the existing real-run
      harness and reasoning-effort items below.
- [ ] **P2 — Evidence-backed usage disclosure (H9).** Preserve existing PTY
      Codex percentage signals; distinguish unknown/stale from zero and support
      provenance/reset/window fields only when supplied. API tokens/USD and a
      retry delay are not subscription allowance. Extend guardrails, not the
      removed Cost Dashboard.
- [ ] **P2 — Optional rendered-app verification (H8), after reliability.**
      Evaluate supported browser/MCP integration with scoped local-app authority
      and evidence artifacts. Preserve web_fetch SSRF protection. Any future
      desktop-control integration must release control through waits/builds.
      October 25 refinement: after desktop acceptance and the existing Remote
      Agents program, investigate a docked development-app preview first, then
      opt-in element selection that stages a reviewable screenshot/annotation,
      URL, selector, bounded DOM/styles and available component context in the
      intended agent draft. Keep page content outside Tauri/host privileges and
      treat extracted content as untrusted; strip credentials/private fields,
      preserve origin/provenance and fail visibly on unsupported pages. Require
      navigation/lifecycle, isolation and exact-destination evidence before any
      completion claim. This is the existing H8 scope, not a second browser task
      or a resumption of paused general Computer Use.
      Cursor/Claude refinement: after the isolated preview and annotation path
      is proven, evaluate opt-in CSS change previews and bounded screenshots/
      DOM/error checks against explicit local-app criteria. Record actual
      viewport, source revision, actions, results and missing coverage; keep
      manual annotations, agent verification and independent test evidence
      distinct. No inferred pass from a screenshot, blanket auto-verify default
      or general desktop-control permission. GUI1 renders returned artifacts;
      existing evidence owners retain capture/provenance responsibilities.
- [ ] **P2 — Official ChatGPT-plan feasibility review.** Evaluate the documented
      OSS/local SIWC consent/host/refresh/entitlement contract and Codex app-server
      versus direct Responses route, including preview limitations. No login,
      adapter resurrection or provider change is performed by the research.
      Keep retired provider IDs retired; use a new explicit identity if approved.

Composer/model-development research now belongs to the separate
[packetbench-model-lab project](https://github.com/packetloss404/packetbench-model-lab/blob/main/docs/PLAN.md),
at `D:/projects/packetbench-model-lab`. Its active plan and progress live there. The packets
above improve the existing runtime and do not create a separate model or
competitor harness product.

## Provider acceptance — October 15

Live evidence and installation scope are in [the current handoff](HANDOFF.md#sugar-default-activation--october-15-2026).
The October 19 Flight rebuild of 0.14.9 supersedes the earlier Sugar-default
installation; exact installed identity is in the current handoff. Sugar passed six-model
discovery, streaming, follow-up memory and a synthetic local-file tool/result
exchange through the actual native adapter. Ollama `qwen3.5:4b` passed its
earlier provider checks; the packaged helper passed two protocol-12 echo turns.
Full native Workspace acceptance remains open.

- [x] Connect Sugar, test the real native adapter and make Sugar/Conduit the
      default for new API chats, Flight targets and workflow roles. Preserve
      existing conversation/provider pins. Installed executable hash verified.
- [x] Select a working auxiliary route: all fifteen task classes are
      explicitly pinned to Sugar/Conduit for this user.
- [x] Migrate `issue-investigate` and Insights `agent-chat` onto the selected
      auxiliary provider with bounded read-only file tools. Both are pinned to
      Sugar/Conduit locally and passed live Sugar acceptance. Insights chat is
      reachable from Settings; the installed UI and saved routes were verified.
- [x] Verify the installed GUI selects Sugar/Conduit by default, runs an actual
      `read_file` call and correctly answers a follow-up memory question.
- [ ] Complete the broader native Workspace acceptance matrix. This focused
      Sugar conversation does not establish every Workspace workflow.
- [ ] Resolve direct MiniMax account/plan access if that provider is needed.
      Both M2 and M3 returned HTTP 402, insufficient balance (1008), on October 15.
      Sugar now supplies the selected API/background routes, so MiniMax is no
      longer the default path. The older HTTP 429 observation is historical.
- [ ] Configure real account keys and run a short tool call plus follow-up turn
      through ClinePass, OpenCode Go (each protocol family), Ollama Cloud, Google
      and xAI. Source support and fixture coverage are described in
      [the integration report](dev/provider-integrations-2026-10-06.md).
- [ ] Refresh authenticated Anthropic/OpenAI/Google/xAI catalogs in the native
      app and verify the chosen account's model access. Public plan inventory does
      not prove subscription entitlement. Paid Claude testing remains deferred.

## Loop and graph engineering review — October 19

Follow-ups from the [source alignment review](dev/loop-and-graph-engineering-alignment-2026-10-19.md)
at `4698ca9c`. The owner authorized the three scoped runtime repairs below;
implementation and quality gates are recorded in the [follow-up review](dev/flight-overhaul-review-2026-10-19.md).
Broader evidence/graph changes remain unscheduled and do not supersede
Workspace stabilization or authorize broader autonomy.

- [x] **P2 — Review evidence freshness (source).** Bind review to committed
      HEAD, pinned base and frozen criteria/task context; reject stale/unbound
      passes at verdict, acceptance, integration and delivery. Deliver the exact
      reviewed commit; preserve a retained branch/worktree that advances during
      landing. Dirty/untracked work must be committed before review. Packaged
      local/SSH journey proof remains in the existing acceptance item.
- [x] **P2 — Reviewer accounting and bounded errors (source).** Register
      reviewer owner/provider/model before startup and retain ownership through
      retries/resets for delayed usage. Persist per-attempt reviewer retry counts
      independently of truncated history; save allowance before launch, back off,
      and stop for attention at the existing round cap. Recheck policy and runtime
      authorization during automatic retry startup.
- [ ] **P2 — Independent execution and integration evidence.** Reuse the
      proposed Packet Control contract for independently captured local/SSH check
      evidence and a combined integration-tree check pinned through final
      cooperative landing. A fresh read-only model
      review does not independently execute builder-reported checks.
- [ ] **P2 — Feedback runtime behavior proof.** Cover repair/review/pass,
      repeated reviewer errors, stale evidence and missing graph inputs. Carry
      native proof into the existing P1 RG8/CG9/CI9/AP9 acceptance item below;
      do not create a duplicate packaged-proof program.
- [ ] **P3 — Reusable Flight recipe contracts, after proof.** Evaluate
      versioned inputs, output artifact references and joins keyed by expected
      task identity on the existing cooperative DAG. Require measured benefit
      before adding a general graph editor or recurring discovery scheduler.

## Flight overhaul review — October 19

The owner requested a separate runtime, GUI and end-to-end UX review because
Flights are unused. The [combined source review](dev/flight-overhaul-review-2026-10-19.md)
contains the current journey, proposed flow and acceptance criteria. These
findings led to an explicitly authorized implementation in priority order.
The source overhaul is implemented; the dated review records local validation
and the remaining native/provider and adoption evidence boundary.

- [x] **P1 — Preserve interrupted work (source).** Retain dirty/untracked attempt
      worktrees after a crash; provide Inspect/Resume/Discard instead of automatic
      forced removal during startup recovery.
- [x] **P1 — Complete Stop semantics (source).** Cancel reviewer and remediation
      sessions as well as running builders. Prevent new role sessions after Stop;
      distinguish admission caps from in-flight watchdog/cancellation behavior.
- [x] **P1 — Stable task identity and truthful completion (source).** Preserve task IDs
      and task-scoped prompts during cooperative recovery. Protect plan replacement
      once execution begins, and derive completion from the graph/delivery state
      instead of the first set of completed attempts. Prevent premature success
      memory capture.
- [x] **P1 — Repair Flight launch controls (source).** Restore New attempt after the
      first run; use shared authenticated live provider/model selection for
      builders and cooperative tasks; make the local/SSH repository path editable
      and validate it before launch.
- [x] **P2 — One-agent delivery flow (source).** Contextual Workspace/issue/chat entry
      creates or reuses a Flight, then brief → run → attention → unified diff,
      checks and reviewer evidence → Land/Open PR → archive. Put blockers/results
      first; move unused integrations and expert orchestration settings out of the
      default path. Keep API billing distinct from PTY subscription sessions.
- [x] **P2 — Cooperative and constrained-layout usability (source).** Permit dependent
      tasks to reuse owned files while protecting parallel writers; combine task
      and milestone summaries, improve narrow-pane/keyboard/label semantics, and
      retain explicit final combined review and landing.
- [ ] **P1 — Flight native acceptance and adoption evidence.** Exercise the
      complete builder → review → repair → fresh review → delivery → archive flow
      in the native app, including pinned SSH, restart with dirty/untracked work,
      Stop during each role, and a second Flight. Record launch-to-delivery time,
      interventions, actual cost, abandonment reasons and second-Flight choice.
      Use the existing packaged/provider acceptance runbook; mocked browser tests
      and hermetic Git fixtures do not replace this proof. Independent execution
      of builder checks and combined integration checks remains a separate later
      evidence adapter; current UI labels these limits explicitly.

      October 19 native follow-up: disposable local and pinned Docker SSH
      Flights completed Stop/restart/Resume, changes-requested review, repair,
      fresh passed review, Land and archive/restore/rearchive. Independent file,
      Git, immutable-commit tests, review identity and usage checks passed on
      both hosts. The first SSH Stop exposed a surviving grandchild; its failed
      proof remains alongside the corrected actual-runtime tests and passing
      native rerun. A provider HTTP 522 also exposed failed-worktree cleanup;
      source fixes retain failed/cancelled work and preserve recovery state on
      rejected cleanup. This scoped proof does not close the broader
      role/provider, billing or adoption matrix. See the dated Flight review
      for exact build and evidence boundaries.

      Installed-app closeout also passed: all 8,683 payload hashes, two bundled
      sidecar turns, archived-delivery UI, durable local/SSH review/usage state
      and all nine project-history entries. Test Flights are archived, the
      disposable SSH server is stopped, and the app is back on the workstation
      repository. The owner can now dogfood real work; this does not close the
      broader acceptance/adoption item.

Provider status reconciled: 2026-10-15; loop/graph and Flight reviews: 2026-10-19;
remaining backlog baseline: 2026-10-06 (dogfooding incomplete)

This is the single task register for work that has not shipped or has not yet
earned its required real/package proof. Completed implementation history belongs
in [`CHANGELOG.md`](./CHANGELOG.md); dated audits and superseded designs are
evidence, not additional backlogs.

Priority: **P1** = release blocker, real bug, or major user-facing gap;
**P2** = bounded correctness/UX work; **P3** = later enhancement or cleanup.

## Owner decisions

Owner decisions below preserve their dated record. Hosting/topology references
are not a current deployment-health claim; the October 24 audit found later
local operator records that differ from the historical Railway design. Keep
auth/confidentiality requirements while verifying actual infrastructure.

**Historical direction, 2026-09-24:** no feature expansion. Stabilize and finish
the existing product paths identified below before resuming expansion plans.
That checkpoint prepared the October 19 local 0.14.9 Flight rebuild and its
scoped payload/UI/state checks. The current executable/source relationship is
recorded in the October 24 audit; do not treat the older hash as current.
Broader Workspace dogfooding remains incomplete.
On October 6 the owner confirmed they have not dogfooded enough yet. Resume
with reported defects, prioritizing Workspaces; no feature expansion or
deployment is requested by the pre-tag review.

The later October 24 owner decision puts desktop/runtime completion and
acceptance before Remote Agents, superseding the earlier Remote-Agents-first
order. The current completion plan scopes the work; this does not reactivate
every historical or optional item above/below.
Resolved choices below remain dated owner decisions; unresolved implementation
and evidence work belongs in the current ledger sections, not this old pre-tag
instruction.

1. **RESOLVED 2026-08-28 - Remote Agents authentication.** **Build it
   ourselves:** passkey/magic-link auth in the Rust relay backed by
   PostgreSQL, chosen from the four-option menu (hosted SaaS IdP /
   self-hosted IdP / in-house / dev-only). The owner explicitly accepted the
   ownership burden. This was the last blocking owner decision on the
   program — Sprint 0 is unblocked.

   **The owned surface this creates**, which is now real work rather than a
   vendor's problem: WebAuthn registration and assertion ceremonies with
   attestation handling and credential storage; session issuance, lifetime,
   refresh, and revocation across desktop and PWA; magic-link delivery,
   expiry, and single-use guarantees; account recovery and the device-loss
   path; rate limiting and enumeration resistance; and **a security review
   before external beta**, which gates the beta alongside the E2EE
   requirement in decision 2. Size Sprint 0 accordingly.

   In-house auth does not soften the E2EE gate: TLS terminates at Railway's
   edge, so owning the auth code is not the same as content being unreadable
   in the deployment. Hosted SaaS and self-hosted OSS IdP stay as fallbacks
   if this lands more expensive than expected — most likely at recovery or at
   the security review — and the vendor field should be re-surveyed rather
   than reusing the 2026-06 comparison. Full record in
   [`dev/remoteagents/09-open-decisions.md`](./dev/remoteagents/09-open-decisions.md).

2. **RESOLVED 2026-08-16 - Remote Agents payload encryption timing.** The
   recommendation was ratified: plaintext (TLS-only) is acceptable only for
   local/internal development; encrypted agent, approval, and file payloads
   are a hard gate before any external beta. See
   [`dev/remoteagents/09-open-decisions.md`](./dev/remoteagents/09-open-decisions.md).
3. **RESOLVED 2026-08-16 - Global Undo.** Shape chosen: a **time-boxed undo
   toast** that delays destructive commits for a short window; durable
   soft-delete/restore was declined. Confirmations remain the safety net until
   the toast is implemented (post-1.0-scope work; not yet scheduled).
4. **DEFERRED ON COST 2026-08-27 - Code-signing identity.** Not neglect and
   not blocked: an explicit owner decision to spend nothing on signing for now.

   **Trigger to revisit:** the first time a build goes to anyone who is not the
   owner. Until then unsigned local builds are fine (SmartScreen's
   _More info -> Run anyway_ is one click per build).

   **Cheapest path when triggered** (the day-0 "apply for everything
   immediately" advice in the Fable 5 review was scoped to a 2-week v1.0.0
   deadline that was rejected on 2026-08-16, so its urgency no longer applies):
   - **Azure Trusted Signing, ~$10/month, billed monthly** - no annual
     commitment, 1-7 business-day validation, no hardware token. This alone
     unblocks Windows.
   - **Skip the OV certificate** unless Azure validation stalls; it is a
     few hundred a year and is only a hedge.
   - **Defer Apple's $99/year** until macOS is actually in scope. macOS is a
     v1.1 target ([`dev/macos-release-plan.md`](./dev/macos-release-plan.md)),
     and enrollment is its long pole - start it when v1.1 starts, not before.

   **Groundwork already done (2026-08-27), so the credential drops straight in:**
   `.gitignore` now covers `*.key`/`*.pem`/`*.p12`/`*.pfx`/`*.cer`/`*.crt`/
   `AuthKey_*.p8`/`.tauri/` ahead of any key existing, and
   `scripts/release-gate.mjs` already reads the credential env vars
   (`WINDOWS_SIGNTOOL_CERT_SHA1`, `WINDOWS_SIGNING_CERT_PATH`,
   `TAURI_SIGNING_PRIVATE_KEY`, `APPLE_SIGNING_IDENTITY`, ...).

   **Deliberately NOT done:** the Tauri updater keypair was not generated. The
   updater plugin is not installed and no `updater` block exists in
   `tauri.conf.json`, so nothing would consume the key today - and an
   un-backed-up updater private key is a liability, not an asset: lose it and
   every install signed with it can never be updated again. Generate it as the
   first step of wiring the updater, not before, and back it up twice
   immediately (`dev/updater-setup.md`).

   **What stays blocked meanwhile:** distribution trust and hosted gates
   (strict-mode `release:readiness` fails without credentials), the updater,
   SmartScreen reputation (which only starts accruing after the first signed
   release), the macOS v1.1 DMG, and the PacketCode signed release channel.

   Original v1.0.0 context, retained: the 2026-08-05 Fable 5 review recommended
   a Windows-only, signed, installer-proven v1.0.0 with the updater client
   shipped but the first served update deferred to 1.1, and an explicit "1.0 is
   NOT" list (macOS/Linux, Remote Agents, Global Undo, hosted CI, the
   environment-gated proof matrices). The owner **rejected** that definition on
   2026-08-16; PacketBench continues the 0.x cadence with no 1.0
   milestone. See
   [`docs/reports/fable5-review-2026-08-05.md`](https://docs.ianlan.dev/reports/fable5-review-2026-08-05.md).

5. **RECONCILED 2026-09-24 - Former PacketCode ACP leftovers.** ACP was
   removed on September 1. Keep `src/agents/packetcode.ts`: it serves the
   supported PTY CLI. Retiring it in favour of the removed transport is no
   longer an action item. The September 24 follow-up removes the hidden
   cost-statusline opt-in and unused aggregate cost display calculations;
   token displays and budget accounting remain. Disposition of the separate
   packetcode-gui repository remains unverified and is not evidence that ACP
   is a current capability.

6. **RESOLVED 2026-08-27 - PacketRelay ownership and deployment.**
   PacketRelay (`D:\projects\packetrelay`) **belongs to PacketBench**. It is
   not Syndicate's and it is not shared: the Syndicate separation on
   2026-08-27 left the relay on this side of the split. Its deployment target
   is **Railway**, replacing the Cloud Run target it carried under Syndicate.

   **Consequence, stated plainly:** Remote Agents now bears **100%** of the
   relay's build and run cost. That cost was previously shared with Syndicate,
   so this is a real reweighting of the program's economics — and it has **not
   been scored**. Nobody has costed a Railway-hosted relay against the
   single-tenant volume Remote Agents alone will generate. Price it before the
   program commits to a hosting shape, and note that it now compounds with
   decision 1: an IdP choice with a hosting bill of its own lands on the same
   budget.

Remote Agents relay architecture and code location are already decided: extend
the standalone Rust service at `D:\projects\packetrelay`; keep shared schemas
and the initial PWA under PacketBench's `remoteagents/` workspace. See
[`dev/remoteagents/09-open-decisions.md`](./dev/remoteagents/09-open-decisions.md).

## Existing-code completeness sweep — 2026-09-24

**Source fixes and follow-up implemented; all eleven local gate categories
passed, including the frozen frontend/browser rerun. Windows 0.14.8 is built,
installed and launched; owner dogfood feedback remains pending.** The three-team audit of
`5035f98d` remains the before-fix record:
[code-completeness-audit-2026-09-24.md](./docs/reports/code-completeness-audit-2026-09-24.md).
The per-ID implementation and validation record is
[existing-code-stabilization-2026-09-24.md](./dev/existing-code-stabilization-2026-09-24.md).

- **F01–F06:** Workspace approval ownership, worktree PR identity, stale Git
  refresh rejection, Monitor status, unsupported custom CLI creation and
  unreachable Quality diagnostics addressed. F05/F06 use removal and honest
  scope instead of adding features.
- **B01–B08:** Parent/child tool authority, child usage, session task isolation,
  custom-agent discovery, incomplete outcomes and per-chain depth addressed.
  The follow-up adds native local project/network MCP with session-owned
  configuration; native SSH explicitly refuses desktop MCP substitution.
- **S01–S08:** Session/turn budget admission, reviewer recovery/durability,
  restored settings, failed prompt delivery, backend cleanup and notification
  preferences addressed. Integration review also fixed Stop during admission
  and usage-write/completion ordering.
- **C01/C02:** Confirmed unused code removed and current claims reconciled.
  Compatibility aliases and disabled Remote Agents foundations retained.
- **Installation complete:** NSIS upgrade from 0.14.6 exited 0, all 8,683
  installed files matched, bundled protocol-v12 sidecar passed two echo turns,
  and normal launch opened a responding 0.14.8 window. MSI installation was
  not tested.
- **Still required:** owner dogfooding of the changed paths and follow-up fixes
  from concrete reports; broader native/provider/hardware acceptance remains.
  Paid Claude testing remains deferred for subscription cost.
- **Accounting recovery:** failed/uncertain writes retain per-entry journals and
  block further API requests until reconciled. First-observation threshold
  alerts now notify under the existing preferences. Guardrails still cannot
  cap an in-flight request's cost. Recovery procedure and physical storage
  limits are in the implementation record.

## Remote Agents implementation

**After desktop/runtime completion and acceptance, per the later October 24
owner decision.** Keep production fail-closed while waiting and extend existing
PacketRelay when implementation resumes. Sprint 0 acceptance below is historical.
Committed relay identity/ACL/audit/PostgreSQL repository substrate exists, but
auth sessions/tickets/replay/outbox, working routes and PWA sockets are not a
completed Sprint 1. The desktop's eleven readiness gates remain unmet. Later
local PacketRelay operator notes describe datacenter deployment and deletion
of former Railway/PostgreSQL resources; those notes are partly uncommitted and
live infrastructure was not verified. Confirm actual topology/datastore before
rollout; preserve prior owner decisions as dated history. See the current note
in [the Remote Agents index](dev/remoteagents/README.md).

October 25 approval refinement belongs to this existing program, after its
transport/auth prerequisites: make phone decision authority explicitly opt-in,
show its expiry and originating device, support immediate revocation, and bind
each decision to the exact pending request/host/run. Reject expired, revoked,
stale or replayed decisions without a second execution, including reconnect and
desktop/phone races. Choose/document the permission lifetime in the existing
security contract rather than inheriting BridgeMind's 24-hour setting. Preserve
account/PWA-first sign-in, API-agent-only v1 and the E2EE/external-beta gates;
this creates no separate mobile feature, QR-first flow or raw PTY control task.

- **CLOSED 2026-09-01 - Sprint 0 foundations.** Shared protocol/PWA/workspace
  foundations, feature-gated PacketRelay skeleton, fail-off desktop flag,
  ownership map, managed PostgreSQL, and the feature-off production deployment
  are verified. Both services run in `us-west2`; live health and legacy WSS
  smoke pass; the final IaC plan is clean.
- **P1 - Sprint 1 relay and host presence. INCOMPLETE.** Reuse the committed
  identity/ACL/persistence substrate without treating it as finished auth or
  presence. First close the
  replay/ACK recovery, ticket reserve/finalize, and endpoint-to-endpoint
  hello/E2EE security gates in
  the transport decision record. Then implement the approved dev-auth ticket
  path, PostgreSQL trust state, host/device sockets, presence, heartbeat,
  revocation, and reconnect behavior in
  [`dev/remoteagents/06-implementation-plan.md`](./dev/remoteagents/06-implementation-plan.md).
  Keep Remote Agents disabled/fail-closed until that slice earns its gates.
  Product passkey/magic-link auth is also not started. Before external beta,
  enable PostgreSQL PITR, schedule volume backups, and pass an offsite logical
  dump restore drill.
- **P1 - Honour the relay's close codes in every client. NOT STARTED.** The
  relay has closed with intent-carrying codes since 2026-09-04 (`4000` replaced,
  `4001` heartbeat timeout, `4002` slow consumer, plus `1001` shutdown and
  `1008` budget), and the contract is now specified in
  [`dev/remoteagents/03-protocol.md`](./dev/remoteagents/03-protocol.md). No
  client implements it yet. **`4000` is the one that bites:** it means another
  connection has taken this slot, so a client that reconnects on it evicts its
  own replacement, which reconnects and evicts it back — the two flap
  indefinitely and the session never settles. `1008` is likewise not a
  reconnect signal. The Remote Agents PWA has no socket code yet, so the fix is
  free if it is built this way from the start; the inherited Jarvis-lineage
  clients (desktop pair, desktop presence, desktop chat JS, mobile chat JS)
  live outside this repository and each need the same change. Done when every
  client treats `4000` and `1008` as terminal, reconnects with backoff on
  everything else including unknown codes, and a reconnect-storm test proves a
  replaced connection does not fight its replacement.

## Release and real-environment proof

The source behind these slices is implemented. Keep them open until the named
environment or packaged matrix has actually run.

- **ACCEPTED 2026-08-29 - localStorage does not migrate across a packaged
  upgrade.** Owner decision: **accept the loss and state it in the release
  notes.** Not a defect to fix; a documented consequence of the rename.

  `migrateLegacyStorage()` (`src/lib/storage-migration.ts:14`) reads
  `localStorage` from inside its own WebView2 profile, and WebView2 keys that
  profile by bundle identifier. The rename moved the identifier from
  `com.packetade.desktop` to `com.packetbench.desktop`, so a packaged upgrade
  gets a **new, empty profile**: the migrator finds zero `packetade:*` keys,
  writes its guard key, and reports success by silence. Measured 2026-08-28 on
  the development machine: 159 KiB of localStorage under the old identifier
  against 19 KiB under the new one, with twelve stranded keys including
  `packetade:agent-drafts` (unsent composer drafts), `packetade:project-history`,
  `packetade:issues`, and `packetade:workspaces-cache`. The migrator's own logic
  is sound — guard key, copy-not-clobber, legacy kept as rollback — it simply
  cannot see what it is meant to migrate.

  Rejected: a Rust LevelDB reader for the old profile. It is a real feature with
  its own failure modes — parsing another application's store, which that
  application may still hold open — for data that is mostly UI preference. The
  one genuinely costly item is unsent composer drafts.

  **Nothing is deleted.** The old profile stays on disk at
  `%LOCALAPPDATA%\com.packetade.desktop\EBWebView\`, so a determined user can
  recover from it by hand, and a future importer could still be written.

  Follow-up that is NOT this item: the migrator currently writes its guard key
  and reports success on a profile it could never have read. That silence is
  what made this hard to find. Consider having it record that it found nothing,
  so the next person sees a fact rather than an absence.
  **DONE 2026-09-04.** `migrateLegacyStorage()` now returns what it saw and
  writes it to `packetbench:storage-migration-record` — `legacyKeysFound: 0` is
  stated rather than implied, and the zero case logs why an empty origin is
  expected on a packaged upgrade. `bootPersistedStorage()` keeps the whole boot
  outcome (`getStorageBootRecord()`), and **Settings → Security & Diagnostics →
  Storage durability** renders it: mirror active/inactive with the reason, keys
  restored this launch, and the migration count. The record lives under the
  mirrored prefix, so the fact survives the next origin change. "Found zero"
  and "migrated before this was recorded" are deliberately distinct states — an
  install that upgraded before the record existed reports _unknown_ rather than
  claiming zero.

  Worth noting the shape: `bootPersistedStorage()` already returned a typed
  result and `main.tsx` dropped it, so nothing could read it — the same
  typed-contract-with-no-consumer pattern as the PTY exit payload above.

  **RECURRENCE PREVENTED 2026-09-04 — the accepted loss above still stands.**
  `src/lib/storageMirror.ts` now mirrors every `packetbench:*` write to
  `~/.packetbench/` (Rust side: `commands/webview_storage_mirror.rs`), and
  `src/lib/storage-boot.ts` restores from it before any store hydrates. Because
  that directory is in the user's home rather than inside the WebView2 profile,
  the NEXT identifier change — or any other origin change — no longer empties
  the app.

  This does **not** reopen or undo the decision above. Nothing reads the old
  `com.packetade.desktop` profile, so the twelve stranded packetade-era keys
  remain exactly as stranded as they were; the rejected LevelDB reader stayed
  rejected. The mirror only protects data written from this version onward.
  Two further limits worth knowing: values over 512 KiB per key are dropped
  (regenerable caches such as `packetbench:workspaces-cache`), and only the
  `packetbench:` prefix is mirrored, so a future unprefixed key would be
  missed.

- **DONE 2026-08-28 - Memory capture for remote workspaces.** Records are
  stamped through a single write choke point, with the scope resolved from the
  workspace the work ran in rather than the active one. Scope keys render as
  `build-box · app` in the timeline chips, pattern badges, and Markdown export.
  Isolation got stricter: under `projectPathMatching: "global"` a synthetic key
  previously matched everything, so a local brief would have pulled in every
  remote workspace's memory. Migration is opt-in and reversible — a plain
  `/srv/app` is indistinguishable from a local project at that path, so nothing
  is rewritten automatically. **Not done:** remote `.agents/memory` notes, which
  need an SSH note transport, and `InvestigationPanel` still stamps a plain path
  because GitHub always works against a checked-out local repo.
- **P2 - Packaged acceptance sections 3-5 at 0.13.2.** Sections 0 (build),
  1 (migration) and **2 (launch, lifecycle and shell)** of
  [`dev/acceptance.md`](./dev/acceptance.md) have run against the installed
  0.13.2 package. Section 1 found two defects, one fixed and one filed above;
  section 2 left two partial rows, one blocked row, and one confirmed-still-
  broken finding (filed below). That historical matrix remains incomplete.
  September 8 native follow-up exercised Analytics/History empty states,
  verified Tiny download, a zero-frame headset probe and two-display Monitor
  lifecycle; see `dev/gui-provider-evidence-2026-09-08.md` for per-build scope.
  Full speech/recovery and remaining Monitor cases still need runtime proof.
  The dictation section is the highest-yield: those fixes were
  written for Bluetooth failure paths that only a real headset can provoke.

- **DONE 0.13.2 - the three section-2 findings.** A crashing CLI reading as a
  clean exit (every `pty:exit` listener discarded the payload), a workspace with
  a missing project folder clicking through to nothing, and the selected
  workspace not surviving a restart. All fixed in `a5b5507c`; the restart one is
  verified in the installed package, the other two by tests and code path. See
  `dev/acceptance.md` section 2 and the 0.13.2 CHANGELOG entry.

- **P2 - The PTY pane and ACP resolve DIFFERENT packetcode binaries.** Measured
  2026-08-30 on installed 0.13.2: the Workspace PTY pane launched
  `C:\Users\ianwalmsley\Desktop\PacketBench-0.11.0-portable\packetcode.exe`
  (`v0.5.1-70-g5c0adf8`) while ACP resolved via `PATH` to
  `C:\Users\ianwalmsley\bin\packetcode.exe` (`v0.5.1-96-gf52d7c5`) - twenty-six
  commits of skew, silently, across the two surfaces of the same product. There
  is no pin file at `~/.packetbench/packetcode-bin`, so the PTY side is almost
  certainly honouring the CLI Clients "PacketCode integration" override
  (`cliOverrideStore`), which by design feeds PTY launches only. Unifying the
  two resolvers was already an open item; this is the first measured instance of
  it biting, and the skew is invisible in the UI - each surface reports its own
  version and neither mentions the other.
- **P1 - Distribution trust and hosted gates.** Add hosted CI; acquire Windows
  Authenticode and Apple Developer ID credentials; wire Tauri updater
  signing/configuration and hosted `latest.json`. Current Windows artifacts are
  unsigned. The credential half is **gated on Owner decision 4** (deferred on
  cost 2026-08-27) — the "in parallel on day 0" urgency this item used to carry
  came from the rejected 2-week v1.0.0 deadline and no longer applies; the
  cheapest path and the trigger to revisit are recorded there. See
  [`dev/beta-distribution-trust-runbook.md`](./dev/beta-distribution-trust-runbook.md)
  and [`dev/updater-setup.md`](./dev/updater-setup.md). macOS signing,
  notarization, and entitlements are owned end to end by
  [`dev/macos-release-plan.md`](./dev/macos-release-plan.md).
- **P1 - macOS v1.1 release.** Enroll in the Apple Developer Program
  (Individual); create the Developer ID Application certificate and an App Store
  Connect API key and back the private key up twice. Run the unsigned macOS
  acceptance matrix during the 1.0 fix buffer, then fix the blockers: no
  entitlements file, `bundle.macOS` carries only `minimumSystemVersion`,
  `dictation/delivery.rs:40-48` hard-fails off Windows, CMake missing from the
  documented macOS prerequisites, and `build.rs:16-21` treats a missing bundled
  Node as a warning. Ship a signed + notarized + stapled arm64 DMG.
  See [`dev/macos-release-plan.md`](./dev/macos-release-plan.md).
- **P2 - macOS terminal shell defaults.** Auto resolves to bash on macOS
  (`src/agents/terminal.ts:4,9`; `TerminalShellSettingsCard.tsx:163`), where
  `/bin/bash` is the 2007 GPLv2 freeze and zsh has been the login shell since
  Catalina; posix profiles pass no login-shell args
  (`src/lib/terminalShells.ts:219-222`, unlike git-bash at `:206-211`), so
  `~/.zshrc`-defined aliases and env are missing. Nothing reads `$SHELL`.
  fish/nu/xonsh are never probed on posix despite the backend allowlist and the
  UI copy promising them.
- **P1 - Packaged application acceptance.** Run the launch, lifecycle,
  accessibility, denial, credential, and real-host matrices. Build success is
  not interactive acceptance. The ordered checklist is
  [`dev/acceptance.md`](./dev/acceptance.md), which supersedes the
  prose scattered through
  [`dev/release-v0.10.3.md`](./dev/release-v0.10.3.md); the standard of evidence
  is [`dev/proof-audit-2026-08-01.md`](./dev/proof-audit-2026-08-01.md).
- **P1 - Flight supervision.** Run packaged local and disposable pinned-SSH
  matrices for Reviewer Gate, cooperative integration, Coordination Inbox, and
  bounded YOLO (RG8/CG9/CI9/AP9).
- **P1 - PacketAgent W9 interoperability.** **Source complete both halves
  (2026-08-26):** the PacketBench consumer (PH2–PH9 — contract probe, multi-
  source package builders, Rust-side SSE stream with reconnect/dedupe/ack and
  polling fallback, approval round-trip, typed evidence + provenance-stamped
  landing, attention-queue integration) and the PacketAgent server surface
  (contract route, attention list/respond ops, credential-mint CLI) are merged
  and gated. **PH10 live e2e remains** — the only part needing a running
  instance: mint a packet-product credential with the new
  `packet-product-credential issue` CLI, point PacketBench Settings at
  `http://127.0.0.1:8484`, then run the deploy → close/relaunch/reconnect →
  approve → evidence runbook in
  [`dev/bridgemind/packetagent-handoff-loop.md`](./dev/bridgemind/packetagent-handoff-loop.md).
  PacketAgent remains the durable-execution owner.
- **DONE 2026-08-26 - Re-pin `PACKET_AGENT_CONTRACT_COMMIT`.** The PacketAgent
  server half (contract route, attention operations, mint CLI) merged to
  PacketAgent main as `cf910c1`; the pin in `src/types/packet-agent.ts` now
  references it and the digest fixture passes unchanged.
- **P1 - PacketCode release proof.** Publish signed stable/preview artifacts;
  run clean-machine install/update/rollback, packaged PacketBench launch, and
  PacketAgent W9 compatibility smoke. Source detection and `doctor --json`
  already pass.
- **DONE 2026-08-27 - Bump the version before the next release build.**
  `package.json` and `src-tauri/tauri.conf.json` both read `0.11.0`, so the
  next build can no longer collide with a shipped version string. The
  distribution caveat survives as a fact, not a task: the 2026-08-15
  development build produced installers labelled `0.10.5` that hash differently
  from the released `0.10.5` (both sets recorded in `CHANGELOG.md`). Nothing
  distinguishes them to a user or an updater, so that unreleased pair must
  never be distributed. They live outside the repo.
- **CLOSED 2026-08-27 - Syndicate packaged acceptance gate.** Moot: Syndicate
  was separated from the Packet\* product family and the whole execution-target
  integration was removed from PacketBench (see `CHANGELOG.md` [Unreleased];
  pre-removal code is at `d87fb125`). The clean-Ubuntu, expiry, revocation, and
  rollback matrices in
  [`dev/archive/syndicate/syndicate-execution-target.md`](./dev/archive/syndicate/syndicate-execution-target.md) and
  [`dev/archive/syndicate/syndicate-expiry-acceptance.md`](./dev/archive/syndicate/syndicate-expiry-acceptance.md)
  are Syndicate's to run against its own client now; the docs stay as records.
- **CLOSED 2026-08-27 - Syndicate `device.refresh` client half.** Moot with the
  integration's removal: PacketBench no longer holds grants to refresh. The
  proposal ([`dev/archive/syndicate/syndicate-device-refresh-proposal.md`](./dev/archive/syndicate/syndicate-device-refresh-proposal.md),
  delivered to Syndicate 2026-08-15 as `packetbench/device-refresh-proposal`)
  is Syndicate's to adopt or drop.
- **CLOSED 2026-08-27 - Contribute the device→relay protocol spec.** The draft
  ([`dev/archive/syndicate/controller-protocol-device-relay-half.md`](./dev/archive/syndicate/controller-protocol-device-relay-half.md))
  was handed to Syndicate before the split and stays in `dev/` as the record;
  the reference implementation it documents lives at
  `src-tauri/src/commands/syndicate_relay.rs` @ `d87fb125` (removed from the
  tree with the integration) and remains the device-half reference for the
  future Remote Agents work.
- **CLOSED 2026-08-27 - Syndicate SSH forward pins the remote port to 4317.**
  Moot: `commands/syndicate.rs` and the forward it built were removed with the
  integration.
- **CLOSED 2026-08-27 - PacketRelay opens one WebSocket per RPC.** Closed as
  written: the client that did this (`syndicate_relay.rs`) was removed with the
  integration, so no PacketBench code opens those sockets today. **But note
  Owner decision 6** — PacketRelay itself is now PacketBench's, so connection
  reuse becomes a Remote Agents concern the moment that program builds a new
  device half. It is not Syndicate's to fix on our behalf.
- **CLOSED 2026-08-27 - Relay keepalive is coupled by an exact string.** Closed
  as written: the emitting side (`syndicate_relay.rs`) was removed with the
  integration. **But note Owner decision 6** — the byte-exact ping/pong
  coupling and its missing fixture live in PacketRelay, which PacketBench now
  owns, so this returns as a real Remote Agents item rather than staying
  Syndicate's (they tracked it as their P4#11).
- **P1 - Dictation hardware/platform matrix.** Run default/USB/Bluetooth,
  44.1/48 kHz, fast-PTT, cancel, disconnect, repeated phrase, first-model-load,
  history, in-app, clipboard, and opt-in external-paste tests on Windows with an
  active microphone. Then run the Linux ALSA/PipeWire plus X11/Wayland matrices.
  September 8: installed 0.14.1 enumerated the PLT Focus at 16 kHz mono;
  Tiny downloaded, was selected and independently checksum-verified. The live
  1,500 ms probe opened the microphone but received zero frames and recovered
  with an error. Speech accuracy, model inference and physical recovery remain
  unproved; see `dev/gui-provider-evidence-2026-09-08.md`.
  macOS microphone permission, TCC behaviour, and the `systemWidePaste` gap are
  items MAC-13 to MAC-15 of the acceptance matrix in
  [`dev/macos-release-plan.md`](./dev/macos-release-plan.md).
- **P2 - Local Terminal shell matrix.** In the v0.10.3 package, exercise Auto,
  PowerShell 7, Windows PowerShell, Command Prompt, Git Bash, WSL,
  unavailable-profile recovery, app/workspace/pane persistence and hydration,
  and CLI/SSH non-regression. Detection and direct command probes already pass.
- **P2 - Workspace, Settings, and SSH proof.** Run manual Workspace/Agents
  dogfood plus packaged OS-keyring set/delete/rollback and live pinned-host
  password authentication. Run the surviving Claude Agent SDK and OpenAI
  Agents SDK local/SSH provider matrix; the retired Codex chat-provider gate is
  not applicable.
- **P2 - GitHub/Gitea authority and Issue-to-Flight mirroring.** Use disposable
  GitHub and Gitea repositories to prove create/adopt/update/pull/conflict,
  hidden-window pause, restart, revoked-auth recovery, repository transitions,
  and the bounded slow-write/host-switch overlap.
- **P2 - Project Memory interoperability — hardened 2026-08-28, real-editor
  proof still open.** The simulated matrix ran and found eight faults, all fixed:
  a leading-edge debounce that fired mid-save, zero-byte and BOM-prefixed files
  producing ghost or silently-unmanaged notes, editor lock files listing as
  notes, `write_atomic` leaving a window with no file on disk and an unread
  backup, arming the watcher creating `.agents/memory` in every project opened,
  a leaked OS watch handle per project, O(notes^2) search, and per-note regex
  compilation on the reload hot path — plus seven store races. `.gitignore` is
  now pinned untouched by three tests including a byte comparison.
  **Still open:** no real editor was driven — VS Code, vim, and Emacs against a
  live `.agents/memory` remain untested, as do the `notify` callback wiring, the
  `write_atomic` fallback branch, watcher eviction at the cap, and the packaged
  matrix. Known and deliberately unfixed: `find_note` lists the whole directory
  per mutation (an id index would break resolving an externally-renamed note by
  its frontmatter id), and a 2,000-note snapshot can serialize ~512 MB to the
  frontend, which needs a paginated list command.
- **P2 - MCP Hub parity.** Run surviving sidecar/in-process providers against
  configured local and pinned-SSH MCP servers: crash/reload/version-skew,
  offline install/removal, trust downgrade/reconnect, remote-profile parity,
  and packaged catalog/removal smoke. The 2026-09-07 consolidation adds v12
  host-owned project trust and handshake-before-start. The 2026-09-08 real
  Linux OpenSSH matrix passed old-peer rejection, host-local project trust,
  marker execution/denial and reconnect (9/9); installed 0.14.1 payload/runtime
  checks also passed. Full packaged provider/GUI parity remains; see
  `dev/installer-ssh-evidence-2026-09-08.md` for the exact proof boundary.
- **P2 - Trust/provenance parity.** Run all-provider local/SSH/MCP/restart/YOLO
  and packaged visual/manual matrices without weakening denial floors.
- **P2 - Remaining Monitor proof.** September 8 native testing found and fixed
  Windows creation deadlock and main-window shutdown leakage, now packaged in
  0.14.3. Two-display opening/rendering, route reuse, focus, maximize, own close,
  live conversation projection and main-window shutdown were exercised, with
  exact per-build scope in `dev/gui-provider-evidence-2026-09-08.md`. Accessible
  window-button names were added and observed. Still run stale/deleted entity,
  Flight, 800-pixel responsive/full keyboard, and WebView-to-Rust denial
  integration cases; source allowlist tests alone do not close that last gate.
  The 0.14.7 source adds serialized concurrent singleton creation, with four
  focused Rust tests passing; its new concurrency test uses a fake native seam,
  so installed concurrency proof remains separate (`dev/workspace-release-0.14.7.md`).
- **DONE 2026-09-11 - Packaged conversation restart fixes.** Installed 0.14.4
  retained the exact initial Ollama prompt after confirmed mid-turn shutdown,
  restoring idle with an interruption notice. A restored idle conversation
  accepted qwen2.5-coder:7b → qwen3.5:4b without the missing-session error and
  retained that choice after restart. Seven source regressions also cover
  live backend rejection and stale saves. Evidence:
  `dev/workspace-evidence-2026-09-11.md`.
- **P3 - Windows OpenSSH and remote transfer proof.** Add an OS probe and
  unit-tested cmd/PowerShell command builder for Windows-OpenSSH targets. Prove
  streamed transfers above the current 2 MB cap before considering port
  forwarding.
- **P3 - Autonomy harness real-run validation.** Exercise
  `src/lib/agent-harness.ts` against a live provider and record the evidence.
  Expanded into H1/H6 in the October 19 agent/harness review above; use that
  consolidated item for production-executor evaluation and run attribution.
  (Originally folded from `docs/deferred-work.md`.)
- **P3 - PTY orphan-reaper live verification.** After the reaper is actually
  wired (see the Fable 5 P1), verify orphan reaping in a packaged build.
  (Folded from `docs/deferred-work.md`.)
- **P3 - Additional platform packaging.** Snap/Flatpak remain deferred until the
  release matrix demands them. macOS `x86_64-apple-darwin` is a fast-follow to
  the v1.1 arm64 DMG only if a user asks; it cross-compiles on an Apple Silicon
  Mac and needs no new machinery. Linux packaging is still unproven.

- **P2 - Live model discovery, real-endpoint proof.** `list_provider_models`
  (`src-tauri/src/commands/provider_models.rs`) parses six wire shapes and is
  covered by 23 tests, but every fixture in that module is hand-authored - the
  parsers are verified against our belief about each response, not against the
  providers. **OpenRouter is now genuinely proven:** 395 live entries fetched
  2026-08-31 match the parser's assumptions exactly, including the nullable
  `top_provider.context_length` / `max_completion_tokens` (6 of 395 null) and
  `pricing.prompt` / `completion` always arriving as strings. Two things only
  live data could settle: **10 models price at the sentinel `-1`** for
  variable/unknown cost, caught by the `per_token < 0.0 -> None` guard at
  `provider_models.rs:526` - without it they would surface as -$1,000,000/Mtok
  and sail straight past any zero-cost check - and **42 price at exactly `"0"`**,
  so the free row has real occupants for `expectedStatus` to assert on. Still
  unproven: Anthropic, OpenAI, MiniMax, and the other keyed providers, all of
  which need credentials the development environment does not hold (only
  `ANTHROPIC_BASE_URL` is set). Close this with an `#[ignore]`d live-capture
  test that hits the real endpoints when keys are in the environment, run by
  hand rather than in CI, so the proof is repeatable instead of expiring at
  every release.
- **P2 - Anthropic pagination is unreachable, not merely untested.**
  `list_anthropic_models` requests `limit=1000` (`provider_models.rs:335`) and
  Anthropic publishes a few dozen models, so `has_more` is false on the first
  page and the loop at `provider_models.rs:330` will never take a second
  iteration in production. Shipping a build and clicking refresh does not
  exercise it: the cursor handling, the empty-cursor guard at
  `provider_models.rs:346`, and the `MAX_ANTHROPIC_PAGES` cap are dead paths
  until Anthropic crosses 1000 models. The live-capture test above should force
  `limit=1` for this provider specifically - the only way the loop genuinely
  runs twice against a real endpoint.

## Bounded source work

These are real code changes, not substitutes for the proof matrices above.

### PacketCode ACP transport residue (2026-08-26)

The ACP transport, its engine surface, and the Claude Code x Codex restyle of
the Agents pane are implemented and green (731 Rust + 31 ACP integration, 267
frontend files / 2305 tests). Deliberate leftovers.

Re-verified 2026-08-27: the eviction mechanism is still wired-but-undriven
(`acp/mod.rs:1364` `close_session_on`, called only from `acp/routing.rs:472`;
no `MAX_IDLE_RESIDENT` or `isEngaged` anywhere), and `deny`/`plan` still both
collapse to ACP `read-only` (`acp/routing.rs:70`, tests at `:535,:539`). The
`/opacity` P1 has since landed and is marked below.

- **LANDED 2026-08-27 - Dead `/opacity` modifiers on Graphite tokens.**
  `tailwind.config.ts:9+` now declares every Graphite token in the
  `color-mix(in srgb, var(--color-*) calc(<alpha-value> * 100%), transparent)`
  form, so opacity modifiers compute. The audit this item asked for — 1113
  never-seen styles switching on at once, light and dark — is **not** recorded
  as having been run; if a visual pass is wanted, open it as its own item
  rather than reopening this one.
- **P2 - Adopted engine sessions do not render their replay.** The
  `api-agent:*` contract has no user-turn event, so a replayed ACP transcript
  would show every assistant turn with every prompt missing, and PacketBench has
  no local record to interleave. The replay is suppressed and the conversation
  opens with a notice; the engine still holds full history as model context.
  Real replay needs a user-turn event in the contract.
- **P2 - ACP sessions expose four permission postures, not five.** `deny` and
  `plan` both map to ACP `read-only`, so `deny` is dropped. This is a property
  of the posture mapping, not the operator ceiling, and applies even to a
  fully permissive engine.
- **P2 - No idle-session eviction policy for ACP sessions.** The mechanism is
  wired (`close_session_on` -> ACP `session/close`, idempotent and degrading to
  success on engines without it), but nothing drives it, so engine-side session
  runtimes accumulate over a long run. The retired packetcode-gui carried the
  policy this should copy: an LRU over resident sessions with
  `MAX_IDLE_RESIDENT = 5`, and an `isEngaged` guard that never evicts a session
  that is running or holding an unanswered permission request. Re-selecting an
  evicted session just resumes it via `session/load`. Roughly 40 lines; recorded
  here because the source repo is now archived.
- **P3 - ACP contract fixtures live only in PacketBench.** The original product
  split put ACP extensions and contract fixtures upstream in `packetcode`, so
  the engine owns its own protocol contract. In practice `mock-engine.mjs` and
  the `acp_stream.rs` suite exist only here. That is defensible (they test the
  client, not the engine), but it means a packetcode-side protocol change has no
  fixture upstream to break. Decide whether to mirror them into `packetcode` or
  to record that PacketBench is the contract's home.
- **P3 - Launch composer shows the seeded model catalog for the ACP row.**
  Engine-advertised models reach the picker only once a conversation exists;
  fetching them pre-launch would require branching on provider id, which the
  pane's capability rule forbids.
- **P3 - Engine installer is unproven on macOS/Linux.** Command construction is
  unit-tested per platform, but `curl | bash` has never been executed on a real
  Unix host. It targets `~/.local/bin` because a GUI app cannot answer the
  sudo prompt `install.sh`'s `/usr/local/bin` default raises.
- **P3 - Frontend suite is timeout-flaky under CPU contention.** A 7x slowdown
  from parallel work cascades into the 5s default `testTimeout`; the same
  suites pass serially and in isolation. Worth raising the default or marking
  the store-graph suites.

### Three-track build-out residue (2026-08-26)

Deliberate leftovers from the LM / PacketAgent-handoff implementation wave
(branches `feat/lm-and-packetagent-handoff` in this repo and
`feat/packet-product-handoff-surface` in PacketAgent). Re-verified 2026-08-28:
the two remaining Claude CLI auxiliary callers were migrated on 2026-10-15.

- **DONE 2026-10-15 - LM 3C-3 tool-loop half.** `github_investigate_issue` and
  `ask_agent_chat_stream` resolve an `AuxRoute` and use `core::aux_research`:
  bounded read-only local file tools, scoped chat streaming/cancellation,
  reasoning replay and usage accounting. Both passed live Sugar/Conduit tests;
  Settings controls both routes and exposes Insights chat. No auxiliary command
  calls `run_claude` or `claude_command`. Full remote GitHub issue retrieval was
  not part of the synthetic live acceptance (the repo has no issues).
- **P2 - LM local-opt-in surface.** The "route aux tasks locally" banner and
  one-click pin are gated on a green `cargo test --test ollama_e2e -- --ignored`
  run against the live daemon (test ships ignored-by-default).
- **P3 - PacketAgent handoff polish.** "Review branch…" landing action into the
  existing diff/review surface; optional `flagLinkedIssuesNeedHuman` on
  budget_exhausted/failed; a subscriber surface for conversation-keyed
  deployments (only the Flight card subscribes today). PH10 live e2e runbook is
  in [`dev/bridgemind/packetagent-handoff-loop.md`](./dev/bridgemind/packetagent-handoff-loop.md)
  scope — mint a credential with the new CLI first.
- **P3 - Ollama capability cache staleness.** The `/api/show` capability memo
  is keyed `{base}|{model}` for process lifetime; a model re-pull mid-process
  can serve a stale tools-capability answer until restart.

### Workspace pane-system review (2026-08-07)

Three-team review of the mosaic layout, pane runtime lifecycle, and comparable
products. Four findings were fixed in v0.10.5 (preset leaf duplication, the
add/remove remount that restarted running agents, the zoom Escape hijack, and
layout persistence). These are the remainder, still open.

Spot-checked 2026-08-27 and still true: no `.focus()` call follows pane focus
in `useXterm.ts` / `WorkspacePane.tsx` / `PaneContainer.tsx`; `useXterm`'s
`ResizeObserver` (`:137`) still has no debounce or rAF batching; no
`TileChrome` component exists; and `react-mosaic-component` is still pinned at
`7.0.0-beta0` (`package.json:74`). One claim needed correcting — see the dead
pane API item.

September 11 reconciliation: terminal focus, resize/output batching and caught
command/template PTY sends now have source fixes and regression coverage below.
Reproduce the older hydration/layout findings before treating them as current
normal-startup failures:
`initializeApp` hydrates Workspaces before publishing `initialized`, and
`WorkspaceView` gates mosaic mounting on that flag. Wholesale replacement in
`hydrateFromBackend` and first-build-only layout consumption remain edge cases
to test, but those code patterns alone do not prove the historical startup race
is reachable today. Workspace daily workflow is now the first P1 roadmap track.

- **SOURCE FIXED 2026-09-11 - Terminal focus and navigation.** Selection now
  focuses the terminal, Ctrl+Alt+PageUp/PageDown cycles visible terminals, and
  workspace switching restores the last focused pane. Modal, editor, approval,
  hidden-pane and highlight-expiry cases have regression coverage. Native
  acceptance is tracked in `dev/workspace-evidence-2026-09-11.md`.
  Historical cause: `activePaneId` drove a border
  class only; nothing calls `xterm.focus()` or focuses the composer. Clicking a
  pane's header or padding marks it active while keystrokes still go to
  whichever pane last had DOM focus, and `requestPaneFocus` highlights a pane
  the user must then click. No shortcut cycles panes or focuses pane N —
  `mosaicPresets.getLeafOrder`'s docstring promises `Ctrl+1/2/3/4` switching
  that does not exist.
- **SOURCE FIXED 2026-09-11 - Resize batching.** `useXterm` now coalesces fits
  per animation frame, ignores duplicate dimensions, and cancels hidden or
  unmounted work. Four/eight-pane burst and visibility regressions pass.
  Historical cause: `useXterm`'s `ResizeObserver` had no
  debounce or rAF batching, and react-mosaic throttles splitter drags to 30Hz,
  so a 4-pane drag costs roughly 120 forced layout measurements and up to 120
  resize IPC round-trips per second. (`src/hooks/useXterm.ts`)
- **DONE 2026-09-11 - Incremental pane layout lost on restart.** Native 0.14.4
  revealed that four added columns became a 2x2 preset because only drag
  release saved geometry. Structural add/remove changes now save their exact
  tree once, preserving mounted terminals. The new regression failed before
  the fix; installed 0.14.5 retained four columns after normal restart without
  a prior splitter gesture. See `dev/workspace-evidence-2026-09-11.md`.
- **SOURCE FIXED 2026-09-11 - PTY output batching.** An eight-entry bounded
  queue feeds a dispatcher capped at 32 KiB / 8 ms. It appends and emits the
  same sequenced batch, then drains before exit. Queued-burst tests turn eight
  reads into two emissions for 1/4/8 panes, preserving all text. This is a
  synthetic event-count result, not a measured native frame-rate claim.
  Historical cause: one Tauri event per
  8KB read, and each event is parsed twice (`useTerminalSession` and
  `usePtyStateDetector` both listen on `pty:output:<id>`). A noisy build floods
  the bridge. (`src-tauri/src/commands/pty.rs`, `src/hooks/usePtyStateDetector.ts`)
- **INSTALLED 0.14.6 2026-09-11 - Shared pane controls.** `TileChrome` now owns
  the common drag header, identity/status, accessible zoom and optional close
  controls. Terminal, saved conversation and file bodies retain their existing
  lifecycle. Failed-send controls no longer act as drag handles. Historical
  cause: `WorkspacePane`,
  `ConversationTile`, and now `FileTile` each hand-roll the same grip / identity
  / zoom bar and each re-connect the mosaic drag source, because
  `mosaic-overrides.css` hides the library toolbar that _is_ the drag handle.
  Three status vocabularies coexist (terminal pill, conversation pill, and
  `sessionStatus`'s `Attention`, which calls itself the single truth but is not
  what either tile renders). Shared terminal/file controls and zoomed-file
  closure passed native acceptance; saved conversation behavior has focused tests.
- **P3 - Dead pane API in `layoutStore`.** **Corrected 2026-08-27 — the
  original claim was too broad.** `panes`, `addPane`, and `removePane` are
  genuinely dead: no non-test caller references them, and every `addPane` hit
  in `src/` resolves to `workspaceStore.addPane`. But `setPaneSession` has five
  live callers in `src/hooks/useTerminalSession.ts` (`:263`, `:298`, `:446`,
  `:467`, `:488` — `:263` arrived with the orphaned-spawn fix), and
  `getActivePane` is called from `src/stores/promptStore.ts:120`. So
  `layoutStore` is live for `projectPath`, `activePaneId`, `setPaneSession`,
  and `getActivePane`. The decoy `panes` array is still real and still worth
  deleting; the rest of the API is not dead.
- **INSTALLED 0.14.6 2026-09-11 - Readable many-pane layouts.** Default readable
  canvas dimensions preserve saved ratios with scrolling. Fit all, Balance
  sizes, pane selection/navigation and zoom are explicit controls. Real-browser
  eight-pane geometry/lifecycle checks and native eight-column restart pass.
  Tabs remain a separate design:
  the current library unmounts inactive tabs, so converting live terminals
  would require preserving their runtime independently of tab rendering.
- **PROFILED 2026-09-12 - Eight-pane output on native WebView2.** A dedicated
  isolated native host with real Workspace/xterm and mocked Tauri delivered
  21.9 MB per run with all fresh Unicode markers and terminal instances intact.
  Cold/warm p95 frame intervals were 16.8/16.8 ms, maxima 50.0/16.9 ms, with no
  long tasks. CPU profiles identify buffer copying/parsing as the largest named
  JavaScript costs; they do not isolate GPU time. This resolves the requested
  native profiling investigation without speculative production scheduling
  changes. It is not packaged/live-PTY or universal FPS acceptance. Exact scope,
  raw evidence and reproduction: `dev/workspace-release-0.14.7.md`.
- **BUILT 0.14.7 2026-09-12 - Count viewer panes separately in Workspace summaries.**
  Workspace and Fleet classify `pane.kind` before inert CLI carrier fields:
  File viewer and Saved conversation stay distinct from actual terminals/CLIs.
  Header account grouping and Fleet attention mapping remain intact. All 33
  focused component/projection tests and both installer builds passed. Installed
  0.14.7 observation remains separate; see `dev/workspace-release-0.14.7.md`.
- **NEEDS REPRODUCTION - A layout arriving after first mount is ignored.**
  Current normal startup hydrates before mounting the Workspace, so this old
  late-arrival sequence is not established as reachable there. It is distinct
  from the reproduced incremental-layout loss fixed above.
  The container consumes `workspace.layout` only on its first tree build. If the
  localStorage cache hydrates without a layout and the backend later supplies
  one with identical pane ids (most plausibly after a swallowed
  `localStorage.setItem` quota failure in `workspaceStore.ts`), the preset is
  kept and the next saved gesture writes it over the user's arrangement. Low
  frequency, permanent loss when it hits.
- **P3 - `removeFromTree` cannot prune a leaf inside a tabs node.** It returns
  tabs nodes unchanged. `reconcileLayout`'s final leaf check catches this and
  falls back to the preset, but the incremental add/remove path has no such
  backstop: a closed pane inside a tabs node would stay a leaf and `renderTile`
  would return a bare `<div/>`. Latent — no `createNode` is passed today, so the
  library never mints a tabs node. Must be fixed alongside the tabs work above.
- **BUILT 0.14.7 - Missing-conversation fallback survives zoom.** The
  fallback carries `data-pane-zoomed` and selects its pane on pointer/keyboard
  focus. Zooming a missing transcript retains the explanation and Remove tile
  control; Show all panes restores the grid. Regression coverage exercises the
  actual Mosaic reveal selector and toolbar.
- **P3 - `ReviewSurface` does not mark its Escape handled.** Its layering
  therefore depends on listener registration order rather than on
  `defaultPrevented`. No user-visible symptom found; a `preventDefault()` on
  close would make the ordering explicit.
- **SOURCE FIXED 2026-09-11 - Zoom cleanup on archive/delete.** Owned zoom is
  cleared, including stale zoom encountered during backend hydration. Tests
  preserve zoom belonging to an unrelated surviving Workspace.
  Historical cause: both operations nulled
  `activeWorkspaceId` but leave `zoomedPaneId`, so restoring the workspace
  reopens it already zoomed on the old pane. Inert meanwhile — the stale id
  matches no rendered pane.
- **P3 - Upgrade react-mosaic 7.0.0-beta0 → 7.0.0.** Released 2026-07-13. The
  review recommends staying on react-mosaic rather than migrating to dockview:
  tiles own PTY handles and xterm instances, and dockview's panel lifecycle
  remounts during drag/popout would tear live terminals. Only popout-to-second-
  monitor would justify a migration.

### Fable 5 review findings (2026-08-05)

Verified findings from the six-team deep review; full evidence with file:line
citations is in
[`docs/reports/fable5-review-2026-08-05.md`](https://docs.ianlan.dev/reports/fable5-review-2026-08-05.md).

**This section is a review snapshot, not a task list that maintains itself.**
It was reconciled against source on 2026-08-27 and eleven findings were closed;
they are listed under _Landed since the review_ at the end of this section so
nobody re-opens them. What follows is only what is still open — each entry
below was re-read in source on that date unless it says otherwise.

- **RECONCILED 2026-09-24 — Sub-agent permission findings.** The old claim that
  all three holes remain open is obsolete: the child loop now checks tool
  membership and denies destructive tools, grep skips symlinks, and the default
  permission mode is `AskForRisky`. The current concrete authority findings are
  **B01** (custom-agent MCP selection/root snapshot loss) and **B02** (parent
  in-process profile advertisement without dispatch membership validation),
  tracked in the completeness sweep above. Do not reopen the corrected child
  checks from this historical review description.
- **P2 - Flight cost integrity.** Narrowed but still open. The permanent-
  inflation half is gone — `flightStore.hydrateFromBackend` no longer does a
  `max()` merge, it takes the backend value for any id the backend knows
  (`stores/flightStore.ts:353-366`). The double-apply half survives:
  `applyBackendCostDelta` still **adds** (`totalCost: (f.totalCost ?? 0) +
costUsd`, `stores/flightStore.ts:371-383`), so a delta that interleaves with
  a hydrate is counted twice until the next hydrate corrects it. Emit
  authoritative totals and make the listener set rather than add. The three
  companion items are **unverified** this pass: `pkt/*` branch cleanup after
  attempts, plan-apply replacing milestones without confirmation, and the
  launch modal hiding partial-launch success.
- **P2 - Sidecar resilience.** Still open, all of it. `MAX_RESTARTS_IN_WINDOW`
  = 3 still bricks the provider (`commands/agent_sidecar/supervisor.rs:709`)
  and the only exported command is `get_sidecar_status`
  (`commands/agent_sidecar/mod.rs:209`) — there is no restart command. No
  watchdog or stall timeout exists anywhere under
  `commands/agent_sidecar/`. `agent-sidecar/src/providers/openai-agents.ts`
  still contains no `rate_limited` emission. The inline `done`/`error`
  persistence on the single reader loop is **unverified** this pass.
- **P2 - Dependency and config hygiene.** Two of five still open, one
  unchanged, two landed. Still open: `reqwest` carries no
  `default-features = false` (`src-tauri/Cargo.toml:36`), and
  `sidecar:install` still has no `--frozen-lockfile`
  (`package.json:24`). Unchanged: `fuzzy-matcher = "0.3"` is still declared
  (`src-tauri/Cargo.toml:47`) with zero `fuzzy_matcher` references anywhere in
  `src-tauri/src` — still dead, still deletable. Landed: the
  `specs-gen.vercel.app` CSP origin is gone from `tauri.conf.json`, and
  `.gitignore:54-56` now covers `*.key`/`*.pem`/`*.p12` (recorded under Owner
  decision 4).
- **P2 - SSH trust anchors.** Still open. `ssh_pin_host`
  (`commands/pty.rs:1268`) validates only that the line is non-empty and
  de-dupes it — no wildcard and no `@cert-authority` rejection. No pinned
  fingerprint is required before a remote sidecar start
  (`commands/agent_sidecar/supervisor.rs` references `host_fingerprint` only
  inside a test), which is the same hole the remote-API-key item below
  describes; close them together. The `UserKnownHostsFile` sub-item is
  **downgraded, not closed**: both call sites push it as its own argv element
  after `-o` (`core/execution.rs:117`, `commands/pty.rs:1389`), so no shell
  quoting applies on the paths verified here.
- **P2 - Listener-lifecycle sweep.** Two of three still open. The
  cancelled-flag pattern **has** been applied — no file now assigns `unlisten`
  after a bare `await listen(...)` without a liveness guard (the one remaining
  such assignment, `PacketCodeEngineGate.tsx:158`, checks `aliveRef.current`).
  Still open: the five-file `mountedRef` dev-only bug — `QualityAIExplanation`,
  `QualityAISummary`, `QualityAIRunSummaryPanel`, `PRDescriptionButton`, and
  `PRReviewPanel` all still declare `useRef(true)` and set it `false` in
  cleanup without ever restoring it on mount, so React 18 StrictMode's
  double-mount wedges the panel. Also still open: `AutoFixButton` now has
  unmount cleanup (`components/quality/AutoFixButton.tsx:130-131`) but never
  calls `cancelQualityFix`, which exists at `src/lib/tauri.ts:454`.
- **RECONCILED 2026-09-11 - workspaceStore persistence and sends.** The ordered
  backend save tail was already present. Normal startup hydrates before showing
  Workspaces, so the historical create-during-bootstrap loss is not reproduced;
  retain backend authority. Newly corrected selection validation rejects stale
  archived/deleted records and restores backend-only selection. Command/template
  sends now catch failure, retain exact input, suppress duplicate pending sends,
  and offer explicit retry plus separate restart. Source regression suites pass;
  native proof is scoped in `dev/workspace-evidence-2026-09-11.md`.
- **P2 - Undefined theme tokens.** `accent-cyan`, `accent-yellow`,
  `accent-orange`, and `text-text-tertiary` are used but not defined — 12
  usages render colourless today (PR pending pills, "Up Next" status dot).
  Re-verified 2026-08-27: none of the four appear in `tailwind.config.ts`,
  whose `accent` group is green/amber/blue/red/purple/soft/line and whose
  `text` group stops at `faint`. Note this is now the **only** colour item
  left in the theme layer — the `/opacity` fix above landed, so these four
  tokens no longer hide behind it.
- **P2 - Coverage measurement and runtime split.** Nothing here has started.
  Re-verified 2026-08-27: no coverage configuration exists in
  `vitest.config.ts` or `package.json`, `src/runtime/` does not exist, and
  `src/agents/` is still `src/agents/`. Add vitest coverage tooling with
  per-directory floors; move the ~2,483 LOC of event-listener runtimes out of
  `stores/` into `src/runtime/`; rename `src/agents/` → `src/lib/pty/`; then
  write behavioural tests for the six money/remote modules
  (`LaunchAsyncFlightModal`, `reviewerGateRuntime`, `issueFlightMirrorStore`,
  `ServerFormModal`, attempt listeners, the PTY pattern parser).
- **P3 - Brand-literal sweep.** Replace the hardcoded `packetbench:` storage
  keys and `packetbench://` URIs with `storageKey()`/`URI_SCHEME` (both exist,
  `src/lib/brand.ts:22,28`). Re-counted 2026-08-27 and unchanged: **43**
  literal `"packetbench:` occurrences outside `brand.ts` and test files, and
  9 `packetbench://` occurrences.
- **RECONCILED 2026-10-06 - Local release rehearsal.** The September 24
  validation completed all eleven local gate categories, and the 0.14.8 build
  ran all twelve packaging prechecks inside `prebundle`. The older claim that
  the packaging gate had never run is obsolete. Signing/updater requirements
  remain scoped to the owner decisions above; historical v1.0 deadlines remain
  void. Exact evidence and the latest pre-tag pass:
  `dev/existing-code-stabilization-2026-09-24.md`.
- **RESOLVED for the Windows release path - WSL gate environment.** Target
  override validation and Cargo bundle-root discovery were fixed; Windows
  Rust/schema checks passed in the September validation. Run native Windows
  release gates from Windows, as documented in `dev/local-quality-gates.md`.
  This does not claim that a WSL-hosted MSVC build was validated.
- **P2 - Remote sidecar provider/GUI acceptance.** The 2026-09-07 consolidation
  fixes the request-before-handshake race in source: SSH startup awaits a
  compatible v12 `ready` before forwarding the session/API key. Regression
  tests reject old/missing/invalid handshakes and preserve buffered events.
  Native real pinned-SSH handshake/trust/reconnect proof passed 9/9 on
  2026-09-08 (`dev/installer-ssh-evidence-2026-09-08.md`). Remaining: full
  packaged Tauri session lifecycle with the paid SDK providers. The broader
  GUI run passed local Ollama turns, cancellation and recovery; MiniMax
  hit its plan quota and Anthropic/OpenAI keys were absent. Those observations
  do not prove SSH SDK parity (`dev/gui-provider-evidence-2026-09-08.md`). The
  separate real remote Claude CLI check is deferred at the user's explicit
  request on 2026-09-12 because the subscription requires paid renewal; no
  successful provider reply is claimed. Its opt-in runner is documented in
  `dev/installer-ssh-acceptance.md`; do not request login or retry unless the
  user resumes it. This CLI check would not close the SDK provider matrix.
  The SSH-trust-anchors item remains open; this change does
  not require a fingerprint where the existing connection permits TOFU.
- **P2 - Sidecar cold start takes 18-29 s on this checkout.** **Unverified on
  2026-08-27** — closing or confirming it needs a timed run, not a read.
  Module-load
  measurement attributes ~25.5 s of it to `providers/openai-agents.js` alone
  (pre-existing, unrelated to the MCP trust work). Four spawn-based smokes
  (`protocol`, `registry`, `remote-project`, `remote-mcp-fromfs`) time out
  against their 3-5 s `ready` budgets as a result. Re-run them on a native
  filesystem to separate DrvFs cost from real load cost, then either lazy-load
  the OpenAI SDK behind first use or raise the budgets deliberately.
- **P3 - A landed attempt does not remember that it landed.** The attempt tile
  reports "Landed `pkt/…` as `abc1234`" in component state only, so the fact
  disappears on remount. Persisting it needs a new field on the Rust `Attempt`
  struct. Re-clicking Land is already safe — the merge returns `nothingToLand`
  and the tile says so rather than claiming a second landing. Re-verified
  2026-08-27: `core/flight.rs` still has no `landed` field.
- **P2 - Several test timeouts are too tight for this filesystem.**
  **Unverified on 2026-08-27** — this needs a suite run, not a read. A full
  suite run on 2026-08-06 returned 1,631 passed / 10 failed, and **every one of
  the ten was a timeout or a platform assumption, not a regression** — but that
  makes a clean run impossible here, so a real failure would be easy to miss.
  The source-fence tests (`workspace-agents-boundaries`, `confirm-idiom`) walk
  all of `src/` synchronously and need 5-49 s against a 5 s default;
  `sessionContract` pays a cold-import cost; and
  `persistenceMigration`'s "moduleStore ignores a persisted 'ideation' entry"
  carries its own hardcoded `15_000` budget while taking ~27 s on DrvFs. All
  pass when given room. Raise the budgets for the filesystem-walking tests,
  and consider `--pool=threads` as the repo default: the forks pool hits
  vitest's hardcoded 60 s worker-boot timeout under load. Note the fences are
  vitest files — run them with `npx vitest run <path>`, not bare `node`.
- **P3 - Onboarding overlay now suppresses view-switch chords.** The modal
  stack correctly blocks `Ctrl+Shift+<chord>` navigation while any dialog is
  open, but `AgentsOnboarding` renders a `Modal` for the one-time welcome
  overlay, so a first-run user's chords do nothing until they dismiss it.
  Consistent with the rule and harmless, but decide whether a dismissible
  non-destructive overlay should be exempt.
- **P3 - Two component tests only pass on a Windows runner.**
  `AddSessionPicker` and `TerminalShellSettingsCard` assert Windows shell
  profiles, but `src/lib/terminalShells.ts:37-38` derives the platform from
  `navigator.userAgent`, which resolves to `posix` under jsdom on a Linux or
  WSL runner. Pre-existing and unrelated to the modal work, but it means the
  component suite is not green cross-platform — relevant once CI exists.
- **P3 - MCP Hub capability snapshot drops tool annotations.**
  `McpCapabilitySnapshot.tools` (`src/types/mcp.ts`) carries only
  `{name, description}`, so `defaultMcpTrustProfile` still derives its default
  allowlist from the name heuristic. Enforcement is unaffected (the sidecar
  probe and the Rust live listing both read `readOnlyHint` directly), but the
  Hub shows the user a less accurate picture than the runtime enforces.
- **P3 - Reviewer Gate report provenance does not persist.** The TypeScript
  `ReviewGateReport` carries an optional `provenance` envelope; the Rust
  `ReviewGateReportDto` has no such field, so the verdict now survives a
  restart but its provenance does not. Strictly better than the pre-fix state
  (nothing persisted at all) and consistent with coordination events, but
  closing it means adding the field to `core/flight.rs` and `api/mod.rs` and
  regenerating bindings.
- **P3 - Windows startup PTY reaper.** The crash-recovery sweep is deliberately
  Unix-only: a `.cmd`-wrapped CLI records `cmd.exe` in the pid registry, so a
  recycled pid would match the recorded image name and tree-kill an unrelated
  console. Pane-close and app-exit reaping do work on Windows, so only a hard
  crash strands a child. If crash-orphans prove real in practice, add a
  stronger identity token (process creation time) before building the sweep.
- **P3 - Dead code and hygiene.** Delete the ~15 orphaned frontend files
  (incl. `IssueDetailView.tsx`, the dead twin `views/SpecImportModal.tsx`, and
  the remaining dead `tauri.ts` wrappers after a Rust-side check); unify the
  flight status-dot colour maps; rename `IssueFlightMirrorCard`; backfill the
  19 missing release tags; document sidecar protocol v11 in the Rust module
  docs; align the two error-taxonomy serializations (`rate_limit` vs
  `ratelimit`). **Done 2026-08-29:** the `commands/checkpoints.rs` module
  (`save_checkpoint` / `list_checkpoints` / `delete_checkpoint`, subsumed by
  `forkAndResend`) and the four verified-dead wrapper commands
  `calculate_turn_cost`, `list_custom_agents`, `insert_dictation_entry` and
  `search_project_memory` (plus its TS wrapper) are gone; their live inner
  functions — `calculate_cost_at`, `discover_custom_agents`, `insert_entry`,
  `search_project_memory_inner` — were kept. Re-verified 2026-08-27:
  `src/components/issues/IssueDetailView.tsx` and
  `src/components/views/SpecImportModal.tsx` still exist. The tag backfill, the
  colour-map unification, and the wrapper count are **unverified** this pass.

#### Landed since the review

Closed against source on 2026-08-27. Recorded so the fixes are not re-opened
from the original report, which still lists them as findings.

- **Reviewer Gate verdict persistence** — backend-owned
  `set_attempt_review_gate` writes under the state lock,
  `commands/flight_attempts.rs:1207`, with merge tests at `:1770` and `:1786`.
- **Reconcile attempts on startup** — `recover_flights_on_startup` demotes
  non-terminal attempts to `Failed` and returns them for worktree sweep,
  `core/orchestrator.rs:96`.
- **PTY kill and reaper** — `record_spawned_pid` is defined at
  `core/pty.rs:136` and now actually called at `commands/pty.rs:855`; the
  app-exit `RunEvent::Exit` arm reaps PTY trees at `lib.rs:601`.
- **State-lock fairness** — the `try_lock` spin is gone; sync writers take the
  fair FIFO `blocking_lock` and both mutexes recover from poisoning instead of
  failing forever, `core/storage.rs:452-487`.
- **MCP read-only enforcement is fail-open** — inverted to allowlist-by-default
  on both copies, with the verb list demoted to a floor beneath it:
  `core/mcp_bridge.rs:196-253` and `agent-sidecar/src/mcp-trust.ts:9-22,253`.
- **Sidecar protocol security floor** — `MINIMUM_PROTOCOL_VERSION = 11`
  (`commands/agent_sidecar/mod.rs:122`) is enforced by `protocol_meets_floor`
  at `commands/agent_sidecar/handler.rs:79`, which refuses the session and
  explains why.
- **Authenticated Node download** — `scripts/fetch-node.js` pins the archive
  digests in-repo, re-validates the `.sha256` cache marker against the pin on
  every run, and treats the live `SHASUMS256.txt` as advisory cross-check only
  (`scripts/fetch-node.js:23-32,281-335,405`).
- **Release machinery truthfulness** — `release-readiness.mjs` executes each
  gate and reads its exit code (`runGate`, `:497-511`); `release-gate.mjs`
  separates the updater minisign key from Authenticode and says so in the
  failure text (`:251-333`); `release:gate` runs from `prebundle`
  (`package.json:44`).
- **Terminal-pane orphaned spawn** — `mountedRef` guard plus best-effort
  `killPty` before any ref or store is touched,
  `src/hooks/useTerminalSession.ts:251-258`.
- **Shared Modal focus/semantics/Escape stack** — `src/components/ui/Modal.tsx`
  imports `isTopModal`/`registerModal`/`unregisterModal` from `@/lib/modalStack`
  (`:4`) and implements focus move-in/restore (`~:103-124`) and a Tab trap that
  yields to the top-most dialog (`~:126-141`).
- **Accept/Reject safety and landing** — both decisions now route through a
  confirm backed by a live dirty-worktree probe
  (`src/components/flights/AttemptTile.tsx:81-82,136,154,498-500`), and the
  post-accept **Land** action exists (`:405`).

### Settings and Workspace

- **P2 - Stable Settings identity.** Migrate MCP selection/trust references to
  stable scoped server IDs; show the active local/SSH Workspace in Project
  settings; validate provider-aware profile model/tool choices.
- **P2 - Resolve Task Role Defaults.** Either consume the setting in the real
  launch/runtime path or remove the control. AI Provider Routing is already
  consumed and must remain. Re-verified 2026-08-27: the control is still
  advertised (`src/lib/settingsNavigation.ts:161-166`, key `routing`) and
  there is still no `taskRoleDefaults`/`roleDefaults` reader anywhere in `src/`
  or `src-tauri/src` — so it remains a setting that changes nothing.
- **P2 - CLI-first preferences and diagnostics.** Consolidate CLI/provider/SSH
  doctor output. Consider terminal appearance/behavior, Workspace restore and
  template defaults, default CLI/model, worktree cleanup, external editor, and
  environment editing only through the six-group Settings information
  architecture.
- **P2 - Detachable interactive Agents prerequisite.** Do not create a second
  interactive WebView until conversation, approval, and persistence ownership
  has a single-writer broker or versioned Rust state. The read-only Monitor is
  not proof of multi-writer safety.

### Main shell and daily-driver polish

- **DONE 2026-09-04 - A crashed CLI is indistinguishable from a clean exit
  (found 2026-08-28).**
  Every production `pty:exit` listener discards the event payload, so a PTY
  session whose child died on startup renders exactly like one the user closed
  normally: the pane simply ends, with no error, no exit code, and nothing to
  act on.

  The backend already does the work. `commands/pty.rs` reads the child's status,
  logs `exit_code` and `terminated`, and emits a typed `PtyExitPayload`
  (`pty.rs:434-457`, `:935-955`). The frontend has a normalizer for it —
  `parsePtyExitPayload` in `src/lib/tauri.ts:227`, exported with a docstring
  explaining that `0` is success and non-zero is a failed agent. **It has no
  production callers.** Its only references are in
  `src/hooks/__tests__/useTerminalSession.test.tsx`. The three real listeners
  all throw the payload away: `useTerminalSession.ts:328`
  (`listen<unknown>(..., () => finishSession())`) and `useTransientPty.ts:150`
  and `:276` (`listen<string>`, payload ignored). The typed contract is
  built, tested, and unreachable — the same shape as the unreachable cost
  statusline in Owner decision 5.

  **Found via a real failure.** `codex` panes appeared to "not load" in
  Workspaces. The cause was outside PacketBench — the vendored
  `@openai/codex` 0.147.0 binary access-violates on startup
  (`0xC0000005`, reproducible by running `codex.exe --version` directly). But
  PacketBench gave the user nothing to go on: on Windows a `.cmd`-wrapped CLI
  is spawned as `cmd.exe /c codex.cmd` (`pty.rs:768-780`), so `cmd.exe` starts
  successfully and the PTY session is created; the real CLI then dies
  milliseconds later and the pane closes silently. Any crashing or
  missing-dependency CLI produces the same blank outcome.

  Fix: consume `parsePtyExitPayload` in all three listeners and surface a
  non-zero exit distinctly from a clean one — at minimum the exit code in the
  pane, ideally recognising Windows NTSTATUS values (`0xC0000005` access
  violation, `0xC0000135` missing DLL) which are the common "the CLI is broken,
  not your config" cases. Respect `terminated`: an orchestrator-killed session
  is not a crash and must not be reported as one.

  **Shipped.** `PtyExitOutcome` in `src/lib/tauri.ts` replaces the boolean with
  four mutually exclusive cases — `clean`, `failed` (with the code), `killed`,
  `unknown` — and all three listeners now classify through it. The pane header
  renders a distinct chip per outcome, and `describePtyExitCode` names the
  NTSTATUS values this entry asked for, `0xC0000005` included.

  Two things were worse than this entry recorded. `ptyExitSucceeded` treated a
  **null** exit code as success, so "we could not read the status" was reported
  as a clean run; and `useTransientPty` called `finish(true)` whenever the
  session was merely absent from `list_pty_sessions`, inventing a success it
  had never observed. That second one fed the PacketCode install verifier,
  which could therefore report a verified install for an installer that died.
  `unknown` is now a first-class outcome, and the verifier treats it as
  unproven and lets the binary probe decide.

  `terminated` is respected: a killed session is not a crash, but it is not
  scored as a successful completion either.

- **P2 - MS4 accessibility/responsiveness.** Align Git Hosts, Workspaces,
  Dictation, and handoff labels; remove duplicate ellipsis chrome; add
  navigation/tab/menu ARIA; and prove responsive overflow from 800 px through
  ultrawide.
- **P2 - Creation semantics.** Reconcile `Ctrl+N` and the `/new` slash command,
  which still reach conversation creation through different routes with
  different semantics.
- **P3 - App-close preference.** Decide whether a scoped "don't ask again"
  preference is appropriate; preserve confirmation whenever live work would be
  destroyed unless the owner explicitly accepts the tradeoff.
- **P3 - Dead/unreferenced code decisions.** Delete or justify
  `IssueDetailView.tsx`, `useServerConnection`, and `ConnectionProgress`. All
  three still exist as of 2026-08-27 (`src/components/issues/IssueDetailView.tsx`,
  `src/hooks/useServerConnection.ts`, `src/components/servers/ConnectionProgress.tsx`).
  Overlaps the Fable 5 _Dead code and hygiene_ P3 — resolve them together.
- **P3 - Format enforcement.** Normalize the known Rust formatting drift and
  decide whether `cargo fmt --check` joins the local/release gates. Re-verified
  2026-08-27: no `cargo fmt` / `fmt:check` script exists in `package.json`, so
  no gate runs it today.
- **P3 - Historical Gemini wording.** Remove stray descriptive mentions while
  retaining intentional persisted-data read aliases until their removal gate.
  Re-verified 2026-08-27: the stray descriptive mentions are
  `src/agents/packetcode.ts:10` and the comment at `src/lib/api-models.ts:253`.
  The retired-id aliases (`stores/agentStore.ts:20`,
  `stores/workspaceStore.ts:334,378`) and the real OpenRouter
  `google/gemini-2.5-pro` row are intentional — leave them.

### Models, agents, and editing

- **LANDED 2026-08-26 - Ollama capability-aware picker.** `/api/show` is
  probed and memoised (`commands/ollama.rs:62,201`; `core/llm_ollama.rs:62,76`)
  and `ModelSelector` disables tool-less models while leaving
  unknown-capability ones selectable (`ModelSelector.tsx:78,230`). The residual
  staleness of the memo is tracked as its own P3 under _Three-track build-out
  residue_; do not re-open this item for it.
- **LANDED 2026-08-26 - Custom OpenAI-compatible provider.** Shipped as the
  `api-custom` row (`src/lib/api-models.ts:189`) backed by
  `src-tauri/src/core/llm_custom_compat.rs`, and documented in `CLAUDE.md`'s
  nine-row provider table.
- **DONE 2026-10-15 - Finish auxiliary-task routing.** All fifteen task classes
  now honor provider/model settings. Insights chat and issue investigation use
  the shared bounded read-only research loop; the remaining tasks use auxiliary
  one-shot/streaming calls. No Cost Dashboard was revived.
- **P2 - Retired-conversation provider switch.** Offer an explicit, logged
  user action to continue a conversation that references the retired
  `api-openai-codex` chat-provider id. Never rewrite automatically.
- **P2 - Edit capability groups.** Replace fragile per-tool allow-list entries
  with an `edits` capability so profiles do not silently exclude `edit_file`.
- **P2 - Failed-edit rendering.** Do not render a successful-looking phantom
  diff row when an Edit/`edit_file` tool call failed or was refused.
- **P3 - Remote exact edits.** Fix the SSH heredoc trailing-newline behavior
  before enabling `edit_file` remotely.
- **P3 - Composer per-launch MCP multi-select.** Let a launch pick a subset of
  enabled MCP servers instead of all-or-nothing. (Folded from the retired
  `docs/deferred-work.md`.)
- **P3 - Per-run cost cap.** A `costCapUsd` per conversation/run with mid-run
  cancel, complementing the existing budget guardrails. (Folded from
  `docs/deferred-work.md`.) Expanded into the P1 H4 request-reservation item above;
  implement and track the combined requirement there.
- **P3 - Cross-provider reasoning effort.** Expose a reasoning-effort control
  instead of the hardcoded 8000-token thinking budget in `api_agent.rs` /
  `llm_anthropic.rs`. Part of H3/H5's model/context capability contract in the
  consolidated October 19 review above. (Folded from `docs/deferred-work.md`.)
- **P3 - Diff viewer controls.** Side-by-side toggle, word wrap, and
  whitespace-ignore in the agent diff view. (Folded from
  `docs/deferred-work.md`.)
- **P3 - `agentTaskStore` module split.** The store is **2,261 lines** as of
  2026-08-27 — it has grown ~27% since the last recorded count of ~1,780 and
  keeps growing between reconciliations. Split along
  session-lifecycle/event-intake seams. (Folded from `docs/deferred-work.md`,
  count re-measured.)

- **P2 - Pure logic hidden behind the `@/lib/tauri` transport mock.**
  `src/lib/tauri.ts` is both the IPC surface and a grab-bag of pure helpers, so
  a suite that stubs the transport also stubs the reasoning. Measured
  2026-08-31: **103 test files mock that module and 92 replace it wholesale**,
  so any pure function living there is untested in roughly 90% of the suite.
  Wiring the live-model error classifier surfaced this as nine unhandled
  rejections that vitest flags as possible false positives; the fix was to move
  the classifier out to `src/lib/liveModelErrors.ts`, where no transport mock
  can reach it. `parsePtyExitPayload` (`src/lib/tauri.ts:227`) hit the identical
  trap earlier and is tracked separately under _Main shell and daily-driver
  polish_. Patching 92 files is the wrong fix: sweep `tauri.ts` for the
  remaining pure helpers and relocate them beside the two that already escaped.

### Flight, Git host, and runtime debt

- **P3 - Partial multi-target launch result.** Return per-target success and
  failure directly instead of recovering partial successes by diffing persisted
  Attempts after an error.
- **P3 - Planner compatibility retirement.** Define the release-age and
  retention gate for removing legacy `planner_*` fields and optional journal
  cleanup. Do not restore Planner v1.
- **P3 - MCP advertised-name cache.** Resolve MCP tool names once at agent
  session start instead of respawning every enabled server for every call.
- **P3 - Gitea parity extensions.** Consider agent-tool/create-PR support,
  richer Actions/checks, inline review-comment authoring, and multi-commit AI
  compare only after the packaged dual-host authority matrix closes.
- **DONE 2026-08-28 - P3 Semantic Memory retrieval, evaluated and declined.**
  The gate was "only if measured IDF retrieval misses justify it", and the
  measurement is now done — it was only meaningful once Ask stopped searching
  the prompt-injection budget. Recall is a step function on surface anchoring:
  100% when a query shares a token, stem, prefix, or substring with the
  document, **0% otherwise**, so a headline 92% recall reflected query
  authorship rather than retrieval quality. Shipped the two deterministic wins
  (camelCase splitting, a small domain acronym table). Declined embeddings — no
  measured need, and the corpus at `maxEvents=200` is ~34k tokens, so sending it
  to an already-configured provider dominates a bundled model on every axis
  except offline use. Declined a curated synonym map outright: against a
  held-out set whose vocabulary it did not contain it recovered **0%** while
  inflating result sets 2.75x. No vector database is warranted, and at this
  corpus size no index is either.
- **P3 - Instrument Ask to measure the real miss rate.** The one number that
  decides whether retrieval ever needs more than lexical matching is the share
  of _real_ queries that are surface-anchor-free, and it cannot be obtained from
  synthetic data. Log zero-result and single-result Ask queries locally (no
  content leaves the machine). Suggested trigger to revisit: >20% of real
  queries returning nothing while the answer was in the corpus — and reach for
  an LLM-over-corpus fallback before embeddings. Keep the invariant that makes
  this measurable: eligibility in `searchMemoryCorpus` is `relevance > 0`, with
  kind/recency/trust priors that only reorder, so a miss is always attributable
  to the scorer.
- **P3 - Historical cost compatibility.** Preserve retired-provider and old
  flight-cost data losslessly. Correct old rollups only with a schema that can
  represent input/output/cache/model attribution without guessing.

## Proposed later products

These are approved concepts, not current implementation commitments.

- **P2 - Packet Control evidence layer.** Freeze one `ControlRun`/
  `ControlStep`/`ControlArtifact` contract that projects losslessly onto
  PacketAgent's `ValidationEvidenceRecord`; then add user-initiated local/SSH
  terminal evidence capture, redaction, approval, capped retention, and
  read-only review surfaces. No daemon or autonomy expansion. See
  [`dev/packet-control-loop.md`](./dev/packet-control-loop.md).
- **P2 - Computer use (browser tier first). PAUSED 2026-08-16** — deliberately
  parked the same day it was designed, as part of the portfolio sequencing
  pass; do not schedule until the owner unpauses. Pickup runbook and staleness
  map: §7-PAUSE of
  [`dev/computer-use-plan.md`](./dev/computer-use-plan.md).
  Agent-driven screen interaction
  for API-agent conversations. Owner decisions are settled (2026-08-16):
  browser tier via CDP first, then full desktop; in-process Rust backend with
  native `computer_20251124` for Anthropic providers; approval-gated +
  kill-switch safety model with a Syndicate-pattern opt-in; Windows-only v1;
  local-only (SSH/Syndicate refused); flights excluded. Phase 0 is
  image-capable tool results end-to-end (also fixes MCP image results being
  silently dropped today). See
  [`dev/computer-use-plan.md`](./dev/computer-use-plan.md).
- **P3 - Dictation engine benchmark.** Benchmark Parakeet and optional Whisper
  acceleration only after the repaired CPU path has real packaged latency and
  quality measurements.
- **P3 - Monitor expansion.** Approval/Cost routes, saved bounds, multiple
  simultaneous windows, and PTY attachment remain later. A Monitor must never
  mount or own the live PTY.
- **P3 - Native iOS/TestFlight.** Evaluate after the Remote Agents PWA proves
  relay, auth, push, and phone UX.

## Completed boundaries

Do not reopen these from historical plans:

- (Removed 2026-08-27) PacketBench's Syndicate execution-target source boundary
  was completed and then deleted whole when Syndicate separated from the
  Packet\* family — `kind: "syndicate"` persistence, OS-keychain device
  credentials, scoped pairing/revocation, pane/session lifecycle, managed
  pinned SSH bootstrap, and encrypted PacketRelay frames all lived at
  `d87fb125`. Do not rebuild it here; the controller protocol continues in
  Syndicate's own repos. **PacketRelay does not** — per Owner decision 6 it
  stayed with PacketBench (`D:\projects\packetrelay`, with Railway the historical
  target; current deployment requires the October 24 reconciliation).
  The boundary that closed is the Syndicate _execution target_, not the relay.

- Workspace/Agents restructuring and WA0-WA4 are complete: Workspaces are
  CLI/PacketCode-first; Agents is a first-class same-window GUI-agent surface;
  new Workspace conversation attachments are retired; saved panes remain
  compatible.
- The six-group Settings information architecture and P1 authority/security
  corrections are complete.
- Flight Deck Option B is live. Planning is a normal read-only conversation
  with explicit apply; attempts remain user-launched. The autonomous Planner v1
  backend was intentionally removed.
- The 30 low-rated Reliability findings are closed.
- GitHub/Gitea dual-host source support, Issue-to-Flight source mirroring,
  Project Memory, MCP Hub, trust/provenance, Dictation hardening, Monitor v1,
  PacketCode integration, and PacketAgent W9 consumer source are implemented;
  their remaining work is recorded above.
- Claude Code panes self-bootstrap PacketBench's native status collector in
  v0.10.3; selectable Terminal shells are shipped at source/package level.

## Canonical plan map

- Product direction: [`ROADMAP.md`](./ROADMAP.md)
- Restart state and exact artifacts: [`HANDOFF.md`](./HANDOFF.md)
- Current verification/status: [`dev/current-status.md`](./dev/current-status.md)
- Source/deployment audit: [`dev/documentation-audit-2026-10-24.md`](./dev/documentation-audit-2026-10-24.md)
- Complete documentation catalog: [`dev/documentation-map.md`](./dev/documentation-map.md)
- Historical September build/install record: [`dev/existing-code-stabilization-2026-09-24.md`](./dev/existing-code-stabilization-2026-09-24.md)
- Historical tagged release: [`dev/release-v0.10.3.md`](./dev/release-v0.10.3.md)
- Remote Agents: [`dev/remoteagents/README.md`](./dev/remoteagents/README.md)
- Syndicate execution target (removed 2026-08-27; historical): [`dev/archive/syndicate/syndicate-execution-target.md`](./dev/archive/syndicate/syndicate-execution-target.md)
- Main shell: [`dev/main-shell-navigation-and-right-panel-audit-2026-07-29.md`](./dev/main-shell-navigation-and-right-panel-audit-2026-07-29.md)
- Workspace/Agents: [`dev/workspace-agents-restructuring-goal.md`](./dev/workspace-agents-restructuring-goal.md)
- Settings: [`dev/workspace-agent-settings-decision-2026-07-29.md`](./dev/workspace-agent-settings-decision-2026-07-29.md)
- Packaged/external proof: [`dev/proof-audit-2026-08-01.md`](./dev/proof-audit-2026-08-01.md)
