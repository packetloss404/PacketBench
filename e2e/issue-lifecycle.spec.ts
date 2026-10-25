import { test, expect } from "./setup/fixtures";
import type { Page } from "@playwright/test";

// These journeys use the complete React application in Chromium. The native
// bridge is simulated by the shared fixture; no PTY, provider, or Git runs.
async function openBoard(page: Page) {
  await page.goto("/");
  await page.getByRole("button", { name: "Issues", exact: true }).click();
  await expect(page.getByRole("button", { name: "New issue", exact: true })).toBeVisible();
}

async function createIssue(page: Page, title: string) {
  await page.getByRole("button", { name: "New issue", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "New Issue", exact: true });
  await dialog.getByPlaceholder("Issue title...").fill(title);
  await dialog.getByRole("button", { name: "Create Issue", exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByText(title, { exact: true })).toBeVisible();
}

test.describe("Issue lifecycle in the full app", () => {
  test("creates, filters, completes criteria, comments, changes status and deletes", async ({
    page,
  }) => {
    await openBoard(page);
    await page.getByRole("button", { name: "New issue", exact: true }).click();
    const draft = page.getByRole("dialog", { name: "New Issue", exact: true });
    await expect(draft.getByRole("button", { name: "Create Issue" })).toBeDisabled();
    await draft.getByPlaceholder("Issue title...").fill("Verify browser acceptance");
    await draft.getByPlaceholder("Describe the issue...").fill("Keep **evidence** visible.");
    await draft.getByPlaceholder("Add criterion...").fill("A real browser can complete this task");
    await draft.getByPlaceholder("Add criterion...").press("Enter");
    await expect(draft).toBeVisible();
    await draft.getByRole("button", { name: "Create Issue", exact: true }).click();
    await expect(draft).toBeHidden();

    const search = page.getByPlaceholder("Filter by label, agent, flight…");
    await search.fill("does not exist");
    await expect(page.getByText("Verify browser acceptance", { exact: true })).toBeHidden();
    await search.fill("browser acceptance");
    await page.getByText("Verify browser acceptance", { exact: true }).click();
    const detail = page.getByRole("dialog");
    await expect(detail.getByText("evidence", { exact: true })).toBeVisible();
    await detail.getByRole("checkbox").check();
    await expect(detail.getByText("Acceptance Criteria (1/1 complete)")).toBeVisible();
    await detail.getByPlaceholder("Add criterion...").fill("Changes survive navigating away");
    await detail.getByPlaceholder("Add criterion...").press("Enter");
    await detail.getByRole("button", { name: "Assign...", exact: true }).click();
    await detail.getByPlaceholder('username, email, or "me"').fill("browser-tester");
    await detail.getByPlaceholder('username, email, or "me"').press("Enter");
    await detail.getByPlaceholder(/^Leave a comment/).fill("Checked the **rendered** behavior.");
    await detail.getByRole("button", { name: "Comment", exact: true }).click();
    await expect(detail.getByText("rendered", { exact: true })).toBeVisible();
    await detail.getByRole("button", { name: "Done", exact: true }).click();
    await detail.getByText("Close", { exact: true }).click();
    const doneColumn = page.getByTestId("issue-board-column").filter({ hasText: /^Done/ });
    await expect(doneColumn.getByText("Verify browser acceptance", { exact: true })).toBeVisible();

    await page.getByRole("button", { name: "Memory", exact: true }).click();
    await page.getByRole("button", { name: "Issues", exact: true }).click();
    await search.fill("browser-tester");
    await page.getByText("Verify browser acceptance", { exact: true }).click();
    await expect(detail.getByRole("button", { name: "browser-tester", exact: true })).toBeVisible();
    await expect(detail.getByText("Acceptance Criteria (1/2 complete)")).toBeVisible();
    await expect(detail.getByText("rendered", { exact: true })).toBeVisible();
    await detail.getByRole("button", { name: "Delete issue", exact: true }).click();
    const confirm = page.getByRole("dialog", { name: "Delete issue?", exact: true });
    await expect(confirm).toContainText("Verify browser acceptance");
    await page.keyboard.press("Escape");
    await expect(confirm).toBeHidden();
    await expect(detail).toBeVisible();
    await detail.getByRole("button", { name: "Delete issue", exact: true }).click();
    await confirm.getByRole("button", { name: "Delete", exact: true }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(page.getByText("Verify browser acceptance", { exact: true })).toBeHidden();
  });

  test("drags a card between columns and preserves reciprocal dependencies on deletion", async ({
    page,
  }) => {
    await openBoard(page);
    await createIssue(page, "Implement prerequisite");
    await page.getByRole("button", { name: "New issue", exact: true }).click();
    const draft = page.getByRole("dialog", { name: "New Issue", exact: true });
    await draft.getByPlaceholder("Issue title...").fill("Ship dependent change");
    const blockingPicker = draft.locator("select").filter({
      has: page.locator("option", { hasText: "Add blocking issue..." }),
    });
    const prerequisiteId = await blockingPicker
      .locator("option")
      .filter({ hasText: "Implement prerequisite" })
      .getAttribute("value");
    expect(prerequisiteId).toBeTruthy();
    await blockingPicker.selectOption(prerequisiteId!);
    await draft.getByRole("button", { name: "Create Issue", exact: true }).click();
    await page.getByText("Implement prerequisite", { exact: true }).click();
    const detail = page.getByRole("dialog");
    await expect(detail.getByText(/: Ship dependent change/, { exact: false })).toBeVisible();
    await detail.getByText("Close", { exact: true }).click();
    const card = page.locator('[draggable="true"]').filter({ hasText: "Ship dependent change" });
    const attention = page
      .getByTestId("issue-board-column")
      .filter({ hasText: /^Needs Attention/ });
    await card.dragTo(attention);
    await expect(attention.getByText("Ship dependent change", { exact: true })).toBeVisible();
    await page.getByText("Implement prerequisite", { exact: true }).click();
    await detail.getByRole("button", { name: "Delete issue", exact: true }).click();
    const confirm = page.getByRole("dialog", { name: "Delete issue?", exact: true });
    await expect(confirm).toContainText(/dependenc/i);
    await confirm.getByRole("button", { name: "Delete", exact: true }).click();
    await page.getByText("Ship dependent change", { exact: true }).click();
    await expect(detail.getByText("Blocked By (0 issues)", { exact: true })).toBeVisible();
  });
});
