// Registry regression smoke test for the PacketBench agent sidecar.
//
// Spawns `node agent-sidecar/dist/index.js` once and issues `start_session`
// requests for every concrete provider, a RETIRED provider, and a bogus
// provider name.
// Validates only that each provider is correctly wired through
// `session-registry` — not that any live integration works.
//
// Pass criteria per provider:
//   - echo            → expects `done` for its sessionId (real round-trip)
//   - claude-oauth    → actionable missing Anthropic API-key error
//   - openai-agents   → missing OpenAI API-key error
//                       No key is supplied: neither provider may reach a live
//                       service or pass merely because it timed out.
//   - openai-codex    → MUST be `error` "Unknown provider:" — the ChatGPT
//                       subscription row was removed in 2026-07 and must not
//                       silently resolve to some other provider
//   - bogus-provider  → MUST be `error` with message starting
//                       "Unknown provider:" (proves the registry rejects
//                       unknown names). A `done` here is FAIL.
//
// Each session has a 20-second individual timeout. Overall test prints a
// per-provider outcome table, then exits 0 if every outcome matches
// expectations, else exits 1.

import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { existsSync } from "node:fs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Headroom for a BUSY machine, not for a slow sidecar. Booting dist/index.js
// (which eagerly imports the Anthropic, OpenAI and MCP SDKs) takes ~0.9s on an
// idle box, so the old 3-5s budgets were fine in isolation — and failed anyway
// when these smokes ran beside a cargo build using every core. These smokes
// assert protocol behaviour, not latency, so the budget sits well clear of
// contention rather than close to the measured best case.
const PER_SESSION_TIMEOUT_MS = 20_000;

const sidecarEntry = resolve(__dirname, "..", "dist", "index.js");

if (!existsSync(sidecarEntry)) {
  console.error(`[registry-smoke] sidecar entry not found at ${sidecarEntry}`);
  console.error(`[registry-smoke] run 'pnpm sidecar:install && pnpm sidecar:build' first`);
  process.exit(1);
}

// Each case is independent — we define expected outcomes and how to classify
// a PASS/FAIL based on the terminal event we observe (or timeout).
const CASES = [
  {
    provider: "echo",
    sessionId: "registry-smoke-echo",
    // echo should actually return a real `done`.
    classify: (term) => {
      if (term.kind === "done") return { ok: true, outcome: "done" };
      if (term.kind === "error")
        return {
          ok: false,
          outcome: `error: ${term.message}`,
        };
      return { ok: false, outcome: `timeout after ${PER_SESSION_TIMEOUT_MS}ms` };
    },
  },
  {
    provider: "claude-oauth",
    sessionId: "registry-smoke-claude",
    verifyNoRetainedStartError: true,
    classify: (term) => {
      if (term.kind === "error" && /No Anthropic API key was provided/.test(term.message))
        return {
          ok: true,
          outcome: `error: ${term.message}`,
        };
      return {
        ok: false,
        outcome: `expected missing Anthropic API key error, got ${term.kind}${term.message ? `: ${term.message}` : ""}`,
      };
    },
  },
  {
    provider: "openai-agents",
    sessionId: "registry-smoke-openai-agents",
    verifyNoRetainedStartError: true,
    classify: (term) => {
      if (term.kind === "error" && /No OpenAI API key was provided/.test(term.message))
        return {
          ok: true,
          outcome: `error: ${term.message}`,
        };
      return {
        ok: false,
        outcome: `expected missing OpenAI API key error, got ${term.kind}${term.message ? `: ${term.message}` : ""}`,
      };
    },
  },
  {
    // RETIRED 2026-07. `openai-codex` drove `codex exec` on a ChatGPT
    // subscription; it was removed along with subscription OAuth. It must be
    // rejected exactly like an unknown provider — resolving it to anything
    // else would silently run a user's stored Codex conversation on the wrong
    // credentials.
    provider: "openai-codex",
    sessionId: "registry-smoke-retired-codex",
    classify: (term) => {
      if (term.kind === "error" && /^Unknown provider:/.test(term.message ?? "")) {
        return { ok: true, outcome: `error: ${term.message}` };
      }
      if (term.kind === "error") return { ok: false, outcome: `wrong error: ${term.message}` };
      if (term.kind === "done")
        return { ok: false, outcome: "done (retired provider still registered!)" };
      return { ok: false, outcome: `timeout after ${PER_SESSION_TIMEOUT_MS}ms` };
    },
  },
  {
    provider: "bogus-provider",
    sessionId: "registry-smoke-bogus",
    // Must be an "Unknown provider:" error. A done would be catastrophic.
    classify: (term) => {
      if (term.kind === "error") {
        if (term.message.startsWith("Unknown provider:")) {
          return { ok: true, outcome: `error: ${term.message}` };
        }
        return {
          ok: false,
          outcome: `error (wrong message): ${term.message}`,
        };
      }
      if (term.kind === "done") return { ok: false, outcome: "unexpected done for bogus provider" };
      return { ok: false, outcome: `timeout after ${PER_SESSION_TIMEOUT_MS}ms` };
    },
    verifyNoRetainedSession: true,
  },
];

// ---------- sidecar lifecycle ----------

const child = spawn(process.execPath, [sidecarEntry], {
  stdio: ["pipe", "pipe", "pipe"],
  windowsHide: true,
});

const stderrChunks = [];
child.stderr.setEncoding("utf8");
child.stderr.on("data", (chunk) => stderrChunks.push(chunk));

child.on("error", (err) => {
  console.error(`[registry-smoke] child spawn error: ${err.message}`);
  process.exit(1);
});

// Map sessionId → resolver callback for a terminal event
// (`{kind: "done" | "error", message?: string}`).
const pending = new Map();

let gotReady = false;
let sawFatalProtocolError = false;

child.stdout.setEncoding("utf8");
const rl = createInterface({ input: child.stdout });

rl.on("line", (line) => {
  const trimmed = line.trim();
  if (trimmed.length === 0) return;
  let event;
  try {
    event = JSON.parse(trimmed);
  } catch {
    sawFatalProtocolError = true;
    console.error(`[registry-smoke] non-JSON stdout line: ${trimmed}`);
    return;
  }

  switch (event.type) {
    case "ready":
      gotReady = true;
      break;
    case "done": {
      const resolver = pending.get(event.sessionId);
      if (resolver) {
        pending.delete(event.sessionId);
        resolver({ kind: "done" });
      }
      break;
    }
    case "error": {
      const resolver = pending.get(event.sessionId);
      if (resolver) {
        pending.delete(event.sessionId);
        resolver({ kind: "error", message: event.message ?? "" });
      }
      break;
    }
    // All other events (chunk, thinking, tool_*, permission_request,
    // pending_edit, thinking_stop) are ignored for this test — we only
    // care about terminal signals per session.
    default:
      break;
  }
});

// ---------- drive the cases sequentially ----------

function waitForTerminal(sessionId) {
  return new Promise((resolveFn) => {
    const timer = setTimeout(() => {
      if (pending.has(sessionId)) {
        pending.delete(sessionId);
        resolveFn({ kind: "timeout" });
      }
    }, PER_SESSION_TIMEOUT_MS);
    pending.set(sessionId, (term) => {
      clearTimeout(timer);
      resolveFn(term);
    });
  });
}

function sendStart(c) {
  const req = {
    type: "start_session",
    sessionId: c.sessionId,
    provider: c.provider,
    model: "",
    systemPrompt: "",
    allowedTools: [],
    mcpServers: {},
    projectPath: process.cwd(),
    initialMessage: "regression-test",
  };
  child.stdin.write(JSON.stringify(req) + "\n");
}

function sendCancel(sessionId) {
  const req = { type: "cancel", sessionId };
  try {
    child.stdin.write(JSON.stringify(req) + "\n");
  } catch {
    // pipe may already be closed; ignore
  }
}

async function run() {
  const results = [];
  for (const c of CASES) {
    const waiter = waitForTerminal(c.sessionId);
    sendStart(c);

    const term = await waiter;
    const classified = c.classify(term);
    if (classified.ok && c.verifyNoRetainedStartError && term.kind === "error") {
      const cleanupWaiter = waitForTerminal(c.sessionId);
      sendCancel(c.sessionId);
      const cleanupTerm = await cleanupWaiter;
      if (cleanupTerm.kind !== "error" || !cleanupTerm.message.startsWith("No active session:")) {
        classified.ok = false;
        classified.outcome += `; retained session after start error (${cleanupTerm.kind}${
          cleanupTerm.message ? `: ${cleanupTerm.message}` : ""
        })`;
      }
    }
    if (classified.ok && c.verifyNoRetainedSession) {
      const cleanupWaiter = waitForTerminal(c.sessionId);
      sendCancel(c.sessionId);
      const cleanupTerm = await cleanupWaiter;
      if (cleanupTerm.kind !== "error" || !cleanupTerm.message.startsWith("No active session:")) {
        classified.ok = false;
        classified.outcome += `; retained session after failed start (${cleanupTerm.kind}${
          cleanupTerm.message ? `: ${cleanupTerm.message}` : ""
        })`;
      }
    }
    results.push({ provider: c.provider, ...classified });
  }

  // Print outcome table.
  const pad = (s, n) => (s.length >= n ? s : s + " ".repeat(n - s.length));
  const widthProvider = Math.max("provider".length, ...results.map((r) => r.provider.length));
  const widthStatus = 6; // "PASS" / "FAIL"
  console.log("");
  console.log(`${pad("provider", widthProvider)}  ${pad("status", widthStatus)}  outcome`);
  console.log(`${"-".repeat(widthProvider)}  ${"-".repeat(widthStatus)}  ${"-".repeat(40)}`);
  for (const r of results) {
    console.log(
      `${pad(r.provider, widthProvider)}  ${pad(r.ok ? "PASS" : "FAIL", widthStatus)}  ${r.outcome}`,
    );
  }
  console.log("");

  const allOk = results.every((r) => r.ok) && gotReady && !sawFatalProtocolError;
  if (!gotReady) {
    console.error(`[registry-smoke] FAIL: never saw 'ready' event at startup`);
  }
  if (sawFatalProtocolError) {
    console.error(`[registry-smoke] FAIL: saw non-JSON stdout line`);
  }

  // Close sidecar.
  try {
    child.stdin.end();
  } catch {
    // ignore
  }
  const killTimer = setTimeout(() => {
    try {
      child.kill();
    } catch {
      // ignore
    }
  }, 500);
  child.on("exit", () => clearTimeout(killTimer));

  if (!allOk) {
    if (stderrChunks.length > 0) {
      console.error(`[registry-smoke] sidecar stderr:\n${stderrChunks.join("")}`);
    }
    process.exit(1);
  }
  process.exit(0);
}

run().catch((err) => {
  console.error(`[registry-smoke] unexpected error: ${err?.stack ?? err}`);
  process.exit(1);
});
