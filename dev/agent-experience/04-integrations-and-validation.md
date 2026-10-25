# Responsiveness, usage and supported integration design

> October 24 verification: these are still target experiments/evidence packets,
> not delivered integrations. The current process responds at rest; N1 navigation
> diagnosis remains open. Read [current status](../current-status.md) and
> [the audit](../documentation-audit-2026-10-24.md). Desktop/runtime completion
> and acceptance now precede Remote Agents; optional integration experiments
> remain outside [the desktop completion gate](./08-desktop-completion-before-remote-agents.md).

Proposed design, October 19, 2026; primary docs retrieved October 20 UTC.
Read the [package entry point](./README.md) and
[full review](../agent-harness-and-experience-review-2026-10-19.md).
No source code, provider accounts, running apps or credentials are changed here.
Composer research is excluded. I0–I3 below are bounded future work packets;
implementation status belongs only in [backlog.md](../../backlog.md).

## I0 — Diagnose native responsiveness before a readiness claim

### Known evidence and limits

The prior installed Windows capture rendered Flight Deck. The automated Agents
click timed out; the next capture showed Not Responding and process checks
agreed. No prompt was submitted. App versus native/accessibility cause remains
unisolated. An old PID/window ID is evidence, not a target for a new session.

Inspect source for navigation, store hydration, native invoke and event behavior
without assigning a cause from timing alone. Initial seams:

- `src/components/views/AgentsView.tsx` and `src/App.tsx`: routing/mount/probes.
- `src/stores/agentTaskStore.ts`: hydration/projection and subscriptions.
- `src/lib/storageMirror.ts` and `src/lib/storage-boot.ts`: persistence ordering.
- `src-tauri/src/commands/state.rs`: persisted-state read boundaries.
- `src-tauri/src/lib.rs`, `init_tracing` and `dirs_log_dir`: existing logging.

Logs can contain private paths/transcripts. Keep evidence local under the
ignored acceptance directory, redact exported summaries and never log tokens.
Do not globally enable request-body logging to diagnose a navigation issue.

### Experiment, one variable at a time

1. Inventory the actual installed binary/source hash, WebView version, OS/display
   scale, active sessions and fixture profile. Preserve user state; use an
   isolated app-data/WebView profile through existing acceptance seams where
   possible. Do not replace the user's profile or silently kill sessions.
2. Try ordinary navigation without an accessibility snapshot, then comparable
   automation on a fresh fixture. Keep a bounded record of start/end/outcome.
   A helper timeout is an unknown action outcome: re-observe before retry.
3. Distinguish process liveness, native-message responsiveness, WebView event-loop
   responsiveness and successful route render. None alone proves the others.
   In a debug fixture, add bounded spans for route start/render, hydration/invoke
   start/end and async task completion. Do not poll/render-flood the installed app.
4. If the stall repeats, obtain a local stack trace or safe diagnostic snapshot
   using available supported tooling. Treat memory dumps as sensitive, never
   upload them by default. Compare with a no-automation reproduction before
   blaming UIA or React. Keep the first failed evidence alongside later fixes.
5. Make only a cause-supported fix. Add the regression at the responsible
   layer and prove the same reproduction no longer stalls. A longer timeout,
   forced remount or process restart alone is not a causal fix.

Future native control must use the available computer-use skill, target one
fresh returned app window, and release/reset immediately after each short
burst (aim for 15–30 seconds of activity). Never hold control during builds,
research or test waits. Respect user interruption. Do not automate Codex itself,
terminal windows, authentication or security/privacy UI. Keep research comparisons
to public docs and user observations when those surfaces are unavailable.

### Outputs, acceptance and ownership

Owner: native-diagnostics/integration agent; coordinator leases any source edit
in a shared file. Deliver `reproduction.md`, redacted timing JSON and exact source/
binary identity under the ignored acceptance root, plus the linked root-cause
explanation or an explicit not-reproduced/unknown result. Repeat cold launch,
navigation out/back and conversation selection with fixture histories. Preserve
saved state and prove the main window still accepts ordinary input afterward.
Do not restart a newly stalled user process solely to make a screenshot green.

Dependencies: no feature implementation. Rollback removes temporary fixture
instrumentation or reverts the diagnosed source fix, not user data. Open N1 is
a native-readiness restriction; independent source work may continue.

## I1 — Usage observations with provenance

### Current source boundary

`src-tauri/src/commands/usage.rs::UsageEntry` stores raw provider token/cache/USD
rows. `core/llm_types.rs` completion does not supply account quota windows.
The sidecar protocol's rate_limited/retryAfterSeconds signal is currently logged
by `commands/agent_sidecar/handler.rs`, not an account allowance model.
`commands/statusline/codex.rs` parses PTY primary/secondary used_percent and
`src/components/session/CodexStatusBar.tsx` exposes a narrower hover display.
Missing percentages currently default to zero. Preserve that distinction.

### Proposed contract

Add a backend-normalized DTO exported through the shared schema; the runtime
owns source collection, and the GUI only renders the projection:

```ts
type UsageObservationV1 = {
  schemaVersion: 1;
  providerId: string;
  credentialProfileRef: string; // opaque local reference, never a token/email
  executionHostRef?: string;
  scope: "account" | "workspace" | "run" | "session" | "unknown";
  source: "provider_api" | "cli_status" | "application_meter";
  observedAt: string;
  staleAfter?: string;
  confidence: "reported" | "estimated" | "unknown";
  window?: {
    authority: "provider" | "application_policy";
    durationSeconds?: number;
    resetsAt?: string;
  };
  usedPercent?: number;
  retryNotBefore?: string;
};
```

Use optional fields, never zero defaults for absent signals. The run's token/
cost record and `BudgetDisclosure` remain separate structures linked by identity.
Do not squeeze remaining dollars into a percentage or create an allowance from
catalog prices. A rate-limit retry delay belongs in retryNotBefore, not resetsAt.

Source adapters validate numeric range, identity and timestamps. If they cannot
identify the credential/account unambiguously, display source+unknown scope
without cross-account aggregation and use scope unknown rather than guess.
Keep observations ephemeral unless the user needs historical
display; durable raw usage remains in the existing ledger. Background collection
must be bounded, cached and disabled for sources without a supported interface.
Do not scrape auth files or call an undocumented billing endpoint to fill a bar.

### Product behavior

Composer/run details show actual model, host, billing class and cap strength.
Expand usage to see observed time, stale state and available windows. If only
tokens are known, show tokens and “Allowance unavailable”; if pricing is unknown,
show “Price unavailable” rather than zero/free. Preserve explicit true local/free
classification only when the source supports it. Keep provider window and local
daily/monthly cap visibly separate. A child route is attributed independently.

On rate limits, keep the draft and run context; show provider-returned retry
information when available and stop automated retry at the configured boundary.
No automatic billing/provider fallback. Use existing guardrails/Settings, not a
new cost dashboard. Coordinate attention actions with `AgentAttentionTarget`.

### Tests, files and rollout

Future files: `core/usage_observation.rs` (new), relevant statusline/provider
adapters, `src/types/usage-observation.ts` or generated export, a small shared
usage disclosure component and existing status bars. Coordinator owns
`src/lib/tauri.ts`, schema exports and command registration. Runtime owner keeps
raw ledger fields intact. GUI owns display application after behavioral schema.

Acceptance cases: missing/zero/100/out-of-range readings; stale data; two accounts
on one host and one account across two hosts; provider quota versus local cap;
rate delay without reset; unpriced positive tokens; parent and child providers;
old persisted DTOs. Unit-test normalization and identity filtering, DOM-test
labels/actions, then native-confirm the actual reported source. No paid request
is needed for hermetic tests. Live quotas stay unverified when unavailable.
Roll out additively; a disabled disclosure must not disable raw accounting or
infer more allowance. No historical usage rewrite is needed.

## I2 — Official ChatGPT-plan transport feasibility

This is a later bounded experiment, not an instruction to restore the retired
`api-openai-codex` row or activate a provider. It is independent of Composer.
Refresh official documentation when this packet is assigned: preview behavior
and eligibility may change. Keep the existing API-key and PTY routes intact.

### Source-grounded constraints

- The documented OSS/local route separates identity from plan-use permission,
  registers a user-authorized client and binds a stable host identity. Paid or
  remotely hosted deployments follow a different eligibility path.
  [Overview](https://developers.openai.com/siwc/token-sharing-open-source)
- Registration uses a loopback listener, fresh state/nonce/PKCE, the issued
  client registration and validated identity/scopes. Do not treat an identity
  token alone as inference permission.
  [Registration](https://developers.openai.com/siwc/token-sharing-open-source/sign-in)
- App-server supports an attributed stdio client, streamed events, saved thread
  IDs and token renewal controlled by the client. A model list is not a completed
  inference entitlement check.
  [App-server](https://developers.openai.com/siwc/token-sharing-open-source/codex-app-server)
- The preview route requires streamed, nonstored requests and has restrictions
  on parameters, hosted tools and continuation. Local app-server thread resume
  is distinct from hosted Responses state.
  [Limitations](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations)
- Account registrations remain distinct; refresh rotation must be serialized.
  Tokens stay out of browser storage/logs. Sign-out and confirmed revocation
  have different failure handling from a temporary network outage.
  [Accounts](https://developers.openai.com/siwc/token-sharing-open-source/profiles-and-sessions)
- Plan limits pause inference; eligibility, unavailable service and unsupported
  capabilities require different recovery. A limit error alone does not specify
  a reset time.
  [Errors](https://developers.openai.com/siwc/token-sharing-open-source/errors-and-recovery)
- Show “Using ChatGPT plan” near the picker and “Manage usage” linking to
  ChatGPT usage settings, with clear consent/limit UX.
  [UI guidance](https://developers.openai.com/siwc/ui-ux-guidelines)

### Proposed experiment design

Prefer evaluating an **isolated Codex app-server adapter** first, because it
provides a structured agent/runtime interface. Compare a small direct Responses
fixture to expose capability/maintenance differences; do not ship two competing
production executors. Write an ADR from actual results before selecting the
production route. Stop if eligibility or authority cannot be demonstrated.

Proposed future identity: `api-openai-chatgpt-plan`, separate from every legacy
row. This is a proposed stable ID, not an existing supported value. The coordinator
owns the AgentCli/provider catalog change. First prototype local only behind a
disabled-by-default development capability. SSH support is a separate later
acceptance decision; do not forward workstation tokens to a remote process.

Rust owns account registration metadata and OS-keyring secrets using the existing
brand/keyring conventions. Public UI DTOs contain opaque registration references,
labels and readiness state only. The local child process gets only the selected
short-lived access credential and a constrained environment; it never reads
ambient Codex/Claude credential files. Do not use a user's shell to launch it or
put tokens in command-line arguments. Redact auth URLs containing identity hints.

An environment allowlist alone does not prove credential isolation. The spike
must show that tool children do not inherit the inference token, and assess
whether shell/file/process access can read it from the parent or credential
store. It must also prove that app-server-owned tools honor the frozen project,
MCP and approval authority rather than bypass the native journal/permission
boundary. If the supported interface cannot enforce that contract, keep the
adapter disabled or select a demonstrably safer supported route; do not claim
security or request-budget parity from event normalization alone.

Keep authorization candidate state separate until identity/scopes validate.
Serialize refresh per registration and prevent stale refresh results overwriting
new credentials. Preserve distinct registrations even when emails match.
Sign-out stops dispatch; revoke when possible and accurately disclose an
unconfirmed remote revocation. A network 503 must not erase valid credentials.

Adapter states: disconnected → authorizing → connected_identity_only or ready
→ starting → running → completed/failed/interrupted. Auth expiry enters
refreshing; concurrent requests wait on one refresh. Declined scope returns
identity_only without inference. A plan cap enters needs_usage_attention with
Manage usage, never automatic paid API fallback. Copy changes follow Appearance
and attention contracts; explicit fallback starts a new billing-bound run.

Map app-server items onto the canonical `api-agent:*` event contract, preserving
tool/permission IDs, turn outcome and cancellation. Map only supported controls;
unknown resume/budget capability stays unknown/soft. No exact-checkpoint or
request-cap badge until this adapter proves the corresponding runtime contract.
Unsupported tools/inputs must fail before dispatch; the native API request
builder cannot be reused without checking the preview's accepted fields.

### Future implementation surface and acceptance

Owner: one transport agent after core runtime contracts, with coordinator leases
for shared provider enums/registration. Likely new Rust modules under
`commands/chatgpt_plan/` and `core/`, a structured child supervisor, schema DTOs,
auth badge/Settings card and focused protocol fixtures. Whether the existing
Node sidecar hosts the adapter is decided by the experiment; do not add a
security-relevant optional field to an old wire shape and assume it is enforced.

Required hermetic cases: OAuth state/nonce/audience mismatch; declined scopes;
callback duplication/cancel; same-email distinct registrations; serialized
rotating refresh; temporary outage versus revoked credential; no inherited
ambient credentials; partial streams, failed/interrupted terminal events;
permission correlation; unsupported capability; plan limit without reset;
no automatic billing fallback; native Stop child cleanup; one-run attribution.

Live inference uses an eligible user-selected account only when the execution
task authorizes it, with a tiny explicit scope and no credential capture in
evidence. A listing/sign-in alone is insufficient. If live account access is
unavailable, leave eligibility and real inference as unverified; do not weaken
the acceptance statement. Record source date, account class without personal
identifiers, adapter version, exact command/event fixture hashes and outcome.

Success: a documented supported route completes a local tool/approval/follow-up/
Stop/restart journey, preserves billing identity and meets the authority
contract. Otherwise retain the ADR and keep the feature disabled. Rollback
disables the new row without rewriting existing conversations, deleting saved
credentials silently or reviving retired IDs.

## I3 — Scoped rendered-app verification

### First useful boundary

Start with a **verification recipe**, not an unrestricted browser/computer
controller. Reuse the existing Playwright infrastructure to run a registered
scenario against an owned fixture app in a disposable workspace. The model may
choose a supported recipe ID and read its result; it cannot submit arbitrary
browser JavaScript or choose unrestricted navigation targets through this tool.
Existing shell authority still governs executing repository test code.

Proposed recipe inputs: runId/epoch, recipeId, registered fixture origin and
revision. Outputs: passed/failed/infrastructure_error/incomplete, source/fixture
identity, check names, redacted diagnostics and opaque screenshot/trace refs.
Preserve failed runs. An agent-authored test may supplement but cannot replace
an independent check; distinguish who supplied the expectation.

The origin is explicit loopback plus an owned port/server instance. Check
redirects, requests and tool access; local HTTP access is narrow test authority,
not permission to read arbitrary intranet services. Keep web_fetch's private-IP
SSRF restrictions. A general MCP browser may be evaluated later only with a
trusted server and enforceable origin/tool policy; readOnlyHint alone does not
make browser navigation side-effect-free.

Screenshots/DOM can contain private source, credentials or personal data. Default
to fixtures, local artifact retention and redacted summaries. Never attach
screenshots from another conversation or upload traces by default. Bind artifacts
to the originating run/project and enforce path traversal/ownership checks.

### Files, tests and promotion

Owner: verification agent after H1/H5/H6 contracts and F2 artifact ownership.
Candidate new module `core/tool_verify_app.rs`, shared tool registration under
the runtime owner, Node recipe runner under `scripts/acceptance/`, and dedicated
fixtures/specs under `e2e/`. Prefer reusing existing runners to a new browser
stack. Keep invocation structured with explicit executable/argument arrays.

Test refused origin/redirect/private host, stale epoch, artifact from another
run, timeout, server death, screenshot failure, cancellation tree cleanup,
unchanged fail-to-pass tests and an injected visible UI defect. Separately
exercise keyboard/accessibility assertions and snapshot comparisons where
they add signal. Playwright recommends retrying locators/assertions for async
UI state; do not paper over races with long sleeps.
[Playwright assertions](https://playwright.dev/docs/test-assertions)

Browser tests still do not prove native Tauri behavior. Tauri documents its
own test approaches; follow platform-supported native tooling and preserve the
repository's native acceptance boundary.
[Tauri tests](https://v2.tauri.app/develop/tests/)

Promotion requires measured improvement in the existing runtime's verification
success and interventions on fixture tasks. Otherwise retain external/manual
testing. Native desktop control, hosted computer-use tools and arbitrary user
applications are outside I3. No Composer or model-development dependency exists.
