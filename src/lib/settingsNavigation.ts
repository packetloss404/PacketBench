import { APP_NAME } from "@/lib/brand";

import type {
  SettingsGroup,
  SettingsScope,
  SettingsSection,
  SettingsTarget,
} from "@/types/settings";

export interface SettingsSectionDefinition {
  key: SettingsSection;
  label: string;
  description: string;
  scopes: SettingsScope[];
  keywords: string[];
}

export interface SettingsGroupDefinition {
  key: SettingsGroup;
  label: string;
  description: string;
  sections: SettingsSectionDefinition[];
}

export const SETTINGS_GROUPS: SettingsGroupDefinition[] = [
  {
    key: "general",
    label: "General",
    description: "App-wide appearance, notifications, and keyboard behavior.",
    sections: [
      {
        key: "general",
        label: "Preferences",
        description: "Theme, notifications, and global keyboard shortcuts.",
        scopes: ["App"],
        keywords: [
          "appearance",
          "theme",
          "dark",
          "light",
          "notifications",
          "keyboard",
          "shortcuts",
        ],
      },
      {
        key: "time",
        label: "Date & Time",
        description: "The time zone dates and times are displayed in.",
        scopes: ["App"],
        keywords: [
          "time",
          "date",
          "timezone",
          "time zone",
          "tz",
          "utc",
          "clock",
          "locale",
          "daylight saving",
          "dst",
        ],
      },
    ],
  },
  {
    key: "workspaces-terminal",
    label: "Workspaces & Terminal",
    description: "Project workrooms, CLI clients, remote hosts, and project rules.",
    sections: [
      {
        key: "workspace",
        label: "Workspace defaults",
        description: "Active project identity and defaults for new Workspace layouts.",
        scopes: ["App", "Workspace"],
        keywords: [
          "project",
          "layout",
          "template",
          "terminal",
          "shell",
          "powershell",
          "cmd",
          "bash",
          "git bash",
          "wsl",
          "path",
          "restore",
          // The bypass default and the GitHub auto-bind toggle live on this
          // section's WorkspaceSettingsCard but were unsearchable.
          "bypass",
          "permission prompts",
          "auto-detect repo",
        ],
      },
      {
        key: "cli-clients",
        label: "CLI Clients",
        description: "Detect, configure, and repair PacketCode and other coding CLIs.",
        scopes: ["App", "New sessions"],
        keywords: ["packetcode", "claude", "codex", "opencode", "shell", "binary"],
      },
      {
        key: "cli-accounts",
        label: "CLI Accounts",
        description: "Named logins for Claude Code and Codex, each with its own config directory.",
        scopes: ["App", "New sessions"],
        keywords: [
          "account",
          "accounts",
          "login",
          "multi account",
          "claude",
          "codex",
          "config dir",
          "claude_config_dir",
          "codex_home",
          "subscription",
          "switch",
        ],
      },
      {
        key: "servers",
        label: "Remote Hosts",
        description: "SSH hosts, authentication methods, paths, and host-key trust.",
        scopes: ["App", "Workspace"],
        keywords: ["ssh", "servers", "remote", "password", "key", "host", "fingerprint"],
      },
      {
        key: "project-rules",
        label: "Project Rules",
        description: "Instructions and operational rules for the active project.",
        scopes: ["Project"],
        keywords: ["agents md", "claude md", "instructions", "rules", "project"],
      },
    ],
  },
  {
    key: "agents-models",
    label: "Agents & Models",
    description: "GUI-agent behavior, profiles, provider accounts, endpoints, and models.",
    sections: [
      {
        key: "agents",
        label: "Agent behavior",
        description: "Conversation defaults, profiles, cleanup, failover, and onboarding.",
        scopes: ["App", "New conversations"],
        keywords: [
          "profile",
          "worktree",
          "archive",
          "failover",
          "conversation",
          "tools",
          // `rail` was dropped: the "Start right rail collapsed" control was
          // retired (see PlaceboSettingsControls.test.tsx) and searching for
          // it landed on a section that no longer offers it.
          "transcript",
          "density",
          "verbose",
          "summary",
          "cleanup",
          "onboarding",
        ],
      },
      {
        key: "providers",
        label: "Providers & Models",
        description: "API credentials, subscription accounts, endpoints, and available models.",
        scopes: ["App", "New conversations"],
        keywords: [
          "api keys",
          "anthropic",
          "openai",
          "minimax",
          "openrouter",
          "sugar", "clinepass", "opencode go", "ollama cloud", "google", "gemini", "xai", "grok",
          "ollama",
          "models",
          // The keyless rows are configured here too.
          "endpoint",
        ],
      },
    ],
  },
  {
    key: "automation",
    label: "Automation",
    description: "Flight policy, task-role defaults, and durable PacketAgent handoffs.",
    sections: [
      {
        key: "flights",
        label: "Flights & Autonomy",
        description:
          "Commit attribution, bounded autonomy defaults, and spend guardrails for new Flights.",
        scopes: ["New Flights"],
        keywords: [
          "flight",
          "yolo",
          "autonomy",
          "commit",
          "trailer",
          "policy",
          "approval",
          "budget",
          "cost",
          "spend",
          "guardrail",
          "limit",
          "cap",
        ],
      },
      {
        key: "routing",
        label: "Task Role Defaults",
        description:
          `Desired agent assignments by task role, and the provider for ${APP_NAME}'s own auxiliary AI tasks.`,
        scopes: ["App", "New conversations", "New Flights"],
        keywords: [
          "routing",
          "task",
          "role",
          "review",
          "research",
          "debug",
          "agent",
          // The auxiliary-task half of this card was entirely unsearchable.
          "auxiliary",
          "aux",
          "spec import",
          "pr description",
          "triage",
          "side chat",
          "cheapest",
        ],
      },
      {
        key: "packet-agent",
        label: "PacketAgent",
        description: "Endpoint, identity, and credentials for always-on worker handoffs.",
        scopes: ["App", "New Flights"],
        keywords: ["worker", "remote", "endpoint", "token", "handoff", "durable"],
      },
    ],
  },
  {
    key: "integrations-data",
    label: "Integrations & Data",
    description: "Git hosts, MCP, issues, Memory, dictation, and first-party modules.",
    sections: [
      {
        key: "github",
        label: "Git Hosts",
        // GitLab is a first-class host kind, so it belongs in both the blurb
        // and the keywords: Settings search is keyword-matched, and a user
        // typing "gitlab" was getting no result for a section that connects it.
        description: "GitHub, GitLab, and self-hosted Gitea or Forgejo connections.",
        scopes: ["App", "Workspace"],
        keywords: [
          "github",
          "gitlab",
          "gitea",
          "forgejo",
          "git",
          "pull request",
          "merge request",
          "token",
        ],
      },
      {
        key: "mcp",
        label: "MCP",
        description: `MCP clients, the ${APP_NAME} provider, trust, and diagnostics.`,
        scopes: ["App", "Project", "New conversations"],
        keywords: ["model context protocol", "server", "provider", "tools", "trust", "catalog"],
      },
      {
        key: "issues",
        label: "Issues",
        description: "Ticket identifiers, epics, labels, and issue organization.",
        // FAULT: badged "Project". The ticket prefix, epics, and labels are
        // held in one global slice — `issueStore` writes them to a single
        // localStorage key and `storage.rs::save_issues` to one state file,
        // neither keyed by project path — so switching projects does not
        // switch any of them.
        scopes: ["App"],
        keywords: ["ticket", "prefix", "epic", "label", "taxonomy"],
      },
      {
        key: "memory",
        label: "Memory",
        description: "Project memory behavior, retention, and data access.",
        scopes: ["Project", "New conversations"],
        keywords: ["context", "patterns", "retention", "privacy", "capture"],
      },
      {
        key: "dictation",
        label: "Dictation",
        description: "Speech capture, transcription, and input devices.",
        scopes: ["App"],
        keywords: ["voice", "microphone", "speech", "shortcut", "push to talk"],
      },
      {
        key: "modules",
        label: "Modules",
        description: `Enable and configure first-party ${APP_NAME} modules.`,
        scopes: ["App"],
        keywords: ["quality", "dictation", "integration", "extension"],
      },
    ],
  },
  {
    key: "security-diagnostics",
    label: "Security & Diagnostics",
    description: "Trust posture, release state, crash reports, history, and diagnostics.",
    sections: [
      {
        key: "advanced",
        label: "Trust & Diagnostics",
        description: "Runtime evidence, trust, crashes, release status, history, and prompts.",
        scopes: ["App"],
        keywords: ["security", "trust", "provenance", "crash", "history", "release", "prompt"],
      },
    ],
  },
];

const sections = SETTINGS_GROUPS.flatMap((group) =>
  group.sections.map((section) => ({ group, section })),
);

export function settingsGroupForSection(section: SettingsSection): SettingsGroupDefinition {
  return (
    sections.find((candidate) => candidate.section.key === section)?.group ?? SETTINGS_GROUPS[0]
  );
}

export function settingsDefinitionForSection(section: SettingsSection): SettingsSectionDefinition {
  return (
    sections.find((candidate) => candidate.section.key === section)?.section ??
    SETTINGS_GROUPS[0].sections[0]
  );
}

export function normalizeSettingsTarget(target: SettingsTarget | null): SettingsSection {
  if (!target) return "general";
  if (target.section === "agents" && target.cliId) return "cli-clients";
  return target.section;
}

export function searchSettings(query: string): Array<{
  group: SettingsGroupDefinition;
  section: SettingsSectionDefinition;
}> {
  const normalized = query.trim().toLocaleLowerCase();
  if (!normalized) return [];
  return sections.filter(({ group, section }) =>
    [group.label, group.description, section.label, section.description, ...section.keywords]
      .join(" ")
      .toLocaleLowerCase()
      .includes(normalized),
  );
}
