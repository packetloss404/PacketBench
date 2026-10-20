# PacketBench — Competitor Landscape

Last updated: 2026-07-27

**Historical snapshot.** For current Cursor ownership, weekly versus legacy
usage, Composer 2.5, official ChatGPT-plan integrations and PacketBench's fresh
runtime/experience assessment, use the
[October 19 review](./agent-harness-and-experience-review-2026-10-19.md).
The July provider counts and exclusivity claims below are not current evidence.

Scope: desktop/local agentic development environments and multi-agent coding-CLI orchestrators —
the category PacketBench competes in. Compiled from read-only web research (fan-out subagent team).
Figures are vendor/third-party-reported unless noted; treat funding/valuation/ARR as approximate.

Companion docs:

- [`bridgemind/bridgespace-competitive-brief.md`](./bridgemind/bridgespace-competitive-brief.md) — deep dive on the closest competitor
- [`bridgemind/bridgeswarm-teardown.md`](./bridgemind/bridgeswarm-teardown.md) — BridgeSwarm orchestration teardown
- [`bridgemind/swarm-orchestration-plan.md`](./bridgemind/swarm-orchestration-plan.md) — PacketBench's own swarm response (mostly shipped)

## The one-line thesis

The category has converged on a single shape: **wrap external coding CLIs (Claude Code, Codex,
Gemini CLI, …) in a desktop/TUI/cloud shell, isolate each with a git worktree (or container), and
add a diff/review + dispatch surface.** Agent intelligence is commoditized; the product is the
management layer. **On the axis PacketBench optimizes — provider identity + auth transport as a
first-class, badged abstraction — essentially nobody else competes.** Everyone delegates auth to
whatever CLI you installed.

## Master comparison

| Product                      | Status                       | Platform                                          | Agent model                                            | Provider breadth                                                                                                      | **Auth model**                                                                                                                                          | Isolation                         | Orchestration                                                                 |
| ---------------------------- | ---------------------------- | ------------------------------------------------- | ------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------- | ----------------------------------------------------------------------------- |
| **PacketBench** (us)           | Active                       | Tauri2/Rust; macOS/Win/Linux                      | Wraps PTY CLIs **+ API agents**                        | **7 API-agent rows** (Claude Agent SDK, Claude API, OpenAI API, OpenAI Agents SDK, MiniMax, OpenRouter, Ollama)       | **API-key/local auth badges, separate CLI-account health, dual in-process/sidecar transport**                                                           | Git worktrees (Flight attempts)   | Flights + roles/ownership/collision/feed                                      |
| **BridgeSpace** (BridgeMind) | GA v3.4.15                   | Tauri2/Rust; mac/Win/Linux                        | Wraps external CLIs                                    | Delegated to installed CLIs; discontinued BridgeCode remains a historical benchmark                                   | Claude/Codex account connection plus Settings API Keys; no verified unified ADE provider/auth contract comparable to PacketBench's rows/badges/transports | Git worktrees                     | **BridgeSwarm** roles + ownership + quality gates                             |
| **Warp**                     | Active, ~$73M (Sequoia)      | Rust native (non-Electron); mac/Linux/Win + cloud | Own harness **+** wraps CLIs                           | ~5 providers / 40+ models, picker + auto-route                                                                        | Warp account + credits; **BYOK API-key-only**, no OAuth-sub, no badges                                                                                  | Git worktrees (Tab Configs)       | Parallel independent tabs                                                     |
| **Cursor Cloud** (Anysphere) | Dominant, ~$4B ARR           | Electron desktop/web/iOS/Slack                    | **Own proprietary stack**                              | Multi-model, single-vendor-controlled, auto-route                                                                     | **Single-vendor account**; BYO keys IDE-only (not cloud agents); no badges                                                                              | Cloud VMs                         | Parallel + `/multitask` sub-agents                                            |
| **AgentsRoom**               | Active v1.120                | Electron+xterm; mac/Win/Linux + iOS/Android       | Wraps 8 CLIs                                           | **8** (Claude Code, Codex, Antigravity, OpenCode, Aider, Grok Build, Mistral Vibe, Kimi); per-agent + mid-conv switch | **Never touches creds** — no login/API-key/badges by design                                                                                             | Worktree optional (weak)          | **Richest**: 14 roles, React-Flow editor, MCP `team_*` handoff, role morphing |
| **Conductor**                | Active v0.77, YC S24, $22M A | macOS-only native                                 | Wraps 4: Claude Code, Codex, Cursor, OpenCode          | 4 harnesses + routing (OpenRouter/Bedrock/GLM)                                                                        | CLI-auth-vs-API-key toggle + status readout; delegates identity, no badges                                                                              | Git worktrees                     | Parallel independent                                                          |
| **Superset**                 | Active, YC P26, ELv2         | macOS-only (Win/Linux soon)                       | Wraps **12+ CLIs** (breadth leader)                    | 12+, launch picker, BYO providers                                                                                     | **Pure BYO-keys**, no modeling/badges (its OAuth2.1 is for its own MCP server)                                                                          | Git worktrees (100+ parallel)     | Parallel + cron                                                               |
| **Nimbalyst** (ex-Crystal)   | Active, **free + MIT**       | Electron; mac/Win/Linux + iOS                     | Wraps Claude Code + Codex (+alpha)                     | Narrow (~2)                                                                                                           | BYO CLI login; no modeling/badges                                                                                                                       | Git worktrees                     | Parallel + compare-approaches, session kanban                                 |
| **Claude Squad**             | Active, AGPL-3.0             | Go **TUI**; mac/Linux (WSL)                       | Wraps Claude Code, Codex, Gemini, Aider, OpenCode, Amp | Broad via profiles                                                                                                    | Env-vars / BYO; no modeling                                                                                                                             | **tmux + worktrees**              | Parallel multiplexer                                                          |
| **Sculptor** (Imbue)         | Beta, MIT                    | macOS/Linux                                       | Wraps Claude Code + Pi                                 | **Claude-only**                                                                                                       | BYO Claude/Max, single-vendor                                                                                                                           | **Docker containers** (strongest) | Parallel                                                                      |
| **Omnara**                   | Active, YC S25, Apache-2.0   | Mobile-first: iOS/Android/web/watch/CLI           | Remote-controls Claude Code + Codex                    | Claude/Codex-centric                                                                                                  | BYO subscription; control-plane sync only                                                                                                               | **None** (overlay)                | Single + orchestrator sub-agents                                              |
| **Vibe Kanban** (Bloop)      | **Dead** Apr 2026 → OSS      | Local web UI (Rust+SQLite)                        | Wraps 10+ CLIs                                         | 10+ agents                                                                                                            | Pure BYO CLI login; no modeling                                                                                                                         | Git worktrees                     | **Kanban-dispatch** (the canonical one)                                       |
| **Terragon**                 | **Dead** Jan 2026 → OSS      | Cloud/hosted                                      | Wraps Claude Code, Codex, +                            | Multi, extensible                                                                                                     | **Dual sub-or-API-key** (closest to us) but cloud-centralized, no badges                                                                                | Cloud sandbox containers          | Parallel background + auto-PR                                                 |

## Where each stands (one paragraph each)

**BridgeMind / BridgeSpace** — The closest overall analog: same Tauri2/Rust ADE shape with a 16-pane
grid, worktrees, Kanban dispatch, role-based orchestration (BridgeSwarm), shared memory, MCP spine,
and Whisper voice. Solo-founder, build-in-public, ~$201K ARR, targets _non-coders/vibe-coders_.
BridgeSpace now exposes custom Agent prompts and Settings API Keys, but current public material still
does not establish one unified provider/auth/transport contract comparable to PacketBench's. Full brief:
[`bridgemind/bridgespace-competitive-brief.md`](./bridgemind/bridgespace-competitive-brief.md).

**Warp** — Biggest and best-funded (~$73M, Sequoia). Native Rust terminal repositioned as an "ADE";
runs its own multi-provider agent _and_ wraps external CLIs, with worktrees, parallel tabs, native
code review, and MCP. Auth is account-credit-centric with API-key-only BYOK — no OAuth-subscription
login for its own agent and no provider-identity UI. The rival most worth watching on UX/scale.

**Cursor Cloud (Anysphere)** — The scale incumbent (~$4B ARR, ~$29B+ valuation). Own proprietary
agent stack, cloud-VM isolation, `/multitask` sub-agents, deep Slack/GitHub/Linear integration. Pure
single-vendor funnel: you authenticate to Cursor, models are abstracted behind its routing/credits,
and BYO keys don't even work for cloud agents. The inverse of PacketBench's provider-neutral thesis.

**AgentsRoom** — The richest _orchestration_ peer and closest on provider breadth: 8 CLIs, per-agent
provider with mid-conversation switching, a **React-Flow visual team editor** with 14 roles, an
MCP-based `team_*` handoff protocol, cheaper-model QA delegation, one-click role "morphing," plus a
real iOS/Android companion. Electron. Deliberately **never touches credentials** — zero in-app auth
visibility. Out-orchestrates and out-mobilizes PacketBench; PacketBench out-abstracts it on providers/auth.

**Conductor** — Closest well-funded incumbent (YC S24, $22M A, ~6 people). macOS-only, best-in-class
native polish, worktree-per-workspace, wraps 4 harnesses. Has a real auth surface (CLI-auth-vs-API-key
toggle + status readout) but delegates identity to each CLI — no provider modeling or badges, no MCP.
The bar to beat on UX; shallower than PacketBench on auth/provider depth.

**Superset** — Breadth leader (12+ CLIs) with an agent-facing MCP server (27 workspace tools) and a
real team/enterprise pricing ladder. macOS-only, ELv2 source-available, tiny early team. Pure
BYO-keys with no provider-auth modeling. Its coverage makes PacketBench's 7 rows look narrow on
_count_, but PacketBench's auth abstraction is a different (and absent-here) axis.

**Nimbalyst (ex-Crystal)** — Crystal _pioneered the desktop worktree-parallel-sessions pattern_ that
is now the category's shared DNA; its free + MIT successor Nimbalyst adds a session kanban, inline AI
diffs, WYSIWYG artifact editors, and a mobile companion. Electron, narrow provider set (Claude
Code + Codex), no auth modeling. Closest desktop analog; edge is visual editors, not providers.

**Claude Squad** — The terminal-purist: a Go TUI multiplexer over tmux + worktrees, agent-agnostic
via a profiles system, AGPL-3.0. No GUI, kanban, memory, voice, MCP, or Windows-native support. Its
generic-CLI-profile model is instructive; its auth is bare env-vars.

**Sculptor (Imbue)** — Strongest _isolation_ story: a real Docker container per agent (user-owned,
local, free), with mid-session Claude model switching, a Skills system, and a CI Babysitter.
Single-vendor (Claude only), macOS/Linux, research-preview. PacketBench's closest philosophical rival
on local user-owned isolation — but isolates harder while abstracting providers less.

**Omnara** — Owns the **mobile/remote/voice** dimension PacketBench doesn't touch: a control-plane
overlay that mirrors and steers your local Claude Code/Codex sessions from phone, watch, web, or CLI,
with a flagship 2-way voice mode. No isolation of its own; thin provider layer. A complement more
than a head-to-head — and a clear gap in PacketBench's coverage.

**Vibe Kanban (Bloop)** — The canonical "kanban for agents" (YC-backed), now **dead as a product**
(shut Apr 2026, Apache-2.0 community fork). Local web UI over a Rust+SQLite server, 10+ CLIs, worktree
per card, inline diff review, preview browser, MCP. The direct reference point for PacketBench's Flight
Deck worktree-attempt model — with no provider/auth abstraction.

**Terragon** — Cloud fire-and-forget background orchestrator, also **dead** (shut Jan 2026, OSS
snapshot). Ran each agent in a cloud sandbox container and auto-opened PRs. Notably the _only_ peer
besides PacketBench to model a subscription-vs-API-key split — but centralized creds in its cloud and
had no live badges. Validates the auth axis while showing the cloud-centralized version is fragile.

## Synthesis

### Common pattern (category DNA)

1. **Wrap external CLIs, don't build the agent** — everyone except Warp and Cursor.
2. **Git worktrees as the default isolation primitive** — Sculptor (Docker) and Terragon/Cursor
   (cloud sandboxes/VMs) are the outliers.
3. **Parallel attempts + a diff/review/merge surface** is the core loop.
4. **"Bring your own login/keys"** — auth is uniformly delegated to the installed CLI. **No tool
   treats auth identity/transport as a first-class modeled concept.**
5. **Rapid consolidation/mortality** — Terragon (Jan '26), Crystal→Nimbalyst (Feb '26), Bloop/Vibe
   Kanban (Apr '26) all died or changed hands within one quarter.

### Differentiation battlegrounds

- **Orchestration quality** — top axis. AgentsRoom (visual team editor + MCP handoff), BridgeSwarm
  (roles + ownership + gates), and Warp (task-decomposing harness) lead; most others just launch
  parallel independent agents.
- **Isolation model** — worktree (default) vs container (Sculptor) vs cloud VM (Cursor/Terragon).
  "How safe is a bad agent?" is a real wedge.
- **Provider breadth + switching** — Superset (12+), AgentsRoom (8, mid-conv), Warp (5/40+ models).
- **Auth/provider identity** — **wide open; only PacketBench and (defunct) Terragon even attempt it.**
- **Memory** — near-empty lane; only BridgeMemory and AgentsRoom's project memory market it.
- **Voice** — thin field: Omnara, AgentsRoom, BridgeVoice, PacketBench's Dictation.
- **Mobile/remote steering** — Omnara, AgentsRoom, Cursor, BridgeAgent.
- **MCP** — surprisingly under-marketed; Warp, Superset, AgentsRoom, BridgeMCP foreground it.

### Where PacketBench is genuinely differentiated

1. **Provider/auth-type as a first-class, badged concept** — unique. API-key
   providers and local Ollama have live status (`ready | missing_key |
service_down`), while PTY CLI account health remains a separate,
   refresh-aware surface.
2. **Dual transport behind one event contract** — in-process `LlmProvider` (Claude/OpenAI API,
   MiniMax, OpenRouter, Ollama) _and_ a versioned Node sidecar (Claude Agent SDK
   and OpenAI Agents SDK), both emitting `api-agent:*`. No peer runs both
   in-process raw-API and SDK providers behind one contract.
3. **Layered work hierarchy (Flights above issues/sessions)** — most peers stop at card→agent→worktree→diff.
4. **Breadth of integrated surfaces** — API-agent chat tiles + PTY terminals + memory + dictation +
   MCP + cost analytics in one Tauri app; few peers span this range.

### Gaps PacketBench should weigh (where peers are ahead)

- **Orchestration depth** — AgentsRoom's visual team editor + MCP handoff and BridgeSwarm's gates set
  a higher bar than parallel attempts. (PacketBench's [`swarm-orchestration-plan.md`](./bridgemind/swarm-orchestration-plan.md)
  already ships roles/ownership/collision/feed; auto-reassignment escalation is the remaining gap.)
- **Mobile/remote/voice steering** — owned by Omnara/AgentsRoom/Cursor; PacketBench is desktop-only.
- **Native-Mac polish & funding** — Conductor/Warp/Cursor out-resource us on UX.
- **Provider count** — Superset (12+) and AgentsRoom (8 CLIs) exceed our 8 rows on raw count (though
  not on auth depth).

### Bottom line

UI/worktree/kanban/diff parity is table-stakes and no longer differentiates anyone. PacketBench's
durable moats are **provider/auth abstraction, dual transport, memory, and MCP breadth** — precisely
the lanes the rest of the field under-invests in, and aligned to a _professional-engineer_ audience
that BridgeMind/Warp's vibe-coder positioning doesn't serve.
