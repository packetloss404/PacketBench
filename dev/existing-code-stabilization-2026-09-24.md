# Existing-code stabilization — 2026-09-24

Scope: repair the findings in the
[September 24 audit](../docs/reports/code-completeness-audit-2026-09-24.md), remove
confirmed unused code, and reconcile current capability claims. No feature
expansion. Branch: `codex/stabilize-existing-contracts`, based on `5035f98d`.
The audit remains an immutable record of the source before these fixes.

Source delta is approximately 2,100 fewer physical lines across frontend,
Rust and sidecar source (including comments and inline Rust tests). Separate
test files grow slightly. This is a cleanup of confirmed unused paths, not a
line-count target; compatibility code and active implementations remain.

## Implementation

| Findings | Source change |
| --- | --- |
| F01 | Approval keys require the selected visible terminal in the active Workspace; dialogs, unrelated controls, editing, modifiers and IME input take precedence. |
| F02 | Conversation worktree publication resolves origin before pushing and pins the matching Git host connection for PR creation. |
| F03 | GitDashboard state is scoped to repository/Workspace/SSH configuration; refresh generations reject superseded responses. |
| F04 | Monitor projection preserves saved status; cold-start interruption normalization remains separate. |
| F05 | Removed custom CLI creation with no supported launcher. Existing saved configurations remain visible with an unsupported-launch explanation. |
| F06 | Removed unreachable diagnostics components. Kept aggregate check results, AI summaries, metrics history and the existing auto-fix controls; added working cancellation and listener lifecycle handling to the aggregate runner. |
| B01/B02 | Child tools intersect parent authority and retain the parent's MCP selection and frozen trust/roots. Returned parent calls must belong to the advertised set before hooks or dispatch. |
| B03 | Completed child requests are recorded under their actual model/provider and parent session, including Flight rollup. Session totals are available to admission checks. |
| B04 | Task-tool state belongs to a backend conversation, is shared with its children and cleared on close. It is intentionally not durable across app restart. |
| B05 | Trusted project and global custom-agent definitions are discovered once for the session; advertisement and execution use that same snapshot. |
| B06/B08 | Child iteration exhaustion is an explicit incomplete result; recursion depth belongs to each nested call chain, not a process-wide concurrency counter. |
| B07 | Native local MCP now resolves global/trusted project stdio, HTTP and SSE servers into session-owned connections. Native SSH refuses desktop substitution; remote-owned MCP uses an SDK provider. See the follow-up below. |
| S01/S02 | New, restored, direct, queued and retried API turns pass budget admission using accounted conversation spend. Ledger totals include children; transcript fallback does not double-count ledger root usage. |
| S03/S04 | Hydrated reviewer gates reconcile missing/interrupted sessions. Authoritative gate persistence precedes success, and failed writes remain visible and retryable. |
| S05 | Restored permission, plan and approve-write controls persist before backend resume; live backend failures surface in the chat. |
| S06 | Prompt Library awaits terminal/Scout delivery and retains the dialog/template with an error on failure. |
| S07/S08 | Deleting a conversation closes completed/failed backend sessions too. Flight notifications respect the shared enable, focus, completion/error and debounce preferences. |
| C01/C02 | Removed confirmed orphan components/helpers and their obsolete tests. README provider, protocol, version and capability claims now describe live paths. Roadmap and handoff prioritize stabilization. |

## First-pass validation

Focused validation passed: 82 frontend tests, 102 store/UI tests, and 95 Rust
tests. Targeted cleanup checks also passed. Integration review caught and fixed
Stop/delete during pending budget admission, abandoned resume listeners, stale
reviewer writes, and usage accounting racing completion events.

All eleven local gate categories passed after correcting stale test fixtures.
The first `pnpm gates:full` run passed ten gates and exposed five frontend
suites with old assumptions: two synchronous dispatch assertions, two incomplete
Zustand mocks, and a selector for the removed custom CLI creation section.
Only tests changed afterward; production behavior was not weakened.

- The five affected suites passed all 37 tests after correction.
- TypeScript passed again, followed by the complete frontend suite:
  **298 files, 2,866 tests passed**.
- The original full run passed formatting, lint, frontend build, Remote Agents
  checks, browser E2E, sidecar checks, Rust check/test and the Tauri schema gate.
- Modified test files passed scoped ESLint. Owned Rust files passed rustfmt;
  the final working diff passed `git diff --check`.

Evidence is under
`test-results/acceptance/existing-code-stabilization-2026-09-24/`:
`full-gates.log` preserves the initial failure; `affected-suite-rerun.log`,
`typecheck-rerun.log`, and `frontend-rerun.log` record its resolution.
`source-manifest.json` identifies the uncommitted source/test files by hash.

## Follow-up repairs

The owner requested implementation of the five remaining items identified
after the first pass. Follow-up validation is recorded separately from the
first-pass evidence above.

- Accounting uses a synced, unique journal for each completed request before
  appending its usage row. Failed or uncertain writes retain the journal and
  block further API requests and budget admission. Concurrent completions
  retain separate records. Native requests record completed usage before the
  next tool round, so later provider failures cannot discard earlier spending.
  Premature stream EOF is incomplete. Native, sidecar and auxiliary callers
  surface accounting failure instead of reporting ordinary completion. Startup
  repricing preserves unresolved journals and their ledger offsets.
- Already-crossed thresholds notify on first observation. A pending delivery
  cannot duplicate itself across concurrent polls; suppressed notifications
  remain eligible for retry. Existing notification preferences still apply.
- Removed the inaccessible cost-display preference, dollar statusline and
  unused aggregate display calculations. Token displays, per-turn cost
  accounting, shared pricing and budget controls remain.
- Removed the unused per-diagnostic AI command, prompt and auxiliary route.
  Aggregate Quality summaries and existing auto-fix controls remain.
- Native local MCP sessions resolve global and trusted project servers over
  stdio, Streamable HTTP and legacy SSE. Each session owns its frozen server
  definitions, tool mapping and connections; children inherit that authority.
  Project overrides are resolved before filtering, preventing fallback to a
  same-named global server. Network servers require explicit network trust.
  Settings can disable all servers even when the list is empty, and an existing
  conversation can explicitly reconnect without MCP. These controls make the
  native SSH refusal recoverable without editing persisted data.

MCP transport behavior follows the installed official Rust SDK's negotiated
protocol and the
[2025-11-25 transport specification](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports).
Static headers are supported. Redirects cannot forward them, and legacy SSE
POST endpoints must remain on the configured origin. Failed tool requests are
not replayed automatically. This is not a migration to the newer protocol draft
or an interactive OAuth implementation.

Stdio session teardown reuses the existing process-tree helper. It terminates
descendants while their wrapper is still alive (Windows `taskkill /T`, Unix
process group). Already detached descendants after a wrapper exits are outside
that helper's guarantee; this change does not add a new process supervisor.

Focused follow-up validation passed 122 cleanup frontend tests, seven alert
tests and 136 Rust tests, including loopback HTTP/SSE and injected ledger
failures. The Rust snapshot preceded the final auxiliary error-preservation
and MCP cached-discovery Stop corrections; the full run below validates those
final changes. Logs are separate from first-pass evidence under
`test-results/acceptance/existing-code-followup-2026-09-24/`.

Final follow-up result: **all eleven local gate categories passed**, including
the complete Rust tests, sidecar checks and schema validation. The initial
full run passed ten categories; one browser case lost its execution context
during navigation while the final MCP recovery UI edit was landing. The
frozen-source rerun passed all five affected frontend categories: lint,
typecheck, production build, **298 files / 2,869 tests**, and **14 browser
tests**. No test thresholds or production checks were weakened.

`full-gates.log` and `e2e-initial-error-context.md` preserve that initial
failure; `frontend-final-gates.log` records the clean rerun. The final source
manifest covers 122 changed source/test/configuration files against `5035f98d`:
digest `68b8ca341d0f9735a7ae5f030aacb4b39a06dd4e40513e57c7bae9aa165d8edd`.
Its hashes matched all 122 files again before the version-only release metadata
bump and commit. Changed Rust files passed rustfmt
and the final diff passed whitespace checks. Physical runtime source is
**2,079 lines smaller** (including inline Rust tests); separate test files
grow by 231 lines across the complete stabilization branch.

### Accounting design and recovery

Rust's [`write_all`](https://doc.rust-lang.org/std/io/trait.Write.html#method.write_all)
can return an error after writing part of a record. A subsequent sync failure
can also leave a complete record. Blind retry could duplicate spending.
[`sync_all`](https://doc.rust-lang.org/std/fs/struct.File.html#method.sync_all)
and atomic [`create_new`](https://doc.rust-lang.org/std/fs/struct.OpenOptions.html#method.create_new)
provide the journal boundaries used here; automatic replay is deliberately
absent.

If accounting reports incomplete usage, stop API work and close the app.
Preserve copies of both `usage.jsonl` and the adjacent `usage-pending/`
directory before repair. Validate every journal and its newline-terminated
usage row first; a partial journal requires reconstruction from authoritative
provider/session evidence. Each valid journal contains the exact intended
JSONL line and, when known, the ledger length before that write. Compare exact bytes at
that offset: a complete match is already counted; an exact partial prefix
needs only the missing suffix; no bytes at that offset needs the full line.
Any different tail or unknown offset requires reconciling the retained row
against the ledger and provider/session evidence before deciding what is
missing. Do not blindly append all journals or delete them to clear the error.
After every retained entry is accounted exactly once, validate complete JSONL
rows and finite nonnegative costs, sync the repaired ledger, then remove only
the reconciled journals and restart. The process failure latch clears only on
restart; outstanding journals keep admission blocked across restarts.

This is evidence preservation and explicit recovery, not a transactional
database. If storage refuses every write, only the running process can retain
the failure latch. No guarantee is made for external concurrent ledger edits
or power loss before directory metadata reaches disk.

## Limits and release state

- The fixes were committed, merged and pushed to main as `9367b7a1` before
  building both 0.14.8 Windows installers. Artifact hashes were verified.
  Installation was outside this build request; the last recorded installed
  application is 0.14.6.
- Mocked frontend tests and local Rust fixtures do not constitute native GUI,
  hardware or paid-provider acceptance. Paid Claude testing remains deferred
  at the user's request because of subscription cost.
- Budget checks use recorded completed usage at turn boundaries. They cannot
  predict or cap the cost of an already-running provider request; unknown
  pricing remains explicit. Ledger errors refuse admission; pending writes
  require reconciliation as described above. These controls are not an
  absolute spending ceiling.
- Native SSH MCP remains unsupported. Explicit empty selection permits native
  SSH conversations without MCP; other selections, including the default all,
  fail with guidance to choose an SDK provider for remote-owned MCP. Desktop
  configuration is never substituted for the SSH host's configuration.
- This closes a bounded audit, not every historical backlog item or every
  possible defect. Remote Agents expansion remains deferred and disabled.

## Windows build 0.14.8

Built on September 24 with `CARGO_BUILD_JOBS=2` and
`PACKETBENCH_RELEASE_REQUIRE_CLEAN=1` using `pnpm acceptance:build`.
The wrapper exited 0 after NSIS/MSI packaging, manifest generation and restoring
the sidecar development dependencies. All 12 packaging prechecks passed with
zero warnings; the fresh frontend build and optimized Rust build passed. Rust
emitted the existing ts-rs serde-alias warnings. The build did not install or
launch the application.

- Source commit: `9367b7a1b0d2239df48eb1524705c593873df011`, pushed to main
  before building; working tree clean throughout packaging.
- Source manifest: 1,335 files,
  SHA-256 `4e3b4d1b9ac7d60fbd3a4e814321dab44012ad1bc58f4acf482b79dbec7c7d60`.
- Target: `x86_64-pc-windows-msvc`; application file/product version `0.14.8`.
- Installer manifest lists 8,683 payload files. This records bundled inputs;
  it is not a claim of installed-payload verification.

Artifacts are under `C:/Users/ianwalmsley/packetbench-build/release/`:

| Artifact | Bytes | Verified SHA-256 |
| --- | ---: | --- |
| `bundle/nsis/PacketBench_0.14.8_x64-setup.exe` | 89,813,760 | `58335588d201891a464f84788a2c75b92a4cc61536caf4c117263184eaa90aa0` |
| `bundle/msi/PacketBench_0.14.8_x64_en-US.msi` | 140,072,148 | `f9d49da5741a70ce244bc022d771c344b9af93673058935273c3a18aeb6c62a1` |
| `packetbench.exe` (unpatched build output) | 50,629,120 | `36d9ea8dbee65a2fbd63ab70730ee13fa43ae2b0b6d56de220ee96caf3a582b0` |

Tauri patches the embedded executable per installer. The manifest records
NSIS executable hash `df06ee96c33c552dde4757dfc84432f7ff27261f60970bf7908bed0323e535fa`
and MSI executable hash `4537d2e0e353e320edd63e0afa6e6bc14d58839d87064bf586e8ea46e835aaac`.
Use the installer for deployment; the standalone executable needs its bundled
resources.

Local evidence:

- `test-results/acceptance/release-0.14.8/build.log`
- `test-results/acceptance/release-0.14.8/verification.json`
- `test-results/acceptance/windows/2026-09-24T18-00-41-372Z/manifest.json`

This release record was updated after the build. Its documentation commit does
not change the artifact's source identity above. Native GUI, real-provider and
hardware acceptance still require version-specific evidence; paid Claude
testing remains deferred for subscription cost.
