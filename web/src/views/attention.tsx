import { useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../lib/api";
import { useStore } from "../lib/store";
import type { Task } from "../lib/api";
import { isTrackingOnly, taskNeedsAttention } from "../lib/needsYou";
import { Attach, HEALTH_LABEL, StatusDot, toast } from "../lib/ui";
import { useRelTime } from "../lib/time";

export { taskNeedsAttention as needsAttention } from "../lib/needsYou";

// One compact tray row for a FAILED task awaiting human triage. Failed tasks are
// not a board column, so without this tray they vanish entirely.
export function FailedRow({ task }: { task: Task }) {
  const { projects } = useStore();
  const project = projects.find((p) => p.id === task.project_id);
  const age = useRelTime(task.updated_at);
  const [editing, setEditing] = useState(false);
  const trackingOnly = isTrackingOnly(task);
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
        {!trackingOnly && (
          <>
            <button className="btn btn-mini" onClick={() => act(() => api.transition(task.id, "queued", "requeued"), "Re-queued")}>
              Requeue
            </button>
            <button className="btn btn-mini" onClick={() => setEditing(true)}>
              Edit &amp; requeue
            </button>
          </>
        )}
        <button className="btn btn-mini btn-danger" onClick={() => act(() => api.transition(task.id, "cancelled", "dismissed from tray"), "Cancelled")}>
          Cancel
        </button>
      </div>
      {editing && !trackingOnly && <EditRequeueModal task={task} onClose={() => setEditing(false)} />}
    </div>
  );
}

// One compact tray row for a live task whose agent is dead/stuck.
export function UnhealthyRow({ task }: { task: Task }) {
  const { projects } = useStore();
  const project = projects.find((p) => p.id === task.project_id);
  const age = useRelTime(task.health?.since || task.updated_at);
  const trackingOnly = isTrackingOnly(task);
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
      <span className={`attn-reason attn-${h.status}`} title={h.reason || HEALTH_LABEL[h.status]}>
        {h.reason || HEALTH_LABEL[h.status]}
      </span>
      <span className="attn-age">{age}</span>
      <div className="attn-actions">
        {!trackingOnly && task.agent_target && (
          <button className="btn btn-mini" onClick={() => act(async () => { const r = await api.focusAgent(task.id); if (!r.ok) throw new Error(r.error); }, "Focused agent tab")}>
            View agent
          </button>
        )}
        {!trackingOnly && task.agent_target && (
          <button className="btn btn-mini" onClick={() => act(() => api.send(task.id, "hive: status? Reply with what you're doing or what's blocking you."), "Nudge sent")}>
            Nudge
          </button>
        )}
        {!trackingOnly && (
          <button className="btn btn-mini btn-danger" onClick={() => act(() => api.requeue(task.id), "Failed & requeued")}>
            Fail + requeue
          </button>
        )}
      </div>
    </div>
  );
}

// Small modal: edit a failed task's brief/title, then re-queue it.
export function EditRequeueModal({ task, onClose }: { task: Task; onClose: () => void }) {
  const [title, setTitle] = useState(task.title);
  const [brief, setBrief] = useState(task.brief || "");
  const [files, setFiles] = useState<File[]>([]);
  const [busy, setBusy] = useState(false);
  if (isTrackingOnly(task)) return null;
  const submit = async () => {
    if (!title.trim() || busy) return;
    setBusy(true);
    try {
      await api.updateTask(task.id, { title: title.trim(), brief }, files);
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
        <Attach files={files} onChange={setFiles}>
          <label className="fld">
            <span>Brief</span>
            <textarea value={brief} onChange={(e) => setBrief(e.target.value)} />
          </label>
        </Attach>
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

// The two row kinds, split failed vs live-unhealthy. Reused by the board tray
// (wrapped in its own section header) and the Needs you attention section.
export function AttentionRows({ tasks }: { tasks: Task[] }) {
  const failed = tasks.filter((t) => t.state === "failed");
  const unhealthy = tasks.filter((t) => t.state !== "failed");
  return (
    <>
      {unhealthy.map((t) => (
        <UnhealthyRow key={t.id} task={t} />
      ))}
      {failed.map((t) => (
        <FailedRow key={t.id} task={t} />
      ))}
    </>
  );
}

// Collapsed when empty. Failed tasks (awaiting triage) + dead/stuck live tasks.
export function AttentionTray({ tasks }: { tasks: Task[] }) {
  const eligible = tasks.filter(taskNeedsAttention);
  if (eligible.length === 0) return null;
  return (
    <section className="attn-tray">
      <header className="attn-head">
        <span className="attn-head-title">⚠ Needs attention</span>
        <span className="col-count">{eligible.length}</span>
      </header>
      <div className="attn-body">
        <AttentionRows tasks={eligible} />
      </div>
    </section>
  );
}
