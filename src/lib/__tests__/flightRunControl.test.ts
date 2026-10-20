import { describe, expect, it } from "vitest";
import {
  drainFlightStartups,
  registerFlightStartup,
  revokeFlightStarts,
} from "@/lib/flightRunControl";

describe("Flight startup drain", () => {
  it("revokes every admitted startup and drains until its finally has run", async () => {
    const first = registerFlightStartup("stop-and-drain");
    const reviewer = registerFlightStartup("stop-and-drain");
    revokeFlightStarts("stop-and-drain");
    expect(first.isCurrent()).toBe(false);
    expect(reviewer.isCurrent()).toBe(false);
    let drained = false;
    const wait = drainFlightStartups("stop-and-drain").then(() => {
      drained = true;
    });
    first.finish();
    await Promise.resolve();
    expect(drained).toBe(false);
    reviewer.finish();
    reviewer.finish();
    await wait;
    expect(drained).toBe(true);
    const newRun = registerFlightStartup("stop-and-drain");
    expect(newRun.isCurrent()).toBe(true);
    newRun.finish();
  });
});
