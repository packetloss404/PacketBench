import type { TaskType } from "./flight";

// === Task Type Metadata ===

export const ALL_TASK_TYPES: TaskType[] = [
  "implementation",
  "testing",
  "review",
  "validation",
  "research",
  "refactor",
  "documentation",
];

export const TASK_TYPE_LABELS: Record<TaskType, { label: string; description: string }> = {
  implementation: { label: "Implementation", description: "Writing new code" },
  testing: { label: "Testing", description: "Writing & running tests" },
  review: { label: "Code Review", description: "Reviewing code changes" },
  validation: { label: "Validation", description: "Verifying correctness" },
  research: { label: "Research", description: "Exploring solutions" },
  refactor: { label: "Refactoring", description: "Improving existing code" },
  documentation: { label: "Documentation", description: "Writing docs" },
};

// === Provider Routing ===

export interface RouteMapping {
  taskType: TaskType;
  agentConfigId: string;
  model: string | null; // null = system default
}

// === Auxiliary AI task routing (WI-1) ===
//
// Distinct from the `TaskType` routing above, which assigns a coding AGENT to a
// workflow role. These are the short, single-shot generation tasks PacketBench
// runs on the user's behalf: parse a spec, summarize failed checks, write PR
// prose. They do not need a frontier model and they are never routed through a
// Claude / ChatGPT subscription login — see `src-tauri/src/core/aux_llm.rs`.
//
// Ids must match `AuxTaskClass::id()` in that module exactly.

export type AuxTaskClass =
  | "spec-import"
  | "code-quality-summarize"
  | "pr-description"
  | "pr-review"
  | "memory-scan"
  | "session-summarize"
  | "pattern-extract"
  | "flight-retrospective"
  | "spec-to-flight"
  | "spec-to-tickets"
  | "issue-investigate"
  | "agent-chat"
  | "side-chat"
  | "github-catch-up"
  | "github-triage";

export const ALL_AUX_TASK_CLASSES: AuxTaskClass[] = [
  "spec-import",
  "spec-to-flight",
  "spec-to-tickets",
  "code-quality-summarize",
  "pr-description",
  "pr-review",
  "github-catch-up",
  "github-triage",
  "issue-investigate",
  "memory-scan",
  "session-summarize",
  "pattern-extract",
  "flight-retrospective",
  "agent-chat",
  "side-chat",
];

export const AUX_TASK_CLASS_LABELS: Record<AuxTaskClass, { label: string; description: string }> = {
  "spec-import": { label: "Spec import", description: "Spec / PRD → issue drafts" },
  "spec-to-flight": { label: "Spec → flight plan", description: "Spec text → structured flight" },
  "spec-to-tickets": { label: "Spec → tickets", description: "Spec text → ticket array" },
  "code-quality-summarize": {
    label: "Summarize checks",
    description: "Code Quality run summaries",
  },
  "pr-description": { label: "PR description", description: "GitHub PR write-ups" },
  "pr-review": { label: "PR review", description: "GitHub pre-flight reviews" },
  "github-catch-up": { label: "Catch-up digest", description: "GitHub activity digest" },
  "github-triage": { label: "Issue triage", description: "GitHub AI label/priority triage" },
  "issue-investigate": {
    label: "Issue investigation",
    description: "GitHub issue deep-dive (file tools)",
  },
  "memory-scan": { label: "Codebase scan", description: "Key-file memory scan (file tools)" },
  "session-summarize": { label: "Session summary", description: "Session log → summary" },
  "pattern-extract": { label: "Pattern extraction", description: "Summaries → recurring patterns" },
  "flight-retrospective": {
    label: "Flight retrospective",
    description: "Completed-flight lessons",
  },
  "agent-chat": { label: "Agent chat", description: "Insights agent chat (file tools)" },
  "side-chat": { label: "Side chat", description: "Floating side-chat overlay" },
};

/**
 * Task classes whose Settings row cannot take effect today, and why.
 *
 * FAULT: three of the sixteen rows were configuring nothing, with no way for a
 * user to tell. Two of them additionally falsified the section's blanket claim
 * that auxiliary tasks never touch a subscription login: they still shell out
 * to the local `claude` binary, which authenticates however that CLI is logged
 * in. The rows are KEPT rather than deleted — the pins are already persisted,
 * the backend `AuxTaskClass` arms still exist, and `core::aux_llm` resolves
 * them the moment a caller arrives — but each says what it does today.
 *
 * `memory-scan` was the third. Its caveat is gone because the Memory pane's
 * "Scan codebase" button now invokes `scan_codebase_memory`, so the pin it
 * always honoured finally has a caller.
 *
 * Drift guard: `commands/aux_routing.rs::unrouted_aux_surfaces_stay_declared`
 * fails when one of these surfaces moves onto the seam, pointing back here.
 */
export const AUX_TASK_CLASS_CAVEATS: Partial<Record<AuxTaskClass, string>> = {
  "issue-investigate":
    "Not applied yet — still runs the local Claude CLI, so it uses whatever login that CLI has, including a subscription.",
  "agent-chat":
    "Not applied yet — still runs the local Claude CLI, so it uses whatever login that CLI has, including a subscription.",
};

/**
 * Settings-card grouping for the auxiliary task classes. Rendered as
 * headed sections once the flat list outgrows a single screenful (>8 rows);
 * every class must appear in exactly one group.
 */
export const AUX_TASK_CLASS_GROUPS: { label: string; classes: AuxTaskClass[] }[] = [
  { label: "Spec & issues", classes: ["spec-import", "spec-to-flight", "spec-to-tickets"] },
  { label: "Code Quality", classes: ["code-quality-summarize"] },
  {
    label: "GitHub",
    classes: [
      "pr-description",
      "pr-review",
      "github-catch-up",
      "github-triage",
      "issue-investigate",
    ],
  },
  {
    label: "Memory & flights",
    classes: ["memory-scan", "session-summarize", "pattern-extract", "flight-retrospective"],
  },
  { label: "Chat", classes: ["agent-chat", "side-chat"] },
];

/**
 * A user-pinned auxiliary route. `provider: null` means "Auto" — the backend
 * picks the cheapest configured API-key provider using the shared rate table.
 */
export interface AuxRouteMapping {
  taskClass: AuxTaskClass;
  provider: string | null;
  model: string | null;
}

/** What a task class resolves to right now, straight from the backend. */
export interface AuxRouteResolution {
  taskClass: string;
  label: string;
  provider: string | null;
  model: string | null;
  explicit: boolean;
  error: string | null;
}

/** A provider an auxiliary task class may be pinned to. */
export interface AuxProviderOption {
  provider: string;
  defaultModel: string;
  needsApiKey: boolean;
  configured: boolean;
}
