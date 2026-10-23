# PacketBench Handoff

Last reconciled: 2026-10-19 (Flight closeout; later review and implementation handoff prepared, Composer research separate; native responsiveness unresolved)

This is the current restart document. Use `backlog.md` for outstanding work,
`ROADMAP.md` for ordering, and `CHANGELOG.md` for shipped/build history.
`docs/handoff.md` and `docs/audit-2026-09-04.md` describe the September audit;
the current contracts below supersede their older protocol and queue details.

## Future-team implementation handoff — October 19, 2026

The owner requested further team research/design and documentation for agents
to implement later. Start at [dev/agent-experience/README.md](dev/agent-experience/README.md).
The package specifies shared contracts and sequencing, runtime safety, Agents
flow, appearance/accessibility, bounded integrations, file leases, migrations,
fault tests, native evidence and ready-to-use coordinator/worker prompts.
The backlog remains the only task/status register. The plan is a proposed
technical handoff; it does not claim application changes or passing new gates.

**Composer research is moved to another thread and excluded.** Current-runtime
evaluation verifies existing behavior; do not expand it into model training,
adaptation or a competitor-agent product. Optional supported-plan/browser
experiments are later bounded packets, not prerequisites for core repairs.

Key choices: one local backend journal for launch/run/effect/checkpoint/budget
authority, one immutable execution binding per root turn, preserved drafts and
history, and one App scale multiplier for all nonterminal fonts. Terminal size
gets a separate proposed preference/control; source did not establish one
already shipped. The future team must refresh the baseline before implementing.
This planning pass performed no desktop control, provider calls, product tests,
builds, installation, commits or pushes. The later native hang remains unresolved.

**Implementation status (uncommitted working tree).** A Wave 0 source inventory
and a read-only review of tracks 01–04 were completed against `e5d31084`;
rusqlite and the other cited seams exist, while the docs contain a few stale
line claims and unresolved cross-track conflicts recorded in the review notes.
The P1 F1 slice landed: worktree provisioning failure is fail-closed (no agent,
no conversation, no root fallback) and the draft plus staged images survive for
Retry or an explicit Local launch. F2A followed: staged images are scoped per
conversation/launch draft in memory, late decodes are generation-fenced, and
type/size/read rejections are visible with a session-only disclosure. Text
persistence is unchanged. F8 landed next: IME composition now suppresses
composer shortcuts, history recall restores the pre-recall draft, and a
deliberate edit after recall is not overwritten. F3 core followed: Edit & fork
creates a real child with lineage and leaves the parent intact; Rewind saves a
read-only transcript revision, changes no files and starts no turn; parent
deletion retains a checkout still referenced by a fork. F4 core followed: late
auth probes no longer overwrite explicit provider/model/profile choices, and a
slow launch no longer steals conversation selection; single-flight holds through
settlement. F2B core landed: a backend draft-asset service (stage/read/release/
gc) persists image bytes in app-data with type/size/digest validation, the
frontend keeps only metadata refs in a versioned v2 envelope and re-reads
previews after restart, and the legacy v1 text map still migrates. F5 core
followed: worktree and root conversations group under their base project,
two repositories on one SSH host are labelled repo @ server, and New opens
against the selected conversation's base project. Review fixes: draft-asset
I/O runs on a blocking worker thread, and discard/archive cleanup now retains a
checkout that a live fork still references. The review's medium findings were
then closed: image type is sniffed from content, forks keep the parent's frozen
MCP authority, a newer draft envelope is never downgraded, orphan draft assets
are reclaimed at startup, per-draft staging is capped at 20 MiB, missing images
block sending with a visible reason, and lineage records source/rewind
revisions. Flight-owned mutation
gating, old message-link resolution, submission/checkpoint pins,
scheduled GC/capacity, H2 typed-image replay, native restart evidence and the
F4 phase surface remain open. Focused Vitest, Rust unit tests, TypeScript and
ESLint pass. No build or installation was run and native Windows acceptance
(including real IME confirmation and paste/drop restart) remains open.

## Later agent and experience review — October 19, 2026

The owner requested research, a subagent runtime/GUI/UX review, live Windows
inspection and documentation. This follow-up changes documentation only.
The [review](dev/agent-harness-and-experience-review-2026-10-19.md) records
verified Cursor acquisition/weekly-plan changes, newly documented official
ChatGPT-plan integration options, Composer feasibility and prioritized findings.
No app implementation, credentials, build or installation changed.

**New unresolved P1 observation:** installed PID 60916 showed the Flight Deck,
then an automated Agents navigation click timed out. A subsequent capture
showed `PacketBench (Not Responding)` and read-only process checks returned
`Responding=False`. App versus accessibility/native-interaction cause is not
isolated. The app was not killed/restarted and no agent prompt was sent;
desktop control was reset/released after each short burst. This supersedes an
unqualified current readiness claim, not the earlier passing Flight evidence.
Diagnose responsiveness before treating the app as a verified daily driver.

Source review also identifies Agents worktree fallback, unscoped attachment
staging and misleading fork/restore behavior. These are separate from the
completed Flight repairs. Typography defaults need size/contrast/scale work;
Mac visual parity remains unverified. Open work is consolidated in `backlog.md`.
Implementation recommendations require a subsequent execution request.

## Workstation dogfood handoff — October 19, 2026

The Flight overhaul is installed as a local **0.14.9** rebuild. Its exact source
snapshot was subsequently committed as `0b6dbf52d2f32fadf190e9b8f88e1c56941a8f2b`:
the committed tree's source fingerprint matches the installer manifest. The
documentation closeout changes no application inputs, so another compilation or
installation is unnecessary. No new version tag or public installer release is
created by this handoff. The October 6 `v0.14.9` tag remains the published baseline.

- Installed executable: `%LOCALAPPDATA%/PacketBench/packetbench.exe`, SHA-256
  `6a69c35cbbdca49d1b09b5076ceb70bd9ad3b86996a2ac2464965e53b2dc55cb`.
  NSIS exited 0; **8,683 installed files** match the canonical manifest. Bundled
  Node **24.15.0** and two protocol-**12** sidecar turns passed. Both NSIS and MSI
  were built; installation was exercised through NSIS.
- Disposable local and pinned Docker Linux SSH Flights completed Stop during a
  tool command, restart/Resume, independent changes-requested review, repair,
  fresh passing review, Accept, Land and archive/restore/rearchive. Independent
  tests pass 4/4 on each delivered main tree and immutable reviewed commit.
  File/index preservation, review identity and builder/reviewer usage agree.
- Final gates: **1,118 native tests**, **3,138 frontend tests in 312 files**,
  **18 Chromium cases**, Rust check, schema parity, formatting, lint, typecheck,
  production frontend build and explicit sidecar checks passed. Ten native tests
  remain intentionally ignored in the normal suite; the separate live-fixture
  SSH run passed seven focused tests, including actual bash cancellation.
- The installed app opened normally and showed the archived local delivery,
  passing review and Restore action. Persisted local/SSH delivery, review owners,
  usage and all nine project-history entries survived. The full paid walkthrough
  ran in native debug builds; the final installer received payload, sidecar,
  UI and persisted-state smoke verification. These scopes are not interchangeable.
- Cleanup: all three test Flights are archived and hidden from the active list;
  retained branches/worktrees and verified Git bundles remain as evidence. The
  owned Docker SSH container is stopped, development servers are closed, and
  desktop control is released. The installed app is open on `D:/projects/PacketBench`.
  Existing user projects and provider choices remain available.

For the next real task, use one agent in **Assisted** mode: enter the objective
and acceptance checks, run, inspect the changes/checks/review, send findings for
repair when needed, then request a fresh reviewer pass. **Accept** prepares the
result; **Land** performs delivery. Archive after delivery. Stop retains work;
Continue preserved work creates a new owner in the same worktree. Record any
failure's steps, target, expected/actual result and installed hash in `backlog.md`.

The broader provider/WAN/cooperative/PR, role-by-role Stop and adoption matrices
remain open. Sugar's positive token totals have no configured USD rate; the
zero-dollar ledger does not establish free usage or verified billing.
Built-in SSH bash execution requires remote `setsid`; a missing prerequisite
fails with an explicit error. The live Flight matrix covers Linux SSH.

Durable scope and results: [Flight overhaul evidence](dev/flight-overhaul-review-2026-10-19.md).
Ignored workstation evidence is under `test-results/acceptance/flight-native-2026-10-19/`.
The canonical manifest and installation report are under
`test-results/acceptance/windows/2026-10-20T01-56-47-983Z/` (UTC artifact date).
`installer-update.json`, `installed-state-proof.json`, `installed-app-boot-history-proof.json`
and `installed-source-commit.json` link the installed payload to its checks.

## Sugar default activation — October 15, 2026

The owner authorized testing Sugar and making it the default if it worked.
The existing OpenCode Sugar API key was reused and saved in PacketBench's OS
credential store. No raw key was printed or written to an ordinary file, and
no Sugar server, upstream credentials, account limits or billing settings were changed.

Sugar passed authenticated discovery (six models), streaming text, follow-up
memory, a structured tool call, a synthetic local-file read and tool-result
follow-up through PacketBench's actual native `NamedProvider` / Chat Completions
adapter. The guarded live test completed in 12.58 seconds. It is ignored by
normal test runs and requires `PACKETBENCH_LIVE_SUGAR_TEST=1` plus an explicit
`cargo test --lib sugar_live_packetbench_acceptance -- --ignored --nocapture`.

The local rebuilt 0.14.9 is installed with executable SHA-256
`186f4ada0d437750b92f04d1d027e4a805de643f60ea0e4562f983c24a315890`. This is a local rebuild of the working tree, not a new tagged
or published release. This source state is saved as a local Git checkpoint;
no new tag or public release was created.

- New API chats prefer Sugar when connected, using its stable `sugar/conduit`
  alias. Other connected providers remain available. Provider-scoped launches
  and existing conversations retain their explicit choices.
- New Flight targets, workflow-role defaults and automatic API executor
  fallback use Sugar/Conduit. Saved workflow pins remain authoritative.
- This user's seven workflow roles and all fifteen auxiliary task
  routes are saved on Sugar/Conduit. Auxiliary Auto still means cheapest
  configured; these are explicit owner-authorized local pins.
- `issue-investigate` and Insights `agent-chat` now resolve their own auxiliary
  route and use native read-only project research. Settings → Automation →
  Task Role Defaults → Auxiliary AI tasks controls both provider and model.
  The Insights row offers **Open Insights chat** (the former UI had no caller).
  Its scoped stream supports history, Stop, and cancellation on close; the
  modal explicitly clears its chat when closed. Existing terminal CLI choices
  and the independent cooperative reviewer/scout policy remain separate.

Validation for the research follow-up: 53 unique focused frontend/routing
checks, 63 auxiliary/Insights Rust unit tests, TypeScript, changed-file ESLint,
production frontend build, live native Sugar research acceptance (33.61s), and
all 11 prebundle checks passed. The earlier provider-only live acceptance also
passed. Installer payload and installed executable hashes match.
The installed GUI also passed: a fresh launch selected Sugar/Conduit without
manual provider selection, `read_file` read `sugar-provider-check.txt` and the
model returned its exact marker, then answered the follow-up with `MARBLE`.
Saved conversation: `conv_1792103492573_024j0pqz`. The unrelated firewall prompt
was cleared by the owner. The broader Workspace acceptance matrix remains open.

Sanitized evidence: `D:/projects/context/output/packetbench-check-2026-10-15/sugar-native.json`, `sugar-gui.json`,
`sugar-installation.json` and `sugar.json`. The prior installer is retained there as
`PacketBench-before-sugar-setup.exe`; prior routing entries are in
`settings-before-sugar.json`.

## Project research migration — October 15, 2026

`core::aux_research` supplies the two routed project-aware features with only
`read_file`, `list_directory`, and literal `search_files`. It enforces project
root confinement, rejects traversal, linked/reparse, hidden, generated and
sensitive-name paths, and bounds reads, results, transcript size, steps and
wall time (8 rounds, 24 calls, 3 minutes). It replays opaque provider reasoning,
requires stream completion, meters each completed model turn, shares the
auxiliary provider queue, and aborts HTTP tasks on timeout/cancellation.

Live Sugar tests read a synthetic marker, preserved chat follow-up memory,
and diagnosed the `items.length` bug in a sample cart function. The real
`research_issue` helper was exercised; no GitHub issue was posted. PacketBench's
GitHub repository contained no existing issues for an end-to-end remote-issue
smoke test. The installed Insights modal also returned the file marker and
remembered MARBLE; both saved routes survived the app reinstall.

Current sanitized evidence: `sugar-research.json`, `sugar-research-settings.json`
and `sugar-research-installation.json` in the evidence directory above. The
immediately preceding installer is `PacketBench-before-insights-sugar-setup.exe`.
Older provider-only acceptance records remain historical.

## Initial provider checks — October 15, 2026

The following baseline predates the Sugar activation above.

Installed Windows 0.14.9 matches the October 6 executable hash
`6cad2558305b41457dc22c50230e90f24a19872b01af57f42bc2e36165cf9db0`.
The app was not running. These checks used the saved provider configuration
and credentials directly, plus the installed Node sidecar; native GUI/Workspace
acceptance and paid SDK inference are not implied.

- Local Ollama `qwen3.5:4b` passed a response, follow-up memory, structured
  function call, tool-result follow-up and NDJSON streaming. A separate stream
  using the native request shape, with no thinking override, completed normally
  with 247 output tokens. Initial cold loading exceeded a 90-second test limit;
  a later run with a longer loading allowance passed. No persistent runtime
  options were changed.
- `qwen2.5-coder:7b` passed text and follow-up memory. Its one tool-call attempt
  did not return the expected structured call. Ollama reports tool capability,
  so this is not classified as an unsupported model or an app regression.
- MiniMax is the only saved cloud key. Both `MiniMax-M2` and `MiniMax-M3`
  returned HTTP 402, `insufficient balance (1008)`. This supersedes the older
  429/quota observation. No top-up, credential replacement or retry loop ran.
- OpenAI and the other cloud API rows have no saved keys in this installation.
  Paid Claude testing remains deferred. Codex CLI 0.160.1 reports logged in
  using ChatGPT; that status check did not exercise CLI inference.
- The installed protocol-12 sidecar passed two isolated echo turns. No API
  provider or global MCP server was started by that echo test.

No persisted task/aux routing overrides were found. Shipped task routing still
uses `claude-code`; automatic auxiliary routing selects the sole keyed provider,
MiniMax. Choosing an active CLI default and a working auxiliary route is the
next configuration decision. No routing, keyring or project state was changed.
Sanitized evidence: `D:/projects/context/output/packetbench-check-2026-10-15/summary.json`.

## Checkout and artifacts

- **Published baseline:** the original 0.14.9 was built and installed October 6. Source/tag target is
  `83bd31251ef3069c283b310b1f809f393715774f`; annotated tag `v0.14.9` identifies
  the exact build source. Main also contains the subsequent evidence record.
  See `dev/provider-release-0.14.9.md` for peer review, hashes and installation.
- Sugar, ClinePass, OpenCode Go, Ollama Cloud, Google Gemini and xAI are now
  configurable API providers, with live catalogs including direct
  Anthropic/OpenAI. All three peer-review findings were fixed and all eleven
  quality-gate categories passed. Configuration: `dev/provider-integrations-2026-10-06.md`.
- The desktop upgrade from 0.14.8 exited 0, verified all 8,683 manifest payload
  hashes and passed two bundled-sidecar turns. A responding application window
  was observed. Real-account provider testing and interactive Workspace
  dogfooding remain; startup alone does not establish those. Workspaces remain
  the primary product focus. Paid Claude testing stays deferred on cost.
- Working directory: `D:\projects\PacketBench`.
- Remote: `git@github.com:packetloss404/PacketBench.git`.
- **0.14.7 is built and pushed to main** (2026-09-12), from clean code commit
  `4443c8b0`. Viewer/Fleet summaries, missing-conversation zoom and concurrent
  Monitor opens are corrected. Eleven full quality gates, fifteen disposable
  OpenSSH cases and both Windows installer builds passed. Native WebView2
  profiling measured eight-pane cold/warm p95 frame intervals of 16.8 ms.
  Exact hashes and scope: `dev/workspace-release-0.14.7.md`. Installation was
  outside that build request; 0.14.6 remained installed at that time. Paid
  Claude testing is deferred at the user's request because of subscription
  cost; do not request a login refresh or retry without new direction.
- This consolidation started on clean `main` at `7019094b`, matching
  `origin/main`. The old `feat/quality-gates-pty-outcomes-durable-state`
  handoff is obsolete: `f7200bfb` is already part of main. Use `git status`
  and `git log` for the current working state, not this document's snapshot.
- **0.14.6 is built and installed** (2026-09-11): shared pane controls,
  Readable/Fit all/Balance sizes, pane navigation and selection cleanup passed
  native eight-pane and file-viewer checks. Eight columns survive normal restart.
  NSIS exit 0, 8,683 payload hashes, two bundled-sidecar turns, four real-xterm
  browser checks and the 15/15 real OpenSSH matrix passed. High-output rendering
  still has measured pauses. Exact scope and hashes:
  `dev/workspace-usability-evidence-2026-09-11.md`. Earlier raw acceptance files
  were cleared by Playwright's old output default; tracked reports survived.
  Browser output is now isolated in `test-results/playwright`.
- The earlier **0.14.5** build/install (2026-09-11) added Workspace focus/navigation,
  failed-send recovery, restore corrections and resize/output batching are
  included. Native testing found and fixed an additional unsaved pane-add
  layout; four added columns now survive restart. NSIS exit 0, all 8,683
  installed hashes and bundled two-turn sidecar smoke passed. Exact identity,
  tests and native scope: `dev/workspace-evidence-2026-09-11.md`.
- The earlier **0.14.3** install (2026-09-08) included both Monitor lifecycle fixes
  and accessible window controls are included. NSIS exit 0, 8,683 installed
  hashes and bundled two-turn sidecar smoke passed. Native opening, rendering,
  idle/confirmed shutdown and cancelling active-work shutdown passed; current GUI/provider/hardware scope and
  artifact identity are in `dev/gui-provider-evidence-2026-09-08.md`.
- The earlier **0.14.1** run passed NSIS exit 0, 8,683 installed
  payload hashes matched, bundled protocol-v12 sidecar completed two turns,
  and normal app startup passed. Installer/source hashes and the real OpenSSH
  9/9 run are in `dev/installer-ssh-evidence-2026-09-08.md`.
  The prior recorded artifact baseline is
  the unsigned Windows pair built from `cd276627` on 2026-09-05; exact hashes
  live in `CHANGELOG.md`. It was installed and its live MCP smoke passed
  6/7; the Flight-dependent case did not run because no Flight existed.
- Subsequent local verification installs also report 0.14.0 but contain
  different source. The latest recorded one is `087fc57c`; its executable
  hash is in the historical `CHANGELOG.md` verification-build record. Do not
  identify a binary by version alone.
  The current validation workflow records source and payload hashes; see
  `dev/installer-ssh-acceptance.md` and its dated evidence.
- `v0.14.9` is the latest annotated release tag. Older 0.14.x build records do
  not imply corresponding tags; existing historical tags were not changed.

## Current contracts

- Workspaces are PTY-first (`claude`, `codex`, `opencode`, `packetcode`).
  Agents owns first-class API conversations. PacketCode's ACP transport is
  removed. `api-packetcode` and `api-openai-codex` conversations remain
  readable but cannot start turns; never silently remap them.
- Fourteen API rows are implemented. `api-claude-oauth` is a historical identifier for
  the Anthropic API-key Agent SDK provider, not subscription OAuth.
  PTY CLI sessions retain their normal subscription logins.
- Sidecar protocol and minimum are **v12**. Local and remote sidecars must
  satisfy the minimum before a session request is sent. Remote startup now
  waits for the actual SSH peer's `ready` handshake before forwarding keys
  or starting MCP probes; incompatible, missing and timed-out handshakes fail.
- Repo-supplied hooks, MCP commands and agent definitions require explicit
  project trust. For local runtime paths, the list is
  `~/.packetbench/trusted-projects.json`. For remote MCP sourcing it is the
  same file **on the execution host**, containing that host's absolute paths:
  `{"version":1,"projects":["/home/alice/project"]}`. Trust matches canonical
  roots exactly and does not extend to nested repositories. Missing or
  invalid lists deny project config. Global MCP configuration remains usable.
- Untrusted remote `.mcp.json` entries cannot add, replace or disable global
  servers and never reach capability probing. Tool-level MCP permissions
  still apply after a trusted configuration has been loaded. Update old SSH
  sidecars before attempting a v12 session; a desktop trust entry grants no
  remote project authority.
- Auxiliary LLM work has two bounded lanes per provider: background session
  summaries, pattern extraction and Flight retrospectives; and interactive
  tasks such as side chat, spec import and code-quality actions. Each lane
  permits two turns (at most four auxiliary turns per provider). Retry waits
  hold only that provider/lane's permit. The provider may still rate-limit
  requests; queue isolation is not a quota fix or provider fallback.
- Storage mirror restoration runs before dynamically importing the React
  tree and hydrating stores. Build persisted keys with `storageKey()`.
  The original packetade WebView2 profile remains intentionally unmigrated;
  the mirror protects future origin changes, not those stranded old keys.
- PTY outcomes remain `clean`, `failed`, `killed`, or `unknown`. Detection,
  Settings and launches share the CLI resolver. A broken explicit pin must
  remain visible and clearable, rather than silently falling through.
- Remote Agents Sprint 0 is complete and the program is active, while the
  product feature remains disabled behind the private-beta gates. Sprint 1
  host presence and product authentication remain future work; see
  `dev/remoteagents/README.md`.

## Verification and next work

Consolidation validation on 2026-09-07:

- `cargo test --lib --jobs 2` from `src-tauri/`: 989 passed, 2 ignored.
  The handshake regression was rerun successfully after the final logging edit.
- `pnpm exec vitest run --maxWorkers=2`: 2,759 passed across 293 files.
- Sidecar build and five smoke gates passed: MCP config merge, remote
  filesystem sourcing, protocol, MCP trust, and MCP trust enforcement.
  Remote sourcing proves a marker command cannot execute without host trust
  and does execute during probing once the host trusts the project.
- Type checking, format checking and `git diff --check` passed. Lint passed
  with 0 errors and 9 existing React Refresh warnings in untouched files.
- No installer rebuild, installation or live SSH/hardware acceptance was run
  in that September 7 source-validation pass. The September 8 follow-up uses
  `pnpm acceptance:build`, `scripts/validate-installer.ps1`, and
  `pnpm acceptance:ssh`; results are recorded separately rather than inferred
  from those earlier source tests.

September 8 follow-up is complete at its stated scope: NSIS upgrade, installed
payload/runtime, normal startup, and a disposable real Linux OpenSSH matrix.
The dated evidence above also records the per-format executable-hash fix and
four passing harness regressions. No paid-provider or full GUI matrix is
implied by the echo tests.

The broader native follow-up found and corrected Monitor's synchronous WebView2
creation deadlock (0.14.2) and its ability to keep the process alive after main
closed (0.14.3). Installed Ollama streaming, cancellation and a subsequent turn
passed. MiniMax returned its upstream quota limit; Anthropic/OpenAI API keys
were absent. Tiny downloaded and verified successfully, but the live headset
probe received zero frames. Full paid SDK, Flight, denial-integration and physical
headset recovery matrices remain scoped in the backlog and dated GUI report.
The two additional native findings have September 11 source corrections:
the initial prompt is saved before provider launch and restores with an
interruption notice; restored idle model choices are persisted for the next
launch without requiring a nonexistent backend session. Seven restart
regressions pass, including live backend rejection and stale-save protection.
Installed 0.14.4 passed both original native cases: confirmed shutdown during
the initial Ollama turn retained the exact prompt and restored idle with an
interruption notice; the restored model changed and survived restart. Both
corrections are included in installed 0.14.5.

Workspace daily workflow is the first P1 roadmap track. The September 11 team
pass adds guarded terminal focus/navigation, visible failed-send recovery,
selection/zoom restore corrections, and bounded resize/PTY-output batching.
Installed 0.14.6 includes these and both conversation restart fixes, incremental
layout persistence, shared pane controls and readable many-pane layouts. Its
native eight-column restart/file-close checks and 15-case SSH run passed.
Current source/build/native scope: `dev/workspace-usability-evidence-2026-09-11.md`.
Prior reliability details: `dev/workspace-evidence-2026-09-11.md`.
The 0.14.7 source has completed isolated native WebView2 profiling: eight panes,
about 22 MB of output, 16.8 ms p95 frame intervals in cold and warm runs, and no
long tasks. Tauri transport is mocked in that profile. The paid Claude-over-SSH
reply test is deferred at the user's request pending subscription renewal;
GUI-to-SSH and wider hardware acceptance remain separate. Historical release
evidence: `dev/workspace-release-0.14.7.md`.

Current installation, Flight and startup evidence is in
`dev/flight-overhaul-review-2026-10-19.md` and the workstation handoff above.
The September 24 report remains historical; its installed-version statements
are superseded by this local 0.14.9 rebuild.

1. Resume with the owner's installed 0.14.9 dogfood feedback. Prioritize Workspace
   local/SSH panes, focus/approval ownership, saved layouts and restart,
   Git actions, prompt delivery and restored chats. Record concrete steps,
   expected/actual behavior and the affected version in `backlog.md`.
2. Reproduce and fix reported defects, validate the affected paths and keep
   new package evidence tied to its source. Use `dev/installer-ssh-acceptance.md`
   when a future build/install or live OpenSSH run is requested.
3. Broader native/provider/hardware gates remain separate: dictation with
   working audio input, Monitor stale-state/denial/Flight cases, Flight
   supervision, MCP/GUI SSH behavior, and PacketAgent PH10. Paid Claude
   testing remains deferred for cost; the echo check does not cover it.
4. Keep outstanding items in `backlog.md`; do not turn historical audit
   narratives or this handoff into competing task registers.

## Decisions and environment

- No new 1.0 milestone was approved. Continue the 0.x cadence.
- Signing remains deferred until a build goes to someone other than the
  owner. Updater setup and its backed-up keypair remain deferred too.
- Global Undo is a time-boxed delayed-delete toast; durable soft-delete was
  declined. Its implementation remains unscheduled.
- Remote Agents requires encrypted sensitive payloads before external beta.
  Passkey/magic-link auth in PacketRelay is the accepted direction; security
  review and database durability remain external-beta gates.
- Syndicate is separate and has no live integration. PacketRelay belongs to
  PacketBench. PacketCode is the sibling TUI. Do not write into sibling repos
  from this task. The PacketAgent contract fixture is digest-pinned; never
  rename-sweep it.
- Run Cargo from `src-tauri/` so its local `.cargo/config.toml` is honored.
  It currently targets `C:/Users/ianwalmsley/packetbench-build`. On Windows,
  ensure the native Rust toolchain is on PATH. Avoid competing CPU-heavy
  test/build runs; Vitest's timing assertions can fail under saturation.
- `pnpm gates:fast` / `pnpm gates:full` are the local gate entry points;
  there is deliberately no hosted CI. A full package build prunes sidecar
  devDependencies; run `pnpm sidecar:install` afterward to restore them.
- `AGENTS.md` and `CLAUDE.md` are ignored files and must be maintained together
  (identical except their H1). Historical paths in fixtures and archives are
  compatibility/history, not current product identity.
