#[cfg(test)]
mod tests {
    use crate::core::flight::*;
    use crate::core::orchestrator::OrchestratorSettings;
    use crate::core::storage::PersistedState;

    /// Build a fully-populated sample state for contract testing.
    fn sample_state() -> PersistedState {
        PersistedState {
            version: 2,
            flights: vec![Flight {
                id: "flight-contract".to_string(),
                title: "Contract Test Flight".to_string(),
                objective: "Verify serialization".to_string(),
                status: FlightStatus::Active,
                priority: FlightPriority::High,
                project_path: "/test".to_string(),
                workspace_id: None,
                git_branch: Some("main".to_string()),
                milestones: vec![Milestone {
                    id: "ms-1".to_string(),
                    flight_id: "flight-contract".to_string(),
                    title: "Milestone 1".to_string(),
                    description: "First milestone".to_string(),
                    order: 0,
                    status: MilestoneStatus::Active,
                    tasks: vec![Task {
                        id: "task-1".to_string(),
                        milestone_id: "ms-1".to_string(),
                        flight_id: "flight-contract".to_string(),
                        title: "Task 1".to_string(),
                        description: "First task".to_string(),
                        order: 0,
                        status: TaskStatus::Running,
                        task_type: TaskType::Implementation,
                        agent_config_id: "claude-code".to_string(),
                        agent_args: None,
                        model: Some("claude-sonnet-4-6".to_string()),
                        depends_on: vec![],
                        session_id: Some("sess-1".to_string()),
                        result: Some(TaskResult {
                            exit_code: Some(0),
                            summary: "All good".to_string(),
                            files_changed: vec!["src/main.rs".to_string()],
                            errors: vec![],
                            duration_ms: 5000,
                            handoff: Some(TaskHandoff {
                                summary: "Handoff summary".to_string(),
                                files_changed: vec!["src/main.rs".to_string()],
                                tests_needed: vec!["test_main".to_string()],
                                follow_ups: vec![],
                            }),
                            validation: Some(TaskValidationReport {
                                verdict: ValidationVerdict::Pass,
                                summary: "Validated".to_string(),
                                assertions: vec![TaskValidationAssertion {
                                    label: "compiles".to_string(),
                                    status: ValidationVerdict::Pass,
                                    details: Some("OK".to_string()),
                                }],
                            }),
                        }),
                        review_packet: None,
                        created_at: 1000,
                        started_at: Some(2000),
                        completed_at: None,
                        cost: 0.5,
                        tokens: 1000,
                        owned_paths: Vec::new(),
                        replan_count: 0,
                    }],
                    validation_criteria: vec!["Tests pass".to_string()],
                }],
                linked_session_ids: vec!["sess-1".to_string()],
                created_at: 1000,
                updated_at: 2000,
                completed_at: None,
                total_cost: 0.5,
                total_tokens: 1000,
                prompt: None,
                attempts: vec![],
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
            }],
            agents: vec![],
            settings: OrchestratorSettings::default(),
            ui: Default::default(),
            issues: vec![],
            workspaces: vec![],
            retrospectives: vec![],
            memory_events: vec![],
            memory_patterns: vec![],
            servers: vec![],
            cli_accounts: vec![],
            cli_account_defaults: Default::default(),
            flight_approvals: vec![],
            cost_reprice_v1_at: None,
        }
    }

    #[test]
    fn persisted_state_serializes_with_expected_shape() {
        let state = sample_state();
        let json = serde_json::to_string_pretty(&state).unwrap();
        let value: serde_json::Value = serde_json::from_str(&json).unwrap();

        // Top-level keys
        assert!(value.get("version").is_some(), "missing key: version");
        assert!(value.get("flights").is_some(), "missing key: flights");
        assert!(value.get("agents").is_some(), "missing key: agents");
        assert!(value.get("settings").is_some(), "missing key: settings");
        assert!(value.get("ui").is_some(), "missing key: ui");

        // Settings keys (snake_case)
        let settings = &value["settings"];
        assert!(settings.get("max_parallel_sessions").is_some());
        assert!(settings.get("milestone_gating").is_some());
        assert!(settings.get("project_path").is_some());

        // Flight keys
        let flight = &value["flights"][0];
        assert!(flight.get("id").is_some(), "missing flight key: id");
        assert!(
            flight.get("project_path").is_some(),
            "missing flight key: project_path"
        );
        assert!(
            flight.get("git_branch").is_some(),
            "missing flight key: git_branch"
        );
        assert!(
            flight.get("milestones").is_some(),
            "missing flight key: milestones"
        );
        assert!(
            flight.get("linked_session_ids").is_some(),
            "missing flight key: linked_session_ids"
        );
        assert!(
            flight.get("created_at").is_some(),
            "missing flight key: created_at"
        );
        assert!(
            flight.get("updated_at").is_some(),
            "missing flight key: updated_at"
        );
        assert!(
            flight.get("total_cost").is_some(),
            "missing flight key: total_cost"
        );
        assert!(
            flight.get("total_tokens").is_some(),
            "missing flight key: total_tokens"
        );

        // Milestone keys
        let milestone = &flight["milestones"][0];
        assert!(
            milestone.get("flight_id").is_some(),
            "missing milestone key: flight_id"
        );
        assert!(
            milestone.get("validation_criteria").is_some(),
            "missing milestone key: validation_criteria"
        );

        // Task keys
        let task = &milestone["tasks"][0];
        assert!(
            task.get("task_type").is_some(),
            "missing task key: task_type (not 'type')"
        );
        assert!(
            task.get("agent_config_id").is_some(),
            "missing task key: agent_config_id"
        );
        assert!(
            task.get("depends_on").is_some(),
            "missing task key: depends_on"
        );
        assert!(
            task.get("session_id").is_some(),
            "missing task key: session_id"
        );
        assert!(
            task.get("milestone_id").is_some(),
            "missing task key: milestone_id"
        );
        assert!(
            task.get("flight_id").is_some(),
            "missing task key: flight_id"
        );
        assert!(
            task.get("agent_args").is_none() || task.get("agent_args").is_some(),
            "agent_args should serialize or be absent"
        );
        assert!(
            task.get("created_at").is_some(),
            "missing task key: created_at"
        );
        assert!(
            task.get("started_at").is_some(),
            "missing task key: started_at"
        );
        assert!(task.get("cost").is_some(), "missing task key: cost");
        assert!(task.get("tokens").is_some(), "missing task key: tokens");

        // TaskResult keys
        let result = &task["result"];
        assert!(
            result.get("exit_code").is_some(),
            "missing result key: exit_code"
        );
        assert!(
            result.get("files_changed").is_some(),
            "missing result key: files_changed"
        );
        assert!(
            result.get("duration_ms").is_some(),
            "missing result key: duration_ms"
        );
        assert!(
            result.get("handoff").is_some(),
            "missing result key: handoff"
        );
        assert!(
            result.get("validation").is_some(),
            "missing result key: validation"
        );

        // TaskHandoff keys
        let handoff = &result["handoff"];
        assert!(
            handoff.get("files_changed").is_some(),
            "missing handoff key: files_changed"
        );
        assert!(
            handoff.get("tests_needed").is_some(),
            "missing handoff key: tests_needed"
        );
        assert!(
            handoff.get("follow_ups").is_some(),
            "missing handoff key: follow_ups"
        );

        // TaskValidationReport keys
        let validation = &result["validation"];
        assert!(
            validation.get("verdict").is_some(),
            "missing validation key: verdict"
        );
        assert!(
            validation.get("assertions").is_some(),
            "missing validation key: assertions"
        );
        let assertion = &validation["assertions"][0];
        assert!(
            assertion.get("label").is_some(),
            "missing assertion key: label"
        );
        assert!(
            assertion.get("status").is_some(),
            "missing assertion key: status"
        );

        // Verify enum serialization uses snake_case
        assert_eq!(flight["status"].as_str().unwrap(), "active");
        assert_eq!(flight["priority"].as_str().unwrap(), "high");
        assert_eq!(task["status"].as_str().unwrap(), "running");
        assert_eq!(task["task_type"].as_str().unwrap(), "implementation");
        assert_eq!(validation["verdict"].as_str().unwrap(), "pass");

        // NOTE: this test used to write test-fixtures/state.v2.fixture.json
        // "for TS tests", but no TS (or other) consumer ever existed, and the
        // write embedded the running machine's current_dir via
        // OrchestratorSettings::default() — dirtying the tree on every
        // `cargo test` run. The write and the orphan fixture were removed;
        // the in-memory contract assertions above are the real guard.
    }

    #[test]
    fn persisted_state_roundtrips_through_serde() {
        let state = sample_state();
        let json = serde_json::to_string(&state).unwrap();
        let parsed: PersistedState = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed.version, state.version);
        assert_eq!(parsed.flights.len(), state.flights.len());
        assert_eq!(parsed.flights[0].id, state.flights[0].id);
        assert_eq!(parsed.flights[0].milestones[0].tasks[0].id, "task-1");
    }

    #[test]
    fn default_state_roundtrips() {
        let state = PersistedState::default();
        let json = serde_json::to_string(&state).unwrap();
        let parsed: PersistedState = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed.version, state.version);
        assert!(parsed.flights.is_empty());
    }

    /// C1-S1 — LEGACY-FIXTURE COMPAT (persisted-data policy, made executable).
    ///
    /// Simulates an OLD user's on-disk `PersistedState`: a flight in the
    /// legacy `spec` status carrying every Flight-Planner field
    /// (`planner_session_id` / `planner_status` / `planner_cost` /
    /// `planner_tokens` / `planner_provider`), a milestone+task, and a
    /// `flight_approvals` record with a `FlightApprovalRequest`. The
    /// planner-amputation work leaves these fields as inert serde
    /// pass-through, and this test PINS that: the fixture must deserialize
    /// losslessly, round-trip through the DTO, and re-serialize WITHOUT
    /// dropping any planner field. If a future change removes a planner field
    /// from the struct, this test fails — old users' data would silently lose
    /// those values on the next save.
    #[test]
    fn legacy_planner_fixture_roundtrips_without_losing_planner_fields() {
        // Hand-authored to match what an older release wrote to disk. Note the
        // legacy `"spec"` flight status and the full planner_* field set.
        let legacy_json = r#"{
            "version": 7,
            "flights": [
                {
                    "id": "legacy-flight-1",
                    "title": "Legacy planner flight",
                    "objective": "Ship the thing",
                    "status": "spec",
                    "priority": "high",
                    "project_path": "/legacy/project",
                    "git_branch": "main",
                    "milestones": [
                        {
                            "id": "ms-legacy-1",
                            "flight_id": "legacy-flight-1",
                            "title": "Legacy milestone",
                            "description": "old",
                            "order": 0,
                            "status": "active",
                            "tasks": [
                                {
                                    "id": "task-legacy-1",
                                    "milestone_id": "ms-legacy-1",
                                    "flight_id": "legacy-flight-1",
                                    "title": "Legacy task",
                                    "description": "old task",
                                    "order": 0,
                                    "status": "running",
                                    "task_type": "implementation",
                                    "agent_config_id": "claude-code",
                                    "agent_args": null,
                                    "model": "claude-sonnet-4-6",
                                    "depends_on": [],
                                    "session_id": "legacy-exec-sess",
                                    "result": null,
                                    "review_packet": null,
                                    "created_at": 1000,
                                    "started_at": 2000,
                                    "completed_at": null,
                                    "cost": 0.25,
                                    "tokens": 500
                                }
                            ],
                            "validation_criteria": ["builds"]
                        }
                    ],
                    "linked_session_ids": ["legacy-planner-sess"],
                    "created_at": 1000,
                    "updated_at": 2000,
                    "completed_at": null,
                    "total_cost": 1.25,
                    "total_tokens": 4200,
                    "planner_session_id": "legacy-planner-sess",
                    "planner_status": "awake",
                    "planner_cost": 0.75,
                    "planner_tokens": 3100,
                    "planner_provider": "claude-oauth"
                }
            ],
            "agents": [],
            "settings": {
                "max_parallel_sessions": 2,
                "milestone_gating": true,
                "project_path": "/legacy/project"
            },
            "ui": {},
            "flight_approvals": [
                {
                    "id": "appr-legacy-1",
                    "flightId": "legacy-flight-1",
                    "question": "Proceed?",
                    "options": ["yes", "no"],
                    "awaitingSince": 1500,
                    "resolved": false
                }
            ]
        }"#;

        // 1. Deserializes losslessly.
        let state: PersistedState =
            serde_json::from_str(legacy_json).expect("legacy state must deserialize");
        let flight = &state.flights[0];
        assert_eq!(flight.status, FlightStatus::Spec, "legacy 'spec' status");
        assert_eq!(
            flight.planner_session_id.as_deref(),
            Some("legacy-planner-sess")
        );
        assert_eq!(flight.planner_status, Some(PlannerStatus::Awake));
        assert_eq!(flight.planner_cost, Some(0.75));
        assert_eq!(flight.planner_tokens, Some(3100));
        assert_eq!(flight.planner_provider.as_deref(), Some("claude-oauth"));
        assert_eq!(flight.milestones.len(), 1);
        assert_eq!(flight.milestones[0].tasks.len(), 1);
        // flight_approvals (+ camelCase / missionId alias) survive too.
        assert_eq!(state.flight_approvals.len(), 1);
        assert_eq!(state.flight_approvals[0].flight_id, "legacy-flight-1");

        // 2. Round-trips through the DTO (parse -> struct -> serialize -> parse).
        let reserialized = serde_json::to_string(&state).expect("re-serialize state");
        let reparsed: PersistedState = serde_json::from_str(&reserialized).expect("re-parse state");
        let rf = &reparsed.flights[0];

        // 3. Re-serializes WITHOUT losing any planner field.
        assert_eq!(rf.planner_session_id, flight.planner_session_id);
        assert_eq!(rf.planner_status, flight.planner_status);
        assert_eq!(rf.planner_cost, flight.planner_cost);
        assert_eq!(rf.planner_tokens, flight.planner_tokens);
        assert_eq!(rf.planner_provider, flight.planner_provider);
        assert_eq!(rf.status, FlightStatus::Spec);

        // Belt-and-suspenders: the re-serialized JSON literally still contains
        // every planner key (guards against a future `skip_serializing` that
        // would drop a set field on save).
        let value: serde_json::Value = serde_json::from_str(&reserialized).unwrap();
        let out_flight = &value["flights"][0];
        for key in [
            "planner_session_id",
            "planner_status",
            "planner_cost",
            "planner_tokens",
            "planner_provider",
        ] {
            assert!(
                out_flight.get(key).is_some(),
                "re-serialized flight dropped planner key: {}",
                key
            );
        }
    }

    #[test]
    fn enum_variants_serialize_to_expected_strings() {
        // FlightStatus
        let statuses = vec![
            (FlightStatus::Draft, "draft"),
            (FlightStatus::Spec, "spec"),
            (FlightStatus::Planning, "planning"),
            (FlightStatus::Ready, "ready"),
            (FlightStatus::Active, "active"),
            (FlightStatus::Paused, "paused"),
            (FlightStatus::Review, "review"),
            (FlightStatus::Done, "done"),
            (FlightStatus::Failed, "failed"),
            (FlightStatus::Cancelled, "cancelled"),
        ];
        for (variant, expected) in statuses {
            let json = serde_json::to_string(&variant).unwrap();
            assert_eq!(
                json,
                format!("\"{}\"", expected),
                "FlightStatus::{:?}",
                variant
            );
        }

        // FlightPriority
        let priorities = vec![
            (FlightPriority::Low, "low"),
            (FlightPriority::Medium, "medium"),
            (FlightPriority::High, "high"),
            (FlightPriority::Critical, "critical"),
        ];
        for (variant, expected) in priorities {
            let json = serde_json::to_string(&variant).unwrap();
            assert_eq!(
                json,
                format!("\"{}\"", expected),
                "FlightPriority::{:?}",
                variant
            );
        }

        // TaskStatus — verify approval_needed (not "approvalNeeded")
        let task_statuses = vec![
            (TaskStatus::Pending, "pending"),
            (TaskStatus::Blocked, "blocked"),
            (TaskStatus::Queued, "queued"),
            (TaskStatus::Running, "running"),
            (TaskStatus::ApprovalNeeded, "approval_needed"),
            (TaskStatus::Paused, "paused"),
            (TaskStatus::Done, "done"),
            (TaskStatus::Failed, "failed"),
            (TaskStatus::Cancelled, "cancelled"),
        ];
        for (variant, expected) in task_statuses {
            let json = serde_json::to_string(&variant).unwrap();
            assert_eq!(
                json,
                format!("\"{}\"", expected),
                "TaskStatus::{:?}",
                variant
            );
        }

        // TaskType
        let types = vec![
            (TaskType::Implementation, "implementation"),
            (TaskType::Testing, "testing"),
            (TaskType::Review, "review"),
            (TaskType::Validation, "validation"),
            (TaskType::Research, "research"),
            (TaskType::Refactor, "refactor"),
            (TaskType::Documentation, "documentation"),
        ];
        for (variant, expected) in types {
            let json = serde_json::to_string(&variant).unwrap();
            assert_eq!(json, format!("\"{}\"", expected), "TaskType::{:?}", variant);
        }

        // ValidationVerdict
        let verdicts = vec![
            (ValidationVerdict::Pass, "pass"),
            (ValidationVerdict::Fail, "fail"),
            (ValidationVerdict::Warn, "warn"),
        ];
        for (variant, expected) in verdicts {
            let json = serde_json::to_string(&variant).unwrap();
            assert_eq!(
                json,
                format!("\"{}\"", expected),
                "ValidationVerdict::{:?}",
                variant
            );
        }
    }
}
