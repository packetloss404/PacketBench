#!/usr/bin/env node
// Real OpenSSH + production Rust handshake + Linux sidecar. No provider keys.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { root, config, dataDir, sourceIdentity, hash, treeHash } from "./acceptance/common.mjs";
import { buildSshArgs } from "../src/lib/ssh.ts";

const workspaceOnly = process.argv.includes("--workspace-only");

const out = path.join(
  root,
  "test-results/acceptance/live-ssh",
  new Date().toISOString().replaceAll(/[:.]/g, "-"),
);
mkdirSync(out, { recursive: true });
const scratch = mkdtempSync(path.join(tmpdir(), "sidecar-ssh-acceptance-"));
const image = `sidecar-ssh-acceptance:${process.pid}`;
let container;
let builtImage = false;
const report = {
  startedAt: new Date().toISOString(),
  version: config.version,
  workspaceOnly,
  source: sourceIdentity(),
  scope:
    "Native Workspace SSH PTY with production argument builder, binary resolver, decoder and batch dispatcher; optional production sidecar handshake/echo matrix. Harmless interactive fixture, no provider CLI, paid API or GUI interaction.",
  cases: [],
  passed: false,
};
const run = (exe, args, options = {}) =>
  execFileSync(exe, args, {
    cwd: root,
    encoding: "utf8",
    windowsHide: true,
    timeout: 120_000,
    maxBuffer: 32 * 1024 * 1024,
    ...options,
  });
const docker = (...args) => run("docker", args);
const remote = (...args) => docker("exec", container, ...args);
try {
  console.log("Building the sidecar from current source...");
  if (process.platform === "win32") run("cmd.exe", ["/d", "/s", "/c", "pnpm sidecar:build"]);
  else run("pnpm", ["sidecar:build"]);
  report.sidecarDistSha256 = treeHash(path.join(root, "agent-sidecar/dist"));
  console.log("Compiling the opt-in native SSH acceptance test...");
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
  assert(binary, "cargo did not return the library test executable");
  report.testBinarySha256 = hash(binary);
  mkdirSync(out, { recursive: true });
  writeFileSync(path.join(out, "build.jsonl"), compiled);
  const context = path.join(scratch, "context");
  mkdirSync(context);
  for (const file of ["package.json", "pnpm-lock.yaml", "dist"])
    cpSync(path.join(root, "agent-sidecar", file), path.join(context, file), { recursive: true });
  cpSync(path.join(root, "scripts/acceptance/ssh.Dockerfile"), path.join(context, "Dockerfile"));
  cpSync(path.join(root, "scripts/acceptance/fixture.mjs"), path.join(context, "fixture.mjs"));
  console.log("Building the disposable Linux OpenSSH fixture...");
  run("docker", ["build", "-t", image, context], { timeout: 15 * 60_000, stdio: "inherit" });
  builtImage = true;
  report.imageId = docker("image", "inspect", "--format", "{{.Id}}", image).trim();
  container = docker("run", "--detach", "--publish", "127.0.0.1::22", image).trim();
  const port = Number(docker("port", container, "22/tcp").trim().split(":").at(-1));
  assert(port > 0);
  const key = path.join(scratch, "client_key");
  run("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", key]);
  docker("cp", `${key}.pub`, `${container}:/root/.ssh/authorized_keys`);
  remote("chmod", "600", "/root/.ssh/authorized_keys");
  report.workspaceProviderCliPaths = remote(
    "sh",
    "-c",
    'for cli in claude codex opencode packetcode; do command -v "$cli" || true; done',
  )
    .trim()
    .split("\n")
    .filter(Boolean);
  report.workspaceFixture =
    "Harmless interactive Node process; provider CLI/authentication and Workspace GUI lifecycle remain separate acceptance.";
  docker(
    "cp",
    path.join(root, "scripts/acceptance/workspace-pty-fixture.mjs"),
    `${container}:/opt/workspace-pty-fixture.mjs`,
  );
  // Host keys come from the container control plane; never accept a network key.
  const publicKey = remote("cat", "/run/host_key.pub").trim().split(" ").slice(0, 2).join(" ");
  report.hostFingerprint = remote("ssh-keygen", "-lf", "/run/host_key.pub", "-E", "sha256")
    .trim()
    .split(/\s+/)[1];
  const home = path.join(scratch, "home");
  const knownHosts = path.join(home, dataDir, "ssh", "known_hosts");
  mkdirSync(path.dirname(knownHosts), { recursive: true });
  const correctPin = `[127.0.0.1]:${port} ${publicKey}\n`;
  writeFileSync(knownHosts, correctPin);
  const cases = [
    { name: "untrusted", mode: "untrusted", project: false, marker: false, readError: true },
    { name: "trusted", mode: "trusted", project: true, marker: true, readError: false },
    {
      name: "nested-project",
      mode: "trusted",
      child: true,
      project: false,
      marker: false,
      readError: true,
    },
    {
      name: "corrupt-trust",
      mode: "corrupt-trust",
      project: false,
      marker: false,
      readError: true,
    },
    {
      name: "malformed-project",
      mode: "malformed",
      project: false,
      marker: false,
      readError: true,
    },
    {
      name: "protocol-v11",
      mode: "untrusted",
      peer: "/opt/old-peer.cjs",
      expectedError: "must advertise protocol v12",
    },
    {
      name: "invalid-ready",
      mode: "untrusted",
      peer: "/opt/invalid-peer.cjs",
      expectedError: "invalid ready handshake",
    },
    {
      name: "wrong-host-key",
      mode: "untrusted",
      badKey: true,
      expectedError: "exited before its ready handshake",
      expectedStderr: "REMOTE HOST IDENTIFICATION HAS CHANGED",
    },
    { name: "reconnect", mode: "trusted", project: true, marker: true, readError: false },
  ];
  for (const c of workspaceOnly ? [] : cases) {
    remote("node", "/opt/fixture.mjs", c.mode, dataDir);
    writeFileSync(
      knownHosts,
      c.badKey ? `[127.0.0.1]:${port} ${readFileSync(`${key}.pub`, "utf8").trim()}\n` : correctPin,
    );
    const input = path.join(out, `${c.name}-input.json`);
    const output = path.join(out, `${c.name}.json`);
    const spec = {
      ssh: {
        host: "127.0.0.1",
        port,
        user: "root",
        remote_path: `/work/project${c.child ? "/child" : ""}`,
        key_path: key,
        auth_method: "key",
        host_fingerprint: report.hostFingerprint,
      },
      expectedError: c.expectedError,
      expectedStderr: c.expectedStderr,
    };
    // Input contains only a path to an ephemeral key, never key material.
    writeFileSync(input, JSON.stringify(spec));
    try {
      run(
        binary,
        [
          "commands::agent_sidecar::supervisor::live_ssh_tests::live_ssh_acceptance",
          "--exact",
          "--ignored",
          "--nocapture",
          "--test-threads=1",
        ],
        {
          env: {
            ...process.env,
            HOME: home,
            USERPROFILE: home,
            ACCEPTANCE_INPUT: input,
            ACCEPTANCE_OUTPUT: output,
            PACKETBENCH_REMOTE_NODE_PATH: "/usr/local/bin/node",
            PACKETBENCH_REMOTE_SIDECAR_PATH: c.peer ?? "/opt/sidecar/dist/index.js",
          },
        },
      );
      const evidence = JSON.parse(readFileSync(output, "utf8"));
      assert.equal(evidence.version, config.version);
      assert.equal(evidence.protocol, 12);
      if (c.expectedError) {
        assert.equal(evidence.handshakeAccepted, false);
        assert.equal(
          remote("sh", "-c", "test ! -s /root/request-received && echo clear").trim(),
          "clear",
          "a rejected peer received the request sentinel",
        );
      } else {
        const sources = evidence.events.find((e) => e.type === "mcp_sources");
        assert(sources, "missing MCP provenance event");
        assert.equal(
          sources.sources.some((s) => s.scope === "project"),
          c.project,
        );
        assert.equal(
          sources.sources.some((s) => s.name === "shared"),
          !c.project,
          "untrusted disable must not shadow global configuration",
        );
        assert.equal(sources.readErrors.length > 0, c.readError);
        assert.equal(
          remote("sh", "-c", "if test -f /root/probe-ran; then echo yes; else echo no; fi").trim(),
          c.marker ? "yes" : "no",
        );
        assert.equal(evidence.events.filter((e) => e.type === "done").length, 2);
        for (const source of sources.sources) {
          for (const field of ["command", "args", "env", "headers"])
            assert.equal(source[field], undefined);
        }
      }
      report.cases.push({ name: c.name, passed: true });
      console.log(`PASS ${c.name}`);
    } catch (error) {
      report.cases.push({ name: c.name, passed: false, error: error.message });
      throw error;
    }
  }
  const emptyConfig = path.join(home, "empty-ssh-config");
  writeFileSync(emptyConfig, "");
  const workspaceServer = {
    id: "disposable-workspace-acceptance",
    name: "Disposable Workspace acceptance",
    host: "127.0.0.1",
    port,
    username: "root",
    authMethod: "key",
    keyPath: key,
    hostFingerprint: report.hostFingerprint,
    installedAgents: [],
  };
  for (const mode of [
    "interactive",
    "failed-exit",
    "burst",
    "wrong-host-key",
    "disconnect",
    "reconnect",
  ]) {
    const name = `workspace-${mode}`;
    const input = path.join(out, `${name}-input.json`);
    const output = path.join(out, `${name}.json`);
    const readyPath = path.join(out, `${name}-ready`);
    writeFileSync(
      knownHosts,
      mode === "wrong-host-key"
        ? `[127.0.0.1]:${port} ${readFileSync(`${key}.pub`, "utf8").trim()}\n`
        : correctPin,
    );
    const args = [
      // Isolate this key-only acceptance process from user SSH config/agents.
      "-F",
      emptyConfig,
      "-o",
      "BatchMode=yes",
      "-o",
      "IdentitiesOnly=yes",
      "-o",
      `GlobalKnownHostsFile=${emptyConfig}`,
      ...buildSshArgs(
        workspaceServer,
        "/work/project",
        "/usr/local/bin/node",
        ["/opt/workspace-pty-fixture.mjs"],
        knownHosts,
      ),
    ];
    writeFileSync(input, JSON.stringify({ args, mode, readyPath }));
    const env = {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      ACCEPTANCE_INPUT: input,
      ACCEPTANCE_OUTPUT: output,
    };
    try {
      const testArgs = [
        "commands::pty::live_ssh_tests::workspace_live_ssh_acceptance",
        "--exact",
        "--ignored",
        "--nocapture",
        "--test-threads=1",
      ];
      if (mode === "disconnect") {
        const child = spawn(binary, testArgs, { cwd: root, env, windowsHide: true, stdio: "pipe" });
        let diagnostic = "";
        child.stdout.on("data", (chunk) => {
          diagnostic += chunk;
        });
        child.stderr.on("data", (chunk) => {
          diagnostic += chunk;
        });
        const completion = new Promise((resolve, reject) => {
          child.once("error", reject);
          child.once("exit", (code) => resolve(code));
        });
        // Attach immediately so a spawn error cannot become unhandled while
        // the readiness marker is still being polled.
        void completion.catch(() => {});
        let timer;
        try {
          const deadline = Date.now() + 60_000;
          while (!existsSync(readyPath) && child.exitCode === null && Date.now() < deadline)
            await new Promise((resolve) => setTimeout(resolve, 25));
          assert(existsSync(readyPath), "Workspace disconnect test never became ready");
          // Kill only authenticated sshd children in OUR disposable container;
          // keep the listener and host key for the following reconnect case.
          remote(
            "node",
            "-e",
            `const fs=require('node:fs'); for(const id of fs.readdirSync('/proc')) { if(!/^\\d+$/.test(id)||Number(id)===1) continue; try { if(fs.readFileSync('/proc/'+id+'/comm','utf8').trim().startsWith('sshd')) process.kill(Number(id),'SIGKILL'); } catch {} }`,
          );
          const code = await Promise.race([
            completion,
            new Promise((_, reject) => {
              timer = setTimeout(
                () => reject(new Error("Workspace disconnect test timed out")),
                60_000,
              );
            }),
          ]);
          assert.equal(code, 0, diagnostic);
        } finally {
          clearTimeout(timer);
          if (child.exitCode === null) child.kill();
        }
      } else run(binary, testArgs, { env });
      const evidence = JSON.parse(readFileSync(output, "utf8"));
      assert.equal(evidence.passed, true, evidence.error);
      report.cases.push({ name, passed: true, details: evidence.details });
      console.log(`PASS ${name}`);
    } catch (error) {
      report.cases.push({ name, passed: false, error: error.message });
      throw error;
    }
  }
  assert.equal(
    sourceIdentity().sourceSha256,
    report.source.sourceSha256,
    "Source changed during live acceptance; rerun against a stable snapshot",
  );
  assert.equal(
    treeHash(path.join(root, "agent-sidecar/dist")),
    report.sidecarDistSha256,
    "Sidecar dist changed during acceptance",
  );
  report.passed = true;
} catch (error) {
  report.error = error.message;
  process.exitCode = 1;
  console.error(error.message);
} finally {
  // Delete only resources created by this invocation. Retain evidence on failure.
  if (container) {
    try {
      docker("rm", "--force", container);
    } catch (e) {
      report.cleanupError = e.message;
      process.exitCode = 1;
    }
  }
  if (builtImage) {
    try {
      docker("image", "rm", image);
    } catch (e) {
      report.cleanupError = e.message;
      process.exitCode = 1;
    }
  }
  assert(
    path.dirname(scratch) === path.resolve(tmpdir()) &&
      path.basename(scratch).startsWith("sidecar-ssh-acceptance-"),
  );
  rmSync(scratch, { recursive: true, force: true });
  report.finishedAt = new Date().toISOString();
  mkdirSync(out, { recursive: true });
  writeFileSync(path.join(out, "report.json"), JSON.stringify(report, null, 2));
  console.log(`Evidence: ${out}`);
}
