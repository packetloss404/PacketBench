import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  AlertTriangle,
  Loader2,
  Plus,
  Play,
  X,
  MoreVertical,
} from "lucide-react";
import { TileChrome } from "./TileChrome";
import { TerminalPane, type TerminalHeaderRenderState } from "@/components/session/TerminalPane";
import { useAgentStore } from "@/stores/agentStore";
import { useWorkspaceStore } from "@/stores/workspaceStore";
import { useLayoutStore } from "@/stores/layoutStore";
import { useServerStore } from "@/stores/serverStore";
import { usePromptStore } from "@/stores/promptStore";
import { useCliOverrideStore } from "@/stores/cliOverrideStore";
import {
  isAbsolutePacketCodePath,
  usePacketCodeIntegrationStore,
} from "@/stores/packetCodeIntegrationStore";
import { buildSshArgs } from "@/lib/ssh";
import {
  describePtyExitOutcome,
  inspectCliLaunch,
  probePacketCodeIntegration,
  ptyExitPillLabel,
  writePty,
  type CliLaunchInspection,
  type PacketCodeIntegrationProbe,
} from "@/lib/tauri";
import { cliLaunchSourceLabel } from "@/lib/cli-catalog";
import { getModelsForAgent } from "@/lib/models";
import { getAgentColor } from "@/lib/agentColors";
import { accountEnvForSlot } from "@/lib/cliAccountEnv";
import { AccountChip } from "@/components/session/AccountChip";
import { AccountBlockedPane } from "@/components/workspace/AccountBlockedPane";
import { LoginPtyModal } from "@/components/auth/LoginPtyModal";
import { ConfirmDeleteModal } from "@/components/ui/ConfirmDeleteModal";
import { accountLoginCliForSlot, useAccountLaunchGate } from "@/hooks/useAccountLaunchGate";
import type { WorkspacePane as WorkspacePaneType } from "@/types/workspace";
import { useTerminalSettingsStore } from "@/stores/terminalSettingsStore";
import { resolveTerminalShellLaunch } from "@/lib/terminalShells";
import { BYPASS_FLAGS } from "@/lib/bypassFlags";

interface WorkspacePaneProps {
  pane: WorkspacePaneType;
  workspaceId: string;
  /** Gate the pane's one-time automatic PTY launch. */
  autoStart?: boolean;
}

// `identity` is the last successfully resolved launch identity. It survives a
// re-probe on purpose: an already-mounted TerminalPane keeps rendering with it
// while the new inputs resolve, so the pane is only ever unmounted when there
// is genuinely nothing to launch. Unmounting TerminalPane re-arms its
// autoStart on remount, which is why a probe must never bounce a mounted pane.
type PacketCodeRuntimeState =
  | { status: "not-applicable"; identity: null }
  | { status: "probing"; identity: PacketCodeIntegrationProbe | null }
  | { status: "ready"; identity: PacketCodeIntegrationProbe }
  | { status: "error"; identity: null; message: string };

const NOT_APPLICABLE_RUNTIME: PacketCodeRuntimeState = { status: "not-applicable", identity: null };

interface PaneInput {
  label: string;
  content: string;
}

export function WorkspacePane({ pane, workspaceId, autoStart = true }: WorkspacePaneProps) {
  const agents = useAgentStore((s) => s.agents);
  const workspace = useWorkspaceStore((s) => s.workspaces.find((w) => w.id === workspaceId));
  const zoomedPaneId = useWorkspaceStore((s) => s.zoomedPaneId);
  const setZoomedPane = useWorkspaceStore((s) => s.setZoomedPane);
  const activePaneId = useLayoutStore((s) => s.activePaneId);
  const isZoomed = zoomedPaneId === pane.id;
  const isFocused = activePaneId === pane.id;
  // Tile program (P4-S1): transient focus-flash when a focusPaneRequest targets
  // this pane. Purely derived from the auto-clearing store request.
  const isFlashing = useWorkspaceStore(
    (s) =>
      s.focusPaneRequest?.paneId === pane.id && s.focusPaneRequest?.workspaceId === workspaceId,
  );
  const agentConfig = agents.find((a) => a.id === pane.agentId);
  // Single overflow menu replaces the standalone model/prompt/pin popovers —
  // "root" is the menu list, the other views are drilled-into sub-panels.
  const [showOverflow, setShowOverflow] = useState(false);
  const [overflowView, setOverflowView] = useState<"root" | "model" | "prompts" | "pins">("root");
  const [pendingClose, setPendingClose] = useState<{
    onKill: () => void | Promise<void>;
    busy?: boolean;
    error?: string;
  } | null>(null);
  const [newPinCmd, setNewPinCmd] = useState("");
  const [failedInput, setFailedInput] = useState<(PaneInput & { error: string }) | null>(null);
  const [sendingInput, setSendingInput] = useState(false);
  const inputInFlight = useRef(false);
  const overflowRef = useRef<HTMLDivElement>(null);
  const promptTemplates = usePromptStore((s) => s.templates);
  const packetCodeLocalDataHome = usePacketCodeIntegrationStore((s) => s.localDataHome);
  const packetCodeRemoteDataHomes = usePacketCodeIntegrationStore((s) => s.remoteDataHomes);
  const packetCodeManualPath = useCliOverrideStore(
    (s) => s.overrides.packetcode?.manualPath ?? null,
  );
  const defaultTerminalShell = useTerminalSettingsStore((s) => s.defaultShell);
  const [packetCodeProbeNonce, setPacketCodeProbeNonce] = useState(0);
  const [packetCodeRuntime, setPacketCodeRuntime] = useState<PacketCodeRuntimeState>(() =>
    pane.agentId === "packetcode" ? { status: "probing", identity: null } : NOT_APPLICABLE_RUNTIME,
  );
  // Launch identity for the non-PacketCode CLIs. PacketCode has its own,
  // richer runtime block (it also gates launch on a doctor probe); every other
  // CLI simply could not tell you which binary its pane was about to spawn.
  // Resolved through the SAME Rust ladder the PTY uses, so this is a promise
  // rather than a guess — and probed only when the menu is opened, so no pane
  // pays for a readout nobody looked at.
  const [cliLaunch, setCliLaunch] = useState<CliLaunchInspection | null>(null);
  const packetCodeRuntimeRef = useRef(packetCodeRuntime);
  packetCodeRuntimeRef.current = packetCodeRuntime;
  // The inputs the current identity was resolved from. A session ending with
  // these unchanged must not trigger a fresh probe.
  const packetCodeProbedKeyRef = useRef<string | null>(null);

  // Close the overflow menu on outside click; reset to the root view so it
  // doesn't reopen mid-drill-down next time.
  useEffect(() => {
    if (!showOverflow) return;
    const handler = (e: MouseEvent) => {
      if (overflowRef.current && !overflowRef.current.contains(e.target as Node)) {
        setShowOverflow(false);
        setOverflowView("root");
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [showOverflow]);

  const pinnedCommands = useMemo(() => pane.pinnedCommands ?? [], [pane.pinnedCommands]);

  const sendInput = useCallback(
    async (input: PaneInput) => {
      // A second click must not submit twice while the first write is pending.
      if (inputInFlight.current) return;
      inputInFlight.current = true;
      setSendingInput(true);
      setShowOverflow(false);
      setOverflowView("root");
      try {
        if (!pane.sessionId) throw new Error("This pane has no running session.");
        // CR submits consistently through ConPTY as well as Unix PTYs.
        await writePty(pane.sessionId, input.content + "\r");
        setFailedInput(null);
      } catch (reason) {
        // Keep the exact attempted text even if its template is later edited.
        setFailedInput({
          ...input,
          error: reason instanceof Error ? reason.message : String(reason),
        });
      } finally {
        inputInFlight.current = false;
        setSendingInput(false);
      }
    },
    [pane.sessionId],
  );

  const runCommand = useCallback(
    (cmd: string) => void sendInput({ label: "Command", content: cmd }),
    [sendInput],
  );

  // Paste a prompt template's body into this pane's PTY. Mirrors the
  // pre-overhaul Prompt Library "Send to Terminal" affordance, scoped to
  // the specific pane the user clicked on.
  const sendPromptTemplate = useCallback(
    (templateId: string) => {
      const tpl = usePromptStore.getState().templates.find((t) => t.id === templateId);
      if (!tpl) return;
      void sendInput({ label: `Prompt “${tpl.name}”`, content: tpl.content });
    },
    [sendInput],
  );

  const agentName = agentConfig?.name ?? pane.agentId;
  const command = agentConfig?.command ?? pane.agentId;

  // Keep CLI args stable so terminal startup is only driven by real config changes.
  const bypassPermissions = workspace?.bypassPermissions ?? false;
  const model = workspace?.modelOverrides?.[pane.agentId] ?? null;
  const effort = workspace?.effortOverrides?.[pane.agentId] ?? null;
  const initialPrompt = pane.agentId !== "terminal" ? workspace?.prompt : undefined;

  // Model selection
  const availableModels = useMemo(() => getModelsForAgent(pane.agentId), [pane.agentId]);
  const hasModelOptions = availableModels.length > 0 && pane.agentId !== "terminal";
  const modelLabel = model
    ? (availableModels.find((m) => m.value === model)?.label ?? model)
    : "Default";

  const cliArgs: string[] | undefined = useMemo(() => {
    const args: string[] = [];

    // Include agent-specific default args (e.g., opencode needs "." to start TUI)
    if (agentConfig?.defaultArgs?.length) {
      args.push(...agentConfig.defaultArgs);
    }

    if (bypassPermissions) {
      const flag = BYPASS_FLAGS[pane.agentId];
      if (flag) args.push(flag);
    }

    if (model) {
      args.push("--model", model);
    }

    if (effort) {
      args.push("--effort", effort);
    }

    return args.length > 0 ? args : undefined;
  }, [agentConfig?.defaultArgs, bypassPermissions, effort, model, pane.agentId]);

  const terminalShellLaunch = useMemo(
    () =>
      resolveTerminalShellLaunch(
        pane.terminalShell ?? workspace?.terminalShell ?? defaultTerminalShell,
        command,
      ),
    [command, defaultTerminalShell, pane.terminalShell, workspace?.terminalShell],
  );

  // SSH override for remote workspaces
  const server = workspace?.serverId
    ? useServerStore.getState().getServer(workspace.serverId)
    : undefined;
  const knownHostsPath = useServerStore((s) => s.knownHostsPath);
  const isRemote = !!server;
  const paneIdentity =
    pane.agentId === "terminal"
      ? `${agentName} · ${isRemote ? "Remote login shell" : terminalShellLaunch.label}`
      : agentName;
  // Only a local terminal pane actually launches the configured shell; a
  // remote pane always gets the host's login shell, so its stored selection
  // was never in play and there is nothing to report.
  const shellFallbackReason =
    pane.agentId === "terminal" && !isRemote ? terminalShellLaunch.fallbackReason : undefined;

  // Resolve the pane's launch binary only when the user opens the overflow
  // menu to look. `inspect_cli_launch` runs the exact ladder
  // `create_pty_session` runs, so what this shows is what spawns.
  useEffect(() => {
    if (
      !showOverflow ||
      isRemote ||
      pane.agentId === "terminal" ||
      pane.agentId === "packetcode"
    ) {
      return;
    }
    let cancelled = false;
    void inspectCliLaunch(command)
      .then((info) => {
        if (!cancelled) setCliLaunch(info);
      })
      .catch(() => {
        // A failed probe must not replace a previously good readout with a
        // wrong one; leave whatever is there and say nothing new.
      });
    return () => {
      cancelled = true;
    };
  }, [command, isRemote, pane.agentId, showOverflow]);
  const localPlatform =
    typeof navigator !== "undefined" &&
    /windows|win32|win64/i.test(navigator.userAgent || navigator.platform || "")
      ? "windows"
      : "posix";
  const packetCodeHome =
    pane.agentId === "packetcode"
      ? isRemote && server
        ? packetCodeRemoteDataHomes[server.id]?.trim()
        : packetCodeLocalDataHome.trim()
      : "";
  const packetCodeHomeIsValid =
    !packetCodeHome ||
    isAbsolutePacketCodePath(packetCodeHome, isRemote ? "posix" : localPlatform);

  // Resolve one immutable launch identity before a local PacketCode PTY is
  // mounted. The same backend probe selects the executable, verifies its
  // version contract, and asks PacketCode for its effective data home. While a
  // session is alive, keep showing the identity that launched it even if the
  // user edits Settings; the next restart resolves the new values.
  //
  // FAULT this guards against: an earlier version re-probed whenever
  // `pane.sessionId` changed. A PacketCode session ending flipped the pane
  // back to "probing", which unmounted TerminalPane; the remount re-armed
  // autoStart and launched PacketCode again. A binary that exits at startup
  // therefore relaunched in a tight loop. Now a probe only runs when the
  // inputs it depends on actually change (or the user asks for a recheck), and
  // a mounted pane keeps its previous identity while a re-probe is in flight.
  const packetCodeProbeKey = `${packetCodeManualPath ?? ""} ${packetCodeHome} ${packetCodeProbeNonce}`;
  useEffect(() => {
    if (pane.agentId !== "packetcode" || isRemote) {
      packetCodeProbedKeyRef.current = null;
      setPacketCodeRuntime((prev) =>
        prev.status === "not-applicable" ? prev : NOT_APPLICABLE_RUNTIME,
      );
      return;
    }
    // A live session keeps the identity it launched with; changed inputs are
    // picked up once it ends.
    if (pane.sessionId && packetCodeRuntimeRef.current.identity) return;
    if (packetCodeProbedKeyRef.current === packetCodeProbeKey) return;
    packetCodeProbedKeyRef.current = packetCodeProbeKey;

    if (!packetCodeHomeIsValid) {
      setPacketCodeRuntime({
        status: "error",
        identity: null,
        message: "PACKETCODE_HOME must be an absolute host path before PacketCode can launch.",
      });
      return;
    }

    let cancelled = false;
    let settled = false;
    setPacketCodeRuntime((prev) => ({ status: "probing", identity: prev.identity }));
    void probePacketCodeIntegration(packetCodeManualPath, packetCodeHome || null)
      .then((identity) => {
        settled = true;
        if (!cancelled) setPacketCodeRuntime({ status: "ready", identity });
      })
      .catch((reason) => {
        settled = true;
        if (cancelled) return;
        setPacketCodeRuntime({
          status: "error",
          identity: null,
          message: reason instanceof Error ? reason.message : String(reason),
        });
      });
    return () => {
      cancelled = true;
      // A probe cancelled mid-flight (StrictMode's mount/unmount/mount, or
      // inputs changing again) must not leave its key marked as resolved, or
      // the next run would skip the probe and the pane would sit on
      // "resolving" forever.
      if (!settled && packetCodeProbedKeyRef.current === packetCodeProbeKey) {
        packetCodeProbedKeyRef.current = null;
      }
    };
  }, [
    isRemote,
    packetCodeHome,
    packetCodeHomeIsValid,
    packetCodeManualPath,
    packetCodeProbeKey,
    pane.agentId,
    pane.sessionId,
  ]);

  const packetCodeIdentity = packetCodeRuntime.identity;
  const packetCodeVersionLabel = packetCodeIdentity?.version.replace(/^packetcode\s+/i, "");
  // Multi-account CLI binding. `pane.accountId` is absent for ambient panes,
  // in which case `accountEnvForSlot` returns `{}` and this whole feature is
  // inert — the env object below is byte-identical to what it was before.
  const accountId = pane.accountId ?? null;
  const accountEnv = useMemo(
    () => accountEnvForSlot(pane.agentId, accountId),
    [pane.agentId, accountId],
  );

  // REFUSE-TO-LAUNCH. `gate.state === "ambient"` for every pane without an
  // explicit accountId, and the hook short-circuits before any IPC in that
  // case — existing panes gain no probe and no new failure mode.
  const { gate, recheck } = useAccountLaunchGate(pane.agentId, accountId);
  const gateHolds = gate.state === "probing" || gate.state === "blocked";
  const accountCaveat = gate.state === "ready" ? gate.caveat : undefined;
  const [showAccountLogin, setShowAccountLogin] = useState(false);
  const loginCli = accountLoginCliForSlot(pane.agentId);

  /**
   * The ONE env object for this pane. It reaches both spawn paths:
   *   - local: `<TerminalPane env={…}>` → `useTerminalSession` → `create_pty_session`
   *   - SSH:   `buildSshArgs(…, paneEnv)` → remote `env K=V …` prefix
   * so a pane's account binding cannot be honoured on one transport and
   * dropped on the other.
   *
   * PACKETCODE_HOME and the account vars compose rather than compete: they are
   * disjoint keys, the PACKETCODE_HOME branch only ever fires for the
   * `packetcode` slot, and the account branch only ever fires for
   * `claude-code`/`codex`. In practice at most one of the two contributes, but
   * the merge is written so both could without either clobbering the other.
   *
   * Caveat (documented, not solved here): for SSH workspaces the account's
   * `configDir` is a path on the *local* machine. Remote account config dirs
   * are a separate problem; the binding is still forwarded so the remote CLI
   * cannot silently pick up the remote ambient login without a trace.
   */
  const paneEnv = useMemo<Record<string, string> | undefined>(() => {
    const merged: Record<string, string> = {};
    if (packetCodeHome) {
      const platform = isRemote ? "posix" : localPlatform;
      if (isAbsolutePacketCodePath(packetCodeHome, platform)) {
        merged.PACKETCODE_HOME = packetCodeHome;
      }
    }
    Object.assign(merged, accountEnv);
    return Object.keys(merged).length > 0 ? merged : undefined;
  }, [isRemote, localPlatform, packetCodeHome, accountEnv]);
  const localCommand =
    pane.agentId === "terminal"
      ? terminalShellLaunch.command
      : pane.agentId === "packetcode" && packetCodeIdentity
        ? packetCodeIdentity.executablePath
        : command;
  const localArgs =
    pane.agentId === "terminal"
      ? terminalShellLaunch.args.length > 0
        ? terminalShellLaunch.args
        : undefined
      : cliArgs;
  const effectiveCommand = isRemote ? "ssh" : localCommand;
  const remoteCommand =
    isRemote && pane.agentId === "terminal"
      ? null
      : isRemote && pane.agentId === "packetcode"
        ? "packetcode"
        : command;
  const effectiveArgs = useMemo(() => {
    if (!isRemote || !server) return localArgs;
    return buildSshArgs(
      server,
      workspace?.remoteProjectPath ?? server.remotePath ?? "",
      remoteCommand,
      pane.agentId === "terminal" ? undefined : cliArgs,
      knownHostsPath ?? undefined,
      paneEnv,
    );
  }, [
    isRemote,
    server,
    remoteCommand,
    localArgs,
    cliArgs,
    pane.agentId,
    workspace?.remoteProjectPath,
    knownHostsPath,
    paneEnv,
  ]);

  // Render the unified header bar — combines drag handle, agent identity,
  // CLI status, and lifecycle controls into a single row.
  const renderHeader = useCallback(
    (state: TerminalHeaderRenderState) => {
      const c = getAgentColor(state.cliCommand);
      const isLocalPacketCode = pane.agentId === "packetcode" && !isRemote;
      const packetCodeResolving = isLocalPacketCode && packetCodeRuntime.status === "probing";
      const packetCodeBlocked = isLocalPacketCode && packetCodeRuntime.status === "error";
      const notInstalled = !isLocalPacketCode && !!agentConfig && !agentConfig.installed;
      // How the last session ended, once nothing more urgent is being shown.
      // A CLI that died with a code has to READ differently from a session the
      // user closed — that was the whole defect: both rendered as "idle".
      const exitLabel = state.alive ? null : ptyExitPillLabel(state.lastExit);
      const exitPillClass =
        state.lastExit?.kind === "failed"
          ? "bg-bg-elevated text-accent-red"
          : state.lastExit?.kind === "unknown"
            ? "bg-bg-elevated text-accent-amber"
            : "bg-bg-elevated text-text-muted";
      const statusLabel = packetCodeResolving
        ? "resolving"
        : packetCodeBlocked
          ? "blocked"
          : notInstalled
        ? "not installed"
        : state.showApproval
          ? "approval"
          : state.alive
            ? "running"
            : state.error
              ? "error"
              : (exitLabel ?? "idle");
      const statusPillClass = packetCodeResolving
        ? "bg-bg-elevated text-accent-blue"
        : packetCodeBlocked
          ? "bg-bg-elevated text-accent-red"
          : notInstalled
        ? "bg-bg-elevated text-accent-amber"
        : state.showApproval
          ? "bg-accent-soft text-accent-amber"
          : state.alive
            ? "bg-accent-soft text-accent-green"
            : state.error
              ? "bg-bg-elevated text-accent-red"
              : exitLabel
                ? exitPillClass
                : "bg-bg-elevated text-text-muted";
      const statusTitle =
        state.error ?? (exitLabel && state.lastExit ? describePtyExitOutcome(state.lastExit) : statusLabel);

      const headerContent = (
        <TileChrome
          title={paneIdentity}
          titleClassName={c.text}
          icon={
            <span
              className={`h-2 w-2 shrink-0 rounded-full ${c.text} bg-current ${state.alive ? "animate-pulse" : ""}`}
            />
          }
          identityDetails={
            <>
              {packetCodeVersionLabel && (
                <span
                  className="max-w-[150px] truncate rounded border border-accent-amber/30 bg-accent-amber/5 px-1.5 py-0.5 font-mono text-meta text-accent-amber"
                  title={`Binary: ${packetCodeIdentity?.executablePath}\nVersion: ${packetCodeIdentity?.version}\nData home: ${packetCodeIdentity?.effectiveHome ?? "Unknown"}`}
                >
                  {packetCodeVersionLabel}
                </span>
              )}
              {/* FAULT: an unhonourable custom-shell selection fell back to
              auto-detect with no signal at all — the header simply named a
              shell the user had not chosen. */}
              {shellFallbackReason && (
                <span
                  role="img"
                  aria-label={shellFallbackReason}
                  title={shellFallbackReason}
                  className="shrink-0 text-accent-amber"
                >
                  <AlertTriangle size={11} />
                </span>
              )}
              {/* Right next to the agent identity: two tiles running the same CLI
              under two logins are otherwise identical. Ambient panes render
              nothing here. */}
              <AccountChip accountId={accountId} caveat={accountCaveat} className="max-w-[130px]" />
            </>
          }
          status={{ label: statusLabel, className: statusPillClass, title: statusTitle }}
          isZoomed={isZoomed}
          onToggleZoom={() => setZoomedPane(isZoomed ? null : pane.id)}
          shortcutHint="Previous/next terminal: Ctrl+Alt+PageUp / PageDown."
        >
          <div ref={overflowRef} className="relative shrink-0">
            <button
              onClick={(e) => {
                e.stopPropagation();
                setShowOverflow((v) => !v);
              }}
              onMouseDown={(e) => e.stopPropagation()}
              className="p-0.5 text-text-muted transition-colors hover:text-text-primary"
              title="More"
              aria-label={`More controls: ${paneIdentity}`}
              aria-expanded={showOverflow}
            >
              <MoreVertical size={11} />
            </button>
            {showOverflow && (
              <div
                className="absolute right-0 top-full z-50 mt-1 w-64 rounded-md border border-bg-border bg-bg-elevated shadow-xl"
                onMouseDown={(e) => e.stopPropagation()}
              >
                {overflowView === "root" && (
                  <div className="py-1">
                    {packetCodeIdentity && (
                      <div className="mb-1 space-y-1 border-b border-bg-border px-3 pb-2 pt-1">
                        <div className="text-meta font-medium uppercase tracking-wide text-text-muted">
                          PacketCode runtime
                        </div>
                        <div className="font-mono text-meta text-text-primary">
                          {packetCodeIdentity.version}
                        </div>
                        <div
                          className="break-all font-mono text-meta text-text-secondary"
                          title={packetCodeIdentity.executablePath}
                        >
                          Binary: {packetCodeIdentity.executablePath}
                        </div>
                        <div
                          className="break-all font-mono text-meta text-text-secondary"
                          title={packetCodeIdentity.effectiveHome ?? ""}
                        >
                          Home: {packetCodeIdentity.effectiveHome ?? "Unknown"}
                        </div>
                      </div>
                    )}
                    {cliLaunch && (
                      <div className="mb-1 space-y-1 border-b border-bg-border px-3 pb-2 pt-1">
                        <div className="text-meta font-medium uppercase tracking-wide text-text-muted">
                          Launch binary
                        </div>
                        {cliLaunch.version && (
                          <div className="font-mono text-meta text-text-primary">
                            {cliLaunch.version}
                          </div>
                        )}
                        <div
                          className={`break-all font-mono text-meta ${
                            cliLaunch.resolved ? "text-text-secondary" : "text-accent-amber"
                          }`}
                          title={cliLaunch.path}
                        >
                          {cliLaunch.path}
                        </div>
                        <div className="text-meta text-text-muted">
                          via {cliLaunchSourceLabel(cliLaunch.source)}
                        </div>
                        {cliLaunch.rejectedSettingsPath && (
                          <div
                            className="break-all text-meta text-accent-amber"
                            title={cliLaunch.rejectedSettingsPath}
                          >
                            Ignored missing override: {cliLaunch.rejectedSettingsPath}
                          </div>
                        )}
                      </div>
                    )}
                    {hasModelOptions && (
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          setOverflowView("model");
                        }}
                        onMouseDown={(e) => e.stopPropagation()}
                        className="w-full px-3 py-1.5 text-left text-ui text-text-primary transition-colors hover:bg-bg-hover"
                      >
                        Model: {modelLabel}
                      </button>
                    )}
                    {pane.sessionId && (
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          setOverflowView("prompts");
                        }}
                        onMouseDown={(e) => e.stopPropagation()}
                        className="w-full px-3 py-1.5 text-left text-ui text-text-primary transition-colors hover:bg-bg-hover"
                      >
                        Send prompt…
                      </button>
                    )}
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        setOverflowView("pins");
                      }}
                      onMouseDown={(e) => e.stopPropagation()}
                      className="w-full px-3 py-1.5 text-left text-ui text-text-primary transition-colors hover:bg-bg-hover"
                    >
                      Pinned commands ({pinnedCommands.length}/5)
                    </button>
                    <div className="my-1 border-t border-bg-border" />
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        state.onRestart();
                        setShowOverflow(false);
                      }}
                      onMouseDown={(e) => e.stopPropagation()}
                      className="w-full px-3 py-1.5 text-left text-ui text-text-primary transition-colors hover:bg-bg-hover"
                    >
                      {state.alive ? "Restart session" : "Start session"}
                    </button>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        setPendingClose({ onKill: state.onKill });
                        setShowOverflow(false);
                      }}
                      onMouseDown={(e) => e.stopPropagation()}
                      className="w-full px-3 py-1.5 text-left text-ui text-text-primary transition-colors hover:bg-accent-red/10 hover:text-accent-red"
                    >
                      Close pane
                    </button>
                  </div>
                )}
                {overflowView === "model" && (
                  <div className="py-1">
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        setOverflowView("root");
                      }}
                      onMouseDown={(e) => e.stopPropagation()}
                      className="w-full px-3 py-1 text-left text-meta uppercase tracking-wide text-text-muted transition-colors hover:text-text-primary"
                    >
                      ← Back
                    </button>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        useWorkspaceStore
                          .getState()
                          .setModelOverride(workspaceId, pane.agentId, null);
                        setShowOverflow(false);
                        setOverflowView("root");
                      }}
                      onMouseDown={(e) => e.stopPropagation()}
                      className={`w-full px-3 py-1.5 text-left text-ui transition-colors hover:bg-bg-hover ${
                        !model ? "font-medium text-accent-green" : "text-text-primary"
                      }`}
                    >
                      Default
                    </button>
                    {availableModels.map((m) => (
                      <button
                        key={m.value}
                        onClick={(e) => {
                          e.stopPropagation();
                          useWorkspaceStore
                            .getState()
                            .setModelOverride(workspaceId, pane.agentId, m.value);
                          setShowOverflow(false);
                          setOverflowView("root");
                        }}
                        onMouseDown={(e) => e.stopPropagation()}
                        className={`w-full px-3 py-1.5 text-left text-ui transition-colors hover:bg-bg-hover ${
                          model === m.value ? "font-medium text-accent-green" : "text-text-primary"
                        }`}
                      >
                        {m.label}
                      </button>
                    ))}
                    <div className="mt-1 border-t border-bg-border px-3 py-1 pt-1">
                      <span className="text-meta text-text-muted">
                        Takes effect on next session
                      </span>
                    </div>
                  </div>
                )}
                {overflowView === "prompts" && (
                  <div className="max-h-[280px] overflow-y-auto py-1">
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        setOverflowView("root");
                      }}
                      onMouseDown={(e) => e.stopPropagation()}
                      className="w-full px-3 py-1 text-left text-meta uppercase tracking-wide text-text-muted transition-colors hover:text-text-primary"
                    >
                      ← Back
                    </button>
                    {promptTemplates.length === 0 ? (
                      <div className="px-3 py-2 text-ui text-text-muted">
                        No templates yet. Add some in Settings → Prompt Templates.
                      </div>
                    ) : (
                      promptTemplates.map((t) => (
                        <button
                          key={t.id}
                          onClick={(e) => {
                            e.stopPropagation();
                            sendPromptTemplate(t.id);
                          }}
                          onMouseDown={(e) => e.stopPropagation()}
                          disabled={!state.alive || sendingInput || !!failedInput}
                          className="flex w-full items-center gap-1.5 px-3 py-1.5 text-left text-ui text-text-primary transition-colors hover:bg-bg-hover disabled:opacity-40"
                          title={t.content}
                        >
                          <span className="truncate">{t.name}</span>
                          <span className="ml-auto text-meta text-text-muted">{t.category}</span>
                        </button>
                      ))
                    )}
                  </div>
                )}
                {overflowView === "pins" && (
                  <div className="py-1">
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        setOverflowView("root");
                      }}
                      onMouseDown={(e) => e.stopPropagation()}
                      className="w-full px-3 py-1 text-left text-meta uppercase tracking-wide text-text-muted transition-colors hover:text-text-primary"
                    >
                      ← Back
                    </button>
                    <div className="space-y-1.5 px-3 pb-2">
                      <div className="text-meta font-medium uppercase tracking-wider text-text-muted">
                        Pinned Commands ({pinnedCommands.length}/5)
                      </div>
                      {pinnedCommands.map((cmd, i) => (
                        <div key={i} className="group flex items-center gap-1">
                          <span className="flex-1 truncate text-ui text-text-secondary" title={cmd}>
                            {cmd}
                          </span>
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              runCommand(cmd);
                            }}
                            onMouseDown={(e) => e.stopPropagation()}
                            className="shrink-0 p-0.5 text-text-muted transition-colors hover:text-accent-green"
                            title="Run"
                            disabled={
                              !pane.sessionId || !state.alive || sendingInput || !!failedInput
                            }
                          >
                            <Play size={10} />
                          </button>
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              useWorkspaceStore
                                .getState()
                                .removePinnedCommand(workspaceId, pane.id, i);
                            }}
                            onMouseDown={(e) => e.stopPropagation()}
                            className="shrink-0 p-0.5 text-text-muted transition-colors hover:text-accent-red"
                            title="Remove"
                          >
                            <X size={10} />
                          </button>
                        </div>
                      ))}
                      {pinnedCommands.length < 5 && (
                        <form
                          onSubmit={(e) => {
                            e.preventDefault();
                            if (newPinCmd.trim()) {
                              useWorkspaceStore
                                .getState()
                                .addPinnedCommand(workspaceId, pane.id, newPinCmd);
                              setNewPinCmd("");
                            }
                          }}
                          className="flex items-center gap-1 border-t border-bg-border pt-1"
                        >
                          <input
                            type="text"
                            value={newPinCmd}
                            onChange={(e) => setNewPinCmd(e.target.value)}
                            onMouseDown={(e) => e.stopPropagation()}
                            placeholder="Add command..."
                            className="flex-1 rounded border border-bg-border bg-bg-secondary px-1.5 py-0.5 text-ui text-text-primary focus:border-accent-blue focus:outline-none"
                          />
                          <button
                            type="submit"
                            onMouseDown={(e) => e.stopPropagation()}
                            className="shrink-0 p-0.5 text-text-muted transition-colors hover:text-accent-green"
                            title="Add"
                          >
                            <Plus size={10} />
                          </button>
                        </form>
                      )}
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        </TileChrome>
      );

      const quickBar =
        pinnedCommands.length > 0 ? (
          <div className="bg-bg-secondary/50 flex gap-1 overflow-x-auto border-b border-bg-border px-2 py-1">
            {pinnedCommands.map((cmd, i) => (
              <button
                key={i}
                onClick={() => runCommand(cmd)}
                disabled={!pane.sessionId || !state.alive || sendingInput || !!failedInput}
                className="max-w-[120px] truncate rounded bg-bg-hover px-2 py-0.5 text-meta text-text-secondary hover:text-text-primary disabled:opacity-40"
                title={cmd}
              >
                {cmd}
              </button>
            ))}
          </div>
        ) : null;

      const fullHeader = (
        <div className="relative">
          {headerContent}
          {quickBar}
          {sendingInput && (
            <div role="status" className="px-2 py-1 text-ui text-text-muted">
              Sending to terminal…
            </div>
          )}
          {failedInput && (
            <div
              className="space-y-1 border-b border-bg-border bg-bg-secondary px-2 py-2 text-ui"
              onMouseDown={(e) => e.stopPropagation()}
              onDoubleClick={(e) => e.stopPropagation()}
            >
              <div role="alert" className="break-words text-accent-red">
                {failedInput.label} could not be sent: {failedInput.error}
              </div>
              <pre className="max-h-24 select-text overflow-auto whitespace-pre-wrap break-words rounded bg-bg-primary px-2 py-1 font-mono text-meta text-text-secondary">
                {failedInput.content}
              </pre>
              <p className="text-meta text-text-muted">
                Check the terminal before retrying; some input may have arrived. Starting or
                restarting the session does not resend this input.
              </p>
              <div className="flex flex-wrap gap-2">
                <button
                  onClick={() => void sendInput(failedInput)}
                  disabled={!pane.sessionId || !state.alive || sendingInput}
                  className="rounded bg-bg-hover px-2 py-1 text-text-primary disabled:opacity-40"
                >
                  Retry send
                </button>
                <button
                  onClick={() => state.onRestart()}
                  disabled={sendingInput}
                  className="rounded bg-bg-hover px-2 py-1 text-text-primary disabled:opacity-40"
                >
                  {state.alive ? "Restart session" : "Start session"}
                </button>
                <button
                  onClick={() => setFailedInput(null)}
                  disabled={sendingInput}
                  className="rounded px-2 py-1 text-text-muted disabled:opacity-40"
                >
                  Dismiss
                </button>
              </div>
            </div>
          )}
        </div>
      );

      return fullHeader;
    },
    [
      agentConfig,
      cliLaunch,
      isRemote,
      packetCodeIdentity,
      packetCodeRuntime,
      packetCodeVersionLabel,
      paneIdentity,
      shellFallbackReason,
      isZoomed,
      setZoomedPane,
      pane.id,
      pane.agentId,
      hasModelOptions,
      model,
      modelLabel,
      availableModels,
      showOverflow,
      overflowView,
      workspaceId,
      accountId,
      accountCaveat,
      pinnedCommands,
      newPinCmd,
      runCommand,
      pane.sessionId,
      promptTemplates,
      sendPromptTemplate,
      sendInput,
      failedInput,
      sendingInput,
    ],
  );

  const closeConfirmation = pendingClose
    ? createPortal(
        <ConfirmDeleteModal
          title="Close terminal pane?"
          entityName={agentName}
          description="will be removed from this Workspace."
          warnings={[
            "Any live PTY and CLI process in this pane will be stopped.",
            ...(pendingClose.error ? [pendingClose.error] : []),
          ]}
          warningTitle={pendingClose.error ? "Remote stop failed" : "Session lifecycle"}
          confirmLabel={pendingClose.busy ? "Stopping…" : "Close pane"}
          onClose={() => setPendingClose(null)}
          onConfirm={async () => {
            if (pendingClose.busy) return;
            const onKill = pendingClose.onKill;
            setPendingClose({ onKill, busy: true });
            try {
              await onKill();
              useWorkspaceStore.getState().removePane(workspaceId, pane.id);
              setPendingClose(null);
            } catch (reason) {
              setPendingClose({
                onKill,
                error: reason instanceof Error ? reason.message : String(reason),
              });
            }
          }}
        />,
        document.body,
      )
    : null;

  const wrapperBorderClass = isFocused ? "border border-accent-line" : "border border-bg-border";
  // Focus-flash highlight (P4-S1): amber ring pulse while a focusPaneRequest
  // targets this pane.
  const flashClass = isFlashing
    ? "ring-2 ring-accent-amber animate-pulse motion-reduce:animate-none"
    : "";

  // While the gate holds we mount NO TerminalPane. Disabling `autoStart` alone
  // would not be enough: the header's "Start session" item calls straight into
  // `useTerminalSession`, so an unmounted terminal is the only way to be sure
  // the CLI cannot be spawned with the wrong (or missing) account env.
  if (gateHolds) {
    return (
      <>
        <div
          data-pane-zoomed={isZoomed || undefined}
          className={`flex h-full flex-col overflow-hidden rounded-md ${wrapperBorderClass} ${flashClass}`}
        >
          {renderHeader({
            alive: false,
            error: null,
            showApproval: false,
            cliCommand: effectiveCommand,
            // No PTY was ever launched behind this gate, so there is no exit
            // to report — `null`, not a fabricated clean one.
            lastExit: null,
            // "Start session" in the overflow menu re-probes instead of spawning.
            onRestart: recheck,
            onKill: () => {},
          })}
          <AccountBlockedPane
            accountId={accountId ?? ""}
            label={gate.label}
            reason={gate.state === "blocked" ? gate.reason : ""}
            probing={gate.state === "probing"}
            onLogin={
              gate.state === "blocked" && gate.loginCli
                ? () => setShowAccountLogin(true)
                : undefined
            }
            onRecheck={recheck}
          />
          {showAccountLogin && loginCli && (
            <LoginPtyModal
              cli={loginCli}
              projectPath={workspace?.projectPath}
              // The whole point: the login writes credentials into THIS
              // account's config dir, not the ambient one.
              env={accountEnv}
              accountLabel={gate.label}
              onClose={() => {
                setShowAccountLogin(false);
                recheck();
              }}
            />
          )}
        </div>
        {closeConfirmation}
      </>
    );
  }

  // Local: blocked only while there is no identity at all (first probe still
  // running, or the last probe failed). A re-probe that still holds the previous
  // identity keeps the mounted TerminalPane in place.
  const packetCodeLaunchBlocked =
    pane.agentId === "packetcode" &&
    ((!isRemote && !packetCodeIdentity) || (isRemote && !packetCodeHomeIsValid));
  if (packetCodeLaunchBlocked) {
    const probing = !isRemote && packetCodeRuntime.status === "probing";
    const message =
      !isRemote && packetCodeRuntime.status === "error"
        ? packetCodeRuntime.message
        : !packetCodeHomeIsValid
          ? "PACKETCODE_HOME must be an absolute path for this host."
          : "Resolving the PacketCode runtime…";
    return (
      <>
        <div
          data-pane-zoomed={isZoomed || undefined}
          className={`flex h-full flex-col overflow-hidden rounded-md ${wrapperBorderClass} ${flashClass}`}
        >
          {renderHeader({
            alive: false,
            error: probing ? null : message,
            showApproval: false,
            cliCommand: effectiveCommand,
            lastExit: null,
            onRestart: () => setPacketCodeProbeNonce((value) => value + 1),
            onKill: () => {},
          })}
          <div className="flex flex-1 items-center justify-center p-6">
            <div className="max-w-lg text-center">
              {probing ? (
                <Loader2 size={20} className="mx-auto animate-spin text-accent-blue" />
              ) : (
                <AlertTriangle size={20} className="mx-auto text-accent-red" />
              )}
              <div className="mt-2 text-xs font-medium text-text-primary">
                {probing ? "Resolving PacketCode" : "PacketCode launch blocked"}
              </div>
              <div className="mt-1 text-[11px] leading-relaxed text-text-secondary">{message}</div>
              {!probing && (
                <button
                  type="button"
                  onClick={() => setPacketCodeProbeNonce((value) => value + 1)}
                  className="mt-3 rounded border border-accent-blue/40 px-2.5 py-1.5 text-ui text-accent-blue hover:bg-accent-blue/10"
                >
                  Recheck runtime
                </button>
              )}
            </div>
          </div>
        </div>
        {closeConfirmation}
      </>
    );
  }

  return (
    <>
      {/* data-pane-zoomed lets mosaic-overrides.css maximize this pane's
          already-mounted mosaic tile when zoomed (.mosaic-zoom-active) instead
          of mounting a duplicate WorkspacePane (which would spawn a second PTY). */}
      <div
        data-pane-zoomed={isZoomed || undefined}
        className={`flex h-full flex-col overflow-hidden rounded-md ${wrapperBorderClass} ${flashClass}`}
      >
        <TerminalPane
          paneId={pane.id}
          autoStart={autoStart}
          cliCommand={effectiveCommand}
          cliArgs={effectiveArgs}
          env={isRemote ? undefined : paneEnv}
          projectPath={workspace?.projectPath}
          workspaceId={workspaceId}
          initialPrompt={initialPrompt}
          renderHeader={renderHeader}
          onSessionCreated={(sessionId) =>
            useWorkspaceStore.getState().setPaneSession(workspaceId, pane.id, sessionId)
          }
          onSessionEnded={() =>
            useWorkspaceStore.getState().setPaneSession(workspaceId, pane.id, null)
          }
          showCloseButton={false}
        />
      </div>
      {closeConfirmation}
    </>
  );
}
