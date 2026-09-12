import { ShieldCheck, ShieldX, XCircle } from "lucide-react";
import type { RefObject } from "react";

interface ApprovalOverlayProps {
  onApprove: () => void;
  onDeny: () => void;
  onAbort: () => void;
  focusRef?: RefObject<HTMLDivElement | null>;
}

export function ApprovalOverlay({ onApprove, onDeny, onAbort, focusRef }: ApprovalOverlayProps) {
  return (
    <div
      ref={focusRef}
      tabIndex={-1}
      role="group"
      aria-label="Approval needed"
      className="absolute bottom-0 left-0 right-0 flex items-center gap-2 border-t border-accent-amber/30 bg-accent-amber/10 px-3 py-1.5 backdrop-blur-sm"
    >
      <ShieldCheck size={12} className="flex-shrink-0 text-accent-amber" />
      <span className="flex-1 text-[11px] font-medium text-accent-amber">Approval needed</span>
      <button
        onClick={onApprove}
        className="flex items-center gap-1 rounded bg-accent-green/20 px-2.5 py-1 text-[10px] font-medium text-accent-green transition-colors hover:bg-accent-green/30"
      >
        <ShieldCheck size={10} />
        Allow (y)
      </button>
      <button
        onClick={onDeny}
        className="flex items-center gap-1 rounded bg-accent-red/20 px-2.5 py-1 text-[10px] font-medium text-accent-red transition-colors hover:bg-accent-red/30"
      >
        <ShieldX size={10} />
        Deny (n)
      </button>
      <button
        onClick={onAbort}
        className="flex items-center gap-1 rounded bg-text-muted/20 px-2.5 py-1 text-[10px] font-medium text-text-secondary transition-colors hover:bg-text-muted/30"
      >
        <XCircle size={10} />
        Abort (Esc)
      </button>
    </div>
  );
}
