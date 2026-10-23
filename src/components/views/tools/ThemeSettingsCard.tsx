import { Moon, Sun, Palette } from "lucide-react";
import { useAppStore } from "@/stores/appStore";

export function ThemeSettingsCard() {
  const theme = useAppStore((s) => s.theme);
  const setTheme = useAppStore((s) => s.setTheme);

  return (
    <div className="bg-bg-secondary border border-bg-border rounded-lg p-4">
      <h3 className="text-xs font-semibold text-text-primary mb-3 flex items-center gap-2">
        <Palette size={12} className="text-accent-green" />
        Theme
      </h3>

      <p className="mb-3 text-meta text-text-muted leading-snug">
        Choose between dark and light visual themes.
      </p>

      <div className="inline-flex items-center gap-1 bg-bg-primary border border-bg-border rounded-lg p-1">
        <ThemeButton
          label="Dark"
          icon={<Moon size={12} />}
          active={theme === "dark"}
          onClick={() => setTheme("dark")}
        />
        <ThemeButton
          label="Light"
          icon={<Sun size={12} />}
          active={theme === "light"}
          onClick={() => setTheme("light")}
        />
      </div>
    </div>
  );
}

function ThemeButton({
  label,
  icon,
  active,
  onClick,
}: {
  label: string;
  icon: React.ReactNode;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`flex items-center gap-1.5 px-3 py-1.5 text-ui rounded border transition-colors ${
        active
          ? "bg-accent-green/15 text-accent-green border-accent-green/30"
          : "bg-bg-secondary text-text-secondary border-bg-border hover:text-text-primary"
      }`}
    >
      {icon}
      {label}
    </button>
  );
}
