import { readFile, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

/** Read the execution host's trust list, never a desktop path or repo setting.
 * The supervisor supplies the directory name from its central brand module.
 * Missing protocol fields, malformed files and unresolved paths deny trust.
 * As in Rust, trust is an exact canonical root match, with no inheritance.
 */
export async function isProjectTrusted(cwd: string, dataDir?: string): Promise<boolean> {
  if (!dataDir || !/^\.[a-zA-Z0-9_-]+$/.test(dataDir) || !isAbsolute(cwd)) return false;
  try {
    const parsed: unknown = JSON.parse(
      await readFile(join(homedir(), dataDir, "trusted-projects.json"), "utf8"),
    );
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return false;
    const { version, projects } = parsed as { version?: unknown; projects?: unknown };
    if (version !== 1 || !Array.isArray(projects)) return false;
    const project = await realpath(cwd);
    for (const entry of projects) {
      if (typeof entry !== "string" || !isAbsolute(entry.trim())) continue;
      try {
        if ((await realpath(entry.trim())) === project) return true;
      } catch {
        // A stale entry cannot grant trust, but does not invalidate other roots.
      }
    }
  } catch {
    // No usable trust list means no project-supplied executables.
  }
  return false;
}
