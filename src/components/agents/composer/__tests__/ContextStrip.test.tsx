import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentConversation } from "@/types/agent-conversation";
import type { SessionCapabilities } from "@/lib/agentCapabilities";
import { useAgentSidebarPrefsStore } from "@/stores/agentSidebarPrefsStore";
import { ContextStrip } from "../ContextStrip";

const { gitSafetyCheckMock } = vi.hoisted(() => ({
  gitSafetyCheckMock: vi.fn(),
}));

vi.mock("@/lib/tauri", () => ({
  gitSafetyCheck: (...args: unknown[]) => gitSafetyCheckMock(...args),
}));

const EMPTY_REPORT = {
  isGitRepo: false,
  branch: null,
  hasUpstream: false,
  isClean: true,
  uncommittedCount: 0,
  behindUpstream: 0,
  warnings: [],
};

function makeConversation(over: Partial<AgentConversation> = {}): AgentConversation {
  return {
    id: "conv-1",
    title: "Test",
    agent: "api-openai",
    projectPath: "/home/user/repo",
    status: "idle",
    messages: [],
    sessionId: "s1",
    rawOutput: "",
    createdAt: 1,
    updatedAt: 1,
    mode: "api",
    provider: "openai",
    model: "gpt-4o",
    ...over,
  };
}

function makeCaps(over: Partial<SessionCapabilities> = {}): SessionCapabilities {
  return {
    canApprovePerTool: true,
    permissionModes: [],
    permissionVocabulary: "approval",
    canGateWrites: true,
    canPlanMode: true,
    models: [],
    modelsAreAuthoritative: false,
    effortLevels: null,
    emitsThinking: true,
    structuredPlans: false,
    structuredEdits: true,
    canCancelTurn: true,
    canQueueWhileStreaming: true,
    fileMentions: true,
    slashCommands: true,
    imageAttachments: true,
    contextWindow: null,
    reportsUsage: true,
    remote: false,
    mcp: false,
    canRename: true,
    canFork: true,
    usesProviderCredential: true,
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  gitSafetyCheckMock.mockResolvedValue(EMPTY_REPORT);
  useAgentSidebarPrefsStore.setState({ projectLabels: {} });
});

describe("ContextStrip narrow reflow (V8)", () => {
  it("keeps host and project identifiable for an SSH session", () => {
    const conv = makeConversation({
      projectPath: "/home/user/my-project",
      sshTarget: {
        id: "s1",
        name: "build",
        host: "build-host.example.invalid",
        user: "ci",
        remotePath: "/srv/worktree",
      },
    });

    render(<ContextStrip conversation={conv} caps={makeCaps({ remote: true })} />);

    // Short summaries stay in the DOM (wrapped, never clipped away).
    expect(screen.getByText("my-project")).toBeInTheDocument();
    expect(screen.getByText("build-host.example.invalid")).toBeInTheDocument();

    // The focusable disclosure surfaces the FULL, copyable identity.
    fireEvent.click(screen.getByRole("button", { name: "SSH: build-host.example.invalid" }));
    const dialog = screen.getByRole("dialog", { name: "Execution context" });
    expect(dialog).toHaveTextContent("ci@build-host.example.invalid");
    expect(dialog).toHaveTextContent("/srv/worktree");
    expect(dialog).toHaveTextContent("/home/user/my-project");
  });

  it("keeps project and branch identifiable for a local git session", async () => {
    gitSafetyCheckMock.mockResolvedValue({
      ...EMPTY_REPORT,
      isGitRepo: true,
      branch: "feature/x",
    });
    const conv = makeConversation({ projectPath: "/home/user/repo" });

    render(<ContextStrip conversation={conv} caps={makeCaps({ remote: false })} />);

    expect(await screen.findByText("feature/x")).toBeInTheDocument();
    expect(screen.getByText("repo")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Local" }));
    const dialog = screen.getByRole("dialog", { name: "Execution context" });
    expect(dialog).toHaveTextContent("feature/x");
    expect(dialog).toHaveTextContent("/home/user/repo");
  });

  it("wraps chips onto a second row instead of clipping them", () => {
    const conv = makeConversation({
      projectPath: "/home/user/my-project",
      sshTarget: {
        id: "s1",
        name: "build",
        host: "build-host.example.invalid",
        user: "ci",
        remotePath: "/srv/worktree",
      },
    });

    const { container } = render(
      <ContextStrip conversation={conv} caps={makeCaps({ remote: true })} />,
    );

    const strip = container.querySelector(".context-strip");
    expect(strip).not.toBeNull();
    // Reflow mechanism is flex-wrap (a responsive utility), not overflow clipping.
    expect(strip!.classList.contains("flex-wrap")).toBe(true);
    expect(strip!.classList.contains("overflow-hidden")).toBe(false);
  });
});
