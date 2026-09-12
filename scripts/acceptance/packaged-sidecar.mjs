import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";

const [installDir, output] = process.argv.slice(2);
assert(installDir && output, "usage: packaged-sidecar.mjs INSTALL_DIR REPORT.json");
const home = mkdtempSync(path.join(tmpdir(), "installed-sidecar-acceptance-"));
const child = spawn(
  path.join(installDir, "node.exe"),
  [path.join(installDir, "agent-sidecar/dist/index.js")],
  {
    cwd: home,
    env: { ...process.env, HOME: home, USERPROFILE: home },
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
  },
);
const closed = new Promise((resolve) => child.once("close", resolve));
const report = { passed: false, startedAt: new Date().toISOString(), turns: 0 };
let stderr = "";
child.stderr.setEncoding("utf8");
child.stderr.on("data", (chunk) => {
  stderr = (stderr + chunk).slice(-16384);
});
try {
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("packaged sidecar timed out")), 30_000);
    const lines = createInterface({ input: child.stdout });
    let ready = false;
    let chunks = "";
    const fail = (e) => {
      clearTimeout(timer);
      reject(e);
    };
    child.on("error", fail);
    child.stdin.on("error", fail);
    child.on("exit", (code) => {
      if (report.turns !== 2) fail(new Error(`early exit ${code}: ${stderr}`));
    });
    lines.on("line", (line) => {
      try {
        const event = JSON.parse(line);
        if (!ready) {
          assert.equal(event.type, "ready");
          assert.equal(event.protocolVersion, 12);
          report.protocol = event.protocolVersion;
          ready = true;
          child.stdin.write(
            JSON.stringify({
              type: "start_session",
              sessionId: "installed-acceptance",
              provider: "echo",
              model: "echo",
              projectPath: home,
              initialMessage: "first turn",
              systemPrompt: "",
              allowedTools: [],
              mcpServers: {},
            }) + "\n",
          );
          return;
        }
        if (event.sessionId !== "installed-acceptance") return;
        if (event.type === "error") throw new Error(event.message);
        if (event.type === "chunk") chunks += event.text;
        if (event.type === "done") {
          assert.equal(chunks, report.turns === 0 ? "first turn" : "second turn");
          report.turns++;
          if (report.turns === 2) {
            clearTimeout(timer);
            resolve();
          } else {
            chunks = "";
            child.stdin.write(
              JSON.stringify({
                type: "send_message",
                sessionId: "installed-acceptance",
                content: "second turn",
              }) + "\n",
            );
          }
        }
      } catch (e) {
        fail(e);
      }
    });
  });
  report.passed = true;
} catch (e) {
  report.error = e.message;
  process.exitCode = 1;
} finally {
  child.stdin.end();
  const killer = setTimeout(() => child.kill(), 2000);
  await closed;
  clearTimeout(killer);
  assert(
    path.dirname(home) === path.resolve(tmpdir()) &&
      path.basename(home).startsWith("installed-sidecar-acceptance-"),
  );
  rmSync(home, { recursive: true, force: true });
  report.finishedAt = new Date().toISOString();
  writeFileSync(output, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
}
