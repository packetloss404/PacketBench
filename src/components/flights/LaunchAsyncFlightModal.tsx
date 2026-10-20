import { useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  GitPullRequest,
  Route,
  Loader2,
  Rocket,
  ShieldAlert,
  ShieldCheck,
  Sparkles,
} from "lucide-react";
import { Modal } from "@/components/ui/Modal";
import { useAppStore } from "@/stores/appStore";
import { useFlightStore } from "@/stores/flightStore";
import {
  findAsyncLaunchPathCollisions,
  formatAsyncLaunchPathCollisionMessage,
  useAsyncFlightStore,
} from "@/stores/asyncFlightStore";
import { useGitHubStore } from "@/stores/githubStore";
import { useWorkspaceStore } from "@/stores/workspaceStore";
import { useServerStore } from "@/stores/serverStore";
import { useIssueStore } from "@/stores/issueStore";
import { useLayoutStore } from "@/stores/layoutStore";
import { useAgentTaskStore, type AgentCli } from "@/stores/agentTaskStore";
import { requestConversationSave } from "@/stores/agentConversationPersistence";
import { openConversationInAgents } from "@/stores/sessionGlue";
import {
  buildFlightPlanningSystemPrompt,
  FLIGHT_PLANNING_ALLOWED_TOOLS,
} from "@/lib/flightPlanning";
import { useMemoryStore } from "@/stores/memoryStore";
import { useOrchestrationSettingsStore } from "@/stores/orchestrationSettingsStore";
import { selectRecurringErrorHint } from "@/lib/recurringErrorHint";
import { resolveInitialPublishAsPrs, summarizeLaunchOutcome } from "@/lib/flightLaunch";
import { MultiTargetPicker, type PickedTarget } from "./MultiTargetPicker";
import { pickedToSpec } from "./pickedToSpec";
import { FlightAgentPicker } from "./FlightAgentPicker";
import {
  flightContextFromWorkspace,
  initialFlightTargets,
  type FlightLaunchContext,
} from "@/lib/flightLaunchContext";
import { linkConversationToFlight } from "@/lib/agentHandoffs";
import type {
  AutonomyFlightMode,
  AutonomyPolicy,
  AutonomyRuntime,
  FlightPriority,
} from "@/types/flight";
import { getDefaultModel } from "@/lib/api-models";
import { pathWithinAllowedRoots, validateAutonomyPolicy } from "@/lib/autonomyPolicy";
import { APP_NAME } from "@/lib/brand";
import { attemptHasActiveWork, projectFlightLifecycle } from "@/lib/flightLifecycle";
import { generateId } from "@/lib/storage";
import { registerFlightStartup } from "@/lib/flightRunControl";

interface LaunchAsyncFlightModalProps {
  onClose: () => void;
  onLaunched?: (flightId: string) => void;
  // When set, launch attempts into this existing flight instead of minting a
  // new one (e.g. "Launch attempt" from an already-staged flight's detail
  // pane, or GitHub's "Plan flight" hand-off). The prompt/title fields are
  // pre-filled from the flight's objective/title but remain editable.
  flightId?: string;
  initialContext?: FlightLaunchContext;
}

export function LaunchAsyncFlightModal({
  onClose,
  onLaunched,
  flightId,
  initialContext,
}: LaunchAsyncFlightModalProps) {
  const addFlight = useFlightStore((s) => s.addFlight);
  const updateFlight = useFlightStore((s) => s.updateFlight);
  const flushFlightPersistence = useFlightStore((s) => s.flushPersistence);
  const flights = useFlightStore((s) => s.flights);
  const launchAsync = useAsyncFlightStore((s) => s.launchAsync);
  const workspaces = useWorkspaceStore((s) => s.workspaces);
  const servers = useServerStore((s) => s.servers);
  const [forceNew, setForceNew] = useState(false);
  const [createdFlightId, setCreatedFlightId] = useState<string | null>(null);
  const requestedFlightId =
    createdFlightId || (!forceNew ? flightId || initialContext?.flightId : undefined);
  const activeWorkspace = useWorkspaceStore((s) =>
    s.workspaces.find((w) => w.id === s.activeWorkspaceId),
  );
  const projectPath = useLayoutStore((s) => s.projectPath);
  const setActiveView = useAppStore((s) => s.setActiveView);
  // v0.8: pre-check the publish toggle if the user opted into that default
  // via Settings → GitHub.
  const defaultPublishAttemptsAsPrs = useGitHubStore((s) => s.defaultPublishAttemptsAsPrs);
  const autonomyDefaultMode = useOrchestrationSettingsStore((s) => s.autonomyDefaultMode);
  const autonomyDefaultPolicy = useOrchestrationSettingsStore((s) => s.autonomyDefaultPolicy);

  const existingFlight = useMemo(
    () => (requestedFlightId ? (flights.find((f) => f.id === requestedFlightId) ?? null) : null),
    [requestedFlightId, flights],
  );
  const planningConversationExists = useAgentTaskStore((state) =>
    existingFlight?.planningConversationId
      ? state.conversations.some((item) => item.id === existingFlight.planningConversationId)
      : false,
  );

  const [prompt, setPrompt] = useState(
    () => initialContext?.objective ?? existingFlight?.objective ?? "",
  );
  const [title, setTitle] = useState(() => initialContext?.title ?? existingFlight?.title ?? "");
  const [picked, setPicked] = useState<PickedTarget[]>(() =>
    initialFlightTargets(
      {
        ...(activeWorkspace ? flightContextFromWorkspace(activeWorkspace) : { projectPath }),
        ...(existingFlight
          ? {
              projectPath: existingFlight.executionTarget?.basePath || existingFlight.projectPath,
              workspaceId: existingFlight.workspaceId,
              serverId: existingFlight.executionTarget
                ? existingFlight.executionTarget.serverId
                : existingFlight.attempts?.[0]?.target.kind === "ssh"
                  ? existingFlight.attempts[0].target.serverId
                  : undefined,
              baseBranch: existingFlight.gitBranch || existingFlight.attempts?.[0]?.baseBranch,
            }
          : {}),
        ...initialContext,
      },
      workspaces,
      servers,
    ),
  );
  const [targetErrors, setTargetErrors] = useState<string[]>([
    "Checking repository and API access…",
  ]);
  const [reviewerError, setReviewerError] = useState<string | null>(
    "Checking reviewer API access…",
  );
  const [intent, setIntent] = useState<"single" | "compare" | "cooperative">(
    existingFlight?.executionMode === "cooperative" ? "cooperative" : "single",
  );
  const [advanced, setAdvanced] = useState(false);
  const [launching, setLaunching] = useState(false);
  const [pendingFlightId, setPendingFlightId] = useState<string | null>(null);
  const [stopping, setStopping] = useState(false);
  const launchAllowed = useRef(true);
  const [planning, setPlanning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // v0.8-G: per-attempt draft-PR publish toggle. When enabled, the
  // asyncFlightStore pipeline pushes each attempt's branch and opens a
  // draft GitHub PR once it reaches a terminal state.
  // The flight's own setting wins, exactly like every sibling field below.
  // Seeding from the global default alone meant re-opening this modal to add an
  // attempt silently rewrote `publishAttemptsAsPrs` on save (`createOrUpdateFlight`).
  const [publishAsPrs, setPublishAsPrs] = useState(() =>
    existingFlight?.executionMode === "cooperative"
      ? false
      : resolveInitialPublishAsPrs(existingFlight, defaultPublishAttemptsAsPrs),
  );
  const perAttemptPublishing =
    intent !== "cooperative" && existingFlight?.executionMode !== "cooperative" && publishAsPrs;
  const [reviewerEnabled, setReviewerEnabled] = useState(
    existingFlight?.reviewGatePolicy?.enabled ?? false,
  );
  const [reviewerAgent, setReviewerAgent] = useState<AgentCli>(
    (existingFlight?.reviewGatePolicy?.reviewerAgentConfigId as AgentCli | undefined) ??
      "api-openai-agents",
  );
  const [reviewerModel, setReviewerModel] = useState(
    existingFlight?.reviewGatePolicy?.reviewerModel ?? getDefaultModel("api-openai-agents"),
  );
  const [acceptanceCriteria, setAcceptanceCriteria] = useState(
    initialContext?.acceptanceCriteria?.join("\n") ??
      existingFlight?.reviewGatePolicy?.acceptanceCriteria.join("\n") ??
      "",
  );
  const [autonomyMode, setAutonomyMode] = useState<AutonomyFlightMode>(
    existingFlight?.autonomyMode ?? "assisted",
  );

  const promptShort = useMemo(
    () => (prompt.length > 60 ? prompt.slice(0, 57) + "…" : prompt),
    [prompt],
  );

  // M6: "this looks familiar" — warn when the prompt overlaps a known pitfall
  // pattern or a lesson that has recurred across prior flights.
  const memoryPatterns = useMemoryStore((s) => s.patterns);
  const memoryEvents = useMemoryStore((s) => s.events);
  const recurringHint = useMemo(
    () => selectRecurringErrorHint(prompt, memoryPatterns, memoryEvents),
    [prompt, memoryPatterns, memoryEvents],
  );

  const targetSpecs = useMemo(() => picked.map(pickedToSpec), [picked]);
  const launchCollisions = useMemo(
    () => findAsyncLaunchPathCollisions(existingFlight?.id ?? null, targetSpecs, flights),
    [existingFlight, flights, targetSpecs],
  );
  const collisionMessage = useMemo(
    () =>
      launchCollisions.length > 0 ? formatAsyncLaunchPathCollisionMessage(launchCollisions) : null,
    [launchCollisions],
  );

  // #8a: block launches that target SSH servers without a pinned host key.
  // Without a fingerprint the backend falls back to StrictHostKeyChecking=
  // accept-new (TOFU), which is MITM-able on first connect. Mirror the gate
  // in WorkspaceCreationModal (same `!server.hostFingerprint` falsy check —
  // hostFingerprint is `string | undefined`). The realistic trigger is
  // legacy-migrated servers that predate fingerprint capture. Local targets
  // stay launchable; only unpinned SSH picks block.
  const unpinnedTargets = useMemo(
    () => picked.filter((p) => p.kind === "ssh" && !p.server.hostFingerprint),
    [picked],
  );
  const unpinnedMessage = useMemo(() => {
    if (unpinnedTargets.length === 0) return null;
    const names = unpinnedTargets
      .map((p) => (p.kind === "ssh" ? p.server.name : p.label))
      .join(", ");
    return `Host key not verified for: ${names}. Verify on the Servers page before launching.`;
  }, [unpinnedTargets]);

  const parsedAcceptanceCriteria = useMemo(
    () =>
      acceptanceCriteria
        .split("\n")
        .map((criterion) => criterion.trim())
        .filter(Boolean),
    [acceptanceCriteria],
  );
  const reviewerConfigurationError = !reviewerEnabled
    ? null
    : parsedAcceptanceCriteria.length === 0
      ? "Add at least one acceptance check for the independent reviewer."
      : parsedAcceptanceCriteria.length > 40
        ? "Reviewer Gate supports at most 40 acceptance checks."
        : reviewerError;
  const criteriaError =
    parsedAcceptanceCriteria.length > 40 ||
    parsedAcceptanceCriteria.some((criterion) => criterion.length > 1000)
      ? "Use up to 40 acceptance checks, at most 1,000 characters each."
      : null;
  const phase = existingFlight ? projectFlightLifecycle(existingFlight).phase : null;
  const launchBlocked =
    phase === "delivered" || phase === "archived"
      ? "This Flight is already delivered or archived. Start a new Flight for follow-up work."
      : requestedFlightId && !existingFlight
        ? "This Flight is no longer available. Start a new Flight instead."
        : null;

  const explicitYoloPolicy = useMemo<AutonomyPolicy>(
    () => ({
      ...autonomyDefaultPolicy,
      autoReviewRemediation: autonomyDefaultPolicy.autoReviewRemediation && reviewerEnabled,
      autoRunTaskGraph:
        autonomyDefaultPolicy.autoRunTaskGraph &&
        existingFlight?.executionMode === "cooperative" &&
        reviewerEnabled,
      allowedRoots: Array.from(
        new Set([
          ...autonomyDefaultPolicy.allowedRoots,
          ...picked.map((target) => target.basePath),
          ...(existingFlight?.projectPath ? [existingFlight.projectPath] : []),
        ]),
      ),
      allowedTargets: Array.from(
        new Set([
          ...autonomyDefaultPolicy.allowedTargets,
          ...picked.map((target) => (target.kind === "ssh" ? target.server.id : "local")),
        ]),
      ),
      allowDraftPrPublishing: perAttemptPublishing,
    }),
    [
      autonomyDefaultPolicy,
      existingFlight?.executionMode,
      existingFlight?.projectPath,
      picked,
      perAttemptPublishing,
      reviewerEnabled,
    ],
  );
  const settingsPolicy = autonomyDefaultMode === "yolo" ? autonomyDefaultPolicy : undefined;
  const effectiveAutonomyPolicy =
    autonomyMode === "yolo"
      ? explicitYoloPolicy
      : autonomyMode === "settings_default"
        ? settingsPolicy
        : undefined;
  const autonomyConfigurationError = useMemo(() => {
    if (!effectiveAutonomyPolicy) return null;
    const baseError = validateAutonomyPolicy(effectiveAutonomyPolicy)[0];
    if (baseError) return baseError;
    for (const target of picked) {
      if (!pathWithinAllowedRoots(target.basePath, effectiveAutonomyPolicy.allowedRoots)) {
        return `${target.label} is outside the autonomy root allowlist.`;
      }
      const targetId = target.kind === "ssh" ? target.server.id : "local";
      if (!effectiveAutonomyPolicy.allowedTargets.includes(targetId)) {
        return `${target.label} is outside the autonomy target allowlist.`;
      }
    }
    if (
      effectiveAutonomyPolicy.autoRunTaskGraph &&
      existingFlight?.executionMode !== "cooperative"
    ) {
      return "Auto-run task graph requires a Cooperative Flight.";
    }
    if (effectiveAutonomyPolicy.autoRunTaskGraph && !reviewerEnabled) {
      return "Auto-run task graph requires the independent Reviewer Gate.";
    }
    return null;
  }, [effectiveAutonomyPolicy, existingFlight?.executionMode, picked, reviewerEnabled]);

  function handleOpenServersView() {
    setActiveView("tools");
    onClose();
  }

  const canLaunch =
    prompt.trim().length > 0 &&
    picked.length > 0 &&
    targetErrors.length === 0 &&
    !launchBlocked &&
    !criteriaError &&
    intent !== "cooperative" &&
    launchCollisions.length === 0 &&
    unpinnedTargets.length === 0 &&
    reviewerConfigurationError === null &&
    autonomyConfigurationError === null &&
    !launching &&
    !planning;

  const canOpenExistingPlan = Boolean(
    existingFlight?.planningConversationId && planningConversationExists,
  );
  const canPlan =
    !launchBlocked &&
    !criteriaError &&
    !launching &&
    !planning &&
    (canOpenExistingPlan ||
      (prompt.trim().length > 0 &&
        picked.length > 0 &&
        targetErrors.length === 0 &&
        unpinnedTargets.length === 0));

  function autonomyFields(starting: boolean): {
    autonomyMode: AutonomyFlightMode;
    autonomyPolicy?: AutonomyPolicy;
    autonomyRuntime?: AutonomyRuntime;
  } {
    if (!effectiveAutonomyPolicy) return { autonomyMode };
    const previous = existingFlight?.autonomyRuntime;
    const reusePrevious = previous && previous.status !== "stopped";
    return {
      autonomyMode,
      autonomyPolicy: {
        ...effectiveAutonomyPolicy,
        allowedRoots: [...effectiveAutonomyPolicy.allowedRoots],
        allowedTargets: [...effectiveAutonomyPolicy.allowedTargets],
      },
      autonomyRuntime: reusePrevious
        ? previous
        : {
            status: starting ? "running" : "idle",
            startedAt: starting ? Date.now() : undefined,
            actionHistory: [],
          },
    };
  }

  function createOrUpdateFlight(startingAutonomy = false) {
    if (launchBlocked) throw new Error(launchBlocked);
    const primaryTarget = picked[0];
    const executionTarget = {
      kind: primaryTarget.kind,
      basePath: primaryTarget.basePath,
      ...(primaryTarget.kind === "ssh" ? { serverId: primaryTarget.server.id } : {}),
    };
    const executionPrompt =
      parsedAcceptanceCriteria.length > 0
        ? `${prompt.trim()}\n\nAcceptance checks:\n${parsedAcceptanceCriteria.map((criterion) => `- ${criterion}`).join("\n")}`
        : prompt.trim();
    const reviewGatePolicy =
      reviewerEnabled || parsedAcceptanceCriteria.length > 0
        ? {
            enabled: reviewerEnabled,
            reviewerAgentConfigId: reviewerAgent,
            reviewerModel,
            acceptanceCriteria: parsedAcceptanceCriteria,
          }
        : undefined;
    function linkSource(id: string) {
      if (intent === "cooperative") updateFlight(id, { executionMode: "cooperative" });
      if (initialContext?.issueId) {
        const issue = useIssueStore
          .getState()
          .issues.find((item) => item.id === initialContext.issueId);
        if (!issue)
          throw new Error(
            "The source issue is no longer available. Close this brief and select the task again.",
          );
        useIssueStore.getState().assignToFlight(issue.id, id);
        useFlightStore.getState().addIssueToFlight(id, issue.id);
      }
      if (initialContext?.conversationId) {
        const result = linkConversationToFlight(initialContext.conversationId, id);
        if (!result.ok) throw new Error(result.message);
      }
    }
    if (existingFlight) {
      const updates = {
        title: title.trim() || existingFlight.title,
        objective: prompt.trim(),
        prompt: executionPrompt,
        publishAttemptsAsPrs: perAttemptPublishing,
        reviewGatePolicy,
        ...(!existingFlight.attempts?.length && !existingFlight.integrationBranch
          ? {
              projectPath: primaryTarget.basePath,
              gitBranch: primaryTarget.baseBranch,
              executionTarget,
            }
          : {}),
        ...autonomyFields(startingAutonomy),
      };
      updateFlight(existingFlight.id, updates);
      linkSource(existingFlight.id);
      return { ...existingFlight, ...updates };
    }
    const targetWorkspaceId =
      primaryTarget.kind === "local"
        ? primaryTarget.workspaceId
        : activeWorkspace?.serverId === primaryTarget.server.id
          ? activeWorkspace.id
          : null;
    const created = addFlight({
      title: title.trim() || promptShort || "Untitled flight",
      objective: prompt.trim(),
      priority: "medium" as FlightPriority,
      projectPath: primaryTarget.basePath || activeWorkspace?.projectPath || projectPath || "",
      workspaceId: targetWorkspaceId,
      gitBranch: primaryTarget.baseBranch,
      executionTarget,
      issueIds: [],
      publishAttemptsAsPrs: perAttemptPublishing,
      reviewGatePolicy,
      ...autonomyFields(startingAutonomy),
    });
    setCreatedFlightId(created.id);
    updateFlight(created.id, { prompt: executionPrompt });
    linkSource(created.id);
    return useFlightStore.getState().flights.find((item) => item.id === created.id)!;
  }

  async function handlePlanFirst() {
    if (!canPlan) return;
    launchAllowed.current = true;
    setPlanning(true);
    setError(null);
    let startup: ReturnType<typeof registerFlightStartup> | undefined;
    try {
      const currentConversationId = existingFlight?.planningConversationId;
      if (
        currentConversationId &&
        useAgentTaskStore.getState().conversations.some((item) => item.id === currentConversationId)
      ) {
        openConversationInAgents(currentConversationId);
        onClose();
        return;
      }
      if (picked.length === 0) {
        setError("Select an agent to start a new planning conversation.");
        return;
      }

      const flight = createOrUpdateFlight(false);
      const conversationId = generateId("conv");
      startup = registerFlightStartup(flight.id);
      const isCurrent = () => {
        const current = useFlightStore.getState().flights.find((item) => item.id === flight.id);
        return Boolean(
          startup?.isCurrent() &&
          launchAllowed.current &&
          current &&
          !current.stoppedAt &&
          !current.archivedAt &&
          !current.delivery &&
          current.planningConversationId === conversationId,
        );
      };
      // Register ownership before generic API startup so native admission and
      // Stop can identify the planner even while its startup is pending.
      updateFlight(flight.id, {
        planningConversationId: conversationId,
        linkedSessionIds: Array.from(new Set([...flight.linkedSessionIds, conversationId])),
        prompt: flight.prompt || prompt.trim(),
        status: "planning",
      });
      setPendingFlightId(flight.id);
      await flushFlightPersistence();
      if (!isCurrent())
        throw new Error("Planning was stopped before startup. The Flight brief is retained.");
      const target = picked[0];
      const sshTarget =
        target.kind === "ssh"
          ? {
              serverId: target.server.id,
              name: target.server.name,
              host: target.server.host,
              port: target.server.port,
              user: target.server.username,
              remotePath: target.basePath,
              keyPath: target.server.keyPath ?? null,
              authMethod: target.server.authMethod,
              hostFingerprint: target.server.hostFingerprint ?? null,
            }
          : null;
      await useAgentTaskStore.getState().createApiConversation({
        explicitId: conversationId,
        agent: target.agent,
        projectPath: target.basePath,
        model: target.model,
        initialMessage: `Create an implementation-ready upfront plan for this Flight.\n\nObjective:\n${flight.prompt || prompt.trim()}`,
        systemPromptOverride: buildFlightPlanningSystemPrompt(flight.id),
        planMode: false,
        sshTarget,
        allowedTools: FLIGHT_PLANNING_ALLOWED_TOOLS,
        enabledMcpServerIds: [],
        memoryContextEnabled: true,
        permissionMode: "deny_all",
        approveWrites: false,
      });

      if (!isCurrent()) {
        await useAgentTaskStore.getState().cancelActiveConversation(conversationId);
        throw new Error("Planning stopped. Its conversation and Flight brief are retained.");
      }
      const conversation = useAgentTaskStore
        .getState()
        .conversations.find((item) => item.id === conversationId);
      if (conversation?.status === "failed")
        throw new Error(
          "Planning could not start. Open the retained planning conversation for details, then start a new Flight or retry explicitly.",
        );

      useAgentTaskStore.setState((state) => ({
        conversations: state.conversations.map((conversation) =>
          conversation.id === conversationId
            ? { ...conversation, title: `Flight plan — ${flight.title}` }
            : conversation,
        ),
      }));
      requestConversationSave(conversationId);
      await flushFlightPersistence();
      if (!isCurrent()) {
        await useAgentTaskStore.getState().cancelActiveConversation(conversationId);
        throw new Error("Planning stopped. Its conversation and Flight brief are retained.");
      }
      onLaunched?.(flight.id);
      openConversationInAgents(conversationId);
      onClose();
    } catch (e) {
      setError(typeof e === "string" ? e : ((e as Error)?.message ?? "Planning failed"));
    } finally {
      startup?.finish();
      setPlanning(false);
      setPendingFlightId(null);
    }
  }

  async function handleLaunch() {
    if (!canLaunch) return;
    launchAllowed.current = true;
    setLaunching(true);
    setError(null);
    let launchedFlightId: string | null = null;
    let attemptIdsBefore = new Set<string>();
    try {
      if (collisionMessage) {
        setError(collisionMessage);
        return;
      }
      // When launching into an already-staged flight (e.g. from GitHub's
      // "Plan flight" hand-off or the Flights detail pane's empty-attempts
      // state), reuse it instead of minting a disconnected duplicate.
      const flight = createOrUpdateFlight(true);
      launchedFlightId = flight.id;
      setPendingFlightId(flight.id);
      attemptIdsBefore = new Set((flight.attempts ?? []).map((attempt) => attempt.id));

      // The backend appends Attempts to the persisted Flight. Ensure the
      // create/update above has landed first; otherwise a fast launch can see
      // "Flight not found" or race a delayed stale whole-slice write.
      await flushFlightPersistence();

      await launchAsync(flight.id, flight.prompt || prompt.trim(), targetSpecs, {
        explicitResume: true,
        canStart: () => launchAllowed.current,
      });

      onLaunched?.(flight.id);
      onClose();
    } catch (e) {
      if (!launchAllowed.current) {
        setError("Flight stopped. Prepared work is retained for inspection in Flight Deck.");
        if (launchedFlightId) onLaunched?.(launchedFlightId);
        return;
      }
      const message = typeof e === "string" ? e : ((e as Error)?.message ?? "Launch failed");
      // `launchAsync` rehydrates and reattaches attempts that DID provision
      // before the failure, so count them and say so — otherwise the user is
      // told the launch failed while agents are live and spending.
      const prepared = launchedFlightId
        ? (useFlightStore
            .getState()
            .flights.find((f) => f.id === launchedFlightId)
            ?.attempts?.filter((attempt) => !attemptIdsBefore.has(attempt.id)) ?? [])
        : [];
      const outcome = summarizeLaunchOutcome(
        prepared.filter(attemptHasActiveWork).length,
        picked.length,
        message,
      );
      setError(
        !outcome.partial && prepared.length > 0
          ? `${outcome.text} Prepared work is retained for inspection in Flight Deck.`
          : outcome.text,
      );
      if (prepared.length > 0 && launchedFlightId) onLaunched?.(launchedFlightId);
    } finally {
      setLaunching(false);
      setPendingFlightId(null);
    }
  }

  async function stopLaunch() {
    launchAllowed.current = false;
    if (!pendingFlightId || stopping) return;
    setStopping(true);
    try {
      await useAsyncFlightStore.getState().stopFlight(pendingFlightId);
      onLaunched?.(pendingFlightId);
      onClose();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setStopping(false);
    }
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.ctrlKey && e.key === "Enter") {
      e.preventDefault();
      void (intent === "cooperative" ? handlePlanFirst() : handleLaunch());
    }
  }

  const footer = (
    <div className="flex flex-wrap items-center justify-between gap-3">
      <span className="text-[10px] text-text-muted">
        Each run uses an isolated branch · API usage is billed by your provider
      </span>
      <div className="flex items-center gap-2">
        {(launching || planning) && pendingFlightId && (
          <button
            type="button"
            disabled={stopping}
            onClick={() => void stopLaunch()}
            className="rounded border border-accent-red/30 px-3 py-1.5 text-xs text-accent-red"
          >
            {stopping ? "Stopping…" : planning ? "Stop planning" : "Stop launch"}
          </button>
        )}
        <button
          onClick={onClose}
          disabled={launching || planning}
          className="px-3 py-1.5 text-xs text-text-secondary transition-colors hover:text-text-primary disabled:opacity-50"
        >
          Cancel
        </button>
        <button
          onClick={() => void handlePlanFirst()}
          disabled={!canPlan}
          className="flex items-center gap-1.5 rounded border border-accent-purple/30 bg-accent-purple/10 px-3 py-1.5 text-xs font-medium text-accent-purple transition-colors hover:bg-accent-purple/20 disabled:cursor-not-allowed disabled:opacity-40"
          title="Explore the repository and refine a structured plan in a normal agent conversation"
        >
          <Route size={11} />
          {planning ? "Starting plan…" : canOpenExistingPlan ? "Open plan" : "Plan before running"}
        </button>
        <button
          onClick={() => void (intent === "cooperative" ? handlePlanFirst() : handleLaunch())}
          disabled={intent === "cooperative" ? !canPlan : !canLaunch}
          className="flex items-center gap-1.5 rounded border border-accent-green/30 bg-accent-green/15 px-4 py-1.5 text-xs font-medium text-accent-green transition-colors hover:bg-accent-green/25 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {launching ? <Loader2 size={11} className="animate-spin" /> : <Rocket size={11} />}
          {launching
            ? `Provisioning ${picked.length} ${picked.length === 1 ? "agent" : "agents"}…`
            : intent === "cooperative"
              ? "Plan cooperative work"
              : intent === "compare"
                ? `Compare ${picked.length} runs`
                : "Run Flight"}
        </button>
      </div>
    </div>
  );

  return (
    <Modal
      onClose={launching || planning ? () => {} : onClose}
      // While a launch or a planning turn is in flight the dialog is
      // uncloseable — `closeDisabled` dims the X and also suppresses the
      // Escape-to-close default used by the shared Modal.
      closeDisabled={launching || planning}
      title={
        existingFlight
          ? `New attempt — ${existingFlight.title || "Untitled flight"}`
          : "Flight brief"
      }
      icon={<Sparkles size={14} className="text-accent-green" />}
      width="w-[820px] max-w-[92vw]"
      footer={footer}
    >
      <fieldset
        disabled={launching || planning}
        className="flex min-w-0 flex-col gap-4 px-5 py-4"
        onKeyDown={handleKeyDown}
      >
        <p className="text-xs leading-relaxed text-text-secondary">
          Finish one scoped change on an isolated branch, then review the result and choose Land or
          Open PR.{initialContext?.sourceLabel ? ` From ${initialContext.sourceLabel}.` : ""}
        </p>
        {launchBlocked && (
          <div
            role="alert"
            className="rounded border border-accent-amber/30 bg-accent-amber/10 px-3 py-2 text-xs text-accent-amber"
          >
            {launchBlocked}
            <button
              type="button"
              onClick={() => {
                setForceNew(true);
                setCreatedFlightId(null);
                setIntent("single");
                setAutonomyMode("assisted");
              }}
              className="ml-2 underline"
            >
              Create a new Flight
            </button>
          </div>
        )}
        {/* Prompt */}
        <div className="flex flex-col gap-1.5">
          <label htmlFor="flight-outcome" className="text-[11px] font-medium text-text-secondary">
            Desired outcome
          </label>
          <textarea
            id="flight-outcome"
            autoFocus
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder="What should be different when this work is finished? Include the scope and anything the agent should preserve."
            rows={4}
            className="w-full resize-none rounded border border-bg-border bg-bg-primary px-3 py-2 text-xs text-text-primary outline-none placeholder:text-text-muted focus:border-accent-green/50"
          />
          {recurringHint && (
            <div className="flex items-start gap-1.5 rounded border border-accent-amber/40 bg-accent-amber/10 px-2.5 py-1.5 text-[11px] leading-snug text-accent-amber">
              <AlertTriangle size={12} className="mt-px shrink-0" />
              <span>
                <span className="font-medium">This looks familiar</span>
                {recurringHint.source === "failure" && recurringHint.occurrences
                  ? ` (hit in ${recurringHint.occurrences} prior flight${recurringHint.occurrences === 1 ? "" : "s"})`
                  : ""}
                : {recurringHint.text}
              </span>
            </div>
          )}
        </div>

        <label className="flex flex-col gap-1.5 text-[11px] font-medium text-text-secondary">
          Acceptance checks
          <textarea
            aria-label="Acceptance checks"
            value={acceptanceCriteria}
            onChange={(event) => setAcceptanceCriteria(event.target.value)}
            rows={3}
            placeholder={
              "One observable check per line\nExample: creating a Flight from this issue keeps its repository and criteria"
            }
            className="w-full resize-y rounded border border-bg-border bg-bg-primary px-3 py-2 text-xs font-normal text-text-primary"
          />
          <span className="text-[10px] font-normal text-text-muted">
            Included in the builder brief. Independent review is optional below.
          </span>
          {criteriaError && <span className="text-[10px] text-accent-amber">{criteriaError}</span>}
        </label>

        {/* Title (optional) */}
        <div className="flex flex-col gap-1.5">
          <label htmlFor="flight-title" className="text-[11px] font-medium text-text-secondary">
            Title <span className="font-normal text-text-muted">(optional)</span>
          </label>
          <input
            id="flight-title"
            type="text"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder={promptShort || "Auto-generated from prompt"}
            className="w-full rounded border border-bg-border bg-bg-primary px-3 py-2 text-xs text-text-primary outline-none placeholder:text-text-muted focus:border-accent-green/50"
          />
        </div>

        {/* Targets */}
        <MultiTargetPicker
          picked={picked}
          onChange={setPicked}
          allowMultiple={intent === "compare"}
          onValidationChange={setTargetErrors}
        />

        <div className="rounded border border-bg-border bg-bg-secondary px-3 py-2 text-[11px] text-text-secondary">
          {intent === "single"
            ? effectiveAutonomyPolicy
              ? `One agent · Bounded follow-up: $${effectiveAutonomyPolicy.maxTotalCost.toFixed(2)}, ${effectiveAutonomyPolicy.maxDurationMinutes} minutes. You control final landing.`
              : "One agent · Assisted: you control retries, acceptance and landing."
            : intent === "compare"
              ? "Each selected agent runs the same brief independently. Compare results before choosing one."
              : "Create and approve a task plan, then launch ready tasks from the Flight. Each task has its own branch."}
        </div>

        <button
          type="button"
          aria-expanded={advanced}
          onClick={() => setAdvanced((value) => !value)}
          className="self-start text-[11px] text-text-muted underline"
        >
          {advanced
            ? "Hide execution options"
            : "Execution options · review, publishing and team modes"}
        </button>

        {advanced && (
          <>
            <fieldset className="space-y-2 rounded border border-bg-border p-3">
              <legend className="px-1 text-[11px] text-text-secondary">Work arrangement</legend>
              {(
                [
                  ["single", "One scoped change"],
                  ["compare", "Compare alternative implementations"],
                  ["cooperative", "Plan and divide work"],
                ] as const
              ).map(([value, label]) => (
                <label
                  key={value}
                  className="flex items-center gap-2 text-[11px] text-text-secondary"
                >
                  <input
                    type="radio"
                    name="flight-intent"
                    value={value}
                    checked={intent === value}
                    disabled={
                      existingFlight?.executionMode === "cooperative" && value !== "cooperative"
                    }
                    onChange={() => {
                      setIntent(value);
                      if (value === "cooperative") setPublishAsPrs(false);
                      if (value !== "compare") setPicked((current) => current.slice(0, 1));
                    }}
                  />
                  {label}
                </label>
              ))}
            </fieldset>

            <div className="rounded border border-accent-purple/20 bg-accent-purple/5 px-3 py-2 text-[10px] leading-relaxed text-text-muted">
              <span className="font-medium text-text-secondary">Plan first</span> uses the first
              selected agent in a read-only conversation. Refine the plan there, apply it to this
              Flight, then configure and launch attempts when you are ready.
            </div>

            <div className="rounded border border-accent-amber/25 bg-accent-amber/5 px-3 py-2.5">
              <div className="flex items-start gap-2">
                <ShieldAlert size={12} className="mt-0.5 shrink-0 text-accent-amber" />
                <div className="min-w-0 flex-1">
                  <div className="text-[11px] font-medium text-text-secondary">
                    Execution supervision
                  </div>
                  <div className="mt-2 grid grid-cols-3 gap-1">
                    {(
                      [
                        ["assisted", "Assisted"],
                        ["settings_default", "Settings default"],
                        ["yolo", "Bounded follow-up"],
                      ] as const
                    ).map(([value, label]) => (
                      <button
                        key={value}
                        type="button"
                        onClick={() => setAutonomyMode(value)}
                        aria-pressed={autonomyMode === value}
                        className={`rounded border px-2 py-1 text-[10px] ${
                          autonomyMode === value
                            ? value === "yolo"
                              ? "border-accent-amber/50 bg-accent-amber/15 text-accent-amber"
                              : "border-accent-green/40 bg-accent-green/10 text-accent-green"
                            : "border-bg-border text-text-muted"
                        }`}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                  {effectiveAutonomyPolicy ? (
                    <div className="mt-2 text-[10px] leading-relaxed text-text-muted">
                      <span className="font-medium text-text-secondary">Effective bounds:</span> $
                      {effectiveAutonomyPolicy.maxTotalCost.toFixed(2)} ·{" "}
                      {effectiveAutonomyPolicy.maxDurationMinutes} min ·{" "}
                      {effectiveAutonomyPolicy.maxRetriesPerTask} retries/task ·{" "}
                      {effectiveAutonomyPolicy.maxReviewRounds} review rounds ·{" "}
                      {effectiveAutonomyPolicy.maxConcurrentAgents} agents. Enabled:{" "}
                      {[
                        effectiveAutonomyPolicy.autoRecovery && "recovery",
                        effectiveAutonomyPolicy.autoReviewRemediation && "review remediation",
                        effectiveAutonomyPolicy.autoRunTaskGraph && "task graph",
                        effectiveAutonomyPolicy.toolPosture === "allow_in_project" &&
                          "unattended in-project tools",
                      ]
                        .filter(Boolean)
                        .join(", ") || "limits only"}
                      .
                    </div>
                  ) : (
                    <p className="mt-2 text-[10px] leading-relaxed text-text-muted">
                      {autonomyMode === "settings_default"
                        ? "Settings currently resolves this Flight to Assisted mode."
                        : `${APP_NAME} detects and recommends; you launch, retry, accept, and integrate.`}
                    </p>
                  )}
                  {autonomyConfigurationError && (
                    <p className="mt-1 text-[10px] text-accent-amber">
                      {autonomyConfigurationError}
                    </p>
                  )}
                </div>
              </div>
            </div>

            {/* v0.8-G: publish attempts as draft PRs */}
            <label className="group flex cursor-pointer items-start gap-2">
              <input
                type="checkbox"
                checked={perAttemptPublishing}
                disabled={
                  intent === "cooperative" || existingFlight?.executionMode === "cooperative"
                }
                onChange={(e) => setPublishAsPrs(e.target.checked)}
                className="mt-0.5 accent-accent-green"
              />
              <div className="flex flex-col gap-0.5">
                <span className="flex items-center gap-1.5 text-[11px] font-medium text-text-secondary group-hover:text-text-primary">
                  <GitPullRequest size={11} className="text-accent-purple" />
                  Publish attempts as draft PRs
                </span>
                <span className="text-[10px] leading-snug text-text-muted">
                  {intent === "cooperative" || existingFlight?.executionMode === "cooperative"
                    ? "Cooperative tasks integrate into one result. Review the combined changes, then land the Flight."
                    : "After acceptance, push the branch and open a draft PR on its configured Git host."}
                </span>
              </div>
            </label>
          </>
        )}
        <div className="rounded border border-bg-border bg-bg-secondary/40 px-3 py-2.5">
          <label className="group flex cursor-pointer items-start gap-2">
            <input
              type="checkbox"
              checked={reviewerEnabled}
              onChange={(event) => setReviewerEnabled(event.target.checked)}
              className="mt-0.5 accent-accent-green"
            />
            <div className="flex flex-col gap-0.5">
              <span className="flex items-center gap-1.5 text-[11px] font-medium text-text-secondary group-hover:text-text-primary">
                <ShieldCheck size={11} className="text-accent-green" />
                Require an independent Reviewer Gate
              </span>
              <span className="text-[10px] leading-snug text-text-muted">
                When an attempt finishes, automatically run one read-only reviewer. This incurs
                model usage. Acceptance stays blocked until it passes or you record an override.
              </span>
            </div>
          </label>

          {reviewerEnabled && (
            <div className="mt-3 border-t border-bg-border pt-3">
              <FlightAgentPicker
                label="Independent reviewer"
                agent={reviewerAgent}
                model={reviewerModel}
                onChange={(agent, model) => {
                  setReviewerAgent(agent);
                  setReviewerModel(model);
                }}
                onReadinessChange={setReviewerError}
              />
              {reviewerConfigurationError && (
                <p className="mt-2 text-[10px] text-accent-amber">{reviewerConfigurationError}</p>
              )}
            </div>
          )}
        </div>
        {unpinnedMessage && (
          <div className="flex items-start gap-2 rounded border border-accent-amber/30 bg-accent-amber/10 px-3 py-2 text-[11px] text-accent-amber">
            <AlertTriangle size={12} className="mt-0.5 flex-shrink-0" />
            <div className="flex-1">
              <span>{unpinnedMessage}</span>
              <button
                type="button"
                onClick={handleOpenServersView}
                className="mt-1 block underline hover:text-accent-amber"
              >
                Open Servers settings →
              </button>
            </div>
          </div>
        )}

        {launching && (
          <div
            role="status"
            className="flex items-start gap-2 rounded border border-accent-green/25 bg-accent-green/5 px-3 py-2 text-[11px] text-text-secondary"
          >
            <Loader2 size={12} className="mt-0.5 flex-shrink-0 animate-spin text-accent-green" />
            <div>
              Provisioning a git worktree and starting a session for each target, one at a time:{" "}
              <span className="text-text-primary">
                {picked.map((target) => target.label).join(", ")}
              </span>
              . Targets that come up stay live even if a later one fails.
            </div>
          </div>
        )}

        {collisionMessage && (
          <div className="whitespace-pre-wrap rounded border border-accent-amber/30 bg-accent-amber/10 px-3 py-2 text-[11px] text-accent-amber">
            {collisionMessage}
          </div>
        )}

        {error && (
          <div className="rounded border border-accent-red/30 bg-accent-red/10 px-3 py-2 text-[11px] text-accent-red">
            {error}
          </div>
        )}
      </fieldset>
    </Modal>
  );
}
