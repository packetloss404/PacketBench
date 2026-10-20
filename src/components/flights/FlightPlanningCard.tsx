import { useMemo, useState } from "react";
import { CheckCircle2, MessageSquareText, Route } from "lucide-react";
import { useAgentTaskStore } from "@/stores/agentTaskStore";
import { useFlightStore } from "@/stores/flightStore";
import { openConversationInAgents } from "@/stores/sessionGlue";
import {
  FLIGHT_PLAN_FENCE,
  hasFlightPlanExecution,
  parseLatestFlightPlan,
  type FlightPlanInput,
} from "@/lib/flightPlanning";
import type { Flight } from "@/types/flight";

const INPUT =
  "mt-1 block w-full rounded border border-bg-border bg-bg-primary px-2 py-1.5 text-xs text-text-primary";
export function FlightPlanningCard({ flight }: { flight: Flight }) {
  const applyFlightPlan = useFlightStore((state) => state.applyFlightPlan);
  const conversation = useAgentTaskStore((state) =>
    flight.planningConversationId
      ? state.conversations.find((item) => item.id === flight.planningConversationId)
      : undefined,
  );
  const [draft, setDraft] = useState<FlightPlanInput | null>(null);
  const [feedback, setFeedback] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const taskCount = useMemo(
    () => flight.milestones.reduce((sum, milestone) => sum + milestone.tasks.length, 0),
    [flight.milestones],
  );
  const locked = Boolean(flight.archivedAt || hasFlightPlanExecution(flight));
  if (!flight.planningConversationId) return null;

  function loadPreview() {
    setError(null);
    setFeedback(null);
    try {
      if (!conversation)
        throw new Error("The planning conversation is not available on this device.");
      setDraft(parseLatestFlightPlan(conversation.messages));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  }
  function applyPreview() {
    setError(null);
    if (!draft || locked) return;
    try {
      const validated = parseLatestFlightPlan([
        {
          id: "preview",
          role: "assistant",
          content: `\`\`\`${FLIGHT_PLAN_FENCE}\n${JSON.stringify(draft)}\n\`\`\``,
          timestamp: Date.now(),
        },
      ]);
      applyFlightPlan(flight.id, validated);
      setDraft(null);
      setFeedback("Reviewed plan applied. Configure execution when ready.");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  }
  function patchMilestone(index: number, patch: Partial<FlightPlanInput["milestones"][number]>) {
    setDraft((current) =>
      current
        ? {
            ...current,
            milestones: current.milestones.map((item, itemIndex) =>
              itemIndex === index ? { ...item, ...patch } : item,
            ),
          }
        : null,
    );
  }

  return (
    <section
      aria-label="Flight plan"
      className="space-y-3 rounded border border-accent-purple/25 bg-accent-purple/5 p-3"
    >
      <div className="flex flex-wrap items-center gap-2">
        <Route size={13} className="text-accent-purple" />
        <h2 className="text-xs font-semibold text-text-primary">Plan</h2>
        <span className="text-[11px] text-text-muted">
          {taskCount ? `${taskCount} tasks applied` : "No plan applied"}
        </span>
        {conversation && (
          <button
            type="button"
            className="ml-auto flex items-center gap-1 rounded border border-bg-border px-2 py-1 text-[11px] text-text-secondary"
            onClick={() => openConversationInAgents(conversation.id)}
          >
            <MessageSquareText size={11} /> Open planning conversation
          </button>
        )}
        <button
          type="button"
          disabled={!conversation || locked}
          onClick={loadPreview}
          className="rounded border border-accent-purple/30 px-2 py-1 text-[11px] text-accent-purple disabled:opacity-40"
        >
          Preview latest plan
        </button>
      </div>
      {locked && (
        <p className="text-[11px] text-text-muted">
          Execution has started. This plan is protected so existing tasks and results keep their
          identity. Create a new Flight for a revised scope.
        </p>
      )}
      {error && (
        <p role="alert" className="text-xs text-accent-red">
          {error}
        </p>
      )}
      {feedback && (
        <p role="status" className="text-xs text-text-secondary">
          {feedback}
        </p>
      )}
      {draft && (
        <div className="space-y-3 border-t border-bg-border pt-3">
          <p className="text-xs text-text-secondary">
            Review and edit the proposed outcome, steps and checks before applying. Applying a plan
            does not start execution.
          </p>
          <label className="block text-[11px] text-text-secondary">
            Plan title
            <input
              value={draft.title ?? ""}
              onChange={(event) => setDraft({ ...draft, title: event.target.value })}
              className={INPUT}
            />
          </label>
          <label className="block text-[11px] text-text-secondary">
            Outcome
            <textarea
              value={draft.objective ?? ""}
              onChange={(event) => setDraft({ ...draft, objective: event.target.value })}
              className={INPUT}
              rows={2}
            />
          </label>
          {draft.milestones.map((milestone, milestoneIndex) => (
            <fieldset
              key={milestone.key}
              disabled={locked}
              className="space-y-3 rounded border border-bg-border p-3"
            >
              <legend className="px-1 text-xs font-medium text-text-primary">
                Step group {milestoneIndex + 1}
              </legend>
              <label className="block text-[11px] text-text-secondary">
                Group title
                <input
                  value={milestone.title}
                  onChange={(event) =>
                    patchMilestone(milestoneIndex, { title: event.target.value })
                  }
                  className={INPUT}
                />
              </label>
              <label className="block text-[11px] text-text-secondary">
                Acceptance checks, one per line
                <textarea
                  value={milestone.validationCriteria.join("\n")}
                  onChange={(event) =>
                    patchMilestone(milestoneIndex, {
                      validationCriteria: event.target.value.split("\n").filter(Boolean),
                    })
                  }
                  className={INPUT}
                  rows={2}
                />
              </label>
              {milestone.tasks.map((task, taskIndex) => {
                const patchTask = (patch: Partial<typeof task>) =>
                  patchMilestone(milestoneIndex, {
                    tasks: milestone.tasks.map((item, index) =>
                      index === taskIndex ? { ...item, ...patch } : item,
                    ),
                  });
                return (
                  <div key={task.key} className="space-y-2 border-t border-bg-border pt-2">
                    <p className="text-[11px] text-text-muted">
                      Task {taskIndex + 1} · {task.key}
                    </p>
                    <label className="block text-[11px] text-text-secondary">
                      Task title
                      <input
                        value={task.title}
                        onChange={(event) => patchTask({ title: event.target.value })}
                        className={INPUT}
                      />
                    </label>
                    <label className="block text-[11px] text-text-secondary">
                      Scope
                      <textarea
                        value={task.description}
                        onChange={(event) => patchTask({ description: event.target.value })}
                        className={INPUT}
                        rows={2}
                      />
                    </label>
                    <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                      <label className="block text-[11px] text-text-secondary">
                        Owned paths, comma separated
                        <input
                          value={task.ownedPaths.join(", ")}
                          onChange={(event) =>
                            patchTask({
                              ownedPaths: event.target.value
                                .split(",")
                                .map((value) => value.trim()),
                            })
                          }
                          className={INPUT}
                        />
                      </label>
                      <label className="block text-[11px] text-text-secondary">
                        Depends on task keys
                        <input
                          value={task.dependsOn.join(", ")}
                          onChange={(event) =>
                            patchTask({
                              dependsOn: event.target.value
                                .split(",")
                                .map((value) => value.trim())
                                .filter(Boolean),
                            })
                          }
                          className={INPUT}
                        />
                      </label>
                    </div>
                  </div>
                );
              })}
            </fieldset>
          ))}
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              disabled={locked}
              onClick={applyPreview}
              className="flex items-center gap-1 rounded border border-accent-purple/30 bg-accent-purple/10 px-3 py-1.5 text-xs font-medium text-accent-purple disabled:opacity-40"
            >
              <CheckCircle2 size={12} /> Apply reviewed plan
            </button>
            <button
              type="button"
              onClick={() => setDraft(null)}
              className="rounded px-3 py-1.5 text-xs text-text-secondary"
            >
              Close preview
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
