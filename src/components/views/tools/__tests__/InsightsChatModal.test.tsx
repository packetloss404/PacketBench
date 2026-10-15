import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  listeners: new Map<string, (event: { payload: unknown }) => void>(),
  listen: vi.fn(),
  ask: vi.fn(),
  cancel: vi.fn(),
  resolve: vi.fn(),
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: (...args: unknown[]) => mocks.listen(...args) }));
vi.mock("@/lib/tauri", () => ({
  askAgentChatStream: (...args: unknown[]) => mocks.ask(...args),
  cancelAgentChatStream: (...args: unknown[]) => mocks.cancel(...args),
  getAuxRouteResolutions: () => mocks.resolve(),
}));
vi.mock("@/stores/agentTaskStore", () => ({
  useAgentTaskStore: (selector: (state: { selectedRepo: string }) => unknown) =>
    selector({ selectedRepo: "D:/fixture" }),
}));
const mappings: unknown[] = [];
vi.mock("@/stores/routingStore", () => ({
  useRoutingStore: (selector: (state: { auxMappings: unknown[] }) => unknown) =>
    selector({ auxMappings: mappings }),
}));
vi.mock("@/components/agents/composer/ProjectPicker", () => ({
  ProjectPicker: () => <div>Fixture project</div>,
}));
vi.mock("@/components/common/MarkdownRenderer", () => ({
  MarkdownRenderer: ({ content }: { content: string }) => <div>{content}</div>,
}));
import { InsightsChatModal } from "../InsightsChatModal";

function emit(kind: string, id: string, payload: unknown) {
  act(() => {
    mocks.listeners.get(`agent-chat:${kind}:${id}`)?.({ payload });
  });
}
async function send(text: string) {
  fireEvent.change(screen.getByLabelText("Insights question"), { target: { value: text } });
  fireEvent.click(screen.getByRole("button", { name: "Send" }));
  await waitFor(() => expect(mocks.ask).toHaveBeenCalled());
  return mocks.ask.mock.calls[mocks.ask.mock.calls.length - 1]![3] as string;
}

describe("Insights routed chat", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.listeners.clear();
    mocks.ask.mockResolvedValue(undefined);
    mocks.cancel.mockResolvedValue(true);
    mocks.resolve.mockResolvedValue([
      { taskClass: "agent-chat", provider: "sugar", model: "sugar/conduit", error: null },
    ]);
    mocks.listen.mockImplementation(
      async (event: string, callback: (event: { payload: unknown }) => void) => {
        mocks.listeners.set(event, callback);
        return vi.fn(() => mocks.listeners.delete(event));
      },
    );
  });
  it("shows the resolved route and sends full history while joining exact deltas", async () => {
    render(<InsightsChatModal onClose={vi.fn()} />);
    expect(await screen.findByText("sugar · sugar/conduit")).toBeInTheDocument();
    const first = await send("Read the marker");
    expect(mocks.listeners.size).toBe(3);
    emit("chunk", first, "MAR");
    emit("chunk", first, "BLE");
    emit("done", first, true);
    expect(screen.getByText("MARBLE")).toBeInTheDocument();
    expect(mocks.listeners.size).toBe(0);
    mocks.ask.mockClear();
    const second = await send("What was the marker?");
    expect(second).not.toBe(first);
    expect(mocks.ask.mock.calls[0].slice(0, 3)).toEqual([
      "D:/fixture",
      [
        { role: "user", content: "Read the marker" },
        { role: "assistant", content: "MARBLE" },
        { role: "user", content: "What was the marker?" },
      ],
      undefined,
    ]);
  });
  it("Stop cancels only this request and ignores late events", async () => {
    render(<InsightsChatModal onClose={vi.fn()} />);
    const id = await send("Investigate");
    const late = mocks.listeners.get(`agent-chat:chunk:${id}`);
    fireEvent.click(screen.getByRole("button", { name: "Stop" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Send" })).toBeInTheDocument());
    expect(mocks.cancel).toHaveBeenCalledWith(id);
    act(() => late?.({ payload: "late output" }));
    expect(screen.queryByText("late output")).not.toBeInTheDocument();
  });
  it("closing cancels active work and removes its listeners", async () => {
    const view = render(<InsightsChatModal onClose={vi.fn()} />);
    const id = await send("Investigate");
    view.unmount();
    expect(mocks.cancel).toHaveBeenCalledWith(id);
    expect(mocks.listeners.size).toBe(0);
  });
  it("surfaces provider errors and allows another question", async () => {
    render(<InsightsChatModal onClose={vi.fn()} />);
    const id = await send("Investigate");
    emit("error", id, { message: "Choose a configured provider" });
    emit("done", id, false);
    expect(screen.getByRole("alert")).toHaveTextContent("Choose a configured provider");
    expect(screen.getByRole("button", { name: "Send" })).toBeInTheDocument();
  });
  it("retries cancellation when Stop raced request registration", async () => {
    let acknowledge!: () => void;
    mocks.ask.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          acknowledge = resolve;
        }),
    );
    render(<InsightsChatModal onClose={vi.fn()} />);
    const id = await send("Investigate");
    fireEvent.click(screen.getByRole("button", { name: "Stop" }));
    await waitFor(() => expect(mocks.cancel).toHaveBeenCalledTimes(1));
    await act(async () => acknowledge());
    expect(mocks.cancel).toHaveBeenLastCalledWith(id);
    expect(mocks.cancel).toHaveBeenCalledTimes(2);
  });
});
