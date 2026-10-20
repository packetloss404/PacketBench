import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { AsyncFlightGrid } from "../AsyncFlightGrid";
import type { Flight } from "@/types/flight";
vi.mock("../AttemptTile", () => ({ AttemptTile: () => <div>Existing result</div> }));
describe("Flight continuation", () => {
  it.each(["failed", "cancelled", "completed"])(
    "keeps New attempt available after a %s attempt",
    (status) => {
      const launch = vi.fn();
      render(
        <AsyncFlightGrid
          flight={{ attempts: [{ id: "a1", status }] } as Flight}
          onLaunch={launch}
        />,
      );
      fireEvent.click(screen.getByRole("button", { name: "New attempt" }));
      expect(launch).toHaveBeenCalledOnce();
      expect(screen.getByText("Existing result")).toBeInTheDocument();
    },
  );
});
