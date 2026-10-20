import { describe, expect, it, vi, beforeEach } from "vitest";
import type { PersistedStateDto } from "@/generated/tauri-schema";
import type { Flight } from "@/types/flight";
import type { Workspace } from "@/types/workspace";

const mockInvoke = vi.hoisted(() => vi.fn());

vi.mock("@tauri-apps/api/core", () => ({
  invoke: mockInvoke,
}));

import {
  loadPersistedState,
  saveFlightsSlice,
  saveUiSlice,
  saveWorkspacesSlice,
  launchFlightAsync,
  resumeFlightAttempt,
} from "@/lib/tauri";

function makeFlight(overrides: Partial<Flight> = {}): Flight {
  return {
    id: "flight-1",
    title: "Flight",
    objective: "Objective",
    status: "active",
    priority: "medium",
    projectPath: "/repo",
    workspaceId: null,
    milestones: [],
    linkedSessionIds: [],
    issueIds: [],
    createdAt: 1,
    updatedAt: 2,
    totalCost: 0,
    totalTokens: 0,
    ...overrides,
  };
}

function makePersistedStateDto(overrides: Partial<PersistedStateDto> = {}): PersistedStateDto {
  return {
    version: 1,
    flights: [],
    agents: [],
    issues: [],
    settings: {
      maxParallelSessions: 3,
      milestoneGating: true,
      projectPath: "/repo",
      autoCommitTrailerEnabled: true,
      autoCommitTrailerFormat: "Run-By: PacketBench flight F-{flightId} attempt A-{attemptId}",
    },
    ui: {},
    workspaces: [],
    memoryEvents: [],
    memoryPatterns: [],
    servers: [],
    cliAccounts: [],
    cliAccountDefaults: {},
    ...overrides,
  };
}

describe("Tauri persistence DTO mapping", () => {
  beforeEach(() => {
    mockInvoke.mockReset();
    mockInvoke.mockResolvedValue(undefined);
  });

  it("prepares first-launch sessions and maps the camelCase attempt wire contract", async () => {
    const dto = {
      id: "attempt-wire",
      flightId: "flight-1",
      sessionId: "builder-wire",
      target: { kind: "local", basePath: "/repo", worktreePath: "/repo/retained" },
      agentConfigId: "api-openai",
      provider: "openai",
      model: "test-model",
      branch: "pkt/a",
      baseBranch: "main",
      status: "provisioning",
      cost: 0,
      tokens: 0,
    };
    mockInvoke.mockResolvedValueOnce([dto]);
    const [prepared] = await launchFlightAsync("flight-1", "task brief", [
      {
        kind: "local",
        basePath: "/repo",
        baseBranch: "main",
        agentConfigId: "api-openai",
        provider: "openai",
        model: "test-model",
      },
    ]);
    expect(mockInvoke).toHaveBeenCalledWith(
      "launch_flight_async",
      expect.objectContaining({ prepareOnly: true }),
    );
    expect(prepared).toEqual(
      expect.objectContaining({
        sessionId: "builder-wire",
        agentConfigId: "api-openai",
        target: dto.target,
      }),
    );
    mockInvoke.mockResolvedValueOnce({ ...dto, sessionId: "resumed-builder" });
    expect(await resumeFlightAttempt("flight-1", "attempt-wire", 10)).toEqual(
      expect.objectContaining({ sessionId: "resumed-builder", target: dto.target }),
    );
    expect(mockInvoke).toHaveBeenCalledWith("resume_flight_attempt", {
      flightId: "flight-1",
      attemptId: "attempt-wire",
      expectedStoppedAt: 10,
    });
  });

  it("rejects a snake_case core attempt response instead of silently losing the conversation identity", async () => {
    mockInvoke.mockResolvedValueOnce([
      {
        id: "a",
        flight_id: "flight-1",
        session_id: "builder",
        agent_config_id: "api-openai",
        target: { kind: "local", worktree_path: "/repo/a" },
      },
    ]);
    await expect(launchFlightAsync("flight-1", "brief", [])).rejects.toThrow(
      "missing its conversation or worktree identity",
    );
  });

  it("round-trips delivery, recovery, stopped state, saved target and old builder owners", async () => {
    const delivery = {
      kind: "pull_request" as const,
      deliveredAt: 25,
      branch: "pkt/a",
      baseBranch: "main",
      prNumber: 42,
      prUrl: "https://example.invalid/pr/42",
      attemptId: "a",
    };
    const recovery = {
      state: "retained" as const,
      reason: "Restart interrupted the builder",
      retainedAt: 10,
    };
    const sessionHistory = [
      { sessionId: "old-builder", provider: "anthropic", model: "old-model" },
    ];
    const executionTarget = { kind: "ssh" as const, serverId: "saved-server", basePath: "/repo" };
    const flight = makeFlight({
      stoppedAt: 30,
      archivedAt: 40,
      delivery,
      executionTarget,
      attempts: [
        {
          id: "a",
          flightId: "flight-1",
          target: {
            kind: "ssh",
            serverId: "saved-server",
            basePath: "/repo",
            worktreePath: "/repo/retained",
          },
          agentConfigId: "api-openai",
          provider: "openai",
          model: "builder-model",
          branch: "pkt/a",
          baseBranch: "main",
          sessionId: "new-builder",
          status: "completed",
          cost: 0,
          tokens: 0,
          recovery,
          delivery,
          sessionHistory,
        },
      ],
    });
    await saveFlightsSlice([flight]);
    const dtoFlights = mockInvoke.mock.calls[mockInvoke.mock.calls.length - 1][1]
      .flights as PersistedStateDto["flights"];
    expect(dtoFlights[0]).toEqual(
      expect.objectContaining({ stoppedAt: 30, archivedAt: 40, delivery, executionTarget }),
    );
    expect(dtoFlights[0].attempts[0]).toEqual(
      expect.objectContaining({ recovery, delivery, sessionHistory }),
    );
    mockInvoke.mockResolvedValue(makePersistedStateDto({ flights: dtoFlights }));
    const hydrated = (await loadPersistedState()).flights[0];
    expect(hydrated.executionTarget).toEqual(executionTarget);
    expect(hydrated.delivery).toEqual(delivery);
    expect(hydrated.attempts?.[0]).toEqual(
      expect.objectContaining({ recovery, delivery, sessionHistory }),
    );
  });

  it("round-trips flight workspace, planning conversation, and legacy planner fields", async () => {
    await saveFlightsSlice([
      makeFlight({
        workspaceId: "workspace-1",
        planningConversationId: "conversation-1",
        plannerSessionId: "planner-session-1",
        plannerStatus: "quota_paused",
        plannerCost: 1.25,
        plannerTokens: 42,
        plannerProvider: "claude-oauth",
      }),
    ]);

    expect(mockInvoke).toHaveBeenCalledWith("save_flights_slice", {
      flights: [
        expect.objectContaining({
          workspaceId: "workspace-1",
          planningConversationId: "conversation-1",
          plannerSessionId: "planner-session-1",
          plannerStatus: "quota_paused",
          plannerCost: 1.25,
          plannerTokens: 42,
          plannerProvider: "claude-oauth",
        }),
      ],
    });
  });

  it("round-trips the coordination log so handoff/escalation events survive reload", async () => {
    const event = {
      id: "coord-1",
      flightId: "flight-1",
      type: "handoff" as const,
      summary: "Implemented auth; handing off for review",
      timestamp: 99,
      metadata: { source: "mcp" },
    };
    await saveFlightsSlice([makeFlight({ coordinationLog: [event] })]);
    expect(mockInvoke).toHaveBeenCalledWith("save_flights_slice", {
      flights: [expect.objectContaining({ coordinationLog: [event] })],
    });
  });

  it("round-trips Reviewer Gate policy and attempt verdict state", async () => {
    const reviewGatePolicy = {
      enabled: true,
      reviewerAgentConfigId: "api-openai-codex",
      reviewerModel: "gpt-5.5",
      acceptanceCriteria: ["Tests pass", "No unsafe path writes"],
    };
    const reviewGate = {
      status: "changes_requested" as const,
      reviewerSessions: [],
      reviewerConversationId: "review-1",
      reviewerAgentConfigId: "api-openai-codex",
      reviewerModel: "gpt-5.5",
      report: {
        schemaVersion: 1 as const,
        verdict: "changes_requested" as const,
        summary: "One issue remains.",
        findings: [
          {
            severity: "error" as const,
            title: "Missing regression",
            details: "Add the reload case.",
            filePath: "src/reviewer.ts",
            line: 42,
          },
        ],
        evidence: ["pnpm test"],
      },
      startedAt: 10,
      completedAt: 20,
    };
    const attempt = {
      id: "attempt-1",
      flightId: "flight-1",
      target: {
        kind: "local" as const,
        basePath: "/repo",
        worktreePath: "/repo/.pkt-worktrees/attempt-1",
      },
      agentConfigId: "api-claude",
      model: "claude-sonnet-4-6",
      provider: "claude",
      branch: "pkt/attempt-1",
      baseBranch: "main",
      sessionId: "session-1",
      status: "reviewing" as const,
      cost: 0,
      tokens: 0,
      reviewGate,
    };

    await saveFlightsSlice([makeFlight({ reviewGatePolicy, attempts: [attempt] })]);
    expect(mockInvoke).toHaveBeenCalledWith("save_flights_slice", {
      flights: [
        expect.objectContaining({
          reviewGatePolicy,
          attempts: [expect.objectContaining({ reviewGate })],
        }),
      ],
    });

    mockInvoke.mockResolvedValue(
      makePersistedStateDto({
        flights: [
          {
            ...makeFlight({ reviewGatePolicy }),
            attempts: [attempt],
            publishAttemptsAsPrs: false,
          } as unknown as PersistedStateDto["flights"][number],
        ],
      }),
    );
    const state = await loadPersistedState();
    expect(state.flights[0].reviewGatePolicy).toEqual(reviewGatePolicy);
    expect(state.flights[0].attempts?.[0].reviewGate).toEqual(reviewGate);

    // Older snapshots have no frozen context or ownership ledger. Keep them
    // explicitly unbound rather than manufacturing freshness on serialization.
    await saveFlightsSlice([
      makeFlight({
        attempts: [
          {
            ...attempt,
            reviewGate: {
              status: "passed",
              evidence: {
                fingerprint: "old",
                contextFingerprint: "old",
                headSha: "head",
                baseSha: "base",
              },
            },
          },
        ],
      }),
    ]);
    expect(mockInvoke).toHaveBeenLastCalledWith("save_flights_slice", {
      flights: [
        expect.objectContaining({
          attempts: [
            expect.objectContaining({
              reviewGate: expect.objectContaining({
                evidence: expect.objectContaining({ contextJson: "" }),
                reviewerSessions: [],
              }),
            }),
          ],
        }),
      ],
    });
  });

  it("keeps retry counts across DTO hydration and exhausts an unknown counter", async () => {
    mockInvoke.mockResolvedValue(
      makePersistedStateDto({
        flights: [
          {
            ...makeFlight(),
            attempts: [],
            publishAttemptsAsPrs: false,
            autonomyRuntime: {
              status: "paused",
              actionHistory: [],
              reviewRetryCounts: { valid: 2, unknown: undefined },
            },
          } as unknown as PersistedStateDto["flights"][number],
        ],
      }),
    );
    const state = await loadPersistedState();
    expect(state.flights[0].autonomyRuntime?.reviewRetryCounts).toEqual({
      valid: 2,
      unknown: 0xffff_ffff,
    });
  });

  it("hydrates legacy Flights with the Reviewer Gate disabled", async () => {
    mockInvoke.mockResolvedValue(
      makePersistedStateDto({
        flights: [
          {
            ...makeFlight(),
            attempts: [],
            publishAttemptsAsPrs: false,
          } as unknown as PersistedStateDto["flights"][number],
        ],
      }),
    );
    const state = await loadPersistedState();
    expect(state.flights[0].reviewGatePolicy).toBeUndefined();
  });

  it("round-trips cooperative execution metadata and task-bound attempts", async () => {
    const integrationBranch = {
      branch: "packetbench/flight/flight-1",
      baseBranch: "main",
      baseSha: "base123",
      headSha: "head456",
      worktreePath: "/repo/.pkt-flight-integrations/flight-1",
      targetKind: "local" as const,
      status: "ready" as const,
      conflictFiles: [],
    };
    const cooperative = makeFlight({
      executionMode: "cooperative",
      integrationBranch,
      attempts: [
        {
          id: "attempt-task",
          flightId: "flight-1",
          target: {
            kind: "local",
            basePath: "/repo",
            worktreePath: "/repo/.pkt-worktrees/attempt-task",
          },
          agentConfigId: "api-claude",
          model: "claude-sonnet-4-6",
          provider: "claude",
          branch: "pkt/attempt-task",
          baseBranch: integrationBranch.branch,
          sessionId: "session-task",
          status: "running",
          taskId: "task-1",
          cost: 0,
          tokens: 0,
        },
      ],
    });
    await saveFlightsSlice([cooperative]);
    expect(mockInvoke).toHaveBeenCalledWith("save_flights_slice", {
      flights: [
        expect.objectContaining({
          executionMode: "cooperative",
          integrationBranch,
          attempts: [expect.objectContaining({ taskId: "task-1" })],
        }),
      ],
    });

    mockInvoke.mockResolvedValue(
      makePersistedStateDto({
        flights: [
          {
            ...cooperative,
            publishAttemptsAsPrs: false,
          } as unknown as PersistedStateDto["flights"][number],
        ],
      }),
    );
    const state = await loadPersistedState();
    expect(state.flights[0]).toEqual(
      expect.objectContaining({
        executionMode: "cooperative",
        integrationBranch,
      }),
    );
    expect(state.flights[0].attempts?.[0].taskId).toBe("task-1");
  });

  it("round-trips the structured coordination inbox without changing legacy logs", async () => {
    const message = {
      schemaVersion: 1 as const,
      id: "inbox-1",
      flightId: "flight-1",
      kind: "blocker" as const,
      sender: { kind: "agent" as const, id: "agent-1", displayName: "Agent 1" },
      recipient: { kind: "flight" as const, id: "flight-1", label: "Flight" },
      body: "Need an API decision.",
      artifacts: [],
      status: "queued" as const,
      createdAt: 123,
      acknowledgements: [],
      dedupeKey: "dedupe-1",
      hopCount: 0,
    };
    await saveFlightsSlice([makeFlight({ coordinationInbox: [message] })]);
    expect(mockInvoke).toHaveBeenCalledWith("save_flights_slice", {
      flights: [
        expect.objectContaining({
          coordinationInbox: [message],
        }),
      ],
    });
    mockInvoke.mockResolvedValue(
      makePersistedStateDto({
        flights: [
          {
            ...makeFlight(),
            attempts: [],
            coordinationInbox: [message],
            publishAttemptsAsPrs: false,
          } as unknown as PersistedStateDto["flights"][number],
        ],
      }),
    );
    const state = await loadPersistedState();
    expect(state.flights[0].coordinationInbox).toEqual([message]);
    expect(state.flights[0].coordinationLog).toEqual([]);
  });

  it("hydrates flight planner fields and server host fingerprints from DTOs", async () => {
    mockInvoke.mockResolvedValue(
      makePersistedStateDto({
        flights: [
          {
            ...makeFlight({
              workspaceId: "workspace-1",
              planningConversationId: "conversation-1",
              plannerSessionId: "planner-session-1",
              plannerStatus: "awake",
              plannerCost: 2.5,
              plannerTokens: 123,
              plannerProvider: "api-claude",
            }),
            attempts: [],
            publishAttemptsAsPrs: false,
          } as unknown as PersistedStateDto["flights"][number],
        ],
        servers: [
          {
            id: "server-1",
            name: "Server",
            host: "example.com",
            port: 22,
            username: "ian",
            authMethod: "key",
            keyPath: null,
            remotePath: null,
            lastConnectedAt: BigInt(5),
            installedAgents: [],
            hostFingerprint: "SHA256:test",
          },
        ],
      }),
    );

    const state = await loadPersistedState();

    expect(state.flights[0]).toEqual(
      expect.objectContaining({
        workspaceId: "workspace-1",
        planningConversationId: "conversation-1",
        plannerSessionId: "planner-session-1",
        plannerStatus: "awake",
        plannerCost: 2.5,
        plannerTokens: 123,
        plannerProvider: "api-claude",
      }),
    );
    expect(state.servers[0].hostFingerprint).toBe("SHA256:test");
  });

  it("passes through workspace pane pinnedCommands and githubRepo when present", async () => {
    const workspace: Workspace = {
      id: "workspace-1",
      name: "Workspace",
      agents: ["codex"],
      panes: [
        {
          id: "pane-1",
          agentId: "codex",
          sessionId: "session-1",
          gridPosition: { row: 0, col: 0 },
          pinnedCommands: ["pnpm test"],
        },
      ],
      projectPath: "/repo",
      createdAt: 1,
      updatedAt: 2,
      status: "active",
      githubRepo: { owner: "openai", repo: "packetbench" },
    };

    await saveWorkspacesSlice([workspace]);

    expect(mockInvoke).toHaveBeenCalledWith("save_workspaces_slice", {
      workspaces: [
        expect.objectContaining({
          githubRepo: { owner: "openai", repo: "packetbench" },
          panes: [
            expect.objectContaining({
              pinnedCommands: ["pnpm test"],
            }),
          ],
        }),
      ],
    });

    // Legacy/backend-owned pane metadata (taskId, flightId, agentConfigId,
    // initialPrompt, overrideCommand, overrideArgs) from the retired
    // tick-loop scheduler may still be echoed back by an unmigrated
    // backend this wave — hydration must silently ignore it rather than
    // crash or resurrect it onto the frontend Workspace type.
    mockInvoke.mockResolvedValue(
      makePersistedStateDto({
        workspaces: [
          {
            id: "workspace-1",
            name: "Workspace",
            agents: ["codex"],
            panes: [
              {
                id: "pane-1",
                agentId: "codex",
                sessionId: "session-1",
                gridPosition: { row: 0, col: 0 },
                pinnedCommands: ["pnpm test"],
                taskId: "task-1",
                flightId: "flight-1",
                agentConfigId: "codex",
                initialPrompt: "Start here",
                overrideCommand: "codex",
                overrideArgs: ["--ask-for-approval", "never"],
              },
            ],
            projectPath: "/repo",
            createdAt: 1,
            updatedAt: 2,
            status: "active",
            githubRepo: { owner: "openai", repo: "packetbench" },
          } as unknown as PersistedStateDto["workspaces"][number],
        ],
      }),
    );

    const state = await loadPersistedState();
    expect(state.workspaces[0].githubRepo).toEqual({ owner: "openai", repo: "packetbench" });
    expect(state.workspaces[0].panes[0]).toEqual(
      expect.objectContaining({
        pinnedCommands: ["pnpm test"],
      }),
    );
    expect(state.workspaces[0].panes[0]).not.toHaveProperty("taskId");
    expect(state.workspaces[0].panes[0]).not.toHaveProperty("flightId");
    expect(state.workspaces[0].panes[0]).not.toHaveProperty("initialPrompt");
    expect(state.workspaces[0].panes[0]).not.toHaveProperty("overrideCommand");
    expect(state.workspaces[0].panes[0]).not.toHaveProperty("overrideArgs");
  });

  it("round-trips a conversation pane's kind + conversationId through toDto/fromDto", async () => {
    // Tile program (P1-S1): a conversation pane carries the inert carrier
    // agentId "terminal" plus kind:"conversation" + conversationId. The
    // five-field pane whitelist would silently drop the new fields on the next
    // save unless they are threaded through BOTH toDtoWorkspace and fromDto.
    const workspace: Workspace = {
      id: "workspace-conv",
      name: "Workspace",
      agents: [],
      panes: [
        {
          id: "pane-conv",
          agentId: "terminal",
          sessionId: null,
          gridPosition: { row: 0, col: 1 },
          kind: "conversation",
          conversationId: "conv-123",
        },
      ],
      projectPath: "/repo",
      createdAt: 1,
      updatedAt: 2,
      status: "active",
    };

    await saveWorkspacesSlice([workspace]);

    // toDto must emit kind + conversationId (not drop them at the whitelist).
    expect(mockInvoke).toHaveBeenCalledWith("save_workspaces_slice", {
      workspaces: [
        expect.objectContaining({
          panes: [
            expect.objectContaining({
              agentId: "terminal",
              kind: "conversation",
              conversationId: "conv-123",
            }),
          ],
        }),
      ],
    });

    // fromDto must hydrate them back onto the frontend Workspace pane.
    mockInvoke.mockResolvedValue(
      makePersistedStateDto({
        workspaces: [
          {
            id: "workspace-conv",
            name: "Workspace",
            agents: [],
            panes: [
              {
                id: "pane-conv",
                agentId: "terminal",
                sessionId: null,
                gridPosition: { row: 0, col: 1 },
                kind: "conversation",
                conversationId: "conv-123",
              },
            ],
            projectPath: "/repo",
            createdAt: 1,
            updatedAt: 2,
            status: "active",
          } as unknown as PersistedStateDto["workspaces"][number],
        ],
      }),
    );

    const state = await loadPersistedState();
    expect(state.workspaces[0].panes[0]).toEqual(
      expect.objectContaining({
        agentId: "terminal",
        kind: "conversation",
        conversationId: "conv-123",
      }),
    );
  });

  it("does not emit kind/conversationId for a plain terminal pane (byte-identical save)", async () => {
    // Terminal panes must stay on the pre-P1-S1 shape so old binaries and the
    // five-field-era round-trip are unaffected.
    const workspace: Workspace = {
      id: "workspace-term",
      name: "Workspace",
      agents: ["terminal"],
      panes: [
        {
          id: "pane-term",
          agentId: "terminal",
          sessionId: null,
          gridPosition: { row: 0, col: 0 },
        },
      ],
      projectPath: "/repo",
      createdAt: 1,
      updatedAt: 2,
      status: "active",
    };

    await saveWorkspacesSlice([workspace]);

    const call = mockInvoke.mock.calls.find((c) => c[0] === "save_workspaces_slice");
    expect(call).toBeDefined();
    const pane = (call![1] as { workspaces: { panes: Record<string, unknown>[] }[] }).workspaces[0]
      .panes[0];
    expect(pane).not.toHaveProperty("kind");
    expect(pane).not.toHaveProperty("conversationId");
    // Multi-account CLI support: an ambient pane must stay byte-identical too.
    expect(pane).not.toHaveProperty("accountId");
  });

  it("round-trips a pane's accountId through toDto/fromDto", async () => {
    // Multi-account CLI support: the pane-level `accountId` chosen at
    // session-creation time is what the runtime turns into CLAUDE_CONFIG_DIR /
    // CODEX_HOME. The pane whitelist in toDtoWorkspace/fromDtoWorkspace would
    // silently drop it on the next save unless it is threaded through BOTH.
    const workspace: Workspace = {
      id: "workspace-acct",
      name: "Workspace",
      agents: ["claude-code"],
      panes: [
        {
          id: "pane-acct",
          agentId: "claude-code",
          sessionId: null,
          gridPosition: { row: 0, col: 0 },
          accountId: "acct-client",
        },
      ],
      projectPath: "/repo",
      createdAt: 1,
      updatedAt: 2,
      status: "active",
    };

    await saveWorkspacesSlice([workspace]);

    expect(mockInvoke).toHaveBeenCalledWith("save_workspaces_slice", {
      workspaces: [
        expect.objectContaining({
          panes: [expect.objectContaining({ accountId: "acct-client" })],
        }),
      ],
    });

    mockInvoke.mockResolvedValue(
      makePersistedStateDto({
        workspaces: [
          {
            id: "workspace-acct",
            name: "Workspace",
            agents: ["claude-code"],
            panes: [
              {
                id: "pane-acct",
                agentId: "claude-code",
                sessionId: null,
                gridPosition: { row: 0, col: 0 },
                accountId: "acct-client",
              },
            ],
            projectPath: "/repo",
            createdAt: 1,
            updatedAt: 2,
            status: "active",
          } as unknown as PersistedStateDto["workspaces"][number],
        ],
      }),
    );

    const state = await loadPersistedState();
    expect(state.workspaces[0].panes[0]).toEqual(
      expect.objectContaining({ agentId: "claude-code", accountId: "acct-client" }),
    );
  });

  it("omits undefined ui fields for partial ui slice saves", async () => {
    await saveUiSlice({ selectedView: "flights", theme: "dark" });

    expect(mockInvoke).toHaveBeenCalledWith("save_ui_slice", {
      ui: {
        selectedView: "flights",
        theme: "dark",
      },
    });
  });

  it("encodes explicit null ui fields so partial saves can clear them", async () => {
    await saveUiSlice({ selectedFlightId: null });

    expect(mockInvoke).toHaveBeenCalledWith("save_ui_slice", {
      ui: {
        selectedFlightId: "",
      },
    });
  });

  it("omits null theme values because the backend theme dto is an enum", async () => {
    await saveUiSlice({ selectedView: "flights", theme: null });

    expect(mockInvoke).toHaveBeenCalledWith("save_ui_slice", {
      ui: {
        selectedView: "flights",
      },
    });
  });
});
