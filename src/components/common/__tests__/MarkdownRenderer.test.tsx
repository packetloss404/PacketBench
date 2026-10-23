import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { MarkdownRenderer } from "../MarkdownRenderer";

describe("MarkdownRenderer code typography (V4)", () => {
  it("renders fenced code with the text-code scale, theme tokens and horizontal scroll", () => {
    const { container } = render(
      <MarkdownRenderer content={'```typescript\nconst msg = "hi"; // done\n```'} />,
    );

    const code = container.querySelector('code[class*="language-"]');
    expect(code).not.toBeNull();

    // Size/line-height track the shared code scale, not an inline 11px override.
    const codeStyle = code!.getAttribute("style") ?? "";
    expect(codeStyle).toContain("font-size: var(--text-code)");
    expect(codeStyle).toContain("line-height: var(--leading-code)");

    // The PreTag keeps horizontal scrolling as a contained exception.
    const pre = code!.parentElement!;
    expect(pre.getAttribute("style")).toContain("overflow: auto");
    expect(pre.getAttribute("style")).toContain("var(--color-bg-primary)");

    // Syntax roles resolve through semantic theme tokens. react-syntax-highlighter
    // strips the token class names and inlines the role color instead, so assert
    // against the collected inline styles rather than `.token.comment` selectors.
    const tokenStyles = Array.from(container.querySelectorAll("span.token"))
      .map((s) => s.getAttribute("style") ?? "")
      .join(" ");

    expect(tokenStyles).toContain("var(--color-text-muted)"); // comment
    expect(tokenStyles).toContain("var(--color-accent-green)"); // string
    expect(tokenStyles).toContain("var(--color-accent-purple)"); // keyword
  });

  it("uses the text-code scale for inline code instead of an 11px override", () => {
    const { container } = render(<MarkdownRenderer content="run `npm install` now" />);

    const inline = container.querySelector("code.text-code");
    expect(inline).not.toBeNull();
    expect(inline!.className).toContain("text-code");
    expect(inline!.className).not.toContain("text-[11px]");
  });

  it("gives the copy control a named 32px+ target and a focus ring", () => {
    const { container } = render(<MarkdownRenderer content={"```bash\npwd\n```"} />);

    const copy = screen.getByRole("button", { name: "Copy code" });
    expect(copy).toBeInTheDocument();
    expect(copy.className).toContain("min-h-target-icon");
    expect(copy.className).toContain("min-w-target-icon");
    expect(copy.className).toContain("focus-visible:outline");
    expect(copy.className).toContain("focus-visible:outline-2");
    expect(copy.className).toContain("focus-visible:outline-focus-ring");
    expect(copy.className).toContain("group-focus-within:opacity-100");

    expect(container.querySelector('code[class*="language-bash"]')).not.toBeNull();
  });
});
