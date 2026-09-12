pub mod agent;
pub mod agent_config;
pub mod agents_md;
// LM4 (3C-3) — bounded, root-confined Rust-side context assembly for the
// auxiliary seam. Replaces the Claude CLI file tools for the memory scan.
pub mod aux_context;
// WI-1 — the auxiliary LLM seam every non-agentic feature routes through.
pub mod aux_llm;
pub mod boot_check;
pub mod brand;
pub mod claude_statusline;
// v0.8.8 quality ai: hand-authored prompts for the Code Quality AI features
// (explain-error + summarize-run). Kept next to `github_ai_prompts` so prompt
// iteration doesn't churn the command surface.
pub mod code_quality_ai_prompts;
#[cfg(test)]
mod contract_tests;
pub mod error_classifier;
pub mod execution;
pub mod flight;
pub mod git;
pub mod git_host;
// v0.8-E / v0.8-F: shared home for hand-authored GitHub AI prompts.
// Registered here in case the v0.8-E slice hasn't landed yet.
pub mod github_ai_prompts;
pub mod hooks;
// v0.8.5: shared home for hand-authored Issue AI prompts (spec → tickets).
pub mod issue_ai_prompts;
pub mod llm_anthropic;
pub mod llm_custom_compat;
pub mod llm_minimax;
pub mod llm_ollama;
pub mod llm_openai;
pub mod llm_openai_compat;
pub mod llm_openrouter;
pub mod llm_provider;
pub mod llm_system_prompt;
pub mod llm_types;
pub mod mcp_bridge;
pub mod mcp_client;
pub mod migration;
pub mod orchestrator;
pub mod project_trust;
pub mod provenance;
pub mod pty;
pub(crate) mod pty_output;
// One-time reprice of historical cost figures written with the pre-CE2 rates.
pub mod reprice;
pub mod shared;
pub mod shell_path;
pub mod ssh_askpass;
pub mod storage;
pub mod tool_custom_agent;
pub mod tool_github;
pub mod tool_pull_request;
pub mod tool_runtime;
pub mod tool_runtime_ssh;
pub mod tool_subagent;
pub mod tool_tasks;
pub mod tool_web;
pub mod workspace;
pub mod worktree;

pub use agent_config::AgentConfig;
pub use flight::{Flight, FlightStatus, Milestone, Task, TaskStatus};
pub use pty::PtyTranscript;
pub use shared::{hide_window, home_dir, lock_mutex, SKIP_DIRS};
