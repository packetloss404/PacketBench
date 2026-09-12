# GUI, provider and hardware acceptance — 2026-09-08

Raw-artifact retention note (September 11): a later Playwright run cleared the
old shared `test-results` directory. Recorded observations/hashes below survive;
the referenced raw directories do not. Playwright output is now isolated under
`test-results/playwright`; see `workspace-usability-evidence-2026-09-11.md`.

## Installed 0.14.1 observations

Tested the installed NSIS executable identified in
[`installer-ssh-evidence-2026-09-08.md`](./installer-ssh-evidence-2026-09-08.md),
SHA-256 `f51401193fe2f05f7b8c817c70bcb84e68446d06553b1062e9b8527791c97d87`.
These are direct native-window observations, not promoted source-test results.

Provider prompts used a new local Git fixture under
`test-results/acceptance/gui-2026-09-08/project`, branch `codex/acceptance`,
with synthetic README content and no Git remote. Existing SideStep conversations
and workspace bindings were preserved.

| Check | Observed result |
| --- | --- |
| Main window and Settings | Rendered; General, Agent behavior and Providers & Models navigated successfully. |
| Bundled sidecar | Status bar reported ready, v0.5.0, PID 57312. |
| Project selection | Native folder picker selected the isolated fixture for a new conversation without rebinding the existing workspace. |
| Ollama model picker | Listed installed qwen2.5-coder:7b and qwen3.5:4b; embedding model visibly marked as having no tools. |
| Ollama first turn | qwen2.5-coder:7b returned exactly `GUI_ACCEPTANCE_OK`; status returned to Idle, 2,098 tokens displayed. Local Ollama log recorded HTTP 200, 55.5-second request including 38-second model startup. |
| Ollama context continuity | Follow-up returned `GUI_ACCEPTANCE_OK SECOND_TURN_OK`; warm request completed promptly. |
| Navigation during a request | Dictation opened while Ollama was responding; returning to Agents showed the completed transcript. |
| Streaming | A third response visibly streamed before returning to Idle. Cancellation was inconclusive: the model abbreviated the requested sequence and finished before Stop could interrupt it. |
| MiniMax live request | API returned HTTP 429, Token Plan usage limit reached (2056). Conversation visibly Failed with the upstream reason. Positive response remains quota-blocked. |
| Missing API credentials | Both Anthropic and both OpenAI launcher rows displayed API-key setup guidance. Settings independently showed absent keys. Successful SDK execution was not tested. |
| Dictation Analytics | Honest empty state, zero words/WPM/streak/saved time; explanatory UTC and sentiment coverage text. |
| Dictation History | Empty history, search controls rendered, Clear all unavailable. |
| Dictation shortcut state | UI consistently reported global shortcuts off. |
| Device inventory | Windows reported PLT Focus audio endpoints present and healthy. App enumerated the default Headset at 16 kHz, mono. |
| Whisper model setup | Downloaded Tiny successfully (77,691,713 bytes) through the app and selected it. An independent SHA-256 and length check matched the marker and shipped model specification. No model was initially installed. Tiny remains selected. |
| Live microphone probe | The 1,500 ms Test probe opened the headset but received zero audio frames; the UI displayed an actionable error and the Test button recovered. No transcription or accuracy result is claimed. |
| Navigation smoke | Flight Deck and Issues empty states, Memory event list, and Git Hosts connection gate rendered. No Flight or external Git-host mutations were performed. |
| Monitor | **Failed:** Send to Monitor opened a persistent white native window; native Close did not dismiss it. Main web content remained visible. |

## Monitor opening correction — installed 0.14.2

`open_monitor_window` was a synchronous Tauri command. Tauri 2.11.5 documents
that creating WebView2 windows from synchronous commands can deadlock on Windows
and directs callers to use async commands or a separate thread. The command is
now async; its route validation and read-only command allowlist are unchanged.
See [the version-matched Tauri API documentation](https://docs.rs/tauri/2.11.5/tauri/webview/struct.WebviewWindowBuilder.html#method.new).

The correction was built and installed separately as 0.14.2. Two targeted Rust
Monitor tests passed; all 11 release checks, TypeScript/Vite and both Windows
bundles passed. Sidecar development dependencies were restored after packaging.

Evidence directory: `test-results/acceptance/windows/2026-09-08T21-39-52-918Z`.
The source manifest records dirty HEAD `7019094b51ddef8d8d0d67de8306fc6c93fe2f3a`,
1,327 source files, and source SHA-256
`033cf8a7aff4511593c1a65c80eb41b666d7e33b871f94e11f1ec8ba325e36f3`.

| Artifact | SHA-256 |
| --- | --- |
| NSIS 0.14.2 | `5ef87fcd1140c952f16d27af1053736bddf216c052f019a6469d5e332a8246af` |
| MSI 0.14.2 | `026b1b183ce8c2a6e6748f1351ffb36668a8cb6f213526a9fd16c9c3ce3f94c1` |
| Installed NSIS executable | `10b168b356e64d9c3f8171e6fb2f3366117fb6917d362818136b20586cdec39e` |

NSIS exited 0; 8,683 installed payload hashes matched. Installed version was
0.14.2, bundled Node was v24.15.0, and the packaged protocol-v12 sidecar passed
two echo turns. MSI was built and hashed, not installed.

Native candidate testing used that same executable hash and the previously
verified bundled resources. Monitor opened with a rendered transcript, reused
one window when routing from MiniMax to Ollama, focused the main window, and
maximized and closed successfully. Main was on DISPLAY3 and Monitor on DISPLAY2;
Windows reported five active 1920×1080 displays. Tested Monitor sizes were
902×732 and 1920×1032; an 800-pixel responsive layout is not claimed.

After installation, Monitor again rendered and received new Ollama messages.
A coding response was stopped mid-stream, leaving partial output and returning
to Idle. A subsequent turn returned exactly `AFTER_CANCEL_OK`, also visible in
Monitor's native document text. Conversation state survived application restarts.

**A second lifecycle defect was found:** closing the main window left Monitor,
the app process and bundled Node alive. Closing Monitor itself then exited all
three normally. This is recorded as a failure of 0.14.2, not a passing shutdown.
Monitor's three custom window buttons also lacked accessible names.

## Shutdown and accessibility correction — installed 0.14.3, native retest passed

The app now requests exit on the main window's `Destroyed` event, after the
existing `useCloseConfirm` flow has completed. It does not exit merely on a
close request, so cancelling the live-work confirmation still preserves the
window. Tauri's normal Exit event retains PTY, sidecar and stream cleanup.
Monitor's minimize, maximize and close controls now have explicit accessible
names. A new version identifies this correction separately from installed 0.14.2.

The version-matched [Tauri app source](https://docs.rs/crate/tauri/2.11.5/source/src/app.rs)
confirms that `AppHandle::exit` triggers the ordinary ExitRequested/Exit flow.
Seven existing close-confirmation tests passed, including cancel, confirm,
idle close and rejected destruction. Rust formatting and targeted ESLint passed.
All 11 release checks, TypeScript/Vite, and native NSIS/MSI builds passed again.

Evidence directory: `test-results/acceptance/windows/2026-09-08T22-08-27-202Z`.
Built at `2026-09-08T22:22:10.390Z`, from the same dirty HEAD and 1,327 files,
source SHA-256 `2d67edf75053e5765dbc51e84338a6e7ae8a38e670f48e3566ed6cd9f34a3514`.
The source remained unchanged during packaging; documentation was updated afterward.

| Artifact | SHA-256 |
| --- | --- |
| NSIS 0.14.3 | `db19b4e202c00a914ef3b09dcbf79ddfb69b20898270cacc3705da66f7b6564a` |
| MSI 0.14.3 | `d1917d4e73e93f87ecdd1358ef3cbeb00cd8edddf54ff0db10421e665b2e5eb5` |
| NSIS executable payload | `9f1cefbaa8d2aa6b0d909237fe5d510f370e4f76ea8056219c7a5b3cb5600ec8` |

NSIS upgrade exited 0. All 8,683 payload hashes matched; installed version was
0.14.3, Node was v24.15.0, and the bundled protocol-v12 sidecar passed two turns.
MSI was built and hashed, not installed. Development sidecar dependencies were
restored after the build.

| Installed 0.14.3 native check | Result |
| --- | --- |
| Startup and persisted conversations | Passed; the earlier fixture transcripts remained readable. |
| Monitor opening/rendering | Passed repeatedly with the real installed executable. |
| Accessible window controls | Windows accessibility tree exposed Minimize Monitor, Toggle Monitor maximize and Close Monitor. |
| Main close with idle conversation and Monitor open | Passed twice. One run tracked all ten app/WebView/Node processes and found zero remaining afterward. |
| Close request during active local model request | A fresh qwen3.5:4b conversation triggered the one-active-conversation warning. Cancel preserved the active request and both windows. |
| Confirm close with active conversation and Monitor open | Passed; both windows closed and all ten tracked app/WebView/Node processes exited. |

The qwen3.5:4b request was used to test active-work shutdown and was deliberately
cut off before a completed answer. It is not claimed as a positive provider
completion. Earlier qwen2.5-coder attempts returned short model refusals before
close; those runs prove idle shutdown only. The qwen2.5-coder successful turns,
stream interruption and post-cancel reply are attributed to the rows above.

**Separate remaining finding:** changing the model on a restored, idle
conversation closed the picker without changing the displayed model. Choosing
qwen3.5:4b for a fresh conversation worked. The store calls the backend before
persisting a new model, even when the restored conversation has no backend
session; that is the suspected cause, not a completed fix. Tracked in `backlog.md`.

**First-turn persistence finding:** after confirming shutdown during the fresh
qwen3.5:4b request (`conv_1788906537730_4lv53dkz`), the initial prompt/conversation
was absent on restart and its JSON file did not exist. The four earlier saved
conversations remained. The lifecycle cleanup passed, but preserving a new
conversation before its first response completes remains a separate backlog
item. PacketBench was reopened at the end with no test request running.

## September 11 source corrections — packaged retest pending

Both conversation findings above are now corrected in source. Initial API
conversation creation awaits a disk save containing the first user prompt
before exposing the running conversation or launching its provider. A failed
save rejects back to the launch UI before provider work begins. On startup,
previously active records restore idle with an interruption notice and do not
automatically resume. Live Monitor projections do not receive that notice.

Model selection on a restored conversation updates and immediately persists
the local model used by the next resume. A live or starting session still
requires backend acceptance before the displayed model changes. The immediate
save cancels an older pending debounce so that snapshot cannot revert the
selection.

`src/stores/__tests__/agentConversationRestart.test.ts` exercises the real
store/persistence code with mocked IPC and a JSON store retained across module
restarts: seven tests passed. Cases include a delayed initial write, shutdown
before any provider response, disk-write failure, model selection across two
restarts and the next send, live backend rejection/acceptance, stale debounce
protection, and Monitor/completed-conversation behavior.

The broader command
`pnpm exec vitest run src/stores/__tests__ src/lib/__tests__/launchConversation.test.ts src/lib/__tests__/resumeSshConfig.test.ts --maxWorkers=2`
passed 773 of 774 tests across 78 files. The remaining migration test timed out
at its explicit 15-second module-load limit; rerunning the entire
`persistenceMigration.test.ts` file alone with `--maxWorkers=1` passed all 25
tests in 4.71 seconds. Targeted ESLint passed for the three changed source/test
files. `pnpm build` passed TypeScript and the Vite production build (4,236
modules); Vite reported Browserslist age and existing chunk-layout warnings.
`git diff --check` passed.

These are source regression results. Installed 0.14.3 and the installer hashes
above predate the corrections; neither native restart scenario has yet been
repeated in a newly packaged build.

## Physical and credential-dependent checks

The live microphone probe received zero frames. Spoken-phrase accuracy,
headset power-off/out-of-range salvage, profile switches and reconnect require
physical participation. Cloud SDK success needs user-configured API keys;
MiniMax success needs available quota. No credentials were requested in chat,
no subscription credentials were substituted, and no credits were purchased.

Raw local evidence is under `test-results/acceptance/gui-2026-09-08/`: sanitized
fixture transcripts, device/display inventories, recovery and native Monitor
observations. The 0.14.1 real OpenSSH 9/9 proof remains attributed to its original
build. No paid SDK, full Flight, WebView-to-Rust denial integration, stale-entity,
full keyboard/responsive or physical headset recovery matrix is implied here.

The wider matrix in [`acceptance.md`](./acceptance.md) remains a historical
0.13.2 checklist. Only the rows explicitly observed here apply to this run.
