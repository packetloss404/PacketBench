# PacketBench Roadmap

Last reconciled: October 24, 2026. **Remote Agents is the highest product implementation priority.**

[Current status](dev/current-status.md) records verified facts; [backlog](backlog.md) is the only task ledger. [The documentation hub](dev/README.md) links all programs, operations, evidence and archives.

## Now — Remote Agents and its safety dependencies

1. Close the [Remote Agents transport/security contracts](dev/remoteagents/11-transport-contract-decisions.md): replay/ACK persistence, ticket reserve/finalize, authenticated hello and endpoint-to-endpoint encryption.
2. Prove a small internal ticket → desktop host connection → PWA presence → revoke/reconnect slice. Reuse committed relay identity/ACL/persistence substrate; do not mistake scaffolded routes or schema builds for functioning auth/presence.
3. Build backend-owned conversation projection/control and PWA streaming/approval/cancel/reconnect through the narrow Remote Agents protocol. Keep feature gates fail-closed until their evidence is earned.
4. Resolve the directly supporting desktop/runtime safety gaps in parallel: immutable SSH/checkout authority, real launch/turn/recovery identity, unknown spend/effect liability, durable image ownership, truthful start failure and exact visible approvals. Remote Agents does not need every cosmetic task completed before work begins; it must not bypass these authority boundaries.

Canonical program: [dev/remoteagents/README.md](dev/remoteagents/README.md). Product auth remains the resolved in-house passkey/magic-link direction; do not reopen it from historical proposals. Older Railway/PostgreSQL health records and later local datacenter notes are different evidence. Confirm current deployment, datastore and backup/recovery before rollout; no infrastructure was live verified by this documentation audit.

## Next — complete the existing experience and earn rollout

- Finish the [agent-experience residuals](dev/agent-experience/README.md), not a rewrite of the committed source: policy-compatible typed continuation, one root run per turn, real manifest identity, conservative budgets/context, safe asset GC/pins, SSH contextual New, failed-start draft retention and approval-over-review.
- Complete scaling/control/accessible-name migration, terminal dialogs, one sidebar width/reset owner, narrow reflow and actual composed contrast. Keep Workspace CLI font/session ownership intact.
- Bind a final installer to exact source/payload, then verify the installed local and pinned Linux SSH journey including Stop/restart/repair/review/delivery/archive. Windows IME/display/Monitor and separate Mac evidence remain. The current 0.14.9 executable is identified by hash, but deployment of latest HEAD is not proven.
- Earn Remote Agents external-beta gates: owned auth/recovery, E2EE/Rust-browser vectors, revocation, redaction/security review before any external beta, datastore recovery, phone/PWA/push/artifact behavior and load/incident controls. Eleven desktop flags alone are not full beta readiness.

## Existing proof work

Keep these within their existing ledger scopes: live provider and SDK-over-SSH parity; cooperative Flight/inbox/YOLO integration proof; MCP/Memory/trust provenance; dictation/headset and Monitor hardware cases; macOS package acceptance and distribution signing/updater under existing owner decisions. Source complete and accepted in a real package are separate statuses.

The [October 24 audit](dev/documentation-audit-2026-10-24.md) verifies committed implementation slices through `922ddcc9`, default-off guards and remaining proof. Its source findings are not fresh product test results. The earlier Flight local/SSH walkthroughs and installer records retain their named historical scope.

## Later — explicit optional work

- Evidence-backed quota disclosure, scoped rendered-app verification and supported ChatGPT-plan transport feasibility, after the core safety/experience work.
- Native iOS/TestFlight after the Remote Agents PWA earns its phone/relay/auth/push evidence.
- Optional bounded improvements already in backlog only when selected; old product sketches are not an approved implementation queue.
- Packet Control, delayed Global Undo, Monitor/SSH expansion and dictation benchmarks keep their existing boundaries; general Computer Use remains paused. These do not displace Remote Agents or silently become required feature expansion.

Composer/model-development research is owned by a separate thread and excluded from this completion plan. Retired ACP providers, the autonomous Flight planner, Syndicate execution-target integration and the Cost Dashboard stay retired.

## Baseline and completion rules

- Audited source: main `922ddcc928629e116215d899580f7e9370b2603d`, matched live GitHub main on October 24.
- Application source is committed; the subsequent documentation-only publication records this reconciliation without changing application inputs. Source R1–R8/F/V slices are substantial but partial. The journal is opt-in, and cap/recovery strength must be labelled accurately.
- Installed executable: 0.14.9, SHA-256 b91c617d44be753ff3f2b47ff1020c5bedca9d66e4fdcbe4b3e02deb0cfaa1f9, matching the available October 23 NSIS payload. A latest-source build/install manifest and fresh whole-flow acceptance are still needed.
- Historical release tags, suite counts and package reports are indexed under `dev/`; they are not current acceptance. Do not rebuild/install for documentation alone.
- Update backlog when implementation/evidence actually lands and HANDOFF with the next action. Keep target designs, historical observations and verified current facts distinct.
