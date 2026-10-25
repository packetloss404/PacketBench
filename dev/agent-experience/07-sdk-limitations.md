# Current transport limitations

Reconciled October 24, 2026 against committed source `922ddcc9`. This states actual source behavior and limitations, not the target guarantees in `01-runtime.md` or proof of an installed deployment. See [the audit](../documentation-audit-2026-10-24.md), [current status](../current-status.md) and the backlog.

## Activation boundary

PACKETBENCH_RUNTIME_JOURNAL=1 is required; it still defaults off. Native request-budget admission additionally requires a configured budget. The current process environment was not inspected. Source readiness prerequisites do not prove the current app enables these paths, and no setting was changed in this audit.

## Native in-process source

| Contract                   | Current implementation and limit                                                                                                                                                                                              |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Production executor        | The live app and offline fixtures use run_turn through RuntimeServices. R2 extraction is committed.                                                                                                                           |
| Typed history              | Opt-in typed/versioned checkpoint storage and boundary writes exist. Public inspect/resume lacks policy-compatible provider continuation and deliberately refuses typed replay. Epoch advancement is not recovery completion. |
| Tool effects               | Native boundary records exist when enabled. Full immutable authority, reconciliation/start bridge and durable image pins remain incomplete. No exactly-once claim.                                                            |
| Request budget             | Opt-in/configured single-scope estimated reservations cover native/child calls. Estimates omit some system/tool/image input; hierarchy and unknown-liability handling are incomplete. Not a proven hard dollar bound.         |
| Missing usage/cancellation | Current cancellation/startup logic can release reservations without proving zero billing. Preserve this as a repair item, not a guarantee that absent ledger rows are unbilled.                                               |
| Context fit                | Opt-in estimates/snapshots can block detected overflow. Heuristic/catalog windows and unknown-window dispatch do not guarantee fit; full projection/compaction/readout is incomplete.                                         |
| Capabilities               | Opt-in tri-state metadata/image preflight plus UI guard exist. Static/unknown metadata and production manifest identity remain limited.                                                                                       |
| Cancellation               | Existing native local/SSH cancellation is separate from full journal/child/SDK drain and ambiguous-effect reconciliation. Native evidence has its own recorded scope.                                                         |

## SDK / Node sidecar source

The Claude Agent SDK and OpenAI Agents SDK own hidden internal loops. Current source exposes frontend turn preflight and usage reporting; no verified SDK before-request admission hook or implemented SDK-enforced soft-turn limit was found. The target soft_turn label is a desired disclosure category, not evidence that such a limit is enforced today.

No per-request reservation, hidden-context fit, durable mutation receipt or exact typed-recovery parity is claimed. A versioned tested hook/export contract is required before strengthening any guarantee. Rust can preflight images when the guard is enabled, but that does not establish all SDK input/tool behavior. SDK cancellation and remote acknowledgement must be proved separately; a disconnected remote process may have an unknown outcome.

## Protocol

The sidecar wire version/minimum floor remains 12. Runtime admission/effect/checkpoint handshake fields from the target design are not shipped. Preserve the existing trust floor; a future security contract must ship across both peers before changing its required floor. Older SDK paths cannot silently ignore required safety fields and still claim stronger guarantees.

## Evaluation

The feature-gated offline runtime-eval lane uses the production runner with FakeServices and scripted fixtures. It avoids real providers/keyrings/ambient MCP/projects; live mode refuses. The archived October 25UTC manifest records 12/12 at dirty `22d1cbd6`, not fresh clean `922ddcc9` or live-model proof. Repeated held-out tasks, real executor isolation, native/SSH/SDK evaluation and remaining fault cases are open. Composer research is excluded.

No product tests, live provider calls, builds or installations were performed to write this declaration.
