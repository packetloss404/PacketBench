# Installer and live SSH evidence — 2026-09-08

Raw-artifact retention note (September 11): a later Playwright run cleared the
old shared `test-results` directory. Recorded observations/hashes below survive;
the referenced raw directories do not. Playwright output is now isolated under
`test-results/playwright`; see `workspace-usability-evidence-2026-09-11.md`.

**Result:** the 0.14.1 NSIS upgrade, installed payload/runtime checks, normal
application startup, and nine real OpenSSH cases passed. The application was
closed normally by the owner before installation and reopened afterward.

Reproduce with [`installer-ssh-acceptance.md`](./installer-ssh-acceptance.md).
This is an unsigned local verification build, not a tagged public release.

## Source and artifacts

The build and final SSH run used the same stable, explicitly dirty source
snapshot based on HEAD `7019094b51ddef8d8d0d67de8306fc6c93fe2f3a`:

`6cdf29d33c565c10be2db2b26b288f6d05dc4ece4f0c4e4da1880468d673ca5d`

That fingerprint binds 1,323 tracked/untracked, nonignored source files.
The build wrapper verified no source drift during bundling. Afterward, the
validation harness gained the per-format executable-hash correction and its
four regression tests; documentation was then updated with these results.
Those later harness/docs changes did not change application inputs or rebuild
the artifacts. The original build fingerprint is preserved in the manifest.

Artifacts are in `C:/Users/ianwalmsley/packetbench-build/release/bundle/`:

| Artifact | Bytes | SHA-256 |
| --- | ---: | --- |
| `nsis/PacketBench_0.14.1_x64-setup.exe` | 89,359,659 | `6c56e7301d0bf3b4bc9fef9671c0e4d3623ce9cdaf5fa6ff6b5ea2eb602621e8` |
| `msi/PacketBench_0.14.1_x64_en-US.msi` | 139,441,364 | `11b533258edec4582c3420f5813de23985cfe8825cfd42fc2d1dbec6bf57c34c` |

Tauri modifies the executable's bundle marker for each format and restores the
unpatched build output afterward. The harness derives each unsigned payload
hash and refuses ambiguous markers or signed binaries requiring per-format
signing evidence. Both derived hashes were independently matched to the actual
inputs captured while `makensis` and WiX `light` were running:

| Executable | SHA-256 |
| --- | --- |
| Unpatched build output | `f7632df13c8049cdb456a6dc131306234aa2bb30b142c6363b23a66c3dbeef87` |
| NSIS payload / installed app | `f51401193fe2f05f7b8c817c70bcb84e68446d06553b1062e9b8527791c97d87` |
| MSI payload input | `29f5c259125db45486771125fc47053a1c7cd850cc81d644fe40cf6f7cc07172` |

## Installer and startup

- Normal production `prebundle` and frontend build succeeded. Release gate:
  **11/11**. Optimized Rust build succeeded; only existing `ts-rs` warnings.
  Frontend reported the existing circular vendor-chunk/Browserslist warnings.
- Negative checks refused an altered installer hash and an upgrade while the
  old app was open. A missing install failed promptly. The older installed
  sidecar was correctly rejected for protocol 11.
- NSIS upgrade ran after the owner's close confirmation, from **21:14:43 to
  21:15:25 UTC**, exit **0**. Installed **8,683/8,683** manifest files matched,
  including the executable, Node, sidecar dist, and all pruned dependencies.
- Product version **0.14.1**; bundled Node **v24.15.0**; packaged sidecar
  **protocol 12**, two exact echo turns, two `done` events. The echo check used
  an isolated temporary HOME and no provider key.
- Normal startup at **21:16:20 UTC**: installed process PID **23616** remained
  responsive with a native `PacketBench` window, WebView2 child, and the
  **installed** `node.exe` child. This is process/window startup evidence, not
  a claim that every GUI workflow was exercised.
- Sidecar development dependencies were restored after bundling.

The prior 0.14.0 installed executable hash was
`ca9dde7d5816d625c7333c5464074a5f255f7011d6a7f64c1b545e0651339135`.
The MSI was built and hashed; the performed upgrade was NSIS, not MSI.

Raw local evidence:
`test-results/acceptance/windows/2026-09-08T20-48-00-425Z/`
(`manifest.json`, `prior-installation.json`, `installation.json`,
`packaged-sidecar.json`, `startup.json`, and both captured bundler input hashes).

## Live SSH

Final run: **20:47:50–20:50:21 UTC**, **9/9 passed**:

1. Untrusted root excludes project MCP commands, preserves the global server
   despite a project disable entry, and never writes the probe marker.
2. Trusted root loads project MCP, applies its disable, and writes the marker.
3. Parent trust does not authorize a nested project.
4. Corrupt host trust file fails closed.
5. Malformed project config reports an error while retaining global config.
6. Protocol v11 is rejected before any request bytes reach the peer.
7. Invalid ready JSON is rejected before any request bytes reach the peer.
8. A different pinned host key is rejected with OpenSSH's changed-key error.
9. A fresh connection after restoring the pin completes both turns.

All successful cases echoed two exact turns. Source summaries omitted
commands/args/env/headers. The native test used production SSH arguments,
launch script, handshake, bounded reader, and session encoder. A deliberately
fake key sentinel made request-before-handshake leakage observable.

The Linux OpenSSH server ran in a disposable Docker container on a random
loopback port, with a generated client key and explicitly pinned host key
obtained through Docker's control plane. The container, image tag, and temporary
keys were removed. No existing server, user SSH config, keyring, or trust list
was changed.

- Sidecar dist SHA-256:
  `142b0b581c095ffcc2b6d698408741f4db10ad22d52fb8acf8791c8a2dcc2c23`
- Image ID:
  `sha256:fd84a7734cc039b42b3cdb7f01c69b297d98aa8af58f2d3478d1e01ae38a4c92`
- Raw local evidence:
  `test-results/acceptance/live-ssh/2026-09-08T20-47-50-232Z/`

Additional checks passed: focused Rust handshake/encoder/protocol-floor
regressions, four executable-hash harness tests, Prettier, and `git diff --check`.
The earlier full source suites remain attributed to September 7 in `HANDOFF.md`.

Paid Claude/OpenAI providers, full Tauri session lifecycle, WAN/independently
hosted servers, Windows-sshd targets, Flight, Monitor and hardware acceptance
remain separate ledger items. This evidence closes the consolidation's
installer and real SSH handshake/project-trust proof gaps at the scope above.
