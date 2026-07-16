import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../lib/api";
import type { Learning } from "../lib/api";
import { useStore } from "../lib/store";
import { relTime } from "../lib/time";
import { Empty, toast } from "../lib/ui";

export default function Learnings() {
  const { projects } = useStore();
  const [learnings, setLearnings] = useState<Learning[]>([]);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [project, setProject] = useState("");
  const [rootCause, setRootCause] = useState(false);
  const [kind, setKind] = useState<"failure" | "reference">("failure");

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
    await api.createLearning({
      project_id: project,
      title,
      body,
      kind,
      create_root_cause_task: kind === "failure" && rootCause,
    });
    setTitle("");
    setBody("");
    setRootCause(false);
    toast(kind === "reference" ? "Reference saved" : rootCause ? "Learning added + root-cause task queued" : "Learning added");
    load();
  };

  const resolve = async (l: Learning) => {
    await api.updateLearning(l.id, { status: l.status === "active" ? "resolved" : "active" });
    load();
  };

  const references = learnings.filter((l) => l.kind === "reference" && l.status === "active");
  const decisions = learnings.filter((l) => l.kind === "decision" && l.status === "active");
  const active = learnings.filter((l) => l.kind !== "reference" && l.kind !== "decision" && l.status === "active");
  const resolved = learnings.filter((l) => l.kind !== "reference" && l.kind !== "decision" && l.status === "resolved");

  return (
    <div className="policies">
      <section className="panel add-policy">
        <h2>Add {kind === "reference" ? "reference" : "learning"}</h2>
        <div className="row">
          <label className="ck">
            <input type="radio" checked={kind === "failure"} onChange={() => setKind("failure")} /> failure pattern
          </label>
          <label className="ck">
            <input type="radio" checked={kind === "reference"} onChange={() => setKind("reference")} /> reference fact
          </label>
        </div>
        <input
          placeholder={kind === "reference" ? "What it is (e.g. Design file)" : "Title (the failure pattern)"}
          value={title}
          onChange={(e) => setTitle(e.target.value)}
        />
        <textarea
          placeholder={kind === "reference" ? "The fact / link (pinned into every brief)" : "What happened, how it was worked around"}
          value={body}
          onChange={(e) => setBody(e.target.value)}
        />
        <div className="row">
          <select value={project} onChange={(e) => setProject(e.target.value)}>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
          {kind === "failure" && (
            <label className="ck">
              <input type="checkbox" checked={rootCause} onChange={(e) => setRootCause(e.target.checked)} />
              auto-create root-cause task
            </label>
          )}
          <button className="btn btn-primary" onClick={add}>
            Add
          </button>
        </div>
      </section>

      {references.length > 0 && (
        <LearningList title="References (durable facts, pinned into briefs)" items={references} projectName={projectName} onResolve={resolve} />
      )}
      {decisions.length > 0 && (
        <LearningList title="Decisions already made (past answers, so crews don't re-ask)" items={decisions} projectName={projectName} onResolve={resolve} />
      )}
      <LearningList title="Active failure patterns" items={active} projectName={projectName} onResolve={resolve} />
      {resolved.length > 0 && <LearningList title="Resolved" items={resolved} projectName={projectName} onResolve={resolve} />}
      {learnings.length === 0 && (
        <Empty
          title="No learnings or references yet"
          hint="Repo landmines agents trip on (a build quirk, a flaky path) and durable facts (design files, URLs, glossary) land here and get pinned into every agent brief."
        />
      )}
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
              {l.kind !== "reference" && <span className="chip learn-occ" title="occurrences">{l.occurrences}×</span>}
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
