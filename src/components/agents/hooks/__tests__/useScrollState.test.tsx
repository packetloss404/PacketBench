import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentMessage } from "@/types/agent-conversation";
import { useScrollState, getReadingAnchor, resetReadingAnchors } from "../useScrollState";

function message(id: string): AgentMessage {
  return { id, role: "user", content: id, timestamp: 1 };
}

function Harness({
  conversationId,
  messages,
}: {
  conversationId: string;
  messages: AgentMessage[];
}) {
  const { messagesContainerRef, messagesContentRef, messagesEndRef, isAtBottom, jumpToLatest } =
    useScrollState(conversationId, messages);
  return (
    <div ref={messagesContainerRef} data-testid="container">
      <div ref={messagesContentRef}>
        {messages.map((m) => (
          <div key={m.id} data-message-id={m.id} style={{ height: 100 }}>
            {m.content}
          </div>
        ))}
        <div ref={messagesEndRef} data-testid="end" />
      </div>
      <span data-testid="at-bottom">{String(isAtBottom)}</span>
      <button type="button" onClick={jumpToLatest}>
        Jump
      </button>
    </div>
  );
}

beforeEach(() => {
  resetReadingAnchors();
  Element.prototype.scrollIntoView = vi.fn();
});

afterEach(() => {
  vi.restoreAllMocks();
  resetReadingAnchors();
});

describe("useScrollState — reader continuity (F7)", () => {
  it("starts following latest; jumpToLatest scrolls to the end and resumes following", () => {
    render(<Harness conversationId="A" messages={[message("m0")]} />);
    expect(screen.getByTestId("at-bottom")).toHaveTextContent("true");

    fireEvent.click(screen.getByText("Jump"));

    expect(Element.prototype.scrollIntoView).toHaveBeenCalled();
    expect(getReadingAnchor("A")?.followingLatest).toBe(true);
  });

  it("saves a reading anchor on scroll away and restores it on return", () => {
    const { rerender } = render(
      <Harness conversationId="A" messages={[message("m0"), message("m1"), message("m2")]} />,
    );
    const container = screen.getByTestId("container");
    // Scroll geometry so a scrolled-away reader is detectable.
    Object.defineProperty(container, "scrollHeight", { configurable: true, value: 1000 });
    Object.defineProperty(container, "clientHeight", { configurable: true, value: 100 });
    Object.defineProperty(container, "scrollTop", { configurable: true, writable: true, value: 0 });
    // m0/m1 sit above the viewport; m2 is the first visible message.
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (
      this: HTMLElement,
    ) {
      const id = this.getAttribute("data-message-id");
      const top = id === "m0" ? -200 : id === "m1" ? -100 : 0;
      return {
        top,
        bottom: top + 100,
        left: 0,
        right: 0,
        width: 0,
        height: 100,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      } as DOMRect;
    });

    fireEvent.scroll(container);

    expect(getReadingAnchor("A")).toMatchObject({
      followingLatest: false,
      messageId: "m2",
    });

    // Switch away (B has no anchor → follows latest), then return to A.
    rerender(<Harness conversationId="B" messages={[message("x0")]} />);
    rerender(
      <Harness conversationId="A" messages={[message("m0"), message("m1"), message("m2")]} />,
    );

    // A restored its scrolled-up reader position instead of following latest.
    expect(screen.getByTestId("at-bottom")).toHaveTextContent("false");
    expect(getReadingAnchor("A")?.messageId).toBe("m2");
  });

  it("resetReadingAnchors clears saved anchors", () => {
    render(<Harness conversationId="A" messages={[message("m0")]} />);
    fireEvent.click(screen.getByText("Jump"));
    expect(getReadingAnchor("A")).toBeDefined();

    resetReadingAnchors();

    expect(getReadingAnchor("A")).toBeUndefined();
  });

  it("persists a scrolled-away anchor and drops it after jumpToLatest", () => {
    vi.useFakeTimers();
    try {
      render(
        <Harness conversationId="A" messages={[message("m0"), message("m1"), message("m2")]} />,
      );
      const container = screen.getByTestId("container");
      Object.defineProperty(container, "scrollHeight", { configurable: true, value: 1000 });
      Object.defineProperty(container, "clientHeight", { configurable: true, value: 100 });
      Object.defineProperty(container, "scrollTop", {
        configurable: true,
        writable: true,
        value: 0,
      });
      vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (
        this: HTMLElement,
      ) {
        const id = this.getAttribute("data-message-id");
        const top = id === "m0" ? -200 : id === "m1" ? -100 : 0;
        return {
          top,
          bottom: top + 100,
          left: 0,
          right: 0,
          width: 0,
          height: 100,
          x: 0,
          y: 0,
          toJSON: () => ({}),
        } as DOMRect;
      });

      fireEvent.scroll(container);
      act(() => {
        vi.advanceTimersByTime(600);
      });

      const persisted = JSON.parse(
        localStorage.getItem("packetbench:agent-reading-anchors") ?? "{}",
      );
      expect(persisted.A).toMatchObject({ messageId: "m2", followingLatest: false });

      fireEvent.click(screen.getByText("Jump"));
      act(() => {
        vi.advanceTimersByTime(600);
      });
      const after = JSON.parse(localStorage.getItem("packetbench:agent-reading-anchors") ?? "{}");
      expect(after.A).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });
});
