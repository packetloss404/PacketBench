import { describe, expect, it } from "vitest";
// @ts-expect-error node builtin; @types/node is not part of this project's types
import { readFileSync } from "node:fs";

/**
 * V2 contrast regression gate. Reads the real `src/index.css` token values and
 * checks every informative text role against all five surfaces of its theme,
 * using sRGB relative luminance. This is a token-level proof, not a full-app
 * accessibility certification (accent-alpha fills, disabled and diff states
 * still need their own composited checks).
 */

const css: string = readFileSync(new URL("../../index.css", import.meta.url), "utf8");

const DARK_SURFACES = ["#0f0f10", "#161617", "#1c1c1e", "#232326", "#2a2a2e"];
const LIGHT_SURFACES = ["#ffffff", "#f8f8fc", "#ededf5", "#e4e4ee", "#d8d8e6"];

function themeBlock(selector: string): string {
  const match = css.match(new RegExp(`${selector}\\s*\\{([\\s\\S]*?)\\}`));
  if (!match) throw new Error(`Missing theme block ${selector}`);
  return match[1];
}

function token(block: string, name: string): string {
  const match = block.match(new RegExp(`--${name}:\\s*(#[0-9a-fA-F]{6})`));
  if (!match) throw new Error(`Missing token --${name}`);
  return match[1];
}

function toRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function channel(value: number): number {
  const c = value / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

function luminance(hex: string): number {
  const [r, g, b] = toRgb(hex);
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

function ratio(a: string, b: string): number {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

function minimumOver(foreground: string, surfaces: string[]): number {
  return Math.min(...surfaces.map((surface) => ratio(foreground, surface)));
}

const ROLES = ["text-primary", "text-secondary", "text-muted", "text-faint"] as const;

describe("appearance contrast (V2)", () => {
  const dark = themeBlock(":root");
  const light = themeBlock('\\[data-theme="light"\\]');

  it.each(ROLES)("dark %s clears 4.5:1 on every surface", (role) => {
    const value = token(dark, `color-${role}`);
    expect(minimumOver(value, DARK_SURFACES)).toBeGreaterThanOrEqual(4.5);
  });

  it.each(ROLES)("light %s clears 4.5:1 on every surface", (role) => {
    const value = token(light, `color-${role}`);
    expect(minimumOver(value, LIGHT_SURFACES)).toBeGreaterThanOrEqual(4.5);
  });

  it("aliases the legacy faint token to the readable muted value", () => {
    expect(token(dark, "color-text-faint")).toBe(token(dark, "color-text-muted"));
    expect(token(light, "color-text-faint")).toBe(token(light, "color-text-muted"));
  });

  it("no longer carries the failing baseline values", () => {
    expect(token(dark, "color-text-faint").toLowerCase()).not.toBe("#5e5e66");
    expect(token(light, "color-text-muted").toLowerCase()).not.toBe("#9d9db5");
    expect(token(light, "color-text-faint").toLowerCase()).not.toBe("#b9b9c8");
  });
});
