import {
  useState,
  useRef,
  useEffect,
  useLayoutEffect,
  useId,
  useMemo,
  createContext,
  useContext,
  Children,
  isValidElement,
  cloneElement,
  type ReactNode,
  type ReactElement,
} from "react";
import { ChevronDown } from "lucide-react";

interface DropdownContextValue {
  close: () => void;
  /** Lower-cased + trimmed, for case-insensitive item matching. */
  filter: string;
}

const DropdownContext = createContext<DropdownContextValue>({
  close: () => {},
  filter: "",
});

interface DropdownProps {
  trigger: ReactNode;
  children: ReactNode;
  align?: "left" | "right";
  searchable?: boolean;
  searchPlaceholder?: string;
  /** Imperative "open now" channel: incrementing this counter opens the
   * menu (e.g. the `/model` slash command targeting the header model
   * dropdown). Leave undefined for purely click-driven dropdowns. */
  openSignal?: number;
  onOpen?: () => void;
  /**
   * Rendered after the items, and handed the search text AS TYPED (trimmed,
   * case preserved — `MiniMax-M3` does not survive the lower-cased matching
   * needle).
   *
   * Exists so a menu can offer an action over what the user typed rather than
   * only over what it already lists: the model picker's free-text "Use …" row,
   * which is what keeps a model published this morning reachable before any
   * catalog — bundled or live — has heard of it. Return a `DropdownItem` and it
   * closes the menu on click like any other row.
   *
   * A prop rather than an exported `useDropdownFilter` hook purely to keep this
   * file's exports component-only; `react-refresh/only-export-components`
   * already warns about `useDropdownClose` and a second one is not worth it.
   */
  footer?: (searchText: string) => ReactNode;
}

/**
 * Access the enclosing Dropdown's `close()` from arbitrary content rendered
 * inside it (e.g. a menu section that needs to close its parent after an
 * async action). Outside a Dropdown the context default `close` is a no-op —
 * deliberate, so tests can render menu section content bare.
 */
export function useDropdownClose(): () => void {
  return useContext(DropdownContext).close;
}

function stringifyChildren(node: ReactNode): string {
  if (node == null || node === false || node === true) return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(stringifyChildren).join("");
  if (isValidElement(node)) {
    const props = node.props as { children?: ReactNode } | undefined;
    return stringifyChildren(props?.children);
  }
  return "";
}

function isDropdownItemElement(node: ReactNode): node is ReactElement<DropdownItemProps> {
  return isValidElement(node) && node.type === DropdownItem;
}

function filterItems(
  children: ReactNode,
  filter: string,
): { nodes: ReactNode; count: number; hasItems: boolean } {
  let count = 0;
  let hasItems = false;
  const nodes = Children.map(children, (child) => {
    if (isDropdownItemElement(child)) {
      hasItems = true;
      if (filter && !stringifyChildren(child.props.children).toLowerCase().includes(filter))
        return null;
      count += 1;
      return child;
    }
    if (!isValidElement<{ children?: ReactNode }>(child) || !child.props.children) return child;
    const nested = filterItems(child.props.children, filter);
    count += nested.count;
    hasItems ||= nested.hasItems;
    if (!nested.hasItems) return child;
    if (filter && nested.count === 0) return null;
    return cloneElement(child, { children: nested.nodes });
  });
  return { nodes, count, hasItems };
}

export function Dropdown({
  trigger,
  children,
  align = "left",
  searchable = false,
  searchPlaceholder = "Search…",
  openSignal,
  onOpen,
  footer,
}: DropdownProps) {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (openSignal !== undefined && openSignal > 0) setOpen(true);
  }, [openSignal]);
  const [filter, setFilter] = useState("");
  const ref = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const menuId = useId();
  const onOpenRef = useRef(onOpen);
  onOpenRef.current = onOpen;
  const [position, setPosition] = useState({ top: 0, left: 0, maxHeight: 400, minWidth: 160 });

  useEffect(() => {
    if (open) onOpenRef.current?.();
  }, [open]);

  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, []);

  // Reset filter when menu closes; focus input when it opens
  useEffect(() => {
    if (!open) {
      setFilter("");
    } else if (searchable) {
      // defer focus until after the input is mounted
      const id = window.setTimeout(() => {
        searchInputRef.current?.focus();
      }, 0);
      return () => window.clearTimeout(id);
    }
  }, [open, searchable]);

  const normalizedFilter = filter.trim().toLowerCase();

  const filtered = useMemo(
    () => filterItems(children, searchable ? normalizedFilter : ""),
    [children, searchable, normalizedFilter],
  );

  useLayoutEffect(() => {
    if (!open) return;
    const updatePosition = () => {
      const trigger = triggerRef.current;
      const menu = menuRef.current;
      if (!trigger || !menu) return;
      const rect = trigger.getBoundingClientRect();
      const width = window.innerWidth;
      const height = window.innerHeight;
      const margin = 8;
      const gap = 4;
      const minWidth = Math.min(Math.max(160, rect.width), Math.max(0, width - margin * 2));
      const menuWidth = Math.min(
        Math.max(minWidth, menu.getBoundingClientRect().width),
        Math.max(0, width - margin * 2),
      );
      const above = Math.max(0, rect.top - margin - gap);
      const below = Math.max(0, height - rect.bottom - margin - gap);
      const naturalHeight = Math.min(menu.scrollHeight || 320, 400);
      const upward = below < naturalHeight && above > below;
      const maxHeight = Math.min(400, upward ? above : below);
      const top = upward ? rect.top - gap - Math.min(naturalHeight, maxHeight) : rect.bottom + gap;
      const left = Math.max(
        margin,
        Math.min(
          align === "right" ? rect.right - menuWidth : rect.left,
          width - menuWidth - margin,
        ),
      );
      setPosition((previous) =>
        previous.top === top &&
        previous.left === left &&
        previous.maxHeight === maxHeight &&
        previous.minWidth === minWidth
          ? previous
          : { top, left, maxHeight, minWidth },
      );
    };
    updatePosition();
    window.addEventListener("resize", updatePosition);
    document.addEventListener("scroll", updatePosition, true);
    const observer =
      typeof ResizeObserver === "undefined" ? null : new ResizeObserver(updatePosition);
    if (menuRef.current) observer?.observe(menuRef.current);
    if (triggerRef.current) observer?.observe(triggerRef.current);
    return () => {
      window.removeEventListener("resize", updatePosition);
      document.removeEventListener("scroll", updatePosition, true);
      observer?.disconnect();
    };
  }, [open, align, filtered]);

  const contextValue = useMemo<DropdownContextValue>(
    () => ({
      close: () => {
        setOpen(false);
        triggerRef.current?.focus();
      },
      filter: searchable ? normalizedFilter : "",
    }),
    [searchable, normalizedFilter],
  );

  const handleSearchKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      if (filter !== "") {
        setFilter("");
      } else {
        setOpen(false);
        triggerRef.current?.focus();
      }
    }
  };

  return (
    <div ref={ref} className="relative">
      <button
        ref={triggerRef}
        type="button"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={() => setOpen((previous) => !previous)}
        className="flex items-center gap-1 rounded px-2 py-1 text-ui text-text-secondary transition-colors hover:bg-bg-hover hover:text-text-primary"
      >
        {trigger}
        <ChevronDown size={10} className={`transition-transform ${open ? "rotate-180" : ""}`} />
      </button>
      {open && (
        <DropdownContext.Provider value={contextValue}>
          <div
            ref={menuRef}
            id={menuId}
            role="group"
            aria-label="Dropdown options"
            data-dropdown-menu
            style={{
              position: "fixed",
              ...position,
              width: "max-content",
              maxWidth: "calc(100vw - 16px)",
              overflowY: "auto",
              zIndex: 1000,
            }}
            className="rounded-md border border-bg-border bg-bg-elevated py-1 shadow-xl"
            onKeyDown={(event) => {
              if (event.key === "Escape" && !event.defaultPrevented) {
                event.preventDefault();
                event.stopPropagation();
                setOpen(false);
                triggerRef.current?.focus();
              }
            }}
          >
            {searchable && (
              <div className="sticky top-0 z-10 bg-bg-elevated px-1 pb-1">
                <input
                  ref={searchInputRef}
                  type="text"
                  value={filter}
                  onChange={(e) => setFilter(e.target.value)}
                  onKeyDown={handleSearchKeyDown}
                  placeholder={searchPlaceholder}
                  aria-label={searchPlaceholder}
                  className="w-full rounded border border-bg-border bg-bg-primary px-2 py-1 text-ui text-text-primary placeholder:text-text-muted focus:border-accent-green focus:outline-none"
                />
              </div>
            )}
            {filtered.nodes}
            {searchable && normalizedFilter !== "" && filtered.count === 0 && (
              <div className="px-2 py-1 text-ui text-text-muted">No matches</div>
            )}
            {footer?.(searchable ? filter.trim() : "")}
          </div>
        </DropdownContext.Provider>
      )}
    </div>
  );
}

interface DropdownItemProps {
  onClick?: () => void;
  children: ReactNode;
}

export function DropdownItem({ onClick, children }: DropdownItemProps) {
  const { close, filter } = useContext(DropdownContext);
  const hidden = useMemo(() => {
    if (!filter) return false;
    const text = stringifyChildren(children).toLowerCase();
    return !text.includes(filter);
  }, [children, filter]);

  if (hidden) return null;

  return (
    <button
      type="button"
      onClick={() => {
        onClick?.();
        close();
      }}
      className="w-full px-3 py-1.5 text-left text-ui text-text-primary transition-colors hover:bg-bg-hover"
    >
      {children}
    </button>
  );
}
