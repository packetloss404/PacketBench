import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { onTestFinished, test } from "vitest";
import { executableHashes } from "./executable-hashes.mjs";

function fixture(mutate = () => {}) {
  const dir = mkdtempSync(path.join(tmpdir(), "bundle-hash-test-"));
  onTestFinished(() => {
    assert(
      path.dirname(dir) === path.resolve(tmpdir()) &&
        path.basename(dir).startsWith("bundle-hash-test-"),
    );
    rmSync(dir, { recursive: true, force: true });
  });
  const bytes = Buffer.alloc(512);
  bytes.writeUInt32LE(0x40, 0x3c);
  bytes.write("PE\0\0", 0x40);
  bytes.writeUInt16LE(0x20b, 0x58);
  bytes.write("__TAURI_BUNDLE_TYPE_VAR_UNK", 256);
  // A format string elsewhere in the image is not the patch target.
  bytes.write("__TAURI_BUNDLE_TYPE_VAR_NSS", 320);
  mutate(bytes);
  const file = path.join(dir, "app.exe");
  writeFileSync(file, bytes);
  return { file, bytes };
}
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");

test("hashes each format without modifying the build output or another marker", () => {
  const { file, bytes } = fixture();
  const actual = executableHashes(file);
  assert.equal(actual.original, hash(bytes));
  for (const [kind, marker] of [
    ["nsis", "NSS"],
    ["msi", "MSI"],
  ]) {
    const expected = Buffer.from(bytes);
    expected.write(`__TAURI_BUNDLE_TYPE_VAR_${marker}`, 256);
    assert.equal(actual[kind], hash(expected));
  }
  assert.deepEqual(readFileSync(file), bytes);
});

test("rejects an already-patched executable instead of guessing the target", () => {
  const { file } = fixture((bytes) => bytes.write("__TAURI_BUNDLE_TYPE_VAR_NSS", 256));
  assert.throws(() => executableHashes(file), /unpatched Tauri marker/);
});

test("rejects ambiguous patch targets", () => {
  const { file } = fixture((bytes) => bytes.write("__TAURI_BUNDLE_TYPE_VAR_UNK", 320));
  assert.throws(() => executableHashes(file), /unpatched Tauri marker/);
});

test("rejects signed binaries that need per-format signing evidence", () => {
  const { file } = fixture((bytes) => bytes.writeUInt32LE(64, 0x58 + 112 + 4 * 8 + 4));
  assert.throws(() => executableHashes(file), /Signed executable/);
});
