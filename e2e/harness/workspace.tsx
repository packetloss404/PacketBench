import { bridge } from "./workspace-bridge";
import { createRoot } from "react-dom/client";
import { Terminal } from "@xterm/xterm";
import { WorkspaceMosaicContainer } from "@/components/workspace/WorkspaceMosaicContainer";
import { useWorkspaceStore } from "@/stores/workspaceStore";
import { useLayoutStore } from "@/stores/layoutStore";
import { useAppStore } from "@/stores/appStore";
import { ptyOutputEvent } from "@/lib/events";
import type { Workspace } from "@/types/workspace";
import "@/index.css";

const count = Math.min(
  12,
  Math.max(1, Number(new URLSearchParams(location.search).get("panes")) || 1),
);
const workspace: Workspace = {
  id: "acceptance-workspace",
  name: "Output acceptance",
  projectPath: "/acceptance",
  agents: ["terminal"],
  status: "active",
  createdAt: 0,
  updatedAt: 0,
  panes: Array.from({ length: count }, (_, i) => ({
    id: `pane-${i}`,
    agentId: "terminal",
    sessionId: null,
  })),
};
const terminals = new Map<string, Terminal>();
let disposals = 0;
const originalOpen = Terminal.prototype.open;
const originalDispose = Terminal.prototype.dispose;
Terminal.prototype.open = function (container) {
  originalOpen.call(this, container);
  const paneId = container.closest("[data-terminal-pane]")?.getAttribute("data-terminal-pane");
  if (paneId) terminals.set(paneId, this);
};
Terminal.prototype.dispose = function () {
  disposals++;
  originalDispose.call(this);
};

useAppStore.setState({ activeView: "workspace", initialized: true });
useWorkspaceStore.setState({ workspaces: [workspace], activeWorkspaceId: workspace.id });
useLayoutStore.setState({ activePaneId: "pane-0", projectPath: workspace.projectPath });

export function Surface() {
  const current = useWorkspaceStore((state) => state.workspaces[0]);
  return (
    <div style={{ display: "flex", height: "100vh", minWidth: 0 }}>
      <WorkspaceMosaicContainer workspace={current} />
    </div>
  );
}
const sequences = new Map<string, number>();
let runNumber = 0;
const flush = (term: Terminal) => new Promise<void>((resolve) => term.write("", resolve));
const tail = (term: Terminal) => {
  const buffer = term.buffer.active;
  return Array.from(
    { length: Math.min(5, buffer.length) },
    (_, i) => buffer.getLine(Math.max(0, buffer.length - 5) + i)?.translateToString(true) ?? "",
  ).join("\n");
};
const acceptance = {
  ready: () =>
    terminals.size === count &&
    bridge.launches.length === count &&
    bridge.launches.every((id) => bridge.ready(ptyOutputEvent(id))),
  snapshot: () => ({
    launches: bridge.launches.length,
    disposals,
    kills: bridge.kills.length,
    unexpected: bridge.unexpected,
    resizes: bridge.resizes.length,
  }),
  async run() {
    const runId = ++runNumber;
    const started = performance.now();
    const intervals: number[] = [];
    let previous = started;
    let frameId: number;
    let frames = true;
    const frame = (now: number) => {
      intervals.push(now - previous);
      previous = now;
      if (frames) frameId = requestAnimationFrame(frame);
    };
    frameId = requestAnimationFrame(frame);
    let bytes = 0;
    let events = 0;
    const longTasks: number[] = [];
    const observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) longTasks.push(entry.duration);
    });
    observer.observe({ type: "longtask", buffered: false });
    const emit = (sid: string, data: string) => {
      const sequence = (sequences.get(sid) ?? 0) + 1;
      sequences.set(sid, sequence);
      bytes += new TextEncoder().encode(data).byteLength;
      events++;
      bridge.emit(ptyOutputEvent(sid), { data, sequence });
    };
    // Two seconds of paced, production-sized 32KiB batches per pane.
    // The fixture uses real listeners/parser/canvas but a mocked Tauri bridge.
    const chunk = "\x1b[32moutput 日本語\x1b[0m 0123456789\r\n".repeat(720);
    for (let batch = 0; batch < 100; batch++) {
      for (const sid of bridge.launches) emit(sid, chunk);
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    for (let i = 0; i < count; i++)
      emit(bridge.launches[i], `\r\nEND_${i}_日本語_RUN_${runId}\r\n`);
    await Promise.all([...terminals.values()].map(flush));
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    frames = false;
    cancelAnimationFrame(frameId);
    observer.disconnect();
    intervals.sort((a, b) => a - b);
    return {
      scope: "Chromium production Workspace/xterm; mocked Tauri output, no native FPS claim",
      panes: count,
      runId,
      bytes,
      events,
      elapsedMs: performance.now() - started,
      frameSamples: intervals.length,
      p95FrameIntervalMs: intervals[Math.floor(intervals.length * 0.95)] ?? null,
      maxFrameIntervalMs: intervals[intervals.length - 1] ?? null,
      longTasks: longTasks.length,
      maxLongTaskMs: Math.max(0, ...longTasks),
      tails: [...terminals.entries()].map(([id, term]) => ({ id, text: tail(term) })),
      ...acceptance.snapshot(),
    };
  },
};
Object.assign(window, { workspaceAcceptance: acceptance });
export type WorkspaceAcceptance = typeof acceptance;
createRoot(document.getElementById("root")!).render(<Surface />);
