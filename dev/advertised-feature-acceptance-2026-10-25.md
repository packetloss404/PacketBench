# Advertised-feature acceptance audit

October 25, 2026 (America/Chicago). This report inventories the feature claims
in the repository README, including its provider, protocol, platform and
distribution sections. It also checks the repository's product landing page.
The public user manual is maintained in the separate `ianlan-docs` repository;
its deployed contents are outside this source audit. Historical screenshots,
release reports and archived plans are not fresh feature acceptance.

## Evidence boundaries

The user requested a team audit, repairs, browser tests, honest documentation,
commit/push, CI verification and redeployment after everything passes. This
report distinguishes those operations rather than using a passing source suite
as proof of a deployed whole product.

- **Browser:** Playwright drives real Chromium and rendered production React
  components, keyboard, focus, forms and persistence. Its Tauri bridge and
  external responses are simulated. Harnesses may initialize component/store
  state directly. This proves browser behavior for the exercised journey, not
  Rust command execution or external service success.
- **Source:** Vitest, Rust tests, schema checks, sidecar protocol/smokes and the
  offline runtime evaluator cover particular contracts. The table identifies
  existing coverage entry points, not a claim that every subclaim in a row is
  asserted or that merely finding a test proves it passed.
- **Native/live:** a separately running installed payload, real PTY/process
  tree, actual provider/account, pinned SSH host, OS keyring, microphone,
  external repository or external worker must be exercised to earn this label.
  Earlier dated evidence retains its original source/package scope.
- **Unverified:** no fresh end-to-end pass is recorded for that feature here.
  This is an evidence gap; it is not a fabricated product failure or a new
  product requirement. Existing residuals remain in [backlog](../backlog.md).

No row below means universal provider/platform parity. In particular the
runtime journal remains opt-in; typed interrupted-effect recovery and hard
dollar bounds remain incomplete. See [transport limitations](./agent-experience/07-sdk-limitations.md).

## Feature inventory and coverage entry points

Paths in this table are repository-relative. Test names are source entry
points; execution outcomes are recorded separately below. Grouped rows retain
the related individual advertised operations so omissions stay visible.

### Agents and sidecar

| ID  | Advertised operations                                                                                                                                                              | Existing automated entry points                                                                                                           | Fresh native/live evidence still required                                                                                                                   |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A01 | Fourteen provider rows; live auth badges; configurable endpoints; live model discovery/refresh; retained selected model                                                            | `liveModelStore`, `liveModels`, `authStatusStore`, `ProviderConfiguration`, `ProviderEndpointsCard`, `ModelSelector` tests                | A permitted account/model per provider, auth transitions and account/plan entitlement. A visible row is not provider acceptance.                            |
| A02 | One Agents surface/composer; durable conversation IDs; saved Workspace conversation compatibility; no new wrapper Workspaces                                                       | `AgentsView`, `agentWorkspaceDecoupling`, `workspaceDecoupling`, `workspaceAgentsMigrationFixtures` tests                                 | Installed create/select/reopen and legacy-layout migration without duplicate sessions.                                                                      |
| A03 | Model/context/token/auth/project/Git badges; live auth events; Flight click-through; MCP source/errors; memory toggle/preview                                                      | `ContextStrip`, `apiConversationContextWindow`, `apiAgentMcpSources`, `TileHeaderActions.memoryRow` tests                                 | Actual provider metadata/auth refresh, MCP discovery and linked Flight navigation in installed app.                                                         |
| A04 | Drag/drop and clipboard images; 5 MB validation; removable thumbnails; SDK image send                                                                                              | `useAttachmentStaging`, `agentDraftAssets`, `agentDraftStore`, `Composer` tests; Rust capability guards                                   | OS clipboard/drop, durable staging and actual vision requests on each supported route. Unknown capabilities are not vision support.                         |
| A05 | Command palette; route shortcuts/non-QWERTY physical keys; New; transcript mode; Shift+Tab permission mode; composer Tab behavior                                                  | `CommandPalette`, `viewHotkeys`, `useGlobalShortcuts`, `buildComposerKeyboardHandler`, `Composer` tests                                   | Installed keyboard/IME/platform matrix and shortcut conflicts.                                                                                              |
| A06 | Slash commands, saved prompt slash templates, project skills, file/source mentions                                                                                                 | `slashCommandSource`, `slashCommandHandlers`, `PromptLibrary`, `Composer` tests                                                           | Actual project skills/file resolution, prompt insertion and native command effects.                                                                         |
| A07 | Persistent Todo/Plan, structured/fallback parsing, plan-first read-only posture and inline approval                                                                                | `agentPlanStore`, `PlanPanel.handoff`, `AgentModeChip` tests; sidecar protocol fixtures                                                   | Real provider plan tool events and denial before approval followed by permitted execution.                                                                  |
| A08 | Per-hunk acceptance; batch apply/reject; cancel pending without cancelling the turn                                                                                                | `hunkDiff`, `ReviewSurface.applyPipeline`, `agentApprovalStore`, `PendingApprovalsSection.dualMode` tests; correlated sidecar edit smokes | Real writes and partial merged file content, independent queued prompts, continued provider round after denial.                                             |
| A09 | Read-only reviewer subagent seeded with diff; blocker/concern/nit citations                                                                                                        | `flightReview`, `reviewerGate`, `ReviewBar` tests                                                                                         | Real fresh reviewer run, read-only enforcement, diff identity and usable citations.                                                                         |
| A10 | Inline restore, historical revisions/fork-resend, continued conversation after restart                                                                                             | `agentForkAndResend`, `MessageList.history`, `agentConversationRestart` tests                                                             | Source-bound installed restart and provider continuation; interrupted effects need separate reconciliation.                                                 |
| A11 | Streaming Side Chat overlay without disturbing main thread                                                                                                                         | `sideChatStore` tests                                                                                                                     | Concurrent real main/side turns, independent cancellation and retained state.                                                                               |
| A12 | Folder/editor/CLI/Workspace/terminal/Git/Flight handoffs using the same exact project target                                                                                       | `agentHandoffs`, `openInEditor`, `workspaceDecoupling`, `focusConversationDeepLink` tests                                                 | OS/editor launches and exact local/SSH target; no cloned conversation or hidden launch.                                                                     |
| A13 | Read-only Send to Monitor with no duplicated session or mutation controls                                                                                                          | `monitorWindows`, Rust Monitor command restrictions; historical native Monitor evidence                                                   | Fresh installed window lifecycle, Rust denials, two displays and app shutdown.                                                                              |
| A14 | Built-in/custom profiles; system prompt/tools/memory/posture; pinned models; automatic root rules injection                                                                        | `agentSettingsStore`, `AgentSettingsCard` tests; provider prompt/rules code                                                               | Profile save/restart, actual injected rules/tools and model pin behavior per provider.                                                                      |
| A15 | Same-provider rate-limit fallback                                                                                                                                                  | `autoFailover` tests; typed `rate_limited` protocol                                                                                       | Controlled real 429/quota/overload responses, model entitlement and truthful terminal outcome.                                                              |
| A16 | Optional local worktree/branch per conversation; Local/Worktree send default                                                                                                       | `launchConversation`, `conversationWorktreeDisclosure`, `agentTaskStoreWorktreeLifecycle` tests                                           | Real Git isolation, launch failure retains draft, safe cleanup/recovery and restart.                                                                        |
| A17 | Background running-agent tray; count, jump, stop                                                                                                                                   | `RunningAgentsChip.stopping`, `agentAttention`, `AgentChatPane.stopping` tests                                                            | Actual concurrent providers, stop/drain and accurate running counts.                                                                                        |
| A18 | Diff-line comments queued into next turn; resizable per-surface dock with Inspector/Plan/Preview/Diff/Files/Editor/Git                                                             | `reviewCommentThreads`, `rightDockStore`, `RightDock`, `InspectorFilesToEditor` tests                                                     | Installed focus/resize/persistence, exact file/line turn payload and narrow/enlarged-text matrix.                                                           |
| A19 | Smart approval prefix proposals; unified AGENTS/CLAUDE rules save; Claude plan to OpenAI handoff                                                                                   | `PermissionPrompt`, `PlanPanel.handoff`, `approvalTiers` tests                                                                            | Real allowed-prefix enforcement, both files saved safely, real cross-provider handoff and parent link.                                                      |
| A20 | One-time persisted onboarding                                                                                                                                                      | `welcome.spec.ts`, navigation smoke and app persistence tests                                                                             | Fresh installed profile and second-launch behavior.                                                                                                         |
| A21 | Sidecar v12/minimum handshake, normalized event vocabulary and correlated requests; images, plans, edits, cancellation, summaries, resume tokens, typed quota pauses, frozen trust | `agent-sidecar/test/*-smoke.mjs`, sidecar registry/protocol tests and Rust supervisor tests                                               | Bundled Node launch, mixed-version refusals and real SDK event parity on local and pinned SSH hosts. Echo/SDK doubles do not establish paid-model behavior. |

### Workspaces and SSH

| ID  | Advertised operations                                                                                                                                      | Existing automated entry points                                                                                                 | Fresh native/live evidence still required                                                                                |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| W01 | Real xterm multi-pane mosaics, draggable layout, six presets                                                                                               | `workspace-performance.spec.ts`; `WorkspaceMosaicContainer`, `mosaicPresets` tests                                              | Real PTY output/input/resize under sustained load; browser harness simulates PTY messages.                               |
| W02 | CLI-only templates/Add Session; recommended detected PacketCode; missing-CLI recovery                                                                      | `AddSessionPicker`, `WorkspaceLaunchQuality`, `workspaceCliDefaults` tests                                                      | Installed CLI detection/version/path mismatch and actionable failed spawn.                                               |
| W03 | Dormant saved layout hydration; selected Workspace starts panes; navigation preserves active PTYs                                                          | `workspaceAgentsDogfoodStore`, `workspaceActiveSelection`, `useTerminalSession` tests; browser harness launch/disposal counters | OS process identities before/after navigation/restart, no hidden startup process.                                        |
| W04 | App/Workspace/session shell precedence; supported Windows/Unix/custom shells; restart-only application; SSH login shell                                    | `terminalShells`, `terminalSettingsStore`, `TerminalShellSettingsCard` tests; historical installed shell matrix                 | Available/missing profiles on actual hosts, custom allowlist and interactive startup/exit for each platform.             |
| W05 | Effective shell header; CLI status/model/context/cost readout; model/effort/bypass overrides                                                               | `ClaudeStatusBar`, `usageStatusline`, `bypassFlags`, `WorkspacePane.account` tests                                              | Live authenticated CLI metadata, arguments and no changes to global CLI configuration.                                   |
| W06 | PacketCode version/doctor, independent executable/checkout/home settings, stable/preview install, local/SSH home isolation, exact verified launch identity | `packetCodeIntegrationStore`, `PacketCodeIntegrationPanel`, `cliCatalogPacketCode` tests                                        | Official install/update, path/version verification and isolated real CLI data homes.                                     |
| W07 | Delegate and Agent handoffs preserve exact local/SSH context                                                                                               | `agentHandoffs`, `ProjectPickerRemoteSupport`, `resumeSshConfig` tests                                                          | Installed delegation from a real remote project retains canonical host/fingerprint.                                      |
| S01 | SSH host CRUD, agent/key/password authentication, keyring storage, host-key pinning/TOFU                                                                   | `ServersSettingsCard`, `ssh`, `sshKeyPath`, `resumeSshConfig` tests; live SSH script                                            | Disposable pinned host and credentials; incorrect key denial; keyring restart and redacted errors.                       |
| S02 | Remote CLI discovery, Workspace launch, optional clone, remote sidecar/MCP                                                                                 | `remoteClone`, `remoteConversation`, sidecar remote-project/MCP fixtures; `acceptance:ssh`                                      | Compatible remote tools/Node and real pinned host; SDK provider/MCP parity. Native SSH MCP is intentionally unsupported. |
| S03 | SSH bash supervised cancellation using `setsid`                                                                                                            | Rust execution tests; dated Linux Flight proof                                                                                  | Real remote process-group cancellation/disconnect; Windows SSH remains unverified.                                       |
| S04 | Remote Git per-file confined diffs, stage, commit, push and non-fast-forward feedback                                                                      | `GitDashboardDiff`, `gitCommitFlow`, `gitPublish` tests                                                                         | Disposable remote repository, symlink escapes denied, actual commits/push conflict.                                      |

### Flight Deck and issues

| ID  | Advertised operations                                                                                                               | Existing automated entry points                                                             | Fresh native/live evidence still required                                                                              |
| --- | ----------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| F01 | Objective/acceptance brief; Assisted default; contextual Workspace/issue/conversation entries; advanced compare/cooperative choices | `LaunchFlightBrief`, `flightLaunchContext`, `LaunchAsyncFlightModal` tests                  | Installed contextual launch retains exact acceptance/project/provider identity.                                        |
| F02 | Result/next-action/blocker/evidence detail; builder checks separate from independent review                                         | `flights.spec.ts`, `FlightAttemptEvidence`, `AttemptTileDecisions` tests                    | Real builder/reviewer evidence, identity and updated source/package.                                                   |
| F03 | Read-only Plan first conversation; latest structured milestones/tasks applied before attempts                                       | `FlightPlanningCard`, `flightPlanning`, `LaunchFlightBrief` tests                           | Real provider plan, malformed/stale plan refusal and explicit user application.                                        |
| F04 | One/multiple local/SSH isolated-worktree attempts with target/provider/model/path/branch                                            | `asyncFlightStore`, `FlightAgentPicker`, `multiTargetBaseBranch`, Rust attempt tests        | Actual local/SSH isolated branches and mixed target failure outcomes.                                                  |
| F05 | Attention groups; paused/failed/approvals; collision and unpinned SSH launch refusal                                                | `flightStore`, `pathCollisions`, `attemptRouting` tests                                     | Concurrent real launches, exact roots and pinned-host denials.                                                         |
| F06 | Stop preserves work; Inspect/Continue/Discard explicit; Resume keeps file/index and new owner history                               | `flights.spec.ts`, `flightRunControl`, `flightOwnership`, Rust attempt tests                | Real process drain, Git index/untracked preservation, restart and discard confinement.                                 |
| F07 | Reviewer verdict bound to commit/brief; repair invalidates verdict; fresh review gates acceptance                                   | `flightReview`, `reviewerGateRuntime`, `FlightAttemptEvidence` tests                        | Real reviewed commit, repair round/usage and fresh independent reviewer.                                               |
| F08 | Accept versus Land/Open PR; actual delivery; archive/restore preserves evidence/history/usage                                       | `flights.spec.ts`, `flightLifecycle`, `flightDeleteCleanup`, `gitPublish` tests             | Disposable actual merge/PR, conflict handling and installed restart persistence.                                       |
| F09 | Cooperative DAG dependencies/ownership, selected ready batches, serialized integration branch                                       | `cooperativeFlight`, `boundedAutonomyRuntime`, Rust graph tests                             | Multi-agent real worktrees, conflicting merges, interruption and safe retry.                                           |
| F10 | Persisted scoped Coordination Inbox, steering/ack, safe API delivery and opt-in PTY MCP                                             | `coordinationInboxStore`, `flightCoordination`, `mcpWriteBridge` tests                      | Real API/PTY consumers, delivery acknowledgement, restart and authorization boundaries.                                |
| F11 | Bounded YOLO switches, cost/time/retry/concurrency/root checks, history and Pause/Resume/Stop                                       | `autonomyPolicy`, `boundedAutonomyRuntime`, `costGuardrails` tests                          | Adversarial real-runtime matrix; missing usage/in-flight liability means no hard spend guarantee.                      |
| F12 | Attempt stream/follow-up/review/recovery/delivery/Workspace/Monitor; persisted status/tokens/usage/coordination                     | `AsyncFlightGrid`, `flightConversationRuntime`, `apiAgentListeners` tests                   | Live event routing, interruption and persisted source-bound installed history.                                         |
| F13 | Draft PR publishing before cleanup; SSH cleanup via saved Server                                                                    | `gitPublish`, `agentTaskStoreDeleteWorktree`, Rust attempt tests                            | Disposable authenticated repository and pinned host; failed push retains work.                                         |
| F14 | Issue↔Flight GitHub/Gitea milestone/task mirroring, hidden identity/revision fences and conflict feedback                           | `issueFlightMirror`, `issueStore`, `flightStore` tests                                      | Two disposable host repositories/credentials and actual concurrent edits.                                              |
| F15 | PacketAgent frozen W9 package activation, cursor, inspect/pause/resume/revoke/evidence, external durability                         | `packetAgentPackage`, `packetAgentContract`, `packetAgentInbox`, `packetAgentStore.*` tests | Running permitted external PacketAgent, credential and real worker; close PacketBench and prove independent execution. |
| F16 | Legacy planner data compatibility, without restored autonomous planner                                                              | Flight hydration/persistence tests and retired runtime source boundaries                    | Old persisted fixture in installed profile; no hidden planner process.                                                 |
| I01 | Nine kanban columns, drag/drop, search, priorities, labels, acceptance, dependencies and Flight linkage                             | `issues.spec.ts`; `IssueBoard`, `NewIssueForm`, `issueStore` tests                          | Native persisted board and keyboard/drag interactions with actual backend.                                             |
| I02 | Work on issue sends prompt to existing session or creates project Workspace with preloaded task                                     | `issueSendToWorkspace`, `workspaceCreation` tests                                           | Real target PTY input, exact issue/project and no accidental execution/duplicate session.                              |

### Memory, dictation and trust

| ID  | Advertised operations                                                                                                                  | Existing automated entry points                                                                           | Fresh native/live evidence still required                                                                                                   |
| --- | -------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| M01 | Terminal >10s and settled Flight events recorded before optional aux summarization; patterns/confidence/categories                     | `memoryCapture`, `memoryBriefs`, `memoryStoreSettings`, Rust Memory tests                                 | Real terminal outcomes/Flight settlement without provider, then permitted configured aux model enrichment.                                  |
| M02 | Visible memory preview/toggle and bounded injection; separate local/SSH scope                                                          | `memoryScope`, `memoryRemoteScope`, `memoryDigest`, `TileHeaderActions.memoryRow` tests                   | Actual prompt includes only selected scope/context on both execution hosts.                                                                 |
| M03 | `.agents/memory` Markdown/frontmatter, plain-heading titles, IDs/revisions, links/health/provenance/search, external-edit conflicts    | `ProjectNotesTab`, `ProjectNotesTabArchive`, `projectMemoryStore`, Rust project-memory tests              | Actual filesystem edits/reloads, concurrent conflict, symlink confinement and installed restart.                                            |
| M04 | Ask searches all stored sources without prompt-injection limits, reports searched corpus                                               | `memorySearch`, `corpusRelevance`, `searchMemoryEvents`, `MemoryView` tests                               | Real saved corpus and configured provider answer; search does not broaden agent injection.                                                  |
| M05 | No automatic gitignore edits; loopback MCP note search/read/create/update/archive gated by writes/root/revision                        | `mcpProviderStore`, `mcpWriteBridge`, Rust MCP provider tests                                             | Separate loopback client, bearer/origin denial, scoped mutation and unchanged project ignore file.                                          |
| D01 | Local Whisper, verified model, language/dictionary, device selection/doctor/limit                                                      | `DictationSettingsCard`, `DictationModelDelete`, Rust dictation tests                                     | Real microphone and downloaded model; no network audio egress; physical device errors.                                                      |
| D02 | Opt-in global push-to-talk/toggle; route/cancel keys, rebinding and platform chords                                                    | `dictationStore`, `useGlobalShortcuts` tests                                                              | Native OS registration while unfocused, key conflicts, hold/release and Escape during load/transcription.                                   |
| D03 | Focus-aware safe input/contenteditable/PTY insertion; sensitive/stale/disconnected exclusions                                          | `dictationTarget`, `dictationStore` tests                                                                 | Real delayed transcription while focus changes; password/OTP refusal; PTY insertion contains no execution newline.                          |
| D04 | Windows clipboard fallback; opt-in foreground paste; transcript retained if blocked                                                    | Rust dictation delivery tests; historical hardware report                                                 | Native clipboard/paste permission denial and foreground-app transition.                                                                     |
| D05 | REC indicator/waveform/history/search; WPM/sentiment/top words/streak/time estimate/Date & Time                                        | `DictationHistoryTimeZone`, `DictationHistoryRemoval`, `AnalyticsPanel`, `analytics-derive`, charts tests | Real history and capture, local-midnight buckets, unscored rows and restart. Physical Bluetooth dropout matrix remains separate.            |
| T01 | Schema-v1 evidence origins/authority/integrity/lineage; unknown legacy records; compact chips/parent links without raw secret locators | `provenance`, `ToolCallCard`, Memory/Flight source tests                                                  | Installed round-trip/redaction across actual external artifacts. Reviewer report provenance persistence has a separately recorded residual. |
| T02 | Risky external/unknown evidence re-enters permission boundary, including autonomy; credential/publish/root/reviewer floors             | `approvalTiers`, `autonomyPolicy`, sidecar MCP trust tests and Rust denials                               | Adversarial native/SDK/SSH tool matrix; browser prompts alone cannot prove enforcement.                                                     |
| T03 | Redacted bounded trust audit, retention, export/clear                                                                                  | Provenance/audit source and Rust tests                                                                    | Native restart, expiry and exported file inspection without secrets.                                                                        |

### Quality, git hosts, budgets and project operations

| ID  | Advertised operations                                                                                                    | Existing automated entry points                                                                            | Fresh native/live evidence still required                                                                                                                      |
| --- | ------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Q01 | Scores/charts and Overview/Complexity/Languages/Tests                                                                    | `StatGrid`, `codeQualityHistory`, quality helper tests                                                     | Real scan against a disposable multi-language project and truthful unavailable-tool results.                                                                   |
| Q02 | Detected project checks, aggregate results/cancellation, streamed AI summary and persisted metric snapshots              | `QualityAIRunSummaryPanel`, `qualityAIHelpers`, Rust quality runner tests                                  | Real linter/test child lifecycle and cancel, configured aux provider, installed metric restart. Raw ANSI/per-finding/execution-run history are not advertised. |
| Q03 | One-click auto-fix with separate review panel                                                                            | `autoFixPrefs`, Rust quality autofix tests                                                                 | Real failing fixture, confined edit, review/reject and recheck.                                                                                                |
| G01 | Simultaneous GitHub/Gitea/Forgejo, origin-derived connection/icon, PAT/device flow and per-connection keyring            | `gitHostResolve`, `gitHostWizard`, `deviceFlow`, `githubStoreHostContext`, setup/edit modal tests          | Disposable authenticated hosts, OAuth user interaction, restart without plaintext credential persistence.                                                      |
| G02 | Repository selection; issue search/labels/import; PR list/diffs/comments/reviews/merge/draft/labels/reviewers            | `IssueList`, `PRList`, `git-hosts`, `githubStoreConnectionUpdate` tests                                    | Actual disposable issues/PRs with both hosts. Gitea parity extensions remain explicitly limited in the backlog.                                                |
| G03 | Releases, notifications/polling badge, GitHub-only read-only AI investigation                                            | `ActivityFeed`, `notificationPoll`, `InvestigationPanel` tests                                             | Actual release/inbox data and configured provider; permission restrictions against real project tools.                                                         |
| B01 | Daily/monthly/session/provider/Flight budget thresholds; warning and launch refusal; bounded Flight checks               | `costGuardrails`, `costGuardrailStore`, `analyticsStoreGuardrails`, native runtime-budget tests            | Priced live requests/account ledger, hierarchy, unknown billing and SDK hidden loops; not a proven hard dollar bound.                                          |
| B02 | Session History; token/usage evidence without a dedicated cost dashboard                                                 | `historyStore`, `projectHistoryStore`, `sessionIndex` tests                                                | Real prior sessions, persisted history and honest missing-usage display after restart.                                                                         |
| O01 | Six searchable Settings groups, sub-tabs and explicit scope badges                                                       | `settings.spec.ts`, `settingsNavigation`, `ToolsView`, `PlaceboSettingsControls` tests                     | Installed settings persistence and scope effects on actual new/existing sessions.                                                                              |
| O02 | MCP catalog/review-before-add/editor, diagnostics/trust/activity and selected-session reconnect                          | `McpHubCard`, `McpRootsEditor`, `McpServerScopeMove`, `mcpHubContracts` tests; sidecar config/trust smokes | Real stdio/HTTP/SSE servers, selected reconnect and no unrequested process launch.                                                                             |
| O03 | Frozen MCP authority, conservative migration, credential/root/protected publish floors; stdio is not OS network sandbox  | Sidecar trust/enforcement smokes; Rust MCP bridge/provider tests                                           | Actual hostile server and local/SSH SDK/native deny matrix; package runtime network configuration remains separate.                                            |
| O04 | Trusted project/global MCP config, explicit overrides, static headers, native local transports; SSH SDK-only MCP         | Sidecar from-filesystem smokes; Rust MCP config/bridge tests                                               | Real transport servers/headers and remote-owned configuration; no interactive native MCP OAuth or desktop fallback for remote.                                 |
| O05 | Loopback-only provider for Flight/Issues/coordination/review/Memory/Workspace/PacketCode with bearer/origin restrictions | `mcpProviderStore`, `mcpWriteBridge`, Rust loopback tests                                                  | Independent actual client, authentication/origin failures and scoped write denial. No hosted PacketMCP deployment is advertised.                               |
| O06 | Crash report browsing/cleanup; profile and task-class aux provider/model routing                                         | `auxRouting`, `AgentSettingsCard`, Rust crash/state tests                                                  | Real report files and safe removal; actual configured naming/summary/insight routing.                                                                          |

### Packaging, compatibility and future products

| ID  | Advertised operations                                                                                                                              | Existing automated entry points                                                                  | Fresh native/live evidence still required                                                                                                                     |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P01 | Bundled Node/sidecar, standalone executable resolution, ready/version/status/restart stats/provider counters, refresh-token-aware CLI auth watcher | Sidecar smokes, Rust supervisor/auth tests; release gate                                         | New source-bound installer and standalone executable, actual token file change and sidecar death/restart. Do not log credentials.                             |
| P02 | Windows owner build/install, persisted state/migrations, clean launch; macOS/Linux design/build instructions                                       | `acceptance:build`, payload hashes/install verifier; schema/storage tests; dated Windows records | New manifest/source fingerprint and installed hashes; disposable legacy/clean profiles, native walkthrough; actual macOS/Linux hosts for platform acceptance. |
| P03 | Local release/version/bundle gates; no GitHub CI; signing and updater planned/deferred                                                             | Release-gate/readiness/script tests and local gate runner                                        | Exact pushed commit check status; new signed public distribution/updater needs its named configuration. An absent CI run is not a passing CI run.             |
| P04 | Retired Gemini CLI, Codex chat and PacketCode ACP conversations remain readable with honest retirement/migration                                   | `retiredPacketCodeRoute`, migration fixtures, agent store retirement tests                       | Installed legacy saved data, no retired runtime launch or lost history.                                                                                       |
| P05 | Remote Agents disabled/fail-closed; static Sprint 0 PWA/shared validation rather than working phone control                                        | `remoteAgentsGate`, `remoteAgentsSettingsStore`, shared tests/PWA build                          | Future authenticated presence/conversation/approval/reconnect/E2EE and relay datastore proof. A PWA build is not service deployment.                          |

## Execution record for this pass

The inventory contains 82 grouped rows covering the README's related advertised
operations. The latest isolated local gates and disposable Linux SSH matrix pass
within their recorded scope. Installer build/payload verification remains
pending; neither these tests nor the inventory establish every native/live
feature row.

### Source isolation and attribution

The early checks below ran in the shared `D:/projects/PacketBench` checkout.
During its full gate scheduler, another task added 50 uncommitted lines across
`commands/agent_runtime.rs`, `commands/api_agent.rs` and
`core/runtime_journal.rs`. Those edits were preserved. Because that source tree
changed during the run, its full-scheduler output is exploratory evidence and
cannot be attributed to the final installer snapshot, regardless of individual
exit statuses. A sidecar run scheduled alone also does not mean its source
checkout was isolated.

This team's 26 files were committed separately as
`2dd33b983fe0aa26e389c4656a05a993dda35ef9`, based on committed runtime source
through `d41a0a51`. Final validation and packaging move to the managed checkout
`C:/Users/ianwalmsley/.codex/worktrees/feature-acceptance/PacketBench`, on branch
`codex/verified-feature-installers`, created at that exact commit. The other
task's 50 unfinished Rust lines are excluded from this snapshot and remain
untouched in the original checkout. The isolated validation below covers that
snapshot plus the documented test-timeout correction and pending evidence
documentation. The next clean commit and installer manifest will identify the
build source. The existing installed application remains untouched.

### Final isolated local validation

The isolated full runner executed all twelve gates; its original
`test-results/final-gates.log` records eleven passes and one cold-module-import
timeout in Vitest (3,295 passed, one failed). The migration test had a hardcoded
15-second timeout despite the project's configured 20 seconds. Only that
per-test override was removed, preserving all assertions. The focused migration
suite then passed 25/25 in 4.74 seconds, followed by a **complete** Vitest rerun:
331 files and 3,296 tests passed in 115.3 seconds, recorded in
`test-results/final-vitest.log`.

The latest result for each of the twelve local gates is therefore green. This
is the original scheduler's eleven passes plus the successful full Vitest rerun,
not a claim that the original scheduler log contains twelve passes. Production
source was unchanged by the timeout correction.

| Gate                 | Latest isolated result                 | Scope or limitation                                                                                                                |
| -------------------- | -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `format:check`       | PASS                                   | Repository formatting baseline.                                                                                                    |
| `lint:src`           | PASS                                   | Zero errors, nine existing warnings.                                                                                               |
| `typecheck`          | PASS                                   | Frontend TypeScript.                                                                                                               |
| `test`               | PASS — 331 files / 3,296 tests         | Complete rerun after removing the isolated timeout override; no assertions removed.                                                |
| `build`              | PASS                                   | TypeScript and production Vite bundle.                                                                                             |
| `remoteagents:check` | PASS — 25 shared tests and both builds | Shared protocol/PWA shell, not a working hosted Remote Agents product.                                                             |
| `e2e`                | PASS — 24/24, 128.9 seconds            | Chromium UI with simulated native bridge; includes the six new journeys.                                                           |
| `sidecar:check`      | PASS — 35.8 seconds                    | Full clean-build/protocol/registry/trust/config/edit suite; live Anthropic multi-turn explicitly SKIPPED because opt-in was unset. |
| `rust:check`         | PASS                                   | Native backend compilation.                                                                                                        |
| `rust:test`          | PASS — 1,300 library tests             | Nine library tests and two integration tests remain ignored; the schema test passed separately.                                    |
| `runtime:eval`       | PASS — 12/12                           | Production runner with scripted fake services; offline only.                                                                       |
| `check:tauri-schema` | PASS — one schema test                 | Exported Rust/TypeScript contract parity.                                                                                          |

The isolated noninstalling installer verifier's ten unsafe-path/helper
regressions also passed. These tests do not validate fresh installer artifacts;
the clean build and subsequent NSIS/MSI extraction/hash/packaged-echo run remain
the next operation.

### Final disposable Linux SSH validation

The isolated checkout's live disposable SSH run passed **15/15 cases** in
195.1 seconds: nine native sidecar trust/handshake/host-key/reconnect cases and
six native Workspace PTY cases. The latter cover interactive Unicode/resize,
exit code 7, a 10,000-line/2,220,674-byte output burst with continued input,
wrong-pin denial, disconnect and reconnect; output drains before completion.
This uses the production SSH argument builder, binary resolver and PTY
decoder/batch dispatcher against a real Linux OpenSSH container.

Evidence:
`test-results/acceptance/live-ssh/2026-10-25T17-33-35-241Z/report.json`.
It records HEAD `2dd33b983fe0aa26e389c4656a05a993dda35ef9`, dirty true for the
pending documentation/test correction, source SHA-256
`0a7000a7b5c5774345c1d9e759ca5af25f55e9a313959408d14e0229226155a4`,
and the sidecar/test-binary/image identities. The run reported no source/dist
drift, and its container/image were cleaned up.

The remote process is a harmless interactive Node fixture. No provider CLI,
paid API, installed Workspace GUI, WAN server or Windows SSH host was tested.
This closes the named disposable transport cases, not the separate live-model,
provider/SSH parity and native whole-flow acceptance rows.

### Early observations from the shared checkout

- Four new full-app Chromium journeys passed. The two
  [issue lifecycle cases](../e2e/issue-lifecycle.spec.ts) exercise creation,
  editing, filtering (including assignee), status, acceptance criteria,
  comments, reciprocal dependencies, drag/drop and deletion cleanup (I01).
  The two [Agents cases](../e2e/agents.spec.ts) exercise
  launch, streamed completion, follow-up and a backend-start failure retaining
  the draft. The Agents run reported 2 passed in
  31.7 seconds. Native service calls and model events are explicitly simulated;
  these cases do not prove actual issue-to-PTY delivery or live inference.
- Both new [preferences journeys](../e2e/preferences.spec.ts) passed in a
  targeted run (2 passed, 30.3 seconds): rendered sample font/theme and selected
  density, persistence across reload, independent terminal preference/reset,
  scoped text/layout reset and app-scale keyboard controls (O01). Together with
  the issue and Agents cases, this adds six browser journeys. An initial reload
  failure exposed a no-op persistence mock; its simulated UI-slice write/read
  was corrected, rather than misreported as a product defect.
- The specialist's `remoteagents:check` passed: 25/25 shared-envelope tests,
  shared TypeScript build and PWA TypeScript/Vite build. This is foundation and
  protocol proof, not a working Remote Agents service or phone-control journey.
- The complete `sidecar:check`, scheduled alone in the shared checkout, passed,
  including the new clean-build
  regression, full two-turn Unicode echo, strict SDK registration/missing-key
  checks, protocol controls/order/cancellation, OpenAI gating, edit correlation,
  MCP config/trust/enforcement/remote sourcing and Anthropic API-key isolation.
  The live Anthropic multi-turn check was explicitly skipped because its opt-in
  flag was unset. An earlier cold echo startup timed out while browser/build
  work ran concurrently; an isolated repeat and the final whole gate passed.
  The successful run covers offline fixtures and protocol behavior, not an
  actual paid-provider reply.
- The noninstalling payload verifier passed PowerShell syntax checks and ten
  unsafe-path/helper regressions. Its read-only MSI file mapping was also
  checked against 8,685 files in a historical artifact. That historical mapping
  check does not count as validation of this pass's new installers.
- The coordinator opened the already installed Windows application and
  navigated Agents → Flight Deck → Issues → Memory → Git Hosts; each rendered.
  Settings → General also rendered, and New → New Issue opened an empty form
  with Create disabled; Cancel dismissed it and the original Agents conversation
  remained reachable. The sidecar indicator was ready (`v0.5.0`). No issue was
  created and no actual provider/PTY task, SSH, keyring, microphone or Git host
  operation was exercised.
- That installed executable's SHA-256 was
  `b91c617d44be753ff3f2b47ff1020c5bedca9d66e4fdcbe4b3e02deb0cfaa1f9`.
  It is the pre-existing payload described in the October 24 audit, with no
  current-source manifest. This navigation smoke is useful but does not prove
  the current source is deployed or close the earlier responsiveness finding.
- Local relative-link validation passed for the new inventory and updated
  transport declaration (11 file destinations); Prettier and `git diff --check`
  passed for these documentation changes at the time checked.

The pre-existing dirty Rust changes in `commands/agent_runtime.rs`,
`commands/api_agent.rs` and `core/runtime_journal.rs` were committed concurrently
outside this team's change scope; by this documentation pass the source HEAD
was `d41a0a51492d164ea8191b65f57e09ff5f123fdf`. This audit preserves that work
and does not attribute those runtime repairs to its own commit.

## Repairs and coverage improvements

- The issue browser journey reproduced an advertised filter failure: searching
  an assignee hid their issue because the board searched title/description/ID,
  labels and Flight title but omitted `issue.assignee`. The filter now includes
  the assignee, and both issue lifecycle journeys pass.
- Appearance settings previously wrapped multiple controls in one HTML label.
  Named groups now preserve the individual button names and identify each
  related control set. The new preferences journeys check rendered sample
  typography/theme, selected density, persisted terminal preference and scoped
  reset; they do not prove native terminal or every transcript font metric.
- Sidecar echo/registry checks now require full messages,
  handshake and intended provider registration/missing-key behavior. A timeout
  or unrelated provider error must not be counted as a registered SDK pass.
- The sidecar compiler previously left retired JavaScript files in `dist`; a
  deleted June Flight Planner module was still present and would be bundled.
  The build now validates and cleans its own output directory before compiling,
  with a fixture regression covering stale-output removal. This avoids shipping
  retired artifacts and does not restore the deleted planner runtime.
- The Playwright web server starts installed Node/Vite directly, removing an
  avoidable Corepack network lookup from local browser test startup.
- Installer evidence gains archived artifact copies and a noninstalling
  NSIS/MSI payload verifier. Packaging/payload outcomes remain separate from
  installed-app acceptance and are recorded after an actual run.
- The README now states budget, recovery, transport and GitHub-only action
  limits. The transport declaration recognizes the subsequent committed
  manifest, liability, context and child-cancellation repairs without promoting
  them to whole-product acceptance.

## Deployment interpretation and completion gate

This repository produces a native desktop application. There are no GitHub
Actions workflows by design. Verify remote checks for the pushed commit, and
record absent checks as absent. Local gates remain the release signal.

The owner clarified the target during the audit: **prepare verified installers
without reinstalling**. That removes installation and site publication from
this pass. The established owner-only Windows packaging path is:

1. Finish changes and applicable full local gates on a stable source snapshot.
2. Run `pnpm acceptance:build` to build NSIS/MSI and write a source/resource/hash
   manifest. The wrapper also restores sidecar development dependencies after
   the bundler's intentional production pruning.
3. Verify installer hashes and the complete bundled payload against the
   manifest, then hand back the exact NSIS/MSI artifacts. Existing installed
   state remains outside this packaging pass.

A later installation/whole-flow run can follow the existing
[installer acceptance runbook](./installer-ssh-acceptance.md). It remains needed
to close native feature acceptance. A process that responds at rest or an
installer exit code cannot close that matrix.

Do not reuse an old installer and attribute it to this commit, move the existing
`v0.14.9` tag, publish a public release, deploy the separate docs repository, or
enable Remote Agents merely because local tests pass. The present request makes
redeployment conditional on everything passing; missing named native/live
evidence must remain visible rather than silently counted as green. Signing and
updater deferrals retain their existing owner-only scope in
[the distribution runbook](./beta-distribution-trust-runbook.md).
