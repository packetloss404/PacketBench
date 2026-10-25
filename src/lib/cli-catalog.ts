import { WORKSPACE_CLI_REGISTRY } from "./workspaceCliRegistry";
import { APP_NAME } from "@/lib/brand";

/**
 * CLI catalog metadata for PacketBench's Tier 1 CLI detection grid.
 *
 * Pure frontend metadata describing the coding-agent CLIs that PacketBench can
 * detect on the host PATH. The detection backend consumes `getCliBinaries()`
 * to probe for each binary; the UI consumes `CLI_CATALOG` directly to render
 * detection cards (icon, label, color, description).
 *
 * Ordering note: PacketCode is intentionally placed immediately
 * after OpenCode — PacketCode is the sibling terminal TUI to
 * PacketBench and the two are visually paired in the grid.
 */

export type CliBrandColor =
  | "amber"
  | "blue"
  | "green"
  | "purple"
  | "red"
  | "neutral";

export interface CliCatalogEntry {
  /** Stable id used as the detection + state key. */
  id: string;
  /** User-facing name. */
  name: string;
  /** Binary to detect on PATH. */
  binary: string;
  /** lucide-react icon name (string) — the consuming card resolves this. */
  iconName: string;
  /** Brand accent color token slug. */
  color: CliBrandColor;
  /** Short description shown when not installed. */
  description?: string;
  platformNotes?: string;
  /** Stable one-line install command that runs in a workspace PTY pane.
   *  Cross-platform unless noted. Null/undefined = no install button. */
  installCommand?: string;
  /** Windows-specific install command when the POSIX command is not portable. */
  installCommandWindows?: string;
  /** External docs URL for install instructions when there's no scriptable command. */
  installDocsUrl?: string;
  /** True for CLIs we're tracking but don't yet support installing — surfaced
   *  as a "Coming Soon" badge when detection finds nothing. */
  comingSoon?: boolean;
  /** True when the CLI cannot be auto-discovered (in-development or
   *  highly-custom install path) — the card highlights the Browse-for-binary
   *  affordance instead of "not installed" copy. */
  browseRequired?: boolean;
}

const PACKETCODE_INSTALL_PS1 =
  "https://raw.githubusercontent.com/packetloss404/packetcode/main/install.ps1";
const PACKETCODE_INSTALL_SH =
  "https://raw.githubusercontent.com/packetloss404/packetcode/main/install.sh";

export function packetCodeInstallCommand(
  channel: "stable" | "preview",
  windows: boolean,
): string {
  if (windows) {
    const load =
      `$s=[scriptblock]::Create((Invoke-WebRequest '${PACKETCODE_INSTALL_PS1}').Content);`;
    if (channel === "preview") {
      return (
        `powershell -NoProfile -ExecutionPolicy Bypass -Command "` +
        `${load} $v=(Invoke-RestMethod 'https://api.github.com/repos/packetloss404/packetcode/releases?per_page=20' ` +
        `| Where-Object { $_.prerelease -and -not $_.draft } | Select-Object -First 1).tag_name; ` +
        `if (-not $v) { throw 'No PacketCode preview release is available' }; & $s -Version $v"`
      );
    }
    return `powershell -NoProfile -ExecutionPolicy Bypass -Command "${load} & $s"`;
  }
  if (channel === "preview") {
    return (
      `VERSION="$(curl -fsSL 'https://api.github.com/repos/packetloss404/packetcode/releases?per_page=20' ` +
      `| tr -d '\\n' | sed 's/},{/}\\n{/g' | grep -m1 '"prerelease":true' ` +
      `| sed -E 's/.*"tag_name":"([^"]+)".*/\\1/')"; ` +
      `test -n "$VERSION" && curl -fsSL '${PACKETCODE_INSTALL_SH}' | VERSION="$VERSION" bash`
    );
  }
  return `curl -fsSL '${PACKETCODE_INSTALL_SH}' | bash`;
}

export const CLI_CATALOG: CliCatalogEntry[] = [
  ...WORKSPACE_CLI_REGISTRY.map((preset) => ({
    ...preset,
    installDocsUrl: preset.docsUrl,
    ...(preset.id === "packetcode" ? {
      description: `${APP_NAME}'s sibling terminal coding TUI`,
      installCommand: packetCodeInstallCommand("stable", false),
      installCommandWindows: packetCodeInstallCommand("stable", true),
    } : {}),
  })),
  {
    id: "devin",
    name: "Devin for Terminal",
    binary: "devin",
    iconName: "Cpu",
    color: "neutral",
    description: "Cognition's autonomous coding agent",
    comingSoon: true,
  },
  {
    id: "qwen",
    name: "Qwen Code",
    binary: "qwen",
    iconName: "BrainCircuit",
    color: "purple",
    description: "Alibaba's coding CLI",
    installCommand: "npm i -g @qwen-code/qwen-code",
  },
  {
    id: "qoder",
    name: "Qoder CLI",
    binary: "qoder",
    iconName: "Hexagon",
    color: "green",
    description: "Open-source coding CLI",
    installCommand: "npm i -g @qoder/qoder-cli",
  },
  {
    id: "mistral",
    name: "Mistral Vibe CLI",
    binary: "mistral",
    iconName: "Wind",
    color: "amber",
    description: "Mistral's coding CLI",
    comingSoon: true,
  },
  {
    id: "deepseek",
    name: "DeepSeek TUI",
    binary: "deepseek",
    iconName: "Diamond",
    color: "blue",
    description: "DeepSeek's terminal coding TUI",
    comingSoon: true,
  },
];

// === Launch resolution tiers ===

/**
 * Human labels for `core::agent::CliLaunchSource`. Every CLI resolves through
 * one shared ladder in Rust — Settings override, legacy app pin, PATH, the
 * product's documented install directory, then the bare name — and the same
 * ladder is what the PTY spawns. Naming the tier is the point: a user can
 * otherwise see WHICH binary a pane will launch but never WHY.
 *
 * Kept here rather than in a component so the CLI Agents grid, the PacketCode
 * panel, and the Workspace pane header cannot describe the same tier
 * differently.
 */
export const CLI_LAUNCH_SOURCE_LABELS: Record<string, string> = {
  settings: "Settings override",
  legacyPin: `legacy ${APP_NAME} pin`,
  path: "PATH",
  installerLocation: "official installer location",
  bareName: "unresolved — the bare command name",
  wsl: "default WSL distribution",
};

/** Label for a resolution tier, falling back to the raw tag. */
export function cliLaunchSourceLabel(source: string | null | undefined): string {
  if (!source) return "unknown";
  return CLI_LAUNCH_SOURCE_LABELS[source] ?? source;
}

/** Look up a catalog entry by stable id. */
export function getCliCatalogEntry(id: string): CliCatalogEntry | undefined {
  return CLI_CATALOG.find((entry) => entry.id === id);
}

/** Convenience accessor for the backend detector — pairs each id with its binary. */
export function getCliBinaries(): Array<{ id: string; binary: string }> {
  return CLI_CATALOG.map(({ id, binary }) => ({ id, binary }));
}

// === Color → Tailwind token mapping ===

export interface CliBrandClasses {
  /** Background tint for the icon swatch (e.g. "bg-accent-amber/15"). */
  iconBg: string;
  /** Foreground color for the icon (e.g. "text-accent-amber"). */
  iconColor: string;
  /** Solid dot color (e.g. "bg-accent-amber"). */
  dotColor: string;
}

const BRAND_CLASS_MAP: Record<CliBrandColor, CliBrandClasses> = {
  amber: {
    iconBg: "bg-accent-amber/15",
    iconColor: "text-accent-amber",
    dotColor: "bg-accent-amber",
  },
  blue: {
    iconBg: "bg-accent-blue/15",
    iconColor: "text-accent-blue",
    dotColor: "bg-accent-blue",
  },
  green: {
    iconBg: "bg-accent-green/15",
    iconColor: "text-accent-green",
    dotColor: "bg-accent-green",
  },
  purple: {
    iconBg: "bg-accent-purple/15",
    iconColor: "text-accent-purple",
    dotColor: "bg-accent-purple",
  },
  red: {
    iconBg: "bg-accent-red/15",
    iconColor: "text-accent-red",
    dotColor: "bg-accent-red",
  },
  neutral: {
    iconBg: "bg-text-secondary/15",
    iconColor: "text-text-secondary",
    dotColor: "bg-text-secondary",
  },
};

/** Resolve Tailwind classes for a brand color slug. */
export function brandClasses(color: CliBrandColor): CliBrandClasses {
  return BRAND_CLASS_MAP[color];
}
