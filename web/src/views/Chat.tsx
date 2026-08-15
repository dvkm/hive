import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { marked } from "marked";
import DOMPurify from "dompurify";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { faComment } from "@fortawesome/free-solid-svg-icons";
import { useStore } from "../lib/store";
import { api } from "../lib/api";
import type { ChatMessage, ChatThread, Event, Project, Task } from "../lib/api";
import { relTime } from "../lib/time";
import { eventText } from "../lib/eventText";
import { STATE_LABEL } from "../lib/labels";
import { StatusDot, toast } from "../lib/ui";

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

const VISIBLE_MANAGER_EVENTS = new Set(["tool_use", "assistant_text", "status", "spawned"]);

function ManagerActivity({
  thread,
  events,
  tasks,
  awaiting,
  project,
  onRefresh,
  onProjectsRefresh,
}: {
  thread: ChatThread | null;
  events: Event[];
  tasks: Task[];
  awaiting: boolean;
  project: Project | undefined;
  onRefresh: () => void;
  onProjectsRefresh: () => void;
}) {
  const taskId = thread?.task_id ?? null;
  const status = String(events.find((e) => e.type === "agent_status")?.payload.status ?? "");
  const working = awaiting || status === "working";
  const [savingProfile, setSavingProfile] = useState(false);
  const [replaying, setReplaying] = useState<string | null>(null);
  const delegated = tasks
    .filter((t) => t.parent_task_id === taskId && t.source !== "chat_supervisor")
    .sort((a, b) => b.updated_at.localeCompare(a.updated_at))
    .slice(0, 6);
  const activity = events.filter((e) => VISIBLE_MANAGER_EVENTS.has(e.type)).slice(0, 5);
  const meeting = thread?.meetings?.[0];
  const verification = thread?.verifications?.[0];
  const retrospective = thread?.retrospectives?.[0];
  const autonomy = project?.config.autonomy_profile ?? "balanced";

  const setAutonomy = async (profile: "conservative" | "balanced" | "autopilot") => {
    if (!project || savingProfile) return;
    setSavingProfile(true);
    try {
      await api.updateProject(project.id, { config: { ...project.config, autonomy_profile: profile } });
      toast(`Autonomy set to ${profile}`);
      onProjectsRefresh();
      onRefresh();
    } catch (e: any) {
      toast(e?.message ?? "Could not update autonomy");
    } finally {
      setSavingProfile(false);
    }
  };

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
    <aside className="manager-activity" aria-label="Manager activity">
      <div className="manager-activity-head">
        <span>Manager activity</span>
        <span className={`manager-live ${working ? "manager-live-working" : ""}`}>
          <span className="manager-live-dot" />
          {!taskId ? "not started" : working ? "working" : "watching"}
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

      <section className="manager-activity-section">
        <h2>Autonomy</h2>
        <select className="manager-autonomy" value={autonomy} disabled={!project || savingProfile} onChange={(e) => setAutonomy(e.target.value as any)}>
          <option value="conservative">Conservative</option>
          <option value="balanced">Balanced</option>
          <option value="autopilot">Autopilot</option>
        </select>
        <p className="manager-autonomy-help">
          {autonomy === "conservative" ? "Plans and delegates. You resolve every checkpoint and decision." : autonomy === "balanced" ? "Handles safe checkpoints and narrow reversible decisions." : "Handles recommended low-risk engineering choices. Guarded actions still require authority."}
        </p>
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
        <h2>Recent actions</h2>
        {activity.length === 0 ? (
          <p className="manager-activity-empty">{taskId ? "Waiting for the next action." : "Start a conversation to create a manager session."}</p>
        ) : (
          <div className="manager-event-list" aria-live="polite">
            {activity.map((e) => (
              <div className="manager-event" key={e.id}>
                <span className="manager-event-dot" />
                <div>
                  <div className="manager-event-text" title={eventText(e)}>{eventText(e)}</div>
                  <time title={e.ts}>{relTime(e.ts)}</time>
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

export default function Chat({ embedded = false }: { embedded?: boolean }) {
  const { projects, reloadProjects, tasks, feedEvents, chatThreadId, chatMessages, openChatThread } = useStore();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [project, setProject] = useState<string>(() => localStorage.getItem(LS_PROJECT) || "");
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [managerTaskId, setManagerTaskId] = useState<string | null>(null);
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
      .then((ts) => {
        const latest = ts[0] ?? null;
        setManagerThread(latest);
        setManagerTaskId(latest?.task_id ?? null);
        openChatThread(latest?.id ?? null);
      })
      .catch(() => {
        setManagerThread(null);
        setManagerTaskId(null);
        openChatThread(null);
      });
  }, [open, project]);

  useEffect(() => {
    if (!open || !chatThreadId) return;
    refreshManager();
    const timer = setInterval(refreshManager, 5_000);
    return () => clearInterval(timer);
  }, [open, chatThreadId, refreshManager]);

  useEffect(() => {
    let live = true;
    if (!managerTaskId) {
      setManagerEvents([]);
      return;
    }
    api.task(managerTaskId).then((d) => live && setManagerEvents(d.events)).catch(() => live && setManagerEvents([]));
    return () => {
      live = false;
    };
  }, [managerTaskId]);

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
      api.chatThread(r.thread_id).then((thread) => { setManagerThread(thread); setManagerTaskId(thread.task_id); }).catch(() => {});
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
    setManagerThread(null);
    setManagerTaskId(null);
    openChatThread(null);
  };

  // Supervisor is thinking whenever the last thing said was the director's.
  const awaiting = chatMessages.length > 0 && chatMessages[chatMessages.length - 1].role === "director";
  const activityEvents = useMemo(() => {
    const rows = new Map(managerEvents.map((e) => [e.id, e]));
    for (const e of feedEvents) if (e.task_id === managerTaskId) rows.set(e.id, e);
    return [...rows.values()].sort((a, b) => b.ts.localeCompare(a.ts));
  }, [managerEvents, feedEvents, managerTaskId]);

  if (!open)
    return (
      <button className="chat-fab" title="Message your Hive manager" aria-label="Message your Hive manager" onClick={() => setDrawerOpen(true)}>
        <FontAwesomeIcon icon={faComment} />
      </button>
    );

  const conversation = (
    <div className={embedded ? "manager-chat" : "chat-panel"}>
      <header className={embedded ? "manager-head" : "chat-head"}>
        {embedded && (
          <div className="manager-heading">
            <div className="manager-eyebrow">Your Hive manager</div>
            <h1>What should the team accomplish?</h1>
            <p>Set the outcome. Your manager plans the work, delegates it, keeps agents moving, and brings back the decisions that need you.</p>
          </div>
        )}
        <select className="chat-proj" value={project} onChange={(e) => setProject(e.target.value)}>
          {projects.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
        <div className="chat-head-actions">
          <button className="chat-iconbtn" title="New conversation" onClick={() => { setManagerThread(null); setManagerTaskId(null); openChatThread(null); }}>
            ✎
          </button>
          {chatThreadId && (
            <button className="chat-iconbtn" title="End this manager session" onClick={closeThread}>
              ⏹
            </button>
          )}
          {!embedded && (
            <button className="chat-iconbtn" title="Close panel" onClick={() => setDrawerOpen(false)}>
              ✕
            </button>
          )}
        </div>
      </header>
      <div className={embedded ? "manager-body" : "chat-body"}>
        <div className={embedded ? "manager-conversation" : undefined}>
          <div className="chat-scroll" ref={scrollRef}>
            {chatMessages.length === 0 && (
              <div className={embedded ? "manager-empty" : "chat-empty muted"}>
                {project ? (
                  embedded ? (
                    <>
                      <div className="manager-empty-title">Start with the result you want.</div>
                      <div className="manager-empty-copy">You can be broad. The manager will turn it into tasks and coordinate the team.</div>
                      <div className="manager-prompts">
                        {["Plan and build the next release", "Check the team and unblock anything stuck", "Summarize progress and tell me what needs my input"].map((prompt) => (
                          <button key={prompt} onClick={() => setText(prompt)}>{prompt}</button>
                        ))}
                      </div>
                    </>
                  ) : (
                    "Ask the manager to start work, check progress, or resolve a blocker."
                  )
                ) : (
                  "Add a project first. The manager works inside a project's repository."
                )}
              </div>
            )}
            {chatMessages.map((m) => (
              <Bubble key={m.id} m={m} />
            ))}
            {awaiting && <div className="chat-typing muted">manager is working…</div>}
          </div>
          <div className="chat-compose">
            <textarea
              placeholder="Tell your manager what outcome you want…"
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
        {embedded && <ManagerActivity thread={managerThread} events={activityEvents} tasks={tasks} awaiting={awaiting} project={projects.find((p) => p.id === project)} onRefresh={refreshManager} onProjectsRefresh={reloadProjects} />}
      </div>
    </div>
  );

  return embedded ? <div className="manager-page">{conversation}</div> : conversation;
}
