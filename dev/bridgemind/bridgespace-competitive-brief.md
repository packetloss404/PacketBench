# BridgeMind / BridgeSpace — Competitive Brief

> Historical July assessment. For the October 25 BridgeMind One review and the
> consolidated Cursor/Codex/Claude follow-up scope, use the [feature-gap plan](./feature-gap-plan-2026-10-25.md)
> and [live backlog](../../backlog.md). Existing desktop completion and Remote
> Agents ordering supersede this document's older response queue; keep its
> dated feature/source findings within their original evidence scope.

Last updated: 2026-07-27
Research method: a fresh read-only fan-out across official BridgeMind product,
documentation, roadmap, changelog, and public package/repository material, checked
against PacketBench's current source. Official pages were directly accessible during
this pass. "Absence" findings mean "not established in current public material,"
not proof of impossibility.

Related PacketBench response plans (already in flight): [`swarm-orchestration-plan.md`](./swarm-orchestration-plan.md),
[`packetbench-mcp-server-plan.md`](./packetbench-mcp-server-plan.md). Deep BridgeSwarm teardown:
[`bridgeswarm-teardown.md`](./bridgeswarm-teardown.md). Master competitor index:
[`../competitors.md`](../competitors.md).

## Bottom line

BridgeMind's **BridgeSpace remains the closest product to PacketBench** — a Tauri-2/Rust desktop ADE
with multi-pane terminals (up to 16), Kanban dispatch, git-worktree isolation, role-based
multi-agent orchestration, shared memory, an MCP spine, and on-device Whisper voice. Its current
material also shows custom Agent system prompts and Settings API Keys, so the old blanket claim
that it has "no profiles or API-key surface" is retired. What remains unverified is one unified
ADE-level provider/auth/transport contract comparable to PacketBench's seven badged API-agent rows and dual
in-process/sidecar runtime.

## Company & maturity

|             |                                                                                                                                                                                    |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Company     | Solo founder **Matthew Miller** (build-in-public, 3rd startup), US, **no external funding**, effectively 1 person                                                                  |
| Traction    | ~$201K self-reported ARR ("day 185" of a public $1M challenge); ~86K YouTube, ~40K X, ~13K Discord. BridgeSpace 3's Product Hunt launch: **17 upvotes / #47 of day**               |
| Model       | One credit-metered subscription bundling the suite — Basic $16 / Pro $40 / Ultra $80 (annual in the researched material). A durable free tier could not be confirmed consistently. |
| Positioning | "Home of the vibe coding movement." Explicitly targets **non-coders & solo founders**, _not_ professional engineers                                                                |
| Stack       | **Tauri 2 + Rust**, macOS/Win/Linux, signed auto-updating desktop apps, rapid cadence (BridgeSpace v3.4.15, July 17, 2026)                                                         |

**Read:** real and shipping, fast-moving, but early-stage, founder-dependent, hobbyist-audience.
Category is churning (Terragon died Jan '26, Crystal Feb, Bloop's Vibe Kanban Apr).

## BridgeSpace — how the CLI is handled

- **Model = bring-your-own external CLI.** Verbatim: it _"works with Claude Code, OpenAI Codex,
  Gemini CLI, OpenCode, and Cursor — any terminal-based coding agent that can follow structured
  ownership and review."_ BridgeSpace is _"the workroom around them"_ and shells out to whatever
  terminal agent is installed.
- **Panes:** 1–16 terminal grid (templates for 1/2/4/…/16), Warp-style collapsible **command
  blocks** with success/fail indicators, 25+ themes, per-project workspaces.
- **Dispatch:** _"drag a card to dispatch a coding agent"_; selecting a Kanban task auto-determines
  the project folder and spawns workspace tabs/panes. Git **worktree flows** in the sidebar.
- **Tech:** Tauri 2 + Rust PTY engine, Tauri Channels IPC with a 256 KB renderer-payload cap and
  UTF-8-boundary-safe coalescing of oversized PTY bursts. **No evidence of a Node sidecar or a
  versioned JSON stdio protocol** — a near-sibling of PacketBench's `core/pty.rs`, but single-transport.

## The "agent type flow" gap — narrowed

BridgeSpace has more ADE-level configuration than the earlier audit captured. It exposes custom
Agent system prompts and Settings API Keys alongside a **"Connect Accounts"** layer for external
CLI OAuth/subscription logins:

**Present:** linking **Claude and Codex accounts** with per-profile sign-in progress; onboarding
state _"seeded from the CLI's real state file at connect"_; multi-account, **profile-aware resume**
(sessions record which Claude/Codex profile + transcript path they ran under). _"First launch opens
a browser sign-in, not an API key prompt."_

**Still not established in current public material:**

- one provider-row **catalog** equivalent to PacketBench's seven transport/auth identities;
- a refresh-aware distinction between subscription/OAuth and API-key identities with live badges;
- one event contract spanning both in-app raw-API agents and subscription-backed agents;
- a BridgeSpace-level model/transport contract comparable to PacketBench profiles.

**Historical nuance:** BridgeCode exposed multi-provider switching and personas in an alpha CLI,
but BridgeMind discontinued the BridgeCode integration on May 30, 2026. Treat it as a workflow
benchmark, not a current part of the BridgeSpace suite or an active competitor to integrate with.

## The ecosystem

| Module       | Status                                  | What it is                                                                                                                                                                                         | PacketBench analog                                               |
| ------------ | --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| BridgeSpace  | GA (v3.4.15)                            | Flagship Tauri desktop ADE, 16-pane grid, hub for the rest; recent work emphasizes cold-start restore, deferred panes, durable identity, and recovery                                              | The whole app                                                  |
| BridgeSwarm  | GA (in BridgeSpace)                     | Role-based multi-agent (Coordinator/Builder/Scout/Reviewer), file ownership, quality gates. Unit of work = **"mission"**                                                                           | Flights + orchestration (PacketBench _retired_ "Mission" naming) |
| BridgeBoard  | GA (in BridgeSpace)                     | "Vibe Kanban" that dispatches agents; state shared via MCP                                                                                                                                         | Issue board / Flight dispatch                                  |
| BridgeMemory | GA (Pro+)                               | Persistent shared cross-session/cross-tool memory, delivered via MCP                                                                                                                               | Memory layer                                                   |
| BridgeMCP    | GA                                      | Managed endpoint plus local client; shared tasks + memory to connected clients                                                                                                                     | MCP client/provider mgmt                                       |
| BridgeVoice  | GA (most mature)                        | Tauri 2 + Rust, on-device Whisper (Tiny→Large-v3) + Parakeet, optional Groq cloud, 99+ langs                                                                                                       | Dictation module (near-identical)                              |
| BridgeCode   | Discontinued integration (May 30, 2026) | Historical alpha CLI with multi-provider switching, personas, sub-agents, and MCP                                                                                                                  | Historical benchmark for the sibling PacketCode TUI            |
| BridgeAgent  | **Beta** (v0.1.9)                       | Always-on worker with bounded loops, goals/templates, cron Responsibilities, production-signal-to-PR flows, integrations, skills, sub-agents, MCP, and local/container/SSH/cloud execution targets | PacketAgent plus PacketBench handoff contract                    |
| BridgeShot   | Public beta (macOS)                     | Native Swift screenshot + on-device OCR                                                                                                                                                            | —                                                              |
| BridgeBench  | Live alpha, OSS                         | Vibe-coding benchmark and Elo leaderboards (bridgebench.ai)                                                                                                                                        | —                                                              |

**Spine:** BridgeMCP carries shared **tasks** (todo→in-progress→in-review→complete) + **memory** to
every agent/tool. BridgeSpace embeds Board/Swarm/Memory and drives external CLIs. One subscription,
several separate apps.

## Where PacketBench genuinely stands apart

1. **Provider/auth-type as a first-class, badged concept — unique to PacketBench** across BridgeSpace
   and ~11 peers. PacketBench models API-key providers and local Ollama with live
   status while keeping PTY CLI account/subscription health explicit and
   separate.
2. **Dual transport behind one event contract — no peer analog.** In-process `LlmProvider`
   (Claude/OpenAI API, MiniMax, OpenRouter, Ollama) _and_ a versioned Node
   sidecar (Claude Agent SDK and OpenAI Agents SDK), both emitting
   `api-agent:*`.
3. **Layered work hierarchy (Flights above issues/sessions).** Most peers stop at "card → agent →
   worktree → diff"; BridgeSwarm's "mission" is the nearest.
4. **Under-contested lanes PacketBench already occupies:** MCP breadth, voice/dictation, and a memory
   layer — the last two near-empty across the field (only BridgeMind also invests in all three).

## Honest counterweights (where BridgeMind is ahead / a real threat)

- **BridgeSwarm is productized orchestration**, not just parallel attempts — explicit roles +
  file-ownership + merge-gating + inter-agent mailbox. (PacketBench has matched most of this; see
  [`swarm-orchestration-plan.md`](./swarm-orchestration-plan.md) — roles/ownership/collision/feed
  shipped, auto-reassignment escalation still partial.)
- **Distribution & marketing muscle** — large content/community engine, rapid public shipping.
- **BridgeAgent** (autonomous mission→PR with production-signal self-healing) ≈ PacketBench's Remote
  Agents roadmap, already in beta.
- **Same table-stakes:** worktrees, unified diff/review, kanban dispatch, Tauri+Rust+Whisper — these
  no longer differentiate anyone.

## Strategic takeaways

- **Lead with the provider/auth-type abstraction and dual transport** — the one defensible thing the
  entire field lacks, and it maps to the _professional-engineer_ audience BridgeMind isn't serving.
- **Close the orchestration escalation gap** (auto-reassignment / structured supervision) to reach
  BridgeSwarm parity end-to-end.
- **Packet suite positioning:** PacketBench is the professional desktop cockpit, PacketAgent is the
  durable always-on worker, and the sibling PacketCode TUI is the terminal-native coding agent.
  PacketCode has now been audited and hardened against BridgeCode's historical workflows; remaining
  work is release proof and the clean PacketAgent compatibility boundary, not BridgeCode parity.
- **The category is unstable** — auth abstraction, memory, and MCP breadth are the durable moats;
  UI parity is not.

## Competitive response decision queue

Work through these one at a time; presence here is not blanket approval to implement every item.

1. **✅ Decided and shipped baseline — Flight attention and assisted escalation (Option B).**
   Detect blocked/stuck/failed attempts, explain the cause, recommend a recovery, and keep
   retry/reassignment user-approved in PacketBench. No silent relaunching.
2. **✅ Implemented; release-like smoke remains — Reviewer quality gates (Option B).** An opted-in Flight
   automatically starts one selected read-only reviewer when an attempt reaches review. A non-pass
   verdict blocks normal acceptance, with an explicit recorded human override. See
   [`reviewer-gate-loop.md`](./reviewer-gate-loop.md).
3. **✅ Implemented; release-like smoke remains — role-based Flight task graphs (Option B).** Turn an
   explicitly applied plan into dependent, role-assigned work; launch ready batches by user action;
   converge accepted results on an isolated Flight integration branch; retain per-task worktrees.
   See [`cooperative-flight-graph-loop.md`](./cooperative-flight-graph-loop.md).
4. **✅ Implemented; release-like smoke remains — coordination inbox and steering (Option B).** Persist
   structured blockers, questions, findings, handoffs, artifacts, delivery, and acknowledgement;
   steer one agent, role, or whole Flight. Direct agent↔agent routing requires bounded YOLO. See
   [`coordination-inbox-loop.md`](./coordination-inbox-loop.md).
5. **✅ Decided; PacketBench consumer blocked on the separate PacketAgent project — Keep running
   in PacketAgent (Option B).**
   Validate, deploy, activate, reconnect, supervise, and receive durable evidence while PacketAgent
   owns execution after the ADE closes. See
   [`packetagent-handoff-loop.md`](./packetagent-handoff-loop.md); PacketBench slices depend on
   PacketAgent W1–W9.
6. **✅ Source implementation complete; release proof remains — PacketCode as the terminal
   agent, but better (Option B).** PacketCode remains independently installable. PacketBench now
   models PATH/manual/fallback executable resolution, developer checkout, release channel, and
   distinct local/remote `PACKETCODE_HOME`, then performs strict version and bounded doctor probes.
   The PacketCode source has the matching home/doctor contracts, checksum-verifying Windows
   installer, structured bounded loops, per-server MCP restart, and a feature-truth/hardening
   ledger. Published signed multi-platform artifacts, clean-machine proof, remaining lower-priority
   hardening, and the PacketAgent compatibility smoke are still gated. See
   [`packetcode-bridgecode-loop.md`](./packetcode-bridgecode-loop.md).
7. **✅ Decided, implementation queued — project-local Memory Hub (Option B).**
   Extend PacketBench's existing Memory surface with human-readable project-local
   Markdown, versioned metadata, links/backlinks, graph/orphan views,
   provenance, current IDF retrieval, and scoped MCP access. Keep the current
   global memory store as a separate source class; do not create a standalone
   PacketMemory product or add a cloud/vector-database dependency. See
   [`project-local-memory-hub-loop.md`](./project-local-memory-hub-loop.md).
8. **✅ Decided, later — local-first MCP Hub (Option B).** Consolidate the
   shipped PacketBench MCP client/provider substrate with a curated starter
   catalog, capability health/restart, scoped trust profiles, provenance, and
   suite resources. This is approved but explicitly not the first PacketBench
   focus. Keep credentials and execution local/SSH; do not create a hosted
   PacketMCP service or public endpoint. See
   [`local-first-mcp-hub-loop.md`](./local-first-mcp-hub-loop.md).
9. **❌ Decided — no BridgeBench / Flight Bakeoff track.** Do not add an
   internal leaderboard or multi-model acceptance-pack product. Existing
   provider choice, reviewer gates, and normal test evidence remain sufficient;
   remove the generic multi-model A/B item from the roadmap.
10. **❌ Decided — no BridgeShot response.** Do not add screenshot/OCR capture
    to PacketBench or create a standalone PacketShot product.
11. **⏸ Decided — production-signal monitoring is not now.** Do not add a
    Sentry/PostHog/CI-to-Flight product loop to the active backlog. PacketAgent
    remains the eventual always-on execution owner if this is reconsidered.
12. **✅ Decided, implementation queued — Trust and Provenance.** Add one
    cross-cutting PacketBench layer that marks external/derived evidence, carries
    source lineage through agent, MCP, web, review, Flight, and Memory records,
    and gates risky follow-on actions through existing permissions and bounded
    autonomy. It is not a standalone app and does not claim perfect
    prompt-injection detection. See
    [`trust-provenance-loop.md`](./trust-provenance-loop.md).

### Cross-cutting autonomy overlay

The chosen assisted behaviors remain the default. An explicitly enabled **YOLO Mode** may automate
recovery, reviewer remediation, and ready-task execution through one bounded `AutonomyPolicy`.
Settings defines defaults and each Flight exposes its effective policy. Cost, time, retry,
concurrency, root, and target limits plus a kill switch are mandatory; reviewer overrides,
conflict resolution, and final protected/base-branch landing never become implicit. See
[`autonomy-policy-loop.md`](./autonomy-policy-loop.md).

## Sources

Official BridgeMind product pages (`/products/bridgespace`, `/bridgeswarm`, `/bridgemcp`,
`/products/bridgevoice`, `/products/bridgeagent`, `/bridgebench`, `/pricing`, `/roadmap`,
`/changelog`) and docs (`/bridgespace`, `/getting-started`, `/mcp`), plus public npm/GitHub
material for historical BridgeCode and BridgeBench. Third-party material was used only as a
cross-check for vendor-stated maturity and positioning.
