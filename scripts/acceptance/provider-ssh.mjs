#!/usr/bin/env node
// A real, existing CLI login stays on its execution host. No credential export.
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { buildSshArgs } from "../../src/lib/ssh.ts";
import { config, hash, root, sourceIdentity } from "./common.mjs";
import { assertProviderReply, parseProviderResult } from "./provider-ssh-result.mjs";

const host = process.argv[2];
assert(
  host && !host.startsWith("-"),
  "Usage: node scripts/acceptance/provider-ssh.mjs <existing-SSH-alias>",
);
const out = path.join(
  root,
  "test-results/acceptance/provider-ssh",
  new Date().toISOString().replaceAll(/[:.]/g, "-"),
);
mkdirSync(out, { recursive: true });
const run = (exe, args, options = {}) =>
  execFileSync(exe, args, {
    cwd: root,
    windowsHide: true,
    encoding: "utf8",
    timeout: 120_000,
    maxBuffer: 32 * 1024 * 1024,
    ...options,
  });
const report = {
  startedAt: new Date().toISOString(),
  version: config.version,
  source: sourceIdentity(),
  hostAlias: host,
  scope:
    "One genuine authenticated Claude CLI print-mode reply via production SSH argument builder and native PTY decoder/dispatcher; no interactive GUI/TUI, other provider, or remote project/tool acceptance.",
  passed: false,
};
try {
  const sshConfig = new Map(
    run("ssh", ["-G", host])
      .trim()
      .split(/\r?\n/)
      .map((line) => {
        const space = line.indexOf(" ");
        return [line.slice(0, space), line.slice(space + 1)];
      }),
  );
  const hostname = sshConfig.get("hostname");
  const username = sshConfig.get("user");
  const port = Number(sshConfig.get("port"));
  const keyPath = sshConfig.get("identityfile")?.replace(/^~(?=[/\\])/, homedir());
  assert(
    hostname && username && port && keyPath && existsSync(keyPath),
    "Existing SSH alias needs a usable configured key",
  );
  const knownHosts = path.join(homedir(), ".ssh/known_hosts");
  const matched = run("ssh-keygen", [
    "-F",
    port === 22 ? hostname : `[${hostname}]:${port}`,
    "-f",
    knownHosts,
  ]);
  const publicKey = matched
    .split("\n")
    .find((line) => !line.startsWith("#") && line.includes("ssh-ed25519"));
  assert(publicKey, "An existing pinned ed25519 host key is required");
  const keyBlob = publicKey.trim().split(/\s+/)[2];
  const fingerprint = `SHA256:${createHash("sha256").update(Buffer.from(keyBlob, "base64")).digest("base64").replace(/=+$/, "")}`;
  const probe = (command) =>
    run("ssh", [
      "-o",
      "BatchMode=yes",
      "-o",
      "StrictHostKeyChecking=yes",
      "-o",
      "ConnectTimeout=5",
      host,
      command,
    ]);
  const cliPath = probe(
    'command -v claude || test -x "$HOME/.local/bin/claude" && printf "%s/.local/bin/claude\\n" "$HOME"',
  )
    .trim()
    .split("\n")[0];
  assert(
    cliPath.startsWith("/") && !cliPath.includes("'"),
    "No supported remote Claude CLI path found",
  );
  report.cliVersion = probe(`'${cliPath}' --version`).trim();
  const auth = JSON.parse(
    probe(
      `'${cliPath}' auth status --json | python3 -c 'import json,sys; s=json.load(sys.stdin); print(json.dumps({k:s.get(k) for k in ["loggedIn","authMethod","apiProvider"]}))'`,
    ),
  );
  assert.equal(auth.loggedIn, true, "The selected CLI needs an existing valid login");
  report.auth = auth;
  report.hostFingerprint = fingerprint;
  const server = {
    id: "existing-provider-acceptance",
    name: host,
    host: hostname,
    port,
    username,
    authMethod: "key",
    keyPath,
    hostFingerprint: fingerprint,
    installedAgents: ["claude"],
  };
  const marker = `WORKSPACE_PROVIDER_${randomBytes(6).toString("hex")}_42`;
  const prompt = `Compute 17 plus 25. Reply with exactly ${marker} and nothing else.`;
  const args = [
    "-o",
    "BatchMode=yes",
    "-o",
    "IdentitiesOnly=yes",
    ...buildSshArgs(
      server,
      "/tmp",
      cliPath,
      [
        "--print",
        "--safe-mode",
        "--tools",
        "",
        "--no-session-persistence",
        "--output-format",
        "json",
        "--model",
        "sonnet",
        "--effort",
        "low",
        "--max-budget-usd",
        "0.05",
        "--system-prompt",
        "Complete the requested arithmetic transport check. Do not use tools or inspect files.",
        prompt,
      ],
      knownHosts,
      { DISABLE_AUTOUPDATER: "1" },
    ),
  ];
  console.log("Compiling the opt-in native provider PTY acceptance test...");
  const compiled = run(
    "cargo",
    ["test", "--lib", "--no-run", "--message-format=json", "--jobs", "2"],
    { cwd: path.join(root, "src-tauri"), timeout: 20 * 60_000 },
  );
  const binary = compiled
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line))
    .find(
      (item) =>
        item.reason === "compiler-artifact" &&
        item.profile.test &&
        item.executable &&
        item.target.kind.includes("lib"),
    )?.executable;
  assert(binary, "Native test binary was not produced");
  report.testBinarySha256 = hash(binary);
  const input = path.join(out, "input.json");
  const output = path.join(out, "native-output.json");
  writeFileSync(input, JSON.stringify({ args }));
  console.log("Requesting one bounded reply from the existing remote Claude login...");
  try {
    run(
      binary,
      [
        "commands::pty::live_ssh_tests::workspace_provider_ssh_acceptance",
        "--exact",
        "--ignored",
        "--nocapture",
        "--test-threads=1",
      ],
      { env: { ...process.env, ACCEPTANCE_INPUT: input, ACCEPTANCE_OUTPUT: output } },
    );
  } catch (error) {
    if (!existsSync(output)) throw error;
    // Preserve the structured provider error (e.g. expired OAuth) below,
    // instead of reporting only the native test's nonzero process status.
  }
  const evidence = JSON.parse(readFileSync(output, "utf8"));
  const result = parseProviderResult(evidence.output);
  report.providerResult = {
    result: result.result,
    turns: result.num_turns,
    usage: result.usage,
    modelUsage: result.modelUsage,
    totalCostUsd: result.total_cost_usd,
    durationMs: evidence.durationMs,
    exitCode: evidence.exitCode,
    drained: evidence.drained,
  };
  assertProviderReply(result, marker);
  assert.equal(evidence.exitCode, 0, evidence.error || "Native provider CLI failed");
  assert.equal(evidence.drained, true);
  assert.equal(
    sourceIdentity().sourceSha256,
    report.source.sourceSha256,
    "Source changed during acceptance; rerun against a frozen snapshot",
  );
  report.passed = true;
  console.log("PASS genuine provider reply through native SSH PTY");
} catch (error) {
  report.error = error.message;
  process.exitCode = 1;
  console.error(error.message);
} finally {
  report.finishedAt = new Date().toISOString();
  writeFileSync(path.join(out, "report.json"), JSON.stringify(report, null, 2));
  console.log(`Evidence: ${out}`);
}
