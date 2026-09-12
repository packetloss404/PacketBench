# PacketBench Backlog

Last reconciled: 2026-09-08 (installer/SSH proof updates)

This is the single task register for work that has not shipped or has not yet
earned its required real/package proof. Completed implementation history belongs
in [`CHANGELOG.md`](./CHANGELOG.md); dated audits and superseded designs are
evidence, not additional backlogs.

Priority: **P1** = release blocker, real bug, or major user-facing gap;
**P2** = bounded correctness/UX work; **P3** = later enhancement or cleanup.

## Owner decisions

These are the only current product decisions blocking implementation.

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
   *More info -> Run anyway* is one click per build).

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
   2026-08-16; PacketBench continues the 0.x cadence (now 0.13.0) with no 1.0
   milestone. See
   [`docs/reports/fable5-review-2026-08-05.md`](./docs/reports/fable5-review-2026-08-05.md).

5. **OPEN 2026-08-26 - PacketCode ACP fold-in leftovers.** Three product
   calls remain after the ACP transport landed. (a) **Cost statusline.** The
   `$` segment is implemented behind `packetbench:agents:show-cost`, which
   defaults off and has no Settings toggle — so the feature is present, tested
   and unreachable. Either wire the toggle (Agents & Models -> Agent behavior)
   or delete `fmtCost`/`shouldShowCost`/`setCostDisplayEnabled`. Design review
   found the 2026-07-31 removal reason that still holds ("the dashboard was
   never used to change a decision"); the subscription-fiction reason is moot
   now every API row is BYOK. (b) **Retire the PTY-scraping packetcode
   adapter** (`src/agents/packetcode.ts`) now the structured transport is at
   parity. (c) **Archive packetcode-gui** — decide whether that means a README
   notice or archiving the GitHub repo.

   Re-verified 2026-08-27: (a) still true — `SHOW_COST_STORAGE_KEY` /
   `setCostDisplayEnabled` / `shouldShowCost` exist in
   `src/lib/usageStatusline.ts` and are consumed at
   `src/components/agents/composer/Composer.tsx:799`, but the only non-test
   caller of `setCostDisplayEnabled` is the test file, so no Settings control
   reaches it. (b) still true — `src/agents/packetcode.ts` exists and is still
   imported by `src/stores/agentStore.ts:7`. (c) **unverified from this repo**:
   packetcode-gui is a separate GitHub repository, so its archive state cannot
   be confirmed from the PacketBench tree. Treat as open until checked on
   GitHub.

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

## Remote Agents implementation

- **CLOSED 2026-09-01 - Sprint 0 foundations.** Shared protocol/PWA/workspace
  foundations, feature-gated PacketRelay skeleton, fail-off desktop flag,
  ownership map, managed PostgreSQL, and the feature-off production deployment
  are verified. Both services run in `us-west2`; live health and legacy WSS
  smoke pass; the final IaC plan is clean.
- **P1 - Sprint 1 relay and host presence. NOT STARTED.** First close the
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
  install that upgraded before the record existed reports *unknown* rather than
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
  (Folded from `docs/deferred-work.md`.)
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
the Claude CLI shell-out now has exactly two live callers,
`commands/github.rs` (`run_claude`) and `commands/insights.rs`
(`claude_command`):

- **P2 - LM 3C-3 tool-loop half.** `github_investigate_issue` and
  `ask_agent_chat_stream` remain on the Claude CLI
  (`run_claude`/`claude_command`) because they depend on its file tools: unlike
  the memory scan, they cannot know up front which files matter, so they need a
  bounded read-only tool loop parameterized on an `AuxRoute`.
  `core::tool_subagent::run_agent_loop` is most of that loop already (8
  iterations, `read_only_tool_definitions`, workspace-confined
  `tool_runtime::execute_tool`); what it lacks is `AuxRoute` parameterization
  (it derives its provider from the parent session, with a hardcoded Anthropic
  fallback) plus byte and wall-clock budgets on top of the iteration cap.
  `run_claude` cannot be deleted until then. See
  [`dev/local-model-routing.md`](./dev/local-model-routing.md).
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
[`docs/reports/fable5-review-2026-08-05.md`](./docs/reports/fable5-review-2026-08-05.md).

**This section is a review snapshot, not a task list that maintains itself.**
It was reconciled against source on 2026-08-27 and eleven findings were closed;
they are listed under *Landed since the review* at the end of this section so
nobody re-opens them. What follows is only what is still open — each entry
below was re-read in source on that date unless it says otherwise.

- **P2 - Sub-agent permission holes.** All three halves still open.
  `run_agent_loop` builds a read-only tool subset
  (`core/tool_subagent.rs:82-88`) but then dispatches straight into
  `tool_runtime::execute_tool(&call, …)` with no check that the returned call
  is in that subset (`core/tool_subagent.rs:~228`), so the allowlist is
  advisory. `spawn_subagent` is still absent from `RISKY_TOOLS`
  (`commands/api_agent.rs:2005` — `["bash", "write_file", "edit_file"]`),
  routing around DenyAll. And `execute_grep`'s `walk_dir` recurses on
  `path.is_dir()` with no `symlink_metadata` check
  (`core/tool_runtime.rs:939-941`), so `grep` still follows symlinks out of
  the workspace while `read_file`/`write_file`/`edit_file` canonicalize and
  reject them. Also still undecided: whether permission mode `Auto` should
  remain the shipped default for local `bash`.
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
- **P1 - Rehearse the Phase-3 release gates before the release window.** A
  2026-08-06 dry run against the known-good v0.10.3 artifacts already reduces
  the strict gate to exactly the two scheduled blockers — Authenticode
  credentials and updater configuration — plus a dirty tree, with no
  environmental noise. What that run could not cover is the nine quality gates
  themselves, which were skipped. Run one full `release:readiness` from a
  **Windows shell** (where Cargo is on PATH) on a quiet machine, so a release
  window is not spent distinguishing real failures from tooling artifacts.
  **The 2026-08-17 deadline this item used to carry is void** — it belonged to
  the v1.0.0 definition the owner rejected on 2026-08-16; the rehearsal is
  still wanted, it just has no date. Note also that `release:gate` has passed
  standalone but has never yet run inside a real `pnpm tauri build` — it is
  now wired into `prebundle` (`package.json:44`), so the next real build is
  that first run.
- **P1 - Release gates report false failures when run from WSL.** Three
  independent traps, all confirmed on this machine, all of which would burn
  time during the release window: `hostTarget()` reads `os.platform()`, so WSL
  reports `linux` and the script demands Linux bundles for a Windows-only
  release (fixed — `PACKETBENCH_RELEASE_TARGET` is now validated and its
  provenance is printed); `cargo` is not on the WSL path, so `rust:check`,
  `rust:test`, and `check:tauri-schema` fail with `cargo: not found`; and the
  bundle-root lookup used to fall through to `src-tauri/target` whenever
  `cargo metadata` could not run — the same missing-Cargo cause — so readiness
  reported missing artifacts for a release that had built correctly (fixed:
  the root now resolves from `CARGO_TARGET_DIR`, then `.cargo/config.toml`,
  then `cargo metadata`, translating Windows paths under WSL, and prints its
  provenance). The remaining item is the Rust gates: run release gates from
  the Windows shell, or put the MSVC toolchain on the WSL path. See
  `dev/local-quality-gates.md`.
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
  Overlaps the Fable 5 *Dead code and hygiene* P3 — resolve them together.
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
  staleness of the memo is tracked as its own P3 under *Three-track build-out
  residue*; do not re-open this item for it.
- **LANDED 2026-08-26 - Custom OpenAI-compatible provider.** Shipped as the
  `api-custom` row (`src/lib/api-models.ts:189`) backed by
  `src-tauri/src/core/llm_custom_compat.rs`, and documented in `CLAUDE.md`'s
  nine-row provider table.
- **P2 - Finish auxiliary-task routing.** Move remaining Memory, Insights,
  Spec, and GitHub auxiliary calls onto `core/aux_llm.rs`; add task-class
  provider/model settings without reviving the removed Cost Dashboard.
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
  `docs/deferred-work.md`.)
- **P3 - Cross-provider reasoning effort.** Expose a reasoning-effort control
  instead of the hardcoded 8000-token thinking budget in `api_agent.rs` /
  `llm_anthropic.rs`. (Folded from `docs/deferred-work.md`.)
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
  trap earlier and is tracked separately under *Main shell and daily-driver
  polish*. Patching 92 files is the wrong fix: sweep `tauri.ts` for the
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
  of *real* queries that are surface-anchor-free, and it cannot be obtained from
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
  stayed with PacketBench (`D:\projects\packetrelay`, deploying to Railway).
  The boundary that closed is the Syndicate *execution target*, not the relay.

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
- Current audit summary: [`docs/reports/state-of-the-ade-2026-07-30.md`](./docs/reports/state-of-the-ade-2026-07-30.md), Section 0
- Current release record: [`dev/release-v0.10.3.md`](./dev/release-v0.10.3.md)
- Remote Agents: [`dev/remoteagents/README.md`](./dev/remoteagents/README.md)
- Syndicate execution target (removed 2026-08-27; historical): [`dev/archive/syndicate/syndicate-execution-target.md`](./dev/archive/syndicate/syndicate-execution-target.md)
- Main shell: [`dev/main-shell-navigation-and-right-panel-audit-2026-07-29.md`](./dev/main-shell-navigation-and-right-panel-audit-2026-07-29.md)
- Workspace/Agents: [`dev/workspace-agents-restructuring-goal.md`](./dev/workspace-agents-restructuring-goal.md)
- Settings: [`dev/workspace-agent-settings-decision-2026-07-29.md`](./dev/workspace-agent-settings-decision-2026-07-29.md)
- Packaged/external proof: [`dev/proof-audit-2026-08-01.md`](./dev/proof-audit-2026-08-01.md)
