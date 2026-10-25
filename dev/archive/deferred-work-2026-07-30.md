# Deferred work — tile composer / conversation tiles

> Canonical ledger: [`backlog.md`](../../backlog.md). This file is a scoped
> resume-cold reference for the tile-composer/conversation-tile deferrals only;
> anything that becomes actionable belongs in the backlog.

Backlog of things intentionally **not** done during the Waves 1–4 modernization +
the Codex/PTY/harness fixes, with enough detail to resume each cold. This file
predates the 2026-07-29 Workspace/Agents restructuring: new GUI-agent work now
starts in the first-class Agents view, while existing and explicitly attached
Workspace conversation tiles remain compatible. Ordered roughly by value. The
full 314-finding review that seeded the waves is archived in
[`agents-tab-modernization-plan.md`](agents-tab-modernization-plan.md).

Re-verified against the code on 2026-07-30; the line-ending normalization item
shipped and was removed. All six deferrals below were confirmed still open in
this pass (`modeToCodexFlags` still pins `approval_policy=never`, no Composer
MCP multi-select, no `costCapUsd`, no `reasoningEffort` launch field, no diff
toolbar controls).

---

## 1. Codex — interactive per-command approvals (plan / manual modes)
**Status:** Not supported. `modeToCodexFlags` maps every safe mode to
`-c approval_policy=never` (the root `-a` flag isn't accepted by `codex exec`
subcommands); the sandbox (`read-only` for plan, `workspace-write` otherwise)
is the safety boundary instead of per-command prompts.
`bypassPermissions` maps to `--dangerously-bypass-approvals-and-sandbox`.

**Why deferred:** `codex exec` blocks reading stdin, so we close stdin after
spawning (see the "Reading additional input from stdin" fix). That removes the
channel the old `respondPermission` used to send approval responses back, so
interactive approval policies would stall the turn.

**Resume:** `agent-sidecar/src/providers/openai-codex.ts` (`modeToCodexFlags`,
`respondPermission`). Check whether codex 0.142+ exposes an approval channel that
doesn't need an open stdin (a control fd, or `codex proto` / app-server mode). If
so, run Codex through that persistent mode instead of one-shot `exec` and wire
`permission_request` ↔ the response channel. Otherwise this stays as-is.
(ROADMAP tracks the app-server transport question as "Later" item A6.)

## 2. MCP servers at launch (composer)
**Status:** **Partial.** Launch-time MCP now comes from the Settings-level
default (`defaultEnabledMcpServerIds` in `agentSettingsStore`, edited via
`McpServersCard`), which `createApiConversation` applies when no explicit list
is passed; Flight launches pass explicit IDs. What's still missing is a
per-launch MCP multi-select in the Composer itself. Note the original "MCP can
only be picked mid-conversation" framing is stale: since protocol v11 froze
per-session MCP trust, mid-session hot-swap is *not* supported —
`enabledMcpServerIds` changes apply on the next session start.

**Resume:** add an MCP multi-select to
`src/components/agents/composer/Composer.tsx` (reuse `mcpStore` + the `Popover`
primitive), pass `enabledMcpServerIds` through the `createApiConversation`
options object (the plumbing exists — see `agentTaskStore.ts` ~line 520, where
`createApiConversation` falls back to `defaultEnabledMcpServerIds`), and
confirm the Rust/sidecar honor it at `start_api_agent_session`.

## 3. Per-run cost cap — mid-run cancel
**Status:** **Partial.** Cost guardrails shipped (per-run cost is tracked and
surfaced), and Flight-level bounded autonomy now enforces a `maxTotalCost`
hard-stop (`src/lib/autonomyPolicy.ts`) that blocks further *autonomous*
actions when a Flight crosses its cost limit. But there is still no
per-conversation mid-run cancel: nothing halts a runaway single agent run once
it crosses a threshold.

**Why deferred:** the remaining piece needs a live cost-tracking hook in the
agent loop that *cancels* on threshold, not just displays or gates the next
autonomous action.

**Resume:** add a `costCapUsd` field to the launch options; in
`src-tauri/src/commands/api_agent.rs` (`run_agent_loop`) or the `turn_summary`
handler, accumulate cost per turn and cancel the session when exceeded. UI: a cap
input in the composer's Advanced accordion. (Note: with `MAX_TOOL_ITERATIONS`
at 150 and the autonomy harness, runs are longer — this is more relevant now.)

## 4. Cross-provider reasoning-effort / thinking-budget control
**Status:** No launch control. The Codex PTY status bar displays
`reasoning_effort` read-only, and the composer still has only the heuristic
speed pill plus the hidden model-swap hack — no way to set effort/budget when
launching a conversation.

**Why deferred:** each provider applies it differently — Anthropic extended-
thinking budget (currently hardcoded to 8000 tokens in `api_agent.rs`),
OpenAI/Codex `reasoning_effort` / `model_reasoning_effort` — so it needs
per-provider plumbing frontend → Rust/sidecar.

**Resume:** add a `reasoningEffort` ('low'|'medium'|'high') field to the launch
options + a `SegmentedControl` in the composer. Plumb: Anthropic provider
(thinking budget), Codex (`-c model_reasoning_effort=…`), OpenAI (`reasoning_effort`).
Files: composer, `createApiConversation` options, `api_agent.rs`, the sidecar
providers.

## 5. Full `agentTaskStore` module split
**Status:** Wave 4 did a **light** extraction (persistence/hydration helpers →
`agentConversationPersistence.ts`, public API preserved via re-exports), and
later work trimmed the store to ~1,520 lines (from 1,839). The full split is
still deferred.

**Why deferred:** the store has 50+ importers; a full split is high regression
risk for zero user-visible value.

**Resume:** keep extracting cohesive slices (legacy PTY tasks, `api-agent`
listeners, resume logic, conversation CRUD) into sibling modules, re-exporting
from `agentTaskStore.ts` so importers don't change. Do it incrementally, running
`tsc` + `vitest` after each extraction.

## 6. Diff viewer — extra controls
**Status:** Wave 4 rebuilt the diff engine (interleaved rows, line-number gutter,
background-tint); the shared renderer now lives in
`src/components/agents/diff/` (`DiffRows.tsx`, `CommentableRow.tsx`) with hunk
selection folded into `review/ReviewSurface.tsx`. Still missing: word-wrap
toggle, unified/split toggle, copy diff/file, expand-context.

**Resume:** `src/components/agents/diff/*` + `review/ReviewSurface.tsx` — add
the toolbar controls on top of the shared row renderer.

---

## Validation TODOs (not code — things to confirm on a real run)

- **Autonomy harness** (`src/lib/agent-harness.ts`) — shipped but not verified on
  a real multi-step task. Run tasks and tune the prompt: watch for over-running,
  stopping too early anyway, wrong tone, or conflicts with plan mode. This is the
  highest-value thing to babysit.
- **PTY orphan reaper** — verify live: open a workspace pane with an agent, close
  it, confirm no orphaned child survives; and that a crash/force-quit is swept on
  next launch (`src-tauri/src/core/pty.rs` `reap_orphaned_pty_children`).
- **Codex streaming feel** — `codex exec` emits complete blocks, not token
  deltas, so it's choppier than the direct APIs. If it matters, investigate a
  Codex streaming/delta mode; otherwise it's inherent.
