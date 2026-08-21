import { useEffect, useState } from "react";
import { Link, useLocation } from "react-router-dom";
import { api } from "../lib/api";
import { useStore } from "../lib/store";
import type { Health, Kind, State, Task } from "../lib/api";
import { Attach, BlockedBy, CiBadge, Empty, HEALTH_LABEL, STATE_LABEL, StatusDot, toast } from "../lib/ui";
import { useRelTime } from "../lib/time";
import { useProjectFilter, setProjectFilter } from "../lib/projectFilter";
import { AttentionTray, needsAttention, isWaiting } from "./attention";
import { isJiraMirror, isTrackingOnly, trackedSubtasks } from "../lib/needsYou";
import { taskLabel } from "../lib/references";

// A compact "why this card needs attention" line: e.g. "agent gone" or
// "no activity 22m". Server-provided reason + live-ticking since-age.
function HealthLine({ health }: { health: Health }) {
  const age = useRelTime(health.since);
  const dead = health.status === "dead";
  const reason = dead ? "agent gone" : health.reason || HEALTH_LABEL[health.status];
  return (
    <div className={`card-attn attn-${health.status}`} title={dead ? reason : `${reason} ${age}`}>
      <span className="card-attn-reason">{reason}</span>
      {!dead && <span className="card-attn-age">{age}</span>}
    </div>
  );
}

const COLUMNS: { state: State; label: string }[] = [
  { state: "queued", label: "Queued" },
  { state: "in_progress", label: "Working" },
  { state: "needs_decision", label: "Needs You" },
  { state: "in_review", label: "Ready to Merge" },
  { state: "done", label: "Done" },
];
const BOARD_STATES = new Set<State>([...COLUMNS.map(({ state }) => state), "verifying"]);

// What an empty column MEANS, and what puts a card in it. An empty column is
// the most common thing on this board, so "—" was the most common thing the
// director saw.
const COL_EMPTY: Record<string, { title: string; hint: string }> = {
  queued: {
    title: "Nothing queued",
    hint: "New tasks wait here for an agent. Add one, or braindump and approve the breakdown.",
  },
  in_progress: {
    title: "No agents working",
    hint: "Dispatch a queued task and its agent appears here while it runs.",
  },
  needs_decision: {
    title: "Nothing blocked",
    hint: "An agent that hits a call only you can make parks here and waits.",
  },
  in_review: {
    title: "Nothing ready to merge",
    hint: "Agents land here once the PR is open and CI is green. That's your cue to merge.",
  },
  done: {
    title: "Nothing finished yet",
    hint: "Tasks arrive once they're merged, verified, and carry evidence.",
  },
};

export function Card({ task }: { task: Task }) {
  const { projects, evidenceCount, spawnError, lastActivity, tasks } = useStore();
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
  const trackingOnly = isTrackingOnly(task);
  const jiraMirror = isJiraMirror(task);
  const subtasks = trackingOnly ? trackedSubtasks(task, tasks) : [];

  return (
    <Link to={`/tasks/${task.id}`} state={{ backgroundLocation: location }} className="card">
      <div className="card-top">
        <StatusDot state={task.state} health={task.health} />
        <span className="card-num" title={`Legacy task #${task.number}`}>{taskLabel(task)}</span>
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
        {task.source === "intake_braindump" && (
          <span className="chip chip-intake" title="A braindump; Claude is drafting a breakdown to approve">
            braindump
          </span>
        )}
        {task.source === "external" && (
          <span className="chip" title="Tracking-only: driven by an outside agent, never auto-dispatched">
            tracked
          </span>
        )}
        {trackingOnly && <span className="chip">{STATE_LABEL[task.state]}</span>}
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
        <BlockedBy depends_on={task.depends_on} tasks={tasks} />
        {task.deferred_until && Date.parse(task.deferred_until) > Date.now() && (
          <span className="chip chip-deferred" title="Deferred pending an offline human action; nudges suppressed">
            deferred
          </span>
        )}
        <span className="card-age">{age}</span>
      </div>
      {task.summary && <div className="card-summary">{task.summary}</div>}
      {subtasks.length > 0 && (
        <div className="card-subtasks">
          <div className="card-subtasks-head">
            <span>Subtasks</span>
            <span>{subtasks.filter((subtask) => subtask.state === "done").length}/{subtasks.length} done</span>
          </div>
          {subtasks.map((subtask) => (
            <div className="card-subtask" key={subtask.id}>
              <StatusDot state={subtask.state} health={subtask.health} />
              <span className="card-subtask-id">{taskLabel(subtask)}</span>
              <span className="card-subtask-title">{subtask.title}</span>
              <span className="card-subtask-state">{STATE_LABEL[subtask.state]}</span>
            </div>
          ))}
        </div>
      )}
      <div className="card-foot">
        {/* An intake task holds raw input, not a brief: an agent would try to
            "do" the braindump. Its plan produces the dispatchable tasks. */}
        {task.state === "queued" && !task.source?.startsWith("intake_") && !jiraMirror && !task.never_dispatched && (
          <button className="btn btn-mini" onClick={dispatch} disabled={dispatching} title="Spawn an agent for this task now">
            {dispatching ? "dispatching…" : "dispatch now"}
          </button>
        )}
        {task.agent_target && task.state === "in_progress" && !jiraMirror && (
          <button className="btn btn-mini" onClick={viewAgent} title="Focus this agent's tab in herdr">
            view agent
          </button>
        )}
        {!trackingOnly && task.pr_url && (
          <a
            className="pr"
            href={task.pr_url}
            target="_blank"
            rel="noreferrer"
            title={`Pull request linked to ${taskLabel(task)}`}
            onClick={(e) => e.stopPropagation()}
          >
            PR ↔ {taskLabel(task)}
          </a>
        )}
        {!trackingOnly && <CiBadge status={task.ci_status} />}
        {ev != null && ev > 0 && <span className="evc" title="evidence items">◱ {ev}</span>}
      </div>
    </Link>
  );
}

const BANNER_DISMISS_KEY = "hive.brief.bannerDismissed";

// Slim, dismissible banner nudging the director to Needs you when there are
// actionable decisions, reviews, or tasks needing attention.
// Dismissal is keyed on the current item signature, so a fresh decision or a new
// unhealthy task brings it back rather than staying hidden forever.
function BriefBanner() {
  const { decisions, tasks } = useStore();
  const attn = tasks.filter((t) => needsAttention(t) && !isWaiting(t, tasks)).length;
  const decs = decisions.length;
  const review = tasks.filter((t) => t.state === "in_review" && !isTrackingOnly(t)).length;
  const sig = `${decs}:${attn}:${review}`;
  const [dismissed, setDismissed] = useState<string>(() => localStorage.getItem(BANNER_DISMISS_KEY) || "");
  if (decs + attn + review === 0 || dismissed === sig) return null;
  const parts: string[] = [];
  if (decs > 0) parts.push(`${decs} decision${decs === 1 ? "" : "s"}`);
  if (review > 0) parts.push(`${review} to review`);
  if (attn > 0) parts.push(`${attn} need${attn === 1 ? "s" : ""} attention`);
  const dismiss = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    localStorage.setItem(BANNER_DISMISS_KEY, sig);
    setDismissed(sig);
  };
  return (
    <Link to="/inbox" className="brief-banner">
      <span className="brief-banner-dot">◆</span>
      <span className="brief-banner-text">Your brief: {parts.join(", ")}</span>
      <span className="brief-banner-go">Open →</span>
      <button className="brief-banner-x" onClick={dismiss} title="Dismiss" aria-label="Dismiss">
        ×
      </button>
    </Link>
  );
}

export default function Board() {
  const { tasks, projects } = useStore();
  const [adding, setAdding] = useState(false);
  const [view, setView] = useState<"work" | "tracked">("work");
  // Compact project filter (All / per project), shared across board/inboxes and
  // persisted across reloads. Setting it broadcasts to every mounted view.
  const projectFilter = useProjectFilter();
  const setFilter = setProjectFilter;
  // Instant client-side card filter (title/summary substring), no server call.
  const [cardFilter, setCardFilter] = useState("");
  const scoped = projectFilter ? tasks.filter((t) => t.project_id === projectFilter) : tasks;
  const q = cardFilter.trim().toLowerCase();
  const matches = (task: Task) => task.title.toLowerCase().includes(q) || (task.summary || "").toLowerCase().includes(q);
  const visible = q
    ? scoped.filter((task) => matches(task) || (isTrackingOnly(task) && trackedSubtasks(task, scoped).some(matches)))
    : scoped;
  const byState = (s: State) => {
    let list = visible.filter((t) => !isTrackingOnly(t) && t.state === s);
    // list is already newest-updated first from the API / SSE upserts.
    if (s === "done") list = list.slice(0, 10);
    return list;
  };
  const verifying = visible.filter((task) => !isTrackingOnly(task) && task.state === "verifying");
  const tracked = visible.filter((task) => isTrackingOnly(task) && BOARD_STATES.has(task.state));

  return (
    <div className="board-wrap">
      <BriefBanner />
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
        <span className="board-switch-label board-view-label">View</span>
        <button className={`board-chip ${view === "work" ? "board-chip-on" : ""}`} onClick={() => setView("work")}>Work</button>
        <button className={`board-chip ${view === "tracked" ? "board-chip-on" : ""}`} onClick={() => setView("tracked")}>Tracked {tracked.length}</button>
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
      {view === "work" ? (
        <>
          {verifying.length > 0 && (
            <section className="verification-strip" aria-label="Post-merge checks">
              <span className="verification-title">Post-merge checks</span>
              {verifying.map((task) => (
                <Link className="verification-item" to={`/tasks/${task.id}`} key={task.id}>
                  <StatusDot state={task.state} health={task.health} />
                  <span>{taskLabel(task)}</span>
                  <span className="verification-task-title">{task.title}</span>
                </Link>
              ))}
            </section>
          )}
          <div className="board">
          {COLUMNS.map(({ state, label }) => {
            const list = byState(state);
            const attention = list.filter((t) => t.health && t.health.status !== "healthy").length;
            return (
              <section className="column" key={state}>
                <header className="col-head">
                  <span className="col-title">{label}</span>
                  <div className="col-head-right">
                    {attention > 0 && (
                      <span className="col-attn" title={`${attention} task(s) need attention`}>
                        {attention} need attention
                      </span>
                    )}
                    {state === "queued" && (
                      <button className="btn btn-primary btn-new" onClick={() => setAdding(true)}>
                        + New task
                      </button>
                    )}
                    <span className="col-count">{list.length}</span>
                  </div>
                </header>
                <div className="col-body">
                  {list.map((t) => <Card key={t.id} task={t} />)}
                  {list.length === 0 && <Empty compact {...COL_EMPTY[state]} />}
                </div>
              </section>
            );
          })}
          </div>
        </>
      ) : (
        <section className="tracked-view">
          <header className="tracked-head">
            <div>
              <h2>Tracked</h2>
              <p>Outside work grouped here with its external status. Hive subtasks stay visible without entering the merge queue.</p>
            </div>
            <span className="col-count">{tracked.length}</span>
          </header>
          {tracked.length > 0 ? (
            <div className="tracked-grid">
              {tracked.map((task) => <Card key={task.id} task={task} />)}
            </div>
          ) : (
            <Empty title="Nothing tracked" hint="Tracking-only tasks appear here without mixing into Hive's execution lanes." />
          )}
        </section>
      )}
      {adding && <NewTaskModal onClose={() => setAdding(false)} />}
    </div>
  );
}

// Intake form. Esc closes, Cmd/Ctrl+Enter submits.
//
// Braindump (default): dump unstructured text, the planner drafts a task
// breakdown and opens a decision card for approval — nothing is queued until
// the breakdown is approved. Manual: the old title/brief/kind form, which
// queues a task directly. Both surface live via SSE, so no manual refresh.
// Exported so the command palette can open it over any view.
export function NewTaskModal({ onClose }: { onClose: () => void }) {
  const { projects } = useStore();
  const [mode, setMode] = useState<"braindump" | "manual">("braindump");
  const [project, setProject] = useState("");
  const [dump, setDump] = useState("");
  const [title, setTitle] = useState("");
  const [brief, setBrief] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [kind, setKind] = useState<Kind>("ship");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!project && projects.length) setProject(projects[0].id);
  }, [projects, project]);

  const ready = project && (mode === "braindump" ? dump.trim() : title.trim());

  const submit = async () => {
    if (!ready || busy) return;
    setBusy(true);
    try {
      if (mode === "braindump") {
        await api.intake({ project_id: project, text: dump.trim() });
        toast("Braindump sent — Claude is drafting a breakdown for you to approve");
      } else {
        await api.createTask({ project_id: project, title: title.trim(), brief: brief.trim() || undefined, kind }, files);
        toast(files.length ? `Task queued with ${files.length} attachment(s)` : "Task queued");
      }
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
        <div className="mode-tabs">
          <button className={`mode-tab ${mode === "braindump" ? "on" : ""}`} onClick={() => setMode("braindump")}>
            Braindump
          </button>
          <button className={`mode-tab ${mode === "manual" ? "on" : ""}`} onClick={() => setMode("manual")}>
            Manual
          </button>
        </div>
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
            {mode === "braindump" ? (
              <label className="fld">
                <span>Braindump</span>
                <textarea
                  autoFocus
                  className="braindump"
                  placeholder="Dump whatever is in your head. Half-formed is fine. Claude drafts the tasks and you approve them before anything runs."
                  value={dump}
                  onChange={(e) => setDump(e.target.value)}
                />
              </label>
            ) : (
              <>
                <label className="fld">
                  <span>Title</span>
                  <input autoFocus placeholder="What needs doing" value={title} onChange={(e) => setTitle(e.target.value)} />
                </label>
                <Attach files={files} onChange={setFiles}>
                  <label className="fld">
                    <span>Brief</span>
                    <textarea placeholder="Description / definition of done (optional)" value={brief} onChange={(e) => setBrief(e.target.value)} />
                  </label>
                </Attach>
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
          </>
        )}
        <div className="modal-foot">
          <span className="muted modal-hint">
            {mode === "braindump" ? "⌘↵ to send · Esc to close" : "⌘↵ to queue · Esc to close"}
          </span>
          <div className="spacer" />
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary" disabled={busy || !ready} onClick={submit}>
            {mode === "braindump"
              ? busy
                ? "Sending…"
                : "Draft tasks"
              : busy
                ? "Queuing…"
                : "Queue task"}
          </button>
        </div>
      </div>
    </div>
  );
}
