import {
  useState,
  useRef,
  useId,
  useCallback,
  cloneElement,
  type ReactNode,
  type ReactElement,
} from "react";
import { createPortal } from "react-dom";

type TooltipSide = "top" | "bottom" | "left" | "right";

interface TooltipProps {
  content: ReactNode;
  children: ReactElement;
  side?: TooltipSide;
  /** Hover/focus dwell before the tooltip appears, in ms. */
  delay?: number;
}

interface Coords {
  left: number;
  top: number;
}

// Gap between the trigger and the tooltip, in px.
const OFFSET = 6;

// Translate the anchor point onto the tooltip box depending on side.
const TRANSFORM: Record<TooltipSide, string> = {
  top: "translate(-50%, -100%)",
  bottom: "translate(-50%, 0)",
  left: "translate(-100%, -50%)",
  right: "translate(0, -50%)",
};

/**
 * Hover/focus tooltip that replaces native `title=`. Wrap a single focusable
 * element: <Tooltip content="…"><button/></Tooltip>. The tooltip renders into a
 * portal so it is never clipped by overflow containers, and wires
 * aria-describedby onto the child for screen readers.
 */
export function Tooltip({ content, children, side = "top", delay = 400 }: TooltipProps) {
  const [coords, setCoords] = useState<Coords | null>(null);
  const [shown, setShown] = useState(false);
  const anchorRef = useRef<HTMLSpanElement>(null);
  const timerRef = useRef<number | null>(null);
  const tipId = useId();

  const clearTimer = () => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  };

  const position = useCallback((): Coords | null => {
    const el = anchorRef.current;
    if (!el) return null;
    const r = el.getBoundingClientRect();
    switch (side) {
      case "bottom":
        return { left: r.left + r.width / 2, top: r.bottom + OFFSET };
      case "left":
        return { left: r.left - OFFSET, top: r.top + r.height / 2 };
      case "right":
        return { left: r.right + OFFSET, top: r.top + r.height / 2 };
      case "top":
      default:
        return { left: r.left + r.width / 2, top: r.top - OFFSET };
    }
  }, [side]);

  const show = useCallback(() => {
    clearTimer();
    timerRef.current = window.setTimeout(() => {
      const next = position();
      if (!next) return;
      setCoords(next);
      // Mount at opacity-0, then flip on the next frame so the fade-in runs.
      requestAnimationFrame(() => setShown(true));
    }, delay);
  }, [delay, position]);

  const hide = useCallback(() => {
    clearTimer();
    setShown(false);
    setCoords(null);
  }, []);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key !== "Escape") return;
    // Only claim the keypress when there is actually a tooltip to dismiss, and
    // then mark it handled so one Escape does not also unwind the layer behind
    // it (an open dialog, or a zoomed pane).
    if (!shown && !coords) return;
    e.preventDefault();
    hide();
  };

  // Preserve any `aria-describedby` the trigger already carries so the tooltip
  // supplements its description instead of clobbering it. The tip id is added
  // while the tooltip is mounted (focus/hover reveal), so a screen reader
  // always resolves it against the live portal content.
  const existingDescribedBy = (children.props as { "aria-describedby"?: string })[
    "aria-describedby"
  ];
  const describedBy = coords
    ? [existingDescribedBy, tipId].filter(Boolean).join(" ") || undefined
    : existingDescribedBy;

  const child = cloneElement(children as ReactElement<{ "aria-describedby"?: string }>, {
    "aria-describedby": describedBy,
  });

  return (
    <>
      <span
        ref={anchorRef}
        className="inline-flex"
        onMouseEnter={show}
        onMouseLeave={hide}
        onFocus={show}
        onBlur={hide}
        onKeyDown={onKeyDown}
      >
        {child}
      </span>
      {coords &&
        createPortal(
          <span
            id={tipId}
            role="tooltip"
            className={`pointer-events-none fixed z-[60] max-w-xs whitespace-normal rounded border border-line-strong bg-bg-elevated px-2 py-1 text-ui text-text-secondary shadow-lg transition-opacity motion-reduce:transition-none ${shown ? "opacity-100" : "opacity-0"}`}
            style={{ left: coords.left, top: coords.top, transform: TRANSFORM[side] }}
          >
            {content}
          </span>,
          document.body,
        )}
    </>
  );
}
