import { useMemo, useState } from "react";
import { AlertTriangle, Check, GitMerge, Network, Play, RotateCcw, X } from "lucide-react";
import { DEFAULT_API_AGENT, getDefaultModel } from "@/lib/api-models";
import { FlightAgentPicker } from "./FlightAgentPicker";
import {
  selectCooperativeTaskViews,
  validateCooperativeAssignments,
  validateCooperativeGraph,
} from "@/lib/cooperativeFlight";
import { useAsyncFlightStore } from "@/stores/asyncFlightStore";
import { useFlightStore } from "@/stores/flightStore";
import type { AgentCli } from "@/stores/agentTaskStore";
import type { Flight, Task } from "@/types/flight";

function taskStateColor(state: ReturnType<typeof selectCooperativeTaskViews>[number]["state"]) {
  if (state === "integrated") return "text-accent-green";
  if (state === "running") return "text-accent-blue";
  if (state === "review") return "text-accent-amber";
  if (state === "failed") return "text-accent-red";
  if (state === "ready") return "text-accent-purple";
  return "text-text-muted";
}

export function CooperativeFlightCard({ flight }: { flight: Flight }) {
  const updateFlight = useFlightStore((state) => state.updateFlight);
  const appendCoordinationEvent = useFlightStore((state) => state.appendCoordinationEvent);
  const launchReadyTasks = useAsyncFlightStore((state) => state.launchReadyTasks);
  const prepareCooperativeFlight = useAsyncFlightStore((state) => state.prepareCooperativeFlight);
  const landCooperativeFlight = useAsyncFlightStore((state) => state.landCooperativeFlight);
  const [feedback, setFeedback] = useState<string | null>(null);
  const [confirmLanding, setConfirmLanding] = useState(false);
  const [agentReadiness, setAgentReadiness] = useState<
    Record<string, { agent: string; model?: string; error: string | null }>
  >({});
  const views = useMemo(() => selectCooperativeTaskViews(flight), [flight]);
  const issues = useMemo(
    () => [...validateCooperativeGraph(flight), ...validateCooperativeAssignments(flight)],
    [flight],
  );
  const ready = views.filter((view) => view.state === "ready");
  const readyAgentsBlocked = ready.some(({ task }) => {
    const value = agentReadiness[task.id];
    return (
      !value ||
      value.agent !== task.agentConfigId ||
      value.model !== task.model ||
      value.error !== null
    );
  });
  const allIntegrated = views.length > 0 && views.every((view) => view.state === "integrated");

  if (flight.milestones.length === 0) return null;

  function patchTask(taskId: string, patch: Partial<Task>) {
    updateFlight(flight.id, {
      milestones: flight.milestones.map((milestone) => ({
        ...milestone,
        tasks: milestone.tasks.map((task) => (task.id === taskId ? { ...task, ...patch } : task)),
      })),
    });
  }

  function enableCooperativeMode() {
    updateFlight(flight.id, {
      executionMode: "cooperative",
      milestones: flight.milestones.map((milestone) => ({
        ...milestone,
        tasks: milestone.tasks.map((task) => {
          if (task.agentConfigId !== "unassigned" && task.model) return task;
          // Reviewer / scout run on a DIFFERENT vendor from the implementer
          // so a review is not the same model marking its own homework. Was
          // `api-openai-codex` until that row was removed in 2026-07; the
          // OpenAI Agents SDK row reaches the same API with an API key.
          const agent: AgentCli =
            task.role === "reviewer" || task.role === "scout"
              ? "api-openai-agents"
              : DEFAULT_API_AGENT;
          return {
            ...task,
            agentConfigId: task.agentConfigId === "unassigned" ? agent : task.agentConfigId,
            model: task.model || getDefaultModel(agent),
          };
        }),
      })),
    });
    appendCoordinationEvent(flight.id, {
      type: "handoff",
      summary:
        "Enabled assisted cooperative execution. Ready tasks remain user-launched and integrate only after acceptance.",
      metadata: { source: "cooperative_execution" },
    });
  }

  async function run(action: () => Promise<void>, success: string) {
    setFeedback(null);
    try {
      await action();
      setFeedback(success);
    } catch (error) {
      setFeedback(error instanceof Error ? error.message : String(error));
    }
  }

  if (flight.executionMode !== "cooperative") {
    return (
      <div className="flex items-center gap-2 rounded border border-bg-border bg-bg-secondary px-3 py-2">
        <Network size={12} className="text-accent-purple" />
        <div className="min-w-0 flex-1">
          <div className="text-[11px] font-semibold text-text-primary">Cooperative task graph</div>
          <div className="text-[10px] text-text-muted">
            Validate assignments and dependencies, then launch each ready batch from an isolated
            Flight integration branch.
          </div>
        </div>
        <button
          type="button"
          onClick={enableCooperativeMode}
          className="rounded border border-accent-purple/30 bg-accent-purple/10 px-2 py-1 text-[10px] font-medium text-accent-purple hover:bg-accent-purple/20"
        >
          Enable assisted graph
        </button>
      </div>
    );
  }

  const byId = new Map(views.map((view) => [view.task.id, view.task]));
  return (
    <div className="rounded border border-accent-purple/25 bg-bg-secondary">
      <div className="flex items-center gap-2 border-b border-bg-border px-3 py-2">
        <Network size={12} className="text-accent-purple" />
        <div className="min-w-0 flex-1">
          <div className="text-[11px] font-semibold text-text-primary">Cooperative task graph</div>
          <div className="text-[10px] text-text-muted">
            {ready.length} ready · integration {flight.integrationBranch?.status ?? "not prepared"}
            {flight.integrationBranch?.headSha
              ? ` · ${flight.integrationBranch.headSha.slice(0, 8)}`
              : ""}
          </div>
        </div>
        {flight.integrationBranch?.status === "needs_attention" && (
          <button
            type="button"
            onClick={() =>
              void run(
                () => prepareCooperativeFlight(flight.id),
                "Integration branch verified and ready.",
              )
            }
            className="flex items-center gap-1 rounded border border-accent-amber/30 px-2 py-1 text-[10px] text-accent-amber"
          >
            <RotateCcw size={9} /> Retry after resolution
          </button>
        )}
        {allIntegrated &&
          flight.integrationBranch?.status === "ready" &&
          (confirmLanding ? (
            <span className="flex items-center gap-1 text-[10px] text-accent-amber">
              Land into {flight.integrationBranch.baseBranch}?
              <button
                type="button"
                aria-label="Confirm final Flight landing"
                onClick={() =>
                  void run(
                    () => landCooperativeFlight(flight.id),
                    "Flight integration branch landed.",
                  ).finally(() => setConfirmLanding(false))
                }
                className="rounded p-0.5 hover:bg-accent-green/10 hover:text-accent-green"
              >
                <Check size={10} />
              </button>
              <button
                type="button"
                aria-label="Cancel final Flight landing"
                onClick={() => setConfirmLanding(false)}
                className="rounded p-0.5 hover:bg-accent-red/10 hover:text-accent-red"
              >
                <X size={10} />
              </button>
            </span>
          ) : (
            <button
              type="button"
              onClick={() => setConfirmLanding(true)}
              className="flex items-center gap-1 rounded border border-accent-green/30 px-2 py-1 text-[10px] text-accent-green"
            >
              <GitMerge size={9} /> Land Flight
            </button>
          ))}
        <button
          type="button"
          disabled={issues.length > 0 || ready.length === 0 || readyAgentsBlocked}
          onClick={() =>
            void run(
              () => launchReadyTasks(flight.id, undefined, { explicitResume: true }),
              `Launched ${ready.length} ready task${ready.length === 1 ? "" : "s"}.`,
            )
          }
          className="flex items-center gap-1 rounded border border-accent-purple/30 bg-accent-purple/10 px-2 py-1 text-[10px] font-medium text-accent-purple disabled:cursor-not-allowed disabled:opacity-40"
        >
          <Play size={9} /> Launch ready tasks
        </button>
      </div>

      {flight.integrationBranch?.status === "needs_attention" && (
        <div className="flex items-start gap-1.5 border-b border-accent-amber/20 bg-accent-amber/5 px-3 py-2 text-[10px] text-accent-amber">
          <AlertTriangle size={10} className="mt-px" />
          <span>
            {flight.integrationBranch.errorMessage}
            {(flight.integrationBranch.conflictFiles?.length ?? 0) > 0
              ? ` Conflicts: ${flight.integrationBranch.conflictFiles!.join(", ")}.`
              : ""}
          </span>
        </div>
      )}

      <div className="divide-y divide-bg-border">
        {views.map(({ task, state, blockedBy }) => {
          return (
            <div
              key={task.id}
              className="grid grid-cols-1 items-start gap-3 px-3 py-3 text-[11px] xl:grid-cols-[minmax(160px,1fr)_minmax(260px,1.5fr)_minmax(150px,1fr)]"
            >
              <div className="min-w-0">
                <div className="truncate font-medium text-text-primary">{task.title}</div>
                <div className="truncate text-text-muted">
                  {task.role ?? "builder"} · <span className={taskStateColor(state)}>{state}</span>
                  {blockedBy.length > 0
                    ? ` · waits for ${blockedBy.map((id) => byId.get(id)?.title ?? id).join(", ")}`
                    : ""}
                </div>
              </div>
              {state === "ready" || state === "blocked" ? (
                <FlightAgentPicker
                  label={`Agent for ${task.title}`}
                  agent={task.agentConfigId as AgentCli}
                  model={task.model ?? ""}
                  autoSelectAgent={task.agentConfigId === DEFAULT_API_AGENT}
                  onChange={(agent, model) => patchTask(task.id, { agentConfigId: agent, model })}
                  onReadinessChange={(error) =>
                    setAgentReadiness((previous) =>
                      previous[task.id]?.agent === task.agentConfigId &&
                      previous[task.id]?.model === task.model &&
                      previous[task.id]?.error === error
                        ? previous
                        : {
                            ...previous,
                            [task.id]: { agent: task.agentConfigId, model: task.model, error },
                          },
                    )
                  }
                />
              ) : (
                <div className="text-text-muted">
                  {task.agentConfigId} · {task.model}
                </div>
              )}
              <input
                aria-label={`Owned paths for ${task.title}`}
                value={(task.ownedPaths ?? []).join(", ")}
                disabled={state !== "ready" && state !== "blocked"}
                onChange={(event) =>
                  patchTask(task.id, {
                    ownedPaths: event.target.value
                      .split(",")
                      .map((path) => path.trim())
                      .filter(Boolean),
                  })
                }
                placeholder="owned/path, other/path"
                className="rounded border border-bg-border bg-bg-primary px-1.5 py-1 text-text-secondary outline-none"
              />
            </div>
          );
        })}
      </div>

      {issues.length > 0 && (
        <div className="border-t border-accent-amber/20 bg-accent-amber/5 px-3 py-2 text-[10px] text-accent-amber">
          {issues.slice(0, 5).map((issue) => (
            <div key={`${issue.kind}:${issue.taskId}:${issue.relatedTaskId ?? ""}`}>
              {issue.message}
            </div>
          ))}
          {issues.length > 5 && <div>…and {issues.length - 5} more assignment issues.</div>}
        </div>
      )}
      {feedback && (
        <div className="flex items-center gap-1 border-t border-bg-border px-3 py-2 text-[10px] text-text-secondary">
          <GitMerge size={9} /> {feedback}
        </div>
      )}
    </div>
  );
}
