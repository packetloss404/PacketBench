/**
 * Accept verifies clean committed work before non-force cleanup; Reject
 * retains work until a separate Discard. Confirmations describe those outcomes,
 * and accepted local/SSH results can be delivered through Land or Open PR.
 */
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  setAttemptStatus: vi.fn(),
  landAttempt: vi.fn(),
  publishAttemptPr: vi.fn(),
  cancelAttempt: vi.fn(),
  stopFlight: vi.fn(),
  inspectAttemptWorktree: vi.fn(),
  resumeRetainedAttempt: vi.fn(),
  discardRetainedWorktree: vi.fn(),
  sendReviewFindingsToBuilder: vi.fn(),
}));

vi.mock("@/stores/asyncFlightStore", async (importActual) => {
  const actual = await importActual<typeof import("@/stores/asyncFlightStore")>();
  const state = {
    setAttemptStatus: mocks.setAttemptStatus,
    landAttempt: mocks.landAttempt,
    publishAttemptPr: mocks.publishAttemptPr,
    cancelAttempt: mocks.cancelAttempt,
    stopFlight: mocks.stopFlight,
    retryReviewGate: vi.fn(),
    overrideReviewGate: vi.fn(),
    sendReviewFindingsToBuilder: mocks.sendReviewFindingsToBuilder,
    resumeRetainedAttempt: mocks.resumeRetainedAttempt,
    discardRetainedWorktree: mocks.discardRetainedWorktree,
  };
  return {
    ...actual,
    inspectAttemptWorktree: (...args: unknown[]) => mocks.inspectAttemptWorktree(...args),
    useAsyncFlightStore: (selector: (s: typeof state) => unknown) => selector(state),
  };
});

import { AttemptTile } from "@/components/flights/AttemptTile";
import { describeAttemptDecisionImpact, attemptLandability } from "@/stores/asyncFlightStore";
import type { Attempt, Flight } from "@/types/flight";
import { useServerStore } from "@/stores/serverStore";
import type { ServerConfig } from "@/types/server";
import { useAgentTaskStore } from "@/stores/agentTaskStore";
import type { AgentConversation } from "@/types/agent-conversation";

const SERVER: ServerConfig = {
  id: "srv-1",
  name: "Build host",
  host: "build.example.test",
  port: 2222,
  username: "developer",
  authMethod: "key",
  hostFingerprint: "SHA256:pinned",
  installedAgents: [],
};

function makeFlight(overrides: Partial<Flight> = {}): Flight {
  const now = Date.now();
  return {
    id: "flight-1",
    title: "Ship the thing",
    objective: "Ship it",
    status: "review",
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

function makeAttempt(overrides: Partial<Attempt> = {}): Attempt {
  return {
    id: "attempt-1",
    flightId: "flight-1",
    target: { kind: "local", basePath: "/repo", worktreePath: "/repo/.pkt-worktrees/attempt-1" },
    agentConfigId: "api-claude",
    model: "claude-sonnet-5",
    provider: "anthropic",
    branch: "pkt/attempt-1",
    baseBranch: "main",
    sessionId: "session-1",
    status: "reviewing",
    cost: 0,
    tokens: 0,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  useServerStore.setState({ servers: [SERVER] });
  mocks.inspectAttemptWorktree.mockResolvedValue("clean");
  mocks.setAttemptStatus.mockResolvedValue(undefined);
  mocks.landAttempt.mockResolvedValue({ landed: true, commitSha: "abc1234def", message: "" });
  mocks.publishAttemptPr.mockResolvedValue(undefined);
  mocks.stopFlight.mockResolvedValue(undefined);
  mocks.resumeRetainedAttempt.mockResolvedValue(undefined);
  mocks.discardRetainedWorktree.mockResolvedValue(undefined);
  mocks.sendReviewFindingsToBuilder.mockResolvedValue(undefined);
  useAgentTaskStore.setState({ conversations: [] });
});

describe("AttemptTile dispatch errors", () => {
  it("disables reviewer retries while the builder is active and enables them after completion", () => {
    useAgentTaskStore.setState({
      conversations: [
        {
          id: "session-1",
          mode: "api",
          status: "active",
          messages: [{ role: "assistant", content: "Working", isStreaming: true }],
        } as unknown as AgentConversation,
      ],
    });
    const flight = makeFlight({
      reviewGatePolicy: {
        enabled: true,
        reviewerAgentConfigId: "api-openai",
        acceptanceCriteria: [],
      },
    });
    const attempt = makeAttempt({
      reviewGate: { status: "error", errorMessage: "Repair requires a fresh review" },
    });
    const view = render(<AttemptTile flight={flight} attempt={attempt} />);
    expect(screen.getByRole("button", { name: "Retry reviewer" })).toBeDisabled();
    act(() =>
      useAgentTaskStore.setState({
        conversations: [
          {
            id: "session-1",
            mode: "api",
            status: "idle",
            messages: [],
          } as unknown as AgentConversation,
        ],
      }),
    );
    view.rerender(<AttemptTile flight={flight} attempt={attempt} />);
    expect(screen.getByRole("button", { name: "Retry reviewer" })).toBeEnabled();
  });
  it("retains the follow-up and shows the native dispatch error", async () => {
    useAgentTaskStore.setState({
      conversations: [
        {
          id: "session-1",
          mode: "api",
          status: "idle",
          messages: [],
        } as unknown as AgentConversation,
      ],
    });
    const receipt = vi
      .spyOn(useAgentTaskStore.getState(), "sendMessageWithReceipt")
      .mockRejectedValueOnce(new Error("provider rejected follow-up"));
    render(<AttemptTile flight={makeFlight()} attempt={makeAttempt()} />);
    fireEvent.change(screen.getByLabelText("Follow up with the builder"), {
      target: { value: "Please fix this" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    expect(await screen.findByText("provider rejected follow-up")).toBeInTheDocument();
    expect(screen.getByLabelText("Follow up with the builder")).toHaveValue("Please fix this");
    expect(receipt).toHaveBeenCalledWith("session-1", "Please fix this", undefined, {
      requireIdle: true,
    });
    receipt.mockRestore();
  });

  it("shows a rejected repair dispatch without claiming the findings were sent", async () => {
    mocks.sendReviewFindingsToBuilder.mockRejectedValueOnce(new Error("repair permission denied"));
    render(
      <AttemptTile
        flight={makeFlight({
          reviewGatePolicy: {
            enabled: true,
            reviewerAgentConfigId: "api-openai",
            acceptanceCriteria: [],
          },
        })}
        attempt={makeAttempt({
          reviewGate: {
            status: "changes_requested",
            report: {
              schemaVersion: 1,
              verdict: "changes_requested",
              summary: "Fix",
              findings: [],
              evidence: [],
            },
          },
        })}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /send findings/i }));
    expect(await screen.findByText("repair permission denied")).toBeInTheDocument();
  });
});

describe("AttemptTile accept/reject confirmation", () => {
  it("does not settle the attempt when Accept is clicked — it opens a confirm first", async () => {
    render(<AttemptTile flight={makeFlight()} attempt={makeAttempt()} />);

    fireEvent.click(screen.getByRole("button", { name: /accept/i }));

    expect(mocks.setAttemptStatus).not.toHaveBeenCalled();
    expect(await screen.findByText("Accept this attempt?")).toBeInTheDocument();
    await waitFor(() => expect(mocks.inspectAttemptWorktree).toHaveBeenCalled());
  });

  it("settles as completed only from the confirm button", async () => {
    render(<AttemptTile flight={makeFlight()} attempt={makeAttempt()} />);

    fireEvent.click(screen.getByRole("button", { name: /accept/i }));
    const confirm = await screen.findByRole("button", { name: "Accept attempt" });
    fireEvent.click(confirm);

    await waitFor(() =>
      expect(mocks.setAttemptStatus).toHaveBeenCalledWith("flight-1", "attempt-1", "completed"),
    );
  });

  it("settles as failed only from the Reject confirm button", async () => {
    render(<AttemptTile flight={makeFlight()} attempt={makeAttempt()} />);

    fireEvent.click(screen.getByRole("button", { name: /reject/i }));
    expect(mocks.setAttemptStatus).not.toHaveBeenCalled();
    expect(await screen.findByText("Reject this attempt?")).toBeInTheDocument();
    expect(screen.getByRole("dialog")).toHaveTextContent("Its worktree and branch are retained");
    expect(screen.getByRole("dialog")).toHaveTextContent("separate Discard confirmation");
    expect(screen.getByRole("dialog")).not.toHaveTextContent("force-removed");

    fireEvent.click(screen.getByRole("button", { name: "Reject attempt" }));
    await waitFor(() =>
      expect(mocks.setAttemptStatus).toHaveBeenCalledWith("flight-1", "attempt-1", "failed"),
    );
  });

  it("backing out of the confirm mutates nothing", async () => {
    render(<AttemptTile flight={makeFlight()} attempt={makeAttempt()} />);

    fireEvent.click(screen.getByRole("button", { name: /accept/i }));
    await screen.findByText("Accept this attempt?");
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    await waitFor(() => expect(screen.queryByText("Accept this attempt?")).not.toBeInTheDocument());
    expect(mocks.setAttemptStatus).not.toHaveBeenCalled();
  });

  it("renders as a labelled modal dialog and backs out on Escape", async () => {
    render(<AttemptTile flight={makeFlight()} attempt={makeAttempt()} />);

    fireEvent.click(screen.getByRole("button", { name: /accept/i }));
    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(dialog).toHaveAccessibleName("Accept this attempt?");

    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(mocks.setAttemptStatus).not.toHaveBeenCalled();
  });

  it("explains that dirty work must be committed and refusal preserves files", async () => {
    mocks.inspectAttemptWorktree.mockResolvedValue("dirty");
    render(<AttemptTile flight={makeFlight()} attempt={makeAttempt()} />);

    fireEvent.click(screen.getByRole("button", { name: /accept/i }));

    expect(await screen.findByText(/uncommitted or untracked files/i)).toBeInTheDocument();
    expect(screen.getByText(/Refusal retains your files and branch/i)).toBeInTheDocument();
    expect(screen.getByText(/uses non-force removal/i)).toBeInTheDocument();
    expect(screen.queryByText(/is force-removed/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/they are destroyed/i)).not.toBeInTheDocument();
    expect(screen.getByText(/is kept — use Land or Open PR/i)).toBeInTheDocument();
  });

  it("reports a backend refusal to accept dirty work without presenting a successful acceptance", async () => {
    mocks.inspectAttemptWorktree.mockResolvedValue("dirty");
    mocks.setAttemptStatus.mockRejectedValue(
      new Error("Cannot accept: commit the intended changes; worktree retained."),
    );
    render(<AttemptTile flight={makeFlight()} attempt={makeAttempt()} />);
    fireEvent.click(screen.getByRole("button", { name: /^Accept$/ }));
    fireEvent.click(await screen.findByRole("button", { name: "Accept attempt" }));
    expect(
      await screen.findByText(/Cannot accept: commit the intended changes; worktree retained/),
    ).toBeInTheDocument();
    expect(screen.queryByText(/Accepted\. Deliver this branch/)).not.toBeInTheDocument();
    expect(mocks.landAttempt).not.toHaveBeenCalled();
  });

  it("explains that Reject retains dirty files until a separate Discard", async () => {
    mocks.inspectAttemptWorktree.mockResolvedValue("dirty");
    render(<AttemptTile flight={makeFlight()} attempt={makeAttempt()} />);
    fireEvent.click(screen.getByRole("button", { name: /^Reject$/ }));
    expect(
      await screen.findByText(/Uncommitted and untracked files are kept/i),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/Discard preserved work with a separate confirmation/i),
    ).toBeInTheDocument();
    expect(screen.queryByText(/they are destroyed/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/is force-removed/i)).not.toBeInTheDocument();
    expect(mocks.setAttemptStatus).not.toHaveBeenCalled();
  });

  it("shows the probe as still running rather than an empty consequence list", async () => {
    mocks.inspectAttemptWorktree.mockReturnValue(new Promise(() => {}));
    render(<AttemptTile flight={makeFlight()} attempt={makeAttempt()} />);

    fireEvent.click(screen.getByRole("button", { name: /reject/i }));

    expect(await screen.findByText(/Checking this attempt's worktree/i)).toBeInTheDocument();
  });

  it("keeps the reviewer gate as the Accept gate", () => {
    const flight = makeFlight({
      reviewGatePolicy: {
        enabled: true,
        reviewerAgentConfigId: "api-openai-agents",
        reviewerModel: "gpt-5",
        acceptanceCriteria: ["tests pass"],
      },
    });
    render(<AttemptTile flight={flight} attempt={makeAttempt()} />);

    expect(screen.getByRole("button", { name: /accept/i })).toBeDisabled();
  });
});

describe("AttemptTile land / open PR", () => {
  it("shows persisted delivery after remount rather than offering to land it again", () => {
    render(
      <AttemptTile
        flight={makeFlight()}
        attempt={makeAttempt({
          status: "completed",
          delivery: {
            kind: "landed",
            deliveredAt: 123,
            branch: "pkt/attempt-1",
            baseBranch: "main",
            commitSha: "abc1234def",
          },
        })}
      />,
    );
    expect(screen.getByText("Landed into main as abc1234def.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^land$/i })).not.toBeInTheDocument();
  });

  it("prevents double publication while a PR request is pending", async () => {
    let finish: () => void = () => {};
    mocks.publishAttemptPr.mockReturnValue(
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
    );
    render(<AttemptTile flight={makeFlight()} attempt={makeAttempt({ status: "completed" })} />);
    const publish = screen.getByRole("button", { name: "Open PR" });
    fireEvent.click(publish);
    fireEvent.click(publish);
    expect(mocks.publishAttemptPr).toHaveBeenCalledOnce();
    expect(publish).toBeDisabled();
    finish();
    await waitFor(() => expect(publish).toBeEnabled());
  });
  it("offers Land and Open PR once the attempt is accepted", () => {
    render(<AttemptTile flight={makeFlight()} attempt={makeAttempt({ status: "completed" })} />);

    expect(screen.getByRole("button", { name: /land/i })).toBeEnabled();
    expect(screen.getByRole("button", { name: /open pr/i })).toBeEnabled();
  });

  it("offers neither while the attempt is still under review", () => {
    render(<AttemptTile flight={makeFlight()} attempt={makeAttempt()} />);

    expect(screen.queryByRole("button", { name: /^land$/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /open pr/i })).not.toBeInTheDocument();
  });

  it("lands the accepted branch and reports the resulting commit", async () => {
    mocks.landAttempt.mockResolvedValue({
      landed: true,
      commitSha: "abc1234def",
      message: "Landed pkt/attempt-1 as abc1234.",
    });
    render(<AttemptTile flight={makeFlight()} attempt={makeAttempt({ status: "completed" })} />);

    fireEvent.click(screen.getByRole("button", { name: /land/i }));

    await waitFor(() => expect(mocks.landAttempt).toHaveBeenCalledWith("flight-1", "attempt-1"));
    expect(await screen.findByText("Landed pkt/attempt-1 as abc1234.")).toBeInTheDocument();
  });

  it("reports an empty branch as a failure, not as a landing", async () => {
    mocks.landAttempt.mockResolvedValue({
      landed: false,
      message: "Nothing to land — pkt/attempt-1 has no commits the checkout doesn't already have.",
    });
    render(<AttemptTile flight={makeFlight()} attempt={makeAttempt({ status: "completed" })} />);

    fireEvent.click(screen.getByRole("button", { name: /land/i }));

    expect(await screen.findByText(/Nothing to land/i)).toHaveClass("text-accent-red");
  });

  it("surfaces a refused land instead of claiming success", async () => {
    mocks.landAttempt.mockRejectedValue(
      new Error("Cannot land: the root checkout has 2 uncommitted change(s)."),
    );
    render(<AttemptTile flight={makeFlight()} attempt={makeAttempt({ status: "completed" })} />);

    fireEvent.click(screen.getByRole("button", { name: /land/i }));

    expect(await screen.findByText(/root checkout has 2 uncommitted/i)).toBeInTheDocument();
  });

  it("opens a draft PR on demand and can record delivery for an existing PR", async () => {
    const { unmount } = render(
      <AttemptTile flight={makeFlight()} attempt={makeAttempt({ status: "completed" })} />,
    );
    fireEvent.click(screen.getByRole("button", { name: /open pr/i }));
    await waitFor(() =>
      expect(mocks.publishAttemptPr).toHaveBeenCalledWith("flight-1", "attempt-1"),
    );
    unmount();

    render(
      <AttemptTile
        flight={makeFlight()}
        attempt={makeAttempt({ status: "completed", draftPrNumber: 7 })}
      />,
    );
    const record = screen.getByRole("button", { name: "Record PR delivery" });
    expect(record).toBeEnabled();
    fireEvent.click(record);
    await waitFor(() => expect(mocks.publishAttemptPr).toHaveBeenCalledTimes(2));
  });

  it("lands an accepted SSH result on its saved host and exact base branch", async () => {
    const attempt = makeAttempt({
      status: "completed",
      baseBranch: "release/approved",
      target: { kind: "ssh", serverId: "srv-1", basePath: "/srv", worktreePath: "/srv/wt" },
    });
    render(<AttemptTile flight={makeFlight()} attempt={attempt} />);

    const land = screen.getByRole("button", { name: /^Land$/ });
    expect(land).toBeEnabled();
    expect(land).toHaveAttribute(
      "title",
      expect.stringContaining(
        "release/approved at /srv on Build host (developer@build.example.test:2222)",
      ),
    );
    fireEvent.click(land);
    await waitFor(() => expect(mocks.landAttempt).toHaveBeenCalledWith("flight-1", "attempt-1"));
  });
});

describe("AttemptTile preserved work", () => {
  it("stops all Flight work through the preserving action without cancelling and deleting an attempt", async () => {
    render(<AttemptTile flight={makeFlight()} attempt={makeAttempt({ status: "running" })} />);
    fireEvent.click(screen.getByRole("button", { name: "Stop Flight & retain work" }));
    await waitFor(() => expect(mocks.stopFlight).toHaveBeenCalledWith("flight-1"));
    expect(mocks.cancelAttempt).not.toHaveBeenCalled();
    expect(mocks.discardRetainedWorktree).not.toHaveBeenCalled();
  });
  it("requires confirmation naming the exact worktree before discard", async () => {
    render(
      <AttemptTile
        flight={makeFlight()}
        attempt={makeAttempt({
          status: "cancelled",
          recovery: { state: "retained", retainedAt: 1, reason: "Desktop restarted" },
        })}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Discard preserved work…" }));
    expect(mocks.discardRetainedWorktree).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog")).toHaveTextContent("/repo/.pkt-worktrees/attempt-1");
    fireEvent.click(screen.getByRole("button", { name: "Discard preserved work" }));
    await waitFor(() =>
      expect(mocks.discardRetainedWorktree).toHaveBeenCalledWith("flight-1", "attempt-1"),
    );
  });

  it("continues the preserved attempt rather than creating an unrelated Flight", async () => {
    render(
      <AttemptTile
        flight={makeFlight()}
        attempt={makeAttempt({
          status: "failed",
          recovery: { state: "retained", retainedAt: 1, reason: "Desktop restarted" },
        })}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Continue preserved work" }));
    await waitFor(() =>
      expect(mocks.resumeRetainedAttempt).toHaveBeenCalledWith("flight-1", "attempt-1"),
    );
  });
});

describe("describeAttemptDecisionImpact", () => {
  it("reports the probe as pending rather than as clean", () => {
    expect(describeAttemptDecisionImpact("accept", makeAttempt(), null)).toEqual([
      "Checking this attempt's worktree for uncommitted work…",
    ]);
  });

  it.each(["clean", "dirty", "unknown"] as const)(
    "states Reject retains a %s worktree until explicit Discard",
    (cleanliness) => {
      const lines = describeAttemptDecisionImpact("reject", makeAttempt(), cleanliness);
      expect(lines.join(" ")).toContain("/repo/.pkt-worktrees/attempt-1");
      expect(lines.join(" ")).toContain("branch pkt/attempt-1 are retained");
      expect(lines.join(" ")).toContain("Discard preserved work with a separate confirmation");
      expect(lines.join(" ")).not.toContain("force-removed");
      expect(lines.join(" ")).not.toContain("are destroyed");
    },
  );

  it("describes clean-only acceptance and non-force cleanup even after a clean probe", () => {
    const text = describeAttemptDecisionImpact("accept", makeAttempt(), "clean").join(" ");
    expect(text).toContain("committed changes and a clean worktree");
    expect(text).toContain("verifies this again");
    expect(text).toContain("non-force removal");
    expect(text).toContain("If cleanup is refused, the worktree and branch are retained");
    expect(text).not.toContain("force-removed");
  });

  it("mentions the draft PR only when the flight publishes and none exists yet", () => {
    const publishing = makeFlight({ publishAttemptsAsPrs: true });
    expect(
      describeAttemptDecisionImpact("accept", makeAttempt(), "clean", publishing).join(" "),
    ).toContain("draft PR");
    expect(
      describeAttemptDecisionImpact(
        "accept",
        makeAttempt({ draftPrNumber: 3 }),
        "clean",
        publishing,
      ).join(" "),
    ).not.toContain("draft PR");
    expect(
      describeAttemptDecisionImpact("accept", makeAttempt(), "clean", makeFlight()).join(" "),
    ).not.toContain("draft PR");
  });

  it("warns when the worktree could not be checked", () => {
    const text = describeAttemptDecisionImpact("accept", makeAttempt(), "unknown").join(" ");
    expect(text).toContain("could not be checked");
    expect(text).toContain("acceptance is refused and your files and branch are retained");
    expect(text).not.toContain("may be destroyed");
  });

  it("never promises an individual task PR for a cooperative Flight's legacy publishing flag", () => {
    const text = describeAttemptDecisionImpact(
      "accept",
      makeAttempt({ taskId: "task" }),
      "clean",
      makeFlight({ executionMode: "cooperative", publishAttemptsAsPrs: true }),
    ).join(" ");
    expect(text).toContain("combined Flight integration branch");
    expect(text).toContain("individual task PRs are not opened");
    expect(text).not.toContain("draft PR");
    expect(text).not.toContain("use Land or Open PR on this tile");
  });
});

describe("attemptLandability", () => {
  const ssh = () =>
    makeAttempt({
      status: "completed",
      baseBranch: "release/approved",
      target: {
        kind: "ssh",
        serverId: SERVER.id,
        basePath: "/srv/approved",
        worktreePath: "/srv/approved/wt",
      },
    });
  it.each(["queued", "provisioning", "running", "reviewing", "failed", "cancelled"] as const)(
    "refuses a %s result on either host until it is accepted",
    (status) => {
      expect(attemptLandability(makeAttempt({ status })).allowed).toBe(false);
      expect(attemptLandability({ ...ssh(), status }).allowed).toBe(false);
    },
  );
  it("refuses already delivered results on either host", () => {
    const delivery: NonNullable<Attempt["delivery"]> = {
      kind: "landed",
      deliveredAt: 1,
      branch: "pkt/attempt-1",
      baseBranch: "main",
    };
    expect(attemptLandability(makeAttempt({ status: "completed", delivery }))).toMatchObject({
      allowed: false,
      reason: expect.stringContaining("already been delivered"),
    });
    expect(attemptLandability({ ...ssh(), delivery }).allowed).toBe(false);
  });
  it("names the exact local base branch and path", () => {
    expect(attemptLandability(makeAttempt({ status: "completed", baseBranch: "develop" }))).toEqual(
      {
        allowed: true,
        reason: "Squash-merge pkt/attempt-1 into develop at /repo on this computer.",
      },
    );
  });
  it("fails closed for a removed or unpinned saved SSH host", () => {
    useServerStore.setState({ servers: [] });
    expect(attemptLandability(ssh())).toMatchObject({
      allowed: false,
      reason: expect.stringContaining("saved SSH host srv-1 is unavailable"),
    });
    useServerStore.setState({ servers: [{ ...SERVER, hostFingerprint: undefined }] });
    expect(attemptLandability(ssh())).toMatchObject({
      allowed: false,
      reason: expect.stringContaining("Verify and pin"),
    });
  });
});
