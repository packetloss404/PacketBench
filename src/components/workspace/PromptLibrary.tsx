import { useState } from "react";
import { BookOpen, Terminal, MessageSquare, Copy, Pencil, Trash2, Plus, Check, X, Search } from "lucide-react";
import { Modal } from "@/components/ui/Modal";
import { ConfirmDeleteModal } from "@/components/ui/ConfirmDeleteModal";
import { Dropdown, DropdownItem } from "@/components/ui/Dropdown";
import { usePromptStore } from "@/stores/promptStore";
import type { PromptTemplate } from "@/types/prompt";

const CATEGORIES: { key: PromptTemplate["category"] | "all"; label: string }[] = [
  { key: "all", label: "All" },
  { key: "general", label: "General" },
  { key: "review", label: "Review" },
  { key: "debugging", label: "Debug" },
  { key: "feature", label: "Feature" },
  { key: "custom", label: "Custom" },
];

const CATEGORY_COLORS: Record<string, string> = {
  general: "bg-accent-blue/20 text-accent-blue",
  review: "bg-accent-green/20 text-accent-green",
  debugging: "bg-accent-amber/20 text-accent-amber",
  feature: "bg-accent-purple/20 text-accent-purple",
  custom: "bg-text-muted/20 text-text-muted",
};

/** Non-native category picker for the create/edit forms below — the styled
 * Dropdown/DropdownItem equivalent of a `<select>`, matching the pattern
 * used by composer/ProviderPicker. Excludes the "all" filter entry, which
 * only makes sense for the tab row, not a template's own category. */
function CategoryPicker({
  value,
  onChange,
}: {
  value: PromptTemplate["category"];
  onChange: (category: PromptTemplate["category"]) => void;
}) {
  const options = CATEGORIES.filter((c) => c.key !== "all") as {
    key: PromptTemplate["category"];
    label: string;
  }[];
  const current = options.find((c) => c.key === value);
  return (
    <Dropdown
      trigger={<span className="text-text-primary">{current?.label ?? value}</span>}
    >
      {options.map((c) => (
        <DropdownItem key={c.key} onClick={() => onChange(c.key)}>
          {c.label}
        </DropdownItem>
      ))}
    </Dropdown>
  );
}

interface PromptLibraryProps {
  onClose: () => void;
}

export function PromptLibrary({ onClose }: PromptLibraryProps) {
  const templates = usePromptStore((s) => s.templates);
  const addTemplate = usePromptStore((s) => s.addTemplate);
  const updateTemplate = usePromptStore((s) => s.updateTemplate);
  const deleteTemplate = usePromptStore((s) => s.deleteTemplate);
  const sendToTerminal = usePromptStore((s) => s.sendToTerminal);
  const sendToAgentChat = usePromptStore((s) => s.sendToAgentChat);

  const [search, setSearch] = useState("");
  const [activeCategory, setActiveCategory] = useState<PromptTemplate["category"] | "all">("all");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [editContent, setEditContent] = useState("");
  const [editCategory, setEditCategory] = useState<PromptTemplate["category"]>("general");
  const [isCreating, setIsCreating] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<PromptTemplate | null>(null);
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);

  const filtered = templates.filter((t) => {
    if (activeCategory !== "all" && t.category !== activeCategory) return false;
    if (search) {
      const q = search.toLowerCase();
      return t.name.toLowerCase().includes(q) || t.content.toLowerCase().includes(q);
    }
    return true;
  });

  function startEdit(t: PromptTemplate) {
    setEditingId(t.id);
    setEditName(t.name);
    setEditContent(t.content);
    setEditCategory(t.category);
    setIsCreating(false);
  }

  function saveEdit() {
    if (isCreating) {
      if (editName.trim() && editContent.trim()) {
        addTemplate(editName.trim(), editContent.trim(), editCategory);
      }
    } else if (editingId) {
      updateTemplate(editingId, { name: editName.trim(), content: editContent.trim(), category: editCategory });
    }
    setEditingId(null);
    setIsCreating(false);
  }

  function cancelEdit() {
    setEditingId(null);
    setIsCreating(false);
  }

  function startCreate() {
    setIsCreating(true);
    setEditingId("__new__");
    setEditName("");
    setEditContent("");
    setEditCategory("general");
  }

  function handleCopy(content: string) {
    navigator.clipboard.writeText(content);
  }

  async function handleSend(id: string, target: "terminal" | "scout") {
    if (sending) return;
    setSending(true);
    setSendError(null);
    try {
      await (target === "terminal" ? sendToTerminal(id) : sendToAgentChat(id));
      onClose();
    } catch (error) {
      setSendError(`${String(error)} Your template is kept here. Check the destination before retrying to avoid sending twice.`);
    } finally {
      setSending(false);
    }
  }

  return (
    <Modal
      onClose={onClose}
      title="Prompt Library"
      icon={<BookOpen size={14} className="text-accent-green" />}
      width="w-[600px]"
    >
      <div className="p-4 space-y-3">
        {sendError && <p role="alert" className="text-xs text-accent-red">{sendError}</p>}
        {/* Search + New */}
        <div className="flex items-center gap-2">
          <div className="relative flex-1">
            <Search size={12} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-text-muted" />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search templates..."
              className="w-full pl-7 pr-3 py-1.5 text-xs bg-bg-primary border border-bg-border rounded text-text-primary placeholder-text-muted focus:outline-none focus:border-accent-green/50"
            />
          </div>
          <button
            onClick={startCreate}
            disabled={isCreating}
            className="flex items-center gap-1 px-2.5 py-1.5 text-ui bg-accent-green/20 text-accent-green rounded hover:bg-accent-green/30 transition-colors disabled:opacity-40"
          >
            <Plus size={12} />
            New
          </button>
        </div>

        {/* Category tabs */}
        <div className="flex items-center gap-1">
          {CATEGORIES.map((cat) => (
            <button
              key={cat.key}
              onClick={() => setActiveCategory(cat.key)}
              className={`px-2 py-1 text-ui rounded transition-colors ${
                activeCategory === cat.key
                  ? "bg-accent-green/20 text-accent-green"
                  : "text-text-muted hover:text-text-primary hover:bg-bg-hover"
              }`}
            >
              {cat.label}
            </button>
          ))}
        </div>

        {/* Template list */}
        <div className="space-y-2 max-h-[50vh] overflow-y-auto pr-1">
          {/* New template form */}
          {isCreating && (
            <div className="p-3 bg-bg-primary border border-accent-green/30 rounded-lg space-y-2">
              <input
                type="text"
                value={editName}
                onChange={(e) => setEditName(e.target.value)}
                placeholder="Template name"
                className="w-full px-2.5 py-1.5 text-xs bg-bg-secondary border border-bg-border rounded text-text-primary placeholder-text-muted focus:outline-none focus:border-accent-green/50"
                autoFocus
              />
              <textarea
                value={editContent}
                onChange={(e) => setEditContent(e.target.value)}
                placeholder="Prompt content..."
                rows={3}
                className="w-full px-2.5 py-1.5 text-xs bg-bg-secondary border border-bg-border rounded text-text-primary placeholder-text-muted focus:outline-none focus:border-accent-green/50 resize-none"
              />
              <div className="flex items-center gap-2">
                <CategoryPicker value={editCategory} onChange={setEditCategory} />
                <div className="flex-1" />
                <button onClick={cancelEdit} className="p-1 text-text-muted hover:text-text-primary transition-colors">
                  <X size={14} />
                </button>
                <button onClick={saveEdit} className="p-1 text-accent-green hover:text-accent-green/80 transition-colors">
                  <Check size={14} />
                </button>
              </div>
            </div>
          )}

          {filtered.map((t) => (
            <div key={t.id} className="p-3 bg-bg-primary border border-bg-border rounded-lg hover:border-bg-border/80 transition-colors">
              {editingId === t.id && !isCreating ? (
                /* Inline edit mode */
                <div className="space-y-2">
                  <input
                    type="text"
                    value={editName}
                    onChange={(e) => setEditName(e.target.value)}
                    className="w-full px-2.5 py-1.5 text-xs bg-bg-secondary border border-bg-border rounded text-text-primary focus:outline-none focus:border-accent-green/50"
                    autoFocus
                  />
                  <textarea
                    value={editContent}
                    onChange={(e) => setEditContent(e.target.value)}
                    rows={3}
                    className="w-full px-2.5 py-1.5 text-xs bg-bg-secondary border border-bg-border rounded text-text-primary focus:outline-none focus:border-accent-green/50 resize-none"
                  />
                  <div className="flex items-center gap-2">
                    <CategoryPicker value={editCategory} onChange={setEditCategory} />
                    <div className="flex-1" />
                    <button onClick={cancelEdit} className="p-1 text-text-muted hover:text-text-primary transition-colors">
                      <X size={14} />
                    </button>
                    <button onClick={saveEdit} className="p-1 text-accent-green hover:text-accent-green/80 transition-colors">
                      <Check size={14} />
                    </button>
                  </div>
                </div>
              ) : (
                /* Display mode */
                <>
                  <div className="flex items-center gap-2 mb-1">
                    <span className="text-ui font-medium text-text-primary">{t.name}</span>
                    <span className={`px-1.5 py-0.5 text-meta rounded-full ${CATEGORY_COLORS[t.category] || CATEGORY_COLORS.custom}`}>
                      {t.category}
                    </span>
                    {t.id.startsWith("builtin-") && (
                      <span className="px-1.5 py-0.5 text-meta rounded-full bg-accent-purple/15 text-accent-purple">
                        built-in
                      </span>
                    )}
                  </div>
                  <p className="text-ui text-text-secondary mb-2 leading-relaxed">
                    {t.content.length > 80 ? t.content.slice(0, 80) + "..." : t.content}
                  </p>
                  <div className="flex items-center gap-1">
                    <button
                      onClick={() => void handleSend(t.id, "terminal")}
                      disabled={sending}
                      className="flex items-center gap-1 px-2 py-0.5 text-ui text-text-muted hover:text-accent-green bg-bg-secondary rounded transition-colors"
                      title="Send to Terminal — writes this prompt to the active PTY session."
                    >
                      <Terminal size={10} />
                      Terminal
                    </button>
                    <button
                      onClick={() => void handleSend(t.id, "scout")}
                      disabled={sending}
                      className="flex items-center gap-1 px-2 py-0.5 text-ui text-text-muted hover:text-accent-cyan bg-bg-secondary rounded transition-colors"
                      title="Send to Scout — opens a read-only agent chat with this prompt and project memory."
                    >
                      <MessageSquare size={10} />
                      Scout
                    </button>
                    <button
                      onClick={() => handleCopy(t.content)}
                      className="flex items-center gap-1 px-2 py-0.5 text-ui text-text-muted hover:text-text-primary bg-bg-secondary rounded transition-colors"
                      title="Copy prompt content to clipboard."
                    >
                      <Copy size={10} />
                      Copy
                    </button>
                    <div className="flex-1" />
                    <button
                      onClick={() => startEdit(t)}
                      className="p-1 text-text-muted hover:text-text-primary transition-colors"
                      title="Edit template"
                    >
                      <Pencil size={11} />
                    </button>
                    <button
                      onClick={() => setPendingDelete(t)}
                      className="p-1 text-text-muted hover:text-accent-red transition-colors"
                      title={`Delete template “${t.name}”`}
                      aria-label={`Delete template ${t.name}`}
                    >
                      <Trash2 size={11} />
                    </button>
                  </div>
                </>
              )}
            </div>
          ))}

          {filtered.length === 0 && !isCreating && (
            <div className="text-center py-8 text-text-muted text-ui">
              No templates found. Click "New" to create one.
            </div>
          )}
        </div>
      </div>

      {pendingDelete && (
        <ConfirmDeleteModal
          title="Delete prompt template?"
          entityName={pendingDelete.name}
          description="is removed from the prompt library."
          onConfirm={() => {
            deleteTemplate(pendingDelete.id);
            setPendingDelete(null);
          }}
          onClose={() => setPendingDelete(null)}
        />
      )}
    </Modal>
  );
}
