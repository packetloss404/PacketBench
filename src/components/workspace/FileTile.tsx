/**
 * File viewer tile — a `kind: "file"` pane rendered inside the workspace
 * mosaic, so a README or a config can sit beside a Claude Code terminal
 * instead of only in the right-dock Editor.
 *
 * The BODY is deliberately a thin wrapper: the buffer lives in `editorStore`,
 * which means the same path opened in the dock and in a tile is one buffer with
 * one dirty flag and one save path. `EditorPane` is reused unforked, so the
 * markdown preview/raw toggle, Ctrl+S, and the load/error states are the ones
 * already shipped and tested.
 *
 * The CHROME matches the terminal and conversation tiles — grip (wired as the
 * mosaic drag source), identity, zoom, close — because the mosaic hides the
 * library's own toolbar, so without this bar the tile would have no drag
 * handle and no zoom or close control at all.
 *
 * The pane persists only `filePath` (+ optional `fileView`); the buffer id is
 * resolved at mount, because `editorStore` is runtime-only.
 */
import { useEffect, useState } from "react";
import { FileText, FileWarning } from "lucide-react";
import { TileChrome } from "./TileChrome";
import { EditorPane } from "@/components/editor/EditorPane";
import { EmptyState } from "@/components/ui/EmptyState";
import { useEditorStore } from "@/stores/editorStore";
import { useWorkspaceStore } from "@/stores/workspaceStore";
import { useLayoutStore } from "@/stores/layoutStore";
import { basenameOf } from "@/lib/fleetRows";
import type { WorkspacePane } from "@/types/workspace";

interface FileTileProps {
  pane: WorkspacePane;
  workspaceId: string;
  /** Project root the Tauri FS commands scope this read/write to. */
  projectPath: string;
  /** SSH workspaces have no local FS to read — state that instead of failing. */
  remote?: boolean;
}

export function FileTile({ pane, workspaceId, projectPath, remote = false }: FileTileProps) {
  const openFile = useEditorStore((s) => s.openFile);
  const setView = useEditorStore((s) => s.setView);
  const openFiles = useEditorStore((s) => s.openFiles);
  const zoomedPaneId = useWorkspaceStore((s) => s.zoomedPaneId);
  const setZoomedPane = useWorkspaceStore((s) => s.setZoomedPane);
  const removePane = useWorkspaceStore((s) => s.removePane);
  const isFocused = useLayoutStore((s) => s.activePaneId === pane.id);
  const setActivePaneId = useLayoutStore((s) => s.setActivePaneId);
  const [bufferId, setBufferId] = useState<string | null>(null);

  const filePath = pane.filePath ?? "";
  const isZoomed = zoomedPaneId === pane.id;
  const title = basenameOf(filePath) || "File";

  // Resolve (or create) the shared buffer once per path. `openFile` re-activates
  // an existing buffer for the same path, so tiling a file that is already open
  // in the dock adopts that buffer — including its unsaved edits.
  useEffect(() => {
    if (remote || !filePath) return;
    const id = openFile(filePath, projectPath);
    setBufferId(id);
    // A pane that asked for an explicit initial view (the "Markdown Viewer"
    // picker row) applies it once at adoption. Later manual toggles win — this
    // effect is keyed on the path, not on the buffer's current view.
    if (pane.fileView) setView(id, pane.fileView);
  }, [filePath, projectPath, remote, pane.fileView, openFile, setView]);

  const chrome = (
    <TileChrome
      title={title}
      titleTooltip={filePath}
      titleClassName="text-accent-blue"
      icon={<FileText size={11} className="shrink-0 text-accent-blue" />}
      isZoomed={isZoomed}
      onToggleZoom={() => setZoomedPane(isZoomed ? null : pane.id)}
      // Closing a tile preserves the shared editor buffer and its unsaved edits.
      close={{
        label: `Close ${title}`,
        tooltip: "Close viewer",
        onClick: () => removePane(workspaceId, pane.id),
      }}
    />
  );

  const file = bufferId ? (openFiles.find((f) => f.id === bufferId) ?? null) : null;

  let body;
  if (remote) {
    body = (
      <EmptyState
        className="h-full"
        icon={<FileWarning size={22} />}
        title="File viewer is local-only"
        description="This workspace runs over SSH. Browse remote files from the agent's tools instead."
      />
    );
  } else if (!filePath || !file) {
    body = (
      <EmptyState
        className="h-full"
        icon={<FileWarning size={22} />}
        title="No file"
        description="This viewer tile lost its file. Close it and open the file again."
      />
    );
  } else {
    body = <EditorPane key={file.id} file={file} />;
  }

  return (
    // data-pane-zoomed lets mosaic-overrides.css maximize this tile's
    // already-mounted mosaic tile when zoomed — the same CSS path the terminal
    // and conversation tiles use, so no sibling ever remounts.
    <div
      data-pane-zoomed={isZoomed || undefined}
      onPointerDown={() => setActivePaneId(pane.id)}
      onFocusCapture={() => setActivePaneId(pane.id)}
      className={`flex h-full min-h-0 flex-col overflow-hidden rounded-md border bg-bg-primary ${isFocused ? "border-accent-line" : "border-bg-border"}`}
    >
      {chrome}
      <div className="min-h-0 flex-1 overflow-hidden">{body}</div>
    </div>
  );
}
