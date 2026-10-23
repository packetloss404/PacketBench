/**
 * Shared sidebar preferences.
 *
 * Kept deliberately separate from `agentTaskStore` (which owns the
 * conversations themselves) so the two lanes don't collide — this store
 * only holds lightweight, UI-local metadata:
 *   - per-conversation / per-row pin flags (keyed by row id)
 *   - project group display labels (keyed by projectPath)
 *
 * Tile program (P4-S2): `projectLabels` moved here from `agentTaskStore` so the
 * FleetSidebar and the legacy AgentSidebar share ONE source of truth for
 * project-group renames (single-truth; both sidebars stay in sync). The
 * localStorage key is unchanged (`packetbench:project-labels`, with the same
 * one-shot legacy migration), so existing user renames carry over untouched.
 *
 * This store is explicitly exempt from the P1 store-isolation import ban — it is
 * UI-prefs, not an engine store, and both sidebars read it directly.
 */
import { create } from "zustand";
import { loadFromStorage, saveToStorage } from "@/lib/storage";
import { storageKey, LEGACY_STORAGE_PREFIX } from "@/lib/brand";

const STORAGE_KEY = storageKey("agent-sidebar-prefs");
const PROJECT_LABELS_STORAGE_KEY = storageKey("project-labels");
const LEGACY_PROJECT_LABELS_STORAGE_KEY = `${LEGACY_STORAGE_PREFIX}project-labels`;

export interface ConversationPrefs {
  pinned?: boolean;
  /**
   * Fleet sidebar: the workspace row is expanded to show its session children
   * and the FILES subtree. Persisted (rather than component state) so the tree
   * a user opened survives switching views, and so an expanded workspace is
   * still expanded on the next launch. Absent ⇒ collapsed.
   */
  expanded?: boolean;
}

/** V7 — sidebar geometry bounds. A geometry preference, not a font size. */
export const AGENT_SIDEBAR_DEFAULT_WIDTH = 300;
export const AGENT_SIDEBAR_MIN_WIDTH = 240;
export const AGENT_SIDEBAR_MAX_WIDTH = 480;

/** Clamp/validate a persisted or runtime width to the documented range. */
export function clampSidebarWidth(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return AGENT_SIDEBAR_DEFAULT_WIDTH;
  }
  return Math.min(
    AGENT_SIDEBAR_MAX_WIDTH,
    Math.max(AGENT_SIDEBAR_MIN_WIDTH, Math.round(value)),
  );
}

interface PersistedState {
  /** rowId (conversationId or workspaceId) -> { pinned? } */
  prefs: Record<string, ConversationPrefs>;
  /** Sidebar width in CSS pixels (240..480). */
  width: number;
}

interface AgentSidebarPrefsStore extends PersistedState {
  /** projectPath -> custom display label for the project group header. */
  projectLabels: Record<string, string>;
  togglePinned: (rowId: string) => void;
  /** Fleet sidebar: expand/collapse a workspace row's children + FILES tree. */
  toggleExpanded: (rowId: string) => void;
  setProjectLabel: (projectPath: string, label: string) => void;
  /** V7: set + persist the sidebar width (clamped to 240..480). */
  setWidth: (width: number) => void;
}

function load(): PersistedState {
  const raw = loadFromStorage<Partial<PersistedState>>(STORAGE_KEY, {});
  // Defensive: reduce persisted prefs to the documented shape so a stale /
  // malformed entry (e.g. dropped `tags`/`sortMode` fields) can't leak into
  // the sidebar render. Those stale fields are silently dropped here and
  // will not be written back on the next persist().
  const prefs: Record<string, ConversationPrefs> = {};
  for (const [id, entry] of Object.entries(raw?.prefs ?? {})) {
    const e = entry as { pinned?: unknown; expanded?: unknown };
    const next: ConversationPrefs = {};
    if (e?.pinned === true) next.pinned = true;
    if (e?.expanded === true) next.expanded = true;
    // Only keep rows that actually carry a preference — an all-false entry is
    // indistinguishable from absent and would grow the blob forever.
    if (next.pinned || next.expanded) prefs[id] = next;
  }
  return { prefs, width: clampSidebarWidth(raw?.width) };
}

function persist(state: PersistedState) {
  saveToStorage(STORAGE_KEY, { prefs: state.prefs, width: state.width });
}

/**
 * Load project labels from the branded key, migrating the legacy
 * `packetcode:project-labels` blob one-shot on first boot. Mirrors the logic
 * that previously lived in `agentTaskStore.loadProjectLabels`.
 */
function loadProjectLabels(): Record<string, string> {
  if (typeof localStorage === "undefined") return {};
  try {
    const currentRaw = localStorage.getItem(PROJECT_LABELS_STORAGE_KEY);
    if (currentRaw) return JSON.parse(currentRaw) as Record<string, string>;

    const legacyRaw = localStorage.getItem(LEGACY_PROJECT_LABELS_STORAGE_KEY);
    if (!legacyRaw) return {};

    const migrated = JSON.parse(legacyRaw) as Record<string, string>;
    localStorage.setItem(PROJECT_LABELS_STORAGE_KEY, JSON.stringify(migrated));
    return migrated;
  } catch {
    return {};
  }
}

/**
 * Set one boolean flag on a row's prefs, dropping the row entirely once no flag
 * is left. Shared by pin and expand so toggling one never clobbers the other —
 * the pre-expand version rebuilt the entry as `{ pinned: true }`, which would
 * have silently collapsed an expanded row on pin.
 */
function setFlag(
  current: Record<string, ConversationPrefs>,
  width: number,
  rowId: string,
  flag: keyof ConversationPrefs,
  value: boolean,
): PersistedState {
  const prefs = { ...current };
  const next: ConversationPrefs = { ...(prefs[rowId] ?? {}) };
  if (value) next[flag] = true;
  else delete next[flag];
  if (next.pinned || next.expanded) prefs[rowId] = next;
  else delete prefs[rowId];
  persist({ prefs, width });
  return { prefs, width };
}

const initial = load();

export const useAgentSidebarPrefsStore = create<AgentSidebarPrefsStore>((set) => ({
  prefs: initial.prefs,
  width: initial.width,
  projectLabels: loadProjectLabels(),

  togglePinned: (rowId) => {
    if (!rowId) return;
    set((s) => setFlag(s.prefs, s.width, rowId, "pinned", !s.prefs[rowId]?.pinned));
  },

  toggleExpanded: (rowId) => {
    if (!rowId) return;
    set((s) => setFlag(s.prefs, s.width, rowId, "expanded", !s.prefs[rowId]?.expanded));
  },

  setWidth: (width) => {
    set((s) => {
      const next = clampSidebarWidth(width);
      if (next === s.width) return s;
      persist({ prefs: s.prefs, width: next });
      return { width: next };
    });
  },

  setProjectLabel: (projectPath, label) => {
    set((s) => {
      const next = { ...s.projectLabels };
      const trimmed = label.trim();
      if (trimmed) next[projectPath] = trimmed;
      else delete next[projectPath];
      try {
        localStorage.setItem(PROJECT_LABELS_STORAGE_KEY, JSON.stringify(next));
      } catch {
        // Best effort.
      }
      return { projectLabels: next };
    });
  },
}));
