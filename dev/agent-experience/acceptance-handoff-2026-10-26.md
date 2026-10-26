# Native GUI acceptance handoff — 2026-10-26

Source-completion is done through the authoritative-launch identity slice. This
document hands the remaining native GUI acceptance to a desktop-control session.
It is **not** evidence that the installed application was driven; the installers
below are verified artifacts that have not been installed or launched here.

## Source identity and flags

- Commit (frozen source): `a349ae994bced26133cb192dc79079568044e1ab` (on `main`).
- Source fingerprint: `eb6399ebfd6b13fe7b4ccf0f15f0ffcf5e6a3219d633ad889490387ed1b6bfc6` (dirty false, 1498 source files).
- Runtime journal flag: `PACKETBENCH_RUNTIME_JOURNAL` **default OFF**. The
  restart-policy identity, typed-restart seeding, crash tests and durable launch
  identity only activate when this is set; the disabled path is byte-identical
  to prior behaviour. No default-on activation is claimed.
- Version under test: `0.14.9`.

## Verified installers (built from the frozen source, not installed)

| Format | Path | SHA-256 |
| --- | --- | --- |
| NSIS | `test-results/acceptance/windows/2026-10-26T02-08-13-691Z/PacketBench_0.14.9_x64-setup.exe` | `01b2bcafc7198b1e11c9193f6014a1b457605c252ac5cc498695578a41228322` |
| MSI | `test-results/acceptance/windows/2026-10-26T02-08-13-691Z/PacketBench_0.14.9_x64_en-US.msi` | `837f27fe18a163483e47020dd2be7c722f0091cbd1fffad402fbbbf143751194` |

Verification receipt: `test-results/acceptance/payloads-e09b2ac3634c46989304c393d5d02a0b/report.json`.
Both formats: **8,683 exact payload hashes**, bundled Node `v24.15.0`,
protocol-v12 with two exact echo turns. The payload verifier does not install,
start PacketBench, run MSI install actions, or touch the user profile.

## Gate results (frozen source)

`pnpm gates:full` passed **all 12 gates** at `a349ae99`: `format:check`,
`lint:src`, `typecheck`, `test` (full Vitest), `build`, `remoteagents:check`,
`e2e`, `sidecar:check`, `rust:check`, `rust:test` (1325 Rust lib tests),
`runtime:eval`, `check:tauri-schema`.

## Disposable Docker Linux SSH fixture (source-passed)

- Evidence: `test-results/acceptance/live-ssh/2026-10-26T02-26-07-171Z`.
- Result: **15/15 PASS** (9 sidecar + 6 Workspace PTY): untrusted, trusted,
  nested-project, corrupt-trust, malformed-project, protocol-v11, invalid-ready,
  wrong-host-key, reconnect, workspace-interactive, workspace-failed-exit,
  workspace-burst, workspace-wrong-host-key, workspace-disconnect,
  workspace-reconnect.
- Image ID: `sha256:f826dd8af04678dda1b5a2e54dfbc0af16c717baa60d7481699209afae9a9618`.
- Host fingerprint (ephemeral): `SHA256:yzePwqdSu2NCGsdTK7ylHe6fVImhgtTbW2yn7a8kwJ8`.
- The runner builds an ephemeral `node:24.15.0-bookworm-slim` + OpenSSH image from
  `scripts/acceptance/ssh.Dockerfile`, binds SSH to a random loopback port,
  creates a throwaway client key + isolated HOME, and removes its container/image
  and keys in `finally`. No user SSH config, keyring, project trust or saved
  servers are modified. Reproduce with `pnpm acceptance:ssh`; it is the
  disposable pinned Linux SSH fixture, not a WAN or Windows-sshd claim.

## Independent review findings (this tranche)

The restart-recovery slice was independently reviewed. One blocking-adjacent
finding — the typed-restart seed gated on epoch alone, so a **semantic** resume
could silently upgrade to typed history — was fixed in `de0a9e32` (seed now
gates on the recorded resume mode). Remaining findings were non-blocking nits
(policy identity computed on the disabled path, swallowed checkpoint read error,
dead `account` field claim, weaker crash-test comment) and were addressed in the
same commit.

## Source work landed this tranche

- `a349ae99` — `start_api_agent_session` returns the durable run summary
  (operation/run id, epoch, phase) when the journal is enabled; the store stores
  it as a read-only `conversation.runtime` projection. This is the launcher's
  missing operation/run identity for authoritative phase reporting and
  cancel/inspect. Sidecar + disabled starts return null.
- Earlier (still unverified in the GUI): `3106f396` durable policy identity for
  typed restart; `a80af42a` typed-restart seeding; `cb9b18ff` preparation/dispatch
  crash tests; `de0a9e32` review fixes; `2dded7c7` SSH-runner module fix.

## Step-by-step installed journeys (to be run under desktop control)

Disposable local repositories only. Do not mutate a saved production SSH host.
Each journey records: launch → Stop → app/backend restart → resume →
reconciliation → approval → repair → fresh review → delivery → archive/restore.

1. **Launch** — pick a project/model/isolation mode; delay auth and worktree
   preparation; change selection explicitly and press Enter repeatedly. Assert
   ONE operation, no root-checkout fallback, no orphan writer, no lost draft,
   and that stale probe results are ignored (F4 duplicate-Start guard + the
   revision-guarded auto-pick).
2. **Stop/cancel** — Stop mid-run. Assert the turn stays active until the
   authoritative `api-agent:done {cancelled}`; a failed invoke restores the Stop
   control; there is no fixed timeout that clears a stuck `cancelling` state.
   With the journal on, assert the run reaches `cancelled`.
3. **Restart** — kill the app and relaunch. Assert the interrupted run is marked
   `needs_reconciliation` and the RuntimeRecoveryBanner offers Resume; a typed
   resume continues from the durable checkpoint and a restarted session seeds
   the typed history (not the text transcript).
4. **Reconciliation** — inject a crash after a mutation before its receipt (the
   `crash_after_mutation_before_receipt` and `crashed_intent_reconciles…`
   fixtures document the expected state). Assert no blind replay, the pending
   effect stays unresolved, and the user must inspect/acknowledge.
5. **Approval** — trigger a permission/plan/failure; assert the exact approval
   (correct host/scope) is revealed above review and the return anchor survives.
6. **Repair → fresh review → delivery → archive/restore** — run one Flight task
   through brief/start, steering/Stop, restart/continue, approval, change
   review, repair, fresh independent review, Accept/Land, archive and restore.
   Assert immutable reviewed commit/check results, target checkout, retained
   work, usage attribution and persisted history.

## Retained-state assertions

- Drafts and staged attachments survive a failed/unknown start and navigation
  away (no clear on rejection; GC never reclaims a newer/unknown/corrupt v2
  envelope).
- Images/attachments retain their durable identity across restart; a changed or
  unreadable image blocks send, never silently drops it.
- History survives restart; usage attribution and execution authority
  (local/SSH host + host-key pin) are revalidated before continuation; a changed
  host/model/policy refuses typed resume rather than substituting.

## Checklists (native evidence still required)

- **N1 responsiveness** — capture repeatable navigation/timing/process evidence
  at 8/12 panes; a responding process or a negative repro does not establish a
  causal fix.
- **Keyboard/IME** — Windows IME composition (isComposing/keyCode 229) must not
  fire Enter/Escape/arrows; history recall restores the pre-recall draft.
- **Display scale** — 320/480/680px tiles; base 13/15/22px; App scale
  100/125/150/200%; OS display scale 100/125/150% (distinct from App scale).
- **Approval/reader return** — exact approval visible/focused; returning
  restores the review anchor; search opens the exact virtualized turn.
- **Provider/SDK** — local/SSH matrix for the in-process rows and the
  `api-claude-oauth`/`api-openai-agents` sidecar rows (echo fixtures pass is not
  provider proof; real calls need the account below).
- **Monitor / dictation / hardware** — Monitor window behaviour; mic/headset
  recovery; platform-specific evidence.

## Precise prerequisites per open case

| Case | Missing prerequisite | Expected evidence |
| --- | --- | --- |
| Installed GUI journeys | A desktop-control session (no such tool in the source task) | Manual run of the journeys above with screenshots/timings |
| Real/paid provider replies | An authorized paid account + subscription | Exact provider marker, no provider error, native exit 0 |
| macOS | A Mac | Actual WebView/font/VoiceOver run; CSS/token parity is not evidence |
| Windows IME / display-scale | Interactive Windows session | Actual composition + measured dimensions |
| Microphone/headset | Hardware | Dictation capture + device recovery |

## Status summary

- **Source verified:** `a349ae99` — full gates green, independent review applied.
- **Package verified:** both installers hash-verified + payload-verified; **not installed**.
- **GUI acceptance:** **pending** — hand off to a desktop-control session using
  the journeys and checklists above. Remote Agents remains fail-closed.
