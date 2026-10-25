# Removing subscription OAuth from the Agents (API) surface

Status: **DONE — but NOT by the plan below.** WI-1 shipped as written (`d8fb78e`);
the rest was superseded by a re-authentication approach and implemented
2026-07-31 (`422ab94`). **One item is deliberately still open: WI-5**
("switch provider" for conversations on the retired `api-openai-codex` id) —
P2, tracked as F-2.3-16 in the State of the ADE report.
See §-1 first. Everything from §1.2 onward is retained as the blast-radius map
that made the change tractable, not as instructions.
Created: 2026-07-31
Owner decision (2026-07-31): *"let's not use OAuth with agents."*
Owner decision (2026-07-31): route the auxiliary features through the
task-routing layer at the cheapest configured API provider.
Owner decision (2026-07-31, **supersedes the staging in §4**): do not gate or
delete the Agent SDK path — **re-authenticate it with an API key**.
Repo state at analysis time: `main` @ `4d3df4f`.

---

## -1. WHAT ACTUALLY SHIPPED (read this before anything below)

The plan below assumed one thing that turned out to be false: that removing
subscription OAuth meant removing the Claude Agent SDK row. It does not.

**The prohibition is on the credential, not the SDK.** The Agent SDK
[Quickstart](https://code.claude.com/docs/en/agent-sdk/quickstart) says, of
products built on the SDK: *"Unless previously approved, Anthropic does not
allow third party developers to offer claude.ai login or rate limits for their
products, including agents built on the Claude Agent SDK. Please use the API key
authentication methods described in this document instead."* The
[legal-and-compliance page](https://code.claude.com/docs/en/legal-and-compliance)
says developers *"including those using the Agent SDK, should use API key
authentication through Claude Console or a supported cloud provider."*

So the SDK is the **sanctioned** path. §2.1's capability table — which
correctly showed that migrating `api-claude-oauth` → `api-claude` is a real
downgrade (no targeted edit tool, no `plan_block`, weaker plan mode, no Claude
Code settings sourcing) — is now an argument for **keeping** the SDK row, not a
cost to be absorbed.

### What changed

1. **`api-claude-oauth` was re-authenticated, not removed.** Label:
   "Claude Agent SDK (API)". `agent-sidecar/src/providers/anthropic.ts` now
   requires `req.apiKey` (the pattern `openai-agents.ts` already used) and
   passes it as `ANTHROPIC_API_KEY` through the SDK's `Options.env`. Rust loads
   it from keyring `api-key-anthropic` in the `api_agent.rs` sidecar-routing
   branch. `CLAUDE_CODE_OAUTH_TOKEN` is blanked in the same env map. A missing
   key fails the session immediately with a Settings pointer — it never falls
   through to whatever credential the machine has.
2. **The ids were NOT renamed.** `api-claude-oauth` / `claude-oauth` survive as
   historical identifiers. Rationale in §-1.1.
3. **`api-openai-codex` was removed outright**, per §1.5/§2.2 — but with the
   §3.3 graceful-degradation behaviour implemented at the same time rather
   than a release later.
4. **No build-time gate was introduced.** WI-2, WI-3, WI-12 are moot: there is
   nothing left to gate. `src/lib/env.ts` and `src-tauri/Cargo.toml` were not
   touched.
5. **Stage C's deletions happened immediately for Codex** (`openai-codex.ts`,
   `codex-mcp.ts`, `mcp-trust-proxy.ts`, three smoke gates) and **never for
   Anthropic** — `anthropic.ts` and `@anthropic-ai/claude-agent-sdk` are load-
   bearing again. §1.2's "FULLY DEAD" verdict on `anthropic.ts` is wrong.

### -1.1 Why the ids were kept

The plan's §3.2 correctly warned against *aliasing* `api-claude-oauth` to
another provider. Renaming it to something honest (`api-claude-agent-sdk`) is a
different operation, and it was still rejected:

- **`AgentConversation.provider` is read verbatim on resume**
  (`agentTaskStore.ts` `resumeApiConversation`) and is never canonicalised on
  load — §3.1 flags this. A rename needs a second migration path on a field
  with no existing shim, for zero user-visible benefit.
- The `api-claude-oauth` ↔ `claude-oauth` pair is load-bearing in
  `costGuardrails.providerSourceForAgentProvider` and `flight_cost.rs`'s strip
  site. Renaming splits historical spend across two keys.
- The id is internal. The user-facing string is the label, and that changed.
- The retired-id treatment is expensive and was spent where it is actually
  needed: the Codex row, where the provider genuinely no longer exists.

Every site that could mislead a reader carries a comment saying the id does not
imply OAuth. `authProbeProvider` (new, in `agentTaskStore.ts`) is the seam that
keeps the *badge* honest: it maps the Agent SDK row to the `anthropic` keyring
probe, so the Agents pane stopped calling the `claude-oauth` OAuth probe without
that probe being deleted — §1.3's fence held.

### -1.2 Capability parity under API-key auth — verified

The docs document permissions (`canUseTool`), `permissionMode` including
`"plan"`, `mcpServers`, `hooks` (`PreToolUse`), streaming input mode,
`interrupt()` / `setPermissionMode()` / `setModel()`, the full built-in tool
suite, and `settingSources` loading of `~/.claude` + project `.claude/` **once,
for the SDK, without branching on auth mode**. Nothing is documented as
subscription-only. The tier/provider caveats that do exist (Artifact tool,
RemoteTrigger, WebSearch on Bedrock) are claude.ai or cloud-provider
limitations, not API-key limitations.

Caveat worth recording: the docs do not *affirmatively state* that every feature
behaves identically under both auth modes — they simply never branch. Empirical
support from the installed SDK 0.2.116: `ApiKeySource` is `'user' | 'project' |
'org' | 'temporary' | 'oauth'` (distinct sources, same runtime), and the session-
store code path explicitly skips importing `.credentials.json` when
`ANTHROPIC_API_KEY` is set. Nothing found suggests a capability split.

### -1.3 Follow-ups this change could not close

- ~~`src/components/flights/LaunchAsyncFlightModal.tsx:102,105` still defaults its
  reviewer to `api-openai-codex`~~ — **CLOSED in the same commit** (`422ab94`,
  later in the loop than this note was written). Verified 2026-07-31: both the
  agent and the model default to `api-openai-agents`. The modal's
  `if (!reviewerProvider) return "Choose a supported API reviewer."` guard and
  `reviewerGateRuntime.ts`'s substitution for persisted policies remain as the
  belt-and-braces layer.
- `agent-sidecar/package.json` still declares `@modelcontextprotocol/sdk`, whose
  only importer (`mcp-trust-proxy.ts`) was deleted. Dropping it changes the
  lockfile and the `prune-sidecar.js` bundling path, so it was left for a
  deliberate dependency pass.
- `agent_sidecar/handler.rs`'s cumulative-token branch
  (`owner.provider == "openai-codex"`) is now reachable only for historical
  flight attempts. Left in place so old data cannot double-count.
- `mcp-config.ts` still hardcodes `~/.claude/settings.json` as the global MCP
  source for `openai-agents` too (§6's last row). Unchanged, still odd.

> **UPDATE 2026-07-31 — WI-1 is implemented.** The four auxiliary features no
> longer touch subscription credentials. New seam:
> `src-tauri/src/core/aux_llm.rs` (the `core/aux_llm.rs` that
> [`local-model-routing.md`](./local-model-routing.md) LM3 proposed) plus
> `src-tauri/src/commands/aux_routing.rs` for the settings surface. Provider and
> model come from the routing settings, else the cheapest provider with a
> keyring `api-key-*` credential, ranked against `shared/model-pricing.json`.
> With nothing configured the feature fails with a Settings → API Keys pointer;
> there is no OAuth fallback. `SidecarManager::forward_start` (the bare wrapper)
> was deleted along with its only four callers, so every remaining path into the
> sidecar comes from `api_agent.rs`'s `is_sidecar_provider`-gated routing layer.
> `commands/aux_routing.rs::auxiliary_features_never_start_a_sidecar_session` is
> the standing CI check §6 asks for. Frontend: `Draft patch` resolves through
> `src/lib/attemptRouting.ts` → `routingStore.resolveForTask("implementation")`,
> and `ProviderRoutingCard` gained an "Auxiliary AI tasks" section — so
> `resolveForTask`/`resolveForAuxTask` now have production callers and that card
> is no longer a placebo. **Line references below predate these edits.**

> **UPDATE 2026-07-31 — WI-0 is no longer a blocker.** The owner removed the
> cost reporting surface (Cost Dashboard, live-spend chip, per-conversation
> dollar readouts) and **cut CE5** with it; see
> [`cost-efficiency-loop.md`](./cost-efficiency-loop.md) §0. The CE5-first rule
> existed solely to avoid freezing half the *dashboard's* history mid-transition.
> There is no dashboard, so **OAuth removal is not gated on any item in the cost
> plan.** Everything below that reads "HARD BLOCKER: WI-0" is now advisory: the
> only surviving concern is that the budget **guardrails** see less spend from
> the vendor-CLI files afterwards, and migrated traffic on `api-claude` /
> `api-openai` does write `~/.packetbench/usage.jsonl`, so coverage moves rather
> than disappears. `CostDashboardView.tsx` references below are dead file paths;
> the `SOURCE_LABELS` / `SOURCE_PILL_CLASSES` maps they point at were deleted
> with the view. `costGuardrails.ts` read-compat (WI-7) still matters.

Related:

- [`cost-efficiency-loop.md`](./cost-efficiency-loop.md) — ~~CE5 is a hard
  prerequisite of shipping this~~ **CE5 is CUT; the constraint is dissolved**
  (see the update box above and `cost-efficiency-loop.md` §0).
- [`local-model-routing.md`](./local-model-routing.md) — LM4/LM5 currently assume
  the opposite policy; see §7.4.
- [`sidecar-over-ssh-verification.md`](./sidecar-over-ssh-verification.md) — its
  verification contract is written for "subscription providers"; needs rescoping.

---

## 0. Motivation (verbatim, not re-litigated here)

`https://code.claude.com/docs/en/legal-and-compliance` states that Claude Code
OAuth "is intended exclusively for purchasers of Claude Free, Pro, Max, Team, and
Enterprise subscription plans and is designed to support ordinary use of Claude
Code and other native Anthropic applications", that "Anthropic does not permit
third-party developers to offer Claude.ai login or to route requests through
Free, Pro, or Max plan credentials on behalf of their users", and that
enforcement may occur "without prior notice". The Agent SDK overview carries a
matching note.

PacketBench's `api-claude-oauth` row reads `~/.claude/.credentials.json` and drives
the Claude Agent SDK inside the Node sidecar
(`agent-sidecar/src/providers/anthropic.ts:8`;
`agent-sidecar/src/session-registry.ts:31`) — squarely the configuration the
policy describes. OpenAI has published no equivalent rule; `api-openai-codex` is
being removed by owner preference, not by a documented prohibition. That
asymmetry matters for staging (§4).

### 0.1 Scope boundary — READ THIS FIRST

**This removes OAuth from the AGENTS / API-agent surface only.**

PTY-backed CLI sessions that run the real `claude` / `codex` binaries in a
terminal are *ordinary use*, are explicitly **not** affected, and must keep
working exactly as they do today — including the multi-account CLI feature
shipped in `4d3df4f`:

- `CliAccount` records — `src/types/cliAccount.ts:24-70`,
  `src-tauri/src/core/storage.rs:79`, `:147`
- `CLAUDE_CONFIG_DIR` / `CODEX_HOME` injection — `src/lib/cliAccountEnv.ts`,
  `src/lib/sessionAccountDefaults.ts`,
  `src-tauri/src/commands/cli_account.rs`
- Per-account auth probes — `src-tauri/src/commands/provider_auth.rs:327-357`,
  `:536-553`; `src/hooks/useAccountLaunchGate.ts:24,109,119,133`
- Per-account fs watching — `src-tauri/src/commands/auth_watcher.rs:130-302`
- Login PTYs — `src/components/auth/LoginPtyModal.tsx`,
  `src/components/auth/AccountLoginModal.tsx`,
  `src/components/views/tools/SubscriptionsCard.tsx`

None of the above is in scope for deletion. §1.3 enumerates precisely which
shared code this creates a "do not delete" fence around.

---

## 1. Blast radius

### 1.0 The id mapping (essential context)

The `api-*` ids are **frontend-only**. Rust and the sidecar never see
`api-claude-oauth`; they see the stripped short id.

| Frontend `AgentCli` | Backend provider string | Transport |
| --- | --- | --- |
| `api-claude-oauth` | `claude-oauth` | sidecar → Claude Agent SDK, OAuth from `~/.claude` |
| `api-openai-codex` | `openai-codex` | sidecar → `codex exec`, OAuth from `~/.codex/auth.json` |
| `api-openai-agents` | `openai-agents` | sidecar → OpenAI Agents SDK, **API key from keyring** |

Strip sites: `src/stores/agentTaskStore.ts:182-205` (`apiAgentProvider`),
`src/lib/costGuardrails.ts:327-353`, and the Rust mirror
`src-tauri/src/commands/flight_cost.rs:156`
(`t.agent_config_id.trim_start_matches("api-")`).

Consequence: `api-claude-oauth` / `api-openai-codex` appear in `src-tauri/**`
**exactly once** — a test fixture at
`src-tauri/src/commands/flight_cost.rs:495`. All backend work keys on
`claude-oauth` / `openai-codex`.

### 1.1 VERIFIED: `api-openai-agents` is an API-key provider and survives

This was the load-bearing question for how much of the sidecar can go. It is
confirmed API-key, not OAuth:

- `agent-sidecar/src/providers/openai-agents.ts:1-6` — header: *"OpenAI Agents
  SDK provider (API-key auth) … Codex CLI remains the ChatGPT subscription path;
  this file is the BYOK OpenAI Agents SDK path."*
- `agent-sidecar/src/providers/openai-agents.ts:260-269`:

  ```ts
  if (!req.apiKey || req.apiKey.trim().length === 0) {
    emit({ type: "error", sessionId: req.sessionId,
      message: "No OpenAI API key was provided to the OpenAI Agents SDK provider." });
    return;
  }
  setDefaultOpenAIKey(req.apiKey);
  ```

  These are the **only** occurrences of `apiKey` / `OPENAI_API_KEY` /
  `auth.json` / `process.env` in that 1077-line file.
- Key origin: `src-tauri/src/commands/api_agent.rs:908-912` —
  `if provider == "openai-agents" { Some(api_keys::load_api_key("openai")?) } else { None }`.
  The two OAuth providers deliberately pass `None`.
- Auth badge: `src-tauri/src/commands/provider_auth.rs:465-470` aliases
  `openai-agents` → `openai` for `get_api_key_exists`.

**Therefore the Node sidecar, its supervisor, its protocol, and its whole
event-forwarding stack must survive.** Only two of its four providers go.

### 1.2 Code that becomes DEAD

#### Frontend (`src/`)

| File:line | What | Note |
| --- | --- | --- |
| `src/lib/api-models.ts:43-54` | `anthropic-oauth` row | delete/gate |
| `src/lib/api-models.ts:68-87` | `openai-codex` row incl. `supportsApprovals: false` | delete/gate |
| `src/lib/api-models.ts:180-188` | `providerSupportsApprovals` — `api-openai-codex` is the **only** `false` | becomes a no-op; keep the function |
| `src/stores/agentTaskStore.ts:136,138` | `ApiAgentCli` members | |
| `src/stores/agentTaskStore.ts:150,152` | `AgentCli` members | union is open (`\| (string & {})` at `:158`), so removal does not break persisted values |
| `src/stores/agentTaskStore.ts:184,186` | `apiAgentProvider` map entries | **keep as read-compat** — see §3 |
| `src/stores/agentTaskStore.ts:207-211` | `apiAgentCommandPath` — exists only for `api-openai-codex` | fully dead |
| `src/components/agents/composer/utils.ts:52-67` | `PROVIDER_GROUPS` entries at `:59`, `:63`, and the doc comment | also the auth-poll source (`useProviderAuthStatus.ts:36`) |
| `src/components/views/AgentsView.tsx:21-30` | `AUTO_PICK_ORDER` — OAuth ids are ranks 1 and 3 | untested today; see §6 |
| `src/lib/agent-catalog.ts:61-70` | `CHAT_FACE` entries `:62`, `:64` | `Partial<Record<…>>`; stale keys harmless |
| `src/components/agents/ContinueInMenu.tsx:80-87` | `CONTINUATION_CLIS` `:85`, `:86` — the only two entries | whole map dies |
| `src/components/agents/composer/Composer.tsx:414-434` | `needsLogin` branch + login events + tooltip | only these two providers had an interactive-login affordance |
| `src/components/agents/PlanPanel.tsx:182-198, 207, 226-244` | Codex auth probe + "Hand off to Codex" | see §2.3 — this is a **feature loss**, not just dead code |
| `src/components/agents/AgentModeChip.tsx:112-117,148`; `agentModeChipUtils.ts:36-37,85-91` | sandbox-mode label swap, reachable only via `supportsApprovals: false` | becomes unreachable |

Tests that will fail or become vacuous:
`src/components/agents/__tests__/AgentModeChip.test.tsx:121-155`,
`agentModeChipUtils.test.ts:18`,
`PlanPanel.handoff.test.tsx:65,125`,
`ReviewSurface.remoteGating.test.tsx:53`,
`src/lib/__tests__/agentCatalog.test.ts:31-50`,
`flightCoordination.test.ts:148,155`,
`autonomyPolicy.test.ts:43`, `reviewerGate.test.ts:34`,
`tauriPersistence.test.ts:78,91,115,122`,
`boundedAutonomyRuntime.test.ts:95`,
`agentWorkspaceDecoupling.test.ts:169,271,308`.

#### Rust (`src-tauri/`)

| File:line | What | Verdict |
| --- | --- | --- |
| `commands/agent_sidecar/mod.rs:30` | `SIDECAR_PROVIDERS = ["claude-oauth", "openai-codex", "openai-agents", "echo"]` | drop two entries; **keep the const and `is_sidecar_provider` (`:85`)** |
| `commands/agent_sidecar/mod.rs:126-127` | test assertions | update |
| `commands/agent_sidecar/supervisor.rs:1475-1485` | `remote_auth_preflight` — the **only** provider `match` in the module; both arms are OAuth | function body collapses to `""`; `remote_sidecar_preflight_script` (`:1487-1509`) stays (openai-agents-over-SSH needs it) |
| `commands/agent_sidecar/supervisor.rs:1761-1772` | preflight test | update |
| `commands/agent_sidecar/handler.rs:571` | `let cumulative = owner.provider == "openai-codex";` + reset logic `:572-620` | dead branch; `exec_token_snapshots` / `exec_turn_seq` (`supervisor.rs:133`) become dead state |
| `commands/provider_auth.rs:510-511` | the two OAuth arms of `get_provider_auth_status` | **KEEP** — still used by `SubscriptionsCard` for PTY logins and by `get_provider_auth_status_for_dir`'s empty-dir delegation (`:541-543`) |
| `commands/flight_cost.rs:99-106, 495, 504` | doc + fixtures naming the OAuth providers | cosmetic |
| `core/contract_tests.rs:386, 420` | `"planner_provider": "claude-oauth"` fixture | legacy planner data; leave |

**Not affected at all:** `commands/pricing.rs` is model-keyed and contains zero
provider ids. `commands/usage.rs` `source` is a free string. `provider_stats.rs`
is a `HashMap<String, u64>`.

#### Sidecar (`agent-sidecar/`)

| Module | Verdict |
| --- | --- |
| `src/providers/anthropic.ts` (1230 lines) | **FULLY DEAD** |
| `src/providers/openai-codex.ts` (1389 lines) | **FULLY DEAD** |
| `src/codex-mcp.ts` | **FULLY DEAD** — only importer is `openai-codex.ts:58` |
| `src/mcp-trust-proxy.ts` | **FULLY DEAD** — only entry point is `codex-mcp.ts:65` (`buildCodexMcpLaunch`) |
| `src/session-registry.ts:18-19, 31-32` | drop two imports + two map entries; rest is generic |
| `src/mcp-trust.ts` | **PARTIALLY dead.** `mcpToolDenial` (`:110`) survives via `openai-agents.ts:41,558`; `applyMcpTrustSnapshot` (`:40`) survives via `session-registry.ts:15`. `parseAnthropicMcpToolName` (`:138`) becomes fully dead (`anthropic.ts` was its only consumer). `allowedMcpToolNames` (`:150`) becomes dead once `codex-mcp.ts` and `mcp-trust-proxy.ts` go. |
| `src/mcp-config.ts` | **SURVIVES** — called from `session-registry.ts:14,107`, provider-agnostic. Note `:44-45` hardcodes `~/.claude/settings.json` as the global MCP source *even for openai-agents* — an odd coupling worth revisiting but out of scope. |
| `src/protocol.ts`, `src/providers/base.ts`, `src/index.ts`, `src/providers/echo.ts` | **SURVIVE** |
| `src/provenance.ts` | already orphaned today (zero importers); unrelated pre-existing dead code |
| dependency `@anthropic-ai/claude-agent-sdk` | **removable** — this is the single largest bundle-size win |
| dependency `@modelcontextprotocol/sdk` | used **only** by `mcp-trust-proxy.ts` → removable with it |
| dependencies `@openai/agents`, `zod` | **keep** (`openai-agents.ts:16,26`) |

Sidecar smoke gates that die: `anthropic-multi-turn-smoke.mjs`,
`codex-0142-schema-smoke.mjs`, `codex-mcp-trust-smoke.mjs`,
`codex-permission-nohang-smoke.mjs`. Partially affected:
`registry-smoke.mjs`. Survive: `openai-agents-gating-smoke.mjs`,
`echo-smoke.mjs`, `mcp-config-merge-smoke.mjs`, `mcp-trust-smoke.mjs`,
`protocol-v9-smoke.mjs`, `remote-*-smoke.mjs`, `session-ordering-smoke.mjs`.

### 1.3 Code that must NOT be deleted (PTY / multi-account CLI fence)

`provider_auth.rs` is the highest-risk file in this change. **Nearly all of it is
live for the PTY multi-account CLI feature.** The per-dir and ambient probes
share every helper by design — `provider_auth.rs:222-224` states the extraction
exists *"so the ambient `~/.claude` probe and the per-account `CLAUDE_CONFIG_DIR`
probe cannot drift apart."*

Keep, in full:

- `now_unix_secs` (`:6-12`), `format_relative_expiry` (`:20-50`),
  `expiry_to_status` (`:66-95`), `parse_claude_expiry_secs` (`:106-113`),
  `parse_claude_has_refresh_token` (`:120-131`), `base64url_decode` (`:136-160`),
  `parse_codex_expiry_secs` (`:173-186`), `parse_codex_has_refresh_token`
  (`:191-202`)
- `claude_credential_candidates` (`:207-209`), `codex_credential_candidates`
  (`:213-215`) — `root` is `CLAUDE_CONFIG_DIR` / `CODEX_HOME`
- `probe_oauth_credentials` (`:229-278`) — the one shared file-probe loop
- `claude_config_dir_missing_status` (`:306-326`) — **PTY-only**, macOS Keychain caveat
- `probe_claude_oauth_in_dir` (`:327-337`), `probe_codex_oauth_in_dir` (`:339-357`)
  — **PTY-only, the multi-account launch gate**
- `probe_claude_oauth` (`:359-388`), `probe_codex_oauth` (`:390-418`) — reached
  from the CLI path via the empty-`config_dir` delegation at `:541-543`
- `sign_out_provider` (`:435-460`) — wired to `SubscriptionsCard`, which is the
  PTY login surface
- `get_provider_auth_status_for_dir` (`:536-553`) — exists **only** for
  multi-account CLI

Also keep in full: `commands/auth_watcher.rs` (roughly half of it —
`cli_to_provider` `:130-138`, `watched_accounts_from` `:146-160`,
`load_cli_accounts` `:162-170`, `desired_watch_targets` `:186-224`,
`is_state_file_event` `:258-269`, the per-account arm of `probe_for_key`
`:280-287` — is pure multi-account infrastructure), `commands/cli_account.rs`,
`core::storage::CliAccount`, `api::CliAccountDto`, and the
`provider-auth:changed` event contract (listeners at
`src/stores/authStatusStore.ts:239`, `src/hooks/useAccountLaunchGate.ts:133`,
`src/components/views/tools/SubscriptionsCard.tsx:103`).

**The short provider ids `claude-oauth` and `openai-codex` must remain valid
inputs to `get_provider_auth_status` and `get_provider_auth_status_for_dir`
forever.** They are the PTY slots' auth identities
(`src/hooks/useAccountLaunchGate.ts:34-35`).

### 1.4 The finding that changes the shape of this work: three auxiliary features hardcode `claude-oauth`

Outside the Agents picker, **three shipped product features start one-shot
`claude-oauth` sidecar sessions**. The user never chooses a provider for these —
the app routes their Claude subscription credentials through the Agent SDK
silently:

| Feature | Constant | `forward_start` call |
| --- | --- | --- |
| Spec → Issues import | `commands/issues.rs:79` `SPEC_IMPORT_PROVIDER` | `:177-198` |
| Code Quality AI explain / summarize | `commands/code_quality.rs:485` `AI_QUALITY_PROVIDER` | `:708`, `:878` |
| GitHub PR description / PR review | `commands/github.rs:1602` `AI_PR_PROVIDER` | `:1848`, `:1972` |

Plus a fourth, frontend-side: **GitHub "Draft patch"** hardcodes an
`api-claude-oauth` attempt target —
`src/components/views/github/InvestigationPanel.tsx:137-139`.

Two things follow:

1. These call `SidecarManager::forward_start` **directly**, bypassing
   `is_sidecar_provider` (which only gates `api_agent.rs:889`). So removing
   `claude-oauth` from `SIDECAR_PROVIDERS` does **not** disable them — they keep
   running, and the compliance exposure survives the "removal" entirely.
2. On the compliance argument they are *worse* than the picker row, because the
   user did not opt in. **If the motivation in §0 is taken seriously, these are
   the higher-priority fix, not the lower one.**

This is the single most important finding in this document.

### 1.5 Product features that hardcode `api-openai-codex` and would break

- `src/components/flights/LaunchAsyncFlightModal.tsx:131-137` — default reviewer
  agent and its default model (`getDefaultModel("api-openai-codex")`, which
  returns `""` once the row is gone).
- `src/components/flights/CooperativeFlightCard.tsx:57-58` — `reviewer` / `scout`
  roles auto-assign to `api-openai-codex`.
- `src/components/agents/PlanPanel.tsx:226-244` — "Hand off to Codex" executor.

### 1.6 Docs

`README.md:64,66,133,341,365-366,379`; `CLAUDE.md` (the whole "Conversation Tiles
& Sidecar" table — note it is already stale: it says `PROTOCOL_VERSION` 10 while
`agent_sidecar/mod.rs:81` and `README.md:133` say **11**);
`dev/sidecar-over-ssh-verification.md` (rescope to `openai-agents`);
`dev/cost-efficiency-loop.md` (SPIKE-2 targets an `api-claude-oauth` session);
`dev/local-model-routing.md` and `backlog.md:549-556` (see §7.4);
`dev/archive/tile-program/*`, `dev/remoteagents/06-implementation-plan.md`,
`dev/mobile/architecture-fit.md`, `dev/spike-macos-keychain-namespacing.md`.
`CHANGELOG.md` is shipped history — do not rewrite it.

---

## 2. What replaces them for users — honest capability assessment

Surviving rows: Claude (API key), OpenAI (API key), OpenAI Agents SDK, MiniMax,
OpenRouter, Ollama.

### 2.1 `api-claude-oauth` → `api-claude` is **NOT** a full functional replacement

The two Anthropic rows are not the same agent with different billing. They are
two different agents.

| Capability | sidecar `api-claude-oauth` (Claude Agent SDK) | in-process `api-claude` (`LlmProvider`) |
| --- | --- | --- |
| Tool suite | Full Claude Code suite (Read, **Edit/MultiEdit**, Write, Glob, Grep, Bash, WebFetch, **WebSearch**, Task, TodoWrite, NotebookEdit) | `read_file`, `write_file`, `list_directory`, `bash`, `grep` (`core/tool_runtime.rs:123-193`) + `web_fetch`, `spawn_subagent`, `create_pull_request` (`:206-208`) + task/MCP/custom-agent/GitHub tools (`:210-225`) |
| **Targeted edit tool** | yes | **NO** — `write_file` takes full content; `cost-efficiency-loop.md:35` records this as a known gap, and CE14 is the item that would add one |
| **`plan-block` (structured TodoWrite plan)** | yes — `anthropic.ts:781` → `agent_sidecar/handler.rs:382` → `events.rs:43` | **NO** — `plan_block_event` exists only under `commands/agent_sidecar/`; the in-process path never emits it. `PlanPanel`/`agentPlanStore` degrade to prose parsing |
| `tool_output_extended`, `mcp_sources` | yes (`events.rs:46,54`) | **NO** |
| Plan mode | real SDK `permissionMode` mapping (`anthropic.ts:113-116`) | crude tool-name allowlist: `PLAN_MODE_ALLOWED = ["read_file","list_directory","grep"]` (`api_agent.rs:1972`) |
| Claude Code settings sourcing (hooks, slash commands, subagent defs, CLAUDE.md) | native to the SDK | **NO** |
| Permission round-trip | yes (`anthropic.ts:441` `canUseTool`) | **yes** (`api_agent.rs:2050`) |
| Pending-edit diff + baseline | yes (`anthropic.ts:522,562`) | **yes** (`api_agent.rs:2232`, `:244`) |
| Thinking / thinking-stop | yes (`anthropic.ts:736-751`) | **yes** (`api_agent.rs:231-234`) |
| MCP | yes (`anthropic.ts:591-601`) | **yes** (`api_agent.rs:1699-1712` via `core/mcp_bridge.rs`) |
| Attachments | yes (protocol v3) | **partially broken** — injected on iteration 0 only then `mem::take`n (`api_agent.rs:1767-1777`); the model loses the image after its first tool call. `cost-efficiency-loop.md:340-342` (CE7) is the fix |
| SSH remote | yes | yes (`core/tool_runtime_ssh.rs`) |
| Prompt caching | assumed on (SDK-internal); unresolved — `cost-efficiency-loop.md:658` SPIKE-2 | **definitely off** — `cache_control` appears in no file under `src-tauri/src` (`cost-efficiency-loop.md:30`) |
| Billing | flat subscription | metered per token |
| PacketBench-owned usage ledger | ~~none — writes zero rows to `usage.jsonl`~~ **yes since 2026-08-16** — the sidecar `turn_summary` handler appends a row per turn delta (source `api-claude-oauth`) | **yes** — via the three `api_agent.rs` construction sites |

**Verdict:** migrating `api-claude-oauth` → `api-claude` is a real capability
downgrade (no edit tool, no structured plan, weaker plan mode, no Claude Code
settings sourcing) *plus* a move from flat to metered billing *plus* a move from
a probably-cached path to a definitely-uncached one. Users will notice all three
at once, and will attribute the cost spike to the wrong cause unless CE5/CE6 have
landed. This is the strongest argument for the staging in §4.

The one thing that gets *better*: cost observability. The in-process path is the
only one that writes `usage.jsonl`.

### 2.2 `api-openai-codex` → `api-openai-agents` is a much closer replacement

`api-openai-agents` runs in the same sidecar, uses the OpenAI Agents SDK with a
real tool loop, and — unlike Codex `exec` — **can** honour a per-tool approval
round-trip (`api-models.ts:72-77` marks only `api-openai-codex` as
`supportsApprovals: false`). Losses:

- The Codex sandbox as a safety boundary (Codex maps every permission mode to
  sandbox + `-a never`).
- `gpt-5-codex`-class Codex-harness behaviour driven by ChatGPT-plan credentials.
- Cost: ChatGPT Plus/Pro flat → metered OpenAI API.
- The codex-specific cumulative-token accounting (`handler.rs:571`) has no
  equivalent need — openai-agents already reports per-turn deltas.

Net: acceptable. The bigger cost of removing this row is the three hardcoded
consumers in §1.5, not the row itself.

### 2.3 Features that lose their implementation, not just their provider

- **"Hand off to Codex"** (`PlanPanel.tsx:207,226-244`) — a Claude conversation
  hands an approved plan to a Codex executor. Needs repointing to
  `api-openai-agents` or removing. Repointing is a one-line change plus the
  auth-probe key at `:189`.
- **Flight reviewer default** (`LaunchAsyncFlightModal.tsx:131-137`) and
  **cooperative role assignment** (`CooperativeFlightCard.tsx:57-58`) — repoint.
- **The four auxiliary `claude-oauth` consumers** (§1.4) — need a real decision,
  not a repoint. Options: (a) route to `api-claude` (metered — makes "explain
  this lint failure" cost money); (b) route to the cheapest available configured
  provider; (c) gate the feature behind "an API key is configured". This is
  exactly the seam `local-model-routing.md` LM3 proposes (`core/aux_llm.rs`), and
  the two plans should be merged rather than solved twice.

---

## 3. Migration for existing data

### 3.1 What the codebase does today with an unknown provider id

Verified end-to-end. **Nothing crashes, nothing vanishes.**

1. `AgentCli` is an open union — `agentTaskStore.ts:158` ends `| (string & {})`.
2. Conversations persist as one opaque JSON file per conversation under
   `~/.packetbench/conversations/<id>.json`. **Rust never parses them**
   (`src-tauri/src/commands/conversations.rs:1-6`, `:77-84`); unreadable files
   are warn-and-skipped.
3. Hydration (`src/stores/agentConversationPersistence.ts:123-176`) wraps each
   record in `try/catch` (`:171`) and applies
   `conv.agent = canonicalizeAgentCli(conv.agent)` at `:164`.
   `canonicalizeAgentCli` (`agentTaskStore.ts:172-174`) is an explicit
   pass-through for unknown ids.
4. UI lookups are `.find(...)` + `??` fallbacks:
   `ProviderPicker.tsx:82-93` **already filters out any agent with no
   `API_PROVIDERS` entry** ("skip agents that don't exist in API_PROVIDERS"),
   `api-models.ts:186-188` defaults `supportsApprovals` to `true`,
   `agentColors.ts:58` returns `"neutral"`.

**The sharp edge** is `apiAgentProvider` (`agentTaskStore.ts:192-201`): an
unmapped `api-*` id logs a swallowed error and **silently returns `"anthropic"`**.
Its own comment says *"Silently defaulting to Anthropic mis-bills against the
wrong credentials."* If we delete the map entries at `:184,186`, every legacy
OAuth conversation would, on its next send, quietly bill the user's Anthropic API
key. That is unacceptable.

A second field is easy to miss: `AgentConversation.provider`
(`src/types/agent-conversation.ts:116-117`) is stamped once at creation from
`apiAgentProvider` (`agentTaskStore.ts:549`, written at `:636`) and is **never
canonicalized on load**. Both `agent` and `provider` need handling.

### 3.2 Established patterns available

| Pattern | Reference | Fit here |
| --- | --- | --- |
| **Silent alias to a canonical id** | `LEGACY_AGENT_ALIASES` (`agentTaskStore.ts:159-174`), used for `api-minimax-api` → `api-minimax` | **WRONG fit.** That was a pure identity duplicate — same Rust provider, different keyring slot. Aliasing `api-claude-oauth` → `api-claude` would silently move a subscription-funded conversation onto a metered API key. Do not do this. |
| **Degrade to an inert carrier** | gemini → terminal (`workspaceStore.ts:282-285`, `:311-315`; Rust catch-all `api/mod.rs:1175-1187`) | Good spirit, no inert carrier exists for a chat provider. |
| **Drop from the store on hydrate** | `RETIRED_AGENT_IDS` (`agentStore.ts:14-20`, `:193-200`) | **WRONG fit** — would make conversations vanish. |
| **Read-side alias + eager one-shot migration + documented removal criteria** | mission→flight: `#[serde(alias = "missionId")]` (`core/flight.rs:820`, `api/mod.rs:251`), TS `??`-chain (`issueStore.ts:167-180`), eager pass (`core/migration.rs:66-92`, `lib/storage-migration.ts:47-92`), policy at `backlog.md:229-259` | **Best structural fit** for the *field-level* compatibility, and the removal-criteria policy ("keep the shim until at least one release has shipped with the migration") should be adopted verbatim. |

### 3.3 Proposed behaviour: retired-but-readable, with an explicit user-driven switch

Do **not** silently remap. Do **not** hide. Do this:

1. **Introduce `RETIRED_API_AGENTS`** in `agentTaskStore.ts` alongside
   `LEGACY_AGENT_ALIASES`:

   ```ts
   /** API provider ids withdrawn from the picker. Persisted conversations
    * still load and remain fully readable; they cannot start a new turn.
    * Unlike LEGACY_AGENT_ALIASES these are NOT remapped — silently moving a
    * subscription-funded conversation onto a metered key would mis-bill. */
   export const RETIRED_API_AGENTS: ReadonlySet<string> =
     new Set(["api-claude-oauth", "api-openai-codex"]);
   ```

2. **Keep the `apiAgentProvider` entries** (`:184,186`) so the id still resolves
   to `claude-oauth` / `openai-codex` for labelling, cost bucketing, and the auth
   badge. Only the *routing* is withdrawn.

3. **Conversation renders read-only.** The transcript, diffs, plan, and cost
   panel all render exactly as today. The composer is disabled with a single
   honest banner:

   > *This conversation used the Anthropic subscription provider, which
   > PacketBench no longer offers. The transcript is preserved. To continue,
   > switch it to Claude (API) — new turns will be billed to your Anthropic API
   > key.*  **[ Switch provider ]  [ Learn why ]**

4. **"Switch provider" is an explicit, logged, user-initiated rewrite** that sets
   both `agent` and `provider`, appends a system message recording the switch
   and its date, and calls `scheduleSave`. It must never happen automatically.

5. **Block the send path**, not just the UI. Add a `RETIRED_API_AGENTS` guard in
   `createApiConversation` / `resumeApiConversation` / `sendMessage` so a stale
   pane, a queued message, a flight relaunch, or the Monitor projection cannot
   route around the disabled composer. Without this guard the send would reach
   `core/llm_provider.rs:35-46` and fail with
   `Err("Unknown provider: claude-oauth")` — a confusing runtime error instead of
   a clear product statement.

### 3.4 Other persisted fields needing read-compatibility

| Field | Where | Handling |
| --- | --- | --- |
| `AgentConversation.agent` | `types/agent-conversation.ts:101-104` | as §3.3 |
| `AgentConversation.provider` | `types/agent-conversation.ts:116-117` | preserve; do not rewrite except on explicit switch |
| `Flight.attempts[].provider` | `commands/flight_cost.rs:139` | preserve; read-only historical attempts |
| task `agentConfigId` | `commands/flight_cost.rs:156` (strip site) | preserve; `LaunchAsyncFlightModal` must not offer a retired target |
| `reviewerAgentConfigId` | persisted reviewer-gate / autonomy policy (`tauriPersistence.test.ts:115,122`, `boundedAutonomyRuntime.test.ts:95`) | **needs a default fallback** — a persisted policy pinned to `api-openai-codex` must resolve to `api-openai-agents` or fail loudly at gate time, never silently skip the review |
| guardrail budget keys | `costGuardrails.ts:330-335` map `api-*` → `claude-oauth` / `openai-codex` | **keep both directions** so existing per-provider budgets keep applying to historical spend |
| analytics `source` rows | `CostDashboardView.tsx:31,33,46,49` `SOURCE_LABELS` / `SOURCE_PILL_CLASSES` | **keep** — historical rows must keep their human label, not render as a raw id |
| `planner_provider: "claude-oauth"` | `core/contract_tests.rs:386,420`; retired-planner fields preserved per `core/storage.rs:524-545` | leave as-is |

### 3.5 Test precedent to follow

Follow the `api-minimax-api` precedent, **not** gemini's. The minimax retirement
has real regression coverage —
`src/stores/__tests__/persistenceMigration.test.ts:369-400` (hydrates a legacy
file, strips mirror keys, canonicalizes the id),
`:577-583` (`canonicalizeAgentCli("some-future-provider")` passes through), and
`sessionContract.test.ts:282-305`. The gemini alias has **no dedicated
regression test at all** (only hit for "gemini" in tests is
`cliAccountEnv.test.ts:53`, unrelated).

---

## 4. Staging: remove outright, or gate? — **SUPERSEDED**

> **This whole section is obsolete.** It answers "how do we withdraw the Agent
> SDK row safely?", and the answer turned out to be "we don't withdraw it — we
> re-credential it." No build-time flag was introduced, `SIDECAR_PROVIDERS`
> still contains `claude-oauth`, and §4.2's Stages A/B/C do not describe what
> shipped. §4.1's observation that compliance scales with distribution is still
> true, but it is no longer load-bearing: an API-key build is compliant at any
> distribution scale, which is strictly better than a flag. Retained for the
> record of what was considered and why it was not chosen.


### 4.1 The decisive observation

**The compliance concern in §0 scales with DISTRIBUTION, not with personal use.**
The quoted prohibition is on third-party developers *offering* Claude.ai login
and *routing requests on behalf of their users*. A developer running their own
subscription through their own local build is not offering anything to anyone.

Deletion and compliance are therefore not the same axis. What actually needs to
be true of a distributed build is: **it must not ship the affordance.** What
needs to be true of the owner's local build is: nothing.

### 4.2 Recommendation

**Gate, do not delete — in three stages, and fix the auxiliary callers first.**

**Stage A — Remove the distribution surface (the compliance fix).**
Introduce one build-time flag, default **off**, that controls three things
together:

- whether the two rows appear in `API_PROVIDERS` / `PROVIDER_GROUPS` /
  `AUTO_PICK_ORDER`;
- whether `claude-oauth` / `openai-codex` are members of `SIDECAR_PROVIDERS`
  (`agent_sidecar/mod.rs:30`);
- whether the four auxiliary features (§1.4) may target `claude-oauth`.

A distributed installer built with the flag off contains the sidecar providers as
inert code but exposes no path to them. The owner's local build sets the flag on
and nothing changes for them. Ship this stage as its own release with a
CHANGELOG entry.

Mechanism: there is no existing feature-flag infrastructure — `src/lib/env.ts`
has only `isDev`/`isProd`, and `src-tauri/Cargo.toml` has no `[features]`
section. So this introduces one: a `VITE_PACKETBENCH_ALLOW_SUBSCRIPTION_OAUTH`
build var read once in `src/lib/env.ts`, mirrored by a Cargo feature (compile-time,
not an env var — an env var would let a distributed binary be re-enabled at
runtime by an end user, which re-creates the exposure).

**Stage B — Deprecate in the UI.**
With the flag on (owner's build), mark both rows "Deprecated — subscription
OAuth" in the picker and stop auto-picking them (`AUTO_PICK_ORDER`). Ship the
§3.3 read-only migration behaviour so it is exercised *before* anything is
deleted. Repoint the `api-openai-codex` consumers (§1.5).

**Stage C — Delete, later, on evidence.**
Once CE5 has produced at least one real usage period of PacketBench-owned ledger
data on the surviving rows (§5, WI-0), and the owner confirms they no longer use
the gated path, delete `anthropic.ts`, `openai-codex.ts`, `codex-mcp.ts`,
`mcp-trust-proxy.ts`, the two dependencies, and the flag. Keep the §3.3
read-compat shim per the `backlog.md:229-259` policy — one full release cycle
after the eager migration ships.

### 4.3 Why not delete outright

1. **Deleting the picker rows does not achieve the compliance goal.** The three
   Rust auxiliary features (§1.4) call `forward_start("claude-oauth")` directly,
   bypassing `is_sidecar_provider`. A "removal" that leaves them in place removes
   the user-visible feature while keeping 100% of the exposure — strictly the
   worst outcome.
2. **The replacement is genuinely weaker** (§2.1). Deleting before CE14 (edit
   tool) and CE6 (caching) hands the owner a slower, dumber, more expensive
   agent overnight.
3. **CE5 has not landed** (§5). Deleting first creates a measurement blind window
   across exactly the transition being measured.
4. **A gate is cheap and reversible; a deletion of 2,600+ lines of sidecar
   provider code is not.** If Anthropic's policy or PacketBench's distribution
   model changes, Stage A is a one-line default flip.

### 4.4 Why not just do nothing and keep it gated forever

Because a permanently-on-in-dev flag rots. Stage C exists so the decision has a
forcing function; without it the sidecar keeps two unmaintained providers, four
dead smoke gates, and a 20 MB dependency nobody exercises.

---

## 5. Work items

Effort scale: **S** ≈ half a day, **M** ≈ 1–2 days, **L** ≈ 3+ days.

### Prerequisite

**WI-0 — ~~CE5 (self-owned usage ledger) ships and runs for one real usage
period~~ — DROPPED 2026-07-31.** CE5 is cut and the dashboard it protected is
deleted (`cost-efficiency-loop.md` §0), so this is **no longer a blocker for
anything**. The paragraph below is retained as the record of what the concern
was; read "dashboard" as "guardrail inputs". ~~Today `api-claude-oauth`, `api-openai-codex`,
and `api-openai-agents` write **zero** rows to `~/.packetbench/usage.jsonl`
(`append_usage_entry` is called only from `api_agent.rs:1649,1944,2528`); their
spend is reconstructed by scraping `~/.claude/cost-tally.json` and
`~/.codex/sessions/*.jsonl`, files the **vendor CLIs** write.~~ **No longer
true since 2026-08-16:** the sidecar `turn_summary` handler now appends
`usage.jsonl` rows for the surviving sidecar providers (see
`cost-efficiency-loop.md` §1 item 5), so metered sidecar spend feeds the
guardrails directly. Removing the rows
before CE5 lands freezes roughly half the dashboard's history with no PacketBench
replacement, precisely across the transition being measured
(`cost-efficiency-loop.md:728-731`).

Nuance worth recording: because the PTY CLI agents keep writing those same vendor
files, the `claude-cli` / `codex` analytics sources (`analytics.rs:93,198`) do
**not** go to zero after the removal. What is lost is the ability to separate
API-agent spend from PTY spend in that data at all — the two were always
conflated there. CE5 is what makes the post-removal number attributable.

### Stage A — compliance fix (ship first)

**WI-1 — Repoint or gate the four auxiliary `claude-oauth` consumers.**
**DONE 2026-07-31.** Resolved as option (b) from §2.3 — route to the cheapest
configured provider — built on the LM3 seam rather than solved twice.

New: `src-tauri/src/core/aux_llm.rs` (`AuxTaskClass`, `resolve_aux_route`,
`run_aux_oneshot`, `spawn_aux_stream`, `AuxRoutingState`),
`src-tauri/src/commands/aux_routing.rs` (three commands),
`src/lib/attemptRouting.ts`, plus an aux slice on `src/stores/routingStore.ts`
and an "Auxiliary AI tasks" section in
`src/components/views/tools/ProviderRoutingCard.tsx`.

Repointed: `commands/issues.rs` (`issues_extract_from_spec`),
`commands/code_quality.rs` (`code_quality_ai_explain`,
`code_quality_ai_summarize`), `commands/github.rs`
(`github_ai_pr_description`, `github_ai_pr_review`),
`src/components/views/github/InvestigationPanel.tsx` (Draft patch).
Deleted: the bare `SidecarManager::forward_start`
(`commands/agent_sidecar/protocol.rs`), `spawn_oneshot_cleanup`,
`spawn_quality_ai_cleanup`, and the `AI_*_PROVIDER` / `AI_*_MODEL` constants.

Notes for later items:
* The streaming features keep the `api-agent:chunk|done|error:<sid>` contract,
  so their frontend listeners were untouched.
* Auxiliary turns now write `~/.packetbench/usage.jsonl` rows with
  `source: "aux"` and `agent_id: <task class>`. The OAuth sidecar wrote none,
  so this is coverage gained, relevant to the WI-0 discussion above.
* Ollama is deliberately excluded from *automatic* selection (no credential to
  prove the user configured it, and a stopped daemon would win every ranking at
  $0); it stays explicitly selectable.
* Draft patch's provider id comes from `apiAgentProvider`, not the naive
  `replace(/^api-/, "")` that `LaunchAsyncFlightModal.pickedToSpec` uses —
  the latter yields `"claude"` for `api-claude`, which is not a `get_provider`
  id. That looks like a live defect in the manual launch path; it is out of
  WI-1's scope but worth a backlog entry.

**WI-2 — Introduce the build-time gate. — CUT.** Superseded by
re-authentication; there is nothing left to gate. Original text:

Files: `src/lib/env.ts` (new flag), `src/lib/api-models.ts:43-54,68-87`,
`src/components/agents/composer/utils.ts:59,63`,
`src/components/views/AgentsView.tsx:21-30`,
`src-tauri/Cargo.toml` (new `[features]` section),
`src-tauri/src/commands/agent_sidecar/mod.rs:30`.
Effort **M**. Depends on: WI-1 (otherwise the gate is cosmetic).
Compile-time on the Rust side, not an env var — see §4.2.

**WI-3 — Release Stage A. — FOLDED into the single re-auth release.**
Original text:
 CHANGELOG entry stating plainly that PacketBench no
longer offers Claude.ai / ChatGPT subscription login for API agents and why.
Effort **S**. Depends on: WI-1, WI-2.

### Stage B — deprecation UX + data migration

**WI-4 — `RETIRED_API_AGENTS` + read-only conversation behaviour. — DONE
2026-07-31**, scoped to `api-openai-codex` only (`api-claude-oauth` survives, so
it is deliberately NOT in the set — that would be an alias-shaped mis-billing,
exactly what §3.2 warns about). Implemented in `agentTaskStore.ts` as
`RETIRED_API_AGENTS`, `RETIRED_API_AGENT_REPLACEMENTS`, `isRetiredApiAgent`,
`resolveRetiredApiAgent`, `retiredApiAgentNotice`, and
`appendRetiredAgentNotice`, with guards on `createApiConversation` (throws),
`sendMessage`, and `resumeApiConversation` (both append a persisted `system`
message). The `apiAgentProvider` map entry is KEPT per §3.3 item 2. Regression
coverage in `persistenceMigration.test.ts`. Original text:

Files: `src/stores/agentTaskStore.ts:159-205` (new set; **keep** the
`apiAgentProvider` entries), `src/stores/agentConversationPersistence.ts:164`,
`src/components/agents/composer/Composer.tsx`, `AgentChatPane.tsx`,
`src/components/agents/AgentHeaderBadges.tsx`.
Effort **M**. Depends on: WI-2. Includes the send-path guard (§3.3 item 5) in
`createApiConversation` / `resumeApiConversation` / `sendMessage`.

**WI-5 — "Switch provider" action. — NOT DONE. Open, P2.** The
graceful-degradation half (WI-4) shipped and was accepted as the shipped
minimum: a conversation on `api-openai-codex` loads intact and read-only, the
transcript says what to use instead, `RETIRED_AGENT_REPLACEMENT` substitutes at
runtime so a pinned Reviewer Gate never silently no-ops, and the identity entry
stays in `apiAgentProvider` so historical spend is not mis-billed. What does
**not** exist is the action that moves such a conversation onto
`api-openai-agents` — a user who wants to continue one starts a new
conversation and loses the thread. Tracked as **F-2.3-16** in
[`docs/reports/state-of-the-ade-2026-07-30.md`](https://docs.ianlan.dev/reports/state-of-the-ade-2026-07-30.md).
Still worth doing. Original text:

Files: `src/stores/agentTaskStore.ts` (new action rewriting `agent` + `provider`,
appending a system message, calling `scheduleSave`),
`src/components/agents/` banner UI.
Effort **S**. Depends on: WI-4. Must be explicit and logged; never automatic.

**WI-6 — Repoint the `api-openai-codex` consumers. — DONE 2026-07-31.**
`PlanPanel.tsx` ("Hand off to Codex" → "Hand off to OpenAI",
`HANDOFF_EXECUTOR_AGENT = "api-openai-agents"`, auth gate via
`authProbeProvider`), `CooperativeFlightCard.tsx` (reviewer/scout →
`api-openai-agents`), and the `reviewerAgentConfigId` fallback
(`reviewerGateRuntime.ts`, which also re-derives the model so a Codex-pinned
`gpt-5.5` cannot leak). **`LaunchAsyncFlightModal.tsx` closed later in the same
commit** — verified 2026-07-31: both `reviewerAgent` and `reviewerModel`
default to `api-openai-agents`. **WI-6 is DONE.** Original text:

Files: `src/components/agents/PlanPanel.tsx:189,207,226-244`;
`src/components/flights/LaunchAsyncFlightModal.tsx:131-137`;
`src/components/flights/CooperativeFlightCard.tsx:57-58`; plus the
`reviewerAgentConfigId` fallback (§3.4).
Effort **M**. Depends on: WI-0 (so the cost delta of moving reviewers to a
metered provider is measurable), WI-4.

**WI-7 — Cost/guardrail read-compat + regression tests. — DONE 2026-07-31.**
Both `costGuardrails.ts` directions kept (with a comment saying why);
`CostDashboardView.tsx` no longer exists. Tests added to
`persistenceMigration.test.ts`, `attemptRouting.test.ts`,
`agentCatalog.test.ts`, `AgentModeChip.test.tsx`, plus a new offline sidecar
gate `agent-sidecar/test/anthropic-apikey-smoke.mjs` and a retired-provider case
in `registry-smoke.mjs`. Original text:

Files: `src/lib/costGuardrails.ts:327-353` (keep both directions),
`src/components/views/CostDashboardView.tsx:31,33,46,49` (keep labels),
`src/stores/__tests__/persistenceMigration.test.ts` (new cases following the
`api-minimax-api` precedent at `:369-400`, `:577-583`),
`src/stores/__tests__/sessionContract.test.ts`.
Effort **M**. Depends on: WI-4, WI-5.
Note another agent is concurrently editing `pricing.rs` / `conversationCost.ts` —
rebase on that work before starting.

**WI-8 — Docs. — DONE 2026-07-31.** `README.md` provider table + sidecar
sections, `CLAUDE.md` provider table (and the stale `PROTOCOL_VERSION` 10 → 11),
`agent-sidecar/README.md` (also 9 → 11), this file, `CHANGELOG.md`
`[Unreleased]`. Original text:

Files: `README.md:64,66,133,341,365-366,379`; `CLAUDE.md` provider table (**and
fix the stale `PROTOCOL_VERSION` 10 → 11**);
`dev/sidecar-over-ssh-verification.md` (rescope to `openai-agents`);
`dev/cost-efficiency-loop.md` SPIKE-2 (retarget or mark unresolvable);
`dev/local-model-routing.md` + `backlog.md:549-556` (§7.4);
`dev/README.md` index row for this doc.
Effort **S**. Depends on: WI-6.

**WI-9 — Release Stage B.** Effort **S**. Depends on: WI-4…WI-8.

### Stage C — deletion (later, on evidence)

**WI-10 — Delete the sidecar OAuth providers. — PARTIALLY DONE, PARTIALLY
CANCELLED (2026-07-31).** `openai-codex.ts`, `codex-mcp.ts`,
`mcp-trust-proxy.ts` and the three codex smoke gates are deleted;
`registry-smoke.mjs` now asserts the id is rejected. **`anthropic.ts` and
`@anthropic-ai/claude-agent-sdk` are NOT deleted and must not be** — they are
the re-authenticated Agent SDK path. `@modelcontextprotocol/sdk` is now
unimported but still declared (§-1.3). Original text:

Files: delete `agent-sidecar/src/providers/anthropic.ts`,
`agent-sidecar/src/providers/openai-codex.ts`, `agent-sidecar/src/codex-mcp.ts`,
`agent-sidecar/src/mcp-trust-proxy.ts`; edit
`agent-sidecar/src/session-registry.ts:18-19,31-32`; prune
`agent-sidecar/src/mcp-trust.ts` (`parseAnthropicMcpToolName` `:138`,
`allowedMcpToolNames` `:150`); drop `@anthropic-ai/claude-agent-sdk` and
`@modelcontextprotocol/sdk` from `agent-sidecar/package.json`; delete the four
dead smoke gates and update `registry-smoke.mjs`.
Effort **M**. Depends on: WI-9 + one full release cycle + owner confirmation.
**Verify the installer still builds** — `scripts/prune-sidecar.js` and the
`externalBin`/`resources` wiring in `src-tauri/tauri.conf.json` are affected by
the dependency change.

**WI-11 — Delete the Rust OAuth routing. — PARTIALLY DONE (2026-07-31).**
`SIDECAR_PROVIDERS` dropped `openai-codex` and **kept `claude-oauth`**;
`remote_auth_preflight` collapsed to `""` for every provider (sidecar providers
now carry their key over the wire from the LOCAL keyring, so there is nothing
for the remote host to be signed in to) with `remote_sidecar_preflight_script`
intact; `handler.rs`'s codex cumulative branch retained for historical data.
`provider_auth.rs` and `auth_watcher.rs` untouched, per §1.3. Original text:

Files: `src-tauri/src/commands/agent_sidecar/mod.rs:30,126-127`;
`supervisor.rs:1475-1485,1761-1772` (`remote_auth_preflight` collapses; **keep**
`remote_sidecar_preflight_script`); `handler.rs:531-533,570-620` (codex
cumulative-token branch) and the now-dead `exec_token_snapshots` /
`exec_turn_seq` state at `supervisor.rs:133`.
Effort **M**. Depends on: WI-10.
**Do not touch `provider_auth.rs` or `auth_watcher.rs`** beyond comments — see
§1.3.

**WI-12 — Remove the gate. — CUT** (no gate was ever introduced). Original text:

Files: `src/lib/env.ts`, `src-tauri/Cargo.toml`, and the WI-2 call sites.
Effort **S**. Depends on: WI-11.

**WI-13 — Retire the `RETIRED_API_AGENTS` read-compat shim. — STILL PENDING**,
per the `backlog.md:229-259` policy, counting from the release that carries the
2026-07-31 change. Original text:

Per the `backlog.md:229-259` policy: only after at least one release has shipped
with the WI-4/WI-5 behaviour, so every machine has had a chance to run it.
Effort **S**. Depends on: WI-12 + one release cycle.

### Sequence

```
WI-0 (CE5, external) ─┐
WI-1 → WI-2 → WI-3    │  ← Stage A can ship BEFORE WI-0
                      ↓
        WI-4 → WI-5 → WI-6 → WI-7 → WI-8 → WI-9        ← Stage B needs WI-0
                                              ↓
                        WI-10 → WI-11 → WI-12 → WI-13   ← Stage C
```

Stage A is deliberately **not** gated on CE5. CE5 protects the *measurement* of
the migration; Stage A is a compliance action that changes only what a
distributed build offers, and delaying it to wait on a cost-instrumentation item
would be the wrong trade.

---

## 6. Risks

| Risk | Assessment / mitigation |
| --- | --- |
| **BIGGEST: the removal appears to be done while the compliance exposure remains.** Three Rust features call `forward_start("claude-oauth")` directly (`issues.rs:177`, `code_quality.rs:708,878`, `github.rs:1848,1972`), bypassing `is_sidecar_provider` (which only gates `api_agent.rs:889`). Pulling the picker rows removes the feature but not the credential routing — and it is *less* defensible than the picker row, because the user never chose it. | WI-1 ships **first**, ahead of the picker change. Acceptance test: after Stage A, no code path under `src-tauri/src` can reach `forward_start` with `"claude-oauth"`. Grep is sufficient (it is a `const` at three sites) — make it a CI check. |
| **Users mid-conversation on the removed providers.** A live conversation whose composer disappears mid-turn is data loss in the user's perception. | §3.3: read-only, fully rendered, explicit banner, explicit "Switch provider". The send-path guard is what makes this real — without it a queued message, a stale pane, a flight relaunch, or the Monitor projection routes around the disabled composer straight into `Err("Unknown provider: claude-oauth")` (`core/llm_provider.rs:45`). |
| **Silent mis-billing on hydrate.** Deleting the `apiAgentProvider` map entries (`agentTaskStore.ts:184,186`) makes every legacy OAuth conversation fall through to `return "anthropic"` (`:202`) — a swallowed log, then the user's metered Anthropic key. The function's own comment names this hazard. | Keep the map entries. Add `RETIRED_API_AGENTS` and block routing, not identity. Do **not** put these ids in `LEGACY_AGENT_ALIASES`. |
| **Cost-history continuity.** OAuth rows write zero `usage.jsonl` entries; their spend lives only in vendor-CLI files that conflate them with PTY usage. | WI-0 / CE5 is a hard prerequisite for Stage B. Keep `SOURCE_LABELS`, `SOURCE_PILL_CLASSES`, and `providerSourceForAgentProvider` entries so historical rows keep their labels and existing budgets keep applying. |
| **Cost regression is real and will be blamed on the wrong thing.** Users move from flat subscription to metered, on an uncached path (`cache_control` is absent from all of `src-tauri/src`), with no edit tool (so read-then-write stores two full file copies per edit). | Sequence CE6 (caching) and ideally CE14 (edit tool) around Stage B. Say so explicitly in the release note rather than letting users discover it. |
| **Breaking the multi-account CLI work.** `provider_auth.rs` and `auth_watcher.rs` look like OAuth files and are ~90% shared with the PTY feature; `probe_oauth_credentials` (`provider_auth.rs:229-278`) exists specifically so the ambient and per-account probes cannot drift. | §1.3 is the fence. Concretely: **do not** delete anything in `provider_auth.rs` except (optionally) the `:510-511` arms, and not even those — `get_provider_auth_status_for_dir` delegates to `get_provider_auth_status` on an empty `config_dir` (`:541-543`), so removing them breaks the ambient-account launch gate. `sign_out_provider` is wired to `SubscriptionsCard`, the PTY login surface. Regression gate: launch a PTY pane bound to a non-default `CliAccount` and confirm `useAccountLaunchGate` still resolves. |
| **The sidecar becomes partially unused and rots.** Only `openai-agents` + `echo` remain; four smoke gates die; nobody exercises the SSH remote-sidecar path against a real provider. | Keep `openai-agents-gating-smoke.mjs` and the `remote-*-smoke.mjs` gates in CI. Stage C's forcing function exists precisely so the sidecar does not carry two unmaintained providers indefinitely. Note `remote_auth_preflight` (`supervisor.rs:1475-1485`) becomes an empty function — the SSH preflight loses its only auth check, so an openai-agents-over-SSH failure will surface later and less clearly. Consider adding an API-key preflight in its place. |
| **Flight reviewer / cooperative-role silent degradation.** Persisted `reviewerAgentConfigId: "api-openai-codex"` policies exist in shipped data (`tauriPersistence.test.ts:115,122`, `boundedAutonomyRuntime.test.ts:95`). A reviewer gate that silently no-ops is worse than one that fails. | §3.4: resolve to `api-openai-agents` or **fail the gate loudly**. Never skip the review. |
| **`getDefaultModel` returns `""`.** `LaunchAsyncFlightModal.tsx:136` calls `getDefaultModel("api-openai-codex")`, which returns `""` (`api-models.ts:175-178`) once the row is gone — a launch with an empty model string. | WI-6. Add a test asserting no launch path can produce an empty model. |
| **`AUTO_PICK_ORDER` has no test coverage.** `AgentsView.tsx:21-30` ranks the OAuth providers 1st and 3rd; `AgentsView.test.tsx` asserts nothing about it. | Add coverage in WI-7 before changing it. |
| **`CLAUDE.md` is stale and gitignored.** It documents `PROTOCOL_VERSION` 10; the code says 11 (`agent_sidecar/mod.rs:81`, `README.md:133`). Anyone using it as the map for this change will mis-scope. | WI-8 fixes it. Treat `README.md` and source as the trust anchors. |
| **`mcp-config.ts:44-45` hardcodes `~/.claude/settings.json`** as the global MCP source for **all** sidecar sessions, including `openai-agents`. After OAuth removal this reads a Claude Code config directory for a provider that has nothing to do with Claude. | Not a compliance issue (it reads MCP server config, not credentials), but it is confusing and should be noted in `backlog.md`. Out of scope here. |
| **Merge conflict with in-flight work.** Another agent is concurrently editing `src-tauri/src/commands/pricing.rs` and `src/lib/conversationCost.ts`. | WI-7 touches adjacent cost code. Rebase before starting; neither file needs OAuth-specific changes (`pricing.rs` contains zero provider ids). |

---

## 7. Open questions for the owner

1. **Auxiliary features (§1.4, WI-1).** Spec import, Code Quality AI, GitHub PR
   description/review, and Draft patch currently run free on the Claude
   subscription. Move them to the metered API key, gate them behind
   "an API key is configured", or fold them into `local-model-routing.md` LM3?
   This is a product-cost decision, not a technical one.
2. **Gate default in the owner's own build.** Stage A ships the flag off by
   default. Confirm the owner wants a local build with it on, or whether Stage A
   should simply be the end state and Stage C follows immediately.
3. **`api-openai-codex` symmetry.** OpenAI publishes no equivalent prohibition.
   Removing it is preference, not compliance. Confirm it should follow the same
   schedule rather than being kept a release longer (it is the reviewer default
   in three places).
4. **`local-model-routing.md` conflict.** `backlog.md:549-556` (LM4/LM5)
   currently says to migrate auxiliary sidecar sites *"keeping `claude-oauth`
   selectable so subscription-funded operation stays the default."* That is the
   opposite of this decision. One of the two documents must be amended;
   WI-8 assumes this one wins.
5. **SPIKE-2 in `cost-efficiency-loop.md:685-694`** is specified as
   "instrument one real `api-claude-oauth` session" to learn whether the Agent
   SDK caches well. If the row is gated off in the distributed build, the spike
   is still runnable in the owner's local build — but its answer stops mattering
   for product decisions. Retarget or close it.
