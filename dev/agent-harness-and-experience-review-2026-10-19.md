# Agent harness, Cursor and desktop experience review

> Historical October 19 review. Later implementation slices are committed;
> [the October 24 audit](./documentation-audit-2026-10-24.md) and
> [current status](./current-status.md) supersede its unimplemented/current-state
> interpretations. Original findings and evidence retain their dated scope.

Date: October 19, 2026, America/Chicago. Research retrieved through October 20 UTC.
Source baseline: `e5d31084e5d2c4861723dca4d4c2931a64b0f732`.
Installed Windows runtime: local 0.14.9 rebuild, source contents `0b6dbf52`;
executable SHA-256 `6a69c35cbbdca49d1b09b5076ceb70bd9ad3b86996a2ac2464965e53b2dc55cb`.

This is a research and review record, not an implementation or release plan
approved for execution. Open work belongs in [backlog.md](../backlog.md).
It follows the [loop/graph assessment](./loop-and-graph-engineering-alignment-2026-10-19.md)
and [completed Flight overhaul evidence](./flight-overhaul-review-2026-10-19.md).

Follow-up ownership: the owner moved Composer research to a separate thread.
The [implementation handoff](./agent-experience/README.md) develops the remaining
runtime, Agents, appearance and validation findings for a future team. Its
existing-runtime evaluation work does not include a Composer/model program.
The original Composer assessment below remains dated research, not work for
that team to repeat.

## Decision in brief

PacketBench has a real agent runtime, not merely a prompt box: structured tools,
provider adapters, permission boundaries, memory, subagents, usage accounting,
local/SSH execution, review and delivery are already present. Its main weakness
is making those capabilities feel like one reliable, readable daily workflow.

- **Codex experience parity is not established.** There is capability overlap,
  but source review found small text, weak contrast, inconsistent navigation and
  several consequential Agents flow defects. A fresh Windows inspection also
  encountered a nonresponding app; Mac rendering was not inspected.
- **Keep Inter initially.** It is already bundled. Increase sizes, improve
  contrast, expose text scaling, and repair layout before changing typefaces.
- **An owned coding harness is credible.** Measure the production runtime on
  real coding tasks and improve context, recovery, tool behavior and review.
  A prompt preset alone would not establish Composer-level model quality.
- **A trained model is a separate program.** A narrow open-weight experiment
  could follow measured need. A frontier model is not a sensible next desktop
  milestone on the evidence available here.
- **A newly documented official ChatGPT-plan integration deserves evaluation.**
  Its consent, identity and transport contract differs from the retired adapter.
  This report does not restore an old provider or change authentication.

## Evidence boundaries and native inspection

Three read-only subagent reviews covered the reusable runtime, typography and
GUI, and the Agents journey. Their findings below are source-derived unless
explicitly marked otherwise. No models were benchmarked, paid turns submitted,
app source changed, installer rebuilt or provider credentials modified.

The root agent used the installed Windows application through the supported
computer-use API in short bursts, resetting the control session after each.
The first 1886-by-1033 capture showed Flight Deck, three total test Flights,
archived items hidden, and no selected Flight. The shell was visibly very small
and subdued on a large dark surface. That is a visual judgment, not a measured
pixel-font audit. The source tokens below establish the actual CSS sizes.

**N1 — P1, unresolved native responsiveness observation.** The Agents navigation
click timed out (`computer-use request timed out: click_element`). A subsequent
capture displayed **PacketBench (Not Responding)**. Read-only process checks
also returned `Responding=False` for PID 60916. The last check before writing
this report still returned false. No agent prompt was sent. The process was not
killed or restarted, preserving the state for diagnosis, and desktop control
was released. The triggering sequence is recorded; the cause is **not isolated**.
An app main-thread stall, native/accessibility interaction, or another condition
could be responsible. This is not proof of a specific Agents component defect.

Next evidence: reproduce navigation with ordinary manual input and with
automation separately; capture a safe hang dump/main-thread trace, WebView
responsiveness and relevant logs before deciding which layer to fix. A fresh
launch, navigation and return must pass in the installed build without losing
saved work. The earlier installed Flight smoke remains valid for its recorded
scope, but does not establish current whole-app responsiveness.

The live Agents transcript inspection could not be completed after that stall.
Agents findings are consequently source evidence, not a claimed successful
native Agents walkthrough. The computer-use skill prohibits automating the
Codex/ChatGPT application itself; comparison uses official public documentation,
not live control of the user's Codex UI. No native Mac comparison was performed.

## What has changed in the agent landscape

### Harness infrastructure is becoming an available dependency

OpenAI introduced its Agents API in public beta on September 10, 2026: a
managed Codex harness with long-session context management, tool discovery,
execution environments and subagents. This is an available integration option,
not evidence that PacketBench already supports it. [OpenAI announcement](https://openai.com/index/introducing-the-agents-api/)

Anthropic's April 8 architecture separates durable session events, replaceable
harnesses and execution environments. It distinguishes recoverable session
history from whatever subset fits in a model's current context.
[Managed Agents engineering](https://www.anthropic.com/engineering/managed-agents)

**Implication, our assessment:** owning every low-level loop is becoming less
valuable by itself. Own the user's project/host identity, authority boundaries,
recovery, evidence, review and delivery experience. Keep a seam for native,
SDK-backed or managed execution. Managed cloud execution would be optional;
it does not replace the local-first desktop or authorize uploading local work.
Compare an existing SDK/managed route with the native executor before building
another orchestration layer.

### The improvement loop must measure outcomes

Anthropic distinguishes an agent harness from its evaluation harness and
recommends grading resulting environment state as well as the trajectory,
with repeated trials and calibrated human/model judgments.
[Agent evaluations](https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents)

OpenAI describes repository legibility, mechanically enforced constraints and
feedback loops as important parts of its internal agent-first engineering
experiment. Its reported results are an account of that environment, not a
general productivity guarantee. [Harness engineering](https://openai.com/index/harness-engineering/)

**Implication:** PacketBench's product test gates are valuable, but passing
thousands of implementation tests does not answer whether a model plus harness
solves the owner's next task well. Add a small repeatable task suite using the
same production executor. Track correctness, regressions, time, cost, failed
tools and human interventions. Preserve failed trials, not just attractive demos.

### Context is a maintained working set

Anthropic recommends selective, just-in-time retrieval and focused tool
interfaces rather than indiscriminately filling the context window.
[Context engineering](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)
Its earlier long-running harness uses incremental work and durable artifacts
across sessions, while acknowledging uncertainty about when multiple agents
help. [Long-running agents](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents)

**Implication:** preserve an objective, constraints, active plan, relevant file
revisions and unresolved evidence in a versioned context manifest. The existing
Flight DAG is useful execution structure; a dependency graph could improve
retrieval if experiments establish a benefit. A graph editor or graph database
is not a prerequisite. Start with the repository's existing lexical retrieval
and symbols, and preserve the earlier decision against unmeasured embeddings.

### Interoperability is improving, but protocols solve different problems

ACP defines an editor-to-agent interface. Its current documentation distinguishes
v1 from a v2 draft and says full remote support remains work in progress.
[ACP introduction](https://agentclientprotocol.com/get-started/introduction)

**Implication:** compare official structured agent transports before writing
new vendor-specific UI bridges. MCP supplies tools/context; ACP supplies an
agent/client conversation contract; provider HTTP APIs supply inference. None
automatically supplies isolation, model entitlement or a trustworthy review.
An ACP evaluation would be a fresh decision, not permission to revive the
removed PacketCode ACP implementation.

## Cursor: acquisition, weekly limits and lessons

Cursor's August 14, 2026 announcement explicitly states that SpaceX completed
its acquisition. This supersedes the earlier partnership/option stage.
[Cursor acquisition announcement](https://cursor.com/en-US/blog/joining-spacex)

On October 12, The X Subscription combined Grok, Grok Bot, Cursor and X.
The company claims at least twice the coding usage with its own models versus
comparable older Cursor plans. That claim is model- and plan-specific, not a
claim of double Claude or GPT usage. Existing customers can retain their plan.
[Subscription announcement](https://x.ai/news/x-subscription)

Current published monthly tiers are Plus $8, Premium $30, Super $100 and Ultra
$200; these are subscription prices, not fixed API-token grants. Premium and
higher allow separately billed third-party models. Actual eligibility and
account allowances were not inspected. [Current pricing](https://x.ai/pricing)

Cursor's current help distinguishes **new weekly plans** from **legacy monthly
plans**. New paid plans share a Cursor-model pool, including Composer 2.5 and
listed Grok models, across Cursor/Grok Bot/Grok apps. Third-party usage is
separate. Legacy plans retain separate monthly Cursor/other-model pools, with
plan-specific exceptions. Model choice changes consumption. The UI exposes
remaining usage and the next reset. Subagent requests can bill a third-party
model even when the parent picker shows Auto or a Cursor model.
[Usage and limits](https://cursor.com/help/models-and-usage/usage-limits)

### What PacketBench should borrow

These are product recommendations inferred from that structure, not claims
about a provider quota API available to PacketBench:

1. **Make the effective route legible.** Before starting, show provider/model,
   execution host, permission/isolation mode, and whether billing is API-key,
   CLI subscription, local inference or a supported plan integration. Record
   parent and child routes separately.
2. **Make limits understandable at the decision point.** A compact run/usage
   disclosure should distinguish known token usage, estimated dollar cost,
   provider-reported allowance and unknown pricing. Display reset timestamps
   only when returned by a supported source. A local weekly cap is a user's
   policy, not the provider's weekly allowance.
3. **Offer deliberate effort choices after evaluation.** Fast research and
   careful implementation/review can have different policies. Show which model
   actually ran, fallback events and cost implications. Avoid invisible routing
   or a speed default that unexpectedly multiplies spending.
4. **Warn before fallback and overspend.** Preserve choices through auth probes,
   avoid switching to another billing class silently, and expose blockers as
   recoverable states. Never describe an estimated cap as a provider-enforced
   hard guarantee.
5. **Measure cost per accepted task.** Cheap tokens, rapid output and a larger
   quota do not establish successful delivery. Track the full builder/reviewer/
   repair path and the user's interruptions.

Do not revive the removed Cost Dashboard just to copy a competitor. Put the
needed information in the composer, active-run details, Settings and existing
guardrails. PacketBench cannot create another company's included allowance by
wrapping its API or reuse an unrelated application's subscription grant.

## Newly relevant: official ChatGPT plan usage

OpenAI now documents consent-based Sign in with ChatGPT, including eligible
Plus/Pro plan usage in supported apps. App usage consumes the existing plan;
app limits are caps rather than additional grants. Identity sign-in and plan
usage are separate permissions. [User-facing documentation](https://learn.chatgpt.com/docs/sign-in-with-chatgpt)

The developer route explicitly covers open-source/locally hosted apps and uses
OAuth registration, a stable host identity and explicit permission. Paid or
remotely hosted applications are directed to an interest form. PacketBench has
an Apache-2.0 license, but source availability alone does not verify account
eligibility or a completed integration. [Developer overview](https://developers.openai.com/siwc/token-sharing-open-source)

There is an official Codex app-server path with app attribution, streamed
events, saved thread IDs and token-renewal responsibilities.
[App-server integration](https://developers.openai.com/siwc/token-sharing-open-source/codex-app-server)
Preview constraints include stateless streamed Responses requests, restricted
parameters/tools and explicit token renewal; local app-server thread resume
differs from hosted conversation storage.
[Preview limitations](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations)

**Recommendation:** after the P1 reliability fixes, run a bounded feasibility
spike comparing an official app-server adapter with a direct Responses adapter.
Prefer the former if its native tool/context/recovery behavior removes more
maintenance than it adds. Require explicit consent, secure credentials, stable
per-host identity, revoke/refresh handling, real inference entitlement proof,
scope-preserving local/SSH execution, and truthful limit reporting. A successful
model catalog response alone is insufficient.

Keep the historical `api-openai-codex` row retired. Any approved implementation
needs a distinct new provider/transport identity and explicit migration choice.
Do not scrape `~/.codex` credentials. This finding does not change Anthropic's
authentication contract or authorize subscription-token reuse elsewhere.

## Could we build our own Composer 2.5 equivalent?

Cursor describes Composer 2.5 as an actual trained model built from Kimi K2.5,
with additional training, targeted feedback and harder synthetic coding tasks.
It explicitly trains communication and effort calibration too. This is more
than a system prompt and tool router. At launch it listed standard input/output
at $0.50/$2.50 per million tokens and Fast at $3/$15, with Fast the default.
The launch-week double-usage promotion is historical.
[Composer 2.5 research](https://cursor.com/blog/composer-2-5)

There are three materially different proposals:

### A. An owned PacketBench coding experience — recommended experiment

Build a versioned harness over existing strong models: repository onboarding,
selective context, explicit execution authority, reliable tools, bounded
subagents, checkpoints, independent review and delivery evidence. The provider
seam exists in [llm_provider.rs](../src-tauri/src/core/llm_provider.rs), line 9.

This can improve reliability and ergonomics without owning model weights. Call
it a PacketBench harness or profile, not an original model. Its success must
be demonstrated on held-out tasks against the same models with a baseline
harness, and against the owner's ordinary workflow where comparison is possible.
Do not promise general Composer parity from a private demonstration.

### B. A narrow adapted open-weight model — conditional later experiment

Ollama/custom adapters already provide inference seams. A useful first target
could be a read-only scout, structured review triage or context selection.
First compare a suitable existing model with a simple prompt baseline. Only
consider adaptation if a recurring failure, enough consented examples and a
clear verification signal justify it.

This needs a separately governed dataset, held-out tasks, base-model license
assessment, reproducible training, serving/quantization operations and ongoing
regression work. Do not assume desktop hardware can train or serve the same
class of base model. Record real memory/latency/cost measurements before choosing
compute. Do not train on secrets, private code without permission or opaque
provider reasoning envelopes.

### C. A frontier coding model — separate undertaking

No training/weight infrastructure was found in this repository. Pretraining and
large-scale post-training would require a model team, data program, distributed
infrastructure, evaluation and serving operations. Neither a credible budget
nor an attainable quality level can be inferred from this repo review. Do not
make this the dependency for fixing the app people use today.

## Runtime findings

### H1 — P2: Evaluate the production executor

The main native loop is private and tied to `tauri::AppHandle`
([api_agent.rs](../src-tauri/src/commands/api_agent.rs), line 2363).
Product gates in [package.json](../package.json), line 50, do not constitute a
versioned task-quality benchmark. Extract an injectable event sink/provider
boundary and run the **same executor** headlessly; do not build a second loop.

Acceptance: an initial proposed 20–30 representative tasks, three trials per
configuration, pinned starting commits, isolated workspaces, independent hidden
checks, budgets, and machine-readable correctness/cost/time/intervention
results. Infrastructure failures and unfinished runs remain separate outcomes.
These numbers define a proposed starter experiment, not completed measurements.

### H2 — P1: Durable typed continuation

Live transport preserves opaque `ProviderReasoning`
([llm_types.rs](../src-tauri/src/core/llm_types.rs), line 78).
Restart uses role/content DTOs and plain-text reconstruction
([api_agent.rs](../src-tauri/src/commands/api_agent.rs), lines 363 and 418),
with truncated tool prose from [agentTaskStore.ts](../src/stores/agentTaskStore.ts),
line 484. Current semantic continuation is not exact runtime replay.

Persist a versioned typed checkpoint with tool IDs/results, opaque provider
state, provider/model identity and frozen policy/tool snapshot. Keep a clearly
labelled lossy fallback for unsupported transports. Acceptance: restart after
a tool result preserves correlation without executing completed tools again;
incompatible model/provider/policy state is rejected or explicitly continued
as a fresh run. Define retention and redaction before persisting more data.
Also inject a crash after a mutating tool succeeds but before its result is
durable: reconcile observable state or report an unknown outcome, never blindly
replay the tool. A checkpoint alone cannot guarantee exactly-once side effects.

### H3 — P2: Context selection and compaction

The native loop clones full history and uses fixed output/thinking allowances
([api_agent.rs](../src-tauri/src/commands/api_agent.rs), lines 2477–2494).
Restart keeps the latest 80 messages inside 120,000 characters and 4,000-character
tool summaries ([agentTaskStore.ts](../src/stores/agentTaskStore.ts), line 474).
Automatic prompt injection deliberately excludes broad codebase scans
([memoryStore.ts](../src/stores/memoryStore.ts), line 164).

Add window-aware accounting, output reservation, pinned objectives/constraints,
revision-aware retrieved excerpts and compaction provenance. Acceptance: long
fixtures stay within the chosen model window, preserve unresolved work and
instructions, and identify every excerpt's path/revision. Retrieval must improve
held-out outcomes or lower usage without hurting correctness.

### H4 — P1: Request-level budget admission

Frontend admission occurs once per user turn
([agentTaskStore.ts](../src/stores/agentTaskStore.ts), line 390;
[costGuardrailStore.ts](../src/stores/costGuardrailStore.ts), line 166).
A native turn can make 150 iterations; its internal check verifies accounting
health, not a shared in-flight spend reservation
([api_agent.rs](../src-tauri/src/commands/api_agent.rs), lines 30 and 2509).

Admit each backend model request with conservative reservations and reconcile
actual usage across parent/children. Preserve durable accounting and unknown
pricing. Acceptance: parallel requests cannot spend the same remaining budget;
a later iteration stops before dispatch when allowance is exhausted. SDK paths
that hide internal requests must describe the actual cap strength accurately.
Cover cancellation, failed/abandoned requests, missing final usage and restart
with outstanding reservations. Reconcile or release conservatively so allowance
cannot disappear or remain permanently blocked; define the unpriced-route policy.

### H5 — P2: Model capabilities as a contract

Live catalogs include context/output limits and pricing
([provider_models.rs](../src-tauri/src/commands/provider_models.rs), line 87).
Common requests still expose provider-specific thinking fields and potentially
ignored attachments ([llm_types.rs](../src-tauri/src/core/llm_types.rs), line 154).
Add versioned known/unknown capability records for tools, vision, reasoning,
structured output, context and resumability. Acceptance: unsupported requested
behavior fails before dispatch; unknown remains explicit; compatible native/SDK
routes pass common contract fixtures. Avoid silently dropping image inputs.

### H6 — P2: Attribute outcomes to the harness

The static prompt ([agent-harness.ts](../src/lib/agent-harness.ts), line 13)
and editable profiles ([profiles.ts](../src/types/profiles.ts), line 12) are not
a reproducible run identity. Usage rows carry provider/model/session/token/cost
fields, not full harness/context/request/outcome attribution
([usage.rs](../src-tauri/src/commands/usage.rs), line 23).

Save a run manifest with harness/tool-policy hashes, endpoint/model, repository
revision, context version and parent/child request IDs; link redacted timings
and outcome grades. Acceptance: every experiment resolves to its exact manifest
after settings change. Keep source/secrets and opaque reasoning out of exported
training examples by default.

### H7 — P2: Explicit subagent roles and routing

The read-only native subagent boundary and parent-attributed usage are useful.
However, a model override is advertised but ignored, and outputs are constrained
to a paragraph ([tool_subagent.rs](../src-tauri/src/core/tool_subagent.rs),
lines 89 and 106). Cheap-tier mappings live in
[aux_llm.rs](../src-tauri/src/core/aux_llm.rs), line 286; custom-agent model pins
already exist in [tool_custom_agent.rs](../src-tauri/src/core/tool_custom_agent.rs),
line 153.

Unify scout/reviewer contracts with validated routing, child budgets, structured
findings/evidence/incomplete status and visible identity. Acceptance: no ignored
configuration; invalid routing fails before spending; budget exhaustion remains
incomplete; delegation is adopted when measured benefit exceeds its overhead.

### H8 — P2: Browser and desktop verification need an explicit integration

The native catalogue provides file/shell/search/HTTP/task/subagent/Git tools
([tool_runtime.rs](../src-tauri/src/core/tool_runtime.rs), line 125).
`web_fetch` neither executes JavaScript nor reaches localhost/private addresses
([tool_web.rs](../src-tauri/src/core/tool_web.rs), lines 26 and 80).
The OpenAI SDK adapter supplies file/shell/search plus configured MCP
([openai-agents.ts](../agent-sidecar/src/providers/openai-agents.ts), line 466).
Claude SDK tools remain SDK-managed. PacketBench supplies no dedicated
browser/desktop validation integration; configured MCP or external commands
can supply such capabilities today. Image inputs do not imply screen control.

Evaluate an optional supported browser-testing adapter before native desktop
control. Require scoped local-app access, screenshots/DOM evidence tied to a
run and explicit tool authority. Do not weaken web_fetch SSRF protection to
turn it into a browser. Acceptance: a fixture UI defect can be reproduced,
fixed and verified in the actual rendered app, with failure artifacts. Any
future desktop controller must visibly release control after short bursts,
retain user interruption and avoid holding control through builds or waits.

### H9 — P2: Normalize the quota evidence that actually exists

API usage rows/completion events expose tokens/cache/USD, not plan/reset/window
metadata ([usage.rs](../src-tauri/src/commands/usage.rs), line 23;
[llm_types.rs](../src-tauri/src/core/llm_types.rs), line 128).
The Anthropic SDK can emit rate_limited/retryAfterSeconds
([protocol.ts](../agent-sidecar/src/protocol.ts), line 382), but Rust logs rather
than models that state ([handler.rs](../src-tauri/src/commands/agent_sidecar/handler.rs),
line 872).

There is already a narrower PTY Codex signal: primary/secondary used_percent
([codex.rs](../src-tauri/src/commands/statusline/codex.rs), lines 13 and 219),
with primary usage visible on hover
([CodexStatusBar.tsx](../src/components/session/CodexStatusBar.tsx), line 63).
No reset/window/plan identity is supplied there, and missing percentages default
to zero. Do not describe PacketBench as having no quota signals at all; do not
interpret a missing value as a full allowance.

Add optional provenance, observed time, stale/unknown state, billing identity
and supported reset/window fields to a usage disclosure. Acceptance: absent
signals stay unavailable, stale readings are labelled, retry delays cannot
masquerade as quota resets, and one CLI account's percentage never becomes
another API provider's allowance. Extend existing controls; no new billing
dashboard is required.

## Agents journey findings

The shared composer, per-conversation text drafts, inline permissions, hunk
review/Viewed markers and explicit Workspace/Flight handoffs are worth keeping.
The following defects make the surrounding experience unreliable.

### F1 — P1: Failed isolation silently becomes project-root execution

[launchConversation.ts](../src/lib/launchConversation.ts), lines 249–268,
continues after a worktree creation failure. The warning expires after five
seconds ([AgentsView.tsx](../src/components/views/AgentsView.tsx), line 96).
Fail the isolated launch; offer persistent Retry or an explicit project-checkout
choice. Acceptance: failure starts no agent, makes no root edits and retains
the user's prompt/context. This is separate from the repaired Flight path.

### F2 — P1: Attachment staging lacks conversation identity

Agents reuses the pane/composer across selected IDs
([AgentsView.tsx](../src/components/views/AgentsView.tsx), line 177;
[AgentChatPane.tsx](../src/components/agents/AgentChatPane.tsx), line 489), while
[useAttachmentStaging.ts](../src/components/agents/hooks/useAttachmentStaging.ts),
line 26, keeps unscoped component state. Source predicts screenshots can follow
navigation to another project; this was not reproduced through native input.
Unsupported/oversized images also lack adequate visible rejection feedback.

Key the entire draft, including attachments, by conversation/launch context.
Acceptance: A's screenshot never appears in B and is retained on return to A;
rejected attachments show a useful reason.

### F3 — P1: Fork and Restore have misleading history semantics

The UI calls Edit & resend a fork
([MessageList.tsx](../src/components/agents/chat/MessageList.tsx), line 452).
The store truncates the same conversation ID and clears later state
([agentTaskStore.ts](../src/stores/agentTaskStore.ts), line 1686).
Restore repeats that mechanism without restoring files.

Create a real child thread for Fork. Name transcript-only rewinding precisely
and disclose current-file behavior; restore files only with a real checkpoint.
Acceptance: the original conversation survives editing an earlier prompt;
rewind previews exactly what messages/files change.

### F4 — P2: Launch lacks a stable preparation transaction

Late auth probes overwrite selection
([AgentsView.tsx](../src/components/views/AgentsView.tsx), line 119).
The composer's duplicate-send latch lasts 500 ms while preparation is asynchronous
([Composer.tsx](../src/components/agents/composer/Composer.tsx), line 472).
Protect explicit choices and expose Preparing → Starting → Running with a
single-flight operation. Acceptance: delayed probes never replace a manual
selection; repeated Enter creates one worktree/conversation during slow startup.

### F5 — P2: Project grouping follows execution paths

[AgentSidebar.tsx](../src/components/agents/AgentSidebar.tsx), lines 49–55,
groups local worktrees separately and identifies SSH groups by server.
New agent deselects the thread but retains global selectedRepo
([AgentsView.tsx](../src/components/views/AgentsView.tsx), line 132).
Group by base project; show worktree/branch per thread and repository plus host
for SSH. Add contextual New agent. Acceptance: two worktrees remain under one
project; two repositories on one server are distinguishable; New confirms scope.

### F6 — P2: Attention links can leave the blocker covered

Full-screen review overlays the transcript
([AgentChatPane.tsx](../src/components/agents/AgentChatPane.tsx), line 458).
Global attention only selects/routes
([sessionGlue.ts](../src/stores/sessionGlue.ts), line 113); the header count is
passive ([TileHeaderActions.tsx](../src/components/agents/chat/TileHeaderActions.tsx),
line 146). Reveal/focus the exact permission/edit through one attention command.
Acceptance: approval arriving during diff review can be opened from every
attention affordance, then the original review position can be restored.

### F7 — P2: Search and navigation lose the place in the work

Content search returns ordinary thread rows without excerpt/turn navigation
([AgentSidebar.tsx](../src/components/agents/AgentSidebar.tsx), line 63).
Scroll tracking resets on selection
([useScrollState.ts](../src/components/agents/hooks/useScrollState.ts), line 62).
Filters call idle Active and failed Done (sidebar line 189).
Return matching-turn excerpts, restore reading position and use distinct Running,
Needs you, Failed and Finished states. Acceptance: a search opens the exact old
turn; switching threads restores its reading position with Jump to latest.

### F8 — P2: Composition and history recall can damage a draft

[buildComposerKeyboardHandler.ts](../src/components/agents/composer/buildComposerKeyboardHandler.ts),
lines 161–184, submits without an IME guard and replaces/clears the current draft
through history navigation. Ignore shortcuts during composition and retain the
pre-history draft. Acceptance: Japanese/Chinese candidate confirmation cannot
send partial input; leaving history restores the original multiline draft.

## Typography and GUI findings

### V1 — P1: Raise the default reading scale

[index.css](../src/index.css), lines 49–56, defines UI 11/16px, metadata 10/14px,
transcript 13/21px and chips 11.5/16px. The composer uses the transcript token
([Composer.tsx](../src/components/agents/composer/Composer.tsx), line 630);
Settings has 9px navigation labels
([ToolsView.tsx](../src/components/views/ToolsView.tsx), line 182).

Proposed comfortable defaults: transcript **15/24px**, composer **15/22px**,
UI/sidebar **13/20px**, metadata/chips **12/16px**, code **13/20px**. Offer larger
reading sizes and keep compact density optional. These are design proposals,
not measured Codex font values. Acceptance: ordinary actionable information
is at least 12px and computed styles consistently follow shared tokens.

### V2 — P1: Fix meaningful text contrast in both themes

Calculated from solid foreground/background tokens in index.css: dark faint
`#5e5e66` on primary `#0f0f10` is **2.982:1**; light muted `#9d9db5` on white is
**2.650:1**; light faint `#b9b9c8` on white is **1.938:1**. These calculations
are not a whole-screen accessibility audit; opacity/background changes require
additional checks. Faint/muted tokens carry thinking, usage and timestamps
([ThinkingBlock.tsx](../src/components/agents/ThinkingBlock.tsx), line 46;
Composer line 788; AgentSidebar line 322).

For normal-sized informative text, use at least 4.5:1 against its actual surface;
reserve faint treatment for decoration. This follows W3C's contrast guidance,
including helper/placeholder text. [W3C contrast](https://www.w3.org/WAI/WCAG22/Understanding/contrast-minimum.html)
Acceptance: both themes, actual backgrounds and opacity modifiers pass.

### V3 — P1: Provide text size and UI scale controls

[ThemeSettingsCard.tsx](../src/components/views/tools/ThemeSettingsCard.tsx),
line 15, offers themes only. Transcript density controls tool expansion
([AgentSettingsCard.tsx](../src/components/views/tools/AgentSettingsCard.tsx),
line 142); [agentSettingsStore.ts](../src/stores/agentSettingsStore.ts), line 43,
has no persisted display scale. Pane zoom means maximize, not larger text.
Add Appearance size/scale with preview, reset and keyboard shortcuts.
Acceptance: independent from verbosity, persisted after restart, and primary
controls remain usable at 125%, 150% and 200%. Native default zoom is unverified.

### V4 — P2: Unify code typography and syntax themes

[MarkdownRenderer.tsx](../src/components/common/MarkdownRenderer.tsx),
lines 72 and 107, uses oneDark and inline font overrides; index.css line 191
adds separate 11.5px Agent code rules. Computed output must be checked rather
than assuming all code resolves to 11px. Use one scalable mono token and a
theme-aware palette. Acceptance: default 13/20px code follows settings and is
readable in Light as well as Dark mode; horizontal code scrolling remains.

### V5 — P2: Enlarge action targets without enlarging every icon

Sidebar actions combine 10px glyphs and 2px padding (about 14px targets), with
roughly 18px filters (AgentSidebar lines 330 and 386). Composer mic is about
20px and Send/Stop 28px (Composer lines 642–708). Proposed product targets:
32px routine actions, 36px primary Send/Stop, 32–36px navigation rows.
These are recommendations, not the WCAG minimum; W3C specifies 24 CSS pixels
with defined exceptions/spacing alternatives.
[W3C target size](https://www.w3.org/WAI/WCAG22/Understanding/target-size-minimum.html)
Acceptance: bounding boxes/spacing remain usable at enlarged text sizes.

### V6 — P2: Name actions and reveal keyboard focus

[Tooltip.tsx](../src/components/ui/Tooltip.tsx), line 102, adds descriptions,
not accessible names. Stop/mic (Composer lines 639–704), Retry/Save-to-memory
(MessageList line 563) need explicit names. Code Copy is hover-revealed without
focus-within visibility (MarkdownRenderer line 66). Acceptance: keyboard users
can see and identify each action; accessibility trees expose useful names.

### V7 — P2: Make the sidebar readable and resizable

AgentSidebar line 362 fixes width at 252px. Titles are small/truncated; the
tooltip contains provider/status rather than the complete title (line 306),
and useful metadata disappears on hover/focus. Start around 280–300px, allow
resize, show complete title disclosure and keep a stable action lane.
Acceptance: similar long titles can be distinguished without opening threads;
resize preference persists and focus preserves useful metadata.

### V8 — P2: Adapt execution context at narrow widths

[ContextStrip.tsx](../src/components/agents/composer/ContextStrip.tsx),
lines 21 and 92, combines nonshrinking chips with overflow-hidden. Tooltips wrap
nonfocusable spans. Header status vanishes below 340px
([conversation-tile.css](../src/styles/conversation-tile.css), line 19), while
header height stays 33px (AgentChatPane line 329). Provide a second row or a
focusable context disclosure; keep host/permission state identifiable.
Acceptance: at 320/480/680px tile widths and larger text, host/project/branch
and Send/Stop remain accessible on native Windows and Mac.

### Font choice

Inter 400–700 is already bundled (index.css lines 1–4) with system fallbacks
(line 19). A new sans font is not the first intervention. Offer an optional
native-system stack only after comparing the same comfortable size/contrast.
The mono stack in [tailwind.config.ts](../tailwind.config.ts), line 44, and
[useXterm.ts](../src/hooks/useXterm.ts), line 27, depends on installed fonts.
Bundle a chosen mono font or explicitly test fallbacks such as ui-monospace,
SFMono-Regular, Menlo and Consolas. Do not assume Cascadia or SF Mono exists.
Check punctuation, italics, CJK/emoji fallback and scaling on both operating
systems; Mac rasterization is an open acceptance item.

## What “feels like Codex” should mean here

Official Codex documentation emphasizes project/chat organization, returning
to work and explicit worktree context. [Projects and chats](https://learn.chatgpt.com/docs/projects)
Its review pane supports repository scopes, line-specific review and Viewed
markers tied to displayed revisions. [Code review](https://learn.chatgpt.com/docs/code-review)
Its documented Windows/Mac commands include text enlargement/reset, command
navigation, sidebar control, review access and attention navigation.
[Keyboard commands](https://learn.chatgpt.com/docs/reference/commands#keyboard-shortcuts)
These are verified documented affordances, not measurements of Codex's fonts,
animation, latency or the user's exact installed version.

PacketBench has related building blocks. The gap is continuity: a stable
project identity, obvious next action, retained drafts/reading position, readable
conversation, attention that opens the actual blocker, and review that doesn't
hide the agent asking for input. Copy those interaction principles rather
than adding every capability of a broad assistant workspace.

Keep the calm dark surfaces and restrained color. Preserve a readable chat
measure around the existing 680px default; do not stretch prose across the
entire monitor just because space exists. Use the remaining width deliberately
for an optional adjacent diff/file, or keep a centered reading surface. Give
the user control of sidebar width, text scale and review layout. Empty space
alone is not a defect; tiny, low-contrast useful content is.

Desired journey: choose a stable project → write with visible host/model/scope →
see one preparation state → follow progress or switch away → open the exact
attention request → inspect changes/checks → continue/repair/deliver → archive.
Workspaces remain the daily CLI surface; Agents provides a dependable structured
conversation; Flights adds explicit work-unit review and delivery. Do not
silently turn every chat into an autonomous Flight.

## Recommended order and proof before claiming parity

1. **Reliability and history protection:** isolate N1, then F1–F3 and H2/H4
   continuation/budget safety; protect preparation and composition in F4/F8.
   Preserve existing user work throughout. Independent GUI work can proceed
   alongside runtime repairs; P1 safety is not deferred behind P2 polish.
2. **A comfortable default experience:** V1–V3 first, then shared code scale,
   action names/targets, responsive context and stable sidebar. Reconcile the
   local AGENTS/CLAUDE compact-font guidance if implementation is authorized.
3. **Continuity:** F5–F7, attention focus, thread reading position, contextual
   New and adjacent review. Validate the whole journey rather than screenshots
   alone.
4. **Runtime context and capability contracts:** build H3/H5 on the earlier
   H2/H4 checkpoint/budget work. Keep existing Flight invariants intact.
5. **Measured differentiation:** H1/H6 evaluation and attribution, then H7
   routing experiments and the official ChatGPT-plan feasibility spike.
6. **Model adaptation only after evidence:** investigate a narrow role if the
   benchmark shows an unresolved, economically meaningful gap. Frontier training
   remains a separate proposal.

For acceptance, record the actual OS/app/source/hash, display scale, window size
and provider/transport. Exercise Windows 100/125/150/200% text/UI scale and Mac
Retina/non-Retina environments actually available; do not infer native Mac
parity from Chromium tests. Include light/dark, keyboard-only and screen-reader
checks; long titles/code, CJK composition, long transcripts and narrow panes.

Complete one ordinary local task and one pinned SSH task through start,
steering/Stop, restart/continue, approval, review, repair, delivery and archive.
Record launch/preparation time, time to first useful output, interruptions,
lost context/drafts, recovery success and actual priced/unpriced usage. Compare
with the owner's ordinary Codex workflow on matched tasks and settings. Use
outcomes and concrete usability observations; do not invent a parity percentage.

For this review, validation consists of source review, primary-source research,
contrast calculation, link/file checks and documentation formatting. The prior
Flight gates remain historical proof of that source. They were not rerun or
promoted into evidence for unimplemented recommendations. No new app build or
installation is required for these documentation changes.

Documentation checks: all 62 relative source/document links resolve; the new
report passes the installed Prettier formatter; `git diff --check` passes.
