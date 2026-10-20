# Should PacketBench develop a Composer-like coding agent?

Research date: **October 19, 2026, America/Chicago**; sources retrieved through
October 20 UTC. Repository inspected:
`e5d31084e5d2c4861723dca4d4c2931a64b0f732`. This is the same HEAD as the earlier
harness review, confirmed against the current checkout rather than assumed.
Existing working-tree changes were documentation, including the earlier review;
no application-source changes were present at the inspection checkpoint.

**Status: research and proposed experiments only.** No adapter, model training,
infrastructure, paid inference, authentication change, application build or
installation is authorized by this document. Only this report and its research
index entry are outputs of this task. Proposed implementation would require a
separate request; this document is not another task register.

Follow-up clarification: the owner is willing to consider post-training Kimi,
DeepSeek or another suitable open checkpoint for the **main coding agent**.
[Section 9](#9-follow-up-owned-main-model-through-open-weight-post-training)
assesses that route explicitly. This is broader research intent, not authorization
to train, provision resources or incur charges.
The owner subsequently selected **rented GPU servers with controlled operating
cost and an initial cash budget below $1,000, excluding owner time**. The current
model shortlist, training evidence and proposed $950 experiment are in
[Section 10](#10-budgeted-model-selection-beyond-deepseek).

## Recommendation

**Use PacketBench's owned executor to select and post-train a main coding model
in bounded stages.** PacketBench already owns most of the required harness. Make
that production executor measurable, compare the unmodified candidate, and then
test whether adaptation improves verified work. The current first candidate is
**Qwen3.8-27B**, with GLM-4.7-Flash as a conditional training backup; see Section 10
for the evidence and budget. A new agent engine is not necessary for this study.

The owner's clarified target includes an owned main coding model, not only a
scout or reviewer. A narrow role remains an optional experiment, not a substitute
for that target. The base must already supply useful coding ability; a recurring,
labelable model failure, rights-cleared data and affordable serving determine
whether post-training is worthwhile. Large-scale broad competition remains a
separate funding decision, and its earlier cost envelope is not a minimum entry
price for a bounded study against the fixed Composer 2.5 target.

The benefit worth proving is **less human effort to obtain a correct, reviewable,
recoverable change on the user's chosen local or pinned SSH project**. That means
explicit authority, useful context, checks tied to the delivered code, honest
failure states, and predictable resource use. A new provider label or system
prompt alone would not establish that benefit.

This recommendation extends the research in the
[agent/harness review](./agent-harness-and-experience-review-2026-10-19.md) and
[loop/graph assessment](./loop-and-graph-engineering-alignment-2026-10-19.md).
The historical [local-model decision](./local-model-routing.md) declined an API
gateway, inference hosting as a product, and a trained main coding model in favor
of auxiliary task routing. The owner has now reopened main-model post-training
for research. This expands the research scope; implementation, paid training and
hosting remain unapproved. GUI, typography, general Agents repairs and alternative
authentication integrations remain separate work in [the backlog](../backlog.md).

## 1. What current Composer evidence establishes

### Release status and model versus product

**Composer 2.5 shipped May 18, 2026.** Cursor identifies Kimi K2.5 as its starting
checkpoint. Its announcement describes localized textual feedback through
on-policy self-distillation, 25 times as many synthetic tasks as Composer 2,
feature reconstruction with test-based rewards, and training for communication
and effort calibration. The larger model being trained from scratch with
SpaceXAI was described as future work. That announcement does not establish a
shipped successor. [Composer 2.5 announcement](https://cursor.com/blog/composer-2-5)

At this research cutoff, the official
[Composer product page](https://cursor.com/composer) and
[model documentation](https://cursor.com/docs/models/cursor-composer-2-5) still
identify Composer 2.5. Targeted searches and checks of the
[changelog](https://cursor.com/changelog) did not find an official Composer 2.6
or Composer 3 model release.
This is bounded negative evidence, not a guarantee against unannounced work.
Cursor application versions, including Cursor 3, are not Composer model versions.
Later product releases and an announced training partnership cannot be counted
as new model releases.

The model documentation lists a 200k context window. Standard and Fast are
described as the same intelligence with different throughput/pricing; Fast is
the default. Listed dollars per million tokens are:

| Variant               | Fresh input | Cache read | Output |
| --------------------- | ----------: | ---------: | -----: |
| Composer 2.5 Standard |       $0.50 |      $0.20 |  $2.50 |
| Composer 2.5 Fast     |       $3.00 |      $0.50 | $15.00 |

These are customer billing rates within supported Cursor access, not disclosed
inference costs, a raw-model API offer, or a quote for PacketBench self-hosting.
[Current model documentation](https://cursor.com/docs/models/cursor-composer-2-5)

### Training and inference architecture: known and unknown

The March [Composer 2 technical report](https://cursor.com/resources/Composer2.pdf)
describes a 1.04T-total/32B-active MoE base, code-focused continued pretraining,
supervised fine-tuning and agentic reinforcement learning. It describes trained
self-summarization and multi-token prediction for speculative decoding;
Blackwell low-precision kernels; asynchronous training, rollout and evaluation
services; Fireworks RL inference; and isolated Anyrun coding environments.
Training tools share production implementations through a shadow backend;
evaluation pins a production backend and client.

Those are disclosures about **Composer 2**. Composer 2.5's stated lineage and
additional training do not make every predecessor implementation detail a new
2.5 disclosure. Neither source supplies released Composer weights, the complete
training corpus/recipe, total GPU-hours or a reproducible all-in training bill.
They do support an important design lesson: evaluate the actual executor and
tools, rather than an easier substitute loop.

Cursor also describes model-specific prompts, editing tools, context handling,
instruction changes, monitoring and evaluation as harness engineering.
Those can change an agent's behavior while its model stays fixed.
[Cursor harness engineering, April 30](https://cursor.com/blog/continually-improving-agent-harness)
Its [real-time RL article, March 26](https://cursor.com/blog/real-time-rl-for-composer)
describes a separate production-feedback/checkpoint pipeline. Product feedback
such as retained edits or dissatisfied follow-ups is useful, but does not itself
prove correctness or authorize training on private customer code.

### Benchmarks need an evaluator, harness, budget and date

| Evidence                                         | Reported result                                                                                                          | What it supports and what it does not                                                                                                                                                                                                                                               |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Cursor's May launch/product chart                | 69.3% Terminal-Bench 2.0; 79.8% SWE-bench Multilingual; 63.2% CursorBench 3.1                                            | Vendor evidence. Public comparison rows include other vendors' self-reports; these are not a uniform raw-model experiment. [Launch chart](https://cursor.com/composer)                                                                                                              |
| Cursor's June 25 leakage audit                   | Composer 2.5 SWE-bench Pro 74.7% → 54.0%; Multilingual 79.15% → 71.60% with git-history isolation and restricted network | Older images exposed future history; prompts affected exploitation. This qualifies earlier scores without supplying a universal correction factor. [Reward-hacking study](https://cursor.com/blog/reward-hacking-coding-benchmarks)                                                 |
| Current CursorBench 4.0, introduced September 10 | Composer 2.5: 27.7%, $0.68/task, 17,347 tokens and 41 steps; highest displayed setting: 57.8%                            | Current vendor task distribution, not independent reproduction. The change from v3.1 does not demonstrate a model regression. May's positioning is not a current frontier-parity guarantee. [Current evaluation](https://cursor.com/evals)                                          |
| Artificial Analysis, May 20                      | Coding Agent Index 62; Terminal-Bench v2 66%; Standard/Fast mean task times 9.3/6.7 minutes and costs $0.07/$0.44        | Independent historical product evaluation. Model/harness combinations differ across products; these costs and tasks do not forecast PacketBench's workload. [Evaluation](https://artificialanalysis.ai/articles/cursor-composer-2-5-coding-agent-index)                             |
| Current Vals pages                               | 79.60% SWE-bench Verified; 58.43% Terminal-Bench 2.1                                                                     | Independent measurements with **Cursor CLI** for Composer. Other rows use different scaffolds; neither score establishes portable model-only ability. [SWE-bench](https://www.vals.ai/benchmarks/swebench), [Terminal-Bench 2.1](https://www.vals.ai/benchmarks/terminal-bench-2-1) |

Independent results demonstrate that the Cursor agent can perform substantial
coding work. They do not establish that downloading its base model reproduces
Composer, or that PacketBench can obtain those results with its own tools.
Secondary registries that label these Composer runs Mini-SWE-agent or Terminus
should not override the primary evaluator's Cursor CLI attribution.

Public benchmarks remain secondary evidence for this decision. The current
[Terminal-Bench 2.1 maintenance record](https://www.tbench.ai/news/terminal-bench-2-1)
documents task/environment changes. The authors' 2.0 announcement explicitly
excludes benchmark tasks from training corpora.
[Terminal-Bench authors](https://www.tbench.ai/news/announcement-2-0)
OpenAI's July 8 audit also retracts its earlier SWE-Bench Pro recommendation
after finding prompt/test problems. Swapping an unexamined public benchmark for
another does not solve grading or contamination.
[Coding evaluation audit](https://openai.com/index/separating-signal-from-noise-coding-evaluations/)

### Supported integration is available; raw weights are not

Cursor now documents official TypeScript/Python agent SDKs and a cloud agent API.
The local SDK runs the agent loop in the caller's process, while model inference
remains Cursor-hosted. It offers state/resume, streaming and tool controls.
There is no documented standalone OpenAI-compatible Composer inference endpoint
or downloadable Composer checkpoint in the sources inspected. Historical claims
that there is no external integration are therefore stale, even though raw-model
access remains unestablished.
[TypeScript SDK](https://cursor.com/docs/sdk/typescript),
[Python SDK](https://cursor.com/docs/sdk/python),
[Cloud API](https://cursor.com/docs/cloud-agent/api/endpoints)

An official July 10 staff clarification describes embedding Cursor as a backend
as intended SDK use, subject to service restrictions; it distinguishes embedding
from standalone resale/account sharing. That is a potential supported dependency,
not permission to redistribute Composer or bypass accounts.
[Official clarification](https://forum.cursor.com/t/inquiry-regarding-official-api-or-commercial-license-for-using-cursors-engine-as-a-backend-component/165063/5)
An SDK integration could be a future comparison route. It would depend on
Cursor's agent semantics, hosted inference and commercial terms; it would not
demonstrate ownership of PacketBench's direct-model harness. No such integration
is implemented or approved here.

## 2. Current PacketBench foundation

The requested guidance, both October 19 reviews, [HANDOFF](../HANDOFF.md) and
[backlog](../backlog.md) were read. Three research subagents covered Cursor,
current source, and adaptation/evaluation. Source findings below were checked
against the current tree; earlier live walkthroughs remain evidence only for
their recorded scope. No new task-solving benchmark or app walkthrough was run.

| Existing ownership/seam      | Current evidence and practical limit                                                                                                                                                                                                                                                                                                                                                                                                |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Native production agent loop | Private `run_agent_loop` at [api_agent.rs](../src-tauri/src/commands/api_agent.rs), line 2363. PacketBench owns model/tool iteration, permissions, pending edits, cancellation and accounting. It is coupled to `AppHandle`, key loading and the provider factory.                                                                                                                                                                  |
| Inference abstraction        | [llm_provider.rs](../src-tauri/src/core/llm_provider.rs), lines 9–23: streamed requests through `LlmProvider`. This permits model changes while retaining the owned executor.                                                                                                                                                                                                                                                       |
| Open-model serving seams     | [llm_custom_compat.rs](../src-tauri/src/core/llm_custom_compat.rs), lines 1–48, already supports configured Chat Completions endpoints with optional keys. [llm_ollama.rs](../src-tauri/src/core/llm_ollama.rs), line 526, provides a local route. Protocol compatibility still needs real tool-round tests.                                                                                                                        |
| Provider state               | [llm_types.rs](../src-tauri/src/core/llm_types.rs), lines 71–78; [llm_responses.rs](../src-tauri/src/core/llm_responses.rs), lines 19–32; [llm_openai_compat.rs](../src-tauri/src/core/llm_openai_compat.rs), line 142, preserve opaque reasoning/replay state on live rounds. Such state is not an authorized training corpus.                                                                                                     |
| Tools and authority          | [tool_runtime.rs](../src-tauri/src/core/tool_runtime.rs), lines 21–88 and 125–374: file/search/edit/shell/web/task/subagent/Git/MCP tools and file confinement. Shell at line 843 runs with host process authority: a worktree and file-path checks are **not an OS sandbox**.                                                                                                                                                      |
| Context and continuation     | [api_agent.rs](../src-tauri/src/commands/api_agent.rs), line 2477, clones accumulated history; restart at lines 363/418 reconstructs text. [agentTaskStore.ts](../src/stores/agentTaskStore.ts), lines 474–489, bounds/truncates restored history. Exact typed restart replay and adaptive working-set compaction are not established.                                                                                              |
| Budget and subagents         | [agentTaskStore.ts](../src/stores/agentTaskStore.ts), line 390, admits turns; native requests check ledger health at [api_agent.rs](../src-tauri/src/commands/api_agent.rs), line 2509. These are not prospective concurrent spend reservations. [tool_subagent.rs](../src-tauri/src/core/tool_subagent.rs), lines 79–106, has a bounded read-only helper, an ignored advertised model override, and a paragraph response contract. |
| SDK sidecar                  | [anthropic.ts](../agent-sidecar/src/providers/anthropic.ts), line 681, invokes SDK `query`; [openai-agents.ts](../agent-sidecar/src/providers/openai-agents.ts), lines 466/613, invokes its tool/runtime configuration and `run`. PacketBench owns the bridge/lifecycle/approvals; vendor SDKs own substantial loop/session behavior.                                                                                               |
| Flight substrate             | Existing attempts, retained worktrees, pinned SSH, reviewer and delivery paths are reusable. Current [flight_attempts.rs](../src-tauri/src/commands/flight_attempts.rs), lines 1432–1469, validates passed-review evidence/context; [flight_cost.rs](../src-tauri/src/commands/flight_cost.rs), lines 147–173, attributes historical/reviewer sessions. These older review gaps are repaired, not new work.                         |
| Verification gap             | The reviewer is read-only, MCP off, memory off and writes denied at [reviewerGateRuntime.ts](../src/stores/reviewerGateRuntime.ts), lines 511–524. Independent model review does not independently execute tests. Exact-state check capture/combined-tree validation still need an explicit evidence contract.                                                                                                                      |

Local and SSH are not interchangeable evaluation conditions. Native exact
`edit_file` is disabled remotely; SSH uses full-content writes
([tool_runtime.rs](../src-tauri/src/core/tool_runtime.rs), lines 295–302).
Windows shell behavior, Linux SSH prerequisites, token use and interruption
outcomes must therefore be measured separately.

Production unit/protocol/cancellation tests and opt-in provider smoke fixtures
are useful assets. They do not constitute a held-out coding-quality evaluator.
The existing [gate commands](../package.json) establish application regressions,
not whether a model plus harness solves the next real task. A second evaluation
loop would hide production defects; the missing seam is around the existing one.

## 3. The three paths are different commitments

### A. Owned coding harness using existing models — start here

**We own:** the native executor, versioned task/context/tool policies, project and
host identity, worktree lifecycle, interruption/recovery contracts, verification
evidence, review/delivery, evaluation assets and consented outcome telemetry.
The initial experiment should reuse these, not create a scheduler or UI program.

**We depend on:** model weights/capabilities, API availability and entitlement,
provider pricing/retention rules, or a separately operated compatible local
server. SDK-backed routes retain additional vendor harness dependencies. A
direct `LlmProvider` arm gives the cleanest first attribution experiment.

**User value to test:** fewer corrective prompts and manual check/recovery
steps, reliable local/SSH scope, and changes whose verification can be inspected.
Success must survive the same-model comparison. A better result obtained only
by upgrading to a more expensive model is a routing result, not proof of a
better harness.

### B. Narrow adapted open weights — conditional specialist

**We own:** rights-cleared role data/labels, adapters or derivative checkpoints,
training configuration, role/tool contract, evaluations, quantization and release
regressions. **We depend on:** the base checkpoint/license, its inherited ability
and training-data uncertainty, training/serving frameworks and hardware. Adapter
ownership does not mean that the base model was trained by PacketBench.

Start with a read-only role: select relevant files with revision-bound evidence,
or classify review findings with abstention. Keep a strong existing model as
the builder. Establish a prompt-only/unmodified-weight baseline before LoRA/SFT.
Use preference training or RL only if supervised examples leave a specific gap
and the reward can be independently verified. Tests passing is not by itself a
safe reward if the agent can alter tests, history or its grader.

An acceptable specialist could reduce paid context collection or review burden
without matching a frontier builder. An unreliable cheap scout that causes
expensive builder rework has negative value. Measure downstream accepted tasks,
including fallback, not just the specialist's token price or output schema.

### C. Broadly competitive coding model — do not make this a desktop milestone

Two variants exist: broad continued training/post-training of a large licensed
base, or pretraining a new base. Both require a dedicated model/data/evaluation/
infrastructure team, varied executable environments, failure analysis, security
and serving operations. From-scratch pretraining adds tokenizer/corpus/optimizer/
distributed-training work and far greater compute risk.

We would own more of the model pipeline, but still depend on compute supply,
data rights, framework/hardware behavior and, for adaptation, the base license.
Broad competition means sustained results across languages, unfamiliar repos,
long sessions and adversarial conditions under realistic time/cost limits; a
single benchmark or a PacketBench-only demo cannot establish it. The current
repo provides no dataset, model-training infrastructure or measured advantage
that justifies this commitment.

## 4. Open-weight candidates, licensing and hardware

These are candidates for a future controlled baseline, not a recommendation to
download, serve or train now. Pin the exact revision, tokenizer, template,
quantization and license before any approved experiment.

| Candidate         | Verified publisher facts                                                                                                                                                                                                                                                          | Fit and boundary                                                                                                                                                                             |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Qwen3.6-27B       | Dense 27B, Apache-2.0; 256k native context. Official serving instructions use Chat Completions with model-specific reasoning/tool parsers. [Model card](https://huggingface.co/Qwen/Qwen3.6-27B), [license](https://huggingface.co/Qwen/Qwen3.6-27B/blob/main/LICENSE)            | Plausible single-server baseline for a narrow role. Benchmark scores in the card are publisher evaluations, not PacketBench measurements.                                                    |
| Qwen3.6-35B-A3B   | 35B total / 3B active MoE, Apache-2.0, 256k native context. [Model card](https://huggingface.co/Qwen/Qwen3.6-35B-A3B), [license](https://huggingface.co/Qwen/Qwen3.6-35B-A3B/blob/main/LICENSE)                                                                                   | Lower active compute does not make this a 3B-memory model. Hybrid architecture/parser/training support must be checked.                                                                      |
| Kimi K2.5         | Composer's stated starting checkpoint; modified MIT rather than plain MIT. Commercial modification/distribution is permitted with notices and additional large-product attribution conditions. [Publisher license](https://huggingface.co/moonshotai/Kimi-K2.5/blob/main/LICENSE) | Relevant lineage, poor first small-team training choice. Base access confers no Composer weights, Cursor license or proprietary post-training data.                                          |
| Qwen3.8-2.4T-A95B | 2.4T total / 95B active, BF16, custom `qwen3.8-max` license. [Model card](https://huggingface.co/Qwen/Qwen3.8-2.4T-A95B), [actual license](https://huggingface.co/Qwen/Qwen3.8-2.4T-A95B/blob/main/LICENSE)                                                                       | Shows why newer open weights are not automatically tractable or Apache-licensed. The license has commercial-agreement and attribution triggers; unsuitable as the first specialist baseline. |

The Qwen3.6 cards specify vLLM/SGLang versions, reasoning preservation, and
`qwen3` reasoning / `qwen3_coder` tool parsing. PacketBench's existing custom
endpoint is the likely route. That is a compatibility hypothesis, not tested
support for these checkpoints. Streaming tool IDs, parallel calls, tool-result
correlation, reasoning replay, cancellation, context limits and unavailable
capabilities need fixtures before task scoring. An OpenAI-shaped HTTP endpoint
does not establish correct agent behavior. Publisher SWE/Terminal scores that
use a custom harness or refined task set must retain those qualifications.

### Memory is governed by resident weights, context and concurrency

The following are **derived decimal-GB weight floors**, using parameters × bytes,
not measured allocations or complete deployment recipes:

| Parameter count                                | BF16, 2 bytes | Ideal 4-bit, 0.5 bytes |
| ---------------------------------------------- | ------------: | ---------------------: |
| Illustrative 8B specialist                     |         16 GB |                   4 GB |
| 27B dense                                      |         54 GB |                13.5 GB |
| 35B total MoE                                  |         70 GB |                17.5 GB |
| Composer 2's disclosed 1.04T base architecture |      2,080 GB |                 520 GB |
| Qwen3.8 2.4T                                   |      4,800 GB |               1,200 GB |

Quantization scales, nonquantized layers, activations, runtime/workspace buffers
and KV/state cache add memory. Long context and concurrent sessions can dominate;
a supported 256k window is not a promise that it fits affordably. CPU offload can
reduce VRAM needs while making interactive latency unacceptable. Quantization
can change tool reliability and must be evaluated as another configuration.

Planning envelopes, subject to profiling: a quantized 8B role can be explored on
16–24 GB; a quantized 27–35B short/moderate-context role is more comfortably
budgeted on 48–80 GB than assumed to fit a 24 GB desktop at full context.
BF16 27B needs more than its 54 GB weight floor, so 80 GB is a reasonable starting
profile target. These are not hardware purchase recommendations.

LoRA reduces trainable parameters; QLoRA additionally quantizes frozen base
weights. Neither eliminates activations, sequence-length cost or a rollout
fleet. Budget a small dense role for 24–48 GB at bounded sequence lengths, and
27–35B experiments for 80 GB or multiple GPUs until profiling establishes less.
Full Adam-style fine-tuning can require roughly 12–20 bytes per parameter for
weights/gradients/master weights/optimizer states before activations: approximately
324–540 GB for 27B, distributed or offloaded. This is a planning estimate;
precision, optimizer and sharding change it. Do not infer training memory from
an inference quantization file size.
[QLoRA paper](https://arxiv.org/abs/2305.14314),
[Hugging Face training memory guide](https://huggingface.co/docs/transformers/model_memory_anatomy)

Coding-specific controls are also worth comparing before adaptation:
[Qwen3-Coder-30B-A3B-Instruct](https://huggingface.co/Qwen/Qwen3-Coder-30B-A3B-Instruct)
is a non-thinking 30.5B-total/3.3B-active model; Apache-licensed
[Devstral Small 2 24B](https://huggingface.co/mistralai/Devstral-Small-2-24B-Instruct-2512)
documents agentic coding and compatible serving with a Mistral tool parser.
For a cheap historical control,
[Qwen2.5-Coder-7B-Instruct](https://huggingface.co/Qwen/Qwen2.5-Coder-7B-Instruct)
is 7.61B with Apache-2.0 weights. None is declared the winner without the role
evaluation. Manufacturer desktop-fit claims do not establish full-context
concurrency or fine-tuning capacity. Qwen3.6 recommends at least 128k context for
thinking workloads: short-context results must be labelled as a constrained
deployment, and a non-thinking coding control may be simpler initially.

Scale evidence argues against extrapolating from a small adapter: the
[Qwen3-Coder-Next technical report](https://arxiv.org/html/2603.00729v1)
describes approximately 800,000 verifiable tasks and large-scale repository
training, and reports limited transfer across scaffolds. Its results are
publisher research, not an independently reproduced minimum recipe. They make
the production-tool contract and a second-harness transfer check especially
important for any later model study.

## 5. Smallest experiment and held-out evaluation

### Falsifiable first question

**With the same strong model and resource envelope, does a versioned PacketBench
task/context/verification policy produce more correct changes, or the same
correctness with materially less human effort or cost, than today's native
harness?** No training is needed to answer this.

Choose one change: a compact manifest containing objective, constraints,
revision-bound relevant context, acceptance commands and explicit completion/
incomplete evidence. Keep model, tools, permissions, host and review policy
fixed. Start with single-builder Assisted behavior; do not confound it with new
retrieval infrastructure, parallel coding agents or model routing. If that
policy produces no useful gain, inspect failures before investing further.

### Use the production executor

Proposed future implementation: expose injectable event sink, provider/credential
factory, immutable run configuration, clock and cancellation around the existing
`run_agent_loop`. Keep production tool implementations, request parsing,
permission/edit gates, usage accounting and history semantics. The application
and evaluator must call the same executor. Shared code plus contract fixtures
must prevent test-only bypasses or a benchmark-specific easier tool set.

Scripted-provider fixtures first establish tool correlation, denial, cancellation,
missing completion/usage, iteration exhaustion, ledger failure and uncertain
mutation outcomes. They validate plumbing, not model capability. Stop/restart
after a successful mutation but before its result is durable must reconcile
state or report unknown; it must not blindly repeat the mutation. Exact replay,
request reservations and OS isolation are dependencies to scope honestly, not
capabilities this research assumes already work.

### Proposed task sets and trial protocol

1. **Development/pilot:** eight independently authored tasks, three trials in
   each of two arms: **48 runs**. Use them to debug graders and the one policy;
   they are never the final held-out score. This can reject an obviously weak
   idea cheaply, but cannot establish broad parity.
2. **Locked confirmation:** 30 fresh held-out tasks, three trials per arm:
   **180 runs**. Five tasks each for TypeScript defects; Rust/state/concurrency
   defects; cross-file contract changes; test/regression repair; long-context
   or interruption/continuation; and local/SSH execution differences. Include
   Windows local shell and pinned Linux SSH in the appropriate strata. Tasks
   should include PacketBench-like Tauri/React work and at least two unrelated,
   rights-cleared repositories so the suite does not reward memorizing one tree.
3. **Fault/authority suite:** ten deterministic fixtures independent of the
   success score: forbidden writes/network, malicious repository instructions,
   stale evidence, conflicting tools, cancellation/timeout, missing usage,
   incompatible continuation and uncertain side effects. Use dummy secrets.
   Future live adversarial trials need separate authority and isolation.

A curator who did not tune the candidate holds task solutions and hidden graders.
Freeze task IDs, prompt, starting commit/tree, dependency/image digests, tool and
policy hashes, model/endpoint snapshot, reasoning/output settings, seed where
supported, budgets and grading rubric before confirmation. Run paired trials in
randomized order at comparable load; distinguish cold/warm caches. Three repeats
measure stochastic reliability, not 90 independent tasks. Report uncertainty
clustered by task, paired deltas and per-stratum results; a 30-task suite is an
initial product decision aid, not evidence of industry leadership.

Agent-visible copies must not contain future commits, solution branches, hidden
tests, other trial outputs or informative test filenames. Disable network where
unneeded; otherwise restrict it and log access. Use sanitized source snapshots,
fresh isolated homes/caches and per-trial project memory. Git worktrees share
objects/history and are not sufficient to prevent answer leakage. Mount hidden
graders outside the agent's authority, using a container/VM or separate grading
principal as appropriate; merely placing them outside the workspace does not
hide them from a host-authority shell.

Export the final candidate as an immutable tree/commit. An independent runner
executes fail-to-pass and pass-to-pass checks against that tree, with type/lint/
build/security checks relevant to the task. Validate API/schema and cross-file
behavior, not only text matches. Inspect scope and unjustified changes with a
blind human rubric. A model reviewer is supplemental; the builder's claim that
tests passed is not the grade. Grade clarification/abstention as correct when
the objective is deliberately ambiguous or unsafe. Fixed scripted answers keep
clarification conditions equal between arms.

Preserve every attempt and classify: correct; incorrect/regressed; incomplete
by budget; cancelled; authority failure; infrastructure/provider failure; or
unknown outcome. Infrastructure failures remain visible in end-to-end results;
report model-conditional rates separately. No silent reruns, best-of selection,
hidden test modification or removal of difficult tasks after seeing scores.
Appeal defective graders blind to arm, version them, and rerun both arms under
the corrected protocol. Once results inform tuning, retire that suite to
regression/development and obtain a new held-out cohort.

This design follows outcome-state grading, repeated trials and trace review in
Anthropic's [agent evaluation guidance](https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents).
Its production/evaluation distinction matters more than adopting a particular
benchmark framework.

### Required metrics

| Dimension             | Definition and reporting                                                                                                                                                                                                                                                                                            |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Correctness           | All required hidden checks plus preserved existing behavior and scope. Report per-trial pass rate, tasks passing all three trials, regression/false-completion rates and blinded acceptance. Do not substitute pass@k for single-attempt reliability.                                                               |
| Latency               | p50/p95 wall time to first useful action and independently accepted result; preparation, queue, model prefill/decode, tools/tests and review/repair separately. Tiny-stratum p95 is descriptive and unstable. Output tokens/second alone is insufficient.                                                           |
| Cost                  | All parent/child, builder/reviewer/repair, failed/retried requests, fresh/cache/output/reasoning tokens when reported, and execution/serving costs. Total experiment cost ÷ correct accepted tasks includes failed attempts; a zero-success arm has no finite cost per success. Preserve unpriced usage as unknown. |
| Interventions         | Clarifications, routine authority approvals, corrective steering, manual edits/restarts and abandonment, with user minutes. Separate required safety approvals from avoidable rescue; do not reward bypassing approvals.                                                                                            |
| Reliability/authority | Tool errors, retry loops, stale evidence, duplicate side effects, cancellation latency/descendant cleanup, scope violations, secret egress and truthful incomplete/unknown status. A policy failure is not averaged away by more solved tasks.                                                                      |

Keep one versioned run manifest linking exact source/model/harness/tool/context
identity to requests, execution host, timings, evidence tree, grades and billing
provenance. Current usage ledgers alone do not contain that attribution. Report
local and SSH, pricing coverage, and model/SDK variants separately. Add a second
model family only after the first controlled comparison works; it tests whether
the improvement generalizes. An optional matched official Cursor CLI or the
owner's usual agent workflow is an end-to-end product comparison, not a
same-harness model ablation. It needs separate access/budget authorization.

## 6. Data provenance, privacy and training restrictions

Evaluation permission, inference permission, and training/redistribution rights
are separate. A successful user session is not automatic consent to retain its
repository or train on its trace.

For each proposed training example, record source owner/license and revision,
explicit consent scope, originating model/service and terms version, collection
date, prompt/tool-policy/template hashes, redaction/dedup results, test/acceptance
labels, split assignment and deletion lineage. Retain failed examples and
abstentions with accurate labels. Split by repository, time and task family;
near-duplicate patches or generated variants must stay in the same split.
Do not use held-out/public benchmark answers as training or synthetic templates.

Prefer independently authored, rights-cleared examples and consented local-model
trajectories. Repository source licenses, model licenses, dataset licenses and
API-output terms all apply independently. Notice, copyleft, redistribution,
patent and confidentiality obligations do not disappear because code is public.
An open checkpoint often does not disclose enough base-corpus provenance to
promise that all inherited training data is rights-cleared.

Use local retention by default for any future pilot; separately opt in to export
or training. Exclude credentials, personal/regulated data, unrelated files,
private repositories without owner permission and opaque provider reasoning
envelopes. Redact before collection/export rather than after uploading. Define
access control, encryption, short raw-trace retention, deletion/consent withdrawal
and checkpoint lineage; removing a raw example does not retroactively untrain a
released adapter. Capture only the minimum trace needed for diagnosis and labels.

Specific current constraints:

- **Cursor:** September 3 terms §1.5(v) restrict using its service or Suggestions
  to develop/train competing models. Composer outputs/patches/trajectories are
  not an available distillation corpus without a separate agreement. Code
  ownership is not a waiver of those service restrictions.
  [Terms](https://cursor.com/terms-of-service)
- **Cursor privacy:** Privacy Mode prevents training on customer data under its
  stated arrangements; disabled mode can permit training. Provider exceptions
  and retention rules still matter, and BYOK traverses Cursor infrastructure.
  Local SDK execution does not imply local inference or training rights.
  [Data-use policy](https://cursor.com/data-use)
- **Other API teachers:** OpenAI's Services Agreement, effective January 1,
  2026, restricts competing-model development from outputs in §3.3(e), subject
  to defined exceptions. These cover models primarily intended to categorize,
  classify or organize data only when neither distributed nor commercially
  available to third parties; separately, customization through OpenAI services.
  They are not a general commercial coding-model grant.
  Anthropic's Commercial Terms D.4 restrict competing products/services,
  including competing-model training, absent express approval. Gemini's API
  terms prohibit developing competing models and distinguish unpaid/paid data
  treatment. Do not convert ordinary evaluation traces from these services
  into a training corpus without rights for that use.
  [OpenAI agreement](https://openai.com/policies/services-agreement/),
  [Anthropic terms](https://www.anthropic.com/legal/commercial-terms),
  [Gemini terms](https://ai.google.dev/gemini-api/terms)
- **Base licensing:** Kimi K2.5's modified MIT adds prominent model attribution
  for products above 100M MAU or $20M monthly revenue. Qwen3.8's actual license
  has separate commercial terms, including aggregate licensee-and-affiliate
  revenue exceeding $50M during any consecutive 12 months for
  Model-as-a-Service/AI Work Assistant businesses and
  large-product attribution conditions. Small Apache Qwen3.6 candidates avoid
  those particular custom triggers, while retaining Apache notice obligations.
  [Kimi license](https://huggingface.co/moonshotai/Kimi-K2.5/blob/main/LICENSE),
  [Qwen3.8 license](https://huggingface.co/Qwen/Qwen3.8-2.4T-A95B/blob/main/LICENSE)

Provider output rights and retention must be checked on the exact commercial
agreement before collecting a corpus. Do not assume existing API keys, an open
source app license, CLI subscriptions or a provider proxy grant teacher-training
rights. Preserve the current keyring/authentication contract; no credential
reuse or subscription entitlement changes are part of this proposal.

For a first narrow adaptation, propose approximately 1,000–5,000 independently
verified role examples, scaling toward 5,000–20,000 only if learning curves and
held-out errors justify it. These are planning hypotheses, not universal sample
requirements. At 2–8 minutes of curation per example, 1,000 examples alone cost
33–133 human hours; long executable trajectories can cost much more. Context
selection needs relevance/recall and downstream success labels; review triage
needs confirmed findings, false positives and useful abstentions. Formatting a
trace into JSON does not make a valid training target. Start with SFT/LoRA and
compare learning curves to prompt/retrieval baselines before considering RL.

Preserve complete tool-call/result boundaries and sufficient prior state in
training windows. Train on the intended assistant decisions rather than teaching
the model to emit tool observations; verify assistant-only loss masks against
the actual chat template. Check that LoRA targets include the architecture's
expert parameters where needed, and pin base/adapter/quantization compatibility.
[TRL tool-calling SFT](https://huggingface.co/docs/trl/en/sft_trainer),
[PEFT LoRA guidance](https://github.com/huggingface/peft/blob/main/docs/source/package_reference/lora.md)
Open research assets can help scope the work: SWE-smith publishes executable
tasks and expert trajectories, but some trajectories use Claude as teacher.
An open dataset listing alone does not resolve teacher terms or every input
repository's rights. [Authors' assets](https://swesmith.com/getting_started/assets/)

## 7. Effort and operating economics

All amounts are **USD planning estimates, not quotes, approved spend or measured
PacketBench performance**. Engineering assumes experienced contributors and
$15k–$25k per person-month fully loaded; owner time has an opportunity cost.
No available local GPU or customer concurrency was verified. Ranges widen if
durability, strong request caps, execution isolation or dataset rights need
substantial work.

| Path                                          | Engineering/program envelope                                                                                                                                                                                                                                                    | External operating/research envelope and uncertainty                                                                                                                                                                                                                                    |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A: production seam plus bounded pilot         | Roughly 3–6 engineer-weeks including task/grade design; 1–2 people over about 4–8 calendar weeks with analysis. Approximately $11k–$38k loaded engineering for 0.75–1.5 person-months. A dependable beta is additional work, plausibly 2 engineers for 3–6 months ($90k–$300k). | Pilot: tens to hundreds of dollars of inference under the sensitivity model below; confirmation roughly $250–$2,500 plus isolated execution. A separately approved cap must precede live runs. Product inference scales with successful and failed tasks; no new GPU fleet is required. |
| B: narrow adaptation after baseline/data gate | Approximately 2–3 people over 2–4 months, 4–12 person-months ($60k–$300k), for data, ML, executor/serving and eval work. Reuse of existing expertise can reduce this; long-trajectory RL can greatly exceed it.                                                                 | Initial small SFT/LoRA sweep: 50–500 GPU-hours, roughly $125–$2,000 at the reference rates, excluding rollouts, data labor, storage and failed runs. A serious iterative pilot could need $1k–$20k external compute/data services. Neither envelope promises a gain.                    |
| C: broadly competitive post-training          | Illustrative 8–20 specialist team for 12–24 months: roughly $1.4M–$12M personnel, plus data, environments, inference/rollouts and experiments. A $3M–$30M+ program envelope is a risk estimate, not proof it will compete.                                                      | Large persistent fleets and repeated runs; inference alone can be tens of thousands/month per replicated large-model deployment. From-scratch frontier ambitions move into tens to hundreds of millions or more, with very high uncertainty and no credible PacketBench-specific quote. |

**API sensitivity calculation:** assume, rather than quote a particular model,
0.25–1M billable fresh-equivalent input tokens and 10k–40k output tokens per
builder trial, at $2–$5/M input and $10–$25/M output. That is approximately
**$0.60–$6/trial**. Forty-eight pilot runs cost $29–$288; 180 confirmation runs
cost $108–$1,080 before reviewer/repair/child calls. A 2× allowance yields roughly
$60–$600 and $220–$2,160 respectively. Reasoning, context growth, retries or cold
caches can exceed this. Recalculate with the selected provider's current rates
and a dry-run token distribution before approval. Unknown Sugar/custom pricing
cannot be treated as free, and included subscription allowance is not marginal
API entitlement.

**GPU reference, retrieved now:** Modal publishes $0.000542/s for L40S,
$0.000694/s for A100 80 GB and $0.001097/s for H100: approximately
**$1.95/$2.50/$3.95 per GPU-hour**. CPU, RAM, storage, load time and idle grace
are additional; regional/non-preemptible settings can multiply rates. Credits
are not assumed. A continuously resident GPU at those rates is approximately
$1,400/$1,800/$2,840 per 30-day month before overhead. Scale-to-zero trades idle
savings for cold-start latency; interactive latency requires measurement.
[Public pricing](https://modal.com/pricing)

For an owned inference role, count the complete bill and utilization. A $1,800
monthly GPU allocated to 1,000 **correct accepted** tasks is $1.80/task before
other costs; at 100 it is $18/task. At an illustrative API cost of $2 per role
task, $1,800 is equivalent to 900 calls, before failed local runs, fallback,
replication, engineering or CPU costs. These are sensitivity examples, not a
breakeven forecast. A BYO local model still consumes hardware, power and time.

For broad training scale, 128 H100s for 30 days at $3.95/h are about $364k;
1,024 for 90 days are about $8.7M, before data, storage, environments, staffing
and experiments. This arithmetic does not say either fleet is sufficient.
DeepSeek's historical V3 report provides a useful floor on misleading cost
analogies: it reports 2.788M H800 GPU-hours and $5.576M at an assumed $2/h,
excluding prior research/ablation costs. That successful run is neither a
startup's all-in model budget nor evidence of present frontier competitiveness.
[DeepSeek technical report](https://arxiv.org/html/2412.19437v2)

## 8. Staged decision plan and stop rules

The following are **proposals for later approval**, not authorized tasks or
new commitments in the backlog.

| Stage                                         | Evidence needed to progress                                                                                                                                                                                                                                                                                                                                                                | Stop, revise or defer when                                                                                                                                                                                                                                                                            |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0. Review this research                       | Owner chooses Path A's hypothesis, task scope and acceptable operating envelope. Existing reliability work remains separately owned.                                                                                                                                                                                                                                                       | A new model brand is the only proposed benefit; there is no measurable user outcome.                                                                                                                                                                                                                  |
| 1. Offline production-executor seam           | Same executor/tools used by app and evaluator; deterministic fault fixtures and redacted manifests work. No live-model proof claimed.                                                                                                                                                                                                                                                      | A separate simplified loop is required, hidden graders remain agent-readable, or uncertain mutations are silently replayed. Scope and resolve these before live measurement.                                                                                                                          |
| 2. Eight-task paid pilot, separately approved | 48 paired runs; examine every failure. A plausible improvement survives correcting grader/environment defects, within the agreed cap.                                                                                                                                                                                                                                                      | No recurring useful gain, material authority failures, unexplained token/pricing gaps or budget growth. Allow at most two bounded candidate revisions on development data before reconsidering.                                                                                                       |
| 3. Locked 30-task confirmation                | Proposed material-effect target: at least 10 percentage points higher correctness, or correctness within 5 points with at least 20% lower cost/accepted task or corrective user minutes. No new authority violation; no material regression in a critical stratum; latency stays within the agreed envelope. Show paired uncertainty and a second untouched cohort before shipping claims. | Gains vanish on hold-out or a second model family; confidence remains too wide; lower cost hides more interventions; p95 accepted-result latency worsens materially (initial guardrail 20%) without agreed benefit. Uncertain results justify another pre-budgeted cohort, not a parity announcement. |
| 4. Narrow open-model baseline                 | Same role/data boundary and downstream grading. Unmodified weights approach the required quality and a recurring, labelable gap remains; rights-cleared training data and serving economics exist.                                                                                                                                                                                         | Existing prompted model is already sufficient, too weak to recover safely, or its fallback/serving cost exceeds saved work. Do not train merely because weights are available.                                                                                                                        |
| 5. Small adaptation study                     | New repository/time/family hold-out; beat the unmodified base and prompt/retrieval baseline on downstream success or cost/interventions at preserved quality. Verify quantized serving, license, deletion lineage and regression behavior.                                                                                                                                                 | Two small sweeps produce no held-out gain; gains rely on leakage, prohibited teacher data or test manipulation; no economical deployment or reliable abstention exists. Retain a research result and stop.                                                                                            |
| 6. Any broader model program                  | Separate business case, named model/data/infra/eval team, financing and evidence that the narrow result transfers.                                                                                                                                                                                                                                                                         | Desktop adoption or harness reliability would be subordinated to speculative frontier training. Broad training remains no-go on today's evidence.                                                                                                                                                     |

The percentages are proposed decision thresholds to agree **before** running,
not statistical guarantees. Use task-level confidence intervals to judge whether
the data support them; a small suite may only support rejecting a weak variant
or funding more measurement. Correctness, safety and human effort are joint
constraints, not a weighted score that can hide serious failures.
In particular, an observed five-point difference does not establish five-point
noninferiority. If that margin matters, plan a powered confirmation, plausibly
100–200 fresh tasks or more after estimating variance; require the interval to
exclude the unacceptable regression. Do not relax the margin after seeing data.

**Candid conclusion:** PacketBench has enough owned runtime to justify measured
main-agent model selection and a bounded post-training feasibility study. Its
opportunity is reliable work across the user's projects and execution hosts,
with an owned derivative model if the improvement proves useful. Establish base
quality and a learning signal first; a large broad-model program remains a
separate decision. The budgeted recommendation in Section 10 reflects the owner's
clarified interest and the expanded model research.

## Research validation and remaining uncertainty

This report combines current primary-source web research and read-only source
inspection, with vendor, independent and proposed evidence labelled separately.
Composer's full training cost/recipe, PacketBench task-solving performance,
candidate memory/throughput, dataset sufficiency and customer-scale economics
remain unknown. No architecture or cost estimate above substitutes for those
measurements. Source URLs and licenses should be rechecked before an approved
experiment because product access, terms, prices and model releases can change.

Documentation validation is limited to formatting, relative-link resolution,
source-reference spot checks and whitespace checks. Application gates, live
providers, training, infrastructure and installation are outside this research.
The report passes the installed Prettier formatter; all 21 unique relative
targets resolve; `git diff --check` passes. Read-only research reviewers checked
the Cursor and adaptation/evaluation claims, with precision corrections applied.

## 9. Follow-up: owned main model through open-weight post-training

The owner's follow-up makes the intended model route explicit: start from Kimi
K2.5 or a stronger suitable open checkpoint, including DeepSeek, and train for
PacketBench's coding workflow. That is a credible research direction. It must
not be conflated with pretraining from scratch or reduced to an auxiliary-only
model proposal. The initial evaluation infrastructure is necessary for selecting
and improving that model; it does not substitute for the model-ownership goal.

The earlier multi-million-dollar broad-program envelope is **not an established
minimum cost to match the fixed Composer 2.5 target**. No public evidence here
establishes that minimum. A newer checkpoint may already be near or above that
target on important tasks before adaptation; the same-source, same-budget
comparison is still missing. Matching quality, long-session reliability, latency
and cost simultaneously is harder than improving one score.

### Expanded main-model candidate screen

These primary sources were checked during the follow-up; no inference, weights
downloads, training or infrastructure actions were performed.

| Candidate                     | Primary-source findings                                                                                                                                                                                                                                                                                                            | Research implication                                                                                                                                                                                                               |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Kimi K2.5                     | Composer 2.5's stated starting checkpoint. Existing modified-MIT and hardware discussion above applies. [Cursor announcement](https://cursor.com/blog/composer-2-5)                                                                                                                                                                | Useful lineage/control candidate; do not assume it is the strongest current starting point.                                                                                                                                        |
| Kimi K2.7 Code                | Official coding-focused weights; 1T total / 32B active, 256k context, native INT4 and preserved interleaved thinking. [Publisher card](https://huggingface.co/moonshotai/Kimi-K2.7-Code)                                                                                                                                           | A relevant main-agent candidate. Claimed coding/efficiency gains are vendor evidence with Kimi Code CLI, not demonstrated PacketBench gains.                                                                                       |
| DeepSeek V4 Flash             | 284B total / 13B active, 1M context; publisher documents FP4 experts plus FP8 other parameters. [Publisher card](https://huggingface.co/deepseek-ai/DeepSeek-V4-Flash)                                                                                                                                                             | Smaller large-model control worth comparing if architecture-specific training support is usable. It is not the latest DeepSeek merely because it is cheaper to fit.                                                                |
| DeepSeek V4.1 Flash           | Official weights; 552B backbone plus 196B Engram memory and other components; HF reports approximately 763B checkpoint parameters. It activates 8B parameters during prefill and 16B during decode, with a different causal encoder/decoder architecture. [Publisher card](https://huggingface.co/deepseek-ai/DeepSeek-V4.1-Flash) | Strong current research candidate with specialized memory, prompt and kernel behavior. Budget the complete checkpoint and lookup memory, not just active/backbone parameters. Full training-framework compatibility is unverified. |
| Kimi K3                       | Official 2.8T-total / 104B-active weights, 1M context, QAT MXFP4 weights/MXFP8 activations and a custom license. [Publisher card](https://huggingface.co/moonshotai/Kimi-K3)                                                                                                                                                       | Include in the capability screen if the operating envelope permits; model size and novel architecture make it a substantially larger training/serving project.                                                                     |
| 24–35B coding-capable control | Candidate controls in Section 4 remain applicable.                                                                                                                                                                                                                                                                                 | Useful for cheaper pipeline validation and as a possible winner if measured quality suffices. A successful small specialist is not evidence of main-agent parity.                                                                  |

The actual [Kimi K2.7 Code license](https://huggingface.co/moonshotai/Kimi-K2.7-Code/blob/main/LICENSE)
permits modification/distribution with its notices and large-product attribution
condition. [DeepSeek V4.1 Flash's actual license](https://huggingface.co/deepseek-ai/DeepSeek-V4.1-Flash/blob/main/LICENSE)
is MIT. [Kimi K3's license](https://huggingface.co/moonshotai/Kimi-K3/blob/main/LICENSE)
expressly permits fine-tuning, but has distinct terms: a Model-as-a-Service
business above $20M aggregate licensee-and-affiliate revenue over any consecutive
12 months requires a separate agreement; its definition excludes certain
feature/harness-embedded products and mere relays. Separate large-product
attribution conditions and exceptions apply. Determine the actual product
classification rather than assuming K2.5/K2.7 terms carry over to K3. A weight
license also does not establish rights under a hosted teacher's API agreement.

As arithmetic floors, 1T weights are about 500 GB at ideal 4-bit, 763B about
382 GB, and 2.8T about 1.4 TB, before scales, higher-precision tensors, runtime
state, adapters and training activations. These are parameter-count bounds,
not literal allocations for mixed-precision/lookup architectures. Engram memory
may be placed differently from transformer weights, with bandwidth tradeoffs.
LoRA avoids full optimizer state for frozen weights but does not make these
desktop-GPU training jobs; a supported distributed/offloaded recipe must be
profiled before assigning GPU counts or a bill. Full-parameter training and
long-trajectory RL have very different resource requirements from inference.

### A main-model post-training study

The target is an owned coding model adapted to PacketBench's **actual executor**:
repository investigation, multi-file edits, tool use, tests, recovery, instruction
following, appropriate effort and long-session continuity. Source the general
coding ability from the base and teach measurable execution behaviors; do not
assume training only on local conventions will close a broad reasoning gap.

The proposed sequence is:

1. Define parity against a frozen Composer 2.5 configuration, including quality,
   user intervention, latency and total task cost. Use the held-out protocol in
   Section 5 and retain separate same-harness model comparisons.
2. Screen the unmodified main-model candidates. Check actual license, tokenizer,
   reasoning/tool format, trainable framework/kernel support and complete
   checkpoint footprint. Select for quality at an attainable operating envelope,
   rather than choosing Kimi solely for lineage or the largest model by default.
3. Curate an initial rights-cleared main-agent training set, with executable
   outcomes and failure/recovery examples. Train a small supervised adapter only
   after a supported recipe and memory/throughput profile are established. The
   initial corpus size is an experiment; no example count here guarantees parity.
4. Compare adapted versus unadapted weights under the same executor and serving
   precision. Preserve tool-state boundaries and distinguish genuine model gains
   from changes to prompts, decoding or environment leakage.
5. Add verifiable-reward RL only for failure classes the supervised study leaves
   unresolved, after checking reward integrity and rollout economics. Model
   generated tests alone cannot safely define success.
6. Validate longer sessions, new repositories/languages, quantized deployment,
   fallback and operating cost before any parity or product claim. Rebase to a
   newer checkpoint only with an explicit transfer/regression comparison.

This is **a substantive owned-model path**, not a promise that a wrapper or a
small LoRA automatically equals Composer. The next funding decision should buy
candidate selection, a production-matched evaluation and a bounded training
feasibility profile. Its result can support a concrete compute budget; the
earlier broad-program estimate cannot do that on its own. The owner's willingness
to consider training changes the research emphasis, while the original limits
on actual implementation, provisioning and spending remain in force.

## 10. Budgeted model selection beyond DeepSeek

### Decision and constraints

The owner selected rented GPUs with operating cost controlled and **less than
$1,000 initial cash, excluding owner time**. This is a planning constraint, not
permission to rent hardware or submit paid turns. Three read-only research lanes
examined broader model availability/licenses, exact training recipes, and
independent coding evaluations. The application source is still `e5d31084`.

**First choice: Qwen3.8-27B for a main-agent adaptation feasibility study.**
Keep **GLM-4.7-Flash** as the operational backup if the first candidate fails a
quality or training gate. An older **Devstral Small 2 24B** can be a coding-control
baseline; **Gemma 4 31B** provides architectural diversity if needed. Spend the
first allocation on one trained base, not an equal-budget tournament across
every family. These are conditional research choices, not measured winners in
PacketBench.

### Why Qwen3.8-27B moves ahead of the earlier large-model shortlist

The publisher releases a dense 27B, native 262,144-context checkpoint with
flexible thinking/effort and reasoning retention. This exact checkpoint is
Apache-2.0; the family name alone is not a license.
[Publisher card](https://huggingface.co/Qwen/Qwen3.8-27B),
[actual license](https://huggingface.co/Qwen/Qwen3.8-27B/blob/main/LICENSE)

Vals independently reports **86.00% SWE-bench Verified and 58.43% Terminal-Bench
2.1** through Alibaba's hosted model, using xhigh effort in its published model
settings. That is evidence for a serious main coding candidate. It is not a
result for an arbitrary downloaded revision, quantization or PacketBench route.
[Evaluator results/settings](https://www.vals.ai/models/alibaba_qwen3.8-27b)

Vals also reports Composer 2.5 at **58.43% on Terminal-Bench 2.1**, but Composer
uses **Cursor CLI**, while Qwen uses **Terminus 2**. Equal point estimates in
different harnesses do not establish equivalence, equal speed or equal cost.
This evaluator has archived 2.1 in favor of 4.0, and archived Verified after
saturation. These older results justify candidate selection, not a current
frontier or parity announcement.
[Terminal results/methodology](https://www.vals.ai/benchmarks/terminal-bench-2-1),
[Verified status](https://www.vals.ai/benchmarks/swebench)

Qwen3.8-27B also has an exact checked-in Axolotl QLoRA example: rank 16,
2,048-token sequences, microbatch 1, checkpointing and the checkpoint's own chat
template with a reasoning-effort preamble. The example's ordinary conversation
dataset is not a coding corpus or a data-rights recommendation. Its existence
demonstrates a maintained training route, not a PacketBench quality gain or an
8k/128k training-memory result.
[Exact training configuration](https://raw.githubusercontent.com/axolotl-ai-cloud/axolotl/main/examples/qwen3.8/27b-qlora.yaml),
[merged support](https://github.com/axolotl-ai-cloud/axolotl/pull/3935)

### Shortlist by decision role

| Model                                                  | Why retain it                                                                                                                                                                                                                                                                                                                            | Decision under this budget                                                                                                                                                                            |
| ------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Qwen3.8-27B**                                        | Current compact main-agent evidence, Apache-2.0 and exact supervised training configuration. Dense compute may produce more latency than a small-active MoE.                                                                                                                                                                             | **First training candidate**, contingent on unmodified quality, serialization and memory profiling.                                                                                                   |
| **GLM-4.7-Flash**                                      | Approximately 30B total / 3B active MoE; publisher declares MIT, with preserved thinking and tool support. Exact training recipes and recorded notebook output exist. [Publisher card](https://huggingface.co/zai-org/GLM-4.7-Flash)                                                                                                     | **Backup**, not another automatic sweep. The publisher declares the weight license, but no standalone LICENSE was located in that exact repository; resolve the notice before distribution.           |
| **Qwen3-Coder-Next, 80B/3B**                           | Coding-specific Apache-licensed model; potentially useful throughput and non-thinking behavior. [Publisher card](https://huggingface.co/Qwen/Qwen3-Coder-Next)                                                                                                                                                                           | Later throughput/coding candidate if the dense model is too costly per accepted task. Training-framework coverage exists, but an exact cheap 4–8k measured Coder-Next recipe was not established.     |
| **Gemma 4 31B**                                        | Apache-licensed dense weights and native function-calling documentation; Unsloth publishes training support. [Publisher card](https://huggingface.co/google/gemma-4-31B), [function calling](https://ai.google.dev/gemma/docs/capabilities/text/function-calling-gemma4), [training guide](https://unsloth.ai/docs/models/gemma-4/train) | Worth a diversity baseline if Qwen disappoints. No inspected independent coding comparison here establishes superiority over Qwen; do not fund it merely to complete a family checklist.              |
| **Devstral Small 2, 24B**                              | Older Apache coding model with reproducible task evidence. The official SWE-bench board records 56.4% on 500 Verified tasks in mini-SWE-agent 1.17.2, one attempt, dated December 9, 2025. [Official results](https://www.swebench.com/)                                                                                                 | Useful coding control, not the newest quality default. Its hosted API deprecation does not remove downloadable weights. [Provider status](https://docs.mistral.ai/models/devstral-small-2-25-12)      |
| **Mistral Small 4, 119B/6.5B; Medium 3.5, 128B dense** | Newer Mistral alternatives with documented tool/reasoning and training routes. Small 4 is Apache; Medium 3.5 has modified MIT conditions. [Small 4](https://huggingface.co/mistralai/Mistral-Small-4-119B-2603), [Medium 3.5](https://huggingface.co/mistralai/Mistral-Medium-3.5-128B)                                                  | Later larger comparisons. Medium 3.5 replaces Devstral 2 in Vibe, but publisher product succession is not a reason to allocate this first training budget to a 128B dense model.                      |
| **Nemotron 3.5 Lightning, 30B/3B**                     | Compact hybrid model with open training assets and permissive OpenMDW 1.1 terms. [Publisher card](https://build.nvidia.com/nvidia/nemotron-3.5-lightning-30b-a3b/modelcard), [license](https://huggingface.co/nvidia/NVIDIA-Nemotron-3.5-Lightning-30B-A3B-BF16/blob/main/LICENSE)                                                       | Reserve as a training-stack/efficiency control. Current independent terminal evidence does not make it the leading coding choice. An open recipe and low token price do not establish coding quality. |

GLM-5.3-Flash is also a worthwhile **later large-model candidate**: official
320B-total/18B-active weights and an actual MIT license, with 1M context and
specialized attention. It is substantially smaller than Kimi K3 but still about
160 GB at ideal 4-bit before overhead. Preserve Kimi K2.7 Code, Kimi K3 and
DeepSeek V4.1 Flash as capability references from Section 9. A high hosted score
does not establish an economical training route for the same released weights.
[GLM publisher card](https://huggingface.co/zai-org/GLM-5.3-Flash),
[exact license](https://huggingface.co/zai-org/GLM-5.3-Flash/blob/main/LICENSE)

### Licensing changes the ranking

**Do not generalize license terms across a vendor or model generation.** Two
particularly relevant exclusions from the default product-base shortlist:

- **Qwen3.8 Flash Next, 125B/6B:** its Community License requires a separate
  license for commercial Model-as-a-Service or AI Work Assistant use, with an
  internal-use exception. The coding-assistant definition is directly relevant
  to PacketBench. This differs from both Apache Qwen3.8-27B and the $50M trigger
  on the much larger Qwen3.8 checkpoint discussed earlier. Obtain the applicable
  rights before adopting it as a product base.
  [Actual license](https://huggingface.co/Qwen/Qwen3.8-Flash-Next/blob/main/LICENSE)
- **MiniMax M2.7:** the current actual license is noncommercial and requires
  prior written authorization for any commercial use, including fine-tuned
  derivatives. Personal self-hosted experimentation is expressly permitted;
  that is different from a commercial PacketBench model. M3 has a different
  Community License with attribution and notice/authorization conditions.
  Neither should inherit an assumed MIT permission from another MiniMax release.
  [M2.7 license](https://huggingface.co/MiniMaxAI/MiniMax-M2.7/blob/main/LICENSE),
  [M3 license](https://huggingface.co/MiniMaxAI/MiniMax-M3/blob/main/LICENSE)

Step 3.5 Flash is an Apache-declared 196.81B-total/~11B-active later baseline,
roughly 98 GB ideal 4-bit before overhead. Step 5 Preview has actual published
weights now, but is a 600B model with custom StepFun terms and much larger
documented serving setups. Neither is the first sub-$1,000 training choice.
[Step 3.5 publisher](https://huggingface.co/stepfun-ai/Step-3.5-Flash),
[Step 5 weights and caveats](https://huggingface.co/stepfun-ai/Step-5-Preview-BF16/blob/main/README.md),
[Step 5 license](https://huggingface.co/stepfun-ai/Step-5-Preview/blob/main/LICENSE.txt)
Mistral Medium 3.5's separate commercial-license trigger is company/employer
consolidated revenue above $20M in the preceding **month**, not annual revenue.
[Actual Medium license](https://huggingface.co/mistralai/Mistral-Medium-3.5-128B/blob/main/LICENSE)

### What the training evidence does and does not establish

An exact recipe is stronger evidence than an inference-support list. It still
needs inspection. The Qwen3.8 Unsloth guide advertises 24 GB QLoRA, but the linked
notebook asserts at least 28 GB aggregate and uses 1,024-token/rank-8/batch-1
conditions. Its note describes allocator-capped measurements on a larger card,
not measured dual-T4 throughput; there are no saved execution outputs. The
guide's RL link also points to a different model notebook, while its written
Qwen RL route disables fast inference. Do not price coding RL from that button.
[Framework guide](https://unsloth.ai/docs/models/qwen3.8/train),
[notebook source](<https://raw.githubusercontent.com/unslothai/notebooks/main/nb/Kaggle-Qwen3.8_(27B)-Conversational.ipynb>)

GLM has useful recorded output: an Unsloth notebook shows an A100 80 GB at 2k
sequence length, rank 8, roughly 65.738 GiB reserved, and 60 steps in about 1,052
seconds. That is math-style conversational training, not a coding-quality or
4–8k capacity result. The Axolotl GLM guide correctly names MLA projections, but
its current QLoRA YAML lists ordinary Q/K/V module names that do not match this
architecture; copying it can silently narrow adapter coverage. Enumerate matched
modules and trainable parameter counts before spending on a sweep. Pin one
coherent framework/recipe revision; source cells and saved outputs can differ.
[Executed GLM notebook](<https://raw.githubusercontent.com/unslothai/notebooks/main/nb/GLM_Flash_A100(80GB).ipynb>),
[GLM training guide](https://docs.axolotl.ai/docs/models/glm47-flash.html),
[current example](https://raw.githubusercontent.com/axolotl-ai-cloud/axolotl/main/examples/glm47-flash/qlora.yaml)

For Qwen3-Coder-Next, framework registration explicitly distinguishes its coder
template. Axolotl's measured Qwen3-Next example instead names the earlier
Instruct checkpoint; its memory figures cannot silently become an exact
Coder-Next training measurement. Gemma and Devstral also need their own
templates, loss masks, reasoning-history policy and parser validation.
[MS-SWIFT registration](https://github.com/modelscope/ms-swift/blob/main/swift/model/models/qwen.py),
[actual Qwen3-Next example](https://raw.githubusercontent.com/axolotl-ai-cloud/axolotl/main/examples/qwen3-next/qwen3-next-80b-a3b-qlora.yaml)

The production contract also limits what can be compared today:
[LlmRequest](../src-tauri/src/core/llm_types.rs), lines 154–178, has an Anthropic
thinking boolean/budget but no general reasoning-effort field. Qwen's hosted
xhigh evaluation setting is not automatically an explicit PacketBench setting.
Verify the effective server default or separately approved parameter support,
template and output cap. This research does not change that contract or duplicate
the separately owned runtime/evaluation work.

### Independent harder-task evidence and revision identity

The current Vals Terminal-Bench 4.0 page, updated October 18, uses a common
mini-SWE-agent/bash scaffold on 66 new tasks, mean pass@1 across three full-suite
runs (avg@3), an eight-hour task limit, and no step/cost cap. It reports
GLM-5.3-Flash at **37.37%
and $1.22/test**, versus **31.82% and $0.54/test** for DeepSeek V4.1 Flash
**1017**. This gives a useful larger-model quality/cost reference, not a recipe
for a cheap first evaluation. It is a different task set from 2.1 and includes
broad terminal work; only 18 of 66 tasks are categorized Software.
[Current evaluator/methodology](https://www.vals.ai/benchmarks/terminal-bench-4)

The **1017 hosted release** must not be equated to an earlier downloaded
DeepSeek checkpoint. Likewise, a hosted GLM alias or Qwen Cloud result is not an
immutable weight hash. Pin source revision, tokenizer, quantization, kernel,
parser, effective reasoning/output settings and host before interpreting our
own result. General intelligence indices and completion-only code benchmarks
cannot replace coding-agent outcomes.

### A proposed $950 experiment, not an approved spend

This is a cash allocation proposal under the owner's $1,000 limit, excluding
engineering and curation time. It would investigate whether an owned main-agent
adapter can improve bounded coding work. It cannot fund or establish universal
Composer parity. Use **one** trained checkpoint and at most one planned revision;
the backup is conditional, not an additional automatic experiment.

| Allocation                                                                   | Proposed ceiling |
| ---------------------------------------------------------------------------- | ---------------: |
| Unmodified baseline, protocol and limited reference evaluation               |             $120 |
| Rights-cleared data generation/verification compute                          |             $100 |
| Memory/throughput profiling, sanity training and up to two small SFT runs    |             $200 |
| Sealed base-versus-adapter evaluation, regressions and reload/serving checks |             $250 |
| Storage, separate CPU verification and transfers                             |              $50 |
| Unspent contingency, including setup/fees/failures                           |             $230 |
| **Total**                                                                    |         **$950** |

An 80 GB NVIDIA rental is the conservative starting profile target. Assume an
all-in training-host planning rate no higher than approximately $4/hour and
confirm actual CPU/RAM, storage, startup, idle and minimum billing before any
future action. Section 7's currently observed A100-80 GB GPU-only rate is about
$2.50/hour; that is not a guaranteed all-in reservation. The $200 training line
therefore allows about 50 hours at the planning ceiling, not a promised token
count. Preserve the evaluation allocation if training is slower than expected.
The contingency is not permission for more sweeps or recurring hosting.

Proposed sequence:

1. **No GPU needed:** inspect 100–200 rights-cleared examples for roles, tool
   schemas/call IDs, complete observation boundaries, loss masks, templates and
   token lengths. Prepare development and sealed repository/task-family splits.
   The existing production-evaluator seam is a prerequisite, not included app
   implementation under this research authorization.
2. **Unmodified screen:** run Qwen plus one useful control on a small common
   development set through the production executor. Confirm capability rather
   than assume a cheap adapter will rescue a weak base. Reference-provider
   outputs used for comparison are not automatically training data.
3. **Profile and sanity-check:** one forward/backward step at the documented
   2k setup, then 4k and 8k only as measured gates. Freeze vision initially,
   verify adapter targets/finite gradients, and check 20–50-step save/reload and
   serving behavior. Disabled adapters must reproduce the chosen baseline.
4. **One bounded SFT study:** approximately 200–1,000 verified coding-decision
   windows as an initial learning-signal test. Preserve complete tool boundaries
   and adequate prior state. Do not claim this size supplies missing general
   coding ability or teaches 200k-session management.
5. **Sealed comparison:** propose 12 new tasks × two trials × base/adapted arms
   = **48 runs**, plus deterministic authority/regression cases, at equal
   context, precision, tool contract and resource limits. Expand only if the
   measured timing fits the remaining allocation. The larger suite in Section 5
   is a later confirmation design, not promised within this first cash budget.

Stop before a full run if 4k examples cannot train stably in the profiled
single-server envelope, required tools/reasoning cannot be faithfully expressed,
module/loss/reload checks fail, rights-cleared examples are unavailable, or the
unmodified base is far below useful quality. Stop after a pilot if improvement
disappears on unseen tasks or cost/interventions erase it. A negative conclusion
after $100–$300 is preferable to consuming the evaluation allocation without a
credible comparison. Keep RL, continued pretraining and persistent large-model
hosting outside this first experiment.

**Current decision:** investigate Qwen3.8-27B as the first owned main-model base,
retain GLM-4.7-Flash as the training backup and an older Devstral or Gemma control
as needed, and use large DeepSeek/Kimi/GLM models to understand the remaining
quality gap. This is a route toward measured Composer 2.5 parity, not a reason
to assume either that a trillion-parameter model is required or that a small
adapter will achieve it.
