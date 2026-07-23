import { useEffect, useRef, useState } from "react";
import { marked } from "marked";
import DOMPurify from "dompurify";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { faComment } from "@fortawesome/free-solid-svg-icons";
import { useStore } from "../lib/store";
import { api } from "../lib/api";
import type { ChatMessage } from "../lib/api";
import { relTime } from "../lib/time";
import { toast } from "../lib/ui";

// Director chat: a single PERSISTENT panel (a floating drawer, not a route) so
// it's reachable from anywhere in hive. It talks to the supervisor session
// backend (POST /api/chat/turn); the supervisor's replies — and the director's
// own echoed messages — arrive live over SSE via the store. Resulting work
// (tasks created, decisions answered) shows up live on the board/inbox as usual;
// here it surfaces as the supervisor's reply plus any action chips on a message.

const LS_PROJECT = "hive_chat_project";

function MsgActions({ actions }: { actions: ChatMessage["actions"] }) {
  if (!actions?.length) return null;
  return (
    <div className="chat-actions">
      {actions.map((a, i) => (
        <span key={i} className="chat-action-chip">
          {a.label ?? JSON.stringify(a)}
        </span>
      ))}
    </div>
  );
}

export function Bubble({ m }: { m: ChatMessage }) {
  const html =
    m.role === "assistant" ? DOMPurify.sanitize(marked.parse(m.text, { async: false }) as string) : null;
  return (
    <div className={`chat-msg chat-${m.role}`}>
      <div className="chat-bubble">
        {html != null ? (
          <div className="chat-md" dangerouslySetInnerHTML={{ __html: html }} />
        ) : (
          <div className="chat-text">{m.text}</div>
        )}
        <MsgActions actions={m.actions} />
      </div>
      <div className="chat-ts" title={m.ts}>
        {relTime(m.ts)}
      </div>
    </div>
  );
}

export default function Chat() {
  const { projects, chatThreadId, chatMessages, openChatThread } = useStore();
  const [open, setOpen] = useState(false);
  const [project, setProject] = useState<string>(() => localStorage.getItem(LS_PROJECT) || "");
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Default the project once projects load; keep the last-used one across reloads.
  useEffect(() => {
    if (!projects.length) return;
    if (!project || !projects.some((p) => p.id === project)) setProject(projects[0].id);
  }, [projects]);
  useEffect(() => {
    if (project) localStorage.setItem(LS_PROJECT, project);
  }, [project]);

  // When the panel opens (or the project changes), resume the project's most
  // recent thread. No thread yet → a blank conversation the first message starts.
  useEffect(() => {
    if (!open || !project) return;
    api
      .chatThreads(project)
      .then((ts) => openChatThread(ts[0]?.id ?? null))
      .catch(() => openChatThread(null));
  }, [open, project]);

  // Stick to the bottom as messages stream in.
  useEffect(() => {
    if (open) scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [chatMessages, open]);

  const send = async () => {
    const body = text.trim();
    if (!body || sending || !project) return;
    setSending(true);
    setText("");
    try {
      const r = await api.chatTurn(chatThreadId ? { thread_id: chatThreadId, text: body } : { project_id: project, text: body });
      if (r.delivery === "failed") toast(`Supervisor unavailable: ${r.error ?? "spawn failed"}`);
      // First message of a new thread: adopt the id so SSE replies land here.
      if (r.thread_id !== chatThreadId) openChatThread(r.thread_id);
    } catch (e: any) {
      toast(`Chat failed: ${e?.message ?? e}`);
      setText(body); // don't eat the message on a hard failure
    } finally {
      setSending(false);
    }
  };

  const closeThread = async () => {
    if (!chatThreadId) return;
    await api.chatClose(chatThreadId).catch(() => {});
    openChatThread(null);
  };

  // Supervisor is thinking whenever the last thing said was the director's.
  const awaiting = chatMessages.length > 0 && chatMessages[chatMessages.length - 1].role === "director";

  if (!open)
    return (
      <button className="chat-fab" title="Chat with the hive supervisor" onClick={() => setOpen(true)}>
        <FontAwesomeIcon icon={faComment} />
      </button>
    );

  return (
    <div className="chat-panel">
      <header className="chat-head">
        <select className="chat-proj" value={project} onChange={(e) => setProject(e.target.value)}>
          {projects.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
        <div className="chat-head-actions">
          <button className="chat-iconbtn" title="New conversation" onClick={() => openChatThread(null)}>
            ✎
          </button>
          {chatThreadId && (
            <button className="chat-iconbtn" title="End this supervisor session" onClick={closeThread}>
              ⏹
            </button>
          )}
          <button className="chat-iconbtn" title="Close panel" onClick={() => setOpen(false)}>
            ✕
          </button>
        </div>
      </header>
      <div className="chat-scroll" ref={scrollRef}>
        {chatMessages.length === 0 && (
          <div className="chat-empty muted">
            {project
              ? "Ask the supervisor to spin up work, check status, or answer a decision. It coordinates the fleet for you."
              : "Add a project first — the supervisor session runs in a project's repo."}
          </div>
        )}
        {chatMessages.map((m) => (
          <Bubble key={m.id} m={m} />
        ))}
        {awaiting && <div className="chat-typing muted">supervisor is working…</div>}
      </div>
      <div className="chat-compose">
        <textarea
          placeholder="Message the supervisor…"
          value={text}
          disabled={!project}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              send();
            }
          }}
        />
        <button className="btn btn-primary" onClick={send} disabled={sending || !text.trim() || !project}>
          Send
        </button>
      </div>
    </div>
  );
}
