import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "vitest";
import { APP_NAME_LOWER } from "../src/lib/brand.ts";
import { assertCargoBundleTargets } from "./cargo-bundle-targets.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const manifest = path.join(root, "src-tauri/Cargo.toml");
const example = { name: "runtime-eval", kind: ["example"], "required-features": ["runtime-eval"] };
function metadata(extra = [], evalTarget = example) {
  return {
    packages: [
      {
        manifest_path: manifest,
        targets: [{ name: "fixture-app", kind: ["bin"] }, evalTarget, ...extra],
      },
    ],
  };
}

test("real Cargo metadata exposes only the app binary and a gated evaluation example", () => {
  const actual = JSON.parse(
    execFileSync(
      "cargo",
      ["metadata", "--no-deps", "--format-version", "1", "--manifest-path", manifest],
      {
        cwd: root,
        encoding: "utf8",
        windowsHide: true,
        timeout: 30_000,
      },
    ),
  );
  const config = JSON.parse(readFileSync(path.join(root, "src-tauri/tauri.conf.json"), "utf8"));
  assertCargoBundleTargets(actual, manifest, config.mainBinaryName ?? APP_NAME_LOWER);
});

test("a required-feature developer binary still fails the release guard", () => {
  assert.throws(
    () =>
      assertCargoBundleTargets(
        metadata([], { ...example, kind: ["bin"] }),
        manifest,
        "fixture-app",
      ),
    /Only the application/,
  );
});

test("a leftover autodiscovered binary fails even with the correct example present", () => {
  assert.throws(
    () =>
      assertCargoBundleTargets(
        metadata([{ name: "stray-cli", kind: ["bin"] }]),
        manifest,
        "fixture-app",
      ),
    /Only the application/,
  );
});

test("the evaluation lane remains opt-in", () => {
  assert.throws(
    () =>
      assertCargoBundleTargets(
        metadata([], { ...example, "required-features": [] }),
        manifest,
        "fixture-app",
      ),
    /must require/,
  );
});
