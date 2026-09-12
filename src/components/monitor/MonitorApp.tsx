import { useEffect, useMemo, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { Copy, ExternalLink, Minus, Square, X } from "lucide-react";
import { MarkdownRenderer } from "@/components/common/MarkdownRenderer";
import { APP_NAME } from "@/lib/brand";
import {
  closeMonitorWindow,
  focusMonitorRouteInMain,
  getMonitorWindowRoute,
  monitorLabelFromLocation,
} from "@/lib/monitorWindows";
import { loadPersistedState } from "@/lib/tauri";
import { refreshConversationProjection } from "@/stores/agentConversationPersistence";
import { useAgentTaskStore } from "@/stores/agentTaskStore";
import { useFlightStore } from "@/stores/flightStore";
import type { MonitorLease } from "@/types/monitor";

export function MonitorApp() {
  const label = useMemo(() => monitorLabelFromLocation(), []);
  const [lease, setLease] = useState<MonitorLease | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lastUpdated, setLastUpdated] = useState(Date.now());

  useEffect(() => {
    let unlisten: UnlistenFn | undefined;
    let cancelled = false;
    void getMonitorWindowRoute(label)
      .then((value) => {
        if (!cancelled) setLease(value);
      })
      .catch((reason) => {
        if (!cancelled) setError(String(reason));
      });
    void listen<MonitorLease>("monitor-window:route-changed", ({ payload }) => {
      setLease(payload);
      setError(null);
      setLastUpdated(Date.now());
    }).then((cleanup) => {
      if (cancelled) cleanup();
      else unlisten = cleanup;
    });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [label]);

  useEffect(() => {
    const refresh = async () => {
      try {
        const state = await loadPersistedState();
        await useFlightStore.getState().hydrateFromBackend(state);
        await refreshConversationProjection();
        setLastUpdated(Date.now());
      } catch {
        // Keep the last safe projection while the main process is busy.
      }
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), 3_000);
    return () => window.clearInterval(timer);
  }, []);

  return (
    <div className="flex h-screen flex-col overflow-hidden bg-bg-primary text-text-primary">
      <MonitorTitleBar label={label} />
      <header className="flex items-center gap-3 border-b border-bg-border bg-bg-secondary px-4 py-2">
        <span className="bg-accent-green/10 rounded px-2 py-0.5 text-[10px] font-semibold uppercase text-accent-green">
          Read-only Monitor
        </span>
        <span className="flex-1 text-[10px] text-text-muted">
          Updated {new Date(lastUpdated).toLocaleTimeString()}
        </span>
        <button
          onClick={() => void focusMonitorRouteInMain(label)}
          disabled={!lease}
          className="inline-flex items-center gap-1.5 rounded border border-bg-border px-2.5 py-1.5 text-[10px] text-text-secondary hover:bg-bg-hover disabled:opacity-50"
        >
          <ExternalLink size={11} />
          Focus in Main Window
        </button>
      </header>
      <main className="min-h-0 flex-1 overflow-y-auto p-4">
        {error ? (
          <MonitorEmpty title="This Monitor is stale" detail={error} />
        ) : !lease ? (
          <MonitorEmpty title="Opening Monitor…" detail="Waiting for the route lease." />
        ) : lease.route.kind === "flight" ? (
          <FlightMonitor flightId={lease.route.flightId} />
        ) : (
          <AgentMonitor conversationId={lease.route.conversationId} />
        )}
      </main>
    </div>
  );
}

function MonitorTitleBar({ label }: { label: string }) {
  const [maximized, setMaximized] = useState(false);
  async function toggleMaximize() {
    const window = getCurrentWindow();
    const current = await window.isMaximized();
    if (current) await window.unmaximize();
    else await window.maximize();
    setMaximized(!current);
  }
  return (
    <div className="flex h-8 flex-shrink-0 items-center bg-bg-tertiary" data-tauri-drag-region>
      <div className="flex-1 px-3 text-[11px] font-semibold" data-tauri-drag-region>
        {APP_NAME} Monitor
      </div>
      <button
        aria-label="Minimize Monitor"
        onClick={() => void getCurrentWindow().minimize()}
        className="flex h-full w-11 items-center justify-center hover:bg-bg-hover"
      >
        <Minus size={13} />
      </button>
      <button
        aria-label="Toggle Monitor maximize"
        onClick={() => void toggleMaximize()}
        className="flex h-full w-11 items-center justify-center hover:bg-bg-hover"
      >
        {maximized ? <Copy size={11} /> : <Square size={11} />}
      </button>
      <button
        aria-label="Close Monitor"
        onClick={() => void closeMonitorWindow(label)}
        className="hover:bg-accent-red/80 flex h-full w-11 items-center justify-center"
      >
        <X size={13} />
      </button>
    </div>
  );
}

function AgentMonitor({ conversationId }: { conversationId: string }) {
  const conversation = useAgentTaskStore((state) =>
    state.conversations.find((candidate) => candidate.id === conversationId),
  );
  if (!conversation) {
    return (
      <MonitorEmpty title="Conversation not found" detail="It may have been archived or deleted." />
    );
  }
  return (
    <div className="mx-auto max-w-4xl">
      <div className="mb-3 rounded border border-bg-border bg-bg-secondary p-3">
        <div className="flex items-center gap-2">
          <h1 className="text-sm font-semibold">{conversation.title}</h1>
          <span className="rounded bg-bg-elevated px-1.5 py-0.5 text-[9px] uppercase text-text-secondary">
            {conversation.status}
          </span>
        </div>
        <p className="mt-1 font-mono text-[9px] text-text-muted">
          {conversation.agent} · {conversation.model ?? conversation.provider ?? "default"} ·{" "}
          {conversation.projectPath}
        </p>
      </div>
      <div className="space-y-2">
        {conversation.messages.map((message) => (
          <div
            key={message.id}
            className={`rounded border p-3 ${
              message.role === "user"
                ? "border-accent-blue/20 bg-accent-blue/5"
                : "border-bg-border bg-bg-secondary"
            }`}
          >
            <div className="mb-1 text-[9px] font-semibold uppercase text-text-muted">
              {message.role}
            </div>
            <MarkdownRenderer content={message.content} className="text-[11px]" />
            {(message.toolCalls?.length ?? 0) > 0 && (
              <div className="mt-2 text-[9px] text-text-muted">
                {message.toolCalls?.length} tool call(s) ·{" "}
                {message.toolCalls?.filter((tool) => tool.status === "running").length} active
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

function FlightMonitor({ flightId }: { flightId: string }) {
  const flight = useFlightStore((state) =>
    state.flights.find((candidate) => candidate.id === flightId),
  );
  if (!flight) {
    return <MonitorEmpty title="Flight not found" detail="It may have been deleted." />;
  }
  const tasks = flight.milestones.flatMap((milestone) => milestone.tasks);
  const running = tasks.filter((task) => task.status === "running").length;
  const blocked = tasks.filter((task) =>
    ["blocked", "approval_needed", "failed"].includes(task.status),
  ).length;
  const done = tasks.filter((task) => task.status === "done").length;
  return (
    <div className="mx-auto max-w-4xl space-y-3">
      <div className="rounded border border-bg-border bg-bg-secondary p-4">
        <div className="flex items-center gap-2">
          <h1 className="text-base font-semibold">{flight.title}</h1>
          <span className="bg-accent-green/10 rounded px-1.5 py-0.5 text-[9px] uppercase text-accent-green">
            {flight.status}
          </span>
          <span className="text-[9px] uppercase text-text-muted">{flight.priority}</span>
        </div>
        <p className="mt-2 text-[11px] leading-relaxed text-text-secondary">{flight.objective}</p>
      </div>
      <div className="grid grid-cols-3 gap-2">
        {[
          ["Running", running],
          ["Needs attention", blocked],
          ["Done", done],
        ].map(([label, value]) => (
          <div key={label} className="rounded border border-bg-border bg-bg-secondary p-3">
            <div className="text-[9px] uppercase text-text-muted">{label}</div>
            <div className="mt-1 font-mono text-sm text-text-primary">{value}</div>
          </div>
        ))}
      </div>
      {flight.milestones.map((milestone) => (
        <div key={milestone.id} className="rounded border border-bg-border bg-bg-secondary p-3">
          <div className="mb-2 flex items-center gap-2">
            <h2 className="text-[11px] font-semibold">{milestone.title}</h2>
            <span className="text-[9px] uppercase text-text-muted">{milestone.status}</span>
          </div>
          <div className="space-y-1">
            {milestone.tasks.map((task) => (
              <div
                key={task.id}
                className="flex items-center gap-2 rounded bg-bg-primary px-2 py-1.5 text-[10px]"
              >
                <span className="flex-1">{task.title}</span>
                <span className="uppercase text-text-muted">{task.status}</span>
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

function MonitorEmpty({ title, detail }: { title: string; detail: string }) {
  return (
    <div className="flex min-h-[280px] items-center justify-center">
      <div className="text-center">
        <h1 className="text-sm font-semibold">{title}</h1>
        <p className="mt-1 text-[11px] text-text-muted">{detail}</p>
      </div>
    </div>
  );
}
