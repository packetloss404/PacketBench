/**
 * FAULT under test: `MultiTargetPicker` seeded every target's base branch with
 * a hard-coded "main". A repository whose trunk is `master`, `develop` or
 * `trunk` therefore had its attempt worktrees branched off a ref that may not
 * exist — and the row's branch box looked authoritative while saying something
 * untrue. The picker now probes the target's real checked-out branch (local
 * and remote alike) and only keeps "main" when detection cannot answer.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { useEffect, useState } from "react";

const getGitBranch = vi.hoisted(() => vi.fn());
const getGitBranchRemote = vi.hoisted(() => vi.fn());
vi.mock("@/components/flights/FlightAgentPicker", () => ({
  FlightAgentPicker: ({
    onReadinessChange,
  }: {
    onReadinessChange?: (error: string | null) => void;
  }) => {
    useEffect(() => onReadinessChange?.(null), [onReadinessChange]);
    return null;
  },
}));

vi.mock("@/lib/tauri", () => ({
  getGitBranch: (...args: unknown[]) => getGitBranch(...args),
  getGitBranchRemote: (...args: unknown[]) => getGitBranchRemote(...args),
  toGitServerConfigInput: (server: { id: string }) => ({ id: server.id }),
}));

import { MultiTargetPicker, type PickedTarget } from "@/components/flights/MultiTargetPicker";
import { detectBaseBranch } from "@/components/flights/detectBaseBranch";
import { useWorkspaceStore } from "@/stores/workspaceStore";
import { useServerStore } from "@/stores/serverStore";
import type { ServerConfig } from "@/types/server";

const SERVER: ServerConfig = {
  id: "srv_1",
  name: "build box",
  host: "build.example.com",
  port: 22,
  username: "ian",
  authMethod: "key",
  keyPath: "/home/ian/.ssh/id_ed25519",
  hostFingerprint: "SHA256:abc",
  remotePath: "/srv/repo",
  installedAgents: [],
};

function localTarget(): PickedTarget {
  return {
    kind: "local",
    key: "local:ws-1",
    workspaceId: "ws-1",
    label: "example",
    basePath: "D:/projects/example",
    baseBranch: "main",
    agent: "api-claude",
    model: "claude-opus-4-8",
  } as PickedTarget;
}

describe("detectBaseBranch", () => {
  beforeEach(() => vi.clearAllMocks());

  it("reads the real trunk of a local repository", async () => {
    getGitBranch.mockResolvedValue("develop\n");
    await expect(detectBaseBranch(localTarget())).resolves.toBe("develop");
    expect(getGitBranch).toHaveBeenCalledWith("D:/projects/example");
  });

  it("reads a remote target's branch on the host the worktree will be made on", async () => {
    getGitBranchRemote.mockResolvedValue("master");
    const target = {
      kind: "ssh",
      key: "ssh:srv_1",
      server: SERVER,
      label: "build box",
      basePath: "/srv/repo",
      baseBranch: "main",
      agent: "api-claude",
      model: "claude-opus-4-8",
    } as PickedTarget;

    await expect(detectBaseBranch(target)).resolves.toBe("master");
    expect(getGitBranchRemote).toHaveBeenCalledWith({ id: "srv_1" }, "/srv/repo");
    expect(getGitBranch).not.toHaveBeenCalled();
  });

  it("gives up (rather than guessing) on a non-git path or unreachable host", async () => {
    getGitBranch.mockRejectedValue(new Error("not a git repository"));
    await expect(detectBaseBranch(localTarget())).resolves.toBeNull();
  });

  it("rejects a detached HEAD, which is not a branch anyone can base off", async () => {
    getGitBranch.mockResolvedValue("HEAD");
    await expect(detectBaseBranch(localTarget())).resolves.toBeNull();
  });

  it("gives up on an empty base path instead of probing nothing", async () => {
    const target = { ...localTarget(), basePath: "" } as PickedTarget;
    await expect(detectBaseBranch(target)).resolves.toBeNull();
    expect(getGitBranch).not.toHaveBeenCalled();
  });
});

describe("MultiTargetPicker base-branch seeding", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useServerStore.setState({ servers: [] });
    useWorkspaceStore.setState({
      workspaces: [
        {
          id: "ws-1",
          name: "example",
          projectPath: "D:/projects/example",
          panes: [],
          agents: [],
          createdAt: 0,
          updatedAt: 0,
          status: "active",
        },
      ] as never,
    });
  });

  function pick(onChange: (next: PickedTarget[]) => void) {
    const { rerender } = render(<MultiTargetPicker picked={[]} onChange={onChange} />);
    fireEvent.click(screen.getByRole("button", { name: /example/ }));
    return rerender;
  }

  it("replaces the placeholder with the repository's actual branch", async () => {
    getGitBranch.mockResolvedValue("trunk");
    const calls: PickedTarget[][] = [];
    const rerender = pick((next) => calls.push(next));

    // The row appears immediately on the click, seeded with the placeholder —
    // an SSH probe can take seconds and must not block the paint.
    expect(calls[0]?.[0]?.baseBranch).toBe("main");

    rerender(<MultiTargetPicker picked={calls[0]} onChange={(next) => calls.push(next)} />);
    await waitFor(() => expect(calls.length).toBe(2));
    expect(calls[1]?.[0]?.baseBranch).toBe("trunk");
  });

  it("keeps 'main' when detection fails", async () => {
    getGitBranch.mockRejectedValue(new Error("not a git repository"));
    const calls: PickedTarget[][] = [];
    const rerender = pick((next) => calls.push(next));
    rerender(<MultiTargetPicker picked={calls[0]} onChange={(next) => calls.push(next)} />);

    await waitFor(() => expect(getGitBranch).toHaveBeenCalled());
    expect(calls).toHaveLength(1);
    expect(calls[0]?.[0]?.baseBranch).toBe("main");
  });

  it("never clobbers a branch the user typed while the probe was in flight", async () => {
    let resolveBranch: (value: string) => void = () => {};
    getGitBranch.mockReturnValue(
      new Promise<string>((resolve) => {
        resolveBranch = resolve;
      }),
    );

    const calls: PickedTarget[][] = [];
    const rerender = pick((next) => calls.push(next));

    // The user retypes the branch before the probe answers.
    const edited = [{ ...calls[0][0], baseBranch: "release/2026-08" }] as PickedTarget[];
    rerender(<MultiTargetPicker picked={edited} onChange={(next) => calls.push(next)} />);

    resolveBranch("trunk");
    await waitFor(() => expect(getGitBranch).toHaveBeenCalled());
    // Only the original add reached onChange — the late probe stood down.
    expect(calls).toHaveLength(1);
  });
});

describe("Flight repository readiness", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useWorkspaceStore.setState({ workspaces: [] });
    useServerStore.setState({ servers: [] });
  });

  function EditableTarget({ onValidation }: { onValidation: (errors: string[]) => void }) {
    const [picked, setPicked] = useState<PickedTarget[]>([localTarget()]);
    return (
      <MultiTargetPicker picked={picked} onChange={setPicked} onValidationChange={onValidation} />
    );
  }

  it("requires verification of an edited repository before marking the target ready", async () => {
    getGitBranch.mockResolvedValue("trunk");
    const validation = vi.fn();
    render(<EditableTarget onValidation={validation} />);
    await waitFor(() => expect(validation).toHaveBeenLastCalledWith([]));

    getGitBranch.mockRejectedValue(new Error("not a repository"));
    fireEvent.change(screen.getByRole("textbox", { name: "Repository path for example" }), {
      target: { value: "D:/not-a-repository" },
    });
    expect(validation.mock.lastCall?.[0]).not.toEqual([]);
    await waitFor(() => expect(screen.getByText(/Repository could not be verified/)).toBeTruthy());
    expect(getGitBranch).toHaveBeenLastCalledWith("D:/not-a-repository");
    expect(validation.mock.lastCall?.[0]).not.toEqual([]);
  });

  it("reverifies a changed SSH host even when its repository path is unchanged", async () => {
    getGitBranchRemote.mockResolvedValue("main");
    const validation = vi.fn();
    const target: PickedTarget = {
      ...localTarget(),
      kind: "ssh",
      key: "ssh:server",
      server: SERVER,
      basePath: "/srv/repo",
    };
    const props = { onChange: vi.fn(), onValidationChange: validation };
    const { rerender } = render(<MultiTargetPicker {...props} picked={[target]} />);
    await waitFor(() => expect(validation).toHaveBeenLastCalledWith([]));

    getGitBranchRemote.mockReturnValue(new Promise(() => {}));
    rerender(
      <MultiTargetPicker
        {...props}
        picked={[
          {
            ...target,
            server: { ...SERVER, host: "replacement.example.com", hostFingerprint: "SHA256:new" },
          },
        ]}
      />,
    );
    await waitFor(() => expect(validation.mock.lastCall?.[0]).not.toEqual([]));
    expect(screen.getByText("Checking repository…")).toBeTruthy();
  });
});
