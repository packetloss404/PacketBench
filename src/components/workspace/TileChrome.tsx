import { useContext, type ReactNode } from "react";
import { GripHorizontal, Maximize2, Minimize2, X } from "lucide-react";
import { MosaicWindowContext } from "react-mosaic-component";

interface TileChromeProps {
  title: string;
  titleTooltip?: string;
  titleClassName?: string;
  icon?: ReactNode;
  identityDetails?: ReactNode;
  status?: { label: string; className: string; title?: string };
  isZoomed: boolean;
  onToggleZoom: () => void;
  shortcutHint?: string;
  close?: { label: string; tooltip: string; onClick: () => void };
  /** Pane-specific controls follow the shared zoom control. */
  children?: ReactNode;
}

const CONTROL_SELECTOR = 'button, a, input, textarea, select, [role="menuitem"], [contenteditable]';

/** Tile-layer chrome only: bodies retain their existing mount and lifecycle. */
export function TileChrome({
  title,
  titleTooltip,
  titleClassName = "text-text-primary",
  icon,
  identityDetails,
  status,
  isZoomed,
  onToggleZoom,
  shortcutHint,
  close,
  children,
}: TileChromeProps) {
  const actions = useContext(MosaicWindowContext)?.mosaicWindowActions;
  const zoomLabel = isZoomed ? "Exit zoom" : "Zoom to focus";
  const chrome = (
    <div
      role="group"
      aria-label={`${title} pane controls`}
      className="flex min-w-0 shrink-0 cursor-grab select-none items-center gap-2 border-b border-line-soft bg-bg-secondary px-2 py-1 active:cursor-grabbing"
      onDoubleClick={(event) => {
        if (event.target instanceof Element && event.target.closest(CONTROL_SELECTOR)) return;
        onToggleZoom();
      }}
    >
      <span
        className="shrink-0 text-text-muted"
        title={`Drag to rearrange. Double-click the header to toggle zoom.${shortcutHint ? ` ${shortcutHint}` : ""}`}
      >
        <GripHorizontal size={11} aria-hidden="true" />
      </span>
      {icon}
      <span
        className={`min-w-0 truncate text-ui font-semibold ${titleClassName}`}
        title={titleTooltip ?? title}
      >
        {title}
      </span>
      {identityDetails}
      <div className="min-w-0 flex-1" />
      {status && (
        <span
          className={`shrink-0 rounded-full px-1.5 py-0.5 font-mono text-meta ${status.className}`}
          title={status.title}
        >
          {status.label}
        </span>
      )}
      <button
        type="button"
        aria-label={`${zoomLabel}: ${title}`}
        aria-pressed={isZoomed}
        title={zoomLabel}
        onClick={(event) => {
          event.stopPropagation();
          onToggleZoom();
        }}
        onMouseDown={(event) => event.stopPropagation()}
        className="shrink-0 rounded p-0.5 text-text-muted transition-colors hover:text-accent-blue focus-visible:outline focus-visible:outline-1 focus-visible:outline-accent-blue"
      >
        {isZoomed ? (
          <Minimize2 size={11} aria-hidden="true" />
        ) : (
          <Maximize2 size={11} aria-hidden="true" />
        )}
      </button>
      {children && (
        <div
          className="contents"
          onMouseDown={(event) => event.stopPropagation()}
          onDoubleClick={(event) => event.stopPropagation()}
        >
          {children}
        </div>
      )}
      {close && (
        <button
          type="button"
          aria-label={close.label}
          title={close.tooltip}
          onClick={(event) => {
            event.stopPropagation();
            close.onClick();
          }}
          onMouseDown={(event) => event.stopPropagation()}
          className="shrink-0 rounded p-0.5 text-text-muted transition-colors hover:text-accent-red focus-visible:outline focus-visible:outline-1 focus-visible:outline-accent-red"
        >
          <X size={11} aria-hidden="true" />
        </button>
      )}
    </div>
  );
  return actions?.connectDragSource(chrome) ?? chrome;
}
