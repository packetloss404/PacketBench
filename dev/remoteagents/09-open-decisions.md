# 09 - Open Decisions

Program retained; **implementation follows desktop/runtime completion and
acceptance** under the owner's later October 24 instruction. The August
16–27 pause/resumption remains historical. See [`10-pause-record.md`](./10-pause-record.md).

## Current reconciliation — 2026-10-24

Remote Agents now follows the desktop completion gate. The
[current-status map](../current-status.md),
[documentation audit](../documentation-audit-2026-10-24.md) and
[backlog](../../backlog.md) own current ordering/status. The decision log below
is retained; a dated observation is not proof of the environment today.

**Auth and product scope are unchanged:** owned passkey/magic-link auth,
mandatory pre-beta E2EE, PWA first, API-agent-only control, desktop execution,
and the sibling Rust relay remain the recorded owner decisions. Do not reopen
them merely because implementation resumed.

**Deployment record requires reconciliation, not a silent decision change.**
The August Railway target and September managed-PostgreSQL verifications below
are historical. A read-only source audit found the sibling at committed
`74ffc10`, with pre-existing dirty `README.md` and untracked `deploy/`
operator records describing a later datacenter deployment and September 14
deletion of the old Railway project/database. They say the default relay uses
no PostgreSQL and Remote Agents stays off. These are later local records,
not a verified live topology or a newly ratified deployment decision. Current
service/database/backups/cost remain unverified; reconcile that evidence before
the next infrastructure task. The Rust relay choice is independent of hosting.

**Implementation status is more precise than “Sprint 1 not started.”**
Sibling commit `522687a` (2026-09-02), present at `74ffc10`, implements the
initial identity/ACL/redacted-audit repository and migration. It excludes
auth/tickets/replay/outbox, and the feature-on server still returns 501.
Desktop transport/PWA presence/product auth remain unimplemented in the
PacketBench `922ddcc9` source. Existing test files were inspected, not rerun;
the real-PostgreSQL repository test skips without its explicit test URL.

## Locked Decisions

### Primary UX

Use cloud sign-in as the main flow. Do not use QR as primary pairing. QR may be a later convenience link.

### Execution

Desktop PacketBench owns execution. Cloud relay does not call providers or run tools.

### MVP Platform

PWA first. Native iOS/TestFlight later.

### MVP Runtime Scope

API agents only. Raw PTY remote control is not in MVP.

### Transport

WebSocket relay for real-time control. Web Push for notifications only.

### Relay Architecture

Use the standalone Rust service at `D:\projects\packetrelay`. Extend it with
PacketBench-specific HTTP/WebSocket routes, PostgreSQL persistence, durable replay
and outbox processing, Web Push, audit, and object-storage references. Do not
build a second relay on Cloudflare.

### Code Location

The relay remains an independently built/deployed sibling repository at
`D:\projects\packetrelay`. Shared protocol schemas and the PWA begin under
PacketBench's `remoteagents/` workspace so desktop and mobile can evolve in
lockstep. Contract fixtures gate changes across both repositories.

### Relay Ownership — RESOLVED 2026-08-27

PacketRelay is PacketBench's infrastructure. It is no longer shared with, or
driven by, Syndicate, which was separated from the Packet\* product family on
2026-08-27 (its PacketBench execution-target integration was removed in commit
`68ce85ee`). **Remote Agents is the relay's only consumer**, and therefore
carries 100% of its build and run cost — previously shared against Syndicate's
value. The sprint sizing in `06-implementation-plan.md` predates that
reweighting.

### Relay `/v1/product-route` disposition — RESOLVED 2026-08-28

**Cut it.** The owner confirmed on 2026-08-28 that `/v1/product-route` is
**not serving live traffic** — correcting the earlier record, which described
it as a live Syndicate deployment and on that basis ruled the route untouchable
by this program. With no consumer, there is nothing to preserve a compatibility
contract for and nobody to hand it to.

Scope of the cut: the dedicated `/v1/product-route` boundary, crypto/protocol
modules and document, routing classification, reserved connection pool, and
product-only dependencies. Remote Agents adds its own `/ws/host` and
`/ws/device` routes; it does not preserve the removed product route.

**DONE 2026-08-28** — executed in the relay repo as `b2bcff5` on
`packetrelay@main`. Removed: `src/product_route.rs`, `src/product_crypto.rs`,
`PRODUCT_ROUTE_PROTOCOL.md`, the shared crypto fixture, the
`RequestRoute::Product` classification and its reserved connection pool, the
`--product-connection-reserve` flag, and the five crates only that code used
(`aes-gcm`, `ed25519-dalek`, `hkdf`, `x25519-dalek`, `zeroize_derive`). Relay
tests 61 → 53, strict Clippy and `cargo fmt --check` clean.

**Scope correction made during execution.** Earlier planning said the cut also
covered "the bridge/broadcast/room compatibility modes that exist only to serve
it." That was wrong. Bridge, broadcast, and room are a _separate inherited
lineage_ (`jarvis-room-hello-v1`, with external clients of its own), not part
of the product route. They were left untouched. Do not treat them as
condemned by this decision.

The Google Cloud Run deployment path went with it — `cloudbuild.yaml`,
`deploy.sh`, `scripts/smoke-cloud-run.py`, and the README's live-deployment
section.

### Relay Deployment Target — RESOLVED 2026-08-27

Read this section as the dated decision/verification record. The October 24
note above qualifies all present-tense deployment/database claims below; it
does not rewrite or silently supersede the owner decision.

**Railway.** This replaces the Google Cloud Run deployment the relay ran while
it served Syndicate. The relay's repository configuration migrated locally
from deprecated `railway.json` to `.railway/railway.ts` on 2026-09-01; its
validated service graph builds the root `Dockerfile`. Production cleared the
legacy Config File setting, added Railway-managed PostgreSQL, injected its
private `DATABASE_URL`, placed both services in `us-west2`, and configured
`/ready` with a 30-second health-check timeout. The final IaC plan is clean.
Railway canonicalizes default-equivalent restart fields out of the desired
graph; the live manifest retains `ON_FAILURE` with ten retries.
`cloudbuild.yaml` and `deploy.sh` are the retired Cloud Run path.

This does **not** reopen the 2026-08-02 relay-architecture decision — the relay
is still the Rust service and Cloudflare is still rejected. Railway answers
_where the chosen relay runs_, which that decision never fixed.

Deployment-behavior questions were verified on 2026-09-01 and are recorded in
`02-architecture.md` § Deployment target: Railway documents indefinite WSS
connections even when idle; default deploy overlap is `0` and configurable;
both services run in `us-west2`; and the current single-node PostgreSQL with
PITR off is not sufficient for external beta until PITR, scheduled volume
backups, and an offsite logical-dump restore drill are in place. The live legacy
WSS smoke passed, and the final IaC plan is clean.

## Open Decisions

### Auth Provider — RESOLVED 2026-08-28

**Decision (owner, 2026-08-28): build it ourselves.** Passkey/magic-link auth
in the Rust relay backed by PostgreSQL — the third option on the menu below.
The owner explicitly accepted the ownership burden that comes with it.

This unblocks Sprint 0. It was the sole blocking decision: blocking when the
program was paused on 2026-08-16, demoted to "first action of the pickup
runbook" while paused, reverted to blocking when the program resumed on
2026-08-27, and answered on 2026-08-28.

**What this commits us to owning**, recorded here so it is not rediscovered
mid-sprint: the WebAuthn registration and assertion ceremonies including
attestation handling and credential storage; session design — issuance,
lifetime, refresh, and revocation across desktop and PWA; the magic-link
channel and its email delivery, expiry, and single-use guarantees; account
recovery and the device-loss path, which is where hand-rolled auth usually
fails; rate limiting and enumeration resistance on every entry point; and a
security review of all of it before external beta. None of these are optional,
and the last one gates the beta alongside the E2EE requirement.

**Interaction with the E2EE gate** (RESOLVED 2026-08-16, below, unchanged):
in-house auth does not soften it. TLS terminates at Railway's proxy, so the
hosting provider's edge sits inside the TLS boundary — owning the auth code,
like owning the relay code, is not the same as content being unreadable in the
deployment. Encrypted agent, approval, and file payloads remain a hard gate.

**Not chosen, and why the record matters if this is ever revisited:** the
hosted-SaaS option (Clerk/Auth0/Stytch class) and the self-hosted OSS IdP
option (Keycloak/Zitadel/Ory class) both trade per-user cost or an extra
deployed service for a much smaller owned surface. If in-house auth proves
more expensive than expected — most likely at recovery or at the security
review — those remain live alternatives, and the vendor field should be
re-surveyed at that point rather than reusing the two-month-old comparison.

A compile/runtime-gated dev identity provider for internal smoke tests is
still appropriate for the internal prototype phase and is not superseded by
this decision; it is the scaffold, not the product.

The original menu, retained as the record:

- hosted SaaS identity provider (Clerk/Auth0/Stytch class): vendor runs
  sign-in, passkeys, magic links, and recovery; the Rust relay only validates
  tokens. Least owned surface; per-active-user pricing after free tiers.
- self-hosted open-source IdP (Keycloak/Zitadel/Ory class): standard OIDC, no
  vendor or per-user fees, but one more service to deploy, patch, and secure.
- **build passkey/magic-link auth in the Rust relay backed by PostgreSQL —
  fully owned, including the WebAuthn ceremony, session design, recovery, and
  the security review. ← CHOSEN 2026-08-28.**
- compile/runtime-gated dev identity provider for internal smoke tests only

Decision owner: Security/Auth agent, resolved by the owner 2026-08-28.

### Payload Encryption Timing — RESOLVED 2026-08-16

Decision (owner-ratified, 2026-08-16): the written recommendation is adopted as
the launch gate.

- plaintext (TLS-only) is permitted for local/internal development only
- encrypted agent, approval, and file payloads are a hard gate before any
  external private beta

Decision owner: project owner plus Security/Auth agent.

### Backend Conversation Persistence Shape

Options:

- keep opaque JSON conversation files and add remote wrappers
- introduce Rust DTO for `AgentConversation`
- migrate all conversation persistence backend-native

Recommendation:

- MVP: add minimal Rust DTO/snapshot for remote creation and use existing opaque persistence where possible
- Post-MVP: move conversation schema fully backend-native

Decision owner: Desktop Remote Gateway and Backend Conversation agents.

### Native iOS Strategy

Options:

- Swift native
- React Native
- Capacitor wrapper around PWA
- Tauri mobile

Recommendation:

- decide after PWA beta
- evaluate notification, backgrounding, and keychain needs first

Decision owner: project owner after PWA beta.

## Decision Log

Dated record of the Sprint-0 kickoff decisions. Auth was the sole blocking
decision; payload-encryption timing was resolved 2026-08-16. Relay/code
location was resolved by the owner on 2026-08-02; no Cloudflare relay scaffold
should be created. Relay ownership and deployment target were resolved
2026-08-27, the same day the program resumed.

### 2026-08-28 — Auth provider resolved; product-route cut; Sprint 0 unblocked

**Relay `/v1/product-route`** — Resolved. Cut it. The owner confirmed the route
is not serving live traffic, correcting the earlier "live Syndicate deployment"
record that had made it untouchable on this program's authority. Executed in
the relay repo, before the Railway migration. See § Relay `/v1/product-route`
disposition.

**Auth provider** — Resolved. Build passkey/magic-link auth in the Rust relay
backed by PostgreSQL. Fully owned: WebAuthn ceremonies, session design,
magic-link delivery, account recovery and device loss, rate limiting and
enumeration resistance, and a security review before external beta. The owner
explicitly accepted that burden. Hosted SaaS and self-hosted OSS IdP remain the
fallbacks if the cost lands worse than expected; re-survey vendors rather than
reusing the 2026-06 comparison. See § Auth Provider.

**Consequence** — No blocking owner decision remains. Sprint 0 started and
completed on 2026-09-01; Sprint 1/product auth has not started.

**Unchanged** — The E2EE launch gate (resolved 2026-08-16) is not softened by
owning the auth code; TLS still terminates at Railway's edge.

### 2026-08-27 — Program resumed; relay ownership and deployment target

**Program status** — Resumed. The Remote Agents program was unpaused by the
owner after a pause running 2026-08-16 to 2026-08-27. Implementation remains
zero; Sprint 0 is the next step.

**Relay ownership** — Resolved.

- PacketRelay is PacketBench's infrastructure, not shared with Syndicate.
- Remote Agents is its only consumer and carries 100% of its build and run
  cost.
- Syndicate was separated from the Packet\* family on 2026-08-27 and its
  PacketBench execution-target integration was removed (commit `68ce85ee`).

**Relay deployment target** — Resolved.

- Railway, replacing Cloud Run. Does not reopen decision (c) or the
  Cloudflare rejection.
- Follow-on verifications are recorded as open in `02-architecture.md`
  § Deployment target.

**Auth provider** — Reverted to BLOCKING on this date (it had been demoted to a
pickup-runbook step while the program was paused). **Superseded 2026-08-28** —
resolved in favour of in-house passkey/magic-link auth in the relay; see the
entry above.

- Decision owner: project owner, with the Security/Auth agent.

### 2026-08-02 — Rust Packet Relay selected

**Relay architecture and code location** — Resolved.

- Use and extend the standalone Rust service at `D:\projects\packetrelay`.
- Keep PacketBench host/device messages separate from inherited relay protocols.
- Use PostgreSQL for durable account/device/ticket/replay/audit/outbox state.
- Keep live routing single-instance for v1; require explicit coordination work
  before horizontal scaling.
- Keep `remoteagents/shared` and `remoteagents/pwa` in PacketBench initially.
- Cloudflare Workers, Durable Objects, D1, R2, and Queues are not the target
  implementation.

### 2026-06-15 — Sprint-0 kickoff decisions

**(a) Auth provider build-vs-buy for v1** — **Resolved 2026-08-28: build.**

- See "Auth Provider" above for the decision, the owned surface it commits us to, and the retained menu.
- Resolution / date: build in-house passkey/magic-link auth, 2026-08-28.
- Decision owner: Security/Auth agent.

**(b) Payload-encryption launch gate** — Resolved 2026-08-16.

- The written recommendation was ratified by the owner: plaintext for
  local/internal development only; encrypted agent/approval/file payloads
  required before any external private beta.
- Decision owner: project owner plus Security/Auth agent.

**(c) Code location (in-repo `remoteagents/` vs `apps/` vs separate repo)** — Resolved 2026-08-02.

- Relay: standalone `D:\projects\packetrelay` repository.
- PWA/shared schemas: PacketBench `remoteagents/` workspace initially.
- Decision owner: implementation lead.

Note: decision (a) remained BLOCKING through 2026-08-27 and was resolved on
2026-08-28; (b) was resolved 2026-08-16. Decision (c) is closed and must not be
reopened implicitly by creating a provider-specific relay scaffold — naming
Railway as the deployment target on 2026-08-27 does not reopen it.

## Deferred Decisions

- team/org access model
- cloud runner mode
- billing model
- WebRTC/LAN direct mode
- remote PTY policy
- mobile file browser depth
- long-term transcript retention
