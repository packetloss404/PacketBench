//! Review verdicts bind to committed code and the criteria actually reviewed.
//! The base commit is pinned: another accepted task (including this attempt)
//! may advance the cooperative integration branch without changing this review.

use crate::core::flight::{Attempt, AttemptTarget, Flight, ReviewGateEvidence, ReviewGateStatus};
use crate::core::{storage, worktree};
use sha2::{Digest, Sha256};

fn digest(value: &serde_json::Value) -> String {
    format!("{:x}", Sha256::digest(value.to_string().as_bytes()))
}

fn review_context(flight: &Flight, attempt: &Attempt) -> serde_json::Value {
    let task = flight.milestones.iter().find_map(|milestone| {
        milestone
            .tasks
            .iter()
            .find(|task| Some(&task.id) == attempt.task_id.as_ref())
            .map(|task| {
                serde_json::json!({
                    "id": task.id, "title": task.title, "description": task.description,
                    "dependsOn": task.depends_on, "ownedPaths": task.owned_paths,
                    "validationCriteria": milestone.validation_criteria,
                })
            })
    });
    serde_json::json!({
        "flightId": flight.id, "attemptId": attempt.id,
        "objective": flight.objective, "prompt": flight.prompt,
        "criteria": flight.review_gate_policy.as_ref().map(|policy| &policy.acceptance_criteria),
        "target": attempt.target, "branch": attempt.branch, "baseBranch": attempt.base_branch,
        "taskId": attempt.task_id, "task": task,
    })
}

pub(super) fn context_fingerprint(flight: &Flight, attempt: &Attempt) -> String {
    digest(&review_context(flight, attempt))
}

async fn git_read(attempt: &Attempt, args: Vec<String>) -> Result<String, String> {
    let path = match &attempt.target {
        AttemptTarget::Local { worktree_path, .. } | AttemptTarget::Ssh { worktree_path, .. } => {
            worktree_path.clone()
        }
    };
    if let AttemptTarget::Ssh { server_id, .. } = &attempt.target {
        let cfg = super::flight_attempts::resolve_server_ssh_config(server_id, &path)
            .ok_or("The review SSH server is no longer configured.")?;
        if cfg
            .host_fingerprint
            .as_ref()
            .is_none_or(|fingerprint| fingerprint.trim().is_empty())
        {
            return Err("Pin the review SSH server's host key before reviewing.".into());
        }
        let refs = args.iter().map(String::as_str).collect::<Vec<_>>();
        let (output, code) = worktree::ssh_git_read(&cfg, &path, &refs).await?;
        if code != 0 {
            return Err(format!("Review git command failed: {}", output.trim()));
        }
        return Ok(output.trim().to_string());
    }
    tokio::task::spawn_blocking(move || {
        super::validate_project_path(&path)?;
        let mut command = std::process::Command::new("git");
        super::shared::hide_window(&mut command);
        let output = command
            .args(&args)
            .current_dir(path)
            .output()
            .map_err(|error| format!("Review git command failed: {error}"))?;
        if !output.status.success() {
            return Err(format!(
                "Review git command failed: {}",
                String::from_utf8_lossy(&output.stderr).trim()
            ));
        }
        Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
    })
    .await
    .map_err(|error| format!("Review git task failed: {error}"))?
}

pub(super) async fn read(attempt: &Attempt, args: &[&str]) -> Result<String, String> {
    git_read(attempt, args.iter().map(|arg| (*arg).to_string()).collect()).await
}

pub(super) async fn capture(
    flight: &Flight,
    attempt: &Attempt,
    pinned_base: Option<&str>,
) -> Result<ReviewGateEvidence, String> {
    let head = read(attempt, &["rev-parse", "HEAD"]).await?;
    let branch = read(attempt, &["symbolic-ref", "--short", "HEAD"]).await?;
    if branch != attempt.branch {
        return Err("The attempt branch changed; review again after restoring it.".into());
    }
    // Git HEAD binds the entire committed tree, not the bounded presentation
    // patch. Dirty and untracked files must be committed before a pass can bind.
    if !read(
        attempt,
        &[
            "status",
            "--porcelain",
            "--untracked-files=all",
            "--ignore-submodules=none",
        ],
    )
    .await?
    .is_empty()
    {
        return Err("Commit or remove all uncommitted and untracked changes before reviewing or accepting this attempt.".into());
    }
    let base_ref = pinned_base.unwrap_or(&attempt.base_branch);
    let base = read(
        attempt,
        &["rev-parse", "--verify", &format!("{base_ref}^{{commit}}")],
    )
    .await?;
    if read(attempt, &["rev-parse", "HEAD"]).await? != head {
        return Err("The attempt changed while collecting review evidence; retry review.".into());
    }
    let context = context_fingerprint(flight, attempt);
    let fingerprint = digest(&serde_json::json!({"head": head, "base": base, "context": context}));
    Ok(ReviewGateEvidence {
        fingerprint,
        context_fingerprint: context,
        context_json: review_context(flight, attempt).to_string(),
        base_sha: base,
        head_sha: head,
    })
}

pub(super) async fn validate(
    flight: &Flight,
    attempt: &Attempt,
    evidence: Option<&ReviewGateEvidence>,
) -> Result<(), String> {
    let evidence = evidence
        .ok_or("This review has no code fingerprint. Run the reviewer again before acceptance.")?;
    let fresh = capture(flight, attempt, Some(&evidence.base_sha)).await?;
    if &fresh != evidence {
        return Err("The reviewed code or acceptance criteria changed. Run the reviewer again or record an explicit override.".into());
    }
    Ok(())
}

pub(super) async fn validate_acceptance(flight: &Flight, attempt: &Attempt) -> Result<(), String> {
    if !read(
        attempt,
        &[
            "status",
            "--porcelain",
            "--untracked-files=all",
            "--ignore-submodules=none",
        ],
    )
    .await?
    .is_empty()
    {
        return Err("The attempt has uncommitted files. Inspect its retained worktree and commit staged, unstaged and untracked changes before accepting.".into());
    }
    if !flight
        .review_gate_policy
        .as_ref()
        .is_some_and(|policy| policy.enabled)
    {
        return Ok(());
    }
    let gate = attempt
        .review_gate
        .as_ref()
        .ok_or("Run the Reviewer Gate before acceptance.")?;
    match gate.status {
        ReviewGateStatus::Passed => validate(flight, attempt, gate.evidence.as_ref()).await,
        ReviewGateStatus::Overridden
            if gate.overridden_at.is_some()
                && gate
                    .override_reason
                    .as_ref()
                    .is_some_and(|reason| reason.trim().len() >= 3) =>
        {
            Ok(())
        }
        _ => Err(
            "The Reviewer Gate must pass or have a reasoned explicit override before acceptance."
                .into(),
        ),
    }
}

/// Integration happens before the attempt is marked completed. Check here too,
/// so stale reviewed code cannot be merged and only then rejected at teardown.
pub(super) async fn validate_integration(
    integration_path: &str,
    attempt_path: &str,
    attempt_branch: &str,
) -> Result<String, String> {
    let snapshot = storage::load_state();
    let flight = snapshot
        .flights
        .iter()
        .find(|flight| {
            flight
                .integration_branch
                .as_ref()
                .is_some_and(|integration| integration.worktree_path == integration_path)
        })
        .ok_or("The Flight integration worktree is no longer registered.")?;
    let attempt = flight
        .attempts
        .iter()
        .find(|attempt| {
            let path = match &attempt.target {
                AttemptTarget::Local { worktree_path, .. }
                | AttemptTarget::Ssh { worktree_path, .. } => worktree_path,
            };
            path == attempt_path && attempt.branch == attempt_branch
        })
        .ok_or("The Flight attempt is no longer registered.")?;
    validate_acceptance(flight, attempt).await?;
    if flight
        .review_gate_policy
        .as_ref()
        .is_some_and(|policy| policy.enabled)
    {
        if let Some(gate) = &attempt.review_gate {
            if gate.status == ReviewGateStatus::Passed {
                return gate
                    .evidence
                    .as_ref()
                    .map(|evidence| evidence.head_sha.clone())
                    .ok_or("The reviewed commit is missing.".into());
            }
        }
    }
    read(
        attempt,
        &[
            "rev-parse",
            "--verify",
            &format!("{}^{{commit}}", attempt.branch),
        ],
    )
    .await
}

#[tauri::command]
pub async fn capture_attempt_review_evidence(
    flight_id: String,
    attempt_id: String,
) -> Result<crate::api::ReviewGateEvidenceDto, String> {
    let state = storage::load_state();
    let flight = state
        .flights
        .iter()
        .find(|flight| flight.id == flight_id)
        .ok_or("Flight not found.")?;
    let attempt = flight
        .attempts
        .iter()
        .find(|attempt| attempt.id == attempt_id)
        .ok_or("Attempt not found.")?;
    capture(flight, attempt, None).await.map(Into::into)
}

#[tauri::command]
pub async fn validate_attempt_review_gate(
    flight_id: String,
    attempt_id: String,
) -> Result<(), String> {
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
    let result = validate_acceptance(flight, attempt).await;
    if let Err(reason) = &result {
        if attempt
            .review_gate
            .as_ref()
            .is_some_and(|gate| gate.status == ReviewGateStatus::Passed)
        {
            let expected = attempt.review_gate.clone();
            let reason = reason.clone();
            storage::with_state_lock(move |state| {
                if let Some(attempt) = state
                    .flights
                    .iter_mut()
                    .find(|flight| flight.id == flight_id)
                    .and_then(|flight| {
                        flight
                            .attempts
                            .iter_mut()
                            .find(|attempt| attempt.id == attempt_id)
                    })
                {
                    if let Some(gate) = &mut attempt.review_gate {
                        if gate.status == ReviewGateStatus::Passed
                            && gate.evidence
                                == expected.as_ref().and_then(|gate| gate.evidence.clone())
                            && gate.reviewer_conversation_id
                                == expected
                                    .as_ref()
                                    .and_then(|gate| gate.reviewer_conversation_id.clone())
                        {
                            gate.status = ReviewGateStatus::Error;
                            gate.error_message = Some(reason);
                        }
                    }
                }
                std::future::ready(Ok(()))
            })
            .await?;
        }
    }
    result
}

/// Accepted attempts retain a branch after their worktree is removed. A later
/// Land/Publish must deliver the exact reviewed commit, even if that branch was
/// edited in another checkout in the meantime.
pub(super) async fn validate_delivery(flight: &Flight, attempt: &Attempt) -> Result<(), String> {
    if !flight
        .review_gate_policy
        .as_ref()
        .is_some_and(|policy| policy.enabled)
    {
        return Ok(());
    }
    let gate = attempt
        .review_gate
        .as_ref()
        .ok_or("Run the Reviewer Gate before delivering this attempt.")?;
    if gate.status == ReviewGateStatus::Overridden
        && gate.overridden_at.is_some()
        && gate
            .override_reason
            .as_ref()
            .is_some_and(|reason| reason.trim().len() >= 3)
    {
        return Ok(());
    }
    if gate.status != ReviewGateStatus::Passed {
        return Err(
            "The Reviewer Gate must pass or have an explicit override before delivery.".into(),
        );
    }
    let evidence = gate.evidence.as_ref().ok_or(
        "This review has no code fingerprint. Review the retained branch again before delivery.",
    )?;
    let mut repository_attempt = attempt.clone();
    match &mut repository_attempt.target {
        AttemptTarget::Local {
            base_path,
            worktree_path,
        }
        | AttemptTarget::Ssh {
            base_path,
            worktree_path,
            ..
        } => *worktree_path = base_path.clone(),
    }
    let head = read(
        &repository_attempt,
        &[
            "rev-parse",
            "--verify",
            &format!("{}^{{commit}}", attempt.branch),
        ],
    )
    .await?;
    if head != evidence.head_sha
        || context_fingerprint(flight, attempt) != evidence.context_fingerprint
    {
        return Err("The retained branch or review criteria changed after review. Review this code again before landing or publishing it.".into());
    }
    Ok(())
}

#[tauri::command]
pub async fn validate_attempt_delivery(
    flight_id: String,
    attempt_id: String,
) -> Result<(), String> {
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
    let result = validate_delivery(flight, attempt).await;
    if let Err(reason) = &result {
        let expected = attempt.review_gate.clone();
        let reason = reason.clone();
        storage::with_state_lock(move |state| {
            if let Some(attempt) = state
                .flights
                .iter_mut()
                .find(|flight| flight.id == flight_id)
                .and_then(|flight| {
                    flight
                        .attempts
                        .iter_mut()
                        .find(|attempt| attempt.id == attempt_id)
                })
            {
                if let Some(gate) = &mut attempt.review_gate {
                    if gate.status == ReviewGateStatus::Passed
                        && gate.evidence == expected.as_ref().and_then(|gate| gate.evidence.clone())
                        && gate.reviewer_conversation_id
                            == expected
                                .as_ref()
                                .and_then(|gate| gate.reviewer_conversation_id.clone())
                    {
                        gate.status = ReviewGateStatus::Error;
                        gate.error_message = Some(reason);
                    }
                }
            }
            std::future::ready(Ok(()))
        })
        .await?;
    }
    result
}

fn repository_attempt(attempt: &Attempt) -> Attempt {
    let mut repository = attempt.clone();
    match &mut repository.target {
        AttemptTarget::Local {
            base_path,
            worktree_path,
        }
        | AttemptTarget::Ssh {
            base_path,
            worktree_path,
            ..
        } => *worktree_path = base_path.clone(),
    }
    repository
}

pub(super) async fn reviewed_delivery_head(
    flight: &Flight,
    attempt: &Attempt,
) -> Result<String, String> {
    validate_delivery(flight, attempt).await?;
    let repository = repository_attempt(attempt);
    read(
        &repository,
        &[
            "check-ref-format",
            &format!("refs/heads/{}", attempt.branch),
        ],
    )
    .await?;
    if flight
        .review_gate_policy
        .as_ref()
        .is_some_and(|policy| policy.enabled)
    {
        if let Some(gate) = &attempt.review_gate {
            if gate.status == ReviewGateStatus::Passed {
                return gate
                    .evidence
                    .as_ref()
                    .map(|evidence| evidence.head_sha.clone())
                    .ok_or("The reviewed commit is missing.".into());
            }
        }
    }
    read(
        &repository,
        &[
            "rev-parse",
            "--verify",
            &format!("{}^{{commit}}", attempt.branch),
        ],
    )
    .await
}

#[tauri::command]
pub async fn land_reviewed_attempt(
    flight_id: String,
    attempt_id: String,
    squash: Option<bool>,
) -> Result<crate::core::git::MergeBranchOutcome, String> {
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
    if flight.execution_mode == Some(crate::core::flight::FlightExecutionMode::Cooperative) {
        return Err("Land the combined cooperative Flight after all tasks are integrated.".into());
    }
    if attempt.status != crate::core::flight::AttemptStatus::Completed {
        return Err("Accept this attempt before landing its branch.".into());
    }
    let head = reviewed_delivery_head(flight, attempt).await?;
    let repository = repository_attempt(attempt);
    if read(&repository, &["symbolic-ref", "--short", "HEAD"]).await? != attempt.base_branch {
        return Err("The base checkout is on another branch. Restore the intended delivery branch before landing.".into());
    }
    let outcome = match &attempt.target {
        AttemptTarget::Local { base_path, .. } => {
            let base_path = base_path.clone();
            let branch = attempt.branch.clone();
            tokio::task::spawn_blocking(move || {
                super::validate_project_path(&base_path)?;
                crate::core::git::merge_conversation_branch_at_ref(
                    &base_path,
                    &branch,
                    squash.unwrap_or(true),
                    &head,
                )
            })
            .await
            .map_err(|error| format!("Reviewed landing task failed: {error}"))??
        }
        AttemptTarget::Ssh {
            base_path,
            server_id,
            ..
        } => {
            let config = super::flight_attempts::resolve_server_ssh_config(server_id, base_path)
                .ok_or("The saved SSH target is unavailable; restore it before landing.")?;
            worktree::land_remote_attempt_at_ref(
                &config,
                base_path,
                &attempt.base_branch,
                &attempt.branch,
                &head,
                squash.unwrap_or(true),
            )
            .await?
        }
    };
    if !outcome.nothing_to_land {
        let delivery = crate::core::flight::FlightDelivery {
            kind: crate::core::flight::DeliveryKind::Landed,
            delivered_at: super::flight_runtime::now(),
            branch: attempt.branch.clone(),
            base_branch: attempt.base_branch.clone(),
            commit_sha: Some(outcome.commit_sha.clone()),
            pr_number: None,
            pr_url: None,
            attempt_id: Some(attempt_id.clone()),
        };
        storage::with_state_lock(move |state| {
            let result = (|| {
                let flight = state
                    .flights
                    .iter_mut()
                    .find(|flight| flight.id == flight_id)
                    .ok_or("Flight not found.")?;
                super::flight_runtime::apply_delivery(flight, &attempt_id, delivery)
            })();
            std::future::ready(result)
        })
        .await?;
    }
    Ok(outcome)
}

#[tauri::command]
pub async fn push_reviewed_attempt(
    flight_id: String,
    attempt_id: String,
    expected_origin: Option<String>,
) -> Result<String, String> {
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
    if flight.execution_mode == Some(crate::core::flight::FlightExecutionMode::Cooperative) {
        return Err(
            "Deliver the combined cooperative Flight after all tasks are integrated.".into(),
        );
    }
    if !matches!(
        attempt.status,
        crate::core::flight::AttemptStatus::Completed
            | crate::core::flight::AttemptStatus::Reviewing
    ) {
        return Err("Accept this attempt before publishing its branch.".into());
    }
    if attempt.status == crate::core::flight::AttemptStatus::Reviewing {
        validate_acceptance(flight, attempt).await?;
    }
    let head = reviewed_delivery_head(flight, attempt).await?;
    let origin = super::flight_runtime::get_flight_attempt_origin(flight_id, attempt_id).await?;
    if expected_origin
        .as_ref()
        .is_some_and(|expected| expected != &origin)
    {
        return Err(
            "The attempt push destination changed. Resolve its Git host again before publishing."
                .into(),
        );
    }
    push_commit_to(attempt, &head, &origin).await
}

#[cfg(test)]
async fn push_commit(attempt: &Attempt, head: &str) -> Result<String, String> {
    let repository = repository_attempt(attempt);
    let origins = read(
        &repository,
        &["remote", "get-url", "--push", "--all", "origin"],
    )
    .await?;
    if origins.lines().count() != 1 {
        return Err("Flight publishing requires exactly one origin push URL.".into());
    }
    push_commit_to(attempt, head, &origins).await
}

async fn push_commit_to(attempt: &Attempt, head: &str, origin: &str) -> Result<String, String> {
    let repository = repository_attempt(attempt);
    // No force, and no moving branch source: Git receives the reviewed object
    // ID even when another checkout advances the retained branch afterwards.
    read(
        &repository,
        &[
            "push",
            "--",
            origin,
            &format!("{head}:refs/heads/{}", attempt.branch),
        ],
    )
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn git(path: &std::path::Path, args: &[&str]) -> String {
        let output = std::process::Command::new("git")
            .current_dir(path)
            .args(args)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        String::from_utf8_lossy(&output.stdout).trim().into()
    }

    fn fixture() -> (tempfile::TempDir, Flight, Attempt) {
        let dir = tempfile::tempdir().unwrap();
        git(dir.path(), &["init", "-b", "attempt"]);
        git(dir.path(), &["config", "user.name", "Review test"]);
        git(
            dir.path(),
            &["config", "user.email", "review@example.invalid"],
        );
        git(dir.path(), &["config", "commit.gpgsign", "false"]);
        std::fs::write(dir.path().join("file.txt"), "base\n").unwrap();
        git(dir.path(), &["add", "."]);
        git(dir.path(), &["commit", "-m", "base"]);
        git(dir.path(), &["branch", "base"]);
        std::fs::write(dir.path().join("file.txt"), "reviewed\n").unwrap();
        git(dir.path(), &["commit", "-am", "change"]);
        let path = dir.path().to_str().unwrap();
        let attempt: Attempt = serde_json::from_value(serde_json::json!({
            "id": "attempt", "flight_id": "flight", "target": {"kind": "local", "base_path": path, "worktree_path": path},
            "agent_config_id": "api-openai", "model": "builder-model", "provider": "openai", "branch": "attempt", "base_branch": "base", "session_id": "builder", "status": "reviewing", "cost": 0, "tokens": 0
        })).unwrap();
        let flight: Flight = serde_json::from_value(serde_json::json!({
            "id": "flight", "title": "review", "objective": "full objective", "prompt": "full prompt", "status": "review", "priority": "medium", "project_path": path,
            "milestones": [], "linked_session_ids": [], "created_at": 1, "updated_at": 1, "total_cost": 0, "total_tokens": 0,
            "review_gate_policy": {"enabled": true, "reviewer_agent_config_id": "api-openai", "acceptance_criteria": ["criterion"]}, "attempts": [attempt]
        })).unwrap();
        (dir, flight, attempt)
    }

    #[tokio::test]
    async fn binds_full_code_and_criteria_and_rejects_legacy_pass() {
        let (dir, mut flight, attempt) = fixture();
        let evidence = capture(&flight, &attempt, None).await.unwrap();
        validate(&flight, &attempt, Some(&evidence)).await.unwrap();
        assert!(validate(&flight, &attempt, None)
            .await
            .unwrap_err()
            .contains("fingerprint"));
        flight.objective.push_str(" changed");
        assert!(validate(&flight, &attempt, Some(&evidence)).await.is_err());
        flight.objective = "full objective".into();
        flight
            .review_gate_policy
            .as_mut()
            .unwrap()
            .acceptance_criteria
            .push("new criterion".into());
        assert!(validate(&flight, &attempt, Some(&evidence)).await.is_err());
        flight
            .review_gate_policy
            .as_mut()
            .unwrap()
            .acceptance_criteria
            .pop();
        std::fs::write(dir.path().join("file.txt"), "later code\n").unwrap();
        git(dir.path(), &["commit", "-am", "later"]);
        assert!(validate(&flight, &attempt, Some(&evidence)).await.is_err());
    }

    #[tokio::test]
    async fn rejects_dirty_staged_and_untracked_changes_including_beyond_patch_limit() {
        let (dir, flight, attempt) = fixture();
        let evidence = capture(&flight, &attempt, None).await.unwrap();
        std::fs::write(dir.path().join("untracked.txt"), "not in diff").unwrap();
        assert!(validate(&flight, &attempt, Some(&evidence))
            .await
            .unwrap_err()
            .contains("untracked"));
        git(dir.path(), &["add", "untracked.txt"]);
        assert!(capture(&flight, &attempt, None).await.is_err());
        git(dir.path(), &["reset", "--hard", "HEAD"]);
        std::fs::write(dir.path().join("file.txt"), "x".repeat(100_000)).unwrap();
        assert!(validate(&flight, &attempt, Some(&evidence)).await.is_err());
        git(dir.path(), &["commit", "-am", "large change"]);
        assert!(validate(&flight, &attempt, Some(&evidence)).await.is_err());
    }

    #[tokio::test]
    async fn pinned_base_survives_own_integration_but_branch_changes_fail() {
        let (dir, flight, attempt) = fixture();
        let evidence = capture(&flight, &attempt, None).await.unwrap();
        git(dir.path(), &["branch", "-f", "base", "HEAD"]);
        validate(&flight, &attempt, Some(&evidence)).await.unwrap();
        git(dir.path(), &["checkout", "-b", "other"]);
        assert!(validate(&flight, &attempt, Some(&evidence))
            .await
            .unwrap_err()
            .contains("branch changed"));
    }

    #[tokio::test]
    async fn evidence_packet_uses_pinned_commits_despite_transient_dirty_files() {
        let (dir, flight, attempt) = fixture();
        let evidence = capture(&flight, &attempt, None).await.unwrap();
        std::fs::write(dir.path().join("file.txt"), "transient working changes\n").unwrap();
        std::fs::write(
            dir.path().join("untracked.txt"),
            "untracked working changes\n",
        )
        .unwrap();
        let packet = super::super::git::get_git_review_evidence(
            dir.path().to_str().unwrap().into(),
            evidence.base_sha,
            None,
            Some(65_536),
            Some(evidence.head_sha.clone()),
        )
        .await
        .unwrap();
        assert_eq!(packet.head_ref, evidence.head_sha);
        assert!(packet.patch.contains("+reviewed"));
        assert!(!packet.patch.contains("transient"));
        assert_eq!(packet.changed_paths, vec!["file.txt"]);
        let live = super::super::git::get_git_review_evidence(
            dir.path().to_str().unwrap().into(),
            "base".into(),
            None,
            Some(65_536),
            None,
        )
        .await
        .unwrap();
        assert!(live.patch.contains("transient"));
        assert!(live.changed_paths.contains(&"untracked.txt".to_string()));
    }

    #[tokio::test]
    async fn default_acceptance_rejects_uncommitted_output_without_a_review_policy() {
        let (dir, mut flight, attempt) = fixture();
        flight.review_gate_policy = None;
        validate_acceptance(&flight, &attempt).await.unwrap();
        std::fs::write(dir.path().join("untracked.txt"), "builder output").unwrap();
        assert!(validate_acceptance(&flight, &attempt)
            .await
            .unwrap_err()
            .contains("uncommitted"));
        git(dir.path(), &["add", "untracked.txt"]);
        assert!(validate_acceptance(&flight, &attempt).await.is_err());
    }

    #[tokio::test]
    async fn retained_branch_delivery_checks_reviewed_commit_after_worktree_removal() {
        let (dir, flight, mut attempt) = fixture();
        let worktree = dir.path().join("review-worktree");
        let worktree_path = worktree.to_str().unwrap();
        git(
            dir.path(),
            &["worktree", "add", "-b", "delivery", worktree_path, "HEAD"],
        );
        attempt.branch = "delivery".into();
        attempt.target = AttemptTarget::Local {
            base_path: dir.path().to_str().unwrap().into(),
            worktree_path: worktree_path.into(),
        };
        let evidence = capture(&flight, &attempt, None).await.unwrap();
        attempt.review_gate = Some(
            serde_json::from_value(serde_json::json!({"status": "passed", "evidence": evidence}))
                .unwrap(),
        );
        git(dir.path(), &["worktree", "remove", worktree_path]);
        validate_delivery(&flight, &attempt).await.unwrap();
        std::fs::write(dir.path().join("file.txt"), "unreviewed commit\n").unwrap();
        git(dir.path(), &["commit", "-am", "changed after acceptance"]);
        git(dir.path(), &["branch", "-f", "delivery", "HEAD"]);
        assert!(validate_delivery(&flight, &attempt)
            .await
            .unwrap_err()
            .contains("changed after review"));
    }

    #[tokio::test]
    async fn reviewed_push_delivers_captured_commit_when_branch_advances_after_validation() {
        let (dir, flight, mut attempt) = fixture();
        let remote = tempfile::tempdir().unwrap();
        git(remote.path(), &["init", "--bare"]);
        git(
            dir.path(),
            &["remote", "add", "origin", remote.path().to_str().unwrap()],
        );
        let evidence = capture(&flight, &attempt, None).await.unwrap();
        attempt.review_gate = Some(
            serde_json::from_value(serde_json::json!({"status": "passed", "evidence": evidence}))
                .unwrap(),
        );
        let reviewed = reviewed_delivery_head(&flight, &attempt).await.unwrap();
        std::fs::write(dir.path().join("file.txt"), "later unreviewed commit\n").unwrap();
        git(dir.path(), &["commit", "-am", "later"]);
        let advanced = git(dir.path(), &["rev-parse", "HEAD"]);
        push_commit(&attempt, &reviewed).await.unwrap();
        assert_eq!(
            git(remote.path(), &["rev-parse", "refs/heads/attempt"]),
            reviewed
        );
        assert_ne!(advanced, reviewed);
    }

    #[tokio::test]
    async fn cooperative_integration_merges_validated_commit_when_attempt_branch_advances() {
        let (dir, mut flight, mut attempt) = fixture();
        let integration_dir = tempfile::tempdir().unwrap();
        let integration_path = integration_dir.path().to_str().unwrap();
        git(
            dir.path(),
            &[
                "worktree",
                "add",
                "-b",
                "integration",
                integration_path,
                "base",
            ],
        );
        let evidence = capture(&flight, &attempt, None).await.unwrap();
        attempt.review_gate = Some(
            serde_json::from_value(serde_json::json!({"status": "passed", "evidence": evidence}))
                .unwrap(),
        );
        flight.attempts = vec![attempt];
        flight.integration_branch = Some(serde_json::from_value(serde_json::json!({"branch": "integration", "base_branch": "base", "base_sha": "base", "head_sha": "base", "worktree_path": integration_path, "target_kind": "local", "status": "ready"})).unwrap());
        let state_dir = tempfile::tempdir().unwrap();
        let _guard = storage::redirect_data_dir_for_test(state_dir.path());
        storage::save_flights(vec![flight]).await.unwrap();
        let reviewed =
            validate_integration(integration_path, dir.path().to_str().unwrap(), "attempt")
                .await
                .unwrap();
        std::fs::write(dir.path().join("file.txt"), "later unreviewed commit\n").unwrap();
        git(dir.path(), &["commit", "-am", "later"]);
        worktree::integrate_local_attempt(
            integration_path,
            "integration",
            dir.path().to_str().unwrap(),
            &reviewed,
        )
        .unwrap();
        assert_eq!(
            git(integration_dir.path(), &["show", "HEAD:file.txt"]),
            "reviewed"
        );
    }

    #[tokio::test]
    async fn only_reasoned_explicit_override_can_bypass_snapshot() {
        let (_dir, flight, mut attempt) = fixture();
        let mut gate: crate::core::flight::AttemptReviewGate = serde_json::from_value(serde_json::json!({"status": "overridden", "overridden_at": 1, "override_reason": "Manually reviewed"})).unwrap();
        attempt.review_gate = Some(gate.clone());
        validate_acceptance(&flight, &attempt).await.unwrap();
        gate.override_reason = Some(" ".into());
        attempt.review_gate = Some(gate);
        assert!(validate_acceptance(&flight, &attempt).await.is_err());
    }

    #[tokio::test]
    async fn passed_verdict_is_checked_at_write_and_stale_acceptance_becomes_retryable() {
        let (dir, mut flight, mut attempt) = fixture();
        let state_dir = tempfile::tempdir().unwrap();
        let _guard = storage::redirect_data_dir_for_test(state_dir.path());
        let evidence = capture(&flight, &attempt, None).await.unwrap();
        let mut gate: crate::core::flight::AttemptReviewGate = serde_json::from_value(serde_json::json!({
            "status": "running", "reviewer_conversation_id": "review", "reviewer_agent_config_id": "api-openai-agents", "reviewer_model": "review-model", "evidence": evidence
        })).unwrap();
        attempt.review_gate = Some(gate.clone());
        flight.attempts = vec![attempt];
        storage::save_flights(vec![flight]).await.unwrap();
        gate.status = ReviewGateStatus::Passed;
        super::super::flight_attempts::set_attempt_review_gate(
            "flight".into(),
            "attempt".into(),
            Some(gate.clone().into()),
        )
        .await
        .unwrap();
        validate_attempt_review_gate("flight".into(), "attempt".into())
            .await
            .unwrap();
        std::fs::write(dir.path().join("untracked.txt"), "unreviewed").unwrap();
        assert!(
            validate_attempt_review_gate("flight".into(), "attempt".into())
                .await
                .is_err()
        );
        let snapshot = storage::load_state();
        assert_eq!(
            snapshot.flights[0].attempts[0]
                .review_gate
                .as_ref()
                .unwrap()
                .status,
            ReviewGateStatus::Error
        );
        assert!(super::super::flight_attempts::set_attempt_review_gate(
            "flight".into(),
            "attempt".into(),
            Some(gate.into())
        )
        .await
        .is_err());
        super::super::flight_attempts::set_attempt_review_gate(
            "flight".into(),
            "attempt".into(),
            None,
        )
        .await
        .unwrap();
        let snapshot = storage::load_state();
        let owner =
            super::super::flight_cost::flight_for_executor_session(&snapshot, "review").unwrap();
        assert_eq!(
            (owner.provider.as_str(), owner.model.as_str()),
            ("openai-agents", "review-model")
        );
        assert_eq!(
            snapshot.flights[0].attempts[0]
                .review_gate
                .as_ref()
                .unwrap()
                .status,
            ReviewGateStatus::Pending
        );
        super::super::flight_cost::accumulate_executor_cost(&owner.flight_id, 42, 0.125)
            .await
            .unwrap();
        let after = storage::load_state();
        assert_eq!(after.flights[0].total_tokens, 42);
        assert_eq!(after.flights[0].total_cost, 0.125);
    }
}
