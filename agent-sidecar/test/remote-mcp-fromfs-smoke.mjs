// Remote-owned MCP config smoke for the PacketBench agent sidecar (S8-Phase-B,
// Slice A).
//
// This does not open an SSH connection. It exercises the end-to-end
// `sourceMcpFromFs` path against the running sidecar process: with
// PACKETBENCH_REMOTE_SIDECAR=1 and an SSH workspace, a `start_session` carrying
// `sourceMcpFromFs: true` and an EMPTY `mcpServers` must cause the sidecar to
// read its OWN filesystem (a throwaway HOME's ~/.claude/settings.json plus the
// project's .mcp.json), emit an `mcp_sources` event listing those servers, and
// then run the session to `done`.
//
// Three variants:
//   A) untrusted project → no project command executes, even for probing.
//   B) trusted valid config → project probe executes, no source readErrors.
//   C) malformed .mcp.json → mcp_sources carries a populated readErrors entry
//      and the session still reaches `done` (no crash).
//
// Exits 0 if all variants pass, 1 otherwise.

import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, resolve, join } from "node:path";
import { existsSync } from "node:fs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Headroom for a BUSY machine, not for a slow sidecar. Booting dist/index.js
// (which eagerly imports the Anthropic, OpenAI and MCP SDKs) takes ~0.9s on an
// idle box, so the old 3-5s budgets were fine in isolation — and failed anyway
// when these smokes ran beside a cargo build using every core. These smokes
// assert protocol behaviour, not latency, so the budget sits well clear of
// contention rather than close to the measured best case.
const TIMEOUT_MS = 20_000;
const sidecarEntry = resolve(__dirname, "..", "dist", "index.js");

if (!existsSync(sidecarEntry)) {
  console.error(`[remote-mcp-fromfs-smoke] sidecar entry not found at ${sidecarEntry}`);
  console.error(`[remote-mcp-fromfs-smoke] run 'pnpm sidecar:install && pnpm sidecar:build' first`);
  process.exit(1);
}

const cleanups = [];

/**
 * Run one variant against a fresh sidecar process.
 * @param {{ malformed: boolean }} opts
 * @returns {Promise<{ mcpSources: object, done: boolean }>}
 */
async function runVariant({ malformed, trusted = true }) {
  const home = await mkdtemp(join(tmpdir(), "packetbench-remote-mcp-home-"));
  const projectDir = await mkdtemp(join(tmpdir(), "packetbench-remote-mcp-proj-"));
  cleanups.push(home, projectDir);
  const marker = join(home, "project-command-ran");
  if (trusted) {
    await mkdir(join(home, ".test-data"), { recursive: true });
    await writeFile(join(home, ".test-data", "trusted-projects.json"),
      JSON.stringify({ version: 1, projects: [projectDir] }));
  }

  await mkdir(join(home, ".claude"), { recursive: true });
  await writeFile(
    join(home, ".claude", "settings.json"),
    JSON.stringify({
      mcpServers: { "global-srv": { type: "http", url: "https://global.example/mcp" } },
    }),
    "utf8",
  );
  await writeFile(
    join(projectDir, ".mcp.json"),
    malformed
      ? "{ this is not valid json"
      : JSON.stringify({
          mcpServers: { "project-srv": {
            command: process.execPath,
            args: ["-e", `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ran')`],
          } },
        }),
    "utf8",
  );

  const sessionId = malformed ? "remote-mcp-fromfs-malformed" : "remote-mcp-fromfs-valid";

  return await new Promise((resolveFn, rejectFn) => {
    const child = spawn(process.execPath, [sidecarEntry], {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      env: {
        ...process.env,
        PACKETBENCH_REMOTE_SIDECAR: "1",
        HOME: home,
        USERPROFILE: home,
      },
    });

    const stderrChunks = [];
    let settled = false;
    let gotReady = false;
    let mcpSources = null;
    let done = false;

    const timer = setTimeout(() => {
      finish(new Error(`timed out after ${TIMEOUT_MS}ms`));
    }, TIMEOUT_MS);

    function finish(err, value) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        child.stdin.end();
      } catch {
        // ignore
      }
      const killTimer = setTimeout(() => {
        try {
          child.kill();
        } catch {
          // ignore
        }
      }, 300);
      child.on("exit", () => clearTimeout(killTimer));
      if (err) {
        if (stderrChunks.length > 0) {
          console.error(`[remote-mcp-fromfs-smoke] sidecar stderr:\n${stderrChunks.join("")}`);
        }
        rejectFn(err);
      } else {
        resolveFn(value);
      }
    }

    child.on("error", (err) => finish(err));
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => stderrChunks.push(chunk));

    child.stdout.setEncoding("utf8");
    const rl = createInterface({ input: child.stdout });
    rl.on("line", (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      let event;
      try {
        event = JSON.parse(trimmed);
      } catch (err) {
        finish(new Error(`non-JSON stdout line: ${trimmed} (${err.message})`));
        return;
      }

      if (event.type === "ready") {
        gotReady = true;
        child.stdin.write(
          JSON.stringify({
            type: "start_session",
            sessionId,
            provider: "echo",
            model: "echo",
            systemPrompt: "",
            allowedTools: [],
            mcpServers: {},
            sourceMcpFromFs: true,
            projectTrustDataDir: ".test-data",
            projectPath: projectDir,
            initialMessage: "remote mcp fromfs smoke",
            workspace: {
              kind: "ssh",
              serverId: "srv-smoke",
              host: "example.com",
              port: 22,
              user: "ian",
              remotePath: projectDir,
            },
          }) + "\n",
        );
        return;
      }
      if (event.sessionId !== sessionId) return;
      if (event.type === "mcp_sources") {
        mcpSources = event;
        return;
      }
      if (event.type === "error") {
        finish(new Error(`unexpected error event: ${event.message ?? "(no message)"}`));
        return;
      }
      if (event.type === "done") {
        done = true;
        if (!gotReady) {
          finish(new Error("expected ready before done"));
          return;
        }
        finish(null, { mcpSources, done, commandRan: existsSync(marker) });
      }
    });
  });
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

async function run() {
  // Opening an untrusted SSH project must not execute even a capability probe.
  {
    const { mcpSources, done, commandRan } = await runVariant({ malformed: false, trusted: false });
    assert(done, "untrusted project session should still run with global config");
    assert(!commandRan, "untrusted project command executed during startup/probing");
    assert(mcpSources.sources.every(s => s.scope === "global"), "project source must be excluded");
    assert(mcpSources.readErrors.some(e => e.message.includes("trusted-projects.json")),
      "trust refusal must reach the UI");
    console.log("[remote-mcp-fromfs-smoke] PASS: untrusted command never executed");
  }
  // Variant A: valid config on both scopes.
  {
    const { mcpSources, done, commandRan } = await runVariant({ malformed: false });
    assert(done, "valid variant must reach done");
    assert(commandRan, "trusted control must execute the probe's marker command");
    assert(mcpSources, "valid variant must emit an mcp_sources event");
    const names = mcpSources.sources.map((s) => s.name).sort();
    assert(
      names.includes("global-srv") && names.includes("project-srv"),
      `mcp_sources must list both temp servers, got ${JSON.stringify(names)}`,
    );
    assert(
      Array.isArray(mcpSources.readErrors) && mcpSources.readErrors.length === 0,
      `valid variant must have no readErrors, got ${JSON.stringify(mcpSources.readErrors)}`,
    );
    // Security invariant: the event must not leak command/env/headers.
    for (const s of mcpSources.sources) {
      assert(
        s.command === undefined && s.env === undefined && s.headers === undefined,
        `mcp_sources entry leaked a secret-bearing field: ${JSON.stringify(s)}`,
      );
    }
    console.log("[remote-mcp-fromfs-smoke] PASS: valid config");
  }

  // Variant B: malformed project .mcp.json → populated readErrors, no crash.
  {
    const { mcpSources, done } = await runVariant({ malformed: true });
    assert(done, "malformed variant must still reach done (no crash)");
    assert(mcpSources, "malformed variant must emit an mcp_sources event");
    assert(
      mcpSources.readErrors.length >= 1,
      `malformed variant must report a readError, got ${JSON.stringify(mcpSources.readErrors)}`,
    );
    assert(
      mcpSources.readErrors.some((e) => e.scope === "project"),
      "malformed project readError must be scoped 'project'",
    );
    // The valid global scope must still have been sourced.
    assert(
      mcpSources.sources.some((s) => s.name === "global-srv"),
      "global server must survive a malformed project file",
    );
    console.log("[remote-mcp-fromfs-smoke] PASS: malformed project config");
  }

  console.log("[remote-mcp-fromfs-smoke] OK");
}

try {
  await run();
} catch (err) {
  console.error(`[remote-mcp-fromfs-smoke] FAIL: ${err?.stack ?? err}`);
  process.exitCode = 1;
} finally {
  await Promise.all(
    cleanups.map((dir) => rm(dir, { recursive: true, force: true }).catch(() => undefined)),
  );
}
