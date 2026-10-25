import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AddSessionPicker } from "@/components/workspace/AddSessionPicker";
import { useCliAccountStore } from "@/stores/cliAccountStore";
import type { CliAccount } from "@/types/cliAccount";
import type { Workspace } from "@/types/workspace";

const addPane = vi.hoisted(() => vi.fn());
const addFilePane = vi.hoisted(() => vi.fn());
const openFileDialog = vi.hoisted(() => vi.fn());
const openSettings = vi.hoisted(() => vi.fn());

vi.mock("@tauri-apps/plugin-dialog", () => ({ open: openFileDialog }));
const terminalSettingsState = vi.hoisted(() => ({ defaultShell: { profile: "auto" as const } }));
const agentState = vi.hoisted(() => ({
  agents: [
    { id: "claude-code", installed: true },
    { id: "codex", installed: true },
    { id: "opencode", installed: false },
    { id: "packetcode", installed: true },
  ],
}));

vi.mock("@/stores/workspaceStore", () => ({
  useWorkspaceStore: (
    selector: (state: { addPane: typeof addPane; addFilePane: typeof addFilePane }) => unknown,
  ) => selector({ addPane, addFilePane }),
}));

vi.mock("@/stores/appStore", () => ({
  useAppStore: (selector: (state: { openSettings: typeof openSettings }) => unknown) =>
    selector({ openSettings }),
}));

vi.mock("@/stores/agentStore", () => ({
  useAgentStore: (selector: (state: typeof agentState) => unknown) => selector(agentState),
}));

vi.mock("@/stores/serverStore", () => ({
  useServerStore: (selector: (state: { servers: unknown[] }) => unknown) =>
    selector({ servers: [] }),
}));

vi.mock("@/stores/terminalSettingsStore", () => ({
  useTerminalSettingsStore: (selector: (state: typeof terminalSettingsState) => unknown) =>
    selector(terminalSettingsState),
}));

vi.mock("@/hooks/useTerminalShellDetection", () => ({
  useTerminalShellDetection: () => ({
    shells: {
      auto: { profile: "auto", available: true, path: null, version: null },
      powershell7: { profile: "powershell7", available: true, path: "pwsh.exe", version: "7" },
      "windows-powershell": {
        profile: "windows-powershell",
        available: true,
        path: "powershell",
        version: null,
      },
      "command-prompt": {
        profile: "command-prompt",
        available: true,
        path: "cmd",
        version: null,
      },
      "git-bash": {
        profile: "git-bash",
        available: true,
        path: "C:\\Program Files\\Git\\bin\\bash.exe",
        version: "5",
      },
      wsl: { profile: "wsl", available: true, path: "wsl.exe", version: "2" },
      bash: { profile: "bash", available: true, path: "/bin/bash", version: "5" },
      zsh: { profile: "zsh", available: false, path: null, version: null },
    },
    wslDistributions: ["Ubuntu"],
    loading: false,
    error: null,
    refresh: vi.fn(),
  }),
}));

const localWorkspace: Workspace = {
  id: "ws-local",
  name: "Local",
  agents: [],
  panes: [],
  projectPath: "/tmp/project",
  createdAt: 1,
  updatedAt: 1,
  status: "active",
};

/**
 * Multi-account CLI support: the real `cliAccountStore` is used with
 * `setState` (which bypasses its backend sync), so these tests exercise the
 * same resolution path the app does.
 */
function account(id: string, label: string, cli: CliAccount["cli"]): CliAccount {
  return { id, label, cli, configDir: `C:\\cfg\\${id}`, createdAt: 1 };
}

describe("AddSessionPicker", () => {
  afterEach(() => {
    // Platform stubs are per-test; a leaked UA spy silently flips every later
    // assertion about platform-gated chrome.
    vi.restoreAllMocks();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    useCliAccountStore.setState({ accounts: [], stickyDefaults: {} });
    agentState.agents = [
      { id: "claude-code", installed: true },
      { id: "codex", installed: true },
      { id: "opencode", installed: false },
      { id: "packetcode", installed: true },
    ];
  });

  function openPopover(userAgent = "Mozilla/5.0 (X11; Linux x86_64)") {
    vi.spyOn(navigator, "userAgent", "get").mockReturnValue(userAgent);
    render(<AddSessionPicker workspace={localWorkspace} variant="popover" />);
    fireEvent.click(screen.getByRole("button", { name: /add session/i }));
  }

  it("launches a Custom CLI with literal arguments, environment and working directory", () => {
    openPopover();
    fireEvent.click(screen.getByRole("button", { name: "Custom CLI" }));
    expect(addPane).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText("Custom CLI name"), { target: { value: "Local tool" } });
    fireEvent.change(screen.getByLabelText("Custom CLI executable"), { target: { value: "/opt/my agent" } });
    fireEvent.change(screen.getByLabelText("Custom CLI arguments"), { target: { value: '["two words", "--flag"]' } });
    fireEvent.change(screen.getByLabelText("Custom CLI environment"), { target: { value: '{"MODE":"dev"}' } });
    fireEvent.change(screen.getByLabelText("Custom CLI working directory"), { target: { value: "/work/other" } });
    fireEvent.click(screen.getByRole("button", { name: "Add Custom CLI" }));
    expect(addPane).toHaveBeenCalledWith("ws-local", "custom-cli", { customCli: {
      name: "Local tool", command: "/opt/my agent", args: ["two words", "--flag"], env: { MODE: "dev" }, workingDirectory: "/work/other",
    } });
  });

  /**
   * `terminalPlatform()` sniffs the user agent, and jsdom reports Linux. Any
   * assertion about Windows-only chrome (the Command Prompt shell option, the
   * WSL row) has to stub the UA first or it is asserting against the posix
   * profile list. The suite-level afterEach restores the spy —
   * `vi.clearAllMocks()` clears calls, not implementations.
   */
  function openPopoverAsWindows() {
    openPopover("Mozilla/5.0 (Windows NT 10.0; Win64; x64)");
  }

  it("offers CLI sessions only and recommends detected PacketCode first", () => {
    openPopover();

    expect(screen.queryByText("Chat agents")).toBeNull();
    expect(screen.queryByText("Claude API")).toBeNull();
    expect(screen.getByText("CLI sessions")).toBeInTheDocument();
    expect(screen.getByText("Recommended")).toBeInTheDocument();

    const buttons = screen.getAllByRole("button");
    const packetCodeIndex = buttons.findIndex((button) =>
      button.textContent?.includes("PacketCode"),
    );
    const claudeIndex = buttons.findIndex((button) => button.textContent?.includes("Claude Code"));
    expect(packetCodeIndex).toBeGreaterThanOrEqual(0);
    expect(packetCodeIndex).toBeLessThan(claudeIndex);
  });

  it("enables Amp detected inside WSL on Windows", () => {
    agentState.agents.push({ id: "amp", installed: true });
    openPopoverAsWindows();
    fireEvent.click(screen.getByRole("button", { name: "Amp" }));
    expect(addPane).toHaveBeenCalledWith("ws-local", "amp", undefined);
  });

  it("keeps Amp disabled when detection cannot find it in WSL", () => {
    agentState.agents.push({ id: "amp", installed: false });
    openPopoverAsWindows();
    expect(screen.getByRole("button", { name: "Amp" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Amp" }).title).toContain("default WSL distribution");
  });

  it("adds a detected PacketCode PTY pane directly", () => {
    openPopover();

    fireEvent.click(screen.getByRole("button", { name: /PacketCode/ }));

    // Multi-account: an untouched row passes NO account option at all, so
    // `addPane` resolves the sticky per-project default itself.
    expect(addPane).toHaveBeenCalledWith("ws-local", "packetcode", undefined);
  });

  it("keeps the Terminal row on the inherited Auto path until a shell is chosen", () => {
    openPopover();

    expect(screen.getByRole("combobox", { name: "Shell for new Terminal session" })).toHaveValue(
      "inherit",
    );
    fireEvent.click(screen.getByRole("button", { name: "Terminal" }));

    expect(addPane).toHaveBeenCalledWith("ws-local", "terminal", undefined);
  });

  it("stores a one-session shell override on the new Terminal pane", () => {
    // Command Prompt only appears in the WINDOWS profile list. Under jsdom the
    // UA reads Linux, so without this stub the <select> has no such option,
    // jsdom coerces the value to "", and the assertion failed on a phantom
    // `profile: ""` rather than on anything the component did.
    openPopoverAsWindows();

    fireEvent.change(screen.getByRole("combobox", { name: "Shell for new Terminal session" }), {
      target: { value: "command-prompt" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Terminal" }));

    expect(addPane).toHaveBeenCalledWith("ws-local", "terminal", {
      terminalShell: {
        profile: "command-prompt",
        executable: "cmd",
      },
    });
  });

  it("routes missing PacketCode to its Settings recovery panel", () => {
    agentState.agents = agentState.agents.map((agent) =>
      agent.id === "packetcode" ? { ...agent, installed: false } : agent,
    );
    openPopover();

    fireEvent.click(screen.getAllByRole("button", { name: /set up/i })[0]);

    expect(openSettings).toHaveBeenCalledWith({
      section: "cli-clients",
      cliId: "packetcode",
    });
    expect(addPane).not.toHaveBeenCalled();
  });

  it("searches CLI sessions without surfacing API providers", () => {
    openPopover();

    fireEvent.change(screen.getByPlaceholderText("Search CLI sessions…"), {
      target: { value: "cla" },
    });

    expect(screen.getByRole("button", { name: "Claude Code" })).toBeInTheDocument();
    expect(screen.queryByText("PacketCode")).toBeNull();
    expect(screen.queryByText("Claude API")).toBeNull();
  });

  describe("account affordance", () => {
    it("shows no account chip when the user has registered no accounts", () => {
      openPopover();

      expect(screen.queryByText("Default login")).toBeNull();
      // The one-click path is untouched on a zero-config install.
      fireEvent.click(screen.getByRole("button", { name: "Claude Code" }));
      expect(addPane).toHaveBeenCalledWith("ws-local", "claude-code", undefined);
    });

    it("shows the resolved sticky default on the claude-code and codex rows only", () => {
      useCliAccountStore.setState({
        accounts: [
          account("acct-personal", "Personal", "claude-code"),
          account("acct-client", "Client work", "claude-code"),
          account("acct-codex", "Codex login", "codex"),
        ],
        stickyDefaults: { "/tmp/project": { "claude-code": "acct-client" } },
      });

      openPopover();

      // claude-code resolves the sticky default; codex has an account but no
      // sticky entry, so it shows the ambient caption.
      expect(screen.getByText("Client work")).toBeInTheDocument();
      expect(screen.getByText("Default login")).toBeInTheDocument();
      // terminal / opencode / packetcode are unaffected — one chip per
      // account-aware row and no more.
      expect(screen.getAllByTitle(/click to switch before adding/i)).toHaveLength(2);
    });

    it("keeps the one-click fast path: clicking the row adds with the resolved default", () => {
      useCliAccountStore.setState({
        accounts: [account("acct-client", "Client work", "claude-code")],
        stickyDefaults: { "/tmp/project": { "claude-code": "acct-client" } },
      });

      openPopover();
      fireEvent.click(screen.getByRole("button", { name: "Claude Code" }));

      // No explicit option: `addPane` re-resolves the very default the chip
      // displayed, so the common case stays a single click.
      expect(addPane).toHaveBeenCalledWith("ws-local", "claude-code", undefined);
    });

    it("lets the user switch account before adding, and passes it as an explicit choice", () => {
      useCliAccountStore.setState({
        accounts: [
          account("acct-personal", "Personal", "claude-code"),
          account("acct-client", "Client work", "claude-code"),
        ],
        stickyDefaults: { "/tmp/project": { "claude-code": "acct-client" } },
      });

      openPopover();

      // Opening the chip must NOT add a pane.
      fireEvent.click(screen.getAllByTitle(/click to switch before adding/i)[0]);
      expect(addPane).not.toHaveBeenCalled();

      fireEvent.click(screen.getByRole("option", { name: /Personal/ }));
      expect(addPane).not.toHaveBeenCalled();
      expect(screen.getByText("Personal")).toBeInTheDocument();

      fireEvent.click(screen.getByRole("button", { name: "Claude Code" }));
      expect(addPane).toHaveBeenCalledWith("ws-local", "claude-code", {
        accountId: "acct-personal",
      });
    });

    it("switching to the ambient login travels as an explicit null", () => {
      useCliAccountStore.setState({
        accounts: [account("acct-client", "Client work", "claude-code")],
        stickyDefaults: { "/tmp/project": { "claude-code": "acct-client" } },
      });

      openPopover();
      fireEvent.click(screen.getAllByTitle(/click to switch before adding/i)[0]);
      fireEvent.click(screen.getByRole("option", { name: /Default login/ }));
      fireEvent.click(screen.getByRole("button", { name: "Claude Code" }));

      expect(addPane).toHaveBeenCalledWith("ws-local", "claude-code", {
        accountId: null,
      });
    });
  });

  describe("viewer rows", () => {
    it("opens the picked file as a viewer tile", async () => {
      openFileDialog.mockResolvedValue("/tmp/project/notes.txt");
      openPopover();

      fireEvent.click(screen.getByRole("button", { name: "File Viewer" }));
      await vi.waitFor(() =>
        expect(addFilePane).toHaveBeenCalledWith("ws-local", "/tmp/project/notes.txt", undefined),
      );
      // Scoped to the workspace so the dialog opens where the user is working.
      expect(openFileDialog).toHaveBeenCalledWith(
        expect.objectContaining({ defaultPath: "/tmp/project", directory: false }),
      );
    });

    it("Markdown Viewer filters to .md and opens rendered", async () => {
      openFileDialog.mockResolvedValue("/tmp/project/README.md");
      openPopover();

      fireEvent.click(screen.getByRole("button", { name: "Markdown Viewer" }));
      await vi.waitFor(() =>
        expect(addFilePane).toHaveBeenCalledWith("ws-local", "/tmp/project/README.md", {
          view: "preview",
        }),
      );
      expect(openFileDialog).toHaveBeenCalledWith(
        expect.objectContaining({
          filters: [{ name: "Markdown", extensions: ["md", "mdx"] }],
        }),
      );
    });

    it("adds nothing when the dialog is cancelled", async () => {
      openFileDialog.mockResolvedValue(null);
      openPopover();

      fireEvent.click(screen.getByRole("button", { name: "File Viewer" }));
      await vi.waitFor(() => expect(openFileDialog).toHaveBeenCalled());
      expect(addFilePane).not.toHaveBeenCalled();
    });

    it("disables the viewers on an SSH workspace", () => {
      render(
        <AddSessionPicker workspace={{ ...localWorkspace, serverId: "srv-1" }} variant="popover" />,
      );
      fireEvent.click(screen.getByRole("button", { name: /add session/i }));

      expect(screen.getByRole("button", { name: "File Viewer" })).toBeDisabled();
      expect(screen.getByRole("button", { name: "Markdown Viewer" })).toBeDisabled();
    });

    it("still offers no Chat row — API conversations belong to Agents", () => {
      openPopover();
      expect(screen.queryByRole("button", { name: /^chat/i })).toBeNull();
    });
  });

  describe("WSL row", () => {
    it("adds a Terminal pane carrying the WSL shell selection", () => {
      openPopoverAsWindows();

      fireEvent.click(screen.getByRole("button", { name: /WSL/ }));

      // Not a new pane kind — a Terminal pane with a shell override, so it
      // reuses the whole existing PTY launch path.
      expect(addPane).toHaveBeenCalledWith("ws-local", "terminal", {
        terminalShell: { profile: "wsl", executable: "wsl.exe", wslDistro: "Ubuntu" },
      });
    });

    it("is absent off Windows", () => {
      openPopover();
      expect(screen.queryByRole("button", { name: /WSL/ })).toBeNull();
    });
  });
});
