import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  gitGetOriginUrl: vi.fn(),
  gitHostListConnections: vi.fn(),
  gitPushBranch: vi.fn(),
  githubCreatePr: vi.fn(),
}));

vi.mock("@/lib/tauri", () => ({
  gitGetOriginUrl: mocks.gitGetOriginUrl,
  gitHostListConnections: mocks.gitHostListConnections,
  gitPushBranch: mocks.gitPushBranch,
  githubCreatePr: mocks.githubCreatePr,
}));

import { publishBranchAsPr, resolveWorktreePrTarget } from "@/lib/gitPublish";

const baseInput = {
  worktreePath: "/repo/.pkt-worktrees/conv-1",
  branch: "pkt/conv-1",
  baseBranch: "main",
  owner: "acme",
  repo: "widget",
  title: "Land conv-1",
  body: "body",
};

describe("gitPublish.publishBranchAsPr", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.gitPushBranch.mockResolvedValue(undefined);
    mocks.githubCreatePr.mockResolvedValue(JSON.stringify({ number: 42 }));
  });

  it("pushes the branch then opens a draft PR and records the PR number", async () => {
    const result = await publishBranchAsPr(baseInput);

    expect(mocks.gitPushBranch).toHaveBeenCalledWith(
      "/repo/.pkt-worktrees/conv-1",
      "pkt/conv-1",
      false,
    );
    // draft defaults to true.
    expect(mocks.githubCreatePr).toHaveBeenCalledWith(
      "acme",
      "widget",
      "Land conv-1",
      "body",
      "pkt/conv-1",
      "main",
      true,
    );
    expect(result).toEqual({ ok: true, prNumber: 42 });
  });

  it("GP5: uses remotePush instead of the local push when provided (SSH attempts)", async () => {
    const remotePush = vi.fn().mockResolvedValue(undefined);
    const result = await publishBranchAsPr({ ...baseInput, remotePush });

    expect(remotePush).toHaveBeenCalledOnce();
    expect(mocks.gitPushBranch).not.toHaveBeenCalled();
    // The PR is still opened via the GitHub API once the remote push lands.
    expect(mocks.githubCreatePr).toHaveBeenCalled();
    expect(result).toEqual({ ok: true, prNumber: 42 });
  });

  it("GP5: a failed remotePush surfaces as a push-stage error", async () => {
    const remotePush = vi.fn().mockRejectedValue(new Error("ssh push denied"));
    const result = await publishBranchAsPr({ ...baseInput, remotePush });
    expect(result).toEqual({ ok: false, stage: "push", message: "ssh push denied" });
    expect(mocks.githubCreatePr).not.toHaveBeenCalled();
  });

  it("passes draft:false through to githubCreatePr", async () => {
    await publishBranchAsPr({ ...baseInput, draft: false });
    expect(mocks.githubCreatePr).toHaveBeenCalledWith(
      "acme",
      "widget",
      "Land conv-1",
      "body",
      "pkt/conv-1",
      "main",
      false,
    );
  });

  it("does not open a PR when the push fails, classified as stage 'push'", async () => {
    mocks.gitPushBranch.mockRejectedValue("remote rejected");
    const result = await publishBranchAsPr(baseInput);
    expect(result).toEqual({ ok: false, stage: "push", message: "remote rejected" });
    expect(mocks.githubCreatePr).not.toHaveBeenCalled();
  });

  it("classifies a create_pr failure as stage 'create_pr'", async () => {
    mocks.githubCreatePr.mockRejectedValue(new Error("422 Unprocessable"));
    const result = await publishBranchAsPr(baseInput);
    expect(result).toEqual({ ok: false, stage: "create_pr", message: "422 Unprocessable" });
  });

  it("returns prNumber null when GitHub succeeds without a number", async () => {
    mocks.githubCreatePr.mockResolvedValue(JSON.stringify({ html_url: "x" }));
    const result = await publishBranchAsPr(baseInput);
    expect(result).toEqual({ ok: true, prNumber: null });
  });

  it.each([
    { number: 42, html_url: "https://github.com/acme/widget/pull/42" },
    { number: 42, web_url: "https://forge.example/acme/widget/-/merge_requests/42" },
  ])("records the Git host's actual PR URL", async (response) => {
    mocks.githubCreatePr.mockResolvedValue(JSON.stringify(response));
    const result = await publishBranchAsPr(baseInput);
    expect(result).toEqual({
      ok: true,
      prNumber: 42,
      prUrl: response.html_url || response.web_url,
    });
  });

  it("ignores an unsafe optional link without turning a created PR into a failure", async () => {
    mocks.githubCreatePr.mockResolvedValue(
      JSON.stringify({ number: 42, html_url: "javascript:alert(1)" }),
    );
    expect(await publishBranchAsPr(baseInput)).toEqual({ ok: true, prNumber: 42 });
  });
});

describe("worktree PR authority", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.gitHostListConnections.mockResolvedValue([
      { id: "cloud", kind: "github", baseUrl: "https://api.github.com" },
    ]);
  });
  it.each([
    "git@github.com:actual/project.git",
    "https://github.com/actual/project.git",
    "ssh://git@github.com/actual/project.git",
  ])("resolves %s without global repo selection", async (origin) => {
    mocks.gitGetOriginUrl.mockResolvedValue(origin);
    const target = await resolveWorktreePrTarget(baseInput.worktreePath);
    expect(target).toEqual({ owner: "actual", repo: "project", connectionId: "cloud" });
    await publishBranchAsPr({ ...baseInput, ...target });
    expect(mocks.githubCreatePr).toHaveBeenCalledWith(
      "actual",
      "project",
      "Land conv-1",
      "body",
      "pkt/conv-1",
      "main",
      true,
      "cloud",
    );
  });
  it.each([
    "https://unknown.example/actual/project.git",
    "/local/repository",
    "https://github.com/owner/project/extra",
  ])("rejects unsupported authority %s before publication", async (origin) => {
    mocks.gitGetOriginUrl.mockResolvedValue(origin);
    await expect(resolveWorktreePrTarget(baseInput.worktreePath)).rejects.toThrow();
    expect(mocks.gitPushBranch).not.toHaveBeenCalled();
    expect(mocks.githubCreatePr).not.toHaveBeenCalled();
  });
  it("refuses ambiguous matching hosts", async () => {
    mocks.gitGetOriginUrl.mockResolvedValue("git@forge.example:owner/repo.git");
    mocks.gitHostListConnections.mockResolvedValue([
      { id: "one", kind: "gitea", baseUrl: "https://forge.example" },
      { id: "two", kind: "gitea", baseUrl: "https://forge.example" },
    ]);
    await expect(resolveWorktreePrTarget(baseInput.worktreePath)).rejects.toThrow(/exactly one/);
  });

  it("reads the configured SSH worktree origin without inspecting the same path locally", async () => {
    mocks.gitGetOriginUrl.mockResolvedValue("https://github.com/wrong/local-repo.git");
    const readOrigin = vi.fn().mockResolvedValue("ssh://git@forge.example:2222/team/actual.git\n");
    mocks.gitHostListConnections.mockResolvedValue([
      { id: "cloud", kind: "github", baseUrl: "https://api.github.com" },
      { id: "forge", kind: "gitea", baseUrl: "https://forge.example" },
    ]);
    expect(await resolveWorktreePrTarget("/srv/repo", { readOrigin })).toEqual({
      owner: "team",
      repo: "actual",
      connectionId: "forge",
    });
    expect(readOrigin).toHaveBeenCalledOnce();
    expect(mocks.gitGetOriginUrl).not.toHaveBeenCalled();
  });

  it("does not fall back to local origin after SSH lookup failure", async () => {
    mocks.gitGetOriginUrl.mockResolvedValue("https://github.com/wrong/local-repo.git");
    const readOrigin = vi.fn().mockRejectedValue(new Error("SSH host unavailable"));
    await expect(resolveWorktreePrTarget("/srv/repo", { readOrigin })).rejects.toThrow(
      "SSH host unavailable",
    );
    expect(mocks.gitGetOriginUrl).not.toHaveBeenCalled();
    expect(mocks.gitPushBranch).not.toHaveBeenCalled();
    expect(mocks.githubCreatePr).not.toHaveBeenCalled();
  });

  it("preserves nested GitLab namespaces when resolving the actual destination", async () => {
    mocks.gitGetOriginUrl.mockResolvedValue("https://gitlab.example/team/platform/project.git");
    mocks.gitHostListConnections.mockResolvedValue([
      { id: "lab", kind: "gitlab", baseUrl: "https://gitlab.example" },
    ]);
    expect(await resolveWorktreePrTarget(baseInput.worktreePath)).toEqual({
      owner: "team/platform",
      repo: "project",
      connectionId: "lab",
    });
  });
});
