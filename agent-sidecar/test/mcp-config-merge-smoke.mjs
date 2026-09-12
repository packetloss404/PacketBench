// Unit smoke for the pure `mcp-config` merge logic (S8-Phase-B, Slice A).
//
// Exercises `loadMcpFromFs` directly against the compiled module — no sidecar
// process, no protocol IPC. Each case builds a throwaway HOME (holding
// ~/.claude/settings.json) and a throwaway project dir (holding .mcp.json),
// points the loader at them, and asserts the merged servers + summary. The
// loader must NEVER throw: read/parse failures land in `readErrors`.
//
// Exits 0 on success, 1 on the first failed assertion.

import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { existsSync } from "node:fs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const modulePath = resolve(__dirname, "..", "dist", "mcp-config.js");
if (!existsSync(modulePath)) {
  console.error(`[mcp-config-merge-smoke] compiled module not found at ${modulePath}`);
  console.error(`[mcp-config-merge-smoke] run 'pnpm sidecar:install && pnpm sidecar:build' first`);
  process.exit(1);
}

const { loadMcpFromFs } = await import(pathToFileURL(modulePath).href);

const cleanups = [];

/**
 * Build a scenario. `global` / `project` may be:
 *   - an object → written as `{ mcpServers: <object> }`
 *   - "malformed" → written as invalid JSON
 *   - undefined → file not created (missing)
 * Returns the loader result for `loadMcpFromFs(projectDir, sessionId)`.
 */
async function runScenario(global, project, trust = "trusted") {
  const home = await mkdtemp(join(tmpdir(), "packetbench-mcp-home-"));
  const projectDir = await mkdtemp(join(tmpdir(), "packetbench-mcp-proj-"));
  cleanups.push(home, projectDir);
  await mkdir(join(home, ".test-data"), { recursive: true });
  if (trust !== "missing") {
    const body = trust === "malformed" ? "{ broken" : JSON.stringify({
      version: trust === "future" ? 2 : 1,
      projects: trust === "trusted" ? [projectDir] :
        trust === "parent" ? [dirname(projectDir)] : ["relative/path"],
    });
    await writeFile(join(home, ".test-data", "trusted-projects.json"), body);
  }

  if (global !== undefined) {
    await mkdir(join(home, ".claude"), { recursive: true });
    const body =
      global === "malformed" ? "{ not valid json" : JSON.stringify({ mcpServers: global });
    await writeFile(join(home, ".claude", "settings.json"), body, "utf8");
  }
  if (project !== undefined) {
    const body =
      project === "malformed" ? "}{ broken" : JSON.stringify(project);
    await writeFile(join(projectDir, ".mcp.json"), body, "utf8");
  }

  // `os.homedir()` honors HOME on POSIX and USERPROFILE on Windows; point the
  // loader's global source at our throwaway home for the duration of this call.
  const savedHome = process.env.HOME;
  const savedUserProfile = process.env.USERPROFILE;
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  try {
    return await loadMcpFromFs(projectDir, "mcp-config-merge-smoke", ".test-data");
  } finally {
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
    if (savedUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = savedUserProfile;
  }
}

async function run() {
  // Denied project config cannot add, replace, OR disable global authority.
  for (const trust of ["missing", "malformed", "future", "parent", "relative"]) {
    const { servers, summary } = await runScenario(
      { shared: { command: "global-node" }, keep: { command: "global-keep" } },
      { mcpServers: {
        shared: { command: "repo-node" }, keep: { disabled: true },
        added: { command: "repo-added" },
      } }, trust,
    );
    assert.equal(servers.shared.command, "global-node", trust);
    assert.equal(servers.keep.command, "global-keep", trust);
    assert.equal(servers.added, undefined, trust);
    assert.ok(summary.readErrors.some(e => e.message.includes("trusted-projects.json")), trust);
  }
  {
    const { servers } = await runScenario(
      { off: { command: "global-node" } },
      { mcpServers: { off: { disabled: true } } },
    );
    assert.equal(servers.off, undefined, "trusted project may disable a global server");
  }
  // 1) project-over-global override on the same server name.
  {
    const { servers, summary } = await runScenario(
      { shared: { type: "http", url: "https://global.example/mcp" } },
      { mcpServers: { shared: { type: "sse", url: "https://project.example/sse" } } },
    );
    assert.equal(servers.shared.type, "sse", "project entry must override global");
    assert.equal(servers.shared.url, "https://project.example/sse");
    const info = summary.sources.find((s) => s.name === "shared");
    assert.equal(info.scope, "project", "override must be reported at project scope");
    assert.equal(info.transport, "sse");
    assert.equal(summary.readErrors.length, 0);
  }

  // 2) global-only.
  {
    const { servers, summary } = await runScenario(
      { g: { type: "stdio", command: "gnode" } },
      undefined,
    );
    assert.equal(servers.g.command, "gnode");
    assert.equal(summary.sources.length, 1);
    assert.equal(summary.sources[0].scope, "global");
    assert.equal(summary.readErrors.length, 0);
  }

  // 3) project-only.
  {
    const { servers, summary } = await runScenario(undefined, {
      mcpServers: { p: { type: "http", url: "https://p.example/mcp" } },
    });
    assert.equal(servers.p.url, "https://p.example/mcp");
    assert.equal(summary.sources.length, 1);
    assert.equal(summary.sources[0].scope, "project");
    assert.equal(summary.readErrors.length, 0);
  }

  // 4) both missing → empty, no throw, no errors.
  {
    const { servers, summary } = await runScenario(undefined, undefined);
    assert.deepEqual(servers, {});
    assert.equal(summary.sources.length, 0);
    assert.equal(summary.readErrors.length, 0);
  }

  // 5) malformed global → global skipped, project retained, one readError.
  {
    const { servers, summary } = await runScenario("malformed", {
      mcpServers: { keep: { type: "stdio", command: "node" } },
    });
    assert.equal(servers.keep.command, "node", "project must survive a bad global");
    assert.equal(Object.keys(servers).length, 1);
    assert.equal(summary.readErrors.length, 1);
    assert.equal(summary.readErrors[0].scope, "global");
    assert.ok(summary.readErrors[0].message.length > 0);
  }

  // 6) malformed project → project skipped, global retained, one readError.
  {
    const { servers, summary } = await runScenario(
      { keep: { type: "http", url: "https://g.example/mcp" } },
      "malformed",
    );
    assert.equal(servers.keep.url, "https://g.example/mcp", "global must survive a bad project");
    assert.equal(Object.keys(servers).length, 1);
    assert.equal(summary.readErrors.length, 1);
    assert.equal(summary.readErrors[0].scope, "project");
  }

  // 7) valid JSON but no `mcpServers` object → empty, no error.
  {
    const { servers, summary } = await runScenario(undefined, { somethingElse: true });
    assert.deepEqual(servers, {});
    assert.equal(summary.readErrors.length, 0);
  }

  // 8) stdio entry missing `type` is normalized to `type: "stdio"`.
  {
    const { servers, summary } = await runScenario(
      { implicit: { command: "node", args: ["s.js"] } },
      undefined,
    );
    assert.equal(servers.implicit.type, "stdio", "missing type must default to stdio");
    assert.equal(servers.implicit.command, "node");
    assert.equal(summary.sources.find((s) => s.name === "implicit").transport, "stdio");
  }

  // 9) disabled:true entries are dropped and not reported.
  {
    const { servers, summary } = await runScenario(
      {
        on: { type: "stdio", command: "node" },
        off: { type: "stdio", command: "node", disabled: true },
      },
      undefined,
    );
    assert.ok(servers.on, "enabled entry retained");
    assert.equal(servers.off, undefined, "disabled entry dropped");
    assert.equal(summary.sources.length, 1);
    assert.equal(summary.sources[0].name, "on");
    // Normalized entry must NOT carry the `disabled` key onward.
    assert.equal(servers.on.disabled, undefined);
  }

  // 10) Missing trust metadata must fail closed even when HOME is unavailable.
  {
    const projectDir = await mkdtemp(join(tmpdir(), "packetbench-mcp-proj-"));
    cleanups.push(projectDir);
    await writeFile(
      join(projectDir, ".mcp.json"),
      JSON.stringify({ mcpServers: { p: { type: "stdio", command: "node" } } }),
      "utf8",
    );
    const savedHome = process.env.HOME;
    delete process.env.HOME;
    try {
      const { servers, summary } = await loadMcpFromFs(projectDir, "mcp-config-merge-smoke");
      assert.equal(servers.p, undefined, "project scope requires explicit host trust metadata");
      assert.ok(Array.isArray(summary.readErrors), "summary must be well-formed with HOME unset");
    } finally {
      if (savedHome === undefined) delete process.env.HOME;
      else process.env.HOME = savedHome;
    }
  }

  console.log("[mcp-config-merge-smoke] OK");
}

try {
  await run();
} catch (err) {
  console.error(`[mcp-config-merge-smoke] FAIL: ${err?.stack ?? err}`);
  process.exitCode = 1;
} finally {
  await Promise.all(
    cleanups.map((dir) => rm(dir, { recursive: true, force: true }).catch(() => undefined)),
  );
}
