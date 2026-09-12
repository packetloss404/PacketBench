import { test, expect } from "@playwright/test";
import { writeFile } from "node:fs/promises";
import type { WorkspaceAcceptance } from "./harness/workspace";

declare global {
  interface Window {
    workspaceAcceptance: WorkspaceAcceptance;
  }
}

for (const panes of [1, 4, 8]) {
  test(`Workspace sustained output remains ordered with ${panes} panes`, async ({
    page,
  }, testInfo) => {
    test.setTimeout(90_000);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`/e2e/harness/workspace.html?panes=${panes}`);
    await expect
      .poll(() => page.evaluate(() => window.workspaceAcceptance?.ready()), { timeout: 45_000 })
      .toBe(true);
    const result = await page.evaluate(() => window.workspaceAcceptance.run());
    const report = testInfo.outputPath(`workspace-output-${panes}.json`);
    await writeFile(report, JSON.stringify(result, null, 2));
    await testInfo.attach(`workspace-output-${panes}.json`, {
      path: report,
      contentType: "application/json",
    });
    expect(result.unexpected).toEqual([]);
    expect(result.launches).toBe(panes);
    expect(result.disposals).toBe(0);
    expect(result.kills).toBe(0);
    expect(result.frameSamples).toBeGreaterThan(0);
    for (let i = 0; i < panes; i++)
      expect(result.tails.find((tail) => tail.id === `pane-${i}`)?.text).toContain(
        `END_${i}_日本語_RUN_${result.runId}`,
      );
    // Functional navigation under the real browser event model after load.
    await page.locator('[data-terminal-pane="pane-0"] .xterm-helper-textarea').focus();
    await page.keyboard.press("Control+Alt+PageDown");
    await expect(
      page.locator(`[data-terminal-pane="pane-${panes > 1 ? 1 : 0}"] .xterm-helper-textarea`),
    ).toBeFocused();
  });
}

test("readable eight-pane controls preserve real terminals at narrow widths", async ({ page }) => {
  await page.setViewportSize({ width: 800, height: 600 });
  await page.goto("/e2e/harness/workspace.html?panes=8");
  await expect
    .poll(() => page.evaluate(() => window.workspaceAcceptance?.ready()), { timeout: 45_000 })
    .toBe(true);
  const viewport = page.locator("[data-workspace-viewport]");
  const canvas = page.locator("[data-workspace-canvas]");
  const pane = page.locator('[data-terminal-pane="pane-7"]');
  const initial = await page.evaluate(() => window.workspaceAcceptance.snapshot());
  await expect
    .poll(async () => (await page.locator('[data-terminal-pane="pane-0"]').boundingBox())?.width)
    .toBeGreaterThan(350);
  await page.getByRole("combobox", { name: "Select visible pane" }).selectOption("pane-7");
  await expect.poll(() => viewport.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
  const scroll = await viewport.evaluate((element) => ({
    x: element.scrollLeft,
    y: element.scrollTop,
  }));
  await page.getByRole("button", { name: "Zoom selected pane", exact: true }).click();
  await expect.poll(async () => (await pane.boundingBox())?.width).toBeGreaterThan(750);
  await page.getByRole("button", { name: "Show all panes", exact: true }).click();
  await expect
    .poll(() => viewport.evaluate((element) => element.scrollTop))
    .toBeCloseTo(scroll.y, 0);
  await page.getByRole("button", { name: "Fit all", exact: true }).click();
  await expect
    .poll(() => canvas.evaluate((element) => element.getBoundingClientRect().width))
    .toBeLessThanOrEqual(800);
  await page.getByRole("button", { name: "Readable", exact: true }).click();
  await expect(pane).toBeInViewport({ ratio: 0.95 });
  await page.setViewportSize({ width: 1600, height: 900 });
  await page.getByRole("button", { name: "Readable", exact: true }).click();
  await page.getByRole("button", { name: "Balance sizes", exact: true }).click();
  const final = await page.evaluate(() => window.workspaceAcceptance.snapshot());
  expect(final.launches).toBe(initial.launches);
  expect(final.disposals).toBe(initial.disposals);
  expect(final.kills).toBe(initial.kills);
  expect(final.unexpected).toEqual([]);
});
