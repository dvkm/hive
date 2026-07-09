import { useEffect, useState } from "react";
import { Link, useLocation } from "react-router-dom";
import { api } from "../lib/api";
import { useStore } from "../lib/store";
import type { Health, Kind, State, Task } from "../lib/api";
import { CiBadge, HEALTH_LABEL, STATE_LABEL, StatusDot, toast } from "../lib/ui";
import { useRelTime } from "../lib/time";

// A compact "why this card needs attention" line: e.g. "agent gone" or
// "no activity 22m". Server-provided reason + live-ticking since-age.
function HealthLine({ health }: { health: Health }) {
  const age = useRelTime(health.since);
  const text = health.status === "dead" ? "agent gone" : `${health.reason || HEALTH_LABEL[health.status]} ${age}`;
  return <div className={`card-attn attn-${health.status}`}>{text}</div>;
}

const COLUMNS: State[] = [
  "queued",
  "in_progress",
  "needs_decision",
  "in_review",
  "verifying",
  "done",
];

function Card({ task }: { task: Task }) {
  const { projects, evidenceCount, spawnError, lastActivity } = useStore();
  const project = projects.find((p) => p.id === task.project_id);
  const age = useRelTime(lastActivity[task.id] || task.updated_at);
  const ev = evidenceCount[task.id];
  const location = useLocation();
  const [dispatching, setDispatching] = useState(false);

  const dispatch = async (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (dispatching) return;
    setDispatching(true);
    try {
      await api.spawn(task.id);
      toast("Agent dispatched");
    } catch (err) {
      toast((err as Error).message);
      setDispatching(false);
    }
  };

  const viewAgent = async (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    try {
      const r = await api.focusAgent(task.id);
      toast(r.ok ? "Focused agent tab in herdr" : `Can't focus: ${r.error}`);
    } catch (err) {
      toast((err as Error).message);
    }
  };

  const health = task.health;
  const unhealthy = health && health.status !== "healthy";

  return (
    <Link to={`/tasks/${task.id}`} state={{ backgroundLocation: location }} className="card">
      <div className="card-top">
        <StatusDot state={task.state} health={task.health} />
        <span className="card-title">{task.title}</span>
      </div>
      {unhealthy && <HealthLine health={health!} />}
      <div className="card-meta">
        {project && <span className="chip">{project.name}</span>}
        <span className={`chip chip-kind chip-${task.kind}`}>{task.kind}</span>
        {task.source === "intake_gchat" && (
          <span className="chip chip-intake" title="Created from a Google Chat message; needs review">
            intake · unreviewed
          </span>
        )}
        {task.source === "planner" && (
          <span className="chip chip-planned" title="Created from an approved planner breakdown">
            planned
          </span>
        )}
        {task.state === "queued" && spawnError[task.id] && (
          <span className="chip chip-error" title="A previous spawn failed; see the task timeline">
            ⚠ spawn failed
          </span>
        )}
        <span className="card-age">{age}</span>
      </div>
      {task.summary && <div className="card-summary">{task.summary}</div>}
      <div className="card-foot">
        {task.state === "queued" && (
          <button className="btn btn-mini" onClick={dispatch} disabled={dispatching} title="Spawn an agent for this task now">
            {dispatching ? "dispatching…" : "dispatch now"}
          </button>
        )}
        {task.agent_target && task.state === "in_progress" && (
          <button className="btn btn-mini" onClick={viewAgent} title="Focus this agent's tab in herdr">
            view agent
          </button>
        )}
        {task.pr_url && (
          <a
            className="pr"
            href={task.pr_url}
            target="_blank"
            rel="noreferrer"
            onClick={(e) => e.stopPropagation()}
          >
            PR
          </a>
        )}
        <CiBadge status={task.ci_status} />
        {ev != null && ev > 0 && <span className="evc" title="evidence items">◱ {ev}</span>}
      </div>
    </Link>
  );
}

const PROJECT_FILTER_KEY = "hive.board.project";

// Attention-tray eligibility — mirrors the server's needsAttention() rule.
function needsAttention(t: Task): boolean {
  if (t.state === "failed") return true;
  return !!t.health && (t.health.status === "dead" || t.health.status === "stuck");
}

// One compact tray row for a FAILED task awaiting human triage. Failed tasks are
// not a board column, so without this tray they vanish entirely.
function FailedRow({ task }: { task: Task }) {
  const { projects } = useStore();
  const project = projects.find((p) => p.id === task.project_id);
  const age = useRelTime(task.updated_at);
  const [editing, setEditing] = useState(false);
  const act = async (fn: () => Promise<unknown>, msg: string) => {
    try {
      await fn();
      toast(msg);
    } catch (e) {
      toast((e as Error).message);
    }
  };
  return (
    <div className="attn-row">
      <span className="sdot sdot-failed" />
      <Link to={`/tasks/${task.id}`} className="attn-title">
        {task.title}
      </Link>
      {project && <span className="chip">{project.name}</span>}
      <span className="attn-reason">{task.summary || "failed — awaiting triage"}</span>
      <span className="attn-age">{age}</span>
      <div className="attn-actions">
        <button className="btn btn-mini" onClick={() => act(() => api.transition(task.id, "queued", "requeued"), "Re-queued")}>
          Requeue
        </button>
        <button className="btn btn-mini" onClick={() => setEditing(true)}>
          Edit &amp; requeue
        </button>
        <button className="btn btn-mini btn-danger" onClick={() => act(() => api.transition(task.id, "cancelled", "dismissed from tray"), "Cancelled")}>
          Cancel
        </button>
      </div>
      {editing && <EditRequeueModal task={task} onClose={() => setEditing(false)} />}
    </div>
  );
}

// One compact tray row for a live task whose agent is dead/stuck.
function UnhealthyRow({ task }: { task: Task }) {
  const { projects } = useStore();
  const project = projects.find((p) => p.id === task.project_id);
  const age = useRelTime(task.health?.since || task.updated_at);
  const act = async (fn: () => Promise<unknown>, msg: string) => {
    try {
      await fn();
      toast(msg);
    } catch (e) {
      toast((e as Error).message);
    }
  };
  const h = task.health!;
  return (
    <div className="attn-row">
      <StatusDot state={task.state} health={task.health} />
      <Link to={`/tasks/${task.id}`} className="attn-title">
        {task.title}
      </Link>
      {project && <span className="chip">{project.name}</span>}
      <span className={`attn-reason attn-${h.status}`}>{h.reason || HEALTH_LABEL[h.status]}</span>
      <span className="attn-age">{age}</span>
      <div className="attn-actions">
        {task.agent_target && (
          <button className="btn btn-mini" onClick={() => act(async () => { const r = await api.focusAgent(task.id); if (!r.ok) throw new Error(r.error); }, "Focused agent tab")}>
            View agent
          </button>
        )}
        {task.agent_target && (
          <button className="btn btn-mini" onClick={() => act(() => api.send(task.id, "hive: status? Reply with what you're doing or what's blocking you."), "Nudge sent")}>
            Nudge
          </button>
        )}
        <button className="btn btn-mini btn-danger" onClick={() => act(() => api.requeue(task.id), "Failed & requeued")}>
          Fail + requeue
        </button>
      </div>
    </div>
  );
}

// Small modal: edit a failed task's brief/title, then re-queue it.
function EditRequeueModal({ task, onClose }: { task: Task; onClose: () => void }) {
  const [title, setTitle] = useState(task.title);
  const [brief, setBrief] = useState(task.brief || "");
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    if (!title.trim() || busy) return;
    setBusy(true);
    try {
      await api.updateTask(task.id, { title: title.trim(), brief });
      await api.transition(task.id, "queued", "edited & requeued");
      toast("Edited & re-queued");
      onClose();
    } catch (e) {
      toast((e as Error).message);
      setBusy(false);
    }
  };
  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div className="modal" onMouseDown={(e) => e.stopPropagation()} onKeyDown={(e) => e.key === "Escape" && onClose()}>
        <h2>Edit &amp; requeue</h2>
        <label className="fld">
          <span>Title</span>
          <input autoFocus value={title} onChange={(e) => setTitle(e.target.value)} />
        </label>
        <label className="fld">
          <span>Brief</span>
          <textarea value={brief} onChange={(e) => setBrief(e.target.value)} />
        </label>
        <div className="modal-foot">
          <span className="muted modal-hint">Saves the brief, then re-queues</span>
          <div className="spacer" />
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary" disabled={busy || !title.trim()} onClick={submit}>
            {busy ? "Requeuing…" : "Save & requeue"}
          </button>
        </div>
      </div>
    </div>
  );
}

// Collapsed when empty. Failed tasks (awaiting triage) + dead/stuck live tasks.
function AttentionTray({ tasks }: { tasks: Task[] }) {
  const eligible = tasks.filter(needsAttention);
  if (eligible.length === 0) return null;
  const failed = eligible.filter((t) => t.state === "failed");
  const unhealthy = eligible.filter((t) => t.state !== "failed");
  return (
    <section className="attn-tray">
      <header className="attn-head">
        <span className="attn-head-title">⚠ Needs attention</span>
        <span className="col-count">{eligible.length}</span>
      </header>
      <div className="attn-body">
        {unhealthy.map((t) => (
          <UnhealthyRow key={t.id} task={t} />
        ))}
        {failed.map((t) => (
          <FailedRow key={t.id} task={t} />
        ))}
      </div>
    </section>
  );
}

export default function Board() {
  const { tasks, projects } = useStore();
  const [adding, setAdding] = useState(false);
  // Compact project filter (All / per project), persisted across reloads.
  const [projectFilter, setProjectFilter] = useState<string>(() => localStorage.getItem(PROJECT_FILTER_KEY) || "");
  const setFilter = (id: string) => {
    setProjectFilter(id);
    if (id) localStorage.setItem(PROJECT_FILTER_KEY, id);
    else localStorage.removeItem(PROJECT_FILTER_KEY);
  };
  // The command palette's "Toggle project filter" action fires this event so the
  // board picks up the change even when it's already mounted.
  useEffect(() => {
    const onSet = (e: Event) => setFilter((e as CustomEvent<string>).detail);
    window.addEventListener("hive:project-filter", onSet as EventListener);
    return () => window.removeEventListener("hive:project-filter", onSet as EventListener);
  }, []);
  // Instant client-side card filter (title/summary substring), no server call.
  const [cardFilter, setCardFilter] = useState("");
  const scoped = projectFilter ? tasks.filter((t) => t.project_id === projectFilter) : tasks;
  const q = cardFilter.trim().toLowerCase();
  const visible = q
    ? scoped.filter((t) => t.title.toLowerCase().includes(q) || (t.summary || "").toLowerCase().includes(q))
    : scoped;
  const byState = (s: State) => {
    let list = visible.filter((t) => t.state === s);
    // list is already newest-updated first from the API / SSE upserts.
    if (s === "done") list = list.slice(0, 10);
    return list;
  };

  return (
    <div className="board-wrap">
      <AttentionTray tasks={visible} />
      <div className="board-switch">
        <span className="board-switch-label">Project</span>
        <button className={`board-chip ${projectFilter ? "" : "board-chip-on"}`} onClick={() => setFilter("")}>
          All
        </button>
        {projects.map((p) => (
          <button
            key={p.id}
            className={`board-chip ${projectFilter === p.id ? "board-chip-on" : ""}`}
            onClick={() => setFilter(p.id)}
          >
            {p.name}
          </button>
        ))}
        <input
          className="board-search"
          placeholder="Filter cards…"
          value={cardFilter}
          onChange={(e) => setCardFilter(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape" && cardFilter) {
              e.stopPropagation();
              setCardFilter("");
            }
          }}
        />
      </div>
      <div className="board">
      {COLUMNS.map((s) => {
        const list = byState(s);
        const attention = list.filter((t) => t.health && t.health.status !== "healthy").length;
        return (
          <section className="column" key={s}>
            <header className="col-head">
              <span className="col-title">{STATE_LABEL[s]}</span>
              <div className="col-head-right">
                {attention > 0 && (
                  <span className="col-attn" title={`${attention} task(s) need attention`}>
                    {attention} need attention
                  </span>
                )}
                {s === "queued" && (
                  <button className="btn btn-primary btn-new" onClick={() => setAdding(true)}>
                    + New task
                  </button>
                )}
                <span className="col-count">{list.length}</span>
              </div>
            </header>
            <div className="col-body">
              {list.map((t) => (
                <Card key={t.id} task={t} />
              ))}
              {list.length === 0 && <div className="col-empty">—</div>}
            </div>
          </section>
        );
      })}
      {adding && <NewTaskModal onClose={() => setAdding(false)} />}
      </div>
    </div>
  );
}

// Compact create-task form. Esc closes, Cmd/Ctrl+Enter submits. The new task
// lands in Queued and surfaces live via SSE, so no manual refresh is needed.
// Exported so the command palette can open it over any view.
export function NewTaskModal({ onClose }: { onClose: () => void }) {
  const { projects } = useStore();
  const [project, setProject] = useState("");
  const [title, setTitle] = useState("");
  const [brief, setBrief] = useState("");
  const [kind, setKind] = useState<Kind>("ship");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!project && projects.length) setProject(projects[0].id);
  }, [projects, project]);

  const submit = async () => {
    if (!project || !title.trim() || busy) return;
    setBusy(true);
    try {
      await api.createTask({ project_id: project, title: title.trim(), brief: brief.trim() || undefined, kind });
      toast("Task queued");
      onClose();
    } catch (e) {
      toast((e as Error).message);
      setBusy(false);
    }
  };

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") onClose();
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) submit();
  };

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div className="modal" onMouseDown={(e) => e.stopPropagation()} onKeyDown={onKey}>
        <h2>New task</h2>
        {projects.length === 0 ? (
          <div className="muted">No projects yet. Create one first.</div>
        ) : (
          <>
            <label className="fld">
              <span>Project</span>
              <select value={project} onChange={(e) => setProject(e.target.value)}>
                {projects.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="fld">
              <span>Title</span>
              <input autoFocus placeholder="What needs doing" value={title} onChange={(e) => setTitle(e.target.value)} />
            </label>
            <label className="fld">
              <span>Brief</span>
              <textarea placeholder="Description / definition of done (optional)" value={brief} onChange={(e) => setBrief(e.target.value)} />
            </label>
            <label className="fld">
              <span>Kind</span>
              <select value={kind} onChange={(e) => setKind(e.target.value as Kind)}>
                <option value="ship">ship</option>
                <option value="scout">scout</option>
                <option value="chore">chore</option>
              </select>
            </label>
          </>
        )}
        <div className="modal-foot">
          <span className="muted modal-hint">⌘↵ to queue · Esc to close</span>
          <div className="spacer" />
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary" disabled={busy || !title.trim() || !project} onClick={submit}>
            {busy ? "Queuing…" : "Queue task"}
          </button>
        </div>
      </div>
    </div>
  );
}
