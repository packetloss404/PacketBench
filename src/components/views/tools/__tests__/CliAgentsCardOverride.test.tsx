import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

import { CliAgentsCard, CliCatalogCard } from "../CliAgentsCard";
import type { CliCatalogEntry } from "@/lib/cli-catalog";

/**
 * Audit F27.
 *
 * The ✕ that clears a manual path override used to render only when the CLI
 * read as installed. A pin at a path that no longer exists is exactly what
 * makes a CLI read as NOT installed, so the control was hidden precisely when
 * it was the only thing that would help: the pin became unclearable from the
 * card that displayed it.
 *
 * Found on a real machine — a packetcode pin at a deleted
 * `PacketBench-0.11.0-portable` path, where the binary itself resolved on PATH
 * and answered `--version` perfectly well.
 */
const ENTRY: CliCatalogEntry = {
  id: "packetcode",
  name: "PacketCode",
  binary: "packetcode",
  iconName: "Terminal",
  color: "green",
};

function renderCard(overrides: Partial<Parameters<typeof CliCatalogCard>[0]> = {}) {
  const onClearOverride = vi.fn();
  render(
    <CliCatalogCard
      entry={ENTRY}
      result={undefined}
      selected={false}
      detecting={false}
      installing={false}
      manualPath={String.raw`C:\Users\me\Desktop\gone\packetcode.exe`}
      onSelect={vi.fn()}
      onInstall={vi.fn()}
      onBrowse={vi.fn()}
      onClearOverride={onClearOverride}
      {...overrides}
    />,
  );
  return { onClearOverride };
}

describe("CliCatalogCard manual-path override", () => {
  it("offers the clear control even when the CLI reads as not installed", () => {
    // `result: undefined` is the not-installed case — the exact state a broken
    // pin produces.
    const { onClearOverride } = renderCard();

    fireEvent.click(screen.getByTitle("Clear manual path override"));

    expect(onClearOverride).toHaveBeenCalledTimes(1);
  });

  it("still shows the pinned path so the user can see what is wrong", () => {
    renderCard();
    expect(screen.getByText(/Override:/)).toBeInTheDocument();
  });

  it("says the pin is unusable rather than claiming the CLI is not installed", () => {
    // The state a stale pin produces: detect_one short-circuits and reports the
    // bad pin back with installed:false and no version. Calling that "not
    // installed" sends the user off installing a CLI they already have (F27b).
    renderCard({
      result: {
        id: "packetcode",
        installed: false,
        version: null,
        path: String.raw`C:\Users\me\Desktop\gone\packetcode.exe`,
        source: "settings",
      },
    });

    expect(screen.getByText("pinned path not usable")).toBeInTheDocument();
    expect(screen.queryByText("not installed")).toBeNull();
  });

  it("still says not installed when there is no pin at all", () => {
    renderCard({ manualPath: null, result: undefined });
    expect(screen.getByText("not installed")).toBeInTheDocument();
  });

  it("shows nothing to clear when no override is pinned", () => {
    renderCard({ manualPath: null });
    expect(screen.queryByTitle("Clear manual path override")).toBeNull();
  });
});

it("retains saved custom entries while removing unsupported creation", async () => {
  const { useAgentStore } = await import("@/stores/agentStore");
  const tauri = await import("@/lib/tauri");
  const detect = vi.spyOn(tauri, "detectCliCatalog").mockResolvedValue([]);
  const original = useAgentStore.getState().agents;
  const saved = {
    ...original[0],
    id: "custom-legacy",
    name: "Saved legacy CLI",
    command: "legacy-cli",
    isBuiltin: false,
  };
  useAgentStore.setState({ agents: [...original, saved] });
  try {
    render(<CliAgentsCard />);
    fireEvent.click(screen.getByRole("button", { name: /Advanced/ }));
    expect(screen.getByText(/Custom CLI launching is not supported/)).toBeInTheDocument();
    expect(screen.getByText("Saved legacy CLI")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Custom$/ })).toBeNull();
    expect(
      screen.getByRole("button", { name: "Delete custom CLI agent Saved legacy CLI" }),
    ).toBeInTheDocument();
    await waitFor(() => expect(detect).toHaveBeenCalled());
    expect(useAgentStore.getState().agents.find((agent) => agent.id === saved.id)).toEqual(saved);
  } finally {
    useAgentStore.setState({ agents: original });
    detect.mockRestore();
  }
});
