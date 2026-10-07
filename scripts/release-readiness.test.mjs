import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { onTestFinished, test } from "vitest";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function readiness(artifact, { directory = false, empty = false } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), "readiness-test-"));
  onTestFinished(() => {
    assert.equal(path.dirname(dir), path.resolve(tmpdir()));
    assert(path.basename(dir).startsWith("readiness-test-"));
    rmSync(dir, { recursive: true, force: true });
  });
  mkdirSync(path.join(dir, "scripts"));
  mkdirSync(path.join(dir, "src-tauri"));
  copyFileSync(
    path.join(root, "scripts/release-readiness.mjs"),
    path.join(dir, "scripts/release-readiness.mjs"),
  );
  const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
  pkg.version = "0.14.8";
  writeFileSync(path.join(dir, "package.json"), JSON.stringify(pkg));
  writeFileSync(path.join(dir, "src-tauri/Cargo.toml"), '[package]\nversion = "0.14.8"\n');
  writeFileSync(
    path.join(dir, "src-tauri/tauri.conf.json"),
    JSON.stringify({
      version: "0.14.8",
      bundle: { active: true, targets: "all" },
    }),
  );
  const target = path.join(dir, "target");
  const artifactDir = path.join(target, "release/bundle/nsis");
  mkdirSync(artifactDir, { recursive: true });
  const file = path.join(artifactDir, artifact);
  if (directory) mkdirSync(file);
  else writeFileSync(file, empty ? "" : "fixture installer bytes");
  const result = spawnSync(
    process.execPath,
    [path.join(dir, "scripts/release-readiness.mjs"), "--skip-gates"],
    {
      cwd: dir,
      encoding: "utf8",
      windowsHide: true,
      env: {
        ...process.env,
        CARGO_TARGET_DIR: target,
        PACKETBENCH_RELEASE_TARGET: "windows",
        PACKETBENCH_UPDATER_MANIFEST: "",
      },
    },
  );
  assert.ifError(result.error);
  return result;
}

test("accepts an exact-version nonempty installer without claiming skipped gates passed", () => {
  const result = readiness("Example_0.14.8_x64-setup.exe");
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /\[PASS\] Bundle artifacts for windows/);
  assert.match(result.stdout, /NOT EXECUTED/);
});

test.each(["Example_0.14.80_x64-setup.exe", "Example_0.14.8-beta.1_x64-setup.exe"])(
  "rejects a different release whose filename contains the version: %s",
  (name) => {
    const result = readiness(name);
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stdout, /\[FAIL\] Bundle artifacts for windows/);
  },
);

test.each([{ empty: true }, { directory: true }])(
  "rejects unusable installer entries: %j",
  (options) => {
    const result = readiness("Example_0.14.8_x64-setup.exe", options);
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stdout, /\[FAIL\] Bundle artifacts for windows/);
  },
);
