# PacketBench handoff — written 2026-09-05 for a cold start

> Historical audit handoff. Use [`../HANDOFF.md`](../HANDOFF.md) for the
> current restart state. The September 7 consolidation requires protocol v12,
> host-owned remote project trust before MCP probing, and an SSH handshake
> before sending session requests. Auxiliary queues are now per provider and
> background/interactive lane. Older statements below describe the audit build.

Read this if you have no memory of the 2026-09-04 audit session. It is written
for a weaker model or a future maintainer with the repo open and nothing else.
Everything cites a file; verify the file before acting on the sentence.

Companion documents: `docs/audit-2026-09-04.md` (the full audit: findings,
patches, unresolved items), `docs/runbooks.md` (operate it),
`docs/dependency-snapshot-2026-09-04.md` (CVEs and pins), `HANDOFF.md` at the
repo root (the older product-history restart doc; still accurate for history,
superseded by this file for security invariants), `CLAUDE.md`/`AGENTS.md`
(coding conventions; both are git-ignored, edit both).

## 1. What this is, in one screen

PacketBench is a Windows-first Tauri v2 desktop app (React 19 webview + Rust
backend) that wraps coding CLIs in PTYs and runs LLM "API agents" with file,
shell, web, git, and MCP tools. Single user, no server, no accounts.

```
webview (src/)  --Tauri IPC, 254 commands (src-tauri/src/lib.rs:196-360)-->  Rust (src-tauri/src/)
   |                                                                          |-- PTY children: claude, codex, opencode, packetcode, shells, ssh
   |                                                                          |-- in-process agent loop: commands/api_agent.rs + core/tool_runtime*.rs
   |                                                                          |-- Node sidecar (agent-sidecar/): Claude Agent SDK, OpenAI Agents SDK, stdio JSON v11
   |                                                                          |-- MCP stdio servers (core/mcp_client.rs) from ~/.claude/settings.json
   |                                                                          |-- outbound HTTPS: Anthropic, OpenAI-compatible, GitHub/Gitea/GitLab, PacketAgent, Ollama, huggingface
   |                                                                          `-- inbound: MCP server on 127.0.0.1 only (src-tauri/src/mcp_server/), bearer + Origin guarded
   `-- localStorage `packetbench:*` mirrored to ~/.packetbench/webview-storage-mirror.json
```

State: `~/.packetbench/state.v1.json` (+`.bak`), `provider-settings.v1.json`,
`conversations/`, `usage.jsonl`, `dictation.db`, `ssh/known_hosts`,
`trusted-projects.json`. Secrets: Windows Credential Manager, service
`packetbench`. Logs: `%LOCALAPPDATA%\PacketBench\logs\packetbench.log.<date>`.

## 2. Invariants that must not be broken

Each one has a test or a log line that proves it. If a change makes the test
fail, the change is wrong, not the test.

| # | Invariant | Where it is enforced | Proof |
| --- | --- | --- | --- |
| I1 | A conversation that never chose a permission mode asks before `bash`, `write_file`, `edit_file`, `create_pull_request`. `auto` is opt-in. | `api_agent.rs` `PermissionMode::default()` and the `None` arm in `start_api_agent_session`; `agentTaskStore.ts` `?? "ask_for_risky"` (3 sites); `agentModeChipUtils.ts::deriveMode`; `AgentChatPane.tsx` | `cargo test permission_mode_defaults_to_asking`; Vitest `agentModeChipUtils.test.ts` "unset flags as manual mode" |
| I2 | `create_pull_request` is in `RISKY_TOOLS`. | `api_agent.rs` `RISKY_TOOLS` | `cargo test create_pull_request_is_a_risky_tool` |
| I3 | Sub-agents (`spawn_subagent`, `agent_*`) can only call tools in the list they were handed and never bash/write/edit/PR. | `core/tool_subagent.rs::subagent_tool_permitted`, `SUBAGENT_DENIED_TOOLS`; `core/tool_custom_agent.rs::filter_subagent_tools` | `cargo test subagent_allowlist_is_enforced_not_advisory denied_tools_stay_denied custom_agents_cannot_be_granted_execution_tools` |
| I4 | Repo-supplied hooks, `.mcp.json` servers, and `.claude/agents` run only for projects listed in `~/.packetbench/trusted-projects.json`. Missing/malformed file = nothing trusted. | `core/project_trust.rs`; callers `core/hooks.rs::load_hooks_with_project`, `commands/api_agent.rs::build_mcp_config_for_sidecar`, `commands/custom_agents.rs::discover_custom_agents` | `cargo test project_trust merge_mcp_entries_for_sidecar_drops_untrusted_project_servers`; log target `packetbench::trust` |
| I5 | Every file tool stays inside the workspace, including `grep` (no symlink following). | `core/tool_runtime.rs::resolve_workspace_path`, `walk_dir` symlink skip; `core/tool_runtime_ssh.rs::confine_prelude` (remote, fail-closed if no realpath) | `cargo test grep_does_not_follow_symlinks write_file_rejects_symlink edit_file_rejects_symlink` |
| I6 | `web_fetch` cannot reach loopback/private/link-local/metadata addresses, on any redirect hop, including DNS rebinding. | `core/tool_web.rs` `SsrfGuardResolver`, `host_is_blocked_ip_literal`, redirect policy | `cargo test tool_web` |
| I7 | A secret never travels over public plaintext HTTP. Git-host PATs, MiniMax key, custom-endpoint key: https unless the host is local. PacketAgent: https unless loopback. | `core/shared.rs::require_https_unless_local` (called from `commands/github.rs`, `commands/git_host_probe.rs`, `core/storage.rs` normalizers); `commands/packet_agent.rs::normalized_endpoint` | `cargo test tls_guard endpoint_requires_https_except_loopback` |
| I8 | Secrets live only in the OS keyring; never in `state.v1.json`, localStorage, logs, or plaintext files. | `commands/api_keys.rs`, `ssh_keys.rs`, `github.rs` (`host_token_account`), `packet_agent.rs`; `core/tool_github.rs` has no file fallback | `grep -rn "token\|password" src/stores/*.ts` persists only booleans; audit §3 "Secrets" rows |
| I9 | The MCP server binds 127.0.0.1 only; `/mcp` needs the per-run bearer; any present non-loopback Origin is 403 on every route; the per-tool allowlist also gates resources; `/health` is the only tokenless route. | `mcp_server/transport.rs` (`origin_layer`, `bearer_layer`), `mcp_server/mod.rs::resource_permitted` | `cargo test auth_gates_the_transport the_allowlist_is_enforced_over_the_wire resources_honour_the_tool_allowlist`; `node smoke-test.mjs` |
| I10 | `ssh_exec` refuses `ProxyCommand`, `LocalCommand`, `PermitLocalCommand`, `KnownHostsCommand`, `ProxyUseFdpass`, `Include`, `-F`, `-E`. Remote commands are built with `sh_quote` per argument and random heredoc terminators. | `commands/pty.rs::validate_ssh_exec_args`; `core/execution.rs::sh_quote`; `core/shared.rs::pick_heredoc_terminator` | `cargo test ssh_exec_refuses_local_execution_options` |
| I11 | Non-main windows (`monitor-*`) can invoke exactly five read commands. | `commands/monitor_windows.rs::MONITOR_ALLOWED_APP_COMMANDS`; `lib.rs::guarded_invoke_handler` | `cargo test monitor_window_app_command_allowlist_is_read_only` |
| I12 | SSH host keys are pinned when `ServerConfig.hostFingerprint` exists (`StrictHostKeyChecking=yes` against `~/.packetbench/ssh/known_hosts`); TOFU only when it does not, and that is logged. | `core/execution.rs::SshConfig::ssh_args`; `src/lib/ssh.ts::baseSshArgs` | `cargo test ssh_args_uses_pinned_known_hosts_when_fingerprint_set` |
| I13 | Sidecar protocol floor is v11; a lower sidecar is refused. Restart storm cap 3/60 s. | `commands/agent_sidecar/mod.rs:109-119,186-187` | `cargo test protocol_meets_floor` |
| I14 | `PtyExitOutcome` is four-way (`clean`/`failed`/`killed`/`unknown`); `unknown` is never reported as success. | `src/lib/tauri.ts` `PtyExitOutcome` | CLAUDE.md "PTY exit outcomes" |
| I15 | `packetbench:*` is the only localStorage namespace that survives a bundle-identifier change (mirrored by `src/lib/storageMirror.ts`). | `src/lib/brand.ts::storageKey` | CLAUDE.md "Stores" |

## 3. Gotchas (things that cost time)

- **Run `cargo` from `src-tauri/`, never from the repo root.** The local,
  git-excluded `src-tauri/.cargo/config.toml` redirects the target dir to
  `C:/Users/ianwalmsley/packetbench-build`. From the root, cargo uses the stale
  `src-tauri/target` tree whose Tauri build-script output still points at
  `D:\projects\PacketADE\...` and fails before compiling. `pnpm rust:check`
  and `pnpm rust:test` already `cd src-tauri`.
- **Rust is not on PATH in non-interactive shells:**
  `export PATH="/c/Users/ianwalmsley/.rustup/toolchains/stable-x86_64-pc-windows-msvc/bin:$PATH"`.
- **Vitest and cargo compete for CPU** and Vitest asserts on elapsed time. Run
  `cargo test` and `pnpm test` sequentially, or use `pnpm gates:fast` /
  `pnpm gates:full`, which model the contention (`scripts/quality-gates.mjs`).
  A single flaky failure that does not reproduce on an idle machine is noise
  (seen once in this audit).
- **`CLAUDE.md` and `AGENTS.md` are git-ignored** and must stay byte-identical
  except for the H1. Repo-wide sweeps skip them.
- **`pnpm tauri build` destroys sidecar devDeps** (`scripts/prune-sidecar.js`);
  run `pnpm sidecar:install` afterwards.
- **Never launch a pnpm install from `agent-sidecar/` without
  `--ignore-workspace`.** It is not a member of `pnpm-workspace.yaml` (which
  lists only `remoteagents/*`), so pnpm walks up, finds the workspace root and
  installs **that** — it prints `Scope: all 3 workspace projects`. With
  `--prod` that deletes the repo's own devDependencies (`vite`, `typescript`,
  `vitest`, `@tauri-apps/cli`, `eslint`) and never creates
  `agent-sidecar/node_modules`. This broke `pnpm tauri build` outright between
  2026-09-01 (`d6238633`, which added the workspace file and fixed
  `sidecar:install` but not `prune-sidecar.js`) and 2026-09-05 (`f3421a4b`,
  audit F20/P12). Recovery is a plain `pnpm install`. Both call sites pass the
  flag now; keep it that way.
- **The trust list is a file, not a setting.** Until
  `~/.packetbench/trusted-projects.json` lists a repo, that repo's hooks,
  `.mcp.json`, and `.claude/agents` are ignored and the log says so
  (`packetbench::trust`). Users who relied on project hooks will report "my hook
  stopped firing"; the answer is the file, format
  `{"version":1,"projects":["D:\\projects\\PacketBench"]}`. Trust is per
  canonical path, never inherited by a nested clone.
- **The mode chip says "Manual" on new conversations now.** That is I1, not a
  bug. "Default" (auto) is still selectable.
- **Global MCP servers are read from `~/.claude/settings.json`**, not
  `~/.claude.json`, so Claude Code does not see servers added in the MCP Hub
  and vice versa (audit F13). Do not "fix" this without a migration.
- **"Show in Explorer" is broken by design of the shell plugin scope**
  (audit F14/H07). Do not widen `plugins.shell.open` in `tauri.conf.json` to
  filesystem paths; that would let the webview execute any file.
- **Windows password-auth SSH is unverified** (audit F12/U01). Key or agent
  auth is the tested path.
- **`GITHUB_OAUTH_CLIENT_ID` is empty** in `core/brand.rs`; the device-flow
  code is complete but disabled. PAT paste is the supported path.
- **Changing any `#[tauri::command]` signature** requires
  `pnpm generate:tauri-schema` (regenerates `src/generated/tauri-schema.ts`)
  and `pnpm check:tauri-schema` passes only when the two agree.
- **Cost guardrails gate launches, not turns.** `assertCostGuardrailsAllowLaunch`
  runs at conversation launch (`agentTaskStore.ts:712`) and Flight launch
  (`asyncFlightStore.ts:1366`); mid-conversation turns and the auxiliary LLM
  features (side chat, GitHub AI, memory summaries) are not re-checked.
- **A rejected Settings pin is reported verbatim on purpose** — `detect_one`
  (`commands/agent.rs:190`) does NOT fall through to whatever PATH would have
  given, so a stale setting cannot hide behind a working fallback. Do not
  "fix" that; the card just says `pinned path not usable` now instead of the
  old, misleading "not installed" (audit F27).
- **Check the aux provider before blaming aux code.** On 2026-09-06 every
  MiniMax request returned 429 — 9 of 9 that day, including isolated ones, and
  no success anywhere in the egress logs since they began on 2026-09-05. Every
  aux feature (session summaries, memory briefs) was failing silently. Grep the
  log for `egress: LLM response` and check the statuses before investigating
  anything else.
- **Aux turns are capped at 2 concurrent** (`MAX_CONCURRENT_AUX_TURNS`,
  `core/aux_llm.rs`). Raising it re-opens F26: 8 `session-summarize` turns fired
  by one workspace close 429'd a provider and lost every summary. A 429 now
  backs off and retries twice (2 s, 6 s, jittered) and logs at WARN if it still
  gives up, so a lost summary is visible rather than silent. The permit is held
  through the backoff on purpose — that is backpressure, not waste. Raising the
  cap without thinking about the retry budget re-opens the stampede.
- **A vitest flake has now appeared twice**, both times only under
  `pnpm gates:fast` contention (`import` time 1500-2200s vs ~110s standalone),
  never in a standalone run, 1 failure out of 2754. It has not been captured by
  name either time — if you see it, capture the run to a file
  (`pnpm gates:fast > log 2>&1`) rather than letting it scroll.
- **A Flight cannot be created without launching an agent.** The Flight Deck
  button and `+ New → New Flight` both open `LaunchAsyncFlightModal`, whose only
  actions are "Plan first" and "Launch agents" — both spend a real LLM turn. That
  makes any test needing an active Flight (e.g. `smoke-test.mjs`'s
  `append_handoff` case) cost money or need a hand-written `state.v1.json`
  record. `get_active_flight` reads `ui.selected_flight_id` from that file
  (`mcp_server/reads.rs:64-74`), not the webview store. A create-only path would
  be cheap to add and would make the suite fully runnable.
- **Copy the user sees says the product name via `APP_NAME`, not literally.**
  `scripts/app-name-brand.test.mjs` is the fence; it reads code, not comments,
  so JSDoc naming the product is fine. Three sites are allowlisted with reasons
  — the definition, and the two halves of the `Run-By:` trailer template, which
  must stay byte-identical to `src-tauri/src/core/orchestrator.rs:10` and to the
  glob in the generated git hook (`worktree.rs:508,580`). Rename that on both
  sides deliberately or not at all (audit F25/P17).
- **Never hardcode `"packetbench:"` — build keys with `storageKey()`.**
  `storageMirror.ts:158,204` mirrors by `key.startsWith(STORAGE_PREFIX)` and
  `storage-migration.ts:74-84` carries exactly ONE previous prefix forward. A
  hardcoded key therefore survives a rename that `STORAGE_PREFIX` does not: it
  keeps working, quietly stops being mirrored, and the next bundle-identifier
  change takes it with no migration path. Half the stores were in that state
  through two renames (audit F24/P16). `scripts/storage-key-brand.test.mjs` is
  the fence; when the product is renamed again, update the prefix in that file
  in the same change as `brand.ts`.
- **Remote Agents is gated by `src/lib/remoteAgentsGate.ts`, not by the store.**
  `remoteAgentsSettingsStore` holds user intent only and importing it anywhere
  else is an eslint error. Ask `isRemoteAgentsEnabled()` (or the
  `useRemoteAgentsEnabled()` hook), and call `assertRemoteAgentsEnabled(callSite)`
  at any function that opens a socket, contacts the relay, registers a device, or
  exposes desktop capability to a remote peer — it throws, so forgetting to
  branch is not enough to get through. All eleven private-beta gates
  (`dev/remoteagents/04-security.md:385-397`) are `met: false`; flip one only in
  the same change that implements it (audit F23/P15).
- **`HANDOFF.md` at the root is case-insensitive-equal to `handoff.md`**; this
  file lives under `docs/` to avoid the collision.

## 4. The next five tasks, in priority order

Each is sized so it can be executed cold. Verify the cited lines first; they
were accurate at commit `835e1d45`.

### Task 1 — Trust-list UI and first-conversation prompt (closes the usability gap of P01)

Why: I4 is enforced by a hand-edited JSON file. Users will not find it.

Do:
1. Add two commands in a new `src-tauri/src/commands/project_trust.rs`:
   `list_trusted_projects() -> Vec<String>` and
   `set_project_trusted(project_path: String, trusted: bool) -> Result<(), String>`
   that read/write `core::project_trust::trusted_projects_path()` with the
   same atomic write used by `core/storage.rs::write_with_backup` (copy the
   helper or make it `pub(crate)`). Canonicalize before storing; refuse
   relative paths.
2. Register both in `src-tauri/src/lib.rs` inside `guarded_invoke_handler![...]`
   (they must NOT be added to `MONITOR_ALLOWED_APP_COMMANDS`).
3. Add wrappers in `src/lib/tauri.ts`, run `pnpm generate:tauri-schema`.
4. UI: in `src/components/views/tools/ProjectRulesCard.tsx` (Settings →
   Project rules, section id `project-rules`) add a "Trusted project" toggle
   for the current `useLayoutStore().projectPath`, with copy stating exactly
   what trust enables (hooks, `.mcp.json`, `.claude/agents`).
5. On the first API conversation in an untrusted project that HAS any of the
   three files, show a one-time banner in `AgentChatPane.tsx` linking to that
   toggle. Detect via a read-only command `project_trust_signals(project_path)`
   returning which of the three files exist.
6. Tests: Rust unit tests for the write path (round trip, relative path refused);
   Vitest for the toggle.
7. Gate: `pnpm gates:full`.

### Task 2 — Apply the three Rust advisory bumps on a release branch

Why: `h2@0.4.13` (RUSTSEC-2026-0258, client DoS from a malicious server) and
`rustls-webpki@0.103.9` (name-constraint bugs) are in every outbound HTTPS
call. Details in `docs/dependency-snapshot-2026-09-04.md`.

Do:
```bash
git checkout -b chore/rust-advisories-2026-09
cd src-tauri && cargo update -p h2 -p rustls-webpki -p quinn-proto && cargo test --lib
cd .. && pnpm gates:full
```
Do not run an unscoped `cargo update`. Commit `src-tauri/Cargo.lock` only.
Re-run `cargo audit --file src-tauri/Cargo.lock`; expect the three IDs gone.

### Task 3 — Make Windows password-auth SSH real (audit F12/U01)

Why: `commands/pty.rs::ssh_exec` and `core/tool_runtime_ssh.rs::ssh_run_inner`
write the password to stdin on Windows; OpenSSH reads it from the console.

Do:
1. Reproduce with a password-only server (Settings → Servers → Add, Authentication: password). Expect a hang/timeout in the "Connecting via SSH…" step.
2. Reuse `core/ssh_askpass.rs` on Windows: the `arm()` function is `#[cfg(unix)]`
   only because of `mode(0o600)`; add a Windows branch that writes the secret
   file under `std::env::temp_dir()` with a random name and no mode bits, sets
   `SSH_ASKPASS` to `std::env::current_exe()`, `SSH_ASKPASS_REQUIRE=force`, and
   `PACKETBENCH_ASKPASS_FILE`. `main.rs` already dispatches to
   `ssh_askpass::helper_main` before starting the app.
3. Remove the `#[cfg(windows)]` stdin write blocks in both files.
4. Verify against the same server; `packetbench::egress` logs `ssh_exec target=user@host`.

### Task 4 — `reveal_in_file_manager` command (audit F14/H07)

Why: "Show in Explorer" in `src/components/common/PathContextMenu.tsx:31-35`
calls `shell.open()` with a directory, which the plugin scope refuses.
Confirmed live in the installed 0.13.2 build on 2026-09-05: the conversation
menu's "Open project folder in OS" opened nothing (zero Explorer windows
before and after), while "Open in VS Code" in the same menu launched VS Code.
So the feature is dead, not flaky, and the fix is a real command — not a
wider scope.

Do:
1. New command in `src-tauri/src/commands/fs.rs`:
   `reveal_in_file_manager(path: String)`; canonicalize; require `is_dir()`;
   spawn `explorer.exe <path>` on Windows, `open <path>` on macOS,
   `xdg-open <path>` on Linux, using `Command::arg` (never a shell).
2. Register in `lib.rs`; wrapper in `src/lib/tauri.ts`; `pnpm generate:tauri-schema`.
3. Replace the `open(parentDir(...))` call in `PathContextMenu.tsx` with the wrapper.
4. Leave `plugins.shell.open` in `tauri.conf.json` as set by P10.

### Task 5 — Sidecar restart command and turn-level cost guardrail

Why: after three crashes in 60 s the sidecar is dead until app restart
(`supervisor.rs:706-731`); and cost guardrails only run at launch.

Do:
1. Add `restart_sidecar` to `commands/agent_sidecar/mod.rs` that resets the
   restart window and calls `spawn_child`; register in `lib.rs`; surface a
   "Restart sidecar" button on the status chip (`SidecarStatusChip.tsx`).
2. In `agentTaskStore.ts`, call `assertCostGuardrailsAllowLaunch(provider, flightId)`
   inside the send-message path (the function already exists in
   `costGuardrailStore.ts:164`), not only at launch; surface the same
   `requiresApproval` prompt.
3. Tests: Vitest for the send path; manual for the chip.

## 5. How to verify the whole thing in ten minutes

```bash
export PATH="/c/Users/ianwalmsley/.rustup/toolchains/stable-x86_64-pc-windows-msvc/bin:$PATH"
node smoke-test.mjs            # 5/5 in fallback mode; live mode with PACKETBENCH_MCP_URL/TOKEN
pnpm gates:fast                # format, lint, typecheck, vitest
cd src-tauri && cargo test --lib   # 983 passed, 2 ignored at 835e1d45
```

Before a release, also build once — it is the only thing that exercises
`prune-sidecar.js`, and it is the step that silently rotted for four days:

```bash
pnpm tauri build && pnpm sidecar:install
```

Then open the app, start a new API conversation in an untrusted repo, and
confirm the log shows `project is not trusted` and the mode chip shows
"Manual". That exercises I1 and I4, the two invariants most likely to be
"fixed" away by a well-meaning change.
