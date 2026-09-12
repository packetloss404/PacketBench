# Workspace reliability — September 11, 2026

Raw-artifact retention note: a subsequent Playwright run cleared the old shared
`test-results` directory. The observations and hashes below remain recorded,
but their old raw paths may be absent. The output isolation fix and new evidence
are documented in `workspace-usability-evidence-2026-09-11.md`.

Workspaces remain the primary daily working surface. This pass covers terminal
focus/navigation, failed-send recovery, restore selection/zoom, and multi-pane
resize/output behavior. It also carries the earlier first-turn persistence and
restored API model-selection corrections into the next package.

## Implemented behavior

- Terminal selection and explicit focus requests reach the actual input.
  Ctrl+Alt+PageUp/PageDown cycles visible terminal panes in layout order.
  Modal/editor/approval ownership and hidden panes retain their guards.
  Last-focused-pane memory survives workspace switches within the running app.
- Failed commands/templates retain the exact attempted text for an explicit
  retry into the current session. Restart and resend remain separate actions.
- Backend hydration restores valid backend-only selection and rejects stale
  deleted/archived selection. Archive/delete clears only the owned zoom.
- Resize bursts fit once per animation frame using final geometry; hiding or
  unmounting cancels stale work. Returning to a hidden pane still repaints it.
- PTY output uses a bounded eight-entry channel and a 32 KiB / 8 ms dispatcher.
  Transcript append and emitted payload share the same batch and sequence;
  the dispatcher drains before the exit event. Input is not buffered here.

The old late-hydration/layout race is not reproduced on current normal startup:
backend hydration precedes `initialized`, and WorkspaceView gates mosaic mount
on that flag. Backend authority and initial layout consumption remain intact
to avoid unnecessary terminal remounts. Wider tabs/chrome/responsive redesign
remains in the backlog.

## Validation

Focused worker suites passed: WorkspacePane 15, account gating 15, and restore/
layout/account suites 75. Root resize suite passed five tests. Six standalone
Rust batching tests passed. A frozen-clock queued-burst test across 1/4/8 panes
turns eight 8 KiB reads into two 32 KiB emissions per pane, with byte-identical
text. This measures event reduction under the stated fixture, not native FPS.

Integration review found and corrected focus-request expiry stealing focus and
approval keyboard ownership. The visible approval bar now receives focus without
scrolling, and cleanup respects selection/visibility. The final focused focus/
approval/component run passed 33 tests, including 24 new cases. Independent
review found no remaining actionable blocker in the Workspace changes.

Compiled Rust tests passed: `cargo test --lib core::pty --jobs 2` (19 tests) and
`cargo test --lib commands::pty::tests --jobs 2` (30 tests). Targeted ESLint and
`git diff --check` passed.

The full frontend run passed 2,809 tests in 296 files. It also discovered the
installer harness file, whose Node test API made Vitest report an empty suite.
That harness now uses Vitest's API and cleanup hook; its four assertions passed
under Vitest. The documented harness command was updated. Type checking caught
test-fixture mock types and `.at()` calls beyond the configured JS library;
those test-only issues were corrected and the affected suites passed again
(24 focus/navigation tests and nine resize/installer tests). Final
`pnpm typecheck` and `git diff --check` passed.

The final complete rerun exited 0: **2,813 tests passed in 297 files** in
245.37 seconds, including the four installer harness tests. The complete log is
`test-results/acceptance/workspace-2026-09-11/final-vitest.log`.

## Package and native proof

0.14.4 built and installed successfully: NSIS exit 0, all 8,683 payload hashes
matched, bundled Node 24.15.0 and protocol-v12 sidecar completed two echo turns.
The manifest and installation reports are under
`test-results/acceptance/windows/2026-09-12T01-41-13-947Z/`.
Installed executable SHA-256:
`ec8eca59167043a75a23bea34352c1f5db218e45ae121f6107d118917333ca8e`.

Native 0.14.4 checks observed four shell panes returning in the selected
Workspace, header click moving the solid terminal cursor, Ctrl+Alt+PageDown
moving it to the next pane, zoom transfer to the following pane, Escape
restoring the grid, and a splitter resize repainting terminal output. Hidden
Workspace terminals disappeared from the accessibility tree in Agents.
The restored idle Ollama acceptance conversation changed from qwen2.5-coder:7b
to qwen3.5:4b without a missing-session error and retained that choice after
normal close/relaunch. A new local qwen3.5:4b turn was then deliberately cut off
using the app's close confirmation. After relaunch its exact initial prompt
(`WORKSPACE_INITIAL_SAVE_20260911`) remained, the state was idle, and the
interruption notice was visible. No turn resumed automatically.

Native testing exposed a real layout loss: four incrementally added columns
became the 2x2 preset after restart. The incremental add/remove path deliberately
did not save its geometry. It now saves once per structural change, preserving
the same live tree and surviving terminal mounts. The new regression failed
before the fix and now proves backend-save payload, cache hydration and remount
retain the four-column tree. All 36 Mosaic/selection tests passed, with targeted
lint/format and diff checks clean. Previously unsaved geometry cannot be
recovered from an absent layout. Independent review found no persistence loop
or added survivor-remount risk; final type checking passed.

**0.14.5 built and installed successfully.** Both Windows installers and all
11 release checks passed. NSIS exited 0; all 8,683 installed files matched the
manifest. Bundled Node 24.15.0 and protocol-v12 sidecar passed two echo turns.
Source identity was unchanged throughout packaging; subsequent edits only
record the completed evidence and planning status.

| Identity | SHA-256 |
| --- | --- |
| Source snapshot (dirty main `7019094b`, 1,334 files) | `2012236d9653f9f40b3730bce514652201c7c117529d2ebd5e36eef04b37f3b1` |
| Installed NSIS executable | `72b82ae26f0a4eec1e569bf15522d776be9e34dce9fa6ff5ce3deb9de7d301fe` |
| NSIS installer | `abf72eb48b82036aa83d40b959883f741c3f95f42b6c21846ac01a015426a719` |
| MSI installer | `73bc84be4c363215db3caad3f4e7bb0465a9c279fdd225d1d06f7f1befcb49bc` |

Full manifest, install and packaged-sidecar reports:
`test-results/acceptance/windows/2026-09-12T02-01-09-461Z/`.

Native 0.14.5 acceptance used the fresh **Layout acceptance** Workspace:
restored one shell, added three more through Add Session without dragging any
splitter, confirmed four columns, closed normally, and reopened. All four
columns and the selected Workspace survived. The earlier fixture's asymmetric
splitter layout also survived. Selecting the third pane, switching to the other
fixture Workspace and back, then navigating Next selected/focused the fourth
pane, confirming remembered selection and continued navigation. Native UIA
reports the document even for focused xterm inputs; cursor visuals support
header/navigation focus observations. Direct typed-input delivery immediately
after a Workspace switch was not separately tested. All acceptance shells were
closed normally; the two fixture Workspaces remain available for inspection.

The 2,813-test full run preceded the final layout correction; the final changed
Mosaic/selection suites passed 36 tests afterward. Do not describe that older
full run as a rerun of the final correction.

The native fixture is `test-results/acceptance/workspace-2026-09-11/fixture`.
No paid-provider, full SSH CLI, hardware or broad responsive acceptance is
implied by source tests or the queued-output fixture.
