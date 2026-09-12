# Workspace controls, readable layouts and transport acceptance

Follow-up to `workspace-evidence-2026-09-11.md`. **0.14.6 is built, installed and
verified locally** on September 11 (UTC evidence timestamps fall on September 12).

## Implemented

`TileChrome` shares the header drag source, identity/status area, accessible
zoom control and optional close action across terminal, saved conversation and
file panes. Pane-specific lifecycle controls remain with their owners. Failed
send controls are outside the drag handle. Double-clicking a control does not
toggle zoom. File editor focus selects its pane without taking keyboard input.

Readable mode sizes a scrollable canvas from the saved split ratios, targeting
360 by 240 pixels per pane. Fit all is explicit. Balance sizes changes sibling
percentages without reparenting terminals. The pane selector, previous/next and
zoom controls reveal off-screen selections and preserve the layout and live
terminal instances. No tab conversion or automatic regrouping is introduced:
the current library renders only an active tab, which would unmount hidden PTYs.

## Browser acceptance

Run `pnpm acceptance:workspace`. The dedicated Vite harness mounts the production
Workspace, real xterm/parser/canvas and real Tauri event consumers. Its transport
is mocked: no host process starts, and no user app data is read. Four checks
passed: paced output at 1/4/8 panes, plus 800→1600-pixel viewport/control changes.
Every final Unicode marker survived, terminal launches remained one per pane,
and no terminal was disposed or killed. Keyboard pane navigation passed after
the stream. The narrow-layout test checks readable dimensions, selection reveal,
zoom/scroll restoration, Fit all and Balance sizes with real browser geometry.

One recorded headless Chromium run, with 100 paced batches per pane:

| Panes | Bytes delivered | Output events | Elapsed ms | p95 frame interval ms | Longest frame interval ms |
| ----- | --------------: | ------------: | ---------: | --------------------: | ------------------------: |
| 1     |       2,736,019 |           101 |      3,814 |                  33.4 |                     133.2 |
| 4     |      10,944,076 |           404 |      5,868 |                  66.7 |                     300.1 |
| 8     |      21,888,152 |           808 |      7,364 |                 100.0 |                     650.0 |

These include cold rendering and concurrent development-machine load. A 20 ms
producer timer is a minimum delay, not a guaranteed rate. This is a browser
stress baseline, not native WebView2 FPS, a before/after speedup claim, or a
60-fps acceptance pass. Eight-pane high-output responsiveness still needs
profiling; functional delivery and lifecycle checks passed despite pauses.
Raw metrics are copied to
`test-results/acceptance/workspace-usability-2026-09-11/workspace-output-*.json`.

The full Vitest run passed 2,834 tests in 299 files (278.64 seconds), and root
type checking and targeted ESLint passed. This run preceded the final two
selection/visibility integration corrections; their final targeted regressions
and browser recheck passed: 70 focused tests, type checking, lint and formatting,
plus all four browser checks in 38.7 seconds. These include closing a selected
file pane, background closure preserving active selection, and revealing the
selected pane after Fit all→Readable, balancing and viewport resize. Initial
focused checks also passed 55 shared-chrome/file/pane tests and 55 layout/helper
tests. The final browser run retained all output and instances; its eight-pane
p95/max frame intervals were 66.7/466.6 ms, illustrating load variability, not
eliminating the profiling gap. Final metrics are under `final-browser/` in the
acceptance evidence directory.

## Live SSH

The extended runner uses the production frontend SSH argument builder, native
SSH resolution, portable-pty, UTF-8 decoder and output dispatcher against a
disposable Linux OpenSSH host. The remote process is a harmless interactive
Node fixture. Cases cover Unicode input/output, resize, exact clean/nonzero
exit codes, 10,000 ordered unique output lines, changed-key denial, forced
transport loss and fresh reconnect. This does not claim authenticated provider
CLI behavior or GUI-to-SSH coverage. The final stable-source run passed **15/15**:
nine sidecar handshake/trust cases and six Workspace PTY cases. The burst
delivered 2,220,674 bytes with 10,000 unique ordered markers and a fresh
post-burst reply. Wrong-key exit was 255, forced-disconnect exit was 4294967295
on Windows OpenSSH, and reconnect exited 0. Output drained before completion.
Container, temporary image tag and keys were cleaned up.

Raw report: `test-results/acceptance/live-ssh/2026-09-12T04-14-45-977Z/report.json`.
Both source and sidecar-dist identity checks passed.

## Package identity

Build and SSH used the same dirty working-tree snapshot based on
`7019094b51ddef8d8d0d67de8306fc6c93fe2f3a`, covering 1,344 source files:
`644951f85591bbfbaa7f1ac20d9142a55facbbb1666775b3ae11138d386d1cda`.
Documentation completion after packaging changes the working-tree identity;
the manifest remains the authoritative build snapshot. No commit or push was made.

Both installers and all 11 release checks passed. Sidecar development
dependencies were restored after packaging. The build manifest is
`test-results/acceptance/windows/2026-09-12T04-18-30-264Z/manifest.json`.

| Artifact                                | SHA-256                                                            |
| --------------------------------------- | ------------------------------------------------------------------ |
| NSIS `PacketBench_0.14.6_x64-setup.exe` | `758f0337b0382cd8de6580cad00b66a57f86029ed9a4c9db9efdae1b81cdf0e8` |
| MSI `PacketBench_0.14.6_x64_en-US.msi`  | `c6e1cebc8a54bb78107919b614bd5aaae5d7c5646e2879bd36cb43f8d479d186` |
| NSIS executable                         | `f450f26ac082c9f92c94cea6accda793571249c51f2800c96c4be5ba4c23d3ee` |
| MSI executable                          | `ff27932669b75d74418cfa5927ef42052355592910bd40dcca3eaf499e17f796` |

Installer files are under `C:/Users/ianwalmsley/packetbench-build/release/bundle/`.

## Installation and native observations

NSIS exited 0. All **8,683 installed payload hashes** matched. Installed product
version is 0.14.6; bundled Node is v24.15.0 and protocol-v12 sidecar completed two
echo turns. `installation.json` and `packaged-sidecar.json` sit beside the manifest.

Computer Use exercised the installed Windows app, at its 1886×1033 window size:

- Restored the existing `Layout acceptance` Workspace and four saved columns.
- Added four plain Windows PowerShell panes through Add Session. Eight columns
  remained individually readable on a horizontally scrolling canvas.
- Selected pane 8 using the native selector: it scrolled fully into view.
  Zoom filled the working area; leaving zoom restored the scroll position and
  terminal contents. Fit all displayed all eight columns; returning to Readable
  kept pane 8 visible. Balance sizes retained the arrangement. Next wrapped to
  pane 1 and revealed it with a visible terminal cursor.
- Opened the disposable fixture README as a ninth file pane. Previous-pane
  navigation selected/revealed it; its shared header zoom worked. Closing the
  selected zoomed viewer cleared zoom and selected/revealed terminal 8. The
  underlying README remained on disk.
- Closed through the normal eight-session warning and verified the process
  exited. Relaunch restored the active Workspace, eight columns and Readable
  mode; the file viewer stayed closed. Selected pane/scroll position are transient
  across process restart; this is layout/Workspace persistence evidence, not
  continuation of the old PTY processes. The app was left open on the fixture.

Only disposable acceptance shells were used. No shell commands were typed into
the GUI, no paid provider was invoked, and the user's SideStep Workspace was
not activated. Native automation occasionally needed a second observation after
React updated, and the Windows dropdown/file chooser required keyboard or
coordinate input after accessibility targeting failed; those were tool targeting
limitations. Settled screenshots showed the expected application state.

A small existing labeling issue remains: the summary calls eight terminals plus
one file viewer `Terminal ×9`. The viewer is correctly identified in the new pane
selector and does not launch a ninth PTY. This is recorded in `backlog.md`.

The automated browser test proves mount/launch counts; native observations prove
visible behavior. Neither establishes native sustained-output frame-rate acceptance
or authenticated provider CLI/GUI-to-SSH acceptance.

## Evidence retention correction

The first browser run exposed the pre-existing Playwright default output path:
it cleared the shared `test-results` directory, removing earlier ignored raw
installer/SSH reports and disposable test projects. Tracked dated reports and
their recorded hashes survived; installers and the installed app live elsewhere.
Historical raw artifacts are not claimed recoverable. Known disposable project
paths were recreated as empty repositories; their former history was not restored.
Playwright now clears only `test-results/playwright`. New acceptance evidence
is retained outside that directory. Historical report paths may consequently
be absent; the tracked reports preserve the observations, not the raw payloads.
