//! Async parallel agent attempts on Flights ("one prompt → N agents").
//!
//! Each attempt provisions a git worktree (local or remote SSH), starts an
//! API agent session bound to that worktree, and is persisted as an
//! `Attempt` on the Flight. Cancellation removes the worktree and closes
//! the session.

use crate::commands::agent_sidecar::SidecarManager;
use crate::commands::api_agent::{close_api_agent_session, start_api_agent_session, ApiAgentState};
use crate::core::execution::SshConfig;
use crate::core::flight::{Attempt, AttemptStatus, AttemptTarget, ReviewGateStatus};
use crate::core::storage;
use crate::core::worktree;
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use tracing::{info, warn};
use uuid::Uuid;

#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum AttemptTargetSpec {
    Local {
        base_path: String,
        base_branch: String,
        agent_config_id: String,
        provider: String,
        model: String,
        #[serde(default)]
        task_id: Option<String>,
    },
    Ssh {
        target_id: String,
        host: String,
        port: u16,
        user: String,
        #[serde(default)]
        key_path: Option<String>,
        #[serde(default)]
        auth_method: Option<String>,
        /// Pinned SHA256 host-key fingerprint, copied from the saved
        /// `ServerConfig.hostFingerprint`. When present, the per-attempt
        /// `SshConfig` uses strict host-key checking against the
        /// app-managed `known_hosts` file. When absent (legacy entries),
        /// the runtime falls back to TOFU `accept-new` and logs a warning.
        #[serde(default)]
        host_fingerprint: Option<String>,
        base_path: String,
        base_branch: String,
        agent_config_id: String,
        provider: String,
        model: String,
        #[serde(default)]
        task_id: Option<String>,
    },
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SetAttemptStatus {
    Reviewing,
    Completed,
    Failed,
    Cancelled,
}

fn now_ms() -> u64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct PathClaim {
    scope: String,
    path: String,
    display_path: String,
    branch: String,
    case_sensitive: bool,
}

fn normalize_claimed_path(path: &str, case_sensitive: bool) -> String {
    let mut normalized = String::with_capacity(path.len());
    let mut previous_was_slash = false;
    for ch in path.trim().replace('\\', "/").chars() {
        if ch == '/' {
            if !previous_was_slash {
                normalized.push(ch);
            }
            previous_was_slash = true;
        } else {
            if case_sensitive {
                normalized.push(ch);
            } else {
                normalized.push(ch.to_ascii_lowercase());
            }
            previous_was_slash = false;
        }
    }
    while normalized.ends_with('/') {
        normalized.pop();
    }
    normalized
        .strip_prefix("./")
        .unwrap_or(&normalized)
        .to_string()
}

fn claimed_paths_overlap(left: &str, right: &str, case_sensitive: bool) -> bool {
    let a = normalize_claimed_path(left, case_sensitive);
    let b = normalize_claimed_path(right, case_sensitive);
    if a.is_empty() || b.is_empty() {
        return false;
    }
    a == b || a.starts_with(&(b.clone() + "/")) || b.starts_with(&(a.clone() + "/"))
}

fn normalize_branch(branch: &str) -> String {
    let branch = branch.trim().to_ascii_lowercase();
    if branch.is_empty() {
        "main".to_string()
    } else {
        branch
    }
}

fn target_spec_claim(spec: &AttemptTargetSpec) -> Option<PathClaim> {
    match spec {
        AttemptTargetSpec::Local {
            base_path,
            base_branch,
            ..
        } => {
            let path = normalize_claimed_path(base_path, false);
            if path.is_empty() {
                return None;
            }
            Some(PathClaim {
                scope: "local".to_string(),
                path,
                display_path: base_path.clone(),
                branch: normalize_branch(base_branch),
                case_sensitive: false,
            })
        }
        AttemptTargetSpec::Ssh {
            target_id,
            host,
            port,
            user,
            base_path,
            base_branch,
            ..
        } => {
            let path = normalize_claimed_path(base_path, true);
            if path.is_empty() {
                return None;
            }
            let scope = if target_id.trim().is_empty() {
                format!("ssh:{}@{}:{}", user, host, port)
            } else {
                format!("ssh:{}", target_id)
            };
            let display_target = if target_id.trim().is_empty() {
                format!("{}@{}:{}", user, host, port)
            } else {
                target_id.clone()
            };
            Some(PathClaim {
                scope,
                path,
                display_path: format!("{}:{}", display_target, base_path),
                branch: normalize_branch(base_branch),
                case_sensitive: true,
            })
        }
    }
}

fn attempt_claim(attempt: &Attempt) -> Option<PathClaim> {
    let (scope, base_path, case_sensitive) = match &attempt.target {
        AttemptTarget::Local { base_path, .. } => ("local".to_string(), base_path.clone(), false),
        AttemptTarget::Ssh {
            server_id,
            base_path,
            ..
        } => (format!("ssh:{}", server_id), base_path.clone(), true),
    };
    let path = normalize_claimed_path(&base_path, case_sensitive);
    if path.is_empty() {
        return None;
    }
    Some(PathClaim {
        scope,
        path,
        display_path: base_path,
        branch: normalize_branch(&attempt.base_branch),
        case_sensitive,
    })
}

fn claims_overlap(left: &PathClaim, right: &PathClaim) -> bool {
    left.scope == right.scope
        && left.branch == right.branch
        && claimed_paths_overlap(
            &left.path,
            &right.path,
            left.case_sensitive || right.case_sensitive,
        )
}

fn validate_target_identities(targets: &[AttemptTargetSpec]) -> Result<(), String> {
    for (index, target) in targets.iter().enumerate() {
        if let AttemptTargetSpec::Ssh { target_id, .. } = target {
            if target_id.trim().is_empty() {
                return Err(format!(
                    "path_collision: target {} is missing ssh target_id; save/select the SSH server before launching",
                    index + 1
                ));
            }
        }
    }
    Ok(())
}

/// Security boundary (#8a): refuse to launch an async/agent attempt against an
/// SSH target whose host key has not been pinned. `core/execution.rs` falls back
/// to `StrictHostKeyChecking=accept-new` (TOFU) when `host_fingerprint` is None,
/// which is acceptable for the *interactive* PTY/workspace path but is a silent
/// MITM window for the non-interactive async launch path. Fail closed here,
/// before any connection (or worktree provisioning) is attempted, so every async
/// SSH attempt is covered. Local (non-SSH) targets are ignored.
fn validate_ssh_pinning(targets: &[AttemptTargetSpec]) -> Result<(), String> {
    for target in targets {
        if let AttemptTargetSpec::Ssh {
            host,
            host_fingerprint,
            ..
        } = target
        {
            let pinned = host_fingerprint
                .as_deref()
                .map(str::trim)
                .is_some_and(|fp| !fp.is_empty());
            if !pinned {
                return Err(format!(
                    "Refusing to launch against {}: host key not verified. Pin it on the Servers page first.",
                    host
                ));
            }
        }
    }
    Ok(())
}

fn validate_target_claims(targets: &[AttemptTargetSpec]) -> Result<(), String> {
    let claims: Vec<(usize, PathClaim)> = targets
        .iter()
        .enumerate()
        .filter_map(|(index, target)| target_spec_claim(target).map(|claim| (index, claim)))
        .collect();

    for i in 0..claims.len() {
        for j in (i + 1)..claims.len() {
            let (left_index, left) = &claims[i];
            let (right_index, right) = &claims[j];
            if claims_overlap(left, right) {
                return Err(format!(
                    "path_collision: selected targets {} and {} both claim {} on {}",
                    left_index + 1,
                    right_index + 1,
                    left.display_path,
                    left.branch
                ));
            }
        }
    }

    Ok(())
}

fn validate_target_claims_against_active_attempts(
    targets: &[AttemptTargetSpec],
) -> Result<(), String> {
    let target_claims: Vec<(usize, PathClaim)> = targets
        .iter()
        .enumerate()
        .filter_map(|(index, target)| target_spec_claim(target).map(|claim| (index, claim)))
        .collect();
    let state = storage::load_state();

    for flight in &state.flights {
        for existing in &flight.attempts {
            if !is_active_attempt(existing.status) {
                continue;
            }
            let Some(existing_claim) = attempt_claim(existing) else {
                continue;
            };
            for (target_index, target_claim) in &target_claims {
                if claims_overlap(target_claim, &existing_claim) {
                    return Err(format!(
                        "path_collision: target {} claims {} but attempt {} is already {:?} on {} ({})",
                        target_index + 1,
                        target_claim.display_path,
                        existing.id,
                        existing.status,
                        existing_claim.display_path,
                        existing_claim.branch
                    ));
                }
            }
        }
    }

    Ok(())
}

fn is_active_attempt(status: AttemptStatus) -> bool {
    matches!(
        status,
        AttemptStatus::Queued | AttemptStatus::Provisioning | AttemptStatus::Running
    )
}

fn should_apply_attempt_status(current: AttemptStatus, next: AttemptStatus) -> bool {
    match next {
        AttemptStatus::Running => is_active_attempt(current),
        AttemptStatus::Reviewing => {
            is_active_attempt(current) || current == AttemptStatus::Reviewing
        }
        _ => true,
    }
}

fn active_attempt_collision_message(incoming: &Attempt, existing: &Attempt) -> Option<String> {
    if !is_active_attempt(existing.status) {
        return None;
    }
    let incoming_claim = attempt_claim(incoming)?;
    let existing_claim = attempt_claim(existing)?;
    if !claims_overlap(&incoming_claim, &existing_claim) {
        return None;
    }
    Some(format!(
        "path_collision: attempt {} is already {:?} on {} ({})",
        existing.id, existing.status, existing_claim.display_path, existing_claim.branch
    ))
}

async fn cleanup_unpersisted_attempt(
    spec: &AttemptTargetSpec,
    target: &AttemptTarget,
    attempt_id: &str,
) {
    match target {
        AttemptTarget::Local { base_path, .. } => {
            if let Err(e) = worktree::remove_local_worktree(base_path, attempt_id, false).await {
                warn!(
                    attempt = %attempt_id,
                    error = %e,
                    "Local worktree cleanup after rejected attempt failed"
                );
            }
        }
        AttemptTarget::Ssh { base_path, .. } => {
            let Some(cfg) = build_ssh_config_from_spec(spec) else {
                warn!(
                    attempt = %attempt_id,
                    "SSH worktree cleanup after rejected attempt skipped: missing SSH config"
                );
                return;
            };
            if let Err(e) = worktree::remove_remote_worktree(&cfg, base_path, attempt_id).await {
                warn!(
                    attempt = %attempt_id,
                    error = %e,
                    "SSH worktree cleanup after rejected attempt failed"
                );
            }
        }
    }
}

async fn append_attempt(
    flight_id: &str,
    attempt: &Attempt,
    allow_path_collisions: bool,
    prompt: Option<String>,
) -> Result<(), String> {
    // v0.8 race-fix: use `with_state_lock` so concurrent async writers
    // (e.g. multiple `launch_flight_async` invocations or interleaving with
    // `mark_attempt_status`) can't lose each other's mutations via the old
    // naked load → mutate → save.
    let flight_id = flight_id.to_string();
    let mut attempt = attempt.clone();
    storage::with_state_lock(move |state| {
        let result: Result<(), String> = (|| {
            if !state.flights.iter().any(|f| f.id == flight_id) {
                return Err(format!("Flight '{}' not found", flight_id));
            }
            if !allow_path_collisions {
                for existing_flight in &state.flights {
                    for existing in &existing_flight.attempts {
                        if existing.id == attempt.id {
                            continue;
                        }
                        if let Some(message) = active_attempt_collision_message(&attempt, existing)
                        {
                            return Err(message);
                        }
                    }
                }
            }
            let flight = state
                .flights
                .iter_mut()
                .find(|f| f.id == flight_id)
                .ok_or_else(|| format!("Flight '{}' not found", flight_id))?;
            if flight.prompt.is_none() {
                flight.prompt = prompt;
            }
            fence_prepared_attempt(flight, &mut attempt);
            flight.attempts.push(attempt);
            flight.updated_at = now_ms();
            Ok(())
        })();
        std::future::ready(result)
    })
    .await
}

fn fence_prepared_attempt(flight: &crate::core::flight::Flight, attempt: &mut Attempt) {
    if matches!(
        attempt.status,
        AttemptStatus::Provisioning | AttemptStatus::Queued
    ) && (flight.stopped_at.is_some()
        || flight.archived_at.is_some()
        || flight.delivery.is_some())
    {
        attempt.status = AttemptStatus::Cancelled;
        attempt.completed_at = Some(now_ms());
        super::flight_runtime::retained(attempt, "Flight execution closed during preparation; worktree retained for inspection or explicit recovery.", now_ms());
    }
}

async fn update_attempt_status(
    flight_id: &str,
    attempt_id: &str,
    status: AttemptStatus,
    error: Option<String>,
) -> Result<(), String> {
    update_attempt_status_for_owner(flight_id, attempt_id, status, error, None).await
}

async fn update_attempt_status_for_owner(
    flight_id: &str,
    attempt_id: &str,
    status: AttemptStatus,
    error: Option<String>,
    expected_session: Option<&str>,
) -> Result<(), String> {
    // v0.8 race-fix: see `append_attempt` rationale. Concurrent writers
    // through the old naked load/save could drop each other's status flips.
    let flight_id = flight_id.to_string();
    let attempt_id = attempt_id.to_string();
    let expected_session = expected_session.map(str::to_string);
    storage::with_state_lock(move |state| {
        let result: Result<(), String> = (|| {
            let flight = state
                .flights
                .iter_mut()
                .find(|f| f.id == flight_id)
                .ok_or_else(|| format!("Flight '{}' not found", flight_id))?;
            if let Some(expected) = &expected_session {
                if !flight.attempts.iter().any(|attempt| {
                    attempt.id == attempt_id
                        && &attempt.session_id == expected
                        && attempt.status == AttemptStatus::Reviewing
                }) {
                    return Err("The attempt changed while its sessions were stopping; acceptance was not recorded.".into());
                }
            }
            if status == AttemptStatus::Reviewing && flight.stopped_at.is_some() {
                return Err("The Flight was stopped; cancelled turns cannot enter review.".into());
            }
            if status == AttemptStatus::Completed
                && flight
                    .review_gate_policy
                    .as_ref()
                    .is_some_and(|policy| policy.enabled)
            {
                let gate = flight
                    .attempts
                    .iter()
                    .find(|a| a.id == attempt_id)
                    .and_then(|attempt| attempt.review_gate.as_ref())
                    .ok_or_else(|| {
                        "Reviewer Gate has not produced a verdict; acceptance is blocked."
                            .to_string()
                    })?;
                let allowed = match gate.status {
                    ReviewGateStatus::Passed => gate.evidence.as_ref().is_some_and(|evidence| {
                        flight
                            .attempts
                            .iter()
                            .find(|a| a.id == attempt_id)
                            .is_some_and(|attempt| {
                                evidence.context_fingerprint
                                    == super::flight_review::context_fingerprint(flight, attempt)
                            })
                    }),
                    ReviewGateStatus::Overridden => {
                        gate.overridden_at.is_some()
                            && gate
                                .override_reason
                                .as_deref()
                                .is_some_and(|reason| !reason.trim().is_empty())
                    }
                    _ => false,
                };
                if !allowed {
                    return Err(
                        "Reviewer Gate must pass or have a recorded override before acceptance."
                            .to_string(),
                    );
                }
            }
            let attempt = flight
                .attempts
                .iter_mut()
                .find(|a| a.id == attempt_id)
                .ok_or_else(|| format!("Attempt '{}' not found", attempt_id))?;
            if !should_apply_attempt_status(attempt.status, status) {
                return Ok(());
            }
            attempt.status = status;
            if matches!(
                status,
                AttemptStatus::Completed | AttemptStatus::Failed | AttemptStatus::Cancelled
            ) {
                attempt.completed_at = Some(now_ms());
            }
            record_attempt_error(attempt, status, error);
            if status == AttemptStatus::Failed {
                super::flight_runtime::retained(
                    attempt,
                    "The builder failed; worktree retained for inspection or explicit recovery.",
                    now_ms(),
                );
            }
            flight.updated_at = now_ms();
            Ok(())
        })();
        std::future::ready(result)
    })
    .await
}

/// Record a terminal error on an attempt. On a `Failed` transition with a
/// message, also derive a structured `failure_category` via the shared
/// classifier (E1) so the UI can show a category, not just free text.
fn record_attempt_error(attempt: &mut Attempt, status: AttemptStatus, error: Option<String>) {
    if let Some(msg) = error {
        if status == AttemptStatus::Failed {
            attempt.failure_category = Some(
                crate::core::error_classifier::classify_cli_error(&msg)
                    .category
                    .as_str()
                    .to_string(),
            );
        }
        attempt.error_message = Some(msg);
    }
}

fn apply_attempt_status_by_session(
    state: &mut storage::PersistedState,
    session_id: &str,
    status: AttemptStatus,
    error: Option<String>,
) -> bool {
    for flight in &mut state.flights {
        if let Some(attempt) = flight
            .attempts
            .iter_mut()
            .find(|attempt| attempt.session_id == session_id)
        {
            if !is_active_attempt(attempt.status)
                || (flight.stopped_at.is_some()
                    && matches!(status, AttemptStatus::Running | AttemptStatus::Reviewing))
            {
                return false;
            }
            attempt.status = status;
            if matches!(
                status,
                AttemptStatus::Completed | AttemptStatus::Failed | AttemptStatus::Cancelled
            ) {
                attempt.completed_at = Some(now_ms());
            }
            record_attempt_error(attempt, status, error);
            flight.updated_at = now_ms();
            if status == AttemptStatus::Failed {
                super::flight_runtime::retained(
                    attempt,
                    "The builder failed; worktree retained for inspection or explicit recovery.",
                    now_ms(),
                );
            }
            if let Some(task_id) = &attempt.task_id {
                if let Some(task) = flight
                    .milestones
                    .iter_mut()
                    .flat_map(|milestone| &mut milestone.tasks)
                    .find(|task| &task.id == task_id)
                {
                    task.session_id = Some(attempt.session_id.clone());
                    if status == AttemptStatus::Failed {
                        task.status = crate::core::flight::TaskStatus::Failed;
                    }
                    if status == AttemptStatus::Running {
                        task.status = crate::core::flight::TaskStatus::Running;
                        task.started_at = Some(now_ms());
                    }
                }
            }
            return true;
        }
    }
    false
}

pub async fn update_attempt_status_by_session(
    session_id: &str,
    status: AttemptStatus,
    error: Option<String>,
) -> Result<bool, String> {
    let session_id = session_id.to_string();
    storage::with_state_lock(move |state| {
        let updated = apply_attempt_status_by_session(state, &session_id, status, error);
        std::future::ready(Ok(updated))
    })
    .await
}

/// A chat Stop ends the current builder turn without discarding its files.
/// Historical owners remain attributable but cannot change a resumed attempt.
fn apply_builder_cancellation(state: &mut storage::PersistedState, session_id: &str) -> bool {
    for flight in &mut state.flights {
        if flight.stopped_at.is_some() || flight.archived_at.is_some() || flight.delivery.is_some()
        {
            continue;
        }
        let Some(attempt) = flight
            .attempts
            .iter_mut()
            .find(|attempt| attempt.session_id == session_id)
        else {
            continue;
        };
        if !is_active_attempt(attempt.status) {
            return false;
        }
        let at = now_ms();
        attempt.status = AttemptStatus::Cancelled;
        attempt.completed_at = Some(at);
        super::flight_runtime::retained(
            attempt,
            "The builder turn was stopped; worktree retained for inspection or explicit recovery.",
            at,
        );
        if let Some(task) = flight
            .milestones
            .iter_mut()
            .flat_map(|milestone| &mut milestone.tasks)
            .find(|task| attempt.task_id.as_ref() == Some(&task.id))
        {
            task.status = crate::core::flight::TaskStatus::Cancelled;
            task.session_id = Some(attempt.session_id.clone());
        }
        flight.updated_at = at;
        return true;
    }
    false
}

pub(crate) async fn cancel_builder_attempt_for_session(session_id: &str) -> Result<bool, String> {
    let session_id = session_id.to_string();
    storage::with_state_lock(move |state| {
        std::future::ready(Ok(apply_builder_cancellation(state, &session_id)))
    })
    .await
}

/// S4: build an `SshConfig` for a persisted attempt (which stores only
/// `target_id` + paths, not the connection details) by re-resolving the saved
/// `ServerConfig` from storage — the backend analogue of the frontend's
/// `serverStore` lookup. Crucially this carries `host_fingerprint`, so a
/// backend-initiated cancel/cleanup pins the host key exactly like the
/// spec-driven path, instead of deferring to the frontend or falling back to
/// TOFU. Returns `None` if the server is no longer configured.
pub(super) fn resolve_server_ssh_config(target_id: &str, base_path: &str) -> Option<SshConfig> {
    let state = storage::load_state();
    let server = state.servers.iter().find(|s| s.id == target_id)?;
    Some(ssh_config_from_server(server, base_path))
}

/// Pure mapping from a saved `ServerConfig` to a per-cleanup `SshConfig`. Split
/// out from the storage lookup so the fingerprint-propagation contract (S4) is
/// unit-testable without touching disk.
fn ssh_config_from_server(
    server: &crate::core::storage::ServerConfig,
    base_path: &str,
) -> SshConfig {
    SshConfig {
        host: server.host.clone(),
        port: server.port,
        user: server.username.clone(),
        remote_path: base_path.to_string(),
        key_path: server.key_path.clone(),
        auth_method: Some(server.auth_method.clone()),
        target_id: Some(server.id.clone()),
        host_fingerprint: server.host_fingerprint.clone(),
    }
}

fn build_ssh_config_from_spec(spec: &AttemptTargetSpec) -> Option<SshConfig> {
    if let AttemptTargetSpec::Ssh {
        target_id,
        host,
        port,
        user,
        key_path,
        auth_method,
        host_fingerprint,
        base_path,
        ..
    } = spec
    {
        Some(SshConfig {
            host: host.clone(),
            port: *port,
            user: user.clone(),
            remote_path: base_path.clone(),
            key_path: key_path.clone(),
            auth_method: auth_method.clone(),
            target_id: Some(target_id.clone()),
            // Phase 2: propagate the saved `ServerConfig.hostFingerprint`
            // from the picker through the spec so flight attempts pin
            // host keys instead of falling back to TOFU.
            host_fingerprint: host_fingerprint.clone(),
        })
    } else {
        None
    }
}

#[tauri::command]
pub async fn launch_flight_async(
    app_handle: tauri::AppHandle,
    state: tauri::State<'_, Arc<ApiAgentState>>,
    sidecar: tauri::State<'_, Arc<SidecarManager>>,
    flight_id: String,
    prompt: String,
    targets: Vec<AttemptTargetSpec>,
    allow_path_collisions: Option<bool>,
    prepare_only: Option<bool>,
) -> Result<Vec<crate::api::AttemptDto>, String> {
    let admission = super::flight_runtime::launch_admission(&flight_id)?;
    if targets.is_empty() {
        return Err("At least one target is required".to_string());
    }
    let allow_path_collisions = allow_path_collisions.unwrap_or(false);
    validate_target_identities(&targets)?;
    // #8a: fail closed on unpinned SSH targets before any connection/provisioning.
    validate_ssh_pinning(&targets)?;
    let snapshot = storage::load_state();
    if let Some(flight) = snapshot
        .flights
        .iter()
        .find(|flight| flight.id == flight_id)
    {
        if flight.execution_mode == Some(crate::core::flight::FlightExecutionMode::Cooperative) {
            if let Some(target) = &flight.execution_target {
                for spec in &targets {
                    let matches = match spec {
                        AttemptTargetSpec::Local { base_path, .. } => {
                            target.kind == "local"
                                && target.server_id.is_none()
                                && base_path == &target.base_path
                        }
                        AttemptTargetSpec::Ssh {
                            target_id,
                            base_path,
                            ..
                        } => {
                            target.kind == "ssh"
                                && target.server_id.as_ref() == Some(target_id)
                                && base_path == &target.base_path
                        }
                    };
                    if !matches {
                        return Err("The launch target does not match this Flight's saved execution target.".into());
                    }
                }
            }
        }
    }
    if !allow_path_collisions {
        validate_target_claims(&targets)?;
        validate_target_claims_against_active_attempts(&targets)?;
    }

    // v0.8: capture the flight title so the worktree's auto-trailer
    // hook can substitute `{flightTitle}` into the rendered trailer.
    // Read once up front rather than per-attempt so we don't pay the
    // disk hit N times. Missing flight → empty title (the auto-trailer
    // still works, just with the placeholder elided).
    let flight_title = {
        let flight_id = flight_id.clone();
        tokio::task::spawn_blocking(move || {
            storage::load_state()
                .flights
                .into_iter()
                .find(|f| f.id == flight_id)
                .map(|f| f.title)
                .unwrap_or_default()
        })
        .await
        .map_err(|e| format!("flight title lookup join error: {}", e))?
    };

    let mut launched: Vec<Attempt> = Vec::new();

    for spec in targets {
        if admission.cancel.is_cancelled() {
            return Err("Flight launch stopped; existing worktrees were retained.".into());
        }
        let attempt_id = format!("att_{}", Uuid::new_v4().simple());
        let session_id = attempt_id.clone();
        let branch = worktree::branch_name(&attempt_id);
        let task_id = match &spec {
            AttemptTargetSpec::Local { task_id, .. } | AttemptTargetSpec::Ssh { task_id, .. } => {
                task_id.clone()
            }
        };

        let flight = worktree::WorktreeFlight {
            flight_id: Some(flight_id.clone()),
            flight_title: Some(flight_title.clone()),
        };

        let (target, ssh_config_for_session, agent_config_id, provider, model, base_branch) =
            match &spec {
                AttemptTargetSpec::Local {
                    base_path,
                    base_branch,
                    agent_config_id,
                    provider,
                    model,
                    ..
                } => {
                    let path = worktree::create_local_worktree_with_flight(
                        base_path,
                        &attempt_id,
                        base_branch,
                        flight.clone(),
                    )
                    .await
                    .map_err(|e| format!("Local worktree provision failed: {}", e))?;
                    (
                        AttemptTarget::Local {
                            base_path: base_path.clone(),
                            worktree_path: path,
                        },
                        None,
                        agent_config_id.clone(),
                        provider.clone(),
                        model.clone(),
                        base_branch.clone(),
                    )
                }
                AttemptTargetSpec::Ssh {
                    base_path,
                    base_branch,
                    agent_config_id,
                    provider,
                    model,
                    ..
                } => {
                    // #8a defense-in-depth: re-enforce host-key pinning at the
                    // connection boundary so this remains fail-closed even if a
                    // future caller reaches the build site without the upfront
                    // `validate_ssh_pinning` gate. `build_ssh_config_from_spec`
                    // copies `host_fingerprint` verbatim and `core/execution.rs`
                    // would otherwise TOFU-fallback to `accept-new`.
                    validate_ssh_pinning(std::slice::from_ref(&spec))?;
                    let cfg =
                        build_ssh_config_from_spec(&spec).ok_or("Failed to build SshConfig")?;
                    let path =
                        worktree::create_remote_worktree(&cfg, base_path, &attempt_id, base_branch)
                            .await
                            .map_err(|e| format!("Remote worktree provision failed: {}", e))?;
                    // SshConfig used by the API agent session must point at the
                    // worktree, not the original base path, so all tool calls
                    // operate inside the attempt's worktree.
                    let session_cfg = SshConfig {
                        remote_path: path.clone(),
                        ..cfg.clone()
                    };
                    (
                        AttemptTarget::Ssh {
                            server_id: cfg.target_id.clone().unwrap_or_default(),
                            base_path: base_path.clone(),
                            worktree_path: path,
                        },
                        Some(session_cfg),
                        agent_config_id.clone(),
                        provider.clone(),
                        model.clone(),
                        base_branch.clone(),
                    )
                }
            };

        // For Local targets, pass the worktree path as the project_path so the
        // API agent's tool runtime executes inside the worktree.
        let project_path = match &target {
            AttemptTarget::Local { worktree_path, .. } => worktree_path.clone(),
            AttemptTarget::Ssh { worktree_path, .. } => worktree_path.clone(),
        };

        let mut attempt = Attempt {
            id: attempt_id.clone(),
            flight_id: flight_id.clone(),
            target,
            agent_config_id: agent_config_id.clone(),
            model: model.clone(),
            provider: provider.clone(),
            branch,
            base_branch,
            session_id: session_id.clone(),
            status: AttemptStatus::Provisioning,
            started_at: Some(now_ms()),
            completed_at: None,
            cost: 0.0,
            tokens: 0,
            error_message: None,
            failure_category: None,
            review_gate: None,
            session_history: None,
            recovery: None,
            delivery: None,
            task_id,
            draft_pr_number: None,
        };

        if admission.cancel.is_cancelled()
            || super::flight_runtime::ensure_flight_allowed(&flight_id).is_err()
        {
            attempt.status = AttemptStatus::Cancelled;
            attempt.completed_at = Some(now_ms());
            super::flight_runtime::retained(
                &mut attempt,
                "Launch stopped during provisioning; worktree retained.",
                now_ms(),
            );
            append_attempt(&flight_id, &attempt, true, Some(prompt.clone())).await?;
            return Err("Flight launch stopped during provisioning; its worktree was retained for recovery.".into());
        }

        if let Err(e) = append_attempt(
            &flight_id,
            &attempt,
            allow_path_collisions,
            Some(prompt.clone()),
        )
        .await
        {
            warn!(error = %e, "Failed to persist Attempt; aborting");
            cleanup_unpersisted_attempt(&spec, &attempt.target, &attempt_id).await;
            return Err(e);
        }

        // The frontend uses this phase to register both the conversation and
        // its permission/terminal listeners before dispatching any provider.
        // Ownership is already durable, so Stop can fence the prepared session.
        if prepare_only.unwrap_or(false) {
            launched.push(attempt);
            continue;
        }

        // Hand off to the existing API agent session machinery. session_id is
        // shared with the agentTaskStore conversation id on the frontend so
        // the AttemptTile can subscribe to streaming events.
        let (final_status, final_error) = match start_api_agent_session(
            app_handle.clone(),
            state.clone(),
            sidecar.clone(),
            session_id.clone(),
            provider.clone(),
            model.clone(),
            project_path,
            prompt.clone(),
            None,        // system_prompt_override — use default
            Some(false), // thinking_enabled
            None,        // attachments
            Some(false), // plan_mode
            ssh_config_for_session,
            None,        // allowed_tools — flight attempts use full tool set
            None,        // resume_token — flights start fresh
            None,        // enabled_mcp_server_ids — flights use all enabled MCP servers
            None,        // mcp_trust_snapshot — conservative read-only migration
            None,        // resume_messages — flights start fresh
            None,        // permission_mode — default AskForRisky
            Some(false), // approve_writes
            None,        // command_path
            None,        // workspace — derived from ssh_config/local project_path
            None,        // budget_scope_key — flight attempts run without a session budget
            None,        // budget_limit_usd
        )
        .await
        {
            Ok(()) => {
                let _ =
                    update_attempt_status(&flight_id, &attempt_id, AttemptStatus::Running, None)
                        .await;
                (AttemptStatus::Running, None)
            }
            Err(e) => {
                let message = format!("Session start failed: {}", e);
                let _ = update_attempt_status(
                    &flight_id,
                    &attempt_id,
                    AttemptStatus::Failed,
                    Some(message.clone()),
                )
                .await;
                let id = attempt_id.clone();
                let fid = flight_id.clone();
                storage::with_state_lock(move |snapshot| { if let Some(attempt) = snapshot.flights.iter_mut().find(|flight| flight.id == fid).and_then(|flight| flight.attempts.iter_mut().find(|attempt| attempt.id == id)) { super::flight_runtime::retained(attempt, "Session startup failed or was stopped; worktree retained for inspection and explicit recovery.", now_ms()); } std::future::ready(Ok(())) }).await?;
                (AttemptStatus::Failed, Some(message))
            }
        };

        info!(
            flight = %flight_id,
            attempt = %attempt_id,
            agent = %agent_config_id,
            "Launched async attempt"
        );
        launched.push(Attempt {
            status: final_status,
            completed_at: if matches!(
                final_status,
                AttemptStatus::Completed | AttemptStatus::Failed | AttemptStatus::Cancelled
            ) {
                Some(now_ms())
            } else {
                None
            },
            failure_category: if final_status == AttemptStatus::Failed {
                final_error.as_deref().map(|m| {
                    crate::core::error_classifier::classify_cli_error(m)
                        .category
                        .as_str()
                        .to_string()
                })
            } else {
                None
            },
            error_message: final_error,
            ..attempt
        });
    }

    let latest_state = storage::load_state();
    if let Some(flight) = latest_state.flights.iter().find(|f| f.id == flight_id) {
        let latest_attempts = launched
            .iter()
            .map(|attempt| {
                flight
                    .attempts
                    .iter()
                    .find(|current| current.id == attempt.id)
                    .cloned()
                    .unwrap_or_else(|| attempt.clone())
                    .into()
            })
            .collect();
        Ok(latest_attempts)
    } else {
        Ok(launched.into_iter().map(Into::into).collect())
    }
}

/// Tear down one attempt's worktree, reporting failure as data.
///
/// `ssh` is the already-resolved connection for an SSH attempt; `None` means
/// the saved `ServerConfig` is gone, which is reported as `deferred` (the
/// frontend can re-issue `cleanup_attempt_worktree_ssh` with live host
/// details) rather than as success.
async fn cleanup_attempt_worktree_with(
    attempt_id: &str,
    target: &AttemptTarget,
    ssh: Option<SshConfig>,
) -> worktree::WorktreeCleanupOutcome {
    match target {
        AttemptTarget::Local { base_path, .. } => {
            let path = worktree::worktree_path(base_path, attempt_id)
                .unwrap_or_else(|_| base_path.to_string());
            let mut outcome = worktree::WorktreeCleanupOutcome::for_path(path);
            match worktree::remove_local_worktree(base_path, attempt_id, false).await {
                Ok(()) => outcome.removed = true,
                Err(e) => {
                    warn!(attempt = %attempt_id, error = %e, "Local worktree cleanup failed");
                    outcome.error = Some(e);
                }
            }
            outcome
        }
        AttemptTarget::Ssh { base_path, .. } => {
            let path = worktree::worktree_path(base_path, attempt_id)
                .unwrap_or_else(|_| base_path.to_string());
            let mut outcome = worktree::WorktreeCleanupOutcome::for_path(path);
            match ssh {
                Some(cfg) => {
                    match worktree::remove_remote_worktree(&cfg, base_path, attempt_id).await {
                        Ok(()) => outcome.removed = true,
                        Err(e) => {
                            warn!(attempt = %attempt_id, error = %e, "Remote worktree cleanup failed");
                            outcome.error = Some(e);
                        }
                    }
                }
                None => {
                    warn!(attempt = %attempt_id, "SSH worktree cleanup deferred — server no longer configured; frontend may re-issue cleanup_attempt_worktree_ssh");
                    outcome.deferred = true;
                }
            }
            outcome
        }
    }
}

/// S4 wrapper: resolve the saved `ServerConfig` (pinning the host key via its
/// saved fingerprint) before tearing the worktree down.
async fn cleanup_attempt_worktree(
    attempt_id: &str,
    target: &AttemptTarget,
) -> worktree::WorktreeCleanupOutcome {
    let ssh = match target {
        AttemptTarget::Ssh {
            base_path,
            server_id,
            ..
        } => resolve_server_ssh_config(server_id, base_path),
        AttemptTarget::Local { .. } => None,
    };
    cleanup_attempt_worktree_with(attempt_id, target, ssh).await
}

/// Report retained paths after restart. This deliberately performs no Git,
/// filesystem deletion or SSH connection; only explicit Discard may clean up.
pub async fn sweep_interrupted_attempts(
    interrupted: Vec<crate::core::orchestrator::InterruptedAttempt>,
) {
    if interrupted.is_empty() {
        return;
    }
    info!(
        count = interrupted.len(),
        "Retaining worktrees for attempts interrupted by a previous run"
    );
    for entry in interrupted {
        let path = match &entry.target {
            AttemptTarget::Local { worktree_path, .. }
            | AttemptTarget::Ssh { worktree_path, .. } => worktree_path,
        };
        info!(flight = %entry.flight_id, attempt = %entry.attempt_id, path, "Interrupted worktree retained; recovery never deletes or connects to it");
    }
}

/// Cancel an attempt: close its session, mark it cancelled, remove its
/// worktree.
///
/// Returns the worktree teardown outcome instead of swallowing it. Cleanup
/// failure is deliberately NON-FATAL — the attempt is cancelled either way —
/// but it is now visible to the caller, so `deleteFlightWithAttemptCleanup`
/// can report a worktree that is still on disk instead of showing the user a
/// clean delete.
#[tauri::command]
pub async fn cancel_flight_attempt(
    state: tauri::State<'_, Arc<ApiAgentState>>,
    sidecar: tauri::State<'_, Arc<SidecarManager>>,
    flight_id: String,
    attempt_id: String,
) -> Result<worktree::WorktreeCleanupOutcome, String> {
    // 1. Pull a snapshot of the attempt so we can clean up the worktree
    //    after closing the session.
    let attempt = {
        let s = storage::load_state();
        s.flights
            .iter()
            .find(|f| f.id == flight_id)
            .and_then(|f| f.attempts.iter().find(|a| a.id == attempt_id).cloned())
            .ok_or_else(|| format!("Attempt '{}' not found", attempt_id))?
    };

    // 2. Close the API agent session (cancels the loop + drops history).
    let mut ids = std::collections::HashSet::from([attempt.session_id.clone()]);
    ids.extend(
        attempt
            .session_history
            .iter()
            .flatten()
            .map(|owner| owner.session_id.clone()),
    );
    if let Some(gate) = &attempt.review_gate {
        ids.extend(gate.reviewer_conversation_id.iter().cloned());
        ids.extend(
            gate.reviewer_sessions
                .iter()
                .map(|session| session.session_id.clone()),
        );
    }
    let mut starts = Vec::new();
    for id in &ids {
        if let Some(start) = super::flight_runtime::cancel_session_start(id) {
            starts.push(start);
        }
    }
    for id in ids {
        close_api_agent_session(state.clone(), sidecar.clone(), id.clone()).await?;
        state.wait_for_session_stop(&id).await?;
    }
    super::flight_runtime::drain(starts).await?;

    // 3. Mark cancelled before worktree removal so the UI flips quickly.
    let _ = update_attempt_status(&flight_id, &attempt_id, AttemptStatus::Cancelled, None).await;

    // 4. Remove the worktree. For SSH we re-resolve the saved `ServerConfig`
    //    by server_id so the host key is pinned via the saved fingerprint;
    //    only if the server is gone do we defer to the frontend.
    let outcome = cleanup_attempt_worktree(&attempt_id, &attempt.target).await;
    if outcome.removed {
        let id = attempt_id.clone();
        storage::with_state_lock(move |snapshot| {
            if let Some(attempt) = snapshot
                .flights
                .iter_mut()
                .find(|flight| flight.id == flight_id)
                .and_then(|flight| flight.attempts.iter_mut().find(|attempt| attempt.id == id))
            {
                if let Some(recovery) = &mut attempt.recovery {
                    recovery.state = crate::core::flight::RecoveryState::Discarded;
                }
            }
            std::future::ready(Ok(()))
        })
        .await?;
    }
    Ok(outcome)
}

/// Remove a Flight's cooperative integration worktree.
///
/// The integration worktree is flight-keyed, not attempt-keyed, so none of the
/// attempt cleanup commands can reach it — deleting a cooperative Flight used
/// to leave `<base>/.pkt-flight-integrations/<flight_id>` (and its
/// `packetbench/flight/<flight_id>` branch) behind forever.
///
/// `server_id` selects the remote twin and is resolved from saved servers, so
/// a deleted server surfaces as `deferred` rather than a silent no-op.
/// `delete_branch` uses the safe `git branch -d`: the integration branch can
/// be the only ref to merged-but-unlanded attempt work, and a refusal is
/// reported in `branch_retained` rather than forced.
#[tauri::command]
pub async fn cleanup_flight_integration_worktree(
    flight_id: String,
    base_path: String,
    server_id: Option<String>,
    delete_branch: bool,
) -> Result<worktree::WorktreeCleanupOutcome, String> {
    match server_id {
        None => {
            worktree::remove_local_integration_worktree(&base_path, &flight_id, delete_branch).await
        }
        Some(server_id) => match resolve_server_ssh_config(&server_id, &base_path) {
            Some(cfg) => {
                worktree::remove_remote_integration_worktree(
                    &cfg,
                    &base_path,
                    &flight_id,
                    delete_branch,
                )
                .await
            }
            None => {
                warn!(flight = %flight_id, server = %server_id, "Integration worktree cleanup deferred — server no longer configured");
                let mut outcome = worktree::WorktreeCleanupOutcome::for_path(
                    worktree::integration_worktree_path(&base_path, &flight_id)
                        .unwrap_or_else(|_| base_path.clone()),
                );
                outcome.deferred = true;
                Ok(outcome)
            }
        },
    }
}

#[tauri::command]
pub async fn cleanup_attempt_worktree_ssh(
    flight_id: String,
    attempt_id: String,
    host: String,
    port: u16,
    user: String,
    key_path: Option<String>,
    base_path: String,
    target_id: String,
    // Phase 2: optional pinned fingerprint, sourced from the saved
    // `ServerConfig.hostFingerprint`. Falls back to TOFU when absent
    // (legacy callers that haven't been updated yet).
    host_fingerprint: Option<String>,
) -> Result<(), String> {
    let cfg = SshConfig {
        host,
        port,
        user,
        remote_path: base_path.clone(),
        key_path,
        target_id: Some(target_id),
        host_fingerprint,
        auth_method: None,
    };
    let _ = (flight_id, attempt_id.clone());
    worktree::remove_remote_worktree(&cfg, &base_path, &attempt_id).await
}

/// v0.8-G: record the draft PR number published for an attempt. Called
/// after the frontend successfully pushes the attempt branch and opens a
/// draft PR via `github_create_pr`. The number is later surfaced in the
/// Flight detail UI as a "Draft PR #N" link.
#[tauri::command]
pub async fn set_attempt_draft_pr(
    flight_id: String,
    attempt_id: String,
    pr_number: u32,
    delivery: Option<crate::api::FlightDeliveryDto>,
) -> Result<(), String> {
    if let Some(delivery) = &delivery {
        if delivery.kind != "pull_request" || delivery.pr_number != Some(pr_number) {
            return Err("PR delivery must match the created PR number.".into());
        }
        super::flight_runtime::validate_delivery_record(&flight_id, &attempt_id, delivery).await?;
    }
    // v0.8 race-fix: hold the async state lock across load → mutate → save
    // so a concurrent `set_attempt_draft_pr` (e.g. retry path or duplicate
    // publish guard race) can't clobber the first writer's PR number.
    storage::with_state_lock(move |state| {
        let result: Result<(), String> = (|| {
            let flight = state
                .flights
                .iter_mut()
                .find(|f| f.id == flight_id)
                .ok_or_else(|| format!("Flight '{}' not found", flight_id))?;
            if let Some(delivery) = delivery {
                super::flight_runtime::apply_delivery(flight, &attempt_id, delivery.into())?;
            }
            let attempt = flight
                .attempts
                .iter_mut()
                .find(|a| a.id == attempt_id)
                .ok_or_else(|| format!("Attempt '{}' not found", attempt_id))?;
            attempt.draft_pr_number = Some(pr_number);
            flight.updated_at = now_ms();
            Ok(())
        })();
        std::future::ready(result)
    })
    .await
}

/// v0.8-G: persist the Flight's `publish_attempts_as_prs` boolean. Lets
/// the frontend toggle flow through to storage without a full Flight
/// upsert — keeps the asyncFlightStore path lean.
#[tauri::command]
pub async fn set_flight_publish_attempts_as_prs(
    flight_id: String,
    enabled: bool,
) -> Result<(), String> {
    // Serialize against other attempt/cost writers via `with_state_lock` so
    // concurrent saves can't drop the toggle flip.
    storage::with_state_lock(move |state| {
        let result: Result<(), String> = (|| {
            let flight = state
                .flights
                .iter_mut()
                .find(|f| f.id == flight_id)
                .ok_or_else(|| format!("Flight '{}' not found", flight_id))?;
            flight.publish_attempts_as_prs = enabled;
            flight.updated_at = now_ms();
            Ok(())
        })();
        std::future::ready(result)
    })
    .await
}

/// Persist an attempt's Reviewer Gate record.
///
/// The gate is **backend-owned**, like every other attempt lifecycle field.
/// `merge_attempts_for_frontend_save` keeps the backend's copy of an attempt
/// that already exists and takes only independently-derived counters from a
/// whole-slice frontend save, so a `review_gate` authored by the frontend
/// store was discarded on the very next save. `update_attempt_status` then
/// read a field it could never receive and refused every gated acceptance
/// with "Reviewer Gate has not produced a verdict". The reviewer runtime
/// therefore writes through here, under `with_state_lock`, and the merge
/// preserves what this command wrote.
///
/// `review_gate: None` clears the verdict while retaining immutable reviewer
/// owners: delayed usage callbacks can outlive a retry or explicit reset.
#[tauri::command]
pub async fn set_attempt_review_gate(
    flight_id: String,
    attempt_id: String,
    review_gate: Option<crate::api::AttemptReviewGateDto>,
) -> Result<(), String> {
    let gate: Option<crate::core::flight::AttemptReviewGate> = review_gate.map(Into::into);
    if let Some(gate) = &gate {
        if gate.status == ReviewGateStatus::Passed {
            let snapshot = storage::load_state();
            let flight = snapshot
                .flights
                .iter()
                .find(|flight| flight.id == flight_id)
                .ok_or_else(|| format!("Flight '{}' not found", flight_id))?;
            let attempt = flight
                .attempts
                .iter()
                .find(|attempt| attempt.id == attempt_id)
                .ok_or_else(|| format!("Attempt '{}' not found", attempt_id))?;
            super::flight_review::validate(flight, attempt, gate.evidence.as_ref()).await?;
        }
    }
    storage::with_state_lock(move |state| {
        let result: Result<(), String> = (|| {
            let flight = state
                .flights
                .iter_mut()
                .find(|f| f.id == flight_id)
                .ok_or_else(|| format!("Flight '{}' not found", flight_id))?;
            if gate
                .as_ref()
                .is_some_and(|gate| gate.status == ReviewGateStatus::Passed)
            {
                let attempt = flight
                    .attempts
                    .iter()
                    .find(|attempt| attempt.id == attempt_id)
                    .ok_or("Attempt not found.")?;
                let incoming = gate.as_ref().unwrap();
                if incoming.evidence.as_ref().is_none_or(|evidence| {
                    evidence.context_fingerprint
                        != super::flight_review::context_fingerprint(flight, attempt)
                }) {
                    return Err("The review criteria changed. Run the reviewer again.".into());
                }
                let previous = attempt
                    .review_gate
                    .as_ref()
                    .ok_or("The reviewer run is no longer current.")?;
                if previous.reviewer_conversation_id != incoming.reviewer_conversation_id
                    || previous.evidence != incoming.evidence
                    || previous.status != ReviewGateStatus::Running
                {
                    return Err(
                        "The reviewer run is no longer current. Run the reviewer again.".into(),
                    );
                }
            }
            let attempt = flight
                .attempts
                .iter_mut()
                .find(|a| a.id == attempt_id)
                .ok_or_else(|| format!("Attempt '{}' not found", attempt_id))?;
            let mut gate = gate;
            if gate.is_none() {
                if let Some(previous) = &attempt.review_gate {
                    let mut pending = previous.clone();
                    pending.status = ReviewGateStatus::Pending;
                    pending.evidence = None;
                    pending.report = None;
                    pending.error_message = None;
                    pending.completed_at = None;
                    pending.overridden_at = None;
                    pending.override_reason = None;
                    gate = Some(pending);
                }
            }
            if let Some(incoming) = &mut gate {
                preserve_reviewer_sessions(attempt.review_gate.as_ref(), incoming);
            }
            attempt.review_gate = gate;
            flight.updated_at = now_ms();
            Ok(())
        })();
        std::future::ready(result)
    })
    .await
}

/// Keep every registered reviewer owner when a retry replaces the active gate.
/// Usage callbacks may arrive after the old provider has finished/cancelled.
fn preserve_reviewer_sessions(
    previous: Option<&crate::core::flight::AttemptReviewGate>,
    incoming: &mut crate::core::flight::AttemptReviewGate,
) {
    let mut sessions = previous
        .map(|gate| gate.reviewer_sessions.clone())
        .unwrap_or_default();
    if let Some(previous) = previous {
        if let Some(session_id) = &previous.reviewer_conversation_id {
            if !sessions
                .iter()
                .any(|session| &session.session_id == session_id)
            {
                let agent = previous
                    .reviewer_agent_config_id
                    .as_deref()
                    .unwrap_or_default();
                sessions.push(crate::core::flight::ReviewerSession {
                    session_id: session_id.clone(),
                    provider: if agent == "api-claude" {
                        "anthropic".into()
                    } else {
                        agent.trim_start_matches("api-").to_string()
                    },
                    model: previous.reviewer_model.clone().unwrap_or_default(),
                });
            }
        }
    }
    for session in &incoming.reviewer_sessions {
        if !sessions
            .iter()
            .any(|old| old.session_id == session.session_id)
        {
            sessions.push(session.clone());
        }
    }
    incoming.reviewer_sessions = sessions;
}

/// Set an attempt's status. Terminal statuses additionally close the session
/// and tear the worktree down.
///
/// Returns the teardown outcome for terminal transitions (`None` for
/// non-terminal ones) so a failed removal is visible to the frontend instead
/// of being `warn!`-logged and dropped — the same hole `cancel_flight_attempt`
/// had.
fn attempt_session_ids(attempt: &Attempt) -> std::collections::HashSet<String> {
    let mut ids = std::collections::HashSet::from([attempt.session_id.clone()]);
    ids.extend(
        attempt
            .session_history
            .iter()
            .flatten()
            .map(|owner| owner.session_id.clone()),
    );
    if let Some(gate) = &attempt.review_gate {
        ids.extend(gate.reviewer_conversation_id.iter().cloned());
        ids.extend(
            gate.reviewer_sessions
                .iter()
                .map(|owner| owner.session_id.clone()),
        );
    }
    ids
}

async fn retain_interrupted_attempt<F, Fut>(
    flight_id: &str,
    attempt: &Attempt,
    status: AttemptStatus,
    mut stop_owner: F,
) -> Result<Option<worktree::WorktreeCleanupOutcome>, String>
where
    F: FnMut(String) -> Fut,
    Fut: std::future::Future<Output = Result<(), String>>,
{
    update_attempt_status(flight_id, &attempt.id, status, None).await?;
    let saved_flight = flight_id.to_string();
    let saved_attempt = attempt.id.clone();
    let saved_session = attempt.session_id.clone();
    storage::with_state_lock(move |snapshot| {
        if let Some(attempt) = snapshot.flights.iter_mut().find(|flight| flight.id == saved_flight).and_then(|flight| flight.attempts.iter_mut().find(|attempt| attempt.id == saved_attempt && attempt.session_id == saved_session)) {
            super::flight_runtime::retained(attempt, "The attempt was interrupted; its branch and worktree were retained for inspection or explicit recovery.", now_ms());
        }
        std::future::ready(Ok(()))
    }).await?;
    for id in attempt_session_ids(attempt) {
        stop_owner(id).await?;
    }
    Ok(None)
}

async fn accept_after_session_cleanup<F, Fut>(
    flight_id: &str,
    attempt: &Attempt,
    mut stop_owner: F,
) -> Result<(), String>
where
    F: FnMut(String) -> Fut,
    Fut: std::future::Future<Output = Result<(), String>>,
{
    for id in attempt_session_ids(attempt) {
        if let Err(error) = stop_owner(id).await {
            let flight_id = flight_id.to_string();
            let attempt_id = attempt.id.clone();
            let expected_session = attempt.session_id.clone();
            let reason =
                format!("Acceptance could not confirm session cleanup; worktree retained: {error}");
            storage::with_state_lock(move |snapshot| {
                if let Some(flight) = snapshot
                    .flights
                    .iter_mut()
                    .find(|flight| flight.id == flight_id)
                {
                    if let Some(attempt) = flight.attempts.iter_mut().find(|attempt| {
                        attempt.id == attempt_id
                            && attempt.session_id == expected_session
                            && attempt.status != AttemptStatus::Completed
                    }) {
                        if attempt.status == AttemptStatus::Reviewing {
                            attempt.status = AttemptStatus::Failed;
                            attempt.completed_at = Some(now_ms());
                            if let Some(task) = flight
                                .milestones
                                .iter_mut()
                                .flat_map(|milestone| &mut milestone.tasks)
                                .find(|task| attempt.task_id.as_ref() == Some(&task.id))
                            {
                                task.status = crate::core::flight::TaskStatus::Failed;
                            }
                        }
                        attempt.error_message = Some(reason.clone());
                        super::flight_runtime::retained(attempt, &reason, now_ms());
                        flight.updated_at = now_ms();
                    }
                }
                std::future::ready(Ok(()))
            })
            .await?;
            return Err(error);
        }
    }
    // Closing a live owner can finish a write. Recheck the committed result
    // after acknowledgement, before it can become deliverable.
    let snapshot = storage::load_state();
    let flight = snapshot
        .flights
        .iter()
        .find(|flight| flight.id == flight_id)
        .ok_or("Flight not found.")?;
    let current = flight
        .attempts
        .iter()
        .find(|current| current.id == attempt.id)
        .ok_or("Attempt not found.")?;
    if current.session_id != attempt.session_id || current.status != AttemptStatus::Reviewing {
        return Err(
            "The attempt changed while its sessions were stopping; acceptance was not recorded."
                .into(),
        );
    }
    super::flight_review::validate_acceptance(flight, current).await?;
    update_attempt_status_for_owner(
        flight_id,
        &attempt.id,
        AttemptStatus::Completed,
        None,
        Some(&attempt.session_id),
    )
    .await
}

#[tauri::command]
pub fn trace_flight_action(flight_id: String, attempt_id: String, stage: String) {
    if flight_id.len() <= 200
        && attempt_id.len() <= 200
        && matches!(
            stage.as_str(),
            "started"
                | "native_status_completed"
                | "hydration_started"
                | "hydration_completed"
                | "completed"
        )
    {
        tracing::info!(%flight_id, %attempt_id, %stage, "Frontend Flight action stage");
    }
}

#[tauri::command]
pub async fn mark_attempt_status(
    state: tauri::State<'_, Arc<ApiAgentState>>,
    sidecar: tauri::State<'_, Arc<SidecarManager>>,
    flight_id: String,
    attempt_id: String,
    status: SetAttemptStatus,
) -> Result<Option<worktree::WorktreeCleanupOutcome>, String> {
    let started = std::time::Instant::now();
    tracing::info!(%flight_id, %attempt_id, ?status, "Attempt status request started");
    let new_status = match status {
        SetAttemptStatus::Reviewing => AttemptStatus::Reviewing,
        SetAttemptStatus::Completed => AttemptStatus::Completed,
        SetAttemptStatus::Failed => AttemptStatus::Failed,
        SetAttemptStatus::Cancelled => AttemptStatus::Cancelled,
    };

    let is_terminal = matches!(
        new_status,
        AttemptStatus::Completed | AttemptStatus::Failed | AttemptStatus::Cancelled
    );

    // For terminal states, snapshot the attempt before mutating so we can
    // close its session and clean up its worktree afterwards.
    let attempt_snapshot = if is_terminal {
        let s = storage::load_state();
        s.flights
            .iter()
            .find(|f| f.id == flight_id)
            .and_then(|f| f.attempts.iter().find(|a| a.id == attempt_id).cloned())
    } else {
        None
    };

    if matches!(new_status, AttemptStatus::Failed | AttemptStatus::Cancelled) {
        let attempt = attempt_snapshot.as_ref().ok_or("Attempt not found.")?;
        return retain_interrupted_attempt(&flight_id, attempt, new_status, |id| {
            let state = state.clone();
            let sidecar = sidecar.clone();
            async move {
                close_api_agent_session(state.clone(), sidecar, id.clone()).await?;
                state.wait_for_session_stop(&id).await
            }
        })
        .await;
    }

    if new_status == AttemptStatus::Completed {
        let snapshot = storage::load_state();
        let flight = snapshot
            .flights
            .iter()
            .find(|flight| flight.id == flight_id)
            .ok_or("Flight not found.")?;
        let attempt = flight
            .attempts
            .iter()
            .find(|attempt| attempt.id == attempt_id)
            .ok_or("Attempt not found.")?;
        super::flight_review::validate_acceptance(flight, attempt).await?;
        let attempt = attempt_snapshot.as_ref().ok_or("Attempt not found.")?;
        accept_after_session_cleanup(&flight_id, attempt, |id| {
            let state = state.clone();
            let sidecar = sidecar.clone();
            async move {
                close_api_agent_session(state.clone(), sidecar, id.clone()).await?;
                state.wait_for_session_stop(&id).await
            }
        })
        .await?;
    } else {
        update_attempt_status(&flight_id, &attempt_id, new_status, None).await?;
    }
    tracing::info!(%flight_id, %attempt_id, elapsed_ms = started.elapsed().as_millis() as u64, "Attempt status persisted");

    let Some(attempt) = attempt_snapshot else {
        return Ok(None);
    };
    let cleanup_flight = flight_id.clone();
    let cleanup_attempt = attempt_id.clone();
    storage::with_state_lock(move |snapshot| {
        if let Some(attempt) = snapshot
            .flights
            .iter_mut()
            .find(|flight| flight.id == cleanup_flight)
            .and_then(|flight| {
                flight
                    .attempts
                    .iter_mut()
                    .find(|attempt| attempt.id == cleanup_attempt)
            })
        {
            super::flight_runtime::retained(
                attempt,
                "Awaiting non-destructive cleanup; worktree retained until all sessions stop.",
                now_ms(),
            );
        }
        std::future::ready(Ok(()))
    })
    .await?;

    // Git's non-force cleanup remains authoritative if edits race acceptance.
    if new_status != AttemptStatus::Completed {
        for id in attempt_session_ids(&attempt) {
            close_api_agent_session(state.clone(), sidecar.clone(), id.clone()).await?;
            state.wait_for_session_stop(&id).await?;
        }
    }
    tracing::info!(%flight_id, %attempt_id, elapsed_ms = started.elapsed().as_millis() as u64, "Attempt cleanup sessions stopped");
    let (base_path, path, ssh) = match &attempt.target {
        AttemptTarget::Local {
            base_path,
            worktree_path,
        } => (base_path, worktree_path, None),
        AttemptTarget::Ssh {
            base_path,
            worktree_path,
            server_id,
        } => (
            base_path,
            worktree_path,
            resolve_server_ssh_config(server_id, base_path),
        ),
    };
    let mut outcome = worktree::WorktreeCleanupOutcome::for_path(path.clone());
    let result = if matches!(&attempt.target, AttemptTarget::Ssh { .. })
        && ssh.as_ref().is_none_or(|config| {
            config
                .host_fingerprint
                .as_ref()
                .is_none_or(|fingerprint| fingerprint.trim().is_empty())
        }) {
        Err("The saved SSH target is unavailable or unverified; worktree retained.".into())
    } else {
        worktree::remove_attempt_worktree_safely(base_path, &attempt_id, ssh.as_ref()).await
    };
    outcome.removed = result.is_ok();
    outcome.error = result.err();
    let removed = outcome.removed;
    let error = outcome.error.clone();
    let diagnostic_flight = flight_id.clone();
    let diagnostic_attempt = attempt_id.clone();
    storage::with_state_lock(move |snapshot| { if let Some(attempt) = snapshot.flights.iter_mut().find(|flight| flight.id == flight_id).and_then(|flight| flight.attempts.iter_mut().find(|attempt| attempt.id == attempt_id)) { super::flight_runtime::retained(attempt, error.as_deref().unwrap_or("Accepted worktree cleanup completed; the retained branch remains available for delivery."), now_ms()); if removed { attempt.recovery.as_mut().unwrap().state = crate::core::flight::RecoveryState::Discarded; } } std::future::ready(Ok(())) }).await?;
    tracing::info!(flight_id = %diagnostic_flight, attempt_id = %diagnostic_attempt, elapsed_ms = started.elapsed().as_millis() as u64, removed, "Attempt status request completed");
    Ok(Some(outcome))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::flight::{Flight, FlightPriority, FlightStatus};

    #[test]
    fn reviewer_ledger_survives_retry_and_delayed_writes_without_repricing() {
        let previous = serde_json::from_value(serde_json::json!({"status": "error", "reviewer_sessions": [{"session_id": "old", "provider": "claude-oauth", "model": "review-model"}]})).unwrap();
        let mut incoming = serde_json::from_value(serde_json::json!({"status": "pending", "reviewer_sessions": [{"session_id": "old", "provider": "wrong", "model": "wrong"}, {"session_id": "new", "provider": "openai-agents", "model": "new-model"}]})).unwrap();
        preserve_reviewer_sessions(Some(&previous), &mut incoming);
        assert_eq!(incoming.reviewer_sessions.len(), 2);
        assert_eq!(incoming.reviewer_sessions[0].model, "review-model");
        let mut reset = serde_json::from_value(serde_json::json!({"status": "pending"})).unwrap();
        preserve_reviewer_sessions(Some(&incoming), &mut reset);
        assert_eq!(reset.reviewer_sessions.len(), 2);
    }

    fn local_spec(path: &str) -> AttemptTargetSpec {
        AttemptTargetSpec::Local {
            base_path: path.to_string(),
            base_branch: "main".to_string(),
            agent_config_id: "api-claude".to_string(),
            provider: "claude".to_string(),
            model: "claude-sonnet-4-6".to_string(),
            task_id: None,
        }
    }

    fn ssh_spec(target_id: &str, path: &str) -> AttemptTargetSpec {
        AttemptTargetSpec::Ssh {
            target_id: target_id.to_string(),
            host: "example.test".to_string(),
            port: 22,
            user: "ian".to_string(),
            key_path: None,
            auth_method: None,
            host_fingerprint: None,
            base_path: path.to_string(),
            base_branch: "main".to_string(),
            agent_config_id: "api-claude".to_string(),
            provider: "claude".to_string(),
            model: "claude-sonnet-4-6".to_string(),
            task_id: None,
        }
    }

    fn local_attempt(id: &str, path: &str, status: AttemptStatus) -> Attempt {
        Attempt {
            id: id.to_string(),
            flight_id: "flight-1".to_string(),
            target: AttemptTarget::Local {
                base_path: path.to_string(),
                worktree_path: format!("{}/.git/packetbench-worktrees/{}", path, id),
            },
            agent_config_id: "api-claude".to_string(),
            model: "claude-sonnet-4-6".to_string(),
            provider: "claude".to_string(),
            branch: format!("packetbench/{}", id),
            base_branch: "main".to_string(),
            session_id: id.to_string(),
            status,
            started_at: Some(1),
            completed_at: None,
            cost: 0.0,
            tokens: 0,
            error_message: None,
            failure_category: None,
            review_gate: None,
            session_history: None,
            recovery: None,
            delivery: None,
            task_id: None,
            draft_pr_number: None,
        }
    }

    // S4: a backend-initiated cleanup must pin the host key by carrying the
    // saved ServerConfig.host_fingerprint into the SshConfig — not drop it.
    #[test]
    fn ssh_config_from_server_propagates_fingerprint() {
        let server = crate::core::storage::ServerConfig {
            id: "srv-1".to_string(),
            name: "prod".to_string(),
            host: "example.test".to_string(),
            port: 2222,
            username: "ian".to_string(),
            auth_method: "key".to_string(),
            key_path: Some("~/.ssh/id_ed25519".to_string()),
            remote_path: Some("/srv/work".to_string()),
            last_connected_at: None,
            installed_agents: vec![],
            host_fingerprint: Some("SHA256:abc123".to_string()),
        };
        let cfg = ssh_config_from_server(&server, "/srv/work/base");
        assert_eq!(cfg.host_fingerprint.as_deref(), Some("SHA256:abc123"));
        assert_eq!(cfg.host, "example.test");
        assert_eq!(cfg.port, 2222);
        assert_eq!(cfg.user, "ian");
        assert_eq!(cfg.target_id.as_deref(), Some("srv-1"));
        assert_eq!(cfg.remote_path, "/srv/work/base");
    }

    #[test]
    fn ssh_config_from_server_keeps_none_fingerprint_for_legacy() {
        let server = crate::core::storage::ServerConfig {
            id: "srv-2".to_string(),
            name: "legacy".to_string(),
            host: "old.test".to_string(),
            port: 22,
            username: "root".to_string(),
            auth_method: "agent".to_string(),
            key_path: None,
            remote_path: None,
            last_connected_at: None,
            installed_agents: vec![],
            host_fingerprint: None,
        };
        let cfg = ssh_config_from_server(&server, "/base");
        assert!(cfg.host_fingerprint.is_none());
    }

    #[test]
    fn record_attempt_error_classifies_failed_message() {
        let mut attempt = local_attempt("a1", "/tmp/x", AttemptStatus::Running);
        record_attempt_error(
            &mut attempt,
            AttemptStatus::Failed,
            Some("Error: unauthorized — invalid api key".to_string()),
        );
        assert_eq!(attempt.failure_category.as_deref(), Some("auth"));
        assert_eq!(
            attempt.error_message.as_deref(),
            Some("Error: unauthorized — invalid api key")
        );
    }

    #[test]
    fn record_attempt_error_skips_category_when_not_failed() {
        let mut attempt = local_attempt("a1", "/tmp/x", AttemptStatus::Cancelled);
        record_attempt_error(
            &mut attempt,
            AttemptStatus::Cancelled,
            Some("stopped by user".to_string()),
        );
        assert_eq!(attempt.failure_category, None);
        assert_eq!(attempt.error_message.as_deref(), Some("stopped by user"));
    }

    fn flight_with_attempt(attempt: Attempt) -> Flight {
        Flight {
            id: "flight-1".to_string(),
            title: "Flight".to_string(),
            objective: "Do work".to_string(),
            status: FlightStatus::Active,
            priority: FlightPriority::Medium,
            project_path: "D:/repo".to_string(),
            workspace_id: None,
            git_branch: None,
            milestones: Vec::new(),
            linked_session_ids: Vec::new(),
            created_at: 1,
            updated_at: 1,
            completed_at: None,
            total_cost: 0.0,
            total_tokens: 0,
            prompt: None,
            attempts: vec![attempt],
            review_gate_policy: None,
            execution_mode: None,
            execution_target: None,
            integration_branch: None,
            coordination_inbox: Vec::new(),
            autonomy_mode: None,
            autonomy_policy: None,
            autonomy_runtime: None,
            delivery: None,
            archived_at: None,
            stopped_at: None,
            planning_conversation_id: None,
            planner_session_id: None,
            planner_status: None,
            planner_cost: None,
            planner_tokens: None,
            planner_provider: None,
            publish_attempts_as_prs: false,
            coordination_log: Vec::new(),
        }
    }

    #[test]
    fn validate_target_claims_blocks_duplicate_roots() {
        let result = validate_target_claims(&[local_spec("D:\\Repo"), local_spec("d:/repo/src")]);

        assert!(result
            .expect_err("duplicate target roots should be rejected")
            .contains("path_collision"),);
    }

    #[test]
    fn validate_target_identities_rejects_blank_ssh_target_id() {
        let result = validate_target_identities(&[ssh_spec("", "/repo")]);

        assert!(result
            .expect_err("blank SSH target id should be rejected")
            .contains("target_id"));
    }

    #[test]
    fn ssh_claims_are_case_sensitive() {
        let upper = target_spec_claim(&ssh_spec("server-1", "/repo/Foo")).unwrap();
        let lower = target_spec_claim(&ssh_spec("server-1", "/repo/foo")).unwrap();

        assert!(!claims_overlap(&upper, &lower));
    }

    #[test]
    fn active_attempt_collision_blocks_running_same_root() {
        let incoming = local_attempt("att-new", "d:/repo", AttemptStatus::Provisioning);
        let existing = local_attempt("att-running", "D:\\Repo\\src", AttemptStatus::Running);

        let message = active_attempt_collision_message(&incoming, &existing)
            .expect("overlapping running attempt should collide");

        assert!(message.contains("att-running"));
        assert!(message.contains("path_collision"));
    }

    #[test]
    fn active_attempt_collision_ignores_completed_attempts() {
        let incoming = local_attempt("att-new", "d:/repo", AttemptStatus::Provisioning);
        let existing = local_attempt("att-done", "D:\\Repo", AttemptStatus::Completed);

        assert!(active_attempt_collision_message(&incoming, &existing).is_none());
    }

    #[test]
    fn startup_running_status_does_not_regress_terminal_or_reviewing_attempts() {
        assert!(should_apply_attempt_status(
            AttemptStatus::Provisioning,
            AttemptStatus::Running
        ));
        assert!(!should_apply_attempt_status(
            AttemptStatus::Reviewing,
            AttemptStatus::Running
        ));
        assert!(!should_apply_attempt_status(
            AttemptStatus::Failed,
            AttemptStatus::Running
        ));
    }

    #[test]
    fn prepared_attempt_wire_uses_frontend_dto_identity() {
        let attempt = local_attempt("wire-session", "D:/fixture", AttemptStatus::Provisioning);
        let dto: crate::api::AttemptDto = attempt.into();
        let wire = serde_json::to_value(dto).unwrap();
        assert_eq!(wire["sessionId"], "wire-session");
        assert_eq!(wire["agentConfigId"], "api-claude");
        assert_eq!(wire["flightId"], "flight-1");
        assert!(wire["target"]["worktreePath"].as_str().is_some());
        assert!(wire.get("session_id").is_none());
        assert!(wire["target"].get("worktree_path").is_none());
    }

    #[test]
    fn reviewing_status_never_revives_a_settled_attempt() {
        for status in [
            AttemptStatus::Completed,
            AttemptStatus::Cancelled,
            AttemptStatus::Failed,
        ] {
            assert!(!should_apply_attempt_status(
                status,
                AttemptStatus::Reviewing
            ));
        }
        assert!(should_apply_attempt_status(
            AttemptStatus::Provisioning,
            AttemptStatus::Reviewing
        ));
    }

    #[test]
    fn stop_between_provision_and_append_retains_a_cancelled_prepared_attempt() {
        let mut attempt = local_attempt("builder", "D:/fixture", AttemptStatus::Provisioning);
        let mut flight = flight_with_attempt(attempt.clone());
        flight.stopped_at = Some(99);
        fence_prepared_attempt(&flight, &mut attempt);
        assert_eq!(attempt.status, AttemptStatus::Cancelled);
        assert!(matches!(
            attempt.recovery.as_ref().unwrap().state,
            crate::core::flight::RecoveryState::Retained
        ));
        assert!(attempt.completed_at.is_some());
    }

    #[test]
    fn stopped_flight_rejects_late_session_running_and_reviewing_updates() {
        let mut state = storage::PersistedState::default();
        let mut flight = flight_with_attempt(local_attempt(
            "builder",
            "D:/fixture",
            AttemptStatus::Running,
        ));
        flight.stopped_at = Some(99);
        state.flights.push(flight);
        for status in [AttemptStatus::Reviewing, AttemptStatus::Running] {
            assert!(!apply_attempt_status_by_session(
                &mut state, "builder", status, None
            ));
            assert_eq!(state.flights[0].attempts[0].status, AttemptStatus::Running);
        }
    }

    #[test]
    fn apply_attempt_status_by_session_moves_active_attempt_to_reviewing() {
        let mut state = storage::PersistedState::default();
        state.flights = vec![flight_with_attempt(local_attempt(
            "session-1",
            "D:\\Repo",
            AttemptStatus::Running,
        ))];

        let updated = apply_attempt_status_by_session(
            &mut state,
            "session-1",
            AttemptStatus::Reviewing,
            None,
        );

        assert!(updated);
        let attempt = &state.flights[0].attempts[0];
        assert_eq!(attempt.status, AttemptStatus::Reviewing);
        assert!(attempt.completed_at.is_none());
    }

    #[test]
    fn apply_attempt_status_by_session_does_not_clobber_cancelled_attempt() {
        let mut state = storage::PersistedState::default();
        let mut attempt = local_attempt("session-1", "D:\\Repo", AttemptStatus::Cancelled);
        attempt.completed_at = Some(123);
        state.flights = vec![flight_with_attempt(attempt)];

        let updated = apply_attempt_status_by_session(
            &mut state,
            "session-1",
            AttemptStatus::Reviewing,
            None,
        );

        assert!(!updated);
        let attempt = &state.flights[0].attempts[0];
        assert_eq!(attempt.status, AttemptStatus::Cancelled);
        assert_eq!(attempt.completed_at, Some(123));
    }

    #[test]
    fn builder_chat_cancellation_retains_each_active_current_owner() {
        for status in [
            AttemptStatus::Queued,
            AttemptStatus::Provisioning,
            AttemptStatus::Running,
        ] {
            let attempt = local_attempt("current-builder", "D:/fixture", status);
            let target = attempt.target.clone();
            let branch = attempt.branch.clone();
            let mut state = storage::PersistedState::default();
            state.flights.push(flight_with_attempt(attempt));
            assert!(apply_builder_cancellation(&mut state, "current-builder"));
            let attempt = &state.flights[0].attempts[0];
            assert_eq!(attempt.status, AttemptStatus::Cancelled);
            assert!(attempt.completed_at.is_some());
            assert_eq!(
                serde_json::to_value(&attempt.target).unwrap(),
                serde_json::to_value(&target).unwrap()
            );
            assert_eq!(attempt.branch, branch);
            assert!(matches!(
                attempt.recovery.as_ref().unwrap().state,
                crate::core::flight::RecoveryState::Retained
            ));
        }
    }

    #[test]
    fn builder_chat_cancellation_cannot_change_historical_or_settled_owners() {
        for status in [
            AttemptStatus::Running,
            AttemptStatus::Reviewing,
            AttemptStatus::Completed,
            AttemptStatus::Failed,
            AttemptStatus::Cancelled,
        ] {
            let mut attempt = local_attempt("current-builder", "D:/fixture", status);
            attempt.session_history = Some(vec![crate::core::flight::ReviewerSession {
                session_id: "old-builder".into(),
                provider: "anthropic".into(),
                model: "model".into(),
            }]);
            let mut state = storage::PersistedState::default();
            state.flights.push(flight_with_attempt(attempt));
            let before = serde_json::to_value(&state).unwrap();
            assert!(!apply_builder_cancellation(&mut state, "old-builder"));
            if status != AttemptStatus::Running {
                assert!(!apply_builder_cancellation(&mut state, "current-builder"));
            }
            assert_eq!(serde_json::to_value(&state).unwrap(), before);
        }
    }

    #[test]
    fn builder_chat_cancellation_does_not_overwrite_a_stopped_or_archived_flight() {
        for archived in [false, true] {
            let mut flight = flight_with_attempt(local_attempt(
                "current-builder",
                "D:/fixture",
                AttemptStatus::Running,
            ));
            if archived {
                flight.archived_at = Some(55);
            } else {
                flight.stopped_at = Some(55);
            }
            let mut state = storage::PersistedState::default();
            state.flights.push(flight);
            let before = serde_json::to_value(&state).unwrap();
            assert!(!apply_builder_cancellation(&mut state, "current-builder"));
            assert_eq!(serde_json::to_value(&state).unwrap(), before);
        }
    }

    // --- Worktree teardown reporting (cancel / terminal transition) ---

    fn temp_repo(tag: &str) -> std::path::PathBuf {
        use std::time::{SystemTime, UNIX_EPOCH};
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let root = std::env::temp_dir().join(format!("packetbench-cleanup-{}-{}", tag, nanos));
        std::fs::create_dir_all(&root).expect("create temp repo dir");
        let git = |args: &[&str]| {
            let ok = std::process::Command::new("git")
                .args(args)
                .current_dir(&root)
                .output()
                .expect("git run")
                .status
                .success();
            assert!(ok, "git {:?} failed", args);
        };
        git(&["init", "-q"]);
        git(&["config", "user.email", "test@packetbench.test"]);
        git(&["config", "user.name", "PacketBench Test"]);
        git(&["checkout", "-q", "-b", "main"]);
        std::fs::write(root.join("f.txt"), "base\n").expect("write f.txt");
        git(&["add", "f.txt"]);
        git(&["commit", "-q", "-m", "init"]);
        root
    }

    #[tokio::test]
    async fn interrupted_startup_preserves_staged_dirty_and_untracked_files_and_never_contacts_ssh()
    {
        let root = temp_repo("retained-restart");
        let base = root.to_string_lossy().to_string();
        let path = worktree::create_local_worktree(&base, "retained", "main")
            .await
            .unwrap();
        std::fs::write(std::path::Path::new(&path).join("f.txt"), "staged\n").unwrap();
        assert!(std::process::Command::new("git")
            .args(["add", "f.txt"])
            .current_dir(&path)
            .status()
            .unwrap()
            .success());
        std::fs::write(
            std::path::Path::new(&path).join("f.txt"),
            "dirty after stage\n",
        )
        .unwrap();
        std::fs::write(
            std::path::Path::new(&path).join("untracked.txt"),
            "precious\n",
        )
        .unwrap();
        let status = || {
            std::process::Command::new("git")
                .args(["status", "--porcelain", "--untracked-files=all"])
                .current_dir(&path)
                .output()
                .unwrap()
                .stdout
        };
        let before = status();
        sweep_interrupted_attempts(vec![
            crate::core::orchestrator::InterruptedAttempt {
                flight_id: "f".into(),
                attempt_id: "retained".into(),
                target: AttemptTarget::Local {
                    base_path: base.clone(),
                    worktree_path: path.clone(),
                },
            },
            // No saved server or reachable host is needed for startup recovery.
            crate::core::orchestrator::InterruptedAttempt {
                flight_id: "f".into(),
                attempt_id: "ssh".into(),
                target: AttemptTarget::Ssh {
                    server_id: "not-configured".into(),
                    base_path: "/missing".into(),
                    worktree_path: "/missing/retained".into(),
                },
            },
        ])
        .await;
        assert_eq!(status(), before);
        assert_eq!(
            std::fs::read_to_string(std::path::Path::new(&path).join("f.txt")).unwrap(),
            "dirty after stage\n"
        );
        assert_eq!(
            std::fs::read_to_string(std::path::Path::new(&path).join("untracked.txt")).unwrap(),
            "precious\n"
        );
        let _ = std::fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn acceptance_cleanup_refuses_staged_dirty_untracked_files_then_removes_clean_worktree() {
        let root = temp_repo("safe-accept");
        let base = root.to_string_lossy().to_string();
        let path = worktree::create_local_worktree(&base, "safe-accept", "main")
            .await
            .unwrap();
        std::fs::write(std::path::Path::new(&path).join("f.txt"), "staged\n").unwrap();
        assert!(std::process::Command::new("git")
            .args(["add", "f.txt"])
            .current_dir(&path)
            .status()
            .unwrap()
            .success());
        std::fs::write(std::path::Path::new(&path).join("f.txt"), "dirty\n").unwrap();
        std::fs::write(
            std::path::Path::new(&path).join("untracked.txt"),
            "retained\n",
        )
        .unwrap();
        assert!(
            worktree::remove_attempt_worktree_safely(&base, "safe-accept", None)
                .await
                .is_err()
        );
        assert_eq!(
            std::fs::read_to_string(std::path::Path::new(&path).join("untracked.txt")).unwrap(),
            "retained\n"
        );
        assert!(std::process::Command::new("git")
            .args(["add", "."])
            .current_dir(&path)
            .status()
            .unwrap()
            .success());
        assert!(std::process::Command::new("git")
            .args([
                "-c",
                "commit.gpgsign=false",
                "commit",
                "-qm",
                "commit retained work"
            ])
            .current_dir(&path)
            .status()
            .unwrap()
            .success());
        worktree::remove_attempt_worktree_safely(&base, "safe-accept", None)
            .await
            .unwrap();
        assert!(!std::path::Path::new(&path).exists());
        let _ = std::fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn cleanup_reports_success_for_a_real_local_worktree() {
        let root = temp_repo("ok");
        let base = root.to_string_lossy().to_string();
        let path = crate::core::worktree::create_local_worktree(&base, "att-ok", "main")
            .await
            .expect("worktree created");
        let target = AttemptTarget::Local {
            base_path: base.clone(),
            worktree_path: path.clone(),
        };

        let outcome = cleanup_attempt_worktree_with("att-ok", &target, None).await;

        assert!(outcome.removed, "{:?}", outcome);
        assert!(outcome.error.is_none());
        assert!(!outcome.needs_attention());
        assert!(!std::path::Path::new(&path).exists());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[tokio::test]
    async fn cleanup_reports_a_failed_local_worktree_removal_instead_of_swallowing_it() {
        // The worktree dir exists but its base is not a git repo, so
        // `git worktree remove` fails. This used to be warn!-logged and the
        // command returned Ok(()) — a stuck worktree looked like a clean
        // delete to the frontend.
        use std::time::{SystemTime, UNIX_EPOCH};
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let root = std::env::temp_dir().join(format!("packetbench-cleanup-bad-{}", nanos));
        let wt = root.join(".pkt-worktrees").join("att-bad");
        std::fs::create_dir_all(&wt).unwrap();
        let base = root.to_string_lossy().to_string();
        let target = AttemptTarget::Local {
            base_path: base.clone(),
            worktree_path: wt.to_string_lossy().to_string(),
        };

        let outcome = cleanup_attempt_worktree_with("att-bad", &target, None).await;

        assert!(!outcome.removed);
        assert!(outcome.needs_attention());
        assert!(
            outcome
                .error
                .as_deref()
                .unwrap_or_default()
                .contains("git worktree remove failed"),
            "unexpected error: {:?}",
            outcome.error
        );
        // The path is named so the user can finish the job by hand.
        assert!(outcome.worktree_path.contains("att-bad"));
        assert!(wt.exists());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[tokio::test]
    async fn cleanup_reports_ssh_teardown_as_deferred_when_the_server_is_gone() {
        let target = AttemptTarget::Ssh {
            base_path: "/srv/repo".to_string(),
            worktree_path: "/srv/repo/.pkt-worktrees/att-ssh".to_string(),
            server_id: "server-gone".to_string(),
        };

        let outcome = cleanup_attempt_worktree_with("att-ssh", &target, None).await;

        assert!(!outcome.removed);
        assert!(outcome.deferred, "{:?}", outcome);
        assert!(outcome.error.is_none(), "deferred is not an error");
        assert!(outcome.needs_attention());
        assert_eq!(outcome.worktree_path, "/srv/repo/.pkt-worktrees/att-ssh");
    }

    #[test]
    fn apply_attempt_status_by_session_records_error_on_failed_attempt() {
        let mut state = storage::PersistedState::default();
        state.flights = vec![flight_with_attempt(local_attempt(
            "session-1",
            "D:\\Repo",
            AttemptStatus::Provisioning,
        ))];

        let updated = apply_attempt_status_by_session(
            &mut state,
            "session-1",
            AttemptStatus::Failed,
            Some("provider failed".to_string()),
        );

        assert!(updated);
        let attempt = &state.flights[0].attempts[0];
        assert_eq!(attempt.status, AttemptStatus::Failed);
        assert!(attempt.completed_at.is_some());
        assert_eq!(attempt.error_message.as_deref(), Some("provider failed"));
    }

    // --- F1: Reviewer Gate acceptance, end to end through real storage -----

    fn unique_temp_dir(tag: &str) -> std::path::PathBuf {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let dir = std::env::temp_dir().join(format!("packetbench-gate-{}-{}", tag, nanos));
        std::fs::create_dir_all(&dir).expect("create unique temp dir");
        dir
    }

    fn gated_flight() -> Flight {
        let mut flight = flight_with_attempt(local_attempt(
            "attempt-1",
            "D:\\Repo",
            AttemptStatus::Reviewing,
        ));
        flight.review_gate_policy = Some(crate::core::flight::ReviewGatePolicy {
            enabled: true,
            reviewer_agent_config_id: "api-claude".to_string(),
            reviewer_model: None,
            acceptance_criteria: Vec::new(),
        });
        flight
    }

    fn gate_dto(status: crate::api::ReviewGateStatusDto) -> crate::api::AttemptReviewGateDto {
        crate::api::AttemptReviewGateDto {
            evidence: None,
            reviewer_sessions: Vec::new(),
            status,
            reviewer_conversation_id: Some("review-1".to_string()),
            reviewer_agent_config_id: Some("api-claude".to_string()),
            reviewer_model: None,
            report: None,
            error_message: None,
            started_at: Some(1),
            completed_at: Some(2),
            overridden_at: None,
            override_reason: None,
        }
    }

    fn stored_attempt(flight_id: &str, attempt_id: &str) -> Attempt {
        storage::load_state()
            .flights
            .into_iter()
            .find(|f| f.id == flight_id)
            .expect("flight present")
            .attempts
            .into_iter()
            .find(|a| a.id == attempt_id)
            .expect("attempt present")
    }

    #[tokio::test]
    async fn acceptance_waits_for_every_saved_owner_before_recording_completion() {
        let dir = unique_temp_dir("accept-cleanup-failure");
        let _guard = storage::redirect_data_dir_for_test(dir.clone());
        let root = temp_repo("accept-cleanup-failure");
        let clean_path = root.to_string_lossy().to_string();
        let owners = ["attempt-1", "old-builder", "review-1", "old-reviewer"];
        for (index, failed_owner) in owners.iter().enumerate() {
            let mut flight = gated_flight();
            flight.id = format!("cleanup-{index}");
            let attempt = &mut flight.attempts[0];
            attempt.flight_id = flight.id.clone();
            attempt.target = AttemptTarget::Local {
                base_path: clean_path.clone(),
                worktree_path: clean_path.clone(),
            };
            attempt.session_history = Some(vec![crate::core::flight::ReviewerSession {
                session_id: "old-builder".into(),
                provider: "anthropic".into(),
                model: "model".into(),
            }]);
            let mut gate: crate::core::flight::AttemptReviewGate =
                gate_dto(crate::api::ReviewGateStatusDto::Overridden).into();
            gate.overridden_at = Some(1);
            gate.override_reason = Some("Manually reviewed the clean result".into());
            gate.reviewer_sessions
                .push(crate::core::flight::ReviewerSession {
                    session_id: "old-reviewer".into(),
                    provider: "anthropic".into(),
                    model: "model".into(),
                });
            attempt.review_gate = Some(gate);
            let attempt = attempt.clone();
            let target = serde_json::to_value(&attempt.target).unwrap();
            let branch = attempt.branch.clone();
            storage::save_flights(vec![flight.clone()]).await.unwrap();
            let error = accept_after_session_cleanup(&flight.id, &attempt, |id| {
                std::future::ready(if &id == failed_owner {
                    Err("SSH cleanup unacknowledged".into())
                } else {
                    Ok(())
                })
            })
            .await
            .unwrap_err();
            assert!(error.contains("unacknowledged"));
            let saved = stored_attempt(&flight.id, &attempt.id);
            assert_eq!(saved.status, AttemptStatus::Failed);
            assert!(matches!(
                saved.recovery.as_ref().unwrap().state,
                crate::core::flight::RecoveryState::Retained
            ));
            assert_eq!(serde_json::to_value(&saved.target).unwrap(), target);
            assert_eq!(saved.branch, branch);
            assert!(saved.delivery.is_none());
            assert!(root.exists());
        }
        let _ = std::fs::remove_dir_all(root);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn failed_clean_attempt_retains_worktree_error_cost_and_owner_history() {
        let dir = unique_temp_dir("failed-clean-retained");
        let _guard = storage::redirect_data_dir_for_test(dir.clone());
        let root = temp_repo("failed-clean-retained");
        let base = root.to_string_lossy().to_string();
        for (index, status) in [AttemptStatus::Failed, AttemptStatus::Cancelled]
            .into_iter()
            .enumerate()
        {
            let id = format!("interrupted-{index}");
            let path = worktree::create_local_worktree(&base, &id, "main")
                .await
                .unwrap();
            let mut attempt = local_attempt(&id, &base, status);
            attempt.target = AttemptTarget::Local {
                base_path: base.clone(),
                worktree_path: path.clone(),
            };
            attempt.error_message = Some("HTTP 522 provider unavailable after commit".into());
            attempt.failure_category = Some("network".into());
            attempt.cost = 2.5;
            attempt.tokens = 123;
            attempt.session_history = Some(vec![crate::core::flight::ReviewerSession {
                session_id: "old-owner".into(),
                provider: "anthropic".into(),
                model: "model".into(),
            }]);
            let mut flight = flight_with_attempt(attempt.clone());
            flight.id = format!("retained-flight-{index}");
            flight.attempts[0].flight_id = flight.id.clone();
            storage::save_flights(vec![flight.clone()]).await.unwrap();
            let inspect = || {
                let git = |args: &[&str]| {
                    let output = std::process::Command::new("git")
                        .args(args)
                        .current_dir(&path)
                        .output()
                        .unwrap();
                    assert!(output.status.success());
                    String::from_utf8(output.stdout).unwrap()
                };
                let index_path = std::path::Path::new(&path)
                    .join(git(&["rev-parse", "--git-path", "index"]).trim());
                (
                    git(&["rev-parse", "HEAD"]),
                    git(&["status", "--porcelain"]),
                    std::fs::read(index_path).unwrap(),
                    std::fs::read(std::path::Path::new(&path).join("f.txt")).unwrap(),
                )
            };
            let before = inspect();
            assert!(before.1.trim().is_empty(), "fixture must be clean");
            let mut stopped = std::collections::HashSet::new();
            let outcome = retain_interrupted_attempt(&flight.id, &attempt, status, |id| {
                stopped.insert(id);
                std::future::ready(Ok(()))
            })
            .await
            .unwrap();
            assert!(
                outcome.is_none(),
                "interruption must not request worktree cleanup"
            );
            assert_eq!(stopped, attempt_session_ids(&attempt));
            assert_eq!(
                inspect(),
                before,
                "interruption changed HEAD, index or files"
            );
            let saved = stored_attempt(&flight.id, &attempt.id);
            assert_eq!(saved.status, status);
            assert!(matches!(
                saved.recovery.as_ref().unwrap().state,
                crate::core::flight::RecoveryState::Retained
            ));
            assert_eq!(saved.error_message, attempt.error_message);
            assert_eq!(saved.failure_category, attempt.failure_category);
            assert_eq!(saved.cost, attempt.cost);
            assert_eq!(saved.tokens, attempt.tokens);
            assert_eq!(
                serde_json::to_value(&saved.session_history).unwrap(),
                serde_json::to_value(&attempt.session_history).unwrap()
            );
            assert_eq!(saved.branch, attempt.branch);
        }
        let _ = std::fs::remove_dir_all(root);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn acceptance_records_completion_only_after_acknowledged_cleanup_and_clean_recheck() {
        let dir = unique_temp_dir("accept-cleanup-success");
        let _guard = storage::redirect_data_dir_for_test(dir.clone());
        let root = temp_repo("accept-cleanup-success");
        let path = root.to_string_lossy().to_string();
        let mut flight =
            flight_with_attempt(local_attempt("builder", &path, AttemptStatus::Reviewing));
        let attempt = &mut flight.attempts[0];
        attempt.target = AttemptTarget::Local {
            base_path: path.clone(),
            worktree_path: path.clone(),
        };
        let attempt = attempt.clone();
        storage::save_flights(vec![flight.clone()]).await.unwrap();
        let observed = Arc::new(std::sync::Mutex::new(Vec::new()));
        accept_after_session_cleanup(&flight.id, &attempt, |id| {
            assert_eq!(
                stored_attempt(&flight.id, &attempt.id).status,
                AttemptStatus::Reviewing
            );
            observed.lock().unwrap().push(id);
            std::future::ready(Ok(()))
        })
        .await
        .unwrap();
        assert_eq!(*observed.lock().unwrap(), vec![attempt.session_id.clone()]);
        assert_eq!(
            stored_attempt(&flight.id, &attempt.id).status,
            AttemptStatus::Completed
        );
        assert!(root.exists());
        let _ = std::fs::remove_dir_all(root);
        let _ = std::fs::remove_dir_all(dir);
    }

    /// The gap that hid F1: nothing covered gated acceptance. With the gate
    /// enabled, acceptance is blocked until a verdict exists, blocked again
    /// when that verdict is not a pass, and only then allowed — and the
    /// verdict has to survive the frontend's whole-slice flight save that
    /// runs constantly in between.
    #[tokio::test]
    async fn gated_acceptance_blocks_until_a_verdict_is_persisted() {
        let dir = unique_temp_dir("accept");
        let _guard = storage::redirect_data_dir_for_test(dir.clone());
        storage::save_flights(vec![gated_flight()])
            .await
            .expect("seed gated flight");

        // 1. No verdict yet — acceptance is refused.
        let err = update_attempt_status("flight-1", "attempt-1", AttemptStatus::Completed, None)
            .await
            .expect_err("acceptance must be blocked without a verdict");
        assert!(err.contains("has not produced a verdict"), "{err}");

        // 2. A non-passing verdict is still refused.
        set_attempt_review_gate(
            "flight-1".to_string(),
            "attempt-1".to_string(),
            Some(gate_dto(crate::api::ReviewGateStatusDto::ChangesRequested)),
        )
        .await
        .expect("gate write should succeed");
        let err = update_attempt_status("flight-1", "attempt-1", AttemptStatus::Completed, None)
            .await
            .expect_err("changes_requested must not unblock acceptance");
        assert!(
            err.contains("must pass or have a recorded override"),
            "{err}"
        );

        // 3. A legacy pass without code identity must be reviewed again.
        set_attempt_review_gate(
            "flight-1".to_string(),
            "attempt-1".to_string(),
            Some(gate_dto(crate::api::ReviewGateStatusDto::Passed)),
        )
        .await
        .expect_err("a legacy unbound pass must not be accepted");
        let mut override_gate = gate_dto(crate::api::ReviewGateStatusDto::Overridden);
        override_gate.overridden_at = Some(3);
        override_gate.override_reason = Some("Manually reviewed this change".into());
        set_attempt_review_gate("flight-1".into(), "attempt-1".into(), Some(override_gate))
            .await
            .expect("reasoned override persists");
        let mut frontend_snapshot = gated_flight();
        frontend_snapshot.attempts[0].review_gate = None;
        storage::save_flights(vec![frontend_snapshot])
            .await
            .expect("frontend whole-slice save");
        assert!(
            stored_attempt("flight-1", "attempt-1")
                .review_gate
                .is_some(),
            "the persisted verdict must survive a frontend flight save"
        );

        // 4. The explicit override survives frontend saves and allows acceptance.
        update_attempt_status("flight-1", "attempt-1", AttemptStatus::Completed, None)
            .await
            .expect("a reasoned override must allow acceptance");
        assert_eq!(
            stored_attempt("flight-1", "attempt-1").status,
            AttemptStatus::Completed
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// An override is only an override when the user actually recorded a
    /// reason for it — a bare `overridden` status must not unblock acceptance.
    #[tokio::test]
    async fn gated_acceptance_requires_a_reason_on_an_override() {
        let dir = unique_temp_dir("override");
        let _guard = storage::redirect_data_dir_for_test(dir.clone());
        storage::save_flights(vec![gated_flight()])
            .await
            .expect("seed gated flight");

        let mut bare = gate_dto(crate::api::ReviewGateStatusDto::Overridden);
        bare.overridden_at = None;
        bare.override_reason = None;
        set_attempt_review_gate("flight-1".to_string(), "attempt-1".to_string(), Some(bare))
            .await
            .expect("gate write should succeed");
        let err = update_attempt_status("flight-1", "attempt-1", AttemptStatus::Completed, None)
            .await
            .expect_err("an unreasoned override must not unblock acceptance");
        assert!(
            err.contains("must pass or have a recorded override"),
            "{err}"
        );

        let mut recorded = gate_dto(crate::api::ReviewGateStatusDto::Overridden);
        recorded.overridden_at = Some(9);
        recorded.override_reason = Some("Reviewer stalled; risk accepted.".to_string());
        set_attempt_review_gate(
            "flight-1".to_string(),
            "attempt-1".to_string(),
            Some(recorded),
        )
        .await
        .expect("gate write should succeed");
        update_attempt_status("flight-1", "attempt-1", AttemptStatus::Completed, None)
            .await
            .expect("a reasoned override must allow acceptance");

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Clearing the record (what a reviewer retry does) puts the attempt back
    /// behind the gate rather than leaving a stale pass in place.
    #[tokio::test]
    async fn clearing_the_review_gate_reblocks_acceptance() {
        let dir = unique_temp_dir("clear");
        let _guard = storage::redirect_data_dir_for_test(dir.clone());
        storage::save_flights(vec![gated_flight()])
            .await
            .expect("seed gated flight");

        set_attempt_review_gate(
            "flight-1".to_string(),
            "attempt-1".to_string(),
            Some(gate_dto(crate::api::ReviewGateStatusDto::ChangesRequested)),
        )
        .await
        .expect("gate write should succeed");
        set_attempt_review_gate("flight-1".to_string(), "attempt-1".to_string(), None)
            .await
            .expect("clearing the gate should succeed");

        assert_eq!(
            stored_attempt("flight-1", "attempt-1")
                .review_gate
                .unwrap()
                .status,
            ReviewGateStatus::Pending
        );
        let err = update_attempt_status("flight-1", "attempt-1", AttemptStatus::Completed, None)
            .await
            .expect_err("a cleared gate must re-block acceptance");
        assert!(
            err.contains("must pass or have a recorded override"),
            "{err}"
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn set_attempt_review_gate_rejects_unknown_ids() {
        let dir = unique_temp_dir("unknown");
        let _guard = storage::redirect_data_dir_for_test(dir.clone());
        storage::save_flights(vec![gated_flight()])
            .await
            .expect("seed gated flight");

        let err = set_attempt_review_gate(
            "flight-1".to_string(),
            "attempt-missing".to_string(),
            Some(gate_dto(crate::api::ReviewGateStatusDto::Passed)),
        )
        .await
        .expect_err("an unknown attempt id must be reported");
        assert!(err.contains("attempt-missing"), "{err}");

        let _ = std::fs::remove_dir_all(&dir);
    }
}
