import { useEffect, useState } from "react";
import { Link, useLocation } from "react-router-dom";
import { api } from "../lib/api";
import { useStore } from "../lib/store";
import type { AttentionBudget, DivergenceRow, Health, Kind, LandGraph, State, Task } from "../lib/api";
import { Attach, BlockedBy, CiBadge, Empty, HEALTH_LABEL, needsLook, PRIORITIES, PriorityChip, priorityRank, SidecarChip, STATE_LABEL, StatusDot, toast } from "../lib/ui";
import { useRelTime } from "../lib/time";
import { useProjectFilter, setProjectFilter } from "../lib/projectFilter";
import { actionableItems, isJiraMirror, isTrackingOnly, orderFocusItems, trackedSubtasks } from "../lib/needsYou";
import type { NeedsYouItem } from "../lib/needsYou";
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
          <span className="chip chip-intake" title="Intake triage found more than one reading. Pick which one to build — nothing is built until you answer.">
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
            ⚠ spawn failed
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
        {task.state === "queued" && task.skip && !["dependency_blocked", "file_overlap"].includes(task.skip.reason) && (
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
        <BlockedBy depends_on={task.depends_on} tasks={tasks} />
        {/* A taken-over task is deferred too (that is how it is parked), so this
            comes first: "you are holding this one" beats "parked". */}
        {task.parked_for_director ? (
          <span className="chip chip-deferred" title="You took this worktree over; no agent runs on it until you hand it back">
            yours
          </span>
        ) : task.deferred_until && Date.parse(task.deferred_until) > Date.now() && (
          <span className="chip chip-deferred" title="Deferred pending an offline human action; nudges suppressed">
            deferred
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

// ---- land queue (task #1257) --------------------------------------------
// Tick the PRs you want landed, hit the button once, and hive merges them in
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
      {task.land_queued_at && <span className="chip chip-land" title="Approved to land; waiting for its turn in the queue">⏳ queued to land</span>}
      {after.length > 0 && (
        <span className="chip chip-blocked" title="Declared dependency: this lands only after those have merged">
          lands after {after.join(", ")}
        </span>
      )}
      {clash.length > 0 && (
        <span
          className="chip chip-blocked"
          title={clash
            .map((e) => `Both PRs change ${(e.files ?? []).join(", ") || "the same files"} — read them together before landing (${name(e.peer)})`)
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

// ONE rendering of "what needs you" on this page. It used to be three: a
// dismissible brief banner, a Needs attention tray, and the cards themselves,
// so the same fact was read three times before any work was visible
// (HIVE-556). The number and the set come from lib/needsYou.ts, the same
// source as the nav badge, so the two can never disagree.
//
// Nothing is hidden: the strip links to /inbox, where every one of these items
// has its full card and its buttons.
const STRIP_LABELS: Record<string, [string, string]> = {
  decision: ["decision", "decisions"],
  checkpoint: ["checkpoint", "checkpoints"],
  quiz_digest: ["catch-up", "catch-ups"],
  review: ["to review", "to review"],
  attention: ["issue", "issues"],
};

export function NeedsYouStrip() {
  const { needsYou, tasks } = useStore();
  const projectFilter = useProjectFilter();
  const items = actionableItems(needsYou, tasks, projectFilter);
  if (items.length === 0) return null;
  const parts = Object.entries(STRIP_LABELS).flatMap(([kind, [one, many]]) => {
    const n = items.filter((item) => item.kind === kind).length;
    return n > 0 ? [`${n} ${n === 1 ? one : many}`] : [];
  });
  return (
    <Link to="/inbox" className="needs-you-strip">
      <span className="needs-you-strip-count">{items.length}</span>
      <span className="needs-you-strip-text">
        needs you<span className="needs-you-strip-parts"> · {parts.join(" · ")}</span>
      </span>
      <span className="needs-you-strip-go">Open →</span>
    </Link>
  );
}

// ---- attention-first work view (HIVE-356) -------------------------------
// The board's default. Four of the five kanban columns were status, not action:
// Queued, Working, Ready to merge and Done all say what the machine is doing,
// and only one of them ever needs the director. So the page leads with the
// things that need him, in the order hive would hand them over, and collapses
// everything the agents are handling to one line each.
//
// The needs-you set and its order are NOT redefined here: actionableItems() and
// orderFocusItems() (lib/needsYou.ts) are the same functions behind the nav
// badge and the inbox, so the number on this page cannot disagree with them.
// The old columns are still one click away under View.

// Where a row goes when it's clicked, and the one line it says. Everything an
// item needs to be worth ten seconds: what kind of ask it is, which task, and
// what it wants.
function focusRow(item: NeedsYouItem): { kind: string; to: string; label: string; detail: string; ts: string } {
  const label = (task: Task) => `${taskLabel(task)} ${task.title}`;
  switch (item.kind) {
    case "decision":
      return {
        kind: "Decision",
        to: `/decisions#dcard-${item.decision.id}`,
        label: item.decision.title,
        detail: "Waiting on your answer",
        ts: item.decision.ts,
      };
    case "checkpoint":
      return {
        kind: "Checkpoint",
        to: `/tasks/${item.checkpoint.task_id}`,
        label: item.checkpoint.task_title,
        detail: item.checkpoint.note,
        ts: item.checkpoint.ts,
      };
    case "quiz_digest":
      return {
        kind: "Catch up",
        to: "/inbox",
        label: `${item.quizzes.length} shipped ${item.quizzes.length === 1 ? "change" : "changes"}`,
        detail: "Read what shipped, one at a time",
        ts: item.quizzes[0]?.ts ?? "",
      };
    case "review":
      return {
        kind: "Review",
        to: `/tasks/${item.task.id}`,
        label: label(item.task),
        detail: item.task.ci_status === "passing" ? "Tests green — yours to merge" : "Ready for your review",
        ts: item.task.needs_you_since ?? item.task.updated_at,
      };
    // hive stops here and never closes a task itself (HIVE-604), so this row is
    // the whole handover: what landed, what checked out, and Accept to close it.
    case "verify":
      return {
        kind: "Verify",
        to: `/tasks/${item.task.id}`,
        label: label(item.task),
        detail: prNumber(item.task.pr_url)
          ? `Merged #${prNumber(item.task.pr_url)}${item.task.ci_status === "passing" ? ", tests green" : ""} — check it, then accept`
          : "Landed — check it, then accept",
        ts: item.task.needs_you_since ?? item.task.updated_at,
      };
    default:
      return {
        kind: "Issue",
        to: `/tasks/${item.task.id}`,
        label: label(item.task),
        detail: item.task.health?.reason || (item.task.state === "failed" ? "Failed — needs routing" : "Needs a look"),
        ts: item.task.health?.since ?? item.task.needs_you_since ?? item.task.updated_at,
      };
  }
}

function prNumber(prUrl: string | null): string {
  return String(prUrl ?? "").match(/\/pull\/(\d+)/)?.[1] ?? "";
}

// The one action a verify row needs: the director has looked, so close it.
// This is the ONLY way a task reaches done — nothing in hive moves it there.
function AcceptButton({ task }: { task: Task }) {
  const [busy, setBusy] = useState(false);
  const accept = async (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setBusy(true);
    try {
      await api.transition(task.id, "done", "verified by the director");
      toast(`${taskLabel(task)} accepted`);
    } catch (err) {
      toast((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <button className="btn btn-primary focus-accept" onClick={accept} disabled={busy} title="Mark this verified and close it">
      {busy ? "…" : "Accept"}
    </button>
  );
}

function FocusRow({ item }: { item: NeedsYouItem }) {
  const location = useLocation();
  const row = focusRow(item);
  const age = useRelTime(row.ts);
  // Only /tasks/:id has a modal route (App.tsx). Handing backgroundLocation to
  // any other path keeps the board rendered underneath and nothing on top, so
  // the click looks like it did nothing.
  const modal = row.to.startsWith("/tasks/");
  const link = (
    <Link className="focus-row" to={row.to} state={modal ? { backgroundLocation: location } : undefined}>
      <span className={`focus-kind focus-kind-${row.kind.toLowerCase().replace(" ", "-")}`}>{row.kind}</span>
      <span className="focus-label">{row.label}</span>
      <span className="focus-detail">{row.detail}</span>
      <span className="focus-age">{age}</span>
    </Link>
  );
  // A button inside an <a> is not valid HTML, so the accept action sits beside
  // the row rather than inside it.
  if (item.kind !== "verify") return link;
  return (
    <div className="focus-row-wrap">
      {link}
      <AcceptButton task={item.task} />
    </div>
  );
}

// One line for one task an agent is on. No chips, no buttons: this half of the
// page exists to be skipped, not read.
function StatusRow({ task }: { task: Task }) {
  const location = useLocation();
  const { lastActivity } = useStore();
  const age = useRelTime(task.health?.since || lastActivity[task.id] || task.updated_at);
  return (
    <Link className="status-row" to={`/tasks/${task.id}`} state={{ backgroundLocation: location }}>
      <StatusDot state={task.state} health={task.health} />
      <span className="status-row-id">{taskLabel(task)}</span>
      <span className="status-row-title">{task.title}</span>
      <span className="status-row-state">{STATE_LABEL[task.state]}</span>
      <span className="status-row-age">{age}</span>
    </Link>
  );
}

// Over budget: more is waiting on the director than one person tracks, so hive
// has stopped ADDING optional work. It never stops or throttles what is already
// running — the point is that supply stops outrunning the human, not that the
// fleet gets smaller.
//
// The banner also says WHAT is being held, and that it is held rather than
// dropped. A board that is quiet because nothing needs you and a board that is
// quiet because hive is sitting on things look identical, and only one of them
// means you can stop reading. Nothing is ever taken out of the count to make
// the number look better: the pause holds supply, never display.
// `held` is optional on purpose: an older server answers /api/attention without
// it, and a missing field must not take the whole board down with it.
export function heldLine(held?: { scouts: number; watchers: number }): string {
  const parts = [
    (held?.scouts ?? 0) > 0 ? `${held!.scouts} scout${held!.scouts === 1 ? "" : "s"}` : "",
    (held?.watchers ?? 0) > 0 ? `${held!.watchers} watched change${held!.watchers === 1 ? "" : "s"}` : "",
  ].filter(Boolean);
  if (!parts.length) return "Nothing is being held yet.";
  return `Holding ${parts.join(" and ")} — nothing is dropped, they are filed once you are back under.`;
}

export function AttentionBudgetBanner({ count }: { count: number }) {
  const [budget, setBudget] = useState<AttentionBudget | null>(null);
  useEffect(() => {
    let live = true;
    api.attention().then((b) => live && setBudget(b)).catch(() => {});
    return () => { live = false; };
  }, [count]);
  if (!budget || budget.threshold <= 0 || count <= budget.threshold) return null;
  return (
    <div className="attn-budget" role="status">
      <strong>{count} things need you.</strong>{" "}
      That is over your budget of {budget.threshold}, so hive paused {budget.paused.join(" and ")}.
      Nothing already running was stopped. {heldLine(budget.held)}
    </div>
  );
}

type BoardView = "focus" | "columns" | "tracked";
const VIEW_KEY = "hive.board.view";
const readView = (): BoardView => {
  const saved = localStorage.getItem(VIEW_KEY);
  return saved === "columns" || saved === "tracked" ? saved : "focus";
};

export function WorkFocus({ visible }: { visible: Task[] }) {
  const { needsYou, tasks } = useStore();
  const projectFilter = useProjectFilter();
  const items = orderFocusItems(actionableItems(needsYou, tasks, projectFilter), tasks);
  // What agents are actually on. Queued work is not being handled by anyone, so
  // it is a single count, not thirty rows. `verifying` left this lane with
  // HIVE-604: nothing is handling it, it is waiting on the director, and it is
  // already a needs-you row above.
  const handling = visible.filter((task) => !isTrackingOnly(task) && task.state === "in_progress");
  // In review but not yours yet: CI still running, review pass not finished.
  // Visible, deliberately not counted — the actionable ones are already above.
  const pending = visible.filter(
    (task) => !isTrackingOnly(task) && task.state === "in_review" && !items.some((item) => "task" in item && item.task.id === task.id)
  );
  const queued = visible.filter((task) => !isTrackingOnly(task) && task.state === "queued").length;
  // Today's finished work, not hive's lifetime total: 1300-odd done tasks is a
  // fact about the database, not about this morning.
  const dayAgo = Date.now() - 24 * 60 * 60 * 1000;
  const done = visible.filter(
    (task) => !isTrackingOnly(task) && task.state === "done" && Date.parse(task.updated_at) >= dayAgo
  ).length;

  return (
    <div className="work-focus">
      <AttentionBudgetBanner count={items.length} />
      <section className="focus-lane">
        <header className="focus-lane-head">
          <h2>Needs you</h2>
          <span className="focus-lane-count">{items.length}</span>
          {items.length > 0 && <Link className="focus-lane-go" to="/inbox">Work through them →</Link>}
        </header>
        {items.length === 0 ? (
          <Empty
            compact
            title="Nothing needs you."
            hint="Agents park here when they hit a call only you can make, or a branch is ready to merge."
          />
        ) : (
          <div className="focus-rows">
            {items.map((item) => <FocusRow key={`${item.kind}:${item.id}`} item={item} />)}
          </div>
        )}
      </section>

      <section className="status-lane">
        <header className="status-lane-head">
          <h2>Hive is handling</h2>
          <span className="status-lane-counts">
            {queued} queued · {handling.length + pending.length} in flight · {done} done today
          </span>
        </header>
        {handling.length + pending.length === 0 ? (
          <div className="muted status-lane-empty">No agents working right now.</div>
        ) : (
          <div className="status-rows">
            {[...handling, ...pending].map((task) => <StatusRow key={task.id} task={task} />)}
          </div>
        )}
      </section>
    </div>
  );
}

export default function Board() {
  const { tasks, projects } = useStore();
  const [adding, setAdding] = useState(false);
  // Attention-first by default (HIVE-356). The five columns are still here for
  // anyone who wants them; the choice sticks so the board opens the way it was
  // left.
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
    let list = visible.filter((t) => !isTrackingOnly(t) && t.state === s);
    // list is already newest-updated first from the API / SSE upserts.
    if (s === "queued") list = queueOrder(list);
    if (s === "done") list = list.slice(0, 10);
    return list;
  };
  const verifying = visible.filter((task) => !isTrackingOnly(task) && task.state === "verifying");
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
      toast(`${changed.length} queued to land`);
    } catch (err) {
      toast((err as Error).message);
    }
  };
  const tracked = visible.filter((task) => isTrackingOnly(task) && BOARD_STATES.has(task.state));

  return (
    <div className="board-wrap">
      {/* The focus view leads with the same items in full, so the strip would
          say the same thing twice. */}
      {view !== "focus" && <NeedsYouStrip />}
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
        <button className={`board-chip ${view === "focus" ? "board-chip-on" : ""}`} onClick={() => chooseView("focus")}>Focus</button>
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
      {view === "focus" ? (
        <WorkFocus visible={visible} />
      ) : view === "columns" ? (
        <>
          {verifying.length > 0 && (
            <section className="verification-strip" aria-label="Waiting for you to verify">
              <span className="verification-title">Waiting for you to verify</span>
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
                        Land {landSel.length}
                      </button>
                    )}
                    <span className="col-count">{list.length}</span>
                  </div>
                </header>
                <div className="col-body">
                  {list.map((t) =>
                    state === "in_review" ? (
                      <div className="land-row" key={t.id}>
                        <label className="land-pick" title="Select for the land queue">
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
  const { projects } = useStore();
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
        toast("Braindump sent — Claude is drafting a breakdown for you to approve");
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
