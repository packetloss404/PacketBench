import { defineConfig, devices } from "@playwright/test";

const port = Number(process.env.PLAYWRIGHT_PORT ?? 1420);
const baseURL = `http://127.0.0.1:${port}`;

/**
 * Playwright E2E configuration for PacketBench.
 *
 * This runs the React frontend against the Vite dev server (web mode).
 * Tauri-specific IPC calls are mocked via `e2e/setup/mock-tauri.ts`.
 * Full Tauri end-to-end coverage would require tauri-driver, which is
 * out of scope for this first pass.
 */
export default defineConfig({
  testDir: "./e2e",
  // Playwright clears outputDir before each run. Never point it at the shared
  // parent containing installer/SSH evidence and disposable acceptance repos.
  outputDir: "test-results/playwright",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  // Capped deliberately. Every worker shares ONE Vite dev server, and each new
  // browser context makes it transform the module graph on demand; the two
  // visual-audit specs alone take ~50s apiece. Left at the default (half the
  // cores — 8 here) the workers starve each other and the settings spec times
  // out waiting 15s for a dialog, which reads as a product bug rather than
  // what it is. At 2 workers the whole suite passes; the run is slower in wall
  // clock but it is the difference between a red gate and a green one.
  workers: process.env.CI ? 1 : 2,
  reporter: process.env.CI ? "github" : "list",
  timeout: 60_000,
  // `page.goto` resolves on `load`, and `load` no longer covers the React tree.
  // `main.tsx` must repair `localStorage` from the durable mirror BEFORE any
  // store module evaluates, so `App` is imported dynamically after that boot
  // step (see `src/lib/storage-boot.ts`). That import is therefore not part of
  // the entry's static graph, and against the Vite DEV server it costs several
  // seconds of on-demand transform — measured at 4-6s after `load` on this
  // machine, against a 5s budget.
  //
  // The app itself did not get slower: time from navigation to a rendered
  // heading measured ~10s both before and after the change. What moved is which
  // side of `goto` that cost lands on. So the budget here has to cover a cold
  // dev-server module graph, not a production bundle.
  expect: { timeout: 20_000 },
  use: {
    baseURL,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  webServer: {
    command: `pnpm exec vite --host 127.0.0.1 --port ${port} --strictPort`,
    url: baseURL,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    stdout: "ignore",
    stderr: "pipe",
  },
});
