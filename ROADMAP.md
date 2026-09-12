# PacketBench Roadmap

Last reconciled: 2026-09-11

PacketBench is a local-first Agent Development Environment and remains the
flagship control surface. The desktop owns local providers, models, secrets,
Workspaces, MCP configuration, permissions, Memory, and execution.

**Workspaces remain the primary daily working surface.** Prioritize reliable
local/SSH CLI panes, keyboard focus, session recovery, saved arrangements and
multi-pane performance. Agents, Flight Deck and Monitor support that workflow.

There is no shipped remote supervision surface today. Syndicate separated from
the Packet\* product family on 2026-08-27 and its execution-target integration
was removed (`CHANGELOG.md` [Unreleased]), which leaves generic SSH — remote
Workspaces, PTY panes, and agent file/bash tools over a pinned connection — as
the only way to reach another machine. Remote Agents, unpaused 2026-08-27, is
the program that builds a supervision surface. The rule it has to satisfy is
therefore forward-looking rather than descriptive: phone and cloud surfaces
will supervise the authority the desktop already holds; they will not replace
it.

The detailed task ledger is [`backlog.md`](./backlog.md). This file contains
only product direction and ordering.

## Current baseline

- **0.14.6 is built and installed**, with Workspace reliability, shared pane
  controls and readable many-pane layouts. Native eight-column restart and
  file-pane selection/zoom cleanup passed; all 8,683 payload hashes matched,
  bundled sidecar passed two turns, and real OpenSSH passed 15/15. Exact scope:
  `dev/workspace-usability-evidence-2026-09-11.md`. The earlier **0.14.3** included both Monitor lifecycle corrections,
  8,683 verified payload hashes and native shutdown/close-confirmation proof
  (`dev/gui-provider-evidence-2026-09-08.md`). The earlier 0.14.1 real OpenSSH
  handshake/project-trust acceptance passed 9/9
  (`dev/installer-ssh-evidence-2026-09-08.md`). The prior **0.14.0** bundles were built
  2026-09-05 from `cd276627`, hashed in
  `CHANGELOG.md`, and installed (`package.json`, `src-tauri/tauri.conf.json`,
  `src-tauri/Cargo.toml`). `v0.10.3` — packaged for Windows from release source
  `61e0669` — is still the newest annotated tag, while `CHANGELOG.md` records
  0.10.4 and 0.10.5 as released, and 0.11.0 through 0.13.2 as built but
  unreleased.
- **The renamed product has been packaged and installed.** The prior
  0.14.0 baseline was installed and MCP-smoke-tested on 2026-09-05 (6/7; the
  Flight case lacked a Flight). Later local verification installs have the
  same version string; their source commits/hashes are in `CHANGELOG.md`.
  The 2026-08-26
  rename moved the Tauri bundle identifier from `com.packetade.desktop` to
  `com.packetbench.desktop` along with the product name. Section 1 of the
  acceptance matrix ran from source on 2026-08-28 and found **two migration
  defects** — the data-dir veto (fixed in `544e4cc6`, verified against a copy of
  a real legacy dir) and localStorage across a bundle-identifier change. The
  second was **accepted on 2026-08-29** as a documented one-time consequence of
  the rename rather than a defect to fix, and its **recurrence was prevented on
  2026-09-04**: `packetbench:*` writes are now mirrored to `~/.packetbench/` and
  restored before any store hydrates, so the next origin change cannot empty the
  app. The packetade-era keys stranded in the old WebView2 profile are still
  stranded — nothing reads that profile, by decision. Both entries are in
  `backlog.md`. Packaged installation evidence does not complete the remaining
  microphone, Monitor, provider, Flight and live SSH acceptance matrices.
- Workspace/Agents restructuring is complete: Workspaces are
  CLI/PacketCode-first; Agents owns first-class same-window GUI conversations;
  new Workspace conversation attachments are retired; saved panes remain
  compatible.
- The six-group Settings information architecture and its P1 authority/security
  corrections are complete.
- Flight Deck Option B, Flight supervision source, PacketCode integration,
  PacketAgent W9 consumer source, Project Memory, local-first MCP Hub,
  Dictation hardening, trust/provenance, Issue-to-Flight mirroring, and Monitor
  v1 are implemented.
- Selectable local Terminal shells and the self-bootstrapping Claude Code native
  status bar ship in v0.10.3.
- The 30 low-rated Reliability findings are closed.
- Closed record, not current capability: the first-class Syndicate execution
  target (scoped device pairing/revocation, Host-owned Workspaces, durable
  remote CLI panes, managed pinned-SSH bootstrap, encrypted PacketRelay
  transport) was implemented, reviewed, and then removed on 2026-08-27 when
  Syndicate separated from the Packet\* family. PacketBench ships none of it
  today; what survives is two tolerant deserializers
  (`src-tauri/src/core/workspace.rs:88`, `src/types/workspace.ts:108`) that
  degrade a persisted `syndicate` execution target to `None` instead of failing
  the state file. The pre-removal implementation is at `d87fb125`; the
  controller protocol continues in Syndicate's own repos.
- PacketRelay — the standalone Rust relay at `D:\projects\packetrelay` — now
  belongs to PacketBench (owner decision, 2026-08-27). It is no longer shared
  with or owned by Syndicate. The inherited `/v1/product-route` and Cloud Run
  deployment path were removed on 2026-08-28, and the service is live on
  **Railway**.

The remaining bottleneck is broader packaged/provider/hardware acceptance.
The consolidation's 0.14.1 NSIS upgrade and real OpenSSH handshake/project-trust
checks passed on September 8. The broader follow-up verified local Ollama turns,
found and corrected Monitor lifecycle defects in 0.14.3, and recorded specific
API-quota/key and zero-audio-frame blockers. See `HANDOFF.md` for current
protocol requirements and `CHANGELOG.md` for precise installed-build evidence.

## Now

| Track                       | Priority | Current state                                                                                                                                                                                                                                                                                                       | Next action                                                                                                                                                                                                                                                |
| --------------------------- | -------: | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Workspace daily workflow    |       P1 | Installed 0.14.6 adds shared pane controls and Readable/Fit all/Balance sizes. Native eight-column restart, selected file closure, four browser checks and 15 real OpenSSH cases pass. The 0.14.7 source separates viewer badges and passes isolated native WebView2 profiling (eight panes, cold/warm p95 16.8 ms) | Extend packaged live-PTY and GUI-to-SSH recovery coverage. Paid Claude reply testing is deferred at the user's request pending subscription renewal. Evidence: `dev/workspace-release-0.14.7.md`; outstanding work: `backlog.md`                           |
| Packaged Windows acceptance |       P1 | 0.14.1 NSIS upgrade, 8,683 payload hashes, packaged v12 echo runtime and normal startup passed; real Linux OpenSSH handshake/trust matrix 9/9. Exact scope/hashes: `dev/installer-ssh-evidence-2026-09-08.md`. Historical interactive evidence remains version-specific.                                            | Run the outstanding hardware, Monitor, Flight and paid-provider/GUI SSH matrices. Do not transfer old checkmarks to new binaries without verification.                                                                                                     |
| Distribution trust          |       P1 | **DEFERRED ON COST 2026-08-27** — owner decision to spend nothing on signing for now; v0.10.3 reported 0 failures / 6 readiness warnings and all artifacts remain unsigned                                                                                                                                          | Keep shipping unsigned local builds. On the stated trigger — the first build handed to anyone who is not the owner — take the cheapest path (Azure Trusted Signing, ~$10/month), then wire hosted CI, notarization, and the updater. Terms in `backlog.md` |
| macOS release               |       P1 | Builds, bundles a DMG, and runs from source on real hardware; never signed, notarized, or interactively accepted                                                                                                                                                                                                    | Run the unsigned acceptance matrix; start Apple Developer Program enrollment when v1.1 starts rather than now (deferred alongside signing on 2026-08-27); ship arm64 DMG in v1.1 (`dev/macos-release-plan.md`)                                             |
| Remote Agents               |       P1 | **ACTIVE; Sprint 0 complete 2026-09-01.** The feature-off deployment is healthy, managed PostgreSQL is live privately, and the final IaC plan is clean. Remote Agents remains disabled/fail-closed; Sprint 1 and product auth are not started                                                                       | Close the replay/ACK/ticket/hello/E2EE security gates, then implement the accepted Sprint 1 host-presence slice. Keep PostgreSQL PITR + scheduled backups + offsite restore drill as external-beta gates                                                   |
| Global Undo                 |       P1 | Confirmations and cleanup are implemented; no recovery path                                                                                                                                                                                                                                                         | Decided 2026-08-16: time-boxed delayed-delete toast (soft-delete declined); implementation not yet scheduled                                                                                                                                               |
| Flight supervision proof    |       P1 | Reviewer/graph/inbox/YOLO source complete                                                                                                                                                                                                                                                                           | Run packaged local and disposable pinned-SSH matrices                                                                                                                                                                                                      |
| PacketAgent handoff proof   |       P1 | W9 consumer source and fixtures pass                                                                                                                                                                                                                                                                                | Run separately hosted close/relaunch/reconnect and evidence-return matrix                                                                                                                                                                                  |
| PacketCode release proof    |       P1 | Source integration and doctor contract pass                                                                                                                                                                                                                                                                         | Publish signed artifacts; run clean-machine upgrade/rollback and compatibility smoke                                                                                                                                                                       |
| Dictation proof             |       P1 | DV1-DV16 source complete                                                                                                                                                                                                                                                                                            | Run real microphone plus macOS/Linux package matrices                                                                                                                                                                                                      |
| Settings/MS4 cleanup        |       P2 | P1 correctness is complete                                                                                                                                                                                                                                                                                          | Stable IDs/active identity/profile validation, diagnostics, ARIA, labels, and responsive overflow                                                                                                                                                          |
| Git/Memory/MCP/Trust proof  |       P2 | Source implementations pass                                                                                                                                                                                                                                                                                         | Run real GitHub/Gitea, editor-watch, provider, MCP, SSH, restart, and visual matrices                                                                                                                                                                      |
| Terminal shell proof        |       P2 | Source, package compile, detection, and command probes pass                                                                                                                                                                                                                                                         | Run interactive pane, persistence, unavailable-profile, CLI, and SSH matrix                                                                                                                                                                                |
| Monitor proof               |       P2 | Lifecycle corrections installed in 0.14.3; native opening, projection and shutdown checks passed                                                                                                                                                                                                                    | Run remaining stale-entity, Flight, responsive/keyboard and Rust-denial integration cases                                                                                                                                                                  |

## Next

After the immediately available proof gates:

1. Implement the chosen Undo scope.
2. Close bounded Settings and main-shell MS4 work.
3. Finish Ollama capability-aware selection, auxiliary-task routing, retired
   conversation provider switching, and edit/diff honesty.
4. Remote Agents: Sprint 0 is complete. Close the replay/ACK recovery, ticket
   reserve/finalize, and endpoint-to-endpoint hello/E2EE security gates, then execute the approved
   Sprint 1 host-presence slice while Remote Agents remains disabled and
   fail-closed. Product passkey/magic-link auth is resolved in direction but not
   implemented; auth review and database durability remain external-beta gates
   ([`dev/remoteagents/README.md`](./dev/remoteagents/README.md)).
5. Land a private PWA/relay alpha with desktop-owned execution, narrow audited
   commands, device trust, reconnect/replay, approvals, and attention push.
6. When the signing deferral's trigger fires, acquire distribution credentials
   and publish signed, updateable builds: Windows Authenticode first, then the
   signed and notarized macOS arm64 DMG for v1.1 per
   [`dev/macos-release-plan.md`](./dev/macos-release-plan.md).

## Later

- Packet Control: deterministic, user-initiated local/SSH evidence capture
  using one contract shared with PacketAgent.
- Monitor expansion: Approval/Cost routes, saved bounds, multiple windows, and
  PTY attachment only after ownership is safe.
- Detachable interactive Agent windows after a single-writer state contract.
- Native iOS/TestFlight after the Remote Agents PWA proves useful.
- Additional Gitea authoring/checks parity, semantic Memory retrieval when
  measured misses justify it, and alternate Dictation engines after real
  benchmarks.
- Linux packaging proof, macOS x86_64 alongside arm64, and Snap/Flatpak when
  distribution demand warrants them.

## Remote Agents v1 boundary

The first Remote Agents release is a PWA supervision surface through Packet
Cloud and PacketRelay, the standalone Rust relay at `D:\projects\packetrelay`
— PacketBench-owned since 2026-08-27 and deploying to Railway:

- Packet account sign-in and desktop device trust
- configured hosts, Workspaces, providers, models, profiles, and conversations
- start/continue API-agent conversations and stream `api-agent:*`
- permission/edit approval, cancel/retry/model changes, reconnect, and push
- encrypted sensitive payloads before external beta

Provider secrets, MCP servers, files, shells, tools, and execution stay on the
desktop. No generic remote Tauri bridge, raw PTY control, or cloud-side provider
execution belongs in v1.

Account sign-in is built into the Rust relay: passkey and magic-link auth backed
by PostgreSQL. The owned WebAuthn, session, delivery, recovery, rate-limiting,
and enumeration-resistance surface requires a security review before external
beta.

## Architectural debt worth retaining

- Mid-session MCP hot-swap is unsupported; trust/config changes apply on next
  session start.
- `historyStore`, `projectHistoryStore`, and `promptStore` may overlap; perform
  consolidation only when a product change gives it a clear owner.
- `flightStore` owns persisted Flight CRUD; `asyncFlightStore` owns runtime
  attempts. Do not collapse them casually.
- Persisted Mission/Planner/retired-provider aliases, and the tolerant
  `syndicate` execution-target deserializers, remain read-only compatibility
  until their documented release-age gates are met.

## Release path

1. Continue interactive acceptance of the installed 0.14.1 consolidation
   package. Its installer/payload and real OpenSSH protocol/trust checks are
   complete; preserve their scope and the older version-specific evidence.
2. Close available real-host, microphone, provider, MCP, and cross-product
   evidence gates.
3. Resolve and implement Undo plus bounded Settings/MS4 work.
4. Remote Agents: implement Sprint 1 host presence on PacketRelay while the
   production feature remains disabled/fail-closed. See
   `dev/remoteagents/README.md`.
5. Add hosted CI, signing, notarization, and updater infrastructure once the
   signing deferral's trigger fires.
6. Expand E2E coverage across session creation, API-agent launch, Remote Agents
   approvals, and Flight attempt lifecycle.
