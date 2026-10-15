import { create } from "zustand";
import { DEFAULT_API_AGENT, getDefaultModel } from "@/lib/api-models";
import { loadFromStorage, saveToStorage } from "@/lib/storage";
import { setAuxRoutingOverrides } from "@/lib/tauri";
import { logSwallowed } from "@/lib/logSwallowed";
import type { TaskType } from "@/types/flight";
import type { AuxRouteMapping, AuxTaskClass, RouteMapping } from "@/types/routing";
import { ALL_AUX_TASK_CLASSES, ALL_TASK_TYPES } from "@/types/routing";

import { storageKey } from "@/lib/brand";
const STORAGE_KEY = storageKey("routing");
const AUX_STORAGE_KEY = storageKey("routing-aux");

const DEFAULT_AGENT = DEFAULT_API_AGENT;

function buildDefaults(): RouteMapping[] {
  return ALL_TASK_TYPES.map((taskType) => ({
    taskType,
    agentConfigId: DEFAULT_AGENT,
    model: getDefaultModel(DEFAULT_AGENT),
  }));
}

function loadMappings(): RouteMapping[] {
  const saved = loadFromStorage<RouteMapping[]>(STORAGE_KEY, []);
  if (saved.length === 0) return buildDefaults();

  // Ensure every task type has a mapping (in case new types were added)
  const defaults = buildDefaults();
  return defaults.map((d) => saved.find((s) => s.taskType === d.taskType) ?? d);
}

function saveMappings(mappings: RouteMapping[]) {
  saveToStorage(STORAGE_KEY, mappings);
}

// === Auxiliary AI routing (WI-1) ==========================================
//
// `provider: null` is the shipped default and means "Auto": the backend picks
// the cheapest provider the user actually has an API key for, ranked against
// `shared/model-pricing.json`. Auto is deliberately the default so a fresh
// install never silently pins an expensive model — and there is no
// subscription-OAuth option at all, by design.

function buildAuxDefaults(): AuxRouteMapping[] {
  return ALL_AUX_TASK_CLASSES.map((taskClass) => ({
    taskClass,
    provider: null,
    model: null,
  }));
}

function loadAuxMappings(): AuxRouteMapping[] {
  const saved = loadFromStorage<AuxRouteMapping[]>(AUX_STORAGE_KEY, []);
  const defaults = buildAuxDefaults();
  if (saved.length === 0) return defaults;
  return defaults.map((d) => saved.find((s) => s.taskClass === d.taskClass) ?? d);
}

function saveAuxMappings(mappings: AuxRouteMapping[]) {
  saveToStorage(AUX_STORAGE_KEY, mappings);
}

/**
 * Wire shape for `set_aux_routing_overrides`. Task classes left on Auto are
 * omitted entirely, so an empty object is a faithful "everything automatic".
 */
export function auxOverridePayload(
  mappings: AuxRouteMapping[],
): Record<string, { provider: string | null; model: string | null }> {
  const payload: Record<string, { provider: string | null; model: string | null }> = {};
  for (const mapping of mappings) {
    if (!mapping.provider) continue;
    payload[mapping.taskClass] = {
      provider: mapping.provider,
      model: mapping.model,
    };
  }
  return payload;
}

/**
 * Push the settings into the backend, which is where they take effect. Failure
 * is non-fatal and logged: the backend falls back to automatic
 * cheapest-configured routing, never to a subscription credential.
 */
function syncAuxToBackend(mappings: AuxRouteMapping[]) {
  void setAuxRoutingOverrides(auxOverridePayload(mappings)).catch(
    logSwallowed("routingStore.syncAuxToBackend"),
  );
}

interface RoutingStore {
  mappings: RouteMapping[];
  auxMappings: AuxRouteMapping[];
  setMapping: (taskType: TaskType, agentConfigId: string, model: string | null) => void;
  resetToDefaults: () => void;
  resolveForTask: (taskType: TaskType) => { agentConfigId: string; model?: string };
  setAuxMapping: (taskClass: AuxTaskClass, provider: string | null, model: string | null) => void;
  resetAuxToDefaults: () => void;
  resolveForAuxTask: (taskClass: AuxTaskClass) => { provider: string | null; model: string | null };
  /** Re-push the persisted auxiliary settings to the backend (app boot). */
  syncAuxRouting: () => void;
}

export const useRoutingStore = create<RoutingStore>((set, get) => ({
  mappings: loadMappings(),
  auxMappings: loadAuxMappings(),

  setMapping: (taskType, agentConfigId, model) => {
    set((s) => {
      const mappings = s.mappings.map((m) =>
        m.taskType === taskType ? { ...m, agentConfigId, model } : m,
      );
      saveMappings(mappings);
      return { mappings };
    });
  },

  resetToDefaults: () => {
    const mappings = buildDefaults();
    saveMappings(mappings);
    set({ mappings });
  },

  resolveForTask: (taskType) => {
    const mapping = get().mappings.find((m) => m.taskType === taskType);
    if (!mapping) return { agentConfigId: DEFAULT_AGENT, model: getDefaultModel(DEFAULT_AGENT) };
    return {
      agentConfigId: mapping.agentConfigId,
      ...(mapping.model ? { model: mapping.model } : {}),
    };
  },

  setAuxMapping: (taskClass, provider, model) => {
    set((s) => {
      const auxMappings = s.auxMappings.map((m) =>
        m.taskClass === taskClass ? { ...m, provider, model } : m,
      );
      saveAuxMappings(auxMappings);
      syncAuxToBackend(auxMappings);
      return { auxMappings };
    });
  },

  resetAuxToDefaults: () => {
    const auxMappings = buildAuxDefaults();
    saveAuxMappings(auxMappings);
    syncAuxToBackend(auxMappings);
    set({ auxMappings });
  },

  resolveForAuxTask: (taskClass) => {
    const mapping = get().auxMappings.find((m) => m.taskClass === taskClass);
    return {
      provider: mapping?.provider ?? null,
      model: mapping?.model ?? null,
    };
  },

  syncAuxRouting: () => {
    syncAuxToBackend(get().auxMappings);
  },
}));
