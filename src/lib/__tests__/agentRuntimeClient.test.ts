import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  canonicalJson,
  computeRequestDigest,
  prepareRuntimeLaunch,
} from "@/lib/agentRuntimeClient";

const prepareRuntimeRun = vi.fn();
const getRuntimeLaunch = vi.fn();
const getRuntimeRun = vi.fn();
const listRuntimeEvents = vi.fn();
const cancelRuntimeRun = vi.fn();

vi.mock("@/lib/tauri", () => ({
  prepareRuntimeRun: (...args: unknown[]) => prepareRuntimeRun(...args),
  getRuntimeLaunch: (...args: unknown[]) => getRuntimeLaunch(...args),
  getRuntimeRun: (...args: unknown[]) => getRuntimeRun(...args),
  listRuntimeEvents: (...args: unknown[]) => listRuntimeEvents(...args),
  cancelRuntimeRun: (...args: unknown[]) => cancelRuntimeRun(...args),
}));

const launch = {
  route: "anthropic",
  model: "claude",
  requestedIsolation: "checkout",
  draftId: "draft-1",
  draftRevision: "rev-1",
  projectKey: "local:D:/proj",
  basePath: "D:/proj",
};

describe("agentRuntimeClient", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prepareRuntimeRun.mockResolvedValue({
      operationId: "op-1",
      conversationId: "conv-1",
      runId: "run-1",
      epoch: 0,
      phase: "prepared",
      created: true,
    });
  });

  it("canonicalizes JSON with sorted keys regardless of input order", () => {
    expect(canonicalJson({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
    expect(canonicalJson({ a: { d: 1, c: [2, 1] } })).toBe('{"a":{"c":[2,1],"d":1}}');
    expect(canonicalJson({ a: undefined, b: 1 })).toBe('{"b":1}');
  });

  it("computes a stable sha256 digest of the canonical payload", async () => {
    const digest = await computeRequestDigest({ b: 1, a: 2 });
    expect(digest).toMatch(/^sha256:[0-9a-f]{64}$/);
    const again = await computeRequestDigest({ a: 2, b: 1 });
    expect(again).toBe(digest);
  });

  it("prepares with the computed digest and forwards to the backend", async () => {
    const result = await prepareRuntimeLaunch({
      operationId: "op-1",
      conversationId: "conv-1",
      kind: "initial",
      launch,
    });

    expect(prepareRuntimeRun).toHaveBeenCalledTimes(1);
    const input = prepareRuntimeRun.mock.calls[0][0] as { requestDigest: string };
    expect(input.requestDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(result.runId).toBe("run-1");
  });

  it("produces a different digest when the launch payload changes", async () => {
    const a = await computeRequestDigest({ launch });
    const b = await computeRequestDigest({ launch: { ...launch, model: "gpt" } });
    expect(a).not.toBe(b);
  });
});
