import type { TerminalShellSelection } from "@/types/terminal-shell";
import type { MosaicNode } from "@/types/mosaic";

export type { CustomCliConfig } from "@/generated/tauri-schema";
import type { CustomCliConfig, WorkspaceAgentSlotDto } from "@/generated/tauri-schema";

export type WorkspaceAgentSlot = WorkspaceAgentSlotDto;

export type ExecutionTargetRef = { kind: "local" } | { kind: "ssh"; serverId: string };

export interface WorkspacePane {
  id: string;
  agentId: WorkspaceAgentSlot;
  sessionId: string | null;
  customCli?: CustomCliConfig;
  gridPosition?: { row: number; col: number };
  pinnedCommands?: string[]; // max 5 saved commands
  /**
   * Pane kind discriminant (tile program, P1-S1). Absent ⇒ terminal — an old
   * cache or an old binary that never wrote this field degrades to a plain
   * terminal pane. `kind` is the SOLE discriminant; `agentId` is never
   * overloaded with "conversation". Conversation panes persist the inert
   * carrier `agentId: "terminal"` so a downgraded binary renders a harmless
   * terminal pane (its `From<String>` catch-all never sees "conversation").
   */
  kind?: "terminal" | "conversation" | "file";
  /**
   * Set iff `kind === "conversation"`. Points at the owning AgentConversation
   * (reference direction is pane→conversationId only). Enforced by
   * `normalizePanes`: a conversation pane whose id was stripped self-heals to a
   * terminal pane.
   */
  conversationId?: string;
  /**
   * Multi-account CLI support: the `CliAccount.id` this pane launches under.
   * Absent ⇒ ambient login — exactly today's behaviour, and what an old cache
   * or an old binary that never wrote the field degrades to. Only meaningful
   * for the `claude-code` / `codex` slots; the runtime translates it into
   * `CLAUDE_CONFIG_DIR` / `CODEX_HOME`. Same inert `#[serde(default)]`
   * round-trip pattern as `kind`/`conversationId`.
   */
  accountId?: string;
  /** Per-pane raw local Terminal shell override. Absent means inherit. */
  terminalShell?: TerminalShellSelection;
  /**
   * Set iff `kind === "file"`. The absolute path this viewer tile shows.
   * Enforced by `normalizePanes` the same way `conversationId` is: a file pane
   * whose path was stripped self-heals to a terminal pane, so an old binary
   * round-trip degrades cleanly instead of rendering an empty viewer.
   */
  filePath?: string;
  /**
   * Initial view mode for a file pane. Absent ⇒ the editor's per-extension
   * default (markdown renders, everything else opens raw). The "Markdown
   * Viewer" picker row is exactly this field set to `"preview"`.
   */
  fileView?: "preview" | "raw";
}

export interface Workspace {
  id: string;
  name: string;
  agents: WorkspaceAgentSlot[];
  panes: WorkspacePane[];
  projectPath: string;
  prompt?: string;
  createdAt: number;
  updatedAt: number;
  status: "active" | "archived";
  bypassPermissions?: boolean;
  modelOverrides?: Record<string, string | null>;
  effortOverrides?: Record<string, string | null>;
  serverId?: string;
  remoteProjectPath?: string;
  executionTarget?: ExecutionTargetRef;
  /**
   * v0.8-15: auto-bound GitHub repo, derived from `git remote get-url
   * origin` at workspace-creation time. Absent for workspaces whose
   * project path is not a GitHub-backed git repo. Used by the
   * `WorkspaceSidebar` badge and (eventually) the GitHub pane's
   * repo-context picker.
   */
  githubRepo?: { owner: string; repo: string };
  /**
   * Tile program (P1-S2): origin marker for auto-materialized conversation
   * wrappers. `"conversation"` tags a workspace created by
   * `sessionGlue.openSession` (deterministic id `ws-wrap-<convId>`) to wrap a
   * standalone conversation; absent for normal user-created workspaces. Round-
   * trips through the DTO via the same `#[serde(default)]` inert pattern as the
   * pane-level `kind`/`conversationId`, so an old binary that drops it degrades
   * cleanly. The reconciliation sweep uses it to identify orphaned wrappers
   * whose conversation pane was stripped by an old-binary re-save.
   */
  origin?: "conversation";
  /** Raw local Terminal default for this workspace. Absent means app default. */
  terminalShell?: TerminalShellSelection;
  /**
   * The user's hand-arranged mosaic tile layout. Absent ⇒ build from the
   * pane-count preset, which is what every session did before this field
   * existed and what an old cache or binary that drops it degrades to.
   *
   * It is a CACHE of an arrangement, never the source of truth for which panes
   * exist — `panes` is. `WorkspaceMosaicContainer` reconciles the saved leaves
   * against the real pane list on load (pruning leaves whose pane is gone,
   * appending panes the layout never saw), so a stale tree can neither render
   * a pane twice nor lose one.
   */
  layout?: MosaicNode<string>;
}

/** Compatibility normalizer for workspaces persisted before tagged targets.
 * Also tolerates targets of an unknown kind (e.g. `"syndicate"`, written
 * before that integration was removed) by falling back to the legacy fields. */
export function executionTargetForWorkspace(workspace: Workspace): ExecutionTargetRef {
  const target = workspace.executionTarget;
  if (target && (target.kind === "local" || target.kind === "ssh")) return target;
  return workspace.serverId
    ? { kind: "ssh", serverId: workspace.serverId }
    : { kind: "local" };
}

export function isSshWorkspace(workspace: Workspace | undefined | null): boolean {
  return !!workspace && executionTargetForWorkspace(workspace).kind === "ssh";
}

/** True only when it is safe to use workspace.projectPath on this workstation. */
export function isLocalWorkspace(workspace: Workspace | undefined | null): boolean {
  return !!workspace && executionTargetForWorkspace(workspace).kind === "local";
}
