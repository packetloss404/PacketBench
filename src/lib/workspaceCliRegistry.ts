import registry from "./workspace-cli-registry.json" with { type: "json" };
import type { WorkspaceAgentSlot } from "@/types/workspace";
import type { CliBrandColor } from "./cli-catalog";

export type CliPlatform = "windows" | "macos" | "linux";
export type PresetCliId = Exclude<WorkspaceAgentSlot, "terminal" | "custom-cli">;

export interface WorkspaceCliPreset {
  id: PresetCliId;
  name: string;
  binary: string;
  defaultArgs: string[];
  iconName: string;
  color: CliBrandColor;
  description: string;
  platforms: CliPlatform[];
  platformNotes: string;
  installCommand?: string;
  installCommandWindows?: string;
  docsUrl: string;
  verifiedAt: string;
  discovery?: ("npmGlobal" | "localBin" | "grokBin")[];
  windowsRuntime?: "wsl";
  versionArgument?: string;
}

/** Also embedded by Rust: detection, pickers, SSH and PTY admission share it. */
export const WORKSPACE_CLI_REGISTRY = registry as WorkspaceCliPreset[];

export function getWorkspaceCli(id: string): WorkspaceCliPreset | undefined {
  return WORKSPACE_CLI_REGISTRY.find((preset) => preset.id === id);
}

export function cliPlatform(): CliPlatform {
  const platform = typeof navigator === "undefined" ? "" : navigator.userAgent;
  return /Windows/i.test(platform) ? "windows" : /Mac/i.test(platform) ? "macos" : "linux";
}

export function supportsLocalCli(id: string, platform = cliPlatform()): boolean {
  const preset = getWorkspaceCli(id);
  return !preset || preset.platforms.includes(platform) || usesWslCli(id, platform);
}

export function usesWslCli(id: string, platform = cliPlatform()): boolean {
  return platform === "windows" && getWorkspaceCli(id)?.windowsRuntime === "wsl";
}
