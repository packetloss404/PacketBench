import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { RuntimeRecoveryBanner } from "@/components/agents/RuntimeRecoveryBanner";

const getMock = vi.hoisted(() => vi.fn());
const resumeMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/tauri", () => ({ getConversationRuntime: getMock }));
vi.mock("@/lib/runtimeRecovery", () => ({ resumeConversationRun: resumeMock }));

beforeEach(() => {
  getMock.mockReset();
  resumeMock.mockReset();
});

describe("RuntimeRecoveryBanner (R1/R3)", () => {
  it("offers Resume for a needs_reconciliation run and resumes on click", async () => {
    getMock.mockResolvedValue({ state: "needs_reconciliation", runtimeRunId: "r", epoch: 0 });
    resumeMock.mockResolvedValue({ state: "prepared" });

    render(<RuntimeRecoveryBanner conversationId="conv-1" />);

    const button = await screen.findByRole("button", { name: /resume/i });
    fireEvent.click(button);

    await waitFor(() => expect(resumeMock).toHaveBeenCalledTimes(1));
  });

  it("renders nothing for a healthy run", async () => {
    getMock.mockResolvedValue({ state: "completed" });
    const { container } = render(<RuntimeRecoveryBanner conversationId="conv-1" />);
    await waitFor(() => expect(getMock).toHaveBeenCalled());
    expect(container.firstChild).toBeNull();
  });

  it("renders nothing when the journal is disabled (null runtime)", async () => {
    getMock.mockResolvedValue(null);
    const { container } = render(<RuntimeRecoveryBanner conversationId="conv-1" />);
    await waitFor(() => expect(getMock).toHaveBeenCalled());
    expect(container.firstChild).toBeNull();
  });
});
