import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, realpathSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const compiler = path.join(packageRoot, "node_modules/typescript/lib/tsc.js");

export function buildSidecar(directory = packageRoot) {
  assert(existsSync(compiler), "Install sidecar development dependencies before building");
  assert(!lstatSync(directory).isSymbolicLink(), "Sidecar package root must not be a link");
  const root = realpathSync(directory);
  const dist = path.resolve(root, "dist");
  assert.equal(path.dirname(dist), root, "Output must be the package's direct dist child");
  assert.equal(path.basename(dist), "dist");
  let entry;
  try {
    entry = lstatSync(dist);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  if (entry) {
    assert(
      entry.isDirectory() && !entry.isSymbolicLink(),
      "Refusing to clean linked or non-directory sidecar dist",
    );
    assert.equal(realpathSync(dist), dist, "Sidecar dist must resolve inside the package");
    // The exact absolute target was checked above. Never follow a replacement
    // output link or leave retired provider/planner JS in the bundled tree.
    rmSync(dist, { recursive: true, force: true });
  }
  execFileSync(process.execPath, [compiler, "-p", path.join(root, "tsconfig.json")], {
    cwd: root,
    stdio: "inherit",
    windowsHide: true,
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  buildSidecar();
}
