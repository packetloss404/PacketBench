/**
 * P1-S4 (clickable git rows): the GitDashboard's changed-file rows open a
 * read-only diff (HEAD vs working tree) rendered through the shared DiffRows
 * engine, so a commit is never blind. This covers the row-click → correct
 * file diff path; DiffRows/hunkDiff are consumed UNMODIFIED.
 */
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getGitBranch: vi.fn(),
  getGitStatus: vi.fn(),
  getFileHeadContent: vi.fn(),
  readFileForDiff: vi.fn(),
}));

vi.mock("@/lib/tauri", async (importActual) => {
  const actual = await importActual<typeof import("@/lib/tauri")>();
  return {
    ...actual,
    getGitBranch: (...a: unknown[]) => mocks.getGitBranch(...a),
    getGitStatus: (...a: unknown[]) => mocks.getGitStatus(...a),
    getFileHeadContent: (...a: unknown[]) => mocks.getFileHeadContent(...a),
    readFileForDiff: (...a: unknown[]) => mocks.readFileForDiff(...a),
  };
});

vi.mock("@/stores/serverStore", () => ({
  useServerStore: (selector: (s: { servers: unknown[] }) => unknown) => selector({ servers: [] }),
}));
vi.mock("@/stores/flightStore", () => ({
  useFlightStore: (selector: (s: { flights: unknown[]; setActiveFlight: () => void }) => unknown) =>
    selector({ flights: [], setActiveFlight: vi.fn() }),
}));
vi.mock("@/stores/appStore", () => ({
  useAppStore: (selector: (s: { setActiveView: () => void }) => unknown) =>
    selector({ setActiveView: vi.fn() }),
}));
vi.mock("@/stores/issueStore", () => ({
  useIssueStore: (selector: (s: { issues: unknown[] }) => unknown) => selector({ issues: [] }),
}));

import { GitDashboard } from "@/components/workspace/GitDashboard";

describe("GitDashboard clickable diff rows", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getGitBranch.mockResolvedValue("main");
    // Two changed files so we can assert the CORRECT one is diffed.
    mocks.getGitStatus.mockResolvedValue(" M src/foo.ts\n M src/bar.ts\n");
    mocks.getFileHeadContent.mockResolvedValue("line1\n");
    mocks.readFileForDiff.mockResolvedValue("line1\nline2\n");
  });

  it("drops delayed repository A results after switching to B", async () => {
    let resolveOld!: (value: string) => void;
    mocks.getGitStatus.mockImplementation((path: string) =>
      path === "/old"
        ? new Promise<string>((resolve) => {
            resolveOld = resolve;
          })
        : Promise.resolve(" M new.ts\n"),
    );
    const view = render(<GitDashboard projectPath="/old" workspaceId="old" />);
    view.rerender(<GitDashboard projectPath="/new" workspaceId="new" />);
    await screen.findByTitle("new.ts — click to view diff");
    await act(async () => {
      resolveOld(" M old.ts\n");
    });
    expect(screen.queryByTitle("old.ts — click to view diff")).toBeNull();
    fireEvent.click(screen.getByTitle("new.ts — click to view diff"));
    await waitFor(() => expect(mocks.getFileHeadContent).toHaveBeenCalledWith("/new", "new.ts"));
  });
  it("clears old rows immediately while the new repository is loading", async () => {
    const view = render(<GitDashboard projectPath="/old" />);
    await screen.findByTitle("src/foo.ts — click to view diff");
    mocks.getGitStatus.mockImplementation(() => new Promise(() => {}));
    view.rerender(<GitDashboard projectPath="/new" />);
    expect(screen.queryByTitle("src/foo.ts — click to view diff")).toBeNull();
    expect(screen.queryByRole("checkbox")).toBeNull();
  });
  it("opens the diff for the clicked file and renders DiffRows output", async () => {
    render(<GitDashboard projectPath="/repo" />);

    const row = await screen.findByTitle("src/foo.ts — click to view diff");
    fireEvent.click(row);

    // Fetches HEAD + working content for the CLICKED file, not the other one.
    await waitFor(() => {
      expect(mocks.getFileHeadContent).toHaveBeenCalledWith("/repo", "src/foo.ts");
    });
    expect(mocks.readFileForDiff).toHaveBeenCalledWith("/repo", "src/foo.ts");
    expect(mocks.getFileHeadContent).not.toHaveBeenCalledWith("/repo", "src/bar.ts");

    // The added line surfaces through the shared DiffRows engine.
    await waitFor(() => {
      expect(screen.getByText("line2")).toBeTruthy();
    });
    // Close affordance is present.
    expect(screen.getByLabelText("Close diff")).toBeTruthy();
  });

  it("closes the diff overlay from the close button", async () => {
    render(<GitDashboard projectPath="/repo" />);
    const row = await screen.findByTitle("src/foo.ts — click to view diff");
    fireEvent.click(row);
    await waitFor(() => expect(screen.getByLabelText("Close diff")).toBeTruthy());
    fireEvent.click(screen.getByLabelText("Close diff"));
    await waitFor(() => expect(screen.queryByLabelText("Close diff")).toBeNull());
  });
});
