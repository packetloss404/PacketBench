# Changelog

All notable changes to PacketBench are documented in this file. Outstanding work
lives in [`backlog.md`](./backlog.md) at the project root.

For current direction, use [`ROADMAP.md`](./ROADMAP.md). For planning briefs and
runbooks, use [`dev/README.md`](./dev/README.md). This file is history, not a
task list.

## [Unreleased]

## [0.14.7] - 2026-09-12 (local build)

- Workspace and Fleet summaries distinguish file viewers and saved conversations
  from terminals while retaining CLI labels and account grouping.
- Missing-conversation panes remain visible when zoomed, and pointer/keyboard
  focus selects their fallback correctly.
- Concurrent Monitor opens serialize native singleton creation without blocking
  the new WebView's lease handshake.
- Added isolated native WebView2 profiling and opt-in real-provider SSH evidence
  tooling. Eight-pane cold/warm native profiling measured 16.8 ms p95 frame
  intervals with no long tasks. Paid Claude validation is deferred at the user's
  request. Scope: [0.14.7 evidence](./dev/workspace-release-0.14.7.md).
- All eleven full local quality gates and the fifteen-case disposable OpenSSH
  matrix passed. NSIS and MSI installers built from clean commit `4443c8b0`;
  artifact hashes were verified. Installation remains version-specific: the
  installed application is still 0.14.6.

## [0.14.6] - 2026-09-11 (local verification)

- Workspaces now share accessible header/zoom controls across terminal,
  saved conversation and file panes. Closing the selected pane chooses a
  surviving visible pane and clears stale zoom/focus state.
- Readable mode keeps panes at useful dimensions with scrolling. Fit all,
  Balance sizes, pane selection and previous/next controls preserve the saved
  arrangement. Selection remains visible through mode and viewport changes.
- Added real Workspace/xterm browser stress acceptance and six native Workspace
  SSH cases. Full Vitest passed 2,834 tests; final integration checks passed 70
  focused tests plus four browser cases. The frozen-source OpenSSH matrix passed
  15/15. High-output rendering pauses remain a measured profiling gap.
- Both installers and 11 release checks passed. NSIS installation verified
  8,683 files and two bundled-sidecar turns. Native eight-pane controls,
  zoomed file closure and eight-column restart persistence passed.
- Isolated Playwright output after its former default cleared older ignored
  raw acceptance artifacts; tracked historical reports remain. Exact hashes,
  current evidence and limits: [Workspace usability evidence](./dev/workspace-usability-evidence-2026-09-11.md).

## [0.14.5] - 2026-09-11 (local verification)

- Persist the displayed Workspace layout after adding or removing a pane.
  Native testing caught four added columns reopening as the 2x2 preset;
  the corrected installer retains all four columns after a normal restart.
  Surviving terminals keep their mounted tree during structural edits.
- Both Windows installers and 11 release checks passed. NSIS exit 0, all
  8,683 installed hashes matched, and bundled Node/protocol-v12 sidecar passed
  two turns. The final layout/selection suites passed 36 tests. Exact artifact
  identity and native scope: [Workspace evidence](./dev/workspace-evidence-2026-09-11.md).

## [0.14.4] - 2026-09-11 (local verification)

- Workspaces: terminal selection now reaches keyboard focus, with guarded
  Ctrl+Alt+PageUp/PageDown navigation and last-pane restoration when switching
  Workspaces. Backend hydration revalidates the selected Workspace, and
  archive/delete clears owned zoom.
- Failed pinned-command/template sends retain their exact text and offer
  explicit retry and separate session restart. Pending sends suppress duplicate
  clicks; exited sessions disable send controls.
- Terminal resize bursts coalesce per animation frame; hidden/unmounted panes
  cancel pending fits. PTY output uses bounded 8 ms / 32 KiB batches, preserving
  transcript/event sequence boundaries and flushing before the exit event.
- Save a new API conversation and its initial prompt before starting the
  provider. Restoring an active record marks the previous turn as interrupted
  and leaves it idle until the user continues.
- Apply and persist model selections on restored API conversations before
  their next launch. Live sessions still require backend acceptance.
- Full Vitest run: 2,813 tests passed across 297 files; 49 targeted Rust tests
  and 11 release checks passed. Installation verified 8,683 payload files and
  the bundled sidecar. Native initial-prompt interruption/restart and restored
  model change/persistence passed. Native testing found the incremental layout
  loss corrected in 0.14.5; see the dated Workspace evidence for scope.

## [0.14.3] - 2026-09-08 (local verification)

- Main-window destruction now exits the application through its normal cleanup
  path, so an open Monitor cannot keep the app and agent processes alive.
  The live-work close confirmation remains in place. Monitor window controls
  now expose accessible names.
- NSIS upgrade exited 0; all 8,683 installed payload hashes matched. Bundled
  Node 24.15.0 and protocol-v12 sidecar passed two echo turns. Both Windows
  installers, 11 release checks and seven close-confirmation tests passed.
- Native Monitor opening, rendering, accessible names, idle/confirmed shutdown
  and cancelling active-work shutdown passed. Exact hashes and per-build scope are in the
  [GUI/provider/hardware evidence](./dev/gui-provider-evidence-2026-09-08.md).

## [0.14.2] - 2026-09-08 (local verification)

- Fixed a Windows WebView2 deadlock by making Monitor creation an asynchronous
  Tauri command. Native two-display opening, route reuse, focus, maximize and
  own-window close were exercised. The later main-window shutdown failure was
  found in this installed build and corrected in 0.14.3.
- NSIS installation, 8,683 payload hashes and bundled two-turn sidecar smoke
  passed. Installed Ollama streaming, Stop and a successful post-cancel turn
  were observed. Two Monitor route/authority tests and 11 release checks passed.
- Broader native observations included MiniMax's upstream quota failure,
  missing-key setup guidance, Dictation empty states, verified Tiny model
  download and an audio probe that returned zero frames. See the dated report
  above for the exact limits of each observation.

## [0.14.1] - 2026-09-08 (local verification)

Unsigned Windows consolidation build, installed after the owner closed the
app normally. Source snapshot, artifact hashes and exact validation scope:
[`installer/SSH evidence`](./dev/installer-ssh-evidence-2026-09-08.md).

- NSIS upgrade exited 0; **8,683 installed payload files** matched the
  manifest. Bundled Node 24.15.0 and protocol-v12 sidecar passed two echo turns;
  normal application startup passed.
- Real Linux OpenSSH acceptance **9/9**: project trust/probing, malformed
  configuration, old/invalid handshake denial before request transmission,
  wrong host-key rejection, and reconnect. No paid-provider calls.
- Added reproducible build/install/SSH runners and source/payload manifests.
  Per-format hashes account for Tauri's executable marker patching; four
  harness regressions passed. Sidecar dev dependencies restored after build.

These consolidation changes are in 0.14.1, **not** the old 0.14.0 installers:

- Consolidation: remote project MCP configuration requires the execution
  host's explicit canonical-path trust list before merging or probing commands.
  Sidecar protocol/minimum v12 adds `projectTrustDataDir`, derived from the
  Rust brand module. SSH startup waits for a compatible `ready` before sending
  a session request or API key; older peers fail with an update instruction.
- Auxiliary concurrency is bounded separately by provider and by background
  versus interactive work, two turns per lane (at most four per provider).
  Summary backlogs and their retry waits no longer occupy side-chat slots or
  delay another provider. This does not fix an account's exhausted quota.
- Reconciled the root handoff and roadmap with the installed 0.14.0 evidence;
  retained older acceptance results as evidence about their original binaries.

- F26/P18 — aux turns bounded to 2 concurrent. Closing a workspace with N
  terminals fired N simultaneous provider calls.
- F26/P19 — a provider 429 now backs off and retries twice, and a turn that
  exhausts the budget logs at WARN instead of vanishing at INFO.
- F27/P20 — a broken CLI path override hid the very control that clears it.
- F27/P21 — a stale pin now reads `pinned path not usable` rather than "not
  installed", which was sending users to reinstall a CLI they already had. The
  detection behaviour behind it is deliberate and was left alone; my first
  reading of it as a bug was wrong.
- A correction to F26 itself: the stampede did **not** cause the 429s that
  exposed it. Every MiniMax request in the logs has been rejected, isolated ones
  included, so the account is rate-limited or out of quota. P18 removes bad
  behaviour and P19 makes the failure visible; neither would have saved the
  lost summaries.

Local verification builds were installed to exercise these, the most recent
from `087fc57c` — installed exe sha256
`ca9dde7d5816d625c7333c5464074a5f255f7011d6a7f64c1b545e0651339135`. They carry
the same `0.14.0` version string as the artifacts below and are different
binaries. Those older verification installs preceded the versioned 0.14.1
build above and remain attributed to their own hashes.

## [0.14.0] - 2026-09-05

Security and correctness audit, 2026-09-04 to 2026-09-05. 25 findings, 17
patches, each independently applicable and reverse-applicable
(`docs/audit-2026-09-04.md`, `docs/audit/patches/`).

Windows artifacts, built 2026-09-05 from `cd276627`, **unsigned**:

| Artifact                                            | SHA-256                                                            |
| --------------------------------------------------- | ------------------------------------------------------------------ |
| `PacketBench_0.14.0_x64-setup.exe` (NSIS, 85.2 MiB) | `d01692d680dcf6434d8090fef248ad5149d07ddb4324021a75cd57a38d79fc9e` |
| `PacketBench_0.14.0_x64_en-US.msi` (132.9 MiB)      | `f46ab0cffea1ea660b91083d950d556ab6a730625fbdbdeee42042fcb59f61bd` |

`packetbench.exe` inside them reports file version `0.14.0`, and
`pnpm run release:readiness --skip-gates` detects both: 0 fail.

Installed and exercised 2026-09-05: the installed executable reports file
version `0.14.0`, and `node smoke-test.mjs` in live mode passes **6 of 7**
against it — `/health` 200 reporting `"version":"0.14.0"`, no-token 401,
wrong-token 401, foreign `Origin` 403 on both routes, and bearer `initialize`
200 with a session id. The 7th case needs an active Flight and this install has
none, so it did not run; that is the script's precondition, not a defect.

The rest of the audit's runtime verification —
the U05 shell-scope check and the before/after screen comparison — ran against
binaries built from `610f3975`, while the version still read 0.13.2. Those were
also unsigned, and are kept below as the record of what was tested there:

| Pre-bump artifact (`610f3975`, version string 0.13.2) | SHA-256                                                            |
| ----------------------------------------------------- | ------------------------------------------------------------------ |
| `PacketBench_0.13.2_x64-setup.exe` (NSIS, 85.2 MiB)   | `222138d6b89238a23accc39b6a48b4637457f93a24518e88e6875a455f32be75` |
| `PacketBench_0.13.2_x64_en-US.msi` (132.9 MiB)        | `483014079f5a212e4f94873fdefec532d9d9bdd10f7fdce60e1156a8403cb9e7` |

The version was bumped precisely because those carried the same version string
as the 2026-08-30 pair below while being different binaries — three distinct
builds answered to `0.13.2`. Nothing in the toolchain objects to that:
`scripts/release-gate.mjs` checks that the three manifests agree with each
other, not that a version string maps to one artifact.

Gates at `610f3975`: `pnpm gates:fast` all PASS (format, lint, typecheck, and
the full vitest suite), `cargo test --lib` 983 passed / 0 failed / 2 ignored,
`node smoke-test.mjs` 5/5, `pnpm run release:readiness --skip-gates` 0 fail.

### Security

Default permission mode is `ask_for_risky`, not `auto` — `bash`, `write_file`,
`edit_file` and `create_pull_request` now prompt. Repo-supplied hooks,
`.mcp.json` servers and `.claude/agents` definitions are gated behind an
explicit trust list (`~/.packetbench/trusted-projects.json`), fail-closed.
Sub-agents are held to a tool allowlist. `grep` no longer follows symlinks out
of the workspace. Secret-bearing endpoints require https unless the host is
local. GitHub agent tools read the token from the keyring only. MCP resources
honour the tool allowlist, and the server gained a `/health` route.
`ssh_exec` refuses `ProxyCommand`/`LocalCommand`/`-F`/`-E`.

### Fixed — `pnpm tauri build` deleted the repo's own devDependencies

`scripts/prune-sidecar.js` ran a `--prod` install without `--ignore-workspace`.
`agent-sidecar` is not a member of `pnpm-workspace.yaml`, so pnpm walked up,
found the workspace root and installed **that**, stripping `vite`,
`typescript`, `vitest`, `@tauri-apps/cli` and `eslint`, then aborted. Introduced
by `d6238633` (2026-09-01), which added the workspace file and fixed
`sidecar:install` but not this script, which does the same install. The packaged
build had been impossible for four days and nobody had run one. Recovery from a
damaged tree is `pnpm install`.

### Fixed — the Remote Agents feature flag now actually fails closed

`README.md` said Remote Agents "remains disabled and fail-closed". It was
neither: the only control was a store field defaulting to `false` with no
consumer, so the claim held because nothing existed to enable. One
`if (settings.remoteAgents.enabled)` in Sprint 1 would have opened it with none
of the ratified private-beta requirements met. `src/lib/remoteAgentsGate.ts` is
now the single seam — user intent AND an eleven-item gate list transcribed from
`dev/remoteagents/04-security.md:385-397`, all of them unmet — and an eslint
rule stops anything else importing the store.

### Fixed — half the persisted stores would have lost their mirror at a rename

19 files hardcoded the `packetbench:` storage prefix instead of building keys
with `storageKey()`. `storageMirror` mirrors by prefix and the migration
carries exactly one previous prefix, so at the next rename those stores would
have kept working while quietly dropping out of the durable mirror — and the
next bundle-identifier change would have taken them, which is how the last
rename lost state. Two regression fences now guard the storage prefix and the
user-visible product name.

## [0.13.2] - 2026-08-30

Windows artifacts, built 2026-08-30 from `5b534517`, **unsigned**:

| Artifact                                            | SHA-256                                                            |
| --------------------------------------------------- | ------------------------------------------------------------------ |
| `PacketBench_0.13.2_x64-setup.exe` (NSIS, 85.4 MiB) | `3c7a3f55374f5baee36fdf335d5a990093a4e280627d96337edd63da81fde563` |
| `PacketBench_0.13.2_x64_en-US.msi` (133.2 MiB)      | `c116a1642bdb7a66977e360f8f09c31f97fe0f0718d722bccd78a2b8c5cedacc` |

Three defects, all found by **running section 2 of the acceptance matrix
against the installed 0.13.1 package** rather than by reading the source. See
`dev/acceptance.md` for what that run covered and what it did not.

Gates at `5b534517`: `cargo check` clean, 976 Rust lib tests (2 ignored),
`tsc --noEmit` 0 errors, `pnpm lint` 0 errors (9 pre-existing warnings),
`vitest run` 2774/2774 across 287 files.

### Fixed — a crashing CLI was indistinguishable from a clean exit

Every part of the mechanism existed except the one that mattered. Rust emitted a
real payload (`commands/pty.rs:538` — `exitCode`, `terminated`), and
`parsePtyExitPayload` existed to read it. **Nothing called it.** All three
`pty:exit` listeners took no parameter, so a CLI that access-violated on startup
printed the same grey `[Session ended]` and set the same `done` status as one
that finished its work.

Both hooks now consume the payload through a single shared helper,
`ptyExitSucceeded`, so the terminal pane and the transient runner cannot drift
on what counts as a failure. A non-zero code prints in red with the code and
sets the tab to `error`; the memory layer records `error` rather than `done`.
Two cases stay successes deliberately: `terminated` — the user or an
orchestrator killed it, which is not the CLI failing — and a `null` code,
because "could not read the status" is an absence of evidence, not evidence of
failure. Both hooks also carry the outcome across their buffering deferral;
storing only the flag and re-calling `finish(true)` would have laundered a
failure into a success one layer further down.

### Fixed — a workspace whose folder is gone now says so where you clicked

The reason was stated only inside the sidebar's FILES subtree, which is
collapsed by default. The workspace opened to a blank mosaic and the click read
as a no-op. `WorkspaceView` now probes with the existing `path_is_dir` command
and renders the reason in the main pane, with the path and the fact that
nothing has been deleted. Remote workspaces are skipped — their path is on the
remote host and `path_is_dir` would answer about the wrong machine — and a
failed probe stays silent rather than accusing the directory of being missing.

### Fixed — the selected workspace is restored across a restart

`activeWorkspaceId` was hardcoded to `null` at init and never persisted, so
every launch landed on "Select a workspace from the sidebar" with the list and
every session intact behind it. It is now stored under
`packetbench:workspace-active-id` and **validated against the hydrated list on
read**, so a workspace deleted or archived since the last run resolves to `null`
instead of pointing the view at a ghost.

## [0.13.1] - 2026-08-30

Windows artifacts, built 2026-08-30 from `8dc13780`, **unsigned**:

| Artifact                                            | SHA-256                                                            |
| --------------------------------------------------- | ------------------------------------------------------------------ |
| `PacketBench_0.13.1_x64-setup.exe` (NSIS, 85.4 MiB) | `10814779d13001ea4517c706eaf62adc55c21701abe6ed37821d3994a58c8a4e` |
| `PacketBench_0.13.1_x64_en-US.msi` (133.2 MiB)      | `d0caf91b45d3903ae42eda1bd28754b3600e9d9336f50fbb82cf2d2b66c11f68` |

A patch release for three defects found by using 0.13.0 rather than by testing
it. The acceptance-matrix position is unchanged from 0.13.0: sections 2–5 have
still never run.

Gates at `8dc13780`: `cargo check` clean, 976 Rust lib tests (2 ignored),
`tsc --noEmit` 0 errors, `pnpm lint` 0 errors (9 pre-existing warnings),
`vitest run` 2765/2765 across 286 files.

### Fixed — a console window on every visit to either agent route

`acp/mod.rs` has four spawn sites. The `taskkill` and installer spawns both
called `hide_window_async`; the two that matter — the `doctor --json` probe and
the engine itself — never set `CREATE_NO_WINDOW`. Both agent routes probe on
mount (the Agents view through each provider's auth badge via
`acp::routing::auth_status`, the PacketCode view through
`PacketCodeEngineGate`), so a console window appeared on **every navigation**.
The engine spawn was worse than a flash: it is long-lived, so its window stayed
on screen for the whole session.

### Fixed — the ACP row guessed at the engine's models, and 404'd

The PacketCode (ACP) catalog row seeded three model ids so the picker would
"render something before the engine has been asked". Those ids were a guess at
another program's configuration. The engine owns its own provider credentials,
so which models exist is decided by the user's `~/.packetcode/config.toml` — and
on a machine whose engine has providers `openai` / `codex` / `ollama` and default
model `gpt-5.6-sol`, with **no Anthropic provider at all**, the seeded Claude id
went to OpenAI and came back as:

```
-32603 chat completion: status 404: The model claude-opus-4-8 does not exist
or you do not have access to it
```

The row now carries no models, the rule already applied to Ollama's live list
and `api-custom`. Nothing else needed changing: the engine enumerates its real
models over `_packetcode/models/list`, `stampEngineCapabilities` already fetches
them, and `ModelSelector` already prefers them over the catalog. Until that
answer arrives PacketBench sends **no** model, and `acp::routing` maps an empty
model to `None` — so the engine uses its own configured default, the only model
we can be sure exists. The picker stays mounted and reads "Engine default".

### Fixed — three model ids that named models which do not exist

`claude-opus-4-6-20250415`, `claude-sonnet-4-6-20250414` and
`claude-haiku-4-5-20251001` all carried a snapshot date. Anthropic's published
ids are complete without one, so each would have 404'd the first time it was
picked. The rest of the codebase already knew this — `findProviderCatalog` and
both pricing engines strip a trailing `-YYYYMMDD` before matching, and
`modelContext` keys on the bare ids — so the catalog was the only place treating
a dated id as canonical.

Claude Opus 5 and Claude Sonnet 5 join both Anthropic rows, with Opus 5 first so
it is the default for **new** conversations; persisted ones resume on their own
stored id. No pricing change was needed — `shared/model-pricing.json` already
carried `claude-opus-5`, `claude-sonnet-5` and `claude-fable-5`.

Separately, the context table listed Opus 4.6 and Sonnet 4.6 at 200K tokens.
Both are 1M, so every context gauge for those two undersized by 5× — the same
class of error that module's header says it exists to end.

## [0.13.0] - 2026-08-30

Windows artifacts, built 2026-08-30 from `49583b5a`, **unsigned**:

| Artifact                                            | SHA-256                                                            |
| --------------------------------------------------- | ------------------------------------------------------------------ |
| `PacketBench_0.13.0_x64-setup.exe` (NSIS, 85.4 MiB) | `5cb2f0554e1c34a5feb286af60d783854c2543f6743e6cec250432e48235cf1e` |
| `PacketBench_0.13.0_x64_en-US.msi` (133.2 MiB)      | `d94badc981bf00a6cb382616f9ebdbcf47ca68b6a1d2222ce53473c650be7f55` |

> **Installed, not accepted.** 0.13.0 was installed over 0.12.1 on 2026-08-30
> (silent, per-user, exit 0, installer hash checked first). That proved three
> things and no more: one Add/Remove Programs entry rather than two, a
> same-identifier upgrade preserves the data dir, and the app starts. Sections
> 2–5 — lifecycle, dictation on real hardware, analytics, and the two-display
> Monitor matrix — have still never run, and the pre-rename migration row still
> cannot be proved on this machine, because `~/.packetbench` already exists so
> the migrator correctly declines to run. The
> artifacts live in `C:/Users/ianwalmsley/packetbench-build/release/bundle/`, not
> in the repo, alongside the 0.11.0, 0.12.0 and 0.12.1 pairs — **check the
> version in the filename before installing.**

Gates at `49583b5a`: `cargo check` clean, 976 Rust lib tests (2 ignored) + 31
`acp_stream` passing, `tsc --noEmit` 0 errors, `pnpm lint` 0 errors, `vitest run`
2764/2764 across 286 files, `check:tauri-schema` clean.

### Security — four guarantees the code did not actually make

**The git-host guards were a deny-list that failed open.** Every guard read
`if kind == Gitea { refuse }`, so any host kind they had not been told about
sailed through to a hardcoded `api.github.com` carrying that host's repo ids and
the configured token. `github_reply_to_pr_review_comment` had no guard at all —
on a Gitea workspace it sent your token to GitHub. Replaced with `HostCapability`,
an exhaustive per-capability allow-list where an unrecognised kind defaults to
denied, so adding GitLab could not silently reintroduce the leak. Four more
credential-selection faults went with it, including two sites hand-rolling their
own client with the primary connection's token, and a notification URL hardcoded
to `https://github.com` that would have linked a self-hosted user to a stranger's
repository.

**GitHub device flow wrote to the keyring before any scope check.** The poll
persisted the credential the instant GitHub said `authorized`. The token now
parks in process memory behind an opaque handle, `Zeroizing`, and the commit
step refuses in Rust any handle no probe vouched for — fail-closed in the
backend, not merely behind a disabled button.

**An MCP `allowedRoots` entry of `.` or `""` was a universal allow.** Under the
in-process runtime it reduces to an empty path, and every path starts with the
empty path; under the sidecar it means that process's working directory. The
value that reads like a restriction granted the machine. Refused outright by the
new editor, with the reason stated.

**MCP `allowedTools` was dead config.** It persisted and read as a restriction
while only `port` and `allowWrites` ever reached the server. Now enforced through
`ToolRouter::disable_route`, which hides a tool from `tools/list` _and_ rejects
it in `tools/call`, so later tools are gated by construction.

### Added — GitLab, and a seam that can hold it

GitLab CE/EE joins GitHub and Gitea/Forgejo. This was not a fourth constructor:
GitHub and Gitea share a path grammar and differ only by base URL, which is why
the seam was 205 lines. GitLab does not — `/api/v4`, projects addressed as a
single URL-encoded `owner%2Frepo` path, merge requests, project-scoped `iid`.
The seam split in two: outbound, a host-neutral `RepoRef` and named methods on
`GitHost` so no caller formats a path; inbound, GitHub's wire shape stays
canonical and GitLab payloads are projected in Rust, so no React component
learns a third vocabulary.

Repos, issues, merge requests, notes, labels, milestones, branches, releases,
diffs, merge, pagination and subgroup paths work. Check-runs, reviews,
notifications and AI-assist are **refused with a host-named message** rather than
misbehaving — including `merge_method: "rebase"`, which GitLab has no parameter
for and which would otherwise have quietly produced a merge commit.

> **Note:** No request has been sent to a real GitLab server. Every path and body
> is unit-tested; three-level subgroup encoding, `/raw_diffs` content
> negotiation, and renamed-project redirects are unverified.

### Added — guided git-host setup, editing, and browser sign-in

A wizard that validates before it saves, driven by per-host descriptors rather
than per-host branches, with nine distinct verdicts — `tls_error` separated from
`unreachable` for the self-hosted private-CA case, `not_a_host` for a 2xx whose
body is not an identity, and `scopes_unknown` meaning "the host did not say"
rather than "no scopes". GitLab reports scopes at
`/personal_access_tokens/self` rather than on a header, so the probe takes an
optional second request — best-effort, degrading to unknown rather than to a
rejection, because a token can be valid for the API and still unable to read its
own metadata.

Connections can now be **edited and rotated in place**. Rotation validates the
new credential before replacing the old one and leaves the existing token
untouched on any doubt; previously the only path was remove-and-re-add, and
re-running the wizard minted a second connection instead of rotating. Browser
sign-in folded into the wizard as a descriptor capability, so it and token paste
are reachable from one place and both get scope checking.

### Added — reachable features that previously were not

- **Codebase scan.** `scan_codebase_memory` had no caller while Settings shipped
  a provider picker for it. Now a Memory-pane action storing its result as an
  ordinary note — searchable and distillable into patterns, never silently
  injected into a launch brief. A partial walk is labelled partial rather than
  presented as complete.
- **A settable ACP engine path**, in Settings → Providers & Models → Provider
  Endpoints. The engine's own installer does not touch `PATH`, so "works but is
  invisible to the app" was the default outcome for anyone building from source.
  The CLI Clients pin looked like the fix and is not — it feeds PTY launches
  only, and now says so.
- **Whisper model deletion.** The UI downloaded up to 3 GB with no way to reclaim
  the disk. Sizes shown are real on-disk bytes, not the advertised figures.
- **MCP allowed-roots editing**, and **dictation history removal**.

### Fixed — Agents tab told you the wrong thing about your engine

A `doctor --json` timeout — engine present, ran, reported no version — rendered
as "packetcode unknown is older than the required 0.8.0". A false claim about
the user's build, sending them to fix the wrong problem. It now has its own
state. Separately, a packetcode installed exactly where its own installer puts
it was reported installed, offered in the Workspace agent list, and died the
instant a pane opened: PTY resolution had no install-directory tier.

Verified end to end against a real `packetcode v0.5.1-90-g1377d4f` over stdio —
initialize, session/new, a billed turn, session/load, session/close, and the
negative paths. **Zero protocol divergence.**

### Fixed — settings that did not do what they said

- **"Hard stop at %" was ignored on the only path that blocks a launch.** The
  status path honoured it; the enforcement path hardcoded `>= limitUsd`. One
  control, two halves, and the half that enforces was the half ignoring the
  setting.
- **The memory brief's real limit was invisible.** `DEFAULT_MEMORY_BRIEF_MAX_CHARS`
  sat behind an override no caller passed, so raising any source cap above what
  1800 characters held did nothing. Now `briefMaxChars`. `MAX_CONTEXT_PROJECT_NOTES`
  likewise becomes `contextMaxNotes`, joining its three sibling caps.
- **GitLab connections were unreachable in Settings** — the card filtered for
  Gitea under a Gitea heading, so a GitLab connection saved by the card's own
  wizard was invisible and its keyring token had no reachable control.
- **Editing an MCP server's scope copied instead of moving it**, leaving the same
  name defined in two files.
- Three auxiliary-routing rows configure nothing, and two of them falsified the
  section's claim that these features never use a subscription login. Each now
  carries a note, with a Rust drift-guard that fails when the surface migrates.

### Changed — dead surface removed

Four thin command wrappers and the 123-line checkpoints module, whose own code
said `forkAndResend` subsumes it. Checkpoint _data_ is deliberately left alone:
the feature shipped a working button in 0.5.0 through 0.9.4, and the data-dir
migration carries the tree forward on every rename, so upgraded users still have
those files. The reprice pass's exclusion and its test stay.

## [0.12.1] - 2026-08-28

Windows artifacts, built 2026-08-28 23:08 from `f83fad64`, **unsigned**:

| Artifact                                            | SHA-256                                                            |
| --------------------------------------------------- | ------------------------------------------------------------------ |
| `PacketBench_0.12.1_x64-setup.exe` (NSIS, 85.3 MiB) | `5ebd455d7b2d2736179f43a4e51cee1154346db3ef03a71d94264b771bd1f28d` |
| `PacketBench_0.12.1_x64_en-US.msi` (133.0 MiB)      | `6dc6764a168f49cb18223b2af6d9ba2ff91fc731a53a9c18c0f6deda63c86ec0` |

> **Built, not accepted.** Sections 2–5 of
> [`dev/acceptance.md`](./dev/acceptance.md) — launch and
> lifecycle, dictation on real hardware, analytics, and the two-display Monitor
> matrix — have still never run, and **no installed upgrade of any PacketBench
> package has ever been performed.** Section 1 has only been executed from
> source and against a copy of a real legacy data dir. The artifacts live in
> `C:/Users/ianwalmsley/packetbench-build/release/bundle/`, not in the repo.

Gates at `f83fad64`: `cargo check` clean, 842 Rust lib tests (2 ignored) + 31
`acp_stream` passing, `tsc --noEmit` 0 errors, `pnpm lint` 0 errors, `vitest run`
2418/2418 across 266 files, `check:tauri-schema` clean.

This release exists because four memory workstreams landed after the 0.12.0
bundles were built, so those installers do not contain any of the work below.

### Fixed — Project Memory lost or corrupted notes under ordinary editor saves

The watcher's debounce was leading-edge — it fired 180 ms after the _first_
event of a burst, which is to say reliably **mid-save**, exactly when a
half-written file is on disk. What it then read was mishandled three ways: a
truncate-then-write editor's zero-length file passed the frontmatter test and
became a titled, selectable **empty ghost note** that displaced the real one; a
UTF-8 BOM (Notepad, VS Code `utf8bom`, PowerShell redirects) defeated the same
test, silently degrading a fully managed note to an unmanaged one so its id
vanished and update-by-id stopped resolving; and editor lock files (`.#note.md`)
listed as junk notes. The debounce is now trailing, with a ceiling so a
continuous storm cannot starve refresh, and events on the window boundary are no
longer dropped.

`write_atomic` copied to a backup, **removed the original**, then persisted. A
reader in that window saw the note as deleted, and a crash inside it left the
only copy in a `.packetbench-backup` that nothing ever read back — the note
looked permanently gone. It now renames over the target atomically, keeping the
backup dance only as a fallback, and an orphaned backup surfaces as a warning
with recovery guidance instead of sitting there silently.

Arming the watcher called `memory_root(project_path, true)`, so merely opening a
project **created `.agents/memory`** in it. Watching is now read-only and falls
back to the nearest existing ancestor. The watcher map was also keyed by watched
directory and never pruned, leaking one OS watch handle per project opened and
orphaning the ancestor watcher once the directory appeared; it is now keyed by
project root, replaced in place, and capped.

Search recomputed document frequency by re-scanning every document inside its
per-note/per-term loop — O(notes²·tokens·terms), which hangs the command thread
at the 2,000-note ceiling — and `raw_links` compiled two regexes per note, 4,000
compilations per listing on the hot path of every watcher reload. Both are now
computed once.

Seven store-level races went with them: two overlapping listings of the same
project could land out of order and lose the newer one; every watcher event
started its own full listing; `loading` blanked the list on every background
refresh; an unrelated event wiped the save-conflict banner the user still had to
act on; and `ownWriteUntil` was armed only before a write, so a slow write
outlived its window and the echo of the user's own save was reported as an
external edit.

PacketBench still never writes `.gitignore`, now pinned by three tests including
a byte-comparison across create/update/archive/list/search.

### Added — Ask finds camelCase identifiers and domain acronyms

Closes the miss classes the semantic-retrieval evaluation measured. camelCase
splitting was asymmetric: a prose query reached a camelCase document through the
raw-substring rule, but `SshConfig` collapsed to one token that no rule could
relate to "the ssh config record". Users type symbols into the search box while
agents write prose into summaries. A small acronym table covers PTY/ACP/MCP/IDF,
which the tokenizer makes atomic and the prefix rule's four-character floor
makes unmatchable except literally.

A curated **synonym** map was evaluated and rejected: against a held-out query
set whose vocabulary it did not contain it recovered 0% while inflating result
sets 2.75x. Embeddings were declined too — see `backlog.md` for the measurement.

### Changed — `scan_codebase_memory` no longer shells out to the Claude CLI

It now routes through the aux-LLM seam over a bounded, root-confined project
manifest assembled in Rust (`core::aux_context`), so it gets provider routing,
token accounting, and a legible failure when no provider is configured instead
of silently doing nothing without `claude` on PATH. The backlog's "bounded
read-only tool loop" was **not** built for this half: listing key files with
one-line summaries is a deterministic walk, so the model never needs to choose
what to read, and one aux turn over a pre-assembled manifest is cheaper and
auditable in a way a loop is not.

Symlinks and Windows junctions are skipped rather than resolved, making escape
structurally impossible; every file is re-canonicalized immediately before
opening, closing the walk-to-read window; secret-shaped names are refused with
guards so `tokenizer.rs` survives; binaries are listed but never excerpted.
Routing resolves before the filesystem is touched, so with no provider
configured the disk is never read. `run_claude` remains for `github.rs` and
`insights.rs`. The command still has no caller — whether to wire it up or delete
it is filed as a decision rather than left to drift.

### Fixed — the repository fences failed under a full parallel test run

The three filesystem fences in `scripts/` re-walked and re-read every file under
`src/` once per assertion — a dozen times per test. Alone they took 9–25 s;
under a full 266-file parallel run they contended for the disk and blew vitest's
5 s default, failing one to four tests per run with **timeouts, not assertion
failures**, and a different set each time. They now read through a module-scope
cache, walk once, and carry a timeout matched to what they are: filesystem
scans, not unit tests. All four fence files run in ~3 s. No assertion changed.

### Added — memory capture for remote (SSH) workspaces

0.12.0 recorded that remote memory was empty **by construction**:
`computeContextItems` read the `ssh:<serverId>:<path>` scope keys, but every
writer in production stamped a plain path, so a correctly-scoped remote
workspace could never show anything. This closes that.

`memoryStore.memoryWriteKey` is now the single choke point every new record's
scope goes through — local scopes keep their plain filesystem path (so parent
matching, project chips, and `.agents/memory` loading are untouched), remote
scopes get the `ssh:` key. The four writers that used to stamp a path
independently — PTY session capture, flight retrospectives, the coordination and
transcript capture builders, and `captureManually` — all resolve a
`MemoryBriefScope` and hand it to the store instead. `lib/memoryWriteScope.ts`
resolves that scope from the workspace the work actually ran in, not from
whichever workspace happens to be active when a session ends.

This also fixes a pre-existing write-only-dead path: a manual capture from a
**remote** agent transcript was stamped with the bare remote path, which no ssh
brief scope will ever match. It now keys off `conversation.sshTarget`.

Retrieval follows: remote flights get a launch brief (previously any non-local
target skipped injection entirely), Ask is scope-aware rather than local-only,
and pattern extraction runs against the remote corpus and stamps its output with
the same key. `summarize_session` / `extract_patterns` validate a _scope label_
(`validate_memory_scope`) instead of requiring a local directory — neither
command ever touches the filesystem with that value, and it never reaches the
model.

Scope keys never reach a human: `lib/memoryProjectLabel.ts` resolves them for
display ("build-box · app"), degrading to the bare server id when the connection
is gone — an import from another machine, or a deleted server. Timeline project
chips, the pattern scope badge, and the Markdown export all go through it. The
0.12.0 "remote workspaces record no memory" banner and its dedicated empty
states are gone, because they would now be lying.

**Isolation got stricter, not looser.** A synthetic scope key now matches by
exact key identity or not at all: under `projectPathMatching: "global"` — and
under Ask's "All projects" toggle, which forces it — a local project's brief
would otherwise have pulled in every remote workspace's memory. Tests pin
non-retrieval across servers, across paths on one server, and in both directions
between local and remote.

**Migration is opt-in and reversible; nothing is rewritten automatically.**
Memory recorded under a plain remote path before this landed cannot be
attributed safely: `/srv/app` is indistinguishable from a genuinely local
project at `/srv/app`, and from the same path on a different server. The Memory
pane offers a per-scope "Adopt into &lt;server&gt;" action instead, which stamps
the scope key and stores the original in `legacyProjectPath`; "Undo" restores it
exactly. Records already correctly scoped are never touched.

`.agents/memory` project notes remain local-only — they are read off this
machine's filesystem — and `projectNotesFor` now refuses an ssh scope outright
so a local project sharing a remote path's spelling cannot leak notes into it.

## [0.12.0] - 2026-08-28

Windows artifacts, built 2026-08-28 21:13 from `544e4cc6`, **unsigned**:

| Artifact                                            | SHA-256                                                            |
| --------------------------------------------------- | ------------------------------------------------------------------ |
| `PacketBench_0.12.0_x64-setup.exe` (NSIS, 85.3 MiB) | `60e63fbbd683220ea1744c1b7cd28ac036a20aefef71f44f6500cec0123ecf3a` |
| `PacketBench_0.12.0_x64_en-US.msi` (133.0 MiB)      | `cb12c50ee74f632311d3ddb152a71674ffe19d4c6f8b99c9f91dc6682d80348c` |

> **Built, not accepted — and the acceptance matrix has still only partly run.**
> Section 1 of `dev/acceptance.md` (the migration path) was executed
> against source and a copy of a real legacy data dir; it found two defects, one
> fixed below and one open. Sections 2–5 — launch and lifecycle, dictation on real
> hardware, analytics, and the two-display Monitor matrix — have **not** run.
> They need a person at the keyboard with the headset attached. No installed
> upgrade of this package has been performed. The artifacts live in
> `C:/Users/ianwalmsley/packetbench-build/release/bundle/`, not in the repo.
>
> An earlier pair of 0.12.0 bundles was produced at 21:00 and deleted: that build
> spanned a source edit, so it could not be tied to a commit. Only the hashes
> above are real.

Gates at `544e4cc6`, the tree these bundles were built from: `cargo check`
clean, 801 Rust lib tests (2 ignored) + 31 `acp_stream` passing, `tsc --noEmit`
0 errors, `pnpm lint` 0 errors, `vitest run` 2372/2372 across 264 files,
`check:tauri-schema` clean.

> Everything that sat under **[Unreleased]** when this entry was written landed
> after `544e4cc6` and is therefore **not in these 0.12.0 artifacts**. That work
> has since been released under [0.13.0] and later, so this note is history —
> it does **not** refer to the current [Unreleased] section at the top of the
> file.

### Fixed — the rename stranded a shared legacy data dir

`classify_legacy_dir` tested the packetcode-TUI marker list first and
unconditionally, so a `~/.packetade` carrying both shapes read as `Foreign` and
the entire migration was vetoed — abandoning our own state living in the same
directory.

Found on a real machine: `~/.packetade` held `config.toml` and `cost-tally.json`,
folded in by the earlier PacketCode → PacketADE rename, beside a live
`state.v1.json` at version 1471 with 14 issues and 3 workspaces. It classified
`Foreign`, a fresh `~/.packetbench` was created, and every one of those issues
and workspaces silently stopped existing as far as the app was concerned. Nothing
was deleted — the app simply stopped reading them.
`classify_legacy_dir_lets_the_tui_veto_win` pinned that precedence, so the suite
endorsed it.

The veto exists to stop us _destroying_ a TUI home, and a blanket veto
over-served that. Such a directory is now `Mixed`: only our own known entries are
**copied** into the new dir, and the legacy directory is left exactly as found —
nothing of the TUI's is moved, renamed, or deleted. A TUI-only directory is still
skipped outright, and the rescue never overwrites an entry the new dir already
has, because merging two live states is not a decision a migration can make.

Verified against a copy of the real directory above: classified `Mixed`, all
41,885 bytes of `state.v1.json` recovered byte-identically with its 14 issues and
3 workspaces, `config.toml` and `cost-tally.json` left behind, legacy dir intact.

This does not retroactively rescue a machine where `~/.packetbench` already
exists — `migrate_data_dir_in` still returns early there, by design.

### Upgrading from a pre-rename install resets UI preferences

`migrateLegacyStorage()` reads `localStorage` from inside its own WebView2
profile, and WebView2 keys that profile by bundle identifier. The rename moved the
identifier from `com.packetade.desktop` to `com.packetbench.desktop`, so a
packaged upgrade gets a **new, empty profile**: the migrator finds zero
`packetade:*` keys, writes its guard key, and reports success by silence.

Measured on the machine above: 159 KiB of localStorage under the old identifier
against 19 KiB under the new one, with twelve stranded keys including
`packetade:agent-drafts` (unsent composer drafts), `packetade:project-history`,
`packetade:issues`, and `packetade:workspaces-cache`.

**Accepted rather than fixed (owner decision, 2026-08-29.)** Reaching the old
profile means reading another application's LevelDB store from Rust — a real
feature with its own failure modes, for data that is mostly UI preference. The
one genuinely costly item is unsent composer drafts.

So, plainly: **upgrading a packaged install from a pre-rename build starts with
fresh UI preferences.** Pane layouts, the collapsed/expanded dock, your project
history list and any unsent composer drafts do not come across. Your flights,
issues, workspaces, agent profiles, memory and API keys are unaffected — those
live in the data dir and the OS keyring, both of which migrate correctly.

Nothing is deleted: the old profile remains at
`%LOCALAPPDATA%\com.packetade.desktop\EBWebView\`, so the data can be
recovered by hand and a one-time importer could still be written later.

### Fixed — the Memory pane never showed anything

`memory_events` and `memory_patterns` were empty in persisted state on an
install with five configured agents and six recorded PTY transcripts, while all
38 memory tests passed. Green tests over dead wiring. Four independent faults,
each sufficient on its own:

- **`learnFromSession` built its event after the aux-LLM call.** The
  `session_completed` event was only constructed once a summary came back, so an
  unconfigured aux provider — or one malformed response — produced nothing at
  all, not even an unsummarized record, and the failure went to `console.warn`.
  The event is now written and persisted **before** summarization and enriched
  afterwards; failures surface in the pane instead of being swallowed.
- **Capture was gated on `!wasRequested`.** Kill, Restart, and closing a pane all
  skipped it, leaving only "the CLI exited by itself while still mounted, past
  30 seconds". Every way a session ends is now recorded, stamped `killed` where
  that applies, and the unmount path captures explicitly because it tears down
  the exit listeners before `finishSession` can run. Threshold lowered to 10s.
- **Patterns were a closed loop.** `refreshPatterns` bailed silently without
  summarized sessions, and its only button was disabled by a count of those same
  sessions. It now reports what it did, and draws on manual notes and flight
  lessons rather than session summaries alone.
- **`summariesSinceLastRefresh` reset to 0 every launch**, so the auto-extract
  threshold was unreachable in practice. It is rebuilt on hydrate.

The in-flight guard is now per-session rather than one global `isLearning`, so
two panes closing together are both recorded and a hung provider cannot wedge
capture for the process lifetime; the summarize call is bounded by a timeout and
capture is idempotent per session id.

### Fixed — project notes never reached an agent

Notes in `.agents/memory` were rendered in their own tab and injected nowhere:
the injection path had no notion they existed. They now flow into
`computeContextItems` as a `project_note` kind and appear in the brief under
"Project notes", scoped so one project's notes cannot leak into another's
prompt.

The store was also only ever loaded by that tab's own mount effect, so the tab
badge read 0 and Ask found nothing until the user happened to click into it.
Notes now load at startup and on Memory-view mount. `load()` lists before
watching, so a watcher failure — network drive, exhausted handles,
permission-denied mkdir — degrades live refresh instead of blanking a perfectly
readable set of notes.

Plain Markdown without frontmatter is now a valid note, taking its title from
the first heading and its timestamps from the filesystem. Hand-written `.md`
files dropped into `.agents/memory` previously surfaced as a
`malformed_frontmatter` warning instead of content. Genuinely broken frontmatter
still warns.

### Fixed — Ask searched the injection budget instead of the corpus

The Ask tab ranked `computeContextItems` output — a prompt-**budget** selector.
Its rules are correct for deciding what fits in a prompt and wrong for a search
box: patterns under 0.6 confidence dropped, every source capped, flight lessons
windowed to 7 days and session summaries to 48 hours. Anything older than two
days was invisible. `manual_note` had no branch at all, so notes saved from the
pane's own button were unsearchable, and flight retrospectives were mined only
for `lessonsLearned`. The scorer had no substring, prefix, or stem matching, so
"SSH auth" scored zero against a note saying "authentication".

Search and injection are now separate paths over the same data. New
`lib/memorySearch.ts` builds the full in-scope corpus with no caps, no recency
windows, and no character budget; `corpusRelevanceScores` matches by exact
token, stem, prefix, or raw substring and falls back to whole-phrase matching
for a degenerate query. Relevance is the only eligibility gate — kind, recency,
and trust priors reorder hits but can never manufacture or suppress one. Ask
reports what it searched, so an empty answer is legible rather than a lie.

Injection is deliberately untouched: `relevanceScores` and `computeContextItems`
keep their gates, caps, and windows, and `computeContextItems` no longer has any
caller outside the store. A test pins the separation with four items Ask finds
and the brief correctly refuses. `lib/projectMemoryRetrieval.ts` was superseded
and removed.

### Fixed — remote workspaces were scoped to a stale local project

`layoutStore.projectPath` is a local-only mirror whose sync deliberately
early-returns for a remote workspace, preserving the last local path so git
pollers, the file watcher, MCP, and deploy are never handed a remote one.
`useGitInfo` checks `isLocalWorkspace` before trusting it; MemoryView never did.
On a remote workspace the pane therefore scoped patterns, the brief, Ask, and
project notes to a **different project**, and manual captures stamped that other
project's path.

Scope is now derived from the active workspace (`lib/memoryScope.ts`,
`useMemoryScope`) and never falls back to the mirror when remote. The pane
always shows what it is scoped to, local-filesystem commands can no longer
receive a remote path, and a remote workspace gets an explicit banner and
dedicated empty states.

Remote memory is empty **by construction**: `computeContextItems` reads the
`ssh:`/`workspace:` scope keys but nothing anywhere writes them. This release
makes that honest and visible rather than hiding it behind another project's
data. Capturing memory for remote workspaces is a feature with its own migration
story and is deliberately not attempted here.

### Fixed — path spellings silently split a project's memory

`normalizePath` folded separators and case but not duplicate or trailing
separators, so `D:/p/app/` and `D:/p/app` were different scopes under the
default `exact` matching, and memory recorded under one was invisible to the
other. It now folds both. This only ever merges spellings of a single directory
and cannot leak one project into another; the `projectPathMatching` default is
unchanged.

### Added — the Memory pane can be used, not just read

- A **New memory** button. The pane previously had no way to put anything into
  memory; every capture affordance lived on some other surface.
- Empty states now state the actual precondition and carry an action, rather
  than reporting emptiness and stopping. The Timeline's old copy claimed capture
  was automatic for a class of events nothing had emitted since July 2026.
- The default tab follows the data instead of always landing on Patterns, which
  is gated on an aux LLM being configured.
- A scope indicator, so what the pane is scoped to is never a guess.

### Added — dictation analytics

Ported the analytics suite from vibe2text: sentiment scoring over a bundled
VADER lexicon, vocabulary and rhythm panels, trend charts, and the supporting
history schema.

### Added — Date & Time settings

A Date & Time section in Settings with time-zone selection, persisted through
app state and applied before first paint.

## [0.11.0] - 2026-08-28

Windows artifacts, built 2026-08-28 01:05 from `5f1375ca`, **unsigned** — the
first packaged build of the renamed product:

| Artifact                                            | SHA-256                                                            |
| --------------------------------------------------- | ------------------------------------------------------------------ |
| `PacketBench_0.11.0_x64-setup.exe` (NSIS, 85.1 MiB) | `dd65f12b80ceb8bb225be159e1211e211e1006fb5c87362f75b6d1079d55b500` |
| `PacketBench_0.11.0_x64_en-US.msi` (132.8 MiB)      | `19731f62cdb31c40bdb228117ceeadb7b4ea0c6a82ec10b99e99cc8c237b5cb7` |

> **Built, not accepted.** These compiled and bundled cleanly, but the
> interactive acceptance matrix has not run. The rename moved the Tauri bundle
> identifier and every one-shot data-dir, keyring, and localStorage migrator
> (`LEGACY_*` in both brand modules) has still only ever executed from a source
> build. Installing this over a machine carrying pre-rename `packetade` state is
> the untested path that matters. They live in
> `C:/Users/ianwalmsley/packetbench-build/release/bundle/`, not in the repo.

Gates at this tree: `cargo check` clean, 713 Rust lib tests + 31 `acp_stream`
passing, `tsc --noEmit` 0 errors, `pnpm lint` 0 errors, `vitest run` 2248/2248
across 259 files, `check:tauri-schema` clean.

### Superseded — the 2026-08-15 development build

Windows artifacts, built 2026-08-15 02:51 from `a9d5d702`, **unsigned**:

| Artifact                                         | SHA-256                                                            |
| ------------------------------------------------ | ------------------------------------------------------------------ |
| `PacketADE_0.10.5_x64-setup.exe` (NSIS, 89.4 MB) | `8c0233fe31a5b39fef0c1e98082c392054610ab892e7053d0b7fb21985977303` |
| `PacketADE_0.10.5_x64_en-US.msi` (139.5 MB)      | `fca82769b8b48115d35294b2b84ed4346370c92c2804628e8859f7fac2387b45` |

> **These are not the released 0.10.5.** The version was never bumped, so these
> installers carry the same `0.10.5` string as the artifacts recorded under
> [0.10.5] below while containing different code and hashing differently. They
> are a development build of unreleased work. **Bump the version before any
> release build of this branch**, and do not distribute these — an installer
> that claims a released version but is not it cannot be told apart by a user
> or an updater. **They are gone from disk** as of 2026-08-27: build output is
> redirected to `C:/Users/ianwalmsley/packetade-build`, which now contains only
> `debug/` — there is no `release/bundle/`. The hashes are retained here purely
> as provenance for a build that no longer exists anywhere.

> **Filenames intentionally read `PacketADE`.** These artifacts were built
> before the 2026-08-26 rename, so `PacketADE_0.10.5_*` is what the bundler
> actually produced and what the recorded SHA-256 values hash. The rename
> sweep (`5404fb85`) retro-renamed them to `PacketBench_*`, which made the
> provenance unverifiable — a hash table whose filename never existed proves
> nothing. Restored 2026-08-27. Do not let a future brand sweep touch these.

### Removed — the Syndicate execution-target integration

Syndicate has been separated from the Packet\* product family (operator
decision, 2026-08-27), and the integration is deleted rather than switched
off: the native controller commands and the relay device-half
(`src-tauri/src/commands/syndicate.rs`, `syndicate_relay.rs`), the frontend
store/lib/component surface (machines settings card, remote terminal pane,
Workspace-creation target, status-strip and picker branches), the
`kind: "syndicate"` execution-target variant, the Settings toggle the entry
below this one introduced, and the two controller-protocol conformance
fixtures shared byte-for-byte with Syndicate's repo. The generic SSH/remote
machinery, terminal panes, and Workspace model are untouched.

State written while the integration existed still loads: a persisted
`syndicate` execution target now degrades to `None`/local on both sides of
the DTO boundary instead of failing the state file, and unknown pane fields
were always ignored. No live pairings existed at removal time (no
`syndicate-controller-*` keys in the OS credential store), and any grant a
stray device still holds hard-expires at most 30 days after issuance.

The pre-removal implementation remains in history at `d87fb125` — the
`syndicate_relay.rs` there is the reference device-half implementation of the
controller relay protocol for the future Remote Agents work. The `dev/`
design documents (`dev/syndicate-*.md`, `dev/controller-protocol-device-relay-half.md`,
`dev/syndicate-proof/`) stay in the tree as historical records.

### Added — Syndicate integration toggle

Settings → Tools now carries an explicit switch for the Syndicate integration.
Turning it off closes every PacketBench-managed SSH forward, removes Syndicate
from new Workspace targets, and pauses remote panes. Pairings, Workspace data,
pane identities, cursors, and Host sessions are all retained. A native
fail-closed gate backs the preference, so the boundary holds against a direct
or racing invoke rather than relying on the UI alone.

Existing installations default to **enabled**, so paired machines keep working
without intervention.

Turning it back **on** is now the confirmed direction. Enabling restores full
controller authority to every already-paired Host — including `terminal.input`,
which executes code as the Syndicate OS user — without asking the server for a
fresh approval, so the confirmation names how many machines that is and calls
out the ones that hold terminal input. Disabling stays confirmed too, but for a
different reason: to report the remote work it pauses.

### Fixed — sidecar API-agent spend was invisible to the budget guardrails

Sessions on the sidecar providers (`api-claude-oauth`, `api-openai-agents`)
computed cost for the flight rollup but never wrote a row to the
PacketBench-owned usage ledger (`~/.packetbench/usage.jsonl`) — the input the
analytics rollup and the daily/monthly budget guardrails read. Since the OAuth
removal turned those providers into metered API-key spend, real money was
missing from the caps.

The sidecar `turn_summary` handler now appends a ledger row per turn delta,
using provider and model recorded at session start (and kept in step with
mid-session model swaps). Rows store the vendor's raw token counts and price
through the same OpenAI superset-prompt normalisation as the in-process
providers; the flight cost rollup is unchanged, and the retired Codex
cumulative-snapshot path still contributes only deltas, so nothing is counted
twice.

### Fixed — an expired device grant retried forever and still read as active

Syndicate grants last 30 days and cannot be renewed, so every paired device
reaches this. A Host answers an expired grant with `DEVICE_UNAUTHORIZED` while
leaving the device's status `active`, and PacketBench understood neither half:

- The terminal pane's stop condition matched fragments of the error _message_,
  and `DEVICE_UNAUTHORIZED` was not among them — so an expired grant re-signed
  `session.attach` every five seconds indefinitely. `MACHINE_MISMATCH`,
  `INVALID_SIGNATURE`, `AUTH_REPLAY`, and `REQUEST_EXPIRED` fell through the
  same gap.
- The machines card kept advertising "Full coding control" for a grant the
  server would never honour again.
- Nothing carried the grant's expiry, so no warning was possible before the
  cliff — only a diagnosis after it.

The protocol has always answered with a typed `error.retryable` and a stable
`error.code`; PacketBench flattened both into a sentence and then tried to read
them back out of it. The native layer now forwards the typed fields verbatim,
retry decisions branch on `retryable`, grant state branches on `code`, and the
Host's `expiresAt` reaches the machines card — which warns in the last week of
a grant's life and states plainly when one has expired. Transient Host
conditions the protocol marks retryable, and local socket faults, still
reconnect exactly as before.

### Fixed — the kill switch disarmed the remedy

Revoking a device grant and forgetting a device locally both refused to run
while the integration was disabled, and the Revoke button was disabled with
them. Disabling Syndicate is precisely what a user does on suspicion of
compromise, and doing so left the grant live on the Host until it expired.
Both now work while disabled: revoking briefly raises the managed forward and
closes it again, and forgetting is local-only and never needed transport at
all. The machine row gained an explicit "forget locally" action for an
unreachable Host, which deletes the OS-keychain key without pretending the
grant was revoked.

### Fixed — a restored remote pane rendered as detached

A mount-time reset clobbered the restored session state of a pane holding a
live Host session, so it displayed "detached" whenever auto-start was off. The
same reset cleared the start guard without clearing the session identity, so
after re-pairing a machine the new device attached the previous device's
session and the Host answered `SESSION_NOT_OWNED`. The reset now runs only when
the paired device actually changes, and clears the identities with it.

### Fixed — closing a pane could drop it while the remote session ran on

The terminal header's close button called its kill handler without awaiting or
catching it. Where that handler can reject — stopping a remote session can fail
— the pane disappeared, the rejection went unhandled, and the Host session kept
running with nothing shown. The pane now stays put and surfaces the reason.

### Changed — PacketRelay carrier status is throttled

Every successful controller RPC recorded which carrier served it. With 25 ms
output polls and one request per keystroke that was roughly 40 `localStorage`
writes a second per active pane, each re-rendering the machines card, to move a
timestamp nobody reads at that resolution. Unchanged carriers now persist at
most once every 30 seconds; a change of carrier is still recorded immediately.

### Changed — pairing tolerates additive Host responses

The controller protocol pins the pairing _invitation_ field-by-field and backs
it with a fixture shared byte-for-byte with Syndicate, but says nothing about
the claim response. PacketBench rejected unknown fields in both, which meant any
additive change to the claim response would have silently broken pairing on
already-shipped builds. The claim response and its device record are now
forward-compatible; the invitation envelope stays strict, deliberately.

## [0.10.5] - 2026-08-07

Windows artifacts, built 2026-08-07 19:32, **unsigned**:

| Artifact                                         | SHA-256                                                            |
| ------------------------------------------------ | ------------------------------------------------------------------ |
| `PacketADE_0.10.5_x64-setup.exe` (NSIS, 89.0 MB) | `501efd6923de88e1b9bf58112f5e6a39d54d4ba8b4761c8009a4bdb617b38ab5` |
| `PacketADE_0.10.5_x64_en-US.msi` (138.8 MB)      | `b2cc1d99caa8faef0436ede87cb78b16bcecdadd4b74c9957302f2e5e8893626` |

> **Filenames intentionally read `PacketADE`.** These artifacts were built
> before the 2026-08-26 rename, so `PacketADE_0.10.5_*` is what the bundler
> actually produced and what the recorded SHA-256 values hash. The rename
> sweep (`5404fb85`) retro-renamed them to `PacketBench_*`, which made the
> provenance unverifiable — a hash table whose filename never existed proves
> nothing. Restored 2026-08-27. Do not let a future brand sweep touch these.

Workspace quality-of-life work, plus four defects the accompanying pane-system
review turned up. Two of those defects corrupted live agent sessions on
completely ordinary paths, so they are the reason this release exists.

### Fixed — the mosaic could render one pane twice, and lose others

`buildPresetTree` addressed fixed preset slots through
`paneIds[Math.min(i, len - 1)]`. A pane count the preset did not fill therefore
repeated the last id, and a count past its capacity dropped ids outright:

| panes | tiles rendered | effect                                             |
| ----- | -------------- | -------------------------------------------------- |
| 3     | `a b c c`      | pane `c` mounted **twice** — two PTYs for one pane |
| 5     | `a b c d e e`  | same, for `e`                                      |
| 7     | `a b c d e f`  | pane 7 had **no tile at all**                      |
| 8     | `a b c d e f`  | panes 7 and 8 invisible                            |

It fired on a cold rebuild — app restart with 3 panes, or creating a workspace
with 3 agents. Rows are now chunked from the real id list, so a short last row
is short and a long list grows more rows.

### Fixed — adding or closing a pane restarted a running agent

`MosaicRoot` flattens each split into a Fragment keyed by path, so a tile that
changes **depth** is remounted by React — which runs `useTerminalSession`'s
cleanup (`killPty`) and then auto-starts a fresh PTY. `addToTree` nested the
last leaf to make room and `removeFromTree` collapsed a single-child split back
to a bare leaf, so **adding a terminal beside a working `codex` restarted that
`codex` mid-task**, and closing the middle of three panes restarted the
right-hand one.

`addToTree` is replaced by `appendPane`, which pushes onto the root split's
children; `removeFromTree` now keeps single-child splits, which render
identically (no splitter, full bounds). This also ends the 50/25/12.5/12.5
sliver cascade — four panes added one at a time now match four created
together.

### Fixed — zoom stole Escape from dialogs and from terminals

The zoom-exit handler registered when zoom was set, which is before any dialog
opened afterwards registers its own, and window listeners fire in registration
order. `defaultPrevented` could therefore never order the two: zoom ran first,
called `preventDefault`, and `Modal` then bailed on exactly the flag zoom had
just set. **Zooming a pane and opening any dialog meant Escape closed the zoom
and left the dialog open.** Zoom now yields to any open modal, to the review
surface, and to a focused terminal — leaving vim's insert mode no longer
discards the zoom. A zoom stranded in a workspace the user navigated away from
is also cleared instead of lingering invisibly.

Because a focused terminal now keeps its Escape, the way out of a zoomed shell
is the tile's own zoom button; the on-screen hint says so.

The review guard is **scoped** to a review of the pane actually zoomed.
`reviewStore.open` is a global flag that nothing resets on a view change, so
reading it unscoped left Escape-to-exit-zoom permanently dead after opening
review in Agents and switching to Workspace — with the un-exitable zoom and the
"Press Esc" hint both still on screen. The listener also stands down entirely
while the Workspace surface is off screen, so Escape pressed in Agents no
longer un-zooms a hidden pane.

`PathContextMenu` and `Tooltip` now mark their Escape handled. Neither did, and
`PathContextMenu` listens on `document` — which runs before every window
listener — so right-clicking a file path in a zoomed tile and pressing Escape
closed the menu **and** exited the zoom.

### Fixed — one `y` approved every waiting agent

`useApprovalShortcuts` bound bare `y`/`n`/`Escape` on `window`, gated only on
that pane's own `showApproval` flag. Every waiting pane therefore had a live
listener, and one keypress ran all of them — each writing `y\n` into **its own**
PTY. With two agents waiting, approving one silently approved the other, so an
agent the user had never read proceeded with whatever it was asking permission
for. `preventDefault` could not help: the listeners share a target, so only
`stopImmediatePropagation` would have stopped a sibling.

Ownership is now decided inside each handler. One pane waiting owns the
keypress whether or not it has been clicked — that is the common case and an
unambiguous one. With several waiting, only the active pane answers; with
several waiting and none active, nothing answers, and the user picks a pane or
uses that pane's on-screen Approve/Deny buttons.

### Fixed — closing one pane reset every splitter in the workspace

`removeFromTree` rebuilt every split it walked, dropping `splitPercentages`
even on splits that had lost no child. Closing one tile in a hand-sized
four-tile workspace snapped all the remaining boundaries to even — and, now
that layouts persist, would have done so permanently. Only the split that
actually loses a child drops its (now wrong-length) array.

### Added — workspace tile layouts persist

The mosaic tree was component state, so every restart rebuilt the layout from
the pane-count preset and a hand-arranged workspace was lost. It now round-trips
through `Workspace.layout`.

Only a **user gesture** writes a layout — one write per completed drag or resize,
never per drag frame, and never on pane add/remove. That last exclusion is
deliberate: adding panes appends them to the root row, so persisting it would
have frozen six panes added one at a time as six ~16% columns forever, quietly
retiring the pane-count preset that used to heal exactly that on the next
launch. Reconciliation appends new panes on load anyway, so the restored tree
matches what was on screen.

A release event also fires mid-drag, with the dragged tile collapsed to 0% — the
library's drag source hides the tile on drag start and only `onChange` is
suppressed. Saving that would restore an invisible pane, so a tree carrying a
collapsed split is refused; the real drop fires again with sane geometry.

A saved layout is a cache of an arrangement, never the truth about which panes
exist, so it is reconciled against the real pane list on load: leaves whose pane
is gone are pruned, panes it never saw are appended, duplicates are dropped, and
a malformed or unusable tree falls back to the preset. Rearranging tiles does
not bump the workspace's `updatedAt`.

### Added — the Fleet sidebar expands

Workspace rows now have a chevron and an always-visible `+`. Expanding a row
shows its live panes as children — click to focus, hover-X to close, with
terminal panes killing their PTY first — followed by a lazy `FILES` tree rooted
at the project path. Clicking a file opens it as a tile. Expansion state
persists, so a tree you opened survives view switches and restarts. Search
results stay flat. SSH workspaces say file browsing is local-only rather than
failing.

### Added — WSL, File Viewer, and Markdown Viewer in the session picker

WSL is a first-class row rather than a value buried in the Terminal row's shell
dropdown. It is still exactly a Terminal pane carrying a `wsl` shell selection,
so it reuses the whole existing PTY launch path; Windows-only, and hidden when
no distro is installed.

File Viewer and Markdown Viewer create a new `kind: "file"` tile, so a file can
sit beside a running agent instead of only in the right-dock Editor. The tile is
a thin wrapper over the existing editor: the same path open in the dock and in a
tile is **one** buffer with one dirty flag and one save path. Markdown Viewer
only differs by filtering the picker to `.md`/`.mdx` and opening rendered.

There is still no Chat row in this picker — API conversations belong to Agents.

### Testing

`src/lib/__tests__/mosaicPresets.test.ts` is new. The module had no test file at
all, which is why the first two defects above were live. Its load-bearing
property is that the leaves of any tree the module produces are exactly the pane
ids, once each.

## [0.10.4] - 2026-08-06

Closes all twelve P1 findings from the 2026-08-05 deep review. Every fix
carries test evidence; none has yet been exercised in a packaged build, which
is what this release exists to make possible.

### Security — MCP read-only sessions now use an allowlist (2026-08-06)

**This changes behavior you may notice.** A read-only agent session previously
decided whether an MCP tool could run by checking its name against a list of
mutating verbs. That list let real write tools through: `edit_file`,
`apply_patch`, `commit`, `mkdir`, `chmod`, `exec`, `git_commit`,
`append_to_file`, and `put_object` all executed in sessions users had marked
read-only.

A tool now runs in a read-only session only if the MCP server annotated it
`readOnlyHint: true`, or you granted it explicitly in the MCP Hub. Anything
unrecognized is refused — unknown is not read-only. The verb list survives as a
floor beneath the allowlist, so an obviously mutating tool stays blocked even
if a server claims it is read-only.

Many MCP servers publish no annotations at all. Their tools will be denied in
read-only sessions until you allow them in the MCP Hub or enable writes for
that session; the denial message names both remedies. This is deliberate: the
previous behavior silently ignored an explicit user choice.

### Security — the sidecar protocol now has a version floor (2026-08-06)

Protocol v11 moved MCP trust authority into the session start request. A
sidecar older than v11 does not reject that field — it ignores it and then runs
every MCP server unfiltered, while appearing to work. Version mismatches were
previously a log warning.

Sessions are now refused outright when the sidecar advertises a protocol below
v11, and the status chip reports the incompatibility instead of failing
silently. Newer-than-expected versions still warn only. The
`PACKETBENCH_SIDECAR_PATH` and `PACKETBENCH_NODE_PATH` overrides now require a
debug build or an explicit opt-in, because a substituted sidecar receives live
provider API keys.

### Fixed — process lifecycle, Flight state, and release integrity (2026-08-06)

- Closing a terminal pane, and quitting the app, now terminate the whole agent
  process tree. Previously only the immediate child was signalled, so
  `claude` / `codex` processes survived untracked with nothing able to find
  them. App exit had no PTY cleanup at all, and the startup orphan reaper read
  a registry that nothing ever wrote to.
- The Flight Reviewer Gate can now record a verdict. Nothing in the backend
  ever wrote the field, so enabling the gate blocked acceptance permanently and
  dead-ended bounded-autonomy graph mode. The verdict is now backend-owned and
  survives a whole-slice save and a restart.
- Flight attempts left `Queued` / `Provisioning` / `Running` by a restart are
  reconciled to `Failed` and their worktrees swept. They previously persisted
  forever, leaking worktrees and `pkt/*` branches and blocking every future
  launch on the same path with a collision error.
- Saving app state no longer spins on the UI thread. Synchronous save commands
  busy-waited on a lock that async writers could hold indefinitely, which could
  freeze the app with no timeout and no error. A poisoned lock no longer ends
  persistence for the rest of the session.
- Release gates now execute. `release:readiness` previously reported quality
  gates as passing whenever the npm script _name_ existed, without running
  anything; `release:gate` accepted the updater signing key as evidence of a
  code-signing certificate, and never ran automatically during a build.
- The bundled Node runtime is verified against digests pinned in the repository
  and GPG-verified against a Node.js release key. The checksum file previously
  travelled the same unauthenticated channel as the archive it verified, and a
  self-written cache marker made one bad fetch permanent.

### Added — accepted Flight attempts can now be landed (2026-08-06)

Accepting an attempt used to mark it complete, remove its worktree, and stop —
leaving the branch unmerged with no way to reach it from the app unless you had
ticked the draft-PR box before launching.

- A completed attempt now offers **Land** and **Open PR** on its tile. Land
  squash-merges the branch through the same path the conversation worktree bar
  uses, so it inherits that path's refusals: it declines on a dirty root
  checkout, resets on conflict, and reports an empty branch as a failure rather
  than claiming a landing that did not happen. Land is unavailable for SSH
  attempts, which route through Open PR instead.
- Re-opening the launch dialog on an existing flight no longer silently
  rewrites its "publish attempts as pull requests" setting to the global
  default.
- Launching now shows provisioning progress, and a partial launch reports how
  many agents actually started instead of presenting a total failure while
  agents run and spend.

### Changed — Accept and Reject on an attempt now confirm first (2026-08-06)

Both actions force-remove the attempt's worktree, destroying uncommitted work,
and were single unlabelled clicks — while deleting a whole Flight, a rarer and
more deliberate act, showed a confirmation. Both now confirm, using the same
live dirty-worktree probe the Flight delete dialog uses, and the dialog states
what will be destroyed, what will be published, and that the branch is kept so
Land and Open PR still work afterwards.

### Fixed — modal focus, Escape order, and pane cleanup (2026-08-06)

- Dialogs now trap and restore focus and expose proper dialog semantics to
  assistive technology. Escape closes the top-most dialog: previously a
  confirmation opened inside another dialog closed the outer one instead.
- View-switch keyboard shortcuts no longer fire while a dialog is open, where
  they could unmount the view and discard a half-typed form without warning.
- Closing a terminal pane while its session was still starting no longer
  strands the process, and no longer leaks its output subscriptions.
- The status dot for a flight no longer changes colour when the row is
  selected.

## [0.10.3] - 2026-08-02

### Added — selectable local terminal shells (2026-08-02)

- Raw local Terminal panes can now use Auto-detect, PowerShell 7, Windows
  PowerShell, Command Prompt, Git Bash, WSL, Bash, Zsh, or an allowlisted
  custom shell.
- An app default, active-Workspace override, and per-session override resolve
  in pane → Workspace → app order. Leaving all settings untouched falls
  through to Auto, which preserves the previous `powershell`/`bash` launch.
- Settings detects installed shells and WSL distributions, links official
  installation guidance where relevant, and provides a bounded test probe.
- Terminal pane headers now show the effective shell identity, including the
  shell selected by Auto and the chosen WSL distribution.
- Dedicated coding-CLI panes remain unchanged; SSH Terminal panes open the
  remote host's login shell.

### Fixed — Claude Code native status line (2026-08-02)

- Claude Code panes now receive a PacketBench-owned, session-scoped status-line
  collector through Claude's supported `--settings` option. The native pane
  bar no longer depends on a separately installed `claude-code-tools` script
  or a user-edited `~/.claude/settings.json`.
- The collector refreshes the existing model/context/cost state every five
  seconds and works when Claude invokes it through either Windows PowerShell
  or Git Bash. Global Claude settings are left untouched.
- A visible collecting state occupies the native status row until Claude
  emits the first session snapshot instead of making the bar disappear.

### Fixed — runtime authority and operational truth (2026-08-01)

A correctness pass over the places where PacketBench's UI could report something
the runtime had not actually done.

- Closing a Terminal pane now confirms before destroying live work.
- Anthropic edit tool calls correlate exactly by `toolUseId`, so a diff can no
  longer be attributed to the wrong edit.
- Agent Stop and Side Chat cancellation now wait for the runtime's
  acknowledgement instead of optimistically clearing the UI.
- Monitor surfaces its own failures rather than silently showing stale state.
- Cancel-pending ownership has a single canonical owner across both transports.
- Repository and Git-host authority changes invalidate stale sessions instead of
  letting a previous host's token remain in effect.
- Settings persistence reports the truth: controls that were not enforced are
  now hidden rather than shown as active.
- SSH passwords follow a full OS-keyring set/delete lifecycle.
- The sidecar protocol advanced to v11, freezing per-session MCP trust
  authority at session start on both transports.

### Changed — API agents now use API keys, never subscription logins (2026-07-31)

PacketBench no longer signs API agents in with a Claude.ai or ChatGPT
subscription. Every row in the Agents provider picker authenticates with an API
key from Settings → API Keys.

Anthropic's
[legal and compliance policy](https://code.claude.com/docs/en/legal-and-compliance)
states that it "does not permit third-party developers to offer Claude.ai login
or to route requests through Free, Pro, or Max plan credentials on behalf of
their users", and the Claude Agent SDK overview tells developers to use API key
authentication instead. The SDK itself is the sanctioned path — only the
credential was wrong.

- **"Anthropic (Subscription)" is now "Claude Agent SDK (API)".** It is the same
  agent it always was — Claude Code's own harness, with the targeted edit tool,
  structured plan blocks, real permission modes, MCP, and `~/.claude` settings
  sourcing that the leaner in-process "Claude (API)" row does not have. It now
  bills to your Anthropic API key. Your existing conversations on it keep
  working; nothing to migrate. If you have no Anthropic key configured, starting
  a session fails immediately with a pointer to Settings rather than quietly
  using whatever credential your machine happens to have.
- **"OpenAI (ChatGPT Plus/Pro)" has been removed.** It ran the Codex CLI as a
  subprocess on a ChatGPT subscription login. Without that subscription it
  offered nothing over "OpenAI Agents SDK (API)", which reaches the same OpenAI
  models with your OpenAI API key — and, unlike Codex, can pause for per-tool
  approval. Every provider now supports interactive approvals.
- **Existing Codex conversations are safe.** They still open and read exactly as
  before, with the full transcript, diffs, plan, and tool history. They are
  marked read-only: sending a new turn tells you the provider is gone and points
  you at OpenAI Agents SDK (API) instead of failing with a cryptic error. They
  are never silently re-pointed at another vendor's key.
- **Flight reviewers and the Plan panel handoff** that defaulted to Codex now
  use OpenAI Agents SDK. A saved Reviewer Gate policy pinned to Codex resolves
  to the replacement so the review still runs — it never silently passes.
- **Terminal sessions are unchanged.** `claude` and `codex` CLI panes, the
  multi-account CLI feature, and Settings → AI Providers → Subscriptions all
  keep using your subscription logins. That is ordinary use of the vendors' own
  tools and is explicitly unaffected.

### Changed — the AI features that used to spend your subscription now use your API key (2026-07-31)

Five features called a model without ever asking you which one: importing a
spec into issues, Code Quality's "explain this error" and "summarize", writing
a pull-request description, reviewing a pull request, and drafting a patch.
All five quietly used your Claude subscription login.

- **They now run on the cheapest API provider you have configured.** PacketBench
  prices the providers you hold a key for against a representative small task
  and picks the cheapest — so if you have both an Anthropic and an OpenAI key,
  these background jobs land wherever they cost least, and the main agent
  conversation you actually chose is untouched.
- **You can override the choice.** Settings → Tools → Provider Routing has a new
  **Auxiliary AI tasks** section that pins a provider and model per task. That
  card used to be decorative; it now decides something real.
- **Local models are never chosen for you.** Ollama would win any
  cheapest-provider ranking at $0 — including when the daemon is not running —
  so it is only ever used if you pick it explicitly.
- **With no API key configured, these features stop and say so**, pointing you
  at Settings → API Keys. They never fall back to a subscription login.

### Added — a targeted edit tool for the API providers (2026-07-31)

- **Claude (API), OpenAI (API), MiniMax, OpenRouter, and Ollama agents can now
  edit part of a file instead of rewriting all of it.** Previously the only way
  for these agents to change three lines was to regenerate the entire file.
  That is slow, it is billed at the expensive output rate, and smaller models
  frequently mangled the untouched parts.
- **An ambiguous edit is refused, not guessed.** If the text the agent wants to
  replace appears more than once, the edit fails and says so rather than
  silently changing the first occurrence.
- **Approvals work exactly as before.** The edit goes through the same approval
  prompt as a whole-file write, and the diff you are shown is produced by the
  same code that performs the edit — what you approve is what lands.
- **Local workspaces only for now.** Agents working over SSH continue to use
  whole-file writes.
- **If you use an agent profile with a fixed tool list**, add `edit_file` to it;
  profiles that name their tools explicitly will not pick up the new one on
  their own.

### Fixed — local Ollama models were silently running out of context (2026-07-31)

- **Every local model has been quietly truncating your conversation.** Ollama's
  OpenAI-compatible endpoint has no way to set the context size, so models ran
  at the daemon's small default no matter how long the conversation was — and
  Ollama drops the front of the conversation rather than reporting an error.
  This is what "the local model forgot the system prompt" and "it loops on
  tools" actually were: a configuration fault, not model quality.
- **PacketBench now asks each model what context window it was trained for** and
  uses it, up to a ceiling you can change in Settings → Tools → Provider
  Endpoints (16k by default, which is four times Ollama's own).
- **Models stay loaded for 30 minutes** instead of unloading after 5, so a
  normal agent turn no longer pays for a cold reload part-way through.
- **If a conversation does overflow, you are told.** The turn carries a notice
  naming the limit and pointing at the setting, instead of the model quietly
  losing the beginning of its instructions.
- **Asking a model without tool support to use tools now fails in one clear
  line** naming the model, rather than looping. The model picker still lists
  models that cannot run tools — check the model before starting an agent tile.

### Fixed — launching a Flight on the default agent failed with a misleading error (2026-07-31)

- **"No API key configured for claude" was wrong twice over**: there is no
  provider called "claude", and adding a key would not have helped. PacketBench
  was deriving the wrong internal name when starting a Flight attempt, and the
  one agent it broke on happened to be the default. Flights now launch on every
  provider, and an unrecognised one is reported by name instead of being turned
  into a dead end.

### Added — prompt caching on the Claude API path (2026-07-31)

- **Claude API conversations now reuse their cached prompt instead of paying
  full price for it on every step.** An agent turn can call tools dozens of
  times, and each call re-sent the entire system prompt, the whole tool list and
  the full conversation so far — at the full input rate, every time. Those
  tokens are now served from Anthropic's prompt cache at a tenth of the input
  rate. On a long tool-using turn the input bill is expected to drop by roughly
  60–80%; the longer the turn, the bigger the share.
- **The trade-off, stated plainly.** Writing to the cache costs about 25% more
  than plain input, so a single question you ask and then abandon is slightly
  _more_ expensive than before. The cache pays for itself from the second step
  onward, which is the overwhelming majority of real agent work.
- **Caching sticks for five minutes, and every reuse resets that clock.** A turn
  that keeps working never falls out of cache. Come back to a conversation after
  a long coffee break and the next message pays to warm the cache again.
- **Nothing about your conversations changes** — the request is identical apart
  from asking Anthropic to cache it. This affects the **Claude (API)** row only;
  the Anthropic subscription row already runs its own caching inside the Claude
  Agent SDK.
- For anyone who wants to confirm the saving, `node scripts/cache-hit-rate.mjs`
  prints the cache hit rate per model from your local usage log.

### Fixed — MiniMax now points at the documented API host (2026-07-31)

- **MiniMax was calling a legacy hostname that no longer appears in MiniMax's
  own documentation.** It now uses `https://api.minimax.io/v1`, the published
  global endpoint. If you are on a mainland-China plan, Settings → Tools →
  Provider Endpoints has a **MiniMax base URL** field — switch it to
  `https://api.minimaxi.com/v1`, since a key is valid against only one host.
  (The Ollama field lives in the same card and is unchanged.)
- **MiniMax M3 lost its train of thought between tool calls.** M3 reasons
  _between_ tool steps, and MiniMax's API requires the model's reasoning to be
  handed back with each follow-up request to keep that chain intact. PacketBench
  was dropping it, so every tool result arrived with the model's own prior
  reasoning erased — which made M3 look far weaker at multi-step work than it
  is. The reasoning is now captured and replayed. As a bonus, it shows up in the
  thinking panel where it belongs, instead of as raw `<think>` markup in the
  middle of the reply.
- **Auto-failover no longer retries into the same wall.** When MiniMax reported
  an exhausted quota, PacketBench would announce "retrying on MiniMax M2" and
  retry against a different MiniMax tier — which draws on the same account
  quota, so the retry could not possibly succeed. Auto-failover now recognises
  account-level exhaustion (a spent quota, a drained credit balance, a billing
  limit) and surfaces the real error instead of a retry that was never going to
  work. Ordinary rate limits and overload errors still fail over to a cheaper
  tier as before, for every provider.

### Fixed — OpenAI-family conversations report their cached tokens (2026-07-31)

- OpenAI, OpenRouter and MiniMax conversations were recording zero cached
  tokens no matter what the provider actually reported, so cached input was
  priced at the full rate. The real figures are now read and priced correctly.
  These providers were already caching automatically — the saving was real, it
  just was not showing up in the numbers the budget guardrails act on.
- OpenAI conversations also now send a stable per-conversation cache key, which
  improves the odds of a cache hit across the steps of a long turn.

### Fixed — historical spend repriced at the corrected rates (2026-07-31)

- **Your recorded spend history changed, on purpose.** Until the rate-table
  correction earlier the same day, PacketBench priced Claude Opus 4.5–4.8 at the
  deprecated Opus 4.1 rate (`$15/$75` instead of `$5/$25`), Claude Haiku 4.5 at
  the retired Haiku 3.5 rate (`$0.80/$4` instead of `$1/$5`), and the MiniMax
  M2 family at `$0.40/$2.20` instead of the official `$0.30/$1.20`. Every dollar
  figure written to disk before that fix inherited the error: Opus spend
  overstated roughly **3x**, MiniMax M2 roughly **1.6x**, Haiku 4.5 understated
  roughly **20%**.
- A one-time migration now rewrites those figures on first launch. It runs over
  `~/.packetbench/usage.jsonl` and the `costUsd` stamped on messages in
  `~/.packetbench/conversations/*.json`, and it **recomputes each figure from that
  record's own stored token counts** — nothing is scaled or estimated. Each
  record is priced at the rates in effect on **its own date**, so a turn that
  predates a scheduled rate change keeps that era's rate.
- **Why it matters even though the Cost Dashboard is gone.** Those numbers are
  no longer _reported_ anywhere, but they are still what the budget guardrails
  hard-stop on. A 3x-overstated history makes a daily or monthly cap block a
  launch at about a third of the spend you actually authorised. Repricing is
  what keeps the caps honest.
- **Recoverable and visible.** The originals are copied to
  `usage.jsonl.pre-reprice-<date>` and `conversations.pre-reprice-<date>/`
  before anything is written; those backups are never overwritten and never
  deleted. Every rewritten record carries `repriced_at`/`repricedAt` plus the
  previous value in `cost_usd_before`/`costUsdBefore`, so no figure changes
  without a trail. Records that recompute to the value already stored are left
  untouched and unmarked.
- **Left alone, deliberately:** records that do not carry enough token detail to
  be recomputed, and records for a model the rate table does not know (guessing
  would be worse than a stale number). Also untouched are the per-flight
  rollups in `state.v1.json` (`flights[].total_cost`, `attempts[].cost`,
  `tasks[].cost`) — they store a single collapsed token total with no
  input/output/cache split and no per-turn model, so they cannot be recomputed
  without inventing numbers. **Consequence: a per-flight budget cap can still
  trip early on a flight whose spend predates the fix.** Raise that flight's
  cap, or clear it, if it blocks you.

### Removed — cost reporting surface (2026-07-31)

- The Cost Dashboard is gone. Its view, its command-palette and Status Strip
  entries, the Settings jump link and usage-analytics card, and the `/usage`
  slash command were all removed. Reopening the app on that view lands on
  Welcome instead of an empty shell.
- The toolbar's live spend chip is gone with it. Alongside the dashboard it was
  the reason a running dollar total was recomputed across every message of every
  open conversation on each streaming frame, so removing it makes long
  conversations noticeably cheaper to stream.
- Smaller dollar readouts went too: the session cost on the conversation meta
  line, the Cost row in the Agent inspector, and the per-turn cost revealed on
  hovering a message's token count. Token counts themselves stay exactly where
  they were.
- **Budgets still work, and they are still enforced.** Daily, monthly, and
  per-session spend caps, provider and flight caps, the warning threshold, and
  the hard stop that blocks a launch over budget are unchanged — they moved to
  Settings → Flights & Autonomy, under "Budget guardrails". Threshold
  notifications still fire on a background refresh that no longer depends on any
  view being open, and the bounded-autonomy cost limit that stops a runaway
  flight is untouched.
- The reason for the change: a reporting surface has to be maintained, verified
  against changing vendor rates, and trusted. Spend control is worth that; a
  spend report was not.

### Changed — main shell and right-dock ownership (2026-07-30)

- Added one surface-scoped `RightDock` controller that owns the width,
  stacking, and visibility of every right-side panel. Inspector, Git, and
  Editor are mutually exclusive owners behind a single resizer with
  available-width clamping and automatic collapse below a minimum center
  width, so they can no longer collapse the main canvas at the supported 800px
  minimum. Preview state is conversation-scoped, and Hide/Close are
  authoritative rather than disagreeing with the visible tab.
- Added a single route registry that owns the left rail, command palette,
  Status Strip labels, placements, and hotkeys. Dictation collapses to one
  route identity, and the previously missing Agents and Flight Deck
  destinations are reachable from the palette. (Costs was reachable too, until
  the cost reporting surface was removed the following day — removing its one
  registry row took it out of the rail, palette, hotkeys, and Status Strip
  together, which is what the registry was built to do.) Hotkeys now match the
  physical
  `KeyboardEvent.code`, so the Ctrl+Shift chords work on AZERTY, QWERTZ, and
  Dvorak layouts.
- Gated local-only actions — Preview, applied Review, Undo, Plan handoff, and
  diff — on SSH conversations instead of calling local filesystem operations
  for a remote workspace. The `/new` and `/review` slash commands no longer
  silently convert an SSH conversation to local, and diff failures surface
  instead of rendering as `+0/−0`.
- Inspector is owned solely by the Agents view. The App-level Workspace
  inspector, which mounted beside a CLI-first Workspace for any globally
  selected Agent conversation, is removed.
- Reconnected the lightweight Editor as a first-class `RightDock` panel:
  `editorStore.openFile` has production callers, dirty buffers are protected
  against pane/tab/Workspace changes, and the panel's wired Markdown viewer
  fulfils the Files → Preview path that Files had been advertising without
  wiring.

### Changed — deletion, keyboard, and creation safety (2026-07-30)

- Every destructive action now asks first, through one shared confirmation
  dialog. Deleting an SSH server previously fired immediately — the only
  component that carried a confirmation was never imported and could not be
  reached — and the new dialog names the real consequences by cross-referencing
  connection state, conversations running on that host (including mid-turn
  ones), running flight attempts, and bound workspaces. The sweep also replaced
  every remaining native browser confirmation and added confirmations to
  fifteen destructive paths that had none: API-key, GitHub-token and
  PacketAgent-token deletion, crash files, the trust audit, prompt templates,
  memory patterns and clear-all, CLI-agent delete and built-in reset, MCP
  servers, code-quality history, and project-notes archiving. Anonymous trash
  icons gained accessible labels, and a repository test now fences the idiom.
- Ctrl+K no longer steals keystrokes from a focused terminal, text field, or
  editable region: the shortcut yields, and the keypress reaches the shell as
  its normal kill-line. Escape still dismisses modals everywhere, but no longer
  takes the key away from a terminal to cancel dictation.
- Closing the app now confirms only when live work would actually be destroyed
  — running terminals, mid-turn conversations, or queued/provisioning/running
  flight attempts — and lists what would be terminated. Closing an idle app
  stays instant.
- Modals close on Escape by default. Every modal's close button already
  advertised "Close (Esc)", so the previous default made that promise untrue
  app-wide; the transient PTY modal keeps an explicit opt-out because the
  terminal owns Escape there. The New Issue form was a hand-rolled overlay and
  is now a real modal, gaining Escape and a labelled close button.
- Fixed the Issues board dropping its sixth column ("Done") onto a second row
  with a dead right half at every viewport, a regression from when "Needs
  Attention" was added.
- Unified workspace creation. A workspace can no longer be created without a
  project path — the instant paths (Ctrl+N and the sidebar) open the OS folder
  picker when no path is known and create nothing if it is cancelled, instead
  of silently making a zero-pane workspace at an empty path. New workspaces
  auto-name Workspace, Workspace 2, and so on rather than the hardcoded "New
  Session", drifting labels and tooltips were corrected to one noun, the Fleet
  sidebar's duplicate top and bottom create buttons are now a single labelled
  action, and workspace creation is reachable from the global "+ New" menu and
  the Ctrl+K command palette.

### Changed — deleting something now cleans up after it (2026-07-30)

- Deleting a Flight cancels its work instead of abandoning it. Every attempt
  that has not reached a terminal state is cancelled through the normal cancel
  path first — including attempts sitting in review, whose worktree is still on
  disk — and only then is the Flight removed. The confirmation now says what
  will actually happen: which attempts will be cancelled and in what state they
  are, which worktrees will be removed, which of those have uncommitted changes
  or could not be checked, and that any live tasks are left running. If one
  attempt refuses to shut down, the rest still get cleaned up and the Flight is
  still deleted; a message names the branch and what may have survived, so
  nothing fails silently. Deleting a Flight also no longer records a
  completion event or generates a retrospective for the record being discarded.
- Deleting an agent conversation now discards its worktree and `pkt/…` branch
  rather than leaving them on disk with nothing in the app pointing at them.
  Because deleting the conversation removes the last reference to that
  directory, uncommitted work is discarded rather than the delete being refused
  — so the confirmation says so up front, in plain terms, naming the exact
  worktree path and branch and changing its button to "Delete and discard
  changes". A worktree whose status cannot be read is reported as possibly
  having changes rather than assumed clean. Worktrees that were never created,
  already discarded, or live on a remote host are left alone. Both places a
  conversation can be deleted from now show the same dialog, and the workspace
  delete dialog no longer calls a workspace a "session".
- Deleting an SSH server now removes its saved password from the OS keyring,
  including any copy left under the app's previous keyring name, so the secret
  cannot come back if a server id is later reused. Servers that use key
  authentication delete cleanly, and a keyring problem can never block the
  delete itself. The confirmation no longer claims the password is left behind.

### Changed — cleanup that reports the truth, and the last missing deletes (2026-07-30)

- Cleaning up a flight attempt's worktree no longer claims success it did not
  have. If the working tree cannot be removed — it is dirty, locked, or the
  remote host is unreachable — the failure is now reported back to the app with
  the path, the branch, whether the branch survived, and which files were dirty,
  instead of being written to a log nobody reads. The attempt is still
  cancelled either way: a cleanup problem is information, never a reason to
  leave an attempt half-cancelled. Attempts that end on their own — failed,
  rejected, or completed — now clean up their remote worktrees over SSH the
  same way a cancelled attempt always did; that path had previously done
  nothing but log.
- Deleting a Flight now also removes the shared integration worktree that
  cooperative flights build in, rather than leaving it behind on disk or on the
  remote host. If that worktree has uncommitted changes, the confirmation says
  so separately from the attempt list, so a shared workspace and a per-attempt
  workspace are never confused for each other. The integration branch is only
  deleted when Git agrees it is safe to delete — it can be the only remaining
  reference to work that was merged but never landed — and if Git refuses, the
  branch is kept and you are told.
- The app opens where you left it. The view you were last on is restored on
  launch instead of always dropping you on Welcome, with Welcome kept as the
  fallback for a first run or for a view that no longer exists or belongs to a
  disabled module. The restore happens after your conversations have loaded, so
  there is no flash of the Welcome screen and no view rendering against a
  half-loaded workspace.
- Issues can be deleted. There had been no way to delete an issue anywhere in
  the app; now there is one on the issue card and one in the issue detail
  panel, both behind a confirmation that names the real consequences — the
  flight it will be unlinked from, the workspace session that will keep running
  without it, and how many comments, acceptance criteria and dependency links
  go with it. Individual comments can be deleted too, with the same
  confirmation. Deleting an issue now also cleans it out of every flight that
  referenced it, not just the one the issue itself pointed at.
- Conversation tiles have one menu instead of three. The tile stacked a chrome
  menu, a "more controls" toggle, and a second overflow menu whose icon was
  identical to the first; they are now a single menu with every action still
  present. The close button's tooltip used to be wrong in one of the two places
  the tile appears, because closing means different things in each; it now says
  what will actually happen — in a workspace, closing removes the pane and
  leaves the conversation running. The Agents sidebar also drops the duplicate
  "+" from its header and keeps its labelled button at the bottom, matching the
  Fleet sidebar.

### Removed — Gemini CLI (2026-07-30)

- Removed Gemini CLI as a supported PTY agent: the agent definition, statusline
  parser (`commands/statusline/gemini.rs`), Gemini status bar, API-key card,
  agent-config and CLI-catalog entries, install hints, and model metadata are
  deleted (~650 net lines). Supported PTY CLIs are now Claude Code, Codex CLI,
  OpenCode, PacketCode, and plain shells.
- Persisted workspace panes and agent slots that referenced `gemini` remap to
  plain terminal on load, and retired builtin agent configs are filtered on
  hydrate, so old saved layouts keep working without the removed CLI.
- Note: a previously saved Gemini API key may remain in the OS keyring (the
  app no longer reads or manages it); it can be removed with the system
  credential manager (Windows Credential Manager / macOS Keychain Access).

### Added — cross-product supervision and operations

- Added the PacketAgent W9 Flight handoff consumer: frozen canonical fixture
  compatibility, keyring-only bearer storage, HTTPS/loopback transport policy,
  validate/deploy/activate, durable deployment/cursor references, ordered event
  acknowledgement, pause/resume/revoke, and evidence inspection.
- Added opt-in Issue↔Flight mirroring for GitHub and Gitea/Forgejo. Task issues
  group under a Flight milestone, hidden markers prevent duplicates, a
  visibility-aware poller performs two-way reconciliation, and LWW conflicts
  retain both values until acknowledged.
- Added read-only Agent and Flight Monitor windows with a backend-issued route
  lease, separate frontend boot shell, narrow Tauri capability, source-surface
  actions, stale states, and focus-back-to-main routing.

### Fixed — trust, schema, and reliability

- Codex CLI subscription sessions now receive PacketBench's frozen MCP authority
  through a local trust proxy. Only allowlisted servers/tools are advertised,
  and path/write/credential/protected-publish denial floors are rechecked on
  each forwarded call.
- Windows Rust test/schema executables now declare Common Controls v6 through
  the linker, fixing `0xc0000139` while merging cleanly with Tauri's app
  manifest. The generated Tauri schema runs natively again.
- SSH attempt targets now emit `serverId` end to end while retaining read
  aliases for legacy `targetId`/`target_id` persisted data.
- Auth watching has a hard debounce wait and flushes pending changes at
  shutdown; corrected Codex terminal text no longer assumes the final response
  is a strict delta-prefix extension.
- Worktree IDs are restricted to ASCII alphanumeric/`-_`, hook payload
  serialization fails closed before child spawn, PTY reader errors are logged
  once per error kind, and PacketAgent responses are bounded while streaming.
- Ollama usage reporting now negotiates `stream_options.include_usage`, retries
  safely on an explicit unsupported-parameter response, and caches the result
  per endpoint for the app session.

### Changed — smaller UX and test debt

- Reorganized Settings into six stable groups with lossless sub-tabs, searchable
  destinations, local/workspace/global scope labels, typed PacketCode recovery,
  and compatibility for older Agent-section CLI deep links.
- Added a read-only main-shell audit covering navigation, menus, tabs, buttons,
  and right-side panel ownership/wiring; its findings remain decision inputs,
  not silently approved implementation.
- Saved prompt templates can launch directly from the command palette, and
  review packets can open the authoritative git diff surface.
- Closed the carried draft-patch, approval-keyboard/focused-input,
  fork-and-resend plan cleanup, shared-time-helper, worktree, hook, PTY, and
  PacketAgent canonical contract test gaps.
- Added a decision-ready Workspace/Agents and Settings audit with current
  first-party competitor evidence, a compatibility-first surface split, and an
  authoritative Settings cleanup backlog. No surface migration was implied by
  the documentation change.
- Overhauled the root documentation set (2026-07-30 State of the ADE review):
  `README.md` provider table and CLI list re-verified against the source
  catalog,
  `ROADMAP.md`/`HANDOFF.md` restated to the post-review restart point, and the
  review's outcomes ledgered in `backlog.md`. A `marketing/` press-kit pointer
  was added to the README documentation map.

## [0.10.2] - 2026-07-28

### Fixed — Dictation

- Capture now opens each microphone's native CPAL configuration, converts
  common PCM formats, downmixes channels, and resamples 44.1/48 kHz input to
  Whisper's required 16 kHz mono instead of requesting a frequently unsupported
  format.
- Recording start/cancel/push-to-talk races are serialized across the
  Dictation view, global shortcuts, and conversation Composer. `Escape` now
  discards audio rather than transcribing it.
- Verified local models can be selected, legacy model files can be verified,
  and a stale selection falls back to an already verified model.
- Saved microphone selection, waveform/error event shapes, language selection,
  custom dictionary prompting, history, analytics, and no-device diagnostics
  are wired end to end.
- Successful transcription inserts into the tracked PacketBench input or copies
  through the native Windows clipboard path, with foreground-app paste kept
  explicit and opt-in.

### Added — Flight supervision and bounded autonomy

- **Reviewer Gate (RG1–RG7).** Flights may opt into one selected read-only
  reviewer. Structured pass/changes-requested/blocked verdicts gate normal
  acceptance; retry, findings handoff, and recorded human override remain
  explicit bounded actions.
- **Cooperative Flight graph (CG1–CG8).** Applied plans can become validated,
  role-assigned dependency graphs. Users launch ready batches, each task keeps
  its worktree, and accepted work integrates serially on a Flight-owned branch
  with conflict recovery instead of silent resolution.
- **Coordination Inbox (CI1–CI8).** Persisted typed messages, acknowledgements,
  role/attempt/task/Flight targeting, safe API-agent delivery, and an opt-in
  PacketBench MCP inbox give builders and operators one steering channel without
  background terminal keystroke injection.
- **Bounded YOLO policy (AP1–AP8).** Assisted remains the default. Settings and
  per-Flight policy snapshots independently control recovery, review
  remediation, graph execution, routing, and tool posture under hard
  cost/time/retry/concurrency/root/target limits and a kill switch. Reviewer
  overrides, conflict resolution, and protected/base-branch landing never
  become implicit.

### Added / Changed — PacketCode integration

- PacketCode now has strict PATH/manual/fallback version detection, separate
  executable, developer-checkout, release-channel, and local/remote data-home
  settings, plus a bounded `doctor --json` integration probe.
- Local and SSH PacketCode panes receive only their configured
  `PACKETCODE_HOME`; remote launches use the remote executable rather than a
  local absolute path. Missing remote installations use the existing
  detect/install flow.
- Stable/preview install actions are explicit and re-detect on completion.
  PacketCode remains an independent product and is not bundled into PacketBench.

### Added / Changed — GitHub Pane v0.9+ (`dev/github-pane-v9-loop.md`, GP1–GP7)

- **Inline PR review comments (GP1).** Existing review-comment threads now
  anchor on their diff line inside `DiffViewer`, with reply chaining; comments
  on LEFT-side context lines resolve too.
- **Background notification polling (GP2).** A visibility-aware poller refreshes
  the notifications inbox on a 60s cadence, pausing when the window is hidden.
- **GitHub OAuth device flow (GP3).** Authorize without pasting a PAT; the
  affordance appears only when an OAuth app client id is configured, and the
  poll loop cancels cleanly on unmount.
- **Commit-hook shell detection (GP4).** On Windows we now warn when no POSIX
  shell is on PATH, so the `prepare-commit-msg` trailer hook can't silently
  no-op.
- **Publish SSH flight attempts as draft PRs (GP5).** Remote worktree attempts
  push from the host, then open a draft PR — previously local-only.
- **Repo releases view (GP6).** A read-only Releases tab for GitHub and Gitea,
  with loading/error states.
- **Issue⇄Flight mirror design (GP7).** Design doc only
  (`dev/issue-flight-mirror-design.md`); the two-way-sync code is design-gated.

### Changed — SSH & remote-workspace hardening (`dev/ssh-remote-loop.md`, S1–S8)

- **Process-tree reaping (S1).** A timed-out `bash` tool now kills its whole
  process tree — Unix process-group `killpg`, Windows `taskkill /T` — instead
  of orphaning backgrounded grandchildren; the remote `bash` tool runs under
  `ssh -tt` so a dropped connection hangs up the remote job.
- **Key-path hygiene (S2).** Server-form save rejects key paths containing
  control bytes, shell metacharacters, or glob wildcards.
- **Remote git polish (S3).** Path-escape guard on remote staging; an actionable
  non-fast-forward push message; and a per-file diff viewer for remote
  workspaces (symlink-confined, so a tracked symlink can't leak an external
  file into the diff).
- **Host-key pinning on backend cancel (S4).** A backend-initiated attempt
  cancel re-resolves the saved server and pins the host key, matching the
  frontend path.
- **Resume uses live server identity (S5).** Resuming a remote conversation
  resolves host/user/port/key/fingerprint from the current `ServerConfig`, so a
  renamed or repointed server resumes to the right host.
- **Clone-to-remote (S6).** Creating a remote workspace can clone a repo into
  the target path first.
- **Portable confinement (S8).** The remote file-tool symlink-escape guard falls
  back from `realpath` to `readlink -f` (BusyBox / minimal hosts), failing
  closed only when neither exists.
- Deferred (environment-blocked): S7 (`target_id`→`server_id` wire rename —
  needs native ts-rs regen), S9 (Windows-OpenSSH hosts), S10 (streamed
  large-file transfer), S11 (live Codex-over-SSH smoke).

### Added — Gitea / Forgejo self-hosted git-host support

A fourteen-item loop (`dev/gitea-support-loop.md`, G1–G14) that adds a
self-hosted **Gitea/Forgejo** git host alongside cloud **GitHub**, with **both
configurable at once**. Forgejo shares Gitea's `/api/v1`, so it's covered too.

- **Dual-host, resolved per workspace.** Configure a GitHub connection and one
  or more Gitea/Forgejo hosts; a workspace targets whichever host its `origin`
  remote belongs to, and the pane's icon + label follow that host. A switcher
  bar lets you override the active host when more than one is configured. There
  is no global "active provider" toggle.
- **`GitHost` provider seam.** A new `core/git_host.rs` abstraction (mirroring
  the `LlmProvider` pattern) routes the ~45 GitHub commands through the active
  connection; GitHub behavior is byte-identical when GitHub is active.
- **Full GitHub-pane parity where the APIs align:** repos, issues (+comments),
  PRs, diffs, branches, labels/milestones/assignees, issue + PR writes, PR
  reviews, and notifications all work against Gitea, with per-endpoint handling
  for the divergences (pagination `per_page`↔`limit`, diff media-type header vs
  `.diff` suffix, merge `merge_method`↔`Do`, branch `commit.sha`↔`commit.id`,
  label-name→id, review-state enum, notification id/`to-status=read`).
- **Capability-gated degradation.** GitHub-only surfaces (Events activity feed,
  check-runs, the GraphQL draft toggle, inline PR-review authoring, and the AI
  assist features) are hidden or return a clear "GitHub only" message on Gitea
  rather than failing.
- **Tokens now persist in the OS keyring** keyed by connection id — GitHub
  included, so there's no re-prompt after restart (the legacy token is migrated
  in rather than scrubbed). Non-secret Gitea base URLs persist to
  `git-hosts.json`.

Peer-reviewed (backend + frontend) with fixes applied. Deferred: Gitea
agent-tool (`gh_*`) parity and richer Gitea Actions/check-runs surfacing.

### Added — Memory v0.9+ (Memory pane, fully wired)

A ten-item loop (`dev/memory-v9-loop.md`) that fixed the half-wired gaps and
shipped the deferred Memory enhancements. Local-embedding semantic retrieval
remains deliberately deferred (do it only if keyword misses are measured).

- **Timeline search now ranks by the IDF scorer** it sat next to (M1): best
  match first, substring hits preserved, blank query = identity.
- **Timeline scope chips** (M2): rolling date-window (All/24h/7d/30d) + per-
  project chips, composing with the type filters and search.
- **Export / import memory** (M3): download the corpus as round-trippable JSON
  or a readable Markdown digest; import merges JSON deduped by id.
- **"+ Add to memory" on more surfaces** (M4): the flight coordination timeline
  and assistant transcript turns, alongside the existing GitHub investigation.
- **Confidence that learns** (M5): patterns injected into a flight's brief are
  nudged up on success and decayed on failure when the flight settles.
- **"This looks familiar" launch hint** (M6): an amber warning when a prompt
  overlaps a known pitfall or a lesson that recurred across prior flights.
- **Rolling 30-day digest** (M7): event/pattern counts, top patterns, and the
  freshest lessons, in the Patterns rail.
- **"Ask your project" tab** (M8): a keyword-ranked answer over your own memory,
  no LLM call.
- **Rich flight retrospective wired in** (M9): flight capture now enriches its
  lessons with the previously-stranded `summarize_flight` LLM retrospective
  when learning is enabled (best-effort, local flights).

### Changed

- **Dead `task_completed` surface retired** (M10): nothing has emitted that
  event since the July 2026 scheduler removal, so the permanently-empty "Tasks"
  Timeline chip is gone. The type and its renderer stay read-only for any
  events persisted before the removal.

## [0.10.1] - 2026-07-19

### Changed

- **Remote (SSH) sessions now use the remote host's MCP config, not your local
  one (S8-Phase-B — behavior change).** Previously a remote session inherited
  your _local_ MCP configuration (and in practice only local _global_ HTTP/SSE
  servers actually reached the remote). Now the remote sidecar sources its **own**
  config from the remote host — `~/.claude/settings.json` + the project's
  `.mcp.json` — and runs every server (stdio included) from there. **Action
  required:** to keep using an MCP server in a remote workspace, configure it on
  the **remote host** (its `~/.claude/settings.json` and/or the repo's
  `.mcp.json`). Local-only MCP servers no longer appear in remote sessions. The
  upside: your local command paths and secrets never cross SSH, the remote
  project `.mcp.json` is finally honored, and the session meta line shows exactly
  which remote MCP servers were sourced (and flags any unreadable config). See
  `### Added` below and `backlog.md` → S8-Phase-B.
- **Flight Planner backend amputated (`chore/planner-amputation`).** The
  2026-07-11 extract-then-delete: the live executor money path
  (`flight_for_executor_session` / `accumulate_executor_cost`) moved verbatim
  into a new Flight-Deck-owned `commands/flight_cost.rs`; the now-unreachable
  planner command family, prompts, and on-disk journal were then deleted
  (`commands/flight_planner.rs` + 4 sibling modules + `flight_planner_tools/`,
  ~13,300 net lines), along with the sidecar's in-process Flight Planner MCP
  surface (`flight-planner-server.ts`, `mcpKind:"planner"`). Sidecar protocol
  bumped **v6 → v7** (negotiation stays warn-only). `planner_status` /
  `flight_approvals` persisted fields are kept read-only so old users' state
  still loads losslessly. See `backlog.md` → Flight Planner backend.
- **Backlog cleanup batch (`chore/backlog-cleanup-loop`).** Closed the
  self-contained cleanup items: the API-agent system prompt now injects
  `brand::APP_NAME` instead of hardcoding the name; internal SSH/heredoc
  sentinels renamed to `PACKETBENCH_*` with the heredoc terminator hoisted into
  `core::shared` and seeded from OS randomness so it is no longer predictable
  from the payload; the local PR-body temp file is now removed via an RAII
  guard (survives async cancellation/panic); the dead `set_ssh_password`,
  `delete_ssh_password`, and `ssh_test_connection` commands and the zero-caller
  `ask_flight_chat_stream` flight-chat feature were removed; and the worktree
  hook installers (~120 LoC) and sub-agent/custom-agent loops (~80 LoC) were
  de-duplicated into shared helpers.
- **Removed the legacy task-orchestration scheduler.** Deleted the zero-caller
  `commands/orchestration.rs` command family (launch/pause/resume/cancel/tick/
  record-spawn/notify-\* — no frontend callers) plus the `SharedOrchestrator`
  managed state and its DTOs, and untangled `commands/state.rs` from it
  (`save_settings_slice` now just persists to disk; everything reads settings
  fresh via `load_state`). The `core::orchestrator` scheduler engine was pruned
  to just `OrchestratorSettings` + a free `recover_flights_on_startup` function,
  which lib.rs now calls directly at launch so post-restart flight/task
  normalization is preserved exactly.
- **Eager Mission→Flight migration.** Added one-shot startup passes that rewrite
  the legacy `missionId` key to the canonical `flightId`:
  `core::migration::migrate_mission_to_flight` re-saves persisted state when the
  raw file still carries a `missionId` (canonicalizing flight-approval records),
  and `migrateIssuesMissionToFlight` rewrites the link on `packetbench:issues`.
  Both are guarded/idempotent. This is the eager pass the read-side
  `#[serde(alias = "missionId")]` / `issueStore` fallbacks needed before they can
  be retired (one release cycle later). See `backlog.md` → Mission→Flight.

### Fixed

- **Completed the 30-item low-rated Reliability audit loop.** Terminal replay
  now uses backend sequence metadata and session endings are idempotent;
  filesystem/auth/persistence paths fail closed or durably; Whisper downloads
  are pinned and SHA-256 verified; API-agent permissions, edits, ownership,
  cancellation, usage logging, and provider errors have deterministic
  lifecycle handling; sidecar queues are bounded and protocol v10 carries an
  explicit `cancelled` terminal marker; Codex tool IDs, Flight prompt parity,
  retry notices, and late tool results are preserved. The completed
  per-finding ledger and gate record are in
  [`dev/archive/reliability-low-fix-loop-2026-07-19.md`](./dev/archive/reliability-low-fix-loop-2026-07-19.md).
- **API-agent turn cancellation ownership (F28).** In-process sessions now own
  cancellation per turn, serialize overlapping send/retry work before mutating
  the transcript, keep cancelled turns reserved until their task unwinds, and
  use compare-and-remove cleanup so an older turn cannot erase a newer handle.
- **Targeted sidecar edit approvals (G11).** Sidecar protocol bumped v8 → v9;
  `edit_response` now requires `toolUseId`, and Anthropic/OpenAI Agents resolve
  only the addressed pending edit instead of draining every edit in the session.
- **Saved-password remote path probes.** `ssh_check_remote_path` now accepts the
  canonical server id and resolves password-auth credentials inside Rust from
  the OS keyring when no transient password was supplied. The credential never
  needs to round-trip through the webview.

### Added

- **Lightweight Flight planning (Option B).** “Plan first” starts a normal
  read-only API-agent conversation against the selected local or SSH target.
  Users can refine the plan in chat and explicitly apply its latest structured
  milestones/tasks to Flight Deck before launching independent worktree
  attempts. This intentionally does not restore Planner v1's scheduler, wake
  loop, journal, approval FSM, or autonomous replanning.

- **stdio MCP servers over SSH — remote-owned config (S8-Phase-B).** Remote
  (SSH) agent sessions can now use **stdio** MCP servers, not just HTTP/SSE. When
  a session runs on the remote sidecar, the sidecar sources its **own** MCP
  config from the remote host — `~/.claude/settings.json` + the project's
  `.mcp.json` (project-over-global) — and runs every server there. Local command
  paths and secrets never cross SSH, and the remote project `.mcp.json` (which
  was silently ignored before, even for HTTP/SSE) is finally honored. This
  supersedes Phase-A's local-config forwarding for remote sessions; configure a
  remote host's MCP integrations on that host. The session meta line now shows
  which remote MCP servers were sourced (and flags any unreadable config),
  replacing the previous silent backend warning. Sidecar protocol bumped v7 → v8.
- **PacketBench as an MCP server (N3).** PacketBench now exposes its own state to
  external agents (Claude Code, Codex, Cursor) over **Streamable HTTP** (the
  current MCP transport) via the official `rmcp` crate, hosted in the Rust core
  and bound to `127.0.0.1`. Enable it from Tools → MCP Provider: the card shows
  the URL + a bearer token to paste into a client's MCP config, plus a live
  activity feed. Exposes 5 read tools (`get_active_flight`, `list_runnable_tasks`,
  `read_task_details`, `read_memory_context`, `list_workspaces`) and 7
  `packetbench://…` resources (project, flights, flight/tasks, memory patterns,
  workspaces, reviews), sourced from the same persisted state the app owns.
  Optionally (**off by default** — a separate "Allow writes" toggle) agents can
  post append-only notes to a flight's coordination timeline: `append_handoff`
  (a handoff note) and `escalate` (flag a flight for human attention). Notes are
  human-visible in Flights and namespaced (`mcp:…`) so they can't impersonate
  you, and now persist across reload (the coordination log is round-tripped
  through storage — this also makes N2's escalation events durable). Auth is a
  bearer token + `Origin` validation + loopback bind. `src-tauri/src/mcp_server/`.
- **Swarm escalation suggestions (N2).** When a flight's agent attempts fail,
  the coordination timeline now records an informational `task_failed` event per
  failed attempt, and when a flight becomes _stuck_ — every attempt terminal
  (failed/cancelled), at least one failed, and none succeeded — it adds a single
  `escalation` suggestion prompting you to reassign, revise the prompt, or review
  the failures. The suggestion **suggests, never acts**: nothing is reassigned
  automatically. It is deduped per stuck state (a re-run's new attempts can
  escalate again) and fires whether the stuck state is reached by a failure or by
  cancelling the last outstanding sibling. `src/lib/flightCoordination.ts`.
- **Window geometry persistence.** The desktop window remembers its last
  size and position across launches.
- **Task-relevant memory retrieval (memory Phase 1).** Memory injection was
  task-blind — it injected the top-N highest-confidence patterns regardless of
  the task. Retrieval now ranks patterns and lessons by IDF-weighted term overlap
  against the task/objective, blended with confidence, so injected memory is
  relevant to what's being built. The confidence gate is unchanged (relevance
  only re-orders the trusted set; pinning still forces inclusion). Chosen over an
  embeddings/RAG build, which is deferred and re-scoped (the ≤100-pattern corpus
  doesn't justify a vector index).
- **GitHub notifications inbox.** A new "Inbox" subtab in the GitHub pane lists
  `GET /notifications` unread threads with an unread badge, optimistic
  mark-as-read, and type-aware link-back to the source issue/PR.
- **Remote git write actions over SSH.** The workspace GitDashboard was
  read-only on remote (SSH) workspaces; it can now stage, commit, push, pull, and
  create branches on the remote host (`git_*_remote` commands over the existing
  SSH transport, with the same protected-branch / clean-worktree guards as local
  and shell-safe argument quoting).
- **HTTP/SSE MCP servers over SSH (Phase 4.2 Phase A).** Remote sidecar sessions
  previously refused any MCP servers; they now forward URL-reachable HTTP/SSE MCP
  servers to the remote host (no local binary needed). stdio (process) MCP
  servers are still skipped remotely (their binaries are local — deferred to a
  decision-gated Phase B).
- **Authored PR line comments + reply threads.** The GitHub pane could only read
  review threads; now the PR diff has a line-number gutter and a per-line hover
  composer to author an inline review comment (`github_post_pr_review_comment`),
  and existing threads can be replied to from the reviews panel
  (`github_reply_to_pr_review_comment`).
- **Clickable provenance on memory timeline cards.** `flightId`/`sessionId`/
  `taskId` references on memory event cards now deep-link to the originating
  flight/conversation surface (guarded against dangling targets).
- **Flight review packets in the git panel (ROADMAP N4).** GitDashboard already
  matched changed files to flight tasks; it now opens a `ReviewPacketPanel`
  surfacing the linked task's `ReviewPacket` — summary, review type, command, and
  a colored diff of the agent-reported change — plus approval status. When a task
  is `approval_needed` and its session has a live prompt, a "Go to approval"
  button deep-links to that conversation tile; otherwise it offers "Open flight".
  The approve/reject action itself stays session-scoped in ReviewSurface. The
  aggregate "Review before commit" banner opens the same panel.
- **Proactive cost-threshold notifications (ROADMAP N5).** With budget
  guardrails already hard-gating launches, spend now also raises a notification
  as it _approaches_ a limit — firing on an upward guardrail transition
  (`ok→warning`, `warning→limit`, or an `ok→limit` spike), gated by a new
  "Cost threshold alerts" toggle. Detection runs on the 30s analytics poll (not
  the spend-chip render), seeds each scope's baseline silently so launching
  already-over-threshold doesn't spuriously fire, and only consumes a transition
  once the notification is actually delivered.

### Security

- **web_fetch SSRF closed (F40).** `web_fetch` fetched attacker-controllable URLs
  with no guard against internal targets. It now blocks private / loopback /
  link-local / cloud-metadata IP ranges — including IPv4-mapped, NAT64
  (`64:ff9b::/96`), 6to4, and IPv4-compatible embedded-IPv4 forms — validates
  every hostname at connect time through a custom DNS resolver (closing the
  DNS-rebinding TOCTOU across the initial request and every redirect hop),
  pre-screens IP-literal hosts and their decimal/octal/hex/userinfo encodings,
  and caps redirects while re-checking scheme + target on each hop. 2-agent
  security-reviewed; 11 unit tests.

### Fixed

- **Flight Deck attempt reliability audit.** Flight creates/updates are now
  serialized and flushed before Rust appends the first Attempt, and backend
  merge logic preserves runtime-owned attempts/cost across delayed frontend
  whole-slice saves. Local draft-PR publishing now pushes and records the PR
  before terminal cleanup removes the worktree. Accept/reject also completes
  the previously-deferred SSH worktree cleanup instead of leaking it remotely.
  If a later target in a multi-target launch fails to provision, earlier
  attempts are rehydrated and attached before the launch error is surfaced, so
  already-running work never disappears from Flight Deck.

- **P1/P2 reliability closeout (G01 / G09 / SSH password auth).** App exit now
  terminates local and SSH sidecar process trees (including Codex/MCP/SSH
  grandchildren) and suppresses supervisor resurrection. Password-authenticated
  SSH works non-interactively on Unix through a self-reinvoked `SSH_ASKPASS`
  helper with a guarded 0600 secret file; Windows retains its stdin path. The
  Codex exec provider no longer passes rejected `-a`/resume `--sandbox` flags or
  writes approval responses to closed stdin, terminates stdout-idle turns, and
  safely launches the Windows npm shim through its adjacent `codex.js` without a
  command shell. Deterministic Codex compatibility smokes are now release-gated.

- **PTY UTF-8 freeze (F02).** A single invalid UTF-8 byte from a terminal used to
  be re-buffered forever (unbounded `pending`), freezing the terminal's output.
  `decode_terminal_chunk` now uses `Utf8Error::error_len()` to flush invalid bytes
  as U+FFFD while still buffering only genuinely-incomplete trailing sequences.
- **OpenAI-compat parallel tool calls (G16).** The streaming parser tracked a
  single in-flight tool call, so parallel tool calls (distinguished by
  `tool_calls[].index`, with interleaving argument deltas) collapsed or
  cross-contaminated. It now accumulates each call per-index and emits them
  independently — affects the OpenAI / OpenRouter / MiniMax / Ollama providers.
- **P2 hardening batch** (verified against current code — several findings
  predated the single-surface refactor — and 2-agent peer-reviewed):
  - **web_fetch** (`core/tool_web.rs`): caps buffered response bytes (10 MB,
    streamed, with a Content-Length early-reject) so an oversized response can't
    OOM the process; wraps returned content in a nonce-delimited
    untrusted-content envelope to blunt prompt injection; hoisted its HTML-strip
    regexes to compile once.
  - **LLM streamers** (`core/llm_anthropic.rs`, `core/llm_openai_compat.rs`):
    byte-buffered SSE parsing so a multibyte UTF-8 char split across network
    chunks is no longer corrupted (F46); stop draining the upstream stream once
    the consumer drops the receiver (RA1).
  - **SSH credential leak** (`core/tool_runtime_ssh.rs`): the keychain password
    is fed to ssh stdin on Windows only; on Unix, OpenSSH ignored it for auth and
    over a ControlMaster-multiplexed connection forwarded it to the remote command
    (F06/F11).
  - **auth-watcher** (`commands/auth_watcher.rs`): trailing-edge (settle) debounce
    so a login's final authoritative cred write is the one probed/emitted, not a
    half-written first event (F16).
  - **worktree leak** (`commands/flight_attempts.rs`): an attempt whose API session
    fails to start now tears down its orphaned worktree, keeping the Failed record
    (G26).
  - **truncate panic** (`commands/agent_sidecar/handler.rs`): walks to a char
    boundary before slicing (G03).
  - **Codex duplicate text** (`agent-sidecar/.../openai-codex.ts`): the legacy
    event path dedups assistant text like the item path (G10).
  - **API sendMessage failure** (`stores/agentTaskStore.ts`): a failed send clears
    the streaming bubble instead of spinning forever (F32); `deleteConversation`
    always releases api-agent listeners so done/failed conversations don't leak
    them (F36/G32).
  - **flight hydrate** (`stores/flightStore.ts`): `hydrateFromBackend` merges
    local-only optimistic flights instead of wholesale-replacing (F51).
  - **contract test** (`lib/__tests__/contract.test.ts`): the FlightStatus test
    now cross-checks the generated schema enum (F55).

## [0.10.0] - 2026-07-09

Single-surface consolidation. The Agents tab is retired and every agent —
chat or terminal — now lives as a tile in one Workspace. Delivered across
three programs (the two-team UX consensus waves, the conversation-as-tile
build, and the memory rewire), plus the Agents-tab Wave 4 refactor and the
shipped data-loss / orchestration-trust review fixes.

### Added

- **Conversation tiles — single-surface Workspace.** Chat agents now open as
  `ConversationTile`s in the same draggable mosaic as PTY terminal tiles; the
  Workspace is the one home surface. Tiles get a responsive `@container`
  header, lazy overflow, lifecycle states, auto-zoom-on-review, and a
  multi-stream perf gate.
- **FleetSidebar** — one unified session list replacing the old workspace and
  agent sidebars: running + idle rows, virtualized long lists, a _needs-you_
  group pinned to the top for conversations awaiting an approval or answer,
  self-cleaning on close, and a fixed status vocabulary. `sessionStatus` is a
  single-truth rollup, with a net-new `focusPaneRequest` mechanism.
- **AddAgentPicker** — a single add-a-session flow split into **Chat agents**
  and **Terminals** sections over a capability catalog, opening a draft tile.
- **Worktree lifecycle in GitDashboard.** `WorktreeLifecycleBar` carries a
  conversation's branch to **merge / PR / discard** from the single git home,
  backed by a new Rust `merge_conversation_branch` command with ruled safety
  semantics (`gitPublish` extraction, `worktreeLifecycle` lib, dirty-check
  hardening, Discard wiring). A conversation carries a `worktree` field.
- **Agents-tab Wave 4** — transcript virtualization for long conversations, a
  rewritten diff engine, model-metadata surfacing, conversation export, and a
  sidebar-organization / options-object refactor.
- **Sidecar-over-SSH** — `forward_start_ssh` lets subscription providers run
  over SSH remote workspaces through the sidecar.

### Changed

- **Two-team consensus consolidation (P0 / P1 / P2).**
  - **P0** — purged dead / fake UI; fixed the workspace-zoom duplicate-agent
    spawn; fixed disappearing edit cards via a shared `parseToolInput`
    decoder; redesigned the mode-flag bijection and collapsed permission
    controls into a single `AgentModeChip`; removed keyboard landmines and
    per-message chrome filler; smoothed streaming + scroll.
  - **P1** — one canonical **ReviewSurface** with a single hunk engine and one
    apply pipeline (on repaired diff-pipeline foundations); the two composers
    merged into one; tiered approval gating with out-of-view approvals pinned;
    plan approval unified inline (Spec FSM cut, inline Restore); **GitDashboard**
    as the single git home with a per-file staging engine and clickable diff
    rows; chat-header consolidation (9 controls → 6); sidebar diet + fixed
    status vocabulary; workspace chrome diet (templates-first creation, one
    agent-color source); one global transcript view mode with uniform one-line
    tool rows; a typography / spacing **design-tokens** pass.
  - **P2** — memory affordances collapsed to a single surface; a small-cuts
    batch (disabled Cloud segment, removed Preview Browser sub-tab, inspector
    regex plan parser); state-layer pruning with the orchestration runtime
    converged onto `asyncFlightStore`.
- **Memory ON by default, injection artery restored.** The severed
  memory-injection path for tile launches was reconnected, flight lessons are
  wired in (flight injection gated), dead paths cut, `flight_completed` is
  captured on the cancel-tips-it-done transition, and context previews are
  truthful. Memory now defaults to **on**.
- **Quiet sidecar chip.** The toolbar sidecar chip is silent when healthy and
  surfaces only degraded states.
- **Mission → Flight rename + README refresh.** A staged, no-behavior-change
  rename unified Mission → Flight across the frontend, Rust backend, IPC
  surface, and generated schema (`Mission Planner` → `Flight Planner`,
  `MissionsView` → `FlightsView`, `mission_id`/`missionId` →
  `flight_id`/`flightId`, `core/mission_journal.rs` → `core/flight_journal.rs`,
  and the full sibling rename set), with a README pass against the code.
  Read-time `missionId` aliases and the on-disk `~/.packetbench/missions/`
  journal path are deliberately preserved as back-compat; removal is gated on a
  one-shot migration tracked in [`backlog.md`](./backlog.md).

### Fixed

Shipped from the 2026-06-07 triple-review (3-vote panel) after final
validation and moved out of the review ledger:

- **Batch A — data-loss & corruption.** MCP config writes / deletes reject
  malformed JSON instead of clobbering it, preserve existing server fields, and
  forward non-stdio server shapes to sidecar sessions (F19 / F20), with atomic
  MCP file writes via temp-file + `sync_all` + rename (F21). Key / Gemini / SSH
  migrations keep legacy data until the replacement save succeeds, the legacy
  localStorage prefix migration snapshots keys before mutation, and SSH target
  migration merges both legacy namespaces (F09 / F10 / F44 / F56). `FlightDetail`
  unlink updates both issue and flight stores, and backend
  `PersistedState.issues` hydrates `issueStore` before Flight reconciliation
  (F48 / F52). Poisoned Anthropic history no longer breaks turns — empty
  text-only turns are skipped while tool-use turns stay valid (G18).
- **Batch B — "it silently failed" (orchestration trust).** `pty:exit` now
  carries `exitCode` + `terminated`, and non-zero / terminated exits map to
  unsuccessful task completion (G23 / G24); attempts subscribe to
  `api-agent:done` / `:error` so completion no longer relies solely on the
  sentinel (G25); deploy runs get a dedicated wait thread with bounded /
  EIO-aware reads (F13); scheduler-tick failures are logged, counted, notified,
  and pause the loop past a threshold (F33); `update_task` reports unsupported
  `target_spec` patches as `deferred_fields` rather than fake landed updates
  (F34); a sidecar child exit fans out a recoverable `api-agent:error` and
  clears local ownership before restart (G02).

### Removed

- **Persistent goals** — the `/goal` command, `goalStore`, and the PlanPanel →
  Flight Deck goal bridge.
- **Ideation Scanner** — module and view.
- **Deploy** — the Deploy view / UI surface.
- **Standalone Review Queue** view — approvals now surface through the tile
  ReviewBar / ReviewSurface and the toolbar bell.
- **SpecPanel** (Spec → Plan → Code FSM) and **CheckpointPanel** — plan approval
  is inline and rewind is inline **Restore**.
- **Cloud** composer-mode segment — Local / Worktree only.
- **AgentsView / AgentSidebar** — the Agents tab is retired; a one-release
  redirect shim maps the old `agents` view (and `Ctrl+Shift+1`) to the
  Workspace before removal.
- **SessionHealthBar** — folded into the consolidated tile header.

## [0.9.4] - 2026-06-01

### Fixed — two-team code review remediation (8 peer-reviewed fixes)

A two-team subagent review of the whole codebase surfaced one recurring theme: the weak link is failure-path and async-lifecycle discipline, not architecture. Eight fixes shipped, each **sanity-checked against the code before implementation** and **peer-reviewed after**. The review gate caught two would-be regressions before they landed — a Codex `stream_error` false positive (the finding was wrong) and a `write_file` symlink fail-open (a reviewer-caught hole in the fix itself). Full report in [`dev/archive/code-review-2026-05-31.md`](./dev/archive/code-review-2026-05-31.md).

#### Resource & lifecycle

- **Reap orphaned processes/tasks on abnormal termination** (`53e6d46`): added `kill_on_drop(true)` to the tool-runtime bash/ssh/gh spawns and the MCP handshake spawn (`tool_runtime.rs`, `tool_runtime_ssh.rs`, `tool_pull_request.rs`, `mcp_client.rs`) so a timed-out child is reaped instead of orphaned; `api_agent.rs` aborts the detached provider stream task on cancel (was leaking the upstream HTTP connection and pushing into a closed channel); the Node sidecar bash tool now kills the whole process group/tree (POSIX detached + negative-PID SIGKILL, Windows `taskkill /T`) instead of SIGTERM to the shell alone.
- **Evict dead MCP clients from the connection pool** (`85d9206`): `McpConnectionPool` had no eviction, so once a cached server's child died every later `tools/list` / `tools/call` failed until restart — and via `resolve_mcp_name`'s `?`, one dead server broke _all_ tool calls. Connection-level errors now evict (`Arc::ptr_eq`-guarded so a healthy respawn isn't wiped); `list_tools` retries once, `call_tool` evicts without retry to avoid double-executing a mutating tool.

#### Data durability

- **Persisted-state storage hardened** (`60cb763`): `data_dir()` falls back to the legacy dir so a failed migration can't strand the user on an empty new dir; `migrate_data_dir()` adds a cross-volume copy fallback; `write_with_backup` drops the pre-remove crash window (relies on atomic rename); and `load_state` / `load_provider_runtime_settings` gained a read-only recovery ladder (quarantine corrupt → `.bak` → `.tmp` → default) so a parse error or torn write no longer silently resets to empty and then overwrites the recoverable data on the next save.

#### Correctness & contract

- **api-agent terminal-event contract** (`6602d88`): `retryLastTurn` and `createApiConversation` now clear the streaming bubble on a backend-start rejection (previously spun forever, reachable automatically via auto-failover); the Codex `stream_error` event is documented as transient/non-terminal (the `child.on("exit")` handler is authoritative) rather than mis-surfaced as a hard failure.
- **Deploy run status truthfulness** (`e2eeaf1`): `deploy:exit:{id}` (the real numeric code) is now the single source of truth — removed the fabricated `onExit(0)` that could flash a failed deploy as success and mis-correlate to the selected (wrong) run; `finishRun` is idempotent and the exit listener attaches before invoke so a fast deploy's exit can't be missed.

#### Security

- **OpenAI Agents risky-tool approval** (`c8e671c`): the default `auto` mode now requires approval before `bash` / `write_file` (previously ran unconfined shell with no prompt by default), coordinated with `approveWrites` so write_file isn't double-prompted; covered by an offline gating test wired into `sidecar:check`.
- **SSH host-key pinning on async launch** (`140309c`): the async agent launcher now refuses unpinned hosts (UI gate mirroring `WorkspaceCreationModal` plus a fail-closed backend check in `flight_attempts.rs`), closing a silent TOFU / MITM-on-first-connect window. The interactive PTY accept-new fallback is intentionally unchanged.
- **Remote SSH file-tool confinement** (`40c3b2f`): the read/list/grep/write_file remote scripts now `realpath`-resolve the target and reject paths that escape the workspace (fail-closed if the remote lacks `realpath`), matching the local symlink defense; write_file also confines a pre-existing symlinked leaf, not just its parent.

#### Process

- Each finding was verified against the actual code before any implementation (catching the `stream_error` false positive), implemented by paired/sequenced subagents on disjoint scopes, and peer-reviewed by two reviewers per change (catching the write_file fail-open leaf). Deferred follow-ups — Codex's matching permissive default, the `AgentModeChip` "Default" label, remote `realpath` portability, and the cross-volume migration partial-copy edge — are recorded in [`backlog.md`](./backlog.md).

## [0.9.3] - 2026-05-17

### Fixed — `core/` library audit closeout + 3 surgical high-priority fixes

Phase C audit covered the 41-file `src-tauri/src/core/` library across 4 parallel agents on disjoint scopes (LLM provider stack, tool runtime, MCP/workspace/execution, storage/orchestration/prompts). Combined verdict: **29 CLEAN / 12 MIXED**, all 41 modules now categorized. Two inline fixes landed during the audit (`55d8715`, `5ef885c`); the highest-severity findings shipped as a Phase D follow-up wave.

#### Inline audit fixes

- **UTF-8-safe SSH bash truncation** (`tool_runtime_ssh.rs`): the local `tool_runtime.rs::execute_bash` already had a char-boundary-safe `truncate_to_char_boundary` helper, but the SSH variant was using raw `String::truncate` which panics mid-codepoint on multi-byte output. Promoted the helper to `pub(crate)` and reused it. 2-line diff (`55d8715`).
- **`git checkout -b --` was broken** (`core/git.rs:233`): git parses `--` as the branch name when used with `checkout -b`, producing "fatal: '<name>' is not a commit and a branch '--' cannot be created from it". Removed `--` from the `checkout -b` arm; kept it on the `branch` arm where it works. `validate_branch_name` already rejects `-`-prefixed names so flag injection is still blocked (`5ef885c`).

#### Phase D — surgical fixes for highest-severity audit findings

- **Closed the load-modify-write race in `commands/orchestration.rs`** (same severity as the `state.rs` race fixed in v0.9.2). Phase A R1 missed this; Phase C C4 caught it. Four racy sites (`create_shared_orchestrator`, `with_orchestrator_and_flights`, `pause_flight`, `cancel_flight`) migrated to `storage::update_state(|state| ...)`. The bare `let _ = save_state(...)` swallow at line 22 is replaced with `tracing::warn!` since `lib.rs:83 .manage(...)` consumes the function's non-Result signature.
- **Hook child no longer orphaned on timeout** (`core/hooks.rs::run_hook`): `tokio::time::timeout` around `wait_with_output` returned `Err(...)` but the spawned hook child kept running detached. Added `.kill_on_drop(true)` on the `Command` builder so cancel / panic / timeout paths all reap the child uniformly on Unix and Windows. Timeout branch now also emits `tracing::warn!` with hook name + duration. Payload-serialize error at `hooks.rs:205` now logs before falling back to `b"{}"`.
- **TS-binding contract test backfill** (`core/contract_tests.rs::enum_variants_serialize_to_expected_strings`): previously missed `FlightStatus::Spec`, the entire `FlightPriority` enum, and 7 of 8 `TaskStatus` variants (only `ApprovalNeeded` was asserted). Drift in any of those would have silently mismatched TS bindings. Now all three enums are fully covered.

#### Process

- 4 parallel audit agents (C1-C4) on disjoint scopes → 3 parallel surgical fix agents (D1-D3) on disjoint scopes. All 33 worktree branches and directories cleaned up after merge.
- Rust backend now at **100% audit coverage**: 28/28 command modules (v0.9.2) + 41/41 core library modules (v0.9.3).

## [0.9.2] - 2026-05-17

### Fixed — Rust commands audit (Phase A) + silent-error sweep + `state.rs` race fix

Multi-agent audit of every file in `src-tauri/src/commands/` (3 parallel auditors covering 26 single-file modules + 2 module directories). Combined verdict: 22 CLEAN / 6 MIXED. Phase B fix wave addressed all six MIXED files plus a few catches in the deferred `statusline/` and `dictation/` module dirs.

#### High-severity fix — `state.rs` load-modify-write race

`commands/state.rs::save_persisted_state` had an unprotected read-modify-write cycle: `load_state(); state.<merge>(...); save_state(state);`. A concurrent slice-writer (`save_issues_slice`, `save_flights_slice`, etc.) landing between the load and the save could lose data. Closed by adding `core/storage.rs::update_state<F, R>(mutate: F)` — acquires `STATE_LOCK` once, runs the closure with `&mut PersistedState`, and saves atomically. `save_persisted_state` rewritten as a single `update_state(|state| { /* preserve issues + retrospectives, swap rest */ })`.

#### Silent-error sweep (6 files)

Every site below preserves prior behaviour — fallback values are unchanged — but failures are now visible via `tracing::warn!`:

- **`commands/fs.rs`** (`list_directory`, `list_subdirectories`, `walk_collect`): directory-traversal skips now log path + error reason instead of silently dropping unreadable entries.
- **`commands/history.rs`** (lines 79, 85, 92 + JSONL parse branch): silent IO/parse swallows on `.claude/history.jsonl` and per-project files now warn.
- **`commands/pty.rs`** (lines 68, 156, 629, 658): four platform-path `unwrap_or` fallbacks (where-output `\` parsing, SSH home_dir, ssh-keyscan algorithm token, ssh-keygen SHA256 token) now warn before defaulting.
- **`commands/mcp.rs`**: corrupt JSON parse via `tracing::warn!` (was silently coerced to empty config); collapsed a redundant `if scope == "global" { "mcpServers" } else { "mcpServers" }` branch.
- **`commands/insights.rs:103`**: fire-and-forget `tokio::spawn` now logs task start (`info!`) and outcome (`info!` on success, `warn!` with stderr on non-zero exit).
- **`commands/dictation/config.rs:55`**: `get_dictation_settings()` corrupt-config errors now warn before falling back to defaults (was `unwrap_or_default()`).

#### Audit coverage

- 28 of 28 command modules verdicted (incl. 2 module directories: `statusline/` 6 files all CLEAN; `dictation/` 5 CLEAN + 1 fixed).
- Standout CLEAN files called out by auditors: `issues.rs` (production-grade), `provider_auth.rs`, `provider_stats.rs`, `pricing.rs`, `quality_runner.rs`, `code_quality_autofix.rs`, the 4 `mission_planner*.rs` shards from the v0.9.1 split.

## [0.9.1] - 2026-05-17

### Changed — GitHubView decomposition + W-wave refactors (mission_planner, agent_sidecar, MissionsView, DictationCard, orchestrationStore, Tools cards)

Follow-on cleanup wave after the v0.9.0 agent-pane overhaul. Big files split into focused units, four new GitHubView extracts get test coverage, and one Rust module joins the LoC-bloat retirement list.

#### GitHubView extracts (T1a/b/c → T2a/b/c)

`src/components/views/GitHubView.tsx` shed 532 LoC (1,509 → 977) across three sibling extractions and a dedup pass. Each new component owns one feed:

- `github/IssueList.tsx` — open + closed issue rows with state-filter chips.
- `github/PRList.tsx` — open + merged PR rows; same chip pattern as IssueList.
- `github/ActivityFeed.tsx` — cross-event feed (issues + PRs + commits + reviews); manual cherry-pick after the 3-way auto-merge produced a 300-line conflict (T1c).
- `github/shared.tsx` — single home for `StateFilterChip` + `timeAgo`, previously duplicated across the three sibling files.

#### Test coverage

- 21 unit tests across 5 new GitHubView sub-components (IssueList, PRList, ActivityFeed, CtaFeedbackRow, InvestigationPanel) targeting empty states, filter chips, label rendering, and event-card variants.
- `githubStore` catch sweep — 5 silent `catch {}` sites now route through `logSwallowed("githubStore.<op>")`.

#### W-wave splits

- **W2**: `src-tauri/src/commands/agent_sidecar.rs` → 6 focused sub-modules (supervisor, forward\_\*, lifetime stats, etc.).
- **W3**: `src/stores/orchestrationStore.ts` → scheduler + state substores; 3 bare catches surfaced.
- **W4**: `GitHubView` InvestigationPanel extract (1,848 → ~1,570 LoC).
- **W5**: `MissionsView` adopted `useShallow` grouping; `useFlightChat` got `subscribeToFlightChatStream` + `sendMessage` extractions.
- **W6**: `DictationCard` split into 3 focused cards.
- **W7**: shared `<CardHeader>` extracted across the 5 Tools cards.
- **W1'**: `commands/mission_planner.rs` shed its cost-bookkeeping into `commands/mission_planner_costs.rs` (first cut; planner_compaction + planner_tools shards followed).

## [0.9.0] - 2026-05-17

### Changed — Agent-pane overhaul: AgentChatPane / AgentInputArea / agentTaskStore decomposition + UX polish

Major refactor + UX wave targeting the API-agent surface. The two largest files in the pane (`AgentChatPane.tsx`, `AgentInputArea.tsx`) and the central store (`agentTaskStore.ts`) each shed more than half their LoC by being decomposed into focused sub-components, hooks, and substores. Five user-facing UX additions landed alongside.

#### Mega-refactors

- **`AgentChatPane.tsx`** — 2,320 LoC → 763 LoC across 16 new files (hooks + sub-components). Streaming, tool rendering, approval batching, and diff display each became its own seam.
- **`AgentInputArea.tsx`** — 1,667 LoC → 545 LoC across 12 new files. Composer mode, slash commands, image attachments, and provider switching extracted.
- **`agentTaskStore.ts`** — split into approval / plan / streaming substores; checkpoint restore now clears all three correctly. `apiAgentListeners` extracted (`agentTaskStore` 2,086 → 1,685 LoC).

#### UI consolidation

- **DiffPane + EmbeddedDiffPane** — merged around a shared core, eliminating ~237 LoC of duplication.
- **BaseToolCard shell** — Bash and Subagent tool cards now compose a single base shell with a shared `StatusPill`.
- **AgentTabbedRail retired** — collapsed into a `Plan` tab inside `AgentInspectorPane` so there's one inspection surface instead of two.
- **Visual sweep** — header padding standardized at `px-3 py-2` and border semantics unified across every agent pane (`border-line-soft` for internal separators, `border-bg-border` for outer frames).

#### UX additions

- **U1 — Collapsible approval batches + Y/N keyboard shortcuts.** When 2+ writes or permissions stack up they collapse into a single batch row; `Y` / `N` accept-all / reject-all without leaving the keyboard.
- **U2 — Diff-tab unreviewed badge + sidecar status dot.** The Diff tab on `AgentInspectorPane` shows a count badge when unreviewed hunks pile up; the StatusStrip surfaces a live sidecar status dot mirroring `sidecar-status:changed`.
- **U3 — Composer Advanced accordion.** Profile + Mode + ComposerMode chips hidden behind an "Advanced" disclosure so the default composer is two visible affordances instead of five.

## [0.8.8] - 2026-05-16

### Changed — projectPath single source of truth

Eliminates the long-standing drift between the global `useLayoutStore.projectPath` and per-workspace `useWorkspaceStore.workspaces[].projectPath`. The active workspace is now the canonical source; `useLayoutStore.projectPath` is kept in sync via a subscription mirror.

#### Store refactor

- `layoutStore.setProjectPath(p)` is now a **write-through**: with an active local workspace, it updates that workspace's `projectPath` and persists via `saveWorkspacesSlice`. With no active workspace, it writes to a new internal `fallbackProjectPath` field.
- `installWorkspaceProjectPathSync()` registers a `useWorkspaceStore.subscribe(...)` at module init (via `queueMicrotask` to dodge the existing circular import) that mirrors the active workspace's path into `useLayoutStore.projectPath`. Remote workspaces (`serverId` set) skip the mirror to preserve the previous local path.
- Public API preserved: `useLayoutStore((s) => s.projectPath)`, `getState().projectPath`, and `setProjectPath(p)` all work unchanged. No consumer migrations required.

#### Toolbar folder picker

- With an active workspace: picker title reads "Change folder for '{workspaceName}'"; tooltip shows project path + active workspace name.
- With no active workspace: picker shows a follow-up modal asking whether to create a new workspace at the picked path OR set it as the default for the next workspace.
- Folder icon button now has `aria-label` for screen readers.

#### Settings ProjectInfoCard

- Shows "Active: {workspaceName}" context line + explainer copy.
- With no active workspace: replaces the path input with a "Create workspace" CTA showing the last-used folder.
- Raw `text-red-400` token violation on the Clear button replaced with `text-accent-red`.

#### Capture-on-open for in-flight modals

Defends against workspace switches mid-edit:

- `SpecImportModal` captures `projectPath` on `open` transition.
- `CommitModal` captures `projectPath` on `open` transition; also blocks submit when captured path is empty + surfaces an amber hint.
- `NewFlightModal` captures `projectPath` on mount.
- `IssueBoard` snapshots `projectPath` on Import-Spec click (parent-level guard).

#### WorkspaceCreationModal empty-state

- Browse button always available alongside the recents dropdown.
- Auto-jumps to the OS picker when no recents exist.
- Save gated on a non-empty selected path so the persisted workspace never has `projectPath: ""`.

#### Peer-reviewed

4-agent big-session review pass caught issues that are addressed in v0.8.7 above (the projectPath refactor itself produced no P0s — the peer review only flagged behavior changes worth documenting: `ScaffoldView` and `Settings > Browse` now rebind the active workspace silently, which is the intended new behavior).

## [0.8.7] - 2026-05-16

### Added — CLI install/browse + Toolbar Bell + Flight delete + API-agent → Review + Code Quality deep dive

Single big drop covering five themes. Built by ~20 parallel agents + 4-agent peer review + 2 fix passes.

#### CLI catalog: Install / Browse / Coming Soon

- `installCommand` flag annotates 7 catalog entries (claude-code / codex / gemini / opencode / copilot / qwen / qoder) with a stable one-line install command. Clicking Install spawns a one-shot terminal workspace running the command.
- `browseRequired` flag annotates **PacketCode** as Browse-only — user picks the binary via OS file picker (`.exe` filter on Windows, no filter on POSIX). Path persists in a new `cliOverrideStore`.
- `comingSoon` flag on devin / kimi / cursor / mistral / deepseek — surfaces as a "Coming Soon" pill instead of an install button.
- Card grid now has 5 variants: installed / browse-only / installable / coming-soon / browse-fallback. Manual-path overrides display as a clearable "Override: {basename}" tag.
- Backend `DetectCatalogItem.manualPath` skips PATH lookup and probes the user-supplied absolute path directly.
- Fixed: Windows `.cmd` wrapper version probes were returning nothing because `probe_version` ran against the unresolved binary name; now uses the resolved path.

#### Toolbar overhaul

- **Theme toggle removed from Toolbar** — Settings > General > Theme is the canonical control.
- **Review button → Bell at far right** — `accent-red` with count badge when there's pending work, `text-muted` otherwise. Icon is now `Bell` (notifications semantics) rather than `ShieldCheck`.
- Final right-side order: Sidecar | Running | Spend | div | Quality | div | Modules | VT | div | Git | Folder | div | Bell.

#### Flight (Mission) delete

- Inline trash icon on each Mission row (hover-revealed) with two-step confirm + 3s auto-revert.
- Confirm copy escalates to "Active work — delete?" when the flight has running attempts or queued/approval tasks.
- `flightStore.deleteFlight` cascades to clear `Issue.flightId` back-references for every linked issue.

#### API-agent → Review queue wiring

- `api-agent:permission-request` events now fire `fireTaskApprovalNeeded` via a new `flightStore.findTaskBySessionId` reverse-lookup. Tasks bound to a conversation (`Task.sessionId === AgentConversation.id`) get flipped to `approval_needed` and surface in the Toolbar Bell + ReviewQueueView.
- Same wiring for `pending-edit` events — was a missing-handler P0 caught by peer review.
- Both handlers gated on conversation existence so a deleted conversation can't flip a stale task.

#### Code Quality deep dive — backend

- `quality_runner.rs` — new live-streaming check runner with per-check `kill_on_drop`, 3s/300s timeouts (path probe / check run), `quality:chunk:{run_id}` / `quality:check-start` / `quality:check-done` / `quality:done` events, `cancel_quality_run` Tauri command, FIFO run-history eviction by `started_at`, natural-exit prioritized over cancel signals in the post-exit race window.
- `code_quality_autofix.rs` — ESLint --fix / Prettier --write / `cargo fix` / `pnpm audit --fix`, each with a confirm-modal in the UI. Streams via `quality-fix:chunk:{run_id}`. Includes a duplicate-run-id rejection registry (P0 fix from peer review) + `cancel_quality_fix`.
- `code_quality_ai_prompts.rs` — anti-injection envelope on every user-supplied tool output (XML-ish tags + system-prompt warning); per-check + total byte caps with two-pass shrink.

#### Code Quality deep dive — frontend

- Per-check tabs with sticky status badge (idle/queued/running/passed/failed/cancelled/skipped/errored).
- In-house ANSI renderer (no new deps) with SGR + 256-color + truecolor support, line-level filter, `path:line:col` click-to-copy.
- Last-5-runs history dropdown keyed on normalised project path.
- Fullscreen toggle, Ctrl/Cmd+R refresh, Ctrl/Cmd+F filter focus, Escape-to-close (opt-in on the shared Modal).
- AI features: per-error **Explain** (streamed Markdown explanation), **Fix in Workspace** (creates a backlog Issue + provisions an issue-bound worktree + spawns a claude-code pane seeded with the error context), **File Issue** (one-click ticket creation labeled `lint` / `typecheck` / `test-failure` / `build`), and bottom-of-modal **AI summary** with run-hash cache (clear-by-hash, not full wipe).
- AutoFix re-analyze nonce chain so the modal refreshes after each fix.

#### Shared

- `Modal` wrapper gained `closeOnEscape` / `headerExtra` / `fullscreen` props.
- `agent.rs` gained `probe_version_at(path)` for absolute-path version probes + `is_executable_file(path)` POSIX exec-bit check.

#### Process

- 4 parallel implementation agents per major slice + 2-agent peer review per slice + final 4-agent big-session peer review (spec/UX + correctness/races + cross-slice integration + regression).
- ~20 implementation agents total across the session.
- Peer review caught 4 P0s and 11 P1s, all fixed before this commit:
  - P0: `code_quality_run_fix` had no run-id registry (duplicate-call interleaving). Added registry + cancel.
  - P0: `pending-edit` events didn't fire task-approval (Bell undercount). Wired to mirror permission-request.
  - P0: CLI install rapid-click race (first install's spinner got stuck). Switched to Set-tracked active installs.
  - P0: `code_quality_run_fix` duplicate-id rejection.
  - Plus: Windows `.cmd` version probe, CommitModal cancelled-issue filter, raw `text-red-400` token violation, missing `aria-label` on Folder picker, full-cache wipe on AI summary, listener race on rapid re-run, and others.

## [0.8.6] - 2026-05-16

### Changed — Toolbar demotion: Deploy + Prompts

Two underused Toolbar buttons demoted to lower-friction surfaces. Both
features stay alive; they just stop competing for prime chrome real estate.

#### Deploy

- Removed the Rocket-icon Deploy button from the Toolbar.
- New entry "**New deploy run**" added to the global "+ New" dropdown
  (Toolbar left-side, alongside New Claude/Codex/Mission/Issue).
  Routes via `setActiveView("deploy")`.
- DeployView itself unchanged.

#### Prompts

- Removed the BookOpen-icon Prompts button + `<PromptLibrary>` modal mount
  from the Toolbar. The Toolbar no longer carries a Prompts surface.
- **Slash-command expansion** added inside `AgentInputArea`: typing `/`
  at start-of-input or after whitespace opens a popover listing
  kebab-cased template names with a 60-char preview. Arrow nav,
  Enter/Tab to insert (replaces the `/query` with the template body),
  Esc cancels. Coexists with the existing `@`-mention popover; mention
  takes priority where they overlap.
- **Workspace pane** gains a BookOpen-icon dropdown in the pane header.
  Selecting a template writes the body + CR to that pane's PTY via
  `writePty`. Disabled when the pane has no live `sessionId`. (Uses `\r`
  to match `runCommand` so the agent's Enter handler fires on Windows
  ConPTY too.)
- **Settings**: the existing `PromptTemplatesCard` (under Settings >
  Advanced per the v0.8.1 IA reorg) gains a "Manage…" button that opens
  the full `PromptLibrary` modal for in-place CRUD. The card's inline
  editor keeps quick create + delete; full edit + search + send-to
  affordances live in the modal.

#### Process

- 2 parallel agents (Deploy demote + Prompts overhaul) + 1 peer reviewer
  - 2 fix-touches (PTY `\r` consistency, Rocket icon color separated
    from the adjacent Ticket's amber so the +New rows don't visually
    conflate).

## [0.8.5] - 2026-05-16

### Added — Issues pane rebuild (spec import + workspace close-loop)

Repositions the Issues pane as a fourth user mode: **AI-structured intake →
human-orchestrated CLI agents in Workspace panes**. Complements Missions
(autonomous) and Agents (free-form chat).

#### Spec import

- New `issues_extract_from_spec` Tauri command (one-shot Claude OAuth
  sidecar session) reads a pasted spec / PRD / design doc and returns
  structured Issue drafts: title + body + labels + acceptance criteria +
  suggested epic.
- New `SpecImportModal` (2-stage: paste → review-and-accept). Each draft
  is inline-editable, individually selectable. Submit creates Issues with
  a shared `specImportBatchId` so they're grouped semantically.
- Spec-imported Issues land in the new **Backlog** column.
- Prompt module: `src-tauri/src/core/issue_ai_prompts.rs` with explicit
  anti-injection envelope on the user-supplied spec.

#### Send to Workspace (and the close-loop)

- New `sendIssueToWorkspace` orchestrator action:
  1. Provisions an Issue-bound worktree via the new
     `create_issue_worktree` Tauri command.
  2. Installs a `prepare-commit-msg` hook in that worktree that
     idempotently appends `Fixes #{n}` and `Run-By: PacketBench issue
I-{id}` trailers to every commit made inside.
  3. Spins up a workspace (one `claude-code` pane) at the worktree path
     and seeds the conversation with the Issue title + body + acceptance
     criteria.
  4. Stamps `workspaceId`, `sessionId`, `sentToWorkspaceAt` on the Issue,
     flips status to `in_progress`, switches view.
- Per-card "Send to Workspace" CTA; linked Issues show a "→ Workspace"
  pill that jumps to the worktree pane.
- Graceful fallback: if worktree provisioning fails (uncommitted
  changes, branch conflict, non-git project), the workspace still opens
  in the bare project path — only the auto-Done leg is lost for that
  session.

#### Auto-Done on Fixes-#N trailer

- `git_commit` Tauri command now parses commit-message trailers via a
  word-boundary-anchored regex. Recognises `Fixes`/`Closes`/`Resolves`,
  case-insensitive, start-of-line only, optional colon, rejects
  `#42foo`, dedupes, multiple trailers per message all parse.
- Emits `issue-watcher:fixed` events with `{issueId, ticketId,
issueNumber, commitSha, commitSubject}` payload.
- Frontend listener auto-flips matching Issue to `done` and appends a
  system audit comment `Auto-closed by commit {sha7}: {commit_subject}`.

#### Frontend ↔ backend persistence sync

- Every issueStore mutation now funnels through a `saveState` chokepoint
  that writes both the localStorage fast cache AND the Rust
  `PersistedState.issues` via the existing `save_issues_slice` command.
  Without this, the trailer parser couldn't resolve `#N` to an Issue.

#### CommitModal Issue-aware autofill

- When the active workspace is bound to an Issue, the CommitModal opens
  with `Fixes #{n}\n\n` pre-seeded in the message textarea and a "🔗
  Linked to Issue #N: {title}" hint above. One-shot per open — never
  overwrites typing. Caret placed after the seeded line.

#### IssueDetail + filters + smarter columns

- New `IssueDetail` modal: markdown body, acceptance-criteria checklist,
  assignee inline editor, dependency lists, linked workspace pill, full
  status grid, inline comment thread + composer.
- New `IssueCommentList` + `IssueCommentComposer` — markdown body,
  hover-delete, no Ctrl+Enter (mirroring CommitModal).
- New `IssueFilterChips` — multi-select popovers for Label / Epic /
  Workspace / Assignee with type-ahead filter when >6 options.
- Five-column board: **Backlog / Up Next / In Progress / In Review /
  Done**. Legacy status enum values roll up so nothing falls off.
  Display-only In Review override for Issues whose linked Flight has a
  draft PR.

#### Process

- 4 parallel implementation agents (spec import / Send to Workspace /
  Fixes-#N watcher / IssueDetail polish) → 2-agent peer review (spec/UX
  - correctness) → 2 fix agents addressing two P0s:
  1. `sendIssueToWorkspace` didn't invoke the worktree provisioner, so
     the auto-Done loop was dead end-to-end. Wired via new Tauri
     command + frontend integration.
  2. `issueStore` never synced to `PersistedState.issues`, so the
     trailer parser had no data to match against. Wired via debounced
     `save_issues_slice` calls on every mutation.
- Plus inline fixes: hook idempotency regex tightened (was substring
  matching, would have collided `Fixes #4` with `Fixes #42`), spec
  import default status moved from `todo` → `backlog`, IssueDetail
  parallel handoff paths now route through `sendIssueToWorkspace` so
  linkage is recorded consistently.

### Deferred

- No "from spec import on {date}" badge yet — `specImportBatchId` is
  stamped but not surfaced visually.
- IssueDetail still exposes all 9 legacy `IssueStatus` values in the
  status grid; could prune to the v0.8.5 5-column set.

## [0.8.3] - 2026-05-16

### Added — CLI catalog grid (Settings > Agents)

Visual + functional upgrade to the CLI-detection card in Settings, modeled
after a reference screenshot the user shared. Tier 1 of the broader
"detection + diagnosis + auto-install" feature; Tier 2 (PATH fixes and
native install recipes) deferred.

#### Backend (`src-tauri/src/commands/agent.rs`, `core/agent.rs`)

- New `detect_cli_catalog([{id, binary}]) → [{id, installed, version, path}]`
  Tauri command. Each entry's PATH lookup + version probe run truly
  concurrently via `tokio::process::Command` + `join_all`.
- PATH lookup: 2-second timeout, `kill_on_drop`, `CREATE_NO_WINDOW` on
  Windows. Probes `.cmd` shim as a fallback so npm-installed CLIs (claude,
  codex, gemini, opencode) are found.
- Version probe: 3-second timeout per binary, tries `--version` then `-v`,
  captures the first non-empty line of stdout (falls back to stderr),
  trimmed and clamped to 60 chars.
- Legacy `detect_agent` Tauri command now bypasses the version probe so
  back-compat callers don't pay the new latency.

#### Catalog (`src/lib/cli-catalog.ts`)

13 entries, each with a brand color + lucide icon, in this order:
Claude Code, Codex CLI, Devin for Terminal, Gemini CLI, OpenCode,
**PacketCode** (placed immediately adjacent to OpenCode in the 2-column
grid per request), GitHub Copilot CLI, Kimi CLI, Cursor Agent, Qwen Code,
Qoder CLI, Mistral Vibe CLI, DeepSeek TUI.

Helpers: `brandClasses(color)` for icon/dot color tokens,
`getCliBinaries()` for the bulk-detection payload.

#### UI (`src/components/views/tools/CliAgentsCard.tsx` +

`src/components/views/tools/CliCatalogHeader.tsx`)

- 2-column responsive card grid. Each card: 32×32 brand icon swatch +
  name + version (or "not installed") + status dot.
- Click a card to select it. Click again to deselect. Click another to
  switch. Status dot color matches the reference: selected = amber
  (active), installed-unselected = green (passive), not-installed = faint.
- Header row: "Local CLI" label + "N installed" pill + **Test** /
  **Rescan** buttons. Test reuses the same detection on just the
  selected CLI and renders the version + path inline (✓/✕ icon, 8s
  auto-clear, also clears on selection change).
- Existing Detect / Reset built-ins / Custom-CLI drawer preserved in a
  collapsible "Advanced" section below the grid (closed by default).

#### Process

- 4 parallel implementation agents (backend / catalog / grid / header) +
  2-agent peer review (spec/UX + correctness).
- Reviewer-caught P0: original `resolve_path` was synchronous and
  serialized the entire `join_all` sweep — refactored to fully async with
  per-probe timeouts.
- Reviewer-caught P1s: legacy `detect_agent` latency regression, mounted-
  ref guards on async setState, dot-color inversion vs screenshot, stale
  test output bleeding across selections. All fixed.

### Deferred (Tier 2)

- PATH issue diagnosis + repair (per-OS rabbit hole — Windows registry /
  shell rc files / etc.)
- Native install recipes per CLI (npm / winget / brew / curl-pipe — each
  CLI has its own preferred path)
- Hermes, Pi, Kiro CLI, Kilo catalog entries

## [0.8.2] - 2026-05-16

### Added — Toolbar overhaul

Audit-driven cleanup of the top Toolbar (`src/components/layout/Toolbar.tsx`).
Shipped in two commits with peer-review rounds, plus a final consolidated
review pass before push.

#### Commit 1 (`4710028`) — dedupes + Ctrl+K + global "+ New"

- **Dropped the redundant Costs button.** `LiveSpendChip` is now the sole
  cost-navigation surface; clicking it routes to the Cost Dashboard. Chip and
  dashboard both read from `useAnalyticsStore.data` so they agree on today.
- **Dictation removed from the Modules dropdown.** Still reachable from the
  dedicated VT button, the CommandPalette, the StatusStrip indicator, and
  Settings > Modules. Dropdown hides entirely when only Dictation is enabled.
- **`PaneLayoutControls` moved to WorkspaceView.** Extracted to its own file
  in `src/components/workspace/PaneLayoutControls.tsx`; reads
  `useWorkspaceStore` + `useMosaicStore` directly. Removed the duplicate
  inline `SUBTAB_PRESETS` bar from WorkspaceView that the peer reviewer
  caught.
- **Dropped read-only Toolbar git branch + project name displays.**
  StatusStrip already shows both. Kept the actionable folder picker
  (icon-only, full path in tooltip) and the GitActionButtons pill.
- **Ctrl+K discoverability.** New Search chip on the left side of the
  Toolbar with a visible kbd hint; clicks open the same CommandPalette state
  the global keyboard handler does.
- **Global "+ New" dropdown.** Left side of the Toolbar. Four items, all
  wired end-to-end: New Claude session, New Codex session, New Mission,
  New Issue.

#### Commit 2 (`4ba3562`) — polish

- **Icon sizes normalized to 12** across the Toolbar; only intentional
  outlier is the +New caret ChevronDown at size={10}.
- **Cluster dividers** between Status / Action / Tooling / Project chip
  groups for clearer visual rhythm.
- **Tooltip keyboard-shortcut hints.** VT button now surfaces Ctrl+Shift+D;
  folder picker tooltip restored the project-path context that was lost
  when the visible text was removed in commit 1.
- **Review badge count.** Pending-approval count badge on the Review
  button (red, with "99+" cap) mirroring `ReviewQueueView`'s filter
  exactly. Mission-planner approvals correctly excluded (they surface on
  the mission view, not the review queue).
- **Commit Modal replaces `window.prompt` anti-pattern.** New
  `CommitModal` component with a real multi-line message field,
  auto-focus, no Ctrl+Enter (explicit Commit button only), inline error
  rendering, brief 800ms success state, and no double-click re-invocation
  during the success grace window.
- **Modal X dim-during-busy.** Added a `closeDisabled` prop to the shared
  `Modal` wrapper so callers can visually dim the close button while a
  modal is in the middle of an unbreakable operation.
- **Branch chip refresh on commit.** `CommitModal` calls back to refresh
  `getGitBranch` immediately on success so the branch chip catches up
  without waiting for the 10s poll.
- **Search chip kbd hint contrast** tuned (`bg-bg-primary` vs the chip's
  `bg-bg-secondary`) so the `Ctrl+K` cap reads as a label inside the
  search affordance, not a competing button.

#### Architecture

- 8 implementation agents (4 per commit) + 4 peer reviewers (2 per commit)
  - 1 final consolidated review pass. ~14 agent runs total.
- One P0 caught + fixed: `gitCommit` returns raw `git commit -m` stdout
  (multi-line `[branch sha7] subject\n …`), not a SHA — the modal now
  parses the short sha out via regex and falls back to a label-only
  "Committed" if no match.

### Backlog (deferred)

- Modal lacks Escape-to-close (cross-cutting — affects every modal).
- Theme toggle still exists in both Toolbar and Settings (intentional —
  Toolbar is a power-user one-click).
- Long Windows-path truncation in folder tooltip.
- Re-render perf on the Review badge selector (sub-ms today; only matters
  with hundreds of flights).
- Pane-layout-controls leading internal divider only makes sense when it
  has a left-side neighbour.

## [0.8.1] - 2026-05-15

### Added — Settings panel cleanup + missing v0.8 controls

A focused follow-up to v0.8.0 after an audit pass through the Settings panel.
Fixes three real labeling / placement bugs, surfaces the controls the v0.8
work merited but never got, and regroups Settings from 18 flat sections into
15 sensibly-stacked tabs.

#### Bug fixes

- **Composer-mode label clarified.** Settings > Agents > "Launch default"
  silently shared its backing store with the per-conversation chip in the
  agent input bar — flipping the chip permanently changed the global
  default with no signal. Relabeled to "Default launch location", added
  description copy, per-chip tooltips, and a caption that documents the
  override semantics. Behavior unchanged; vocabulary now matches reality.
- **Gemini API key hoisted.** Previously hidden inside the Dictation card.
  Moved to the unified Settings > AI Providers > API Keys list alongside
  Anthropic / OpenAI / MiniMax / OpenRouter / Ollama. DictationCard now
  shows a status badge + jump link.
- **Theme toggle added to Settings.** `useAppStore.theme` was an orphan
  store value mutated only from the Toolbar Sun/Moon button. Added
  `ThemeSettingsCard` under Settings > General with a Dark/Light segmented
  control. Toolbar toggle preserved as the high-frequency action.

#### Missing v0.8 settings shipped

- **GitHub tab (new).** Token status / Rotate / Disconnect, default merge
  strategy (merge/squash/rebase), require-confirmation toggle for
  destructive PR actions, "default new PRs to draft", and "publish Mission
  attempts as draft PRs by default" — all in one place. `PRActionBar`,
  `PRModal`, and `LaunchAsyncFlightModal` now read their defaults from
  these settings.
- **Workspace defaults.** "Default new workspaces to bypass permission
  prompts" + "Auto-detect GitHub repo on workspace creation"
  (opt-out). The auto-bind probe in `WorkspaceCreationModal` is now gated
  on the toggle.
- **Memory project scope.** Radio for "Match memory by project path"
  (Exact / Parent directory / Global) and a "Pinned patterns survive cap
  eviction" toggle. `getContextItemsForSession` and `capPatterns` honor
  both.
- **Mission auto-trailer.** Toggle + format input with placeholder help
  (`{flightId}` / `{attemptId}` / `{flightTitle}`) and a live preview.
  Backed by `OrchestratorSettings` on the Rust side; the worktree
  `prepare-commit-msg` hook now reads the live settings and only installs
  when enabled.
- **Editable dictation hotkeys.** Push-to-talk and toggle accelerators are
  now user-rebindable via in-place capture (Esc to cancel, modifier
  required for validity). `useDictationGlobalShortcuts` re-registers on
  change.
- **Subscriptions card.** Settings > AI Providers > Subscriptions surfaces
  Claude OAuth + Codex OAuth status (Ready / Login required / Expired)
  with Sign-in (opens the existing PTY login flow) and Sign-out (new
  `sign_out_provider` backend command that removes the credential file).

#### Settings IA reorganization

- 18 flat sections → 15 grouped tabs: **General** (Theme, Notifications),
  **Workspace**, **Agents** (CLI + Settings + Profiles stacked),
  **AI Providers** (API Keys + Subscriptions + Endpoints stacked),
  **AI Routing**, **Memory**, **Missions** (with auto-trailer),
  **GitHub** (new), **Issues**, **Servers**, **MCP** (Servers + Provider
  stacked), **Project Rules**, **Modules**, **Dictation**, **Advanced**
  (Crash Reports + History link + Cost Dashboard link + Prompt Templates
  editor moved out of prime real estate).
- Every prior setting reachable; no functional regressions.

### Architecture

- 2 commits (`936990a` fix + this one). Built by 6 parallel agents
  (3 round-1 fix + 3 round-2 controls/IA) with explicit file ownership.
- Frontend-only changes for most controls; Rust side touched for the
  auto-trailer config plumb (`core/orchestrator.rs`,
  `core/worktree.rs::install_prepare_commit_msg_hook`,
  `commands/flight_attempts.rs::launch_flight_async`) and the
  Subscriptions sign-out command (`commands/provider_auth.rs`).

## [0.8.0] - 2026-05-15

### Added — GitHub pane overhaul + Memory inline surfaces

A wide-coverage v0.8 drop turning the GitHub pane from a read-only viewer
into a real daily-loop surface, plus the deferred memory inline-integration
work from the v0.7 backlog.

#### GitHub — parity layer

- **PR lifecycle actions.** Merge (merge / squash / rebase), close, reopen,
  convert-to-draft / mark-ready-for-review on every PR detail. State-aware
  buttons surface only what's valid for the current PR state.
- **CI / check-run status.** A live status pill on every PR card (combined
  state with passing / failing / pending breakdown in the tooltip) plus a
  dedicated Checks tab in the PR detail listing per-workflow status, app,
  duration, and html link.
- **Issue interactivity.** Comment composer with Ctrl+Enter submit, threaded
  comment list rendering markdown bodies, close / reopen, multi-select
  assignee / label pickers and a single-select milestone picker. Open /
  Closed / All state filters and paginated lists on issues, PRs, and repos.
- **5 previously-stubbed CTAs wired end-to-end:**
  - **Plan flight** → opens the issue body as the first user turn of a new
    Mission Planner spec session.
  - **Branch from issue** → `git checkout -b issue-{n}-{slug}` in the active
    workspace.
  - **Hand off to Claude** → opens a PTY session running `claude` with the
    AI investigation result piped in as the first user input.
  - **Draft patch** → seeds a single-attempt async Flight (claude-oauth +
    sonnet-4.6) with the investigation as the brief.
  - **Save as memory** → captures the investigation as a `manual_note`
    MemoryEvent against the active project.

#### GitHub — AI features

- **PR description generator.** One-shot Claude call inside the PR creation
  modal generates a structured description from diff + commits + linked
  issues. User can edit before submitting.
- **Pre-flight AI code review.** Streaming review on the PR detail with
  structured Blocking / Asks / Nits output keyed by `file:line`. Cached per
  PR so re-opening doesn't re-burn the call.
- **"Catch me up" repo digest.** Activity-tab button with 24h / 7d / 30d
  scope chips that streams a markdown summary across the four sections
  Shipped / In progress / Needs attention / Quiet.
- **Issue triage drawer.** Bulk-suggest labels, priority (P0–P3), rationale
  and duplicate-of links across selected untriaged issues. Batches of 20
  per call. User picks what to apply.

#### GitHub — flow polish

- **PR creation modal upgrades.** Branch picker autocompletion (with the
  default branch + recent branches sorted first), draft toggle, "Closes #N"
  autofill seeded from the active issue, reviewer / label / milestone
  pickers with post-create progress per setting.
- **Diff viewer file tree.** Left-side navigator listing every changed file
  grouped by directory with +/-/M status icons; clicking scrolls the diff
  to that file. Header summary: `N files changed · +X / -Y`.
- **Read-only PR review surface.** New panel under the PR diff renders
  existing review submissions (Approved / Changes Requested / Commented
  pills) and line-comment threads grouped by file.

#### Mission Planner ↔ GitHub

- **"Publish attempts as draft PRs" Flight option.** When toggled on, every
  attempt that completes successfully pushes its worktree branch to origin
  and opens a draft PR titled `[Flight {title}] Attempt {id}` with the
  Flight objective as the body. Per-attempt link surfaces on the attempt
  tile. Failures fall through to `errorMessage` so the user sees why.
- **Workspace auto-bind to GitHub repo.** New workspaces run
  `git remote get-url origin` and stamp `{owner, repo}` onto the workspace
  record. A small linked-repo badge surfaces in the sidebar.
- **Auto-trailers on agent commits.** A `prepare-commit-msg` hook installed
  per worktree appends
  `Run-By: PacketBench mission F-<flightId> attempt A-<attemptId>` to every
  commit made inside that worktree, idempotently (existing trailer is left
  alone).

#### Memory inline surfaces

- **AgentInputArea context-preview chevron.** A small collapsible above the
  input that lists the memories about to be injected into the next user
  turn. Live-reactive to the memory store.
- **MissionsView memory chip.** Completed missions show "Brain N" with the
  count of extracted lessons; clicking deep-links into MemoryView filtered
  to that mission.
- **WorkspaceSidebar "Recent learnings" feed.** The last 5 memory events
  for the active project, with a "View all →" link.
- **`LearnedPattern.projectPath` migration.** Patterns are now
  project-scoped on extraction; legacy patterns without `projectPath`
  remain global (match every project) for back-compat.
- **Pin button wired.** Pinned patterns sort first in
  `getContextForSession` and are exempt from the `capPatterns` eviction
  limit. Star icon lights up when pinned.
- **New `manual_note` MemoryEvent variant** for human-captured knowledge
  (used by the GitHub Save-as-memory CTA and any future capture surfaces).

### Fixed (in-flight during this drop)

- **`flight_attempts.rs` lost-update races.** Four functions
  (`append_attempt`, `update_attempt_status`, `set_attempt_draft_pr`,
  `set_flight_publish_attempts_as_prs`) converted from naked
  load-mutate-save to `storage::with_state_lock`. Eliminates the silent
  write-loss window between concurrent attempts.
- **Double-publish race in `setAttemptStatus`.** A `publishingAttempts` set
  guards against re-entry, preventing duplicate draft PRs from concurrent
  status-completion calls.
- **AI streaming listener race.** `PRDescriptionButton` and
  `PRReviewPanel` now pre-allocate the session id frontend-side and attach
  all listeners BEFORE invoking the backend, so the first streamed chunks
  can't be dropped.
- **`api-agent:chunk:<sid>` contract alignment.** Every emitter (sidecar,
  api_agent, github catch-up) now publishes a raw `String` payload — no
  more mixed object-vs-string shape on the same event channel.
- **`setAttemptDraftPr` rollback.** Optimistic write to `draftPrNumber` is
  reverted on backend failure with an `errorMessage` surfacing the failure
  on the attempt tile.
- **`IssueActionBar` swallowed errors.** Each apply path now catches errors
  and renders inline; popovers stay open with a visible message instead of
  half-closing.

### Architecture

- 29 new files, 27 modified. ~10.9K LOC delta.
- Design + scope locked in [`dev/archive/v0.8-github-and-memory.md`](./dev/archive/v0.8-github-and-memory.md).
- Built by 8 parallel implementation agents → 2-agent peer-review pass
  (spec/UX + correctness/race) → 5 fix-up agents addressing P0s
  (PR actions and CI check-runs had to be re-shipped after silent revert
  during the parallel ramp), then commit.

### Deferred to v0.9 / v1.1

- **Authored** PR line comments + threads (read-only viewing shipped now;
  composing new threads remains).
- **Notifications inbox** (`/notifications` integration).
- **Issue → Mission auto-mirroring back to GitHub issue tree** (one-way
  hand-off shipped, bidirectional sync still risk-prone).
- **Embedding / RAG over memory** (needs a vector layer; substantial
  infra).
- **"Ask your project" memory chat tab.**
- **30-day memory digest.**

## [0.7.0] - 2026-05-15

### Added — Mission Planner v1

The headline feature: an autonomous AI Mission Planner that owns a
mission from a spec conversation through completion. One Claude
session per mission, callable tool surface, journal, safety rails,
context compaction.

#### Highlights

- **Spec-mode chat.** Click "Start a mission" → talk to a Sonnet 4.6
  planner about what you want to build. Hit Launch when ready.
- **Autonomous decomposition.** The planner breaks your spec into
  2–4 milestones + 4–10 tasks, each spawned as an executor agent in
  its own worktree. Milestones and tasks populate live on the
  mission detail pane.
- **Self-driving lifecycle.** The planner reacts to task
  completions/failures, replans on retryable errors (with
  RateLimit/Network exempted from the replan cap), and asks the
  user for input via the async approval gate when it genuinely
  needs to escalate.
- **Mission journal.** Every planner action is recorded in
  append-only markdown at
  `~/.packetbench/missions/<shortId>_<id>.md`. A new Journal tab on
  the mission detail pane renders it live.
- **Cost split.** StatGrid shows Planner vs Executor spend
  separately, with a cumulative-token chip for OAuth subscriptions.
- **Safety rails.** Per-mode tool-call caps (50 / 25 / 25), task
  ceiling 60, rate-limit detection + auto-resume, kill-switch
  button, Awake-stickiness watchdog, cold-start enforcement (active
  missions flip to Paused on app restart).
- **Context compaction.** At 150K cumulative input tokens the
  planner's conversation is summarized and the session is reset
  with the summary as priming context, so multi-day missions don't
  hit the context wall.

#### Architecture

- 10 epics shipped (E1–E8 + E10) over ~14K LOC across the Rust
  backend, agent-sidecar (Node), and React frontend.
- Sidecar protocol bumped 4 → 6 (typed `inject_user_turn` +
  `planner_tool` round-trip + `rate_limited` events +
  `maxOutputTokens`).
- In-process MCP server inside the agent-sidecar exposes 7 planner
  tools to Claude (validated by spike — see
  `dev/archive/flight-planner-spike-retro.md`).
- 9 commits, ~70 new tests (Rust unit + vitest + sidecar smokes).

#### Deferred to v1.1

See [`backlog.md`](./backlog.md) for the full list. Headlines:

- Helper planner (one-shot Opus 4.7 spawn for huge scopes).
- Back-port milestone-gating + collision-detection to the
  async-attempts execution path.
- Predictive quota awareness via response headers (if the SDK ever
  exposes them).
- Subscription-% display (no public Anthropic endpoint today).
- Crash-resilient planner sessions across app restarts.

#### Documentation

- `dev/archive/flight-planner-plan.md` — locked design spec.
- `dev/archive/flight-planner-spike-retro.md` — spike findings.
- `dev/archive/flight-planner-v1-acceptance-runbook.md` — manual
  validation procedure.

---

## [0.6.0] - 2026-05-12

### Added — SSH hardening & remote workspaces (Phases 1–3)

#### Phase 1 — security & correctness

- **Sidecar SSH guard** — selecting an SSH target with `api-claude-oauth` or
  `api-openai-codex` now returns a clear error rather than silently running
  locally; matching frontend UI gate disables SSH selector when a sidecar
  provider is active (`src-tauri/src/commands/api_agent.rs`,
  `src/components/agents/AgentInputArea.tsx`).
- **Shell-escaped `buildSshArgs`** — `remoteCommand` and `remoteArgs` now run
  through `shellEscape`, closing a latent shell-injection surface
  (`src/lib/ssh.ts`).
- **Replaced TOFU host-key acceptance with explicit pinning** — three new
  Tauri commands (`ssh_fetch_fingerprint`, `ssh_pin_host`,
  `get_app_known_hosts_path`), app-managed `known_hosts` file at
  `<app_data_dir>/ssh/known_hosts`, "Verify host key" UX in `ServerFormModal`
  with SHA256 display + "Trust this host" gate. Legacy servers without a
  pinned fingerprint fall back to `accept-new` with a tracing warning.
  Persisted `host_fingerprint` field added to `ServerConfig` (TS + Rust DTO).
  Touches `src-tauri/src/commands/pty.rs`, `src-tauri/src/core/execution.rs`,
  `src/components/servers/ServerFormModal.tsx`, `src/lib/bootstrap.ts`.
- **ControlMaster hardening** — sockets moved from `~/.ssh/.pkt-cm-*.sock`
  to `<app_data_dir>/ssh-cm/` (0700, Unix only via `#[cfg(unix)]`);
  `ControlPersist` reduced from 10m to 60s
  (`src-tauri/src/core/execution.rs`).

#### Phase 2 — consolidate SSH stacks

- **Unified `ServerConfig` + `SshTarget`** onto a single canonical
  `ServerConfig` model. Deleted `src/types/ssh.ts`,
  `src/stores/sshTargetStore.ts`, `src/components/agents/SshConnectModal.tsx`.
- **`AgentInputArea`** now uses `serverStore` + `ServerSelectorPopover` for
  SSH selection. New URI scheme `ssh://<serverId>?path=<encoded>`
  in `src/lib/ssh-uri.ts` for per-conversation remote paths.
- **One-time migration** of legacy `packetbench:ssh-targets` localStorage
  records into `serverStore` at app bootstrap
  (`src/lib/sshTargetMigration.ts`); preserves IDs so persisted
  `AgentConversation.sshTarget.id` references still resolve. Reads both new
  and legacy `packetcode:ssh-targets` keys, deletes both on success.
- **`flight_attempts.rs`** now propagates `host_fingerprint` end-to-end into
  `AttemptTargetSpec::Ssh`, so flight attempts honor pinning instead of
  silently degrading to TOFU.

#### Phase 3 — remote workspaces

- **"Location: Local / Remote (SSH)" step in `WorkspaceCreationModal`** —
  pick a registered server (fingerprint-verified), enter remote project path,
  see a live probe of existence / is-directory / is-git-repo.
- **`ssh_check_remote_path` Tauri command** — pinned-mode SSH probe parsing
  `DIR_GIT | DIR | FILE | MISSING` with 8s timeout
  (`src-tauri/src/commands/pty.rs`).
- **`clone_repo_remote` command** — `git clone -- <url> <dest>` over SSH with
  defense-in-depth: allowlist validators (branch / dest / repo URL all
  reject `-`-prefix and shell metacharacters), `--` flag-parsing terminator,
  `sh_quote` shell-escape on every positional arg, 10-minute
  `ssh_run_with_timeout`. 11 new unit tests for the validators.
  (`src-tauri/src/core/worktree.rs`,
  `src-tauri/src/commands/scaffold.rs`).
- **Remote git dashboard** — new `get_git_branch_remote` /
  `get_git_status_remote` commands. `GitDashboard.tsx` accepts an optional
  `serverId` prop, routes refresh to remote variants, classifies SSH errors
  (`server-missing | not-a-repo | connection | other`) with a retry button.
  Commit / push / pull / branch operations disabled with an explanatory note
  for remote workspaces (write commands deferred to a future phase).
- **`workspaceStore.createWorkspace`** validates `serverId` against
  `serverStore` and requires non-empty `remoteProjectPath`.
  `setActiveWorkspace` no longer pushes the remote path into
  `layoutStore.projectPath`.
- **DTO round-trip fix** — `tauri.ts::fromDtoWorkspace` /
  `toDtoWorkspace` now preserve `serverId` and `remoteProjectPath` (was
  silently dropping both on persistence).
- **Phase 1 host-key pinning is honored** by all four new commands.

### Fixed — remote-workspace consumer gaps

- **`CodeQualityModal`** short-circuits with "not yet supported on remote
  workspaces" message; toolbar Quality button disabled with tooltip when
  the active workspace is remote
  (`src/components/quality/CodeQualityModal.tsx`,
  `src/components/layout/Toolbar.tsx`).
- **`EditorPane`** replaced with a placeholder card for remote workspaces —
  file tabs still render so open-files state remains visible
  (`src/components/views/WorkspaceView.tsx`).
- **`MultiTargetPicker.localOptions`** filters out remote workspaces so
  flight launches can't pick a remote path as a local base
  (`src/components/flights/MultiTargetPicker.tsx`).
- **`IdeationView`** already gates remote workspaces with a "not supported
  yet" message (landed earlier in Phase 3.1).

### Added — polish & integrations

- **PacketCode CLI** wired as a built-in agent.
- **Dictation** — global hotkeys, focus-aware insertion, OS-level plugin.
- **Workspace boot performance** — local cache of workspaces, deferred
  heavy hydration on startup.
- **First-open polish** — Inter font self-hosted, branded splash, welcome
  motion, welcome rows, splash alignment, scrollbar tokens.
- **Agents pane decoupled from workspaces** — agents can run independently
  of an open workspace.

### Removed

- `src/types/ssh.ts`, `src/stores/sshTargetStore.ts`,
  `src/components/agents/SshConnectModal.tsx` (consolidated into
  `ServerConfig`).

### Tests

- All 197 vitest tests pass (incl. new `workspaceStore` cases).
- All 164 cargo `--lib` tests pass (incl. clone-validator unit tests and
  host-key pinning regression tests).

---

## [0.5.0] - 2026-05-04

### Added — Agents pane "match the best of Claude Code & Codex" initiative

Driven by a 6-agent deep-dive on Claude Code, Codex, Cursor, Windsurf,
Aider, Cline, Continue.dev, Zed, Copilot Workspace, JetBrains Junie, and
Warp; followed by a 4-agent deep-dive on the OpenAI "Codex for (almost)
everything" April 16 release + GPT-5.5 + CLI 0.107→0.128 cuts.

#### Tier 1 — visible polish

- Drag-drop and clipboard-paste images in the launcher (5 MB cap, removable thumbnail chips); image blocks land in the SDK content array on send
- `SessionHealthBar` in chat header: model · context % gauge · cumulative tokens · session $ · git branch
- Mid-turn steering: `Tab` queues a follow-up; `Alt+.` / `Alt+,` nudge the model toward thorough / fast within the same provider
- `Shift+Tab` cycles a single mode chip (`default | plan | manual | yolo`)
- New slash commands `/usage`, `/history`, `/review`, `/goal`, `/template`; saved prompt templates surface as native `/<slug>` commands
- Header context badges: provider auth, linked Mission with click-to-jump, MCP `N/M` server toggle dropdown, memory-context tooltip previewing the actual injected patterns
- One-time onboarding overlay on first Agents-view visit

#### Tier 2 — killer features

- Persistent dockable `PlanPanel` parsing Anthropic SDK `TodoWrite` and the markdown `task_list` tool
- `PendingApprovalsRollup` with "Apply / Reject / Cancel all" when 2+ pending writes or permissions stack up
- `/review` spawns a Reviewer subagent fed a unified diff of the parent conversation's pending writes — returns 🛑 Blockers / ⚠️ Concerns / 💡 Nits
- Durable agent profiles (Default / Scout / Reviewer built-ins, plus user-created); `AgentProfilesCard` editor in `Settings → Agent Profiles`
- AGENTS.md / CLAUDE.md auto-injection from the project root
- Memories panel inline editor (edit text + category, Ctrl+Enter saves)
- `RunningAgentsChip` in toolbar with live count of streaming agents, click-to-jump and stop

#### Tier 3 — sidecar protocol v3 → v4 + frontend

- Sidecar `PROTOCOL_VERSION` bumped 2 → 4
- New events: `plan_block` (structured TodoWrite mirror), `tool_output_extended` (Bash exit code + stdout/stderr; Write/Edit modified paths), `turn_summary` (running tokens between turns)
- New requests: `set_permission_mode`, `set_model`, `retry`, `cancel_pending_tools` (drains parked permission/edit prompts as denied without killing the loop)
- `StartSessionRequest` gains `attachments` and `resume`; `EditResponseRequest` gains `mergedContent` (per-hunk acceptance honored sidecar AND every in-process provider)
- `permission_request` gains `batchId`/`batchSize` for grouped rollups
- `done` payload gains `resumeToken`; persisted on the conversation
- Auto-failover heuristic on rate-limit (Opus → Sonnet → Haiku, o3 → gpt-5 → o4-mini, MiniMax → highspeed) with a one-retry-per-turn guard
- Worktree-per-conversation toggle in launcher (`.pkt-worktrees/<convId>` on a fresh `pkt/<convId>` branch)

#### Codex Spring 2026 absorption (A1–A5 + B1–B9)

- Codex `todo_list` items map to the existing `plan_block` event so PlanPanel works for Codex too
- `reasoning_tokens` + `cached_input_tokens` from `usage` flow through `turn_summary` and roll into `aggregateConversationCost` (was: under-reporting GPT-5.5 spend)
- Codex MultiAgentV2 sub-agent attribution: `turn_summary.address` (`/root/agent_a` etc.) routes child tokens into a per-address bucket on the conversation; CostDashboard rolls every bucket into the total
- AGENTS.md cascading resolver in Rust core (`core::agents_md`) walking `~/.claude/AGENTS{.override,}.md` → git-root → cwd, picking one of `AGENTS.override.md` / `AGENTS.md` / `CLAUDE.md` per directory, concat with `<!-- source: <path> -->` headers, capped at 32 KiB. Honors `CLAUDE_HOME` env override for CI parity with Codex's `CODEX_HOME`
- `ProjectRulesCard` in `Settings → Workspaces & Terminal → Project Rules` reads + writes both `AGENTS.md` and `CLAUDE.md` on save; surfaces a Unify affordance when the two files diverge; offers a starter template when neither exists
- Hover-`+` Codex-App-style diff comments: per-line `+` button in `ToolDiffView` opens an inline composer; queued comments fold into the next user turn as a `File comments:` preamble
- Smart-approval prefix-rule proposal: `PermissionPrompt` gains a fourth row "Always allow rule `<pattern>`"; one click writes the derived pattern into `conversation.allowedTools`
- Composer-mode segmented control (Local / Worktree / Cloud) replaces the binary worktree toggle; persisted via localStorage
- Right-rail tabbed mode (`AgentTabbedRail`) with Plan / Diff / Inspector tabs in a single 340 px column; toggleable from chat header
- Persistent goals bridged to Missions: new `goalStore` + `/goal` slash command + goal-bound footer in PlanPanel (Pause / Resume / Complete) + 🎯 N badge per Mission row
- `LiveSpendChip` in toolbar combining today's persisted total (analyticsStore) + live in-memory session $ across every open API conversation
- Old-model pinning per profile via `pinnedModel` field; resolves as `profile.pinnedModel ?? selectedModel ?? getDefaultModel(agent)` at launch
- Plan-with-Claude → Execute-with-Codex one-click handoff: PlanPanel "Hand off to Codex →" button when parent is Claude AND Codex auth is `ready`; spawns a fresh Codex conversation seeded with `buildHandoffPrompt(parent)` (distilled spec + plan + discussion summary, capped at 12 KiB); `parentConversationId` field wires a "← back to plan" link in the child's chat header

#### Follow-ups (F1–F10)

- Auto-resume hydrated conversations: extracted listener block into `installApiAgentListeners` helper; `sendMessage` routes the first post-restart send through `resumeApiConversation` with the stored `resumeToken`
- In-process providers honor `mergedContent` for per-hunk diff acceptance (parity with sidecar Anthropic)
- Anthropic sidecar emits `tool_output_extended` (Bash exit code + stdout/stderr; Write/Edit modifiedPaths) and `turn_summary` (running per-message tokens for live SessionHealthBar updates)

### Fixed

- **macOS title bar shows native traffic-light controls** — config switched to `decorations: true` + `titleBarStyle: "Overlay"` + `hiddenTitle: true`; `lib.rs` setup hook strips decorations at runtime on Windows + Linux so the custom chrome stays the only chrome there. `TitleBar.tsx` detects macOS via userAgent, hides the Win-style min/max/close cluster, reserves 78 px of left padding for the traffic-light area
- **Standalone `target/<profile>/packetbench.exe` reported "Sidecar down"** — two stacked bugs:
  - Capability gate: `app.shell().sidecar("node")` is rejected by Tauri's permission layer unless an explicit `shell:allow-execute` entry lists `node` with `sidecar: true` (added in `74e6ba9`)
  - Per-triple Node binary missing: Tauri's shell plugin on Windows resolves `sidecar("node")` to `<exe_dir>/node-<target-triple>.exe`, not generic `node.exe`; `build.rs` now copies `binaries/node-<triple>.<ext>` into the cargo output directory at compile time (added in `8f49083`)

### Removed

- `.github/workflows/{build,ci,release}.yml` — builds and releases run locally; no GitHub Actions CI in this repo

### Sidecar protocol

- At this release, the sidecar protocol advanced to v4. v4 added `cancel_pending_tools` request. v3 added typed `attachments` on `start_session` / `send_message`, `mergedContent` on `edit_response`, `batchId`/`batchSize` on `permission_request`, `resumeToken` on `done`, plus `plan_block` / `tool_output_extended` / `turn_summary` events. Old sidecars reply "Unknown request type" to v3+ requests; supervisor warns on version mismatch (does not refuse)

---

## [0.4.0] - 2026-04-11

### Added

#### Flight Deck — Mission Control Redesign

- Single-screen master-detail layout replaces the old list + drill-in pair
- Status-grouped flight list on the left (Attention, Active, Review, Draft, Done, Cancelled)
- Attention group auto-surfaces paused, failed, and approval-needed flights
- Right-pane mission control tiles: FlightHeaderTile, FlightStatStrip (cost, tokens, tasks, approvals, sessions, updated), MilestonesPanel, LiveAgentsTile, ApprovalsTile, TimelineTile
- Inline approve / deny from the per-flight Approvals tile
- Inline edit of flight title, objective, status, and priority dropdowns
- Pause / Resume / Cancel lifecycle controls on the selected flight
- "Try the AI planner →" CTA on the empty Flight Deck to surface the planner chat

#### Workspace Persistence

- Workspace view stays mounted across tab switches (Flights / Issues / Tools) — PTY sessions, scrollback, and agent state persist
- All active workspaces mount simultaneously with `display: none` toggling; switching workspaces shows different terminal sets without restarting CLIs
- Workspace creation from a flight now persists the `flightId` through `commitWorkspaces` (was silently dropping it before)
- Flight `projectPath` falls back to the global project path when empty, written back to the flight for consistency

#### First-Run Onboarding

- 3-step onboarding pane on a fresh launch: Open Folder → Pick Agents → Open Workspace / Flight Deck / Skip
- `AgentDetectionList` component showing installed / not-found / checking states for each AI CLI
- Install hint links beside each not-found CLI (Claude Code, Codex, Gemini, OpenCode docs)
- Bootstrap fires `detectInstalled()` on startup so agent availability is known before the user picks one
- Onboarding completion persisted in `localStorage` (`packetcode:onboarding-complete`)

#### Mosaic Tiling System

- React Mosaic-based draggable pane tiling replaces the fixed CSS grid
- Layout presets: 1×1, 1×2, 2×1, 2×2, 2×3, 3×2 — available in the main toolbar when a workspace is active
- Per-pane drag handle, minimize, and restore via `MosaicTile` wrapper
- Mosaic tree built from workspace pane count with sensible default preset

#### DTO Layer

- Rust API DTO module (`src-tauri/src/api/`) decoupling internal types from the TS serialization contract
- Generated TypeScript schema types (`src/generated/tauri-schema.ts`)
- Typed event name helpers (`src/lib/events.ts`)
- All Tauri commands and frontend stores refactored to use DTOs, eliminating manual snake_case/camelCase conversion

#### UI Polish

- Unified per-pane header bar: drag grip, status dot, agent icon + name, CLI pill, restart button — consolidated from three separate bars (MosaicTile drag handle, WorkspacePane agent header, TerminalHeader)
- Richer tooltips on all right-side toolbar buttons (Review, Theme, Cost, Deploy, Quality, Git, Project, Profile, Pane layout)
- Profile button now reads "Profile: Auto (Optimized)" with a descriptive tooltip
- Workspace empty state: "A Workspace is a tiled set of agent terminals scoped to one project."
- Flight Deck empty state: Flight definition + AI planner CTA
- Sidebar "PROJECTS" renamed to "RECENT FOLDERS" to remove Workspace/Project terminology overlap
- Cursor-inspired dark theme restyle

### Fixed

- **CMD window flashes on Windows** — `detect_agent` now uses `hide_window` so the `where` probes don't pop console windows; removed redundant safety-net `useEffect` in WorkspaceCreationModal
- **Memory leaking across projects** — `getContextForSession` now takes the current project path and refuses to return context scanned from a different project; memory store stamps `projectPath` on scan
- **Model names** — Claude model aliases updated to un-dated identifiers (`claude-opus-4-6`, `claude-sonnet-4-6`, `claude-haiku-4-5`) so they always resolve to the latest version
- **Launch Workspace from flight broken** — `flightId` now persists via `createWorkspace`; empty `projectPath` falls back to global path
- **Infinite re-render loops** — fixed in FlightDeckView, Toolbar, and workspace creation (unstable function selector subscriptions, inline callback refs in `useTerminalSession`)
- **PTY spawn failures and orphaned processes** — cleanup on unmount, proper exit-requested tracking
- **WebGL resource leaks** — explicit WebglAddon disposal before terminal teardown
- **CLI binary paths on Windows** — `.cmd` wrapper resolution for Claude, Codex, etc.
- **Terminal PTY output fidelity** — preserving raw byte stream integrity
- **Disabled not-installed agents in WorkspaceCreationModal** — buttons now show `opacity-50 cursor-not-allowed` with install links instead of silently failing when clicked

### Changed

- `"mission"` route removed from `AppView`; `MissionWorkspaceView.tsx` deleted — the Flight Deck is now the single entry point for flight management
- `BroadcastBar` component deleted; broadcast feature removed entirely
- Workspace toolbar, broadcast bar, and mosaic preset bar consolidated into the main toolbar
- `WorkspaceView` is always-mounted in `App.tsx` (matching the legacy `MosaicContainer` pattern) so terminals survive view switches
- `TerminalPane` accepts `renderHeader` prop for custom header injection; `TerminalHeaderRenderState` type exported
- `WorkspaceSessionConfig` extended with optional `flightId`
- `MemoryState` gains `projectPath` field; `getContextForSession` requires the current project path argument
- README updated to reflect the Workspaces vs Flight Deck split and new project layout

---

## [0.3.0] - 2026-03-16

### Added

#### Missions System

- Mission domain model with types, Zustand store, and localStorage persistence
- `missionStore` with CRUD operations, issue/session linking, and status rollup computation
- `missionId` field on issues with backward-compatible migration for existing data
- Dedicated **Missions** view: master-detail layout with mission list, search, status filter, inline create form, and full detail panel
- Inline editing of mission title, objective, status, and priority
- Mission status rollup computed from linked issue states (needs_human > blocked > done > active > draft)
- **Mission Control** supervision view: status strip with counts, attention queue for blocked/needs_human missions, active missions section, collapsible all-missions groups
- Mission Control toolbar button with live attention badge (amber count of blocked + needs_human)
- Launch Claude or Codex sessions from mission detail with context-rich prompts (mission objective + linked issues with descriptions and acceptance criteria)
- Auto-link launched sessions to the originating mission
- Mission badges on issue cards (green Target icon + truncated title)
- Mission assignment in issue detail modal (assign/remove dropdown)
- Mission filter dropdown on issue board (all / unassigned / specific mission)
- Mission selector when creating new issues
- Delete confirmation dialog for missions

#### Shared Utilities

- `src/lib/time.ts` — shared `relativeTime()` function (consolidated from 3 duplicate implementations)
- `src/lib/mission-colors.ts` — shared mission status, priority, and issue status color/label constants

### Fixed

- `useMemo` dependency array in CostDashboardView (pre-existing lint error)
- MissionControl → MissionsView navigation now syncs selected mission via store
- Consistent naming: "New Mission" / "Create Mission" labels, capitalized priorities, proper issue status labels

### Changed

- `CoreView` type expanded with `"missions"` and `"mission_control"`
- Toolbar gains Missions tab (top-level) and Control button (right section)
- Issue interface gains `missionId: string | null` with migration
- `addIssue` signature makes `missionId` optional for backward compatibility

---

## [0.2.0] - 2026-02-27

### Added

#### MCP Server Integration Hub

- View, add, edit, and delete MCP server configurations
- Global scope (`~/.claude/settings.json`) and project scope (`.mcp.json`)
- Server list grouped by scope with toggle, edit, and delete controls
- Add/Edit modal with name, command, args, environment variables, and scope selector
- Registered as a module (category: integration, icon: Plug, enabled by default)

#### Project Template Scaffolding

- "New Project" wizard with 3-step flow: template selection, configuration, result
- 6 built-in templates: Next.js, React+Vite, Python FastAPI, Rust CLI, Node Express, Blank
- Automatic tool availability detection (node, cargo, python)
- Directory picker for parent folder selection
- Auto-switches `projectPath` to newly created project on success
- "New Project" button on Welcome Screen
- Registered as a module (category: utility, icon: FolderPlus, enabled by default)

#### Deploy Pipeline

- Core deploy view with toolbar button (Rocket icon)
- Auto-detects deploy configs from `packetcode.deploy.json`, `package.json` scripts, `vercel.json`, `netlify.toml`, and `Dockerfile`
- Custom deploy config creation and persistence in `packetcode.deploy.json`
- Live terminal output via PTY for deploy commands
- Deploy run history with status tracking (running, success, failed) and duration
- Config cards with one-click deploy and history sidebar

#### Rust Backend

- `mcp.rs` — 3 commands: `read_mcp_servers`, `write_mcp_server`, `delete_mcp_server`
- `scaffold.rs` — 2 commands: `scaffold_project`, `check_scaffold_tools`
- `deploy.rs` — 2 commands: `read_deploy_config`, `create_deploy_config`

### Changed

- Added `"deploy"` to `CoreView` union type
- Updated Toolbar with Deploy button in right section
- Welcome Screen now shows "New Project" button when scaffold module is enabled
- Module registry expanded from 2 to 4 modules

---

## [0.1.0] - 2026-02-22

### Added

#### Core IDE

- Tauri v2 desktop application with custom dark theme
- Multi-pane session layout with resizable panels
- PTY-based terminal emulation using xterm.js and portable-pty
- Custom window title bar with minimize/maximize/close controls
- Keyboard shortcuts for pane switching, view navigation, and session splitting
- File explorer panel with directory tree browsing
- Project folder selector with persistent path storage
- Git branch display in toolbar and status bar

#### AI Sessions

- Claude Code CLI integration with full PTY terminal
- OpenAI Codex CLI integration with full PTY terminal
- New Session modal with CLI toggle, model selector, and prompt input
- Model selection: Opus 4.6, Opus 4.5, Sonnet 4.5, Haiku 4.5
- Real-time status line monitoring for Claude and Codex sessions
- Session tab bar for switching between active sessions
- Session history view

#### Agent Profiles

- 5 built-in agent profiles: Auto (Optimized), Speed Runner, Thorough Reviewer, Security Auditor, Refactor Pro
- Custom profile creation with name, description, icon, color, system prompt, and default model
- Profile selector in New Session modal — auto-fills model and prepends system prompt
- Quick-switch profile dropdown in toolbar
- Profile management (create/edit/delete) in Tools > Settings

#### Issue Tracker

- Kanban board with 6 columns: To Do, In Progress, QA, Done, Blocked, Needs Human
- Issue creation with title, description, priority, labels, epic, and acceptance criteria
- Drag-and-drop between columns
- Issue detail view with full metadata
- Session linking — associate issues with AI sessions
- Configurable ticket prefix and custom epics/labels
- Spec2Tick: AI-powered spec parsing into structured tickets

#### GitHub Integration

- Personal access token authentication
- Repository browser (30 most recently updated repos)
- Open issues list with search and label filtering
- Full issue detail view with metadata
- "Import to Board" — convert GitHub issues to local kanban tickets
- "Investigate with AI" — Claude analyzes issue against codebase
- Pull request creation modal (title, body, head/base branch)

#### Memory Layer

- File Map: AI codebase scan generating 1-line file summaries
- Session History: AI-powered session summarization with key decisions and modified files
- Learned Patterns: AI-extracted recurring patterns with category (architecture, convention, preference, pitfall) and confidence scores
- Memory context injection toggle in New Session modal
- Pattern and summary management (view, delete, refresh)
- Persistent storage in localStorage

#### AI Tools

- Vibe Architect: interactive AI project scaffolding and architecture design
- Insights Chat: conversational codebase Q&A with Claude
- Ideation Scanner: AI-generated feature ideas, improvements, and suggestions
- Code Quality: on-demand AI code quality analysis

#### UI/UX

- Welcome screen with quick-start actions
- Tools dropdown menu in toolbar with all features
- Status bar with session info and Claude/Codex status lines
- Error boundaries for graceful failure handling
- Dark theme with custom color tokens (bg-primary, accent-green, etc.)
- Responsive layout with collapsible panels
