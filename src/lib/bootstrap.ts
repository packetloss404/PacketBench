import { listen } from "@tauri-apps/api/event";
import {
  loadPersistedState,
  getCwd,
  pathIsDir,
  saveUiSlice,
  getAppKnownHostsPath,
} from "@/lib/tauri";
import { logSwallowed } from "@/lib/logSwallowed";
import { useWorkspaceStore } from "@/stores/workspaceStore";
import { useAppStore, resolveStartupView } from "@/stores/appStore";
import { useModuleStore } from "@/stores/moduleStore";
import { useAgentStore } from "@/stores/agentStore";
import { useFlightStore } from "@/stores/flightStore";
import { useLayoutStore } from "@/stores/layoutStore";
import { useOrchestrationSettingsStore } from "@/stores/orchestrationSettingsStore";
import { useMemoryStore } from "@/stores/memoryStore";
import { useProjectMemoryStore } from "@/stores/projectMemoryStore";
import { useServerStore } from "@/stores/serverStore";
import { useCliAccountStore } from "@/stores/cliAccountStore";
import { useIssueStore } from "@/stores/issueStore";
import { useRoutingStore } from "@/stores/routingStore";
import { migrateSshTargetsToServers } from "@/lib/sshTargetMigration";
import { startBoundedAutonomyRuntime } from "@/stores/boundedAutonomyRuntime";
import { startCostGuardrailMonitor } from "@/stores/analyticsStore";
import { sampleWorkspaceAgentsDisplayTopology } from "@/stores/workspaceAgentsDogfoodStore";
import { hydrateConversations } from "@/stores/agentConversationPersistence";
import { gcOrphanDraftAssets } from "@/stores/agentDraftStore";

import { storageKey } from "@/lib/brand";
const PROJECT_PATH_KEY = storageKey("project-path");

/** App-lifetime listener for Rust's `flight:cost-updated` event, emitted
 *  after every executor cost accumulation (sidecar `turn_summary` handler and
 *  the in-process rollup in api_agent.rs). Applies the delta to the in-memory
 *  flightStore so the autonomy budget hard-stop, cost guardrail, and cost UI
 *  see spend as it accrues instead of waiting for the next hydrate. Never
 *  unlistened by design; the guard keeps a re-entrant initializeApp (e.g.
 *  StrictMode double-mount) from double-applying deltas. */
let flightCostListenerRegistered = false;

function registerFlightCostListener(): void {
  if (flightCostListenerRegistered) return;
  flightCostListenerRegistered = true;
  void listen<{ flightId: string; totalTokens: number; costUsd: number }>(
    "flight:cost-updated",
    ({ payload }) => {
      useFlightStore
        .getState()
        .applyBackendCostDelta(payload.flightId, payload.totalTokens ?? 0, payload.costUsd ?? 0);
    },
  ).catch((err) => {
    // Registration can fail outside Tauri (tests/browser preview) or during
    // an early native startup failure. Do not leak an unhandled rejection,
    // and allow a later initializeApp call to retry the subscription.
    flightCostListenerRegistered = false;
    logSwallowed("bootstrap.flightCostListener")(err);
  });
}

/** A path inside the app's own build output is never a real project to launch
 *  CLIs in. Adopting it as a default is what historically poisoned the
 *  persisted project path (see `getCwd()` fallback below), so we reject it. */
function looksLikeBuildDir(path: string): boolean {
  const p = path.replace(/\\/g, "/").toLowerCase();
  return p.includes("/src-tauri/target/") || p.endsWith("/src-tauri/target");
}

/**
 * Pick the first candidate that actually exists on disk as a directory.
 * Stale entries (e.g. a project path captured before a folder was renamed
 * or deleted) are skipped so they can't break PTY launches. Clears the
 * persisted `project-path` key when the value it held is no longer valid.
 */
async function resolveValidProjectPath(
  candidates: Array<string | null | undefined>,
): Promise<string | null> {
  for (const candidate of candidates) {
    const path = candidate?.trim();
    if (!path || looksLikeBuildDir(path)) continue;
    try {
      if (await pathIsDir(path)) return path;
    } catch {
      // Backend probe failed — treat as unverifiable and skip.
    }
  }
  // Nothing valid survived; drop a stale persisted value so it doesn't keep
  // resurfacing and re-poisoning the global project path on every launch.
  try {
    localStorage.removeItem(PROJECT_PATH_KEY);
  } catch {
    // localStorage unavailable — fine.
  }
  return null;
}

/**
 * App initialization — called once on mount.
 * Loads persisted state from the Rust backend and hydrates all stores.
 */
export async function initializeApp(): Promise<void> {
  // Conversation files are a separate persistence source from state.v1.json.
  // Start that read concurrently, but do not publish `initialized` until it has
  // completed; sessionGlue relies on both halves being authoritative.
  const conversationsReady = hydrateConversations();
  try {
    const state = await loadPersistedState();

    // Synchronous hydrations — these stores feed the welcome screen and
    // global chrome; render-blocking by design.
    useWorkspaceStore.getState().hydrateFromBackend(state.workspaces);
    useMemoryStore.getState().hydrateFromBackend(state);
    useServerStore.getState().hydrateFromBackend(state.servers);
    // Synchronous: the account list gates PTY launches, so it must be
    // authoritative before the first session picker can be opened.
    useCliAccountStore.getState().hydrateFromBackend(state.cliAccounts, state.cliAccountDefaults);
    useIssueStore.getState().hydrateFromBackend(state.issues);

    // Phase 2: one-time migration of legacy SshTarget records from
    // localStorage into the unified `serverStore`. Runs after hydration so
    // it can merge alongside backend-persisted ServerConfig entries.
    try {
      await migrateSshTargetsToServers();
    } catch (e) {
      console.warn("[bootstrap] SshTarget migration failed:", e);
    }

    // Fetch the app-managed known_hosts path once so buildSshArgs can pin
    // host keys instead of falling back to TOFU. Non-fatal on failure.
    void getAppKnownHostsPath()
      .then((p) => useServerStore.getState().setKnownHostsPath(p))
      .catch((e) => console.warn("[bootstrap] getAppKnownHostsPath failed:", e));

    // Apply theme before doing anything else, so the first paint of the
    // post-bootstrap UI is correctly themed. The view is restored further
    // down — see `startupView`.
    // An empty string is how the backend represents "follow the host zone";
    // both it and a missing key must leave the store's `null` default alone.
    if (typeof state.ui.timeZone === "string" && state.ui.timeZone !== "") {
      useAppStore.getState().setTimeZone(state.ui.timeZone);
    }
    if (state.ui.theme === "dark" || state.ui.theme === "light") {
      useAppStore.getState().setTheme(state.ui.theme);
    }

    // Restore project path: backend settings > localStorage > CWD. Each
    // candidate is validated against the filesystem so a stale path (e.g.
    // captured before a folder was renamed/deleted) can't break PTY launches.
    const backendPath = state.settings.projectPath;
    const localPath = localStorage.getItem(PROJECT_PATH_KEY);
    let cwd: string | null = null;
    try {
      cwd = await getCwd();
    } catch {
      // no CWD available
    }
    const projectPath = await resolveValidProjectPath([backendPath, localPath, cwd]);
    if (projectPath) {
      useLayoutStore.getState().setProjectPath(projectPath);
      // Load `.agents/memory` notes at startup. The only loader used to be the
      // Memory pane's Project-notes tab, so notes never reached an agent's
      // memory brief unless the user happened to open that tab first.
      void useProjectMemoryStore
        .getState()
        .load(projectPath)
        .catch((e) => console.warn("[bootstrap] project memory load failed:", e));
    }

    // One-time cleanup of the retired agentMosaicStore localStorage key.
    // Safe to keep indefinitely — removeItem is a no-op when the key is absent.
    try {
      localStorage.removeItem("packetbench:agent-mosaic-v1");
    } catch {
      // localStorage unavailable — fine.
    }

    await conversationsReady;

    // Restore the view the user left the app on. Deliberately placed here:
    //   - AFTER `conversationsReady`, because the conversation graph is the
    //     heaviest cross-view dependency (Agents, and the Workspace tiles), so
    //     restoring earlier could mount those views against half a graph;
    //   - BEFORE `setInitialized(true)`, so the first post-bootstrap paint is
    //     already the restored view (no Welcome flash) and the App-level
    //     persistence effect — which no-ops until `initialized` — doesn't
    //     immediately write the value straight back.
    // Unreachable destinations fall back to Welcome; see `resolveStartupView`.
    // No route is excluded: every view is reachable from the rail/palette at
    // this same point in the lifecycle, so restoring into one is no different
    // from the user clicking it. The remaining backend slices (flights,
    // agents, orchestration) hydrate immediately below into reactive stores,
    // so a view that mounts ahead of them re-renders when they land.
    useAppStore
      .getState()
      .setActiveView(
        resolveStartupView(state.ui.selectedView, (id) => useModuleStore.getState().isEnabled(id)),
      );

    // Mark app as initialized so UI persistence and cross-store
    // reconciliation can begin.
    useAppStore.getState().setInitialized(true);

    // Heavy stores hydrate in the background — welcome doesn't need them,
    // and they don't make additional backend calls when given pre-loaded
    // state, so this is really just a clarity/intent signal.
    await useFlightStore
      .getState()
      .hydrateFromBackend(state)
      .catch(() => undefined);
    void useAgentStore
      .getState()
      .hydrateFromBackend(state)
      .catch(() => undefined);
    void useOrchestrationSettingsStore
      .getState()
      .hydrateFromBackend(state)
      .catch(() => undefined);
  } catch {
    // Backend unavailable — there is no persisted `selectedView` to restore,
    // so the store's default (`welcome`) stands.
    // Fall back to localStorage / CWD for the project path, validated.
    const localPath = localStorage.getItem(PROJECT_PATH_KEY);
    let cwd: string | null = null;
    try {
      cwd = await getCwd();
    } catch {
      // no CWD available
    }
    const projectPath = await resolveValidProjectPath([localPath, cwd]);
    if (projectPath) {
      useLayoutStore.getState().setProjectPath(projectPath);
    }
    await conversationsReady;
    useAppStore.getState().setInitialized(true);
    // Reclaim draft assets no longer referenced by the persisted envelope.
    void gcOrphanDraftAssets();
  }

  startBoundedAutonomyRuntime();
  registerFlightCostListener();
  // Cost guardrails are a control input, not reporting: this poll refreshes
  // the spend figures the caps are evaluated against and fires threshold
  // notifications. It used to hang off the (now removed) LiveSpendChip.
  startCostGuardrailMonitor();
  void sampleWorkspaceAgentsDisplayTopology();

  // WI-1: mirror the persisted auxiliary AI routing settings into the backend,
  // which is where spec import / Code Quality AI / PR AI resolve their provider.
  // Until this lands the backend routes everything on "auto (cheapest
  // configured API key)" — the same default — so the race is benign.
  useRoutingStore.getState().syncAuxRouting();

  // Kick CLI detection in the background — surfaces installed status to the
  // onboarding flow and the workspace creation modal. Must not block startup.
  void useAgentStore.getState().detectInstalled();
}

/**
 * Persist the current UI state to the backend (debounced).
 */
let uiPersistTimer: ReturnType<typeof setTimeout> | null = null;

export function persistUiState() {
  if (uiPersistTimer) clearTimeout(uiPersistTimer);
  uiPersistTimer = setTimeout(() => {
    const { activeView, theme, timeZone } = useAppStore.getState();
    saveUiSlice({
      selectedView: activeView,
      theme,
      timeZone,
    }).catch(logSwallowed("bootstrap.saveUi"));
  }, 1000);
}
