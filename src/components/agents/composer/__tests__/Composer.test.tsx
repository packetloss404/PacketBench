import { createRef } from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Composer } from "@/components/agents/composer/Composer";
import { LAUNCH_DRAFT_KEY, useAgentDraftStore } from "@/stores/agentDraftStore";
import type { AgentConversation } from "@/types/agent-conversation";

const mocks = vi.hoisted(() => ({
  agentTaskState: {
    selectedRepo: "D:\\projects\\PacketBench" as string | null,
    selectedConversationId: null as string | null,
    conversations: [] as unknown[],
    cancellingConversationIds: new Set<string>(),
    setSelectedRepo: vi.fn(),
    sendMessage: vi.fn(),
    cancelActiveConversation: vi.fn(),
    createApiConversation: vi.fn(),
    selectConversation: vi.fn(),
    setPlanMode: vi.fn(),
  },
  createObjectURL: vi.fn(),
  revokeObjectURL: vi.fn(),
}));

vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: vi.fn(),
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(() => Promise.resolve(() => {})),
}));

vi.mock("@/stores/agentTaskStore", () => {
  const useAgentTaskStore = Object.assign(
    vi.fn((selector: (state: typeof mocks.agentTaskState) => unknown) =>
      selector(mocks.agentTaskState),
    ),
    {
      getState: vi.fn(() => mocks.agentTaskState),
    },
  );
  // The real map, not a prefix-strip: `api-claude` is `anthropic`, and a
  // mock that models the bug teaches the next reader the wrong shape.
  // `api-openai-codex` is RETIRED but keeps its identity entry so a stored
  // record cannot fall through to the anthropic default.
  const apiAgentProvider = (agent: string) =>
    (
      ({
        "api-claude-oauth": "claude-oauth",
        "api-claude": "anthropic",
        "api-openai-codex": "openai-codex",
        "api-openai-agents": "openai-agents",
        "api-openai": "openai",
        "api-minimax": "minimax",
        "api-openrouter": "openrouter",
        "api-ollama": "ollama",
      }) as Record<string, string>
    )[agent] ?? "anthropic";
  return {
    useAgentTaskStore,
    apiAgentProvider,
    // Auth BADGES key on the credential, not the routing target: the Agent
    // SDK row routes as `claude-oauth` but authenticates with the Anthropic
    // API key, so its badge probes `anthropic`.
    authProbeProvider: (agent: string) => {
      const routing = apiAgentProvider(agent);
      return routing === "claude-oauth" ? "anthropic" : routing;
    },
    repoDisplayName: (path: string) => path.split(/[\\/]/).pop() ?? path,
  };
});

vi.mock("@/stores/githubStore", () => ({
  useGitHubStore: vi.fn((selector: (state: { repos: unknown[] }) => unknown) =>
    selector({ repos: [] }),
  ),
}));

vi.mock("@/stores/projectHistoryStore", () => ({
  useProjectHistoryStore: vi.fn(
    (selector: (state: { projects: unknown[]; recordOpen: () => void }) => unknown) =>
      selector({ projects: [], recordOpen: vi.fn() }),
  ),
}));

vi.mock("@/stores/serverStore", () => ({
  useServerStore: vi.fn(
    (selector: (state: { servers: unknown[]; updateServer: () => void }) => unknown) =>
      selector({ servers: [], updateServer: vi.fn() }),
  ),
}));

vi.mock("@/stores/appStore", () => ({
  useAppStore: vi.fn((selector: (state: { setActiveView: () => void }) => unknown) =>
    selector({ setActiveView: vi.fn() }),
  ),
}));

vi.mock("@/stores/promptStore", () => ({
  usePromptStore: vi.fn((selector: (state: { templates: unknown[] }) => unknown) =>
    selector({ templates: [] }),
  ),
}));

vi.mock("@/stores/profileStore", () => ({
  useProfileStore: vi.fn(
    (
      selector: (state: {
        profiles: Array<{ id: string; name: string; description: string; isBuiltin: boolean }>;
        defaultProfileId: string;
        setDefaultProfile: () => void;
      }) => unknown,
    ) =>
      selector({
        profiles: [
          {
            id: "default",
            name: "Default",
            description: "Default profile",
            isBuiltin: true,
          },
        ],
        defaultProfileId: "default",
        setDefaultProfile: vi.fn(),
      }),
  ),
}));

vi.mock("@/hooks/useVoiceInput", () => ({
  useVoiceInput: () => ({
    isListening: false,
    transcript: "",
    startListening: vi.fn(),
    stopListening: vi.fn(),
    isSupported: false,
  }),
}));

vi.mock("@/components/agents/FileMentionPopover", () => ({
  FileMentionPopover: () => null,
}));

vi.mock("@/lib/tauri", () => ({
  getProviderAuthStatus: vi.fn(() => Promise.resolve({ status: "ready", hint: "" })),
  listOllamaModels: vi.fn(() => Promise.resolve([])),
  listSlashCommands: vi.fn(() => Promise.resolve([])),
  listSkills: vi.fn(() => Promise.resolve([])),
  // The composer's context strip owns the git poll now (it moved off the
  // deleted SessionMetaLine band), so this export has to resolve here.
  gitSafetyCheck: vi.fn(() => Promise.resolve(null)),
}));

function renderLaunch(
  onLaunch: (text: string, attachments: unknown[]) => boolean | Promise<boolean>,
) {
  return render(
    <Composer
      variant="launch"
      textareaRef={createRef<HTMLTextAreaElement>()}
      selectedAgent="api-minimax"
      onAgentChange={vi.fn()}
      onLaunch={onLaunch}
      selectedModel="MiniMax-M2.5"
      onModelChange={vi.fn()}
    />,
  );
}

function makeConversation(id: string): AgentConversation {
  return {
    id,
    title: "Chat test",
    agent: "api-openai",
    projectPath: "D:\\projects\\PacketBench",
    status: "idle",
    messages: [],
    sessionId: id,
    rawOutput: "",
    createdAt: 1,
    updatedAt: 1,
    mode: "api",
    provider: "openai",
    model: "gpt-4o",
  };
}

function chatElement(conversation: AgentConversation) {
  return (
    <Composer
      variant="chat"
      conversationId={conversation.id}
      conversation={conversation}
      pendingApprovalCount={0}
      onCancelPending={vi.fn()}
      onCycleMode={vi.fn()}
      onSelectMode={vi.fn()}
      onSetApproveWrites={vi.fn()}
      onChangeModel={vi.fn()}
    />
  );
}

function renderChat(conversation: AgentConversation) {
  return render(chatElement(conversation));
}

async function stageImage(
  name = "shot.png",
  placeholder: RegExp = /what would you like to work on/i,
) {
  const file = new File(["image-bytes"], name, { type: "image/png" });
  const textarea = screen.getByPlaceholderText(placeholder);
  fireEvent.paste(textarea, {
    clipboardData: {
      items: [
        {
          kind: "file",
          getAsFile: () => file,
        },
      ],
    },
  });
  await screen.findByText(name);
}

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  useAgentDraftStore.setState({
    drafts: {},
    stagedAttachments: {},
    attachmentRejections: {},
    stagingGenerations: {},
  });
  mocks.agentTaskState.selectedRepo = "D:\\projects\\PacketBench";
  mocks.agentTaskState.cancellingConversationIds = new Set<string>();
  // jsdom has no layout engine, and `InputPopover` scrolls its highlighted row
  // into view the moment the `/` or `@` menu has rows. Without this shim the
  // effect throws and takes the whole render down.
  Element.prototype.scrollIntoView = vi.fn();
  let counter = 0;
  mocks.createObjectURL.mockImplementation(() => `blob:preview-${++counter}`);
  Object.defineProperty(URL, "createObjectURL", {
    configurable: true,
    value: mocks.createObjectURL,
  });
  Object.defineProperty(URL, "revokeObjectURL", {
    configurable: true,
    value: mocks.revokeObjectURL,
  });
});

describe("Composer (launch variant) — image attachments", () => {
  it("keeps staged images when launch is rejected as a no-op", async () => {
    useAgentDraftStore.getState().setDraft(LAUNCH_DRAFT_KEY, "describe this screenshot");
    const onLaunch = vi.fn((_text: string, _attachments: unknown[]) => false);
    renderLaunch(onLaunch);
    await stageImage();

    const launch = await screen.findByRole("button", { name: /launch/i });
    await waitFor(() => expect(launch).not.toBeDisabled());
    fireEvent.click(launch);

    expect(onLaunch).toHaveBeenCalledTimes(1);
    // Text + attachments are handed to the caller together.
    expect(onLaunch.mock.calls[0][0]).toBe("describe this screenshot");
    expect(screen.getByText("shot.png")).toBeInTheDocument();
    expect(mocks.revokeObjectURL).not.toHaveBeenCalled();
  });

  it("keeps staged images while an async launch is pending and clears them on success", async () => {
    let resolveLaunch!: (accepted: boolean) => void;
    const onLaunch = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          resolveLaunch = resolve;
        }),
    );
    renderLaunch(onLaunch);
    await stageImage("pending.png");

    const launch = await screen.findByRole("button", { name: /launch/i });
    await waitFor(() => expect(launch).not.toBeDisabled());
    fireEvent.click(launch);
    fireEvent.click(launch);

    // The single-flight latch holds until the async launch settles.
    expect(onLaunch).toHaveBeenCalledTimes(1);
    expect(screen.getByText("pending.png")).toBeInTheDocument();

    resolveLaunch(true);
    await waitFor(() => expect(screen.queryByText("pending.png")).not.toBeInTheDocument());
  });

  it("keeps staged images when an async launch fails", async () => {
    let resolveLaunch!: (accepted: boolean) => void;
    const onLaunch = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          resolveLaunch = resolve;
        }),
    );
    renderLaunch(onLaunch);
    await stageImage("retry.png");

    const launch = await screen.findByRole("button", { name: /launch/i });
    await waitFor(() => expect(launch).not.toBeDisabled());
    fireEvent.click(launch);

    resolveLaunch(false);
    await waitFor(() => expect(screen.getByText("retry.png")).toBeInTheDocument());

    // A failed async launch releases the latch so Retry can run.
    fireEvent.click(launch);
    expect(onLaunch).toHaveBeenCalledTimes(2);
    resolveLaunch(true);
    await waitFor(() => expect(screen.queryByText("retry.png")).not.toBeInTheDocument());
  });

  it("keeps each conversation's staged images while switching A -> B -> A", async () => {
    const conversationA = makeConversation("conv-a");
    const conversationB = makeConversation("conv-b");
    const { rerender } = renderChat(conversationA);

    await stageImage("only-a.png", /do anything/i);
    expect(screen.getByText("only-a.png")).toBeInTheDocument();

    rerender(chatElement(conversationB));
    expect(screen.queryByText("only-a.png")).not.toBeInTheDocument();

    await stageImage("only-b.png", /do anything/i);
    expect(screen.getByText("only-b.png")).toBeInTheDocument();
    expect(screen.queryByText("only-a.png")).not.toBeInTheDocument();

    rerender(chatElement(conversationA));
    expect(screen.getByText("only-a.png")).toBeInTheDocument();
    expect(screen.queryByText("only-b.png")).not.toBeInTheDocument();
  });

  it("labels in-memory attachments as kept only for this session", async () => {
    renderLaunch(vi.fn(() => false));
    await stageImage();

    expect(screen.getByText("Kept in this session")).toBeInTheDocument();
  });

  it("shows an unsupported-type rejection instead of silently dropping the file", async () => {
    renderLaunch(vi.fn(() => false));
    const file = new File(["plain text"], "notes.txt", { type: "text/plain" });
    fireEvent.paste(screen.getByPlaceholderText(/what would you like to work on/i), {
      clipboardData: {
        items: [{ kind: "file", getAsFile: () => file }],
      },
    });

    expect(
      await screen.findByText("notes.txt was not added: only image files are supported"),
    ).toBeInTheDocument();
  });

  it("shows an oversized-image rejection with the 5 MiB limit", async () => {
    renderLaunch(vi.fn(() => false));
    const file = new File(["image-bytes"], "huge.png", { type: "image/png" });
    Object.defineProperty(file, "size", { value: 5 * 1024 * 1024 + 1 });
    fireEvent.paste(screen.getByPlaceholderText(/what would you like to work on/i), {
      clipboardData: {
        items: [{ kind: "file", getAsFile: () => file }],
      },
    });

    expect(
      await screen.findByText("huge.png was not added: images must be 5 MiB or smaller"),
    ).toBeInTheDocument();
  });

  it("revokes a preview URL when its chip is removed, but retains images across unmount", async () => {
    const onLaunch = vi.fn(() => false);
    const { unmount } = renderLaunch(onLaunch);

    await stageImage("remove-me.png");
    fireEvent.click(screen.getByRole("button", { name: /remove remove-me\.png/i }));
    await waitFor(() => expect(screen.queryByText("remove-me.png")).not.toBeInTheDocument());
    expect(mocks.revokeObjectURL).toHaveBeenCalledWith("blob:preview-1");

    await stageImage("unmount-me.png");
    unmount();
    expect(mocks.revokeObjectURL).not.toHaveBeenCalledWith("blob:preview-2");
  });

  it("reads and writes its draft in the launch slot of the draft store", () => {
    renderLaunch(vi.fn(() => false));
    const textarea = screen.getByPlaceholderText(/what would you like to work on/i);
    fireEvent.change(textarea, { target: { value: "half-typed launch prompt" } });
    expect(useAgentDraftStore.getState().drafts[LAUNCH_DRAFT_KEY]).toBe("half-typed launch prompt");
  });
});

describe("Composer (chat variant) — per-conversation drafts + send (protected)", () => {
  it("persists the draft under the conversation id with no bleed", () => {
    useAgentDraftStore.getState().setDraft("conv-other", "other draft");
    const conv = makeConversation("conv-1");
    renderChat(conv);

    const textarea = screen.getByPlaceholderText(/do anything/i);
    fireEvent.change(textarea, { target: { value: "typed in conv-1" } });

    const drafts = useAgentDraftStore.getState().drafts;
    expect(drafts["conv-1"]).toBe("typed in conv-1");
    expect(drafts["conv-other"]).toBe("other draft");
    expect(drafts[LAUNCH_DRAFT_KEY]).toBeUndefined();
  });

  it("shows the persisted draft for its conversation on mount", () => {
    useAgentDraftStore.getState().setDraft("conv-1", "restored draft");
    renderChat(makeConversation("conv-1"));
    expect(screen.getByPlaceholderText(/do anything/i)).toHaveValue("restored draft");
  });

  it("Enter sends the trimmed draft through sendMessage and clears it", () => {
    renderChat(makeConversation("conv-1"));
    const textarea = screen.getByPlaceholderText(/do anything/i);
    fireEvent.change(textarea, { target: { value: "  hello agent  " } });
    fireEvent.keyDown(textarea, { key: "Enter" });

    expect(mocks.agentTaskState.sendMessage).toHaveBeenCalledWith("conv-1", "hello agent", null);
    expect(useAgentDraftStore.getState().drafts["conv-1"]).toBeUndefined();
  });

  it("still dispatches to sendMessage while the agent is streaming (store queues it)", () => {
    const conv = makeConversation("conv-1");
    conv.status = "active";
    conv.messages = [
      {
        id: "m-a",
        role: "assistant",
        content: "streaming…",
        timestamp: 1,
        isStreaming: true,
      },
    ];
    renderChat(conv);
    const textarea = screen.getByPlaceholderText(/do anything/i);
    fireEvent.change(textarea, { target: { value: "queue me" } });
    fireEvent.keyDown(textarea, { key: "Enter" });

    expect(mocks.agentTaskState.sendMessage).toHaveBeenCalledWith("conv-1", "queue me", null);
  });

  it("disables and pulses Stop while terminal cancellation acknowledgement is pending", () => {
    const conv = makeConversation("conv-stopping");
    conv.status = "active";
    conv.messages = [
      {
        id: "m-streaming",
        role: "assistant",
        content: "still winding down",
        timestamp: 1,
        isStreaming: true,
      },
    ];
    mocks.agentTaskState.cancellingConversationIds = new Set([conv.id]);

    const { container } = renderChat(conv);
    const stopIcon = container.querySelector("svg.lucide-square");
    const stopButton = stopIcon?.closest("button");

    expect(stopButton).toBeDisabled();
    expect(stopIcon).toHaveClass("animate-pulse");
    fireEvent.click(stopButton!);
    expect(mocks.agentTaskState.cancelActiveConversation).not.toHaveBeenCalled();
  });
});
