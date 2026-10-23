import { create } from "zustand";
import { storageKey } from "@/lib/brand";
import { AUTO_TERMINAL_SHELL, normalizeTerminalShellSelection } from "@/lib/terminalShells";
import type { TerminalShellSelection } from "@/types/terminal-shell";

const DEFAULT_SHELL_KEY = storageKey("terminal-default-shell");
const FONT_SIZE_KEY = storageKey("terminal-font-size");

function clampFontSize(value: number): number {
  return Math.min(32, Math.max(10, Math.round(value)));
}

function loadFontSize(): number {
  if (typeof localStorage === "undefined") return 13;
  try {
    const raw = localStorage.getItem(FONT_SIZE_KEY);
    if (raw === null) return 13;
    const parsed = JSON.parse(raw);
    return Number.isFinite(parsed) ? clampFontSize(parsed) : 13;
  } catch {
    return 13;
  }
}

function persistFontSize(value: number): void {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(FONT_SIZE_KEY, JSON.stringify(clampFontSize(value)));
  } catch {
    // Runtime state remains authoritative for this launch if storage is unavailable.
  }
}

function loadDefaultShell(): TerminalShellSelection {
  if (typeof localStorage === "undefined") return AUTO_TERMINAL_SHELL;
  try {
    const raw = localStorage.getItem(DEFAULT_SHELL_KEY);
    return raw ? normalizeTerminalShellSelection(JSON.parse(raw)) : AUTO_TERMINAL_SHELL;
  } catch {
    return AUTO_TERMINAL_SHELL;
  }
}

function persistDefaultShell(selection: TerminalShellSelection) {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(DEFAULT_SHELL_KEY, JSON.stringify(selection));
  } catch {
    // Runtime state remains authoritative for this launch if storage is unavailable.
  }
}

interface TerminalSettingsStore {
  defaultShell: TerminalShellSelection;
  setDefaultShell: (selection: TerminalShellSelection) => void;
  resetDefaultShell: () => void;
  terminalFontSizePx: number;
  setTerminalFontSizePx: (size: number) => void;
  resetTerminalFontSizePx: () => void;
}

export const useTerminalSettingsStore = create<TerminalSettingsStore>((set) => ({
  defaultShell: loadDefaultShell(),
  setDefaultShell: (input) => {
    const selection = normalizeTerminalShellSelection(input);
    persistDefaultShell(selection);
    set({ defaultShell: selection });
  },
  resetDefaultShell: () => {
    persistDefaultShell(AUTO_TERMINAL_SHELL);
    set({ defaultShell: AUTO_TERMINAL_SHELL });
  },
  terminalFontSizePx: loadFontSize(),
  setTerminalFontSizePx: (size) => {
    const value = clampFontSize(size);
    persistFontSize(value);
    set({ terminalFontSizePx: value });
  },
  resetTerminalFontSizePx: () => {
    persistFontSize(13);
    set({ terminalFontSizePx: 13 });
  },
}));
