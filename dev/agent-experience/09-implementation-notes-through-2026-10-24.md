# Historical implementation notes through October 24, 2026

This is the former HANDOFF narrative, preserved as historical execution notes. Its uncommitted labels, open/closed wording and counts are superseded by [the October 24 source audit](../documentation-audit-2026-10-24.md) and [current status](../current-status.md).
It is not another task ledger or proof of deployment. Source commits and recorded test scopes must be checked separately.

**Implementation status (uncommitted working tree).** A Wave 0 source inventory
and a read-only review of tracks 01–04 were completed against `e5d31084`;
rusqlite and the other cited seams exist, while the docs contain a few stale
line claims and unresolved cross-track conflicts recorded in the review notes.
The P1 F1 slice landed: worktree provisioning failure is fail-closed (no agent,
no conversation, no root fallback) and the draft plus staged images survive for
Retry or an explicit Local launch. F2A followed: staged images are scoped per
conversation/launch draft in memory, late decodes are generation-fenced, and
type/size/read rejections are visible with a session-only disclosure. Text
persistence is unchanged. F8 landed next: IME composition now suppresses
composer shortcuts, history recall restores the pre-recall draft, and a
deliberate edit after recall is not overwritten. F3 core followed: Edit & fork
creates a real child with lineage and leaves the parent intact; Rewind saves a
read-only transcript revision, changes no files and starts no turn; parent
deletion retains a checkout still referenced by a fork. F4 core followed: late
auth probes no longer overwrite explicit provider/model/profile choices, and a
slow launch no longer steals conversation selection; single-flight holds through
settlement. F2B core landed: a backend draft-asset service (stage/read/release/
gc) persists image bytes in app-data with type/size/digest validation, the
frontend keeps only metadata refs in a versioned v2 envelope and re-reads
previews after restart, and the legacy v1 text map still migrates. F5 core
followed: worktree and root conversations group under their base project,
two repositories on one SSH host are labelled repo @ server, and New opens
against the selected conversation's base project. Review fixes: draft-asset
I/O runs on a blocking worker thread, and discard/archive cleanup now retains a
checkout that a live fork still references. The review's medium findings were
then closed: image type is sniffed from content, forks keep the parent's frozen
MCP authority, a newer draft envelope is never downgraded, orphan draft assets
are reclaimed at startup, per-draft staging is capped at 20 MiB, missing images
block sending with a visible reason, and lineage records source/rewind
revisions. Rewind also refuses while an approval or running tool is
unresolved. R1a then landed: a default-off SQLite runtime journal substrate
(launch identity/idempotency, cancel tombstone, fail-closed migrations) exposed
through inert `*_runtime_*` commands; nothing in the live loop calls it yet, and
R2 (same-runner extraction) plus H2/H4 integration remain. R2a added the
`core/agent_runtime/` host-boundary seam (EventSink + recording double,
RunRequest/RunOutcome); R2b then extracted the loop into
`runner.rs::run_turn<R: RuntimeServices>` with a Tauri adapter, behavior-preserving
(`cargo test --lib` 1136/0) and independently reviewed; R2c added headless
fake-provider parity tests (1142/0). R3a added the checkpoint schema (journal
v1→v2) and typed `runtime_checkpoint` module (1156/0, independently reviewed);
R3b added runner checkpoint persistence + inspect/resume behind the default-off
flag (1170/0, disabled path byte-identical), and its three must-fixes landed
(1174/0: restart kind, off-thread persist, fail-closed resume). R4a added the
capability + manifest modules and journal v2→v3 (1190/0); R4b added the
capability readout command + DTO/schema/wrappers and the shared fail-closed
image guard on both transports, gated on the journal being enabled so the
journal-off path is byte-identical (1196/0, full gates green). R5a added the
budget admission substrate (journal v4 + `core/runtime_budget.rs`, 1214/0) and
R5b wired per-request admission into the native runner plus the `usage.jsonl`
request_id bridge, gated on a configured budget (1228/0, full gates green). R6
added context projection + `blocked_context` overflow blocking (journal v5 +
`core/runtime_context.rs`, 1244/0). R7 added the explicit subagent role resolver

- child budget parity (1264/0). R8 added the offline same-executor eval lane
  (`runtime-eval` bin + versioned case/result schema + 12 fixtures + acceptance
  helper + gate, 1275/0); the live held-out-trial lane remains deferred.
  V1/V2 followed: shared type tokens raised to comfortable sizes
  (UI 13/20, meta 12/16, transcript 15/24, composer 15/22, code 13/20) and
  muted/faint text now clears 4.5:1 on every surface in both themes, gated by a
  token contrast test. The V3–V8 appearance and F6/F7 continuity tranche then
  landed: App scale/reading/terminal size with one resolver and one root writer,
  theme-aware code, 32/36px targets, accessible names/focus, a resizable sidebar,
  narrow execution-context disclosure, exact attention routing, and matching-turn
  search with reader-position restoration. V3 App scale/terminal size and all
  native evidence remain open. Flight-owned mutation
  gating, old message-link resolution, submission/checkpoint pins,
  scheduled GC/capacity, H2 typed-image replay, native restart evidence and the
  F4 phase surface remain open. Focused Vitest, Rust unit tests, TypeScript and
  ESLint pass. No build or installation was run and native Windows acceptance
  (including real IME confirmation and paste/drop restart) remains open.
