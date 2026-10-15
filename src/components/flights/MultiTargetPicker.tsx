import { useMemo, useRef } from "react";
import { Folder, Server, X, Check, AlertTriangle } from "lucide-react";
import { useWorkspaceStore } from "@/stores/workspaceStore";
import { useServerStore } from "@/stores/serverStore";
import { API_PROVIDERS, DEFAULT_API_AGENT, getDefaultModel } from "@/lib/api-models";
import { detectBaseBranch } from "@/components/flights/detectBaseBranch";
import type { AgentCli } from "@/stores/agentTaskStore";
import type { ServerConfig } from "@/types/server";
import type { Workspace } from "@/types/workspace";
import { isLocalWorkspace } from "@/types/workspace";

export type PickedTarget =
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
    };

interface MultiTargetPickerProps {
  picked: PickedTarget[];
  onChange: (next: PickedTarget[]) => void;
  defaultAgent?: AgentCli;
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
}: MultiTargetPickerProps) {
  const workspaces = useWorkspaceStore((s) => s.workspaces);
  const sshServers = useServerStore((s) => s.servers);

  const isPicked = (key: string) => picked.some((p) => p.key === key);

  // The picker is controlled, so a detection that lands after the click must
  // patch whatever the parent holds NOW — not the array captured at add time.
  const pickedRef = useRef(picked);
  pickedRef.current = picked;

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
      if (!current || current.baseBranch !== DEFAULT_BRANCH) return;
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
    };
    onChange([...picked, target]);
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
    };
    onChange([...picked, target]);
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
          Targets — click to add
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
              const provider = API_PROVIDERS.find((pr) => pr.agentCli === p.agent);
              return (
                <div
                  key={p.key}
                  className="flex items-center gap-2 border-b border-bg-border bg-bg-primary px-2 py-1.5 text-[11px] last:border-b-0"
                >
                  {p.kind === "local" ? (
                    <Folder size={11} className="shrink-0 text-text-muted" />
                  ) : (
                    <Server size={11} className="shrink-0 text-accent-purple" />
                  )}
                  <span className="min-w-[80px] max-w-[140px] truncate font-medium text-text-primary">
                    {p.label}
                  </span>
                  <input
                    type="text"
                    value={p.baseBranch}
                    onChange={(e) => updatePicked(p.key, { baseBranch: e.target.value })}
                    className="w-20 flex-shrink-0 rounded border border-bg-border bg-bg-secondary px-1.5 py-0.5 text-[10px] text-text-primary outline-none focus:border-accent-green/40"
                    placeholder="branch"
                    title="Base branch for the worktree"
                  />
                  <select
                    value={p.agent}
                    onChange={(e) => {
                      const agent = e.target.value as AgentCli;
                      updatePicked(p.key, {
                        agent,
                        model: getDefaultModel(agent),
                      });
                    }}
                    className="flex-shrink-0 rounded border border-bg-border bg-bg-secondary px-1.5 py-0.5 text-[10px] text-text-secondary outline-none focus:border-accent-green/40"
                  >
                    {API_PROVIDERS.map((pr) => (
                      <option key={pr.agentCli} value={pr.agentCli}>
                        {pr.name}
                      </option>
                    ))}
                  </select>
                  <select
                    value={p.model}
                    onChange={(e) => updatePicked(p.key, { model: e.target.value })}
                    className="min-w-[100px] flex-1 rounded border border-bg-border bg-bg-secondary px-1.5 py-0.5 text-[10px] text-text-secondary outline-none focus:border-accent-green/40"
                  >
                    {provider?.models.map((m) => (
                      <option key={m.value} value={m.value}>
                        {m.label}
                      </option>
                    ))}
                  </select>
                  <button
                    onClick={() => onChange(picked.filter((x) => x.key !== p.key))}
                    className="p-0.5 text-text-muted hover:text-accent-red"
                    title="Remove"
                  >
                    <X size={11} />
                  </button>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
