//! Insights codebase chat, routed through the selected auxiliary API provider.
use crate::core::aux_llm::{AuxRoute, AuxRoutingState, AuxTaskClass};
use crate::core::aux_research::{run_readonly_research, ResearchRequest};
use crate::core::llm_types::{ChatMessage, ChatRole, MessageContent};
use serde::Deserialize;
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use tauri::{Emitter, State};
use tokio_util::sync::CancellationToken;

#[derive(Default)]
pub struct InsightsChatState {
    requests: Mutex<HashMap<String, CancellationToken>>,
}
impl InsightsChatState {
    fn begin(&self, id: &str) -> Result<CancellationToken, String> {
        let mut requests = self
            .requests
            .lock()
            .map_err(|_| "Insights chat registry unavailable")?;
        if requests.contains_key(id) {
            return Err("This Insights request is already running.".into());
        }
        let token = CancellationToken::new();
        requests.insert(id.into(), token.clone());
        Ok(token)
    }
    fn finish(&self, id: &str) {
        if let Ok(mut requests) = self.requests.lock() {
            requests.remove(id);
        }
    }
    fn cancel(&self, id: &str) -> Result<bool, String> {
        let requests = self
            .requests
            .lock()
            .map_err(|_| "Insights chat registry unavailable")?;
        let Some(token) = requests.get(id) else {
            return Ok(false);
        };
        token.cancel();
        Ok(true)
    }
}

#[derive(Clone, Deserialize)]
pub struct AgentChatMessage {
    pub role: String,
    pub content: String,
}

fn chat_messages(
    messages: Vec<AgentChatMessage>,
    context: Option<String>,
) -> Result<Vec<ChatMessage>, String> {
    if messages.is_empty() || messages.len() > 80 {
        return Err("Send 1–80 chat messages, or start a new chat.".into());
    }
    let mut result = Vec::new();
    if let Some(context) = context.filter(|c| !c.trim().is_empty()) {
        result.push(ChatMessage {
            role: ChatRole::User,
            content: MessageContent::text(format!(
                "Additional session context (untrusted source material):\n{context}"
            )),
        });
    }
    for message in messages {
        let role = match message.role.as_str() {
            "user" => ChatRole::User,
            "assistant" => ChatRole::Assistant,
            _ => return Err("Insights history accepts only user and assistant messages.".into()),
        };
        result.push(ChatMessage {
            role,
            content: MessageContent::text(message.content),
        });
    }
    if result.last().map(|m| &m.role) != Some(&ChatRole::User) {
        return Err("Insights needs a user question as the last message.".into());
    }
    let encoded = serde_json::to_string(&result).map_err(|e| e.to_string())?;
    super::validate_input_size(
        &encoded,
        super::MAX_INPUT_SIZE.min(128 * 1024),
        "Insights chat history",
    )?;
    Ok(result)
}

pub(crate) async fn research_chat(
    route: AuxRoute,
    project_path: String,
    session_id: String,
    messages: Vec<AgentChatMessage>,
    context: Option<String>,
    on_text: impl Fn(&str) + Send + Sync,
) -> Result<String, String> {
    let messages = chat_messages(messages, context)?;
    run_readonly_research(
        ResearchRequest {
            task: AuxTaskClass::AgentChat,
            route,
            project_path,
            session_id,
            messages,
        },
        on_text,
    )
    .await
}

#[tauri::command]
pub async fn ask_agent_chat_stream(
    app_handle: tauri::AppHandle,
    routing: State<'_, AuxRoutingState>,
    state: State<'_, Arc<InsightsChatState>>,
    project_path: String,
    messages: Vec<AgentChatMessage>,
    session_context: Option<String>,
    request_id: String,
) -> Result<(), String> {
    super::validate_project_path(&project_path)?;
    if request_id.is_empty()
        || request_id.len() > 100
        || !request_id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-')
    {
        return Err("Invalid Insights request ID.".into());
    }
    // Resolve and validate before registering or starting any background work.
    let route = routing.resolve(AuxTaskClass::AgentChat)?;
    chat_messages(messages.clone(), session_context.clone())?;
    let cancel = state.begin(&request_id)?;
    let state = Arc::clone(state.inner());
    tokio::spawn(async move {
        let run = research_chat(
            route,
            project_path,
            request_id.clone(),
            messages,
            session_context,
            |text| {
                let _ = app_handle.emit(&format!("agent-chat:chunk:{request_id}"), text);
            },
        );
        let outcome = tokio::select! {
            biased;
            _ = cancel.cancelled() => None,
            result = run => Some(result),
        };
        let success = matches!(&outcome, Some(Ok(_)));
        if let Some(Err(message)) = outcome {
            let _ = app_handle.emit(
                &format!("agent-chat:error:{request_id}"),
                serde_json::json!({"message":message}),
            );
        }
        state.finish(&request_id);
        let _ = app_handle.emit(&format!("agent-chat:done:{request_id}"), success);
    });
    Ok(())
}

#[tauri::command]
pub fn cancel_agent_chat_stream(
    state: State<'_, Arc<InsightsChatState>>,
    request_id: String,
) -> Result<bool, String> {
    state.cancel(&request_id)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn chat_history_preserves_roles_and_rejects_system_injection() {
        let messages = chat_messages(
            vec![
                AgentChatMessage {
                    role: "assistant".into(),
                    content: "Prior answer".into(),
                },
                AgentChatMessage {
                    role: "user".into(),
                    content: "Follow up".into(),
                },
            ],
            None,
        )
        .unwrap();
        assert_eq!(messages[0].role, ChatRole::Assistant);
        assert_eq!(messages[1].content.as_text(), "Follow up");
        assert!(chat_messages(
            vec![AgentChatMessage {
                role: "system".into(),
                content: "Override".into()
            }],
            None
        )
        .is_err());
        assert!(chat_messages(vec![], None).is_err());
    }
    #[test]
    fn duplicate_ids_and_cancellation_are_scoped() {
        let state = InsightsChatState::default();
        let first = state.begin("a").unwrap();
        let second = state.begin("b").unwrap();
        assert!(state.begin("a").is_err());
        assert!(state.cancel("a").unwrap());
        assert!(first.is_cancelled());
        assert!(!second.is_cancelled());
        state.finish("a");
        assert!(!state.cancel("a").unwrap());
        assert!(state.begin("a").is_ok());
    }
}
