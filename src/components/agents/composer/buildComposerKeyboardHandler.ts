import type { RefObject } from "react";
import type { AgentMessage } from "@/types/agent-conversation";
import type { UsePrefixMatcherResult } from "../hooks/usePrefixMatcher";
import type { SlashItem } from "./slashCommandSource";

/** Shell-style ↑/↓ prompt-history recall — chat variant only (the launch
 * composer has no prior turns to recall). */
export interface ComposerHistoryDeps {
  messages: AgentMessage[];
  historyIndex: number;
  setHistoryIndex: (n: number) => void;
  historySourceRef: { current: "user" | "history" };
  /** Draft that existed before the first ArrowUp recall. */
  historyDraftRef: { current: string };
}

export interface ComposerKeyboardDeps {
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  input: string;
  setInput: (s: string) => void;
  /** `@` file-mention trigger state machine (usePrefixMatcher). */
  mention: Pick<UsePrefixMatcherResult, "state" | "moveHighlight" | "close">;
  /** Current async file-mention results, read synchronously via ref so
   * Enter/ArrowDown never race the directory scan or touch the DOM. */
  getMentionItems: () => string[];
  insertMentionPath: (path: string) => void;
  /** `/` slash-command trigger state machine (usePrefixMatcher). */
  slash: Pick<UsePrefixMatcherResult, "state" | "moveHighlight" | "close">;
  /** THE slash list — the same array the popover renders (single source of
   * truth), so keyboard resolution can never disagree with what's on screen. */
  slashItems: SlashItem[];
  pickSlashItem: (item: SlashItem) => void;
  submit: () => void;
  history?: ComposerHistoryDeps;
  /** Shift+Tab mode-chip cycle — chat variant only. */
  cycleMode?: () => void;
}

/**
 * Builds the textarea keyDown handler shared by BOTH composer variants:
 * popover-aware mention/slash navigation, optional shell-style ↑/↓ history,
 * optional Shift+Tab mode cycle, Enter/Ctrl+Enter submit. Bare Tab is
 * deliberately NOT handled outside the popovers so it keeps its native
 * focus-navigation behavior; Shift+Enter falls through for a newline.
 *
 * While a popover is open, Enter/Tab always either pick the highlighted row
 * or (empty list) dismiss the popover — a half-typed `@query` / `/command`
 * is never submitted by the same keystroke.
 *
 * Not a hook itself (doesn't call React internals) — naming follows
 * factory-style helpers.
 */
export function buildComposerKeyboardHandler(deps: ComposerKeyboardDeps) {
  const {
    textareaRef,
    input,
    setInput,
    mention,
    getMentionItems,
    insertMentionPath,
    slash,
    slashItems,
    pickSlashItem,
    submit,
    history,
    cycleMode,
  } = deps;

  return function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    // IME candidate confirmation owns Enter/Escape/arrows. Acting on them here
    // sends partial text or mutates history while the composition is live.
    const native = e.nativeEvent as (KeyboardEvent & { isComposing?: boolean }) | undefined;
    const synthetic = e as { isComposing?: boolean };
    if (synthetic.isComposing || native?.isComposing || e.keyCode === 229) return;

    if (slash.state.active) {
      if (e.key === "Escape") {
        e.preventDefault();
        slash.close();
        return;
      }
      if (e.key === "ArrowDown") {
        e.preventDefault();
        slash.moveHighlight(1, slashItems.length);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        slash.moveHighlight(-1, slashItems.length);
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        // Always swallow Enter/Tab while the popover is open so an unmatched
        // `/xyz` is never sent as a literal message; an empty list dismisses
        // the popover so the NEXT Enter can submit.
        e.preventDefault();
        const pick = slashItems[slash.state.highlightedIndex] ?? slashItems[0];
        if (pick) pickSlashItem(pick);
        else slash.close();
        return;
      }
    }

    if (mention.state.active) {
      const items = getMentionItems();
      if (e.key === "Escape") {
        e.preventDefault();
        mention.close();
        return;
      }
      if (e.key === "ArrowDown") {
        e.preventDefault();
        mention.moveHighlight(1, items.length);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        mention.moveHighlight(-1, items.length);
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        // Results are async — swallow so a half-typed `@query` is never sent
        // because the scan hasn't landed yet; empty list dismisses instead.
        e.preventDefault();
        const pick = items[mention.state.highlightedIndex] ?? items[0];
        if (pick !== undefined) insertMentionPath(pick);
        else mention.close();
        return;
      }
    }

    // Shell-style ↑/↓ history. Only triggers when no popover is open and
    // either the composer is empty or the caret is at the very start so it
    // doesn't fight multiline editing.
    if (
      history &&
      !mention.state.active &&
      !slash.state.active &&
      !e.ctrlKey &&
      !e.altKey &&
      !e.metaKey &&
      !e.shiftKey
    ) {
      const { messages, historyIndex, setHistoryIndex, historySourceRef, historyDraftRef } =
        history;
      const ta = textareaRef.current;
      const caretAtStart = !!ta && ta.selectionStart === 0 && ta.selectionEnd === 0;
      const eligible = input.length === 0 || caretAtStart;
      const userMsgs = messages.filter((m) => m.role === "user").map((m) => m.content);

      if (e.key === "ArrowUp" && eligible && userMsgs.length > 0) {
        const nextIdx = Math.min(userMsgs.length - 1, historyIndex + 1);
        if (nextIdx !== historyIndex) {
          e.preventDefault();
          if (historyIndex < 0) historyDraftRef.current = input;
          setHistoryIndex(nextIdx);
          historySourceRef.current = "history";
          setInput(userMsgs[userMsgs.length - 1 - nextIdx]);
        }
        return;
      }
      if (e.key === "ArrowDown" && historyIndex >= 0) {
        // A user edit after recall switches ownership back to the draft; do
        // not overwrite that deliberate edit with older history.
        if (historySourceRef.current !== "history") return;
        e.preventDefault();
        const nextIdx = historyIndex - 1;
        setHistoryIndex(nextIdx);
        if (nextIdx < 0) {
          historySourceRef.current = "user";
          setInput(historyDraftRef.current);
        } else {
          historySourceRef.current = "history";
          setInput(userMsgs[userMsgs.length - 1 - nextIdx]);
        }
        return;
      }
      if (e.key === "Escape" && historyIndex >= 0) {
        e.preventDefault();
        setHistoryIndex(-1);
        historySourceRef.current = "user";
        setInput(historyDraftRef.current);
        return;
      }
    }

    if (cycleMode && e.shiftKey && e.key === "Tab") {
      e.preventDefault();
      cycleMode();
      return;
    }

    if (e.ctrlKey && e.key === "Enter") {
      e.preventDefault();
      submit();
      return;
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  };
}
