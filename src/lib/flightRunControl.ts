/** A Stop revokes work admitted before it, including asynchronous provider startup. */
const generations = new Map<string, number>();
const startups = new Map<string, Set<Promise<void>>>();

export function revokeFlightStarts(flightId: string): void {
  generations.set(flightId, (generations.get(flightId) ?? 0) + 1);
}

export function registerFlightStartup(flightId: string): {
  isCurrent: () => boolean;
  finish: () => void;
} {
  const generation = generations.get(flightId) ?? 0;
  let resolve!: () => void;
  const pending = new Promise<void>((done) => {
    resolve = done;
  });
  const owned = startups.get(flightId) ?? new Set<Promise<void>>();
  owned.add(pending);
  startups.set(flightId, owned);
  let finished = false;
  return {
    isCurrent: () => generation === (generations.get(flightId) ?? 0),
    finish: () => {
      if (finished) return;
      finished = true;
      owned.delete(pending);
      if (owned.size === 0) startups.delete(flightId);
      resolve();
    },
  };
}

export async function drainFlightStartups(flightId: string): Promise<void> {
  while (startups.get(flightId)?.size) {
    await Promise.all([...startups.get(flightId)!]);
  }
}
