import type { Flight } from "@/types/flight";

/**
 * F3 residual: a conversation that is the runtime-owned builder or reviewer for
 * a Flight attempt. Transcript mutation/fork must be disabled on these so a
 * rewind cannot evade the Flight's review/scope/cost identity. A Flight's
 * *planning* conversation is deliberately excluded — it is an ordinary
 * read-only conversation, not the approved run.
 */
export function isFlightOwnedConversation(conversationId: string, flights: Flight[]): boolean {
  for (const flight of flights) {
    for (const attempt of flight.attempts ?? []) {
      if (attempt.sessionId === conversationId) return true;
      const gate = attempt.reviewGate;
      if (gate?.reviewerConversationId === conversationId) return true;
      if (gate?.reviewerSessions?.some((session) => session.sessionId === conversationId)) {
        return true;
      }
    }
  }
  return false;
}
