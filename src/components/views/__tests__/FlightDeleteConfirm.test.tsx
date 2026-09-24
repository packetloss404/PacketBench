/**
 * Flight-delete confirm.
 *
 * The flight row's delete used to be a 3-second armed inline button that
 * dropped the record and abandoned whatever was running. It is now the shared
 * `ConfirmDeleteModal`, and it must NAME what the delete destroys: how many
 * attempts get cancelled, how many worktrees get removed, and which of those
 * worktrees still hold uncommitted work.
 *
 * `FlightRow` is internal to `FlightsView`, so these tests mount the view with
 * mocked stores and drive the real DOM. Heavy children are stubbed out.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { Flight } from "@/types/flight";
import type { FlightDeleteImpact } from "@/stores/asyncFlightStore";

const mocks = vi.hoisted(() => ({
  flightState: {
    flights: [] as Flight[],
    activeFlightId: null as string | null,
    setActiveFlight: vi.fn(),
    deleteFlight: vi.fn(),
    computeFlightStatus: vi.fn(() => "active"),
  },
  memoryState: { events: [] as unknown[] },
  appState: { openMemoryView: vi.fn() },
  inspectFlightDeleteImpact: vi.fn(),
  // Every async-flight action the mounted tree may select. Only the delete
  // fan-out matters here; the rest keep sibling cards mountable.
  asyncState: {
    deleteFlightWithAttemptCleanup: vi.fn(),
    launchAsync: vi.fn(),
    cancelAttempt: vi.fn(),
    setAttemptStatus: vi.fn(),
    reassignAttempt: vi.fn(),
    retryReviewGate: vi.fn(),
    overrideReviewGate: vi.fn(),
    sendReviewFindingsToBuilder: vi.fn(),
    prepareCooperativeFlight: vi.fn(),
    launchReadyTasks: vi.fn(),
    landCooperativeFlight: vi.fn(),
  },
}));

vi.mock("@/stores/flightStore", () => ({
  useFlightStore: Object.assign(
    vi.fn((selector?: (s: typeof mocks.flightState) => unknown) =>
      selector ? selector(mocks.flightState) : mocks.flightState,
    ),
    { getState: vi.fn(() => mocks.flightState) },
  ),
}));

vi.mock("@/stores/memoryStore", () => ({
  useMemoryStore: Object.assign(
    vi.fn((selector?: (s: typeof mocks.memoryState) => unknown) =>
      selector ? selector(mocks.memoryState) : mocks.memoryState,
    ),
    { getState: vi.fn(() => mocks.memoryState) },
  ),
}));

vi.mock("@/stores/appStore", () => ({
  useAppStore: Object.assign(
    vi.fn((selector?: (s: typeof mocks.appState) => unknown) =>
      selector ? selector(mocks.appState) : mocks.appState,
    ),
    { getState: vi.fn(() => mocks.appState), subscribe: vi.fn(() => vi.fn()) },
  ),
}));

// Keep the real warning-text builders (they are what this test is about) and
// swap only the Tauri-touching probe + the delete action.
vi.mock("@/stores/asyncFlightStore", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/stores/asyncFlightStore")>();
  return {
    ...actual,
    inspectFlightDeleteImpact: mocks.inspectFlightDeleteImpact,
    useAsyncFlightStore: Object.assign(
      vi.fn((selector?: (s: typeof mocks.asyncState) => unknown) =>
        selector ? selector(mocks.asyncState) : mocks.asyncState,
      ),
      { getState: vi.fn(() => mocks.asyncState) },
    ),
  };
});

vi.mock("@/components/flights/AsyncFlightGrid", () => ({
  AsyncFlightGrid: () => <div data-testid="mock-async-flight-grid" />,
}));

vi.mock("@/components/flights/LaunchAsyncFlightModal", () => ({
  LaunchAsyncFlightModal: () => null,
}));

import { FlightsView } from "@/components/views/FlightsView";
import { summarizeFlightDeleteImpact } from "@/stores/asyncFlightStore";
import { ToastProvider } from "@/components/ui/Toast";

function makeFlight(overrides: Partial<Flight> = {}): Flight {
  return {
    id: "flight-1",
    title: "Doomed flight",
    objective: "objective",
    status: "active",
    priority: "medium",
    projectPath: "/test",
    workspaceId: null,
    milestones: [],
    linkedSessionIds: [],
    issueIds: [],
    createdAt: 1,
    updatedAt: 1,
    totalCost: 0,
    totalTokens: 0,
    ...overrides,
  };
}

function impactOf(
  entries: Array<[string, FlightDeleteImpact["entries"][number]["cleanliness"], string]>,
): FlightDeleteImpact {
  return summarizeFlightDeleteImpact(
    entries.map(([id, cleanliness, status]) => ({
      attemptId: id,
      branch: `packetbench/${id}`,
      status: status as FlightDeleteImpact["entries"][number]["status"],
      worktreePath: `/w/${id}`,
      cleanliness,
    })),
  );
}

function renderView() {
  return render(
    <ToastProvider>
      <FlightsView />
    </ToastProvider>,
  );
}

/** Mount the view, arm the row's delete, and wait for the confirm to appear. */
async function openConfirm() {
  renderView();
  fireEvent.click(screen.getAllByLabelText("Delete flight")[0]);
  await screen.findByText("Delete flight?");
}

describe("flight delete confirm", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.flightState.flights = [makeFlight()];
    mocks.flightState.activeFlightId = "flight-1";
    mocks.flightState.computeFlightStatus = vi.fn(() => "active" as const);
    mocks.memoryState.events = [];
    mocks.inspectFlightDeleteImpact.mockResolvedValue(summarizeFlightDeleteImpact([]));
    mocks.asyncState.deleteFlightWithAttemptCleanup.mockResolvedValue([]);
  });

  it("opens the shared confirm naming the flight instead of deleting immediately", async () => {
    await openConfirm();

    expect(screen.getByText("“Doomed flight”")).toBeInTheDocument();
    expect(mocks.asyncState.deleteFlightWithAttemptCleanup).not.toHaveBeenCalled();
  });

  it("states the attempt, worktree and dirty-worktree counts", async () => {
    mocks.inspectFlightDeleteImpact.mockResolvedValue(
      impactOf([
        ["a1", "dirty", "running"],
        ["a2", "clean", "running"],
        ["a3", "unknown", "reviewing"],
      ]),
    );

    await openConfirm();

    expect(
      await screen.findByText("3 attempts will be cancelled (2 running, 1 reviewing)."),
    ).toBeInTheDocument();
    expect(screen.getByText("3 git worktrees will be removed.")).toBeInTheDocument();
    expect(
      screen.getByText("1 worktree has uncommitted changes that will be lost: packetbench/a1."),
    ).toBeInTheDocument();
    expect(
      screen.getByText("1 worktree could not be checked for uncommitted changes."),
    ).toBeInTheDocument();
  });

  it("counts live tasks too, which the delete does not cancel", async () => {
    mocks.flightState.flights = [
      makeFlight({
        milestones: [
          {
            id: "ms-1",
            flightId: "flight-1",
            title: "M",
            description: "",
            order: 0,
            status: "active",
            validationCriteria: [],
            tasks: [
              {
                id: "t-1",
                milestoneId: "ms-1",
                flightId: "flight-1",
                title: "T",
                description: "",
                order: 0,
                status: "running",
                type: "implementation",
                agentConfigId: "api-claude",
                dependsOn: [],
                sessionId: null,
                createdAt: 1,
                cost: 0,
                tokens: 0,
              },
            ],
          },
        ],
      }),
    ];

    await openConfirm();

    expect(
      await screen.findByText("1 task is still running or awaiting approval."),
    ).toBeInTheDocument();
  });

  it("says nothing alarming when the flight has no live work", async () => {
    await openConfirm();

    await waitFor(() => {
      expect(screen.queryByText(/will be cancelled/)).not.toBeInTheDocument();
    });
    expect(screen.queryByText("Deleting this also destroys")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Delete" })).toBeInTheDocument();
  });

  it("runs the cancel + worktree-cleanup delete only from the confirm button", async () => {
    mocks.inspectFlightDeleteImpact.mockResolvedValue(impactOf([["a1", "clean", "running"]]));

    await openConfirm();
    const confirm = await screen.findByRole("button", { name: "Cancel attempts & delete" });
    fireEvent.click(confirm);

    expect(mocks.asyncState.deleteFlightWithAttemptCleanup).toHaveBeenCalledWith("flight-1");
    // The record delete never runs on its own — that path abandons worktrees.
    expect(mocks.flightState.deleteFlight).not.toHaveBeenCalled();
  });

  it("backs out with zero mutation on Cancel", async () => {
    await openConfirm();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    await waitFor(() => {
      expect(screen.queryByText("Delete flight?")).not.toBeInTheDocument();
    });
    expect(mocks.asyncState.deleteFlightWithAttemptCleanup).not.toHaveBeenCalled();
    expect(mocks.flightState.deleteFlight).not.toHaveBeenCalled();
  });

  it("surfaces cleanup failures after the flight is gone", async () => {
    mocks.inspectFlightDeleteImpact.mockResolvedValue(impactOf([["a1", "clean", "running"]]));
    mocks.asyncState.deleteFlightWithAttemptCleanup.mockResolvedValue([
      { attemptId: "a1", branch: "packetbench/a1", message: "pty is wedged" },
    ]);

    await openConfirm();
    fireEvent.click(await screen.findByRole("button", { name: "Cancel attempts & delete" }));

    expect(await screen.findByText(/1 attempt cleanup failed/)).toHaveTextContent("pty is wedged");
  });
});
