//! Flight cost — executor cost / token accumulation onto the Flight DTO.
//!
//! This is the **executor money path** — the sacred rollup that must stay
//! bit-identical across the planner-amputation refactor. It was carved out
//! of `flight_planner_costs.rs` (C1-S2) so the live cost surface has a home
//! that doesn't depend on the (dying) planner module. This sub-module owns:
//!
//!   * [`accumulate_executor_cost`] — roll up an executor-owned turn's
//!     `total_tokens` and USD cost onto a Flight's `total_tokens` /
//!     `total_cost` fields.
//!   * [`ExecutorSessionOwner`] / [`flight_for_executor_session`] —
//!     reverse-lookup so the sidecar event handler / api-agent can find the
//!     owning flight from a session id (across both attempt and
//!     milestone-task linkage sites).
//!
//! `accumulate_executor_cost` serializes through `storage::with_state_lock`
//! so parallel `turn_summary` events from a bursty sidecar can't race each
//! other or `persist_planner_state_on_flight`.
//!
//! Deps: `core::storage` + `tracing` only (plus a private `now_millis`).

use tracing::warn;

use crate::core::storage::{self, PersistedState};

/// Milliseconds since the Unix epoch. Private copy so this module carries no
/// dependency on the (dying) `flight_planner` module.
fn now_millis() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or_default()
}

// ---------------------------------------------------------------------------
// E8 — executor cost / token accumulation
// ---------------------------------------------------------------------------

/// Accumulate one executor-session turn's token and cost numbers onto the
/// Flight DTO's `total_tokens` / `total_cost` fields.
///
/// Sibling of `accumulate_planner_cost`: where the planner helper rolls
/// up planner-owned turns onto the dedicated `planner_*` chip fields, this
/// helper rolls up executor-owned turns (the agents the planner spawns
/// through the async-attempts path, or any standalone API-agent session
/// linked to a flight via `attempts.session_id` /
/// `milestones[].tasks[].session_id`) onto the flight-total fields.
///
/// The StatGrid chip in the frontend derives the "Executor" cost as
/// `totalCost - plannerCost` — that subtraction is only correct once
/// executor turn_summaries actually flow into `total_cost`. Pre-E8 this
/// helper didn't exist and executor cost was dropped on the floor; the
/// chip therefore always showed `Exec = totalCost - plannerCost = 0`.
///
/// Semantics:
///   * `total_tokens` accumulates the caller-provided `total_tokens` sum
///     (typically `input + output + cache-read + cache-create`).
///   * `total_cost` accumulates `cost_usd` directly.
///   * Returns `Err` (and logs a warning) when the flight id is unknown,
///     mirroring the planner helper's contract — losing executor cost
///     silently would skew the chip just as badly as losing planner cost.
///
/// Serialized through `storage::with_state_lock` for the same reason as
/// the planner helper: parallel executor turn_summary streams must not
/// race against each other or against `persist_planner_state_on_flight`.
pub async fn accumulate_executor_cost(
    flight_id: &str,
    total_tokens: u64,
    cost_usd: f64,
) -> Result<(), String> {
    let flight_id_owned = flight_id.to_string();
    let result = storage::with_state_lock(move |state| {
        let flight_id = flight_id_owned.clone();
        let inner: Result<(), String> = (|| {
            let Some(flight) = state.flights.iter_mut().find(|f| f.id == flight_id) else {
                return Err(format!("flight not found: {}", flight_id));
            };
            flight.total_tokens = flight.total_tokens.saturating_add(total_tokens);
            flight.total_cost += cost_usd;
            flight.updated_at = now_millis();
            Ok(())
        })();
        std::future::ready(inner)
    })
    .await;
    if let Err(ref e) = result {
        warn!(error = %e, flight_id, "failed to accumulate executor cost on flight");
    }
    result
}

/// Reverse-lookup return value for [`flight_for_executor_session`]: the
/// owning flight id plus the model recorded on the attempt/task (used by
/// the caller to price the turn through `pricing::calculate_cost`).
#[derive(Debug, Clone)]
pub struct ExecutorSessionOwner {
    pub flight_id: String,
    pub model: String,
    /// Provider discriminator (e.g. "openai-codex", "claude-oauth"): read
    /// directly off the attempt for the attempt linkage, and derived from the
    /// task's `agent_config_id` with the `api-` prefix stripped for the
    /// milestone-task linkage.
    ///
    /// Its ONLY consumer is the sidecar `turn_summary` handler, which asks
    /// whether this is `openai-codex` to decide if the event's totals are
    /// per-turn deltas or session-cumulative snapshots. It is deliberately
    /// NOT a routable `get_provider` id — the prefix-strip below yields
    /// "claude" for `api-claude` — so never feed it to `get_provider` or
    /// `load_api_key`. (The frontend's attempt specs resolve their provider
    /// through `attemptProviderFor`; this field is cost bookkeeping only.)
    pub provider: String,
}

/// Reverse-lookup: find the Flight that owns the executor session whose
/// API-agent session id is `session_id`. Returns the owning flight's id
/// plus the model recorded next to the session on the attempt / task, or
/// `None` if no flight references the session.
///
/// Searches both linkage sites:
///   * `flight.attempts[].session_id` — the async-attempts path
///     (`asyncFlightStore.launchAsync` / the planner's `create_task`)
///   * `flight.milestones[].tasks[].session_id` — the multi-task path
///     (planner tasks running through `core::orchestrator`)
///
/// The attempt linkage carries `model` directly on `Attempt`. The task
/// linkage returns `Task::model` when set, falling back to the empty
/// string when it is `None` — `pricing::calculate_cost` treats an unknown
/// model as zero-priced (returns `0.0`), which means such a task will
/// still roll up tokens onto `total_tokens` but its cost lands on
/// `total_cost` only when the model is resolvable.
///
/// Cheap: O(flights × (attempts + milestones × tasks_per_milestone)).
/// State sizes are small enough in practice that linear scan beats
/// maintaining a separate session→flight index.
pub fn flight_for_executor_session(
    state: &PersistedState,
    session_id: &str,
) -> Option<ExecutorSessionOwner> {
    for f in state.flights.iter() {
        if let Some(a) = f.attempts.iter().find(|a| a.session_id == session_id) {
            return Some(ExecutorSessionOwner {
                flight_id: f.id.clone(),
                model: a.model.clone(),
                provider: a.provider.clone(),
            });
        }
        if let Some(owner) = f
            .attempts
            .iter()
            .flat_map(|attempt| attempt.session_history.iter().flatten())
            .find(|owner| owner.session_id == session_id)
        {
            return Some(ExecutorSessionOwner {
                flight_id: f.id.clone(),
                model: owner.model.clone(),
                provider: owner.provider.clone(),
            });
        }
        for gate in f
            .attempts
            .iter()
            .filter_map(|attempt| attempt.review_gate.as_ref())
        {
            if let Some(session) = gate
                .reviewer_sessions
                .iter()
                .find(|session| session.session_id == session_id)
            {
                return Some(ExecutorSessionOwner {
                    flight_id: f.id.clone(),
                    model: session.model.clone(),
                    provider: session.provider.clone(),
                });
            }
            // Older runs have no session ledger, but their active reviewer is
            // still attributable without guessing the builder's model/provider.
            if gate.reviewer_conversation_id.as_deref() == Some(session_id) {
                let agent = gate.reviewer_agent_config_id.as_deref().unwrap_or_default();
                let provider = if agent == "api-claude" {
                    "anthropic"
                } else {
                    agent.trim_start_matches("api-")
                };
                return Some(ExecutorSessionOwner {
                    flight_id: f.id.clone(),
                    model: gate.reviewer_model.clone().unwrap_or_default(),
                    provider: provider.to_string(),
                });
            }
        }
        if let Some(t) = f
            .milestones
            .iter()
            .flat_map(|m| m.tasks.iter())
            .find(|t| t.session_id.as_deref() == Some(session_id))
        {
            return Some(ExecutorSessionOwner {
                flight_id: f.id.clone(),
                model: t.model.clone().unwrap_or_default(),
                // Tasks carry no provider field, so derive the codex
                // discriminator from the agent id. Without this, a
                // codex-backed task session would take the per-turn branch
                // in the sidecar turn_summary handler and re-add its
                // session-cumulative totals on every update. See the field
                // docs: this is a discriminator, not a routable provider id.
                provider: t.agent_config_id.trim_start_matches("api-").to_string(),
            });
        }
    }
    None
}

/// E8-ACCUM — executor-cost round-trips through the on-disk PersistedState.
/// Gated `#[ignore]` because each test rewrites the real `~/.packetbench`
/// state file via `storage::with_state_lock` — the suite can't redirect
/// HOME hermetically, mirroring the
/// `flight_journal::tests::append_journal_creates_file_and_appends`
/// pattern. This is the manual real-state harness; the hermetic
/// tempdir-redirected coverage lives in `hermetic_money_path` below and
/// runs in the default `cargo test` pass. Run manually with:
///
///   `cargo test --lib --manifest-path src-tauri/Cargo.toml \
///       commands::flight_cost::e8_accum -- --ignored --test-threads=1`
///
/// `--test-threads=1` is important because every test in this module
/// mutates the same persisted-state file; concurrent workers would race
/// on each other's seed/teardown.
#[cfg(test)]
mod e8_accum {
    use super::*;
    use crate::core::flight::{Flight, FlightPriority, FlightStatus};

    /// Cleanup helper: remove the seeded test flight so we don't pollute the
    /// user's persisted state with leftover `e8-*` rows.
    async fn unseed_flight(flight_id: &str) {
        let mid = flight_id.to_string();
        let _: Result<(), String> = storage::with_state_lock(move |state| {
            state.flights.retain(|f| f.id != mid);
            std::future::ready(Ok(()))
        })
        .await;
    }

    /// Read back the on-disk Flight for assertions.
    async fn read_flight(flight_id: &str) -> Option<Flight> {
        let state = storage::load_state();
        state.flights.into_iter().find(|f| f.id == flight_id)
    }

    /// Seed a Flight with concrete `total_cost` / `total_tokens` so the
    /// executor add-onto-existing case has something to grow from.
    async fn seed_flight_with_total(
        flight_id: &str,
        total_cost_seed: f64,
        total_tokens_seed: u64,
    ) -> Result<(), String> {
        let mid = flight_id.to_string();
        storage::with_state_lock(move |state| {
            state.flights.retain(|f| f.id != mid);
            state.flights.push(Flight {
                id: mid.clone(),
                title: format!("E8 exec seed {}", mid),
                objective: String::new(),
                status: FlightStatus::Active,
                priority: FlightPriority::Medium,
                project_path: "/tmp/e8-accum-exec".to_string(),
                workspace_id: None,
                git_branch: None,
                milestones: Vec::new(),
                linked_session_ids: Vec::new(),
                created_at: 0,
                updated_at: 0,
                completed_at: None,
                total_cost: total_cost_seed,
                total_tokens: total_tokens_seed,
                prompt: None,
                attempts: Vec::new(),
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
            });
            std::future::ready(Ok(()))
        })
        .await
    }

    /// Headline additive case for executor cost — seed
    /// `total_cost = 1.5` / `total_tokens = 100`, accumulate
    /// `(300, 0.5)`, expect `total_cost = 2.0` / `total_tokens = 400`.
    #[tokio::test]
    #[ignore = "touches real ~/.packetbench state file; run with --ignored --test-threads=1"]
    async fn accumulate_executor_cost_adds_to_existing() {
        let mid = format!(
            "e8-accum-exec-add-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        );
        seed_flight_with_total(&mid, 1.5, 100).await.unwrap();

        super::accumulate_executor_cost(&mid, 300, 0.5)
            .await
            .expect("accumulate must succeed for a seeded flight");

        let after = read_flight(&mid).await.expect("flight present after add");
        assert!(
            (after.total_cost - 2.0).abs() < f64::EPSILON,
            "total_cost should be 2.0, got {}",
            after.total_cost
        );
        assert_eq!(after.total_tokens, 400);

        unseed_flight(&mid).await;
    }

    /// Missing-flight case — calling against a flight id that doesn't
    /// exist on disk MUST surface an `Err` so the api_agent / sidecar
    /// caller can log the warning. Same contract as the planner helper.
    #[tokio::test]
    #[ignore = "touches real ~/.packetbench state file; run with --ignored --test-threads=1"]
    async fn accumulate_executor_cost_errors_on_missing_flight() {
        let mid = format!(
            "e8-accum-exec-missing-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        );
        unseed_flight(&mid).await;

        let result = super::accumulate_executor_cost(&mid, 30, 0.1).await;
        assert!(result.is_err(), "missing flight must return Err");
        let err = result.unwrap_err();
        assert!(
            err.contains(&mid),
            "error message should name the missing flight: {}",
            err
        );
    }
}

// ---------------------------------------------------------------------------
// C1-S1 — HERMETIC money-path guards.
//
// The `e8_accum` module above is `#[ignore]`d because it rewrites the real
// `~/.packetbench` state file. This module gives the SAME live cost path
// CI-run coverage instead: the pure reverse-lookup
// (`flight_for_executor_session`) needs no storage at all, and the persisting
// helper (`accumulate_executor_cost`) is exercised end-to-end against a
// per-thread tempdir via `storage::redirect_data_dir_for_test`, so every test
// here runs in the default `cargo test` pass with no `#[ignore]` and no risk
// to real user state. This is the executor money path the CLEAN passes must
// keep bit-identical.
// ---------------------------------------------------------------------------
#[cfg(test)]
mod hermetic_money_path {
    use super::*;
    use crate::core::flight::{
        Attempt, AttemptStatus, AttemptTarget, Flight, FlightPriority, FlightStatus, Milestone,
        MilestoneStatus, Task, TaskStatus, TaskType,
    };
    use std::path::PathBuf;
    use std::time::{SystemTime, UNIX_EPOCH};

    // --- fixture builders ---------------------------------------------------

    fn base_flight(id: &str) -> Flight {
        Flight {
            id: id.to_string(),
            title: format!("hermetic {}", id),
            objective: String::new(),
            status: FlightStatus::Active,
            priority: FlightPriority::Medium,
            project_path: "/tmp/hermetic".to_string(),
            workspace_id: None,
            git_branch: None,
            milestones: Vec::new(),
            linked_session_ids: Vec::new(),
            created_at: 0,
            updated_at: 0,
            completed_at: None,
            total_cost: 0.0,
            total_tokens: 0,
            prompt: None,
            attempts: Vec::new(),
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

    fn attempt_with(session_id: &str, model: &str) -> Attempt {
        Attempt {
            id: format!("att-{}", session_id),
            flight_id: String::new(),
            target: AttemptTarget::Local {
                base_path: "/tmp/hermetic".to_string(),
                worktree_path: "/tmp/hermetic/wt".to_string(),
            },
            agent_config_id: "claude-code".to_string(),
            model: model.to_string(),
            provider: "api-claude".to_string(),
            branch: "wt".to_string(),
            base_branch: "main".to_string(),
            session_id: session_id.to_string(),
            status: AttemptStatus::Running,
            started_at: None,
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

    fn task_with_session(session_id: &str) -> Task {
        Task {
            id: format!("task-{}", session_id),
            milestone_id: "ms-1".to_string(),
            flight_id: String::new(),
            title: "t".to_string(),
            description: String::new(),
            order: 0,
            status: TaskStatus::Running,
            task_type: TaskType::Implementation,
            agent_config_id: "claude-code".to_string(),
            agent_args: None,
            model: None,
            depends_on: Vec::new(),
            session_id: Some(session_id.to_string()),
            result: None,
            review_packet: None,
            created_at: 0,
            started_at: None,
            completed_at: None,
            cost: 0.0,
            tokens: 0,
            owned_paths: Vec::new(),
            replan_count: 0,
        }
    }

    fn milestone_with(tasks: Vec<Task>) -> Milestone {
        Milestone {
            id: "ms-1".to_string(),
            flight_id: String::new(),
            title: "m".to_string(),
            description: String::new(),
            order: 0,
            status: MilestoneStatus::Active,
            tasks,
            validation_criteria: Vec::new(),
        }
    }

    fn state_with(flights: Vec<Flight>) -> PersistedState {
        let mut state = PersistedState::default();
        state.flights = flights;
        state
    }

    fn unique_temp_dir(tag: &str) -> PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let dir = std::env::temp_dir().join(format!("packetbench-c1s1-{}-{}", tag, nanos));
        std::fs::create_dir_all(&dir).expect("create unique temp dir");
        dir
    }

    // --- flight_for_executor_session (pure logic) ---------------------------

    /// Attempt linkage: a session id recorded on `flight.attempts[].session_id`
    /// resolves to that flight and returns the attempt's model verbatim (the
    /// value the caller prices the turn with).
    #[test]
    fn executor_lookup_attempt_linkage_returns_attempt_model() {
        let mut f = base_flight("flight-a");
        f.attempts = vec![attempt_with("exec-sess-1", "claude-sonnet-4-6")];
        let state = state_with(vec![f]);

        let owner = flight_for_executor_session(&state, "exec-sess-1")
            .expect("attempt-linked session must resolve");
        assert_eq!(owner.flight_id, "flight-a");
        assert_eq!(owner.model, "claude-sonnet-4-6");
    }

    #[test]
    fn reviewer_lookup_keeps_old_sessions_and_actual_model_after_retry() {
        let mut flight = base_flight("review-flight");
        let mut attempt = attempt_with("builder", "builder-model");
        attempt.review_gate = Some(
            serde_json::from_value(serde_json::json!({
                "status": "running", "reviewer_conversation_id": "new-review",
                "reviewer_agent_config_id": "api-openai-agents", "reviewer_model": "new-model",
                "reviewer_sessions": [
                    {"session_id": "old-review", "provider": "claude-oauth", "model": "old-model"},
                    {"session_id": "new-review", "provider": "openai-agents", "model": "new-model"}
                ]
            }))
            .unwrap(),
        );
        flight.attempts.push(attempt);
        let state = state_with(vec![flight]);
        let old = flight_for_executor_session(&state, "old-review").unwrap();
        assert_eq!(
            (
                old.flight_id.as_str(),
                old.provider.as_str(),
                old.model.as_str()
            ),
            ("review-flight", "claude-oauth", "old-model")
        );
        let new = flight_for_executor_session(&state, "new-review").unwrap();
        assert_eq!(
            (new.provider.as_str(), new.model.as_str()),
            ("openai-agents", "new-model")
        );
        assert_eq!(
            flight_for_executor_session(&state, "builder")
                .unwrap()
                .model,
            "builder-model"
        );
        assert!(flight_for_executor_session(&state, "unrelated").is_none());
    }

    #[test]
    fn legacy_reviewer_lookup_never_uses_builder_pricing() {
        let mut flight = base_flight("legacy-review");
        let mut attempt = attempt_with("builder", "builder-model");
        attempt.review_gate = Some(serde_json::from_value(serde_json::json!({
            "status": "error", "reviewer_conversation_id": "review", "reviewer_agent_config_id": "api-claude", "reviewer_model": "review-model"
        })).unwrap());
        flight.attempts.push(attempt);
        let owner = flight_for_executor_session(&state_with(vec![flight]), "review").unwrap();
        assert_eq!(
            (owner.provider.as_str(), owner.model.as_str()),
            ("anthropic", "review-model")
        );
    }

    /// Legacy milestone-task linkage: a session id living on
    /// `flight.milestones[].tasks[].session_id` resolves to the owning
    /// flight; the provider derives from the task's `agent_config_id`, and
    /// a `model: None` task yields an empty model (priced as zero
    /// downstream).
    #[test]
    fn executor_lookup_milestone_task_linkage_returns_empty_model() {
        let mut f = base_flight("flight-b");
        f.milestones = vec![milestone_with(vec![task_with_session("exec-sess-2")])];
        let state = state_with(vec![f]);

        let owner = flight_for_executor_session(&state, "exec-sess-2")
            .expect("task-linked session must resolve");
        assert_eq!(owner.flight_id, "flight-b");
        assert_eq!(owner.model, "", "model: None task yields empty model");
        assert_eq!(
            owner.provider, "claude-code",
            "provider derives from the task's agent_config_id"
        );
    }

    /// Milestone-task linkage with an `api-*` agent: the `api-` prefix is
    /// stripped (mirroring asyncFlightStore) and `Task::model` is returned,
    /// so a codex-backed task session takes the cumulative-snapshot branch
    /// in the sidecar turn_summary handler instead of the per-turn branch.
    #[test]
    fn executor_lookup_milestone_task_linkage_strips_api_prefix_and_returns_model() {
        let mut task = task_with_session("exec-sess-2b");
        task.agent_config_id = "api-openai-codex".to_string();
        task.model = Some("gpt-5.2-codex".to_string());
        let mut f = base_flight("flight-b2");
        f.milestones = vec![milestone_with(vec![task])];
        let state = state_with(vec![f]);

        let owner = flight_for_executor_session(&state, "exec-sess-2b")
            .expect("task-linked session must resolve");
        assert_eq!(owner.flight_id, "flight-b2");
        assert_eq!(owner.provider, "openai-codex");
        assert_eq!(owner.model, "gpt-5.2-codex");
    }

    /// Miss: a session id referenced by nobody resolves to `None`.
    #[test]
    fn executor_lookup_miss_returns_none() {
        let mut f = base_flight("flight-c");
        f.attempts = vec![attempt_with("some-other-sess", "m")];
        f.milestones = vec![milestone_with(vec![task_with_session("yet-another")])];
        let state = state_with(vec![f]);

        assert!(flight_for_executor_session(&state, "nobody-owns-this").is_none());
    }

    /// (b) Handler-fallthrough pin: a session id that belongs to NO planner
    /// registry — a plain executor attempt session — still resolves through
    /// `flight_for_executor_session`. This is exactly the fallthrough the
    /// sidecar/api-agent handlers take when the registry lookup misses, and
    /// the CLEAN passes must preserve it. Scanning multiple flights confirms
    /// the lookup targets the right owner, not merely the first flight.
    #[test]
    fn executor_lookup_fallthrough_resolves_non_planner_session() {
        let f1 = base_flight("flight-1");
        let mut f2 = base_flight("flight-2");
        f2.attempts = vec![attempt_with("registry-miss-sess", "claude-opus-4-6")];
        let state = state_with(vec![f1, f2]);

        let owner = flight_for_executor_session(&state, "registry-miss-sess")
            .expect("non-planner executor session must resolve via fallthrough");
        assert_eq!(owner.flight_id, "flight-2");
        assert_eq!(owner.model, "claude-opus-4-6");
    }

    // --- accumulate_executor_cost (persists, via redirected storage) --------

    /// Headline additive case, exercised end-to-end through the REAL storage
    /// writer against a tempdir: seed `total_cost = 1.5` / `total_tokens = 100`,
    /// accumulate `(300, 0.5)`, reload from disk, expect `2.0` / `400`.
    #[tokio::test]
    async fn accumulate_executor_cost_adds_and_persists() {
        let dir = unique_temp_dir("exec-add");
        let _guard = storage::redirect_data_dir_for_test(dir.clone());

        let mut f = base_flight("flight-exec");
        f.total_cost = 1.5;
        f.total_tokens = 100;
        storage::save_flights(vec![f])
            .await
            .expect("seed flight to tempdir");

        accumulate_executor_cost("flight-exec", 300, 0.5)
            .await
            .expect("accumulate must succeed for a seeded flight");

        let after = storage::load_state()
            .flights
            .into_iter()
            .find(|f| f.id == "flight-exec")
            .expect("flight present after add");
        assert!(
            (after.total_cost - 2.0).abs() < f64::EPSILON,
            "total_cost should be 2.0, got {}",
            after.total_cost
        );
        assert_eq!(after.total_tokens, 400);

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// First-cost case: a freshly-seeded flight at `total_cost = 0.0` /
    /// `total_tokens = 0` takes the first executor turn and persists it.
    #[tokio::test]
    async fn accumulate_executor_cost_first_cost_persists() {
        let dir = unique_temp_dir("exec-first");
        let _guard = storage::redirect_data_dir_for_test(dir.clone());

        storage::save_flights(vec![base_flight("flight-first")])
            .await
            .expect("seed flight to tempdir");

        accumulate_executor_cost("flight-first", 300, 0.5)
            .await
            .expect("accumulate must succeed for a seeded flight");

        let after = storage::load_state()
            .flights
            .into_iter()
            .find(|f| f.id == "flight-first")
            .expect("flight present after first cost");
        assert!(
            (after.total_cost - 0.5).abs() < f64::EPSILON,
            "total_cost should be 0.5, got {}",
            after.total_cost
        );
        assert_eq!(after.total_tokens, 300);

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Missing-flight case: accumulating against an id absent from the
    /// (empty) redirected store surfaces `Err` naming the id — losing
    /// executor counts silently would skew the StatGrid chip.
    #[tokio::test]
    async fn accumulate_executor_cost_errors_on_missing_flight() {
        let dir = unique_temp_dir("exec-missing");
        let _guard = storage::redirect_data_dir_for_test(dir.clone());

        let result = accumulate_executor_cost("no-such-flight", 30, 0.1).await;
        assert!(result.is_err(), "missing flight must return Err");
        let err = result.unwrap_err();
        assert!(
            err.contains("no-such-flight"),
            "error message should name the missing flight: {}",
            err
        );

        let _ = std::fs::remove_dir_all(&dir);
    }
}
