use serde::{Deserialize, Serialize};

/// A chat message in the conversation.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatMessage {
    pub role: ChatRole,
    pub content: MessageContent,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum ChatRole {
    User,
    Assistant,
    System,
    Tool,
}

/// Message content — either plain text or structured content blocks.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(untagged)]
pub enum MessageContent {
    Text(String),
    Blocks(Vec<ContentBlock>),
}

impl MessageContent {
    pub fn text(s: impl Into<String>) -> Self {
        Self::Text(s.into())
    }

    pub fn as_text(&self) -> &str {
        match self {
            Self::Text(s) => s,
            Self::Blocks(blocks) => {
                // Return first text block content, or empty
                for b in blocks {
                    if let ContentBlock::Text { text } = b {
                        return text;
                    }
                }
                ""
            }
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum ContentBlock {
    #[serde(rename = "text")]
    Text { text: String },
    #[serde(rename = "tool_use")]
    ToolUse {
        id: String,
        name: String,
        arguments: serde_json::Value,
    },
    #[serde(rename = "tool_result")]
    ToolResult {
        tool_call_id: String,
        content: String,
        #[serde(default)]
        is_error: bool,
    },
    #[serde(rename = "image")]
    Image {
        media_type: String,
        data_base64: String,
    },
    /// Opaque provider-owned reasoning payload that must be replayed verbatim
    /// on the next request to keep an interleaved-thinking chain intact.
    ///
    /// Stores provider-scoped replay data: MiniMax reasoning, Gemini tool
    /// signatures, Messages content blocks, or Responses output items. Each
    /// transport reads only its own envelope; none of this is rendered as text.
    #[serde(rename = "provider_reasoning")]
    ProviderReasoning { details: serde_json::Value },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ImageAttachment {
    pub media_type: String,
    pub data_base64: String,
}

/// Tool definition sent to the LLM.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolDefinition {
    pub name: String,
    pub description: String,
    /// JSON Schema for the tool parameters.
    pub parameters: serde_json::Value,
}

/// A parsed tool call from the LLM response.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolCall {
    pub id: String,
    pub name: String,
    pub arguments: serde_json::Value,
}

/// Result of executing a tool.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolResult {
    pub tool_call_id: String,
    pub content: String,
    pub is_error: bool,
}

/// Streaming chunks emitted during an LLM response.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum StreamChunk {
    /// A delta of text content.
    TextDelta { text: String },
    /// A tool use block has started.
    ToolUseStart { id: String, name: String },
    /// Partial JSON input for the current tool call.
    ToolUseInputDelta { delta: String },
    /// The current tool use block is complete with final parsed arguments.
    ToolUseEnd {
        id: String,
        name: String,
        arguments: serde_json::Value,
    },
    /// Stream is complete.
    Done {
        #[serde(default)]
        input_tokens: u64,
        #[serde(default)]
        output_tokens: u64,
        #[serde(default)]
        cache_read_input_tokens: u64,
        #[serde(default)]
        cache_creation_input_tokens: u64,
    },
    /// A delta of extended-thinking (reasoning) text.
    ThinkingDelta { text: String },
    /// The provider's own structured reasoning payload for this assistant turn,
    /// already accumulated across the stream. Emitted once, just before `Done`,
    /// by transports that require signed reasoning/tool metadata on subsequent
    /// turns. Consumers store it verbatim; they never inspect it.
    ReasoningDetails { details: serde_json::Value },
    /// The current extended-thinking block is complete.
    ThinkingStop,
    /// An error occurred.
    Error { message: String },
}

/// Request to an LLM provider.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LlmRequest {
    pub model: String,
    pub messages: Vec<ChatMessage>,
    pub tools: Vec<ToolDefinition>,
    #[serde(default)]
    pub system_prompt: Option<String>,
    #[serde(default = "default_max_tokens")]
    pub max_tokens: u32,
    #[serde(default)]
    pub temperature: Option<f32>,
    /// Attach images to the last user message. Providers that don't support vision ignore this.
    #[serde(default)]
    pub attachments: Vec<ImageAttachment>,
    /// Enable Anthropic extended thinking. OpenAI-compat providers silently ignore.
    #[serde(default)]
    pub thinking_enabled: bool,
    /// Budget for extended thinking tokens (Anthropic). Ignored when thinking_enabled is false.
    #[serde(default = "default_thinking_budget")]
    pub thinking_budget_tokens: u32,
    /// Stable cache-partition key for this logical conversation (the session
    /// id). Sent to OpenAI as `prompt_cache_key` so successive agent-loop
    /// iterations route to the same cache partition. Ignored by every other
    /// provider — Anthropic keys its cache off the prefix itself.
    #[serde(default)]
    pub cache_key: Option<String>,
}

fn default_thinking_budget() -> u32 {
    8000
}

fn default_max_tokens() -> u32 {
    16384
}
