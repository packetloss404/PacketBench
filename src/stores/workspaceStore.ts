import { create } from "zustand";
import {
  isLocalWorkspace,
  type ExecutionTargetRef,
  type Workspace,
  type WorkspacePane,
  type WorkspaceAgentSlot,
} from "@/types/workspace";
import { saveWorkspacesSlice } from "@/lib/tauri";
import { logSwallowed } from "@/lib/logSwallowed";
import { useLayoutStore } from "@/stores/layoutStore";
import { useServerStore } from "@/stores/serverStore";
import { rememberAccountChoice, resolveAccountId } from "@/lib/sessionAccountDefaults";
import { normalizeTerminalShellSelection } from "@/lib/terminalShells";
import type { TerminalShellSelection } from "@/types/terminal-shell";
import { getVisibleLeafOrder, isValidMosaicTree } from "@/lib/mosaicPresets";
import type { MosaicNode } from "@/types/mosaic";

import { storageKey } from "@/lib/brand";
export interface WorkspaceSessionConfig {
  prompt?: string;
  modelOverrides?: Record<string, string | null>;
  effortOverrides?: Record<string, string | null>;
  bypassPermissions?: boolean;
  serverId?: string;
  remoteProjectPath?: string;
  executionTarget?: ExecutionTargetRef;
  /**
   * v0.8-15: auto-bound GitHub repo, derived from `git remote get-url
   * origin` at workspace-creation time. Stamped onto `Workspace.githubRepo`.
   */
  githubRepo?: { owner: string; repo: string };
  /**
   * Multi-account CLI support: explicit per-slot account choices made at
   * session-creation time (the New Workspace modal), keyed by
   * {@link WorkspaceAgentSlot}.
   *
   * Tri-state on purpose:
   * - key present with an id ⇒ launch under that account
   * - key present and `null`  ⇒ the user explicitly chose the ambient login
   * - key ABSENT              ⇒ fall back to the sticky per-project default
   *
   * Every present key is also written back as the project's sticky default,
   * so the next launch — including the programmatic ones that never open a
   * modal — remembers it.
   */
  accountIds?: Partial<Record<WorkspaceAgentSlot, string | null>>;
  /** Optional raw-terminal default for the new workspace. */
  terminalShell?: TerminalShellSelection;
}

/**
 * Tile program (P4-S1): a transient focus+flash request. `requestPaneFocus`
 * publishes one; the target tile (ConversationTile / WorkspacePane) reads it to
 * render a brief flash. `token` makes each request distinct so re-focusing the
 * SAME pane re-triggers the flash, and the auto-clear only nulls the request it
 * itself scheduled (never a newer one). Never carries zoom — focus+flash only.
 */
export interface PaneFocusRequest {
  workspaceId: string;
  paneId: string;
  token: number;
}

/**
 * Tile program (P4-S1): how long a focus flash lingers before the store clears
 * the request. The tile derives its flash purely from the live request, so this
 * governs the flash duration everywhere.
 */
export const PANE_FLASH_MS = 1200;

interface WorkspaceStore {
  workspaces: Workspace[];
  activeWorkspaceId: string | null;
  /**
   * Tile program (P4-S1): the current focus+flash request, or null. Set by
   * {@link WorkspaceStore.requestPaneFocus} (needs-you clicks, P5 deep links);
   * auto-cleared after {@link PANE_FLASH_MS}. NEVER touches zoom.
   */
  focusPaneRequest: PaneFocusRequest | null;
  /**
   * v0.8 setting: when true, the New Workspace modal pre-checks the
   * "Bypass permission prompts" toggle. Per-workspace state is still
   * stored on the Workspace itself; this only affects the initial
   * value at creation time.
   */
  defaultBypassPermissions: boolean;
  /**
   * v0.8 setting: when true (default), workspace creation runs
   * `git remote get-url origin` against the local project path and
   * stamps the parsed `{owner, repo}` onto the workspace as
   * `githubRepo`. Disable to skip the probe entirely (the user can
   * still bind manually later).
   */
  autoBindGithubRepo: boolean;
  zoomedPaneId: string | null;
  /**
   * Transient "open the New Workspace modal" request, or null.
   *
   * The full creation form is owned by `WorkspaceView` (it is the surface the
   * new workspace lands on), but the two most discoverable creation entry
   * points are global — the Toolbar "+ New" menu and the Ctrl+K palette. They
   * publish a token here instead of each mounting a competing modal instance.
   * The value is a monotonically increasing token so two consecutive requests
   * are distinguishable; `WorkspaceView` clears it once it has opened.
   */
  creationRequest: number | null;

  createWorkspace: (
    name: string,
    agents: WorkspaceAgentSlot[],
    projectPath: string,
    sessionConfig?: WorkspaceSessionConfig,
  ) => string;
  archiveWorkspace: (id: string) => void;
  restoreWorkspace: (id: string) => void;
  deleteWorkspace: (id: string) => void;
  setActiveWorkspace: (id: string | null) => void;
  getActiveWorkspace: () => Workspace | undefined;
  setBypassPermissions: (workspaceId: string, bypass: boolean) => void;
  setPaneSession: (workspaceId: string, paneId: string, sessionId: string | null) => void;
  updatePane: (workspaceId: string, paneId: string, updates: Partial<WorkspacePane>) => void;
  addPinnedCommand: (workspaceId: string, paneId: string, command: string) => void;
  setModelOverride: (workspaceId: string, agentId: string, model: string | null) => void;
  removePinnedCommand: (workspaceId: string, paneId: string, index: number) => void;
  /**
   * Append a pane to a workspace.
   *
   * `options.accountId` (multi-account CLI support) is tri-state, matching
   * {@link WorkspaceSessionConfig.accountIds}: an id launches under that
   * account, `null` is an explicit ambient login, and omitting it entirely
   * falls back to the sticky per-project default — which is what keeps the
   * programmatic call sites (agent hand-offs, Toolbar quick-launch) from
   * silently launching ambient in a project that has a remembered account.
   * An explicit value is written back as the new sticky default.
   */
  addPane: (
    workspaceId: string,
    agentId: WorkspaceAgentSlot,
    options?: { accountId?: string | null; terminalShell?: TerminalShellSelection },
  ) => string | null;
  /**
   * Add a read/write file viewer tile to the workspace grid. The tile is a
   * `kind: "file"` pane (inert carrier `agentId: "terminal"`, same downgrade
   * story as conversation panes) whose buffer lives in `editorStore`, so the
   * same path opened in the right-dock Editor and in a tile is ONE buffer and
   * one dirty flag. Re-opening an already-tiled path focuses that tile and
   * returns its id rather than minting a duplicate. Returns `null` for a blank
   * path or an unknown workspace.
   */
  addFilePane: (
    workspaceId: string,
    filePath: string,
    options?: { view?: "preview" | "raw" },
  ) => string | null;
  removePane: (workspaceId: string, paneId: string) => void;
  /**
   * Tile program (P1-S2): prune every conversation pane referencing
   * `conversationId` across all workspaces. Drives the one-directional GC in
   * `sessionGlue`: deleting a conversation removes its tiles, but closing a
   * tile (`removePane`) NEVER deletes the conversation. Reference direction is
   * pane→conversationId only.
   */
  removeConversationPanes: (conversationId: string) => void;
  setDefaultBypassPermissions: (value: boolean) => void;
  setAutoBindGithubRepo: (value: boolean) => void;
  setTerminalShellOverride: (
    workspaceId: string,
    selection: TerminalShellSelection | undefined,
  ) => void;
  /**
   * Persist the user's hand-arranged tile layout for one workspace.
   *
   * Called from the mosaic's `onRelease` (once per completed drag/resize
   * gesture, NOT per drag frame) and on pane add/remove. Passing `null` clears
   * the arrangement so the workspace falls back to the pane-count preset.
   *
   * Deliberately does NOT bump `updatedAt`: rearranging tiles is not activity
   * on the work, and letting it reorder the Fleet list under the user's cursor
   * mid-drag would be its own bug.
   */
  setWorkspaceLayout: (workspaceId: string, layout: MosaicNode<string> | null) => void;
  setZoomedPane: (paneId: string | null) => void;
  /**
   * Tile program (P4-S1): NET-NEW focus+flash plumbing (no such symbol existed
   * before). Activates `workspaceId`, sets `layoutStore.activePaneId` to
   * `paneId`, and publishes a transient {@link PaneFocusRequest} that the target
   * tile flashes. NEVER auto-zooms, NEVER rearranges. The request auto-clears
   * after {@link PANE_FLASH_MS}. Drives needs-you clicks (P4-S2) and notification
   * deep links (P5).
   */
  requestPaneFocus: (workspaceId: string, paneId: string) => void;
  /**
   * Tile program (P4-S1): clear the focus request. Pass the `token` of the
   * request you intend to clear so a stale auto-clear can't null a newer
   * request; omit to clear unconditionally.
   */
  clearPaneFocusRequest: (token?: number) => void;
  /** Ask the Workspace surface to open the New Workspace modal. */
  requestWorkspaceCreation: () => void;
  /** Clear a pending {@link WorkspaceStore.creationRequest}. */
  clearWorkspaceCreationRequest: () => void;
  hydrateFromBackend: (workspaces?: Workspace[]) => void;
}

const DEFAULT_BYPASS_KEY = storageKey("workspace-default-bypass");
const AUTO_BIND_GITHUB_KEY = storageKey("workspace-auto-bind-github");
const ACTIVE_WORKSPACE_KEY = storageKey("workspace-active-id");

/**
 * Remember which workspace was open.
 *
 * Restart used to drop the selection: the workspace list and every session in
 * it came back, the app returned to the Workspace view, and then showed
 * "Select a workspace from the sidebar" — so the last thing you were working
 * in had to be re-picked by hand every launch.
 *
 * Only the id is stored. It is validated against the hydrated list on read, so
 * a workspace deleted (or removed on another machine) since the last run
 * resolves to `null` rather than pointing the view at a ghost.
 */
function readActiveWorkspaceId(workspaces: Workspace[]): string | null {
  if (typeof localStorage === "undefined") return null;
  try {
    const raw = localStorage.getItem(ACTIVE_WORKSPACE_KEY);
    if (!raw) return null;
    return workspaces.some((w) => w.id === raw && w.status !== "archived") ? raw : null;
  } catch {
    return null;
  }
}

/**
 * Test seam for {@link readActiveWorkspaceId}. The real call happens once at
 * module init, which a test cannot re-trigger without re-importing the whole
 * store, so the validation rules are exercised through this instead.
 */
export function readActiveWorkspaceIdForTest(workspaces: Workspace[]): string | null {
  return readActiveWorkspaceId(workspaces);
}

function writeActiveWorkspaceId(id: string | null) {
  if (typeof localStorage === "undefined") return;
  try {
    if (id) localStorage.setItem(ACTIVE_WORKSPACE_KEY, id);
    else localStorage.removeItem(ACTIVE_WORKSPACE_KEY);
  } catch {
    // Best-effort — the selection still applies for this session.
  }
}

function readBooleanFlag(key: string, fallback: boolean): boolean {
  if (typeof localStorage === "undefined") return fallback;
  const raw = localStorage.getItem(key);
  if (raw === null) return fallback;
  return raw === "true";
}

function writeBooleanFlag(key: string, value: boolean) {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(key, String(value));
  } catch {
    // Best-effort — runtime state still updates.
  }
}

/**
 * F50: mint a collision-safe pane id. The prior `ws-pane-${++counter}` scheme
 * restarted from 0 on every reload, so a freshly-minted pane could collide with
 * a persisted pane that had claimed the same low number in an earlier session
 * (duplicate keys → React reconciliation clobbering the wrong pane). Minting
 * from `crypto.randomUUID()` — the same source the workspace id uses — makes the
 * id unique across reloads. The `ws-pane-` prefix is retained so old persisted
 * ids (opaque strings) keep working untouched.
 */
function mintPaneId(): string {
  return `ws-pane-${crypto.randomUUID()}`;
}

/**
 * Tile program (P4-S1): monotonic token source for {@link PaneFocusRequest}.
 * Module-scoped so tokens stay unique across the store's lifetime (a fresh
 * token every request re-triggers the flash even for the same pane).
 */
let focusToken = 0;

// Pane focus is runtime UI state. Keep one remembered target per workspace so
// switching grids does not leave keyboard input aimed at a hidden terminal.
const lastFocusedPaneIds = new Map<string, string>();

/**
 * Multi-account CLI support: settle the account a brand-new pane launches
 * under, and record the choice when it was explicit.
 *
 * `explicit === undefined` means "the caller never expressed an opinion" — the
 * seven-odd programmatic `createWorkspace`/`addPane` call sites that bypass the
 * modals — so we fall back to the sticky per-project default rather than
 * silently launching ambient. An explicit value (including `null` for "use the
 * ambient login") wins AND becomes the new sticky default.
 */
function settleAccountId(
  projectPath: string,
  agent: WorkspaceAgentSlot,
  explicit: string | null | undefined,
): string | undefined {
  if (explicit === undefined) return resolveAccountId(projectPath, agent);
  rememberAccountChoice(projectPath, agent, explicit);
  return explicit ?? undefined;
}

function buildPanes(
  agents: WorkspaceAgentSlot[],
  projectPath: string,
  accountIds?: Partial<Record<WorkspaceAgentSlot, string | null>>,
): WorkspacePane[] {
  return agents.map((agent) => {
    // `undefined` (absent, or an explicitly-undefined value) ⇒ sticky default;
    // `null` ⇒ the user deliberately chose the ambient login.
    const accountId = settleAccountId(projectPath, agent, accountIds?.[agent]);
    return {
      id: mintPaneId(),
      agentId: agent,
      sessionId: null,
      // Ambient panes stay byte-identical to the pre-multi-account shape.
      ...(accountId ? { accountId } : {}),
    };
  });
}

const WORKSPACES_CACHE_KEY = storageKey("workspaces-cache");

/**
 * Historical deterministic wrapper-workspace id for a conversation. New
 * attachments are retired, but migration and cleanup tests still recognize
 * this shape so saved `ws-wrap-<convId>` layouts remain safe.
 */
export function conversationWrapperId(conversationId: string): string {
  return `ws-wrap-${conversationId}`;
}

/**
 * Tile program (P1-S1): defensive normalization of a single pane read from an
 * untrusted source (the blindly-`JSON.parse`d localStorage cache, or backend
 * hydration).
 *
 * - Missing/blank `kind` ⇒ terminal (absent kind means terminal — an old cache
 *   or an old binary that never wrote the field degrades cleanly).
 * - `kind` is the SOLE discriminant; `agentId` is never overloaded. Conversation
 *   panes carry the inert carrier `agentId: "terminal"`.
 * - Invariant `conversationId set iff kind === "conversation"` is enforced: a
 *   pane tagged conversation but missing a string `conversationId` self-heals to
 *   a plain terminal pane (the inert-carrier arm — the sweep half of self-heal
 *   lands in P1-S2). A terminal pane never keeps a stray `conversationId`.
 * - Malformed panes (not an object, or no string `id`) are dropped.
 * - Unknown fields are preserved (forward-compat with a newer build's cache).
 *
 * Returns `null` for a pane that should be dropped.
 */
function normalizePane(raw: unknown): WorkspacePane | null {
  if (!raw || typeof raw !== "object") return null;
  const pane = raw as Record<string, unknown>;
  if (typeof pane.id !== "string") return null;

  const isConversation = pane.kind === "conversation" && typeof pane.conversationId === "string";
  // File viewer tiles follow the identical invariant one field over: `kind`
  // stays the sole discriminant, `filePath` is the payload, and a file pane
  // that lost its path self-heals to a terminal rather than mounting an empty
  // viewer. `agentId` stays the inert carrier "terminal" here too.
  const isFile =
    pane.kind === "file" && typeof pane.filePath === "string" && !!pane.filePath.trim();

  // Preserve unknown fields, then override the discriminant pair so the
  // invariant always holds regardless of what was on disk. PTY ids are
  // runtime-only: the owning OS processes died with the previous app process,
  // so hydrating a persisted id would expose a stale write/kill target.
  const normalized = { ...pane } as Record<string, unknown>;
  normalized.sessionId = null;
  // Legacy alias: Gemini CLI support was removed (2026-07). Persisted panes
  // that still reference the retired slot degrade to a plain terminal pane —
  // same read-only-alias spirit as the mission→flight ids.
  if (normalized.agentId === "gemini") normalized.agentId = "terminal";
  if (isConversation) {
    normalized.kind = "conversation";
    normalized.conversationId = pane.conversationId;
    delete normalized.filePath;
    delete normalized.fileView;
  } else if (isFile) {
    normalized.kind = "file";
    normalized.filePath = (pane.filePath as string).trim();
    normalized.fileView =
      pane.fileView === "preview" || pane.fileView === "raw" ? pane.fileView : undefined;
    if (normalized.fileView === undefined) delete normalized.fileView;
    delete normalized.conversationId;
  } else {
    normalized.kind = "terminal";
    delete normalized.conversationId;
    delete normalized.filePath;
    delete normalized.fileView;
  }
  // Multi-account CLI support: a non-string / blank `accountId` from an
  // untrusted cache degrades to ambient rather than reaching the runtime as a
  // bogus config-dir lookup.
  if (typeof normalized.accountId !== "string" || !normalized.accountId.trim()) {
    delete normalized.accountId;
  }
  return normalized as unknown as WorkspacePane;
}

/**
 * Tile program (P1-S1): apply {@link normalizePane} across every workspace's
 * panes, dropping any pane that fails to normalize. Applied to BOTH the
 * localStorage cache and backend hydration so a conversation pane round-trips
 * and a stripped-carrier pane self-heals to a terminal.
 */
export function normalizePanes(workspaces: Workspace[]): Workspace[] {
  return workspaces.map((w) => ({
    ...w,
    // The saved tile arrangement comes from the same untrusted sources as the
    // panes (a blind `JSON.parse` of localStorage, or backend hydration). A
    // malformed tree degrades to absent, and the container falls back to the
    // pane-count preset. Leaf ids are NOT checked here — the container
    // reconciles those against the live pane list, which is the only place
    // that knows them.
    layout: isValidMosaicTree(w.layout) ? w.layout : undefined,
    // Legacy alias sweep: retired "gemini" slot entries in the agents list
    // degrade to plain terminals, mirroring normalizePane's pane-level alias.
    agents: Array.isArray(w.agents)
      ? w.agents.map((agent) =>
          (agent as string) === "gemini" ? ("terminal" as WorkspaceAgentSlot) : agent,
        )
      : [],
    panes: Array.isArray(w.panes)
      ? w.panes
          .map((pane) => normalizePane(pane))
          .filter((pane): pane is WorkspacePane => pane !== null)
      : [],
  }));
}

/**
 * Read the cached workspace list from localStorage. Lets the welcome screen
 * render with workspaces on day-2+ launches before the backend round-trip
 * completes — avoids the brief empty → populated flicker.
 */
function loadCachedWorkspaces(): Workspace[] {
  try {
    if (typeof localStorage === "undefined") return [];
    const cached = localStorage.getItem(WORKSPACES_CACHE_KEY);
    if (!cached) return [];
    const parsed = JSON.parse(cached);
    return Array.isArray(parsed) ? normalizePanes(parsed as Workspace[]) : [];
  } catch {
    return [];
  }
}

function syncToLocalStorage(workspaces: Workspace[]) {
  try {
    if (typeof localStorage === "undefined") return;
    localStorage.setItem(WORKSPACES_CACHE_KEY, JSON.stringify(workspaces));
  } catch {
    // Quota exceeded or storage unavailable — silent fail
  }
}

let backendSaveTail: Promise<void> = Promise.resolve();

function syncToBackend(workspaces: Workspace[]) {
  // Tauri state writes replace the whole workspace slice. Serialize them so a
  // slower cursor save can never land after a newer pane/session identity.
  const snapshot = workspaces;
  backendSaveTail = backendSaveTail
    .catch(() => undefined)
    .then(() => saveWorkspacesSlice(snapshot))
    .catch(logSwallowed("workspaceStore.save"));
  syncToLocalStorage(workspaces);
}

function commitWorkspaces(
  updater: (
    state: Pick<WorkspaceStore, "workspaces" | "activeWorkspaceId">,
  ) => Partial<WorkspaceStore>,
) {
  return (state: WorkspaceStore): Partial<WorkspaceStore> => {
    const next = updater(state);
    if (next.workspaces) {
      syncToBackend(next.workspaces);
    }
    // One choke point for the four mutators that also move the selection
    // (create, archive, restore, delete). `setActiveWorkspace` does not go
    // through here and persists on its own.
    if ("activeWorkspaceId" in next) {
      writeActiveWorkspaceId(next.activeWorkspaceId ?? null);
    }
    return next;
  };
}

const cachedWorkspaces = loadCachedWorkspaces();

export const useWorkspaceStore = create<WorkspaceStore>((set, get) => ({
  workspaces: cachedWorkspaces,
  activeWorkspaceId: readActiveWorkspaceId(cachedWorkspaces),
  focusPaneRequest: null,
  defaultBypassPermissions: readBooleanFlag(DEFAULT_BYPASS_KEY, false),
  autoBindGithubRepo: readBooleanFlag(AUTO_BIND_GITHUB_KEY, true),
  zoomedPaneId: null,
  creationRequest: null,

  requestWorkspaceCreation: () => {
    set((s) => ({ creationRequest: (s.creationRequest ?? 0) + 1 }));
  },

  clearWorkspaceCreationRequest: () => {
    set({ creationRequest: null });
  },

  setDefaultBypassPermissions: (value) => {
    writeBooleanFlag(DEFAULT_BYPASS_KEY, value);
    set({ defaultBypassPermissions: value });
  },

  setAutoBindGithubRepo: (value) => {
    writeBooleanFlag(AUTO_BIND_GITHUB_KEY, value);
    set({ autoBindGithubRepo: value });
  },

  setTerminalShellOverride: (workspaceId, input) => {
    const terminalShell = input ? normalizeTerminalShellSelection(input) : undefined;
    set(
      commitWorkspaces((state) => ({
        workspaces: state.workspaces.map((workspace) =>
          workspace.id === workspaceId
            ? { ...workspace, terminalShell, updatedAt: Date.now() }
            : workspace,
        ),
      })),
    );
  },

  createWorkspace: (name, agents, projectPath, sessionConfig) => {
    const serverId = sessionConfig?.serverId;
    const remoteProjectPath = sessionConfig?.remoteProjectPath;
    const executionTarget: ExecutionTargetRef =
      sessionConfig?.executionTarget ?? (serverId ? { kind: "ssh", serverId } : { kind: "local" });

    // Creation invariant — the empty-path guard lives HERE, not in the modal.
    // `WorkspaceCreationModal` used to be the only place that blocked
    // `projectPath === ""` (persisting one breaks the Toolbar folder picker,
    // git pollers, MCP and deploy), while the instant paths (Fleet sidebar,
    // Ctrl+N) passed `layoutStore.projectPath ?? ""` straight through and
    // silently produced exactly that broken workspace on a fresh install.
    // Callers with no known path must route the user through the folder
    // picker first — see `lib/workspaceCreation.createInstantWorkspace`.
    if (executionTarget.kind === "local" && !projectPath.trim()) {
      throw new Error(
        "createWorkspace: a local workspace requires a non-empty projectPath — " +
          "route the user through the folder picker (lib/workspaceCreation) instead",
      );
    }

    if (executionTarget.kind === "ssh") {
      if (serverId && serverId !== executionTarget.serverId) {
        throw new Error("createWorkspace: SSH execution target and legacy serverId disagree");
      }
      // Remote workspace: serverId must point to a real registered server
      // and we require an explicit remote project path. The pane launch
      // code in WorkspacePane.tsx reads `workspace.remoteProjectPath` so
      // we need it stored on the workspace itself.
      const server = useServerStore.getState().getServer(executionTarget.serverId);
      if (!server) {
        throw new Error(
          `createWorkspace: serverId "${serverId}" does not match any registered server`,
        );
      }
      if (!remoteProjectPath || !remoteProjectPath.trim()) {
        throw new Error("createWorkspace: remoteProjectPath is required when serverId is set");
      }
    }

    // For remote workspaces the legacy `projectPath` becomes the remote
    // path string so any code that reads `workspace.projectPath` without
    // checking `serverId` still gets a stable label (used in workspace
    // headers, history, etc.). Local-only operations must guard with
    // `if (!workspace.serverId)` — see e.g. `IdeationView.handleGenerate`.
    const effectiveProjectPath =
      executionTarget.kind === "ssh"
        ? (remoteProjectPath ?? "").trim() || projectPath
        : projectPath;

    const id = crypto.randomUUID();
    const now = Date.now();
    const workspace: Workspace = {
      id,
      name,
      agents,
      // Multi-account CLI support: panes resolve their account from the
      // caller's explicit choice, else the sticky per-project default. Keyed
      // on `effectiveProjectPath` so remote workspaces stick per remote path.
      panes: buildPanes(agents, effectiveProjectPath, sessionConfig?.accountIds),
      projectPath: effectiveProjectPath,
      prompt: sessionConfig?.prompt,
      createdAt: now,
      updatedAt: now,
      status: "active",
      bypassPermissions: sessionConfig?.bypassPermissions ?? false,
      modelOverrides: sessionConfig?.modelOverrides,
      effortOverrides: sessionConfig?.effortOverrides,
      serverId: executionTarget.kind === "ssh" ? executionTarget.serverId : undefined,
      remoteProjectPath: executionTarget.kind === "ssh" ? remoteProjectPath : undefined,
      executionTarget,
      githubRepo: sessionConfig?.githubRepo,
      terminalShell: sessionConfig?.terminalShell
        ? normalizeTerminalShellSelection(sessionConfig.terminalShell)
        : undefined,
    };
    set(
      commitWorkspaces((s) => {
        const workspaces = [...s.workspaces, workspace];
        return { workspaces, activeWorkspaceId: id };
      }),
    );
    return id;
  },

  archiveWorkspace: (id) => {
    const ownsZoom = get()
      .workspaces.find((workspace) => workspace.id === id)
      ?.panes.some((pane) => pane.id === get().zoomedPaneId);
    set(
      commitWorkspaces((s) => {
        const workspaces = s.workspaces.map((w) =>
          w.id === id ? { ...w, status: "archived" as const, updatedAt: Date.now() } : w,
        );
        const activeWorkspaceId = s.activeWorkspaceId === id ? null : s.activeWorkspaceId;
        return { workspaces, activeWorkspaceId, ...(ownsZoom ? { zoomedPaneId: null } : {}) };
      }),
    );
  },

  restoreWorkspace: (id) => {
    set(
      commitWorkspaces((s) => {
        const workspaces = s.workspaces.map((workspace) =>
          workspace.id === id
            ? { ...workspace, status: "active" as const, updatedAt: Date.now() }
            : workspace,
        );
        return { workspaces, activeWorkspaceId: id };
      }),
    );
  },

  deleteWorkspace: (id) => {
    const ownsZoom = get()
      .workspaces.find((workspace) => workspace.id === id)
      ?.panes.some((pane) => pane.id === get().zoomedPaneId);
    lastFocusedPaneIds.delete(id);
    set(
      commitWorkspaces((s) => {
        const workspaces = s.workspaces.filter((w) => w.id !== id);
        const activeWorkspaceId = s.activeWorkspaceId === id ? null : s.activeWorkspaceId;
        return { workspaces, activeWorkspaceId, ...(ownsZoom ? { zoomedPaneId: null } : {}) };
      }),
    );
  },

  setActiveWorkspace: (id) => {
    const previous = get().workspaces.find((workspace) => workspace.id === get().activeWorkspaceId);
    const activePaneId = useLayoutStore.getState().activePaneId;
    if (previous?.panes.some((pane) => pane.id === activePaneId)) {
      lastFocusedPaneIds.set(previous.id, activePaneId);
    }
    set({ activeWorkspaceId: id });
    writeActiveWorkspaceId(id);
    const workspace = get().workspaces.find((candidate) => candidate.id === id);
    const rememberedPaneId = id ? lastFocusedPaneIds.get(id) : undefined;
    const nextPaneId =
      workspace?.panes.find((pane) => pane.id === get().zoomedPaneId)?.id ??
      workspace?.panes.find((pane) => pane.id === rememberedPaneId)?.id ??
      workspace?.panes[0]?.id ??
      "";
    if (activePaneId !== nextPaneId) useLayoutStore.getState().setActivePaneId(nextPaneId);
    if (id) {
      // Only sync `layoutStore.projectPath` for local workspaces — for
      // remote workspaces the path is on the remote host and would
      // confuse local-only features (file watcher, git dashboard, etc.).
      if (workspace && isLocalWorkspace(workspace)) {
        useLayoutStore.getState().setProjectPath(workspace.projectPath);
      }
    }
  },

  getActiveWorkspace: () => {
    const s = get();
    return s.workspaces.find((w) => w.id === s.activeWorkspaceId);
  },

  setBypassPermissions: (workspaceId, bypass) => {
    set(
      commitWorkspaces((s) => {
        const workspaces = s.workspaces.map((w) =>
          w.id === workspaceId ? { ...w, bypassPermissions: bypass, updatedAt: Date.now() } : w,
        );
        return { workspaces };
      }),
    );
  },

  setPaneSession: (workspaceId, paneId, sessionId) => {
    set(
      commitWorkspaces((s) => {
        const workspaces = s.workspaces.map((w) => {
          if (w.id !== workspaceId) return w;
          return {
            ...w,
            panes: w.panes.map((p) => (p.id === paneId ? { ...p, sessionId } : p)),
            updatedAt: Date.now(),
          };
        });
        return { workspaces };
      }),
    );
  },

  updatePane: (workspaceId, paneId, updates) => {
    set(
      commitWorkspaces((s) => {
        const workspaces = s.workspaces.map((w) => {
          if (w.id !== workspaceId) return w;
          return {
            ...w,
            panes: w.panes.map((p) => (p.id === paneId ? { ...p, ...updates } : p)),
            updatedAt: Date.now(),
          };
        });
        return { workspaces };
      }),
    );
  },

  setModelOverride: (workspaceId, agentId, model) => {
    set(
      commitWorkspaces((s) => {
        const workspaces = s.workspaces.map((w) => {
          if (w.id !== workspaceId) return w;
          const overrides = { ...(w.modelOverrides ?? {}) };
          if (model === null) {
            delete overrides[agentId];
          } else {
            overrides[agentId] = model;
          }
          return { ...w, modelOverrides: overrides, updatedAt: Date.now() };
        });
        return { workspaces };
      }),
    );
  },

  addPinnedCommand: (workspaceId, paneId, command) => {
    const trimmed = command.trim();
    if (!trimmed) return;
    set(
      commitWorkspaces((s) => {
        const workspaces = s.workspaces.map((w) => {
          if (w.id !== workspaceId) return w;
          return {
            ...w,
            panes: w.panes.map((p) => {
              if (p.id !== paneId) return p;
              const existing = p.pinnedCommands ?? [];
              if (existing.includes(trimmed)) return p;
              if (existing.length >= 5) return p;
              return { ...p, pinnedCommands: [...existing, trimmed] };
            }),
            updatedAt: Date.now(),
          };
        });
        return { workspaces };
      }),
    );
  },

  removePinnedCommand: (workspaceId, paneId, index) => {
    set(
      commitWorkspaces((s) => {
        const workspaces = s.workspaces.map((w) => {
          if (w.id !== workspaceId) return w;
          return {
            ...w,
            panes: w.panes.map((p) => {
              if (p.id !== paneId) return p;
              const existing = p.pinnedCommands ?? [];
              return { ...p, pinnedCommands: existing.filter((_, i) => i !== index) };
            }),
            updatedAt: Date.now(),
          };
        });
        return { workspaces };
      }),
    );
  },

  addPane: (workspaceId, agentId, options) => {
    const newPaneId = mintPaneId();
    // Resolved once, outside the (potentially re-run) updater, so the sticky
    // default is written exactly once per add.
    const target = get().workspaces.find((w) => w.id === workspaceId);
    const accountId = target
      ? settleAccountId(target.projectPath, agentId, options?.accountId)
      : undefined;
    set(
      commitWorkspaces((s) => {
        const workspaces = s.workspaces.map((w) => {
          if (w.id !== workspaceId) return w;
          const newPane: WorkspacePane = {
            id: newPaneId,
            agentId,
            sessionId: null,
            // Ambient panes stay byte-identical to the pre-multi-account shape.
            ...(accountId ? { accountId } : {}),
            ...(agentId === "terminal" && options?.terminalShell
              ? { terminalShell: normalizeTerminalShellSelection(options.terminalShell) }
              : {}),
          };
          return {
            ...w,
            agents: [...w.agents, agentId],
            panes: [...w.panes, newPane],
            updatedAt: Date.now(),
          };
        });
        return { workspaces };
      }),
    );
    return newPaneId;
  },

  addFilePane: (workspaceId, filePath, options) => {
    const trimmed = filePath.trim();
    if (!trimmed) return null;
    const target = get().workspaces.find((w) => w.id === workspaceId);
    if (!target) return null;
    // One tile per path per workspace. Re-opening a file that is already tiled
    // focuses the existing tile instead of stacking duplicate viewers of the
    // same buffer (they'd share one `editorStore` entry anyway, so a second
    // tile would just be a confusing mirror of the first).
    const existing = target.panes.find((p) => p.kind === "file" && p.filePath === trimmed);
    if (existing) {
      get().requestPaneFocus(workspaceId, existing.id);
      return existing.id;
    }

    const newPaneId = mintPaneId();
    set(
      commitWorkspaces((s) => {
        const workspaces = s.workspaces.map((w) => {
          if (w.id !== workspaceId) return w;
          const newPane: WorkspacePane = {
            id: newPaneId,
            // Inert carrier, exactly as conversation panes do it: `kind` is the
            // sole discriminant, so a downgraded binary that drops `kind`
            // renders a harmless terminal pane rather than a broken tile.
            agentId: "terminal",
            sessionId: null,
            kind: "file",
            filePath: trimmed,
            ...(options?.view ? { fileView: options.view } : {}),
          };
          return {
            ...w,
            // File panes are NOT pushed into `agents` — that list is the CLI
            // roster behind the header badges, and a viewer launches no agent.
            // `removePane` mirrors this by skipping the agents splice.
            panes: [...w.panes, newPane],
            updatedAt: Date.now(),
          };
        });
        return { workspaces };
      }),
    );
    return newPaneId;
  },

  setWorkspaceLayout: (workspaceId, layout) => {
    const current = get().workspaces.find((w) => w.id === workspaceId);
    if (!current) return;
    // Cheap identity guard: the container re-asserts the layout after every
    // pane add/remove, and an unchanged tree would otherwise cost a full
    // workspaces persist (Tauri IPC + a localStorage JSON.stringify of every
    // workspace) on each one.
    const next = layout ?? undefined;
    if (JSON.stringify(current.layout) === JSON.stringify(next)) return;
    set(
      commitWorkspaces((s) => ({
        workspaces: s.workspaces.map((w) => (w.id === workspaceId ? { ...w, layout: next } : w)),
      })),
    );
  },

  removePane: (workspaceId, paneId) => {
    const workspace = get().workspaces.find((item) => item.id === workspaceId);
    if (!workspace?.panes.some((pane) => pane.id === paneId)) return;
    const paneIds = new Set(workspace.panes.map((pane) => pane.id));
    const visibleIds = getVisibleLeafOrder(workspace.layout ?? null).filter((id) =>
      paneIds.has(id),
    );
    const order = visibleIds.length ? visibleIds : workspace.panes.map((pane) => pane.id);
    const closedIndex = order.indexOf(paneId);
    const survivors = order.filter((id) => id !== paneId);
    const nextPaneId = survivors[Math.min(Math.max(closedIndex, 0), survivors.length - 1)] ?? "";
    const wasSelected =
      get().activeWorkspaceId === workspaceId && useLayoutStore.getState().activePaneId === paneId;
    set(
      commitWorkspaces((s) => {
        const workspaces = s.workspaces.map((w) => {
          if (w.id !== workspaceId) return w;
          const pane = w.panes.find((p) => p.id === paneId);
          if (!pane) return w;
          return {
            ...w,
            panes: w.panes.filter((p) => p.id !== paneId),
            agents: (() => {
              // Tile program (P1-S1): `agents` is keyed on `kind`, not agentId.
              // Conversation panes were never pushed into `agents` (they carry the
              // inert carrier agentId "terminal"), so removing one must NOT splice
              // a real terminal out of the agents list. Skip the mutation.
              // File viewer panes carry the same inert carrier for the same
              // reason, so they get the same skip.
              if (pane.kind === "conversation" || pane.kind === "file") return w.agents;
              // Remove one occurrence of this agent from the agents list
              const idx = w.agents.indexOf(pane.agentId);
              if (idx === -1) return w.agents;
              const copy = [...w.agents];
              copy.splice(idx, 1);
              return copy;
            })(),
            updatedAt: Date.now(),
          };
        });
        return { workspaces };
      }),
    );
    // Clear zoom if the zoomed pane was removed
    if (get().zoomedPaneId === paneId) {
      set({ zoomedPaneId: null });
    }
    if (wasSelected || lastFocusedPaneIds.get(workspaceId) === paneId) {
      if (nextPaneId) lastFocusedPaneIds.set(workspaceId, nextPaneId);
      else lastFocusedPaneIds.delete(workspaceId);
    }
    if (wasSelected) useLayoutStore.getState().setActivePaneId(nextPaneId);
    if (
      get().focusPaneRequest?.workspaceId === workspaceId &&
      get().focusPaneRequest?.paneId === paneId
    ) {
      get().clearPaneFocusRequest();
    }
  },

  removeConversationPanes: (conversationId) => {
    const removedPaneIds: string[] = [];
    set(
      commitWorkspaces((s) => {
        let changed = false;
        const workspaces = s.workspaces.map((w) => {
          const kept = w.panes.filter((p) => {
            const match = p.kind === "conversation" && p.conversationId === conversationId;
            if (match) removedPaneIds.push(p.id);
            return !match;
          });
          if (kept.length === w.panes.length) return w;
          changed = true;
          return { ...w, panes: kept, updatedAt: Date.now() };
        });
        // No referencing pane anywhere — skip the backend write entirely.
        if (!changed) return {};
        return { workspaces };
      }),
    );
    // Clear zoom if the zoomed pane was one of the pruned conversation panes.
    if (get().zoomedPaneId && removedPaneIds.includes(get().zoomedPaneId as string)) {
      set({ zoomedPaneId: null });
    }
  },

  setZoomedPane: (paneId) => {
    set({ zoomedPaneId: paneId });
  },

  requestPaneFocus: (workspaceId, paneId) => {
    // Activate the workspace and set mosaic focus through the EXISTING
    // mechanisms — no new focus machinery (setActiveWorkspace syncs projectPath;
    // layoutStore.activePaneId is the real mosaic focus). Zoom is deliberately
    // untouched: focus+flash only, never auto-zoom, never rearrange.
    get().setActiveWorkspace(workspaceId);
    useLayoutStore.getState().setActivePaneId(paneId);
    const token = ++focusToken;
    set({ focusPaneRequest: { workspaceId, paneId, token } });
    // Transient: the flash clears itself so a stale highlight never lingers.
    // The token guard means a newer request supersedes rather than being
    // cancelled by this timer.
    if (typeof setTimeout === "function") {
      setTimeout(() => {
        get().clearPaneFocusRequest(token);
      }, PANE_FLASH_MS);
    }
  },

  clearPaneFocusRequest: (token) => {
    set((s) => {
      if (!s.focusPaneRequest) return {};
      // Only clear the matching request when a token is supplied, so a
      // late-firing auto-clear can't wipe a fresher focus.
      if (token !== undefined && s.focusPaneRequest.token !== token) return {};
      return { focusPaneRequest: null };
    });
  },

  hydrateFromBackend: (workspaces) => {
    if (workspaces) {
      // Tile program (P1-S1): normalize on the way in from the backend too, so
      // a stripped-carrier conversation pane self-heals and missing kinds
      // default to terminal before anything renders.
      const normalized = normalizePanes(workspaces);
      // The cache can be older than the backend (or absent after a storage
      // restore). Resolve selection against the authoritative list again:
      // module initialization could neither restore a backend-only workspace
      // nor know that a cached workspace had since been archived/deleted.
      const selectedId = get().activeWorkspaceId;
      const activeWorkspaceId = normalized.some(
        (workspace) => workspace.id === selectedId && workspace.status !== "archived",
      )
        ? selectedId
        : readActiveWorkspaceId(normalized);
      const zoomedPaneId = normalized.some(
        (workspace) =>
          workspace.status !== "archived" &&
          workspace.panes.some((pane) => pane.id === get().zoomedPaneId),
      )
        ? get().zoomedPaneId
        : null;
      lastFocusedPaneIds.clear();
      set({ workspaces: normalized, activeWorkspaceId, zoomedPaneId });
      writeActiveWorkspaceId(activeWorkspaceId);
      syncToLocalStorage(normalized);
    }
  },
}));
