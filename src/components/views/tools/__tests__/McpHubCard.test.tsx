import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { McpHubCard } from "../McpHubCard";
import { useLayoutStore } from "@/stores/layoutStore";
import { useMcpStore } from "@/stores/mcpStore";
import { useMcpTrustStore } from "@/stores/mcpTrustStore";
import { useProvenanceAuditStore } from "@/stores/provenanceAuditStore";
import { diagnoseMcpServer } from "@/lib/tauri";

const agentState = vi.hoisted(() => ({
  selectedConversationId: null as string | null,
  conversations: [] as { id: string; title: string; mode: "api" }[],
  prepareMcpReconnect: vi.fn(),
}));

vi.mock("../McpServersCard", () => ({
  McpServersCard: () => <div>Configured servers editor</div>,
}));
vi.mock("../McpProviderCard", () => ({
  McpProviderCard: () => <div>PacketBench provider controls</div>,
}));
vi.mock("@/stores/agentTaskStore", () => ({
  useAgentTaskStore: (selector: (state: typeof agentState) => unknown) => selector(agentState),
}));
vi.mock("@/lib/tauri", () => ({
  diagnoseMcpServer: vi.fn(),
  readMcpServers: vi.fn(),
  writeMcpServer: vi.fn(),
  deleteMcpServer: vi.fn(),
}));

describe("McpHubCard", () => {
  beforeEach(() => {
    agentState.selectedConversationId = null;
    agentState.conversations = [];
    agentState.prepareMcpReconnect.mockReset().mockResolvedValue(undefined);
    localStorage.clear();
    useLayoutStore.setState({ projectPath: "D:\\projects\\demo" });
    useMcpTrustStore.setState({ profiles: {}, capabilities: {} });
    useProvenanceAuditStore.setState({ entries: [] });
    useMcpStore.setState({
      servers: [
        {
          name: "demo",
          scope: "project",
          disabled: false,
          config: { command: "node", args: ["server.js"] },
          rawConfig: { command: "node", args: ["server.js"] },
        },
      ],
      loading: false,
      error: null,
      fetchServers: vi.fn().mockResolvedValue(undefined),
      addServer: vi.fn().mockResolvedValue(undefined),
      updateServer: vi.fn().mockResolvedValue(undefined),
      removeServer: vi.fn().mockResolvedValue(undefined),
    });
  });

  it("explicitly reconnects the selected API conversation without MCP when no servers exist", async () => {
    agentState.selectedConversationId = "ssh-existing";
    agentState.conversations = [{ id: "ssh-existing", title: "SSH existing", mode: "api" }];
    useMcpStore.setState({ servers: [] });
    render(<McpHubCard />);
    fireEvent.click(screen.getByRole("button", { name: "Reconnect without MCP" }));
    await waitFor(() =>
      expect(agentState.prepareMcpReconnect).toHaveBeenCalledWith("ssh-existing", []),
    );
    expect(
      await screen.findByText(/next user turn will reconnect without MCP servers/),
    ).toBeInTheDocument();
  });

  it("retains the current server selection for ordinary reconnect", async () => {
    agentState.selectedConversationId = "existing";
    agentState.conversations = [{ id: "existing", title: "Existing", mode: "api" }];
    render(<McpHubCard />);
    fireEvent.click(screen.getByRole("button", { name: "Reconnect selected" }));
    await waitFor(() => expect(agentState.prepareMcpReconnect).toHaveBeenCalledWith("existing"));
  });

  it("searches the catalog and requires a review before writing config", async () => {
    render(<McpHubCard />);

    expect(screen.getByText("Filesystem")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Search MCP Hub"), {
      target: { value: "github" },
    });
    expect(screen.queryByText("Filesystem")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Review" }));

    expect(screen.getByText("Review GitHub")).toBeInTheDocument();
    expect(screen.getByText(/GITHUB_PERSONAL_ACCESS_TOKEN.*never stored/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Approve and add" }));

    await waitFor(() => expect(useMcpStore.getState().addServer).toHaveBeenCalledTimes(1));
  });

  it("discloses frozen trust and non-overridable denial floors", () => {
    render(<McpHubCard />);
    expect(screen.getByText(/Trust edits never broaden a running session/i)).toBeInTheDocument();
    expect(
      screen.getByText(/Credential, outside-workspace, and protected publish/i),
    ).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: "Write" })).not.toBeChecked();
  });

  it("reports an unprobed remote server as 'not probed', never as degraded", async () => {
    // FAULT: an http/sse server used to be reported `degraded` without a byte
    // being sent to it. `degraded` reads as "measured and unhealthy", so every
    // healthy remote server looked broken — which trains users to ignore the
    // indicator, including when it means something.
    vi.mocked(diagnoseMcpServer).mockResolvedValue({
      state: "notProbed",
      transport: "http",
      tools: [],
      message: "Not probed — the local doctor speaks stdio only.",
      compatibilityVersion: "2024-11-05",
      checkedAt: 1,
    });

    render(<McpHubCard />);
    fireEvent.click(screen.getByRole("button", { name: /Diagnose/ }));

    expect(await screen.findByText("not probed")).toBeInTheDocument();
    expect(screen.queryByText("degraded")).not.toBeInTheDocument();
    // No latency suffix: nothing was timed, and a number would imply it was.
    expect(screen.queryByText(/ms/)).not.toBeInTheDocument();
  });

  it("still shows a real measured failure as failed", async () => {
    // The honest states must stay distinguishable from the new one, otherwise
    // the fix would just move the ambiguity.
    vi.mocked(diagnoseMcpServer).mockResolvedValue({
      state: "failed",
      transport: "stdio",
      latencyMs: 12,
      tools: [],
      message: "No such file or directory",
      compatibilityVersion: "2024-11-05",
      checkedAt: 1,
    });

    render(<McpHubCard />);
    fireEvent.click(screen.getByRole("button", { name: /Diagnose/ }));

    expect(await screen.findByText(/^failed/)).toBeInTheDocument();
    expect(screen.queryByText("not probed")).not.toBeInTheDocument();
  });
});
