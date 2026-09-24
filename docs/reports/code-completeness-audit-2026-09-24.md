# Existing-code completeness audit — 2026-09-24

Audited commit: `5035f98d1d58ba867652ce666895ff6e2b451f8d` (0.14.7).
Scope: existing functionality only; no feature expansion, production edits,
paid provider calls, installation or publishing. Three review teams covered
frontend controls, Rust/sidecar execution, and stores/integration contracts.
The primary reviewer measured size/reachability, checked documentation claims,
and independently inspected the highest-impact authority/accounting paths.

## Assessment

The code cannot currently be described as fully integrated, placeholder-free,
or consistently truthful about state and capabilities. There is substantial
working implementation, alongside concrete authority gaps, incomplete lifecycle
paths, unreachable feature code and stale promises. A clean build and passing
tests do not establish these untested integration properties.

This audit records **six P1 and sixteen P2 findings**, plus two cleanup/doc
findings. They are source-confirmed paths, not a claim that every trigger was
reproduced in the packaged application. One approval-shortcut issue additionally
has an executable handler-level reproduction. These are preexisting findings,
not all regressions introduced in the most recent commit.

Use `backlog.md` as the live task register. This report is a dated evidence
snapshot. File/line references below refer to the audited commit.

## Size and growth

Counts are physical lines, including comments, blank lines and inline Rust
tests. Dependencies, build output, ignored acceptance evidence and binaries are
excluded from text totals. These counts are not a measure of maintainability.

| Category                                         | Files | Physical lines |
| ------------------------------------------------ | ----: | -------------: |
| Desktop frontend source, separate tests excluded |   535 |        118,899 |
| Rust backend source, including inline tests      |   131 |         88,086 |
| Sidecar source                                   |    12 |          4,206 |
| Separate tests, mocks and fixtures               |   338 |         61,751 |
| Documentation and plans                          |   189 |         56,787 |
| Build and acceptance scripts                     |    29 |          6,582 |
| Remote Agents foundation/configuration           |    13 |            484 |
| Generated frontend bindings                      |     1 |            266 |
| Lockfiles                                        |     4 |         13,657 |
| Other text configuration/assets                  |    47 |          6,560 |

Total: **1,352 tracked files**, **357,278 text lines**, including **211,191
lines in the three main runtime-source categories**. This is not millions of
lines, but it is a sizable codebase for its maintenance resources.

The July 31 snapshot (`87d8b07d`) had approximately 160,545 physical lines in
those runtime-source categories; the present Git-object count is approximately
211,183, an increase of 50,638 (31.5%). Git grep and working-file counting differ
slightly on final-line handling. The last implementation commit (`4443c8b0`)
added a net **1,780 runtime-source lines**: frontend +730, Rust +989, sidecar +61.
Most of that commit's remaining additions were tests, docs and acceptance tools.
No authorship conclusion about Claude or another assistant follows from these
counts or the repository's human author identity.

Large maintenance concentrations include `commands/github.rs` (5,278 lines),
`lib/tauri.ts` (4,180), `api/mod.rs` (3,283), `commands/api_agent.rs` (2,896),
and `core/worktree.rs` (2,598). Size alone is not a finding or permission for a
wholesale rewrite; first fix the boundaries demonstrated below.

## P1 — authority, wrong-target actions and advertised spending controls

### F01 — Hidden terminal approval shortcuts consume unrelated keys

`src/hooks/useApprovalShortcuts.ts:70` has no owning-view/Workspace, modal,
modifier or IME guard. A single pending approval owns keys even when another
pane is selected. Workspaces stay mounted when hidden (`src/App.tsx:263`), and
callbacks write approvals, denials or Ctrl-C to the PTY
(`src/hooks/useTerminalSession.ts:609`). Leave an approval waiting, switch
views/open a dialog, and Y/N/Escape on a non-text control can act on that hidden
terminal. Listener ordering can defeat a later modal's `defaultPrevented` guard.

A harness transpiling the actual hook reproduced plain Y, Ctrl+Y, composing Y,
and button Escape with a different active pane. Fix ownership at the shortcut
boundary and reject modified/composing events; focus-restoration guards alone
do not protect approval dispatch.

### F02 — Create PR combines two unrelated repositories

`src/components/workspace/WorktreeLifecycleBar.tsx:131` uses the conversation's
worktree path but global GitHub selection's owner/repo. `src/lib/gitPublish.ts:78`
pushes the worktree's origin before creating the PR in that selected repository.
Select repository B in GitHub, then publish a conversation in A: A is pushed,
while the PR request targets B. Usually this fails after the push; a matching
head already in B can produce the wrong PR. Resolve and validate the repository
and host from the worktree before any publish action.

### B01 — Custom-agent delegation drops the parent's MCP authority

`src-tauri/src/core/tool_custom_agent.rs:114` discovers child tools through
unrestricted `tool_definitions()`. The child dispatch at
`core/tool_subagent.rs:244` uses `execute_tool()` without the parent's selected
servers or frozen trust snapshot. `core/mcp_bridge.rs:330` skips root checks
when that snapshot is absent. A global custom agent allowing an annotated
read-only MCP tool can rediscover a server excluded by the parent or read
outside the parent's frozen roots. Mutation and credential-name restrictions
still apply; this is a read-authority expansion, not unrestricted execution.
Propagate immutable parent MCP selection/trust through discovery and dispatch.

### B02 — In-process profile tool restrictions filter advertisements only

Profiles reach the backend through `src/lib/launchConversation.ts:106`.
`src-tauri/src/commands/api_agent.rs:1956` filters the advertised tool list,
but returned calls enter the dispatch path at line 2260 without membership
validation. `core/tool_runtime.rs:274` dispatches known names. A model returning
`read_file` when a profile excluded it still executes that call. Separate risky
tool permissions remain in force. Validate every call against the effective
session tool set before hooks or execution. The child loop's existing allowlist
check does not protect this parent-loop path.

### S01 — The visible per-conversation spending cap has no spend input

`src/stores/costGuardrailStore.ts:185` evaluates current session spend using
literal zero. Running monitoring at `src/stores/analyticsStore.ts:71` supplies
no session usage, and `src/lib/costGuardrails.ts:223` defaults it to zero.
There is no production caller supplying `currentSessionCostUsd`. The visible
session cap therefore cannot react to actual conversation spend. Wire the
existing conversation cost into monitoring and turn admission, and test crossing
the configured cap; do not present the current setting as enforced.

### S02 — Restored conversations bypass launch budget admission

New creation checks `assertCostGuardrailsAllowLaunch` at
`src/stores/agentTaskStore.ts:717`. Resume starts a fresh backend directly at
line 1757. After reaching a daily/provider cap, restarting and sending in a
saved conversation can start paid work even though new-chat creation is blocked.
Use one admission path for creation and resume, with an explicit existing-turn
policy. This is distinct from S01's absent per-session usage input.

## P2 — incomplete behavior and lifecycle integration

| ID  | Concrete behavior and trigger                                                                                                                                                                                                      | Source evidence                                                                                                                     | Minimum correction                                                                                                                          |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| F03 | A slow Git refresh for Workspace A can overwrite B's display after switching, while stage/commit handlers act on B's current path.                                                                                                 | `src/components/workspace/GitDashboard.tsx:296,475`; reused at `src/components/views/WorkspaceView.tsx:182`                         | Fence asynchronous results by current project/server scope; clear or disable mutations until that scope loads.                              |
| F04 | Monitor reads active, failed and completed conversations as idle. Read-only projection uses a loader that unconditionally resets status and streaming metadata.                                                                    | `src/components/monitor/MonitorApp.tsx:54,153`; `src/stores/agentConversationPersistence.ts:175`                                    | Separate cold-start normalization from live read-only projection.                                                                           |
| F05 | Settings saves custom CLI entries, but neither routed Workspace launcher offers them.                                                                                                                                              | `src/components/views/tools/CliAgentsCard.tsx:943`; `workspace/AddSessionPicker.tsx:229`; `workspace/WorkspaceCreationModal.tsx:39` | Connect only already-supported execution or remove/disable misleading creation. Do not invent a new CLI subsystem.                          |
| F06 | Code Quality advertises live ANSI output, cancellation, execution history and per-finding explanations, but the live view exposes only aggregate run completion and AI summaries. Existing diagnostics components are unreachable. | `README.md:368`; `src/components/views/QualityView.tsx:387`; `quality/QualityAIRunSummaryPanel.tsx:175`                             | Integrate the existing intended diagnostics or narrow claims and remove abandoned code. Metrics history and aggregate AI summaries do work. |
| B03 | Paid child-agent requests discard token/cache totals, so parent/Flight usage omits their entire request stream.                                                                                                                    | `src-tauri/src/core/tool_subagent.rs:151,202`; `commands/api_agent.rs:2118`                                                         | Return or separately persist child usage with provider/model attribution, without double-counting.                                          |
| B04 | Task create/update/list use one process-wide vector. Conversation B can see or mutate A's checklist, and closure does not clear it.                                                                                                | `src-tauri/src/core/tool_tasks.rs:58`; `core/tool_runtime.rs:342`                                                                   | Scope tasks by conversation and define cleanup/persistence. A source “v1 caveat” is not isolation.                                          |
| B05 | Project-only custom agents are loaded at invocation but never advertised; a same-name project override can differ from the advertised global definition.                                                                           | `src-tauri/src/core/tool_custom_agent.rs:45,73`                                                                                     | Discover against the trusted execution project and retain the same definition for dispatch.                                                 |
| B06 | After eight tool-bearing rounds, a sub-agent returns intermediate text as successful completion even if no final answer occurred.                                                                                                  | `src-tauri/src/core/tool_subagent.rs:269`                                                                                           | Return explicit incomplete/error status on iteration exhaustion, with partial text if useful.                                               |
| B07 | In-process MCP supports global stdio configuration; project or HTTP/SSE configuration from shared surfaces disappears or fails as unconfigured.                                                                                    | `src-tauri/src/core/mcp_bridge.rs:389`; `core/mcp_client.rs:448,462`                                                                | Expose the actual provider/transport boundary; keep this under the existing MCP parity item rather than silently promising parity.          |
| B08 | A process-global atomic counter called recursion depth rejects a fourth unrelated first-level child when three are running, even across conversations.                                                                             | `src-tauri/src/core/tool_subagent.rs:289`                                                                                           | Separate per-chain depth from any deliberate global concurrency limit.                                                                      |
| S03 | A persisted running reviewer gate can wait forever after restart: its reviewer is reset to idle with no backend, or absent, while retry/override remains unavailable.                                                              | `src/stores/reviewerGateRuntime.ts:416`; `agentConversationPersistence.ts:175`; `components/flights/AttemptTile.tsx:290`            | Reconcile absent/non-live reviewers to an explicit interrupted/error state with retry.                                                      |
| S04 | Reviewer verdict/override appears successful even when its authoritative backend write fails; a console log is the only failure signal.                                                                                            | `src/stores/reviewerGateRuntime.ts:53,60,119,366`                                                                                   | Propagate persistence failure, revert or show retry, and announce success only after the authoritative write.                               |
| S05 | Restored conversations cannot change plan mode, permission mode or approve-writes before their first resumed turn: setters call a nonexistent backend and the UI discards failures.                                                | `src/stores/agentTaskStore.ts:1354,1373,1387`; `components/agents/AgentChatPane.tsx:267,490`                                        | Apply the existing model setter's local-before-resume approach and show live-session failures.                                              |
| S06 | Tools' Prompt Library closes immediately after fire-and-forget sends; a dead PTY or failed Scout creation has no delivery/error recovery.                                                                                          | `src/stores/promptStore.ts:123`; `components/workspace/PromptLibrary.tsx:122`; mounted by `views/ToolsView.tsx:867`                 | Await delivery, retain the prompt/dialog on failure, and offer retry. The WorkspacePane send fix does not cover this path.                  |
| S07 | Deleting done/failed API conversations skips backend close, retaining their history/configuration until application exit.                                                                                                          | `src/stores/agentTaskStore.ts:1097`; `src-tauri/src/commands/api_agent.rs:204,1735,1739`                                            | Close every deleted API session; cancellation can remain conditional.                                                                       |
| S08 | Flight completion/error notifications bypass global and event-specific notification preferences.                                                                                                                                   | `src/lib/notifications.ts:92,106`; `stores/asyncAttemptTerminalListeners.ts:76`; `components/flights/AttemptTile.tsx:94`            | Reuse the ordinary session notification preference/debounce gate.                                                                           |

## Cleanup and promise drift

### C01 — Unreachable runtime-code candidates

A TypeScript import graph started at `src/main.tsx`, including reexports,
literal dynamic imports and conservatively even type-only edges. All 537
examined modules resolved their local imports. After excluding test helpers,
types, the unused barrel and intentionally dormant Remote Agents foundation,
**19 candidates total 3,260 physical lines**:

- Quality: `CodeQualityCheckPanel`, `AnsiText`, `CheckStatusBadge`,
  `QualityAIErrorActions`, `qualityStream` — 1,056 lines. Tracing the live module
  route confirmed the F06 integration gap. `QualityAIExplanation` is another
  runtime orphan, conservatively retained by the graph due to a type-only edge.
- Old session UI: `AgentChatPanel`, `ApprovalPrompt`, `DiffBlock`, `SessionInspect`.
- Other UI: `IssueDetailView`, `SpecImportModal`, `ConnectionProgress`, `Input`,
  `Popover`, and `useServerConnection`.
- Helpers: `agent-output-parser`, `env`, `errors`, `streamFallbackScheduler`.

Graph non-reachability is a cleanup lead, not proof that every file is safe to
delete. Check test-only consumers and retained compatibility purposes before
removal. The dormant fallback scheduler, for example, may have an intentional
history even though it contributes no live functionality. New abstractions and
large reorganizations are not justified by the line counts alone.

### C02 — Current documentation contradicts the code

The README says source 0.14.0 at line 7, advertises nine providers and the retired
PacketCode ACP engine at lines 67–70, omits Custom from its provider table,
says every API agent requires a key at line 137 despite keyless rows, and calls
the protocol v11 at line 216. Actual source is 0.14.7, eight provider rows,
retired `api-packetcode`, and protocol/floor 12. F06 identifies a separate
capability promise that the live UI does not fulfill.

The backlog's August sub-agent entry also says child tool membership, unsafe
grep symlinks and Auto-by-default remain open. Current source enforces child
membership, denies destructive child tools, skips grep symlinks and defaults
to `AskForRisky`. Those historical claims must not be recycled as fresh findings.
B01/B02 are narrower surviving authority gaps on different paths.

## What this audit does not classify as unfinished product behavior

- Input `placeholder` props are normal UI copy, not feature stubs.
- Echo providers, deterministic browser fixtures and acceptance-only SSH
  processes are deliberately isolated test mechanisms.
- Retired provider IDs and persisted Flight aliases protect existing data.
- Remote Agents explicitly identifies itself as a disabled Sprint 0 foundation;
  it is unfinished by design and must stay outside the no-expansion stabilization
  pass. It is not secretly a complete shipped remote-control product.
- Explicit unsupported remote operations and security refusals are legitimate
  boundaries when the UI states them honestly.
- Empty quality runs correctly reject rather than emitting successful completion.
- Main/child cancellation paths and child allowlist enforcement exist; this
  report does not repeat disproved suspicions about them.

## Evidence, coverage and test limitations

Ignored local evidence: `test-results/acceptance/code-audit-2026-09-24/` contains
`inventory.json`, `growth.json`, `import-graph.json`,
`approval-shortcut-repro.cjs` and `approval-shortcut-repro-results.json`.
Run the latter harness with Node. Exit zero confirms the old unsafe behavior;
it is not a passing safety regression. It uses the real transpiled hook with
minimal effect/window/layout shims, not native UI or a real PTY. Hidden-view
reachability was separately traced through production components.

Tests reviewed around these findings leave material gaps: prompt-store tests
cover CRUD rather than failed delivery; deletion tests cover active backend
cleanup rather than done/failed deletion; cost tests do not establish the
session-spend input; reviewer helper tests cover parsing/policy rather than
restart and failed authoritative persistence. The eleven quality gates passed
for the September 12 build, but were not rerun for this read-only source audit.

Coverage included Workspace focus/launch/Git, Agents handoffs, Flight attempt
actions, Monitor, Quality, representative Settings/Memory/GitHub/History paths,
backend command registration and selected provider/SSH/MCP/files/Flight paths,
stores, Remote Agents foundation and selected build/acceptance scripts. This is
a broad multi-team sweep, not line-by-line proof of every file, provider or OS.
External packet runtimes and separate documentation repositories were not audited.

## Stabilization order

1. Fix the six P1 authority/target/budget paths with failure-path regressions.
2. Fix state isolation, truthful completion/status, restart and persistence
   behavior (especially Workspaces/Git and reviewer gates).
3. Make existing configuration/features honestly usable or visibly unavailable;
   reconcile claims and retire confirmed abandoned code.
4. Dogfood the resulting installed build on ordinary work, retaining the paid
   Claude-test deferral. Do not expand the feature set or equate this static
   audit with full packaged/provider acceptance.
