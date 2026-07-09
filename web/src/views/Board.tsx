import { useEffect, useState } from "react";
import { Link, useLocation } from "react-router-dom";
import { api } from "../lib/api";
import { useStore } from "../lib/store";
import type { Kind, State, Task } from "../lib/api";
import { CiBadge, STATE_LABEL, StatusDot, toast } from "../lib/ui";
import { useRelTime } from "../lib/time";

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

  return (
    <Link to={`/tasks/${task.id}`} state={{ backgroundLocation: location }} className="card">
      <div className="card-top">
        <StatusDot state={task.state} />
        <span className="card-title">{task.title}</span>
      </div>
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

export default function Board() {
  const { tasks } = useStore();
  const [adding, setAdding] = useState(false);
  const byState = (s: State) => {
    let list = tasks.filter((t) => t.state === s);
    // list is already newest-updated first from the API / SSE upserts.
    if (s === "done") list = list.slice(0, 10);
    return list;
  };

  return (
    <div className="board">
      {COLUMNS.map((s) => {
        const list = byState(s);
        return (
          <section className="column" key={s}>
            <header className="col-head">
              <span className="col-title">{STATE_LABEL[s]}</span>
              <div className="col-head-right">
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
  );
}

// Compact create-task form. Esc closes, Cmd/Ctrl+Enter submits. The new task
// lands in Queued and surfaces live via SSE, so no manual refresh is needed.
function NewTaskModal({ onClose }: { onClose: () => void }) {
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
