# Source, deployment and documentation verification

Date: October 24, 2026, America/Chicago. UTC evidence paths can be dated October 25. This is a read-only application audit followed by documentation updates.
Three specialist agents reviewed runtime, F/V implementation and Remote Agents/
documentation independently; the coordinator checked GitHub and installed bytes.
The documentation pass inventories/classifies every tracked Markdown file and
new reconciliation document, checks local Markdown references, and reconciles
the current entry points and active plans. It does not reread every archived
source-line claim as if it were a current implementation requirement.
No application implementation, deployment, installation or paid account activity
was authorized or performed in this pass.

## Verdict and evidence

The requested plan has **committed implementation slices, not complete deployment
or acceptance**. Reconcile documentation even though the full-completion premise
is false: preserving an inaccurate green status would be misleading.

### Git

- Branch: `main`; HEAD `922ddcc928629e116215d899580f7e9370b2603d`.
- Read-only live GitHub check returned exactly that SHA for `refs/heads/main`.
  The local tracking comparison was also 0 behind / 0 ahead.
- Initial modifications: `dev/README.md` and `dev/composer-research-2026-10-19.md`.
  Application source had no uncommitted diff. This audit preserves those edits,
  including the separate thread's Composer summary in the index.
- The original agent-experience specification and subsequent source changes are
  tracked. Reconciliation documents/edits form a subsequent documentation-only
  commit, separately authorized by the owner; they are not covered by the prior
  application push. Composer research and its index-summary changes are excluded.

### Workstation payload

Read-only filesystem/process checks found:

- Installed path: `%LOCALAPPDATA%/PacketBench/packetbench.exe`, version 0.14.9,
  52,701,184 bytes, SHA-256
  `b91c617d44be753ff3f2b47ff1020c5bedca9d66e4fdcbe4b3e02deb0cfaa1f9`.
- File write timestamp: `2026-10-23T20:35:42Z`. PID 17972 had started at
  `2026-10-23T20:41:11Z` and reported Responding true. This is a point-in-time
  liveness observation, not an interactive walkthrough or N1 root-cause proof.
- The available release executable under
  `C:/Users/ianwalmsley/packetbench-build/release/` has unpatched SHA-256
  `6a99b2c0bb41e6120491d2d53040ad39a8869c5e7d235b5db92050b9e9f717ae`.
  The existing read-only `scripts/acceptance/executable-hashes.mjs` derives its
  NSIS payload hash as exactly the installed hash. Different unpatched/patched
  hashes are expected; they are not evidence of a corrupt installation.
- No discovered source/installation manifest binds this October 23 payload to
  the October 24 HEAD. The latest canonical Windows acceptance manifest found
  is `test-results/acceptance/windows/2026-10-20T01-56-47-983Z/manifest.json`;
  its installed hash is `6a69c35c…2dc55cb`, a different October 19 build.

Thus an updated application is installed, but the latest plan cannot be declared
deployed. A version string, modification time or matching available executable
does not identify all installer inputs/source. Full resource and source identity
verification remains required. No build or reinstall was performed to hide this
gap.

### Existing test evidence, not a new rerun

The newest inspected runtime-eval manifest is
`test-results/acceptance/runtime-eval/2026-10-25T02-23-04-250Z/manifest.json`:
12/12 offline cases passed; HEAD `22d1cbd6498e35aa8f66b3dc5e149e45580dd3ce`,
dirty true, source fingerprint
`e2cc6293fa8237fd2061dac74243c05cb67cc0ed20b8e4cd431e1bc4ecf0d5b3`.
It is useful archived evidence, not a rerun against clean `922ddcc9`, live-model
evaluation, SSH acceptance or installed-app proof. Historical suite counts in
HANDOFF/backlog are recorded reports and were not independently reproduced here.

## Runtime coverage of the original target

All referenced commits are reachable from audited HEAD. These statuses describe
source/wiring only, not universal enabled behavior or package acceptance.

| Packet   | Committed source                                                                                                                 | Remaining target boundary                                                                                                                                                                                              |
| -------- | -------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R1       | `ea9951f3`: SQLite prepare/idempotency/ownership/events/cancel substrate; schema now v5                                          | Checkout-only reduced contract; full frozen intent, immutable SSH authority, resource ownership and production transaction missing. Existing-turn owner/revision/predecessor validation incomplete.                    |
| R2       | `f0d1d18d`, `476dd6fd`, `6d1f5848`: actual production `run_turn` extraction, `RuntimeServices`, fake-provider parity             | Extraction implemented; tests and existing native evidence have their own snapshot limits.                                                                                                                             |
| R3/H2    | `b4e9addc`, `5e53aab7`, `842b2849`: typed checkpoint storage, checks, native boundary writes                                     | Public recovery lacks policy compatibility and refuses typed replay; epoch change is not provider continuation. Follow-up/retry run identity, terminal projection, image pins and reconciliation/UI bridge incomplete. |
| R4/H5/H6 | `f83c3610`, `42fb8cc4`, `922ddcc9`: capability/readout/image preflight; manifest module/storage tests                            | Guards opt-in; capabilities largely static. No production full-manifest insertion found; checkpoint identity is a reduced route/model/execution label.                                                                 |
| R5/H4    | `d5f6a375`, `7da096ba`, `429a407b`: single-scope reservations, native/child wiring, usage request IDs and startup reconciliation | Configured budget plus journal required. Estimates omit system/tool/image input; missing/cancelled usage can release uncertain liability. Hierarchical budget/billing scopes and hard-bound evidence missing.          |
| R6/H3    | `c58ba3cc`, `22d1cbd6`: context estimate/snapshot/overflow guard and session-carried catalog window                              | Heuristic accounting; unknown windows can dispatch. No retrieval/omission/tokenizer/compaction contract or complete context readout.                                                                                   |
| R7/H7    | `122a81f1`: explicit native roles/model selection, structured child result, parent budget hooks                                  | Catalog entitlement, child cancellation and SDK hooks/parity remain limited.                                                                                                                                           |
| R8/H1    | `738444a6`: feature-gated CLI, 12 fixtures, result schema and offline gate using production runner                               | Offline v1 implemented; live mode refuses. Repeated held-out tasks, real executor isolation, SDK/live and further fault cases remain. No Composer program is included.                                                 |

Primary source seams:

- [runtime_journal.rs](../src-tauri/src/core/runtime_journal.rs), line 51:
  defaults off unless `PACKETBENCH_RUNTIME_JOURNAL=1`.
- [runtime_types.rs](../src-tauri/src/core/runtime_types.rs), line 90, and
  runtime_journal line 354: reduced preparation/existing-turn validation.
- [agent_runtime.rs](../src-tauri/src/commands/agent_runtime.rs), line 187:
  public resume lacks live policy context; line 674: admission estimate.
- [api_agent.rs](../src-tauri/src/commands/api_agent.rs), lines 1615/1711/1842:
  startup binding and production start/follow-up runner calls.
- [runner.rs](../src-tauri/src/core/agent_runtime/runner.rs), lines 531/545/685:
  optional guards and cancellation reservation release.
- [runtime_budget.rs](../src-tauri/src/core/runtime_budget.rs), line 543:
  missing-ledger reservation release; absence does not establish zero billing.
- [runtime_manifest.rs](../src-tauri/src/core/runtime_manifest.rs), line 165:
  manifest substrate; no production insert caller found in this scan.
- [runtime_context.rs](../src-tauri/src/core/runtime_context.rs), lines 1/220:
  estimation/unknown-window boundary.
- [subagent_role.rs](../src-tauri/src/core/subagent_role.rs), line 113, and
  [tool_subagent.rs](../src-tauri/src/core/tool_subagent.rs), line 37: native roles.
- [runtime_eval/mod.rs](../src-tauri/src/runtime_eval/mod.rs), line 1, and
  [quality-gates.mjs](../scripts/quality-gates.mjs), line 267: offline lane/gate.

Do not enable the journal or strengthen dollar/recovery claims just because
the prerequisites were committed. Unknown billing/effect liability must survive
until reconciled; source tests that assert the current release behavior do not
prove that it meets the original target contract.

## Agents flow and appearance coverage

| Packet | Committed implementation                                                                                            | Remaining boundary                                                                                                                      |
| ------ | ------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| F1     | `a7348d2f`: isolated failure aborts launch and preserves draft                                                      | Native failure/retry proof.                                                                                                             |
| F2     | `a7348d2f`, `7b1bbaec` and fixes: scoped staging, durable byte refs, validation, startup GC                         | Single launch draft key, incomplete submission/message/checkpoint pins, global cap/grace/scheduled GC and read-failure handling.        |
| F3     | `ebd17aed`, `b79790f4`, `98f30376`, `72aee531`: real fork, saved revisions, Flight UI gating, old links             | Mutation-boundary Flight protection and native lineage/restart proof.                                                                   |
| F4     | `7c3492e4`, `581cd5c2`: selection protection, latch, phase labels                                                   | Backend-start rejection still returns an ID; launcher can show Running/clear draft. Canonical prepare/cancel/reconcile remains unwired. |
| F5     | `7e58cb4c`: base grouping and SSH repository labels                                                                 | Contextual New loses SSH host identity.                                                                                                 |
| F6     | `00fafd22`: exact-target helper, header attention/focus and return state                                            | Review overlay can still cover permissions; global routes do not all use helper.                                                        |
| F7     | `00fafd22`, `bae939d1`: matching turns and persisted anchors                                                        | Whole-flow/native reader restoration/resize evidence.                                                                                   |
| F8     | `53521439`: IME/history/deliberate-edit guards                                                                      | Native IME confirmation proof.                                                                                                          |
| V1/V2  | `ad267d83`: comfortable semantic scale and improved contrast/token tests                                            | Raw/default fixed typography and actual composited state coverage.                                                                      |
| V3     | `c3f6f573`, `51ed16d2`, `a38dea4d`: preferences/resolver/root hook, actions, Workspace terminal, Monitor projection | Complete scaling, transient terminal, width/reset ownership, schema/native matrix.                                                      |
| V4     | `7dafa1b3`: theme-aware code and Copy focus                                                                         | Consistent mono/diff metrics and native appearance proof.                                                                               |
| V5/V6  | `7dafa1b3`, `00fafd22`: target tokens, some named actions/focus                                                     | Primary Send/Stop/mic/sidebar targets and Stop/mic accessible names incomplete.                                                         |
| V7/V8  | `00fafd22`, `7dafa1b3`: splitter/title/context disclosure                                                           | Duplicate width ownership, narrow drawer/action lane, fixed header and full enlarged-text matrix.                                       |

Source-confirmed residuals to keep actionable:

1. **Wrong-target risk:** [AgentsView.tsx](../src/components/views/AgentsView.tsx),
   line 138, passes a remote plain path to New; [launchConversation.ts](../src/lib/launchConversation.ts),
   line 154, chooses SSH from its URI. Preserve canonical server identity.
2. **Start failure/draft loss:** [agentTaskStore.ts](../src/stores/agentTaskStore.ts),
   line 1026, catches backend-start failure and returns an ID. launchConversation
   lines 300–313 can then show Running and clear the launch draft.
3. **Hidden approval:** [sessionGlue.ts](../src/stores/sessionGlue.ts), line 174,
   arms exact focus without closing review; [AgentChatPane.tsx](../src/components/agents/AgentChatPane.tsx),
   line 511, keeps the overlay. Update all attention entry points.
4. **Asset retention:** [agentDraftStore.ts](../src/stores/agentDraftStore.ts),
   line 193, keeps only v2 draft refs for GC; a preserved future envelope can
   yield an empty keep set. [draft_assets.rs](../src-tauri/src/commands/draft_assets.rs),
   line 190, removes other assets immediately. Pin all durable owners and treat
   unreadable/newer ownership conservatively. [agentDraftAssets.ts](../src/lib/agentDraftAssets.ts),
   line 25, skips unreadable materializations, so a visible missing-chip check
   alone does not cover every read failure.
5. **Scale/ownership:** [agentSidebarPrefsStore.ts](../src/stores/agentSidebarPrefsStore.ts),
   line 58, owns the rendered width while Appearance reset changes a different
   field. [TransientPtyModal.tsx](../src/components/ui/TransientPtyModal.tsx),
   line 131, still fixes the font at 13px. Legacy text/targets/header geometry
   do not all consume the resolver.
6. **Primary controls:** [Composer.tsx](../src/components/agents/composer/Composer.tsx),
   lines 851/917, retains unnamed mic/Stop and small targets;
   [Tooltip.tsx](../src/components/ui/Tooltip.tsx), line 113, supplies descriptions,
   not names. Semantic tokens alone do not close V5/V6.

These are static source findings, not newly reproduced native bugs. They justify
partial status and focused follow-up; no application fix was made here.

## Remote Agents and deployment-record reconciliation

Remote Agents is the owner's **highest product implementation priority**.
PacketBench's [remoteAgentsGate.ts](../src/lib/remoteAgentsGate.ts), lines 65/127,
still records eleven unmet gates and requires both readiness plus opt-in.
The [PWA](../remoteagents/pwa/src/App.tsx), line 25, is a static Sprint 0 surface.
Shared envelope validation exists; it is not a functioning phone-control product.

The sibling checkout `D:/projects/packetrelay`, inspected read-only at `74ffc10`,
contains committed identity/ACL/audit/PostgreSQL repository substrate from
`522687a`, but auth/tickets/replay/outbox are excluded from that persistence slice.
Feature-on Remote Agents routes return not-implemented; default-off routes refuse
access. Its PostgreSQL tests require `TEST_DATABASE_URL`; no database test was
run by this audit.

Later local operator records describe a September 12 datacenter/Caddy/systemd
deployment, a September 14 removal of the former Railway project/database,
and an October 6 domain update. The sibling README is modified and `deploy/`
is untracked. Treat those as later local operational evidence, **not** committed
deployment attestation or a live infrastructure health check. This audit did
not contact endpoints/accounts or edit that sibling repository.

Preserve historical Railway/Sprint 0 evidence with its date, qualify current
infrastructure assertions, and refresh deployment/datastore reality before
implementation. Keep the resolved product-auth direction and confidentiality
requirements; do not silently substitute an auth provider or claim E2EE shipped.

## Consolidation decisions

- [dev/README.md](./README.md) is the one entry point; [current status](./current-status.md)
  gives facts, [ROADMAP](../ROADMAP.md) gives ordering, [backlog](../backlog.md)
  is the sole task ledger and [HANDOFF](../HANDOFF.md) gives restart context.
- [The Markdown catalog](./documentation-map.md) enumerates the tracked root,
  dev, archive, docs, website/package and vendored documents with classifications.
  Ignored local agent instructions are identified separately. No old plan is
  made active merely because it appears in the catalog.
- Keep original file paths/history. Add current/historical boundaries and repair
  navigation rather than move every dated report and break its references.
- Keep agent-experience specs as target contracts with audited progress links;
  R2b decisions become a historical decision record and SDK declarations are
  corrected to source-enforced limitations.
- Retain public docs in their existing separate repository; this pass does not
  deploy or promise synchronization of that website.
- Preserve Composer research and its pre-existing edits as a separate program.

The current snapshot and ledger list completion work with Remote Agents first.
The audit does not turn old future-product sketches into approved implementation
or reopen retired products. Source fixes, live verification and installer work
remain separate actions from this documentation reconciliation.

## Documentation validation

- Catalog coverage: all 178 tracked/new repository Markdown documents are listed,
  with no extra or missing catalog entries. Ignored local instructions are
  identified separately.
- All 672 local Markdown file references in that inventory resolve. This checks
  file destinations, not heading anchors, external website availability or the
  historical accuracy of every archived statement.
- Prettier passes for the rewritten entry points, new reconciliation documents,
  agent-experience documents and eight updated Remote Agents documents.
  Untouched historical/vendor formatting is outside this change.
- `git diff --check` passes. The working-tree change contains Markdown documents
  only; application source remains unchanged at `922ddcc9`.
- A separate final agent recheck cleared the current-status, audit, README and
  ledger consistency. No product quality gates, native acceptance, build or
  installer run is claimed by these documentation checks.

The local inventory results are saved in
`test-results/documentation-audit-2026-10-24/validation.json`. The separate
Composer research remains independently edited and was not modified by this
audit. The owner subsequently authorized a documentation-only commit and push,
excluding Composer research and its index-summary changes.
