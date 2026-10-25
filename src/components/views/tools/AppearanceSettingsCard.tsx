import { Minus, Plus, SlidersHorizontal, RotateCcw } from "lucide-react";
import { APP_SCALE_STEPS, type AppScalePercent } from "@/lib/appearance";
import { useAppearanceStore } from "@/stores/appearanceStore";
import { useTerminalSettingsStore } from "@/stores/terminalSettingsStore";

export function AppearanceSettingsCard() {
  const preferences = useAppearanceStore((s) => s.preferences);
  const setUiScalePercent = useAppearanceStore((s) => s.setUiScalePercent);
  const setTranscriptFontSizePx = useAppearanceStore((s) => s.setTranscriptFontSizePx);
  const setDensity = useAppearanceStore((s) => s.setDensity);
  const resetTextAndLayout = useAppearanceStore((s) => s.resetTextAndLayout);
  const saveFailed = useAppearanceStore((s) => s.saveFailed);

  const terminalFontSizePx = useTerminalSettingsStore((s) => s.terminalFontSizePx);
  const setTerminalFontSizePx = useTerminalSettingsStore((s) => s.setTerminalFontSizePx);
  const resetTerminalFontSizePx = useTerminalSettingsStore((s) => s.resetTerminalFontSizePx);

  const readingPx = preferences.transcriptFontSizePx * (preferences.uiScalePercent / 100);

  return (
    <div className="rounded-lg border border-bg-border bg-bg-secondary p-4">
      <h3 className="mb-3 flex items-center gap-2 text-ui font-semibold text-text-primary">
        <SlidersHorizontal size={12} className="text-accent-green" />
        Appearance
      </h3>

      {saveFailed && (
        <p role="alert" className="mb-3 text-meta text-accent-amber">
          Changes apply now; saving preferences failed. Try again.
        </p>
      )}

      <div className="flex flex-col gap-4">
        <Field label="App scale">
          <div className="inline-flex flex-wrap items-center gap-1 rounded-lg border border-bg-border bg-bg-primary p-1">
            {APP_SCALE_STEPS.map((scale) => (
              <ScaleButton
                key={scale}
                value={scale}
                active={preferences.uiScalePercent === scale}
                onClick={() => setUiScalePercent(scale)}
              />
            ))}
          </div>
        </Field>

        <Field label="Reading text">
          <div className="flex items-center gap-2">
            <StepButton
              label="Decrease reading size"
              onClick={() => setTranscriptFontSizePx(preferences.transcriptFontSizePx - 1)}
            >
              <Minus size={12} />
            </StepButton>
            <span className="min-w-[2.5rem] text-center font-mono text-ui text-text-primary">
              {preferences.transcriptFontSizePx}
            </span>
            <StepButton
              label="Increase reading size"
              onClick={() => setTranscriptFontSizePx(preferences.transcriptFontSizePx + 1)}
            >
              <Plus size={12} />
            </StepButton>
            <span className="text-meta text-text-muted">
              Reading size: {preferences.transcriptFontSizePx}px × {preferences.uiScalePercent}% ={" "}
              {readingPx}px
            </span>
          </div>
        </Field>

        <Field label="Interface density">
          <div className="inline-flex items-center gap-1 rounded-lg border border-bg-border bg-bg-primary p-1">
            <DensityButton
              label="Comfortable"
              active={preferences.density === "comfortable"}
              onClick={() => setDensity("comfortable")}
            />
            <DensityButton
              label="Compact"
              active={preferences.density === "compact"}
              onClick={() => setDensity("compact")}
            />
          </div>
        </Field>

        <Field label="Terminal text size">
          <div className="flex items-center gap-2">
            <StepButton
              label="Decrease terminal size"
              onClick={() => setTerminalFontSizePx(terminalFontSizePx - 1)}
            >
              <Minus size={12} />
            </StepButton>
            <span className="min-w-[2.5rem] text-center font-mono text-ui text-text-primary">
              {terminalFontSizePx}
            </span>
            <StepButton
              label="Increase terminal size"
              onClick={() => setTerminalFontSizePx(terminalFontSizePx + 1)}
            >
              <Plus size={12} />
            </StepButton>
            <button
              type="button"
              onClick={resetTerminalFontSizePx}
              className="rounded px-2 py-0.5 text-meta text-text-secondary transition-colors hover:bg-bg-hover hover:text-text-primary"
            >
              Reset terminal text size
            </button>
          </div>
          <p className="mt-1 text-meta text-text-muted">
            Independent of App scale. Applies to Workspace terminals and terminal dialogs.
          </p>
        </Field>

        <div className="rounded-lg border border-bg-border bg-bg-primary p-3">
          <p className="text-meta text-text-muted">Sample</p>
          <p className="text-body text-text-primary">The quick brown fox</p>
          <p className="font-mono text-code text-accent-amber">const answer = 42;</p>
          <p className="text-ui text-accent-amber">Warning: this is a filename.txt</p>
        </div>

        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={resetTextAndLayout}
            className="inline-flex items-center gap-1.5 rounded bg-accent-green/15 px-3 py-1.5 text-ui font-medium text-accent-green transition-colors hover:bg-accent-green/25"
          >
            <RotateCcw size={12} />
            Reset text and layout
          </button>
          <span className="text-meta text-text-muted">
            Resets App scale, reading size, density and sidebar width. Keeps theme, terminal size,
            drafts and work.
          </span>
        </div>
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div role="group" aria-label={label} className="flex flex-col gap-1.5">
      <span className="text-ui font-medium text-text-secondary">{label}</span>
      {children}
    </div>
  );
}

function StepButton({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      onClick={onClick}
      className="flex h-8 w-8 items-center justify-center rounded border border-bg-border text-text-secondary transition-colors hover:bg-bg-hover hover:text-text-primary"
    >
      {children}
    </button>
  );
}

function ScaleButton({
  value,
  active,
  onClick,
}: {
  value: AppScalePercent;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`rounded px-2 py-1 text-ui transition-colors ${
        active
          ? "bg-accent-green/15 text-accent-green"
          : "text-text-secondary hover:bg-bg-hover hover:text-text-primary"
      }`}
    >
      {value}%
    </button>
  );
}

function DensityButton({
  label,
  active,
  onClick,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`rounded px-2.5 py-1 text-ui transition-colors ${
        active
          ? "bg-accent-green/15 text-accent-green"
          : "text-text-secondary hover:bg-bg-hover hover:text-text-primary"
      }`}
    >
      {label}
    </button>
  );
}
