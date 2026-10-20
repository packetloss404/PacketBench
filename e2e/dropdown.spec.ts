import { test, expect } from "./setup/fixtures";

test("bottom-of-modal provider picker opens from its label and keeps a filtered choice visible", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1024, height: 720 });
  await page.goto("/e2e/harness/dropdown.html");
  const trigger = page.getByTestId("provider-anchor").getByRole("button");
  await trigger.click();
  const search = page.getByRole("textbox", { name: "Search providers…" });
  await expect(search).toBeFocused();
  await search.fill("Sugar");
  const menu = page.getByRole("group", { name: "Dropdown options" });
  const sugar = menu.getByRole("button", { name: /^Sugar/ });
  await expect(sugar).toBeVisible();
  await expect(menu.getByText("No matches", { exact: true })).toHaveCount(0);
  await expect(menu.getByRole("button")).toHaveCount(1);
  const box = await menu.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.y).toBeGreaterThanOrEqual(0);
  expect(box!.y + box!.height).toBeLessThanOrEqual(720);
  expect(
    await sugar.evaluate((element) => {
      const rect = element.getBoundingClientRect();
      return element.contains(
        document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2),
      );
    }),
  ).toBe(true);
  await sugar.click();
  await expect(page.getByRole("status")).toHaveText("Selected api-sugar");
  await expect(trigger).toBeFocused();
});
