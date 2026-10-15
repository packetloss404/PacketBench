import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn().mockResolvedValue(() => undefined),
}));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn().mockImplementation(async (command: string) => {
    if (command === "mcp_server_status")
      return { running: false, allowWrites: false, servedTools: [] };
    if (command === "mcp_server_recent_activity") return [];
    if (command === "mcp_server_available_tools")
      return [
        { name: "ping", description: "Health check" },
        { name: "get_active_flight", description: "Active flight" },
      ];
    if (command === "get_aux_provider_options")
      return [
        { provider: "anthropic", defaultModel: "haiku", needsApiKey: true, configured: false },
      ];
    if (command === "get_aux_route_resolutions") return [];
    return undefined;
  }),
}));

import { AgentSettingsCard } from "@/components/views/tools/AgentSettingsCard";
import { McpProviderCard } from "@/components/views/tools/McpProviderCard";
import { WorkspaceSettingsCard } from "@/components/views/tools/WorkspaceSettingsCard";
import { ProviderRoutingCard } from "@/components/views/tools/ProviderRoutingCard";
import { useMcpProviderStore } from "@/stores/mcpProviderStore";
import { useWorkspaceStore } from "@/stores/workspaceStore";
import { useAgentSettingsStore } from "@/stores/agentSettingsStore";
import { useRoutingStore } from "@/stores/routingStore";

describe("Settings runtime honesty", () => {
  beforeEach(() => {
    useMcpProviderStore.setState({
      serverStatus: null,
      serverError: null,
      serverBusy: false,
      activity: [],
    });
  });

  it("does not offer the retired Agent right-rail default", () => {
    render(<AgentSettingsCard />);
    expect(screen.queryByText("Start right rail collapsed")).not.toBeInTheDocument();
  });

  it("does not offer an MCP scope the Rust server cannot enforce", () => {
    // `scope` was REMOVED rather than enforced: the provider server reads the
    // single global state file and its resources are inherently global, so
    // there was no "project" reading of it to implement.
    render(<McpProviderCard />);
    expect(screen.queryByText("Scope")).not.toBeInTheDocument();
    // The enforceable read/write boundary remains present.
    expect(screen.getByText("Allow writes")).toBeInTheDocument();
  });

  it("offers the per-tool filter now that the Rust router enforces it", async () => {
    // This control was previously removed BECAUSE it was dead config. It is
    // back because `mcp_server_start` now receives the allowlist and the
    // router disables every tool outside it, at `tools/list` AND `tools/call`.
    render(<McpProviderCard />);
    expect(await screen.findByText(/Available Tools/)).toBeInTheDocument();
    // Rendered from the BACKEND catalogue, not a hardcoded copy — `ping` was
    // never in the old hardcoded list, so seeing it proves the source.
    expect(await screen.findByText("ping")).toBeInTheDocument();
  });

  /**
   * FAULT: the app-wide "default new workspaces to bypass permission prompts"
   * toggle carried no caveat, while the creation modal and the workspace
   * header both said the flag never reaches OpenCode or PacketCode. A default
   * that over-promises is the same lie one step earlier.
   */
  it("does not let the bypass DEFAULT promise more than a launch delivers", () => {
    useWorkspaceStore.setState({ defaultBypassPermissions: true });
    render(<WorkspaceSettingsCard />);
    expect(screen.getByText(/Not applied to OpenCode and PacketCode/)).toBeInTheDocument();
  });

  it("keeps the bypass caveat out of the way while the default is off", () => {
    useWorkspaceStore.setState({ defaultBypassPermissions: false });
    render(<WorkspaceSettingsCard />);
    expect(screen.queryByText(/Not applied to OpenCode and PacketCode/)).not.toBeInTheDocument();
  });

  it("offers working provider/model controls for both project research features", async () => {
    render(<ProviderRoutingCard />);
    expect(await screen.findByLabelText("Insights agent chat provider")).toBeInTheDocument();
    expect(screen.getByLabelText("Issue investigation provider")).toBeInTheDocument();
    expect(screen.queryByText(/still runs the local Claude CLI/)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Open Insights chat" })).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Insights agent chat provider"), { target: { value: "anthropic" } });
    expect(useRoutingStore.getState().resolveForAuxTask("agent-chat").provider).toBe("anthropic");
    fireEvent.change(screen.getByLabelText("Issue investigation provider"), { target: { value: "anthropic" } });
    expect(useRoutingStore.getState().resolveForAuxTask("issue-investigate").provider).toBe("anthropic");
  });

  /**
   * `transcriptViewMode` and `worktreeCleanupPolicy` were persisted global
   * state whose only affordance was a chat-header overflow menu (and, for the
   * cleanup policy, nothing at all). Both now have a control here.
   */
  it("offers a control for every persisted agent preference a user can change", () => {
    useAgentSettingsStore.setState({
      transcriptViewMode: "normal",
      worktreeCleanupPolicy: "only-when-safe",
    });
    render(<AgentSettingsCard />);

    fireEvent.click(screen.getByRole("button", { name: "Verbose" }));
    expect(useAgentSettingsStore.getState().transcriptViewMode).toBe("verbose");

    fireEvent.click(screen.getByRole("button", { name: "Keep" }));
    expect(useAgentSettingsStore.getState().worktreeCleanupPolicy).toBe("never");

    // Both survive a reload — the store is the persistence boundary.
    useAgentSettingsStore.getState().hydrateFromStorage();
    expect(useAgentSettingsStore.getState().transcriptViewMode).toBe("verbose");
    expect(useAgentSettingsStore.getState().worktreeCleanupPolicy).toBe("never");
  });
});
