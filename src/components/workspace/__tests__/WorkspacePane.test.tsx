import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { WorkspacePane } from "@/components/workspace/WorkspacePane";
import type { TerminalHeaderRenderState } from "@/components/session/TerminalPane";
import { useWorkspaceStore } from "@/stores/workspaceStore";
import { useAgentStore } from "@/stores/agentStore";
import { CODEX_CONFIG } from "@/agents/codex";
import { OPENCODE_CONFIG } from "@/agents/opencode";
import { TERMINAL_CONFIG } from "@/agents/terminal";
import { PACKETCODE_CONFIG } from "@/agents/packetcode";
import { useTerminalSettingsStore } from "@/stores/terminalSettingsStore";
import { usePacketCodeIntegrationStore } from "@/stores/packetCodeIntegrationStore";
import { useCliOverrideStore } from "@/stores/cliOverrideStore";
import { usePromptStore } from "@/stores/promptStore";
import type { Workspace } from "@/types/workspace";

const probePacketCodeIntegration = vi.hoisted(() => vi.fn());
const writePty = vi.hoisted(() => vi.fn());

// Spread the real module: the pane now also calls the pure exit-classification
// helpers (`ptyExitPillLabel`, `describePtyExitOutcome`) while rendering its
// header, and stubbing the module wholesale would leave those undefined.
vi.mock("@/lib/tauri", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/tauri")>()),
  writePty,
  probePacketCodeIntegration,
}));

// The tile header lives entirely inside WorkspacePane's `renderHeader`
// callback passed to TerminalPane. Mounting the real TerminalPane would
// pull in xterm/PTY plumbing this suite doesn't need — mock it down to a
// component that invokes `renderHeader` with a test-controlled state and
// renders the result, mirroring TerminalHeaderRenderState's real shape
// (TerminalPane.tsx:12).
let currentHeaderState: TerminalHeaderRenderState = {
  alive: true,
  error: null,
  showApproval: false,
  cliCommand: "codex",
  lastExit: null,
  onRestart: vi.fn(),
  onKill: vi.fn(),
};
let lastTerminalProps: Record<string, unknown> = {};

vi.mock("@/components/session/TerminalPane", () => ({
  TerminalPane: (props: {
    renderHeader?: (state: TerminalHeaderRenderState) => React.ReactNode;
    [key: string]: unknown;
  }) => {
    lastTerminalProps = props;
    return <>{props.renderHeader ? props.renderHeader(currentHeaderState) : null}</>;
  },
}));

// WorkspacePane reaches for MosaicWindowContext to wire the drag source.
// Outside a <MosaicWindow> provider, React's useContext naturally resolves
// to the context's own default (`undefined`, per react-mosaic-component's
// contextTypes.ts) — the code already null-guards on that (`?? fullHeader`),
// so no explicit mock is needed here.

function makeWorkspace(): Workspace {
  const now = Date.now();
  return {
    id: "ws-1",
    name: "Header diet test workspace",
    agents: ["codex", "opencode", "terminal"],
    panes: [
      { id: "pane-codex", agentId: "codex", sessionId: null },
      { id: "pane-opencode", agentId: "opencode", sessionId: null },
      { id: "pane-terminal", agentId: "terminal", sessionId: null },
    ],
    projectPath: "/tmp/project",
    createdAt: now,
    updatedAt: now,
    status: "active",
  };
}

describe("WorkspacePane tile header", () => {
  beforeEach(() => {
    useWorkspaceStore.setState({
      workspaces: [makeWorkspace()],
      activeWorkspaceId: "ws-1",
      zoomedPaneId: null,
    });
    useAgentStore.setState({
      agents: [
        { ...CODEX_CONFIG, installed: true },
        { ...OPENCODE_CONFIG, installed: true },
        { ...TERMINAL_CONFIG, installed: true },
      ],
      detecting: false,
    });
    currentHeaderState = {
      alive: true,
      error: null,
      showApproval: false,
      cliCommand: "codex",
      lastExit: null,
      onRestart: vi.fn(),
      onKill: vi.fn(),
    };
    lastTerminalProps = {};
    useTerminalSettingsStore.setState({ defaultShell: { profile: "auto" } });
    usePacketCodeIntegrationStore.setState({
      localDataHome: "",
      developerRepoPath: "",
      releaseChannel: "stable",
      remoteDataHomes: {},
    });
    useCliOverrideStore.setState({ overrides: {} });
    probePacketCodeIntegration.mockReset();
    writePty.mockReset().mockResolvedValue(undefined);
  });

  it("renders a diet header: grip, dot, name, status, zoom, one overflow — no standalone accent/pin/prompt/model controls", () => {
    const workspace = useWorkspaceStore.getState().workspaces[0];
    render(<WorkspacePane pane={workspace.panes[0]} workspaceId={workspace.id} />);

    // The old per-pane accent-color picker is gone.
    expect(screen.queryByTitle("Change accent color")).not.toBeInTheDocument();
    // Standalone Pin / prompt-template / model-chip buttons are gone —
    // they now live inside the single overflow menu.
    expect(screen.queryByTitle("Pinned commands")).not.toBeInTheDocument();
    expect(screen.queryByTitle("Send a prompt template to this pane")).not.toBeInTheDocument();
    expect(screen.queryByTitle(/change model/i)).not.toBeInTheDocument();

    // Zoom stays a direct header control.
    expect(screen.getByTitle("Zoom to focus")).toBeInTheDocument();

    // Exactly one overflow trigger.
    expect(screen.getByTitle("More")).toBeInTheDocument();
  });

  it("retains a failed pinned command across restart and only retries into the new PTY on request", async () => {
    const workspace = useWorkspaceStore.getState().workspaces[0];
    const pane = { ...workspace.panes[0], sessionId: "pty-old", pinnedCommands: ["git status"] };
    writePty.mockRejectedValueOnce("PTY session not found");
    const view = render(<WorkspacePane pane={pane} workspaceId={workspace.id} />);

    fireEvent.click(screen.getByRole("button", { name: "git status" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Command could not be sent: PTY session not found");
    expect(writePty).toHaveBeenCalledWith("pty-old", "git status\r");
    expect(currentHeaderState.onRestart).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "git status" })).toBeDisabled();

    currentHeaderState = { ...currentHeaderState, alive: false };
    view.rerender(<WorkspacePane pane={{ ...pane, sessionId: null }} workspaceId={workspace.id} />);
    expect(screen.getByRole("button", { name: "Retry send" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Start session" }));
    expect(currentHeaderState.onRestart).toHaveBeenCalledTimes(1);
    expect(writePty).toHaveBeenCalledTimes(1);

    currentHeaderState = { ...currentHeaderState, alive: true };
    view.rerender(<WorkspacePane pane={{ ...pane, sessionId: "pty-new" }} workspaceId={workspace.id} />);
    expect(screen.getByRole("alert")).toBeInTheDocument();
    expect(writePty).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Retry send" }));
    await waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument());
    expect(writePty).toHaveBeenLastCalledWith("pty-new", "git status\r");
    expect(writePty).toHaveBeenCalledTimes(2);
  });

  it("keeps the attempted prompt body when its template changes after a failed send", async () => {
    const workspace = useWorkspaceStore.getState().workspaces[0];
    const template = { id: "retry-template", name: "Review changes", content: "Review exactly this diff", category: "review" as const, createdAt: 0, updatedAt: 0 };
    usePromptStore.setState({ templates: [template] });
    writePty.mockRejectedValueOnce(new Error("Broken pipe"));
    render(<WorkspacePane pane={{ ...workspace.panes[0], sessionId: "pty-live" }} workspaceId={workspace.id} />);
    fireEvent.click(screen.getByTitle("More"));
    fireEvent.click(screen.getByText("Send prompt…"));
    fireEvent.click(screen.getByRole("button", { name: /Review changes/ }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Prompt “Review changes” could not be sent: Broken pipe");
    expect(screen.getByText(template.content)).toBeInTheDocument();
    act(() => usePromptStore.setState({ templates: [{ ...template, content: "A different request" }] }));
    fireEvent.click(screen.getByRole("button", { name: "Retry send" }));
    await waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument());
    expect(writePty).toHaveBeenLastCalledWith("pty-live", template.content + "\r");
    expect(currentHeaderState.onRestart).not.toHaveBeenCalled();
  });

  it("suppresses repeated command clicks while a PTY write is pending", async () => {
    const workspace = useWorkspaceStore.getState().workspaces[0];
    let finishWrite!: () => void;
    writePty.mockImplementationOnce(() => new Promise<void>((resolve) => { finishWrite = resolve; }));
    render(<WorkspacePane pane={{ ...workspace.panes[0], sessionId: "pty-live", pinnedCommands: ["git status"] }} workspaceId={workspace.id} />);
    const button = screen.getByRole("button", { name: "git status" });
    fireEvent.click(button);
    fireEvent.click(button);
    expect(button).toBeDisabled();
    expect(screen.getByRole("status")).toHaveTextContent("Sending to terminal");
    expect(writePty).toHaveBeenCalledTimes(1);
    await act(async () => finishWrite());
    expect(button).toBeEnabled();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("allows dismissing a send failure without retrying or restarting", async () => {
    const workspace = useWorkspaceStore.getState().workspaces[0];
    writePty.mockRejectedValueOnce(new Error("Broken pipe"));
    render(<WorkspacePane pane={{ ...workspace.panes[0], sessionId: "pty-live", pinnedCommands: ["git status"] }} workspaceId={workspace.id} />);
    fireEvent.click(screen.getByRole("button", { name: "git status" }));
    await screen.findByRole("alert");
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "git status" })).toBeEnabled();
    expect(writePty).toHaveBeenCalledTimes(1);
    expect(currentHeaderState.onRestart).not.toHaveBeenCalled();
  });

  it("does not send through a stale session ID after a known PTY exit", () => {
    const workspace = useWorkspaceStore.getState().workspaces[0];
    currentHeaderState = { ...currentHeaderState, alive: false, lastExit: { kind: "failed", exitCode: 1 } };
    render(<WorkspacePane pane={{ ...workspace.panes[0], sessionId: "pty-stale", pinnedCommands: ["git status"] }} workspaceId={workspace.id} />);
    fireEvent.click(screen.getByRole("button", { name: "git status" }));
    expect(screen.getByRole("button", { name: "git status" })).toBeDisabled();
    expect(writePty).not.toHaveBeenCalled();
  });

  it("codex identity resolves via lib/agentColors (text-accent-amber)", () => {
    const workspace = useWorkspaceStore.getState().workspaces[0];
    render(<WorkspacePane pane={workspace.panes[0]} workspaceId={workspace.id} />);

    const name = screen.getByText(CODEX_CONFIG.name);
    expect(name.className).toContain("text-accent-amber");
  });

  it("opencode identity resolves to a different agentColors token (text-accent-purple) — proves the divergent per-file maps died", () => {
    currentHeaderState = { ...currentHeaderState, cliCommand: "opencode" };
    const workspace = useWorkspaceStore.getState().workspaces[0];
    render(<WorkspacePane pane={workspace.panes[1]} workspaceId={workspace.id} />);

    const name = screen.getByText(OPENCODE_CONFIG.name);
    expect(name.className).toContain("text-accent-purple");
    expect(name.className).not.toContain("text-accent-amber");
  });

  it("confirms before Close pane stops a live PTY and removes the pane", async () => {
    const workspace = useWorkspaceStore.getState().workspaces[0];
    const removePaneSpy = vi.spyOn(useWorkspaceStore.getState(), "removePane");

    render(<WorkspacePane pane={workspace.panes[0]} workspaceId={workspace.id} />);

    fireEvent.click(screen.getByTitle("More"));
    expect(screen.getByText("Restart session")).toBeInTheDocument();

    fireEvent.click(screen.getByText("Close pane"));
    expect(screen.getByText("Close terminal pane?")).toBeInTheDocument();
    expect(
      screen.getByText("Any live PTY and CLI process in this pane will be stopped."),
    ).toBeInTheDocument();
    expect(removePaneSpy).not.toHaveBeenCalled();
    expect(currentHeaderState.onKill).not.toHaveBeenCalled();

    fireEvent.click(screen.getByText("Cancel"));
    expect(screen.queryByText("Close terminal pane?")).not.toBeInTheDocument();
    expect(removePaneSpy).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTitle("More"));
    fireEvent.click(screen.getByText("Close pane"));
    fireEvent.click(screen.getByRole("button", { name: "Close pane" }));

    expect(currentHeaderState.onKill).toHaveBeenCalledTimes(1);
    await waitFor(() =>
      expect(removePaneSpy).toHaveBeenCalledWith(workspace.id, "pane-codex"),
    );
  });

  it("applies the selected shell only to a raw local Terminal pane", () => {
    useTerminalSettingsStore.setState({
      defaultShell: { profile: "command-prompt", executable: "cmd.exe" },
    });
    const workspace = useWorkspaceStore.getState().workspaces[0];

    const { unmount } = render(
      <WorkspacePane pane={workspace.panes[2]} workspaceId={workspace.id} />,
    );
    expect(lastTerminalProps.cliCommand).toBe("cmd.exe");
    expect(lastTerminalProps.cliArgs).toBeUndefined();
    expect(screen.getByText("Terminal · Command Prompt")).toBeInTheDocument();

    unmount();
    render(<WorkspacePane pane={workspace.panes[0]} workspaceId={workspace.id} />);
    expect(lastTerminalProps.cliCommand).toBe("codex");
  });

  it("uses pane override before workspace and app shell defaults", () => {
    useTerminalSettingsStore.setState({ defaultShell: { profile: "command-prompt" } });
    const workspace = useWorkspaceStore.getState().workspaces[0];
    workspace.terminalShell = { profile: "powershell7" };
    const pane = {
      ...workspace.panes[2],
      terminalShell: { profile: "wsl" as const, wslDistro: "Ubuntu" },
    };

    render(<WorkspacePane pane={pane} workspaceId={workspace.id} />);

    expect(lastTerminalProps.cliCommand).toBe("wsl");
    expect(lastTerminalProps.cliArgs).toEqual(["--distribution", "Ubuntu"]);
    expect(screen.getByText("Terminal · WSL · Ubuntu")).toBeInTheDocument();
  });

  it("launches PacketCode with the exact probed binary and visibly reports version and home", async () => {
    const executablePath = "C:\\Users\\ian\\bin\\packetcode.exe";
    const dataHome = "C:\\Users\\ian\\.packetcode-isolated";
    probePacketCodeIntegration.mockResolvedValue({
      healthy: true,
      executablePath,
      version: "packetcode v0.5.1-127-gd646094 (d646094)",
      exitCode: 0,
      schemaVersion: 1,
      doctorStatus: "ok",
      effectiveHome: dataHome,
      homeSource: "environment",
      providerSummary: { configured: 1, ready: 1, warning: 0, failed: 0 },
      doctor: {},
    });
    usePacketCodeIntegrationStore.setState({ localDataHome: dataHome });
    useCliOverrideStore.setState({
      overrides: { packetcode: { manualPath: executablePath } },
    });
    useAgentStore.setState({
      agents: [...useAgentStore.getState().agents, { ...PACKETCODE_CONFIG, installed: true }],
    });
    const workspace = useWorkspaceStore.getState().workspaces[0];
    const pane = { id: "pane-packetcode", agentId: "packetcode" as const, sessionId: null };

    const view = render(<WorkspacePane pane={pane} workspaceId={workspace.id} />);

    await waitFor(() => expect(lastTerminalProps.cliCommand).toBe(executablePath));
    expect(probePacketCodeIntegration).toHaveBeenCalledWith(executablePath, dataHome);
    expect(screen.getByText("v0.5.1-127-gd646094 (d646094)")).toBeInTheDocument();

    fireEvent.click(screen.getByTitle("More"));
    expect(screen.getByText(`Binary: ${executablePath}`)).toBeInTheDocument();
    expect(screen.getByText(`Home: ${dataHome}`)).toBeInTheDocument();

    view.rerender(
      <WorkspacePane pane={{ ...pane, sessionId: "pty-live" }} workspaceId={workspace.id} />,
    );
    usePacketCodeIntegrationStore.setState({ localDataHome: "C:\\changed-after-launch" });
    await waitFor(() => expect(probePacketCodeIntegration).toHaveBeenCalledTimes(1));
    expect(lastTerminalProps.cliCommand).toBe(executablePath);
  });

  function packetCodeIdentity(executablePath: string, effectiveHome: string) {
    return {
      healthy: true,
      executablePath,
      version: "packetcode v0.5.1 (abc123)",
      exitCode: 0,
      schemaVersion: 1,
      doctorStatus: "ok",
      effectiveHome,
      homeSource: "environment",
      providerSummary: { configured: 1, ready: 1, warning: 0, failed: 0 },
      doctor: {},
    };
  }

  function mountPacketCodePane(manualPath: string) {
    useCliOverrideStore.setState({ overrides: { packetcode: { manualPath } } });
    useAgentStore.setState({
      agents: [...useAgentStore.getState().agents, { ...PACKETCODE_CONFIG, installed: true }],
    });
    const workspace = useWorkspaceStore.getState().workspaces[0];
    const pane = { id: "pane-packetcode", agentId: "packetcode" as const, sessionId: null };
    const view = render(<WorkspacePane pane={pane} workspaceId={workspace.id} />);
    return { view, pane, workspaceId: workspace.id };
  }

  // REGRESSION: a session ending used to flip the pane back to "probing",
  // which unmounted TerminalPane; the remount re-armed autoStart and
  // relaunched PacketCode. A binary that exits at startup looped forever.
  it("keeps the pane mounted and does not re-probe when a PacketCode session ends unchanged", async () => {
    const executablePath = "C:\\Users\\ian\\bin\\packetcode.exe";
    probePacketCodeIntegration.mockResolvedValue(packetCodeIdentity(executablePath, "C:\\home"));
    const { view, pane, workspaceId } = mountPacketCodePane(executablePath);
    await waitFor(() => expect(lastTerminalProps.cliCommand).toBe(executablePath));

    view.rerender(<WorkspacePane pane={{ ...pane, sessionId: "pty-live" }} workspaceId={workspaceId} />);
    lastTerminalProps = {};
    view.rerender(<WorkspacePane pane={pane} workspaceId={workspaceId} />);

    expect(probePacketCodeIntegration).toHaveBeenCalledTimes(1);
    expect(screen.queryByText("Resolving PacketCode")).toBeNull();
    // TerminalPane re-rendered rather than unmounting, so it recorded props again.
    expect(lastTerminalProps.cliCommand).toBe(executablePath);
  });

  it("applies Settings changed during a live session on the next launch without unmounting", async () => {
    const firstPath = "C:\\Users\\ian\\bin\\packetcode.exe";
    const secondPath = "D:\\tools\\packetcode.exe";
    probePacketCodeIntegration.mockResolvedValueOnce(packetCodeIdentity(firstPath, "C:\\home"));
    const { view, pane, workspaceId } = mountPacketCodePane(firstPath);
    await waitFor(() => expect(lastTerminalProps.cliCommand).toBe(firstPath));

    view.rerender(<WorkspacePane pane={{ ...pane, sessionId: "pty-live" }} workspaceId={workspaceId} />);
    let resolveSecond: (value: unknown) => void = () => {};
    probePacketCodeIntegration.mockImplementationOnce(
      () => new Promise((resolve) => (resolveSecond = resolve)),
    );
    useCliOverrideStore.setState({ overrides: { packetcode: { manualPath: secondPath } } });
    // Deferred while the session is alive.
    expect(probePacketCodeIntegration).toHaveBeenCalledTimes(1);

    lastTerminalProps = {};
    view.rerender(<WorkspacePane pane={pane} workspaceId={workspaceId} />);
    await waitFor(() => expect(probePacketCodeIntegration).toHaveBeenCalledTimes(2));
    expect(probePacketCodeIntegration).toHaveBeenLastCalledWith(secondPath, null);
    // In-flight re-probe keeps the ended pane (and its transcript) on screen.
    expect(screen.queryByText("Resolving PacketCode")).toBeNull();
    expect(lastTerminalProps.cliCommand).toBe(firstPath);

    resolveSecond(packetCodeIdentity(secondPath, "C:\\home"));
    await waitFor(() => expect(lastTerminalProps.cliCommand).toBe(secondPath));
  });

  it("blocks PacketCode launch when PACKETCODE_HOME is not absolute", async () => {
    usePacketCodeIntegrationStore.setState({ localDataHome: "relative/home" });
    useAgentStore.setState({
      agents: [...useAgentStore.getState().agents, { ...PACKETCODE_CONFIG, installed: true }],
    });
    const workspace = useWorkspaceStore.getState().workspaces[0];
    const pane = { id: "pane-packetcode", agentId: "packetcode" as const, sessionId: null };

    render(<WorkspacePane pane={pane} workspaceId={workspace.id} />);

    expect(await screen.findByText("PacketCode launch blocked")).toBeInTheDocument();
    expect(screen.getByText(/PACKETCODE_HOME must be an absolute host path/)).toBeInTheDocument();
    expect(lastTerminalProps).toEqual({});
    expect(probePacketCodeIntegration).not.toHaveBeenCalled();
  });
});
