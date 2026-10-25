# Local Model Routing (Ollama-first)

Status: **IN PROGRESS** — LM1 shipped (barring picker gating), LM3 partial,
LM5 done, LM7 needs re-specifying (its target view was deleted)
Created: 2026-07-30
Owner decision recorded: 2026-07-30
Last updated: 2026-08-28

## Decision record

The prompt behind this doc was: *should PacketBench build a Cursor-style
hosted-model stack (API gateway + our own inference + our own trained model),
or invest in local models instead?*

Three separable layers were considered:

| Layer | Description | Verdict |
| --- | --- | --- |
| **A. API gateway** | Auth, routing, key custody, billing in front of someone else's inference | **OUT** — commodity; makes us a worse OpenRouter and puts us in the uptime/billing/abuse path for no differentiation |
| **B. Own inference hosting** | vLLM/SGLang/llama.cpp on owned or rented GPUs | **OUT as a product.** Available for free as a *config* via layer A of this plan (a custom OpenAI-compatible base URL) |
| **C. Own trained model** | RL/fine-tune against our own harness traces (Cursor's actual moat) | **OUT** — revisit only if a large corpus of PacketBench harness traces with outcome labels ever accumulates |

**Chosen direction:** neither "be Cursor" nor "run the main coding agent
locally". Instead: **per-task-class routing.** PacketBench makes ~15 distinct
auxiliary LLM calls across the product (commit messages, issue triage, PR
descriptions, code-quality explanations, memory ops, spec parsing, side chat).
These are short-context, single-shot, structured-output tasks that a 7–14B
local model handles fine. The agentic coding loop stays on frontier models.

The differentiator is *"PacketBench spends real money only on the hard agentic
turns and runs the other twenty calls an hour on your own hardware"* — offline,
zero marginal cost, no data egress. No competitor in `dev/competitors.md` does
per-task-class routing.

Running the *main* agentic loop on a local model remains out of scope. Long
tool loops with MCP, subagents, and worktree attempts punish small models
exactly where they are weakest.

## Audit: how auxiliary surfaces currently reach a model

Performed 2026-07-30 against `src-tauri/src`. **This audit invalidated the
initial scoping assumption** that routing was a one-argument change to
`get_provider`. There are three independent mechanisms, and only one of them
passes through that seam.

### Mechanism 1 — in-process `LlmProvider`

Dispatch: `core/llm_provider.rs:35` `get_provider(name)`.
Credential: OS keyring `api-key-{provider}`.

| Call site | Surface | Provider / model |
| --- | --- | --- |
| `commands/api_agent.rs:1697,1793` | User conversation tiles | **dynamic** — session-selected |
| `commands/side_chat.rs:19-20,105` | Side Chat | `anthropic` / `claude-haiku-4-5` |
| `commands/github.rs:2193-94,2564,2761` | GitHub catch-up (2 sites) | `anthropic` / `claude-haiku-4-5` |
| `core/tool_subagent.rs:18,266` | Subagent tool | `anthropic` / `claude-haiku-4-5` |
| `core/tool_custom_agent.rs:15,151` | Custom-agent tool | `anthropic` / `claude-haiku-4-5` |

`api_agent.rs` is already fully routable. The other four are hardcoded.

### Mechanism 2 — sidecar one-shot

Dispatch: `SidecarManager::forward_start(...)` with a `claude-oauth` provider
string. **Never touches `get_provider`.**
Credential: `~/.claude/.credentials.json` OAuth (Claude Pro/Max subscription).

| Call site | Surface | Provider / model |
| --- | --- | --- |
| `commands/code_quality.rs:484-85` | Explain error, summarize | `claude-oauth` / `claude-sonnet-4-6` |
| `commands/github.rs:1601-02` | PR description, PR review | `claude-oauth` / `claude-sonnet-4-6` |
| `commands/issues.rs:75,79` | Spec import | `claude-oauth` / `claude-sonnet-4-6` |

These deliberately draw on the subscription rather than metered API credit.
Any routing design must preserve that as an option, not silently move these
onto a metered key.

### Mechanism 3 — Claude CLI shell-out

Dispatch: `claude/binary.rs::run_claude` (`claude -p --output-format text`),
or `claude_command()` directly for streaming. **No provider abstraction at
all** — a hard runtime dependency on the `claude` binary being on `PATH`.

| Call site | Surface |
| --- | --- |
| `commands/memory.rs:11,28,43,106` | Four memory operations |
| `commands/insights.rs:72-93` | Agent chat stream (streaming variant) |
| `commands/spec.rs:4,54` | Parse spec → flight, parse spec → tickets |
| `commands/github.rs:1577` | Investigate issue |

This is the weakest tier: no streaming for `run_claude`, no token accounting,
no cost attribution, and it silently fails on machines without the CLI. These
sites are also the *easiest* to migrate — they are pure text-in/text-out.

### Summary

~15 auxiliary call sites. **4 sit behind `get_provider`; 11 do not.**
Task-tier routing therefore requires a unifying auxiliary entry point first —
it is not a signature change.

## Known defects blocking local-model viability

1. **No `num_ctx`.** — **FIXED 2026-07-31 (LM1).**
   `core/llm_openai_compat.rs::stream_chat_compat` sent only
   `messages` / `max_tokens` / `stream`. Ollama's OpenAI-compatible endpoint
   defaults to a small context (4096 on current builds, 2048 historically) and
   **silently truncates the front of the conversation** rather than erroring.
   This presented as "the local model forgets the system prompt" or "loops on
   tools" and was a config fault, not a model-quality one.
   `contextWindow` in `src/lib/api-models.ts:13,163` is display metadata only
   and is still never sent — the value now comes from the daemon instead.
2. **No `keep_alive`.** — **FIXED 2026-07-31 (LM1).** Every call risked a
   multi-second model reload.
3. **No tool-capability detection.** — **PARTIALLY FIXED 2026-07-31 (LM1).**
   Many Ollama models ship without a tools template. The backend now probes
   `/api/show` and refuses a tool-carrying request to a model whose
   `capabilities` lack `tools`, with a message naming the model — so it fails
   in one clear line instead of at the first tool call. **The picker is still
   ungated**: `ProviderPicker` / the model dropdown still offer tool-incapable
   models for an agent tile. That gating is the remaining LM1 item, tracked as
   **F-2.3-15** in
   [`docs/reports/state-of-the-ade-2026-07-30.md`](https://docs.ianlan.dev/reports/state-of-the-ade-2026-07-30.md).

   The obstacle is that `list_ollama_models` reads `/api/tags`, which returns
   **no capability data at all** — name, size, digest, modified date, and a
   `details` block, nothing about tools. Gating therefore needs a second call
   per model. Two shapes, both viable: fan out `/api/show` at list time (local
   and fast, but N round trips, so cache per (endpoint, digest) — the digest
   changes when the model does, so it is a safe cache key), or probe lazily on
   selection and disable the row after the fact, which is worse UX for one
   saved round trip. Prefer the first. The `/api/show` probe and its
   process-lifetime cache already exist in `core/llm_ollama.rs`; the work is
   exposing them to `commands/ollama.rs` and carrying a `supportsTools` flag
   into the model list the frontend renders.

Fixing (1) and (2) required Ollama's native `/api/chat` route; neither fits the
OpenAI-compat shim, so `core/llm_ollama.rs` (previously a 40-line passthrough)
grew a real second code path.

## Phased plan

### LM1 — Ollama fundamentals

**SHIPPED 2026-07-31**, except picker gating (see defect 3 above).

`core/llm_ollama.rs` is no longer a passthrough: it speaks Ollama's **native
`/api/chat`** route, which is the only mechanism that can carry these options.
Ollama's docs are explicit that the OpenAI-compatible route cannot — *"The
OpenAI API does not have a way of setting the context size for a model"*
([openai-compatibility](https://docs.ollama.com/api/openai-compatibility)); the
options live in `options` / top-level `keep_alive` on
[`/api/chat`](https://docs.ollama.com/api/chat).

What shipped:

- **`options.num_ctx`**, derived per model rather than hardcoded. `/api/show`
  is probed once per (endpoint, model) and cached for the process; the trained
  window comes from the `*.context_length` key in `model_info`, falls back to
  8192 when the daemon does not report one, and is clamped by a user cap that
  defaults to **16384** (~2 GiB of KV cache for a 7–8B GQA model — what fits
  beside a q4 model on an 8 GB card, and 4x Ollama's own default). The model's
  own window always wins when it is smaller: exceeding it degrades quality via
  rope scaling. The value deliberately does **not** vary with prompt size —
  changing `num_ctx` forces a reload, which would defeat `keep_alive`.
- **`keep_alive`**, default **`30m`** (Ollama's own default of `5m` expires
  inside a normal agent loop, and every expiry is a cold reload).
- **Overrides**: persisted in provider settings, edited in Settings → Tools →
  Provider Endpoints (`ProviderEndpointsCard`), commands
  `get_ollama_runtime_options` / `set_ollama_runtime_options`, env fallbacks
  `PACKETBENCH_OLLAMA_NUM_CTX_CAP` / `PACKETBENCH_OLLAMA_KEEP_ALIVE`.
- **Truncation is surfaced, not swallowed.** Ollama has no truncation field, so
  it is inferred from `prompt_eval_count >= num_ctx` (authoritative) or a
  content-length estimate over `num_ctx` (the backstop, since a warm KV cache
  under-reports `prompt_eval_count`), and `done_reason == "length"` for the
  output side. Each emits a `tracing::warn` **and** appends a visible notice to
  the turn naming `num_ctx` and pointing at the settings row.
- **Tool-capability pre-flight**: a tool-carrying request to a model whose
  `/api/show` capabilities lack `tools` fails with a one-line explanation.
- **Fallback**: an endpoint that 404s `/api/chat` still works via the old
  OpenAI-compat route, which logs loudly that `num_ctx` cannot be set there.

Wire-format differences the native route imposed: NDJSON instead of SSE; tool
calls arrive complete with **no id** (we synthesise `ollama-{name}-{n}`) and
arguments as an object; tool results replay by `tool_name`, so ids are mapped
back to names from the assistant turns in history; images ride as bare base64
in `images: []`; usage is `prompt_eval_count` / `eval_count` with no cache
bucket.

**Done first.** Everything downstream was worthless while local inference
silently truncated.

### LM2 — Custom OpenAI-compatible endpoint

New provider row + `CustomCompatProvider` wrapping `stream_chat_compat` with a
user-supplied `base_url`, optional keyring key, and manual model list. Touches
`core/llm_provider.rs` dispatch, a new provider file, `src/lib/api-models.ts`,
the `AgentCli` union in `src/stores/agentTaskStore.ts`, and the auth-status
probe.

One row covers vLLM, LM Studio, LiteLLM, Together, Fireworks, an SSH-tunnelled
box, and any future endpoint — including a self-hosted gateway, which is how
layer B above stays available without being built as a product.

### LM3 — Unified auxiliary LLM entry point

**PARTIALLY SHIPPED 2026-07-31** as WI-1 of
[`oauth-removal-plan.md`](./oauth-removal-plan.md). `core/aux_llm.rs` now
exists with `AuxTaskClass`, a pure `resolve_aux_route`, `run_aux_oneshot`
(blocking text) and `spawn_aux_stream` (emits `api-agent:chunk|done|error`).
Five task classes are modelled — `spec-import`, `code-quality-explain`,
`code-quality-summarize`, `pr-description`, `pr-review` — covering every
mechanism-2 site, so **LM5 is done too**. Settings live in
`src/stores/routingStore.ts` and are mirrored into a Rust `AuxRoutingState`;
LM6's routing UI exists for these classes in `ProviderRoutingCard`.

Still to do here: extend `AuxTaskClass` to the remaining surfaces (memory ops,
insights, side chat, catch-up, subagent, custom agent) and migrate the
mechanism-1 and mechanism-3 sites onto it (LM4).

Note the seam deliberately has **no sidecar branch**: subscription-OAuth
routing for auxiliary work is what WI-1 removed, so `run_aux` selects only
among in-process `LlmProvider` ids with a keyring credential. §7.4 of the OAuth
plan settles the conflict with LM5's original wording below.

This is the load-bearing phase. It is what the initial scoping missed.

### LM4 — Migrate mechanism-3 sites

Move `memory.rs`, `insights.rs`, `spec.rs`, and `github.rs:1577` off
`run_claude` onto `aux_llm`. Removes the hard `claude`-on-PATH dependency and
brings four surfaces into token accounting for the first time. Easiest
migration; do before LM5.

**Status 2026-08-28.** `spec.rs` and the pure-text memory turns landed as
3C-2. `memory.rs` is now fully migrated (3C-3 memory half, below). The two
survivors are `github.rs::github_investigate_issue` (`run_claude`) and
`insights.rs::ask_agent_chat_stream` (`claude_command`, streaming).

#### 3C-3 memory half — DONE 2026-08-28

`scan_codebase_memory` never needed the model to *decide* what to read: "list
the key files with one-line summaries" is a deterministic walk followed by one
turn. `core/aux_context.rs` does the walk in Rust and the command runs a single
`memory-scan` turn over the rendered manifest. `memory.rs` no longer imports
`claude::binary` at all.

Assembly contract:

- **Rooted and symlink-free.** The walk canonicalizes the project path and
  descends only into real directories beneath it. Symlinks — and Windows
  junctions, which `FileType::is_symlink` also reports — are *skipped, never
  followed*, for files as well as directories, so a link cannot be used to
  reach outside the root. Each file is canonicalized again immediately before
  it is opened and re-checked against the root, closing the walk→read TOCTOU
  window. Non-regular files (FIFOs, sockets, devices) are ignored.
- **Refusals.** Dot-entries, `core::shared::SKIP_DIRS`, secret-shaped names
  (key/cert extensions, `id_rsa*`, `*credential*`/`*secret*`/`*password*`, and
  ambiguous stems like `tokens`/`auth`/`keys` when paired with a data
  extension), and binary content (NUL byte in the head) — binaries may be
  listed by path but are never excerpted.
- **Bounds.** Depth 12; 20 000 directory entries visited; 400 files listed; 60
  files excerpted; 2 KiB per excerpt; 512 KB max size to be excerpt-eligible;
  192 KB total assembled payload; 10 s wall clock. Every bound degrades to a
  truncated manifest that says so in the rendered text, never to a silent
  partial result.
- **Fails closed on routing.** The command resolves the `AuxRoute` *before*
  touching the filesystem, so a user with no configured provider gets
  `no_provider_error` and nothing is read from disk, let alone sent anywhere.
  `AUX_PROVIDERS` membership already guarantees no subscription-OAuth path.

#### 3C-3 tool-loop half — still open

`github_investigate_issue` and `ask_agent_chat_stream` cannot pre-compute their
context: which files matter depends on the issue or the question. They need the
bounded read-only loop. Most of it exists: `core::tool_subagent::run_agent_loop`
already caps at 8 iterations, advertises only `read_file` / `list_directory` /
`grep` / `web_fetch` via `read_only_tool_definitions`, and dispatches through
`tool_runtime::execute_tool`, whose `resolve_workspace_path` enforces the same
canonicalized workspace confinement plus a 2 MB per-file and 256 KB per-output
cap.

What it lacks for aux use:

1. **`AuxRoute` parameterization.** It derives provider/model from the parent
   session (`PARENT_LLM`) and falls back to a hardcoded `anthropic` /
   `claude-haiku-4-5`. An aux caller has no parent session, so the loop needs to
   accept a resolved `AuxRoute` — and reject anything outside `AUX_PROVIDERS`.
2. **Budgets beyond the iteration cap.** Total tool-result bytes and a
   wall-clock deadline, so a model that greps in circles is stopped by
   something other than iteration count.
3. **A narrower tool set.** `web_fetch` is egress and has no place in a
   codebase investigation; the aux loop should advertise the three filesystem
   tools only.
4. **Usage accounting per iteration**, so the loop's spend lands in
   `usage.jsonl` the way `run_aux_oneshot` already does.

### LM5 — Migrate mechanism-2 sites

**DONE 2026-07-31** (WI-1). `code_quality.rs`, the `github.rs` PR commands, and
`issues.rs` spec import all run through `aux_llm`.

The original wording below is **superseded** — it said to keep `claude-oauth`
selectable "so subscription-funded operation stays the default", which is the
opposite of the 2026-07-31 owner decision. Subscription OAuth is not a
selectable auxiliary route and must not become one; see
[`oauth-removal-plan.md`](./oauth-removal-plan.md) §0. The default is now the
cheapest provider the user has an API key for, and mechanism 2 no longer
exists for these features.

### LM6 — Routing settings

New `modelRoutingStore` plus a persisted settings slice mapping task class →
provider/model, with a frontier default. **Not** `orchestrationSettingsStore`,
which is flight/worktree-scoped (auto-commit trailers, autonomy policy) and
hydrates from `OrchestratorSettings` in Rust. Settings UI under the existing
six-group IA.

### LM7 — Cost surfacing and gates — **NEEDS RE-SPECIFYING (2026-07-31)**

The original wording was: *split local vs. metered spend in `CostDashboardView`
so the saving is visible and quantified — this is the feature's proof.*

**`CostDashboardView` no longer exists.** The owner removed the entire cost
*reporting* surface on 2026-07-31 (`35dcb54`) — the dashboard, the live-spend
chip, the Settings usage card, per-conversation dollars, and `/usage` — on the
reasoning that a reporting surface is not worth its maintenance cost. Cost
survives only as a **control**: budget guardrails, the bounded-autonomy
`maxTotalCost` hard-stop, the shared pricing table, and `usage.jsonl`. See
[`cost-efficiency-loop.md`](./cost-efficiency-loop.md) §0.

So LM7 cannot be "add a panel". The proof has to come from one of:

1. **A throwaway script over `usage.jsonl`**, the pattern CE3/CE4 were re-scoped
   to — a local-vs-metered split computed on demand, deleted or left dormant
   once the number is known. Cheapest, and consistent with the owner decision.
2. **The guardrails themselves** — if local routing works, metered spend per
   unit of work falls, and that shows up in cap headroom without any new UI.

Whichever is chosen, state the saving as **measured or modelled, explicitly** —
the same discipline CE6 is held to. `src/lib/api-models.ts` already has a
zero-rate guard for Ollama/free models, so local traffic will not pollute the
metered figure. The local/SSH/packaged gates are unchanged.

**Do not re-add a cost view for this.** Reversing an owner decision to prove a
feature's value is the wrong trade.

## Sequencing

**LM1 → LM2 → LM3 → LM4 → LM5 → LM6 → LM7.**

LM1 proves local inference is viable at all; LM2 generalises the endpoint;
LM3 builds the seam that LM4/LM5 migrate onto; LM6 exposes the choice; LM7
proves the value.

LM1 and LM2 are independently shippable and useful on their own. LM3 onward is
the differentiated feature and should not start until LM1 has demonstrated a
local model completing a real auxiliary task correctly.

**Sequencing note (2026-07-31):** LM3/LM5 landed ahead of LM1 via the OAuth
removal work. LM1 is now in, so the remaining gap is the one thing it could not
prove from a unit test — an end-to-end run of a real local model through
`aux_llm` against a live daemon, confirming the negotiated `num_ctx` is what
the daemon loaded and that the model is not silently starved. Do that before
LM4 migrates more surfaces onto local routes.

## Open questions

- Which task classes get a local default out of the box, versus frontier-by-
  default with local opt-in? Leaning frontier-default to avoid a quality
  regression on first run.
- Do subagent and custom-agent tools (`core/tool_subagent.rs`,
  `core/tool_custom_agent.rs`) count as auxiliary or agentic? They are
  currently Haiku, which suggests auxiliary, but they run tool loops.
- Fallback policy when the local endpoint is down mid-task: fail, or silently
  escalate to the frontier route? Silent escalation has a cost-surprise
  failure mode.
