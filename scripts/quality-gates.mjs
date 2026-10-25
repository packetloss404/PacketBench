#!/usr/bin/env node

/**
 * PacketBench concurrent local quality-gate runner.
 *
 * PacketBench has no hosted CI (see dev/local-quality-gates.md), so every
 * signal is earned locally. The historical entry points chain gates with `&&`:
 *
 *   preflight = format:check && lint:src && test && build && remoteagents:check
 *   check     = preflight && e2e && sidecar:check && check:tauri-schema
 *               && rust:check && rust:test
 *
 * That has two costs. It is strictly serial even though most of those gates
 * touch disjoint resources, and `&&` short-circuits, so a Prettier nit stops
 * you from ever learning whether the Rust side compiles.
 *
 * This runner keeps those scripts untouched and adds a scheduler on top:
 *
 *   - a bounded worker pool runs independent gates concurrently;
 *   - EVERY selected gate runs to completion — no short-circuit, so one
 *     invocation tells you everything that is broken;
 *   - gates that genuinely contend declare a named resource lock, so the
 *     scheduler serialises exactly the pairs that must be serialised;
 *   - the run ends in a summary table (gate, result, duration) and exits
 *     non-zero if anything failed.
 *
 * Nothing here re-implements a gate. Every gate shells out to the package
 * script that already defines it, so `pnpm run <gate>` and this runner always
 * execute the same command.
 *
 * Usage:
 *   node scripts/quality-gates.mjs [--tier fast|full] [options]
 *
 * See --help for the full option list.
 */

import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const isWindows = process.platform === "win32";

// ---------------------------------------------------------------------------
// Resources
// ---------------------------------------------------------------------------

/**
 * Named contention points. A gate declares the resources it touches and
 * whether it reads ("shared") or mutates ("exclusive") them. Two gates may
 * run concurrently unless they hold the same resource and at least one of
 * them holds it exclusively.
 *
 * These are the real conflicts found by reading the scripts, not guesses:
 *
 * cargo      Every cargo invocation takes a lock on the shared target
 *            directory. `rust:check`, `rust:test`, and `check:tauri-schema`
 *            (which shells out to `cargo test --test api_schema`) would just
 *            block on each other, so running them in parallel buys nothing
 *            and makes the timings meaningless. They are serialised, cheapest
 *            first, so the group warms one build cache instead of three.
 *
 * schema     `scripts/check-tauri-schema.mjs` snapshots
 *            `src/generated/tauri-schema.ts`, lets the Rust test OVERWRITE it,
 *            compares, and writes the snapshot back. For the duration of that
 *            cargo run the file on disk is not the checked-in file. `tsc`
 *            (typecheck, build) and Vitest both resolve it — `src/lib/tauri.ts`
 *            imports from `@/generated/tauri-schema` — so they take it shared
 *            and the schema gate takes it exclusively. eslint does NOT: its
 *            config ignores `src/generated/**`.
 *
 * sidecar    `sidecar:check` starts with `sidecar:install`, which rewrites
 *            `agent-sidecar/node_modules`, then builds `agent-sidecar/dist`
 *            and runs fourteen smoke scripts against it. Nothing else in the
 *            gate set may be reading that tree while it is being replaced.
 *
 * vitePort   `e2e` boots Vite on a fixed `--strictPort` port (1420 by
 *            default). Only one gate may own it.
 *
 * distDir    `build` writes `dist/`.
 *
 * remoteagts `remoteagents:check` builds the dist dirs under remoteagents/.
 *
 * cpu        Machine capacity, and the one lock that is about TIME rather than
 *            a file or a port.
 *
 *            Three gates assert on wall-clock behaviour: Vitest fails a test
 *            that exceeds its budget, the sidecar smokes give a spawned
 *            process a fixed number of milliseconds to answer, and Playwright
 *            waits on a Vite dev server. Meanwhile `cargo` alone will use
 *            every core it can get. Run those together on a 16-core box and
 *            the timing-sensitive gates lose — measured here, repeatedly: a
 *            sidecar smoke timed out at TWENTY seconds doing work that takes
 *            ~0.9s on an idle machine, and a store test blew a 15s budget it
 *            meets in under a second alone. A 20x blowout is what saturation
 *            does; it is not a slow sidecar.
 *
 *            Those are false failures. They cost more than the makespan they
 *            save, because a red gate nobody believes is worth nothing. So the
 *            three timing-sensitive gates take `cpu` EXCLUSIVE and get a quiet
 *            machine; every other heavy gate takes it SHARED and still runs
 *            packed together. The cargo chain is the critical path and the
 *            cheap gates fit inside it, so most of the parallelism survives.
 */
const RESOURCES = {
  cargo: "cargo target-dir lock",
  schema: "src/generated/tauri-schema.ts",
  sidecar: "agent-sidecar/node_modules + dist",
  vitePort: "Vite --strictPort e2e server",
  distDir: "dist/",
  remoteagents: "remoteagents/*/dist",
  cpu: "machine CPU (timing-sensitive gates run alone)",
};

const EXCLUSIVE = "exclusive";
const SHARED = "shared";

// ---------------------------------------------------------------------------
// Gate catalog
// ---------------------------------------------------------------------------

/**
 * `weight` is a scheduling hint in milliseconds, not a measurement and not a
 * promise. It only decides which ready gate is started first when the pool has
 * a free slot; being wrong costs a little makespan and nothing else. The long
 * cargo chain is the critical path, so it is nudged to the front by `priority`.
 *
 * `affectedBy` lists the path prefixes that can possibly change a gate's
 * result, used only by --changed. Be generous here: a missing entry means a
 * skipped gate that should have run, which is the one failure mode this
 * feature must not have.
 */
const GATES = [
  {
    id: "format:check",
    script: "format:check",
    tiers: ["fast", "full"],
    weight: 6_000,
    locks: [],
    // Mirrors the globs in the `format:check` package script. If that script
    // grows a surface, add it here too or --changed will under-run it.
    affectedBy: ["package.json", "eslint.config.js", "dev/local-quality-gates.md", "e2e/"],
  },
  {
    id: "lint:src",
    script: "lint:src",
    tiers: ["fast", "full"],
    weight: 75_000,
    locks: [[RESOURCES.cpu, SHARED]],
    affectedBy: ["src/", "e2e/", "eslint.config.js"],
  },
  {
    id: "typecheck",
    script: "typecheck",
    tiers: ["fast", "full"],
    weight: 25_000,
    // Reads the generated schema through `src/lib/tauri.ts`.
    locks: [
      [RESOURCES.schema, SHARED],
      [RESOURCES.cpu, SHARED],
    ],
    affectedBy: ["src/", "tsconfig"],
  },
  {
    id: "test",
    script: "test",
    tiers: ["fast", "full"],
    weight: 110_000,
    // Vitest fails tests on elapsed time, so it gets the machine to itself.
    locks: [
      [RESOURCES.schema, SHARED],
      [RESOURCES.cpu, EXCLUSIVE],
    ],
    affectedBy: ["src/", "vitest.config.ts"],
  },
  {
    id: "build",
    script: "build",
    tiers: ["full"],
    weight: 60_000,
    locks: [
      [RESOURCES.schema, SHARED],
      [RESOURCES.distDir, EXCLUSIVE],
      [RESOURCES.cpu, SHARED],
    ],
    affectedBy: [
      "src/",
      "index.html",
      "public/",
      "vite.config.ts",
      "tsconfig",
      "tailwind.config",
      "postcss.config",
    ],
  },
  {
    id: "remoteagents:check",
    script: "remoteagents:check",
    tiers: ["full"],
    weight: 60_000,
    locks: [
      [RESOURCES.remoteagents, EXCLUSIVE],
      [RESOURCES.cpu, SHARED],
    ],
    affectedBy: ["remoteagents/"],
  },
  {
    id: "e2e",
    script: "e2e",
    tiers: ["full"],
    weight: 90_000,
    // Waits on a Vite dev server; starved workers time out waiting for a dialog.
    locks: [
      [RESOURCES.vitePort, EXCLUSIVE],
      [RESOURCES.cpu, EXCLUSIVE],
    ],
    affectedBy: [
      "src/",
      "e2e/",
      "index.html",
      "public/",
      "vite.config.ts",
      "playwright.config.ts",
      "tailwind.config",
      "postcss.config",
    ],
  },
  {
    id: "sidecar:check",
    script: "sidecar:check",
    tiers: ["full"],
    weight: 90_000,
    // Smoke scripts give a spawned sidecar a fixed millisecond budget to answer.
    locks: [
      [RESOURCES.sidecar, EXCLUSIVE],
      [RESOURCES.cpu, EXCLUSIVE],
    ],
    affectedBy: ["agent-sidecar/"],
  },
  {
    id: "rust:check",
    script: "rust:check",
    tiers: ["full"],
    weight: 225_000,
    priority: 0,
    locks: [
      [RESOURCES.cargo, EXCLUSIVE],
      [RESOURCES.cpu, SHARED],
    ],
    affectedBy: ["src-tauri/", "Cargo.toml", "Cargo.lock", "rust-toolchain"],
  },
  {
    id: "rust:test",
    script: "rust:test",
    tiers: ["full"],
    weight: 240_000,
    priority: 1,
    locks: [
      [RESOURCES.cargo, EXCLUSIVE],
      [RESOURCES.cpu, SHARED],
    ],
    affectedBy: ["src-tauri/", "Cargo.toml", "Cargo.lock", "rust-toolchain"],
  },
  {
    id: "runtime:eval",
    script: "acceptance:runtime-eval",
    tiers: ["full"],
    weight: 120_000,
    // Builds and runs a cargo bin, so it joins the target-dir lock. Runs after
    // the cargo chain (default priority), not inside it.
    locks: [
      [RESOURCES.cargo, EXCLUSIVE],
      [RESOURCES.cpu, SHARED],
    ],
    affectedBy: ["src-tauri/", "scripts/"],
  },
  {
    id: "check:tauri-schema",
    script: "check:tauri-schema",
    tiers: ["full"],
    weight: 165_000,
    // Deliberately last of the cargo chain: it is the one gate that mutates a
    // file the TypeScript gates read, and by the time the two cargo gates
    // ahead of it are done those gates have long finished. The schema lock
    // makes that correct rather than merely likely.
    priority: 2,
    locks: [
      [RESOURCES.cargo, EXCLUSIVE],
      [RESOURCES.schema, EXCLUSIVE],
      [RESOURCES.cpu, SHARED],
    ],
    affectedBy: [
      "src-tauri/",
      "src/generated/",
      "Cargo.toml",
      "Cargo.lock",
      "rust-toolchain",
    ],
  },
];

/**
 * Any change to one of these makes every skip decision untrustworthy, so
 * --changed gives up on skipping entirely and runs the full selection. A
 * lockfile bump can change any gate's result; a change under scripts/ can
 * change this file's own rules.
 */
const CHANGED_MODE_ESCAPE_HATCHES = [
  "package.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "scripts/",
  ".npmrc",
];

const HOOK_MARKER = "packetbench-quality-gates-hook v1";

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const opts = {
    tier: "fast",
    jobs: 0,
    changed: false,
    changedSince: null,
    only: [],
    skip: [],
    list: false,
    dryRun: false,
    stream: false,
    json: false,
    tail: 0,
    help: false,
    installHook: false,
    uninstallHook: false,
    force: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const valueOf = (inline) => {
      if (inline !== undefined) return inline;
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) {
        fail(`${arg} needs a value`);
      }
      i += 1;
      return next;
    };
    const [flag, inline] = arg.startsWith("--") && arg.includes("=")
      ? [arg.slice(0, arg.indexOf("=")), arg.slice(arg.indexOf("=") + 1)]
      : [arg, undefined];

    switch (flag) {
      case "--help":
      case "-h":
        opts.help = true;
        break;
      case "--tier":
        opts.tier = valueOf(inline);
        break;
      case "--fast":
        opts.tier = "fast";
        break;
      case "--full":
        opts.tier = "full";
        break;
      case "--jobs":
      case "-j":
        opts.jobs = Number(valueOf(inline));
        break;
      case "--changed":
        opts.changed = true;
        break;
      case "--changed-since":
        opts.changed = true;
        opts.changedSince = valueOf(inline);
        break;
      case "--only":
        opts.only.push(...valueOf(inline).split(",").filter(Boolean));
        break;
      case "--skip":
        opts.skip.push(...valueOf(inline).split(",").filter(Boolean));
        break;
      case "--list":
        opts.list = true;
        break;
      case "--dry-run":
        opts.dryRun = true;
        break;
      case "--stream":
        opts.stream = true;
        break;
      case "--json":
        opts.json = true;
        break;
      case "--tail":
        opts.tail = Number(valueOf(inline));
        break;
      case "--install-hook":
        opts.installHook = true;
        break;
      case "--uninstall-hook":
        opts.uninstallHook = true;
        break;
      case "--force":
        opts.force = true;
        break;
      default:
        fail(`unknown option: ${arg}\nRun with --help for usage.`);
    }
  }

  if (!["fast", "full"].includes(opts.tier)) {
    fail(`unknown tier "${opts.tier}" — expected "fast" or "full"`);
  }
  if (!Number.isFinite(opts.jobs) || opts.jobs < 0) {
    fail("--jobs must be a non-negative number");
  }
  return opts;
}

function fail(message) {
  console.error(`quality-gates: ${message}`);
  process.exit(2);
}

function usage() {
  const ids = GATES.map((gate) => gate.id).join(", ");
  console.log(`PacketBench concurrent quality-gate runner

  node scripts/quality-gates.mjs [--tier fast|full] [options]
  pnpm gates:fast | pnpm gates:full | pnpm gates:changed

Tiers
  --tier fast   (default)  format:check, lint:src, typecheck, test
  --tier full              everything \`pnpm check\` covers, plus typecheck

Selection
  --only a,b               run only these gate ids
  --skip a,b               drop these gate ids
  --changed                skip gates that no changed file can affect
                           (working tree + untracked, vs HEAD)
  --changed-since <ref>    same, but diff against merge-base with <ref>

Execution
  --jobs N, -j N           worker pool size (default: min(4, cpus))
  --dry-run                print the schedule and exit without running anything
  --list                   print the gate catalog and exit

Output
  --stream                 interleave live gate output, prefixed by gate id
  --tail N                 on failure print only the last N lines (0 = all)
  --json                   emit a machine-readable summary on stdout

Git hook (opt-in, never installed automatically)
  --install-hook           install a pre-push hook running the fast tier
  --uninstall-hook         remove it
  --force                  overwrite a foreign pre-push hook

Environment
  PACKETBENCH_GATE_TIMEOUT_MS   per-gate timeout (default 2700000, 45 min)

Gates: ${ids}`);
}

// ---------------------------------------------------------------------------
// Child process plumbing
// ---------------------------------------------------------------------------

/**
 * Spawn `pnpm run <script>` without a shell.
 *
 * This is a Windows-primary repo and `pnpm` is a `.cmd` shim there, so a bare
 * spawn("pnpm") fails with ENOENT. `shell: true` would work but re-parses the
 * whole command line, which is exactly the wrong thing on a tree whose paths
 * contain spaces and backslashes. Spawning ComSpec with `/d /s /c` and passing
 * argv through keeps quoting out of the picture entirely — the same approach
 * scripts/run-pnpm-no-deprecation.mjs already uses.
 */
function spawnPnpm(args, { onData } = {}) {
  const command = isWindows ? (process.env.ComSpec ?? "cmd.exe") : "pnpm";
  const spawnArgs = isWindows ? ["/d", "/s", "/c", "pnpm.cmd", ...args] : args;
  const child = spawn(command, spawnArgs, {
    cwd: root,
    env: process.env,
    shell: false,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const chunks = [];
  const collect = (buffer) => {
    const text = buffer.toString();
    chunks.push(text);
    if (onData) onData(text);
  };
  child.stdout.on("data", collect);
  child.stderr.on("data", collect);
  return { child, output: () => chunks.join("") };
}

/**
 * Kill a child and everything it spawned.
 *
 * `child.kill()` on Windows kills only the cmd.exe wrapper, orphaning the pnpm
 * and cargo processes underneath it — which is how a timed-out cargo gate ends
 * up still holding the target-dir lock the next gate is waiting for.
 */
function killTree(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  if (isWindows) {
    spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
      stdio: "ignore",
      windowsHide: true,
    });
    return;
  }
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch {
    child.kill("SIGKILL");
  }
}

// ---------------------------------------------------------------------------
// --changed
// ---------------------------------------------------------------------------

function git(args) {
  const result = spawnSync("git", args, {
    cwd: root,
    encoding: "utf8",
    windowsHide: true,
  });
  if (result.error || result.status !== 0) return null;
  return result.stdout;
}

/**
 * The set of paths this working tree changes, relative to the repo root and
 * normalised to forward slashes.
 *
 * Returns null — meaning "no evidence, run everything" — whenever git cannot
 * answer, rather than an empty set that would read as "nothing changed".
 */
function changedFiles(sinceRef) {
  let base = "HEAD";
  if (sinceRef) {
    const mergeBase = git(["merge-base", sinceRef, "HEAD"]);
    if (!mergeBase) return null;
    base = mergeBase.trim();
  }
  const tracked = git(["diff", "--name-only", base]);
  const untracked = git(["ls-files", "--others", "--exclude-standard"]);
  if (tracked === null || untracked === null) return null;
  const files = `${tracked}\n${untracked}`
    .split("\n")
    .map((line) => line.trim().replaceAll("\\", "/"))
    .filter(Boolean);
  return [...new Set(files)];
}

function matchesAny(file, prefixes) {
  return prefixes.some((prefix) =>
    prefix.endsWith("/") ? file.startsWith(prefix) : file === prefix || file.startsWith(prefix),
  );
}

/**
 * Decide, per gate, whether the change set can be proven not to affect it.
 *
 * Conservative by construction: this returns a skip only when NO changed path
 * matches the gate's `affectedBy` prefixes, and it refuses to skip anything at
 * all when a lockfile, package.json, or this script's own directory moved.
 */
function planSkips(files, gates) {
  if (files === null) {
    return { skips: new Map(), note: "git could not report a change set — running every gate" };
  }
  if (files.length === 0) {
    return {
      skips: new Map(),
      note: "no changed files — running every gate (a clean tree is not evidence HEAD is green)",
    };
  }
  const escapes = files.filter((file) => matchesAny(file, CHANGED_MODE_ESCAPE_HATCHES));
  if (escapes.length > 0) {
    return {
      skips: new Map(),
      note:
        `${escapes.slice(0, 3).join(", ")}${escapes.length > 3 ? ", …" : ""} changed — ` +
        "skip rules cannot be trusted, running every gate",
    };
  }
  const skips = new Map();
  for (const gate of gates) {
    if (!files.some((file) => matchesAny(file, gate.affectedBy))) {
      skips.set(gate.id, `no changed file under ${gate.affectedBy.join(", ")}`);
    }
  }
  return {
    skips,
    note: `${files.length} changed file(s); ${skips.size} gate(s) provably unaffected`,
  };
}

// ---------------------------------------------------------------------------
// Scheduler
// ---------------------------------------------------------------------------

class ResourceTable {
  constructor() {
    /** @type {Map<string, {exclusive: boolean, holders: number}>} */
    this.held = new Map();
  }

  available(locks) {
    return locks.every(([name, mode]) => {
      const entry = this.held.get(name);
      if (!entry || entry.holders === 0) return true;
      return mode === SHARED && !entry.exclusive;
    });
  }

  acquire(locks) {
    for (const [name, mode] of locks) {
      const entry = this.held.get(name) ?? { exclusive: false, holders: 0 };
      entry.exclusive = mode === EXCLUSIVE;
      entry.holders += 1;
      this.held.set(name, entry);
    }
  }

  release(locks) {
    for (const [name] of locks) {
      const entry = this.held.get(name);
      if (!entry) continue;
      entry.holders -= 1;
      if (entry.holders <= 0) this.held.delete(name);
    }
  }
}

function sortForScheduling(gates) {
  return [...gates].sort((a, b) => {
    const pa = a.priority ?? 100;
    const pb = b.priority ?? 100;
    if (pa !== pb) return pa - pb;
    return b.weight - a.weight;
  });
}

async function runGates(gates, opts) {
  const timeoutMs = Number(process.env.PACKETBENCH_GATE_TIMEOUT_MS ?? 45 * 60 * 1000);
  const jobs = opts.jobs || Math.max(1, Math.min(4, os.cpus().length));
  const resources = new ResourceTable();
  const pending = sortForScheduling(gates);
  const results = [];
  const running = new Set();
  let interrupted = false;

  const log = (line) => {
    if (!opts.json) console.log(line);
  };

  const onInterrupt = () => {
    interrupted = true;
    for (const entry of running) killTree(entry.child);
  };
  process.on("SIGINT", onInterrupt);
  process.on("SIGTERM", onInterrupt);

  const startedAt = Date.now();

  const startOne = (gate) => {
    const gateStartedAt = Date.now();
    log(`  >> ${gate.id} started (${running.size + 1}/${jobs} busy)`);
    resources.acquire(gate.locks);

    const onData = opts.stream
      ? (text) => {
          for (const line of text.split("\n")) {
            if (line.trim()) console.log(`  [${gate.id}] ${line}`);
          }
        }
      : undefined;

    const { child, output } = spawnPnpm(["run", gate.script], { onData });
    const entry = { gate, child };
    running.add(entry);

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child);
    }, timeoutMs);

    return new Promise((resolve) => {
      const finish = (status, signal, spawnError) => {
        clearTimeout(timer);
        running.delete(entry);
        resources.release(gate.locks);
        const ms = Date.now() - gateStartedAt;
        let detail;
        if (spawnError) detail = `could not run: ${spawnError.message}`;
        else if (timedOut) detail = `timed out after ${Math.round(timeoutMs / 1000)}s`;
        else if (interrupted && status !== 0) detail = "interrupted";
        else if (signal) detail = `killed by ${signal}`;
        else detail = `exit ${status}`;
        const ok = !spawnError && !timedOut && status === 0;
        results.push({
          id: gate.id,
          script: gate.script,
          status: ok ? "PASS" : "FAIL",
          ms,
          detail,
          output: ok ? "" : output(),
        });
        log(`  ${ok ? "ok" : "FAIL"} ${gate.id} (${(ms / 1000).toFixed(1)}s)`);
        resolve();
      };

      child.on("error", (error) => finish(null, null, error));
      child.on("close", (status, signal) => finish(status, signal, null));
    });
  };

  const inFlight = new Set();
  while (pending.length > 0 || inFlight.size > 0) {
    let launched = false;
    if (!interrupted) {
      for (let i = 0; i < pending.length && inFlight.size < jobs; ) {
        const gate = pending[i];
        if (!resources.available(gate.locks)) {
          i += 1;
          continue;
        }
        pending.splice(i, 1);
        const promise = startOne(gate).then(() => {
          inFlight.delete(promise);
        });
        inFlight.add(promise);
        launched = true;
      }
    }
    if (interrupted) {
      // Drop anything not yet started; report it honestly below.
      while (pending.length > 0) {
        const gate = pending.shift();
        results.push({
          id: gate.id,
          script: gate.script,
          status: "SKIP",
          ms: 0,
          detail: "not started (interrupted)",
          output: "",
        });
      }
    }
    if (inFlight.size === 0 && !launched && pending.length > 0) {
      // Unreachable with the current catalog, but a future gate that locks a
      // resource nothing releases would otherwise spin forever.
      const stuck = pending.map((gate) => gate.id).join(", ");
      throw new Error(`gate scheduler deadlocked with nothing running: ${stuck}`);
    }
    if (inFlight.size > 0) await Promise.race(inFlight);
  }

  process.off("SIGINT", onInterrupt);
  process.off("SIGTERM", onInterrupt);

  return { results, wallMs: Date.now() - startedAt, jobs, interrupted };
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

function seconds(ms) {
  return `${(ms / 1000).toFixed(1)}s`;
}

function printSummary(rows, wallMs, jobs, opts) {
  const width = Math.max(4, ...rows.map((row) => row.id.length));
  const pad = (text, n) => String(text).padEnd(n);

  console.log("");
  console.log(`${pad("GATE", width)}  RESULT  ${pad("TIME", 8)}  DETAIL`);
  console.log(`${"-".repeat(width)}  ------  ${"-".repeat(8)}  ------`);
  for (const row of rows) {
    const time = row.status === "SKIP" ? "-" : seconds(row.ms);
    console.log(`${pad(row.id, width)}  ${pad(row.status, 6)}  ${pad(time, 8)}  ${row.detail}`);
  }

  const failures = rows.filter((row) => row.status === "FAIL");
  const skipped = rows.filter((row) => row.status === "SKIP");
  const executed = rows.filter((row) => row.status !== "SKIP");
  const gateMs = executed.reduce((sum, row) => sum + row.ms, 0);

  console.log("");
  console.log(
    `Wall clock ${seconds(wallMs)} across ${executed.length} executed gate(s) ` +
      `(${seconds(gateMs)} of gate time, pool of ${jobs}).`,
  );

  for (const row of failures) {
    console.log("");
    console.log(`--- ${row.id} FAILED (${row.detail}) ---`);
    const lines = row.output.split("\n");
    const shown = opts.tail > 0 ? lines.slice(-opts.tail) : lines;
    if (shown.length < lines.length) {
      console.log(`  | … ${lines.length - shown.length} earlier line(s) hidden by --tail`);
    }
    console.log(
      shown
        .join("\n")
        .replace(/\s+$/, "")
        .replace(/^/gm, "  | "),
    );
  }

  console.log("");
  if (skipped.length > 0) {
    console.log(
      `NOT VERIFIED: ${skipped.map((row) => row.id).join(", ")} — ` +
        "these gates did not run and this result says nothing about them.",
    );
  }
  if (failures.length > 0) {
    console.log(`FAILED: ${failures.length} of ${executed.length} executed gate(s).`);
  } else if (executed.length > 0) {
    console.log(`PASSED: all ${executed.length} executed gate(s).`);
  } else {
    console.log("Nothing executed.");
  }
}

// ---------------------------------------------------------------------------
// Opt-in git hook
// ---------------------------------------------------------------------------

/**
 * Resolve the directory git will actually read hooks from.
 *
 * `git rev-parse --git-path hooks` honours core.hooksPath, which matters here:
 * this repo currently points core.hooksPath at a directory left behind by an
 * earlier rename, so writing into .git/hooks would install a hook git never
 * runs. Refuse rather than pretend.
 */
function hooksDir() {
  const raw = git(["rev-parse", "--git-path", "hooks"]);
  if (raw === null) return { error: "not a git repository (or git is unavailable)" };
  const resolved = path.resolve(root, raw.trim());
  const configured = git(["config", "--get", "core.hooksPath"]);
  if (configured !== null && configured.trim() && !existsSync(resolved)) {
    return {
      error:
        `core.hooksPath points at ${configured.trim()}, which does not exist — ` +
        "git runs no hooks at all in this repo right now. Fix it with " +
        "`git config --unset core.hooksPath` (or point it somewhere real), then retry.",
    };
  }
  return { dir: resolved };
}

function hookBody() {
  return [
    "#!/bin/sh",
    `# ${HOOK_MARKER}`,
    "# Installed on purpose by \`pnpm gates:install-hook\`. Never installed automatically.",
    "# Remove with \`pnpm gates:uninstall-hook\`, or just delete this file.",
    "# Bypass one push with \`git push --no-verify\` or PACKETBENCH_SKIP_GATES=1.",
    "",
    'if [ -n "$PACKETBENCH_SKIP_GATES" ]; then',
    '  echo "pre-push: PACKETBENCH_SKIP_GATES set, skipping quality gates."',
    "  exit 0",
    "fi",
    "",
    'exec node "scripts/quality-gates.mjs" --tier fast',
    "",
  ].join("\n");
}

function installHook(force) {
  const { dir, error } = hooksDir();
  if (error) fail(error);
  const target = path.join(dir, "pre-push");
  if (existsSync(target)) {
    const current = readFileSync(target, "utf8");
    if (!current.includes(HOOK_MARKER) && !force) {
      fail(
        `${target} already exists and was not installed by this script. ` +
          "Inspect it, then re-run with --force to replace it.",
      );
    }
  }
  mkdirSync(dir, { recursive: true });
  writeFileSync(target, hookBody(), { mode: 0o755 });
  console.log(`Installed pre-push hook: ${target}`);
  console.log("It runs `node scripts/quality-gates.mjs --tier fast` before every push.");
  console.log("Remove it with `pnpm gates:uninstall-hook`. Bypass once with `git push --no-verify`.");
}

function uninstallHook() {
  const { dir, error } = hooksDir();
  if (error) fail(error);
  const target = path.join(dir, "pre-push");
  if (!existsSync(target) || !statSync(target).isFile()) {
    console.log(`No pre-push hook at ${target}; nothing to remove.`);
    return;
  }
  const current = readFileSync(target, "utf8");
  if (!current.includes(HOOK_MARKER)) {
    fail(
      `${target} was not installed by this script — refusing to delete someone else's hook. ` +
        "Remove it by hand if you are sure.",
    );
  }
  rmSync(target);
  console.log(`Removed pre-push hook: ${target}`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const opts = parseArgs(process.argv.slice(2));

  if (opts.help) {
    usage();
    return 0;
  }
  if (opts.installHook) {
    installHook(opts.force);
    return 0;
  }
  if (opts.uninstallHook) {
    uninstallHook();
    return 0;
  }
  if (opts.list) {
    for (const gate of GATES) {
      const locks = gate.locks.map(([name, mode]) => `${name} (${mode})`).join("; ") || "none";
      console.log(`${gate.id}`);
      console.log(`  script  pnpm run ${gate.script}`);
      console.log(`  tiers   ${gate.tiers.join(", ")}`);
      console.log(`  locks   ${locks}`);
      console.log(`  affected by  ${gate.affectedBy.join(", ")}`);
    }
    return 0;
  }

  // Every gate must still be a real package script — the whole design depends
  // on this runner and `pnpm run <gate>` being the same command.
  const scripts = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")).scripts ?? {};
  const missing = GATES.filter((gate) => !scripts[gate.script]).map((gate) => gate.script);
  if (missing.length > 0) {
    fail(`package.json is missing script(s): ${missing.join(", ")}`);
  }

  let selected = GATES.filter((gate) => gate.tiers.includes(opts.tier));
  if (opts.only.length > 0) {
    const known = new Set(GATES.map((gate) => gate.id));
    const unknown = opts.only.filter((id) => !known.has(id));
    if (unknown.length > 0) fail(`unknown gate id(s) in --only: ${unknown.join(", ")}`);
    selected = GATES.filter((gate) => opts.only.includes(gate.id));
  }
  if (opts.skip.length > 0) {
    selected = selected.filter((gate) => !opts.skip.includes(gate.id));
  }

  let skipRows = [];
  if (opts.changed) {
    const files = changedFiles(opts.changedSince);
    const { skips, note } = planSkips(files, selected);
    if (!opts.json) console.log(`Changed-file analysis: ${note}`);
    skipRows = selected
      .filter((gate) => skips.has(gate.id))
      .map((gate) => ({
        id: gate.id,
        script: gate.script,
        status: "SKIP",
        ms: 0,
        detail: skips.get(gate.id),
        output: "",
      }));
    selected = selected.filter((gate) => !skips.has(gate.id));
  }

  if (opts.dryRun) {
    const jobs = opts.jobs || Math.max(1, Math.min(4, os.cpus().length));
    console.log(`Tier: ${opts.tier}   pool: ${jobs}   (dry run — nothing executed)`);
    console.log("Launch order (highest priority first; locks may delay a start):");
    for (const gate of sortForScheduling(selected)) {
      const locks = gate.locks.map(([name, mode]) => `${name}:${mode}`).join(", ") || "-";
      console.log(`  ${gate.id.padEnd(20)} locks[${locks}]`);
    }
    for (const row of skipRows) console.log(`  ${row.id.padEnd(20)} SKIP (${row.detail})`);
    return 0;
  }

  const jobsPreview = opts.jobs || Math.max(1, Math.min(4, os.cpus().length));
  if (!opts.json) {
    console.log(
      `PacketBench quality gates — tier "${opts.tier}", ` +
        `${selected.length} gate(s), pool of ${jobsPreview}, no short-circuit.`,
    );
  }

  const { results, wallMs, jobs, interrupted } = await runGates(selected, opts);

  // Report in catalog order so the table is stable run to run.
  const order = new Map(GATES.map((gate, index) => [gate.id, index]));
  const rows = [...results, ...skipRows].sort(
    (a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0),
  );

  if (opts.json) {
    console.log(
      JSON.stringify(
        {
          tier: opts.tier,
          jobs,
          wallMs,
          interrupted,
          gates: rows.map(({ output, ...rest }) => rest),
        },
        null,
        2,
      ),
    );
  } else {
    printSummary(rows, wallMs, jobs, opts);
  }

  const failed = rows.some((row) => row.status === "FAIL");
  return failed || interrupted ? 1 : 0;
}

// Exported so scripts/quality-gates.test.mjs can exercise the graph and the
// --changed skip rules as pure functions, without spawning an eight-minute run.
export {
  CHANGED_MODE_ESCAPE_HATCHES,
  EXCLUSIVE,
  GATES,
  HOOK_MARKER,
  RESOURCES,
  ResourceTable,
  SHARED,
  hookBody,
  matchesAny,
  planSkips,
  sortForScheduling,
};

const invokedDirectly =
  Boolean(process.argv[1]) && pathToFileURL(process.argv[1]).href === import.meta.url;

if (invokedDirectly) {
  main()
    .then((code) => process.exit(code))
    .catch((error) => {
      console.error(error?.stack ?? String(error));
      process.exit(1);
    });
}
