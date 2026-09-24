/**
 * Editing an MCP server's scope must MOVE it, not clone it.
 *
 * FAULT: `McpServerModal`'s Scope buttons stay live while editing, and are
 * pre-selected to the server's current scope, so switching them reads as
 * "move this server". The card called `updateServer(...)` with only the NEW
 * scope, and `write_mcp_server` is an upsert into whichever file that scope
 * names — `~/.claude/settings.json` for global, `<project>/.mcp.json` for
 * project. The old row was never removed, so a Global-to-Project edit left the
 * same server name defined twice, in two files, with different commands. The
 * hub then listed it under both headings and agent sessions saw whichever the
 * merge happened to win with.
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const tauri = vi.hoisted(() => ({
  readMcpServers: vi.fn(),
  writeMcpServer: vi.fn(),
  deleteMcpServer: vi.fn(),
}));

vi.mock("@/lib/tauri", () => tauri);

import { McpServersCard } from "@/components/views/tools/McpServersCard";
import { useMcpStore } from "@/stores/mcpStore";
import { useLayoutStore } from "@/stores/layoutStore";
import { useAgentSettingsStore } from "@/stores/agentSettingsStore";
import type { McpServerEntry } from "@/types/mcp";

const GLOBAL_ENTRY: McpServerEntry = {
  name: "filesystem",
  scope: "global",
  config: { command: "npx", args: ["-y", "server-filesystem"], env: {} },
  disabled: false,
};

beforeEach(() => {
  vi.clearAllMocks();
  tauri.readMcpServers.mockResolvedValue([GLOBAL_ENTRY]);
  tauri.writeMcpServer.mockResolvedValue(undefined);
  tauri.deleteMcpServer.mockResolvedValue(undefined);
  useLayoutStore.setState({ projectPath: "D:\\work\\app" });
  useMcpStore.setState({ servers: [GLOBAL_ENTRY], loading: false, error: null });
  useAgentSettingsStore.setState({ defaultEnabledMcpServerIds: null });
});

it("explicitly disables MCP for new conversations even with no configured servers", async () => {
  tauri.readMcpServers.mockResolvedValue([]);
  useMcpStore.setState({ servers: [] });
  render(<McpServersCard />);
  fireEvent.click(screen.getByRole("button", { name: "Disable all" }));
  expect(useAgentSettingsStore.getState().defaultEnabledMcpServerIds).toEqual([]);
  expect(
    await screen.findByText(/All MCP servers are disabled for new conversations/),
  ).toBeInTheDocument();
  expect(tauri.writeMcpServer).not.toHaveBeenCalled();
  expect(tauri.deleteMcpServer).not.toHaveBeenCalled();
});

async function openEditForm() {
  render(<McpServersCard />);
  await screen.findByText("filesystem");
  fireEvent.click(screen.getByTitle("Edit"));
  await screen.findByRole("heading", { name: "Edit MCP Server" });
}

describe("MCP server scope edit", () => {
  it("removes the old scope's row when the scope changes", async () => {
    await openEditForm();

    fireEvent.click(screen.getByRole("button", { name: "Project" }));
    fireEvent.click(screen.getByRole("button", { name: "Update" }));

    await waitFor(() => expect(tauri.writeMcpServer).toHaveBeenCalled());

    // Written into the new scope...
    expect(tauri.writeMcpServer).toHaveBeenCalledWith(
      "D:\\work\\app",
      "filesystem",
      "npx",
      ["-y", "server-filesystem"],
      {},
      "project",
    );
    // ...and cleared out of the old one, so exactly one definition survives.
    await waitFor(() =>
      expect(tauri.deleteMcpServer).toHaveBeenCalledWith("D:\\work\\app", "filesystem", "global"),
    );
  });

  it("writes the destination before deleting the source", async () => {
    // A delete-then-write order loses the server outright if the write fails.
    // A write-then-delete leaves a duplicate, which the user can still fix.
    await openEditForm();

    fireEvent.click(screen.getByRole("button", { name: "Project" }));
    fireEvent.click(screen.getByRole("button", { name: "Update" }));

    await waitFor(() => expect(tauri.deleteMcpServer).toHaveBeenCalled());
    expect(tauri.writeMcpServer.mock.invocationCallOrder[0]).toBeLessThan(
      tauri.deleteMcpServer.mock.invocationCallOrder[0],
    );
  });

  it("deletes nothing when only the command is edited", async () => {
    await openEditForm();

    fireEvent.change(screen.getByDisplayValue("npx"), { target: { value: "node" } });
    fireEvent.click(screen.getByRole("button", { name: "Update" }));

    await waitFor(() => expect(tauri.writeMcpServer).toHaveBeenCalled());
    expect(tauri.deleteMcpServer).not.toHaveBeenCalled();
  });

  it("deletes nothing when adding a brand-new server", async () => {
    render(<McpServersCard />);
    await screen.findByText("filesystem");
    fireEvent.click(screen.getByRole("button", { name: /Add/i }));
    await screen.findByRole("heading", { name: "Add MCP Server" });

    fireEvent.change(screen.getByPlaceholderText("e.g. my-mcp-server"), {
      target: { value: "brand-new" },
    });
    fireEvent.change(screen.getByPlaceholderText("e.g. npx or node"), {
      target: { value: "node" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add Server" }));

    await waitFor(() => expect(tauri.writeMcpServer).toHaveBeenCalled());
    expect(tauri.deleteMcpServer).not.toHaveBeenCalled();
  });
});

/**
 * FAULT: `McpServerModal` edits command + args + env and nothing else. An
 * http/sse server is defined by `type` and `url` and has no command at all, so
 * the form opened with Command blank and would not save until the user made
 * one up — and `upsert_mcp_server` preserves unknown keys, so the result was a
 * server carrying both a url and an invented command. The Edit affordance was
 * offering to describe a server it has no vocabulary for.
 */
describe("MCP server edit affordance by transport", () => {
  const HTTP_ENTRY: McpServerEntry = {
    name: "remote-docs",
    scope: "global",
    config: { command: "", args: [], env: {} },
    rawConfig: { type: "http", url: "https://mcp.example.com/v1" },
    disabled: false,
  };

  it("does not offer to edit an http server through the command form", async () => {
    useMcpStore.setState({ servers: [HTTP_ENTRY], loading: false, error: null });
    tauri.readMcpServers.mockResolvedValue([HTTP_ENTRY]);

    render(<McpServersCard />);
    await screen.findByText("remote-docs");

    const edit = screen.getByRole("button", { name: /http server/i });
    expect(edit).toBeDisabled();
    expect(edit).toHaveAttribute("title", expect.stringContaining("defined by a url"));
  });

  it("labels the transport and shows the url instead of an empty command line", async () => {
    useMcpStore.setState({ servers: [HTTP_ENTRY], loading: false, error: null });
    tauri.readMcpServers.mockResolvedValue([HTTP_ENTRY]);

    render(<McpServersCard />);
    await screen.findByText("remote-docs");

    expect(screen.getByText("http")).toBeInTheDocument();
    expect(screen.getByText("https://mcp.example.com/v1")).toBeInTheDocument();
  });

  it("still offers Edit for an ordinary stdio server", async () => {
    render(<McpServersCard />);
    await screen.findByText("filesystem");

    expect(screen.getByTitle("Edit")).toBeEnabled();
  });
});
