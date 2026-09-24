import { create } from "zustand";
import { loadFromStorage, saveToStorage, generateId } from "@/lib/storage";
import { writePty } from "@/lib/tauri";
import { useLayoutStore } from "@/stores/layoutStore";
import { useAgentTaskStore } from "@/stores/agentTaskStore";
import { openConversationInAgents } from "@/stores/sessionGlue";
import { API_PROVIDERS, getDefaultModel } from "@/lib/api-models";
import {
  SCOUT_SYSTEM_PROMPT,
  SCOUT_ALLOWED_TOOLS,
  SCOUT_MEMORY_CONTEXT_DEFAULT,
} from "@/lib/scout-config";
import type { PromptTemplate } from "@/types/prompt";

import { storageKey } from "@/lib/brand";
const STORAGE_KEY = storageKey("prompt-templates");

const BUILTIN_TEMPLATES: PromptTemplate[] = [
  {
    id: "builtin-review",
    name: "Code Review",
    content:
      "Review the recent changes in this project. Focus on correctness, performance, and security. Highlight any issues found.",
    category: "review",
    createdAt: 0,
    updatedAt: 0,
  },
  {
    id: "builtin-debug",
    name: "Debug Issue",
    content: "Help me debug this issue. Look at the error messages and suggest fixes.",
    category: "debugging",
    createdAt: 0,
    updatedAt: 0,
  },
  {
    id: "builtin-explain",
    name: "Explain Code",
    content:
      "Explain how this codebase works. Start with the entry point and trace through the main flow.",
    category: "general",
    createdAt: 0,
    updatedAt: 0,
  },
  {
    id: "builtin-test",
    name: "Write Tests",
    content:
      "Write comprehensive tests for the recent changes. Cover edge cases and error scenarios.",
    category: "general",
    createdAt: 0,
    updatedAt: 0,
  },
  {
    id: "builtin-refactor",
    name: "Refactor",
    content:
      "Suggest refactoring opportunities in this code. Focus on readability and maintainability.",
    category: "custom",
    createdAt: 0,
    updatedAt: 0,
  },
];

function loadTemplates(): PromptTemplate[] {
  const stored = loadFromStorage<PromptTemplate[]>(STORAGE_KEY, []);
  if (stored.length === 0) {
    saveToStorage(STORAGE_KEY, BUILTIN_TEMPLATES);
    return BUILTIN_TEMPLATES;
  }
  return stored;
}

interface PromptStore {
  templates: PromptTemplate[];
  addTemplate: (name: string, content: string, category: PromptTemplate["category"]) => void;
  updateTemplate: (
    id: string,
    updates: Partial<Pick<PromptTemplate, "name" | "content" | "category">>,
  ) => void;
  deleteTemplate: (id: string) => void;
  sendToTerminal: (templateId: string) => Promise<void>;
  sendToAgentChat: (templateId: string) => Promise<void>;
}

export const usePromptStore = create<PromptStore>((set, get) => ({
  templates: loadTemplates(),

  addTemplate: (name, content, category) => {
    const now = Date.now();
    const template: PromptTemplate = {
      id: generateId("tpl"),
      name,
      content,
      category,
      createdAt: now,
      updatedAt: now,
    };
    const updated = [...get().templates, template];
    set({ templates: updated });
    saveToStorage(STORAGE_KEY, updated);
  },

  updateTemplate: (id, updates) => {
    const updated = get().templates.map((t) =>
      t.id === id ? { ...t, ...updates, updatedAt: Date.now() } : t,
    );
    set({ templates: updated });
    saveToStorage(STORAGE_KEY, updated);
  },

  deleteTemplate: (id) => {
    const updated = get().templates.filter((t) => t.id !== id);
    set({ templates: updated });
    saveToStorage(STORAGE_KEY, updated);
  },

  sendToTerminal: async (templateId) => {
    const template = get().templates.find((t) => t.id === templateId);
    if (!template) throw new Error("This prompt template no longer exists.");
    const activePane = useLayoutStore.getState().getActivePane();
    if (!activePane?.sessionId) throw new Error("Select a running terminal before sending this prompt.");
    await writePty(activePane.sessionId, template.content + "\r");
  },

  sendToAgentChat: async (templateId) => {
    const template = get().templates.find((t) => t.id === templateId);
    if (!template) throw new Error("This prompt template no longer exists.");
    const projectPath = useLayoutStore.getState().projectPath;
    if (!projectPath) throw new Error("Open a project before sending this prompt to Scout.");
    const agentState = useAgentTaskStore.getState();
    const selected = agentState.conversations.find(
      (c) => c.id === agentState.selectedConversationId,
    );
    const agent =
      selected?.mode === "api" && API_PROVIDERS.some((p) => p.agentCli === selected.agent)
        ? selected.agent
        : "api-claude";
    const id = await useAgentTaskStore.getState().createApiConversation({
      agent,
      projectPath,
      model: getDefaultModel(agent),
      initialMessage: template.content,
      systemPromptOverride: SCOUT_SYSTEM_PROMPT,
      thinkingEnabled: false,
      planMode: false,
      sshTarget: null,
      skipBackendStart: false,
      allowedTools: SCOUT_ALLOWED_TOOLS,
      memoryContextEnabled: SCOUT_MEMORY_CONTEXT_DEFAULT,
    });
    // Prompt-library launches are durable conversations owned by Agents. Do not
    // materialize a Workspace pane as a navigation side effect.
    useAgentTaskStore.getState().selectConversation(id);
    openConversationInAgents(id);
  },
}));
