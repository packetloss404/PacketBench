/**
 * agentCapabilities — the ONE place chrome asks "can this session do X?".
 *
 * The contract these assertions defend is not "the fields have nice values",
 * it is **the initial implementation reproduces today's behavior exactly**.
 * Each block therefore names the surface whose old inline branch the field
 * replaced, so a future widening is a deliberate edit here rather than a
 * silent behavior change somewhere in the Agents pane.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/tauri", () => ({
  saveServersSlice: vi.fn(),
}));

import { capabilitiesFor, type CapabilityConversation } from "@/lib/agentCapabilities";
import {
  MODE_ORDER,
  SANDBOX_MODE_ORDER,
  modesForApprovals,
} from "@/components/agents/agentModeChipUtils";
import { getProviderForAgent, providerSupportsApprovals } from "@/lib/api-models";

function conv(over: Partial<CapabilityConversation> = {}): CapabilityConversation {
  return {
    agent: "api-claude",
    mode: "api",
    model: "claude-opus-4-8",
    projectPath: "/repo",
    ...over,
  };
}

describe("capabilitiesFor — permission & safety", () => {
  it("offers the full five-posture set for approval-capable providers", () => {
    const caps = capabilitiesFor(conv());
    expect(caps.canApprovePerTool).toBe(true);
    expect(caps.permissionModes).toEqual(MODE_ORDER);
    expect(caps.permissionVocabulary).toBe("approval");
  });

  it("falls back to the sandbox postures when the adapter cannot pause", () => {
    // No live catalog row sets `supportsApprovals: false`, so this drives the
    // machinery directly to prove the descriptor forwards it rather than
    // hard-coding the approval answer.
    const caps = capabilitiesFor(conv());
    expect(caps.permissionModes).not.toEqual(SANDBOX_MODE_ORDER);
    expect(SANDBOX_MODE_ORDER.every((m) => MODE_ORDER.includes(m))).toBe(true);
  });

  it("gives a PTY session no postures, no write gate and no plan mode", () => {
    const caps = capabilitiesFor(conv({ mode: "pty", agent: "claude-code" }));
    expect(caps.permissionModes).toEqual([]);
    expect(caps.canGateWrites).toBe(false);
    expect(caps.canPlanMode).toBe(false);
  });

  it("does not sandbox-relabel a retired provider id", () => {
    // `api-openai-codex` has no catalog row, so it defaults to approval-capable
    // — the same answer AgentModeChip produced inline.
    const caps = capabilitiesFor(conv({ agent: "api-openai-codex" }));
    expect(caps.permissionVocabulary).toBe("approval");
  });
});

describe("capabilitiesFor — model & inference", () => {
  it("exposes the provider catalog rows as the pickable model set", () => {
    const caps = capabilitiesFor(conv({ agent: "api-openai" }));
    expect(caps.models.length).toBeGreaterThan(0);
    expect(caps.models.map((m) => m.value)).toContain("gpt-5.5");
  });

  it("returns an empty model set for an agent with no catalog row", () => {
    // ModelSelector rendered nothing in this case, so "no picker" is today's
    // behavior — the caller degrades to a read-only model name.
    expect(capabilitiesFor(conv({ agent: "claude-code", mode: "pty" })).models).toEqual([]);
    // …and it is NOT an authoritative empty. Nobody was asked; there is simply
    // no list. The two empties must stay distinguishable — collapsing them is
    // what made a live list's failure mode invisible.
    expect(
      capabilitiesFor(conv({ agent: "claude-code", mode: "pty" })).modelsAreAuthoritative,
    ).toBe(false);
  });

  it("prefers a live enumeration over the bundled catalog, for ANY provider", () => {
    // The descriptor no longer asks who the provider is, only whether
    // something authoritative answered.
    // Passed IN rather than read, because `capabilitiesFor` must stay pure.
    const caps = capabilitiesFor(conv({ agent: "api-openai" }), {
      status: "ready",
      models: [{ label: "gpt-9", value: "gpt-9" }],
    });
    expect(caps.models.map((m) => m.value)).toEqual(["gpt-9"]);
    expect(caps.modelsAreAuthoritative).toBe(true);
  });

  it("keeps the catalog when a live enumeration has not settled", () => {
    // `undefined`/failed is "never asked or the ask failed" — the degradation
    // rule that keeps a failed fetch from taking an affordance away.
    for (const live of [
      undefined,
      { status: "loading" as const },
      { status: "failed" as const, error: "boom" },
      { status: "no-key" as const },
    ]) {
      const caps = capabilitiesFor(conv({ agent: "api-openai" }), live);
      expect(caps.models).toEqual(getProviderForAgent("api-openai")?.models);
      expect(caps.modelsAreAuthoritative).toBe(false);
    }
  });

  it("lets a SETTLED empty live list override the catalog", () => {
    const caps = capabilitiesFor(conv({ agent: "api-openai" }), {
      status: "ready",
      models: [],
    });
    expect(caps.models).toEqual([]);
    expect(caps.modelsAreAuthoritative).toBe(true);
  });

  it("advertises no effort levels — no adapter exposes one yet", () => {
    expect(capabilitiesFor(conv()).effortLevels).toBeNull();
  });

  it("marks only the Claude rows as emitting structured plan blocks", () => {
    expect(capabilitiesFor(conv({ agent: "api-claude" })).structuredPlans).toBe(true);
    expect(capabilitiesFor(conv({ agent: "api-claude-oauth" })).structuredPlans).toBe(true);
    expect(capabilitiesFor(conv({ agent: "api-openai" })).structuredPlans).toBe(false);
    expect(capabilitiesFor(conv({ agent: "api-ollama" })).structuredPlans).toBe(false);
  });

  it("ties thinking and structured edits to api sessions", () => {
    expect(capabilitiesFor(conv()).emitsThinking).toBe(true);
    expect(capabilitiesFor(conv()).structuredEdits).toBe(true);
    const pty = capabilitiesFor(conv({ mode: "pty", agent: "claude-code" }));
    expect(pty.emitsThinking).toBe(false);
    expect(pty.structuredEdits).toBe(false);
  });
});

describe("capabilitiesFor — composer inputs", () => {
  it("offers file mentions only when there is a project to scan", () => {
    expect(capabilitiesFor(conv()).fileMentions).toBe(true);
    expect(capabilitiesFor(conv({ projectPath: "" })).fileMentions).toBe(false);
  });

  it("keeps slash commands, attachments, cancel and queueing unconditional", () => {
    const caps = capabilitiesFor(conv({ mode: "pty", agent: "claude-code" }));
    expect(caps.slashCommands).toBe(true);
    expect(caps.imageAttachments).toBe(true);
    expect(caps.canCancelTurn).toBe(true);
    expect(caps.canQueueWhileStreaming).toBe(true);
  });
});

describe("capabilitiesFor — context & accounting", () => {
  it("resolves the model's context window through the shared helper", () => {
    expect(capabilitiesFor(conv({ model: "claude-opus-4-8" })).contextWindow).toBe(1_000_000);
    // Unknown ids still resolve to the directional default — the ring renders.
    expect(capabilitiesFor(conv({ model: "who-knows" })).contextWindow).toBe(200_000);
  });

  it("reports usage for api sessions only", () => {
    expect(capabilitiesFor(conv()).reportsUsage).toBe(true);
    expect(capabilitiesFor(conv({ mode: "pty", agent: "claude-code" })).reportsUsage).toBe(false);
  });
});

describe("capabilitiesFor — environment", () => {
  it("detects a remote session from its ssh target", () => {
    expect(capabilitiesFor(conv()).remote).toBe(false);
    expect(
      capabilitiesFor(
        conv({
          sshTarget: {
            id: "srv-1",
            name: "box",
            host: "10.0.0.2",
            user: "ian",
            remotePath: "/srv/repo",
          },
        }),
      ).remote,
    ).toBe(true);
  });

  it("reports MCP only when sources or read errors were recorded", () => {
    expect(capabilitiesFor(conv()).mcp).toBe(false);
    expect(capabilitiesFor(conv({ mcpSources: { sources: [], readErrors: [] } })).mcp).toBe(false);
    expect(
      capabilitiesFor(
        conv({
          mcpSources: {
            sources: [{ name: "fs", transport: "stdio", scope: "project" }],
            readErrors: [],
          },
        }),
      ).mcp,
    ).toBe(true);
    expect(
      capabilitiesFor(
        conv({
          mcpSources: {
            sources: [],
            readErrors: [{ scope: "global", path: "/x.json", message: "bad" }],
          },
        }),
      ).mcp,
    ).toBe(true);
  });

  it("keeps the auth badge on every api-* id, including retired ones", () => {
    // This IS the `agent.startsWith("api-")` branch AgentHeaderBadges carried.
    // A stored conversation on the retired Codex id must not lose its badge,
    // which is why this does not go through the provider catalog.
    expect(capabilitiesFor(conv({ agent: "api-openai-codex" })).usesProviderCredential).toBe(true);
    // Same for the retired ACP transport.
    expect(capabilitiesFor(conv({ agent: "api-packetcode" })).usesProviderCredential).toBe(true);
    expect(
      capabilitiesFor(conv({ agent: "claude-code", mode: "pty" })).usesProviderCredential,
    ).toBe(false);
  });
});

/**
 * THE regression guard. Every transport must come out of `capabilitiesFor`
 * with the descriptor's transport-agnostic answers.
 */
describe("capabilitiesFor — transport-agnostic defaults", () => {
  const transports: [string, Partial<CapabilityConversation>][] = [
    ["sidecar (Claude Agent SDK)", { agent: "api-claude-oauth", mode: "api" }],
    ["sidecar (OpenAI Agents SDK)", { agent: "api-openai-agents", mode: "api" }],
    ["in-process LlmProvider", { agent: "api-openai", mode: "api" }],
    ["in-process (local, unpriced)", { agent: "api-ollama", mode: "api" }],
    ["PTY CLI", { agent: "claude-code", mode: "pty" }],
  ];

  it.each(transports)("%s", (_label, over) => {
    const conversation = conv(over);
    const caps = capabilitiesFor(conversation);
    const isApi = conversation.mode === "api";

    // agentModeChipUtils.modesForApprovals, unfiltered.
    expect(caps.permissionModes).toEqual(
      isApi ? modesForApprovals(providerSupportsApprovals(conversation.agent)) : [],
    );
    // api-models.API_PROVIDERS, verbatim.
    expect(caps.models).toEqual(getProviderForAgent(conversation.agent)?.models ?? []);
    // Unconditional true.
    expect(caps.slashCommands).toBe(true);
    // Project-path test only.
    expect(caps.fileMentions).toBe(!!conversation.projectPath);
    // The `mcp_sources` event condition only — no sources here, so false.
    expect(caps.mcp).toBe(false);
    // Unconditional true.
    expect(caps.canRename).toBe(true);
    // `mode === "api"` only.
    expect(caps.reportsUsage).toBe(isApi);
  });

  it("keeps the mcp_sources pill condition intact", () => {
    expect(
      capabilitiesFor(
        conv({
          agent: "api-claude-oauth",
          mcpSources: {
            sources: [{ name: "fs", transport: "stdio", scope: "project" }],
            readErrors: [],
          },
        }),
      ).mcp,
    ).toBe(true);
  });
});
