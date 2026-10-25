import { create } from "zustand";

/**
 * F4: coarse, honest launch progress for the Agents launcher.
 *
 * `ready` is a prepared draft awaiting Start; `cancelling` is a Stop whose
 * backend acknowledgement is still outstanding; `unknown` is a start whose
 * backend outcome could not be confirmed (never reported as success). The
 * phases are labels only — no numeric percentage unless the backend supplies
 * measurable progress.
 */
export type LaunchPhase =
  | "idle"
  | "preparing"
  | "ready"
  | "starting"
  | "cancelling"
  | "running"
  | "failed"
  | "unknown";

interface LaunchOperation {
  phase: LaunchPhase;
  /** The current draft revision (bumped on an explicit user/context change). */
  revision: number;
  /** The revision the in-flight operation started for, or null when none. */
  activeRevision: number | null;
  error: string | null;
}

interface AgentLaunchStore {
  launch: LaunchOperation;
  /**
   * Begin a launch for a draft revision. Returns false — changing nothing —
   * when an operation is already in flight for the SAME revision, so a repeated
   * Enter/click (even across a remount) yields ONE operation/run/worktree. A
   * bumped revision (an explicit user/context change) starts a distinct
   * operation.
   */
  begin: (revision: number) => boolean;
  setPhase: (phase: LaunchPhase, error?: string | null) => void;
  /** An explicit user/context change bumps the draft revision. */
  bumpRevision: () => number;
  reset: () => void;
}

const IDLE: LaunchOperation = {
  phase: "idle",
  revision: 0,
  activeRevision: null,
  error: null,
};

export const useAgentLaunchStore = create<AgentLaunchStore>((set, get) => ({
  launch: IDLE,
  begin: (revision) => {
    const { launch } = get();
    const inFlight = launch.phase !== "idle" && launch.phase !== "failed";
    // Refuse a duplicate Start only for the SAME in-flight revision; a bumped
    // revision starts a distinct operation.
    if (inFlight && launch.activeRevision === revision) return false;
    set({ launch: { phase: "preparing", revision, activeRevision: revision, error: null } });
    return true;
  },
  setPhase: (phase, error = null) =>
    set((s) => ({
      launch: {
        ...s.launch,
        phase,
        error,
        activeRevision:
          phase === "idle" || phase === "failed" ? null : s.launch.activeRevision,
      },
    })),
  bumpRevision: () => {
    const revision = get().launch.revision + 1;
    set((s) => ({ launch: { ...s.launch, revision } }));
    return revision;
  },
  reset: () => set({ launch: IDLE }),
}));
