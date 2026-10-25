//! R8 (H1): offline-by-default same-executor evaluation lane.
//!
//! Fixture cases drive the *production* [`run_turn`] loop through the
//! deterministic [`FakeServices`] double — the same [`RuntimeServices`] seam the
//! Tauri adapter implements — so an evaluation exercises the real runner rather
//! than a second request/tool loop. Every seam is owned by the fakes: no
//! provider, keyring, ambient MCP server or real project is reachable from this
//! module. Live evaluation is deliberately not implemented (the `runtime-eval`
//! binary refuses `--live`).
//!
//! The module compiles only under `cfg(test)` or the opt-in `runtime-eval`
//! feature (see `lib.rs`). Types are versioned JSON with a `v` field, so the
//! fixtures are reviewable files and the results are a stable artifact.
//!
//! `repositoryFixture` and `startingCommit` are the spec's repo-fixture and
//! starting-commit identity fields. Offline v1 cases leave both `null`; a live
//! fixture (deferred) populates them. The declared `harnessConfigDigest` is
//! load-bearing: [`load_cases`] recomputes it from the case's execution binding,
//! script and budget and rejects a mismatch, so a fixture cannot drift from the
//! configuration it claims to pin.
//!
//! Full JSON-Schema validation of fixtures is out of scope; the schemas are
//! reviewable documents and `schemas_and_fixtures_are_consistent` is the
//! load-bearing structural check (schema `$id`/`const`/`additionalProperties`,
//! plus every fixture parsing and carrying every key the schema requires).
//!
//! [`redact`] is an explicit no-op for the current field set: [`RunResult`]
//! records event kinds, counts, spend micros and a bounded failure diagnostic —
//! never raw reasoning, tool payloads, credentials or account ids. A test
//! serializes a result and asserts a fixture's raw text and the fake API key are
//! absent, so the guard fails if a raw-payload field is ever added.
//!
//! Deferred to a later packet (out of scope for v1): the 20–30 held-out live
//! tasks with repetitions, disposable-container executor isolation, and the
//! checkpoint-layer cases (duplicate/out-of-order tool ids, newer-schema
//! quarantine) that belong to the journal lane rather than this runner lane.
//! Those require a live lane with an explicit provider/account/target selection
//! and a spend policy, which this v1 deliberately does not provide.

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use tokio::sync::oneshot;

use crate::core::agent_runtime::runner::run_turn;
use crate::core::agent_runtime::testing::{FakeServices, FaultCheckpointStore, ScriptStep};
use crate::core::agent_runtime::{
    BudgetAdmission, CheckpointBoundary, PermissionDecision, PermissionMode, RunOutcome, RunRequest,
};
use crate::core::llm_types::{ImageAttachment, StreamChunk};

/// Wire version of [`EvaluationCase`].
pub const EVALUATION_CASE_VERSION: i64 = 1;
/// Wire version of [`RunResult`].
pub const RUN_RESULT_VERSION: i64 = 1;

/// How long a `cancelled` case waits before firing the stop signal. The
/// scripted provider parks forever on a `chunksThenBlock` step, so the outcome
/// is `Cancelled` whether the signal lands mid-stream or before the first
/// request; the delay only makes the mid-stream path the common one.
const CANCEL_AFTER: Duration = Duration::from_millis(25);

/// Named evaluation failure. Callers branch on the variant rather than parse a
/// string.
#[derive(Debug)]
pub enum EvalError {
    Io(String),
    Parse {
        path: String,
        message: String,
    },
    UnsupportedVersion {
        case_id: String,
        found: i64,
        supported: i64,
    },
    DuplicateCaseId(String),
    HarnessDigestMismatch {
        case_id: String,
        declared: String,
        expected: String,
    },
    Script(String),
    Lane(String),
    Other(String),
}

impl std::fmt::Display for EvalError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            EvalError::Io(message) => write!(f, "evaluation case I/O error: {message}"),
            EvalError::Parse { path, message } => {
                write!(f, "failed to parse evaluation case {path}: {message}")
            }
            EvalError::UnsupportedVersion {
                case_id,
                found,
                supported,
            } => write!(
                f,
                "evaluation case {case_id} is v{found}; this build supports v{supported}"
            ),
            EvalError::DuplicateCaseId(case_id) => {
                write!(f, "duplicate evaluation case id: {case_id}")
            }
            EvalError::HarnessDigestMismatch {
                case_id,
                declared,
                expected,
            } => write!(
                f,
                "evaluation case {case_id} declares harnessConfigDigest {declared} but its \
                 execution binding, script and budget hash to {expected}"
            ),
            EvalError::Script(message) => write!(f, "invalid scripted step: {message}"),
            EvalError::Lane(message) => write!(f, "invalid lane configuration: {message}"),
            EvalError::Other(message) => write!(f, "{message}"),
        }
    }
}

impl std::error::Error for EvalError {}

impl From<String> for EvalError {
    fn from(message: String) -> Self {
        EvalError::Other(message)
    }
}

/// Where a case executes. In the offline lane the provider/model only select
/// the session route the fake is told about; no provider is constructed.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExecutionBinding {
    pub provider: String,
    pub model: String,
    /// `native` or `sdk`. Recorded for provenance; the deterministic lane is
    /// provider-transport agnostic.
    pub transport: String,
}

/// The per-case spend ceiling. `None` means no budget is configured, which is
/// the disabled admission path.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CaseBudget {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub limit_usd_micros: Option<i64>,
}

/// What the harness expects to observe. These are harness assertions, never a
/// model-authored claim.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ExpectedOutcome {
    Completed,
    Failed,
    Cancelled,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OutcomeCriteria {
    pub expect: ExpectedOutcome,
    /// When set, the number of settled reservations the harness must observe.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expect_settles: Option<u32>,
    /// When true, the turn must fail with a `blocked_context` error.
    #[serde(default)]
    pub expect_context_block: bool,
    /// When set, this tool name must appear in the tools the turn executed.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expect_tool_executed: Option<String>,
    /// When set, this tool name must NOT appear in the tools the turn executed.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expect_tool_denied: Option<String>,
    /// When set, the runner's error must contain this substring.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expect_error_contains: Option<String>,
}

/// A JSON-friendly mirror of [`ScriptStep`]. Chunks are stored as raw JSON and
/// decoded into [`StreamChunk`] at load time, so the exact chunk shape lives in
/// the fixtures and is validated by the same serde contract the provider uses.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum ScriptStepJson {
    Chunks { chunks: Vec<Value> },
    ChunksThenBlock { chunks: Vec<Value> },
    Fail { message: String },
}

impl ScriptStepJson {
    pub fn to_script_step(&self) -> Result<ScriptStep, EvalError> {
        match self {
            ScriptStepJson::Chunks { chunks } => Ok(ScriptStep::Chunks(decode_chunks(chunks)?)),
            ScriptStepJson::ChunksThenBlock { chunks } => {
                Ok(ScriptStep::ChunksThenBlock(decode_chunks(chunks)?))
            }
            ScriptStepJson::Fail { message } => Ok(ScriptStep::Fail(message.clone())),
        }
    }
}

fn decode_chunks(chunks: &[Value]) -> Result<Vec<StreamChunk>, EvalError> {
    chunks
        .iter()
        .map(|chunk| {
            serde_json::from_value::<StreamChunk>(chunk.clone())
                .map_err(|error| EvalError::Script(format!("invalid StreamChunk: {error}")))
        })
        .collect()
}

/// The deterministic-lane knobs a fixture may set. Everything here is optional
/// so a plain text case needs only the top-level fields.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LaneConfig {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub permission_mode: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub allowed_tools: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub auto_allowed_tools: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub permission_decision: Option<PermissionDecisionJson>,
    /// `reserved` or `refused`. Defaults to `reserved` when a budget is set.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub admission: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub scripted_actual_usd_micros: Option<i64>,
    /// Scripts `account_request_chunk` to fail on `Done` (a ledger-append
    /// failure), which must leave the reservation reserved.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub scripted_account_error: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub capability_guard_enabled: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub context_window_tokens: Option<u64>,
    /// A [`CheckpointBoundary`] name (`tool_receipt`, …) to fault exactly once.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub checkpoint_fault: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pending_attachments: Option<usize>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PermissionDecisionJson {
    /// `allowOnce`, `allowAlways` or `deny`.
    pub kind: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

/// One versioned evaluation case.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EvaluationCase {
    pub v: i64,
    pub case_id: String,
    pub version: i64,
    pub title: String,
    pub task_input: String,
    pub execution_binding: ExecutionBinding,
    pub harness_config_digest: String,
    #[serde(default)]
    pub budget: CaseBudget,
    pub verifier: String,
    pub outcome_criteria: OutcomeCriteria,
    pub script: Vec<ScriptStepJson>,
    #[serde(default)]
    pub lane: LaneConfig,
    /// The repository fixture a live case runs against. Offline v1 cases leave
    /// this `null`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub repository_fixture: Option<String>,
    /// The starting commit a live case is pinned to. Offline v1 cases leave
    /// this `null`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub starting_commit: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Correctness {
    Pass,
    Fail,
}

/// Terminal state of one evaluated turn. `Incomplete` and `Blocked` are reserved
/// for a future lane that distinguishes an unfinished stream from a policy
/// refusal; the deterministic v1 lane maps every runner error to `Failed`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum RunStatus {
    Completed,
    Incomplete,
    Blocked,
    Failed,
    Cancelled,
}

/// Actual, provisional and unknown spend are kept separate: a reservation is
/// not an invoice and an unpriced route is not zero-cost.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Spend {
    pub actual_usd_micros: i64,
    pub provisional_usd_micros: i64,
    pub unknown_usd_micros: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Environment {
    pub os: String,
    pub arch: String,
    /// A caller-supplied source hash. The Node acceptance helper records the
    /// repository `sourceIdentity()`; the Rust CLI leaves it empty unless
    /// `PACKETBENCH_SOURCE_IDENTITY` is set.
    pub source_identity: String,
}

/// The versioned, redacted artifact of one evaluated turn. It contains event
/// *kinds*, counts and spend micros only — never raw reasoning, tool payloads,
/// credentials or account identifiers.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunResult {
    pub v: i64,
    pub case_id: String,
    pub case_version: i64,
    pub manifest_id: String,
    pub repetitions: u32,
    pub seed: u64,
    pub correctness: Correctness,
    pub infrastructure_errors: Vec<String>,
    pub status: RunStatus,
    pub interventions: u32,
    pub duration_ms: u64,
    pub spend: Spend,
    pub redacted: bool,
    pub environment: Environment,
    /// A bounded diagnostic for a failed grade: which criterion failed and, for
    /// a failed turn, the runner's error text. `None` when the case passed.
    /// This is a status/accounting diagnostic, never raw reasoning or a payload.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub failure_reason: Option<String>,
}

/// The case's stable identity, hashed into `manifest_id`. Mutable presentation
/// fields (title, task text, the script) are deliberately excluded so the same
/// semantic case dedupes across a script tweak.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CaseIdentity<'a> {
    case_id: &'a str,
    version: i64,
    execution_binding: &'a ExecutionBinding,
    harness_config_digest: &'a str,
    outcome_criteria: &'a OutcomeCriteria,
}

/// The harness configuration a case's `harnessConfigDigest` pins. Deliberately
/// excludes presentation fields (title, task text, criteria) so the digest
/// binds exactly what a fixture claims to run.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct HarnessConfig<'a> {
    execution_binding: &'a ExecutionBinding,
    script: &'a [ScriptStepJson],
    budget: &'a CaseBudget,
}

/// `sha256:<64 hex>` over the canonical JSON of a case's harness configuration
/// (execution binding + script + budget). Same helper and encoding as
/// [`manifest_id`], so a fixture's declared `harnessConfigDigest` is a real
/// binding rather than a free-text placeholder.
pub fn harness_config_digest(case: &EvaluationCase) -> String {
    let config = HarnessConfig {
        execution_binding: &case.execution_binding,
        script: &case.script,
        budget: &case.budget,
    };
    let canonical = serde_json::to_string(&config).unwrap_or_default();
    format!("sha256:{:x}", Sha256::digest(canonical.as_bytes()))
}

/// `sha256:<64 hex>` over the canonical JSON of the case identity. Mirrors the
/// run-manifest hashing so identical cases hash identically and any changed
/// identity field changes the hash.
pub fn manifest_id(case: &EvaluationCase) -> String {
    let identity = CaseIdentity {
        case_id: &case.case_id,
        version: case.version,
        execution_binding: &case.execution_binding,
        harness_config_digest: &case.harness_config_digest,
        outcome_criteria: &case.outcome_criteria,
    };
    let canonical = serde_json::to_string(&identity).unwrap_or_default();
    format!("sha256:{:x}", Sha256::digest(canonical.as_bytes()))
}

/// Load every `*.json` case in `dir` in stable name order. Rejects duplicate
/// case ids and any case whose wire version this build does not support.
pub fn load_cases(dir: &Path) -> Result<Vec<EvaluationCase>, EvalError> {
    let mut paths: Vec<PathBuf> = std::fs::read_dir(dir)
        .map_err(|error| EvalError::Io(format!("{}: {error}", dir.display())))?
        .filter_map(|entry| entry.ok())
        .map(|entry| entry.path())
        .filter(|path| {
            path.extension()
                .map(|ext| ext.eq_ignore_ascii_case("json"))
                .unwrap_or(false)
        })
        // The v1 JSON Schema documents live beside the cases; they are not
        // cases and must not be parsed as one.
        .filter(|path| {
            !path
                .file_name()
                .and_then(|name| name.to_str())
                .map(|name| name.ends_with(".schema.json"))
                .unwrap_or(false)
        })
        .collect();
    paths.sort();

    let mut cases = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();
    for path in paths {
        let text = std::fs::read_to_string(&path)
            .map_err(|error| EvalError::Io(format!("{}: {error}", path.display())))?;
        let case: EvaluationCase =
            serde_json::from_str(&text).map_err(|error| EvalError::Parse {
                path: path.display().to_string(),
                message: error.to_string(),
            })?;
        if case.v != EVALUATION_CASE_VERSION {
            return Err(EvalError::UnsupportedVersion {
                case_id: case.case_id,
                found: case.v,
                supported: EVALUATION_CASE_VERSION,
            });
        }
        if !seen.insert(case.case_id.clone()) {
            return Err(EvalError::DuplicateCaseId(case.case_id));
        }
        let expected = harness_config_digest(&case);
        if case.harness_config_digest != expected {
            return Err(EvalError::HarnessDigestMismatch {
                case_id: case.case_id,
                declared: case.harness_config_digest,
                expected,
            });
        }
        cases.push(case);
    }
    Ok(cases)
}

/// Redact a result. [`RunResult`] is constructed from event kinds, counts and
/// spend micros only — there is no raw reasoning, tool payload, credential or
/// account id to strip — so this is an explicit, auditable no-op that marks the
/// artifact redacted.
pub fn redact(result: &RunResult) -> RunResult {
    let mut redacted = result.clone();
    redacted.redacted = true;
    redacted
}

/// Run one case through the production runner and grade it from harness
/// observations. Correctness never consults model text: it compares the
/// observed terminal status, the settle count and the context-block signal
/// against the case's declared criteria.
pub async fn run_case(case: &EvaluationCase) -> RunResult {
    let started = Instant::now();
    let session_id = case.case_id.clone();
    let mut infrastructure_errors: Vec<String> = Vec::new();

    let mut services = FakeServices::new(&session_id);
    services.set_session_route(
        &case.execution_binding.provider,
        &case.execution_binding.model,
    );

    let lane = &case.lane;

    if let Some(mode) = lane.permission_mode.as_deref() {
        match PermissionMode::parse(mode) {
            Some(parsed) => services.set_permission_mode(parsed),
            None => infrastructure_errors.push(format!("unknown permissionMode: {mode}")),
        }
    }
    if let Some(tools) = lane.allowed_tools.clone() {
        services.set_allowed_tools(Some(tools));
    }
    if let Some(boundary_name) = lane.checkpoint_fault.as_deref() {
        match parse_boundary(boundary_name) {
            Some(boundary) => {
                let store = Arc::new(FaultCheckpointStore::new());
                store.fail_at(boundary, 1);
                services.install_checkpoints(store);
            }
            None => infrastructure_errors.push(format!("unknown checkpointFault: {boundary_name}")),
        }
    }

    for tool in &lane.auto_allowed_tools {
        services.allow_tool(tool);
    }
    if let Some(decision) = &lane.permission_decision {
        match permission_decision(decision) {
            Ok(decision) => services.script_permission(decision),
            Err(error) => infrastructure_errors.push(error.to_string()),
        }
    }
    if lane.capability_guard_enabled == Some(true) {
        services.set_capability_guard_enabled(true);
    }
    if let Some(window) = lane.context_window_tokens {
        services.set_context_window(Some(window));
    }
    if let Some(count) = lane.pending_attachments {
        services.set_pending_attachments(vec![attachment(); count]);
    }
    if let Some(actual) = lane.scripted_actual_usd_micros {
        services.set_scripted_actual_usd_micros(Some(actual));
    }
    if let Some(error) = &lane.scripted_account_error {
        services.set_scripted_account_error(Some(error.clone()));
    }

    let admission = admission_for(case, &mut infrastructure_errors);
    let reserved = matches!(admission, Some(Ok(BudgetAdmission::Reserved)));
    if let Some(admission) = admission {
        services.set_admission(admission);
    }

    for step in &case.script {
        match step.to_script_step() {
            Ok(step) => services.push_script(step),
            Err(error) => {
                infrastructure_errors.push(error.to_string());
                break;
            }
        }
    }

    // The runner treats a dropped cancel sender as a stop, so a non-cancel case
    // must hold the sender until the turn returns.
    let (cancel_tx, cancel_rx) = oneshot::channel::<()>();
    let mut cancel_holder = Some(cancel_tx);
    let canceller = if matches!(case.outcome_criteria.expect, ExpectedOutcome::Cancelled) {
        let sender = cancel_holder.take().expect("cancel sender present");
        Some(tokio::spawn(async move {
            tokio::time::sleep(CANCEL_AFTER).await;
            let _ = sender.send(());
        }))
    } else {
        None
    };

    let outcome = run_turn(
        &services,
        RunRequest {
            session_id: session_id.clone(),
        },
        cancel_rx,
    )
    .await;
    if let Some(handle) = canceller {
        let _ = handle.await;
    }
    drop(cancel_holder);

    let (status, error_text) = match outcome {
        Ok(RunOutcome::Completed { .. }) => (RunStatus::Completed, String::new()),
        Ok(RunOutcome::Cancelled) => (RunStatus::Cancelled, String::new()),
        Ok(RunOutcome::Failed(message)) => (RunStatus::Failed, message),
        Err(message) => (RunStatus::Failed, message),
    };

    let settle_calls = services.settle_calls();
    let release_calls = services.release_calls();
    let events = services.recorded_events();
    let interventions = events
        .iter()
        .filter(|(kind, _)| {
            kind.contains(":permission-request:") || kind.contains(":pending-edit:")
        })
        .count() as u32;

    let actual_usd_micros: i64 = settle_calls.iter().map(|(_, _, actual)| *actual).sum();
    let provisional_usd_micros = if reserved && settle_calls.is_empty() && release_calls.is_empty()
    {
        case.budget.limit_usd_micros.unwrap_or(0)
    } else {
        0
    };

    let executed = services.executed_tools();

    let status_ok = matches!(
        (case.outcome_criteria.expect, status),
        (ExpectedOutcome::Completed, RunStatus::Completed)
            | (ExpectedOutcome::Failed, RunStatus::Failed)
            | (ExpectedOutcome::Cancelled, RunStatus::Cancelled)
    );
    let settles_ok = match case.outcome_criteria.expect_settles {
        Some(expected) => settle_calls.len() as u32 == expected,
        None => true,
    };
    let context_ok = if case.outcome_criteria.expect_context_block {
        error_text.contains("blocked_context")
    } else {
        true
    };
    let tool_executed_ok = match &case.outcome_criteria.expect_tool_executed {
        Some(tool) => executed.iter().any(|ran| ran == tool),
        None => true,
    };
    let tool_denied_ok = match &case.outcome_criteria.expect_tool_denied {
        Some(tool) => !executed.iter().any(|ran| ran == tool),
        None => true,
    };
    let error_contains_ok = match &case.outcome_criteria.expect_error_contains {
        Some(needle) => error_text.contains(needle.as_str()),
        None => true,
    };

    let mut failures: Vec<String> = Vec::new();
    if !status_ok {
        failures.push(format!(
            "expected {} but observed {}",
            expected_label(case.outcome_criteria.expect),
            status_label(status)
        ));
    }
    if !settles_ok {
        if let Some(expected) = case.outcome_criteria.expect_settles {
            failures.push(format!(
                "expected {expected} settled reservation(s) but observed {}",
                settle_calls.len()
            ));
        }
    }
    if !context_ok {
        failures.push(format!(
            "expected a blocked_context error but the runner error was: {error_text}"
        ));
    }
    if !tool_executed_ok {
        if let Some(tool) = &case.outcome_criteria.expect_tool_executed {
            failures.push(format!(
                "expected tool '{tool}' to execute but executed tools were {executed:?}"
            ));
        }
    }
    if !tool_denied_ok {
        if let Some(tool) = &case.outcome_criteria.expect_tool_denied {
            failures.push(format!("expected tool '{tool}' NOT to execute but it did"));
        }
    }
    if !error_contains_ok {
        if let Some(needle) = &case.outcome_criteria.expect_error_contains {
            failures.push(format!(
                "expected the runner error to contain '{needle}' but it was: {error_text}"
            ));
        }
    }
    if !infrastructure_errors.is_empty() {
        failures.push(format!(
            "infrastructure: {}",
            infrastructure_errors.join("; ")
        ));
    }

    let correctness = if failures.is_empty() {
        Correctness::Pass
    } else {
        Correctness::Fail
    };
    let failure_reason = if failures.is_empty() {
        None
    } else {
        Some(failures.join("; "))
    };

    RunResult {
        v: RUN_RESULT_VERSION,
        case_id: case.case_id.clone(),
        case_version: case.version,
        manifest_id: manifest_id(case),
        repetitions: 1,
        seed: 0,
        correctness,
        infrastructure_errors,
        status,
        interventions,
        duration_ms: started.elapsed().as_millis() as u64,
        spend: Spend {
            actual_usd_micros,
            provisional_usd_micros,
            unknown_usd_micros: 0,
        },
        redacted: true,
        environment: Environment {
            os: std::env::consts::OS.to_string(),
            arch: std::env::consts::ARCH.to_string(),
            source_identity: String::new(),
        },
        failure_reason,
    }
}

fn expected_label(expected: ExpectedOutcome) -> &'static str {
    match expected {
        ExpectedOutcome::Completed => "completed",
        ExpectedOutcome::Failed => "failed",
        ExpectedOutcome::Cancelled => "cancelled",
    }
}

fn status_label(status: RunStatus) -> &'static str {
    match status {
        RunStatus::Completed => "completed",
        RunStatus::Incomplete => "incomplete",
        RunStatus::Blocked => "blocked",
        RunStatus::Failed => "failed",
        RunStatus::Cancelled => "cancelled",
    }
}

fn admission_for(
    case: &EvaluationCase,
    infrastructure_errors: &mut Vec<String>,
) -> Option<Result<BudgetAdmission, String>> {
    match case.lane.admission.as_deref() {
        Some("refused") => Some(Err(
            "budget refusal: the request exceeds the configured limit".to_string(),
        )),
        Some("reserved") => Some(Ok(BudgetAdmission::Reserved)),
        Some(other) => {
            infrastructure_errors.push(format!("unknown admission: {other}"));
            None
        }
        None if case.budget.limit_usd_micros.is_some() => Some(Ok(BudgetAdmission::Reserved)),
        None => None,
    }
}

fn permission_decision(spec: &PermissionDecisionJson) -> Result<PermissionDecision, EvalError> {
    match spec.kind.as_str() {
        "allowOnce" | "allow_once" => Ok(PermissionDecision::AllowOnce),
        "allowAlways" | "allow_always" => Ok(PermissionDecision::AllowAlways),
        "deny" => Ok(PermissionDecision::Deny {
            reason: spec.reason.clone(),
        }),
        other => Err(EvalError::Lane(format!(
            "unknown permissionDecision.kind: {other}"
        ))),
    }
}

fn parse_boundary(name: &str) -> Option<CheckpointBoundary> {
    [
        CheckpointBoundary::UserTurnAccepted,
        CheckpointBoundary::PreRequest,
        CheckpointBoundary::ToolIntent,
        CheckpointBoundary::ToolReceipt,
        CheckpointBoundary::AssistantReceipt,
    ]
    .into_iter()
    .find(|boundary| boundary.as_str() == name)
}

fn attachment() -> ImageAttachment {
    ImageAttachment {
        media_type: "image/png".to_string(),
        data_base64: "AAAA".to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn fixtures_dir() -> PathBuf {
        Path::new(env!("CARGO_MANIFEST_DIR")).join("testdata/runtime_eval")
    }

    fn fixture(case_id: &str) -> EvaluationCase {
        load_cases(&fixtures_dir())
            .expect("fixtures load")
            .into_iter()
            .find(|case| case.case_id == case_id)
            .unwrap_or_else(|| panic!("fixture {case_id} present"))
    }

    #[test]
    fn stream_chunk_json_shape_is_the_provider_contract() {
        let value = serde_json::to_value(StreamChunk::TextDelta {
            text: "hi".to_string(),
        })
        .unwrap();
        assert_eq!(value, json!({ "type": "TextDelta", "text": "hi" }));

        let decoded: StreamChunk =
            serde_json::from_value(json!({ "type": "TextDelta", "text": "hi" })).unwrap();
        assert!(matches!(decoded, StreamChunk::TextDelta { text } if text == "hi"));

        let done = serde_json::to_value(StreamChunk::Done {
            input_tokens: 2,
            output_tokens: 1,
            cache_read_input_tokens: 0,
            cache_creation_input_tokens: 0,
        })
        .unwrap();
        assert_eq!(done["type"], json!("Done"));
        assert_eq!(done["input_tokens"], json!(2));
    }

    #[test]
    fn loader_rejects_duplicate_case_ids() {
        let dir = tempfile::tempdir().unwrap();
        let case = fixture("case-01-text-stream");
        std::fs::write(
            dir.path().join("a.json"),
            serde_json::to_string(&case).unwrap(),
        )
        .unwrap();
        std::fs::write(
            dir.path().join("b.json"),
            serde_json::to_string(&case).unwrap(),
        )
        .unwrap();
        assert!(matches!(
            load_cases(dir.path()),
            Err(EvalError::DuplicateCaseId(id)) if id == case.case_id
        ));
    }

    #[test]
    fn loader_rejects_unsupported_version() {
        let dir = tempfile::tempdir().unwrap();
        let mut case = fixture("case-01-text-stream");
        case.v = EVALUATION_CASE_VERSION + 1;
        std::fs::write(
            dir.path().join("bad.json"),
            serde_json::to_string(&case).unwrap(),
        )
        .unwrap();
        assert!(matches!(
            load_cases(dir.path()),
            Err(EvalError::UnsupportedVersion { .. })
        ));
    }

    #[test]
    fn manifest_id_is_stable_and_identity_sensitive() {
        let case = fixture("case-01-text-stream");
        assert_eq!(manifest_id(&case), manifest_id(&case));
        assert!(manifest_id(&case).starts_with("sha256:"));

        let mut changed = case.clone();
        changed.execution_binding.model = "other-model".to_string();
        assert_ne!(manifest_id(&case), manifest_id(&changed));

        // Presentation-only edits do not change the identity.
        let mut retitled = case.clone();
        retitled.title = "a different title".to_string();
        assert_eq!(manifest_id(&case), manifest_id(&retitled));
    }

    #[tokio::test]
    async fn every_fixture_case_passes() {
        let cases = load_cases(&fixtures_dir()).expect("fixtures load");
        assert!(
            cases.len() >= 12,
            "the offline lane covers text/tool/permission/cancel/provider-error/budget/context/crash \
             and the journal-fail-closed cases"
        );
        for case in &cases {
            let result = run_case(case).await;
            assert_eq!(
                result.correctness,
                Correctness::Pass,
                "case {} failed: status={:?} errors={:?} reason={:?}",
                case.case_id,
                result.status,
                result.infrastructure_errors,
                result.failure_reason
            );
            assert!(result.redacted);
        }
    }

    #[tokio::test]
    async fn a_mismatched_criterion_fails() {
        let mut case = fixture("case-01-text-stream");
        case.outcome_criteria.expect = ExpectedOutcome::Failed;
        let result = run_case(&case).await;
        assert_eq!(result.correctness, Correctness::Fail);
        assert_eq!(result.status, RunStatus::Completed);
        assert!(result.failure_reason.is_some());
    }

    #[tokio::test]
    async fn tool_execution_expectations_are_load_bearing() {
        // case-02 auto-allows bash and the script drives it, so the tool runs:
        // claiming it was denied must fail.
        let mut executed = fixture("case-02-tool-auto-allowed");
        executed.outcome_criteria.expect_tool_denied = Some("bash".to_string());
        let result = run_case(&executed).await;
        assert_eq!(
            result.correctness,
            Correctness::Fail,
            "a tool that ran must fail expectToolDenied"
        );
        assert!(result
            .failure_reason
            .as_deref()
            .unwrap_or_default()
            .contains("NOT to execute"));

        // case-03 denies bash, so the tool must not run: claiming it executed
        // must fail.
        let mut denied = fixture("case-03-permission-denied");
        denied.outcome_criteria.expect_tool_executed = Some("bash".to_string());
        let result = run_case(&denied).await;
        assert_eq!(
            result.correctness,
            Correctness::Fail,
            "a denied tool must fail expectToolExecuted"
        );

        // The unmodified fixtures pass, so the assertions above are the only
        // difference.
        assert_eq!(
            run_case(&fixture("case-02-tool-auto-allowed"))
                .await
                .correctness,
            Correctness::Pass
        );
        assert_eq!(
            run_case(&fixture("case-03-permission-denied"))
                .await
                .correctness,
            Correctness::Pass
        );
    }

    #[tokio::test]
    async fn redact_leaves_no_raw_payload_in_the_artifact() {
        let case = fixture("case-01-text-stream");
        let result = run_case(&case).await;
        let json = serde_json::to_string(&result).unwrap();
        // case-01 streams the raw text "Hello"; the fake host's API key is
        // "fake-key" and its session system prompt is "You are a test agent.".
        assert!(
            !json.contains("Hello"),
            "raw model text leaked into RunResult: {json}"
        );
        assert!(
            !json.contains("fake-key"),
            "a credential leaked into RunResult: {json}"
        );
        assert!(
            !json.contains("You are a test agent."),
            "the system prompt leaked into RunResult: {json}"
        );
        assert!(result.redacted);
        assert_eq!(redact(&result), result);
    }

    #[test]
    fn schemas_and_fixtures_are_consistent() {
        let dir = fixtures_dir();
        let case_schema: Value = serde_json::from_str(
            &std::fs::read_to_string(dir.join("evaluation-case-v1.schema.json")).unwrap(),
        )
        .unwrap();
        let result_schema: Value = serde_json::from_str(
            &std::fs::read_to_string(dir.join("run-result-v1.schema.json")).unwrap(),
        )
        .unwrap();

        for (schema, id) in [
            (
                &case_schema,
                "https://packetbench.app/schemas/evaluation-case-v1.schema.json",
            ),
            (
                &result_schema,
                "https://packetbench.app/schemas/run-result-v1.schema.json",
            ),
        ] {
            assert_eq!(schema["$id"], json!(id));
            assert_eq!(schema["additionalProperties"], json!(false));
            assert_eq!(schema["properties"]["v"]["const"], json!(1));
        }

        let required: Vec<String> = case_schema["required"]
            .as_array()
            .expect("required array")
            .iter()
            .map(|value| value.as_str().expect("required key").to_string())
            .collect();
        assert!(!required.is_empty(), "schema declares required keys");

        let mut checked = 0;
        for entry in std::fs::read_dir(&dir).unwrap() {
            let path = entry.unwrap().path();
            let name = path
                .file_name()
                .and_then(|name| name.to_str())
                .unwrap_or_default()
                .to_string();
            if !name.starts_with("case-") || !name.ends_with(".json") {
                continue;
            }
            let value: Value =
                serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
            let object = value.as_object().expect("fixture is an object");
            for key in &required {
                assert!(
                    object.contains_key(key),
                    "{name} is missing the required key {key}"
                );
            }
            serde_json::from_value::<EvaluationCase>(value).unwrap_or_else(|error| {
                panic!("{name} must deserialize into EvaluationCase: {error}")
            });
            checked += 1;
        }
        assert!(
            checked >= 12,
            "expected at least 12 fixtures, found {checked}"
        );
    }

    #[test]
    fn loader_rejects_harness_digest_mismatch() {
        let dir = tempfile::tempdir().unwrap();
        let mut case = fixture("case-01-text-stream");
        case.harness_config_digest =
            "sha256:0000000000000000000000000000000000000000000000000000000000000000".to_string();
        std::fs::write(
            dir.path().join("bad.json"),
            serde_json::to_string(&case).unwrap(),
        )
        .unwrap();
        assert!(matches!(
            load_cases(dir.path()),
            Err(EvalError::HarnessDigestMismatch { .. })
        ));
    }

    #[test]
    fn print_fixture_harness_digests() {
        // Regenerates the `harnessConfigDigest` values for the fixtures. Run
        // with `cargo test --lib print_fixture_harness_digests -- --nocapture`
        // after editing a case's execution binding, script or budget.
        let dir = fixtures_dir();
        for entry in std::fs::read_dir(&dir).unwrap() {
            let path = entry.unwrap().path();
            let name = path
                .file_name()
                .and_then(|name| name.to_str())
                .unwrap_or_default()
                .to_string();
            if !name.starts_with("case-") || !name.ends_with(".json") {
                continue;
            }
            let case: EvaluationCase =
                serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
            println!("{} {}", case.case_id, harness_config_digest(&case));
        }
    }
}
