import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  templates: [
    {
      id: "prompt",
      name: "Keep this prompt",
      content: "intended content",
      category: "general",
      createdAt: 1,
      updatedAt: 1,
    },
  ],
  sendToTerminal: vi.fn(),
  sendToAgentChat: vi.fn(),
  addTemplate: vi.fn(),
  updateTemplate: vi.fn(),
  deleteTemplate: vi.fn(),
}));
vi.mock("@/stores/promptStore", () => ({
  usePromptStore: (select: (value: typeof state) => unknown) => select(state),
}));
import { PromptLibrary } from "../PromptLibrary";

describe("Prompt Library send failures", () => {
  beforeEach(() => vi.clearAllMocks());

  it.each(["Terminal", "Scout"])(
    "keeps the dialog and prompt on a failed %s send, and closes after explicit retry succeeds",
    async (destination) => {
      const send = destination === "Terminal" ? state.sendToTerminal : state.sendToAgentChat;
      send
        .mockRejectedValueOnce(new Error("Destination unavailable"))
        .mockResolvedValueOnce(undefined);
      const close = vi.fn();
      render(<PromptLibrary onClose={close} />);
      fireEvent.click(screen.getByRole("button", { name: destination }));
      expect(await screen.findByRole("alert")).toHaveTextContent("Destination unavailable");
      expect(close).not.toHaveBeenCalled();
      expect(screen.getByText("intended content")).toBeVisible();
      fireEvent.click(screen.getByRole("button", { name: destination }));
      await waitFor(() => expect(close).toHaveBeenCalledOnce());
      expect(send).toHaveBeenCalledTimes(2);
    },
  );
});
