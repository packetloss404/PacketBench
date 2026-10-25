# 07 - Six-Agent Runbook

> **Historical Sprint 0 ownership map; clarified 2026-10-24.** Its publication
> completed a Sprint 0 planning checkpoint, not the later implementation or
> deployment gates. Use [current status](../current-status.md), the
> [documentation audit](../documentation-audit-2026-10-24.md), and
> [backlog](../../backlog.md) before assigning work. Roles remain useful, but
> refresh file ownership and dependencies against current source. Auth was
> resolved in favor of owned passkey/magic-link on August 28; choosing an auth
> provider is not new work. Railway observations are historical and later
> local sibling operator records require reconciliation; this runbook does
> not prove or choose a current deployment. The security review is required
> before any external beta, not only public beta.

This is the kickoff plan and posted Sprint 0 ownership map for a six-agent team.
Each agent owns a separate write area to reduce conflicts. Its publication
satisfies the ownership-map item in the Sprint 0 checkpoint.

## Ground Rules

- Read all docs in `dev/remoteagents` before coding.
- Do not expose raw Tauri invoke over the relay.
- Do not send provider secrets to cloud or PWA.
- Keep protocol changes in shared schemas first.
- Every mutating remote command needs idempotency.
- Every relay route/message needs auth and object-level authorization.
- Route production Remote Agents operations through the fail-closed
  `remoteAgentsGate` authority (`assertRemoteAgentsEnabled` at effectful
  boundaries). Persisted `remoteAgents.enabled` is user intent only and cannot
  bypass its eleven unmet requirements. Any separate internal prototype path
  must remain compile/runtime-isolated from external builds; do not mark beta
  gates met merely to test a prototype.
- Keep MVP API-agent only.

## Agent 1 - Rust Relay And Data

Owns:

- the sibling `D:\projects\packetrelay` repository
- PostgreSQL migrations
- in-process host-room router
- durable outbox workers
- relay test harness

Tasks:

- Feature-isolated PacketBench module in the existing Rust service.
- Host-room router with host/device sockets.
- Auth middleware stub.
- Host registration.
- Device subscription.
- Routing and replay buffer.
- PostgreSQL tables and migrations.
- Audit insert path.
- Revocation disconnect.
- Regression coverage for existing bridge/broadcast/room clients.

First checkpoint:

- fake desktop and fake PWA can connect and exchange envelopes through a host room.

## Agent 2 - Desktop Remote Gateway

Owns:

- `src-tauri/src/commands/remote_agents`
- desktop relay client
- desktop remote status command registration
- Tools/Settings status card backend bindings

Tasks:

- remote config/state.
- outbound WebSocket manager.
- reconnect/backoff.
- host registration payload.
- relay command dispatcher.
- local kill switch.
- status events to frontend.

First checkpoint:

- PacketBench desktop connects to fake relay and shows connected/disconnected state.

## Agent 3 - Backend Conversation Service

Owns:

- `src-tauri/src/commands/remote_agents/conversation_service.rs`
- changes needed in `src-tauri/src/commands/api_agent.rs`
- conversation persistence integration
- local desktop events for remote-created conversations

Tasks:

- backend create-conversation method.
- backend send/cancel/retry/set-model wrappers.
- map mobile launch modes to PacketBench API-agent config.
- persist snapshots.
- fan out `api-agent:*` events to remote service.
- bridge approval responses.

First checkpoint:

- fake relay command starts a real API-agent conversation and desktop UI can see it.

## Agent 4 - PWA

Owns:

- `remoteagents/pwa`
- PWA app shell
- service worker
- mobile UX components

Tasks:

- Vite/React PWA scaffold.
- auth shell.
- host list.
- New Agent flow.
- conversation view.
- event reducer.
- approval cards.
- reconnect state.
- IndexedDB cursors/drafts.

First checkpoint:

- PWA can connect to fake relay, render host list, and display a simulated stream.

## Agent 5 - Security/Auth

Owns:

- auth design implementation across relay/PWA/desktop
- token validation
- device approval/revocation
- payload encryption spike
- security tests

Tasks:

- implement the resolved owned passkey/magic-link auth lifecycle, including
  recovery and its required pre-external-beta security review; do not reopen
  the resolved provider decision implicitly
- PKCE desktop sign-in.
- trusted device ACL.
- revocation.
- WebSocket origin and authorization checks.
- encrypted payload proof-of-concept.
- audit schema review.

First checkpoint:

- untrusted device cannot access host; approved device can; revoked device is disconnected.

## Agent 6 - QA, Protocol, Docs, Release

Owns:

- `remoteagents/shared`
- protocol schemas/tests
- integration test harness
- Playwright PWA tests
- release runbooks
- docs upkeep

Tasks:

- shared TypeScript protocol schemas.
- sample envelopes.
- contract tests.
- fake relay/fake desktop/fake PWA simulator.
- E2E scenarios.
- update docs as decisions land.
- final checklist.

First checkpoint:

- one command validates against the shared schema in Rust relay, PWA, and desktop tests.

## Parallelization Plan

Day 1:

- Agent 6 creates shared protocol package first.
- Agent 1 starts the isolated Rust relay module using the draft protocol.
- Agent 2 starts desktop module behind flag.
- Agent 4 starts PWA shell with mocked protocol.
- Agent 5 starts auth/ACL threat model and dev-auth stub.
- Agent 3 maps current conversation lifecycle and creates backend service skeleton.

Day 2:

- Agent 1 and 2 connect real desktop to dev relay.
- Agent 4 connects PWA to dev relay.
- Agent 3 gets fake remote command to start local conversation.
- Agent 5 wires device approval stub.
- Agent 6 adds relay simulator and contract tests.

Day 3:

- End-to-end stream from real desktop to PWA.
- Approval response from PWA to desktop.
- Reconnect/resume baseline.
- Audit rows.

Day 4:

- Push notifications.
- Security hardening.
- Mobile polish.
- Failure-mode tests.

Day 5:

- Private-beta candidate.
- Manual iOS/Android checks.
- Docs/runbook updates.

## Sprint 0 Kickoff Checklist

1. Assign owners and branches.
2. Carry forward the resolved in-house auth direction: passkey/magic-link in
   the Rust relay on PostgreSQL. A dev identity scaffold is acceptable for
   internal smoke tests but is not the product auth implementation.
3. Confirm the Railway service/project naming, the managed PostgreSQL
   instance, and domain placeholders (deployment target resolved 2026-08-27;
   see `02-architecture.md` § Deployment target).
4. Freeze Sprint 1 protocol field names.
5. Create the integration branch, recommended `codex/remote-agents-integration`.
6. Create the `remoteProtocolVersion = 1` fixture package.
7. Use the resolved in-repository PWA location at `remoteagents/pwa`.
8. Start with mocked crypto for smoke only while real E2EE test vectors are built.
9. Create a fake desktop and fake PWA simulator so relay/PWA/desktop lanes can test independently.
10. End the meeting with one visible target: "trusted PWA sees desktop host online."

## Merge Order

1. Shared protocol schemas.
2. Rust relay PacketBench skeleton.
3. Desktop feature flag and no-op remote module.
4. PWA skeleton.
5. Host presence.
6. Provider/workspace/profile snapshots.
7. Backend conversation service.
8. Event fanout.
9. Approvals.
10. Push/audit/security hardening.

## Coordination Checkpoints

Twice daily:

- protocol changes
- schema version changes
- auth/ACL assumptions
- desktop command surface changes
- PWA UX blockers
- test failures

No agent should change another agent's ownership area without a handoff note.

## Definition Of Done

A story is done when:

- feature flag behavior is correct
- happy path works
- at least one negative/security test exists for auth-sensitive behavior
- logs redact content
- errors have stable codes
- docs are updated if behavior differs from this plan

## PR Boundaries

Good PR slices:

- cloud registry endpoints only
- relay host/device socket only
- desktop keyring/host identity only
- desktop approval modal only
- PWA sign-in/desktops screen only
- protocol schema package only
- E2EE test vectors only

Avoid:

- giant PRs spanning cloud, desktop, and PWA
- UI PRs that alter auth semantics
- protocol changes without fixtures
- desktop bridge changes without command authorization tests
