# PacketBench QA Workbook

> Historical September 5, 2026 workbook for the commits listed below. It is not
> the current release checklist or status ledger. Start at
> [the documentation hub](dev/README.md), [current status](dev/current-status.md)
> and the [current quality gates](dev/local-quality-gates.md). Preserve old rows
> as evidence; do not promote their checks to the October 24 source/package.

| Field | Value |
|---|---|
| Repository | packetloss404/PacketBench |
| Commit reviewed by the audit | 2f4a10c384508af75a792604fff91b55a16dee26 |
| Commit this workbook was built from | c7f10621e0695f337310f846aa7df78ca07aa98f |
| Date built | 2026-09-05 |
| Run it locally (exact command) | pnpm install && pnpm tauri dev |
| Then run the gates | pnpm gates:fast   (format, lint, typecheck, vitest)   and   cd src-tauri && cargo test --lib |
| Smoke test | node smoke-test.mjs   (live mode: set PACKETBENCH_MCP_URL and PACKETBENCH_MCP_TOKEN from Settings > MCP > MCP Provider) |
| Exact URL in prod | none (desktop app; no hosted URL). Installed via the NSIS installer PacketBench_<version>_x64-setup.exe. The only HTTP endpoint is the loopback MCP server: http://127.0.0.1:<port>/health |
| Log file | %LOCALAPPDATA%\PacketBench\logs\packetbench.log.<YYYY-MM-DD> |
| Data dir | %USERPROFILE%\.packetbench |
| Audit report | docs/audit-2026-09-04.md (findings F01-F25, patches P01-P17, unresolved U01-U07) |

How to use: every checklist row has an empty checkbox cell (tick when done) and a P/F cell (write P or F). Failure signatures are the literal strings the app or the log prints. Where a browser cannot make the request, the literal curl is given with <TOKEN> as the placeholder for the bearer shown in Settings > MCP > MCP Provider.

Manual IPC calls: run `pnpm tauri dev`, press Ctrl+Shift+I in the app window, and in the devtools console call `await window.__TAURI_INTERNALS__.invoke('<command>', {<camelCase args>})`. Release builds do not expose devtools; that is expected.

# Surface inventory with negative cases

Reprinted from audit deliverable 2 and scanned live from src-tauri/src. Four negative cases per IPC row: UNAUTH = call from outside the webview (there is no path: Tauri IPC is reachable only from the app's own webview; record N/A unless you find one). ROLE = call from the read-only Monitor window (open one via Flight Deck > attempt tile > 'Monitor' or the conversation header menu 'Send to Monitor', then devtools in that window): expected rejection string is exactly "This read-only Monitor cannot invoke that application command." for every command except the five marked 'main, monitor'. ID = substitute a foreign/absent id (session id, flight id, conversation id): expected an error string naming the missing entity (e.g. "PTY session <id> not found", "unknown flightId", "Conversation id cannot traverse paths"). BODY = omit a required argument or send the wrong type: Tauri returns "invalid args `<arg>` for command `<name>`" before the handler runs.

| ID | Command | Roles | Mutates / reaches | Location | UNAUTH | ROLE | ID | BODY | [ ] | P/F |
|---|---|---|---|---|---|---|---|---|---|---|
| C001 | `analyze_code_quality` | main only | Reads project; may call aux LLM | `src-tauri/src/commands/code_quality.rs:330` |  |  |  |  |  |  |
| C002 | `archive_project_memory` | main only | Archives a note | `src-tauri/src/commands/project_memory.rs:917` |  |  |  |  |  |  |
| C003 | `ask_agent_chat_stream` | main only | Aux LLM stream (spend) | `src-tauri/src/commands/insights.rs:72` |  |  |  |  |  |  |
| C004 | `ask_side_chat_stream` | main only | Aux LLM stream (spend) | `src-tauri/src/commands/side_chat.rs:107` |  |  |  |  |  |  |
| C005 | `cancel_api_agent_session` | main only | Cancels a turn | `src-tauri/src/commands/api_agent.rs:1414` |  |  |  |  |  |  |
| C006 | `cancel_flight_attempt` | main only | Cancels an attempt | `src-tauri/src/commands/flight_attempts.rs:1016` |  |  |  |  |  |  |
| C007 | `cancel_pending_tools` | main only | Denies pending prompts | `src-tauri/src/commands/api_agent.rs:1616` |  |  |  |  |  |  |
| C008 | `cancel_quality_fix` | main only | Cancels a running task | `src-tauri/src/commands/code_quality_autofix.rs:554` |  |  |  |  |  |  |
| C009 | `cancel_quality_run` | main only | Cancels a running task | `src-tauri/src/commands/quality_runner.rs:1053` |  |  |  |  |  |  |
| C010 | `cancel_recording` | main only | Stops capture | `src-tauri/src/commands/dictation/audio.rs:814` |  |  |  |  |  |  |
| C011 | `cancel_side_chat_stream` | main only | Cancels a running task | `src-tauri/src/commands/side_chat.rs:304` |  |  |  |  |  |  |
| C012 | `change_model` | main only | Changes model | `src-tauri/src/commands/api_agent.rs:1432` |  |  |  |  |  |  |
| C013 | `cleanup_attempt_worktree_ssh` | main only | Removes remote worktree over SSH | `src-tauri/src/commands/flight_attempts.rs:1092` |  |  |  |  |  |  |
| C014 | `cleanup_flight_integration_worktree` | main only | Removes local integration worktree | `src-tauri/src/commands/flight_attempts.rs:1058` |  |  |  |  |  |  |
| C015 | `clear_dictation_history` | main only | Deletes SQLite rows | `src-tauri/src/commands/dictation/history.rs:312` |  |  |  |  |  |  |
| C016 | `cli_launch_diagnostics` | main only | Resolves launch path | `src-tauri/src/commands/agent.rs:277` |  |  |  |  |  |  |
| C017 | `clone_repo_remote` | main only | git clone over SSH (URL/branch validated) | `src-tauri/src/commands/git.rs:930` |  |  |  |  |  |  |
| C018 | `close_api_agent_session` | main only | Ends a session | `src-tauri/src/commands/api_agent.rs:1719` |  |  |  |  |  |  |
| C019 | `close_monitor_window` | main, monitor | Closes monitor window | `src-tauri/src/commands/monitor_windows.rs:162` |  |  |  |  |  |  |
| C020 | `code_quality_ai_explain` | main only | Aux LLM (spend) | `src-tauri/src/commands/code_quality.rs:652` |  |  |  |  |  |  |
| C021 | `code_quality_ai_summarize` | main only | Aux LLM (spend) | `src-tauri/src/commands/code_quality.rs:735` |  |  |  |  |  |  |
| C022 | `code_quality_probe_fixers` | main only | Probes project (read) | `src-tauri/src/commands/code_quality_autofix.rs:254` |  |  |  |  |  |  |
| C023 | `code_quality_run_fix` | main only | Spawns eslint --fix / prettier / cargo fix / pnpm audit --fix | `src-tauri/src/commands/code_quality_autofix.rs:319` |  |  |  |  |  |  |
| C024 | `create_conversation_worktree` | main only | git worktree add | `src-tauri/src/commands/git.rs:393` |  |  |  |  |  |  |
| C025 | `create_issue_worktree` | main only | git worktree add | `src-tauri/src/commands/git.rs:466` |  |  |  |  |  |  |
| C026 | `create_project_memory` | main only | Writes a note in the project memory dir | `src-tauri/src/commands/project_memory.rs:901` |  |  |  |  |  |  |
| C027 | `create_pty_session` | main only | Spawns allowlisted CLI/shell in a PTY with caller args+env | `src-tauri/src/commands/pty.rs:604` |  |  |  |  |  |  |
| C028 | `delete_api_key` | main only | Keyring delete | `src-tauri/src/commands/api_keys.rs:219` |  |  |  |  |  |  |
| C029 | `delete_conversation_file` | main only | Deletes a conversation file | `src-tauri/src/commands/conversations.rs:93` |  |  |  |  |  |  |
| C030 | `delete_crash` | main only | Deletes a crash log (confined) | `src-tauri/src/commands/crashes.rs:88` |  |  |  |  |  |  |
| C031 | `delete_dictation_entry` | main only | Deletes one row | `src-tauri/src/commands/dictation/history.rs:285` |  |  |  |  |  |  |
| C032 | `delete_mcp_server` | main only | Removes an mcpServers entry | `src-tauri/src/commands/mcp.rs:404` |  |  |  |  |  |  |
| C033 | `delete_packet_agent_token` | main only | Keyring delete | `src-tauri/src/commands/packet_agent.rs:247` |  |  |  |  |  |  |
| C034 | `delete_ssh_password` | main only | Keyring delete | `src-tauri/src/commands/ssh_keys.rs:220` |  |  |  |  |  |  |
| C035 | `delete_whisper_model` | main only | Deletes a model file | `src-tauri/src/commands/dictation/models.rs:539` |  |  |  |  |  |  |
| C036 | `deliver_dictation_text` | main only | Sets clipboard; optional Ctrl+V into foreground app | `src-tauri/src/commands/dictation/delivery.rs:31` |  |  |  |  |  |  |
| C037 | `detect_agent` | main only | Spawns <cli> --version | `src-tauri/src/commands/agent.rs:142` |  |  |  |  |  |  |
| C038 | `detect_cli_catalog` | main only | Spawns each CLI --version | `src-tauri/src/commands/agent.rs:151` |  |  |  |  |  |  |
| C039 | `detect_quality_checks` | main only | None (read) | `src-tauri/src/commands/quality_runner.rs:899` |  |  |  |  |  |  |
| C040 | `diagnose_mcp_server` | main only | Spawns the configured stdio MCP server | `src-tauri/src/commands/mcp.rs:224` |  |  |  |  |  |  |
| C041 | `download_whisper_model` | main only | Downloads pinned-SHA256 model from huggingface.co | `src-tauri/src/commands/dictation/models.rs:278` |  |  |  |  |  |  |
| C042 | `export_conversation_markdown` | main only | None (pure render) | `src-tauri/src/commands/conversations.rs:107` |  |  |  |  |  |  |
| C043 | `extract_patterns` | main only | Aux LLM (spend) | `src-tauri/src/commands/memory.rs:185` |  |  |  |  |  |  |
| C044 | `focus_monitor_route_in_main` | main, monitor | Focuses main window | `src-tauri/src/commands/monitor_windows.rs:185` |  |  |  |  |  |  |
| C045 | `get_api_key_exists` | main only | Keyring read | `src-tauri/src/commands/api_keys.rs:192` |  |  |  |  |  |  |
| C046 | `get_app_known_hosts_path` | main only | None (read) | `src-tauri/src/commands/pty.rs:1304` |  |  |  |  |  |  |
| C047 | `get_aux_provider_options` | main only | None (read) | `src-tauri/src/commands/aux_routing.rs:106` |  |  |  |  |  |  |
| C048 | `get_aux_route_resolutions` | main only | None (read) | `src-tauri/src/commands/aux_routing.rs:72` |  |  |  |  |  |  |
| C049 | `get_custom_compat_base_url` | main only | None (read) | `src-tauri/src/commands/custom_compat.rs:11` |  |  |  |  |  |  |
| C050 | `get_custom_compat_models` | main only | None (read) | `src-tauri/src/commands/custom_compat.rs:31` |  |  |  |  |  |  |
| C051 | `get_cwd` | main only | None | `src-tauri/src/commands/fs.rs:23` |  |  |  |  |  |  |
| C052 | `get_dictation_analytics` | main only | None (read) | `src-tauri/src/commands/dictation/analytics.rs:674` |  |  |  |  |  |  |
| C053 | `get_dictation_history` | main only | None (read) | `src-tauri/src/commands/dictation/history.rs:214` |  |  |  |  |  |  |
| C054 | `get_dictation_settings` | main only | None (read) | `src-tauri/src/commands/dictation/config.rs:110` |  |  |  |  |  |  |
| C055 | `get_file_head_content` | main only | None (read) | `src-tauri/src/commands/git.rs:221` |  |  |  |  |  |  |
| C056 | `get_git_branch` | main only | None (read) | `src-tauri/src/commands/git.rs:9` |  |  |  |  |  |  |
| C057 | `get_git_branch_remote` | main only | None (read) | `src-tauri/src/commands/git.rs:542` |  |  |  |  |  |  |
| C058 | `get_git_review_evidence` | main only | None (read) | `src-tauri/src/commands/git.rs:674` |  |  |  |  |  |  |
| C059 | `get_git_status` | main only | None (read) | `src-tauri/src/commands/git.rs:19` |  |  |  |  |  |  |
| C060 | `get_git_status_remote` | main only | None (read) | `src-tauri/src/commands/git.rs:557` |  |  |  |  |  |  |
| C061 | `get_minimax_base_url` | main only | None (read) | `src-tauri/src/commands/minimax.rs:14` |  |  |  |  |  |  |
| C062 | `get_monitor_window_route` | main, monitor | Read | `src-tauri/src/commands/monitor_windows.rs:146` |  |  |  |  |  |  |
| C063 | `get_ollama_base_url` | main only | None (read) | `src-tauri/src/commands/ollama.rs:87` |  |  |  |  |  |  |
| C064 | `get_ollama_runtime_options` | main only | None (read) | `src-tauri/src/commands/ollama.rs:131` |  |  |  |  |  |  |
| C065 | `get_packet_agent_token_exists` | main only | Keyring read | `src-tauri/src/commands/packet_agent.rs:238` |  |  |  |  |  |  |
| C066 | `get_provider_auth_status` | main only | Reads CLI credential files | `src-tauri/src/commands/provider_auth.rs:463` |  |  |  |  |  |  |
| C067 | `get_provider_auth_status_for_dir` | main only | Reads credential files in a dir | `src-tauri/src/commands/provider_auth.rs:563` |  |  |  |  |  |  |
| C068 | `get_provider_launch_stats` | main only | None (read) | `src-tauri/src/commands/provider_stats.rs:172` |  |  |  |  |  |  |
| C069 | `get_sidecar_status` | main only | None (read) | `src-tauri/src/commands/agent_sidecar/mod.rs:206` |  |  |  |  |  |  |
| C070 | `get_ssh_password_exists` | main only | Keyring read | `src-tauri/src/commands/ssh_keys.rs:167` |  |  |  |  |  |  |
| C071 | `git_commit` | main only | git commit (staged only) | `src-tauri/src/commands/git.rs:234` |  |  |  |  |  |  |
| C072 | `git_commit_remote` | main only | git commit over SSH | `src-tauri/src/commands/git.rs:993` |  |  |  |  |  |  |
| C073 | `git_create_branch` | main only | git branch (name validated) | `src-tauri/src/commands/git.rs:296` |  |  |  |  |  |  |
| C074 | `git_create_branch_remote` | main only | git branch over SSH | `src-tauri/src/commands/git.rs:1068` |  |  |  |  |  |  |
| C075 | `git_diff_file_remote` | main only | git diff over SSH (read) | `src-tauri/src/commands/git.rs:1023` |  |  |  |  |  |  |
| C076 | `git_get_origin_url` | main only | Read | `src-tauri/src/commands/git.rs:365` |  |  |  |  |  |  |
| C077 | `git_host_add_connection` | main only | Writes git-hosts.json + keyring token (P05 https unless local) | `src-tauri/src/commands/github.rs:942` |  |  |  |  |  |  |
| C078 | `git_host_has_token` | main only | Read | `src-tauri/src/commands/github.rs:1059` |  |  |  |  |  |  |
| C079 | `git_host_list_connections` | main only | Read | `src-tauri/src/commands/github.rs:872` |  |  |  |  |  |  |
| C080 | `git_host_probe_credential` | main only | HTTPS to pasted instance URL with pasted token (P05) | `src-tauri/src/commands/git_host_probe.rs:348` |  |  |  |  |  |  |
| C081 | `git_host_remove_connection` | main only | Deletes connection + token | `src-tauri/src/commands/github.rs:1004` |  |  |  |  |  |  |
| C082 | `git_host_set_active` | main only | Switches active host | `src-tauri/src/commands/github.rs:379` |  |  |  |  |  |  |
| C083 | `git_host_set_token` | main only | Keyring rewrite | `src-tauri/src/commands/github.rs:1041` |  |  |  |  |  |  |
| C084 | `git_host_update_connection` | main only | Rename/rotate after live probe | `src-tauri/src/commands/github.rs:1312` |  |  |  |  |  |  |
| C085 | `git_pull` | main only | git pull | `src-tauri/src/commands/git.rs:286` |  |  |  |  |  |  |
| C086 | `git_pull_remote` | main only | git pull over SSH | `src-tauri/src/commands/git.rs:1055` |  |  |  |  |  |  |
| C087 | `git_push` | main only | git push | `src-tauri/src/commands/git.rs:276` |  |  |  |  |  |  |
| C088 | `git_push_branch` | main only | git push -u origin <branch> [--force-with-lease] | `src-tauri/src/commands/git.rs:346` |  |  |  |  |  |  |
| C089 | `git_push_remote` | main only | git push over SSH | `src-tauri/src/commands/git.rs:1042` |  |  |  |  |  |  |
| C090 | `git_safety_check` | main only | Read | `src-tauri/src/commands/git.rs:375` |  |  |  |  |  |  |
| C091 | `git_stage_files` | main only | git add -- | `src-tauri/src/commands/git.rs:314` |  |  |  |  |  |  |
| C092 | `git_stage_files_remote` | main only | git add over SSH | `src-tauri/src/commands/git.rs:958` |  |  |  |  |  |  |
| C093 | `git_unstage_files` | main only | git restore --staged -- | `src-tauri/src/commands/git.rs:329` |  |  |  |  |  |  |
| C094 | `git_unstage_files_remote` | main only | git restore over SSH | `src-tauri/src/commands/git.rs:976` |  |  |  |  |  |  |
| C095 | `github_ai_catch_up` | main only | GitHub read + aux LLM (spend) | `src-tauri/src/commands/github.rs:2869` |  |  |  |  |  |  |
| C096 | `github_ai_pr_description` | main only | GitHub read + aux LLM (spend) | `src-tauri/src/commands/github.rs:2242` |  |  |  |  |  |  |
| C097 | `github_ai_pr_review` | main only | GitHub read + aux LLM (spend) | `src-tauri/src/commands/github.rs:2362` |  |  |  |  |  |  |
| C098 | `github_ai_triage` | main only | GitHub read + aux LLM (spend) | `src-tauri/src/commands/github.rs:3126` |  |  |  |  |  |  |
| C099 | `github_clear_token` | main only | Keyring delete | `src-tauri/src/commands/github.rs:525` |  |  |  |  |  |  |
| C100 | `github_close_issue` | main only | Mutates remote repo via git-host API (close issue) | `src-tauri/src/commands/github.rs:1767` |  |  |  |  |  |  |
| C101 | `github_close_pr` | main only | Mutates remote repo via git-host API (close pr) | `src-tauri/src/commands/github.rs:3416` |  |  |  |  |  |  |
| C102 | `github_convert_pr_to_draft` | main only | Mutates remote repo via git-host API (convert pr to draft) | `src-tauri/src/commands/github.rs:3440` |  |  |  |  |  |  |
| C103 | `github_create_issue` | main only | Mutates remote repo via git-host API (create issue) | `src-tauri/src/commands/github.rs:1499` |  |  |  |  |  |  |
| C104 | `github_create_pr` | main only | Mutates remote repo via git-host API (create pr) | `src-tauri/src/commands/github.rs:1561` |  |  |  |  |  |  |
| C105 | `github_create_repo_milestone` | main only | Mutates remote repo via git-host API (create repo milestone) | `src-tauri/src/commands/github.rs:1932` |  |  |  |  |  |  |
| C106 | `github_device_flow_commit` | main only | Keyring write | `src-tauri/src/commands/github.rs:837` |  |  |  |  |  |  |
| C107 | `github_device_flow_discard` | main only | Drops parked token | `src-tauri/src/commands/github.rs:854` |  |  |  |  |  |  |
| C108 | `github_device_flow_poll` | main only | Polls github.com; parks token | `src-tauri/src/commands/github.rs:751` |  |  |  |  |  |  |
| C109 | `github_device_flow_probe_pending` | main only | Probes parked token | `src-tauri/src/commands/github.rs:819` |  |  |  |  |  |  |
| C110 | `github_device_flow_start` | main only | github.com device endpoint (needs PACKETBENCH_GITHUB_CLIENT_ID) | `src-tauri/src/commands/github.rs:570` |  |  |  |  |  |  |
| C111 | `github_get_authenticated_user` | main only | GitHub/Gitea read with keyring token | `src-tauri/src/commands/github.rs:1400` |  |  |  |  |  |  |
| C112 | `github_get_issue` | main only | GitHub/Gitea read with keyring token | `src-tauri/src/commands/github.rs:1485` |  |  |  |  |  |  |
| C113 | `github_get_pr_checks` | main only | GitHub/Gitea read with keyring token | `src-tauri/src/commands/github.rs:3619` |  |  |  |  |  |  |
| C114 | `github_get_pr_diff` | main only | GitHub/Gitea read with keyring token | `src-tauri/src/commands/github.rs:1602` |  |  |  |  |  |  |
| C115 | `github_has_token` | main only | Read | `src-tauri/src/commands/github.rs:535` |  |  |  |  |  |  |
| C116 | `github_investigate_issue` | main only | GitHub read + aux LLM (spend) | `src-tauri/src/commands/github.rs:2051` |  |  |  |  |  |  |
| C117 | `github_list_branches` | main only | GitHub/Gitea read with keyring token | `src-tauri/src/commands/github.rs:2473` |  |  |  |  |  |  |
| C118 | `github_list_issue_comments` | main only | GitHub/Gitea read with keyring token | `src-tauri/src/commands/github.rs:1687` |  |  |  |  |  |  |
| C119 | `github_list_issues` | main only | GitHub/Gitea read with keyring token | `src-tauri/src/commands/github.rs:1448` |  |  |  |  |  |  |
| C120 | `github_list_issues_page` | main only | GitHub/Gitea read with keyring token | `src-tauri/src/commands/github.rs:1975` |  |  |  |  |  |  |
| C121 | `github_list_notifications` | main only | GitHub/Gitea read with keyring token | `src-tauri/src/commands/github.rs:4259` |  |  |  |  |  |  |
| C122 | `github_list_pr_review_comments` | main only | GitHub/Gitea read with keyring token | `src-tauri/src/commands/github.rs:3991` |  |  |  |  |  |  |
| C123 | `github_list_pr_reviews` | main only | GitHub/Gitea read with keyring token | `src-tauri/src/commands/github.rs:3962` |  |  |  |  |  |  |
| C124 | `github_list_prs` | main only | GitHub/Gitea read with keyring token | `src-tauri/src/commands/github.rs:1586` |  |  |  |  |  |  |
| C125 | `github_list_prs_page` | main only | GitHub/Gitea read with keyring token | `src-tauri/src/commands/github.rs:2018` |  |  |  |  |  |  |
| C126 | `github_list_releases` | main only | GitHub/Gitea read with keyring token | `src-tauri/src/commands/github.rs:1432` |  |  |  |  |  |  |
| C127 | `github_list_repo_assignable_users` | main only | GitHub/Gitea read with keyring token | `src-tauri/src/commands/github.rs:1959` |  |  |  |  |  |  |
| C128 | `github_list_repo_labels` | main only | GitHub/Gitea read with keyring token | `src-tauri/src/commands/github.rs:1900` |  |  |  |  |  |  |
| C129 | `github_list_repo_milestones` | main only | GitHub/Gitea read with keyring token | `src-tauri/src/commands/github.rs:1916` |  |  |  |  |  |  |
| C130 | `github_list_repos` | main only | GitHub/Gitea read with keyring token | `src-tauri/src/commands/github.rs:1379` |  |  |  |  |  |  |
| C131 | `github_list_repos_page` | main only | GitHub/Gitea read with keyring token | `src-tauri/src/commands/github.rs:2036` |  |  |  |  |  |  |
| C132 | `github_mark_notification_read` | main only | PATCH notification thread | `src-tauri/src/commands/github.rs:4286` |  |  |  |  |  |  |
| C133 | `github_merge_pr` | main only | Mutates remote repo via git-host API (merge pr) | `src-tauri/src/commands/github.rs:3326` |  |  |  |  |  |  |
| C134 | `github_oauth_configured` | main only | Read | `src-tauri/src/commands/github.rs:616` |  |  |  |  |  |  |
| C135 | `github_post_issue_comment` | main only | Mutates remote repo via git-host API (post issue comment) | `src-tauri/src/commands/github.rs:1710` |  |  |  |  |  |  |
| C136 | `github_post_pr_review_comment` | main only | Mutates remote repo via git-host API (post pr review comment) | `src-tauri/src/commands/github.rs:4024` |  |  |  |  |  |  |
| C137 | `github_reopen_issue` | main only | Mutates remote repo via git-host API (reopen issue) | `src-tauri/src/commands/github.rs:1780` |  |  |  |  |  |  |
| C138 | `github_reopen_pr` | main only | Mutates remote repo via git-host API (reopen pr) | `src-tauri/src/commands/github.rs:3427` |  |  |  |  |  |  |
| C139 | `github_reply_to_pr_review_comment` | main only | Mutates remote repo via git-host API (reply to pr review comment) | `src-tauri/src/commands/github.rs:4094` |  |  |  |  |  |  |
| C140 | `github_set_issue_assignees` | main only | Mutates remote repo via git-host API (set issue assignees) | `src-tauri/src/commands/github.rs:1793` |  |  |  |  |  |  |
| C141 | `github_set_issue_labels` | main only | Mutates remote repo via git-host API (set issue labels) | `src-tauri/src/commands/github.rs:1815` |  |  |  |  |  |  |
| C142 | `github_set_issue_milestone` | main only | Mutates remote repo via git-host API (set issue milestone) | `src-tauri/src/commands/github.rs:1886` |  |  |  |  |  |  |
| C143 | `github_set_pr_labels` | main only | Mutates remote repo via git-host API (set pr labels) | `src-tauri/src/commands/github.rs:2550` |  |  |  |  |  |  |
| C144 | `github_set_pr_milestone` | main only | Mutates remote repo via git-host API (set pr milestone) | `src-tauri/src/commands/github.rs:2602` |  |  |  |  |  |  |
| C145 | `github_set_pr_reviewers` | main only | Mutates remote repo via git-host API (set pr reviewers) | `src-tauri/src/commands/github.rs:2516` |  |  |  |  |  |  |
| C146 | `github_set_token` | main only | Probes GitHub then keyring write github-token | `src-tauri/src/commands/github.rs:507` |  |  |  |  |  |  |
| C147 | `github_update_issue` | main only | Mutates remote repo via git-host API (update issue) | `src-tauri/src/commands/github.rs:1530` |  |  |  |  |  |  |
| C148 | `inspect_cli_launch` | main only | Resolves launch path | `src-tauri/src/commands/agent.rs:244` |  |  |  |  |  |  |
| C149 | `inspect_packetcode_installation` | main only | Spawns packetcode --version | `src-tauri/src/commands/agent.rs:318` |  |  |  |  |  |  |
| C150 | `integrate_flight_attempt` | main only | Merges attempt into integration | `src-tauri/src/commands/git.rs:836` |  |  |  |  |  |  |
| C151 | `issues_extract_from_spec` | main only | Aux LLM (spend) | `src-tauri/src/commands/issues.rs:127` |  |  |  |  |  |  |
| C152 | `kill_pty` | main only | Kills a PTY process tree | `src-tauri/src/commands/pty.rs:950` |  |  |  |  |  |  |
| C153 | `kill_pty_and_wait` | main only | Kills a PTY tree and waits | `src-tauri/src/commands/pty.rs:980` |  |  |  |  |  |  |
| C154 | `land_flight_integration` | main only | Merges integration into root | `src-tauri/src/commands/git.rs:881` |  |  |  |  |  |  |
| C155 | `launch_flight_async` | main only | Creates worktrees (local/SSH), starts agent sessions (spend) | `src-tauri/src/commands/flight_attempts.rs:625` |  |  |  |  |  |  |
| C156 | `list_audio_devices` | main only | Read | `src-tauri/src/commands/dictation/audio.rs:160` |  |  |  |  |  |  |
| C157 | `list_crashes` | main only | None (read) | `src-tauri/src/commands/crashes.rs:44` |  |  |  |  |  |  |
| C158 | `list_directory` | main only | Read inside workspace | `src-tauri/src/commands/fs.rs:44` |  |  |  |  |  |  |
| C159 | `list_ollama_models` | main only | GET Ollama base URL (no secret) | `src-tauri/src/commands/ollama.rs:163` |  |  |  |  |  |  |
| C160 | `list_project_files` | main only | Read | `src-tauri/src/commands/fs.rs:375` |  |  |  |  |  |  |
| C161 | `list_project_memory` | main only | Read | `src-tauri/src/commands/project_memory.rs:896` |  |  |  |  |  |  |
| C162 | `list_provider_models` | main only | GET provider catalogs with keyring key | `src-tauri/src/commands/provider_models.rs:760` |  |  |  |  |  |  |
| C163 | `list_pty_sessions` | main only | None (read) | `src-tauri/src/commands/pty.rs:972` |  |  |  |  |  |  |
| C164 | `list_skills` | main only | None (read) | `src-tauri/src/commands/skills.rs:164` |  |  |  |  |  |  |
| C165 | `list_slash_commands` | main only | None (read) | `src-tauri/src/commands/slash_commands.rs:111` |  |  |  |  |  |  |
| C166 | `list_subdirectories` | main only | Read any absolute dir | `src-tauri/src/commands/fs.rs:160` |  |  |  |  |  |  |
| C167 | `list_whisper_models` | main only | Read | `src-tauri/src/commands/dictation/models.rs:241` |  |  |  |  |  |  |
| C168 | `list_wsl_distributions` | main only | Spawns wsl.exe --list | `src-tauri/src/commands/pty.rs:301` |  |  |  |  |  |  |
| C169 | `load_conversations` | main, monitor | None (read) | `src-tauri/src/commands/conversations.rs:53` |  |  |  |  |  |  |
| C170 | `load_persisted_state` | main, monitor | None (read) | `src-tauri/src/commands/state.rs:12` |  |  |  |  |  |  |
| C171 | `load_webview_storage_mirror` | main only | Read | `src-tauri/src/commands/webview_storage_mirror.rs:79` |  |  |  |  |  |  |
| C172 | `mark_attempt_status` | main only | Rewrites attempt status | `src-tauri/src/commands/flight_attempts.rs:1230` |  |  |  |  |  |  |
| C173 | `mcp_server_available_tools` | main only | Read | `src-tauri/src/mcp_server/mod.rs:314` |  |  |  |  |  |  |
| C174 | `mcp_server_recent_activity` | main only | Read | `src-tauri/src/mcp_server/mod.rs:297` |  |  |  |  |  |  |
| C175 | `mcp_server_start` | main only | Binds 127.0.0.1:<port>, mints bearer, serves MCP | `src-tauri/src/mcp_server/mod.rs:226` |  |  |  |  |  |  |
| C176 | `mcp_server_status` | main only | Read (returns token) | `src-tauri/src/mcp_server/mod.rs:284` |  |  |  |  |  |  |
| C177 | `mcp_server_stop` | main only | Stops MCP server | `src-tauri/src/mcp_server/mod.rs:271` |  |  |  |  |  |  |
| C178 | `merge_conversation_branch` | main only | git squash-merge into HEAD | `src-tauri/src/commands/git.rs:433` |  |  |  |  |  |  |
| C179 | `open_monitor_window` | main only | Creates monitor-main window | `src-tauri/src/commands/monitor_windows.rs:95` |  |  |  |  |  |  |
| C180 | `packet_agent_request` | main only | HTTPS to PacketAgent endpoint with keyring bearer; POST/PUT mutate deployments | `src-tauri/src/commands/packet_agent.rs:255` |  |  |  |  |  |  |
| C181 | `parse_spec_to_flight` | main only | Aux LLM (spend) | `src-tauri/src/commands/spec.rs:89` |  |  |  |  |  |  |
| C182 | `parse_spec_to_tickets` | main only | Aux LLM (spend) | `src-tauri/src/commands/spec.rs:104` |  |  |  |  |  |  |
| C183 | `path_is_dir` | main only | Existence probe, any path | `src-tauri/src/commands/fs.rs:37` |  |  |  |  |  |  |
| C184 | `prepare_flight_integration_branch` | main only | Creates integration branch | `src-tauri/src/commands/git.rs:800` |  |  |  |  |  |  |
| C185 | `probe_packetcode_integration` | main only | Spawns packetcode --version / doctor --json | `src-tauri/src/commands/agent.rs:362` |  |  |  |  |  |  |
| C186 | `probe_terminal_shell` | main only | Spawns <shell> --version | `src-tauri/src/commands/pty.rs:252` |  |  |  |  |  |  |
| C187 | `read_codex_statusline_states` | main only | None (read) | `src-tauri/src/commands/statusline/codex.rs:257` |  |  |  |  |  |  |
| C188 | `read_crash` | main only | Read (confined) | `src-tauri/src/commands/crashes.rs:82` |  |  |  |  |  |  |
| C189 | `read_file_contents` | main only | Read inside workspace (2 MB cap) | `src-tauri/src/commands/fs.rs:221` |  |  |  |  |  |  |
| C190 | `read_file_for_diff` | main only | Read (confined) | `src-tauri/src/commands/fs.rs:418` |  |  |  |  |  |  |
| C191 | `read_mcp_servers` | main only | Read both files | `src-tauri/src/commands/mcp.rs:364` |  |  |  |  |  |  |
| C192 | `read_opencode_statusline_states` | main only | None (read) | `src-tauri/src/commands/statusline/opencode.rs:23` |  |  |  |  |  |  |
| C193 | `read_prompt_history` | main only | None (read) | `src-tauri/src/commands/history.rs:33` |  |  |  |  |  |  |
| C194 | `read_pty_transcript` | main only | None (read) | `src-tauri/src/commands/pty.rs:1014` |  |  |  |  |  |  |
| C195 | `read_statusline_states` | main only | None (read) | `src-tauri/src/commands/statusline/claude.rs:29` |  |  |  |  |  |  |
| C196 | `read_usage_analytics` | main only | None (read) | `src-tauri/src/commands/analytics.rs:72` |  |  |  |  |  |  |
| C197 | `remove_conversation_worktree` | main only | git worktree remove | `src-tauri/src/commands/git.rs:409` |  |  |  |  |  |  |
| C198 | `resize_pty` | main only | Resizes a PTY | `src-tauri/src/commands/pty.rs:924` |  |  |  |  |  |  |
| C199 | `resolve_agents_md` | main only | Reads AGENTS.md chain | `src-tauri/src/commands/agents_md.rs:12` |  |  |  |  |  |  |
| C200 | `respond_edit` | main only | Applies/declines a pending edit | `src-tauri/src/commands/api_agent.rs:1575` |  |  |  |  |  |  |
| C201 | `respond_permission` | main only | Resolves a risky-tool prompt | `src-tauri/src/commands/api_agent.rs:1507` |  |  |  |  |  |  |
| C202 | `retry_last_turn` | main only | Re-runs last turn (spend) | `src-tauri/src/commands/api_agent.rs:1646` |  |  |  |  |  |  |
| C203 | `run_quality_checks` | main only | Spawns detected lint/typecheck/test/cargo | `src-tauri/src/commands/quality_runner.rs:911` |  |  |  |  |  |  |
| C204 | `save_agents_slice` | main only | Rewrites one slice of state.v1.json | `src-tauri/src/commands/state.rs:55` |  |  |  |  |  |  |
| C205 | `save_cli_accounts_slice` | main only | Rewrites one slice of state.v1.json | `src-tauri/src/commands/state.rs:104` |  |  |  |  |  |  |
| C206 | `save_conversation` | main only | Writes conversations/<id>.json (id validated) | `src-tauri/src/commands/conversations.rs:42` |  |  |  |  |  |  |
| C207 | `save_flights_slice` | main only | Rewrites one slice of state.v1.json | `src-tauri/src/commands/state.rs:50` |  |  |  |  |  |  |
| C208 | `save_issues_slice` | main only | Rewrites one slice of state.v1.json | `src-tauri/src/commands/state.rs:74` |  |  |  |  |  |  |
| C209 | `save_memory_slice` | main only | Rewrites one slice of state.v1.json | `src-tauri/src/commands/state.rs:84` |  |  |  |  |  |  |
| C210 | `save_persisted_state` | main only | Rewrites state.v1.json (not issues/retros) | `src-tauri/src/commands/state.rs:28` |  |  |  |  |  |  |
| C211 | `save_servers_slice` | main only | Rewrites one slice of state.v1.json | `src-tauri/src/commands/state.rs:92` |  |  |  |  |  |  |
| C212 | `save_settings_slice` | main only | Rewrites one slice of state.v1.json | `src-tauri/src/commands/state.rs:60` |  |  |  |  |  |  |
| C213 | `save_ui_slice` | main only | Rewrites one slice of state.v1.json | `src-tauri/src/commands/state.rs:69` |  |  |  |  |  |  |
| C214 | `save_webview_storage_mirror` | main only | Rewrites webview-storage-mirror.json (8 MB cap) | `src-tauri/src/commands/webview_storage_mirror.rs:120` |  |  |  |  |  |  |
| C215 | `save_workspaces_slice` | main only | Rewrites one slice of state.v1.json | `src-tauri/src/commands/state.rs:79` |  |  |  |  |  |  |
| C216 | `scan_codebase_memory` | main only | Reads project + aux LLM (spend) | `src-tauri/src/commands/memory.rs:93` |  |  |  |  |  |  |
| C217 | `search_dictation_history` | main only | SQLite read | `src-tauri/src/commands/dictation/history.rs:252` |  |  |  |  |  |  |
| C218 | `seed_cli_account_config_dir` | main only | Copies settings.json/config.toml between abs dirs (never credentials) | `src-tauri/src/commands/cli_account.rs:90` |  |  |  |  |  |  |
| C219 | `send_api_agent_message` | main only | Continues a turn (LLM spend) | `src-tauri/src/commands/api_agent.rs:1343` |  |  |  |  |  |  |
| C220 | `set_api_key` | main only | Keyring write api-key-<provider> | `src-tauri/src/commands/api_keys.rs:169` |  |  |  |  |  |  |
| C221 | `set_approve_writes` | main only | Toggles edit gate | `src-tauri/src/commands/api_agent.rs:1542` |  |  |  |  |  |  |
| C222 | `set_attempt_draft_pr` | main only | Records PR URL | `src-tauri/src/commands/flight_attempts.rs:1125` |  |  |  |  |  |  |
| C223 | `set_attempt_review_gate` | main only | Records review verdict | `src-tauri/src/commands/flight_attempts.rs:1195` |  |  |  |  |  |  |
| C224 | `set_aux_routing_overrides` | main only | Updates in-memory routing map | `src-tauri/src/commands/aux_routing.rs:50` |  |  |  |  |  |  |
| C225 | `set_custom_compat_base_url` | main only | Writes provider-settings.v1.json (P05) | `src-tauri/src/commands/custom_compat.rs:18` |  |  |  |  |  |  |
| C226 | `set_custom_compat_models` | main only | Writes model list | `src-tauri/src/commands/custom_compat.rs:38` |  |  |  |  |  |  |
| C227 | `set_dictation_settings` | main only | Writes dictation config | `src-tauri/src/commands/dictation/config.rs:156` |  |  |  |  |  |  |
| C228 | `set_flight_publish_attempts_as_prs` | main only | Flight flag | `src-tauri/src/commands/flight_attempts.rs:1158` |  |  |  |  |  |  |
| C229 | `set_minimax_base_url` | main only | Writes provider-settings.v1.json (P05 https unless local) | `src-tauri/src/commands/minimax.rs:19` |  |  |  |  |  |  |
| C230 | `set_ollama_base_url` | main only | Writes provider-settings.v1.json (http allowed; no secret) | `src-tauri/src/commands/ollama.rs:92` |  |  |  |  |  |  |
| C231 | `set_ollama_runtime_options` | main only | Writes num_ctx/keep_alive | `src-tauri/src/commands/ollama.rs:138` |  |  |  |  |  |  |
| C232 | `set_packet_agent_token` | main only | Keyring write packet-agent-token | `src-tauri/src/commands/packet_agent.rs:227` |  |  |  |  |  |  |
| C233 | `set_permission_mode` | main only | Changes gate posture | `src-tauri/src/commands/api_agent.rs:1481` |  |  |  |  |  |  |
| C234 | `set_plan_mode` | main only | Toggles plan mode | `src-tauri/src/commands/api_agent.rs:1455` |  |  |  |  |  |  |
| C235 | `set_ssh_password` | main only | Keyring write ssh-<serverId> | `src-tauri/src/commands/ssh_keys.rs:187` |  |  |  |  |  |  |
| C236 | `sign_out_provider` | main only | Deletes ~/.claude/.credentials.json or ~/.codex/auth.json | `src-tauri/src/commands/provider_auth.rs:436` |  |  |  |  |  |  |
| C237 | `ssh_check_remote_path` | main only | Spawns ssh to probe a remote path | `src-tauri/src/commands/pty.rs:1356` |  |  |  |  |  |  |
| C238 | `ssh_exec` | main only | Spawns local ssh with caller argv (P08 denylist); password via askpass/stdin | `src-tauri/src/commands/pty.rs:1070` |  |  |  |  |  |  |
| C239 | `ssh_fetch_fingerprint` | main only | Spawns ssh-keyscan + ssh-keygen | `src-tauri/src/commands/pty.rs:1153` |  |  |  |  |  |  |
| C240 | `ssh_pin_host` | main only | Appends to ~/.packetbench/ssh/known_hosts | `src-tauri/src/commands/pty.rs:1264` |  |  |  |  |  |  |
| C241 | `start_api_agent_session` | main only | Starts agent loop: keyring key, gated tools (P02 default ask), MCP, hooks; LLM spend | `src-tauri/src/commands/api_agent.rs:1051` |  |  |  |  |  |  |
| C242 | `start_packet_agent_stream` | main only | Opens SSE stream to PacketAgent (bearer) | `src-tauri/src/commands/packet_agent_stream.rs:176` |  |  |  |  |  |  |
| C243 | `start_recording` | main only | Opens microphone | `src-tauri/src/commands/dictation/audio.rs:458` |  |  |  |  |  |  |
| C244 | `stop_packet_agent_stream` | main only | Stops SSE task | `src-tauri/src/commands/packet_agent_stream.rs:220` |  |  |  |  |  |  |
| C245 | `stop_recording` | main only | Stops capture, runs whisper | `src-tauri/src/commands/dictation/audio.rs:855` |  |  |  |  |  |  |
| C246 | `summarize_flight` | main only | Aux LLM (spend) | `src-tauri/src/commands/memory.rs:223` |  |  |  |  |  |  |
| C247 | `summarize_session` | main only | Aux LLM (spend) | `src-tauri/src/commands/memory.rs:164` |  |  |  |  |  |  |
| C248 | `test_audio_device` | main only | Opens a device | `src-tauri/src/commands/dictation/audio.rs:294` |  |  |  |  |  |  |
| C249 | `toggle_pinned_pattern` | main only | Flips a memory pattern flag | `src-tauri/src/commands/memory.rs:278` |  |  |  |  |  |  |
| C250 | `update_project_memory` | main only | Rewrites a note (revision check) | `src-tauri/src/commands/project_memory.rs:909` |  |  |  |  |  |  |
| C251 | `watch_project_memory` | main only | Starts fs watcher | `src-tauri/src/commands/project_memory.rs:974` |  |  |  |  |  |  |
| C252 | `write_file_contents` | main only | Writes a file inside workspace | `src-tauri/src/commands/fs.rs:246` |  |  |  |  |  |  |
| C253 | `write_mcp_server` | main only | Upserts mcpServers in ~/.claude/settings.json or <project>/.mcp.json | `src-tauri/src/commands/mcp.rs:381` |  |  |  |  |  |  |
| C254 | `write_pty` | main only | Writes keystrokes to a PTY (64 KB cap) | `src-tauri/src/commands/pty.rs:899` |  |  |  |  |  |  |

| ID | Route | Auth | Mutates | Location | [ ] | P/F |
|---|---|---|---|---|---|---|
| N001 | GET /health on 127.0.0.1:<port> (MCP server) | any local process; Origin must be absent or loopback | None | src-tauri/src/mcp_server/transport.rs |  |  |
| N002 | POST/GET/DELETE /mcp (MCP Streamable HTTP) | bearer + loopback Origin + Host allowlist | tools M008-M010, M013-M016 mutate (allow_writes only) | src-tauri/src/mcp_server/transport.rs:69-100 |  |  |
| M001-M016 | MCP tools ping, get_active_flight, list_runnable_tasks, read_task_details, read_memory_context, search_project_memory, read_project_memory, create/update/archive_project_memory, list_workspaces, read_coordination_inbox, append_handoff, escalate, post_coordination_message, acknowledge_coordination_message | bearer; writes need Allow writes | see audit 2b | src-tauri/src/mcp_server/mod.rs:582-836 |  |  |
| R001-R002 | MCP resources packetbench://project\|flights\|flights/{id}\|flights/{id}/tasks\|flights/{id}/inbox\|issues\|reviews\|workspaces\|memory/patterns\|memory/project/{ws}\|packetcode/health | bearer; gated by the tool allowlist (P07) | packetcode/health spawns a process | src-tauri/src/mcp_server/mod.rs:923-1030 |  |  |

# Shot list

There are no URLs: PacketBench is a desktop window. Each shot names the in-app location, the state to be in, and the one question the shot answers. Dev builds are served from http://localhost:1420 inside the window (tauri.conf.json build.devUrl).

| # | Location + state | Question the shot answers | [ ] | P/F |
|---|---|---|---|---|
| S1 | Agents view, new API conversation in a repo NOT listed in trusted-projects.json; provider 'Claude (API)'; anthropic key present | Does the mode chip read 'Manual' (not 'Default') on a fresh conversation? (P02) |  |  |
| S2 | Same conversation; ask 'run `git status` with the bash tool' | Does the Allow once / Always allow / Deny prompt appear before anything runs? (P02) |  |  |
| S3 | Log viewer: Select-String packetbench::trust in today's log after S1 | Is 'project is not trusted: repo-supplied hooks, .mcp.json servers, and .claude/agents are ignored' present? (P01) |  |  |
| S4 | Settings > MCP > MCP Provider card, Enable MCP Provider on, Allow writes off, all tools ticked | Are port, bearer token, and served tool list visible? (baseline for S5) |  |  |
| S5 | Same card with only get_active_flight ticked, server re-enabled; terminal running the curl from test T-MCP-07 | Does resources/read of packetbench://memory/patterns return the allowlist error? (P07) |  |  |
| S6 | Settings > GitHub > Connect a git host wizard, Gitea, instance URL http://gitea.example.com, any token | Is the error 'Instance URL must use https:// ...' shown before any request? (P05) |  |  |
| S7 | Settings > Providers > API Keys card | Are keys shown only as present/absent, never as values? (I8) |  |  |
| S8 | Log viewer: Select-String packetbench::boot on app start | Does 'boot check done' appear with issues=0, and is the trust-file line present? (P09) |  |  |

# Screenshot slots

(one framed empty slot per shot; captions below)

- S1 - Agents view, new API conversation in a repo NOT listed in trusted-projects.json; provider 'Claude (API)'; anthropic key present  -  Q: Does the mode chip read 'Manual' (not 'Default') on a fresh conversation? (P02)
- S2 - Same conversation; ask 'run `git status` with the bash tool'  -  Q: Does the Allow once / Always allow / Deny prompt appear before anything runs? (P02)
- S3 - Log viewer: Select-String packetbench::trust in today's log after S1  -  Q: Is 'project is not trusted: repo-supplied hooks, .mcp.json servers, and .claude/agents are ignored' present? (P01)
- S4 - Settings > MCP > MCP Provider card, Enable MCP Provider on, Allow writes off, all tools ticked  -  Q: Are port, bearer token, and served tool list visible? (baseline for S5)
- S5 - Same card with only get_active_flight ticked, server re-enabled; terminal running the curl from test T-MCP-07  -  Q: Does resources/read of packetbench://memory/patterns return the allowlist error? (P07)
- S6 - Settings > GitHub > Connect a git host wizard, Gitea, instance URL http://gitea.example.com, any token  -  Q: Is the error 'Instance URL must use https:// ...' shown before any request? (P05)
- S7 - Settings > Providers > API Keys card  -  Q: Are keys shown only as present/absent, never as values? (I8)
- S8 - Log viewer: Select-String packetbench::boot on app start  -  Q: Does 'boot check done' appear with issues=0, and is the trust-file line present? (P09)

# Test sheets

## MCP server (N001/N002) - every row is a literal curl; replace <port> and <TOKEN> from Settings > MCP > MCP Provider

| ID | Case | Command | Expected | Failure signature | [ ] | P/F |
|---|---|---|---|---|---|---|
| T-MCP-01 | Health | `curl -s -i http://127.0.0.1:<port>/health` | HTTP 200; body {"ok":true,"app":"PacketBench","version":"0.14.0","service":"mcp"} | 404 (P07 not applied) or connection refused (server not enabled) |  |  |
| T-MCP-02 | No token | `curl -s -o /dev/null -w '%{http_code}' -X POST http://127.0.0.1:<port>/mcp -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"qa","version":"0"}}}'` | 401 | 200 = bearer layer missing; log has no 'MCP request rejected: bearer token missing or wrong' |  |  |
| T-MCP-03 | Wrong token | `curl -s -o /dev/null -w '%{http_code}' -X POST http://127.0.0.1:<port>/mcp -H 'authorization: Bearer nope' -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"qa","version":"0"}}}'` | 401; log line outcome=bad_token | 200 |  |  |
| T-MCP-04 | Non-loopback Origin (webhook analogue) | `curl -s -o /dev/null -w '%{http_code}' -X POST http://127.0.0.1:<port>/mcp -H 'origin: https://evil.example.com' -H 'authorization: Bearer <TOKEN>' -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"qa","version":"0"}}}'` | 403; log line outcome=forbidden_origin | 200 |  |  |
| T-MCP-05 | Origin guard on /health | `curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:<port>/health -H 'origin: https://evil.example.com'` | 403 | 200 |  |  |
| T-MCP-06 | Login | `curl -s -i -X POST http://127.0.0.1:<port>/mcp -H 'authorization: Bearer <TOKEN>' -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"qa","version":"0"}}}'` | 200; response header mcp-session-id present | 401 |  |  |
| T-MCP-07 | Resource denied by allowlist (server enabled with only get_active_flight ticked) | `after T-MCP-06 and notifications/initialized: curl -s -X POST http://127.0.0.1:<port>/mcp -H 'authorization: Bearer <TOKEN>' -H 'mcp-session-id: <SID>' -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' -d '{"jsonrpc":"2.0","id":5,"method":"resources/read","params":{"uri":"packetbench://memory/patterns"}}'` | JSON-RPC error 'resource is not permitted by this server's tool allowlist' | a result with 'patterns' |  |  |
| T-MCP-08 | Authenticated write (Allow writes ON, a Flight selected) | `same session: -d '{"jsonrpc":"2.0","id":6,"method":"tools/call","params":{"name":"append_handoff","arguments":{"flightId":"<flight id from get_active_flight>","summary":"qa note"}}}'` | 'Posted to the flight timeline.'; Flight Deck timeline shows actor mcp | 'writes are disabled; enable them in PacketBench's MCP Provider settings' (means Allow writes is off = documented failure path) |  |  |
| T-MCP-09 | Bad flight id | `same as T-MCP-08 with flightId 'nope'` | JSON-RPC error 'unknown flightId' | success |  |  |
| T-MCP-10 | Webhooks | `n/a - PacketBench has no inbound webhooks (audit section 3)` | record N/A | - |  |  |

## Paid outbound calls (every LLM spend path)

| ID | Path | Steps (real values) | Expected | Failure signature | [ ] | P/F |
|---|---|---|---|---|---|---|
| T-PAY-01 | Anthropic in-process (Claude (API) row) | Settings > Providers > API Keys: anthropic key set. Start a conversation, send 'say hi'. | log: packetbench::egress service=anthropic 'LLM request' then 'LLM response' status=200; usage.jsonl gains a row | 'No API key configured for anthropic. Set one in Settings > API Keys.' (key missing) or status=401 |  |  |
| T-PAY-02 | OpenAI-compatible (OpenAI / MiniMax / OpenRouter / Ollama / Custom rows) | Same with the row's key. For Ollama no key. | log: service=openai-compat base_url=<url> 'LLM response' status=200 | status=401/403 or 'Ollama not reachable at http://localhost:11434' |  |  |
| T-PAY-03 | Sidecar rows (Claude Agent SDK (API), OpenAI Agents SDK (API)) | Start a conversation on each row. | Sidecar status chip 'ready'; turn completes; usage row written | 'Sidecar crashed and could not restart' -> restart app |  |  |
| T-PAY-04 | Cost guardrail hard stop | Settings > Agents > Budget Guardrails: Daily cap $ = 0.01, Hard stop at % = 100. Start a new conversation after spend exceeds it. | Launch refused with the guardrail dialog (assertCostGuardrailsAllowLaunch) | conversation starts anyway |  |  |
| T-PAY-05 | Aux LLM features are NOT guardrail-checked (known gap) | With the cap from T-PAY-04 still exceeded, use Side chat or GitHub > AI PR description. | Expected today: the call proceeds (documented gap, audit section 3 'Rate limiting') | record actual; not a regression |  |  |
| T-PAY-06 | Custom endpoint over public http refused | Settings > Providers > Provider Endpoints: custom endpoint http://llm.example.com/v1 | 'Custom endpoint URL must use https:// - plain http:// is only allowed for localhost, private-network, or .local/.lan/.internal hosts...' | 'Saved.' |  |  |
| T-PAY-07 | PacketAgent | Settings > PacketAgent: endpoint https://agent.example.test, token set; press the health probe in the card | log: service=packetagent operation=health status=<code> | 'PacketAgent requires HTTPS; HTTP is allowed only for a loopback endpoint.' when http:// is entered |  |  |

## Background jobs

| ID | Job | Steps | Expected | Failure signature | [ ] | P/F |
|---|---|---|---|---|---|---|
| T-JOB-01 | Sidecar restart cap | taskkill /IM node.exe /F three times within 60 s while a sidecar conversation is open | Chip cycles restarting (1/3..3/3) then 'Sidecar crashed and could not restart' | no chip change; conversation hangs silently |  |  |
| T-JOB-02 | PTY orphan reap | Open a terminal pane running `claude`; taskkill /IM packetbench.exe /F; relaunch | Log line from core::pty::reap_orphaned_pty_children; no stray claude.exe in Task Manager | claude.exe survives |  |  |
| T-JOB-03 | PacketAgent SSE reconnect | Start a stream (Flight with a PacketAgent deployment); disconnect network 10 s | packet-agent:stream-status 'reconnecting' then 'connected'; cursor preserved | state 'error' with no retry |  |  |
| T-JOB-04 | Auth credential watcher | Run `claude login` in a terminal pane | AuthBadge flips to ready without reopening the picker (provider-auth:changed) | badge stale until restart |  |  |
| T-JOB-05 | Flight recovery on startup | Launch an attempt, force-kill the app, relaunch | Attempt shows Failed; worktree swept (log 'sweep_interrupted_attempts') | attempt stuck Running |  |  |

## Secret loading (every keyring account and file)

| ID | Secret | Steps | Expected | Failure signature | [ ] | P/F |
|---|---|---|---|---|---|---|
| T-SEC-01 | api-key-anthropic / openai / minimax / openrouter | Delete the key in Settings > Providers > API Keys ('Delete API key?'), start a conversation | 'No API key configured for <provider>. Set one in Settings > API Keys.'; log outcome=missing | turn starts |  |  |
| T-SEC-02 | github-token | Settings > GitHub > Remove git host, then open GitHub view | 'Sign in with GitHub, or add a token with repo scope' prompt; cmdkey /list no longer lists github-token.packetbench | token still listed |  |  |
| T-SEC-03 | git-host-token-<id> | Add a Gitea host (https), then Remove | cmdkey /list shows git-host-token-<id>.packetbench before, not after | entry remains |  |  |
| T-SEC-04 | ssh-<serverId> | Settings > Servers > Add password-auth server, Save; Delete remote host | entry ssh-<serverId>.packetbench appears then disappears | entry remains |  |  |
| T-SEC-05 | packet-agent-token | Settings > PacketAgent: save token; 'Remove stored token' | 'PacketAgent token removed from the credential store.' | requests still authenticate |  |  |
| T-SEC-06 | Boot keyring probe | Start the app; Select-String packetbench::boot | 'OS credential store is reachable' | 'OS credential store failed a read ...' |  |  |
| T-SEC-07 | Plaintext token file is inert | Create %USERPROFILE%\.packetbench\github-token containing 'x'; ask an agent to use gh_list_issues with the GitHub connection removed | 'GitHub token not configured. Run `github_set_token` first.' | the file's value is used (P06 not applied) |  |  |
| T-SEC-08 | Trust file | Delete %USERPROFILE%\.packetbench\trusted-projects.json; start a conversation in a repo with .claude/settings.json hooks | hooks do not run; log 'project hooks ignored: project is not in the trusted-projects list' | hook side effect observed |  |  |
| T-SEC-09 | Trust file malformed | Write '{ not json' to trusted-projects.json; repeat T-SEC-08 | 'trusted-projects file is not valid JSON; treating every project as untrusted' | hook runs |  |  |

# Patch verification (one test per patch, keyed to docs/audit/patches)

| Patch | Manual test (real values) | Expected | Nothing adjacent broke | Automated / log line | [ ] | P/F |
|---|---|---|---|---|---|---|
| P01 | Untrusted repo: add .claude/settings.json with {"hooks":[{"event":"SessionStart","command":"echo HOOKRAN > %TEMP%\\hook.txt"}]}; start a conversation; then add the repo to trusted-projects.json and start another | First: no hook.txt, log 'project hooks ignored'. Second: hook.txt exists | Adjacent: global ~/.claude/settings.json hooks still run in both cases | cargo test --lib -- project_trust merge_mcp_entries_for_sidecar_drops |  |  |
| P02 | New conversation, no posture chosen; send 'run `dir` via bash' | Chip 'Manual'; Allow once / Always allow / Deny prompt appears | Adjacent: choosing Default (auto) from the chip runs bash unprompted; Plan blocks bash entirely | cargo test --lib -- permission_mode_defaults_to_asking; vitest agentModeChipUtils.test.ts |  |  |
| P03 | Ask: 'use spawn_subagent to run `whoami` with bash' | Sub-agent result contains 'Error: tool 'bash' is not available to this sub-agent.'; log 'sub-agent requested a tool outside its allowlist; refused' | Adjacent: spawn_subagent can still read_file/grep | cargo test --lib -- subagent_allowlist denied_tools_stay custom_agents_cannot |  |  |
| P03b | In Manual mode ask the agent to create a pull request | Permission prompt for create_pull_request before any git push | Adjacent: Deny refuses it; plan mode disables it | cargo test --lib -- create_pull_request_is_a_risky_tool |  |  |
| P04 | mklink /D <workspace>\link C:\Users\<you>\.ssh (needs Developer Mode or admin); ask the agent to grep for 'Host' | No lines from the link; only workspace files | Adjacent: grep still finds matches in real subdirectories | cargo test --lib -- grep_does_not_follow_symlinks |  |  |
| P05 | Settings > GitHub > Connect a git host > Gitea, http://gitea.example.com | 'Gitea base URL must use https:// ...'; also http://gitea.local and http://192.168.1.5:3000 are accepted | Adjacent: Ollama base URL http://<lan-ip>:11434 still accepted (no secret) | cargo test --lib -- tls_guard |  |  |
| P06 | T-SEC-07 | as T-SEC-07 | Adjacent: keyring token still works for gh_list_issues | grep -n 'github-token' src-tauri/src/core/tool_github.rs shows keyring reads only |  |  |
| P07 | T-MCP-01, T-MCP-05, T-MCP-07 | as those rows | Adjacent: with no allowlist every resource still reads; tools/call still works | node smoke-test.mjs (fallback runs the transport tests) |  |  |
| P08 | In devtools: await window.__TAURI_INTERNALS__.invoke('ssh_exec',{commandArgs:['-o','ProxyCommand=calc.exe','u@h'],password:null}) | rejects with exactly "ssh option 'ProxyCommand=calc.exe' is not permitted"; calc does not open | Adjacent: Settings > Servers connect to a real key-auth host still works | cargo test --lib -- ssh_exec_refuses_local_execution_options |  |  |
| P09 | Set $env:PACKETBENCH_SIDECAR_PTH='x' and launch | log 'PACKETBENCH_SIDECAR_PTH is set but is not a variable PacketBench reads (typo? ...)' and 'boot check done issues=1' | Adjacent: app starts normally | cargo test --lib -- boot_check |  |  |
| P10 | Right-click a path in a conversation > Open in VS Code | VS Code opens the file | Adjacent: 'Show in Explorer' still fails with a console warn (known, H07) | grep plugins src-tauri/tauri.conf.json |  |  |
| P11 | ls -la .dockerignore | file absent | Adjacent: nothing depends on it | git log --oneline -1 -- .dockerignore |  |  |
| P12 | pnpm tauri build from a non-interactive shell | prune-sidecar prints 'pruned node_modules' and the build reaches the bundler | Adjacent: pnpm lint and pnpm build still work afterwards - root devDeps intact | grep -n ignore-workspace scripts/prune-sidecar.js |  |  |
| P13 | pnpm run release:readiness --skip-gates | the pnpm run check line reads 'not evaluated because some were not executed', NOT 'cannot be derived' | Adjacent: bundle artifact detection still passes; summary still 0 fail | grep -n remoteagents:check scripts/release-readiness.mjs |  |  |
| P14 | pnpm run remoteagents:build, then pnpm run lint:src | exits 0 and lints 7 files under remoteagents/, none of them under a dist/ directory | Adjacent: src and e2e still linted; eslint remoteagents alone still clean | npx eslint remoteagents --format json \| count the entries |  |  |
| P15 | Add a file under src/ that imports @/stores/remoteAgentsSettingsStore, then run pnpm run lint:src | no-restricted-imports error pointing at @/lib/remoteAgentsGate | Adjacent: re-add the workspaceStore import to agentTaskStore.ts - the tile-program store-isolation error must still fire | vitest src/lib/__tests__/remoteAgentsGate.test.ts |  |  |
| P16 | Add const K = "packetbench:anything" to any file under src/, then run pnpm test | scripts/storage-key-brand.test.mjs fails and names the file | Adjacent: settings, prompts, routing, workspaces and GitHub state all survive an app restart - the keys are unchanged | vitest scripts/storage-key-brand.test.mjs |  |  |
| P17 | Open onboarding, the title bar, and Settings > Git host with a bad URL | every screen still reads PacketBench exactly as before | Adjacent: the Releases link in Settings still points at github.com/packetloss404/PacketBench; git trailers still read Run-By: PacketBench | vitest scripts/app-name-brand.test.mjs |  |  |

# Unresolved experiments (audit section 7)

| ID | Question | Procedure (cold) | How to read the result | [ ] | P/F |
|---|---|---|---|---|---|
| U01 | Windows password-auth SSH | Settings > Servers > Add: Host <a linux host allowing password auth>, Authentication: password, Save, then Connect. Watch the 'Connecting via SSH...' step. | Connected within 8 s = stdin path works (F12 void). Timeout/'Permission denied' = stdin path dead -> handoff Task 3. |  |  |
| U02 | xterm link handler | SETTLED 2026-09-05: window.open() returns null in this webview, so the addon logs 'Opening link blocked as opener could not be cleared' and does nothing when a terminal URL is clicked. | Settled - benign, no action. Re-check only if xterm or the webview is upgraded. |  |  |
| U03 | Key inheritance by MCP stdio servers under the Agent SDK | SETTLED 2026-09-05: the MCP SDK spawns stdio servers with a fixed 12-name env allowlist that excludes ANTHROPIC_API_KEY; a probe child received 15 vars, none of them the key or a sentinel. | Settled - F11 refuted, no leak. Re-run after an MCP SDK bump. |  |  |
| U04 | Sidecar-only audit | cd agent-sidecar && pnpm --ignore-workspace audit --json | SETTLED 2026-09-05: 37 advisories (10 high, 24 moderate, 3 low, 0 critical), almost all in the MCP SDK HTTP-server half the sidecar never starts. Recorded in the dependency snapshot. |  |  |
| U05 | Packaged shell open scope | SETTLED 2026-09-05. Dev build: the scope rejected a bare path and file:// quoting the P10 regex, and allowed vscode://file/ (VS Code opened) and https:// (Edge opened). Packaged build: the release exe contains the scope regex once, byte-identical to tauri.conf.json line 14; the 2026-08-30 release exe contains it zero times. Installed build: the conversation menu's Open in VS Code launched VS Code cold onto the conversation project, and Open project folder in OS (a bare path) opened nothing. | Settled both ways. To re-check after a config change: strings the built exe for vscode://file/ before shipping, then click both menu items - Open in VS Code must work and the bare-path one must not. |  |  |
| U06 | Vitest stability | pnpm test twice on an idle machine | Both runs 2743 passed; any single non-reproducing failure is CPU contention. |  |  |
| U07 | Real-hardware acceptance | dev/acceptance.md sections 3-5 with the headset | Rows ticked in that file. |  |  |

# Ops pages (from docs/runbooks.md)

| Task | Command | Success looks like | [ ] | P/F |
|---|---|---|---|---|
| Build installers | `export PATH="/c/Users/ianwalmsley/.rustup/toolchains/stable-x86_64-pc-windows-msvc/bin:$PATH" pnpm gates:full pnpm run release:gate pnpm tauri build pnpm run release:readiness --skip-gates pnpm sidecar:install` | C:/Users/ianwalmsley/packetbench-build/release/bundle/nsis/PacketBench_<version>_x64-setup.exe exists |  |  |
| Roll back app | `Windows Settings > Apps > PacketBench > Uninstall; run the previous -setup.exe from the bundle dir` | Version shown in Settings > Advanced matches the previous release |  |  |
| Roll back a patch | `git apply -R docs/audit/patches/<name>.diff   (revert P09 before P01)` | cargo test --lib passes |  |  |
| Restart app | `taskkill /IM packetbench.exe /F` | Next launch logs boot check done and reaps orphan PTYs |  |  |
| Restart MCP server | `Settings > MCP > MCP Provider > Enable MCP Provider off/on` | New bearer token shown; /health answers |  |  |
| Tail logs | `Get-Content -Wait -Tail 50 "$env:LOCALAPPDATA\PacketBench\logs\packetbench.log.$(Get-Date -Format yyyy-MM-dd)"` | lines stream |  |  |
| Security lines only | `Select-String -Path "$env:LOCALAPPDATA\PacketBench\logs\packetbench.log.*" -Pattern 'packetbench::(auth\|egress\|trust\|boot)'` | matches listed |  |  |
| List secrets | `cmdkey /list \| findstr packetbench` | targets <account>.packetbench listed |  |  |
| Rotate API key | `Settings > Providers > API Keys: paste new key, save (old one overwritten in api-key-<provider>.packetbench)` | next turn logs outcome=found |  |  |
| Rotate git-host token | `Settings > GitHub > host row > Edit > paste token > save (live-probed first)` | 'Rotated the token for git-host connection' in log |  |  |
| Rotate PacketAgent token | `Settings > PacketAgent > Remove stored token, then save the new one` | 'PacketAgent token removed from the credential store.' then requests succeed |  |  |
| Restore state | `taskkill /IM packetbench.exe /F; Copy-Item "$env:USERPROFILE\.packetbench\state.v1.json.bak" "$env:USERPROFILE\.packetbench\state.v1.json" -Force` | app launches with the previous flights/workspaces |  |  |
| Full backup | `robocopy "$env:USERPROFILE\.packetbench" "D:\backups\packetbench-<date>" /E /XD pty-transcripts` | folder copied; secrets must be re-entered on restore |  |  |
| Health | `curl -s http://127.0.0.1:<port>/health` | {"ok":true,"app":"PacketBench",...} |  |  |

# Bug log

| # | Date | Where | What happened vs expected | Severity |
|---|---|---|---|---|
| 1 | | | | |
| 2 | | | | |
| 3 | | | | |
| 4 | | | | |
| 5 | | | | |
| 6 | | | | |
| 7 | | | | |
| 8 | | | | |
| 9 | | | | |
| 10 | | | | |
| 11 | | | | |
| 12 | | | | |
| 13 | | | | |
| 14 | | | | |
| 15 | | | | |
| 16 | | | | |
| 17 | | | | |
| 18 | | | | |
| 19 | | | | |
| 20 | | | | |
| 21 | | | | |
| 22 | | | | |

# Day-31 backlog (fill on the first day access returns)

Seed items, from docs/handoff.md section 4: (1) trust-list UI, (2) cargo update -p h2 -p rustls-webpki -p quinn-proto, (3) Windows askpass for password SSH, (4) reveal_in_file_manager command, (5) restart_sidecar + turn-level cost guardrail.

| # | Item | Evidence | Priority | Owner |
|---|---|---|---|---|
| 1 | | | | |
| 2 | | | | |
| 3 | | | | |
| 4 | | | | |
| 5 | | | | |
| 6 | | | | |
| 7 | | | | |
| 8 | | | | |
| 9 | | | | |
| 10 | | | | |
| 11 | | | | |
| 12 | | | | |
| 13 | | | | |
| 14 | | | | |
| 15 | | | | |
| 16 | | | | |
| 17 | | | | |
| 18 | | | | |
| 19 | | | | |
| 20 | | | | |

