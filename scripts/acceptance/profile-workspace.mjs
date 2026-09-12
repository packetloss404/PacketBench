import { chromium } from "@playwright/test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { root } from "./common.mjs";

// Start Vite separately. Keep profiling output outside Playwright's cleanup root.
const label = process.argv[2] ?? "profile";
if (!/^[a-z0-9-]+$/i.test(label)) throw new Error("Invalid evidence label");
const output = path.join(root, "test-results/acceptance/workspace-0.14.7", label);
mkdirSync(output, { recursive: true });
const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.goto("http://127.0.0.1:1420/e2e/harness/workspace.html?panes=8");
  await page.waitForFunction(() => window.workspaceAcceptance?.ready());
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Profiler.enable");
  if (process.argv.includes("--warm")) await page.evaluate(() => window.workspaceAcceptance.run());
  await cdp.send("Profiler.start");
  const metrics = await page.evaluate(() => window.workspaceAcceptance.run());
  const { profile } = await cdp.send("Profiler.stop");
  writeFileSync(path.join(output, "cpu.cpuprofile"), JSON.stringify(profile));
  writeFileSync(path.join(output, "metrics.json"), JSON.stringify(metrics, null, 2));
  assert.equal(metrics.launches, 8);
  assert.equal(metrics.disposals, 0);
  assert.equal(metrics.kills, 0);
  assert.deepEqual(metrics.unexpected, []);
  for (let i = 0; i < 8; i++) {
    assert(
      metrics.tails
        .find((tail) => tail.id === `pane-${i}`)
        ?.text.includes(`END_${i}_日本語_RUN_${metrics.runId}`),
    );
  }
  const times = new Map();
  for (let i = 0; i < profile.samples.length; i++) {
    const id = profile.samples[i];
    times.set(id, (times.get(id) ?? 0) + profile.timeDeltas[i]);
  }
  const hot = profile.nodes
    .map((node) => ({
      ms: Math.round((times.get(node.id) ?? 0) / 1000),
      function: node.callFrame.functionName,
      url: node.callFrame.url,
      line: node.callFrame.lineNumber + 1,
    }))
    .sort((a, b) => b.ms - a.ms)
    .slice(0, 30);
  writeFileSync(path.join(output, "hot-functions.json"), JSON.stringify(hot, null, 2));
  console.log(JSON.stringify({ output, metrics, hot }, null, 2));
} finally {
  await browser.close();
}
