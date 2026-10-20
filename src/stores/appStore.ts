import { create } from "zustand";
import { getRoute, resolveModuleAlias } from "@/lib/routeRegistry";
import type { SettingsTarget } from "@/types/settings";
import type { FlightLaunchContext } from "@/lib/flightLaunchContext";

export type CoreView =
  | "welcome"
  | "workspace"
  | "agents"
  | "issues"
  | "flights"
  | "history"
  | "tools"
  | "github"
  | "memory"
  | "dictation";
export type AppView = CoreView | `mod:${string}`;

/**
 * View-normalization chokepoint for hydrated UI state. The WA1
 * Workspace/Agents split restores `"agents"` as a real same-window view, so a
 * persisted Agents selection must survive instead of being redirected to
 * Workspace.
 *
 * D4 (audit P1-9): also collapses module views that are aliases of a
 * first-class shell route down to their canonical `CoreView`. Dictation used
 * to exist as BOTH `"dictation"` and `"mod:dictation"`, which produced
 * inconsistent rail highlighting and Status Strip text; `mod:dictation` is now
 * an alias that normalizes to `"dictation"`.
 */
export function normalizeView(view: AppView): AppView {
  if (view.startsWith("mod:")) {
    const canonical = resolveModuleAlias(view.slice(4));
    if (canonical) return canonical;
  }
  // RETIRED ROUTE. `packetcode` was a second Agents pane: the same
  // `AgentsView`, wrapped in the engine gate and pinned to the ACP provider.
  // Two rail entries rendering one component invited exactly the divergence
  // this registry exists to prevent, so PacketCode is now a provider you
  // select inside Agents — the gate and the engine-session directory follow
  // the selection. Anyone whose persisted view, hotkey or palette entry still
  // says `packetcode` lands on Agents rather than on a dead route.
  if (view === ("packetcode" as AppView)) return "agents";
  return view;
}

export function isModuleView(view: AppView): boolean {
  return view.startsWith("mod:");
}

export function getModuleId(view: AppView): string | null {
  return view.startsWith("mod:") ? view.slice(4) : null;
}

export function moduleViewId(id: string): AppView {
  return `mod:${id}` as AppView;
}

/**
 * Startup view resolution (UX-09 area).
 *
 * `bootstrap` used to force `"welcome"` on every launch, so the `selectedView`
 * it faithfully persisted on every navigation was written and never read. The
 * app now reopens where the user left off — but only when that destination is
 * still reachable, because a persisted view that no longer resolves would
 * strand the user on an empty shell with no rendered view.
 *
 * Rules, in order:
 *  - nothing persisted (fresh install, or a backend that never wrote the key)
 *    ⇒ `"welcome"`;
 *  - `mod:<id>` aliases collapse to their canonical route via
 *    {@link normalizeView} (e.g. `mod:dictation` → `dictation`);
 *  - a plain module view (`mod:quality`) survives only while that module is
 *    enabled — `isModuleEnabled` also answers `false` for modules that have
 *    since been removed from the registry;
 *  - a core view survives only if {@link ROUTE_REGISTRY} still declares it, and
 *    — for routes backed by a module, like Dictation — only while that module
 *    is enabled;
 *  - anything else (a retired route id such as the legacy `"dashboard"` or the
 *    removed `"cost_dashboard"`, junk, a future id from a newer build) ⇒
 *    `"welcome"`.
 *
 * The module-enabled check is injected rather than imported so this stays a
 * pure function and `appStore` keeps no dependency on `moduleStore`.
 */
export function resolveStartupView(
  persisted: string | null | undefined,
  isModuleEnabled: (moduleId: string) => boolean,
): AppView {
  const raw = typeof persisted === "string" ? persisted.trim() : "";
  if (!raw) return "welcome";

  const view = normalizeView(raw as AppView);

  // Plain module view: not a shell route, so the registry can't vouch for it.
  const moduleId = getModuleId(view);
  if (moduleId) return isModuleEnabled(moduleId) ? view : "welcome";

  const route = getRoute(view);
  if (!route) return "welcome";
  if (route.moduleId && !isModuleEnabled(route.moduleId)) return "welcome";
  return route.id;
}

/** v0.8-H: deep-link filter applied to MemoryView when navigated to from
 * another surface (e.g. the FlightsView "N patterns extracted" chip).
 * Set via {@link AppStore.openMemoryView} and cleared either explicitly
 * (the consumer clicks Clear) or implicitly (next time it's set). */
export interface MemoryViewFilter {
  /** Restrict MemoryView to events/patterns tied to a specific flight. */
  flightId?: string;
  /** Restrict MemoryView to a single project's events/patterns. */
  projectPath?: string;
}

interface AppStore {
  flightLaunchContext: FlightLaunchContext | null;
  openFlightBrief: (context?: FlightLaunchContext) => void;
  closeFlightBrief: () => void;
  initialized: boolean;
  activeView: AppView;
  gitBranch: string | null;
  claudeVersion: string | null;
  isMaximized: boolean;
  commandPaletteOpen: boolean;
  settingsTarget: SettingsTarget | null;
  theme: "dark" | "light";
  /** IANA zone name (e.g. `America/New_York`), or `null` to follow the host
   *  system zone. Stored as a zone name rather than a fixed offset — an
   *  offset is wrong for half the year wherever DST applies. */
  timeZone: string | null;
  /** v0.8-H: optional filter applied the next time MemoryView mounts.
   * Consumed by `MemoryView` on mount and cleared after read. */
  memoryViewFilter: MemoryViewFilter | null;
  /**
   * When set, the open GitDashboard mounts the WorktreeLifecycleBar scoped to
   * this conversation's worktree (Merge back / Create PR / Discard / Keep).
   * `null` ⇒ the plain workspace git view (opened via the header toggle).
   */
  gitPanelConversationId: string | null;
  /** Workspace that owns the current Git-ending projection. This replaces the
   * old requirement that a conversation pane be attached to prove scope. */
  gitPanelWorkspaceId: string | null;
  setInitialized: (initialized: boolean) => void;
  setActiveView: (view: AppView) => void;
  setGitBranch: (branch: string | null) => void;
  setClaudeVersion: (version: string | null) => void;
  setIsMaximized: (maximized: boolean) => void;
  setCommandPaletteOpen: (open: boolean) => void;
  openSettings: (target?: SettingsTarget) => void;
  clearSettingsTarget: () => void;
  setTheme: (theme: "dark" | "light") => void;
  /** Pass `null` to follow the host system zone. */
  setTimeZone: (timeZone: string | null) => void;
  /** Drop any conversation scope so the Git panel shows the plain workspace
   *  view (no lifecycle bar). */
  clearGitPanelScope: () => void;
  /** ReviewBar "Finish → Commit…": scope the git panel to a conversation so its
   *  WorktreeLifecycleBar (the endings loop) renders. D2: the panel's
   *  VISIBILITY is the RightDock's — see `lib/agentHandoffs`. */
  openGitPanelForConversation: (conversationId: string, workspaceId: string) => void;
  /** v0.8-H: switch to MemoryView with an optional filter. The filter
   * lives in store state so the receiving view can react to it without
   * a separate routing layer. */
  openMemoryView: (filter?: MemoryViewFilter) => void;
  clearMemoryViewFilter: () => void;
}

export const useAppStore = create<AppStore>((set) => ({
  flightLaunchContext: null,
  openFlightBrief: (context = {}) => set({ flightLaunchContext: context }),
  closeFlightBrief: () => set({ flightLaunchContext: null }),
  initialized: false,
  activeView: "welcome",
  gitBranch: null,
  claudeVersion: null,
  isMaximized: false,
  commandPaletteOpen: false,
  settingsTarget: null,
  theme: "dark",
  timeZone: null,
  memoryViewFilter: null,
  gitPanelConversationId: null,
  gitPanelWorkspaceId: null,
  setInitialized: (initialized) => set({ initialized }),
  setActiveView: (view) => set({ activeView: normalizeView(view) }),
  setGitBranch: (branch) => set({ gitBranch: branch }),
  setClaudeVersion: (version) => set({ claudeVersion: version }),
  setIsMaximized: (maximized) => set({ isMaximized: maximized }),
  setCommandPaletteOpen: (open) => set({ commandPaletteOpen: open }),
  openSettings: (target) => set({ activeView: "tools", settingsTarget: target ?? null }),
  clearSettingsTarget: () => set({ settingsTarget: null }),
  setTheme: (theme) => set({ theme }),
  setTimeZone: (timeZone) => set({ timeZone }),
  clearGitPanelScope: () =>
    set({
      gitPanelConversationId: null,
      gitPanelWorkspaceId: null,
    }),
  openGitPanelForConversation: (conversationId, workspaceId) =>
    set({
      gitPanelConversationId: conversationId,
      gitPanelWorkspaceId: workspaceId,
    }),
  openMemoryView: (filter) => set({ activeView: "memory", memoryViewFilter: filter ?? null }),
  clearMemoryViewFilter: () => set({ memoryViewFilter: null }),
}));
