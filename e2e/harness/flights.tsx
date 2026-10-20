import { createRoot } from "react-dom/client";
import { FlightsView } from "@/components/views/FlightsView";
import { LaunchAsyncFlightModal } from "@/components/flights/LaunchAsyncFlightModal";
import { ToastProvider } from "@/components/ui/Toast";
import { useFlightStore } from "@/stores/flightStore";
import { useAgentTaskStore } from "@/stores/agentTaskStore";
import { useAppStore } from "@/stores/appStore";
import type { Attempt, Flight } from "@/types/flight";
import "@/index.css";

// A deterministic browser-only fixture. No provider or native command runs.
const bridge = (
  window as unknown as {
    __TAURI_INTERNALS__: { invoke: (command: string, args?: unknown) => Promise<unknown> };
  }
).__TAURI_INTERNALS__;
const original = bridge.invoke.bind(bridge);
bridge.invoke = async (command, args) =>
  command === "get_git_review_evidence"
    ? {
        baseRef: "1111111111111111111111111111111111111111",
        headRef: "2222222222222222222222222222222222222222",
        changedPaths: ["src/example.ts"],
        diffSummary: "1 file changed",
        patch:
          "diff --git a/src/example.ts b/src/example.ts\n--- a/src/example.ts\n+++ b/src/example.ts\n@@ -1 +1 @@\n-return false;\n+return true;",
        patchTruncated: false,
      }
    : original(command, args);

const state = new URLSearchParams(location.search).get("state") || "review";
const attempt: Attempt = {
  id: "acceptance-attempt",
  flightId: "acceptance-flight",
  target: {
    kind: "local",
    basePath: "/acceptance/project",
    worktreePath: "/acceptance/project/.worktrees/acceptance-attempt",
  },
  agentConfigId: "api-sugar",
  provider: "sugar",
  model: "sugar/conduit",
  branch: "pkt/acceptance-attempt",
  baseBranch: "main",
  sessionId: "acceptance-builder",
  status: state === "review" ? "reviewing" : state === "retained" ? "cancelled" : "completed",
  cost: 0.05,
  tokens: 1200,
  reviewGate: {
    status: "passed",
    reviewerConversationId: "acceptance-reviewer",
    evidence: {
      fingerprint: "fixture-review-fingerprint",
      contextFingerprint: "fixture-context",
      baseSha: "1111111111111111111111111111111111111111",
      headSha: "2222222222222222222222222222222222222222",
    },
    report: {
      schemaVersion: 1,
      verdict: "pass",
      summary: "The changed condition matches the requested behavior.",
      findings: [],
      evidence: ["Inspected src/example.ts and the recorded regression output."],
    },
  },
  ...(state === "delivered"
    ? {
        delivery: {
          kind: "landed" as const,
          deliveredAt: 10,
          branch: "pkt/acceptance-attempt",
          baseBranch: "main",
          commitSha: "3333333333333333333333333333333333333333",
        },
      }
    : {}),
  ...(state === "retained"
    ? {
        recovery: {
          state: "retained" as const,
          retainedAt: 8,
          reason: "Desktop stopped while work was active.",
        },
      }
    : {}),
};
const flight: Flight = {
  id: attempt.flightId,
  title: "Correct the example condition",
  objective: "Return true for the supported case and preserve existing behavior elsewhere.",
  projectPath: "/acceptance/project",
  workspaceId: null,
  status: "review",
  priority: "medium",
  milestones: [],
  linkedSessionIds: [attempt.sessionId],
  issueIds: [],
  createdAt: 1,
  updatedAt: 8,
  totalCost: 0.06,
  totalTokens: 1400,
  attempts: [attempt],
  reviewGatePolicy: {
    enabled: true,
    reviewerAgentConfigId: "api-openai-agents",
    acceptanceCriteria: ["Regression check passes", "Only the supported case changes"],
  },
};
useFlightStore.setState({ flights: [flight], activeFlightId: flight.id });
useAgentTaskStore.setState({
  conversations: [
    {
      id: attempt.sessionId,
      title: "Example implementation",
      agent: "api-sugar",
      projectPath: attempt.target.worktreePath,
      status: "idle",
      sessionId: "fixture-session",
      rawOutput: "",
      mode: "api",
      createdAt: 1,
      updatedAt: 8,
      messages: [
        {
          id: "result",
          role: "assistant",
          content: "Updated the supported case and ran the regression check.",
          timestamp: 8,
          toolCalls: [
            {
              id: "check",
              name: "bash",
              input: "pnpm test example",
              status: "done",
              summary: "1 regression check passed",
            },
          ],
        },
      ],
    },
  ],
});
useAppStore.setState({ activeView: "flights", initialized: true });

export function Surface() {
  const context = useAppStore((store) => store.flightLaunchContext);
  return (
    <ToastProvider>
      <div style={{ display: "flex", height: "100vh", minWidth: 0 }}>
        <FlightsView />
      </div>
      {context && (
        <LaunchAsyncFlightModal
          initialContext={context}
          onClose={() => useAppStore.getState().closeFlightBrief()}
        />
      )}
    </ToastProvider>
  );
}
createRoot(document.getElementById("root")!).render(<Surface />);
