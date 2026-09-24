import { useCallback, useEffect, useMemo, useState } from "react";
import {
  AlertCircle,
  Atom,
  Bot,
  BrainCircuit,
  Check,
  ChevronDown,
  ChevronRight,
  Clock,
  Cpu,
  Diamond,
  Download,
  ExternalLink,
  FolderOpen,
  Github,
  Hexagon,
  Loader2,
  type LucideIcon,
  MousePointer2,
  Pencil,
  RefreshCw,
  RotateCcw,
  Sparkles,
  Terminal,
  Trash2,
  Wand2,
  Wind,
  X,
} from "lucide-react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { useAgentStore } from "@/stores/agentStore";
import { useCliOverrideStore } from "@/stores/cliOverrideStore";
import { useLayoutStore } from "@/stores/layoutStore";
import {
  brandClasses,
  CLI_CATALOG,
  cliLaunchSourceLabel,
  type CliCatalogEntry,
  getCliBinaries,
  packetCodeInstallCommand,
} from "@/lib/cli-catalog";
import {
  cliLaunchDiagnostics,
  detectCliCatalog,
  inspectPacketCodeInstallation,
  type DetectCatalogResult,
  type PacketCodeInstallationInspection,
  type PtyExitOutcome,
} from "@/lib/tauri";
import { ConfirmDeleteModal } from "@/components/ui/ConfirmDeleteModal";
import type { AgentConfig } from "@/types/agent";
import { TransientPtyModal } from "@/components/ui/TransientPtyModal";
import { CliCatalogHeader } from "./CliCatalogHeader";
import {
  PacketCodeIntegrationPanel,
  type PacketCodeInstallReport,
} from "./PacketCodeIntegrationPanel";
import { usePacketCodeIntegrationStore } from "@/stores/packetCodeIntegrationStore";

// Static map from catalog iconName -> lucide component. Catalog uses string
// names so backend/test code can stay framework-agnostic; resolve here.
const ICON_MAP: Record<string, LucideIcon> = {
  Bot,
  Atom,
  Cpu,
  Sparkles,
  Hexagon,
  Terminal,
  Github,
  Wand2,
  MousePointer2,
  BrainCircuit,
  Wind,
  Diamond,
};

function renderCatalogIcon(name: string, className: string): React.ReactElement {
  const Resolved: LucideIcon = ICON_MAP[name] ?? Terminal;
  return <Resolved size={16} className={className} />;
}

// === v0.8.7: card variant model ===

/** Discriminated render mode for each catalog entry. Computed top-to-bottom:
 *  installed > browse-only > installable > coming-soon > browse-fallback. */
type CardVariant = "installed" | "browse-only" | "installable" | "coming-soon" | "browse-fallback";

function resolveVariant(
  entry: CliCatalogEntry,
  result: DetectCatalogResult | undefined,
): CardVariant {
  if (result?.installed) return "installed";
  if (entry.browseRequired) return "browse-only";
  if (entry.installCommand || entry.installCommandWindows) return "installable";
  if (entry.comingSoon) return "coming-soon";
  return "browse-fallback";
}

/** OS detector — we lack `@tauri-apps/plugin-os`, so sniff the user agent.
 *  Used only to decide the file-picker extension filter; a wrong answer just
 *  means a less-helpful filter (Unix execs are extensionless either way). */
function isWindowsHost(): boolean {
  if (typeof navigator === "undefined") return false;
  const ua = navigator.userAgent || navigator.platform || "";
  return /windows/i.test(ua) || /win32|win64/i.test(ua);
}

function oneShotInstallInput(command: string, windows: boolean): string {
  return windows
    ? `${command} & exit /b`
    : `${command}; packetbench_install_status=$?; exit $packetbench_install_status`;
}

function basename(p: string): string {
  if (!p) return p;
  const idx = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
  return idx >= 0 ? p.slice(idx + 1) : p;
}

// === Custom CLI drawer state (preserved from previous implementation) ===

interface DraftState {
  id: string | null;
  name: string;
  command: string;
  defaultArgsText: string;
  description: string;
  isBuiltin: boolean;
}

function agentToDraft(agent: AgentConfig): DraftState {
  return {
    id: agent.id,
    name: agent.name,
    command: agent.command,
    defaultArgsText: agent.defaultArgs.join("\n"),
    description: agent.description,
    isBuiltin: agent.isBuiltin,
  };
}

function parseArgs(value: string): string[] {
  return value
    .split("\n")
    .map((arg) => arg.trim())
    .filter(Boolean);
}

function commandSummary(agent: AgentConfig): string {
  return [agent.command, ...agent.defaultArgs].filter(Boolean).join(" ");
}

// === Per-card grid component ===
//
// Exported for the F27 regression test only; the card grid below is its sole
// production consumer.

interface CliCatalogCardProps {
  entry: CliCatalogEntry;
  result: DetectCatalogResult | undefined;
  selected: boolean;
  detecting: boolean;
  installing: boolean;
  manualPath: string | null;
  onSelect: (id: string) => void;
  onInstall: (entry: CliCatalogEntry) => void;
  onBrowse: (entry: CliCatalogEntry) => void;
  onClearOverride: (entry: CliCatalogEntry) => void;
}

export function CliCatalogCard({
  entry,
  result,
  selected,
  detecting,
  installing,
  manualPath,
  onSelect,
  onInstall,
  onBrowse,
  onClearOverride,
}: CliCatalogCardProps) {
  const variant = resolveVariant(entry, result);
  const installed = variant === "installed";
  const brand = brandClasses(entry.color);

  // Selected = filled accent-amber highlight; installed = green; otherwise
  // faint gray. Browse-only and Installable both stay "not installed" until
  // the user actually points us at a binary that responds.
  const outerClass = selected
    ? "border-accent-amber/40 bg-accent-amber/5"
    : installed
      ? "border-bg-border bg-bg-secondary hover:bg-bg-elevated"
      : variant === "coming-soon"
        ? "border-bg-border bg-bg-secondary opacity-80"
        : "border-bg-border bg-bg-secondary opacity-90 hover:bg-bg-elevated";

  const dotClass = !installed
    ? variant === "coming-soon"
      ? "bg-accent-amber/60"
      : "bg-text-faint"
    : selected
      ? "bg-accent-amber"
      : "bg-accent-green";

  let versionText: React.ReactNode;
  if (detecting && !result) {
    versionText = <span className="text-text-faint">checking…</span>;
  } else if (installed) {
    versionText = result?.version ? (
      <span className="font-mono">{result.version}</span>
    ) : (
      <span className="text-text-muted">installed</span>
    );
  } else if ((result?.source === "settings" || result?.source === "legacyPin") && result?.path) {
    // A pinned path the resolver would not use. `detect_one` short-circuits
    // here ON PURPOSE (`commands/agent.rs:190`) — it reports the bad pin back
    // verbatim rather than quietly resolving whatever PATH would have given,
    // so a stale setting cannot hide behind a working fallback.
    //
    // That behaviour is right; the word for it was not. This state used to
    // render as "not installed", which conflates "this CLI is nowhere on the
    // machine" with "this CLI is fine, your pin is stale" — the second is what
    // the user actually has, and reading the first sends them off installing
    // something they already have (audit F27b).
    //
    // Deliberately "not usable" rather than "not found": the DTO cannot
    // distinguish a missing file from one that exists but did not answer
    // `--version`, since both arrive as `installed: false` with no version.
    // Naming only the first would be wrong half the time.
    versionText = <span className="italic text-accent-amber">pinned path not usable</span>;
  } else if (variant === "browse-only") {
    versionText = (
      <span className="italic text-text-muted">Locate the executable to use it here.</span>
    );
  } else if (variant === "installable") {
    versionText = <span className="italic">not installed</span>;
  } else if (variant === "coming-soon") {
    versionText = (
      <span className="italic text-text-muted">Coming soon — track on the roadmap.</span>
    );
  } else {
    versionText = <span className="italic">not installed</span>;
  }

  // Buttons under the card body. `stopPropagation` so the surrounding card
  // click (which toggles selection) doesn't also fire when the user is
  // interacting with the install/browse affordances.
  function stop<E extends React.SyntheticEvent>(e: E) {
    e.stopPropagation();
  }

  return (
    <div
      id={`cli-catalog-${entry.id}`}
      role="button"
      tabIndex={0}
      onClick={() => onSelect(entry.id)}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onSelect(entry.id);
        }
      }}
      aria-pressed={selected}
      className={`relative flex cursor-pointer flex-col gap-2 rounded border p-3 text-left transition-colors ${outerClass}`}
    >
      {/* Status dot */}
      <span
        aria-hidden="true"
        className={`absolute right-2 top-2 h-1.5 w-1.5 rounded-full ${dotClass}`}
      />

      <div className="flex items-start gap-3">
        {/* Icon block */}
        <div
          className={`flex h-8 w-8 flex-shrink-0 items-center justify-center rounded ${
            installed ? brand.iconBg : "bg-bg-elevated"
          }`}
        >
          {installed ? (
            renderCatalogIcon(entry.iconName, brand.iconColor)
          ) : variant === "coming-soon" ? (
            <Clock size={14} className="text-accent-amber/80" />
          ) : (
            <span className="h-2 w-2 rounded-full bg-text-faint" />
          )}
        </div>

        {/* Name + version/state line */}
        <div className="min-w-0 flex-1 pr-4">
          <div className="flex flex-wrap items-center gap-1.5">
            <span
              className={`truncate text-xs font-medium ${
                installed ? "text-text-primary" : "text-text-secondary"
              }`}
            >
              {entry.name}
            </span>
            {variant === "coming-soon" && (
              <span className="rounded bg-accent-amber/15 px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-wide text-accent-amber">
                Coming Soon
              </span>
            )}
          </div>
          <div className="mt-0.5 truncate text-[10px] text-text-muted">{versionText}</div>
        </div>
      </div>

      {/* Launch identity. The resolver that produced this is the SAME one the
          PTY spawns through, so this line is a promise, not a guess — and the
          tier answers "why THIS binary?", which used to be unanswerable for
          every CLI except PacketCode. */}
      {result?.path && (
        <div className="flex flex-col gap-0.5 text-[10px] leading-tight">
          <span className="truncate font-mono text-text-faint" title={result.path}>
            {result.path}
          </span>
          <span
            className={
              result.source === "settings" || result.source === "legacyPin"
                ? "text-accent-amber"
                : "text-text-muted"
            }
          >
            via {cliLaunchSourceLabel(result.source)}
          </span>
        </div>
      )}

      {/* Manual-path override tag — visible whenever the user has pinned a
          path. The X clears the override and re-runs detection so the card
          flips back to PATH-based resolution.

          The `installed` half of this guard was removed (audit F27): a pin at a
          path that no longer exists is exactly what makes a CLI read as not
          installed, so gating the clear control on `installed` hid it precisely
          when it was the only thing that would help. The pin was then
          unclearable from the card that displayed it — Browse… could replace it
          but nothing could remove it. A control that undoes a setting must not
          depend on that setting being healthy. */}
      {manualPath && (
        <div className="flex items-center gap-1 text-[10px] text-text-faint" onClick={stop}>
          <span
            className="max-w-[180px] truncate rounded bg-bg-elevated px-1.5 py-0.5 text-text-muted"
            title={manualPath}
          >
            Override: {basename(manualPath)}
          </span>
          <button
            type="button"
            onClick={(e) => {
              stop(e);
              onClearOverride(entry);
            }}
            className="rounded p-0.5 transition-colors hover:bg-bg-hover hover:text-text-secondary"
            title="Clear manual path override"
          >
            <X size={10} />
          </button>
        </div>
      )}

      {/* State-specific actions row. Rendered only for non-installed
          variants — the installed card relies on its version line and the
          shared Test button in the header. */}
      {!installed && (
        <div className="flex flex-wrap items-center gap-1.5" onClick={stop} onKeyDown={stop}>
          {variant === "browse-only" && (
            <button
              type="button"
              onClick={() => onBrowse(entry)}
              className="flex items-center gap-1 rounded border border-accent-blue/40 px-2 py-1 text-[10px] text-accent-blue transition-colors hover:bg-accent-blue/10"
            >
              <FolderOpen size={10} />
              Browse for binary
            </button>
          )}

          {variant === "installable" && (
            <>
              <button
                type="button"
                onClick={() => onInstall(entry)}
                disabled={installing}
                className="flex items-center gap-1 rounded border border-accent-green/40 px-2 py-1 text-[10px] text-accent-green transition-colors hover:bg-accent-green/10 disabled:cursor-not-allowed disabled:opacity-50"
                title={entry.installCommand}
              >
                {installing ? (
                  <Loader2 size={10} className="animate-spin" />
                ) : (
                  <Download size={10} />
                )}
                Install
              </button>
              <button
                type="button"
                onClick={() => onBrowse(entry)}
                className="text-[10px] text-text-muted underline underline-offset-2 transition-colors hover:text-accent-blue"
              >
                Browse…
              </button>
              {entry.installDocsUrl && (
                <a
                  href={entry.installDocsUrl}
                  target="_blank"
                  rel="noreferrer"
                  onClick={stop}
                  className="flex items-center gap-0.5 text-[10px] text-text-faint hover:text-text-muted"
                  title="Install docs"
                >
                  <ExternalLink size={9} />
                </a>
              )}
            </>
          )}

          {variant === "coming-soon" && entry.installDocsUrl && (
            <a
              href={entry.installDocsUrl}
              target="_blank"
              rel="noreferrer"
              onClick={stop}
              className="flex items-center gap-1 text-[10px] text-text-faint underline underline-offset-2 hover:text-accent-amber"
            >
              <ExternalLink size={9} />
              Roadmap
            </a>
          )}

          {variant === "browse-fallback" && (
            <button
              type="button"
              onClick={() => onBrowse(entry)}
              className="flex items-center gap-1 rounded border border-bg-border px-2 py-1 text-[10px] text-text-secondary transition-colors hover:bg-bg-hover"
            >
              <FolderOpen size={10} />
              Browse for binary
            </button>
          )}
        </div>
      )}

      {/* Installing feedback strip — present while we're spawning the
          install workspace. Clears when the install pane gets a sessionId. */}
      {installing && (
        <div className="flex items-center gap-1 border-t border-accent-green/20 pt-1.5 text-[10px] text-accent-green">
          <Loader2 size={10} className="animate-spin" />
          <span>Installing in workspace →</span>
        </div>
      )}
    </div>
  );
}

// === Main card ===

interface CliAgentsCardProps {
  focusedCliId?: string | null;
}

export function CliAgentsCard({ focusedCliId = null }: CliAgentsCardProps) {
  const agents = useAgentStore((s) => s.agents);
  const storeDetecting = useAgentStore((s) => s.detecting);
  const updateAgent = useAgentStore((s) => s.updateAgent);
  const removeAgent = useAgentStore((s) => s.removeAgent);
  const detectInstalled = useAgentStore((s) => s.detectInstalled);
  const resetBuiltins = useAgentStore((s) => s.resetBuiltins);

  // v0.8.7: manual-path overrides + workspace spawning for installs.
  const overrides = useCliOverrideStore((s) => s.overrides);
  const setManualPath = useCliOverrideStore((s) => s.setManualPath);
  const clearManualPath = useCliOverrideStore((s) => s.clearManualPath);
  const packetCodeReleaseChannel = usePacketCodeIntegrationStore((s) => s.releaseChannel);

  const [results, setResults] = useState<Record<string, DetectCatalogResult>>({});
  const [scanning, setScanning] = useState(false);
  const [selectedCliId, setSelectedCliId] = useState<string | null>(null);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [draft, setDraft] = useState<DraftState | null>(null);
  const [pendingRemove, setPendingRemove] = useState<AgentConfig | null>(null);
  const [pendingResetBuiltins, setPendingResetBuiltins] = useState(false);
  // v0.8.8+ peer-review fix: a Set keyed by entry id, not a single string.
  // Two installs clicked in quick succession used to overwrite each other —
  // the second `setInstallingId` would clear the first install's spinner
  // even though the first install was still running (and the 30s safety net
  // would later flap the second install's spinner too).
  const [installingIds, setInstallingIds] = useState<Set<string>>(() => new Set());
  /** Active install modal — drives the `TransientPtyModal` overlay. */
  const [installTarget, setInstallTarget] = useState<{
    entryId: string;
    name: string;
    command: string;
    projectPath: string | undefined;
    packetCodeChannel?: "stable" | "preview";
  } | null>(null);
  const [packetCodeInspection, setPacketCodeInspection] =
    useState<PacketCodeInstallationInspection | null>(null);
  const [packetCodeInstallReport, setPacketCodeInstallReport] =
    useState<PacketCodeInstallReport | null>(null);

  useEffect(() => {
    if (!focusedCliId || !CLI_CATALOG.some((entry) => entry.id === focusedCliId)) {
      return;
    }
    setSelectedCliId(focusedCliId);
    const frame = requestAnimationFrame(() => {
      document
        .getElementById(`cli-catalog-${focusedCliId}`)
        ?.scrollIntoView({ block: "center", behavior: "smooth" });
    });
    return () => cancelAnimationFrame(frame);
  }, [focusedCliId]);

  const customAgents = useMemo(() => agents.filter((a) => !a.isBuiltin), [agents]);

  /** Build the detector payload from the catalog, layering in any saved
   *  manual-path overrides so the backend resolves to the pinned binary
   *  instead of (or in preference to) PATH. */
  const buildDetectItems = useCallback(() => {
    return getCliBinaries().map((item) => {
      const manualPath = overrides[item.id]?.manualPath;
      return manualPath ? { ...item, manualPath } : item;
    });
  }, [overrides]);

  /** Reflect a single catalog detection result back into `agentStore` so the
   *  Workspace Add Session picker (which reads `agents[].installed`) and PTY
   *  launches (which read `agents[].command`) both see the manual-path
   *  override. Without this, Browse-pinning a binary updates only the
   *  override store and the local results map, leaving the menu disabled
   *  and any forced launch attempting to spawn the bare binary name on
   *  PATH. No-op for catalog ids that don't correspond to a built-in agent
   *  slot (e.g. `devin`, `copilot`). */
  const syncAgentFromResult = useCallback(
    (
      entry: CliCatalogEntry,
      result: DetectCatalogResult | undefined,
      manualPath: string | null,
    ) => {
      const store = useAgentStore.getState();
      if (!store.getAgent(entry.id)) return;
      const command =
        manualPath ||
        (entry.id === "packetcode" && result?.installed && result.path
          ? result.path
          : entry.binary);
      store.updateAgent(entry.id, {
        command,
        installed: !!result?.installed,
      });
    },
    [],
  );

  // Bulk-scan the catalog via detectCliCatalog (the legacy detectAgent
  // command now routes through the same backend, so a separate fallback
  // path would just duplicate work). On error, log + leave results so
  // the cards render as "not installed" rather than silently lying.
  const rescan = useCallback(async () => {
    setScanning(true);
    try {
      const items = buildDetectItems();
      const out = await detectCliCatalog(items);
      const merged: Record<string, DetectCatalogResult> = {};
      for (const r of out) merged[r.id] = r;
      setResults(merged);
      // Sync override-aware results back into agentStore so the
      // Workspace Add Session picker and PTY launch path both see the
      // pinned binary. Done per-entry so the agentStore's `command` is
      // updated to the override path when one is set.
      for (const item of items) {
        const entry = CLI_CATALOG.find((e) => e.id === item.id);
        if (!entry) continue;
        const manualPath = overrides[item.id]?.manualPath ?? null;
        syncAgentFromResult(entry, merged[item.id], manualPath);
      }
    } catch (err) {
      console.warn("[cli-catalog] detection failed:", err);
    } finally {
      setScanning(false);
    }
  }, [buildDetectItems, overrides, syncAgentFromResult]);

  // Mount: rescan once if results are empty.
  useEffect(() => {
    if (Object.keys(results).length === 0) {
      void rescan();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const installedCount = useMemo(
    () => CLI_CATALOG.filter((e) => results[e.id]?.installed).length,
    [results],
  );

  const selectedEntry = useMemo(
    () => (selectedCliId ? CLI_CATALOG.find((e) => e.id === selectedCliId) : null) ?? null,
    [selectedCliId],
  );
  const detecting = scanning || storeDetecting;

  function toggleSelect(id: string) {
    setSelectedCliId((prev) => (prev === id ? null : id));
  }

  async function handleTest(): Promise<{ ok: boolean; output: string }> {
    if (!selectedEntry) {
      return { ok: false, output: "No CLI selected." };
    }
    try {
      // Re-probe the selected binary specifically so the user gets fresh
      // installed/version data for the one they care about. Reuses the same
      // detect_cli_catalog command the grid uses for the full sweep — and
      // critically threads any pinned manualPath through, so testing an
      // override-pinned CLI doesn't fall back to PATH.
      const manualPath = overrides[selectedEntry.id]?.manualPath;
      const item = manualPath
        ? { id: selectedEntry.id, binary: selectedEntry.binary, manualPath }
        : { id: selectedEntry.id, binary: selectedEntry.binary };
      const [result] = await detectCliCatalog([item]);
      if (!result) {
        return { ok: false, output: "Detection returned no result." };
      }
      // Update the local results map so the card refreshes immediately.
      setResults((prev) => ({ ...prev, [selectedEntry.id]: result }));
      // Propagate into agentStore so the Workspace "Add Session" picker
      // (which gates its button on `agents[].installed`) and PTY launches
      // see this result. Without this, a green Test check never enables the
      // Add Session button. No-op for catalog ids without a built-in slot.
      syncAgentFromResult(selectedEntry, result, manualPath ?? null);
      if (!result.installed) {
        return {
          ok: false,
          output: result.path
            ? `${selectedEntry.binary} resolved to ${result.path} via ${cliLaunchSourceLabel(result.source)}, but it did not respond.`
            : `${selectedEntry.binary} was not found in any launch tier (Settings override, legacy pin, PATH, install directory).`,
        };
      }
      const versionLine = result.version
        ? `${selectedEntry.binary} ${result.version}`
        : `${selectedEntry.binary} responds (no version string)`;
      // Name the tier: this is the binary a Workspace pane will spawn, and the
      // tier is the only thing that explains why it and not another copy.
      const pathLine = result.path
        ? `\n${result.path}\nvia ${cliLaunchSourceLabel(result.source)}`
        : "";
      return { ok: true, output: `${versionLine}${pathLine}` };
    } catch (err) {
      return {
        ok: false,
        output: err instanceof Error ? err.message : String(err),
      };
    }
  }

  /** Build the redacted launch-resolution report for a bug report. The Rust
   *  side does the work so the text is produced by the same resolver the panes
   *  use, and so the home directory can be abbreviated to `~`. */
  const handleCopyDiagnostics = useCallback(
    () => cliLaunchDiagnostics(buildDetectItems()),
    [buildDetectItems],
  );

  // === v0.8.7 actions ===

  /** Re-probe a single catalog entry and merge the result into local state.
   *  Used after Browse-for-binary picks a path, and after Reset-override
   *  clears one. Also syncs `agentStore` so the Workspace Add Session
   *  menu enables the freshly-pinned binary and PTY launches use the
   *  override path. Keeps the card snappy without forcing a full grid
   *  rescan. */
  const redetectOne = useCallback(
    async (entry: CliCatalogEntry, manualPath: string | null) => {
      try {
        const item = manualPath
          ? { id: entry.id, binary: entry.binary, manualPath }
          : { id: entry.id, binary: entry.binary };
        const [result] = await detectCliCatalog([item]);
        if (result) {
          setResults((prev) => ({ ...prev, [entry.id]: result }));
        }
        syncAgentFromResult(entry, result, manualPath);
        return result ?? null;
      } catch (err) {
        console.warn("[cli-catalog] single-entry detect failed:", err);
        return null;
      }
    },
    [syncAgentFromResult],
  );

  const refreshPacketCodeInspection = useCallback(async (manualPath: string | null) => {
    try {
      const inspection = await inspectPacketCodeInstallation(manualPath);
      setPacketCodeInspection(inspection);
      return inspection;
    } catch (error) {
      console.warn("[packetcode] installation inspection failed:", error);
      return null;
    }
  }, []);

  useEffect(() => {
    if (selectedEntry?.id !== "packetcode") return;
    void refreshPacketCodeInspection(overrides.packetcode?.manualPath ?? null);
  }, [overrides.packetcode?.manualPath, refreshPacketCodeInspection, selectedEntry?.id]);

  /** Open a file picker scoped to the host OS so the user can pin a binary
   *  on disk. On selection, persist the override + immediately re-probe the
   *  entry so the card flips to "installed" if the binary responds. */
  const handleBrowse = useCallback(
    async (entry: CliCatalogEntry) => {
      try {
        const win = isWindowsHost();
        const selected = await openDialog({
          multiple: false,
          directory: false,
          title: `Locate ${entry.name} binary`,
          filters: win ? [{ name: "Executable", extensions: ["exe"] }] : undefined,
        });
        if (!selected || typeof selected !== "string") {
          // Cancelled, or returned an array (we passed multiple: false so
          // we treat any non-string as a no-op).
          return;
        }
        setManualPath(entry.id, selected);
        await redetectOne(entry, selected);
      } catch (err) {
        console.warn("[cli-catalog] browse failed:", err);
      }
    },
    [setManualPath, redetectOne],
  );

  /** Clear a manual-path override and re-detect via PATH. */
  const handleClearOverride = useCallback(
    async (entry: CliCatalogEntry) => {
      clearManualPath(entry.id);
      await redetectOne(entry, null);
    },
    [clearManualPath, redetectOne],
  );

  /** Run the entry's `installCommand` inside a floating PTY modal.
   *
   *  Previously this spawned a one-pane workspace and typed the install
   *  command into it. Migrated to `useTransientPty` (via TransientPtyModal)
   *  so the install no longer leaves a persistent workspace behind — when
   *  the install process exits, the modal stays open with the final output
   *  for the user to review, then auto-cleans the PTY on close. */
  const handleInstall = useCallback(
    async (entry: CliCatalogEntry) => {
      const cmd =
        entry.id === "packetcode"
          ? packetCodeInstallCommand(packetCodeReleaseChannel, isWindowsHost())
          : isWindowsHost()
            ? (entry.installCommandWindows ?? entry.installCommand)?.trim()
            : entry.installCommand?.trim();
      if (!cmd) return;

      const projectPath = useLayoutStore.getState().projectPath || undefined;
      setInstallingIds((cur) => {
        const next = new Set(cur);
        next.add(entry.id);
        return next;
      });
      const packetCodeChannel = entry.id === "packetcode" ? packetCodeReleaseChannel : undefined;
      if (packetCodeChannel) {
        const before = await refreshPacketCodeInspection(overrides.packetcode?.manualPath ?? null);
        setPacketCodeInstallReport({
          status: "running",
          channel: packetCodeChannel,
          before,
          after: null,
        });
      }
      setInstallTarget({
        entryId: entry.id,
        name: entry.name,
        command: cmd,
        projectPath,
        packetCodeChannel,
      });
    },
    [overrides.packetcode?.manualPath, packetCodeReleaseChannel, refreshPacketCodeInspection],
  );

  /**
   * Score an installer run from its REAL exit outcome.
   *
   * The distinction that matters here is `unknown` vs `clean`. The transient
   * runner reports `unknown` when it never observed an exit status at all —
   * previously that was laundered into success, so an installer that died
   * could still report "install verified". Now an unobserved exit is not
   * trusted on its own: the binary probe below is the sole authority, and if
   * it cannot confirm a version the run is reported as failed, naming the
   * fact that the exit was never observed.
   */
  const handleInstallExit = useCallback(
    (outcome: PtyExitOutcome) => {
      const current = installTarget;
      if (!current?.packetCodeChannel) return;
      if (outcome.kind === "failed" || outcome.kind === "killed") {
        setPacketCodeInstallReport((report) =>
          report
            ? {
                ...report,
                status: "error",
                message:
                  outcome.kind === "killed"
                    ? "Installation was cancelled before it finished."
                    : `Installer exited with code ${outcome.exitCode}.`,
              }
            : report,
        );
        return;
      }

      setPacketCodeInstallReport((report) =>
        report ? { ...report, status: "verifying" } : report,
      );
      void (async () => {
        const manualPath = useCliOverrideStore.getState().overrides.packetcode?.manualPath ?? null;
        const entry = CLI_CATALOG.find((candidate) => candidate.id === "packetcode");
        if (entry) await redetectOne(entry, manualPath);
        const after = await refreshPacketCodeInspection(manualPath);
        const verified = !!after?.installerVersion;
        setPacketCodeInstallReport((report) =>
          report
            ? {
                ...report,
                status: verified ? "success" : "error",
                after,
                message: verified
                  ? undefined
                  : outcome.kind === "unknown"
                    ? "The installer's exit status was never observed and the installed binary failed verification."
                    : "Installer exited successfully, but the installed binary failed verification.",
              }
            : report,
        );
      })();
    },
    [installTarget, redetectOne, refreshPacketCodeInspection],
  );

  const pinExecutable = useCallback(
    async (path: string) => {
      const entry = CLI_CATALOG.find((candidate) => candidate.id === "packetcode");
      if (!entry) return;
      setManualPath(entry.id, path);
      await redetectOne(entry, path);
      const inspection = await refreshPacketCodeInspection(path);
      setPacketCodeInstallReport((report) =>
        report && inspection ? { ...report, after: inspection } : report,
      );
    },
    [redetectOne, refreshPacketCodeInspection, setManualPath],
  );

  const clearInstallTarget = useCallback(() => {
    const current = installTarget;
    if (current) {
      if (current.entryId === "packetcode") {
        setPacketCodeInstallReport((report) =>
          report?.status === "running"
            ? { ...report, status: "error", message: "Installation was cancelled." }
            : report,
        );
      }
      setInstallingIds((cur) => {
        if (!cur.has(current.entryId)) return cur;
        const next = new Set(cur);
        next.delete(current.entryId);
        return next;
      });
      const entry = CLI_CATALOG.find((candidate) => candidate.id === current.entryId);
      if (entry) {
        void redetectOne(entry, overrides[entry.id]?.manualPath ?? null);
      }
    }
    setInstallTarget(null);
  }, [installTarget, overrides, redetectOne]);

  // === Custom CLI drawer handlers (preserved) ===

  function startEdit(agent: AgentConfig) {
    setDraft(agentToDraft(agent));
    setAdvancedOpen(true);
  }
  function cancel() {
    setDraft(null);
  }
  function save() {
    if (!draft) return;
    const command = draft.command.trim();
    const name = draft.name.trim();
    if (!command || (!draft.isBuiltin && !name)) return;
    const defaultArgs = parseArgs(draft.defaultArgsText);
    if (draft.id) {
      updateAgent(draft.id, {
        command,
        defaultArgs,
        ...(!draft.isBuiltin ? { name, description: draft.description.trim() } : {}),
      });
    }
    setDraft(null);
  }
  function requestRemove(agent: AgentConfig) {
    if (agent.isBuiltin) return;
    setPendingRemove(agent);
  }
  function performRemove(agent: AgentConfig) {
    removeAgent(agent.id);
    if (draft?.id === agent.id) setDraft(null);
    setPendingRemove(null);
  }
  function performResetBuiltins() {
    resetBuiltins();
    void detectInstalled();
    if (draft?.isBuiltin) setDraft(null);
    setPendingResetBuiltins(false);
  }

  return (
    <div className="rounded-lg border border-bg-border bg-bg-secondary p-4">
      <CliCatalogHeader
        installedCount={installedCount}
        selectedEntry={
          selectedEntry
            ? {
                id: selectedEntry.id,
                name: selectedEntry.name,
                binary: selectedEntry.binary,
              }
            : null
        }
        isRescanning={detecting}
        onRescan={rescan}
        onTest={handleTest}
        onCopyDiagnostics={handleCopyDiagnostics}
      />

      {/* 2-column responsive grid */}
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        {CLI_CATALOG.map((entry) => (
          <CliCatalogCard
            key={entry.id}
            entry={entry}
            result={results[entry.id]}
            selected={selectedCliId === entry.id}
            detecting={detecting}
            installing={installingIds.has(entry.id)}
            manualPath={overrides[entry.id]?.manualPath ?? null}
            onSelect={toggleSelect}
            onInstall={handleInstall}
            onBrowse={handleBrowse}
            onClearOverride={handleClearOverride}
          />
        ))}
      </div>

      {selectedEntry?.id === "packetcode" && (
        <PacketCodeIntegrationPanel
          detection={results.packetcode}
          manualPath={overrides.packetcode?.manualPath ?? null}
          installing={installingIds.has("packetcode")}
          inspection={packetCodeInspection}
          installReport={packetCodeInstallReport}
          onPinExecutable={pinExecutable}
          onInstall={() => void handleInstall(selectedEntry)}
        />
      )}

      {/* Advanced: custom CLI management + reset built-ins */}
      <div className="mt-4 border-t border-bg-border pt-3">
        <button
          type="button"
          onClick={() => setAdvancedOpen((v) => !v)}
          className="flex items-center gap-1.5 text-[10px] text-text-muted transition-colors hover:text-text-primary"
        >
          {advancedOpen ? <ChevronDown size={10} /> : <ChevronRight size={10} />}
          Advanced — saved CLI settings
          {customAgents.length > 0 && (
            <span className="text-[10px] text-text-faint">({customAgents.length})</span>
          )}
        </button>

        {advancedOpen && (
          <div className="mt-3">
            <div className="mb-2 flex items-center justify-end gap-1">
              <button
                type="button"
                onClick={() => setPendingResetBuiltins(true)}
                className="flex items-center gap-1 rounded px-2 py-1 text-[10px] text-text-muted transition-colors hover:bg-bg-hover hover:text-text-primary"
                title="Reset built-in command overrides"
              >
                <RotateCcw size={10} />
                Reset built-ins
              </button>
            </div>

            <p className="mb-2 text-[10px] text-text-muted">
              Custom CLI launching is not supported. Previously saved entries are retained below for
              reference and removal.
            </p>
            {customAgents.length === 0 && !draft ? (
              <p className="text-[10px] italic text-text-faint">No saved custom CLI entries.</p>
            ) : (
              <div className="flex flex-col gap-2">
                {customAgents.map((agent) => (
                  <div
                    key={agent.id}
                    className="flex items-start gap-2.5 rounded-md border border-bg-border bg-bg-primary p-2.5"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-[11.5px] font-semibold text-text-primary">
                          {agent.name}
                        </span>
                        <span className="rounded bg-bg-elevated px-1 py-px text-[9px] text-text-muted">
                          custom
                        </span>
                        {detecting ? (
                          <span className="inline-flex items-center gap-1 text-[9px] text-text-muted">
                            <RefreshCw size={9} className="animate-spin" />
                            checking
                          </span>
                        ) : agent.installed ? (
                          <span className="inline-flex items-center gap-1 text-[9px] text-accent-green">
                            <Check size={9} />
                            installed
                          </span>
                        ) : (
                          <span className="inline-flex items-center gap-1 text-[9px] text-accent-amber">
                            <AlertCircle size={9} />
                            not found
                          </span>
                        )}
                      </div>
                      <div className="mt-0.5 line-clamp-1 text-[10px] text-text-muted">
                        {agent.description || "No description"}
                      </div>
                      <div
                        className="mt-1 truncate font-mono text-[10px] text-text-faint"
                        title={commandSummary(agent) || "No command"}
                      >
                        {commandSummary(agent) || "No command"}
                      </div>
                    </div>
                    <div className="flex flex-shrink-0 items-center gap-0.5">
                      <button
                        type="button"
                        onClick={() => startEdit(agent)}
                        className="rounded p-1 text-text-faint hover:text-accent-blue"
                        title="Edit command and args"
                      >
                        <Pencil size={11} />
                      </button>
                      <button
                        type="button"
                        onClick={() => requestRemove(agent)}
                        className="rounded p-1 text-text-faint hover:text-accent-red"
                        title={`Delete custom CLI agent “${agent.name}”`}
                        aria-label={`Delete custom CLI agent ${agent.name}`}
                      >
                        <Trash2 size={11} />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}

            {draft && (
              <div className="mt-3 rounded-md border border-accent-blue/40 bg-bg-primary p-3">
                <div className="mb-2 flex items-center justify-between">
                  <span className="text-[11px] font-semibold text-text-primary">
                    {draft.id ? `Edit ${draft.name}` : "New custom CLI agent"}
                  </span>
                  <div className="flex items-center gap-1">
                    <button
                      type="button"
                      onClick={save}
                      disabled={!draft.command.trim() || (!draft.isBuiltin && !draft.name.trim())}
                      className="flex items-center gap-1 rounded border border-accent-green/40 px-2 py-1 text-[11px] text-accent-green hover:bg-accent-green/10 disabled:opacity-40"
                    >
                      <Check size={11} />
                      Save
                    </button>
                    <button
                      type="button"
                      onClick={cancel}
                      className="flex items-center gap-1 rounded border border-bg-border px-2 py-1 text-[11px] text-text-secondary hover:bg-bg-hover"
                    >
                      <X size={11} />
                      Cancel
                    </button>
                  </div>
                </div>

                <div className="mb-2 grid grid-cols-2 gap-2">
                  <label className="flex flex-col gap-1">
                    <span className="text-[10px] text-text-muted">Name</span>
                    <input
                      type="text"
                      value={draft.name}
                      disabled={draft.isBuiltin}
                      onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                      placeholder="My CLI agent"
                      className="rounded border border-bg-border bg-bg-secondary px-2 py-1 text-[11px] text-text-primary focus:border-accent-blue/60 focus:outline-none disabled:text-text-muted disabled:opacity-70"
                    />
                  </label>
                  <label className="flex flex-col gap-1">
                    <span className="text-[10px] text-text-muted">Command</span>
                    <input
                      type="text"
                      value={draft.command}
                      onChange={(e) => setDraft({ ...draft, command: e.target.value })}
                      placeholder="claude, codex, C:\\tools\\agent.cmd"
                      className="rounded border border-bg-border bg-bg-secondary px-2 py-1 font-mono text-[11px] text-text-primary focus:border-accent-blue/60 focus:outline-none"
                    />
                  </label>
                </div>

                {!draft.isBuiltin && (
                  <label className="mb-2 flex flex-col gap-1">
                    <span className="text-[10px] text-text-muted">Description</span>
                    <input
                      type="text"
                      value={draft.description}
                      onChange={(e) => setDraft({ ...draft, description: e.target.value })}
                      placeholder="What this CLI is used for"
                      className="rounded border border-bg-border bg-bg-secondary px-2 py-1 text-[11px] text-text-primary focus:border-accent-blue/60 focus:outline-none"
                    />
                  </label>
                )}

                <label className="flex flex-col gap-1">
                  <span className="text-[10px] text-text-muted">Default args, one per line</span>
                  <textarea
                    value={draft.defaultArgsText}
                    onChange={(e) => setDraft({ ...draft, defaultArgsText: e.target.value })}
                    rows={4}
                    placeholder={"--model\nsonnet"}
                    className="resize-y rounded border border-bg-border bg-bg-secondary px-2 py-1 font-mono text-[11px] text-text-primary focus:border-accent-blue/60 focus:outline-none"
                  />
                  <span className="text-[9.5px] text-text-faint">
                    Args are passed before the task prompt. Use a wrapper script for complex shell
                    quoting.
                  </span>
                </label>
              </div>
            )}
          </div>
        )}
      </div>
      {installTarget && (
        <TransientPtyModal
          title={`Install ${installTarget.name}`}
          icon={<Download size={14} className="text-accent-green" />}
          // Run inside a shell so pipelines like `curl … | bash` work. The
          // install command is fed in as initialInput so users can see the
          // line that's about to run before output streams in.
          command={isWindowsHost() ? "cmd" : "bash"}
          projectPath={installTarget.projectPath}
          initialInput={oneShotInstallInput(installTarget.command, isWindowsHost())}
          interactive
          onClose={clearInstallTarget}
          onExit={handleInstallExit}
          runningMessage={`Installing ${installTarget.name}…`}
          doneMessage="Installer exited successfully — close to view the verified result."
          errorMessage="Install ended with an error."
        />
      )}

      {pendingRemove && (
        <ConfirmDeleteModal
          title="Delete CLI agent?"
          entityName={pendingRemove.name}
          description="is removed from the session launcher. The CLI itself stays installed on this machine."
          onConfirm={() => performRemove(pendingRemove)}
          onClose={() => setPendingRemove(null)}
        />
      )}

      {pendingResetBuiltins && (
        <ConfirmDeleteModal
          title="Reset built-in CLI agents?"
          description="Built-in CLI agents go back to their default commands and args. Custom CLI agents are kept."
          confirmLabel="Reset to defaults"
          undoNote="Your edits to built-in commands, args, and manual paths are lost."
          onConfirm={performResetBuiltins}
          onClose={() => setPendingResetBuiltins(false)}
        />
      )}
    </div>
  );
}
