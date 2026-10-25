# macOS Release Plan

Created: 2026-08-06

Status: **ACTIVE PLAN — not executed.** No step below has been run.

**This document owns macOS code signing and notarization end to end.**
`dev/multi-platform-build.md` and `dev/beta-distribution-trust-runbook.md`
previously deferred macOS signing to each other, so nobody owned it. Both should
now point here. This file is the single authority for Developer ID, entitlements,
hardened runtime, `notarytool`, and stapling.

---

## 0. Why this exists

The 2026-08-05 Fable 5 review scoped macOS out of v1.0.0
([`docs/reports/fable5-review-2026-08-05.md`](https://docs.ianlan.dev/reports/fable5-review-2026-08-05.md) §2)
on the stated grounds that no Apple hardware was documented as available and that
`multi-platform-build.md` says macOS cannot be cross-compiled from anywhere else.

The first half of that is now false. **The owner has a Mac and has been running
PacketBench on it for months** (owner statement, 2026-08-06) — not a one-off
build, but sustained real use. The git history corroborates this independently —
three commits in June 2026 fix defects that can only be observed on a real Mac:

| Commit     | Date       | What it proves                                                                                                                                                           |
| ---------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `8a872d44` | 2026-06-21 | `launchd` hands a Finder-launched `.app` a minimal `PATH`, so `which claude` failed. Fixed by `core/shell_path.rs`. Only observable from a GUI launch of a built `.app`. |
| `18ae8989` | 2026-06-21 | `bundle_dmg.sh`'s Finder AppleScript "fails on roughly half of first attempts here". Someone ran the DMG bundler repeatedly.                                             |
| `3d67b38f` | 2026-06-27 | `fork()` aborts in the child under Tauri's threaded WebKit host. Fixed by vendoring portable-pty with a `posix_spawn` helper.                                            |

So macOS is not a green field. It is a platform that **builds, bundles a DMG, and
runs from source**, and has never been signed, notarized, or interactively
accepted. That is a much shorter distance than the review assumed, but it is not
zero, and the remaining distance is concentrated in exactly the two things that
are hardest to schedule: an external credential and a first-ever notarization.

---

## 1. Recommendation: macOS ships as **v1.1**, and Apple enrollment starts **today**

**Do not add macOS to v1.0.0.** Ship it as v1.1, targeted 2–3 weeks after 1.0
(early-to-mid September 2026). Three reasons, in order of weight:

**1. An unsigned macOS build is not shippable, and the signing identity may not
arrive in time.** This is the asymmetry that decides it. On Windows, an unsigned
installer produces a SmartScreen warning the user can click through — which is
precisely the v1.0 contingency the review already wrote down ("cert not arrived →
ship `v1.0.0-rc1` publicly unsigned with hashes"). That contingency **has no macOS
equivalent.** On current macOS, an unsigned, unnotarized app downloaded from the
internet cannot be opened by right-click→Open any more; the user has to go to
System Settings → Privacy & Security and click "Open Anyway", after a dialog that
says the app "was not opened because it is not from an identified developer"
(general knowledge — re-verify against the macOS version you actually test on).
Telling a first-time user to do that is worse than not shipping. So macOS in 1.0
would mean the whole release date rides on Apple approving an enrollment, with no
fallback. The 1.0 date already rides on one certificate authority. Two independent
external dependencies on one date is how dates slip.

**2. The 1.0 window has no room.** The review's plan through 2026-08-19 is: land
twelve P1 findings, wire the updater client, install the NSIS installer **for the
first time ever** on 08-10, and run a Windows acceptance matrix Mon–Wed with
Wed–Fri as the only buffer. Adding macOS adds a second full acceptance matrix, a
second bundle format, and a first-ever notarization — a per-build step that fails
on entitlement mistakes and that nobody here has run — into the three days that
exist to absorb whatever the first-ever Windows install turns up.

**3. There are real macOS defects, not merely untested surfaces.** Section 3
lists them. The two that would embarrass a 1.0: dictation's native delivery path
returns a hardcoded "Windows only" error on macOS, and there is no entitlements
file, so under the hardened runtime that notarization requires, the microphone is
denied regardless of the `Info.plist` string that already exists.

### The carve-out that makes this a real plan and not a deferral

Deferring macOS to 1.1 only works if 1.1 is a _signing_ exercise rather than a
_discovery_ exercise. So:

- **Enroll in the Apple Developer Program on the same day the Windows signing
  application goes in** (the review says "first hour"). It is $99/year and
  entirely independent of the Windows certificate. There is no reason to serialize
  them, and enrollment is the longest-lead item on the macOS path.
- **Cut an unsigned local macOS build during the 1.0 fix buffer (08-13 → 08-15)
  and run the acceptance matrix in §7 on it.** `xattr -cr` clears quarantine for a
  locally-built app, so an unsigned build is perfectly good for finding bugs — it
  is only bad for _distribution_. Every finding this turns up is one that does not
  land inside the 1.1 window.
- **Fix the §3 defects in the 1.0 → 1.1 gap**, not during 1.1's release week.

That sequencing means 1.1 reduces to: certificate in hand → set four env vars →
build → notarize → staple → verify → publish. That is a two-day job when it works
and a four-day job when the entitlements are wrong on the first submission.

### What this means for the v1.0.0 scope statement

The review's "1.0 is NOT: macOS or Linux" line stands as written. It should gain
a pointer to this document so that "not in 1.0" reads as _scheduled_ rather than
_abandoned_. Proposed backlog text is in the report accompanying this plan.

---

## 2. What is already macOS-ready

Verified against the working tree at `main` (post-`2aaa7f56`). Line numbers in
`commands/pty.rs`, `core/pty.rs`, and `lib.rs` are in flux from concurrent P1
work; treat those as approximate and the others as exact.

### Build and packaging

- **Both Apple triples are in the Node fetcher, with pinned digests.**
  `scripts/node-runtime.js:96-109` defines `x86_64-apple-darwin`
  (`node-v24.15.0-darwin-x64.tar.gz`) and `aarch64-apple-darwin`
  (`darwin-arm64`), each with its `outputFilename` matching Tauri's
  `externalBin` triple-suffix convention **and a pinned `archiveSha256`**, so
  the macOS Node downloads are authenticated on the same footing as the Windows
  one. `scripts/target-triple.js:27-28,39-40,61-62` lists both as supported and
  maps host detection for `darwin`/`arm64` and `darwin`/`x64`.
  `scripts/fetch-node.js` consumes the table and `chmod +x`'s the extracted
  binary on Unix.
  _(`node-runtime.js` is new as of the in-flight F9 supply-chain fix; before
  that, the table lived at `scripts/fetch-node.js:83-94` unpinned. Re-check
  these paths if the F9 work lands differently.)_
- **`src-tauri/build.rs:37-70`** copies `node-<TARGET>` next to the binary and
  correctly yields an empty extension off Windows (`build.rs:43-47`).
- **A macOS DMG build wrapper already exists.** `scripts/build-macos.mjs` (and the
  `build:macos` package script) retries DMG bundling after detaching the leaked
  scratch image, because `bundle_dmg.sh`'s cosmetic Finder AppleScript flakes.
  `scripts/clean-dmg-scratch.mjs` runs as the first step of `prebundle`.
- **`icons/icon.icns` exists** (200 KB) and is already listed in
  `tauri.conf.json:36-42`.
- **`bundle.macOS.minimumSystemVersion` is set** to `10.15`
  (`src-tauri/tauri.conf.json:49-51`).
- **The sidecar has zero native addons.** `find agent-sidecar/node_modules -name
'*.node'` returns nothing, and there are no `.dylib`/`.so` files. Production deps
  are four pure-JS packages (`@anthropic-ai/claude-agent-sdk`,
  `@modelcontextprotocol/sdk`, `@openai/agents`, `zod`). **This is the single
  biggest piece of good news for notarization** — the only nested Mach-O in the
  bundle is the one `node` binary.

### Runtime

- **PTY spawn is macOS-correct and was written for macOS.**
  `src-tauri/Cargo.toml:31-34` vendors and patches portable-pty 0.8.1 specifically
  because `close_random_fds` allocated in a fork child.
  `src-tauri/vendor/portable-pty/src/unix.rs:186-243` replaces upstream's
  `fork()`+`pre_exec()` with a `posix_spawn` of the app binary re-invoked as a
  helper; the helper is `src-tauri/src/lib.rs:75-109` under `#[cfg(unix)]`,
  dispatched from `src-tauri/src/main.rs:8-12`. It does `chdir` → `setsid` →
  `ioctl(TIOCSCTTY)` → `execvp`, all Darwin-valid, with the `TIOCSCTTY as _` cast
  that Darwin's `u64` constant requires.
- **GUI-launch `PATH` repair is macOS-first.** `src-tauri/src/core/shell_path.rs`
  (whole module, `#[cfg(not(target_os = "windows"))]`) reconstructs `PATH` from
  `/opt/homebrew/{bin,sbin}`, `/usr/local/{bin,sbin}` (`:55-60`), `~/.local/bin`,
  npm/bun/cargo/volta/deno dirs (`:61-72`), plus literal `PATH=` lines _read, never
  executed_ out of `.zshenv`/`.zprofile`/`.zshrc`/`.profile`/`.bash_profile`/
  `.bashrc` (`:117-124`). It deliberately never spawns a login shell so it cannot
  trip TCC prompts (`:12-14`). Unit-tested with `/Users/x` fixtures (`:261`).
- **TCC-avoidance is already designed in.** `commands/pty.rs:124-130`
  (`neutral_scratch_cwd`) and the cwd fallback commentary around
  `commands/pty.rs:589-598` explicitly avoid `$HOME` because scanning it walks into
  `~/Music`, `~/Pictures`, `~/Documents` and triggers macOS permission prompts.
- **Unix CLI resolution exists** — `commands/pty.rs:86-118`
  (`#[cfg(not(windows))]`): pin file at `~/.packetbench/<command>-bin`, pass-through
  for anything containing `/`, then a manual `PATH` scan checking
  `mode() & 0o111`.
- **`claude/binary.rs`** carries macOS/Homebrew/npm fallback candidates (added by
  `8a872d44`).
- **Log directory is macOS-correct.** `src-tauri/src/lib.rs:48-55` puts logs under
  `~/Library/Application Support/<LOG_DIR_NAME>/logs`.
- **Window chrome is macOS-correct.** `tauri.conf.json:19-21` sets
  `decorations: true` + `titleBarStyle: "Overlay"` + `hiddenTitle: true`;
  `lib.rs:238` strips decorations at runtime only under
  `#[cfg(not(target_os = "macos"))]`; `src/components/layout/TitleBar.tsx:7-14,55-74`
  detects macOS via user agent, hides the Windows-style control cluster, and
  reserves 78 px for the traffic lights.
- **Keyring is already wired to the macOS Keychain.**
  `src-tauri/Cargo.toml:47` — `keyring = { version = "3", features = [...,
"apple-native"] }`. `Cargo.lock` carries `security-framework` 2.11.1 and 3.7.0.
  `commands/api_keys.rs` and `commands/ssh_keys.rs` contain zero `cfg(target_os)`
  and only use `keyring::Entry::new` + `Error::NoEntry`, so they are backend-
  agnostic.
- **Audio is platform-agnostic and CoreAudio is already in the graph.**
  `Cargo.toml:49` — `cpal = "0.17"` with no features and no target-conditional
  block; `Cargo.lock:580` resolves `coreaudio-rs` 0.14.1. All of
  `commands/dictation/audio.rs` is free of `cfg(target_os)`: enumeration at
  `:88-135`, device selection with stable-ID persistence and legacy-index
  migration at `:142-211`, native-format capture at `:402-421`, and all twelve
  `SampleFormat` variants at `:455-560` (CoreAudio's f32 default is covered).
- **`NSMicrophoneUsageDescription` already exists.** `src-tauri/Info.plist` — seven
  lines, one key, merged into the generated app plist by the Tauri bundler.
- **Sidecar node lookup knows both Darwin names.**
  `commands/agent_sidecar/supervisor.rs:1358-1377` handles
  `node-x86_64-apple-darwin` and `node-aarch64-apple-darwin`.
- **The terminal shell picker is not stubbed on macOS.**
  `src/hooks/useTerminalShellDetection.ts:27-37` probes `bash` and `zsh` on
  non-Windows; `src/lib/terminalShells.ts:96-100` offers
  `auto | bash | zsh | custom`. `commands/pty.rs:383-422` (`list_wsl_distributions`)
  correctly returns an empty vec off Windows.
- **The release-readiness script already knows about macOS.**
  `scripts/release-readiness.mjs:182-201` checks
  `bundle.macOS.signingIdentity` / `providerShortName` and the `APPLE_*` env vars,
  emitting `WARN` today. `PACKETBENCH_RELEASE_TARGET=macos` selects macOS artifacts.

### The honest summary

The macOS work that has been done is _good_ work, done against a real machine, on
exactly the problems that only show up on a real machine. What has never been done
is everything downstream of "the app runs."

---

## 3. What is missing, stubbed, or wrong on macOS

Ordered by severity. Items marked **[1.1 blocker]** must be fixed before a macOS
release; the rest are quality items.

### Blockers

1. **No entitlements file anywhere in the repo.** [1.1 blocker]
   `find` over the tree returns only `src-tauri/Info.plist`. Notarization requires
   the hardened runtime; the hardened runtime denies microphone access without
   `com.apple.security.device.audio-input` **even though**
   `Info.plist`'s `NSMicrophoneUsageDescription` is present. The plist string
   controls the _wording of the prompt_; the entitlement controls _whether the
   capability exists at all_. Both are required. See §4.3.

2. **`bundle.macOS` has only `minimumSystemVersion`.** [1.1 blocker]
   `src-tauri/tauri.conf.json:49-51`. Missing `entitlements`, `signingIdentity`,
   `providerShortName`, `hardenedRuntime`, and any `dmg` block. Nothing in the
   config points at the `Info.plist` either (Tauri picks it up by convention).

3. **Dictation's native delivery path hard-fails on macOS.** [1.1 blocker for the
   dictation claim, not for the release]
   `src-tauri/src/commands/dictation/delivery.rs:40-48`:

   ```rust
   #[cfg(not(target_os = "windows"))]
   {
       let _ = paste;
       Err("Native dictation delivery is currently available on Windows; the transcript remains available in PacketBench".to_string())
   }
   ```

   The whole clipboard + `enigo` Ctrl+V path is `#[cfg(target_os = "windows")]`
   (`:11-38`), and `clipboard-win` / `enigo` are declared under
   `[target.'cfg(windows)']` at `Cargo.toml:63-65` — the only target-conditional
   block in the manifest. The frontend degrades to the webview clipboard
   (`src/hooks/useDictationTarget.ts:80-92`), so this is graceful, but
   `systemWidePaste` is a setting that silently does nothing on macOS.
   Foreground paste on macOS additionally needs the Accessibility TCC grant, for
   which there is no code and no prompt. **Decision needed:** either implement
   macOS delivery, or hide the `systemWidePaste` control on macOS. Hiding it is
   the correct 1.1 scope; the repo already has a convention of hiding unenforced
   controls (v0.10.3, "hidden unenforced controls").

4. **CMake is an undocumented macOS build prerequisite.** [1.1 blocker]
   `Cargo.toml:50` — `whisper-rs = "0.16"`; `Cargo.lock:6059-6071` shows
   `whisper-rs-sys` build-depends on `cmake` and `bindgen` (libclang).
   `dev/multi-platform-build.md:22-29` lists only Xcode CLT, Rust, and Node/pnpm.
   **CMake does not ship with the Xcode Command Line Tools**, so a clean Mac will
   fail the build at `whisper-rs-sys`. (The owner's Mac evidently has it, or the
   June builds would not have completed — but a documented prerequisite list that
   does not reproduce is a trap for the next machine.) Fix: add
   `brew install cmake` to the macOS prerequisites.

5. **No Darwin `node` binaries are staged.**
   `src-tauri/binaries/` contains only `node-x86_64-pc-windows-msvc.exe`. This is
   expected — `pnpm fetch-node` runs on the build machine — but note that
   `build.rs:16-21` makes the copy failure **non-fatal** (`cargo:warning` only), so
   a macOS build with no fetched Node **silently produces an app whose sidecar is
   dead**. Acceptance item MAC-06 exists to catch this; consider making it fatal.

### Quality items

6. **Auto shell on macOS is bash, not zsh.** Three places encode it:
   `src/agents/terminal.ts:4,9` (the authoritative one, consumed via
   `WorkspacePane.tsx:124,165-167`),
   `src/components/views/tools/TerminalShellSettingsCard.tsx:163`, and the
   user-facing copy at `TerminalShellSettingsCard.tsx:64-66`. On macOS `/bin/bash`
   is bash 3.2.57 from 2007 (Apple froze it at the last GPLv2 release); zsh has
   been the default login shell since Catalina. Worse,
   `src/lib/terminalShells.ts:219-222` passes **no args** for the `bash` and `zsh`
   profiles, unlike `git-bash` two cases above which passes `["--login", "-i"]`
   (`:206-211`). So a macOS pane gets an interactive non-login bash that sources
   `~/.bashrc` — a file most macOS users do not have, because their config is in
   `~/.zprofile`/`~/.zshrc`. Aliases, prompt, and env are all missing;
   `core/shell_path.rs` compensates for `PATH` only. Nothing in either tree reads
   `$SHELL`, `getpwuid`, or `/etc/shells`.
   **Fix for 1.1:** make Auto resolve to `$SHELL` (falling back to zsh on macOS),
   and pass `-l` to posix profiles.

7. **`fish`, `nu`, and `xonsh` are never probed on posix**, even though the Rust
   allowlists accept them (`commands/pty.rs:42-44,48-59`),
   `terminalShells.ts:11-22` lists them, and the UI copy at
   `TerminalShellSettingsCard.tsx:284-285` tells the user they are supported. A
   macOS fish user must type an absolute path into Custom.

8. **There is no `"macos"` seam in the TS platform type.**
   `terminalShells.ts:7` is `"windows" | "posix"`. Nothing misfires today — macOS
   correctly falls to `posix` — but there is no place to give macOS a different
   default. The same UA regex is duplicated three times
   (`terminalShells.ts:36-40`, `agents/terminal.ts:4`,
   `components/workspace/WorkspacePane.tsx:181-185`).

9. **No `Info.dev.plist`.** `tauri dev` on macOS runs the bare
   `target/debug/packetbench` binary rather than an `.app`, so the microphone usage
   string is absent in dev and dictation's TCC behaviour under `tauri dev` is
   unverified.

10. **`~/.packetbench` rather than `~/Library/Application Support`.**
    `commands/dictation/models.rs:133-136` (and the general data dir) use
    `dirs::home_dir()` + a dotfolder. The log dir is macOS-correct
    (`lib.rs:48-55`) but the data dir is not. This is a **deliberate
    cross-platform-identical** choice and changing it would need a migration —
    recommend leaving it and documenting it, not "fixing" it during a release.

11. **No macOS-specific error text on TCC denial.** The CoreAudio TCC prompt fires
    when the stream is _built_, not when devices are _enumerated_ — so
    `list_audio_devices` happily returns devices and `build_input_stream` then
    fails, surfacing as a bare string (`audio.rs:849`). Same for Keychain: a denied
    or cancelled Keychain ACL prompt surfaces as `"Credential store unavailable"`
    (`api_keys.rs:156`). Neither says "grant access in System Settings → Privacy &
    Security".

12. **Whisper has no Apple acceleration.** `whisper-rs = "0.16"` with **no
    features** — no `metal`, no `coreml`. macOS runs CPU-only (whisper.cpp will
    still pick up Accelerate). Not a blocker; a 1.2+ performance item.

13. **The Claude Code Keychain namespacing question is unresolved** and the
    multi-account CLI feature depends on it.
    `commands/provider_auth.rs:311-317` returns a deliberate `"unknown"` on macOS
    rather than guessing. See §6 — this is now runnable.

14. **No CI at all.** There is no `.github/workflows` directory, so no macOS build
    has ever run in automation. This is a known, accepted position for 1.0.

---

## 4. Signing and notarization

**This section is the owner of macOS signing. Nothing defers out of it.**

Everything in §4.1 and §4.2 marked _(general knowledge)_ is from training data
with a January 2026 cutoff and reflects a landscape that moves. **Re-verify prices,
timelines, and portal flows at purchase time** — the same review that produced
this plan found the Windows CA landscape had shifted.

### 4.1 Apple Developer Program enrollment

_(general knowledge — re-verify)_

- **Cost:** $99 USD/year, auto-renewing.
- **Enroll as an Individual, not an Organization.** Individual enrollment is
  identity-verified against a government ID and typically completes within 24–48
  hours, occasionally same-day, occasionally longer if verification goes manual.
  Organization enrollment requires a D-U-N-S number and legal-entity verification
  and can take **one to four weeks** — that alone would sink a macOS-in-1.0 plan.
  The only thing organization enrollment buys is a company name on the signature
  instead of a personal name. Not worth the weeks.
- **What you need:** an Apple Account with two-factor authentication enabled, a
  government ID, and a payment method. Enroll at `developer.apple.com/programs/`
  or through the Apple Developer app on the Mac.
- **Start this on the same day as the Windows signing application.** It is the
  longest-lead item on the macOS path and is independent of everything else.

### 4.2 Certificates and keys

_(general knowledge — re-verify)_

Once enrolled, create these from the Mac:

1. **Developer ID Application certificate** — signs the `.app` and the nested
   `node` binary. This is the one that matters. Create it via
   Xcode → Settings → Accounts → Manage Certificates → **+** → _Developer ID
   Application_, which generates the private key in the login Keychain for you.
   Doing it through the web portal requires manually generating a CSR in Keychain
   Access; Xcode's path is less error-prone.
   _Historically limited to five per account — do not burn them experimenting._
2. **Developer ID Installer certificate** — only needed for a signed `.pkg`. **Not
   needed**: we ship a DMG.
3. **An App Store Connect API key for notarization** — `.p8` private key file, Key
   ID, and Issuer ID, created under App Store Connect → Users and Access → Keys.
   **Prefer this over an app-specific password.** The API key does not expire on a
   password change, works unattended, and is the credential form CI will eventually
   need. Store the `.p8` outside the repo; it is downloadable exactly once.

**Back up the Developer ID private key** (Keychain Access → export as `.p12`) the
same day you create it, to the same two places the updater minisign key goes.
Losing it means re-issuing a certificate and every already-distributed build keeps
verifying but you cannot sign a new one under the same key.

**Never commit** the `.p12`, the `.p8`, or any password. `beta-distribution-trust-runbook.md`'s
existing rule applies unchanged.

### 4.3 Entitlements

Create `src-tauri/entitlements.plist` and point
`bundle.macOS.entitlements` at it. Start with the **minimum** set and add only on
a demonstrated failure — every extra entitlement is a notarization risk and a
security surface.

**Start here:**

| Entitlement                             | Why                                                                                                                                                                                                                                                                                                               |
| --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `com.apple.security.device.audio-input` | **Required.** Dictation captures via cpal → CoreAudio. Under the hardened runtime this is denied without the entitlement, regardless of `NSMicrophoneUsageDescription`.                                                                                                                                           |
| `com.apple.security.cs.allow-jit`       | **Required for the bundled Node.** V8 JIT-compiles; under the hardened runtime that needs `MAP_JIT`, which needs this entitlement. Applies to the **`node` binary's own signature**, not the app's — a child process gets its own entitlements from its own code signature. Sign `Contents/MacOS/node` with this. |

**Add only if the first notarized build actually fails:**

| Entitlement                                                                    | When                                                                                                                                                                                                                                                                                                                             |
| ------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `com.apple.security.cs.allow-unsigned-executable-memory`                       | If `allow-jit` alone is not enough for the bundled Node. Broader and weaker; try `allow-jit` first.                                                                                                                                                                                                                              |
| `com.apple.security.cs.disable-library-validation`                             | Only if `node` needs to load an unsigned `.dylib` or `.node`. **We currently have zero native addons** (verified — `find agent-sidecar/node_modules -name '*.node'` is empty), so this should not be needed. If a future sidecar dependency adds one, this becomes required — treat a new native addon as a signing-plan change. |
| `com.apple.security.automation.apple-events` + `NSAppleEventsUsageDescription` | Only if macOS dictation delivery is implemented via AppleScript. Not needed while `delivery.rs` is Windows-only.                                                                                                                                                                                                                 |

**Explicitly NOT needed:**

- **`com.apple.security.network.client`** — this is an **App Sandbox** entitlement.
  PacketBench is not sandboxed and is not going to the Mac App Store (an app that
  spawns arbitrary user CLIs cannot be sandboxed). Outbound network from a
  non-sandboxed, hardened-runtime app needs no entitlement. Do not add it; adding
  sandbox entitlements to a non-sandboxed app is a common cargo-cult mistake.
- **`com.apple.security.get-task-allow`** — this is the _debug_ entitlement, and
  its presence is an **automatic notarization rejection**. Tauri's release build
  should not set it; verify with `codesign -d --entitlements -` before submitting.
- **Accessibility (`AXIsProcessTrusted`)** — there is no entitlement for this. It
  is a pure TCC grant the user makes in System Settings → Privacy & Security →
  Accessibility. Relevant only if foreground paste is implemented.

**Also add to `Info.plist`** — these are prompt _wording_, not capability, but
without them macOS shows a generic prompt for a dev tool that legitimately opens
the user's project folders:

```xml
<key>NSDocumentsFolderUsageDescription</key>
<string>PacketBench needs access to open projects you select in Documents.</string>
<key>NSDownloadsFolderUsageDescription</key>
<string>PacketBench needs access to open projects you select in Downloads.</string>
<key>NSDesktopFolderUsageDescription</key>
<string>PacketBench needs access to open projects you select on the Desktop.</string>
```

**TCC responsibility note, worth understanding before the acceptance run:** child
processes spawned by PacketBench — every PTY shell, every `claude`/`codex` CLI, the
`node` sidecar — inherit PacketBench as their TCC _responsible process_. So when the
`claude` CLI reads a file in `~/Documents`, macOS attributes the access to
PacketBench and prompts under PacketBench's name. This is correct and expected, but it
means the app can produce permission prompts for things the user did not
consciously ask _PacketBench_ to do. The existing `$HOME`-scan avoidance
(`commands/pty.rs:124-130`) is the right instinct; expect more of these during
acceptance.

### 4.4 Hardened runtime and nested code

Two rules govern everything here:

1. **Notarization requires the hardened runtime** (`codesign --options runtime`)
   and a **secure timestamp** (`--timestamp`). Tauri sets these when signing on
   macOS; verify rather than assume.
2. **Every Mach-O inside a signed bundle must itself be signed, and signing goes
   inside-out.** Nested code is signed first, the outer bundle last, because the
   outer signature seals a hash of the inner ones.

For PacketBench the nested-code inventory is short:

- `Contents/MacOS/node` — the bundled Node 24.15.0 (`externalBin`). **This is the
  only nested Mach-O.** It must be signed with the Developer ID Application
  certificate, hardened runtime, and `com.apple.security.cs.allow-jit`. Note that
  re-signing **replaces** whatever signature nodejs.org shipped; that is expected
  and required, because a Developer ID bundle cannot contain code signed by a
  different team.
- `Contents/Resources/agent-sidecar/**` — `dist/` and `node_modules/`. All pure
  JavaScript, ~thousands of small files, **no Mach-O**. Data resources do not need
  individual signatures; they are covered by the bundle seal. This is why the
  zero-native-addons finding matters so much — the usual "notarization died on
  nested unsigned binaries in node_modules" failure mode does not apply here, and
  should be re-checked whenever a sidecar dependency is added.

**Do not use `codesign --deep`.** It is deprecated by Apple, applies the same
entitlements to every nested binary (which is wrong — the app and `node` want
different sets), and silently skips things. Sign explicitly.

**Verification before every submission:**

```bash
APP="src-tauri/target/release/bundle/macos/PacketBench.app"

# Every Mach-O is signed, sealed resources are intact
codesign --verify --deep --strict --verbose=4 "$APP"

# Hardened runtime is on and get-task-allow is absent
codesign -d --entitlements - --verbose=4 "$APP"
codesign -d --entitlements - --verbose=4 "$APP/Contents/MacOS/node"
codesign -d -vvv "$APP" 2>&1 | grep -E 'Authority|TeamIdentifier|flags'
#   expect: Authority=Developer ID Application: <Name> (<TEAMID>)
#           flags=0x10000(runtime)
```

### 4.5 Build → sign → notarize → staple

Tauri v2 can do signing and notarization inline when the environment is set. The
env-var names below are already recognized by `scripts/release-readiness.mjs:182-201`
and `beta-distribution-trust-runbook.md`'s credential-hints list, so nothing new
needs inventing.

```bash
# --- signing ---
export APPLE_SIGNING_IDENTITY="Developer ID Application: <Name> (<TEAMID>)"
# CI only, importing the cert into a temp keychain:
# export APPLE_CERTIFICATE="<base64 of the .p12>"
# export APPLE_CERTIFICATE_PASSWORD="<p12 password>"

# --- notarization, App Store Connect API key form (preferred) ---
export APPLE_API_KEY="<Key ID>"
export APPLE_API_ISSUER="<Issuer UUID>"
export APPLE_API_KEY_PATH="$HOME/private_keys/AuthKey_<KeyID>.p8"

# --- build ---
pnpm install
TAURI_TARGET=aarch64-apple-darwin pnpm fetch-node   # MUST run; build.rs failure is non-fatal
pnpm build:macos                                     # wraps `tauri build` with the DMG retry
pnpm run release:readiness                           # macOS signals should now be PASS, not WARN
```

Then **verify by hand** rather than trusting the bundler. Tauri's exact
notarize-and-staple behaviour across versions is the one thing in this section
that cannot be confirmed from this machine (see §9), so run the manual path at
least once and record what was already done:

```bash
DMG="src-tauri/target/release/bundle/dmg/PacketBench_1.1.0_aarch64.dmg"

# Submit and wait (minutes, typically)
xcrun notarytool submit "$DMG" \
  --key "$APPLE_API_KEY_PATH" --key-id "$APPLE_API_KEY" --issuer "$APPLE_API_ISSUER" \
  --wait

# On "Invalid", read the actual reason — this is the step that teaches you
xcrun notarytool log <submission-id> \
  --key "$APPLE_API_KEY_PATH" --key-id "$APPLE_API_KEY" --issuer "$APPLE_API_ISSUER"

# Staple the ticket so first launch works offline
xcrun stapler staple "$DMG"
xcrun stapler validate "$DMG"

# Final acceptance check — this is what Gatekeeper will actually say
spctl -a -t open --context context:primary-signature -vvv "$DMG"
#   expect: source=Notarized Developer ID
```

`notarytool` ships with Xcode 13+ Command Line Tools, which the macOS
prerequisites already require.

### 4.6 Known failure modes, and what each means

| Symptom                                                                                                     | Cause                                                                                       | Fix                                                                                       |
| ----------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `notarytool` returns **Invalid**, log says "The binary is not signed with a valid Developer ID certificate" | An Apple Development (not Developer **ID**) cert was used, or `node` was missed             | Check `codesign -dvvv` on each Mach-O; re-issue as Developer ID Application               |
| Invalid: "The executable does not have the hardened runtime enabled"                                        | `--options runtime` missing                                                                 | Tauri should set it; verify `flags=0x10000(runtime)`                                      |
| Invalid: "The signature does not include a secure timestamp"                                                | Built offline, or the timestamp server was unreachable                                      | Re-sign online with `--timestamp`                                                         |
| Invalid: "The executable requests the `com.apple.security.get-task-allow` entitlement"                      | A debug build slipped through                                                               | Build release; strip the entitlement                                                      |
| App launches, dictation silently records nothing                                                            | Missing `com.apple.security.device.audio-input`                                             | Add it; §4.3                                                                              |
| Sidecar never becomes ready, no obvious error                                                               | `node` killed by the runtime for JIT, **or** it was never fetched (`build.rs` warning only) | Check `com.apple.security.cs.allow-jit` on `Contents/MacOS/node`; check the binary exists |
| Keychain prompts on every launch                                                                            | Signing identity changed between builds, invalidating the Keychain ACL                      | Expected while iterating; stabilizes once the identity is fixed                           |
| First launch after download still warns despite notarization                                                | Ticket not stapled — Gatekeeper had to reach Apple and could not                            | `xcrun stapler staple` the DMG                                                            |
| DMG bundling aborts mid-build                                                                               | Known `bundle_dmg.sh` Finder AppleScript flake                                              | Already handled by `pnpm build:macos`                                                     |

---

## 5. Architecture decision: **arm64-only for 1.1**, not universal

**Ship one `aarch64-apple-darwin` DMG. Do not build a universal binary. Add
`x86_64-apple-darwin` only if a user asks for it.**

Why not universal:

- **There is no universal Node tarball.** `scripts/fetch-node.js:83-94` fetches
  `darwin-x64` and `darwin-arm64` separately. A universal app would need us to
  `lipo` two ~90 MB Node binaries into one, add that step to `prebundle`, and then
  sign the fused result. That is new build machinery in a release window, for a
  binary that is already the largest thing in the bundle.
- **Size.** The DMG is already ~80–90 MB (`multi-platform-build.md:144`). Universal
  roughly doubles the native payload for a product whose entire audience runs one
  arch each.
- Apple Silicon is the overwhelming majority of active Macs in 2026, and it is the
  arch the owner's Mac runs.

Why per-arch is cheap if x64 is ever wanted: an Apple Silicon Mac can cross-compile
`x86_64-apple-darwin` natively — same SDK, just `rustup target add`. The plumbing
already exists:

```bash
rustup target add x86_64-apple-darwin
TAURI_TARGET=x86_64-apple-darwin pnpm fetch-node
pnpm tauri build --target x86_64-apple-darwin
```

Both DMGs are then signed and notarized identically. Note that this contradicts
`multi-platform-build.md:136-137` only in appearance — that line says you cannot
build **macOS from a non-Mac**, which remains true. Building x64 macOS **on** an
arm64 Mac is ordinary same-platform cross-compilation and is supported.

**Consequence for `minimumSystemVersion`:** an arm64-only build cannot run on
macOS 10.15 (Catalina predates Apple Silicon), so
`tauri.conf.json:49-51`'s `"10.15"` is misleading. **Propose bumping it to
`"11.0"`** for the arm64 bundle — or higher if the acceptance run is done on a
much newer OS and older ones are untested. Claiming support for an OS you have
never launched on is exactly the kind of unproven claim this repo's proof gates
exist to prevent. _(Source change — not applied by this plan.)_

---

## 6. SPIKE — Claude Code Keychain namespacing per `CLAUDE_CONFIG_DIR`

Supersedes the procedure in
[`spike-macos-keychain-namespacing.md`](./spike-macos-keychain-namespacing.md);
that document remains the authority on **why** this matters and **what we do with
each outcome**. Read its "Why this matters" and "What we do with each outcome"
sections first. This is the runnable version, now that a Mac exists.

**Question:** does `claude` derive a distinct macOS Keychain item name per
`CLAUDE_CONFIG_DIR`, so two `CliAccount`s stay isolated? Binary analysis of
`claude` 2.1.220 suggests a `sha256(configDir)[..8]` suffix; upstream issue
[#20553](https://github.com/anthropics/claude-code/issues/20553) reports a single
fixed item. The answer is version-dependent, so **record the version**.

**Prerequisites:** a Mac, a current `claude`, and **two real Claude accounts you
can log into**. Without two accounts, step 4 cannot distinguish "namespaced" from
"same account written twice". Budget 20 minutes plus whatever the token-expiry
wait in step 7 costs.

> Safety: this touches your normal login. Step 6 verifies the default account
> survived. Do not run this immediately before work you cannot afford to lose
> access to.

```bash
# ── 0. Record the version. The answer depends on it. ────────────────────────
claude --version | tee /tmp/spike-claude-version.txt

# ── 1. Baseline: what Keychain items exist before we touch anything ─────────
#    `dump-keychain` without -d lists metadata only and does NOT prompt.
security dump-keychain ~/Library/Keychains/login.keychain-db \
  | grep -i 'claude' | sort -u | tee /tmp/spike-kc-0-baseline.txt

# ── 2. Log in under the DEFAULT config dir, as ACCOUNT A ────────────────────
env -u CLAUDE_CONFIG_DIR claude     # complete /login as ACCOUNT A, then /exit
security dump-keychain ~/Library/Keychains/login.keychain-db \
  | grep -i 'claude' | sort -u | tee /tmp/spike-kc-1-default.txt

# ── 3. Predict the namespaced item name before creating it ─────────────────
export SPIKE_DIR="$HOME/.claude-spike"
mkdir -p "$SPIKE_DIR"
for candidate in "$SPIKE_DIR" "$(cd "$SPIKE_DIR" && pwd -P)"; do
  echo "$candidate -> Claude Code-$(printf '%s' "$candidate" | shasum -a 256 | cut -c1-8)"
done | tee /tmp/spike-predicted-names.txt

# ── 4. Log in under the SECOND config dir, as ACCOUNT B (must differ from A) ─
CLAUDE_CONFIG_DIR="$SPIKE_DIR" claude   # complete /login as ACCOUNT B, then /exit
security dump-keychain ~/Library/Keychains/login.keychain-db \
  | grep -i 'claude' | sort -u | tee /tmp/spike-kc-2-second.txt

# ── 5. THE ANSWER ──────────────────────────────────────────────────────────
diff /tmp/spike-kc-1-default.txt /tmp/spike-kc-2-second.txt
#   A NEW item appeared  -> NAMESPACED
#   No change            -> COLLIDES
# Confirm the predicted name directly (exits 0 if the item exists):
security find-generic-password -s "Claude Code-$(printf '%s' "$SPIKE_DIR" | shasum -a 256 | cut -c1-8)" >/dev/null 2>&1 \
  && echo "PREDICTED NAMESPACED ITEM EXISTS" || echo "predicted name not found"

# ── 6. Did ACCOUNT A survive? Run in a clean env. ──────────────────────────
env -u CLAUDE_CONFIG_DIR claude -p "Reply with only the email address of the signed-in account."
CLAUDE_CONFIG_DIR="$SPIKE_DIR" claude -p "Reply with only the email address of the signed-in account."
#   The two answers MUST differ and MUST match A and B respectively.

# ── 7. Refresh safety (the part that actually catches the bug) ─────────────
#    Wait past an access-token expiry — leave both alive, come back later,
#    and re-run step 6 verbatim. A silent refresh that writes to a shared
#    item shows up HERE, not in step 5.

# ── 8. Side questions worth answering while you are in here ────────────────
ls -la "$SPIKE_DIR"          # does .credentials.json exist on disk at all on macOS?
#   Does CLAUDE_SECURESTORAGE_CONFIG_DIR decouple the credential namespace?
CLAUDE_SECURESTORAGE_CONFIG_DIR="$HOME/.claude-spike2" CLAUDE_CONFIG_DIR="$SPIKE_DIR" claude -p "hi"
security dump-keychain ~/Library/Keychains/login.keychain-db | grep -i 'claude' | sort -u
```

### Pass / fail criteria

| Outcome          | Evidence required                                                                                                                                                                            | Consequence                                                                                                                                                                                                                                                                                                                                       |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **NAMESPACED**   | Step 5 shows a new item **and** the predicted-name lookup succeeds; step 6 returns two _different_ correct identities; step 7 still returns two different correct identities after a refresh | Multi-account CLI is safe on macOS. Replace the `"unknown"` status at `commands/provider_auth.rs:311-317` with a real Keychain-backed probe using the confirmed name derivation.                                                                                                                                                                  |
| **COLLIDES**     | Step 5 shows no new item, **or** step 6/7 returns the _same_ identity twice, **or** account A 401s                                                                                           | Multi-account CLI is unsafe on macOS. Take the `CLAUDE_CODE_OAUTH_TOKEN` fallback in the existing spike doc — but first verify [#37512](https://github.com/anthropics/claude-code/issues/37512) (token setup deleting the Keychain entry on exit) does not reproduce. Until then, keep `"unknown"` and consider disabling multi-account on macOS. |
| **INCONCLUSIVE** | Two items appear but the predicted name does not match, or `.credentials.json` turns out to exist on disk after all                                                                          | Record the actual observed item names verbatim and re-derive. Do **not** ship a probe based on a guessed derivation — the current `"unknown"` is the correct conservative answer and stays.                                                                                                                                                       |

Record the answer, the `claude --version`, and the raw `/tmp/spike-kc-*.txt`
files in this document, then close the spike doc.

### Cleanup

```bash
rm -rf "$HOME/.claude-spike" "$HOME/.claude-spike2"
# Delete any spike Keychain items via Keychain Access (search "Claude Code").
# Re-verify the default account still works:
env -u CLAUDE_CONFIG_DIR claude -p "say ok"
```

---

## 7. macOS packaged acceptance matrix

Parallel to the Windows matrix in the Fable 5 review §2 Phase 2, ordered by
packaging risk — highest first, so failures surface with buffer left.

Run twice: **once on an unsigned local build during the 1.0 fix buffer**
(quarantine cleared with `xattr -cr`), and **once on the signed + notarized DMG**
during 1.1. Items marked ⚠ can only be truly proven on the signed build.

| ID     | Item                                                                                                                                                             | Pass criterion                                                                                                                                                                                                                   |
| ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| MAC-01 | ⚠ **Gatekeeper first run.** Download the DMG over HTTPS (do not `scp` it — quarantine only attaches on a real download), mount, drag to `/Applications`, launch. | Opens with **no** security dialog. `spctl -a -t open --context context:primary-signature -vvv` reports `source=Notarized Developer ID`.                                                                                          |
| MAC-02 | **Bundled sidecar + bundled Node conversation.** One full API-agent turn on `api-claude-oauth` (Claude Agent SDK). Highest packaging risk on every platform.     | Response streams; `sidecar-status:changed` reports ready; protocol version reconciles at 11; no `PACKETBENCH_SIDECAR_PATH`/`PACKETBENCH_NODE_PATH` set.                                                                              |
| MAC-03 | ⚠ **Node JIT under hardened runtime.** Implied by MAC-02 but check the failure mode explicitly.                                                                  | Sidecar process stays alive; no `Killed: 9`; Console.app shows no `CODESIGNING` / `MAP_JIT` denials.                                                                                                                             |
| MAC-04 | **First run creates its data dirs.**                                                                                                                             | `~/.packetbench/` and `~/Library/Application Support/<LOG_DIR_NAME>/logs` created; log file written (`lib.rs:48-55`).                                                                                                              |
| MAC-05 | **GUI-launch CLI detection.** Launch from **Finder/Spotlight, not a terminal** — this is the `launchd` minimal-`PATH` case `8a872d44` fixed.                     | Homebrew/npm/nvm-installed `claude`, `codex`, `gh`, `git`, `node` are all detected in Settings.                                                                                                                                  |
| MAC-06 | **Sidecar binary actually shipped.** `build.rs:16-21` makes a missing Node a warning, not an error.                                                              | `PacketBench.app/Contents/MacOS/node` exists, is executable, and `--version` reports 24.15.0.                                                                                                                                      |
| MAC-07 | **PTY pane with the default shell.**                                                                                                                             | Pane opens, prompt renders, `echo $0` and `ls` work, resize reflows, colour is correct.                                                                                                                                          |
| MAC-08 | **PTY shell profiles.** Auto, Bash, Zsh, and one Custom (`/opt/homebrew/bin/fish`) — Custom is the only route to fish today (§3 item 7).                         | Each launches and reports the effective shell in the pane header. **Record whether Auto gives bash or zsh** — §3 item 6 says bash, which is wrong for macOS; this is the evidence that drives that fix.                          |
| MAC-09 | **Login-shell environment.** In an Auto pane, check an alias and a `PATH` entry defined only in `~/.zshrc`/`~/.zprofile`.                                        | Expected to **FAIL** as written (`terminalShells.ts:219-222` passes no `-l`). Record it; it is a known 1.1 fix, not a discovery.                                                                                                 |
| MAC-10 | **Coding CLI in a pane.** Launch `claude` in a PTY pane; verify the self-bootstrapping statusline (v0.10.3) renders.                                             | Statusline shows model/context/cost. No global `~/.claude/settings.json` was modified.                                                                                                                                           |
| MAC-11 | ⚠ **Keychain: API key set/read/delete.** Settings → add an Anthropic API key, restart the app, use it, delete it.                                                | Value round-trips. Note how many ACL prompts appear and whether "Always Allow" sticks across relaunch — a changed signing identity resets this.                                                                                  |
| MAC-12 | ⚠ **Keychain: SSH password.** Same cycle for an `ssh-<ServerConfig.id>` entry.                                                                                   | Round-trips; legacy-service migration path is not triggered on a fresh install.                                                                                                                                                  |
| MAC-13 | ⚠ **Microphone permission for dictation.** First dictation start.                                                                                                | macOS prompts with the `NSMicrophoneUsageDescription` text from `Info.plist`; granting it lets capture start; **denying it produces a comprehensible error** (§3 item 11 says it currently does not — record the actual string). |
| MAC-14 | **Dictation end to end.** Record → transcribe → insert into the composer.                                                                                        | Transcript appears. First run downloads the Whisper model to `~/.packetbench/models/` (`models.rs:133-136`) with SHA-256 verification.                                                                                             |
| MAC-15 | **Dictation native delivery is honest.** Toggle `systemWidePaste`.                                                                                               | Expected to **FAIL** — `delivery.rs:40-48` returns the Windows-only error. The pass criterion for 1.1 is that this control is **hidden on macOS**, not that it works.                                                            |
| MAC-16 | **Monitor on two displays.** Open a Monitor window, move it to a second display, resize, close.                                                                  | Renders correctly on both; closes with the main process; does not mount a PTY (Monitor v1 is read-only).                                                                                                                         |
| MAC-17 | **Traffic lights and window chrome.**                                                                                                                            | Native traffic lights present and functional; no duplicate Windows-style controls; the 78 px left inset looks right (`TitleBar.tsx:55-74`); full-screen works.                                                                   |
| MAC-18 | **App close and process cleanup.** Quit with PTY panes and a sidecar session live.                                                                               | App exits. **`ps aux \| grep -E 'node\|claude\|codex'` shows no survivors** — this is the macOS side of Fable 5 findings F4/F5, where orphans reparent to `launchd` and are unreachable.                                         |
| MAC-19 | **Flight attempt end to end.** One worktree-backed attempt: launch → run → accept.                                                                               | Worktree created and removed; `pkt/*` branch handled per the current contract; no leaked `git worktree` entries.                                                                                                                 |
| MAC-20 | **Relaunch and state restore.**                                                                                                                                  | Workspaces, panes, flights, issues, and settings all survive.                                                                                                                                                                    |
| MAC-21 | **TCC prompt inventory.** Open a project in `~/Documents` and let an agent read a file.                                                                          | Record every permission prompt macOS raises, its wording, and what triggered it (see the responsible-process note in §4.3). Deliverable is the list, not a pass/fail.                                                            |
| MAC-22 | ⚠ **Clean-machine install.** A Mac (or account) that has never run PacketBench.                                                                                    | Installs and reaches MAC-02 without any developer tooling present.                                                                                                                                                               |

Record results in a dated evidence file under `dev/` following the
`release-v0.10.3.md` pattern. **Build success is not acceptance** — the existing
rule in `backlog.md` applies unchanged.

---

## 8. Timeline

Dates assume the v1.0.0 plan holds. Nothing here moves the 1.0 date.

| When                                                 | Step                                                                                                                                                                                                                        |
| ---------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Day 0** (same day as the Windows cert application) | Enroll in the Apple Developer Program as an **Individual**. $99. This is the long pole.                                                                                                                                     |
| **On approval** (est. 1–2 days, possibly longer)     | Create the Developer ID Application certificate via Xcode; create the App Store Connect API key; **back up the private key twice** the same day.                                                                            |
| **1.0 fix buffer, 08-13 → 08-15**                    | `pnpm build:macos` unsigned; `xattr -cr`; run the §7 matrix (skipping ⚠ items). Run the §6 Keychain spike. File everything found.                                                                                           |
| **2026-08-19**                                       | **v1.0.0 ships, Windows only.** Unchanged.                                                                                                                                                                                  |
| **Week of 08-24**                                    | Fix the §3 blockers: entitlements file + `tauri.conf.json` `bundle.macOS` block, hide `systemWidePaste` on macOS, document CMake, Auto→`$SHELL`/zsh with `-l`, `minimumSystemVersion` → `11.0`, plus whatever §7 turned up. |
| **Week of 08-31**                                    | First signed + notarized build. **Budget for the first submission to be rejected** — §4.6 exists because this step teaches by failing. Re-run §7 including ⚠ items on the notarized DMG.                                    |
| **Early-to-mid September**                           | **v1.1.0: macOS arm64 DMG**, signed, notarized, stapled, published on GitHub Releases with hashes. Plus whatever else 1.1 carries.                                                                                          |

**If Apple enrollment stalls past 08-31**, ship 1.1 on its own merits without
macOS and move macOS to 1.2. Do not hold a release on a certificate — that is the
same rule the 1.0 plan already applies to Windows.

---

## 9. What cannot be known from this machine

Stated plainly so nobody mistakes desk research for verification. This plan was
written on WSL2 with no access to macOS, no Apple Developer account, and no Mac
to test against.

1. ~~**Whether `pnpm tauri build` currently succeeds on the owner's Mac at
   `main`.**~~ Substantially answered 2026-08-06: the owner reports months of
   sustained use on macOS, so the build and run paths are exercised well past
   the June 2026 commits cited above. What remains unverified is narrower —
   whether a build at the _current_ tree still succeeds after this pass's Rust
   changes, and that is checked simply by building once during the 1.0 fix
   buffer.
2. **Tauri v2's exact inline notarize-and-staple behaviour** at the pinned CLI
   version — specifically whether it staples the DMG as well as the `.app`, and
   whether it signs `externalBin` with the app's entitlements or its own. §4.5
   deliberately gives the manual `notarytool`/`stapler` path so this is verified
   rather than assumed on the first run.
3. **Whether `com.apple.security.cs.allow-jit` alone is sufficient** for Node
   24.15.0 under the hardened runtime, or whether
   `allow-unsigned-executable-memory` is also needed. Try the narrow one first.
4. **Current Apple Developer pricing, enrollment turnaround, and portal flow.**
   All §4.1/§4.2 figures are general knowledge with a January 2026 cutoff. The
   same review that produced this plan found the Windows CA landscape had shifted
   under it. **Re-verify at purchase time.**
5. **Exact current Gatekeeper behaviour for unsigned apps** on whatever macOS
   version the owner runs. The §1 argument only gets _stronger_ if the flow is
   more hostile than described, and the recommendation does not depend on the
   detail.
6. **The Keychain namespacing answer** (§6) — that is the entire point of the
   spike.
7. **Which macOS versions are actually supported.** `minimumSystemVersion` is a
   claim, not a test result. Only versions actually launched on should be claimed.
8. **Whether the owner's Mac is Apple Silicon or Intel.** §5 assumes Apple
   Silicon. If it is an Intel Mac, swap the triples — the arm64-only
   recommendation becomes x64-only, and the same cross-compile note does _not_
   apply in reverse (an Intel Mac cannot produce a signed arm64 build it can
   test).

---

## Related documents

- [`multi-platform-build.md`](./multi-platform-build.md) — prerequisites, build
  flow, target triples. Defers macOS signing/notarization **here**.
- [`beta-distribution-trust-runbook.md`](./beta-distribution-trust-runbook.md) —
  release gates and the credential-hint env vars. Defers macOS
  signing/notarization **here**.
- [`updater-setup.md`](./updater-setup.md) — the Tauri updater is not enabled. When
  it is, macOS needs its own `{{target}}` entries in `latest.json`
  (`darwin-aarch64`, and `darwin-x86_64` if that arch ships).
- [`spike-macos-keychain-namespacing.md`](./spike-macos-keychain-namespacing.md) —
  the _why_ and the _what we do about it_ for §6.
- [`../docs/reports/fable5-review-2026-08-05.md`](https://docs.ianlan.dev/reports/fable5-review-2026-08-05.md)
  §2 — the v1.0.0 definition this plan works alongside.
