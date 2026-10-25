import {
  ReactNode,
  useCallback,
  useRef,
  useState,
  MouseEvent as ReactMouseEvent,
} from "react";
import { useAgentTaskStore } from "@/stores/agentTaskStore";
import { launchDraftKey, useAgentDraftStore } from "@/stores/agentDraftStore";
import { PathContextMenu } from "./PathContextMenu";

/**
 * Matches `path/to/file.ext` or `path/to/file.ext:NN` tokens. The trailing
 * `:line` is optional and parsed separately. Whitespace and backticks
 * terminate the match so we don't pull in surrounding markdown chrome.
 */
const PATH_REGEX =
  /([^\s`'"()<>]+\.(?:ts|tsx|js|jsx|rs|md|json|toml|yml|yaml|py|go|java|sh|html|css))(?::(\d+))?/g;

interface MenuState {
  x: number;
  y: number;
  path: string;
  line?: number;
}

interface ClickablePathsRootProps {
  /** Optional project root used to resolve bare relative paths if needed. */
  projectPath?: string;
  children: ReactNode;
  /** Optional className passthrough for the wrapper div */
  className?: string;
  /** Optional left-click handler for Markdown paths. */
  onOpenMarkdown?: (path: string, line?: number) => void;
  /** D3 / P0-4: paths in this subtree belong to an SSH-backed conversation, so
   * the context menu's local-disk actions are disabled. */
  remote?: boolean;
}

/**
 * Use the browser's caret APIs (with vendor fallbacks) to find the text node
 * and offset under a viewport coordinate. Returns null if neither API is
 * available or the point isn't inside text.
 */
function caretFromPoint(
  x: number,
  y: number,
): { node: Node; offset: number } | null {
  // Standardized API (Firefox, modern Safari).
  type DocWithCaret = Document & {
    caretPositionFromPoint?: (x: number, y: number) =>
      | { offsetNode: Node; offset: number }
      | null;
    caretRangeFromPoint?: (x: number, y: number) => Range | null;
  };
  const d = document as DocWithCaret;

  if (typeof d.caretPositionFromPoint === "function") {
    const pos = d.caretPositionFromPoint(x, y);
    if (pos && pos.offsetNode) {
      return { node: pos.offsetNode, offset: pos.offset };
    }
  }
  // WebKit/Chromium legacy fallback.
  if (typeof d.caretRangeFromPoint === "function") {
    const range = d.caretRangeFromPoint(x, y);
    if (range) {
      return { node: range.startContainer, offset: range.startOffset };
    }
  }
  return null;
}

/**
 * Given the text content of a node and a caret offset, find a path-like
 * token straddling that offset. Returns the matched path and optional line.
 */
function extractPathAt(
  text: string,
  offset: number,
): { path: string; line?: number } | null {
  PATH_REGEX.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = PATH_REGEX.exec(text)) !== null) {
    const start = m.index;
    const end = start + m[0].length;
    if (offset >= start && offset <= end) {
      return {
        path: m[1],
        line: m[2] ? parseInt(m[2], 10) : undefined,
      };
    }
  }
  return null;
}

/**
 * Wrapper that detects right-clicks on `file/path[:line]` tokens within its
 * children and pops a `PathContextMenu`. Uses event delegation — no
 * per-token DOM mutation — so it's safe to wrap streaming markdown output.
 *
 * Detection strategy:
 *   1. caretPositionFromPoint / caretRangeFromPoint to find the clicked
 *      text node + offset, then regex-scan the node's textContent for a
 *      straddling path token.
 *   2. Fallback: if no caret API is available or no token straddles the
 *      caret, use `window.getSelection()` if the user has highlighted
 *      something path-shaped.
 *   3. Otherwise: no-op (let the native context menu surface).
 */
export function ClickablePathsRoot({
  children,
  className,
  projectPath,
  onOpenMarkdown,
  remote = false,
}: ClickablePathsRootProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const [menu, setMenu] = useState<MenuState | null>(null);

  const handleAttach = useCallback((path: string) => {
    const { selectedConversationId, selectedRepo } = useAgentTaskStore.getState();
    // Both composers keep their text in the draft store: inside a chat the
    // mention lands in that conversation's draft; otherwise it goes to the
    // launch composer's project-scoped slot. Either way, no bleed across
    // composers.
    const { drafts, setDraft } = useAgentDraftStore.getState();
    const key = selectedConversationId ?? launchDraftKey(selectedRepo);
    const prev = drafts[key] ?? "";
    const sep = prev.length === 0 || prev.endsWith(" ") ? "" : " ";
    setDraft(key, `${prev}${sep}@${path} `);
  }, []);

  const onContextMenu = useCallback((e: ReactMouseEvent<HTMLDivElement>) => {
    // Try caret-based extraction first.
    const caret = caretFromPoint(e.clientX, e.clientY);
    let found: { path: string; line?: number } | null = null;

    if (caret && caret.node.nodeType === Node.TEXT_NODE) {
      const text = caret.node.textContent ?? "";
      found = extractPathAt(text, caret.offset);
    }

    // Fallback: use the user's selection if it looks like a path token.
    if (!found) {
      const sel = window.getSelection?.()?.toString().trim() ?? "";
      if (sel) {
        PATH_REGEX.lastIndex = 0;
        const m = PATH_REGEX.exec(sel);
        if (m && m[0] === sel) {
          found = { path: m[1], line: m[2] ? parseInt(m[2], 10) : undefined };
        }
      }
    }

    if (!found) {
      // Let the native menu through — nothing actionable here.
      return;
    }

    e.preventDefault();
    e.stopPropagation();
    setMenu({
      x: e.clientX,
      y: e.clientY,
      path: found.path,
      line: found.line,
    });
  }, []);

  const onClick = useCallback((e: ReactMouseEvent<HTMLDivElement>) => {
    if (!onOpenMarkdown) return;
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) {
      return;
    }

    const caret = caretFromPoint(e.clientX, e.clientY);
    if (!caret || caret.node.nodeType !== Node.TEXT_NODE) return;

    const text = caret.node.textContent ?? "";
    const found = extractPathAt(text, caret.offset);
    if (!found || !/\.mdx?$/i.test(found.path)) return;

    e.preventDefault();
    e.stopPropagation();
    onOpenMarkdown(found.path, found.line);
  }, [onOpenMarkdown]);

  return (
    <div
      ref={rootRef}
      className={className}
      onClick={onClick}
      onContextMenu={onContextMenu}
      style={{ display: "contents" }}
    >
      {children}
      {menu && (
        <PathContextMenu
          x={menu.x}
          y={menu.y}
          path={menu.path}
          line={menu.line}
          onClose={() => setMenu(null)}
          onAttach={handleAttach}
          projectPath={projectPath}
          remote={remote}
        />
      )}
    </div>
  );
}

export default ClickablePathsRoot;
