import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { apiAgentDoneEvent, apiAgentErrorEvent } from "@/lib/events";
import { notifyAttemptCompleted } from "@/lib/notifications";
import { recordAttemptFailure } from "@/lib/flightCoordination";
import { useFlightStore } from "@/stores/flightStore";
import type { Attempt, AttemptStatus } from "@/types/flight";

const attemptTerminalCleanups = new Map<string, UnlistenFn[]>();
const attemptTerminalInstalls = new Map<string, Promise<void>>();

function patchAttempt(flightId: string, attemptId: string, patch: Partial<Attempt>) {
  const flight = useFlightStore.getState().flights.find((f) => f.id === flightId);
  if (!flight || !flight.attempts) return;
  const next = flight.attempts.map((a) => (a.id === attemptId ? { ...a, ...patch } : a));
  useFlightStore.getState().updateFlight(flightId, { attempts: next });
}

function attemptLabel(attempt: Attempt): string {
  return attempt.target.kind === "ssh" ? attempt.target.serverId : "local";
}

function currentActiveAttempt(
  flightId: string,
  attemptId: string,
  sessionId: string,
): Attempt | undefined {
  const flight = useFlightStore.getState().flights.find((f) => f.id === flightId);
  if (!flight || flight.stoppedAt != null) return;
  return flight.attempts?.find(
    (a) => a.id === attemptId && a.sessionId === sessionId && terminalStatusIsActive(a.status),
  );
}

function terminalStatusIsActive(status: AttemptStatus | undefined): boolean {
  return status === "running" || status === "provisioning";
}

async function transitionAttemptStatus(
  flightId: string,
  attemptId: string,
  sessionId: string,
  status: Extract<AttemptStatus, "reviewing" | "failed">,
  errorMessage?: string,
) {
  const { markAttemptStatus } = await import("@/lib/tauri");
  if (!currentActiveAttempt(flightId, attemptId, sessionId)) return false;
  await markAttemptStatus(flightId, attemptId, status);
  if (!currentActiveAttempt(flightId, attemptId, sessionId)) return false;
  if (status === "failed")
    return reconcileRetainedBuilder(flightId, attemptId, sessionId, status, errorMessage);
  patchAttempt(flightId, attemptId, {
    status,
    ...(errorMessage ? { errorMessage } : {}),
  });
  return true;
}

async function reconcileRetainedBuilder(
  flightId: string,
  attemptId: string,
  sessionId: string,
  status: "failed" | "cancelled",
  errorMessage?: string,
): Promise<boolean> {
  if (!currentActiveAttempt(flightId, attemptId, sessionId)) return false;
  // The terminal event follows native retention. Never call the destructive
  // cancel/discard command, and never let a delayed old owner replace a resume.
  const { loadPersistedState } = await import("@/lib/tauri");
  const snapshot = await loadPersistedState();
  if (!currentActiveAttempt(flightId, attemptId, sessionId)) return false;
  const savedFlight = snapshot.flights.find((flight) => flight.id === flightId);
  const savedAttempt = savedFlight?.attempts?.find(
    (attempt) => attempt.id === attemptId && attempt.sessionId === sessionId,
  );
  if (savedAttempt?.status !== status) return false;
  useFlightStore.setState((state) => ({
    flights: state.flights.map((flight) => {
      if (flight.id !== flightId || !currentActiveAttempt(flightId, attemptId, sessionId))
        return flight;
      return {
        ...flight,
        attempts: flight.attempts?.map((attempt) =>
          attempt.id === attemptId
            ? { ...savedAttempt, ...(errorMessage ? { errorMessage } : {}) }
            : attempt,
        ),
        milestones: flight.milestones.map((milestone) => ({
          ...milestone,
          tasks: milestone.tasks.map((task) =>
            task.id === savedAttempt.taskId ? { ...task, status, sessionId } : task,
          ),
        })),
      };
    }),
  }));
  detachAttemptTerminalListeners(sessionId);
  return true;
}

export function detachAttemptTerminalListeners(sessionId: string) {
  const unlisteners = attemptTerminalCleanups.get(sessionId);
  if (!unlisteners) return;
  attemptTerminalCleanups.delete(sessionId);
  attemptTerminalInstalls.delete(sessionId);
  for (const unlisten of unlisteners) {
    try {
      unlisten();
    } catch {
      // best-effort detach
    }
  }
}

async function ensureAttemptTerminalListeners(flightId: string, attempt: Attempt): Promise<void> {
  const pending = attemptTerminalInstalls.get(attempt.sessionId);
  if (pending) return pending;
  if (attemptTerminalCleanups.has(attempt.sessionId)) return;

  const unlisteners: UnlistenFn[] = [];
  attemptTerminalCleanups.set(attempt.sessionId, unlisteners);

  const doneReady = listen<{ cancelled?: boolean }>(
    apiAgentDoneEvent(attempt.sessionId),
    (event) => {
      if (event.payload?.cancelled) {
        void reconcileRetainedBuilder(flightId, attempt.id, attempt.sessionId, "cancelled").catch(
          (error) => console.warn("Failed to reconcile stopped Flight builder:", error),
        );
        return;
      }
      // Defer one macrotask so the normal api-agent conversation listener can
      // finalize the assistant message first. The attempt transition is owned
      // here, not by AttemptTile, so it survives route changes and unmounted UI.
      setTimeout(() => {
        if (!currentActiveAttempt(flightId, attempt.id, attempt.sessionId)) return;

        void transitionAttemptStatus(flightId, attempt.id, attempt.sessionId, "reviewing")
          .then((changed) => {
            if (!changed) return;
            const flight = useFlightStore.getState().flights.find((f) => f.id === flightId);
            if (flight) void notifyAttemptCompleted(flight.title, attemptLabel(attempt));
          })
          .catch((error) => console.warn("Failed to reconcile Flight completion:", error));
      }, 0);
    },
  ).then((unlisten) => {
    if (attemptTerminalCleanups.get(attempt.sessionId) === unlisteners) {
      unlisteners.push(unlisten);
    } else {
      unlisten();
    }
  });

  const errorReady = listen<{ message?: string }>(
    apiAgentErrorEvent(attempt.sessionId),
    (event) => {
      if (!currentActiveAttempt(flightId, attempt.id, attempt.sessionId)) return;

      void transitionAttemptStatus(
        flightId,
        attempt.id,
        attempt.sessionId,
        "failed",
        event.payload?.message,
      )
        .then((changed) => {
          if (!changed) return;
          recordAttemptFailure(flightId, attempt.id, event.payload?.message);
          detachAttemptTerminalListeners(attempt.sessionId);
        })
        .catch((error) => console.warn("Failed to reconcile Flight error:", error));
    },
  ).then((unlisten) => {
    if (attemptTerminalCleanups.get(attempt.sessionId) === unlisteners) {
      unlisteners.push(unlisten);
    } else {
      unlisten();
    }
  });

  const ready = Promise.all([doneReady, errorReady]).then(() => undefined);
  attemptTerminalInstalls.set(attempt.sessionId, ready);
  try {
    await ready;
  } catch (error) {
    if (attemptTerminalCleanups.get(attempt.sessionId) === unlisteners)
      detachAttemptTerminalListeners(attempt.sessionId);
    throw error;
  } finally {
    if (attemptTerminalInstalls.get(attempt.sessionId) === ready)
      attemptTerminalInstalls.delete(attempt.sessionId);
  }
}

export async function syncAsyncAttemptTerminalListeners(
  flights = useFlightStore.getState().flights,
): Promise<void> {
  const activeSessionIds = new Set<string>();
  const registrations: Promise<void>[] = [];
  for (const flight of flights) {
    if (flight.stoppedAt != null) continue;
    for (const attempt of flight.attempts ?? []) {
      if (!terminalStatusIsActive(attempt.status)) continue;
      activeSessionIds.add(attempt.sessionId);
      registrations.push(ensureAttemptTerminalListeners(flight.id, attempt));
    }
  }

  for (const sessionId of Array.from(attemptTerminalCleanups.keys())) {
    if (!activeSessionIds.has(sessionId)) {
      detachAttemptTerminalListeners(sessionId);
    }
  }

  await Promise.all(registrations);
}

if (typeof useFlightStore.subscribe === "function") {
  useFlightStore.subscribe((state) => {
    void syncAsyncAttemptTerminalListeners(state.flights).catch((error) =>
      console.warn("Failed to register Flight terminal listeners:", error),
    );
  });
}
