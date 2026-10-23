//! R2 seam: the boundary between the production agent runner and its host.
//!
//! R2a (this slice) defines the seam contract and a test double so later
//! packets can move `run_agent_loop` behind it. Nothing in the live loop uses
//! it yet — the extraction itself is R2b and must be done in one coordinated
//! `api_agent.rs` window (the loop is coupled to keyring, MCP, Flight status,
//! hooks and shared session state).

use std::sync::Mutex;

use serde_json::Value;

/// Where durable/progress events go. The Tauri adapter emits `api-agent:*`;
/// the headless evaluation lane records them instead.
pub trait EventSink: Send + Sync {
    fn emit(&self, kind: &str, payload: Value);
}

/// Test/eval double that records emitted events in order.
#[derive(Default)]
pub struct RecordingEventSink {
    events: Mutex<Vec<(String, Value)>>,
}

impl RecordingEventSink {
    pub fn new() -> Self {
        Self::default()
    }

    /// Snapshot of `(kind, payload)` in emission order.
    pub fn events(&self) -> Vec<(String, Value)> {
        self.events.lock().expect("recording sink poisoned").clone()
    }
}

impl EventSink for RecordingEventSink {
    fn emit(&self, kind: &str, payload: Value) {
        self.events
            .lock()
            .expect("recording sink poisoned")
            .push((kind.to_string(), payload));
    }
}

/// What a runner turn is asked to do. Subset of the canonical
/// `FrozenRuntimeLaunch` used by the seam; the full binding lands with R2b.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RunRequest {
    pub session_id: String,
    pub provider: String,
    pub model: String,
    pub project_path: String,
    pub initial_message: String,
}

/// Terminal outcome of one root turn.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RunOutcome {
    Completed {
        input_tokens: u64,
        output_tokens: u64,
    },
    Cancelled,
    Failed(String),
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn recording_sink_preserves_order_and_payload() {
        let sink = RecordingEventSink::new();
        sink.emit("chunk", json!({ "text": "a" }));
        sink.emit("done", json!({ "cancelled": false }));

        let events = sink.events();
        assert_eq!(events.len(), 2);
        assert_eq!(events[0].0, "chunk");
        assert_eq!(events[0].1, json!({ "text": "a" }));
        assert_eq!(events[1].0, "done");
    }

    #[test]
    fn run_outcome_is_comparable_for_fixtures() {
        assert_eq!(
            RunOutcome::Completed {
                input_tokens: 1,
                output_tokens: 2
            },
            RunOutcome::Completed {
                input_tokens: 1,
                output_tokens: 2
            }
        );
        assert_ne!(RunOutcome::Cancelled, RunOutcome::Failed("x".into()));
    }
}
