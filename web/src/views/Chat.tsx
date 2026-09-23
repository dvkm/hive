import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { marked } from "marked";
import DOMPurify from "dompurify";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { faComment } from "@fortawesome/free-solid-svg-icons";
import { useStore } from "../lib/store";
import { api } from "../lib/api";
import type { ChatMessage, Decision, Task } from "../lib/api";
import { relTime } from "../lib/time";
import { toast } from "../lib/ui";
import { DecisionCard } from "./DecisionCard";

// One portfolio-wide Chief of staff conversation, in a drawer on every page.
// Its replies and the director's echoed messages arrive live over SSE.

const CHIEF_LAST_SEEN = "hive.chief.lastSeen";

function MsgActions({ actions }: { actions: ChatMessage["actions"] }) {
  const { decisions } = useStore();
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  if (!actions?.length) return null;
  const decisionIds = actions
    .filter((action) => action.type === "decision" && typeof action.decision_id === "string")
    .map((action) => action.decision_id as string);
  const cards = decisionIds
    .map((id) => decisions.find((decision) => decision.id === id))
    .filter((decision): decision is Decision => !!decision && !hidden.has(decision.id));
  const visibleCard = cards[0];
  const passive = actions.filter((action) => action.type !== "decision");
  return (
    <>
      {visibleCard && (
        <div className="chat-decision-actions">
          {cards.length > 1 && <div className="chat-decision-queue">Decision 1 of {cards.length}</div>}
          <DecisionCard key={visibleCard.id} d={visibleCard} onDone={(id) => setHidden((current) => new Set(current).add(id))} />
        </div>
      )}
      {passive.length > 0 && (
        <div className="chat-actions">
          {passive.map((action, i) => <span key={i} className="chat-action-chip">{action.label ?? JSON.stringify(action)}</span>)}
        </div>
      )}
    </>
  );
}

export function Bubble({ m }: { m: ChatMessage }) {
  const { decisions } = useStore();
  const hasDecision = m.actions?.some((action) =>
    action.type === "decision" && action.decision_id && decisions.some((decision) => decision.id === action.decision_id)
  );
  const html =
    m.role === "assistant" ? DOMPurify.sanitize(marked.parse(m.text, { async: false }) as string) : null;
  return (
    <div id={`message-${m.id}`} className={`chat-msg chat-${m.role}${hasDecision ? " chat-has-decision" : ""}`}>
      <div className="chat-bubble">
        {hasDecision ? (
          <div className="chat-decision-intro">One decision needs your call.</div>
        ) : html != null ? (
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
  const { projects, projectsLoaded, decisions, feedEvents, chatThreadId, chatMessages, chatDelivery, openChatThread } = useStore();
  const [open, setOpen] = useState(false);
  const [lastSeen, setLastSeen] = useState<string | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [managerTaskId, setManagerTaskId] = useState<string | null>(null);
  const [managerTask, setManagerTask] = useState<Task | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  // What was new is judged against the previous visit; closing the drawer
  // counts as having read it.
  const openDrawer = () => {
    setLastSeen(localStorage.getItem(CHIEF_LAST_SEEN));
    setOpen(true);
  };
  const closeDrawer = () => {
    localStorage.setItem(CHIEF_LAST_SEEN, new Date().toISOString());
    setOpen(false);
  };

  const refreshManager = useCallback(() => {
    if (!chatThreadId) return;
    api.chatThread(chatThreadId).then((thread) => setManagerTaskId(thread.task_id)).catch(() => {});
  }, [chatThreadId]);

  // There is one durable Chief of staff thread across every project. Reopen it
  // whenever the drawer opens so switching pages never switches threads.
  useEffect(() => {
    if (!open || !projects.length) return;
    api
      .chatThreads()
      .then((ts) => {
        const latest = ts.find((thread) => !thread.project_id) ?? null;
        setManagerTaskId(latest?.task_id ?? null);
        openChatThread(latest?.id ?? null);
      })
      .catch(() => {
        setManagerTaskId(null);
        openChatThread(null);
      });
  }, [open, projects.length]);

  // A respawn binds the thread to a NEW task id that no old event carries, so
  // the thread refetches on its own events and on delivery changes.
  const managerEventCursor = feedEvents.find((e) => e.task_id === managerTaskId)?.id ?? "";
  useEffect(() => {
    if (!open || !chatThreadId) return;
    refreshManager();
  }, [open, chatThreadId, refreshManager, managerEventCursor, chatDelivery, chatMessages.length]);

  useEffect(() => {
    let live = true;
    if (!managerTaskId) {
      setManagerTask(null);
      return;
    }
    api.task(managerTaskId).then((d) => live && setManagerTask(d)).catch(() => live && setManagerTask(null));
    return () => {
      live = false;
    };
  }, [managerTaskId]);

  const send = async () => {
    const body = text.trim();
    if (!body || sending || !projects.length) return;
    setSending(true);
    setText("");
    try {
      const r = await api.chatTurn(chatThreadId ? { thread_id: chatThreadId, text: body } : { scope: "chief", text: body });
      // The turn returns before delivery: progress and any failure arrive over
      // SSE (chat_delivery, plus a visible message on the thread when it fails).
      // First message of a new thread: adopt the id so SSE replies land here.
      if (r.thread_id !== chatThreadId) openChatThread(r.thread_id);
      api.chatThread(r.thread_id).then((thread) => setManagerTaskId(thread.task_id)).catch(() => {});
    } catch (e: any) {
      toast(`Chat failed: ${e?.message ?? e}`);
      setText(body); // don't eat the message on a hard failure
    } finally {
      setSending(false);
    }
  };

  // Working whenever the last thing said was the director's.
  const managerStopped = !!managerTask && ["done", "failed", "cancelled"].includes(managerTask.state);
  const awaiting = !managerStopped && chatMessages.length > 0 && chatMessages[chatMessages.length - 1].role === "director";
  const deliveryLabel =
    chatDelivery === "spawning" ? "Chief of staff is starting…"
    : chatDelivery === "queued" || chatDelivery === "delivering" ? "Delivering…"
    : null;
  const focusedMessages = useMemo(() => {
    const openDecisionIds = new Set(decisions.map((decision) => decision.id));
    const ids = new Set<string>();
    const lastDirector = [...chatMessages].reverse().find((message) => message.role === "director");
    const lastAssistant = [...chatMessages].reverse().find((message) => message.role === "assistant");
    const openDecisionMessage = [...chatMessages].reverse().find((message) =>
      message.actions?.some((action) => action.type === "decision" && action.decision_id && openDecisionIds.has(action.decision_id))
    );
    const unseen = (message: ChatMessage) => !lastSeen || message.ts > lastSeen;
    if (lastDirector && (awaiting || unseen(lastDirector))) ids.add(lastDirector.id);
    if (lastAssistant && unseen(lastAssistant)) ids.add(lastAssistant.id);
    if (openDecisionMessage) ids.add(openDecisionMessage.id);
    return chatMessages.filter((message) => ids.has(message.id));
  }, [chatMessages, decisions, awaiting, lastSeen]);
  const hiddenMessageCount = chatMessages.length - focusedMessages.length;
  const visibleMessages = historyOpen ? chatMessages : focusedMessages;
  const focusedDecisionMessageId = focusedMessages.find((message) =>
    message.actions?.some((action) => action.type === "decision" && action.decision_id && decisions.some((decision) => decision.id === action.decision_id))
  )?.id ?? null;

  // An actionable card should open at its question, not scrolled to its footer.
  // Ordinary replies stay pinned to the newest message.
  useEffect(() => {
    const scroll = scrollRef.current;
    if (!open || !scroll) return;
    if (chatMessages.length === 0 || historyOpen) {
      scroll.scrollTo({ top: 0 });
      return;
    }
    if (focusedDecisionMessageId && chatMessages.at(-1)?.role !== "director") {
      const decision = scroll.querySelector<HTMLElement>(".chat-has-decision");
      if (decision) scroll.scrollTop += decision.getBoundingClientRect().top - scroll.getBoundingClientRect().top;
      return;
    }
    scroll.scrollTo({ top: scroll.scrollHeight });
  }, [visibleMessages, open, historyOpen, focusedDecisionMessageId, chatMessages]);

  if (!open)
    return (
      <button className="chat-fab" title="Message your Chief of staff" aria-label="Message your Chief of staff" onClick={openDrawer}>
        <FontAwesomeIcon icon={faComment} />
      </button>
    );

  return (
    <div className="chat-panel">
      <header className="chat-head">
        <span className="chat-title">Chief of staff</span>
        <div className="chat-head-actions">
          <button className="chat-iconbtn" title="Close" aria-label="Close" onClick={closeDrawer}>
            ✕
          </button>
        </div>
      </header>
      <div className="chat-body">
        <div className="chat-scroll" ref={scrollRef}>
          {hiddenMessageCount > 0 && (
            <button className="chat-history-toggle" onClick={() => setHistoryOpen((current) => !current)}>
              {historyOpen ? "Show current conversation" : `${hiddenMessageCount} earlier ${hiddenMessageCount === 1 ? "message" : "messages"}`}
            </button>
          )}
          {chatMessages.length === 0 && (
            <div className="chat-empty muted">
              {projects.length ? (
                "Ask your Chief of staff to start work, catch you up, or clear a blocker."
              ) : projectsLoaded ? (
                // Only once the list has really landed: an empty list from a
                // failed fetch would greet an established install with
                // first-run onboarding.
                <FirstProject />
              ) : null}
            </div>
          )}
          {visibleMessages.map((m) => (
            <Bubble key={m.id} m={m} />
          ))}
          {(awaiting || deliveryLabel) && <div className="chat-typing muted">{deliveryLabel ?? "Chief of staff is working…"}</div>}
        </div>
        <div className="chat-compose">
          <textarea
            placeholder={projects.length ? "Tell Hive the outcome you want…" : "Add a project to start"}
            value={text}
            disabled={!projects.length}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                send();
              }
            }}
          />
          <button className="btn btn-primary" onClick={send} disabled={sending || !text.trim() || !projects.length}>
            Send
          </button>
        </div>
      </div>
    </div>
  );
}

// A fresh install has nothing to supervise yet: the one thing to do is add a
// repository. Shared by the Home page and the chat drawer.
export function FirstProject() {
  return (
    <div className="manager-project-empty">
      <div className="manager-project-mark" aria-hidden="true">01</div>
      <div>
        <div className="manager-empty-title">Connect your first project.</div>
        <div className="manager-empty-copy">Give Hive one repository. Then your Chief of staff can plan, delegate, and follow the work through.</div>
      </div>
      <Link className="manager-project-cta" to="/projects">Add a project <span aria-hidden="true">→</span></Link>
    </div>
  );
}
