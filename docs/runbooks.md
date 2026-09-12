# PacketBench ops runbooks

Written from the scripts, config, and Rust source in this repository at
`main` after the 2026-09-04 audit commits. Nothing here is invented: every
command names a script in `package.json`, a file the app reads, or a path the
code writes. Where a value depends on your machine it is marked **(yours)**.

PacketBench is a desktop app. "Deploy" means build installers; "restart"
means the app process; there are no servers, containers, or unit files in
this repository (the Remote Agents relay is a separate repo and is not
covered here).

Log file: `%LOCALAPPDATA%\PacketBench\logs\packetbench.log.<YYYY-MM-DD>`
(`src-tauri/src/lib.rs::dirs_log_dir`, daily rolling).
Data dir: `%USERPROFILE%\.packetbench\` (`core/brand.rs::DATA_DIR_NAME`).
Secrets: Windows Credential Manager, service `packetbench`
(`core/brand.rs::KEYRING_SERVICE`); each entry's target name is
`<account>.packetbench` (keyring 3.6.3 `windows.rs`: `format!("{user}.{service}")`).

---

## 1. Deploy (build installers)

Prerequisites: Node 24 with pnpm 9.15.4 (`package.json` `packageManager`), the
Rust stable MSVC toolchain, and network access for `scripts/fetch-node.js`.
Rust is not on PATH in non-interactive shells:

```bash
export PATH="/c/Users/ianwalmsley/.rustup/toolchains/stable-x86_64-pc-windows-msvc/bin:$PATH"
```

1. Bump the version in all three manifests (`package.json`,
   `src-tauri/tauri.conf.json`, `src-tauri/Cargo.toml`). `scripts/release-gate.mjs`
   fails if they differ.
2. Run the local gates (there is no CI by design, `dev/local-quality-gates.md`):

```bash
pnpm gates:full
```

3. Run the release gate:

```bash
pnpm run release:gate
```

4. Build. `beforeBuildCommand` in `tauri.conf.json` runs `pnpm run prebundle`
   (clean:dmg-scratch, fetch-node, sidecar:install, sidecar:build,
   sidecar:prune, release:gate) and then `pnpm run build`:

```bash
pnpm tauri build
```

5. Artifacts. Cargo output is redirected by the local, git-excluded
   `src-tauri/.cargo/config.toml` to **(yours)** `C:/Users/ianwalmsley/packetbench-build`,
   so installers land in:

- `C:/Users/ianwalmsley/packetbench-build/release/bundle/nsis/PacketBench_<version>_x64-setup.exe`
- `C:/Users/ianwalmsley/packetbench-build/release/bundle/msi/PacketBench_<version>_x64_en-US.msi`

On a machine without that config file they land in `src-tauri/target/release/bundle/`.

6. Verify the artifacts exist and record hashes (the release readiness script
   looks for exactly those globs, `scripts/release-readiness.mjs:46-49`):

```bash
pnpm run release:readiness --skip-gates
```

```powershell
Get-FileHash "C:\Users\ianwalmsley\packetbench-build\release\bundle\nsis\PacketBench_*_x64-setup.exe" -Algorithm SHA256
```

Record the hash in `CHANGELOG.md` the way the 0.13.2 entry does.

7. `prebundle` runs `scripts/prune-sidecar.js`, a destructive prod-only
   reinstall of `agent-sidecar/node_modules`. Restore dev dependencies
   afterwards or the sidecar smoke tests will fail:

```bash
pnpm sidecar:install
```

8. If a build ever leaves the repo unable to run `pnpm lint`/`pnpm build`,
   the prune step installed the wrong project. `agent-sidecar` is not a member
   of `pnpm-workspace.yaml` (`packages: ["remoteagents/*"]`), so a pnpm install
   launched from it without `--ignore-workspace` walks up, finds the workspace
   root, and installs **that** instead — with `--prod`, which deletes the
   repo's devDependencies. Both `sidecar:install` and
   `scripts/prune-sidecar.js` pass `--ignore-workspace` for this reason; see
   F20 in `docs/audit-2026-09-04.md`. Recovery:

```bash
pnpm install
```

9. Install: run the NSIS `-setup.exe`. Builds are unsigned (signing deferred on
   cost, `dev/beta-distribution-trust-runbook.md`), so SmartScreen shows
   "Windows protected your PC": click **More info → Run anyway**.

## 2. Roll back

**Roll back the installed app.** The data dir is not touched by uninstall.

1. Windows Settings → Apps → Installed apps → PacketBench → Uninstall.
2. Run the previous installer from the bundle directory above (older bundles
   are kept there; their SHA-256 hashes are in `CHANGELOG.md`).
3. Launch; the boot log should show `boot check done` (see §4) and the data dir
   migration lines are no-ops.

**Roll back a code change.** Every audit patch is an independent diff:

```bash
git apply -R docs/audit/patches/P07-mcp-resources-allowlist-and-health.diff
```

or revert the commit (`git log --oneline -14` lists the twelve audit commits):

```bash
git revert <sha>
```

Then rebuild (§1). Dependency order for reverts: revert P09 before P01.

**Roll back a bad `state.v1.json` write.** See §6.

## 3. Restart

**The app.** Close the window (File/exit) or, for a hung instance:

```powershell
taskkill /IM packetbench.exe /F
```

A forced kill skips the exit hook that reaps PTY children
(`lib.rs` `RunEvent::Exit`); the next launch reaps them via
`core::pty::reap_orphaned_pty_children` using `~/.packetbench/pty-active-pids`.
Interrupted Flight attempts are demoted to Failed on the next launch
(`core::orchestrator::recover_flights_on_startup`).

**The Node sidecar** (Claude Agent SDK and OpenAI Agents SDK rows). The
supervisor restarts it automatically up to `MAX_RESTARTS_IN_WINDOW = 3` times
per 60 s (`commands/agent_sidecar/mod.rs:186-187`). Past that the status chip
reads "Sidecar crashed and could not restart" and there is no restart command:
restart the app. Sidecar stderr is forwarded into the app log.

**The MCP server.** Settings → MCP → "MCP Provider" card → toggle
**Enable MCP Provider** off and on. Each start mints a new bearer token
(`mcp_server/mod.rs::generate_token`); update any external client config.

**A stuck API-agent turn.** The conversation's Cancel control calls
`cancel_api_agent_session`; pending permission prompts time out after 300 s
and are denied (`api_agent.rs`).

## 4. Tail the right logs

Today's app log, live:

```powershell
Get-Content -Wait -Tail 50 "$env:LOCALAPPDATA\PacketBench\logs\packetbench.log.$(Get-Date -Format yyyy-MM-dd)"
```

Only the security-relevant lines (targets added by the audit):

```powershell
Select-String -Path "$env:LOCALAPPDATA\PacketBench\logs\packetbench.log.*" -Pattern 'packetbench::(auth|egress|trust|boot)'
```

What each target means:

| Target | Lines you will see |
| --- | --- |
| `packetbench::boot` | `boot check start` … `boot check done issues=N`; any `data dir … is not writable`, `OS credential store failed a read`, `PACKETBENCH_… is set but is not a variable PacketBench reads` |
| `packetbench::auth` | `API key loaded from keyring provider=… outcome=found\|missing\|legacy\|store_error`; `MCP request rejected: bearer token missing or wrong`; `MCP request rejected: non-loopback Origin`; `sub-agent requested a tool outside its allowlist; refused` |
| `packetbench::trust` | `project is not trusted: repo-supplied hooks, .mcp.json servers, and .claude/agents are ignored`; `project hooks ignored …`; `project-scope MCP server ignored …` |
| `packetbench::egress` | `LLM request` / `LLM response` (service, model, status); `git host client built`; `PacketAgent response`; `web_fetch response`; `ssh_exec target=user@host` |

Verbosity is set by `RUST_LOG` at launch (`lib.rs::init_tracing`, default
`info`). To run once at debug level from PowerShell:

```powershell
$env:RUST_LOG = "packetbench=debug"; & "<install dir>\packetbench.exe"
```

Panics: `%USERPROFILE%\.packetbench\crashes\crash-<unix-seconds>.log`, also
listed in Settings → Advanced (Crash Viewer card, "View" / "Delete crash report").

Playwright and Vitest output: `test-results/` (git-ignored).

## 5. Rotate each secret, by name

All secrets live in Windows Credential Manager under service `packetbench`.
List them:

```powershell
cmdkey /list | findstr packetbench
```

| Secret (keyring account) | Credential Manager target | Rotate from the UI | Rust command behind it |
| --- | --- | --- | --- |
| `api-key-anthropic`, `api-key-openai`, `api-key-minimax`, `api-key-openrouter` | `api-key-<provider>.packetbench` | Settings → Providers → **API Keys** card: paste the new key in the row (placeholder `sk-...`) and save; the trash icon opens "Delete API key?" | `set_api_key` / `delete_api_key` (`commands/api_keys.rs:159,209`) |
| `github-token` | `github-token.packetbench` | Settings → GitHub → the connection row → **Edit** ("Edit renames a host or replaces an expiring token in place"); the new token is live-probed before the keyring is written | `git_host_update_connection` (`commands/github.rs:1303`) |
| `git-host-token-<connection id>` (Gitea/Forgejo/GitLab) | `git-host-token-<id>.packetbench` | Same Edit flow on that host's row; **Remove** opens "Remove git host?" and deletes the token | `git_host_update_connection`, `git_host_remove_connection` |
| `ssh-<serverId>` (SSH password) | `ssh-<serverId>.packetbench` | Settings → Servers → the host's **Edit** → Authentication: password → Save | `set_ssh_password` (`commands/ssh_keys.rs:187`) |
| `packet-agent-token` | `packet-agent-token.packetbench` | Settings → PacketAgent: **Remove stored token** ("Remove PacketAgent token?"), then paste the new token and save | `set_packet_agent_token` (`commands/packet_agent.rs:227`) |
| MCP server bearer token | not stored; in memory per run | Settings → MCP → MCP Provider: toggle **Enable MCP Provider** off/on; copy the new token with "Copy bearer token" | `mcp_server_stop` / `mcp_server_start` |
| Claude / Codex CLI logins (PTY sessions only) | `~/.claude/.credentials.json`, `~/.codex/auth.json` | Settings → Agents → Subscriptions card, or `claude login` / `codex login` in a terminal pane | `sign_out_provider` deletes the files (`provider_auth.rs:436`) |
| SSH host keys | `%USERPROFILE%\.packetbench\ssh\known_hosts` | Settings → Servers → host row → **Fetch host key** (re-pins; "Pinned" badge) | `ssh_fetch_fingerprint` + `ssh_pin_host` |
| Project trust list | `%USERPROFILE%\.packetbench\trusted-projects.json`; for SSH MCP, `~/.packetbench/trusted-projects.json` on the execution host | List exact absolute project roots in `{"version":1,"projects":["/home/alice/project"]}` on SSH hosts (use Windows paths locally). No nested-root inheritance. Missing/invalid lists deny project MCP commands before probing; global config stays usable. Changes apply on the next session start. SSH sidecars must support protocol v12; the desktop checks `ready` before sending keys or requests. | `core/project_trust.rs`, `agent-sidecar/src/project-trust.ts` |

After rotating a provider key, the next agent turn logs
`API key loaded from keyring provider=<p> outcome=found`.

## 6. Restore from backup

**What the app protects on its own** (`core/storage.rs::write_with_backup`):
`state.v1.json` and `provider-settings.v1.json` are written to a `.tmp`,
fsynced, the previous file copied to `.bak`, then renamed into place. On load,
a corrupt primary is renamed to `<file>.corrupt-<timestamp>` and the app
recovers from `.bak`, then `.tmp` (`storage.rs::load_state_from`). The log
line is `Recovered state from backup`.

**Manual restore of the last good state** (app closed):

```powershell
taskkill /IM packetbench.exe /F 2>$null
Copy-Item "$env:USERPROFILE\.packetbench\state.v1.json.bak" "$env:USERPROFILE\.packetbench\state.v1.json" -Force
```

**Full backup of a machine.** Copy the data dir; it holds flights, workspaces,
issues, servers (no passwords), conversations, usage ledger, dictation history,
whisper models, pinned SSH host keys, and the trust list:

```powershell
robocopy "$env:USERPROFILE\.packetbench" "D:\backups\packetbench-$(Get-Date -Format yyyyMMdd)" /E /XD pty-transcripts
```

Secrets are **not** in that folder; they are in Credential Manager and must be
re-entered on a new machine (§5). `webview-storage-mirror.json` inside the data
dir is the durable copy of the webview's `packetbench:*` localStorage and is
restored automatically on first launch after a reinstall
(`src/lib/storageMirror.ts`).

**Restore to a new machine:** install (§1 step 8), launch once, close, copy the
backup over `%USERPROFILE%\.packetbench`, relaunch, re-enter secrets.

## 7. Health check (dark period)

With the MCP Provider enabled (port shown on the card):

```bash
curl -s http://127.0.0.1:<port>/health
```

Expected: `{"ok":true,"app":"PacketBench","version":"0.13.2","service":"mcp"}`.
Without the token this is the only route that answers; everything under `/mcp`
returns 401. The repo-root `smoke-test.mjs` automates this plus the auth
failure paths (`node smoke-test.mjs`, with `PACKETBENCH_MCP_URL` and
`PACKETBENCH_MCP_TOKEN` set for live mode).
