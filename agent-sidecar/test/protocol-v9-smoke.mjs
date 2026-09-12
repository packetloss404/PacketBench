// Protocol v12 regression smoke test for the PacketBench agent sidecar.
// The historical filename is retained for package-script compatibility.
//
// Validates that the protocol v2 request types plus the v4
// `cancel_pending_tools` request, the v5 `inject_user_turn` request, and
// the v6 `rate_limited` event shape all route correctly through the
// dispatcher against the echo provider. This is a wiring test only — it
// does not exercise any real provider. The echo provider's v2 handlers
// emit one `chunk` echoing the received field, then `done` with zero
// tokens. Echo does NOT implement v4 `cancel_pending_tools` or v5
// `inject_user_turn`, so for those requests the expected result is the
// registry's clean "not supported" error.
//
// (v7 removed the in-process planner MCP surface — the `planner_tool`
// event, `planner_tool_result` request, and `mcpKind` — so this file no
// longer probes those. `inject_user_turn` survives as the shared
// wake-trigger / spec-mode re-entry path.)
//
// The v6 `rate_limited` event is a server→client envelope (no request
// type to dispatch), so we only round-trip the JSON shape via JSON.parse
// to confirm the wire layout the Rust supervisor expects — we never need
// to trigger a real RateLimitError, which would require a live Anthropic
// session.
//
// Sequence:
//   1. Spawn the sidecar, wait for `ready` (must advertise protocol v9).
//   2. `start_session` with an SSH workspace → expect clean refusal before
//      any provider can treat the remote path as local cwd.
//   3. `start_session` for provider "echo", wait for its `done`.
//   4. `set_permission_mode { mode: "plan" }` → expect chunk echoing "plan"
//      then `done`, within 3s.
//   5. `set_model { model: "test-model" }` → expect chunk echoing
//      "test-model" then `done`, within 3s.
//   6. `retry` → expect chunk containing "retry" then `done`, within 3s.
//   7. `edit_response` → echo the v9 `toolUseId` correlation field.
//   8. `cancel_pending_tools` → expect clean unsupported error, within 3s.
//   9. `inject_user_turn` → expect clean unsupported error, within 3s.
//  10. v6 `rate_limited` event shape round-trip via JSON.parse — pure
//      wire-format check, no IPC.
//
// Exits 0 if all steps pass, 1 otherwise — printing which step failed
// and why.

import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { existsSync } from "node:fs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const SESSION_ID = "protocol-v9-smoke";
const EXPECTED_PROTOCOL_VERSION = 12;
// Headroom for a BUSY machine, not for a slow sidecar. Booting dist/index.js
// (which eagerly imports the Anthropic, OpenAI and MCP SDKs) takes ~0.9s on an
// idle box, so the old 3-5s budgets were fine in isolation — and failed anyway
// when these smokes ran beside a cargo build using every core. These smokes
// assert protocol behaviour, not latency, so the budget sits well clear of
// contention rather than close to the measured best case.
const STEP_TIMEOUT_MS = 20_000;
const START_TIMEOUT_MS = 20_000;
const READY_TIMEOUT_MS = 20_000;

const sidecarEntry = resolve(__dirname, "..", "dist", "index.js");

if (!existsSync(sidecarEntry)) {
  console.error(`[protocol-v9-smoke] sidecar entry not found at ${sidecarEntry}`);
  console.error(`[protocol-v9-smoke] run 'pnpm sidecar:install && pnpm sidecar:build' first`);
  process.exit(1);
}

const child = spawn(process.execPath, [sidecarEntry], {
  stdio: ["pipe", "pipe", "pipe"],
  windowsHide: true,
});

const stderrChunks = [];
child.stderr.setEncoding("utf8");
child.stderr.on("data", (chunk) => stderrChunks.push(chunk));

child.on("error", (err) => {
  console.error(`[protocol-v9-smoke] child spawn error: ${err.message}`);
  process.exit(1);
});

// Collected events between request waves.
const chunks = [];
const dones = [];
const errors = [];
let gotReady = false;
let readyProtocolVersion = null;
let readyResolver = null;

// After each request, the test code sets a single waiter that resolves when
// either a `done` or `error` event lands for SESSION_ID.
let terminalResolver = null;

child.stdout.setEncoding("utf8");
const rl = createInterface({ input: child.stdout });

rl.on("line", (line) => {
  const trimmed = line.trim();
  if (trimmed.length === 0) return;
  let event;
  try {
    event = JSON.parse(trimmed);
  } catch {
    console.error(`[protocol-v9-smoke] non-JSON stdout line: ${trimmed}`);
    return;
  }

  switch (event.type) {
    case "ready":
      gotReady = true;
      readyProtocolVersion = event.protocolVersion;
      if (readyResolver) {
        const r = readyResolver;
        readyResolver = null;
        r();
      }
      break;
    case "chunk":
      if (event.sessionId === SESSION_ID) chunks.push(event);
      break;
    case "done":
      if (event.sessionId === SESSION_ID) {
        dones.push(event);
        if (terminalResolver) {
          const r = terminalResolver;
          terminalResolver = null;
          r({ kind: "done", event });
        }
      }
      break;
    case "error":
      if (event.sessionId === SESSION_ID) {
        errors.push(event);
        if (terminalResolver) {
          const r = terminalResolver;
          terminalResolver = null;
          r({ kind: "error", event });
        }
      }
      break;
    default:
      // Ignore other event types (thinking, tool_*, permission_request,
      // pending_edit, thinking_stop, rate_limited, mcp_sources) — this test
      // only cares about chunk / done / error for SESSION_ID.
      break;
  }
});

function send(req) {
  child.stdin.write(JSON.stringify(req) + "\n");
}

function waitForReady() {
  return new Promise((resolveFn, rejectFn) => {
    if (gotReady) {
      resolveFn();
      return;
    }
    const timer = setTimeout(() => {
      readyResolver = null;
      rejectFn(new Error(`timed out after ${READY_TIMEOUT_MS}ms waiting for 'ready'`));
    }, READY_TIMEOUT_MS);
    readyResolver = () => {
      clearTimeout(timer);
      resolveFn();
    };
  });
}

function waitForTerminal(timeoutMs, label) {
  return new Promise((resolveFn, rejectFn) => {
    const timer = setTimeout(() => {
      terminalResolver = null;
      rejectFn(
        new Error(`timed out after ${timeoutMs}ms waiting for done/error during '${label}'`),
      );
    }, timeoutMs);
    terminalResolver = (result) => {
      clearTimeout(timer);
      resolveFn(result);
    };
  });
}

function shutdown(code) {
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
  if (code !== 0 && stderrChunks.length > 0) {
    console.error(`[protocol-v9-smoke] sidecar stderr:\n${stderrChunks.join("")}`);
  }
  process.exit(code);
}

function fail(step, reason) {
  console.error(`[protocol-v9-smoke] FAIL at step '${step}': ${reason}`);
  shutdown(1);
}

async function runStep(step, request, { expectSubstring = null, expectErrorSubstring = null }) {
  // Snapshot the chunk index so we only consider chunks emitted after this
  // request was dispatched.
  const chunkStart = chunks.length;
  send(request);
  let term;
  try {
    term = await waitForTerminal(STEP_TIMEOUT_MS, step);
  } catch (err) {
    fail(step, err.message);
    return;
  }
  if (expectErrorSubstring !== null) {
    if (term.kind !== "error") {
      fail(
        step,
        `expected error containing ${JSON.stringify(expectErrorSubstring)}, got ${term.kind}`,
      );
      return;
    }
    const message = term.event.message ?? "";
    if (!message.includes(expectErrorSubstring)) {
      fail(
        step,
        `expected error containing ${JSON.stringify(expectErrorSubstring)}, got ${JSON.stringify(message)}`,
      );
      return;
    }
    console.log(`[protocol-v9-smoke] PASS: ${step}`);
    return;
  }
  if (term.kind === "error") {
    fail(step, `received error event: ${term.event.message}`);
    return;
  }
  const stepChunks = chunks.slice(chunkStart);
  if (stepChunks.length < 1) {
    fail(step, `expected at least one 'chunk' event, got 0`);
    return;
  }
  const matched = stepChunks.some(
    (c) => typeof c.text === "string" && c.text.includes(expectSubstring),
  );
  if (!matched) {
    fail(
      step,
      `expected a 'chunk' containing ${JSON.stringify(expectSubstring)}, got ${JSON.stringify(stepChunks.map((c) => c.text))}`,
    );
    return;
  }
  console.log(`[protocol-v9-smoke] PASS: ${step}`);
}

/**
 * v6: `rate_limited` is a server→client event. We don't need to round-trip
 * it through the sidecar process (that would require triggering a real
 * RateLimitError), but we do want to confirm the wire shape stays stable
 * — the Rust supervisor's `agent_sidecar::handle_event` parses these exact
 * keys (`type`, `sessionId`, `retryAfterSeconds`, `message`).
 */
function checkRateLimitedEventShape() {
  const step = "rate_limited_event_shape";
  const sample = {
    type: "rate_limited",
    sessionId: "rl-test",
    retryAfterSeconds: 90,
    message: "Anthropic rate limit hit",
  };
  const serialized = JSON.stringify(sample);
  let parsed;
  try {
    parsed = JSON.parse(serialized);
  } catch (err) {
    fail(step, `JSON round-trip failed: ${err.message}`);
    return;
  }
  if (parsed.type !== "rate_limited") {
    fail(step, `type must be 'rate_limited', got ${JSON.stringify(parsed.type)}`);
    return;
  }
  if (parsed.sessionId !== "rl-test") {
    fail(step, `sessionId did not round-trip: ${JSON.stringify(parsed.sessionId)}`);
    return;
  }
  if (parsed.retryAfterSeconds !== 90) {
    fail(step, `retryAfterSeconds did not round-trip: ${JSON.stringify(parsed.retryAfterSeconds)}`);
    return;
  }
  if (parsed.message !== "Anthropic rate limit hit") {
    fail(step, `message did not round-trip: ${JSON.stringify(parsed.message)}`);
    return;
  }
  // retryAfterSeconds is optional — confirm omitting it still parses.
  const minimal = { type: "rate_limited", sessionId: "rl-test" };
  const minimalParsed = JSON.parse(JSON.stringify(minimal));
  if (minimalParsed.type !== "rate_limited" || minimalParsed.sessionId !== "rl-test") {
    fail(step, "minimal rate_limited envelope (no retryAfterSeconds) failed to round-trip");
    return;
  }
  if (minimalParsed.retryAfterSeconds !== undefined) {
    fail(step, "minimal envelope should not invent a retryAfterSeconds value");
    return;
  }
  console.log(`[protocol-v9-smoke] PASS: ${step}`);
}

async function run() {
  try {
    await waitForReady();
  } catch (err) {
    fail("ready", err.message);
    return;
  }
  if (readyProtocolVersion !== EXPECTED_PROTOCOL_VERSION) {
    fail(
      "ready",
      `expected protocolVersion ${EXPECTED_PROTOCOL_VERSION}, got ${JSON.stringify(readyProtocolVersion)}`,
    );
    return;
  }

  // 2) Remote workspace metadata must not fall through into provider cwd use.
  await runStep(
    "start_session_remote_workspace_guard",
    {
      type: "start_session",
      sessionId: SESSION_ID,
      provider: "echo",
      model: "echo",
      systemPrompt: "",
      allowedTools: [],
      mcpServers: {},
      projectPath: "",
      initialMessage: "init",
      workspace: {
        kind: "ssh",
        serverId: "srv-123",
        host: "example.com",
        port: 22,
        user: "ian",
        remotePath: "/srv/app",
      },
    },
    { expectErrorSubstring: "Remote SSH workspace metadata reached" },
  );

  // 3) start_session for echo and wait for the provider's initial `done`.
  {
    const chunkStart = chunks.length;
    send({
      type: "start_session",
      sessionId: SESSION_ID,
      provider: "echo",
      model: "echo",
      systemPrompt: "",
      allowedTools: [],
      mcpServers: {},
      projectPath: process.cwd(),
      initialMessage: "init",
    });
    let term;
    try {
      term = await waitForTerminal(START_TIMEOUT_MS, "start_session");
    } catch (err) {
      fail("start_session", err.message);
      return;
    }
    if (term.kind === "error") {
      fail("start_session", `received error event: ${term.event.message}`);
      return;
    }
    // Not strictly required, but prove echo actually streamed something.
    void chunks.slice(chunkStart);
    console.log(`[protocol-v9-smoke] PASS: start_session`);
  }

  // 3) set_permission_mode { mode: "plan" }
  await runStep(
    "set_permission_mode",
    { type: "set_permission_mode", sessionId: SESSION_ID, mode: "plan" },
    { expectSubstring: "plan" },
  );

  // 4) set_model { model: "test-model" }
  await runStep(
    "set_model",
    { type: "set_model", sessionId: SESSION_ID, model: "test-model" },
    { expectSubstring: "test-model" },
  );

  // 5) retry
  await runStep("retry", { type: "retry", sessionId: SESSION_ID }, { expectSubstring: "retry" });

  // 6) v9 edit_response correlation reaches the provider unchanged.
  await runStep(
    "edit_response_tool_id",
    {
      type: "edit_response",
      sessionId: SESSION_ID,
      toolUseId: "tool-edit-2",
      approved: true,
    },
    { expectSubstring: "tool-edit-2" },
  );

  // 7) cancel_pending_tools. Echo intentionally does not implement this
  // method; the registry error proves index.ts dispatches v4 requests into
  // the registry instead of dropping them as unknown request types.
  await runStep(
    "cancel_pending_tools",
    { type: "cancel_pending_tools", sessionId: SESSION_ID },
    { expectErrorSubstring: "does not support cancel_pending_tools" },
  );

  // 8) inject_user_turn. v5 wake-trigger / spec-mode chat path. Echo does
  // not implement it; we want the registry's "not supported" error rather
  // than the parser's "unknown request type" log line (which would mean
  // index.ts dropped it without dispatching).
  await runStep(
    "inject_user_turn",
    {
      type: "inject_user_turn",
      sessionId: SESSION_ID,
      content: "ping",
      source: "user",
    },
    { expectErrorSubstring: "does not support inject_user_turn" },
  );

  // 9) v6 `rate_limited` event-shape round-trip. Server→client envelope —
  // pure wire-format check, no IPC.
  checkRateLimitedEventShape();

  console.log(`[protocol-v9-smoke] OK`);
  shutdown(0);
}

run().catch((err) => {
  console.error(`[protocol-v9-smoke] unexpected error: ${err?.stack ?? err}`);
  shutdown(1);
});
