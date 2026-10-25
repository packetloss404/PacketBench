import { test, expect } from "./setup/fixtures";
import type { Page } from "@playwright/test";

// Full-app Chromium journeys with an explicit, in-memory native boundary.
// Responses below are fixtures, not evidence of a live model/provider run.
async function installAgentBridge(page: Page, failStart = false) {
  await page.addInitScript(
    ({ failStart }) => {
      const host = window as unknown as {
        __TAURI_INTERNALS__: {
          invoke: (command: string, args?: Record<string, unknown>) => Promise<unknown>;
        };
        __AGENT_CALLS__: { command: string; args?: Record<string, unknown> }[];
        __AGENT_EMIT__: (event: string, payload: unknown) => void;
        [key: string]: unknown;
      };
      const original = host.__TAURI_INTERNALS__.invoke.bind(host.__TAURI_INTERNALS__);
      const listeners = new Map<number, { event: string; handler: number }>();
      let nextId = 10000;
      host.__AGENT_CALLS__ = [];
      host.__AGENT_EMIT__ = (event, payload) => {
        for (const [id, listener] of listeners) {
          if (listener.event === event) {
            const callback = host[`_${listener.handler}`] as (value: unknown) => void;
            callback({ event, id, payload });
          }
        }
      };
      host.__TAURI_INTERNALS__.invoke = async (command, args) => {
        host.__AGENT_CALLS__.push({ command, args });
        switch (command) {
          case "plugin:event|listen": {
            const id = nextId++;
            listeners.set(id, { event: String(args?.event), handler: Number(args?.handler) });
            return id;
          }
          case "plugin:event|unlisten":
            listeners.delete(Number(args?.eventId));
            return null;
          case "plugin:dialog|open":
            return "/browser-acceptance/project";
          case "get_provider_auth_status":
            return { status: "ready", hint: "Simulated browser-only credentials" };
          case "list_provider_models":
            return [{ id: "browser-fixture", displayName: "Browser fixture model" }];
          case "get_runtime_guard_status":
            return false;
          case "read_mcp_servers":
          case "list_slash_commands":
          case "list_skills":
            return [];
          case "load_agents_md":
            return null;
          case "save_conversation":
          case "set_permission_mode":
          case "set_plan_mode":
          case "close_api_agent_session":
            return null;
          case "start_api_agent_session":
            if (failStart) throw new Error("Browser fixture: provider unavailable");
            return null;
          case "send_api_agent_message":
            return null;
          default:
            return original(command, args);
        }
      };
    },
    { failStart },
  );
}

async function openLauncher(page: Page) {
  await page.goto("/");
  await page.getByRole("button", { name: "Agents", exact: true }).click();
  await page.getByRole("button", { name: "Got it", exact: true }).click();
  await page.getByRole("button", { name: /Select a project/ }).click();
  await page.getByRole("button", { name: "Open Folder", exact: true }).click();
}

async function selectFixtureModel(page: Page) {
  await page.getByRole("button", { name: /Select model|sugar\/conduit/ }).click();
  await page.getByPlaceholder("Search models…").fill("browser-fixture");
  await page.getByRole("button", { name: /Use.*browser-fixture/ }).click();
}

test.describe("Agents conversations in the full app", () => {
  test("launches, renders streamed events and sends a follow-up through the native boundary", async ({
    page,
  }) => {
    await installAgentBridge(page);
    await openLauncher(page);
    await selectFixtureModel(page);
    const composer = page.locator("textarea").first();
    await composer.fill("Inspect the browser acceptance fixture");
    await page.getByRole("button", { name: "Launch", exact: true }).click();
    await expect(
      page.getByText("Inspect the browser acceptance fixture", { exact: true }),
    ).toBeVisible();
    await expect(page.getByRole("button", { name: "Stop turn", exact: true })).toBeVisible();
    const sessionId = await page.evaluate(() => {
      const calls = (
        window as unknown as {
          __AGENT_CALLS__: { command: string; args?: { sessionId: string } }[];
        }
      ).__AGENT_CALLS__;
      return calls.find((call) => call.command === "start_api_agent_session")!.args!.sessionId;
    });
    await page.evaluate((sessionId) => {
      const emit = (
        window as unknown as { __AGENT_EMIT__: (name: string, payload: unknown) => void }
      ).__AGENT_EMIT__;
      emit(`api-agent:chunk:${sessionId}`, "The simulated response reached the transcript.");
      emit(`api-agent:done:${sessionId}`, { input_tokens: 12, output_tokens: 9 });
    }, sessionId);
    await expect(
      page.getByText("The simulated response reached the transcript.", { exact: true }),
    ).toBeVisible();
    await expect(page.getByRole("button", { name: "Stop turn", exact: true })).toBeHidden();
    await page.locator("textarea").first().fill("Continue the fixture conversation");
    await page.getByRole("button", { name: "Send", exact: true }).click();
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            (
              window as unknown as { __AGENT_CALLS__: { command: string }[] }
            ).__AGENT_CALLS__.filter((call) => call.command === "send_api_agent_message").length,
        ),
      )
      .toBe(1);
    await expect(
      page.getByText("Continue the fixture conversation", { exact: true }),
    ).toBeVisible();
  });

  test("preserves a failed launch draft and reports a failure instead of running", async ({
    page,
  }) => {
    await installAgentBridge(page, true);
    await openLauncher(page);
    await selectFixtureModel(page);
    const composer = page.locator("textarea").first();
    await composer.fill("Keep this draft when startup fails");
    await page.getByRole("button", { name: "Launch", exact: true }).click();
    await expect(page.getByRole("alert")).toContainText("Your draft and attachments are preserved");
    await expect(composer).toHaveValue("Keep this draft when startup fails");
    await expect(page.getByRole("button", { name: "Launch", exact: true })).toBeEnabled();
    await expect(page.getByRole("button", { name: "Stop turn", exact: true })).toHaveCount(0);
  });
});
