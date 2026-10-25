import assert from "node:assert/strict";
import path from "node:path";

// Tauri enumerates Cargo binary targets even when required-features stops
// Cargo from building one. Developer executables therefore belong in examples.
export function assertCargoBundleTargets(metadata, manifestPath, applicationName) {
  const pkg = metadata.packages.find(
    (candidate) => path.resolve(candidate.manifest_path) === path.resolve(manifestPath),
  );
  assert(pkg, "Cargo metadata did not contain the application package");
  const binaries = pkg.targets.filter((target) => target.kind.includes("bin"));
  assert.deepEqual(
    binaries.map((target) => target.name),
    [applicationName],
    "Only the application may be a Cargo binary target; move developer CLIs to gated examples before bundling",
  );
  const evaluator = pkg.targets.filter((target) => target.name === "runtime-eval");
  assert.equal(evaluator.length, 1, "Expected one offline evaluation example");
  assert.deepEqual(evaluator[0].kind, ["example"], "runtime-eval must not be an installer binary");
  assert(
    evaluator[0]["required-features"]?.includes("runtime-eval"),
    "The evaluation example must require the runtime-eval feature",
  );
  return { application: applicationName, example: evaluator[0].name };
}
