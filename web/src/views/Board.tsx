import { Link } from "react-router-dom";
import { useStore } from "../lib/store";
import type { State, Task } from "../lib/api";
import { CiBadge, STATE_LABEL, StatusDot } from "../lib/ui";
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
  const { projects, evidenceCount, lastActivity } = useStore();
  const project = projects.find((p) => p.id === task.project_id);
  const age = useRelTime(lastActivity[task.id] || task.updated_at);
  const ev = evidenceCount[task.id];
  return (
    <Link to={`/tasks/${task.id}`} className="card">
      <div className="card-top">
        <StatusDot state={task.state} />
        <span className="card-title">{task.title}</span>
      </div>
      <div className="card-meta">
        {project && <span className="chip">{project.name}</span>}
        <span className={`chip chip-kind chip-${task.kind}`}>{task.kind}</span>
        <span className="card-age">{age}</span>
      </div>
      {task.summary && <div className="card-summary">{task.summary}</div>}
      <div className="card-foot">
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
              <span className="col-count">{list.length}</span>
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
    </div>
  );
}
