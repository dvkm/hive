import { createContext, useContext, useEffect, useRef, useState } from "react";
import { api, apiToken } from "./api";
import type { Task, Decision, Project, Notification, Event, Evidence, Incident, Checkpoint, UnderstandingQuiz, ChatMessage } from "./api";
import { getNeedsYouItems } from "./needsYou";
import type { NeedsYouItem } from "./needsYou";

export type SseState = "connecting" | "open" | "reconnecting";

export interface Store {
  tasks: Task[];
  projects: Project[]; // unarchived, shared across board/policies/new-task
  reloadProjects: () => void; // refresh after a project is created/edited/archived
  decisions: Decision[]; // open only
  notifications: Notification[]; // newest first
  ackNotifications: () => void;
  evidenceCount: Record<string, number>;
  spawnError: Record<string, boolean>; // task has a spawn_error and no later spawned
  lastActivity: Record<string, string>; // ts of most-recent event per task
  rev: Record<string, number>; // bumps when a task is touched (task pages refetch on change)
  feedEvents: Event[]; // live events for the activity feed, newest first (capped)
  evidenceMeta: Record<string, { url: string | null; kind: Evidence["kind"] }>; // by evidence id, for live feed thumbnails
  checkpoints: Checkpoint[]; // open (un-acked) build-time checkpoints, all tasks
  reloadCheckpoints: () => void;
  quizzes: UnderstandingQuiz[]; // required or deferred understanding checks
  reloadQuizzes: () => void;
  needsYou: NeedsYouItem[];
  offline: boolean; // offline mode: fleet drained, nothing new spawns
  setOffline: (on: boolean) => void;
  sse: SseState;
  // Director chat (persistent supervisor session). Only the open thread's
  // messages are held; SSE appends live as the supervisor replies.
  chatThreadId: string | null;
  chatMessages: ChatMessage[];
  // Transient delivery status of the open thread's newest turn
  // ("queued"|"delivering"|"spawning"|"delivered"|"spawned"|"failed"). Pushed
  // over SSE while the turn is in flight; null once the supervisor answers.
  chatDelivery: string | null;
  openChatThread: (id: string | null) => void;
  // Fan-out for EVERY incoming chat message regardless of the open thread —
  // the Supervisors board runs one live column per thread. Returns unsubscribe.
  onChatMessage: (cb: (m: ChatMessage) => void) => () => void;
}

const FEED_CAP = 400;

// Exported so tests can provide a fake Store without mounting the real
// StoreProvider (which opens a live EventSource and hits every api.* on load).
export const Ctx = createContext<Store | null>(null);
export const useStore = () => {
  const s = useContext(Ctx);
  if (!s) throw new Error("useStore outside provider");
  return s;
};

const BASE = import.meta.env.VITE_HIVE_URL || "";

export function StoreProvider({ children }: { children: React.ReactNode }) {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [decisions, setDecisions] = useState<Decision[]>([]);
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const [evidenceCount, setEvidenceCount] = useState<Record<string, number>>({});
  const [spawnError, setSpawnError] = useState<Record<string, boolean>>({});
  const [lastActivity, setLastActivity] = useState<Record<string, string>>({});
  const [rev, setRev] = useState<Record<string, number>>({});
  const [feedEvents, setFeedEvents] = useState<Event[]>([]);
  const [evidenceMeta, setEvidenceMeta] = useState<Record<string, { url: string | null; kind: Evidence["kind"] }>>({});
  const [sse, setSse] = useState<SseState>("connecting");
  const bumped = useRef(false);

  const bump = (id: string) => setRev((r) => ({ ...r, [id]: (r[id] || 0) + 1 }));
  const reloadProjects = () => api.projects().then(setProjects).catch(() => setProjects([]));
  const [checkpoints, setCheckpoints] = useState<Checkpoint[]>([]);
  const [quizzes, setQuizzes] = useState<UnderstandingQuiz[]>([]);
  const needsYou = getNeedsYouItems(decisions, tasks, checkpoints, quizzes);
  const [offline, setOfflineState] = useState(false);
  const setOffline = (on: boolean) => {
    setOfflineState(on); // optimistic; SSE confirms
    api.setOffline(on).catch(() => setOfflineState(!on));
  };
  const reloadCheckpoints = () => api.checkpoints().then((r) => setCheckpoints(r.checkpoints)).catch(() => {});
  const reloadQuizzes = () => api.understandingQuizzes().then((r) => setQuizzes(r.quizzes)).catch(() => {});

  // Chat: the open thread + its messages. A ref mirrors the id so the SSE
  // handler (closed over once) knows which thread's messages to append.
  const [chatThreadId, setChatThreadId] = useState<string | null>(null);
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const [chatDelivery, setChatDelivery] = useState<string | null>(null);
  const chatThreadRef = useRef<string | null>(null);
  const hydrateChatDecisions = (messages: ChatMessage[]) => {
    const decisionIds = new Set(
      messages.flatMap((message) => message.actions)
        .filter((action) => action.type === "decision" && typeof action.decision_id === "string")
        .map((action) => action.decision_id as string)
    );
    if (decisionIds.size)
      api.decisions("open").then((open) => setDecisions((prev) => [
        ...open.filter((decision) => decisionIds.has(decision.id)),
        ...prev.filter((decision) => !decisionIds.has(decision.id)),
      ])).catch(() => {});
  };
  const openChatThread = (id: string | null) => {
    chatThreadRef.current = id;
    setChatThreadId(id);
    setChatDelivery(null);
    if (id) api.chatThread(id).then((t) => {
      setChatMessages(t.messages);
      hydrateChatDecisions(t.messages);
    }).catch(() => setChatMessages([]));
    else setChatMessages([]);
  };
  const chatSubs = useRef(new Set<(m: ChatMessage) => void>());
  const onChatMessage = (cb: (m: ChatMessage) => void) => {
    chatSubs.current.add(cb);
    return () => void chatSubs.current.delete(cb);
  };

  // Initial load.
  useEffect(() => {
    let fresh = false;
    const loadTasks = (ts: Task[]) => {
      setTasks(ts);
      setLastActivity(Object.fromEntries(ts.map((t) => [t.id, t.updated_at])));
      setEvidenceCount(Object.fromEntries(ts.map((t) => [t.id, t.evidence_count ?? 0])));
      setSpawnError(Object.fromEntries(ts.map((t) => [t.id, t.spawn_error ?? false])));
    };
    api.cachedTasks().then((ts) => { if (ts && !fresh) loadTasks(ts); });
    api.tasks().then((ts) => { fresh = true; loadTasks(ts); });
    api.decisions("open").then(setDecisions);
    reloadCheckpoints();
    reloadQuizzes();
    api.offline().then((r) => setOfflineState(r.on)).catch(() => {});
    reloadProjects();
    api.notifications().then((n) => setNotifications(n.notifications)).catch(() => setNotifications([]));
    return () => { fresh = true; };
  }, []);

  // Mark all as read: optimistic local update + server ack.
  const ackNotifications = () => {
    setNotifications((ns) => ns.map((n) => (n.delivered_at ? n : { ...n, delivered_at: new Date().toISOString() })));
    api.ackNotifications().catch(() => {});
  };

  // SSE. Auto-reconnects (EventSource does this natively; we just reflect state).
  useEffect(() => {
    let es: EventSource;
    let closed = false;
    const connect = () => {
      // EventSource cannot set headers; remote (token-gated) access rides the
      // query param the server accepts for exactly this reason.
      const token = apiToken();
      es = new EventSource(BASE + "/api/stream" + (token ? `?token=${encodeURIComponent(token)}` : ""));
      es.onopen = () => setSse("open");
      es.onerror = () => {
        if (!closed) setSse("reconnecting");
      };
      es.onmessage = (m) => {
        let msg: any;
        try {
          msg = JSON.parse(m.data);
        } catch {
          return;
        }
        if (msg.type === "task") {
          const t: Task = msg.task;
          setTasks((prev) => {
            const i = prev.findIndex((x) => x.id === t.id);
            if (i === -1) return [t, ...prev];
            const next = prev.slice();
            next[i] = t;
            return next;
          });
          setLastActivity((la) => ({ ...la, [t.id]: t.updated_at }));
          bump(t.id);
        } else if (msg.type === "event") {
          const ev: Event = msg.event;
          setLastActivity((la) => ({ ...la, [ev.task_id]: ev.ts }));
          setFeedEvents((prev) => [ev, ...prev].slice(0, FEED_CAP));
          if (ev.type === "spawn_error") setSpawnError((s) => ({ ...s, [ev.task_id]: true }));
          else if (ev.type === "spawned") setSpawnError((s) => ({ ...s, [ev.task_id]: false }));
          // Live checkbox list: any checkpoint activity refreshes the open set.
          if (ev.type === "checkpoint" || ev.type === "checkpoint_ack")
            api.checkpoints().then((r) => setCheckpoints(r.checkpoints)).catch(() => {});
          if (["review_summary", "understanding_quiz_attempt", "understanding_quiz_passed", "understanding_quiz_deferred"].includes(ev.type))
            api.understandingQuizzes().then((r) => setQuizzes(r.quizzes)).catch(() => {});
          bump(ev.task_id);
        } else if (msg.type === "evidence") {
          const evi: Evidence = msg.evidence;
          const id = evi.task_id;
          setEvidenceCount((c) => ({ ...c, [id]: (c[id] || 0) + 1 }));
          if (evi.id) setEvidenceMeta((m) => ({ ...m, [evi.id]: { url: evi.url, kind: evi.kind } }));
          bump(id);
        } else if (msg.type === "decision") {
          const d: Decision = msg.decision;
          setDecisions((prev) => {
            const rest = prev.filter((x) => x.id !== d.id);
            return d.status === "open" ? [d, ...rest] : rest;
          });
          bump(d.task_id);
        } else if (msg.type === "usage") {
          bump(msg.usage.task_id);
        } else if (msg.type === "incident") {
          // Fold standalone monitor incidents into the live feed as a synthetic
          // "incident" event (no task_id). The Feed enriches it from projects.
          const inc: Incident = msg.incident;
          const synthetic: Event = {
            id: inc.id + ":" + inc.status,
            task_id: "",
            ts: inc.ts,
            source: "monitor",
            type: "incident",
            payload: { monitor: inc.monitor, status: inc.status, detail: inc.detail, project_id: inc.project_id },
          };
          setFeedEvents((prev) => [synthetic, ...prev].slice(0, FEED_CAP));
        } else if (msg.type === "offline") {
          setOfflineState(!!msg.on);
        } else if (msg.type === "notification") {
          const n: Notification = msg.notification;
          setNotifications((prev) => (prev.some((x) => x.id === n.id) ? prev : [n, ...prev]));
        } else if (msg.type === "chat_message") {
          const cm: ChatMessage = msg.message;
          hydrateChatDecisions([cm]);
          if (cm.thread_id === chatThreadRef.current) {
            setChatMessages((prev) => (prev.some((m) => m.id === cm.id) ? prev : [...prev, cm]));
            if (cm.role === "assistant") setChatDelivery(null); // the supervisor answered
          }
          chatSubs.current.forEach((cb) => cb(cm));
        } else if (msg.type === "chat_delivery") {
          if (msg.thread_id === chatThreadRef.current) setChatDelivery(String(msg.status));
        }
      };
    };
    if (!bumped.current) {
      bumped.current = true;
      connect();
    }
    return () => {
      closed = true;
      es?.close();
    };
  }, []);

  return (
    <Ctx.Provider value={{ tasks, projects, reloadProjects, decisions, notifications, ackNotifications, evidenceCount, spawnError, lastActivity, rev, feedEvents, evidenceMeta, checkpoints, reloadCheckpoints, quizzes, reloadQuizzes, needsYou, offline, setOffline, sse, chatThreadId, chatMessages, chatDelivery, openChatThread, onChatMessage }}>
      {children}
    </Ctx.Provider>
  );
}
