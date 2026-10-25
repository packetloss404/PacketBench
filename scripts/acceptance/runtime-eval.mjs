#!/usr/bin/env node
/**
 * R8 (H1) offline same-executor evaluation acceptance.
 *
 * Builds and runs the `runtime-eval` binary, which drives the production agent
 * runner through the deterministic fake lane, then archives the redacted
 * results and a source-stamped manifest under test-results/. Offline always:
 * the binary cannot reach a provider, the keyring, an ambient MCP server or a
 * real project.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { root, sourceIdentity } from "./common.mjs";

const startedAt = new Date().toISOString();
const output = path.join(
  root,
  "test-results/acceptance/runtime-eval",
  startedAt.replaceAll(/[:.]/g, "-"),
);
mkdirSync(output, { recursive: true });
const cliOut = path.join(output, "cli");
const isWindows = process.platform === "win32";
// Passed through `cmd /d /s /c`, so it must not be quoted: a relative path from
// src-tauri keeps it free of spaces whatever the checkout path is.
const cliRelative = path.relative(path.join(root, "src-tauri"), cliOut);
const source = sourceIdentity();

let status = 0;
try {
  execFileSync(
    isWindows ? (process.env.ComSpec ?? "cmd.exe") : "cargo",
    isWindows
      ? [
          "/d",
          "/s",
          "/c",
          `cargo run --features runtime-eval --bin runtime-eval -- --all --out ${cliRelative}`,
        ]
      : [
          "run",
          "--features",
          "runtime-eval",
          "--bin",
          "runtime-eval",
          "--",
          "--all",
          "--out",
          cliRelative,
        ],
    {
      cwd: path.join(root, "src-tauri"),
      stdio: "inherit",
      windowsHide: true,
      timeout: 45 * 60_000,
      // The archived results record the exact source they were produced from.
      env: { ...process.env, PACKETBENCH_SOURCE_IDENTITY: source.sourceSha256 },
    },
  );
} catch (error) {
  status = error.status ?? 1;
}

const resultsPath = path.join(cliOut, "results.json");
if (!existsSync(resultsPath)) {
  writeFileSync(
    path.join(output, "manifest.json"),
    JSON.stringify(
      {
        schemaVersion: 1,
        startedAt,
        source,
        cases: 0,
        passed: 0,
        failed: 0,
        error: "runtime-eval produced no results.json (build or case-load failure)",
      },
      null,
      2,
    ),
  );
  rmSync(cliOut, { recursive: true, force: true });
  console.error(`runtime-eval: no results at ${resultsPath}`);
  process.exit(1);
}

const results = JSON.parse(readFileSync(resultsPath, "utf8"));
const passed = results.filter((result) => result.correctness === "pass").length;
const failed = results.length - passed;

writeFileSync(path.join(output, "results.json"), JSON.stringify(results, null, 2));
writeFileSync(
  path.join(output, "manifest.json"),
  JSON.stringify(
    { schemaVersion: 1, startedAt, source, cases: results.length, passed, failed },
    null,
    2,
  ),
);
rmSync(cliOut, { recursive: true, force: true });

console.log(`runtime-eval: ${passed}/${results.length} passed (evidence: ${output})`);
process.exit(status !== 0 || failed > 0 ? 1 : 0);
