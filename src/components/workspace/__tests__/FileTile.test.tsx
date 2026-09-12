import { useEffect } from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useWorkspaceStore } from "@/stores/workspaceStore";
import { useLayoutStore } from "@/stores/layoutStore";
import { FileTile } from "../FileTile";

const fixture = vi.hoisted(() => ({
  file: { id: "buffer-1", path: "/project/README.md", content: "unsaved changes", dirty: true },
  openFile: vi.fn(() => "buffer-1"),
  setView: vi.fn(),
  removePane: vi.fn(),
  mount: vi.fn(),
  unmount: vi.fn(),
}));
vi.mock("@/stores/editorStore", () => ({
  useEditorStore: (select: (state: unknown) => unknown) =>
    select({ openFile: fixture.openFile, setView: fixture.setView, openFiles: [fixture.file] }),
}));
vi.mock("@/stores/workspaceStore", async () => {
  const { create } = await import("zustand");
  return {
    useWorkspaceStore: create((set) => ({
      zoomedPaneId: null,
      setZoomedPane: (zoomedPaneId: string | null) => set({ zoomedPaneId }),
      removePane: fixture.removePane,
    })),
  };
});
vi.mock("@/stores/layoutStore", async () => {
  const { create } = await import("zustand");
  return {
    useLayoutStore: create((set) => ({
      activePaneId: "",
      setActivePaneId: (activePaneId: string) => set({ activePaneId }),
    })),
  };
});
vi.mock("@/components/editor/EditorPane", () => ({
  EditorPane: function Editor({ file }: { file: typeof fixture.file }) {
    useEffect(() => {
      fixture.mount();
      return fixture.unmount;
    }, []);
    return <textarea aria-label="File content" defaultValue={file.content} />;
  },
}));
const pane = {
  id: "file-pane",
  kind: "file" as const,
  agentId: "terminal" as const,
  sessionId: null,
  filePath: "/project/README.md",
};

beforeEach(() => {
  vi.clearAllMocks();
  useWorkspaceStore.setState({ zoomedPaneId: null });
  useLayoutStore.setState({ activePaneId: "" });
});

describe("FileTile shared chrome", () => {
  it("tracks pointer and keyboard focus without taking the editor's input focus", () => {
    render(<FileTile pane={pane} workspaceId="ws" projectPath="/project" />);
    fireEvent.pointerDown(screen.getByText("README.md"));
    expect(useLayoutStore.getState().activePaneId).toBe(pane.id);
    act(() => useLayoutStore.setState({ activePaneId: "terminal-pane" }));
    act(() => screen.getByRole("textbox").focus());
    expect(useLayoutStore.getState().activePaneId).toBe(pane.id);
    expect(screen.getByRole("textbox")).toHaveFocus();
    expect(useWorkspaceStore.getState().zoomedPaneId).toBeNull();
  });

  it("retains the editor instance and unsaved buffer across zoom", () => {
    render(<FileTile pane={pane} workspaceId="ws" projectPath="/project" />);
    const editor = screen.getByRole("textbox");
    fireEvent.click(screen.getByRole("button", { name: "Zoom to focus: README.md" }));
    expect(useWorkspaceStore.getState().zoomedPaneId).toBe(pane.id);
    fireEvent.click(screen.getByRole("button", { name: "Exit zoom: README.md" }));
    expect(screen.getByRole("textbox")).toBe(editor);
    expect(editor).toHaveValue("unsaved changes");
    expect(fixture.mount).toHaveBeenCalledOnce();
    expect(fixture.unmount).not.toHaveBeenCalled();
    expect(fixture.openFile).toHaveBeenCalledOnce();
  });

  it("closes only the tile, preserving the shared dirty buffer", () => {
    render(<FileTile pane={pane} workspaceId="ws" projectPath="/project" />);
    fireEvent.click(screen.getByRole("button", { name: "Close README.md" }));
    expect(fixture.removePane).toHaveBeenCalledWith("ws", pane.id);
    expect(fixture.file).toMatchObject({ content: "unsaved changes", dirty: true });
  });

  it("keeps remote file gating while zoom controls remain available", () => {
    render(<FileTile pane={pane} workspaceId="ssh" projectPath="/remote" remote />);
    expect(screen.getByText("File viewer is local-only")).toBeInTheDocument();
    expect(fixture.openFile).not.toHaveBeenCalled();
    act(() => useWorkspaceStore.getState().setZoomedPane(pane.id));
    expect(screen.getByRole("button", { name: "Exit zoom: README.md" })).toBeInTheDocument();
  });
});
