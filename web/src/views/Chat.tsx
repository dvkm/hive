import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { marked } from "marked";
import DOMPurify from "dompurify";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { faComment } from "@fortawesome/free-solid-svg-icons";
import { useStore } from "../lib/store";
import { api } from "../lib/api";
import type { Brief, ChatMessage, ChatThread, Decision, Event, Task } from "../lib/api";
import { relTime } from "../lib/time";
import { eventText } from "../lib/eventText";
import { STATE_LABEL } from "../lib/labels";
import { StatusDot, toast } from "../lib/ui";
import { DecisionCard } from "./DecisionCard";

// One portfolio-wide Chief of Staff conversation appears on the home route and
// in a persistent drawer elsewhere. Its replies and the director's echoed
// messages arrive live over SSE; detailed supervisor activity stays behind the
// home view's progressive disclosure.

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
    <div className={`chat-msg chat-${m.role}${hasDecision ? " chat-has-decision" : ""}`}>
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

const VISIBLE_MANAGER_EVENTS = new Set([
  "steer",
  "spawned",
  "agent_status",
  "assistant_text",
  "tool_use",
  "agent_turn_end",
  "needs-decision",
  "auto_approved",
  "auto_approve_declined",
  "spawn_error",
  "steer_error",
]);

function ManagerActivity({
  thread,
  events,
  tasks,
  awaiting,
  managerTask,
  onRefresh,
}: {
  thread: ChatThread | null;
  events: Event[];
  tasks: Task[];
  awaiting: boolean;
  managerTask: Task | null;
  onRefresh: () => void;
}) {
  const taskId = thread?.task_id ?? null;
  const status = String(events.find((e) => e.type === "agent_status")?.payload.status ?? "");
  const stopped = !!managerTask && ["done", "failed", "cancelled"].includes(managerTask.state);
  const working = !stopped && (awaiting || status === "working");
  const [replaying, setReplaying] = useState<string | null>(null);
  const delegated = (taskId ? tasks.filter((t) => t.parent_task_id === taskId && t.source !== "chat_supervisor") : [])
    .sort((a, b) => b.updated_at.localeCompare(a.updated_at))
    .slice(0, 6);
  const activity = events.filter((e) => VISIBLE_MANAGER_EVENTS.has(e.type)).slice(0, 12);
  const meeting = thread?.meetings?.[0];
  const verification = thread?.verifications?.[0];
  const retrospective = thread?.retrospectives?.[0];

  const replay = async () => {
    if (!thread || !verification || replaying) return;
    setReplaying(verification.event_id);
    try {
      const result = await api.replayVerification(thread.id, verification.event_id);
      if (result.delivery === "failed") toast(result.error ?? "Could not wake the manager");
      else toast("Verification replay queued");
      onRefresh();
    } catch (e: any) {
      toast(e?.message ?? "Could not replay verification");
    } finally {
      setReplaying(null);
    }
  };

  return (
    <aside className="manager-activity" aria-label="Chief of Staff activity">
      <div className="manager-activity-head">
        <span>Chief of Staff activity</span>
        <span className={`manager-live ${working ? "manager-live-working" : ""}`}>
          <span className="manager-live-dot" />
          {!taskId ? "not started" : stopped ? "stopped" : working ? "working" : "watching"}
        </span>
      </div>

      <section className="manager-activity-section manager-run-section">
        <div className="manager-section-title">
          <h2>Run ledger</h2>
          {thread && <span className={`manager-phase manager-phase-${thread.phase}`}>{thread.phase}</span>}
        </div>
        {!thread ? (
          <p className="manager-activity-empty">The ledger starts with your first message.</p>
        ) : (
          <div className="manager-run-ledger">
            <div className="manager-run-field">
              <span>Objective</span>
              <p>{thread.objective || "Manager is defining the outcome."}</p>
            </div>
            {!!thread.acceptance_criteria.length && (
              <div className="manager-run-field">
                <span>Success means</span>
                <ul>{thread.acceptance_criteria.map((criterion, i) => <li key={i}>{criterion}</li>)}</ul>
              </div>
            )}
            {thread.next_action && <div className="manager-run-field"><span>Next</span><p>{thread.next_action}</p></div>}
            {thread.waiting_on && <div className="manager-run-field manager-run-waiting"><span>Waiting on</span><p>{thread.waiting_on}</p></div>}
            {thread.outcome && <div className="manager-run-field"><span>Outcome</span><p>{thread.outcome}</p></div>}
          </div>
        )}
      </section>

      {(meeting || verification || retrospective) && (
        <section className="manager-activity-section manager-records">
          <h2>Management record</h2>
          {meeting && (
            <div className="manager-record">
              <div className="manager-record-head"><span>Meeting</span><b>{meeting.stage}</b></div>
              <p>{meeting.topic}</p>
              {meeting.decision && <small>Decision: {meeting.decision}</small>}
            </div>
          )}
          {verification && (
            <div className={`manager-record manager-verification-${verification.status}`}>
              <div className="manager-record-head"><span>Verification</span><b>{verification.status}</b></div>
              <p>{verification.method}</p>
              {verification.result && <small>{verification.result}</small>}
              {verification.status !== "started" && (
                <button className="link-btn" disabled={!!replaying} onClick={replay}>{replaying ? "replaying…" : "Replay this check"}</button>
              )}
            </div>
          )}
          {retrospective && (
            <div className="manager-record">
              <div className="manager-record-head"><span>Retrospective</span></div>
              <p>{retrospective.summary}</p>
            </div>
          )}
        </section>
      )}

      <section className="manager-activity-section">
        <h2>Trajectory</h2>
        {activity.length === 0 ? (
          <p className="manager-activity-empty">{taskId ? "Waiting for the next action." : "Start a conversation to create a manager session."}</p>
        ) : (
          <div className="manager-event-list" aria-live="polite">
            {activity.map((e) => (
              <div className="manager-event" key={e.id}>
                <span className="manager-event-dot" />
                <div>
                  <div className="manager-event-text" title={eventText(e)}>{eventText(e)}</div>
                  <div className="manager-event-meta"><span>{e.type.replace(/[_-]+/g, " ")}</span><time title={e.ts}>{relTime(e.ts)}</time></div>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="manager-activity-section manager-work-section">
        <h2>Delegated work <span>{delegated.length || ""}</span></h2>
        {delegated.length === 0 ? (
          <p className="manager-activity-empty">No work delegated yet.</p>
        ) : (
          <div className="manager-work-list">
            {delegated.map((task) => (
              <Link to={`/tasks/${task.id}`} className="manager-work" key={task.id}>
                <StatusDot state={task.state} health={task.health} />
                <span className="manager-work-title">{task.title}</span>
                <span className="manager-work-state">{STATE_LABEL[task.state]}</span>
              </Link>
            ))}
          </div>
        )}
      </section>
    </aside>
  );
}

function ChiefBriefing({
  thread,
  awaiting,
  managerTask,
}: {
  thread: ChatThread | null;
  awaiting: boolean;
  managerTask: Task | null;
}) {
  const { tasks } = useStore();
  const [since] = useState(() => localStorage.getItem(CHIEF_LAST_SEEN));
  const [brief, setBrief] = useState<Brief | null>(null);
  useEffect(() => {
    let live = true;
    api.morningBrief(since ?? undefined).then((result) => live && setBrief(result)).catch(() => live && setBrief(null));
    localStorage.setItem(CHIEF_LAST_SEEN, new Date().toISOString());
    return () => {
      live = false;
    };
  }, [since]);

  const attentionCount = brief?.director_required_task_ids.length ?? 0;
  const working = tasks.filter((task) => task.source !== "chat_supervisor" && ["in_progress", "needs_decision", "in_review", "verifying"].includes(task.state));
  const finishedCount = since ? brief?.done.length ?? 0 : 0;
  const stopped = !!managerTask && ["done", "failed", "cancelled"].includes(managerTask.state);
  const headline = !brief
    ? "Getting you caught up…"
    : attentionCount > 0
      ? `${attentionCount} ${attentionCount === 1 ? "decision needs" : "decisions need"} your call.`
      : awaiting
        ? "Hive is handling it."
        : "You're caught up.";
  const detail = attentionCount > 0
    ? "Everything else keeps moving while your Chief waits for this decision."
    : thread?.next_action || thread?.outcome || thread?.objective || "Tell Hive the outcome you want. Your Chief of Staff will coordinate the rest.";

  return (
    <section className="chief-briefing" aria-label="Re-entry briefing">
      <div className="chief-briefing-copy">
        <div className="manager-eyebrow">Briefing</div>
        <h2>{headline}</h2>
        <p>{detail}</p>
      </div>
      <div className="chief-briefing-foot">
        <div className="chief-briefing-facts">
          {attentionCount > 0 && <Link to="/inbox">Review {attentionCount === 1 ? "decision" : "decisions"}</Link>}
          <Link to="/work">{working.length} in motion</Link>
          {finishedCount > 0 && <span>{finishedCount} finished</span>}
        </div>
        <div className={`chief-status ${awaiting ? "chief-status-working" : ""}`}>
          <span className="manager-live-dot" />
          {!thread ? "Ready" : stopped ? "Stopped" : awaiting ? "Working" : "Watching"}
        </div>
      </div>
    </section>
  );
}

export default function Chat({ embedded = false }: { embedded?: boolean }) {
  const { projects, tasks, decisions, feedEvents, chatThreadId, chatMessages, openChatThread } = useStore();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [managerTaskId, setManagerTaskId] = useState<string | null>(null);
  const [managerTask, setManagerTask] = useState<Task | null>(null);
  const [managerThread, setManagerThread] = useState<ChatThread | null>(null);
  const [managerEvents, setManagerEvents] = useState<Event[]>([]);
  const scrollRef = useRef<HTMLDivElement>(null);
  const open = embedded || drawerOpen;

  const refreshManager = useCallback(() => {
    if (!chatThreadId) return;
    api.chatThread(chatThreadId).then((thread) => {
      setManagerThread(thread);
      setManagerTaskId(thread.task_id);
    }).catch(() => {});
  }, [chatThreadId]);

  // There is one durable Chief of Staff thread across every project. Reopen it
  // wherever the panel appears so switching pages never switches managers.
  useEffect(() => {
    if (!open || !projects.length) return;
    api
      .chatThreads()
      .then((ts) => {
        const latest = ts.find((thread) => !thread.project_id) ?? null;
        setManagerThread(latest);
        setManagerTaskId(latest?.task_id ?? null);
        openChatThread(latest?.id ?? null);
      })
      .catch(() => {
        setManagerThread(null);
        setManagerTaskId(null);
        openChatThread(null);
      });
  }, [open, projects.length]);

  useEffect(() => {
    if (!open || !chatThreadId) return;
    refreshManager();
    const timer = setInterval(refreshManager, 5_000);
    return () => clearInterval(timer);
  }, [open, chatThreadId, refreshManager]);

  useEffect(() => {
    let live = true;
    if (!managerTaskId) {
      setManagerTask(null);
      setManagerEvents([]);
      return;
    }
    api.task(managerTaskId).then((d) => {
      if (!live) return;
      setManagerTask(d);
      setManagerEvents(d.events);
    }).catch(() => {
      if (!live) return;
      setManagerTask(null);
      setManagerEvents([]);
    });
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
      if (r.delivery === "failed") toast(`Chief of Staff unavailable: ${r.error ?? "spawn failed"}`);
      // First message of a new thread: adopt the id so SSE replies land here.
      if (r.thread_id !== chatThreadId) openChatThread(r.thread_id);
      api.chatThread(r.thread_id).then((thread) => { setManagerThread(thread); setManagerTaskId(thread.task_id); }).catch(() => {});
    } catch (e: any) {
      toast(`Chat failed: ${e?.message ?? e}`);
      setText(body); // don't eat the message on a hard failure
    } finally {
      setSending(false);
    }
  };

  // Supervisor is thinking whenever the last thing said was the director's.
  const managerStopped = !!managerTask && ["done", "failed", "cancelled"].includes(managerTask.state);
  const awaiting = !managerStopped && chatMessages.length > 0 && chatMessages[chatMessages.length - 1].role === "director";
  const activityEvents = useMemo(() => {
    const rows = new Map(managerEvents.map((e) => [e.id, e]));
    for (const e of feedEvents) if (e.task_id === managerTaskId) rows.set(e.id, e);
    return [...rows.values()].sort((a, b) => b.ts.localeCompare(a.ts));
  }, [managerEvents, feedEvents, managerTaskId]);
  const focusedMessages = useMemo(() => {
    const openDecisionIds = new Set(decisions.map((decision) => decision.id));
    const ids = new Set<string>();
    const lastDirector = [...chatMessages].reverse().find((message) => message.role === "director");
    const lastAssistant = [...chatMessages].reverse().find((message) => message.role === "assistant");
    const openDecisionMessage = [...chatMessages].reverse().find((message) =>
      message.actions?.some((action) => action.type === "decision" && action.decision_id && openDecisionIds.has(action.decision_id))
    );
    if (lastDirector) ids.add(lastDirector.id);
    if (lastAssistant) ids.add(lastAssistant.id);
    if (openDecisionMessage) ids.add(openDecisionMessage.id);
    return chatMessages.filter((message) => ids.has(message.id));
  }, [chatMessages, decisions]);
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
    if (historyOpen) {
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
      <button className="chat-fab" title="Message your Chief of Staff" aria-label="Message your Chief of Staff" onClick={() => setDrawerOpen(true)}>
        <FontAwesomeIcon icon={faComment} />
      </button>
    );

  const conversation = (
    <div className={embedded ? "manager-chat" : "chat-panel"}>
      <header className={embedded ? "manager-head" : "chat-head"}>
        {embedded && (
          <div className="manager-heading">
            <div>
              <div className="manager-eyebrow">Chief of Staff</div>
              <h1>{awaiting ? "Working on it." : "What should Hive handle?"}</h1>
            </div>
            <div className={`chief-presence ${awaiting ? "chief-presence-working" : ""}`}>
              <span className="manager-live-dot" />
              {awaiting ? "Coordinating" : "Ready"}
            </div>
          </div>
        )}
        <div className="chat-head-actions">
          {!embedded && (
            <button className="chat-iconbtn" title="Close panel" onClick={() => setDrawerOpen(false)}>
              ✕
            </button>
          )}
        </div>
      </header>
      <div className={embedded ? "manager-body" : "chat-body"}>
        {embedded && <ChiefBriefing thread={managerThread} awaiting={awaiting} managerTask={managerTask} />}
        <div className={embedded ? "manager-conversation" : undefined}>
          <div className="chat-scroll" ref={scrollRef}>
            {hiddenMessageCount > 0 && (
              <button className="chat-history-toggle" onClick={() => setHistoryOpen((current) => !current)}>
                {historyOpen ? "Show current conversation" : `${hiddenMessageCount} earlier ${hiddenMessageCount === 1 ? "message" : "messages"}`}
              </button>
            )}
            {chatMessages.length === 0 && (
              <div className={embedded ? "manager-empty" : "chat-empty muted"}>
                {projects.length ? (
                  embedded ? (
                    <>
                      <div className="manager-empty-title">Start with the result you want.</div>
                      <div className="manager-empty-copy">You can stay high level. Your Chief of Staff will recover context, route the work, and follow through.</div>
                      <div className="manager-prompts">
                        {["Give me the brief", "Handle the low-risk work", "What needs my decision?"].map((prompt) => (
                          <button key={prompt} onClick={() => setText(prompt)}>{prompt}</button>
                        ))}
                      </div>
                    </>
                  ) : (
                    "Ask your Chief of Staff to start work, catch you up, or resolve a blocker."
                  )
                ) : (
                  "Add a project first. The Chief of Staff needs one repository to run from."
                )}
              </div>
            )}
            {visibleMessages.map((m) => (
              <Bubble key={m.id} m={m} />
            ))}
            {awaiting && <div className="chat-typing muted">manager is working…</div>}
          </div>
          <div className="chat-compose">
            <textarea
              placeholder="Tell Hive the outcome you want…"
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
        {embedded && (
          <details className="chief-details">
            <summary>Activity and agent details</summary>
            <ManagerActivity thread={managerThread} events={activityEvents} tasks={tasks} awaiting={awaiting} managerTask={managerTask} onRefresh={refreshManager} />
          </details>
        )}
      </div>
    </div>
  );

  return embedded ? <div className="manager-page">{conversation}</div> : conversation;
}
