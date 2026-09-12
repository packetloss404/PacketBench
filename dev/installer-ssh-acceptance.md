# Installer and live SSH acceptance

This runbook closes the consolidation's two proof gaps: packaging the current
source, and testing protocol-v12/project trust over an actual SSH transport.
It does not substitute echo tests for paid-provider, GUI, microphone, Flight,
or independently hosted server acceptance.

Completed run: [`2026-09-08 evidence`](./installer-ssh-evidence-2026-09-08.md).

## Design and research

- Tauri produces NSIS and MSI Windows installers. Use its normal build hooks
  so the pinned Node runtime, pruned production dependencies and sidecar dist
  are the same inputs used for distribution.
  [Tauri Windows installer documentation](https://v2.tauri.app/distribute/windows-installer/).
- NSIS documents uppercase `/S` and requires `/D` to be the final, unquoted
  argument. Tauri's generated `utils.nsh` kills a running application in silent
  mode. The validation script refuses an unattended upgrade while the app is
  running; close it normally after saving active work.
  [NSIS command-line documentation](https://nsis.sourceforge.io/Which_command_line_parameters_can_be_used_to_configure_installers).
- SSH acceptance uses `StrictHostKeyChecking=yes`, the production
  `SshConfig` known-hosts path, and key-only batch authentication. Obtain the
  fixture's public host key through Docker's control plane, then prove that a
  different pin is rejected. Never disable verification to make a test pass.
  [OpenSSH configuration manual](https://man.openbsd.org/ssh_config).

The SSH test lives behind Rust's `#[ignore]` and `#[cfg(test)]`; no validation
CLI or privileged test endpoint is added to the installed application. It
shares the production request encoder, launch script, bounded line reader and
ready-handshake gate. A fake API-key sentinel is sent only after that gate.

## Run the live SSH matrix

Prerequisites: Windows OpenSSH, Docker with Linux containers, Node/pnpm and the
Rust toolchain. Run from the repository root:

```powershell
pnpm sidecar:install
pnpm sidecar:build
pnpm acceptance:ssh
```

The full runner now includes six Workspace PTY cases after the nine sidecar
cases. To run only the Workspace matrix, use
`node scripts/validate-live-ssh.mjs --workspace-only`. It uses the production
SSH argument builder and native PTY/UTF-8/batching code with a disposable
interactive Node fixture. It proves transport behavior, not provider CLI auth.
Keep source files unchanged throughout a final evidence run.

Browser Workspace acceptance is `pnpm acceptance:workspace`. Playwright's
output directory is deliberately `test-results/playwright`: it clears that
directory at startup. Never change it to the shared `test-results` parent,
which also contains installer/SSH reports and disposable fixture repositories.

The runner builds an ephemeral Linux Node/OpenSSH image from the frozen
sidecar lockfile and current dist, binds SSH only to a random loopback port,
creates a throwaway client key and isolated local HOME, and runs the native
test binary. No user's SSH configuration, credentials, keyring, project trust
or existing servers are modified. It removes its container, image tag and
temporary keys in `finally`; report files remain under
`test-results/acceptance/live-ssh/<timestamp>/`.

| Case                     | Required evidence                                                                           |
| ------------------------ | ------------------------------------------------------------------------------------------- |
| Untrusted root           | No project source or marker execution; global server survives a project's disable entry     |
| Trusted root             | Project source appears; marker executes during capability probing; explicit disable applies |
| Nested project           | Parent trust does not grant child trust                                                     |
| Corrupt trust file       | Fail closed; preserve global config and actionable read error                               |
| Malformed project config | Preserve global config and report project read error                                        |
| Protocol v11             | Reject before sending any request bytes, including the fake key                             |
| Invalid ready            | Reject malformed JSON before sending any request bytes                                      |
| Wrong host key           | OpenSSH's changed-key diagnostic; no sidecar request                                        |
| Reconnect                | Restore correct pin and complete a fresh connection after rejection                         |

Every successful connection must echo two exact turns and produce two terminal
events. Source summaries must omit commands, arguments, headers and environment
values. Reports include version, protocol, source fingerprint, image ID, public
host fingerprint, each case's result and timestamp. This is a live Linux SSH
server inside Docker; it does not establish WAN or Windows-sshd compatibility.

## Profile Workspace output in native WebView2

Use the dedicated host to distinguish cold rendering from a second workload in
the same native session. It runs the existing browser fixture with real
Workspace/xterm and a mocked Tauri transport; it does not attach to an installed
application, read its profile or start real PTYs. This is native WebView2
performance evidence, separate from packaged application acceptance.

Prerequisites: Windows x64, the installed WebView2 runtime, .NET Framework 4.x
C# compiler, frontend dependencies and network access to official NuGet on the
first run. A .NET SDK is not required. Start Vite in one terminal, then run the
native host from another:

```powershell
pnpm exec vite --host 127.0.0.1 --port 1420 --strictPort
```

```powershell
powershell -NoProfile -File scripts/acceptance/validate-workspace-webview2.ps1 -Panes 8 -Port 1420 -Profile
```

Keep source stable and let compiler/build activity finish before timing. The
native window needs to remain visible during both runs. The runner compiles
`WorkspaceWebView2Host.cs` against official NuGet WebView2 SDK 1.0.4191.47 after
checking its pinned SHA-256. It uses a fresh profile under
`test-results/acceptance/webview2-perf/<timestamp>-<panes>panes/` and accepts only
the loopback fixture URL. `-Panes` supports 1 through 12; omit `-Profile` for
metrics without CPU sampling. An optional `-OutputDirectory` must be new, so
the test cannot reuse an existing browser profile.

`cold.json` and `warm.json` record frame intervals, long tasks, output counts,
terminal tails and lifecycle counters. Both runs must retain the exact current
`END_i_日本語_RUN_<runId>` marker for every pane, one launch per pane, zero
disposals/kills and no unexpected bridge calls. The changing marker prevents
old output from making the second run pass. The manifest records SDK/source
hashes; `runtime.txt` and `viewport.json` identify the actual runtime and visible
viewport. `-Profile` also writes CPU profiles and self-sample hot-function
summaries. These samples do not isolate GPU time. The host closes after the
two runs while retaining its isolated evidence/profile directory.

For a separate Chromium comparison using the same fixture:

```powershell
node scripts/acceptance/profile-workspace.mjs cold
node scripts/acceptance/profile-workspace.mjs warm --warm
```

Use new evidence labels for subsequent comparisons. Chromium and native host
results have different engines/viewports and must retain those scope labels;
neither is a universal FPS guarantee. The first native measurements are in
[`workspace-release-0.14.7.md`](./workspace-release-0.14.7.md).

## Opt-in real provider reply over SSH

**Deferred at the user's request on September 12, 2026:** the real Claude test
needs a paid subscription renewal. No successful provider reply is recorded.
The command below is a future reproduction procedure, not an instruction to
log in, renew or retry during the current task. Run it only if the user later
resumes this acceptance check.

This uses an existing SSH alias and an existing authenticated remote Claude CLI
login. It is distinct from the disposable Node fixture and from the Claude
Agent SDK/OpenAI Agents SDK sidecar matrix. Prerequisites are native Node with
TypeScript stripping, Windows OpenSSH, the Rust toolchain, a configured private
key and an existing pinned ed25519 host entry in `~/.ssh/known_hosts`. The remote
host needs Claude and Python 3. No credentials are exported from the host.

```powershell
node scripts/acceptance/provider-ssh.mjs <existing-SSH-alias>
```

The runner reads the selected alias, requires batch/key authentication and
strict host-key checking, and verifies CLI version and selected nonsecret auth
status fields. It compiles the opt-in native test, then requests one exact
arithmetic marker using the production SSH argument builder and PTY
decoder/dispatcher. The request uses print mode, safe mode, no tools, no session
persistence, a Sonnet low-effort turn and a USD 0.05 budget cap. It does not test
interactive TUI behavior, remote project/tool execution or other providers.

Evidence is retained in
`test-results/acceptance/provider-ssh/<timestamp>/report.json` with the native
output, source identity, test binary hash, public host fingerprint and bounded
provider outcome. Passing requires an exact new provider marker, no provider
error, native exit zero, drained output and stable source. An authenticated
status probe or successful SSH transport alone cannot pass. Provider refusal
or expired authorization remains a failed/deferred check, with no successful
reply claim. Parser/error regressions can run without contacting a provider:

```powershell
pnpm exec vitest run scripts/acceptance/provider-ssh-result.test.mjs --maxWorkers=1
```

## Build and verify the Windows upgrade

```powershell
pnpm acceptance:build
# Build prints the absolute manifest path. Use that exact path below.
powershell -NoProfile -File scripts/validate-installer.ps1 -Manifest '<manifest.json>' -Install
```

The build wrapper records HEAD, whether the worktree is dirty, and a SHA-256
over every tracked/untracked, nonignored source file. It rejects source drift
during bundling. This permits a clearly attributed local verification build
without pretending uncommitted changes belong to HEAD; release distribution
should still use a clean committed tree. Do not edit source while it builds.

The manifest contains hashes for both installers and the executable, bundled
Node, sidecar dist and every pruned dependency file. The installer runner
checks artifact hashes before any install, refuses to kill a running app,
performs the per-user NSIS upgrade, checks its exit code, then compares the
installed payload to the manifest. It launches the **installed** Node and
sidecar with an isolated HOME and verifies protocol v12 plus two exact turns.
Omit `-Install` to verify an already-installed payload without changing it.

Tauri patches the main executable's bundle marker separately for NSIS and MSI,
then restores the build output. The manifest uses each format's expected
unsigned executable hash; comparing an installed executable directly to the
restored build output would report a false mismatch. Signed builds require
capturing the actual post-signing payload instead, so this unsigned harness
fails closed for them. See the
[Tauri bundler implementation](https://github.com/tauri-apps/tauri/blob/dev/crates/tauri-bundler/src/bundle.rs).
Run the harness regressions with `pnpm exec vitest run scripts/acceptance`.

The build always restores sidecar development dependencies afterward. Reports
are alongside the manifest: `installation.json` and `packaged-sidecar.json`.
Record the installer hashes and source fingerprint in a dated evidence note.
An unsigned local build is not a signed public release. Building an MSI does
not claim that MSI installation was tested; the automatic upgrade uses NSIS.

After installing, launch the application normally and check startup separately.
Normal launch uses the user's profile and may resume sessions; the isolated
packaged echo check intentionally does not exercise GUI state or keyring auth.
Keep earlier `dev/acceptance.md` ticks attributed to their original versions.
