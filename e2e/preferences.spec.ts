import { test, expect, type Page } from "@playwright/test";
import { mockTauriInitScript } from "./setup/mock-tauri";

// Each Playwright context starts empty. Unlike the general smoke fixture, do
// not clear storage on every navigation: reloading must test real persistence.
test.beforeEach(async ({ page }) => {
  // Theme is saved by Rust's UI-slice command rather than the frontend's
  // appearance key. Simulate that native persistence across reloads too.
  await page.addInitScript(`${mockTauriInitScript}
    (() => {
      const baseInvoke = window.__TAURI_INTERNALS__.invoke;
      window.__TAURI_INTERNALS__.invoke = async (cmd, args) => {
        if (cmd === "save_ui_slice") {
          const previous = JSON.parse(sessionStorage.getItem("e2e-native-ui") || "{}");
          sessionStorage.setItem("e2e-native-ui", JSON.stringify({ ...previous, ...args.ui }));
          return null;
        }
        const result = await baseInvoke(cmd, args);
        if (cmd === "load_persisted_state") {
          return { ...result, ui: JSON.parse(sessionStorage.getItem("e2e-native-ui") || "{}") };
        }
        return result;
      };
    })();
  `);
});

async function openPreferences(page: Page) {
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("button", { name: "General", exact: true }).click();
  await page.getByRole("button", { name: "Preferences", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Appearance", exact: true })).toBeVisible();
}

test("appearance changes render, survive reload, and reset without changing theme or terminal size", async ({
  page,
}) => {
  await page.goto("/");
  await openPreferences(page);

  await page.getByRole("button", { name: "Light", exact: true }).click();
  await page.getByRole("button", { name: "125%", exact: true }).click();
  await page.getByRole("button", { name: "Increase reading size" }).click();
  await page.getByRole("button", { name: "Compact", exact: true }).click();
  await page.getByRole("button", { name: "Increase terminal size" }).click();
  await expect(page.getByText("The quick brown fox", { exact: true })).toHaveCSS(
    "font-size",
    "20px",
  );
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await expect
    .poll(() =>
      page.evaluate(() => JSON.parse(sessionStorage.getItem("e2e-native-ui") || "{}").theme),
    )
    .toBe("light");

  await page.reload();
  await openPreferences(page);
  await expect(page.getByRole("button", { name: "125%", exact: true })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(page.getByRole("button", { name: "Compact", exact: true })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(page.getByText("The quick brown fox", { exact: true })).toHaveCSS(
    "font-size",
    "20px",
  );
  await expect(page.getByRole("group", { name: "Terminal text size", exact: true })).toContainText(
    "14",
  );
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");

  await page.getByRole("button", { name: "Reset text and layout", exact: true }).click();
  await expect(page.getByRole("button", { name: "100%", exact: true })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(page.getByRole("button", { name: "Comfortable", exact: true })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(page.getByText("The quick brown fox", { exact: true })).toHaveCSS(
    "font-size",
    "15px",
  );
  await expect(page.getByRole("group", { name: "Terminal text size", exact: true })).toContainText(
    "14",
  );
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");

  await page.getByRole("button", { name: "Reset terminal text size", exact: true }).click();
  await expect(page.getByRole("group", { name: "Terminal text size", exact: true })).toContainText(
    "13",
  );
});

test("app scale keyboard controls update the rendered UI and reset", async ({ page }) => {
  await page.goto("/");
  await openPreferences(page);
  await page.keyboard.press("Control+=");
  await expect(page.getByRole("button", { name: "110%", exact: true })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(page.getByText("The quick brown fox", { exact: true })).toHaveCSS(
    "font-size",
    "16.5px",
  );
  await page.keyboard.press("Control+-");
  await expect(page.getByRole("button", { name: "100%", exact: true })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await page.keyboard.press("Control+=");
  await page.keyboard.press("Control+0");
  await expect(page.getByRole("button", { name: "100%", exact: true })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
});
