import { describe, expect, it } from "vitest";
import { WORKSPACE_CLI_REGISTRY, supportsLocalCli, usesWslCli } from "@/lib/workspaceCliRegistry";
import { WORKSPACE_BUILTIN_AGENTS } from "@/agents/workspace-presets";
import { CLI_CATALOG } from "@/lib/cli-catalog";
import { normalizeCustomCli } from "@/lib/customCli";
import { AGENT_CLI_NAMES } from "@/lib/ssh";

describe("Workspace CLI launch contract", () => {
  it("uses verified interactive entry points across detection, configs and SSH", () => {
    const expected = {
      "claude-code": "claude",
      codex: "codex",
      cursor: "agent",
      gemini: "gemini",
      copilot: "copilot",
      grok: "grok",
      droid: "droid",
      kimi: "kimi",
      amp: "amp",
      antigravity: "agy",
      aider: "aider",
    };
    for (const [id, command] of Object.entries(expected)) {
      const preset = WORKSPACE_CLI_REGISTRY.find((p) => p.id === id)!;
      expect(preset.binary).toBe(command);
      expect(preset.docsUrl).toMatch(/^https:\/\//);
      expect(WORKSPACE_BUILTIN_AGENTS.find((p) => p.id === id)?.command).toBe(command);
      expect(CLI_CATALOG.find((p) => p.id === id)?.binary).toBe(command);
      expect(AGENT_CLI_NAMES[id]).toBe(command);
    }
  });

  it("keeps Amp's Windows WSL requirement explicit", () => {
    expect(supportsLocalCli("amp", "windows")).toBe(true);
    expect(usesWslCli("amp", "windows")).toBe(true);
    expect(usesWslCli("amp", "linux")).toBe(false);
    expect(usesWslCli("codex", "windows")).toBe(false);
    const amp = WORKSPACE_CLI_REGISTRY.find((p) => p.id === "amp")!;
    expect(amp.installCommandWindows).toContain("wsl --cd");
    expect(amp.installCommandWindows).toContain("https://ampcode.com/install.sh");
    expect(supportsLocalCli("amp", "linux")).toBe(true);
    expect(supportsLocalCli("antigravity", "windows")).toBe(true);
  });

  it("preserves custom argument boundaries, environment and cwd without shell parsing", () => {
    const input = {
      name: "My agent",
      command: "C:\\Tools with spaces\\agent.exe",
      args: ["value with spaces", "$(echo no)", "x;y"],
      env: { MODE: "dev mode" },
      workingDirectory: "C:\\my project",
    };
    const output = normalizeCustomCli(input)!;
    input.args.push("later");
    input.env.MODE = "changed";
    expect(output.args).toEqual(["value with spaces", "$(echo no)", "x;y"]);
    expect(output.env.MODE).toBe("dev mode");
    expect(output.workingDirectory).toBe("C:\\my project");
  });

  it.each([
    { command: "" },
    { command: "agent\nsecond-command" },
    { args: "--flag" },
    { args: [3] },
    { env: { "BAD-NAME": "x" } },
    { env: { KEY: 7 } },
    { env: [] },
    { workingDirectory: 4 },
    { workingDirectory: "relative/folder" },
  ])("rejects malformed custom profiles: %j", (patch) => {
    expect(
      normalizeCustomCli({ name: "Test", command: "tool", args: [], env: {}, ...patch }),
    ).toBeUndefined();
  });
});
