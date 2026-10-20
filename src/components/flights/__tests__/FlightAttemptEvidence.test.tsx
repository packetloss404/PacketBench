import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { FlightAttemptEvidence } from "../FlightAttemptEvidence";
import { useServerStore } from "@/stores/serverStore";
import type { AgentConversation } from "@/types/agent-conversation";
import type { Attempt } from "@/types/flight";

const mocks = vi.hoisted(() => ({ load: vi.fn() }));
vi.mock("@/lib/tauri", async (original) => ({
  ...(await original<typeof import("@/lib/tauri")>()),
  getGitReviewEvidence: (...args: unknown[]) => mocks.load(...args),
}));
function attempt(patch: Partial<Attempt> = {}): Attempt {
  return {
    id: "a1",
    flightId: "f1",
    target: { kind: "local", basePath: "/repo", worktreePath: "/repo/worktree" },
    agentConfigId: "api-sugar",
    provider: "openai",
    model: "model",
    branch: "pkt/a1",
    baseBranch: "main",
    sessionId: "s1",
    status: "reviewing",
    cost: 0,
    tokens: 0,
    ...patch,
  };
}
beforeEach(() => {
  mocks.load.mockReset();
  useServerStore.setState({ servers: [] });
  mocks.load.mockResolvedValue({
    baseRef: "base-sha",
    headRef: "head-sha",
    changedPaths: ["src/fix.ts"],
    patch: "-old\n+new",
    diffSummary: "1 file",
    patchTruncated: false,
  });
});
describe("Flight result evidence", () => {
  it("shows changed files and diff beside clearly attributed builder check results", async () => {
    const conversation = {
      messages: [
        {
          role: "assistant",
          content: "",
          toolCalls: [
            { id: "check", name: "bash", input: "pnpm test", status: "done", summary: "2 passed" },
          ],
        },
      ],
    } as AgentConversation;
    render(<FlightAttemptEvidence attempt={attempt()} conversation={conversation} />);
    expect(await screen.findByText("src/fix.ts")).toBeInTheDocument();
    expect(screen.getByLabelText("Code diff")).toHaveTextContent("+new");
    expect(screen.getByText(/not independently executed/i)).toBeInTheDocument();
    expect(screen.getByText("2 passed")).toBeInTheDocument();
    expect(mocks.load).toHaveBeenCalledWith("/repo/worktree", "main", null, 65_536, undefined);
  });
  it("inspects accepted evidence from the base repo and pinned commits after worktree removal", async () => {
    render(
      <FlightAttemptEvidence
        attempt={attempt({
          status: "completed",
          reviewGate: {
            status: "passed",
            evidence: {
              fingerprint: "f",
              contextFingerprint: "c",
              baseSha: "review-base",
              headSha: "review-head",
            },
          },
        })}
      />,
    );
    await screen.findByText("src/fix.ts");
    expect(mocks.load).toHaveBeenCalledWith("/repo", "review-base", null, 65_536, "review-head");
  });
  it.each(["failed", "cancelled"] as const)(
    "inspects the retained branch after a legacy %s worktree was cleaned",
    async (status) => {
      render(<FlightAttemptEvidence attempt={attempt({ status })} />);
      await screen.findByText("src/fix.ts");
      expect(mocks.load).toHaveBeenCalledWith("/repo", "main", null, 65_536, "pkt/a1");
    },
  );
  it("includes current dirty preserved work instead of showing only an older reviewed commit", async () => {
    render(
      <FlightAttemptEvidence
        attempt={attempt({
          status: "cancelled",
          recovery: { state: "retained", retainedAt: 1, reason: "Stopped" },
          reviewGate: {
            status: "passed",
            evidence: {
              fingerprint: "f",
              contextFingerprint: "c",
              baseSha: "review-base",
              headSha: "old-reviewed-head",
            },
          },
        })}
      />,
    );
    await screen.findByText("src/fix.ts");
    expect(mocks.load).toHaveBeenCalledWith(
      "/repo/worktree",
      "review-base",
      null,
      65_536,
      undefined,
    );
    expect(screen.getByText(/including uncommitted changes/)).toBeInTheDocument();
  });
  it("keeps unavailable evidence explicit and provides retry without asserting readiness", async () => {
    mocks.load.mockRejectedValueOnce(new Error("Remote host unavailable"));
    render(<FlightAttemptEvidence attempt={attempt()} />);
    expect(await screen.findByRole("alert")).toHaveTextContent("Remote host unavailable");
    fireEvent.click(screen.getByRole("button", { name: "Refresh changes" }));
    expect(await screen.findByText("src/fix.ts")).toBeInTheDocument();
    expect(mocks.load).toHaveBeenCalledTimes(2);
  });
  it("refuses to inspect remote code through an unavailable or unpinned host", async () => {
    render(
      <FlightAttemptEvidence
        attempt={attempt({
          target: {
            kind: "ssh",
            serverId: "missing",
            basePath: "/srv/repo",
            worktreePath: "/srv/wt",
          },
        })}
      />,
    );
    expect(await screen.findByRole("alert")).toHaveTextContent("available and verified");
    expect(mocks.load).not.toHaveBeenCalled();
  });
  it("does not let a slow evidence read replace a newly selected attempt", async () => {
    let finish: (value: unknown) => void = () => {};
    mocks.load.mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    const view = render(<FlightAttemptEvidence attempt={attempt()} />);
    view.rerender(<FlightAttemptEvidence attempt={attempt({ id: "a2", branch: "pkt/a2" })} />);
    await screen.findByText("src/fix.ts");
    finish({
      changedPaths: ["stale.ts"],
      baseRef: "old",
      headRef: "old",
      patch: "old",
      patchTruncated: false,
    });
    await waitFor(() => expect(screen.queryByText("stale.ts")).not.toBeInTheDocument());
  });
});
