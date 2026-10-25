import { Mic, Send } from "lucide-react";

interface ActionButtonsProps {
  isSupported: boolean;
  isListening: boolean;
  startListening: () => void;
  stopListening: () => void;
  launchReady: boolean;
  launchLabel: string;
  launchTitle: string;
  onLaunch: () => void;
}

export function ActionButtons({
  isSupported,
  isListening,
  startListening,
  stopListening,
  launchReady,
  launchLabel,
  launchTitle,
  onLaunch,
}: ActionButtonsProps) {
  return (
    <div className="flex items-center gap-1">
      {isSupported && (
        <button
          type="button"
          aria-label={isListening ? "Stop voice input" : "Voice input"}
          onClick={isListening ? stopListening : startListening}
          className={`grid h-8 w-8 place-items-center rounded-full transition-colors ${
            isListening
              ? "bg-accent-green/20 text-accent-green animate-pulse"
              : "text-text-muted hover:text-text-primary"
          }`}
          title={isListening ? "Stop listening" : "Voice input"}
        >
          <Mic size={14} />
        </button>
      )}

      {/* Launch button — gated on provider auth status. The submitInFlight
          guard inside `onLaunch` blocks rapid mashing across both Enter and
          click paths. */}
      <button
        onClick={() => {
          if (launchReady) onLaunch();
        }}
        disabled={!launchReady}
        title={launchTitle}
        className="flex items-center gap-1 px-3 py-1.5 rounded text-ui font-medium transition-colors bg-accent-green/20 text-accent-green hover:bg-accent-green/30 disabled:opacity-40 disabled:cursor-not-allowed"
      >
        <Send size={10} />
        {launchLabel}
      </button>
    </div>
  );
}
