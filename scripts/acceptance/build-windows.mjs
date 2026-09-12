#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { APP_NAME_LOWER } from "../../src/lib/brand.ts";
import { root, config, hash, sourceIdentity } from "./common.mjs";
import { executableHashes } from "./executable-hashes.mjs";

assert.equal(process.platform, "win32", "Windows installer acceptance requires Windows");
const output = path.join(
  root,
  "test-results/acceptance/windows",
  new Date().toISOString().replaceAll(/[:.]/g, "-"),
);
mkdirSync(output, { recursive: true });
const source = sourceIdentity();
const runPnpm = (command) =>
  execFileSync("cmd.exe", ["/d", "/s", "/c", command], {
    cwd: root,
    stdio: "inherit",
    windowsHide: true,
    timeout: 45 * 60_000,
  });
const metadata = JSON.parse(
  execFileSync("cargo", ["metadata", "--no-deps", "--format-version", "1"], {
    cwd: path.join(root, "src-tauri"),
    encoding: "utf8",
    windowsHide: true,
  }),
);
const release = path.join(metadata.target_directory, "release");
const binaryName = `${config.mainBinaryName ?? APP_NAME_LOWER}.exe`;
const files = [];
function add(file, installedPath) {
  assert(existsSync(file), `missing bundle input: ${file}`);
  files.push({ sourcePath: file, installedPath, sha256: hash(file) });
}
function addTree(dir, prefix) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    const relative = path.posix.join(prefix, entry.name);
    if (entry.isDirectory()) addTree(file, relative);
    else if (entry.isFile()) add(file, relative);
    else throw new Error(`Unexpected non-file in pruned resources: ${file}`);
  }
}
try {
  runPnpm("pnpm tauri build --bundles nsis,msi");
  assert.equal(
    sourceIdentity().sourceSha256,
    source.sourceSha256,
    "Sources changed during bundling; do not attribute these artifacts to the recorded snapshot",
  );
  add(path.join(release, binaryName), binaryName);
  // The unpatched release executable is restored after each bundle. NSIS and
  // MSI consume different bytes, so the install verifier needs the NSIS hash.
  const binaryHashes = executableHashes(path.join(release, binaryName));
  files[0].sha256 = binaryHashes.nsis;
  add(path.join(root, "src-tauri/binaries/node-x86_64-pc-windows-msvc.exe"), "node.exe");
  addTree(path.join(root, "agent-sidecar/dist"), "agent-sidecar/dist");
  addTree(path.join(root, "agent-sidecar/node_modules"), "agent-sidecar/node_modules");
  add(path.join(root, "agent-sidecar/package.json"), "agent-sidecar/package.json");
  const installers = [
    path.join(release, "bundle/nsis", `${config.productName}_${config.version}_x64-setup.exe`),
    path.join(release, "bundle/msi", `${config.productName}_${config.version}_x64_en-US.msi`),
  ].map((file) => ({
    path: file,
    sha256: hash(file),
    executableSha256: file.endsWith(".msi") ? binaryHashes.msi : binaryHashes.nsis,
  }));
  const manifest = {
    schemaVersion: 1,
    builtAt: new Date().toISOString(),
    version: config.version,
    productName: config.productName,
    binaryName,
    unpatchedExecutableSha256: binaryHashes.original,
    source,
    installers,
    files,
  };
  writeFileSync(path.join(output, "manifest.json"), JSON.stringify(manifest, null, 2));
  console.log(`Installer manifest: ${path.join(output, "manifest.json")}`);
} finally {
  // Tauri's prebundle intentionally prunes sidecar dev dependencies.
  runPnpm("pnpm sidecar:install");
}
