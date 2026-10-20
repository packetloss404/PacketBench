import { describe, expect, it, vi } from "vitest";
import {
  buildReviewEvidenceBundle,
  buildReviewerInitialMessage,
  buildReviewerRemediationPrompt,
  buildReviewerSystemPrompt,
  parseLatestReviewGateReport,
  REVIEW_EVIDENCE_PATCH_LIMIT,
  REVIEW_GATE_FENCE,
  reviewerGateAllowsAcceptance,
} from "@/lib/reviewerGate";
import type { AgentMessage } from "@/types/agent-conversation";
import type { Attempt, Flight } from "@/types/flight";
import type { ServerConfig } from "@/types/server";

function flight(overrides: Partial<Flight> = {}): Flight {
  return {
    id: "flight-1",
    title: "Reviewer flight",
    objective: "Ship a safe change",
    status: "review",
    priority: "medium",
    projectPath: "/repo",
    workspaceId: null,
    milestones: [],
    linkedSessionIds: [],
    issueIds: [],
    createdAt: 1,
    updatedAt: 2,
    totalCost: 0,
    totalTokens: 0,
    reviewGatePolicy: {
      enabled: true,
      reviewerAgentConfigId: "api-openai-codex",
      reviewerModel: "gpt-5.5",
      acceptanceCriteria: ["Tests pass", "Reload is covered"],
    },
    ...overrides,
  };
}

function attempt(overrides: Partial<Attempt> = {}): Attempt {
  return {
    id: "attempt-1",
    flightId: "flight-1",
    target: {
      kind: "local",
      basePath: "/repo",
      worktreePath: "/repo/.pkt-worktrees/attempt-1",
    },
    agentConfigId: "api-claude",
    model: "claude-sonnet-4-6",
    provider: "claude",
    branch: "pkt/attempt-1",
    baseBranch: "main",
    sessionId: "session-1",
    status: "reviewing",
    cost: 0,
    tokens: 0,
    ...overrides,
  };
}

function assistant(content: string): AgentMessage {
  return { id: crypto.randomUUID(), role: "assistant", content, timestamp: 1 };
}

function reportBlock(verdict = "pass"): string {
  return `\`\`\`${REVIEW_GATE_FENCE}
{
  "schemaVersion": 1,
  "verdict": "${verdict}",
  "summary": "Evidence supports the decision.",
  "findings": [],
  "evidence": ["pnpm test passed"]
}
\`\`\``;
}

describe("Reviewer Gate", () => {
  it("parses the latest versioned report and rejects malformed or unnamed output", () => {
    const parsed = parseLatestReviewGateReport([
      assistant(reportBlock("blocked")),
      assistant(`Final review.\n${reportBlock("pass")}`),
    ]);
    expect(parsed.verdict).toBe("pass");
    expect(() =>
      parseLatestReviewGateReport([
        assistant(reportBlock("pass").replace('"schemaVersion": 1', '"schemaVersion": 2')),
      ]),
    ).toThrow("schemaVersion must be 1");
    expect(() => parseLatestReviewGateReport([assistant("Looks good.")])).toThrow(
      `No \`${REVIEW_GATE_FENCE}\``,
    );
  });

  it("builds a bounded local evidence packet without losing changed file identity", async () => {
    const loadGitEvidence = vi.fn().mockResolvedValue({
      baseRef: "main",
      headRef: "abc123",
      diffSummary: "2 files changed",
      changedPaths: ["src/a.ts", "src/b.ts"],
      patch: "x".repeat(REVIEW_EVIDENCE_PATCH_LIMIT + 100),
      patchTruncated: true,
    });
    const bundle = await buildReviewEvidenceBundle(flight(), attempt(), {
      lookupServer: () => undefined,
      loadGitEvidence,
    });
    expect(loadGitEvidence).toHaveBeenCalledWith(
      "/repo/.pkt-worktrees/attempt-1",
      "main",
      null,
      REVIEW_EVIDENCE_PATCH_LIMIT,
    );
    expect(bundle.changedPaths).toEqual(["src/a.ts", "src/b.ts"]);
    expect(bundle.patch.length).toBeLessThanOrEqual(REVIEW_EVIDENCE_PATCH_LIMIT + 20);
    expect(bundle.patchTruncated).toBe(true);
  });

  it("uses the captured immutable base and refuses a moving reviewed HEAD", async () => {
    const loadGitEvidence = vi.fn().mockResolvedValue({
      baseRef: "pinned",
      headRef: "head",
      diffSummary: "",
      changedPaths: [],
      patch: "",
      patchTruncated: false,
    });
    const snapshot = {
      fingerprint: "full-tree",
      contextFingerprint: "criteria",
      contextJson: JSON.stringify({
        objective: "Captured objective",
        prompt: "Captured prompt",
        criteria: ["Captured criterion"],
        task: null,
        branch: "pkt/attempt-1",
        target: { kind: "local", worktree_path: "/repo/.pkt-worktrees/attempt-1" },
      }),
      baseSha: "pinned",
      headSha: "head",
    };
    const bundle = await buildReviewEvidenceBundle(
      flight({ objective: "Frontend changed while capture awaited" }),
      attempt(),
      {
        lookupServer: () => undefined,
        loadGitEvidence,
        snapshot,
      },
    );
    expect(loadGitEvidence.mock.calls[0][1]).toBe("pinned");
    expect(loadGitEvidence.mock.calls[0][4]).toBe("head");
    expect(bundle.objective).toBe("Captured objective");
    expect(bundle.acceptanceCriteria).toEqual(["Captured criterion"]);
    loadGitEvidence.mockResolvedValueOnce({
      baseRef: "pinned",
      headRef: "later",
      diffSummary: "",
      changedPaths: [],
      patch: "",
      patchTruncated: false,
    });
    await expect(
      buildReviewEvidenceBundle(flight(), attempt(), {
        lookupServer: () => undefined,
        loadGitEvidence,
        snapshot,
      }),
    ).rejects.toThrow("changed");
  });

  it("rejects oversized required context instead of silently dropping criteria", async () => {
    const loadGitEvidence = vi.fn();
    const oversized = flight();
    oversized.reviewGatePolicy!.acceptanceCriteria = Array.from(
      { length: 41 },
      (_, index) => `criterion ${index}`,
    );
    await expect(
      buildReviewEvidenceBundle(oversized, attempt(), {
        lookupServer: () => undefined,
        loadGitEvidence,
      }),
    ).rejects.toThrow("cannot be omitted");
    await expect(
      buildReviewEvidenceBundle(flight({ objective: "x".repeat(8_001) }), attempt(), {
        lookupServer: () => undefined,
        loadGitEvidence,
      }),
    ).rejects.toThrow("evidence limit");
    expect(loadGitEvidence).not.toHaveBeenCalled();
  });

  it("uses the pinned SSH server for remote evidence and fails closed when it is missing", async () => {
    const server: ServerConfig = {
      id: "server-1",
      name: "Build host",
      host: "example.test",
      port: 22,
      username: "ian",
      authMethod: "key",
      installedAgents: [],
      hostFingerprint: "SHA256:test",
    };
    const remoteAttempt = attempt({
      target: {
        kind: "ssh",
        serverId: server.id,
        basePath: "/srv/repo",
        worktreePath: "/srv/repo/.pkt-worktrees/attempt-1",
      },
    });
    const loadGitEvidence = vi.fn().mockResolvedValue({
      baseRef: "main",
      headRef: "abc123",
      diffSummary: "",
      changedPaths: [],
      patch: "",
      patchTruncated: false,
    });
    await buildReviewEvidenceBundle(flight(), remoteAttempt, {
      lookupServer: () => server,
      loadGitEvidence,
    });
    expect(loadGitEvidence.mock.calls[0][2]).toEqual(
      expect.objectContaining({ id: "server-1", hostFingerprint: "SHA256:test" }),
    );
    await expect(
      buildReviewEvidenceBundle(flight(), remoteAttempt, {
        lookupServer: () => undefined,
        loadGitEvidence,
      }),
    ).rejects.toThrow("no longer configured");
  });

  it("requires a pass or recorded override before normal acceptance", () => {
    const base = flight();
    expect(reviewerGateAllowsAcceptance(base, attempt()).allowed).toBe(false);
    expect(
      reviewerGateAllowsAcceptance(base, attempt({ reviewGate: { status: "changes_requested" } }))
        .allowed,
    ).toBe(false);
    expect(
      reviewerGateAllowsAcceptance(base, attempt({ reviewGate: { status: "passed" } })).allowed,
    ).toBe(false);
    expect(
      reviewerGateAllowsAcceptance(
        base,
        attempt({
          reviewGate: {
            status: "passed",
            evidence: {
              fingerprint: "snapshot",
              contextFingerprint: "criteria",
              baseSha: "base",
              headSha: "head",
            },
          },
        }),
      ).allowed,
    ).toBe(true);
    expect(
      reviewerGateAllowsAcceptance(
        base,
        attempt({
          reviewGate: {
            status: "overridden",
            overriddenAt: 5,
            overrideReason: "Accepted risk",
          },
        }),
      ).allowed,
    ).toBe(true);
    expect(
      reviewerGateAllowsAcceptance(flight({ reviewGatePolicy: undefined }), attempt()).allowed,
    ).toBe(true);
  });

  it("keeps review and remediation read-only and explicitly bounded", () => {
    const system = buildReviewerSystemPrompt();
    expect(system).toContain("read-only");
    expect(system).toContain("Do not edit files, run commands");
    expect(system).toContain(REVIEW_GATE_FENCE);
    const initial = buildReviewerInitialMessage({
      schemaVersion: 1,
      flightId: "flight-1",
      attemptId: "attempt-1",
      objective: "Objective",
      prompt: "Prompt",
      acceptanceCriteria: ["Tests pass"],
      baseRef: "main",
      headRef: "abc",
      branch: "pkt/a",
      target: "local",
      diffSummary: "",
      changedPaths: [],
      patch: "",
      patchTruncated: false,
      checks: [],
    });
    expect(initial).toContain('"acceptanceCriteria"');
    const remediation = buildReviewerRemediationPrompt({
      schemaVersion: 1,
      verdict: "changes_requested",
      summary: "Add coverage.",
      findings: [
        {
          severity: "error",
          title: "Missing test",
          details: "Cover reload.",
        },
      ],
      evidence: [],
    });
    expect(remediation).toContain("one user-triggered remediation turn");
    expect(remediation).toContain("will not automatically repeat");
  });
});
