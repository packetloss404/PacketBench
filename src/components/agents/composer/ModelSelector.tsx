import { useEffect, useRef, useState, type ReactNode } from "react";

import {
  Loader2,
  AlertCircle,
  ChevronDown,
  CornerDownLeft,
  RefreshCw,
  Settings2,
} from "lucide-react";
import { Dropdown, DropdownItem } from "@/components/ui/Dropdown";
import type { AgentCli } from "@/stores/agentTaskStore";
import { useAppStore } from "@/stores/appStore";
import { buildApiModel, getModelSpeed, MODEL_SPEED_LABEL, type ApiModel } from "@/lib/api-models";
import { providerEnumeratesLive, resolveModelRows, liveModelSource } from "@/lib/liveModels";
import type { OllamaModelsState } from "../hooks/useOllamaModels";
import { useCustomModels } from "../hooks/useCustomModels";
import { useLiveModels } from "../hooks/useLiveModels";

/** Compact context-window label, e.g. 200_000 -> "200K ctx", 1_000_000 -> "1M ctx". */
function formatContextWindow(tokens: number | undefined): string | null {
  if (!tokens || tokens <= 0) return null;
  if (tokens >= 1_000_000) {
    const m = tokens / 1_000_000;
    return `${Number.isInteger(m) ? m : m.toFixed(1)}M ctx`;
  }
  return `${Math.round(tokens / 1000)}K ctx`;
}

/** Compact per-1M-token price label, e.g. { input: 3, output: 15 } -> "$3/$15". */
function formatPricing(pricing: { input: number; output: number } | undefined): string | null {
  if (!pricing) return null;
  return `$${pricing.input}/$${pricing.output}`;
}

/**
 * "Use ‹what you typed›" — the escape hatch that keeps enumeration a
 * CONVENIENCE rather than a gate.
 *
 * A model published this morning is in no bundled catalog and may not yet be in
 * the provider's own listing either; without this row the picker would be the
 * only way to change model and would silently refuse to name it. Offered in
 * both popover directions and for every provider, including the ones whose
 * lists are empty — an empty picker with a search box you can type into is
 * still a working control.
 */
function freeTextRow(typed: string, onSelect: (model: string) => void): ReactNode {
  if (!typed) return null;
  return (
    <DropdownItem onClick={() => onSelect(typed)}>
      <span className="flex items-center gap-1.5 text-text-secondary">
        <CornerDownLeft size={10} />
        Use &ldquo;{typed}&rdquo;
      </span>
    </DropdownItem>
  );
}

/** One selectable model row, rendered identically by both popover directions. */
interface ModelRow {
  key: string;
  /** Text the search box filters on. */
  searchText: string;
  body: ReactNode;
  onSelect: () => void;
  /** Tool-less Ollama model while the surface needs tool calling: shown but
   * not selectable (backend pre-flight is the real enforcement point). */
  disabled?: boolean;
}

interface ModelSelectorProps {
  selectedAgent: AgentCli;
  selectedModel: string;
  onModelChange: (model: string) => void;
  /**
   * Rows from `capabilitiesFor(conversation).models`.
   *
   * Whether these OVERRIDE the bundled catalog is decided by
   * {@link modelsAreAuthoritative}, never by their length — see the `[]`
   * ruling in `lib/liveModels.ts`. This component used to make that call
   * itself with `models.length > 0 ? models : catalog`, which disagreed with
   * `agentCapabilities.ts` about what an empty list means; both now resolve
   * through `resolveModelRows`.
   *
   * Omitted entirely = "no opinion", the pre-seam behaviour: the picker falls
   * back to this agent's live enumeration, then to the bundled catalog.
   */
  models?: ApiModel[];
  /**
   * Did `models` come from the session's own backend? Pass
   * `caps.modelsAreAuthoritative` alongside `caps.models`. When true, an EMPTY
   * `models` means "this backend serves none" and the catalog must not stand
   * in; when false or absent, an empty `models` is simply no answer yet.
   */
  modelsAreAuthoritative?: boolean;
  ollamaModels: OllamaModelsState;
  refreshOllamaModels: () => void;
  /** Imperative "open now" channel, e.g. so the `/model` slash command can
   * open whichever surface currently owns the picker. */
  openSignal?: number;
  /**
   * Open the list UPWARD. The composer sits on the bottom edge of the pane, so
   * the shared `Dropdown` (which is hard-coded to `top-full`) would render its
   * menu off-screen there. This flag swaps in an equivalent self-contained
   * popover anchored to `bottom-[calc(100%+8px)]`; the rows, the search box and
   * the `openSignal` behaviour are the same either way.
   */
  dropUp?: boolean;
  /** True when the surface this picker serves runs tool-carrying turns
   * (conversation tiles always do). Ollama models the daemon reports as
   * tool-less are disabled; unknown-capability models stay selectable. */
  requiresTools?: boolean;
}

export function ModelSelector({
  selectedAgent,
  selectedModel,
  onModelChange,
  models,
  modelsAreAuthoritative = false,
  ollamaModels,
  refreshOllamaModels,
  openSignal,
  dropUp = false,
  requiresTools = false,
}: ModelSelectorProps) {
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState("");
  const rootRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  // Same imperative channel the shared Dropdown exposes.
  useEffect(() => {
    if (openSignal !== undefined && openSignal > 0) setOpen(true);
  }, [openSignal]);

  useEffect(() => {
    if (!open) {
      setFilter("");
      return;
    }
    const id = window.setTimeout(() => searchRef.current?.focus(), 0);
    function handleClick(e: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClick);
    return () => {
      window.clearTimeout(id);
      document.removeEventListener("mousedown", handleClick);
    };
  }, [open]);

  const isOllama = selectedAgent === "api-ollama";
  const isCustom = selectedAgent === "api-custom";
  // LM2: the custom endpoint models are a runtime-managed manual list, so
  // (like Ollama live list) the static catalog carries none.
  const { customModels, refresh: refreshCustomModels } = useCustomModels(selectedAgent);
  // Every other live-enumerating provider goes through the shared cache. It
  // serves whatever it has immediately and refreshes behind the picker, so
  // opening this menu never waits on the network.
  const { answer: liveAnswer, refresh: refreshLiveModels } = useLiveModels(selectedAgent);
  const openSettings = useAppStore((s) => s.openSettings);

  // ONE precedence decision, in ONE place. This component used to make its own
  // (`models.length > 0 ? models : catalog`) and `agentCapabilities.ts` made a
  // contradictory one; `LaunchAsyncFlightModal` and `ProviderRoutingCard` made
  // two more. They all resolve through `resolveModelRows` now.
  const resolution = resolveModelRows({
    agent: selectedAgent,
    authoritative: modelsAreAuthoritative ? models : undefined,
    live: liveAnswer,
  });
  // An explicitly-passed NON-EMPTY list is the caller's rows either way; the
  // `authoritative` flag only ever decides whether an EMPTY one may override
  // the bundled catalog. Same shape as the old expression, correct meaning.
  const modelRows = models && models.length > 0 ? models : resolution.rows;

  // A live-enumerating provider ALWAYS gets a picker, even at zero rows: zero
  // rows is a state the user can act on (refresh, type an id, open Settings),
  // and unmounting turns it into a dead read-only label with no way out. This
  // replaces a hardcoded three-agent exemption that had already drifted from
  // the set of providers that actually enumerate.
  const enumeratesLive = providerEnumeratesLive(selectedAgent);
  if (!enumeratesLive && modelRows.length === 0) return null;

  // Trigger label. In Ollama mode the label is the live-fetched model name
  // (just the `name` string; Ollama installs have no separate display label).
  let triggerLabel: string;
  if (isOllama) {
    if (Array.isArray(ollamaModels)) {
      const match = ollamaModels.find((m) => m.name === selectedModel);
      triggerLabel = match?.name ?? selectedModel ?? ollamaModels[0]?.name ?? "Select model";
    } else if (ollamaModels === "loading") {
      triggerLabel = selectedModel || "Loading models…";
    } else {
      triggerLabel = selectedModel || "Ollama unreachable";
    }
  } else if (isCustom) {
    triggerLabel = selectedModel || "Select model";
  } else {
    const currentModel = modelRows.find((m) => m.value === selectedModel);
    triggerLabel = currentModel?.label || selectedModel || "Select model";
  }

  const speed = getModelSpeed(selectedModel);
  const speedClass =
    speed === "fast"
      ? "text-accent-green bg-accent-green/10"
      : speed === "thorough"
        ? "text-accent-purple bg-accent-purple/10"
        : "text-accent-blue bg-accent-blue/10";

  // ── Rows + notices, computed once and rendered by either direction ──────
  const rows: ModelRow[] = [];
  let header: ReactNode = null;
  let notice: ReactNode = null;

  if (isOllama) {
    header = (
      <div className="flex items-center justify-between px-3 py-1 text-meta uppercase tracking-wide text-text-muted">
        <span>Installed models</span>
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            refreshOllamaModels();
          }}
          className="rounded p-0.5 text-text-muted transition-colors hover:bg-bg-hover hover:text-text-primary"
          title="Refresh installed Ollama models"
        >
          <RefreshCw size={10} />
        </button>
      </div>
    );
    if (ollamaModels === "loading") {
      notice = (
        <div className="flex items-center gap-1.5 px-3 py-1.5 text-text-muted">
          <Loader2 size={10} className="animate-spin motion-reduce:animate-none" />
          Loading models…
        </div>
      );
    } else if (!Array.isArray(ollamaModels)) {
      notice = (
        <>
          <div className="flex items-center gap-1.5 px-3 py-1.5 text-accent-red">
            <AlertCircle size={10} />
            {ollamaModels.error}
          </div>
          <button
            type="button"
            onClick={() => {
              refreshOllamaModels();
              setOpen(false);
            }}
            className="w-full px-3 py-1.5 text-left text-ui text-text-primary transition-colors hover:bg-bg-hover"
          >
            <span className="flex items-center gap-1.5 text-text-secondary">
              <RefreshCw size={10} />
              Retry
            </span>
          </button>
        </>
      );
    } else if (ollamaModels.length === 0) {
      notice = (
        <div className="px-3 py-1.5 text-meta text-text-muted">
          No models installed. Run{" "}
          <code className="text-text-secondary">ollama pull &lt;model&gt;</code> in a terminal.
        </div>
      );
    } else {
      for (const m of ollamaModels) {
        const toolless = requiresTools && m.supportsTools === false;
        // The daemon reports a trained context window and this picker threw it
        // away, so every Ollama row rendered with no ctx chip while every cloud
        // row had one. Through the shared builder the daemon's number wins and
        // `getModelContextWindow` fills the gap for an older daemon.
        const ctx = formatContextWindow(
          buildApiModel({
            value: m.name,
            contextWindow: m.contextLength ?? undefined,
          }).contextWindow,
        );
        rows.push({
          key: m.name,
          searchText: m.name,
          disabled: toolless,
          onSelect: toolless ? () => {} : () => onModelChange(m.name),
          body: (
            <span
              className={`flex w-full items-center justify-between gap-2 ${toolless ? "opacity-50" : ""}`}
              title={
                toolless
                  ? "This model has no tools template — agent turns need tool calling"
                  : undefined
              }
            >
              <span className="truncate">{m.name}</span>
              <span className="flex shrink-0 items-center gap-2 text-meta tabular-nums text-text-muted">
                {ctx && <span>{ctx}</span>}
                {toolless ? (
                  <span>no tools</span>
                ) : (
                  typeof m.size === "number" && <span>{(m.size / 1e9).toFixed(1)} GB</span>
                )}
              </span>
            </span>
          ),
        });
      }
    }
  } else if (isCustom) {
    header = (
      <div className="flex items-center justify-between px-3 py-1 text-meta uppercase tracking-wide text-text-muted">
        <span>Configured models</span>
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            refreshCustomModels();
          }}
          className="rounded p-0.5 text-text-muted transition-colors hover:bg-bg-hover hover:text-text-primary"
          title="Reload the configured model list"
        >
          <RefreshCw size={10} />
        </button>
      </div>
    );
    if (customModels === "loading") {
      notice = (
        <div className="flex items-center gap-1.5 px-3 py-1.5 text-text-muted">
          <Loader2 size={10} className="animate-spin motion-reduce:animate-none" />
          Loading models…
        </div>
      );
    } else if (!Array.isArray(customModels)) {
      notice = (
        <div className="flex items-center gap-1.5 px-3 py-1.5 text-accent-red">
          <AlertCircle size={10} />
          {customModels.error}
        </div>
      );
    } else if (customModels.length === 0) {
      notice = (
        <div className="px-3 py-1.5 text-meta text-text-muted">
          No models configured for the custom endpoint yet.
        </div>
      );
    } else {
      for (const name of customModels) {
        rows.push({
          key: name,
          searchText: name,
          onSelect: () => onModelChange(name),
          body: <span className="truncate">{name}</span>,
        });
      }
    }
    rows.push({
      key: "__edit_custom_models__",
      searchText: "edit models settings",
      onSelect: () => openSettings({ section: "providers" }),
      body: (
        <span className="flex items-center gap-1.5 text-text-secondary">
          <Settings2 size={10} />
          Edit models…
        </span>
      ),
    });
  } else {
    // Every remaining provider renders the same way — bundled catalog rows, an
    // and a live provider list are all just rows.
    // What differs is the HEADER (is a refresh possible?) and the NOTICE (are
    // these really this provider's models?), and both come from the seam
    // rather than from a per-provider branch.
    if (enumeratesLive) {
      const refreshable = liveModelSource(selectedAgent)?.producer === "ipc";
      header = (
        <div className="flex items-center justify-between px-3 py-1 text-meta uppercase tracking-wide text-text-muted">
          <span>
            {resolution.source === "live"
              ? "Available models"
              : resolution.source === "bundled"
                ? "Built-in models"
                : "Models"}
            {resolution.stale ? " · stale" : ""}
          </span>
          {refreshable && (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                refreshLiveModels();
              }}
              className="rounded p-0.5 text-text-muted transition-colors hover:bg-bg-hover hover:text-text-primary"
              title="Re-fetch this provider's model list"
            >
              <RefreshCw size={10} />
            </button>
          )}
        </div>
      );
    }
    if (resolution.notice) {
      // A bundled fallback is BADGED, never passed off as the provider's real
      // catalog — "no key yet" and "the provider rejected your key" are
      // different problems and the user can only fix the one they are told
      // about.
      notice = <div className="px-3 py-1.5 text-meta text-text-muted">{resolution.notice}</div>;
    }
    for (const m of modelRows) {
      const ctx = formatContextWindow(m.contextWindow);
      const price = formatPricing(m.pricing);
      rows.push({
        key: m.value,
        searchText: m.label,
        onSelect: () => onModelChange(m.value),
        body: (
          <span className="flex w-full items-center justify-between gap-3">
            <span className="truncate">{m.label}</span>
            {(ctx || price) && (
              <span className="flex shrink-0 items-center gap-2 text-meta tabular-nums text-text-muted">
                {ctx && <span>{ctx}</span>}
                {price && <span>{price}</span>}
              </span>
            )}
          </span>
        ),
      });
    }
  }

  const trigger = (
    <span className="flex items-center gap-1.5 text-ui text-text-muted">
      <span>{triggerLabel}</span>
      <span
        className={`rounded px-1 py-px text-meta font-medium ${speedClass}`}
        title={`${MODEL_SPEED_LABEL[speed]} mode (heuristic)`}
      >
        {MODEL_SPEED_LABEL[speed]}
      </span>
    </span>
  );

  // ── Downward (launch card / anywhere with room below) ───────────────────
  if (!dropUp) {
    return (
      <Dropdown
        searchable
        searchPlaceholder="Search models…"
        openSignal={openSignal}
        trigger={trigger}
        footer={(typed) => freeTextRow(typed, onModelChange)}
      >
        {header}
        {notice}
        {rows.map((r) => (
          <DropdownItem key={r.key} onClick={r.disabled ? () => {} : r.onSelect}>
            {r.body}
          </DropdownItem>
        ))}
      </Dropdown>
    );
  }

  // ── Upward (composer row, pinned to the bottom edge) ────────────────────
  const needle = filter.trim().toLowerCase();
  const visible =
    needle === "" ? rows : rows.filter((r) => r.searchText.toLowerCase().includes(needle));

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="listbox"
        aria-expanded={open}
        className="flex items-center gap-1 rounded-md px-2 py-1 text-ui text-text-secondary transition-colors hover:bg-bg-hover hover:text-text-primary"
      >
        {trigger}
        <ChevronDown
          size={10}
          className={`transition-transform motion-reduce:transition-none ${open ? "rotate-180" : ""}`}
        />
      </button>
      {open && (
        <div
          role="listbox"
          className="absolute bottom-[calc(100%+8px)] right-0 z-50 min-w-[220px] rounded-lg border border-bg-border bg-bg-elevated py-1 shadow-xl"
        >
          <div className="px-1 pb-1">
            <input
              ref={searchRef}
              type="text"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              onKeyDown={(e) => {
                if (e.key !== "Escape") return;
                e.preventDefault();
                e.stopPropagation();
                if (filter !== "") setFilter("");
                else setOpen(false);
              }}
              placeholder="Search models…"
              className="w-full rounded border border-bg-border bg-bg-primary px-2 py-1 text-ui text-text-primary placeholder:text-text-muted focus:border-accent-green focus:outline-none"
            />
          </div>
          {header}
          {notice}
          {visible.map((r) => (
            <button
              key={r.key}
              type="button"
              role="option"
              aria-selected={r.key === selectedModel}
              aria-disabled={r.disabled}
              onClick={() => {
                if (r.disabled) return;
                r.onSelect();
                setOpen(false);
              }}
              className="w-full px-3 py-1.5 text-left text-ui text-text-primary transition-colors hover:bg-bg-hover"
            >
              {r.body}
            </button>
          ))}
          {/* Enumeration is a convenience, not a gate — see FreeTextModelRow.
              The upward popover owns its own search box, so it offers the same
              escape hatch directly rather than through the Dropdown context. */}
          {filter.trim() !== "" && (
            <button
              type="button"
              onClick={() => {
                onModelChange(filter.trim());
                setOpen(false);
              }}
              className="w-full px-3 py-1.5 text-left text-ui text-text-primary transition-colors hover:bg-bg-hover"
            >
              <span className="flex items-center gap-1.5 text-text-secondary">
                <CornerDownLeft size={10} />
                Use &ldquo;{filter.trim()}&rdquo;
              </span>
            </button>
          )}
          {needle !== "" && visible.length === 0 && (
            <div className="px-2 py-1 text-meta text-text-muted">
              No matches in this provider&apos;s list.
            </div>
          )}
        </div>
      )}
    </div>
  );
}
