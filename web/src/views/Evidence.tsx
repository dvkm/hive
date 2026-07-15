import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../lib/api";
import type { EvidenceRow } from "../lib/api";
import { useStore } from "../lib/store";
import { useLightbox } from "../lib/lightbox";
import type { LightboxImage } from "../lib/lightbox";
import { relTime } from "../lib/time";
import { Empty } from "../lib/ui";

const KINDS = ["screenshot", "test_run", "log", "report", "link"] as const;

export default function Evidence() {
  const { projects, tasks } = useStore();
  const lightbox = useLightbox();

  const [project, setProject] = useState("");
  const [kind, setKind] = useState("");
  const [task, setTask] = useState("");
  const [rows, setRows] = useState<EvidenceRow[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let live = true;
    setLoading(true);
    api
      .evidence({ project: project || undefined, kind: kind || undefined, task: task || undefined, limit: 100 })
      .then((r) => live && setRows(r.evidence))
      .catch(() => live && setRows([]))
      .finally(() => live && setLoading(false));
    return () => {
      live = false;
    };
  }, [project, kind, task]);

  // Tasks selectable in the filter, scoped to the chosen project.
  const taskOptions = useMemo(
    () => tasks.filter((t) => !project || t.project_id === project),
    [tasks, project]
  );

  // Image rows form one lightbox set (matching the grid's newest-first order).
  const imageRows = rows.filter((e) => e.kind === "screenshot" && e.url);
  const lb: LightboxImage[] = imageRows.map((e) => ({
    url: e.url!,
    caption: e.caption,
    taskId: e.task_id,
    taskTitle: e.task_title,
    ts: e.ts,
  }));

  return (
    <div className="evidence-browser">
      <div className="evb-filters">
        <select value={project} onChange={(e) => { setProject(e.target.value); setTask(""); }}>
          <option value="">All projects</option>
          {projects.map((p) => (
            <option key={p.id} value={p.id}>{p.name}</option>
          ))}
        </select>
        <select value={kind} onChange={(e) => setKind(e.target.value)}>
          <option value="">All kinds</option>
          {KINDS.map((k) => (
            <option key={k} value={k}>{k}</option>
          ))}
        </select>
        <select value={task} onChange={(e) => setTask(e.target.value)}>
          <option value="">All tasks</option>
          {taskOptions.map((t) => (
            <option key={t.id} value={t.id}>{t.title}</option>
          ))}
        </select>
        <span className="evb-count muted">{rows.length} item{rows.length === 1 ? "" : "s"}</span>
      </div>

      {rows.length === 0 && !loading && (
        <Empty
          title="No evidence"
          hint="Agents attach screenshots, test runs and reports here as they work — no task reaches Done without one. Widen the filters if you expected something."
        />
      )}

      <div className="evb-grid">
        {rows.map((e) =>
          e.kind === "screenshot" && e.url ? (
            <button
              key={e.id}
              className="evb-card evb-img"
              onClick={() => lightbox.open(lb, imageRows.findIndex((x) => x.id === e.id))}
              title="Open"
            >
              <img src={e.url} alt={e.caption || "screenshot"} />
              <EvbMeta e={e} />
            </button>
          ) : (
            <div key={e.id} className="evb-card evb-doc">
              <div className="evb-doc-head">
                <span className="chip chip-kind">{e.kind}</span>
                {e.url && (
                  <a className="evb-open" href={e.url} target="_blank" rel="noreferrer">
                    open →
                  </a>
                )}
              </div>
              <div className="evb-cap">{e.caption || e.url || e.path || "(no caption)"}</div>
              {e.preview && <pre className="ev-preview">{e.preview}</pre>}
              <EvbMeta e={e} />
            </div>
          )
        )}
      </div>
    </div>
  );
}

function EvbMeta({ e }: { e: EvidenceRow }) {
  return (
    <div className="evb-meta">
      <span className="chip chip-kind">{e.project_name}</span>
      <Link className="evb-task" to={`/tasks/${e.task_id}`}>{e.task_title}</Link>
      <span className="evb-age" title={e.ts}>{relTime(e.ts)}</span>
    </div>
  );
}
