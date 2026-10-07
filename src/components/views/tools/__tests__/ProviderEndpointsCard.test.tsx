/**
 * LM1: Ollama used to send neither `num_ctx` nor `keep_alive`, so the daemon
 * ran at its 4096-token default and silently dropped the oldest messages. The
 * backend now derives and sends both; this card is the override surface, so
 * what is pinned here is that a saved override round-trips to the backend
 * rather than being cosmetic.
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn().mockResolvedValue(() => {}) }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

import { invoke } from "@tauri-apps/api/core";
import { ProviderEndpointsCard } from "@/components/views/tools/ProviderEndpointsCard";

const DEFAULT_OPTIONS = {
  numCtxCap: 16384,
  keepAlive: "30m",
  defaultNumCtxCap: 16384,
  defaultKeepAlive: "30m",
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(invoke).mockImplementation(async (command: string, args?: unknown) => {
    switch (command) {
      case "get_provider_base_url":
        return "https://fixture.example/v1";
      case "get_ollama_base_url":
        return "http://localhost:11434";
      case "get_minimax_base_url":
        return "https://api.minimax.io/v1";
      case "get_ollama_runtime_options":
        return DEFAULT_OPTIONS;
      case "set_ollama_runtime_options": {
        const { numCtxCap, keepAlive } = args as {
          numCtxCap: number | null;
          keepAlive: string | null;
        };
        return {
          ...DEFAULT_OPTIONS,
          numCtxCap: numCtxCap ?? DEFAULT_OPTIONS.defaultNumCtxCap,
          keepAlive: keepAlive ?? DEFAULT_OPTIONS.defaultKeepAlive,
        };
      }
      default:
        return undefined;
    }
  });
});

describe("ProviderEndpointsCard — Ollama local runtime", () => {
  it("loads the effective context cap and keep-alive from the backend", async () => {
    render(<ProviderEndpointsCard />);

    expect(await screen.findByLabelText("Ollama context cap")).toHaveValue(16384);
    expect(screen.getByLabelText("Ollama keep-alive")).toHaveValue("30m");
  });

  it("sends an edited cap and keep-alive to the backend", async () => {
    render(<ProviderEndpointsCard />);

    const cap = await screen.findByLabelText("Ollama context cap");
    fireEvent.change(cap, { target: { value: "32768" } });
    fireEvent.change(screen.getByLabelText("Ollama keep-alive"), { target: { value: "1h" } });
    fireEvent.click(screen.getByTitle("Save Ollama runtime options"));

    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("set_ollama_runtime_options", {
        numCtxCap: 32768,
        keepAlive: "1h",
      }),
    );
    expect(await screen.findByLabelText("Ollama context cap")).toHaveValue(32768);
  });

  it("resets to the built-in defaults by clearing both overrides", async () => {
    render(<ProviderEndpointsCard />);

    await screen.findByLabelText("Ollama context cap");
    fireEvent.click(screen.getByTitle("Reset Ollama runtime options"));

    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("set_ollama_runtime_options", {
        numCtxCap: null,
        keepAlive: null,
      }),
    );
  });

  it("does not save an unchanged form", async () => {
    render(<ProviderEndpointsCard />);

    await screen.findByLabelText("Ollama context cap");

    expect(screen.getByTitle("Save Ollama runtime options")).toBeDisabled();
  });
});
