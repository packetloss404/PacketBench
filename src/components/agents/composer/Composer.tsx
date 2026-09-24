import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowUp, ChevronUp, Mic, Square, X } from "lucide-react";
import { useShallow } from "zustand/react/shallow";
import { Tooltip } from "@/components/ui/Tooltip";
import { useAgentTaskStore, type AgentCli } from "@/stores/agentTaskStore";
import { LAUNCH_DRAFT_KEY, useAgentDraftStore } from "@/stores/agentDraftStore";
import { useProfileStore } from "@/stores/profileStore";
import { usePromptStore } from "@/stores/promptStore";
import { useAppStore } from "@/stores/appStore";
import type { AgentConversation } from "@/types/agent-conversation";
import type { ImageAttachment } from "@/lib/tauri";
import type { AuthStatus } from "@/components/ui/AuthBadge";
import { isSshUri } from "@/lib/ssh-uri";
import { FileMentionPopover } from "../FileMentionPopover";
import { InputPopover } from "../InputPopover";
import { CancelPendingButton } from "../chat/CancelPendingButton";
import { usePrefixMatcher } from "../hooks/usePrefixMatcher";
import { useAttachmentStaging } from "../hooks/useAttachmentStaging";
import { useProviderAuthStatus } from "../hooks/useProviderAuthStatus";
import { useOllamaModels } from "../hooks/useOllamaModels";
import { useProjectSlashCommands } from "../hooks/useProjectSlashCommands";
import { useVoiceTranscript } from "../hooks/useVoiceTranscript";
import { AgentModeChip, type AgentMode as PermissionPosture } from "../AgentModeChip";
import { addPaneControlListener, OPEN_MODEL_DROPDOWN_EVENT } from "../paneEvents";
import { capabilitiesFor } from "@/lib/agentCapabilities";
import { providerEnumeratesLive } from "@/lib/liveModels";
import { useLiveModels } from "../hooks/useLiveModels";
import { sessionUsageFor, usageStatusline } from "@/lib/usageStatusline";
import { ContextStrip } from "./ContextStrip";
import { ProjectPicker } from "./ProjectPicker";
import { ModeSelector } from "./ModeSelector";
import { ProfilePicker } from "./ProfilePicker";
import { ComposerModePicker } from "./ComposerModePicker";
import { ProviderPicker } from "./ProviderPicker";
import { ModelSelector } from "./ModelSelector";
import { ActionButtons } from "./ActionButtons";
import { AdvancedAccordion } from "./AdvancedAccordion";
import {
  COMPOSER_HELP_TEXT,
  MODE_META,
  composerPlaceholder,
  type AgentMode,
  type ComposerMode,
} from "./utils";
import { buildComposerKeyboardHandler } from "./buildComposerKeyboardHandler";
import { buildSlashItems, templatesToSlashDefs, type SlashItem } from "./slashCommandSource";
import { slashCommandHandlers } from "./slashCommandHandlers";

export interface LaunchComposerProps {
  variant: "launch";
  /** Owned by the caller so AgentsView can focus the box (Ctrl+N / New agent). */
  textareaRef: React.RefObject<HTMLTextAreaElement | null>;
  selectedAgent: AgentCli;
  onAgentChange: (agent: AgentCli) => void;
  /** Called when the user submits with the composed text + staged image
   * attachments. Return true to accept (clears the staged attachments; the
   * caller clears the launch draft once the async launch succeeds so a
   * failed launch keeps the prompt for a retry). */
  onLaunch: (text: string, attachments: ImageAttachment[]) => boolean;
  selectedModel: string;
  onModelChange: (model: string) => void;
  agentMode?: AgentMode;
  onAgentModeChange?: (mode: AgentMode) => void;
  selectedProfileId?: string;
  onProfileChange?: (id: string) => void;
  composerMode?: ComposerMode;
  onComposerModeChange?: (mode: ComposerMode) => void;
}

export interface ChatComposerProps {
  variant: "chat";
  conversationId: string;
  conversation: AgentConversation;
  /** Pending permission+edit approvals — drives the cancel-pending button. */
  pendingApprovalCount: number;
  onCancelPending: () => void;
  /** Shift+Tab mode-chip cycle (the posture state machine lives in the pane). */
  onCycleMode: () => void;
  /** Pick a posture directly from the mode chip's popover. */
  onSelectMode: (mode: PermissionPosture) => void;
  /** The chip popover's orthogonal "Approve writes" fine flag. */
  onSetApproveWrites: (on: boolean) => void;
  /** Model switch from the composer-row picker. */
  onChangeModel: (model: string) => void;
}

export type ComposerProps = LaunchComposerProps | ChatComposerProps;

/**
 * THE composer. One component with a launch/chat variant prop, replacing the
 * two parallel implementations (AgentInputArea + the AgentChatPane inline
 * composer). Both variants share ONE trigger system (usePrefixMatcher +
 * InputPopover/FileMentionPopover), ONE slash-command source of truth
 * (buildSlashItems feeds the popover AND the keyboard handler), ONE keyboard
 * handler, and the same attachment staging — so `@` and `/` behave
 * identically whether you're launching an agent or replying to one.
 *
 * Variant differences that remain are inherent to the moment:
 * - launch: project/provider/model/mode pickers, auth-gated Launch button,
 *   no conversation history to recall.
 * - chat: builtin slash commands (they act on the live conversation),
 *   shell-style ↑/↓ history, Shift+Tab mode cycle, Stop-while-streaming.
 */
export function Composer(props: ComposerProps) {
  const isChat = props.variant === "chat";
  const launch = props.variant === "launch" ? props : undefined;
  const conversation = isChat ? props.conversation : undefined;
  const conversationId = isChat ? props.conversationId : "";
  const isStopping = useAgentTaskStore(
    (s) => isChat && (s.cancellingConversationIds?.has(conversationId) ?? false),
  );

  // ─── Draft text — always in the per-conversation draft store ─────────
  const draftKey = isChat ? conversationId : LAUNCH_DRAFT_KEY;
  const input = useAgentDraftStore((s) => s.drafts[draftKey] ?? "");
  const setDraft = useAgentDraftStore((s) => s.setDraft);
  const setInput = useCallback((text: string) => setDraft(draftKey, text), [draftKey, setDraft]);

  const internalTextareaRef = useRef<HTMLTextAreaElement>(null);
  const textareaRef = launch ? launch.textareaRef : internalTextareaRef;

  // ─── Store wiring ─────────────────────────────────────────────────────
  const selectedRepo = useAgentTaskStore((s) => s.selectedRepo);
  const setSelectedRepo = useAgentTaskStore((s) => s.setSelectedRepo);
  const chatActions = useAgentTaskStore(
    useShallow((s) => ({
      sendMessage: s.sendMessage,
      cancelActiveConversation: s.cancelActiveConversation,
      createApiConversation: s.createApiConversation,
      selectConversation: s.selectConversation,
      setPlanMode: s.setPlanMode,
    })),
  );
  const setActiveView = useAppStore((s) => s.setActiveView);
  const profiles = useProfileStore((s) => s.profiles);
  const defaultProfileId = useProfileStore((s) => s.defaultProfileId);
  const setDefaultProfile = useProfileStore((s) => s.setDefaultProfile);
  const reviewerProfile = useProfileStore((s) =>
    s.profiles.find((p) => p.id === "builtin-reviewer"),
  );
  const activeProfileId = launch?.selectedProfileId ?? defaultProfileId;
  const activeProfile = profiles.find((p) => p.id === activeProfileId) ?? profiles[0];

  // ─── Attachment staging (paste / drag-drop) — both variants ──────────
  const { staged, addFiles, removeStaged, clear: clearStaged } = useAttachmentStaging();
  const [dragActive, setDragActive] = useState(false);
  // Enter/leave depth counter so the drag border doesn't flicker off when the
  // pointer crosses into nested children (textarea, staged chips, popovers).
  const dragDepthRef = useRef(0);

  const handlePaste = useCallback(
    (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
      const items = e.clipboardData?.items;
      if (!items) return;
      const files: File[] = [];
      for (let i = 0; i < items.length; i++) {
        const item = items[i];
        if (item.kind === "file") {
          const f = item.getAsFile();
          if (f && f.type.startsWith("image/")) files.push(f);
        }
      }
      if (files.length > 0) {
        e.preventDefault();
        void addFiles(files);
      }
    },
    [addFiles],
  );

  const handleDrop = useCallback(
    (e: React.DragEvent<HTMLDivElement>) => {
      e.preventDefault();
      dragDepthRef.current = 0;
      setDragActive(false);
      const files = Array.from(e.dataTransfer?.files ?? []);
      if (files.length > 0) void addFiles(files);
    },
    [addFiles],
  );

  const handleDragEnter = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    dragDepthRef.current += 1;
    setDragActive(true);
  }, []);

  // dragover must preventDefault for the drop to fire, but doesn't touch the
  // depth counter — enter/leave own the active state.
  const handleDragOver = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
  }, []);

  const handleDragLeave = useCallback(() => {
    dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
    if (dragDepthRef.current === 0) setDragActive(false);
  }, []);

  // ─── Voice input ──────────────────────────────────────────────────────
  const appendToInput = useCallback(
    (chunk: string) => {
      const current = useAgentDraftStore.getState().drafts[draftKey] ?? "";
      setDraft(draftKey, current + chunk);
    },
    [draftKey, setDraft],
  );
  const voice = useVoiceTranscript(appendToInput);

  // ─── Capabilities — every control below renders from THIS, never from a
  //     provider id. See lib/agentCapabilities.ts. ────────────────────────
  /**
   * This provider's live model list, from the shared cache.
   *
   * `capabilitiesFor` is PURE — it may not read a store or issue IPC — so the
   * live answer is subscribed HERE and passed in. The empty-string agent for a
   * launch-mode composer resolves to no registry entry, so it subscribes to
   * nothing and fetches nothing; the launch card's own ModelSelector does its
   * own lookup from `launch.selectedAgent`.
   */
  const { answer: liveModelAnswer } = useLiveModels(conversation?.agent ?? ("" as AgentCli));
  const caps = conversation ? capabilitiesFor(conversation, liveModelAnswer) : null;

  // ─── Prefix-trigger pickers (@ mentions, / slash-commands) ───────────
  const mention = usePrefixMatcher("@");
  const slash = usePrefixMatcher("/");
  // The mention popover owns its directory scan; we keep a ref to the
  // current list so ArrowUp/Down/Enter can read it synchronously.
  const mentionItemsRef = useRef<string[]>([]);

  // Launch mentions/commands come from the picked project (local only —
  // memory/file scans are project-path-keyed and remote paths aren't a
  // stable key here); chat uses the conversation's own project path.
  const mentionProjectPath = isChat
    ? (conversation?.projectPath ?? "")
    : selectedRepo && !isSshUri(selectedRepo)
      ? selectedRepo
      : "";

  const promptTemplates = usePromptStore((s) => s.templates);
  const templateDefs = useMemo(() => templatesToSlashDefs(promptTemplates), [promptTemplates]);
  const { customSlashCommands, userSkills } = useProjectSlashCommands(mentionProjectPath);
  const allCustomSlashCommands = useMemo(
    () => [...customSlashCommands, ...templateDefs],
    [customSlashCommands, templateDefs],
  );

  // Whether `/` opens a menu at all. The pane's rule is to omit an affordance
  // a session cannot serve rather than open an empty one; the placeholder
  // already degrades to match (composerPlaceholder).
  const slashEnabled = caps ? caps.slashCommands : true;
  const mentionsEnabled = caps
    ? caps.fileMentions
    : // Launch has no conversation to ask, so the project path is the gate,
      // exactly as before.
      !!mentionProjectPath;

  // THE slash list — rendered by the popover and resolved by the keyboard
  // handler, so the two can never disagree.
  const slashItems = useMemo<SlashItem[]>(
    () =>
      slash.state.active && slashEnabled
        ? buildSlashItems(slash.state.query, {
            includeBuiltins: isChat,
            customCommands: allCustomSlashCommands,
            userSkills,
          })
        : [],
    [
      slash.state.active,
      slash.state.query,
      slashEnabled,
      isChat,
      allCustomSlashCommands,
      userSkills,
    ],
  );
  const clampSlashHighlight = slash.clampHighlight;
  useEffect(() => {
    clampSlashHighlight(slashItems.length);
  }, [slashItems.length, clampSlashHighlight]);

  const detectTriggers = useCallback(
    (value: string, caret: number) => {
      // A session that cannot serve the affordance never opens the trigger at
      // all — `@`/`/` stay literal text, and Enter still submits rather than
      // being swallowed by an empty popover. Launch (no conversation, so no
      // capability record) keeps today's unconditional detection.
      const mentionHit = mentionsEnabled ? mention.detect(value, caret) : false;
      if (!mentionsEnabled) mention.close();
      // Slash is suppressed while the mention popover is active so the two
      // triggers don't fight.
      if (!mentionHit && slashEnabled) {
        slash.detect(value, caret);
      } else {
        slash.close();
      }
    },
    [mention, slash, mentionsEnabled, slashEnabled],
  );

  // ─── Chat prompt history (↑/↓ recall) ────────────────────────────────
  const [historyIndex, setHistoryIndex] = useState(-1);
  const historySourceRef = useRef<"user" | "history">("user");
  const messages = useMemo(() => conversation?.messages ?? [], [conversation?.messages]);
  const turnCount = useMemo(() => messages.filter((m) => m.role === "user").length, [messages]);

  const handleTextChange = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      const value = e.target.value;
      setInput(value);
      const caret = e.target.selectionStart ?? value.length;
      detectTriggers(value, caret);
      if (historySourceRef.current === "history") {
        historySourceRef.current = "user";
      } else if (historyIndex !== -1) {
        setHistoryIndex(-1);
      }
    },
    [setInput, detectTriggers, historyIndex],
  );

  // Re-detect on caret movement (arrow keys, clicks) so the popovers track
  // the token under the caret, not just the last edit.
  const handleSelectionChange = useCallback(() => {
    const ta = textareaRef.current;
    if (!ta) return;
    const caret = ta.selectionStart ?? ta.value.length;
    detectTriggers(ta.value, caret);
  }, [textareaRef, detectTriggers]);

  const handleBlur = useCallback(() => {
    // Delay so onMouseDown selection in the popover can still fire.
    setTimeout(() => {
      mention.close();
      slash.close();
    }, 120);
  }, [mention, slash]);

  const handleMentionItemsChange = useCallback(
    (paths: string[]) => {
      mentionItemsRef.current = paths;
      mention.clampHighlight(paths.length);
    },
    [mention],
  );

  const insertMentionPath = useCallback(
    (path: string) => {
      const atIndex = mention.state.prefixIndex;
      if (atIndex < 0) return;
      const before = input.slice(0, atIndex);
      const caret = textareaRef.current?.selectionStart ?? input.length;
      const after = input.slice(caret);
      const inserted = `@${path} `;
      const next = `${before}${inserted}${after}`;
      setInput(next);
      const newCaret = before.length + inserted.length;
      requestAnimationFrame(() => {
        const el = textareaRef.current;
        if (el) {
          el.focus();
          el.setSelectionRange(newCaret, newCaret);
        }
      });
      mentionItemsRef.current = [];
      mention.close();
    },
    [input, setInput, textareaRef, mention],
  );

  /** Resolve a picked slash item. Builtins run immediately (they're actions
   * on the live conversation); body-carrying commands (templates, custom
   * commands, skills) expand INTO the composer at the trigger position —
   * identically in both variants — so the user can append arguments/details
   * before Enter sends (chat) or launches (launch). */
  const pickSlashItem = useCallback(
    (item: SlashItem) => {
      const slashIdx = slash.state.prefixIndex;
      if (slashIdx < 0) return;
      const before = input.slice(0, slashIdx);
      const afterStart = slashIdx + 1 + slash.state.query.length;
      const after = input.slice(afterStart);
      slash.close();

      const sel = item.selection;
      if (sel.kind === "builtin") {
        setInput((before + after).trim());
        if (isChat && conversation) {
          const handler = slashCommandHandlers[sel.name];
          if (handler) {
            handler({
              conversationId,
              conversation,
              setPlanMode: chatActions.setPlanMode,
              createApiConversation: chatActions.createApiConversation,
              selectConversation: chatActions.selectConversation,
              setActiveView,
              reviewerProfile,
            });
          }
        }
        return;
      }

      // Trim trailing whitespace on the body, leave the user's `after`
      // content untouched to avoid double-newlines.
      const body = sel.def.body.replace(/\s+$/, "");
      const next = `${before}${body}${after}`;
      setInput(next);
      const newCaret = before.length + body.length;
      requestAnimationFrame(() => {
        const el = textareaRef.current;
        if (el) {
          el.focus();
          el.setSelectionRange(newCaret, newCaret);
        }
      });
    },
    [
      slash,
      input,
      setInput,
      isChat,
      conversation,
      conversationId,
      chatActions,
      setActiveView,
      reviewerProfile,
      textareaRef,
    ],
  );

  // ─── Provider auth + Ollama models (launch variant only) ─────────────
  const { authStatus, refreshAuthStatuses } = useProviderAuthStatus(!isChat);
  // Both variants own a model picker now, so the Ollama probe follows whichever
  // agent this composer is pointed at.
  const { ollamaModels, refresh: refreshOllamaModels } = useOllamaModels(
    launch?.selectedAgent ?? conversation?.agent ?? "",
  );

  // `/model` slash command → open the composer-row model picker. This listener
  // used to live in TileHeaderActions; it MUST travel with the control it
  // opens, or `/model` becomes a silent no-op.
  const [modelOpenSignal, setModelOpenSignal] = useState(0);
  useEffect(() => {
    if (!isChat || !conversationId) return undefined;
    return addPaneControlListener(OPEN_MODEL_DROPDOWN_EVENT, conversationId, () =>
      setModelOpenSignal((n) => n + 1),
    );
  }, [isChat, conversationId]);

  const selectedAuth = launch ? authStatus[launch.selectedAgent] : undefined;
  const selectedAuthStatus: AuthStatus =
    selectedAuth === "loading" || !selectedAuth ? "loading" : selectedAuth.status;
  const launchReady = selectedAuthStatus === "ready";
  const launchLabel = selectedAuthStatus === "coming_soon" ? "Coming soon" : "Launch";
  // No API-agent row uses an interactive subscription login any more, so the
  // old inline "Log in" button (which fired `packetbench:open-claude-login` /
  // `packetbench:open-codex-login`) is gone from this surface. Interactive
  // `claude login` / `codex login` still exists in Settings → Subscriptions
  // for PTY CLI sessions, which are unaffected.
  //
  // A not-ready badge is NOT always a missing API key: two rows are keyless
  // and fail for reasons of their own — Ollama with `service_down` when
  // localhost:11434 is not answering, and the custom endpoint with
  // `missing_key` when no base URL is set. Each
  // one's backend hint names its own remedy, which is why the disabled Launch
  // button's tooltip is the hint verbatim rather than a fixed "add a key"
  // sentence.

  // ─── Submit ───────────────────────────────────────────────────────────
  // Single-flight guard (launch): onLaunch returns synchronously while async
  // work (worktree provisioning, conversation creation) is still in flight,
  // so a second submit can race the first. The 500ms window blocks rapid
  // Enter/Send mashing without delaying legitimate quick consecutive submits.
  const submitInFlightRef = useRef(false);
  const submitLaunch = useCallback(() => {
    if (!launch || !launchReady) return;
    if (submitInFlightRef.current) return;
    submitInFlightRef.current = true;
    const toSend = staged.map((s) => s.attachment);
    const accepted = launch.onLaunch(input, toSend);
    if (accepted) {
      clearStaged();
    }
    window.setTimeout(() => {
      submitInFlightRef.current = false;
    }, 500);
  }, [launch, launchReady, staged, input, clearStaged]);

  const isActive = conversation?.status === "active";

  const submitChat = useCallback(() => {
    if (!isChat || !conversation) return;
    const text = input.trim();
    if (!text) return;
    // While a turn is streaming the store QUEUES the text (protected
    // queued-send-while-streaming behavior) — queued messages carry no
    // attachments, so keep any staged images for the next live send
    // instead of silently dropping them.
    const streaming =
      conversation.status === "active" && conversation.messages.some((m) => m.isStreaming);
    const attachments = streaming ? null : staged.map((s) => s.attachment);
    setInput("");
    mention.close();
    slash.close();
    setHistoryIndex(-1);
    if (!streaming) clearStaged();
    chatActions.sendMessage(
      conversationId,
      text,
      attachments && attachments.length > 0 ? attachments : null,
    );
  }, [
    isChat,
    conversation,
    input,
    staged,
    setInput,
    mention,
    slash,
    clearStaged,
    chatActions,
    conversationId,
  ]);

  const submit = isChat ? submitChat : submitLaunch;

  const handleStop = useCallback(() => {
    void chatActions.cancelActiveConversation(conversationId);
  }, [chatActions, conversationId]);

  // ─── Keyboard handler — ONE for both variants ────────────────────────
  const handleKeyDown = buildComposerKeyboardHandler({
    textareaRef,
    input,
    setInput,
    mention,
    getMentionItems: () => mentionItemsRef.current,
    insertMentionPath,
    slash,
    slashItems,
    pickSlashItem,
    submit,
    history: isChat ? { messages, historyIndex, setHistoryIndex, historySourceRef } : undefined,
    cycleMode: isChat ? props.onCycleMode : undefined,
  });

  // Auto-resize the chat textarea (launch uses a fixed 4-row box).
  useEffect(() => {
    if (!isChat) return;
    const ta = textareaRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = `${Math.min(ta.scrollHeight, 120)}px`;
  }, [isChat, input, textareaRef]);

  // ─── Shared pieces ────────────────────────────────────────────────────
  const popovers = (
    <div className="relative">
      <FileMentionPopover
        visible={mention.state.active && mentionsEnabled && !!mentionProjectPath}
        projectPath={mentionProjectPath}
        query={mention.state.query}
        highlightedIndex={mention.state.highlightedIndex}
        onSelect={insertMentionPath}
        onItemsChange={handleMentionItemsChange}
      />
      <InputPopover
        visible={slash.state.active && slashEnabled}
        items={slashItems}
        highlightedIndex={slash.state.highlightedIndex}
        onSelect={(item) => {
          const match = slashItems.find((si) => si.key === item.key);
          if (match) pickSlashItem(match);
        }}
        emptyLabel="No matching commands"
      />
    </div>
  );

  const stagedChips = staged.length > 0 && (
    <div className="flex flex-wrap gap-1.5 pb-2">
      {staged.map((s) => (
        <div
          key={s.id}
          className="flex items-center gap-1.5 rounded-md bg-bg-secondary py-0.5 pl-1 pr-1.5 text-meta text-text-secondary"
        >
          <Tooltip content={`${s.name} · ${(s.sizeBytes / 1024).toFixed(1)} KB`}>
            <span className="flex items-center gap-1.5">
              <img src={s.previewUrl} alt="" className="h-5 w-5 rounded object-cover" />
              <span className="max-w-[140px] truncate">{s.name}</span>
            </span>
          </Tooltip>
          <Tooltip content="Remove">
            <button
              type="button"
              aria-label="Remove"
              onClick={() => removeStaged(s.id)}
              className="rounded p-0.5 text-text-muted hover:bg-bg-hover hover:text-accent-red"
            >
              <X size={9} />
            </button>
          </Tooltip>
        </div>
      ))}
    </div>
  );

  const textarea = (
    <textarea
      ref={textareaRef}
      value={input}
      onChange={handleTextChange}
      onKeyDown={handleKeyDown}
      onKeyUp={handleSelectionChange}
      onClick={handleSelectionChange}
      onPaste={handlePaste}
      onBlur={handleBlur}
      placeholder={
        isChat
          ? // Degrades with capability — never promise a key this session
            // cannot serve (see composerPlaceholder above).
            composerPlaceholder(caps?.slashCommands ?? true, caps?.fileMentions ?? false)
          : "What would you like to work on?"
      }
      rows={isChat ? 1 : 4}
      className={
        isChat
          ? "w-full resize-none bg-transparent text-body text-text-primary placeholder:text-text-muted focus:outline-none"
          : "w-full resize-none bg-transparent px-4 py-3 text-body text-text-primary placeholder:text-text-muted focus:outline-none"
      }
    />
  );

  // ─── Voice button — same control in both shells ──────────────────────
  const voiceButton = voice.isSupported && (
    <Tooltip content={voice.isListening ? "Stop recording" : "Voice input"}>
      <button
        type="button"
        onClick={voice.isListening ? voice.stopListening : voice.startListening}
        className={`shrink-0 rounded-md p-1 transition-colors motion-reduce:transition-none ${
          voice.isListening
            ? "animate-pulse bg-accent-green/20 text-accent-green motion-reduce:animate-none"
            : "text-text-muted hover:bg-bg-hover hover:text-text-primary"
        }`}
      >
        <Mic size={12} />
      </button>
    </Tooltip>
  );

  // ─── Chat variant shell — the floating Codex-style composer card ──────
  if (isChat && conversation && caps) {
    const usage = caps.reportsUsage ? sessionUsageFor(conversation) : null;
    const statusline = usageStatusline(usage);

    return (
      <div
        className="composer-zone relative shrink-0 bg-bg-primary px-6 pb-4 pt-1"
        onDrop={handleDrop}
        onDragEnter={handleDragEnter}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
      >
        <div className="relative mx-auto w-full max-w-composer">
          {historyIndex >= 0 && (
            <div className="pointer-events-none absolute -top-4 right-1 inline-flex select-none items-center gap-0.5 font-mono text-meta text-text-faint">
              <ChevronUp size={10} />
              {historyIndex + 1}/{turnCount}
            </div>
          )}

          {/* `@`/`/` popovers open UPWARD (InputPopover is `bottom-full`), so
              they must be anchored above the whole card. */}
          {popovers}

          <ContextStrip conversation={conversation} caps={caps} />

          <div
            className={`rounded-b-xl border bg-bg-tertiary px-3.5 py-2.5 transition-colors motion-reduce:transition-none ${
              dragActive
                ? "border-accent-green ring-2 ring-accent-green/30"
                : "border-bg-border focus-within:border-accent-green/50"
            }`}
          >
            {stagedChips}
            {textarea}

            {/* Composer row: posture + turn control left, model/effort/send
                right. Every slot is gated on a capability, never a provider. */}
            <div className="mt-2 flex items-center gap-1.5">
              {caps.permissionModes.length > 0 && (
                <AgentModeChip
                  conversation={conversation}
                  onCycle={props.onCycleMode}
                  onSelectMode={props.onSelectMode}
                  onSetApproveWrites={props.onSetApproveWrites}
                />
              )}

              {caps.canCancelTurn && isActive && (
                <Tooltip content={isStopping ? "Waiting for Stop acknowledgement" : "Stop turn"}>
                  <button
                    type="button"
                    onClick={handleStop}
                    disabled={isStopping}
                    className="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-accent-red/20 text-accent-red transition-colors hover:bg-accent-red/30 disabled:cursor-wait disabled:opacity-60 motion-reduce:transition-none"
                  >
                    <Square
                      size={12}
                      className={
                        isStopping ? "animate-pulse motion-reduce:animate-none" : undefined
                      }
                    />
                  </button>
                </Tooltip>
              )}

              <CancelPendingButton
                pendingCount={props.pendingApprovalCount}
                onCancel={props.onCancelPending}
              />

              <div className="ml-auto flex min-w-0 items-center gap-1.5">
                {voiceButton}

                {/* NOT gated on `caps.models.length > 0` any more.
                    That gate degraded an empty list to a dead read-only label
                    — no picker, no refresh, no way to type an id — and it fired
                    for a live provider whose fetch had merely not landed yet,
                    which is the most common case and the least recoverable one.
                    Worse, it made ModelSelector's own empty-list handling
                    unreachable from an active conversation: the component knew
                    how to render "no models, here's Refresh and Settings" and
                    was never mounted to do it. ModelSelector now decides for
                    itself (`providerEnumeratesLive`), and this fallback is left
                    for the case it genuinely covers — a PTY/unknown agent with
                    no model list of any kind. */}
                <ModelSelector
                  dropUp
                  selectedAgent={conversation.agent}
                  selectedModel={conversation.model ?? ""}
                  onModelChange={props.onChangeModel}
                  models={caps.models}
                  modelsAreAuthoritative={caps.modelsAreAuthoritative}
                  ollamaModels={ollamaModels}
                  refreshOllamaModels={refreshOllamaModels}
                  openSignal={modelOpenSignal}
                  requiresTools
                />
                {!providerEnumeratesLive(conversation.agent) &&
                  caps.models.length === 0 &&
                  conversation.model && (
                    // Nothing to pick FROM and nothing that could ever arrive,
                    // but the session still knows what it runs ON — read-only
                    // rather than hidden.
                    <span className="truncate text-chip text-text-muted">{conversation.model}</span>
                  )}

                {/* Effort segments — omitted while no adapter advertises them. */}
                {caps.effortLevels && caps.effortLevels.length > 0 && (
                  <div className="flex items-center overflow-hidden rounded-md border border-bg-border">
                    {caps.effortLevels.map((level) => (
                      <span key={level} className="px-1.5 py-0.5 text-chip text-text-muted">
                        {level}
                      </span>
                    ))}
                  </div>
                )}

                <Tooltip content="Send (Enter)">
                  <button
                    type="button"
                    onClick={submitChat}
                    disabled={!input.trim() || (isActive && !caps.canCancelTurn)}
                    aria-label="Send"
                    className="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-accent-green text-bg-primary transition-colors hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-30 motion-reduce:transition-none"
                  >
                    <ArrowUp size={14} />
                  </button>
                </Tooltip>
              </div>
            </div>
          </div>

          {statusline && (
            <div className="mt-1.5 px-1 font-mono text-meta text-text-faint">{statusline}</div>
          )}
        </div>
      </div>
    );
  }

  // ─── Launch variant shell ─────────────────────────────────────────────
  if (!launch) return null; // unreachable — `variant` is a closed union
  const agentMode = launch.agentMode ?? "agent";
  const composerMode = launch.composerMode ?? "local";

  return (
    <div className="composer-zone flex flex-1 flex-col items-center justify-center px-8">
      {/* Same three-part shell as the chat composer — context strip on top,
          input card below, controls in a composer row — so the empty state and
          a live conversation read as one object rather than two designs. */}
      <div className="w-full max-w-composer">
        <div className="flex items-center gap-1.5 rounded-t-xl border border-b-0 border-bg-border bg-bg-secondary px-2 py-0.5">
          <ProjectPicker selectedRepo={selectedRepo} setSelectedRepo={setSelectedRepo} />
        </div>

        <div
          className={`relative rounded-b-xl border bg-bg-tertiary transition-colors motion-reduce:transition-none ${
            dragActive
              ? "border-accent-green ring-2 ring-accent-green/30"
              : "border-bg-border focus-within:border-accent-green/50"
          }`}
          onDrop={handleDrop}
          onDragEnter={handleDragEnter}
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
        >
          {/* Popovers positioned above the textarea. */}
          {popovers}

          {staged.length > 0 && <div className="px-4 pt-3">{stagedChips}</div>}

          {textarea}

          <div className="flex flex-col gap-2 border-t border-bg-border/50 px-3 py-2">
            <div className="flex items-center justify-between gap-2">
              <div className="flex flex-wrap items-center gap-2">
                <ProviderPicker
                  selectedAgent={launch.selectedAgent}
                  onAgentChange={launch.onAgentChange}
                  onModelChange={launch.onModelChange}
                  authStatus={authStatus}
                  refreshAuthStatuses={refreshAuthStatuses}
                />
                <ModelSelector
                  selectedAgent={launch.selectedAgent}
                  selectedModel={launch.selectedModel}
                  onModelChange={launch.onModelChange}
                  ollamaModels={ollamaModels}
                  refreshOllamaModels={refreshOllamaModels}
                  requiresTools
                />
              </div>

              <ActionButtons
                isSupported={voice.isSupported}
                isListening={voice.isListening}
                startListening={voice.startListening}
                stopListening={voice.stopListening}
                launchReady={launchReady}
                launchLabel={launchLabel}
                launchTitle={
                  launchReady
                    ? "Launch (Enter)"
                    : selectedAuth && selectedAuth !== "loading"
                      ? selectedAuth.hint || launchLabel
                      : launchLabel
                }
                onLaunch={submitLaunch}
              />
            </div>

            <AdvancedAccordion
              summary={[
                {
                  label: agentMode === "agent" ? null : MODE_META[agentMode].label,
                },
                {
                  // Profile: "default" here means the built-in default —
                  // picking any profile also pins it as `defaultProfileId`,
                  // so we can't use that flag. Truncate long names so the
                  // summary stays one line.
                  label:
                    !activeProfile || activeProfile.id === "builtin-default"
                      ? null
                      : activeProfile.name,
                  maxChars: 12,
                },
                {
                  label: composerMode === "local" ? null : "Worktree",
                },
              ]}
              forceOpenOnFirstMount={
                agentMode !== "agent" ||
                (!!activeProfile && activeProfile.id !== "builtin-default") ||
                composerMode !== "local"
              }
            >
              <ModeSelector value={agentMode} onChange={launch.onAgentModeChange} />
              <ProfilePicker
                profiles={profiles}
                selectedProfileId={launch.selectedProfileId}
                activeProfile={activeProfile}
                onProfileChange={launch.onProfileChange}
                setDefaultProfile={setDefaultProfile}
              />
              {selectedRepo && !isSshUri(selectedRepo) && (
                <ComposerModePicker value={composerMode} onChange={launch.onComposerModeChange} />
              )}
            </AdvancedAccordion>
          </div>
        </div>

        <p className="mt-1.5 px-1 text-center font-mono text-meta text-text-faint">
          {COMPOSER_HELP_TEXT}
        </p>
      </div>
    </div>
  );
}
