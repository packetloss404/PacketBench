import {
  useAgentTaskStore,
  type AgentCli,
  type AgentSshConfigInput,
} from "@/stores/agentTaskStore";
import { requestConversationSave } from "@/stores/agentConversationPersistence";
import { useProjectHistoryStore } from "@/stores/projectHistoryStore";
import { useServerStore } from "@/stores/serverStore";
import { LAUNCH_DRAFT_KEY, useAgentDraftStore } from "@/stores/agentDraftStore";
import { getDefaultModel } from "@/lib/api-models";
import { createConversationWorktree, getGitBranch, type ImageAttachment } from "@/lib/tauri";
import { generateId } from "@/lib/storage";
import { isSshUri, parseSshUri } from "@/lib/ssh-uri";
import type { AgentMode, ComposerMode } from "@/components/agents/composer/utils";
import type { ModeFlags } from "@/components/agents/agentModeChipUtils";
import type { AgentProfile } from "@/types/profiles";
import type { AgentConversation, PermissionMode } from "@/types/agent-conversation";

/** Inputs the AgentsView launcher captures and hands to `launchConversation`.
 * Extracted verbatim from `AgentsView.handleLaunch` so the launch flow —
 * profile/model resolution, SSH parsing, worktree provisioning, and the
 * `createApiConversation` dispatch — lives in one testable place. AgentsView
 * now only resolves these values and delegates; behavior is identical. */
export interface LaunchConversationParams {
  rawText: string;
  attachments: ImageAttachment[];
  selectedRepo: string | null;
  selectedAgent: AgentCli;
  selectedModel: string;
  /** The four launcher mode buttons (agent | ask | manual | plan). */
  agentMode: AgentMode;
  /** local vs worktree launch (Settings-level toggle). */
  composerMode: ComposerMode;
  /** The launcher profile AgentsView resolved via `profileStore.getProfile`. */
  profile: AgentProfile | undefined;
  setLaunchError: (message: string | null) => void;
  /**
   * Tile program (P3-S4): explicit launch posture. When supplied (the draft
   * tile's capability-filtered mode chip resolves it via `flagsForMode`) it
   * REPLACES the coarse `agentMode`→posture derivation below, so the full
   * PermissionMode range (incl. deny_all / allow_all, which the four launcher
   * buttons can't express) survives to `createApiConversation`. Omitted by the
   * AgentsView launcher → behavior byte-identical.
   */
  postureOverride?: ModeFlags;
  /**
   * Called after the durable conversation record exists. Unlike
   * `onLaunched`, this callback is presentation-neutral and must not place a
   * pane; the first-class Agents surface uses it only for content-free WA4
   * dogfood evidence.
   */
  onCreated?: (conversationId: string) => void;
  /**
   * Tile program (P3-S4): invoked with the new conversation id the moment
   * `createApiConversation` resolves — i.e. after the conversation exists in
   * agentTaskStore but as the async backend start settles. The draft tile uses
   * it to materialize the real conversation pane (created-before-insert) and
   * retire the draft. Omitted by the AgentsView launcher.
   */
  onLaunched?: (conversationId: string) => void;
  /** F4: report launch progress so the UI can show Preparing → Starting →
   * Running instead of a single opaque Launch click. */
  onPhase?: (phase: LaunchPhase) => void;
}

/** Coarse, honest launch progress. `running` fires once the conversation is
 * materialized and its backend turn dispatched. */
export type LaunchPhase = "preparing" | "starting" | "running" | "failed";

/**
 * F1/F4: `createApiConversation` persists the conversation record even when the
 * backend rejects the start — it marks that record `failed` (see `failTurn`)
 * and still resolves with its id. A caller that treated any resolved id as a
 * successful launch would show "Running…" and clear the user's draft for a
 * turn that never started. Detect the failed/absent record so the launcher can
 * report the failure and keep the draft and staged attachments for a retry.
 */
function backendStartFailed(conversationId: string): boolean {
  const conversation = useAgentTaskStore
    .getState()
    .conversations.find((c) => c.id === conversationId);
  return !conversation || conversation.status === "failed";
}

/**
 * Launch an API conversation from the Agents launcher. Returns `false` for the
 * synchronous guard failures (empty text, no repo, unresolved SSH target), and
 * a promise settling `true`/`false` for a dispatched launch so callers can keep
 * the draft and staged attachments until the outcome is known.
 *
 * tile-program D: when launched in worktree mode, the worktree provenance —
 * including the `baseBranch` that was previously computed then discarded — is
 * stamped onto the conversation's `worktree` field so later phases can land or
 * discard it. A provisioning failure is fail-closed (F1): nothing is launched,
 * no conversation is created and no root-checkout fallback occurs. The user's
 * prompt/attachments stay intact for a retry or an explicit Local launch.
 */
export function launchConversation({
  rawText,
  attachments,
  selectedRepo,
  selectedAgent,
  selectedModel,
  agentMode,
  composerMode,
  profile,
  setLaunchError,
  postureOverride,
  onCreated,
  onLaunched,
  onPhase,
}: LaunchConversationParams): boolean | Promise<boolean> {
  const text = rawText.trim();
  if (!text) return false;
  if (!selectedRepo) return false;

  const createApiConversation = useAgentTaskStore.getState().createApiConversation;

  // Profile contributes the system prompt + tool whitelist + memory flag.
  // Mode (the four launcher buttons) wins for plan/permission posture so
  // users can override a profile's defaults per-launch.
  const systemPrompt: string | null =
    profile && profile.systemPrompt.length > 0 ? profile.systemPrompt : null;
  const allowedTools: string[] | null = profile?.allowedTools ?? null;
  // Memory is on by default for user-initiated launches; a profile can still
  // disable it, and the per-conversation toggle can turn it off after launch.
  const memoryContextEnabled = profile?.memoryContextEnabled ?? true;

  // B9: profile.pinnedModel overrides the launcher selection so the
  // launcher's auto-pick or default doesn't silently switch a known-
  // good model out from under a Reviewer / Scout / pinned profile.
  const model = profile?.pinnedModel || selectedModel || getDefaultModel(selectedAgent);

  // `getDefaultModel` answers `""` for any row with no bundled models, and that
  // empty string used to travel all the way to the backend, where it becomes a
  // request that names no model and a vendor 400 mentioning nothing the user
  // did. With model lists now arriving asynchronously this stopped being a
  // corner case: a launch fired before the first enumeration lands hits it
  // directly. Fail loudly through the launcher's own error channel instead.
  if (!model) {
    setLaunchError(
      "No model selected for this provider yet — pick one (or type a model id) in the model picker.",
    );
    return false;
  }

  // Mode -> planMode + launch-time permission posture (mode overrides profile).
  // When the caller supplies an explicit `postureOverride` (draft tile), it
  // wins over the coarse agentMode mapping and can express the full
  // PermissionMode range.
  const planMode = postureOverride
    ? postureOverride.planMode
    : agentMode === "ask" || agentMode === "plan";
  const launchPermissionMode: PermissionMode = postureOverride
    ? postureOverride.permissionMode
    : agentMode === "manual"
      ? "ask_for_risky"
      : "auto";
  const launchApproveWrites = postureOverride ? postureOverride.approveWrites : false;
  // Plan mode alone drives planning: the backend plan-mode posture keeps
  // the agent read-only and the inline PlanModeApprovalMenu carries the
  // approval when the plan lands.
  const initialMessage = text;

  const att = attachments.length > 0 ? attachments : null;
  let sshProjectPath: string | null = null;
  let sshTarget: AgentSshConfigInput | null = null;

  if (isSshUri(selectedRepo)) {
    const parsed = parseSshUri(selectedRepo);
    const server = parsed ? useServerStore.getState().getServer(parsed.serverId) : undefined;
    if (!parsed || !server) {
      setLaunchError("SSH server no longer exists. Pick another from the project dropdown.");
      return false;
    }
    // Per-session remote path comes from the URI (edited inline in
    // AgentInputArea), falling back to the server-level default.
    const remotePath =
      (parsed.remotePath && parsed.remotePath.trim().length > 0
        ? parsed.remotePath.trim()
        : server.remotePath?.trim()) ?? "";
    if (!remotePath) {
      setLaunchError("Enter a remote project path for this SSH server before launching.");
      return false;
    }
    sshProjectPath = remotePath;
    sshTarget = {
      serverId: server.id,
      name: server.name,
      host: server.host,
      port: server.port,
      user: server.username,
      remotePath,
      keyPath: server.keyPath ?? null,
      authMethod: server.authMethod,
      hostFingerprint: server.hostFingerprint ?? null,
    };
  }

  setLaunchError(null);
  return (async () => {
    try {
      onPhase?.("preparing");
      if (sshTarget && sshProjectPath) {
        // Stamp lastConnectedAt so the recents ordering reflects use.
        useServerStore.getState().updateServer(sshTarget.serverId, {
          lastConnectedAt: Date.now(),
        });
        const convId = await createApiConversation({
          agent: selectedAgent,
          projectPath: sshProjectPath,
          model,
          initialMessage,
          systemPromptOverride: systemPrompt,
          planMode,
          sshTarget,
          skipBackendStart: false,
          allowedTools,
          memoryContextEnabled,
          attachments: att,
          permissionMode: launchPermissionMode,
          approveWrites: launchApproveWrites,
          selectOnCreate: false,
        });
        // F4: a backend start rejection resolves with the conversation id but
        // leaves the record `failed`. Report the failure and retain the draft
        // instead of claiming a turn is running.
        if (backendStartFailed(convId)) {
          setLaunchError(
            "The agent session failed to start. Your draft and attachments are " +
              "preserved — retry, or check the provider configuration.",
          );
          onPhase?.("failed");
          return false;
        }
        onCreated?.(convId);
        // P3-S4: materialize the draft's pane now that the conversation exists.
        onLaunched?.(convId);
        onPhase?.("running");
        // F4: only take the selection if the user didn't navigate to another
        // conversation while this launch was preparing.
        if (useAgentTaskStore.getState().selectedConversationId === null) {
          useAgentTaskStore.getState().selectConversation(convId);
        }
      } else {
        // T3.F: when worktree mode is on, provision a fresh worktree at
        // <projectPath>/.pkt-worktrees/<convId> on a new pkt/<convId>
        // branch off the current HEAD. The conversation then runs inside
        // the worktree so its tool calls don't touch the main checkout.
        let effectiveProjectPath = selectedRepo;
        let explicitConvId: string | undefined;
        // tile-program D: retain the worktree provenance so it can be
        // stamped onto the conversation (the unlandable-work fix). Null
        // when not in worktree mode; provisioning failure aborts the launch.
        let worktreeMeta: NonNullable<AgentConversation["worktree"]> | null = null;
        if (composerMode === "worktree") {
          const provisionalConvId = generateId("conv");
          try {
            const branch = await getGitBranch(selectedRepo).catch(() => "");
            const baseBranch = branch && branch.length > 0 ? branch : "HEAD";
            const wtPath = await createConversationWorktree(
              selectedRepo,
              provisionalConvId,
              baseBranch,
            );
            effectiveProjectPath = wtPath;
            explicitConvId = provisionalConvId;
            worktreeMeta = {
              basePath: selectedRepo,
              worktreePath: wtPath,
              branch: `pkt/${provisionalConvId}`,
              baseBranch,
              createdAt: Date.now(),
              state: "active",
            };
          } catch (e) {
            // F1: fail closed. The user picked "worktree" precisely so the
            // agent could not touch the main checkout; silently running in the
            // project root is the one outcome they were guarding against.
            // Start nothing, create no conversation, and keep the draft and
            // staged attachments so the user can retry or explicitly choose
            // Local mode.
            const reason = e instanceof Error ? e.message : String(e);
            console.warn("Worktree provisioning failed; launch aborted:", e);
            setLaunchError(
              `Worktree provisioning failed — nothing was launched. ` +
                `Retry, or switch execution mode to Local to run in the project checkout. ${reason}`,
            );
            onPhase?.("failed");
            return false;
          }
        }

        const convId = await createApiConversation({
          agent: selectedAgent,
          projectPath: effectiveProjectPath,
          model,
          initialMessage,
          systemPromptOverride: systemPrompt,
          planMode,
          sshTarget: null,
          explicitId: explicitConvId,
          skipBackendStart: false,
          allowedTools,
          memoryContextEnabled,
          attachments: att,
          permissionMode: launchPermissionMode,
          approveWrites: launchApproveWrites,
          selectOnCreate: false,
        });

        // tile-program D: stamp the worktree provenance at provisioning.
        // createApiConversation returns after the conversation exists in the
        // store (even if the backend start rejected), so patching it here and
        // requesting a save persists the field on the next debounced write.
        if (worktreeMeta) {
          const meta = worktreeMeta;
          useAgentTaskStore.setState((s) => ({
            conversations: s.conversations.map((c) =>
              c.id === convId ? { ...c, worktree: meta } : c,
            ),
          }));
          requestConversationSave(convId);
        }
        // F4: a backend start rejection resolves with the conversation id but
        // leaves the record `failed`. Report the failure and retain the draft
        // instead of claiming a turn is running.
        if (backendStartFailed(convId)) {
          setLaunchError(
            "The agent session failed to start. Your draft and attachments are " +
              "preserved — retry, or check the provider configuration.",
          );
          onPhase?.("failed");
          return false;
        }
        useProjectHistoryStore.getState().recordOpen(selectedRepo);
        onPhase?.("starting");
        onCreated?.(convId);
        // P3-S4: materialize the draft's pane now that the conversation exists.
        onLaunched?.(convId);
        onPhase?.("running");
        // F4: only take the selection if the user didn't navigate to another
        // conversation while this launch was preparing.
        if (useAgentTaskStore.getState().selectedConversationId === null) {
          useAgentTaskStore.getState().selectConversation(convId);
        }
      }
      // Clear the composer only once the launch actually succeeded, so a
      // failed launch keeps the user's typed prompt intact for a retry.
      useAgentDraftStore.getState().clearDraft(LAUNCH_DRAFT_KEY);
      return true;
    } catch (e) {
      setLaunchError(e instanceof Error ? e.message : "Failed to launch agent.");
      onPhase?.("failed");
      return false;
    }
  })();
}
