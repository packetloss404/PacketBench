import { beforeEach, describe, expect, it } from "vitest";
import { useAgentLaunchStore } from "@/stores/agentLaunchStore";

const store = () => useAgentLaunchStore.getState();

beforeEach(() => {
  useAgentLaunchStore.setState({
    launch: { phase: "idle", revision: 0, activeRevision: null, error: null },
  });
});

describe("agentLaunchStore (F4)", () => {
  it("refuses a duplicate begin for the same revision while in flight", () => {
    expect(store().begin(0)).toBe(true);
    expect(store().begin(0)).toBe(false);
    expect(store().launch.phase).toBe("preparing");
  });

  it("admits a begin after an explicit revision bump", () => {
    expect(store().begin(0)).toBe(true);
    const revision = store().bumpRevision();
    expect(revision).toBe(1);
    expect(store().begin(revision)).toBe(true);
  });

  it("admits a fresh begin after a failed phase", () => {
    store().begin(0);
    store().setPhase("failed", "boom");
    expect(store().begin(0)).toBe(true);
  });

  it("reset returns to idle so the composer is usable again", () => {
    store().begin(0);
    store().reset();
    expect(store().launch.phase).toBe("idle");
    expect(store().begin(0)).toBe(true);
  });

  it("tracks the phase and error", () => {
    store().begin(0);
    store().setPhase("cancelling");
    expect(store().launch.phase).toBe("cancelling");
    store().setPhase("unknown", "no acknowledgement");
    expect(store().launch.phase).toBe("unknown");
    expect(store().launch.error).toBe("no acknowledgement");
  });
});
