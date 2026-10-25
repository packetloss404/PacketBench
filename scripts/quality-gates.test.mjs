/**
 * Fences for the concurrent quality-gate runner.
 *
 * The runner's whole value rests on two claims that are cheap to get wrong and
 * expensive to notice: that gates which contend are actually serialised, and
 * that `--changed` never skips a gate a change could have broken. Both are
 * pure functions of the catalog, so they are asserted here rather than
 * discovered during an eight-minute run.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
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
} from "./quality-gates.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packageJson = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));

const gateById = (id) => GATES.find((gate) => gate.id === id);

describe("gate catalog", () => {
  it("names only scripts that package.json actually defines", () => {
    // The runner is a scheduler, not a second definition of the gates. If a
    // script is renamed, this fails here instead of half way through a run.
    const missing = GATES.filter((gate) => !packageJson.scripts?.[gate.script]).map(
      (gate) => gate.id,
    );
    expect(missing).toEqual([]);
  });

  it("keeps the pre-existing chained entry points untouched", () => {
    // preflight/check are what humans and scripts/release-readiness.mjs still
    // rely on; this runner adds a path, it does not replace one.
    expect(packageJson.scripts.preflight).toContain("&&");
    expect(packageJson.scripts.check).toContain("pnpm run preflight");
    expect(packageJson.scripts.prebundle).toContain("pnpm run release:gate");
  });

  it("covers every gate `pnpm check` runs", () => {
    const referenced = new Set();
    const expand = (body) => {
      for (const [, name] of String(body ?? "").matchAll(/\bpnpm\s+(?:run\s+)?([A-Za-z][\w:-]*)/g)) {
        if (name === "preflight") expand(packageJson.scripts.preflight);
        else referenced.add(name);
      }
    };
    expand(packageJson.scripts.check);

    const fullTier = new Set(
      GATES.filter((gate) => gate.tiers.includes("full")).map((gate) => gate.script),
    );
    // `test` is spelled `pnpm test` in the chain, which the regex reads as the
    // script name `test` — same thing.
    const uncovered = [...referenced].filter((name) => !fullTier.has(name));
    expect(uncovered).toEqual([]);
  });

  it("gives every gate a fast-or-full tier and a scheduling weight", () => {
    for (const gate of GATES) {
      expect(gate.tiers.length, gate.id).toBeGreaterThan(0);
      expect(gate.weight, gate.id).toBeGreaterThan(0);
      expect(gate.affectedBy.length, gate.id).toBeGreaterThan(0);
    }
  });
});

describe("resource locks", () => {
  it("serialises every cargo gate against every other cargo gate", () => {
    // All of them shell out to cargo and would block on the shared target-dir
    // lock; running them concurrently buys nothing and hides the real cost.
    const cargoGates = ["rust:check", "rust:test", "check:tauri-schema", "runtime:eval"].map(
      gateById,
    );
    const table = new ResourceTable();
    table.acquire(cargoGates[0].locks);
    expect(table.available(cargoGates[1].locks)).toBe(false);
    expect(table.available(cargoGates[2].locks)).toBe(false);
    expect(table.available(cargoGates[3].locks)).toBe(false);
    table.release(cargoGates[0].locks);
    expect(table.available(cargoGates[1].locks)).toBe(true);
  });

  it("blocks the schema writer against the gates that read the generated file", () => {
    // check:tauri-schema lets cargo overwrite src/generated/tauri-schema.ts and
    // then restores it. tsc and Vitest both resolve that file through
    // src/lib/tauri.ts, so they must not be mid-read while it is swapped.
    const schemaWriter = gateById("check:tauri-schema");
    const table = new ResourceTable();
    table.acquire(gateById("typecheck").locks);
    expect(table.available(schemaWriter.locks)).toBe(false);
    // ...but two readers still run together. `build` rather than `test` here:
    // both read the schema and both take `cpu` shared, so this isolates the
    // schema rule instead of colliding with the timing rule below.
    expect(table.available(gateById("build").locks)).toBe(true);
    table.release(gateById("typecheck").locks);
    expect(table.available(schemaWriter.locks)).toBe(true);
  });

  it("lets the genuinely independent gates run together", () => {
    const table = new ResourceTable();
    for (const id of ["lint:src", "format:check", "typecheck", "build", "remoteagents:check"]) {
      expect(table.available(gateById(id).locks), id).toBe(true);
      table.acquire(gateById(id).locks);
    }
  });

  it("never co-schedules a wall-clock-sensitive gate with anything else heavy", () => {
    // REGRESSION: these three assert on elapsed time — Vitest budgets, the
    // sidecar smokes' fixed millisecond waits, and Playwright waiting on a dev
    // server — while `cargo` will happily eat every core. Run together they
    // produced false failures: a sidecar smoke timing out at 20s doing work
    // that takes ~0.9s on an idle machine, and a store test blowing a 15s
    // budget it meets in under a second alone. Each must hold `cpu`
    // exclusively.
    const timingSensitive = ["test", "e2e", "sidecar:check"];
    for (const id of timingSensitive) {
      expect(
        gateById(id).locks.some(([name, mode]) => name === RESOURCES.cpu && mode === EXCLUSIVE),
        id,
      ).toBe(true);
    }

    // No two of them, and nothing core-hungry alongside one of them.
    for (const id of timingSensitive) {
      const table = new ResourceTable();
      table.acquire(gateById(id).locks);
      for (const other of [...timingSensitive.filter((x) => x !== id), "rust:check", "build"]) {
        expect(table.available(gateById(other).locks), `${other} during ${id}`).toBe(false);
      }
      // The genuinely cheap gate is still free to fill the slot.
      expect(table.available(gateById("format:check").locks)).toBe(true);
    }
  });

  it("starts the cargo chain first, cheapest cargo gate leading", () => {
    // The cargo group is the critical path of a full run; if it starts last the
    // pool drains and the wall clock is just the serial time again.
    const order = sortForScheduling(GATES.filter((gate) => gate.tiers.includes("full"))).map(
      (gate) => gate.id,
    );
    expect(order.slice(0, 3)).toEqual(["rust:check", "rust:test", "check:tauri-schema"]);
  });

  it("uses exclusive mode wherever a gate mutates a shared path", () => {
    const exclusiveOf = (id) => gateById(id).locks.filter(([, mode]) => mode === EXCLUSIVE).length;
    expect(exclusiveOf("sidecar:check")).toBeGreaterThan(0);
    expect(exclusiveOf("build")).toBeGreaterThan(0);
    expect(exclusiveOf("e2e")).toBeGreaterThan(0);
    expect(gateById("typecheck").locks.every(([, mode]) => mode === SHARED)).toBe(true);
  });
});

describe("--changed skip rules", () => {
  const fullTier = GATES.filter((gate) => gate.tiers.includes("full"));
  const skipsFor = (files) => planSkips(files, fullTier).skips;

  it("runs everything when git cannot report a change set", () => {
    expect(skipsFor(null).size).toBe(0);
  });

  it("runs everything on a clean tree rather than claiming a verified HEAD", () => {
    const { skips, note } = planSkips([], fullTier);
    expect(skips.size).toBe(0);
    expect(note).toMatch(/not evidence/);
  });

  it("abandons skipping entirely when a lockfile or script changed", () => {
    for (const escape of CHANGED_MODE_ESCAPE_HATCHES) {
      const file = escape.endsWith("/") ? `${escape}something.mjs` : escape;
      expect(skipsFor([file, "README.md"]).size, file).toBe(0);
    }
  });

  it("skips the cargo group only when no Rust-adjacent path moved", () => {
    const frontendOnly = skipsFor(["src/components/views/AgentsView.tsx"]);
    expect(frontendOnly.has("rust:check")).toBe(true);
    expect(frontendOnly.has("rust:test")).toBe(true);
    expect(frontendOnly.has("check:tauri-schema")).toBe(true);

    for (const rustish of [
      "src-tauri/src/lib.rs",
      "src-tauri/Cargo.toml",
      "Cargo.lock",
      "rust-toolchain.toml",
    ]) {
      const skips = skipsFor([rustish]);
      expect(skips.has("rust:check"), rustish).toBe(false);
      expect(skips.has("rust:test"), rustish).toBe(false);
    }
  });

  it("never skips the schema gate when the generated file itself moved", () => {
    // The gate's whole job is comparing that file against a fresh export, so a
    // hand-edit to it is precisely when it must run.
    const skips = skipsFor(["src/generated/tauri-schema.ts"]);
    expect(skips.has("check:tauri-schema")).toBe(false);
  });

  it("skips sidecar and remoteagents only when their trees are untouched", () => {
    expect(skipsFor(["src/App.tsx"]).has("sidecar:check")).toBe(true);
    expect(skipsFor(["agent-sidecar/src/index.ts"]).has("sidecar:check")).toBe(false);
    expect(skipsFor(["src/App.tsx"]).has("remoteagents:check")).toBe(true);
    expect(skipsFor(["remoteagents/shared/src/index.ts"]).has("remoteagents:check")).toBe(false);
  });

  it("keeps the frontend gates whenever anything under src/ moved", () => {
    const skips = skipsFor(["src/stores/agentStore.ts"]);
    for (const id of ["lint:src", "typecheck", "test", "build", "e2e"]) {
      expect(skips.has(id), id).toBe(false);
    }
  });

  it("matches directory prefixes without matching sibling names", () => {
    // "src/" must not swallow "src-tauri/..." — that would be the wrong kind of
    // over-run, but more importantly the reverse mistake would skip real work.
    expect(matchesAny("src-tauri/src/lib.rs", ["src/"])).toBe(false);
    expect(matchesAny("src/lib/tauri.ts", ["src/"])).toBe(true);
  });
});

describe("opt-in pre-push hook", () => {
  it("is identifiable, bypassable, and runs only the fast tier", () => {
    const body = hookBody();
    expect(body).toContain(HOOK_MARKER);
    expect(body).toContain("--tier fast");
    expect(body).toContain("PACKETBENCH_SKIP_GATES");
    expect(body).toContain("gates:uninstall-hook");
  });

  it("is not wired into any install lifecycle script", () => {
    // Installing git hooks behind someone's back is how a repo earns a
    // reputation. The only path to a hook is the explicit command.
    for (const [name, body] of Object.entries(packageJson.scripts)) {
      if (name === "gates:install-hook") continue;
      expect(String(body), name).not.toContain("--install-hook");
    }
    expect(packageJson.scripts.postinstall).not.toContain("gates");
  });
});
