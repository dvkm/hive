// Minimal in-process pub/sub for SSE. Every event / state change / decision
// update is broadcast here; the /api/stream endpoint fans it out to clients.
// `app: true` marks the Electron desktop client (it subscribes with
// /api/stream?client=app). Notification delivery needs to tell it apart from
// browser tabs: a tab cannot raise a native macOS notification.
//
// `project` / `classes` are per-client subscription filters (/api/stream
// ?project=&classes=). They live on the client, not on the publisher, so one
// picky subscriber never costs a second pass over the frame.
type Client = {
  id: string;
  send: (data: string) => void;
  app?: boolean;
  project?: string | null;
  classes?: Set<string> | null;
};

const clients = new Set<Client>();

export function addClient(c: Client): void {
  clients.add(c);
}

export function removeClient(c: Client): void {
  clients.delete(c);
}

export function clientCount(): number {
  return clients.size;
}

// How many desktop app clients are attached. Zero means nothing can render a
// native notification right now, so delivery falls back to launching the app.
export function appClientCount(): number {
  let n = 0;
  for (const c of clients) if (c.app) n++;
  return n;
}

// Frames carry a task id under a handful of shapes; a task never changes
// project, so one lookup per task id is enough for the life of the process.
type ProjectResolver = (taskId: string) => string | null;
let resolveProject: ProjectResolver | null = null;
const projectCache = new Map<string, string | null>();

// Wired once at startup with a db-backed lookup. Without it frames simply
// carry no project_id and every filtered client falls back to pass-through
// for scopeless frames, which is the pre-filter behaviour.
export function setProjectResolver(fn: ProjectResolver | null): void {
  resolveProject = fn;
  projectCache.clear();
}

function taskIdOf(msg: any): string | null {
  return (
    msg.task?.id ??
    msg.task_id ??
    msg.event?.task_id ??
    msg.decision?.task_id ??
    msg.notification?.task_id ??
    msg.evidence?.task_id ??
    msg.incident?.task_id ??
    msg.usage?.task_id ??
    msg.message?.task_id ??
    null
  );
}

// The project a frame belongs to, or null when it has no project scope
// (hello, offline, chat_thread, reconciler_error, ...).
export function frameProject(msg: any): string | null {
  if (!msg || typeof msg !== "object") return null;
  const direct = msg.project_id ?? msg.task?.project_id ?? msg.learning?.project_id;
  if (direct) return direct;
  const taskId = taskIdOf(msg);
  if (!taskId || !resolveProject) return null;
  if (!projectCache.has(taskId)) projectCache.set(taskId, resolveProject(taskId));
  return projectCache.get(taskId) ?? null;
}

// msg is a plain object; it is JSON-encoded once and pushed to every client.
// Clients with no filters get the identical frame they got before filtering
// existed, plus the project_id the frame can now name.
export function broadcast(msg: unknown): void {
  const project = frameProject(msg);
  const frame =
    project && msg && typeof msg === "object" && (msg as any).project_id == null
      ? { ...(msg as any), project_id: project }
      : msg;
  const type = (frame as any)?.type;
  const data = JSON.stringify(frame);
  for (const c of clients) {
    if (c.classes && !c.classes.has(type)) continue;
    // A frame with no project scope reaches everyone: it is fleet-wide news.
    if (c.project && project && c.project !== project) continue;
    try {
      c.send(data);
    } catch {
      clients.delete(c);
    }
  }
}
