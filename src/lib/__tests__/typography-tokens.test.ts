import { describe, expect, it } from "vitest";
// @ts-expect-error node builtin; @types/node is not part of this project's types
import { readFileSync } from "node:fs";

/**
 * V1 typography-token gate: the shared reading scale stays at the comfortable
 * defaults and no role drops below 12px.
 */

const css: string = readFileSync(new URL("../../index.css", import.meta.url), "utf8");

function token(name: string): string {
  const match = css.match(new RegExp(`--${name}:\\s*(\\d+(?:\\.\\d+)?)px`));
  if (!match) throw new Error(`Missing token --${name}`);
  return `${match[1]}px`;
}

describe("appearance typography tokens (V1)", () => {
  it("uses the comfortable default scale", () => {
    expect(token("text-ui")).toBe("13px");
    expect(token("leading-ui")).toBe("20px");
    expect(token("text-meta")).toBe("12px");
    expect(token("leading-meta")).toBe("16px");
    expect(token("text-body")).toBe("15px");
    expect(token("leading-body")).toBe("24px");
    expect(token("text-composer")).toBe("15px");
    expect(token("leading-composer")).toBe("22px");
    expect(token("text-code")).toBe("13px");
    expect(token("leading-code")).toBe("20px");
    expect(token("text-chip")).toBe("12px");
  });

  it("keeps every ordinary role at 12px or larger", () => {
    for (const role of [
      "text-ui",
      "text-meta",
      "text-body",
      "text-composer",
      "text-code",
      "text-chip",
    ]) {
      expect(parseFloat(token(role))).toBeGreaterThanOrEqual(12);
    }
  });
});
