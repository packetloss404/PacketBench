import { create } from "zustand";
import { generateId as genId } from "@/lib/storage";
import { loadPersistedState, saveFlightsSlice, saveUiSlice } from "@/lib/tauri";
import type { CoordinationEvent, Flight, FlightStatus } from "@/types/flight";
import {
  flightLifecycleStatus,
  attemptHasActiveWork,
  flightOwnedSessionIds,
} from "@/lib/flightLifecycle";
import { useAgentApprovalStore } from "@/stores/agentApprovalStore";
import { useAgentTaskStore } from "@/stores/agentTaskStore";
import { validateCooperativeGraph } from "@/lib/cooperativeFlight";
import {
  hasFlightPlanExecution,
  materializeFlightPlan,
  type FlightPlanInput,
} from "@/lib/flightPlanning";
import { derivedArtifactProvenance } from "@/lib/provenance";
import { useIssueStore } from "@/stores/issueStore";

type FlightState = {
  flights: Flight[];
  activeFlightId: string | null;
};

const generateId = (prefix: string) => genId(prefix);

function loadState(): FlightState {
  // Backend is the sole source of truth; real data arrives via hydrateFromBackend.
  return { flights: [], activeFlightId: null };
}

let persistenceTail: Promise<void> = Promise.resolve();
let latestPersistence: Promise<void> = Promise.resolve();

function saveState(state: FlightState) {
  // Serialize whole-slice writes in the same order as the local mutations that
  // produced them. Flight launch explicitly flushes this queue before asking
  // Rust to append an Attempt, so a freshly-created Flight cannot race its
  // first launch and a delayed older snapshot cannot land afterwards.
  const snapshot = { flights: [...state.flights], activeFlightId: state.activeFlightId };
  const job = persistenceTail.then(() => syncFlightsToBackend(snapshot));
  latestPersistence = job;
  persistenceTail = job.catch((err) => {
    console.warn("[flightStore.persist] swallowed error:", err);
  });
}

async function syncFlightsToBackend(state: FlightState) {
  await saveFlightsSlice(state.flights);
  await saveUiSlice({ selectedFlightId: state.activeFlightId });
}

// === Helpers ===

function planIdentity(flight: Pick<Flight, "milestones">): string {
  return JSON.stringify(
    flight.milestones
      .map((milestone) => ({
        id: milestone.id,
        tasks: milestone.tasks
          .map((task) => ({
            id: task.id,
            milestoneId: task.milestoneId,
            dependsOn: [...task.dependsOn].sort(),
          }))
          .sort((a, b) => a.id.localeCompare(b.id)),
      }))
      .sort((a, b) => a.id.localeCompare(b.id)),
  );
}

function sameIds(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((id, index) => id === right[index]);
}

function reconcileIssueIdsFromIssues(
  flights: Flight[],
  touchUpdatedAt: boolean,
): { flights: Flight[]; changed: boolean } {
  if (flights.length === 0) return { flights, changed: false };

  const flightIds = new Set(flights.map((flight) => flight.id));
  const issueIdsByFlight = new Map<string, string[]>();

  for (const issue of useIssueStore.getState().issues) {
    if (!issue.flightId || !flightIds.has(issue.flightId)) continue;
    const issueIds = issueIdsByFlight.get(issue.flightId) ?? [];
    if (!issueIds.includes(issue.id)) {
      issueIds.push(issue.id);
    }
    issueIdsByFlight.set(issue.flightId, issueIds);
  }

  let changed = false;
  const now = touchUpdatedAt ? Date.now() : null;
  const reconciled = flights.map((flight) => {
    const issueIds = issueIdsByFlight.get(flight.id) ?? [];
    if (sameIds(flight.issueIds, issueIds)) return flight;
    changed = true;
    return {
      ...flight,
      issueIds,
      updatedAt: now ?? flight.updatedAt,
    };
  });

  return { flights: reconciled, changed };
}

// === Store ===

interface FlightStore {
  flights: Flight[];
  activeFlightId: string | null;

  // Flight CRUD
  addFlight: (
    flight: Pick<Flight, "title" | "objective" | "priority" | "projectPath"> &
      Partial<
        Pick<
          Flight,
          | "gitBranch"
          | "executionTarget"
          | "issueIds"
          | "workspaceId"
          | "publishAttemptsAsPrs"
          | "reviewGatePolicy"
          | "executionMode"
          | "integrationBranch"
          | "autonomyMode"
          | "autonomyPolicy"
          | "autonomyRuntime"
        >
      >,
  ) => Flight;
  updateFlight: (id: string, updates: Partial<Flight>) => void;
  applyFlightPlan: (id: string, plan: FlightPlanInput) => void;
  archiveFlight: (id: string) => void;
  unarchiveFlight: (id: string) => void;
  /** Wait for every Flight mutation queued before this call to reach Rust. */
  flushPersistence: () => Promise<void>;
  /** N2: append a coordination event (task_failed / escalation suggestion / …)
   *  to a flight's timeline, surfaced in FlightsView's coordination log. */
  appendCoordinationEvent: (
    flightId: string,
    event: Omit<CoordinationEvent, "id" | "flightId" | "timestamp">,
  ) => void;
  /**
   * Drop the Flight record and unlink its issues. This is the *record*
   * delete only — it does not touch running attempts.
   *
   * UI delete paths must go through
   * `useAsyncFlightStore.getState().deleteFlightWithAttemptCleanup(id)`,
   * which cancels non-terminal attempts (closing their sessions and removing
   * their worktrees) and then calls this. Calling this directly abandons that
   * work; it stays separate so the cleanup fan-out can live next to the
   * attempt lifecycle without a circular store import.
   */
  deleteFlight: (id: string) => void;
  setActiveFlight: (id: string | null) => void;

  // Issue linking
  addIssueToFlight: (flightId: string, issueId: string) => void;
  removeIssueFromFlight: (flightId: string, issueId: string) => void;

  // Computed status
  computeFlightStatus: (flightId: string) => FlightStatus;
  // `issueIds` is a legacy frontend cache; Rust flights do not round-trip it.
  reconcileIssueLinks: (options?: { persist?: boolean; touchUpdatedAt?: boolean }) => void;
  hydrateFromBackend: (persisted?: Awaited<ReturnType<typeof loadPersistedState>>) => Promise<void>;
  /** Apply an executor cost/token delta from Rust's `flight:cost-updated`
   *  event (see bootstrap's listener) onto the in-memory flight so the
   *  autonomy budget hard-stop, launch guardrail, and cost UI track spend
   *  live instead of waiting for the next hydrateFromBackend. Deliberately
   *  does NOT saveState(): Rust already persisted the accumulation in
   *  accumulate_executor_cost, and the backend merge takes max() anyway. */
  applyBackendCostDelta: (flightId: string, totalTokens: number, costUsd: number) => void;
}

const initial = loadState();

export const useFlightStore = create<FlightStore>((set, get) => ({
  ...initial,

  addFlight: (input) => {
    const state = get();
    const newFlight: Flight = {
      id: generateId("flight"),
      title: input.title,
      objective: input.objective,
      status: "draft",
      priority: input.priority,
      projectPath: input.projectPath,
      workspaceId: input.workspaceId ?? null,
      gitBranch: input.gitBranch,
      executionTarget: input.executionTarget,
      milestones: [],
      linkedSessionIds: [],
      issueIds: input.issueIds ?? [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
      totalCost: 0,
      totalTokens: 0,
      publishAttemptsAsPrs: input.publishAttemptsAsPrs ?? false,
      reviewGatePolicy: input.reviewGatePolicy,
      executionMode: input.executionMode,
      integrationBranch: input.integrationBranch,
      autonomyMode: input.autonomyMode,
      autonomyPolicy: input.autonomyPolicy,
      autonomyRuntime: input.autonomyRuntime,
    };
    const newState: FlightState = {
      flights: [...state.flights, newFlight],
      activeFlightId: state.activeFlightId,
    };
    set({ flights: newState.flights });
    saveState(newState);
    return newFlight;
  },

  updateFlight: (id, updates) => {
    const current = get().flights.find((flight) => flight.id === id);
    if (
      current &&
      updates.milestones &&
      hasFlightPlanExecution(current) &&
      planIdentity(current) !== planIdentity({ milestones: updates.milestones })
    ) {
      throw new Error(
        "The task plan cannot be replaced after execution starts. Create a new Flight for a revised graph.",
      );
    }
    set((s) => {
      const flights = s.flights.map((f) =>
        f.id === id ? { ...f, ...updates, updatedAt: Date.now() } : f,
      );
      saveState({ flights, activeFlightId: s.activeFlightId });
      return { flights };
    });
  },

  applyFlightPlan: (id, plan) => {
    const flight = get().flights.find((candidate) => candidate.id === id);
    if (!flight) throw new Error("This Flight no longer exists.");
    if (flight.archivedAt || hasFlightPlanExecution(flight))
      throw new Error(
        "The task plan cannot be replaced after execution starts. Create a new Flight for a revised graph.",
      );
    const materialized = materializeFlightPlan(id, plan);
    const issues = validateCooperativeGraph({ ...flight, milestones: materialized.milestones });
    if (issues.length) throw new Error(issues[0].message);
    const previous = new Map(
      flight.milestones.flatMap((milestone) => milestone.tasks).map((task) => [task.id, task]),
    );
    get().updateFlight(id, {
      title: materialized.title ?? flight.title,
      objective: materialized.objective ?? flight.objective,
      status: "ready",
      milestones: materialized.milestones.map((milestone) => ({
        ...milestone,
        tasks: milestone.tasks.map((task) => {
          const old = previous.get(task.id);
          return old
            ? {
                ...task,
                agentConfigId: old.agentConfigId,
                model: old.model,
                createdAt: old.createdAt,
              }
            : task;
        }),
      })),
    });
  },

  archiveFlight: (id) => {
    const flight = get().flights.find((candidate) => candidate.id === id);
    if (!flight) throw new Error("This Flight no longer exists.");
    if (
      useAgentTaskStore
        .getState()
        .conversations.some(
          (conversation) =>
            conversation.status === "active" &&
            flightOwnedSessionIds(flight).includes(conversation.id),
        ) ||
      (flight.attempts ?? []).some(attemptHasActiveWork) ||
      flight.milestones.some((milestone) =>
        milestone.tasks.some((task) => ["queued", "running"].includes(task.status)),
      )
    )
      throw new Error(
        "Stop the Flight before archiving it. Worktrees and history will be preserved.",
      );
    get().updateFlight(id, { archivedAt: Date.now() });
  },
  unarchiveFlight: (id) => get().updateFlight(id, { archivedAt: undefined }),

  flushPersistence: () => latestPersistence,

  appendCoordinationEvent: (flightId, event) => {
    set((s) => {
      let changed = false;
      const flights = s.flights.map((f) => {
        if (f.id !== flightId) return f;
        changed = true;
        const full: CoordinationEvent = {
          ...event,
          id: generateId("coord"),
          flightId,
          timestamp: Date.now(),
        };
        full.provenance =
          event.provenance ??
          derivedArtifactProvenance(
            full.id,
            `Flight coordination · ${full.type}`,
            [],
            full.timestamp,
          );
        return { ...f, coordinationLog: [...(f.coordinationLog ?? []), full] };
      });
      if (!changed) return {};
      saveState({ flights, activeFlightId: s.activeFlightId });
      return { flights };
    });
  },

  deleteFlight: (id) => {
    // Clear flightId from any linked issues before removing the flight
    const flight = get().flights.find((f) => f.id === id);
    if (flight && flight.issueIds) {
      const { assignToFlight } = useIssueStore.getState();
      for (const issueId of flight.issueIds) {
        assignToFlight(issueId, null);
      }
    }

    set((s) => {
      const flights = s.flights.filter((f) => f.id !== id);
      const activeFlightId = s.activeFlightId === id ? null : s.activeFlightId;
      saveState({ flights, activeFlightId });
      return { flights, activeFlightId };
    });
  },

  setActiveFlight: (id) => {
    set((s) => {
      saveState({ flights: s.flights, activeFlightId: id });
      return { activeFlightId: id };
    });
  },

  // === Issue linking (PacketBench-specific legacy) ===

  addIssueToFlight: (flightId, issueId) => {
    set((s) => {
      const flights = s.flights.map((f) =>
        f.id === flightId && !f.issueIds.includes(issueId)
          ? { ...f, issueIds: [...f.issueIds, issueId], updatedAt: Date.now() }
          : f,
      );
      saveState({ flights, activeFlightId: s.activeFlightId });
      return { flights };
    });
  },

  removeIssueFromFlight: (flightId, issueId) => {
    set((s) => {
      const flights = s.flights.map((f) =>
        f.id === flightId
          ? { ...f, issueIds: f.issueIds.filter((id) => id !== issueId), updatedAt: Date.now() }
          : f,
      );
      saveState({ flights, activeFlightId: s.activeFlightId });
      return { flights };
    });
  },

  // === Computed status ===

  computeFlightStatus: (flightId) => {
    const flight = get().flights.find((f) => f.id === flightId);
    if (!flight) return "draft";
    const approvals = useAgentApprovalStore.getState();
    const pendingApprovalCount = flightOwnedSessionIds(flight).reduce(
      (count, id) =>
        count +
        (approvals.permissions.get(id)?.length ?? 0) +
        (approvals.edits.get(id)?.length ?? 0),
      0,
    );
    const owned = new Set(flightOwnedSessionIds(flight));
    const activeSessionCount = useAgentTaskStore
      .getState()
      .conversations.filter(
        (conversation) => owned.has(conversation.id) && conversation.status === "active",
      ).length;
    return flightLifecycleStatus(flight, { pendingApprovalCount, activeSessionCount });
  },

  reconcileIssueLinks: (options = {}) => {
    const persist = options.persist ?? true;
    const touchUpdatedAt = options.touchUpdatedAt ?? true;

    set((s) => {
      const { flights, changed } = reconcileIssueIdsFromIssues(s.flights, touchUpdatedAt);
      if (!changed) return s;
      if (persist) {
        saveState({ flights, activeFlightId: s.activeFlightId });
      }
      return { flights };
    });
  },

  hydrateFromBackend: async (persisted) => {
    try {
      const state = persisted ?? (await loadPersistedState());
      // F51: merge rather than wholesale-replace so locally-added optimistic
      // flights not yet in the backend snapshot survive hydration. Backend is
      // authoritative for any id it does contain.
      const backendIds = new Set(state.flights.map((f) => f.id));
      const localOnly = get().flights.filter((f) => !backendIds.has(f.id));
      set({
        flights: [...state.flights, ...localOnly],
        activeFlightId: state.ui.selectedFlightId ?? null,
      });
      get().reconcileIssueLinks({ persist: false, touchUpdatedAt: false });
    } catch (err) {
      console.warn("[flightStore.hydrate] swallowed error:", err);
    }
  },

  applyBackendCostDelta: (flightId, totalTokens, costUsd) => {
    set((s) => ({
      flights: s.flights.map((f) =>
        f.id === flightId
          ? {
              ...f,
              totalCost: (f.totalCost ?? 0) + costUsd,
              totalTokens: (f.totalTokens ?? 0) + totalTokens,
            }
          : f,
      ),
    }));
  },
}));
