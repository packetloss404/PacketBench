/**
 * P2-20 — StatGrid single-Cost-cell coverage.
 *
 * The orchestration convergence collapses the Planner + Exec split (E8-UI)
 * back into one "Cost" cell on the flight detail pane's StatGrid, since the
 * tick-loop scheduler and flightPlannerStore FSM that produced the
 * planner/executor cost split are retired — `asyncFlightStore`'s worktree
 * attempts are the sole surviving orchestration path and don't distinguish
 * "planner" spend from "executor" spend. This slice owns the FE regression
 * tests for the collapsed cell and basic FlightsView render coverage.
 *
 * `StatGrid` is an internal helper inside `FlightsView.tsx` — it is NOT
 * exported, so these tests mount the full `FlightsView` with mocked stores
 * and assert the StatGrid output through the rendered DOM (same approach
 * as before the convergence). Heavy children (AsyncFlightGrid,
 * LaunchAsyncFlightModal) are mocked to no-op stubs to keep the mount
 * lightweight and free of unrelated Tauri/listener wiring.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import type { Flight } from "@/types/flight";

// === Hoisted shared state ===
//
// vi.hoisted runs BEFORE the vi.mock factories below, so the factories can
// close over `mocks` and the test bodies can mutate it per-test.

const mocks = vi.hoisted(() => {
  return {
    flightState: {
      flights: [] as Flight[],
      activeFlightId: null as string | null,
      setActiveFlight: vi.fn(),
      deleteFlight: vi.fn(),
      computeFlightStatus: vi.fn(() => "active"),
    },
    memoryState: {
      events: [] as unknown[],
    },
    appState: {
      openMemoryView: vi.fn(),
    },
  };
});

// === Store mocks ===

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

// === Heavy child component stubs ===
//
// These children pull in their own Tauri wiring, async-attempt listeners,
// and modal portals — none of which affect the StatGrid contract. Replace
// with empty divs so the test mounts cleanly.

vi.mock("@/components/flights/AsyncFlightGrid", () => ({
  AsyncFlightGrid: () => <div data-testid="mock-async-flight-grid" />,
}));

vi.mock("@/components/flights/LaunchAsyncFlightModal", () => ({
  LaunchAsyncFlightModal: () => null,
}));

import { FlightsView } from "@/components/views/FlightsView";
import { ToastProvider } from "@/components/ui/Toast";

// === Test helpers ===

// FlightRow raises toasts for delete-cleanup failures, so the view needs a
// live Toast host to mount.
function renderView() {
  return render(
    <ToastProvider>
      <FlightsView />
    </ToastProvider>,
  );
}

function makeFlight(overrides: Partial<Flight> = {}): Flight {
  return {
    id: "flight-1",
    title: "Cost Split Flight",
    objective: "test the cost split",
    status: "active",
    priority: "medium",
    projectPath: "/test",
    workspaceId: null,
    milestones: [],
    linkedSessionIds: [],
    issueIds: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
    totalCost: 1.5,
    totalTokens: 50_000,
    ...overrides,
  };
}

// Find the stat card matching a label. Walks up from the label <span>
// to its parent cell so callers can scope further queries to one cell.
function statCell(label: string): HTMLElement {
  const labelNode = screen.getByText(label);
  const cell = labelNode.parentElement;
  if (!cell) throw new Error(`StatGrid cell for "${label}" not found`);
  return cell as HTMLElement;
}

function valueInCell(cell: HTMLElement): string {
  // Cell layout: <span label> <span value> [<span sub>]
  // The value lives in the second span.
  const spans = cell.querySelectorAll("span");
  if (spans.length < 2) throw new Error("cell has no value span");
  return spans[1]?.textContent ?? "";
}

// === Tests ===

describe("StatGrid cost cell (P2-20 convergence)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.flightState.flights = [];
    mocks.flightState.activeFlightId = null;
    mocks.flightState.computeFlightStatus = vi.fn(() => "active" as const);
    mocks.memoryState.events = [];
  });

  it("renders a single Cost cell (no Planner/Exec split)", () => {
    const flight = makeFlight({ totalCost: 1.5, totalTokens: 50_000 });
    mocks.flightState.flights = [flight];
    mocks.flightState.activeFlightId = flight.id;

    renderView();

    expect(screen.getByText("Cost")).toBeInTheDocument();
    expect(screen.queryByText("Planner")).not.toBeInTheDocument();
    expect(screen.queryByText("Exec")).not.toBeInTheDocument();
  });

  it("shows the flight's totalCost in the Cost cell", () => {
    const flight = makeFlight({ totalCost: 1.5, totalTokens: 50_000 });
    mocks.flightState.flights = [flight];
    mocks.flightState.activeFlightId = flight.id;

    renderView();

    expect(valueInCell(statCell("Cost"))).toBe("$1.50");
  });

  it("treats a missing totalCost as zero", () => {
    const flight = makeFlight({ totalTokens: 50_000 });
    delete (flight as Partial<Flight>).totalCost;
    mocks.flightState.flights = [flight];
    mocks.flightState.activeFlightId = flight.id;

    renderView();

    expect(valueInCell(statCell("Cost"))).toBe("$0.00");
  });

  it("keeps the Tokens cell as the cumulative flight total", () => {
    const flight = makeFlight({ totalCost: 1.5, totalTokens: 50_000 });
    mocks.flightState.flights = [flight];
    mocks.flightState.activeFlightId = flight.id;

    renderView();

    // formatTokens(50_000) -> "50.0k"
    expect(valueInCell(statCell("Tokens"))).toBe("50.0k");
  });

  it("renders legacy 'spec'-status flights as a normal overview (no crash, no planner FSM UI)", () => {
    // Flights persisted before the Spec FSM was cut may still carry
    // status "spec" — the detail pane must fall through to the normal
    // overview rather than mount the retired FlightSpecPane.
    const flight = makeFlight({ status: "spec", totalCost: 0, totalTokens: 0 });
    mocks.flightState.flights = [flight];
    mocks.flightState.activeFlightId = flight.id;
    mocks.flightState.computeFlightStatus = vi.fn(() => "spec" as const);

    renderView();

    expect(screen.getAllByText("spec").length).toBeGreaterThan(0);
    expect(screen.getByText("Cost")).toBeInTheDocument();
    expect(screen.getByTestId("mock-async-flight-grid")).toBeInTheDocument();
  });

  it("mounts the async attempt grid on the flight detail overview", () => {
    const flight = makeFlight();
    mocks.flightState.flights = [flight];
    mocks.flightState.activeFlightId = flight.id;

    renderView();

    expect(screen.getByTestId("mock-async-flight-grid")).toBeInTheDocument();
  });

  it("shows the empty state with a New flight action when there are no flights", () => {
    mocks.flightState.flights = [];
    mocks.flightState.activeFlightId = null;

    renderView();

    expect(screen.getByText("No flights yet")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /new flight/i })).toBeInTheDocument();
  });
});
