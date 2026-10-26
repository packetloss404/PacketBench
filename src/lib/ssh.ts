import { WORKSPACE_CLI_REGISTRY } from "./workspaceCliRegistry.ts";
import type { ServerConfig } from "@/types/server";

/** Shell-escape a string for safe embedding in a remote command. */
function shellEscape(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

/** Ensure common bin dirs are on PATH for non-login SSH shells. */
const PATH_SETUP =
  'export PATH="$HOME/.local/bin:$HOME/.npm-global/bin:$HOME/.cargo/bin:$HOME/.opencode/bin:$HOME/.nvm/versions/node/$(ls $HOME/.nvm/versions/node/ 2>/dev/null | tail -1)/bin:/usr/local/bin:$PATH" 2>/dev/null;';

/** Common SSH flags shared across all connection types.
 *
 *  Host-key verification mode is decided here:
 *  - If `server.hostFingerprint` is set AND `knownHostsPath` was provided
 *    by the caller, pin against the app-managed `known_hosts` file with
 *    `StrictHostKeyChecking=yes`.
 *  - Otherwise fall back to TOFU `accept-new` (legacy entries / first
 *    connect) with a console warning so the user can re-save to pin. */
function baseSshArgs(
  server: ServerConfig,
  knownHostsPath: string | undefined,
  { allocatePty = true } = {},
): string[] {
  const args: string[] = ["-o", "ConnectTimeout=10"];

  if (server.hostFingerprint && knownHostsPath) {
    args.push("-o", "StrictHostKeyChecking=yes");
    args.push("-o", `UserKnownHostsFile=${knownHostsPath}`);
  } else {
    if (!server.hostFingerprint) {
      console.warn(
        `[ssh] Server "${server.name}" has no pinned host fingerprint — using accept-new (TOFU). Re-save the server to pin the key.`,
      );
    } else if (!knownHostsPath) {
      console.warn(
        "[ssh] knownHostsPath unavailable — falling back to accept-new. Bootstrap may not have fetched get_app_known_hosts_path yet.",
      );
    }
    args.push("-o", "StrictHostKeyChecking=accept-new");
  }

  // Only request pseudo-terminal when running through a PTY.
  // Password auth uses a direct process (no PTY), so -t would warn.
  if (allocatePty) {
    args.push("-t");
  }

  if (server.port !== 22) {
    args.push("-p", String(server.port));
  }

  if (server.authMethod === "key" && server.keyPath) {
    args.push("-i", server.keyPath);
    args.push("-o", "PreferredAuthentications=publickey");
  } else if (server.authMethod === "agent") {
    args.push("-o", "PreferredAuthentications=publickey");
  } else if (server.authMethod === "password") {
    args.push("-o", "PreferredAuthentications=keyboard-interactive,password");
    args.push("-o", "PubkeyAuthentication=no");
  }

  return args;
}

/** Build SSH command-line args for spawning a remote CLI session via PTY.
 *
 *  `knownHostsPath` is the absolute path returned by the Rust
 *  `get_app_known_hosts_path` command. When provided alongside a
 *  `server.hostFingerprint`, SSH uses strict host-key checking against
 *  that file. Callers are expected to fetch this once at startup and
 *  cache it (see `serverStore.knownHostsPath`). */
export function buildSshArgs(
  server: ServerConfig,
  remotePath: string,
  remoteCommand: string | null,
  remoteArgs?: string[],
  knownHostsPath?: string,
  remoteEnv?: Record<string, string>,
): string[] {
  const args = baseSshArgs(server, knownHostsPath);
  args.push(`${server.username}@${server.host}`);

  // Build the remote command string with PATH augmentation. Each component is
  // shell-escaped so paths or args containing spaces, quotes, or shell
  // metacharacters can't break out of the remote `sh -c` shell that SSH
  // wraps the command in.
  const cmdParts = remoteCommand
    ? [shellEscape(remoteCommand), ...(remoteArgs ?? []).map(shellEscape)].join(" ")
    : 'exec "${SHELL:-/bin/sh}" -l';
  const envSetup = Object.entries(remoteEnv ?? {})
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, value]) => {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
        throw new Error(`Invalid remote environment variable name: ${name}`);
      }
      return `export ${name}=${shellEscape(value)};`;
    })
    .join(" ");
  const remoteCmd = remotePath
    ? `${PATH_SETUP} ${envSetup} cd ${shellEscape(remotePath)} && ${cmdParts}`
    : `${PATH_SETUP} ${envSetup} ${cmdParts}`;
  args.push(remoteCmd);

  return args;
}

/** Build SSH args for running a one-shot command (detection, install). */
export function buildSshExecArgs(
  server: ServerConfig,
  remoteCommand: string,
  knownHostsPath?: string,
): string[] {
  // Password auth runs via direct process (no PTY), so skip -t to avoid warning
  const allocatePty = server.authMethod !== "password";
  const args = baseSshArgs(server, knownHostsPath, { allocatePty });
  args.push(`${server.username}@${server.host}`);
  args.push(remoteCommand);

  return args;
}

/** Install commands for each agent CLI on a remote server. */
export const REMOTE_INSTALL_COMMANDS: Record<string, string> = Object.fromEntries(
  WORKSPACE_CLI_REGISTRY.filter((p) => p.installCommand).map((p) => [p.id, p.installCommand!]),
);
REMOTE_INSTALL_COMMANDS.packetcode = 'curl -fsSL https://raw.githubusercontent.com/packetloss404/packetcode/main/install.sh | INSTALL_DIR="$HOME/.local/bin" bash';

export const AGENT_CLI_NAMES: Record<string, string> = Object.fromEntries(
  WORKSPACE_CLI_REGISTRY.map((p) => [p.id, p.binary]),
);
