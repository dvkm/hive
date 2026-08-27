import { useEffect, useRef, useState } from "react";
import { useStore } from "../lib/store";
import { api } from "../lib/api";
import type { ChatMessage, ChatThread } from "../lib/api";
import { toast } from "../lib/ui";
import { Bubble } from "./Chat";

// Supervisors board: one live chat column per supervisor session, side by side.
// Unlike the floating drawer (one thread at a time), this is the fleet-command
// view — several projects at once, and several supervisors on the SAME project
// when you want parallel conversations. Columns are the user's layout (kept in
// localStorage); the threads themselves live on the server.

const LS_COLS = "hive_supervisor_cols";

// A column is either a live thread or a draft (project picked, no thread until
// the first message creates one — same lazy-create as the drawer).
interface Col {
  key: string;
  thread_id: string | null;
  project_id: string;
}

function loadCols(): Col[] | null {
  try {
    const raw = localStorage.getItem(LS_COLS);
    return raw ? (JSON.parse(raw) as Col[]) : null;
  } catch {
    return null;
  }
}

function SupervisorColumn({
  col,
  title,
  projectName,
  onThreadCreated,
  onRemove,
}: {
  col: Col;
  title: string | null;
  projectName: string;
  onThreadCreated: (key: string, threadId: string) => void;
  onRemove: (key: string, endSession: boolean) => void;
}) {
  const { onChatMessage } = useStore();
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const threadRef = useRef(col.thread_id);
  threadRef.current = col.thread_id;

  useEffect(() => {
    if (!col.thread_id) return setMessages([]);
    let live = true;
    api.chatThread(col.thread_id).then((t) => live && setMessages(t.messages)).catch(() => {});
    return () => {
      live = false;
    };
  }, [col.thread_id]);

  // Live append for THIS thread only (the store fans out every chat_message).
  useEffect(
    () =>
      onChatMessage((m) => {
        if (m.thread_id !== threadRef.current) return;
        setMessages((prev) => (prev.some((x) => x.id === m.id) ? prev : [...prev, m]));
      }),
    []
  );

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [messages]);

  const send = async () => {
    const body = text.trim();
    if (!body || sending) return;
    setSending(true);
    setText("");
    try {
      const r = await api.chatTurn(
        col.thread_id ? { thread_id: col.thread_id, text: body } : { project_id: col.project_id, text: body }
      );
      // A failed delivery posts a visible message on the thread over SSE.
      if (r.thread_id !== col.thread_id) onThreadCreated(col.key, r.thread_id);
    } catch (e: any) {
      toast(`Chat failed: ${e?.message ?? e}`);
      setText(body);
    } finally {
      setSending(false);
    }
  };

  const awaiting = messages.length > 0 && messages[messages.length - 1].role === "director";

  return (
    <section className="sup-col">
      <header className="sup-col-head">
        <span className="chip">{projectName}</span>
        <span className="sup-col-title" title={title ?? undefined}>
          {title || (col.thread_id ? "conversation" : "new supervisor")}
        </span>
        <span className="spacer" />
        {col.thread_id && (
          <button className="chat-iconbtn" title="End this supervisor session and remove" onClick={() => onRemove(col.key, true)}>
            ⏹
          </button>
        )}
        <button className="chat-iconbtn" title="Remove column (session keeps running)" onClick={() => onRemove(col.key, false)}>
          ✕
        </button>
      </header>
      <div className="chat-scroll sup-col-scroll" ref={scrollRef}>
        {messages.length === 0 && (
          <div className="chat-empty muted">Message this supervisor to start the session.</div>
        )}
        {messages.map((m) => (
          <Bubble key={m.id} m={m} />
        ))}
        {awaiting && <div className="chat-typing muted">supervisor is working…</div>}
      </div>
      <div className="chat-compose">
        <textarea
          placeholder={`Message the ${projectName} supervisor…`}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              send();
            }
          }}
        />
        <button className="btn btn-primary" onClick={send} disabled={sending || !text.trim()}>
          Send
        </button>
      </div>
    </section>
  );
}

export default function Supervisors() {
  const { projects } = useStore();
  const [threads, setThreads] = useState<ChatThread[]>([]);
  const [cols, setCols] = useState<Col[]>([]);
  const [adding, setAdding] = useState(false);

  // First visit: a column per existing thread. After that, the saved layout
  // wins (threads the user removed stay removed; drafts survive reloads).
  useEffect(() => {
    api
      .chatThreads()
      .then((ts) => {
        setThreads(ts);
        const saved = loadCols();
        setCols(saved ?? ts.map((t) => ({ key: t.id, thread_id: t.id, project_id: t.project_id ?? "" })));
      })
      .catch(() => setCols(loadCols() ?? []));
  }, []);
  useEffect(() => {
    if (cols.length || localStorage.getItem(LS_COLS)) localStorage.setItem(LS_COLS, JSON.stringify(cols));
  }, [cols]);

  const addCol = (projectId: string) => {
    setCols((cs) => [...cs, { key: `draft_${Date.now()}`, thread_id: null, project_id: projectId }]);
    setAdding(false);
  };
  const onThreadCreated = (key: string, threadId: string) => {
    setCols((cs) => cs.map((c) => (c.key === key ? { ...c, thread_id: threadId } : c)));
    api.chatThreads().then(setThreads).catch(() => {});
  };
  const onRemove = (key: string, endSession: boolean) => {
    const col = cols.find((c) => c.key === key);
    if (endSession && col?.thread_id) api.chatClose(col.thread_id).catch(() => {});
    setCols((cs) => cs.filter((c) => c.key !== key));
  };

  return (
    <div className="sup-page">
      <div className="page-head">
        <h1 className="page-title">Supervisors</h1>
        <p className="page-sub">
          {cols.length === 0
            ? "One chat column per supervisor session — run several projects (or the same one twice) side by side."
            : `${cols.length} supervisor${cols.length === 1 ? "" : "s"} open.`}
        </p>
        <span className="spacer" />
        {adding ? (
          <select
            className="chat-proj"
            autoFocus
            defaultValue=""
            onBlur={() => setAdding(false)}
            onChange={(e) => e.target.value && addCol(e.target.value)}
          >
            <option value="" disabled>
              pick a project…
            </option>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        ) : (
          <button className="btn btn-primary" onClick={() => setAdding(true)}>
            ＋ Add supervisor
          </button>
        )}
      </div>
      <div className="sup-board">
        {cols.map((c) => (
          <SupervisorColumn
            key={c.key}
            col={c}
            title={threads.find((t) => t.id === c.thread_id)?.title ?? null}
            projectName={projects.find((p) => p.id === c.project_id)?.name ?? "?"}
            onThreadCreated={onThreadCreated}
            onRemove={onRemove}
          />
        ))}
        {cols.length === 0 && <div className="muted sup-empty">No supervisors yet — add one to start.</div>}
      </div>
    </div>
  );
}
