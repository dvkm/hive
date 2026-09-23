import { useEffect, useState } from "react";
import { Link, useLocation } from "react-router-dom";
import { api } from "../lib/api";
import { useStore } from "../lib/store";
import type { DivergenceRow, Health, Kind, LandGraph, State, Task } from "../lib/api";
import { Attach, BlockedBy, CiBadge, Empty, HEALTH_LABEL, needsLook, PRIORITIES, PriorityChip, priorityRank, SidecarChip, STATE_LABEL, StatusDot, toast } from "../lib/ui";
import { useRelTime } from "../lib/time";
import { useProjectFilter, setProjectFilter } from "../lib/projectFilter";
import { isJiraMirror, isTrackingOnly, mirrorStillWorking, trackedSubtasks } from "../lib/needsYou";
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
  { state: "needs_decision", label: "Blocked" },
  { state: "in_review", label: "In review" },
  { state: "done", label: "Done" },
];

// What still holds an in_review card, from the server's review gate. CI chips
// already render in the card foot, so those two gates draw nothing extra here.
// A `needs_you` card's hover is the server's own reason (review_hold) when it sent one.
export const REVIEW_GATE_CHIP: Record<string, { label: string; title: string; className: string } | undefined> = {
  needs_you: { label: "Needs you", title: "This one waits for your Ship.", className: "chip chip-yours" },
  hive_merging: { label: "Hive is merging", title: "The checks passed and nothing needs you. Hive merges it on its own.", className: "chip" },
  risk_confirmed: { label: "risk confirmed", title: "The risk check confirmed a finding on this commit. The agent has to clear it before this can merge.", className: "chip chip-error" },
  review_running: { label: "pre-review running", title: "Hive's pre-review has not finished on this commit yet.", className: "chip" },
  no_pr: { label: "no PR yet", title: "No pull request or report yet.", className: "chip" },
};
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
    title: "Nothing in review",
    hint: "Agents land here once a PR is open. Each card says what still holds it.",
  },
  done: {
    title: "Nothing finished yet",
    hint: "Work shows up here once it is merged.",
  },
};

export function Card({ task }: { task: Task }) {
  const { projects, spawnError, lastActivity, tasks, decisions } = useStore();
  // One rule decides every chip on this card: show it only if it changes what
  // the director would DO. A project name while a project filter is on says
  // what the filter buttons already say, so it is dropped there.
  const projectFilter = useProjectFilter();
  const project = projectFilter ? undefined : projects.find((p) => p.id === task.project_id);
  // health.since is the server's agent-only activity clock (health.ts); it is
  // the honest "quiet for" number, where updated_at counts hive's own writes.
  const age = useRelTime(task.health?.since || lastActivity[task.id] || task.updated_at);
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

  const health = task.health;
  const unhealthy = needsLook(health);
  const trackingOnly = isTrackingOnly(task);
  const jiraMirror = isJiraMirror(task);
  const subtasks = trackingOnly ? trackedSubtasks(task, tasks) : [];
  // `decisions` is the open-cards list, so an intake_triage card here means this
  // task is held waiting on the director to pick a reading.
  const awaitingTriage = decisions.some((d) => d.task_id === task.id && d.decision_class === "intake_triage");
  // A deferred task is excluded from the dispatcher's queued lap, so its
  // `skip` reason is frozen from before the deferral and can go stale (e.g.
  // "intent is still a draft" surviving the intent's acceptance) — the
  // deferred chip below, with the director's own note, is the true reason.
  const deferred = !!task.deferred_until && Date.parse(task.deferred_until) > Date.now();
  const gateChip = task.review_gate ? REVIEW_GATE_CHIP[task.review_gate] : undefined;

  return (
    <Link to={`/tasks/${task.id}`} state={{ backgroundLocation: location }} className="card">
      <div className="card-top">
        <StatusDot state={task.state} health={task.health} />
        <span className="card-num" title={`Legacy task #${task.number}`}>{taskLabel(task)}</span>
        {/* Clamped to two lines in CSS; the full title is the tooltip and the
            card's own page. A six-line title made the card all title. */}
        <span className="card-title" title={task.title}>{task.title}</span>
      </div>
      {unhealthy && <HealthLine health={health!} />}
      <div className="card-meta">
        {project && <span className="chip">{project.name}</span>}
        <PriorityChip task={task} />
        {awaitingTriage ? (
          // Intake triage read this request two ways and parked it on one
          // question. "queued" alone reads as "an agent will pick this up",
          // which is exactly wrong: nothing moves until the director answers.
          <span className="chip chip-intake" title="Intake triage found more than one reading. Pick which one to build. Nothing is built until you answer.">
            awaiting one answer
          </span>
        ) : task.source === "intake_gchat" && !task.reviewed && (
          // `reviewed` is server-computed (health.ts). Intake triage marks a
          // clear mechanical request reviewed on its own, and a reviewed task
          // dispatches like any other — so only say "unreviewed" while it is
          // genuinely held.
          <span className="chip chip-intake" title="Created from a Google Chat message; needs review">
            intake · unreviewed
          </span>
        )}
        {trackingOnly && <span className="chip">{STATE_LABEL[task.state]}</span>}
        {task.state === "queued" && spawnError[task.id] && (
          <span className="chip chip-error" title="A previous spawn failed; see the task timeline">
            spawn failed
          </span>
        )}
        {task.state === "queued" && task.overlap_hold && (
          <span
            className="chip chip-blocked"
            title={`Both this task and #${task.overlap_hold.number} look like they edit ${task.overlap_hold.files.join(", ")}. It starts once that one finishes, or sooner if nothing else can run.`}
          >
            waiting on #{task.overlap_hold.number}
          </span>
        )}
        {/* Why this queued task is not running (HIVE-525). A permanent reason is
            the loud one: nothing changes until a human changes a setting. The
            two reasons with their own richer chip above are left out. */}
        {task.state === "queued" && !deferred && task.skip && !["dependency_blocked", "file_overlap"].includes(task.skip.reason) && (
          <span
            className={task.skip.permanent ? "chip chip-error" : "chip"}
            title={`Dispatcher skipped this task: ${task.skip.label}`}
          >
            {task.skip.permanent ? "won't run · " : "waiting · "}
            {task.skip.label}
          </span>
        )}
        {/* Only a FAILING check earns board space; a green one changes nothing
            the director would do. Both are always on the task page. */}
        {task.sidecar && !task.sidecar.ok && <SidecarChip sidecar={task.sidecar} />}
        {/* The column holds every task in review; the chip says whether it is
            the director's turn or what still holds it (a confirmed risk sat
            under "Ready to Merge" before this). */}
        {task.state === "in_review" && !trackingOnly && gateChip && (
          <span className={gateChip.className} title={(task.review_gate === "needs_you" && task.review_hold) || gateChip.title}>
            {gateChip.label}
          </span>
        )}
        <BlockedBy depends_on={task.depends_on} tasks={tasks} />
        {/* A taken-over task is deferred too (that is how it is parked), so this
            comes first: "you are holding this one" beats "parked". */}
        {task.parked_for_director ? (
          <span className="chip chip-deferred" title="You took this worktree over; no agent runs on it until you hand it back">
            yours
          </span>
        ) : deferred && (
          // HIVE-2234: while deferred, the human-written deferral note IS the
          // waiting reason — the dispatcher's intent/skip gate text never
          // applies here (server already omits `skip` while deferred).
          <span className="chip chip-deferred" title={task.deferred_note ? `Deferred: ${task.deferred_note}` : "Deferred pending an offline human action; nudges suppressed"}>
            {task.deferred_note ? `deferred · ${task.deferred_note}` : "deferred"}
          </span>
        )}
        <span className="card-age">{age}</span>
      </div>
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
        {/* PR link, green CI, evidence count and "view agent" all moved to the
            card's own page (HIVE-556): they are detail, not a reason to act.
            A CI result that is NOT passing stays, because that one stops a
            merge. */}
        {!trackingOnly && task.ci_status && task.ci_status !== "passing" && <CiBadge status={task.ci_status} />}
      </div>
    </Link>
  );
}

// ---- merge queue (task #1257) --------------------------------------------
// Tick the PRs you want merged, hit the button once, and hive merges them in
// graph order: declared dependencies first, and never two conflicting branches
// in the same sweep. The chips say why a card will wait.
function useLandGraph(signature: string, project: string): LandGraph {
  const [graph, setGraph] = useState<LandGraph>({ nodes: [], edges: [] });
  useEffect(() => {
    api.landGraph(project || undefined).then(setGraph).catch(() => {});
  }, [signature, project]);
  return graph;
}

export function LandChips({ task, graph, tasks }: { task: Task; graph: LandGraph; tasks: Task[] }) {
  const incoming = graph.edges.filter((e) => e.to === task.id);
  const conflicts = graph.edges.filter((e) => e.kind === "conflict" && (e.from === task.id || e.to === task.id));
  if (!incoming.length && !conflicts.length && !task.land_queued_at) return null;
  const name = (id: string) => {
    const t = tasks.find((x) => x.id === id);
    return t ? taskLabel(t) : id.slice(0, 6);
  };
  const after = incoming.filter((e) => e.kind === "depends").map((e) => name(e.from));
  const clash = conflicts.map((e) => ({ ...e, peer: e.from === task.id ? e.to : e.from }));
  return (
    <div className="card-meta card-land">
      {task.land_queued_at && <span className="chip chip-land" title="Approved to merge. It waits for its turn.">queued to merge</span>}
      {after.length > 0 && (
        <span className="chip chip-blocked" title="Declared dependency: this merges only after those have merged">
          merges after {after.join(", ")}
        </span>
      )}
      {clash.length > 0 && (
        <span
          className="chip chip-blocked"
          title={clash
            .map((e) => `Both PRs change ${(e.files ?? []).join(", ") || "the same files"}. Read them together before merging (${name(e.peer)}).`)
            .join("\n")}
        >
          conflicts with {clash.map((e) => name(e.peer)).join(", ")}
        </span>
      )}
    </div>
  );
}

// Queued cards read in the order the dispatcher will actually pick them up:
// priority first, then the longest wait (server: PRIORITY_RANK_SQL, created_at).
export const queueOrder = (list: Task[]): Task[] =>
  [...list].sort(
    (a, b) => priorityRank(a.priority) - priorityRank(b.priority) || a.created_at.localeCompare(b.created_at)
  );

// ---- divergence radar (HIVE-348) ----------------------------------------
// Conflicts used to appear at merge time, after a review was already done. This
// shows them while the work is still in flight: how far a branch trails the
// branch it will land on, and which files it shares with a sibling branch. Same
// file-overlap detector the land queue uses, read one step earlier.
function useDivergence(signature: string, project: string): DivergenceRow[] {
  const [rows, setRows] = useState<DivergenceRow[]>([]);
  useEffect(() => {
    api.divergence(project || undefined).then((r) => setRows(r.rows)).catch(() => {});
  }, [signature, project]);
  return rows;
}

// A branch is always a commit or two behind an active base; saying so on every
// card would be noise, not signal. Only a real drift earns a chip.
const BEHIND_CHIP_MIN = 5;

export function DivergenceChips({ task, rows, tasks }: { task: Task; rows: DivergenceRow[]; tasks: Task[] }) {
  const row = rows.find((r) => r.id === task.id);
  if (!row) return null;
  const behind = row.behind ?? 0;
  const name = (id: string, number: number) => {
    const t = tasks.find((x) => x.id === id);
    return t ? taskLabel(t) : `#${number}`;
  };
  if (behind < BEHIND_CHIP_MIN && !row.overlaps.length) return null;
  return (
    <div className="card-meta card-land">
      {behind >= BEHIND_CHIP_MIN && (
        <span className="chip chip-blocked" title={`'${row.branch}' is missing ${behind} commits that are already on the branch it lands on. Rebase before review.`}>
          {behind} behind
        </span>
      )}
      {row.overlaps.length > 0 && (
        <span
          className="chip chip-blocked"
          title={row.overlaps.map((o) => `${name(o.task_id, o.number)}: ${o.files.join(", ")}`).join("\n")}
        >
          same files as {row.overlaps.map((o) => name(o.task_id, o.number)).join(", ")}
        </span>
      )}
    </div>
  );
}

type BoardView = "columns" | "tracked";
const VIEW_KEY = "hive.board.view";
const readView = (): BoardView => (localStorage.getItem(VIEW_KEY) === "tracked" ? "tracked" : "columns");

export default function Board() {
  const { tasks, projects } = useStore();
  const [adding, setAdding] = useState(false);
  // The choice sticks so the board opens the way it was left.
  const [view, setView] = useState<BoardView>(readView);
  const chooseView = (next: BoardView) => {
    setView(next);
    localStorage.setItem(VIEW_KEY, next);
  };
  // Compact project filter (All / per project), shared across board/inboxes and
  // persisted across reloads. Setting it broadcasts to every mounted view.
  const projectFilter = useProjectFilter();
  const setFilter = setProjectFilter;
  // Instant client-side card filter (title/summary substring), no server call.
  const [cardFilter, setCardFilter] = useState("");
  const [landSel, setLandSel] = useState<string[]>([]);
  const scoped = projectFilter ? tasks.filter((t) => t.project_id === projectFilter) : tasks;
  const q = cardFilter.trim().toLowerCase();
  const matches = (task: Task) => task.title.toLowerCase().includes(q) || (task.summary || "").toLowerCase().includes(q);
  const visible = q
    ? scoped.filter((task) => matches(task) || (isTrackingOnly(task) && trackedSubtasks(task, scoped).some(matches)))
    : scoped;
  const byState = (s: State) => {
    // Merged work is finished from the director's side, so `verifying` sits in
    // Done: hive closes it without the director.
    let list = visible.filter((t) => !isTrackingOnly(t) && (t.state === s || (s === "done" && t.state === "verifying")));
    // list is already newest-updated first from the API / SSE upserts.
    if (s === "queued") list = queueOrder(list);
    if (s === "done") list = list.slice(0, 10);
    return list;
  };
  // Refetch the ordering graph whenever the review column changes: an edge is
  // only meaningful between two PRs that are both still open.
  const reviewIds = visible.filter((t) => t.state === "in_review").map((t) => t.id).sort().join(",");
  const landGraph = useLandGraph(reviewIds, projectFilter);
  // The radar covers every branch still moving, so it refetches when the set of
  // in-flight cards changes, not just the review column.
  const inFlightIds = visible
    .filter((t) => t.state === "in_progress" || t.state === "in_review" || t.state === "needs_decision")
    .map((t) => t.id)
    .sort()
    .join(",");
  const divergence = useDivergence(inFlightIds, projectFilter);
  const toggleLand = (id: string) => setLandSel((sel) => (sel.includes(id) ? sel.filter((x) => x !== id) : [...sel, id]));
  const queueLand = async () => {
    try {
      const { changed } = await api.landQueue(landSel);
      setLandSel([]);
      toast(`${changed.length} queued to merge`);
    } catch (err) {
      toast((err as Error).message);
    }
  };
  // One card per ticket: while a Jira mirror's work is live, the work task's
  // card is the one to act on.
  const tracked = visible.filter((task) => isTrackingOnly(task) && BOARD_STATES.has(task.state) && !mirrorStillWorking(task, tasks));

  return (
    <div className="board-wrap">
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
        <button className={`board-chip ${view === "columns" ? "board-chip-on" : ""}`} onClick={() => chooseView("columns")}>Columns</button>
        <button className={`board-chip ${view === "tracked" ? "board-chip-on" : ""}`} onClick={() => chooseView("tracked")}>Tracked {tracked.length}</button>
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
      {view === "columns" ? (
        <>
          <div className="board">
          {COLUMNS.map(({ state, label }) => {
            const list = byState(state);
            const attention = list.filter((t) => needsLook(t.health)).length;
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
                    {state === "in_review" && landSel.length > 0 && (
                      <button className="btn btn-primary btn-new" onClick={queueLand} title="Hive merges these in dependency order, one conflicting branch at a time">
                        Merge {landSel.length}
                      </button>
                    )}
                    <span className="col-count">{list.length}</span>
                  </div>
                </header>
                <div className="col-body">
                  {list.map((t) =>
                    state === "in_review" ? (
                      <div className="land-row" key={t.id}>
                        <label className="land-pick" title="Select to merge">
                          <input type="checkbox" checked={landSel.includes(t.id)} onChange={() => toggleLand(t.id)} />
                        </label>
                        <div className="land-card">
                          <Card task={t} />
                          <LandChips task={t} graph={landGraph} tasks={visible} />
                          <DivergenceChips task={t} rows={divergence} tasks={visible} />
                        </div>
                      </div>
                    ) : (
                      <div key={t.id}>
                        <Card task={t} />
                        <DivergenceChips task={t} rows={divergence} tasks={visible} />
                      </div>
                    )
                  )}
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
  const { projects, projectsLoaded } = useStore();
  const [mode, setMode] = useState<"braindump" | "manual">("braindump");
  const [project, setProject] = useState("");
  const [dump, setDump] = useState("");
  const [title, setTitle] = useState("");
  const [brief, setBrief] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [kind, setKind] = useState<Kind>("ship");
  const [priority, setPriority] = useState("normal");
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
        toast("Braindump sent. Claude is drafting a breakdown for you to approve.");
      } else {
        await api.createTask(
          { project_id: project, title: title.trim(), brief: brief.trim() || undefined, kind, priority },
          files
        );
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
          projectsLoaded ? <div className="muted">No projects yet. Create one first.</div> : null
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
                <label className="fld">
                  <span>Priority</span>
                  <select value={priority} onChange={(e) => setPriority(e.target.value)}>
                    {PRIORITIES.map((p) => (
                      <option key={p} value={p}>
                        {p}
                      </option>
                    ))}
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
