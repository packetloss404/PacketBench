import type { CustomCliConfig } from "@/types/workspace";

/** Validate persisted/profile input without parsing a shell command line. */
export function normalizeCustomCli(value: unknown): CustomCliConfig | undefined {
  if (!value || typeof value !== "object") return undefined;
  const config = value as Partial<CustomCliConfig>;
  if (
    typeof config.command !== "string" ||
    !config.command.trim() ||
    /[\0\r\n]/.test(config.command)
  )
    return undefined;
  if (typeof config.name !== "string" || !config.name.trim()) return undefined;
  if (
    !Array.isArray(config.args) ||
    config.args.some((arg) => typeof arg !== "string" || arg.includes("\0"))
  )
    return undefined;
  if (!config.env || typeof config.env !== "object" || Array.isArray(config.env)) return undefined;
  if (
    Object.entries(config.env).some(
      ([key, val]) =>
        !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || typeof val !== "string" || val.includes("\0"),
    )
  )
    return undefined;
  if (
    config.workingDirectory != null &&
    (typeof config.workingDirectory !== "string" ||
      /[\0\r\n]/.test(config.workingDirectory) ||
      (config.workingDirectory.trim() !== "" && !/^(\/|[A-Za-z]:[\\/]|\\\\)/.test(config.workingDirectory.trim())))
  )
    return undefined;
  return {
    name: config.name.trim(),
    command: config.command.trim(),
    args: [...config.args],
    env: { ...config.env },
    ...(config.workingDirectory?.trim()
      ? { workingDirectory: config.workingDirectory.trim() }
      : {}),
  };
}
