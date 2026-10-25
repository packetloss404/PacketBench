# 08 - Testing Plan

## Evidence boundary — 2026-10-24

This is the target test plan, not a record that its matrices have passed. Start
after desktop/runtime completion and acceptance under the owner's later
October 24 sequence; use [the desktop gate](../agent-experience/08-desktop-completion-before-remote-agents.md)
for the current team. For the later Remote Agents team, start
with [current status](../current-status.md), the
[documentation audit](../documentation-audit-2026-10-24.md), and
[backlog](../../backlog.md). No tests/builds, sockets, phones, providers or
infrastructure were exercised for this documentation reconciliation.

At PacketBench `922ddcc9`, `pnpm remoteagents:check` runs the shared envelope
tests and builds the shared/PWA packages. The PWA is a static foundation shell;
its package currently exposes build/dev scripts, not an implemented mobile
auth/socket/approval test suite. Passing that command would not prove a relay
connection, E2EE, product auth, phone backgrounding, push or PostgreSQL.

The sibling committed relay `74ffc10` defaults to no `remote-agents` feature.
Its feature-on routes return 501; the feature-off namespace is closed. Its
identity/ACL/redacted-audit PostgreSQL substrate exists, but
`tests/postgres_persistence.rs` explicitly skips when `TEST_DATABASE_URL` is
absent. Neither a default-feature test run nor a skipped database test proves
the remote feature. Later dirty/untracked deployment records and older
Railway acceptance remain separately scoped evidence, not current live checks.

## Test Philosophy

Remote Agents has three failure classes:

- correctness failures: duplicated prompts, lost chunks, stale state
- security failures: unauthorized device, leaked secret, overbroad command
- mobile reliability failures: reconnect, backgrounding, push, offline

The test plan must cover all three before beta.

## Unit Tests

### Shared Protocol

- valid envelope parses
- unknown version rejected
- unknown mutating command rejected
- missing idempotency key rejected for mutating commands
- oversized payload rejected
- encrypted-required channels enforced in beta mode
- command/event discriminated unions exhaustive

### Rust Relay HTTP/Auth

- auth middleware accepts valid token
- auth middleware rejects expired token
- object-level ACL blocks cross-account host access
- revoked device rejected
- origin validation
- rate limit counters
- audit row generated

### Rust Host Router And Replay Store

- host connect/disconnect
- device connect/disconnect
- route device command to host
- route host event to all trusted devices
- sequence assignment monotonic
- replay after cursor
- replay too old returns snapshot-required
- slow client queue coalesces chunks
- duplicate command id ignored

### Desktop Rust

- remote config load/save
- token storage wrapper
- relay reconnect backoff
- provider snapshot mapping
- workspace snapshot redacts secrets
- remote command validation
- conversation create persists
- approval command routes to existing backend
- revoked device command rejected

### PWA

- event reducer appends chunks
- done marks stream complete
- error marks failed
- duplicate event ignored
- approval card state updates
- offline outbox TTL expires
- host status reducer

## Integration Tests

### Fake Relay Harness

Create a local test harness:

```text
fake-pwa <-> packet-relay dev <-> fake-desktop
```

Scenarios:

- connect host and device
- unauthorized device denied
- device approval
- start conversation command
- stream chunks
- permission request and approval response
- pending edit and reject
- cancel active run
- reconnect device and replay
- reconnect host and continue
- duplicate send does not duplicate prompt

### Real Desktop With Fake Provider

Use a deterministic provider or echo provider:

- start from PWA
- stream known chunks
- emit permission request
- emit done
- verify desktop conversation persistence
- verify PWA final transcript

### Sidecar Smoke

Keep existing checks:

- `pnpm run sidecar:check`

Add:

- fake remote-start smoke
- sidecar runtime event fanout smoke

## End-To-End Tests

### PWA Playwright

Mobile viewport tests:

- sign-in mock
- host list
- new agent form
- streaming conversation
- approval flow
- cancel
- retry
- reconnect banner
- history view

### Desktop + PWA

Use local relay dev:

- desktop connects
- PWA starts conversation
- desktop sidebar updates
- PWA receives stream
- desktop sends follow-up
- PWA receives update

## Security Tests

Required before private beta:

- cross-account device cannot list host
- trusted device cannot access untrusted host
- revoked device active socket is closed
- revoked token rejected
- expired token rejected
- WebSocket bad origin rejected
- command with mismatched host id rejected
- command with mismatched account id rejected
- command without idempotency key rejected
- payload over limit rejected
- provider secrets absent from relay logs
- SSH key paths absent from snapshots
- MCP env values absent from snapshots
- audit log records every mutating command

## Load And Reliability Tests

Scenarios:

- 1,000 idle hosts connected
- 10,000 idle devices connected if feasible in staged load
- 100 active streams
- slow mobile client during long stream
- desktop reconnect storm
- relay deployment while clients connected
- push queue burst

Metrics:

- connect latency
- stream event latency p50/p95/p99
- reconnect recovery time
- dropped event count
- duplicate command count
- Rust relay process RSS/CPU
- per-connection outbound queue pressure
- PostgreSQL replay/outbox backlog

## Manual Mobile Matrix

### iOS Safari Installed PWA

- install to Home Screen
- sign in
- enable push
- receive approval push
- open correct conversation from push
- background for 5 minutes
- reopen and resume
- lock/unlock during stream
- low-power mode behavior

### iOS Safari Browser Tab

- sign in
- host list
- stream while foreground
- clear explanation if push/install unavailable

### Android Chrome Installed PWA

- install
- push
- background/reopen
- file attachment picker later

### Android Chrome Browser Tab

- sign in
- foreground stream
- offline/reconnect

## Build Checks

These checks describe future implementation acceptance. Record exact source,
feature set, commands, environment and passed/failed/skipped results; do not
promote schema/build or fake-transport checks into native/mobile proof.

Desktop:

- `pnpm lint`
- `pnpm test`
- `pnpm build`
- `pnpm run rust:check`
- `pnpm run sidecar:check`
- targeted Rust tests for `remote_agents`

PWA:

- lint
- typecheck
- unit tests
- Playwright mobile tests
- Lighthouse PWA smoke

Rust relay (`D:\projects\packetrelay`):

- `cargo fmt --all -- --check`
- `cargo clippy --locked --all-targets -- -D warnings`
- `cargo test --locked`
- `cargo clippy --locked --features remote-agents --all-targets -- -D warnings`
- `cargo test --locked --features remote-agents`
- `cargo test --locked --features remote-agents --test postgres_persistence`
  against an explicitly authorized disposable PostgreSQL instance; treat a
  missing test URL as **skipped**, never database acceptance
- PostgreSQL migration and restart/replay integration tests
- Docker build and container smoke test
- deployment dry run

The current PostgreSQL test covers the identity-foundation migration and
repository boundaries, not an implemented ticket/replay/auth/outbox lifecycle.
Add the missing lifecycle/fault tests as those features land. A feature-enabled
test executable or container must report its actual build feature set; the
default relay image is not evidence that the remote routes work.

Keep distinct evidence for: cross-runtime envelope compatibility; approved
crypto golden/negative vectors; real database restart/replay and restore;
fake-relay desktop/PWA command flows; actual socket auth/Origin/revocation;
and installed iOS/Android approval/background/reopen/push flows. Desktop browser
emulation cannot establish installed-phone behavior. Restore/backup readiness
and the required auth/security review must be recorded independently of the
eleven desktop feature gates.

## Beta Exit Criteria

- all private beta launch gates in `04-security.md` pass
- owned-auth/recovery and accepted E2EE/transport security review completed
  before any external beta, plus proven datastore backup/restore readiness
- no known P1/P2 security issues
- 30-minute remote active session passes
- iOS and Android manual matrix complete
- all mutating remote commands audited
- remote disabled path leaves desktop behavior unchanged
- revocation tested during active stream
- no provider secrets observed in relay/PWA logs
