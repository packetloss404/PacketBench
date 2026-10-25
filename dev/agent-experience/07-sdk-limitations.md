# Declared SDK limitations (R8 / H1)

Status: declaration for the R8 rollout. It states what the shipped runtime
actually guarantees per transport. It does not claim a capability the code has
not verified against a locked dependency version. Native claims are enforced by
the journal/capability/budget/context modules in `src-tauri/src/core/`; SDK
claims are the strongest the sidecar path can make today.

Source of truth: `01-runtime.md` §7.1. This file is the operational restatement;
if the two disagree, §7.1 wins.

## What is proven (native, in-process)

The native route runs the production `run_turn` behind `RuntimeServices`, so the
journal, capability, budget and context guards are all visible and enforced:

| Contract                     | Native guarantee                                                                                                                                                                          |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Typed provider input         | `ChatMessage`/`ContentBlock` history is journaled; checkpoints are typed and versioned.                                                                                                   |
| Tool mutation intent/receipt | The existing executor + approval broker are wrapped; intent is durable before the effect.                                                                                                 |
| Request budget               | A reservation is written before every native model request **and** every child subagent request (R5b/R7), settled on the provider `Done` with the exact actual, released on error/cancel. |
| Context fit                  | The native serializer/accounting is visible; overflow enters `blocked_context` before spend (R6).                                                                                         |
| Capability guard             | An image on a route whose vision is `unsupported`/`unknown` is refused before dispatch (R4b).                                                                                             |
| Cancellation                 | The existing local/SSH guards plus journal drain.                                                                                                                                         |
| Crash recovery               | A crash between the ledger append and the journal settle is reconciled at startup (single-instance guaranteed), settling from the ledger or releasing a genuinely orphaned reservation.   |

## What is declared, not proven (SDK / Node sidecar)

The sidecar transports (`claude-oauth`, `openai-agents`) own their own request
loop. Until a versioned before-request/mutation hook handshake is shipped and
verified against the locked SDK versions, the SDK route makes the **weaker**
claim for each contract:

| Contract                     | SDK route at this rollout                                                                                                                                     |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Typed provider input         | Only a tested, versioned adapter export/resume format qualifies. A token or text seed is not equivalent.                                                      |
| Tool mutation intent/receipt | Journal before SDK-owned mutation requires a tested hook; absent it, interrupted work is **semantic/unknown** and must not auto-resume.                       |
| Request budget               | **soft_turn** — the SDK enforces a turn-level soft limit, not a per-request reservation, unless a real before-request hook with required bounds is verified.  |
| Context fit                  | No fit is claimed where the SDK owns hidden context/compaction; only the SDK's declared evidence and limits are exposed.                                      |
| Cancellation                 | Requires SDK cancellation and remote supervisor acknowledgement; state may remain `stopping`/`unknown` on disconnect.                                         |
| Capability guard             | The image guard runs in the Rust sidecar branch before dispatch (R4b) for the sidecar providers, but the SDK's own input handling beyond that is not claimed. |

### Protocol floor

The sidecar protocol is **v12** (`PROTOCOL_VERSION` /
`MINIMUM_PROTOCOL_VERSION` in `src-tauri/src/commands/agent_sidecar/mod.rs`). No
journaled tool/admission handshake exists yet; the proposed v13 messages
(`runId`/`epoch`/`requestId`, `before_effect`, `effect_admission`,
`effect_receipt`, optional `before_model_request`/reservation response) are not
shipped. An older sidecar may continue only through explicitly supported legacy
semantics; it cannot ignore required safety fields for a journaled run. The
global minimum protocol floor is **not** raised until the security contract ships
across bundled and SSH sidecars. The v12 trust floor is never weakened.

No claim is made that any particular installed SDK exposes all proposed hooks.

## Evaluation-lane policy

The offline evaluation lane (`src-tauri/src/bin/runtime-eval.rs`) runs the
**same** `run_turn` against the deterministic `FakeServices`/`ScriptedProvider`
lane. It is offline by default and must never touch network/keyring/ambient MCP.
`--live` hard-refuses: live evaluation requires an explicit provider/account/
target selection **and** a predeclared spend policy, and never runs as part of
routine tests or against a developer's real project/profile. The 20–30 held-out
live tasks × 3 trials and OS/container isolation are deferred; the offline lane
does not constitute live-model proof.
