/**
 * F2 follow-ons in the launch modal:
 *  - the publish-as-draft-PR checkbox must seed from the FLIGHT, not the global
 *    default. It seeded from the default while `createOrUpdateFlight` wrote it
 *    back, so re-opening the modal to add an attempt silently rewrote the
 *    flight's publish setting — and the accept-time publish then never ran.
 *  - a multi-target launch that fails partway must say how many agents are
 *    nonetheless live and spending.
 */
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/tauri", async (importActual) => {
  const actual = await importActual<typeof import("@/lib/tauri")>();
  return { ...actual, listOllamaModels: vi.fn().mockResolvedValue([]) };
});

import { LaunchAsyncFlightModal } from "@/components/flights/LaunchAsyncFlightModal";
import { resolveInitialPublishAsPrs, summarizeLaunchOutcome } from "@/lib/flightLaunch";
import { useFlightStore } from "@/stores/flightStore";
import { useGitHubStore } from "@/stores/githubStore";
import type { Flight } from "@/types/flight";

function makeFlight(overrides: Partial<Flight> = {}): Flight {
  const now = Date.now();
  return {
    id: "flight-publish",
    title: "Publish flag flight",
    objective: "Do the thing",
    status: "ready",
    priority: "medium",
    projectPath: "/repo",
    workspaceId: null,
    milestones: [],
    linkedSessionIds: [],
    issueIds: [],
    createdAt: now,
    updatedAt: now,
    totalCost: 0,
    totalTokens: 0,
    ...overrides,
  };
}

function seedFlight(flight: Flight) {
  useFlightStore.setState({ flights: [flight] });
}

function publishCheckbox(): HTMLInputElement {
  const options = screen.getByRole("button", { name: /Execution options/ });
  if (options.getAttribute("aria-expanded") === "false") fireEvent.click(options);
  return screen
    .getByText("Publish attempts as draft PRs")
    .closest("label")!
    .querySelector("input[type=checkbox]") as HTMLInputElement;
}

beforeEach(() => {
  useFlightStore.setState({ flights: [] });
  useGitHubStore.setState((state) => ({ ...state, defaultPublishAttemptsAsPrs: false }));
});

describe("resolveInitialPublishAsPrs", () => {
  it("prefers the flight's own setting over the global default", () => {
    expect(resolveInitialPublishAsPrs({ publishAttemptsAsPrs: true }, false)).toBe(true);
    expect(resolveInitialPublishAsPrs({ publishAttemptsAsPrs: false }, true)).toBe(false);
  });

  it("falls back to the global default only when the flight has no setting", () => {
    expect(resolveInitialPublishAsPrs({}, true)).toBe(true);
    expect(resolveInitialPublishAsPrs(null, true)).toBe(true);
    expect(resolveInitialPublishAsPrs(undefined, false)).toBe(false);
  });
});

describe("LaunchAsyncFlightModal publish flag", () => {
  it("re-opening a publishing flight keeps the checkbox ticked", () => {
    seedFlight(makeFlight({ publishAttemptsAsPrs: true }));
    render(<LaunchAsyncFlightModal onClose={() => {}} flightId="flight-publish" />);

    expect(publishCheckbox().checked).toBe(true);
  });

  it("re-opening a non-publishing flight does not inherit the global default", () => {
    useGitHubStore.setState((state) => ({ ...state, defaultPublishAttemptsAsPrs: true }));
    seedFlight(makeFlight({ publishAttemptsAsPrs: false }));
    render(<LaunchAsyncFlightModal onClose={() => {}} flightId="flight-publish" />);

    expect(publishCheckbox().checked).toBe(false);
  });

  it("a brand-new flight still uses the global default", () => {
    useGitHubStore.setState((state) => ({ ...state, defaultPublishAttemptsAsPrs: true }));
    render(<LaunchAsyncFlightModal onClose={() => {}} />);

    expect(publishCheckbox().checked).toBe(true);
  });
});

describe("summarizeLaunchOutcome", () => {
  it("reports a total failure as the raw error", () => {
    expect(summarizeLaunchOutcome(0, 3, "ssh: connection refused")).toEqual({
      text: "ssh: connection refused",
      partial: false,
    });
  });

  it("says how many agents are live when only some targets came up", () => {
    const outcome = summarizeLaunchOutcome(2, 3, "ssh: connection refused");
    expect(outcome.partial).toBe(true);
    expect(outcome.text).toBe(
      "2 of 3 agents are running — the rest failed to launch: ssh: connection refused",
    );
  });

  it("uses singular wording for a single survivor", () => {
    expect(summarizeLaunchOutcome(1, 2, "boom").text).toBe(
      "1 of 2 agent is running — the rest failed to launch: boom",
    );
  });
});
