# Local Quality Gates

PacketBench intentionally has no GitHub CI workflows. Release confidence is built from local checks run before merging or shipping.

## Runner: `pnpm gates`

`scripts/quality-gates.mjs` schedules the same package scripts the ladder below
describes, and is the recommended entry point for anything larger than a
one-gate check.

- `pnpm gates:fast` — format, lint, typecheck, Vitest.
- `pnpm gates:full` — everything `pnpm check` covers, plus typecheck.
- `pnpm gates:changed` — full tier, minus gates no changed file can affect.
- `pnpm gates -- --dry-run` prints the schedule without running anything;
  `--list` prints the catalog; `--json` emits a machine-readable summary.

Two behaviours are the point of it:

- **Nothing short-circuits.** The `&&` chains stop at the first failure, so a
  Prettier nit hides whether the Rust side even compiles. The runner always
  runs every selected gate and ends in a pass/fail/duration table.
- **Contention is modelled, not hoped for.** Gates declare the resources they
  touch — the cargo target-dir lock, `src/generated/tauri-schema.ts` (which the
  schema gate overwrites while `tsc` and Vitest read it), the sidecar tree, the
  fixed Vite port — and the scheduler serialises exactly those pairs.

  There is also a `cpu` lock for machine capacity. Vitest, the sidecar smokes
  and Playwright all assert on elapsed time, while cargo will use every core it
  can get; run together they produce failures that look like product bugs. A
  sidecar smoke timed out at twenty seconds doing work that takes ~0.9s on an
  idle machine. Those three gates hold `cpu` exclusively and everything else
  holds it shared, so the cargo chain still runs packed with the cheap gates.

`--changed` is deliberately conservative: it runs a gate whenever it cannot
prove the gate is unaffected, and disables itself entirely when its own
definitions change. It will over-run; it must never under-run.

An **opt-in** pre-push hook is available via `pnpm gates:install-hook`
(`gates:uninstall-hook` removes it). It is never installed automatically.

## Quality Ladder

The runner executes these scripts; it does not replace them. Run any of them
directly when you want a single signal.

1. **Preflight: fast local check**
   - Use the preflight command when you want a quick signal before handing work off.
   - Run `pnpm preflight`.
   - It stays focused on common regressions: format check, bounded lint, Vitest, and frontend build.

2. **Check: full local release confidence**
   - Use the full check command before release-oriented work or larger changes.
   - Run `pnpm check`.
   - It covers the complete local quality surface: preflight, Playwright, sidecar checks and smoke tests, schema validation, Rust check, and Rust tests.

3. **Release readiness: beta distribution gate**
   - Use the readiness check after producing local Tauri bundles. It now executes the quality gates itself, so climb the ladder in order rather than running the suite twice: `pnpm check` for the full suite, then `pnpm run release:readiness --skip-gates` for the distribution surface alone.
   - Run `pnpm run release:readiness`.
   - It reports release metadata, signing signals, updater manifest readiness, and bundle artifact presence, then executes the full quality-gate suite for the release handoff.
   - Run `pnpm run release:readiness:report` when you only need a non-failing status snapshot during setup. `--report-only` implies `--skip-gates` and additionally suppresses the non-zero exit, so it can never report a failure.

## Individual Gates

- **Lint scripts**
  - Run `pnpm lint` or `pnpm lint:src` for TypeScript, React, and shared frontend rules over `src/` and `e2e/`.
  - Run `pnpm lint:strict` when you want warnings to fail the command.

- **Format check**
  - Run `pnpm format:check` before submitting changes.
  - It checks the repo surfaces that currently have a stable Prettier baseline: package/config files, this quality-gates doc, and Playwright specs.
  - Keep broader source formatting fixes separate from unrelated edits when possible so reviews stay readable.

- **Vitest**
  - Run `pnpm test` for frontend unit and store-level coverage.
  - Prefer targeted Vitest runs while iterating, then include the full local test run for broader confidence.

- **Playwright**
  - Playwright coverage is local web-mode only.
  - Run `pnpm e2e` for browser smoke and interaction checks.
  - Use it for browser-facing frontend behavior that can run under the Vite web app. It does not exercise the native Tauri shell or desktop-only APIs directly.

- **Rust check and test**
  - Run `pnpm rust:check` for fast Rust compile confidence.
  - Run `pnpm rust:test` for Rust tests.
  - Run Rust tests locally when backend command, provider, state, or orchestration behavior changes.

- **Sidecar smoke scripts**
  - Run `pnpm sidecar:check` after changes to `agent-sidecar/`, provider routing, protocol types, or supervisor integration.
  - These scripts validate the Node sidecar protocol and basic provider registry behavior without requiring the full desktop app.

- **Schema check**
  - Run `pnpm check:tauri-schema` after changing shared contracts, generated types, persisted state shapes, or request/response payloads.
  - Schema failures should be fixed before any release-confidence check is considered complete.

- **Release gate**
  - Run `pnpm run release:gate` to validate the release preconditions that must hold at bundle time.
  - It is wired into `prebundle`, so it now runs automatically on every `pnpm tauri build`. It previously never ran automatically at all.
  - Run `pnpm run release:gate:strict` to additionally require a clean worktree, signing configuration, and updater configuration.

- **Release readiness**
  - Run `pnpm run release:readiness` before publishing a beta installer.
  - The script does not read certificate contents or secrets. It checks config/env signals, updater manifest shape, and expected bundle artifacts for the host platform, then executes the ten leaf quality gates in order and gates on each exit code: `format:check`, `lint:src`, `test`, `build`, `e2e`, `sidecar:check`, `check:tauri-schema`, `rust:check`, `rust:test`, and `remoteagents:check`.
  - `pnpm run check` is reported as a row derived from those ten results rather than re-executed, because it expands to exactly them. The script re-derives that relationship from `package.json` on every run and refuses to claim the composite if the scripts have drifted.
  - Each gate runs under a 45-minute timeout by default; override it with `PACKETBENCH_RELEASE_GATE_TIMEOUT_MS`.
  - Run `pnpm run release:readiness --skip-gates` when you have just run `pnpm check` or `pnpm gates:full` and only need the distribution surface. It finishes in about a second, marks the ten gate rows `WARN … NOT EXECUTED` rather than claiming a pass it did not earn, and still fails on real problems. `PACKETBENCH_RELEASE_SKIP_GATES=1` is equivalent.
  - Artifact presence requires a nonempty regular file with the exact version field in its Tauri filename. Neighboring versions, prereleases, empty files and directories cannot satisfy it. This is a presence check, not proof of installer integrity or source identity: verify hashes against the build manifest before tagging or distributing existing artifacts.
  - The target platform is detected from the running Node process and named in the header, for example `Target: linux (from host detection (linux, WSL))`. Set `PACKETBENCH_RELEASE_TARGET` to `windows`, `macos`, or `linux` when the bundle was produced on another platform, such as a Windows-side build inspected from WSL. An unrecognised value fails and lists the valid ones rather than searching every platform's artifacts.
  - Bundle globs resolve the build root in order: `CARGO_TARGET_DIR`, then a `[build] target-dir` in `src-tauri/.cargo/config.toml`, then `cargo metadata`, then the default `src-tauri/target`. Windows drive-letter paths are translated when running under WSL. The header prints which root was used and where it came from, for example `Bundle root: /mnt/c/Users/... (from src-tauri/.cargo/config.toml [build] target-dir)`, so a build redirected out of the tree needs no manual directory.
  - Warnings mean distribution work is still incomplete, usually signing or updater setup, or that gates were skipped and are therefore unverified. Failures mean the local release handoff is structurally blocked, such as missing artifacts, mismatched versions, a missing gate command, or a gate that actually failed.

## Notes

- No GitHub Actions, workflow files, or remote CI gates are expected for this repository.
- Local checks are the source of truth; document any skipped gate in the handoff when it is relevant.
- There is no need to run every gate for every small edit, but release-facing changes should climb the full ladder.
