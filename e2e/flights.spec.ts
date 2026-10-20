import { test, expect } from "./setup/fixtures";

test.describe("Flight result-first browser flow", () => {
  test.use({ viewport: { width: 1024, height: 768 } });
  test("keeps review evidence and continuation usable at a narrow desktop width", async ({
    page,
  }, info) => {
    await page.goto("/e2e/harness/flights.html");
    await expect(
      page.getByRole("heading", { name: "Correct the example condition", exact: true }),
    ).toBeVisible();
    await expect(page.getByRole("button", { name: "New attempt", exact: true })).toBeVisible();
    await expect(page.getByLabel("Code diff", { exact: true })).toContainText("+return true;");
    await expect(page.getByText("src/example.ts", { exact: true })).toBeVisible();
    await expect(page.getByText(/not independently executed by the reviewer/)).toBeVisible();
    await expect(page.getByRole("button", { name: "Open reviewer conversation" })).toBeVisible();
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    await page.getByRole("button", { name: "Review result", exact: true }).focus();
    await page.keyboard.press("Enter");
    await expect(page.locator("#flight-attempt-acceptance-attempt")).toBeFocused();
    await page.screenshot({ path: info.outputPath("flight-review-1024.png"), fullPage: true });
  });
  test("archives a delivered result and restores its retained history by keyboard", async ({
    page,
  }) => {
    await page.goto("/e2e/harness/flights.html?state=delivered");
    await expect(page.getByText("Landed into main as 333333333333.")).toBeVisible();
    await page.getByRole("button", { name: "Archive Flight", exact: true }).click();
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "Archive Flight", exact: true })
      .click();
    await page.getByRole("checkbox", { name: "Show archived" }).check();
    await expect(page.getByRole("button", { name: "Restore Flight", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Restore Flight", exact: true }).focus();
    await page.keyboard.press("Enter");
    await expect(page.getByText("Landed into main as 333333333333.")).toBeVisible();
  });
  test("retained-work recovery names the exact path and requires explicit discard", async ({
    page,
  }) => {
    await page.goto("/e2e/harness/flights.html?state=retained");
    await expect(page.getByText("Work preserved for recovery")).toBeVisible();
    await page.getByRole("button", { name: "Discard preserved work…" }).click();
    const dialog = page.getByRole("dialog", { name: "Discard preserved work?" });
    await expect(dialog).toContainText("/acceptance/project/.worktrees/acceptance-attempt");
    await expect(dialog).toContainText("Uncommitted and untracked files");
    await page.keyboard.press("Escape");
    await expect(dialog).not.toBeVisible();
    await expect(page.getByText("Work preserved for recovery")).toBeVisible();
  });
});
