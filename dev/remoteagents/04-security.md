# 04 - Security

## Current gate clarification — 2026-10-24

Use [current status](../current-status.md), the
[documentation audit](../documentation-audit-2026-10-24.md), and
[backlog](../../backlog.md) for sequencing. Remote Agents follows desktop/runtime
completion and acceptance; it remains disabled/fail-closed while waiting. The
sequencing change does not waive any security requirement below.

The ratified in-house-auth decision in
[09-open-decisions.md](./09-open-decisions.md#auth-provider--resolved-2026-08-28)
requires security review **before any external beta**, including an external
private beta. The later Public beta list below does not postpone that review.
Pre-beta E2EE is also mandatory; owning the relay/auth code or using TLS is not
a substitute. Transport/crypto details remain gated by
[document 11](./11-transport-contract-decisions.md).

The eleven requirements encoded in `src/lib/remoteAgentsGate.ts` are a
necessary production feature guard, not a complete release-readiness
checklist. Their all-green state would not establish auth-review completion,
datastore backup/PITR and restore readiness, full retention/recovery policy,
or the mobile/operational proof below. Keep those as independent release
requirements with dated evidence. No gate was marked met and no security,
infrastructure or test verification was performed in this reconciliation.

## Security Position

Remote Agents is remote control over an agent that can read, write, run commands, use API credentials, access local files, and call MCP tools. Treat it as high-risk infrastructure from day one.

The security model is:

- cloud sign-in establishes user identity
- desktop approval establishes device trust for a host
- narrow protocol establishes allowed remote actions
- desktop permission policy still controls risky tools
- provider secrets never leave desktop
- agent content is encrypted before external beta

## Auth Recommendation

### Primary

- Passkeys/WebAuthn for Packet account sign-in.
- Magic-link or one-time email code fallback.
- Optional GitHub/Google OIDC later.

Avoid username/password in v1 unless absolutely required. Password auth adds reset flows, credential stuffing, breach response, and support overhead.

### Desktop Sign-In

Use browser-based PKCE:

1. Desktop starts sign-in.
2. Browser opens Packet Cloud auth.
3. Auth redirects to loopback callback or custom URI.
4. Desktop exchanges code for tokens.
5. Desktop stores refresh token in OS keyring under PacketBench brand constants.

Desktop PacketBench is a public native client:

- do not embed client secrets
- use the system browser, not an embedded webview
- use loopback redirect or a claimed custom URI
- rotate refresh tokens
- keep refresh tokens in keyring only
- do not use the resource owner password credentials grant

### PWA Sign-In

Use same Packet account auth. Store refresh/session material according to web best practice:

- prefer secure, HttpOnly, SameSite cookies for cloud auth session
- use CSRF protections for state-changing HTTPS endpoints
- mint short-lived single-use WebSocket tickets over HTTPS
- do not put long-lived access or refresh tokens in localStorage
- use WebAuthn credentials for passkeys
- store device private key in IndexedDB/WebCrypto non-extractable key when possible

## Host And Device Identity

### Desktop Host Key

Desktop generates a long-term host identity key on first Remote Agents enablement.

Store:

- private key in OS keyring
- public key in Packet Cloud desktop registration
- key fingerprint in desktop settings

Rotation:

- provide a manual "Rotate host key" control
- rotation invalidates trusted-device grants unless the user chooses a migration flow

### Mobile Device Key

PWA generates a device keypair on first use.

Storage:

- best: non-extractable WebCrypto `CryptoKey` persisted in IndexedDB when supported
- fallback: encrypted private key in IndexedDB
- native iOS later: Keychain/Secure Enclave where possible

Device key uses:

- sign access requests
- bind WebSocket tickets
- sign encrypted command envelopes
- support revocation by key id

### Trust Grant

A trust grant binds:

- `accountId`
- `hostId`
- `deviceId`
- `devicePublicKey`
- `hostPublicKey`
- capability scope
- creation time
- optional expiry
- host signature

Cloud metadata is not enough. Desktop must maintain and verify its own trusted-device record before invoking local actions.

## Device Trust

Account sign-in alone should not automatically grant remote control over a desktop host in v1.

Flow:

1. PWA signs in.
2. User taps host.
3. Cloud sends `device.access_request` to desktop.
4. Desktop shows requester name/device/browser/IP region.
5. Desktop user approves.
6. Cloud records ACL: `{ accountId, hostId, deviceId, scopes, createdAt, lastUsedAt }`.
7. PWA receives trusted-device token.

Device scopes:

- `view` - list providers, models, auth statuses, summaries, transcript
- `respond` - answer pending permissions and edits
- `send` - send follow-up messages
- `start` - start new API-agent conversations

Future scopes:

- `pty:read`
- `pty:write`
- `missions:control`
- `deploy:control`

MVP does not grant:

- mobile `allow_always`
- raw PTY control
- API key management
- shell command submission outside the agent permission flow
- MCP config edits

## Revocation

Revocation must be immediate:

- desktop Settings shows trusted devices
- PWA account page shows devices
- cloud maintains revoked token ids
- relay disconnects revoked sockets
- desktop receives `device.revoked`
- remote commands from revoked device fail closed

## Token Strategy

- Short-lived access tokens, 5-15 minutes.
- Rotating refresh tokens.
- Token id (`jti`) tracked for revocation.
- Device id bound to ACL.
- WebSocket tickets are single-use, 60-second TTL, and bound to account, host, device, role, capabilities, and device public key.
- Consider DPoP or equivalent proof-of-possession for device API calls after MVP foundation.
- Desktop host token stored in keyring.
- PWA auth session protected by secure cookies where practical.

## End-To-End Payload Encryption

TLS protects network transit, but the relay would still see prompts, code, diffs, tool arguments, and approvals unless payloads are encrypted above TLS.

This is a property of the deployment as well as the process: TLS terminates at
the hosting proxy (Railway, as of 2026-08-27 — see `02-architecture.md`
§ Deployment target), so the hosting provider's edge and any platform log or
traffic-inspection surface sits inside the TLS boundary alongside the relay
binary. Payload encryption is what protects content from both. This is
unchanged by PacketBench now owning the relay: owning the code is not the same
as the content being unreadable in the deployment.

Recommendation:

- Internal dev can start with plaintext payloads for speed.
- External private beta requires encrypted payloads for agent/approval/file/control channels.
- Presence and routing metadata can remain visible to relay.

Model:

1. Desktop host has a long-term host key pair.
2. Trusted device has a device key pair.
3. During desktop approval, desktop and device exchange public keys through the cloud and verify via the desktop approval UI.
4. Desktop and trusted device establish endpoint-to-endpoint content-key epochs;
   the relay authenticates and forwards key-agreement metadata but never derives
   or receives content keys.
5. Payloads are encrypted with WebCrypto on PWA and Rust crypto on desktop.
6. Relay buffers ciphertext only.

Use audited libraries. Preferred approaches:

- HPKE using RFC 9180 suites
- Noise-based session transport using a mature implementation

Do not design custom crypto beyond protocol composition, nonce/sequence tracking, AAD, and envelope validation. Before Sprint 1 encrypted routing, an explicit security review must lock the audited HPKE/Noise composition, authenticated peer-key forwarding, multi-device distribution, and how a reconnecting endpoint can decrypt retained ciphertext across key rotation.

Frame requirements:

- assign the sequence at the single authenticated stream producer before sealing,
  and include protocol version, host id, device id, stream id, sequence number,
  frame kind, and timestamp bucket in AAD
- ignore authenticated duplicates already processed; reject or request replay for
  forward gaps and other out-of-order sequence numbers
- rotate session keys at reconnect and periodically by frame count or time
- prefer X25519 where available, with P-256 fallback for browser compatibility
- make suite negotiation explicit and downgrade-protected

Cloud-visible metadata:

- account id
- host id
- device id
- channel
- command/event type
- sequence number
- timestamps
- payload size

Cloud-hidden content:

- user prompts
- assistant chunks/thinking
- tool inputs/outputs
- file paths where possible
- diffs/file contents
- permission arguments
- provider/model secrets

## Provider Secret Isolation

Never send these to cloud or PWA:

- API keys from OS keyring
- Claude/OAuth credential files
- Codex auth JSON
- MCP server environment variables
- SSH private keys
- local env vars
- raw shell profile config

The PWA can receive auth status only:

```ts
{ status: "ready", hint: "Session will auto-refresh on next use" }
```

## Permission Safety

Desktop permission policy remains authoritative. Mobile can answer prompts, but it cannot bypass policy unless the desktop conversation is configured to allow it.

For MVP, mobile can `allow_once` or `deny`; `allow_always` remains desktop-only.

Mobile approval cards must show:

- host name
- workspace/project
- provider/model
- tool name
- risk class
- summarized arguments
- whether this is one of a batch
- action buttons

Risk classes:

- `read`
- `write`
- `shell`
- `network`
- `git`
- `secrets-sensitive`
- `destructive`

Step-up auth later:

- require passkey confirmation for `shell`, `destructive`, deploy, or broad allow-all changes
- require fresh session age under 5 minutes for high-risk approvals

## WebSocket Security Requirements

Follow OWASP WebSocket guidance:

- authenticate during WebSocket upgrade
- validate `Origin`
- enforce object-level authorization on every message
- rate-limit connection attempts and messages
- cap message size
- heartbeat and idle timeout
- do not trust client-supplied account/host/device ids
- log security decisions
- reject unknown protocol versions
- disable compression unless a measured need justifies it
- close active sockets on logout, token revocation, or device revocation

## Abuse Prevention

Cloud relay abuse risks:

- attacker uses relay as generic socket tunnel
- stolen token sends expensive agent prompts
- compromised phone approves destructive command
- malicious host floods push notifications

Mitigations:

- command allowlist only
- per-account/device/host rate limits
- per-message max size
- daily push notification caps
- audit log
- revoke controls
- anomaly detection: new country, new browser, too many approvals, too many failed auth attempts
- beta allowlist before public launch

## Threat Model

### Stolen Phone

Risk: trusted device controls host.

Mitigations:

- phone OS lock
- PWA session timeout
- device revocation
- step-up auth for high-risk approvals
- audit log

### Stolen Cloud Access Token

Risk: attacker sends commands through relay.

Mitigations:

- short-lived tokens
- refresh rotation
- token revocation
- proof-of-possession later
- object-level ACL checks
- single-use WebSocket tickets

### Compromised Relay Host/Database

Risk: relay metadata exposure, command manipulation.

Mitigations:

- encrypted content payloads before external beta
- desktop validates command schema and device ACL claims
- audit mismatch detection
- no provider secrets in relay storage or logs

### Malicious Device On Same Account

Risk: signed-in user adds unauthorized mobile device.

Mitigations:

- desktop approval required
- device list and revocation
- optional "require approval for every new device"

### Compromised Desktop

Risk: all bets mostly off, because desktop owns secrets/tools.

Mitigations:

- clear local kill switch
- audit remote commands
- do not allow cloud to escalate beyond desktop policies

## Launch Gates

Internal prototype gate:

- auth mocked or dev-only
- relay protocol narrow
- no raw Tauri bridge
- provider secrets stay desktop

Private beta gate:

- real account auth
- device approval/revocation
- object-level authorization tests
- WebSocket origin validation
- audit log
- payload encryption for agent/approval content
- E2EE test vectors pass in Rust and browser
- revoked active device loses WebSocket within 5 seconds
- mobile `allow_always` is rejected
- cloud logs are scanned for prompt/tool content and pass redaction checks
- documented incident kill switch

Additional requirements before **any external beta**, whether or not they are
represented in the eleven desktop gates:

- complete the security review of owned auth, recovery/device-loss paths and
  the accepted endpoint-to-endpoint encryption/transport contracts
- establish the actual datastore/deployment configuration and prove the
  required PITR/backup and offsite restore-drill guarantees; the September
  Railway observations do not establish a database exists today
- exercise durable restart/replay, revocation, redaction, retention and the
  applicable phone approval/reconnect matrix with recorded evidence

Public beta gate:

- passkey/magic-link production auth
- rate limits
- abuse monitoring
- push notification controls
- retention policy
- security review refreshed for the public scope; the initial owned-auth
  review is already required before external private beta
