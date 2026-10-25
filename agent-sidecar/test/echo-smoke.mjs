// Deterministic subprocess/NDJSON smoke test for the agent sidecar.
//
// Spawns `node agent-sidecar/dist/index.js` directly, sends an initial turn
// and a Unicode/multiline follow-up for the `echo` provider, and validates
// both complete NDJSON transcripts. This does not call a live AI provider.
//
// Pass criteria:
//   - >= 1 `ready` event at startup (sessionId not required)
//   - each turn's chunks reproduce its entire input, in order
//   - one natural `done` event per turn, with no errors
//   - ready advertises the required protocol and the subprocess pid
//   - all this within 20 seconds
//
// Exits 0 and prints "OK" on success, prints diagnostics and exits 1 on
// failure.

import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { existsSync } from "node:fs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const SESSION_ID = "smoke-1";
const INITIAL_MESSAGE = "hello world";
const FOLLOWUP_MESSAGE = "second turn: café 🚀\nnext line";
// Headroom for a BUSY machine, not for a slow sidecar. Booting dist/index.js
// (which eagerly imports the Anthropic, OpenAI and MCP SDKs) takes ~0.9s on an
// idle box, so the old 3-5s budgets were fine in isolation — and failed anyway
// when these smokes ran beside a cargo build that was using every core. The
// smokes assert protocol behaviour, not latency, so the budget is set well
// clear of contention rather than close to the measured best case.
const TIMEOUT_MS = 20_000;

const sidecarEntry = resolve(__dirname, "..", "dist", "index.js");

if (!existsSync(sidecarEntry)) {
  console.error(`[smoke] sidecar entry not found at ${sidecarEntry}`);
  console.error(`[smoke] run 'pnpm sidecar:install && pnpm sidecar:build' first`);
  process.exit(1);
}

const child = spawn(process.execPath, [sidecarEntry], {
  stdio: ["pipe", "pipe", "pipe"],
  windowsHide: true,
});

const readyEvents = [];
const chunkEvents = [];
const doneEvents = [];
const errorEvents = [];
const stderrChunks = [];
const unknownEvents = [];

let finished = false;
let completedTurns = 0;
let turnChunkStart = 0;

function finish(code, reason) {
  if (finished) return;
  finished = true;
  clearTimeout(timeoutHandle);
  try {
    child.stdin.end();
  } catch {
    // ignore
  }
  // Give the child a moment to exit cleanly, then force-kill if needed.
  const killTimer = setTimeout(() => {
    try {
      child.kill();
    } catch {
      // ignore
    }
  }, 500);
  child.on("exit", () => {
    clearTimeout(killTimer);
  });

  if (code === 0) {
    console.log("OK");
  } else {
    console.error(`[smoke] FAIL: ${reason}`);
    console.error(`[smoke] ready events:  ${readyEvents.length}`);
    console.error(`[smoke] chunk events:  ${chunkEvents.length}`);
    console.error(`[smoke] done events:   ${doneEvents.length}`);
    console.error(`[smoke] error events:  ${errorEvents.length}`);
    if (chunkEvents.length > 0) {
      console.error(`[smoke] chunk texts: ${JSON.stringify(chunkEvents.map((e) => e.text))}`);
    }
    if (errorEvents.length > 0) {
      console.error(`[smoke] errors: ${JSON.stringify(errorEvents)}`);
    }
    if (unknownEvents.length > 0) {
      console.error(`[smoke] unexpected events: ${JSON.stringify(unknownEvents.slice(0, 5))}`);
    }
    if (stderrChunks.length > 0) {
      console.error(`[smoke] stderr:\n${stderrChunks.join("")}`);
    }
  }
  process.exit(code);
}

const timeoutHandle = setTimeout(() => {
  finish(1, `timed out after ${TIMEOUT_MS}ms waiting for 'done' event`);
}, TIMEOUT_MS);

child.on("error", (err) => {
  finish(1, `child spawn error: ${err.message}`);
});

child.stderr.setEncoding("utf8");
child.stderr.on("data", (chunk) => {
  stderrChunks.push(chunk);
});

child.stdout.setEncoding("utf8");
const rl = createInterface({ input: child.stdout });

rl.on("line", (line) => {
  const trimmed = line.trim();
  if (trimmed.length === 0) return;
  let event;
  try {
    event = JSON.parse(trimmed);
  } catch (err) {
    finish(1, `stdout produced non-JSON line: ${trimmed} (${err.message})`);
    return;
  }

  switch (event.type) {
    case "ready":
      readyEvents.push(event);
      break;
    case "chunk":
      chunkEvents.push(event);
      break;
    case "done":
      doneEvents.push(event);
      // Validate once we see a done for our session.
      if (event.sessionId === SESSION_ID) {
        validateAndFinish();
      }
      break;
    case "error":
      errorEvents.push(event);
      break;
    case "thinking":
    case "thinking_stop":
    case "tool_start":
    case "tool_result":
    case "permission_request":
    case "pending_edit":
      // Allowed but not required for echo provider; ignore.
      break;
    default:
      unknownEvents.push(event);
      break;
  }
});

function validateAndFinish() {
  // ready event at startup
  if (readyEvents.length < 1) {
    finish(1, "expected at least one 'ready' event at startup, got 0");
    return;
  }
  if (readyEvents[0].protocolVersion !== 12 || readyEvents[0].pid !== child.pid) {
    finish(1, "ready handshake must advertise protocol 12 and the child pid");
    return;
  }

  // Validate every fragment, in order, for this turn alone.
  const expectedMessage = completedTurns === 0 ? INITIAL_MESSAGE : FOLLOWUP_MESSAGE;
  const ourChunks = chunkEvents.slice(turnChunkStart).filter((e) => e.sessionId === SESSION_ID);
  if (ourChunks.length < 1) {
    finish(1, `expected at least one 'chunk' event for sessionId '${SESSION_ID}', got 0`);
    return;
  }
  const transcript = ourChunks.map((event) => event.text).join("");
  if (transcript !== expectedMessage) {
    finish(
      1,
      `expected complete transcript ${JSON.stringify(expectedMessage)}, got ${JSON.stringify(transcript)}`,
    );
    return;
  }

  // exactly one additional natural completion for this turn
  const ourDones = doneEvents.filter((e) => e.sessionId === SESSION_ID);
  if (ourDones.length !== completedTurns + 1 || ourDones.at(-1).cancelled === true) {
    finish(
      1,
      `expected ${completedTurns + 1} natural completions for session '${SESSION_ID}', got ${JSON.stringify(ourDones)}`,
    );
    return;
  }

  if (errorEvents.length > 0) {
    finish(1, `received ${errorEvents.length} 'error' event(s): ${JSON.stringify(errorEvents)}`);
    return;
  }

  completedTurns++;
  if (completedTurns === 1) {
    turnChunkStart = chunkEvents.length;
    child.stdin.write(
      JSON.stringify({
        type: "send_message",
        sessionId: SESSION_ID,
        content: FOLLOWUP_MESSAGE,
      }) + "\n",
    );
    return;
  }
  finish(0, "ok");
}

// Send the start_session request.
const startReq = {
  type: "start_session",
  sessionId: SESSION_ID,
  provider: "echo",
  model: "echo",
  systemPrompt: "",
  allowedTools: [],
  mcpServers: {},
  projectPath: process.cwd(),
  initialMessage: INITIAL_MESSAGE,
};

child.stdin.write(JSON.stringify(startReq) + "\n");
