import { beforeEach, describe, expect, it, vi } from "vitest";
import { resumeConversationRun } from "@/lib/runtimeRecovery";
import type { RuntimeRunSummary } from "@/generated/tauri-schema";

const inspectMock = vi.hoisted(() => vi.fn());
const resumeMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/tauri", () => ({
  inspectRuntimeResume: inspectMock,
  resumeRuntimeRun: resumeMock,
}));

function run(overrides: Partial<RuntimeRunSummary> = {}): RuntimeRunSummary {
  return {
    version: 1,
    runtimeRunId: "run-1",
    conversationId: "conv-1",
    operationId: "op-1",
    epoch: 3,
    state: "needs_reconciliation",
    resumeMode: "none",
    latestDurableSeq: 0,
    ...overrides,
  } as RuntimeRunSummary;
}

beforeEach(() => {
  inspectMock.mockReset();
  resumeMock.mockReset();
});

describe("resumeConversationRun (R1/R3)", () => {
  it("prefers a typed resume and echoes the inspected revision", async () => {
    inspectMock.mockResolvedValue({
      permittedModes: ["typed", "semantic"],
      inspectedRevision: "ckpt-1",
      incompatibilities: [],
    });
    resumeMock.mockResolvedValue(run({ state: "prepared", resumeMode: "typed" }));

    const result = await resumeConversationRun(run());

    expect(resumeMock).toHaveBeenCalledWith("run-1", 3, "typed", "ckpt-1");
    expect(result.resumeMode).toBe("typed");
  });

  it("falls back to a semantic resume with no revision token", async () => {
    inspectMock.mockResolvedValue({
      permittedModes: ["semantic"],
      inspectedRevision: "ckpt-1",
      incompatibilities: [],
    });
    resumeMock.mockResolvedValue(run({ state: "prepared", resumeMode: "semantic" }));

    await resumeConversationRun(run());

    expect(resumeMock).toHaveBeenCalledWith("run-1", 3, "semantic", null);
  });

  it("throws with the backend incompatibilities when no mode is permitted", async () => {
    inspectMock.mockResolvedValue({
      permittedModes: [],
      inspectedRevision: null,
      incompatibilities: ["run is terminal"],
    });

    await expect(resumeConversationRun(run())).rejects.toThrow("run is terminal");
    expect(resumeMock).not.toHaveBeenCalled();
  });
});
