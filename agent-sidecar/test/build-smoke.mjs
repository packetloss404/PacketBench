import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildSidecar } from "../scripts/build.mjs";

const scratch = mkdtempSync(path.join(tmpdir(), "sidecar-build-smoke-"));
try {
  const fixture = path.join(scratch, "package");
  mkdirSync(path.join(fixture, "src"), { recursive: true });
  mkdirSync(path.join(fixture, "dist/mcp"), { recursive: true });
  writeFileSync(
    path.join(fixture, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        outDir: "dist",
        rootDir: "src",
        target: "ES2022",
        skipLibCheck: true,
        types: [],
      },
      include: ["src/**/*.ts"],
    }),
  );
  writeFileSync(
    path.join(fixture, "src/index.ts"),
    'const message: string = "current source";\nconsole.log(message);\n',
  );
  writeFileSync(path.join(fixture, "dist/index.js"), "stale entry");
  const stale = path.join(fixture, "dist/mcp/flight-planner-server.js");
  writeFileSync(stale, "retired planner must not ship");
  buildSidecar(fixture);
  assert(!existsSync(stale), "Deleted source output must disappear from a new build");
  assert.match(readFileSync(path.join(fixture, "dist/index.js"), "utf8"), /current source/);

  const linked = path.join(scratch, "linked-package");
  const outside = path.join(scratch, "outside");
  mkdirSync(linked);
  mkdirSync(outside);
  const marker = path.join(outside, "keep.txt");
  writeFileSync(marker, "keep");
  symlinkSync(
    outside,
    path.join(linked, "dist"),
    process.platform === "win32" ? "junction" : "dir",
  );
  assert.throws(() => buildSidecar(linked), /Refusing to clean linked/);
  assert.equal(
    readFileSync(marker, "utf8"),
    "keep",
    "A linked output must never remove outside files",
  );
  const broken = path.join(scratch, "broken-package");
  mkdirSync(broken);
  symlinkSync(
    path.join(scratch, "missing"),
    path.join(broken, "dist"),
    process.platform === "win32" ? "junction" : "dir",
  );
  assert.throws(() => buildSidecar(broken), /Refusing to clean linked/);
  console.log(
    "PASS sidecar build: stale output removed, current entry compiled, linked dist refused",
  );
} finally {
  assert.equal(path.dirname(scratch), path.resolve(tmpdir()));
  assert(path.basename(scratch).startsWith("sidecar-build-smoke-"));
  rmSync(scratch, { recursive: true, force: true });
}
