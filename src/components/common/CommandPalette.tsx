import { useState, useEffect, useRef, useMemo } from "react";
import { Search, FileText, LayoutGrid, ZoomIn, ZoomOut, RotateCcw, Palette } from "lucide-react";
import { useAppStore, moduleViewId } from "@/stores/appStore";
import { useAppearanceStore } from "@/stores/appearanceStore";
import { useModuleStore } from "@/stores/moduleStore";
import { getModulesSorted } from "@/modules/registry";
import { usePromptStore } from "@/stores/promptStore";
import {
  paletteRoutes,
  resolveModuleAlias,
  routePaletteIcon,
  routePaletteLabel,
} from "@/lib/routeRegistry";
import { createInstantWorkspace, openWorkspaceCreationModal } from "@/lib/workspaceCreation";

interface PaletteAction {
  id: string;
  label: string;
  description?: string;
  icon: React.ReactNode;
  action: () => void;
  keywords?: string[];
}

export function CommandPalette() {
  const [query, setQuery] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const [selectedIndex, setSelectedIndex] = useState(0);

  const setActiveView = useAppStore((s) => s.setActiveView);
  const setCommandPaletteOpen = useAppStore((s) => s.setCommandPaletteOpen);
  const openSettings = useAppStore((s) => s.openSettings);
  const increaseAppScale = useAppearanceStore((s) => s.increaseAppScale);
  const decreaseAppScale = useAppearanceStore((s) => s.decreaseAppScale);
  const resetAppScale = useAppearanceStore((s) => s.resetAppScale);
  const moduleStates = useModuleStore((s) => s.states);
  const promptTemplates = usePromptStore((s) => s.templates);
  const sendPromptToAgent = usePromptStore((s) => s.sendToAgentChat);

  const actions = useMemo<PaletteAction[]>(() => {
    // Creation commands. The route registry describes NAVIGATION only, so
    // these are a separate section rather than a faked route — Ctrl+K used to
    // be navigation-only, which left the palette (promoted on the Welcome
    // screen) unable to create the app's top-level object.
    const items: PaletteAction[] = [
      {
        id: "action-new-workspace",
        label: "New Workspace",
        description: "Choose templates, CLI sessions, models and location",
        icon: <LayoutGrid size={14} className="text-accent-green" />,
        action: () => openWorkspaceCreationModal(),
        keywords: ["new", "create", "workspace", "project", "template"],
      },
      {
        id: "action-new-workspace-instant",
        label: "New Workspace (empty)",
        description: "Create an empty workspace in the current project folder",
        icon: <LayoutGrid size={14} className="text-text-secondary" />,
        action: () => void createInstantWorkspace(),
        keywords: ["new", "create", "workspace", "empty", "blank", "quick"],
      },
      {
        id: "appearance.appScale.increase",
        label: "Increase App scale",
        description: "Enlarge all nonterminal text one step",
        icon: <ZoomIn size={14} className="text-text-secondary" />,
        action: increaseAppScale,
        keywords: ["scale", "appearance", "zoom", "text", "bigger", "increase"],
      },
      {
        id: "appearance.appScale.decrease",
        label: "Decrease App scale",
        description: "Shrink all nonterminal text one step",
        icon: <ZoomOut size={14} className="text-text-secondary" />,
        action: decreaseAppScale,
        keywords: ["scale", "appearance", "zoom", "text", "smaller", "decrease"],
      },
      {
        id: "appearance.appScale.reset",
        label: "Reset App scale",
        description: "Return App scale to 100%",
        icon: <RotateCcw size={14} className="text-text-secondary" />,
        action: resetAppScale,
        keywords: ["scale", "appearance", "zoom", "text", "reset", "default"],
      },
      {
        id: "appearance.open",
        label: "Open Appearance settings",
        description: "Adjust App scale, reading size, density and terminal text",
        icon: <Palette size={14} className="text-accent-green" />,
        action: () => openSettings(),
        keywords: ["appearance", "settings", "font", "size", "scale", "zoom", "readability", "density", "terminal"],
      },
    ];

    // D4: every navigation destination comes from the one route registry, so
    // the palette can no longer drift from the rail (audit P1-9 — it used to
    // omit Agents, Flight Deck, Costs and Dictation).
    items.push(
      ...paletteRoutes()
      // A route backed by an optional module is only offered while that module
      // is enabled (preserves the old module-gated Dictation entry).
      .filter((route) => !route.moduleId || (moduleStates[route.moduleId]?.enabled ?? false))
      .map((route) => {
        const Icon = routePaletteIcon(route);
        return {
          id: route.id,
          label: routePaletteLabel(route),
          description: route.palette.description,
          icon: <Icon size={14} className={route.palette.iconColor ?? "text-text-secondary"} />,
          action: () => setActiveView(route.id),
          keywords: route.palette.keywords,
        };
      }),
    );

    for (const template of promptTemplates) {
      items.push({
        id: `prompt-${template.id}`,
        label: `Prompt: ${template.name}`,
        description: `Launch ${template.category} prompt in a conversation tile`,
        icon: <FileText size={14} className="text-accent-blue" />,
        action: () => void sendPromptToAgent(template.id),
        keywords: ["prompt", "template", template.category, template.name.toLowerCase()],
      });
    }

    // Add enabled modules. Modules that are aliases of a first-class shell
    // route (Dictation) are skipped — the registry row above is the canonical
    // destination, so Ctrl+K lists them exactly once.
    for (const mod of getModulesSorted()) {
      if (resolveModuleAlias(mod.id)) continue;
      if (moduleStates[mod.id]?.enabled) {
        const Icon = mod.icon;
        items.push({
          id: `mod-${mod.id}`,
          label: mod.name,
          description: mod.description,
          icon: <Icon size={14} className={mod.iconColor} />,
          action: () => setActiveView(moduleViewId(mod.id)),
          keywords: [mod.id, mod.category],
        });
      }
    }

    return items;
  }, [setActiveView, moduleStates, promptTemplates, sendPromptToAgent, increaseAppScale, decreaseAppScale, resetAppScale, openSettings]);

  const filtered = useMemo(() => {
    if (!query.trim()) return actions;
    const q = query.toLowerCase();
    return actions.filter(
      (a) =>
        a.label.toLowerCase().includes(q) ||
        a.description?.toLowerCase().includes(q) ||
        a.keywords?.some((k) => k.includes(q)),
    );
  }, [actions, query]);

  // Reset selection when filtered list changes
  useEffect(() => {
    setSelectedIndex(0);
  }, [filtered.length]);

  // Auto-focus input
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  function close() {
    setCommandPaletteOpen(false);
  }

  function execute(action: PaletteAction) {
    action.action();
    close();
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Escape") {
      e.preventDefault();
      close();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      setSelectedIndex((i) => Math.min(i + 1, filtered.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSelectedIndex((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (filtered[selectedIndex]) {
        execute(filtered[selectedIndex]);
      }
    }
  }

  // Scroll selected item into view
  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const item = list.children[selectedIndex] as HTMLElement;
    if (item) {
      item.scrollIntoView({ block: "nearest" });
    }
  }, [selectedIndex]);

  return (
    <div
      className="fixed inset-0 z-[100] flex items-start justify-center pt-[15vh]"
      onClick={close}
    >
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/50" />

      {/* Palette */}
      <div
        className="relative w-[480px] overflow-hidden rounded-xl border border-bg-border bg-bg-secondary shadow-2xl"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={handleKeyDown}
      >
        {/* Search input */}
        <div className="flex items-center gap-2 border-b border-bg-border px-4 py-3">
          <Search size={14} className="flex-shrink-0 text-text-muted" />
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Type a command..."
            className="flex-1 bg-transparent text-sm text-text-primary placeholder:text-text-muted focus:outline-none"
          />
          <kbd className="rounded border border-bg-border bg-bg-elevated px-1.5 py-0.5 text-[10px] text-text-muted">
            ESC
          </kbd>
        </div>

        {/* Results */}
        <div ref={listRef} className="max-h-[320px] overflow-y-auto py-1">
          {filtered.length === 0 ? (
            <div className="px-4 py-6 text-center text-xs text-text-muted">
              No matching commands
            </div>
          ) : (
            filtered.map((action, i) => (
              <button
                key={action.id}
                onClick={() => execute(action)}
                onMouseEnter={() => setSelectedIndex(i)}
                className={`flex w-full items-center gap-3 px-4 py-2.5 text-left transition-colors ${
                  i === selectedIndex
                    ? "bg-accent-green/10 text-text-primary"
                    : "text-text-secondary hover:bg-bg-hover"
                }`}
              >
                {action.icon}
                <div className="min-w-0 flex-1">
                  <div className="truncate text-xs font-medium">{action.label}</div>
                  {action.description && (
                    <div className="truncate text-[10px] text-text-muted">{action.description}</div>
                  )}
                </div>
              </button>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
