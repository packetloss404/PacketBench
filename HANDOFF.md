# PacketBench Handoff

Last reconciled: 2026-09-12

This is the current restart document. Use `backlog.md` for outstanding work,
`ROADMAP.md` for ordering, and `CHANGELOG.md` for shipped/build history.
`docs/handoff.md` and `docs/audit-2026-09-04.md` describe the September audit;
the current contracts below supersede their older protocol and queue details.

## Checkout and artifacts

- Working directory: `D:\projects\PacketBench`.
- Remote: `git@github.com:packetloss404/PacketBench.git`.
- **0.14.7 is built and pushed to main** (2026-09-12), from clean code commit
  `4443c8b0`. Viewer/Fleet summaries, missing-conversation zoom and concurrent
  Monitor opens are corrected. Eleven full quality gates, fifteen disposable
  OpenSSH cases and both Windows installer builds passed. Native WebView2
  profiling measured eight-pane cold/warm p95 frame intervals of 16.8 ms.
  Exact hashes and scope: `dev/workspace-release-0.14.7.md`. Installation was
  outside this build request; the installed app remains 0.14.6. Paid Claude
  testing is deferred at the user's request pending subscription renewal.
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
  hash is under `[Unreleased]`. Do not identify a binary by version alone.
  The current validation workflow records source and payload hashes; see
  `dev/installer-ssh-acceptance.md` and its dated evidence.
- `v0.10.3` remains the latest annotated release tag. Newer build records
  do not imply matching release tags.

## Current contracts

- Workspaces are PTY-first (`claude`, `codex`, `opencode`, `packetcode`).
  Agents owns first-class API conversations. PacketCode's ACP transport is
  removed. `api-packetcode` and `api-openai-codex` conversations remain
  readable but cannot start turns; never silently remap them.
- Eight API rows remain. `api-claude-oauth` is a historical identifier for
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
GUI-to-SSH and wider hardware acceptance remain separate. Current release
evidence: `dev/workspace-release-0.14.7.md`.

1. Follow `dev/installer-ssh-acceptance.md` to reproduce the newly versioned
   package and live OpenSSH checks; inspect the dated evidence for run status.
2. Keep wider packaged/provider acceptance distinct from the isolated echo
   transport and installed-payload checks.
3. Continue the remaining real-hardware and real-host gates: dictation with
   working audio input, Monitor stale-state/denial/Flight cases, Flight
   supervision, paid provider/MCP behavior, and PacketAgent PH10.
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
