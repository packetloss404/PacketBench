//! Claude-Code-style task management tools for API agents.
//!
//! Exposes `task_create`, `task_update`, and `task_list` so the agent can track
//! its own multi-step work and surface a checklist back to the user.
//!
//! Tasks belong to one backend conversation, survive its turns, and are
//! discarded when that conversation closes. They are intentionally ephemeral.

use crate::core::llm_types::ToolDefinition;
use serde::{Deserialize, Serialize};
use std::sync::Mutex;
use tracing::info;
use uuid::Uuid;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum TaskStatus {
    Pending,
    InProgress,
    Completed,
}

impl TaskStatus {
    fn from_str(s: &str) -> Result<Self, String> {
        match s {
            "pending" => Ok(Self::Pending),
            "in_progress" => Ok(Self::InProgress),
            "completed" => Ok(Self::Completed),
            other => Err(format!(
                "Unknown status '{}': expected pending|in_progress|completed",
                other
            )),
        }
    }

    fn checklist_marker(&self) -> &'static str {
        match self {
            Self::Pending => "- [ ]",
            Self::InProgress => "- [~]",
            Self::Completed => "- [x]",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Task {
    pub id: String,
    pub title: String,
    pub status: TaskStatus,
}

#[derive(Debug, Default)]
pub struct SessionTasks(Mutex<Vec<Task>>);

impl SessionTasks {
    pub fn clear(&self) {
        self.0.lock().unwrap_or_else(|e| e.into_inner()).clear();
    }
}

/// Tool definitions advertised to the LLM provider.
pub fn task_tool_definitions() -> Vec<ToolDefinition> {
    vec![
        ToolDefinition {
            name: "task_create".to_string(),
            description: "Create a new task in your todo list. Use this when planning multi-step work so the user can see your progress. Returns the new task id.".to_string(),
            parameters: serde_json::json!({
                "type": "object",
                "properties": {
                    "title": {
                        "type": "string",
                        "description": "Short, action-oriented title (e.g., 'Add task tools to runtime')."
                    },
                    "status": {
                        "type": "string",
                        "enum": ["pending", "in_progress", "completed"],
                        "description": "Initial status. Defaults to 'pending'."
                    }
                },
                "required": ["title"]
            }),
        },
        ToolDefinition {
            name: "task_update".to_string(),
            description: "Update an existing task's status and/or title. Call this as soon as you start a task (status: in_progress) and again when you finish it (status: completed).".to_string(),
            parameters: serde_json::json!({
                "type": "object",
                "properties": {
                    "task_id": {
                        "type": "string",
                        "description": "The id returned from task_create."
                    },
                    "status": {
                        "type": "string",
                        "enum": ["pending", "in_progress", "completed"],
                        "description": "New status."
                    },
                    "title": {
                        "type": "string",
                        "description": "New title (optional)."
                    }
                },
                "required": ["task_id"]
            }),
        },
        ToolDefinition {
            name: "task_list".to_string(),
            description: "List all current tasks as a markdown checklist. Use this to re-orient yourself or to surface progress to the user.".to_string(),
            parameters: serde_json::json!({
                "type": "object",
                "properties": {}
            }),
        },
    ]
}

pub fn execute_task_create(
    tasks: &SessionTasks,
    args: &serde_json::Value,
) -> Result<String, String> {
    let title = args
        .get("title")
        .and_then(|t| t.as_str())
        .ok_or("Missing 'title' parameter")?
        .trim()
        .to_string();

    if title.is_empty() {
        return Err("'title' must not be empty".to_string());
    }

    let status = match args.get("status").and_then(|s| s.as_str()) {
        Some(s) => TaskStatus::from_str(s)?,
        None => TaskStatus::Pending,
    };

    let id = Uuid::new_v4().to_string();
    let task = Task {
        id: id.clone(),
        title: title.clone(),
        status,
    };

    info!(task_id = %id, title = %title, "Tool: task_create");

    let mut tasks = tasks
        .0
        .lock()
        .map_err(|e| format!("Task store poisoned: {}", e))?;
    tasks.push(task);
    Ok(id)
}

pub fn execute_task_update(
    tasks: &SessionTasks,
    args: &serde_json::Value,
) -> Result<String, String> {
    let task_id = args
        .get("task_id")
        .and_then(|t| t.as_str())
        .ok_or("Missing 'task_id' parameter")?;

    let new_status = match args.get("status").and_then(|s| s.as_str()) {
        Some(s) => Some(TaskStatus::from_str(s)?),
        None => None,
    };
    let new_title = args
        .get("title")
        .and_then(|t| t.as_str())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());

    if new_status.is_none() && new_title.is_none() {
        return Err("Provide at least one of 'status' or 'title' to update".to_string());
    }

    let mut tasks = tasks
        .0
        .lock()
        .map_err(|e| format!("Task store poisoned: {}", e))?;

    let task = tasks
        .iter_mut()
        .find(|t| t.id == task_id)
        .ok_or_else(|| format!("No task with id '{}'", task_id))?;

    if let Some(status) = new_status {
        task.status = status;
    }
    if let Some(title) = new_title {
        task.title = title;
    }

    info!(task_id = %task_id, "Tool: task_update");
    Ok("updated".to_string())
}

pub fn execute_task_list(
    tasks: &SessionTasks,
    _args: &serde_json::Value,
) -> Result<String, String> {
    let tasks = tasks
        .0
        .lock()
        .map_err(|e| format!("Task store poisoned: {}", e))?;

    if tasks.is_empty() {
        return Ok("(no tasks yet)".to_string());
    }

    let lines: Vec<String> = tasks
        .iter()
        .map(|t| format!("{} {}", t.status.checklist_marker(), t.title))
        .collect();

    Ok(lines.join("\n"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn create_update_list_roundtrip() {
        let tasks = SessionTasks::default();
        let id = execute_task_create(&tasks, &json!({"title":"alpha"})).unwrap();
        execute_task_create(&tasks, &json!({"title":"beta", "status":"in_progress"})).unwrap();
        execute_task_update(&tasks, &json!({"task_id":id,"status":"completed"})).unwrap();
        let list = execute_task_list(&tasks, &json!({})).unwrap();
        assert!(list.contains("- [x] alpha"));
        assert!(list.contains("- [~] beta"));
    }

    #[test]
    fn sessions_cannot_list_or_update_each_others_tasks_and_close_clears() {
        let a = SessionTasks::default();
        let b = SessionTasks::default();
        let id = execute_task_create(&a, &json!({"title":"private-a"})).unwrap();
        assert_eq!(execute_task_list(&b, &json!({})).unwrap(), "(no tasks yet)");
        assert!(execute_task_update(&b, &json!({"task_id":id,"status":"completed"})).is_err());
        assert!(execute_task_list(&a, &json!({}))
            .unwrap()
            .contains("private-a"));
        a.clear();
        assert_eq!(execute_task_list(&a, &json!({})).unwrap(), "(no tasks yet)");
    }

    #[test]
    fn rejects_unknown_status() {
        assert!(execute_task_create(
            &SessionTasks::default(),
            &json!({"title":"x","status":"bogus"})
        )
        .unwrap_err()
        .contains("Unknown status"));
    }
}
