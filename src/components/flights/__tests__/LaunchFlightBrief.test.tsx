import { useEffect } from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/tauri", async (importActual) => ({
  ...(await importActual<typeof import("@/lib/tauri")>()),
  saveFlightsSlice: vi.fn().mockResolvedValue(undefined),
  saveUiSlice: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/components/flights/MultiTargetPicker", () => ({
  MultiTargetPicker: ({
    picked,
    allowMultiple,
    onValidationChange,
  }: {
    picked: unknown[];
    allowMultiple: boolean;
    onValidationChange: (errors: string[]) => void;
  }) => {
    useEffect(() => onValidationChange([]), [onValidationChange]);
    return (
      <output aria-label="Selected execution agents">
        {picked.length} / {String(allowMultiple)}
      </output>
    );
  },
}));
vi.mock("@/components/flights/FlightAgentPicker", () => ({
  FlightAgentPicker: () => null,
}));
vi.mock("@/stores/sessionGlue", () => ({ openConversationInAgents: vi.fn() }));
vi.mock("@/stores/agentConversationPersistence", async (importActual) => ({
  ...(await importActual<typeof import("@/stores/agentConversationPersistence")>()),
  requestConversationSave: vi.fn(),
}));

import { LaunchAsyncFlightModal } from "@/components/flights/LaunchAsyncFlightModal";
import { useAsyncFlightStore } from "@/stores/asyncFlightStore";
import { useFlightStore } from "@/stores/flightStore";
import { useWorkspaceStore } from "@/stores/workspaceStore";
import { useServerStore } from "@/stores/serverStore";
import { useAgentTaskStore } from "@/stores/agentTaskStore";
import { useGitHubStore } from "@/stores/githubStore";
import type { ServerConfig } from "@/types/server";
import type { Flight } from "@/types/flight";

const server: ServerConfig = {
  id: "build-host",
  name: "Build host",
  host: "build.example.com",
  port: 22,
  username: "dev",
  authMethod: "key",
  hostFingerprint: "SHA256:pinned",
  installedAgents: [],
};
const launch = vi.fn();
const stop = vi.fn();
const createPlan = vi.fn();
const cancelConversation = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  useFlightStore.setState({ flights: [], activeFlightId: null });
  useWorkspaceStore.setState({ workspaces: [], activeWorkspaceId: null });
  useServerStore.setState({ servers: [server] });
  useAgentTaskStore.setState({
    conversations: [],
    createApiConversation: createPlan,
    cancelActiveConversation: cancelConversation,
  });
  useAsyncFlightStore.setState({ launchAsync: launch, stopFlight: stop });
  useGitHubStore.setState({ defaultPublishAttemptsAsPrs: false });
  launch.mockResolvedValue([]);
  stop.mockResolvedValue(undefined);
  createPlan.mockImplementation(async ({ explicitId }: { explicitId: string }) => explicitId);
  cancelConversation.mockResolvedValue(undefined);
});

describe("Flight brief Run and Plan contract", () => {
  it("starts with one Assisted agent and persists the user's branch and checks before explicit Run", async () => {
    const onClose = vi.fn();
    render(
      <LaunchAsyncFlightModal
        onClose={onClose}
        initialContext={{
          projectPath: "D:/repo",
          baseBranch: "develop",
          objective: "Fix the dialog",
          acceptanceCriteria: ["Keyboard focus returns to the opener"],
        }}
      />,
    );
    expect(screen.getByLabelText("Desired outcome")).toHaveValue("Fix the dialog");
    expect(screen.getByLabelText("Acceptance checks")).toHaveValue(
      "Keyboard focus returns to the opener",
    );
    expect(screen.getByLabelText("Selected execution agents")).toHaveTextContent("1 / false");
    await waitFor(() => expect(screen.getByRole("button", { name: "Run Flight" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "Run Flight" }));
    await waitFor(() => expect(onClose).toHaveBeenCalledOnce());

    const flight = useFlightStore.getState().flights[0];
    expect(flight).toMatchObject({
      autonomyMode: "assisted",
      gitBranch: "develop",
      executionTarget: { kind: "local", basePath: "D:/repo" },
      reviewGatePolicy: {
        enabled: false,
        acceptanceCriteria: ["Keyboard focus returns to the opener"],
      },
    });
    expect(launch).toHaveBeenCalledWith(
      flight.id,
      expect.stringContaining("Acceptance checks:"),
      [expect.objectContaining({ basePath: "D:/repo", baseBranch: "develop" })],
      expect.objectContaining({ explicitResume: true, canStart: expect.any(Function) }),
    );
  });

  it("keeps a standalone SSH plan's exact execution target and selected branch without a Workspace", async () => {
    const onClose = vi.fn();
    render(
      <LaunchAsyncFlightModal
        onClose={onClose}
        initialContext={{
          projectPath: "/srv/approved-project",
          serverId: server.id,
          baseBranch: "trunk",
          objective: "Implement the scoped change",
          acceptanceCriteria: ["Existing behavior passes"],
        }}
      />,
    );
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Plan before running" })).toBeEnabled(),
    );
    fireEvent.click(screen.getByRole("button", { name: "Plan before running" }));
    await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
    const flight = useFlightStore.getState().flights[0];
    expect(flight).toMatchObject({
      gitBranch: "trunk",
      workspaceId: null,
      planningConversationId: expect.any(String),
      executionTarget: { kind: "ssh", serverId: server.id, basePath: "/srv/approved-project" },
    });
    expect(createPlan).toHaveBeenCalledWith(
      expect.objectContaining({
        explicitId: flight.planningConversationId,
        projectPath: "/srv/approved-project",
        permissionMode: "deny_all",
        approveWrites: false,
        initialMessage: expect.stringContaining("Existing behavior passes"),
        sshTarget: expect.objectContaining({
          serverId: server.id,
          hostFingerprint: "SHA256:pinned",
        }),
      }),
    );
    expect(launch).not.toHaveBeenCalled();
  });

  it("clears individual PR publishing when choosing cooperative work", async () => {
    useGitHubStore.setState({ defaultPublishAttemptsAsPrs: true });
    render(
      <LaunchAsyncFlightModal
        onClose={() => {}}
        initialContext={{
          projectPath: "D:/repo",
          baseBranch: "main",
          objective: "Divide one scoped change",
        }}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /Execution options/ }));
    fireEvent.click(screen.getByRole("radio", { name: "Plan and divide work" }));
    const publish = screen.getByRole("checkbox", { name: /Publish attempts as draft PRs/ });
    expect(publish).toBeDisabled();
    expect(publish).not.toBeChecked();
    expect(
      screen.getByText(/Review the combined changes, then land the Flight/),
    ).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Plan cooperative work" })).toBeEnabled(),
    );
    fireEvent.click(screen.getByRole("button", { name: "Plan cooperative work" }));
    await waitFor(() => expect(createPlan).toHaveBeenCalledOnce());
    expect(useFlightStore.getState().flights[0]).toMatchObject({
      executionMode: "cooperative",
      publishAttemptsAsPrs: false,
    });
  });

  it("revokes pending startup before invoking unified Stop", async () => {
    let finish!: () => void;
    launch.mockReturnValue(
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
    );
    const onClose = vi.fn();
    render(
      <LaunchAsyncFlightModal
        onClose={onClose}
        initialContext={{
          projectPath: "D:/repo",
          baseBranch: "main",
          objective: "A bounded task",
        }}
      />,
    );
    await waitFor(() => expect(screen.getByRole("button", { name: "Run Flight" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "Run Flight" }));
    await waitFor(() => expect(launch).toHaveBeenCalledOnce());
    const options = launch.mock.calls[0][3];
    expect(options.canStart()).toBe(true);
    stop.mockImplementation(async () => {
      expect(options.canStart()).toBe(false);
    });
    fireEvent.click(screen.getByRole("button", { name: "Stop launch" }));
    await waitFor(() => expect(stop).toHaveBeenCalledWith(useFlightStore.getState().flights[0].id));
    await act(async () => finish());
    expect(options.canStart()).toBe(false);
  });

  it("registers planner ownership before startup and cancels a late startup after Stop", async () => {
    let finish!: () => void;
    createPlan.mockImplementation(({ explicitId }: { explicitId: string }) => {
      expect(useFlightStore.getState().flights[0].planningConversationId).toBe(explicitId);
      return new Promise<string>((resolve) => {
        finish = () => resolve(explicitId);
      });
    });
    render(
      <LaunchAsyncFlightModal
        onClose={() => {}}
        initialContext={{
          projectPath: "D:/repo",
          baseBranch: "main",
          objective: "Plan one scoped task",
        }}
      />,
    );
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Plan before running" })).toBeEnabled(),
    );
    fireEvent.click(screen.getByRole("button", { name: "Plan before running" }));
    await waitFor(() => expect(createPlan).toHaveBeenCalledOnce());
    const id = useFlightStore.getState().flights[0].planningConversationId;
    fireEvent.click(screen.getByRole("button", { name: "Stop planning" }));
    await act(async () => finish());
    await waitFor(() => expect(cancelConversation).toHaveBeenCalledWith(id));
    expect(useFlightStore.getState().flights[0].planningConversationId).toBe(id);
  });

  it("keeps the prepared Flight when an explicit launch fails and is retried", async () => {
    launch.mockRejectedValueOnce(new Error("Provider unavailable"));
    render(
      <LaunchAsyncFlightModal
        onClose={() => {}}
        initialContext={{
          projectPath: "D:/repo",
          baseBranch: "main",
          objective: "Retry the same scoped task",
        }}
      />,
    );
    await waitFor(() => expect(screen.getByRole("button", { name: "Run Flight" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "Run Flight" }));
    await waitFor(() => expect(screen.getByText("Provider unavailable")).toBeTruthy());
    const id = useFlightStore.getState().flights[0].id;
    fireEvent.click(screen.getByRole("button", { name: "Run Flight" }));
    await waitFor(() => expect(launch).toHaveBeenCalledTimes(2));
    expect(launch.mock.calls.map((call) => call[0])).toEqual([id, id]);
    expect(useFlightStore.getState().flights).toHaveLength(1);
  });

  it("describes a failed provisioned attempt as retained work rather than a running agent", async () => {
    launch.mockImplementationOnce(async (flightId: string) => {
      useFlightStore.getState().updateFlight(flightId, {
        attempts: [
          {
            id: "failed-provision",
            flightId,
            target: {
              kind: "local",
              basePath: "D:/repo",
              worktreePath: "D:/repo/.worktrees/failed",
            },
            agentConfigId: "api-claude",
            provider: "anthropic",
            model: "test-model",
            branch: "pkt/failed",
            baseBranch: "main",
            sessionId: "failed-session",
            status: "failed",
            cost: 0,
            tokens: 0,
          },
        ],
      });
      throw new Error("Provider unavailable");
    });
    render(
      <LaunchAsyncFlightModal
        onClose={() => {}}
        initialContext={{
          projectPath: "D:/repo",
          baseBranch: "main",
          objective: "Keep failed work visible",
        }}
      />,
    );
    await waitFor(() => expect(screen.getByRole("button", { name: "Run Flight" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "Run Flight" }));
    await waitFor(() =>
      expect(
        screen.getByText(
          "Provider unavailable Prepared work is retained for inspection in Flight Deck.",
        ),
      ).toBeInTheDocument(),
    );
    expect(screen.queryByText(/agents? (?:is|are) running/)).not.toBeInTheDocument();
  });

  it("requires an explicit new Flight for a delivered result", async () => {
    const delivered = {
      id: "delivered",
      title: "Finished",
      objective: "Original work",
      status: "done",
      priority: "medium",
      projectPath: "D:/repo",
      workspaceId: null,
      milestones: [],
      linkedSessionIds: [],
      issueIds: [],
      createdAt: 1,
      updatedAt: 1,
      totalCost: 0,
      totalTokens: 0,
      delivery: {
        kind: "landed",
        deliveredAt: 1,
        commitSha: "a".repeat(40),
        branch: "pkt/result",
        baseBranch: "main",
      },
    } as Flight;
    useFlightStore.setState({ flights: [delivered] });
    render(
      <LaunchAsyncFlightModal
        onClose={() => {}}
        initialContext={{
          flightId: delivered.id,
          projectPath: "D:/repo",
          baseBranch: "main",
          objective: "Follow-up",
        }}
      />,
    );
    expect(screen.getByRole("button", { name: "Run Flight" })).toBeDisabled();
    expect(launch).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Create a new Flight" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Run Flight" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "Run Flight" }));
    await waitFor(() => expect(launch).toHaveBeenCalledOnce());
    expect(launch.mock.calls[0][0]).not.toBe(delivered.id);
    expect(
      useFlightStore.getState().flights.find((flight) => flight.id === delivered.id)?.delivery,
    ).toEqual(delivered.delivery);
  });
});
