import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

// Tauri patches this marker for each installer and then restores the original
// executable. Derive exact unsigned payload hashes without changing the file.
// Signed binaries need hashes captured after each format's signing step.
export function executableHashes(file) {
  const bytes = readFileSync(file);
  const pe = bytes.readUInt32LE(0x3c);
  assert.equal(bytes.toString("ascii", pe, pe + 4), "PE\0\0", "not a PE executable");
  const optional = pe + 24;
  const magic = bytes.readUInt16LE(optional);
  assert([0x10b, 0x20b].includes(magic), "unsupported PE optional header");
  const directories = optional + (magic === 0x20b ? 112 : 96);
  assert.equal(
    bytes.readUInt32LE(directories + 4 * 8 + 4),
    0,
    "Signed executable: capture each installer's post-signing payload; unsigned marker derivation is not valid",
  );
  const prefix = Buffer.from("__TAURI_BUNDLE_TYPE_VAR_");
  const token = Buffer.concat([prefix, Buffer.from("UNK")]);
  const index = bytes.indexOf(token);
  assert(
    index >= 0 && bytes.indexOf(token, index + 1) === -1,
    "Expected one unpatched Tauri marker; wait until bundling restores the original executable",
  );
  const suffix = index + prefix.length;
  assert(
    ["UNK", "NSS", "MSI"].includes(bytes.toString("ascii", suffix, suffix + 3)),
    "unknown Tauri bundle marker",
  );
  const sha256 = (buffer) => createHash("sha256").update(buffer).digest("hex");
  const original = sha256(bytes);
  const hashes = {};
  for (const [format, marker] of [
    ["nsis", "NSS"],
    ["msi", "MSI"],
  ]) {
    const copy = Buffer.from(bytes);
    copy.write(marker, suffix, "ascii");
    hashes[format] = sha256(copy);
  }
  return { original, ...hashes };
}
