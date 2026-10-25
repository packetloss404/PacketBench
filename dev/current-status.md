# Current product and delivery status

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

## Work order — Remote Agents first

### 1. Remote Agents: next product implementation priority

Start with [the Remote Agents plan](./remoteagents/README.md) and its
[transport/security contracts](./remoteagents/11-transport-contract-decisions.md).
PacketBench's desktop gate is still fail-closed, the PWA is a Sprint 0 scaffold,
and the relay's Remote Agents routes are not a working product surface.
Committed identity/ACL/persistence substrate is not completed auth or presence.

Close replay/ACK recovery, ticket reserve/finalize and end-to-end hello/E2EE
decisions/tests, then deliver a small internal host/presence/auth slice. Build
backend-owned conversation control and PWA approval/reconnect behavior through
the narrow command protocol. Product passkey/magic-link auth, revocation,
encrypted agent/approval/file payloads, recovery/storage operations, phone UX,
push/audit/security/load evidence gate external beta. Keep the feature off until
the relevant gates pass; never expose a generic remote Tauri bridge.

Railway/PostgreSQL health statements in older plans are historical. Later local
PacketRelay operator notes describe a datacenter deployment and removal of the
old Railway resources; those notes include uncommitted files and were not live
verified here. Confirm the actual deployment/datastore before provisioning or
claiming production readiness. Do not rebuild deleted infrastructure merely
because an old diagram names it.

### 2. Desktop/runtime safety needed by that remote surface

Treat these as concrete safety dependencies or parallel repairs, not a demand
to finish every desktop cosmetic item before Remote Agents can begin:

- Complete backend-owned initial/follow-up launch identity, immutable local/SSH
  authority and the actual prepare/start/cancel/reconcile bridge.
- Retain uncertain dispatched request liability; include all relevant input and
  budget scopes before strengthening cap claims. Default-on activation requires
  evidence, not only the single-instance prerequisite already implemented.
- Complete policy-compatible typed provider continuation, tool reconciliation,
  durable image pins and one run per root turn. Current public resume refuses
  typed recovery and only changes journal state.
- Preserve SSH identity for contextual New; make failed starts retain drafts
  and report failure; reveal approvals above review; make asset GC safe for
  unknown/newer envelopes and submitted/checkpoint references.
- Put Flight transcript protection at the mutation boundary as well as UI.

These are residuals in [the agent-experience specification](./agent-experience/README.md),
not unstarted rewrites of all the source work already committed.

### 3. Finish readability, continuity and real acceptance

Complete App-scale coverage, terminal dialogs, one sidebar-width owner/reset,
remaining primary-control targets/names, narrow headers and composited contrast.
Finish the 320/480/680px and enlarged-text matrix, local/Linux SSH restart and
delivery journeys, Windows IME and separate Mac evidence. The process responding
at rest on October 24 does not close the October 19 navigation-stall observation.
Bind a final build/install manifest to the chosen source before claiming the
installed app contains it. Do not rebuild/install during a documentation audit.

### 4. Existing release/provider/feature proof

The ledger retains real-account provider and SDK-over-SSH parity; cooperative
Flight/inbox/YOLO integration evidence; MCP, Memory and trust/provenance proof;
dictation/headset and Monitor hardware cases; macOS packaging; and distribution
signing/updater work within the owner's existing decisions. Much is implemented
source awaiting named environment evidence. Historical unchecked matrices are
not automatically new feature requests, nor are old passes current proof.

### 5. Optional later work

Evidence-backed quota disclosure, scoped rendered-app verification and the
official supported-plan feasibility packet remain open. They are not needed to
begin the approved Remote Agents priority. Native iOS and other expansion follow
the PWA's evidence. Composer research/model training stays in its separate thread
and is excluded from this completion plan.

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
