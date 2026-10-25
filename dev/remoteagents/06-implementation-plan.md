# 06 - Implementation Plan

## Current checkpoint — 2026-10-24

Remote Agents resumes **after desktop/runtime completion and acceptance**.
The later October 24 owner instruction supersedes the earlier first-priority
order. Use [the desktop exit gate](../agent-experience/08-desktop-completion-before-remote-agents.md),
[current status](../current-status.md), the
[documentation audit](../documentation-audit-2026-10-24.md) and
[backlog](../../backlog.md) for live ordering; the sprints below are the
accepted design/checkpoint structure, not a fresh gate run or deployment claim.

PacketBench `922ddcc9` still has a static PWA and a desktop gate with all eleven
private-beta requirements unmet. Sprint 0 foundations were committed in
`d6238633`; the later fail-closed gate and close-code contract are in
`f7200bfb` and `bf32f2b5`. Sibling `packetrelay@74ffc10` includes the Sprint 1
identity/ACL/columnar-audit persistence foundation from `522687a`, but its
feature-gated HTTP/socket routes still return 501 rather than serving auth or
presence. Thus **Sprint 1 data substrate is partial; transport, host presence
and product auth are not implemented**. Do not erase that substrate or call
the whole Sprint 1 slice complete.

The September Railway/PostgreSQL evidence is historical. Later pre-existing
dirty/untracked sibling operator records describe a datacenter deployment and
deletion of the former Railway/database; current live topology, database and
backup readiness were not checked. See the dated note in
[02-architecture.md](./02-architecture.md#deployment-target-railway).

After that desktop gate, resume in this order. Extend the existing
`D:/projects/packetrelay` service, preserving legacy protocol compatibility:

1. Accept the bounded replay/ACK/high-water recovery, ticket reserve/finalize,
   signed hello and endpoint-to-endpoint E2EE contracts in
   [11](./11-transport-contract-decisions.md), with cross-runtime negative
   fixtures. Keep auth lifecycle/retention migrations behind their own review.
2. Reuse the committed persistence foundation and implement one internal-only
   dev-auth ticket → desktop connect → PWA host-online → revoke/offline slice.
   Respect terminal close codes, Origin/ACL checks and bounded reconnect. Any
   internal prototype path must be separate from the production gate; do not
   mark unmet beta requirements met merely to test it.
3. Add capability snapshots and a backend-owned remote conversation service
   through the existing runtime/authority/persistence seams, then mobile
   stream/approval/reconnect. Do not build another executor or a generic Tauri
   proxy because the phone cannot own a React store.
4. Complete owned product auth/recovery, E2EE, the required security review,
   trust/revocation, redacted audit, push/artifacts and tested datastore
   durability before external beta.
   Reconcile the deployment record and prove the selected environment rather
   than carrying forward September health/backup assumptions.

No source, tests, builds, provider calls, remote accounts or deployments were
changed or exercised for this documentation reconciliation.

## Sprint Structure

The work is sized for a six-agent implementation team. Sprints are written as checkpoints rather than calendar promises. If the team starts tomorrow, Sprint 0 and Sprint 1 can run in parallel after a kickoff.

This sizing predates 2026-08-27, when the relay became PacketBench-owned with
Remote Agents as its only consumer. The relay work below (control plane,
PostgreSQL state, replay, audit, Web Push) is now wholly funded by this
program rather than shared with another; re-cut the sprint plan if that
changes the capacity available. See `10-pause-record.md` §1.3.

## Sprint 0 - Foundations And Decisions — COMPLETE 2026-09-01

Goal: lock protocol, repo layout, feature flag, and team contracts.

Deliverables:

- Create `remoteagents/shared` with protocol schemas.
- Create `remoteagents/pwa` skeleton.
- Add a feature-isolated PacketBench protocol/control-plane skeleton to the
  standalone Rust repo at `D:\projects\packetrelay`.
- Add desktop feature flag: `remoteAgents.enabled`.
- Add docs link from `dev/README.md`.
- ~~Decide auth provider build-vs-buy for v1.~~ **Resolved 2026-08-28: build.**
  Passkey/magic-link in the Rust relay on PostgreSQL. Sprint 0 is no longer
  gated on an owner decision, but it now carries the owned surface —
  WebAuthn ceremonies, session lifecycle, magic-link delivery, recovery and
  device loss, rate limiting and enumeration resistance — plus a security
  review before external beta. Size it accordingly; see
  `09-open-decisions.md` § Auth Provider.
- Decide encryption launch gate: plaintext internal only, encrypted private
  beta. **Resolved 2026-08-16**; carry it forward rather than re-deciding.
- Provision the relay's Railway service and its managed PostgreSQL instance,
  and answer the four deployment verifications in `02-architecture.md`
  § Deployment target (edge WebSocket lifetime, deploy-time instance overlap,
  managed-PostgreSQL durability, region). Record the answers in
  `09-open-decisions.md`.

Current state (2026-09-01): the shared protocol package, PWA skeleton, workspace
build wiring, feature-gated relay route/protocol skeleton, isolated desktop
feature flag, and six-agent ownership map exist. `pnpm remoteagents:check`, the
three focused desktop flag tests, and PacketRelay's 57-test `remote-agents`
feature suite pass. Railway-managed PostgreSQL is live over private
`DATABASE_URL`; both services are in `us-west2`; the `/ready` health check uses
a 30-second timeout; the final IaC plan is clean. Source deployment
`471c18b3-dcc1-49d4-8629-facc7a02b73b` passed `/health`, `/ready`, and legacy
WSS smoke while `/ws/host` remained feature-off (`404`). Sprint 0 is complete.
Remote Agents remains disabled/fail-closed, and Sprint 1/auth has not started.

Checkpoint:

- [x] Shared protocol package builds.
- [x] `packet-relay` starts locally with its existing protocols intact and the
      PacketBench routes feature-gated.
- [x] `packet-relay` deploys to Railway from `.railway/railway.ts` and passes an
      HTTPS health check plus a real WSS upgrade.
- [x] PWA dev server starts.
- [x] Desktop compiles with remote feature flag off.
- [x] Six-agent ownership map is posted in `07-six-agent-runbook.md`.

## Sprint 1 - Relay And Host Presence

Goal: desktop and PWA can sign into dev auth, connect to the relay, and see host presence.

Rust relay (`D:\projects\packetrelay`):

- HTTPS control-plane and `/ws/host` + `/ws/device` routes.
- In-process host-room router.
- PostgreSQL migrations for accounts, hosts, devices, ACL, tickets, replay, and audit.
- WebSocket upgrade auth.
- Heartbeats.
- Host online/offline state.
- Existing bridge/broadcast/room compatibility tests remain green.

Desktop:

- `remote_agents` module.
- Outbound WebSocket client.
- reconnect/backoff.
- host registration.
- status Tauri commands for UI.

PWA:

- sign-in mock or dev auth.
- host list.
- connection state.

Checkpoint:

- Desktop connects outbound to relay.
- Phone/PWA sees host online.
- Killing desktop marks host offline.
- Revoked/unauthorized device cannot subscribe.

## Sprint 2 - Provider/Workspace/Profile Snapshots

Goal: phone can see what the desktop can run.

Desktop:

- backend provider/model snapshot exported from current provider catalog.
- provider auth statuses from `get_provider_auth_status`.
- workspace/project snapshot.
- profile snapshot.
- remote status card in PacketBench Tools/Settings.

Rust relay:

- route encrypted or plaintext dev snapshots.
- cache metadata snapshot for fast host list display.

PWA:

- provider/model/profile/workspace picker.
- auth badge rendering.
- incompatible/offline states.

Checkpoint:

- PWA can pick a real desktop workspace and provider/model.
- Missing auth displays correctly.
- No secret fields are present in relay logs or PWA devtools.

## Sprint 3 - Backend Conversation Service

Goal: conversations created from phone are first-class PacketBench conversations.

Desktop:

- `RemoteConversationService`.
- create remote API conversation.
- persist remote-created conversations.
- emit local desktop state events.
- forward `api-agent:*` events to remote.
- support send/cancel/retry/model changes.
- route mobile approval responses.

Frontend desktop:

- React store hydrates remote-created conversations.
- selected conversation can be opened on desktop.
- remote-created runs show in sidebar/history.

Checkpoint:

- PWA starts conversation.
- Desktop Agents sidebar shows it.
- Assistant stream appears on both desktop and PWA.
- Cancel from PWA stops desktop run.
- Sending from desktop updates PWA.

## Sprint 4 - Mobile Conversation UX

Goal: usable PWA MVP chat and approval loop.

PWA:

- Needs Me tab.
- Active tab.
- New Agent flow.
- Conversation screen.
- compact event cards.
- approval cards.
- cancel/retry.
- reconnect and replay.
- IndexedDB cursors/drafts.

Rust relay:

- replay buffer.
- sequence assignment.
- cursor ack.
- slow-client handling.

Checkpoint:

- User can start a run from phone, lock phone, reopen, and resume stream.
- Permission request triggers Needs Me.
- Approval from phone unblocks desktop agent.
- Duplicate reconnect does not duplicate prompts.

## Sprint 5 - Push, Audit, Security Hardening

Goal: private-beta safety baseline.

Rust relay:

- Web Push subscriptions.
- durable notification outbox and bounded Rust sender task.
- audit log.
- rate limits.
- origin validation.
- ACL enforcement tests.
- revocation disconnect.

Desktop:

- trusted device approval UI.
- revoke device UI.
- kill switch.
- local audit viewer.

PWA:

- push permission UX.
- notification deep links.
- account/device settings.

Security:

- payload encryption implemented or feature gated before private beta.
- token rotation.
- object-level auth tests.

Checkpoint:

- New phone cannot control host until desktop approval.
- Revocation stops active WebSocket and future commands.
- Push notification opens correct conversation.
- Audit row exists for every mutating command.

## Sprint 6 - Beta Polish And Release

Goal: reliable private beta.

Deliverables:

- protocol docs generated from schemas
- relay load test
- mobile browser matrix complete
- failure-mode runbook
- release checklist
- staged deploy to Railway
- beta allowlist

Checkpoint:

- 30-minute remote session with disconnects passes.
- iOS Home Screen PWA approval flow passes.
- Android installed PWA approval flow passes.
- Desktop local use unaffected when relay disabled.

## Acceptance Test

A user with PacketBench desktop running on Windows signs into Packet Cloud,
enables Remote Agents, opens the PWA on iPhone, signs in, requests access,
approves on desktop, starts an `api-openai-agents` or `api-claude-oauth`
(historical id for the API-key-backed Claude Agent SDK row) conversation against
`D:\projects\PacketBench`, receives streaming output, approves one risky tool,
cancels or completes the run, and then opens the same conversation on desktop.

Pass criteria:

- provider/model list matches desktop
- no provider secrets in cloud/PWA logs
- stream appears on phone within 2 seconds of desktop event
- approval unblocks within 2 seconds
- reconnect does not duplicate messages
- audit log complete
- desktop works normally after relay disconnect

## Implementation Risks

### Frontend-Owned Conversation Lifecycle

Risk: phone-created conversations bypass React state.

Mitigation: Sprint 3 must create backend conversation ownership and desktop update events before PWA chat deepens.

### Provider Catalog Duplicated In Frontend

Risk: PWA gets stale provider/model list.

Mitigation: backend-export provider snapshot and generate shared types.

### PWA Background Limits

Risk: iOS kills socket in background.

Mitigation: push notifications wake user, reconnect/resume on open.

### Cloud Sees Content

Risk: relay sees prompts/code before encryption.

Mitigation: internal-only plaintext allowed, encrypted payloads required for external beta.

### Sidecar Provider SSH Gap

**Dated correction 2026-10-24:** The risk wording below predates the existing
SSH sidecar implementation. Current `commands/api_agent.rs` routes sidecar
sessions through its SSH path, and the AGENTS/sidecar contract requires pinned
host identity and the compatible remote handshake. The surviving real-provider
and packaged SSH matrix is in
[sidecar-over-ssh-verification.md](../sidecar-over-ssh-verification.md).
Project capability/host/auth checks and the recorded proof boundary still
matter; do not disable all sidecar SSH options based on this old blanket claim.
The following paragraph is retained as the original risk record.

Risk: sidecar providers cannot run SSH execution today.

Mitigation: PWA displays capability. Use API-key providers for SSH until sidecar SSH support exists.

### Large Diffs/Attachments

Risk: mobile and relay choke on large payloads.

Mitigation: preserve the relay's 64 KiB inline ceiling, use encrypted
`artifactId` references for larger content, and render mobile summaries first.
