import { useEffect, useRef, useState } from "react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { MessageCircle, Send, Square } from "lucide-react";
import { Modal } from "@/components/ui/Modal";
import { MarkdownRenderer } from "@/components/common/MarkdownRenderer";
import { ProjectPicker } from "@/components/agents/composer/ProjectPicker";
import { useAgentTaskStore } from "@/stores/agentTaskStore";
import { useRoutingStore } from "@/stores/routingStore";
import { askAgentChatStream, cancelAgentChatStream, getAuxRouteResolutions } from "@/lib/tauri";
import { agentChatChunkEvent, agentChatDoneEvent, agentChatErrorEvent } from "@/lib/events";
import { isSshUri } from "@/lib/ssh-uri";

type Message = { role: "user" | "assistant"; content: string };
type ActiveRequest = { id: string; partial: string; unlisten: UnlistenFn[] };

export function InsightsChatModal({ onClose }: { onClose: () => void }) {
  const selectedRepo = useAgentTaskStore((s) => s.selectedRepo);
  const auxMappings = useRoutingStore((s) => s.auxMappings);
  const [project, setProject] = useState<string | null>(selectedRepo);
  const [messages, setMessages] = useState<Message[]>([]);
  const [question, setQuestion] = useState("");
  const [partial, setPartial] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [route, setRoute] = useState("Checking provider…");
  const active = useRef<ActiveRequest | null>(null);
  const scroll = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let live = true;
    getAuxRouteResolutions()
      .then((rows) => {
        const row = rows.find((r) => r.taskClass === "agent-chat");
        if (live)
          setRoute(
            row?.error ||
              (row ? `${row.provider} · ${row.model}` : "Choose a provider in AI Provider Routing"),
          );
      })
      .catch(() => {
        if (live) setRoute("Provider unavailable; check AI Provider Routing");
      });
    return () => {
      live = false;
    };
  }, [auxMappings]);

  useEffect(
    () => () => {
      const request = active.current;
      active.current = null;
      if (request) {
        request.unlisten.forEach((stop) => stop());
        void cancelAgentChatStream(request.id).catch(() => {});
      }
    },
    [],
  );

  useEffect(() => {
    scroll.current?.scrollIntoView?.({ block: "end" });
  }, [messages, partial]);

  function finish(request: ActiveRequest, success: boolean) {
    if (active.current !== request) return;
    active.current = null;
    request.unlisten.forEach((stop) => stop());
    if (success && request.partial.trim()) {
      setMessages((history) => [...history, { role: "assistant", content: request.partial }]);
    }
    setPartial("");
    setBusy(false);
  }

  async function send() {
    if (!project || !question.trim() || active.current) return;
    if (isSshUri(project)) {
      setError("Select a local project for Insights chat.");
      return;
    }
    const next: Message[] = [...messages, { role: "user", content: question.trim() }];
    const request: ActiveRequest = { id: crypto.randomUUID(), partial: "", unlisten: [] };
    active.current = request;
    setMessages(next);
    setQuestion("");
    setPartial("");
    setError(null);
    setBusy(true);
    try {
      // Register before invoking: a fast provider must not outrun its listeners.
      async function attach<T>(event: string, handler: (payload: T) => void) {
        const stop = await listen<T>(event, ({ payload }) => handler(payload));
        if (active.current !== request) {
          stop();
          return false;
        }
        request.unlisten.push(stop);
        return true;
      }
      if (
        !(await attach<string>(agentChatChunkEvent(request.id), (text) => {
          if (active.current !== request) return;
          request.partial += text;
          setPartial(request.partial);
        }))
      )
        return;
      if (
        !(await attach<{ message: string }>(agentChatErrorEvent(request.id), (payload) => {
          if (active.current === request) setError(payload.message);
        }))
      )
        return;
      if (
        !(await attach<boolean>(agentChatDoneEvent(request.id), (success) =>
          finish(request, success),
        ))
      )
        return;
      await askAgentChatStream(project, next, undefined, request.id);
      // If Stop/close raced the invoke's registry setup, cancel again after its acknowledgement.
      if (active.current !== request) await cancelAgentChatStream(request.id);
    } catch (cause) {
      if (active.current === request) {
        setError(String(cause));
        finish(request, false);
      }
    }
  }

  async function stop() {
    const request = active.current;
    if (!request) return;
    try {
      await cancelAgentChatStream(request.id);
      finish(request, false);
    } catch (cause) {
      setError(`Could not stop Insights: ${String(cause)}`);
    }
  }

  return (
    <Modal
      title="Insights agent chat"
      icon={<MessageCircle size={16} />}
      onClose={onClose}
      width="w-[760px]"
    >
      <div className="flex max-h-[75vh] flex-col gap-3 p-4">
        <div className="flex flex-wrap items-center justify-between gap-2 text-[11px]">
          <fieldset disabled={busy} className="min-w-0 border-0 p-0">
            <ProjectPicker
              selectedRepo={project}
              setSelectedRepo={(path) => {
                setProject(path);
                setMessages([]);
                setPartial("");
                setError(null);
              }}
            />
          </fieldset>
          <span className="text-text-secondary">{route}</span>
        </div>
        <p className="text-[10px] text-text-muted">
          Ask about a local project. Insights can read and search files. This chat clears when
          closed.
        </p>
        <div
          aria-live="polite"
          className="min-h-[160px] flex-1 space-y-3 overflow-y-auto rounded border border-bg-border bg-bg-primary p-3"
        >
          {messages.length === 0 && (
            <p className="text-[11px] text-text-muted">
              What would you like to understand about this project?
            </p>
          )}
          {messages.map((message, index) => (
            <div key={index}>
              <div className="mb-1 text-[9px] font-semibold uppercase text-text-muted">
                {message.role === "user" ? "You" : "Insights"}
              </div>
              <MarkdownRenderer
                content={message.content}
                className="text-[11px] text-text-secondary"
              />
            </div>
          ))}
          {busy && (
            <div>
              <div className="mb-1 text-[9px] font-semibold uppercase text-text-muted">
                Insights
              </div>
              {partial ? (
                <MarkdownRenderer content={partial} className="text-[11px] text-text-secondary" />
              ) : (
                <p className="text-[11px] text-text-muted">Reading project files…</p>
              )}
            </div>
          )}
          <div ref={scroll} />
        </div>
        {error && (
          <p role="alert" className="text-[11px] text-accent-red">
            {error}
          </p>
        )}
        <form
          className="flex items-end gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            void send();
          }}
        >
          <textarea
            aria-label="Insights question"
            value={question}
            disabled={busy}
            rows={2}
            onChange={(event) => setQuestion(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                event.preventDefault();
                void send();
              }
            }}
            placeholder="Ask about this codebase…"
            className="min-w-0 flex-1 resize-none rounded border border-bg-border bg-bg-primary p-2 text-[11px] text-text-primary focus:border-accent-green focus:outline-none"
          />
          {busy ? (
            <button
              type="button"
              onClick={() => void stop()}
              className="flex items-center gap-1 rounded border border-bg-border px-3 py-2 text-[11px] text-text-secondary"
            >
              <Square size={12} />
              Stop
            </button>
          ) : (
            <button
              type="submit"
              disabled={!project || !question.trim()}
              className="flex items-center gap-1 rounded bg-accent-green px-3 py-2 text-[11px] text-bg-primary disabled:opacity-40"
            >
              <Send size={12} />
              Send
            </button>
          )}
        </form>
      </div>
    </Modal>
  );
}
