import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
export const config = JSON.parse(
  readFileSync(path.join(root, "src-tauri/tauri.conf.json"), "utf8"),
);
export const dataDir = readFileSync(path.join(root, "src-tauri/src/core/brand.rs"), "utf8").match(
  /pub const DATA_DIR_NAME: &str = "([^"]+)";/,
)?.[1];
if (!dataDir) throw new Error("Cannot resolve canonical Rust data directory");
export const hash = (file) => createHash("sha256").update(readFileSync(file)).digest("hex");
export function treeHash(directory) {
  const result = createHash("sha256");
  function visit(dir, prefix = "") {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name, "en"),
    )) {
      const file = path.join(dir, entry.name);
      const name = path.posix.join(prefix, entry.name);
      if (entry.isDirectory()) visit(file, name);
      else if (entry.isFile()) result.update(`${name}\0${hash(file)}\n`);
      else throw new Error(`Unexpected non-file: ${file}`);
    }
  }
  visit(directory);
  return result.digest("hex");
}
export function sourceIdentity() {
  const git = (...args) =>
    execFileSync("git", args, { cwd: root, encoding: "utf8", windowsHide: true });
  const files = [
    ...new Set(git("ls-files", "-co", "--exclude-standard", "-z").split("\0").filter(Boolean)),
  ].sort();
  const tree = createHash("sha256");
  for (const file of files) {
    // Deleted tracked files remain in ls-files: bind their absence as well.
    let digest;
    try {
      digest = hash(path.join(root, file));
    } catch (e) {
      if (e.code !== "ENOENT") throw e;
      digest = "deleted";
    }
    tree.update(`${file}\0${digest}\n`);
  }
  return {
    head: git("rev-parse", "HEAD").trim(),
    dirty: Boolean(git("status", "--porcelain").trim()),
    sourceSha256: tree.digest("hex"),
    files: files.length,
  };
}
