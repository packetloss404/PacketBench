# Workspace 0.14.7 implementation and acceptance evidence

Release preparation record, September 12, 2026. Source fixes and all eleven
full quality gates have passed. **The 0.14.7 package build is pending.**
Installation is outside this build request. The latest verified
installed package remains 0.14.6; its evidence is in
[`workspace-usability-evidence-2026-09-11.md`](./workspace-usability-evidence-2026-09-11.md).

## Workspace summary correction

`src/lib/workspacePaneSummary.ts` classifies panes by `kind` before reading CLI
carrier fields. Both the Workspace header and Fleet projection now distinguish
`File viewer` and `Saved conversation` from actual terminals. Eight terminal
panes plus one README viewer therefore no longer report nine terminals. Actual
CLI names remain visible; header badges preserve account grouping and account
dots, and Fleet retains conversation attention/needs-you mapping.

Focused evidence reported by the implementing worker:

```powershell
pnpm exec vitest run src/lib/__tests__/fleetRows.test.ts src/components/workspace/__tests__/FleetSidebar.test.tsx src/components/views/__tests__/WorkspaceLaunchQuality.test.tsx --maxWorkers=1
pnpm exec tsc --noEmit
```

All **33 tests in three files** passed, alongside type checking and targeted
ESLint. These are component/projection checks; installed badge rendering has
not yet been checked for 0.14.7.

## Missing-conversation zoom correction

The missing-transcript fallback now carries the normal zoom marker and selects
its pane on pointer or keyboard focus. Zooming it through the layout toolbar
keeps the explanation and Remove tile action visible instead of blanking the
canvas. Regression coverage checks the actual Mosaic CSS reveal selector,
Show all panes recovery, and pointer/keyboard selection.

## Monitor concurrent-open correction

`src-tauri/src/commands/monitor_windows.rs` retains asynchronous native creation
and adds a separate Tokio mutex around lease replacement, singleton lookup and
native creation. Concurrent requests cannot both pass the singleton lookup and
attempt to create the same native window label. The lease-map mutex remains
available while the new WebView starts, so its lease handshake is not blocked
by native creation. An unsuccessful creation releases the gate for retry.

From `src-tauri`, the implementing worker ran:

```powershell
cargo test --lib commands::monitor_windows::tests -- --test-threads=1
```

All **four tests** passed. New cases model eight concurrent requests producing
one creation and seven reuses, and failure followed by retry. This uses a fake
native creation seam; it is not a new packaged/native concurrency acceptance
claim. Formatting and diff checks passed. Earlier 0.14.3 native Monitor proof
remains attributed to its original build.

## Native WebView2 output profiling

The dedicated host in `scripts/acceptance/WorkspaceWebView2Host.cs` loads the
existing Workspace harness from loopback Vite, using its own fresh WebView2
profile. It mounts the production Workspace and real xterm while mocking Tauri
events and PTY commands. It neither attaches to the installed application nor
starts real terminal/provider processes. The fixture's raw `scope` text retains
its browser wording; `manifest.json` and `runtime.txt` identify this execution
as the dedicated native WebView2 host.

The runner uses official NuGet SDK **1.0.4191.47**, pinned to SHA-256
`F492BBF547D0DA329553B6727435B677579B1E9F91CC9E4A1AD029366D5F23D0`.
The observed runtime was **152.0.4191.66**, with a **visible 1280×800** viewport.
Measurements began after the concurrent Rust compilation finished; the
installed application with idle acceptance panes remained in the background.

Two workloads ran in the same native session, with CPU profiling enabled:

| Run         | Panes |      Bytes | Events | Elapsed ms | Frame samples | p95 frame interval ms | Maximum frame interval ms | Long tasks |
| ----------- | ----: | ---------: | -----: | ---------: | ------------: | --------------------: | ------------------------: | ---------: |
| Cold, run 1 |     8 | 21,888,200 |    808 |    2,539.4 |           146 |                  16.8 |                      50.0 |          0 |
| Warm, run 2 |     8 | 21,888,200 |    808 |    2,253.6 |           137 |                  16.8 |                      16.9 |          0 |

Both runs had eight launches, zero disposals, zero kills and no unexpected
bridge calls. Every pane retained its exact `END_i_日本語_RUN_<runId>` marker;
the changing run ID prevents warm-run acceptance from accidentally matching an
old cold-run tail. Maximum long-task duration was zero in both runs. The host
exited cleanly after recording evidence.

CPU self-samples were predominantly idle (1,141/1,264 ms cold/warm) or program
work without a JavaScript attribution (480/301 ms). The largest named
JavaScript costs were xterm buffer copying/cloning and parsing. CPU sampling
does not isolate GPU time. The earlier heavily loaded Chromium measurements
do not establish a sustained native stall: this native run provides no basis
for adding a speculative xterm output queue. No production performance change
was made in response to these profiles. This is one controlled host/workload
measurement, not a before/after speedup or universal frame-rate guarantee.

Evidence directory:
`test-results/acceptance/webview2-perf/20260912-045501-556-8panes/`.
It contains source/SDK hashes in `manifest.json`, runtime and viewport metadata,
`cold.json`, `warm.json`, both `.cpuprofile` files, raw profiler responses and
hot-function summaries. Reproduction commands are in
[`installer-ssh-acceptance.md`](./installer-ssh-acceptance.md#profile-workspace-output-in-native-webview2).

## Real provider boundary

A separate opt-in runner now exercises an existing authenticated remote Claude
CLI through the production SSH argument builder and native PTY output path.
It requires a fresh exact provider reply, exit zero and drained output;
transport/auth-status checks alone cannot pass it. It is separate from the
disposable Node/OpenSSH fixture and from the API-agent sidecar provider matrix.

The prior opt-in attempt returned a provider 401 and no successful paid reply,
despite the CLI reporting an existing login. That failure is retained under
`test-results/acceptance/provider-ssh/2026-09-12T04-51-10-253Z/`; it is not an
acceptance pass. Four result-parser regressions passed, including rejection of
an error response whose subtype misleadingly says success and rejection of a
marker without model output-token evidence.

**The user explicitly deferred the real Claude test because the subscription
requires paid renewal. No successful provider reply is claimed.** Do not treat
this as a request to log in, renew or retry. Resume only if the user later
chooses to do so. The reproducible opt-in procedure is recorded in the
acceptance runbook; the wider paid-provider and packaged GUI matrices remain
outside this completed source/profiling proof.

## Release validation

- `pnpm gates:full`: all eleven gates passed in 439.4 seconds: format, lint,
  TypeScript, Vitest, frontend build, Remote Agents checks, Playwright, sidecar,
  Rust check/test and Tauri schema. The last missing-conversation correction
  preceded the full Vitest/browser runs; its focused 18 tests, targeted lint and
  a subsequent TypeScript check also passed. The release bundle rebuilds the
  frontend from the final committed source.
- Windows installer build and artifact/source hashes: pending.
- Installation and installed 0.14.7 observations: not part of this build request.

This preliminary report intentionally contains no 0.14.7 artifact or install
success claim. Append the final manifest and results after those checks run.
