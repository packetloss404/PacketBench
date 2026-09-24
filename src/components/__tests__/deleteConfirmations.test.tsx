/**
 * Destructive actions must ask first, and must ask in ONE voice.
 *
 * The creation/deletion review found five competing confirm idioms across ~30
 * delete affordances — the most common being no confirmation at all, plus
 * `window.confirm` in seven files. Everything swept here now goes through
 * `ConfirmDeleteModal`. Each case pins the same three properties:
 *
 *   1. the destructive click alone mutates nothing — it opens a confirm;
 *   2. cancelling leaves state untouched;
 *   3. only the explicit confirm button performs the destruction.
 *
 * The source-level guard that keeps `window.confirm` from coming back lives in
 * `scripts/confirm-idiom.test.mjs` (it needs node:fs, which the app tsconfig
 * does not carry).
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn().mockResolvedValue(() => {}) }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn().mockResolvedValue(undefined) }));

const tauriMocks = vi.hoisted(() => ({
  deleteApiKey: vi.fn().mockResolvedValue(undefined),
  getApiKeyExists: vi.fn().mockResolvedValue(true),
  setApiKey: vi.fn().mockResolvedValue(undefined),
  listCrashes: vi.fn().mockResolvedValue([{ path: "/logs/crash-1.log", summary: "boom", timestamp: "0" }]),
  readCrash: vi.fn().mockResolvedValue("stack"),
  deleteCrash: vi.fn().mockResolvedValue(undefined),
  getPacketAgentTokenExists: vi.fn().mockResolvedValue(true),
  deletePacketAgentToken: vi.fn().mockResolvedValue(undefined),
  setPacketAgentToken: vi.fn().mockResolvedValue(undefined),
  githubOauthConfigured: vi.fn().mockResolvedValue(false),
  detectCliCatalog: vi.fn().mockResolvedValue([]),
}));

vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn().mockResolvedValue(null) }));

vi.mock("@/lib/tauri", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/tauri")>()),
  ...tauriMocks,
}));

import { ApiKeysCard } from "@/components/views/tools/ApiKeysCard";
import { CrashViewerCard } from "@/components/views/tools/CrashViewerCard";
import { TrustProvenanceCard } from "@/components/views/tools/TrustProvenanceCard";
import { AgentProfilesCard } from "@/components/views/tools/AgentProfilesCard";
import { McpServersCard } from "@/components/views/tools/McpServersCard";
import { WorkspaceAgentsDogfoodCard } from "@/components/views/tools/WorkspaceAgentsDogfoodCard";
import { PromptLibrary } from "@/components/workspace/PromptLibrary";
import { CodeQualityHistoryDropdown } from "@/components/quality/CodeQualityHistoryDropdown";
import { PacketAgentSettingsCard } from "@/components/views/tools/PacketAgentSettingsCard";
import { GitHubSettingsCard } from "@/components/views/tools/GitHubSettingsCard";
import { useGitHubStore } from "@/stores/githubStore";
import { CliAgentsCard } from "@/components/views/tools/CliAgentsCard";
import { useAgentStore } from "@/stores/agentStore";
import { useProvenanceAuditStore } from "@/stores/provenanceAuditStore";
import { useProfileStore } from "@/stores/profileStore";
import { usePromptStore } from "@/stores/promptStore";
import { useMcpStore } from "@/stores/mcpStore";
import { useWorkspaceAgentsDogfoodStore } from "@/stores/workspaceAgentsDogfoodStore";
import type { AgentProfile } from "@/types/profiles";
import type { CodeQualityHistoryEntry } from "@/components/quality/codeQualityHistory";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("ApiKeysCard — deleting a stored API key", () => {
  it("requires the confirm; cancel leaves the keyring alone", async () => {
    render(<ApiKeysCard />);
    const trash = await screen.findByRole("button", { name: "Delete Anthropic API key" });

    fireEvent.click(trash);
    expect(tauriMocks.deleteApiKey).not.toHaveBeenCalled();
    expect(screen.getByRole("heading", { name: "Delete API key?" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(tauriMocks.deleteApiKey).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Delete Anthropic API key" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(tauriMocks.deleteApiKey).toHaveBeenCalledWith("anthropic"));
  });
});

describe("CrashViewerCard — deleting a crash report", () => {
  it("requires the confirm; cancel leaves the file on disk", async () => {
    render(<CrashViewerCard />);
    const trash = await screen.findByRole("button", {
      name: "Delete crash report /logs/crash-1.log",
    });

    fireEvent.click(trash);
    expect(tauriMocks.deleteCrash).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(tauriMocks.deleteCrash).not.toHaveBeenCalled();

    fireEvent.click(trash);
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(tauriMocks.deleteCrash).toHaveBeenCalledWith("/logs/crash-1.log"));
  });
});

describe("TrustProvenanceCard — clearing the whole trust audit", () => {
  it("requires the confirm; cancel keeps every entry", () => {
    useProvenanceAuditStore.setState({
      entries: [
        {
          id: "e1",
          timestamp: 1,
          sourceKind: "mcp",
          sourceLabel: "srv",
          sourceChain: [],
          decision: "allowed",
        } as never,
      ],
    });

    render(<TrustProvenanceCard />);
    fireEvent.click(screen.getByRole("button", { name: "Clear local trust audit" }));
    expect(useProvenanceAuditStore.getState().entries).toHaveLength(1);

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(useProvenanceAuditStore.getState().entries).toHaveLength(1);

    fireEvent.click(screen.getByRole("button", { name: "Clear local trust audit" }));
    fireEvent.click(screen.getByRole("button", { name: "Clear audit" }));
    expect(useProvenanceAuditStore.getState().entries).toHaveLength(0);
  });
});

describe("AgentProfilesCard — deleting a custom profile", () => {
  function customProfile(): AgentProfile {
    return {
      id: "p-custom",
      name: "Scout Plus",
      description: "d",
      systemPrompt: "s",
      allowedTools: null,
      memoryContextEnabled: false,
      permissionMode: "auto",
      planMode: false,
      isBuiltin: false,
      createdAt: 0,
      updatedAt: 0,
    };
  }

  it("requires the confirm; cancel keeps the profile", () => {
    const builtins = useProfileStore.getState().profiles.filter((p) => p.isBuiltin);
    useProfileStore.setState({ profiles: [...builtins, customProfile()] });
    const before = useProfileStore.getState().profiles.length;

    render(<AgentProfilesCard />);
    fireEvent.click(screen.getByRole("button", { name: "Delete profile Scout Plus" }));
    expect(useProfileStore.getState().profiles).toHaveLength(before);
    expect(screen.getByRole("heading", { name: "Delete profile?" })).toBeInTheDocument();
    // Named in the confirm body, not just in the row behind it.
    expect(screen.getAllByText(/Scout Plus/).length).toBeGreaterThan(1);

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(useProfileStore.getState().profiles).toHaveLength(before);

    fireEvent.click(screen.getByRole("button", { name: "Delete profile Scout Plus" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    expect(useProfileStore.getState().profiles).toHaveLength(before - 1);
  });
});

describe("McpServersCard — deleting an MCP server", () => {
  it("replaces the no-cancel Confirm swap with a real confirm", async () => {
    const removeServer = vi.fn().mockResolvedValue(undefined);
    useMcpStore.setState({
      servers: [
        { name: "filesystem", config: { command: "npx" }, scope: "global", disabled: false },
      ],
      loading: false,
      error: null,
      fetchServers: vi.fn().mockResolvedValue(undefined),
      removeServer,
    });

    render(<McpServersCard />);
    fireEvent.click(screen.getByRole("button", { name: "Delete filesystem" }));
    expect(removeServer).not.toHaveBeenCalled();
    expect(screen.getByRole("heading", { name: "Delete MCP server?" })).toBeInTheDocument();

    // The old idiom had no way back out. This one does.
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(removeServer).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Delete filesystem" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(removeServer).toHaveBeenCalledWith("filesystem", "global"));
  });
});

describe("PromptLibrary — deleting a saved template", () => {
  it("requires the confirm; cancel keeps the template", () => {
    usePromptStore.setState({
      templates: [
        { id: "t1", name: "Review diff", content: "c", category: "review", createdAt: 0 } as never,
      ],
    });

    render(<PromptLibrary onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Delete template Review diff" }));
    expect(usePromptStore.getState().templates).toHaveLength(1);

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(usePromptStore.getState().templates).toHaveLength(1);

    fireEvent.click(screen.getByRole("button", { name: "Delete template Review diff" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    expect(usePromptStore.getState().templates).toHaveLength(0);
  });
});

describe("WorkspaceAgentsDogfoodCard — resetting local evidence", () => {
  it("requires the confirm; cancel keeps the counters", () => {
    const reset = vi.fn();
    useWorkspaceAgentsDogfoodStore.setState({ reset });

    render(<WorkspaceAgentsDogfoodCard />);
    fireEvent.click(screen.getByRole("button", { name: "Reset" }));
    expect(reset).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(reset).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Reset" }));
    fireEvent.click(screen.getByRole("button", { name: "Reset counters" }));
    expect(reset).toHaveBeenCalledTimes(1);
  });
});

describe("CodeQualityHistoryDropdown — clearing run history", () => {
  it("requires the confirm; cancel keeps the history", () => {
    const onClear = vi.fn();
    const entries = [
      { ranAt: 2, totalScore: 80 },
      { ranAt: 1, totalScore: 70 },
    ] as CodeQualityHistoryEntry[];

    render(
      <CodeQualityHistoryDropdown
        entries={entries}
        selectedIndex={0}
        onSelect={vi.fn()}
        onClear={onClear}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /2 runs/ }));
    fireEvent.click(screen.getByRole("button", { name: "Clear run history" }));
    expect(onClear).not.toHaveBeenCalled();
    expect(screen.getByRole("heading", { name: "Clear run history?" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onClear).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: /2 runs/ }));
    fireEvent.click(screen.getByRole("button", { name: "Clear run history" }));
    fireEvent.click(screen.getByRole("button", { name: "Clear history" }));
    expect(onClear).toHaveBeenCalledTimes(1);
  });
});

describe("PacketAgentSettingsCard — removing the stored token", () => {
  it("requires the confirm; cancel leaves the credential store alone", async () => {
    render(<PacketAgentSettingsCard />);
    const trash = await screen.findByTitle("Remove stored token");

    fireEvent.click(trash);
    expect(tauriMocks.deletePacketAgentToken).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(tauriMocks.deletePacketAgentToken).not.toHaveBeenCalled();

    fireEvent.click(trash);
    fireEvent.click(screen.getByRole("button", { name: "Remove token" }));
    await waitFor(() => expect(tauriMocks.deletePacketAgentToken).toHaveBeenCalled());
  });
});

describe("GitHubSettingsCard — removing a self-hosted git host", () => {
  it("requires the confirm; cancel keeps the connection", () => {
    const removeGitHostConnection = vi.fn().mockResolvedValue(undefined);
    useGitHubStore.setState({
      connections: [
        { id: "gh-1", kind: "gitea", baseUrl: "https://git.example.com", label: "Forge", hasToken: true },
      ],
      loadConnections: vi.fn().mockResolvedValue(undefined),
      removeGitHostConnection,
    });

    render(<GitHubSettingsCard />);
    fireEvent.click(screen.getByRole("button", { name: "Remove Forge" }));
    expect(removeGitHostConnection).not.toHaveBeenCalled();
    expect(screen.getByRole("heading", { name: "Remove git host?" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(removeGitHostConnection).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Remove Forge" }));
    fireEvent.click(screen.getByRole("button", { name: "Remove host" }));
    expect(removeGitHostConnection).toHaveBeenCalledWith("gh-1");
  });
});

describe("CliAgentsCard — deleting a saved legacy CLI entry and resetting built-ins", () => {
  it("requires a confirm for both, and cancel mutates nothing", () => {
    const builtins = useAgentStore.getState().agents.filter((a) => a.isBuiltin);
    useAgentStore.setState({
      agents: [
        ...builtins,
        {
          id: "custom-mycli",
          name: "MyCLI",
          command: "mycli",
          defaultArgs: [],
          description: "d",
          isBuiltin: false,
        } as never,
      ],
    });
    const before = useAgentStore.getState().agents.length;

    render(<CliAgentsCard />);
    fireEvent.click(screen.getByRole("button", { name: /Advanced — saved CLI settings/ }));
    expect(screen.getByText(/Custom CLI launching is not supported/)).toBeInTheDocument();
    expect(screen.getByText("MyCLI")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Custom$/ })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Delete custom CLI agent MyCLI" }));
    expect(useAgentStore.getState().agents).toHaveLength(before);
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(useAgentStore.getState().agents).toHaveLength(before);

    fireEvent.click(screen.getByRole("button", { name: "Delete custom CLI agent MyCLI" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    expect(useAgentStore.getState().agents).toHaveLength(before - 1);

    // "Reset built-ins" is destructive to command overrides — it asks too.
    const resetBuiltins = vi.fn();
    useAgentStore.setState({ resetBuiltins });
    fireEvent.click(screen.getByRole("button", { name: /Reset built-ins/ }));
    expect(resetBuiltins).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(resetBuiltins).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: /Reset built-ins/ }));
    fireEvent.click(screen.getByRole("button", { name: "Reset to defaults" }));
    expect(resetBuiltins).toHaveBeenCalledTimes(1);
    // Renders the whole CliAgentsCard twice and drives two confirm dialogs;
    // ~1.8s alone, but exceeds the 5s default under full-suite parallel load.
  }, 20000);
});
