//! Pure read projections: `&PersistedState` → JSON, reusing the existing
//! camelCase `api` DTOs so the MCP surface matches the frontend's shapes.
//! Kept free of transport/rmcp types so they're unit-testable in isolation.

use serde_json::{json, Value};

use crate::api::{FlightDto, ReviewPacketDto, TaskDto, WorkspaceDto};
use crate::core::flight::{Flight, FlightStatus, Task, TaskStatus};
use crate::core::storage::PersistedState;

/// A task is "runnable" when it can be dispatched now: `pending` or `queued`.
/// `blocked` (unmet deps), `approval_needed`/`paused` (held), `running`, and the
/// terminal states are all excluded. NOTE: this is only half the predicate — a
/// task is truly runnable only if its parent flight is also runnable
/// (`flight_is_runnable`); callers must AND the two.
pub fn is_runnable(status: &TaskStatus) -> bool {
    matches!(status, TaskStatus::Pending | TaskStatus::Queued)
}

/// A flight can dispatch work only while it is actively executing. `Draft`,
/// `Spec`, `Planning`, and `Ready` haven't launched; `Paused` was held by the
/// user; `Review`/`Done`/`Failed`/`Cancelled` are past dispatch. Without this
/// gate, a paused or not-yet-launched flight's `Pending` tasks would be
/// advertised as runnable to an external orchestrator.
pub fn flight_is_runnable(flight: &Flight) -> bool {
    matches!(flight.status, FlightStatus::Active)
}

/// Iterator over every runnable task across all runnable flights.
fn runnable_tasks(state: &PersistedState) -> impl Iterator<Item = &Task> {
    state
        .flights
        .iter()
        .filter(|f| flight_is_runnable(f))
        .flat_map(all_tasks)
        .filter(|t| is_runnable(&t.status))
}

fn all_tasks(flight: &Flight) -> impl Iterator<Item = &Task> {
    flight.milestones.iter().flat_map(|m| m.tasks.iter())
}

fn find_flight<'a>(state: &'a PersistedState, id: &str) -> Option<&'a Flight> {
    state.flights.iter().find(|f| f.id == id)
}

fn to_value<T: serde::Serialize>(v: T) -> Value {
    serde_json::to_value(v).unwrap_or(Value::Null)
}

fn flight_dto(f: &Flight) -> Value {
    // Reuses the frontend's camelCase FlightDto. Caveat: its `From` hardcodes
    // `issueIds: []` (issue linkage isn't carried on the core Flight), so that
    // field is always empty here — agents must not treat it as authoritative.
    to_value(FlightDto::from(f.clone()))
}

fn task_dto(t: &Task) -> Value {
    to_value(TaskDto::from(t.clone()))
}

// === Tool projections ===

pub fn active_flight_json(state: &PersistedState) -> Value {
    match state
        .ui
        .selected_flight_id
        .as_deref()
        .and_then(|id| find_flight(state, id))
    {
        Some(f) => flight_dto(f),
        None => Value::Null,
    }
}

pub fn runnable_tasks_json(state: &PersistedState) -> Value {
    let tasks: Vec<Value> = runnable_tasks(state).map(task_dto).collect();
    json!({ "tasks": tasks })
}

pub fn task_details_json(state: &PersistedState, flight_id: &str, task_id: &str) -> Option<Value> {
    let flight = find_flight(state, flight_id)?;
    let task = all_tasks(flight).find(|t| t.id == task_id)?;
    Some(task_dto(task))
}

pub fn memory_patterns_json(state: &PersistedState) -> Value {
    json!({ "patterns": state.memory_patterns })
}

pub fn workspaces_json(state: &PersistedState) -> Value {
    let workspaces: Vec<Value> = state
        .workspaces
        .iter()
        .map(|w| to_value(WorkspaceDto::from(w.clone())))
        .collect();
    json!({ "workspaces": workspaces })
}

pub fn workspace_project_path<'a>(
    state: &'a PersistedState,
    workspace_id: &str,
) -> Option<&'a str> {
    state
        .workspaces
        .iter()
        .find(|workspace| workspace.id == workspace_id && workspace.server_id.is_none())
        .map(|workspace| workspace.project_path.as_str())
}

// === Resource projections ===

pub fn all_flights_json(state: &PersistedState) -> Value {
    let flights: Vec<Value> = state.flights.iter().map(flight_dto).collect();
    json!({ "flights": flights })
}

pub fn all_issues_json(state: &PersistedState) -> Value {
    json!({
        "issues": state.issues,
        "count": state.issues.len(),
    })
}

pub fn one_flight_json(state: &PersistedState, id: &str) -> Option<Value> {
    find_flight(state, id).map(flight_dto)
}

pub fn flight_tasks_json(state: &PersistedState, id: &str) -> Option<Value> {
    let flight = find_flight(state, id)?;
    let tasks: Vec<Value> = all_tasks(flight).map(task_dto).collect();
    Some(json!({ "flightId": id, "tasks": tasks }))
}

pub fn flight_inbox_json(
    state: &PersistedState,
    id: &str,
    recipient_id: Option<&str>,
) -> Option<Value> {
    let flight = find_flight(state, id)?;
    let messages = flight
        .coordination_inbox
        .iter()
        .filter(|message| {
            recipient_id.is_none()
                || message.recipient.id.as_deref() == recipient_id
                || message.recipient.kind == "flight"
        })
        .collect::<Vec<_>>();
    Some(json!({ "flightId": id, "messages": messages }))
}

pub fn reviews_json(state: &PersistedState) -> Value {
    let reviews: Vec<Value> = state
        .flights
        .iter()
        .flat_map(all_tasks)
        .filter_map(|t| t.review_packet.as_ref())
        .map(|rp| to_value(ReviewPacketDto::from(rp.clone())))
        .collect();
    json!({ "reviews": reviews })
}

pub fn project_overview_json(state: &PersistedState) -> Value {
    let task_count: usize = state.flights.iter().flat_map(all_tasks).count();
    let runnable_count: usize = runnable_tasks(state).count();
    json!({
        "version": state.version,
        "activeFlightId": state.ui.selected_flight_id,
        "flightCount": state.flights.len(),
        "workspaceCount": state.workspaces.len(),
        "taskCount": task_count,
        "runnableTaskCount": runnable_count,
    })
}

// === Write validation ===

/// Max handoff-note length. Bounds per-event growth of the persisted flights
/// slice (each note is appended to `state.v1.json`).
pub const MAX_HANDOFF_SUMMARY: usize = 4096;
pub const MAX_INBOX_BODY: usize = 16_384;

/// Validate an `append_handoff` request against current state. Returns the
/// rejection message on failure. Pure so the tool's guard is unit-testable.
pub fn validate_handoff(
    state: &PersistedState,
    flight_id: &str,
    summary: &str,
) -> Result<(), &'static str> {
    if summary.trim().is_empty() {
        return Err("summary must not be empty");
    }
    if summary.len() > MAX_HANDOFF_SUMMARY {
        return Err("summary too long");
    }
    if !state.flights.iter().any(|f| f.id == flight_id) {
        return Err("unknown flightId");
    }
    Ok(())
}

pub fn validate_inbox_post(
    state: &PersistedState,
    flight_id: &str,
    kind: &str,
    recipient_kind: &str,
    recipient_id: Option<&str>,
    body: &str,
) -> Result<(), &'static str> {
    if body.trim().is_empty() {
        return Err("body must not be empty");
    }
    if body.len() > MAX_INBOX_BODY {
        return Err("body too long");
    }
    if !matches!(
        kind,
        "instruction" | "question" | "answer" | "blocker" | "finding" | "handoff" | "artifact"
    ) {
        return Err("unsupported message kind");
    }
    if !matches!(
        recipient_kind,
        "flight" | "role" | "task" | "attempt" | "session"
    ) {
        return Err("unsupported recipient kind");
    }
    if recipient_kind != "flight" && recipient_id.is_none_or(|id| id.trim().is_empty()) {
        return Err("recipientId is required");
    }
    if !state.flights.iter().any(|flight| flight.id == flight_id) {
        return Err("unknown flightId");
    }
    Ok(())
}

// === Resource URI routing ===

#[derive(Debug, PartialEq, Eq)]
pub enum ResourceRoute<'a> {
    Project,
    Flights,
    Issues,
    Flight(&'a str),
    FlightTasks(&'a str),
    FlightInbox(&'a str),
    MemoryPatterns,
    ProjectMemory(&'a str),
    Workspaces,
    Reviews,
    PacketCodeHealth,
    Unknown,
}

/// Parse a `packetbench://…` resource URI into a route. Unknown/foreign schemes
/// and malformed paths map to `Unknown`.
pub fn parse_resource_uri(uri: &str) -> ResourceRoute<'_> {
    let Some(path) = uri.strip_prefix("packetbench://") else {
        return ResourceRoute::Unknown;
    };
    let parts: Vec<&str> = path.split('/').collect();
    match parts.as_slice() {
        ["project"] => ResourceRoute::Project,
        ["flights"] => ResourceRoute::Flights,
        ["issues"] => ResourceRoute::Issues,
        ["flights", id] if !id.is_empty() => ResourceRoute::Flight(id),
        ["flights", id, "tasks"] if !id.is_empty() => ResourceRoute::FlightTasks(id),
        ["flights", id, "inbox"] if !id.is_empty() => ResourceRoute::FlightInbox(id),
        ["memory", "patterns"] => ResourceRoute::MemoryPatterns,
        ["memory", "project", workspace_id] if !workspace_id.is_empty() => {
            ResourceRoute::ProjectMemory(workspace_id)
        }
        ["workspaces"] => ResourceRoute::Workspaces,
        ["reviews"] => ResourceRoute::Reviews,
        ["packetcode", "health"] => ResourceRoute::PacketCodeHealth,
        _ => ResourceRoute::Unknown,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::flight::{
        Flight, FlightPriority, FlightStatus, Milestone, MilestoneStatus, Task, TaskStatus,
        TaskType,
    };

    fn task(id: &str, status: TaskStatus) -> Task {
        Task {
            id: id.to_string(),
            milestone_id: "m1".to_string(),
            flight_id: "f1".to_string(),
            title: format!("task {id}"),
            description: String::new(),
            order: 0,
            status,
            task_type: TaskType::Implementation,
            agent_config_id: String::new(),
            agent_args: None,
            model: None,
            depends_on: Vec::new(),
            session_id: None,
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

    fn flight_with(id: &str, tasks: Vec<Task>) -> Flight {
        Flight {
            id: id.to_string(),
            title: format!("flight {id}"),
            objective: String::new(),
            status: FlightStatus::Active,
            priority: FlightPriority::Medium,
            project_path: "/tmp/test".to_string(),
            workspace_id: None,
            git_branch: None,
            milestones: vec![Milestone {
                id: "m1".to_string(),
                flight_id: id.to_string(),
                title: "M1".to_string(),
                description: String::new(),
                order: 0,
                status: MilestoneStatus::Active,
                tasks,
                validation_criteria: Vec::new(),
            }],
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

    fn state_with(flights: Vec<Flight>, active: Option<&str>) -> PersistedState {
        let mut s = PersistedState::default();
        s.flights = flights;
        s.ui.selected_flight_id = active.map(|a| a.to_string());
        s
    }

    fn flight_status(mut f: Flight, status: FlightStatus) -> Flight {
        f.status = status;
        f
    }

    #[test]
    fn is_runnable_only_pending_or_queued() {
        assert!(is_runnable(&TaskStatus::Pending));
        assert!(is_runnable(&TaskStatus::Queued));
        for s in [
            TaskStatus::Blocked,
            TaskStatus::Running,
            TaskStatus::ApprovalNeeded,
            TaskStatus::Paused,
            TaskStatus::Done,
            TaskStatus::Failed,
            TaskStatus::Cancelled,
        ] {
            assert!(!is_runnable(&s), "{s:?} must not be runnable");
        }
    }

    #[test]
    fn runnable_tasks_filters_and_spans_active_flights() {
        let f1 = flight_with(
            "f1",
            vec![task("t1", TaskStatus::Queued), task("t2", TaskStatus::Done)],
        );
        let f2 = flight_with("f2", vec![task("t3", TaskStatus::Pending)]);
        let state = state_with(vec![f1, f2], None);
        let v = runnable_tasks_json(&state);
        let ids: Vec<&str> = v["tasks"]
            .as_array()
            .unwrap()
            .iter()
            .map(|t| t["id"].as_str().unwrap())
            .collect();
        assert_eq!(ids, vec!["t1", "t3"]);
    }

    #[test]
    fn runnable_tasks_excludes_paused_and_prelaunch_flights() {
        // Pending tasks in a paused or not-yet-launched flight must NOT surface.
        let paused = flight_status(
            flight_with("paused", vec![task("p1", TaskStatus::Pending)]),
            FlightStatus::Paused,
        );
        let draft = flight_status(
            flight_with("draft", vec![task("d1", TaskStatus::Queued)]),
            FlightStatus::Draft,
        );
        let active = flight_with("active", vec![task("a1", TaskStatus::Pending)]);
        let state = state_with(vec![paused, draft, active], None);
        let v = runnable_tasks_json(&state);
        let ids: Vec<&str> = v["tasks"]
            .as_array()
            .unwrap()
            .iter()
            .map(|t| t["id"].as_str().unwrap())
            .collect();
        assert_eq!(ids, vec!["a1"]);
        assert_eq!(project_overview_json(&state)["runnableTaskCount"], 1);
    }

    #[test]
    fn active_flight_resolves_via_ui_selection() {
        let state = state_with(
            vec![flight_with("f1", vec![]), flight_with("f2", vec![])],
            Some("f2"),
        );
        assert_eq!(active_flight_json(&state)["id"].as_str(), Some("f2"));
        // No selection → null.
        let none = state_with(vec![flight_with("f1", vec![])], None);
        assert!(active_flight_json(&none).is_null());
    }

    #[test]
    fn task_details_found_and_missing() {
        let state = state_with(
            vec![flight_with("f1", vec![task("t1", TaskStatus::Pending)])],
            None,
        );
        assert_eq!(
            task_details_json(&state, "f1", "t1").unwrap()["id"].as_str(),
            Some("t1")
        );
        assert!(task_details_json(&state, "f1", "nope").is_none());
        assert!(task_details_json(&state, "nope", "t1").is_none());
    }

    #[test]
    fn project_overview_counts() {
        let f1 = flight_with(
            "f1",
            vec![task("t1", TaskStatus::Queued), task("t2", TaskStatus::Done)],
        );
        let state = state_with(vec![f1], Some("f1"));
        let v = project_overview_json(&state);
        assert_eq!(v["flightCount"], 1);
        assert_eq!(v["taskCount"], 2);
        assert_eq!(v["runnableTaskCount"], 1);
        assert_eq!(v["activeFlightId"], "f1");
    }

    #[test]
    fn validate_handoff_guards() {
        let state = state_with(vec![flight_with("f1", vec![])], None);
        assert!(validate_handoff(&state, "f1", "did the thing").is_ok());
        assert_eq!(
            validate_handoff(&state, "f1", "   "),
            Err("summary must not be empty")
        );
        assert_eq!(
            validate_handoff(&state, "nope", "hi"),
            Err("unknown flightId")
        );
        // Over-long summaries are rejected (bounds persisted-state growth).
        let long = "x".repeat(MAX_HANDOFF_SUMMARY + 1);
        assert_eq!(
            validate_handoff(&state, "f1", &long),
            Err("summary too long")
        );
        let exact = "x".repeat(MAX_HANDOFF_SUMMARY);
        assert!(validate_handoff(&state, "f1", &exact).is_ok());
    }

    #[test]
    fn validate_inbox_post_guards_kind_recipient_and_bounds() {
        let state = state_with(vec![flight_with("f1", vec![])], None);
        assert!(validate_inbox_post(
            &state,
            "f1",
            "blocker",
            "task",
            Some("t1"),
            "Need a decision"
        )
        .is_ok());
        assert_eq!(
            validate_inbox_post(&state, "f1", "bogus", "flight", None, "hello"),
            Err("unsupported message kind")
        );
        assert_eq!(
            validate_inbox_post(&state, "f1", "question", "task", None, "hello"),
            Err("recipientId is required")
        );
        assert_eq!(
            validate_inbox_post(&state, "missing", "question", "flight", None, "hello"),
            Err("unknown flightId")
        );
        let long = "x".repeat(MAX_INBOX_BODY + 1);
        assert_eq!(
            validate_inbox_post(&state, "f1", "question", "flight", None, &long),
            Err("body too long")
        );
    }

    #[test]
    fn resource_uri_routing() {
        assert_eq!(
            parse_resource_uri("packetbench://project"),
            ResourceRoute::Project
        );
        assert_eq!(
            parse_resource_uri("packetbench://flights"),
            ResourceRoute::Flights
        );
        assert_eq!(
            parse_resource_uri("packetbench://issues"),
            ResourceRoute::Issues
        );
        assert_eq!(
            parse_resource_uri("packetbench://flights/f1"),
            ResourceRoute::Flight("f1")
        );
        assert_eq!(
            parse_resource_uri("packetbench://flights/f1/tasks"),
            ResourceRoute::FlightTasks("f1")
        );
        assert_eq!(
            parse_resource_uri("packetbench://flights/f1/inbox"),
            ResourceRoute::FlightInbox("f1")
        );
        assert_eq!(
            parse_resource_uri("packetbench://memory/patterns"),
            ResourceRoute::MemoryPatterns
        );
        assert_eq!(
            parse_resource_uri("packetbench://workspaces"),
            ResourceRoute::Workspaces
        );
        assert_eq!(
            parse_resource_uri("packetbench://reviews"),
            ResourceRoute::Reviews
        );
        assert_eq!(
            parse_resource_uri("packetbench://packetcode/health"),
            ResourceRoute::PacketCodeHealth
        );
        assert_eq!(
            parse_resource_uri("packetbench://flights/"),
            ResourceRoute::Unknown
        );
        assert_eq!(parse_resource_uri("http://evil"), ResourceRoute::Unknown);
        assert_eq!(
            parse_resource_uri("packetbench://bogus/path"),
            ResourceRoute::Unknown
        );
    }
}
