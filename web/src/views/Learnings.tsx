import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../lib/api";
import type { Learning } from "../lib/api";
import { useStore } from "../lib/store";
import { relTime } from "../lib/time";
import { toast } from "../lib/ui";

export default function Learnings() {
  const { projects } = useStore();
  const [learnings, setLearnings] = useState<Learning[]>([]);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [project, setProject] = useState("");
  const [rootCause, setRootCause] = useState(false);

  const load = () => api.learnings().then(setLearnings);
  useEffect(() => {
    load();
  }, []);
  useEffect(() => {
    if (!project && projects.length) setProject(projects[0].id);
  }, [projects, project]);

  const projectName = (id: string) => projects.find((p) => p.id === id)?.name || id;

  const add = async () => {
    if (!title.trim() || !project) return;
    await api.createLearning({ project_id: project, title, body, create_root_cause_task: rootCause });
    setTitle("");
    setBody("");
    setRootCause(false);
    toast(rootCause ? "Learning added + root-cause task queued" : "Learning added");
    load();
  };

  const resolve = async (l: Learning) => {
    await api.updateLearning(l.id, { status: l.status === "active" ? "resolved" : "active" });
    load();
  };

  const active = learnings.filter((l) => l.status === "active");
  const resolved = learnings.filter((l) => l.status === "resolved");

  return (
    <div className="policies">
      <section className="panel add-policy">
        <h2>Add learning</h2>
        <input placeholder="Title (the failure pattern)" value={title} onChange={(e) => setTitle(e.target.value)} />
        <textarea placeholder="What happened, how it was worked around" value={body} onChange={(e) => setBody(e.target.value)} />
        <div className="row">
          <select value={project} onChange={(e) => setProject(e.target.value)}>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
          <label className="ck">
            <input type="checkbox" checked={rootCause} onChange={(e) => setRootCause(e.target.checked)} />
            auto-create root-cause task
          </label>
          <button className="btn btn-primary" onClick={add}>
            Add
          </button>
        </div>
      </section>

      <LearningList title="Active" items={active} projectName={projectName} onResolve={resolve} />
      {resolved.length > 0 && <LearningList title="Resolved" items={resolved} projectName={projectName} onResolve={resolve} />}
      {learnings.length === 0 && <div className="muted pad">No learnings yet.</div>}
    </div>
  );
}

function LearningList({
  title,
  items,
  projectName,
  onResolve,
}: {
  title: string;
  items: Learning[];
  projectName: (id: string) => string;
  onResolve: (l: Learning) => void;
}) {
  if (items.length === 0) return null;
  return (
    <>
      <h3 className="learn-section">{title}</h3>
      <div className="policy-list">
        {items.map((l) => (
          <div key={l.id} className={`policy ${l.status === "resolved" ? "policy-off" : ""}`}>
            <div className="policy-head">
              <span className="chip">{projectName(l.project_id)}</span>
              <span className="chip learn-occ" title="occurrences">{l.occurrences}×</span>
              {l.root_cause_task_id && (
                <Link className="chip learn-link" to={`/tasks/${l.root_cause_task_id}`}>
                  root-cause task →
                </Link>
              )}
              <div className="spacer" />
              <span className="learn-age" title={l.last_seen}>seen {relTime(l.last_seen)}</span>
              <button className="link-btn" onClick={() => onResolve(l)}>
                {l.status === "active" ? "resolve" : "reopen"}
              </button>
            </div>
            <strong>{l.title}</strong>
            {l.body && <p className="policy-body">{l.body}</p>}
          </div>
        ))}
      </div>
    </>
  );
}
