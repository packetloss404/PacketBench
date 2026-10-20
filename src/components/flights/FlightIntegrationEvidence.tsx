import { FlightAttemptEvidence } from "./FlightAttemptEvidence";
import { integrationBasePath } from "@/stores/asyncFlightStore";
import type { Flight } from "@/types/flight";

/** A combined diff is evidence to inspect, not a claim that combined checks ran. */
export function FlightIntegrationEvidence({ flight }: { flight: Flight }) {
  const integration = flight.integrationBranch;
  if (!integration || !integration.headSha || !integration.baseSha) return null;
  const basePath = integrationBasePath(flight) ?? flight.projectPath;
  if (integration.targetKind === "ssh" && !integration.targetId) {
    return (
      <p role="alert" className="text-xs text-accent-amber">
        Restore the integration branch's saved SSH target before inspecting the combined changes.
      </p>
    );
  }
  return (
    <FlightAttemptEvidence
      heading="Combined Flight changes"
      description="This is the combined integration tree. Task reviews cover individual results; independently verify this combined tree before final landing."
      range={{ baseSha: integration.baseSha, headSha: integration.headSha }}
      showChecks={false}
      attempt={{
        id: `${flight.id}-integration`,
        status: "reviewing",
        branch: integration.branch,
        baseBranch: integration.baseBranch,
        target:
          integration.targetKind === "ssh"
            ? {
                kind: "ssh",
                serverId: integration.targetId!,
                basePath,
                worktreePath: integration.worktreePath,
              }
            : { kind: "local", basePath, worktreePath: integration.worktreePath },
      }}
    />
  );
}
