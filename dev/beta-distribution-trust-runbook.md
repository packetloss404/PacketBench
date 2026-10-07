# Beta Distribution Trust Runbook

Last updated: 2026-10-06

This is the current trust checklist for public beta builds. The goal is to keep
release friction boring: versions line up, sidecar assets are embedded, updater
readiness is explicit, and signed/notarized release candidates fail fast when
required credentials are missing.

## Existing local artifacts and tags

An owner-only version tag and a public installer release are separate actions.
Signing remains deferred for owner-only use under the recorded cost decision;
the public distribution requirements below still apply when that scope changes.

The existing 0.14.8 Windows installers were built from clean commit
`9367b7a1b0d2239df48eb1524705c593873df011`. The
[release record](./existing-code-stabilization-2026-09-24.md) contains their
hashes, installation checks and the final pre-tag pass. Later documentation
and release-tooling commits do not change that artifact identity.

Before creating a tag for existing artifacts:

1. Confirm the intended tag does not exist locally or remotely; never move an
   existing release tag to repair a provenance mismatch.
2. Verify installer hashes against the saved build manifest and use its source
   commit as the tag target. For the existing 0.14.8 pair that is `9367b7a1`.
   If a different source commit should own the release, build and record new
   artifacts from it instead of assigning old installers to that source.
3. Read the exact validation scope. Startup and isolated echo checks do not
   establish Workspace dogfooding or paid-provider/hardware acceptance. The
   owner reported on October 6 that dogfooding is not yet sufficient.
4. When tagging is requested, use an annotated tag recording the source and
   evidence. Publishing installers, deploying services and enabling the updater
   remain separate actions. No tag or publication was performed in this pass.

The readiness script verifies artifact presence and exact filename versions.
It does not replace manifest/hash verification or validate signing credentials
cryptographically.

## Local Release Gate

Run the lightweight gate before any installer build:

```bash
pnpm run release:gate
```

It checks:

- `package.json`, `src-tauri/tauri.conf.json`, and `src-tauri/Cargo.toml`
  share the same version.
- Tauri bundling is enabled.
- the build pipeline runs `prebundle` and the frontend build.
- the bundled Node runtime and `agent-sidecar` resources are configured.
- `agent-sidecar/dist/index.js` and the Windows Node runtime exist.
- the updater runbook is present.

For release-candidate packaging, use the strict mode:

```bash
pnpm run release:gate:strict
```

Strict mode additionally requires a clean git tree, at least one signing
credential hint, and updater signing configuration. The strict gate is expected
to fail on ordinary dev machines until certificate and updater secrets are
available.

## Trust Gates

| Gate                           | Status                                                      | Owner notes                                                                                                                                                           |
| ------------------------------ | ----------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Windows executable build       | Active                                                      | `pnpm tauri build` produces NSIS and MSI installers.                                                                                                                  |
| Sidecar + Node embedding       | Active                                                      | `prebundle` fetches Node, builds sidecar, prunes production deps.                                                                                                     |
| Version drift check            | Active                                                      | `pnpm run release:gate`.                                                                                                                                              |
| Signing credential check       | Active gate, credentials pending                            | strict mode fails unless signing env is present.                                                                                                                      |
| Updater signing check          | Active gate, updater deferred                               | strict mode fails until updater config and signing key are wired.                                                                                                     |
| Windows SmartScreen reputation | Pending real certificate                                    | requires signed releases and reputation over time.                                                                                                                    |
| macOS codesign/notarization    | Pending Apple credentials; owned by `macos-release-plan.md` | Enrollment is the day-0 long pole. Entitlements, hardened runtime, `notarytool`, and stapling are specified in [`macos-release-plan.md`](./macos-release-plan.md) §4. |

## Release Candidate Flow

1. Update versions in all three manifests.
2. Run `pnpm run release:gate`.
3. Run the normal local verification suite for the release branch.
4. Run `pnpm tauri build`.
5. On the release machine, run `pnpm run release:gate:strict`.
6. Sign/notarize installers and upload artifacts.
7. If updater is enabled for that release, generate and sign `latest.json`.

## Credential Hints

The strict gate recognizes these environment variables:

- Windows: `WINDOWS_SIGNTOOL_CERT_SHA1`, `WINDOWS_SIGNING_CERT_PATH`
- Tauri updater: `TAURI_SIGNING_PRIVATE_KEY`,
  `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`
- macOS: `APPLE_SIGNING_IDENTITY`, `APPLE_CERTIFICATE`, `APPLE_API_KEY`,
  `APPLE_API_KEY_PATH`

Do not commit private keys or certificate material. Keep release credentials in
the release machine, CI secret store, or platform keychain.
