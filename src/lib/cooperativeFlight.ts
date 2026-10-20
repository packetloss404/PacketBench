import { claimedPathsOverlap, normalizeClaimedPath } from "@/lib/pathCollisions";
import type { Attempt, Flight, Task } from "@/types/flight";
import { APP_NAME } from "@/lib/brand";

export type CooperativeTaskState =
  | "blocked"
  | "ready"
  | "running"
  | "review"
  | "integrated"
  | "failed";

export interface CooperativeGraphIssue {
  kind:
    | "duplicate_task"
    | "missing_dependency"
    | "self_dependency"
    | "dependency_cycle"
    | "missing_assignment"
    | "missing_model"
    | "missing_owned_paths"
    | "ownership_conflict";
  taskId: string;
  relatedTaskId?: string;
  message: string;
}

export interface CooperativeTaskView {
  task: Task;
  state: CooperativeTaskState;
  attempt?: Attempt;
  blockedBy: string[];
}

export function cooperativeTasks(flight: Flight): Task[] {
  return flight.milestones.flatMap((milestone) => milestone.tasks);
}

function latestAttemptByTask(flight: Flight): Map<string, Attempt> {
  const result = new Map<string, Attempt>();
  for (const attempt of flight.attempts ?? []) {
    if (!attempt.taskId) continue;
    const current = result.get(attempt.taskId);
    if (!current || (attempt.startedAt ?? 0) >= (current.startedAt ?? 0)) {
      result.set(attempt.taskId, attempt);
    }
  }
  return result;
}

function findCycle(tasks: Task[]): string[] | null {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const path: string[] = [];
  const visit = (taskId: string): string[] | null => {
    if (visiting.has(taskId)) {
      const start = path.indexOf(taskId);
      return [...path.slice(start), taskId];
    }
    if (visited.has(taskId)) return null;
    visiting.add(taskId);
    path.push(taskId);
    for (const dependency of byId.get(taskId)?.dependsOn ?? []) {
      if (!byId.has(dependency)) continue;
      const cycle = visit(dependency);
      if (cycle) return cycle;
    }
    path.pop();
    visiting.delete(taskId);
    visited.add(taskId);
    return null;
  };
  for (const task of tasks) {
    const cycle = visit(task.id);
    if (cycle) return cycle;
  }
  return null;
}

export function validateCooperativeGraph(flight: Flight): CooperativeGraphIssue[] {
  const tasks = cooperativeTasks(flight);
  const issues: CooperativeGraphIssue[] = [];
  const byId = new Map<string, Task>();
  for (const task of tasks) {
    if (byId.has(task.id)) {
      issues.push({
        kind: "duplicate_task",
        taskId: task.id,
        message: `Task id '${task.id}' is duplicated.`,
      });
    }
    byId.set(task.id, task);
  }
  for (const task of tasks) {
    for (const dependency of task.dependsOn) {
      if (dependency === task.id) {
        issues.push({
          kind: "self_dependency",
          taskId: task.id,
          relatedTaskId: dependency,
          message: `${task.title} depends on itself.`,
        });
      } else if (!byId.has(dependency)) {
        issues.push({
          kind: "missing_dependency",
          taskId: task.id,
          relatedTaskId: dependency,
          message: `${task.title} depends on missing task '${dependency}'.`,
        });
      }
    }
  }
  const cycle = findCycle(tasks);
  if (cycle) {
    issues.push({
      kind: "dependency_cycle",
      taskId: cycle[0],
      message: `Dependency cycle: ${cycle.join(" → ")}.`,
    });
  }
  return issues;
}

export function validateCooperativeAssignments(flight: Flight): CooperativeGraphIssue[] {
  const tasks = cooperativeTasks(flight);
  const issues: CooperativeGraphIssue[] = [];
  for (const task of tasks) {
    if (!task.agentConfigId || task.agentConfigId === "unassigned") {
      issues.push({
        kind: "missing_assignment",
        taskId: task.id,
        message: `${task.title} needs an agent assignment.`,
      });
    }
    if (!task.model?.trim()) {
      issues.push({
        kind: "missing_model",
        taskId: task.id,
        message: `${task.title} needs a model assignment.`,
      });
    }
    if (!task.ownedPaths?.some((path) => path.trim())) {
      issues.push({
        kind: "missing_owned_paths",
        taskId: task.id,
        message: `${task.title} needs at least one owned path.`,
      });
    }
  }
  for (let leftIndex = 0; leftIndex < tasks.length; leftIndex += 1) {
    const left = tasks[leftIndex];
    for (let rightIndex = leftIndex + 1; rightIndex < tasks.length; rightIndex += 1) {
      const right = tasks[rightIndex];
      // Ordered writers receive the integrated predecessor tree. Only pairs
      // that can execute concurrently must have disjoint ownership.
      if (taskDependsOn(tasks, left.id, right.id) !== taskDependsOn(tasks, right.id, left.id))
        continue;
      for (const leftRaw of left.ownedPaths ?? []) {
        for (const rightRaw of right.ownedPaths ?? []) {
          const leftPath = normalizeClaimedPath(leftRaw);
          const rightPath = normalizeClaimedPath(rightRaw);
          if (!leftPath || !rightPath || !claimedPathsOverlap(leftPath, rightPath)) continue;
          issues.push({
            kind: "ownership_conflict",
            taskId: left.id,
            relatedTaskId: right.id,
            message: `${left.title} and ${right.title} have overlapping ownership (${leftRaw} ↔ ${rightRaw}).`,
          });
        }
      }
    }
  }
  return issues;
}

export function taskDependsOn(tasks: Task[], taskId: string, dependencyId: string): boolean {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const pending = [...(byId.get(taskId)?.dependsOn ?? [])];
  const visited = new Set<string>();
  while (pending.length) {
    const id = pending.pop()!;
    if (visited.has(id)) continue;
    visited.add(id);
    if (id === dependencyId) return true;
    pending.push(...(byId.get(id)?.dependsOn ?? []));
  }
  return false;
}

export function selectCooperativeTaskViews(flight: Flight): CooperativeTaskView[] {
  const tasks = cooperativeTasks(flight);
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const attempts = latestAttemptByTask(flight);
  return tasks.map((task) => {
    const blockedBy = task.dependsOn.filter(
      (dependency) => byId.get(dependency)?.status !== "done",
    );
    const attempt = attempts.get(task.id);
    let state: CooperativeTaskState;
    if (task.status === "done") state = "integrated";
    else if (attempt?.status === "failed" || task.status === "failed") state = "failed";
    else if (attempt?.status === "reviewing") state = "review";
    else if (attempt && ["queued", "provisioning", "running"].includes(attempt.status)) {
      state = "running";
    } else if (blockedBy.length > 0) state = "blocked";
    else state = "ready";
    return { task, state, attempt, blockedBy };
  });
}

export function selectReadyCooperativeTasks(flight: Flight): Task[] {
  if (validateCooperativeGraph(flight).length > 0) return [];
  return selectCooperativeTaskViews(flight)
    .filter((view) => view.state === "ready")
    .map((view) => view.task);
}

export function buildCooperativeTaskPrompt(flight: Flight, task: Task): string {
  const allTasks = cooperativeTasks(flight);
  const dependencySummaries = task.dependsOn
    .map((id) => allTasks.find((candidate) => candidate.id === id))
    .filter((dependency): dependency is Task => Boolean(dependency))
    .map((dependency) => `- ${dependency.title}: integrated`)
    .join("\n");
  const milestone = flight.milestones.find((candidate) => candidate.id === task.milestoneId);
  return `Work on one cooperative Flight task in an isolated worktree.

Flight objective:
${flight.objective}

Task:
${task.title}
${task.description}

Role: ${task.role ?? "builder"}
Owned paths:
${(task.ownedPaths ?? []).map((path) => `- ${path}`).join("\n")}

Dependencies already integrated:
${dependencySummaries || "- none"}

Acceptance criteria:
${(milestone?.validationCriteria ?? []).map((criterion) => `- ${criterion}`).join("\n")}

Stay within the owned paths unless a necessary cross-cutting change is explicitly explained. Run appropriate checks and commit all changes before finishing; ${APP_NAME} can integrate only a clean committed branch.`;
}
