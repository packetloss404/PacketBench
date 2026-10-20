import { APP_NAME, APP_NAME_LOWER } from "@/lib/brand";
import { getGitReviewEvidence, toGitServerConfigInput, type GitReviewEvidence } from "@/lib/tauri";
import type { AgentConversation, AgentMessage } from "@/types/agent-conversation";
import type {
  Attempt,
  Flight,
  ReviewGateFinding,
  ReviewGateFindingSeverity,
  ReviewGateReport,
  ReviewGateEvidence,
  ReviewGateVerdict,
} from "@/types/flight";
import type { ServerConfig } from "@/types/server";

export const REVIEW_GATE_FENCE = `${APP_NAME_LOWER}-review-gate`;
export const REVIEWER_ALLOWED_TOOLS = ["read_file", "list_directory", "grep"];
export const REVIEW_EVIDENCE_PATCH_LIMIT = 65_536;

const VERDICTS = new Set<ReviewGateVerdict>(["pass", "changes_requested", "blocked"]);
const SEVERITIES = new Set<ReviewGateFindingSeverity>(["info", "warning", "error"]);

export interface ReviewCheckEvidence {
  tool: string;
  status: "done" | "error";
  command?: string;
  summary?: string;
}

export interface ReviewEvidenceBundle {
  schemaVersion: 1;
  flightId: string;
  attemptId: string;
  objective: string;
  prompt: string;
  acceptanceCriteria: string[];
  baseRef: string;
  headRef: string;
  branch: string;
  target: "local" | "ssh";
  diffSummary: string;
  changedPaths: string[];
  patch: string;
  patchTruncated: boolean;
  checks: ReviewCheckEvidence[];
  task?: {
    id: string;
    title: string;
    description: string;
    ownedPaths?: string[];
    dependsOn: string[];
  };
}

export interface BuildReviewEvidenceOptions {
  snapshot?: ReviewGateEvidence;
  builderConversation?: AgentConversation;
  lookupServer: (id: string) => ServerConfig | undefined;
  loadGitEvidence?: typeof getGitReviewEvidence;
}

function boundedText(value: string, max: number): string {
  if (value.length <= max) return value;
  const suffix = "\n…[truncated]";
  return `${value.slice(0, Math.max(0, max - suffix.length))}${suffix}`;
}

function isCheckLike(toolName: string, input: string): boolean {
  const value = `${toolName} ${input}`.toLowerCase();
  return /\b(test|lint|check|build|verify|cargo|vitest|pytest|go test)\b/.test(value);
}

/** Extract only completed deterministic-looking tool results from the builder
 * transcript. This is supporting evidence, never a substitute for a verdict. */
export function extractReviewChecks(
  conversation: AgentConversation | undefined,
): ReviewCheckEvidence[] {
  if (!conversation) return [];
  const checks: ReviewCheckEvidence[] = [];
  for (const message of conversation.messages) {
    for (const call of message.toolCalls ?? []) {
      if (call.status === "running") continue;
      const input = call.input ?? "";
      if (!isCheckLike(call.name, input)) continue;
      checks.push({
        tool: boundedText(call.name, 120),
        status: call.status,
        command: input ? boundedText(input, 1_000) : undefined,
        summary: call.summary ? boundedText(call.summary, 2_000) : undefined,
      });
      if (checks.length >= 40) return checks;
    }
  }
  return checks;
}

export async function buildReviewEvidenceBundle(
  flight: Flight,
  attempt: Attempt,
  options: BuildReviewEvidenceOptions,
): Promise<ReviewEvidenceBundle> {
  const task = flight.milestones
    ?.flatMap((milestone) => milestone.tasks)
    .find((task) => task.id === attempt.taskId);
  const milestone = task
    ? flight.milestones.find((milestone) => milestone.id === task.milestoneId)
    : undefined;
  const frozen = options.snapshot
    ? (JSON.parse(options.snapshot.contextJson || "null") as {
        objective: string;
        prompt: string | null;
        criteria: string[] | null;
        branch: string;
        target: { kind: "local" | "ssh"; worktree_path: string; server_id?: string };
        task: {
          id: string;
          title: string;
          description: string;
          ownedPaths?: string[];
          dependsOn: string[];
          validationCriteria: string[];
        } | null;
      } | null)
    : null;
  if (options.snapshot && !frozen)
    throw new Error("The review snapshot has no frozen criteria. Retry the reviewer.");
  const objective = frozen?.objective ?? flight.objective;
  const prompt = frozen ? (frozen.prompt ?? frozen.objective) : (flight.prompt ?? flight.objective);
  const criteria = frozen
    ? [...(frozen.criteria ?? []), ...(frozen.task?.validationCriteria ?? [])]
    : [
        ...(flight.reviewGatePolicy?.acceptanceCriteria ?? []),
        ...(milestone?.validationCriteria ?? []),
      ];
  if (
    objective.length > 8_000 ||
    prompt.length > 12_000 ||
    criteria.length > 40 ||
    criteria.some((criterion) => criterion.length > 1_000)
  ) {
    throw new Error(
      "The review objective, prompt, or acceptance criteria exceed the evidence limit. Shorten them or split this Flight before reviewing; required criteria cannot be omitted.",
    );
  }
  const taskEvidence = frozen
    ? (frozen.task ?? undefined)
    : task
      ? {
          id: task.id,
          title: task.title,
          description: task.description,
          ownedPaths: task.ownedPaths,
          dependsOn: task.dependsOn,
        }
      : undefined;
  if (taskEvidence && JSON.stringify(taskEvidence).length > 20_000)
    throw new Error(
      "The review task context exceeds the evidence limit. Split this task before reviewing.",
    );
  const targetKind = frozen?.target.kind ?? attempt.target.kind;
  const serverId =
    frozen?.target.server_id ?? (attempt.target.kind === "ssh" ? attempt.target.serverId : "");
  const server = targetKind === "ssh" ? options.lookupServer(serverId ?? "") : undefined;
  if (targetKind === "ssh" && !server) {
    throw new Error("The SSH server used by this attempt is no longer configured.");
  }
  const loader = options.loadGitEvidence ?? getGitReviewEvidence;
  const git: GitReviewEvidence = options.snapshot
    ? await loader(
        frozen!.target.worktree_path,
        options.snapshot.baseSha,
        server ? toGitServerConfigInput(server) : null,
        REVIEW_EVIDENCE_PATCH_LIMIT,
        options.snapshot.headSha,
      )
    : await loader(
        attempt.target.worktreePath,
        attempt.baseBranch,
        server ? toGitServerConfigInput(server) : null,
        REVIEW_EVIDENCE_PATCH_LIMIT,
      );
  if (options.snapshot && git.headRef !== options.snapshot.headSha) {
    throw new Error("The attempt changed while collecting review evidence. Retry review.");
  }
  return {
    schemaVersion: 1,
    flightId: flight.id,
    attemptId: attempt.id,
    objective,
    prompt,
    acceptanceCriteria: criteria,
    baseRef: git.baseRef,
    headRef: git.headRef,
    branch: boundedText(frozen?.branch ?? attempt.branch, 512),
    target: targetKind,
    diffSummary: boundedText(git.diffSummary, 16_000),
    changedPaths: git.changedPaths.slice(0, 2_000).map((path) => boundedText(path, 2_000)),
    patch: boundedText(git.patch, REVIEW_EVIDENCE_PATCH_LIMIT),
    patchTruncated: git.patchTruncated,
    checks: extractReviewChecks(options.builderConversation),
    task: taskEvidence,
  };
}

function nonEmptyString(value: unknown, label: string, max: number): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${label} must be a non-empty string.`);
  }
  if (value.length > max) throw new Error(`${label} exceeds ${max} characters.`);
  return value.trim();
}

function optionalString(value: unknown, label: string, max: number): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  return nonEmptyString(value, label, max);
}

function validateFinding(value: unknown, index: number): ReviewGateFinding {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Finding ${index + 1} must be an object.`);
  }
  const raw = value as Record<string, unknown>;
  const severity = raw.severity as ReviewGateFindingSeverity;
  if (!SEVERITIES.has(severity)) {
    throw new Error(`Finding ${index + 1} has an unsupported severity.`);
  }
  let line: number | undefined;
  if (raw.line !== undefined && raw.line !== null) {
    if (!Number.isInteger(raw.line) || (raw.line as number) < 1) {
      throw new Error(`Finding ${index + 1} line must be a positive integer.`);
    }
    line = raw.line as number;
  }
  return {
    severity,
    title: nonEmptyString(raw.title, `Finding ${index + 1} title`, 300),
    details: nonEmptyString(raw.details, `Finding ${index + 1} details`, 8_000),
    filePath: optionalString(raw.filePath, `Finding ${index + 1} filePath`, 2_000),
    line,
  };
}

export function validateReviewGateReport(value: unknown): ReviewGateReport {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("The review report must be a JSON object.");
  }
  const raw = value as Record<string, unknown>;
  if (raw.schemaVersion !== 1) {
    throw new Error("The review report schemaVersion must be 1.");
  }
  const verdict = raw.verdict as ReviewGateVerdict;
  if (!VERDICTS.has(verdict)) throw new Error("The review report verdict is unsupported.");
  if (!Array.isArray(raw.findings) || raw.findings.length > 100) {
    throw new Error("The review report findings must be an array of at most 100 items.");
  }
  if (!Array.isArray(raw.evidence) || raw.evidence.length > 100) {
    throw new Error("The review report evidence must be an array of at most 100 strings.");
  }
  if (raw.evidence.some((entry) => typeof entry !== "string")) {
    throw new Error("Every review evidence entry must be a string.");
  }
  return {
    schemaVersion: 1,
    verdict,
    summary: nonEmptyString(raw.summary, "Review summary", 12_000),
    findings: raw.findings.map(validateFinding),
    evidence: raw.evidence.map((entry) => boundedText((entry as string).trim(), 4_000)),
  };
}

function reportCandidates(content: string): string[] {
  const pattern = new RegExp(`\`\`\`${REVIEW_GATE_FENCE}\\s*([\\s\\S]*?)\`\`\``, "gi");
  return [...content.matchAll(pattern)].map((match) => match[1].trim());
}

export function parseLatestReviewGateReport(messages: AgentMessage[]): ReviewGateReport {
  let lastError: Error | null = null;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role !== "assistant" || !message.content.trim()) continue;
    for (const candidate of reportCandidates(message.content)) {
      try {
        return validateReviewGateReport(JSON.parse(candidate));
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
      }
    }
  }
  if (lastError) throw new Error(`The reviewer report is invalid: ${lastError.message}`);
  throw new Error(`No \`${REVIEW_GATE_FENCE}\` JSON block was found in the reviewer response.`);
}

export function buildReviewerSystemPrompt(): string {
  return `You are an independent, read-only reviewer in ${APP_NAME}. Evaluate only the supplied objective, acceptance criteria, git evidence, and repository files available through read-only tools. Do not edit files, run commands, request write permission, or assume missing evidence passed.

End the response with exactly one fenced \`\`\`${REVIEW_GATE_FENCE} JSON block:
{
  "schemaVersion": 1,
  "verdict": "pass|changes_requested|blocked",
  "summary": "concise decision",
  "findings": [{
    "severity": "info|warning|error",
    "title": "finding title",
    "details": "specific evidence and required change",
    "filePath": "optional/path",
    "line": 1
  }],
  "evidence": ["check, diff, or repository fact used"]
}
\`\`\`

Use "pass" only when the evidence supports every acceptance criterion. Use "changes_requested" for fixable product/code/test gaps. Use "blocked" when required evidence or repository state is unavailable.`;
}

export function buildReviewerInitialMessage(bundle: ReviewEvidenceBundle): string {
  return `Review this completed Flight attempt against the stated criteria. The evidence packet is bounded; when patchTruncated is true, inspect named files with read-only tools before deciding.

\`\`\`json
${JSON.stringify(bundle, null, 2)}
\`\`\``;
}

export function buildReviewerRemediationPrompt(report: ReviewGateReport): string {
  const findings = report.findings.map((finding, index) => {
    const location = finding.filePath
      ? ` (${finding.filePath}${finding.line ? `:${finding.line}` : ""})`
      : "";
    return `${index + 1}. [${finding.severity}] ${finding.title}${location}\n${finding.details}`;
  });
  return `The independent Reviewer Gate requested changes.

Verdict: ${report.verdict}
Summary: ${report.summary}

Findings:
${findings.length > 0 ? findings.join("\n\n") : "No structured findings were supplied; address the summary and report back."}

This is one user-triggered remediation turn. Make the requested changes, run appropriate checks, and summarize what changed. ${APP_NAME} will not automatically repeat this cycle.`;
}

export function reviewerGateAllowsAcceptance(
  flight: Flight,
  attempt: Attempt,
): {
  allowed: boolean;
  reason?: string;
} {
  if (!flight.reviewGatePolicy?.enabled) return { allowed: true };
  const status = attempt.reviewGate?.status;
  if (
    status === "overridden" &&
    attempt.reviewGate?.overrideReason?.trim() &&
    attempt.reviewGate.overriddenAt
  )
    return { allowed: true };
  if (status === "passed" && attempt.reviewGate?.evidence) return { allowed: true };
  return {
    allowed: false,
    reason:
      status === "passed"
        ? "This review has no code fingerprint. Run the reviewer again before acceptance."
        : status === "running" || status === "pending"
          ? "The independent reviewer has not finished."
          : "The Reviewer Gate must pass or be explicitly overridden before acceptance.",
  };
}
