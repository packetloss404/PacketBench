//! Session admission and non-destructive Flight Stop/recovery contracts.
use crate::commands::agent_sidecar::SidecarManager;
use crate::commands::api_agent::{close_api_agent_session, ApiAgentState};
use crate::core::flight::{
    Attempt, AttemptRecovery, AttemptStatus, Flight, RecoveryState, ReviewGateStatus,
};
use crate::core::storage;
use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex, OnceLock};
use tokio::sync::watch;
use tokio_util::sync::CancellationToken;

#[derive(Clone)]
pub(crate) struct PendingStart {
    cancel: CancellationToken,
    finished: watch::Receiver<bool>,
}
pub(crate) struct Admission {
    pub cancel: CancellationToken,
    finished: watch::Sender<bool>,
}
impl Drop for Admission {
    fn drop(&mut self) {
        let _ = self.finished.send(true);
    }
}
fn sessions() -> &'static Mutex<HashMap<String, PendingStart>> {
    static VALUE: OnceLock<Mutex<HashMap<String, PendingStart>>> = OnceLock::new();
    VALUE.get_or_init(Default::default)
}
fn launches() -> &'static Mutex<HashMap<String, Vec<PendingStart>>> {
    static VALUE: OnceLock<Mutex<HashMap<String, Vec<PendingStart>>>> = OnceLock::new();
    VALUE.get_or_init(Default::default)
}
fn admission() -> (Admission, PendingStart) {
    let cancel = CancellationToken::new();
    let (tx, rx) = watch::channel(false);
    (
        Admission {
            cancel: cancel.clone(),
            finished: tx,
        },
        PendingStart {
            cancel,
            finished: rx,
        },
    )
}
pub(crate) fn session_admission(id: &str) -> Result<Admission, String> {
    let (guard, pending) = admission();
    let mut starts = sessions().lock().unwrap_or_else(|error| error.into_inner());
    ensure_session_allowed(id)?;
    if starts
        .get(id)
        .is_some_and(|entry| !*entry.finished.borrow())
    {
        return Err("This session is already starting.".into());
    }
    starts.insert(id.into(), pending);
    Ok(guard)
}
pub(crate) fn cancel_session_start(id: &str) -> Option<PendingStart> {
    let start = sessions()
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .get(id)
        .cloned();
    if let Some(start) = &start {
        start.cancel.cancel();
    }
    start
}
pub(crate) fn launch_admission(flight_id: &str) -> Result<Admission, String> {
    let (guard, pending) = admission();
    let mut values = launches().lock().unwrap_or_else(|error| error.into_inner());
    ensure_flight_allowed(flight_id)?;
    let starts = values.entry(flight_id.into()).or_default();
    starts.retain(|entry| !*entry.finished.borrow());
    starts.push(pending);
    Ok(guard)
}

fn recovery_admission(
    flight_id: &str,
    expected_stopped_at: Option<u64>,
) -> Result<Admission, String> {
    let (guard, pending) = admission();
    let mut values = launches().lock().unwrap_or_else(|error| error.into_inner());
    let snapshot = storage::load_state();
    let flight = snapshot
        .flights
        .iter()
        .find(|flight| flight.id == flight_id)
        .ok_or("Flight not found.")?;
    if flight.stopped_at != expected_stopped_at {
        return Err(
            "The Flight stop state changed. Review its current state before resuming.".into(),
        );
    }
    if flight.archived_at.is_some() || flight.delivery.is_some() {
        return Err(
            "This Flight is archived or delivered. Create a new Flight before resuming work."
                .into(),
        );
    }
    let starts = values.entry(flight_id.into()).or_default();
    starts.retain(|entry| !*entry.finished.borrow());
    starts.push(pending);
    Ok(guard)
}
pub(crate) fn ensure_flight_allowed(flight_id: &str) -> Result<(), String> {
    let snapshot = storage::load_state();
    let flight = snapshot
        .flights
        .iter()
        .find(|flight| flight.id == flight_id)
        .ok_or("Flight not found.")?;
    if flight.stopped_at.is_some() {
        return Err(
            "This Flight was stopped. Explicitly resume execution before starting another session."
                .into(),
        );
    }
    if flight.archived_at.is_some() || flight.delivery.is_some() {
        return Err(
            "This Flight is archived or delivered. Create a new Flight before starting more work."
                .into(),
        );
    }
    Ok(())
}
pub(crate) fn owned_session_ids(flight: &Flight) -> HashSet<String> {
    let mut ids = HashSet::new();
    for attempt in &flight.attempts {
        ids.insert(attempt.session_id.clone());
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
    }
    ids.extend(
        flight
            .milestones
            .iter()
            .flat_map(|milestone| &milestone.tasks)
            .filter_map(|task| task.session_id.clone()),
    );
    ids.extend(flight.planning_conversation_id.iter().cloned());
    ids
}
pub(crate) fn ensure_session_allowed(id: &str) -> Result<(), String> {
    let snapshot = storage::load_state();
    validate_session_admission(&snapshot.flights, id)
}
fn validate_session_admission(flights: &[Flight], id: &str) -> Result<(), String> {
    if flights
        .iter()
        .flat_map(|flight| &flight.attempts)
        .any(|attempt| {
            attempt.session_id != id
                && attempt
                    .session_history
                    .iter()
                    .flatten()
                    .any(|owner| owner.session_id == id)
        })
    {
        return Err("Historical builder sessions cannot restart. Use the current builder or explicitly resume retained work.".into());
    }
    if flights.iter().any(|flight| {
        (flight.stopped_at.is_some() || flight.archived_at.is_some() || flight.delivery.is_some())
            && owned_session_ids(flight).contains(id)
    }) {
        return Err(
            "This Flight was stopped; the session cannot start or resume automatically.".into(),
        );
    }
    Ok(())
}

/// A deliberate builder follow-up revokes the previous verdict before any
/// write-capable provider receives the turn. Historical reviewers stay owned.
pub(super) async fn begin_builder_turn(id: &str) -> Result<(), String> {
    let id = id.to_string();
    storage::with_state_lock(move |state| std::future::ready(apply_builder_turn(state, &id))).await
}
fn apply_builder_turn(state: &mut storage::PersistedState, id: &str) -> Result<(), String> {
    validate_session_admission(&state.flights, id)?;
    for flight in &mut state.flights {
        if let Some(attempt) = flight
            .attempts
            .iter_mut()
            .find(|attempt| attempt.session_id == id)
        {
            if flight.stopped_at.is_some()
                || flight.archived_at.is_some()
                || flight.delivery.is_some()
            {
                return Err("This Flight cannot admit another builder turn. Resume it explicitly or create a new Flight.".into());
            }
            if matches!(
                attempt.status,
                AttemptStatus::Completed | AttemptStatus::Failed | AttemptStatus::Cancelled
            ) {
                return Err("This builder attempt is settled. Resume retained work explicitly or create a new attempt.".into());
            }
            if attempt.status == AttemptStatus::Reviewing {
                attempt.status = AttemptStatus::Running;
                attempt.completed_at = None;
                if let Some(gate) = &mut attempt.review_gate {
                    gate.status = ReviewGateStatus::Error;
                    gate.evidence = None;
                    gate.report = None;
                    gate.overridden_at = None;
                    gate.override_reason = None;
                    gate.error_message = Some(
                        "Builder follow-up started; review the new result before accepting.".into(),
                    );
                }
                if let Some(task_id) = &attempt.task_id {
                    if let Some(task) = flight
                        .milestones
                        .iter_mut()
                        .flat_map(|milestone| &mut milestone.tasks)
                        .find(|task| &task.id == task_id)
                    {
                        task.status = crate::core::flight::TaskStatus::Running;
                        task.session_id = Some(id.to_string());
                    }
                }
                flight.updated_at = now();
            }
        }
    }
    Ok(())
}

pub(crate) async fn drain(starts: Vec<PendingStart>) -> Result<(), String> {
    for mut start in starts {
        if !*start.finished.borrow() {
            tokio::time::timeout(std::time::Duration::from_secs(30), async { while !*start.finished.borrow() { if start.finished.changed().await.is_err() { break; } } }).await.map_err(|_| "A Flight startup did not finish stopping. Its files were retained; inspect before discarding.".to_string())?;
        }
    }
    Ok(())
}
pub(crate) fn retained(attempt: &mut Attempt, reason: &str, at: u64) {
    attempt.recovery = Some(AttemptRecovery {
        state: RecoveryState::Retained,
        reason: reason.into(),
        retained_at: at,
    });
}
pub(crate) fn now() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

pub(super) async fn retain_failed_start(id: &str, error: &str) -> Result<(), String> {
    let id = id.to_string();
    let error = error.to_string();
    storage::with_state_lock(move |state| {
        for flight in &mut state.flights {
            if let Some(attempt) = flight.attempts.iter_mut().find(|attempt| attempt.session_id == id) {
                if matches!(attempt.status, AttemptStatus::Provisioning | AttemptStatus::Queued | AttemptStatus::Running) {
                    attempt.status = AttemptStatus::Failed;
                    attempt.error_message = Some(format!("Session startup failed: {error}"));
                    attempt.failure_category = Some(crate::core::error_classifier::classify_cli_error(&error).category.as_str().into());
                    attempt.completed_at = Some(now());
                    retained(attempt, "Session startup failed; retained files can be inspected or explicitly resumed.", now());
                    if let Some(task_id) = &attempt.task_id { if let Some(task) = flight.milestones.iter_mut().flat_map(|milestone| &mut milestone.tasks).find(|task| &task.id == task_id) { task.session_id = Some(id.clone()); task.status = crate::core::flight::TaskStatus::Failed; } }
                    flight.updated_at = now();
                }
            }
        }
        std::future::ready(Ok(()))
    }).await
}

/// Frontend admission (budget, trust snapshot or listener registration) may
/// fail before start_api_agent_session is invoked. Preserve the prepared files
/// without changing a stopped, superseded or already-started session.
fn fail_prepared_start(
    flight: &mut Flight,
    attempt_id: &str,
    session_id: &str,
    error: &str,
) -> Result<(), String> {
    let attempt = flight
        .attempts
        .iter_mut()
        .find(|attempt| attempt.id == attempt_id)
        .ok_or("Attempt not found.")?;
    if flight.stopped_at.is_some()
        || attempt.session_id != session_id
        || !matches!(
            attempt.status,
            AttemptStatus::Provisioning | AttemptStatus::Queued
        )
    {
        return Ok(());
    }
    attempt.status = AttemptStatus::Failed;
    attempt.error_message = Some(format!("Session startup failed: {error}"));
    attempt.completed_at = Some(now());
    retained(attempt, "Session startup failed before dispatch; worktree retained for inspection or explicit recovery.", now());
    if let Some(task_id) = &attempt.task_id {
        if let Some(task) = flight
            .milestones
            .iter_mut()
            .flat_map(|milestone| &mut milestone.tasks)
            .find(|task| &task.id == task_id)
        {
            task.status = crate::core::flight::TaskStatus::Failed;
        }
    }
    flight.updated_at = now();
    Ok(())
}

#[tauri::command]
pub async fn fail_prepared_flight_attempt(
    flight_id: String,
    attempt_id: String,
    session_id: String,
    error: String,
) -> Result<(), String> {
    storage::with_state_lock(move |state| {
        let result = state
            .flights
            .iter_mut()
            .find(|flight| flight.id == flight_id)
            .ok_or_else(|| "Flight not found.".to_string())
            .and_then(|flight| fail_prepared_start(flight, &attempt_id, &session_id, &error));
        std::future::ready(result)
    })
    .await
}

fn sidecar_activity() -> &'static Mutex<HashMap<String, watch::Sender<bool>>> {
    static VALUE: OnceLock<Mutex<HashMap<String, watch::Sender<bool>>>> = OnceLock::new();
    VALUE.get_or_init(Default::default)
}
pub(crate) fn sidecar_active(id: &str, active: bool) {
    let mut values = sidecar_activity()
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    let sender = values
        .entry(id.into())
        .or_insert_with(|| watch::channel(false).0);
    sender.send_replace(active);
}
pub(crate) async fn wait_sidecar_idle(id: &str) -> Result<(), String> {
    let receiver = sidecar_activity()
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .get(id)
        .map(|sender| sender.subscribe());
    if let Some(mut receiver) = receiver {
        tokio::time::timeout(std::time::Duration::from_secs(30), async {
            while *receiver.borrow() {
                if receiver.changed().await.is_err() {
                    break;
                }
            }
        })
        .await
        .map_err(|_| {
            "The sidecar did not confirm cancellation. Its worktree remains intact.".to_string()
        })?;
    }
    Ok(())
}
pub(crate) fn sidecar_is_active(id: &str) -> bool {
    sidecar_activity()
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .get(id)
        .is_some_and(|sender| *sender.borrow())
}

fn begin(flight: &mut Flight, expected_stopped_at: Option<u64>) -> Result<(), String> {
    begin_at(flight, expected_stopped_at, now())
}
fn begin_at(
    flight: &mut Flight,
    expected_stopped_at: Option<u64>,
    clock: u64,
) -> Result<(), String> {
    if flight.stopped_at != expected_stopped_at {
        return Err(
            "The Flight stop state changed. Review its current state before resuming.".into(),
        );
    }
    if flight.stopped_at.is_none() {
        return Ok(());
    }
    flight.stopped_at = None;
    flight.archived_at = None;
    flight.updated_at = flight.updated_at.max(clock);
    Ok(())
}
#[tauri::command]
pub async fn begin_flight_execution(
    flight_id: String,
    expected_stopped_at: Option<u64>,
) -> Result<(), String> {
    storage::with_state_lock(move |state| {
        let result = state
            .flights
            .iter_mut()
            .find(|flight| flight.id == flight_id)
            .ok_or_else(|| "Flight not found.".to_string())
            .and_then(|flight| begin(flight, expected_stopped_at));
        std::future::ready(result)
    })
    .await
}

fn validate_resume(flight: &Flight, attempt: &Attempt) -> Result<(), String> {
    if flight.archived_at.is_some() || flight.delivery.is_some() {
        return Err(
            "This Flight is archived or delivered. Create a new Flight before resuming work."
                .into(),
        );
    }
    if !matches!(
        attempt.recovery.as_ref().map(|recovery| &recovery.state),
        Some(RecoveryState::Retained)
    ) || matches!(
        attempt.status,
        AttemptStatus::Queued | AttemptStatus::Provisioning | AttemptStatus::Running
    ) || (attempt.status == AttemptStatus::Reviewing && flight.stopped_at.is_none())
    {
        return Err("Only an interrupted, retained attempt can be resumed. Inspect its retained worktree first.".into());
    }
    if attempt.delivery.is_some() {
        return Err("This attempt was already delivered. Create a new attempt.".into());
    }
    if let Some(task_id) = &attempt.task_id {
        let tasks: Vec<_> = flight
            .milestones
            .iter()
            .flat_map(|milestone| &milestone.tasks)
            .collect();
        let task = tasks.iter().find(|task| &task.id == task_id).ok_or("The attempt's task is no longer in this Flight. Inspect its files and create a new attempt.")?;
        if task.status == crate::core::flight::TaskStatus::Done
            || task.depends_on.iter().any(|id| {
                !tasks.iter().any(|dependency| {
                    &dependency.id == id
                        && dependency.status == crate::core::flight::TaskStatus::Done
                })
            })
        {
            return Err("The retained task is complete or its dependencies are not complete. Resolve the graph before resuming.".into());
        }
        if flight.execution_mode == Some(crate::core::flight::FlightExecutionMode::Cooperative)
            && flight.integration_branch.is_none()
        {
            return Err("The cooperative integration branch is missing. Inspect retained work before creating a new attempt.".into());
        }
    }
    Ok(())
}

fn recovery_session_ids(attempt: &Attempt) -> HashSet<String> {
    let mut ids = HashSet::from([attempt.session_id.clone()]);
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

async fn ensure_recovery_idle(state: &ApiAgentState, attempt: &Attempt) -> Result<(), String> {
    for id in recovery_session_ids(attempt) {
        let starting = sessions()
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .get(&id)
            .is_some_and(|entry| !*entry.finished.borrow());
        if starting || sidecar_is_active(&id) || state.has_active_turn(&id).await {
            return Err("Wait for the retained attempt's builder and reviewers to finish stopping before resuming.".into());
        }
        crate::core::tool_runtime_ssh::drain_session(&id).await.map_err(|error| {
            format!("The retained attempt still has unconfirmed remote cleanup and cannot resume: {error}")
        })?;
    }
    Ok(())
}

fn prepare_resume(
    flight: &mut Flight,
    attempt_id: &str,
    old_session: &str,
) -> Result<Attempt, String> {
    let attempt = flight
        .attempts
        .iter()
        .find(|attempt| attempt.id == attempt_id)
        .ok_or("Attempt not found.")?;
    validate_resume(flight, attempt)?;
    if attempt.session_id != old_session {
        return Err("This retained attempt has already been resumed.".into());
    }
    let attempt = flight
        .attempts
        .iter_mut()
        .find(|attempt| attempt.id == attempt_id)
        .unwrap();
    let history = attempt.session_history.get_or_insert_with(Vec::new);
    if !history.iter().any(|owner| owner.session_id == old_session) {
        history.push(crate::core::flight::ReviewerSession {
            session_id: old_session.into(),
            provider: attempt.provider.clone(),
            model: attempt.model.clone(),
        });
    }
    attempt.session_id = uuid::Uuid::new_v4().to_string();
    attempt.status = AttemptStatus::Provisioning;
    attempt.recovery = None;
    attempt.started_at = Some(now());
    attempt.completed_at = None;
    attempt.error_message = None;
    attempt.failure_category = None;
    if let Some(gate) = &mut attempt.review_gate {
        gate.status = ReviewGateStatus::Error;
        gate.evidence = None;
        gate.report = None;
        gate.error_message = Some(
            "The retained builder was resumed; review its new result before accepting.".into(),
        );
        gate.overridden_at = None;
        gate.override_reason = None;
    }
    flight.updated_at = now();
    if let Some(task_id) = &attempt.task_id {
        if let Some(task) = flight
            .milestones
            .iter_mut()
            .flat_map(|milestone| &mut milestone.tasks)
            .find(|task| &task.id == task_id)
        {
            task.session_id = Some(attempt.session_id.clone());
            task.status = crate::core::flight::TaskStatus::Queued;
            task.started_at = None;
            task.completed_at = None;
        }
    }
    Ok(attempt.clone())
}

fn prepare_and_begin_resume(
    flight: &mut Flight,
    attempt_id: &str,
    old_session: &str,
    expected_stopped_at: Option<u64>,
    cancel: &CancellationToken,
) -> Result<Attempt, String> {
    if cancel.is_cancelled() {
        return Err("Flight resume was stopped. All retained files remain intact.".into());
    }
    // Neither validation failure nor a newer Stop may partially reopen the
    // Flight. Register the fresh owner and clear its old verdict on a clone,
    // then publish both changes together after the stop-state CAS succeeds.
    let mut candidate = flight.clone();
    let prepared = prepare_resume(&mut candidate, attempt_id, old_session)?;
    begin(&mut candidate, expected_stopped_at)?;
    if cancel.is_cancelled() {
        return Err("Flight resume was stopped. All retained files remain intact.".into());
    }
    *flight = candidate;
    Ok(prepared)
}

/// Prepare a fresh session in the existing worktree. The frontend installs its
/// listeners before starting this registered session through the normal API.
#[tauri::command]
pub async fn resume_flight_attempt(
    state: tauri::State<'_, Arc<ApiAgentState>>,
    flight_id: String,
    attempt_id: String,
    expected_stopped_at: Option<u64>,
) -> Result<crate::api::AttemptDto, String> {
    let admission = recovery_admission(&flight_id, expected_stopped_at)?;
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
    validate_resume(flight, attempt)?;
    ensure_recovery_idle(state.inner().as_ref(), attempt).await?;
    // read() uses the saved, pinned SSH host configuration. No checkout, reset,
    // clean or staging occurs: both staged and untracked recovery files survive.
    if super::flight_review::read(attempt, &["symbolic-ref", "--short", "HEAD"]).await?
        != attempt.branch
    {
        return Err(
            "The retained worktree is on another branch. Inspect it before resuming.".into(),
        );
    }
    super::flight_review::read(attempt, &["rev-parse", "--verify", "HEAD^{commit}"]).await?;
    let old_session = attempt.session_id.clone();
    ensure_recovery_idle(state.inner().as_ref(), attempt).await?;
    if admission.cancel.is_cancelled() {
        return Err("Flight resume was stopped. All retained files remain intact.".into());
    }
    let cancel = admission.cancel.clone();
    storage::with_state_lock(move |snapshot| {
        let result = (|| {
            let flight = snapshot
                .flights
                .iter_mut()
                .find(|flight| flight.id == flight_id)
                .ok_or("Flight not found.")?;
            prepare_and_begin_resume(
                flight,
                &attempt_id,
                &old_session,
                expected_stopped_at,
                &cancel,
            )
            .map(Into::into)
        })();
        std::future::ready(result)
    })
    .await
}

pub(super) fn apply_delivery(
    flight: &mut Flight,
    attempt_id: &str,
    delivery: crate::core::flight::FlightDelivery,
) -> Result<(), String> {
    if flight.execution_mode == Some(crate::core::flight::FlightExecutionMode::Cooperative) {
        return Err(
            "Deliver the combined cooperative Flight after all tasks are integrated.".into(),
        );
    }
    let attempt = flight
        .attempts
        .iter_mut()
        .find(|attempt| attempt.id == attempt_id)
        .ok_or("Attempt not found.")?;
    if delivery.branch != attempt.branch
        || delivery.base_branch != attempt.base_branch
        || delivery.attempt_id.as_deref() != Some(attempt_id)
    {
        return Err("Delivery identity does not match this attempt.".into());
    }
    match delivery.kind {
        crate::core::flight::DeliveryKind::Landed
            if delivery
                .commit_sha
                .as_ref()
                .is_none_or(|sha| sha.trim().is_empty()) =>
        {
            return Err("A landed delivery requires its resulting commit SHA.".into())
        }
        crate::core::flight::DeliveryKind::PullRequest if delivery.pr_number.is_none() => {
            return Err("A pull request delivery requires its PR number.".into())
        }
        _ => {}
    }
    if attempt.status != AttemptStatus::Completed
        && !(matches!(
            delivery.kind,
            crate::core::flight::DeliveryKind::PullRequest
        ) && attempt.status == AttemptStatus::Reviewing)
    {
        return Err("Accept this attempt before delivering it.".into());
    }
    attempt.delivery = Some(delivery.clone());
    flight.delivery = Some(delivery);
    flight.updated_at = now();
    Ok(())
}

pub(super) async fn validate_delivery_record(
    flight_id: &str,
    attempt_id: &str,
    delivery: &crate::api::FlightDeliveryDto,
) -> Result<(), String> {
    if !matches!(delivery.kind.as_str(), "landed" | "pull_request") {
        return Err("Unknown delivery kind.".into());
    }
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
    if attempt.status == AttemptStatus::Reviewing {
        super::flight_review::validate_acceptance(flight, attempt).await?;
    }
    if attempt.status == AttemptStatus::Completed {
        super::flight_review::validate_delivery(flight, attempt).await?;
    }
    Ok(())
}

#[tauri::command]
pub async fn record_attempt_delivery(
    flight_id: String,
    attempt_id: String,
    delivery: crate::api::FlightDeliveryDto,
) -> Result<(), String> {
    validate_delivery_record(&flight_id, &attempt_id, &delivery).await?;
    storage::with_state_lock(move |state| {
        let result = (|| {
            let flight = state
                .flights
                .iter_mut()
                .find(|flight| flight.id == flight_id)
                .ok_or("Flight not found.")?;
            apply_delivery(flight, &attempt_id, delivery.into())
        })();
        std::future::ready(result)
    })
    .await
}

/// Resolve the remote from the registered execution target, including its
/// saved SSH host key. Accepted attempts may no longer have a worktree.
#[tauri::command]
pub async fn get_flight_attempt_origin(
    flight_id: String,
    attempt_id: String,
) -> Result<String, String> {
    let snapshot = storage::load_state();
    let mut attempt = snapshot
        .flights
        .iter()
        .find(|flight| flight.id == flight_id)
        .and_then(|flight| {
            flight
                .attempts
                .iter()
                .find(|attempt| attempt.id == attempt_id)
        })
        .cloned()
        .ok_or("Attempt not found.")?;
    match &mut attempt.target {
        crate::core::flight::AttemptTarget::Local {
            base_path,
            worktree_path,
        }
        | crate::core::flight::AttemptTarget::Ssh {
            base_path,
            worktree_path,
            ..
        } => *worktree_path = base_path.clone(),
    }
    let origins = super::flight_review::read(
        &attempt,
        &["remote", "get-url", "--push", "--all", "origin"],
    )
    .await?;
    let values: Vec<_> = origins
        .lines()
        .filter(|line| !line.trim().is_empty())
        .collect();
    if values.len() != 1 {
        return Err("Flight publishing requires exactly one origin push URL. Resolve multiple push destinations before publishing.".into());
    }
    Ok(values[0].to_string())
}

fn stop(flight: &mut Flight, clock: u64) -> HashSet<String> {
    let ids = owned_session_ids(flight);
    let at = clock
        .max(flight.updated_at.saturating_add(1))
        .max(flight.stopped_at.unwrap_or(0).saturating_add(1));
    flight.stopped_at = Some(at);
    flight.updated_at = at;
    flight.status = crate::core::flight::FlightStatus::Paused;
    for attempt in &mut flight.attempts {
        if matches!(
            attempt.status,
            AttemptStatus::Queued
                | AttemptStatus::Provisioning
                | AttemptStatus::Running
                | AttemptStatus::Reviewing
        ) {
            attempt.status = AttemptStatus::Cancelled;
            attempt.completed_at = Some(at);
            retained(
                attempt,
                "Stopped by the user; worktree retained for inspection or explicit recovery.",
                at,
            );
            if let Some(gate) = &mut attempt.review_gate {
                if matches!(
                    gate.status,
                    ReviewGateStatus::Pending | ReviewGateStatus::Running
                ) {
                    gate.status = ReviewGateStatus::Error;
                    gate.error_message =
                        Some("The Flight was stopped before review finished.".into());
                }
            }
        }
    }
    for task in flight
        .milestones
        .iter_mut()
        .flat_map(|milestone| &mut milestone.tasks)
    {
        if matches!(
            task.status,
            crate::core::flight::TaskStatus::Running
                | crate::core::flight::TaskStatus::Queued
                | crate::core::flight::TaskStatus::ApprovalNeeded
        ) {
            task.status = crate::core::flight::TaskStatus::Paused;
        }
    }
    if let Some(runtime) = &mut flight.autonomy_runtime {
        if runtime.status != crate::core::flight::AutonomyRunStatus::NeedsAttention {
            runtime.status = crate::core::flight::AutonomyRunStatus::Stopped;
        }
        runtime.stopped_at = Some(at);
        if runtime.hard_stop_reason.is_none() {
            runtime.hard_stop_reason = Some("Stopped by the user.".into());
        }
    }
    ids
}

#[tauri::command]
pub async fn stop_flight_sessions(
    state: tauri::State<'_, Arc<ApiAgentState>>,
    sidecar: tauri::State<'_, Arc<SidecarManager>>,
    flight_id: String,
) -> Result<(), String> {
    let ids = storage::with_state_lock({
        let flight_id = flight_id.clone();
        move |snapshot| {
            let result = (|| {
                let flight = snapshot
                    .flights
                    .iter_mut()
                    .find(|flight| flight.id == flight_id)
                    .ok_or("Flight not found.")?;
                let ids = stop(flight, now());
                Ok(ids)
            })();
            std::future::ready(result)
        }
    })
    .await?;
    let mut pending = launches()
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .get(&flight_id)
        .cloned()
        .unwrap_or_default();
    for launch in &pending {
        launch.cancel.cancel();
    }
    for id in &ids {
        if let Some(start) = cancel_session_start(id) {
            pending.push(start);
        }
    }
    let mut failures = Vec::new();
    for id in ids {
        if let Err(error) =
            close_api_agent_session(state.clone(), sidecar.clone(), id.clone()).await
        {
            failures.push(error);
        }
        if let Err(error) = state.wait_for_session_stop(&id).await {
            failures.push(error);
        }
    }
    drain(pending).await?;
    if failures.is_empty() {
        Ok(())
    } else {
        Err(format!(
            "Some Flight sessions could not confirm Stop: {}. All worktrees were retained.",
            failures.join("; ")
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn fixture() -> Flight {
        serde_json::from_value(json!({"id":"f", "title":"Retained", "objective":"Recover safely", "status":"active", "priority":"high", "project_path":"D:/fixture", "git_branch":null, "milestones":[], "linked_session_ids":["unowned-reference"], "created_at":0, "updated_at":0,"completed_at":null,"total_cost":0,"total_tokens":0,
            "attempts":[{"id":"a","flight_id":"f","target":{"kind":"local","base_path":"D:/fixture","worktree_path":"D:/fixture/retained"},"agent_config_id":"api-openai","model":"builder-model","provider":"openai","branch":"pkt/a","base_branch":"main","session_id":"builder","status":"running"}]})).unwrap()
    }

    #[test]
    fn prepared_frontend_admission_failure_retains_files_but_never_revives_stopped_or_newer_sessions(
    ) {
        let mut flight = fixture();
        flight.attempts[0].status = AttemptStatus::Provisioning;
        fail_prepared_start(&mut flight, "a", "builder", "Budget refused").unwrap();
        assert_eq!(flight.attempts[0].status, AttemptStatus::Failed);
        assert!(matches!(
            flight.attempts[0].recovery.as_ref().unwrap().state,
            RecoveryState::Retained
        ));
        assert!(flight.attempts[0]
            .error_message
            .as_ref()
            .unwrap()
            .contains("Budget refused"));
        let path = flight.attempts[0].target.clone();
        assert_eq!(
            serde_json::to_value(path).unwrap()["worktree_path"],
            "D:/fixture/retained"
        );

        let mut stopped = fixture();
        stop(&mut stopped, 123);
        fail_prepared_start(&mut stopped, "a", "builder", "late error").unwrap();
        assert_eq!(stopped.attempts[0].status, AttemptStatus::Cancelled);
        assert!(stopped.attempts[0].error_message.is_none());

        let mut newer = fixture();
        newer.attempts[0].status = AttemptStatus::Provisioning;
        newer.attempts[0].session_id = "new-builder".into();
        fail_prepared_start(&mut newer, "a", "builder", "obsolete error").unwrap();
        assert_eq!(newer.attempts[0].status, AttemptStatus::Provisioning);
    }

    #[test]
    fn admitted_repair_turn_is_running_and_revokes_pass_without_erasing_reviewer_owners() {
        let mut flight = fixture();
        flight.attempts[0].status = AttemptStatus::Reviewing;
        flight.attempts[0].review_gate = Some(serde_json::from_value(json!({"status":"passed","reviewer_sessions":[{"session_id":"reviewer","provider":"openai","model":"review-model"}],"overridden_at":5,"override_reason":"old override"})).unwrap());
        let mut state = storage::PersistedState {
            flights: vec![flight],
            ..Default::default()
        };
        apply_builder_turn(&mut state, "builder").unwrap();
        let attempt = &state.flights[0].attempts[0];
        assert_eq!(attempt.status, AttemptStatus::Running);
        let gate = attempt.review_gate.as_ref().unwrap();
        assert_eq!(gate.status, ReviewGateStatus::Error);
        assert!(gate.evidence.is_none());
        assert!(gate.overridden_at.is_none());
        assert_eq!(gate.reviewer_sessions[0].session_id, "reviewer");
        state.flights[0].stopped_at = Some(99);
        assert!(apply_builder_turn(&mut state, "builder").is_err());
    }

    #[test]
    fn stop_fences_repeated_stops_and_cas_begin_without_implicit_restart() {
        let mut flight = fixture();
        stop(&mut flight, 123);
        assert_eq!(flight.stopped_at, Some(123));
        stop(&mut flight, 123);
        assert_eq!(flight.stopped_at, Some(124));
        assert!(begin(&mut flight, Some(123)).is_err());
        assert_eq!(flight.stopped_at, Some(124));
        begin(&mut flight, Some(124)).unwrap();
        assert_eq!(flight.stopped_at, None);
        let updated_at = flight.updated_at;
        begin(&mut flight, None).unwrap();
        assert_eq!(flight.updated_at, updated_at);
    }

    #[test]
    fn same_millisecond_stop_begin_stop_never_reuses_a_stop_fence() {
        let mut flight = fixture();
        stop(&mut flight, 123);
        begin_at(&mut flight, Some(123), 123).unwrap();
        stop(&mut flight, 123);
        assert_eq!(flight.stopped_at, Some(124));
        assert!(begin_at(&mut flight, Some(123), 123).is_err());
        begin_at(&mut flight, Some(124), 122).unwrap();
        assert_eq!(flight.updated_at, 124);
        stop(&mut flight, 122);
        assert_eq!(flight.stopped_at, Some(125));
    }

    #[test]
    fn historical_builder_is_accounted_and_stoppable_but_never_admitted_again() {
        let mut flight = fixture();
        stop(&mut flight, 123);
        begin_at(&mut flight, Some(123), 123).unwrap();
        let resumed = prepare_resume(&mut flight, "a", "builder").unwrap();
        assert!(
            validate_session_admission(std::slice::from_ref(&flight), "builder")
                .unwrap_err()
                .contains("Historical")
        );
        validate_session_admission(std::slice::from_ref(&flight), &resumed.session_id).unwrap();
        assert!(owned_session_ids(&flight).contains("builder"));
        let mut state = storage::PersistedState {
            flights: vec![flight],
            ..Default::default()
        };
        assert!(apply_builder_turn(&mut state, "builder").is_err());
        assert_eq!(state.flights[0].attempts[0].session_id, resumed.session_id);
        assert_eq!(
            state.flights[0].attempts[0].status,
            AttemptStatus::Provisioning
        );
        let owner =
            crate::commands::flight_cost::flight_for_executor_session(&state, "builder").unwrap();
        assert_eq!(owner.model, "builder-model");
    }

    #[test]
    fn stop_owns_all_builder_and_reviewer_sessions_and_leaves_retryable_files() {
        let mut flight = fixture();
        flight.attempts[0].status = AttemptStatus::Reviewing;
        flight.attempts[0].session_history = Some(vec![crate::core::flight::ReviewerSession {
            session_id: "old-builder".into(),
            provider: "old-provider".into(),
            model: "old-model".into(),
        }]);
        flight.attempts[0].review_gate = Some(serde_json::from_value(json!({"status":"running", "reviewer_conversation_id":"reviewer", "reviewer_sessions":[{"session_id":"old-reviewer","provider":"openai","model":"review-model"}]})).unwrap());
        let ids = stop(&mut flight, 10);
        for id in ["builder", "old-builder", "reviewer", "old-reviewer"] {
            assert!(ids.contains(id));
        }
        assert!(!ids.contains("unowned-reference"));
        let attempt = &flight.attempts[0];
        assert_eq!(attempt.status, AttemptStatus::Cancelled);
        assert!(matches!(
            attempt.recovery.as_ref().unwrap().state,
            RecoveryState::Retained
        ));
        assert_eq!(
            attempt.review_gate.as_ref().unwrap().status,
            ReviewGateStatus::Error
        );
        assert!(
            matches!(&attempt.target, crate::core::flight::AttemptTarget::Local {worktree_path,..} if worktree_path == "D:/fixture/retained")
        );
    }

    #[test]
    fn resume_registers_a_new_builder_and_keeps_delayed_usage_ownership() {
        let mut flight = fixture();
        stop(&mut flight, 10);
        begin(&mut flight, Some(10)).unwrap();
        let prepared = prepare_resume(&mut flight, "a", "builder").unwrap();
        assert_ne!(prepared.session_id, "builder");
        assert_eq!(prepared.status, AttemptStatus::Provisioning);
        assert!(prepared.recovery.is_none());
        assert!(prepare_resume(&mut flight, "a", "builder").is_err());
        let state = storage::PersistedState {
            flights: vec![flight],
            ..Default::default()
        };
        let owner =
            crate::commands::flight_cost::flight_for_executor_session(&state, "builder").unwrap();
        assert_eq!(
            (owner.provider.as_str(), owner.model.as_str()),
            ("openai", "builder-model")
        );
        assert!(owned_session_ids(&state.flights[0]).contains(&prepared.session_id));
    }

    #[test]
    fn resume_validates_and_reopens_atomically_including_legacy_retained_reviewing() {
        let mut flight = fixture();
        stop(&mut flight, 10);
        flight.attempts[0].status = AttemptStatus::Reviewing;
        flight.attempts[0].review_gate = Some(serde_json::from_value(json!({"status":"passed", "reviewer_conversation_id":"old-reviewer", "reviewer_sessions":[{"session_id":"old-reviewer","provider":"openai","model":"review-model"}]})).unwrap());
        let prepared = prepare_and_begin_resume(
            &mut flight,
            "a",
            "builder",
            Some(10),
            &CancellationToken::new(),
        )
        .unwrap();
        assert_eq!(flight.stopped_at, None);
        assert_eq!(prepared.status, AttemptStatus::Provisioning);
        assert_ne!(prepared.session_id, "builder");
        assert_eq!(
            prepared.review_gate.as_ref().unwrap().status,
            ReviewGateStatus::Error
        );
        assert!(prepared.review_gate.as_ref().unwrap().evidence.is_none());
        assert_eq!(
            prepared.review_gate.as_ref().unwrap().reviewer_sessions[0].session_id,
            "old-reviewer"
        );
    }

    #[test]
    fn failed_resume_never_reopens_or_changes_the_retained_attempt() {
        let mut baseline = fixture();
        stop(&mut baseline, 10);
        baseline.attempts[0].status = AttemptStatus::Reviewing;
        for failure in ["orphan", "new-stop", "new-owner", "cancelled", "archived"] {
            let mut flight = baseline.clone();
            let cancel = CancellationToken::new();
            match failure {
                "orphan" => flight.attempts[0].task_id = Some("missing-task".into()),
                "new-stop" => flight.stopped_at = Some(11),
                "new-owner" => flight.attempts[0].session_id = "new-owner".into(),
                "cancelled" => cancel.cancel(),
                "archived" => flight.archived_at = Some(12),
                _ => unreachable!(),
            }
            let before = serde_json::to_value(&flight).unwrap();
            assert!(
                prepare_and_begin_resume(&mut flight, "a", "builder", Some(10), &cancel).is_err(),
                "{failure}"
            );
            assert_eq!(serde_json::to_value(&flight).unwrap(), before, "{failure}");
        }
        begin(&mut baseline, Some(10)).unwrap();
        assert!(validate_resume(&baseline, &baseline.attempts[0]).is_err());
    }

    #[tokio::test]
    async fn recovery_requires_idle_reviewers_and_builder_startups() {
        let mut flight = fixture();
        let id = uuid::Uuid::new_v4().to_string();
        flight.attempts[0].session_id = id.clone();
        let state = ApiAgentState::new();
        ensure_recovery_idle(&state, &flight.attempts[0])
            .await
            .unwrap();
        sidecar_active(&id, true);
        assert!(ensure_recovery_idle(&state, &flight.attempts[0])
            .await
            .is_err());
        sidecar_active(&id, false);
        let (guard, pending) = admission();
        sessions().lock().unwrap().insert(id.clone(), pending);
        assert!(ensure_recovery_idle(&state, &flight.attempts[0])
            .await
            .is_err());
        drop(guard);
        ensure_recovery_idle(&state, &flight.attempts[0])
            .await
            .unwrap();
        sessions().lock().unwrap().remove(&id);
    }

    #[test]
    fn resume_rejects_active_or_unretained_or_orphaned_attempts() {
        let mut flight = fixture();
        assert!(validate_resume(&flight, &flight.attempts[0]).is_err());
        stop(&mut flight, 10);
        begin(&mut flight, Some(10)).unwrap();
        flight.attempts[0].task_id = Some("missing-task".into());
        assert!(validate_resume(&flight, &flight.attempts[0])
            .unwrap_err()
            .contains("no longer"));
        flight.attempts[0].task_id = None;
        flight.attempts[0].recovery.as_mut().unwrap().state = RecoveryState::Discarded;
        assert!(validate_resume(&flight, &flight.attempts[0]).is_err());
    }

    #[tokio::test]
    async fn admission_drain_waits_for_cancelled_startup_to_release() {
        let (guard, pending) = admission();
        pending.cancel.cancel();
        assert!(guard.cancel.is_cancelled());
        let drain = tokio::spawn(drain(vec![pending]));
        tokio::task::yield_now().await;
        assert!(!drain.is_finished());
        drop(guard);
        drain.await.unwrap().unwrap();
    }

    #[tokio::test]
    async fn sidecar_stop_waits_for_terminal_acknowledgement() {
        let id = uuid::Uuid::new_v4().to_string();
        sidecar_active(&id, true);
        let waiting = tokio::spawn({
            let id = id.clone();
            async move { wait_sidecar_idle(&id).await }
        });
        tokio::task::yield_now().await;
        assert!(!waiting.is_finished());
        sidecar_active(&id, false);
        waiting.await.unwrap().unwrap();
    }

    #[test]
    fn delivery_requires_accepted_identity_and_real_outcome() {
        let mut flight = fixture();
        let mut delivery = crate::core::flight::FlightDelivery {
            kind: crate::core::flight::DeliveryKind::Landed,
            delivered_at: 10,
            branch: "pkt/a".into(),
            base_branch: "main".into(),
            commit_sha: Some("abc".into()),
            pr_number: None,
            pr_url: None,
            attempt_id: Some("a".into()),
        };
        assert!(apply_delivery(&mut flight, "a", delivery.clone()).is_err());
        flight.attempts[0].status = AttemptStatus::Completed;
        delivery.commit_sha = None;
        assert!(apply_delivery(&mut flight, "a", delivery.clone()).is_err());
        delivery.commit_sha = Some("abc".into());
        apply_delivery(&mut flight, "a", delivery).unwrap();
        assert_eq!(
            flight.delivery.as_ref().unwrap().commit_sha.as_deref(),
            Some("abc")
        );
        assert!(flight.attempts[0].delivery.is_some());
        flight.delivery = None;
        flight.execution_mode = Some(crate::core::flight::FlightExecutionMode::Cooperative);
        let delivery = flight.attempts[0].delivery.clone().unwrap();
        assert!(apply_delivery(&mut flight, "a", delivery).is_err());
        assert!(flight.delivery.is_none());
    }
}
