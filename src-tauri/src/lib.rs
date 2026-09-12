pub mod api;
mod claude;
mod commands;
pub mod core;
mod mcp_server;

use commands::agent_sidecar::SidecarManager;
use commands::api_agent::ApiAgentState;
use commands::code_quality_autofix::CodeQualityAutoFixState;
use commands::dictation::audio::create_dictation_state;
use commands::dictation::whisper::WhisperState;
use commands::github::{create_device_auth_state, create_github_auth_state};
use commands::pty::create_shared_pty_manager;
use commands::quality_runner::QualityRunnerState;
use tauri::Manager;

fn init_tracing() {
    use tracing_subscriber::{fmt, EnvFilter};

    let log_dir = dirs_log_dir();
    let file_appender = tracing_appender::rolling::daily(log_dir, "packetbench.log");
    let (non_blocking, _guard) = tracing_appender::non_blocking(file_appender);

    // Leak the guard so the writer stays alive for the process lifetime
    std::mem::forget(_guard);

    let filter = EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info"));

    fmt()
        .with_env_filter(filter)
        .with_writer(non_blocking)
        .with_ansi(false)
        .init();
}

fn dirs_log_dir() -> std::path::PathBuf {
    use crate::core::brand::LOG_DIR_NAME;
    #[cfg(target_os = "linux")]
    {
        let base = std::env::var("XDG_DATA_HOME").unwrap_or_else(|_| {
            let home = std::env::var("HOME").unwrap_or_else(|_| "/tmp".to_string());
            format!("{}/.local/share", home)
        });
        std::path::PathBuf::from(base)
            .join(LOG_DIR_NAME)
            .join("logs")
    }
    #[cfg(target_os = "macos")]
    {
        let home = std::env::var("HOME").unwrap_or_else(|_| "/tmp".to_string());
        std::path::PathBuf::from(home)
            .join("Library/Application Support")
            .join(LOG_DIR_NAME)
            .join("logs")
    }
    #[cfg(target_os = "windows")]
    {
        let appdata = std::env::var("LOCALAPPDATA")
            .or_else(|_| std::env::var("APPDATA"))
            .unwrap_or_else(|_| "C:\\ProgramData".to_string());
        std::path::PathBuf::from(appdata)
            .join(LOG_DIR_NAME)
            .join("logs")
    }
}

/// PTY spawn helper. Re-invoked as
/// `packetbench __pty_spawn <cwd> <program> <args...>` by the vendored
/// portable-pty (`UnixSlavePty::spawn_command`), with the slave pty wired to
/// fd 0/1/2. This runs in a fresh, single-threaded process that the parent
/// created via `posix_spawn` (fork-safe in a multi-threaded host), so it can
/// safely become a session leader, claim the pty as its controlling terminal,
/// chdir, and exec the real program. Never returns.
#[cfg(unix)]
pub fn pty_spawn_helper(args: &[std::ffi::OsString]) -> ! {
    use std::os::unix::ffi::OsStrExt;

    // args = [cwd, program, arg1, ...]
    let cwd = args.first().cloned().unwrap_or_default();
    let exec_argv = args.get(1..).unwrap_or(&[]);

    unsafe {
        if !cwd.is_empty() {
            if let Ok(c) = std::ffi::CString::new(cwd.as_bytes()) {
                libc::chdir(c.as_ptr());
            }
        }
        // Become a session leader and claim the pty (fd 0) as the controlling
        // terminal so SIGWINCH/job control work for the TUI CLIs.
        libc::setsid();
        libc::ioctl(0, libc::TIOCSCTTY as _, 0);
    }

    let c_args: Vec<std::ffi::CString> = exec_argv
        .iter()
        .filter_map(|a| std::ffi::CString::new(a.as_bytes()).ok())
        .collect();
    if c_args.is_empty() {
        std::process::exit(127);
    }
    let mut ptrs: Vec<*const libc::c_char> = c_args.iter().map(|c| c.as_ptr()).collect();
    ptrs.push(std::ptr::null());
    unsafe {
        libc::execvp(ptrs[0], ptrs.as_ptr());
    }
    // Only reached if exec failed.
    std::process::exit(127);
}

fn typed_application_invoke_handler<F>(handler: F) -> F
where
    F: Fn(tauri::ipc::Invoke<tauri::Wry>) -> bool,
{
    handler
}

macro_rules! guarded_invoke_handler {
    ($($command:path),* $(,)?) => {{
        let handler =
            typed_application_invoke_handler(tauri::generate_handler![$($command),*]);
        move |invoke: tauri::ipc::Invoke<tauri::Wry>| {
            let command_allowed = commands::monitor_windows::command_allowed_for_window(
                invoke.message.webview_ref().label(),
                invoke.message.command(),
            );
            if !command_allowed {
                invoke
                    .resolver
                    .reject("This read-only Monitor cannot invoke that application command.");
                return true;
            }
            handler(invoke)
        }
    }};
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Repair PATH for GUI launches (Finder/Dock/Spotlight give us only the
    // minimal launchd PATH). Reconstructs PATH from known install dirs + the
    // user's shell rc files *without executing the shell*, so it never trips
    // privacy prompts via the user's config. Must run before the sidecar, PTY,
    // or any CLI lookup (`which claude`, `gh`, `git`, `node`, …).
    //
    // CRITICAL: this calls `std::env::set_var`, which is only sound while the
    // process is single-threaded. It MUST run before anything spawns a thread —
    // notably `init_tracing()` below, which starts a background log-writer
    // thread. Mutating `environ` once another thread exists is UB and corrupts
    // the environment such that a later PTY `fork()`+`exec()` aborts in the
    // child ("crashed on child side of fork pre-exec"). So this is the very
    // first statement in `run()`.
    core::shell_path::fix_path_for_gui_launch();

    init_tracing();
    // Rename ~/.packetade → ~/.packetbench once per upgrade (LEGACY_DATA_DIR_NAME
    // is the immediately-prior name; the older ~/.packetcode hop already ran).
    // Must run before any command that reads/writes the data dir.
    core::migration::migrate_data_dir();
    // Canonicalize any lingering legacy `missionId` keys in persisted
    // flight-approval records to `flightId`. Runs after migrate_data_dir so the
    // data dir is resolved; a no-op once the state has no legacy keys.
    core::migration::migrate_mission_to_flight();
    commands::crashes::install_panic_hook();
    // Validate the environment once the data dir has settled: writable data
    // dir, reachable credential store, trust file, and PACKETBENCH_* typos.
    // Logs under `packetbench::boot`; never aborts startup.
    let _boot_issues = core::boot_check::run();

    // One-time: rewrite the dollar figures in `usage.jsonl` and in persisted
    // conversation messages that were computed with the pre-CE2 (wrong) model
    // rates — Opus overstated ~3x, MiniMax M2 ~1.6x, Haiku 4.5 understated
    // ~20%. This is not cosmetic: those numbers are what the budget guardrails
    // hard-stop on, so a 3x-overstated history locks the user out early. Runs
    // after migrate_data_dir so the data dir has settled, after the panic hook
    // so a surprise is reported, and before the Tauri builder so nothing is
    // writing either artifact. No-op on a fresh install, and idempotent
    // (see `core::reprice`).
    core::reprice::reprice_historical_costs();

    // Reap PTY-agent children stranded by a previous run's abnormal exit
    // (SIGKILL / crash / force-quit) before we spawn anything new. Runs after
    // migrate_data_dir so the registry resolves to the current data dir.
    core::pty::reap_orphaned_pty_children();

    // Normalize persisted flights left in an interrupted state by a previous
    // abnormal exit (stale Active/Running milestone-task status, dead session
    // ids). Runs after migrate_data_dir so the data dir is resolved. Formerly
    // done inside the (now-removed) shared-orchestrator constructor.
    // Attempts are reconciled here too: their API sessions do not survive a
    // restart, so any left Queued/Provisioning/Running is demoted to Failed.
    // The worktrees they leave behind can only be swept once the async runtime
    // is up, so recovery hands them back and `.setup()` spawns the sweep.
    let interrupted_attempts = match core::storage::update_state(|state| {
        core::orchestrator::recover_flights_on_startup(&mut state.flights)
    }) {
        Ok(interrupted) => interrupted,
        Err(e) => {
            tracing::warn!("Failed to persist flight recovery on startup: {}", e);
            Vec::new()
        }
    };

    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        // Restore the last window size/position on launch; saves on close.
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .manage(create_github_auth_state())
        .manage(create_device_auth_state())
        .manage(create_shared_pty_manager())
        .manage(create_dictation_state())
        .manage(WhisperState::default())
        .manage(std::sync::Arc::new(ApiAgentState::new()))
        .manage(std::sync::Arc::new(QualityRunnerState::new()))
        .manage(std::sync::Arc::new(CodeQualityAutoFixState::new()))
        .manage(mcp_server::create_mcp_server_state())
        .manage(commands::monitor_windows::MonitorWindowRegistry::default())
        .manage(commands::project_memory::ProjectMemoryWatchState::default())
        .manage(std::sync::Arc::new(
            commands::side_chat::SideChatState::default(),
        ))
        // WI-1 — backend mirror of the auxiliary AI routing settings. Empty
        // until the frontend routing store pushes; an empty map means
        // "auto (cheapest configured API key)", never a subscription login.
        .manage(core::aux_llm::AuxRoutingState::default())
        // PH6 — registry of live PacketAgent SSE consumer tasks.
        .manage(commands::packet_agent_stream::PacketAgentStreamState::default())
        .setup(|app| {
            // Spawn the Node agent sidecar and stash the supervisor in
            // managed state so slice C's routing layer can reach it via
            // `State<Arc<SidecarManager>>`. The manager spawns the child
            // asynchronously, so `.setup()` returns immediately.
            use tauri::Manager;
            let manager = SidecarManager::new(app.handle().clone());
            app.manage(manager);

            // Start the auth-credentials fs watcher so the AuthBadge in the
            // Agents pane updates the moment a `claude login` / `codex
            // login` completes, without the user having to re-open the
            // dropdown.
            if let Err(e) = commands::auth_watcher::init(&app.handle()) {
                tracing::warn!("auth_watcher init failed: {}", e);
            }

            // Best-effort teardown of the worktrees belonging to attempts a
            // previous run left mid-flight (see the recovery pass above).
            // Detached: git/SSH removal is slow and must not delay the window.
            tauri::async_runtime::spawn(async move {
                commands::flight_attempts::sweep_interrupted_attempts(interrupted_attempts).await;
            });

            // Per-platform window chrome. The config sets
            // `decorations: true` + `titleBarStyle: "Overlay"` so macOS
            // shows traffic lights overlaid on our custom TitleBar
            // (titleBarStyle is macOS-only). On Windows + Linux, that same
            // `decorations: true` would re-introduce the native title bar
            // alongside our custom one — so we strip decorations at
            // runtime here. The custom TitleBar is the only chrome on
            // those platforms.
            #[cfg(not(target_os = "macos"))]
            {
                if let Some(win) = app.get_webview_window("main") {
                    let _ = win.set_decorations(false);
                }
            }

            Ok(())
        })
        .invoke_handler(guarded_invoke_handler![
            // PTY-based sessions (primary)
            commands::pty::create_pty_session,
            commands::pty::write_pty,
            commands::pty::resize_pty,
            commands::pty::kill_pty,
            commands::pty::kill_pty_and_wait,
            commands::pty::list_pty_sessions,
            commands::pty::read_pty_transcript,
            commands::pty::probe_terminal_shell,
            commands::pty::list_wsl_distributions,
            commands::pty::ssh_exec,
            commands::pty::ssh_fetch_fingerprint,
            commands::pty::ssh_pin_host,
            commands::pty::ssh_check_remote_path,
            commands::pty::get_app_known_hosts_path,
            commands::ssh_keys::get_ssh_password_exists,
            commands::ssh_keys::set_ssh_password,
            commands::ssh_keys::delete_ssh_password,
            // Git
            commands::git::get_git_branch,
            commands::git::get_git_status,
            commands::git::get_file_head_content,
            commands::git::get_git_branch_remote,
            commands::git::get_git_status_remote,
            commands::git::get_git_review_evidence,
            commands::git::prepare_flight_integration_branch,
            commands::git::integrate_flight_attempt,
            commands::git::land_flight_integration,
            commands::git::git_stage_files_remote,
            commands::git::git_unstage_files_remote,
            commands::git::git_commit_remote,
            commands::git::git_push_remote,
            commands::git::git_diff_file_remote,
            commands::git::git_pull_remote,
            commands::git::git_create_branch_remote,
            commands::git::git_commit,
            commands::git::git_push,
            commands::git::git_pull,
            commands::git::git_create_branch,
            // P1-15: per-file staging for the GitDashboard commit flow
            commands::git::git_stage_files,
            commands::git::git_unstage_files,
            // v0.8-G pr modal upgrades — push a specific branch for
            // "Publish attempts as draft PRs"
            commands::git::git_push_branch,
            // v0.8-15 workspace github bind
            commands::git::git_get_origin_url,
            commands::git::git_safety_check,
            commands::git::create_conversation_worktree,
            commands::git::remove_conversation_worktree,
            // P2-S1: local squash-merge with ruled safety semantics
            commands::git::merge_conversation_branch,
            // v0.8.5 fix: issue worktree wiring
            commands::git::create_issue_worktree,
            commands::agents_md::resolve_agents_md,
            // Code quality
            commands::code_quality::analyze_code_quality,
            // Quality runner (lint/typecheck/test/cargo)
            commands::quality_runner::detect_quality_checks,
            commands::quality_runner::run_quality_checks,
            commands::quality_runner::cancel_quality_run,
            // v0.8.8 quality autofix
            commands::code_quality_autofix::code_quality_probe_fixers,
            commands::code_quality_autofix::code_quality_run_fix,
            commands::code_quality_autofix::cancel_quality_fix,
            // v0.8.8 quality ai
            commands::code_quality::code_quality_ai_explain,
            commands::code_quality::code_quality_ai_summarize,
            // WI-1 — auxiliary AI routing settings
            commands::aux_routing::set_aux_routing_overrides,
            commands::aux_routing::get_aux_route_resolutions,
            commands::aux_routing::get_aux_provider_options,
            // Crash reports
            commands::crashes::list_crashes,
            commands::crashes::read_crash,
            commands::crashes::delete_crash,
            // Filesystem
            commands::fs::list_directory,
            commands::fs::list_subdirectories,
            commands::fs::get_cwd,
            commands::fs::path_is_dir,
            commands::fs::read_file_contents,
            commands::fs::write_file_contents,
            commands::fs::list_project_files,
            commands::fs::read_file_for_diff,
            // Flight lifecycle orchestration
            commands::flight_attempts::launch_flight_async,
            commands::flight_attempts::cancel_flight_attempt,
            commands::flight_attempts::cleanup_attempt_worktree_ssh,
            commands::flight_attempts::cleanup_flight_integration_worktree,
            commands::flight_attempts::mark_attempt_status,
            // v0.8-G pr modal upgrades — async-Flight draft-PR publish
            commands::flight_attempts::set_attempt_draft_pr,
            commands::flight_attempts::set_attempt_review_gate,
            commands::flight_attempts::set_flight_publish_attempts_as_prs,
            // Unified persisted state
            commands::state::load_persisted_state,
            commands::state::save_persisted_state,
            commands::state::save_flights_slice,
            commands::state::save_agents_slice,
            commands::state::save_settings_slice,
            commands::state::save_ui_slice,
            commands::state::save_issues_slice,
            commands::state::save_workspaces_slice,
            commands::state::save_memory_slice,
            // v0.8-H memory inline
            commands::memory::toggle_pinned_pattern,
            commands::state::save_servers_slice,
            commands::state::save_cli_accounts_slice,
            // Durable localStorage mirror — survives a bundle-identifier change
            commands::webview_storage_mirror::load_webview_storage_mirror,
            commands::webview_storage_mirror::save_webview_storage_mirror,
            // Agent detection
            commands::agent::detect_agent,
            // v0.8.3 cli detection
            commands::agent::detect_cli_catalog,
            commands::agent::inspect_cli_launch,
            commands::agent::cli_launch_diagnostics,
            commands::agent::inspect_packetcode_installation,
            commands::agent::probe_packetcode_integration,
            // Status line
            commands::statusline::claude::read_statusline_states,
            commands::statusline::codex::read_codex_statusline_states,
            commands::statusline::opencode::read_opencode_statusline_states,
            // Spec parsing
            commands::spec::parse_spec_to_flight,
            commands::spec::parse_spec_to_tickets,
            // v0.8.5 issues spec import
            commands::issues::issues_extract_from_spec,
            // Agent-chat side panel streaming (was Insights; Insights folded into
            // the Agents pane via the Scout profile).
            commands::insights::ask_agent_chat_stream,
            // Flight chat
            // Side chat (ephemeral context-aware helper)
            commands::side_chat::ask_side_chat_stream,
            commands::side_chat::cancel_side_chat_stream,
            // GitHub integration
            commands::github::github_set_token,
            commands::github::github_clear_token,
            commands::github::github_has_token,
            commands::github::git_host_list_connections,
            commands::github::git_host_add_connection,
            commands::github::git_host_remove_connection,
            commands::github::git_host_set_token,
            commands::github::git_host_update_connection,
            commands::github::git_host_has_token,
            commands::github::git_host_set_active,
            commands::git_host_probe::git_host_probe_credential,
            commands::github::github_device_flow_start,
            commands::github::github_device_flow_poll,
            commands::github::github_device_flow_probe_pending,
            commands::github::github_device_flow_commit,
            commands::github::github_device_flow_discard,
            commands::github::github_oauth_configured,
            commands::github::github_list_releases,
            commands::github::github_list_repos,
            commands::github::github_get_authenticated_user,
            commands::github::github_list_issues,
            commands::github::github_get_issue,
            commands::github::github_create_issue,
            commands::github::github_update_issue,
            commands::github::github_create_pr,
            commands::github::github_list_prs,
            commands::github::github_get_pr_diff,
            commands::github::github_investigate_issue,
            // v0.8-C issues interactive
            commands::github::github_list_issue_comments,
            commands::github::github_post_issue_comment,
            commands::github::github_close_issue,
            commands::github::github_reopen_issue,
            commands::github::github_set_issue_assignees,
            commands::github::github_set_issue_labels,
            commands::github::github_set_issue_milestone,
            commands::github::github_list_repo_labels,
            commands::github::github_list_repo_milestones,
            commands::github::github_create_repo_milestone,
            commands::github::github_list_repo_assignable_users,
            commands::github::github_list_issues_page,
            commands::github::github_list_prs_page,
            commands::github::github_list_repos_page,
            // v0.8-G pr modal upgrades
            commands::github::github_list_branches,
            commands::github::github_set_pr_reviewers,
            commands::github::github_set_pr_labels,
            commands::github::github_set_pr_milestone,
            // v0.8-E ai pr
            commands::github::github_ai_pr_description,
            commands::github::github_ai_pr_review,
            // v0.8-F ai digest
            commands::github::github_ai_catch_up,
            commands::github::github_ai_triage,
            // v0.8-A pr actions (re-shipped)
            commands::github::github_merge_pr,
            commands::github::github_close_pr,
            commands::github::github_reopen_pr,
            commands::github::github_convert_pr_to_draft,
            // v0.8-B ci checks (re-shipped)
            commands::github::github_get_pr_checks,
            // v0.8-13 pr review viewer
            commands::github::github_list_pr_reviews,
            commands::github::github_list_pr_review_comments,
            commands::github::github_post_pr_review_comment,
            commands::github::github_reply_to_pr_review_comment,
            // notifications inbox
            commands::github::github_list_notifications,
            commands::github::github_mark_notification_read,
            // Memory layer
            commands::memory::scan_codebase_memory,
            commands::memory::summarize_session,
            commands::memory::extract_patterns,
            commands::memory::summarize_flight,
            commands::project_memory::list_project_memory,
            commands::project_memory::create_project_memory,
            commands::project_memory::update_project_memory,
            commands::project_memory::archive_project_memory,
            commands::project_memory::watch_project_memory,
            // Prompt history
            commands::history::read_prompt_history,
            // Usage analytics
            commands::analytics::read_usage_analytics,
            // MCP server management
            commands::mcp::read_mcp_servers,
            commands::mcp::write_mcp_server,
            commands::mcp::delete_mcp_server,
            commands::mcp::diagnose_mcp_server,
            // Remote SSH repo clone (used by workspace creation)
            commands::git::clone_repo_remote,
            // Dictation / audio capture
            commands::dictation::list_audio_devices,
            commands::dictation::test_audio_device,
            commands::dictation::start_recording,
            commands::dictation::cancel_recording,
            commands::dictation::stop_recording,
            commands::dictation::deliver_dictation_text,
            commands::dictation::get_dictation_history,
            commands::dictation::search_dictation_history,
            commands::dictation::delete_dictation_entry,
            commands::dictation::clear_dictation_history,
            commands::dictation::get_dictation_analytics,
            commands::dictation::get_dictation_settings,
            commands::dictation::set_dictation_settings,
            commands::dictation::list_whisper_models,
            commands::dictation::download_whisper_model,
            commands::dictation::delete_whisper_model,
            // API keys
            commands::api_keys::set_api_key,
            commands::api_keys::get_api_key_exists,
            commands::api_keys::delete_api_key,
            commands::packet_agent::set_packet_agent_token,
            commands::packet_agent::get_packet_agent_token_exists,
            commands::packet_agent::delete_packet_agent_token,
            commands::packet_agent::packet_agent_request,
            commands::packet_agent_stream::start_packet_agent_stream,
            commands::packet_agent_stream::stop_packet_agent_stream,
            commands::monitor_windows::open_monitor_window,
            commands::monitor_windows::get_monitor_window_route,
            commands::monitor_windows::close_monitor_window,
            commands::monitor_windows::focus_monitor_route_in_main,
            // Provider auth status probe
            commands::provider_auth::get_provider_auth_status,
            commands::provider_auth::get_provider_auth_status_for_dir,
            commands::cli_account::seed_cli_account_config_dir,
            commands::provider_auth::sign_out_provider,
            // Local-only per-provider launch counter (Tier 4 slice B)
            commands::provider_stats::get_provider_launch_stats,
            // Ollama local model discovery
            commands::minimax::get_minimax_base_url,
            commands::minimax::set_minimax_base_url,
            commands::ollama::get_ollama_base_url,
            commands::ollama::set_ollama_base_url,
            commands::ollama::list_ollama_models,
            commands::ollama::get_ollama_runtime_options,
            commands::ollama::set_ollama_runtime_options,
            // Live per-provider model catalogs
            commands::provider_models::list_provider_models,
            // LM2 — custom OpenAI-compatible endpoint
            commands::custom_compat::get_custom_compat_base_url,
            commands::custom_compat::set_custom_compat_base_url,
            commands::custom_compat::get_custom_compat_models,
            commands::custom_compat::set_custom_compat_models,
            // API agent sessions
            commands::api_agent::start_api_agent_session,
            commands::api_agent::send_api_agent_message,
            commands::api_agent::cancel_api_agent_session,
            commands::api_agent::close_api_agent_session,
            commands::api_agent::change_model,
            commands::api_agent::set_plan_mode,
            commands::api_agent::set_permission_mode,
            commands::api_agent::respond_permission,
            commands::api_agent::set_approve_writes,
            commands::api_agent::respond_edit,
            commands::api_agent::retry_last_turn,
            commands::api_agent::cancel_pending_tools,
            // Agent conversation persistence
            commands::conversations::save_conversation,
            commands::conversations::load_conversations,
            commands::conversations::delete_conversation_file,
            commands::conversations::export_conversation_markdown,
            // Slash commands (user-defined)
            commands::slash_commands::list_slash_commands,
            // Skills (Claude-Code-style ~/.claude/skills/<name>/SKILL.md)
            commands::skills::list_skills,
            // Sidecar lifecycle status (for the status-bar chip)
            commands::agent_sidecar::get_sidecar_status,
            // N3 — PacketBench-as-MCP-server lifecycle
            mcp_server::mcp_server_start,
            mcp_server::mcp_server_stop,
            mcp_server::mcp_server_status,
            mcp_server::mcp_server_recent_activity,
            mcp_server::mcp_server_available_tools,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app_handle, event| {
            // Wait for actual destruction, after useCloseConfirm has either
            // found no live work or received confirmation. A read-only Monitor
            // must not keep the app and its agent processes alive without main.
            if matches!(
                &event,
                tauri::RunEvent::WindowEvent {
                    label,
                    event: tauri::WindowEvent::Destroyed,
                    ..
                } if label == "main"
            ) {
                app_handle.exit(0);
            }
            if let tauri::RunEvent::Exit = event {
                // Stop the PacketAgent SSE consumer tasks so their sockets
                // never outlive the window (PH6 clean-shutdown requirement).
                commands::packet_agent_stream::shutdown_on_exit(app_handle);
                // Reap PTY agent process trees BEFORE the sidecar: quitting the
                // app otherwise leaves every running `claude` / `codex` alive
                // and permanently unreachable — nothing in the app can find
                // them once this process is gone.
                if let Some(manager) = app_handle.try_state::<commands::pty::SharedPtyManager>() {
                    commands::pty::shutdown_pty_sessions(&manager);
                }
                if let Some(manager) = app_handle.try_state::<std::sync::Arc<SidecarManager>>() {
                    manager.shutdown();
                }
            }
        });
}
