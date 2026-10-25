import { WORKSPACE_CLI_REGISTRY } from "./workspaceCliRegistry";
/**
 * Install hint URLs for the supported AI CLIs.
 *
 * Kept in a static map (not on AgentConfig) to avoid churning the persisted
 * agent schema for purely UI-side data.
 */

export interface InstallHint {
  label: string;
  url: string;
}

export const INSTALL_HINTS: Record<string, InstallHint> = Object.fromEntries(
  WORKSPACE_CLI_REGISTRY.map((preset) => [preset.id, { label: `Install ${preset.name}`, url: preset.docsUrl }]),
);
