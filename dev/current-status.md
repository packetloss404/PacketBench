# Current product and delivery status

**October 25 dogfood follow-up:** the owner subsequently requested installation
and launch of the verified build. NSIS installed source `04cd0e16` successfully;
all 8,683 expected installed file hashes, bundled Node `v24.15.0`, protocol 12
and two echo turns passed. The installed executable hashes to
`7e7472f6d77e3621f332e1a2ab677f6d8b3a4197097a9866c3fa89964f49cbf5`.
The app opened to Agents with 20 existing conversations visible. Version remains
`0.14.9`; the source/hash identifies this newer local build. Installation and
startup evidence is beside the delivered artifacts in `installation.json`,
`packaged-sidecar.json` and `dogfood-launch.json`. This supersedes the earlier
preparation-only workstation state below, without closing the full native,
provider or hardware acceptance matrix.

The [October 25 advertised-feature audit](./advertised-feature-acceptance-2026-10-25.md)
records an 82-group feature inventory and isolated validation from audit commit
`2dd33b98` plus a test-timeout/documentation correction. The latest result for
all twelve local gates is green: 3,296 Vitest tests, 24 Chromium cases, 1,300 Rust
library tests, 12 offline evaluation cases, schema and the remaining checks.
The original scheduler had one cold-import timeout; its complete Vitest rerun
passed with all assertions intact. A disposable Linux SSH matrix also passed
15/15 native sidecar/PTY cases. Exact logs, source identity, ignored tests and
live-provider skips are in the report. The earlier shared-checkout gate run was
unstable because another task edited Rust source and is not final evidence.

The owner's requested **verified installers without reinstalling** are ready.
The first clean build at `fd2135d7` failed before installer creation because
Tauri discovered an optional developer binary. Moving it to a feature-gated
Cargo example passed four target regressions, metadata/default-production
checks, the release gate and a fresh 12/12 offline run. The clean retry at
`04cd0e16b7eb0cf312af7c384c0197c69819a20d` then produced unsigned Windows x64
NSIS/MSI installers. Both delivered copies passed all 8,683 application payload
hashes, their format-specific executable/version, extracted Node `v24.15.0`,
protocol 12 and two exact sidecar echo turns. Artifact paths, sizes, hashes,
clean source fingerprint and logs are in the audit receipt. Sidecar development
dependencies were restored. Readiness passed with zero failures and 17 disclosed
warnings; existing signing/updater deferrals remain.

GitHub checks for pushed build source `04cd0e16` returned zero statuses, check
runs and Actions runs, consistent with this repository's deliberate absence of
hosted CI. This final receipt is documentation only and follows the installer
source commit. There was no reinstall, installer execution, main-app launch,
public release, new tag or site update. The installed executable still hashes
to `b91c617d44be753ff3f2b47ff1020c5bedca9d66e4fdcbe4b3e02deb0cfaa1f9`.
Its earlier navigation smoke uses that existing payload. Real provider/account,
installed whole-flow, hardware/platform and external-integration cases remain
open. The October 24 facts below retain their original snapshot; subsequent
runtime/flow commits and remaining work are recorded in [backlog](../backlog.md)
and [HANDOFF](../HANDOFF.md).

Reconciled October 24, 2026 (America/Chicago). Source audited:
`922ddcc928629e116215d899580f7e9370b2603d` on `main`.
The [verification report](./documentation-audit-2026-10-24.md) records evidence
and limits. [backlog.md](../backlog.md) is the only task/status ledger;
[the documentation hub](./README.md) and [full catalog](./documentation-map.md)
make the documents discoverable. Dated reports describe their own snapshots.

## Direct answer: committed, implemented and deployed are different

- **Committed and pushed:** yes. The application changes through `922ddcc9`
  are committed; a live read-only `git ls-remote` returned that same SHA for
  GitHub `refs/heads/main`. At audit start, only `dev/README.md` and the separate
  Composer research document were modified. Their changes were preserved.
- **Full agent-experience plan implemented:** no. F/V and R1–R8 have substantial
  committed slices, but the target contracts and acceptance are incomplete.
  R2 production-runner extraction and R8's offline v1 lane are real; they do
  not establish full typed recovery, strict budgets or native whole-flow proof.
- **Enabled by default:** no. `PACKETBENCH_RUNTIME_JOURNAL=1` is still required.
  Request budgets additionally require a configured budget. Do not advertise
  those opt-in paths as universal or proven hard dollar caps.
- **Latest source deployed to the workstation:** not verified. The responding
  installed 0.14.9 executable matches the available October 23 NSIS payload,
  but no matching source/payload manifest ties it to the October 24 HEAD.
  The earlier October 19 manifest describes a different executable.
- **Fresh whole-flow/native acceptance:** not earned in this audit. No app UI,
  paid provider, build, installer, infrastructure deployment or product test
  was run. Existing archived tests retain their original scope/source identity.

## Work order — desktop/runtime completion and acceptance first

The owner's later October 24 instruction supersedes the Remote-Agents-first
order published in `4da14806`. Start [the desktop completion plan](./agent-experience/08-desktop-completion-before-remote-agents.md)
and [team dispatch](./agent-experience/05-agent-dispatch-and-acceptance.md).
The facts above retain the original audit's source/evidence limits; this
sequencing update is documentation only.

### 1. Runtime authority, recovery and spend safety

Start N1 responsiveness diagnosis alongside independent source repairs.

- Complete backend-owned initial/follow-up launch identity, immutable local/SSH
  authority and the actual prepare/start/cancel/reconcile bridge.
- Retain uncertain dispatched request liability; include all relevant input and
  budget scopes before strengthening cap claims. Default-on activation requires
  evidence, not only the single-instance prerequisite already implemented.
- Complete policy-compatible typed provider continuation, tool reconciliation,
  durable image pins and one run per root turn. Current public resume refuses
  typed recovery and only changes journal state.
- Complete production manifests, context/window policy and readout, child
  cancellation, adapter hooks/limitations and production-executor evidence.

These are residuals in [the agent-experience specification](./agent-experience/README.md),
not unstarted rewrites of all the source work already committed.

### 2. Agents flow, retained work and readability

Preserve SSH identity for contextual New; make failed starts retain drafts and
report failure; reveal approvals above review; make asset GC safe for unknown/
newer envelopes and message/submission/checkpoint references. Block unreadable
materialization and finish project-scoped drafts. Put Flight transcript
protection at the mutation boundary as well as UI. Finish native history,
search/reader continuity and IME behavior.

Complete App-scale coverage, terminal dialogs, one sidebar-width owner/reset,
remaining primary-control targets/names, narrow headers and composited contrast.
Finish the 320/480/680px and enlarged-text matrix with separate Windows/Mac
native evidence. Preserve existing Workspace CLI font/session ownership.

### 3. Existing feature hardening and integration proof

Refresh older bounded source findings against current code/owner decisions and
close applicable defects. The ledger retains provider and SDK-over-SSH parity; cooperative
Flight/inbox/YOLO integration evidence; MCP, Memory and trust/provenance proof;
dictation/headset and Monitor hardware cases; macOS packaging; and distribution
signing/updater work within the owner's existing decisions. Much is implemented
source awaiting named environment evidence. Historical unchecked matrices are
not automatically new feature requests, nor are old passes current proof.

### 4. Source-bound installed acceptance and desktop completion

Run focused tests, final integrated/full local gates and an independent whole-
flow review. Bind a final build/install manifest to chosen source and prove the
installed local/Docker Linux SSH journey: Stop/cancel, restart/resume, ambiguous
effect recovery, approval, repair, fresh review, delivery and archive/restore.
Verify retained state, shell/credentials/denials and named platform/hardware
matrices. The process responding at rest does not close N1.

Completion needs no unresolved blocking safety findings, passing applicable
gates and named native/integration evidence for the source-bound installed
payload. Unavailable account/hardware/platform cases remain open with exact
prerequisites; do not claim full acceptance from a source pass. Existing signing,
updater and distribution decisions remain in force. This documentation update
does not perform any build, installation or product test.

### 5. Remote Agents — after desktop/runtime acceptance

Resume [the Remote Agents plan](./remoteagents/README.md) and
[transport/security contracts](./remoteagents/11-transport-contract-decisions.md)
after the desktop completion gate. Keep production fail-closed while waiting.
Extend the existing `D:/projects/packetrelay` Rust service and committed identity/
ACL/audit/persistence foundation, preserving legacy protocols.

Finish replay/ACK/ticket/hello/E2EE contracts, then internal authenticated
presence, backend-owned conversations and PWA approval/reconnect. Owned product
auth/recovery, encryption, revocation, phone/push/artifacts, datastore recovery
and security/load evidence still gate external beta.

Historical Railway records and later dirty/untracked datacenter operator notes
are different evidence. Verify current infrastructure before rollout. Do not
rebuild deleted infrastructure from an old diagram.

### 6. Optional later work

Evidence-backed quota disclosure, scoped rendered-app verification and the
official supported-plan feasibility packet remain open outside the desktop
completion gate. Native iOS and other expansion follow
the PWA's evidence. Composer research/model training now belongs to the separate
[packetbench-model-lab project](https://github.com/packetloss404/packetbench-model-lab/blob/main/docs/PLAN.md),
at `D:/projects/packetbench-model-lab`, and is excluded from this completion plan.

Other documented optional/deferred concepts remain explicitly separate: Packet
Control evidence capture, paused general Computer Use, delayed Global Undo,
Monitor expansion, Windows-OpenSSH/larger-transfer work and dictation-engine
benchmarks. They do not become current implementation commitments merely by
appearing in the catalog; use the owner's existing decisions and ledger.

## Documentation rules

Use this snapshot for current facts, ROADMAP for ordering, backlog for item
status, HANDOFF for the restart action and track specs for the target design.
The catalog includes current plans, operational runbooks, dated evidence and
archives with distinct labels. Original paths are retained to preserve links
and evidence; one hub replaces competing entry points, not historical records.
The public documentation website lives in another repository and was not
changed or republished by this audit.
