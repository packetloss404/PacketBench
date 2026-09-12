//! `SidecarManager` — owns the child process, stdin writer channel, and the
//! set of sidecar-owned sessions. Implements spawn / restart / IO pumping.

use std::collections::{HashMap, HashSet};
use std::future::Future;
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
use std::sync::{Arc, Mutex as StdMutex};
use std::time::{Duration, Instant};

use serde_json::Value;
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_shell::process::CommandEvent;
use tauri_plugin_shell::ShellExt;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{ChildStderr, ChildStdin, Command};
use tokio::sync::{mpsc, oneshot, Mutex};
use tracing::{error, info, warn};

use super::events::{error_event, ErrorPayload};
use super::status::{
    current_time_rfc3339, load_lifetime_stats, save_lifetime_stats, SidecarState, SidecarStatus,
    SidecarStatusInner,
};
use super::{
    protocol_meets_floor, EXPECTED_PROTOCOL_VERSION, MAX_RESTARTS_IN_WINDOW,
    MINIMUM_PROTOCOL_VERSION, RESTART_WINDOW, SIDECAR_STATUS_EVENT,
};
use crate::commands::shared::hide_window_async;
use crate::commands::ssh_keys;
use crate::core::execution::{sh_quote, SshConfig};

#[cfg(test)]
#[path = "live_ssh_tests.rs"]
mod live_ssh_tests;

const REMOTE_SIDECAR_TIMEOUT_SECS: u64 = 25;
const SIDECAR_WRITER_CAPACITY: usize = 256;
const MAX_SIDECAR_STDOUT_LINE_BYTES: usize = 8 * 1024 * 1024;
const REMOTE_PATH_SETUP: &str = r#"export PATH="$HOME/.local/bin:$HOME/.npm-global/bin:$HOME/.cargo/bin:$HOME/.opencode/bin:$HOME/.nvm/versions/node/$(ls "$HOME/.nvm/versions/node/" 2>/dev/null | tail -1)/bin:/usr/local/bin:$PATH" 2>/dev/null;"#;
const SIDECAR_RESTART_RECOVERABLE_ERROR: &str =
    "Sidecar restarted — please resend your message to continue this conversation.";

/// No request (including its API key) may reach an SSH sidecar before this
/// succeeds. Keep the buffered reader for the event loop so bytes read ahead
/// with `ready` are not discarded.
async fn await_remote_handshake<R: tokio::io::AsyncBufRead + Unpin>(
    reader: &mut R,
) -> Result<(), String> {
    tokio::time::timeout(Duration::from_secs(REMOTE_SIDECAR_TIMEOUT_SECS), async {
        let mut buffer = Vec::new();
        loop {
            let line = read_capped_line(reader, &mut buffer)
                .await
                .map_err(|e| format!("SSH sidecar handshake failed: {e}"))?
                .ok_or_else(|| "SSH sidecar exited before its ready handshake".to_string())?;
            if line.trim().is_empty() {
                continue;
            }
            let ready: Value = serde_json::from_str(&line)
                .map_err(|_| "SSH sidecar sent an invalid ready handshake".to_string())?;
            let version = ready
                .get("protocolVersion")
                .and_then(Value::as_u64)
                .and_then(|v| u32::try_from(v).ok());
            if ready.get("type").and_then(Value::as_str) != Some("ready")
                || !protocol_meets_floor(version)
            {
                return Err(format!(
                    "SSH sidecar must advertise protocol v{MINIMUM_PROTOCOL_VERSION} or newer \
                     to enforce MCP and remote project trust. Update the sidecar on this host."
                ));
            }
            if version != Some(EXPECTED_PROTOCOL_VERSION) {
                warn!(expected = EXPECTED_PROTOCOL_VERSION, got = ?version,
                    "remote sidecar protocol version mismatch");
            }
            return Ok(());
        }
    })
    .await
    .map_err(|_| "Timed out waiting for SSH sidecar ready handshake".to_string())?
}

fn kill_process_tree(pid: u32, own_group: bool) {
    if pid <= 1 {
        return;
    }

    #[cfg(unix)]
    unsafe {
        let target = if own_group { -(pid as i32) } else { pid as i32 };
        if own_group {
            libc::kill(target, libc::SIGTERM);
        }
        libc::kill(target, libc::SIGKILL);
    }

    #[cfg(windows)]
    {
        let _ = own_group;
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        let _ = std::process::Command::new("taskkill")
            .args(["/T", "/F", "/PID", &pid.to_string()])
            .creation_flags(CREATE_NO_WINDOW)
            .status();
    }
}

#[derive(Clone)]
pub(super) struct RemoteSidecarSession {
    writer_tx: mpsc::Sender<String>,
    target_label: String,
}

/// Per-session waiter state for [`SidecarManager::wait_for_oneshot`].
///
/// Flight Planner E10-SUMMARIZE uses this to await a single-turn sidecar
/// session's completion from Rust code. The waiter accumulates `chunk` text
/// into `buffer` and gets resolved on the first terminal event (`done` →
/// `Ok(buffer)` / `error` → `Err(message)`).
///
/// Held inside `SidecarManager::oneshot_waiters` keyed by session id. The
/// entry is removed when the terminal event fires (or when the awaiter
/// times out / is dropped — best-effort cleanup happens on the next
/// terminal event for the same id).
pub(super) struct OneshotWaiter {
    /// Accumulated `chunk` text for this session. Drained when the
    /// terminal event resolves the waiter.
    pub buffer: String,
    /// One-shot completion channel. `Some(_)` while the awaiter is still
    /// waiting; `None` after the terminal event has fired (guards against
    /// double-resolution if both `done` and `error` race in pathological
    /// cases).
    pub sender: Option<oneshot::Sender<Result<String, String>>>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct ChildHandle {
    pid: u32,
    own_group: bool,
}

/// Provider + model recorded for a sidecar-owned session at start time, so
/// the `turn_summary` handler can price and attribute a usage-ledger row
/// without needing the session to be linked to a flight.
#[derive(Debug, Clone)]
pub(super) struct SessionUsageMeta {
    pub(super) provider: String,
    pub(super) model: String,
}

pub struct SidecarManager {
    pub(super) app_handle: AppHandle,
    /// Absolute path to the sidecar's `dist/index.js` entrypoint.
    sidecar_path: PathBuf,
    /// Sender for JSON lines destined for the sidecar's stdin.
    /// Held inside a Mutex so the writer can be swapped on respawn.
    writer_tx: Mutex<Option<mpsc::Sender<String>>>,
    /// Sessions we've started and not yet closed. Used by slice C's
    /// `owns_session()` check and to fan-out sidecar-crash errors.
    pub(super) owned_sessions: Arc<Mutex<HashSet<String>>>,
    /// Lifecycle status surfaced to the frontend (see `SidecarStatus`).
    status: Mutex<SidecarStatusInner>,
    /// E10-SUMMARIZE — per-session one-shot completion waiters. A caller
    /// that needs the full assistant response as a `String` (rather than
    /// the streamed-event firehose) registers a waiter via
    /// [`SidecarManager::wait_for_oneshot`] before `forward_start`, then
    /// awaits the returned `Result`. The chunk/done/error branches of
    /// `handle_event` resolve outstanding waiters.
    ///
    /// Sessions with no registered waiter incur a single hash-map lookup
    /// per event — zero behavioural change for the streaming path.
    pub(super) oneshot_waiters: Arc<Mutex<HashMap<String, OneshotWaiter>>>,
    /// Session ids whose provider is running over SSH. This remains set even
    /// during brief route teardown windows so a remote session can never fall
    /// back to the local sidecar process.
    pub(super) remote_owned_sessions: Arc<Mutex<HashSet<String>>>,
    /// SSH-backed sidecars keyed by session id. Local sidecar sessions keep
    /// using `writer_tx`; remote sessions get a dedicated SSH process so
    /// local and remote conversations cannot steal each other's stdin.
    pub(super) remote_sessions: Arc<Mutex<HashMap<String, RemoteSidecarSession>>>,
    /// E8-ACCUM — last-processed `turn_summary` sequence number plus the
    /// last-seen cumulative token snapshot per (session_id, address) for
    /// snapshot-semantics providers (openai-codex, whose `turn_summary`
    /// events carry session-cumulative running totals). The `turn_summary`
    /// handler uses this to roll only the delta up onto the owning Flight,
    /// and drops events whose sequence is older than the stored one so
    /// unordered rollup tasks can't misread a late-arriving older snapshot
    /// as a counter reset. Values are `(seq, [input, output, cache_read,
    /// cache_creation])`. Entries are dropped at every session-death
    /// cleanup site: [`Self::forget_owned_session`], the local crash
    /// fan-out ([`fan_out_crash_error_to_local_sessions`]), and the remote
    /// per-child wait task in [`Self::spawn_remote_sidecar_for_session`].
    pub(super) exec_token_snapshots: Arc<Mutex<HashMap<(String, String), (u64, [u64; 4])>>>,
    /// Usage-ledger metadata for sessions this supervisor started: the
    /// provider and model recorded by `forward_start` (model refreshed by
    /// `forward_set_model`). The `turn_summary` handler reads it to append
    /// `~/.packetbench/usage.jsonl` rows for sidecar sessions — including
    /// standalone chats that own no flight role, which have no other place
    /// their model is recorded. Entries are dropped at the same
    /// session-death cleanup sites as `exec_token_snapshots`.
    pub(super) session_usage_meta: Arc<Mutex<HashMap<String, SessionUsageMeta>>>,
    /// E8-ACCUM — monotonic stamp source for `exec_token_snapshots`
    /// sequence numbers. Incremented in `handle_event` for each
    /// `turn_summary` BEFORE the rollup task is spawned, so stamps reflect
    /// per-session arrival order even though the rollup tasks themselves
    /// complete in arbitrary order.
    pub(super) exec_turn_seq: AtomicU64,
    /// F7 — wire protocol version advertised by the local sidecar's most
    /// recent `ready` handshake. `0` means no handshake has completed yet.
    /// `forward_start` waits for this before sending a session, then refuses
    /// anything below [`super::MINIMUM_PROTOCOL_VERSION`].
    handshake_protocol: AtomicU32,
    /// Synchronous process bookkeeping used by the Tauri exit hook. These
    /// locks must remain usable after the async runtime begins shutting down.
    local_child: StdMutex<Option<ChildHandle>>,
    remote_children: Arc<StdMutex<HashMap<String, u32>>>,
    shutting_down: AtomicBool,
}

impl SidecarManager {
    /// Construct the manager, spawn the child, and start the IO tasks.
    /// Safe to call during `.setup()`; the child is spawned asynchronously.
    pub fn new(app_handle: AppHandle) -> Arc<Self> {
        let sidecar_path = resolve_sidecar_path(&app_handle);
        // Hydrate lifetime counters from disk before spawning. Missing /
        // corrupt file → defaults. Never fatal.
        let lifetime = load_lifetime_stats();
        let mut inner = SidecarStatusInner::default();
        inner.lifetime = lifetime;
        let manager = Arc::new(Self {
            app_handle,
            sidecar_path,
            writer_tx: Mutex::new(None),
            owned_sessions: Arc::new(Mutex::new(HashSet::new())),
            status: Mutex::new(inner),
            oneshot_waiters: Arc::new(Mutex::new(HashMap::new())),
            remote_owned_sessions: Arc::new(Mutex::new(HashSet::new())),
            remote_sessions: Arc::new(Mutex::new(HashMap::new())),
            exec_token_snapshots: Arc::new(Mutex::new(HashMap::new())),
            session_usage_meta: Arc::new(Mutex::new(HashMap::new())),
            exec_turn_seq: AtomicU64::new(0),
            handshake_protocol: AtomicU32::new(0),
            local_child: StdMutex::new(None),
            remote_children: Arc::new(StdMutex::new(HashMap::new())),
            shutting_down: AtomicBool::new(false),
        });

        // Spawn the child + reader/writer tasks in the background. If the
        // initial spawn fails we log and continue — the frontend won't notice
        // until someone actually tries to use a sidecar provider.
        let mgr = Arc::clone(&manager);
        tauri::async_runtime::spawn(async move {
            mgr.spawn_and_supervise().await;
        });

        manager
    }

    /// Check whether a session id was started via this supervisor. Slice C
    /// uses this to pick between the sidecar and the in-process runtime on
    /// `send_message` / `cancel` / `close` after the fact.
    pub async fn owns_session(&self, session_id: &str) -> bool {
        self.owned_sessions.lock().await.contains(session_id)
    }

    /// Stop local and SSH-backed sidecars synchronously while Tauri's exit
    /// event is still running. Process groups include Codex, MCP, and SSH
    /// grandchildren spawned by the sidecar.
    pub fn shutdown(&self) {
        self.shutting_down.store(true, Ordering::SeqCst);
        if let Some(child) = self.local_child.lock().unwrap().take() {
            kill_process_tree(child.pid, child.own_group);
        }
        let children = std::mem::take(&mut *self.remote_children.lock().unwrap());
        for (_, pid) in children {
            kill_process_tree(pid, true);
        }
    }

    pub(super) async fn forget_owned_session(&self, session_id: &str) {
        {
            let mut sessions = self.owned_sessions.lock().await;
            sessions.remove(session_id);
        }
        // Drop any executor-cost snapshot entries for this session so a
        // later session reusing the id can't inherit a stale baseline.
        self.exec_token_snapshots
            .lock()
            .await
            .retain(|(sid, _), _| sid != session_id);
        self.session_usage_meta.lock().await.remove(session_id);
    }

    /// E10-SUMMARIZE — register a one-shot completion waiter for
    /// `session_id` and return a future that resolves with the
    /// concatenated assistant text on `done`, or `Err(message)` on `error`.
    ///
    /// Intended for sessions whose entire conversation is a single
    /// request/response round-trip (e.g. flight-journal summarization).
    /// The caller is responsible for:
    ///   * Calling this **before** `forward_start` so the waiter is in
    ///     place before any chunks arrive (the registration is cheap and
    ///     synchronous-looking — just a `HashMap::insert`).
    ///   * Closing the session via `forward_close` after the future
    ///     resolves. The waiter does **not** close the session itself; it
    ///     only collects text.
    ///
    /// If a waiter for `session_id` already exists, the previous one is
    /// dropped (sender goes out of scope → previous awaiter sees
    /// `RecvError`). In practice each one-shot session id is a fresh UUID,
    /// so this never happens.
    #[allow(dead_code)]
    pub async fn wait_for_oneshot(
        self: &Arc<Self>,
        session_id: &str,
    ) -> oneshot::Receiver<Result<String, String>> {
        let (tx, rx) = oneshot::channel();
        let waiter = OneshotWaiter {
            buffer: String::new(),
            sender: Some(tx),
        };
        let mut guard = self.oneshot_waiters.lock().await;
        guard.insert(session_id.to_string(), waiter);
        rx
    }

    /// Return a snapshot of the current lifecycle status. Used by the
    /// `get_sidecar_status` Tauri command (the frontend polls this on mount
    /// before subscribing to `sidecar-status:changed`).
    pub async fn current_status(&self) -> SidecarStatus {
        let guard = self.status.lock().await;
        guard.snapshot()
    }

    /// F7 — record the protocol version from a local `ready` handshake. `0`
    /// means the sidecar answered without advertising one.
    pub(super) fn record_protocol_handshake(&self, version: u32) {
        self.handshake_protocol.store(version, Ordering::SeqCst);
    }

    /// Clear the recorded handshake. Called when the child dies so a restart
    /// re-negotiates instead of inheriting the dead process's version.
    pub(super) fn clear_protocol_handshake(&self) {
        self.handshake_protocol.store(0, Ordering::SeqCst);
    }

    /// F7 — emit `api-agent:error:*` on every owned local session. Used when
    /// the sidecar is alive but refused (protocol below the security floor),
    /// where the crash paths would otherwise never run.
    pub(super) async fn fail_owned_sessions(&self, message: &str) {
        self.fan_out_crash_error(message).await;
    }

    /// F7 — block a `start_session` unless the local sidecar has handshaken at
    /// or above [`MINIMUM_PROTOCOL_VERSION`].
    ///
    /// The wait exists because `writer_tx` is installed when the child spawns
    /// but `ready` lands a beat later; without it a session launched in that
    /// window would skip the check entirely. In practice the handshake is long
    /// since done — the local sidecar negotiates during app startup — so this
    /// returns on its first poll.
    async fn ensure_protocol_floor(&self) -> Result<(), String> {
        const HANDSHAKE_WAIT: Duration = Duration::from_secs(10);
        const POLL_INTERVAL: Duration = Duration::from_millis(50);

        let deadline = std::time::Instant::now() + HANDSHAKE_WAIT;
        loop {
            let advertised = self.handshake_protocol.load(Ordering::SeqCst);
            if advertised >= MINIMUM_PROTOCOL_VERSION {
                return Ok(());
            }
            if advertised > 0 {
                return Err(format!(
                    "The agent sidecar speaks protocol v{advertised}, but PacketBench requires \
                     v{MINIMUM_PROTOCOL_VERSION} or newer to enforce per-session MCP trust rules. \
                     Refusing to start this session. Reinstall PacketBench, or clear \
                     PACKETBENCH_SIDECAR_PATH if you set it."
                ));
            }
            let state_is_terminal = {
                let guard = self.status.lock().await;
                matches!(guard.state, SidecarState::Down | SidecarState::Incompatible)
            };
            if state_is_terminal {
                return Err(
                    "The agent sidecar is not running, so PacketBench cannot verify it enforces \
                     per-session MCP trust rules. Refusing to start this session."
                        .to_string(),
                );
            }
            if std::time::Instant::now() >= deadline {
                return Err(
                    "The agent sidecar did not complete its protocol handshake in time, so \
                     PacketBench cannot verify it enforces per-session MCP trust rules. Refusing \
                     to start this session."
                        .to_string(),
                );
            }
            tokio::time::sleep(POLL_INTERVAL).await;
        }
    }

    /// Public seam for `protocol.rs`'s `forward_start_inner`.
    pub(super) async fn assert_protocol_floor(&self) -> Result<(), String> {
        self.ensure_protocol_floor().await
    }

    // -----------------------------------------------------------------------
    // Internals
    // -----------------------------------------------------------------------

    /// Apply a status mutation under the lock and emit
    /// `sidecar-status:changed` with the new snapshot. All transitions go
    /// through here so we never forget to emit.
    ///
    /// Persists `lifetime` to `~/.packetbench/sidecar-stats.json` on every
    /// call. The write is cheap (the struct serializes to a few hundred
    /// bytes), atomic via `.tmp` + rename, and best-effort — failures are
    /// logged but do not block the emit.
    pub(super) async fn update_status(&self, mutate: impl FnOnce(&mut SidecarStatusInner)) {
        let (snapshot, lifetime) = {
            let mut guard = self.status.lock().await;
            mutate(&mut guard);
            (guard.snapshot(), guard.lifetime.clone())
        };
        if let Err(e) = save_lifetime_stats(&lifetime) {
            warn!(error = %e, "failed to persist sidecar lifetime stats");
        }
        let _ = self.app_handle.emit(SIDECAR_STATUS_EVENT, snapshot);
    }

    /// Serialize `value` as a JSON line and push it onto the writer channel.
    pub(super) async fn send_json(&self, value: Value) -> Result<(), String> {
        let line = serde_json::to_string(&value)
            .map_err(|e| format!("serialize sidecar request: {}", e))?;
        let tx = {
            let guard = self.writer_tx.lock().await;
            guard.clone()
        };
        let tx = tx.ok_or_else(|| "sidecar writer not initialized".to_string())?;
        tx.send(line)
            .await
            .map_err(|_| "sidecar writer channel closed".to_string())?;
        Ok(())
    }

    /// Serialize `value` and route it to the sidecar stream that owns
    /// `session_id`. SSH sessions get their dedicated process; all other
    /// sessions fall back to the app-wide local sidecar writer.
    pub(super) async fn send_json_for_session(
        &self,
        session_id: &str,
        value: Value,
    ) -> Result<(), String> {
        let remote = {
            let guard = self.remote_sessions.lock().await;
            guard.get(session_id).cloned()
        };
        if let Some(remote) = remote {
            let line = serde_json::to_string(&value)
                .map_err(|e| format!("serialize remote sidecar request: {}", e))?;
            remote
                .writer_tx
                .send(line)
                .await
                .map_err(|_| format!("remote sidecar writer closed for {}", remote.target_label))?;
            return Ok(());
        }

        let is_remote_owned = {
            let guard = self.remote_owned_sessions.lock().await;
            guard.contains(session_id)
        };
        if is_remote_owned {
            return Err(format!(
                "Remote sidecar route is unavailable for session {}",
                session_id
            ));
        }

        self.send_json(value).await
    }

    pub(super) async fn close_remote_session(&self, session_id: &str) {
        let removed = {
            let mut guard = self.remote_sessions.lock().await;
            guard.remove(session_id)
        };
        if let Some(remote) = removed {
            info!(
                session_id = %session_id,
                target = %remote.target_label,
                "closed SSH sidecar route"
            );
            drop(remote);
        }
        let mut remote_owned = self.remote_owned_sessions.lock().await;
        remote_owned.remove(session_id);
    }

    /// Spawn a dedicated Node sidecar through SSH for one remote API-agent
    /// session. The remote host must be Unix-like, have Node.js on PATH (or
    /// `PACKETBENCH_REMOTE_NODE_PATH` set in this PacketBench process), and have
    /// the built sidecar available at
    /// `~/.packetbench/agent-sidecar/dist/index.js` (or
    /// `PACKETBENCH_REMOTE_SIDECAR_PATH` set in this PacketBench process).
    pub(super) fn spawn_remote_sidecar_for_session<'a>(
        &'a self,
        session_id: &'a str,
        provider: &'a str,
        config: &'a SshConfig,
    ) -> Pin<Box<dyn Future<Output = Result<(), String>> + Send + 'a>> {
        Box::pin(async move {
            if self.shutting_down.load(Ordering::SeqCst) {
                return Err("Sidecar manager is shutting down".to_string());
            }
            validate_remote_sidecar_target(config)?;
            reject_remote_password_auth(config)?;
            remote_sidecar_preflight(config, provider.as_ref()).await?;

            let mut cmd = Command::new("ssh");
            cmd.args(config.ssh_args(false))
                .arg(remote_sidecar_launch_script(config))
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .stderr(Stdio::piped())
                .kill_on_drop(true);
            hide_window_async(&mut cmd);
            #[cfg(unix)]
            cmd.process_group(0);

            let mut child = cmd.spawn().map_err(|e| {
                format!(
                    "Failed to spawn SSH sidecar for {}: {}",
                    remote_target_label(config),
                    e
                )
            })?;
            let child_pid = child.id();
            if let Some(pid) = child_pid {
                self.remote_children
                    .lock()
                    .unwrap()
                    .insert(session_id.to_string(), pid);
                if self.shutting_down.load(Ordering::SeqCst) {
                    self.remote_children.lock().unwrap().remove(session_id);
                    kill_process_tree(pid, true);
                    return Err("Sidecar manager is shutting down".to_string());
                }
            }

            let stdin = child
                .stdin
                .take()
                .ok_or_else(|| "SSH sidecar stdin was not piped".to_string())?;
            let stdout = child
                .stdout
                .take()
                .ok_or_else(|| "SSH sidecar stdout was not piped".to_string())?;
            let stderr = child
                .stderr
                .take()
                .ok_or_else(|| "SSH sidecar stderr was not piped".to_string())?;

            let stderr_handle = tokio::spawn(stderr_loop(stderr));
            let mut stdout = BufReader::new(stdout);
            if let Err(message) = await_remote_handshake(&mut stdout).await {
                if let Some(pid) = child_pid {
                    kill_process_tree(pid, true);
                }
                let _ = child.wait().await;
                self.remote_children.lock().unwrap().remove(session_id);
                stderr_handle.abort();
                return Err(message);
            }
            let (writer_tx, writer_rx) = mpsc::channel::<String>(SIDECAR_WRITER_CAPACITY);
            let target_label = remote_target_label(config);
            {
                let mut remote_owned = self.remote_owned_sessions.lock().await;
                remote_owned.insert(session_id.to_string());
            }
            {
                let mut guard = self.remote_sessions.lock().await;
                guard.insert(
                    session_id.to_string(),
                    RemoteSidecarSession {
                        writer_tx,
                        target_label: target_label.clone(),
                    },
                );
            }

            let writer_handle = tokio::spawn(writer_loop(stdin, writer_rx));
            let reader_mgr = self
                .app_handle
                .try_state::<Arc<SidecarManager>>()
                .map(|state| state.inner().clone())
                .ok_or_else(|| "SidecarManager state is unavailable".to_string())?;
            let reader_session_id = session_id.to_string();
            let reader_handle = tokio::spawn(async move {
                let reader_future: std::pin::Pin<Box<dyn std::future::Future<Output = ()> + Send>> =
                    Box::pin(reader_mgr.remote_reader_loop(reader_session_id, stdout));
                reader_future.await;
            });

            info!(
                session_id = %session_id,
                pid = ?child_pid,
                target = %target_label,
                "SSH sidecar spawned"
            );

            let session_for_wait = session_id.to_string();
            let target_for_wait = target_label.clone();
            let remote_sessions = Arc::clone(&self.remote_sessions);
            let remote_children = Arc::clone(&self.remote_children);
            let owned_sessions = Arc::clone(&self.owned_sessions);
            let remote_owned_sessions = Arc::clone(&self.remote_owned_sessions);
            let oneshot_waiters = Arc::clone(&self.oneshot_waiters);
            let exec_token_snapshots = Arc::clone(&self.exec_token_snapshots);
            let session_usage_meta = Arc::clone(&self.session_usage_meta);
            let app_handle = self.app_handle.clone();
            tokio::spawn(async move {
                let status = child.wait().await;
                {
                    let mut guard = remote_sessions.lock().await;
                    guard.remove(&session_for_wait);
                }
                remote_children.lock().unwrap().remove(&session_for_wait);

                let still_owned = {
                    let mut guard = owned_sessions.lock().await;
                    guard.remove(&session_for_wait)
                };
                {
                    let mut guard = remote_owned_sessions.lock().await;
                    guard.remove(&session_for_wait);
                };
                // This cleanup path bypasses forget_owned_session, so drop
                // any executor-cost snapshot baselines here too — a later
                // session reusing the id must not inherit a stale baseline.
                exec_token_snapshots
                    .lock()
                    .await
                    .retain(|(sid, _), _| sid != &session_for_wait);
                session_usage_meta.lock().await.remove(&session_for_wait);
                let message = match status {
                    Ok(exit) if exit.success() => {
                        format!("SSH sidecar for {} exited", target_for_wait)
                    }
                    Ok(exit) => format!("SSH sidecar for {} exited with {}", target_for_wait, exit),
                    Err(e) => format!("SSH sidecar for {} wait failed: {}", target_for_wait, e),
                };
                if still_owned {
                    warn!(session_id = %session_for_wait, error = %message);
                    let _ = app_handle.emit(
                        &error_event(&session_for_wait),
                        ErrorPayload {
                            message: message.clone(),
                        },
                    );
                    let mut waiters = oneshot_waiters.lock().await;
                    if let Some(mut waiter) = waiters.remove(&session_for_wait) {
                        if let Some(sender) = waiter.sender.take() {
                            let _ = sender.send(Err(message.clone()));
                        }
                    }
                } else {
                    info!(session_id = %session_for_wait, target = %target_for_wait, %message);
                }

                let _ = reader_handle.await;
                let _ = stderr_handle.await;
                let _ = writer_handle.await;
            });

            Ok(())
        })
    }

    /// Spawn-and-supervise loop. Runs the child, then restarts it if it dies,
    /// subject to the rate limit. If the rate limit is exceeded we fan-out
    /// errors to all owned sessions and stop trying.
    async fn spawn_and_supervise(self: Arc<Self>) {
        let mut restart_times: Vec<Instant> = Vec::new();

        loop {
            if self.shutting_down.load(Ordering::SeqCst) {
                return;
            }
            match self.spawn_child().await {
                Ok(()) => {
                    // spawn_child returned because the child exited cleanly or
                    // died. Fall through to restart logic.
                    warn!("agent sidecar exited — considering restart");
                    let now_rfc3339 = current_time_rfc3339();
                    self.update_status(|s| {
                        // If the child had been ready, an unexpected exit
                        // without a recorded error still deserves *some*
                        // breadcrumb for the status chip's tooltip.
                        if s.last_error.is_none() && s.state == SidecarState::Ready {
                            s.last_error = Some("Sidecar exited unexpectedly".to_string());
                        }
                        s.pid = None;
                        // Lifetime bookkeeping: count the crash, remember the
                        // error for future sessions, and fold the just-ended
                        // uptime window into the cumulative total.
                        s.lifetime.total_crashes = s.lifetime.total_crashes.saturating_add(1);
                        s.lifetime.last_crash_time = Some(now_rfc3339.clone());
                        s.lifetime.last_error = s.last_error.clone();
                        if let Some(start) = s.session_start.take() {
                            let secs = start.elapsed().as_secs();
                            s.lifetime.total_uptime_secs =
                                s.lifetime.total_uptime_secs.saturating_add(secs);
                        }
                    })
                    .await;
                }
                Err(e) => {
                    error!(error = %e, "failed to spawn agent sidecar");
                    let msg = e.clone();
                    let now_rfc3339 = current_time_rfc3339();
                    self.update_status(|s| {
                        s.last_error = Some(msg.clone());
                        s.pid = None;
                        // Treat a spawn failure as a crash for lifetime
                        // purposes — it's the same user-visible outcome.
                        s.lifetime.total_crashes = s.lifetime.total_crashes.saturating_add(1);
                        s.lifetime.last_crash_time = Some(now_rfc3339.clone());
                        s.lifetime.last_error = Some(msg);
                        if let Some(start) = s.session_start.take() {
                            let secs = start.elapsed().as_secs();
                            s.lifetime.total_uptime_secs =
                                s.lifetime.total_uptime_secs.saturating_add(secs);
                        }
                    })
                    .await;
                }
            }

            // The child is gone. Whether or not we're going to restart, the
            // respawned Node process has no memory of the sessions this one was
            // serving — so any in-flight owned session is now stranded
            // mid-stream and later messages would get "No active session".
            // Tell the frontend to restart those conversations and clear our
            // local ownership set / resolve any oneshot waiters. The give-up
            // branch below re-runs this with the terminal message; because this
            // clears `owned_sessions`, that second call finds nothing left to
            // emit (no double-emission).
            self.fan_out_crash_error(SIDECAR_RESTART_RECOVERABLE_ERROR)
                .await;

            // F7: the dead child's negotiated version says nothing about the
            // one we are about to spawn. Re-negotiate from scratch.
            self.clear_protocol_handshake();

            // Prune restart times outside the window, then check the rate limit.
            let now = Instant::now();
            restart_times.retain(|t| now.duration_since(*t) < RESTART_WINDOW);
            if restart_times.len() >= MAX_RESTARTS_IN_WINDOW {
                error!(
                    "agent sidecar exceeded {} restarts in {:?}; giving up",
                    MAX_RESTARTS_IN_WINDOW, RESTART_WINDOW
                );
                self.fan_out_crash_error("Sidecar crashed and could not restart")
                    .await;
                // Clear the writer channel so future forward_* calls fail fast
                // with a clear error.
                {
                    let mut guard = self.writer_tx.lock().await;
                    *guard = None;
                }
                self.update_status(|s| {
                    s.state = SidecarState::Down;
                    s.pid = None;
                    if s.last_error.is_none() {
                        s.last_error = Some(format!(
                            "Sidecar exceeded {} restarts in {:?}",
                            MAX_RESTARTS_IN_WINDOW, RESTART_WINDOW
                        ));
                    }
                })
                .await;
                return;
            }
            restart_times.push(now);

            // About to retry — flip to "restarting" and bump the lifetime
            // counter. The chip will show `restarting (N/3)`.
            self.update_status(|s| {
                s.state = SidecarState::Restarting;
                s.restart_count = s.restart_count.saturating_add(1);
                s.pid = None;
            })
            .await;

            // Small backoff before retry.
            tokio::time::sleep(Duration::from_millis(500)).await;
        }
    }

    /// Spawn the Node child and drive IO until it exits. Returns Ok when the
    /// child is gone (so the supervisor can decide whether to restart).
    ///
    /// Dispatches to one of two spawn strategies:
    /// - Tokio `tokio::process::Command` when a system `node` / explicit
    ///   `PACKETBENCH_NODE_PATH` should be used (dev default, or anywhere the
    ///   env override is set).
    /// - Tauri shell plugin's sidecar API (`app.shell().sidecar("node")`) in
    ///   release, so the bundled Node binary is used.
    async fn spawn_child(self: &Arc<Self>) -> Result<(), String> {
        if !self.sidecar_path.exists() {
            return Err(format!(
                "sidecar entry not found at {} — reinstall the app or set PACKETBENCH_SIDECAR_PATH",
                self.sidecar_path.display()
            ));
        }

        if let Some(node_path) = resolved_node_override() {
            // Explicit override — always use tokio::process with that exe.
            self.spawn_via_tokio(Some(node_path)).await
        } else if cfg!(debug_assertions) {
            // Dev: system `node` on PATH.
            self.spawn_via_tokio(None).await
        } else if let Some(node_path) = resolve_bundled_node_path(&self.app_handle) {
            // Release/standalone: prefer the colocated bundled Node binary
            // with the Tokio path. The shell plugin's sidecar resolver works
            // in installed bundles, but can fail for direct
            // `target/release/packetbench.exe` launches even when build.rs has
            // copied Node beside the executable.
            self.spawn_via_tokio(Some(node_path)).await
        } else {
            // Release fallback: Tauri-bundled Node via the shell plugin
            // sidecar API.
            self.spawn_via_shell_sidecar().await
        }
    }

    /// Spawn the sidecar via `tokio::process::Command`. Used in dev and when
    /// `PACKETBENCH_NODE_PATH` is set.
    async fn spawn_via_tokio(
        self: &Arc<Self>,
        node_override: Option<PathBuf>,
    ) -> Result<(), String> {
        let node_exe: PathBuf = node_override.unwrap_or_else(|| PathBuf::from("node"));
        let sidecar_arg = node_compatible_path(&self.sidecar_path);
        let mut cmd = Command::new(&node_exe);
        cmd.arg(&sidecar_arg)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        hide_window_async(&mut cmd);
        #[cfg(unix)]
        cmd.process_group(0);

        let mut child = cmd.spawn().map_err(|e| {
            format!(
                "spawn node sidecar (node={}, entry={}): {}",
                node_exe.display(),
                sidecar_arg.display(),
                e
            )
        })?;

        let child_pid = child.id();
        if let Some(pid) = child_pid {
            *self.local_child.lock().unwrap() = Some(ChildHandle {
                pid,
                own_group: cfg!(unix),
            });
            if self.shutting_down.load(Ordering::SeqCst) {
                self.local_child.lock().unwrap().take();
                kill_process_tree(pid, cfg!(unix));
            }
        }
        info!(
            pid = ?child_pid,
            node = %node_exe.display(),
            path = %sidecar_arg.display(),
            strategy = "tokio",
            "agent sidecar spawned"
        );

        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| "sidecar stdin was not piped".to_string())?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| "sidecar stdout was not piped".to_string())?;
        let stderr = child
            .stderr
            .take()
            .ok_or_else(|| "sidecar stderr was not piped".to_string())?;

        // Writer task: pull lines from an mpsc channel, append '\n', write.
        let (writer_tx, writer_rx) = mpsc::channel::<String>(SIDECAR_WRITER_CAPACITY);
        {
            let mut guard = self.writer_tx.lock().await;
            *guard = Some(writer_tx);
        }
        let writer_handle = tokio::spawn(writer_loop(stdin, writer_rx));

        // Reader task: buffered line reader, parse JSON, emit events.
        let reader_mgr = Arc::clone(self);
        let reader_handle = tokio::spawn(async move {
            reader_mgr.reader_loop(stdout).await;
        });
        let stderr_handle = tokio::spawn(stderr_loop(stderr));

        // Wait for the child to exit.
        let status = match child.wait().await {
            Ok(s) => s,
            Err(e) => {
                warn!(error = %e, "agent sidecar wait() failed");
                // Kill the IO tasks by dropping the writer channel.
                let mut guard = self.writer_tx.lock().await;
                *guard = None;
                *self.local_child.lock().unwrap() = None;
                return Ok(());
            }
        };
        *self.local_child.lock().unwrap() = None;

        warn!(?status, pid = ?child_pid, "agent sidecar exited");
        if !status.success() {
            let message = format!("Sidecar exited with {}", status);
            self.update_status(|s| {
                if s.last_error.is_none() {
                    s.last_error = Some(message);
                }
            })
            .await;
        }

        // Drop the writer channel so the writer task winds down.
        {
            let mut guard = self.writer_tx.lock().await;
            *guard = None;
        }

        // Reader task will end on its own once stdout hits EOF.
        let _ = reader_handle.await;
        let _ = stderr_handle.await;
        let _ = writer_handle.await;

        Ok(())
    }

    /// Spawn the sidecar via the Tauri shell plugin's sidecar API, which
    /// resolves `node` to the app-bundled binary declared in
    /// `tauri.conf.json > bundle.externalBin` (see slice B). Used in release.
    async fn spawn_via_shell_sidecar(self: &Arc<Self>) -> Result<(), String> {
        let sidecar_arg = node_compatible_path(&self.sidecar_path);
        let command = self
            .app_handle
            .shell()
            .sidecar("node")
            .map_err(|e| format!("resolve bundled node sidecar: {}", e))?
            .arg(&sidecar_arg);

        let (mut rx, mut child) = command
            .spawn()
            .map_err(|e| format!("spawn bundled node sidecar: {}", e))?;

        let child_pid = child.pid();
        *self.local_child.lock().unwrap() = Some(ChildHandle {
            pid: child_pid,
            own_group: false,
        });
        if self.shutting_down.load(Ordering::SeqCst) {
            self.local_child.lock().unwrap().take();
            kill_process_tree(child_pid, false);
        }
        info!(
            pid = child_pid,
            path = %sidecar_arg.display(),
            strategy = "shell-sidecar",
            "agent sidecar spawned"
        );

        // Writer task: pull lines from an mpsc channel, append '\n', write
        // them via `CommandChild::write`. The shell plugin's CommandChild does
        // not expose a raw `ChildStdin`; it wraps a synchronous PipeWriter.
        // We move the child into the writer task so it can be mutated there;
        // to let the reader still observe terminate-on-exit, we use the
        // Terminated event from the event channel rather than `child.wait()`.
        let (writer_tx, mut writer_rx) = mpsc::channel::<String>(SIDECAR_WRITER_CAPACITY);
        {
            let mut guard = self.writer_tx.lock().await;
            *guard = Some(writer_tx);
        }

        let writer_handle = tokio::spawn(async move {
            while let Some(line) = writer_rx.recv().await {
                let mut buf = line.into_bytes();
                buf.push(b'\n');
                if let Err(e) = child.write(&buf) {
                    warn!(error = %e, "agent sidecar stdin write failed");
                    break;
                }
            }
            // Channel closed — try to kill the child so the reader task can
            // observe termination and return.
            let _ = child.kill();
        });

        // Reader task: pump events from the shell plugin channel into the
        // same `handle_event` / stderr logging pipeline as the tokio path.
        let reader_mgr = Arc::clone(self);
        let reader_handle = tokio::spawn(async move {
            while let Some(event) = rx.recv().await {
                match event {
                    CommandEvent::Stdout(bytes) => {
                        if bytes.len() > MAX_SIDECAR_STDOUT_LINE_BYTES {
                            warn!(
                                bytes = bytes.len(),
                                limit = MAX_SIDECAR_STDOUT_LINE_BYTES,
                                "agent sidecar stdout record exceeded limit"
                            );
                            break;
                        }
                        // The shell plugin delivers already line-split bytes
                        // (one event per newline) when raw_out is false.
                        let line = String::from_utf8_lossy(&bytes);
                        let trimmed = line.trim();
                        if trimmed.is_empty() {
                            continue;
                        }
                        match serde_json::from_str::<Value>(trimmed) {
                            Ok(value) => reader_mgr.handle_event(value).await,
                            Err(e) => {
                                warn!(
                                    error = %e,
                                    line = %super::handler::truncate(trimmed, 500),
                                    "agent sidecar emitted malformed JSON"
                                );
                            }
                        }
                    }
                    CommandEvent::Stderr(bytes) => {
                        // Mirror the tokio path's `Stdio::inherit()` behavior
                        // by surfacing stderr to our tracing sink. The shell
                        // plugin forces stderr to be piped, so we must drain.
                        let line = String::from_utf8_lossy(&bytes);
                        let trimmed = line.trim_end();
                        if !trimmed.is_empty() {
                            warn!(target: "agent_sidecar::stderr", "{}", trimmed);
                        }
                    }
                    CommandEvent::Error(e) => {
                        warn!(error = %e, "agent sidecar shell command error");
                    }
                    CommandEvent::Terminated(payload) => {
                        warn!(
                            code = ?payload.code,
                            signal = ?payload.signal,
                            pid = child_pid,
                            "agent sidecar exited"
                        );
                        if payload.code != Some(0) {
                            let message = match payload.code {
                                Some(code) => format!("Sidecar exited with code {}", code),
                                None => "Sidecar exited unexpectedly".to_string(),
                            };
                            reader_mgr
                                .update_status(|s| {
                                    if s.last_error.is_none() {
                                        s.last_error = Some(message);
                                    }
                                })
                                .await;
                        }
                        break;
                    }
                    _ => {}
                }
            }
        });

        // The reader task returns when the sidecar terminates; once that
        // happens we drop the writer channel so the writer task joins and
        // the supervisor can decide whether to restart.
        let _ = reader_handle.await;
        *self.local_child.lock().unwrap() = None;
        {
            let mut guard = self.writer_tx.lock().await;
            *guard = None;
        }
        let _ = writer_handle.await;

        Ok(())
    }

    /// Consume lines from the sidecar's stdout, parse each as JSON, and emit
    /// the corresponding `api-agent:*` event.
    async fn reader_loop(self: Arc<Self>, stdout: tokio::process::ChildStdout) {
        let mut reader = BufReader::new(stdout);
        let mut buffer = Vec::new();
        loop {
            match read_capped_line(&mut reader, &mut buffer).await {
                Ok(Some(line)) => {
                    if line.trim().is_empty() {
                        continue;
                    }
                    match serde_json::from_str::<Value>(&line) {
                        Ok(value) => self.handle_event(value).await,
                        Err(e) => {
                            warn!(
                                error = %e,
                                line = %super::handler::truncate(&line, 500),
                                "agent sidecar emitted malformed JSON"
                            );
                        }
                    }
                }
                Ok(None) => {
                    // EOF on stdout — the child has closed its side.
                    break;
                }
                Err(e) => {
                    warn!(
                        error = %e,
                        "agent sidecar stdout read error — killing sidecar so the supervisor can restart it"
                    );
                    // The protocol stream is unusable (oversized record,
                    // invalid UTF-8, or a pipe I/O failure). Breaking alone
                    // would leave the child alive with nobody reading its
                    // stdout: `child.wait()` in spawn_via_tokio never
                    // returns, no crash fan-out fires, the status chip stays
                    // Ready, and every session freezes silently. Kill the
                    // child so wait() unblocks and the run loop's existing
                    // crash-error fan-out + restart machinery takes over.
                    if let Some(child) = self.local_child.lock().unwrap().take() {
                        kill_process_tree(child.pid, child.own_group);
                    }
                    break;
                }
            }
        }
    }

    /// Remote sidecars are per-session transports. Their `ready` handshake is
    /// useful for protocol diagnostics, but it should not mutate the app-wide
    /// local sidecar status chip or lifetime counters.
    async fn remote_reader_loop(
        self: Arc<Self>,
        session_id: String,
        mut reader: BufReader<tokio::process::ChildStdout>,
    ) {
        let mut buffer = Vec::new();
        loop {
            match read_capped_line(&mut reader, &mut buffer).await {
                Ok(Some(line)) => {
                    if line.trim().is_empty() {
                        continue;
                    }
                    match serde_json::from_str::<Value>(&line) {
                        Ok(value) => {
                            let event_type =
                                value.get("type").and_then(|v| v.as_str()).unwrap_or("");
                            if event_type == "ready" {
                                let protocol_version = value
                                    .get("protocolVersion")
                                    .and_then(|v| v.as_u64())
                                    .map(|v| v as u32);
                                if let Some(proto) = protocol_version {
                                    if proto != EXPECTED_PROTOCOL_VERSION {
                                        warn!(
                                            session_id = %session_id,
                                            expected = EXPECTED_PROTOCOL_VERSION,
                                            got = proto,
                                            "remote sidecar protocol version mismatch"
                                        );
                                    }
                                }
                                info!(
                                    session_id = %session_id,
                                    version = ?value.get("version").and_then(|v| v.as_str()),
                                    protocol_version = ?protocol_version,
                                    "remote sidecar ready"
                                );
                                // The initial handshake was checked before
                                // sending start_session. Reject a later ready
                                // event too if it advertises a downgraded peer.
                                if !protocol_meets_floor(protocol_version) {
                                    let message = format!(
                                        "The sidecar on this SSH host speaks protocol {}, but \
                                         PacketBench requires v{} or newer to enforce per-session \
                                         MCP trust rules. This session was stopped. Update \
                                         PacketBench on the remote host.",
                                        protocol_version
                                            .map(|p| format!("v{p}"))
                                            .unwrap_or_else(|| "an unknown version".to_string()),
                                        MINIMUM_PROTOCOL_VERSION,
                                    );
                                    error!(
                                        session_id = %session_id,
                                        minimum = MINIMUM_PROTOCOL_VERSION,
                                        got = ?protocol_version,
                                        "refusing remote sidecar below the protocol security floor"
                                    );
                                    let _ = self.app_handle.emit(
                                        &error_event(&session_id),
                                        ErrorPayload {
                                            message: message.clone(),
                                        },
                                    );
                                    self.forget_owned_session(&session_id).await;
                                    self.close_remote_session(&session_id).await;
                                    let mut waiters = self.oneshot_waiters.lock().await;
                                    if let Some(mut waiter) = waiters.remove(&session_id) {
                                        if let Some(sender) = waiter.sender.take() {
                                            let _ = sender.send(Err(message));
                                        }
                                    }
                                    return;
                                }
                                continue;
                            }
                            if event_type == "error" {
                                let message = value
                                    .get("message")
                                    .and_then(|v| v.as_str())
                                    .unwrap_or("unknown remote sidecar error")
                                    .to_string();
                                let _ = self.app_handle.emit(
                                    &error_event(&session_id),
                                    ErrorPayload {
                                        message: message.clone(),
                                    },
                                );
                                // Per-turn errors are recoverable — keep
                                // session ownership and the SSH route alive
                                // so the user can resend/retry (mirrors the
                                // "error" arm in handler.rs). Process death
                                // is handled by the detached wait task in
                                // `spawn_remote_sidecar_for_session`; user
                                // close goes through forward_close.
                                let mut waiters = self.oneshot_waiters.lock().await;
                                if let Some(mut waiter) = waiters.remove(&session_id) {
                                    if let Some(sender) = waiter.sender.take() {
                                        let _ = sender.send(Err(message));
                                    }
                                }
                                continue;
                            }
                            self.handle_event(value).await;
                        }
                        Err(e) => {
                            warn!(
                                error = %e,
                                line = %super::handler::truncate(&line, 500),
                                "remote sidecar emitted malformed JSON"
                            );
                        }
                    }
                }
                Ok(None) => break,
                Err(e) => {
                    warn!(
                        session_id = %session_id,
                        error = %e,
                        "remote sidecar stdout read error — killing remote sidecar"
                    );
                    // Same rationale as `reader_loop`: the stream is
                    // unusable, so kill the SSH child instead of leaving it
                    // running unread. Bookkeeping removal and the api-agent
                    // error emission are handled by the detached per-child
                    // wait task in `spawn_remote_sidecar_for_session`, which
                    // fires once the killed child exits.
                    let pid = self
                        .remote_children
                        .lock()
                        .unwrap()
                        .get(&session_id)
                        .copied();
                    if let Some(pid) = pid {
                        kill_process_tree(pid, true);
                    }
                    break;
                }
            }
        }
    }

    /// Emit `api-agent:error:*` on every currently-owned **local** session,
    /// clear those sessions, and resolve any outstanding one-shot waiters with
    /// the same `message`. Remote (SSH-backed) sessions are left untouched —
    /// they have their own dedicated process and exit handling.
    ///
    /// Called on every local-sidecar child exit (with a recoverable message so
    /// the frontend can restart those conversations against the freshly
    /// respawned process, which has no memory of prior sessions) and again in
    /// the give-up branch (with the terminal message). Because this clears
    /// `owned_sessions`, the second call after a restart-loop exhaustion finds
    /// nothing left to emit, so there is no double-emission.
    async fn fan_out_crash_error(&self, message: &str) {
        fan_out_crash_error_to_local_sessions(
            &self.owned_sessions,
            &self.remote_owned_sessions,
            &self.oneshot_waiters,
            &self.exec_token_snapshots,
            &self.session_usage_meta,
            message,
            |event, payload| {
                let _ = self.app_handle.emit(&event, payload);
            },
        )
        .await;
    }
}

async fn fan_out_crash_error_to_local_sessions<F>(
    owned_sessions: &Arc<Mutex<HashSet<String>>>,
    remote_owned_sessions: &Arc<Mutex<HashSet<String>>>,
    oneshot_waiters: &Arc<Mutex<HashMap<String, OneshotWaiter>>>,
    exec_token_snapshots: &Arc<Mutex<HashMap<(String, String), (u64, [u64; 4])>>>,
    session_usage_meta: &Arc<Mutex<HashMap<String, SessionUsageMeta>>>,
    message: &str,
    mut emit_error: F,
) where
    F: FnMut(String, ErrorPayload) + Send,
{
    let remote_owned: HashSet<String> = {
        let guard = remote_owned_sessions.lock().await;
        guard.iter().cloned().collect()
    };
    let sessions: Vec<String> = {
        let guard = owned_sessions.lock().await;
        guard
            .iter()
            .filter(|session_id| !remote_owned.contains(*session_id))
            .cloned()
            .collect()
    };
    if sessions.is_empty() {
        return;
    }
    for session_id in &sessions {
        emit_error(
            error_event(session_id),
            ErrorPayload {
                message: message.to_string(),
            },
        );
    }
    drop(emit_error);

    let mut guard = owned_sessions.lock().await;
    guard.retain(|session_id| remote_owned.contains(session_id));
    drop(guard);

    // This cleanup path bypasses forget_owned_session, so drop the cleared
    // sessions' executor-cost snapshot baselines here too. Without this a
    // conversation restarted under the same session id against the fresh
    // sidecar would inherit a stale cumulative baseline and under-count its
    // first rollup.
    {
        let mut snapshots = exec_token_snapshots.lock().await;
        snapshots.retain(|(sid, _), _| !sessions.iter().any(|cleared| cleared == sid));
    }
    {
        let mut meta = session_usage_meta.lock().await;
        meta.retain(|sid, _| !sessions.iter().any(|cleared| cleared == sid));
    }

    // E10-SUMMARIZE — also resolve any outstanding one-shot waiters
    // with the crash error so awaiters don't hang forever after a
    // sidecar exit.
    let mut waiters = oneshot_waiters.lock().await;
    let drained: Vec<(String, OneshotWaiter)> = sessions
        .iter()
        .filter_map(|session_id| {
            waiters
                .remove(session_id)
                .map(|waiter| (session_id.clone(), waiter))
        })
        .collect();
    drop(waiters);
    for (_sid, mut waiter) in drained {
        if let Some(sender) = waiter.sender.take() {
            let _ = sender.send(Err(message.to_string()));
        }
    }
}

/// Pump JSON lines from the mpsc receiver to the sidecar's stdin. Terminates
/// when the channel is closed (on respawn / shutdown) or stdin write fails.
async fn writer_loop(mut stdin: ChildStdin, mut rx: mpsc::Receiver<String>) {
    while let Some(line) = rx.recv().await {
        let mut buf = line.into_bytes();
        buf.push(b'\n');
        if let Err(e) = stdin.write_all(&buf).await {
            warn!(error = %e, "agent sidecar stdin write failed");
            break;
        }
        if let Err(e) = stdin.flush().await {
            warn!(error = %e, "agent sidecar stdin flush failed");
            break;
        }
    }
}

async fn read_capped_line<R>(
    reader: &mut R,
    buffer: &mut Vec<u8>,
) -> std::io::Result<Option<String>>
where
    R: tokio::io::AsyncBufRead + Unpin,
{
    buffer.clear();
    loop {
        let (take, consume, found_newline, reached_eof) = {
            let available = reader.fill_buf().await?;
            if available.is_empty() {
                (Vec::new(), 0, false, true)
            } else if let Some(index) = available.iter().position(|byte| *byte == b'\n') {
                (available[..index].to_vec(), index + 1, true, false)
            } else {
                (available.to_vec(), available.len(), false, false)
            }
        };

        if reached_eof {
            if buffer.is_empty() {
                return Ok(None);
            }
            break;
        }
        if buffer.len().saturating_add(take.len()) > MAX_SIDECAR_STDOUT_LINE_BYTES {
            reader.consume(consume);
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                format!(
                    "sidecar stdout record exceeded {} bytes",
                    MAX_SIDECAR_STDOUT_LINE_BYTES
                ),
            ));
        }
        buffer.extend_from_slice(&take);
        reader.consume(consume);
        if found_newline {
            break;
        }
    }

    String::from_utf8(buffer.clone())
        .map(Some)
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))
}

async fn stderr_loop(stderr: ChildStderr) {
    let mut lines = BufReader::new(stderr).lines();
    loop {
        match lines.next_line().await {
            Ok(Some(line)) => {
                let trimmed = line.trim_end();
                if !trimmed.is_empty() {
                    warn!(target: "agent_sidecar::stderr", "{}", trimmed);
                }
            }
            Ok(None) => break,
            Err(e) => {
                warn!(error = %e, "agent sidecar stderr read failed");
                break;
            }
        }
    }
}

/// F7 — are developer env overrides honored in this build?
///
/// `PACKETBENCH_SIDECAR_PATH` and `PACKETBENCH_NODE_PATH` redirect the supervisor
/// to an arbitrary Node binary and script, and that process is handed live API
/// keys (`start_session.apiKey`) plus every session's MCP trust snapshot. In a
/// debug build that is the normal development loop. In a release build it is a
/// way to substitute the security-critical peer without touching the install,
/// so it is honored only when the user has opted in explicitly via
/// `PACKETBENCH_DEV_SIDECAR=1`.
fn developer_overrides_allowed() -> bool {
    overrides_allowed(
        cfg!(debug_assertions),
        std::env::var("PACKETBENCH_DEV_SIDECAR").ok().as_deref(),
    )
}

/// Pure form of the rule, so both build modes are testable from a debug build.
fn overrides_allowed(is_debug_build: bool, opt_in: Option<&str>) -> bool {
    is_debug_build || matches!(opt_in, Some("1") | Some("true"))
}

/// Log loudly, once, when a release build is running against an overridden
/// sidecar or Node binary. This is the only trace an operator gets that the
/// process receiving their API keys is not the bundled one.
fn warn_if_override_active_in_release(variable: &str, value: &str) {
    if cfg!(debug_assertions) {
        return;
    }
    warn!(
        variable = %variable,
        value = %value,
        "SECURITY: release build is using a developer sidecar override — the overridden process \
         receives live API keys and this session's MCP trust snapshot"
    );
}

/// Resolve the path to the sidecar entrypoint.
///
/// Three-branch resolution:
/// 1. If `PACKETBENCH_SIDECAR_PATH` is set AND developer overrides are allowed
///    (debug build, or `PACKETBENCH_DEV_SIDECAR=1`), use it verbatim.
/// 2. Otherwise in dev (`cfg!(debug_assertions)`) fall back to
///    `<project-root>/agent-sidecar/dist/index.js`. `CARGO_MANIFEST_DIR` in
///    dev is `src-tauri/`, so this resolves to the source tree.
/// 3. Otherwise in release resolve via Tauri's resource dir (slice B bundles
///    `agent-sidecar/{dist,package.json,node_modules}` under that path).
///
/// If none of the three exist we still return a best-guess path; the caller
/// (`spawn_child`) checks `.exists()` and surfaces a user-readable error
/// that lists the resolved path.
fn resolve_sidecar_path(app_handle: &AppHandle) -> PathBuf {
    // 1. Explicit env override — highest priority, developer builds only.
    if let Ok(override_path) = std::env::var("PACKETBENCH_SIDECAR_PATH") {
        if developer_overrides_allowed() {
            warn_if_override_active_in_release("PACKETBENCH_SIDECAR_PATH", &override_path);
            return PathBuf::from(override_path);
        }
        warn!(
            path = %override_path,
            "ignoring PACKETBENCH_SIDECAR_PATH in a release build — set PACKETBENCH_DEV_SIDECAR=1 to \
             opt in; the bundled sidecar will be used instead"
        );
    }

    // 2. Dev fallback — CARGO_MANIFEST_DIR-relative path to the source tree.
    let dev_path: PathBuf = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("agent-sidecar")
        .join("dist")
        .join("index.js");

    if cfg!(debug_assertions) {
        return dev_path;
    }

    // 3. Release — bundled resource dir. If resource_dir() fails (unlikely
    //    on desktop), fall back to dev_path so the error message in
    //    `spawn_child` points at something sensible.
    match app_handle.path().resource_dir() {
        Ok(dir) => dir.join("agent-sidecar").join("dist").join("index.js"),
        Err(e) => {
            error!(
                error = %e,
                "failed to resolve resource_dir; falling back to manifest-relative path"
            );
            dev_path
        }
    }
}

/// Resolve an explicit Node binary override via `PACKETBENCH_NODE_PATH`. When
/// `None` is returned, callers use their default strategy: system `node` in
/// dev, Tauri shell plugin sidecar in release.
///
/// F7: honored only where [`developer_overrides_allowed`] says so — this
/// selects the interpreter that will receive live API keys.
fn resolved_node_override() -> Option<PathBuf> {
    let raw = std::env::var("PACKETBENCH_NODE_PATH").ok()?;
    if raw.is_empty() {
        return None;
    }
    if !developer_overrides_allowed() {
        warn!(
            path = %raw,
            "ignoring PACKETBENCH_NODE_PATH in a release build — set PACKETBENCH_DEV_SIDECAR=1 to \
             opt in; the bundled Node runtime will be used instead"
        );
        return None;
    }
    warn_if_override_active_in_release("PACKETBENCH_NODE_PATH", &raw);
    Some(PathBuf::from(raw))
}

/// Node 24.15 on Windows cannot load a main module path in verbatim form
/// (`\\?\D:\...`), which Tauri may return for bundled resources. Strip that
/// prefix only for the argument we pass to Node; filesystem checks can keep
/// using the original `PathBuf`.
#[cfg(windows)]
fn node_compatible_path(path: &Path) -> PathBuf {
    let rendered = path.to_string_lossy();
    if let Some(rest) = rendered.strip_prefix("\\\\?\\UNC\\") {
        PathBuf::from(format!("\\\\{}", rest))
    } else if let Some(rest) = rendered.strip_prefix("\\\\?\\") {
        PathBuf::from(rest)
    } else {
        path.to_path_buf()
    }
}

#[cfg(not(windows))]
fn node_compatible_path(path: &Path) -> PathBuf {
    path.to_path_buf()
}

fn bundled_node_names() -> &'static [&'static str] {
    #[cfg(all(target_os = "windows", target_arch = "x86_64", target_env = "msvc"))]
    {
        &["node.exe", "node-x86_64-pc-windows-msvc.exe"]
    }
    #[cfg(all(target_os = "macos", target_arch = "x86_64"))]
    {
        &["node", "node-x86_64-apple-darwin"]
    }
    #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
    {
        &["node", "node-aarch64-apple-darwin"]
    }
    #[cfg(all(target_os = "linux", target_arch = "x86_64"))]
    {
        &["node", "node-x86_64-unknown-linux-gnu"]
    }
    #[cfg(all(target_os = "linux", target_arch = "aarch64"))]
    {
        &["node", "node-aarch64-unknown-linux-gnu"]
    }
    #[cfg(not(any(
        all(target_os = "windows", target_arch = "x86_64", target_env = "msvc"),
        all(target_os = "macos", target_arch = "x86_64"),
        all(target_os = "macos", target_arch = "aarch64"),
        all(target_os = "linux", target_arch = "x86_64"),
        all(target_os = "linux", target_arch = "aarch64")
    )))]
    {
        &[]
    }
}

fn resolve_bundled_node_path(app_handle: &AppHandle) -> Option<PathBuf> {
    let mut roots = Vec::new();
    if let Ok(exe) = std::env::current_exe() {
        if let Some(parent) = exe.parent() {
            roots.push(parent.to_path_buf());
        }
    }
    if let Ok(resource_dir) = app_handle.path().resource_dir() {
        roots.push(resource_dir);
    }

    for root in roots {
        for name in bundled_node_names() {
            let candidate = root.join(name);
            if candidate.is_file() {
                return Some(candidate);
            }
        }
    }
    None
}

fn load_ssh_password(config: &SshConfig) -> Option<String> {
    config
        .target_id
        .as_deref()
        .and_then(|id| ssh_keys::load_ssh_password(id).ok().flatten())
        .filter(|pw| !pw.is_empty())
}

fn reject_remote_password_auth(config: &SshConfig) -> Result<(), String> {
    let explicit_password = config
        .auth_method
        .as_deref()
        .map(|method| method.eq_ignore_ascii_case("password"))
        .unwrap_or(false);
    let legacy_password = config.auth_method.is_none() && load_ssh_password(config).is_some();
    if explicit_password || legacy_password {
        return Err(
            "Remote sidecar execution requires key or SSH-agent authentication. Password-auth SSH targets cannot be used because stdin is reserved for the sidecar JSON protocol.".to_string(),
        );
    }
    Ok(())
}

fn remote_target_label(config: &SshConfig) -> String {
    format!("{}@{}:{}", config.user, config.host, config.remote_path)
}

fn validate_remote_sidecar_target(config: &SshConfig) -> Result<(), String> {
    let remote_path = config.remote_path.trim();
    if remote_path.is_empty() {
        return Err("Remote workspace path is empty".to_string());
    }
    if !remote_path.starts_with('/') {
        return Err(format!(
            "Sidecar-over-SSH currently requires a Unix-style absolute remote path; got '{}'",
            remote_path
        ));
    }
    if remote_path.contains('\0') {
        return Err("Remote workspace path may not contain NUL bytes".to_string());
    }
    Ok(())
}

fn remote_node_assignment() -> String {
    match std::env::var("PACKETBENCH_REMOTE_NODE_PATH")
        .ok()
        .filter(|v| !v.trim().is_empty())
    {
        Some(path) => format!("NODE_BIN={};", sh_quote(path.trim())),
        None => "NODE_BIN=${PACKETBENCH_REMOTE_NODE_PATH:-node};".to_string(),
    }
}

fn remote_sidecar_assignment() -> String {
    match std::env::var("PACKETBENCH_REMOTE_SIDECAR_PATH")
        .ok()
        .filter(|v| !v.trim().is_empty())
    {
        Some(path) => format!("SIDECAR_ENTRY={};", sh_quote(path.trim())),
        None => {
            "SIDECAR_ENTRY=${PACKETBENCH_REMOTE_SIDECAR_PATH:-$HOME/.packetbench/agent-sidecar/dist/index.js};"
                .to_string()
        }
    }
}

/// Remote-host credential preflight for a sidecar provider.
///
/// Empty for every provider: all sidecar providers now authenticate with an
/// API key that the LOCAL supervisor loads from the OS keyring and sends over
/// the wire in `start_session.apiKey`. There is nothing for the remote host to
/// be "signed in" to, so the old `claude login` / `codex login` file checks
/// were removed along with subscription OAuth.
///
/// Kept as a named seam rather than inlined so an API-key-shaped preflight can
/// be added here later without re-threading the call site.
fn remote_auth_preflight(_provider: &str) -> &'static str {
    ""
}

fn remote_sidecar_preflight_script(config: &SshConfig, provider: &str) -> String {
    let project_path = sh_quote(config.remote_path.trim());
    let auth_preflight = remote_auth_preflight(provider);
    format!(
        r#"{path_setup}
OS_NAME=$(uname -s 2>/dev/null || echo unknown)
case "$OS_NAME" in Linux*|Darwin*|FreeBSD*) ;; *) echo "PACKETBENCH_PREFLIGHT_ERROR unsupported remote OS: $OS_NAME. Sidecar-over-SSH currently requires a Unix-like host with POSIX sh." >&2; exit 91;; esac
{node_assignment}
{sidecar_assignment}
PROJECT_PATH={project_path}
if ! command -v "$NODE_BIN" >/dev/null 2>&1 && [ ! -x "$NODE_BIN" ]; then echo "PACKETBENCH_PREFLIGHT_ERROR Node.js not found on remote host. Install Node.js or set PACKETBENCH_REMOTE_NODE_PATH." >&2; exit 92; fi
if [ ! -f "$SIDECAR_ENTRY" ]; then echo "PACKETBENCH_PREFLIGHT_ERROR Remote sidecar entry not found at $SIDECAR_ENTRY. Copy agent-sidecar to ~/.packetbench/agent-sidecar or set PACKETBENCH_REMOTE_SIDECAR_PATH." >&2; exit 93; fi
if [ ! -d "$PROJECT_PATH" ]; then echo "PACKETBENCH_PREFLIGHT_ERROR Remote workspace path does not exist: $PROJECT_PATH" >&2; exit 94; fi
case "$PROJECT_PATH" in /*) ;; *) echo "PACKETBENCH_PREFLIGHT_ERROR Remote workspace path must be Unix-style absolute: $PROJECT_PATH" >&2; exit 95;; esac
{auth_preflight}
echo PACKETBENCH_REMOTE_SIDECAR_READY
"#,
        path_setup = REMOTE_PATH_SETUP,
        node_assignment = remote_node_assignment(),
        sidecar_assignment = remote_sidecar_assignment(),
        project_path = project_path,
        auth_preflight = auth_preflight,
    )
}

fn remote_sidecar_launch_script(config: &SshConfig) -> String {
    let project_path = sh_quote(config.remote_path.trim());
    format!(
        r#"{path_setup}
{node_assignment}
{sidecar_assignment}
PROJECT_PATH={project_path}
cd "$PROJECT_PATH" || exit 94
PACKETBENCH_REMOTE_SIDECAR=1 exec "$NODE_BIN" "$SIDECAR_ENTRY"
"#,
        path_setup = REMOTE_PATH_SETUP,
        node_assignment = remote_node_assignment(),
        sidecar_assignment = remote_sidecar_assignment(),
        project_path = project_path,
    )
}

async fn remote_sidecar_preflight(config: &SshConfig, provider: &str) -> Result<(), String> {
    let mut cmd = Command::new("ssh");
    cmd.args(config.ssh_args(false))
        .arg(remote_sidecar_preflight_script(config, provider))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    hide_window_async(&mut cmd);

    let child = cmd.spawn().map_err(|e| {
        format!(
            "Failed to spawn SSH preflight for {}: {}",
            remote_target_label(config),
            e
        )
    })?;

    let output = tokio::time::timeout(
        Duration::from_secs(REMOTE_SIDECAR_TIMEOUT_SECS),
        child.wait_with_output(),
    )
    .await
    .map_err(|_| {
        format!(
            "SSH sidecar preflight timed out for {}",
            remote_target_label(config)
        )
    })?
    .map_err(|e| format!("SSH sidecar preflight failed: {}", e))?;

    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    let combined = format!("{}{}", stdout, stderr);
    if output.status.success() && stdout.contains("PACKETBENCH_REMOTE_SIDECAR_READY") {
        return Ok(());
    }

    let message = combined
        .lines()
        .find_map(|line| line.strip_prefix("PACKETBENCH_PREFLIGHT_ERROR "))
        .map(str::to_string)
        .or_else(|| {
            combined
                .lines()
                .find(|line| !line.trim().is_empty())
                .map(|line| line.trim().to_string())
        })
        .unwrap_or_else(|| format!("SSH preflight exited with {}", output.status));
    Err(message)
}

#[cfg(test)]
mod supervisor_tests {
    use super::*;
    use std::collections::{HashMap, HashSet};
    use std::sync::Arc;
    use tokio::sync::{oneshot, Mutex};

    fn waiter() -> (OneshotWaiter, oneshot::Receiver<Result<String, String>>) {
        let (tx, rx) = oneshot::channel();
        (
            OneshotWaiter {
                buffer: String::new(),
                sender: Some(tx),
            },
            rx,
        )
    }

    #[tokio::test]
    async fn fan_out_crash_error_emits_recoverable_errors_for_local_sessions_only() {
        let owned_sessions = Arc::new(Mutex::new(
            ["local-a", "local-b", "remote-a"]
                .into_iter()
                .map(String::from)
                .collect::<HashSet<_>>(),
        ));
        let remote_owned_sessions = Arc::new(Mutex::new(
            ["remote-a"]
                .into_iter()
                .map(String::from)
                .collect::<HashSet<_>>(),
        ));

        let (local_a_waiter, local_a_rx) = waiter();
        let (local_b_waiter, local_b_rx) = waiter();
        let (remote_waiter, _remote_rx) = waiter();
        let (orphan_waiter, _orphan_rx) = waiter();
        let oneshot_waiters = Arc::new(Mutex::new(HashMap::from([
            ("local-a".to_string(), local_a_waiter),
            ("local-b".to_string(), local_b_waiter),
            ("remote-a".to_string(), remote_waiter),
            ("orphan-a".to_string(), orphan_waiter),
        ])));
        // Seed executor-cost snapshot baselines for one cleared local session
        // and the surviving remote session: the fan-out must purge the
        // former (stale baselines survive crashes otherwise) and keep the
        // latter (remote sessions are untouched by the local crash path).
        let exec_token_snapshots = Arc::new(Mutex::new(HashMap::from([
            (
                ("local-a".to_string(), String::new()),
                (3_u64, [10, 20, 30, 40]),
            ),
            (
                ("remote-a".to_string(), String::new()),
                (7_u64, [1, 2, 3, 4]),
            ),
        ])));
        // Usage-ledger metadata follows the same purge/keep rule as the
        // cost baselines above.
        let session_usage_meta = Arc::new(Mutex::new(HashMap::from([
            (
                "local-a".to_string(),
                SessionUsageMeta {
                    provider: "claude-oauth".to_string(),
                    model: "claude-sonnet-4-6".to_string(),
                },
            ),
            (
                "remote-a".to_string(),
                SessionUsageMeta {
                    provider: "openai-agents".to_string(),
                    model: "gpt-5.5".to_string(),
                },
            ),
        ])));

        let mut emitted = Vec::new();
        fan_out_crash_error_to_local_sessions(
            &owned_sessions,
            &remote_owned_sessions,
            &oneshot_waiters,
            &exec_token_snapshots,
            &session_usage_meta,
            SIDECAR_RESTART_RECOVERABLE_ERROR,
            |event, payload| emitted.push((event, payload.message)),
        )
        .await;

        emitted.sort();
        assert_eq!(
            emitted,
            vec![
                (
                    "api-agent:error:local-a".to_string(),
                    SIDECAR_RESTART_RECOVERABLE_ERROR.to_string(),
                ),
                (
                    "api-agent:error:local-b".to_string(),
                    SIDECAR_RESTART_RECOVERABLE_ERROR.to_string(),
                ),
            ]
        );
        assert_eq!(
            owned_sessions.lock().await.clone(),
            ["remote-a"]
                .into_iter()
                .map(String::from)
                .collect::<HashSet<_>>()
        );
        assert_eq!(
            remote_owned_sessions.lock().await.clone(),
            ["remote-a"]
                .into_iter()
                .map(String::from)
                .collect::<HashSet<_>>()
        );
        assert_eq!(
            local_a_rx.await.unwrap(),
            Err(SIDECAR_RESTART_RECOVERABLE_ERROR.to_string())
        );
        assert_eq!(
            local_b_rx.await.unwrap(),
            Err(SIDECAR_RESTART_RECOVERABLE_ERROR.to_string())
        );

        {
            let waiters = oneshot_waiters.lock().await;
            assert!(!waiters.contains_key("local-a"));
            assert!(!waiters.contains_key("local-b"));
            assert!(waiters
                .get("remote-a")
                .and_then(|waiter| waiter.sender.as_ref())
                .is_some());
            assert!(waiters
                .get("orphan-a")
                .and_then(|waiter| waiter.sender.as_ref())
                .is_some());
        }

        {
            let snapshots = exec_token_snapshots.lock().await;
            assert!(
                !snapshots.contains_key(&("local-a".to_string(), String::new())),
                "cleared local session's cost baseline must be purged"
            );
            assert_eq!(
                snapshots.get(&("remote-a".to_string(), String::new())),
                Some(&(7_u64, [1, 2, 3, 4])),
                "surviving remote session's cost baseline must be kept"
            );
        }

        {
            let meta = session_usage_meta.lock().await;
            assert!(
                !meta.contains_key("local-a"),
                "cleared local session's usage metadata must be purged"
            );
            assert!(
                meta.contains_key("remote-a"),
                "surviving remote session's usage metadata must be kept"
            );
        }

        fan_out_crash_error_to_local_sessions(
            &owned_sessions,
            &remote_owned_sessions,
            &oneshot_waiters,
            &exec_token_snapshots,
            &session_usage_meta,
            "Sidecar crashed and could not restart",
            |event, payload| emitted.push((event, payload.message)),
        )
        .await;
        assert_eq!(emitted.len(), 2);
        assert_eq!(
            owned_sessions.lock().await.clone(),
            ["remote-a"]
                .into_iter()
                .map(String::from)
                .collect::<HashSet<_>>()
        );
    }
}

#[cfg(test)]
mod developer_override_tests {
    use super::overrides_allowed;

    #[test]
    fn debug_builds_honor_the_sidecar_overrides() {
        // The everyday `pnpm tauri dev` loop, with and without the opt-in.
        assert!(overrides_allowed(true, None));
        assert!(overrides_allowed(true, Some("1")));
    }

    #[test]
    fn release_builds_ignore_the_overrides_unless_opted_in() {
        // F7: the overridden process receives live API keys and each session's
        // MCP trust snapshot, so a stray env var in a shipped build must not
        // be enough to swap it out.
        assert!(!overrides_allowed(false, None));
        assert!(!overrides_allowed(false, Some("")));
        assert!(!overrides_allowed(false, Some("0")));
        assert!(!overrides_allowed(false, Some("yes")));
        assert!(overrides_allowed(false, Some("1")));
        assert!(overrides_allowed(false, Some("true")));
    }
}

#[cfg(test)]
mod remote_tests {
    use super::*;

    fn sample_cfg(remote_path: &str) -> SshConfig {
        SshConfig {
            host: "example.com".to_string(),
            port: 22,
            user: "alice".to_string(),
            remote_path: remote_path.to_string(),
            key_path: None,
            auth_method: Some("agent".to_string()),
            target_id: Some("srv-1".to_string()),
            host_fingerprint: Some("SHA256:test".to_string()),
        }
    }

    #[test]
    fn remote_target_rejects_windows_paths() {
        let err = validate_remote_sidecar_target(&sample_cfg("C:\\repo")).unwrap_err();
        assert!(err.contains("Unix-style absolute"));
    }

    #[test]
    fn remote_preflight_script_checks_node_sidecar_and_project() {
        let script =
            remote_sidecar_preflight_script(&sample_cfg("/home/alice/project"), "openai-agents");
        assert!(script.contains("PACKETBENCH_REMOTE_SIDECAR_READY"));
        assert!(script.contains("Node.js not found"));
        assert!(script.contains("Remote sidecar entry not found"));
        assert!(script.contains("PROJECT_PATH='/home/alice/project'"));
    }

    #[test]
    fn remote_preflight_script_never_requires_remote_oauth() {
        // Sidecar providers are API-key-authenticated and the key travels in
        // `start_session.apiKey` from the LOCAL keyring, so no preflight may
        // demand a subscription credential file on the SSH host. A regression
        // that reinstated one would both break remote launches and reintroduce
        // the subscription-credential dependency this change removed.
        for provider in ["claude-oauth", "openai-agents", "openai-codex"] {
            let script =
                remote_sidecar_preflight_script(&sample_cfg("/home/alice/project"), provider);
            assert!(
                !script.contains("OAuth is not signed in"),
                "{provider} preflight still checks for remote OAuth credentials"
            );
            assert!(!script.contains(".credentials.json"), "{provider}");
            assert!(!script.contains(".codex/auth.json"), "{provider}");
            // The non-auth preflight checks must survive.
            assert!(script.contains("Node.js not found"), "{provider}");
        }
    }

    #[test]
    fn remote_password_auth_uses_explicit_auth_method_before_keyring_fallback() {
        let mut cfg = sample_cfg("/home/alice/project");
        cfg.auth_method = Some("password".to_string());
        assert!(reject_remote_password_auth(&cfg)
            .unwrap_err()
            .contains("Password-auth"));

        cfg.auth_method = Some("key".to_string());
        assert!(reject_remote_password_auth(&cfg).is_ok());
    }

    #[test]
    fn remote_launch_script_execs_node_sidecar_in_project() {
        let script = remote_sidecar_launch_script(&sample_cfg("/home/alice/project"));
        assert!(script.contains("cd \"$PROJECT_PATH\""));
        assert!(
            script.contains("PACKETBENCH_REMOTE_SIDECAR=1 exec \"$NODE_BIN\" \"$SIDECAR_ENTRY\"")
        );
    }

    #[tokio::test]
    async fn remote_handshake_requires_trust_capable_ready_and_preserves_buffered_events() {
        for line in [
            "{\"type\":\"ready\",\"protocolVersion\":11}\n",
            "{\"type\":\"ready\"}\n",
            "{\"type\":\"done\",\"protocolVersion\":12}\n",
            "{\"type\":\"ready\",\"protocolVersion\":4294967308}\n",
            "not json\n",
            "",
        ] {
            let mut reader = BufReader::new(line.as_bytes());
            assert!(await_remote_handshake(&mut reader).await.is_err(), "{line}");
        }
        for version in [MINIMUM_PROTOCOL_VERSION, EXPECTED_PROTOCOL_VERSION + 1] {
            let input = format!(
                "\n{{\"type\":\"ready\",\"protocolVersion\":{version}}}\n{{\"type\":\"done\"}}\n"
            );
            let mut reader = BufReader::new(input.as_bytes());
            await_remote_handshake(&mut reader).await.unwrap();
            assert_eq!(
                read_capped_line(&mut reader, &mut Vec::new())
                    .await
                    .unwrap(),
                Some("{\"type\":\"done\"}".to_string())
            );
        }
    }

    #[tokio::test]
    async fn capped_sidecar_line_reader_accepts_normal_and_rejects_oversized_records() {
        let normal = b"{\"type\":\"done\"}\n";
        let mut reader = BufReader::new(normal.as_slice());
        let mut buffer = Vec::new();
        assert_eq!(
            read_capped_line(&mut reader, &mut buffer).await.unwrap(),
            Some("{\"type\":\"done\"}".to_string())
        );

        let mut oversized = vec![b'x'; MAX_SIDECAR_STDOUT_LINE_BYTES + 1];
        oversized.push(b'\n');
        let mut reader = BufReader::new(oversized.as_slice());
        let error = read_capped_line(&mut reader, &mut buffer)
            .await
            .unwrap_err();
        assert_eq!(error.kind(), std::io::ErrorKind::InvalidData);
    }
}
