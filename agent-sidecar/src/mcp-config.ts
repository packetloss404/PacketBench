// v8 (S8-Phase-B): remote-owned MCP config sourcing.
//
// When a session is launched with `sourceMcpFromFs: true`, the sidecar (which
// runs ON the remote host for SSH sessions) sources its OWN MCP config from the
// remote filesystem instead of trusting the `mcpServers` map the supervisor
// would otherwise forward. This keeps local commands/secrets off the remote
// host and lets stdio server command/args resolve against the remote PATH.
//
// Sources, merged project-over-global:
//   - Global:  ~/.claude/settings.json     ("mcpServers" object)
//   - Project: <cwd>/.mcp.json             (only with explicit host project trust)
//
// This module is pure and unit-testable: no process spawning, no protocol
// coupling beyond the shared source/error summary shapes. It NEVER throws —
// every read/parse problem is folded into `readErrors` so the caller can still
// start the session and surface the failures in the UX.

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { isProjectTrusted } from "./project-trust.js";

export type McpTransport = "stdio" | "http" | "sse";

export type McpScope = "global" | "project";

export interface McpSourceInfo {
  name: string;
  transport: McpTransport;
  scope: McpScope;
}

export interface McpReadError {
  scope: McpScope;
  path: string;
  message: string;
}

export interface McpSourceSummary {
  sources: McpSourceInfo[];
  readErrors: McpReadError[];
}

/** Absolute path to the global Claude settings file (`~/.claude/settings.json`). */
export function globalSettingsPath(): string {
  return join(homedir(), ".claude", "settings.json");
}

/** Absolute path to a project's `.mcp.json` for the given working directory. */
export function projectMcpPath(cwd: string): string {
  return join(cwd, ".mcp.json");
}

/** Node's error objects carry a string `code` (e.g. "ENOENT"); narrow to it. */
function errorCode(err: unknown): string | undefined {
  if (err && typeof err === "object" && "code" in err) {
    const code = (err as { code?: unknown }).code;
    if (typeof code === "string") return code;
  }
  return undefined;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Read one MCP config file and pull its `mcpServers` object.
 *
 * - Missing file (ENOENT) → `{ servers: {} }`, no error (a project may simply
 *   have no `.mcp.json`, or the user may have no global settings).
 * - Any other read error or JSON parse failure → `{ servers: {}, error }`.
 * - Valid JSON whose `mcpServers` is absent or not an object → `{ servers: {} }`,
 *   no error (a settings file with no MCP block is normal).
 */
export async function readMcpServersFile(
  filePath: string,
  scope: McpScope,
): Promise<{ servers: Record<string, unknown>; error?: McpReadError }> {
  let content: string;
  try {
    content = await readFile(filePath, "utf8");
  } catch (err) {
    if (errorCode(err) === "ENOENT") {
      return { servers: {} };
    }
    return {
      servers: {},
      error: { scope, path: filePath, message: errorMessage(err) },
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (err) {
    return {
      servers: {},
      error: { scope, path: filePath, message: errorMessage(err) },
    };
  }

  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    const servers = (parsed as { mcpServers?: unknown }).mcpServers;
    if (servers && typeof servers === "object" && !Array.isArray(servers)) {
      return { servers: servers as Record<string, unknown> };
    }
  }
  return { servers: {} };
}

/**
 * Normalize a raw MCP server entry into the shape the providers consume.
 *
 * - `disabled: true` → returns `null` (the entry is dropped; never sourced).
 * - Otherwise strips `disabled` and defaults `type` to `"stdio"` when absent —
 *   critical because `openai-agents.ts` requires an exact `type === "stdio"`
 *   match before it will spawn a stdio server.
 */
export function normalizeEntry(
  raw: unknown,
): { entry: Record<string, unknown>; transport: McpTransport } | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const source = raw as Record<string, unknown>;
  if (source.disabled === true) return null;

  const entry: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(source)) {
    if (key === "disabled") continue;
    entry[key] = value;
  }

  const rawType = typeof entry.type === "string" ? entry.type : undefined;
  const transport: McpTransport =
    rawType === "http" || rawType === "sse" ? rawType : "stdio";
  entry.type = transport;

  return { entry, transport };
}

/**
 * Load MCP servers from the sidecar's own filesystem: global settings first,
 * then trusted project `.mcp.json` (project overwrites global on matching name).
 * The trust decision happens before merging; an untrusted project cannot
 * replace global commands that the capability probe will later execute.
 *
 * Never throws. Each `readError` is also logged to stderr with a `[sidecar]`
 * prefix so the failure is visible in host logs, not only in the UX summary.
 */
export async function loadMcpFromFs(
  cwd: string,
  _sessionId: string,
  projectTrustDataDir?: string,
): Promise<{ servers: Record<string, unknown>; summary: McpSourceSummary }> {
  const servers: Record<string, unknown> = {};
  const sources: McpSourceInfo[] = [];
  const readErrors: McpReadError[] = [];
  const projectTrusted = await isProjectTrusted(cwd, projectTrustDataDir);

  const scopes: { scope: McpScope; path: string }[] = [];
  // Resolving the global path calls os.homedir(), which THROWS (not returns
  // "") when $HOME is unset AND the uid has no passwd entry — a real config on
  // containerized/sandboxed SSH targets. Guard it so a missing home degrades to
  // a read error instead of failing the whole session. If homedir cannot be
  // resolved the host trust list cannot be read either, so project config
  // remains denied.
  try {
    scopes.push({ scope: "global", path: globalSettingsPath() });
  } catch (err) {
    const message = errorMessage(err);
    readErrors.push({ scope: "global", path: "~/.claude/settings.json", message });
    process.stderr.write(
      `[sidecar] failed to resolve global MCP config path (home directory unavailable): ${message}\n`,
    );
  }
  scopes.push({ scope: "project", path: projectMcpPath(cwd) });

  for (const { scope, path } of scopes) {
    const { servers: raw, error } = await readMcpServersFile(path, scope);
    if (error) {
      readErrors.push(error);
      process.stderr.write(
        `[sidecar] failed to read MCP config (${scope}) at ${error.path}: ${error.message}\n`,
      );
      continue;
    }
    if (scope === "project" && !projectTrusted) {
      if (Object.keys(raw).length > 0) {
        const message = "Project MCP servers ignored: add this project's absolute path to " +
          "the execution host's trusted-projects.json (version 1, projects array).";
        readErrors.push({ scope, path, message });
        process.stderr.write(`[sidecar] ${message}\n`);
      }
      continue;
    }
    for (const [name, value] of Object.entries(raw)) {
      // Only a trusted project may disable a same-named global server.
      if (value && typeof value === "object" && (value as { disabled?: unknown }).disabled === true) {
        delete servers[name];
        const existing = sources.findIndex((s) => s.name === name);
        if (existing >= 0) sources.splice(existing, 1);
        continue;
      }
      const normalized = normalizeEntry(value);
      if (!normalized) continue;
      // Project scope overwrites global on the same name (last write wins);
      // rebuild the summary so a project override is reported at its own scope.
      servers[name] = normalized.entry;
      const existing = sources.findIndex((s) => s.name === name);
      const info: McpSourceInfo = { name, transport: normalized.transport, scope };
      if (existing >= 0) {
        sources[existing] = info;
      } else {
        sources.push(info);
      }
    }
  }

  return { servers, summary: { sources, readErrors } };
}
