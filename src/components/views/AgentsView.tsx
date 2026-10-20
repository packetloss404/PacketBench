import { useCallback, useEffect, useRef, useState } from "react";
import { Bot, X } from "lucide-react";
import { authProbeProvider, useAgentTaskStore, type AgentCli } from "@/stores/agentTaskStore";
import { useAgentSettingsStore } from "@/stores/agentSettingsStore";
import { useProfileStore } from "@/stores/profileStore";
import { launchConversation } from "@/lib/launchConversation";
import { API_PROVIDERS, DEFAULT_API_AGENT, getDefaultModel } from "@/lib/api-models";
import { getProviderAuthStatus, type ImageAttachment } from "@/lib/tauri";
import { AgentSidebar } from "@/components/agents/AgentSidebar";
import { AgentChatPane } from "@/components/agents/AgentChatPane";
import { AgentInspectorPane } from "@/components/agents/AgentInspectorPane";
import { AgentsOnboarding } from "@/components/agents/AgentsOnboarding";
import { Composer } from "@/components/agents/composer/Composer";
import { ErrorBoundary } from "@/components/ui/ErrorBoundary";
import type { AgentMode, ComposerMode } from "@/components/agents/composer/utils";
import {
  recordWorkspaceAgentsEvent,
  useWorkspaceAgentsDogfoodStore,
} from "@/stores/workspaceAgentsDogfoodStore";

// Prefer Sugar when connected; otherwise use the first ready API provider.
// Probed via `authProbeProvider`, so every entry is an API-key check.
const AUTO_PICK_ORDER: AgentCli[] = [
  DEFAULT_API_AGENT,
  "api-claude-oauth",
  "api-claude",
  "api-openai",
  "api-openai-agents",
  "api-openrouter",
  "api-ollama",
  "api-minimax",
  ...API_PROVIDERS.map((p) => p.agentCli).filter(
    (id) =>
      ![
        DEFAULT_API_AGENT,
        "api-claude-oauth",
        "api-claude",
        "api-openai",
        "api-openai-agents",
        "api-openrouter",
        "api-ollama",
        "api-minimax",
      ].includes(id),
  ),
];

const DEFAULT_AGENT = DEFAULT_API_AGENT;
const DEFAULT_MODEL = getDefaultModel(DEFAULT_API_AGENT);

export interface AgentsViewProps {
  /**
   * Pin the launch composer to ONE provider instead of auto-picking the first
   * credentialed one. Set by provider-scoped routes (see `PacketCodeView`);
   * `undefined` keeps the historical behaviour exactly.
   */
  pinnedAgent?: AgentCli;
  /** Model preselected alongside `pinnedAgent`. Ignored when unpinned. */
  pinnedModel?: string;
}

export function AgentsView({ pinnedAgent, pinnedModel }: AgentsViewProps = {}) {
  const selectedRepo = useAgentTaskStore((state) => state.selectedRepo);
  const selectedConversationId = useAgentTaskStore((state) => state.selectedConversationId);
  const selectConversation = useAgentTaskStore((state) => state.selectConversation);

  const [selectedAgent, setSelectedAgent] = useState<AgentCli>(pinnedAgent ?? DEFAULT_AGENT);
  const [selectedModel, setSelectedModel] = useState(pinnedModel ?? DEFAULT_MODEL);
  const [agentMode, setAgentMode] = useState<AgentMode>("agent");
  const [launchError, setLaunchError] = useState<string | null>(null);
  const defaultProfileId = useProfileStore((state) => state.defaultProfileId);
  const getProfile = useProfileStore((state) => state.getProfile);
  const [selectedProfileId, setSelectedProfileId] = useState(defaultProfileId);
  const composerMode = useAgentSettingsStore((state) => state.composerMode) as ComposerMode;
  const setComposerMode = useAgentSettingsStore((state) => state.setComposerMode);
  const userPickedProfile = useRef(false);
  const userInteractedRef = useRef(false);
  const autoPickStarted = useRef(false);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const recordVisibleConversations = useWorkspaceAgentsDogfoodStore(
    (state) => state.recordVisibleConversations,
  );

  useEffect(() => {
    recordVisibleConversations(selectedConversationId ? 1 : 0);
  }, [recordVisibleConversations, selectedConversationId]);

  useEffect(() => {
    if (!userPickedProfile.current) setSelectedProfileId(defaultProfileId);
  }, [defaultProfileId]);

  useEffect(() => {
    if (selectedConversationId) return;
    const frame = requestAnimationFrame(() => textareaRef.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [selectedConversationId]);

  useEffect(() => {
    // A pinned provider is the caller's explicit choice — never override it
    // with the credential auto-pick.
    if (pinnedAgent || autoPickStarted.current || selectedConversationId) return;
    autoPickStarted.current = true;
    let cancelled = false;
    void Promise.all(
      AUTO_PICK_ORDER.map(async (agent) => {
        try {
          return {
            agent,
            status: await getProviderAuthStatus(authProbeProvider(agent)),
          };
        } catch {
          return null;
        }
      }),
    ).then((results) => {
      if (cancelled) return;
      // F4: a late probe result must never overwrite an explicit choice the
      // user made while it was in flight.
      if (userInteractedRef.current) return;
      const ready = results.find((result) => result?.status.status === "ready");
      if (!ready) return;
      setSelectedAgent(ready.agent);
      // Clear a previous provider's model even when this provider has no bundled rows.
      setSelectedModel(getDefaultModel(ready.agent));
    });
    return () => {
      cancelled = true;
    };
  }, [pinnedAgent, selectedConversationId]);

  const handleNewAgent = useCallback(() => {
    selectConversation(null);
  }, [selectConversation]);

  const handleProfileChange = useCallback((profileId: string) => {
    userPickedProfile.current = true;
    userInteractedRef.current = true;
    setSelectedProfileId(profileId);
  }, []);

  const handleLaunch = useCallback(
    (rawText: string, attachments: ImageAttachment[]) =>
      launchConversation({
        rawText,
        attachments,
        selectedRepo,
        selectedAgent,
        selectedModel,
        agentMode,
        composerMode,
        profile: getProfile(selectedProfileId),
        setLaunchError,
        onCreated: () => recordWorkspaceAgentsEvent("agent_started_agents"),
      }),
    [
      agentMode,
      composerMode,
      getProfile,
      selectedAgent,
      selectedModel,
      selectedProfileId,
      selectedRepo,
    ],
  );

  return (
    <div className="relative flex flex-1 overflow-hidden bg-bg-primary">
      <AgentSidebar
        selectedId={selectedConversationId}
        onSelect={selectConversation}
        onNewAgent={handleNewAgent}
      />

      {selectedConversationId ? (
        <>
          <ErrorBoundary fallbackMessage="This conversation encountered an error.">
            <AgentChatPane
              conversationId={selectedConversationId}
              onClose={handleNewAgent}
              // The Agents dock is a sibling of this pane, so its header owns
              // the toggle. (Workspace tiles omit this — see AgentChatPane.)
              dockSurface="agents"
            />
          </ErrorBoundary>
          <ErrorBoundary fallbackMessage="The agent inspector encountered an error.">
            <AgentInspectorPane conversationId={selectedConversationId} />
          </ErrorBoundary>
        </>
      ) : (
        <div className="flex flex-1 flex-col overflow-hidden">
          <div className="flex shrink-0 items-center gap-2 border-b border-bg-border bg-bg-secondary px-4 py-2">
            <Bot size={14} className="text-accent-green" />
            <div className="flex flex-col">
              <span className="text-ui font-semibold text-text-primary">New agent</span>
              <span className="text-meta text-text-muted">
                Choose a project, provider, model, and execution posture.
              </span>
            </div>
          </div>
          <Composer
            variant="launch"
            textareaRef={textareaRef}
            selectedAgent={selectedAgent}
            onAgentChange={(agent) => {
              userInteractedRef.current = true;
              setSelectedAgent(agent);
            }}
            onLaunch={handleLaunch}
            selectedModel={selectedModel}
            onModelChange={(model) => {
              userInteractedRef.current = true;
              setSelectedModel(model);
            }}
            agentMode={agentMode}
            onAgentModeChange={setAgentMode}
            selectedProfileId={selectedProfileId}
            onProfileChange={handleProfileChange}
            composerMode={composerMode}
            onComposerModeChange={setComposerMode}
          />
        </div>
      )}

      {launchError && (
        <div
          role="alert"
          aria-live="assertive"
          className="absolute bottom-4 left-1/2 z-40 flex max-w-[480px] -translate-x-1/2 items-start gap-2 rounded border border-accent-red/30 bg-bg-elevated px-3 py-2 text-[11px] text-accent-red shadow-lg"
        >
          <span className="flex-1">{launchError}</span>
          <button
            type="button"
            onClick={() => setLaunchError(null)}
            className="transition-colors hover:text-text-primary"
            title="Dismiss launch error"
            aria-label="Dismiss launch error"
          >
            <X size={12} />
          </button>
        </div>
      )}

      <AgentsOnboarding />
    </div>
  );
}
