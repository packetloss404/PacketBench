import { useEffect, useMemo, useRef, useState } from "react";
import { Folder, Server, X, Check, AlertTriangle } from "lucide-react";
import { useWorkspaceStore } from "@/stores/workspaceStore";
import { useServerStore } from "@/stores/serverStore";
import { DEFAULT_API_AGENT, getDefaultModel } from "@/lib/api-models";
import { detectBaseBranch } from "@/components/flights/detectBaseBranch";
import type { AgentCli } from "@/stores/agentTaskStore";
import type { ServerConfig } from "@/types/server";
import type { Workspace } from "@/types/workspace";
import { isLocalWorkspace } from "@/types/workspace";
import { FlightAgentPicker } from "./FlightAgentPicker";
import { flightTargetInputError } from "@/lib/flightLaunchContext";

export type PickedTarget = { autoSelectAgent?: boolean } & (
  | {
      kind: "local";
      key: string;
      workspaceId: string;
      label: string;
      basePath: string;
      baseBranch: string;
      agent: AgentCli;
      model: string;
    }
  | {
      kind: "ssh";
      key: string;
      /** Phase 2: ServerConfig from the unified server registry. Was
       *  `SshTarget` from the deleted sshTargetStore. */
      server: ServerConfig;
      label: string;
      basePath: string;
      baseBranch: string;
      agent: AgentCli;
      model: string;
    }
);

interface MultiTargetPickerProps {
  picked: PickedTarget[];
  onChange: (next: PickedTarget[]) => void;
  defaultAgent?: AgentCli;
  allowMultiple?: boolean;
  onValidationChange?: (errors: string[]) => void;
}

function targetSignature(target: PickedTarget): string {
  return JSON.stringify([
    target.kind,
    target.basePath,
    target.baseBranch,
    target.agent,
    target.model,
    target.kind === "ssh"
      ? [
          target.server.id,
          target.server.host,
          target.server.port,
          target.server.username,
          target.server.hostFingerprint,
        ]
      : "",
  ]);
}

function TargetConfiguration({
  target,
  onChange,
  onRemove,
  onValidation,
  verifyRepository,
}: {
  target: PickedTarget;
  onChange: (patch: Partial<PickedTarget>) => void;
  onRemove: () => void;
  onValidation: (error: string | null) => void;
  verifyRepository: boolean;
}) {
  const [agentError, setAgentError] = useState<string | null>("Checking API access…");
  const [repository, setRepository] = useState<{
    identity: string;
    error: string | null;
  } | null>(null);
  const [refresh, setRefresh] = useState(0);
  const latest = useRef({ target, onChange, onValidation });
  latest.current = { target, onChange, onValidation };
  const fingerprint = target.kind === "ssh" ? target.server.hostFingerprint : "local";
  const repositoryIdentity = JSON.stringify([
    target.basePath,
    target.kind,
    target.kind === "ssh"
      ? [
          target.server.id,
          target.server.host,
          target.server.port,
          target.server.username,
          fingerprint,
        ]
      : null,
  ]);
  useEffect(() => {
    if (!verifyRepository || !target.basePath || (target.kind === "ssh" && !fingerprint)) return;
    let stale = false;
    const identity = repositoryIdentity;
    const timer = setTimeout(() => {
      void detectBaseBranch(latest.current.target).then((branch) => {
        if (stale) return;
        setRepository({
          identity,
          error: branch
            ? null
            : "Repository could not be verified. Check the path and host connection, then retry.",
        });
        if (branch && !latest.current.target.baseBranch)
          latest.current.onChange({ baseBranch: branch });
      });
    }, 250);
    return () => {
      stale = true;
      clearTimeout(timer);
    };
  }, [target.basePath, target.kind, fingerprint, repositoryIdentity, refresh, verifyRepository]);
  const inputError = flightTargetInputError(target);
  const repositoryError = verifyRepository
    ? repository?.identity === repositoryIdentity
      ? repository.error
      : "Checking repository…"
    : null;
  const error = inputError || repositoryError || agentError;
  useEffect(() => {
    latest.current.onValidation(error);
  }, [error, target.agent, target.model, target.baseBranch, target.basePath, repositoryIdentity]);
  return (
    <fieldset className="min-w-0 space-y-3 border-b border-bg-border bg-bg-primary p-3 last:border-b-0">
      <legend className="px-1 text-[11px] font-medium text-text-secondary">
        {target.label} ·{" "}
        {target.kind === "ssh" ? `${target.server.username}@${target.server.host}` : "Local"}
      </legend>
      <div className="flex items-start gap-2">
        <div className="grid min-w-0 flex-1 gap-2 sm:grid-cols-[minmax(0,1fr)_160px]">
          <label className="space-y-1 text-[10px] text-text-muted">
            <span className="block">Repository path</span>
            <input
              aria-label={`Repository path for ${target.label}`}
              value={target.basePath}
              onChange={(event) => onChange({ basePath: event.target.value, baseBranch: "" })}
              placeholder={target.kind === "ssh" ? "/srv/project" : "Absolute repository path"}
              className="w-full min-w-0 rounded border border-bg-border bg-bg-secondary px-2 py-1.5 font-mono text-[11px] text-text-primary"
            />
          </label>
          <label className="space-y-1 text-[10px] text-text-muted">
            <span className="block">Base branch</span>
            <input
              aria-label={`Base branch for ${target.label}`}
              value={target.baseBranch}
              onChange={(event) => onChange({ baseBranch: event.target.value })}
              placeholder="Detected from repository"
              title="Base branch for the worktree"
              className="w-full rounded border border-bg-border bg-bg-secondary px-2 py-1.5 text-[11px] text-text-primary"
            />
          </label>
        </div>
        <button
          type="button"
          onClick={onRemove}
          aria-label={`Remove ${target.label}`}
          title="Remove"
          className="mt-5 rounded p-1 text-text-muted hover:text-accent-red"
        >
          <X size={12} />
        </button>
      </div>
      {repositoryError && verifyRepository && (
        <div className="flex items-center gap-2 text-[10px] text-accent-amber">
          <span>{repositoryError}</span>
          <button
            type="button"
            onClick={() => setRefresh((value) => value + 1)}
            className="underline"
          >
            Check again
          </button>
        </div>
      )}
      {inputError && <p className="text-[10px] text-accent-amber">{inputError}</p>}
      <FlightAgentPicker
        agent={target.agent}
        model={target.model}
        autoSelectAgent={target.autoSelectAgent}
        onChange={(agent, model) => onChange({ agent, model })}
        onReadinessChange={setAgentError}
      />
    </fieldset>
  );
}

/**
 * FAULT: every target used to be seeded with a hard-coded "main" regardless of
 * the repository's real trunk, so a repo on `master`/`develop`/`trunk` branched
 * its attempt worktrees off a branch that may not even exist — and the row's
 * branch box looked authoritative while saying something untrue.
 *
 * This stays as the LAST resort only: the row is seeded with it so the picker
 * paints instantly, then `detectBaseBranch` replaces it with the target's
 * actual checked-out branch when the probe lands.
 */
const DEFAULT_BRANCH = "main";

export function MultiTargetPicker({
  picked,
  onChange,
  defaultAgent = DEFAULT_API_AGENT,
  allowMultiple = true,
  onValidationChange,
}: MultiTargetPickerProps) {
  const workspaces = useWorkspaceStore((s) => s.workspaces);
  const sshServers = useServerStore((s) => s.servers);
  const [validation, setValidation] = useState<
    Record<string, { signature: string; error: string | null }>
  >({});
  const validationCallback = useRef(onValidationChange);
  validationCallback.current = onValidationChange;

  const isPicked = (key: string) => picked.some((p) => p.key === key);

  // The picker is controlled, so a detection that lands after the click must
  // patch whatever the parent holds NOW — not the array captured at add time.
  const pickedRef = useRef(picked);
  pickedRef.current = picked;
  const validationKey = JSON.stringify(
    picked.map((target) => [target.key, targetSignature(target), validation[target.key]]),
  );
  useEffect(() => {
    validationCallback.current?.(
      pickedRef.current.flatMap((target) => {
        const result = validation[target.key];
        return result?.signature === targetSignature(target)
          ? result.error
            ? [`${target.label}: ${result.error}`]
            : []
          : [`${target.label}: checking repository and API access…`];
      }),
    );
  }, [validationKey, validation]);

  /**
   * Replace a freshly added row's placeholder branch with the repository's
   * real one. Deliberately fire-and-forget: the row must appear on the click,
   * and an SSH probe can take seconds. The guard below is what makes that
   * safe — a row the user has already retyped or removed is left alone, so a
   * slow probe can never overwrite a deliberate choice.
   */
  function seedRealBaseBranch(target: PickedTarget) {
    void detectBaseBranch(target).then((branch) => {
      if (!branch || branch === DEFAULT_BRANCH) return;
      const current = pickedRef.current.find((p) => p.key === target.key);
      if (!current || current.baseBranch !== DEFAULT_BRANCH || current.basePath !== target.basePath)
        return;
      onChange(
        pickedRef.current.map((p) =>
          p.key === target.key ? ({ ...p, baseBranch: branch } as PickedTarget) : p,
        ),
      );
    });
  }

  const localOptions = useMemo(
    () =>
      workspaces
        .filter(
          (w): w is Workspace & { projectPath: string } =>
            Boolean(w.projectPath) && isLocalWorkspace(w),
        )
        .map((w) => ({
          key: `local:${w.id}`,
          workspace: w,
        })),
    [workspaces],
  );

  function toggleLocal(workspace: Workspace) {
    const key = `local:${workspace.id}`;
    if (isPicked(key)) {
      onChange(picked.filter((p) => p.key !== key));
      return;
    }
    const target: PickedTarget = {
      kind: "local",
      key,
      workspaceId: workspace.id,
      label: workspace.name,
      basePath: workspace.projectPath,
      baseBranch: DEFAULT_BRANCH,
      agent: defaultAgent,
      model: getDefaultModel(defaultAgent),
      autoSelectAgent: true,
    };
    onChange(allowMultiple ? [...picked, target] : [target]);
    seedRealBaseBranch(target);
  }

  function toggleSsh(server: ServerConfig) {
    // #8a (defense in depth): never admit an SSH server without a pinned
    // host key. Same `!server.hostFingerprint` falsy check the launch gate
    // and WorkspaceCreationModal use. Protects any future caller of this
    // picker even if their launch surface forgets to gate.
    if (!server.hostFingerprint) return;
    const key = `ssh:${server.id}`;
    if (isPicked(key)) {
      onChange(picked.filter((p) => p.key !== key));
      return;
    }
    const target: PickedTarget = {
      kind: "ssh",
      key,
      server,
      label: server.name,
      // Phase 2: ServerConfig.remotePath is optional (it's a default,
      // not a per-attempt path). Fall back to "" so the row's path
      // input shows up empty and the user can fill it in.
      basePath: server.remotePath ?? "",
      baseBranch: DEFAULT_BRANCH,
      agent: defaultAgent,
      model: getDefaultModel(defaultAgent),
      autoSelectAgent: true,
    };
    onChange(allowMultiple ? [...picked, target] : [target]);
    seedRealBaseBranch(target);
  }

  function updatePicked(key: string, patch: Partial<PickedTarget>) {
    onChange(picked.map((p) => (p.key === key ? ({ ...p, ...patch } as PickedTarget) : p)));
  }

  return (
    <div className="flex flex-col gap-3">
      {/* Available targets */}
      <div className="flex flex-col gap-1.5">
        <span className="text-[10px] uppercase tracking-wide text-text-muted">
          Execution project — choose a repository
        </span>
        <div className="flex flex-wrap gap-1.5">
          {localOptions.length === 0 && sshServers.length === 0 && (
            <span className="text-[11px] italic text-text-muted">
              No workspaces or SSH servers — open a folder or add a server first.
            </span>
          )}
          {localOptions.map(({ key, workspace }) => {
            const selected = isPicked(key);
            return (
              <button
                key={key}
                onClick={() => toggleLocal(workspace)}
                className={`flex items-center gap-1.5 rounded border px-2 py-1 text-[11px] transition-colors ${
                  selected
                    ? "border-accent-green/40 bg-accent-green/15 text-accent-green"
                    : "border-bg-border bg-bg-primary text-text-secondary hover:border-accent-green/30"
                }`}
              >
                {selected ? <Check size={11} /> : <Folder size={11} />}
                {workspace.name}
              </button>
            );
          })}
          {sshServers.map((server) => {
            const key = `ssh:${server.id}`;
            const selected = isPicked(key);
            // #8a: unpinned servers (no host fingerprint) render disabled in
            // an amber state — the user must verify the host key on the
            // Servers page before they can target it.
            const unpinned = !server.hostFingerprint;
            if (unpinned) {
              return (
                <button
                  key={key}
                  type="button"
                  disabled
                  title="Host key not verified — pin it on the Servers page"
                  className="flex cursor-not-allowed items-center gap-1.5 rounded border border-accent-amber/30 bg-accent-amber/5 px-2 py-1 text-[11px] text-accent-amber opacity-70"
                >
                  <AlertTriangle size={11} />
                  {server.name}
                </button>
              );
            }
            return (
              <button
                key={key}
                onClick={() => toggleSsh(server)}
                className={`flex items-center gap-1.5 rounded border px-2 py-1 text-[11px] transition-colors ${
                  selected
                    ? "border-accent-purple/40 bg-accent-purple/15 text-accent-purple"
                    : "border-bg-border bg-bg-primary text-text-secondary hover:border-accent-purple/30"
                }`}
              >
                {selected ? <Check size={11} /> : <Server size={11} />}
                {server.name}
              </button>
            );
          })}
          <button
            type="button"
            onClick={() => {
              const target: PickedTarget = {
                kind: "local",
                key: "local:custom",
                workspaceId: "",
                label: "Local repository",
                basePath: "",
                baseBranch: "",
                agent: defaultAgent,
                model: getDefaultModel(defaultAgent),
                autoSelectAgent: true,
              };
              onChange(
                allowMultiple
                  ? [...picked.filter((item) => item.key !== target.key), target]
                  : [target],
              );
            }}
            className="rounded border border-bg-border px-2 py-1 text-[11px] text-text-secondary hover:bg-bg-hover"
          >
            Choose another local path
          </button>
        </div>
      </div>

      {/* Picked targets — per-row config */}
      {picked.length > 0 && (
        <div className="flex flex-col gap-1.5">
          <span className="text-[10px] uppercase tracking-wide text-text-muted">
            {picked.length} agent{picked.length !== 1 ? "s" : ""} will launch
          </span>
          <div className="flex flex-col gap-1 overflow-hidden rounded border border-bg-border">
            {picked.map((p) => {
              return (
                <TargetConfiguration
                  key={p.key}
                  target={p}
                  verifyRepository={Boolean(onValidationChange)}
                  onChange={(patch) => updatePicked(p.key, patch)}
                  onRemove={() => onChange(picked.filter((item) => item.key !== p.key))}
                  onValidation={(error) => {
                    const next = { signature: targetSignature(p), error };
                    setValidation((previous) =>
                      previous[p.key]?.signature === next.signature &&
                      previous[p.key]?.error === error
                        ? previous
                        : { ...previous, [p.key]: next },
                    );
                  }}
                />
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
