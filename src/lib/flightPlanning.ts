import { APP_NAME, APP_NAME_LOWER } from "@/lib/brand";
import type { AgentMessage } from "@/types/agent-conversation";
import type { Flight, Milestone, TaskRole, TaskType } from "@/types/flight";

export const FLIGHT_PLANNING_ALLOWED_TOOLS = ["read_file", "list_directory", "grep"];
export const FLIGHT_PLAN_FENCE = `${APP_NAME_LOWER}-flight-plan`;

const TASK_TYPES = new Set<TaskType>([
  "implementation",
  "testing",
  "review",
  "validation",
  "research",
  "refactor",
  "documentation",
]);
const TASK_ROLES = new Set<TaskRole>(["coordinator", "builder", "reviewer", "scout"]);

interface PlanTaskInput {
  key: string;
  title: string;
  description: string;
  type: TaskType;
  role?: TaskRole;
  dependsOn: string[];
  ownedPaths: string[];
}

interface PlanMilestoneInput {
  key: string;
  title: string;
  description: string;
  validationCriteria: string[];
  tasks: PlanTaskInput[];
}

export interface FlightPlanInput {
  title?: string;
  objective?: string;
  milestones: PlanMilestoneInput[];
}

export interface MaterializedFlightPlan {
  title?: string;
  objective?: string;
  milestones: Milestone[];
  taskCount: number;
}

function nonEmpty(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${label} must be a non-empty string.`);
  }
  return value.trim();
}

function stringList(value: unknown, label: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw new Error(`${label} must be an array of strings.`);
  }
  return value.map((entry) => entry.trim()).filter(Boolean);
}

function readOptionalString(value: unknown, label: string): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  return nonEmpty(value, label);
}

function validatePlan(value: unknown): FlightPlanInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("The plan must be a JSON object.");
  }
  const raw = value as Record<string, unknown>;
  if (!Array.isArray(raw.milestones) || raw.milestones.length === 0) {
    throw new Error("The plan must contain at least one milestone.");
  }
  if (raw.milestones.length > 12) throw new Error("A plan may contain at most 12 milestones.");

  const milestoneKeys = new Set<string>();
  const taskKeys = new Set<string>();
  let totalTasks = 0;
  const milestones = raw.milestones.map((entry, milestoneIndex): PlanMilestoneInput => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error(`Milestone ${milestoneIndex + 1} must be an object.`);
    }
    const milestone = entry as Record<string, unknown>;
    const key = nonEmpty(milestone.key, `Milestone ${milestoneIndex + 1} key`);
    if (milestoneKeys.has(key)) throw new Error(`Duplicate milestone key: ${key}.`);
    milestoneKeys.add(key);
    if (!Array.isArray(milestone.tasks) || milestone.tasks.length === 0) {
      throw new Error(`Milestone ${key} must contain at least one task.`);
    }
    const tasks = milestone.tasks.map((taskEntry, taskIndex): PlanTaskInput => {
      if (!taskEntry || typeof taskEntry !== "object" || Array.isArray(taskEntry)) {
        throw new Error(`Task ${taskIndex + 1} in milestone ${key} must be an object.`);
      }
      const task = taskEntry as Record<string, unknown>;
      const taskKey = nonEmpty(task.key, `Task ${taskIndex + 1} key`);
      if (taskKeys.has(taskKey)) throw new Error(`Duplicate task key: ${taskKey}.`);
      taskKeys.add(taskKey);
      const type = nonEmpty(task.type, `Task ${taskKey} type`) as TaskType;
      if (!TASK_TYPES.has(type)) throw new Error(`Task ${taskKey} has unsupported type: ${type}.`);
      const roleValue = readOptionalString(task.role, `Task ${taskKey} role`) as
        | TaskRole
        | undefined;
      if (roleValue && !TASK_ROLES.has(roleValue)) {
        throw new Error(`Task ${taskKey} has unsupported role: ${roleValue}.`);
      }
      totalTasks += 1;
      return {
        key: taskKey,
        title: nonEmpty(task.title, `Task ${taskKey} title`),
        description: nonEmpty(task.description, `Task ${taskKey} description`),
        type,
        role: roleValue,
        dependsOn: stringList(task.dependsOn, `Task ${taskKey} dependsOn`),
        ownedPaths: stringList(task.ownedPaths, `Task ${taskKey} ownedPaths`),
      };
    });
    return {
      key,
      title: nonEmpty(milestone.title, `Milestone ${key} title`),
      description: nonEmpty(milestone.description, `Milestone ${key} description`),
      validationCriteria: stringList(
        milestone.validationCriteria,
        `Milestone ${key} validationCriteria`,
      ),
      tasks,
    };
  });

  if (totalTasks > 60) throw new Error("A plan may contain at most 60 tasks.");
  for (const milestone of milestones) {
    for (const task of milestone.tasks) {
      for (const dependency of task.dependsOn) {
        if (!taskKeys.has(dependency)) {
          throw new Error(`Task ${task.key} depends on unknown task key: ${dependency}.`);
        }
        if (dependency === task.key) throw new Error(`Task ${task.key} cannot depend on itself.`);
      }
    }
  }

  return {
    title: readOptionalString(raw.title, "Plan title"),
    objective: readOptionalString(raw.objective, "Plan objective"),
    milestones,
  };
}

function jsonCandidates(content: string): string[] {
  const preferredPattern = new RegExp(`\`\`\`${FLIGHT_PLAN_FENCE}\\s*([\\s\\S]*?)\`\`\``, "gi");
  return [...content.matchAll(preferredPattern)].map((match) => match[1].trim());
}

export function parseLatestFlightPlan(messages: AgentMessage[]): FlightPlanInput {
  let lastError: Error | null = null;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role !== "assistant" || !message.content.trim()) continue;
    for (const candidate of jsonCandidates(message.content)) {
      try {
        return validatePlan(JSON.parse(candidate));
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
      }
    }
  }
  if (lastError) throw new Error(`The latest plan block is invalid: ${lastError.message}`);
  throw new Error(`No \`${FLIGHT_PLAN_FENCE}\` JSON block was found in the planning conversation.`);
}

export function materializeFlightPlan(
  flightId: string,
  plan: FlightPlanInput,
  now = Date.now(),
): MaterializedFlightPlan {
  const taskIds = new Map<string, string>();
  for (const milestone of plan.milestones) {
    for (const task of milestone.tasks)
      taskIds.set(task.key, `${flightId}:task:${encodeURIComponent(task.key)}`);
  }

  const milestones = plan.milestones.map((milestone, milestoneIndex): Milestone => {
    const milestoneId = `${flightId}:milestone:${encodeURIComponent(milestone.key)}`;
    return {
      id: milestoneId,
      flightId,
      title: milestone.title,
      description: milestone.description,
      order: milestoneIndex,
      status: "pending",
      validationCriteria: milestone.validationCriteria,
      tasks: milestone.tasks.map((task, taskIndex) => ({
        id: taskIds.get(task.key)!,
        milestoneId,
        flightId,
        title: task.title,
        description: task.description,
        order: taskIndex,
        status: "pending",
        type: task.type,
        role: task.role,
        ownedPaths: task.ownedPaths.length > 0 ? task.ownedPaths : undefined,
        agentConfigId: "unassigned",
        dependsOn: task.dependsOn.map((key) => taskIds.get(key)!),
        sessionId: null,
        createdAt: now,
        cost: 0,
        tokens: 0,
      })),
    };
  });

  return { title: plan.title, objective: plan.objective, milestones, taskCount: taskIds.size };
}

export function hasFlightPlanExecution(flight: Flight): boolean {
  return Boolean(
    flight.attempts?.length ||
    flight.integrationBranch ||
    flight.delivery ||
    flight.milestones.some((milestone) =>
      milestone.tasks.some(
        (task) =>
          task.sessionId ||
          task.startedAt ||
          task.completedAt ||
          task.cost ||
          task.tokens ||
          !["pending", "blocked"].includes(task.status),
      ),
    ),
  );
}

export function buildFlightPlanningSystemPrompt(flightId: string): string {
  return `You are planning Flight ${flightId} in ${APP_NAME}. Explore the repository with read-only tools, ask the user focused questions when requirements are ambiguous, and iteratively produce an implementation-ready plan. Do not edit files or run commands.

Every complete plan response must end with exactly one fenced \`\`\`${FLIGHT_PLAN_FENCE} JSON block using this schema:
{
  "title": "optional improved flight title",
  "objective": "optional clarified objective",
  "milestones": [{
    "key": "m1",
    "title": "Milestone title",
    "description": "Outcome and scope",
    "validationCriteria": ["observable acceptance criterion"],
    "tasks": [{
      "key": "t1",
      "title": "Task title",
      "description": "Concrete implementation work",
      "type": "implementation|testing|review|validation|research|refactor|documentation",
      "role": "coordinator|builder|reviewer|scout",
      "dependsOn": [],
      "ownedPaths": ["likely/path"]
    }]
  }]
}
\`\`\`

Keys must be unique. Dependencies must reference task keys. Keep the plan under 12 milestones and 60 tasks. Explain important decisions in prose before the block so the user can refine them in normal conversation.`;
}
