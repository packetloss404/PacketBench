import { WORKSPACE_CLI_REGISTRY } from "@/lib/workspaceCliRegistry";
import type { AgentConfig } from "@/types/agent";
import { CLAUDE_CODE_CONFIG } from "./claude-code";
import { CODEX_CONFIG } from "./codex";
import { OPENCODE_CONFIG } from "./opencode";
import { PACKETCODE_CONFIG } from "./packetcode";
import { TERMINAL_CONFIG } from "./terminal";

const integrations: Record<string, AgentConfig> = {
  "claude-code": CLAUDE_CODE_CONFIG,
  codex: CODEX_CONFIG,
  opencode: OPENCODE_CONFIG,
  packetcode: PACKETCODE_CONFIG,
};

/** Rich integrations remain optional; every preset can run as a plain PTY. */
export const WORKSPACE_BUILTIN_AGENTS: AgentConfig[] = [
  ...WORKSPACE_CLI_REGISTRY.map(
    (preset): AgentConfig => ({
      ...integrations[preset.id],
      id: preset.id,
      name: preset.name,
      command: preset.binary,
      defaultArgs: [...preset.defaultArgs],
      description: preset.description,
      installed: false,
      capabilities: integrations[preset.id]?.capabilities ?? ["shell"],
      icon: preset.iconName,
      color: preset.color === "neutral" ? "text-text-secondary" : `text-accent-${preset.color}`,
      statusPatterns: integrations[preset.id]?.statusPatterns ?? {
        approval: [],
        thinking: [],
        toolUse: [],
        idle: [],
      },
      isBuiltin: true,
    }),
  ),
  TERMINAL_CONFIG,
];
