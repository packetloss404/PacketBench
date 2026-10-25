# Current transport limitations

Reconciled October 25, 2026 through committed source `d41a0a51`. This states actual source behavior and limitations, not the target guarantees in `01-runtime.md` or proof of an installed deployment. The [October 24 audit](../documentation-audit-2026-10-24.md) is a historical snapshot; subsequent source repairs are recorded in [HANDOFF](../../HANDOFF.md) and [backlog](../../backlog.md). See also [the feature acceptance inventory](../advertised-feature-acceptance-2026-10-25.md).

## Activation boundary

PACKETBENCH_RUNTIME_JOURNAL=1 is required; it still defaults off. Native request-budget admission additionally requires a configured budget. Source readiness prerequisites do not prove the installed app enables these paths. This audit does not change activation settings.

## Native in-process source

| Contract                   | Current implementation and limit                                                                                                                                                                                                                                                                                        |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Production executor        | The live app and offline fixtures use run_turn through RuntimeServices. R2 extraction is committed.                                                                                                                                                                                                                     |
| Typed history              | Opt-in typed/versioned checkpoint storage and boundary writes exist. Public inspect/resume now derives compatibility from a live registered session and can offer typed mode when compatible; absent session context stays semantic-only. Epoch advancement does not itself continue the provider or reconcile effects. |
| Tool effects               | Native boundary records and terminal run projection exist when enabled. Full immutable authority, prepare/start/cancel/reconciliation bridge and durable image pins remain incomplete. No exactly-once claim.                                                                                                           |
| Request budget             | Opt-in/configured single-scope estimated reservations cover native/child calls. Estimates omit some system/tool/image input; hierarchical scope ownership remains incomplete. Not a proven hard dollar bound.                                                                                                           |
| Missing usage/cancellation | A durable dispatch marker now retains dispatched-but-unsettled reservations as uncertain liability, including missing-ledger startup reconciliation. Unknown is not zero billing. A proven-safe release/reconciliation path for that liability remains open.                                                            |
| Context fit                | Opt-in estimates/snapshots can block detected overflow. A hash-verified context/window readout exists; heuristic/catalog windows, unknown-window dispatch and incomplete omission/compaction still prevent a guaranteed-fit claim.                                                                                      |
| Capabilities               | Opt-in tri-state metadata/image preflight plus UI guard exist. The production runner now records a content-addressed manifest when bound and enabled. Static/unknown metadata and full frozen execution/SSH authority remain limited.                                                                                   |
| Cancellation               | The native parent cancellation token now reaches child provider loops and nested children; dispatched child liability remains uncertain until reconciled. Full remote/SDK drain and ambiguous-effect reconciliation still need separate evidence.                                                                       |

## SDK / Node sidecar source

The Claude Agent SDK and OpenAI Agents SDK own hidden internal loops. Current source exposes frontend turn preflight and usage reporting; no verified SDK before-request admission hook or implemented SDK-enforced soft-turn limit was found. The target soft_turn label is a desired disclosure category, not evidence that such a limit is enforced today.

No per-request reservation, hidden-context fit, durable mutation receipt or exact typed-recovery parity is claimed. A versioned tested hook/export contract is required before strengthening any guarantee. Rust can preflight images when the guard is enabled, but that does not establish all SDK input/tool behavior. SDK cancellation and remote acknowledgement must be proved separately; a disconnected remote process may have an unknown outcome.

## Protocol

The sidecar wire version/minimum floor remains 12. Runtime admission/effect/checkpoint handshake fields from the target design are not shipped. Preserve the existing trust floor; a future security contract must ship across both peers before changing its required floor. Older SDK paths cannot silently ignore required safety fields and still claim stronger guarantees.

## Evaluation

The feature-gated offline runtime-eval lane uses the production runner with FakeServices and scripted fixtures. Its developer entry point is the Cargo example `src-tauri/examples/runtime_eval.rs` (`cargo run --features runtime-eval --example runtime-eval -- --all`), outside Tauri's production binary discovery. It avoids real providers/keyrings/ambient MCP/projects; live mode refuses. The October 25 isolated local gates passed all 12 cases, and a fresh example-target run passed 12/12 after the packaging correction. [The feature acceptance report](../advertised-feature-acceptance-2026-10-25.md) records the target checks, exact source/evidence snapshots and older shared-checkout evidence separately. This is offline runner evidence. Repeated held-out tasks, real executor isolation, live-model/SDK evaluation and remaining fault cases are open. The separately passing disposable SSH transport matrix does not evaluate a provider. Composer research is excluded.

Current test outcomes and packaging status are recorded in the feature acceptance report. No live-provider, installed whole-flow or deployment guarantee follows from this source declaration.
