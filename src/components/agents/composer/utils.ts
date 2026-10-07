import { Bot, MessageCircle, Hand, Layers, type LucideIcon } from "lucide-react";
import type { AgentCli } from "@/stores/agentTaskStore";
import type { ImageAttachment } from "@/lib/tauri";

/** Cursor-style launch modes. */
export type AgentMode = "agent" | "ask" | "manual" | "plan";

/** B2: Codex-App-style 2-way "where does the agent run" picker. `local`
 * is the default — no worktree, edits land in the project tree. `worktree`
 * provisions `.pkt-worktrees/<convId>` on a fresh `pkt/<convId>` branch
 * (T3.F). The choice persists in localStorage so users don't re-pick. */
export type ComposerMode = "local" | "worktree";

export const MODE_META: Record<
  AgentMode,
  { label: string; description: string; icon: LucideIcon; color: string }
> = {
  agent: {
    label: "Agent",
    description: "Full tools — read, write, run commands",
    icon: Bot,
    color: "text-accent-green",
  },
  ask: {
    label: "Ask",
    description: "Read-only — no edits or commands",
    icon: MessageCircle,
    color: "text-accent-blue",
  },
  manual: {
    label: "Manual",
    description: "Every risky tool requires your approval",
    icon: Hand,
    color: "text-accent-amber",
  },
  plan: {
    label: "Plan",
    description: "Produce a structured plan first, then execute",
    icon: Layers,
    color: "text-accent-purple",
  },
};

export const MODE_ORDER: AgentMode[] = ["agent", "ask", "manual", "plan"];

/**
 * Provider dropdown grouping. Only includes `api-*` agents (PTY CLI agents
 * like `claude-code` / `codex` are handled elsewhere). Every row here
 * authenticates with an API key from the OS keyring — PacketBench offers no
 * Claude.ai / ChatGPT subscription login for API agents.
 *
 * `api-claude-oauth` is a historical id, not an OAuth row: it is the Claude
 * Agent SDK running in the sidecar on the Anthropic API key.
 * `api-openai-codex` was removed in 2026-07 (see `RETIRED_API_AGENTS`).
 */
export const PROVIDER_GROUPS: { label: string; agents: AgentCli[] }[] = [
  { label: "Anthropic", agents: ["api-claude-oauth" as AgentCli, "api-claude"] },
  { label: "OpenAI", agents: ["api-openai", "api-openai-agents"] },
  { label: "Google", agents: ["api-google"] },
  { label: "xAI", agents: ["api-xai"] },
  {
    label: "Gateways and plans",
    agents: ["api-sugar", "api-cline-pass", "api-opencode-go", "api-ollama-cloud"],
  },
  {
    label: "Other",
    agents: ["api-openrouter", "api-minimax", "api-ollama", "api-custom"],
  },
];

/**
 * Slugify a template name to its slash-command form, e.g. "Code Review"
 * becomes "code-review". Used by the unified composer's slash-command
 * source so users see the same `/<name>` in both variants.
 */
export function templateSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** Hard cap to keep payloads sane — Anthropic accepts ~5MB per image. */
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

/**
 * Read a File / Blob into a base64 string suitable for ImageAttachment.
 * Strips the `data:<mime>;base64,` prefix that FileReader.readAsDataURL
 * always prepends so the wire payload is just the encoded bytes.
 */
export function fileToImageAttachment(file: File): Promise<ImageAttachment> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result;
      if (typeof result !== "string") {
        reject(new Error("FileReader returned non-string result"));
        return;
      }
      const commaIdx = result.indexOf(",");
      const data_base64 = commaIdx >= 0 ? result.slice(commaIdx + 1) : result;
      resolve({
        media_type: file.type || "image/png",
        data_base64,
      });
    };
    reader.onerror = () => reject(reader.error ?? new Error("read failed"));
    reader.readAsDataURL(file);
  });
}

/**
 * FAULT: this used to advertise "Ctrl+N for new agent". It is rendered under
 * the LAUNCH composer only, where that promise is wrong twice over:
 * `useAgentTabHoists` returns early on `isEditableTarget`, so the chord is
 * inert while the caret is in the composer it is printed beneath; and even
 * when it does fire from the Agents route it runs
 * `selectConversation(null)` — already the state the launch composer IS. The
 * chord was not made to fire from a textarea instead, because Ctrl+N is
 * caret-down in macOS text fields and stealing it would break editing to
 * deliver a no-op. Every other hint here is live from inside the composer.
 */
export const COMPOSER_HELP_TEXT =
  "Enter to send · Shift+Enter for newline · @ to mention a file · / to expand a prompt template · drag/paste images";

/**
 * The composer placeholder must not promise an affordance this session cannot
 * serve — a conversation with no project path has nothing for `@` to scan, so
 * the prompt degrades rather than advertising a dead key. Driven by
 * `SessionCapabilities.slashCommands` / `.fileMentions`.
 */
export function composerPlaceholder(hasCommands: boolean, hasFiles: boolean): string {
  if (hasCommands && hasFiles) return "Do anything — / for commands, @ for files";
  if (hasCommands) return "Do anything — / for commands";
  if (hasFiles) return "Do anything — @ for files";
  return "Do anything";
}
