import { StrictMode } from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  listen: vi.fn(),
  run: vi.fn(),
  cancel: vi.fn(),
  handlers: new Map<string, (event: { payload: unknown }) => void>(),
  unlisteners: [] as ReturnType<typeof vi.fn>[],
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: mocks.listen }));
vi.mock("@/lib/tauri", () => ({
  runQualityChecks: mocks.run,
  cancelQualityRun: mocks.cancel,
  qualityEvents: {
    checkDone: (id: string) => `check:${id}`,
    done: (id: string) => `done:${id}`,
    error: (id: string) => `error:${id}`,
  },
}));
vi.mock("../QualityAISummary", () => ({
  QualityAISummary: ({ checks }: { checks: { output: string }[] }) => (
    <div data-testid="summary">{checks.map((check) => check.output).join(" ")}</div>
  ),
}));
import { QualityAIRunSummaryPanel } from "../QualityAIRunSummaryPanel";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.handlers.clear();
  mocks.unlisteners.length = 0;
  mocks.run.mockResolvedValue("run");
  mocks.cancel.mockResolvedValue(true);
  mocks.listen.mockImplementation(
    async (name: string, handler: (event: { payload: unknown }) => void) => {
      mocks.handlers.set(name, handler);
      const off = vi.fn(() => mocks.handlers.delete(name));
      mocks.unlisteners.push(off);
      return off;
    },
  );
});
async function start() {
  fireEvent.click(screen.getByRole("button", { name: "Run checks + summarize" }));
  await waitFor(() => expect(mocks.run).toHaveBeenCalledOnce());
  return mocks.run.mock.calls[0][1] as string;
}
function done(id: string, payload: unknown) {
  act(() => mocks.handlers.get(`done:${id}`)?.({ payload }));
}
describe("live aggregate Quality checks", () => {
  it("completes under StrictMode and uses authoritative final check results", async () => {
    render(
      <StrictMode>
        <QualityAIRunSummaryPanel projectPath="/repo" projectName="repo" />
      </StrictMode>,
    );
    const id = await start();
    done(id, {
      checks: [
        {
          checkId: "lint",
          label: "Lint",
          status: "failed",
          optional: false,
          exitCode: 1,
          output: "actual diagnostic",
        },
      ],
      cancelled: false,
    });
    expect(screen.getByTestId("summary")).toHaveTextContent("actual diagnostic");
    expect(mocks.unlisteners.every((off) => off.mock.calls.length === 1)).toBe(true);
  });
  it("cancels the actual run and never summarizes cancelled work as success", async () => {
    render(<QualityAIRunSummaryPanel projectPath="/repo" projectName="repo" />);
    const id = await start();
    fireEvent.click(screen.getByRole("button", { name: "Cancel checks" }));
    await waitFor(() => expect(mocks.cancel).toHaveBeenCalledWith(id));
    done(id, { checks: [], cancelled: true });
    expect(screen.getByText("Quality checks cancelled.")).toBeInTheDocument();
    expect(screen.queryByText("All checks passed")).toBeNull();
    expect(screen.queryByTestId("summary")).toBeNull();
  });
  it("releases a late listener and never starts checks after unmount during subscription", async () => {
    let resolve!: (off: () => void) => void;
    mocks.listen.mockImplementationOnce(
      () =>
        new Promise((r) => {
          resolve = r;
        }),
    );
    const view = render(<QualityAIRunSummaryPanel projectPath="/repo" projectName="repo" />);
    fireEvent.click(screen.getByRole("button", { name: "Run checks + summarize" }));
    view.unmount();
    const off = vi.fn();
    await act(async () => resolve(off));
    expect(off).toHaveBeenCalledOnce();
    expect(mocks.run).not.toHaveBeenCalled();
  });
  it("honors cancellation before the backend run can start", async () => {
    let resolve!: (off: () => void) => void;
    mocks.listen.mockImplementationOnce(
      () =>
        new Promise((r) => {
          resolve = r;
        }),
    );
    render(<QualityAIRunSummaryPanel projectPath="/repo" projectName="repo" />);
    fireEvent.click(screen.getByRole("button", { name: "Run checks + summarize" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel checks" }));
    await act(async () => resolve(vi.fn()));
    expect(mocks.run).not.toHaveBeenCalled();
    expect(screen.getByText("Quality checks cancelled.")).toBeInTheDocument();
  });
  it("cancels and clears the old run when the project changes", async () => {
    const view = render(<QualityAIRunSummaryPanel projectPath="/old" projectName="old" />);
    const id = await start();
    const late = mocks.handlers.get(`done:${id}`)!;
    view.rerender(<QualityAIRunSummaryPanel projectPath="/new" projectName="new" />);
    expect(mocks.cancel).toHaveBeenCalledWith(id);
    act(() => late({ payload: { checks: [], cancelled: false } }));
    expect(screen.getByRole("button", { name: "Run checks + summarize" })).toBeInTheDocument();
    expect(screen.queryByText("All checks passed")).toBeNull();
  });
});
