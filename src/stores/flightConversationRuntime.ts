import { registerFlightStartup } from "@/lib/flightRunControl";
import { flightOwnedSessionIds } from "@/lib/flightLifecycle";

/** Project an admitted repair turn before provider output can arrive. Native
 * admission remains authoritative; this also installs the next done listener. */
export async function runFlightConversationTurn(
  sessionId: string,
  dispatch: () => Promise<void>,
): Promise<void> {
  const { useFlightStore } = await import("@/stores/flightStore");
  const flight = useFlightStore
    .getState()
    .flights.find((candidate) => flightOwnedSessionIds(candidate).includes(sessionId));
  if (!flight) return dispatch();
  const ticket = registerFlightStartup(flight.id);
  const ensureCurrent = () => {
    const latest = useFlightStore
      .getState()
      .flights.find((candidate) => candidate.id === flight.id);
    if (!ticket.isCurrent() || !latest || latest.stoppedAt || latest.archivedAt || latest.delivery)
      throw new Error(
        "This Flight is stopped, archived or delivered. Resume retained work explicitly or create a new Flight.",
      );
    return latest;
  };
  try {
    const latest = ensureCurrent();
    if (
      (latest.attempts ?? []).some((attempt) =>
        attempt.sessionHistory?.some((session) => session.sessionId === sessionId),
      )
    )
      throw new Error(
        "This builder session was replaced during recovery. Open the current attempt to continue; its history remains readable.",
      );
    const builder = latest.attempts?.find((attempt) => attempt.sessionId === sessionId);
    if (builder && ["completed", "failed", "cancelled"].includes(builder.status))
      throw new Error("Resume retained work explicitly before sending another builder turn.");
    if (builder?.status === "reviewing") {
      useFlightStore.setState((state) => ({
        flights: state.flights.map((candidate) =>
          candidate.id === flight.id
            ? {
                ...candidate,
                attempts: candidate.attempts?.map((attempt) =>
                  attempt.id === builder.id
                    ? {
                        ...attempt,
                        status: "running" as const,
                        reviewGate: attempt.reviewGate
                          ? {
                              ...attempt.reviewGate,
                              status: "error" as const,
                              evidence: undefined,
                              report: undefined,
                              overriddenAt: undefined,
                              overrideReason: undefined,
                              errorMessage:
                                "Builder follow-up started; review the new result before accepting.",
                            }
                          : undefined,
                        completedAt: undefined,
                      }
                    : attempt,
                ),
              }
            : candidate,
        ),
      }));
      const { syncAsyncAttemptTerminalListeners } =
        await import("@/stores/asyncAttemptTerminalListeners");
      await syncAsyncAttemptTerminalListeners(useFlightStore.getState().flights);
      ensureCurrent();
    }
    await dispatch();
  } catch (error) {
    await useFlightStore
      .getState()
      .hydrateFromBackend()
      .catch(() => undefined);
    throw error;
  } finally {
    ticket.finish();
  }
}
