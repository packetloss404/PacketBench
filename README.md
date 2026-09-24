# PacketBench

**A local-first desktop ADE (Agent Development Environment) for orchestrating AI software work.**

PacketBench is a Tauri v2 desktop app that brings AI coding agents, planning, issue tracking, memory, and workspace management into a single native environment. It is built for running real development workflows across multiple agent CLIs without leaving the app.

The latest recorded local build is **0.14.7**, with unsigned Windows NSIS/MSI
installers and source/artifact hashes in
[`dev/workspace-release-0.14.7.md`](./dev/workspace-release-0.14.7.md).
Source is undergoing stabilization of existing functionality; current findings
and acceptance gaps are tracked in [`backlog.md`](./backlog.md). Build checks,
installed-app checks and paid-provider acceptance have separate evidence—passing
one does not establish the others. Use [`HANDOFF.md`](./HANDOFF.md) for the
recorded installed version and [`CHANGELOG.md`](./CHANGELOG.md) for build history.

![PacketBench Workspace running Claude Code and PacketCode side by side](./docs/screenshots/workspace-claude-packetcode.png)

_An actual native PacketBench capture: PacketCode and Claude Code running their real TUIs side by side._

## Documentation Map

**Start here: [docs.ianlan.dev/packetbench](https://docs.ianlan.dev/packetbench/)** — 30 pages
covering every surface, a settings reference, an operations section, a deep
developer section, and an orientation briefing written for coding agents working
in this repository.

The documentation lives in its own repository,
[packetloss404/ianlan-docs](https://github.com/packetloss404/ianlan-docs), which
also serves the reports below. It moved out of this repo so that an unrelated
app commit no longer triggers a docs deploy. Edit the Markdown under `src/packetbench/`
there — not here, and never the generated HTML.

- [State of the ADE](https://docs.ianlan.dev/reports/state-of-the-ade-2026-07-30.md) — historical July/August assessment; use this repository's handoff and backlog for current state.
- [State of the ADE (PDF)](https://docs.ianlan.dev/reports/state-of-the-ade-2026-07-30.pdf) — identical paginated human edition.
- [Fable 5 review](https://docs.ianlan.dev/reports/fable5-review-2026-08-05.md) — the 2026-08-05 seven-team deep review and v1.0.0 plan (`.html` sibling is the human edition with screenshots).
- [`HANDOFF.md`](./HANDOFF.md) — exact restart point, completed decisions,
  current owner questions, build evidence, and guardrails.
- [`ROADMAP.md`](./ROADMAP.md) — current product direction and release path.
- [`backlog.md`](./backlog.md) — master ledger for outstanding work.
- [`dev/release-v0.10.3.md`](./dev/release-v0.10.3.md) — immutable tagged-source,
  gate, artifact, and hash record for `v0.10.3`. Still the newest annotated tag,
  but no longer current source; `CHANGELOG.md` records 0.11.0 through 0.13.2
  after it.
- [`dev/acceptance.md`](./dev/acceptance.md) — the packaged
  acceptance checklist. Sections 0, 1 and 2 have run against installed 0.13.2;
  sections 3–5 (dictation, analytics, Monitor) have not.
- [`dev/README.md`](./dev/README.md) — planning index, active implementation briefs, runbooks, and archive.
- [`dev/remoteagents/README.md`](./dev/remoteagents/README.md) — canonical Remote Agents plan.
- [`CHANGELOG.md`](./CHANGELOG.md) — shipped history only.
- [`marketing/`](./marketing/) — press-kit assets: one-pager PDF, hero poster, social banner, and the design-philosophy note.
- `AGENTS.md` / `CLAUDE.md` — local agent-facing repository instructions (generated and intentionally gitignored).

The main-shell/right-dock decisions, Workspace/Agents restructuring, and the
six-group Settings information architecture are implemented. The local-shell
feature is committed, packaged, and command-probed on Windows; remaining shell
work is the explicit interactive packaged matrix, MS4 responsive proof, and the smaller residue in
[`backlog.md`](./backlog.md). Remote Agents resumed on 2026-08-27 and completed
Sprint 0 on 2026-09-01 against the PacketBench-owned Rust `packet-relay`
service. The feature remains disabled and fail-closed; Sprint 1 and product auth
have not started. Auth direction is resolved in-house (passkey/magic-link on
PostgreSQL), and encrypted agent, approval, and file payloads remain a hard gate
before any external beta.

## What It Does

- Create and supervise structured conversations with eight API-agent provider rows
  in the first-class **Agents** surface — Claude Agent SDK/API, OpenAI
  API/Agents SDK, MiniMax, OpenRouter, local Ollama,
  and a configured OpenAI-compatible endpoint all normalize into one
  event contract
- Run PacketCode, Claude Code, Codex CLI, OpenCode, and plain shells in
  CLI-first **Workspaces** with persistent draggable mosaics
- See the effective raw-terminal shell in each pane header, and get a native
  Claude Code model/context/cost bar without installing a separate statusline
  script or changing global Claude settings
- Launch and supervise larger units of work from the **Flight Deck** — a single-screen master-detail flight control surface
- Track issues on a kanban board and send them directly to workspace sessions
- Connect to remote servers via SSH and run agent sessions over the wire
- Keep project context close with auto-learning memory, history, and git-host integration (GitHub + self-hosted Gitea/Forgejo)
- Manage MCP servers, inspect crashes, and run code-quality scans from the same UI

## Screenshots

### Agent command center

![PacketBench Agents view with the conversation sidebar and new-agent composer](./docs/reports/visual-audit-2026-07-30/04-agents-empty-1920.png)

| Flight planning and supervised launch                                                                                                                   | CLI clients and installation recovery                                                                                                               |
| ------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| ![PacketBench Flight launch dialog with planning and execution-supervision controls](./docs/reports/visual-audit-2026-07-30/13-modal-new-flight-1280.png) | ![PacketBench Workspaces and Terminal settings showing detected CLI clients](./docs/reports/visual-audit-2026-07-30/11-settings-cli-clients-1920.png) |

### Issue board

![PacketBench issue board with Flight, label, epic, workspace, and assignee filters](./docs/reports/visual-audit-2026-07-30/05-issues-board-1920.png)

> **Note:** These captures are from the 2026-07-30 visual audit and therefore
> **predate the 2026-08-26 rename** — they carry the previous product name and
> do not show anything built since, including the reworked Memory pane and the
> dictation analytics tab. They are kept because the layouts are still
> representative; treat the branding and any specific copy as out of date.

These captures show the rendered UI using PacketBench's deterministic
web-mode fixture. The full viewport set, method, and environment limitations
are documented in the
[`2026-07-30 visual audit`](./docs/reports/visual-audit-2026-07-30/findings.md).

## Supported Agents

PacketBench connects two complementary execution styles.

**PTY-backed CLI sessions** — launched in a workspace pane and driven by the CLI's own UI:

- Claude Code
- OpenAI Codex CLI
- OpenCode
- PacketCode
- Plain terminal

> Gemini CLI support was removed on 2026-07-30. Saved workspace panes that
> referenced it reopen as plain terminal sessions; no data is lost.

**GUI/API agents in the Agents view** — durable structured conversations with
streaming, tool calls, permission gating, plans, review, Memory, and worktree
endings:

| Row                     | Internal id         | Auth                                     |
| ----------------------- | ------------------- | ---------------------------------------- |
| Claude Agent SDK (API)  | `api-claude-oauth`  | Anthropic API key in OS keyring          |
| Claude (API)            | `api-claude`        | Anthropic API key in OS keyring          |
| OpenAI (API)            | `api-openai`        | `OPENAI_API_KEY` in OS keyring           |
| OpenAI Agents SDK (API) | `api-openai-agents` | `OPENAI_API_KEY` in OS keyring           |
| MiniMax (Token Plan)    | `api-minimax`       | API key in OS keyring                    |
| OpenRouter              | `api-openrouter`    | API key in OS keyring                    |
| Ollama (Local)          | `api-ollama`        | none — local daemon at `localhost:11434` |
| Custom endpoint        | `api-custom`        | optional API key; configured OpenAI-compatible URL |

**Hosted provider rows use API keys.** Ollama is keyless, and Custom endpoints
can be configured without a key. PacketBench does not offer
Claude.ai or ChatGPT subscription login for API agents — Anthropic's
[legal and compliance policy](https://code.claude.com/docs/en/legal-and-compliance)
states that it "does not permit third-party developers to offer Claude.ai login
or to route requests through Free, Pro, or Max plan credentials on behalf of
their users", and the Agent SDK overview directs developers to use API key
authentication instead. Terminal CLI sessions (`claude`, `codex`) are ordinary
end-user use of those tools and keep their own subscription logins; see
Settings → AI Providers → Subscriptions.

`api-claude-oauth` is a historical internal id, not an OAuth row: it is the
Claude Agent SDK running in the Node sidecar on the `api-key-anthropic` keyring
entry. It is kept as-is so persisted conversations continue to resolve. It is
the row to pick when you want Claude Code's own agent harness — the targeted
edit tool, structured plan blocks, real permission modes, and `~/.claude`
settings sourcing — rather than the leaner in-process `api-claude` runtime.

Auth status is probed live and shown as a badge next to each row (`ready` / `missing_key` / `service_down`; the same probe also returns `login_required` / `coming_soon` for the PTY CLI launch gate). Most API-key providers run in-process in Rust; the Claude Agent SDK and OpenAI Agents SDK providers run in the Node sidecar. Each session can be launched with agent-specific arguments and model selections exposed through the UI.

> The `api-openai-codex` row (OpenAI ChatGPT Plus/Pro via `codex exec`) was
> removed on 2026-07-31. Existing conversations on it still open and read
> normally; they are marked read-only and point you at OpenAI Agents SDK (API),
> which reaches the same models with your OpenAI API key. All providers now
> support interactive per-tool approvals.

## Main Features

### Agents — Unified Delegated Work

**Agents** owns new GUI-agent creation, the cross-project conversation and
attention list, one large active conversation, and its inspector. Every
provider shares one composer, two interchangeable backends (in-process Rust +
Node sidecar), and one event contract. When writes stack up, the
**ReviewBar** opens the canonical **ReviewSurface**; when work settles, the
explicit Git handoff opens the authoritative **WorktreeLifecycleBar** for the
same conversation and worktree.

Workspace conversation panes remain load-compatible for saved layouts. They
reference the same durable conversation ID, but PacketBench no longer exposes any
action or API that creates a new one. Normal creation, project/Git/Flight
handoffs, and deep links never materialize wrapper Workspaces.

- **Conversation context**: model, reported token/context usage, provider auth and project/Git context; availability depends on the provider's reported metadata
- **Drag-drop and clipboard-paste images** into the launcher (5 MB cap, removable thumbnail chips); image blocks land in the SDK content array on send
- **Keyboard**: `Ctrl+K` opens the app-wide **command palette** (search and navigate everything — the primary navigation affordance); `Shift+Tab` cycles a single mode chip (`default | plan | manual | yolo`); `Ctrl/Cmd+N` starts a new Agent while in Agents and a new empty Workspace elsewhere; `Ctrl+Shift+1` jumps to Agents, `Ctrl+Shift+W` jumps to Workspace, and `Ctrl+Shift+O` cycles the transcript view mode. Route chords match on physical key, so they survive non-QWERTY layouts. Bare `Tab` is unbound in the composer (it only picks a highlighted popover row when one is open)
- **Slash commands**: `/plan /permissions /model /compact /review /history /clear /new /help` plus saved prompt templates as native `/<slug>` commands and project skills
- **`@`-mention files and sources** in the composer via a file-mention popover, so you can pull specific files into a turn without pasting paths
- **Header context badges**: provider auth (live `provider-auth:changed`) and linked Flight with click-to-jump. MCP defaults are configured in Settings; the conversation context strip displays reported MCP sources and discovery errors. A separate **memory toggle** in the header overflow menu previews the injected memory context
- **Persistent Plan / Todo panel** docked above the chat scroll, parsing Anthropic SDK `TodoWrite` (structured `plan_block` events) plus the markdown `task_list` tool with a fallback parser
- **Per-hunk diff acceptance** in `PendingEditPrompt`: pick which hunks to accept, the merged content lands via `edit_response.mergedContent` (sidecar Anthropic + every in-process provider)
- **Batch approvals**: when 2+ writes or permissions stack up, "Apply all / Reject all / Cancel pending" rollups appear; "Cancel pending" drains parked prompts as denied without killing the agent loop
- **Reviewer subagent**: `/review` spawns a fresh read-only conversation seeded with a unified diff of pending writes; returns 🛑 Blockers / ⚠️ Concerns / 💡 Nits with file:line citations
- **Plan-first mode**: launching with the Plan posture keeps the model read-only until it proposes a plan; the plan is approved inline in the transcript (structured `TodoWrite`) and approving lifts plan-mode so execution runs
- **Inline Restore**: rewind the thread to an earlier point directly from the transcript (Claude-Code-style rewind), with no separate checkpoint panel
- **Side Chat overlay**: a floating ask-a-side-question panel that streams an answer without disturbing the main thread
- **Explicit handoffs**: open the project folder in the OS, open the same
  **project** in Workspace (never the conversation), attach a separate
  terminal, open the authoritative Git ending, link one durable conversation
  reference to a Flight, or continue in an external editor/CLI
- **Send to Monitor**: route a conversation to a separate Rust-restricted
  read-only operations window without duplicating its session or exposing
  composer/approval controls
- **Durable agent profiles** (Default, Scout, Reviewer built-ins, plus user-created): bundle system prompt + allowed tools + memory + permission posture; pick from the launcher dropdown or edit in `Settings → Agents & Models → Agent behavior`
- **AGENTS.md / CLAUDE.md auto-injection** from project root into the system prompt at session start
- **Auto-failover on rate-limit**: 429 / quota / overload errors trigger a same-provider fallback (Opus → Sonnet → Haiku, o3 → gpt-5.5 → o4-mini, MiniMax → highspeed) before surfacing the failure
- **Worktree-per-conversation** (opt-in toggle, local projects): provisions `.pkt-worktrees/<convId>` on a fresh `pkt/<convId>` branch so the conversation's tool calls don't touch the main checkout
- **Backgroundable agent tray** in the toolbar showing a live count of streaming agents with click-to-jump and stop
- **Hover-`+` Codex-App-style diff comments**: per-line `+` button in the diff view opens an inline composer; queued comments fold into the next user turn as a `File comments:` preamble
- **Composer-mode segmented control** (Local / Worktree) at "send" time picks where the conversation runs — Local edits the project tree, Worktree runs on a fresh branch in `.pkt-worktrees/`; the choice also sets the global default
- **Right dock** — one resizable column (260–720 px, 340 px default, persisted per surface and clamped against the live viewport) showing one panel at a time. Agents docks Inspector / Plan / Preview / Diff / Files / Editor; Workspace docks Editor / Git. Nothing else in the shell renders a fixed-width right panel
- **Smart-approval prefix proposals**: permission prompts compute a sensible allowlist rule (e.g. `Bash(git push:*)`) and let you accept it with one click — closes the "approval fatigue" footgun
- **Cross-tool unified Project Rules editor** in `Settings → Workspaces & Terminal → Project Rules` reads + writes both `AGENTS.md` and `CLAUDE.md` on save so a single rule set works for both Claude Code and Codex
- **Plan-with-Claude → Execute-with-OpenAI** one-click handoff: PlanPanel "Hand off to OpenAI" button spawns a fresh OpenAI Agents SDK conversation seeded with the distilled spec + plan; "← back to plan" link in the child's chat header
- **Old-model pinning** per profile via the `pinnedModel` field — locks a known-good model so future provider auto-upgrades don't silently switch away
- **Auto-resume across restarts**: hydrated conversations capture the provider's resume token and lazily re-establish the session on next send
- **Onboarding overlay** on first visit explaining the core affordances; one-time, persisted in localStorage

### Sidecar Protocol

The Claude Agent SDK and OpenAI Agents SDK providers run in a Node sidecar that emits a normalized `api-agent:*` event vocabulary the frontend listens to (the same shape the in-process Rust providers emit). PROTOCOL_VERSION and the minimum accepted sidecar version are **12**:

- Events: `ready` (handshake), `chunk`, `thinking`, `thinking_stop`, `tool_start`, `tool_result`, `permission_request` (with optional `batchId`/`batchSize`), `pending_edit`, `done` (with optional `resumeToken` and v10 `cancelled` marker), `error`, `plan_block`, `tool_output_extended` (Bash exit code + stdout/stderr; Write/Edit modified paths), `turn_summary` (running tokens between turns), and `rate_limited` (v6, typed provider quota-pause)
- Requests: `start_session` (with image attachments, resume, frozen MCP trust snapshots and v12 execution-host project trust), `send_message`, `permission_response`, `edit_response` (v9-correlated by required `toolUseId`, with optional `mergedContent` for per-hunk acceptance), `cancel`, `close_session`, `set_permission_mode`, `set_model`, `retry`, `cancel_pending_tools`, `inject_user_turn` (v5)

### Workspaces — Terminal CLI Command Center

- Multi-pane terminal workflow built on `xterm.js` and `portable-pty` with a draggable mosaic tiling layout
- New Workspace templates and **Add Session** expose terminal/CLI sessions
  only; detected PacketCode is the recommended/default session, with a typed
  Settings recovery path when it is missing
- Saved layouts hydrate dormant: Welcome launches no hidden CLIs, and only the
  selected Workspace starts its panes. Once running, those PTYs survive normal
  navigation to Agents, Flights, and other views
- Local **Terminal** panes can use Auto-detect, PowerShell 7, Windows
  PowerShell, Command Prompt, Git Bash, WSL, Bash, Zsh, or an allowlisted
  custom shell. Configure the app default and active-Workspace override in
  `Settings → Workspaces & Terminal → Workspace defaults`, or choose a
  per-session override from **Add Session**. Precedence is session → Workspace
  → app default → Auto; leaving everything unset preserves the historical
  PowerShell-on-Windows/Bash-on-macOS-or-Linux launch exactly
- Shell selection applies only to new or restarted local Terminal panes.
  Dedicated Claude Code, Codex, OpenCode, and PacketCode panes keep their own
  launch commands; SSH Terminal panes use the remote host's login shell
- Live status bars for supported agent CLIs
- Per-pane model and effort overrides, bypass-permissions toggles
- PacketCode integration with strict version detection, bounded `doctor --json`
  health, separate executable/developer-checkout/data-home settings, explicit
  stable/preview install actions, and isolated local/SSH `PACKETCODE_HOME`.
  Local Workspace panes resolve one launch identity before spawning, show the
  exact binary/version/effective home, and block invalid data-home overrides.
  Install/update actions verify the official target afterward and report both
  the version change and whether Workspace will launch that exact file.
- Pane layout presets (1×1, 1×2, 2×1, 2×2, 2×3, 3×2) live in the main toolbar when a workspace is active
- **Delegate** opens the Agents launcher on the exact local or SSH project;
  explicit Agent handoffs can return to the same target without cloning a
  conversation, approval queue, review, or worktree

### Flight Deck — Flight Control

- Single-screen master-detail layout: a status-grouped flight list on the left, the selected flight's flight control on the right
- **Plan first** starts a normal read-only agent conversation against the selected target; refine the plan in chat, then apply its latest structured milestones/tasks to the Flight before launching attempts
- Launch one or more local or SSH agents against isolated worktrees, choosing the provider, model, base path, and branch per target
- **Attention** grouping automatically surfaces paused, failed, and approval-needed Flights; active path collisions and unpinned SSH targets are blocked before launch
- Optional **Reviewer Gate** starts one read-only reviewer, enforces its
  structured verdict, and records any explicit human override
- Optional **Cooperative Flight graph** validates task dependencies/ownership,
  launches user-selected ready batches, and serializes accepted work onto an
  isolated Flight integration branch
- A persisted **Coordination Inbox** supports scoped steering, acknowledgements,
  safe API delivery, and opt-in MCP reads/writes for PTY agents
- **YOLO Mode** is an explicit bounded overlay—not the default—with independent
  recovery/review/graph/routing switches, cost/time/retry/concurrency/root
  limits, action history, and Pause/Resume/Stop
- Each Attempt tile streams the agent conversation, accepts follow-up turns,
  exposes review/complete/reject/cancel controls, and can open that same
  attempt in Workspace or a read-only Monitor; terminal status, tokens, cost,
  and coordination events persist on the Flight
- Optional local draft-PR publishing pushes the Attempt branch before worktree cleanup, while SSH worktree cleanup is resolved through the saved Server configuration
- Optional **Issue ↔ Flight mirroring** publishes one host issue per task under
  a Flight-named GitHub/Gitea milestone, then reconciles title/state/milestone
  changes with hidden identity markers, revision fences, and visible conflicts
- **Send to Monitor** opens or reroutes one read-only Agent/Flight Monitor
  window; all mutations stay in the main cockpit
- **Deploy & keep running in PacketAgent** validates a frozen W9 WorkerPackage,
  activates a durable external worker, persists its event cursor, and exposes
  inspect/pause/resume/revoke/evidence controls. PacketAgent remains a separate
  runtime and owns execution after PacketBench closes
- Planning is intentionally upfront and user-applied: it does not restore the former autonomous Flight Planner FSM, journal, wake loop, or task scheduler; legacy planner fields remain load-compatible
- Kanban issue tracking with priorities, labels, acceptance criteria, and flight linkage

### SSH Remote Workspaces

- Add and manage remote servers with SSH agent, key, or password authentication
- Detect installed agent CLIs and create workspaces that run agent sessions over SSH on remote machines
- Optionally clone a git repo into the remote path when creating a workspace
- Remote git dashboard with per-file diffs (symlink-confined), staging, commit, and push — with an actionable message on a non-fast-forward push
- Optional SSH password storage in the OS keyring (under `ssh-<server-id>`); otherwise prompted at connect time and held in memory only. Host-key pinning is enforced when a server's fingerprint is known, with a TOFU `accept-new` fallback for interactive PTY connections

### Issues — Work on This Issue

- Kanban board with drag-and-drop columns: Backlog, Up Next, To Do, In Progress, In Review, QA, Done, Blocked, Needs Human
- Click "Work on this issue" to send the issue prompt to an existing workspace session
- Or create a new workspace named after the project with the issue pre-loaded
- Acceptance criteria, dependency graphs, flight assignment, labels, and priorities

### Memory — Auto-Learning System

- Records every terminal session longer than ten seconds, however it ends, and
  every settled Flight. The event is written **before** any summarization, so
  the timeline fills in even with no AI provider configured — the summary is an
  enrichment, not a precondition.
- Summarization and pattern extraction route through the aux-LLM seam, so they
  use whichever provider you have configured rather than a fixed vendor.
- Learned patterns with confidence scores and categories (architecture, convention, preference, pitfall)
- Live context injection into sessions (patterns + lessons + recent summaries +
  project notes), behind a visible toggle that previews exactly what will be sent
- Scope is derived from the active workspace, so a remote SSH workspace keeps its
  own memory and neither side leaks into the other
- A **Project notes** source stores ordinary Markdown plus schema-v1 YAML
  frontmatter under `.agents/memory`. Notes have stable IDs, optimistic
  revisions, links/backlinks, broken-link/orphan health, provenance references,
  search, and safe external-editor reload/conflict handling.
- **Ask** searches the entire corpus — every pattern regardless of confidence,
  every event regardless of age, saved notes and project notes — with no recency
  window and no character budget, and reports what it searched so an empty
  answer is legible. It is deliberately a **separate** path from prompt
  injection: widening what search can find must never widen what reaches an
  agent, and tests pin that separation.
- Project notes are plain Markdown. A file with no YAML frontmatter is a valid
  note, taking its title from the first heading.
- Project notes are normal project files and are version-control-capable by
  default. PacketBench never edits `.gitignore`; teams decide whether to track
  `.agents/memory`.
- PacketBench's loopback MCP provider exposes bounded project-note
  search/read/create/update/archive operations. Mutations require the provider's
  explicit `allow writes` setting and the same project confinement/revision
  checks as the UI.

### Dictation — Voice-to-Text

- Local Whisper transcription (no audio leaves the machine); verified model, stable audio device, microphone doctor, recording limit, language, and custom dictionary configurable from `Settings → Integrations & Data → Dictation`
- Explicitly opt-in OS-level global shortcuts via `tauri-plugin-global-shortcut` so the hotkeys work even when PacketBench is not the focused application:
  - `Ctrl+Alt+Space` (hold) — push-to-talk; records while held, transcribes on release (rebindable; `Cmd+Alt+Space` on macOS)
  - `Ctrl+Alt+R` — toggle recording on/off (rebindable; `Cmd+Alt+R` on macOS)
  - `Ctrl+Shift+D` — open the Dictation view
  - `Escape` — cancel an active recording
- **Focus-aware insertion**: inserts into safe React inputs, textareas, contenteditable editors, and live PacketBench terminals (through the PTY API). Password, one-time-code, explicitly sensitive, stale, and disconnected targets are excluded.
- **External delivery** copies to the native Windows clipboard when no PacketBench input is tracked, with an opt-in foreground-app paste mode. The transcript remains visible and on the clipboard if OS injection is blocked.
- Live `REC` indicator in the status strip, 32-bar waveform, automatic history capture/search, and an analytics dashboard (WPM, sentiment trend, top words, daily streak, time saved estimate)

### Trust and Provenance

- Web, MCP, local/remote workspace, imported attachment, memory, agent, and
  generated evidence use one schema-v1 origin/authority/integrity/lineage
  envelope. Legacy records load as `unknown`; they are never silently promoted
  to trusted intent.
- Tool cards, permission prompts, Memory records, reviewer reports, Flight
  coordination records, and derived artifacts retain compact source chips or
  parent links without persisting raw attachment payloads or secret-bearing
  locators.
- A risky action after external or unknown evidence reuses the existing
  permission boundary even under broad autonomy settings. Credential,
  protected-publish, conflict, reviewer, and workspace-root floors remain
  explicit.
- Trust decisions are kept in a redacted, bounded local audit (200 entries,
  configurable 7/30-day retention) with JSON export and clear controls.

### Code Quality

- Language, complexity, and test breakdowns with per-category scores, donut
  charts, and an Overview / Complexity / Languages / Tests tab layout
- Auto-detected per-project checks (lint, typecheck, tests, cargo, ruff) report
  aggregate completed-check results, with cancellation for the active run
- Streamed AI run summaries and persisted code-metrics snapshots. The current
  view does not expose raw ANSI check output, per-finding explanations or
  persisted execution-run history
- One-click **auto-fix** with its own review panel, backed by a dedicated Rust
  command family (`quality_runner.rs`, `code_quality_autofix.rs`)

### Git Host Integration (GitHub + Gitea/Forgejo)

- Cloud **GitHub** and self-hosted **Gitea/Forgejo** — both configurable at once; a workspace uses whichever host its `origin` remote belongs to, and the pane's icon/label follow that host
- PAT or GitHub OAuth **device-flow** authentication, persisted in the OS keyring per connection (no re-prompt after restart)
- Repository listing and selection
- Issue browsing with search, labels, and import-to-board
- Pull request browsing with diff viewer, inline review comments, reviews, merge, and draft/label/reviewer actions
- Releases view and a notifications inbox (with background polling for a live badge)
- AI investigation of issues via Claude (GitHub only)

### Budget guardrails & History

- Spend caps that actually stop work: daily, monthly, per-session, per-provider,
  and per-Flight limits with a warning threshold and a hard stop that blocks a
  launch over budget, configured in `Settings → Automation → Flights & Autonomy`
- Bounded-autonomy Flights carry their own cost ceiling and halt when they reach it
- A History view for browsing prior session activity

> PacketBench deliberately ships **no cost reporting surface** — no dashboard, no
> spend chip, no per-turn dollar figures. Cost is measured and used to enforce
> budgets; it is not reported back to you. Token counts are still shown per turn
> and per session.

### Project Operations

- Settings uses six searchable root groups—**General**, **Workspaces &
  Terminal**, **Agents & Models**, **Automation**, **Integrations & Data**, and
  **Security & Diagnostics**—with focused sub-tabs and explicit App, Project,
  Workspace, new-session, new-conversation, or new-Flight scope badges.
- A unified **Local-first MCP Hub** in `Settings → Integrations & Data → MCP` combines the existing
  client/server editor and PacketBench provider with search, a review-before-add
  official starter catalog, stdio capability diagnostics, per-workspace
  read/write/network/root/tool trust, bounded activity, and an explicit selected
  conversation reconnect.
- MCP trust is frozen into each PacketBench-managed MCP session. Later settings
  edits cannot silently broaden it; old sessions migrate to conservative
  read-only authority. Non-overridable floors block credentials,
  outside-workspace paths, and protected publish/merge/deploy tools. A local
  stdio child is not an OS network sandbox, so its own package/runtime
  configuration still matters. The API-key-backed Claude Agent SDK and OpenAI
  Agents SDK providers, plus the in-process providers, enforce the frozen
  snapshot. The retired Codex chat-provider trust proxy is not part of the
  current runtime.
- Local Claude (API), OpenAI (API), MiniMax, OpenRouter, Ollama and Custom
  conversations resolve global and trusted project MCP configuration, including
  stdio, Streamable HTTP and legacy SSE servers. Each session retains its
  resolved configuration, tool mapping and trust permissions; project overrides
  cannot fall back to a same-named global server. URL-based servers require
  network permission. Static request headers are supported; interactive OAuth
  is not provided by this native runtime. MCP on an SSH execution host uses the
  SDK-backed providers. Native SSH conversations must explicitly deselect MCP;
  they never run a desktop server in place of a remote one.
- PacketBench's loopback provider organizes scoped resources for Flights, Issues,
  coordination, review, global/project Memory, workspaces, and PacketCode
  integration health. It remains loopback-only with bearer/origin controls;
  there is no hosted PacketMCP service.
- Local crash report browsing and cleanup
- Agent profile management and **auxiliary-LLM routing**: per-task-class
  provider/model selection so background AI work (naming, summaries, insights)
  can run on a cheaper or local model than the primary agents
- **Custom provider endpoints** for OpenAI-compatible hosts you run yourself
- **Multi-account CLI logins**: named per-CLI accounts (separate
  `CLAUDE_CONFIG_DIR` / `CODEX_HOME` homes) with a per-session picker, so work
  and personal subscriptions never collide
- **Light/dark theme switching** in `Settings → General → Preferences`
- Prompt template library
- Local Whisper dictation with OS-global hotkeys and focus-aware transcript insertion (see [Dictation](#dictation--voice-to-text))

## Tech Stack

| Layer    | Technology                   |
| -------- | ---------------------------- |
| Desktop  | Tauri v2                     |
| Frontend | React 19 + TypeScript + Vite |
| State    | Zustand                      |
| Styling  | Tailwind CSS                 |
| Terminal | xterm.js + portable-pty      |
| Backend  | Rust                         |
| Markdown | react-markdown + remark-gfm  |
| Icons    | lucide-react                 |
| Testing  | Vitest + Playwright          |

## Getting Started

### Prerequisites

- Node.js (the bundled sidecar runtime is pinned to **24.15.0**; use a recent LTS for development)
- `pnpm` (repo pins `pnpm@9.15.4` via `packageManager`)
- Rust stable toolchain
- One or more supported agent CLIs installed and available on `PATH`

Examples:

- Claude Code for Claude sessions
- Codex CLI for Codex sessions
- OpenCode for OpenCode sessions

### Install

```bash
git clone git@github.com:packetloss404/PacketBench.git
cd PacketBench
pnpm install
```

### Agent Sidecar

PacketBench ships with a Node.js sidecar that powers the Claude Agent SDK (API) and OpenAI Agents SDK (API) providers.

- `pnpm install` at the repo root also installs the sidecar's dependencies automatically via a `postinstall` hook (idempotent; adds a few seconds to the first install).
- Before using a sidecar provider for the first time, compile the sidecar once:

  ```bash
  pnpm sidecar:build
  ```

- For a full-fidelity local build that compiles both the sidecar and the Vite app in order, use:

  ```bash
  pnpm build:all
  ```

- To point the app at a custom sidecar entry point (e.g. when running from a different working copy), set `PACKETBENCH_SIDECAR_PATH` to the absolute path of the compiled entry file before launching PacketBench. `PACKETBENCH_NODE_PATH` similarly overrides the Node binary used to launch it.

`pnpm build:all` still works for a full local build. For **production bundling**, `pnpm tauri build` now auto-runs the `prebundle` chain (`fetch-node` → `sidecar:install` → `sidecar:build` → `sidecar:prune`) via Tauri's `beforeBuildCommand`, so no manual sidecar or Node setup is needed. A pinned Node 24.15.0 runtime is fetched as a Tauri `externalBin`, and the sidecar ships with a pruned production `node_modules`. Reference sizes from the v0.10.3 Windows build: NSIS installer 84.68 MiB, MSI installer 132.19 MiB (both are produced because `bundle.targets` is `"all"`), standalone `packetbench.exe` 43.81 MiB. The prune step removes the sidecar's devDependencies; run `pnpm sidecar:install` afterward to restore them for further sidecar development.

#### Sidecar status

The sidecar work is complete across the original four v2 tiers and the v3–v11 protocol additions that power the unified conversation tiles:

- **v2 Tier 1 — Bundling:** pinned Node 24.15.0 runtime fetched as a Tauri `externalBin`, sidecar resources bundled with pruned production `node_modules`, `prebundle` chain wired into `tauri build`.
- **v2 Tier 2 — Lifecycle & auth:** sidecar version handshake on startup, toolbar status chip reflecting live sidecar state, credential expiry parsing for the Claude / Codex CLI subscription tokens that gate terminal sessions, and a filesystem watcher that re-reads auth when cred files change on disk.
- **v2 Tier 3 — Protocol & UX:** `pending_edit` diff preview for Claude Agent SDK turns and command forwarding (`set_permission_mode`, `set_model`, `retry`) through a versioned protocol.
- **v2 Tier 4 — Observability & updates:** sidecar lifetime stats (uptime, restart count, last-exit reason), per-provider launch counters surfaced to the UI, and a documented Tauri auto-updater setup.
- **Refresh-token aware expiry:** `provider_auth` now treats expired access tokens as `ready` when a refresh token is present, avoiding spurious "please log in" prompts for subscription users whose SDK / CLI would have refreshed on next use anyway.
- **v3 — Protocol additions for the Agents pane:** typed image attachments on `start_session` / `send_message`; `mergedContent` on `edit_response` (per-hunk acceptance); `batchId`/`batchSize` on `permission_request`; `resumeToken` on `done`; new `plan_block` event mirroring `TodoWrite`; `tool_output_extended` event with Bash exit code + stdout/stderr + Write/Edit modified paths; `turn_summary` event for live mid-stream token totals.
- **v4 — `cancel_pending_tools`:** drains parked permission/edit prompts as denied without aborting the SDK query, so the model receives synthetic "User cancelled this tool" results and the loop continues.
- **v5 — `inject_user_turn`:** injects a user/wake-trigger turn into a long-lived session; originally paired with a Flight Planner `planner_tool` / `planner_tool_result` MCP round-trip that v7 removed (see below).
- **v6 — typed `rate_limited` event:** surfaces provider quota pauses as a typed event instead of an opaque error.
- **v7 — planner amputation (2026-07-11):** the entire in-process Flight Planner MCP surface — the `planner_tool` event, the `planner_tool_result` request, and the sidecar's `mcpKind:"planner"` construction branch — was deleted along with the Rust `flight_planner` command family (~13,300 net lines removed). The live executor money path (`flight_for_executor_session` / `accumulate_executor_cost`) was extracted first into `commands/flight_cost.rs` and is unaffected. See [`backlog.md`](./backlog.md#flight-deck).
- **v8 — remote-owned MCP over SSH:** a remote sidecar loads its own `~/.claude/settings.json` and project `.mcp.json`, runs both stdio and network MCP servers on the remote host, and reports a secrets-free `mcp_sources` summary to the conversation.
- **v9 — targeted edit responses:** `edit_response` carries a required `toolUseId`; Anthropic and OpenAI Agents resolve only that pending edit, preserving unrelated approvals in the same session.
- **v10 — explicit `cancelled` terminal marker:** the `done` event carries a `cancelled` flag so a user-cancelled turn is distinguished from a natural completion, giving the frontend exactly-once cancelled-terminal semantics across idle / active / post-completion cancels.
- **v11 — frozen MCP trust authority:** PacketBench-managed MCP servers receive a
  per-session read/write/network/root/tool snapshot with conservative legacy
  migration and non-overridable denial floors. The API-key-backed Claude Agent
  SDK and OpenAI Agents SDK providers, plus the in-process providers, enforce it
  directly. The former Codex chat-provider proxy was removed with that provider.
- **Retired Codex adapter compatibility:** historical Codex `todo_list`, token,
  and sub-agent-address events remain readable in saved conversation and cost
  data, but no current API-agent row launches `codex exec`.
- **OpenAI Agents SDK provider:** `api-openai-agents` runs in the sidecar with
  the same OpenAI API key as `api-openai`, preserving the existing Agents pane
  event contract alongside the stable Rust OpenAI API provider. The default
  `auto` mode requires approval before `bash` / `write_file`.
- **Standalone exe sidecar fix:** the Tauri shell plugin on Windows resolves `app.shell().sidecar("node")` to `<exe_dir>/node-<target-triple>.exe`, and the call is gated by an explicit `shell:allow-execute` capability entry. `build.rs` now copies `binaries/node-<triple>.<ext>` into the cargo output directory at compile time, and `capabilities/default.json` grants the `node` sidecar entry — so running `target/<profile>/packetbench.exe` directly (without installing the MSI/NSIS) no longer reports the sidecar as down.
- See [`agent-sidecar/README.md`](./agent-sidecar/README.md) for sidecar internals and [`dev/updater-setup.md`](./dev/updater-setup.md) for signing / release channel configuration.

### Multi-platform builds

PacketBench is developed on Windows but is designed to ship on macOS and Linux as well. For per-platform prerequisites, supported target triples, and cross-compilation notes, see [`dev/multi-platform-build.md`](./dev/multi-platform-build.md). Builds and releases are produced locally — there is no GitHub Actions CI in this repo.

### Beta Distribution Status

**Nothing current is published.** The newest build on GitHub Releases is
`v0.5.0` from May 2026, and its installers still carry the previous `PacketADE`
product name. Unsigned Windows NSIS and MSI artifacts exist locally for 0.11.0,
0.12.0, 0.12.1 and 0.13.0 but have not been uploaded, and no packaged install has
completed the acceptance matrix. Building from source is the only way to run
current PacketBench.

Windows Authenticode signing, macOS Developer ID signing/notarization, and the
Tauri v2 auto-updater are planned release-trust gates and are not enabled in the
repo today. Until those credentials and updater manifests exist, any fresh
download will raise SmartScreen or Gatekeeper warnings.

The source tag and application version move together. Local release gates are
explicit: run `pnpm lint`, `pnpm test`, `pnpm build`,
`cargo check --manifest-path src-tauri/Cargo.toml`, and `pnpm tauri build`
before publishing an installer. The updater setup runbook lives in
[`dev/updater-setup.md`](./dev/updater-setup.md).

### Run The Desktop App

```bash
pnpm tauri dev
```

### Build

```bash
pnpm tauri build
```

Build artifacts are written under the active Cargo target directory in
`release/` and `release/bundle/` (normally `src-tauri/target`; this repository's
Windows release workstation redirects it to `packetbench-build`).

### Quality Checks

The two composite ladders are the real gates — run these before claiming green:

```bash
pnpm preflight       # format check + lint + unit tests + web build
pnpm check           # preflight + e2e + sidecar:check + Tauri schema + Rust check/tests
pnpm sidecar:check   # 14 chained sidecar build/protocol/provider smoke gates
```

The documentation site is no longer built from this repository. It lives in
[packetloss404/ianlan-docs](https://github.com/packetloss404/ianlan-docs) and
deploys itself.

Individual rungs are also available directly:

```bash
pnpm lint
pnpm test
pnpm build
pnpm e2e
pnpm check:tauri-schema
pnpm rust:test
```

Release builds additionally use `pnpm release:gate` (bundling correctness,
strict mode adds clean-tree/signing checks) and `pnpm release:readiness`
(environment/credential probes).

### Rust Checks

```bash
cargo check --manifest-path src-tauri/Cargo.toml
```

### Windows Note

If Tauri builds cannot find the Rust toolchain, ensure the Rust binary path is on `PATH`.

Example:

```bash
set PATH=C:\Users\ianwalmsley\.rustup\toolchains\stable-x86_64-pc-windows-msvc\bin;%PATH%
```

## Project Layout

```text
PacketBench/
  src/
    App.tsx                    # Root app shell and view routing
    components/
      layout/                  # Title bar, toolbar, mosaic tiling, status bar, left rail
      session/                 # Terminal panes, session modals, status bars, inspect UI
      issues/                  # Kanban issue board and issue detail UI
      flights/                 # Flight Deck attempts (LaunchAsyncFlightModal, AsyncFlightGrid, AttemptTile)
      views/                   # First-class views (AgentsView, WorkspaceView, FlightsView, GitHubView, …)
      editor/                  # Lightweight editor/diff support
      workspace/               # CLI-first Workspace: AddSessionPicker, mosaic, compatibility ConversationTile, GitDashboard
      agents/                  # Agent-first conversation UI, handoffs, composer, inspector, review and diff surfaces
      servers/                 # SSH server form modal
      common/                  # Shared presentation components
      ui/                      # Shared UI primitives
    stores/                    # Zustand stores for app, layout, flights, issues, workspaces, etc.
    modules/                   # Module registration: quality, dictation
    lib/                       # Tauri bindings, shared utilities, model lists, event helpers
    generated/                 # Generated TypeScript types (Rust ↔ TS DTO contract)
    hooks/                     # UI and agent interaction hooks
    types/                     # Shared TypeScript types

  src-tauri/
    src/
      lib.rs                   # Tauri app bootstrap and command registration
      commands/                # Tauri commands exposed to the frontend
      api/                     # DTO layer that decouples internal Rust types from the TS contract
      core/                    # Orchestration engine, storage, workspace, PTY core
      claude/                  # Claude CLI integration helpers
      session/                 # Session DTOs and shared session helpers

  agent-sidecar/               # Node sidecar for API-key-backed Agent SDK providers
  scripts/                     # Build, sidecar, schema-check, and bundling scripts
  e2e/                         # Playwright tests
  public/                      # Static frontend assets

  (documentation now lives in packetloss404/ianlan-docs)
```

## Contributor Notes

- Core views are declared in `src/stores/appStore.ts`
- Tauri commands live in `src-tauri/src/commands/` and are bound in `src/lib/tauri.ts`
- App modules are registered through `src/modules/registry.ts`; current modules are Code Quality and Dictation
- Session management is PTY-based rather than JSONL-session based
- GitHub PAT is stored in the OS keyring via the `keyring` crate
- SSH passwords may be stored in the OS keyring (under `ssh-<server-id>`) or prompted at connect time and held in memory only

## License

PacketBench is licensed under the Apache License, Version 2.0. See [`LICENSE`](LICENSE) and [`NOTICE`](NOTICE).
