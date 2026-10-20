# Agents flow: implementation specification

Status: **Proposed design; implementation has not started.**

Date: 2026-10-19, America/Chicago. Source baseline: `e5d31084`.

Parent evidence: [Agent harness and experience review](../agent-harness-and-experience-review-2026-10-19.md), findings F1–F8. This document defines their behavior and future work boundaries. The parent plan and `backlog.md` remain the work ledger. It excludes Composer model/harness comparisons, provider-account integration research, typography decisions and a new scheduler.

The audit is source-only. In particular, attachment carryover and navigation races are predictions from component/store lifetime, not reproduced native bugs. The parent review records a Windows Agents-navigation timeout followed by a nonresponding process; its cause is unisolated and may involve native/accessibility automation. This document neither diagnoses that hang nor claims a successful native Agents walkthrough. Native Mac behavior remains unverified. No app source, tests, builds, providers, accounts or desktop controls were exercised in producing this specification.

## Outcome and boundaries

The ordinary journey is: choose a stable project → compose with visible host/model/scope → prepare once → follow progress or leave → open the exact request needing attention → review changes → continue or open the Git ending → archive when work has settled.

Keep the existing shared composer, per-conversation text drafts, inline permissions, canonical hunk review and Viewed signatures. Improve continuity around them. Do not replace them with another dashboard or another approval queue.

Agents remains the owner of structured GUI conversations. Workspace remains the daily CLI/PTY and Git workroom. Opening a conversation must not create a wrapper Workspace; opening its exact project, attaching a terminal and opening its Git ending remain explicit actions. Flights remains the organizer for scoped work with its own review/delivery lifecycle; adding a conversation to a Flight prepares the existing brief, never starts work implicitly. The [locked Workspace/Agents route contract](../workspace-agents-wa0-route-contract.md) still applies.

API-key/local/configured-endpoint billing identity remains visible and separate from PTY subscription sessions. This track adds no subscription credential reuse or provider transport. A source feature count is not evidence of experience parity.

## Evidence map to refresh before implementation

These line numbers refer to the baseline, not a promise that they remain stable:

- **F1:** [launchConversation.ts](../../src/lib/launchConversation.ts), lines 249–268, continues in the root after worktree preparation fails; [AgentsView.tsx](../../src/components/views/AgentsView.tsx), line 96, expires its warning after five seconds. The repaired Flight launch path is separate.
- **F2:** [AgentsView.tsx](../../src/components/views/AgentsView.tsx), line 177, and [AgentChatPane.tsx](../../src/components/agents/AgentChatPane.tsx), line 489, reuse components across selected IDs. [useAttachmentStaging.ts](../../src/components/agents/hooks/useAttachmentStaging.ts), lines 26–54, holds unscoped local state. [agentDraftStore.ts](../../src/stores/agentDraftStore.ts), lines 29–50, persists text only in one launch slot plus conversation keys.
- **F3:** [MessageList.tsx](../../src/components/agents/chat/MessageList.tsx), lines 403–405 and 452–480, mixes Fork/Restore language with transcript truncation. [agentTaskStore.ts](../../src/stores/agentTaskStore.ts), lines 1655–1722, modifies the same conversation and does not restore files.
- **F4:** [AgentsView.tsx](../../src/components/views/AgentsView.tsx), lines 119–125, applies late provider/model auto-picks. [Composer.tsx](../../src/components/agents/composer/Composer.tsx), lines 472–513, uses a timed launch latch and clears draft inputs before asynchronous settlement.
- **F5:** [AgentSidebar.tsx](../../src/components/agents/AgentSidebar.tsx), lines 49–60, groups by execution path and labels SSH groups by server alone. [AgentsView.tsx](../../src/components/views/AgentsView.tsx), lines 132–134, opens New by deselecting without resolving project context.
- **F6:** [AgentChatPane.tsx](../../src/components/agents/AgentChatPane.tsx), lines 435–464, puts review above the permission transcript. [sessionGlue.ts](../../src/stores/sessionGlue.ts), lines 113–120, only selects/routes; [TileHeaderActions.tsx](../../src/components/agents/chat/TileHeaderActions.tsx), lines 146–155, renders a passive approval count.
- **F7:** [AgentSidebar.tsx](../../src/components/agents/AgentSidebar.tsx), lines 63–69 and 185–209, filters conversations without a matching-turn destination. [useScrollState.ts](../../src/components/agents/hooks/useScrollState.ts), lines 62–82, resets position tracking on selection.
- **F8:** [buildComposerKeyboardHandler.ts](../../src/components/agents/composer/buildComposerKeyboardHandler.ts), lines 127–186, recalls history into the draft and submits Enter without composition protection.

Relevant existing boundaries are [launchConversation.ts](../../src/lib/launchConversation.ts), [agentTaskStore.ts](../../src/stores/agentTaskStore.ts), [agentConversationPersistence.ts](../../src/stores/agentConversationPersistence.ts), [agentHandoffs.ts](../../src/lib/agentHandoffs.ts), [reviewStore.ts](../../src/stores/reviewStore.ts), [sessionStatus.ts](../../src/lib/sessionStatus.ts) and [git.rs](../../src-tauri/src/commands/git.rs), lines 393–420. The current conversation-worktree command is local-only and returns a path; it is not an atomic prepare/start/cancel transaction.

## Shared contract decisions

All shapes below are **proposed**, not existing callable APIs. The parent plan's contract registry and runtime/schema owner resolve final generated names. Flow implementation owns behavior; GUI implementation consumes these contracts and owns appearance. Do not create structurally similar competing types in each component.

### Project identity and execution identity are different

The sole definitions of `AgentProjectRef`, `RequestedExecutionBinding`, resolved `ExecutionBinding` and execution-resource ownership are [runtime §2.1](./01-runtime.md#21-identity-epochs-and-writer-ownership). Consume its generated types; do not copy a wire shape into this document or a UI store. That section owns versioning, the exact execution directory, branch/resource revision, SSH authority hash, and owned/borrowed cleanup semantics.

`AgentProjectRef` groups a repository across threads/worktrees. It grants no file or network authority. `ExecutionBinding` names the exact checkout and resolved host identity for a run; a changed server record cannot redirect an already prepared operation.

Derive `projectKey` through one helper. For local projects use the normalized backend-resolved base checkout; for SSH use stable server ID plus normalized remote base path. Do not blindly lowercase Mac or SSH paths. Collapse separators/trailing separators according to the execution filesystem; filesystem case equivalence must be proved by the backend, otherwise retain distinct keys. An offline/unresolved legacy path may get a provisional key and label; it cannot be silently treated as authority to launch. Display labels and ordering are preferences, not identity.

Prefer stamped `conversation.worktree.basePath`; use the existing legacy resolver only when its known worktree layout is proven. Never strip arbitrary path segments or infer that two unrelated `repo` leaf names are the same project. SSH labels show `repository · server`, with full path and user/host disclosure; remote paths remain remote.

Use `RuntimeRunSummary` and the smaller additive `AgentConversationRuntimeProjection` exactly as defined in [runtime §3](./01-runtime.md#3-storage-and-dto-contracts). The projection is not a second runtime state machine and carries no raw prompts, credentials, opaque replay state or attachment bytes. One runtime run is one root user turn plus its model/tool rounds and descendants; a later follow-up has a new run ID and previous-run link. Restart continues the same run only through the runtime resume contract. `RuntimeRunSummary.state` and the conversation projection's `runtimeState` must not be confused or independently redefined.

### Durable drafts and assets

```ts
type AgentDraftKey = `conversation:${string}` | `launch:${string}`;

type DraftAttachmentRef = {
  attachmentId: string; // opaque ID; never a caller-controlled disk path
  name: string;
  mimeType: string;
  byteLength: number;
  sha256: string;
  state: "ready" | "missing" | "rejected";
  errorCode?: "unsupported_type" | "too_large" | "read_failed" | "missing";
};

type AgentDraftV2 = {
  version: 2;
  key: AgentDraftKey;
  revision: number;
  text: string;
  attachments: DraftAttachmentRef[];
  project?: AgentProjectRef;
  launch?: {
    agent: string; // AgentCli in implementation
    provider: string; // explicit resolved route; canonical prepare validates it
    model: string;
    profileId?: string;
    profileRevision?: SnapshotRevision; // canonical runtime snapshot hash
    requestedIsolation: "checkout" | "worktree";
    posture: RuntimePosture; // canonical runtime §2.2 type, not a UI enum
    selectionOrigin: "default" | "automatic" | "user" | "context";
  };
  selection: { start: number; end: number };
  updatedAt: number;
};
```

Use one `launchDraftId` for a launch intent before a conversation exists. Contextual New opens the existing unfinished launch draft for that project, or creates one; explicit New draft creates another ID. A draft opened from Workspace/Flight has a source reference, not ownership by that surface. The global New entry uses the last explicitly chosen project or a visible project picker; it must not silently reuse another conversation's execution/worktree path.

`AgentDraftV2.launch` is UI selection state, not a wire request. The runtime client constructs canonical `FrozenRuntimeLaunch` through the validated snapshot/policy resolver; it must not spread the draft object into IPC. Supply the profile ID, snapshot and snapshot revision together as required by runtime §2.2. If the saved profile snapshot is unavailable or changed, show the effective settings and require a new reviewed selection before preparation instead of pretending the old hash describes the current profile.

Selecting a different project switches to that project's draft. If an unbound draft already contains text/images, offer an explicit **Use this draft for {project}** action; do not transfer context because a sidebar selection happened. Retargeting a bound nonempty draft uses **Move draft to {project}** with the destination visible, or leaves the original intact and opens an empty destination draft. A live preparation snapshot is immutable; changes produce a later draft revision, not a modified in-flight request.

Attachment bytes belong in an app-data asset directory, accessed by proposed typed `stage_agent_draft_attachment`, `read_agent_draft_attachment` and `release_agent_draft_attachment` commands. Metadata belongs in the mirrored draft envelope via `storageKey(...)`; do not put base64 images or Blob URLs into localStorage. Backend IDs validate ownership, file type, decoded size and digest. No generic read-by-path API is needed. Browser fixtures use the same asset interface with a memory implementation, not production security bypasses.

Keep the existing 5 MiB per-image limit for the initial change. Proposed initial aggregate limits are 20 MiB per draft and 100 MiB across draft assets; report capacity and allow explicit removal rather than evicting another draft silently. These are implementation defaults to validate, not observed provider limits. Requested unsupported/unknown vision behavior must use the runtime capability contract; this flow cannot silently omit an image just to start.

Asset lifecycle: staging validates/writes a temporary asset → atomic asset commit → draft revision references it → a submitted snapshot pins its refs → durable runtime/message acceptance takes ownership → draft clears only the accepted revision. On failure or cancellation the draft retains the refs. Removing a draft chip releases only its draft ref; an active/unknown operation or saved-message ref prevents byte deletion. Preview object URLs are created on display and revoked on removal/unmount; they are never the durable identity. File API defines that revocation invalidates dereferencing, so regeneration from retained bytes is required. [W3C File API](https://www.w3.org/TR/FileAPI/#creating-revoking)

Late file decoding captures `{draftKey, scopeGeneration, stagingToken}`. Navigation does not retarget it: completion may append only to that original, still-existing draft. Deletion, clearing or explicit retargeting invalidates the scope token; ordinary text edits do not throw the image away. A callback never appends into whichever composer happens to be selected when decoding ends. Unreferenced temporary assets can be collected after a proposed 24-hour grace, but recovery first scans draft, runtime-journal, saved-message and H2 checkpoint references. Never garbage-collect assets attached to an operation with unknown outcome or a retained checkpoint. H2 stores vault asset IDs and durable ownership refs, not a second image store. Typed replay validates that each asset's bytes and digest are available; a filename, hash, excerpt or transcript placeholder cannot substitute. Missing bytes block typed replay and expose an explicit recovery choice; semantic continuation must disclose omitted evidence and require renewed intent. Draft capacity defaults apply to draft staging; checkpoint/message ownership follows the runtime retention contract and cannot be evicted to satisfy a draft cap. Missing draft assets remain visible with **Reattach image** and **Remove image**; sending cannot silently discard them. Deleting a conversation releases its draft refs separately from explicit worktree/branch disposal or checkpoint retention.

### Launch preparation and idempotency

Use the runtime track's **single existing-rusqlite journal** for operation IDs, runs, requests, effects, checkpoints and reservations. Do not introduce another launch database, orchestrator or provider loop.

The only wire contracts for `PrepareAgentLaunchInput`, `PrepareRuntimeRunResult`, `PreparedRuntimeRun`, frozen provider/model/profile/posture, preparation phases, existing-conversation turn preparation and lifecycle commands are [runtime §2.2](./01-runtime.md#22-shared-launch-contract-with-the-ux-track). Do not maintain a second `Prepare...` or `Prepared...` DTO here. The UI consumes the schema owner's generated fields and command client, including explicit `provider`, `profileRevision: SnapshotRevision` and `RuntimePosture`; a snapshot revision is a versioned canonical content hash, while `draftRevision` is numeric. Draft UI metadata supplies the full namespaced `AgentDraftKey` as `draftId`; backend preparation receives the private frozen text and attachment refs as required by that contract. The result always exposes its operation summary; `prepared` is present only when the operation is actually prepared. A pending result is not a dispatch acknowledgment.

Policy/profile contents are frozen into the runtime manifest; a mutable profile ID alone is insufficient. Backend preparation computes the canonical payload digest, reserves IDs and atomically records text/attachment refs. A response may be pending with IDs and current preparation phase; status events/query complete the same operation without a second prepare. UI words such as Preparing, Starting and Start outcome unknown are presentation derived from canonical operation/run states, not another wire-state enum.

Normal sequence:

1. The UI captures the draft revision, explicit choices and requested target, allocates a new operation ID and an initial conversation ID only for a new launch, sets pending synchronously, and requests the canonical prepare command. All Enter/click/shortcut paths share it. Follow-ups and retries within an existing conversation use the runtime's existing-conversation preparation variant and its validated owner ID; they do not create or reassign a conversation.
2. The journal reserves identity and validates project, host authority, model/tool/vision requirements, policy, MCP trust and budget admission through existing owners. It then provisions isolation, resolves exact execution binding and records `prepared`. No provider request starts during prepare.
3. The UI durably attaches the conversation projection, including operation/run identity and worktree provenance, and installs scoped listeners. A failed frontend save/listener step leaves the operation prepared with **Complete setup**; it does not discard the worktree or start in a hidden place. Retrying this attachment/listener step is not a second launch or provider dispatch.
4. `start_runtime_run(expectedEpoch)` validates the cancellation fence and frozen binding immediately before dispatch. It records dispatch intent before calling the adapter. Duplicate start for the same run/epoch returns current state; it cannot buy another turn.
5. The UI shows **Running** only after the backend's start acknowledgment. Thereafter canonical conversation/run state owns running, attention, completion and Stop; the UI does not invent a separate terminal `started` journal phase.

The initial explicit Start authorizes this prepare→attach→start sequence; successful preparation does not add a routine second confirmation. `prepared` is an internal/transient state unless persistence failed, the user cancelled, the app restarted or the binding needs renewed review. A scope change is a new explicit choice. Do not turn the transaction repair into an extra launch wizard.

Cancellation is a durable backend fence, not an abandoned Promise. Before dispatch it becomes `cancelled`; late preparation/start completions cannot revive that operation ID. During an uninterruptible Git/SSH operation display **Cancelling preparation…** until the backend reconciles it. After dispatch use normal turn cancellation and show **Stopping…** until acknowledged. A close/navigation action leaves preparation running and discoverable; only Cancel cancels it.

On a crash between recorded dispatch intent and acknowledgment, display **Start outcome unknown** from the runtime's reconciliation state until it reconciles the existing session/run. Never auto-retry a paid request or a potentially executed mutation. An adapter unable to correlate/reconcile reports **Start outcome unknown — inspect before trying again**. This is bounded idempotency, not a promise of exactly-once external effects. Runtime epoch/CAS protects stale frontend windows and callbacks; existing one interactive-writer policy remains.

Retransmission, retry and restart are distinct:

- **Network retransmission:** the same operation ID plus identical canonical request digest returns the same IDs and current state only. It does not revive a failed/cancelled operation, provision another resource or dispatch another request. A changed digest conflicts.
- **Explicit retry of a proven pre-dispatch initial-launch failure:** create a new operation with `retryOf` linking the prior operation and a distinct initial conversation ID. Preserve the failed operation/resource evidence. New isolation provisioning has its own ownership receipt; do not quietly reuse the previous operation's path.
- **Follow-up/retry in an existing conversation:** create a new operation and run while keeping the same backend-validated conversation owner. Use the canonical existing-conversation variant with `previousRunId` and `expectedConversationRevision`; its compare-and-swap rejects stale writers or overlapping unresolved work. Link the retry according to runtime §2.2; reserve a new initial conversation only for genuinely new conversations. Preserve previous turn outcomes/history rather than deleting failed output to make the retry appear successful.
- **Restart/continuation:** use the runtime resume contract for the same existing run with a new CAS epoch when recovery is valid; the UI does not turn it into a new launch because a transport reply was lost.
- **Ambiguous outcome:** no automatic retry or fresh dispatch. Inspection/reconciliation must resolve outstanding effect/spend liability; any later execution requires the runtime's renewed-intent path. An unreachable SSH session is not proof that it never started.

A changed project, provider, model, prompt, policy or attachment set is a new explicit intent; the previous one remains inspectable. Cancelled operation tombstones never revive. Draft revision comparison prevents successful submission from clearing text entered during preparation.

Local/SSH differences:

- A local **Isolated worktree** failure is a persistent failed operation. **Retry isolation** retains the snapshot. **Run in project checkout…** is an explicit new intent naming the checkout; it does not automatically execute or reuse the isolated operation ID.
- SSH must resolve the canonical `ServerConfig`, actual remote repository path and current pin at prepare. A missing/changed host or pin stops preparation; reconnecting does not mutate the prepared binding. Recheck authority immediately before dispatch and require a new preparation if it changed.
- The existing Agents SSH branch currently starts at its remote path and does not provision the local conversation-worktree command. Until a runtime-backed remote-isolation contract is implemented and tested, disable **Isolated worktree** for SSH with **Remote isolation is unavailable for this target. Use the remote checkout or prepare a Flight.** Never label remote checkout execution isolated. Keep Flight's existing local/SSH attempt runtime as the supported isolated-work alternative; do not borrow its ownership IDs for a normal chat.
- Ordinary SSH drafts/assets remain on the desktop. Bytes reach the selected remote provider runtime only at explicit dispatch. A host change cannot move retained image/context refs into another host's operation.

## F1–F8 behavior packets

### F1 — Fail-closed isolated launch

**Priority/dependencies:** P1; the immediate fail-closed correction can precede F4. Its final path consumes F4's operation and binding contracts. No dependency on appearance changes or model evaluation.

**Behavior:** Remove project-root fallback from every caller of `launchConversation`, including compatibility launch surfaces. Preserve the selected isolation mode, full draft and exact failure. A known-empty prepared worktree may be safely cleaned by the runtime after cancellation; any dirty/untracked/ambiguous residue is retained with exact path, branch, **Open in Workspace** and explicit confirmed **Discard retained work…**. Do not call the existing force-removal helper as ordinary error cleanup. User-owned root checkout is never cleanup material.

**Copy/accessibility:** Inline `role="alert"`: **Could not prepare an isolated worktree. No agent was started. Your draft is still here.** Include the specific safe error detail and F2's accurate session/durable asset status. Actions: **Retry isolation**, **Run in project checkout…**, **Open preparation details**. The alternate checkout dialog names the path/host and effect before **Start in this checkout**. Errors remain until resolved/dismissed; dismissal does not clear failure state. Initial focus is the explanatory heading or safe retry, not the scope-broadening action.

**Future ownership:** Flow owner: `src/lib/launchConversation.ts`, `src/lib/__tests__/launchConversation.test.ts`. Runtime owner, serialized boundary: `src-tauri/src/commands/git.rs`, `core/worktree.rs`, shared runtime commands and generated `src/lib/tauri.ts` wrappers. GUI leases `AgentsView.tsx`/launch card after behavior is stable.

**Acceptance:** Stub worktree creation failure and assert zero backend session starts, no root-write calls and intact draft. Use disposable local repositories to prove dirty/untracked preparation residues survive cancel/restart. An explicit checkout action starts only after a new intent; SSH never receives a local-path command. Native verification uses a disposable project, not real user work.

### F2 — Complete drafts and attachment ownership

**Priority/dependencies:** P1; staged as the two slices below. F4 consumes draft identity and, for images, the durable asset slice. F8 uses revision and selection APIs. Do not defer the immediate cross-conversation lifetime correction until the asset service is complete.

**F2A — First useful slice:** Own the complete text/image draft in an in-memory map keyed by conversation or launch identity, preserving A while B is selected. Include visible type/size/read rejection and bind late staging completions to their original live draft, rejecting deleted/cleared/retargeted scopes. A keyed remount that throws A's images away does not pass. Keep existing text persistence, label in-memory images **Kept in this session**, and do not claim that those bytes survive process exit. After restart any retained image metadata without bytes is **Missing — reattach image**; no automatic send or typed image replay is allowed. This slice repairs the existing send path without pretending that an in-memory handle is a durable runtime asset.

**F2B — Durable assets and recovery:** Add the backend asset service, migration, submission/checkpoint pins and disposal rules below. It is required before enabling image-bearing preparation through the new runtime contract or typed image recovery. Text-only operation integration may proceed independently. Retained bytes/digest, not an image chip or filename, establish recovery readiness.

**Behavior:** Replace `useAttachmentStaging` as the owner of bytes with draft-bound asset staging. A keyed component alone is insufficient: unmounting A must not throw away A's pending images. Keep text, selections, images and launch choices when switching conversations/projects or restarting. On Send, create a durable user-message submission snapshot before clearing it. During streaming, a queued submission must carry the whole snapshot, including attachments, or explicitly offer **Queue text only** and **Keep full draft**; never send text while silently holding its image back. Missing/unsupported vision capability blocks before submission with a recoverable explanation.

**Migration:** Read the existing `agent-drafts` string map once into a versioned `agent-drafts-v2` envelope. Preserve conversation IDs; migrate `__launch__` into one explicit legacy launch draft, initially unbound until the user confirms its visibly suggested target. Do not invent missing old attachments. Commit V2 metadata/assets before marking migration complete; keep a text-only compatibility projection until the parent rollout gate permits removal. Unknown future versions stay read-only with export/recovery, never coerce to an empty store.

**Copy/accessibility:** Attachment chips identify filename/type/size and **Remove {filename}**. Rejections say **{filename} was not added: images must be 5 MiB or smaller** or the precise type/read failure. Announce completion/rejection once through a status region. Reading/staging never steals focus. Disk-full/mirror failure says **Draft could not be saved — keep this window open** with Retry/Copy text/Remove images; never claim Saved before durable acknowledgment.

**Future ownership:** Flow owner: `agentDraftStore.ts`, `hooks/useAttachmentStaging.ts`, proposed `types/agent-flow.ts`, `lib/agentDraftAssets.ts`, relevant draft/hook tests. Backend asset owner: proposed `commands/agent_drafts.rs`, registration/capabilities and schema via runtime/shared owner. `Composer.tsx` behavior lease first; GUI subsequently applies target sizes/names/layout without changing lifetime semantics.

**Acceptance:** F2A proves A→B→A staging and asynchronous decode, visible rejections, launch/chat/project separation and correct session-only disclosure; it makes no crash-durability claim. F2B adds failed send/start, edits during pending submission, restart with ready/missing/corrupt assets, storage quota, delete while decode is pending, two snapshots referencing an asset, and a retained H2 checkpoint after its draft is cleared. Assert identity/refcount and durable bytes, not merely chip count. Missing checkpoint bytes block typed replay without silently dropping evidence. Browser mock IPC verifies image payload reaches only the intended submission. Native paste/drop and restart verify real WebView behavior.

### F3 — Actual Fork and truthful transcript rewind

**Priority/dependencies:** P1; basic naming/protection can ship before exact typed continuation. Execution uses F4 plus runtime H2 continuation/resource contracts. It must not fabricate typed replay from the existing text-only resume fallback.

Proposed additive lineage metadata:

```ts
type ConversationLineage = {
  parentConversationId: string;
  sourceRevisionId: string;
  forkedFromMessageId: string;
  kind: "fork";
  contextMode: "typed" | "semantic";
};

type TranscriptRevision = {
  revisionId: string;
  conversationId: string;
  parentRevisionId?: string;
  operation: "initial" | "transcript_rewind";
  throughMessageId?: string;
  createdAt: number;
};
```

Execution-resource IDs, owned/borrowed bindings and writer tokens come exclusively from [runtime §2.1](./01-runtime.md#21-identity-epochs-and-writer-ownership); lineage is not an independent cleanup-ownership record.

**Fork:** **Edit & fork…** opens a child draft, anchored to the selected user turn. It allocates a new conversation ID, persists lineage and prefix as immutable source context, and preserves the original conversation/messages/approvals/plan/Viewed/draft. A preview names project, host, branch/current files, provider/model/posture and continuation fidelity. Only explicit **Start fork** creates a runtime run. Creation/save/start failure leaves a recoverable child draft and the original unchanged. Do not copy live session/resume tokens, pending approvals, counters or transient streaming state.

Default semantic forking uses the parent's current files, not historical filesystem state. It can execute in the same checkout only after the parent has stopped/settled and no other writer owns that execution resource. The runtime journal owns resource/borrower references and an exclusive writer token `{runId, epoch}`; no lease timeout may free an unknown mutation or unconfirmed cleanup. The child holds a borrowed resource reference; never stamp the parent's worktree as a second independently disposable child-owned worktree. Child deletion releases its borrow and cannot remove the parent's directory; parent discard must account for live references. If writer/resource-reference support is not available, create the child draft but block **Start fork** with a clear choice of a separately prepared checkout. A fresh isolated checkout is explicit and must not pretend to include uncommitted parent files. Runtime/resource owner supplies this contract before enabling execution.

**Transcript rewind:** Rename Restore to **Rewind conversation…**. Its preview says **Later messages move to a saved history revision. Files stay as they are.** Show the selected boundary and message count, plus current host/path/branch. It is available only when no turn or unresolved tool is active. Stop and wait for acknowledgment first; do not proceed after a failed Stop. Persist the complete old revision, then atomically switch the active revision and detach the runtime session. No backend filesystem undo occurs. The new follow-up is explicit; the action does not automatically buy a rerun. **View previous history** remains available. Old links with message IDs resolve to their saved revision.

**File checkpoints:** A future real restore must be a separate action, e.g. **Restore files from checkpoint…**, with a backend-issued plan containing checkpoint ID, exact execution resource, current revision/HEAD, changed/tracked/untracked paths and overwrite effects. Confirm using a short-lived token bound to that plan and the same current file state; changed files/host invalidate it. Preserve work before destructive replacement and test conflicts/recovery. Until that contract exists, display **No file checkpoint is available** as explanation and omit any active file-restore control. F3 is complete with truthful transcript operations; implementing file restoration is deferred to the runtime/Workspace checkpoint track.

**Flight/Workspace boundary:** An attempt builder/reviewer conversation is runtime-owned. Disable transcript mutation/fork execution that would evade its Flight review/scope/cost identity; offer **Prepare a Flight follow-up** through the existing brief instead. Forks are not automatically linked as new task attempts. Planning and ordinary linked conversations preserve references without pretending the child is the same approved run. Git delivery remains on the existing exact-resource ending surface.

**Future ownership:** Flow owner: `agentTaskStore.ts` history actions, `agentConversationPersistence.ts`, proposed `lib/agentHistory.ts`, `chat/MessageList.tsx` behavior, lineage tests. Runtime/schema owner: typed checkpoint compatibility, revision persistence schema, resource refs/writer admission, projected DTOs. GUI owns the confirmation/draft visual shell after the serialized behavior lease.

**Acceptance:** Fork earlier text/images after a later edit; original remains byte-for-byte readable, child has distinct identity, and queued tools are not copied. Failed child persistence/start leaves original intact. Rewind then reopen old message links; no file mutation or provider start occurs. Reject rewind while Stop fails. Child deletion preserves borrowed worktree; parent discard identifies dependencies. Both local and SSH identity survive restart, and semantic continuation is labelled.

### F4 — Stable preparation, explicit choices and cancel/reconcile

**Priority/dependencies:** P2 with P1 failure protections; depends on F2 draft identity and runtime prepare/start/cancel APIs. F1 can fail closed earlier. Root runtime owns operation journal/epochs/budgets, not the composer.

**Behavior:** Replace the synchronous boolean `onLaunch`/500 ms latch with an operation handle driven by the shared launch store. Disable duplicate Start immediately for its active draft revision; show **Preparing isolated worktree…**, **Ready to start**, **Starting agent…**, **Cancelling…**, **Start failed** or **Start outcome unknown** accurately. Navigating away keeps a preparing item in the conversation/project list. Distinct intentional drafts can be prepared independently within runtime admission limits.

Provider/model auto-pick may run only while selection origin is default/automatic. User/context choice increments a selection revision; a probe callback may apply only if the captured revision still matches. Restored launch drafts count as explicit saved choices. Freeze effective profile/model/posture, show overrides, and never change billing route through a late probe or failure fallback. Preparing a new revision requires explicitly stopping/cancelling or leaving the existing intent running as a separate operation.

A local cancellation acknowledgment does not prove an unreachable SSH process stopped. Show the backend's unknown/reconcile state and exact retained resource. Retry/inspect/Stop actions depend on that state, never a fixed timeout. There is no numeric progress percentage unless the backend supplies measurable progress.

**Future ownership:** Flow owner: proposed `stores/agentLaunchStore.ts`, `lib/agentLaunch.ts`, `AgentsView.tsx`, `launchConversation.ts`, `Composer.tsx`/`ActionButtons.tsx` behavior and tests. Runtime owner: journal commands, adapter duplicate admission, cancellation fencing, asset pinning, generated bindings. Compatibility DraftTile/prompt launch callers must migrate through the same service; root integration owner leases them after inventory.

**Acceptance:** Delayed auth cannot replace explicit choice; double Enter/click after more than 500 ms yields one operation/run/worktree; repeated prepare/start IPC returns same IDs/current state without reviving terminal operations; changed payload conflicts. Explicit initial retry has new operation/initial conversation IDs and `retryOf`. Complete turn 1, submit turn 2, retry turn 2 and restart it: each new turn/retry gets its canonical new operation/run while the conversation owner remains stable; restart resumes its existing run/epoch contract and preserves both outcomes. Reject an unrelated conversation/project owner or stale expected conversation revision. Cancel during each preparation boundary, lost response, reconnect, stale epoch, app restart before/after dispatch and failed UI persistence all produce inspectable, correctly labelled states with no automatic second request. Use fake providers/echo and disposable repos; paid providers are not required for these gates.

### F5 — Stable project grouping and contextual New

**Priority/dependencies:** P2; stable project identity helper first; consumes F2/F4 for contextual drafts and pending operations. GUI sidebar resizing/typography is a later shared-file lease, not a competing grouping implementation.

**Behavior:** Group by `AgentProjectRef.projectKey`, retain distinct projects even with identical leaf names, and show execution branch/worktree on the thread row/details. Header disclosure identifies the full project path and host. Group order is stable preference order with recent activity secondary; pinning a thread cannot create multiple project sections. Collapse state persists per project. New in a project group opens that project's launch draft; global New shows its chosen target; New from a selected worktree resolves the base project and does not silently reuse its execution directory.

One status projection consumes runtime/conversation terminal outcome, streaming/cancelling state and actual approval queues. Use **Preparing**, **Running**, **Needs you**, **Failed**, **Finished**, **Stopped** and **Archived** where supported. Parked idle is **Ready to continue**, not Running; failed is not Finished. Filtering labels match the projection. Archive is organizational and never means delivered. Running/preparing/blocked work cannot silently disappear: initial policy disables Archive with **Stop this agent before archiving**. A future background-archive option requires explicit wording and a persistent active tray; it is not part of this packet. Ordinary settled archive preserves history, drafts and unlanded resources under the established safe-cleanup policy.

**Migration:** Lazily derive project identity from current stamped/legacy provenance, persist the canonical ref after validation, and retain old path aliases so saved labels/pins do not vanish. Host deletion leaves the group/history visible as **SSH target unavailable** with **Restore host configuration**; it does not become a local project. A server rename changes label only. No migration starts Git/network/provider work by itself.

**Future ownership:** Flow owner: proposed `lib/agentProjectIdentity.ts` and status projection helper, `AgentSidebar.tsx`, `agentSidebarPrefsStore.ts`, `agentHandoffs.ts`, `AgentsView.tsx` contextual behavior and tests. Runtime/schema owner resolves canonical host-sensitive paths/bindings. GUI owns only later sizing/action-lane application. Existing `sessionStatus`/RunningAgentsChip consumers must use the same state facts; root integrator owns their coordinated adoption.

**Acceptance:** Two worktrees/one repo/one group; same basename/different paths/two groups; two repos on one SSH server are distinguishable. Contextual New targets base project; switching context restores its own draft. Server rename/deletion and case-sensitive remote paths preserve identity. Active archive cannot hide work; archived settled history remains readable and explicitly resumable/unarchivable without silent delivery or cleanup.

### F6 — Exact attention routing and return position

**Priority/dependencies:** P2; independent of launch runtime, uses existing approval queues plus F7 reader anchors. Can initially capture an in-memory return anchor before F7 durable restoration lands.

```ts
type AgentAttentionTarget = {
  conversationId: string;
  kind: "permission" | "edit" | "plan" | "failure";
  requestId: string; // stable request/turn ID, never array position
  messageId?: string;
  filePath?: string;
};

type AgentReaderAnchor = {
  conversationId: string;
  transcriptRevisionId?: string;
  messageId?: string;
  offsetWithinMessagePx: number;
  followingLatest: boolean;
};

type AgentReturnLocation = {
  view: "agents" | "workspace" | "flights";
  conversationId?: string;
  reader?: AgentReaderAnchor;
  review?: { conversationId: string; filePath?: string; offsetPx: number };
  focusToken?: string; // ephemeral semantic token, not serialized HTMLElement
};

function openAgentAttention(
  target: AgentAttentionTarget,
  options?: { returnTo?: AgentReturnLocation },
): Promise<{ opened: boolean; reason?: "resolved" | "missing_conversation" }>;
```

**Behavior:** All header/sidebar/global-banner/tray/Flight links use this one command. A user-triggered permission link saves review/reader position, reveals the transcript, force-mounts the owning message, scrolls to the exact card and focuses its descriptive heading (programmatically focusable), not Allow. Edit attention opens the canonical review at its exact pending edit. A review overlay cannot cover the request. A compact **Return to review** restores its file/offset/focus. An incoming event alone announces **Agent needs your answer** and shows a persistent action; it must not move keyboard focus or auto-close review while the user types.

Targets are revalidated against the authoritative queue after mounting. If another action already resolved it, say **This request has already been answered** and preserve the return action; never silently target the next request, especially destructive commands. Y/N act only on a visibly identified current target in the active keyboard scope, with existing typing/palette/modal guards. Disable repeat responses while acknowledgment is pending; failure stays on that request with Retry and the backend's safe detail. There is no automatic Allow or retrying permission response against a different ID.

Preserve current one-per-conversation inline approval cards. The global banner is navigation/status, not a second approval owner; avoid duplicate announcements for already visible focus. Modal confirmations follow the shared Modal's focus containment/return behavior. Returning focus to the invoking control or a logical replacement follows the [WAI modal-dialog pattern](https://www.w3.org/WAI/ARIA/apg/patterns/dialog-modal/); this does not turn the ordinary review pane into a modal.

**Future ownership:** Flow owner: proposed `lib/agentAttention.ts`, `sessionGlue.ts`, `AgentChatPane.tsx`, `PendingApprovalsSection.tsx`, `TileHeaderActions.tsx`, `PinnedApprovalBanner.tsx`, review navigation and associated tests. Approval store remains queue/response owner; GUI applies accessible sizing/names afterward. Root integration owner updates Flight/Workspace callers to pass exact IDs and return context; no Flight runtime mutation is needed.

**Acceptance:** New permission during review; exact edit among multiple files; same ID resolved before navigation; two conversations blocked; archived/missing conversation; approval IPC failure; focus while typing; keyboard-only return to original review file/offset. A linked Flight review opens the exact reviewer/request and returns without creating a Workspace or accepting/delivering anything.

### F7 — Matching-turn search and reader continuity

**Priority/dependencies:** P2; uses stable message IDs and F5 project keys. F6 consumes anchors. Search can ship on current in-memory conversations; no graph database/embeddings/network search is required.

```ts
type AgentSearchHit = {
  conversationId: string;
  transcriptRevisionId?: string;
  projectKey: string;
  messageId?: string; // absent only for a title/project match
  field: "title" | "project" | "message";
  excerpt: string;
  matchRanges: Array<{ start: number; end: number }>;
};
```

**Behavior:** Show grouped matching-thread results with a small capped number of matching-turn excerpts, explicit match count and **More matches**. Search terms are literal by default, safely highlighted as text; no HTML interpolation or accidental regex. Preserve the query/filter/results selection when opening a hit. Activating a message hit navigates by stable message/revision ID, force-mounts it before scroll, briefly marks the matching text and focuses the message region. Opening a title/project hit uses the remembered anchor. Do not route a historical match to the latest turn merely because the row was virtualized.

Default search excludes archived history unless its visible **Include archived** toggle is selected. Results show archived/unavailable status and can open history without unarchiving/starting it. Search failure or incomplete loaded history states exactly what was searched. Initial implementation searches currently loaded saved messages; if persistence becomes lazy, show **Loaded conversations only** until the storage owner supplies a local index. No unsupported claim of complete full-history search.

Reader state belongs in a proposed `agentNavigationStore`, keyed by conversation plus transcript revision. Store first visible message ID, intra-message offset and whether the reader was following latest; throttle persistence and save on navigation/unmount. On return restore after the target row mounts; resize/font changes re-anchor by message, not raw absolute scrollTop. New output increments a count without pulling an older reader to the bottom. **Jump to latest** is explicit and resumes following. If an anchor was removed, use the nearest surviving message in that revision; explain **Previous location is no longer available** rather than showing the wrong search result. Unknown message IDs do not create conversations or send requests.

Preferences/query/anchors are local presentation state, mirrored via the normal namespace; no message content is duplicated into reader state. Persist query only for the current local UI session, not as a new analytics payload. Clear anchors/search references on explicit conversation deletion; saved rewind revisions retain their own anchors. Restoring position never replays tools.

**Future ownership:** Flow owner: proposed `lib/agentSearch.ts`, `stores/agentNavigationStore.ts`, `AgentSidebar.tsx`, `chat/MessageList.tsx`, `hooks/useScrollState.ts`, and tests. GUI applies sidebar/result typography/resizing afterward. Persistence owner supplies a later local-index seam if needed; do not let this packet rewrite conversation storage or H2 checkpoints.

**Acceptance:** An old rare phrase opens the exact virtualized turn; A→B→A restores reading position while A receives output; text scale/width changes retain the anchor; title-only hit; duplicate words/Unicode ranges; archived inclusion; missing/deleted message; rewind revision; empty and incomplete search. Browser fixtures must use a long transcript, not only three rendered rows.

### F8 — Safe IME and history input

**Priority/dependencies:** P2; small immediate composition guard is independent. Durable selection/history restoration consumes F2. This is input behavior only; it is not Composer model research or a new editor.

**Behavior:** Guard the shared textarea handler before popover/history/mode/submit processing when the native event is composing or the composition lifecycle ref is active. Do not prevent the IME's default candidate-confirmation behavior. `compositionend` commits text/selection; it is not a Send event. Do not add an arbitrary post-composition timer that swallows the next deliberate Enter. The UI Events draft defines composition events and `isComposing`; native WebView event ordering still needs real platform verification. [W3C UI Events](https://www.w3.org/TR/uievents/#events-composition-key-events)

Store a pre-history snapshot `{draftKey, revision, text, selection}` when entering history. ArrowUp recall remains available on empty input or at the existing caret boundary, but ArrowDown past the newest recall and Escape restore that snapshot, not an empty string. Editing a recalled prompt intentionally promotes it into the draft; later navigation must not overwrite that edit with a stale snapshot. Switching conversation resets only history-browsing state and restores that conversation's saved draft. Scope history source and index to the active conversation/revision. Keep attachments attached to the draft, not to a recalled text-only previous prompt, and show the existing staged context before sending.

Enter, Shift+Enter, Ctrl/Cmd+Enter and slash/mention selection use one documented precedence; preserve ordinary newline and menu behavior. Composition guards also apply to Edit & fork and denial-reason inputs before their submit actions. Existing Shift+Tab mode cycling remains a separate, visible posture action and must not run during composition or change a frozen launch operation. GUI owns a discoverable keyboard alternative and focus treatment; this packet does not silently alter the permission model.

**Future ownership:** Flow owner: `composer/buildComposerKeyboardHandler.ts`, `Composer.tsx` behavior, relevant inline input handlers in `MessageList.tsx`/`PermissionPrompt.tsx`, focused keyboard/composer tests. Shared helper types live with F2, not duplicated in a visual component. GUI's later lease adds accessible names/help/focus styles without changing precedence.

**Acceptance:** Synthetic composition Enter/Arrow/Tab produce no submit/history/mode action; deliberate Enter after composition sends once. Native Japanese and Chinese candidate confirmation on Windows and Mac must retain text and not send prematurely. A multiline draft/caret/selection survives Up→Down and Up→Escape; edited recall remains intentional; switching threads while browsing history restores the correct draft. Existing slash/mention and multiline shortcuts still work.

## Shared-file serialization and integration order

Future owners are roles, not concurrent permission to edit the same files:

1. **Runtime owner and shared-schema coordinator** land contract types/commands and inert compatibility reads first: runtime journal, requested/resolved execution binding, operation IDs, epoch/cancel/summary, asset/revision/resource-ref wire schema. Runtime owns domain definitions, validators and commands. The coordinator alone owns `src/lib/tauri.ts`, generated schema/tests, `src/types/agent-conversation.ts`, Rust registration and cross-language exports. Flow requests precise changes through those owners and does not hand-edit generated DTOs.
2. **Flow behavior owner** lands pure identity/draft/search/history/navigation helpers and tests. It then leases `agentTaskStore.ts`/persistence with runtime owner, followed by `AgentsView.tsx`, `Composer.tsx`, `ActionButtons.tsx`, `AgentSidebar.tsx`, `AgentChatPane.tsx`, `MessageList.tsx` and attention components in small serialized groups. Each lease names files and ends with a diff/test summary. It must preserve the GUI owner's already-landed edits.
3. **GUI appearance owner** applies approved typography/scale/action targets/responsiveness to those same components after the behavior lease is released, consuming shared selectors/actions. `appearanceStore` stays separate; theme stays `appStore`. It does not reimplement draft lifetime, launch pending state, project grouping, search or attention routing.
4. **Root integrator** serializes `App.tsx`, cross-surface handoffs, common status consumers, compatibility launch callers, `vitest.config.ts`, shared E2E setup and quality-gate scripts. Packet owners may add isolated fixture/spec files, not concurrent edits to the global mock registry.

Suggested dependency order: F1 fail-closed, F2A identity-scoped session drafts and F8 composition protection first; identity/schema seams; F2B durable drafts/assets; F4 transaction (text-only integration may precede F2B); F3 preserved history/fork execution after runtime binding/resource admission; F5 contextual navigation; F7 reader/search; F6 final exact-target/return wiring. F6 can deliver basic exact request focus earlier with temporary in-memory anchors. No packet waits for model benchmarking or a new provider integration. Native release claims wait for N1 diagnosis and whole-journey proof.

## Verification and future gates

No commands below were run for this documentation task. Tests are future implementation requirements. Use disposable repositories/fixtures and fake/echo providers; do not mutate saved user conversations, spend tokens or contact an SSH host merely to run automated gates.

**Meaningful unit/DOM contracts:** Pure tests cover identity normalization, operation idempotency/fences, revision-aware draft consumption, asset references, search result IDs/ranges and history transitions. DOM tests render production components and stores through delayed/failing IPC, switch A/B, open attention during review, and exercise actual keyboard/focus. Assert that no forbidden start/write occurs and that preserved data can be reopened; avoid tests that only restate CSS or helper implementation.

Existing entry points to extend are `src/lib/__tests__/launchConversation.test.ts`, `src/stores/__tests__/agentDraftStore.test.ts`, `src/components/agents/composer/__tests__/Composer.test.tsx`, `src/components/agents/composer/__tests__/buildComposerKeyboardHandler.test.ts`, `src/components/agents/review/__tests__/ReviewBar.test.tsx` and handoff tests. Add production-path focused files for launch operations, project identity, history revisions, exact attention and reader navigation as needed. Tests needing DOM must match `DOM_TEST_GLOBS` in [vitest.config.ts](../../vitest.config.ts); a per-file environment comment is insufficient.

**Browser journey:** Add `e2e/agents-flow.spec.ts` with an isolated harness under `e2e/harness/` and scoped IPC fixtures. Run start→prepare failure/retry/cancel→chat switch→attachment send→permission during review→search historical turn→fork/rewind preview→Workspace Git ending→Flight brief→return/archive. Include delayed operations, response loss and restart hydration. A Chromium harness proves frontend behavior against mocked IPC, not native Git/SSH/process cancellation or Mac IME.

**Backend fault cases:** Runtime owner tests prepare repeat/conflict, cancel at each journal boundary, crash after directory creation, crash after dispatch intent, stale epoch, unavailable remote host, changed pin, duplicated sidecar acknowledgment, failed save and active asset/resource references. Use the production journal/admission path and disposable real Git repositories. A mocked `Promise` test alone cannot establish backend idempotency.

**Focused commands after relevant implementation:**

```text
pnpm exec vitest run src/lib/__tests__/launchConversation.test.ts src/stores/__tests__/agentDraftStore.test.ts
pnpm exec vitest run src/components/agents/composer/__tests__/Composer.test.tsx src/components/agents/composer/__tests__/buildComposerKeyboardHandler.test.ts src/components/agents/review/__tests__/ReviewBar.test.tsx
pnpm exec playwright test e2e/agents-flow.spec.ts --project chromium --workers=1
pnpm gates:changed
```

Run the new packet test paths in addition to those existing suites. Once integrated, root runs the appropriate `gates:full`, including generated Tauri schema parity and Rust gates when bindings/runtime change. Follow repository gate definitions; do not use an installer build as an accidental dependency install or paid-provider smoke test. Exact focused Rust test names belong to the runtime owner's implementation, not invented names in this plan.

**Native acceptance:** After root isolates N1, record OS/app/source/executable hash, provider/transport fixture, window/text scale and input method. On installed Windows verify manual navigation separately from accessibility automation; capture evidence before restarting a hung process. On available Mac verify the same journey, actual IME event sequence, keyboard focus and native paste/drop/restart. Keep local and pinned SSH acceptance separate; live SSH tests require the authorized disposable host. No automatic native/parity pass is inferred from DOM/Chromium results. Model-call quality and priced spend are outside these deterministic flow gates.

**Owner dogfood proof:** Record task-scoped counts of duplicate starts, lost drafts/attachments, wrong execution scope, unresolved starts, attention targets reached, search target correctness and restoration failures. Use content-free operation IDs/timings with local consented evidence, not prompt/image uploads. Compare ordinary owner tasks before/after without inventing percentage gains. P1 flow acceptance requires zero observed scope fallback, original-history loss or cross-project attachment transfer in the defined fixtures; it is not a claim of zero possible defects.

## Rollout and recovery

- Ship F1 fail-closed and F8 input guards independently when their focused regressions pass. Do not retain silent root fallback as a rollback option.
- Add schemas/commands behind additive reads before enabling new UI writes. Snapshot legacy draft metadata and conversation revisions through existing persistence, with explicit migration version/state. Never run a broad rewrite of real histories to manufacture lineage.
- Enable F2/F4 first for local disposable fixtures, then owner local projects; SSH checkout execution and remote isolation have separate capability gates. An unavailable backend reports a blocker rather than falling back to the old fire-and-forget start.
- Gate fork execution on resource ownership/writer admission and checkpoint fidelity. Until available, users can safely prepare a child draft and inspect the unchanged original. Do not turn a known incomplete checkpoint into an exact-resume claim.
- Visual rollout follows the serialized behavior changes. A UI regression can switch back to the prior presentation while retaining new journal/draft/revision schemas and readers. Disable creation of new affected intents; let existing operations remain inspectable/cancellable through a compatible control surface.
- Revert by compatible versioned code, not by deleting journal rows/assets/revisions or downgrading them to old text strings. Cancelled/unknown operations and retained work remain visible until reconciled. Rollback must not rerun queued submissions, force-remove worktrees or relabel semantic continuation typed.
- Root records gate results and native limitations in the implementation evidence. This proposal itself is not shipped history and should not be added to `CHANGELOG.md` as completed work.

## Primary references used for this design

The source audit and parent report provide product evidence. The additional public references below support narrow platform semantics; they do not establish Codex/native parity or provider entitlement:

- [W3C UI Events, composition key events](https://www.w3.org/TR/uievents/#events-composition-key-events), retrieved 2026-10-19/20 UTC: guard application shortcuts during composition; verify actual WebView ordering. The linked UI Events specification is a working draft.
- [W3C File API, Blob URL creation/revocation](https://www.w3.org/TR/FileAPI/#creating-revoking), retrieved 2026-10-19/20 UTC: preview URLs have lifecycle, not durable attachment identity.
- [WAI APG modal-dialog pattern](https://www.w3.org/WAI/ARIA/apg/patterns/dialog-modal/), retrieved 2026-10-19/20 UTC: confirmation-dialog focus and return behavior; ordinary attention navigation remains nonmodal.
