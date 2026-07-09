import { createContext, useContext, useEffect, useRef, useState } from "react";
import { api } from "./api";
import type { Task, Decision, Project, Notification } from "./api";

export type SseState = "connecting" | "open" | "reconnecting";

interface Store {
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
  sse: SseState;
}

const Ctx = createContext<Store | null>(null);
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
  const [sse, setSse] = useState<SseState>("connecting");
  const bumped = useRef(false);

  const bump = (id: string) => setRev((r) => ({ ...r, [id]: (r[id] || 0) + 1 }));
  const reloadProjects = () => api.projects().then(setProjects).catch(() => setProjects([]));

  // Initial load.
  useEffect(() => {
    api.tasks().then((ts) => {
      setTasks(ts);
      setLastActivity(Object.fromEntries(ts.map((t) => [t.id, t.updated_at])));
      // ponytail: N+1 detail fetch to get evidence counts. Localhost, small N.
      // Add a count column / aggregate endpoint if the board ever gets large.
      ts.forEach((t) =>
        api.task(t.id).then((d) => {
          setEvidenceCount((c) => ({ ...c, [t.id]: d.evidence.length }));
          setSpawnError((s) => ({ ...s, [t.id]: d.events.some((e) => e.type === "spawn_error") && !d.events.some((e) => e.type === "spawned") }));
        })
      );
    });
    api.decisions("open").then(setDecisions);
    reloadProjects();
    api.notifications().then((n) => setNotifications(n.notifications)).catch(() => setNotifications([]));
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
      es = new EventSource(BASE + "/api/stream");
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
          const ev = msg.event;
          setLastActivity((la) => ({ ...la, [ev.task_id]: ev.ts }));
          if (ev.type === "spawn_error") setSpawnError((s) => ({ ...s, [ev.task_id]: true }));
          else if (ev.type === "spawned") setSpawnError((s) => ({ ...s, [ev.task_id]: false }));
          bump(ev.task_id);
        } else if (msg.type === "evidence") {
          const id = msg.evidence.task_id;
          setEvidenceCount((c) => ({ ...c, [id]: (c[id] || 0) + 1 }));
          bump(id);
        } else if (msg.type === "decision") {
          const d: Decision = msg.decision;
          setDecisions((prev) => {
            const rest = prev.filter((x) => x.id !== d.id);
            return d.status === "open" ? [d, ...rest] : rest;
          });
          bump(d.task_id);
        } else if (msg.type === "notification") {
          const n: Notification = msg.notification;
          setNotifications((prev) => (prev.some((x) => x.id === n.id) ? prev : [n, ...prev]));
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
    <Ctx.Provider value={{ tasks, projects, reloadProjects, decisions, notifications, ackNotifications, evidenceCount, spawnError, lastActivity, rev, sse }}>
      {children}
    </Ctx.Provider>
  );
}
